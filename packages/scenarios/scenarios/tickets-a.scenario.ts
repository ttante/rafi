// S-CLI-4, the subcommands M5 part 4a builds on the log (plan item 5, C207–C210): init, update, complete, block,
// unblock, cancel, render, validate, queue and reorder. Each write is one event with its actor and changes no
// other field; `--queue-limit` is dropped (FLAG-TK-3). The rest of S-CLI-4's subcommands are in tickets-b.scenario.ts
// (part 4a-2); `populate` is M9.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { registry } from "../checks/registry.js";
import { git } from "../fixtures/common.js";
import { scenario } from "../harness/scenario.js";
import { exported } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

async function notYet(pending: (name: string, milestone: string) => Promise<void>): Promise<void> {
  await pending("populate (with --proposal-file, --authorize-retire, --waive-risk-notes)", "M9");
}

scenario({
  id: "S-CLI-4", covers: covers("S-CLI-4"), modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, project, pending } = ctx;
    const ticketsFile = path.join(project, ".tickets", "tickets.yaml");
    const status = async (id: string) => {
      const r = await rafi(`tickets show ${id} --json`);
      return (JSON.parse(r.out) as { tickets: { id: string; status: string }[] }).tickets.find((t) => t.id === id)!
        .status;
    };
    const lastEvent = async () => (await exported(ctx)).events.at(-1)!;
    await step("init: .tickets/config.yaml with 500 / 20000 / UTC, the schema, the rules and progress docs; "
      + "--queue-limit is dropped", async () => {
      const dropped = await rafi("tickets init -y --queue-limit 9");
      assert.equal(dropped.code, 1, dropped.output);
      const r = await rafi("tickets init -y");
      assert.equal(r.code, 0, r.output);
      const config = parse(readFileSync(path.join(project, ".tickets", "config.yaml"), "utf8"));
      assert.equal(config.implementation_limit, 500);
      assert.equal(config.view_limit, 20000);
      assert.equal(config.timezone, "UTC");
      for (const file of [".tickets/schema/tickets.schema.json", ".tickets/tracker-rules.md",
        "docs/ticket-progress.md"]) assert.ok(existsSync(path.join(project, file)), file);
      assert.match(readFileSync(path.join(project, ".tickets", "tracker-rules.md"), "utf8"), /Written by rafi/);
      const again = await rafi("tickets init -y");
      assert.equal(again.code, 0, "init again keeps what's there");
    });
    await step("update, block, unblock: one ticket.status_set each, with its actor; tickets.yaml unchanged",
      async () => {
      const before = readFileSync(ticketsFile, "utf8");
      const u = await rafi("tickets update T1 --status next --summary 'looked at it'");
      assert.equal(u.code, 0, u.output);
      const e = await lastEvent();
      assert.deepEqual([e.type, e.ticket_id, e.actor, (e.data as { status: string }).status],
        ["ticket.status_set", "T1", "user", "next"]);
      assert.equal(await status("T1"), "planned", "next maps to planned in 1.0's tracker view");
      assert.equal((await rafi("tickets block T2 --summary 'waiting on design' --actor manager")).code, 0);
      const b = await lastEvent();
      assert.deepEqual([b.type, b.actor], ["ticket.status_set", "manager"]);
      assert.equal(await status("T2"), "blocked");
      assert.equal((await rafi("tickets unblock T2")).code, 0);
      assert.equal(await status("T2"), "planned");
      assert.equal(readFileSync(ticketsFile, "utf8"), before);
      const bad = await rafi("tickets update T1 --actor somebody");
      assert.equal(bad.code, 1, bad.output);
      assert.match(bad.output, /--actor/);
    });
    await step("complete: without evidence exits 1 unless not_applicable; with evidence, done with it", async () => {
      const no = await rafi("tickets complete T3");
      assert.equal(no.code, 1, no.output);
      assert.match(no.output, /--evidence/);
      assert.equal((await rafi("tickets complete T3 --evidence 'ran it by hand'")).code, 0);
      assert.equal(await status("T3"), "done");
      assert.equal(((await lastEvent()).data as { evidence: string }).evidence, "ran it by hand");
      assert.equal((await rafi("tickets complete T6 --validation-result not_applicable")).code, 0);
      assert.equal(await status("T6"), "done");
    });
    await step("cancel: without --summary exits 1; with it, canceled", async () => {
      assert.equal((await rafi("tickets cancel T4")).code, 1);
      const r = await rafi("tickets cancel T4 --summary 'not needed'");
      assert.equal(r.code, 0, r.output);
      assert.equal(await status("T4"), "canceled");
      assert.equal((await lastEvent()).type, "ticket.dropped");
    });
    await step("render regenerates the progress doc; validate passes clean, then exits 1 on a schema error",
      async () => {
        const doc = path.join(project, "docs", "ticket-progress.md");
        writeFileSync(doc, "stale\n");
        assert.equal((await rafi("tickets render")).code, 0);
        assert.match(readFileSync(doc, "utf8"), /## Next up/);
        const ok = await rafi("tickets validate");
        assert.equal(ok.code, 0, ok.output);
        assert.match(ok.out, /validation passed — all 4 passes clean/);
        const saved = readFileSync(ticketsFile, "utf8");
        writeFileSync(ticketsFile, saved.replace("risk: Low", "risk: Unknown"));
        const bad = await rafi("tickets validate");
        assert.equal(bad.code, 1, bad.output);
        assert.match(bad.output, /risk/);
        writeFileSync(ticketsFile, saved);
      });
    await step("queue --limit 2 prints two rows", async () => {
      const r = await rafi("tickets queue --limit 2");
      assert.equal(r.code, 0, r.output);
      const rows = r.out.split("\n").filter((l) => /^\s*\d+\.\s+T\d/.test(l));
      assert.equal(rows.length, 2, r.out);
    });
    await step("reorder T7 --order 1: tickets.yaml's order and the queue change; one tickets.changed by you",
      async () => {
        const r = await rafi("tickets reorder T7 --order 1");
        assert.equal(r.code, 0, r.output);
        const tickets = (parse(readFileSync(ticketsFile, "utf8")) as { tickets: { id: string; order: number }[] })
          .tickets;
        assert.equal(tickets.find((t) => t.id === "T7")!.order, 1);
        const q = await rafi("tickets queue --limit 1");
        assert.match(q.out, /1\.\s+T7/);
        const e = await lastEvent();
        assert.equal(e.type, "tickets.changed");
        assert.deepEqual((e.data as { by: string; items: unknown[] }).by, "user");
        git(project, ["status", "--porcelain"]);
      });
    await notYet(pending);
  },
});
