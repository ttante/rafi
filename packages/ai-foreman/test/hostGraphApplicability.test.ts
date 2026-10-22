import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleContract } from "../src/qaVerificationContract.js";
import { applyHostGraphApplicability, createHostGraphApplicability, hostGraphApplicabilityV1Schema, isGraphQaCheck, normalizeGraphQaChecks } from "../src/hostGraphApplicability.js";
import { applyHostQaAugmentations } from "../src/hostQaAugmentation.js";
import { assessment, candidate, coverage, digest } from "./qaPreparationFixtures.js";

test("Graphify checks are normalized as host-owned conditional checks", () => {
  const draft = candidate();
  draft.checks[0]!.expectedBehavior = "Use Graphify graph evidence to verify the changed callers";
  draft.checks[0]!.expectedEvidence = ["Graphify evidence receipt"];
  const normalized = normalizeGraphQaChecks(draft);
  assert.equal(normalized.checks[0]!.applicability.kind, "conditional");
  assert.equal(normalized.checks[0]!.applicability.decisionOwner, "host");
  assert.equal(normalized.checks[0]!.obligation, "mandatory");
});

test("ordinary product graph checks are not treated as Graphify checks", () => {
  const draft = candidate();
  draft.checks[0]!.expectedBehavior = "The graph query returns the connected customer nodes";
  draft.checks[0]!.expectedEvidence = ["Graph traversal test output"];
  assert.equal(isGraphQaCheck(draft.checks[0]! as never), false);
  assert.equal(normalizeGraphQaChecks(draft).checks[0]!.applicability.decisionOwner, "qa");
});

test("disabled or unavailable Graphify becomes non-blocking host coverage", () => {
  const draft = candidate();
  draft.checks[0]!.expectedBehavior = "Use Graphify graph evidence to verify the changed callers";
  draft.checks[0]!.expectedEvidence = ["Graphify evidence receipt"];
  const normalized = normalizeGraphQaChecks(draft);
  const contract = assembleContract(normalized, normalized.requirements, assessment(normalized), "author");
  const sourceDigest = digest;
  const store = { artifacts: () => [], putArtifact: (_kind: string, value: unknown) => digest };
  const result = createHostGraphApplicability({ projectDir: mkdtempSync(join(tmpdir(), "rafi-graph-")), runId: "run", ticketId: "T1", contract, reviewAttemptId: "review", reviewBasisDigest: digest, sourceDigest, store });
  assert.equal(hostGraphApplicabilityV1Schema.parse(result.result).status, "disabled");
  const augmented = applyHostGraphApplicability(coverage(contract), contract, result.result, result.resultDigest, ".");
  assert.equal(augmented.checks[0]!.applicability, "not-applicable");
  assert.equal(augmented.checks[0]!.outcome, "passed");
});

test("missing Graphify project is fail-open and never treated as a blocker", () => {
  const draft = candidate();
  draft.checks[0]!.expectedBehavior = "Use Graphify graph evidence";
  draft.checks[0]!.expectedEvidence = ["Graphify evidence"];
  const normalized = normalizeGraphQaChecks(draft);
  const contract = assembleContract(normalized, normalized.requirements, assessment(normalized), "author");
  const result = createHostGraphApplicability({ projectDir: "/tmp/rafi-graphify-project-does-not-exist", runId: "run", ticketId: "T1", contract, reviewAttemptId: "review", reviewBasisDigest: digest, sourceDigest: digest, store: { artifacts: () => [], putArtifact: () => digest } });
  assert.equal(result.result.status, "unavailable");
});

test("host-owned adopted Graphify applicability overrides provider waiver", () => {
  const draft = candidate();
  draft.checks[0]!.expectedBehavior = "Use Graphify graph evidence";
  draft.checks[0]!.expectedEvidence = ["Graphify evidence"];
  const normalized = normalizeGraphQaChecks(draft);
  const contract = assembleContract(normalized, normalized.requirements, assessment(normalized), "author");
  const result = hostGraphApplicabilityV1Schema.parse({ version: 1, runId: "run", ticketId: "T1", contractDigest: contract.contentDigest, contractRevision: contract.revision, reviewAttemptId: "review", reviewBasisDigest: digest, sourceDigest: digest, status: "adopted-enabled", reason: "adopted", observedAt: "2026-01-01T00:00:00.000Z" });
  const provider = coverage(contract);
  provider.checks[0]!.applicability = "not-applicable";
  provider.checks[0]!.outcome = "not-run";
  const augmented = applyHostGraphApplicability(provider, contract, result, digest, ".");
  assert.equal(augmented.checks[0]!.applicability, "applicable");
  assert.equal(augmented.checks[0]!.outcome, "not-run");
});

test("the shared host augmentation produces the same replay coverage", () => {
  const draft = candidate();
  draft.checks[0]!.expectedBehavior = "Use Graphify graph evidence";
  draft.checks[0]!.expectedEvidence = ["Graphify evidence receipt"];
  const normalized = normalizeGraphQaChecks(draft);
  const contract = assembleContract(normalized, normalized.requirements, assessment(normalized), "author");
  const result = hostGraphApplicabilityV1Schema.parse({ version: 1, runId: "run", ticketId: "T1", contractDigest: contract.contentDigest, contractRevision: contract.revision, reviewAttemptId: "review", reviewBasisDigest: digest, sourceDigest: digest, status: "disabled", reason: "disabled", observedAt: "2026-01-01T00:00:00.000Z" });
  const providerCoverage = coverage(contract);
  const live = applyHostQaAugmentations({ coverage: providerCoverage, contract, projectDir: ".", hostGraph: { result, resultDigest: digest } });
  const replay = applyHostQaAugmentations({ coverage: structuredClone(providerCoverage), contract, projectDir: ".", hostGraph: { result, resultDigest: digest } });
  assert.deepEqual(replay, live);
  assert.equal(replay.checks[0]!.outcome, "passed");
  assert.equal(replay.checks[0]!.applicability, "not-applicable");
});
