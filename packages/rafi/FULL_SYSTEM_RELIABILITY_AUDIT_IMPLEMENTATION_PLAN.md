# Rafi full-system reliability audit implementation plan

## Objective

Implement the audit requirements in
`FULL_SYSTEM_RELIABILITY_AUDIT_REQUIREMENTS.md` so Rafi can explain every
real-provider build from creation through independent QA and completion.

The finished system must answer, from host-owned records:

- What requirements were created?
- What did QA preparation add or reject?
- What exactly did the Builder receive?
- What did the Builder do and test?
- What exactly did independent QA review?
- Why did every QA failure occur?
- What did Rafi hand back to the Builder?
- What did the Builder produce afterward?
- Why did QA pass, fail again, or stop?
- Where did time go, down to provider, tool, snapshot, parsing, persistence,
  and recovery phases?

The instrumentation must be detailed enough for performance diagnosis while
remaining bounded, opt-in where content is sensitive, and cheap when detailed
logging is disabled.

## Non-negotiable boundaries

The implementation must preserve:

- independent QA;
- host ownership of run IDs, ticket IDs, paths, timestamps, digests,
  generations, evidence IDs, and acceptance state;
- provider-output schema and semantic validation;
- bounded output disclosure and redaction;
- current-branch additive-ticket semantics;
- rollback validation and recovery safety;
- historical evidence needed for recovery and audit;
- user interruption semantics: normal active builds do not stop on their own.

The implementation must not:

- treat a provider claim as host evidence;
- fabricate RED/GREEN, exit-status, source-scope, or rollback evidence;
- retain unrestricted provider transcripts by default;
- disclose full command output globally;
- turn performance logging into a new product requirement;
- add mandatory documentation requirements by implication;
- bypass QA or reduce QA depth merely to improve timing.

## Logging modes

Implement three host-controlled modes. The mode is captured in the run record
so a run can be interpreted correctly later.

### `off`

Use when the operator wants the minimum overhead and does not need diagnostic
detail.

Retain only the existing correctness-critical records:

- run and ticket state transitions;
- contract and source digests;
- required handoff/recovery records;
- final outcomes;
- evidence needed to enforce QA and recovery safety.

Do not disable correctness-critical evidence or state persistence through this
mode.

### `summary` (default)

Use for normal builds. Retain enough information to identify the slow stage
without retaining every provider event.

Retain:

- all phase start/end timestamps and durations;
- provider/model/session identity;
- tool-call counts and durations;
- command classification, exit status, output digest, and bounded summary;
- snapshot file counts, bytes, hashing/copy/verification durations;
- contract delivery and handoff receipts;
- QA finding, remediation, and acceptance summaries;
- context size, compaction count, retry count, and token/cost metadata when
  authoritative;
- bounded error and limitation summaries.

Do not retain raw provider conversation text unless an existing bounded-evidence
rule explicitly permits it.

### `trace`

Use for a disposable diagnostic run or a narrowly scoped ticket. Add:

- host-observed provider and tool lifecycle events;
- per-tool start/end timestamps and durations;
- phase queue/wait times;
- parser, normalization, validation, persistence, and callback timings;
- bounded provider response excerpts only when explicitly authorized for the
  current ticket;
- evidence references for each input/output transition;
- event sequence and parent/child span relationships.

Trace mode remains bounded. It does not grant broader shell access or global
transcript retention. Raw response bodies remain digest-addressed artifacts
with existing redaction and access controls.

### Retention, access, and size limits

Before implementing trace mode, define and test a retention policy for each
artifact class:

- correctness-critical state and evidence: retained with the run’s normal
  recovery history;
- summary diagnostics: retained for the project’s configured diagnostic
  window;
- trace events and bounded excerpts: retained only for the disposable trace
  window, then expired by host cleanup;
- raw provider bodies: retained only when an existing bounded-evidence rule
  authorizes them and only for the configured artifact window.

Each project must define or inherit the window, access authority, redaction
rules, and cleanup behavior. The plan must not introduce indefinite retention
by default. Cleanup must record what class was removed, when, and whether any
artifact could not be removed.

Trace mode must enforce hard budgets per run and ticket:

```text
maximum events
maximum event bytes
maximum artifact bytes
maximum bounded excerpt bytes
maximum provider turns
maximum retained tool observations
```

When a budget is reached, the host records `trace-budget-exhausted` and
continues with summary metadata. It never silently drops correctness-critical
evidence.

### Configuration and precedence

Add one documented configuration surface with this precedence:

1. explicit run flag;
2. project configuration;
3. environment variable for disposable diagnostics;
4. `summary` default.

Suggested public shape:

```text
--audit-logging off|summary|trace
RAFI_AUDIT_LOGGING=off|summary|trace
```

The selected mode must be shown at run start and stored in the run capability
record. Invalid values fail clearly before the build starts. A mode change
during a run is not allowed except through an explicit, recorded diagnostic
decision; otherwise timing comparisons become ambiguous.

## Phase 1: inventory existing observability and define canonical events

### Work

1. Inventory current run spans, run events, phase rollups, QA journals,
   workflow events, recovery tables, ticket events, evidence artifacts, and
   snapshot metadata.
2. Map each existing record to the lifecycle in the audit requirements.
3. Identify duplicate event types and choose one canonical host event/span
   representation for new work.
4. Define the event version and migration strategy.
5. Define redaction, bounded-size, and retention rules before adding new
   content-bearing fields.

### Canonical event fields

Every event/span should support:

```text
eventId
operationId
retryId
causalChainId
runId
ticketId
stage
actor
provider
model
providerSessionId
executionId
attempt
cycle
handoffGeneration
contractDigest
sourceDigest
snapshotId
eventType
parentEventId
startedAt
completedAt
durationMs
queueWaitMs
status
outcome
inputBasisDigest
evidenceRefs
errorClass
summary
```

`operationId` identifies one logical operation, `retryId` identifies one
attempt of that operation, and `causalChainId` links the complete chain from a
finding through handback, remediation, and subsequent QA. These identities
must remain stable across provider retries and process recovery.

Use wall-clock ISO timestamps for correlation and a monotonic clock for
duration measurement. If a duration cannot be measured, store `unknown`; do
not use zero.

### Tests

- event schema validation;
- parent/child span linkage;
- monotonic duration under clock changes;
- missing timing represented as unknown;
- mode captured and immutable for a run;
- old databases migrate without losing existing records.

## Phase 2: add efficient lifecycle timing

Instrument the complete lifecycle with nested spans. Do not create a separate
provider call merely to log a span; the host records timing around work it is
already performing.

### Required stages

At minimum:

1. create interview and persistence;
2. planning provider wait and response processing;
3. QA-preparation depth assessment;
4. QA-preparation draft generation;
5. QA-preparation semantic assessment;
6. QA-preparation challenge and bounded repair;
7. contract normalization;
8. contract semantic validation;
9. contract persistence;
10. contract delivery and receipt;
11. ticket setup/population/validation/queue;
12. admission and worker launch;
13. Builder prompt construction and delivery;
14. Builder provider wait, tool execution, parsing, and persistence;
15. Builder self-checks and evidence capture;
16. source freeze and stability retries;
17. snapshot clone, materialization, dependency setup, hashing, verification,
    and cleanup;
18. independent QA prompt construction and delivery;
19. independent QA provider wait, tool execution, parsing, validation, and
    report persistence;
20. QA finding classification;
21. remediation chunk construction and handoff staging;
22. handoff acceptance callback;
23. Builder remediation provider/tool work;
24. remediation response validation and source capture;
25. final QA;
26. final fixture tests;
27. completion persistence and cleanup.

### Efficiency rules

- `off` mode performs no detailed event allocation beyond correctness records.
- `summary` mode writes one phase row at completion where possible rather than
  one database transaction per progress message.
- `trace` mode may write event batches asynchronously, but must flush before a
  terminal result is committed.
- Progress output remains a UI concern and is not the audit database.
- Large output is stored once by digest; events reference it rather than copy
  it.
- Repeated identical metadata is stored by reference or run-level context.
- Measure instrumentation overhead itself, including event creation,
  serialization, queueing, database writes, flushes, dropped diagnostic events,
  and cleanup. Record `loggingOverheadMs`, `loggingQueueDepth`,
  `loggingDroppedEvents`, and `loggingFlushMs` in the run summary.
- Logging failures never silently turn a successful command into fabricated
  evidence; they produce an explicit `evidence-unavailable` status where
  required.

Logging failure semantics are explicit:

- diagnostic logging unavailable: continue the build and mark diagnostics
  incomplete;
- correctness-critical evidence unavailable: block only the affected QA or
  recovery decision and report the exact missing evidence;
- never convert missing evidence into a pass, successful exit, or fabricated
  command result.

Concurrent runs must have isolated run IDs, operation IDs, snapshots, event
streams, provider sessions, and project-local persistence boundaries. A Claude
run and a Codex run executing simultaneously must never share mutable audit
state or cause one run’s timing/evidence to be attributed to the other.

## Phase 3: durable host-owned command evidence

### Work

Create a host-owned command-result record for contract-relevant Builder and QA
commands. Start with test commands and rollback rehearsals, then extend only
where the audit shows a need.

Each record must include:

```text
commandEvidenceId
runId
ticketId
role
attempt
cycle
providerSessionId
snapshotId/workspaceIdentity
commandClass             node-test | npm-test | rollback-rehearsal | other-approved
sanitizedCommandShape    no secrets or unrestricted raw command text
startedAt
completedAt
durationMs
exitCode                 known integer or unknown
outcome                  passed | failed | denied | cancelled | timed_out | unknown
outputDigest
boundedOutputSummary     optional, mode/authorization controlled
sourceDigestBefore
sourceDigestAfter
eventEvidenceRef
retentionClass
```

### RED/GREEN handling

1. When a contract requires test-first evidence, the host records the failing
   test command before the implementation source changes.
2. The host records the source digest associated with that failure.
3. The host records the passing command after the source change.
4. The passing record must bind to the final source digest or the exact
   approved intermediate digest required by the contract.
5. `hostTestSequenceEvidence` must return stable command evidence IDs and
   persisted records, not only in-memory observations.
6. If the host cannot prove the sequence, QA receives a single explicit
   evidence-unavailable finding with one recovery option. It must not trigger
   repeated attempts to recreate the RED state by reverting source.

The recovery option must be explicit and actionable:

- rerun the required command with host capture enabled;
- revise the contract only through the normal authorized contract-amendment
  path when test-first evidence is not actually required; or
- ask the operator for a decision when neither option is safe.

The system must record which option was offered and which decision was made.

### Tests

- RED and GREEN records survive process restart;
- non-zero exit is not converted to completed;
- provider “completed” status cannot override host exit status;
- missing exit status remains unknown;
- source digest ordering is enforced;
- duplicate event delivery is idempotent;
- bounded output and redaction rules are enforced;
- a failed evidence capture is visible to QA and recovery.

## Phase 4: prove contract delivery and requirement traceability

### Work

For every contract-bearing delivery, persist a delivery receipt containing:

- source contract digest;
- rendered prompt/instruction digest;
- section names and byte counts;
- Builder or QA role;
- provider/session identity;
- delivery start/end/duration;
- acknowledgement or terminal event identity;
- response parser and semantic-validation result.

Build a requirement traceability record:

```text
requirementId
requirementDigest
sourceLocator
contractDigest
builderInstructionDigest
builderEvidenceRefs
qaCheckIds
qaEvidenceRefs
finalDisposition
```

The trace must distinguish:

- requirement never created;
- requirement created but not delivered;
- delivered but not acknowledged;
- acknowledged but not addressed;
- addressed but not independently verified;
- independently verified and passed.

### Tests

- exact contract digest reaches Builder and QA;
- stale contract delivery is rejected;
- changed source invalidates old trace entries;
- omitted requirement is detected;
- provider text cannot change host-owned trace fields;
- bounded prompt receipts do not retain unauthorized raw content.

## Phase 5: formalize snapshot lifecycle evidence

### Work

Add a host-owned `snapshotId` and lifecycle record for each disposable QA
snapshot:

```text
snapshotId
runId
ticketId
reviewAttemptId
sourceDigest
contentDigest
head
fileCount
byteCount
createdAt
frozenAt
verifiedAt
qaStartedAt
qaCompletedAt
removedAt
cloneDurationMs
materializeDurationMs
dependencyDurationMs
hashDurationMs
verifyDurationMs
cleanupDurationMs
status
verificationResult
```

Record file counts and byte totals, not full file contents. The existing frozen
source manifest and digest remain authoritative for integrity.

Define snapshot immutability as:

- the Builder workspace is not the QA workspace;
- the snapshot is verified against the frozen host manifest before QA;
- QA changes are detected after review;
- changes to the snapshot cannot change the Builder source;
- the reviewed source digest is bound into the QA attempt and report.

### Tests

- snapshot mismatch before QA blocks review;
- QA edits do not alter Builder files;
- source drift causes a fresh snapshot/review;
- cleanup removes only the disposable snapshot;
- cleanup timing and failure are recorded;
- dependency setup is not confused with source copying.

## Phase 6: build one causal QA-cycle ledger

### Work

Create a durable cycle record that links:

```text
review attempt
→ QA report
→ finding IDs/keys
→ classification
→ handback request
→ handoff staging
→ acceptance callback
→ Builder remediation turn
→ source/evidence result
→ next QA attempt
```

Each cycle must record:

- exact finding and requirement/check reference;
- finding category and confidence;
- whether the finding was knowable before implementation;
- whether it was actionable;
- requested remediation scope;
- source/contract/baseline digests;
- whether source changed;
- Builder result and evidence;
- next QA disposition;
- why another cycle was or was not necessary;
- provider, host, tool, waiting, and persistence durations.

### Cycle controls

- Keep the initial full QA review.
- Keep remediation chunks bounded.
- Do not resend settled findings.
- Invalidate a remediation chunk when source, contract, or review basis changes.
- Do not start remediation if the handoff was not accepted.
- Do not start another review for an unchanged, already-disproven, or
  host-unresolvable finding without a new recovery decision.
- Detect repeated normalized findings and report them as recurrence, not new
  independent defects.

### Tests

- identical finding recurrence;
- changed wording with same normalized finding;
- two independent findings in one chunk;
- source change invalidating a chunk;
- contract amendment invalidating a chunk;
- staged handoff without acceptance callback;
- remediation response with no source change;
- provider failure versus host evidence failure;
- final full QA after multiple remediation chunks.

## Phase 7: complete failure-cause and handback analysis

### Work

Extend the QA timeline/reporting layer to produce a causal report for every
failure. The report must distinguish at least:

- requirement/preparation omission;
- Builder behavioral defect;
- Builder evidence omission;
- QA contract or parser defect;
- QA false positive or out-of-scope requirement;
- provider refusal, timeout, or malformed response;
- host command-policy denial;
- snapshot/source drift;
- handoff staging/acceptance failure;
- persistence or state-machine failure;
- external environment failure.

Cause classification must cite retained evidence and mark uncertainty. A
heuristic similarity match may identify a possible recurrence but cannot claim
that two findings are the same without supporting evidence.

The report must show both the QA request and the Builder’s actual output, not
just the final status.

## Phase 8: generate audit reports and performance analysis

Implement report generation over retained host data. Reports should be
available as bounded JSON and concise human-readable Markdown/CLI output.

### Required reports

1. run timeline;
2. requirement traceability matrix;
3. QA cycle ledger;
4. failure-cause report;
5. evidence completeness report;
6. snapshot cost report;
7. provider comparison report;
8. state consistency report;
9. remediation efficiency report;
10. before/after performance report.

### Performance analysis

For every run calculate:

- wall-clock duration;
- active provider time;
- provider queue/wait time;
- tool execution time;
- snapshot time;
- parsing/normalization/validation time;
- persistence time;
- explicit user-wait time;
- recovery/remediation time;
- unattributed time.

For QA specifically calculate:

- initial review duration;
- each QA turn duration;
- each handoff acceptance delay;
- each remediation chunk duration;
- each snapshot creation and verification duration;
- repeated-context cost;
- time spent on findings that did not change source;
- time spent on evidence-only blockers;
- final QA duration.

Do not declare a phase inefficient from one run alone. Compare equivalent
Claude/Codex runs and report sample size, fixture, model, reasoning setting,
ticket count, QA mode, and logging mode.

Initially report descriptive distributions rather than hard-coded blocking
thresholds. After enough runs, propose thresholds for review and approval.

The first performance report must state its sample size and comparison basis.
Do not call a change faster or slower without recording the fixture, ticket
count, provider, model, reasoning setting, QA mode, logging mode, and whether
the comparison runs were concurrent. Any future threshold proposal must state
the minimum sample size and comparison method before it becomes a policy.

## Phase 9: audit adjacent Rafi systems

Add targeted audits for:

### Provider/runtime

- startup/authentication/session allocation;
- model and reasoning configuration;
- retry and timeout behavior;
- provider exit-status mapping;
- compaction and context growth;
- Claude/Codex adapter parity.

### Persistence/recovery

- SQLite transaction boundaries;
- state transition correctness;
- stale leases and admission cleanup;
- recovery generation and acceptance callback routing;
- restart-current, resume, fresh-session, and fresh-with-handoff behavior.

### Ticket lifecycle

- setup/population/validation/queue consistency;
- risk-based rollback quality;
- reset and regeneration semantics;
- eligible-ticket selection;
- stale blocked-ticket handling.

### CLI and user experience

- accurate progress and final status wording;
- no unexpected stop during authorized work;
- run selection without unnecessary internal IDs;
- clear reset/regenerate effects;
- actionable needs-human output.

### Packaging and publishing

- source versus dist behavior;
- clean-package install behavior;
- package version alignment;
- migrations from older run/ticket databases;
- published CLI and provider runtime behavior.

## Phase 10: test strategy

### Unit tests

Test schemas, event normalization, digest bindings, timing, logging modes,
bounded output, redaction, and causal classification.

### Integration tests

Exercise complete chains with fake providers:

- successful Builder and QA;
- QA finding and one remediation chunk;
- repeated finding;
- missing RED evidence;
- missing handoff acceptance;
- stale source/contract;
- snapshot mutation;
- provider timeout/refusal/malformed output;
- interrupted and resumed builds;
- logging off/summary/trace equivalence for correctness.

### Live tests

Run fresh disposable Claude and Codex journeys in parallel with:

- logging mode recorded;
- complete evidence paths retained;
- independent fixture tests;
- before/after timing reports;
- no claims of success unless Builder, independent QA, and fixture tests pass.

## Implementation order and checkpoints

1. Inventory and canonical event design.
2. Logging-mode configuration and capability recording.
3. Lifecycle spans and phase timing.
4. Durable command evidence and RED/GREEN records.
5. Contract-delivery receipts and requirement traceability.
6. Snapshot lifecycle records.
7. Unified QA-cycle ledger.
8. Failure-cause and handback reports.
9. Performance and provider-comparison reports.
10. Adjacent-system audits.
11. Unit/integration regression suite.
12. Parallel live Claude/Codex verification.

At each checkpoint:

- run targeted tests;
- run TypeScript checks and `git diff --check`;
- inspect migration compatibility;
- verify no new broad disclosure or provider authority;
- verify logging-off mode preserves correctness;
- record remaining evidence gaps before moving on.

Each phase is complete only when it has produced:

- the required schema, migration, or implementation boundary;
- targeted unit and integration tests;
- a bounded sample event/report fixture;
- documented retention and failure behavior;
- evidence that `off` mode preserves correctness and QA semantics;
- a review of concurrent-run isolation where the phase touches shared state.

## Completion criteria

The implementation is complete only when:

- a run can be reconstructed without relying on a provider conversation;
- required RED/GREEN evidence is host-verifiable when requested;
- every QA cycle has a causal chain and timing breakdown;
- snapshot cost is separated from provider/model time;
- repeated remediation cycles can be explained and bounded;
- logs can be disabled, summarized, or traced without changing build semantics;
- summary mode is efficient enough for normal operation;
- trace mode is bounded and suitable for disposable diagnostics;
- Claude and Codex can be compared using the same event definitions;
- independent QA, contract validation, and evidence integrity remain intact;
- fresh live Claude and Codex journeys complete Builder work, independent QA,
  and fixture verification.

