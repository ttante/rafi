# Full-Run Forensic Replay and Debugging Requirements

## 1. Purpose

Rafi needs a complete, local, forensic record of every build workflow so an
operator can reconstruct exactly what happened, determine where time was
spent, inspect the data flowing through any step, visualize the run, and
optionally re-execute an individual step in an isolated context.

The system is intended for reliability investigation, performance analysis,
QA diagnosis, and recovery analysis. It must not make logging a prerequisite
for build correctness or allow diagnostic failures to stop or change a build.

## 2. Decisions already made

These requirements are decided:

- Capture all available diagnostic data, including full provider prompts and
  responses and complete tool inputs and outputs.
- Keep the data local to the project/run environment. Do not upload it to an
  external service by default.
- Retain the full diagnostic record indefinitely unless an operator explicitly
  removes it.
- Provide forensic playback of completed and incomplete runs.
- Provide optional re-execution of individual steps from recorded inputs.
- Keep the debugger-style detailed data view off by default for ordinary use.
- Automatically enable full capture during E2E tests.
- Preserve the existing requirement that logging and diagnostics never block,
  alter, or falsely complete a build.

The full-capture decision is intentionally different from the earlier bounded
evidence policy. This feature is an explicit local diagnostic mode and must be
clearly identified as potentially containing secrets and sensitive provider
data.

## 3. Workflow coverage

The record must cover the complete Rafi lifecycle, not only Builder and QA:

1. Project creation and configuration resolution.
2. Planning, including interview/grill decisions and plan revisions.
3. Ticket setup and population.
4. Ticket normalization, contract validation, and dependency resolution.
5. Queue selection and eligibility decisions.
6. Start preparation, admission, process launch, and runtime readiness.
7. Builder session preparation, provider turns, compaction, retries, tool use,
   file changes, and handbacks.
8. QA preparation:
   - policy resolution;
   - baseline capture;
   - inventory;
   - requirement extraction;
   - draft contract;
   - semantic assessment;
   - approach challenge;
   - normalization and validation;
   - contract publication and acceptance.
9. Independent QA:
   - disposable snapshot creation;
   - reviewer initialization;
   - review turns;
   - tool use;
   - evidence collection;
   - host-owned comparisons;
   - verdict parsing and validation;
   - persistence.
10. QA failure handling:
    - failure report creation;
    - finding classification;
    - handoff staging;
    - handoff acceptance;
    - Builder guidance delivery;
    - Builder remediation;
    - response repair;
    - recovery packet creation;
    - retry scheduling;
    - final QA.
11. Branch/worktree operations, source snapshots, rollback evidence, and
    ownership reconciliation.
12. Final ticket completion, run completion, durable persistence, and
    independent project tests.
13. Resume, reset, start-over, crash recovery, cancellation, and incomplete
    runs.

Every phase must be represented even when it is skipped, unavailable, denied,
cancelled, or fails before producing an ordinary result.

## 4. Event and span model

Use a versioned, append-only event model with nested spans. A span represents a
timed operation; events represent instantaneous facts or state transitions.

Every span should include:

- schema version;
- stable span ID;
- run ID and execution ID;
- parent span ID;
- ticket ID and delivery-unit ID when applicable;
- role (`host`, `builder`, `qa`, `manager`, or another explicit role);
- provider, model, provider session ID, and provider turn ID when applicable;
- logical phase and operation name;
- monotonic start and end timing for duration calculation;
- wall-clock start and end timestamps for human correlation;
- outcome (`completed`, `failed`, `blocked`, `cancelled`, `denied`, `retry`,
  `passed`, `rejected`, `unknown`, etc.);
- completion certainty (`known`, `unknown`, or equivalent);
- input references and output references;
- state-before and state-after references;
- error/failure classification;
- resource samples or references when available.

Every event should include:

- event ID and schema version;
- timestamp and monotonic ordering information;
- run/execution/span/ticket identity;
- event type and actor/authority;
- immutable payload or payload reference;
- digest of the payload;
- causal parent or preceding event where known;
- whether the event was observed, intended, accepted, rejected, or inferred.

Wall-clock time is for correlation and display. Monotonic time is authoritative
for durations so clock changes cannot create negative or misleading timings.

## 5. Required data capture

### 5.1 Rafi and host data

Capture, with before/after references where meaningful:

- resolved configuration and configuration source;
- command line and environment selection relevant to behavior;
- effective policy and safety decisions;
- approved plan and exact plan revision;
- ticket definitions and normalized ticket records;
- QA contracts, contract revisions, digests, and validation errors;
- baseline and final source inventories;
- source/worktree/branch identity;
- file changes and file-content digests;
- database state transitions and transaction outcomes;
- admission, lease, ownership, and process identity;
- handoff manifests, recovery packets, and acceptance receipts;
- host-generated instructions and guidance;
- host parser, normalizer, and semantic-validation results;
- independent QA assessment and final certificates;
- test commands, exit codes, bounded/full output according to mode, and
  result digests;
- all pauses, user decisions, waivers, approvals, cancellations, and resumes.

### 5.2 Provider data

Capture locally and indefinitely in full-capture mode:

- provider name, model, SDK/CLI version, and runtime configuration;
- session creation, initialization, compaction, reconnect, retry, and close;
- exact prompt/instruction text sent by Rafi;
- exact provider response text and structured response payloads;
- provider error payloads, exit status, and transport metadata;
- provider usage, token counts, cost data, and timing when available;
- provider-reported tool calls and result messages;
- session identity changes and continuity evidence.

The record must distinguish host-observed data from provider-claimed data.
Provider output must never overwrite host-owned paths, hashes, source state,
authority, or acceptance state.

### 5.3 Tool data

Capture for every tool invocation:

- tool name and invocation ID;
- start/end timestamps and duration;
- exact input arguments;
- permission decision;
- execution environment and working directory;
- stdout, stderr, exit code, signal, and timeout state;
- files changed, created, deleted, or read when observable;
- output digest and full output in full-capture mode;
- whether the tool was attempted, denied, cancelled, failed, or completed.

### 5.4 QA-specific data

QA must be diagnosable as a chain, not just a final pass/fail:

- preparation policy and selected depth;
- preparation budget and each budget reservation/extension;
- each preparation operation and provider response;
- each draft, assessment, challenge, inventory, and contract artifact;
- every check, obligation, timing, applicability predicate, and evidence rule;
- contract parsing, normalization, semantic validation, and rejection reasons;
- independent-review snapshot identity and source digest;
- each QA finding, its evidence, classification, confidence, and cause;
- whether the finding was knowable before implementation;
- handoff staging and acceptance attempts, including why an acceptance
  callback was or was not reached;
- Builder guidance input and the complete remediation response;
- source digest before and after remediation;
- final QA result and independent test result.

The following must be first-class timed phases rather than being hidden inside
generic provider spans:

- `qa-preparation`
- `qa-preparation-inventory`
- `qa-preparation-assessment`
- `qa-preparation-challenge`
- `qa-contract-publication`
- `qa-contract-acceptance`
- `qa-review`
- `qa-failure-delivery`
- `qa-handoff-staging`
- `qa-handoff-acceptance`
- `builder-remediation`
- `qa-response-repair`
- `qa-final-review`

## 6. State snapshots and point-in-time inspection

At every meaningful boundary, record a state snapshot or immutable reference
to one. Snapshots should cover:

- current run state and checkpoint;
- current ticket state;
- active leases/admissions;
- current provider/session state;
- contract head and requirements digest;
- source/worktree identity;
- pending handoffs and recovery records;
- current observability state;
- relevant process/resource metrics.

Snapshots must be content-addressed and deduplicated. A debugger should be able
to select any span or event and show:

- what was active;
- what data entered the step;
- what data was produced;
- what changed;
- what was known versus unknown;
- what downstream step consumed the result.

If a value was not captured, the debugger must show “unavailable” and the
reason. It must never synthesize a value from a later state.

## 7. Forensic playback

Playback must be read-only and must not mutate the original run, tickets,
source, databases, provider sessions, or recovery state.

Playback should provide:

- chronological event timeline;
- nested span tree;
- Gantt-style duration view;
- active-component view for each instant;
- run scrubber and play/pause controls;
- speed controls, including real-time duration playback;
- filtering by ticket, role, provider, phase, outcome, and time range;
- transition from a step to its parents, children, inputs, outputs, and evidence;
- comparison of two runs or two attempts;
- clear display of retries, overlaps, pauses, gaps, and uncertain completion;
- exportable JSON event stream and a stable visualization data format.

Animation is a presentation layer. It must use recorded durations and must not
change the underlying evidence or imply that an operation was active when the
record says it was not.

## 8. Optional isolated step re-execution

Re-execution is separate from forensic playback and requires explicit operator
action.

Requirements:

- Never mutate the original run or original evidence.
- Create a new replay execution ID and link it to the original span/event.
- Use recorded inputs, configuration, source snapshot, and relevant state.
- Run in a disposable worktree or sandbox by default.
- Require explicit confirmation before provider calls, shell commands, file
  writes, network access, or other side effects.
- Allow host-only deterministic replays without contacting a provider.
- Clearly label newly produced outputs as replay results, never as historical
  facts.
- Record environment differences, unavailable dependencies, and nondeterminism.
- Compare replay output with the historical output without replacing either.
- Support re-executing a single step or a bounded descendant subgraph, not an
  uncontrolled rerun of the entire project.

## 9. Capture modes and controls

At minimum provide:

- `off`: no optional diagnostic capture; required safety/audit boundary records
  still remain where needed for correctness.
- `summary`: current normal mode with timings, counts, digests, bounded
  evidence, and rollups.
- `trace`: detailed structured spans and tool/provider metadata.
- `full-replay`: complete local payload capture, including provider and tool
  inputs/outputs, intended for E2E and forensic investigation.

E2E harnesses must force `full-replay` and record that the mode was forced.
Ordinary user runs must not silently enable full raw payload capture.

The mode, retention policy, capture capabilities, and any missing sources must
be recorded in the run itself.

## 10. Storage and retention

Use local append-only, versioned storage with:

- a structured event/span index for fast queries;
- content-addressed payload storage for large data;
- immutable digests and parent references;
- crash-safe writes and recovery of incomplete records;
- schema migrations and backward-compatible readers;
- indefinite retention by default for full-replay data;
- explicit operator-controlled deletion/export tools;
- no automatic upload or external retention;
- protection against accidental inclusion in Git and package artifacts.

The implementation should consider optional local encryption at rest, because
full provider and tool capture may contain credentials, source code, prompts,
and personal data. Encryption must not silently prevent forensic access to the
owner who enabled the feature.

## 11. Performance and reliability requirements

Diagnostics must be efficient enough not to materially slow normal builds.

Required safeguards:

- append writes without holding the build’s critical path longer than needed;
- batching/coalescing for high-frequency metrics;
- content-addressed deduplication;
- bounded in-memory queues with explicit overflow behavior;
- backpressure that drops only optional diagnostics and records the omission;
- no loss of safety-critical state transitions because diagnostics are busy;
- diagnostic exceptions are isolated and visible but never fail the build;
- timing records use monotonic clocks;
- incomplete spans are marked uncertain/abandoned on crash;
- parent/child overlap is preserved so reports do not double-count time.

## 12. Reporting and analysis

The report layer should answer, for any run or cohort:

- Where did calendar time go?
- Where did active execution time go?
- What time was provider thinking, tool execution, host work, waiting, or
  remediation?
- How many QA attempts, findings, remediations, and terminal failures occurred?
- Which QA checks fail most often?
- Which findings were preparation omissions, Builder misses, implementation
  defects, or outside-contract issues?
- How long did each handoff and acceptance path take?
- How often were callbacks not reached, and why?
- How frequently did compaction, retry, reconnect, or recovery occur?
- Which providers, models, ticket sizes, or phases are slowest?
- How much time is unattributed or diagnostically unavailable?
- Did the Builder satisfy the contract before QA, or did QA repeatedly discover
  missing requirements?

Reports must distinguish:

- a QA finding that caused remediation;
- a non-passing QA attempt;
- a terminal QA rejection;
- a provider/runtime failure;
- a host validation failure;
- an expected approval pause.

The current metric name `qaFailures` must not collapse these categories into one
number.

## 13. Implementation guidance for the agent

Before changing code, inspect and reuse the existing implementations in:

- `packages/ai-foreman/src/observability.ts`
- `packages/ai-foreman/src/qaPreparationMetrics.ts`
- `packages/ai-foreman/src/qaBuildGate.ts`
- `packages/ai-foreman/src/qaReview.ts`
- `packages/ai-foreman/src/qaFailureDelivery.ts`
- `packages/ai-foreman/src/qaPreparationStore.ts`
- `packages/ai-foreman/src/handoffs.ts`
- `packages/ai-foreman/src/buildRuns.ts`
- `packages/ai-foreman/src/buildResume.ts`
- `packages/ai-foreman/src/adapters/claude.ts`
- `packages/ai-foreman/src/adapters/codex.ts`
- `packages/rafi/src/audit.ts`
- `packages/rafi/src/cli` and the live E2E harnesses

Also inspect the corresponding Zod contracts in `packages/spec`. Every new
persisted event, span, payload reference, replay request, replay result,
visualization record, and report must have an obvious versioned contract schema.

The implementation should be staged:

1. Define versioned event/span/payload/snapshot/replay contracts.
2. Add append-only payload storage and migration support.
3. Instrument missing QA and handoff boundaries.
4. Instrument the full create-to-completion CLI journey.
5. Add full-capture mode and E2E harness enforcement.
6. Add forensic query APIs and CLI JSON/Markdown reports.
7. Add visualization export format and a minimal timeline renderer.
8. Add isolated step re-execution with explicit safety gates.
9. Add historical/cohort analysis and performance regression tests.

## 14. Acceptance criteria

The work is complete only when all of the following are true:

- A successful Claude E2E run can be replayed step-by-step from local data.
- A successful Codex E2E run can be replayed step-by-step from local data.
- A failed, paused, resumed, and recovered run can each be inspected without
  corrupting or mutating the original run.
- Every lifecycle phase has a start/end timestamp or an explicit unavailable
  record.
- QA preparation, review, remediation, handoff, acceptance, and final QA have
  separate timings.
- Every span can be linked to its inputs, outputs, state, and evidence.
- Full-capture E2E mode retains complete provider and tool payloads locally.
- Normal mode keeps the detailed debugger view disabled.
- Playback preserves overlaps, pauses, retries, and uncertain completion.
- Individual steps can be re-executed only in an isolated new execution.
- Replay results are never mistaken for historical evidence.
- Diagnostic failure does not block or alter a build.
- Tests cover schema validation, crash recovery, retention, redaction/display
  boundaries, timing accuracy, nested-span accounting, playback, and replay.
- Fresh Claude and Codex E2E runs complete Builder work, independent QA, and
  independent fixture tests with full-capture logging enabled.

## 15. Risks and explicit warnings

- Full local indefinite retention can expose secrets, source code, credentials,
  personal data, and proprietary provider context.
- Provider/tool output may be extremely large; content addressing and storage
  quotas must avoid slowing or crashing builds.
- A forensic record is not necessarily a deterministic replay. External
  providers, clocks, operating systems, and dependencies can differ.
- Full capture must not weaken host authority, independent QA, contract
  validation, or recovery safety.
- Visualization must never imply causality or active work solely because two
  spans overlap; the underlying event and span relationships remain canonical.
- If a required data source is unavailable, the UI must show the gap rather
  than reconstructing or fabricating the missing value.
