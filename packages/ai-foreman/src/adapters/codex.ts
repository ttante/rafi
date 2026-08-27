import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadSkill } from "special-agents";
import { BuilderEventQueue, withActivityPhase } from "../activity.js";
import { normalizeRuntimeErrorText } from "../runtimeAuth.js";
import type { BuilderAdapter, BuilderAdapterOptions, BuilderEvent, CompactResult, ContextUsage, ProviderSettingSwitch, TurnResult } from "./types.js";

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
  private initialized = false;
  private closed = false;
  private activeText: string[] = [];
  private usage?: ContextUsage;
  private stderr = "";

  constructor(private readonly opts: BuilderAdapterOptions) { this._sessionId = opts.resumeSessionId; }

  buildInstruction(instruction: string): string {
    return [this.opts.systemPromptAppend, this.buildSkillsAppendix(), instruction]
      .filter((part): part is string => Boolean(part)).join("\n\n");
  }

  buildAppServerArgs(): string[] { return ["app-server", "--listen", "stdio://"]; }

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
    try {
      await this.ensureThread();
      this.activeText = [];
      const completion = this.waitFor("turn/completed", (params) => params.threadId === this._sessionId);
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
      const result: TurnResult = { text: failed ? normalizeRuntimeErrorText("codex", String(error?.message ?? text), null, "app-server turn") : text, isError: failed, numTurns: 1, costUsd: 0 };
      this.eventQueue.push({ kind: "turn-complete", result });
      return result;
    } catch (error) {
      const detail = [error instanceof Error ? error.message : String(error), this.stderr].filter(Boolean).join("\n");
      const text = normalizeRuntimeErrorText("codex", detail, this.process?.exitCode ?? null, "builder turn");
      this.disconnect(new Error(text));
      const result = { text, isError: true, numTurns: 1, costUsd: 0 };
      this.eventQueue.push({ kind: "error", message: text });
      this.eventQueue.push({ kind: "turn-complete", result });
      return result;
    }
  }

  async compact(): Promise<CompactResult> {
    try {
      await this.ensureThread();
      this.eventQueue.push({ kind: "session-transition", transition: "compacting" });
      const done = this.waitFor("item/completed", (params) => {
        const item = params.item as Record<string, unknown> | undefined;
        return params.threadId === this._sessionId && item?.type === "contextCompaction";
      });
      await this.request("thread/compact/start", { threadId: this._sessionId });
      await done;
      this.usage = undefined;
      this.eventQueue.push({ kind: "session-transition", transition: "compacted" });
      return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  async contextUsage(): Promise<ContextUsage | undefined> { return this.usage; }
  async switchSettings(settings: ProviderSettingSwitch): Promise<CompactResult> {
    this.opts.model = settings.model; this.opts.effort = settings.effort; this.opts.fast = settings.fast;
    return { ok: true };
  }
  sessionId(): string | undefined { return this._sessionId; }
  events(): AsyncIterable<BuilderEvent> { return this.eventQueue; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.disconnect(new Error("app-server closed"));
    this.eventQueue.close();
  }

  private async ensureThread(): Promise<void> {
    await this.ensureConnection();
    if (this._sessionId && this.initialized === true && this.threadAttached) return;
    const method = this._sessionId ? "thread/resume" : "thread/start";
    const result = await this.request(method, {
      ...(this._sessionId ? { threadId: this._sessionId } : {}), cwd: this.opts.cwd,
      model: this.opts.model ?? null, approvalPolicy: "never",
      sandbox: this.opts.sandboxMode === "read-only" ? "read-only" : "workspace-write",
      developerInstructions: this.opts.systemPromptAppend ?? null,
    }) as Record<string, unknown>;
    const thread = result.thread as Record<string, unknown> | undefined;
    this._sessionId = String(thread?.id ?? this._sessionId ?? "") || undefined;
    if (!this._sessionId) throw new Error(`${method} did not return a thread ID`);
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
    child.on("error", (error) => this.disconnect(error));
    child.on("close", (code) => this.disconnect(new Error(`Codex app-server exited with code ${code ?? "unknown"}`)));
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
      const used = Number(total?.totalTokens ?? 0);
      const maximum = Number(tokenUsage?.modelContextWindow ?? 0) || undefined;
      this.usage = { used, maximum, ...(maximum ? { percentage: used / maximum * 100 } : {}) };
      this.eventQueue.push({ kind: "context-usage", ...this.usage });
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

  private waitFor(method: string, predicate: Waiter["predicate"]): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => { const waiters = this.notificationWaiters.get(method) ?? []; waiters.push({ predicate, resolve, reject }); this.notificationWaiters.set(method, waiters); });
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

  private buildSkillsAppendix(): string | undefined {
    if (!this.opts.skills?.length) return undefined;
    const blocks = this.opts.skills.map((skill) => loadSkillMarkdown(this.opts.cwd, skill)).filter((block): block is string => Boolean(block));
    return blocks.length ? ["# Preloaded Skills", "Use the following skills for this run.", ...blocks].join("\n\n") : undefined;
  }
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
