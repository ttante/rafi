// S-BATCH-1 (M5 plan item 4, C207): a seven-ticket batch on F-CHAIN with QA rejecting T3 once. Every ticket finishes
// in queue order, T5 only after T2's delivery; docs/ticket-progress.md is regenerated after each ticket, has a
// `Next up` heading and no LLM_NEXT_QUEUE, and no agent is told about it; builder T5's message carries T5, its
// numbered criteria and one line on T2, and no other ticket id. (S-SCN-9 joins this file in slice 5.)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { registry } from "../checks/registry.js";
import { addFiles } from "../fixtures/common.js";
import { B, on } from "../fakes/script/behaviors.js";
import { scenario } from "../harness/scenario.js";
import { exported } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

scenario({
  id: "S-BATCH-1", covers: covers("S-BATCH-1"), modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, project, computer } = ctx;
    computer.script.rules.push(on("qa T3#1 @review", B.reject({ 1: "not yet" })));
    // A project whose tracker is set up (FMT-K1, `rafi tickets init`): the doc is the tracker's view, as today.
    addFiles(project, { ".tickets/config.yaml": stringify({ app_name: "fixture", implementation_limit: 500,
      view_limit: 20000, timezone: "UTC" }) });
    const doc = path.join(project, "docs", "ticket-progress.md");
    const reads: { at: string; text: string | null }[] = [];
    await step("rafi start . --steps 7: every ticket done, in queue order, T5 after T2's delivery", async () => {
      const r = await rafi("start . --steps 7", { pauseAt: { at: (o) => o.startsWith("4:"), fn: async (o) => {
        reads.push({ at: o, text: existsSync(doc) ? readFileSync(doc, "utf8") : null });
      } } });
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx);
      const done = e.events.filter((x) => x.type === "delivery.done").map((x) => x.ticket_id);
      assert.deepEqual(done, ["T1", "T2", "T3", "T4", "T5", "T6", "T7"]);
      const started = (id: string) => e.events.find((x) => x.type === "ticket.started" && x.ticket_id === id)!.seq;
      const t2Done = e.events.find((x) => x.type === "delivery.done" && x.ticket_id === "T2")!.seq;
      assert.ok(started("T5") > t2Done, "T5 starts only after T2 is done");
    });
    await step("docs/ticket-progress.md is regenerated after each ticket, with Next up and no LLM_NEXT_QUEUE", () => {
      const final = readFileSync(doc, "utf8");
      assert.match(final, /^## Next up$/m);
      assert.doesNotMatch(final, /LLM_NEXT_QUEUE/);
      assert.match(final, /rafi tickets/);
      assert.doesNotMatch(final, /foreman tickets/);
      // Each ticket's first boundary after the previous ticket's done sees that ticket done in the file.
      for (const [prev, next] of [["T1", "T2"], ["T2", "T3"], ["T3", "T4"], ["T4", "T5"], ["T5", "T6"],
        ["T6", "T7"]]) {
        const read = reads.find((x) => x.at.includes(`(${next}`));
        assert.ok(read?.text, `a read during ${next}`);
        assert.match(read.text, new RegExp(`\\| ${prev} \\|[^\\n]*\\| done \\|`), `${prev} done when ${next} runs`);
      }
      const texts = new Set(reads.map((x) => x.text));
      assert.ok(texts.size >= 7, `regenerated after each ticket (${texts.size} versions)`);
    });
    await step("no instruction or message to any agent names the progress doc", () => {
      for (const sent of computer.sentToAgents) assert.doesNotMatch(sent, /ticket-progress/);
    });
    await step("builder T5's message: T5, its numbered criteria, one line on T2, no other ticket id", () => {
      const t5 = computer.script.transcript.find((t) => t.ticket === "T5" && t.role === "builder" &&
        t.step === "build")!;
      const message = t5.message;
      assert.match(message, /T5/);
      assert.match(message, /1\. Ticket 5 works\./);
      const t2Lines = message.split("\n").filter((l) => l.includes("T2"));
      assert.equal(t2Lines.length, 1, message);
      assert.match(t2Lines[0]!, /T2.*done/);
      for (const other of ["T1", "T3", "T4", "T6", "T7"]) assert.ok(!message.includes(other), `${other} in ${message}`);
    });
  },
});

// S-SCN-9 (M5 plan item 11, slice 5): F-BRANCH, `--steps 4 --branch-per-ticket`: four tickets finish across all three
// units; `rafi tickets queue` from a second rafi at T2's safe point still lists what remains; `rafi status` says
// the finished build finished.
scenario({
  id: "S-SCN-9", covers: covers("S-SCN-9"), modes: ["next"], fixture: "F-BRANCH",
  async run(ctx) {
    const { rafi, step } = ctx;
    let queue = "";
    await step("--steps 4 --branch-per-ticket: four tickets done across all three units", async () => {
      const r = await rafi("start . --steps 4 --branch-per-ticket", { pauseAt: { at: (o) => o.startsWith("4:") &&
        o.includes("(T2"), fn: async () => { queue = (await rafi("tickets queue")).output; } } });
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx);
      assert.deepEqual(e.events.filter((x) => x.type === "delivery.done").map((x) => x.ticket_id),
        ["T1", "T2", "T3", "T4"]);
      assert.equal(e.events.filter((x) => x.type === "git.branch_created").length, 4);
    });
    await step("tickets queue at T2's safe point doesn't say there's nothing left", () => {
      assert.doesNotMatch(queue, /No remaining tickets/);
      assert.match(queue, /T3/);
      assert.match(queue, /T4/);
    });
    await step("rafi status calls the finished build finished", async () => {
      const r = await rafi("status");
      assert.match(r.output, /finished/i);
      assert.doesNotMatch(r.output, /incomplete|stopped|crashed/i);
    });
  },
});
