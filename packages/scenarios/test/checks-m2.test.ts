// Milestone: M2
// Item 24 (M2 plan 3.3): rafi runs the checks and records them (ARCH 6.9): the check.run record, the time limits
// (timed-out after 2 quiet minutes is a failure; too-slow at 5 minutes isn't), changed-code naming files, QA's
// restore, the cache variables, the sandbox prefix (os) or none, and the check step reusing fresh runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { openEngine } from "@rafi-ai/engine";
import { checkStep, executeCheck, type CheckEnv } from "@rafi-ai/engine/build";
import { fakeTerminal } from "../fakes/terminal.js";
import { git, tempRoot } from "../fixtures/common.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { harnessDeps } from "../harness/deps.js";
import { newComputer } from "../harness/rafi.js";

async function setup(tests: Record<string, unknown>, o: { sandbox?: boolean } = {}) {
  const root = tempRoot();
  const project = fTestsLocal(root);
  const computer = newComputer(root);
  Object.assign(computer.checks.tests, tests);
  const { deps } = harnessDeps(computer, fakeTerminal({ tty: false }), { cwd: project, instance: "i1" });
  const engine = await openEngine({ projectDir: project, deps });
  const env: CheckEnv = { deps, engine, project, run: "r1", ticket: "T1", grants: { needs: [] },
    sandbox: o.sandbox === false ? null : "sandbox-exec", runner: ["fake-test"], quietMs: 120_000, limitMs: 300_000,
    outputPaths: ["coverage/"], checksEnv: [] };
  const runs = async () => {
    const out: Record<string, unknown>[] = [];
    for await (const e of engine.events()) if (e.type === "check.run") out.push(e.data as Record<string, unknown>);
    return out;
  };
  return { project, computer, engine, env, runs };
}

test("a failing builder run is recorded with command, exit, per-test results, tree, duration and sandbox", async () => {
  const s = await setup({ "t1.test": { outcomes: ["fail(2)"], writes: ["coverage/"], homeCache: true } });
  const out = await executeCheck(s.env, ["fake-test", "t1.test"], "builder");
  const [run] = await s.runs();
  assert.equal(run!.run, 1);
  assert.equal(run!.command, "fake-test t1.test");
  assert.equal(run!.asked_by, "builder");
  assert.equal(run!.outcome, "failed");
  assert.equal(run!.exit_code, 1);
  assert.equal((run!.tests as unknown[]).length, 2);
  assert.match(String(run!.tree), /^[0-9a-f]{40}$/);
  assert.equal(run!.sandbox, "os");
  assert.ok(typeof run!.output === "string");
  assert.match(out.text, /run 1/);
  assert.match(out.text, /exit 1/);
  assert.match(out.text, /t1\.test › case 1/);
  assert.match(out.text, /check_output\(1\)/);
  const log = s.computer.checks.log.at(-1)!;
  assert.ok(log.sandbox.length > 0, "the sandbox prefix reached checks.run");
  assert.ok(String(log.env.npm_config_cache).startsWith(path.join(s.project, ".rafi", "cache")));
  assert.match(git(s.project, ["status", "--porcelain", "--untracked-files=all"]), /^$/m);
  s.engine.close();
});

test("a run quiet for 2 minutes is timed-out (a failure); one still printing at 5 minutes is too-slow", async () => {
  const s = await setup({ "t1.test": { outcomes: ["hang"] }, "t2.test": { outcomes: ["slow(8m)"] } });
  await executeCheck(s.env, ["fake-test", "t1.test"], "rafi");
  await executeCheck(s.env, ["fake-test", "t2.test"], "rafi");
  const [hung, slow] = await s.runs();
  assert.deepEqual([hung!.outcome, hung!.duration_ms], ["timed-out", 120_000]);
  assert.deepEqual([slow!.outcome, slow!.duration_ms], ["too-slow", 300_000]);
  s.engine.close();
});

test("a builder run that edits a tracked file is changed-code naming it; QA's is put back and recorded", async () => {
  const s = await setup({ "t2.test": { outcomes: ["pass"], edits: "src/index.js" } });
  const before = readFileSync(path.join(s.project, "src", "index.js"), "utf8");
  await executeCheck(s.env, ["fake-test", "t2.test"], "builder");
  const [builder] = await s.runs();
  assert.equal(builder!.outcome, "changed-code");
  assert.deepEqual(builder!.changed_tracked, ["src/index.js"]);
  git(s.project, ["checkout", "--", "src/index.js"]);
  await executeCheck(s.env, ["fake-test", "t2.test"], "qa");
  const [, qa] = await s.runs();
  assert.equal(qa!.outcome, "passed");
  assert.deepEqual(qa!.restored, ["src/index.js"]);
  assert.equal(readFileSync(path.join(s.project, "src", "index.js"), "utf8"), before);
  s.engine.close();
});

test("threat 12: a QA run that edits a tracked file and adds a new one: both put back, the restore checked",
  async () => {
    const s = await setup({ "t2.test": { outcomes: ["pass"], edits: "src/index.js", creates: "src/added.js" } });
    const before = readFileSync(path.join(s.project, "src", "index.js"), "utf8");
    await executeCheck(s.env, ["fake-test", "t2.test"], "qa");
    const [qa] = await s.runs();
    assert.deepEqual(qa!.restored, ["src/added.js", "src/index.js"]);
    assert.equal(readFileSync(path.join(s.project, "src", "index.js"), "utf8"), before, "the edit is put back");
    assert.equal(existsSync(path.join(s.project, "src", "added.js")), false, "the added file is removed");
    const status = git(s.project, ["status", "--porcelain", "--untracked-files=all"]).split("\n")
      .filter((l) => l && !l.includes(" .rafi/"));
    assert.deepEqual(status, [], "nothing changed outside rafi's folder");
    s.engine.close();
  });

test("with the no-sandbox warning accepted, runs spawn with no prefix and record sandbox: none", async () => {
  const s = await setup({}, { sandbox: false });
  await executeCheck(s.env, ["fake-test", "t1.test"], "builder");
  assert.deepEqual(s.computer.checks.log.at(-1)!.sandbox, []);
  assert.equal((await s.runs())[0]!.sandbox, "none");
  s.engine.close();
});

test("the check step reuses a fresh passing run and reruns only a stale one", async () => {
  const s = await setup({ "t1.test": { outcomes: ["pass"], related: ["src/T1.txt"] },
    "t2.test": { outcomes: ["pass"], related: ["src/T2.txt"] } });
  await executeCheck(s.env, ["fake-test", "t1.test"], "builder");
  await executeCheck(s.env, ["fake-test", "t2.test"], "builder");
  appendFileSync(path.join(s.project, "src", "index.js"), "// unrelated to either test\n");
  appendFileSync(path.join(s.project, "coverage.txt"), "x");
  const both = [{ req: 1, command: "fake-test t1.test" }, { req: 2, command: "fake-test t2.test" }];
  const rules = { root: s.project, runner: ["fake-test"], requirementChecks: [], setupScript: "scripts/rafi-setup.sh",
    testScripts: [] };
  const first = await checkStep(s.env, both, rules);
  assert.equal(first.outcome, "passed");
  assert.deepEqual(first.reused, [1, 2]);
  appendFileSync(path.join(s.project, "src", "T2.txt"), "changed\n");
  const second = await checkStep(s.env, both, rules);
  assert.deepEqual(second.reused, [1]);
  assert.deepEqual(second.runs, [3]);
  s.engine.close();
});
