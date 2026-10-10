/** Versioned public artifacts. Mutable lifecycle and observations are stored separately. */
export type QaPreparationLevel = 1 | 2 | 3 | 4 | 5;
export type QaPreparationMode = "legacy" | "shadow" | "enforce";
export type QaRiskCategory = "interaction" | "compatibility" | "state-transition" | "external-dependency" | "authorization" | "security" | "data-integrity" | "migration" | "concurrency" | "recovery" | "deployment" | "architecture-uncertainty";
export interface QaPreparationDepthDecisionV1 {
  version: 1; decisionId: string; level: QaPreparationLevel; rationale: string;
  riskFactors: Array<{ category: QaRiskCategory; rationale: string; references: string[] }>;
  lowRisk?: { narrowBehavior: string; understoodDependencies: string; adequateVerification: string };
  policyVersion: string; plannerOperationId: string; plannerIdentity: string; timestamp: string;
  minimumLevel: QaPreparationLevel; minimumReasons: string[]; predecessorDecisionId?: string;
}
export interface QaPreparationConfigV1 {
  mode: QaPreparationMode; policyVersion: "qa-preparation-v1";
  wallTimeMs: [number, number, number, number, number];
}
export interface ContractInputRef {
  id: string; kind: "ticket" | "plan" | "decision" | "checklist" | "rules" | "skill" | "policy" | "baseline";
  reference: string; digest: string; authority: "approved-scope" | "project-rule" | "planner-policy" | "inspected-context";
  revision: string; availability: "available" | "missing" | "unsupported";
}
export interface RequirementRef {
  id: string; inputRef: string; locator: string; statement: string; digest: string;
  obligation: "mandatory" | "advisory"; origin: "explicit" | "derived" | "invariant" | "proposed" | "advisory";
  authority: "approved" | "invariant" | "proposed"; conflict?: string;
}
export interface VerificationMethod {
  kind: "command" | "procedure"; argv?: string[]; steps?: string[]; cwd: string;
  fixtures: string[]; expectedOutcome: string; runtime: string; timeoutMs: number;
  equivalentAuthorityId?: string;
}
export interface VerificationCheckV1 {
  id: string; requirementRefs: string[]; origin: RequirementRef["origin"]; expectedBehavior: string;
  obligation: "mandatory" | "advisory"; timing: "preimplementation" | "postimplementation" | "both";
  applicability: { kind: "unconditional" | "conditional"; predicate?: string; decisionOwner: "host" | "qa"; requiredEvidence: string[] };
  verification: VerificationMethod[]; expectedEvidence: string[]; prerequisiteRefs: string[]; dependsOnChecks: string[];
  expectedBaseline?: string; dispositionRef?: string; successorOf?: string;
}
export interface RequirementCoverageRef { requirementId: string; checkIds: string[]; dispositionRef?: string }
export interface BaselineObservationRef {
  checkId?: string; applicability?: "applicable" | "not-applicable" | "unresolved"; predicateEvidence?: string[];
  id: string; sourceDigest: string; phase: string; runtime: string; procedure: string; observedAt: string;
  status: "passed" | "failed" | "blocked" | "not-run"; evidenceDigest: string; relevance: string; expectedTransition: string;
}
export interface PreparationEvidenceRef {
  obligation: string; references: Array<{ path: string; digest: string; locator: string }>;
  analysis: string; operationId: string; sessionId: string; evidenceDigest: string;
  /** Host-bound navigation provenance; never substitutes for source references. */
  graphReceiptRefs?: string[];
}
export interface UnresolvedConcern {
  reason: string; requirementIds: string[]; checkIds: string[]; material: boolean; owner: string; nextAction: string;
}
export interface QaContractCandidateV1 {
  version: 1; contractId: string; revision: number; predecessorDigest?: string;
  runId: string; workId: string; admissionDigest: string; depthDecision: QaPreparationDepthDecisionV1;
  inputs: ContractInputRef[]; baseline: BaselineObservationRef[]; requirements: RequirementRef[];
  checks: VerificationCheckV1[]; coverage: RequirementCoverageRef[]; preparationEvidence: PreparationEvidenceRef[];
  unresolved: UnresolvedConcern[]; createdAt: string;
}
export interface QaVerificationContractV1 extends QaContractCandidateV1 {
  contentDigest: string; draftPayloadDigest: string; semanticAssessmentDigest: string; challengeReceiptDigest?: string;
}
export interface QaSemanticAssessmentV1 {
  version: 1; draftPayloadDigest: string; inventoryDigest: string; policyVersion: string;
  operationId: string; sessionId: string; authorSessionId: string;
  assessedRequirementIds: string[]; assessedObligations: string[]; concerns: UnresolvedConcern[];
}
export interface QaChallengeReceiptV1 extends QaSemanticAssessmentV1 {
  approach: string; concernCategories: string[]; approachConcerns: UnresolvedConcern[];
}
export interface QaContractDeliveryReceiptV1 {
  version: 1; operationId: string; runId: string; workId: string; admissionDigest: string;
  revision: number; contractDigest: string; resourceDigest: string;
  provider: string; sessionId: string; generation: number; workspace: string; configRoot: string;
  responseDigest: string; deliveredAt: string; compactionSequence: number;
}
export interface QaContractCoverageV1 {
  version: 1; phase: "builder" | "qa"; runId: string; workId: string; revision: number; contractDigest: string;
  sourceDigest: string; inputBasisDigest: string; attemptId: string; sessionId: string;
  checks: Array<{ checkId: string; applicability: "applicable" | "not-applicable" | "unresolved";
    predicateEvidence: string[]; outcome: "passed" | "failed" | "blocked" | "not-run";
    evidence: Array<{ procedure: string; cwd: string; runtime: string; sourceDigest: string; reference: string; limitation?: string }> }>;
}

export const QA_PREPARATION_POLICY_VERSION = "qa-preparation-v1" as const;
export const QA_RISK_MINIMUMS: Record<QaRiskCategory, QaPreparationLevel> = {
  interaction: 3, compatibility: 3, "state-transition": 3, "external-dependency": 3,
  authorization: 4, security: 4, "data-integrity": 4, migration: 4, concurrency: 4, recovery: 4, deployment: 4,
  "architecture-uncertainty": 5,
};
export const qaPreparationDepthDecisionV1Schema = {
  type: "object", additionalProperties: false,
  required: ["version", "decisionId", "level", "rationale", "riskFactors", "policyVersion", "plannerOperationId", "plannerIdentity", "timestamp", "minimumLevel", "minimumReasons"],
  properties: {
    version: { const: 1 }, decisionId: { type: "string", minLength: 1 }, level: { type: "integer", minimum: 1, maximum: 5 },
    rationale: { type: "string", minLength: 1 }, policyVersion: { const: QA_PREPARATION_POLICY_VERSION },
    plannerOperationId: { type: "string", minLength: 1 }, plannerIdentity: { type: "string", minLength: 1 },
    timestamp: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T" }, minimumLevel: { type: "integer", minimum: 1, maximum: 5 },
    minimumReasons: { type: "array", items: { type: "string", minLength: 1 } }, predecessorDecisionId: { type: "string", minLength: 1 },
    lowRisk: { type: "object", additionalProperties: false, required: ["narrowBehavior", "understoodDependencies", "adequateVerification"], properties: {
      narrowBehavior: { type: "string", minLength: 1 }, understoodDependencies: { type: "string", minLength: 1 }, adequateVerification: { type: "string", minLength: 1 },
    } },
    riskFactors: { type: "array", items: { type: "object", additionalProperties: false, required: ["category", "rationale", "references"], properties: {
      category: { enum: Object.keys(QA_RISK_MINIMUMS) }, rationale: { type: "string", minLength: 1 }, references: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    } } },
  },
} as const;
