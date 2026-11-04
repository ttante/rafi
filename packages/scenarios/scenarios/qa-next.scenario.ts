// "What next?" (SCN 3.2): S-QA-2 steps 1–4 (M3) and 6 (M4: Manager's /request-attempt, C153, C146). Step 5 needs the
// read-only Planner (M8).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import { B, on } from "../fakes/script/behaviors.js";
import type { Rule } from "../fakes/script/engine.js";
import { git } from "../fixtures/common.js";
import { copyProject, scenario, type ScenarioContext } from "../harness/scenario.js";
import { rafiRunner } from "../harness/rafi.js";
import { exported, of, ticketJson, turns } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

const FOUR = [1, 2, 3, 4].map((n) => ({ from: 1, text: `Requirement number ${n} holds.`, check: null }));
const OPTIONS = ["Retry another Builder fix", "I verified it myself", "Explicitly waive QA",
  "Discuss with read-only Planner", "Pause at this checkpoint"];

/** QA rejects attempts 1–4, each on a different requirement; each fix writes new content (progress). */
function script(): Rule[] {
  return [on("qa T1 @prepare", B.requirements(FOUR)),
    ...[1, 2, 3, 4].map((n) => on(`qa T1#${n} @review`, B.reject({ [n]: `R${n} isn't met yet` }))),
    ...[2, 3, 4].map((n) => on(`builder T1#${n}`, B.also({ edit: "src/T1.txt", content: `fix ${n}\n` })))];
}

/** Step 6 (M4, C153, C146): Retry, then Manager's /request-attempt from a second shell closes the open prompt. */
async function step6(ctx: ScenarioContext): Promise<void> {
  const { rafi, computer, fixture } = ctx;
  await ctx.step("6: Retry runs exactly T1#5 and asks again; Manager /request-attempt grants T1#6", async () => {
    const dir = fixture("F-ONE");
    computer.script.rules.length = 0;
    computer.script.rules.push(on("qa T1 @prepare", B.requirements(FOUR)),
      ...[1, 2, 3, 4, 5, 6].map((n) => on(`qa T1#${n} @review`, B.reject({ [((n - 1) % 4) + 1]: `R${n} not yet` }))),
      ...[2, 3, 4, 5, 6].map((n) => on(`builder T1#${n}`, B.also({ edit: "src/T1.txt", content: `fix ${n}\n` }))));
    const before = computer.script.transcript.length;
    const live = rafi.start("start . --steps 1", { cwd: dir, tty: true });
    await live.expect(/What next\?/);
    live.send("1\n");
    await live.expect(/What next\?/);
    const fixes = () => computer.script.transcript.slice(before).filter((t) => t.role === "builder" &&
      t.step === "fix" && !t.repair).map((t) => t.attempt);
    assert.deepEqual(fixes(), [2, 3, 4, 5], "Retry ran exactly one more fix, then asked again");
    const run = (await exported(ctx, dir)).events.find((x) => x.type === "build.started")!.run_id;
    const m = await rafi(`manager --ask "/request-attempt ${run} T1 \\"one more try\\""`, { cwd: dir });
    assert.equal(m.code, 0, m.output);
    await live.expect(/answered by Manager/);
    await live.expect(/What next\?/);
    live.end();
    const r = await live.done();
    assert.deepEqual(fixes(), [2, 3, 4, 5, 6], "exactly T1#6, and no T1#7");
    assert.notEqual(r.code, 0);
    const e = await exported(ctx, dir);
    const granted = e.events.filter((x) => x.type === "fix.granted" && x.actor === "manager");
    assert.deepEqual(granted.map((x) => [x.source, x.data.by, x.data.reason]),
      [["manager", "manager", "one more try"]]);
    assert.equal(of(e, "question.opened").length, 3, "What next? asked again after T1#6");
  });
}

scenario({
  id: "S-QA-2", covers: covers("S-QA-2"), modes: ["next"], fixture: "F-ONE",
  async run(ctx) {
    const { rafi, step, computer, fixture, pending, project } = ctx;
    computer.script.rules.push(...script());
    let output = "";
    let code = -1;
    await step("1: in a terminal, What next? comes after exactly 3 builder fixes, with its five options", async () => {
      const r = await rafi("start . --steps 1", { tty: true,
        input: ["2", "", "Checked the empty state on a phone"] });
      output = r.output;
      code = r.code;
      assert.equal(turns(computer.script.transcript, "builder", "fix").length, 3);
      const at = output.indexOf("What next?");
      assert.ok(at > 0, output);
      assert.ok(output.lastIndexOf("fix started") < at, "no fix after the question");
      for (const option of OPTIONS) assert.ok(output.slice(at).includes(option), option);
      const opened = of(await exported(ctx), "question.opened") as { kind: string; options: { id: string }[] }[];
      assert.deepEqual(opened.map((q) => q.kind), ["what-next"]);
      assert.deepEqual(opened[0]!.options.map((o) => o.id), ["retry", "verified", "waive", "planner", "pause"]);
    });
    await step("2: the empty note is refused; the note is recorded; only the open findings are waived; T1 done",
      async () => {
        assert.equal(code, 0, output);
        assert.equal(output.split("\n").filter((l) => /needs a note/.test(l)).length, 1, output);
        const e = await exported(ctx);
        const answered = of(e, "question.answered") as { choice: string; note: string | null }[];
        assert.deepEqual(answered.map((a) => [a.choice, a.note]), [["verified", "Checked the empty state on a phone"]]);
        const waivers = of(e, "waiver.recorded") as { kind: string; findings: string[]; note: string }[];
        assert.deepEqual(waivers.map((w) => [w.kind, w.findings]), [["verified-myself", ["R4"]]]);
        assert.ok(e.events.some((x) => x.type === "question.answered" && x.actor === "user" &&
          x.source === "terminal"));
        const t1 = await ticketJson(ctx, "T1");
        assert.equal(t1.state, "done");
        const validation = t1.validation as { result: string; waiver: { kind: string; note: string } };
        assert.equal(validation.result, "user-verified");
        assert.deepEqual([validation.waiver.kind, validation.waiver.note],
          ["verified-myself", "Checked the empty state on a phone"]);
      });
    await step("3: a covered-file edit makes the waiver stale; a README-only edit leaves it standing", async () => {
      const copy = copyProject(project);
      computer.script.rules.push(on("qa T1#4 @review", B.reject({ 4: "R4 isn't met yet" })));
      writeFileSync(path.join(project, "src", "T1.txt"), "your own change\n");
      git(project, ["add", "-A"]);
      git(project, ["commit", "-qm", "edit T1"]);
      const before = (await exported(ctx)).events.length;
      const r = await rafi("start . --ticket T1 --steps 1");
      assert.equal(r.code, 1, r.output);
      const after = (await exported(ctx)).events.slice(before);
      assert.ok(after.some((x) => x.type === "ticket.reopened" && x.ticket_id === "T1"), r.output);
      assert.match(r.output, /src\/T1\.txt/);
      const verdicts = after.filter((x) => x.type === "verdict.recorded").map((x) => x.data as { rejected: boolean });
      assert.deepEqual(verdicts.map((v) => v.rejected), [true], "QA reviews again and rejects R4 again");
      const asked = after.filter((x) => x.type === "question.opened").map((x) => x.data as { no: number;
        key: string });
      const first = of(await exported(ctx), "question.opened")[0] as { no: number; key: string };
      assert.equal(asked.length, 1, "What next? is asked again, not answered by the old note");
      assert.ok(asked[0]!.no > first.no && asked[0]!.key !== first.key, "a new number and a new key");
      assert.ok(!after.some((x) => x.type === "waiver.recorded"), "no new waiver");
      writeFileSync(path.join(copy, "README.md"), "# Fixture, edited\n");
      git(copy, ["add", "-A"]);
      git(copy, ["commit", "-qm", "edit README"]);
      const transcript = computer.script.transcript.length;
      const other = rafiRunner(computer, copy);
      const r2 = await other("start . --ticket T1 --steps 1");
      assert.equal(r2.code, 0, r2.output);
      assert.equal(computer.script.transcript.length, transcript, "no agent turn");
      assert.equal((await ticketJson({ rafi: other }, "T1")).state, "done");
    });
    await step("4: Explicitly waive QA, then Waive and continue: validation failed, unresolved findings kept",
      async () => {
        const dir = fixture("F-ONE");
        computer.script.rules.length = 0;
        computer.script.rules.push(...script());
        const r = await rafi("start . --steps 1", { cwd: dir, tty: true, input: ["3", "2"] });
        assert.equal(r.code, 0, r.output);
        assert.match(r.output, /Record validation_result=failed and retain unresolved issues\?/);
        const e = await exported(ctx, dir);
        const waivers = of(e, "waiver.recorded") as { kind: string; findings: string[] }[];
        assert.deepEqual(waivers.map((w) => [w.kind, w.findings]), [["waive-qa", ["R4"]]]);
        const t1 = await ticketJson(ctx, "T1", dir);
        assert.equal((t1.validation as { result: string }).result, "failed");
      });
    await pending("5: Discuss with read-only Planner shows the proposal in plain English", "M8");
    await step6(ctx);
  },
});
