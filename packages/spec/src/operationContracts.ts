import { z } from "zod";
import { continuityDeltaV1Schema, ticketPopulationProposalV1Schema, structuredPlanProposalV1Schema, structuredSourceRequestSchema, riskNoteRepairProposalV1Schema, semanticResultV1Schema, qaRemediationProposalV1Schema, discoveryEnvelopeV1Schema, type TicketPopulationProposalV1Contract } from "./providerContracts.js";
import { createProviderWireContract, decodeCodexOptionalProperties, outputContract, jsonOutputContract, projectCodexSchema, registerProviderWireContract, type OutputContract } from "./structuredOutput.js";

const text = z.string().min(1).max(20_000);
const textOf = (max = 20_000) => z.string().min(1).max(max);
export const graphRequestWireSchema = z.strictObject({
  kind: z.literal("rafi_graph_request"), version: z.literal(1), requestId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
  operations: z.array(z.strictObject({ operation: z.enum(["status", "query", "node", "neighbors", "path", "impact"]),
    query: z.string().min(1).max(2000).optional(), seeds: z.array(z.string().min(1).max(2048)).max(16).optional(),
    target: z.string().min(1).max(2048).optional(), direction: z.enum(["incoming", "outgoing", "both"]).optional(), depth: z.number().int().min(0).max(5).optional(),
  })).min(1).max(4),
});
export const blockedResultSchema = z.strictObject({ kind: z.literal("blocked"), reason: text, nextAction: text });
export const questionResultSchema = z.strictObject({ kind: z.literal("needs-input"), question: text, choices: z.array(z.string().min(1).max(1000)).max(20) });
export const graphResultSchema = z.strictObject({ kind: z.literal("graph-request"), request: graphRequestWireSchema });
export const handoffResultSchema = z.strictObject({ kind: z.literal("handoff-request"), reason: text, roleState: z.strictObject({ summary: text }) });
export const sourceResultSchema = z.strictObject({ kind: z.literal("source-request"), requests: z.array(structuredSourceRequestSchema).min(1).max(10) });

/** The envelope is small; the host selects exactly one operation's payload. */
export function operationContract<T extends z.ZodType>(operation: string, payload: T, options: { sources?: boolean; graph?: boolean; handoff?: boolean; branchDependency?: boolean } = {}) {
  return outputContract(operation, z.strictObject({ version: z.literal(1), operation: z.literal(operation),
    result: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("completed"), summary: text, payload }), options.branchDependency ? blockedResultSchema.extend({ branchDependency: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/).optional() }) : blockedResultSchema, questionResultSchema,
      ...(options.handoff ? [handoffResultSchema] : []),
      ...(options.graph === false ? [] : [graphResultSchema]), ...(options.sources ? [sourceResultSchema] : []),
    ]),
    continuity: continuityDeltaV1Schema.nullable(),
  }));
}
// Approved preparation and documentation decisions belong to the plan owner.
// Do not ask another model to copy or reinterpret them on every population turn.
export const ticketPopulationDraftSchema = ticketPopulationProposalV1Schema.extend({
  tickets: z.array(ticketPopulationProposalV1Schema.shape.tickets.element.omit({ qa_preparation: true, documentation: true })).max(200),
});
export const ticketPopulationOutput = operationContract("ticket-population", ticketPopulationDraftSchema);
export const structuredPlanOutput = operationContract("structured-plan", structuredPlanProposalV1Schema, { sources: true });

// Codex's strict schema mode makes every optional property a required nullable
// field.  For a populated ticket plan that recursively inflates a tiny answer
// into an impractical response.  This reviewed wire profile has no provider
// placeholders: host-owned QA/documentation are absent, and the normalizer
// only removes the explicit null sentinels used for optional source labels.
const ticketPopulationCodexWire = z.strictObject({
  version: z.literal(1),
  operation: z.literal("ticket-population"),
  // A flat tagged wire record avoids Codex strict-mode's nested union/output
  // expansion. The normalizer reconstructs the canonical result union.
  kind: z.enum(["completed", "blocked", "needs-input"]),
  summary: text.nullable(),
  payload: z.strictObject({
      version: z.literal(1), plan_id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/), revision: z.number().int().min(1),
      tickets: z.array(z.strictObject({
        slice_ref: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/), title: textOf(500), area: textOf(500), priority: z.enum(["P0", "P1", "P2", "P3"]), size: z.enum(["XS", "S", "M", "L", "XL"]), risk: z.enum(["Low", "Medium", "High"]), summary: text,
        acceptance: z.array(text).max(200), required_tests: z.array(text).max(200), likely_files: z.array(textOf(1_000)).max(200), depends_on: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/)).max(200),
        rollback: z.string().max(20_000).nullable(), notes: text.nullable(),
        source_refs: z.array(z.strictObject({ source_id: z.string().regex(/^src_[A-Za-z0-9_-]{1,127}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), item: textOf(2_000).nullable(), url: z.string().url().nullable(), note: textOf(2_000).nullable() })).max(100),
      })).max(200), retirements: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/)).max(200),
  }).nullable(),
  reason: text.nullable(),
  nextAction: text.nullable(),
  question: text.nullable(),
  choices: z.array(z.string().min(1).max(1000)).max(20),
  continuity: z.null(),
});

function normalizeTicketPopulationCodexWire(value: unknown): OperationResponse<TicketPopulationProposalV1Contract> {
  const parsed = ticketPopulationCodexWire.parse(value);
  if (parsed.kind === "blocked") {
    if (parsed.reason === null || parsed.nextAction === null || parsed.summary !== null || parsed.payload !== null || parsed.question !== null || parsed.choices.length) throw new Error("Invalid blocked ticket-population wire result");
    return { version: 1, operation: "ticket-population", continuity: null, result: { kind: "blocked", reason: parsed.reason, nextAction: parsed.nextAction } };
  }
  if (parsed.kind === "needs-input") {
    if (parsed.question === null || parsed.summary !== null || parsed.payload !== null || parsed.reason !== null || parsed.nextAction !== null) throw new Error("Invalid needs-input ticket-population wire result");
    return { version: 1, operation: "ticket-population", continuity: null, result: { kind: "needs-input", question: parsed.question, choices: parsed.choices } };
  }
  if (parsed.summary === null || parsed.payload === null || parsed.reason !== null || parsed.nextAction !== null || parsed.question !== null || parsed.choices.length) throw new Error("Invalid completed ticket-population wire result");
  return {
    version: 1, operation: "ticket-population", continuity: null,
    result: {
      kind: "completed", summary: parsed.summary,
      payload: {
        ...parsed.payload,
        tickets: parsed.payload.tickets.map(ticket => ({
          ...ticket,
          source_refs: ticket.source_refs.map(source => ({
            source_id: source.source_id, fingerprint: source.fingerprint,
            ...(source.item === null ? {} : { item: source.item }), url: source.url, note: source.note,
          })),
        })),
      },
    },
  } as OperationResponse<TicketPopulationProposalV1Contract>;
}

export function operationJsonContract<T>(operation: string, payloadSchema: Record<string, unknown>, options: { sources?: boolean; graph?: boolean; handoff?: boolean; branchDependency?: boolean } = {}) {
  const envelope = structuredClone(operationContract(operation, z.null(), options).jsonSchema) as Record<string, any>;
  const completed = envelope.properties.result.oneOf.find((branch: any) => branch.properties.kind.const === "completed");
  const { $id: _id, ...payload } = payloadSchema;
  completed.properties.payload = payload;
  return jsonOutputContract<OperationResponse<T>>(operation, envelope);
}

export type OperationResponse<T = unknown> = {
  version: 1; operation: string; continuity: z.infer<typeof continuityDeltaV1Schema> | null;
  result: { kind: "completed"; summary: string; payload: T } | (z.infer<typeof blockedResultSchema> & { branchDependency?: string }) | z.infer<typeof questionResultSchema> |
    z.infer<typeof graphResultSchema> | z.infer<typeof sourceResultSchema> | z.infer<typeof handoffResultSchema>;
};

export const riskNoteRepairOutput = operationContract("risk-note-repair", riskNoteRepairProposalV1Schema);
export const semanticExtractionOutput = operationContract("graph-semantic-extraction", semanticResultV1Schema, { graph: false });
export const plannerRemediationOutput = operationContract("planner-remediation", qaRemediationProposalV1Schema);

// Native discovery has bounded, concrete fields. The historical report reader
// remains separate and can still inspect older heterogeneous observations.
export const discoveryOutput = operationContract("discovery", discoveryEnvelopeV1Schema.extend({
  likely_current_state: z.strictObject({ state: text, evidence: z.array(z.string().min(1).max(4000)).max(500) }),
  rafi_history_confidence: z.strictObject({ answer: text, confidence: z.enum(["low", "medium", "high"]), basis: text }),
  source_candidates: z.array(structuredSourceRequestSchema).max(500),
  excluded_or_avoided_resources: z.array(z.strictObject({ description: text, reason: text })).max(500),
}), { sources: true });

export const guidedRecoveryOutput = operationContract("guided-recovery", z.strictObject({ reconciled: z.literal(true) }));
export const branchAuditOutput = operationContract("branch-dependency-audit", z.strictObject({ dependencies: z.array(z.strictObject({
  ticket: z.string().min(1).max(256), dependsOn: z.string().min(1).max(256), reason: text,
})).max(1000) }));

/** Interpretation only; host preview, owned-path checks and approval authorize removal. */
export const uninstallProposalOutput = operationContract("uninstall-proposal", z.strictObject({
  operations: z.array(z.strictObject({ kind: z.enum(["keep", "delete", "edit", "remove-dependency"]), target: z.string().trim().min(1).max(4000), reason: z.string().trim().min(1).max(10000), confidence: z.enum(["high", "medium", "low"]) })).max(500),
  followUpQuestion: z.string().trim().min(1).max(4000).optional(),
}), { graph: false });

/**
 * These descriptors replace adapter-side schema derivation.  They are still
 * deliberately marked compatibility profiles until an operation has a
 * purpose-built wire shape; the registry makes that remaining work visible
 * and prevents an adapter from silently inventing a profile.
 */
function registerOperationWireProfiles(contract: OutputContract): void {
  if (contract === ticketPopulationOutput) {
    registerProviderWireContract(createProviderWireContract({
      canonical: contract, provider: "claude", profile: "claude-ticket-population-v1", variant: "default", wireVersion: 1,
      wireSchema: contract.jsonSchema, maximumSchemaBytes: 250_000, maximumResponseBytes: 1_000_000,
      normalizerId: "identity", normalizerVersion: 1, normalize: value => value,
      guidanceId: "ticket-population-v1", guidance: () => "Return one native ticket-population JSON envelope. Do not invent host identifiers, QA preparation, or documentation fields.",
    }));
    registerProviderWireContract(createProviderWireContract({
      canonical: contract, provider: "codex", profile: "codex-ticket-population-v1", variant: "default", wireVersion: 1,
      wireSchema: projectCodexSchema(z.toJSONSchema(ticketPopulationCodexWire, { target: "draft-7", io: "input" })) as Record<string, unknown>, maximumSchemaBytes: 250_000, maximumResponseBytes: 1_000_000,
      normalizerId: "ticket-population-codex-v1", normalizerVersion: 1, normalize: normalizeTicketPopulationCodexWire,
      guidanceId: "ticket-population-v1", guidance: () => "Return one flat ticket-population JSON record. Its root fields are version, operation, kind, summary, payload, reason, nextAction, question, choices, and continuity. kind is completed, blocked, or needs-input. For completed, provide summary and payload; for blocked, provide reason and nextAction; for needs-input, provide question and choices. Do not nest a canonical result envelope. Do not include QA/documentation fields or host identifiers.",
    }));
    return;
  }
  registerProviderWireContract(createProviderWireContract({
    canonical: contract, provider: "claude", profile: "claude-operation-compat-v1", variant: "default", wireVersion: 1,
    wireSchema: contract.jsonSchema, maximumSchemaBytes: 1_000_000, maximumResponseBytes: 2_000_000,
    normalizerId: "identity", normalizerVersion: 1, normalize: value => value,
    guidanceId: "operation-envelope-v1", guidance: () => "Return one native JSON operation envelope. Do not invent host identifiers or fields not requested by the selected schema.",
  }));
  registerProviderWireContract(createProviderWireContract({
    canonical: contract, provider: "codex", profile: "codex-operation-compat-v1", variant: "default", wireVersion: 1,
    wireSchema: projectCodexSchema(contract.jsonSchema) as Record<string, unknown>, maximumSchemaBytes: 1_000_000, maximumResponseBytes: 2_000_000,
    normalizerId: "codex-optional-properties", normalizerVersion: 1, normalize: value => decodeCodexOptionalProperties(contract.jsonSchema, value),
    guidanceId: "operation-envelope-v1", guidance: () => "Return one native JSON operation envelope. Do not invent host identifiers or fields not requested by the selected schema.",
  }));
}

[
  ticketPopulationOutput, structuredPlanOutput, riskNoteRepairOutput,
  semanticExtractionOutput, plannerRemediationOutput, discoveryOutput,
  guidedRecoveryOutput, branchAuditOutput, uninstallProposalOutput,
].forEach(registerOperationWireProfiles);
