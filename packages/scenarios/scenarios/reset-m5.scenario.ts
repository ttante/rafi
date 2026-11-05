// S-SCN-2 and S-CLI-14's M5 part (M5 plan item 14, slice 7; C154, C261): F-DIRTY after an interrupted build that
// works in per-ticket worktrees (`--dirty-work preserve`), with a bare remote and the fake gh. Reset previews first,
// offers exactly restart-current and archive-restart (plus cancel) for this build, refuses the dropped actions, acts
// only on the working trees the build worked in (your checkout, its edit and its untracked folder stay
// byte-identical), keeps the plan approval through "everything", keeps the log, refuses a live build, never pushes
// or closes a PR; `rafi tickets reset` changes only tracker state. The variants fork from one interrupted build (P33).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import { git } from "../fixtures/common.js";
import { fDirty } from "../fixtures/f-dirty.js";
import { openPr } from "../fakes/gh.js";
import { copyProject, scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported, of } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
const CRASH = "3: reply arrived, before it's recorded (T2";
const T2_TREE = path.join(".foreman", "worktrees", "feature-T2-ticket-2");

/** sha256 of every tracked and untracked file of your checkout outside rafi's own folders. */
function yours(dir: string): Record<string, string> {
  const files = git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0")
    .filter((f) => f && !/^(\.rafi|\.foreman|docs\/ticket-progress\.md)/.test(f));
  return Object.fromEntries(files.sort().map((f) => [f, existsSync(path.join(dir, f))
    ? createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex") : "missing"]));
}

/** F-DIRTY with a plan, a bare `origin` and a PR of an earlier build; built until T2's builder replied, then killed. */
async function interrupted(ctx: ScenarioContext, name: string): Promise<{ dir: string; run: string }> {
  const dir = fDirty(path.join(ctx.root, name));
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs", "rafi-plan.json"), `${JSON.stringify({ version: 1, plan_id: "pln_fixture",
    revision: 1, summary: "Fixture plan", slices: [] })}\n`);
  git(dir, ["add", "docs/rafi-plan.json"]);
  git(dir, ["commit", "-qm", "plan"]);
  const remote = path.join(ctx.root, name, "remote.git");
  git(ctx.root, ["init", "-q", "--bare", remote]);
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["push", "-q", "origin", "main"]);
  openPr(ctx.computer.gh, { head: "feature/earlier", base: "main" });
  const r = await ctx.rafi("start . --steps 3 --dirty-work preserve --auto-approve", { cwd: dir, crashAt: CRASH });
  assert.ok(r.crashed, r.output);
  const run = (await exported(ctx, dir)).events.find((e) => e.type === "build.started")!.run_id!;
  return { dir, run };
}

/** P33's byte copy, with its worktrees re-linked to the copy (a worktree's `.git` names its repo by path). */
function forked(dir: string): string {
  const copy = copyProject(dir);
  for (const name of readdirSync(path.join(copy, ".foreman", "worktrees"))) {
    const tree = path.join(copy, ".foreman", "worktrees", name);
    const id = path.basename(readFileSync(path.join(tree, ".git"), "utf8").trim());
    writeFileSync(path.join(tree, ".git"), `gitdir: ${path.join(copy, ".git", "worktrees", id)}\n`);
    writeFileSync(path.join(copy, ".git", "worktrees", id, "gitdir"), `${path.join(tree, ".git")}\n`);
  }
  return copy;
}

const t2File = (dir: string) => readFileSync(path.join(dir, T2_TREE, "src", "T2.txt"), "utf8");

scenario({
  id: "S-SCN-2", covers: covers("S-SCN-2"), modes: ["next"], fixture: "none",
  async run(ctx) {
    const { rafi, step } = ctx;
    for (const [name, line] of [["this build, restart-current, handled",
      "reset --build --action restart-current --cleanup handled --yes"], ["everything", "reset --everything --yes"]]) {
      await step(`${name}: no error; the untracked folder byte-identical`, async () => {
        const { dir } = await interrupted(ctx, name.replace(/\W+/g, "-"));
        const before = yours(dir);
        const r = await rafi(line!, { cwd: dir });
        assert.equal(r.code, 0, r.output);
        assert.doesNotMatch(r.output, /error|failed/i);
        assert.deepEqual(yours(dir), before);
        assert.equal(readFileSync(path.join(dir, "notes", "a.md"), "utf8"), "# my notes\n");
      });
    }
  },
});

/** One variant of "this build", typed in a terminal; returns the result and the git calls it made. */
async function variant(ctx: ScenarioContext, dir: string, input: string[]) {
  const calls: string[][] = [];
  const r = await ctx.rafi("reset", { cwd: dir, tty: true, input, onGit: (a) => { calls.push([...a]); } });
  return { r, calls };
}

/** "This build": restart-current with stash, discard and handled, and archive-restart (SCN :1338), four variants,
 * each on its own copy of the interrupted build (P33). */
async function variants(ctx: ScenarioContext, base: { dir: string; run: string }): Promise<void> {
  const { step } = ctx;
  const cases: [string, string[], (dir: string) => void][] = [
    ["restart-current, stash", ["1", "1", "1", "1"], (dir) => {
      assert.equal(t2File(dir), "T2 start\n");
      assert.match(git(dir, ["stash", "list"]), /rafi reset/);
    }],
    ["restart-current, discard", ["1", "1", "2", "1"], (dir) => assert.equal(t2File(dir), "T2 start\n")],
    ["restart-current, handled", ["1", "1", "3", "1"], (dir) => assert.equal(t2File(dir), "T2 done\n")],
    ["archive-restart", ["1", "2", "1"], (dir) => {
      assert.equal(t2File(dir), "T2 start\n");
      assert.equal(git(dir, ["show", `rafi/archive/${base.run}:src/T2.txt`]), "T2 done\n");
    }],
  ];
  for (const [name, input, check] of cases) {
    await step(`this build, ${name}: previewed first; only the build's worktree changes; nothing pushed`,
      async () => {
      const dir = forked(base.dir);
      const before = yours(dir);
      const { r, calls } = await variant(ctx, dir, input);
      assert.equal(r.code, 0, r.output);
      const preview = r.output.indexOf(`This resets build ${base.run}`);
      assert.ok(preview >= 0 && preview < r.output.indexOf("Reset?\n"), "the preview comes before the confirm");
      assert.match(r.output, /The same, as a command: rafi reset --build/);
      check(dir);
      assert.deepEqual(yours(dir), before, "your checkout: the edit and notes/ byte-identical");
      const verb = (a: string[]) => a.find((x) => !x.startsWith("-") && !x.includes("="));
      assert.ok(!calls.some((a) => verb(a) === "push" || a.includes("--force")), JSON.stringify(calls));
      const reset = of(await exported(ctx, dir), "build.reset") as { tickets: string[] }[];
      assert.deepEqual(reset.map((x) => x.tickets), [["T2"]]);
    });
  }
}

scenario({
  id: "S-CLI-14", covers: covers("S-CLI-14"), modes: ["next"], fixture: "none",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    let base = { dir: "", run: "" };
    await step("setup: F-DIRTY, a plan, a remote and the fake gh; the build is killed after T2's builder replied",
      async () => {
        base = await interrupted(ctx, "base");
        assert.equal(t2File(base.dir), "T2 done\n", "T2's builder changed its worktree");
      });
    await step("the first question is this build, everything or the plan; this build offers exactly two, plus cancel",
      async () => {
        const dir = forked(base.dir);
        const n = (await exported(ctx, dir)).events.length;
        const r = await rafi("reset", { cwd: dir, tty: true, input: ["1", "3"] });
        assert.equal(r.code, 0, r.output);
        assert.match(r.output,
          /Reset this build, everything, or the plan\?\n {2}1\. This build\n {2}2\. Everything\n {2}3\. The plan/);
        const offered = r.output.slice(r.output.indexOf("How should Rafi restart this build?"));
        assert.deepEqual([...offered.matchAll(/^ {2}\d\. (.+)$/gm)].map((m) => m[1]!.split(":")[0]),
          ["Restart current", "Archive and restart", "Cancel"]);
        assert.match(r.output, /Cancelled; nothing was reset\./);
        assert.equal((await exported(ctx, dir)).events.length, n, "nothing written");
      });
    await step("the dropped start-over actions exit 1 as unknown", async () => {
      for (const a of ["archive-new-branch", "new-branch", "retain-merged", "revert-branch", "manual"]) {
        const r = await rafi(`reset --build --action ${a} --cleanup handled --yes`, { cwd: base.dir });
        assert.equal(r.code, 1, a);
        assert.match(r.output, /--action takes restart-current, archive-restart\./, a);
      }
    });
    await variants(ctx, base);
    await step("everything: tickets back, the plan approval kept (a build without a terminal asks nothing)",
      async () => {
        const dir = forked(base.dir);
        const r = await rafi("reset --everything --yes", { cwd: dir });
        assert.equal(r.code, 0, r.output);
        assert.deepEqual((of(await exported(ctx, dir), "build.reset") as { tickets: string[] }[])[0]!.tickets.sort(),
          ["T1", "T2", "T3", "T4", "T5", "T6", "T7"].filter((id) => r.output.includes(id)).sort());
        const again = await rafi("start . --steps 1 --dirty-work preserve", { cwd: dir });
        assert.equal(again.code, 0, again.output);
        assert.doesNotMatch(again.output, /How does this plan look|--auto-approve/);
        assert.match((await rafi(`stats show --run ${base.run}`, { cwd: dir })).output,
          new RegExp(`^Run ${base.run}: reset`, "m"), "the old run stays in stats");
      });
    await ctx.pending("reset the plan: the chosen revision becomes current again (GUI-INS-8)", "M8");
    await step("refused while a build runs; nothing changes", async () => {
      const dir = forked(base.dir);
      let refused = "";
      const r = await rafi("resume", { cwd: dir, pauseAt: { at: (o: string) => o.startsWith("1: intent, before " +
        "sending (T3"), fn: async () => {
        refused = (await rafi("reset --build --action restart-current --cleanup discard --yes", { cwd: dir })).output;
      } } });
      assert.equal(r.code, 0, r.output);
      assert.match(refused, /is running; reset changes nothing while a build runs/);
    });
    await step("the fakes record no force-push and no PR close; the earlier PR is still open", () => {
      assert.ok(!computer.gh.calls.some((c) => c.args.includes("close")), "no PR close");
      assert.deepEqual(computer.gh.prs.map((p) => p.state), ["OPEN", "OPEN", "OPEN"].slice(0, computer.gh.prs.length));
    });
    await step("rafi tickets reset T3 changes only tracker state", async () => {
      const dir = forked(base.dir);
      const tickets = readFileSync(path.join(dir, ".tickets", "tickets.yaml"), "utf8");
      const before = yours(dir);
      const head = git(dir, ["rev-parse", "HEAD"]);
      const t2 = t2File(dir);
      const n = (await exported(ctx, dir)).events.length;
      const r = await rafi("tickets reset T3 -y", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const added = (await exported(ctx, dir)).events.slice(n).filter((e) => e.type !== "project.created");
      assert.deepEqual(added.map((e) => [e.type, e.ticket_id]), [["ticket.status_set", "T3"]]);
      assert.equal(readFileSync(path.join(dir, ".tickets", "tickets.yaml"), "utf8"), tickets);
      assert.deepEqual(yours(dir), before);
      assert.equal(git(dir, ["rev-parse", "HEAD"]), head);
      assert.equal(t2File(dir), t2);
    });
  },
});
