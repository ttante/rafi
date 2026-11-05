// M5 plan C223 (Q-ADP-2, NEW-ADP-2): a reused session compacts at a ticket boundary only when the latest usage
// sample is above the threshold's share of the window; no window, no sample or no threshold means no compaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactionDue } from "../../src/turns/reuse.js";

test("compaction is due only above the threshold, from the latest sample", () => {
  assert.equal(compactionDue({ last: 900, window: 1000 }, 80), true);
  assert.equal(compactionDue({ last: 800, window: 1000 }, 80), false, "at the threshold isn't above it");
  assert.equal(compactionDue({ last: 20, window: 1000 }, 50), false, "a small latest sample, whatever the total");
  assert.equal(compactionDue({ last: 900, window: null }, 80), false, "no window (Claude): the CLI's own");
  assert.equal(compactionDue({ last: null, window: 1000 }, 80), false);
  assert.equal(compactionDue(undefined, 80), false);
  assert.equal(compactionDue({ last: 900, window: 1000 }, undefined), false, "no threshold set");
});
