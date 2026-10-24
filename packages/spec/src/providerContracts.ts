import { z } from "zod";

const text = (max = 20_000) => z.string().trim().min(1).max(max);
const textList = (maxItems = 200, maxText = 20_000) => z.array(text(maxText)).max(maxItems);
const ref = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);
const qaLevel = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const sourceRef = z.strictObject({
  source_id: z.string().regex(/^src_[A-Za-z0-9_-]{1,127}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  item: text(2_000).optional(),
  url: text(4_000).url().nullable().optional(),
  note: text(2_000).nullable().optional(),
});
const workspaceRelativePath = z.string().trim().min(1).max(4_000).refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !normalized.split("/").includes("..") && !/^[A-Za-z]:\//.test(normalized);
}, "must be a workspace-relative path without parent traversal");
/** V2 verification intent is approved data, never shell prose. */
export const verificationApplicabilityV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("always") }),
  z.strictObject({ kind: z.literal("host-executable-available"), executable: z.enum(["pnpm", "npm", "yarn", "bun", "node", "python3", "pytest", "cargo", "go"]), expected: z.boolean(), phase: z.enum(["preimplementation", "postimplementation", "both"]) }),
]);
export const verificationMethodV2Schema = z.strictObject({
  kind: z.enum(["command", "procedure"]), argv: z.array(text(4_000)).min(1).max(32).optional(), steps: textList(32, 4_000).optional(), cwd: workspaceRelativePath,
  runtime: text(256), timeout_ms: z.number().int().min(1).max(3_600_000), expected_outcome: text(4_000),
}).superRefine((value, ctx) => {
  if (value.kind === "command" && !value.argv?.length) ctx.addIssue({ code: "custom", message: "command verification requires argv" });
  if (value.kind === "procedure" && !value.steps?.length) ctx.addIssue({ code: "custom", message: "procedure verification requires steps" });
});
export const verificationRequirementV2Schema = z.strictObject({
  id: ref, summary: text(4_000), timing: z.enum(["preimplementation", "postimplementation", "both"]), applicability: verificationApplicabilityV2Schema,
  methods: z.array(verificationMethodV2Schema).min(1).max(16), expected_evidence: textList(32, 4_000), depends_on: z.array(ref).max(64),
});
export type VerificationRequirementV2 = z.infer<typeof verificationRequirementV2Schema>;
const discoveryArtifact = z.strictObject({
  path: workspaceRelativePath,
  kind: z.enum(["file", "directory"]),
  bytes: z.number().int().nonnegative().max(1_000_000_000).optional(),
  reason: text(2_000),
});
const discoveryPriorReference = z.strictObject({
  path: workspaceRelativePath,
  status: z.enum(["current", "stale", "unknown"]).optional(),
  kind: z.enum(["file", "directory"]).optional(),
  title: text(500).optional(),
});

export const qaPreparationDepthDecisionZodSchema = z.strictObject({
  version: z.literal(1),
  decisionId: text(256),
  level: qaLevel,
  rationale: text(),
  riskFactors: z.array(z.strictObject({
    category: z.enum(["interaction", "compatibility", "state-transition", "external-dependency", "authorization", "security", "data-integrity", "migration", "concurrency", "recovery", "deployment", "architecture-uncertainty"]),
    rationale: text(),
    references: textList(50, 2_000),
  })).max(50),
  lowRisk: z.strictObject({ narrowBehavior: text(), understoodDependencies: text(), adequateVerification: text() }).optional(),
  policyVersion: z.literal("qa-preparation-v1"),
  plannerOperationId: text(256),
  plannerIdentity: text(256),
  timestamp: z.string().datetime(),
  minimumLevel: qaLevel,
  minimumReasons: textList(50, 2_000),
  predecessorDecisionId: text(256).optional(),
});
export const qaPreparationEscalationProposalV1Schema = z.strictObject({
  // Default keeps the pre-versioned escalation envelope backward compatible
  // while making the parsed contract explicitly versioned for new callers.
  version: z.literal(1).default(1),
  rationale: text(),
  riskFactors: z.array(z.strictObject({
    category: z.enum(["interaction", "compatibility", "state-transition", "external-dependency", "authorization", "security", "data-integrity", "migration", "concurrency", "recovery", "deployment", "architecture-uncertainty"]),
    rationale: text(), references: textList(50, 2_000),
  })).min(1).max(50),
});

const planSlice = z.strictObject({
  qa_preparation: qaPreparationDepthDecisionZodSchema.optional(),
  documentation: z.strictObject({ required: z.boolean(), targets: textList(100, 1_000), criteria: textList(100, 4_000) }).optional(),
  local_ref: ref,
  retains: ref.optional(),
  title: text(500),
  summary: text(),
  acceptance: textList(),
  required_tests: textList(),
  /** Absent only on historical V1 artifacts. New plans declare version 2. */
  verification_version: z.literal(2).optional(),
  verification_requirements: z.array(verificationRequirementV2Schema).min(1).max(200).optional(),
  likely_files: z.array(text(1_000)).max(200),
  depends_on: z.array(ref).max(200),
  source_refs: z.array(sourceRef).max(100).optional(),
});
const documentationTarget = text(1_000).refine(value => {
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !normalized.split("/").includes("..") && !/^[A-Za-z]:\//.test(normalized);
}, "must be a workspace-relative documentation path without parent traversal");
export const documentationPolicyV1ZodSchema = z.strictObject({ required: z.boolean(), targets: z.array(documentationTarget).max(100), criteria: textList(100, 4_000) });
export type DocumentationPolicyV1Contract = z.infer<typeof documentationPolicyV1ZodSchema>;

const deliveryUnit = z.strictObject({
  id: ref,
  slice_refs: z.array(ref).max(200),
  branch_mode: z.enum(["current", "per-ticket", "shared"]),
  completion: z.enum(["pr", "auto-merge", "direct-merge", "none"]),
  provider: z.enum(["auto", "github", "gitlab", "local"]),
  pr_ready: z.boolean(),
  merge_method: z.enum(["squash", "merge", "rebase"]),
  cleanup: z.boolean(),
  depends_on: z.array(ref).max(200),
  dependency_mode: z.enum(["combine", "wait", "stack"]),
});

export const structuredPlanProposalV1Schema = z.strictObject({
  version: z.literal(1),
  summary: text(),
  assumptions: textList(),
  implementation_changes: textList(),
  acceptance_criteria: textList(),
  test_plan: textList(),
  slices: z.array(planSlice).max(200),
  delivery_units: z.array(deliveryUnit).max(200),
  stacks: z.array(z.strictObject({ local_ref: ref, retains: ref.optional(), name: text(500), units: z.array(ref).min(1).max(5) })).max(200),
});

const populationTicket = z.strictObject({
  qa_preparation: qaPreparationDepthDecisionZodSchema.optional(),
  documentation: z.strictObject({ required: z.boolean(), targets: textList(100, 1_000), criteria: textList(100, 4_000) }).optional(),
  slice_ref: ref,
  // The provider may suggest queue order, but Rafi allocates durable ticket
  // order during materialization; accepting it remains useful for compatibility
  // without granting provider authority over the persisted value.
  order: z.number().int().min(0).max(1_000_000).optional(),
  title: text(500),
  area: text(500),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  size: z.enum(["XS", "S", "M", "L", "XL"]),
  risk: z.enum(["Low", "Medium", "High"]),
  summary: text(),
  acceptance: textList(),
  required_tests: textList(),
  likely_files: z.array(text(1_000)).max(200),
  depends_on: z.array(ref).max(200),
  // Presence is structural here; the risk validator owns the meaningful
  // non-whitespace requirement so repairable risk failures retain their
  // typed recovery path.
  rollback: z.string().max(20_000).nullable().optional(),
  notes: text().nullable().optional(),
  source_refs: z.array(sourceRef).max(100).optional(),
});

export const ticketPopulationProposalV1Schema = z.strictObject({
  version: z.literal(1),
  plan_id: ref,
  revision: z.number().int().min(1),
  tickets: z.array(populationTicket).max(60 * 150),
  retirements: z.array(ref).max(200),
});

export const riskNoteRepairProposalV1Schema = z.strictObject({
  version: z.literal(1),
  tickets: z.array(z.strictObject({ id: ref, rollback: text() })).max(200),
});

export const structuredSourceRequestSchema = z.strictObject({
  type: z.enum(["local", "url", "github", "gitlab", "linear", "jira"]).optional(),
  description: text(4_000).optional(),
  label: text(500).optional(),
  locator: z.strictObject({
    path: text(4_000).optional(), description: text(4_000).optional(), url: z.string().url().optional(), repository: text(1_000).optional(),
    mode: z.enum(["issue", "issues", "project", "board"]).optional(), issue: z.number().int().min(1).optional(), project: text(1_000).optional(),
    filters: z.record(text(500), text(2_000)).optional(), api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/).optional(), team_key: text(200).nullable().optional(), filter: text(2_000).nullable().optional(),
    site: z.string().url().optional(), email_env: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/).optional(), token_env: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/).optional(), jql: text(4_000).optional(),
  }).optional(),
});
export const qaSegmentAcknowledgementV1Schema = z.strictObject({ index: z.number().int().min(0).max(10_000), digest: z.string().regex(/^[a-f0-9]{64}$/), missingSections: z.array(text(500)).max(200) });
export const qaAcceptanceAcknowledgementV1Schema = z.strictObject({ workId: text(256), revision: z.number().int().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/), missingSections: z.array(text(500)).max(200) });
export const qaRecoveryAcknowledgementV1Schema = z.strictObject({ packet: z.string().regex(/^[a-f0-9]{64}$/), reviewed_state: z.string().regex(/^[a-f0-9]{64}$/), required_resources_read: z.literal("all") });
export const qaRemediationProposalV1Schema = z.strictObject({ summary: text(10_000), fix_instructions: textList(100, 10_000) });

export const continuityDeltaV1Schema = z.strictObject({
  version: z.literal(1),
  decisions: textList(500, 4_000), constraints: textList(500, 4_000), discoveries: textList(500, 4_000),
  completedActions: textList(500, 4_000), evidence: textList(500, 4_000), failures: textList(500, 4_000),
  blockers: textList(500, 4_000), openWork: textList(500, 4_000), nextAction: text(4_000),
});

export const builderHandoffRequestV1Schema = z.strictObject({
  version: z.literal(1), reason: text(2_000),
  decisions: textList(500, 4_000), constraints: textList(500, 4_000), discoveries: textList(500, 4_000),
  completed_actions: textList(500, 4_000), evidence: textList(500, 4_000), failures: textList(500, 4_000),
  blockers: textList(500, 4_000), open_work: textList(500, 4_000), next_action: text(4_000),
  role_state: z.record(z.string().max(256), z.unknown()),
});

export const discoveryEnvelopeV1Schema = z.strictObject({
  version: z.literal(1),
  detected_stack: z.strictObject({ frontend: text(500).optional(), backend: text(500).optional(), database: text(500).optional() }).optional(),
  discovered_artifacts: z.array(discoveryArtifact).max(500).optional(), likely_current_state: z.unknown().optional(),
  relevant_prior_plans_docs_tickets: z.array(discoveryPriorReference).max(500).optional(), rafi_history_confidence: z.unknown().optional(),
  recommended_next_command: text(4_000).optional(), source_candidates: z.array(z.unknown()).max(500).optional(),
  excluded_or_avoided_resources: z.array(z.unknown()).max(500).optional(), handoff_brief: text(20_000).optional(),
});

export const semanticResultV1Schema = z.strictObject({
  kind: z.literal("rafi_graph_semantic_result"), version: z.literal(1), operationId: text(256), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  nodes: z.array(z.strictObject({ id: text(512), label: text(2_000).optional(), source_file: text(4_000), kind: text(500).optional(), detail: text(4_000).optional() })).max(10_000),
  edges: z.array(z.strictObject({ source: text(512), target: text(512), confidence: z.enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"]), relation: text(1_000), source_file: text(4_000) })).max(20_000),
  origin: z.strictObject({ provider: text(256), model: text(512).optional(), operationId: text(256) }),
  inputTokens: z.number().int().nonnegative().max(100_000_000).optional(), outputTokens: z.number().int().nonnegative().max(100_000_000).optional(),
});

export const grillAuditQuestionV1Schema = z.strictObject({ id: ref, question: text(4_000), recommendation: text(4_000), rationale: text(8_000), alternatives: textList(3, 4_000) });
export const grillAuditVerdictV1Schema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("complete"), evidence: z.string().trim().min(20).max(20_000) }),
  z.strictObject({ status: z.literal("needs_user_input"), questions: z.array(grillAuditQuestionV1Schema).min(1).max(5) }),
]);

/**
 * The planner proposal is a provider-facing contract, not a ticket-runtime
 * implementation detail.  Keeping it here lets every consumer select the
 * same immutable provider descriptor before it starts a planning turn.
 */
const ticketPlanText = (max = 20_000) => z.string().trim().min(1).max(max);
const ticketPlanIdentifier = z.string().regex(/^[A-Za-z][A-Za-z0-9-_]{0,127}$/);
const ticketPlanSourceRef = z.strictObject({ source: ticketPlanText(500), item: ticketPlanText(2_000), source_id: ticketPlanIdentifier.optional(), url: z.string().url().nullable().optional(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), note: ticketPlanText(2_000).nullable().optional() });
const ticketPlanDefinition = z.strictObject({
  qa_preparation: qaPreparationDepthDecisionZodSchema.optional(), id: ticketPlanIdentifier, order: z.number().int().min(0),
  documentation: documentationPolicyV1ZodSchema.optional(), title: ticketPlanText(500), area: ticketPlanText(500), priority: z.enum(["P0", "P1", "P2", "P3"]), size: z.enum(["XS", "S", "M", "L", "XL"]), risk: z.enum(["Low", "Medium", "High"]),
  depends_on: z.array(ticketPlanIdentifier).max(200), summary: ticketPlanText(), acceptance: z.array(ticketPlanText()).min(1).max(200), required_tests: z.array(ticketPlanText()).min(1).max(200), likely_files: z.array(ticketPlanText(1_000)).max(200),
  rollback: z.string().max(20_000).nullable().optional(), notes: z.string().max(20_000).nullable().optional(),
  external_refs: z.array(z.strictObject({ provider: ticketPlanText(100), id: ticketPlanText(500), key: ticketPlanText(500).nullable().optional(), url: z.string().url().nullable().optional() })).max(100).optional(),
  source_refs: z.array(ticketPlanSourceRef).max(100).optional(), superseded_by: z.array(ticketPlanIdentifier).max(200).optional(), supersedes: z.array(ticketPlanIdentifier).max(200).optional(),
  plan_ref: z.strictObject({ plan_id: ticketPlanIdentifier, revision: z.number().int().min(1), slice_ref: ticketPlanIdentifier }).optional(),
});
const ticketPlanDelivery = z.strictObject({
  version: z.literal(1), plan: z.strictObject({ plan_id: ticketPlanIdentifier, revision: z.number().int().min(1) }).optional(),
  units: z.array(z.strictObject({ id: ticketPlanIdentifier, tickets: z.array(ticketPlanIdentifier).min(1).max(200), branch_mode: z.enum(["current", "per-ticket", "shared"]), completion: z.enum(["pr", "auto-merge", "direct-merge", "none"]).optional(), provider: z.enum(["auto", "github", "gitlab", "local"]).optional(), pr_ready: z.boolean().optional(), merge_method: z.enum(["squash", "merge", "rebase"]).optional(), cleanup: z.boolean().optional(), depends_on: z.array(ticketPlanIdentifier).max(200).optional(), dependency_mode: z.enum(["combine", "wait", "stack"]).optional() })).max(200),
  stacks: z.array(z.strictObject({ id: ticketPlanIdentifier, name: ticketPlanText(500), units: z.array(ticketPlanIdentifier).min(1).max(5), status: z.enum(["planned", "in_progress", "partial", "blocked", "awaiting_review", "merged"]).optional(), completed_prefix: z.array(ticketPlanIdentifier).max(5).optional(), next_ticket: ticketPlanIdentifier.optional(), review_links: z.array(z.string().url()).max(20).optional(), remote_checked_at: z.string().datetime().optional(), remote_stale: z.boolean().optional(), published_branches: z.record(ticketPlanIdentifier, ticketPlanText(500)).optional() })).max(200).optional(),
});
const ticketPlanDefaults = z.strictObject({
  branch_strategy: z.enum(["current", "batch", "branch-per-ticket"]).optional(), completion: z.enum(["pr", "auto-merge", "direct-merge", "none"]).optional(), provider: z.enum(["auto", "github", "gitlab", "local"]).optional(), pr_ready: z.boolean().optional(), merge_method: z.enum(["squash", "merge", "rebase"]).optional(), cleanup: z.boolean().optional(), auto_merge_wait: z.boolean().optional(), auto_merge_timeout_minutes: z.number().int().min(0).nullable().optional(), base_branch: ticketPlanText(500).optional(), branch_prefix: ticketPlanText(500).optional(), branch_policy: z.strictObject({ mode: z.enum(["global", "size"]), global_strategy: z.enum(["current", "batch", "branch-per-ticket"]), by_size: z.strictObject({ XS: z.enum(["shared", "per-ticket"]), S: z.enum(["shared", "per-ticket"]), M: z.enum(["shared", "per-ticket"]), L: z.enum(["shared", "per-ticket"]), XL: z.enum(["shared", "per-ticket"]) }) }).optional(), review: z.strictObject({ title_style: z.enum(["ticket-title", "conventional", "none", "custom"]), title_template: z.string().max(500).nullable(), description_sections: z.array(ticketPlanText(500)).max(50) }).optional(), validation_checklist: z.array(ticketPlanText(500)).max(100).optional(),
});
export const ticketPlanProposalV1Schema = z.strictObject({
  version: z.literal(1), title: ticketPlanText(500), markdown: ticketPlanText(100_000), additions: z.array(ticketPlanDefinition).max(200), edits: z.array(z.strictObject({ id: ticketPlanIdentifier, patch: ticketPlanDefinition.partial() })).max(200), supersessions: z.array(z.strictObject({ replaced: z.array(ticketPlanIdentifier).min(1).max(200), replacements: z.array(ticketPlanIdentifier).min(1).max(200), reason: ticketPlanText() })).max(200), state_changes: z.array(z.strictObject({ id: ticketPlanIdentifier, status: z.enum(["planned", "next", "in_progress", "blocked", "done", "canceled", "obsolete"]), reason: ticketPlanText() })).max(200), source_reconciliation: z.array(z.strictObject({ source: ticketPlanText(500), item: ticketPlanText(2_000), disposition: z.enum(["mapped", "split", "combined", "deferred", "excluded"]), ticket_ids: z.array(ticketPlanIdentifier).max(200), reason: ticketPlanText().optional() })).max(500), delivery: ticketPlanDelivery.nullable().optional(), build_defaults: ticketPlanDefaults.partial().nullable().optional(), future_work: z.array(z.strictObject({ id: z.number().int().min(0), disposition: z.enum(["accepted", "rejected", "merged", "queued"]) })).max(500), next: z.strictObject({ ticket_ids: z.array(ticketPlanIdentifier).max(200), replace_existing: z.boolean() }),
});

export const providerQuestionV1Schema = z.strictObject({
  question: text(4_000), header: text(500).optional(),
  options: z.array(z.strictObject({ label: text(2_000), description: text(4_000).optional(), preview: text(4_000).optional() })).max(200),
  multiSelect: z.boolean().default(false),
});

export type StructuredPlanProposalV1Contract = z.infer<typeof structuredPlanProposalV1Schema>;
export type TicketPopulationProposalV1Contract = z.infer<typeof ticketPopulationProposalV1Schema>;
export type RiskNoteRepairProposalV1Contract = z.infer<typeof riskNoteRepairProposalV1Schema>;
export type StructuredSourceRequestContract = z.infer<typeof structuredSourceRequestSchema>;
export type ContinuityDeltaV1Contract = z.infer<typeof continuityDeltaV1Schema>;
export type BuilderHandoffRequestV1Contract = z.infer<typeof builderHandoffRequestV1Schema>;
export type SemanticResultV1Contract = z.infer<typeof semanticResultV1Schema>;
export type GrillAuditQuestionV1Contract = z.infer<typeof grillAuditQuestionV1Schema>;
export type ProviderQuestionV1Contract = z.infer<typeof providerQuestionV1Schema>;

export function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "$"}: ${issue.message}`);
}

export function parseProviderContract<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${name} contract validation failed:\n${zodIssues(result.error).map((issue) => `- ${issue}`).join("\n")}`);
  return result.data;
}
