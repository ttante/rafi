import test from "node:test";
import assert from "node:assert/strict";
import type { StructuredPlanV1 } from "rafi-spec";
import { authorizeTicketRetirements, materializeTicketPopulation, validateTicketPopulationProposal, type TicketPopulationProposalV1 } from "../src/ticketPopulation.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";

const old: TicketDef = {
  id: "T009", order: 9, title: "Existing slice", area: "core", priority: "P2", size: "S", risk: "Low",
  depends_on: [], summary: "old", acceptance: ["old acceptance"], required_tests: ["old test"], likely_files: [],
  plan_ref: { plan_id: "pln_a", revision: 1, slice_ref: "slc_keep" },
};
const unrelated: TicketDef = { ...old, id: "T100", order: 100, title: "Unrelated", plan_ref: undefined };
const plan: StructuredPlanV1 = {
  version: 1, plan_id: "pln_a", revision: 2, content_digest: "digest", summary: "Plan", assumptions: [], implementation_changes: [], acceptance_criteria: [], test_plan: [],
  slices: [
    { slice_ref: "slc_keep", title: "Keep", summary: "keep", acceptance: ["works"], required_tests: ["test"], likely_files: [], depends_on: [] },
    { slice_ref: "slc_new", title: "New", summary: "new", acceptance: ["works"], required_tests: ["test"], likely_files: [], depends_on: ["slc_keep"], source_refs: [{ source_id: "src_0123456789abcdef", fingerprint: "a".repeat(64), item: "REQ-1" }] },
  ],
  delivery_units: [{ id: "unit", slice_refs: ["slc_keep", "slc_new"], branch_mode: "current", completion: "none", provider: "local", pr_ready: false, merge_method: "squash", cleanup: false, depends_on: [], dependency_mode: "combine" }],
  stacks: [],
};
const proposal: TicketPopulationProposalV1 = {
  version: 1, plan_id: "pln_a", revision: 2, retirements: [], tickets: [
    { slice_ref: "slc_keep", title: "Keep revised", area: "core", priority: "P2", size: "S", risk: "Low", summary: "keep", acceptance: ["works"], required_tests: ["test"], likely_files: [], depends_on: [] },
    { slice_ref: "slc_new", title: "New", area: "core", priority: "P2", size: "S", risk: "Low", summary: "new", acceptance: ["works"], required_tests: ["test"], likely_files: [], depends_on: ["slc_keep"] },
  ],
};

test("population retains plan slice ticket IDs and preserves unrelated tickets", () => {
  assert.deepEqual(validateTicketPopulationProposal(proposal, plan, [old, unrelated]), []);
  const result = materializeTicketPopulation(proposal, plan, [old, unrelated]);
  assert.equal(result.sliceToTicket.get("slc_keep"), "T009");
  assert.equal(result.sliceToTicket.get("slc_new"), "T001");
  assert.ok(result.tickets.some((ticket) => ticket.id === "T100" && ticket.title === "Unrelated"));
  assert.deepEqual(result.tickets.find((ticket) => ticket.id === "T001")?.depends_on, ["T009"]);
  assert.deepEqual(result.tickets.find((ticket) => ticket.id === "T001")?.source_refs, [{ source: "src_0123456789abcdef", item: "REQ-1", source_id: "src_0123456789abcdef", fingerprint: "a".repeat(64) }]);
});

test("population rejects missing/duplicate mappings and requires exact computer-run retirement IDs", () => {
  const invalid = { ...proposal, tickets: [proposal.tickets[0]!, proposal.tickets[0]!] };
  assert.match(validateTicketPopulationProposal(invalid, plan, [old]).join(";"), /duplicate slice mapping|missing ticket mapping/);
  assert.throws(() => authorizeTicketRetirements(["T010", "T011"], { computerRun: true, authorizedIds: ["T010"] }), /exact authorized ticket IDs/);
  assert.doesNotThrow(() => authorizeTicketRetirements(["T010", "T011"], { computerRun: true, authorizedIds: ["T011", "T010"] }));
});
