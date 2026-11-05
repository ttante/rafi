// Item 25 (M5 plan 3.3): every (unit state, event) pair of ARCH 4.3.2, stacks and --stacks N's selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fold } from "../../src/state/fold.js";
import { nextUnit, selectStacks, stacksOf, UNIT_STATES, unitTarget } from "../../src/state/units.js";
import { InvalidTransition } from "../../src/state/types.js";
import { standard } from "../../src/workflow/standard.js";

const events: Record<string, [string, Record<string, unknown>]> = {
  ready: ["unit.ready", { unit: "U1" }],
  merge_waiting: ["unit.merge_waiting", { unit: "U1", until: "2026-11-04T15:00:00.000Z" }],
  delivered: ["unit.delivered", { unit: "U1", how: "merged" }],
  failed: ["unit.failed", { unit: "U1", category: "conflict", message: "x" }],
  conflict: ["ticket.added", { ticket: "FIX-1", source: "conflict", requirements: [], hint: null, unit: "U1" }],
};

// The legal pairs; every other pair of a state and an event is refused. `delivering` is the in-flight part of
// `ready` (no event marks it), so it has no row of its own (C280).
const legal: Record<string, Record<string, string>> = {
  building: { ready: "ready", failed: "failed" },
  ready: { merge_waiting: "merge_waiting", delivered: "delivered", failed: "failed" },
  merge_waiting: { merge_waiting: "merge_waiting", delivered: "delivered", failed: "failed" },
  delivered: {},
  failed: { ready: "ready", failed: "failed", conflict: "building" },
};

test("every (unit state, event) pair: the legal ones move, the rest are refused", () => {
  assert.deepEqual([...UNIT_STATES].sort(), Object.keys(legal).sort());
  for (const state of UNIT_STATES) {
    for (const [name, [type, data]] of Object.entries(events)) {
      const to = legal[state]![name];
      if (to) assert.equal(nextUnit(state, type, data), to, `${state} + ${name}`);
      else assert.throws(() => nextUnit(state, type, data), InvalidTransition, `${state} + ${name}`);
    }
  }
});

test("which unit an event names: unit.* events, and only a conflict fix ticket among ticket.added", () => {
  assert.equal(unitTarget("unit.ready", { unit: "U2" }), "U2");
  assert.equal(unitTarget("ticket.added", events.conflict![1]), "U1");
  assert.equal(unitTarget("ticket.added", { ticket: "FIX-1", source: "ci", unit: null }), null);
  assert.equal(unitTarget("ticket.started", { unit: "U1" }), null);
});

const at = (n: number) => `2026-11-04T14:0${n}:00.000Z`;
const ev = (seq: number, type: string, data: Record<string, unknown>) =>
  ({ seq, type, run_id: "r1", ticket_id: type === "ticket.added" ? String(data.ticket) : null, actor: "engine",
    at: at(seq), data });

test("the fold: an illegal unit event is a violation and keeps the state; a conflict fix ticket makes a failed " +
  "unit building again, and unit.ready retries it", () => {
  const view = fold([ev(1, "unit.ready", { unit: "U1" }), ev(2, "unit.ready", { unit: "U1" }),
    ev(3, "unit.failed", { unit: "U1", category: "conflict", message: "x" })], { workflows: [standard] });
  assert.equal(view.units.U1, "failed");
  assert.deepEqual(view.violations.map((v) => [v.seq, v.type]), [[2, "unit.ready"]]);
  const again = fold([ev(1, "unit.ready", { unit: "U1" }), ev(2, "unit.failed", { unit: "U1", category: "conflict",
    message: "x" }), ev(3, "ticket.added", events.conflict![1]), ev(4, "unit.ready", { unit: "U1" }),
  ev(5, "unit.delivered", { unit: "U1", how: "merged" }), ev(6, "unit.failed", { unit: "U1", category: "rejected",
    message: "y" })], { workflows: [standard] });
  assert.equal(again.units.U1, "delivered");
  assert.deepEqual(again.violations.map((v) => v.seq), [6]);
  assert.equal(again.tickets["FIX-1"]?.rafiOwned, true);
});

const u = (id: string, tickets: string[], o: { depends_on?: string[]; dependency_mode?: "combine" | "wait" |
  "stack" } = {}) => ({ id, tickets, ...o });

test("stacks: a chain joined by dependency_mode stack; any other unit, combine and wait included, is a stack of one",
  () => {
    const units = [u("U1", ["T1", "T2"]), u("U2", ["T3"]), u("U3", ["T4"], { depends_on: ["U2"],
      dependency_mode: "stack" }), u("U4", ["T5"], { depends_on: ["U1"], dependency_mode: "wait" }),
    u("U5", ["T6"], { depends_on: ["U4"], dependency_mode: "combine" })];
    assert.deepEqual(stacksOf(units), [["U1"], ["U2", "U3"], ["U4"], ["U5"]]);
    assert.deepEqual(stacksOf([u("U9", ["T9"])]), [["U9"]], "a stack of one");
  });

test("--stacks N takes the first N stacks with work left, in queue order, skipping skipped tickets", () => {
  const units = [u("U1", ["T1", "T2"]), u("U2", ["T3"]), u("U3", ["T4"], { depends_on: ["U2"],
    dependency_mode: "stack" }), u("U4", ["T5"])];
  const queue = ["T3", "T1", "T2", "T4", "T5"];
  const done = (id: string) => id === "T1" || id === "T2";
  assert.deepEqual(selectStacks(units, 1, { queue, done, skip: [] }), ["T3", "T4"]);
  assert.deepEqual(selectStacks(units, 2, { queue, done, skip: ["T4"] }), ["T3", "T5"]);
  assert.deepEqual(selectStacks(units, 5, { queue, done: () => true, skip: [] }), []);
});
