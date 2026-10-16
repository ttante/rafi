import test from "node:test";
import assert from "node:assert/strict";
import { handoffSystemInstructions } from "../src/handoffProtocol.js";
import { buildPrimer } from "../src/foreman.js";

for (const role of ["builder", "qa"]) test(`${role} orchestration distinguishes host bookkeeping from product acceptance`, () => {
  const instructions = handoffSystemInstructions(role, "Preserve every product acceptance criterion")!;
  assert.match(instructions, /host owns ticket lifecycle transitions/);
  assert.match(instructions, /An unavailable ticket CLI is not an implementation blocker/);
  assert.match(instructions, /remains in_progress until this independent review passes/);
  assert.match(instructions, /does not waive product acceptance criteria, tests, source integrity/);
  assert.match(instructions, /including tickets that explicitly implement tracker functionality/);
  assert.match(instructions, /Preserve every product acceptance criterion/);
});
test("tracker primer leaves finalization with the host while a manually managed tracker keeps its original workflow", () => {
  const supervised = buildPrimer(2, "docs/ticket-progress.md", true);
  assert.match(supervised, /Foreman records completion.*after independent QA passes/);
  assert.match(supervised, /optional mid-turn notes/);
  assert.match(supervised, /not an implementation blocker/);
  assert.match(buildPrimer(2, "manual-tracker.md", false), /After completing.*update its status/);
  assert.equal(handoffSystemInstructions("planner", "existing rules"), "existing rules");
});
