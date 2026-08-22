/**
 * Agent-agnostic interface over a coding agent ("builder").
 */
import type { RuntimeProbeCategory, RuntimeProbePhase } from "rafi-spec";

/** A permission request surfaced by a builder before it runs a tool. */
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  /** Human-readable prompt from the agent, when available. */
  title?: string;
}

/** The foreman's verdict on a permission request. */
export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

/** Decides each permission request. Supplied by the foreman, called by the adapter. */
export type PermissionHandler = (
  req: PermissionRequest,
) => Promise<PermissionDecision>;

/** Result of a single completed turn. */
export interface TurnResult {
  /** Final assistant message text — where the STEP_STATUS marker lives. */
  text: string;
  isError: boolean;
  numTurns: number;
  costUsd: number;
  failure?: {
    runtime: "claude" | "codex";
    phase: RuntimeProbePhase;
    category: RuntimeProbeCategory;
    executable: string;
    cwd: string;
    diagnostics: string;
  };
}

/** Observability events emitted while a builder works. */
export type BuilderEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "turn-complete"; result: TurnResult }
  | { kind: "session-transition"; transition: "started" | "resumed" | "compacting" | "compacted" | "fresh-fallback"; detail?: string }
  | { kind: "context-usage"; used: number; maximum?: number; percentage?: number }
  | { kind: "error"; message: string };

export interface ContextUsage {
  used: number;
  maximum?: number;
  percentage?: number;
}

export interface CompactResult {
  ok: boolean;
  error?: string;
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
  resumeSessionId?: string;
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
}

export interface BuilderAdapter {
  readonly agent: "claude" | "codex";

  /** Send one instruction; resolves when that turn completes. */
  sendTurn(text: string): Promise<TurnResult>;

  /** Current session id, once known — used for resume. */
  sessionId(): string | undefined;

  /** Provider-native compaction on the exact live conversation. */
  compact?(): Promise<CompactResult>;

  /** Truthful provider context occupancy, when exposed by the provider. */
  contextUsage?(): Promise<ContextUsage | undefined>;

  /** Attempt a provider-supported in-conversation model/reasoning transition. */
  switchSettings?(settings: ProviderSettingSwitch): Promise<CompactResult>;

  /** Stream of observability events. Iterate to drive a live view. */
  events(): AsyncIterable<BuilderEvent>;

  /** Shut the builder down and release resources. */
  close(): Promise<void>;
}
