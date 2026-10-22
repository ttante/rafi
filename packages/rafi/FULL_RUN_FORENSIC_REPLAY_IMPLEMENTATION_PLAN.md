# Full-Run Forensic Replay and Debugging Implementation Plan

This plan implements `FULL_RUN_FORENSIC_REPLAY_REQUIREMENTS.md` against the
current Rafi and ai-foreman codebase.

## 1. Fixed product decisions

This feature is new; no compatibility aliases or legacy mode migration are
required.

The public capture levels are exactly:

- `none`: no optional diagnostic capture. Safety-critical records required for
  build correctness remain.
- `normal`: timing, counts, digests, structured spans, bounded metadata, and
  rollups. Raw provider/tool payloads are not retained.
- `detailed`: full replay capture, including exact provider prompts and
  responses, structured provider messages, complete tool inputs and outputs,
  snapshots, and replay inputs.

All three levels retain data indefinitely. Rafi never automatically deletes
diagnostic data because of age or database size. Storage pressure may cause
optional future writes to be recorded as omitted, but must never delete
existing evidence, block a build, or change build behavior.

Explicit operator commands are the only deletion path.

The command family is `rafi stats`:

```text
rafi stats show
rafi stats timeline
rafi stats compare
rafi stats export
rafi stats replay
rafi stats delete
```

`rafi audit` remains the existing bounded compatibility report and is not the
primary interface for full playback or replay.

## 2. Current implementation baseline

The codebase already provides a useful foundation:

- `packages/ai-foreman/src/observability.ts` owns SQLite observability storage,
  spans, events, monotonic duration calculation, resource samples, summaries,
  and read-only readers.
- `packages/spec/src/types.ts` contains versioned span, run summary, diagnostic,
  evidence, QA, handoff, and replay-adjacent contracts.
- Claude and Codex adapters expose provider turns, tool events, lifecycle
  traces, session identity, compaction, retries, and `TurnResult` metadata.
- QA preparation, contracts, evidence, reviews, handoffs, recovery packets, and
  source snapshots already persist content digests in their own stores.
- `packages/rafi/src/audit.ts` provides bounded run selection and report export.
- E2E and recovery tests cover many lifecycle boundaries but do not yet force
  or verify full replay capture.

The existing system is not sufficient because spans are mutable projections,
payloads are mostly bounded or digest-only, snapshots are not a unified
point-in-time record, retention is currently bounded, and playback/replay APIs
do not exist.

## 3. Workstream A — versioned contracts

Update:

- `packages/spec/src/types.ts`
- `packages/spec/src/schemas.ts`
- `packages/spec/src/validate.ts`
- `packages/spec/src/index.ts`
- `packages/spec/test/*`

Add versioned contracts for:

- `ObservabilityLevelV1` with only `none | normal | detailed`.
- Capture configuration, retention policy, capability status, and omission
  reasons.
- Immutable forensic event records.
- Immutable span start and span completion records.
- Content-addressed payload references and metadata.
- Point-in-time state snapshots.
- Replay requests, replay execution records, replay results, environment
  differences, and nondeterminism declarations.
- Stable timeline and visualization export records.
- Expanded run outcome categories that distinguish QA findings, failed QA
  attempts, terminal rejection, provider/runtime failure, host validation
  failure, approval pause, cancellation, and incomplete completion.

Span contracts must include schema version, stable IDs, run/execution/span
identity, ticket and delivery-unit identity, role, provider/model/session/turn
identity, phase and operation, wall-clock timestamps, monotonic timestamps,
outcome, completion certainty, input/output/state references, failure
classification, and resource references.

Event contracts must include immutable payload or payload reference, payload
digest, actor/authority, causal parent or predecessor, and whether the fact was
observed, intended, accepted, rejected, or inferred.

Do not put raw conversation content in `ManagerRunSummaryV1`. Keep summaries as
sanitized projections and add explicit references to detailed evidence where
needed.

## 4. Workstream B — append-only local storage

Refactor `packages/ai-foreman/src/observability.ts`, adding focused modules as
needed:

- `forensicStore.ts` for append-only event/span journal operations.
- `forensicPayloads.ts` for content-addressed payloads.
- `forensicSnapshots.ts` for immutable snapshots.
- `forensicReader.ts` for timeline, graph, comparison, and export queries.

Keep the existing `ObservabilityStore`, `RunObserver`, and
`ObservabilityReader` APIs where they remain useful, but make their tables
projections over the new canonical records rather than the source of truth.

Use local project storage:

```text
.rafi/observability.sqlite3
.rafi/forensic/payloads/<sha256>
.rafi/forensic/snapshots/<sha256>
.rafi/forensic/exports/<operator-created-export>
```

Required storage behavior:

- append-only journal records with immutable digests;
- atomic payload writes using temporary files and rename;
- SQLite WAL and crash-safe transaction boundaries;
- deduplicated payloads and snapshots by digest;
- indexes by run, execution, span, phase, ticket, role, provider, and time;
- incomplete spans marked `unknown`/`abandoned` after restart;
- schema migrations with backward-compatible readers for records created
  during the feature rollout;
- all diagnostic failures isolated from build state and recovery state;
- generated storage ignored by Git and excluded from package artifacts.

Replace current automatic age pruning, hard-limit row deletion, and detail
demotion in `enforceLimits`. Storage maintenance may compress data, report
capacity, or record an omission, but must not delete or silently downgrade
existing data. Add an explicit deletion service that verifies run scope,
requires an operator confirmation token, journals the deletion, and removes
payloads only when no retained record references them.

## 5. Workstream C — capture levels and configuration

Update:

- `packages/ai-foreman/src/observability.ts`
- `packages/ai-foreman/src/config.ts`
- `packages/ai-foreman/src/cli/start.ts`
- `packages/ai-foreman/test/observabilityMode.test.ts`
- configuration and CLI documentation/tests

Implement only `none`, `normal`, and `detailed` in configuration, CLI flags,
environment selection, and persisted run metadata.

Recommended controls:

- `--audit-logging <none|normal|detailed>`
- `RAFI_AUDIT_LOGGING=<none|normal|detailed>`
- `observability.mode` with the same three values in `foreman.yaml`

`normal` records structured metadata and bounded display projections. `detailed`
records complete payloads locally and marks the run as sensitive. Every run
records the selected level, whether it was forced, retention policy, capture
capabilities, and missing sources.

Configuration must not retain the old retention-day and automatic-pruning
settings as active behavior. If capacity settings remain, they can only govern
queue limits and omission reporting, never deletion.

## 6. Workstream D — provider and tool capture

Update:

- `packages/ai-foreman/src/adapters/types.ts`
- `packages/ai-foreman/src/adapters/claude.ts`
- `packages/ai-foreman/src/adapters/codex.ts`
- `packages/ai-foreman/src/adapters/recovering.ts`
- `packages/ai-foreman/src/agentRun.ts`
- `packages/ai-foreman/src/sessionLifecycle.ts`
- `packages/ai-foreman/src/providerPhase.ts`

Use the existing adapter event boundaries as the capture seam. Record:

- provider and SDK/runtime identity;
- session creation, initialization, resume, reconnect, compaction, retry, and
  close;
- exact host instruction and provider-dispatched instruction;
- exact raw and cleaned responses;
- structured provider items and provider errors;
- usage, token, cost, exit, and transport metadata;
- provider-reported tool calls and result messages;
- tool name, invocation ID, exact input, permission decision, cwd, environment
  identity, stdout, stderr, exit status, signal, timeout, and observable file
  effects.

At `normal`, retain digests, bounded summaries, and lifecycle metadata. At
`detailed`, write complete payloads and link them from spans/events. Provider
claims must remain separate from host-owned source state, hashes, authority,
and acceptance state.

## 7. Workstream E — lifecycle instrumentation

Add root and child spans/events across the complete lifecycle:

- project discovery, creation, configuration resolution, interview, grill, and
  plan revisions;
- ticket setup, population, normalization, validation, dependency resolution,
  queue selection, and eligibility decisions;
- admission, leases, process launch, readiness, supervisor state, and worker
  execution;
- source inventory, branch/worktree operations, rollback evidence, ownership
  reconciliation, and file changes;
- Builder preparation, turns, tools, compaction, retries, handbacks, and
  remediation;
- final ticket completion, project tests, durable persistence, and run close;
- resume, reset, start-over, cancellation, crash recovery, and incomplete
  execution.

Primary files:

- `packages/rafi/src/index.ts`
- `packages/rafi/src/plan.ts`
- `packages/rafi/src/planningDriver.ts`
- `packages/rafi/src/grillAudit.ts`
- `packages/rafi/src/discovery.ts`
- `packages/rafi/src/ticketPlan.ts`
- `packages/ai-foreman/src/cli/start.ts`
- `packages/ai-foreman/src/foreman.ts`
- admission, ownership, recovery, branch, and finalization modules under
  `packages/ai-foreman/src`

Every phase must emit an explicit unavailable, skipped, denied, cancelled, or
failed record when it does not produce an ordinary result.

## 8. Workstream F — QA and handoff instrumentation

Update:

- `qaPreparation.ts`
- `qaPreparationStore.ts`
- `qaPreparationMetrics.ts`
- `qaBuildGate.ts`
- `qaReview.ts`
- `qaFailureDelivery.ts`
- `qaProtocolV2.ts`
- `qaRecovery.ts`
- `qaSnapshot.ts`
- `handoffs.ts`
- `qaDeliveryJournal.ts`
- `qaEvidenceReader.ts`

Make these first-class timed phases:

```text
qa-preparation
qa-preparation-inventory
qa-preparation-assessment
qa-preparation-challenge
qa-contract-publication
qa-contract-acceptance
qa-review
qa-failure-delivery
qa-handoff-staging
qa-handoff-acceptance
builder-remediation
qa-response-repair
qa-final-review
```

Link every phase to its policy, budget reservation/extension, artifact,
contract revision, review basis, snapshot identity, provider turn, finding,
handoff, remediation source digest, and final certificate.

Replace the current `qaFailures` rollup with distinct counters and report
fields for non-passing attempts, remediation-causing findings, terminal
rejections, provider/runtime failures, host validation failures, and expected
approval pauses.

## 9. Workstream G — immutable state snapshots

Add snapshot capture at meaningful boundaries:

- run start/end and every execution restart;
- ticket admission and state transitions;
- provider session transitions;
- contract publication and acceptance;
- QA disposable snapshot creation;
- handoff staging and acceptance;
- remediation before/after;
- recovery pause/resume;
- final completion and independent project tests.

Snapshot contents should reference current run/checkpoint, ticket state,
leases/admissions, provider state, contract head and requirements digest,
source/worktree identity, pending handoffs/recovery records, observability
state, and resource metrics. Missing values must carry an explicit unavailable
reason; later state must never be used to fill an earlier gap.

## 10. Workstream H — `rafi stats` query, playback, and exports

Add a new Rafi CLI module, likely `packages/rafi/src/stats.ts`, and register it
in `packages/rafi/src/index.ts`.

Implement:

- `stats show`: run overview, outcome categories, capture level, capabilities,
  gaps, timing, QA counts, and storage health;
- `stats timeline`: chronological events, nested span tree, parent/child links,
  inputs, outputs, evidence, gaps, retries, pauses, overlaps, and uncertain
  completion;
- `stats compare`: compare two runs or attempts without merging evidence;
- `stats export`: stable JSON event stream and visualization data format;
- `stats delete`: explicit, scoped, confirmed deletion with deletion receipt;
- `stats replay`: explicit replay request creation and execution inspection.

Playback must be read-only. It must preserve recorded durations and overlaps,
show unavailable data honestly, and never imply causality solely from temporal
overlap.

## 11. Workstream I — isolated replay

Add replay modules under `packages/ai-foreman/src`, with CLI wiring in
`packages/rafi/src/stats.ts`.

Replay must:

- create a new replay execution ID linked to the historical span/event;
- use recorded input, configuration, source snapshot, and relevant state;
- default to a disposable worktree or sandbox;
- require explicit confirmation for provider calls, shell commands, writes,
  network, and other side effects;
- support host-only deterministic replay without provider contact;
- record environment differences, unavailable dependencies, and
  nondeterminism;
- compare historical and replay outputs without replacing either;
- support a single span or bounded descendant subgraph only.

Replay data is always marked as newly produced replay evidence and cannot be
returned through historical evidence queries as if it were original.

## 12. Workstream J — E2E and reliability validation

Update the Claude and Codex E2E harnesses and fixtures to force `detailed`,
persist the forced-mode reason, and verify local payload availability.

Add tests for:

- schema validation and migration;
- append-only integrity and digest verification;
- crash recovery and abandoned spans;
- monotonic timing and nested-span accounting;
- all three capture levels;
- indefinite retention and explicit deletion;
- payload capacity omissions without build failure;
- redaction/display boundaries;
- provider/tool capture for Claude and Codex;
- all named QA phase timings;
- playback order, gaps, overlap, retries, and uncertainty;
- replay isolation and historical/replay separation;
- comparison and cohort statistics;
- diagnostic failure isolation;
- successful, failed, paused, resumed, recovered, cancelled, and incomplete
  full-capture E2E runs.

## 13. Delivery order

Implement in this order:

1. Contracts and validation.
2. Append-only journal, payload store, snapshot store, and migrations.
3. Three capture levels and indefinite-retention policy.
4. Provider/tool payload capture.
5. Root lifecycle instrumentation.
6. QA/handoff phase instrumentation.
7. Snapshot integration.
8. `rafi stats show`, timeline, export, and comparison.
9. E2E detailed-mode enforcement and replayability tests.
10. Isolated replay.
11. Deletion, storage health, and cohort analysis hardening.

Each stage must preserve the invariant that diagnostic failures are visible but
cannot block, alter, or falsely complete the build.

## 14. Definition of done

The work is complete when:

- `none`, `normal`, and `detailed` are the only supported public levels;
- all levels retain data indefinitely unless explicitly deleted;
- detailed Claude and Codex E2E runs contain complete local provider/tool
  payloads;
- every lifecycle phase has timing or an explicit unavailable record;
- QA preparation, review, remediation, handoff, acceptance, and final QA have
  separate timings;
- every span links to inputs, outputs, state, and evidence;
- playback is read-only and preserves overlaps, pauses, retries, and uncertain
  completion;
- replay is isolated, explicitly authorized, and never confused with history;
- `rafi stats` supports inspection, export, comparison, replay, and deletion;
- storage pressure cannot delete evidence or affect build correctness;
- tests cover schemas, crash recovery, indefinite retention, deletion,
  redaction, timing, nested spans, playback, replay, and both providers;
- successful and recovery-oriented Claude/Codex E2E runs pass with detailed
  capture enabled.

## 15. Known implementation risks

- Indefinite full capture can grow without bound; capacity handling must omit
  only future optional payloads and clearly report the gap.
- Provider output may include credentials, source code, personal data, and
  proprietary context; detailed mode must be visibly sensitive.
- A recorded run is not necessarily deterministic because providers,
  dependencies, clocks, and operating systems change.
- Existing QA and workflow stores already own authoritative evidence; forensic
  records should reference them rather than create conflicting authority.
- The visualization layer must remain a projection and never become an
  authority for source state, QA acceptance, or recovery.
