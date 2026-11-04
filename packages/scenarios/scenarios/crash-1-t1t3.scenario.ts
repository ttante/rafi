// S-CRASH-1 (SCN 3.7), shard t1t3 (C160): T1's first and last step boundary, T3's step boundaries, and a literal
// sample of 3 points in T2. Each point is a snapshot of the clean run
// (P33), resumed until the build finishes; checkCrashRun and the files check hold at every one.
import assert from "node:assert/strict";
import { registry } from "../checks/registry.js";
import { enumerateCrashes, lever } from "../checks/crash.js";
import { B, on } from "../fakes/script/behaviors.js";
import { fChain3 } from "../fixtures/f-chain3.js";
import { scenario } from "../harness/scenario.js";

scenario({
  id: "S-CRASH-1", covers: registry.find((r) => r.id === "S-CRASH-1")!.covers, modes: ["next"], fixture: "none",
  async run({ step }) {
    await step("crash at each point, then resume until done: every invariant holds", async () => {
      const others = lever("T2", (inside) => !inside);
      const report = await enumerateCrashes({ fixture: fChain3, line: "start . --steps 3",
        script: () => [on("qa T2#1 @review", B.reject({ 1: "not yet" })), on("builder T3#1 @build", B.malformed(300))],
        // Section 6 lever (c): T1 at its first and last step boundary only; T3 at every step boundary.
        points: (occurrence) => others(occurrence) &&
          (!occurrence.includes("(T1") || /\(T1, (1st|5th)\)/.test(occurrence)),
        literal: ["1: intent, before sending (T2", "3: reply arrived, before it's recorded (T2",
          "5: during the progress-file write (7th"],
      });
      assert.ok(report.forked.length + report.literal.length >= 3, report.clean.join("\n"));
      assert.deepEqual(report.problems, [], `${report.forked.length} forked, ${report.literal.length} literal`);
    });
  },
});
