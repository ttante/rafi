// The QA loop (SCN 3.2): S-QA-1 and S-QA-3 in full (M3). Mode next.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import { B, on } from "../fakes/script/behaviors.js";
import { scenario } from "../harness/scenario.js";
import { exported, insideQuotes, of, runNumbers, ticketJson, turn } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

const TWO = [{ from: 1, text: "The list shows its items.", check: null },
  { from: 1, text: "An empty list shows the empty-state message.", check: null }];

scenario({
  id: "S-QA-1", covers: covers("S-QA-1"), modes: ["next"], fixture: "F-ONE",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    computer.script.rules.push(on("qa T1 @prepare", B.requirements(TWO)),
      on("qa T1#1 @review", B.reject({ 2: "empty state missing" })), on("builder T1#2",
        B.also({ edit: "src/T1.txt", content: "with the empty state\n" })),
      on("qa T1#2 @review", B.pass()));
    let output = "";
    await step("exit 0, T1 done, no question asked", async () => {
      const r = await rafi("start . --steps 1");
      output = r.output;
      assert.equal(r.code, 0, r.output);
      assert.equal((await ticketJson(ctx, "T1")).state, "done");
      assert.deepEqual(of(await exported(ctx), "question.opened"), []);
    });
    await step("the terminal says QA rejected the work for the first review, with the one-line finding", () => {
      const lines = output.split("\n").filter((l) => /QA rejected the work/.test(l));
      assert.equal(lines.length, 1, output);
      assert.match(lines[0]!, /T1: QA rejected the work: R2: empty state missing$/);
    });
    await step("builder turn 2 receives QA's R2 finding, quoted", () => {
      const fix = turn(computer.script.transcript, "builder", "fix", 2);
      assert.ok(fix, "a fix turn");
      assert.match(insideQuotes(fix.message), /^- R2\b.*: empty state missing$/m);
      assert.match(fix.message, /docs\/requirements\/T1\.md/);
    });
    await step("QA turn 2 gets only what changed, the R2 finding and the requirements path, not its text", async () => {
      const t = computer.script.transcript;
      const first = turn(t, "qa", "review", 1)!;
      const second = turn(t, "qa", "review", 2)!;
      assert.equal(second.session, "reused", "the re-review reuses QA's review session (C35)");
      const quotedText = insideQuotes(second.message);
      assert.match(quotedText, /^Files changed since your last review: src\/T1\.txt\.$/m);
      assert.match(quotedText, /^- R2\b.*: empty state missing$/m);
      const before = Math.max(0, ...runNumbers(first.message));
      const since = runNumbers(second.message);
      assert.ok(since.length > 0, second.message);
      assert.ok(since.every((n) => n > before), `only runs after review 1: ${since} vs ${before}`);
      assert.match(second.message, /Requirements file: docs\/requirements\/T1\.md/);
      const file = readFileSync(path.join(ctx.project, "docs", "requirements", "T1.md"), "utf8");
      for (const line of file.split("\n").filter((l) => l.startsWith("- **R"))) {
        assert.ok(!second.message.includes(line), `no requirement line: ${line}`);
      }
    });
    await step("QA's verdict is per requirement, each with one of the four statuses", async () => {
      const verdicts = of(await exported(ctx), "verdict.recorded") as { results: { req: number; status: string }[] }[];
      assert.equal(verdicts.length, 2);
      for (const v of verdicts) {
        assert.deepEqual(v.results.map((r) => r.req), [1, 2]);
        for (const r of v.results) assert.ok(["satisfied", "not-satisfied", "not-applicable", "unable"]
          .includes(r.status));
      }
    });
  },
});

/** Builder requests in order: no two consecutive ones are identical (NEW-RTY-1, ARCH 5.4). */
function noRepeats(messages: readonly string[]): void {
  for (let i = 1; i < messages.length; i += 1) {
    assert.notEqual(messages[i], messages[i - 1], `builder request ${i + 1}`);
  }
}

scenario({
  id: "S-QA-3", covers: covers("S-QA-3"), modes: ["next"], fixture: "F-ONE",
  async run(ctx) {
    const { rafi, step, computer, fixture } = ctx;
    const same = () => [on("qa T1 @prepare", B.requirements(TWO)),
      ...[1, 2, 3, 4].map((n) => on(`qa T1#${n} @review`, B.sameReject(2)))];
    const builder = () => computer.script.transcript.filter((t) => t.role === "builder" && !t.repair);
    await step("script A: the same rejection and no change stops before the 3-fix allowance and says so", async () => {
      computer.script.rules.push(...same());
      const r = await rafi("start . --steps 1", { tty: true });
      assert.equal(r.code, 1, r.output);
      const fixes = builder().filter((t) => t.step === "fix");
      assert.equal(fixes.length, 2, "fewer than 3 fixes");
      const verdicts = of(await exported(ctx), "verdict.recorded") as { attempt: number; circling: boolean }[];
      assert.deepEqual(verdicts.map((v) => [v.attempt, v.circling]), [[1, false], [2, false], [3, true]]);
      const opened = of(await exported(ctx), "question.opened") as { text: string }[];
      assert.equal(opened.length, 1);
      assert.match(opened[0]!.text, /the same failure repeated with no progress/);
      assert.match(r.output, /the same failure repeated with no progress/);
      noRepeats(builder().map((t) => t.message));
    });
    await step("script B (control): each fix reads a new file, so the normal allowance applies", async () => {
      const dir = fixture("F-ONE");
      computer.script.rules.length = 0;
      computer.script.transcript.length = 0;
      computer.script.rules.push(...same(), on("builder T1#2", B.read("README.md")),
        on("builder T1#3", B.read("package.json")), on("builder T1#4", B.read("rafi-config.yaml")));
      const r = await rafi("start . --steps 1", { cwd: dir, tty: true });
      assert.equal(r.code, 1, r.output);
      assert.equal(builder().filter((t) => t.step === "fix").length, 3);
      const e = await exported(ctx, dir);
      assert.ok((of(e, "verdict.recorded") as { circling: boolean }[]).every((v) => !v.circling));
      const opened = of(e, "question.opened") as { text: string }[];
      assert.match(opened[0]!.text, /after 3 fixes/);
      const reads = (of(e, "attempt.summary") as { files_read: string[] }[]).map((s) => s.files_read);
      assert.deepEqual(reads, [[], ["README.md"], ["package.json"], ["rafi-config.yaml"]]);
      noRepeats(builder().map((t) => t.message));
    });
  },
});
