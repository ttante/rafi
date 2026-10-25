import { qaPreparationDepthDecisionV1Schema } from "./qaPreparation.js";
const text = { type: "string", minLength: 1 };
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" };
const strings = { type: "array", items: text };
const enumeration = (...values: string[]) => ({ enum: values });
const array = (items: unknown, minItems = 0) => ({ type: "array", items, minItems, maxItems: 10000 });
const object = (properties: Record<string, unknown>, optional: string[] = []) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties).filter(key => !optional.includes(key)) });
const documentationTarget = { type: "string", minLength: 1, maxLength: 1_000, pattern: "^(?!/)(?!.*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))(?![A-Za-z]:[/\\\\])" };
const verificationIntentV2Schema = object({
  id: text,
  summary: text,
  timing: enumeration("preimplementation", "postimplementation", "both"),
  applicability: {
    oneOf: [
      object({ kind: { const: "always" } }),
      object({ kind: { const: "host-executable-available" }, executable: enumeration("pnpm", "npm", "yarn", "bun", "node", "python3", "pytest", "cargo", "go"), expected: { type: "boolean" }, phase: enumeration("preimplementation", "postimplementation", "both") }),
    ],
  },
  methods: array(object({ kind: enumeration("command", "procedure"), argv: array(text, 1), steps: array(text, 1), cwd: text, runtime: text, timeout_ms: { type: "integer", minimum: 1, maximum: 3600000 }, expected_outcome: text }, ["argv", "steps"]), 1),
  expected_evidence: array(text, 1),
  depends_on: strings,
});
export const documentationPolicyV1Schema = object({ required: { type: "boolean" }, targets: array(documentationTarget, 0), criteria: array(text, 0) });
export const qaContractInputRefSchema = object({ id: text, kind: enumeration("ticket", "plan", "decision", "checklist", "rules", "skill", "policy", "baseline"), reference: text, digest, authority: enumeration("approved-scope", "project-rule", "planner-policy", "inspected-context"), revision: text, availability: enumeration("available", "missing", "unsupported") });
export const qaRequirementRefSchema = object({ id: text, inputRef: text, locator: text, statement: text, digest, obligation: enumeration("mandatory", "advisory"), origin: enumeration("explicit", "derived", "invariant", "proposed", "advisory"), authority: enumeration("approved", "invariant", "proposed"), conflict: text, verificationIntent: verificationIntentV2Schema, verificationIntentDigest: digest }, ["conflict", "verificationIntent", "verificationIntentDigest"]);
export const qaVerificationMethodSchema = object({ kind: enumeration("command", "procedure"), argv: array({ type: "string" }, 1), steps: array(text, 1), cwd: text, fixtures: strings, expectedOutcome: text, runtime: text, timeoutMs: { type: "integer", minimum: 1, maximum: 3600000 }, equivalentAuthorityId: text }, ["argv", "steps", "equivalentAuthorityId"]);
export const qaVerificationCheckSchema = object({ hostKind: enumeration("source-scope", "graph-maintenance", "documentation-policy"), id: text, requirementRefs: array(text, 1), origin: enumeration("explicit", "derived", "invariant", "proposed", "advisory"), expectedBehavior: text, obligation: enumeration("mandatory", "advisory"), timing: enumeration("preimplementation", "postimplementation", "both"), applicability: object({ kind: enumeration("unconditional", "conditional"), predicate: text, decisionOwner: enumeration("host", "qa"), requiredEvidence: strings }, ["predicate"]), verification: array(qaVerificationMethodSchema, 1), expectedEvidence: array(text, 1), prerequisiteRefs: strings, dependsOnChecks: strings, expectedBaseline: text, dispositionRef: text, successorOf: text }, ["hostKind", "expectedBaseline", "dispositionRef", "successorOf"]);
export const qaUnresolvedConcernSchema = object({ category: enumeration("evidence-gap", "contract-gap", "scope-conflict", "verification-gap"), timing: enumeration("preimplementation", "postimplementation", "both"), reason: text, requirementIds: strings, checkIds: strings, material: { type: "boolean" }, owner: text, nextAction: text }, ["category", "timing"]);
const candidateFields = {
  version: { const: 1 }, contractId: text, revision: { type: "integer", minimum: 1 }, predecessorDigest: digest,
  runId: text, workId: text, admissionDigest: digest, depthDecision: qaPreparationDepthDecisionV1Schema,
  inputs: array(qaContractInputRefSchema, 1), requirements: array(qaRequirementRefSchema, 1), checks: array(qaVerificationCheckSchema, 1),
  documentation: documentationPolicyV1Schema,
  baseline: array(object({ checkId: text, applicability: enumeration("applicable", "not-applicable", "unresolved"), predicateEvidence: strings, id: text, sourceDigest: digest, phase: text, runtime: text, procedure: text, observedAt: text, status: enumeration("passed", "failed", "blocked", "not-run"), evidenceDigest: digest, relevance: text, expectedTransition: text }, ["checkId", "applicability", "predicateEvidence"])),
  coverage: array(object({ requirementId: text, checkIds: array(text, 1), dispositionRef: text }, ["dispositionRef"]), 1),
  preparationEvidence: array(object({ obligation: text, references: array(object({ path: text, digest, locator: text }), 1), analysis: text, operationId: text, sessionId: text, evidenceDigest: digest, graphReceiptRefs: strings }, ["graphReceiptRefs"]), 1),
  unresolved: array(qaUnresolvedConcernSchema), createdAt: text,
};
export const qaContractCandidateV1Schema = object(candidateFields, ["predecessorDigest", "documentation"]);
export const qaVerificationContractV1Schema = object({ ...candidateFields, contentDigest: digest, draftPayloadDigest: digest, semanticAssessmentDigest: digest, challengeReceiptDigest: digest }, ["predecessorDigest", "challengeReceiptDigest", "documentation"]);
const assessmentFields = { version: { const: 1 }, draftPayloadDigest: digest, inventoryDigest: digest, policyVersion: { const: "qa-preparation-v1" }, operationId: text, sessionId: text, authorSessionId: text, assessedRequirementIds: array(text, 1), assessedObligations: array(text, 1), concerns: array(qaUnresolvedConcernSchema) };
export const qaSemanticAssessmentV1Schema = object(assessmentFields);
export const qaChallengeReceiptV1Schema = object({ ...assessmentFields, approach: text, concernCategories: array(text, 1), approachConcerns: array(qaUnresolvedConcernSchema) });
export const qaContractCoverageV1Schema = object({ version: { const: 1 }, phase: enumeration("builder", "qa"), runId: text, workId: text, revision: { type: "integer", minimum: 1 }, contractDigest: digest, sourceDigest: digest, inputBasisDigest: digest, attemptId: text, sessionId: text,
  checks: array(object({ checkId: text, applicability: enumeration("applicable", "not-applicable", "unresolved"), predicateEvidence: strings, outcome: enumeration("passed", "failed", "blocked", "not-run"), evidence: array(object({ procedure: text, cwd: text, runtime: text, sourceDigest: digest, reference: text, limitation: text }, ["limitation"])) }), 1),
});
