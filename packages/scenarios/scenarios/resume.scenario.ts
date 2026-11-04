// S-CRASH-4 (SCN 3.7): resume attaches, picks and narrows; `rafi status` on a crashed build. S-CLI-13's picker,
// --discard and pruning are in interviews.scenario.ts.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import { B, on } from "../fakes/script/behaviors.js";
import { git } from "../fixtures/common.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import { writeInterviews } from "../fixtures/interviews.js";
import type { LiveRafi } from "../harness/rafi.js";
import { exported, of } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

/** Every file outside `.rafi/`, plus `.rafi/progress.yaml`, with its bytes (C147). */
export function projectFiles(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const rel = path.relative(base, file);
    if (rel === ".git" || (rel.startsWith(".rafi") && rel !== path.join(".rafi", "progress.yaml") && rel !== ".rafi")) {
      continue;
    }
    if (statSync(file).isDirectory()) projectFiles(file, base, out);
    else out[rel] = readFileSync(file).toString("base64");
  }
  return out;
}

const CRASH_T2 = "2: sent, before any reply (T2, build";
const intents = async (ctx: ScenarioContext, dir: string, ticket: string) =>
  of(await exported(ctx, dir), "turn.intent", ticket) as { step: string; model: string | null; runtime: string }[];

/** Steps 2–4: the picker, --run, --ticket, the one-off agent and model, --allow, and -y without a terminal. */
async function pickAndNarrow(ctx: ScenarioContext): Promise<void> {
  const { rafi, step, fixture } = ctx;
  const dir = fixture("F-CHAIN");
  await step("2: a crashed build and a newer saved plan interview: one question, newest first, no recovery mode",
    async () => {
      assert.ok((await rafi("start . --steps 2", { cwd: dir, crashAt: CRASH_T2 })).crashed);
      writeInterviews(dir, [{ id: "plan-z9", workflow: "plan", status: "paused", title: "Plan the next release",
        updated_at: "2026-11-01T15:00:00.000Z" }]);
      const before = (await exported(ctx, dir)).events.length;
      const r = await rafi("resume", { cwd: dir, tty: true, input: [""] });
      assert.equal(r.output.match(/What should Rafi resume\?/g)?.length, 1, r.output);
      const at = (re: RegExp) => r.output.search(re);
      assert.ok(at(/Plan the next release/) > 0 && at(/Plan the next release/) < at(/Build \S+ \(crashed/), r.output);
      assert.doesNotMatch(r.output, /recovery|recover mode/i);
      assert.equal((await exported(ctx, dir)).events.length, before, "a cancelled pick writes nothing");
    });
  await step("3: --run <prefix>; --ticket T3 runs only T3; --agent/--model for this resume only; --allow refused",
    async () => {
      const run = (await exported(ctx, dir)).events.find((e) => e.type === "build.started")!.run_id!;
      const allow = await rafi("resume --allow internet", { cwd: dir });
      assert.equal(allow.code, 1);
      assert.match(allow.output, /isn't in the new engine yet \(milestone M7\)/);
      const narrowed = await rafi(`resume --run ${run.slice(0, 6)} --ticket T3`, { cwd: dir });
      assert.match(narrowed.output, /Only T3 runs this time/);
      const e = await exported(ctx, dir);
      assert.deepEqual(of(e, "build.resumed").map((x: { ticket: string | null }) => x.ticket), ["T3"]);
      assert.ok(e.events.some((x) => x.type === "delivery.done" && x.ticket_id === "T3"), narrowed.output);
      assert.equal((await intents(ctx, dir, "T2")).filter((i) => i.step === "build").length, 1, "T2 waits");
      const once = await rafi(`resume --run ${run} --agent claude --model m2`, { cwd: dir,
        crashAt: "1: intent, before sending (T2" });
      assert.ok(once.crashed, once.output);
      const resumed = of(await exported(ctx, dir), "build.resumed") as { settings: Record<string, unknown> }[];
      assert.deepEqual(resumed.at(-1)!.settings, { "agent.runtime": { value: "claude", source: "flag" },
        "agent.model": { value: "m2", source: "flag" } });
      assert.equal((await intents(ctx, dir, "T2")).at(-1)!.model, "m2");
      const after = await rafi(`resume --run ${run}`, { cwd: dir });
      assert.equal(after.code, 0, after.output);
      assert.equal((await intents(ctx, dir, "T2")).at(-1)!.model, null, "the next resume doesn't keep them");
    });
  await step("4: without a terminal, --auto-approve takes the most recent unfinished build", async () => {
    const other = fixture("F-CHAIN");
    assert.ok((await rafi("start . --steps 2", { cwd: other, crashAt: CRASH_T2 })).crashed);
    writeInterviews(other, [{ id: "plan-y8", workflow: "plan", status: "paused", title: "Plan more",
      updated_at: "2026-11-01T15:00:00.000Z" }]);
    const none = await rafi("resume", { cwd: other });
    assert.equal(none.code, 1);
    assert.match(none.output, /--run/);
    assert.match(none.output, /--id/);
    const r = await rafi("resume --auto-approve", { cwd: other });
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /Resuming \S+: T2's build step was interrupted/);
  });
}

scenario({
  id: "S-CRASH-4", covers: covers("S-CRASH-4"), modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, computer, fixture } = ctx;
    await step("1: terminal B's rafi resume attaches to terminal A's build: progress, no second build", async () => {
      computer.script.rules.push(on("builder T1#1 @build", B.slow(5, 1)));
      const a = rafi.start("start . --steps 2", { tty: true });
      let b: LiveRafi | null = null;
      computer.clock.whenTimer("agent", async () => {
        b = rafi.start("resume", { tty: true });
        await b.expect(/T1.*build started/);
      });
      const ra = await a.done();
      assert.equal(ra.code, 0, ra.output);
      const rb = await b!.done();
      assert.equal(rb.code, 0, rb.output);
      assert.match(rb.output, /T1 +build started/);
      assert.match(rb.output, /T2 +build started/, "it kept showing the build live");
      const e = await exported(ctx);
      assert.equal(of(e, "build.started").length, 1, "no second build");
      assert.equal(of(e, "build.owner_acquired").length, 1, "the attached view never took the build");
    });
    await pickAndNarrow(ctx);
    await step("5: rafi status on a crashed build names it, the last step, the redo and the command; reads only",
      async () => {
        const dir = fixture("F-CHAIN");
        const crashed = await rafi("start . --steps 2", { cwd: dir, crashAt: "2: sent, before any reply (T2, build" });
        assert.ok(crashed.crashed, crashed.output);
        const before = { git: git(dir, ["status", "--porcelain", "--untracked-files=all"]), files: projectFiles(dir),
          stats: (await rafi("stats export", { cwd: dir })).out };
        const r = await rafi("status", { cwd: dir });
        assert.equal(r.code, 0, r.output);
        const run = (JSON.parse(before.stats) as { events: { type: string; run_id: string }[] }).events
          .find((x) => x.type === "build.started")!.run_id;
        assert.match(r.output, new RegExp(`Build ${run}: crashed`));
        assert.doesNotMatch(r.output, /blocked|failed|waiting on you/);
        assert.match(r.output, /The last step that finished: T2's prepare step\./);
        assert.match(r.output, /`rafi resume` redoes T2's build step\./);
        assert.match(r.output, /No open questions\./);
        assert.match(r.output, /Continue with `rafi resume`\./);
        assert.deepEqual({ git: git(dir, ["status", "--porcelain", "--untracked-files=all"]), files: projectFiles(dir),
          stats: (await rafi("stats export", { cwd: dir })).out }, before, "status changed nothing");
        const fresh = fixture("F-ONE");
        assert.match((await rafi("status", { cwd: fresh })).output, /No build has run here yet/);
        assert.equal(existsSync(path.join(fresh, ".rafi")), false, "a reader creates nothing (C147)");
      });
  },
});
