// Delivery units (ARCH 4.3.2; M5 plan item 25): the unit's transition function, stacks and `--stacks N`'s
// selection. Pure. A unit with no event yet is `building` (some of its tickets aren't done); `delivering` is the
// in-flight part of `ready` (no event marks it), so it has no state of its own (C280).
import { InvalidTransition } from "./types.js";

export type UnitState = "building" | "ready" | "merge_waiting" | "delivered" | "failed";
export const UNIT_STATES: readonly UnitState[] = ["building", "ready", "merge_waiting", "delivered", "failed"];

const NEXT: Readonly<Record<string, Partial<Record<UnitState, UnitState>>>> = {
  // Every ticket done; or a failed unit retried (transient, or its conflict fix ticket done).
  "unit.ready": { building: "ready", failed: "ready" },
  // Waiting for a PR to auto-merge; "Keep waiting" after a timeout waits again.
  "unit.merge_waiting": { ready: "merge_waiting", merge_waiting: "merge_waiting" },
  "unit.delivered": { ready: "delivered", merge_waiting: "delivered" },
  // A ticket's step can fail on the unit's git (its worktree, its commit) while the unit is building.
  "unit.failed": { building: "failed", ready: "failed", merge_waiting: "failed", failed: "failed" },
  // "Builder resolves the conflict" (C237, P50): the unit is building again until its fix ticket is done.
  "ticket.added": { failed: "building" },
};

/** The unit an event moves: `unit.*`'s `unit`, or a conflict fix ticket's; null for anything else. */
export function unitTarget(type: string, data: Record<string, unknown>): string | null {
  if (type.startsWith("unit.")) return typeof data.unit === "string" ? data.unit : null;
  if (type === "ticket.added" && data.source === "conflict" && typeof data.unit === "string") return data.unit;
  return null;
}

/** The unit's next state; throws InvalidTransition for a pair 4.3.2 has no rule for. */
export function nextUnit(state: UnitState, type: string, _data: Record<string, unknown>): UnitState {
  const to = NEXT[type]?.[state];
  if (!to) throw new InvalidTransition(`unit ${state}`, type);
  return to;
}

export interface StackUnit {
  readonly id: string;
  readonly tickets: readonly string[];
  readonly depends_on?: readonly string[];
  readonly dependency_mode?: "combine" | "wait" | "stack";
}

/** C189: chains of units joined by `depends_on` where the dependent has `dependency_mode: stack`; any other unit
 * is a stack of one. Each stack lists its unit ids, root first. */
export function stacksOf(units: readonly StackUnit[]): string[][] {
  const parent = (u: StackUnit) => (u.dependency_mode === "stack" ? u.depends_on?.[0] : undefined);
  return units.filter((u) => !parent(u) || !units.some((x) => x.id === parent(u))).map((root) => {
    const chain = [root.id];
    for (let next = units.find((u) => parent(u) === root.id); next;
      next = units.find((u) => parent(u) === chain.at(-1))) chain.push(next.id);
    return chain;
  });
}

/** `--stacks N`: the tickets of the first N stacks with work left (a ticket not done and not skipped), in queue
 * order, skipped tickets left out. */
export function selectStacks(units: readonly StackUnit[], n: number,
  o: { queue: readonly string[]; done: (id: string) => boolean; skip: readonly string[] }): string[] {
  const ticketsOf = (ids: readonly string[]) => ids.flatMap((id) => units.find((u) => u.id === id)?.tickets ?? []);
  const open = stacksOf(units).map(ticketsOf).filter((s) => s.some((id) => !o.done(id) && !o.skip.includes(id)));
  return open.slice(0, n).flat().filter((id) => !o.skip.includes(id))
    .sort((a, b) => o.queue.indexOf(a) - o.queue.indexOf(b));
}

/** PRM-76: units with some tickets done and some still to do (done and dropped count as finished), with how many
 * remain. */
export function unfinishedUnits(units: readonly StackUnit[], state: (id: string) => string | undefined):
  { id: string; remaining: string[] }[] {
  const closed = (id: string) => ["done", "dropped"].includes(state(id) ?? "");
  return units.map((u) => ({ id: u.id, remaining: u.tickets.filter((t) => !closed(t)) }))
    .filter((u) => u.remaining.length && u.remaining.length < (units.find((x) => x.id === u.id)?.tickets.length ?? 0));
}
