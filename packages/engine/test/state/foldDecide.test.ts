// fold, decide (rules 1–9 of ARCH 4.5) and the label maps (4.2, 4.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../../src/state/decide.js";
import { fold, type FoldEvent } from "../../src/state/fold.js";
import { guiLabel, trackerStatus } from "../../src/state/labels.js";
import type { Folded, Liveness } from "../../src/state/types.js";
import { standard } from "../../src/workflow/standard.js";
import { workflowDigest } from "../../src/workflow/load.js";

const ctx = { workflows: [standard], definitions: [
  { id: "T1", dependsOn: [] }, { id: "T2", dependsOn: [] }, { id: "T3", dependsOn: ["T2"] },
] };
const between: Liveness = { safePoint: true, stepInFlight: false };
let seq = 0;
const ev = (type: string, data: unknown, o: Partial<FoldEvent> = {}): FoldEvent =>
  ({ type, data, run_id: "r1", ticket_id: null, seq: ++seq, at: "2026-11-01T14:00:00.000Z", ...o });
const t = (id: string) => ({ ticket_id: id });

function started(scope: unknown = { kind: "all", value: null, skip: [] }): FoldEvent[] {
  return [
    ev("project.created", { app_name: "a", rafi_version: "1" }, { run_id: null }),
    ev("tickets.populated", { plan_rev: 1, added: ["T1", "T2", "T3"], retired: [], group: null }, { run_id: null }),
    ev("build.started", { workflow: { id: "standard", version: 1, digest: workflowDigest(standard) }, scope,
      tickets: ["T1", "T2", "T3"], settings: {}, engine_version: "1", argv: [] }),
  ];
}
const delivered = { unit: null, validation: { result: "passed", runs: [], unverified: [] } };
const deliverAll = (id: string): FoldEvent[] => [
  ev("ticket.started", { resume_step: null }, t(id)),
  ev("requirements.written", { path: "p", fp: "f", depth: "s", depth_raised_from: null, count: 1, person_only: [] },
    t(id)),
  ev("builder.reported", { kind: "done", summary: "s", runs: [], block: null, question: null }, t(id)),
  ev("checks.passed", { runs: [], reused: [] }, t(id)),
  ev("verdict.recorded", { attempt: 1, results: [], rejected: false, unverified: [], signature: "s",
    circling: false }, t(id)),
  ev("delivery.done", delivered, t(id)),
];

test("fold skips detail and imported events, and reports an invalid pair without throwing", () => {
  const events = [...started(), ev("delivery.done", delivered, t("T1")),
    ev("ticket.started", { resume_step: null }, { ...t("T2"), class: "detail" }),
    ev("ticket.started", { resume_step: null }, { ...t("T1"), origin: "imported" })];
  const view = fold(events, ctx);
  assert.equal(view.tickets.T1?.state, "queued");
  assert.equal(view.tickets.T2?.state, "queued");
  assert.equal(view.violations.length, 1);
  assert.match(view.violations[0]!.reason, /delivery.done/);
  assert.equal(view.project.state, "building");
});

test("ticket.added folds by the ticket its data names, even without the envelope's ticket_id", () => {
  const added = ev("ticket.added", { ticket: "T9", source: "ci", requirements: ["fix it"], hint: null });
  const view = fold([...started(), added], ctx);
  assert.deepEqual(view.violations, []);
  assert.equal(view.tickets.T9?.state, "queued");
  assert.equal(view.tickets.T9?.rafiOwned, true);
});

test("decide: rule 6 starts the first eligible ticket; rule 3 runs or redoes the current step", () => {
  const view = fold(started(), ctx);
  assert.deepEqual(decide(view, between), { kind: "start-ticket", ticket: "T1", resumeNode: null });
  const running = fold([...started(), ev("ticket.started", { resume_step: null }, t("T1")),
    ev("step.started", { step: "prepare", attempt: 1 }, t("T1"))], ctx);
  assert.deepEqual(decide(running, between), { kind: "step", ticket: "T1", node: "prepare", redo: true });
});

test("decide: rules 1, 2, 5, 7, 8 and 9", () => {
  const stop = fold([...started(), ev("build.stop_requested", { mode: "graceful", source: "rafi-stop" })], ctx);
  assert.equal(decide(stop, { safePoint: false, stepInFlight: true }).kind, "stop");
  const pause = fold([...started(), ev("build.pause_requested", { source: "manager", boundary: null })], ctx);
  assert.equal(decide(pause, between).kind, "pause");
  const steps = fold([...started({ kind: "steps", value: 1, skip: [] }), ...deliverAll("T1")], ctx);
  assert.deepEqual(decide(steps, between), { kind: "finish", complete: true, done: ["T1"], left: ["T2", "T3"] });
  const asked = [...started(), ...deliverAll("T1"), ev("ticket.blocked", { kind: "held", reason: "r", question: "q1",
    waits: [] }, t("T2")), ev("question.opened", { id: "q1", no: 1, kind: "held", tickets: ["T2"], text: "q",
    options: [], recommended: null, context: null, urgency: "normal", key: null }, { run_id: null })];
  assert.deepEqual(decide(fold(asked, ctx), between), { kind: "wait", questions: ["q1"] });
  const deferred = [...asked, ev("question.deferred", { id: "q1" }, { run_id: null })];
  assert.deepEqual(decide(fold(deferred, ctx), between),
    { kind: "finish", complete: false, done: ["T1"], left: ["T2", "T3"] });
  const all = [...started(), ...deliverAll("T1"), ...deliverAll("T2"), ...deliverAll("T3")];
  assert.deepEqual(decide(fold(all, ctx), between), { kind: "finish", complete: true, done: ["T1", "T2", "T3"],
    left: [] });
});

test("decide: rafi-owned fix tickets come before new tickets (rule 4)", () => {
  const view = fold([...started(), ev("ticket.added", { ticket: "F1", source: "ci", requirements: [], hint: null },
    t("F1"))], ctx);
  assert.equal((decide(view, between) as { ticket: string }).ticket, "F1");
});

test("labels: tracker status for every state, and GUI labels", () => {
  const view: Folded = fold([...started(), ...deliverAll("T1"), ev("ticket.blocked", { kind: "held", reason: "r", question: null, waits: [] }, t("T2"))], ctx);
  assert.equal(trackerStatus(view.tickets.T1!, view), "done");
  assert.equal(trackerStatus(view.tickets.T2!, view), "blocked");
  assert.equal(trackerStatus(view.tickets.T3!, view), "blocked", "a dependency is blocked");
  const fresh = fold(started(), ctx);
  assert.equal(trackerStatus(fresh.tickets.T1!, fresh), "next");
  assert.equal(trackerStatus(fresh.tickets.T2!, fresh), "planned");
  assert.equal(trackerStatus({ ...fresh.tickets.T1!, state: "fixing" }, fresh), "in_progress");
  assert.equal(trackerStatus({ ...fresh.tickets.T1!, state: "dropped", dropped: "obsolete" }, fresh), "obsolete");
  assert.equal(trackerStatus({ ...fresh.tickets.T1!, state: "dropped", dropped: "wont-do" }, fresh), "canceled");
  const alive = { ownerAlive: true, recovering: false };
  assert.equal(guiLabel(fresh.project, fresh, alive), "Building");
  assert.equal(guiLabel(fresh.project, fresh, { ownerAlive: false, recovering: false }), "Failed");
  assert.equal(guiLabel(fresh.project, fresh, { ownerAlive: false, recovering: true }), "Recovering");
  assert.equal(guiLabel({ state: "awaiting-approval", before: null }, fresh, alive), "Awaiting plan approval");
});
