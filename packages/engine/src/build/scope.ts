// A build's scope (ARCH 2.2 `build/scope.ts`; M5 plan C188–C192): from the flags or PRM-70's answers, with
// FLAG-ST-R3's one stopping point, `--skip` by ticket or unit id, PRM-77 for `--ticket`, the stale-waiver check for
// done tickets a `--to-ticket` scope names (C107), and scope approval (PRM-71, C191). Everything here happens
// before the first agent turn; a refusal is one line and an exit code, with nothing written.
import type { Settings } from "rafi-spec/v1";
import { selectStacks, unfinishedUnits } from "../state/units.js";
import type { Engine } from "../api/engine.js";
import { staleWaiver } from "../ask/blocked.js";
import type { NewEvent } from "../log/types.js";
import { approvalEvents, approvalFor } from "../plan/approval.js";
import type { Prepared, RunUI } from "./run.js";

export interface ScopeFlags {
  readonly steps?: number;
  readonly ticket?: string;
  readonly toTicket?: string;
  readonly stacks?: number;
  readonly skip?: readonly string[];
}

export type ScopeChoice = { kind: "steps" | "stacks"; value: number } | { kind: "to_ticket"; value: string };

/** The terminal side of a start's questions; each is null when there's no answer. */
export interface ScopeUI {
  /** PRM-70: "Build tickets or complete delivery stacks?", then the count or the ticket. */
  chooseScope?(queue: readonly { id: string; title: string }[]): Promise<ScopeChoice | null>;
  /** PRM-71: "How does this plan look?"; `changed` when an approved scope changed materially. */
  approvePlan?(changed: boolean): Promise<"proceed" | "feedback" | "cancel" | null>;
  /** PRM-77: "Start eligible dependency <id>: <title> instead?" or "Start <id> anyway?"; PRM-76 with `no`. */
  confirm?(text: string, yes: string, no?: string): Promise<boolean | null>;
}

export interface Chosen {
  readonly scope: { kind: string; value: number | string | null; skip: string[] };
  readonly tickets: string[];
  readonly events: NewEvent[];
  readonly waiver?: () => Promise<void>;
}

export const NO_SCOPE = "Say where the build stops: --steps <n> tickets, --stacks <n> complete delivery stacks, " +
  "or --to-ticket <id>.";

type Out = Chosen | number;

async function scopeFlags(o: ScopeFlags & { tty: boolean; autoApprove?: boolean }, queue: { id: string;
  title: string }[], ui: RunUI & ScopeUI): Promise<ScopeFlags | number> {
  const stops = [["--steps", o.steps], ["--to-ticket", o.toTicket], ["--stacks", o.stacks]].filter(([, v]) =>
    v !== undefined).map(([name]) => String(name));
  if (stops.length > 1) {
    ui.line(`${stops.join(" and ")} each set where the build stops; use one (FLAG-ST-R3).`);
    return 1;
  }
  if (o.ticket && (o.toTicket !== undefined || o.stacks !== undefined)) {
    ui.line(`--ticket builds one ticket; it can't be combined with ${stops[0]}.`);
    return 1;
  }
  if (stops.length || o.ticket) return o;
  if (!o.tty || o.autoApprove || !ui.chooseScope) { ui.line(NO_SCOPE); return 1; }
  const picked = await ui.chooseScope(queue);
  if (!picked) { ui.line("No stopping point chosen; nothing was started."); return 1; }
  if (picked.kind === "to_ticket") return { ...o, toTicket: picked.value };
  return picked.kind === "steps" ? { ...o, steps: picked.value } : { ...o, stacks: picked.value };
}

/** C192 (PRM-77): `--ticket X` waiting on a dependency, or not the next eligible ticket. */
async function ticketChoice(engine: Engine, p: Prepared, id: string, tty: boolean, ui: RunUI & ScopeUI):
  Promise<string | number> {
  const view = engine.fold(p.tickets.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
  const isDone = (t: string) => view.tickets[t]?.state === "done";
  const ready = (t: string) => view.tickets[t]?.state === "queued" && (view.queue.find((d) => d.id === t)?.dependsOn
    ?? []).every(isDone);
  const waiting = (view.queue.find((d) => d.id === id)?.dependsOn ?? []).filter((d) => !isDone(d));
  if (waiting.length) {
    const dep = waiting.find(ready);
    const title = p.tickets.tickets.find((t) => t.id === dep)?.title ?? "";
    if (dep && tty && ui.confirm) {
      const yes = await ui.confirm(`Start eligible dependency ${dep}: ${title} instead?`, `Start ${dep}`);
      if (yes) return dep;
      if (yes === false) { ui.line("Nothing was started."); return 0; }
      return 1;
    }
    ui.line(`${id} needs ${waiting.join(", ")}${dep ? `; start ${dep} first (rafi start . --ticket ${dep})` : ""}.`);
    return 1;
  }
  const next = view.queue.map((d) => d.id).find(ready);
  if (tty && ui.confirm && next && next !== id && ready(id)) {
    const yes = await ui.confirm(`Start ${id} anyway? (${next} is next in the queue.)`, `Start ${id}`);
    if (!yes) { ui.line("Nothing was started."); return yes === false ? 0 : 1; }
  }
  return id;
}

function skipped(p: Prepared, ids: readonly string[], ui: RunUI): string[] | number {
  const out: string[] = [];
  for (const id of ids) {
    const unit = p.tickets.units.find((u) => u.id === id);
    if (unit) out.push(...unit.tickets);
    else if (p.tickets.tickets.some((t) => t.id === id)) out.push(id);
    else { ui.line(`--skip ${id}: there's no ticket or delivery unit ${id}.`); return 1; }
  }
  return [...new Set(out)].sort();
}

/** The scope, its tickets and the approval events to write with `build.started`, or an exit code. */
export async function chooseScope(engine: Engine, o: ScopeFlags & { tty: boolean; autoApprove?: boolean },
  p: Prepared, settings: Settings, ui: RunUI & ScopeUI, run: string): Promise<Out> {
  const queue = engine.fold(p.tickets.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on }))).queue
    .map((d) => ({ id: d.id, title: p.tickets.tickets.find((t) => t.id === d.id)?.title ?? "" }));
  const flags = await scopeFlags(o, queue, ui);
  if (typeof flags === "number") return flags;
  const skip = skipped(p, flags.skip ?? [], ui);
  if (typeof skip === "number") return skip;
  let tickets: string[] = [];
  let scope: Chosen["scope"];
  if (flags.ticket) {
    const id = await ticketChoice(engine, p, flags.ticket, o.tty, ui);
    if (typeof id === "number") return id;
    tickets = [id];
    scope = flags.steps ? { kind: "steps", value: flags.steps, skip } : { kind: "ticket", value: id, skip };
  } else if (flags.toTicket !== undefined) {
    const at = queue.findIndex((t) => t.id === flags.toTicket);
    if (at < 0) { ui.line(`--to-ticket: there's no ticket ${flags.toTicket}.`); return 1; }
    tickets = queue.slice(0, at + 1).map((t) => t.id).filter((id) => !skip.includes(id));
    scope = { kind: "to_ticket", value: flags.toTicket, skip };
  } else if (flags.stacks !== undefined) {
    const view = engine.fold(p.tickets.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
    tickets = selectStacks(p.tickets.units, flags.stacks, { queue: queue.map((t) => t.id), skip,
      done: (id) => view.tickets[id]?.state === "done" });
    scope = { kind: "stacks", value: flags.stacks, skip };
  } else {
    // PRM-76 (C192): in a terminal, a half-done unit asks Resume or Skip for this run; otherwise it resumes.
    const view = engine.fold(p.tickets.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
    const half = unfinishedUnits(p.tickets.units, (id) => view.tickets[id]?.state)
      .find((u) => u.remaining.some((t) => !skip.includes(t)));
    if (half && o.tty && !o.autoApprove && ui.confirm) {
      const resume = await ui.confirm(`Resume unfinished delivery unit ${half.id} (${half.remaining.length} ` +
        "remaining)?", "Resume", "Skip for this run");
      if (resume === null) return 1;
      if (!resume) skip.push(...half.remaining.filter((t) => !skip.includes(t)));
    }
    scope = flags.steps ? { kind: "steps", value: flags.steps, skip } : { kind: "all", value: null, skip };
  }
  const events = await approve(engine, o, p, settings, ui, run);
  if (typeof events === "number") return events;
  const recheck = flags.ticket ? tickets : scope.kind === "to_ticket" ? tickets : [];
  const waiver = recheck.length ? async () => {
    for (const id of recheck) await staleWaiver(engine, engine.deps, run, id, (text) => ui.line(text));
  } : undefined;
  return { scope, tickets, events, waiver };
}

/** C191: PRM-71 for a new or materially changed scope; auto-approve answers it; without either, exit 1. */
async function approve(engine: Engine, o: { tty: boolean; autoApprove?: boolean }, p: Prepared, settings: Settings,
  ui: RunUI & ScopeUI, run: string): Promise<NewEvent[] | number> {
  const docs = String(settings["docs.root"]?.value ?? "docs");
  const a = await approvalFor(engine, docs, p.tickets.tickets);
  if (a.kind === "none" || a.kind === "approved") return [];
  if (a.kind === "carried") return approvalEvents(engine, run, a.key, "carried");
  if (o.autoApprove || settings["approvals.mode"]?.value === "auto") return approvalEvents(engine, run, a.key,
    "auto-approve");
  if (!o.tty || !ui.approvePlan) {
    ui.line(`The plan's scope ${a.changed ? "changed" : "is new"} and needs your approval; run rafi start in a ` +
      "terminal, or pass --auto-approve.");
    return 1;
  }
  for (;;) {
    const answer = await ui.approvePlan(a.changed);
    if (answer === "proceed") return approvalEvents(engine, run, a.key, "user");
    if (answer === "feedback") {
      ui.line("\"Give feedback\" isn't in the new engine yet (milestone M8).");
      continue;
    }
    if (answer === "cancel") { ui.line("Cancelled. Nothing was started."); return 0; }
    return 1;
  }
}
