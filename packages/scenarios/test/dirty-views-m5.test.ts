// Milestone: M5
// Part 6 (M5 review P1, the second): rafi drops or rewrites `docs/ticket-progress.md` in your checkout only when its
// bytes are the ones rafi last wrote. An edit of yours to it is your uncommitted work: the dirty-work rules apply
// (PRM-75, `--dirty-work`), and your bytes stay byte-identical (M5 plan :216), whatever the delivery does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { git } from "../fixtures/common.js";
import { T1, setup } from "./git-race-helpers.js";

const DOC = path.join("docs", "ticket-progress.md");
const MERGE = "start . --steps 1 --branch-per-ticket --completion direct-merge";

function rendered() {
  const s = setup();
  return { ...s, doc: path.join(s.project, DOC) };
}

test("rafi's own unchanged view isn't your work: no dirty question; the direct merge goes ahead", async () => {
  const { project, rafi, exported, of, doc } = rendered();
  assert.equal((await rafi("tickets render")).code, 0);
  assert.ok(existsSync(doc));
  const r = await rafi(MERGE);
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(r.output, /Uncommitted work found/);
  assert.equal(of(await exported(), "unit.delivered").length, 1);
  assert.equal(git(project, ["rev-list", "--count", `main..${T1}`]).trim(), "0", "T1 is merged into main");
  assert.match(readFileSync(doc, "utf8"), /T1/, "rewritten by rafi after the merge");
});

test("your edit to the view is uncommitted work: without a terminal or a flag, exit 1 naming --dirty-work",
  async () => {
    const { rafi, doc } = rendered();
    assert.equal((await rafi("tickets render")).code, 0);
    appendFileSync(doc, "\nmy own note\n");
    const before = readFileSync(doc);
    const r = await rafi(MERGE);
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /--dirty-work preserve/);
    assert.match(r.output, /docs\/ticket-progress\.md/);
    assert.deepEqual(readFileSync(doc), before, "byte-identical");
  });

test("your edit to the view with --dirty-work preserve: built, and your view byte-identical afterwards",
  async () => {
    const { project, rafi, doc } = rendered();
    assert.equal((await rafi("tickets render")).code, 0);
    appendFileSync(doc, "\nmy own note\n");
    const before = readFileSync(doc);
    const r = await rafi(`${MERGE} --dirty-work preserve`);
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(readFileSync(doc), before, "byte-identical");
    const committed = git(project, ["ls-tree", "-r", "--name-only", T1]).split("\n");
    assert.ok(!committed.includes("docs/ticket-progress.md"), "your edited view isn't carried by rafi's commit");
  });

test("your edit to the view during the build, before the direct merge: never deleted or reset", async () => {
  const { rafi, doc } = rendered();
  assert.equal((await rafi("tickets render")).code, 0);
  let before: Buffer | null = null;
  const r = await rafi(MERGE, { pauseAt: { at: (o) => o.startsWith("6: before merge"), fn: async () => {
    appendFileSync(doc, "\nmy own note\n");
    before = readFileSync(doc);
  } } });
  assert.ok(before, `paused before the merge\n${r.output}`);
  assert.match(r.output, /U1 failed \(rejected\): your checkout's changes are in the way/, "the merge is refused");
  assert.deepEqual(readFileSync(doc), before, "byte-identical after the run");
});
