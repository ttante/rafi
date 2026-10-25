import { z } from "zod";
import { operationContract, operationJsonContract } from "./operationContracts.js";
import { canonicalJson, createProviderWireContract, decodeCodexOptionalProperties, projectCodexSchema, type OutputContract, type ProviderWireContract } from "./structuredOutput.js";
import { qaContractCoverageV1Schema } from "./qaPreparationSchemas.js";
import { qaFailureReportV1Schema, builderQaRemediationReportV3Schema } from "./schemas.js";
import type { QaContractCoverageV1 } from "./qaPreparation.js";
import { qaRecoveryAcknowledgementV1Schema, qaAcceptanceAcknowledgementV1Schema, qaSegmentAcknowledgementV1Schema } from "./providerContracts.js";
import { assessmentOutput, challengeOutput, depthOutput, draftOutput } from "./qaPreparationOutputContracts.js";

const coverage = qaContractCoverageV1Schema as Record<string, any>;
const row = structuredClone(coverage.properties.checks.items);
delete row.properties.evidence.items.properties.sourceDigest;
row.properties.evidence.items.required = row.properties.evidence.items.required.filter((key: string) => key !== "sourceDigest");
/** Providers author claims. Run/source/session/revision fields are bound by the host. */
export const coverageClaimsSchema = { type: "object", additionalProperties: false, required: ["checks"],
  properties: { checks: { ...coverage.properties.checks, items: row } } };
export type CoverageClaims = { checks: Array<Omit<QaContractCoverageV1["checks"][number], "evidence"> & {
  evidence: Array<Omit<QaContractCoverageV1["checks"][number]["evidence"][number], "sourceDigest">>;
}> };
export const builderCoverageOutput = operationJsonContract<CoverageClaims>("builder-coverage", coverageClaimsSchema, { graph: false });

export type WorkReportPayload = { disposition: "modified" | "already-satisfied";
  evidence: string[]; coverage: CoverageClaims | null; graphMaintenance: "meaningful-indexed-change" | null };
export const workReportOutput = operationJsonContract<WorkReportPayload>("work-report", {
  type: "object", additionalProperties: false, required: ["disposition", "evidence", "coverage", "graphMaintenance"], properties: {
    disposition: { enum: ["modified", "already-satisfied"] },
    evidence: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 4000 } },
    coverage: { anyOf: [coverageClaimsSchema, { type: "null" }] }, graphMaintenance: { enum: ["meaningful-indexed-change", null] },
  },
}, { handoff: true, branchDependency: true });
export const preflightOutput = operationContract("build-preflight", z.strictObject({ steps: z.array(z.strictObject({ ticket: z.string().min(1).nullable(), work: z.string().min(1).max(4000) })).min(1).max(200) }));
export const initializationOutput = operationContract("session-initialization", z.strictObject({ ready: z.literal(true) }), { graph: false });
export const qaRecoveryOutput = operationContract("qa-recovery-acceptance", qaRecoveryAcknowledgementV1Schema, { graph: false });
const { $id: _remediationId, ...remediationReportSchema } = builderQaRemediationReportV3Schema;
export type RemediationPayload = { status: "done" | "blocked"; reason: string | null; report: import("./types.js").BuilderQaRemediationReportV3; coverage: CoverageClaims | null; graphMaintenance?: "meaningful-indexed-change" | null };
export const remediationOutput = operationJsonContract<RemediationPayload>("builder-remediation", {
  type: "object", additionalProperties: false, required: ["status", "reason", "report", "coverage"], properties: {
    graphMaintenance: { enum: ["meaningful-indexed-change", null] },
    status: { enum: ["done", "blocked"] }, reason: { type: ["string", "null"], minLength: 1, maxLength: 4000 }, report: remediationReportSchema,
    coverage: { anyOf: [coverageClaimsSchema, { type: "null" }] },
  },
});

export type QaVerdictPayload = { kind: "passed"; coverage: CoverageClaims | null; verifiedInstructionIds: string[] } | { kind: "failed"; report: import("./types.js").QaFailureReportV1; coverage: CoverageClaims | null; verifiedInstructionIds: string[] };
const { $id: _failureReportId, ...failureReportSchema } = qaFailureReportV1Schema;
export const qaVerdictOutput = operationJsonContract<QaVerdictPayload>("qa-verdict", {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["kind", "coverage", "verifiedInstructionIds"], properties: { kind: { const: "passed" }, verifiedInstructionIds: { description: "IDs of separately issued Manager guidance instructions independently verified in this review. Use only the host supplied allowed instruction IDs; never include contract check IDs, test names, or acceptance criteria. Return [] when the allowed list is empty.", type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } }, coverage: { anyOf: [coverageClaimsSchema, { type: "null" }] } } },
    { type: "object", additionalProperties: false, required: ["kind", "report", "coverage", "verifiedInstructionIds"], properties: { kind: { const: "failed" }, verifiedInstructionIds: { description: "IDs of separately issued Manager guidance instructions independently verified in this review. Use only the host supplied allowed instruction IDs; never include contract check IDs, test names, or acceptance criteria. Return [] when the allowed list is empty.", type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } }, report: failureReportSchema, coverage: { anyOf: [coverageClaimsSchema, { type: "null" }] } } },
  ],
});

export const contractAcceptanceOutput = operationContract("qa-contract-acceptance", qaAcceptanceAcknowledgementV1Schema, { graph: false });
export const contractSegmentOutput = operationContract("qa-contract-segment", qaSegmentAcknowledgementV1Schema, { graph: false });
export const handoffAcceptanceOutput = operationContract("handoff-acceptance", z.strictObject({
  manifestDigest: z.string().min(1).max(200), generation: z.number().int().min(0), missingResources: z.array(z.string().min(1).max(2048)).max(100),
}), { graph: false });

export function qaProviderWireContracts(): readonly ProviderWireContract[] {
  return ([
  builderCoverageOutput, workReportOutput, preflightOutput, initializationOutput,
  qaRecoveryOutput, remediationOutput, qaVerdictOutput, contractAcceptanceOutput,
  contractSegmentOutput, handoffAcceptanceOutput, draftOutput, assessmentOutput,
  challengeOutput, depthOutput,
] as OutputContract[]).flatMap(contract => {
  const register = (provider: "claude" | "codex") => {
    const wireSchema = (provider === "codex" ? projectCodexSchema(contract.jsonSchema) : contract.jsonSchema) as Record<string, unknown>;
    const schemaBytes = Buffer.byteLength(canonicalJson(wireSchema));
    return createProviderWireContract({
      canonical: contract, provider, profile: `${provider}-${contract.operation}-v2`, variant: "default", wireVersion: 2,
      wireSchema, maximumSchemaBytes: schemaBytes + 1024, maximumResponseBytes: Math.max(65_536, Math.min(1_000_000, schemaBytes * 16)),
      normalizerId: provider === "codex" ? "codex-optional-properties" : "identity", normalizerVersion: 1,
      normalize: value => provider === "codex" ? decodeCodexOptionalProperties(contract.jsonSchema, value) : value,
      guidanceId: `${contract.operation}-${provider}-v2`, guidance: `Return one native ${contract.operation} JSON envelope. Do not invent host identifiers or fields outside the selected schema.`,
    });
  };
  return [register("claude"), register("codex")];
});
}
