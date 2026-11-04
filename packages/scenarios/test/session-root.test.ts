// Item 20 (M3 plan, C128, C108): session roots. After drift, QA's review runs in a new session rooted at the copy:
// its agent cwd, its run_check's check cwd and sandbox worktree are the copy; the in-place session closes before the
// copy's opens and the copy's closes before cleanup; the next review after a copy review opens a new session and
// gets the full message. (In-process Claude fake on F-TESTS-LOCAL.)
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { B, on } from "../fakes/script/behaviors.js";
import type { Behavior, MetaLike, TurnContext } from "../fakes/script/engine.js";
import { tempRoot } from "../fixtures/common.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

test("a copy review has its own session and roots; closes are ordered; the next review is new and full", async () => {
  const root = tempRoot();
  const project = fTestsLocal(root);
  const computer = newComputer(root);
  const copyReview = (meta: MetaLike, ctx: TurnContext): Behavior => ({
    ...(B.reject({ 1: "not yet" })(meta, ctx)), steps: [{ runCheck: "fake-test t1.test" }] });
  computer.script.rules.push(on("qa T1#1 @review", B.outside({ edit: "src/T1.txt", content: "yours\n" })),
    on("qa T1#1 @review", copyReview));
  const rafi = rafiRunner(computer, project);
  const r = await rafi("start . --ticket T1 --steps 1");
  assert.equal(r.code, 0, r.output);
  const copies = path.join(project, ".rafi", "cache", "qa-copy") + path.sep;
  const reviews = computer.script.transcript.filter((t) => t.ticket === "T1" && t.step === "review");
  assert.deepEqual(reviews.map((t) => [t.attempt, t.session, t.cwd?.startsWith(copies)]),
    [[1, "new", false], [1, "new", true], [2, "new", false]]);
  assert.doesNotMatch(reviews[2]!.message, /again, after the builder's fix/, "after a copy review: the full message");
  const copy = reviews[1]!.cwd!;
  const qaRuns = computer.checks.log.filter((l) => l.args.includes("t1.test") && l.cwd === copy);
  assert.equal(qaRuns.length, 1, JSON.stringify(computer.checks.log.map((l) => [l.cwd, l.args])));
  assert.ok(qaRuns[0]!.sandbox.some((a) => a.includes(copy)), "the sandbox's worktree is the copy");
  const sessions = computer.script.sessions!;
  const inPlaceClose = sessions.findIndex((s) => s.op === "close" && s.cwd === project &&
    sessions.indexOf(s) > sessions.findIndex((x) => x.op === "open" && x.cwd === project && x !== sessions[0]));
  const copyOpen = sessions.findIndex((s) => s.op === "open" && s.cwd === copy);
  const copyClose = sessions.findIndex((s) => s.op === "close" && s.cwd === copy);
  assert.ok(inPlaceClose >= 0 && inPlaceClose < copyOpen, JSON.stringify(sessions));
  assert.ok(copyClose > copyOpen && sessions[copyClose]!.exists, "the copy's session closes before cleanup");
});
