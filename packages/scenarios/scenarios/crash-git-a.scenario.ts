// Crash enumeration (SCN 7.7): full tier only (SCN 7.10, plan 10.12).
// S-CRASH-1's git boundaries (M5 plan item 19; ARCH 14.1 `:1687`, P45; C227, C160), shard a: F-BRANCH trimmed to
// its per-ticket unit U1 (T1, T2), `--steps 2 --completion pr`. A P33 fork at every boundary-6 point of T1 and at
// the first and last of T2, plus two literal crashAt points; each resumed until done. checkCrashRun, the files
// check and the git checks (one commit per ticket, one PR per branch, the clean run's branches, no other ref
// pushed, every git.intent followed by its result) hold at every one.
import assert from "node:assert/strict";
import path from "node:path";
import { registry } from "../checks/registry.js";
import { holds } from "../checks/crash.js";
import { BRANCH_TICKETS, fBranch } from "../fixtures/f-branch.js";
import { scenario } from "../harness/scenario.js";

const U1 = { tickets: BRANCH_TICKETS.slice(0, 2), units: [{ id: "U1", tickets: ["T1", "T2"],
  branch_mode: "per-ticket" }] };
const git6 = (o: string) => o.startsWith("6: ");

/** Every boundary-6 point of T1's branch, and the first and last of T2's. */
function firstAndLast(ofT2: RegExp) {
  return (all: readonly string[]) => {
    const t2 = all.filter((o) => ofT2.test(o));
    return [...all.filter((o) => !ofT2.test(o)), ...new Set([t2[0]!, t2.at(-1)!])];
  };
}

scenario({
  id: "S-CRASH-1", covers: registry.find((r) => r.id === "S-CRASH-1")!.covers, modes: ["next"], fixture: "none",
  async run({ step }) {
    await step("git boundaries (U1, completion pr): crash at each point, resume until done; every check holds",
      async () => {
        const report = await holds("U1 pr", { fixture: (root) => fBranch(path.join(root, "f"), U1),
          line: "start . --steps 2 --completion pr", script: () => [], points: git6, pick: firstAndLast(/feature\/T2-/),
          literal: ["6: after commit (T1", "6: before pr-create (U1 feature/T2"] }, 12);
        assert.equal(report.literal.length, 2, report.literal.join("\n"));
      });
  },
});
