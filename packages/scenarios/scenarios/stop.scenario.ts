// S-CRASH-3 (SCN 3.7): stop, Ctrl+C, crash and pause are different outcomes. Runs 1–3 and 5 come with slice 4.
import assert from "node:assert/strict";
import { registry } from "../checks/registry.js";
import type { Computer } from "../harness/deps.js";
import { B, DONE, on } from "../fakes/script/behaviors.js";
import type { Behavior, MetaLike, TurnContext } from "../fakes/script/engine.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import type { LiveRafi, RafiResult } from "../harness/rafi.js";
import { exported, of } from "./m3-helpers.js";

const STOP_LINE = "Stopping after the current step. Run `rafi stop` again or press Ctrl+C to stop now.";

/** T2's builder: one file written, then ten minutes of work with activity each minute (SCN's slow(10m)). */
function slowT2(computer: Computer): void {
  const slow = B.slow(10) as (m: MetaLike, c: TurnContext) => Behavior;
  computer.script.rules.push(on("builder T2#1 @build", (m, c) => {
    const b = slow(m, c);
    return { ...b, steps: [{ edit: "src/T2-wip.txt", content: "half done\n" }, { activity: "started on T2" },
      ...(b.steps ?? [])] };
  }));
}

/** Starts F-CHAIN `--steps 2` in a terminal and runs `during` once T2's slow turn is out. */
async function whileT2Builds(ctx: ScenarioContext, during: (dir: string, live: LiveRafi) => Promise<void>,
  setup: () => void = () => undefined): Promise<{ dir: string; r: RafiResult }> {
  const dir = ctx.fixture("F-CHAIN");
  slowT2(ctx.computer);
  setup();
  const live = ctx.rafi.start("start . --steps 2", { tty: true, cwd: dir });
  let ran = false;
  ctx.computer.clock.whenTimer("agent", async () => { ran = true; await during(dir, live); });
  const r = await live.done();
  assert.ok(ran, r.output);
  return { dir, r };
}

const run = async (ctx: ScenarioContext, dir: string) => (await exported(ctx, dir)).events
  .find((e) => e.type === "build.started")!.run_id!;
const NEVER = /failed|waiting on you|: blocked/;

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
const BUILD_STATE = ["build.started", "build.waiting", "build.unwaiting", "build.paused", "build.unpaused",
  "build.stopped", "build.finished", "build.failed", "build.owner_lost", "build.resumed", "build.reset"];

/** Run 1. */
async function stopOnce(ctx: ScenarioContext): Promise<void> {
  const { rafi, computer } = ctx;
  await ctx.step("1: rafi stop: Q-CMD-6's line; stopping until T2's step ends, then stopped; T1's block kept",
    async () => {
    let stopped: RafiResult | null = null;
    let during = "";
    const { dir, r } = await whileT2Builds(ctx, async (d) => {
      stopped = await rafi("stop", { cwd: d });
      during = (await rafi("status", { cwd: d })).output;
    }, () => computer.script.rules.push(on("builder T1#1 @build", { reply: { ...DONE, kind: "blocked",
      summary: null, block: { type: "install", need: null, reason: "needs postgres" } } })));
    assert.equal(stopped!.code, 0, stopped!.output);
    assert.equal(stopped!.output.trim(), `rafi: ${STOP_LINE}`);
    assert.match(during, /: stopping;/);
    assert.equal(r.code, 0, r.output);
    const e = await exported(ctx, dir);
    assert.deepEqual(of(e, "build.stopped"), [{ cause: "stop" }]);
    const key = (of(e, "turn.intent", "T2") as { key: string }[])[0]!.key;
    assert.ok(e.events.some((x) => x.type === "turn.reply" && x.data.key === key && x.data.outcome === "ok"),
      "T2's turn finished normally");
    const status = (await rafi("status", { cwd: dir })).output;
    assert.match(status, /: stopped;/);
    assert.match(status, /T1 is blocked: needs postgres/);
    assert.doesNotMatch(status.replace(/T1 is blocked: needs postgres/, ""), NEVER);
    assert.match((await rafi("stats show", { cwd: dir })).output, /^Run \S+: stopped/m);
  });
}

/** Run 2. */
async function stopTwice(ctx: ScenarioContext): Promise<void> {
  const { rafi, computer } = ctx;
  await ctx.step("2: rafi stop twice: the second cancels at once; the turn is cancelled; its evidence is kept",
    async () => {
      let second: RafiResult | null = null;
      const t0 = computer.clock.now().getTime();
      const { dir, r } = await whileT2Builds(ctx, async (d) => {
        await rafi("stop", { cwd: d });
        second = await rafi("stop", { cwd: d });
      });
      assert.equal(second!.code, 0);
      assert.equal(r.code, 0, r.output);
      assert.ok(computer.clock.now().getTime() - t0 < 10 * 60_000, "it didn't wait out the turn");
      const e = await exported(ctx, dir);
      assert.deepEqual(of(e, "build.stop_requested").map((x: { mode: string }) => x.mode), ["graceful", "now"]);
      assert.deepEqual(of(e, "build.stopped"), [{ cause: "cancel" }]);
      const cancelled = of(e, "turn.cancelled", "T2") as { cause: string; confirmed: boolean }[];
      assert.deepEqual(cancelled.map((c) => [c.cause, c.confirmed]), [["stop", true]]);
      const stats = (await rafi("stats show", { cwd: dir })).output;
      assert.match(stats, /^Run \S+: cancelled/m);
      assert.match(stats, /Interrupted turn T2 build attempt 1 \(cancelled, confirmed\)/);
      assert.match(stats, /activity: started on T2/);
      assert.match(stats, /changed files: [^\n]*src\/T2-wip\.txt/);
      assert.doesNotMatch((await rafi("status", { cwd: dir })).output, NEVER);
    });
}

scenario({
  id: "S-CRASH-3", covers: covers("S-CRASH-3"), modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    await stopOnce(ctx);
    await stopTwice(ctx);
    await step("3: Ctrl+C in the build's terminal: cancelled by Ctrl+C after the fake took the cancel; exit 130",
      async () => {
        const { dir, r } = await whileT2Builds(ctx, async (_d, live) => { live.interrupt(); });
        assert.equal(r.code, 130, r.output);
        const e = await exported(ctx, dir);
        assert.deepEqual(of(e, "build.stop_requested"), [{ mode: "now", source: "ctrl-c" }]);
        assert.deepEqual(of(e, "build.stopped"), [{ cause: "ctrl-c" }]);
        const at = (type: string) => e.events.findIndex((x) => x.type === type);
        assert.ok(e.events.some((x) => x.type === "turn.cancelled" && x.data.confirmed === true));
        assert.ok(at("turn.cancelled") < at("build.owner_released"), "released only after the cancel was confirmed");
        assert.match((await rafi("status", { cwd: dir })).output, /: cancelled by Ctrl\+C;/);
      });
    await step("4: a crash while T2's turn is out: no owner, the log's build state running, status says crashed",
      async () => {
        slowT2(computer);
        const r = await rafi("start . --steps 2", { crashAt: "2: sent, before any reply (T2, build" });
        assert.ok(r.crashed);
        const e = await exported(ctx);
        assert.equal(e.events.filter((x) => BUILD_STATE.includes(x.type)).at(-1)?.type, "build.started",
          "the stored state is still running");
        const status = await rafi("status");
        assert.match(status.output, /: crashed/);
        assert.match(status.output, /`rafi resume`/);
        assert.doesNotMatch(status.output, /failed|blocked|waiting on you/);
        const stats = await rafi("stats show");
        assert.match(stats.output, /^Run \S+: crashed/m);
      });
    await step("5: Manager /pause: status says pausing, then paused at the next safe point; rafi stop ends it",
      async () => {
        let paused = "";
        let pausing = "";
        const { dir, r } = await whileT2Builds(ctx, async (d, live) => {
          const id = await run(ctx, d);
          const m = await rafi(`manager --ask "/pause ${id} T2"`, { cwd: d });
          assert.equal(m.code, 0, m.output);
          pausing = (await rafi("status", { cwd: d })).output;
          void live.expect(/Paused/).then(async () => {
            paused = (await rafi("status", { cwd: d })).output;
            await rafi("stop", { cwd: d });
          });
        });
        assert.match(pausing, /: pausing;/);
        assert.match(paused, /: paused;/);
        assert.equal(r.code, 0, r.output);
        const e = await exported(ctx, dir);
        const pauses = e.events.filter((x) => x.type === "build.pause_requested");
        assert.deepEqual(pauses.map((x) => [x.actor, x.source, x.data.source]), [["manager", "manager", "manager"]]);
        assert.equal(of(e, "build.paused").length, 1);
        const key = (of(e, "turn.intent", "T2") as { key: string }[])[0]!.key;
        assert.ok(e.events.findIndex((x) => x.type === "build.paused") >
          e.events.findIndex((x) => x.type === "turn.reply" && x.data.key === key), "paused at the next safe point");
        assert.doesNotMatch(paused, NEVER);
      });
  },
});
