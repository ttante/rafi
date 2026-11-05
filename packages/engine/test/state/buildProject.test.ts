// Every (state and flags, event) pair for the build (ARCH 4.3) and every (state, event) pair for the project (4.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEventData, eventRegistry } from "rafi-spec/v1";
import { initialBuild, nextBuild } from "../../src/state/build.js";
import { isProjectEvent, nextProject } from "../../src/state/project.js";
import { InvalidTransition, type BuildState, type ProjectState } from "../../src/state/types.js";

const wf = { id: "standard", version: 1, digest: "d" };
const buildVariants: Record<string, [string, unknown]> = {
  started: ["build.started", { workflow: wf, scope: { kind: "all", value: null, skip: [] }, tickets: [], settings: {},
    engine_version: "1", argv: [] }],
  acquired: ["build.owner_acquired", { instance: "i", host: "h", pid: 1 }],
  released: ["build.owner_released", { reason: "waiting" }],
  lost: ["build.owner_lost", { last_heartbeat_at: "2026-11-01T14:00:00.000Z" }],
  resumed: ["build.resumed", { from_state: "x", ticket: null, settings: {} }],
  "resumed narrowed": ["build.resumed", { from_state: "x", ticket: "T3", settings: { "agent.model": { value: "m2",
    source: "flag" } } }],
  "reset build": ["build.reset", { scope: "build", action: "restart-current", cleanup: "handled", tickets: ["T1"],
    archive_branch: null }],
  "reset everything": ["build.reset", { scope: "everything", action: null, cleanup: null, tickets: ["T1"],
    archive_branch: null }],
  waiting: ["build.waiting", { questions: [] }],
  unwaiting: ["build.unwaiting", { questions: [] }],
  "pause requested": ["build.pause_requested", { source: "manager", boundary: null }],
  paused: ["build.paused", { source: "manager", boundary: null }],
  "unpause requested": ["build.unpause_requested", { source: "rafi-stop", boundary: null }],
  unpaused: ["build.unpaused", { source: "engine", boundary: null }],
  "stop graceful": ["build.stop_requested", { mode: "graceful", source: "rafi-stop" }],
  "stop now": ["build.stop_requested", { mode: "now", source: "ctrl-c" }],
  stopped: ["build.stopped", { cause: "stop" }],
  "finished complete": ["build.finished", { complete: true, done: [], left: [] }],
  "finished incomplete": ["build.finished", { complete: false, done: [], left: ["T2"] }],
  failed: ["build.failed", { error: "bug", message: "m" }],
};

const b = (state: BuildState["state"], extra: Partial<BuildState> = {}): BuildState =>
  ({ ...initialBuild("r1"), state, ...extra });
const buildFrom: Record<string, BuildState> = {
  none: b("none"), running: b("running"), "running(pausing)": b("running", { pausing: true }),
  waiting: b("waiting"), "waiting(pausing)": b("waiting", { pausing: true }),
  "waiting(released)": b("waiting", { ownerReleased: true }), paused: b("paused"),
  "paused(unpausing)": b("paused", { unpausing: true }),
  stopping: b("stopping", { stopMode: "graceful", stopSource: "rafi-stop" }),
  "stopping(ctrl-c)": b("stopping", { stopMode: "now", stopSource: "ctrl-c" }),
  stopped: b("stopped", { cause: "stop" }), "stopped(reset)": b("stopped", { cause: "reset" }),
  "finished complete": b("finished", { complete: true }),
  "finished incomplete": b("finished", { complete: false }), failed: b("failed"),
};

// [from names, variant, expected]. Expected is a state, "state(flag)", "stopped:cause", "same" or (unlisted) invalid.
const live = ["running", "running(pausing)", "waiting", "waiting(pausing)", "waiting(released)", "paused",
  "paused(unpausing)", "stopping", "stopping(ctrl-c)", "stopped", "finished complete", "finished incomplete",
  "failed"];
const withReset = [...live, "stopped(reset)"];
const buildRows: [string[], string, string][] = [
  [["none"], "started", "running"],
  [withReset, "acquired", "same"],
  [withReset, "released", "same"],
  [["running", "running(pausing)"], "waiting", "waiting"],
  [["waiting", "waiting(pausing)", "waiting(released)"], "unwaiting", "running"],
  [["running", "waiting", "waiting(released)"], "pause requested", "(pausing)"],
  [["running(pausing)", "waiting(pausing)"], "pause requested", "same"],
  [["running(pausing)", "waiting(pausing)"], "paused", "paused"],
  [["paused", "paused(unpausing)"], "unpause requested", "paused(unpausing)"],
  [["paused", "paused(unpausing)"], "unpaused", "running"],
  [["running", "running(pausing)", "waiting", "waiting(pausing)", "waiting(released)", "paused",
    "paused(unpausing)"], "stop graceful", "stopping"],
  [["running", "running(pausing)", "waiting", "waiting(pausing)", "waiting(released)", "paused",
    "paused(unpausing)", "stopping", "stopping(ctrl-c)"], "stop now", "stopping(now)"],
  [["stopping", "stopping(ctrl-c)"], "stopped", "stopped:stop"],
  [["running", "running(pausing)", "waiting", "waiting(pausing)", "waiting(released)"], "finished complete",
    "finished"],
  [["running", "running(pausing)", "waiting", "waiting(pausing)", "waiting(released)"], "finished incomplete",
    "finished"],
  [["running", "running(pausing)", "waiting", "waiting(pausing)", "waiting(released)", "stopping",
    "stopping(ctrl-c)"], "failed", "failed"],
  [["running", "running(pausing)", "waiting", "waiting(pausing)", "waiting(released)", "paused",
    "paused(unpausing)"], "lost", "stopped:crash"],
  [["stopping"], "lost", "stopped:stop"],
  [["stopping(ctrl-c)"], "lost", "stopped:ctrl-c"],
  [["stopped", "failed", "waiting(released)", "finished incomplete"], "resumed", "running"],
  [["stopped", "failed", "waiting(released)", "finished incomplete"], "resumed narrowed", "running(narrowed)"],
  [["finished complete"], "resumed", "same"],
  [["finished complete"], "resumed narrowed", "same"],
  // P31: a reset ends any build but one already reset; a reset build is never resumed.
  ...["reset build", "reset everything"].map((v) => [live, v, "stopped:reset"] as [string[], string, string]),
];

function buildMatches(got: BuildState, before: BuildState, want: string): boolean {
  // Owner events are liveness only (4.3): ownerReleased and (M4, C152) everOwned may change.
  if (want === "same") {
    return JSON.stringify(got) === JSON.stringify({ ...before, ownerReleased: got.ownerReleased,
      everOwned: got.everOwned });
  }
  if (want === "(pausing)") return got.state === before.state && got.pausing;
  if (want.startsWith("stopped:")) return got.state === "stopped" && got.cause === want.slice(8);
  if (want === "running(narrowed)") {
    return got.state === "running" && got.narrowed === "T3" && got.overrides["agent.model"]?.value === "m2";
  }
  if (want === "stopping(now)") return got.state === "stopping" && got.stopMode === "now";
  if (want === "paused(unpausing)") return got.state === "paused" && got.unpausing;
  const keepsFlag = want === "running" || want === "waiting";
  return got.state === want && (keepsFlag ? got.pausing === before.pausing : !got.pausing);
}

test("every (state and flags, event) pair of the build matches ARCH 4.3", () => {
  const failures: string[] = [];
  for (const [name, before] of Object.entries(buildFrom)) {
    for (const [variant, [type, data]] of Object.entries(buildVariants)) {
      assert.ok(checkEventData(type, 1, data).ok, variant);
      const row = buildRows.filter(([from, v]) => v === variant && from.includes(name)).at(-1);
      const want = row?.[2] ?? "invalid";
      try {
        const got = nextBuild(before, { type, run_id: "r1", data });
        if (want === "invalid" || !buildMatches(got, before, want)) failures.push(`${name} + ${variant}: ${want}`);
      } catch (error) {
        if (!(error instanceof InvalidTransition)) throw error;
        if (want !== "invalid") failures.push(`${name} + ${variant}: want ${want}, got invalid`);
      }
    }
  }
  const buildTypes = [...eventRegistry.keys()].filter((t) => t.startsWith("build."));
  const covered = new Set(Object.values(buildVariants).map(([t]) => t));
  assert.deepEqual(buildTypes.filter((t) => !covered.has(t)), []);
  assert.deepEqual(failures, []);
});

function migrated(state: string) {
  return { from: "0.10.x", files: [], kept: [], dropped: [], state };
}
const projectVariants: Record<string, [string, unknown]> = {
  created: ["project.created", { app_name: "a", rafi_version: "1" }],
  "migrated ready": ["project.migrated", migrated("ready")],
  "migrated ticketing": ["project.migrated", migrated("ticketing")],
  "migrated draft": ["project.migrated", migrated("draft")],
  archived: ["project.archived", {}],
  unarchived: ["project.unarchived", {}],
  "plan started": ["plan.started", { mode: "new", interview_id: null }],
  proposed: ["plan.proposed", { plan_id: "p", revision: 1, digest: "d", path: "x" }],
  "plan failed": ["plan.failed", { reason: "r" }],
  rejected: ["plan.rejected", { feedback: "f" }],
  approved: ["plan.approved", { plan_id: "p", revision: 1, digest: "d", by: "user" }],
  "approved carried": ["plan.approved", { plan_id: "p", revision: 1, digest: "d", by: "carried" }],
  populated: ["tickets.populated", { plan_rev: 1, added: ["T1"], retired: [], group: null }],
  "future accepted": ["future_work.accepted", { id: "f", ticket: "T9" }],
  "ticket added": ["tickets.changed", { by: "user", items: [{ ticket: "T9", field: "added" }], material: true }],
  "ticket edited": ["tickets.changed", { by: "user", items: [{ ticket: "T1", field: "title" }], material: false }],
  "plan changed": ["plan.changed", { from_rev: 1, to_rev: 2, kind: "update", by: "planner", why: "w", items: [],
    applied: true, told: [] }],
  "plan reset": ["plan.reset", { to_rev: 1, tickets: [] }],
  "build started": ["build.started", buildVariants.started![1]],
  "finished complete": ["build.finished", { complete: true, done: [], left: [] }],
  "finished incomplete": ["build.finished", { complete: false, done: [], left: [] }],
  "build stopped": ["build.stopped", { cause: "stop" }],
  "build failed": ["build.failed", { error: "e", message: "m" }],
  "owner lost": ["build.owner_lost", { last_heartbeat_at: "2026-11-01T14:00:00.000Z" }],
  resumed: ["build.resumed", { from_state: "stopped", ticket: null, settings: {} }],
  "reset build": ["build.reset", buildVariants["reset build"]![1]],
  "reset everything": ["build.reset", buildVariants["reset everything"]![1]],
  "released waiting": ["build.owner_released", { reason: "waiting" }],
  "released finished": ["build.owner_released", { reason: "finished" }],
};
const states = ["none", "draft", "planning", "awaiting-approval", "ticketing", "ready", "building", "complete",
  "archived"] as const;
const notArchived = states.filter((s) => s !== "archived" && s !== "none");
const projectRows: [readonly string[], string, string][] = [
  [["none"], "created", "draft"],
  [["none"], "migrated ready", "ready"],
  [["none"], "migrated ticketing", "ticketing"],
  [["none"], "migrated draft", "draft"],
  [states, "archived", "archived"],
  [["archived"], "unarchived", "ready"],
  [["draft", "ready", "complete"], "plan started", "planning"],
  [["planning"], "proposed", "awaiting-approval"],
  [["planning"], "plan failed", "before"],
  [["awaiting-approval"], "rejected", "planning"],
  [["awaiting-approval"], "approved", "ticketing"],
  [["awaiting-approval"], "approved carried", "ready"],
  [["ticketing", "draft"], "populated", "ready"],
  [["draft"], "future accepted", "ready"],
  // ARCH 4.4 :603 (approved in M5 part 4a-2): accept-future-work in a ready, complete or building project.
  [["ready", "complete", "building"], "future accepted", "same"],
  [["draft", "complete"], "ticket added", "ready"],
  [states.filter((s) => s !== "draft" && s !== "complete"), "ticket added", "same"],
  [states, "ticket edited", "same"],
  [["complete"], "plan changed", "ready"],
  [notArchived, "plan reset", "ticketing"],
  [["ready", "complete"], "build started", "building"],
  [["building"], "finished complete", "complete"],
  [["building"], "finished incomplete", "ready"],
  [["building"], "build stopped", "ready"],
  [["building"], "build failed", "ready"],
  // P31: build.reset is a build end; "everything" also takes complete back to ready (4.4).
  [["building"], "reset build", "ready"],
  [["building", "complete"], "reset everything", "ready"],
  // C168 (M4): a build that already ended left the project ready, so a later end (rafi stop on a waiting build
  // whose owner released, a reset) changes nothing; a reset of a finished build leaves complete as it is.
  [["ready"], "build stopped", "same"],
  [["ready"], "build failed", "same"],
  [["ready"], "reset build", "same"],
  [["ready", "complete"], "reset build", "same"],
  [["ready"], "reset everything", "ready"],
  // C168: the takeover's owner_lost is the crashed build's end (a crash keeps building until then); a resume makes
  // the project building again, as a start does.
  [["building"], "owner lost", "ready"],
  [states.filter((s) => s !== "building"), "owner lost", "same"],
  [["ready"], "resumed", "building"],
  [states.filter((s) => s !== "ready"), "resumed", "same"],
  [["building"], "released waiting", "ready"],
  [states.filter((s) => s !== "building"), "released waiting", "same"],
  [states, "released finished", "same"],
];

test("every (state, event) pair of the project matches ARCH 4.4", () => {
  const failures: string[] = [];
  for (const state of states) {
    const before: ProjectState = { state, before: state === "planning" ? "ready" : null };
    for (const [variant, [type, data]] of Object.entries(projectVariants)) {
      assert.ok(checkEventData(type, 1, data).ok, variant);
      const want = projectRows.filter(([from, v]) => v === variant && from.includes(state)).at(-1)?.[2] ?? "invalid";
      const expectState = want === "before" ? "ready" : want === "same" ? state : want;
      try {
        const got = nextProject(before, { type, data }, { allTicketsClosed: true });
        if (want === "invalid" || got.state !== expectState) failures.push(`${state} + ${variant}: want ${want}`);
      } catch (error) {
        if (!(error instanceof InvalidTransition)) throw error;
        if (want !== "invalid") failures.push(`${state} + ${variant}: want ${want}, got invalid`);
      }
    }
  }
  assert.deepEqual(failures, []);
  const open = nextProject({ state: "building", before: null }, { type: "build.finished",
    data: projectVariants["finished complete"]![1] }, { allTicketsClosed: false });
  assert.equal(open.state, "ready", "complete needs every ticket done or dropped");
});

test("ARCH 4.4's P19 row: — (no project yet) + project.created plus tickets.changed (added) → ready", () => {
  const none: ProjectState = { state: "none", before: null };
  const created = nextProject(none, { type: "project.created", data: projectVariants.created![1] },
    { allTicketsClosed: false });
  const added = nextProject(created, { type: "tickets.changed", data: projectVariants["ticket added"]![1] },
    { allTicketsClosed: false });
  assert.deepEqual([created.state, added.state], ["draft", "ready"]);
  const edited = nextProject(created, { type: "tickets.changed", data: projectVariants["ticket edited"]![1] },
    { allTicketsClosed: false });
  assert.equal(edited.state, "draft", "only added tickets make it ready");
  assert.equal(nextProject(added, { type: "build.started", data: buildVariants.started![1] },
    { allTicketsClosed: false }).state, "building", "and a build can start");
});

test("project pairs cover the registry: every project event has a variant, every other event passes through", () => {
  const covered = new Set(Object.values(projectVariants).map(([t]) => t));
  const types = [...eventRegistry.keys()];
  assert.deepEqual(types.filter((t) => isProjectEvent(t) && !covered.has(t)), []);
  const changed: string[] = [];
  for (const state of states) {
    const before: ProjectState = { state, before: null };
    for (const type of types.filter((t) => !isProjectEvent(t))) {
      const after = nextProject(before, { type, data: {} }, { allTicketsClosed: true });
      if (after !== before) changed.push(`${state}+${type}`);
    }
  }
  assert.deepEqual(changed, []);
});

test("project.migrated names the state it lands in (ARCH 3.4, 4.4)", () => {
  for (const state of ["ready", "ticketing", "draft"]) {
    assert.ok(checkEventData("project.migrated", 1, migrated(state)).ok, state);
  }
  const { state: _omitted, ...without } = migrated("ready");
  assert.equal(checkEventData("project.migrated", 1, without).ok, false, "the state is required");
  assert.equal(checkEventData("project.migrated", 1, migrated("building")).ok, false, "only ready, ticketing or draft");
});
