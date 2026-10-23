import { test } from "node:test";
import assert from "node:assert/strict";
import { candidate, assessment, digest } from "./qaPreparationFixtures.js";
import { allocateStableCheckIds, assembleContract, bindUniqueBaselineCheckIds, contractDigest, draftDigest, ensureHostScopeCheck, parsePreparationArtifact, renderVerificationContract, rewriteProviderHostScopeChecks, validateAssessment, validateCandidate, verifyContractDigest } from "../src/qaVerificationContract.js";
import { validateDepthDecision, depthObligations, resolveQaPreparationConfig } from "../src/qaPreparationPolicy.js";
import { normalizeAssessmentMetadata } from "../src/qaPreparation.js";

test("stable check IDs update exact provider-prose references without changing approved text or partial matches", () => {
  const draft = candidate(); draft.checks[0]!.id = "check-original"; draft.coverage[0]!.checkIds = ["check-original"];
  draft.checks[0]!.expectedEvidence = ["See check-original; not check-original-extra"];
  draft.preparationEvidence[0]!.analysis = "Evidence for check-original";
  draft.unresolved.push({ reason: "Related to check-original", requirementIds: ["req"], checkIds: ["check-original"], material: false, owner: "qa", nextAction: "Inspect check-original" });
  const originalRequirements = structuredClone(draft.requirements); const allocated = allocateStableCheckIds(draft), id = allocated.checks[0]!.id;
  assert.notEqual(id, "check-original"); assert.equal(allocated.coverage[0]!.checkIds[0], id);
  assert.equal(allocated.checks[0]!.expectedEvidence[0], `See ${id}; not check-original-extra`);
  assert.equal(allocated.preparationEvidence[0]!.analysis, `Evidence for ${id}`);
  assert.equal(allocated.unresolved[0]!.nextAction, `Inspect ${id}`);
  assert.deepEqual(allocated.requirements, originalRequirements);
});

test("preparation parser accepts repeated identical artifacts but rejects conflicting ones", () => {
  const one = "RAFI_QA_CANDIDATE_START\n{\"checks\":[]}\nRAFI_QA_CANDIDATE_END";
  assert.deepEqual(parsePreparationArtifact(one + "\n" + one, "RAFI_QA_CANDIDATE"), { checks: [] });
  assert.throws(() => parsePreparationArtifact(one + "\nRAFI_QA_CANDIDATE_START\n{\"checks\":[1]}\nRAFI_QA_CANDIDATE_END", "RAFI_QA_CANDIDATE"), /unambiguous/);
  assert.deepEqual(parsePreparationArtifact("The text RAFI_QA_CANDIDATE_START is only a label.\n" + one, "RAFI_QA_CANDIDATE"), { checks: [] });
  assert.throws(() => parsePreparationArtifact("RAFI_QA_CANDIDATE_START\n{\"checks\":[]}", "RAFI_QA_CANDIDATE"), /Expected exactly one/);
});

test("stable check ID allocation is idempotent for host IDs copied into baseline references", () => {
  const allocated = allocateStableCheckIds(candidate());
  const replay = candidate();
  replay.baseline = [{
    id: "baseline-check",
    checkId: allocated.checks[0]!.id,
    sourceDigest: digest,
    phase: "preimplementation-investigation",
    runtime: "node20",
    procedure: "Inspect the existing token test",
    observedAt: "2026-10-09T00:00:00Z",
    status: "passed",
    evidenceDigest: digest,
    relevance: "Existing behavior baseline",
    expectedTransition: "The postimplementation check remains passing",
  }];
  const normalized = allocateStableCheckIds(replay);
  assert.equal(normalized.baseline[0]!.checkId, normalized.checks[0]!.id);
});

test("baseline check IDs are repaired only from a unique explicit prerequisite", () => {
  const draft = candidate();
  draft.checks[0]!.prerequisiteRefs = ["baseline-node"];
  draft.baseline = [{ id: "baseline-node", checkId: "", sourceDigest: digest, phase: "preimplementation-investigation", runtime: "node20", procedure: "Check node", observedAt: "2026-10-09T00:00:00Z", status: "passed", evidenceDigest: digest, relevance: "Runtime prerequisite", expectedTransition: "Remains available" }];
  const normalized = bindUniqueBaselineCheckIds(allocateStableCheckIds(draft));
  assert.equal(normalized.baseline[0]!.checkId, normalized.checks[0]!.id);

  const ambiguous = structuredClone(draft);
  ambiguous.checks.push({ ...ambiguous.checks[0]!, id: "second-check" });
  assert.equal(bindUniqueBaselineCheckIds(allocateStableCheckIds(ambiguous)).baseline[0]!.checkId, "");
});

test("stale allocated baseline check IDs are repaired from a unique prerequisite", () => {
  const draft = candidate();
  draft.checks[0]!.prerequisiteRefs = ["baseline-node"];
  draft.baseline = [{ id: "baseline-node", checkId: "check-from-an-earlier-draft-0", sourceDigest: digest, phase: "preimplementation-investigation", runtime: "node20", procedure: "Check node", observedAt: "2026-10-09T00:00:00Z", status: "passed", evidenceDigest: digest, relevance: "Runtime prerequisite", expectedTransition: "Remains available" }];
  const normalized = bindUniqueBaselineCheckIds(draft);
  assert.equal(normalized.baseline[0]!.checkId, normalized.checks[0]!.id);
});

test("host scope bookkeeping is collapsed without losing requirement coverage", () => {
  const draft = candidate();
  draft.checks[0]!.expectedBehavior = "List every changed file and compare unchanged files with the baseline";
  draft.checks[0]!.expectedEvidence = ["Complete changed path inventory"];
  draft.checks.push({ ...draft.checks[0]!, id: "scope-check", expectedBehavior: "List every changed-path file and compare unchanged files with the baseline", expectedEvidence: ["Complete changed-path list"], requirementRefs: ["req"] });
  draft.coverage[0]!.checkIds = ["check", "scope-check"];
  const normalized = rewriteProviderHostScopeChecks(bindUniqueBaselineCheckIds(allocateStableCheckIds(draft)), "host-preimplementation-source");
  assert.equal(normalized.checks.length, 1);
  assert.deepEqual(normalized.checks[0]!.requirementRefs, ["req"]);
  assert.deepEqual(normalized.coverage[0]!.checkIds, [normalized.checks[0]!.id]);
  assert.equal(normalized.checks[0]!.applicability.decisionOwner, "host");
  assert.equal(normalized.checks[0]!.prerequisiteRefs.includes("host-preimplementation-source"), true);
  assert.match(normalized.checks[0]!.expectedBehavior, /Rafi compares/);
});

test("ordinary product scope checks are not rewritten as host bookkeeping", () => {
  const draft = candidate();
  draft.checks[0]!.expectedBehavior = "The public token export remains within the approved product scope";
  draft.checks[0]!.expectedEvidence = ["Inspect the exported API and its focused regression test"];
  const normalized = rewriteProviderHostScopeChecks(bindUniqueBaselineCheckIds(allocateStableCheckIds(draft)), "host-preimplementation-source");
  assert.equal(normalized.checks[0]!.applicability.decisionOwner, "qa");
  assert.equal(normalized.checks[0]!.expectedBehavior, draft.checks[0]!.expectedBehavior);
});

test("missing host scope invariant is structurally bound to an authoritative requirement", () => {
  const draft = candidate();
  const normalized = ensureHostScopeCheck(draft, "host-preimplementation-source");
  const scope = normalized.checks.find(check => check.id === "host-scope");
  assert.ok(scope);
  assert.deepEqual(scope.requirementRefs, [normalized.requirements[0]!.id]);
  assert.deepEqual(validateCandidate(normalized, normalized.requirements).filter(issue => issue.includes("host-scope") || issue.includes("requirementRefs")), []);
});

test("assessment removes only non-authoritative provider timestamps and names other unexpected properties", () => {
  const draft = candidate(), review = assessment(draft);
  const withMetadata = { ...review, createdAt: "2026-01-01T00:00:00Z" };
  assert.deepEqual(normalizeAssessmentMetadata(withMetadata), review);
  const extra = { ...withMetadata, inventedAuthority: true };
  assert.ok(validateAssessment(draft, normalizeAssessmentMetadata(extra), "author").some(issue => issue.includes("inventedAuthority")));
});

test("material preparation blockers include their reason and next action", () => {
  const draft = candidate();
  draft.unresolved.push({ reason: "The approved plan and ticket disagree on documentation scope", requirementIds: ["req"], checkIds: ["check"], material: true, owner: "host", nextAction: "Ask which scope is approved" });
  assert.ok(validateCandidate(draft, draft.requirements).some(issue => issue.includes("plan and ticket disagree") && issue.includes("Ask which scope is approved")));
});

test("documentation policy is opt-in, explicit, and delivered with the contract", () => {
  const disabled = candidate();
  assert.deepEqual(disabled.documentation, undefined);
  assert.deepEqual(validateCandidate(disabled, disabled.requirements), []);
  const enabled = candidate();
  enabled.documentation = { required: true, targets: ["README.md"], criteria: ["Document the public token-expiry behavior"] };
  const contract = assembleContract(enabled, enabled.requirements, assessment(enabled), "author");
  assert.equal(contract.documentation?.required, true);
  assert.match(renderVerificationContract(contract), /Documentation required: yes/);
  const incomplete = candidate(); incomplete.documentation = { required: true, targets: [], criteria: [] };
  assert.match(validateCandidate(incomplete, incomplete.requirements).join(";"), /Documentation policy requires explicit targets and criteria/);
});

test("V2 verification intent has its own digest without changing statement identity", () => {
  const draft = candidate();
  const intent = {
    id: "run-unit", summary: "Run the unit suite", timing: "postimplementation" as const,
    applicability: { kind: "always" as const },
    methods: [{ kind: "command" as const, argv: ["pnpm", "test"], cwd: ".", runtime: "node", timeout_ms: 60_000, expected_outcome: "passes" }],
    expected_evidence: ["test output"], depends_on: [],
  };
  draft.requirements[0] = {
    ...draft.requirements[0]!,
    statement: intent.summary,
    digest: contractDigest("statement", intent.summary),
    verificationIntent: intent,
    verificationIntentDigest: contractDigest("verification-intent-v2", intent),
  };
  assert.deepEqual(validateCandidate(draft, draft.requirements), []);
  draft.requirements[0]!.verificationIntentDigest = contractDigest("verification-intent-v2", { ...intent, summary: "different" });
  assert.match(validateCandidate(draft, draft.requirements).join(";"), /Invalid V2 verification intent/);
});

test("independent assessment blockers include their reason and next action", () => {
  const draft = candidate(), review = assessment(draft);
  review.concerns.push({ reason: "The proposed verification misses the boundary case", requirementIds: ["req"], checkIds: ["check"], material: true, owner: "host", nextAction: "Add a boundary check" });
  assert.ok(validateAssessment(draft, review, "author").some(issue => issue.includes("misses the boundary") && issue.includes("Add a boundary check")));
});

test("invalid coverage identifies the missing check-to-requirement link", () => {
  const draft = candidate(); draft.checks[0]!.requirementRefs = ["different"];
  assert.ok(validateCandidate(draft, draft.requirements).some(issue => issue.includes("Invalid coverage req/check") && issue.includes("requirementRefs must include req")));
});

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
  assert.equal(resolveQaPreparationConfig(true).mode, "enforce");
  assert.equal(resolveQaPreparationConfig(true, true).mode, "shadow");
  assert.equal(resolveQaPreparationConfig(false).mode, "legacy");
  assert.throws(() => resolveQaPreparationConfig(false, true), /requires qa_preparation/);
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
