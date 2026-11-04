// Item 18 (M3 plan): "Retry another Builder fix" runs exactly one more fix, then asks again (C104); PRM-82's "No"
// returns to "What next?"; the Planner and Pause options aren't built yet and ask again (C102); a prompt with no
// input, or no terminal, leaves the question open and exits 1 (C100); a review with no verdict says "QA broke" (C110).
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

test("Retry another Builder fix runs exactly one more fix, then asks again; no input leaves it open, exit 1",
  async () => {
    const { rafi, exported, fixes } = setup(progress(5));
    const r = await rafi("start . --steps 1", { tty: true, input: ["1"] });
    assert.equal(r.code, 1, r.output);
    assert.equal(fixes().length, 4, "3 fixes, then exactly one more");
    const e = await exported();
    assert.deepEqual(of(e, "fix.granted").map((x) => [x.actor, (x.data as { by: string }).by]), [["user", "user"]]);
    const opened = of(e, "question.opened");
    assert.equal(opened.length, 2, "asked again after the granted fix");
    assert.equal(of(e, "question.answered").length, 1, "the second question is still open");
    assert.equal((r.output.match(/1\. Retry another Builder fix/g) ?? []).length, 2, "the question is shown twice");
    const fix5 = fixes()[3]!;
    assert.equal(fix5.attempt, 5, "the retry is the next attempt");
    assert.match(fix5.message, /Fix 4 of 4\./);
  });

test("after an early circling question, Retry still runs exactly one more fix before asking again (C104)", async () => {
  const two = [{ from: 1, text: "It shows.", check: null }, { from: 1, text: "The empty state shows.", check: null }];
  const { rafi, exported, fixes } = setup([on("qa T1 @prepare", B.requirements(two)),
    ...[1, 2, 3, 4, 5, 6].map((n) => on(`qa T1#${n} @review`, B.sameReject(2))),
    on("builder T1#4", B.read("README.md")), on("builder T1#5", B.read("package.json")),
    on("builder T1#6", B.read("rafi-config.yaml"))]);
  const r = await rafi("start . --steps 1", { tty: true, input: ["1"] });
  assert.equal(r.code, 1, r.output);
  const e = await exported();
  const opened = of(e, "question.opened").map((x) => (x.data as { text: string }).text);
  assert.equal(opened.length, 2, r.output);
  assert.match(opened[0]!, /the same failure repeated with no progress/);
  assert.equal(fixes().length, 3, "2 fixes before circling asked, then exactly one more");
  assert.deepEqual(fixes().map((t) => t.attempt), [2, 3, 4]);
});
