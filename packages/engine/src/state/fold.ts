// fold(events, ctx): every state event in seq order through the three machines (ARCH 3.6).
// Skips detail and imported events; an invalid pair keeps the state and becomes a violation; never throws.
import type { Workflow } from "../workflow/types.js";
import { initialBuild, nextBuild } from "./build.js";
import { initialProject, nextProject } from "./project.js";
import { initialTicket, nextTicket } from "./ticket.js";
import type {
  BuildState, Folded, ProjectState, Question, StateEvent, TicketDefinition, TicketRules, TicketState, Violation,
} from "./types.js";

export interface FoldEvent extends StateEvent {
  readonly class?: "state" | "detail";
  readonly origin?: "local" | "imported";
}

export interface FoldContext {
  readonly workflows: readonly Workflow[];
  readonly definitions?: readonly TicketDefinition[];
}

interface Acc {
  project: ProjectState;
  builds: Record<string, BuildState>;
  run: string | null;
  tickets: Record<string, TicketState>;
  doneInRun: Record<string, string[]>;
  questions: Record<string, Question>;
  answers: Record<string, { choice: string | null; text: string | null }>;
  grants: { need: string; scope: string; allowed: boolean; tickets: string[] }[];
  units: Record<string, string>;
  violations: Violation[];
}

type Data = Record<string, unknown>;

function setting<T>(build: BuildState | undefined, key: string, fallback: T): T {
  const entry = build?.settings[key];
  return entry === undefined ? fallback : (entry.value as T);
}

function rulesFor(acc: Acc, event: FoldEvent, ctx: FoldContext, rafiOwned: boolean): TicketRules | string {
  const build = acc.builds[event.run_id ?? acc.run ?? ""];
  const ref = build?.workflow;
  const workflow = ref
    ? ctx.workflows.find((w) => w.id === ref.id && w.version === ref.version)
    : ctx.workflows.find((w) => w.id === "standard") ?? ctx.workflows[0];
  if (!workflow) return `unknown workflow ${ref ? `${ref.id}@${ref.version}` : "standard"}`;
  return {
    qa: setting(build, "harness.qa", true), fixes: setting(build, "retries.fixes", 3),
    manualChecks: setting(build, "manual_checks", "wait"), rafiOwned, workflow,
  };
}

function ticketTargets(event: FoldEvent): string[] {
  const data = (event.data ?? {}) as Data;
  if (event.type === "tickets.changed") return ((data.items as { ticket: string }[]) ?? []).map((i) => i.ticket);
  // P31: build.reset reaches each ticket it puts back, as tickets.changed's items do.
  if (event.type === "build.reset") return (data.tickets as string[] | undefined) ?? [];
  if (event.type === "progress.imported") {
    const entry = data.entry as { kind: string; key: string };
    return entry.kind === "ticket" ? [entry.key] : [];
  }
  // ticket.added, check.run and recheck.requested name their ticket in the data; the data wins (append keeps
  // the envelope's ticket_id equal to it).
  if (typeof data.ticket === "string") return [data.ticket];
  return event.ticket_id ? [event.ticket_id] : [];
}

const TICKET_TYPES: ReadonlySet<string> = new Set([
  "ticket.added", "ticket.status_set", "ticket.tags_added", "ticket.risk_waiver_recorded", "ticket.started",
  "step.started", "step.failed", "turn.retry", "requirements.written", "builder.reported", "check.run",
  "checks.passed", "checks.failed", "attempt.summary", "facts.snapshot", "verdict.recorded", "fix.granted",
  "waiver.recorded", "recheck.requested", "recheck.recorded", "ticket.blocked", "ticket.unblocked",
  "ticket.dropped", "ticket.reopened", "git.committed", "git.branch_created", "delivery.done", "scan.gap",
  "recording.saved", "recording.removed", "tickets.changed", "progress.imported", "build.reset",
]);

/** The outcomes a step records; the first one after a takeover ends "recovering" (C145). */
const OUTCOMES: ReadonlySet<string> = new Set([
  "requirements.written", "builder.reported", "checks.passed", "checks.failed", "verdict.recorded", "delivery.done",
  "step.failed", "ticket.blocked",
]);

function endRecovering(acc: Acc, event: FoldEvent): void {
  const build = event.run_id ? acc.builds[event.run_id] : undefined;
  if (build?.recovering && OUTCOMES.has(event.type)) acc.builds[event.run_id!] = { ...build, recovering: false };
}

export function isTicketEvent(type: string): boolean {
  return TICKET_TYPES.has(type);
}

function applyTickets(acc: Acc, event: FoldEvent, ctx: FoldContext): void {
  if (!TICKET_TYPES.has(event.type)) return;
  const ids = [...new Set(ticketTargets(event))];
  for (const id of ids) {
    const before = acc.tickets[id] ?? null;
    const rules = rulesFor(acc, event, ctx, before?.rafiOwned ?? false);
    if (typeof rules === "string") return void violation(acc, event, rules);
    try {
      const after = nextTicket(before, { ...event, ticket_id: id }, rules);
      acc.tickets[id] = after;
      if (after.state === "done" && before?.state !== "done" && event.run_id) {
        (acc.doneInRun[event.run_id] ??= []).push(id);
      }
    } catch (error) {
      violation(acc, event, (error as Error).message);
    }
  }
}

function applyBuild(acc: Acc, event: FoldEvent): void {
  if (!event.type.startsWith("build.") || !event.run_id) return;
  const before = acc.builds[event.run_id] ?? initialBuild(event.run_id);
  try {
    acc.builds[event.run_id] = nextBuild(before, event);
    if (event.type === "build.started") acc.run = event.run_id;
  } catch (error) {
    violation(acc, event, (error as Error).message);
  }
}

function applyProject(acc: Acc, event: FoldEvent): void {
  const allTicketsClosed = Object.values(acc.tickets).every((t) => t.state === "done" || t.state === "dropped");
  try {
    acc.project = nextProject(acc.project, event, { allTicketsClosed });
  } catch (error) {
    violation(acc, event, (error as Error).message);
  }
}

function applyRecords(acc: Acc, event: FoldEvent): void {
  const data = (event.data ?? {}) as Data;
  const id = String(data.id ?? "");
  const q = acc.questions[id];
  if (event.type === "question.opened") {
    acc.questions[id] = {
      id, no: Number(data.no), kind: String(data.kind), tickets: data.tickets as string[], text: String(data.text),
      status: "open", openedAt: event.at ?? null,
    };
  } else if (event.type === "question.answered" && q && q.status !== "answered") {
    acc.questions[id] = { ...q, status: "answered" };
    acc.answers[id] = { choice: (data.choice as string | null) ?? null, text: (data.text as string | null) ?? null };
  } else if (event.type === "question.deferred" && q && q.status === "open") {
    acc.questions[id] = { ...q, status: "deferred" };
  } else if (event.type === "question.closed" && q) {
    acc.questions[id] = { ...q, status: "closed" };
  } else if (event.type === "grant.recorded") {
    acc.grants.push({ need: String(data.need), scope: String(data.scope), allowed: Boolean(data.allowed),
      tickets: data.tickets as string[] });
  } else if (event.type.startsWith("unit.")) {
    acc.units[String(data.unit)] = event.type.slice("unit.".length);
  }
}

function violation(acc: Acc, event: FoldEvent, reason: string): void {
  acc.violations.push({ seq: event.seq ?? 0, type: event.type, reason });
}

export function emptyAcc(ctx: FoldContext): Acc {
  const tickets: Record<string, TicketState> = {};
  for (const def of ctx.definitions ?? []) tickets[def.id] = initialTicket(def.id);
  return { project: initialProject, builds: {}, run: null, tickets, doneInRun: {}, questions: {}, answers: {},
    grants: [], units: {}, violations: [] };
}

/** A copy the transition check can apply trial events to (state values are immutable; containers are copied). */
export function cloneAcc(a: Acc): Acc {
  return { ...a, builds: { ...a.builds }, tickets: { ...a.tickets }, questions: { ...a.questions },
    answers: { ...a.answers }, grants: [...a.grants], units: { ...a.units }, violations: [...a.violations],
    doneInRun: Object.fromEntries(Object.entries(a.doneInRun).map(([k, v]) => [k, [...v]])) };
}

/** Applies one event. Returns the violations it caused (empty when valid). */
export function applyEvent(acc: Acc, event: FoldEvent, ctx: FoldContext): Violation[] {
  if (event.class === "detail" || event.origin === "imported") return [];
  const before = acc.violations.length;
  applyBuild(acc, event);
  applyTickets(acc, event, ctx);
  endRecovering(acc, event);
  applyProject(acc, event);
  applyRecords(acc, event);
  return acc.violations.slice(before);
}

export function fold(events: readonly FoldEvent[], ctx: FoldContext): Folded {
  const acc = emptyAcc(ctx);
  for (const event of events) applyEvent(acc, event, ctx);
  return { ...acc, queue: ctx.definitions ?? [] };
}

export type FoldAcc = Acc;
