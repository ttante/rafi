// Milestone: M2
// Item 27 (M2 plan 3.3): the clock fix and whenTimer (C49), rafi.start, the scripted checks runner (fake-test),
// the in-memory endpoint, the F-TESTS-LOCAL and F-HUGE fixtures, and the role happy paths (SCN 2.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mcpHandler, RAFI_TOOLS } from "@rafi-ai/engine/tools";
import { FakeClock } from "../fakes/clock.js";
import { scriptedChecks } from "../fakes/checks.js";
import { memoryServe } from "../fakes/serve.js";
import { happyPath } from "../fakes/script/roles.mjs";
import { git, tempRoot } from "../fixtures/common.js";
import { fHuge } from "../fixtures/f-huge.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { fOne } from "../fixtures/f-one.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

test("auto-advance fires every timer due on the way to an agent timer, in order", async () => {
  const clock = new FakeClock();
  const c = clock.forInstance("a");
  const fired: string[] = [];
  const beat = () => { fired.push(`heartbeat@${(clock.now().getTime() - Date.parse("2026-11-01T14:00:00Z")) / 1000}`);
    c.timer(30_000, beat, "heartbeat"); };
  c.timer(30_000, beat, "heartbeat");
  await c.sleep(100_000, "agent");
  assert.deepEqual(fired, ["heartbeat@30", "heartbeat@60", "heartbeat@90"]);
});

test("whenTimer runs a step when a timer of that kind is armed, before the clock moves to it", async () => {
  const clock = new FakeClock();
  const c = clock.forInstance("a");
  const seen: string[] = [];
  clock.whenTimer("backoff", async () => {
    seen.push(`step at ${clock.now().toISOString()} pending ${clock.pending().map((p) => p.kind).join(",")}`);
  });
  await c.sleep(10_000, "backoff");
  assert.deepEqual(seen, ["step at 2026-11-01T14:00:00.000Z pending backoff"]);
  assert.equal(clock.now().toISOString(), "2026-11-01T14:00:10.000Z");
});

test("rafi.start runs a command in the background; a second instance runs while it does", async () => {
  const root = tempRoot();
  const project = fOne(root);
  const computer = newComputer(root);
  const rafi = rafiRunner(computer, project);
  const handle = rafi.start("--version");
  const second = await rafi("--help");
  assert.equal(second.code, 0);
  const first = await handle.done();
  assert.equal(first.code, 0);
  assert.match(first.out, /1\.0\.0/);
});

function run(checks: ReturnType<typeof scriptedChecks>, cwd: string, cmd: string, args: string[],
  o: { needs?: ("internet" | "local-servers")[]; sandbox?: string[]; signal?: AbortSignal;
    env?: Record<string, string> } = {}) {
  const out: string[] = [];
  return checks.run(cmd, args, { cwd, env: o.env ?? {}, grants: { needs: o.needs ?? [] },
    sandbox: o.sandbox ?? ["sandbox"], onOutput: (t) => out.push(t), signal: o.signal ?? new AbortController().signal })
    .then((r) => ({ ...r, streamed: out.join("") }));
}

test("fake-test: pass, fail(n), per-test JSON, writes, home cache, edits and the network", async () => {
  const root = tempRoot();
  const project = fTestsLocal(root);
  const clock = new FakeClock();
  const checks = scriptedChecks({ clock: clock.forInstance("a"), home: path.join(root, "home"),
    tests: { "t1.test": { outcomes: ["fail(2)", "pass"], writes: ["coverage/"], homeCache: true },
      "t2.test": { outcomes: ["pass"], edits: "src/index.js" }, "t3.test": { outcomes: ["pass"], network: true } } });
  const json = path.join(project, ".rafi", "cache", "run-1.json");
  const env = { npm_config_cache: path.join(project, ".rafi", "cache", "npm") };
  const first = await run(checks, project, "fake-test", ["t1.test", "--json", `--outputFile=${json}`], { env });
  assert.equal(first.code, 1);
  const report = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(report.numFailedTests, 2);
  const failed = report.testResults[0].assertionResults.filter((a: { status: string }) => a.status === "failed");
  assert.equal(failed.length, 2);
  assert.ok(existsSync(path.join(project, "coverage", "lcov.info")), "coverage/ written");
  assert.ok(readdirSync(path.join(project, ".rafi", "cache", "npm")).length > 0, "the cache write went to .rafi/cache");
  assert.equal((await run(checks, project, "fake-test", ["t1.test"], { env })).code, 0, "the second outcome");
  const home = await run(checks, project, "fake-test", ["t1.test"]);
  assert.match(home.output, /EPERM/, "without the cache variable a sandboxed home-cache write is denied");
  const before = readFileSync(path.join(project, "src", "index.js"), "utf8");
  await run(checks, project, "fake-test", ["t2.test"]);
  assert.notEqual(readFileSync(path.join(project, "src", "index.js"), "utf8"), before, "edits(src/index.js)");
  const denied = await run(checks, project, "fake-test", ["t3.test"]);
  assert.equal(denied.code, 1);
  assert.match(denied.output, /EPERM/);
  assert.equal((await run(checks, project, "fake-test", ["t3.test"], { needs: ["internet"] })).code, 0);
  assert.equal((await run(checks, project, "fake-test", ["t3.test"], { sandbox: [] })).code, 0, "no sandbox");
});

test("fake-test: --listTests --findRelatedTests, hang until aborted, slow with output on the fake clock", async () => {
  const root = tempRoot();
  const project = fTestsLocal(root);
  const clock = new FakeClock();
  const checks = scriptedChecks({ clock: clock.forInstance("a"), home: path.join(root, "home"),
    tests: { "t1.test": { outcomes: ["hang"], related: ["src/T1.txt"] }, "t2.test": { outcomes: ["slow(8m)"] } } });
  const related = await run(checks, project, "fake-test", ["--listTests", "--findRelatedTests", "src/T1.txt"]);
  assert.deepEqual(related.output.trim().split("\n"), [path.join(project, "t1.test")]);
  const controller = new AbortController();
  clock.forInstance("a").timer(120_000, () => controller.abort(), "timeout");
  const hung = await run(checks, project, "fake-test", ["t1.test"], { signal: controller.signal });
  assert.equal(hung.aborted, true);
  assert.equal(hung.streamed, "");
  const slowAbort = new AbortController();
  clock.forInstance("a").timer(300_000, () => slowAbort.abort(), "timeout");
  const slow = await run(checks, project, "fake-test", ["t2.test"], { signal: slowAbort.signal });
  assert.equal(slow.aborted, true);
  assert.ok(slow.streamed.split("\n").filter(Boolean).length >= 9, "output all along");
  assert.equal(slow.durationMs, 300_000);
});

test("the scripted sandbox setting: available by default, missing(reason) when set", async () => {
  const clock = new FakeClock();
  const ok = scriptedChecks({ clock: clock.forInstance("a"), home: "/h", tests: {} });
  assert.deepEqual(await ok.sandbox(), { platform: "darwin", sandboxExec: true });
  const missing = scriptedChecks({ clock: clock.forInstance("a"), home: "/h", tests: {}, sandbox: "missing" });
  assert.deepEqual(await missing.sandbox(), { platform: "linux", bwrap: null, bwrapWorks: false });
});

test("the in-memory endpoint serves one handler per session and checks the token", async () => {
  const serve = memoryServe();
  const token = "t".repeat(64);
  const handler = mcpHandler({ token, tools: RAFI_TOOLS, call: async () => ({ text: "run 1", isError: false }) });
  const served = await serve.serve({ host: "127.0.0.1", handler });
  assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const ok = await serve.post(served.url, { authorization: `Bearer ${token}` },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_check", arguments: { command: "x" } } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).result.content[0].text, "run 1");
  assert.equal((await serve.post(served.url, {}, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
  await served.close();
  await assert.rejects(serve.post(served.url, { authorization: `Bearer ${token}` }, { id: 1, method: "ping" }),
    /ECONNREFUSED/);
});

test("F-TESTS-LOCAL: T1–T3, fake-test as the runner, git left to you; F-HUGE: no commit, and 20,000 ignored files",
  () => {
    const root = tempRoot();
    const project = fTestsLocal(root);
    const config = readFileSync(path.join(project, "rafi-config.yaml"), "utf8");
    assert.match(config, /test_runner: fake-test/);
    assert.match(config, /managed_by: me/);
    assert.match(readFileSync(path.join(project, ".tickets", "tickets.yaml"), "utf8"), /id: T3/);
    assert.equal(git(project, ["status", "--porcelain"]), "");
    const empty = fHuge(root, "no-commit");
    assert.throws(() => git(empty, ["rev-parse", "HEAD"]));
    const huge = fHuge(root, "ignored");
    assert.equal(readdirSync(path.join(huge, "big")).length, 20_000);
    assert.equal(git(huge, ["status", "--porcelain"]), "");
  });

test("role happy paths (SCN 2.2): requirements per criterion, the builder's edit and run_check, QA satisfied", () => {
  const root = tempRoot();
  const project = fTestsLocal(root);
  const prepare = happyPath({ role: "qa", ticket: "T1", step: "prepare" }, { cwd: project, message: "" });
  assert.equal(prepare.reply.requirements.length, 1);
  assert.equal(prepare.reply.requirements[0].check, "fake-test t1.test");
  const build = happyPath({ role: "builder", ticket: "T1", step: "build" }, { cwd: project, message: "" });
  assert.deepEqual(build.steps.map((s: Record<string, unknown>) => Object.keys(s)[0]), ["edit", "runCheck"]);
  assert.equal(build.reply.kind, "done");
  const review = happyPath({ role: "qa", ticket: "T1", step: "review" },
    { cwd: project, message: "Rafi's recorded runs:\n- run 1: `fake-test t1.test` passed\nrequirements R1." });
  assert.deepEqual(review.reply.results, [{ req: 1, status: "satisfied", runs: [1], needs: null, note: null }]);
});

type Logged = { type: string; data: Record<string, unknown> };
const logged = async (rafi: ReturnType<typeof rafiRunner>) =>
  (JSON.parse((await rafi("stats export")).out) as { events: Logged[] }).events;

test("P19 (ARCH 4.4): a 1.0 config and tickets with no project yet → ready, recorded by the first command that writes",
  async () => {
    const root = tempRoot();
    const project = fOne(root);
    const rafi = rafiRunner(newComputer(root), project);
    assert.equal((await rafi("start . --steps 1")).code, 0);
    const events = await logged(rafi);
    assert.deepEqual(events.slice(0, 3).map((e) => e.type), ["project.created", "tickets.changed", "build.started"]);
    assert.deepEqual(events[1]!.data.items, [{ ticket: "T1", field: "added" }]);
    assert.equal((await rafi("start . --steps 1")).code, 0);
    assert.equal((await logged(rafi)).filter((e) => e.type === "project.created").length, 1, "only the first time");
  });

test("P19: a 1.0 config with no tickets on disk isn't adopted; start says so and exits 1", async () => {
  const root = tempRoot();
  const project = fOne(root);
  writeFileSync(path.join(project, ".tickets", "tickets.yaml"), "tickets: []\n");
  writeFileSync(path.join(project, ".tickets", "delivery.yaml"), "units: []\n");
  git(project, ["commit", "-qam", "no tickets"]);
  const rafi = rafiRunner(newComputer(root), project);
  const r = await rafi("start . --steps 1");
  assert.deepEqual((await logged(rafi)).map((e) => e.type), [], "nothing recorded: the row needs tickets on disk");
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /no tickets/i);
});
