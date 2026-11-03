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
  | "Paused" | "Pausing…" | "Failed" | "Recovering" | "Complete" | "Archived";

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
  const crashed = ["running", "waiting", "paused", "stopping"].includes(build.state) && !live.ownerAlive;
  if (build.state === "failed" || crashed) return "Failed";
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
