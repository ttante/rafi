// Item 13 (M3 plan): QA preparation depth (C113, P23 (a) option i): the minimum by risk and the one raise.
// Table-driven from the one minimums map, so a different answer changes only that map and this table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEPTHS, depthFor, MINIMUMS } from "../../src/build/depth.js";

test("the minimums are P23 (a) option (i): Low standard, Medium standard, High extensive", () => {
  assert.deepEqual(MINIMUMS, { Low: "standard", Medium: "standard", High: "extensive" });
  assert.deepEqual(DEPTHS, ["focused", "standard", "extensive", "critical", "exceptional"]);
  assert.ok(Object.isFrozen(MINIMUMS) && Object.isFrozen(DEPTHS));
});

const table: readonly [string, string | undefined, string, string | null][] = [
  ["Low", undefined, "standard", null],
  ["Low", "focused", "standard", "focused"],
  ["Low", "standard", "standard", null],
  ["Low", "critical", "critical", null],
  ["Medium", "focused", "standard", "focused"],
  ["Medium", "extensive", "extensive", null],
  ["High", undefined, "extensive", "standard"],
  ["High", "focused", "extensive", "focused"],
  ["High", "standard", "extensive", "standard"],
  ["High", "extensive", "extensive", null],
  ["High", "exceptional", "exceptional", null],
];

for (const [risk, given, depth, raisedFrom] of table) {
  test(`risk ${risk}, planner depth ${given ?? "absent"} → ${depth}${raisedFrom ? ` (raised from ${raisedFrom})` : ""}`,
    () => {
      const ticket = { risk, ...(given ? { qa_preparation: { depth: given } } : {}) };
      assert.deepEqual(depthFor(ticket as never), { depth, raisedFrom });
    });
}
