// Tests and checks with QA on (SCN 5.5): S-CHK-2 in full; S-CHK-3 step 1 on F-TESTS-LOCAL (P22), without the setup
// script's run (M7) and without step 2's plan restore (M8). Mode next.
import assert from "node:assert/strict";
import { registry } from "../checks/registry.js";
import { B, on } from "../fakes/script/behaviors.js";
import { happyPath } from "../fakes/script/roles.mjs";
import type { Behavior, MetaLike, Step, TurnContext } from "../fakes/script/engine.js";
import { addFiles, setTickets } from "../fixtures/common.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported, of, ticketJson, turn } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

type Run = { run: number; command: string; asked_by: string; outcome: string };

/** The builder's happy edit, then these steps, then done citing its runs. */
const builderThen = (...steps: Step[]) => (meta: MetaLike, ctx: TurnContext): Behavior => {
  const base = happyPath(meta, ctx) as Behavior;
  return { ...base, steps: [...(base.steps ?? []).filter((s) => s.edit), ...steps] };
};

function chk2(ctx: ScenarioContext, dir: string, r2: string[]): void {
  addFiles(dir, { "r1.test": "// r1\n", "r2.test": "// r2\n", "src/r1.js": "1\n", "src/r2.js": "2\n" });
  setTickets(dir, { T1: { acceptance: ["R1 holds.", "R2 holds."],
    required_tests: ["fake-test r1.test", "fake-test r2.test"] } });
  const { computer } = ctx;
  computer.script.rules.length = 0;
  computer.script.transcript.length = 0;
  computer.checks.log.length = 0;
  computer.checks.tests = { "r1.test": { outcomes: ["pass"], related: ["src/r1.js"] },
    "r2.test": { outcomes: r2, related: ["src/r2.js"] } };
  computer.script.rules.push(on("qa T1 @prepare", B.requirements([
    { from: 1, text: "R1 holds.", check: "fake-test r1.test" },
    { from: 2, text: "R2 holds.", check: "fake-test r2.test" },
  ])), on("builder T1#1", builderThen({ runCheck: "fake-test r1.test" }, { runCheck: "fake-test r2.test" },
    { edit: "src/r2.js", content: "2, edited\n" })));
}

scenario({
  id: "S-CHK-2", covers: covers("S-CHK-2"), modes: ["next"], fixture: "F-TESTS-LOCAL",
  async run(ctx) {
    const { rafi, step, computer, fixture, project } = ctx;
    await step("A: only R2's check reruns (src/r2.js is related to it); R1's run is reused; QA gets both", async () => {
      chk2(ctx, project, ["pass"]);
      const r = await rafi("start . --ticket T1 --steps 1");
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx);
      const runs = of(e, "check.run", "T1") as Run[];
      const byRafi = runs.filter((x) => x.asked_by === "rafi");
      assert.deepEqual(byRafi.map((x) => x.command), ["fake-test r2.test"]);
      const r1 = runs.find((x) => x.asked_by === "builder" && x.command === "fake-test r1.test")!;
      const passed = (of(e, "checks.passed", "T1") as { runs: number[]; reused: number[] }[])[0]!;
      assert.ok(passed.reused.includes(r1.run), JSON.stringify(passed));
      const review = turn(computer.script.transcript, "qa", "review", 1)!;
      assert.match(review.message, new RegExp(`- run ${r1.run}: \`fake-test r1\\.test\` passed`));
      assert.match(review.message, new RegExp(`- run ${byRafi[0]!.run}: \`fake-test r2\\.test\` passed`));
    });
    await step("B: the rerun fails: straight back to the builder, no QA turn first; it counts as a fix", async () => {
      const dir = fixture("F-TESTS-LOCAL");
      chk2(ctx, dir, ["pass", "fail(1)", "pass"]);
      const r = await rafi("start . --ticket T1 --steps 1", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const order = computer.script.transcript.map((t) => `${t.role}@${t.step}`);
      assert.deepEqual(order.slice(0, 3), ["qa@prepare", "builder@build", "builder@fix"]);
      assert.equal((await ticketJson(ctx, "T1", dir)).fixes, 1);
    });
  },
});

const TEN = ["t1.test", "t2.test", "t3.test", "a1.test", "a2.test", "b1.test", "b2.test", "b3.test", "b4.test",
  "b5.test"];

scenario({
  id: "S-CHK-3", covers: covers("S-CHK-3"), modes: ["next"], fixture: "F-TESTS-LOCAL",
  async run(ctx) {
    const { rafi, step, computer, pending, project } = ctx;
    await step("1: only T1's requirement checks and the two related test files run; QA's extra test is recorded",
      async () => {
        addFiles(project, { "src/a.js": "a\n", "e2e/a.spec": "// e2e\n", ...Object.fromEntries(TEN.slice(3)
          .map((f) => [f, `// ${f}\n`])) });
        computer.checks.tests = Object.fromEntries(TEN.map((f) => [f, { outcomes: ["pass"],
          related: f.startsWith("a") ? ["src/a.js"] : [] }]));
        computer.checks.tests["e2e/a.spec"] = { outcomes: ["pass"] };
        computer.script.rules.push(on("builder T1#1", B.edit("src/a.js")),
          on("qa T1#1 @review", B.also({ runCheck: "fake-test e2e/a.spec" })));
        const r = await rafi("start . --ticket T1 --steps 1");
        assert.equal(r.code, 0, r.output);
        const ran = new Set(computer.checks.log.filter((l) => !l.args.includes("--listTests"))
          .flatMap((l) => l.args.filter((a) => !a.startsWith("-"))));
        assert.deepEqual([...ran].sort(), ["a1.test", "a2.test", "e2e/a.spec", "t1.test"]);
        const runs = of(await exported(ctx), "check.run", "T1") as Run[];
        assert.deepEqual(runs.filter((x) => x.asked_by === "qa").map((x) => x.command), ["fake-test e2e/a.spec"]);
        assert.deepEqual(runs.filter((x) => x.asked_by === "rafi").map((x) => x.command).sort(),
          ["fake-test a1.test", "fake-test a2.test"]);
      });
    await pending("1: the setup script's run is recorded like a test (P22)", "M7");
    await pending("2: plan restore, then QA's re-check reads the recorded runs the same way", "M8");
  },
});
