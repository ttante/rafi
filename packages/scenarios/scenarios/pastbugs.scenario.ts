// Past bugs (SCN 4) in M2: S-SCN-1 (no commit yet, a huge ignored folder, heartbeat rows) and S-SCN-14 (harmless
// failed reads don't flood the output). Mode next.
import assert from "node:assert/strict";
import type { EventsExport } from "../checks/invariants.js";
import { registry } from "../checks/registry.js";
import { B, on } from "../fakes/script/behaviors.js";
import { scenario } from "../harness/scenario.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

scenario({
  id: "S-SCN-1", covers: covers("S-SCN-1"), modes: ["next"], fixture: "F-HUGE-NO-COMMIT",
  async run({ rafi, step, computer, fixture }) {
    await step("a repo with no commit yet stops with one line naming the first commit and the command", async () => {
      const r = await rafi("start . --steps 1");
      assert.equal(r.code, 1, r.output);
      assert.equal(r.err.trim().split("\n").length, 1, r.err);
      assert.match(r.err, /^rafi: this repository has no commit yet; make the first one with `git add -A && git/);
      assert.equal(computer.script.transcript.length, 0);
    });
    await step("the ignored folder isn't read; rafi's snapshot work is fast; heartbeat rows during 10 quiet minutes",
      async () => {
        // The real-time bound is on the extra time the 20,000 ignored files cost over the same build without them,
        // so a loaded or slow machine, which slows both builds alike, can't flake it.
        const timed = async (dir: string) => {
          computer.script.rules.length = 0;
          computer.script.transcript.length = 0;
          computer.script.rules.push(on("builder T1#1", B.slow(20, 10)));
          const started = performance.now();
          const result = await rafi("start . --steps 1", { cwd: dir });
          assert.equal(result.code, 0, result.output);
          return { r: result, ms: performance.now() - started };
        };
        const control = await timed(fixture("F-ONE"));
        const dir = fixture("F-HUGE-IGNORED");
        const { r, ms } = await timed(dir);
        assert.ok(ms - control.ms < 2000, `the snapshot work took ${Math.round(ms - control.ms)} ms more (${ms} ms)`);
        const e = JSON.parse((await rafi("stats export", { cwd: dir })).out) as EventsExport;
        const files = e.events.filter((x) => x.type === "facts.snapshot").flatMap((x) => x.data.files as string[]);
        assert.ok(!files.some((f) => f.startsWith("big/")), "the ignored folder isn't in any snapshot");
        const beats = r.out.split("\n").filter((l) => /^\d\d:\d\d:\d\d +builder +T1 +still working; quiet for/.test(l));
        assert.ok(beats.length >= 30, `heartbeat rows: ${beats.length}`);
      });
  },
});

scenario({
  id: "S-SCN-14", covers: covers("S-SCN-14"), modes: ["next"], fixture: "F-ONE",
  async run({ rafi, step, computer }) {
    computer.script.rules.push(on("builder T1#1", B.toolShapes()));
    let rows: string[] = [];
    await step("rafi start . --steps 1", async () => {
      const r = await rafi("start . --steps 1");
      assert.equal(r.code, 0, r.output);
      rows = r.out.split("\n").filter((l) => /^\d\d:\d\d:\d\d +builder/.test(l));
    });
    await step("six harmless failed reads fold into at most one quiet line; the real failure still shows", () => {
      assert.equal(rows.filter((l) => /Read .*missing-/.test(l)).length, 0);
      assert.equal(rows.filter((l) => /exploratory reads? didn't find a file/.test(l)).length, 1);
      assert.match(rows.find((l) => / false /.test(l)) ?? "", /: failed, duration unknown — Exit code 1/);
    });
    await step("error, timeout, cancellation and unknown have distinct labels; each names tool and call id", () => {
      assert.match(rows.find((l) => /sleep 999/.test(l)) ?? "", /: timed out/);
      assert.match(rows.find((l) => /npm run long/.test(l)) ?? "", /: cancelled/);
      assert.match(rows.find((l) => /never-returns/.test(l)) ?? "", /: outcome unknown/);
      for (const l of rows.filter((x) => /^.*Bash /.test(x))) assert.match(l, /Bash .*\(call toolu_\d+\)/);
    });
    await step("the duplicated result shows once; TIME_ELAPSED shows as an unknown duration", () => {
      assert.equal(rows.filter((l) => /echo dup/.test(l)).length, 1);
      const elapsed = rows.find((l) => /sleep 1 /.test(l)) ?? "";
      assert.match(elapsed, /duration unknown/);
      assert.doesNotMatch(elapsed, /\d+ ms/);
    });
  },
});
