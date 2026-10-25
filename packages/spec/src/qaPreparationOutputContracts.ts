import { operationContract, operationJsonContract } from "./operationContracts.js";
import { qaContractCandidateV1Schema, qaSemanticAssessmentV1Schema, qaChallengeReceiptV1Schema, qaUnresolvedConcernSchema } from "./qaPreparationSchemas.js";
import { qaPreparationEscalationProposalV1Schema } from "./providerContracts.js";
import { qaPreparationDepthDecisionV1Schema as qaDepthDecisionSchema, type QaContractCandidateV1, type QaPreparationDepthDecisionV1, type QaSemanticAssessmentV1, type QaChallengeReceiptV1 } from "./qaPreparation.js";

// The provider proposes verification work; the host owns contract identity,
// approved inputs, depth, timestamps, and evidence hashes.
const durableFields = qaContractCandidateV1Schema.properties;
const providerEvidence = { type: "object", additionalProperties: false, required: ["obligation", "references", "analysis"], properties: {
  obligation: { type: "string", minLength: 1 }, analysis: { type: "string", minLength: 1 },
  references: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["path", "locator"], properties: { path: { type: "string", minLength: 1 }, locator: { type: "string", minLength: 1 } } } },
} };
const providerBaseline = { type: "object", additionalProperties: false, required: ["id", "runtime", "procedure", "status", "relevance", "expectedTransition"], properties: {
  id: { type: "string", minLength: 1 }, checkId: { type: "string", minLength: 1 }, applicability: { enum: ["applicable", "not-applicable", "unresolved"] }, predicateEvidence: { type: "array", items: { type: "string" } }, runtime: { type: "string", minLength: 1 }, procedure: { type: "string", minLength: 1 }, status: { enum: ["passed", "failed", "blocked", "not-run"] }, relevance: { type: "string", minLength: 1 }, expectedTransition: { type: "string", minLength: 1 },
} };
const providerConcerns = { type: "array", maxItems: 10000, items: { ...qaUnresolvedConcernSchema, required: Object.keys(qaUnresolvedConcernSchema.properties) } };
const providerChecks = structuredClone(durableFields.checks) as Record<string, any>;
delete providerChecks.items.properties.hostKind;
export const providerDraftSchema = { type: "object", additionalProperties: false, required: ["checks", "coverage", "baseline", "preparationEvidence", "unresolved"], properties: {
  checks: providerChecks, coverage: durableFields.coverage, baseline: { type: "array", items: providerBaseline }, preparationEvidence: { type: "array", minItems: 1, items: providerEvidence }, unresolved: providerConcerns,
} };
function qaDepthEscalationJson(): Record<string, unknown> {
  const schema = operationContract("escalation", qaPreparationEscalationProposalV1Schema).jsonSchema as any;
  return schema.properties.result.oneOf[0].properties.payload;
}
export const providerDraftPayloadSchema = { oneOf: [
  { type: "object", additionalProperties: false, required: ["kind", ...providerDraftSchema.required], properties: { kind: { const: "draft" }, ...providerDraftSchema.properties } },
  { type: "object", additionalProperties: false, required: ["kind", "escalation"], properties: { kind: { const: "escalation" }, escalation: qaDepthEscalationJson() } },
] };
export type ProviderDraftPayload =
  | ({ kind: "draft" } & Pick<Partial<QaContractCandidateV1>, "checks" | "coverage" | "baseline" | "preparationEvidence" | "unresolved">)
  | { kind: "escalation"; escalation: unknown };
export const draftOutput = operationJsonContract<ProviderDraftPayload>("qa-preparation-draft", providerDraftPayloadSchema);

function proposalSchema(schema: Record<string, any>, hostFields: string[]): Record<string, any> {
  const proposal = structuredClone(schema);
  for (const field of hostFields) delete proposal.properties[field];
  if (proposal.properties.concerns) proposal.properties.concerns = providerConcerns;
  if (proposal.properties.approachConcerns) proposal.properties.approachConcerns = providerConcerns;
  proposal.required = proposal.required.filter((field: string) => !hostFields.includes(field));
  return proposal;
}
const assessmentHostFields = ["draftPayloadDigest", "inventoryDigest", "policyVersion", "operationId", "sessionId", "authorSessionId"];
export const assessmentProposalSchema = proposalSchema(qaSemanticAssessmentV1Schema, assessmentHostFields);
export const challengeProposalSchema = proposalSchema(qaChallengeReceiptV1Schema, assessmentHostFields);
export const depthProposalSchema = proposalSchema(qaDepthDecisionSchema, ["plannerOperationId", "plannerIdentity"]);
export const assessmentOutput = operationJsonContract<QaSemanticAssessmentV1>("qa-preparation-assessment", assessmentProposalSchema);
export const challengeOutput = operationJsonContract<QaChallengeReceiptV1>("qa-preparation-challenge", challengeProposalSchema);
export const depthOutput = operationJsonContract<QaPreparationDepthDecisionV1>("qa-preparation-depth", depthProposalSchema);
