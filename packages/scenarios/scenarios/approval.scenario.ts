// S-START-3 steps 1, 2 and 4 (M5 plan item 3, C191): an approved, unchanged scope starts with no question; a
// material change asks PRM-71 once (Proceed / Give feedback / Cancel); auto-approve answers it and the log says so.
// Step 3 (feedback to the Planner) is M8.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { registry } from "../checks/registry.js";
import { setTickets } from "../fixtures/common.js";
import { approvedPlan } from "../fixtures/plan.js";
import { scenario } from "../harness/scenario.js";
import { exported, of } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
const PLAN_Q = /How does this plan look\?/g;

scenario({
  id: "S-START-3", covers: covers("S-START-3"), modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, project, pending } = ctx;
    approvedPlan(project);
    await step("1: an approved, unchanged scope starts with no plan question", async () => {
      const r = await rafi("start . --steps 1", { tty: true });
      assert.equal(r.code, 0, r.output);
      assert.doesNotMatch(r.output, PLAN_Q);
      const approved = of(await exported(ctx), "scope.approved") as { by: string }[];
      assert.deepEqual(approved.map((a) => a.by), ["carried"], "the progress file's approval is carried into the log");
    });
    await step("2: a material change (T3's acceptance) asks once: Proceed / Give feedback / Cancel", async () => {
      setTickets(project, { T3: { acceptance: ["Ticket 3 works.", "And it logs."] } });
      const r = await rafi("start . --steps 1", { tty: true, input: ["1"] });
      assert.equal(r.code, 0, r.output);
      assert.equal(r.output.match(PLAN_Q)?.length, 1, r.output);
      assert.match(r.output, /1\. Proceed — start implementing\n\s+2\. Give feedback — revise the plan\n\s+3\. Cancel/);
      const e = await exported(ctx);
      assert.deepEqual((of(e, "scope.approved") as { by: string }[]).map((a) => a.by), ["carried", "user"]);
      const answers = parse(readFileSync(path.join(project, ".rafi", "progress.yaml"), "utf8")).answers;
      assert.ok(Object.keys(answers).some((k) => /^scope\|1\|sha256:[0-9a-f]{64}$/.test(k)), JSON.stringify(answers));
      const again = await rafi("start . --steps 1", { tty: true });
      assert.doesNotMatch(again.output, PLAN_Q, "approved now: no question");
    });
    await pending("3: Give feedback sends it to the Planner and asks again", "M8");
    await step("Give feedback says it arrives in M8 and asks again; Cancel exits 0 and writes nothing", async () => {
      setTickets(project, { T6: { required_tests: ["npm test", "npm run lint"] } });
      const before = (await exported(ctx)).events.length;
      const r = await rafi("start . --steps 1", { tty: true, input: ["2", "3"] });
      assert.equal(r.code, 0, r.output);
      assert.equal(r.output.match(PLAN_Q)?.length, 2, r.output);
      assert.match(r.output, /isn't in the new engine yet \(milestone M8\)/);
      assert.equal((await exported(ctx)).events.length, before, "Cancel writes nothing");
      const none = await rafi("start . --steps 1");
      assert.equal(none.code, 1, none.output);
      assert.match(none.output, /--auto-approve/);
    });
    await step("4: edit T4; --auto-approve: no question; the log records the approval as by auto-approve", async () => {
      setTickets(project, { T4: { acceptance: ["Ticket 4 works, twice."] } });
      const r = await rafi("start . --steps 1 --auto-approve", { tty: true });
      assert.equal(r.code, 0, r.output);
      assert.doesNotMatch(r.output, PLAN_Q);
      assert.equal((of(await exported(ctx), "scope.approved") as { by: string }[]).at(-1)!.by, "auto-approve");
    });
    await step("rewording a title only isn't material: no question", async () => {
      setTickets(project, { T7: { title: "Ticket seven, reworded" } });
      const r = await rafi("start . --steps 1", { tty: true });
      assert.equal(r.code, 0, r.output);
      assert.doesNotMatch(r.output, PLAN_Q);
    });
  },
});
