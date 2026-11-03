// Workflows and roles as data (ARCH 4.8, plan choice C5).
export type StepType = "maker" | "checker" | "rafi";
export type TicketActiveState = "building" | "reviewing" | "fixing";
/** Where a path ends: another node's id, or one of these. */
export type StepEnd = "done" | "blocked" | "unfixed";

export interface StepLimit {
  /** The setting that bounds this loop; `retries.fixes` for standard's fix loop. */
  readonly setting: string;
  /** Where the path goes when the limit is used up (or circling stops it). */
  readonly exhausted: StepEnd;
}

export interface WorkflowNode {
  readonly id: string;
  /** The step name written in events (`step.started.step`). */
  readonly step: string;
  readonly state: TicketActiveState;
  readonly type: StepType;
  readonly role: string | null;
  readonly onPass: string;
  readonly onFail: string;
  readonly limit?: StepLimit;
  /** Skipped (its onPass followed) when QA is off. */
  readonly skipWhenQaOff?: boolean;
}

export interface Workflow {
  readonly id: string;
  readonly version: number;
  readonly start: string;
  readonly nodes: readonly WorkflowNode[];
}

export interface Role {
  readonly id: string;
  readonly coreInstructions: string;
  readonly replySchema: string | null;
  readonly permissions: "read-only" | "write";
  readonly defaultAgent: "codex" | "claude";
}
