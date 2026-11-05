// S-START-2 (PRM-70: no stopping point given) and S-START-5 steps 1–3 (no QA, one ticket, skip); M5 plan items 1
// and 2, C188–C190, C192. Step 4 of S-START-5 runs in the process set (M4); step 5 needs notifications (M7).
import assert from "node:assert/strict";
import { registry } from "../checks/registry.js";
import { scenario } from "../harness/scenario.js";
import { exported, of } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
type Ticket = { id: string; status: string };

async function statuses(rafi: (line: string, o?: { cwd?: string }) => Promise<{ code: number; out: string;
  output: string }>, cwd?: string): Promise<Record<string, string>> {
  const r = await rafi("tickets show --all --json", { cwd });
  assert.equal(r.code, 0, r.output);
  return Object.fromEntries((JSON.parse(r.out) as { tickets: Ticket[] }).tickets.map((t) => [t.id, t.status]));
}
const done = (s: Record<string, string>) => Object.keys(s).filter((id) => s[id] === "done").sort();

scenario({
  id: "S-START-2", covers: covers("S-START-2"), modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    await step("1–2: in a terminal, PRM-70 offers tickets, complete stacks and up to a ticket; 2 tickets", async () => {
      const r = await rafi("start .", { tty: true, input: ["1", "2"] });
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /Build tickets or complete delivery stacks\?/);
      assert.match(r.output, /1\. Tickets \(Recommended\)\n\s+2\. Complete stacks\n\s+3\. Up to a ticket/);
      assert.match(r.output, /How many tickets\?/);
      assert.deepEqual(done(await statuses(rafi)), ["T1", "T2"]);
      const started = (of(await exported(ctx), "build.started") as { scope: unknown }[]).at(-1)!;
      assert.deepEqual(started.scope, { kind: "steps", value: 2, skip: [] });
    });
    await step("3: up to a ticket, T4: T1–T4 done", async () => {
      const r = await rafi("start .", { tty: true, input: ["3", "T4"] });
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /Up to which ticket\?/);
      assert.deepEqual(done(await statuses(rafi)), ["T1", "T2", "T3", "T4"]);
      const started = (of(await exported(ctx), "build.started") as { scope: unknown; tickets: string[] }[]).at(-1)!;
      assert.deepEqual(started.scope, { kind: "to_ticket", value: "T4", skip: [] });
    });
    await step("4: without a terminal, start . exits 1 in one line naming --steps, --stacks and --to-ticket; no "
      + "build.started, no agent turn", async () => {
      const before = await exported(ctx);
      const turns = computer.script.transcript.length;
      const r = await rafi("start .");
      assert.equal(r.code, 1, r.output);
      const lines = r.output.trim().split("\n");
      assert.equal(lines.length, 1, r.output);
      for (const flag of ["--steps", "--stacks", "--to-ticket"]) assert.ok(lines[0]!.includes(flag), flag);
      const after = await exported(ctx);
      assert.equal(of(after, "build.started").length, of(before, "build.started").length);
      assert.equal(computer.script.transcript.length, turns, "no agent turn");
      const auto = await rafi("start . --auto-approve");
      assert.equal(auto.code, 1, "auto-approve must give a stopping point too (FLAG-ST-R4)");
      assert.match(auto.output, /--steps.*--stacks.*--to-ticket/);
    });
    await step("FLAG-ST-R3: --steps with --to-ticket exits 1 before any build", async () => {
      const r = await rafi("start . --steps 2 --to-ticket T6");
      assert.equal(r.code, 1, r.output);
      assert.match(r.output, /--steps.*--to-ticket/);
      const s = await rafi("start . --to-ticket T9");
      assert.equal(s.code, 1, s.output);
      assert.match(s.output, /no ticket T9/);
    });
  },
});

scenario({
  id: "S-START-5", covers: covers("S-START-5"), modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, computer, pending } = ctx;
    await step("1: --steps 1 --no-qa: no QA turns; T1 done; QA recorded as off", async () => {
      const r = await rafi("start . --steps 1 --no-qa");
      assert.equal(r.code, 0, r.output);
      assert.ok(!computer.script.transcript.some((t) => t.role === "qa"), "no QA turns");
      assert.deepEqual(done(await statuses(rafi)), ["T1"]);
      const s = (of(await exported(ctx), "build.started") as { settings: Record<string, unknown> }[]).at(-1)!;
      assert.deepEqual(s.settings["harness.qa"], { value: false, source: "flag" });
    });
    await step("2: --ticket T4 --steps 1 without a terminal builds only T4 (C192)", async () => {
      const dir = ctx.fixture("F-CHAIN");
      const r = await rafi("start . --ticket T4 --steps 1", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(done(await statuses(rafi, dir)), ["T4"]);
    });
    await step("3: --steps 3 --skip T2: T1, T3, T4 done; T2 planned; T5 (needs T2) not started", async () => {
      const dir = ctx.fixture("F-CHAIN");
      const r = await rafi("start . --steps 3 --skip T2", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const s = await statuses(rafi, dir);
      assert.deepEqual(done(s), ["T1", "T3", "T4"]);
      assert.equal(s.T2, "planned");
      assert.equal(s.T5, "planned");
      const started = (of(await exported(ctx, dir), "build.started") as { scope: unknown }[]).at(-1)!;
      assert.deepEqual(started.scope, { kind: "steps", value: 3, skip: ["T2"] });
    });
    await step("a dependency decides: --steps 4 --skip T2 builds T6, never T5 (T5 needs T2)", async () => {
      const dir = ctx.fixture("F-CHAIN");
      const r = await rafi("start . --steps 4 --skip T2 --no-qa", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(done(await statuses(rafi, dir)), ["T1", "T3", "T4", "T6"]);
    });
    await step("--skip a delivery unit skips its tickets; an unknown id exits 1 naming it", async () => {
      const dir = ctx.fixture("F-CHAIN");
      const r = await rafi("start . --steps 1 --skip U-T1", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(done(await statuses(rafi, dir)), ["T2"]);
      const bad = await rafi("start . --steps 1 --skip NOPE", { cwd: dir });
      assert.equal(bad.code, 1, bad.output);
      assert.match(bad.output, /NOPE/);
    });
    await step("C192: --ticket T5 (its dependency T2 not done) without a terminal exits 1 naming T2", async () => {
      const dir = ctx.fixture("F-CHAIN");
      const r = await rafi("start . --ticket T5 --steps 1", { cwd: dir });
      assert.equal(r.code, 1, r.output);
      assert.match(r.output, /T5 needs T2/);
      const t = await rafi("start . --ticket T5 --steps 1", { cwd: dir, tty: true, input: ["1"] });
      assert.equal(t.code, 0, t.output);
      assert.match(t.output, /Start eligible dependency T2: Ticket 2 instead\?/);
      assert.deepEqual(done(await statuses(rafi, dir)), ["T2"]);
    });
    await pending("4: --detach, then rafi status and rafi resume (runs in the process set: detach.process.ts)",
      "process set");
    await pending("5: a decision answered from the notification", "M7");
  },
});
