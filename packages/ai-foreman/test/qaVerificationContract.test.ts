import { test } from "node:test";
import assert from "node:assert/strict";
import { candidate, assessment } from "./qaPreparationFixtures.js";
import { assembleContract, contractDigest, draftDigest, validateCandidate, verifyContractDigest } from "../src/qaVerificationContract.js";
import { validateDepthDecision, depthObligations, resolveQaPreparationConfig } from "../src/qaPreparationPolicy.js";

test("canonical content and draft digests are non-circular, order-stable and sensitive to meaning", () => {
  const draft = candidate(); const review = assessment(draft);
  const contract = assembleContract(draft, draft.requirements, review, "author"); verifyContractDigest(contract);
  assert.equal(draftDigest(contract), draftDigest(draft));
  assert.equal(contractDigest("x", { b: 1, a: 2 }), contractDigest("x", { a: 2, b: 1 }));
  draft.checks[0]!.expectedBehavior = "Accept expired tokens";
  assert.throws(() => assembleContract(draft, draft.requirements, review, "author"), /exact draft/);
  const corrupt = { ...contract, revision: 2 }; assert.throws(() => verifyContractDigest(corrupt), /Corrupt/);
});
test("every level retains complete inventory and enforces distinct investigation obligations", () => {
  for (const level of [1, 2, 3, 4, 5] as const) {
    const draft = candidate(level); assert.deepEqual(validateCandidate(draft, draft.requirements), []);
    draft.coverage = []; assert.match(validateCandidate(draft, draft.requirements).join(), /coverage/);
    const missing = candidate(level); missing.preparationEvidence = []; assert.match(validateCandidate(missing, missing.requirements).join(), /evidence|minItems|fewer/);
  }
  assert.equal(new Set([1, 2, 3, 4, 5].map(level => depthObligations(level as 1 | 2 | 3 | 4 | 5).length)).size, 5);
});
test("dependency cycles, advisory substitution, unsupported dispositions and proposed blockers reject readiness", () => {
  for (const mutate of [
    (draft: ReturnType<typeof candidate>) => { draft.checks[0]!.dependsOnChecks = ["check"]; },
    (draft: ReturnType<typeof candidate>) => { draft.checks[0]!.obligation = "advisory"; },
    (draft: ReturnType<typeof candidate>) => { draft.checks[0]!.dispositionRef = "agent says waived"; },
    (draft: ReturnType<typeof candidate>) => { draft.requirements[0]!.authority = "proposed"; },
  ]) { const draft = candidate(); mutate(draft); assert.ok(validateCandidate(draft, draft.requirements).length); }
});
test("Exceptional requires fresh independent challenge with separate resolved approach conclusions", () => {
  const draft = candidate(5), review = assessment(draft);
  assert.throws(() => assembleContract(draft, draft.requirements, review, "author"), /challenge/);
  const challenge = { ...review, sessionId: "challenger", approach: "Change expiry validation and add regression", concernCategories: ["scope", "invariants", "failure-boundaries", "verification"], approachConcerns: [] };
  assert.ok(assembleContract(draft, draft.requirements, review, "author", challenge).challengeReceiptDigest);
  challenge.sessionId = "author"; assert.throws(() => assembleContract(draft, draft.requirements, review, "author", challenge), /independent/);
});
test("risk minimums, low-risk evidence and policy defaults never depend on size, cost or provider failure", () => {
  assert.equal(resolveQaPreparationConfig(undefined).mode, "legacy");
  assert.throws(() => resolveQaPreparationConfig({ mode: "automatic" }));
  assert.throws(() => resolveQaPreparationConfig({ mode: "enforce", wallTimeMs: [1, 2, 3, 4, 5] }));
  const selection = candidate().depthDecision; selection.riskFactors = [{ category: "migration", rationale: "Persisted records change format", references: ["schema.ts:migrate"] }];
  assert.match(validateDepthDecision(selection).join(), /minimum/);
  const focused = candidate(1).depthDecision; delete focused.lowRisk; assert.match(validateDepthDecision(focused).join(), /Focused/);
  const prior = candidate(4).depthDecision, next = candidate(2).depthDecision; next.predecessorDecisionId = prior.decisionId; next.rationale = "Budget exhausted"; assert.match(validateDepthDecision(next, prior).join(), /downgrade/);
});

test("start-time readiness is distinct from a defect or final capability that implementation must resolve", () => {
  const draft = candidate(); draft.checks[0]!.timing = "preimplementation";
  assert.match(validateCandidate(draft, draft.requirements).join(), /readiness incomplete/);
  draft.baseline = [{ id: "environment", checkId: "check", applicability: "applicable", predicateEvidence: [], sourceDigest: draft.admissionDigest, phase: "preimplementation-investigation", runtime: "node20", procedure: "Inspect runtime access", observedAt: draft.createdAt, status: "blocked", evidenceDigest: draft.admissionDigest, relevance: "Required to investigate the expiry invariant", expectedTransition: "Restore capability before implementation" }];
  assert.match(validateCandidate(draft, draft.requirements).join(), /readiness incomplete/);
  draft.baseline[0]!.status = "failed";
  assert.match(validateCandidate(draft, draft.requirements).join(), /readiness incomplete/);
  draft.checks[0]!.timing = "postimplementation";
  assert.deepEqual(validateCandidate(draft, draft.requirements), [], "A failing existing regression is retained and expected to change through implementation");
  draft.checks[0]!.timing = "both";
  assert.match(validateCandidate(draft, draft.requirements).join(), /readiness incomplete/);
  draft.baseline[0]!.status = "passed";
  assert.deepEqual(validateCandidate(draft, draft.requirements), []);
});
