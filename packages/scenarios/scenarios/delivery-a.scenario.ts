// S-BATCH-2 steps 1–2 (M5 plan item 10; slices 5–6): F-BRANCH, fresh fixture each. Step 1: `--steps 2
// --branch-per-ticket --completion pr`: branches `feature/<id>-<title-slug>`, one draft PR per ticket, each body
// under `.foreman/pr-bodies/`. Step 2: `pr-ready` ready PRs; `auto-merge` waits for the merge on the clock before
// the stacked unit starts; `direct-merge` merges locally and pushes the base; `none` leaves the branch with its
// commits; `--no-branch-per-ticket` beats a saved `branch-per-ticket`. Across all: no CI file written, no
// branch-protection call, no forced push.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import { git } from "../fixtures/common.js";
import { fBranch, remoteOf } from "../fixtures/f-branch.js";
import { mergePr } from "../fakes/gh.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

const branches = (dir: string) => git(dir, ["branch", "--format=%(refname:short)"]).split("\n").filter(Boolean).sort();
const remoteBranches = (project: string) => branches(remoteOf(project));
const isAncestor = (dir: string, a: string, b: string) => {
  try { git(dir, ["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; }
};
const subject = (dir: string, ref: string) => git(dir, ["log", "-1", "--format=%s%n%b", ref]);

/** No CI files, no branch-protection call, no forced or deleting push (C198, ARCH 6.10's "never adds CI files"). */
function noCiNoForce(ctx: ScenarioContext, project: string) {
  assert.ok(!existsSync(path.join(project, ".github")) && !existsSync(path.join(project, ".gitlab-ci.yml")));
  for (const call of ctx.computer.gh.calls) assert.ok(!call.args.some((a) => /protection/.test(a)), String(call.args));
  for (const call of ctx.computer.gh.calls) assert.ok(!call.args.includes("--delete-branch"));
}

/** Your checkout: untouched apart from rafi's progress file, which is yours to commit (ARCH 3.7). */
const onlyViews = (dir: string) => assert.equal(git(dir, ["status", "--porcelain", "--untracked-files=all"]),
  "?? .rafi/progress.yaml\n");

/** A fresh F-BRANCH and a fresh fake gh (step 2's variants each start from the fixture). */
function fresh(ctx: ScenarioContext, name: string, build: Record<string, unknown> = {}): string {
  ctx.computer.gh.prs.length = 0;
  ctx.computer.gh.calls.length = 0;
  ctx.computer.gh.mergeAfterViews = null;
  return fBranch(path.join(ctx.root, name), { build });
}

/** Every merge-wait poll moves the clock to it (polls never fire on their own, SCN 7.4). */
function polls(ctx: ScenarioContext): void {
  ctx.computer.clock.whenTimer("poll", () => {
    polls(ctx);
    setImmediate(() => ctx.computer.clock.advance(60_000));
  });
}

scenario({
  id: "S-BATCH-2", covers: covers("S-BATCH-2"), modes: ["next"], fixture: "F-BRANCH",
  async run(ctx) {
    const { rafi, step, project, computer } = ctx;
    await step("step 1: --steps 2 --branch-per-ticket --completion pr: a branch, a draft PR per ticket", async () => {
      const r = await rafi("start . --steps 2 --branch-per-ticket --completion pr");
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(remoteBranches(project), ["feature/T1-add-the-parser", "feature/T2-add-the-printer", "main"]);
      for (const [id, b] of [["T1", "feature/T1-add-the-parser"], ["T2", "feature/T2-add-the-printer"]]) {
        assert.match(subject(project, b!), new RegExp(`^${id}: .*\\n[\\s\\S]*Rafi-Ticket: ${id}\\n`));
        assert.equal(git(project, ["rev-list", "--count", `main..${b}`]).trim(), "1", `one commit on ${b}`);
        assert.equal(git(project, ["show", `${b}:src/${id}.txt`]), `${id} done\n`);
        assert.match(git(project, ["show", `${b}:.rafi/progress.yaml`]), /tickets:/, "the views ride along (C196)");
      }
      const prs = computer.gh.prs;
      assert.deepEqual(prs.map((p) => [p.head, p.base, p.draft]), [["feature/T1-add-the-parser", "main", true],
        ["feature/T2-add-the-printer", "main", true]]);
      const bodies = readdirSync(path.join(project, ".foreman", "pr-bodies"));
      assert.equal(bodies.length, 2);
      for (const pr of prs) assert.match(pr.body, new RegExp(pr.head.slice(8, 10)));
      const e = await exported(ctx);
      assert.deepEqual(e.events.filter((x) => x.type === "unit.delivered").map((x) => (x.data as { how: string }).how),
        ["pr-opened"]);
      assert.equal(e.events.filter((x) => x.type === "pr.created").length, 2);
      for (const x of e.events.filter((y) => ["git.pushed", "pr.created", "git.committed"].includes(y.type))) {
        const intent = e.events.filter((y) => y.type === "git.intent" && y.seq < x.seq).at(-1);
        assert.ok(intent, `${x.type} follows a git.intent`);
      }
      onlyViews(project);
      noCiNoForce(ctx, project);
    });
    await step("tickets queue --refresh asks gh for each PR's state now (FLAG-TK-21, C233)", async () => {
      mergePr(computer.gh, computer.gh.prs[0]!.url);
      const r = await rafi("tickets queue --refresh");
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /U1 feature\/T1-add-the-parser: merged https:/);
      assert.match(r.output, /U1 feature\/T2-add-the-printer: open \(draft\) https:/);
      assert.ok(computer.gh.calls.filter((c) => c.args[1] === "view").length >= 2);
    });
    await step("step 2: pr-ready opens ready PRs", async () => {
      const dir = fresh(ctx, "ready");
      const r = await rafi("start . --steps 2 --branch-per-ticket --completion pr-ready", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(computer.gh.prs.map((p) => [p.head, p.draft]), [["feature/T1-add-the-parser", false],
        ["feature/T2-add-the-printer", false]]);
      noCiNoForce(ctx, dir);
    });
    await step("step 2: auto-merge waits on the clock for the merge before the stacked unit starts", async () => {
      const dir = fresh(ctx, "auto");
      computer.gh.mergeAfterViews = 1;
      const started = computer.clock.now().getTime();
      polls(ctx);
      const r = await rafi("start . --steps 4 --completion auto-merge", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx, dir);
      type E = (typeof e.events)[number];
      const seq = (type: string, f: (x: E) => boolean) =>
        e.events.find((x) => x.type === type && f(x))?.seq ?? Infinity;
      const unit = (u: string) => (x: (typeof e.events)[number]) => (x.data as { unit?: string }).unit === u;
      assert.ok(seq("unit.merge_waiting", unit("U2")) < seq("unit.delivered", unit("U2")));
      assert.ok(seq("unit.delivered", unit("U2")) < seq("ticket.started", (x) => x.ticket_id === "T4"),
        "U3 starts only once U2's PR merged");
      assert.ok(computer.clock.now().getTime() - started >= 60_000, "the wait is on the clock");
      assert.ok(computer.gh.prs.every((p) => p.autoMerge === "merge"));
      assert.equal(e.events.filter((x) => x.type === "pr.merged").length, 3);
      noCiNoForce(ctx, dir);
    });
    await step("step 2: direct-merge merges locally and pushes the base", async () => {
      const dir = fresh(ctx, "direct");
      const r = await rafi("start . --steps 2 --branch-per-ticket --completion direct-merge", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      for (const b of ["feature/T1-add-the-parser", "feature/T2-add-the-printer"]) {
        assert.ok(isAncestor(dir, b, "main"), `${b} is in main\n${r.output}`);
      }
      assert.equal(readFileSync(path.join(dir, "src", "T2.txt"), "utf8"), "T2 done\n", "your checkout follows main");
      assert.equal(git(remoteOf(dir), ["rev-parse", "main"]), git(dir, ["rev-parse", "main"]));
      assert.equal(computer.gh.calls.filter((c) => c.args[0] === "pr").length, 0);
      noCiNoForce(ctx, dir);
    });
    await step("step 2: none leaves each branch with its commit; nothing pushed, no PR", async () => {
      const dir = fresh(ctx, "none");
      const r = await rafi("start . --steps 2 --branch-per-ticket --completion none", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(branches(dir), ["feature/T1-add-the-parser", "feature/T2-add-the-printer", "main"]);
      assert.deepEqual(remoteBranches(dir), ["main"]);
      assert.equal(git(dir, ["rev-list", "--count", "main..feature/T2-add-the-printer"]).trim(), "1");
      assert.equal(computer.gh.calls.length, 0);
      onlyViews(dir);
    });
    await step("step 2: --no-branch-per-ticket beats a saved branch-per-ticket", async () => {
      const dir = fresh(ctx, "nobranch", { branch_strategy: "branch-per-ticket" });
      const r = await rafi("start . --steps 2 --no-branch-per-ticket", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(branches(dir), ["main"]);
      assert.equal(readFileSync(path.join(dir, "src", "T1.txt"), "utf8"), "T1 done\n");
      assert.equal(git(dir, ["rev-list", "--count", "HEAD"]).trim(), "1", "no commit: git is left to you");
    });
  },
});
