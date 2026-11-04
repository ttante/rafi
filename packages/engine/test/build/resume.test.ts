// Item 19 (M4 plan 3.3, ARCH 8.5, C141, C152): what `rafi resume` does with a build, by its stored state and its
// owner's liveness: attach to a live one, take over a dead or released one (with build.owner_lost when the old owner
// never released), take a detached build's first ownership with no extra events, or say nothing is left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { takeover } from "../../src/build/resume.js";
import { initialBuild } from "../../src/state/build.js";
import type { OwnerLiveness } from "../../src/state/labels.js";
import type { BuildState } from "../../src/state/types.js";

const b = (state: BuildState["state"], extra: Partial<BuildState> = {}): BuildState =>
  ({ ...initialBuild("r1"), state, everOwned: true, ...extra });
const o = { ticket: null, settings: {}, heartbeat: "2026-11-01T14:00:00.000Z" };
const types = (build: BuildState, owner: OwnerLiveness) => {
  const plan = takeover(build, owner, o);
  return plan.kind === "takeover" ? plan.events.map((e) => e.type) : plan.kind;
};

test("the takeover table", () => {
  const rows: [string, BuildState, OwnerLiveness, string | string[]][] = [
    ["running, owner alive", b("running"), "alive", "attach"],
    ["running, not responding", b("running"), "not-responding", "attach"],
    ["paused, owner alive", b("paused"), "alive", "attach"],
    ["running, owner dead", b("running"), "dead", ["build.owner_lost", "build.resumed"]],
    ["paused, owner dead", b("paused"), "dead", ["build.owner_lost", "build.resumed"]],
    ["stopping, owner dead", b("stopping", { stopSource: "ctrl-c" }), "dead", ["build.owner_lost", "build.resumed"]],
    ["waiting, owner released", b("waiting", { ownerReleased: true }), "released", ["build.resumed"]],
    ["waiting, owner dead", b("waiting"), "dead", ["build.owner_lost", "build.resumed"]],
    ["stopped", b("stopped", { cause: "stop", ownerReleased: true }), "released", ["build.resumed"]],
    ["stopped by a crash, already taken", b("stopped", { cause: "crash" }), "dead", ["build.resumed"]],
    ["failed", b("failed", { ownerReleased: true }), "released", ["build.resumed"]],
    ["finished with work left", b("finished", { complete: false, ownerReleased: true }), "released",
      ["build.resumed"]],
    ["never owned (a detached start)", b("running", { everOwned: false }), "none", []],
    ["finished complete", b("finished", { complete: true }), "released", "nothing"],
    ["reset", b("stopped", { cause: "reset" }), "released", "nothing"],
  ];
  const failures = rows.filter(([, build, owner, want]) => JSON.stringify(types(build, owner)) !==
    JSON.stringify(want)).map(([name, build, owner, want]) => `${name}: want ${JSON.stringify(want)}, got ` +
    JSON.stringify(types(build, owner)));
  assert.deepEqual(failures, []);
});

test("owner_lost carries the last heartbeat; resumed carries the state, the narrowed ticket and the overrides", () => {
  const settings = { "agent.runtime": { value: "claude", source: "flag" } };
  const plan = takeover(b("running"), "dead", { ticket: "T3", settings, heartbeat: "2026-11-01T14:02:00.000Z" });
  assert.equal(plan.kind, "takeover");
  const [lost, resumed] = (plan as { events: { type: string; data: unknown }[] }).events;
  assert.deepEqual(lost!.data, { last_heartbeat_at: "2026-11-01T14:02:00.000Z" });
  assert.deepEqual(resumed!.data, { from_state: "running", ticket: "T3", settings });
  const done = takeover(b("finished", { complete: true }), "released", o);
  assert.deepEqual(done, { kind: "nothing", why: "Nothing to resume." });
});
