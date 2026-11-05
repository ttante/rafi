// Milestone: M5
// M5 part 4c (C380; found by fork C's crash work): a conflict fix ticket (C237) that can't resolve the conflict
// (its checks circle) is blocked as unfixed, and its unit was never delivered, so the build must not finish as
// complete. As 19b's direct-merge case: U2's merge conflicts, "Builder resolves the conflict" adds FIX-1, and the
// builder's redo leaves the markers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "../fixtures/common.js";
import { gitAs } from "../fixtures/f-branch.js";
import { on } from "../fakes/script/behaviors.js";
import { once, setup } from "./git-race-helpers.js";

test("C380: an unfixed conflict fix ticket leaves the build incomplete and its unit undelivered", async () => {
  const { project, computer, rafi, exported, of } = setup({ config: { checks: { ci_tests: "none" } },
    units: [{ id: "U2", tickets: ["T3"] }, { id: "U1", tickets: ["T1", "T2", "T4"] }],
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
  // The builder's only reply resolves nothing: the markers stay, the checks fail the same way until circling.
  computer.script.rules.push(on("builder FIX-1", { steps: [],
    reply: { kind: "done", summary: "Tried.", runs: [], block: null, question: null } }));
  const r = await rafi("resume", { tty: true, input: ["1"] });
  const e = await exported();
  assert.equal(of(e, "unit.delivered").length, 0, r.output);
  const finished = of(e, "build.finished").map((x) => (x.data as { complete: boolean }).complete);
  assert.deepEqual(finished, [false], "the resumed build finishes incomplete");
  assert.notEqual(r.code, 0, r.output);
});
