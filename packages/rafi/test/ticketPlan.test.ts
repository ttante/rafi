import test from "node:test";
import assert from "node:assert/strict";
import { buildTicketPlanInstruction } from "../src/ticketPlan.js";

test("guided ticket plan instruction is read-only, conversational, and exact-apply ready", () => {
  const instruction = buildTicketPlanInstruction({
    brief: "Plan a new export feature",
    sourceChoice: "Use the requirements and repo",
    sources: [{ type: "url", url: "https://example.com/requirements" }],
    sourceSnapshots: [".tickets/imports/url.md"],
    context: { tickets: [], states: [], futureWork: [], existingNext: [] },
    grill: "exhaustive",
    docsRoot: "docs",
  });
  assert.match(instruction, /read-only guided ticket planner/);
  assert.match(instruction, /grill-me skill exhaustively/);
  assert.match(instruction, /recommended answer first/);
  assert.match(instruction, /SOURCE_REQUEST/);
  assert.match(instruction, /source_reconciliation/);
  assert.match(instruction, /replace_existing/);
  assert.match(instruction, /RAFI_PROPOSAL_START/);
  assert.match(instruction, /proposal_ready/);
});
