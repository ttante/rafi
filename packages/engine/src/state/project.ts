// nextProject (ARCH 4.4): eight states. The fold passes whether every ticket is closed (plan choice C28).
import {
  InvalidTransition, type ProjectContext, type ProjectState, type ProjectStateName, type StateEvent,
} from "./types.js";

type Data = Record<string, unknown>;

export const initialProject: ProjectState = Object.freeze({ state: "none", before: null });

const BUILD_ENDS: ReadonlySet<string> = new Set(["build.stopped", "build.failed"]);

function to(p: ProjectState, state: ProjectStateName, before: ProjectStateName | null = p.before): ProjectState {
  return { state, before };
}

function addsTicket(data: Data): boolean {
  return ((data.items as { field: string }[]) ?? []).some((item) => item.field === "added");
}

function building(p: ProjectState, event: StateEvent, data: Data, ctx: ProjectContext): ProjectState | null {
  if (event.type === "build.finished") {
    return to(p, data.complete === true && ctx.allTicketsClosed ? "complete" : "ready");
  }
  if (BUILD_ENDS.has(event.type)) return to(p, "ready");
  if (event.type === "build.owner_released" && data.reason === "waiting") return to(p, "ready");
  return null;
}

/** Events that only matter to a build or a ticket pass through the project unchanged. */
const PROJECT_EVENTS: ReadonlySet<string> = new Set([
  "project.created", "project.migrated", "project.archived", "project.unarchived", "plan.started",
  "plan.proposed", "plan.failed", "plan.rejected", "plan.approved", "tickets.populated", "tickets.changed",
  "future_work.accepted", "build.started", "build.finished", "build.stopped", "build.failed",
  "build.owner_released", "plan.reset", "plan.changed",
]);

export function isProjectEvent(type: string): boolean {
  return PROJECT_EVENTS.has(type);
}

function planning(p: ProjectState, event: StateEvent, data: Data): ProjectState | null {
  const s = p.state;
  if (event.type === "plan.started" && (s === "draft" || s === "ready" || s === "complete")) {
    return to(p, "planning", s);
  }
  if (s === "planning" && event.type === "plan.proposed") return to(p, "awaiting-approval");
  if (s === "planning" && event.type === "plan.failed") return to(p, p.before ?? "draft", null);
  if (s === "awaiting-approval" && event.type === "plan.rejected") return to(p, "planning");
  if (s === "awaiting-approval" && event.type === "plan.approved") {
    return to(p, data.by === "carried" ? "ready" : "ticketing", null);
  }
  return null;
}

function tickets(p: ProjectState, event: StateEvent, data: Data): ProjectState | null {
  const s = p.state;
  if ((s === "ticketing" || s === "draft") && event.type === "tickets.populated") return to(p, "ready");
  if (s === "draft" && event.type === "future_work.accepted") return to(p, "ready");
  if (s === "draft" && event.type === "tickets.changed" && addsTicket(data)) return to(p, "ready");
  if (s === "complete" && event.type === "plan.changed") return to(p, "ready");
  if (s === "complete" && event.type === "tickets.changed" && addsTicket(data)) return to(p, "ready");
  if (event.type === "tickets.changed") return p;
  if (event.type === "plan.reset" && s !== "archived" && s !== "none") return to(p, "ticketing");
  return null;
}

/** The project's next state. Events that don't concern the project return it unchanged. */
export function nextProject(project: ProjectState, event: StateEvent, ctx: ProjectContext): ProjectState {
  const p = project;
  const data = (event.data ?? {}) as Data;
  if (!PROJECT_EVENTS.has(event.type)) return p;
  if (event.type === "project.created") {
    if (p.state !== "none") throw new InvalidTransition(p.state, event.type);
    return to(p, "draft", null);
  }
  if (event.type === "project.migrated") {
    // The event names the state the migrated project lands in: ready, ticketing or draft (ARCH 3.4, 4.4).
    if (p.state !== "none") throw new InvalidTransition(p.state, event.type);
    return to(p, data.state as ProjectStateName, null);
  }
  if (event.type === "project.archived") return to(p, "archived", null);
  if (event.type === "project.unarchived") {
    if (p.state !== "archived") throw new InvalidTransition(p.state, event.type);
    return to(p, "ready", null);
  }
  if (event.type === "build.started") {
    if (p.state !== "ready" && p.state !== "complete") throw new InvalidTransition(p.state, event.type);
    return to(p, "building");
  }
  if (p.state === "building") {
    const next = building(p, event, data, ctx);
    if (next) return next;
    if (event.type === "build.owner_released" || event.type === "tickets.changed") return p;
  } else if (event.type === "build.owner_released") {
    return p;
  }
  const next = planning(p, event, data) ?? tickets(p, event, data);
  if (next) return next;
  throw new InvalidTransition(p.state, event.type);
}
