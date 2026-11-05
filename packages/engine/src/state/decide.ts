// decide(view, live): what the build loop does next, by ARCH 4.5's rules 1–9, in order.
import { ciAction } from "./ci.js";
import type { Action, BuildState, Folded, Liveness, TicketState } from "./types.js";

const ACTIVE: ReadonlySet<string> = new Set(["building", "reviewing", "fixing"]);
const LIVE_BUILD: ReadonlySet<string> = new Set(["running", "waiting"]);
const CLOSED: ReadonlySet<string> = new Set(["done", "dropped"]);

function scopeTickets(view: Folded, build: BuildState): string[] {
  const order = view.queue.map((d) => d.id);
  const listed = build.tickets.length ? build.tickets : order;
  const skip = new Set(build.scope?.skip ?? []);
  return order.filter((id) => listed.includes(id) && !skip.has(id))
    .concat(listed.filter((id) => !order.includes(id) && !skip.has(id)));
}

function doneHere(view: Folded, build: BuildState): string[] {
  return (view.doneInRun[build.run] ?? []).filter((id) => !view.tickets[id]?.rafiOwned);
}

/** Rule 5: --steps N done, the --to-ticket or --ticket target done; `all` is rule 9's job. */
function scopeReached(view: Folded, build: BuildState): boolean {
  const scope = build.scope;
  if (!scope) return false;
  if (scope.kind === "steps") return doneHere(view, build).length >= Number(scope.value);
  if (scope.kind === "to_ticket" || scope.kind === "ticket") {
    return view.tickets[String(scope.value)]?.state === "done";
  }
  return false;
}

function eligible(view: Folded, id: string): boolean {
  const ticket = view.tickets[id];
  if (!ticket || ticket.state !== "queued") return false;
  const def = view.queue.find((d) => d.id === id);
  return (def?.dependsOn ?? []).every((dep) => view.tickets[dep]?.state === "done") &&
    (def?.after ?? []).every((unit) => view.units[unit] === "delivered");
}

function openBlocking(view: Folded, inScope: readonly string[]): string[] {
  return Object.values(view.questions)
    .filter((q) => q.status === "open" && (q.tickets.length === 0 || q.tickets.some((t) => inScope.includes(t))))
    .map((q) => q.id);
}

function rafiOwnedNext(view: Folded): TicketState | undefined {
  return Object.values(view.tickets).find((t) => t.rafiOwned && t.state === "queued");
}

function finish(view: Folded, build: BuildState, inScope: readonly string[], closed: boolean): Action {
  // M5: a delivery unit that failed leaves the build incomplete, whatever its tickets say (4.3.2); so does a
  // conflict fix ticket left unfixed, whose unit was never delivered (C380).
  const unfixed = Object.values(view.tickets).some((t) => t.owned?.source === "conflict" && t.state === "blocked");
  const complete = closed && !unfixed && !Object.values(view.units).includes("failed");
  const done = inScope.filter((id) => view.tickets[id]?.state === "done");
  const left = inScope.filter((id) => !["done", "dropped"].includes(view.tickets[id]?.state ?? ""));
  return { kind: "finish", complete, done: [...new Set([...doneHere(view, build), ...done])], left };
}

/** Rules 6–9: start a ticket, wait on a question, or finish. C144: a narrowed segment works on its ticket only and
 * then finishes with the rest of the scope left (complete: false), for a later `rafi resume`. */
function nextWork(view: Folded, build: BuildState, inScope: readonly string[]): Action {
  const owned = build.narrowed ? undefined : rafiOwnedNext(view);
  if (owned) return { kind: "start-ticket", ticket: owned.id, resumeNode: owned.resumeNode };
  if (build.narrowed) {
    const id = build.narrowed;
    if (eligible(view, id)) return { kind: "start-ticket", ticket: id,
      resumeNode: view.tickets[id]?.resumeNode ?? null };
    const asked = openBlocking(view, [id]);
    if (asked.length) return build.state === "waiting" ? { kind: "hold", why: "waiting on you" }
      : { kind: "wait", questions: asked };
    const allClosed = inScope.every((t) => ["done", "dropped"].includes(view.tickets[t]?.state ?? ""));
    return finish(view, build, inScope, allClosed);
  }
  const next = inScope.find((id) => eligible(view, id));
  if (next) return { kind: "start-ticket", ticket: next, resumeNode: view.tickets[next]?.resumeNode ?? null };
  const questions = openBlocking(view, inScope);
  if (questions.length) {
    return build.state === "waiting" ? { kind: "hold", why: "waiting on you" } : { kind: "wait", questions };
  }
  // C204: nothing else to do while a unit's PR merges: poll it (tickets that wait on it are in scope).
  const merging = Object.entries(view.units).find(([, s]) => s === "merge_waiting")?.[0];
  const queued = inScope.some((id) => view.tickets[id]?.state === "queued");
  if (merging && queued) return { kind: "deliver-unit", unit: merging };
  const allClosed = inScope.every((id) => ["done", "dropped"].includes(view.tickets[id]?.state ?? ""));
  return finish(view, build, inScope, allClosed);
}

export function decide(view: Folded, live: Liveness): Action {
  const build = view.run ? view.builds[view.run] : undefined;
  if (!build) return { kind: "none", why: "no build" };
  if (build.state === "stopping") {
    const now = build.stopMode === "now";
    return { kind: "stop", now, letStepFinish: !now && live.stepInFlight };
  }
  if (build.state === "paused") return { kind: "hold", why: "paused" };
  if (!LIVE_BUILD.has(build.state)) return { kind: "none", why: `build ${build.state}` };
  if (build.pausing && (live.safePoint || build.state === "waiting")) return { kind: "pause" };
  const current = Object.values(view.tickets).find((t) => ACTIVE.has(t.state) && t.node &&
    (!build.narrowed || t.id === build.narrowed));
  if (current) return { kind: "step", ticket: current.id, node: current.node!, redo: current.stepRunning };
  // M5: a ready unit is tested at its CI point, then delivered (rule 4, state/ci.ts); a failed one waits for its
  // question (C203) and isn't retried here.
  const inScope = scopeTickets(view, build);
  const ended = scopeReached(view, build) || inScope.every((id) => CLOSED.has(view.tickets[id]?.state ?? ""));
  const unitAction = ciAction(view, build, ended);
  if (unitAction) return unitAction;
  if (!build.narrowed && scopeReached(view, build) && !rafiOwnedNext(view)) {
    // C203: a delivery question about the scope's units is asked before the build finishes.
    const asked = openBlocking(view, inScope).filter((id) => view.questions[id]?.kind === "delivery");
    if (!asked.length) return finish(view, build, inScope, true);
    return build.state === "waiting" ? { kind: "hold", why: "waiting on you" } : { kind: "wait", questions: asked };
  }
  return nextWork(view, build, inScope);
}
