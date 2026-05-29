import type { TicketDef } from "./ticketSchema.js";
import type { TicketState } from "./stateDb.js";

export function resolveBlockers(
  ticket: TicketDef,
  states: Map<string, TicketState>,
): string[] {
  const unresolvedDeps = ticket.depends_on.filter((depId) => {
    const dep = states.get(depId);
    return dep?.status !== "done";
  });

  const state = states.get(ticket.id);
  const explicitBlockers: string[] = state
    ? (JSON.parse(state.blocked_by_json || "[]") as string[])
    : [];

  return [...new Set([...unresolvedDeps, ...explicitBlockers])];
}

export type DisplayStatus = "next" | "in_progress" | "blocked" | "done" | "canceled";

export function computeDisplayStatus(
  storedStatus: string,
  blockedBy: string[],
): DisplayStatus {
  if (storedStatus === "done") return "done";
  if (storedStatus === "canceled") return "canceled";
  if (storedStatus === "in_progress") return "in_progress";
  if (blockedBy.length > 0 || storedStatus === "blocked") return "blocked";
  return "next";
}
