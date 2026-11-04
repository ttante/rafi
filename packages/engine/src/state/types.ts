// State types for the three machines, the fold and decide (ARCH 4.1–4.5). Types only; no I/O.
import type { Workflow } from "../workflow/types.js";

export type TicketStateName = "queued" | "building" | "reviewing" | "fixing" | "blocked" | "done" | "dropped";
export type BlockKind =
  | "permission" | "install" | "service" | "credential" | "decision" | "other" | "held" | "what-next"
  | "unverified" | "confirm" | "build-wide" | "manual" | "limit" | "unfixed";

export interface Block {
  readonly kind: BlockKind;
  readonly reason: string;
  readonly question: string | null;
}

export interface TicketState {
  readonly id: string;
  readonly state: TicketStateName;
  /** The workflow node id while building, reviewing or fixing. */
  readonly node: string | null;
  readonly block: Block | null;
  /** The node id a blocked or queued ticket restarts at (`resume_step` in events). */
  readonly resumeNode: string | null;
  readonly attempt: number;
  readonly fixesUsed: number;
  readonly fixesGranted: number;
  readonly rafiOwned: boolean;
  /** A requirements file exists for the current definition (plan choice C6). */
  readonly requirementsCurrent: boolean;
  readonly personOnly: number;
  /** A step.started with no recorded outcome yet: the step to redo (ARCH 4.5 rule 3). */
  readonly stepRunning: boolean;
  readonly dropped: string | null;
}

export interface TicketRules {
  qa: boolean;
  fixes: number;
  manualChecks: "wait" | "none" | "track";
  rafiOwned: boolean;
  workflow: Workflow;
}

/** The parts of a stored event the pure functions read. */
export interface StateEvent {
  readonly type: string;
  readonly data: unknown;
  readonly run_id?: string | null;
  readonly ticket_id?: string | null;
  readonly at?: string;
  readonly seq?: number;
}

export type BuildStateName = "running" | "waiting" | "paused" | "stopping" | "stopped" | "finished" | "failed";

export interface BuildState {
  readonly run: string;
  readonly state: BuildStateName | "none";
  readonly pausing: boolean;
  readonly unpausing: boolean;
  readonly stopMode: "graceful" | "now" | null;
  readonly stopSource: string | null;
  readonly cause: "stop" | "cancel" | "ctrl-c" | "crash" | "reset" | null;
  readonly complete: boolean | null;
  readonly ownerReleased: boolean;
  readonly startedAt: string | null;
  readonly workflow: { id: string; version: number; digest: string } | null;
  readonly scope: { kind: string; value: unknown; skip: string[] } | null;
  readonly tickets: readonly string[];
  readonly settings: Readonly<Record<string, { value: unknown; source: string }>>;
  /** C144: the ticket a `rafi resume --ticket` narrowed this segment to (P32), until the next build.resumed. */
  readonly narrowed: string | null;
  /** P32: this resume's one-off overrides (agent, model), until the build ends or the next build.resumed. */
  readonly overrides: Readonly<Record<string, { value: unknown; source: string }>>;
  /** C145: between build.owner_lost and the first outcome a redone step records. */
  readonly recovering: boolean;
  /** C152: an owner has acquired it (a detached start has none until its child takes it). */
  readonly everOwned: boolean;
}

export type ProjectStateName =
  | "draft" | "planning" | "awaiting-approval" | "ticketing" | "ready" | "building" | "complete" | "archived";

export interface ProjectState {
  readonly state: ProjectStateName | "none";
  /** The state before planning started, for plan.failed (ARCH 4.4). */
  readonly before: ProjectStateName | null;
}

export interface ProjectContext {
  /** Every ticket is done or dropped (for building → complete). */
  readonly allTicketsClosed: boolean;
}

export interface Question {
  readonly id: string;
  readonly no: number;
  readonly kind: string;
  readonly tickets: readonly string[];
  readonly text: string;
  readonly status: "open" | "answered" | "deferred" | "closed";
  readonly openedAt: string | null;
}

export interface TicketDefinition {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export interface Violation {
  readonly seq: number;
  readonly type: string;
  readonly reason: string;
}

export interface Folded {
  readonly project: ProjectState;
  readonly builds: Readonly<Record<string, BuildState>>;
  /** The latest run, or null before any build. */
  readonly run: string | null;
  readonly tickets: Readonly<Record<string, TicketState>>;
  /** Ticket definitions in queue order, from tickets.yaml (passed to the fold). */
  readonly queue: readonly TicketDefinition[];
  /** Tickets done in each run, in order (for --steps). */
  readonly doneInRun: Readonly<Record<string, readonly string[]>>;
  readonly questions: Readonly<Record<string, Question>>;
  readonly answers: Readonly<Record<string, { choice: string | null; text: string | null }>>;
  readonly grants: readonly { need: string; scope: string; allowed: boolean; tickets: readonly string[] }[];
  readonly units: Readonly<Record<string, string>>;
  readonly violations: readonly Violation[];
}

export interface Liveness {
  /** The loop is between steps: a step's outcome is recorded and the next hasn't started. */
  readonly safePoint: boolean;
  /** A step is executing in this process right now. */
  readonly stepInFlight: boolean;
}

export type Action =
  | { kind: "none"; why: string }
  | { kind: "stop"; now: boolean; letStepFinish: boolean }
  | { kind: "pause" }
  | { kind: "hold"; why: string }
  | { kind: "step"; ticket: string; node: string; redo: boolean }
  | { kind: "deliver-unit"; unit: string }
  | { kind: "start-ticket"; ticket: string; resumeNode: string | null }
  | { kind: "wait"; questions: string[] }
  | { kind: "finish"; complete: boolean; done: string[]; left: string[] };

export class InvalidTransition extends Error {
  constructor(readonly from: string, readonly eventType: string, why = "no rule for this pair") {
    super(`${eventType} isn't valid in ${from}: ${why}`);
  }
}
