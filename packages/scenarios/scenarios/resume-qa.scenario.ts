// S-QA-4 (SCN 3.2): resume after QA, rejected versus broke (NEW-QAM-3, NEW-QAM-7; C148). (a) A crash after "Retry"
// redoes the fix with the same QA report and no new "What next?"; (b) QA's provider crashing mid-review is retried
// in the run and shown as "QA broke", with the same requirements fingerprint and changed files, and no fix used; (b′)
// the same when rafi itself crashes mid-review; (c) after Ctrl+C at "What next?" and an edit, the old question is
// closed as stale and QA reviews the changed code.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import type { TranscriptEntry } from "../checks/transcript.js";
import { B, on } from "../fakes/script/behaviors.js";
import type { Rule } from "../fakes/script/engine.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported, insideQuotes, of } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
const FOUR = [1, 2, 3, 4].map((n) => ({ from: 1, text: `Requirement number ${n} holds.`, check: null }));

/** QA rejects attempts 1–4 on a different requirement each time; each fix writes new content (progress). */
const rejecting = (): Rule[] => [on("qa T1 @prepare", B.requirements(FOUR)),
  ...[1, 2, 3, 4].map((n) => on(`qa T1#${n} @review`, B.reject({ [n]: `R${n} isn't met yet` }))),
  ...[2, 3, 4, 5].map((n) => on(`builder T1#${n}`, B.also({ edit: "src/T1.txt", content: `fix ${n}\n` })))];

const reviews = (t: readonly TranscriptEntry[], from: number) => t.slice(from)
  .filter((x) => x.role === "qa" && x.step === "review" && !x.repair);
const fixes = (t: readonly TranscriptEntry[], from: number) => t.slice(from)
  .filter((x) => x.role === "builder" && x.step === "fix" && !x.repair);

async function retryThenCrash(ctx: ScenarioContext): Promise<void> {
  const { rafi, computer, fixture, step } = ctx;
  await step("(a) Retry, then a crash before the fix's reply: resume redoes it with the same QA report, no new ask",
    async () => {
      const dir = fixture("F-ONE");
      computer.script.rules.push(...rejecting());
      const from = computer.script.transcript.length;
      const crashed = await rafi("start . --steps 1", { cwd: dir, tty: true, input: ["1"],
        crashAt: "2: sent, before any reply (T1, fix, attempt 5" });
      assert.ok(crashed.crashed, crashed.output);
      const asked = of(await exported(ctx, dir), "question.opened").length;
      const r = await rafi("resume", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.equal(of(await exported(ctx, dir), "question.opened").length, asked, "What next? isn't asked again");
      const five = fixes(computer.script.transcript, from).filter((t) => t.attempt === 5);
      assert.equal(five.length, 2, "the fix was sent, then redone once");
      assert.match(insideQuotes(five[0]!.message), /R4 isn't met yet/);
      assert.equal(insideQuotes(five[1]!.message), insideQuotes(five[0]!.message), "the same QA report");
    });
}

async function qaBroke(ctx: ScenarioContext): Promise<void> {
  const { rafi, computer, fixture, step } = ctx;
  await step("(b) QA's provider crashes mid-review: retried in the run, shown as QA broke, no fix used", async () => {
    const dir = fixture("F-ONE");
    computer.script.rules.push(on("qa T1#1 @review", { crash: true }));
    const from = computer.script.transcript.length;
    const r = await rafi("start . --steps 1", { cwd: dir });
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /T1: QA broke \(no verdict\): .*reviewing again with the same requirements file and/);
    assert.doesNotMatch(r.output, /QA rejected the work/);
    const two = reviews(computer.script.transcript, from);
    assert.equal(two.length, 2, "the review ran again in the same run");
    assert.ok(two[1]!.message.includes(two[0]!.message), "the same requirements fingerprint and changed files");
    assert.equal(fixes(computer.script.transcript, from).length, 0, "no fix attempt is used");
    assert.match((await rafi("resume", { cwd: dir })).output, /Nothing to resume\./);
  });
  await step("(b′) rafi crashes mid-review: resume says QA broke and reviews with the same fingerprint and files",
    async () => {
      const dir = fixture("F-ONE");
      const from = computer.script.transcript.length;
      const crashed = await rafi("start . --steps 1", { cwd: dir, crashAt: "2: sent, before any reply (T1, review" });
      assert.ok(crashed.crashed, crashed.output);
      const r = await rafi("resume", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /T1: QA broke \(no verdict\): .*reviewing again with the same requirements file/);
      const two = reviews(computer.script.transcript, from);
      assert.equal(two.length, 2);
      assert.equal(insideQuotes(two[1]!.message), insideQuotes(two[0]!.message));
      assert.equal(fixes(computer.script.transcript, from).length, 0);
    });
}

async function staleQuestion(ctx: ScenarioContext): Promise<void> {
  const { rafi, computer, fixture, step } = ctx;
  await step("(c) Ctrl+C at What next?, then an edit: the old question is closed as stale and QA reviews again",
    async () => {
      const dir = fixture("F-ONE");
      computer.script.rules.push(...rejecting());
      const live = rafi.start("start . --steps 1", { cwd: dir, tty: true });
      await live.expect(/What next\?/);
      live.interrupt();
      assert.equal((await live.done()).code, 130);
      writeFileSync(path.join(dir, "src", "T1.txt"), "your own fix\n");
      const from = computer.script.transcript.length;
      const r = await rafi("resume", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx, dir);
      const opened = of(e, "question.opened") as { id: string }[];
      assert.deepEqual(of(e, "question.closed"), [{ id: opened[0]!.id, why: "stale" }]);
      assert.equal(of(e, "question.answered").length, 0, "the old question's answer is never applied");
      assert.equal(reviews(computer.script.transcript, from).length, 1, "QA reviews the changed code");
      assert.equal(fixes(computer.script.transcript, from).length, 0);
    });
}

scenario({
  id: "S-QA-4", covers: covers("S-QA-4"), modes: ["next"], fixture: "F-ONE",
  async run(ctx) {
    await retryThenCrash(ctx);
    await qaBroke(ctx);
    await staleQuestion(ctx);
  },
});
