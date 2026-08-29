import test from "node:test";
import assert from "node:assert/strict";
import { applyTicketPlanWorkModeDefault, buildTicketPlanInstruction } from "../src/ticketPlan.js";
import type { TicketPlanProposal } from "ai-foreman/ticket-planning.js";

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
  assert.match(instruction, /native AskUserQuestion-style question tool/);
  assert.match(instruction, /SOURCE_REQUEST/);
  assert.match(instruction, /source_reconciliation/);
  assert.match(instruction, /replace_existing/);
  assert.match(instruction, /RAFI_PROPOSAL_START/);
  assert.match(instruction, /proposal_ready/);
});

test("ticket plan work mode is host-owned and overrides contradictory planner output", () => {
  const proposal: TicketPlanProposal = {
    version: 1,
    title: "Plan",
    markdown: "# Plan",
    additions: [],
    edits: [],
    supersessions: [],
    state_changes: [],
    source_reconciliation: [],
    future_work: [],
    next: { ticket_ids: [], replace_existing: false },
  };

  const filled = applyTicketPlanWorkModeDefault(proposal, "current");
  assert.equal(filled.build_defaults?.branch_strategy, "current");

  const explicit = applyTicketPlanWorkModeDefault({
    ...proposal,
    build_defaults: { branch_strategy: "batch" },
  }, "current");
  assert.equal(explicit.build_defaults?.branch_strategy, "current");
});
