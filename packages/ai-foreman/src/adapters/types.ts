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
  failure?: RuntimeFailure;
}

/** Observability events emitted while a builder works. */
export type BuilderEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "activity"; state: string; detail?: string; provider?: "claude" | "codex"; model?: string; transient?: boolean }
  | { kind: "retry"; provider: "claude" | "codex"; reason: string; attempt?: number; maximum?: number; delayMs?: number; managedBy: "provider" | "rafi" }
  | { kind: "turn-complete"; result: TurnResult }
  | { kind: "session-transition"; transition: "started" | "resumed" | "compacting" | "compacted" | "fresh-fallback"; detail?: string }
  | { kind: "context-usage"; used: number; maximum?: number; percentage?: number; observedAt?: string; source?: "provider-event" | "provider-query" | "post-compact" }
  | { kind: "error"; message: string };

export interface ContextUsage {
  used: number;
  maximum?: number;
  percentage?: number;
  observedAt?: string;
  source?: "provider-event" | "provider-query" | "post-compact";
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
  /** Provider-native context ceiling, as a percentage of that provider's model window. */
  autoCompactThresholdPercent?: number;
}

export interface BuilderAdapter {
  readonly agent: "claude" | "codex";

  /** Send one instruction; resolves when that turn completes. */
  sendTurn(text: string): Promise<TurnResult>;

  /** Current session id, once known — used for resume. */
  sessionId(): string | undefined;

  /** Current location-scoped session reference, once known. */
  sessionRef?(): ProviderSessionRefV1 | undefined;

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
  prepareAutoCompaction?(thresholdPercent?: number): Promise<void>;

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
