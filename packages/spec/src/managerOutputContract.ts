import { z } from "zod";
import { operationContract, type OperationResponse } from "./operationContracts.js";
import { jsonOutputContract, registerCompatibilityProviderWireContracts } from "./structuredOutput.js";
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
for (const [kind, request] of [["run-evidence-request", z.toJSONSchema(requestV1, { target: "draft-7", io: "input" })], ["qa-evidence-request", managerEvidenceRequestV2Schema], ["graph-evidence-request", managerGraphRequestV3Schema]] as const) {
  schema.properties.result.oneOf.push({ type: "object", additionalProperties: false, required: ["kind", "request"], properties: { kind: { const: kind }, request } });
}
export type ManagerResponse = Omit<OperationResponse<{ answer: string }>, "result"> & { result:
  OperationResponse<{ answer: string }>["result"] |
  { kind: "run-evidence-request"; request: ManagerEvidenceRequestV1 } |
  { kind: "qa-evidence-request"; request: ManagerEvidenceRequestV2 } |
  { kind: "graph-evidence-request"; request: ManagerGraphRequestV3 } };
export const managerOutput = jsonOutputContract<ManagerResponse>("manager", schema);
registerCompatibilityProviderWireContracts(managerOutput, "manager");
