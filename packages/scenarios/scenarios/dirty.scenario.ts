// S-BATCH-3 (M5 plan item 13, slice 7; C206): F-DIRTY. In a terminal, "Uncommitted work found. How should the
// isolated build start?"; `--dirty-work preserve` builds in worktrees from committed code; `include` from a private
// baseline commit made through a separate index, with no commit on and no switch of your branch. Both keep their
// worktrees and make no merge or PR. In every step your files are byte-identical afterwards. No terminal and no
// flag: exit 1 naming --dirty-work.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import { git } from "../fixtures/common.js";
import { fDirty } from "../fixtures/f-dirty.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

/** sha256 of every tracked and untracked file outside rafi's own folders. */
function yours(dir: string): Record<string, string> {
  const files = git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0")
    .filter((f) => f && !/^(\.rafi|\.foreman)\//.test(f));
  return Object.fromEntries(files.sort().map((f) => [f, existsSync(path.join(dir, f))
    ? createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex") : "missing"]));
}

const head = (dir: string) => [git(dir, ["rev-parse", "HEAD"]).trim(), git(dir, ["symbolic-ref", "HEAD"]).trim()];
const worktrees = (dir: string) => readdirSync(path.join(dir, ".foreman", "worktrees")).sort();

function fresh(ctx: ScenarioContext, name: string) {
  const dir = fDirty(path.join(ctx.root, name));
  return { dir, before: yours(dir), at: head(dir) };
}

scenario({
  id: "S-BATCH-3", covers: covers("S-BATCH-3"), modes: ["next"], fixture: "none",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    await step("step 1: in a terminal, PRM-75 asks how the isolated build should start", async () => {
      const f = fresh(ctx, "ask");
      const r = await rafi("start . --steps 2", { cwd: f.dir, tty: true, input: ["3"] });
      assert.match(r.output, /Uncommitted work found\. How should the isolated build start\?/);
      assert.match(r.output, /From committed code \(Recommended\)[\s\S]*Include my uncommitted work[\s\S]*Cancel/);
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(yours(f.dir), f.before);
      assert.ok(!computer.sentToAgents.length, "nothing ran");
    });
    await step("no terminal and no flag: exit 1 naming --dirty-work", async () => {
      const f = fresh(ctx, "none");
      const r = await rafi("start . --steps 2", { cwd: f.dir });
      assert.equal(r.code, 1);
      assert.match(r.output, /--dirty-work preserve/);
      assert.deepEqual(yours(f.dir), f.before);
    });
    await step("step 2: --dirty-work preserve builds in worktrees from committed code", async () => {
      const f = fresh(ctx, "preserve");
      const r = await rafi("start . --steps 2 --dirty-work preserve", { cwd: f.dir });
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(worktrees(f.dir), ["feature-T1-ticket-1", "feature-T2-ticket-2"], "kept");
      const t1 = "feature/T1-ticket-1";
      assert.equal(git(f.dir, ["rev-parse", `${t1}^`]).trim(), f.at[0], "from your last commit");
      assert.ok(!git(f.dir, ["show", "--name-only", "--format=", t1]).includes("notes/"));
      assert.deepEqual(head(f.dir), f.at);
      assert.deepEqual(yours(f.dir), f.before, "your files byte-identical");
      const e = await exported(ctx, f.dir);
      assert.ok(!e.events.some((x) => ["unit.ready", "pr.created", "git.pushed", "unit.delivered"].includes(x.type)));
    });
    await step("step 3: --dirty-work include builds from a private baseline; your branch untouched", async () => {
      const f = fresh(ctx, "include");
      const r = await rafi("start . --steps 2 --dirty-work include", { cwd: f.dir });
      assert.equal(r.code, 0, r.output);
      const recorded = readdirSync(path.join(f.dir, ".foreman", "dirty-baselines"));
      assert.equal(recorded.length, 1);
      const base = JSON.parse(readFileSync(path.join(f.dir, ".foreman", "dirty-baselines", recorded[0]!), "utf8"));
      assert.equal(base.head, f.at[0]);
      assert.equal(git(f.dir, ["show", `${base.commit}:notes/a.md`]), "# my notes\n");
      assert.equal(git(f.dir, ["show", `${base.commit}:src/T1.txt`]), "T1 start\nmy uncommitted edit\n");
      assert.equal(git(f.dir, ["rev-parse", "feature/T2-ticket-2^"]).trim(), base.commit, "worktrees from it");
      assert.deepEqual(head(f.dir), f.at, "no commit on, no switch of, your branch");
      assert.deepEqual(worktrees(f.dir), ["feature-T1-ticket-1", "feature-T2-ticket-2"]);
      assert.deepEqual(yours(f.dir), f.before, "your files byte-identical");
      assert.equal(git(f.dir, ["diff", "--cached", "--name-only"]), "", "your index untouched");
    });
  },
});
