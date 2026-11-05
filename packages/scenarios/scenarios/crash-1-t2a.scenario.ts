// Crash enumeration (SCN 7.7): full tier only (SCN 7.10, plan 10.12).
// S-CRASH-1 (SCN 3.7), shard t2a (C160): T2, every other point (the even ones). Each point is a snapshot of the
// clean run (P33), resumed until the build finishes; checkCrashRun and the files check hold at every one.
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
      const report = await enumerateCrashes({ fixture: fChain3, line: "start . --steps 3",
        script: () => [on("qa T2#1 @review", B.reject({ 1: "not yet" })), on("builder T3#1 @build", B.malformed(300))],
        points: lever("T2", (inside, n) => inside && n % 2 === 0)
      });
      assert.ok(report.forked.length + report.literal.length >= 3, report.clean.join("\n"));
      assert.deepEqual(report.problems, [], `${report.forked.length} forked, ${report.literal.length} literal`);
    });
  },
});
