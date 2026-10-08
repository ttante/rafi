/**
 * Agent-agnostic interface over a coding agent ("builder").
 */
import type {
  ConfigurableAgentRole,
  ProviderSessionRefV1,
  RuntimeProbeCategory,
  RuntimeProbePhase,
  SessionAvailabilityV1,
} from "rafi-spec";
import type { RunObserver } from "../observability.js";

/** A permission request surfaced by a builder before it runs a tool. */
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  /** Human-readable prompt from the agent, when available. */
  title?: string;
  /** Signaled if the provider-side operation should be aborted. */
  signal?: AbortSignal;
  /** Provider-native identifier for this specific tool call, when available. */
  toolUseID?: string;
  /** Short provider-rendered name for the requested action, when available. */
  displayName?: string;
  /** Provider-rendered detail for the requested action, when available. */
  description?: string;
  /** Provider explanation for why permission was requested, when available. */
  decisionReason?: string;
  /** Provider path that triggered the permission request, when available. */
  blockedPath?: string;
}

/** The foreman's verdict on a permission request. */
export type PermissionDecision =
  | {
      behavior: "allow";
      /** Provider-native tool input to continue with after host interaction. */
      updatedInput?: Record<string, unknown>;
      /** Provider-native permission updates to apply after approval. */
      updatedPermissions?: Array<Record<string, unknown>>;
    }
  | { behavior: "deny"; message: string; interrupt?: boolean };

/** Decides each permission request. Supplied by the foreman, called by the adapter. */
export type PermissionHandler = (
  req: PermissionRequest,
) => Promise<PermissionDecision>;

/** Result of a single completed turn. */
export type SessionFailurePhase = "preflight" | "attach" | "turn";
export type TurnDispatchState = "not-sent" | "unknown";

export interface RuntimeFailure {
  runtime: "claude" | "codex";
  phase: RuntimeProbePhase | SessionFailurePhase;
  category: RuntimeProbeCategory;
  executable: string;
  cwd: string;
  diagnostics: string;
  dispatchState?: TurnDispatchState;
  availability?: SessionAvailabilityV1;
}

export interface TurnResult {
  /** Final assistant message text — where the STEP_STATUS marker lives. */
  text: string;
  isError: boolean;
  numTurns: number;
  costUsd: number;
  /** True only when the provider supplied this value; never inferred by Rafi. */
  costAuthoritative?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** Explicit counter semantics. Compatibility counters above must not be summed without this scope. */
  usage?: {
    scope: "turn-delta" | "session-cumulative";
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  failure?: RuntimeFailure;
  /** Stable host/provider correlation ID for this turn. */
  turnId?: string;
  /** Deferred handback continuity validation; no hidden provider repair. */
  continuityErrors?: string[];
  /** Exact instruction requested by the immediate host caller. */
  hostInstruction?: string;
  /** Exact instruction dispatched to the provider after all wrappers. */
  providerInstruction?: string;
  /** Exact provider response before continuity or contract cleanup. */
  rawResponse?: string;
  /** Effective response consumed by the host contract parser. */
  cleanedResponse?: string;
  providerMetadata?: {
    provider: "claude" | "codex";
    sessionId?: string;
    sessionRef?: ProviderSessionRefV1;
  };
}

/** Observability events emitted while a builder works. */
export type BuilderEvent =
  (
  | { kind: "text"; text: string; byteCount?: number; digest?: string }
  | { kind: "tool"; name: string; input: unknown; inputCompleteness?: "complete" | "truncated" | "unavailable"; lifecycle?: "started" | "progress" | "completed"; callId?: string; status?: string; durationMs?: number; exitCode?: number; outputSummary?: string; outputDigest?: string; outputCompleteness?: "complete" | "truncated" | "unavailable"; rawOutputBytes?: number; completionKnown?: boolean; providerTurnId?: string }
  | { kind: "provider-item"; provider: "claude" | "codex"; lifecycle: "started" | "completed"; itemType: string; payload: Record<string, unknown>; payloadCompleteness: "complete"; providerTurnId?: string }
  | { kind: "activity"; state: string; detail?: string; provider?: "claude" | "codex"; model?: string; transient?: boolean }
  | { kind: "retry"; provider: "claude" | "codex"; reason: string; attempt?: number; maximum?: number; delayMs?: number; managedBy: "provider" | "rafi"; retryId?: string; providerTurnId?: string }
  | { kind: "turn-complete"; result: TurnResult; turnId?: string }
  | { kind: "session-transition"; transition: "started" | "resumed" | "compacting" | "compacted" | "fresh-fallback"; detail?: string }
  | { kind: "context-usage"; used: number; maximum?: number; percentage?: number; observedAt?: string; source?: "provider-event" | "provider-query" | "post-compact" }
  | { kind: "error"; message: string }) & { eventId?: string; observedAt?: string };

export interface ContextUsage {
  used: number;
  maximum?: number;
  percentage?: number;
  observedAt?: string;
  source?: "provider-event" | "provider-query" | "post-compact";
}

/**
 * The provider-native automatic-compaction policy that was actually installed.
 * Providers may clamp a requested ceiling to a model- or runtime-specific
 * minimum, so lifecycle enforcement must consume the effective value.
 */
export interface NativeAutoCompactionPolicy {
  requestedThresholdPercent: number;
  effectiveThresholdPercent: number;
  modelContextWindow?: number;
  triggerTokens?: number;
}

export interface ProviderSessionUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  authoritativeCostUsd?: number;
  observedAt: string;
  source: "provider" | "turn-aggregate";
}

export interface CompactResult {
  ok: boolean;
  error?: string;
  /** Preserve exact-session loss so lifecycle policy never treats it as an ordinary retryable compaction failure. */
  failure?: RuntimeFailure;
}

/** A provider-confirmed compaction that happened without Rafi issuing /compact. */
export interface NativeCompaction {
  /** Stable for the lifetime of an adapter; used for durable idempotency. */
  id: string;
  occurredAt: string;
  provider: "claude" | "codex";
  /** Adapter-local usage generation captured with the provider confirmation. */
  usageRevision?: number;
}

export interface ProviderSettingSwitch { model?: string; effort?: EffortLevel; fast?: boolean }

export type EffortLevel = "low" | "medium" | "high" | "xhigh";

export interface BuilderAdapterOptions {
  /** Working directory the builder operates in. */
  cwd: string;
  /** Absolute runtime executable path verified by the readiness probe. */
  runtimeExecutable?: string;
  /** User-facing execution phase for diagnostics. */
  runtimePhase?: RuntimeProbePhase;
  /** Permission decision callback. */
  permission: PermissionHandler;
  /** Resume a prior session instead of starting fresh. */
  /** @deprecated Foreman-controlled recovery must use resumeSessionRef. */
  resumeSessionId?: string;
  /** Location-scoped provider conversation to validate before exact resume. */
  resumeSessionRef?: ProviderSessionRefV1;
  /** Canonical Rafi configuration/recovery root. Defaults to cwd for compatibility callers. */
  configRoot?: string;
  /** Metadata used when the provider first reveals a fresh session identity. */
  sessionRole?: ConfigurableAgentRole;
  sessionStream?: string;
  sessionGeneration?: number;
  workspaceIdentity?: string;
  ticketId?: string;
  deliveryUnitId?: string;
  /** Override the model; omit for the agent's default. */
  model?: string;
  /** Reasoning effort level. Claude also accepts "max"; Codex supports up to "xhigh". */
  effort?: EffortLevel;
  /** Fast mode: lower latency at the cost of some quality. */
  fast?: boolean;
  /** Codex sandbox mode. Defaults to workspace-write for implementation runs. */
  sandboxMode?: "workspace-write" | "read-only";
  /** Role system text to append to the harness system prompt (from .rafi/compiled or library). */
  systemPromptAppend?: string;
  /** Skill names to preload for this session (Claude: lazy-loaded; Codex: flattened). */
  skills?: string[];
  /** Exact host-frozen skill text injected into the provider instruction. */
  preloadedSkillContent?: Array<{ name: string; content: string }>;
  /** Provider-native context ceiling, as a percentage of that provider's model window. */
  autoCompactThresholdPercent?: number;
  /** QA forbids an unjournaled model turn merely to discover the context window. */
  allowAutoCompactionSetupTurn?: boolean;
  /** Raw-adapter observability; wrapper adapters must not persist re-emitted events. */
  observer?: RunObserver;
  /** Redacted AskUserQuestion diagnostics, independent of build observability. */
  onQuestionTrace?: import("../questionTrace.js").QuestionTraceSink;
  /**
   * Maximum time a dispatched provider turn may remain completely silent.
   * This is an idle timeout, not a total turn limit: every provider message
   * resets it.  A timeout is intentionally terminal and has unknown dispatch
   * state, so callers must never replay the instruction automatically.
   */
  providerIdleTimeoutMs?: number;
  compactionTimeoutMs?: number;
  preparationTimeoutMs?: number;
  rpcTimeoutMs?: number;
  turnDeadlineMs?: number;
  shutdownTimeoutMs?: number;
  /** Metadata-only lifecycle trace; no prompts, responses, credentials, or tool inputs. */
  onLifecycleTrace?: (event: { phase: string; at: string; elapsedMs?: number; sessionId?: string; method?: string; timeoutMs?: number }) => void;
}

export interface BuilderAdapter {
  readonly agent: "claude" | "codex";

  /** Send one instruction; resolves when that turn completes. */
  sendTurn(text: string, policy?: { handback?: boolean; responseOnly?: boolean; logicalActionId?: string }): Promise<TurnResult>;
  /** Synchronous observation through the event owner. Terminal precedes sendTurn resolution. */
  observeEvents?(listener: (event: BuilderEvent) => void): () => void;
  /** Commit a deferred handback checkpoint only after the host validates the turn. */
  acceptHandbackTurn?(turn: TurnResult): void;

  /** Current session id, once known — used for resume. */
  sessionId(): string | undefined;

  /** Current location-scoped session reference, once known. */
  sessionRef?(): ProviderSessionRefV1 | undefined;

  /**
   * Establish and observe the exact provider session without dispatching a
   * role/work turn. Durable QA calls this before binding its first turn.
   */
  prepareSession?(): Promise<ProviderSessionRefV1>;

  /** Host-only metadata promotion after a validated handoff is accepted. */
  adoptSessionRef?(ref: ProviderSessionRefV1): void;

  /** Attach/probe a requested exact session without starting a provider turn. */
  validateSession?(): Promise<SessionAvailabilityV1>;

  /** Provider-native compaction on the exact live conversation. */
  compact?(): Promise<CompactResult>;

  /**
   * Install and verify provider-native automatic compaction before role work is
   * dispatched. This intentionally happens outside a work turn so a long,
   * tool-heavy first turn is protected too.
   */
  prepareAutoCompaction?(thresholdPercent?: number): Promise<NativeAutoCompactionPolicy | void>;
  /** True only when a provider needs one observable, tool-free turn to learn its context window. */
  requiresAutoCompactionSetupTurn?(): boolean;

  /** The last provider-native automatic-compaction policy verified on this transport. */
  autoCompactionPolicy?(): NativeAutoCompactionPolicy | undefined;

  /** Consume provider-native compactions observed since the prior drain. */
  drainNativeCompactions?(): NativeCompaction[];

  /** Return a drained batch to the adapter when durable receipt failed. */
  restoreNativeCompactions?(compactions: NativeCompaction[]): void;

  /** Return occupancy known to postdate a native-compaction event, if available. */
  contextUsageAfterNativeCompaction?(compaction: NativeCompaction): Promise<ContextUsage | undefined>;

  /** Truthful provider context occupancy, when exposed by the provider. */
  contextUsage?(): Promise<ContextUsage | undefined>;

  /** Provider/session cumulative totals; distinct from live context occupancy. */
  sessionUsage?(): Promise<ProviderSessionUsage | undefined>;

  /** Attempt a provider-supported in-conversation model/reasoning transition. */
  switchSettings?(settings: ProviderSettingSwitch): Promise<CompactResult>;

  /** Stream of observability events. Iterate to drive a live view. */
  events(): AsyncIterable<BuilderEvent>;

  /** Shut the builder down and release resources. */
  close(): Promise<void>;
}
