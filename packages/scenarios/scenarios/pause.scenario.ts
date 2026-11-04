// S-CRASH-5 (SCN 3.7), M4 part (C161): S-CRASH-1's fixture and script, paused at every step boundary in turn with
// Manager's /pause from a second shell; each pause shows "pausing" then "paused" and is continued by `rafi resume`
// answering "Continue the paused build?". The end state matches a clean run, with no extra agent turns and no
// repeated question. Plan-update points (M8) and "waiting on you" points (M6) come later.
import assert from "node:assert/strict";
import { registry } from "../checks/registry.js";
import { workFiles } from "../checks/crash.js";
import { B, on } from "../fakes/script/behaviors.js";
import { fChain3 } from "../fixtures/f-chain3.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported, of } from "./m3-helpers.js";

const script = () => [on("qa T2#1 @review", B.reject({ 1: "not yet" })), on("builder T3#1 @build", B.malformed(300))];

async function clean(ctx: ScenarioContext) {
  const dir = fChain3(`${ctx.root}/clean`);
  const computer = newComputer(`${ctx.root}/clean`);
  computer.script.rules.push(...script());
  const r = await rafiRunner(computer, dir)("start . --steps 3");
  assert.equal(r.code, 0, r.output);
  return { files: workFiles(dir), turns: computer.script.transcript.length };
}

scenario({
  id: "S-CRASH-5", covers: registry.find((r) => r.id === "S-CRASH-5")!.covers, modes: ["next"], fixture: "none",
  async run(ctx) {
    const { rafi, step, computer, root, pending } = ctx;
    await step("paused at every step boundary in turn, then resumed: the clean run's end state", async () => {
      const base = await clean(ctx);
      const dir = fChain3(`${root}/paused`);
      computer.script.rules.push(...script());
      const statuses: string[] = [];
      let pauses = 0;
      const owner = rafi.start("start . --steps 3", { cwd: dir, tty: true, pauseAt: { at: (o) => o.startsWith("4:"),
        fn: async () => {
          const run = (await exported(ctx, dir)).events.find((e) => e.type === "build.started")!.run_id;
          assert.equal((await rafi(`manager --ask "/pause ${run} T1"`, { cwd: dir })).code, 0);
          statuses.push((await rafi("status", { cwd: dir })).output);
          pauses += 1;
        } } });
      let done = false;
      void owner.done().then(() => { done = true; });
      for (;;) {
        try { await owner.expect(/Paused at a safe point/); } catch { break; }
        statuses.push((await rafi("status", { cwd: dir })).output);
        const viewer = rafi.start("resume", { cwd: dir, tty: true, input: ["1"] });
        await viewer.expect(/Continuing build/);
        await viewer.expect(/Following build/);
        viewer.interrupt();
        await viewer.done();
        if (done) break;
      }
      const r = await owner.done();
      assert.equal(r.code, 0, r.output);
      assert.ok(pauses >= 10, `${pauses} pauses`);
      assert.equal(statuses.filter((s) => /: pausing;/.test(s)).length, pauses, "each pause shows pausing first");
      assert.equal(statuses.filter((s) => /: paused;/.test(s)).length, pauses, "then paused");
      const e = await exported(ctx, dir);
      assert.equal(of(e, "build.paused").length, pauses);
      assert.equal(of(e, "build.unpaused").length, pauses);
      assert.deepEqual(workFiles(dir), base.files, "the same end state as the clean run");
      assert.equal(computer.script.transcript.length, base.turns, "no extra agent turns");
      assert.equal(of(e, "question.opened").length, 0, "no repeated question");
    });
    await pending("plan-update states: a pause at each plan-update point (S-PLAN-1)", "M8");
    await pending("a pause while the build waits on you", "M6");
  },
});
