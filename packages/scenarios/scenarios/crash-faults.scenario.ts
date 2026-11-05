// S-CRASH-2 (SCN 3.7), M4 runs (C155, C157): one fault per run, then `rafi resume`. A torn progress file is rebuilt
// from the database with one line; a busy database is waited out on the clock; a full disk on an event append and an
// unwritable `.rafi/` each stop with one line naming the folder and `rafi resume`; a crash halfway through writing a
// requirements file is redone before the builder starts; optional data the disk refuses (a large blob: a malformed
// reply's raw text) is skipped and recorded as skipped, and the build goes on (C157). M5 (C229): on F-BRANCH, a
// failed git commit stops with C155's line and resume commits once; a crash after a ticket's branch is created is
// resumed on that branch and worktree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported, of } from "./m3-helpers.js";
import { B, on } from "../fakes/script/behaviors.js";
import { workFiles } from "../checks/crash.js";
import { git } from "../fixtures/common.js";
import { fBranch } from "../fixtures/f-branch.js";

const T1_BRANCH = "feature/T1-add-the-parser";
/** Your checkout's files: everything outside `.git/`, `.rafi/` and rafi's working files under `.foreman/`. */
const yours = (dir: string) => Object.fromEntries(Object.entries(workFiles(dir))
  .filter(([f]) => !f.startsWith(".foreman")));
const verb = (args: readonly string[]) => args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");

const done = async (ctx: ScenarioContext, dir: string) => new Set((await exported(ctx, dir)).events
  .filter((e) => e.type === "delivery.done").map((e) => e.ticket_id));

/** C229 (M5): the git faults, on F-BRANCH. */
async function gitFaults(ctx: ScenarioContext): Promise<void> {
  const { rafi, step } = ctx;
  await step("a failed git commit (F-BRANCH): C155's one-line stop, your files unchanged; resume makes one commit",
    async () => {
      const dir = fBranch(path.join(ctx.root, "git-commit-fault"));
      const before = yours(dir);
      // C229: the ticket's staging in its worktree can't write git's index (a full disk) until the fault is lifted.
      type Env = Readonly<Record<string, string | undefined>>;
      const faults = { git: (args: readonly string[], cwd: string, env?: Env) =>
        verb(args) === "add" && cwd.includes(".foreman") && !env?.GIT_INDEX_FILE
          ? "fatal: unable to write new index file\n" : null };
      const r = await rafi("start . --steps 1", { cwd: dir, faults });
      assert.equal(r.code, 1, r.output);
      const lines = r.output.split("\n").filter((l) => /^rafi: /.test(l));
      assert.equal(lines.length, 1, r.output);
      assert.match(lines[0]!, /disk is full.*`rafi resume`/, r.output);
      assert.doesNotMatch(r.output, /Internal error|failed \(rejected\)/);
      assert.deepEqual(yours(dir), before, "your files byte-identical after the failed delivery");
      const again = await rafi("resume", { cwd: dir });
      assert.equal(again.code, 0, again.output);
      assert.equal(git(dir, ["rev-list", "--count", `main..${T1_BRANCH}`]).trim(), "1", "exactly one commit");
      assert.equal(of(await exported(ctx, dir), "git.committed", "T1").length, 1);
      assert.deepEqual(yours(dir), before);
    });
  await step("a crash right after T1's branch is created: resume reuses the branch and worktree; one of each",
    async () => {
      const dir = fBranch(path.join(ctx.root, "git-branch-crash"));
      const crashed = await rafi("start . --steps 1", { cwd: dir, crashAt: "6: after branch (T1" });
      assert.ok(crashed.crashed?.startsWith("6: after branch (T1"), crashed.output);
      const r = await rafi("resume", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx, dir);
      assert.equal(of(e, "git.branch_created", "T1").length, 1);
      assert.deepEqual(git(dir, ["branch", "--list", "feature/*", "--format=%(refname:short)"]).trim(), T1_BRANCH);
      assert.equal(git(dir, ["worktree", "list", "--porcelain"]).split("\n")
        .filter((l) => l.startsWith("worktree ")).length, 2, "the main checkout and T1's one worktree");
      assert.equal(git(dir, ["rev-list", "--count", `main..${T1_BRANCH}`]).trim(), "1", "exactly one commit");
    });
}

scenario({
  id: "S-CRASH-2", covers: registry.find((r) => r.id === "S-CRASH-2")!.covers, modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, fixture, computer } = ctx;
    await step("a torn .rafi/progress.yaml: rebuilt from the database with one line; nothing lost", async () => {
      const dir = fixture("F-CHAIN");
      const torn = await rafi("start . --steps 2", { cwd: dir, faults: { tornWrite: /progress\.yaml$/, at: 3 } });
      assert.ok(torn.crashed, torn.output);
      const before = (await exported(ctx, dir)).events.length;
      const r = await rafi("resume", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.equal(r.output.split("\n").filter((l) => /progress\.yaml was damaged/.test(l)).length, 1, r.output);
      assert.ok((await exported(ctx, dir)).events.length > before);
      assert.match(readFileSync(path.join(dir, ".rafi", "progress.yaml"), "utf8"), /^version: 1$/m);
      assert.equal((await done(ctx, dir)).size, 2);
    });
    await step("the database busy for 5 s on the clock: rafi waits and goes on", async () => {
      const dir = fixture("F-CHAIN");
      const t0 = computer.clock.now().getTime();
      const r = await rafi("start . --steps 2", { cwd: dir, faults: { busyMs: 5_000 } });
      assert.equal(r.code, 0, r.output);
      assert.ok(computer.clock.now().getTime() - t0 >= 5_000);
      assert.equal((await done(ctx, dir)).size, 2);
    });
    await step("a full disk on an event append: one line naming the folder and rafi resume; resume works after",
      async () => {
        const dir = fixture("F-CHAIN");
        const full = await rafi("start . --steps 2", { cwd: dir, faults: { fullOnAppend: 25 } });
        assert.equal(full.code, 1, full.output);
        const lines = full.output.split("\n").filter((l) => /disk is full/.test(l));
        assert.equal(lines.length, 1, full.output);
        assert.ok(lines[0]!.includes(path.join(dir, ".rafi")) && lines[0]!.includes("`rafi resume`"), lines[0]);
        assert.doesNotMatch(full.output, /Internal error/);
        const kept = (await exported(ctx, dir)).events;
        const r = await rafi("resume", { cwd: dir });
        assert.equal(r.code, 0, r.output);
        const after = (await exported(ctx, dir)).events;
        assert.deepEqual(after.slice(0, kept.length), kept, "nothing recorded was lost");
        assert.equal((await done(ctx, dir)).size, 2);
      });
    await step("an unwritable .rafi/: one line naming it", async () => {
      const dir = fixture("F-CHAIN");
      assert.equal((await rafi("start . --steps 1", { cwd: dir })).code, 0);
      chmodSync(path.join(dir, ".rafi"), 0o500);
      try {
        const r = await rafi("start . --steps 1", { cwd: dir });
        assert.equal(r.code, 1, r.output);
        assert.equal(r.output.split("\n").filter((l) => l.includes(path.join(dir, ".rafi"))).length, 1, r.output);
        assert.doesNotMatch(r.output, /Internal error/);
      } finally {
        chmodSync(path.join(dir, ".rafi"), 0o700);
      }
    });
    await step("a crash halfway through writing a requirements file: rewritten before the builder starts", async () => {
      const dir = fixture("F-CHAIN");
      const crashed = await rafi("start . --steps 1", { cwd: dir,
        faults: { tornWrite: /docs\/requirements\/T1\.md$/, at: 1 } });
      assert.ok(crashed.crashed);
      const file = path.join(dir, "docs", "requirements", "T1.md");
      const half = readFileSync(file, "utf8");
      const r = await rafi("resume", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx, dir);
      const at = (type: string) => e.events.findIndex((x) => x.type === type && x.ticket_id === "T1");
      assert.ok(at("requirements.written") >= 0 && at("requirements.written") < at("builder.reported"));
      assert.equal(of(e, "requirements.written", "T1").length, 1);
      const written = of(e, "requirements.written", "T1")[0] as { fp: string };
      const now = readFileSync(file, "utf8");
      assert.ok(now.length > half.length, "the half-written file was rewritten");
      assert.equal(`sha256:${createHash("sha256").update(now).digest("hex")}`, written.fp);
    });
    await gitFaults(ctx);
    await step("optional data refused for lack of space: skipped and recorded as skipped; the build continues",
      async () => {
        const dir = fixture("F-CHAIN");
        // T1's first build reply is malformed and 70 KB long: its raw text is a blob the full disk refuses.
        computer.script.rules.push(on("builder T1#1 @build", B.malformed(70_000)));
        const r = await rafi("start . --steps 2", { cwd: dir, faults: { refuseBlobsOver: 64 * 1024 } });
        assert.equal(r.code, 0, r.output);
        const e = (await exported(ctx, dir)).events;
        const skipped = e.filter((x) => x.type === "turn.activity" && x.data.kind === "skipped");
        assert.equal(skipped.length, 1, JSON.stringify(skipped));
        assert.match(String(skipped[0]!.data.text), /^the reply's raw text \(\d+ bytes\) not stored: disk full$/);
        assert.equal(skipped[0]!.data.key, "T1:build:1");
        const reply = e.find((x) => x.type === "turn.reply" && x.data.key === "T1:build:1" && x.data.outcome !== "ok");
        assert.equal(reply?.data.raw, null, "the reply is recorded without its raw text");
        assert.equal((await done(ctx, dir)).size, 2, "the build continued");
        assert.match((await rafi("resume", { cwd: dir })).output, /Nothing to resume\./);
      });
  },
});
