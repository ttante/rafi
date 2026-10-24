import { z } from "zod";
import { operationContract, type OperationResponse } from "./operationContracts.js";
import { canonicalJson, createProviderWireContract, decodeCodexOptionalProperties, jsonOutputContract, projectCodexSchema, type ProviderWireContract } from "./structuredOutput.js";
import { managerEvidenceRequestV2Schema } from "./schemas.js";
import { managerGraphRequestV3Schema, type ManagerGraphRequestV3 } from "./graph.js";
import type { ManagerEvidenceRequestV1, ManagerEvidenceRequestV2 } from "./types.js";

const id = z.string().min(1).max(1024);
const ids = z.array(id).max(100);
const metrics = z.enum(["calendarMs", "activeExecutionMs", "pausedOfflineMs", "explicitWaitMs", "attributedMs", "unattributedMs", "observedRetryMs", "reportedRetryDelayMs", "qaAttempts", "qaFailures", "fixes", "retries", "tools", "providerTurns", "waits", "executions", "inputTokens", "outputTokens", "totalTokens", "authoritativeCostUsd"]);
const filters = z.strictObject({ runIds: ids.optional(), statuses: ids.optional(), createdFrom: id.optional(), createdTo: id.optional(), completedFrom: id.optional(), completedTo: id.optional(), providers: z.array(z.enum(["claude", "codex"])).max(2).optional(), models: ids.optional(), branchModes: ids.optional(), qaEnabled: z.boolean().optional(), ticketIds: ids.optional(), detailLevels: z.array(z.enum(["detailed", "rollup", "legacy"])).max(3).optional() });
const aggregate = z.strictObject({ version: z.literal(1), filters: filters.optional(), groupBy: z.array(z.enum(["status", "provider", "model", "branchMode", "qaEnabled", "ticket", "detailLevel"])).max(7).optional(), metrics: z.array(metrics).max(20), operations: z.array(z.enum(["sum", "count", "minimum", "maximum", "average", "median", "p75", "p90"])).max(8) });
const requestV1 = z.strictObject({ version: z.literal(1), requestId: id, operations: z.array(z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_runs"), filters: filters.optional(), limit: z.number().int().min(1).max(1000).optional(), cursor: id.optional() }),
  z.strictObject({ kind: z.literal("get_run_details"), runIds: ids, maxSpans: z.number().int().min(1).max(1000).optional() }),
  z.strictObject({ kind: z.literal("aggregate_runs"), query: aggregate }),
  z.strictObject({ kind: z.literal("compare_runs"), runIds: ids, metrics: z.array(metrics).max(20) }),
])).min(1).max(6) });
const schema = structuredClone(operationContract("manager", z.strictObject({ answer: z.string().min(1).max(100_000) }), { graph: false }).jsonSchema) as Record<string, any>;
const evidenceRequests = {
  run: z.toJSONSchema(requestV1, { target: "draft-7", io: "input" }),
  qa: managerEvidenceRequestV2Schema,
  graph: managerGraphRequestV3Schema,
} as const;
schema.properties.result.oneOf.push({
  type: "object", additionalProperties: false, required: ["kind", "evidenceType", "request"],
  properties: { kind: { const: "evidence-request" }, evidenceType: { enum: ["run", "qa", "graph"] }, request: { anyOf: Object.values(evidenceRequests) } },
  // `anyOf` keeps the Codex wire projection representable. The conditional
  // clauses retain the canonical correlation between subtype and request.
  allOf: Object.entries(evidenceRequests).map(([evidenceType, request]) => ({
    if: { properties: { evidenceType: { const: evidenceType } } },
    then: { properties: { request } },
  })),
});
export type ManagerEvidenceRequestResult =
  | { kind: "evidence-request"; evidenceType: "run"; request: ManagerEvidenceRequestV1 }
  | { kind: "evidence-request"; evidenceType: "qa"; request: ManagerEvidenceRequestV2 }
  | { kind: "evidence-request"; evidenceType: "graph"; request: ManagerGraphRequestV3 };
export type ManagerResponse = Omit<OperationResponse<{ answer: string }>, "result"> & { result:
  OperationResponse<{ answer: string }>["result"] | ManagerEvidenceRequestResult };
export const managerOutput = jsonOutputContract<ManagerResponse>("manager", schema);
export function managerProviderWireContracts(): readonly ProviderWireContract[] {
  return (["claude", "codex"] as const).map(provider => {
  const wireSchema = (provider === "codex" ? projectCodexSchema(managerOutput.jsonSchema) : managerOutput.jsonSchema) as Record<string, unknown>;
  const schemaBytes = Buffer.byteLength(canonicalJson(wireSchema));
  return createProviderWireContract({
    canonical: managerOutput, provider, profile: `${provider}-manager-v2`, variant: "default", wireVersion: 2,
    wireSchema, maximumSchemaBytes: schemaBytes + 1024, maximumResponseBytes: Math.max(65_536, Math.min(1_000_000, schemaBytes * 16)),
    normalizerId: provider === "codex" ? "codex-optional-properties" : "identity", normalizerVersion: 1,
    normalize: value => provider === "codex" ? decodeCodexOptionalProperties(managerOutput.jsonSchema, value) : value,
    guidanceId: `manager-${provider}-v2`, guidance: "Return one native manager JSON envelope. Do not invent host identifiers or fields outside the selected schema.",
  });
});
}
