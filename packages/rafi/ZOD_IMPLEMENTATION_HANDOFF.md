# Zod contract implementation handoff

## Mission

Implement runtime contracts for every Rafi provider-generation boundary so the
real workflow is reliable:

`rafi create -> plan -> tickets setup/populate -> validate -> queue -> start -> Builder -> independent QA -> completed build`

The source-level inventory is in
[`ZOD_GENERATION_CONTRACT_AUDIT.md`](./ZOD_GENERATION_CONTRACT_AUDIT.md). Read
that file completely before changing code. This handoff is the execution brief;
the audit is the authoritative boundary inventory.

## Current repository state

The worktree is intentionally dirty with substantial pre-existing changes in
`packages/ai-foreman`, `packages/spec`, `packages/rafi`, docs, and tests. Do not
reset, clean, or overwrite unrelated changes. The audit document itself is an
untracked file from this effort. Use focused diffs and preserve all existing
work.

The repository currently has no Zod dependency. `packages/spec` already owns
shared JSON Schemas validated with AJV. Do not create two independently
authoritative contracts. Use this lower-risk policy unless a complete migration
is justified and tested:

1. Add Zod for new/manual/unchecked provider boundaries.
2. Keep existing AJV schemas authoritative where they already cover a shared
   artifact, or migrate that whole schema family in one coordinated change.
3. Never let TypeScript casts (`as SomeType`) substitute for runtime parsing.

## Implementation order

### P0: protect the primary workflow

Implement and test these first:

1. Main structured plan (`src/structuredPlan.ts`, `src/plan.ts`): define a
   versioned strict contract; validate immediately after extraction; preserve
   host-owned fields and semantic checks.
2. Ticket-planning proposal (`packages/ai-foreman/src/ticketPlanning.ts`).
3. Ticket-population proposal (`packages/ai-foreman/src/ticketPopulation.ts`,
   `packages/ai-foreman/src/cli/tickets.ts`). Validate IDs, dependencies,
   risk, rollback/mitigation, acceptance/tests, file hints, notes, and
   retirements before materialization.
4. Risk-note repair proposal (`packages/ai-foreman/src/cli/tickets.ts`). It
   may update only missing risk-plan fields; IDs, dependencies, acceptance,
   and unrelated content must be immutable.
5. Discovery report and source-request envelopes
   (`packages/rafi/src/discovery.ts`,
   `packages/ai-foreman/src/sources/sourceRegistry.ts`).
6. QA transport acknowledgements, especially
   `RAFI_QA_SEGMENT`, `RAFI_QA_ACCEPTANCE`, and
   `RAFI_QA_RECOVERY_ACK`. These are admission/acceptance gates and must reject
   malformed or stale acknowledgements rather than silently continuing.
7. Uninstall proposal (`packages/ai-foreman/src/uninstall.ts` or current
   implementation location), if it remains a public mutation path.

For each P0 boundary: define or reuse one contract, generate the exact
provider instruction from that contract, parse at the first boundary, perform
semantic/host-binding validation, and use bounded correction or an actionable
failure before mutation.

### P1: QA and recovery

Do not duplicate the already-established AJV schemas. Consolidate or wrap the
existing runtime validators and add semantic tests for:

- QA depth decision, preparation candidate/draft, escalation request;
- QA semantic assessment, approach challenge, coverage report;
- QA failure report and Builder remediation report;
- interactive QA non-convergence remediation proposal;
- continuity delta and Builder handoff request;
- Builder branch-audit dependency report;
- graph evidence request and semantic extraction result.

The audit names exact source locations and current validation status for each.

### P2: management and interaction

Harden manager/provider evidence requests and action requests, grill audit
verdicts, and provider-native question payloads after P0/P1 are stable.

## Contract design requirements

- Prefer strict, versioned objects with bounded arrays/strings and explicit
  enums.
- Distinguish provider-generated fields from host-owned fields. Providers must
  not invent IDs, paths, digests, snapshots, acceptance state, permissions, or
  source persistence decisions.
- Validate shape first, then semantic bindings (cross-references, digests,
  completeness, authorization, current run/session identity).
- Parse before any file, ticket, branch, state, or publication mutation.
- On repairable provider defects, issue at most a small bounded correction loop;
  on exhaustion, give an actionable recovery menu. Never weaken validation to
  hide malformed output.
- Error messages must identify the contract, JSON path, expected value, and a
  concrete next command or recovery action.
- Keep marker/protocol parsers where they are the right abstraction; Zod may
  validate the parsed payload, but do not replace exact line grammar with a
  broad object schema.

## Explicit non-targets

Do not add Zod merely because data is structured. The audit deliberately
classifies these as other validation responsibilities:

- SQLite/workflow receipts/evidence and project/ticket YAML/config/manifests;
- provider-native event streams and GitHub/GitLab CLI responses;
- free-form Builder implementation prose and `STEP_STATUS` line grammar;
- host-selected bounded `RAFI_QA_COMMAND_OUTPUT_EXCERPTS` evidence;
- the host-gated `RAFI_GRAPH_MAINTENANCE: meaningful-indexed-change` signal;
- generated Markdown tracker sections and `LLM_NEXT_QUEUE` markers.

These still need their existing parsers, schemas, marker tests, or semantic
checks. They should not acquire a second, misleading Zod contract.

## Required tests and acceptance gate

For every P0/P1 boundary add both malformed-shape and semantically-invalid
tests, plus instruction/round-trip tests proving the provider receives the
same contract the parser enforces. Preserve existing AJV parity tests where
AJV remains authoritative.

Run the normal package tests and focused CLI/ai-foreman/spec tests. Then run
disposable real-provider canaries for both Claude and Codex covering the full
workflow through independent QA and completed build. A canary that stops at
population, Builder admission, or QA preparation is not an end-to-end pass.

Report separately:

- unit/integration results;
- Claude canary result;
- Codex canary result;
- any provider/environment failure that is not an obvious code defect;
- contracts intentionally left AJV/parser-owned and why.

Do not claim the workflow is fixed unless Builder and independent QA both
complete for the provider being reported.

## Useful audit checklist

The audit inventory must remain covered: D1/D2, P1/P2, G1, T1/T2/T3,
Q1–Q11, B1–B3, M1–M4, U1, and S1. In particular, do not miss the late-found
QA recovery acknowledgement (`RAFI_QA_RECOVERY_ACK`) or the interactive QA
remediation proposal. Before declaring the audit complete, re-run a repository
search over `sendTurn`, `runRoleInstruction`, `runRole`, provider adapters,
`JSON.parse`, `as SomeType`, prompt builders, and all `RAFI_*` markers and map
every result to either a contract or an explicit non-target above.

## Working agreement

Make obvious fixes directly. If implementation requires choosing between
incompatible contract authorities, expanding disclosure/retention of provider
output, or changing user-facing safety semantics, stop and consult the user
with the exact alternatives and affected files. Keep independent QA meaningful;
never waive, fabricate, or truncate evidence and call it complete.
