// Every structured reply uses the same repair (SCN 3.5): S-MAL-3's QA runs (M3): QA writing the requirements file,
// QA's verdict, and the builder's fix after a QA rejection. The Planner and Ticket Maker runs need M9.
import assert from "node:assert/strict";
import { registry } from "../checks/registry.js";
import { B, on } from "../fakes/script/behaviors.js";
import { happyPath } from "../fakes/script/roles.mjs";
import type { Behavior, MetaLike, Rule, TurnContext } from "../fakes/script/engine.js";
import { scenario } from "../harness/scenario.js";
import { exported, of } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

const happy = (meta: MetaLike, ctx: TurnContext) => (happyPath(meta, ctx) as Behavior).reply;
/** The role's happy reply, sent with trailing text at byte 300; then the same reply as valid JSON. */
const broken = (selector: string): Rule[] => {
  let first: unknown = null;
  return [on(selector, (meta, ctx) => B.malformedOf(first = happy(meta, ctx), 300)),
    on(selector, () => B.repairOf(first))];
};

const RUNS: readonly [string, Rule[], string][] = [
  ["QA writing the requirements file", broken("qa T1 @prepare"), "qa@prepare"],
  ["QA's verdict", broken("qa T1#1 @review"), "qa@review"],
  ["the builder's fix after a QA rejection", [on("qa T1#1 @review", B.reject({ 1: "not yet" })),
    on("builder T1#2", B.malformed(300)), on("builder T1#2", B.repairOk())], "builder@fix"],
];

scenario({
  id: "S-MAL-3", covers: covers("S-MAL-3"), modes: ["next"], fixture: "F-ONE",
  async run(ctx) {
    const { rafi, step, computer, fixture, pending } = ctx;
    for (const [name, rules, where] of RUNS) {
      await step(`${name}: one repair request, S-MAL-1's wording, accepted; the command finishes`, async () => {
        const dir = fixture("F-ONE");
        computer.script.rules.length = 0;
        computer.script.transcript.length = 0;
        computer.script.rules.push(...rules);
        const r = await rafi("start . --steps 1", { cwd: dir });
        assert.equal(r.code, 0, r.output);
        const repairs = computer.script.transcript.filter((t) => t.repair);
        assert.equal(repairs.length, 1, JSON.stringify(computer.script.transcript.map((t) => t.step)));
        assert.equal(`${repairs[0]!.role}@${repairs[0]!.step}`, where);
        assert.match(repairs[0]!.message, /wasn't valid JSON: .* at byte 300\./);
        assert.match(repairs[0]!.message, /Send the same reply again as valid JSON in the same format\./);
        assert.match(repairs[0]!.message, /Don't run tools, read files or change anything\./);
        const e = await exported(ctx, dir);
        assert.deepEqual((of(e, "turn.repair") as { accepted: boolean; at_byte: number }[])
          .map((x) => [x.accepted, x.at_byte]), [[true, 300]]);
        assert.deepEqual(of(e, "turn.retry"), [], "the repaired reply was used");
        assert.ok(e.events.some((x) => x.type === "delivery.done" && x.ticket_id === "T1"));
      });
    }
    await pending("the Planner's malformed reply (rafi plan)", "M9");
    await pending("the Ticket Maker's malformed reply (rafi tickets populate)", "M9");
  },
});
