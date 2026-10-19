import { test } from "node:test";
import assert from "node:assert/strict";
import {
  builderHandoffRequestV1Schema,
  continuityDeltaV1Schema,
  documentationPolicyV1ZodSchema,
  discoveryEnvelopeV1Schema,
  grillAuditVerdictV1Schema,
  parseProviderContract,
  providerQuestionV1Schema,
  qaPreparationEscalationProposalV1Schema,
  riskNoteRepairProposalV1Schema,
  semanticResultV1Schema,
  structuredSourceRequestSchema,
  ticketPopulationProposalV1Schema,
} from "../src/providerContracts.js";

const delta = {
  version: 1 as const,
  decisions: ["Use the host snapshot"],
  constraints: [],
  discoveries: ["The provider cannot author durable paths"],
  completedActions: [],
  evidence: ["test output"],
  failures: [],
  blockers: [],
  openWork: ["Run independent QA"],
  nextAction: "Run the project tests",
};

test("new provider contracts accept their minimal valid shapes", () => {
  assert.equal(documentationPolicyV1ZodSchema.safeParse({ required: false, targets: [], criteria: [] }).success, true);
  assert.equal(documentationPolicyV1ZodSchema.safeParse({ required: true, targets: ["README.md"], criteria: ["Document the public API"] }).success, true);
  assert.equal(documentationPolicyV1ZodSchema.safeParse({ required: true, targets: ["../README.md"], criteria: [] }).success, false);
  assert.equal(continuityDeltaV1Schema.safeParse(delta).success, true);
  assert.equal(builderHandoffRequestV1Schema.safeParse({
    version: 1,
    reason: "Context limit",
    decisions: [], constraints: [], discoveries: [], completed_actions: [], evidence: [],
    failures: [], blockers: [], open_work: [], next_action: "Continue",
    role_state: { role: "builder" },
  }).success, true);
  assert.equal(discoveryEnvelopeV1Schema.safeParse({ version: 1, detected_stack: { backend: "node" } }).success, true);
  assert.equal(semanticResultV1Schema.safeParse({
    kind: "rafi_graph_semantic_result", version: 1, operationId: "op-1", inputDigest: "a".repeat(64),
    nodes: [{ id: "n1", source_file: "src/index.ts" }], edges: [],
    origin: { provider: "host", operationId: "op-1" },
  }).success, true);
  assert.equal(grillAuditVerdictV1Schema.safeParse({ status: "complete", evidence: "This is sufficiently detailed evidence." }).success, true);
  assert.equal(providerQuestionV1Schema.safeParse({ question: "Choose", options: [{ label: "A" }] }).success, true);
  assert.equal(qaPreparationEscalationProposalV1Schema.safeParse({
    rationale: "The change crosses a recovery boundary.",
    riskFactors: [{ category: "recovery", rationale: "A failed retry may need repair.", references: ["ticket-1"] }],
  }).success, true);
  assert.equal(riskNoteRepairProposalV1Schema.safeParse({ version: 1, tickets: [{ id: "T1", rollback: "Restore the previous config." }] }).success, true);
  assert.equal(structuredSourceRequestSchema.safeParse({ type: "local", locator: { path: "docs/brief.md" } }).success, true);
  assert.equal(ticketPopulationProposalV1Schema.safeParse({
    version: 1, plan_id: "PLAN1", revision: 1, retirements: [], tickets: [{ order: 1000,
      slice_ref: "S1", title: "Implement", area: "core", priority: "P1", size: "M", risk: "Medium",
      summary: "Implement the behavior", acceptance: ["It works"], required_tests: ["unit test"],
      likely_files: ["src/index.ts"], depends_on: [], rollback: "Restore the prior implementation.",
    }],
  }).success, true);
});

test("strict contracts reject provider-added fields instead of silently accepting them", () => {
  const extra = { ...delta, provider_claimed_generation: 9 };
  const result = continuityDeltaV1Schema.safeParse(extra);
  assert.equal(result.success, false);
  assert.throws(() => parseProviderContract(continuityDeltaV1Schema, extra, "continuity delta"), /provider_claimed_generation/);

  const question = providerQuestionV1Schema.safeParse({ question: "Choose", options: [], host_owned: true });
  assert.equal(question.success, false);
});

test("bounded contracts reject oversized content and malformed identity fields", () => {
  assert.equal(continuityDeltaV1Schema.safeParse({ ...delta, decisions: ["x".repeat(4_001)] }).success, false);
  assert.equal(providerQuestionV1Schema.safeParse({ question: "Choose", options: Array.from({ length: 201 }, () => ({ label: "A" })) }).success, false);
  assert.equal(discoveryEnvelopeV1Schema.safeParse({ version: 2 }).success, false);
  assert.equal(semanticResultV1Schema.safeParse({
    kind: "rafi_graph_semantic_result", version: 1, operationId: "op", inputDigest: "not-a-digest",
    nodes: [], edges: [], origin: { provider: "host", operationId: "op" },
  }).success, false);
  assert.equal(grillAuditVerdictV1Schema.safeParse({ status: "complete", evidence: "too short" }).success, false);
  assert.equal(qaPreparationEscalationProposalV1Schema.safeParse({ rationale: "x", riskFactors: [] }).success, false);
});

test("discriminated grill verdicts reject incomplete or mixed envelopes", () => {
  assert.equal(grillAuditVerdictV1Schema.safeParse({ status: "needs_user_input", questions: [] }).success, false);
  assert.equal(grillAuditVerdictV1Schema.safeParse({ status: "complete", evidence: "This evidence is complete.", questions: [] }).success, false);
  assert.equal(grillAuditVerdictV1Schema.safeParse({ status: "unknown", evidence: "This evidence is complete." }).success, false);
});
