import { Ajv } from "ajv";
/** Public graph protocols. Graph evidence is navigation, never execution authority. */
export const GRAPH_PROTOCOL_VERSION = 1 as const;
export const GRAPHIFY_VERSION = "0.9.82";
export const GRAPH_PURPOSES = ["planning", "planning-audit", "source-reconciliation", "qa-preparation", "preparation-assessment", "preparation-challenge", "build-preflight", "branch-dependency-audit", "implementation", "remediation", "manager-guidance", "final-qa", "qa-recovery", "guided-recovery", "manager-diagnosis", "discovery", "ticket-population", "uninstall-analysis", "native-investigation", "semantic-extraction"] as const;
export type GraphPurpose = typeof GRAPH_PURPOSES[number];
export type GraphFreshness = "matching" | "stale" | "historical" | "unknown";
export type GraphUseDecision = "disabled" | "inapplicable" | "available" | "used" | "unavailable" | "degraded";
export type GraphResultStatus = "ok" | "no-match" | "ambiguous" | "partial" | "empty-corpus" | "unavailable" | "invalid-request";
export interface GraphLimitsV1 {
  packetBytes: number;
  rounds: number;
  aggregateBytes: number;
  queryMs: number;
  inventoryMs: number;
  maxFiles: number;
  maxWords: number;
  maxInputBytes: number;
  maxGraphBytes: number;
  maintenanceMs: number;
  storageBytes: number;
  retainedEvidenceBytes: number;
  semanticInputs: number;
}
export const DEFAULT_GRAPH_LIMITS: Readonly<GraphLimitsV1> = Object.freeze({ packetBytes: 24 * 1024, rounds: 3, aggregateBytes: 96 * 1024, queryMs: 15000, inventoryMs: 30000, maxFiles: 500, maxWords: 2000000, maxInputBytes: 32 * 1024 * 1024, maxGraphBytes: 64 * 1024 * 1024, maintenanceMs: 300000, storageBytes: 2 * 1024 ** 3, retainedEvidenceBytes: 10 * 1024 ** 2, semanticInputs: 100 });
export interface GraphConfigV1 {
  version: 1;
  enabled: boolean;
  mode: "mixed" | "code-only";
  maintenance: "selective" | "manual";
  include: string[];
  exclude: string[];
  sourceIds: string[];
  sourceSelection?: "explicit" | "active-captured";
  sourceVersions?: Record<string, string>;
  limits?: Partial<GraphLimitsV1>;
}
export const DEFAULT_GRAPH_CONFIG: Readonly<GraphConfigV1> = Object.freeze({ version: 1, enabled: true, mode: "mixed", maintenance: "selective", include: ["**"], exclude: [], sourceIds: [], sourceSelection: "active-captured" });
export interface GraphAdoptionV1 {
  version: 1;
  projectRef: string;
  policyDigest: string;
  config: GraphConfigV1;
  acceptedAt: string;
  authorization: "setup" | "explicit";
  initialOperationId: string;
}
export interface GraphLimitationV1 {
  reason: string;
  detail: string;
  nextAction?: string;
  inputs?: string[];
}
export interface GraphSourceProvenanceV1 {
  classification: "registered-reference";
  authority: "reference-only; approval not inferred";
  label: string;
  sourceType: string;
  capturedAt: string;
}
export interface GraphSourceLocationV1 {
  provenance?: GraphSourceProvenanceV1;
  path: string;
  digest?: string;
  sourceId?: string;
  version?: string;
  line?: number;
  endLine?: number;
}
export interface GraphNodeV1 {
  id: string;
  label: string;
  kind?: string;
  sources: GraphSourceLocationV1[];
  origin: "structural" | "semantic" | "unknown";
}
export interface GraphEdgeV1 {
  source: string;
  target: string;
  relation: string;
  evidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" | "UNKNOWN";
  confidence?: number;
  sources: GraphSourceLocationV1[];
}
export interface GraphReadOperationV1 {
  operation: "status" | "query" | "node" | "neighbors" | "path" | "impact";
  query?: string;
  seeds?: string[];
  target?: string;
  direction?: "incoming" | "outgoing" | "both";
  depth?: number;
}
export interface GraphReadRequestV1 {
  kind: "rafi_graph_request";
  version: 1;
  requestId: string;
  operations: GraphReadOperationV1[];
}
export interface GraphSourceBindingV1 {
  version: 1;
  projectRef: string;
  workspaceRef: string;
  hostProjectRef?: string;
  hostWorkspaceRef?: string;
  sourceRef: string;
  corpusDigest: string;
  policyDigest: string;
}
export interface GraphInputV1 {
  provenance?: GraphSourceProvenanceV1;
  path: string;
  digest: string;
  bytes: number;
  mode: number;
  kind: "code" | "semantic";
  sourceId?: string;
  sourceVersion?: string;
}
export interface GraphGenerationV1 {
  version: 1;
  id: string;
  corpusDigest: string;
  policyDigest: string;
  graphDigest: string;
  binding: GraphSourceBindingV1;
  inputs: GraphInputV1[];
  createdAt: string;
  operationId: string;
  packageVersion: string;
  graphSchema: number;
  parent?: string;
  limitations: GraphLimitationV1[];
  files: Record<string, string>;
}
export interface GraphReadResultV1 {
  version: 1;
  status: GraphResultStatus;
  freshness: GraphFreshness;
  generationId?: string;
  corpusDigest?: string;
  sourceBinding?: GraphSourceBindingV1;
  nodes: GraphNodeV1[];
  edges: GraphEdgeV1[];
  limitations: GraphLimitationV1[];
  truncated: boolean;
  digest: string;
}
export interface GraphEvidenceRefV1 {
  version: 1;
  evidenceId: string;
  generationId: string;
  corpusDigest: string;
  sourceBinding: GraphSourceBindingV1;
  operationDigest: string;
  resultDigest: string;
  freshness: GraphFreshness;
  sourceLocations: GraphSourceLocationV1[];
  requirementRefs: string[];
  checkRefs: string[];
  limitations: GraphLimitationV1[];
}
export interface GraphUseContextV1 {
  version: 1;
  operationId: string;
  logicalTaskId: string;
  purpose: GraphPurpose;
  configRoot: string;
  workspace: string;
  /** Durable source workspace when workspace is a disposable review snapshot. */
  accessWorkspace?: string;
  sourceRef: string;
  runId?: string;
  workId?: string;
  contractRef?: {
    id: string;
    revision: number;
    digest: string;
  };
  reviewBasisRef?: string;
  hostWritesAllowed: boolean;
  qualifies: boolean;
  reason: string;
  seeds: string[];
}
export interface GraphDeliveryReceiptV1 {
  version: 1;
  operationId: string;
  logicalTaskId: string;
  purpose: GraphPurpose;
  sessionRef?: string;
  workspaceRef: string;
  decision: GraphUseDecision;
  packetDigest?: string;
  generationIds: string[];
  reason: string;
  deliveredAt: string;
}
export interface GraphExchangeV1 {
  version: 1;
  id: string;
  parentId: string;
  sessionRef?: string;
  rounds: number;
  bytes: number;
  state: "ready" | "request-received" | "read-completed" | "continuation-intended" | "completed" | "uncertain";
  requests: Record<string, {
    payloadDigest: string;
    packet: string;
  }>;
  finalTurnId?: string;
  /** Exact frozen action binding; older records without it require reconciliation. */
  bindingDigest?: string;
  authorityDigest?: string;
  pendingPrompt?: string;
  generationId?: string;
  terminalLimitationSent?: boolean;
  operations?: number;
  usageTotals?: { costUsd: number; numTurns: number; costAuthoritative: boolean; known: boolean; inputTokens: number; outputTokens: number };
}
const strings = { type: "array", maxItems: 512, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2048 } };
const limitMax: Record<keyof GraphLimitsV1, number> = { packetBytes: 65536, rounds: 12, aggregateBytes: 1048576, queryMs: 60000, inventoryMs: 120000, maxFiles: 100000, maxWords: 20000000, maxInputBytes: 536870912, maxGraphBytes: 268435456, maintenanceMs: 1200000, storageBytes: 10737418240, retainedEvidenceBytes: 104857600, semanticInputs: 1000 };
export const graphConfigSchema = {
  type: "object", additionalProperties: false,
  required: ["version", "enabled", "mode", "maintenance", "include", "exclude", "sourceIds"],
  properties: {
    version: { const: 1 }, enabled: { type: "boolean" }, mode: { enum: ["mixed", "code-only"] }, maintenance: { enum: ["selective", "manual"] }, include: strings, exclude: strings, sourceIds: strings, sourceSelection: { enum: ["explicit", "active-captured"] }, sourceVersions: { type: "object", maxProperties: 500, additionalProperties: { type: "string", minLength: 1, maxLength: 256 } },
    limits: { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.entries(limitMax).map(([k, maximum]) => [k, { type: "integer", minimum: 1, maximum }])) }
  },
};
export const graphReadRequestSchema = {
  type: "object", additionalProperties: false, required: ["kind", "version", "requestId", "operations"],
  properties: {
    kind: { const: "rafi_graph_request" }, version: { const: 1 }, requestId: { type: "string", pattern: "^[a-zA-Z0-9_.:-]{1,128}$" }, operations: {
      type: "array", minItems: 1, maxItems: 4, items: {
        type: "object", additionalProperties: false, required: ["operation"], properties: {
          operation: { enum: ["status", "query", "node", "neighbors", "path", "impact"] }, query: { type: "string", minLength: 1, maxLength: 2000 },
          seeds: { ...strings, maxItems: 16 }, target: { type: "string", minLength: 1, maxLength: 2048 }, direction: { enum: ["incoming", "outgoing", "both"] }, depth: { type: "integer", minimum: 0, maximum: 5 },
        }
      },
    }
  },
};
const ajv = new Ajv({ allErrors: true, strict: true });
const configValidator = ajv.compile<GraphConfigV1>(graphConfigSchema);
const requestValidator = ajv.compile<GraphReadRequestV1>(graphReadRequestSchema);
export function assertGraphConfig(value: unknown): asserts value is GraphConfigV1 {
  if (!configValidator(value))
    throw new Error(`Invalid graph configuration: ${ajv.errorsText(configValidator.errors)}`);
  for (const pattern of [...(value as GraphConfigV1).include, ...(value as GraphConfigV1).exclude]) {
    if (pattern.startsWith("/") || pattern.includes("\\") || pattern.split("/").includes("..") || /^[A-Za-z]:/.test(pattern))
      throw new Error("Graph patterns must be relative and confined to the project");
  }
}
export function assertGraphReadRequest(value: unknown): asserts value is GraphReadRequestV1 {
  if (!requestValidator(value))
    throw new Error(`Invalid graph request: ${ajv.errorsText(requestValidator.errors)}`);
  for (const op of (value as GraphReadRequestV1).operations) {
    if (op.operation === "query" && !op.query)
      throw new Error("query requires query text");
    if (["node", "neighbors", "path", "impact"].includes(op.operation) && !op.seeds?.length)
      throw new Error(`${op.operation} requires seeds`);
    if (op.operation === "path" && (!op.target || op.seeds?.length !== 1))
      throw new Error("path requires one seed and a target");
  }
}
/** Manager extension leaves the existing V1/V2 diagnostic envelopes intact. */
export interface ManagerGraphRequestV3 {
  kind: "manager_graph_evidence_request";
  version: 3;
  requestId: string;
  receiptId?: string;
  operations: GraphReadOperationV1[];
}
export const managerGraphRequestV3Schema = {
  ...graphReadRequestSchema,
  properties: {
    ...graphReadRequestSchema.properties,
    kind: { const: "manager_graph_evidence_request" },
    version: { const: 3 },
    receiptId: { type: "string", pattern: "^[a-zA-Z0-9_.:-]{1,256}$" },
  },
};
const managerGraphValidator = ajv.compile<ManagerGraphRequestV3>(managerGraphRequestV3Schema);
export function assertManagerGraphRequest(value: unknown): asserts value is ManagerGraphRequestV3 {
  if (!managerGraphValidator(value))
    throw new Error(`Invalid Manager graph request: ${ajv.errorsText(managerGraphValidator.errors)}`);
  const { receiptId: _, ...request } = value;
  assertGraphReadRequest({ ...request, kind: "rafi_graph_request", version: 1 });
}
