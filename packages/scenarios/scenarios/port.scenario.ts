// S-PORT-2 (M5 plan item 17, slice 9; ARCH 3.6 `:390`, 3.7 `:413-414`; C224, C225, C300): two clones of F-CHAIN at
// one commit. Clone 1 runs `--steps 3` and is killed in T2's builder turn after T1 is done; clone 2 builds T3; each
// commits its work and its `.rafi/progress.yaml`. Merging clone 2 into clone 1 leaves a conflict in the progress
// file; `rafi resume` takes the newer entry per ticket, writes a clean file, says which side it kept for each
// conflicting ticket, and the build continues with T1 and T3 done. Step 4: a clone whose database is older than its
// file; `rafi status` shows the file's state from memory and says so, writing nothing; the next `rafi resume`
// imports it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { registry } from "../checks/registry.js";
import { git, GIT_ENV } from "../fixtures/common.js";
import { copyProject, scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported, of } from "./m3-helpers.js";

const KILL_T2 = "2: sent, before any reply (T2, build";
const PROGRESS = path.join(".rafi", "progress.yaml");
const statuses = (dir: string) => Object.fromEntries(Object.entries((parse(readFileSync(path.join(dir, PROGRESS),
  "utf8")) as { tickets: Record<string, { status: string }> }).tickets).map(([k, v]) => [k, v.status]));

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", message]);
}

/** sha256 of every file under the project (rafi's database included), so a reader that writes anything shows. */
function everyFile(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (name === ".git") continue;
    if (statSync(file).isDirectory()) everyFile(file, base, out);
    else out[path.relative(base, file)] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return out;
}

const started = async (ctx: ScenarioContext, dir: string) => of(await exported(ctx, dir), "ticket.started")
  .length;

scenario({
  id: "S-PORT-2", covers: registry.find((r) => r.id === "S-PORT-2")!.covers, modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, fixture } = ctx;
    const one = fixture("F-CHAIN");
    const two = fixture("F-CHAIN");
    await step("clone 1 builds T1, clone 2 builds T3; each commits", async () => {
      assert.equal(git(one, ["rev-parse", "HEAD"]), git(two, ["rev-parse", "HEAD"]), "two clones of one commit");
      const killed = await rafi("start . --steps 3", { cwd: one, crashAt: KILL_T2 });
      assert.ok(killed.crashed, killed.output);
      assert.equal(statuses(one).T1, "done");
      ctx.computer.clock.advance(60_000);
      const r = await rafi("start . --ticket T3", { cwd: two });
      assert.equal(r.code, 0, r.output);
      assert.equal(statuses(two).T3, "done");
      commitAll(one, "clone 1: T1");
      commitAll(two, "clone 2: T3");
    });
    await step("merging leaves a conflict in .rafi/progress.yaml", () => {
      git(one, ["fetch", "-q", two, "main:clone-2"]);
      const merge = spawnSync("git", ["-C", one, "merge", "--no-ff", "--no-edit", "clone-2"], { encoding: "utf8",
        env: { ...process.env, ...GIT_ENV } });
      assert.notEqual(merge.status, 0, merge.stderr);
      assert.match(git(one, ["diff", "--name-only", "--diff-filter=U"]), /^\.rafi\/progress\.yaml$/m, merge.stderr);
      assert.match(readFileSync(path.join(one, PROGRESS), "utf8"), /^<{7} /m);
    });
    await step("rafi resume: the newer entry per ticket, a clean file, one line per conflicting ticket naming the " +
      "side; T1 and T3 done; the build continues", async () => {
      const r = await rafi("resume", { cwd: one });
      assert.equal(r.code, 0, r.output);
      const kept = r.output.split("\n").filter((l) => /^(rafi: )?T\d: kept (ours|theirs) \(/.test(l));
      assert.ok(kept.some((l) => /T1: kept ours \(\d\d:\d\d vs 00:00\)/.test(l)), r.output);
      assert.ok(kept.some((l) => /T3: kept theirs \(\d\d:\d\d vs 00:00\)/.test(l)), r.output);
      assert.equal(new Set(kept.map((l) => /T\d/.exec(l)![0])).size, kept.length, "one line per ticket");
      assert.match(r.output, /Rebuilt build state from \.rafi\/progress\.yaml\./);
      const text = readFileSync(path.join(one, PROGRESS), "utf8");
      assert.doesNotMatch(text, /^(<{7}|={7}|>{7})/m, "a clean file");
      const now = statuses(one);
      assert.deepEqual([now.T1, now.T2, now.T3], ["done", "done", "done"], text);
      const e = await exported(ctx, one);
      assert.deepEqual(of(e, "progress.imported").map((x) => (x as { entry: { key: string } }).entry.key), ["T3"]);
      assert.ok(!e.events.some((x) => x.type === "ticket.started" && x.ticket_id === "T3"), "T3 isn't rebuilt");
      assert.ok(e.events.some((x) => x.type === "delivery.done" && x.ticket_id === "T2"), "the build continued");
    });
    await step("a clone whose database is older than its file: rafi status shows the file's state in memory and " +
      "says so, writing nothing; the next rafi resume imports it", async () => {
      const a = fixture("F-CHAIN");
      const killed = await rafi("start . --steps 2", { cwd: a, crashAt: KILL_T2 });
      assert.ok(killed.crashed, killed.output);
      const b = copyProject(a);
      ctx.computer.clock.advance(60_000); // the other computer goes on a minute later
      assert.equal((await rafi("resume", { cwd: a })).code, 0);
      assert.equal(statuses(a).T2, "done");
      copyFileSync(path.join(a, PROGRESS), path.join(b, PROGRESS));
      const events = (await rafi("stats export", { cwd: b })).out;
      const files = everyFile(b); // after a first reader opened the database (SQLite's -wal and -shm exist then)
      const s = await rafi("status", { cwd: b });
      assert.equal(s.code, 0, s.output);
      assert.match(s.output, /\.rafi\/progress\.yaml/, s.output);
      assert.match(s.output, /in memory/, s.output);
      assert.match(s.output, /T2 done/, s.output);
      assert.match(s.output, /rafi resume/, s.output);
      assert.deepEqual(everyFile(b), files, "status wrote nothing");
      assert.equal((await rafi("stats export", { cwd: b })).out, events, "the log is unchanged");
      const before = await started(ctx, b);
      const r = await rafi("resume", { cwd: b });
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /Rebuilt build state from \.rafi\/progress\.yaml\./);
      const e = await exported(ctx, b);
      assert.deepEqual(of(e, "progress.imported").map((x) => (x as { entry: { key: string; status: string } })
        .entry).map((x) => [x.key, x.status]), [["T2", "done"]]);
      assert.equal(e.events.filter((x) => x.type === "ticket.started" && x.ticket_id === "T2").length, 1,
        "T2 isn't built again here");
      assert.ok((await started(ctx, b)) >= before);
    });
  },
});
