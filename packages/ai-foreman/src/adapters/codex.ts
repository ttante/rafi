import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadSkill } from "special-agents";
import { BuilderEventQueue, withActivityPhase } from "../activity.js";
import { normalizeRuntimeErrorText } from "../runtimeAuth.js";
import type { BuilderAdapter, BuilderAdapterOptions, BuilderEvent, CompactResult, ContextUsage, ProviderSessionUsage, ProviderSettingSwitch, TurnResult } from "./types.js";
import type { ProviderSessionRefV1, SessionAvailabilityV1 } from "rafi-spec";
import { canonicalSessionPath, createProviderSessionRef, validateProviderSessionScope } from "../sessionIdentity.js";
import { SessionUnavailableError, sessionUnavailableResult } from "./sessionFailure.js";

export interface CodexLineResult { events: BuilderEvent[]; sessionId?: string; text?: string }

/** Compatibility parser for recorded pre-app-server JSONL fixtures. */
export function parseCodexLine(raw: Record<string, unknown>): CodexLineResult {
  const type = raw.type as string | undefined;
  if (type === "thread.started") return { events: [], sessionId: raw.thread_id as string | undefined };
  if (type === "item.completed") {
    const item = raw.item as Record<string, unknown> | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string") return { events: [{ kind: "text", text: item.text }], text: item.text };
    if (item?.type === "command_execution") return { events: [{ kind: "tool", name: "command_execution", input: { command: item.command } }] };
  }
  if (type === "error") return { events: [{ kind: "error", message: String((raw.error as Record<string, unknown> | undefined)?.message ?? JSON.stringify(raw)) }] };
  return { events: [] };
}

type RpcMessage = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number } };
type Waiter = { predicate: (params: Record<string, unknown>) => boolean; resolve: (params: Record<string, unknown>) => void; reject: (error: Error) => void };

/** Persistent JSON-RPC controller for one live Codex thread. */
export class CodexAdapter implements BuilderAdapter {
  readonly agent = "codex" as const;
  private readonly eventQueue = new BuilderEventQueue();
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notificationWaiters = new Map<string, Waiter[]>();
  private _sessionId?: string;
  private _sessionRef?: ProviderSessionRefV1;
  private sessionAvailability?: SessionAvailabilityV1;
  private initialized = false;
  private closed = false;
  private activeText: string[] = [];
  private usage?: ContextUsage;
  private usageRevision = 0;
  private providerSessionUsage?: ProviderSessionUsage;
  private lastTurnTokens?: { inputTokens?: number; outputTokens?: number };
  private stderr = "";
  private nativeAutoCompactTokenLimit?: number;
  private autoCompactionPrepared = false;

  constructor(private readonly opts: BuilderAdapterOptions) {
    this._sessionId = opts.resumeSessionRef?.sessionId ?? opts.resumeSessionId;
    this._sessionRef = opts.resumeSessionRef;
  }

  buildInstruction(instruction: string): string {
    return [this.opts.systemPromptAppend, this.buildSkillsAppendix(), instruction]
      .filter((part): part is string => Boolean(part)).join("\n\n");
  }

  buildAppServerArgs(): string[] {
    const args = ["app-server", "--listen", "stdio://"];
    if (this.nativeAutoCompactTokenLimit !== undefined) {
      args.push(
        "-c", `model_auto_compact_token_limit=${this.nativeAutoCompactTokenLimit}`,
        "-c", 'model_auto_compact_token_limit_scope="total"',
      );
    }
    return args;
  }

  /** Deprecated fixture helper. Runtime execution uses only app-server. */
  buildArgs(instruction: string): string[] {
    const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", this.opts.sandboxMode ?? "workspace-write", "-C", this.opts.cwd];
    if (this.opts.model) args.push("-m", this.opts.model);
    if (this.opts.effort) args.push("-c", `model_reasoning_effort=${this.opts.effort}`); else if (this.opts.fast) args.push("-c", "model_reasoning_effort=low");
    if (this._sessionId) args.push("resume", this._sessionId);
    args.push(instruction); return args;
  }

  async sendTurn(instruction: string): Promise<TurnResult> {
    return withActivityPhase(`Codex ${activityPhase(this.opts.runtimePhase)}`, () => this.sendTurnInternal(instruction));
  }

  private async sendTurnInternal(instruction: string): Promise<TurnResult> {
    if (this.closed) throw new Error("builder is closed");
    this.eventQueue.push({ kind: "activity", state: "starting Codex turn", provider: "codex", model: this.opts.model });
    let turnStartDispatched = false;
    try {
      await this.ensureThread();
      this.activeText = [];
      this.lastTurnTokens = undefined;
      const completion = this.waitFor("turn/completed", (params) => params.threadId === this._sessionId);
      turnStartDispatched = true;
      await this.request("turn/start", {
        threadId: this._sessionId,
        input: [{ type: "text", text: this.buildInstruction(instruction), text_elements: [] }],
        cwd: this.opts.cwd,
        model: this.opts.model ?? null,
        effort: this.opts.effort ?? (this.opts.fast ? "low" : null),
      });
      const params = await completion;
      const turn = params.turn as Record<string, unknown> | undefined;
      const failed = turn?.status === "failed";
      const error = turn?.error as Record<string, unknown> | null | undefined;
      const text = this.activeText.join("\n");
      const result: TurnResult = {
        text: failed ? normalizeRuntimeErrorText("codex", String(error?.message ?? text), null, "app-server turn") : text,
        isError: failed, numTurns: 1, costUsd: 0, costAuthoritative: false,
        ...(this.lastTurnTokens ?? {}),
      };
      this.eventQueue.push({ kind: "turn-complete", result });
      return result;
    } catch (error) {
      if (error instanceof SessionUnavailableError) {
        const result = sessionUnavailableResult(error);
        this.eventQueue.push({ kind: "error", message: result.text });
        this.eventQueue.push({ kind: "turn-complete", result });
        return result;
      }
      const detail = [error instanceof Error ? error.message : String(error), this.stderr].filter(Boolean).join("\n");
      const text = normalizeRuntimeErrorText("codex", detail, this.process?.exitCode ?? null, "builder turn");
      this.disconnect(new Error(text));
      const resumed = Boolean(this.opts.resumeSessionRef);
      const result: TurnResult = resumed
        ? sessionUnavailableResult(new SessionUnavailableError({
          runtime: "codex", phase: turnStartDispatched ? "turn" : "attach", dispatchState: turnStartDispatched ? "unknown" : "not-sent",
          executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: text,
          availability: { version: 1, status: turnStartDispatched ? "unknown" : "unavailable", checkedAt: new Date().toISOString(), reason: turnStartDispatched ? "probe-failed" : "attach-failed", detail: text, sessionRef: this.opts.resumeSessionRef },
        }))
        : { text, isError: true, numTurns: 1, costUsd: 0, costAuthoritative: false };
      this.eventQueue.push({ kind: "error", message: text });
      this.eventQueue.push({ kind: "turn-complete", result });
      return result;
    }
  }

  async compact(): Promise<CompactResult> {
    try {
      await this.ensureThread();
      this.eventQueue.push({ kind: "session-transition", transition: "compacting" });
      const usageRevision = this.usageRevision;
      // A pre-compaction observation must never be mistaken for proof that the
      // provider reduced the live context. The app server emits a fresh token
      // usage notification for the compacted thread; require it alongside the
      // explicit contextCompaction completion item.
      this.usage = undefined;
      const done = this.waitFor("item/completed", (params) => {
        const item = params.item as Record<string, unknown> | undefined;
        return params.threadId === this._sessionId && item?.type === "contextCompaction";
      }, 30_000);
      const postCompactUsage = this.waitFor("thread/tokenUsage/updated", (params) => {
        return (params.threadId === undefined || params.threadId === this._sessionId)
          && this.usageRevision > usageRevision
          && this.usage !== undefined;
      }, 30_000);
      await Promise.all([
        this.request("thread/compact/start", { threadId: this._sessionId }),
        done,
        postCompactUsage,
      ]);
      this.eventQueue.push({ kind: "session-transition", transition: "compacted" });
      return { ok: true };
    } catch (error) {
      if (error instanceof SessionUnavailableError) return { ok: false, error: error.message, failure: error.failure };
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async prepareAutoCompaction(): Promise<void> {
    if (this.autoCompactionPrepared || this.opts.autoCompactThresholdPercent === undefined) return;
    const threshold = validThreshold(this.opts.autoCompactThresholdPercent);
    await this.ensureThread();
    // Codex reports its model context window in token-usage notifications, not
    // in thread/start. Establish the otherwise idle thread with a constrained
    // setup turn, then restart the app server with the provider-native ceiling
    // before any Builder or QA work is sent.
    if (!this.usage) {
      const setup = await this.sendTurnInternal("Rafi setup only: do not call tools or modify files; reply exactly CONTEXT_READY.");
      if (setup.isError || setup.text.trim() !== "CONTEXT_READY") {
        throw new Error(`Codex automatic-compaction setup failed: ${setup.text.slice(0, 240)}`);
      }
    }
    const maximum = this.usage?.maximum;
    if (!maximum || !Number.isFinite(maximum) || maximum <= 0) {
      throw new Error("Codex did not report a model context window during automatic-compaction setup");
    }
    this.nativeAutoCompactTokenLimit = tokenLimit(maximum, threshold);
    await this.restartForAutoCompaction();
    await this.ensureThread();
    this.autoCompactionPrepared = true;
  }

  async contextUsage(): Promise<ContextUsage | undefined> { return this.usage; }
  async sessionUsage(): Promise<ProviderSessionUsage | undefined> { return this.providerSessionUsage ? { ...this.providerSessionUsage } : undefined; }
  async switchSettings(settings: ProviderSettingSwitch): Promise<CompactResult> {
    this.opts.model = settings.model; this.opts.effort = settings.effort; this.opts.fast = settings.fast;
    return { ok: true };
  }
  sessionId(): string | undefined { return this._sessionId; }
  sessionRef(): ProviderSessionRefV1 | undefined { return this._sessionRef; }
  adoptSessionRef(ref: ProviderSessionRefV1): void {
    if (ref.provider !== "codex" || ref.sessionId !== this._sessionId) throw new Error("cannot adopt a session reference for a different Codex thread");
    this._sessionRef = ref;
  }
  async validateSession(): Promise<SessionAvailabilityV1> {
    const checkedAt = new Date().toISOString();
    if (!this._sessionRef) return { version: 1, status: "unknown", checkedAt, reason: "legacy-unscoped", detail: "Codex raw thread IDs cannot be declared exact without a stored location scope" };
    try {
      await this.ensureThread();
      return this.sessionAvailability ?? { version: 1, status: "available", checkedAt, observedCwd: canonicalSessionPath(this.opts.cwd), sessionRef: this._sessionRef };
    } catch (error) {
      if (error instanceof SessionUnavailableError && error.failure.availability) return error.failure.availability;
      return { version: 1, status: "unknown", checkedAt, reason: "probe-failed", detail: error instanceof Error ? error.message : String(error), sessionRef: this._sessionRef };
    }
  }
  events(): AsyncIterable<BuilderEvent> { return this.eventQueue; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.disconnect(new Error("app-server closed"));
    this.eventQueue.close();
  }

  private async ensureThread(): Promise<void> {
    if (this._sessionRef && !this.threadAttached) {
      if (this._sessionRef.source === "legacy-inferred") {
        const availability: SessionAvailabilityV1 = { version: 1, status: "unknown", checkedAt: new Date().toISOString(), reason: "legacy-unscoped", detail: "legacy Codex thread IDs cannot be proven exact without an observed scoped binding", sessionRef: this._sessionRef };
        this.sessionAvailability = availability;
        throw new SessionUnavailableError({ runtime: "codex", phase: "preflight", dispatchState: "not-sent", executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: availability.detail!, availability });
      }
      const scoped = validateProviderSessionScope(this._sessionRef, {
        provider: "codex", cwd: this.opts.cwd, configRoot: this.opts.configRoot ?? this.opts.cwd,
        role: this.opts.sessionRole ?? this._sessionRef.role, stream: this.opts.sessionStream ?? this._sessionRef.stream,
        workspaceIdentity: this.opts.workspaceIdentity, ticketId: this.opts.ticketId, deliveryUnitId: this.opts.deliveryUnitId,
      });
      if (scoped.status !== "available" || !scoped.sessionRef) {
        this.sessionAvailability = scoped;
        throw new SessionUnavailableError({
          runtime: "codex", phase: "preflight", dispatchState: "not-sent", executable: this.opts.runtimeExecutable ?? "codex",
          cwd: this.opts.cwd, diagnostics: scoped.detail ?? `Codex session ${this._sessionRef.sessionId} is ${scoped.status}`, availability: scoped,
        });
      }
      this._sessionRef = scoped.sessionRef;
    }
    await this.ensureConnection();
    if (this._sessionId && this.initialized === true && this.threadAttached) return;
    const method = this._sessionId ? "thread/resume" : "thread/start";
    let result: Record<string, unknown>;
    try {
      result = await this.request(method, {
        ...(this._sessionId ? { threadId: this._sessionId } : {}), cwd: this.opts.cwd,
        model: this.opts.model ?? null, approvalPolicy: "never",
        sandbox: this.opts.sandboxMode === "read-only" ? "read-only" : "workspace-write",
        developerInstructions: this.opts.systemPromptAppend ?? null,
      }) as Record<string, unknown>;
    } catch (error) {
      if (this._sessionRef) {
        const detail = error instanceof Error ? error.message : String(error);
        const availability: SessionAvailabilityV1 = {
          version: 1, status: "unavailable", checkedAt: new Date().toISOString(),
          reason: /not found|unknown thread|no thread/i.test(detail) ? "not-found" : "attach-failed", detail, sessionRef: this._sessionRef,
        };
        this.sessionAvailability = availability;
        throw new SessionUnavailableError({ runtime: "codex", phase: "attach", dispatchState: "not-sent", executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: detail, availability, cause: error });
      }
      throw error;
    }
    const thread = result.thread as Record<string, unknown> | undefined;
    const returnedSessionId = String(thread?.id ?? this._sessionId ?? "") || undefined;
    if (this._sessionRef && returnedSessionId !== this._sessionRef.sessionId) {
      const availability: SessionAvailabilityV1 = {
        version: 1,
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        reason: "attach-failed",
        detail: `Codex resumed thread ${returnedSessionId ?? "without an ID"} instead of requested thread ${this._sessionRef.sessionId}`,
        sessionRef: this._sessionRef,
      };
      this.sessionAvailability = availability;
      throw new SessionUnavailableError({
        runtime: "codex",
        phase: "attach",
        dispatchState: "not-sent",
        executable: this.opts.runtimeExecutable ?? "codex",
        cwd: this.opts.cwd,
        diagnostics: availability.detail!,
        availability,
      });
    }
    this._sessionId = returnedSessionId;
    if (!this._sessionId) throw new Error(`${method} did not return a thread ID`);
    const providerCwd = typeof thread?.cwd === "string" ? canonicalSessionPath(thread.cwd) : undefined;
    if (this._sessionRef && providerCwd && providerCwd !== canonicalSessionPath(this._sessionRef.cwd)) {
      const availability: SessionAvailabilityV1 = { version: 1, status: "unavailable", checkedAt: new Date().toISOString(), reason: "cwd-mismatch", observedCwd: providerCwd, detail: `Codex thread cwd ${providerCwd} does not match ${this._sessionRef.cwd}`, sessionRef: this._sessionRef };
      this.sessionAvailability = availability;
      throw new SessionUnavailableError({ runtime: "codex", phase: "attach", dispatchState: "not-sent", executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: availability.detail!, availability });
    }
    if (!this._sessionRef) {
      this._sessionRef = createProviderSessionRef({
        provider: "codex", sessionId: this._sessionId, cwd: providerCwd ?? this.opts.cwd, configRoot: this.opts.configRoot ?? this.opts.cwd,
        role: this.opts.sessionRole, stream: this.opts.sessionStream, generation: this.opts.sessionGeneration,
        workspaceIdentity: this.opts.workspaceIdentity, ticketId: this.opts.ticketId, deliveryUnitId: this.opts.deliveryUnitId,
      });
    } else {
      this._sessionRef = { ...this._sessionRef, validatedAt: new Date().toISOString() };
    }
    this.sessionAvailability = { version: 1, status: "available", checkedAt: new Date().toISOString(), observedCwd: providerCwd ?? canonicalSessionPath(this.opts.cwd), sessionRef: this._sessionRef };
    this.threadAttached = true;
    this.eventQueue.push({ kind: "session-transition", transition: method === "thread/resume" ? "resumed" : "started" });
  }

  private threadAttached = false;

  private async ensureConnection(): Promise<void> {
    if (this.process && this.initialized) return;
    this.stderr = "";
    const executable = this.opts.runtimeExecutable ?? "codex";
    const child = spawn(executable, this.buildAppServerArgs(), { cwd: this.opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    // A short-lived server may close stdin before its stderr/exit event. The
    // close handler owns rejection so diagnostics include the complete stderr.
    child.stdin.on("error", () => {});
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => { if (line.trim()) try { this.handle(JSON.parse(line) as RpcMessage); } catch { /* ignore non-protocol stdout */ } });
    child.stderr.on("data", (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8192); });
    child.on("error", (error) => { if (this.process === child) this.disconnect(error); });
    child.on("close", (code) => { if (this.process === child) this.disconnect(new Error(`Codex app-server exited with code ${code ?? "unknown"}`)); });
    await this.request("initialize", { clientInfo: { name: "rafi", title: "Rafi", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.write({ method: "initialized", params: {} });
    this.initialized = true;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); } catch (error) { this.pending.delete(id); reject(error as Error); }
    });
  }

  private write(message: RpcMessage): void {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server is not connected");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handle(message: RpcMessage): void {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) { this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message ?? `JSON-RPC error ${message.error.code ?? "unknown"}`)) : pending.resolve(message.result); }
      return;
    }
    if (!message.method) return;
    const params = message.params ?? {};
    if (message.method === "item/started") {
      const item = params.item as Record<string, unknown> | undefined;
      const activity = codexItemActivity(item);
      if (activity) this.eventQueue.push({ kind: "activity", provider: "codex", ...activity });
    } else if (message.method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") { this.activeText.push(item.text); this.eventQueue.push({ kind: "text", text: item.text }); }
      else if (item?.type === "commandExecution") this.eventQueue.push({ kind: "tool", name: "command_execution", input: { command: item.command } });
      else {
        const activity = codexItemActivity(item, true);
        if (activity) this.eventQueue.push({ kind: "activity", provider: "codex", ...activity });
      }
    } else if (message.method === "turn/plan/updated") {
      const plan = params.plan as Array<Record<string, unknown>> | undefined;
      const active = plan?.find((step) => step.status === "inProgress") ?? plan?.at(-1);
      this.eventQueue.push({ kind: "activity", provider: "codex", state: "following plan", detail: typeof active?.step === "string" ? active.step : undefined });
    } else if (message.method.includes("reasoning") || message.method === "thread/status/changed") {
      this.eventQueue.push({ kind: "activity", provider: "codex", state: message.method.includes("reasoning") ? "reasoning" : "provider working", transient: message.method.includes("Delta") });
    } else if (message.method === "thread/tokenUsage/updated") {
      const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
      const total = tokenUsage?.total as Record<string, unknown> | undefined;
      const last = tokenUsage?.last as Record<string, unknown> | undefined;
      const used = Number(total?.totalTokens);
      const maximum = Number(tokenUsage?.modelContextWindow);
      const observedAt = new Date().toISOString();
      const totalInput = optionalNonNegative(total?.inputTokens);
      const totalOutput = optionalNonNegative(total?.outputTokens);
      const sessionTotal = optionalNonNegative(total?.totalTokens);
      if (totalInput !== undefined || totalOutput !== undefined || sessionTotal !== undefined) {
        this.providerSessionUsage = { inputTokens: totalInput, outputTokens: totalOutput, totalTokens: sessionTotal, observedAt, source: "provider" };
      }
      this.lastTurnTokens = {
        inputTokens: optionalNonNegative(last?.inputTokens),
        outputTokens: optionalNonNegative(last?.outputTokens),
      };
      if (Number.isFinite(used) && used >= 0 && Number.isFinite(maximum) && maximum > 0) {
        this.usage = { used, maximum, percentage: used / maximum * 100, observedAt, source: "provider-event" };
        this.usageRevision += 1;
        this.eventQueue.push({ kind: "context-usage", ...this.usage });
      }
    } else if (message.method === "error") {
      const error = params.error as Record<string, unknown> | undefined;
      const reason = String(error?.message ?? params.message ?? "Codex app-server error");
      if (params.willRetry === true) this.eventQueue.push({ kind: "retry", provider: "codex", reason, managedBy: "provider" });
      else this.eventQueue.push({ kind: "error", message: reason });
    }
    const waiters = this.notificationWaiters.get(message.method) ?? [];
    const remaining: Waiter[] = [];
    for (const waiter of waiters) waiter.predicate(params) ? waiter.resolve(params) : remaining.push(waiter);
    this.notificationWaiters.set(message.method, remaining);
  }

  private waitFor(method: string, predicate: Waiter["predicate"], timeoutMs?: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        predicate,
        resolve: (params) => { if (timeout) clearTimeout(timeout); resolve(params); },
        reject: (error) => { if (timeout) clearTimeout(timeout); reject(error); },
      };
      const waiters = this.notificationWaiters.get(method) ?? [];
      waiters.push(waiter);
      this.notificationWaiters.set(method, waiters);
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          const active = this.notificationWaiters.get(method) ?? [];
          this.notificationWaiters.set(method, active.filter((candidate) => candidate !== waiter));
          reject(new Error(`Timed out waiting for Codex app-server notification ${method}`));
        }, timeoutMs);
      }
    });
  }

  private disconnect(error: Error): void {
    const child = this.process;
    this.process = undefined; this.initialized = false; this.threadAttached = false;
    if (child && child.exitCode === null) child.kill("SIGTERM");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiters of this.notificationWaiters.values()) for (const waiter of waiters) waiter.reject(error);
    this.notificationWaiters.clear();
  }

  private async restartForAutoCompaction(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    this.initialized = false;
    this.threadAttached = false;
    if (child.exitCode === null) child.kill("SIGTERM");
  }

  private buildSkillsAppendix(): string | undefined {
    if (!this.opts.skills?.length) return undefined;
    const blocks = this.opts.skills.map((skill) => loadSkillMarkdown(this.opts.cwd, skill)).filter((block): block is string => Boolean(block));
    return blocks.length ? ["# Preloaded Skills", "Use the following skills for this run.", ...blocks].join("\n\n") : undefined;
  }
}

function optionalNonNegative(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function validThreshold(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 99) throw new Error("automatic compaction threshold must be an integer from 1 to 99");
  return value;
}

function tokenLimit(maximum: number, percentage: number): number {
  return Math.max(1, Math.floor(maximum * percentage / 100));
}

function activityPhase(phase: BuilderAdapterOptions["runtimePhase"]): string {
  if (phase === "planning") return "planning";
  if (phase === "ticket-population") return "populating tickets";
  if (phase === "qa") return "reviewing with QA";
  if (phase === "uninstaller") return "planning uninstall";
  return "building";
}

function codexItemActivity(item: Record<string, unknown> | undefined, completed = false): { state: string; detail?: string } | undefined {
  if (!item) return undefined;
  const state = completed ? "completed" : "running";
  if (item.type === "commandExecution") return { state: `${state} command`, detail: typeof item.command === "string" ? item.command : undefined };
  if (item.type === "fileChange") return { state: `${state} file changes` };
  if (item.type === "mcpToolCall") return { state: `${state} MCP tool`, detail: String(item.tool ?? item.name ?? "") || undefined };
  if (item.type === "dynamicToolCall") return { state: `${state} tool`, detail: String(item.tool ?? item.name ?? "") || undefined };
  if (item.type === "webSearch") return { state: `${state} web search`, detail: typeof item.query === "string" ? item.query : undefined };
  if (item.type === "contextCompaction") return { state: completed ? "context compacted" : "compacting context" };
  if (item.type === "agentMessage") return { state: completed ? "received response" : "writing response" };
  return undefined;
}

function loadSkillMarkdown(cwd: string, skill: string): string | undefined {
  const projectPath = join(cwd, ".agents", "skills", skill, "SKILL.md");
  if (existsSync(projectPath)) return `## ${skill}\n${readFileSync(projectPath, "utf8").trim()}`;
  try { const bundled = loadSkill(skill); return bundled.body?.trim() ? `## ${bundled.name}\n${bundled.body.trim()}` : undefined; } catch { return undefined; }
}
