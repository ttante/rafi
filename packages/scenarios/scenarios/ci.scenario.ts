// CI (SCN 5.6, M5 slice 8; plan items 15, 16): S-CHK-6 on F-TESTS (the suite fails at the end-of-build CI point; a
// rafi-owned fix ticket fixes it; the suite passes apart from the already-broken test; rafi merges and pushes) and
// S-CHK-8's M5 part (no suite when you manage git or completion is `none`; each ticket's own and related tests run).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import { steps } from "../checks/transcript.js";
import { B, on } from "../fakes/script/behaviors.js";
import { git } from "../fixtures/common.js";
import { remoteOf } from "../fixtures/f-branch.js";
import { fTests } from "../fixtures/f-tests.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
type Data = Record<string, unknown>;
const of = (events: readonly { type: string; data: unknown }[], type: string) =>
  events.filter((e) => e.type === type).map((e) => e.data as Data);

/** `T2`'s commit breaks `suite/x.test` until the fix ticket's file exists; `y` fails everywhere; `z` once. */
function chk6Tests(ctx: ScenarioContext): void {
  const t = ctx.computer.checks.tests;
  t["suite/x.test"] = { outcomes: ["pass"], failWhen: { file: "src/T2.txt", contains: "T2 done",
    unless: "src/FIX-1.txt" } };
  t["suite/y.test"] = { outcomes: ["fail(1)"] };
  t["suite/z.test"] = { outcomes: ["fail(1)", "pass"] };
  ctx.computer.script.rules.push(on("qa FIX-1#1 @prepare", B.requirements([{ from: 1,
    text: "suite/x.test passes", check: "fake-test suite/x.test" }])));
}

scenario({
  id: "S-CHK-6", covers: covers("S-CHK-6"), modes: ["next"], fixture: "none",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    const dir = fTests(path.join(ctx.root, "chk6"));
    chk6Tests(ctx);
    const r = await rafi("start . --steps 3", { cwd: dir });
    const events = (await exported(ctx, dir)).events;
    const suites = of(events, "suite.run");
    await step("the build finishes: T1–T3 and the fix ticket done, exit 0", () => {
      assert.equal(r.code, 0, r.output);
      const finished = of(events, "build.finished").at(-1)!;
      assert.equal(finished.complete, true);
    });
    await step("the suite fails on x, y and z; z is flaky and y already broken, each reported once, not blocking",
      () => {
        const first = suites[0]!;
        assert.deepEqual([first.outcome, first.failing, first.preexisting, first.flaky],
          ["failed", ["suite/x.test", "suite/y.test", "suite/z.test"], ["suite/y.test"], ["suite/z.test"]]);
        const lines = r.output.split("\n");
        assert.equal(lines.filter((l) => /already failing/.test(l) && /suite\/y\.test/.test(l)).length, 1, r.output);
        assert.equal(r.output.split("\n").filter((l) => /flaky/.test(l) && /suite\/z\.test/.test(l)).length, 1);
      });
    await step("a fix ticket first in the queue: suite/x.test its requirement, T2 probably caused it", () => {
      const added = of(events, "ticket.added");
      assert.equal(added.length, 1);
      assert.deepEqual([added[0]!.ticket, added[0]!.source, added[0]!.requirements], ["FIX-1", "ci",
        ["suite/x.test"]]);
      assert.match(String(added[0]!.hint), /T2/);
      const starts = events.filter((e) => e.type === "ticket.started").map((e) => e.ticket_id);
      assert.deepEqual(starts, ["T1", "T2", "T3", "FIX-1"]);
    });
    await step("built like any ticket: requirements file, builder, QA", () => {
      const fix = computer.script.transcript.filter((t) => t.ticket === "FIX-1");
      assert.deepEqual(steps(fix), ["qa@prepare", "builder@build", "qa@review"]);
      assert.ok(events.some((e) => e.type === "requirements.written" && e.ticket_id === "FIX-1"));
    });
    await step("T1–T3 stay done, none reopened; the fix ticket isn't counted, writes no plan revision, told once",
      () => {
        const added = events.findIndex((e) => e.type === "ticket.added");
        const odd = events.filter((e, i) => ["ticket.reopened", "ticket.status_set", "question.opened"]
          .includes(e.type) || (e.type === "tickets.changed" && i > added));
        assert.deepEqual(odd, [], "no reopen, no plan change after the fix ticket, no question");
        const finished = of(events, "build.finished").at(-1)!;
        assert.deepEqual([...(finished.done as string[])].filter((t) => t.startsWith("T")).sort(), ["T1", "T2", "T3"]);
        assert.equal(r.output.split("\n").filter((l) => /added FIX-1/.test(l)).length, 1, r.output);
      });
    await ctx.pending("the end-of-build summary names the fix ticket (S-ENG-1's summary)", "M9");
    await step("the fix's builder message: each failing test's name, file, error, excerpt and run number", () => {
      const msg = computer.script.transcript.find((t) => t.ticket === "FIX-1" && t.role === "builder")!.message;
      assert.match(msg, /case 1/);
      assert.match(msg, /suite\/x\.test/);
      assert.match(msg, /expect\(received\)\.toBe\(expected\)/);
      assert.match(msg, /check_output\(1\)/);
      assert.doesNotMatch(msg, /suite\/y\.test.*case 1|T2 done/);
    });
    await step("the suite runs again and passes apart from y; rafi merges and pushes the base", () => {
      assert.equal(suites.length, 2);
      assert.deepEqual([suites[1]!.outcome, suites[1]!.failing, suites[1]!.preexisting], ["passed", ["suite/y.test"],
        ["suite/y.test"]]);
      assert.ok((suites[1]!.reused as string[]).includes("t1.test"), "unchanged passing tests reused");
      assert.deepEqual(of(events, "ci.result").map((d) => [d.outcome, d.fix_ticket]), [["fixed", "FIX-1"]]);
      assert.deepEqual(of(events, "unit.delivered").map((d) => [d.unit, d.how]), [["U-1", "merged"]]);
      const log = git(remoteOf(dir), ["log", "--format=%s", "main"]);
      for (const id of ["T1", "T2", "T3", "FIX-1"]) assert.match(log, new RegExp(`^${id}: `, "m"), log);
      assert.ok(!existsSync(path.join(dir, ".github")) && !existsSync(path.join(dir, ".gitlab-ci.yml")));
      assert.ok(!existsSync(path.join(dir, ".rafi", "cache", "ci")) ||
        git(dir, ["worktree", "list"]).split("\n").every((l) => !l.includes(path.join(".rafi", "cache", "ci"))),
      "the throwaway worktrees are gone");
    });
  },
});

scenario({
  id: "S-CHK-8", covers: covers("S-CHK-8"), modes: ["next"], fixture: "F-TESTS-LOCAL",
  async run(ctx) {
    const { rafi, step, computer, project } = ctx;
    const related = () => {
      computer.checks.tests["suite/x.test"] = { outcomes: ["pass"], related: ["src/T1.txt"] };
    };
    const check = async (dir: string) => {
      const r = await rafi("start . --steps 3", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const events = (await exported(ctx, dir)).events;
      assert.equal(of(events, "suite.run").length, 0, "no suite runs");
      assert.equal(of(events, "ci.result").length, 0);
      const runs = of(events, "check.run").map((d) => d.command);
      for (const n of [1, 2, 3]) assert.ok(runs.includes(`fake-test t${n}.test`), `T${n}'s own test`);
      assert.ok(runs.includes("fake-test suite/x.test"), "T1's related test");
    };
    await step("git.managed_by: me: no suite; each ticket's own and related tests run", async () => {
      related();
      await check(project);
      // The same with delivery.yaml asking for a direct merge: managed_by: me still means no suite (C205).
      await check(fTests(path.join(ctx.root, "me"), { qa: false, config: { checks: { test_runner: "fake-test" },
        git: { managed_by: "me" } } }));
    });
    await step("managed_by: rafi with completion none: no suite either", async () => {
      related();
      await check(fTests(path.join(ctx.root, "none"), { qa: false, units: [{ id: "U-1",
        tickets: ["T1", "T2", "T3"], branch_mode: "shared", completion: "none" }] }));
    });
    await ctx.pending("the build's settings, read from the event stream (S-ENG-2), say rafi doesn't handle git",
      "M10");
  },
});
