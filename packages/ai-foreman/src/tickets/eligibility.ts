import type { DeliveryConfig } from "./delivery.js";
import { resolveBlockers } from "./blockers.js";
import type { TicketDef } from "./ticketSchema.js";
import type { TicketState } from "./stateDb.js";

export type TicketIneligibilityCode =
  | "missing" | "terminal" | "outside-window" | "dependencies" | "explicit-blocker"
  | "delivery-constraint" | "active-lease" | "resumable-owner";

export interface TicketEligibility {
  ticket?: TicketDef;
  eligible: boolean;
  recommended: boolean;
  blockers: Array<{ code: TicketIneligibilityCode; detail: string; tickets?: string[] }>;
  eligibleDependencies: TicketDef[];
}

export interface EligibilityContext {
  tickets: TicketDef[];
  states: Map<string, TicketState>;
  implementationLimit: number;
  delivery?: DeliveryConfig;
  activeLease?: { runId: string };
  allowOwnedResume?: boolean;
}

export function evaluateTicketEligibility(context: EligibilityContext, ticketId: string): TicketEligibility {
  const ticket = context.tickets.find((candidate) => candidate.id === ticketId);
  if (!ticket) return { eligible: false, recommended: false, blockers: [{ code: "missing", detail: `ticket ${ticketId} does not exist` }], eligibleDependencies: [] };
  const state = context.states.get(ticket.id);
  const blockers: TicketEligibility["blockers"] = [];
  if (["done", "canceled", "obsolete"].includes(state?.status ?? "planned")) blockers.push({ code: "terminal", detail: `ticket is ${state?.status}` });
  const window = implementationWindow(context.tickets, context.states, context.implementationLimit);
  if (!window.some((candidate) => candidate.id === ticket.id)) blockers.push({ code: "outside-window", detail: `ticket is outside the ${context.implementationLimit}-ticket implementation window` });
  const unfinishedDependencies = ticket.depends_on.filter((id) => context.states.get(id)?.status !== "done");
  if (unfinishedDependencies.length) blockers.push({ code: "dependencies", detail: `unfinished dependencies: ${unfinishedDependencies.join(", ")}`, tickets: unfinishedDependencies });
  const explicit = resolveBlockers(ticket, context.states).filter((id) => !unfinishedDependencies.includes(id));
  if (explicit.length) blockers.push({ code: "explicit-blocker", detail: `explicit blockers: ${explicit.join(", ")}`, tickets: explicit });
  const deliveryReason = deliveryConstraint(ticket.id, context.delivery, context.states);
  if (deliveryReason) blockers.push({ code: "delivery-constraint", detail: deliveryReason });
  if (context.activeLease) blockers.push({ code: "active-lease", detail: `project has an active workflow lease for run ${context.activeLease.runId}` });
  if (!context.allowOwnedResume && (state?.status === "in_progress" || state?.owner)) blockers.push({ code: "resumable-owner", detail: `ticket has resumable ownership${state.owner ? ` by ${state.owner}` : ""}` });
  const eligibleDependencies = unfinishedDependencies
    .map((id) => context.tickets.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is TicketDef => Boolean(candidate))
    .filter((candidate) => evaluateTicketEligibility({ ...context, activeLease: undefined }, candidate.id).eligible)
    .sort(ticketOrder);
  const ranked = eligibleTickets({ ...context, activeLease: undefined });
  return { ticket, eligible: blockers.length === 0, recommended: ranked[0]?.id === ticket.id, blockers, eligibleDependencies };
}

export function eligibleTickets(context: EligibilityContext): TicketDef[] {
  return implementationWindow(context.tickets, context.states, context.implementationLimit)
    .filter((ticket) => {
      const state = context.states.get(ticket.id);
      if (["done", "canceled", "obsolete", "in_progress"].includes(state?.status ?? "planned") || state?.owner) return false;
      if (resolveBlockers(ticket, context.states).length) return false;
      return !deliveryConstraint(ticket.id, context.delivery, context.states);
    })
    .sort(ticketOrder);
}

export function implementationWindow(tickets: TicketDef[], states: Map<string, TicketState>, limit: number): TicketDef[] {
  return tickets.filter((ticket) => !["done", "canceled", "obsolete"].includes(states.get(ticket.id)?.status ?? "planned")).sort(ticketOrder).slice(0, limit);
}

function ticketOrder(a: TicketDef, b: TicketDef): number {
  return a.order - b.order || a.id.localeCompare(b.id);
}

function deliveryConstraint(ticketId: string, delivery: DeliveryConfig | undefined, states: Map<string, TicketState>): string | undefined {
  if (!delivery) return undefined;
  const unit = delivery.units.find((candidate) => candidate.tickets.includes(ticketId));
  if (!unit) return undefined;
  const stack = delivery.stacks?.find((candidate) => candidate.units.includes(unit.id));
  if (!stack) return undefined;
  const firstUnfinishedUnit = stack.units.find((unitId) => {
    const candidate = delivery.units.find((item) => item.id === unitId);
    return candidate?.tickets.some((id) => !["done", "canceled", "obsolete"].includes(states.get(id)?.status ?? "planned"));
  });
  if (firstUnfinishedUnit && firstUnfinishedUnit !== unit.id) return `delivery stack ${stack.id} must continue with unit ${firstUnfinishedUnit}`;
  const firstUnfinishedTicket = unit.tickets.find((id) => !["done", "canceled", "obsolete"].includes(states.get(id)?.status ?? "planned"));
  if (firstUnfinishedTicket && firstUnfinishedTicket !== ticketId && unit.dependency_mode === "stack") return `delivery unit ${unit.id} must continue with ${firstUnfinishedTicket}`;
  return undefined;
}
