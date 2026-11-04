// nextTicket (ARCH 4.2): the ticket state machine, reading its steps from the pinned workflow.
import type { Workflow, WorkflowNode } from "../workflow/types.js";
import {
  InvalidTransition, type BlockKind, type StateEvent, type TicketRules, type TicketState,
} from "./types.js";

type Data = Record<string, unknown>;

/** Events that never change a ticket, in any state (ARCH 4.2 "any … no change"). */
const NO_CHANGE: ReadonlySet<string> = new Set([
  "ticket.tags_added", "waiver.recorded", "facts.snapshot", "check.run", "attempt.summary", "turn.retry",
  "ticket.risk_waiver_recorded", "scan.gap", "recording.saved", "recording.removed", "git.committed",
  "git.branch_created",
]);

export function initialTicket(id: string): TicketState {
  return {
    id, state: "queued", node: null, block: null, resumeNode: null, attempt: 1, fixesUsed: 0, fixesGranted: 0,
    rafiOwned: false, requirementsCurrent: false, personOnly: 0, stepRunning: false, dropped: null,
  };
}

function label(t: TicketState): string {
  return t.node ? `${t.state}·${t.node}` : t.state;
}

function node(workflow: Workflow, id: string | null): WorkflowNode | undefined {
  return id ? workflow.nodes.find((n) => n.id === id) : undefined;
}

/** Moves into a node (following QA-off skips) or onto `done`. */
function enter(t: TicketState, target: string, rules: TicketRules): TicketState {
  if (target === "done") return { ...t, state: "done", node: null, stepRunning: false, resumeNode: null };
  const next = node(rules.workflow, target);
  if (!next) throw new InvalidTransition(label(t), "workflow", `unknown step ${target}`);
  if (next.skipWhenQaOff && !rules.qa) return enter(t, next.onPass, rules);
  return { ...t, state: next.state, node: next.id, stepRunning: false, block: null, resumeNode: null };
}

function block(t: TicketState, kind: BlockKind, reason: string, resumeNode: string | null, question = null) {
  return { ...t, state: "blocked" as const, node: null, stepRunning: false, resumeNode,
    block: { kind, reason, question } };
}

function fixesLeft(t: TicketState, rules: TicketRules): boolean {
  return t.fixesUsed < rules.fixes + t.fixesGranted;
}

/** A failed check or a rejection: fix again, or the loop's limit (or circling) ends it (ARCH 4.2, 5.5). */
function failLoop(t: TicketState, at: WorkflowNode, circling: boolean, rules: TicketRules): TicketState {
  if (fixesLeft(t, rules) && !circling) {
    return { ...enter(t, at.onFail, rules), attempt: t.attempt + 1, fixesUsed: t.fixesUsed + 1 };
  }
  const owned = t.rafiOwned || rules.rafiOwned;
  const why = circling ? "the same failure repeated with no progress" : "no fixes left";
  return block(t, owned ? "unfixed" : "what-next", why, at.onFail);
}

const STATUS_TO_STATE: Readonly<Record<string, "queued" | "blocked" | "done" | "dropped">> = Object.freeze({
  planned: "queued", next: "queued", in_progress: "queued", blocked: "blocked", done: "done",
  canceled: "dropped", obsolete: "dropped",
});

function setStatus(t: TicketState, status: string): TicketState {
  const target = STATUS_TO_STATE[status];
  if (!target) throw new InvalidTransition(label(t), "ticket.status_set", `unknown status ${status}`);
  const base = { ...t, node: null, stepRunning: false, block: null };
  if (target === "blocked") return block(t, "manual", "Blocked with rafi tickets block", t.resumeNode);
  if (target === "dropped") return { ...base, state: "dropped", dropped: status };
  return { ...base, state: target };
}

function startTicket(t: TicketState, data: Data, rules: TicketRules): TicketState {
  const resume = (data.resume_step as string | null) ?? t.resumeNode;
  if (resume) return enter(t, resume, rules);
  const first = node(rules.workflow, rules.workflow.start);
  if (first && first.step === "prepare" && t.requirementsCurrent) return enter(t, first.onPass, rules);
  return enter(t, rules.workflow.start, rules);
}

function builderReported(t: TicketState, at: WorkflowNode, data: Data, rules: TicketRules): TicketState {
  if (data.kind === "done") return enter(t, at.onPass, rules);
  if (data.kind === "needs-input") {
    const question = (data.question as { text?: string } | null)?.text ?? "The builder needs input";
    return block(t, "decision", question, at.id);
  }
  const reported = data.block as { type: BlockKind; reason: string } | null;
  return block(t, reported?.type ?? "other", reported?.reason ?? "The builder reported blocked", at.id);
}

function verdict(t: TicketState, at: WorkflowNode, data: Data, rules: TicketRules): TicketState {
  if (data.rejected) return failLoop(t, at, Boolean(data.circling), rules);
  const unverified = (data.unverified as { req: number; tool: string | null }[]) ?? [];
  const tool = unverified.find((u) => u.tool);
  if (tool) return block(t, "unverified", `R${tool.req} needs ${tool.tool} to verify`, at.id);
  if (t.personOnly > 0 && rules.manualChecks === "wait") {
    return block(t, "confirm", "A check only a person can do is waiting", at.onPass);
  }
  return enter(t, at.onPass, rules);
}

function unblocked(t: TicketState, data: Data, rules: TicketRules): TicketState {
  const resume = (data.resume_step as string | null) ?? t.resumeNode;
  const fixNode = node(rules.workflow, resume);
  if (t.block?.kind === "confirm" && fixNode?.type === "maker" && fixNode.state === "fixing") {
    return { ...enter(t, fixNode.id, rules), attempt: t.attempt + 1, fixesUsed: t.fixesUsed + 1 };
  }
  const queued = { ...t, state: "queued" as const, node: null, block: null, resumeNode: resume, stepRunning: false };
  // C104 (ARCH 4.2's what-next row): "Retry another Builder fix" is the next attempt and uses the grant, so exactly
  // one more fix runs before rafi asks again, even when circling asked early.
  if (t.block?.kind === "what-next" && fixNode?.type === "maker" && fixNode.state === "fixing") {
    return { ...queued, attempt: t.attempt + 1, fixesUsed: rules.fixes + t.fixesGranted };
  }
  return queued;
}

function namesTicket(t: TicketState, data: Data): boolean {
  const items = (data.items as { ticket: string }[]) ?? [];
  return Boolean(data.material) && items.some((item) => item.ticket === t.id);
}

function inactive(t: TicketState, event: StateEvent, rules: TicketRules): TicketState {
  const data = (event.data ?? {}) as Data;
  const from = label(t);
  if (t.state === "queued" && event.type === "ticket.started") return startTicket(t, data, rules);
  if (t.state === "queued" && event.type === "ticket.blocked") {
    if (data.kind !== "held" && data.kind !== "build-wide") throw new InvalidTransition(from, event.type);
    return block(t, data.kind, String(data.reason), t.resumeNode);
  }
  if ((t.state === "queued" || t.state === "blocked") && event.type === "ticket.dropped") {
    return { ...t, state: "dropped", node: null, block: null, dropped: String(data.why) };
  }
  if ((t.state === "queued" || t.state === "blocked") && event.type === "tickets.changed") {
    return namesTicket(t, data) ? { ...t, requirementsCurrent: false } : t;
  }
  if (t.state === "blocked" && event.type === "ticket.unblocked") return unblocked(t, data, rules);
  if (t.state === "done" && event.type === "ticket.reopened") {
    const review = rules.workflow.nodes.find((n) => n.state === "reviewing");
    return review ? enter(t, review.id, rules) : t;
  }
  if (t.state === "done" || t.state === "dropped") return t;
  throw new InvalidTransition(from, event.type);
}

function active(t: TicketState, event: StateEvent, rules: TicketRules): TicketState {
  const data = (event.data ?? {}) as Data;
  const at = node(rules.workflow, t.node);
  const from = label(t);
  if (!at) throw new InvalidTransition(from, event.type, "the ticket has no current step");
  const isCheck = at.type === "rafi" && at.step === "check";
  switch (event.type) {
    case "step.started":
      if (data.step !== at.step) throw new InvalidTransition(from, event.type, `step ${String(data.step)}`);
      return { ...t, stepRunning: true };
    case "requirements.written":
      if (at.step !== "prepare") break;
      return { ...enter(t, at.onPass, rules), requirementsCurrent: true,
        personOnly: ((data.person_only as number[]) ?? []).length };
    case "builder.reported":
      if (at.type !== "maker") break;
      return builderReported(t, at, data, rules);
    case "checks.passed":
      if (!isCheck) break;
      return enter(t, at.onPass, rules);
    case "checks.failed":
      if (!isCheck) break;
      return failLoop(t, at, Boolean(data.circling), rules);
    case "ticket.blocked":
      if (!isCheck || data.kind !== "limit") break;
      return block(t, "limit", String(data.reason), at.id);
    case "verdict.recorded":
      if (at.state !== "reviewing") break;
      return verdict(t, at, data, rules);
    case "delivery.done":
      if (at.step !== "deliver") break;
      return enter(t, at.onPass, rules);
    case "step.failed":
    case "tickets.changed":
      return changedOrFailed(t, at, event.type, data, rules);
  }
  throw new InvalidTransition(from, event.type);
}

/** step.failed and a material tickets.changed apply in building·*, reviewing·review and fixing·fix only. */
function changedOrFailed(t: TicketState, at: WorkflowNode, type: string, data: Data, rules: TicketRules) {
  if (type === "tickets.changed" && !namesTicket(t, data)) return t;
  if (at.state === "fixing" && at.type !== "maker") throw new InvalidTransition(label(t), type);
  if (type === "tickets.changed") return { ...enter(t, rules.workflow.start, rules), requirementsCurrent: false };
  const circling = Boolean(data.circling) && at.state === "fixing";
  return block(t, circling ? "what-next" : "other", String(data.reason), at.id);
}

/** The ticket's next state. An invalid pair throws InvalidTransition; the fold turns it into a violation. */
export function nextTicket(ticket: TicketState | null, event: StateEvent, rules: TicketRules): TicketState {
  const id = event.ticket_id ?? ticket?.id ?? "?";
  if (event.type === "ticket.added") {
    if (ticket) throw new InvalidTransition(label(ticket), event.type, "the ticket already exists");
    return { ...initialTicket(id), rafiOwned: true };
  }
  const t = ticket ?? initialTicket(id);
  const data = (event.data ?? {}) as Data;
  if (NO_CHANGE.has(event.type)) return t;
  // P31 (ARCH 4.2): back to queued with no resume step, attempt 1 and no fixes; dropped tickets stay dropped.
  if (event.type === "build.reset") {
    return t.state === "dropped" ? t : { ...t, state: "queued", node: null, block: null, resumeNode: null,
      attempt: 1, fixesUsed: 0, fixesGranted: 0, stepRunning: false };
  }
  if (event.type === "fix.granted") return { ...t, fixesGranted: t.fixesGranted + 1 };
  if (event.type === "ticket.status_set") return setStatus(t, String(data.status));
  if (event.type === "progress.imported") {
    const entry = data.entry as { status: string | null };
    return entry.status ? setStatus(t, entry.status) : t;
  }
  if (t.state === "building" || t.state === "reviewing" || t.state === "fixing") return active(t, event, rules);
  return inactive(t, event, rules);
}
