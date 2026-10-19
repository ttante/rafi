# Zod implementation plan

## Goal

Implement runtime contracts at Rafi's provider-generation boundaries so the
workflow is reliable from:

`rafi create -> plan -> tickets setup/populate -> validate -> queue -> start -> Builder -> independent QA -> completed build`

This plan follows `ZOD_GENERATION_CONTRACT_AUDIT.md` and
`ZOD_IMPLEMENTATION_HANDOFF.md`.

## Contract policy

- Add Zod where a provider boundary is parser-only, manually validated, or
  unchecked.
- Keep existing AJV schemas authoritative for established QA, graph, manager,
  and failure-report contracts.
- Do not maintain parallel Zod and AJV schemas for the same artifact unless the
  entire schema family is migrated together with parity tests.
- Define each new contract once with a version, strict object shape, bounded
  strings and arrays, explicit enums, and `z.infer` types.
- Generate provider-facing schema guidance and examples from the authoritative
  contract definition rather than maintaining a second hand-written shape.
- Parse immediately after marker extraction, then apply host-owned semantic
  checks before publication, mutation, dispatch, or durable acceptance.
- Providers must not supply IDs, paths, digests, timestamps, generations,
  authorization, acceptance state, or persistence decisions owned by Rafi.

## Phase 1: shared foundation

1. Add Zod as a shared runtime dependency with a pinned compatible version.
2. Create common helpers for:
   - strict objects and unknown-field rejection;
   - bounded text and array sizes;
   - version fields and discriminated unions;
   - marker-envelope extraction;
   - JSON-path validation errors;
   - safe repository-relative paths;
   - host-owned-field stripping and binding.
3. Establish one contract location for each boundary. Shared contracts belong in
   `packages/spec`; package-local contracts remain beside their parser.
4. Add a contract-to-prompt renderer so the provider instruction and parser use
   the same schema definition.

## Phase 2: P0 workflow protection

Implement and test these in this order:

### T2: ticket-population proposal

Define a strict versioned schema for
`RAFI_TICKET_POPULATION_PROPOSAL_START/END`, including plan identity, revision,
slice mapping, dependencies, acceptance, tests, file hints, risk, rollback,
notes, and retirements.

Parse before materialization. Preserve semantic checks for exact plan identity,
one-to-one slice mapping, retirements, dependencies, delivery, and required
rollback/mitigation for Medium and High risk.

### T3: risk-note repair proposal

Define a strict schema for `RAFI_RISK_NOTE_REPAIR_START/END` with an exact set
of ticket IDs and bounded non-empty rollback text.

Enforce atomic application and prohibit changes to IDs, dependencies,
acceptance, tests, risk, or unrelated ticket fields.

### P1: main structured plan

Define or wrap the strict `StructuredPlanProposalV1` contract and parse it at
the first extraction boundary.

Retain semantic validation for dependency graphs, slice references, source
fingerprints, previous-plan retention, current-branch constraints, and
host-owned IDs and delivery decisions.

### Q9: QA transport acknowledgements

Define versioned schemas for:

- `RAFI_QA_SEGMENT_START/END`;
- `RAFI_QA_ACCEPTANCE_START/END`.

Require exact host-supplied segment indexes, digests, work IDs, revisions, and
contract digests. Reject partial, stale, or provider-invented acknowledgements.

### U1: uninstall proposal

Define `UninstallProposalV1` and its operation union before parsing. Validate
repository confinement, prohibited Git/remote/root targets, duplicate targets,
operation authorization, and ambiguity requiring a follow-up question before
any mutation.

### D1/D2: discovery and source requests

Define strict versioned schemas for:

- the discovery report envelope;
- structured source requests, including legacy-line conversion.

Validate bounded item shapes, confidence values, safe paths, locator variants,
source-type requirements, and the distinction between a proposed source and a
source actually captured by the host.

## Phase 3: P1 QA and recovery

### Q1-Q8: retain AJV as the authoritative family

Do not add parallel Zod schemas for:

- QA depth decisions;
- QA preparation candidates;
- semantic assessments;
- approach challenges;
- contract coverage;
- QA failure reports;
- Builder QA-remediation reports.

Instead:

- preserve the existing AJV validators;
- add malformed-shape and semantic-invalid fixtures;
- test host-owned digest, identity, requirement, finding, and coverage binding;
- verify bounded correction and exhaustion behavior;
- ensure initial, retry, and recovery prompts use the same authoritative
  contract guidance.

### Q3: QA escalation request

Define the currently inline escalation object as a versioned contract. Validate
source-backed risk categories and references, while preventing the provider
from changing depth, scope, or authorization directly.

### Q10: interactive QA remediation proposal

Define `QaRemediationProposalV1` with bounded summary and instructions.

Bind it to the current ticket, QA history, source snapshot, and revision.
Treat it as a read-only proposal; only explicit operator approval authorizes a
new Builder turn.

### Q11: QA recovery acknowledgement

Keep the exact first-line acknowledgement grammar and canonical string
comparison. Introduce a typed parsed acknowledgement value object only after
line parsing, then validate packet digest, reviewed-state digest, required
resources, and continuity ordering.

### B2: Builder handoff request

Define a versioned request union and validate it before staging durable
handoffs. Host-owned generation, session identity, paths, and acceptance state
must never come from provider output.

### B3: branch-audit dependency report

Define a strict versioned dependency envelope and validate known selected
tickets, no self-edges, no duplicate edges, no cycles, and no scope expansion.

### M2: graph semantic extraction

Define the missing semantic extraction contract with strict node and edge
schemas, confidence vocabulary, source-file binding, unique IDs, and per-input
coverage. Validate it at `parseSemanticResult`, then retain host input-binding
checks.

## Phase 4: protocols and interaction

### P2: planning status and user-question protocol

Keep the hand-written line grammar for `STEP_STATUS` and conversation markers.
Define a shared discriminated union for the parsed result and validate required
fields, duplicate fields, final-line placement, and ticket identity after line
parsing.

### B1: continuity delta

Keep exact marker parsing and duplicate/malformed-record handling. Validate the
parsed `RAFI_CONTINUITY_DELTA` object with one shared schema afterward, while
retaining role-specific and host continuity rules.

### G1: grill audit verdict

Add a strict discriminated union for complete versus needs-user-input verdicts,
including bounded evidence and one-to-five questions. Preserve quality and
minimum-evidence refinements.

### S1: provider tool-question payloads

Define and validate the raw provider question payload before presenting it to a
user. Preserve safe filtering, provider limits, and cancellation behavior;
invalid input must be rejected rather than partially interpreted.

## Explicitly AJV-owned or parser-owned boundaries

These must be reviewed and tested but should not receive an independent Zod
copy:

- Q1-Q8 established QA schemas;
- M1 graph requests;
- M3 manager/provider evidence requests;
- M4 manager action requests;
- provider-native event streams and terminal output;
- GitHub/GitLab command responses;
- host-produced QA command-output excerpts;
- `RAFI_GRAPH_MAINTENANCE` exact-line recognition;
- generated tracker Markdown and `LLM_NEXT_QUEUE` sections;
- SQLite rows, workflow receipts, evidence journals, project configuration,
  ticket YAML, delivery YAML, and manifests.

If any of these are later migrated to Zod, migrate the complete schema family
and add AJV/Zod parity tests before switching authority.

## Validation and test requirements

Every new Zod contract requires:

- valid fixtures;
- malformed-shape fixtures;
- unknown-field rejection;
- string, array, and nesting bounds;
- semantically invalid fixtures;
- host-owned-field override/rejection tests;
- marker and extraction tests;
- prompt/schema round-trip tests;
- bounded correction-loop tests;
- actionable exhaustion/recovery tests.

P0/P1 tests must specifically cover truncated output, missing terminators,
missing continuity markers, relative versus absolute paths, provider-supplied
hashes or IDs, stale handoff generations, incomplete rollback plans, and
attempted scope expansion.

## Verification gate

Before calling the implementation complete:

1. Run spec, ai-foreman, and CLI typechecks.
2. Run focused contract tests and the full provider-free suite.
3. Re-run the repository boundary audit over `sendTurn`, `runRoleInstruction`,
   provider adapters, `JSON.parse`, unchecked casts, prompt builders, and all
   `RAFI_*` markers.
4. Map every result to a Zod contract, an AJV-owned contract, a parser-owned
   protocol, or an explicit non-target.
5. Run fresh disposable Claude and Codex journeys through Builder, independent
   QA, and independent fixture tests.
6. Report any provider or environment failure separately from contract defects.

No end-to-end success may be claimed unless Builder and independent QA both
complete and the fixture tests pass independently.

## Consultation rule

The contracts listed above are sufficiently defined to implement from the
audit. If implementation reveals a boundary whose allowed fields, authority,
mutation effect, or compatibility behavior cannot be determined from the
existing code and tests, stop at that boundary and ask for a decision before
adding a schema or guessing at provider semantics.
