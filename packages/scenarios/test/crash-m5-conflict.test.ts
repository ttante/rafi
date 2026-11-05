// Milestone: M5
// M5 part 4c (plan 10.10's open item; C237, C235): a conflict fix ticket resumed after a crash mid-merge. As 19b's
// direct-merge case (delivery-m5.test.ts): U2's merge into main conflicts in src/T3.txt, "Builder resolves the
// conflict" adds FIX-1, and rafi starts merging main into U2's branch in its worktree. The build is killed at each
// point between that start and the merge's commit: right after the merge started, while the builder's turn is out,
// right before the commit, and right after it (before it's recorded). `rafi resume` finishes each with one merge
// commit with both parents and no markers, one `unit.delivered`, one branch, and T3 never out of `done`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "../fixtures/common.js";
import { gitAs } from "../fixtures/f-branch.js";
import { on } from "../fakes/script/behaviors.js";
import { tempRoot } from "../fixtures/common.js";
import { restore, takeSnapshot, type Snapshot } from "../harness/fork.js";
import { rafiRunner } from "../harness/rafi.js";
import type { EventsExport } from "../checks/invariants.js";
import { once, setup, trailers } from "./git-race-helpers.js";

const T3 = "feature/T3-add-the-store";
const U2 = [{ id: "U2", tickets: ["T3"] }, { id: "U1", tickets: ["T1", "T2", "T4"] }];
const resolve = () => on("builder FIX-1", { steps: [{ edit: "src/T3.txt", content: "resolved\n" }],
  reply: { kind: "done", summary: "Resolved the conflict.", runs: [], block: null, question: null } });

const POINTS = ["6: after merge (FIX-1", "2: sent, before any reply (FIX-1, build", "6: before commit (FIX-1",
  "6: after commit (FIX-1"];

/** P33: every case starts from the same state (U2's merge conflicted, the delivery question open), so the first
 * build runs once and each case gets its own copy of it. */
let base: Promise<Snapshot[]> | undefined;
function firstBuild(): Promise<Snapshot[]> {
  base ??= (async () => {
    const { project, computer, rafi } = setup({ config: { checks: { ci_tests: "none" } }, units: U2,
      build: { completion: "direct-merge" } });
    const onGit = once((a) => {
      if (a[0] !== "merge-tree") return false;
      writeFileSync(path.join(project, "src", "T3.txt"), "yours\n");
      git(project, ["add", "--", "src/T3.txt"]);
      gitAs(project, ["commit", "-qm", "you: src/T3.txt"]);
      return true;
    });
    const first = await rafi("start . --ticket T3 --branch-per-ticket", { onGit });
    assert.match(first.output, /U2 failed \(conflict\)/);
    const into = tempRoot();
    return POINTS.map((_, i) => takeSnapshot(computer, project, into, "after the first build", i));
  })();
  return base;
}

for (const [i, at] of POINTS.entries()) {
  test(`a crash at "${at} …)" in the conflict fix: resume merges once, delivers once; T3 stays done`, async () => {
    const restored = restore((await firstBuild())[i]!);
    const { project } = restored;
    // A turn the crash cut short used its rule; the redo gets the same one.
    const computer = { ...restored.computer, script: { ...restored.computer.script,
      rules: [...restored.computer.script.rules, resolve(), resolve()] } };
    const rafi = rafiRunner(computer, project);
    const exported = async () => JSON.parse((await rafi("stats export")).out) as EventsExport;
    const of = (e: EventsExport, type: string) => e.events.filter((x) => x.type === type);
    const crashed = await rafi("resume", { tty: true, input: ["1"], crashAt: at });
    assert.ok(crashed.crashed?.startsWith(at), crashed.output);
    const r = await rafi("resume");
    assert.equal(r.code, 0, r.output);
    const e = await exported();
    assert.deepEqual(of(e, "ticket.added").map((x) => x.ticket_id), ["FIX-1"], "one fix ticket");
    assert.equal(of(e, "git.branch_created").length, 1, "no branch for FIX-1");
    assert.equal(of(e, "unit.delivered").length, 1, r.output);
    assert.equal(of(e, "git.committed").filter((x) => x.ticket_id === "FIX-1").length, 1);
    assert.deepEqual(e.events.filter((x) => x.ticket_id === "T3" && ["ticket.reopened", "ticket.status_set"]
      .includes(x.type)), [], "T3 stays done");
    const fixes = trailers(project, T3, "FIX-1");
    assert.equal(fixes.length, 1, "one merge commit");
    assert.equal(git(project, ["rev-list", "--parents", "-n", "1", fixes[0]!]).trim().split(" ").length, 3,
      "two parents");
    assert.equal(git(project, ["show", "main:src/T3.txt"]), "resolved\n");
    assert.throws(() => git(project, ["grep", "-q", "-e", "<<<<<<<", "main", "--"]), "no markers on main");
  });
}
