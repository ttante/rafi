// Milestone: M1
// Harness unit tests: the write fence after a crash (M1 security), the fake clock, the screen model,
// crash naming, and the after-each checks catching a planted forbidden folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { append, openEngine, openLog, redactor } from "@rafi-ai/engine";
import { tempRoot, gitRepo } from "../fixtures/common.js";
import { fakeTerminal, Screen, stripAnsi } from "../fakes/terminal.js";
import { afterEachChecks } from "../harness/after-each.js";
import { harnessDeps } from "../harness/deps.js";
import { FencedWrite } from "../harness/fence.js";
import { HarnessCrash } from "../harness/hooks.js";
import { newComputer } from "../harness/rafi.js";
import { scenarioProblems } from "../harness/scenario.js";

const created = { type: "project.created", actor: "user", data: { app_name: "a", rafi_version: "1" } };
const tags = { type: "ticket.tags_added", ticket_id: "T1", actor: "engine",
  data: { tags: [{ tag: "x", reason: "r" }] } };

test("after a crash, every write, rename, remove, git command and append from that instance throws", async () => {
  const root = tempRoot();
  const project = gitRepo(path.join(root, "p"), {});
  const computer = newComputer(root);
  const first = harnessDeps(computer, fakeTerminal({ tty: false }), { cwd: project, instance: "one" });
  const engine = await openEngine({ projectDir: project, deps: first.deps });
  await engine.append([created]);
  let fired = false;
  first.deps.clock.timer(1000, () => { fired = true; }, "reminder");
  first.hooks.crashAt(1);
  assert.throws(() => first.deps.hooks.crash("4: recorded, before progress write"), HarnessCrash);
  assert.ok(first.fence.dead);
  for (const write of [
    () => first.deps.fs.writeAtomic(path.join(project, "after.txt"), "x"),
    () => first.deps.fs.rename(path.join(project, "README.md"), path.join(project, "moved.md")),
    () => first.deps.fs.remove(path.join(project, "README.md")),
    () => first.deps.fs.mkdir(path.join(project, "new-dir")),
    () => first.deps.git(["commit", "--allow-empty", "-m", "x"], { cwd: project }),
    () => engine.append([tags]),
  ]) {
    await assert.rejects(write, FencedWrite);
  }
  computer.clock.advance(5_000);
  assert.equal(fired, false, "the dead instance's timers never fire");
  first.fence.closeAll();
  const second = harnessDeps(computer, fakeTerminal({ tty: false }), { cwd: project, instance: "two" });
  const reopened = await openEngine({ projectDir: project, deps: second.deps });
  const types: string[] = [];
  for await (const event of reopened.events()) types.push(event.type);
  assert.deepEqual(types, ["project.created"], "a fresh instance reads the log as it was");
  reopened.close();
});

test("a HarnessCrash thrown inside the transaction commits nothing", async () => {
  const root = tempRoot();
  const project = gitRepo(path.join(root, "p"), {});
  const computer = newComputer(root);
  const one = harnessDeps(computer, fakeTerminal({ tty: false }), { cwd: project, instance: "one" });
  await one.deps.fs.mkdir(path.join(project, ".rafi"));
  const log = await openLog(one.deps, path.join(project, ".rafi", "state.sqlite3"));
  one.hooks.crashAt(1);
  const ctx = { log, redact: redactor({}), now: () => one.deps.clock.now(), newId: () => one.deps.random.id(),
    checkTransition: () => { one.deps.hooks.crash("4: recorded, before progress write"); return null; } };
  await assert.rejects(append(ctx, [created]), HarnessCrash);
  await assert.rejects(append({ ...ctx, checkTransition: () => null }, [created]), FencedWrite);
  one.fence.closeAll();
  const two = harnessDeps(computer, fakeTerminal({ tty: false }), { cwd: project, instance: "two" });
  const reopened = await openEngine({ projectDir: project, deps: two.deps });
  let count = 0;
  for await (const _ of reopened.events()) count += 1;
  assert.equal(count, 0, "the crashed transaction wasn't committed");
  assert.equal(await two.deps.processes.isAlive({ instance: "one", host: "h", pid: 1, startedAt: null }), false);
  reopened.close();
});

test("crash naming: each boundary occurrence is numbered", () => {
  const computer = newComputer(tempRoot());
  const one = harnessDeps(computer, fakeTerminal({ tty: false }), { cwd: "/", instance: "one" });
  one.deps.hooks.crash("4: recorded, before progress write (T2, review)");
  one.deps.hooks.crash("4: recorded, before progress write (T2, review)");
  one.hooks.crashAt(3);
  assert.throws(() => one.deps.hooks.crash("1: after turn.intent, before sending"), (e: Error) =>
    e instanceof HarnessCrash && e.occurrence === "1: after turn.intent, before sending (1st)");
  assert.deepEqual(one.hooks.passed.slice(0, 2), ["4: recorded, before progress write (T2, review, 1st)",
    "4: recorded, before progress write (T2, review, 2nd)"]);
});

test("fake clock: auto-advances to timeouts only when idle, never to a reminder", async () => {
  const computer = newComputer(tempRoot());
  const clock = computer.clock.forInstance("one");
  const start = clock.now().toISOString();
  assert.equal(start, "2026-11-01T14:00:00.000Z");
  let reminded = false;
  clock.timer(60_000, () => { reminded = true; }, "reminder");
  await clock.sleep(30 * 60_000, "timeout");
  assert.equal(clock.now().toISOString(), "2026-11-01T14:30:00.000Z", "a 30-minute timeout took no real time");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reminded, false, "the clock never jumps to a reminder on its own");
  computer.clock.advance(31 * 60_000);
  assert.equal(reminded, true, "advance() fires reminders");
  // The deps call ends only when the test says so, and the fire is polled for with a generous deadline, so a
  // loaded machine can't flake either half.
  let busyFired = false;
  let finish = () => undefined as void;
  const busy = computer.clock.track(() => new Promise<void>((resolve) => { finish = resolve; }));
  clock.timer(1000, () => { busyFired = true; }, "backoff");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(busyFired, false, "not idle while a deps call is in flight");
  finish();
  await busy;
  for (let waited = 0; !busyFired && waited < 5000; waited += 10) await new Promise((r) => setTimeout(r, 10));
  assert.equal(busyFired, true);
});

test("screen model: pinned lines, title, scroll region, clack-style cursor moves, pipe mode", () => {
  const screen = new Screen(40, 6);
  screen.write("\u001b]0;rafi · T3 building\u0007");
  screen.write("\u001b[1;4r\u001b[5;1HQuestion 1 pinned\u001b[6;1HQuestion 2\u001b[1;1H");
  for (let i = 1; i <= 6; i += 1) screen.write(`row ${i}\n`);
  screen.write("\u001b[2A\u001b[2K\u001b[32mrewritten\u001b[39m\u001b[?25l");
  assert.equal(screen.title, "rafi · T3 building");
  assert.deepEqual(screen.pinned(), ["Question 1 pinned", "Question 2"]);
  assert.ok(screen.text().includes("rewritten"));
  assert.ok(!screen.text().includes("row 1"), "rows scrolled out of the region");
  const pipe = fakeTerminal({ tty: false });
  pipe.write("\u001b[1mbold\u001b[0m plain\n");
  assert.equal(pipe.screen, null);
  assert.equal(stripAnsi(pipe.out()), "bold plain\n");
});

test("after-each catches a planted forbidden folder, a dropped prompt and an ENV-5 variable", () => {
  const project = tempRoot();
  mkdirSync(path.join(project, ".foreman", "runs"), { recursive: true });
  mkdirSync(path.join(project, ".rafi", "logs"), { recursive: true });
  writeFileSync(path.join(project, ".rafi", "logs", "supervisor-1.log"), "x");
  const problems = afterEachChecks({ projects: [project],
    outputs: ["How should Rafi recover the interrupted build?"], childEnvs: [{ RAFI_BUILD_WORKER_RUN: "r1" }] });
  assert.equal(problems.length, 4, problems.join("\n"));
  assert.deepEqual(afterEachChecks({ projects: [tempRoot()], outputs: ["fine"], childEnvs: [{ PATH: "/bin" }] }), []);
});

test("after-each sees the env of every process rafi starts and what rafi sends agents (S-CLI-2 step 4)", async () => {
  const root = tempRoot();
  const project = gitRepo(path.join(root, "p"), {});
  const claudeQuery = (params: { prompt: AsyncIterable<unknown> }) => Object.assign((async function* () {
    for await (const _message of params.prompt) { /* consumed, as the SDK does */ }
    yield { type: "result" };
  })(), { interrupt: async () => undefined });
  const computer = { ...newComputer(root, "a", { RAFI_BUILD_WORKER_RUN: "r1" }), agents: { claudeQuery } };
  const { deps } = harnessDeps(computer, fakeTerminal({ tty: false }), { cwd: project, instance: "one" });
  await deps.exec(process.execPath, ["-e", ""], { cwd: project });
  await deps.git(["status"], { cwd: project, env: { PATH: process.env.PATH, RAFI_PROBE_ENV: "1" } });
  const prompt = (async function* () { yield { message: "QA report recovery: go on" }; })();
  for await (const _reply of deps.agents.claudeQuery({ prompt, options: { env: { RAFI_REHEARSAL_X: "1" } } })) {
    /* drain */
  }
  assert.deepEqual(scenarioProblems(computer, [project], []).sort(), [
    "RAFI_BUILD_WORKER_RUN set on a process rafi started", "RAFI_PROBE_ENV set on a process rafi started",
    "RAFI_REHEARSAL_X set on a process rafi started", "dropped prompt sent to an agent: /QA report recovery:/",
  ]);
  assert.deepEqual(scenarioProblems(newComputer(root, "b"), [project], []), []);
});
