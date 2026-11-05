// Milestone: M4
// Item 26 (M4 plan 3.3) and C149: "Pause at this checkpoint" in What next?, the picker's prompts, and Ctrl+C in an
// attached view (Q2).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventsExport } from "../checks/invariants.js";
import { B, on } from "../fakes/script/behaviors.js";
import { tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { writeInterviews } from "../fixtures/interviews.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

const FOUR = [1, 2, 3, 4].map((n) => ({ from: 1, text: `Requirement number ${n} holds.`, check: null }));
const rejecting = () => [on("qa T1 @prepare", B.requirements(FOUR)),
  ...[1, 2, 3, 4].map((n) => on(`qa T1#${n} @review`, B.reject({ [n]: `R${n} not yet` }))),
  ...[2, 3, 4].map((n) => on(`builder T1#${n}`, B.also({ edit: "src/T1.txt", content: `fix ${n}\n` })))];

function setup() {
  const root = tempRoot();
  const project = fOne(root);
  const computer = newComputer(root);
  computer.script.rules.push(...rejecting());
  const rafi = rafiRunner(computer, project);
  const exported = async () => JSON.parse((await rafi("stats export")).out) as EventsExport;
  return { rafi, computer, exported, project };
}

test("C149: Pause at this checkpoint pauses at once with the question open; Ctrl+C then stops", async () => {
  const { rafi, exported } = setup();
  const live = rafi.start("start . --steps 1", { tty: true });
  await live.expect(/What next\?/);
  live.send("5\n");
  await live.expect(/Paused with T1's question open\. `rafi resume` from another shell continues; Ctrl\+C stops\./);
  assert.match((await rafi("status")).output, /: paused;/);
  live.interrupt();
  const r = await live.done();
  assert.equal(r.code, 130, r.output);
  const e = await exported();
  const pause = e.events.filter((x) => x.type === "build.pause_requested");
  assert.deepEqual(pause.map((x) => [x.actor, x.source, x.data.source]), [["user", "terminal", "terminal"]]);
  assert.equal(e.events.filter((x) => x.type === "build.paused").length, 1);
  assert.equal(e.events.filter((x) => x.type === "question.answered").length, 0, "the question stays open");
});

const CRASH_T1 = "2: sent, before any reply (T1, build";

test("one candidate resumes without a question; several without a terminal and without -y exit 1 naming them",
  async () => {
    const one = setup();
    one.computer.script.rules.length = 0;
    assert.ok((await one.rafi("start . --steps 1", { crashAt: CRASH_T1 })).crashed);
    const r = await one.rafi("resume", { tty: true });
    assert.doesNotMatch(r.output, /What should Rafi resume\?/);
    assert.equal(r.code, 0, r.output);
    const two = setup();
    two.computer.script.rules.length = 0;
    assert.ok((await two.rafi("start . --steps 1", { crashAt: CRASH_T1 })).crashed);
    writeInterviews(two.project, [{ id: "plan-q1", workflow: "plan", status: "paused", title: "Plan it",
      updated_at: "2026-11-01T15:00:00.000Z" }]);
    const none = await two.rafi("resume");
    assert.equal(none.code, 1);
    assert.match(none.output, /Plan it/);
    assert.match(none.output, /`rafi resume --run <id>` or `rafi resume --id <id>`/);
  });

test("Continue the paused build? No exits 0 and writes nothing; Yes continues it and follows it", async () => {
  const { rafi, computer, exported } = setup();
  computer.script.rules.length = 0;
  computer.script.rules.push(on("builder T1#1 @build", B.slow(3)));
  const owner = rafi.start("start . --steps 1", { tty: true });
  computer.clock.whenTimer("agent", async () => {
    const run = (await exported()).events.find((x) => x.type === "build.started")!.run_id;
    await rafi(`manager --ask "/pause ${run} T1"`);
  });
  await owner.expect(/Paused at a safe point/);
  const count = (await exported()).events.length;
  const no = await rafi("resume", { tty: true, input: ["2"] });
  assert.match(no.output, /Continue the paused build\?/);
  assert.equal(no.code, 0, no.output);
  assert.equal((await exported()).events.length, count, "No writes nothing");
  const yes = await rafi("resume", { tty: true, input: ["1"] });
  assert.equal(yes.code, 0, yes.output);
  assert.equal((await owner.done()).code, 0);
  const e = await exported();
  assert.equal(e.events.filter((x) => x.type === "build.unpause_requested").length, 1);
  assert.equal(e.events.filter((x) => x.type === "build.unpaused").length, 1);
});

/** An attached terminal B on terminal A's slow build; `presses` Ctrl+Cs in B, then what B and A returned. */
async function attachedCtrlC(presses: number) {
  const s = setup();
  s.computer.script.rules.length = 0;
  s.computer.script.rules.push(on("builder T1#1 @build", B.slow(5)));
  const owner = s.rafi.start("start . --steps 1", { tty: true });
  let viewer: ReturnType<typeof s.rafi.start> | null = null;
  s.computer.clock.whenTimer("agent", async () => {
    viewer = s.rafi.start("resume", { tty: true });
    await viewer.expect(/Following build/);
    for (let i = 0; i < presses; i += 1) viewer.interrupt();
  });
  const a = await owner.done();
  const b = await viewer!.done();
  return { a, b, e: await s.exported() };
}

test("Q2: one Ctrl+C in an attached view stops watching, says a second press stops the build; the build goes on",
  async () => {
    const { a, b, e } = await attachedCtrlC(1);
    assert.equal(b.code, 0, b.output);
    assert.match(b.output, /Stopped watching build \S+; it keeps running\. Press Ctrl\+C again within 3 seconds/);
    assert.match(b.output, /Build \S+ keeps running/);
    assert.equal(a.code, 0, a.output);
    assert.equal(e.events.filter((x) => x.type === "build.stop_requested").length, 0);
    assert.equal(e.events.filter((x) => x.type === "build.finished").length, 1);
  });

test("Q2: a second Ctrl+C within the window stops the build gracefully, saying so at each step", async () => {
  const { a, b, e } = await attachedCtrlC(2);
  assert.equal(b.code, 130, b.output);
  assert.match(b.output, /Stopping build \S+ after its current step/);
  assert.match(b.output, /Build \S+ stopped\./);
  const req = e.events.filter((x) => x.type === "build.stop_requested");
  assert.deepEqual(req.map((x) => x.data), [{ mode: "graceful", source: "ctrl-c" }]);
  assert.deepEqual(e.events.filter((x) => x.type === "build.stopped").map((x) => x.data), [{ cause: "stop" }]);
  assert.equal(a.code, 0, a.output);
});

test("Q3 (a): rafi start over a crashed build starts a new one that redoes the interrupted step first", async () => {
  const { rafi, computer, exported } = setup();
  computer.script.rules.length = 0;
  assert.ok((await rafi("start . --steps 1", { crashAt: CRASH_T1 })).crashed);
  const r = await rafi("start . --steps 1");
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /superseded/);
  const e = await exported();
  const runs = e.events.filter((x) => x.type === "build.started").map((x) => x.run_id);
  assert.equal(runs.length, 2);
  assert.deepEqual(e.events.filter((x) => x.type === "build.owner_lost").map((x) => x.run_id), [runs[0]]);
  const first = e.events.find((x) => x.run_id === runs[1] && x.type === "step.started");
  assert.deepEqual(first?.data, { step: "build", attempt: 1 }, "the interrupted build step comes first");
  assert.match((await rafi("resume")).output, /Nothing to resume\./);
});

test("rafi start while a build is live doesn't start a second one: it points to rafi resume", async () => {
  const { rafi, computer, exported } = setup();
  computer.script.rules.length = 0;
  computer.script.rules.push(on("builder T1#1 @build", B.slow(2)));
  const owner = rafi.start("start . --steps 1", { tty: true });
  let second = null as Awaited<ReturnType<typeof rafi>> | null;
  computer.clock.whenTimer("agent", async () => { second = await rafi("start . --steps 1"); });
  assert.equal((await owner.done()).code, 0);
  assert.equal(second!.code, 1);
  assert.match(second!.output, /already running here.*`rafi resume`/);
  assert.equal((await exported()).events.filter((x) => x.type === "build.started").length, 1);
});

test("ARCH 8.5: rafi start in a terminal while a build is live offers to attach; Cancel starts nothing, Attach " +
  "follows the build", async () => {
  const { rafi, computer, exported } = setup();
  computer.script.rules.length = 0;
  computer.script.rules.push(on("builder T1#1 @build", B.slow(2)));
  const owner = rafi.start("start . --steps 1", { tty: true });
  let declined = null as Awaited<ReturnType<typeof rafi>> | null;
  let attached = null as ReturnType<typeof rafi.start> | null;
  computer.clock.whenTimer("agent", async () => {
    declined = await rafi("start . --steps 1", { tty: true, input: ["2"] });
    attached = rafi.start("start . --steps 1", { tty: true });
    await attached.expect(/Attach to it\?/);
    attached.send("1\n");
    await attached.expect(/Following build/);
  });
  assert.equal((await owner.done()).code, 0);
  const a = await attached!.done();
  assert.equal(declined!.code, 0, declined!.output);
  assert.match(declined!.output, /already running here \(one live build per checkout\)\. Attach to it\?/);
  assert.match(declined!.output, /Nothing was started\./);
  assert.equal(a.code, 0, a.output);
  assert.match(a.output, /The build finished/);
  assert.equal((await exported()).events.filter((x) => x.type === "build.started").length, 1);
});
