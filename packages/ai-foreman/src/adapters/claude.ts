import { inheritedStructuredLiveBudget } from "../structuredLiveBudget.js";
import { ProviderPhaseBarrier, type ProviderTurnPurpose } from "../providerPhase.js";
import { OperationDeadline } from "../util/deadline.js";
import { assertActiveProviderDispatch } from "../structuredDispatchAuthority.js";
import type {
  Query,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  PermissionResult,
  HookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, isAbsolute } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

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
import { QuestionRoundTripTrace } from "../questionTrace.js";
import { AsyncQueue } from "../util/asyncQueue.js";
import { BuilderEventQueue, currentActivity, withActivityPhase } from "../activity.js";
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
  NativeCompaction,
  NativeAutoCompactionPolicy,
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
import { isFastModeUnavailable, reportFastModeUnavailable } from "./fastMode.js";
import { handoffSystemInstructions } from "../handoffProtocol.js";
import { providerControlOperationV2, providerWireContract, renderProviderWireInstruction, validateProviderWireValue, type OutputContract, type ProviderWireContract } from "rafi-spec";
import { structuredReceipt } from "./structured.js";
import type { TurnRequest } from "./types.js";

const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * Pure function: build the `options` object passed to `query()`.
 * Extracted so tests can assert on the shape without making a live SDK call.
 * `canUseTool` is omitted here — it's a closure that the constructor adds.
 */
export function buildClaudeQueryOptions(
  opts: Omit<BuilderAdapterOptions, "permission">,
  scratchDirectory = join(dirname(opts.cwd), "scratch"),
): Record<string, unknown> {
  const qaReadOnly = opts.sessionRole === "qa" || opts.sandboxMode === "read-only";
  const confinedBuilder = opts.sessionRole === "builder";
  const base: Record<string, unknown> = {
    cwd: opts.cwd,
    pathToClaudeCodeExecutable: opts.runtimeExecutable,
    env: qaReadOnly ? qaEnvironment(process.env, scratchDirectory) : { ...process.env },
    model: opts.model,
    resume: opts.resumeSessionRef?.sessionId ?? opts.resumeSessionId,
    permissionMode: qaReadOnly ? "default" : "acceptEdits",
    effort: opts.effort,
    // Start at standard speed even when user/project settings enable fast mode.
    // Enabling it before checking capabilities can silently switch the model.
    settings: { fastMode: false },
    // Read-only roles still need the user's Claude authentication settings (for
    // example, an enterprise apiKeyHelper). Do not load repository-controlled
    // settings in those roles.
    settingSources: qaReadOnly ? ["user"] : ["user", "project", "local"],
    ...(qaReadOnly ? { disallowedTools: ["Write", "Edit", "NotebookEdit"] } : {}),
    ...(confinedBuilder && !qaReadOnly ? { sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
      network: opts.networkAccess === true ? { allowedDomains: ["*"] } : { allowedDomains: [], deniedDomains: ["*"] },
      filesystem: { allowWrite: [opts.cwd] },
    } } : {}),
    ...(qaReadOnly ? { sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      // QA stays offline unless the operator granted --qa-network for this build.
      network: opts.networkAccess === true ? { allowedDomains: ["*"] } : { allowedDomains: [], deniedDomains: ["*"] },
      filesystem: { allowWrite: [scratchDirectory], denyWrite: [opts.cwd, ...(opts.configRoot ? [opts.configRoot] : [])] },
    } } : {}),
  };
  const exactSkills = opts.preloadedSkillContent?.length
    ? ["# Preloaded Skills", "Use the following skills for this run.", ...opts.preloadedSkillContent.map((skill) => skill.content)].join("\n\n")
    : undefined;
  const systemAppend = [handoffSystemInstructions(opts.sessionRole, opts.systemPromptAppend), opts.sessionRole === "builder" ? `Builder runtime contract: shell network ${opts.networkAccess === true ? "explicitly approved for this build" : "disabled"}; sandbox fallback disabled. If acquisition requires unavailable access, request input first or use a provenance-verified local bundle. A ticket answer does not grant runtime permissions.` : undefined, opts.sessionRole === "qa" && opts.networkAccess === true ? "QA runtime contract: shell network explicitly approved for this review (--qa-network); you may run live checks against operator-provided local or remote services. Workspace stays read-only." : undefined, exactSkills].filter((part): part is string => Boolean(part)).join("\n\n");
  if (systemAppend) {
    base.systemPrompt = { type: "preset", preset: "claude_code", append: systemAppend };
  }
  if (opts.skills !== undefined) {
    base.skills = opts.skills;
  }
  return base;
}

function qaEnvironment(source: NodeJS.ProcessEnv, scratchDirectory: string): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "NO_COLOR", "FORCE_COLOR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];
  return { ...Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]!]])), TMPDIR: scratchDirectory };
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
  graphRuntimeSettings() { return { model: this.opts.model, effort: this.opts.effort, fast: this.opts.fast, runtimeExecutable: this.opts.runtimeExecutable }; }

  private inbox = new AsyncQueue<SDKUserMessage>();
  private readonly eventQueue = new BuilderEventQueue();
  private query!: Query;
  private abort = new AbortController();
  private pumpDone!: Promise<void>;
  private rotatingQuery = false;
  private configuringTurn = false;
  private output?: OutputContract;
  private outputWireContract?: ProviderWireContract;
  private responseOnlyViolation = false;
  private _sessionId?: string;
  private _sessionRef?: ProviderSessionRefV1;
  private readonly sessionIdentityReady: Promise<ProviderSessionRefV1>;
  private resolveSessionIdentity!: (ref: ProviderSessionRefV1) => void;
  private rejectSessionIdentity!: (error: Error) => void;
  private readonly stderrChunks: string[] = [];
  private turnSignals: string[] = [];
  private structuredError?: string;
  private apiErrorStatus?: number | null;
  private compactResult?: CompactResult;
  private manualCompactionDeadline?: OperationDeadline;
  private compactionPromise?: Promise<CompactResult>;
  private autoCompactionPrepared = false;
  private preparedAutoCompactThreshold?: number;
  private preparedAutoCompactionPolicy?: NativeAutoCompactionPolicy;
  private manualCompactionInFlight = false;
  private nativeCompactions: NativeCompaction[] = [];
  private nativeCompactionSequence = 0;
  private cumulativeUsage: ProviderSessionUsage = { observedAt: new Date(0).toISOString(), source: "provider" };
  private priorTurnUsage: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {};
  private activeProviderTurnId?: string;
  private activeTurnPolicy?: TurnRequest;
  private activeProviderTurnSpanId?: string;
  private readonly toolSpans = new Map<string, string>();
  private readonly structuredSubmissionIds = new Set<string>();
  private readonly toolCalls = new Map<string, { name: string; input: unknown }>();
  private readonly completedToolCalls = new Set<string>();
  private readonly unknownToolResults = new Map<string, string>();
  private pending?: {
    resolve: (r: TurnResult) => void;
    reject: (e: Error) => void;
    instruction: string;
    turnId: string;
    submitted?: boolean;
    idleTimer?: ReturnType<typeof setTimeout>;
    hardTimer?: ReturnType<typeof setTimeout>;
    hardRemainingMs?: number;
    hardArmedAt?: number;
    /** Native questions wait on the person, not the provider. */
    providerQuestionWaits?: number;
    /** The local prompt resolved and its answer is being returned to Claude. */
    providerQuestionAnswered?: boolean;
  };
  private questionTrace?: QuestionRoundTripTrace;
  private responseOnlyTurn = false;
  readonly phaseBarrier = new ProviderPhaseBarrier();
  contractCapabilities() { return { sameSessionAcceptance: true, nativeCompactionBarrier: true }; }
  enableContractEnforcement(): void { this.phaseBarrier.enableEnforcement(); }
  contractCompactionSequence(): number { return this.phaseBarrier.compactionSequence; }
  acceptContractDelivery(sequence: number): void { this.phaseBarrier.accept(sequence); }

  private terminalResult?: TurnResult;
  private streamEnded = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly scratchDirectory?: string;
  private launchScopeObserved = false;
  private providerIdentityObserved = false;
  private toolCwd?: string;
  private readonly toolCwds = new Map<string, string>();
  private fastModePrepared?: Promise<void>;
  private fastModeEnabled = false;
  private fastModeUnavailable = false;
  private turnSawWork = false;

  private async prepareFastMode(): Promise<void> {
    if (!this.opts.fast || this.fastModeUnavailable) return;
    this.fastModePrepared ??= (async () => {
      // A missing capability is conservative: standard speed, same model.
      let models: Array<{ value: string; supportsFastMode?: boolean }>;
      try {
        const init = await new OperationDeadline("Claude model capabilities", this.opts.rpcTimeoutMs ?? 60_000).run(() => this.query.initializationResult());
        models = init.models ?? [];
      } catch (error) {
        if (!isFastModeUnavailable(String(error))) throw error;
        this.disableFastModeNotice(); return;
      }
      const model = models.find(item => item.value === (this.opts.model ?? "default"));
      if (model?.supportsFastMode !== true || typeof this.query.applyFlagSettings !== "function") { this.disableFastModeNotice(); return; }
      try {
        providerControlOperationV2("claude", "applyFlagSettings");
        await new OperationDeadline("Claude fast mode", this.opts.rpcTimeoutMs ?? 60_000).run(() => this.query.applyFlagSettings({ fastMode: true }));
        this.fastModeEnabled = true;
      } catch (error) {
        if (!isFastModeUnavailable(String(error))) throw error;
        await this.disableFastMode();
      }
    })();
    await this.fastModePrepared;
  }

  private disableFastModeNotice(): void {
    if (!this.fastModeUnavailable) reportFastModeUnavailable(this.opts.model);
    this.fastModeUnavailable = true; this.fastModeEnabled = false;
  }

  private async disableFastMode(): Promise<void> {
    providerControlOperationV2("claude", "applyFlagSettings");
    await new OperationDeadline("Claude standard speed", this.opts.rpcTimeoutMs ?? 60_000).run(() => this.query.applyFlagSettings({ fastMode: false }));
    this.disableFastModeNotice();
  }

  static async create(opts: BuilderAdapterOptions): Promise<ClaudeAdapter> {
    const inheritedBudget = inheritedStructuredLiveBudget("claude");
    opts = { ...opts, queryBudget: opts.queryBudget ?? inheritedBudget };
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
  private constructor(private readonly opts: BuilderAdapterOptions, private readonly queryFactory: (o: any) => Query) {
    this.phaseBarrier.begin("initialization");
    this._sessionId = opts.resumeSessionRef?.sessionId ?? opts.resumeSessionId;
    this._sessionRef = opts.resumeSessionRef;
    this.sessionIdentityReady = new Promise<ProviderSessionRefV1>((resolve, reject) => {
      this.resolveSessionIdentity = resolve;
      this.rejectSessionIdentity = reject;
    });
    void this.sessionIdentityReady.catch(() => {});
    this.questionTrace = new QuestionRoundTripTrace(opts.runtimePhase ?? "builder", opts.onQuestionTrace, opts.observer ? {
      start: (attemptId) => opts.observer!.store.startSpan(this.observationContext(), { kind: "provider_wait", name: "Waiting for Claude after question answer", attributes: { attemptId } }),
      finish: (spanId, outcome) => opts.observer!.store.finishSpan(spanId, { outcome }),
    } : undefined);
    // Planning and interpretation also use read-only sessions, without a QA
    // snapshot's sibling scratch directory. Own a real, private directory for
    // the complete query lifecycle, including exact-session schema rotations.
    // macOS's default TMPDIR is too long for the SDK's Unix socket paths.
    if (opts.sessionRole === "qa" || opts.sandboxMode === "read-only") this.scratchDirectory = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rf-c-"));
    try { this.startQuery(); }
    catch (error) { this.finishQueryBudget(); if (this.scratchDirectory) rmSync(this.scratchDirectory, { recursive: true, force: true }); throw error; }
  }

  private queryBudget?: ReturnType<NonNullable<BuilderAdapterOptions["queryBudget"]>["reserveQuery"]>;
  private queryBudgetAbort?: () => void;
  private finishQueryBudget(): void {
    if (this.queryBudgetAbort) this.queryBudget?.signal.removeEventListener("abort", this.queryBudgetAbort);
    this.queryBudgetAbort = undefined;
    this.queryBudget?.close(); this.queryBudget = undefined;
  }

  private startQuery(): void {
    const opts = this.opts;
    this.queryBudget = opts.queryBudget?.reserveQuery("claude");
    if (this.queryBudget) {
      const lease = this.queryBudget;
      this.queryBudgetAbort = () => { this.abort.abort(); void this.close(); };
      lease.signal.addEventListener("abort", this.queryBudgetAbort, { once: true });
      if (lease.signal.aborted) { this.finishQueryBudget(); throw new Error("Live query deadline expired before launch"); }
    }
    this.query = this.queryFactory({
      prompt: this.providerInputs(),
      options: {
        ...buildClaudeQueryOptions(opts, this.scratchDirectory),
        ...(this.queryBudget ? { maxBudgetUsd: this.queryBudget.maximumSpendUsd } : {}),
        ...(this._sessionId ? { resume: this._sessionId } : {}),
        ...(this.outputWireContract ? { outputFormat: { type: "json_schema", schema: this.outputWireContract.wireSchema } } : {}),
        abortController: this.abort,
        hooks: {
          PreToolUse: [{ hooks: [async (input: HookInput) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            if (this.isResultSubmission(input.tool_name, input.tool_input)) {
              const reason = this.resultSubmissionError(input.tool_input);
              return reason ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } } : {};
            }
            if (this.output && this.responseOnlyTurn) this.responseOnlyViolation = true;
            this.toolCwd = input.cwd;
            this.toolCwds.set(input.tool_use_id, input.cwd);
            if (this.toolCwds.size > 1000) this.toolCwds.delete(this.toolCwds.keys().next().value!);
            const reason = this.phaseBarrier.denial(input.tool_name);
            return reason ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } } : {};
          }] }],
          PreCompact: [{ hooks: [async () => { this.phaseBarrier.compact(); return {}; }] }],
          SessionStart: [{ hooks: [async (input: HookInput) => {
          if (input.hook_event_name !== "SessionStart" || input.agent_id) return {};
          try { this.observeSession(input.session_id, input.cwd); }
          catch (error) {
            this.failSessionIdentity(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
          return {};
        }] }] },
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
          if (this.isResultSubmission(toolName, input)) {
            const reason = this.resultSubmissionError(input);
            return reason ? { behavior: "deny", message: reason } : { behavior: "allow", updatedInput: input };
          }
          if (this.output && this.responseOnlyTurn) this.responseOnlyViolation = true;
          if (this.responseOnlyTurn) return { behavior: "deny", message: "QA response correction forbids all tools, including read-only tools", interrupt: true };
          const isProviderQuestion = toolName === "AskUserQuestion";
          const questionAttempt = isProviderQuestion ? this.questionTrace?.begin() : undefined;
          if (isProviderQuestion) this.beginProviderQuestionWait();
          try {
            const decision = await opts.permission({
              toolName,
              input,
              executionCwd: (requestOptions.toolUseID ? this.toolCwds.get(requestOptions.toolUseID) : undefined) ?? this.toolCwd ?? opts.cwd,
              signal: requestOptions.signal,
              title: requestOptions.title,
              displayName: requestOptions.displayName,
              description: requestOptions.description,
              decisionReason: requestOptions.decisionReason,
              blockedPath: requestOptions.blockedPath,
              toolUseID: requestOptions.toolUseID,
            });
            const result = permissionDecisionToClaudeResult(decision, requestOptions.toolUseID);
            if (questionAttempt) this.questionTrace?.returned(questionAttempt, decision.behavior === "allow" ? "allowed" : "denied");
            if (isProviderQuestion) this.endProviderQuestionWait(decision.behavior === "allow");
            return result;
          } catch (error) {
            if (questionAttempt) this.questionTrace?.returned(questionAttempt, "callback-error");
            if (isProviderQuestion) this.endProviderQuestionWait(false);
            throw error;
          }
        },
      },
    });
    this.pumpDone = this.pump();
  }

  private isResultSubmission(name: string, input: unknown): boolean {
    // Only the SDK's built-in submission in a host-configured structured query.
    // An MCP name or arbitrary tool cannot acquire this exception.
    return Boolean(this.pending && this.output && name === "StructuredOutput");
  }

  private resultSubmissionError(input: unknown): string | undefined {
    try {
      // This SDK hook sees provider wire data, not the canonical artifact.
      // Canonical validation is deliberately deferred until the selected
      // normalizer runs in structuredReceipt.
      validateProviderWireValue(this.outputWireContract!, input);
      return undefined;
    } catch (error) {
      // The SDK submission is data, including when malformed. Give its bounded
      // native retry the actual wire-contract violations, never a mutation-policy
      // diagnosis. Only a valid wire payload may invoke the SDK submission tool.
      return `Native structured result violates selected ${this.outputWireContract!.profile} wire contract for ${this.output!.operation}: ${String(error).slice(0, 2400)}. Return every required field with the declared type.`;
    }
  }

  private async configureOutput(output: OutputContract | undefined, wireContract?: ProviderWireContract): Promise<void> {
    const selected = output ? wireContract ?? providerWireContract(output, "claude", "default", { requireRegistered: true }) : undefined;
    if (selected && (selected.provider !== "claude" || selected.canonical.schemaDigest !== output!.schemaDigest)) throw new Error("Claude received a mismatched provider wire contract");
    if (output?.schemaDigest === this.output?.schemaDigest && output?.operation === this.output?.operation && selected?.descriptorDigest === this.outputWireContract?.descriptorDigest) return;
    if (this.pending || this.closed || this.streamEnded) throw new Error("Cannot change output schema on an active or unavailable Claude query");
    this.rotatingQuery = true;
    try {
      this.inbox.close();
      this.abort.abort();
      this.query.close?.();
      await new OperationDeadline("Claude schema transition", this.opts.shutdownTimeoutMs ?? 10_000).run(() => this.pumpDone);
      this.finishQueryBudget();
    } catch (error) {
      this.streamEnded = true;
      throw error;
    } finally { this.rotatingQuery = false; }
    this.inbox = new AsyncQueue<SDKUserMessage>();
    this.abort = new AbortController();
    this.output = output;
    this.outputWireContract = selected;
    this.fastModePrepared = undefined;
    this.fastModeEnabled = false;
    this.providerIdentityObserved = false;
    this.startQuery();
    if (this._sessionId) this.eventQueue.push({ kind: "session-transition", transition: "resumed", detail: "Exact session resumed for output schema change" });
  }

  /** Background loop: consume the SDK message stream until it ends. */
  private async *providerInputs(): AsyncGenerator<SDKUserMessage> {
    for await (const message of this.inbox) {
      // A closed queue can still contain buffered input. Never let the SDK
      // submit it after we recorded a proven pre-submit cancellation/failure.
      if (this.closed || this.terminalResult || this.streamEnded) return;
      if (this.pending?.instruction === message.message.content) this.pending.submitted = true;
      yield message;
    }
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.query) {
        this.handle(msg);
      }
    } catch (err) {
      if (this.rotatingQuery) return;
      this.questionTrace?.finish(this.closed ? "closed" : "stream-error");
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
        this.rejectSessionIdentity(new Error(message));
        this.terminalResult = result;
        this.settlePending(result);
      }
    } finally {
      if (this.rotatingQuery) return;
      this.questionTrace?.finish(this.closed ? "closed" : "stream-ended");
      this.streamEnded = true;
      if (!this.closed && this.pending) {
        const result = this.streamFailureResult("Claude stream ended without a result", Boolean(this.opts.resumeSessionRef ?? this.opts.resumeSessionId));
        this.terminalResult = result;
        this.eventQueue.push({ kind: "error", message: result.text });
        this.settlePending(result);
      }
      if (!this.closed && !this.terminalResult) this.terminalResult = this.streamFailureResult("Claude stream ended without a result", Boolean(this.opts.resumeSessionRef ?? this.opts.resumeSessionId));
      if (!this._sessionRef) this.rejectSessionIdentity(new Error("Claude stream ended before exposing a scoped session identity"));
      this.eventQueue.close();
    }
  }

  private handle(msg: SDKMessage): void {
    const questionStreamOutcome = msg.type === "system" && msg.subtype === "api_retry" ? "provider-retry"
      : msg.type === "auth_status" && msg.error ? "provider-auth-error"
      : msg.type === "assistant" && (msg.error === "authentication_failed" || msg.error === "oauth_org_not_allowed") ? "provider-auth-error"
      : msg.type === "assistant" && msg.error ? "provider-error" : "stream-message";
    this.questionTrace?.message(questionStreamOutcome);
    if (this.pending?.providerQuestionAnswered && !this.pending.providerQuestionWaits) {
      this.pending.providerQuestionAnswered = false;
      currentActivity()?.update("Claude stream resumed");
    }
    this.touchPendingTurn();
    if ("session_id" in msg && typeof msg.session_id === "string") {
      this.observeSession(msg.session_id, "cwd" in msg && typeof msg.cwd === "string" ? msg.cwd : undefined);
    }
    if (msg.type === "assistant") {
      if (msg.error) {
        this.structuredError = msg.error;
        this.turnSignals.push(`assistant error: ${msg.error}`);
      }
      for (const block of msg.message.content) {
        this.eventQueue.push({ kind: "provider-item", provider: "claude", lifecycle: "completed", itemType: block.type === "tool_use" && this.isResultSubmission(block.name, block.input) ? "structuredOutput" : String(block.type ?? "unknown"), payload: structuredClone(block) as unknown as Record<string, unknown>, payloadCompleteness: "complete", providerTurnId: this.activeProviderTurnId, eventId: randomUUID(), observedAt: new Date().toISOString() });
        if (block.type === "text" && block.text) {
          if (msg.error && this.fastModeEnabled && isFastModeUnavailable(block.text) && !this.turnSawWork) continue;
          this.turnSawWork = true;
          this.eventQueue.push({ kind: "text", text: block.text, byteCount: Buffer.byteLength(block.text), digest: createHash("sha256").update(block.text).digest("hex"), eventId: randomUUID(), observedAt: new Date().toISOString() });
          this.opts.observer?.signal(true);
        } else if (block.type === "tool_use") {
          // The SDK result submission is transport, not a domain tool. Retain its
          // provider-item evidence without falsely reporting an acceptance violation.
          if (this.isResultSubmission(block.name, block.input)) {
            this.structuredSubmissionIds.add(block.id);
            if (this.structuredSubmissionIds.size > 1000) this.structuredSubmissionIds.delete(this.structuredSubmissionIds.values().next().value!);
            continue;
          }
          if (this.output && this.responseOnlyTurn && !this.isResultSubmission(block.name, block.input)) this.responseOnlyViolation = true;
          this.turnSawWork = true;
          const callId = block.id;
          this.toolCalls.set(callId, { name: block.name, input: block.input });
          if (this.toolCalls.size > 1000) this.toolCalls.delete(this.toolCalls.keys().next().value!);
          this.eventQueue.push({
            kind: "tool",
            name: block.name,
            input: block.input,
            inputCompleteness: "complete",
            lifecycle: "started",
            callId,
            completionKnown: false,
            providerTurnId: this.activeProviderTurnId,
            eventId: randomUUID(),
            observedAt: new Date().toISOString(),
          });
          if (this.opts.observer) {
            const spanId = this.opts.observer.store.startSpan(this.observationContext(), { kind: "tool", name: block.name, providerTurnId: this.activeProviderTurnId, attributes: { callId, input: block.input } });
            this.toolSpans.set(callId, spanId);
            this.opts.observer.signal(true);
          }
        }
      }
    } else if (msg.type === "auth_status") {
      if (msg.error) this.turnSignals.push(`auth status: ${msg.error}`);
      if (msg.output.length > 0) this.turnSignals.push(...msg.output.map((line) => `auth: ${line}`));
    } else if (msg.type === "system" && msg.subtype === "status") {
      if (msg.status === "compacting") {
        if (this.manualCompactionInFlight && msg.session_id === this._sessionId) this.manualCompactionDeadline?.extendForCorrelatedProgress();
        this.eventQueue.push({ kind: "session-transition", transition: "compacting" });
      }
      if (msg.compact_result === "success") {
        this.compactResult = { ok: true };
        this.eventQueue.push({ kind: "session-transition", transition: "compacted" });
        if (!this.manualCompactionInFlight) this.nativeCompactions.push({ id: `claude:${this._sessionId ?? "unknown"}:${++this.nativeCompactionSequence}`, occurredAt: new Date().toISOString(), provider: "claude" });
      } else if (msg.compact_result === "failed") {
        this.compactResult = { ok: false, error: sanitizeDiagnostics(msg.compact_error ?? "Claude native compaction failed") };
      }
    } else if (msg.type === "system" && msg.subtype === "api_retry") {
      this.structuredError = msg.error;
      this.apiErrorStatus = msg.error_status;
      this.turnSignals.push(`API retry ${msg.attempt}/${msg.max_retries}: ${msg.error}${msg.error_status === null ? "" : ` (HTTP ${msg.error_status})`}`);
      const retryEvent = { ...claudeApiRetryEvent(msg), retryId: randomUUID(), providerTurnId: this.activeProviderTurnId, observedAt: new Date().toISOString() };
      this.eventQueue.push(retryEvent);
      if (this.opts.observer) {
        const attributes = { provider: "claude", attempt: msg.attempt, maximum: msg.max_retries, reportedDelayMs: msg.retry_delay_ms, reasonDigest: createHash("sha256").update(msg.error).digest("hex") };
        const retrySpanId = this.opts.observer.store.startSpan(this.observationContext(), { spanId: retryEvent.retryId, kind: "retry", name: "Claude provider retry", providerTurnId: this.activeProviderTurnId, attributes });
        this.opts.observer.store.recordEvent(this.observationContext(), "retry", { eventId: retryEvent.retryId, spanId: retrySpanId, severity: "warning", attributes });
        this.opts.observer.store.finishSpan(retrySpanId, { outcome: "reported" });
      }
    } else if (msg.type === "tool_progress") {
      this.eventQueue.push({ kind: "activity", provider: "claude", state: "running tool", detail: `${msg.tool_name} (${Math.floor(msg.elapsed_time_seconds)}s)`, transient: true });
      const progress = msg as unknown as Record<string, unknown>;
      const callId = typeof progress.tool_use_id === "string" ? progress.tool_use_id : typeof progress.toolUseID === "string" ? progress.toolUseID : undefined;
      if (callId && this.structuredSubmissionIds.has(callId)) return;
      this.eventQueue.push({ kind: "tool", name: msg.tool_name, input: {}, lifecycle: "progress", callId, durationMs: Math.max(0, msg.elapsed_time_seconds * 1000), completionKnown: false, eventId: randomUUID(), observedAt: new Date().toISOString() });
      this.opts.observer?.signal(false);
    } else if ((msg as unknown as { type?: string }).type === "user") {
      this.observeToolResults(msg as unknown as Record<string, unknown>);
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
      this.queryBudget?.record(msg.total_cost_usd);
      let result: TurnResult = {
        text: failure ? formatClaudeFailure(failure) : text,
        isError: msg.is_error,
        numTurns: msg.num_turns,
        costUsd: msg.total_cost_usd,
        costAuthoritative: Number.isFinite(msg.total_cost_usd),
        failure,
        turnId: this.pending?.turnId ?? this.activeProviderTurnId,
        hostInstruction: this.pending?.instruction,
        providerInstruction: this.pending?.instruction,
        rawResponse: text,
        cleanedResponse: failure ? formatClaudeFailure(failure) : text,
        providerMetadata: { provider: "claude", sessionId: this._sessionId, sessionRef: this._sessionRef },
        ...(this.activeTurnPolicy?.selectedDispatch ? { selectedDispatch: this.activeTurnPolicy.selectedDispatch } : {}),
      };
      const rawResult = msg as unknown as Record<string, unknown>;
      if (this.output) {
        const selectedDispatch = this.activeTurnPolicy?.selectedDispatch;
        if (!selectedDispatch || !this._sessionId) throw new Error("Structured terminal lost its sealed dispatch tuple or session");
        result = { ...result, selectedDispatch, structured: msg.subtype !== "success" || msg.is_error || this.responseOnlyViolation
          ? { state: "rejected", reason: this.responseOnlyViolation ? "tool-policy-violation" : "execution-not-completed", detail: `Claude terminal ${msg.subtype}`, dispatchId: result.turnId! }
          : !this.outputWireContract || !this.activeTurnPolicy?.selectedDispatch
            ? { state: "rejected", reason: "invalid-contract", detail: "Claude structured turn has no sealed descriptor or tuple", dispatchId: result.turnId! }
            : structuredReceipt(this.output, "claude", rawResult.structured_output, { dispatchId: result.turnId!, sessionId: this._sessionId, nativeTurnId: typeof rawResult.uuid === "string" ? rawResult.uuid : undefined }, "decoded-json", this.outputWireContract, this.activeTurnPolicy.selectedDispatch) };
        if (result.structured.state === "rejected") result.isError = true;
      }
      const mergedUsage = mergeClaudeProviderSessionUsage(this.cumulativeUsage, rawResult);
      result.inputTokens = mergedUsage.inputTokens;
      result.outputTokens = mergedUsage.outputTokens;
      result.usage = { scope: "session-cumulative", inputTokens: mergedUsage.sample.inputTokens, outputTokens: mergedUsage.sample.outputTokens, totalTokens: mergedUsage.sample.totalTokens, costUsd: mergedUsage.sample.authoritativeCostUsd };
      this.cumulativeUsage = mergedUsage.sample;
      if (!(result.isError && this.fastModeEnabled && !this.turnSawWork && isFastModeUnavailable(text))) this.eventQueue.push({ kind: "turn-complete", result, turnId: result.turnId });
      this.settlePending(result, false);
      this.turnSignals = [];
      this.structuredError = undefined;
      this.apiErrorStatus = undefined;
      this.stderrChunks.length = 0;
    }
  }

  async sendTurn(text: string, policy?: import("./types.js").ProviderTurnPolicy): Promise<TurnResult> {
    if (this.pending || this.configuringTurn) throw new Error("a turn is already in progress");
    if (policy?.output) assertActiveProviderDispatch(policy, text, "claude", this.sessionRef());
    this.configuringTurn = true;
    try {
      const selected = policy?.output ? policy.wireContract ?? providerWireContract(policy.output, "claude", "default", { requireRegistered: true }) : undefined;
      if (selected && policy?.renderedWireContractDigest && policy.renderedWireContractDigest !== selected.descriptorDigest) throw new Error("Claude received mismatched rendered wire guidance");
      if (selected) {
        text = renderProviderWireInstruction(text, selected);
        policy = { ...policy, wireContract: selected, renderedWireContractDigest: selected.descriptorDigest };
      }
      if (policy?.output?.schemaDigest !== this.output?.schemaDigest || policy?.output?.operation !== this.output?.operation || selected?.descriptorDigest !== this.outputWireContract?.descriptorDigest) await this.configureOutput(policy?.output, selected);
    }
    finally { this.configuringTurn = false; }
    this.responseOnlyViolation = false;
    this.activeTurnPolicy = policy;
    this.responseOnlyTurn = Boolean(policy?.responseOnly);
    this.phaseBarrier.begin(policy?.purpose ?? (policy?.responseOnly ? "response-repair" : "implementation"));
    const turnId = policy?.dispatchId ?? randomUUID();
    this.activeProviderTurnId = turnId;
    const observer = this.opts.observer;
    if (!observer) {
      try { return await withActivityPhase(`Claude ${activityPhase(this.opts.runtimePhase)}`, () => this.sendTurnInternal(text)); }
      finally { this.activeProviderTurnId = undefined; this.responseOnlyTurn = false; }
    }
    const context = this.observationContext();
    const spanId = observer.store.startSpan(context, { spanId: turnId, kind: "provider_turn", name: `Claude ${activityPhase(this.opts.runtimePhase)}`, providerTurnId: turnId, attributes: { provider: "claude" } });
    this.activeProviderTurnSpanId = spanId;
    observer.store.updateCurrentState({ runId: observer.runId, role: context.role ?? "host", stream: context.stream ?? "claude", executionId: observer.executionId, ticketId: context.ticketId, deliveryUnitId: context.deliveryUnitId, providerSessionId: context.providerSessionId, phase: "provider turn", activeSpanId: spanId, activeSpanKind: "provider_turn", lastSemanticProgressAt: new Date().toISOString() });
    try {
      const result = await withActivityPhase(`Claude ${activityPhase(this.opts.runtimePhase)}`, () => this.sendTurnInternal(text));
      const deltaInput = nonNegativeDelta(result.usage?.inputTokens, this.priorTurnUsage.inputTokens);
      const deltaOutput = nonNegativeDelta(result.usage?.outputTokens, this.priorTurnUsage.outputTokens);
      const deltaCost = nonNegativeDelta(result.usage?.costUsd, this.priorTurnUsage.costUsd);
      this.priorTurnUsage = { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens, costUsd: result.usage?.costUsd };
      observer.store.finishSpan(spanId, { outcome: result.isError ? "failed" : "completed", attributes: { cumulativeUsage: result.usage, turnDelta: { inputTokens: deltaInput, outputTokens: deltaOutput, costUsd: deltaCost } } });
      return result;
    } catch (error) {
      observer.store.finishSpan(spanId, { outcome: "failed", attributes: { error: String(error).slice(0, 500) } });
      throw error;
    } finally {
      for (const [callId, toolSpanId] of this.toolSpans) { observer.store.finishSpan(toolSpanId, { outcome: "unknown", completionKnown: false, attributes: { callId } }); this.toolSpans.delete(callId); }
      this.activeProviderTurnId = undefined; this.activeProviderTurnSpanId = undefined; this.responseOnlyTurn = false;
    }
  }

  private async sendTurnInternal(text: string): Promise<TurnResult> {
    if (this.opts.fast) await this.prepareFastMode();
    const result = await this.sendTurnAttempt(text);
    if (!this.output && result.isError && this.fastModeEnabled && !this.turnSawWork && isFastModeUnavailable(result.rawResponse ?? result.text) && !this.streamEnded) {
      await this.disableFastMode();
      return this.sendTurnAttempt(text);
    }
    return result;
  }

  private sendTurnAttempt(text: string): Promise<TurnResult> {
    if (this.closed) return Promise.reject(new Error("builder is closed"));
    if (this.terminalResult || this.streamEnded) return Promise.resolve(this.terminalResult ?? this.streamFailureResult("Claude stream is no longer available", Boolean(this.opts.resumeSessionRef ?? this.opts.resumeSessionId)));
    if (this.pending) {
      return Promise.reject(new Error("a turn is already in progress"));
    }
    return new Promise<TurnResult>((resolve, reject) => {
      this.eventQueue.push({ kind: "activity", state: "starting Claude turn", provider: "claude", model: this.opts.model });
      this.turnSignals = [];
      this.turnSawWork = false;
      this.structuredError = undefined;
      this.apiErrorStatus = undefined;
      const pending = this.pending = { resolve, reject, instruction: text, submitted: false, turnId: this.activeProviderTurnId ?? randomUUID() };
      this.armPendingTurn(pending);
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

  private observationContext() {
    const observer = this.opts.observer!;
    const inherited = observer.context();
    return { ...inherited, runId: observer.runId, executionId: observer.executionId, role: this.opts.sessionRole ?? inherited.role ?? "builder" as const,
      stream: this.opts.sessionStream ?? inherited.stream ?? this.opts.sessionRole ?? "builder", providerSessionId: this._sessionId,
      ticketId: this.opts.ticketId ?? inherited.ticketId, deliveryUnitId: this.opts.deliveryUnitId ?? inherited.deliveryUnitId,
      parentSpanId: this.activeProviderTurnSpanId ?? inherited.parentSpanId, providerTurnId: this.activeProviderTurnId ?? inherited.providerTurnId };
  }

  private observeToolResults(message: Record<string, unknown>): void {
    const body = message.message as { content?: unknown } | undefined;
    if (!Array.isArray(body?.content)) return;
    for (const block of body.content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result") continue;
      this.eventQueue.push({ kind: "provider-item", provider: "claude", lifecycle: "completed", itemType: typeof block.tool_use_id === "string" && this.structuredSubmissionIds.has(block.tool_use_id) ? "structuredOutput" : "tool_result", payload: structuredClone(block), payloadCompleteness: "complete", providerTurnId: this.activeProviderTurnId, eventId: randomUUID(), observedAt: new Date().toISOString() });
      const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      if (!callId || this.structuredSubmissionIds.has(callId)) continue;
      if (this.completedToolCalls.has(callId)) continue;
      const call = this.toolCalls.get(callId);
      const spanId = this.toolSpans.get(callId);
      const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      const sanitized = text.replace(/\b(token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
      const failed = block.is_error === true;
      // TIME_ELAPSED alone does not establish success or failure. Preserve it as unknown.
      const elapsedOnly = /^\s*TIME_ELAPSED\s*$/.test(text);
      // An SDK `is_error` bit without a terminal reason is not enough to call
      // the tool failed: enterprise gateways can emit provisional errors and
      // continue the same turn. Preserve that state as unknown until a
      // correlated, explicit terminal result arrives.
      const resultReason = elapsedOnly ? "elapsed_placeholder"
        : failed && /Foreman policy: this action needs human approval\b[\s\S]*\band was NOT performed\./.test(text) ? "host_policy_denied"
        : failed && /timed?\s*out|timeout/i.test(text) ? "timeout"
          : failed && /cancel(?:led|ed)/i.test(text) ? "cancelled"
            : failed && /permission denied/i.test(text) ? "permission_denied"
              : failed && /not found/i.test(text) ? "not_found"
                // Claude's Read tool explicitly reports its size guard this
                // way. It is a terminal, observed rejection, not a
                // provisional transport error that might later complete.
                : failed && /\b(?:content|file)\b[\s\S]{0,160}\bexceeds\s+(?:the\s+)?maximum\s+allowed\s+tokens\b/i.test(text) ? "output_limit"
                : failed && /\b(?:exit(?:ed)?|status)\s+[1-9]\d*\b/i.test(text) ? "nonzero_exit"
                  : failed && /\b(?:failed|error|exception)\b/i.test(text) ? "explicit_error"
                    : failed ? "unexplained_error"
                      : "completed";
      const status = resultReason === "host_policy_denied" ? "denied" : resultReason === "timeout" ? "timed_out" : resultReason === "cancelled" ? "cancelled" : ["permission_denied", "not_found", "output_limit", "nonzero_exit", "explicit_error"].includes(resultReason) ? "failed" : resultReason === "completed" ? "completed" : "unknown";
      if (status !== "unknown") {
        this.completedToolCalls.add(callId);
        if (this.completedToolCalls.size > 1000) this.completedToolCalls.delete(this.completedToolCalls.values().next().value!);
        this.toolCalls.delete(callId);
      }
      const outputDigest = createHash("sha256").update(text).digest("hex");
      // Persist only correlation metadata. The result text can contain source
      // paths, command output, or credentials and must not enter lifecycle logs.
      this.opts.onLifecycleTrace?.({ phase: "provider-tool-result", at: new Date().toISOString(), sessionId: this._sessionId, providerTurnId: this.activeProviderTurnId, toolCallId: callId, toolName: call?.name ?? "unidentified tool", classification: status, resultReason, isError: failed, outputDigest, rawOutputBytes: Buffer.byteLength(text), completionKnown: status !== "unknown" });
      if (status === "unknown") {
        if (this.unknownToolResults.get(callId) === outputDigest) continue;
        this.unknownToolResults.set(callId, outputDigest);
        if (this.unknownToolResults.size > 1000) this.unknownToolResults.delete(this.unknownToolResults.keys().next().value!);
      } else this.unknownToolResults.delete(callId);
      this.eventQueue.push({ kind: "tool", name: call?.name ?? "unidentified tool", input: call?.input ?? {}, inputCompleteness: call ? "complete" : "unavailable", lifecycle: "completed", callId, status, outputSummary: sanitized.slice(0, 1000), outputDigest, outputCompleteness: block.is_truncated === true ? "truncated" : "complete", rawOutputBytes: Buffer.byteLength(text), completionKnown: status !== "unknown", providerTurnId: this.activeProviderTurnId, eventId: randomUUID(), observedAt: new Date().toISOString() });
      if (spanId && this.opts.observer && status !== "unknown") { this.opts.observer.store.finishSpan(spanId, { outcome: status, completionKnown: true, attributes: { callId, outputSummary: sanitized.slice(0, 1000), outputDigest } }); this.toolSpans.delete(callId); }
      this.opts.observer?.signal(true);
    }
  }

  sessionId(): string | undefined {
    return this._sessionId;
  }

  sessionRef(): ProviderSessionRefV1 | undefined { return this._sessionRef; }
  async prepareSession(timeoutMs = this.opts.preparationTimeoutMs ?? 120_000): Promise<ProviderSessionRefV1> {
    if (this.closed || this.streamEnded || this.terminalResult) throw new Error(this.terminalResult?.text ?? "Claude session is closed");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Claude session initialization timeout must be positive");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new Error(this.terminalResult?.text ?? "Claude session closed during initialization"));
        this.abort.signal.addEventListener("abort", aborted, { once: true });
        if (this.abort.signal.aborted) aborted();
        timer = setTimeout(() => reject(new Error(`Claude did not expose a scoped session identity within ${timeoutMs}ms`)), timeoutMs);
      });
      const prepare = async () => {
        await this.query.initializationResult();
        await this.prepareFastMode();
        if (!this.providerIdentityObserved && typeof this.query.supportedCommands === "function") {
          const commands = await this.query.supportedCommands();
          // Some SDK/CLI pairs expose init identity only after their first input.
          // Require an advertised built-in local command; never substitute a
          // model-generated warm-up for QA's pre-dispatch identity validation.
          if (commands.some(command => command.name === "context" && "builtin" in command && command.builtin === true)) {
            providerControlOperationV2("claude", "/context");
            this.opts.onLifecycleTrace?.({ phase: "local-context-initialization-start", at: new Date().toISOString() });
            const result = await this.sendTurn("/context", { responseOnly: true });
            this.opts.onLifecycleTrace?.({ phase: "local-context-initialization-complete", at: new Date().toISOString() });
            // SDK total_cost_usd includes earlier conversation cost on resume.
            // The advertised built-in command must report zero model turns;
            // historical cumulative cost does not make this a paid warm-up.
            if (result.isError || result.failure || result.numTurns !== 0 || (result.costUsd > 0 && result.usage?.scope !== "session-cumulative")) throw new Error("Claude local context initialization did not complete without model work");
          }
        }
        return this.sessionIdentityReady;
      };
      const ready = await Promise.race([prepare(), interrupted]);
      // The identity promise resolves once. A host may later adopt a new scope
      // for the same conversation (for example a handoff generation), so the
      // prepared session is the adapter's current reference, as for Codex.
      const ref = this._sessionRef?.sessionId === ready.sessionId ? this._sessionRef : ready;
      if (!ref.validatedAt) throw new Error("Claude session identity was not provider-validated during initialization");
      return ref;
    } catch (error) {
      this.failSessionIdentity(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (aborted) this.abort.signal.removeEventListener("abort", aborted);
    }
  }
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
    if (this.compactionPromise) return this.compactionPromise;
    const operation = this.opts.observer
      ? this.opts.observer.span("compaction", "Claude context compaction", () => this.compactInternal())
      : this.compactInternal();
    this.compactionPromise = operation;
    try { return await operation; }
    finally { if (this.compactionPromise === operation) this.compactionPromise = undefined; }
  }

  private async compactInternal(): Promise<CompactResult> {
    providerControlOperationV2("claude", "/compact");
    this.compactResult = undefined;
    this.manualCompactionInFlight = true;
    const normalMs = Math.min(180_000, Math.max(1, this.opts.compactionTimeoutMs ?? 120_000));
    const deadline = new OperationDeadline("Claude compaction", normalMs, Math.min(180_000, normalMs * 1.5));
    this.manualCompactionDeadline = deadline;
    let result: TurnResult;
    try { result = await deadline.run(() => this.sendTurn("/compact"), () => this.abort.abort()); }
    catch (error) {
      const failure = new SessionUnavailableError({ runtime: "claude", phase: "turn", dispatchState: "unknown", executable: this.opts.runtimeExecutable ?? "claude", cwd: this.opts.cwd, diagnostics: String(error) });
      await this.close();
      return { ok: false, error: failure.message, failure: failure.failure };
    }
    finally { this.manualCompactionInFlight = false; this.manualCompactionDeadline = undefined; }
    if (result.failure?.category === "session-unavailable") {
      return { ok: false, error: result.text || result.failure.diagnostics, failure: result.failure };
    }
    if (this.compactResult) return this.compactResult;
    return { ok: false, error: sanitizeDiagnostics(result.text || "Claude did not emit an explicit compact status") };
  }

  async prepareAutoCompaction(thresholdPercent = this.opts.autoCompactThresholdPercent): Promise<NativeAutoCompactionPolicy | void> {
    return new OperationDeadline("Claude auto-compaction preparation", this.opts.preparationTimeoutMs ?? 120_000).run(() => this.prepareAutoCompactionInternal(thresholdPercent), () => this.abort.abort());
  }

  private async prepareAutoCompactionInternal(thresholdPercent = this.opts.autoCompactThresholdPercent): Promise<NativeAutoCompactionPolicy | void> {
    if (thresholdPercent === undefined) return;
    const threshold = validThreshold(thresholdPercent);
    if (this.autoCompactionPrepared && this.preparedAutoCompactThreshold === threshold) return this.preparedAutoCompactionPolicy;
    this.opts.autoCompactThresholdPercent = threshold;
    await new OperationDeadline("Claude initialization", this.opts.preparationTimeoutMs ?? 120_000).run(() => this.query.initializationResult());
    // The SDK can acknowledge initialization while its CLI is still waiting
    // for first input. Sending getContextUsage then deadlocks the control
    // queue, including a later local command. Establish identity first.
    if (!this.providerIdentityObserved && typeof this.query.supportedCommands === "function") await this.prepareSession();
    providerControlOperationV2("claude", "applyFlagSettings");
    await new OperationDeadline("Claude settings", this.opts.rpcTimeoutMs ?? 60_000).run(() => this.query.applyFlagSettings({ autoCompactEnabled: true }));
    providerControlOperationV2("claude", "getContextUsage");
    const baseline = await new OperationDeadline("Claude context usage", this.opts.rpcTimeoutMs ?? 60_000).run(() => this.query.getContextUsage());
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
    providerControlOperationV2("claude", "applyFlagSettings");
    await new OperationDeadline("Claude settings", this.opts.rpcTimeoutMs ?? 60_000).run(() => this.query.applyFlagSettings({ autoCompactEnabled: true, autoCompactWindow: requestedWindow }));
    providerControlOperationV2("claude", "getContextUsage");
    const installed = await new OperationDeadline("Claude context usage", this.opts.rpcTimeoutMs ?? 60_000).run(() => this.query.getContextUsage());
    if (!installed.isAutoCompactEnabled || !Number.isFinite(installed.maxTokens) || installed.maxTokens <= 0
      || !Number.isFinite(installed.autoCompactThreshold) || installed.autoCompactThreshold === undefined) {
      throw new Error("Claude did not expose an enabled native automatic-compaction threshold after configuration");
    }
    // A control acknowledgment may disagree with the SDK's subsequent report.
    // Use that reported threshold as the available lifecycle telemetry rather
    // than rejecting the build. This does not prove clamping or independently
    // verify the native trigger's actual enforcement.
    const effectiveThresholdPercent = Math.max(1, Math.min(99,
      Math.floor(installed.autoCompactThreshold / installed.maxTokens * 100)));
    this.preparedAutoCompactionPolicy = {
      requestedThresholdPercent: threshold,
      effectiveThresholdPercent,
      modelContextWindow: installed.maxTokens,
      triggerTokens: installed.autoCompactThreshold,
    };
    this.autoCompactionPrepared = true;
    this.preparedAutoCompactThreshold = threshold;
    return this.preparedAutoCompactionPolicy;
  }

  autoCompactionPolicy(): NativeAutoCompactionPolicy | undefined { return this.preparedAutoCompactionPolicy; }

  drainNativeCompactions(): NativeCompaction[] {
    const pending = this.nativeCompactions;
    this.nativeCompactions = [];
    return pending;
  }
  restoreNativeCompactions(compactions: NativeCompaction[]): void { this.nativeCompactions.unshift(...compactions); }

  async contextUsage(): Promise<ContextUsage | undefined> {
    try {
      providerControlOperationV2("claude", "getContextUsage");
      const usage = await new OperationDeadline("Claude context usage", this.opts.rpcTimeoutMs ?? 60_000).run(() => this.query.getContextUsage());
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
    providerControlOperationV2("claude", "/model");
    if (settings.model && /[\r\n]/.test(settings.model)) return { ok: false, error: "Model control requires one model identifier" };
    if (this.opts.fast) await this.prepareFastMode();
    if (this.fastModeEnabled) providerControlOperationV2("claude", "applyFlagSettings");
    if (this.fastModeEnabled) await new OperationDeadline("Claude standard speed", this.opts.rpcTimeoutMs ?? 60_000).run(() => this.query.applyFlagSettings({ fastMode: false }));
    this.fastModeEnabled = false;
    const result = await new OperationDeadline("Claude model settings", this.opts.rpcTimeoutMs ?? 60_000).run(() => this.sendTurn(`/model ${settings.model ?? "default"}`), () => this.abort.abort());
    if (result.isError) return { ok: false, error: result.text, ...(result.failure ? { failure: result.failure } : {}) };
    if (result.numTurns !== 0 || result.structured) return { ok: false, error: "Model control did not complete as a non-authoritative provider acknowledgement" };
    this.opts.model = settings.model;
    this.fastModePrepared = undefined; this.fastModeUnavailable = false;
    if (this.opts.fast) await this.prepareFastMode();
    return { ok: true };
  }

  observeEvents(listener: (event: BuilderEvent) => void): () => void { return this.eventQueue.observe(listener); }

  events(): AsyncIterable<BuilderEvent> {
    return this.eventQueue;
  }

  close(): Promise<void> { return this.closePromise ??= this.closeInternal(); }
  private async closeInternal(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) this.settlePending(this.streamFailureResult("Claude turn interrupted; submitted work requires recovery", false));
    this.questionTrace?.finish("closed");
    this.rejectSessionIdentity(new Error("Claude session closed during initialization"));
    this.abort.abort();
    this.inbox.close();
    try {
      await new OperationDeadline("Claude interrupt", this.opts.shutdownTimeoutMs ?? 10_000).run(() => this.query.interrupt());
    } catch {
      // interrupt is best-effort — ignore if no turn is active
    }
    try {
      this.query.close?.();
      await new OperationDeadline("Claude shutdown", this.opts.shutdownTimeoutMs ?? 10_000).run(() => this.pumpDone).catch(() => {});
    } finally {
      this.finishQueryBudget();
      if (this.scratchDirectory) rmSync(this.scratchDirectory, { recursive: true, force: true });
    }
  }

  private failSessionIdentity(error: Error): void {
    this.rejectSessionIdentity(error);
    const result = sessionUnavailableResult(new SessionUnavailableError({
      runtime: "claude", phase: this.pending ? "turn" : "preflight", dispatchState: this.pending?.submitted ? "unknown" : "not-sent",
      executable: this.opts.runtimeExecutable ?? "claude", cwd: this.opts.cwd, diagnostics: error.message,
      availability: { version: 1, status: "unavailable", checkedAt: new Date().toISOString(), reason: "attach-failed", detail: error.message, ...(this._sessionRef ? { sessionRef: this._sessionRef } : {}) },
    }));
    this.terminalResult = result;
    this.settlePending(result);
    this.inbox.close();
    this.abort.abort();
  }

  private observeSession(sessionId: string, observedCwd?: string): void {
    const expectedId = this._sessionRef?.sessionId ?? this._sessionId;
    if (!sessionId.trim() || (expectedId && expectedId !== sessionId)) {
      const error = new Error(`Claude initialized session ${sessionId || "without an ID"} instead of requested session ${expectedId ?? "a nonempty ID"}`);
      this.failSessionIdentity(error);
      throw error;
    }
    const launchCwd = canonicalSessionPath(this.opts.cwd);
    const currentCwd = observedCwd === undefined ? undefined : canonicalSessionPath(observedCwd);
    const withinLaunchScope = currentCwd === undefined ? false : (() => {
      const path = relative(launchCwd, currentCwd);
      return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
    })();
    // Establish the launch scope before trusting mutable Bash cwd. Subsequent
    // messages for the same identity may report a directory inside that scope;
    // they must not replace the immutable cwd in the durable session reference.
    const trustedResumeScope = Boolean(this.opts.resumeSessionRef?.validatedAt && canonicalSessionPath(this.opts.resumeSessionRef.cwd) === launchCwd);
    if (currentCwd !== undefined && (this.launchScopeObserved || trustedResumeScope ? !withinLaunchScope : currentCwd !== launchCwd)) {
      const error = new Error(`Claude session cwd ${observedCwd} does not match ${this.opts.cwd}`);
      this.failSessionIdentity(error);
      throw error;
    }
    if (currentCwd === launchCwd) this.launchScopeObserved = true;
    this.providerIdentityObserved = true;
    if (currentCwd !== undefined) this.toolCwd = currentCwd;
    this._sessionId = sessionId;
    if (this._sessionRef?.validatedAt) {
      this.resolveSessionIdentity(this._sessionRef);
      return;
    }
    const now = new Date().toISOString();
    const validatedAt = observedCwd !== undefined || this.opts.sessionRole !== "qa" ? now : undefined;
    this._sessionRef = this._sessionRef
      ? { ...this._sessionRef, source: "observed", ...(validatedAt ? { validatedAt } : {}) }
      : createProviderSessionRef({
        provider: "claude", sessionId, cwd: this.opts.cwd, configRoot: this.opts.configRoot ?? this.opts.cwd,
        role: this.opts.sessionRole, stream: this.opts.sessionStream, generation: this.opts.sessionGeneration,
        workspaceIdentity: this.opts.workspaceIdentity, ticketId: this.opts.ticketId, deliveryUnitId: this.opts.deliveryUnitId,
        source: "observed", validatedAt,
      });
    if (this._sessionRef.validatedAt) this.resolveSessionIdentity(this._sessionRef);
  }

  private settlePending(result: TurnResult, emit = true): void {
    this.questionTrace?.finish(result.isError ? "result-error" : "result");
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    if (pending.hardTimer) clearTimeout(pending.hardTimer);
    if (!result.turnId) {
      result.turnId = pending.turnId; result.hostInstruction = pending.instruction; result.providerInstruction = pending.instruction;
      result.rawResponse = result.text; result.cleanedResponse = result.text;
      result.providerMetadata = { provider: "claude", sessionId: this._sessionId, sessionRef: this._sessionRef };
    }
    if (emit) this.eventQueue.push({ kind: "turn-complete", result, turnId: result.turnId });
    pending.resolve(result);
  }

  private touchPendingTurn(): void {
    if (this.pending) this.armPendingTurn(this.pending);
  }

  private beginProviderQuestionWait(): void {
    const pending = this.pending;
    if (!pending) return;
    pending.providerQuestionWaits = (pending.providerQuestionWaits ?? 0) + 1;
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    pending.idleTimer = undefined;
    if (pending.hardTimer) {
      clearTimeout(pending.hardTimer);
      pending.hardTimer = undefined;
      pending.hardRemainingMs = Math.max(0, (pending.hardRemainingMs ?? this.opts.turnDeadlineMs ?? 3_600_000) - (performance.now() - (pending.hardArmedAt ?? performance.now())));
    }
  }

  private endProviderQuestionWait(answered: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    pending.providerQuestionWaits = Math.max(0, (pending.providerQuestionWaits ?? 1) - 1);
    pending.providerQuestionAnswered ||= answered;
    if (pending.providerQuestionWaits === 0) this.armPendingTurn(pending);
  }

  private armPendingTurn(pending: NonNullable<ClaudeAdapter["pending"]>): void {
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    if ((pending.providerQuestionWaits ?? 0) > 0) return;
    if (!pending.hardTimer) {
      pending.hardRemainingMs ??= this.opts.turnDeadlineMs ?? 3_600_000;
      pending.hardArmedAt = performance.now();
      pending.hardTimer = setTimeout(() => {
        if (this.pending !== pending) return;
        this.settlePending(this.streamFailureResult("Claude active turn deadline exceeded; dispatched work requires reconciliation", false));
        void this.close();
      }, pending.hardRemainingMs);
      pending.hardTimer.unref();
    }
    const timeoutMs = this.providerIdleTimeoutMs();
    pending.idleTimer = setTimeout(() => {
      if (this.pending !== pending || this.closed) return;
      this.questionTrace?.finish("idle-timeout");
      const context = pending.providerQuestionAnswered ? " after your answer was sent; Claude has not resumed its stream yet" : "";
      const message = `Claude provider was silent for ${Math.round(timeoutMs / 60_000)} minutes${context}; the turn may have been dispatched and will not be retried automatically`;
      const result = this.streamFailureResult(message, false);
      this.eventQueue.push({ kind: "error", message });
      this.settlePending(result);
      // Do not leave a hidden stream running after the host has declared its
      // result uncertain.  close() is intentionally not awaited here.
      void this.close();
    }, timeoutMs);
    pending.idleTimer.unref();
  }

  private providerIdleTimeoutMs(): number {
    const configured = this.opts.providerIdleTimeoutMs;
    return Number.isFinite(configured) && configured! > 0 ? configured! : DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
  }

  private streamFailureResult(message: string, sessionUnavailable: boolean): TurnResult {
    const dispatchState = this.pending?.submitted === false ? "not-sent" : "unknown";
    if (sessionUnavailable) {
      const availability: SessionAvailabilityV1 = {
        version: 1, status: "unavailable", checkedAt: new Date().toISOString(), reason: "not-found",
        detail: message, ...(this._sessionRef ? { sessionRef: this._sessionRef } : {}),
      };
      return sessionUnavailableResult(new SessionUnavailableError({
        runtime: "claude", phase: "turn", dispatchState, executable: this.opts.runtimeExecutable ?? "claude",
        cwd: this.opts.cwd, diagnostics: message, availability,
      }));
    }
    return {
      text: message, isError: true, numTurns: 0, costUsd: 0, costAuthoritative: false,
      failure: { runtime: "claude", phase: this.opts.runtimePhase ?? "builder", category: "agent-stream", executable: this.opts.runtimeExecutable ?? "claude", cwd: this.opts.cwd, diagnostics: message, dispatchState },
    };
  }
}

function finiteNumber(value: unknown): number | undefined { const parsed = Number(value); return value !== null && value !== undefined && value !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined; }

function nonNegativeDelta(current: number | undefined, prior: number | undefined): number | undefined {
  if (current === undefined) return undefined;
  return prior === undefined ? current : Math.max(0, current - prior);
}

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
  if (phase === "manager") return "analyzing diagnostics";
  if (phase === "discovery") return "discovering project context";
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
