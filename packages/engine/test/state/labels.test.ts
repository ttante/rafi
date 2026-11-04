// Item 16 (M4 plan 3.3, C134, C145): the outcome rafi status, stats show and the picker show for a build, from the
// fold plus the owner's liveness (ARCH 4.3's shown-outcome table and 4.3.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialBuild } from "../../src/state/build.js";
import { shownOutcome, type OwnerLiveness } from "../../src/state/labels.js";
import type { BuildState } from "../../src/state/types.js";

const b = (state: BuildState["state"], extra: Partial<BuildState> = {}): BuildState =>
  ({ ...initialBuild("r1"), state, ...extra });
const at = { since: "2026-11-01T14:05:00.000Z", heartbeat: "2026-11-01T14:03:00.000Z" };
const owners: OwnerLiveness[] = ["alive", "dead", "not-responding", "released", "none"];

const rows: [string, BuildState, Partial<Record<OwnerLiveness, string>>][] = [
  ["running", b("running"), { alive: "running", dead: "crashed", "not-responding": "not responding since 14:03",
    released: "crashed", none: "crashed" }],
  ["running, pausing", b("running", { pausing: true }), { alive: "pausing", dead: "crashed" }],
  ["waiting", b("waiting"), { alive: "waiting on you since 14:05", dead: "crashed",
    released: "waiting on you since 14:05" }],
  ["paused", b("paused"), { alive: "paused", dead: "crashed", "not-responding": "not responding since 14:03" }],
  ["stopping", b("stopping", { stopMode: "graceful" }), { alive: "stopping", dead: "crashed" }],
  ["stopped stop", b("stopped", { cause: "stop" }), { alive: "stopped", dead: "stopped", released: "stopped" }],
  ["stopped cancel", b("stopped", { cause: "cancel" }), { released: "cancelled", dead: "cancelled" }],
  ["stopped ctrl-c", b("stopped", { cause: "ctrl-c" }), { released: "cancelled by Ctrl+C" }],
  ["stopped crash", b("stopped", { cause: "crash" }), { dead: "crashed", released: "crashed" }],
  ["stopped reset", b("stopped", { cause: "reset" }), { dead: "reset", released: "reset" }],
  ["finished complete", b("finished", { complete: true }), { released: "finished" }],
  ["finished with work left", b("finished", { complete: false }), { released: "finished, with work left" }],
  ["failed", b("failed"), { released: "failed", dead: "failed" }],
];

test("every build state × owner liveness × cause shows ARCH 4.3's outcome, never failed for a crash", () => {
  const failures: string[] = [];
  for (const [name, build, want] of rows) {
    for (const owner of owners) {
      const expected = want[owner];
      if (!expected) continue;
      const got = shownOutcome(build, { owner, recovering: false, superseded: false, ...at }).text;
      if (got !== expected) failures.push(`${name} / ${owner}: want "${expected}", got "${got}"`);
    }
  }
  assert.deepEqual(failures, []);
});

test("recovering between owner_lost and the first redone outcome; superseded by a newer build (Q3 a)", () => {
  const live = { owner: "alive" as const, recovering: true, superseded: false, ...at };
  assert.equal(shownOutcome(b("running", { recovering: true }), live).text, "recovering");
  const old = { owner: "dead" as const, recovering: false, superseded: true, ...at };
  assert.equal(shownOutcome(b("running"), old).text, "superseded");
  assert.equal(shownOutcome(b("stopped", { cause: "crash" }), old).text, "superseded");
  assert.equal(shownOutcome(b("stopped", { cause: "reset" }), old).text, "reset", "a reset stays a reset");
  assert.equal(shownOutcome(b("finished", { complete: true }), old).text, "finished");
});

test("the kind names whether rafi resume continues it (the picker, C142)", () => {
  const ctx = (owner: OwnerLiveness) => ({ owner, recovering: false, superseded: false, ...at });
  assert.equal(shownOutcome(b("running"), ctx("dead")).resumable, true);
  assert.equal(shownOutcome(b("stopped", { cause: "reset" }), ctx("released")).resumable, false);
  assert.equal(shownOutcome(b("finished", { complete: true }), ctx("released")).resumable, false);
  assert.equal(shownOutcome(b("finished", { complete: false }), ctx("released")).resumable, true);
  assert.equal(shownOutcome(b("running"), { ...ctx("dead"), superseded: true }).resumable, false);
});
