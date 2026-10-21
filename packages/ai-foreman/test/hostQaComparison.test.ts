import test from "node:test";
import assert from "node:assert/strict";
import { applyHostQaComparison, hostQaComparisonV1Schema } from "../src/hostQaComparison.js";
import type { QaContractCoverageV1, QaVerificationContractV1 } from "rafi-spec";

const hash = (char: string) => char.repeat(64);

function fixture(): { contract: QaVerificationContractV1; coverage: QaContractCoverageV1 } {
  const contract = {
    version: 1, contractId: "contract", revision: 1, runId: "run", workId: "T001", admissionDigest: hash("a"),
    depthDecision: {} as never, inputs: [{ id: "preimplementation-source", kind: "baseline", reference: "source", digest: hash("b"), authority: "inspected-context", revision: "HEAD", availability: "available" }],
    baseline: [], requirements: [], checks: [{ id: "host-scope", requirementRefs: [], origin: "invariant", expectedBehavior: "Rafi compares the final product paths with the host-captured preimplementation baseline and rejects unauthorized product changes.", obligation: "mandatory", timing: "postimplementation", applicability: { kind: "unconditional", decisionOwner: "host", requiredEvidence: ["host-preimplementation-source"] }, verification: [], expectedEvidence: ["Rafi host-owned postimplementation scope comparison bound to the retained host-preimplementation baseline."], prerequisiteRefs: [], dependsOnChecks: [] }], coverage: [], preparationEvidence: [], unresolved: [], createdAt: "2026-01-01T00:00:00.000Z", contentDigest: hash("c"), draftPayloadDigest: hash("d"), semanticAssessmentDigest: hash("e"),
  } as QaVerificationContractV1;
  const coverage = {
    version: 1, phase: "qa", runId: "run", workId: "T001", revision: 1, contractDigest: hash("c"), sourceDigest: hash("f"), inputBasisDigest: hash("a"), attemptId: "attempt", sessionId: "session",
    checks: [
      { checkId: "host-scope", applicability: "applicable", predicateEvidence: [], outcome: "not-run", evidence: [] },
      { checkId: "ordinary", applicability: "applicable", predicateEvidence: ["predicate"], outcome: "passed", evidence: [{ procedure: "test", cwd: ".", runtime: "node", sourceDigest: hash("f"), reference: "provider-evidence" }] },
    ],
  } as QaContractCoverageV1;
  contract.checks.push({ id: "ordinary", requirementRefs: [], origin: "explicit", expectedBehavior: "ordinary product behavior", obligation: "mandatory", timing: "postimplementation", applicability: { kind: "unconditional", decisionOwner: "qa", requiredEvidence: [] }, verification: [], expectedEvidence: ["test"], prerequisiteRefs: [], dependsOnChecks: [] });
  return { contract, coverage };
}

test("host augmentation replaces only the host-owned row and preserves provider coverage", () => {
  const { contract, coverage } = fixture();
  const result = hostQaComparisonV1Schema.parse({ version: 1, runId: "run", ticketId: "T001", assignmentId: "assignment", contractDigest: hash("c"), contractRevision: 1, reviewAttemptId: "attempt", reviewBasisDigest: hash("a"), baselineSourceDigest: hash("b"), finalSourceDigest: hash("f"), scopeBasisDigest: hash("d"), status: "passed", changedPaths: [], unauthorizedPaths: [], deletedPaths: [], protectedPaths: [], reason: "passed", comparedAt: "2026-01-01T00:00:00.000Z" });
  const augmented = applyHostQaComparison(coverage, contract, result, hash("e"), "/project");
  const host = augmented.checks.find(row => row.checkId === "host-scope")!;
  assert.equal(host.outcome, "passed");
  assert.equal(host.evidence[0]!.reference, `host-qa-comparison:${hash("e")}`);
  assert.deepEqual(augmented.checks.find(row => row.checkId === "ordinary"), coverage.checks.find(row => row.checkId === "ordinary"));
});

test("host augmentation resolves the false documentation requirement without weakening true requirements", () => {
  const { contract, coverage } = fixture();
  contract.documentation = { required: false, targets: [], criteria: [] };
  contract.checks.push({ id: "documentation-policy", requirementRefs: [], origin: "invariant", expectedBehavior: "Rafi verifies whether documentation is required by the admitted contract.", obligation: "mandatory", timing: "postimplementation", applicability: { kind: "unconditional", decisionOwner: "host", requiredEvidence: [] }, verification: [], expectedEvidence: ["Host-owned documentation applicability result."], prerequisiteRefs: [], dependsOnChecks: [] });
  coverage.checks.push({ checkId: "documentation-policy", applicability: "applicable", predicateEvidence: ["Approved documentation.required is false"], outcome: "not-run", evidence: [] });
  const result = hostQaComparisonV1Schema.parse({ version: 1, runId: "run", ticketId: "T001", assignmentId: "assignment", contractDigest: hash("c"), contractRevision: 1, reviewAttemptId: "attempt", reviewBasisDigest: hash("a"), baselineSourceDigest: hash("b"), finalSourceDigest: hash("f"), scopeBasisDigest: hash("d"), status: "passed", changedPaths: [], unauthorizedPaths: [], deletedPaths: [], protectedPaths: [], reason: "passed", comparedAt: "2026-01-01T00:00:00.000Z" });
  const augmented = applyHostQaComparison(coverage, contract, result, hash("e"), "/project");
  const documentation = augmented.checks.find(row => row.checkId === "documentation-policy")!;
  assert.equal(documentation.outcome, "passed");
  assert.match(documentation.evidence[0]!.reference, /^host-qa-documentation:/);
});

test("host augmentation recognizes the admitted baseline-bound scope check wording", () => {
  const { contract, coverage } = fixture();
  contract.checks = [{
    id: "host-scope",
    requirementRefs: [],
    origin: "invariant",
    expectedBehavior: "Product changes are limited to the approved multiply implementation and its focused tests, with host-owned bookkeeping excluded from provider scope assessment.",
    obligation: "mandatory",
    timing: "postimplementation",
    applicability: { kind: "unconditional", decisionOwner: "qa", requiredEvidence: ["Host-owned scope comparison against the preimplementation baseline", "Reviewed approved source and test paths"] },
    verification: [],
    expectedEvidence: ["Host-owned scope comparison result"],
    prerequisiteRefs: [],
    dependsOnChecks: [],
  }];
  coverage.checks = [{ checkId: "host-scope", applicability: "applicable", predicateEvidence: [], outcome: "not-run", evidence: [] }];
  const result = hostQaComparisonV1Schema.parse({ version: 1, runId: "run", ticketId: "T001", assignmentId: "assignment", contractDigest: hash("c"), contractRevision: 1, reviewAttemptId: "attempt", reviewBasisDigest: hash("a"), baselineSourceDigest: hash("b"), finalSourceDigest: hash("f"), scopeBasisDigest: hash("d"), status: "passed", changedPaths: [], unauthorizedPaths: [], deletedPaths: [], protectedPaths: [], reason: "passed", comparedAt: "2026-01-01T00:00:00.000Z" });
  const augmented = applyHostQaComparison(coverage, contract, result, hash("e"), "/project");
  assert.equal(augmented.checks.find(row => row.checkId === "host-scope")?.outcome, "passed");
});

test("host augmentation replaces every matching host-owned scope or safety row", () => {
  const { contract, coverage } = fixture();
  contract.checks.push({
    id: "host-safety",
    requirementRefs: [],
    origin: "invariant",
    expectedBehavior: "Builder work complies with scoped-change and no-destructive-operation rules.",
    obligation: "mandatory",
    timing: "postimplementation",
    applicability: { kind: "unconditional", decisionOwner: "host", requiredEvidence: ["Host scope and protected-file comparison"] },
    verification: [],
    expectedEvidence: ["Host safety/scope result"],
    prerequisiteRefs: [],
    dependsOnChecks: [],
  });
  coverage.checks.push({ checkId: "host-safety", applicability: "applicable", predicateEvidence: [], outcome: "not-run", evidence: [] });
  const result = hostQaComparisonV1Schema.parse({ version: 1, runId: "run", ticketId: "T001", assignmentId: "assignment", contractDigest: hash("c"), contractRevision: 1, reviewAttemptId: "attempt", reviewBasisDigest: hash("a"), baselineSourceDigest: hash("b"), finalSourceDigest: hash("f"), scopeBasisDigest: hash("d"), status: "passed", changedPaths: [], unauthorizedPaths: [], deletedPaths: [], protectedPaths: [], reason: "passed", comparedAt: "2026-01-01T00:00:00.000Z" });
  const augmented = applyHostQaComparison(coverage, contract, result, hash("e"), "/project");
  assert.equal(augmented.checks.find(row => row.checkId === "host-scope")?.outcome, "passed");
  assert.equal(augmented.checks.find(row => row.checkId === "host-safety")?.outcome, "passed");
});

test("host result rejects a different review binding", () => {
  const { contract, coverage } = fixture();
  const result = hostQaComparisonV1Schema.parse({ version: 1, runId: "run", ticketId: "T001", assignmentId: "assignment", contractDigest: hash("c"), contractRevision: 1, reviewAttemptId: "other-attempt", reviewBasisDigest: hash("a"), baselineSourceDigest: hash("b"), finalSourceDigest: hash("f"), scopeBasisDigest: hash("d"), status: "passed", changedPaths: [], unauthorizedPaths: [], deletedPaths: [], protectedPaths: [], reason: "passed", comparedAt: "2026-01-01T00:00:00.000Z" });
  assert.throws(() => applyHostQaComparison(coverage, contract, result, hash("e"), "/project"), /not bound/);
});
