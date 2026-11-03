// The adapter interface of ARCH 11.6. Adapters map and report; they never retry, prompt or decide.
export type Role = "planner" | "ticket-maker" | "builder" | "qa" | "manager";

export interface TurnMeta {
  readonly key: string;
  readonly role: Role;
  readonly ticket?: string;
  readonly step?: string;
  readonly attempt?: number;
}

export interface ReplySchema {
  readonly name: string;
  /** JSON Schema draft-07, for Claude. */
  readonly json: Record<string, unknown>;
  /** Codex's strict projection; defaults to `json`. */
  readonly codex?: Record<string, unknown>;
}

export interface TurnRequest {
  /** Identity; never sent to the provider (plan choice C11). */
  readonly meta: TurnMeta;
  readonly instructions?: string;
  readonly message: string;
  readonly schema: ReplySchema;
  readonly grants: readonly string[];
  readonly tools: readonly unknown[];
  readonly repair?: true;
}

export interface ToolRun {
  readonly tool: string;
  /** The provider's id for this call (OUT-8: each completion names its call id). */
  readonly callId: string | null;
  readonly command: string | null;
  readonly outcome: "completed" | "failed" | "timed-out" | "cancelled" | "unknown";
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  /** The provider's error text for a failed call, for classifying harmless reads (C56). */
  readonly error: string | null;
}

export interface PermissionRequest {
  readonly tool: string;
  readonly command: string | null;
  readonly path: string | null;
  readonly reason: string | null;
  /** The runtime asks to act beyond its sandbox (a Codex approval under `on-request`, C85); no grant covers it. */
  readonly escalation?: true;
}

export type Decision = "allow" | "deny";

export type AgentEvent =
  /** `compaction`: the provider reported that it compacted the context (ARCH 11.2, OUT-13); never inferred. */
  | { kind: "activity"; text: string; compaction?: true }
  | { kind: "tool"; run: ToolRun }
  /** `window`: the model's context window, when the provider reports it (Codex's `modelContextWindow`). */
  | { kind: "usage"; input: number; output: number; cost?: number; measured: boolean; last?: { total: number };
      window?: number }
  | { kind: "permission"; request: PermissionRequest; decide(d: Decision): void }
  | { kind: "question"; text: string; choices: string[] }
  | { kind: "reply"; text: string; structured?: unknown; finals?: number }
  | { kind: "error"; code: "transient" | "quota" | "auth" | "configuration" | "session-gone" | "unknown";
      resetAt?: string; message: string; detail?: string }
  | { kind: "exit"; code: number | null }
  | { kind: "idle-timeout" }
  | { kind: "cancelled"; confirmed: boolean };

export const TERMINAL_KINDS: ReadonlySet<string> = new Set(["reply", "error", "exit", "idle-timeout", "cancelled"]);

export interface Capabilities {
  readonly structuredReplies: boolean;
  readonly exitCodes: boolean;
  readonly resume: boolean;
  readonly images: boolean;
  readonly enforceableGrants: boolean;
  readonly compaction: boolean;
  /** The runtime's sandbox can allow local servers without full internet (M2 plan 1.3). */
  readonly localServersWithoutInternet: boolean;
}

export interface Agent {
  readonly runtime: "codex" | "claude";
  capabilities(): Capabilities;
  turn(request: TurnRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  /** The provider's model list (C52), or null when it gives none. */
  models?(): Promise<string[] | null>;
  close(): Promise<void>;
}
