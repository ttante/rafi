// Crash enumeration (SCN 7.7): full tier only (SCN 7.10, plan 10.12).
// S-CRASH-1's git boundaries (M5 plan item 19; ARCH 14.1 `:1687`, P45; C227, C160, C323), shard b: M5's other
// delivery boundaries. F-BRANCH trimmed to U1 with `direct-merge` (the merge into main and main's push) and with
// `auto-merge` (the PR's auto-merge, then its wait polled on the clock until the fake merges it: every safe point of
// the wait). The CI point is shard c.
// Each point a P33 fork resumed until done; checkCrashRun, the files check and the git checks hold at every one.
import path from "node:path";
import { registry } from "../checks/registry.js";
import { holds } from "../checks/crash.js";
import { BRANCH_TICKETS, fBranch } from "../fixtures/f-branch.js";
import type { Computer } from "../harness/deps.js";
import { scenario } from "../harness/scenario.js";

const U1 = { tickets: BRANCH_TICKETS.slice(0, 2), units: [{ id: "U1", tickets: ["T1", "T2"],
  branch_mode: "per-ticket" }] };

/** A merge wait's polls move the clock to them (polls never fire on their own, SCN 7.4); the fake merges an
 * auto-merge PR on its second view. */
function polled(computer: Computer): void {
  computer.gh.mergeAfterViews = 2;
  const next = () => computer.clock.whenTimer("poll", () => {
    next();
    setImmediate(() => computer.clock.advance(60_000));
  });
  next();
}

scenario({
  id: "S-CRASH-1", covers: registry.find((r) => r.id === "S-CRASH-1")!.covers, modes: ["next"], fixture: "none",
  async run({ step }) {
    await step("direct-merge (U1): every point of the unit's merge and main's push", async () => {
      await holds("direct-merge", { fixture: (root) => fBranch(path.join(root, "f"), U1), script: () => [],
        line: "start . --steps 2 --completion direct-merge", points: (o) => /^6: .*\(U1 /.test(o) }, 4);
    });
    await step("auto-merge (U1): every point of the PRs' auto-merge and of the merge wait's safe points", async () => {
      let waiting = false;
      await holds("auto-merge", { fixture: (root) => fBranch(path.join(root, "f"), U1), script: () => [],
        line: "start . --steps 2 --completion auto-merge", setup: polled,
        points: (o) => {
          if (/^6: after auto-merge \(U1 feature\/T2/.test(o)) waiting = true;
          return /^6: (before|after) auto-merge/.test(o) || (waiting && /^[45]:/.test(o));
        } }, 4);
    });
  },
});
