// Item 18 (M3 plan), part 2 (split from qa-m3.test.ts to stay under 8 s): PRM-82's "No"
// returns to "What next?"; the Planner option isn't built yet and asks again (C102; Pause is built in M4); a
// prompt with no input, or no terminal, leaves the question open and exits 1 (C100); a review with no verdict says
// "QA broke" (C110).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventsExport } from "../checks/invariants.js";
import { B, on } from "../fakes/script/behaviors.js";
import type { Rule } from "../fakes/script/engine.js";
import { tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

function setup(rules: Rule[]) {
  const root = tempRoot();
  const project = fOne(root);
  const computer = newComputer(root);
  computer.script.rules.push(...rules);
  const rafi = rafiRunner(computer, project);
  const exported = async () => JSON.parse((await rafi("stats export")).out) as EventsExport;
  const fixes = () => computer.script.transcript.filter((t) => t.role === "builder" && t.step === "fix" && !t.repair);
  return { rafi, exported, fixes };
}

const of = (e: EventsExport, type: string) => e.events.filter((x) => x.type === type);
const FIVE = [1, 2, 3, 4, 5].map((n) => ({ from: 1, text: `Requirement number ${n} holds.`, check: null }));

/** QA rejects every attempt on a different requirement, and each fix writes new content: progress, not circling. */
const progress = (attempts: number): Rule[] => [on("qa T1 @prepare", B.requirements(FIVE)),
  ...Array.from({ length: attempts }, (_, i) => on(`qa T1#${i + 1} @review`, B.reject({ [(i % 5) + 1]: `no ${i}` }))),
  ...Array.from({ length: attempts }, (_, i) => on(`builder T1#${i + 2}`, B.also({ edit: "src/T1.txt",
    content: `fix ${i + 2}\n` })))];

// M4: "Pause at this checkpoint" is built (C149, tested in resume-m4.test.ts), so only the Planner asks again here.
test("Planner isn't built yet and asks again; PRM-82's No returns to What next?", async () => {
  const { rafi, exported } = setup(progress(4));
  const r = await rafi("start . --steps 1", { tty: true, input: ["4", "3", "1", "2", "Checked it by hand"] });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /isn't in the new engine yet \(milestone M8\)/);
  assert.match(r.output, /Record validation_result=failed and retain unresolved issues\?/);
  assert.equal((r.output.match(/1\. Retry another Builder fix/g) ?? []).length, 3, "asked again after each");
  const e = await exported();
  assert.deepEqual(of(e, "waiver.recorded").map((x) => (x.data as { kind: string }).kind), ["verified-myself"]);
  assert.deepEqual(of(e, "question.answered").map((x) => (x.data as { choice: string }).choice), ["verified"]);
});

test("without a terminal the question stays open, the build exits 1 and says how to answer it", async () => {
  const { rafi, exported } = setup(progress(4));
  const r = await rafi("start . --steps 1");
  assert.equal(r.code, 1, r.output);
  const e = await exported();
  assert.equal(of(e, "question.opened").length, 1);
  assert.equal(of(e, "question.answered").length, 0);
  assert.match(r.output, /T1 is waiting on question 1 \(What next\?\).*in a terminal/);
  assert.ok(of(e, "build.owner_released").some((x) => (x.data as { reason: string }).reason === "waiting"));
});

test("a review that ends without a verdict says QA broke, never QA rejected the work", async () => {
  const bad = { reply: { verdict: "no" } };
  const { rafi } = setup([1, 2, 3, 4].map(() => on("qa T1 @review", bad)));
  const r = await rafi("start . --steps 1");
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /T1: QA broke \(no verdict\): /);
  assert.doesNotMatch(r.output, /QA rejected the work/);
});
