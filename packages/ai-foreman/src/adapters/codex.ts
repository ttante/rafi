import { OperationDeadline } from "../util/deadline.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadSkill } from "special-agents";
import { BuilderEventQueue, withActivityPhase } from "../activity.js";
import { normalizeRuntimeErrorText } from "../runtimeAuth.js";
import type { BuilderAdapter, BuilderAdapterOptions, BuilderEvent, CompactResult, ContextUsage, NativeAutoCompactionPolicy, NativeCompaction, ProviderSessionUsage, ProviderSettingSwitch, TurnResult } from "./types.js";
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
type Waiter = { predicate: (params: Record<string, unknown>) => boolean; resolve: (params: Record<string, unknown>) => void; reject: (error: Error) => void; touch?: () => void };

/** A provider can legitimately take a long time, but not without any event. */
const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 30 * 60_000;

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
  private turnUsageBaseline?: ProviderSessionUsage;
  private lastTurnTokens?: { inputTokens?: number; outputTokens?: number };
  private stderr = "";
  private nativeAutoCompactTokenLimit?: number;
  private autoCompactionPrepared = false;
  private preparedAutoCompactThreshold?: number;
  private preparedAutoCompactionPolicy?: NativeAutoCompactionPolicy;
  private nativeCompactions: NativeCompaction[] = [];
  private nativeCompactionSequence = 0;
  private manualCompactionInFlight = false;
  private compactionPromise?: Promise<CompactResult>;
  private compactionActive = false;
  private compactionUncertain = false;
  private observedToolCalls = 0;
  private activeProviderTurnId?: string;
  private activeProviderTurnSpanId?: string;
  private readonly toolSpans = new Map<string, string>();

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

  async sendTurn(instruction: string, policy?: { handback?: boolean; responseOnly?: boolean; logicalActionId?: string }): Promise<TurnResult> {
    const turnId = randomUUID();
    this.activeProviderTurnId = turnId;
    const observer = this.opts.observer;
    if (!observer) {
      try { return await withActivityPhase(`Codex ${activityPhase(this.opts.runtimePhase)}`, () => this.sendTurnInternal(instruction, policy)); }
      finally { this.activeProviderTurnId = undefined; }
    }
    const context = this.observationContext();
    const spanId = observer.store.startSpan(context, { spanId: turnId, kind: "provider_turn", name: `Codex ${activityPhase(this.opts.runtimePhase)}`, providerTurnId: turnId, attributes: { provider: "codex" } });
    this.activeProviderTurnSpanId = spanId;
    observer.store.updateCurrentState({ runId: observer.runId, role: context.role ?? "host", stream: context.stream ?? "codex", executionId: observer.executionId, ticketId: context.ticketId, deliveryUnitId: context.deliveryUnitId, providerSessionId: context.providerSessionId, phase: "provider turn", activeSpanId: spanId, activeSpanKind: "provider_turn", lastSemanticProgressAt: new Date().toISOString() });
    try {
      const result = await withActivityPhase(`Codex ${activityPhase(this.opts.runtimePhase)}`, () => this.sendTurnInternal(instruction, policy));
      observer.store.finishSpan(spanId, { outcome: result.isError ? "failed" : "completed", attributes: { usage: result.usage } });
      return result;
    } catch (error) {
      observer.store.finishSpan(spanId, { outcome: "failed", attributes: { error: String(error).slice(0, 500) } });
      throw error;
    } finally {
      for (const [callId, toolSpanId] of this.toolSpans) { observer.store.finishSpan(toolSpanId, { outcome: "unknown", completionKnown: false }); this.toolSpans.delete(callId); }
      this.activeProviderTurnId = undefined; this.activeProviderTurnSpanId = undefined;
    }
  }

  private async sendTurnInternal(instruction: string, policy?: { responseOnly?: boolean }): Promise<TurnResult> {
    if (this.closed) throw new Error("builder is closed");
    this.eventQueue.push({ kind: "activity", state: "starting Codex turn", provider: "codex", model: this.opts.model });
    let turnStartDispatched = false;
    const providerInstruction = this.buildInstruction(instruction);
    try {
      await this.ensureThread();
      const toolsBefore = this.observedToolCalls;
      this.activeText = [];
      this.lastTurnTokens = undefined;
      this.turnUsageBaseline = this.providerSessionUsage ? { ...this.providerSessionUsage } : undefined;
      const completion = this.waitFor("turn/completed", (params) => params.threadId === this._sessionId, this.providerIdleTimeoutMs(), true);
      turnStartDispatched = true;
      await this.request("turn/start", {
        threadId: this._sessionId,
        input: [{ type: "text", text: providerInstruction, text_elements: [] }],
        cwd: this.opts.cwd,
        model: this.opts.model ?? null,
        effort: this.opts.effort ?? (this.opts.fast ? "low" : null),
      });
      const params = await new OperationDeadline("Codex active turn", this.opts.turnDeadlineMs ?? 3_600_000).run(() => completion);
      const turn = params.turn as Record<string, unknown> | undefined;
      const responseOnlyViolation = Boolean(policy?.responseOnly && this.observedToolCalls !== toolsBefore);
      const failed = turn?.status === "failed" || responseOnlyViolation;
      const error = turn?.error as Record<string, unknown> | null | undefined;
      const text = this.activeText.join("\n");
      const result: TurnResult = {
        text: failed ? normalizeRuntimeErrorText("codex", String(responseOnlyViolation ? "Response-only correction used tools; its result cannot authorize completion" : error?.message ?? text), null, "app-server turn") : text,
        isError: failed, numTurns: 1, costUsd: 0, costAuthoritative: false,
        turnId: this.activeProviderTurnId, hostInstruction: instruction, providerInstruction,
        rawResponse: text, cleanedResponse: failed ? normalizeRuntimeErrorText("codex", String(responseOnlyViolation ? "Response-only correction used tools; its result cannot authorize completion" : error?.message ?? text), null, "app-server turn") : text,
        providerMetadata: { provider: "codex", sessionId: this._sessionId, sessionRef: this._sessionRef },
        ...(this.lastTurnTokens ?? {}),
      };
      result.usage = { scope: "turn-delta", inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        ...(result.inputTokens !== undefined || result.outputTokens !== undefined ? { totalTokens: (result.inputTokens ?? 0) + (result.outputTokens ?? 0) } : {}) };
      this.eventQueue.push({ kind: "turn-complete", result, turnId: result.turnId });
      return result;
    } catch (error) {
      if (error instanceof SessionUnavailableError) {
        const result = sessionUnavailableResult(error);
        this.eventQueue.push({ kind: "error", message: result.text });
        result.turnId = this.activeProviderTurnId; result.hostInstruction = instruction; result.providerInstruction = providerInstruction;
        result.rawResponse = result.text; result.cleanedResponse = result.text;
        result.providerMetadata = { provider: "codex", sessionId: this._sessionId, sessionRef: this._sessionRef };
        this.eventQueue.push({ kind: "turn-complete", result, turnId: result.turnId });
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
        : { text, isError: true, numTurns: 1, costUsd: 0, costAuthoritative: false, failure: { runtime: "codex", phase: turnStartDispatched ? "turn" : "attach", category: "agent-stream", executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: text, dispatchState: turnStartDispatched ? "unknown" : "not-sent" } };
      this.eventQueue.push({ kind: "error", message: text });
      result.turnId = this.activeProviderTurnId; result.hostInstruction = instruction; result.providerInstruction = providerInstruction;
      result.rawResponse = result.text; result.cleanedResponse = result.text;
      result.providerMetadata = { provider: "codex", sessionId: this._sessionId, sessionRef: this._sessionRef };
      this.eventQueue.push({ kind: "turn-complete", result, turnId: result.turnId });
      return result;
    }
  }

  async compact(): Promise<CompactResult> {
    if (this.compactionPromise) return this.compactionPromise;
    const operation = this.opts.observer
      ? this.opts.observer.span("compaction", "Codex context compaction", () => this.compactInternal())
      : this.compactInternal();
    this.compactionPromise = operation;
    try { return await operation; }
    finally { if (this.compactionPromise === operation) this.compactionPromise = undefined; }
  }

  private async compactInternal(): Promise<CompactResult> {
    if (this.compactionUncertain) return { ok: false, error: "Prior compaction outcome is uncertain; validate a fresh successor before further work" };
    if (this.compactionActive) return { ok: false, error: "Compaction is already in progress for this session" };
    if (this.manualCompactionInFlight) return { ok: false, error: "Codex compaction already in flight" };
    this.compactionActive = true;
    const controller = new AbortController();
    const began = performance.now();
    const timeoutMs = Math.min(180_000, Math.max(1, this.opts.compactionTimeoutMs ?? 120_000));
    const hardTimeoutMs = Math.min(180_000, timeoutMs * 1.5);
    this.traceLifecycle("compaction-started", { timeoutMs });
    const deadline = new OperationDeadline("Codex compaction", timeoutMs, hardTimeoutMs);
    try {
      await deadline.run(() => this.ensureThread());
      this.eventQueue.push({ kind: "session-transition", transition: "compacting" });
      const usageRevision = this.usageRevision;
      // A pre-compaction observation must never be mistaken for proof that the
      // provider reduced the live context. The app server emits a fresh token
      // usage notification for the compacted thread; require it alongside the
      // explicit contextCompaction completion item.
      this.usage = undefined;
      let compactionItemId: string | undefined;
      const progress = this.waitFor("item/started", params => {
        const item = params.item as Record<string, unknown> | undefined;
        if (params.threadId !== this._sessionId || item?.type !== "contextCompaction" || typeof item.id !== "string") return false;
        compactionItemId = item.id;
        deadline.extendForCorrelatedProgress();
        this.traceLifecycle("compaction-deadline-extended", { timeoutMs: hardTimeoutMs });
        return true;
      }, hardTimeoutMs, false, controller.signal);
      void progress.catch(() => {});
      const done = this.waitFor("item/completed", (params) => {
        const item = params.item as Record<string, unknown> | undefined;
        return params.threadId === this._sessionId && item?.type === "contextCompaction" && (!compactionItemId || item.id === compactionItemId);
      }, hardTimeoutMs, false, controller.signal);
      const postCompactUsage = this.waitFor("thread/tokenUsage/updated", (params) => {
        return params.threadId === this._sessionId
          && this.usageRevision > usageRevision
          && this.usage !== undefined;
      }, hardTimeoutMs, false, controller.signal);
      this.manualCompactionInFlight = true;
      try {
        const acknowledgementFailure = this.request("thread/compact/start", { threadId: this._sessionId }).then(
          () => { this.traceLifecycle("compaction-acknowledged"); return new Promise<never>(() => {}); },
          error => {
            // A missing acknowledgement is not failure evidence. Explicit
            // completion plus fresh occupancy is sufficient to reconcile it.
            if (/deadline|timed out/i.test(String(error))) return new Promise<never>(() => {});
            throw error;
          },
        );
        await deadline.run(() => Promise.race([Promise.all([done, postCompactUsage]), acknowledgementFailure]));
      } finally { this.manualCompactionInFlight = false; }
      this.eventQueue.push({ kind: "session-transition", transition: "compacted" });
      this.traceLifecycle("compaction-completed", { elapsedMs: performance.now() - began });
      return { ok: true };
    } catch (error) {
      if (error instanceof SessionUnavailableError) return { ok: false, error: error.message, failure: error.failure };
      this.compactionUncertain = true;
      this.usage = undefined;
      this.traceLifecycle("compaction-failed", { elapsedMs: performance.now() - began });
      const detail = error instanceof Error ? error.message : String(error);
      if (/deadline|timed out/i.test(detail)) {
        // Waiting expired, not the provider operation. Quarantine this adapter;
        // the host must reconcile it instead of automatically starting a writer.
        const failure = new SessionUnavailableError({ runtime: "codex", phase: "turn", dispatchState: "unknown", executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: detail });
        this.closed = true;
        this.disconnect(failure);
        this.eventQueue.close();
        return { ok: false, error: detail, failure: failure.failure };
      }
      return { ok: false, error: detail };
    } finally { controller.abort(); this.compactionActive = false; }
  }

  async prepareAutoCompaction(thresholdPercent = this.opts.autoCompactThresholdPercent): Promise<NativeAutoCompactionPolicy | void> {
    return new OperationDeadline("Codex auto-compaction preparation", this.opts.preparationTimeoutMs ?? 120_000).run(() => this.prepareAutoCompactionInternal(thresholdPercent), () => this.disconnect(new Error("Codex preparation expired")));
  }

  private async prepareAutoCompactionInternal(thresholdPercent = this.opts.autoCompactThresholdPercent): Promise<NativeAutoCompactionPolicy | void> {
    if (thresholdPercent === undefined) return;
    const threshold = validThreshold(thresholdPercent);
    if (this.autoCompactionPrepared && this.preparedAutoCompactThreshold === threshold) return this.preparedAutoCompactionPolicy;
    this.opts.autoCompactThresholdPercent = threshold;
    await this.ensureThread();
    // Codex reports its model context window in token-usage notifications, not
    // in thread/start. Establish the otherwise idle thread with a constrained
    // setup turn, then restart the app server with the provider-native ceiling
    // before any Builder or QA work is sent.
    if (!this.usage?.maximum) {
      if (this.opts.allowAutoCompactionSetupTurn === false) return;
      const toolsBefore = this.observedToolCalls;
      const setup = await this.sendTurnInternal("Rafi internal initialization only. Do not call tools or modify files. Reply briefly that the context is ready.");
      if (setup.isError) throw new Error(`Codex automatic-compaction setup failed: ${setup.text.slice(0, 240)}`);
      if (this.observedToolCalls !== toolsBefore) throw new Error("Codex automatic-compaction setup unexpectedly called a tool");
    }
    const maximum = this.usage?.maximum;
    if (!maximum || !Number.isFinite(maximum) || maximum <= 0) {
      throw new Error("Codex did not report a model context window during automatic-compaction setup");
    }
    this.nativeAutoCompactTokenLimit = tokenLimit(maximum, threshold);
    await this.restartForAutoCompaction();
    await this.ensureThread();
    this.autoCompactionPrepared = true;
    this.preparedAutoCompactThreshold = threshold;
    this.preparedAutoCompactionPolicy = {
      requestedThresholdPercent: threshold,
      effectiveThresholdPercent: threshold,
      modelContextWindow: maximum,
      triggerTokens: this.nativeAutoCompactTokenLimit,
    };
    return this.preparedAutoCompactionPolicy;
  }

  requiresAutoCompactionSetupTurn(): boolean {
    return this.opts.autoCompactThresholdPercent !== undefined && !this.autoCompactionPrepared && !this.usage?.maximum;
  }

  autoCompactionPolicy(): NativeAutoCompactionPolicy | undefined { return this.preparedAutoCompactionPolicy; }

  drainNativeCompactions(): NativeCompaction[] {
    const pending = this.nativeCompactions;
    this.nativeCompactions = [];
    return pending;
  }
  restoreNativeCompactions(compactions: NativeCompaction[]): void { this.nativeCompactions.unshift(...compactions); }

  async contextUsage(): Promise<ContextUsage | undefined> { return this.usage; }
  async contextUsageAfterNativeCompaction(compaction: NativeCompaction): Promise<ContextUsage | undefined> {
    if (compaction.usageRevision === undefined || this.usageRevision > compaction.usageRevision) return this.usage;
    try {
      await this.waitFor("thread/tokenUsage/updated", () => this.usageRevision > compaction.usageRevision!, 5_000);
      return this.usage;
    } catch { return undefined; }
  }
  async sessionUsage(): Promise<ProviderSessionUsage | undefined> { return this.providerSessionUsage ? { ...this.providerSessionUsage } : undefined; }
  async switchSettings(settings: ProviderSettingSwitch): Promise<CompactResult> {
    this.opts.model = settings.model; this.opts.effort = settings.effort; this.opts.fast = settings.fast;
    return { ok: true };
  }
  sessionId(): string | undefined { return this._sessionId; }
  sessionRef(): ProviderSessionRefV1 | undefined { return this._sessionRef; }
  async prepareSession(): Promise<ProviderSessionRefV1> {
    await this.ensureThread();
    if (!this._sessionRef) throw new Error("Codex did not expose a scoped thread identity during session preparation");
    if (!this._sessionRef.validatedAt) this._sessionRef = { ...this._sessionRef, validatedAt: new Date().toISOString() };
    return this._sessionRef;
  }
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
  observeEvents(listener: (event: BuilderEvent) => void): () => void { return this.eventQueue.observe(listener); }

  events(): AsyncIterable<BuilderEvent> { return this.eventQueue; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.process;
    let onExit: (() => void) | undefined;
    const exited = child && child.exitCode === null ? new Promise<void>(resolve => { onExit = resolve; child.once("exit", resolve); }) : Promise.resolve();
    this.disconnect(new Error("app-server closed"));
    this.eventQueue.close();
    try {
      try { await new OperationDeadline("Codex shutdown", this.opts.shutdownTimeoutMs ?? 10_000).run(() => exited); }
      catch {
        child?.kill("SIGKILL");
        await new OperationDeadline("Codex forced shutdown", 5_000).run(() => exited);
      }
    }
    finally { if (onExit) child?.off("exit", onExit); }
  }

  private async ensureThread(): Promise<void> {
    return new OperationDeadline("Codex preparation", this.opts.preparationTimeoutMs ?? 120_000).run(() => this.ensureThreadInternal(), () => this.disconnect(new Error("Codex preparation deadline exceeded")));
  }

  private async ensureThreadInternal(): Promise<void> {
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
    if (!returnedSessionId?.trim()) throw new Error(`${method} did not return a thread ID`);
    const providerCwd = typeof thread?.cwd === "string" ? canonicalSessionPath(thread.cwd) : undefined;
    const expectedCwd = canonicalSessionPath(this._sessionRef?.cwd ?? this.opts.cwd);
    if ((providerCwd && providerCwd !== expectedCwd) || (!providerCwd && this.opts.sessionRole === "qa")) {
      const availability: SessionAvailabilityV1 = { version: 1, status: "unavailable", checkedAt: new Date().toISOString(), reason: "cwd-mismatch", observedCwd: providerCwd, detail: `Codex thread cwd ${providerCwd ?? "was not returned"} does not match ${expectedCwd}`, sessionRef: this._sessionRef };
      this.sessionAvailability = availability;
      throw new SessionUnavailableError({ runtime: "codex", phase: "attach", dispatchState: "not-sent", executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: availability.detail!, availability });
    }
    this._sessionId = returnedSessionId;
    if (!this._sessionRef) {
      this._sessionRef = createProviderSessionRef({
        provider: "codex", sessionId: this._sessionId, cwd: providerCwd ?? this.opts.cwd, configRoot: this.opts.configRoot ?? this.opts.cwd,
        role: this.opts.sessionRole, stream: this.opts.sessionStream, generation: this.opts.sessionGeneration,
        workspaceIdentity: this.opts.workspaceIdentity, ticketId: this.opts.ticketId, deliveryUnitId: this.opts.deliveryUnitId,
        validatedAt: new Date().toISOString(),
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
    return new OperationDeadline(`Codex RPC ${method}`, this.opts.rpcTimeoutMs ?? 60_000).run(() => new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); } catch (error) { this.pending.delete(id); reject(error as Error); }
    }), () => { this.pending.delete(id); });
  }

  private write(message: RpcMessage): void {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server is not connected");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handle(message: RpcMessage): void {
    this.touchWaiters();
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) { this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message ?? `JSON-RPC error ${message.error.code ?? "unknown"}`)) : pending.resolve(message.result); }
      return;
    }
    if (!message.method) return;
    const params = message.params ?? {};
    if (message.method === "item/started") {
      const item = params.item as Record<string, unknown> | undefined;
      if (item) this.eventQueue.push({ kind: "provider-item", provider: "codex", lifecycle: "started", itemType: String(item.type ?? "unknown"), payload: exactProviderItem(item), payloadCompleteness: "complete", providerTurnId: this.activeProviderTurnId, eventId: randomUUID(), observedAt: new Date().toISOString() });
      if (isCodexToolItem(item)) {
        this.observedToolCalls += 1;
        const callId = codexItemId(item) ?? randomUUID();
        const name = codexToolName(item);
        this.eventQueue.push({ kind: "tool", name, input: exactToolInput(item), inputCompleteness: "complete", lifecycle: "started", callId, completionKnown: false, providerTurnId: this.activeProviderTurnId, eventId: randomUUID(), observedAt: new Date().toISOString() });
        if (this.opts.observer) {
          const spanId = this.opts.observer.store.startSpan(this.observationContext(), { kind: "tool", name, providerTurnId: this.activeProviderTurnId, attributes: { callId, input: boundedToolInput(item) } });
          this.toolSpans.set(callId, spanId);
          this.opts.observer.signal(true);
        }
      }
      const activity = codexItemActivity(item);
      if (activity) this.eventQueue.push({ kind: "activity", provider: "codex", ...activity });
    } else if (message.method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined;
      if (item) this.eventQueue.push({ kind: "provider-item", provider: "codex", lifecycle: "completed", itemType: String(item.type ?? "unknown"), payload: exactProviderItem(item), payloadCompleteness: "complete", providerTurnId: this.activeProviderTurnId, eventId: randomUUID(), observedAt: new Date().toISOString() });
      if (isCodexToolItem(item)) {
        const callId = codexItemId(item);
        const spanId = callId ? this.toolSpans.get(callId) : undefined;
        const status = typeof item?.status === "string" ? item.status : undefined;
        const exitCode = finiteNumber(item?.exitCode ?? item?.exit_code);
        const durationMs = finiteNumber(item?.durationMs ?? item?.duration_ms);
        const output = codexOutputSummary(item);
        this.eventQueue.push({ kind: "tool", name: codexToolName(item), input: exactToolInput(item), inputCompleteness: "complete", lifecycle: "completed", callId, status, durationMs, exitCode, outputSummary: output?.summary, outputDigest: output?.digest, outputCompleteness: output?.completeness ?? "unavailable", rawOutputBytes: output?.bytes, completionKnown: true, providerTurnId: this.activeProviderTurnId, eventId: randomUUID(), observedAt: new Date().toISOString() });
        if (spanId && this.opts.observer) { this.opts.observer.store.finishSpan(spanId, { outcome: status ?? (exitCode === undefined || exitCode === 0 ? "completed" : "failed"), completionKnown: true, attributes: { callId, providerDurationMs: durationMs, exitCode, outputSummary: output?.summary, outputDigest: output?.digest } }); this.toolSpans.delete(callId!); }
        this.opts.observer?.signal(true);
      }
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        this.activeText.push(item.text);
        this.eventQueue.push({ kind: "text", text: item.text, byteCount: Buffer.byteLength(item.text), digest: createHash("sha256").update(item.text).digest("hex"), eventId: randomUUID(), observedAt: new Date().toISOString() });
        this.opts.observer?.signal(true);
      }
      else if (item?.type === "commandExecution") { /* tool completion was emitted above */
      } else if (item?.type === "contextCompaction" && !this.manualCompactionInFlight) {
        // Completion is the provider's authoritative confirmation. Token-usage
        // notifications may arrive before or after it, so do not make durable
        // compaction accounting depend on their delivery order.
        this.nativeCompactions.push({
          id: `codex:${this._sessionId ?? "unknown"}:${Date.now()}:${++this.nativeCompactionSequence}`,
          occurredAt: new Date().toISOString(),
          provider: "codex",
          usageRevision: this.usageRevision,
        });
        this.eventQueue.push({ kind: "session-transition", transition: "compacted", detail: "provider-native automatic compaction" });
      }
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
      if (this._sessionId && params.threadId !== this._sessionId) return;
      const used = optionalNonNegative(last?.totalTokens);
      const maximum = Number(tokenUsage?.modelContextWindow);
      const observedAt = new Date().toISOString();
      const totalInput = optionalNonNegative(total?.inputTokens);
      const totalOutput = optionalNonNegative(total?.outputTokens);
      const sessionTotal = optionalNonNegative(total?.totalTokens);
      if (totalInput !== undefined || totalOutput !== undefined || sessionTotal !== undefined) {
        this.providerSessionUsage = { inputTokens: totalInput, outputTokens: totalOutput, totalTokens: sessionTotal, observedAt, source: "provider" };
      }
      if ((totalInput !== undefined && this.turnUsageBaseline?.inputTokens !== undefined && totalInput < this.turnUsageBaseline.inputTokens) || (totalOutput !== undefined && this.turnUsageBaseline?.outputTokens !== undefined && totalOutput < this.turnUsageBaseline.outputTokens)) this.turnUsageBaseline = undefined;
      this.lastTurnTokens = {
        inputTokens: cumulativeDelta(this.turnUsageBaseline?.inputTokens, totalInput),
        outputTokens: cumulativeDelta(this.turnUsageBaseline?.outputTokens, totalOutput),
      };
      this.usage = undefined;
      if (used !== undefined && Number.isFinite(maximum) && maximum > 0) {
        this.usage = { used, maximum, percentage: used / maximum * 100, observedAt, source: "provider-event" };
        this.usageRevision += 1;
        this.eventQueue.push({ kind: "context-usage", ...this.usage });
      }
    } else if (message.method === "error") {
      const error = params.error as Record<string, unknown> | undefined;
      const reason = String(error?.message ?? params.message ?? "Codex app-server error");
      if (params.willRetry === true) {
        const retryId = randomUUID();
        this.eventQueue.push(this.opts.observer
          ? { kind: "retry", provider: "codex", reason, managedBy: "provider", retryId, providerTurnId: this.activeProviderTurnId, eventId: retryId, observedAt: new Date().toISOString() }
          : { kind: "retry", provider: "codex", reason, managedBy: "provider" });
        if (this.opts.observer) {
          const retrySpanId = this.opts.observer.store.startSpan(this.observationContext(), { spanId: retryId, kind: "retry", name: "Codex provider retry", providerTurnId: this.activeProviderTurnId,
            attributes: { provider: "codex", reasonDigest: createHash("sha256").update(reason).digest("hex") } });
          this.opts.observer.store.recordEvent(this.observationContext(), "retry", { eventId: retryId, spanId: retrySpanId, severity: "warning", attributes: { provider: "codex", reasonDigest: createHash("sha256").update(reason).digest("hex") } });
          this.opts.observer.store.finishSpan(retrySpanId, { outcome: "reported" });
        }
      }
      else this.eventQueue.push({ kind: "error", message: reason });
    }
    const waiters = this.notificationWaiters.get(message.method) ?? [];
    const remaining: Waiter[] = [];
    for (const waiter of waiters) waiter.predicate(params) ? waiter.resolve(params) : remaining.push(waiter);
    this.notificationWaiters.set(message.method, remaining);
  }

  private observationContext() {
    const observer = this.opts.observer!;
    const inherited = observer.context();
    return { ...inherited, runId: observer.runId, executionId: observer.executionId, role: this.opts.sessionRole ?? inherited.role ?? "builder" as const,
      stream: this.opts.sessionStream ?? inherited.stream ?? this.opts.sessionRole ?? "builder", providerSessionId: this._sessionId,
      ticketId: this.opts.ticketId ?? inherited.ticketId, deliveryUnitId: this.opts.deliveryUnitId ?? inherited.deliveryUnitId,
      parentSpanId: this.activeProviderTurnSpanId ?? inherited.parentSpanId, providerTurnId: this.activeProviderTurnId ?? inherited.providerTurnId };
  }

  private waitFor(method: string, predicate: Waiter["predicate"], timeoutMs?: number, resetOnProviderActivity = false, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const began = performance.now();
      const clear = () => { if (timeout) clearTimeout(timeout); timeout = undefined; signal?.removeEventListener("abort", abort); };
      const waiter: Waiter = {
        predicate,
        resolve: (params) => { clear(); this.traceLifecycle("waiter-completed", { method, elapsedMs: performance.now() - began }); resolve(params); },
        reject: (error) => { clear(); reject(error); },
      };
      const abort = () => {
        this.notificationWaiters.set(method, (this.notificationWaiters.get(method) ?? []).filter(candidate => candidate !== waiter));
        clear();
        this.traceLifecycle("waiter-cancelled", { method });
        reject(new Error(`Codex waiter cancelled: ${method}`));
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      this.traceLifecycle("waiter-registered", { method, timeoutMs });
      const waiters = this.notificationWaiters.get(method) ?? [];
      waiters.push(waiter);
      this.notificationWaiters.set(method, waiters);
      if (timeoutMs !== undefined) {
        const arm = () => { timeout = setTimeout(() => {
          const active = this.notificationWaiters.get(method) ?? [];
          this.notificationWaiters.set(method, active.filter((candidate) => candidate !== waiter));
          clear();
          this.traceLifecycle("waiter-timeout", { method, timeoutMs, elapsedMs: performance.now() - began });
          reject(new Error(`Codex provider wait timed out after ${timeoutMs} ms while waiting for ${method}; the turn may have been dispatched and will not be retried automatically`));
        }, timeoutMs); };
        if (resetOnProviderActivity) waiter.touch = () => { clear(); arm(); };
        arm();
      }
    });
  }

  private traceLifecycle(phase: string, data: { method?: string; timeoutMs?: number; elapsedMs?: number } = {}): void {
    try { this.opts.onLifecycleTrace?.({ phase, at: new Date().toISOString(), sessionId: this._sessionId, ...data }); } catch { /* diagnostics cannot change execution */ }
  }

  private touchWaiters(): void {
    for (const waiters of this.notificationWaiters.values()) for (const waiter of waiters) waiter.touch?.();
  }

  private providerIdleTimeoutMs(): number {
    const configured = this.opts.providerIdleTimeoutMs;
    return Number.isFinite(configured) && configured! > 0 ? configured! : DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
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
    if (this.opts.preloadedSkillContent?.length) {
      return ["# Preloaded Skills", "Use the following skills for this run.", ...this.opts.preloadedSkillContent.map((skill) => skill.content)].join("\n\n");
    }
    if (!this.opts.skills?.length) return undefined;
    const blocks = this.opts.skills.map((skill) => loadSkillMarkdown(this.opts.cwd, skill)).filter((block): block is string => Boolean(block));
    return blocks.length ? ["# Preloaded Skills", "Use the following skills for this run.", ...blocks].join("\n\n") : undefined;
  }
}

function optionalNonNegative(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
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
  if (phase === "manager") return "analyzing diagnostics";
  if (phase === "discovery") return "discovering project context";
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

function isCodexToolItem(item: Record<string, unknown> | undefined): boolean {
  return item?.type === "commandExecution" || item?.type === "mcpToolCall" || item?.type === "dynamicToolCall" || item?.type === "webSearch" || item?.type === "fileChange";
}

function codexItemId(item: Record<string, unknown> | undefined): string | undefined { const value = item?.id ?? item?.itemId ?? item?.callId; return typeof value === "string" && value ? value : undefined; }
function codexToolName(item: Record<string, unknown> | undefined): string { return String(item?.tool ?? item?.name ?? item?.type ?? "tool"); }
function exactProviderItem(item: Record<string, unknown>): Record<string, unknown> { return structuredClone(item); }
function exactToolInput(item: Record<string, unknown> | undefined): Record<string, unknown> { return item ? exactProviderItem(item) : {}; }
function boundedToolInput(item: Record<string, unknown> | undefined): Record<string, unknown> { if (!item) return {}; return Object.fromEntries(Object.entries(exactToolInput(item)).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 1000) : value])); }
function codexOutputSummary(item: Record<string, unknown> | undefined): { summary: string; digest: string; completeness: "complete" | "truncated"; bytes: number } | undefined { const value = item?.aggregatedOutput ?? item?.output ?? item?.stdout; if (typeof value !== "string" || !value) return undefined; const sanitized = value.replace(/\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]"); const providerTruncated = item?.outputTruncated === true || item?.truncated === true; return { summary: sanitized.slice(0, 1000), digest: createHash("sha256").update(value).digest("hex"), completeness: providerTruncated ? "truncated" : "complete", bytes: Buffer.byteLength(value) }; }
function finiteNumber(value: unknown): number | undefined { const result = Number(value); return Number.isFinite(result) ? result : undefined; }

function loadSkillMarkdown(cwd: string, skill: string): string | undefined {
  const projectPath = [join(cwd, ".codex", "skills", skill, "SKILL.md"), join(cwd, ".agents", "skills", skill, "SKILL.md")].find(existsSync);
  if (projectPath) return `## ${skill}\n${readFileSync(projectPath, "utf8").trim()}`;
  try { const bundled = loadSkill(skill); return bundled.body?.trim() ? `## ${bundled.name}\n${bundled.body.trim()}` : undefined; } catch { return undefined; }
}

function cumulativeDelta(before: number | undefined, after: number | undefined): number | undefined {
  return before !== undefined && after !== undefined && after >= before ? after - before : undefined;
}
