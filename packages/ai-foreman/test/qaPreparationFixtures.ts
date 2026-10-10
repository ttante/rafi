import Database from "better-sqlite3";
import type { QaContractCandidateV1, QaSemanticAssessmentV1, QaPreparationDepthDecisionV1, QaContractCoverageV1 } from "rafi-spec";
import { QaPreparationStore, migrateQaPreparation } from "../src/qaPreparationStore.js";
import { depthObligations, resolveQaPreparationConfig } from "../src/qaPreparationPolicy.js";
import { contractDigest, draftDigest, inventoryDigest } from "../src/qaVerificationContract.js";
export const digest = "a".repeat(64);
export function decision(level: 1 | 2 | 3 | 4 | 5 = 2): QaPreparationDepthDecisionV1 {
  return { version: 1, decisionId: `depth-${level}`, level, rationale: "Inspected ordinary behavior and tests", riskFactors: [], policyVersion: "qa-preparation-v1", plannerOperationId: "planner-op", plannerIdentity: "planner-session", timestamp: "2026-10-09T00:00:00Z", minimumLevel: level === 1 ? 1 : 2, minimumReasons: [], ...(level === 1 ? { lowRisk: { narrowBehavior: "one behavior", understoodDependencies: "inspected callers", adequateVerification: "behavior regression" } } : {}) };
}
export function candidate(level: 1 | 2 | 3 | 4 | 5 = 2): QaContractCandidateV1 {
  return { version: 1, contractId: "contract", revision: 1, runId: "run", workId: "T1", admissionDigest: digest, depthDecision: decision(level),
    inputs: [{ id: "ticket", kind: "ticket", reference: "admission", digest, authority: "approved-scope", revision: "1", availability: "available" }],
    baseline: [], requirements: [{ id: "req", inputRef: "ticket", locator: "acceptance[0]", statement: "Reject expired token", digest: contractDigest("statement", "Reject expired token"), obligation: "mandatory", origin: "explicit", authority: "approved" }],
    checks: [{ id: "check", requirementRefs: ["req"], origin: "explicit", expectedBehavior: "Expired tokens return unauthorized", obligation: "mandatory", timing: "postimplementation", applicability: { kind: "unconditional", decisionOwner: "qa", requiredEvidence: [] }, verification: [{ kind: "command", argv: ["node", "--test", "test/token.test.js"], cwd: ".", fixtures: [], expectedOutcome: "Expired-token assertion passes", runtime: "node20", timeoutMs: 30000 }], expectedEvidence: ["test output"], prerequisiteRefs: [], dependsOnChecks: [] }],
    coverage: [{ requirementId: "req", checkIds: ["check"] }], preparationEvidence: depthObligations(level).map(obligation => ({ obligation, references: [{ path: "src/token.ts", digest, locator: "verifyToken" }], analysis: `Inspected ${obligation}; token-expiry expectation is observable in tests`, operationId: "author-op", sessionId: "author", evidenceDigest: digest })), unresolved: [], createdAt: "2026-10-09T00:00:00Z" };
}
export function assessment(draft: QaContractCandidateV1): QaSemanticAssessmentV1 { return { version: 1, draftPayloadDigest: draftDigest(draft), inventoryDigest: inventoryDigest(draft.requirements), policyVersion: "qa-preparation-v1", operationId: "assessor-op", sessionId: "assessor", authorSessionId: "author", assessedRequirementIds: draft.requirements.map(req => req.id), assessedObligations: depthObligations(draft.depthDecision.level), concerns: [] }; }
export function storeFixture() {
  const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); db.exec("CREATE TABLE workflow_runs(run_id TEXT PRIMARY KEY); INSERT INTO workflow_runs VALUES('run');"); migrateQaPreparation(db);
  const store = new QaPreparationStore(db, runId => { if (runId !== "run") throw new Error("Foreign owner"); }); store.freezePolicy("run", resolveQaPreparationConfig({ mode: "enforce" }));
  return { db, store };
}
export function coverage(contract: import("rafi-spec").QaVerificationContractV1): QaContractCoverageV1 { return { version: 1, phase: "qa", runId: "run", workId: "T1", revision: contract.revision, contractDigest: contract.contentDigest, sourceDigest: digest, inputBasisDigest: digest, attemptId: "review", sessionId: "reviewer", checks: [{ checkId: "check", applicability: "applicable", predicateEvidence: [], outcome: "passed", evidence: [{ procedure: "node --test", cwd: ".", runtime: "node20", sourceDigest: digest, reference: "retained-test-output" }] }] }; }
