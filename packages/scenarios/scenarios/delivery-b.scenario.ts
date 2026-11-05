// S-BATCH-2 steps 3–7 (M5 plan item 10; slices 5–6), each on a fresh F-BRANCH: `--stacks 1 --base main` builds
// one complete stack from main; the config-only keys are followed (prefix, merge method, auto-merge wait, kept
// worktrees, the depth limit before any turn) and `--merge-method` is refused naming its key; PRM-77 and PRM-78 in
// a terminal, and PRM-76 (resume a half-done unit); an explicit unit branch is exact while automatic ones take the
// saved prefix; step 7's size policy (P42) shares a branch and a PR between S tickets, never a session.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import { git } from "../fixtures/common.js";
import { BRANCH_UNITS, fBranch, remoteOf, type BranchOptions } from "../fixtures/f-branch.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
const branches = (dir: string) => git(dir, ["branch", "--format=%(refname:short)"]).split("\n").filter(Boolean).sort();

function fresh(ctx: ScenarioContext, name: string, o: BranchOptions = {}): string {
  ctx.computer.gh.prs.length = 0;
  ctx.computer.gh.calls.length = 0;
  ctx.computer.gh.notReady = false;
  return fBranch(path.join(ctx.root, name), o);
}

scenario({
  id: "S-BATCH-2", covers: covers("S-BATCH-2"), modes: ["next"], fixture: "none",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    await step("step 3: --stacks 1 --base main builds exactly one complete stack from main", async () => {
      const dir = fresh(ctx, "stacks");
      const r = await rafi("start . --stacks 1 --base main", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx, dir);
      assert.deepEqual(e.events.filter((x) => x.type === "delivery.done").map((x) => x.ticket_id), ["T1", "T2"]);
      assert.deepEqual(computer.gh.prs.map((p) => [p.head, p.base]), [["feature/T1-add-the-parser", "main"],
        ["feature/T2-add-the-printer", "main"]]);
      for (const b of ["feature/T1-add-the-parser", "feature/T2-add-the-printer"]) {
        assert.equal(git(dir, ["merge-base", b, "main"]).trim(), git(dir, ["rev-parse", "main"]).trim());
      }
    });
    await step("step 4: the config-only keys are followed", async () => {
      const dir = fresh(ctx, "config", { build: { merge_method: "squash", provider: "github", auto_merge_wait: false,
        auto_merge_timeout_minutes: 5, branch_prefix: "team", keep_worktrees: true, max_branch_depth: 3 } });
      const r = await rafi("start . --steps 2 --branch-per-ticket --completion auto-merge", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(branches(dir), ["main", "team/T1-add-the-parser", "team/T2-add-the-printer"]);
      assert.ok(computer.gh.prs.every((p) => p.autoMerge === "squash"), "merge_method");
      const e = await exported(ctx, dir);
      assert.deepEqual(e.events.filter((x) => x.type === "unit.delivered").map((x) => (x.data as { how: string }).how),
        ["pr-opened"], "auto_merge_wait: false doesn't wait");
      assert.equal(e.events.filter((x) => x.type === "unit.merge_waiting").length, 0);
      for (const b of ["team-T1-add-the-parser", "team-T2-add-the-printer"]) {
        assert.ok(existsSync(path.join(dir, ".foreman", "worktrees", b)), `keep_worktrees keeps ${b}`);
      }
    });
    await step("step 4: a stack deeper than max_branch_depth is refused before any turn", async () => {
      const dir = fresh(ctx, "depth", { build: { max_branch_depth: 1 } });
      const r = await rafi("start . --steps 4 --branch-per-ticket", { cwd: dir });
      assert.equal(r.code, 1, r.output);
      assert.match(r.output, /T4-add-the-sync would be 2 branches deep; tickets\.build\.max_branch_depth is 1/);
      assert.ok(!existsSync(path.join(dir, ".rafi", "state.sqlite3")) || !(await exported(ctx, dir)).events
        .some((x) => x.type === "turn.intent" || x.type === "build.started"));
    });
    await step("step 4: --merge-method squash is refused, naming tickets.build.merge_method", async () => {
      const r = await rafi("start . --steps 1 --merge-method squash", { cwd: fresh(ctx, "flag") });
      assert.equal(r.code, 1);
      assert.match(r.output, /tickets\.build\.merge_method/);
    });
    await step("step 5: in a terminal, --ticket T4 asks to start its eligible dependency first", async () => {
      const dir = fresh(ctx, "dep");
      const r = await rafi("start . --ticket T4", { cwd: dir, tty: true, input: ["2"] });
      assert.match(r.output, /Start eligible dependency T3: Add the store instead\?/);
      assert.equal(r.code, 0, r.output);
    });
    await resumeUnit(ctx);
    await step("step 6: a failed gh readiness asks \"Retry GitHub readiness check?\"; Retry goes on", async () => {
      const dir = fresh(ctx, "ready");
      computer.gh.notReady = true;
      const live = rafi.start("start . --steps 2 --branch-per-ticket --completion pr", { cwd: dir, tty: true });
      await live.expect(/Retry GitHub readiness check\?/);
      computer.gh.notReady = false;
      live.send("1\n");
      const r = await live.done();
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /GitHub isn't ready: You are not logged into any GitHub hosts\..*gh auth login/);
      assert.equal(computer.gh.prs.length, 2);
      const other = fresh(ctx, "ready2");
      computer.gh.notReady = true;
      const none = await rafi("start . --steps 1 --branch-per-ticket --completion pr", { cwd: other });
      assert.equal(none.code, 1, "no terminal: exit 1 with the fix line");
      assert.match(none.output, /gh auth login/);
    });
    await step("step 7: an explicit branch is exact; automatic ones take the saved prefix", async () => {
      const units = [BRANCH_UNITS[0]!, { id: "U2", tickets: ["T3"], branch: "release/x" }];
      const dir = fresh(ctx, "named", { units, build: { branch_prefix: "work/" } });
      const r = await rafi("start . --steps 3 --completion pr", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(git(remoteOf(dir), ["branch", "--format=%(refname:short)"]).split("\n").filter(Boolean).sort(),
        ["main", "release/x", "work/T1-add-the-parser", "work/T2-add-the-printer"]);
    });
    await sizePolicy(ctx);
  },
});

/** Step 5, PRM-76. */
async function resumeUnit(ctx: ScenarioContext): Promise<void> {
  const { rafi, step, computer } = ctx;
  await step("step 5: a half-done unit asks \"Resume unfinished delivery unit U1 (1 remaining)?\" in a terminal; " +
    "Skip builds past it; without a terminal it resumes", async () => {
    const dir = fresh(ctx, "resume-unit");
    assert.equal((await rafi("start . --steps 1", { cwd: dir })).code, 0);
    const r = await rafi("start . --steps 1", { cwd: dir, tty: true, input: ["2"] });
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /Resume unfinished delivery unit U1 \(1 remaining\)\?/);
    assert.match(r.output, /Resume \(Recommended\)[\s\S]*Skip for this run/);
    const started = async () => (await exported(ctx, dir)).events.filter((x) => x.type === "ticket.started")
      .map((x) => x.ticket_id);
    assert.deepEqual(await started(), ["T1", "T3"], "Skip for this run builds past U1");
    // T3 (U2: git left to you) is uncommitted in your checkout, so U1's worktree build says how it starts.
    const plain = await rafi("start . --steps 1 --dirty-work preserve", { cwd: dir });
    assert.equal(plain.code, 0, plain.output);
    assert.doesNotMatch(plain.output, /Resume unfinished/);
    assert.deepEqual(await started(), ["T1", "T3", "T2"], "no terminal: U1 resumes");
  });
}

/** Step 7, P42. */
async function sizePolicy(ctx: ScenarioContext): Promise<void> {
  const { rafi, step, computer } = ctx;
  await step("step 7: with the size policy, the two S tickets share one branch and one PR, the M ticket gets its " +
    "own; each ticket has a new builder session (P42)", async () => {
    const tickets = [{ id: "T1", title: "Add the parser" }, { id: "T2", title: "Add the printer" },
      { id: "T3", title: "Add the store", size: "M" }];
    const policy = { mode: "size", global_strategy: "branch-per-ticket",
      by_size: { XS: "shared", S: "shared", M: "per-ticket", L: "per-ticket", XL: "per-ticket" } };
    const dir = fresh(ctx, "sizes", { tickets, units: [{ id: "U1", tickets: ["T1", "T2", "T3"],
      branch_mode: "per-ticket" }], build: { branch_policy: policy } });
    const r = await rafi("start . --steps 3 --completion pr", { cwd: dir });
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(computer.gh.prs.map((p) => p.head), ["feature/U1-size-t1-t2", "feature/T3-add-the-store"]);
    assert.deepEqual(git(remoteOf(dir), ["branch", "--format=%(refname:short)"]).split("\n").filter(Boolean).sort(),
      ["feature/T3-add-the-store", "feature/U1-size-t1-t2", "main"]);
    const builds = (await exported(ctx, dir)).events.filter((x) => x.type === "turn.intent" &&
      (x.data as { role: string; step: string }).role === "builder" && (x.data as { step: string }).step === "build");
    assert.deepEqual(builds.map((x) => [x.ticket_id, (x.data as { session: string }).session]),
      [["T1", "new"], ["T2", "new"], ["T3", "new"]]);
  });
}
