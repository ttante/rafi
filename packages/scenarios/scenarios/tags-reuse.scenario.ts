// S-TAG-3 (SCN :771-775; M5 plan item 7, C223): with the reuse override (`rafi agents --agent-type builder
// --session-strategy compact`), one builder session serves the build. Before `T1` it gets the tags of every ticket in
// scope (`ui`, `database`, `ai`) and their packs; `rafi tickets reorder T4 --order 2` from a second shell during `T1`
// brings `T4` (`mobile`) into the scope, and the next ticket's first message carries only what's new (nothing
// removed, no pack twice). The union is recorded on the session (`turn.activity {kind: "session-tags"}`), not as
// `ticket.tags_added`. Below the compaction threshold nothing compacts at ticket boundaries; on Codex the occupancy is
// the latest usage sample (20 of a 1000-token window), not the session total (5000), so nothing compacts (NEW-ADP-2).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import { countPerSession } from "../checks/transcript.js";
import { B, on } from "../fakes/script/behaviors.js";
import { configure } from "../fixtures/common.js";
import { fUi } from "../fixtures/f-ui.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
const HEADINGS = ["## Core Working Agreement", "## Accessibility, UX, And Product Quality",
  "## Data And Database Rules",
  "## AI And LLM Safety"];

async function reuseBuild(ctx: ScenarioContext, runtime: "claude" | "codex") {
  const { rafi, computer } = ctx;
  if (runtime === "codex") mkdirSync(path.join(ctx.root, "codex"), { recursive: true });
  const dir = fUi(runtime === "codex" ? path.join(ctx.root, "codex") : ctx.root,
    { extra: [{ id: "T4", title: "Ship the phone app", tags: ["mobile"] }] });
  configure(dir, { tools: { "phone-check": { kind: "command", start: { command: "scripts/phone.sh" },
    description: "Check the phone build", roles: ["builder"], tags: ["mobile"] } } });
  const agents = await rafi(`agents --agent-type builder --session-strategy compact --auto-compact-threshold 50${
    runtime === "codex" ? " --agent-make codex" : ""}`, { cwd: dir });
  assert.equal(agents.code, 0, agents.output);
  // Every builder turn takes two minutes on the clock, so the reorder lands during T1; on Codex each reports a
  // session total of 5000 against a 1000-token window, with the fake's latest sample of 20.
  const slow = B.slow(2) as (meta: never, c: never) => object;
  computer.script.rules.unshift(on("builder", (meta, c) => ({ ...slow(meta as never, c as never),
    ...(runtime === "codex" ? { usage: { inputTokens: 4000, outputTokens: 1000 }, contextWindow: 1000 } : {}) })));
  let reorder = null as null | { code: number; output: string };
  computer.clock.whenTimer("agent", async () => {
    reorder ??= await rafi("tickets reorder T4 --order 2", { cwd: dir });
  });
  const from = computer.script.transcript.length;
  const r = await rafi.start("start . --steps 3", { cwd: dir }).done();
  assert.equal(r.code, 0, r.output);
  assert.equal(reorder?.code, 0, reorder?.output);
  return { dir, builders: computer.script.transcript.slice(from).filter((t) => t.role === "builder") };
}

const sessionTags = async (ctx: ScenarioContext, dir: string) => (await exported(ctx, dir)).events
  .filter((e) => e.type === "turn.activity" && (e.data as { kind: string }).kind === "session-tags")
  .map((e) => (e.data as { text: string }).text);

scenario({
  id: "S-TAG-3", covers: covers("S-TAG-3"), modes: ["next"], fixture: "none",
  async run(ctx) {
    const { step, computer } = ctx;
    let built = null as Awaited<ReturnType<typeof reuseBuild>> | null;
    await step("rafi agents --agent-type builder --session-strategy compact; start --steps 3; reorder T4 during T1",
      async () => { built = await reuseBuild(ctx, "claude"); });
    await step("one builder session for the build", async () => {
      assert.deepEqual(built!.builders.map((t) => t.session).filter((s) => s === "new"), ["new"]);
      assert.deepEqual([...new Set(built!.builders.map((t) => t.ticket))], ["T1", "T4", "T2"]);
    });
    await step("before T1 it holds the packs of ui, database and ai (every ticket in scope)", async () => {
      const first = built!.builders[0]!;
      assert.equal(first.ticket, "T1");
      for (const h of HEADINGS) assert.ok(first.instructions.includes(h), h);
      const recorded = await sessionTags(ctx, built!.dir);
      assert.equal(recorded[0], "ai, database, ui");
    });
    await step("the next ticket's first message adds mobile's context, repeats no pack, removes nothing", async () => {
      const recorded = await sessionTags(ctx, built!.dir);
      assert.deepEqual(recorded, ["ai, database, ui", "ai, database, mobile, ui (added: mobile)"]);
      const t4 = built!.builders.find((t) => t.ticket === "T4")!;
      assert.match(t4.message, /Tools for this ticket: phone-check, for check the phone build/);
      for (const h of HEADINGS) assert.deepEqual(countPerSession(built!.builders, h), [1], h);
      const added = (await exported(ctx, built!.dir)).events.filter((e) => e.type === "ticket.tags_added" &&
        (e.data as { tags: { tag: string }[] }).tags.some((t) => t.tag === "mobile"));
      assert.deepEqual(added, [], "the union is the session's, not a ticket.tags_added");
    });
    await step("below the threshold, no compaction at ticket boundaries", async () => {
      const e = await exported(ctx, built!.dir);
      assert.deepEqual(e.events.filter((x) => x.type === "turn.activity" &&
        (x.data as { kind: string }).kind === "compaction"), []);
      assert.ok(!computer.sentToAgents.some((m) => m.includes("thread/compact/start")));
    });
    await step("Codex: a session total of 5000 against a 1000-token window with a latest sample of 20: one session, "
      + "no compaction (occupancy from the latest sample)", async () => {
      const { dir, builders } = await reuseBuild(ctx, "codex");
      assert.ok(builders.every((t) => t.runtime === "codex"));
      assert.deepEqual(builders.map((t) => t.session).filter((s) => s === "new"), ["new"]);
      assert.ok(!computer.sentToAgents.some((m) => m.includes("thread/compact/start")), "rafi asked for none");
      const e = await exported(ctx, dir);
      assert.deepEqual(e.events.filter((x) => x.type === "turn.activity" &&
        (x.data as { kind: string }).kind === "compaction"), []);
    });
  },
});
