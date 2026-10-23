import test from "node:test";
import assert from "node:assert/strict";
import { applyHostQaComparison, hostQaComparisonV1Schema, inspectHostQaComparison, createHostQaComparison } from "../src/hostQaComparison.js";
import { captureBuildSource } from "../src/buildAssignment.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { applyHostQaAugmentations } from "../src/hostQaAugmentation.js";
import { assembleFinalQaCoverage } from "../src/qaCoverageAssembly.js";
import type { QaContractCoverageV1, QaVerificationContractV1 } from "rafi-spec";

const hash = (char: string) => char.repeat(64);

test("host comparison blocks committed source drift and does not mistake a restored tracked file for deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-comparison-head-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  try {
    git("init", "-q");
    writeFileSync(join(root, "product.txt"), "original\n");
    git("add", "product.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
    writeFileSync(join(root, "product.txt"), "dirty baseline\n");
    const before = captureBuildSource(root);
    writeFileSync(join(root, "product.txt"), "original\n");
    const after = captureBuildSource(root);
    const { contract } = fixture();
    contract.inputs[0]!.digest = before.digest;
    const db = { operations: () => [{ idempotencyKey: "assignment", intent: { ticketId: "T001", before }, result: { after } }] } as unknown as Parameters<typeof inspectHostQaComparison>[0]["db"];
    const input = { db, projectDir: root, worktree: root, runId: "run", ticket: { id: "T001", likely_files: ["product.txt"] } as Parameters<typeof inspectHostQaComparison>[0]["ticket"], contract };
    const restored = inspectHostQaComparison(input);
    assert.equal(restored.status, "passed");
    assert.deepEqual(restored.deletedPaths, []);
    assert.equal(restored.filePreservation?.[0]?.baselineIsExactPrefix, false);
    writeFileSync(join(root, "product.txt"), "committed different content\n");
    git("add", "product.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "changed head");
    const changedHead = inspectHostQaComparison(input);
    assert.equal(changedHead.status, "blocked");
    assert.match(changedHead.reason, /HEAD changed/);
    assert.deepEqual(changedHead.filePreservation, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pre-review comparison supplies current source facts without issuing authority; acceptance recomputes after drift", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-comparison-observation-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "product.txt"), "baseline");
    writeFileSync(join(root, "unchanged.txt"), "preserved");
    const before = captureBuildSource(root);
    writeFileSync(join(root, "product.txt"), "implemented");
    const after = captureBuildSource(root);
    const { contract, coverage } = fixture();
    contract.inputs[0]!.digest = before.digest;
    const retained: Array<{ digest: string; value: unknown }> = [];
    const db = {
      operations: () => [{ idempotencyKey: "assignment", intent: { ticketId: "T001", before }, result: { after } }],
      qaPreparationStore: () => ({ artifacts: () => retained, putArtifact: (_kind: string, value: unknown) => { const digest = hash("d"); retained.push({ digest, value }); return digest; } }),
    } as unknown as Parameters<typeof inspectHostQaComparison>[0]["db"];
    const input = { db, projectDir: root, worktree: root, runId: "run", ticket: { id: "T001", likely_files: ["product.txt"] } as Parameters<typeof inspectHostQaComparison>[0]["ticket"], contract };
    const observation = inspectHostQaComparison(input);
    assert.equal(observation.status, "passed");
    assert.equal(observation.finalSourceDigest, after.digest);
    assert.deepEqual(observation.changedPaths, ["product.txt"]);
    assert.equal("reviewBasisDigest" in observation, false);
    assert.equal(retained.length, 0, "An observation cannot issue or persist acceptance authority");
    assert.throws(() => applyHostQaComparison(coverage, contract, observation as never, hash("d"), root));
    writeFileSync(join(root, "unchanged.txt"), "unauthorized later mutation");
    const acceptedComparison = createHostQaComparison({ ...input, reviewAttemptId: "review", reviewBasisDigest: hash("a") });
    assert.equal(acceptedComparison.result.status, "failed");
    assert.deepEqual(acceptedComparison.result.unauthorizedPaths, ["unchanged.txt"]);
    assert.notEqual(acceptedComparison.result.finalSourceDigest, observation.finalSourceDigest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixture(): { contract: QaVerificationContractV1; coverage: QaContractCoverageV1 } {
  const contract = {
    version: 1, contractId: "contract", revision: 1, runId: "run", workId: "T001", admissionDigest: hash("a"),
    depthDecision: {} as never, inputs: [{ id: "preimplementation-source", kind: "baseline", reference: "source", digest: hash("b"), authority: "inspected-context", revision: "HEAD", availability: "available" }],
    baseline: [], requirements: [], checks: [{ id: "host-scope", hostKind: "source-scope", requirementRefs: [], origin: "invariant", expectedBehavior: "Rafi compares the final product paths with the host-captured preimplementation baseline and rejects unauthorized product changes.", obligation: "mandatory", timing: "postimplementation", applicability: { kind: "unconditional", decisionOwner: "host", requiredEvidence: ["host-preimplementation-source"] }, verification: [], expectedEvidence: ["Rafi host-owned postimplementation scope comparison bound to the retained host-preimplementation baseline."], prerequisiteRefs: [], dependsOnChecks: [] }], coverage: [], preparationEvidence: [], unresolved: [], createdAt: "2026-01-01T00:00:00.000Z", contentDigest: hash("c"), draftPayloadDigest: hash("d"), semanticAssessmentDigest: hash("e"),
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
  contract.checks.push({ id: "documentation-policy", hostKind: "documentation-policy", requirementRefs: [], origin: "invariant", expectedBehavior: "Rafi verifies whether documentation is required by the admitted contract.", obligation: "mandatory", timing: "postimplementation", applicability: { kind: "unconditional", decisionOwner: "host", requiredEvidence: [] }, verification: [], expectedEvidence: ["Host-owned documentation applicability result."], prerequisiteRefs: [], dependsOnChecks: [] });
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
    hostKind: "source-scope",
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

test("provider scope wording cannot acquire host authority or replace a failed check", () => {
  const { contract, coverage } = fixture();
  contract.checks = [{
    id: "provider-scope",
    requirementRefs: [],
    origin: "explicit",
    expectedBehavior: "Changed product paths outside bookkeeping and evidence exclusions are limited to index.mjs and test/multiply.test.mjs.",
    obligation: "mandatory",
    timing: "postimplementation",
    applicability: { kind: "unconditional", decisionOwner: "qa", requiredEvidence: ["Host-retained scope observation"] },
    verification: [],
    expectedEvidence: ["Host-retained scope observation result"],
    prerequisiteRefs: [],
    dependsOnChecks: [],
  }];
  coverage.checks = [{ checkId: "provider-scope", applicability: "applicable", predicateEvidence: [], outcome: "failed", evidence: [] }];
  const result = hostQaComparisonV1Schema.parse({ version: 1, runId: "run", ticketId: "T001", assignmentId: "assignment", contractDigest: hash("c"), contractRevision: 1, reviewAttemptId: "attempt", reviewBasisDigest: hash("a"), baselineSourceDigest: hash("b"), finalSourceDigest: hash("f"), scopeBasisDigest: hash("d"), status: "passed", changedPaths: [], unauthorizedPaths: [], deletedPaths: [], protectedPaths: [], reason: "passed", comparedAt: "2026-01-01T00:00:00.000Z" });
  assert.throws(() => applyHostQaComparison(coverage, contract, result, hash("e"), "/project"), /contract check is missing/);
  assert.equal(coverage.checks[0]!.outcome, "failed");
});

test("host augmentation replaces every matching host-owned scope or safety row", () => {
  const { contract, coverage } = fixture();
  contract.checks.push({
    id: "host-safety",
    hostKind: "source-scope",
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

test("host augmentation accepts retained successful test command exit status", () => {
  const { contract, coverage } = fixture();
  contract.checks = [{ ...contract.checks[1]!, id: "npm-test", verification: [{ kind: "command", argv: ["npm", "test"], cwd: ".", fixtures: [], expectedOutcome: "exit 0", runtime: "npm", timeoutMs: 30_000 }] }];
  coverage.checks = [{ checkId: "npm-test", applicability: "applicable", predicateEvidence: [], outcome: "passed", evidence: [] }];
  const augmented = assembleFinalQaCoverage({ providerCoverage: coverage, contract, projectDir: "/project", commandObservations: [{ spanId: "span-1", kind: "npm-test", outcome: "completed", exitCode: 0 }] });
  assert.equal(augmented.checks[0]!.outcome, "passed");
  assert.equal(augmented.checks[0]!.evidence[0]!.reference, "host-command-span:span-1");
});

test("host augmentation accepts retained red-before-green evidence", () => {
  const { contract, coverage } = fixture();
  const finalDigest = hash("f");
  contract.checks = [{
    ...contract.checks[1]!,
    id: "tdd-order",
    expectedBehavior: "The test-first ordering is retained.",
    verification: [{ kind: "command", argv: ["node", "--test", "test/multiply.test.mjs"], cwd: ".", fixtures: [], expectedOutcome: "exit 0", runtime: "node", timeoutMs: 30_000 }],
  }];
  coverage.checks = [{ checkId: "tdd-order", applicability: "applicable", predicateEvidence: [], outcome: "passed", evidence: [] }];
  const augmented = applyHostQaAugmentations({
    coverage, contract, projectDir: ".",
    commandObservations: [
      { kind: "node-test", sequence: 4, testPath: "test/multiply.test.mjs", outcome: "failed", sourceDigest: hash("e"), startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z" },
      { kind: "node-test", sequence: 5, testPath: "test/multiply.test.mjs", outcome: "completed", exitCode: 0, sourceDigest: finalDigest, startedAt: "2026-01-01T00:00:02Z", completedAt: "2026-01-01T00:00:03Z" },
    ],
  });
  assert.equal(augmented.checks[0]!.outcome, "passed");
  assert.match(augmented.checks[0]!.evidence[0]!.reference, /^host-test-sequence:/);
});

test("host augmentation binds the exact retained baseline evidence digest", () => {
  const { contract, coverage } = fixture();
  contract.checks[1]!.timing = "preimplementation";
  contract.baseline = [{ id: "ordinary-baseline", checkId: "ordinary", sourceDigest: hash("b"), phase: "preimplementation-investigation", runtime: "node20", procedure: "Check ordinary", observedAt: "2026-01-01T00:00:00Z", status: "passed", evidenceDigest: hash("g"), relevance: "Regression baseline", expectedTransition: "Remains valid" }];
  const result = applyHostQaAugmentations({ coverage, contract, projectDir: "." });
  const baseline = contract.baseline[0]!;
  assert.ok(baseline);
  assert.ok(result.checks.find(check => check.checkId === "ordinary")!.evidence.some(evidence => evidence.reference === baseline.evidenceDigest));
});

test("host result rejects a different review binding", () => {
  const { contract, coverage } = fixture();
  const result = hostQaComparisonV1Schema.parse({ version: 1, runId: "run", ticketId: "T001", assignmentId: "assignment", contractDigest: hash("c"), contractRevision: 1, reviewAttemptId: "other-attempt", reviewBasisDigest: hash("a"), baselineSourceDigest: hash("b"), finalSourceDigest: hash("f"), scopeBasisDigest: hash("d"), status: "passed", changedPaths: [], unauthorizedPaths: [], deletedPaths: [], protectedPaths: [], reason: "passed", comparedAt: "2026-01-01T00:00:00.000Z" });
  assert.throws(() => applyHostQaComparison(coverage, contract, result, hash("e"), "/project"), /not bound/);
});

for (const outcome of ["not-run", "blocked", "failed"] as const) test(`command observation cannot promote ${outcome} domain coverage to passed`, () => {
  const { contract, coverage } = fixture();
  contract.checks = [{ ...contract.checks[1]!, id: "security-test", verification: [{ kind: "command", argv: ["npm", "test", "--", "security"], cwd: "packages/auth", fixtures: [], expectedOutcome: "authorization boundaries hold", runtime: "npm", timeoutMs: 30000 }] }];
  coverage.checks = [{ checkId: "security-test", applicability: "applicable", predicateEvidence: [], outcome, evidence: [] }];
  const augmented = assembleFinalQaCoverage({ providerCoverage: coverage, contract, projectDir: "/project", commandObservations: [{ spanId: "unrelated-test", kind: "npm-test", outcome: "completed", exitCode: 0 }] });
  assert.deepEqual(augmented.checks, coverage.checks);
});
