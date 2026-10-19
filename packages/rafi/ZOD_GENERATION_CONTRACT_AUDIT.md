# Rafi provider-generation contract and Zod audit

## Purpose and scope

This is a source-level inventory of every place in the Rafi workflow where a
provider (Claude, Codex, or a provider-backed helper session) is asked to
generate structured data, a protocol response, or a machine-readable request.
It covers the CLI package, `ai-foreman`, and the shared `rafi-spec` package
because the CLI only orchestrates several of the actual generation boundaries.

The audit asks three questions for each boundary:

1. Is the contract already represented in TypeScript, or does its content need
   to be defined first?
2. Is there already runtime validation (JSON Schema/Ajv or a hand-written
   parser), or would Zod add a missing runtime boundary?
3. Does the provider instruction explicitly tell the agent how to use the
   contract, including what is host-owned and what it must not invent?

This is an audit and adoption plan, not an implementation of Zod. It is
deliberately conservative: Zod is useful at provider boundaries, but adding a
second validator beside an already authoritative Ajv schema would create two
contracts that can drift.

## Recommendation in one paragraph

Rafi should have one runtime-validation layer for provider artifacts. Because
the repository is TypeScript, Zod is a good implementation for new and
provider-facing schemas. The existing `rafi-spec` JSON Schemas are already
authoritative for several QA and graph artifacts; either keep Ajv as the
single validator for those artifacts or migrate each schema completely to Zod
and derive JSON Schema from it. Do not maintain both independently. In either
case, every provider response should be parsed at the first boundary, checked
against the shape and semantic bindings, and either repaired with a bounded
correction turn or rejected with the exact path and expected value.

The repository currently has no Zod dependency. `rafi-spec` already owns the
shared JSON Schemas and uses Ajv, so the first implementation decision is
architectural: either (a) add Zod only for the currently manual/unchecked
provider boundaries while explicitly keeping Ajv for the established shared
schemas, or (b) migrate the shared schema family in one coordinated change.
Option (a) is the lower-risk path for the E2E workflow; option (b) is cleaner
long term but should not be mixed incrementally without generated-schema and
parity tests.

## Status vocabulary

- **New contract**: the TypeScript shape is absent or too loose; define the
  contract before writing a validator.
- **TS exists**: an interface/type exists, but compile-time types do not protect
  the runtime provider boundary.
- **Schema exists**: an Ajv/JSON Schema or equivalent runtime validator exists;
  Zod is optional only as a migration/consolidation choice.
- **Parser only**: the code recognizes markers or parses JSON but does not
  validate the complete object.
- **Semantic validation**: shape validation is insufficient; host-owned values,
  cross-references, digests, completeness, and authorization must be checked
  after parsing.
- **Instruction status**: whether the current prompt tells the receiving agent
  exactly what to emit and what it must leave to Rafi.

## Complete generation-boundary inventory

### D1. Create/discovery report envelope

**Code:** `packages/rafi/src/discovery.ts` (`DiscoveryEnvelope`,
`extractDiscoveryEnvelope`, `buildDiscoveryInstruction`).

**Generated contract:** one `RAFI_DISCOVERY_REPORT_START/END` JSON object with
stack detection, discovered artifacts, current state, prior plans/docs/tickets,
history confidence, source candidates, avoided resources, handoff brief, and a
recommended next command.

**Contract content:** TypeScript exists, but it is intentionally loose:
several fields are `unknown[]`/`unknown` and optional. The actual content is not
defined tightly enough for reliable downstream use. Define a versioned
`DiscoveryEnvelopeV1` contract, including item shapes, bounded strings/arrays,
allowed confidence values, safe relative-path rules, and whether a next command
is advisory text or an executable command.

**Runtime validation:** parser currently checks marker placement and JSON shape
only; it casts with `as DiscoveryEnvelope`. Add a strict Zod schema (or a
fully equivalent Ajv schema) at `extractDiscoveryEnvelope`. Keep the existing
fallback report behavior, but make fallback explicit when validation fails.

**Agent instruction:** partially present. `buildDiscoveryInstruction` tells the
provider to emit the envelope, but it does not give a strict field-by-field
schema, limits, or host-owned-field rules. Add the exact schema/example and
state that source persistence, source IDs, snapshots, and the recommended next
command are host decisions. The agent must not claim a source was captured when
it only suggested one.

### D2. Discovery source-request envelope

**Code:** `packages/ai-foreman/src/sources/sourceRegistry.ts`
(`StructuredSourceRequest`, `extractSourceRequests`); prompts in
`packages/rafi/src/discovery.ts` and `packages/rafi/src/ticketPlan.ts`.

**Generated contract:** one or more `RAFI_SOURCE_REQUEST_START/END` JSON
objects/arrays, with a legacy `SOURCE_REQUEST:` line still accepted.

**Contract content:** `StructuredSourceRequest` exists, but the extractor
accepts arbitrary objects and casts them. The exact allowed locator variants,
required fields by source type, and mutually exclusive fields need to be
defined in a versioned schema.

**Runtime validation:** parser only. Add strict validation for each request,
including URL/path/repository locator safety, supported source types, and
description requirements. Preserve legacy-line compatibility by converting it
into the same validated shape.

**Agent instruction:** present but incomplete. Prompts explain when to request
sources and show the markers, but need the exact request schema and explicit
instruction that requests are proposals, not proof of access or capture.

### P1. Main planning structured proposal

**Code:** `packages/rafi/src/structuredPlan.ts`
(`StructuredPlanProposalV1`, `extractStructuredPlanProposal`,
`validateStructuredPlanProposal`) and `packages/rafi/src/plan.ts`.

**Generated contract:** `RAFI_PLAN_PROPOSAL_START/END`, containing summary,
assumptions, implementation changes, acceptance criteria, test plan, slices,
delivery units, stacks, source references, and optional QA-depth decisions.

**Contract content:** fully represented in TypeScript and in the persisted
`rafi-spec` types (`StructuredPlanV1`). The content is defined. The manual
validator already expresses many cross-field rules: unique refs, dependency
references, assignment, stack limits, and enum values.

**Runtime validation:** manual validation plus JSON parsing. This is a high
priority Zod candidate. Replace or wrap the hand-written field checks with a
strict schema, then retain semantic refinements for dependency graphs,
previous-plan retention, source fingerprints, and current-branch constraints.
Do not use Zod alone for those cross-object rules.

**Agent instruction:** strong but duplicated in multiple prompts. The planner
gets the envelope, shape, marker, host-controlled workflow decisions, and
status-marker instructions. Consolidate this into one generated contract
instruction so revisions cannot diverge. State that `local_ref` is provider
chosen, final IDs are host allocated, and delivery/branch policy is host
validated.

### P2. Planning status and user-question protocol

**Code:** `packages/rafi/src/plan.ts` (`parsePlannerStepStatus`),
`packages/rafi/src/ticketPlan.ts` (`parseConversationMarker`), and the shared
`STEP_STATUS` parsing in `ai-foreman`.

**Generated contract:** plain-text `STEP_STATUS` with quoted key/value fields;
`plan_complete`, `blocked`, `needs_input`, and question/choice fields.

**Contract content:** the allowed status and fields are defined in parsers and
prompts, but not as a single typed contract. Define a shared discriminated
union for the parsed status and a single escaping grammar.

**Runtime validation:** hand-written parser is appropriate for the line
protocol; Zod should validate the parser's resulting object, not replace the
line grammar. Add checks for required fields per status, duplicate fields,
final-line placement, and ticket identity.

**Agent instruction:** generally present, but the same rules are repeated in
many correction prompts. Generate the status contract from one source and tell
the provider that status is not JSON and must be the final non-empty line.

### G1. Independent grill-me audit verdict

**Code:** `packages/rafi/src/grillAudit.ts`
(`GrillAuditVerdict`, `parseGrillAuditVerdict`,
`buildGrillAuditInstruction`).

**Generated contract:** `RAFI_GRILL_AUDIT_START/END`, either
`{status:"complete", evidence}` or
`{status:"needs_user_input", questions:[...]}`.

**Contract content:** TypeScript union exists and the parser manually validates
most fields and question count. Content is defined.

**Runtime validation:** parser only. Add a strict Zod discriminated union for
the envelope and question items; retain the minimum evidence-length and
question-quality refinements. This is a small, high-value migration.

**Agent instruction:** explicit and good: one fresh read-only turn, no tools,
no Markdown, exact envelope, one-to-five questions. Add the strict schema and
state that the auditor cannot change the candidate or make product decisions.

### T1. Ticket-planning proposal

**Code:** `packages/ai-foreman/src/ticketPlanning.ts`
(`TicketPlanProposal`, `extractTicketPlanProposal`,
`validateTicketPlanProposal`).

**Generated contract:** `RAFI_PROPOSAL_START/END`, containing additions, edits,
supersessions, state changes, source reconciliation, delivery, build defaults,
future-work dispositions, and next-ticket selection.

**Contract content:** TypeScript interface and a substantial manual validator
exist. The content is defined, including cross-ticket and existing-ticket
semantics.

**Runtime validation:** high-priority Zod candidate. Add strict nested schemas
for `TicketDef`/patches and the proposal, then retain semantic refinements for
IDs, staged ticket validity, dependency cycles, source provenance, future-work
existence, and delivery validation. This proposal can mutate tracker state, so
no unchecked cast may survive the extraction boundary.

**Agent instruction:** present in the ticket-planning prompt, including marker
and approval-only behavior. It should additionally state that IDs, state
transitions, and persistence are host-owned; the planner proposes them but
cannot claim they were applied.

### T2. Ticket-population proposal

**Code:** `packages/ai-foreman/src/ticketPopulation.ts` and
`packages/ai-foreman/src/cli/tickets.ts`.

**Generated contract:** `RAFI_TICKET_POPULATION_PROPOSAL_START/END`, with plan
identity, revision, one ticket slice per approved slice, dependencies,
acceptance/tests/file hints, risk, rollback, notes, and retirements.

**Contract content:** TypeScript interfaces exist (`TicketSliceProposal`,
`TicketPopulationProposalV1`) and semantic validation exists. The exact ticket
field enums are defined in `TicketDef`/ticket schema. Content is defined.

**Runtime validation:** extraction currently only does `JSON.parse` and casts;
validation happens later. Add strict Zod parsing immediately after extraction,
then run existing plan-identity, one-to-one mapping, retirement, risk-plan,
dependency, and delivery refinements. This is P0 because malformed population
data was the original user-facing failure.

**Agent instruction:** strong and recently improved. `buildPopulateInstruction`
lists all fields, exact plan identity, mapping rules, and the concrete
Medium/High rollback requirement. Keep it, but generate it from the schema and
repeat that `rollback` is required while `notes` cannot substitute. The agent
must not allocate final ticket IDs or write files.

### T3. Risk-note repair proposal

**Code:** `packages/ai-foreman/src/cli/tickets.ts`
(`RiskNoteRepairProposal`, `extractRiskNoteRepairProposal`,
`applyRiskNoteRepairProposal`).

**Generated contract:** `RAFI_RISK_NOTE_REPAIR_START/END`, version and an exact
set of ticket IDs with concrete rollback strings.

**Contract content:** TypeScript interface exists; allowed content is narrow and
well understood. Define a strict schema with non-empty bounded rollback text and
unique IDs.

**Runtime validation:** extraction currently casts parsed JSON; the apply path
checks exact target IDs and validates the resulting ticket set. Add Zod at
extraction, then retain exact-target and atomic-apply checks.

**Agent instruction:** explicit and good: only rollback fields may change,
exact IDs are required, and the result must be complete. Add the schema and
explicitly prohibit changing risk, dependencies, acceptance, or IDs.

### Q1. QA depth decision

**Code:** `packages/spec/src/qaPreparation.ts`,
`packages/spec/src/qaPreparationSchemas.ts`, and
`packages/ai-foreman/src/qaPreparation.ts`.

**Generated contract:** `RAFI_QA_DEPTH_START/END`, with level, minimum level,
rationale, minimum reasons, risk factors, policy version, decision ID, and
optional low-risk evidence.

**Contract content:** TypeScript interface and an existing JSON Schema plus
`validateDepthDecision` exist. Content is defined.

**Runtime validation:** Ajv/hand-written semantic validation already works.
Do not add an independent Zod schema. Either keep Ajv as the authoritative
validator or migrate this schema once to Zod and derive JSON Schema. Add
bounded correction diagnostics for missing risk-category reasons; that semantic
rule cannot be expressed by shape alone.

**Agent instruction:** present and recently strengthened. The planner receives
the schema, host risk minimums, and exact category-copy rule. Keep explicit
“read-only QA planning; do not implement” wording. The provider does know the
contract, but live failures show it can still emit the wrong kind of response;
the parser/correction loop remains mandatory.

### Q2. QA preparation candidate/draft

**Code:** `packages/spec/src/qaPreparationSchemas.ts`,
`packages/ai-foreman/src/qaPreparation.ts`, and
`qaVerificationContract.ts`.

**Generated contract:** `RAFI_QA_CANDIDATE_START/END`. The provider supplies
checks, coverage, baseline observations, preparation evidence, and unresolved
concerns; Rafi owns identity, requirements, timestamps, digests, and bindings.

**Contract content:** complete TypeScript interfaces and existing JSON Schemas
(`QaContractCandidateV1`, provider draft schema) exist. Content is defined.

**Runtime validation:** Ajv provider-draft validation plus extensive semantic
validation already exists. This is not a “write another Zod schema” task. Pick
one validator source. If migrating, preserve host-owned-field stripping,
inventory completeness, requirement/check references, timing rules, baseline
rules, evidence paths, and no-agent-disposition rules as refinements.

**Agent instruction:** unusually strong and explicit: five provider fields only,
no identity/digests, exact requirement IDs, relative cwd, truthful timing,
individual obligations, and no waivers. Keep it generated from the schema and
include a short example of a valid check. The receiving agent knows the
contract; malformed Codex responses demonstrate that validation/correction,
not more prose alone, is required.

### Q3. QA escalation request

**Code:** `packages/ai-foreman/src/qaPreparation.ts` and
`packages/spec/src/qaPreparation.ts`.

**Generated contract:** optional `RAFI_QA_ESCALATION_START/END` with rationale
and risk factors when the provider believes the selected depth is insufficient.

**Contract content:** currently an inline object shape and reuse of the depth
decision risk-factor type, not a separately exported versioned interface.
Define `QaPreparationEscalationV1` explicitly.

**Runtime validation:** currently parsed with the generic preparation parser
and then used as a partial object. Add strict schema validation plus checks
that categories/references are source-backed and that the provider cannot
raise depth directly or alter scope.

**Agent instruction:** present but inline and less clear than the main depth
prompt. Add a dedicated schema/example and say escalation is a request to the
host, not an authorization or a new scope decision.

### Q4. Independent QA semantic assessment

**Code:** `packages/spec/src/qaPreparationSchemas.ts` and
`packages/ai-foreman/src/qaPreparation.ts`.

**Generated contract:** `RAFI_QA_ASSESSMENT_START/END`, with binding fields,
assessed requirement IDs/obligations, concerns, operation/session IDs, and
host-computed digests.

**Contract content:** TypeScript and JSON Schema exist (`QaSemanticAssessmentV1`).
Content is defined.

**Runtime validation:** Ajv plus host normalization and semantic binding checks
already exist. Do not duplicate with Zod unless the entire QA schema family is
migrated. The host must overwrite/verify all identity, policy, inventory, and
draft digest fields.

**Agent instruction:** explicit schema and exact binding are supplied. Add a
clear prohibition on inventing requirement IDs or digests and require every
obligation to be listed separately.

### Q5. Independent approach challenge receipt

**Code:** same QA preparation schema family and `qaPreparation.ts`.

**Generated contract:** `RAFI_QA_CHALLENGE_START/END`, extending assessment
with approach, concern categories, and approach concerns.

**Contract content:** TypeScript and JSON Schema exist
(`QaChallengeReceiptV1`). Content is defined.

**Runtime validation:** existing Ajv plus semantic binding checks. No parallel
Zod schema; migrate consistently with Q4 if desired.

**Agent instruction:** present and explicit that the assessor critiques rather
than authors a replacement. Add exact category vocabulary and host-owned
metadata rules.

### Q6. Builder/QA contract coverage

**Code:** `packages/spec/src/qaPreparationSchemas.ts`,
`packages/ai-foreman/src/qaContractCoverage.ts`, and
`qaBuilderCoverage.ts`.

**Generated contract:** `RAFI_QA_COVERAGE_START/END`, with phase, contract and
source digests, attempt/session identity, per-check applicability/outcome,
predicate evidence, and retained evidence references.

**Contract content:** TypeScript and JSON Schema exist
(`QaContractCoverageV1`). Content is defined.

**Runtime validation:** Ajv/schema validation plus strict host binding and
coverage completeness checks already exist. This is a high-risk boundary but
not a reason to add a second Zod schema. The current Codex invalid-requirement
coverage failure is exactly the kind of semantic error that shape validation
cannot solve; retain exact requirement/check set comparison.

**Agent instruction:** `COVERAGE_INSTRUCTIONS` is strong and unusually
specific. Keep it authoritative and include the exact host-supplied binding
object. The provider knows what to do, but must not be trusted to invent
requirements, IDs, digests, or evidence.

### Q7. QA failure report

**Code:** `packages/spec/src/qaFailureReport.ts`, `schemas.ts`, `validate.ts`,
and `packages/ai-foreman/src/qaReview.ts`/`qaFailureDelivery.ts`.

**Generated contract:** `RAFI_QA_FAILURE_REPORT_START/END` with every check,
findings, observations, blocking state, and the final QA status marker.

**Contract content:** TypeScript, JSON Schema, and parser/semantic validators
exist (`QaFailureReportV1`). Content is defined.

**Runtime validation:** Ajv and strict envelope/status parsing already exist.
Keep one authoritative validator; do not add an uncoordinated Zod copy.

**Agent instruction:** present in QA prompts, including “report only; do not fix
on this turn,” envelope ordering, and complete finding coverage. Add the schema
example to all correction prompts, not only the initial QA prompt.

### Q8. Builder QA-remediation report

**Code:** `packages/spec/src/qaFailureReport.ts`, `schemas.ts`, `validate.ts`,
`packages/ai-foreman/src/qaFailureDelivery.ts`, and `qaReview.ts`.

**Generated contract:** `RAFI_BUILDER_QA_REMEDIATION_START/END`, V2/V3 report
with fixed/disputed/blocked finding coverage, changes, evidence, verification,
and status.

**Contract content:** TypeScript and JSON Schema exist, including V3. Content
is defined.

**Runtime validation:** existing strict parser, Ajv, exact finding coverage,
handoff/generation binding, and semantic blocked/fixed rules. Keep one validator
source; Zod migration is optional, not additive.

**Agent instruction:** explicit in `qaFailureDelivery.ts`, including no scope
expansion, exact findings, truthful evidence, and status semantics. Ensure the
same generated contract is used in initial, retry, and recovery prompts.

### Q10. Interactive QA-nonconvergence remediation proposal

**Code:** `packages/ai-foreman/src/cli/start.ts` (the
`RAFI_QA_REMEDIATION_START/END` prompt and parser used after the operator
chooses Planner remediation).

**Generated contract:** `{summary:string, fix_instructions:string[]}`. This is
distinct from the Builder's QA-remediation report: it is a read-only Planner's
proposal for a human to approve before a new Builder turn.

**Contract content:** no exported interface or versioned schema exists; the
shape is an inline cast with two ad hoc checks. Define
`QaRemediationProposalV1`, including non-empty bounded summary, one or more
bounded instructions, and an explicit version.

**Runtime validation:** currently `JSON.parse` plus `summary`/array checks.
Add strict Zod parsing, reject unknown fields, enforce size limits, and bind
the proposal to the current ticket, QA history, source snapshot, and revision
before displaying it for approval. The proposal must never authorize a broader
scope by itself.

**Agent instruction:** present but incomplete. The prompt says read-only Planner
and gives the envelope, but it should include the formal schema, prohibit
implementation/tool use, require evidence-linked instructions, and state that
the operator approval—not the agent response—authorizes a new Builder turn.

### Q9. QA contract transport acknowledgements

**Code:** `packages/ai-foreman/src/qaContractDelivery.ts`.

**Generated contract:** `RAFI_QA_SEGMENT_START/END` and
`RAFI_QA_ACCEPTANCE_START/END` acknowledgements containing segment index/digest
or work ID/revision/contract digest/missing sections.

**Contract content:** currently inline object types at parse sites. Define
versioned `QaSegmentAcknowledgementV1` and `QaAcceptanceAcknowledgementV1`.

**Runtime validation:** generic `parsePreparationArtifact<T>` plus manual field
comparisons. Add strict schemas and exact expected digest/revision checks. This
is a small P0 hardening item because acceptance gates Builder admission.

**Agent instruction:** present and includes exact expected values. Add explicit
“copy host values exactly; do not summarize or accept partial content” wording
and provide the schema as a generated example.

### Q11. QA recovery-packet acknowledgement

**Code:** `packages/ai-foreman/src/qaRecovery.ts`
(`RAFI_QA_RECOVERY_ACK` and `validateRecoveryAcknowledgement`).

**Generated contract:** the first non-empty line must be the exact host-bound
acknowledgement containing the recovery packet digest, reviewed-state digest,
and `required_resources_read="all"`; the next line is the continuity record.

**Contract content:** the protocol is defined by the exact string assembled from
the packet manifest, but there is no exported typed contract. Define a small
`QaRecoveryAcknowledgementV1` value object and a canonical renderer/parser.
The digest values remain host-owned and must never be accepted from an
unbound packet.

**Runtime validation:** exact string comparison plus continuity parsing already
provides strong validation. Zod is not useful for the line grammar itself; it
can validate the parsed fields after the canonical parser is introduced.

**Agent instruction:** explicit in the recovery prompt. Keep the instruction
that the acknowledgement must be the first line, contain no extra text, and
be followed by exactly one continuity record. Add a regression test for stale
packet/reviewed-state values and duplicate acknowledgement lines.

### B1. Continuity delta

**Code:** `packages/ai-foreman/src/continuity.ts`.

**Generated contract:** a single-line `RAFI_CONTINUITY_DELTA` JSON record with
version, decisions, constraints, discoveries, completed actions, evidence,
failures, blockers, open work, and next action.

**Contract content:** `ContinuityDelta` exists in TypeScript and semantic
validation exists in `parseContinuityDelta`. Content is defined.

**Runtime validation:** hand-written parser/validator is appropriate and
already handles marker placement, duplicate/malformed records, and role rules.
Add Zod only after parsing the single line, if desired; do not replace the
continuity protocol grammar with raw JSON parsing.

**Agent instruction:** explicit through `continuityInstruction`, including
role-specific QA rules and separation from `STEP_STATUS`. Keep one shared
instruction; correction prompts must repeat it.

### B2. Builder handoff request

**Code:** `packages/ai-foreman/src/handoffs.ts`
(`BuilderHandoffRequest`, `parseBuilderHandoffRequest`).

**Generated contract:** provider asks to hand off/recover/continue with ticket,
reason, and related context; the host creates durable handoff records.

**Contract content:** TypeScript exists, but inspect the parser's accepted
legacy forms and define one versioned request union with exact required fields.

**Runtime validation:** currently marker/field parsing and host checks. Add Zod
to validate the parsed request before a durable handoff is staged. Host owns
generation, session identity, paths, and acceptance state.

**Agent instruction:** handoff protocol text exists and says what acceptance
does not certify. Add the exact request schema and prohibit claiming that a
handoff was accepted; only the host can accept it.

### B3. Builder branch-audit dependency report

**Code:** `packages/ai-foreman/src/branch/planner.ts`
(`AuditDependency`, `parseAuditDependencies`) and audit prompt in
`cli/start.ts`.

**Generated contract:** dependency edges inferred during a branch audit.

**Contract content:** `AuditDependency` exists, but the output parser and
cross-ticket validity are loose. Define a versioned array/object envelope,
including allowed ticket-ID syntax and a bounded reason.

**Runtime validation:** parser only plus later filtering. Add strict schema and
semantic checks: known selected tickets, no self edges, no cycles, no duplicate
edges, and no authority to expand the selected scope.

**Agent instruction:** currently asks for audit dependencies but does not
consistently show a formal JSON contract. Add exact marker/schema and state
that the audit is advisory input to host planning, not permission to select
additional tickets.

### M1. Graph evidence request

**Code:** `packages/rafi/src` graph callers and
`packages/ai-foreman/src/graph/turn.ts`, `graph/manager.ts`, `rafi-spec/src/graph.ts`.

**Generated contract:** `rafi_graph_request` JSON with operation ID, request
ID, query operations, and bounded options.

**Contract content:** TypeScript, JSON Schema, Ajv assertions, and manager
variants already exist. Content is defined.

**Runtime validation:** existing `assertGraphReadRequest`/strict JSON handling
is the authoritative boundary. Do not add a second Zod schema. If migrating,
migrate all graph request variants together.

**Agent instruction:** `GRAPH_REQUEST_GUIDANCE` is explicit about when graph
evidence qualifies, exact JSON, no tools, and source-backed uncertainty. Keep
it; add a concise schema example to manager-specific prompts too.

### M2. Graph semantic extraction result

**Code:** `packages/ai-foreman/src/graph/semantic.ts` and `graph/host.ts`.

**Generated contract:** strict JSON `rafi_graph_semantic_result` with operation
ID, input digest, nodes, edges, and provider/model origin.

**Contract content:** TypeScript interfaces exist, but there is no complete
JSON Schema for nodes/edges/semantic extraction. Define `SemanticExtractionV1`
and nested node/edge schemas, including confidence vocabulary, source-file
binding, unique IDs, and per-input coverage.

**Runtime validation:** currently `parseStrictJson` plus a few envelope checks;
node/edge content is not fully validated. Add Zod (or an equivalent Ajv schema)
at `parseSemanticResult`, then retain input coverage and source-binding checks.

**Agent instruction:** `SEMANTIC_INSTRUCTIONS` is explicit and safety-focused,
but the nested schema is prose. Include the formal schema and require every
input chunk to have attributable output or an explicit omission/error.

### M3. Manager/provider evidence request

**Code:** `packages/ai-foreman/src/managerEvidence.ts`,
`projectDiagnostics.ts`, and `cli/manager.ts`.

**Generated contract:** manager asks provider to return evidence-request JSON
for scoped runs, QA evidence, diagnostics, cursors, and artifact handles.

**Contract content:** V1/V2 TypeScript types and JSON Schemas exist in
`rafi-spec`; parsing calls the Ajv validator. Content is defined.

**Runtime validation:** existing Ajv is authoritative. No parallel Zod copy.
Audit every provider-facing correction prompt to ensure it references the same
V2 schema, and keep host scope/authorization checks after validation.

**Agent instruction:** manager prompts explain request formats, but some legacy
paths accept natural-language fallback. Mark fallback as untrusted and route
all structured requests through the V2 schema before execution.

### M4. Manager action request

**Code:** `packages/ai-foreman/src/buildInterventions.ts` and
`cli/manager.ts`.

**Generated contract:** slash/action commands become a typed action request
with request ID, expected revision, operation, and scope.

**Contract content:** `ManagerActionRequestV1` and JSON Schema exist. This is
mostly user-generated rather than provider-generated, but it crosses a durable
control boundary and belongs in the audit.

**Runtime validation:** existing Ajv plus revision/scope checks. No new Zod
schema unless the shared spec validator is migrated.

**Agent instruction:** not applicable for normal user commands; manager-agent
prompts that emit actions must be explicit that an action is a proposal and
requires host authorization/revision validation.

### U1. Uninstall proposal

**Code:** `packages/rafi/src/uninstall.ts`.

**Generated contract:** one JSON object with `operations` (`keep`, `delete`,
`edit`, `remove-dependency`), repository-relative target, reason, confidence,
and optional follow-up question.

**Contract content:** no exported TypeScript interface or versioned schema was
found; the shape is embedded only in the prompt and downstream ad hoc parsing.
Define `UninstallProposalV1` and operation unions first.

**Runtime validation:** add strict Zod parsing, then semantic checks for
repository confinement, prohibited Git/remote/root targets, operation
authorization, duplicate targets, and ambiguity requiring follow-up.

**Agent instruction:** current prompt is clear about read-only behavior and
allowed fields, but it needs the formal schema, explicit `version`, and a
statement that confidence does not authorize mutation. This is P0 because the
proposal can lead to destructive actions.

### S1. Provider tool question payloads

**Code:** `packages/ai-foreman/src/providerQuestions.ts`.

**Generated contract:** provider-native `AskUserQuestion` tool input with
questions, options, multi-select, answers, and annotations.

**Contract content:** TypeScript interfaces exist for the normalized question,
but the raw provider payload is `Record<string, unknown>` and is filtered
manually. Define a strict raw request schema with required question/options
fields and provider limits.

**Runtime validation:** add Zod parsing before presenting any prompt. Preserve
the current safe filtering and cancellation behavior; invalid input should be
denied with a useful message, not silently partially interpreted.

**Agent instruction:** native tool schema is supplied by Claude/Codex rather
than Rafi's text prompt. Add compiled generated guidance where possible and
keep the grill-me qualification rules separate from generic questions.

## Deliberately not Zod targets

These are not provider-generated contracts and should not receive a new Zod
layer merely because they contain JSON:

- SQLite rows, workflow receipts, observation journals, and retained evidence;
  validate them at database/state boundaries with existing versioned readers.
- Project YAML/JSON configuration, ticket YAML, delivery YAML, and generated
  manifests; these already have project/ticket schemas and are host-owned.
- Provider-native event streams and terminal output; parse the adapter protocol
  and use typed normalized events, not a model-output Zod contract.
- GitHub/GitLab CLI responses; use narrow API response validators at the
  integration boundary if needed, but they are external command/API contracts,
  not Rafi agent-generation contracts.
- Plain `STEP_STATUS` and continuity marker grammar; retain dedicated parsers,
  optionally feeding their parsed objects into Zod afterward.
- `RAFI_QA_COMMAND_OUTPUT_EXCERPTS` and other QA evidence summaries; these are
  host-selected, bounded observations from the observability store, not agent
  proposals. Validate their host-produced shape where they are serialized, but
  do not ask a provider to satisfy that contract.
- `RAFI_GRAPH_MAINTENANCE: meaningful-indexed-change`; this is an optional
  single-line provider signal consumed only when the host also observes source
  changes. Keep exact-line recognition and host-side gating; Zod adds no value
  to the marker itself.
- `LLM_NEXT_QUEUE` and the other generated progress-document sections; these
  are host-rendered Markdown (or, in legacy mode, an operational document with
  a textual agent editing protocol). Add marker/row-count/parser tests rather
  than forcing Markdown into a Zod object. The host should remain the writer in
  the normal generated-tracker mode.

## Priority order

### P0: protect the create → plan → populate → start path

1. Ticket population proposal (T2).
2. Risk-note repair proposal (T3).
3. Main structured plan (P1).
4. QA transport acknowledgements (Q9).
5. Uninstall proposal (U1) if uninstall is in the release surface.
6. Discovery envelope/source requests (D1/D2), because create depends on them.

### P1: protect independent QA and recovery

1. Consolidate the existing QA Ajv schemas rather than adding duplicate Zod
   definitions (Q1–Q8).
2. Add semantic validation tests for requirement coverage, host-owned digests,
   finding coverage, and exact handoff bindings.
3. Add handoff and branch-audit request schemas (B2/B3).
4. Add semantic extraction validation (M2).

### P2: management and interaction hardening

1. Grill audit (G1).
2. Provider question payloads (S1).
3. Manager request paths (M3/M4) if the shared validator is migrated.

## Contract/instruction design rules for implementation

1. Define each schema once, with a version and a stable marker/tag.
2. Generate the provider prompt's schema/example from that definition; do not
   hand-maintain a second shape string.
3. Mark every field as provider-authored, host-authored, or derived. Provider
   responses must not supply IDs, digests, timestamps, generations, paths, or
   dispositions that Rafi owns.
4. Parse and validate before any materialization, publication, dispatch,
   mutation, or durable acceptance.
5. Separate shape validation from semantic validation. Zod can express many
   refinements, but dependency graphs, exact requirement sets, digest binding,
   source confinement, and authorization still require host logic.
6. On recoverable format errors, issue a bounded response-only correction with
   exact paths and expected values. Never “repair” substantive coverage by
   inventing evidence or IDs.
7. On exhaustion, report the provider contract failure with the artifact and
   exact next action. Do not silently fall back to an unchecked cast.
8. Add one malformed-response test and one semantically invalid-response test
   for every P0/P1 boundary, plus a live Claude and Codex canary for the
   create-to-independent-QA path.

## Bottom line

There are more than a dozen genuinely provider-generated JSON contracts and a
similar number of marker/protocol contracts. The biggest immediate gap is not
“Rafi has no types”; most important contracts already have TypeScript types.
The gap is that some types are only compile-time, several extractors cast raw
JSON, and prompts are duplicated or weaker than the validators. Adopt Zod for
the unvalidated/new boundaries, especially ticket population, risk repair,
plan, discovery, uninstall, and semantic graph extraction. For the established
QA/graph schemas, choose one authoritative runtime system—currently Ajv—and
do not create parallel Zod definitions unless the migration is complete.
