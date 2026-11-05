// S-TAG-5 (file patterns add tags, with reasons), S-TAG-4 (QA gets the builder's tags plus the changed files') and
// S-TAG-1 (packs, skills and tools by tag), M5 plan item 6, C220, C221, C222, C239. Tags are recorded as
// `ticket.tags_added` with one reason each, before the turn that uses them, with no agent turn in between, and
// shown in the terminal; rafi only adds.
import assert from "node:assert/strict";
import { registry } from "../checks/registry.js";
import type { EventsExport } from "../checks/invariants.js";
import { B, on } from "../fakes/script/behaviors.js";
import { configure } from "../fixtures/common.js";
import { tempRoot } from "../fixtures/common.js";
import { fUi } from "../fixtures/f-ui.js";
import { scenario } from "../harness/scenario.js";
import { exported } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
type Tag = { tag: string; reason: string };
const added = (e: EventsExport, ticket: string) => e.events.filter((x) => x.type === "ticket.tags_added" &&
  x.ticket_id === ticket);
const intentOf = (e: EventsExport, ticket: string, role: string, step: string) => e.events.find((x) =>
  x.type === "turn.intent" && (x.data as { ticket: string; role: string; step: string }).ticket === ticket &&
  (x.data as { role: string }).role === role && (x.data as { step: string }).step === step)!;

scenario({
  id: "S-TAG-5", covers: covers("S-TAG-5"), modes: ["next"], fixture: "none",
  async run(ctx) {
    const { rafi, step } = ctx;
    const dir = fUi(ctx.root);
    await step("before T1 builds, ui is added because src/App.tsx matches **/*.tsx, with that reason, shown, and "
      + "with no agent turn in between", async () => {
      const r = await rafi("start . --steps 1 --no-qa", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx, dir);
      const tags = added(e, "T1");
      assert.equal(tags.length, 1, JSON.stringify(tags));
      assert.deepEqual((tags[0]!.data as { tags: Tag[] }).tags,
        [{ tag: "ui", reason: "src/App.tsx matches **/*.tsx" }]);
      const build = intentOf(e, "T1", "builder", "build");
      assert.ok(tags[0]!.seq < build.seq, "added before the builder's turn");
      const between = e.events.filter((x) => x.seq > tags[0]!.seq && x.seq < build.seq && x.type === "turn.intent");
      assert.deepEqual(between, [], "no agent turn in between");
      assert.match(r.output, /T1: tag ui added \(src\/App\.tsx matches \*\*\/\*\.tsx\)/);
      assert.deepEqual(added(e, "T2"), [], "T2's files match no pattern");
    });
    await step("2: run again on a fresh copy of the fixture, and after `rafi reset --everything`: ui is added "
      + "again, with the same reason", async () => {
      const reason = [{ tag: "ui", reason: "src/App.tsx matches **/*.tsx" }];
      const fresh = fUi(tempRoot());
      const again = await rafi("start . --steps 1 --no-qa", { cwd: fresh });
      assert.equal(again.code, 0, again.output);
      assert.deepEqual(added(await exported(ctx, fresh), "T1").map((x) => (x.data as { tags: Tag[] }).tags),
        [reason]);
      const reset = await rafi("reset --everything --yes", { cwd: dir });
      assert.equal(reset.code, 0, reset.output);
      const rerun = await rafi("start . --steps 1 --no-qa", { cwd: dir });
      assert.equal(rerun.code, 0, rerun.output);
      assert.match(rerun.output, /T1: tag ui added \(src\/App\.tsx matches \*\*\/\*\.tsx\)/);
      const tags = added(await exported(ctx, dir), "T1").map((x) => (x.data as { tags: Tag[] }).tags);
      assert.deepEqual(tags, [reason, reason], "added once per run, never removed from the log");
    });
  },
});

scenario({
  id: "S-TAG-4", covers: covers("S-TAG-4"), modes: ["next"], fixture: "none",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    const dir = fUi(ctx.root);
    computer.script.rules.push(on("builder T2#1 @build", B.also({ edit: "src/Panel.tsx",
      content: "export const Panel = () => null;\n" })));
    await step("rafi start . --steps 2", async () => {
      const r = await rafi("start . --steps 2", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /T2: tag ui added \(builder changed src\/Panel\.tsx \(matches \*\*\/\*\.tsx\)\)/);
    });
    await step("T1: builder and QA get the same tags (nothing added between the builder and QA)", async () => {
      const e = await exported(ctx, dir);
      const build = intentOf(e, "T1", "builder", "build");
      const review = intentOf(e, "T1", "qa", "review");
      assert.deepEqual(added(e, "T1").filter((x) => x.seq > build.seq && x.seq < review.seq), []);
    });
    await step("T2: QA also gets ui, added because the builder changed src/Panel.tsx, before QA's review", async () => {
      const e = await exported(ctx, dir);
      const build = intentOf(e, "T2", "builder", "build");
      const review = intentOf(e, "T2", "qa", "review");
      const t2 = added(e, "T2");
      assert.equal(t2.length, 1, JSON.stringify(t2));
      assert.ok(t2[0]!.seq > build.seq && t2[0]!.seq < review.seq);
      assert.deepEqual((t2[0]!.data as { tags: Tag[] }).tags, [{ tag: "ui",
        reason: "builder changed src/Panel.tsx (matches **/*.tsx)" }]);
    });
  },
});

const AI_PACK = /^## AI And LLM Safety$/m;
const CORE = /^## Core Working Agreement$/m;
const DATABASE = /^## Data And Database Rules$/m;

scenario({
  id: "S-TAG-1", covers: covers("S-TAG-1"), modes: ["next"], fixture: "none",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    const dir = fUi(ctx.root, { usesAI: true });
    configure(dir, { tools: { "model-evals": { kind: "command", start: { command: "scripts/evals.sh" },
      description: "Run the model evals", roles: ["builder", "qa"], tags: ["ai"] } } });
    computer.script.rules.push(on("qa T2 @prepare", { reply: { requirements: [{ from: 1, text: "Items are stored",
      check: null, expect: null }], in_scope: [], out_of_scope: [], risks: [], add_tags: ["security", "nonsense"] } }));
    let output = "";
    await step("rafi start . --steps 3", async () => {
      const r = await rafi("start . --steps 3", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      output = r.output;
    });
    const opened = (ticket: string) => computer.script.transcript.filter((t) => t.ticket === ticket &&
      t.session === "new" && (t.role === "builder" || t.role === "qa"));
    await step("T2 (database): builder and QA instructions hold no AI pack, and the database pack", async () => {
      const sessions = opened("T2");
      assert.deepEqual([...new Set(sessions.map((t) => t.role))].sort(), ["builder", "qa"]);
      for (const t of sessions) {
        assert.doesNotMatch(t.instructions, AI_PACK, `${t.role} ${t.step}`);
        assert.match(t.instructions, DATABASE, `${t.role} ${t.step}`);
        assert.doesNotMatch(t.instructions, /model-evals/, "the ai tool isn't T2's");
      }
    });
    await step("T3 (ai): builder and QA instructions hold the AI packs and the ai tool, not the database pack",
      async () => {
        const sessions = opened("T3");
        assert.deepEqual([...new Set(sessions.map((t) => t.role))].sort(), ["builder", "qa"]);
        for (const t of sessions) {
          assert.match(t.instructions, AI_PACK, `${t.role} ${t.step}`);
          assert.doesNotMatch(t.instructions, DATABASE, `${t.role} ${t.step}`);
          assert.match(t.instructions, /Tools for this ticket: model-evals, for run the model evals/);
        }
      });
    await step("QA preparation's add_tags: security added with its reason before T2's builder, which gets its pack; "
      + "an unknown tag is skipped and named", async () => {
      const e = await exported(ctx, dir);
      const t2 = added(e, "T2");
      assert.deepEqual(t2.map((x) => (x.data as { tags: Tag[] }).tags), [[{ tag: "security",
        reason: "added by QA preparation" }]]);
      assert.ok(t2[0]!.seq < intentOf(e, "T2", "builder", "build").seq);
      const builder = opened("T2").find((t) => t.role === "builder")!;
      assert.match(builder.instructions, /^## Security, Privacy, And Compliance$/m);
      assert.doesNotMatch(opened("T1").find((t) => t.role === "builder")!.instructions,
        /^## Security, Privacy, And Compliance$/m, "T1 has no security tag");
      assert.match(output, /T2: tag security added \(added by QA preparation\)/);
      assert.match(output, /T2: QA preparation's tag nonsense isn't a known tag \(known: ui, backend, .*\); skipped/);
    });
    await step("every agent gets the always core once; skills by name and description only", async () => {
      for (const t of ["T1", "T2", "T3"].flatMap(opened)) {
        assert.equal(t.instructions.split(CORE.source.slice(1, -1)).length - 1, 1, `${t.ticket} ${t.role}`);
        assert.match(t.instructions, /^- tdd: Test-driven development/m, `${t.ticket} ${t.role}`);
        assert.doesNotMatch(t.instructions, /^## Philosophy$/m, "a skill's body never goes in");
      }
    });
  },
});
