// Tests and CI, the M2 part (SCN 5.6): S-CHK-1, S-CHK-9, S-CHK-10, S-CHK-11 on F-TESTS-LOCAL, mode next.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { EventsExport } from "../checks/invariants.js";
import { registry } from "../checks/registry.js";
import { steps } from "../checks/transcript.js";
import { B, on } from "../fakes/script/behaviors.js";
import { git } from "../fixtures/common.js";
import { scenario, type FixtureName, type ScenarioContext } from "../harness/scenario.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
type Data = Record<string, unknown>;

async function events(ctx: Pick<ScenarioContext, "rafi">, cwd: string, type: string): Promise<Data[]> {
  const r = await ctx.rafi("stats export", { cwd });
  return (JSON.parse(r.out) as EventsExport).events.filter((e) => e.type === type).map((e) => e.data);
}

function fresh(ctx: ScenarioContext, name: FixtureName = "F-TESTS-LOCAL"): string {
  ctx.computer.script.rules.length = 0;
  ctx.computer.script.transcript.length = 0;
  for (const key of Object.keys(ctx.computer.checks.tests)) delete ctx.computer.checks.tests[key];
  return ctx.fixture(name);
}

scenario({
  id: "S-CHK-1", covers: covers("S-CHK-1"), modes: ["next"], fixture: "F-TESTS-LOCAL",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    await step("script A: the claimed pass isn't used; rafi's failing run is recorded; back to the builder, no QA",
      async () => {
        const dir = fresh(ctx);
        computer.checks.tests["t1.test"] = { outcomes: ["fail(1)", "pass"], writes: ["coverage/"], homeCache: true };
        computer.script.rules.push(on("builder T1#1", B.shellTest("fake-test t1.test")));
        const r = await rafi("start . --ticket T1 --steps 1", { cwd: dir });
        assert.equal(r.code, 0, r.output);
        const runs = await events(ctx, dir, "check.run");
        const first = runs[0]!;
        assert.deepEqual([first.asked_by, first.command, first.outcome, first.exit_code], ["rafi", "fake-test t1.test",
          "failed", 1]);
        assert.ok(typeof first.output === "string" && typeof first.duration_ms === "number");
        assert.match(String(first.tree), /^[0-9a-f]{40}$/);
        assert.deepEqual(steps(computer.script.transcript),
          ["qa@prepare", "builder@build", "builder@fix", "qa@review"]);
        assert.ok((await events(ctx, dir, "checks.failed")).length === 1);
        assert.ok(existsSync(path.join(dir, "coverage", "lcov.info")), "coverage/ written in the worktree");
        const cache = path.join(dir, ".rafi", "cache", "npm", "_cacache", "index");
        assert.ok(existsSync(cache), "the cache write landed under .rafi/cache");
        assert.doesNotMatch(git(dir, ["status", "--porcelain", "--untracked-files=all"]), /\.rafi\/cache|coverage/);
        assert.doesNotMatch(r.output, /EPERM/);
        const qa = computer.script.transcript.filter((t) => t.role === "qa");
        assert.ok(qa.every((t) => t.writable === false), "QA's sessions are read-only");
      });
    await step("script B: run_check is recorded asked_by builder and the turn gets the run number", async () => {
      const dir = fresh(ctx);
      computer.script.rules.push(on("builder T1#1", B.runCheck("fake-test t1.test")));
      const r = await rafi("start . --ticket T1 --steps 1", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const runs = await events(ctx, dir, "check.run");
      assert.deepEqual([runs[0]!.run, runs[0]!.asked_by, runs[0]!.exit_code], [1, "builder", 0]);
      assert.deepEqual((await events(ctx, dir, "builder.reported"))[0]!.runs, [1]);
    });
  },
});

for (const runtime of ["claude", "codex"] as const) {
  scenario({
    id: "S-CHK-9", covers: covers("S-CHK-9"), modes: ["next"], fixture: "F-TESTS-JEST",
    async run(ctx) {
      const { rafi, step, computer, project } = ctx;
      if (runtime === "codex") {
        const file = path.join(project, "rafi-config.yaml");
        writeFileSync(file, stringify({ ...parse(readFileSync(file, "utf8")), harness: { targets: ["codex"] } }));
        git(project, ["commit", "-qam", "codex only"]);
      }
      const original = readFileSync(path.join(project, "src", "index.js"), "utf8");
      computer.checks.tests["t2.test"] = { outcomes: ["pass"], edits: "src/index.js" };
      computer.checks.tests["t3.test"] = { outcomes: ["pass"], network: true };
      computer.script.rules.push(on("builder T1#1", B.runCheck("rafi answer 1 1", "curl https://example.com",
        "npx jest t1.test", "npx jest t3.test")), on("qa T1 @review", () => ({ steps: [{ runCheck:
        "npx jest t2.test" }], reply: { results: [{ req: 1, status: "satisfied", runs: [3], needs: null, note: null }],
        summary: "ok" } })));
      let runs: Data[] = [];
      await step(`${runtime}: rafi start . --ticket T1 --steps 1`, async () => {
        const r = await rafi("start . --ticket T1 --steps 1");
        assert.equal(r.code, 0, r.output);
        runs = await events(ctx, project, "check.run");
      });
      await step("rafi answer and curl are refused and recorded with the reason; no question is answered", async () => {
        const refused = runs.filter((r) => r.outcome === "refused");
        assert.deepEqual(refused.map((r) => r.command), ["rafi answer 1 1", "curl https://example.com"]);
        assert.ok(refused.every((r) => String(r.refused).length > 10));
        assert.deepEqual(await events(ctx, project, "question.answered"), []);
      });
      await step("npx jest t1.test runs; a test trying the network is denied by the sandbox", () => {
        assert.deepEqual(runs.filter((r) => r.command === "npx jest t1.test").map((r) => r.outcome)[0], "passed");
        assert.equal(runs.find((r) => r.command === "npx jest t3.test")!.outcome, "failed");
        assert.ok(runs.every((r) => r.sandbox === "os"));
        assert.ok(computer.checks.log.every((l) => !l.needs.includes("internet")), "no internet grant reaches it");
      });
      await step("QA's run is recorded, src/index.js put back (restored), the code unchanged for review", () => {
        const qa = runs.find((r) => r.asked_by === "qa")!;
        assert.deepEqual(qa.restored, ["src/index.js"]);
        assert.equal(readFileSync(path.join(project, "src", "index.js"), "utf8"), original);
      });
      await step(`${runtime} reaches the tools ${runtime === "codex" ? "through rafi's local endpoint" : "in-process"}`,
        () => {
          const posted = computer.serve.calls.filter((c) => c.method === "tools/call").length;
          if (runtime === "codex") assert.ok(posted >= 5, `posts: ${posted}`);
          else assert.equal(posted, 0);
        });
    },
  });
}

scenario({
  id: "S-CHK-10", covers: covers("S-CHK-10"), modes: ["next"], fixture: "F-TESTS-LOCAL",
  async run(ctx) {
    const { rafi, step, computer, project } = ctx;
    computer.checks.tests["t1.test"] = { outcomes: ["fail(2)", "fail(2)", "pass"] };
    computer.checks.tests["t2.test"] = { outcomes: ["pass"], related: ["src/T1.txt"] };
    await step("--no-qa: no requirements file, no QA turn; the required test and the related tests run", async () => {
      const r = await rafi("start . --ticket T1 --steps 1 --no-qa");
      assert.equal(r.code, 0, r.output);
      assert.ok(!existsSync(path.join(project, "docs", "requirements", "T1.md")));
      assert.deepEqual(steps(computer.script.transcript), ["builder@build", "builder@fix"]);
      const rafiRuns = (await events(ctx, project, "check.run")).filter((x) => x.asked_by === "rafi");
      assert.deepEqual(rafiRuns.slice(0, 2).map((x) => x.command), ["fake-test t1.test", "fake-test t2.test"]);
    });
    await step("the fix message names both failing tests, the run and check_output, and says keep the work", () => {
      const fix = computer.script.transcript.find((t) => t.step === "fix")!.message;
      assert.match(fix, /case 1 in t1\.test/);
      assert.match(fix, /case 2 in t1\.test/);
      assert.match(fix, /expect\(received\)\.toBe\(expected\)/);
      assert.match(fix, /Run 2 failed/);
      assert.match(fix, /Command: fake-test t1\.test\n/, "the command, inside the quoted details");
      assert.match(fix, /check_output\(2\)/);
      assert.match(fix, /Keep the work you've done; don't start over/);
    });
    await step("the fix passes the check and T1 is delivered", async () => {
      assert.equal((await events(ctx, project, "delivery.done")).length, 1);
    });
  },
});

scenario({
  id: "S-CHK-11", covers: covers("S-CHK-11"), modes: ["next"], fixture: "F-TESTS-LOCAL",
  async run(ctx) {
    const { rafi, step, computer, project } = ctx;
    computer.checks.sandbox = "missing";
    const grants = path.join(computer.stateDir, "grants.yaml");
    const script = () => { computer.script.rules.length = 0;
      computer.script.rules.push(on("builder T1#1", B.runCheck("fake-test t1.test", "curl https://example.com"))); };
    await step("1: the warning comes before any agent turn; cancel exits 0 with no turn and no test run", async () => {
      script();
      const r = await rafi("start . --ticket T1 --steps 1", { tty: true, input: ["2"] });
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /bubblewrap isn't installed/);
      assert.match(r.output, /reach the internet/);
      assert.match(r.output, /write outside the project/);
      assert.equal(computer.script.transcript.length, 0);
      assert.equal(computer.checks.log.length, 0);
    });
    await step("2: accepted: sandbox none, curl still refused, no grants, saved off the project", async () => {
      script();
      const r = await rafi("start . --ticket T1 --steps 1", { tty: true, input: ["1"] });
      assert.equal(r.code, 0, r.output);
      const runs = await events(ctx, project, "check.run");
      assert.ok(runs.length >= 2 && runs.every((x) => x.sandbox === "none"));
      assert.equal(runs.find((x) => x.command === "curl https://example.com")!.outcome, "refused");
      assert.deepEqual(await events(ctx, project, "grant.recorded"), []);
      assert.ok(computer.checks.log.every((l) => l.sandbox.length === 0));
      assert.match(readFileSync(grants, "utf8"), new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.throws(() => git(project, ["grep", "-n", "run_without_sandbox"]), "no tracked file mentions it");
    });
    await step("3: the next build in a terminal asks nothing and runs with sandbox none", async () => {
      computer.script.transcript.length = 0;
      // "2" would cancel the warning if it were asked again, so a lost acceptance fails here instead of hanging.
      const r = await rafi("start . --ticket T2 --steps 1", { tty: true, input: ["2"] });
      assert.equal(r.code, 0, r.output);
      assert.doesNotMatch(r.output, /no sandbox for tests/);
      assert.ok((await events(ctx, project, "check.run")).every((x) => x.sandbox === "none"));
    });
    await step("4: revoked, without a terminal: exit 1 before any turn, one line naming the setting", async () => {
      writeFileSync(grants, stringify({ projects: {} }));
      computer.script.transcript.length = 0;
      const r = await rafi("start . --ticket T3 --steps 1");
      assert.equal(r.code, 1, r.output);
      assert.equal(r.err.trim().split("\n").length, 1);
      assert.match(r.err, /checks\.run_without_sandbox: true/);
      assert.equal(computer.script.transcript.length, 0);
      assert.deepEqual(await events(ctx, project, "question.opened"), []);
    });
    await step("5: checks.run_without_sandbox: true accepts it unattended", async () => {
      const file = path.join(project, "rafi-config.yaml");
      const config = parse(readFileSync(file, "utf8"));
      writeFileSync(file, stringify({ ...config, checks: { ...config.checks, run_without_sandbox: true } }));
      const r = await rafi("start . --ticket T3 --steps 1");
      assert.equal(r.code, 0, r.output);
      assert.ok((await events(ctx, project, "check.run")).every((x) => x.sandbox === "none"));
    });
    for (const tty of [true, false]) {
      await step(`6: -y accepts it ${tty ? "in a terminal" : "without a terminal"} and saves the acceptance`,
        async () => {
          const dir = fresh(ctx);
          const r = await rafi("start . --ticket T1 --steps 1 -y", { cwd: dir, tty });
          assert.equal(r.code, 0, r.output);
          assert.match(readFileSync(grants, "utf8"), new RegExp(path.basename(dir)));
        });
    }
  },
});
