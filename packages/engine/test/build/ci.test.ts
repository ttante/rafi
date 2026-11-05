// M5 slice 8 (item 32; ARCH 6.10, C213, C234): where `checks.ci_when` puts the CI points, what a ready unit waits
// for, how a suite's failures are sorted, and how the fold opens and closes a point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ciAction, classifySuite } from "../../src/state/ci.js";
import { fold, type FoldEvent } from "../../src/state/fold.js";
import type { BuildState, Folded } from "../../src/state/types.js";
import { standard } from "../../src/workflow/standard.js";

type Over = { units?: Record<string, string>; tickets?: Record<string, string>; ci?: Folded["ci"];
  done?: string[]; owned?: string[] };

function view(o: Over): Folded {
  const tickets = Object.fromEntries(Object.entries(o.tickets ?? {}).map(([id, state]) =>
    [id, { id, state, rafiOwned: (o.owned ?? []).includes(id) }]));
  return { units: o.units ?? {}, tickets, ci: o.ci ?? {}, doneInRun: { r1: o.done ?? [] } } as unknown as Folded;
}
const build = (o: Record<string, unknown> = {}) => ({ run: "r1", settings: Object.fromEntries(Object.entries({
  "checks.test_runner": "fake-test", ...o })
  .map(([k, value]) => [k, { value, source: "project" }])) }) as unknown as BuildState;
const when = (w: string, more: Record<string, unknown> = {}) => build({ "checks.ci_when": w, ...more });

test("end-of-build (the default): one full point for every ready unit once the scope is done", () => {
  const v = view({ units: { U1: "ready", U2: "ready" } });
  assert.deepEqual(ciAction(v, build(), true), { kind: "ci", key: "build", units: ["U1", "U2"], tests: "full" });
  assert.deepEqual(ciAction(v, build({ "checks.ci_tests": "light" }), true),
    { kind: "ci", key: "build", units: ["U1", "U2"], tests: "light" });
});

test("end-of-build before the scope is done: a ready unit delivers, or waits with ci_blocks_merge", () => {
  const v = view({ units: { U1: "ready" } });
  assert.deepEqual(ciAction(v, build(), false), { kind: "deliver-unit", unit: "U1" });
  assert.equal(ciAction(v, build({ "checks.ci_blocks_merge": true }), false), null);
});

test("each-pr: a point per ready unit, then its delivery once the point is closed", () => {
  const v = view({ units: { U1: "ready" } });
  assert.deepEqual(ciAction(v, when("each-pr"), false), { kind: "ci", key: "U1", units: ["U1"], tests: "full" });
  const closed = view({ units: { U1: "ready" }, ci: { "r1|U1": { fix: null, closed: true } } });
  assert.deepEqual(ciAction(closed, when("each-pr"), false), { kind: "deliver-unit", unit: "U1" });
});

test("light-each-pr-full-end: light per unit while the scope runs, full at the end", () => {
  const v = view({ units: { U1: "ready" } });
  assert.deepEqual(ciAction(v, when("light-each-pr-full-end"), false),
    { kind: "ci", key: "U1", units: ["U1"], tests: "light" });
  assert.deepEqual(ciAction(v, when("light-each-pr-full-end"), true),
    { kind: "ci", key: "build", units: ["U1"], tests: "full" });
});

test("each-ticket: a point for each ticket done in this run (never a rafi-owned one), before any delivery", () => {
  const v = view({ units: { U1: "ready" }, tickets: { T1: "done", FIX1: "done" }, done: ["T1", "FIX1"],
    owned: ["FIX1"] });
  assert.deepEqual(ciAction(v, when("each-ticket"), false), { kind: "ci", key: "T1", units: [], tests: "full" });
  const closed = view({ units: { U1: "ready" }, tickets: { T1: "done" }, done: ["T1"],
    ci: { "r1|T1": { fix: null, closed: true } } });
  assert.deepEqual(ciAction(closed, when("each-ticket"), false), { kind: "deliver-unit", unit: "U1" });
});

test("a point with its fix ticket open holds every delivery; once the fix ticket is done or blocked, it runs again",
  () => {
    const fixing = (state: string) => view({ units: { U1: "ready" }, tickets: { "FIX-1": state }, owned: ["FIX-1"],
      ci: { "r1|build": { fix: "FIX-1", closed: false } } });
    assert.equal(ciAction(fixing("queued"), build(), true), null);
    assert.equal(ciAction(fixing("building"), build(), true), null);
    for (const s of ["done", "blocked"]) {
      assert.deepEqual(ciAction(fixing(s), build(), true), { kind: "ci", key: "build", units: ["U1"],
        tests: "full" }, s);
    }
  });

test("no CI when you manage git, ci_tests is none or there is no test runner: a ready unit just delivers", () => {
  const v = view({ units: { U1: "ready" } });
  assert.deepEqual(ciAction(v, build({ "git.managed_by": "me" }), true), { kind: "deliver-unit", unit: "U1" });
  assert.deepEqual(ciAction(v, build({ "checks.ci_tests": "none" }), true), { kind: "deliver-unit", unit: "U1" });
  assert.deepEqual(ciAction(v, build({ "checks.test_runner": null }), true), { kind: "deliver-unit", unit: "U1" },
    "no test runner: nothing to run");
  assert.equal(ciAction(view({ units: { U1: "merge_waiting" } }), build(), true), null);
});

test("a suite's failures: failing at the starting commit is already broken; passing on the rerun is flaky", () => {
  assert.deepEqual(classifySuite(["x", "y", "z"], new Set(["y"]), new Set(["x", "y"])),
    { real: ["x"], preexisting: ["y"], flaky: ["z"] });
  assert.deepEqual(classifySuite([], new Set(), new Set()), { real: [], preexisting: [], flaky: [] });
});

test("the fold: a failing suite.run opens its point, the ci fix ticket joins it, ci.result closes it", () => {
  let seq = 0;
  const ev = (type: string, data: unknown, o: Partial<FoldEvent> = {}): FoldEvent =>
    ({ type, data, run_id: "r1", ticket_id: null, seq: ++seq, at: "2026-11-01T14:00:00.000Z", ...o });
  const suite = (outcome: string) => ev("suite.run", { unit: "build", commit: "c", tests: "full", outcome,
    failing: ["suite/x.test"], preexisting: [], flaky: [], reused: [], duration_ms: 1 });
  const opened = fold([suite("failed"), ev("ticket.added", { ticket: "FIX-1", source: "ci", requirements: ["x"],
    hint: "T2", unit: null }, { ticket_id: "FIX-1" })], { workflows: [standard] });
  assert.deepEqual(opened.ci["r1|build"], { fix: "FIX-1", closed: false });
  assert.equal(opened.tickets["FIX-1"]?.rafiOwned, true);
  const closed = fold([suite("failed"), ev("ci.result", { unit: "build", outcome: "passed", fix_ticket: null,
    still_failing: [] })], { workflows: [standard] });
  assert.deepEqual(closed.ci["r1|build"], { fix: null, closed: true });
});
