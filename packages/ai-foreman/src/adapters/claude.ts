import type {
  Query,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

/** Lazy-load the Claude Agent SDK. Throws an actionable error if not installed. */
export async function requireClaudeSDK() {
  try {
    return await import("@anthropic-ai/claude-agent-sdk");
  } catch {
    throw new Error(
      "Rafi's Claude Agent SDK dependency is not installed.\n" +
      "Reinstall Rafi/ai-foreman with optional dependencies enabled; do not install the SDK into the target application.\n" +
      "Or use Codex for this run with --agent codex.",
    );
  }
}
import { AsyncQueue } from "../util/asyncQueue.js";
import { BuilderEventQueue, withActivityPhase } from "../activity.js";
import { normalizeRuntimeErrorText } from "../runtimeAuth.js";
import {
  classifyClaudeSdkFailure,
  resolveExecutablePath,
  sanitizeDiagnostics,
} from "../runtimeReadiness.js";
import type {
  BuilderAdapter,
  BuilderAdapterOptions,
  BuilderEvent,
  CompactResult,
  ContextUsage,
  PermissionDecision,
  ProviderSettingSwitch,
  ProviderSessionUsage,
  TurnResult,
} from "./types.js";
import type { ProviderSessionRefV1, SessionAvailabilityV1 } from "rafi-spec";
import { createProviderSessionRef, validateProviderSessionScope, canonicalSessionPath } from "../sessionIdentity.js";
import { SessionUnavailableError, sessionUnavailableResult } from "./sessionFailure.js";

/**
 * Pure function: build the `options` object passed to `query()`.
 * Extracted so tests can assert on the shape without making a live SDK call.
 * `canUseTool` is omitted here — it's a closure that the constructor adds.
 */
export function buildClaudeQueryOptions(
  opts: Omit<BuilderAdapterOptions, "permission">,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    cwd: opts.cwd,
    pathToClaudeCodeExecutable: opts.runtimeExecutable,
    env: { ...process.env },
    model: opts.model,
    resume: opts.resumeSessionRef?.sessionId ?? opts.resumeSessionId,
    permissionMode: "acceptEdits",
    effort: opts.effort,
    extraArgs: opts.fast ? { fast: null } : undefined,
    settingSources: ["user", "project", "local"],
  };
  if (opts.systemPromptAppend) {
    base.systemPrompt = { type: "preset", preset: "claude_code", append: opts.systemPromptAppend };
  }
  if (opts.skills !== undefined) {
    base.skills = opts.skills;
  }
  return base;
}

export async function probeClaudeSession(
  ref: ProviderSessionRefV1,
  input: {
    cwd: string;
    configRoot?: string;
    workspaceIdentity?: string;
    role?: ProviderSessionRefV1["role"];
    stream?: string;
    ticketId?: string;
    deliveryUnitId?: string;
    getSessionInfo?: (sessionId: string, options?: { dir?: string }) => Promise<SDKSessionInfo | undefined>;
    now?: Date;
  },
): Promise<SessionAvailabilityV1> {
  const now = input.now ?? new Date();
  const local = validateProviderSessionScope(ref, {
    provider: "claude",
    cwd: input.cwd,
    configRoot: input.configRoot ?? input.cwd,
    role: input.role ?? ref.role,
    stream: input.stream ?? ref.stream,
    workspaceIdentity: input.workspaceIdentity,
    ticketId: input.ticketId ?? ref.ticketId,
    deliveryUnitId: input.deliveryUnitId ?? ref.deliveryUnitId,
  }, now);
  if (local.status !== "available") return local;
  try {
    const getSessionInfo = input.getSessionInfo ?? (await requireClaudeSDK()).getSessionInfo;
    const info = await getSessionInfo(ref.sessionId, { dir: ref.cwd });
    if (!info) return { version: 1, status: "unavailable", checkedAt: now.toISOString(), reason: "not-found", detail: `Claude has no conversation ${ref.sessionId} in ${ref.cwd}`, sessionRef: ref };
    if (info.sessionId !== ref.sessionId) return { version: 1, status: "unavailable", checkedAt: now.toISOString(), reason: "not-found", detail: "Claude returned metadata for a different session", sessionRef: ref };
    if (!info.cwd) return { version: 1, status: "unknown", checkedAt: now.toISOString(), reason: "probe-failed", detail: "Claude session metadata did not include cwd", sessionRef: ref };
    const observedCwd = canonicalSessionPath(info.cwd);
    if (observedCwd !== canonicalSessionPath(ref.cwd)) return { version: 1, status: "unavailable", checkedAt: now.toISOString(), reason: "cwd-mismatch", detail: `Claude metadata cwd ${observedCwd} does not match ${ref.cwd}`, observedCwd, sessionRef: ref };
    return { ...local, checkedAt: now.toISOString(), observedCwd, sessionRef: { ...local.sessionRef!, validatedAt: now.toISOString() } };
  } catch (error) {
    return { version: 1, status: "unknown", checkedAt: now.toISOString(), reason: "probe-failed", detail: sanitizeDiagnostics(error instanceof Error ? error.message : String(error)), sessionRef: ref };
  }
}

export function permissionDecisionToClaudeResult(
  decision: PermissionDecision,
  toolUseID?: string,
): PermissionResult {
  if (decision.behavior === "allow") {
    return {
      behavior: "allow",
      updatedInput: decision.updatedInput,
      updatedPermissions: decision.updatedPermissions as PermissionResult extends { updatedPermissions?: infer T } ? T : never,
      toolUseID,
    };
  }
  return {
    behavior: "deny",
    message: decision.message,
    interrupt: decision.interrupt,
    toolUseID,
  };
}

/** Project one cumulative SDK result without inventing or double-counting counters. */
export function mergeClaudeProviderSessionUsage(
  prior: ProviderSessionUsage,
  rawResult: Record<string, unknown>,
  observedAt = new Date().toISOString(),
): { sample: ProviderSessionUsage; inputTokens?: number; outputTokens?: number } {
  const rawUsage = rawResult.usage && typeof rawResult.usage === "object" ? rawResult.usage as Record<string, unknown> : {};
  const directInputTokens = finiteNumber(rawUsage.input_tokens);
  const cacheCreationInputTokens = finiteNumber(rawUsage.cache_creation_input_tokens);
  const cacheReadInputTokens = finiteNumber(rawUsage.cache_read_input_tokens);
  const inputTokens = [directInputTokens, cacheCreationInputTokens, cacheReadInputTokens].some((value) => value !== undefined)
    ? (directInputTokens ?? 0) + (cacheCreationInputTokens ?? 0) + (cacheReadInputTokens ?? 0)
    : undefined;
  const outputTokens = finiteNumber(rawUsage.output_tokens);
  const authoritativeCostUsd = finiteNumber(rawResult.total_cost_usd);
  // SDK result usage and total_cost_usd are cumulative for this query
  // conversation. Preserve the latest authoritative absolute counters;
  // summing successive result messages would double-count prior turns.
  const cumulativeInput = inputTokens ?? prior.inputTokens;
  const cumulativeOutput = outputTokens ?? prior.outputTokens;
  const cumulativeTotal = inputTokens === undefined && outputTokens === undefined
    ? prior.totalTokens
    : (inputTokens ?? 0) + (outputTokens ?? 0);
  const cumulativeCost = authoritativeCostUsd ?? prior.authoritativeCostUsd;
  return {
    sample: {
      ...(cumulativeInput !== undefined ? { inputTokens: cumulativeInput } : {}),
      ...(cumulativeOutput !== undefined ? { outputTokens: cumulativeOutput } : {}),
      ...(cumulativeTotal !== undefined ? { totalTokens: cumulativeTotal } : {}),
      ...(cumulativeCost !== undefined ? { authoritativeCostUsd: cumulativeCost } : {}),
      observedAt,
      source: "provider",
    },
    inputTokens,
    outputTokens,
  };
}

export function claudeApiRetryEvent(message: {
  error: string;
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
}): BuilderEvent {
  return {
    kind: "retry",
    provider: "claude",
    reason: message.error,
    attempt: message.attempt,
    maximum: message.max_retries,
    delayMs: message.retry_delay_ms,
    managedBy: "provider",
  };
}

/**
 * Drives Claude Code through the Claude Agent SDK in streaming-input mode:
 * one persistent session, follow-up turns pushed as user messages, permission
 * requests routed to the foreman's handler via `canUseTool`.
 */
export class ClaudeAdapter implements BuilderAdapter {
  readonly agent = "claude" as const;

  private readonly inbox = new AsyncQueue<SDKUserMessage>();
  private readonly eventQueue = new BuilderEventQueue();
  private readonly query: Query;
  private readonly abort = new AbortController();
  private readonly pumpDone: Promise<void>;
  private _sessionId?: string;
  private _sessionRef?: ProviderSessionRefV1;
  private readonly stderrChunks: string[] = [];
  private turnSignals: string[] = [];
  private structuredError?: string;
  private apiErrorStatus?: number | null;
  private compactResult?: CompactResult;
  private autoCompactionPrepared = false;
  private cumulativeUsage: ProviderSessionUsage = { observedAt: new Date(0).toISOString(), source: "provider" };
  private pending?: {
    resolve: (r: TurnResult) => void;
    reject: (e: Error) => void;
  };
  private terminalResult?: TurnResult;
  private streamEnded = false;
  private closed = false;

  static async create(opts: BuilderAdapterOptions): Promise<ClaudeAdapter> {
    try {
      const runtimeExecutable = opts.runtimeExecutable ?? resolveExecutablePath("claude");
      if (!runtimeExecutable) {
        throw new Error("Claude Code executable not found on PATH. Install your organization-approved Claude Code CLI, then retry.");
      }
      const sdk = await requireClaudeSDK();
      let validatedOpts = { ...opts, runtimeExecutable };
      if (opts.resumeSessionRef) {
        const availability = await probeClaudeSession(opts.resumeSessionRef, {
          cwd: opts.cwd,
          configRoot: opts.configRoot,
          workspaceIdentity: opts.workspaceIdentity,
          role: opts.sessionRole,
          stream: opts.sessionStream,
          ticketId: opts.ticketId,
          deliveryUnitId: opts.deliveryUnitId,
          getSessionInfo: sdk.getSessionInfo,
        });
        if (availability.status !== "available" || !availability.sessionRef) {
          throw new SessionUnavailableError({
            runtime: "claude", phase: "preflight", dispatchState: "not-sent", executable: runtimeExecutable,
            cwd: opts.cwd, diagnostics: availability.detail ?? `Claude session ${opts.resumeSessionRef.sessionId} is ${availability.status}`,
            availability,
          });
        }
        validatedOpts = { ...validatedOpts, resumeSessionId: availability.sessionRef.sessionId, resumeSessionRef: availability.sessionRef };
      }
      return new ClaudeAdapter(validatedOpts, sdk.query);
    } catch (err) {
      if (err instanceof SessionUnavailableError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(normalizeRuntimeErrorText("claude", message, null, "adapter startup"), { cause: err });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(private readonly opts: BuilderAdapterOptions, query: (o: any) => Query) {
    this._sessionId = opts.resumeSessionRef?.sessionId ?? opts.resumeSessionId;
    this._sessionRef = opts.resumeSessionRef;
    this.query = query({
      prompt: this.inbox,
      options: {
        ...buildClaudeQueryOptions(opts),
        abortController: this.abort,
        stderr: (data: string) => this.captureStderr(data),
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
          requestOptions: {
            signal?: AbortSignal;
            title?: string;
            displayName?: string;
            description?: string;
            decisionReason?: string;
            blockedPath?: string;
            toolUseID?: string;
          } = {},
        ): Promise<PermissionResult> => {
          const decision = await opts.permission({
            toolName,
            input,
            signal: requestOptions.signal,
            title: requestOptions.title,
            displayName: requestOptions.displayName,
            description: requestOptions.description,
            decisionReason: requestOptions.decisionReason,
            blockedPath: requestOptions.blockedPath,
            toolUseID: requestOptions.toolUseID,
          });
          return permissionDecisionToClaudeResult(decision, requestOptions.toolUseID);
        },
      },
    });
    this.pumpDone = this.pump();
  }

  /** Background loop: consume the SDK message stream until it ends. */
  private async pump(): Promise<void> {
    try {
      for await (const msg of this.query) {
        this.handle(msg);
      }
    } catch (err) {
      // Suppress the AbortError that fires when close() aborts the stream.
      const isShutdownAbort =
        this.closed &&
        (err instanceof Error &&
          (err.name === "AbortError" || err.message.includes("aborted")));
      if (!isShutdownAbort) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const message = normalizeRuntimeErrorText("claude", rawMessage, null, "builder stream");
        this.eventQueue.push({ kind: "error", message });
        const result = this.streamFailureResult(message, isMissingClaudeSession(rawMessage));
        this.terminalResult = result;
        this.settlePending(result);
      }
    } finally {
      this.streamEnded = true;
      if (!this.closed && this.pending) {
        const result = this.streamFailureResult("Claude stream ended without a result", Boolean(this.opts.resumeSessionRef ?? this.opts.resumeSessionId));
        this.terminalResult = result;
        this.eventQueue.push({ kind: "error", message: result.text });
        this.settlePending(result);
      }
      if (!this.closed && !this.terminalResult) this.terminalResult = this.streamFailureResult("Claude stream ended without a result", Boolean(this.opts.resumeSessionRef ?? this.opts.resumeSessionId));
      this.eventQueue.close();
    }
  }

  private handle(msg: SDKMessage): void {
    if ("session_id" in msg && typeof msg.session_id === "string") {
      this._sessionId = msg.session_id;
      this.observeSession(msg.session_id);
    }
    if (msg.type === "assistant") {
      if (msg.error) {
        this.structuredError = msg.error;
        this.turnSignals.push(`assistant error: ${msg.error}`);
      }
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          this.eventQueue.push({ kind: "text", text: block.text });
        } else if (block.type === "tool_use") {
          this.eventQueue.push({
            kind: "tool",
            name: block.name,
            input: block.input,
          });
        }
      }
    } else if (msg.type === "auth_status") {
      if (msg.error) this.turnSignals.push(`auth status: ${msg.error}`);
      if (msg.output.length > 0) this.turnSignals.push(...msg.output.map((line) => `auth: ${line}`));
    } else if (msg.type === "system" && msg.subtype === "status") {
      if (msg.status === "compacting") this.eventQueue.push({ kind: "session-transition", transition: "compacting" });
      if (msg.compact_result === "success") {
        this.compactResult = { ok: true };
        this.eventQueue.push({ kind: "session-transition", transition: "compacted" });
      } else if (msg.compact_result === "failed") {
        this.compactResult = { ok: false, error: sanitizeDiagnostics(msg.compact_error ?? "Claude native compaction failed") };
      }
    } else if (msg.type === "system" && msg.subtype === "api_retry") {
      this.structuredError = msg.error;
      this.apiErrorStatus = msg.error_status;
      this.turnSignals.push(`API retry ${msg.attempt}/${msg.max_retries}: ${msg.error}${msg.error_status === null ? "" : ` (HTTP ${msg.error_status})`}`);
      this.eventQueue.push(claudeApiRetryEvent(msg));
    } else if (msg.type === "tool_progress") {
      this.eventQueue.push({ kind: "activity", provider: "claude", state: "running tool", detail: `${msg.tool_name} (${Math.floor(msg.elapsed_time_seconds)}s)`, transient: true });
    } else if (msg.type === "system") {
      const system = msg as unknown as Record<string, unknown>;
      if (system.subtype === "task_started" || system.subtype === "task_progress" || system.subtype === "task_updated") {
        this.eventQueue.push({ kind: "activity", provider: "claude", state: "working on task", detail: typeof system.summary === "string" ? system.summary : undefined, transient: system.subtype === "task_progress" });
      } else if (system.subtype === "session_state_changed") {
        this.eventQueue.push({ kind: "activity", provider: "claude", state: "provider working", detail: typeof system.state === "string" ? system.state : undefined });
      }
    } else if (msg.type === "result") {
      if ("api_error_status" in msg) this.apiErrorStatus = msg.api_error_status;
      const text =
        "result" in msg && typeof msg.result === "string"
          ? msg.result
          : "errors" in msg
            ? msg.errors.join("; ")
            : "";
      const rawDiagnostics = sanitizeDiagnostics([
        text,
        ...this.turnSignals,
        ...this.stderrChunks,
      ].filter(Boolean).join("\n"));
      const missingResumedSession = msg.is_error
        && Boolean(this.opts.resumeSessionRef ?? this.opts.resumeSessionId)
        && isMissingClaudeSession(rawDiagnostics);
      const failure = msg.is_error ? missingResumedSession
        ? new SessionUnavailableError({
          runtime: "claude", phase: "turn", dispatchState: "unknown",
          executable: this.opts.runtimeExecutable ?? "claude", cwd: this.opts.cwd,
          diagnostics: rawDiagnostics,
          availability: {
            version: 1, status: "unavailable", checkedAt: new Date().toISOString(), reason: "not-found",
            detail: rawDiagnostics, ...(this._sessionRef ? { sessionRef: this._sessionRef } : {}),
          },
        }).failure
        : {
          runtime: "claude" as const,
          phase: this.opts.runtimePhase ?? "builder",
          category: classifyClaudeSdkFailure(this.structuredError, this.apiErrorStatus, rawDiagnostics),
          executable: this.opts.runtimeExecutable ?? "claude",
          cwd: this.opts.cwd,
          diagnostics: rawDiagnostics,
        } : undefined;
      const result: TurnResult = {
        text: failure ? formatClaudeFailure(failure) : text,
        isError: msg.is_error,
        numTurns: msg.num_turns,
        costUsd: msg.total_cost_usd,
        costAuthoritative: Number.isFinite(msg.total_cost_usd),
        failure,
      };
      const rawResult = msg as unknown as Record<string, unknown>;
      const mergedUsage = mergeClaudeProviderSessionUsage(this.cumulativeUsage, rawResult);
      result.inputTokens = mergedUsage.inputTokens;
      result.outputTokens = mergedUsage.outputTokens;
      this.cumulativeUsage = mergedUsage.sample;
      this.eventQueue.push({ kind: "turn-complete", result });
      this.settlePending(result, false);
      this.turnSignals = [];
      this.structuredError = undefined;
      this.apiErrorStatus = undefined;
      this.stderrChunks.length = 0;
    }
  }

  sendTurn(text: string): Promise<TurnResult> {
    return withActivityPhase(`Claude ${activityPhase(this.opts.runtimePhase)}`, () => this.sendTurnInternal(text));
  }

  private sendTurnInternal(text: string): Promise<TurnResult> {
    if (this.closed) return Promise.reject(new Error("builder is closed"));
    if (this.terminalResult || this.streamEnded) return Promise.resolve(this.terminalResult ?? this.streamFailureResult("Claude stream is no longer available", Boolean(this.opts.resumeSessionRef ?? this.opts.resumeSessionId)));
    if (this.pending) {
      return Promise.reject(new Error("a turn is already in progress"));
    }
    return new Promise<TurnResult>((resolve, reject) => {
      this.eventQueue.push({ kind: "activity", state: "starting Claude turn", provider: "claude", model: this.opts.model });
      this.turnSignals = [];
      this.structuredError = undefined;
      this.apiErrorStatus = undefined;
      this.pending = { resolve, reject };
      this.inbox.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
    });
  }

  private captureStderr(data: string): void {
    this.stderrChunks.push(data);
    while (this.stderrChunks.join("").length > 8 * 1024) this.stderrChunks.shift();
  }

  sessionId(): string | undefined {
    return this._sessionId;
  }

  sessionRef(): ProviderSessionRefV1 | undefined { return this._sessionRef; }
  adoptSessionRef(ref: ProviderSessionRefV1): void {
    if (ref.provider !== "claude" || ref.sessionId !== this._sessionId) throw new Error("cannot adopt a session reference for a different Claude conversation");
    this._sessionRef = ref;
  }

  async validateSession(): Promise<SessionAvailabilityV1> {
    if (!this._sessionRef) return { version: 1, status: "unknown", checkedAt: new Date().toISOString(), reason: "legacy-unscoped", detail: "Claude adapter was constructed from an unscoped raw session ID" };
    return probeClaudeSession(this._sessionRef, {
      cwd: this.opts.cwd,
      configRoot: this.opts.configRoot,
      workspaceIdentity: this.opts.workspaceIdentity,
      role: this.opts.sessionRole,
      stream: this.opts.sessionStream,
      ticketId: this.opts.ticketId,
      deliveryUnitId: this.opts.deliveryUnitId,
    });
  }

  async compact(): Promise<CompactResult> {
    this.compactResult = undefined;
    const result = await this.sendTurn("/compact");
    if (result.failure?.category === "session-unavailable") {
      return { ok: false, error: result.text || result.failure.diagnostics, failure: result.failure };
    }
    if (this.compactResult) return this.compactResult;
    return { ok: false, error: sanitizeDiagnostics(result.text || "Claude did not emit an explicit compact status") };
  }

  async prepareAutoCompaction(): Promise<void> {
    if (this.autoCompactionPrepared || this.opts.autoCompactThresholdPercent === undefined) return;
    const threshold = validThreshold(this.opts.autoCompactThresholdPercent);
    await this.query.initializationResult();
    await this.query.applyFlagSettings({ autoCompactEnabled: true });
    const baseline = await this.query.getContextUsage();
    if (!Number.isFinite(baseline.maxTokens) || baseline.maxTokens <= 0
      || !Number.isFinite(baseline.autoCompactThreshold) || baseline.autoCompactThreshold === undefined
      || !baseline.isAutoCompactEnabled) {
      throw new Error("Claude did not expose an enabled native automatic-compaction threshold");
    }
    // Claude's setting is the total window. Preserve the provider's own
    // response/compaction reserve, so the resulting used-token trigger is at
    // or before Rafi's configured percentage.
    const reserve = baseline.maxTokens - baseline.autoCompactThreshold;
    if (reserve < 0) throw new Error("Claude reported an invalid automatic-compaction reserve");
    const requestedWindow = tokenLimit(baseline.maxTokens, threshold) + reserve;
    await this.query.applyFlagSettings({ autoCompactEnabled: true, autoCompactWindow: requestedWindow });
    const installed = await this.query.getContextUsage();
    if (!installed.isAutoCompactEnabled || installed.autoCompactThreshold === undefined
      || installed.autoCompactThreshold > tokenLimit(baseline.maxTokens, threshold)) {
      throw new Error("Claude did not accept the requested native automatic-compaction ceiling");
    }
    this.autoCompactionPrepared = true;
  }

  async contextUsage(): Promise<ContextUsage | undefined> {
    try {
      const usage = await this.query.getContextUsage();
      const result = { used: usage.totalTokens, maximum: usage.maxTokens, percentage: usage.percentage, observedAt: new Date().toISOString(), source: "provider-query" as const };
      this.eventQueue.push({ kind: "context-usage", ...result });
      return result;
    } catch { return undefined; }
  }

  async sessionUsage(): Promise<ProviderSessionUsage | undefined> {
    return this.cumulativeUsage.observedAt === new Date(0).toISOString() ? undefined : { ...this.cumulativeUsage };
  }

  async switchSettings(settings: ProviderSettingSwitch): Promise<CompactResult> {
    if (settings.effort !== this.opts.effort || settings.fast !== this.opts.fast) return { ok: false, error: "Claude SDK cannot change reasoning/fast controls on an existing transport" };
    if (settings.model === this.opts.model) return { ok: true };
    const result = await this.sendTurn(`/model ${settings.model ?? "default"}`);
    if (result.isError) return { ok: false, error: result.text, ...(result.failure ? { failure: result.failure } : {}) };
    this.opts.model = settings.model; return { ok: true };
  }

  events(): AsyncIterable<BuilderEvent> {
    return this.eventQueue;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.inbox.close();
    try {
      await this.query.interrupt();
    } catch {
      // interrupt is best-effort — ignore if no turn is active
    }
    this.abort.abort();
    await this.pumpDone.catch(() => {});
  }

  private observeSession(sessionId: string): void {
    if (this._sessionRef?.sessionId === sessionId) return;
    this._sessionRef = createProviderSessionRef({
      provider: "claude", sessionId, cwd: this.opts.cwd, configRoot: this.opts.configRoot ?? this.opts.cwd,
      role: this.opts.sessionRole, stream: this.opts.sessionStream, generation: this.opts.sessionGeneration,
      workspaceIdentity: this.opts.workspaceIdentity, ticketId: this.opts.ticketId, deliveryUnitId: this.opts.deliveryUnitId,
      source: "observed",
    });
  }

  private settlePending(result: TurnResult, emit = true): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    if (emit) this.eventQueue.push({ kind: "turn-complete", result });
    pending.resolve(result);
  }

  private streamFailureResult(message: string, sessionUnavailable: boolean): TurnResult {
    if (sessionUnavailable) {
      const availability: SessionAvailabilityV1 = {
        version: 1, status: "unavailable", checkedAt: new Date().toISOString(), reason: "not-found",
        detail: message, ...(this._sessionRef ? { sessionRef: this._sessionRef } : {}),
      };
      return sessionUnavailableResult(new SessionUnavailableError({
        runtime: "claude", phase: "turn", dispatchState: "unknown", executable: this.opts.runtimeExecutable ?? "claude",
        cwd: this.opts.cwd, diagnostics: message, availability,
      }));
    }
    return {
      text: message, isError: true, numTurns: 0, costUsd: 0, costAuthoritative: false,
      failure: { runtime: "claude", phase: this.opts.runtimePhase ?? "builder", category: "agent-stream", executable: this.opts.runtimeExecutable ?? "claude", cwd: this.opts.cwd, diagnostics: message, dispatchState: "unknown" },
    };
  }
}

function finiteNumber(value: unknown): number | undefined { const parsed = Number(value); return value !== null && value !== undefined && value !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined; }

function validThreshold(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 99) throw new Error("automatic compaction threshold must be an integer from 1 to 99");
  return value;
}

function tokenLimit(maximum: number, percentage: number): number {
  return Math.max(1, Math.floor(maximum * percentage / 100));
}

function isMissingClaudeSession(message: string): boolean {
  return /no conversation found with session id|session .* not found|conversation .* not found/i.test(message);
}

function activityPhase(phase: BuilderAdapterOptions["runtimePhase"]): string {
  if (phase === "planning") return "planning";
  if (phase === "ticket-population") return "populating tickets";
  if (phase === "qa") return "reviewing with QA";
  if (phase === "uninstaller") return "planning uninstall";
  return "building";
}

function formatClaudeFailure(failure: NonNullable<TurnResult["failure"]>): string {
  const environmentNames = Object.keys(process.env)
    .filter((name) => /^(ANTHROPIC|CLAUDE|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)(_|$)/i.test(name))
    .sort();
  const lines = [
    `Claude failed during ${failure.phase} (${failure.category}).`,
    `Executable: ${failure.executable}`,
    `Working directory: ${failure.cwd}`,
    "Settings: user, project, local, and managed policy",
    `Relevant environment variables set: ${environmentNames.length > 0 ? environmentNames.join(", ") : "none"}`,
  ];
  if (failure.category === "authentication") {
    lines.push("Authenticate using the Claude Code login method approved by your organization, then verify the exact executable with `claude -p \"Return exactly OK\"`.");
  } else if (failure.category === "network") {
    lines.push("Check the organization proxy/CA configuration, including HTTPS_PROXY, NODE_EXTRA_CA_CERTS, and CLAUDE_CODE_CERT_STORE where applicable.");
  }
  if (failure.diagnostics) lines.push("", "Runtime diagnostics:", failure.diagnostics);
  return lines.join("\n");
}
