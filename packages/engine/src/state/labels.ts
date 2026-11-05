// Engine state → tracker status (ARCH 4.2) and the GUI lifecycle labels (ARCH 4.4).
import type { BuildState, Folded, ProjectState, TicketState } from "./types.js";

export type TrackerStatus = "planned" | "next" | "in_progress" | "blocked" | "done" | "canceled" | "obsolete";

function dependencyBlocked(view: Folded, id: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const def = view.queue.find((d) => d.id === id);
  return (def?.dependsOn ?? []).some((dep) => {
    const state = view.tickets[dep]?.state;
    return state === "blocked" || (state === "queued" && dependencyBlocked(view, dep, seen));
  });
}

function firstEligible(view: Folded): string | undefined {
  return view.queue.find((def) => view.tickets[def.id]?.state === "queued" &&
    def.dependsOn.every((dep) => view.tickets[dep]?.state === "done"))?.id;
}

export function trackerStatus(ticket: TicketState, view: Folded): TrackerStatus {
  switch (ticket.state) {
    case "building":
    case "reviewing":
    case "fixing":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "dropped":
      return ticket.dropped === "obsolete" ? "obsolete" : "canceled";
    case "queued":
      if (dependencyBlocked(view, ticket.id)) return "blocked";
      return firstEligible(view) === ticket.id ? "next" : "planned";
  }
}

export type GuiLabel =
  | "Draft" | "Planning" | "Awaiting plan approval" | "Ticketing" | "Ready" | "Building" | "QA" | "Awaiting you"
  | "Paused" | "Pausing…" | "Failed" | "Crashed" | "Recovering" | "Complete" | "Archived";

const PROJECT_LABELS: Readonly<Record<string, GuiLabel>> = Object.freeze({
  draft: "Draft", planning: "Planning", "awaiting-approval": "Awaiting plan approval", ticketing: "Ticketing",
  ready: "Ready", complete: "Complete", archived: "Archived",
});

export interface LabelLiveness {
  /** The build's owner is alive (false for a crashed build, ARCH 4.3). */
  readonly ownerAlive: boolean;
  /** Between build.owner_lost and the end of the first redone step. */
  readonly recovering: boolean;
}

function buildLabel(build: BuildState, view: Folded, live: LabelLiveness): GuiLabel | null {
  if (live.recovering) return "Recovering";
  if (build.state === "failed") return "Failed";
  // A derived crash (4.3): shown as "Crashed" here too, as rafi status and stats show say (M4 follow-up 1).
  if (["running", "waiting", "paused", "stopping"].includes(build.state) && !live.ownerAlive) return "Crashed";
  if (build.state === "paused") return "Paused";
  if (build.pausing) return "Pausing…";
  if (build.state === "waiting") return "Awaiting you";
  if (build.state !== "running") return null;
  const openForScope = Object.values(view.questions).some((q) => q.status === "open" &&
    q.tickets.some((t) => build.tickets.includes(t)));
  if (openForScope) return "Awaiting you";
  const current = Object.values(view.tickets).find((t) => ["building", "reviewing", "fixing"].includes(t.state));
  return current?.state === "reviewing" ? "QA" : "Building";
}

export function guiLabel(project: ProjectState, view: Folded, live: LabelLiveness): GuiLabel {
  const build = view.run ? view.builds[view.run] : undefined;
  if (project.state === "building" && build) {
    return buildLabel(build, view, live) ?? "Ready";
  }
  return PROJECT_LABELS[project.state] ?? "Draft";
}

// The outcome a build shows (ARCH 4.3's table, C134, C145): rafi status, stats show and the picker all use this one
// function. "Crashed" is derived: a live state whose owner isn't alive (4.3.1). Pure: the caller passes liveness.
export type OwnerLiveness = "alive" | "dead" | "not-responding" | "released" | "none";

export interface OutcomeContext {
  readonly owner: OwnerLiveness;
  /** When the build started waiting on you. */
  readonly since: string | null;
  /** The owner's last heartbeat. */
  readonly heartbeat: string | null;
  readonly recovering?: boolean;
  /** A newer build started while this one was unfinished (Q3 a). */
  readonly superseded: boolean;
}

export type OutcomeKind = "running" | "pausing" | "paused" | "stopping" | "waiting" | "not-responding" |
  "recovering" | "crashed" | "stopped" | "cancelled" | "cancelled-ctrl-c" | "reset" | "superseded" | "finished" |
  "finished-left" | "failed";

/** `resumable`: `rafi resume` takes it over and continues it (C142); a live build is attached to instead. */
export interface Outcome {
  readonly kind: OutcomeKind;
  readonly text: string;
  readonly resumable: boolean;
}

const hhmm = (iso: string | null) => (iso ? iso.slice(11, 16) : "an unknown time");
const out = (kind: OutcomeKind, text: string, resumable: boolean): Outcome => ({ kind, text, resumable });

const STOPPED: Readonly<Record<string, Outcome>> = Object.freeze({
  stop: out("stopped", "stopped", true), cancel: out("cancelled", "cancelled", true),
  "ctrl-c": out("cancelled-ctrl-c", "cancelled by Ctrl+C", true), crash: out("crashed", "crashed", true),
});

export function shownOutcome(build: BuildState, ctx: OutcomeContext): Outcome {
  if (build.state === "stopped" && build.cause === "reset") return out("reset", "reset", false);
  if (build.state === "finished") {
    return build.complete ? out("finished", "finished", false)
      : ctx.superseded ? out("superseded", "superseded", false)
        : out("finished-left", "finished, with work left", true);
  }
  if (ctx.superseded) return out("superseded", "superseded", false);
  if (build.state === "failed") return out("failed", "failed", true);
  if (build.state === "stopped") return STOPPED[build.cause ?? "stop"] ?? STOPPED.stop!;
  const released = ctx.owner === "released";
  if (ctx.owner === "dead" || ctx.owner === "none" || (released && build.state !== "waiting")) {
    return out("crashed", "crashed", true);
  }
  if (ctx.owner === "not-responding") {
    return out("not-responding", `not responding since ${hhmm(ctx.heartbeat)}`, false);
  }
  if (build.recovering || ctx.recovering) return out("recovering", "recovering", false);
  if (build.state === "paused") return out("paused", "paused", false);
  if (build.pausing) return out("pausing", "pausing", false);
  if (build.state === "stopping") return out("stopping", "stopping", false);
  if (build.state === "waiting") return out("waiting", `waiting on you since ${hhmm(ctx.since)}`, released);
  return out("running", "running", false);
}
