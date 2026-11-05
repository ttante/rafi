// Crash enumeration (SCN 7.7): full tier only (SCN 7.10, plan 10.12).
// S-CRASH-1's git boundaries (M5 plan item 19; ARCH 14.1 `:1687`; C323), shard c: a CI point (ARCH 6.10) on F-TESTS
// whose suite fails once T2's work is in. Points: after the suite run and after its last rerun, after the fix
// ticket's commit and its check (the CI point's run again), the unit's merge into main and main's push; plus the
// suite run's start as a literal crashAt. Each resumed until done; checkCrashRun, the files check and the git
// checks hold at every one, so a crash never adds a second fix ticket, commit or merge.
import path from "node:path";
import { holds } from "../checks/crash.js";
import { registry } from "../checks/registry.js";
import { fTests } from "../fixtures/f-tests.js";
import type { Computer } from "../harness/deps.js";
import { scenario } from "../harness/scenario.js";

/** C272's fixture: suite/x.test fails once T2's work is in, until the fix ticket's file is. */
function failingSuite(computer: Computer): void {
  computer.checks.tests["suite/x.test"] = { outcomes: ["pass"], failWhen: { file: "src/T2.txt", contains: "T2 done",
    unless: "src/FIX-1.txt" } };
}

/** The CI point's boundaries from its suite run on, each kind once (speed): after the suite run and after its last
 * rerun (the outcome not recorded yet), after the fix ticket's commit and its check, then the unit's merge and
 * main's push. The suite run's start is the literal point. */
function ciPoints(): { points: (o: string) => boolean; pick: (all: readonly string[]) => string[] } {
  let ci = false;
  const rerun = /^10: after test run 1 \(FIX-1, /;
  return {
    points: (o) => {
      if (/^10: before test run \d+ \(FIX-1/.test(o)) ci = true;
      return ci && /^(10|6): /.test(o) && !/^(10|6): before (test run|commit|push)/.test(o);
    },
    pick: (all) => {
      const runs = all.filter((o) => rerun.test(o));
      return all.filter((o) => !rerun.test(o) || o === runs[0] || o === runs.at(-1));
    },
  };
}

scenario({
  id: "S-CRASH-1", covers: registry.find((r) => r.id === "S-CRASH-1")!.covers, modes: ["next"], fixture: "none",
  async run({ step }) {
    await step("a failing CI point (F-TESTS): the suite run, the fix ticket's commit, the merge and main's push",
      async () => {
        await holds("ci", { fixture: (root) => fTests(path.join(root, "f"), { qa: false }), script: () => [],
          line: "start . --steps 3", setup: failingSuite, ...ciPoints(),
          literal: ["10: before test run 1 (FIX-1"] }, 7);
      });
  },
});
