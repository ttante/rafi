import type { TicketDef } from "./ticketSchema.js";
import type { TicketState } from "./stateDb.js";
import { resolveBlockers, computeDisplayStatus } from "./blockers.js";
import type { DeliveryConfig, DeliveryStack, StackDeliveryState } from "./delivery.js";
import { normalizeStackNodes } from "./delivery.js";

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
      return status !== "done" && status !== "canceled" && status !== "obsolete";
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

/** Human-readable queue blocks keep a whole unfinished stack and its resume point visible. */
export function formatStackAwareQueue(ticketDefs: TicketDef[], states: Map<string, TicketState>, delivery?: DeliveryConfig): string[] {
  if (!delivery?.stacks?.length) return buildNextQueue(ticketDefs, states, Number.MAX_SAFE_INTEGER).map((row) => `${row.ticket} ${row.status} ${row.title}`);
  const defs = new Map(ticketDefs.map((ticket) => [ticket.id, ticket]));
  const unitById = new Map(delivery.units.map((unit) => [unit.id, unit]));
  const stackedTickets = new Set<string>(); const lines: string[] = [];
  for (const stack of delivery.stacks) {
    const nodes = normalizeStackNodes(stack, delivery.units, ticketDefs);
    const ticketIds = stack.units.flatMap((id) => unitById.get(id)?.tickets ?? []);
    ticketIds.forEach((id) => stackedTickets.add(id));
    const completed = ticketIds.filter((id) => terminal(states.get(id)?.status));
    if (completed.length === ticketIds.length && (stack.status ?? "planned") === "merged") continue;
    const next = ticketIds.find((id) => !terminal(states.get(id)?.status));
    const blockers = next && defs.get(next) ? resolveBlockers(defs.get(next)!, states) : [];
    const state = deriveStackState(stack, ticketIds, states, blockers);
    lines.push(`=== STACK START: ${stack.name} (${stack.id}) ===`);
    lines.push(`status=${state}; size=${ticketIds.length}; pr_depth=${nodes.length}; blockers=${blockers.join(",") || "none"}; completed_prefix=${completed.join(",") || "none"}; next=${next ?? "none"}`);
    lines.push(`reviews=${stack.review_links?.join(",") || "none"}; remote_checked=${stack.remote_checked_at ?? "never"}${stack.remote_stale ? " (stale; run --refresh for a live check)" : ""}`);
    for (const id of ticketIds) lines.push(`${id} ${states.get(id)?.status ?? "planned"} ${defs.get(id)?.title ?? "unknown ticket"}`);
    lines.push(`=== STACK END: ${stack.name} (${stack.id}) ===`);
  }
  for (const ticket of ticketDefs.sort((a, b) => a.order - b.order)) {
    if (stackedTickets.has(ticket.id) || terminal(states.get(ticket.id)?.status)) continue;
    const blockers = resolveBlockers(ticket, states); lines.push(`${ticket.id} ${computeDisplayStatus(states.get(ticket.id)?.status ?? "planned", blockers)} ${ticket.title}`);
  }
  return lines;
}

function terminal(status: string | undefined): boolean { return status === "done" || status === "canceled" || status === "obsolete"; }
function deriveStackState(stack: DeliveryStack, tickets: string[], states: Map<string, TicketState>, blockers: string[]): StackDeliveryState {
  if (stack.status === "merged") return "merged";
  if (stack.status === "awaiting_review") return "awaiting_review";
  if (blockers.length) return "blocked";
  const completed = tickets.filter((id) => terminal(states.get(id)?.status)).length;
  if (completed === 0) return stack.status ?? "planned";
  if (completed < tickets.length) return "partial";
  return "awaiting_review";
}
