// Timeouts and provider errors (SCN 3.6): S-TIME-1 and S-TIME-2, mode next, on the fake clock.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { EventsExport } from "../checks/invariants.js";
import { registry } from "../checks/registry.js";
import { B, on } from "../fakes/script/behaviors.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

async function events(ctx: Pick<ScenarioContext, "rafi">, cwd?: string, type?: string) {
  const r = await ctx.rafi("stats export", { cwd });
  const list = (JSON.parse(r.out) as EventsExport).events;
  return type ? list.filter((e) => e.type === type).map((e) => e.data) : list.map((e) => e.data);
}

function fresh(ctx: ScenarioContext): string {
  ctx.computer.script.rules.length = 0;
  ctx.computer.script.transcript.length = 0;
  return ctx.fixture("F-ONE");
}

scenario({
  id: "S-TIME-1", covers: covers("S-TIME-1"), modes: ["next"], fixture: "F-ONE",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    let status = "";
    await step("a hung builder turn is cancelled at the idle timeout, retried with backoff; T1 finishes", async () => {
      computer.script.rules.push(on("builder T1#1", B.hang()));
      computer.clock.whenTimer("backoff", async () => { status = (await rafi("status")).output; });
      const simStart = computer.clock.now().getTime();
      const started = performance.now();
      const r = await rafi("start . --steps 1");
      const real = performance.now() - started;
      assert.equal(r.code, 0, r.output);
      // The fake clock, not real waiting, drove the timeout: it moved past the 30-minute idle timeout plus the
      // 10 s backoff, while real time stayed a tiny fraction of that (a ratio, so a loaded machine can't flake it).
      const simulated = computer.clock.now().getTime() - simStart;
      assert.ok(simulated >= 30 * 60_000 + 10_000, `the fake clock moved only ${simulated} ms`);
      assert.ok(real < simulated / 100, `${Math.round(real)} ms of real time for ${simulated} ms on the fake clock`);
      assert.doesNotMatch(r.output, /What should Rafi do\?/);
      const retries = await events(ctx, undefined, "turn.retry");
      assert.deepEqual(retries.map((x) => x.category), ["timeout"]);
      assert.equal(Number(retries[0]!.delay_ms), 10_000);
      assert.equal((await events(ctx, undefined, "turn.cancelled")).length, 1);
      const builder = computer.script.transcript.filter((t) => t.role === "builder");
      assert.match(builder[1]!.message, /timed out/);
    });
    await step("while waiting, rafi status says rafi is waiting on the provider, retry number and next try", () => {
      assert.match(status, /waiting on the provider/i);
      assert.match(status, /retry 1 of 3/i);
      assert.match(status, /next try at 14:30:10/);
    });
    await step("the control: 45 minutes of healthy work with activity every minute isn't timed out", async () => {
      const dir = fresh(ctx);
      computer.script.rules.push(on("builder T1#1", B.slow(45, 1)));
      const r = await rafi("start . --steps 1", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(await events(ctx, dir, "turn.retry"), []);
    });
  },
});

scenario({
  id: "S-TIME-2", covers: covers("S-TIME-2"), modes: ["next"], fixture: "F-ONE",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    await step("two transient errors: retried with backoff, then T1 finishes", async () => {
      computer.script.rules.push(on("builder T1#1", B.error("transient")), on("builder T1#2", B.error("transient")));
      const r = await rafi("start . --steps 1");
      assert.equal(r.code, 0, r.output);
      const retries = await events(ctx, undefined, "turn.retry");
      assert.deepEqual(retries.map((x) => [x.category, x.delay_ms]), [["provider", 10_000], ["provider", 30_000]]);
    });
    await step("four: after 3 retries T1 stops with one line saying what, why and the command to continue",
      async () => {
        const dir = fresh(ctx);
        for (let n = 1; n <= 4; n += 1) computer.script.rules.push(on(`builder T1#${n}`, B.error("transient")));
        const r = await rafi("start . --steps 1", { cwd: dir });
        assert.equal(r.code, 1, r.output);
        const lines = r.err.split("\n").filter((l) => /T1 stopped/.test(l));
        assert.equal(lines.length, 1, r.err);
        assert.match(lines[0]!, /^rafi: T1 stopped after 4 tries: overloaded.*`rafi resume`/);
        assert.equal((await events(ctx, dir, "turn.retry")).length, 3);
      });
    await step("quota: no tight retry loop; one line naming the usage limit and how to continue", async () => {
      const dir = fresh(ctx);
      computer.script.rules.push(on("builder T1#1", B.error("quota")));
      const r = await rafi("start . --steps 1", { cwd: dir });
      assert.equal(r.code, 1, r.output);
      assert.equal(computer.script.transcript.filter((t) => t.role === "builder").length, 1, "no tight loop");
      assert.match(r.err, /^rafi: T1 stopped .*usage limit.*`rafi resume`/m);
    });
    await step("login, in a terminal: <runtime> is not ready … What should Rafi do?; switching states its scope",
      async () => {
        const dir = fresh(ctx);
        const config = readFileSync(path.join(dir, "rafi-config.yaml"), "utf8");
        computer.script.rules.push(on("builder T1#1", B.error("auth")));
        const r = await rafi("start . --steps 1", { cwd: dir, tty: true, input: ["2"] });
        assert.equal(r.code, 0, r.output);
        assert.match(r.output, /Claude is not ready for this build .* What should Rafi do\?/);
        assert.doesNotMatch(r.output, /Foreman/);
        assert.match(r.output, /1\. Retry/);
        assert.match(r.output, /3\. Cancel/);
        assert.match(r.output,
          /builder now uses Codex for this build, from the next turn; the project default is unchanged/);
        assert.match(r.output, /new session.*loses continuity.*cost/i);
        const builder = computer.script.transcript.filter((t) => t.role === "builder");
        assert.deepEqual(builder.map((t) => t.runtime), ["claude", "codex"]);
        assert.equal(readFileSync(path.join(dir, "rafi-config.yaml"), "utf8"), config, "rafi-config.yaml unchanged");
        const answered = await events(ctx, dir, "question.answered");
        assert.equal(answered.length, 1);
      });
  },
});
