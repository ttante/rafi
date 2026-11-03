// Malformed replies and references (SCN 3.5): S-MAL-1, S-MAL-5 in full; S-MAL-2 variant 1 and S-MAL-4's builder runs
// (their other parts are later milestones). Mode next.
import assert from "node:assert/strict";
import type { EventsExport } from "../checks/invariants.js";
import { registry } from "../checks/registry.js";
import { steps } from "../checks/transcript.js";
import { B, on } from "../fakes/script/behaviors.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

async function exported(ctx: Pick<ScenarioContext, "rafi">, cwd?: string): Promise<EventsExport> {
  const r = await ctx.rafi("stats export", { cwd });
  assert.equal(r.code, 0, r.output);
  return JSON.parse(r.out) as EventsExport;
}

const of = (e: EventsExport, type: string) => e.events.filter((x) => x.type === type).map((x) => x.data);

scenario({
  id: "S-MAL-1", covers: covers("S-MAL-1"), modes: ["next"], fixture: "F-ONE",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    computer.script.rules.push(on("builder T1#1", B.malformed(4412)), on("builder T1#1", B.repairOk()));
    let out = "";
    await step("rafi start . --steps 1 finishes T1 and asks nothing", async () => {
      const r = await rafi("start . --steps 1");
      out = r.output;
      assert.equal(r.code, 0, r.output);
      assert.doesNotMatch(out, /What should Rafi do\?/);
    });
    await step("exactly one repair request: invalid at byte 4412, same content as valid JSON, no tools", () => {
      const repairs = computer.script.transcript.filter((t) => t.repair);
      assert.equal(repairs.length, 1);
      assert.match(repairs[0]!.message, /wasn't valid JSON: .* at byte 4412\./);
      assert.match(repairs[0]!.message, /Send the same reply again as valid JSON/);
      assert.match(repairs[0]!.message, /Don't run tools, read files or change anything\./);
      assert.deepEqual(steps(computer.script.transcript), ["qa@prepare", "builder@build", "builder@build(repair)",
        "qa@review"]);
    });
    await step("the repaired reply is accepted and recorded", async () => {
      const e = await exported(ctx);
      assert.deepEqual(of(e, "turn.repair").map((r) => [r.accepted, r.at_byte]), [[true, 4412]]);
      assert.deepEqual(of(e, "turn.retry"), [], "the repaired reply was used: no retry after the repair");
      assert.equal(of(e, "builder.reported").length, 1);
      assert.ok(e.events.some((x) => x.type === "delivery.done" && x.ticket_id === "T1"));
    });
    await step("rafi stats show counts one malformed builder reply on this provider", async () => {
      const r = await rafi("stats show");
      assert.equal(r.code, 0, r.output);
      assert.match(r.out, /Malformed replies: builder on claude: 1\b/);
    });
  },
});

scenario({
  id: "S-MAL-5", covers: covers("S-MAL-5"), modes: ["next"], fixture: "F-ONE",
  async run(ctx) {
    const { rafi, step, computer, fixture } = ctx;
    await step("instructions name runs by short number and contain no long hash ids; check 3 is accepted", async () => {
      computer.script.rules.push(on("builder T1", B.runCheck("npm test", "npm test", "npm test")),
        on("qa T1 @review", B.verdictRuns([3])));
      const r = await rafi("start . --steps 1");
      assert.equal(r.code, 0, r.output);
      const review = computer.script.transcript.find((t) => t.step === "review")!;
      assert.match(review.message, /run 3: `npm test` passed/);
      // The review message carries the requirements file's fingerprint (ARCH 10.2); no reference is hash-like.
      for (const t of computer.script.transcript) {
        assert.doesNotMatch((t.instructions + t.message).replace(/sha256:[0-9a-f]{64}/g, ""), /\b[0-9a-f]{20,}\b/);
      }
      assert.equal(computer.script.transcript.filter((t) => t.step === "review").length, 1, "accepted first time");
    });
    for (const [name, runs] of [["check 99", [99]], ["a duplicate", [1, 1]], ["a hash-like id",
      ["a3f9c2d1e8b7a6f5c4d3e2f1"]]] as const) {
      await step(`${name} is an error sent back for a retry; no nearest match`, async () => {
        const dir = fixture("F-ONE");
        computer.script.rules.length = 0;
        computer.script.transcript.length = 0;
        computer.script.rules.push(on("qa T1 @review", B.verdictRuns([...runs])));
        const r = await rafi("start . --steps 1", { cwd: dir });
        assert.equal(r.code, 0, r.output);
        const reviews = computer.script.transcript.filter((t) => t.step === "review");
        assert.equal(reviews.length, 2);
        assert.match(reviews[1]!.message, /wasn't accepted/);
        const e = await exported(ctx, dir);
        const content = of(e, "turn.reply").filter((x) => x.outcome === "content");
        assert.equal(content.length, 1);
        assert.ok(!of(e, "turn.repair").length, "never a format repair");
      });
    }
    await step("a false claim: rafi's exit 1 is what QA and the log see, logged as a mismatch, no retry", async () => {
      const dir = fixture("F-ONE");
      computer.script.rules.length = 0;
      computer.script.transcript.length = 0;
      computer.checks.tests["npm test"] = { outcomes: ["fail(1)", "pass"] };
      computer.script.rules.push(on("builder T1", B.runCheck("npm test")));
      const r = await rafi("start . --steps 1", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx, dir);
      assert.deepEqual(of(e, "facts.mismatch").map((m) => m.record), ["run 1 `npm test` failed (exit 1)"]);
      assert.equal(computer.script.transcript.filter((t) => t.role === "builder").length, 1, "no retry");
      const review = computer.script.transcript.find((t) => t.step === "review")!;
      assert.match(review.message, /run 1: `npm test` failed, exit 1/);
      assert.doesNotMatch(review.message + review.instructions, /report (the|its) exit code/i);
    });
  },
});

scenario({
  id: "S-MAL-2", covers: covers("S-MAL-2"), modes: ["next"], fixture: "F-ONE",
  async run(ctx) {
    const { rafi, step, computer, pending } = ctx;
    computer.script.rules.push(on("builder T1#1", B.malformed(200)), on("builder T1#1", B.repairChanged("summary")));
    await step("variant 1: the changed resend is rejected; a content retry with the error; T1 finishes", async () => {
      const r = await rafi("start . --steps 1");
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx);
      assert.deepEqual(of(e, "turn.repair").map((x) => x.accepted), [false]);
      assert.match(String(of(e, "turn.repair")[0]!.why), /summary/);
      const reported = of(e, "builder.reported");
      assert.equal(reported.length, 1, "nothing from either rejected reply was applied");
      assert.notEqual(reported[0]!.summary, "something else");
      assert.deepEqual(steps(computer.script.transcript).filter((s) => s.startsWith("builder")),
        ["builder@build", "builder@build(repair)", "builder@build"]);
      assert.match(computer.script.transcript.filter((t) => t.role === "builder")[2]!.message, /summary/);
      assert.ok(e.events.some((x) => x.type === "delivery.done"));
    });
    await step("the raw replies and the validation errors are kept, shown by stats show --run", async () => {
      const e = await exported(ctx);
      const run = e.events.find((x) => x.type === "build.started")!.run_id!;
      const r = await rafi(`stats show --run ${run}`);
      assert.equal(r.code, 0, r.output);
      assert.match(r.out, /Failed replies kept:/);
      assert.match(r.out, /T1 build attempt 1: format/);
      assert.match(r.out, /the repair was rejected: the resend changed summary/);
      assert.match(r.out, /raw sha256:[0-9a-f]{64}/);
    });
    await pending("variant 3: circling stops repeated changed resends", "M3");
    await pending("variant 2: every reply malformed; T1 blocked with 'malformed reply', T2 still builds", "M6");
  },
});

scenario({
  id: "S-MAL-4", covers: covers("S-MAL-4"), modes: ["next"], fixture: "F-ONE",
  async run(ctx) {
    const { rafi, step, computer, fixture, pending } = ctx;
    const runs = [["missing-field(summary)", B.missingField("summary"), "content"],
      ["wrong-type(runs)", B.wrongType("runs"), "content"], ["two final replies", B.twoFinals(), "content"],
      ["done with an invalid payload", B.doneInvalid(), "content"],
      ["a reply naming T9 and another session", B.binding(), "content"],
      ["a failed provider turn", B.error("transient"), "provider"]] as const;
    for (const [name, behavior, category] of runs) {
      await step(`${name}: retried as ${category}, never sent to format repair, T1 finishes`, async () => {
        const dir = fixture("F-ONE");
        computer.script.rules.length = 0;
        computer.script.transcript.length = 0;
        computer.script.rules.push(on("builder T1#1", behavior));
        const r = await rafi("start . --steps 1", { cwd: dir });
        assert.equal(r.code, 0, r.output);
        const e = await exported(ctx, dir);
        assert.ok(!of(e, "turn.repair").length, "no format repair");
        assert.deepEqual(of(e, "turn.retry").map((x) => x.category), [category]);
        assert.equal(of(e, "builder.reported").length, 1, "nothing invalid applied");
        for (const t of computer.script.transcript) assert.doesNotMatch(t.message, /handoff_id|finding_key/);
      });
    }
    await step("evidence for a command rafi never recorded is ignored for rafi's record; no repair", async () => {
      const dir = fixture("F-ONE");
      computer.script.rules.length = 0;
      computer.script.rules.push(on("builder T1#1", { reply: { kind: "done", summary: "Ran the suite.", runs: [42],
        block: null, question: null } }));
      const r = await rafi("start . --steps 1", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx, dir);
      assert.ok(!of(e, "turn.repair").length && !of(e, "turn.retry").length);
      assert.match(String(of(e, "facts.mismatch")[0]?.record), /no run 42/);
    });
    await step("an edit outside the ticket's files is refused with a one-line reason naming the file", async () => {
      const dir = fixture("F-ONE");
      computer.script.rules.length = 0;
      computer.script.rules.push(on("builder T1#1", B.edit("../outside.txt")));
      const r = await rafi("start . --steps 1", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.match(r.err, /^rafi: T1: refused .*outside\.txt is outside the ticket's worktree/m);
    });
    await pending("the planner runs (a plan with no status line)", "M9");
  },
});
