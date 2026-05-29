import type { TicketDef } from "./ticketSchema.js";
import type { TicketState } from "./stateDb.js";
import { resolveBlockers, computeDisplayStatus } from "./blockers.js";

export interface QueueRow {
  rank: number;
  ticket: string;
  title: string;
  status: string;
  priority: string;
  area: string;
  dependsOn: string;
  blockedBy: string;
  size: string;
  risk: string;
  nextAction: string;
  requiredTests: string;
  evidence: string;
  likelyFiles: string;
}

export interface ActiveStatusRow {
  ticket: string;
  title: string;
  status: string;
  priority: string;
  area: string;
  owner: string;
  lastWorkedAt: string;
  completedAt: string;
  dependsOn: string;
  blockers: string;
  nextAction: string;
  acceptanceTestGate: string;
  evidence: string;
  futureWorkNotes: string;
}

function defaultNextAction(ticket: TicketDef, displayStatus: string, blockedBy: string[]): string {
  if (displayStatus === "blocked") return `Resolve blockers: ${blockedBy.join(", ")}`;
  if (displayStatus === "in_progress") return "Continue implementation";
  return "Begin implementation";
}

export function buildNextQueue(
  ticketDefs: TicketDef[],
  states: Map<string, TicketState>,
  queueLimit: number,
): QueueRow[] {
  const remaining = ticketDefs
    .filter((t) => {
      const s = states.get(t.id);
      const status = s?.status ?? "planned";
      return status !== "done" && status !== "canceled";
    })
    .sort((a, b) => a.order - b.order);

  const window = remaining.slice(0, Math.min(queueLimit, remaining.length));

  return window.map((ticket, index) => {
    const state = states.get(ticket.id);
    const blockedBy = resolveBlockers(ticket, states);
    const displayStatus = computeDisplayStatus(state?.status ?? "planned", blockedBy);

    return {
      rank: index + 1,
      ticket: ticket.id,
      title: ticket.title,
      status: displayStatus,
      priority: ticket.priority,
      area: ticket.area,
      dependsOn: ticket.depends_on.length ? ticket.depends_on.join(", ") : "None",
      blockedBy: blockedBy.length ? blockedBy.join(", ") : "None",
      size: ticket.size,
      risk: ticket.risk,
      nextAction: state?.next_action ?? defaultNextAction(ticket, displayStatus, blockedBy),
      requiredTests: ticket.required_tests.join("; "),
      evidence: state?.evidence ?? "N/A until implemented.",
      likelyFiles: ticket.likely_files.length ? ticket.likely_files.join(", ") : "unknown",
    };
  });
}

export function buildActiveStatusRows(
  queueRows: QueueRow[],
  ticketDefs: TicketDef[],
  states: Map<string, TicketState>,
): ActiveStatusRow[] {
  const defsById = new Map(ticketDefs.map((t) => [t.id, t]));

  return queueRows.map((row) => {
    const state = states.get(row.ticket);
    const def = defsById.get(row.ticket);

    return {
      ticket: row.ticket,
      title: row.title,
      status: row.status,
      priority: row.priority,
      area: row.area,
      owner: state?.owner ?? "unassigned",
      lastWorkedAt: state?.last_worked_at ?? "N/A",
      completedAt: state?.completed_at ?? "N/A",
      dependsOn: row.dependsOn,
      blockers: row.blockedBy,
      nextAction: row.nextAction,
      acceptanceTestGate: def?.acceptance.join("; ") ?? "N/A",
      evidence: row.evidence,
      futureWorkNotes: state?.blocker_notes ?? "N/A",
    };
  });
}
