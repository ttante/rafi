// S-SCN-12 (SCN 4.1): no stale session pointers after a reset. QA rejects T1 once; the build crashes as the fix
// starts; `rafi reset` (this build, restart-current, handled) puts T1 back; the next build starts every role in a
// new session, T1 at attempt 1, and the old run stays in `rafi stats` (P31, C154).
import assert from "node:assert/strict";
import { registry } from "../checks/registry.js";
import { B, on } from "../fakes/script/behaviors.js";
import { scenario } from "../harness/scenario.js";
import { exported, of } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

scenario({
  id: "S-SCN-12", covers: covers("S-SCN-12"), modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, computer } = ctx;
    computer.script.rules.push(on("qa T1#1 @review", B.reject({ 1: "not yet" })));
    let oldRun = "";
    let mark = 0;
    await step("build until QA hands the rejection to the builder; crash; reset this build", async () => {
      const crashed = await rafi("start . --steps 1", { crashAt: "1: intent, before sending (T1, fix" });
      assert.ok(crashed.crashed, crashed.output);
      oldRun = (await exported(ctx)).events.find((e) => e.type === "build.started")!.run_id!;
      const r = await rafi("reset --build --action restart-current --cleanup handled --yes");
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /rafi reset --build --action restart-current --cleanup handled --yes/);
      const e = await exported(ctx);
      assert.deepEqual(of(e, "build.reset").map((x: { scope: string; tickets: string[] }) => [x.scope, x.tickets]),
        [["build", ["T1"]]]);
      mark = e.events.length;
    });
    await step("between the reset and the next start: status says reset; resume and stop find nothing", async () => {
      assert.match((await rafi("status")).output, new RegExp(`Build ${oldRun}: reset;`));
      assert.match((await rafi("resume")).output, /Nothing to resume\./);
      assert.match((await rafi("stop")).output, /No build is running here\./);
    });
    await step("the next build: every role in a new session, T1 at attempt 1, the old run still in stats", async () => {
      const before = computer.script.transcript.length;
      const r = await rafi("start . --steps 1");
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx);
      const intents = e.events.slice(mark).filter((x) => x.type === "turn.intent")
        .map((x) => x.data as { role: string; ticket: string; session: string; attempt: number });
      const firsts = new Map<string, string>();
      for (const i of intents) if (!firsts.has(`${i.ticket}|${i.role}`)) firsts.set(`${i.ticket}|${i.role}`, i.session);
      assert.ok(firsts.size >= 2, JSON.stringify(intents));
      for (const [who, session] of firsts) assert.equal(session, "new", who);
      const builder = intents.find((i) => i.ticket === "T1" && i.role === "builder")!;
      assert.equal(builder.attempt, 1, "T1 restarts at attempt 1");
      const after = computer.script.transcript.slice(before);
      for (const role of ["builder", "qa"]) {
        assert.equal(after.find((t) => t.role === role)?.session, "new", `${role}'s first request opens a session`);
      }
      assert.match((await rafi(`stats show --run ${oldRun}`)).output, new RegExp(`^Run ${oldRun}: reset`, "m"));
      assert.equal(e.events.filter((x) => x.type === "build.reset").length, 1);
    });
  },
});
