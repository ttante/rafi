import test from "node:test";
import assert from "node:assert/strict";
import type { StructuredPlanV1 } from "rafi-spec";
import { assertRiskPlanOnlyCorrection, authorizeTicketRetirements, extractTicketPopulationProposal, materializeTicketPopulation, TicketPopulationValidationError, validateTicketPopulationProposal, type TicketPopulationProposalV1 } from "../src/ticketPopulation.js";
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

test("explicit current setup owns delivery mode over provider plan output", () => {
  const providerPlan = structuredClone(plan);
  providerPlan.delivery_units[0]!.branch_mode = "per-ticket";
  providerPlan.delivery_units[0]!.completion = "pr";
  providerPlan.delivery_units[0]!.provider = "github";
  const result = materializeTicketPopulation(proposal, providerPlan, [old], { branchStrategy: "current" });
  assert.equal(result.delivery.units[0]!.branch_mode, "current");
  assert.equal(result.delivery.units[0]!.completion, "none");
  assert.equal(result.delivery.units[0]!.provider, "local");
  assert.deepEqual(result.delivery.stacks, []);
});

test("population rejects missing/duplicate mappings and requires exact computer-run retirement IDs", () => {
  const invalid = { ...proposal, tickets: [proposal.tickets[0]!, proposal.tickets[0]!] };
  assert.match(validateTicketPopulationProposal(invalid, plan, [old]).join(";"), /duplicate slice mapping|missing ticket mapping/);
  assert.throws(() => authorizeTicketRetirements(["T010", "T011"], { computerRun: true, authorizedIds: ["T010"] }), /exact authorized ticket IDs/);
  assert.doesNotThrow(() => authorizeTicketRetirements(["T010", "T011"], { computerRun: true, authorizedIds: ["T011", "T010"] }));
});

test("population rejects provider-invented sibling-absence requirements", () => {
  const invalid = structuredClone(proposal);
  invalid.tickets[1]!.acceptance = [
    "npm test passes with this slice alone, without subtract present",
  ];

  assert.throws(
    () => materializeTicketPopulation(invalid, plan, [old], { branchStrategy: "current" }),
    /adds a sibling-absence requirement/,
  );
});

test("population preserves explicitly approved absence requirements", () => {
  const approved = structuredClone(plan);
  const requirement = "verify the feature is absent before enabling the migration";
  approved.slices[1]!.required_tests = [requirement];

  const generated = structuredClone(proposal);
  generated.tickets[1]!.required_tests = [requirement];

  assert.doesNotThrow(() =>
    materializeTicketPopulation(generated, approved, [old], { branchStrategy: "current" }),
  );
});

test("population does not apply additive-absence validation to per-ticket branches", () => {
  const invalid = structuredClone(proposal);
  invalid.tickets[1]!.acceptance = ["this slice alone passes"];

  assert.doesNotThrow(() =>
    materializeTicketPopulation(invalid, plan, [old], { branchStrategy: "branch-per-ticket" }),
  );
});

test("ticket-maker proposal parsing errors remain distinct from plan discovery failures", () => {
  assert.throws(
    () => extractTicketPopulationProposal("Codex returned prose but no proposal envelope."),
    /ticket-maker output is missing RAFI_TICKET_POPULATION_PROPOSAL_START/,
  );
});

test("ticket population extraction rejects unknown fields before materialization", () => {
  const value = structuredClone(proposal) as unknown as Record<string, unknown>;
  (value.tickets as Array<Record<string, unknown>>)[0]!.provider_ticket_id = "T-provider";
  assert.throws(
    () => extractTicketPopulationProposal(`RAFI_TICKET_POPULATION_PROPOSAL_START\n${JSON.stringify(value)}\nRAFI_TICKET_POPULATION_PROPOSAL_END`),
    /contract validation failed.*provider_ticket_id/s,
  );
});

test("ticket-maker preserves planner depth through population and cannot override or retain stale metadata", async () => {
  const { decision } = await import("./qaPreparationFixtures.js");
  const approved = structuredClone(plan), generated = structuredClone(proposal);
  approved.slices[0]!.qa_preparation = decision(2);
  generated.tickets[0]!.qa_preparation = Object.fromEntries(Object.entries(decision(2)).reverse()) as ReturnType<typeof decision>;
  assert.deepEqual(validateTicketPopulationProposal(generated, approved, [old]), []);
  const populated = materializeTicketPopulation(generated, approved, [old]);
  assert.deepEqual(populated.tickets.find(ticket => ticket.id === "T009")!.qa_preparation, decision(2));
  populated.tickets.find(ticket => ticket.id === "T009")!.qa_preparation!.rationale = "Changed ticket";
  assert.notEqual(approved.slices[0]!.qa_preparation!.rationale, "Changed ticket");
  generated.tickets[0]!.qa_preparation = decision(1); assert.ok(validateTicketPopulationProposal(generated, approved, [old]).some(issue => issue.includes("cannot override")));
  delete generated.tickets[0]!.qa_preparation; delete approved.slices[0]!.qa_preparation;
  const stale = { ...old, qa_preparation: decision(4) };
  assert.equal(materializeTicketPopulation(generated, approved, [stale]).tickets.find(ticket => ticket.id === "T009")!.qa_preparation, undefined);
});

test("population exposes missing Medium-risk rollback as a repairable structured failure", () => {
  const risky = structuredClone(proposal);
  risky.tickets[1]!.risk = "Medium";
  risky.tickets[1]!.notes = "extra context is not a rollback";
  assert.throws(() => materializeTicketPopulation(risky, plan, [old]), (error: unknown) => {
    assert.ok(error instanceof TicketPopulationValidationError);
    assert.equal(error.onlyRepairableRiskFailures, true);
    assert.deepEqual(error.repairableRiskTicketIds, ["T001"]);
    assert.deepEqual(error.repairableRiskSliceRefs, ["slc_new"]);
    assert.match(error.message, /rollback or mitigation plan in `rollback`/);
    return true;
  });
});

test("population permits a reasoned waiver only for the exact missing risk-ticket IDs", () => {
  const risky = structuredClone(proposal);
  risky.tickets[1]!.risk = "Medium";
  const waived = materializeTicketPopulation(risky, plan, [old], {
    waiveRiskTicketIds: ["T001"], waiverReason: "Accepted for initial backlog triage", waiverActor: "tyler",
  });
  assert.deepEqual(waived.riskWaivers, [{ ticketId: "T001", reason: "Accepted for initial backlog triage", actor: "tyler" }]);
  assert.throws(() => materializeTicketPopulation(risky, plan, [old], {
    waiveRiskTicketIds: ["T999"], waiverReason: "wrong ticket",
  }), TicketPopulationValidationError);
});

test("population rejects whitespace-only rollback plans for Medium and High risk tickets", () => {
  for (const risk of ["Medium", "High"] as const) {
    const risky = structuredClone(proposal);
    risky.tickets[1]!.risk = risk;
    risky.tickets[1]!.rollback = "  \n\t ";
    assert.throws(() => materializeTicketPopulation(risky, plan, [old]), (error: unknown) => {
      assert.ok(error instanceof TicketPopulationValidationError);
      assert.equal(error.onlyRepairableRiskFailures, true);
      return true;
    });
  }
});

test("risk-plan correction cannot change scope, mappings, or unaffected tickets", () => {
  const risky = structuredClone(proposal);
  risky.tickets[1]!.risk = "Medium";
  const corrected = structuredClone(risky);
  corrected.tickets[1]!.rollback = "Disable the new path and verify error rate returns to baseline.";
  assert.doesNotThrow(() => assertRiskPlanOnlyCorrection(risky, corrected, ["slc_new"]));
  corrected.tickets[0]!.title = "Scope drift";
  assert.throws(() => assertRiskPlanOnlyCorrection(risky, corrected, ["slc_new"]), /other than rollback/);
});
