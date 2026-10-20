# Rafi full-system reliability audit requirements

## Purpose

This document defines a system-wide audit of the real-provider build path:

```text
create → plan → ticket setup/population → validate → queue → start
→ Builder preparation → Builder work → Builder self-checks
→ independent QA preparation → independent QA → QA handback/remediation
→ final QA → completed build
```

The audit must explain, with evidence and timing, why a build passed, failed,
paused, repeated work, or became blocked. It must distinguish:

- a real product or provider failure;
- a missing or malformed contract/evidence record;
- a host orchestration or state-machine failure;
- a legitimate user decision point; and
- expected work that was merely slow.

The audit is diagnostic and improvement-oriented. It must not weaken
independent QA, host ownership of identity and evidence, rollback safety, or
provider-output validation in order to make a run appear successful.

## Immediate improvements to lock down

The audit implementation must make these improvements observable and durable:

1. **Host-owned command evidence.** Every Builder and QA command that matters
   to a contract must produce a small host-retained record containing the
   command classification, bounded output summary, exit status when available,
   start/end timestamps, duration, workspace/snapshot identity, and source
   digest. Providers may describe a command, but cannot create or alter its
   host evidence.
2. **Explicit RED/GREEN records.** If a contract requires test-first evidence,
   Rafi must retain a host event for the failing pre-change run and the passing
   post-change run, linked to the same ticket, attempt, command, and source
   lineage. A conversation-only claim is insufficient. If the host cannot
   capture the record, the system must report that precise limitation once and
   avoid repeated remediation loops.
3. **One cycle ledger.** Every QA review, finding, handback, Builder response,
   acceptance callback, and retry must receive a sequence number, timestamps,
   durations, source/contract digests, and an outcome. The ledger must make it
   possible to answer “why did cycle 5 happen?” without reconstructing a chat
   transcript.
4. **Snapshot lifecycle records.** A QA snapshot means a disposable code
   copy, not a browser or UI snapshot. Rafi must record when it was created,
   what source state it contains, how many files were copied/hashed, when it
   became immutable, when QA started and ended, and when it was deleted. The
   snapshot must never silently become the Builder workspace.
5. **Bounded, deduplicated context.** Repeated QA cycles must receive the
   existing contract, the current source digest, the exact unresolved findings,
   and only the bounded evidence needed to resolve them. Rafi must not resend
   the entire project or repeat already-settled findings unless the source,
   contract, or evidence basis changed.
6. **Clear cycle termination.** A finding that is unchanged, unresolvable due
   to a host limitation, or already disproven must not trigger an unbounded
   Builder/QA loop. The system must either close it, produce one actionable
   recovery decision, or stop with a precise needs-human reason.

These requirements authorize bounded host evidence and operational metadata.
They do not authorize global transcript retention, broad provider shell access,
unbounded output disclosure, or automatic waivers.

## Audit questions

### A. End-to-end run accounting

For each fresh Claude and Codex run, establish:

- a unique run ID, provider, model, reasoning setting, adapter version, Rafi
  version, Node/package-manager versions, and fixture repository;
- the exact command and environment policy used at each stage;
- wall-clock start/end times and durations for every stage and sub-stage;
- the ticket population, ordering, dependencies, risk, and effective contract
  for each ticket;
- every transition in run and ticket state;
- every provider turn, retry, compaction, handoff, interruption, timeout, and
  process exit;
- the final result: completed, failed, blocked, paused, or needs-human;
- independent fixture-test results, including their own exit statuses and
  durations.

The auditor must reconcile the user-visible log, durable run state, event log,
ticket database, recovery records, and provider evidence. Any disagreement
must be reported rather than silently choosing the most favorable source.

### B. Create, plan, and QA preparation

Verify that:

- the initial user request is preserved without provider reinterpretation;
- the plan identifies the correct project scope, files, dependencies, risks,
  rollback, required tests, and documentation requirement;
- documentation is false by default and is enabled only by explicit contract
  input or an explicit user/project decision;
- QA preparation runs when enabled, at the selected level, with the expected
  policy version and ceilings;
- the preparation result contains concrete, ticket-specific requirements,
  checks, evidence expectations, rollback expectations, and recovery options;
- host-owned fields—run ID, ticket ID, timestamps, source digests, contract
  digest, predecessor lineage, evidence IDs, and provider identity—are not
  supplied or overwritten by the provider;
- provider drafts are normalized into the durable contract without losing
  substantive requirements or inventing requirements;
- the preparation result is actually delivered to the Builder, not merely
  stored in a plan file;
- the Builder prompt clearly separates required work from optional suggestions;
- preparation does not impose unrelated sibling-ticket work, arbitrary
  documentation, branch-history requirements, or invented absence conditions;
- preparation duration is measured separately from provider generation,
  normalization, semantic validation, persistence, and delivery.

Required evidence: raw bounded provider draft, normalized candidate, validation
result, semantic-validation findings, final persisted contract, delivery
receipt, and timestamps for every transition.

### C. Ticket setup, population, validation, and queueing

Verify that:

- setup creates the expected durable tracker and does not accidentally reuse
  stale state from an older run;
- population preserves the authoritative plan and does not let provider text
  replace host-owned fields;
- Medium/High-risk tickets receive meaningful rollback plans;
- malformed or weak rollback plans receive bounded repair before population
  fails, with actionable recovery afterward;
- validators reject invented scope, contradictory acceptance criteria,
  impossible dependencies, and unsupported evidence requirements;
- explicit waivers are visible, scoped, and non-blocking unless policy says
  otherwise;
- validation records exact findings and does not mutate the ticket silently;
- queue ordering selects the first eligible, unblocked, non-terminal ticket;
- a ticket marked blocked for an old run cannot silently block a fresh run;
- regeneration, reset, resume, restart-current, and ticket reset have distinct,
  documented effects on durable state.

Measure each command and each database write. Record ticket status before and
after every operation, including the reason and actor for the transition.

### D. Start, recovery, and admission

Verify that:

- default start chooses the first eligible ticket;
- explicit current waivers warn but do not alone block start;
- admission ownership is released on rejected, crashed, timed-out, or
  cancelled worker launches;
- a start that appears to finish immediately is classified correctly as
  completed, blocked, paused, or failed;
- recovery resumes the intended run/ticket and does not accidentally select a
  stale ticket or old provider session;
- staged recovery handoffs always have a matching acceptance callback or a
  durable reason why acceptance could not occur;
- unconsumed staged handoffs are reported as recoverable handoff pauses, not
  generic build failures;
- a provider response naming no ticket is reconciled against the assigned
  ticket without corrupting ownership;
- the system does not stop in the middle of authorized work unless the user
  interrupts or a genuine terminal safety condition occurs.

Required timing fields include admission requested, worker launched, provider
session allocated, first provider output, turn completed, handoff staged,
handoff accepted, and recovery resumed.

### E. Builder preparation and delivery

Verify that the Builder receives, in one inspectable delivery:

- ticket identity and scope;
- the authoritative contract and its digest;
- QA-preparation requirements and their source;
- required tests and evidence rules;
- rollback plan and risk context;
- bounded prior findings, if this is remediation;
- the current source/contract lineage and any explicit user decisions.

The audit must prove that the Builder did not receive contradictory versions of
the contract, stale findings, provider-invented requirements, or a missing
instruction that later caused QA to reject the work.

Measure prompt construction, delivery, provider queue time, provider execution
time, tool-call time, response parsing, and persistence separately.

### F. Builder work and self-checks

For every ticket, determine:

- what files the Builder changed and whether they were within scope;
- whether the Builder followed the prepared requirements;
- whether tests were written/run in the required order;
- whether RED and GREEN evidence was captured by the host;
- whether the Builder checked its own acceptance criteria, rollback, and scope;
- whether the final response accurately described the work and limitations;
- whether the response claimed evidence that was not actually retained;
- whether the Builder left the ticket in the correct state.

The audit must compare the Builder’s claims to host evidence, not treat a
well-written response as proof. It must separately record source changes,
test results, evidence availability, and unresolved limitations.

### G. QA snapshot and independent QA

Verify the complete snapshot pipeline:

1. Builder source is frozen.
2. Host records the exact source manifest and digest.
3. A disposable review repository is created.
4. Staged, unstaged, and untracked files are materialized as intended.
5. The snapshot is independently verified against the frozen source.
6. QA receives the snapshot path and contract, not the mutable Builder path.
7. QA cannot write back into the Builder workspace.
8. Snapshot cleanup is recorded and does not delete user-owned work.

Measure file count, bytes, hashing time, copy time, verification time, provider
startup time, and cleanup time. Distinguish those mechanical costs from QA
model reasoning time.

For each independent QA review, verify that QA:

- received the exact contract and source digest it was meant to review;
- had enough bounded evidence to evaluate each requirement;
- ran the required independent tests itself;
- reviewed the actual snapshot rather than trusting Builder claims;
- preserved unrelated sibling work when the contract is additive;
- did not invent documentation, deletion, branch, or history requirements;
- classified each finding as passed, failed, blocked, not applicable, or
  needs-human with evidence;
- produced a complete report even when one check was blocked;
- returned a finding only when it is actionable and tied to the current source
  and contract.

### H. QA failure, handback, remediation, and final QA

For every QA failure, build a complete causal record containing:

- failure number and finding key;
- first timestamp and final timestamp;
- QA attempt, handoff generation, ticket, contract digest, and source digest;
- exact requirement/check that failed;
- whether the failure was behavioral, evidence-related, contract-related,
  provider-related, host-orchestration-related, or environment-related;
- the evidence QA used and its provenance;
- what QA handed back to the Builder, including requested action and scope;
- whether the handback was accepted by the host;
- the Builder’s response, files changed, tests run, and evidence produced;
- whether the next QA review saw the intended change;
- final disposition: fixed, repeated, superseded, blocked, waived, or
  needs-human;
- time spent waiting for provider output, executing tools, preparing the next
  snapshot, and validating the response.

The audit must answer for every cycle:

```text
What did QA say was wrong?
Was it actually wrong?
What exact work did Rafi ask the Builder to do?
What did the Builder actually do?
Did the source change as intended?
Did the evidence prove the change?
Why did QA pass, fail again, or stop?
Was another cycle necessary?
```

Special attention is required for:

- repeated identical findings;
- findings that change wording but not substance;
- QA requesting work outside the ticket;
- QA blocking solely because host evidence was not retained;
- handoffs staged without an acceptance callback;
- remediation that changes no source but still triggers another full review;
- provider sessions that spend most of their time rereading large context;
- final QA that reruns tests already proven without a source or contract
  change.

### I. Completion and independent fixture verification

Do not mark a live run successful unless:

- all required tickets are terminal-success;
- final independent QA completed and accepted the final source;
- the fixture’s own tests pass when run independently of the Builder and QA
  sessions;
- the test command, exit status, output summary, source digest, and duration
  are host-retained;
- the resulting completion state is persisted and visible through the normal
  CLI/API;
- no unresolved staged handoff, recovery record, or admission lease remains;
- the evidence path and run ID are reported.

## Additional audit areas

The following parts of Rafi were not the immediate focus but can create the
same symptoms and must be included:

### Provider adapters and runtime behavior

- model/provider selection and reasoning configuration;
- provider startup, authentication, rate limits, retries, timeouts, and exit
  status mapping;
- differences between Claude and Codex response envelopes;
- shell-policy denials and whether they are reported as provider failure or
  host failure;
- output truncation, parsing, normalization, and schema-validation loss;
- context size, compaction count, and repeated prompt growth.

### Persistence and state machines

- SQLite/YAML/event-log consistency;
- transaction boundaries and crash recovery;
- ticket/run status transitions and idempotency;
- stale leases, admission ownership, worker cleanup, and orphaned sessions;
- generation numbers, continuity IDs, recovery packet versions, and acceptance
  callbacks;
- restart-current, resume, fresh-session, and fresh-with-handoff semantics.

### Evidence, security, and disclosure

- host/provider authority boundaries for paths, hashes, IDs, timestamps, and
  status;
- bounded output limits and whether truncation is detectable;
- evidence retention duration and cleanup behavior;
- accidental disclosure of unrelated project files or global transcripts;
- shell permissions, command classification, and narrowly scoped exceptions;
- whether evidence can be replayed or tampered with after the fact.

### CLI and user experience

- whether progress messages accurately describe the current stage;
- whether “done,” “paused,” “blocked,” and “needs-human” are unambiguous;
- whether the user is told what action is required and why;
- whether a run picker can select an existing run without requiring internal
  IDs when a safe UI alternative is available;
- whether reset/regenerate operations explain what they overwrite or retain;
- whether Ctrl-C is the only normal user interruption of an active build.

### Packaging, releases, and compatibility

- package version alignment and publish order;
- built `dist` contents versus source contents;
- packaged CLI behavior from a clean install;
- migrations and backward compatibility for old run/ticket databases;
- tests that pass in the monorepo but fail when publishing or installing a
  package independently.

## Required audit data model

The audit output must be machine-readable or mechanically extractable. At
minimum, each event should contain:

```text
runId
ticketId (when applicable)
stage
actor                 host | builder | qa | provider | user
provider
model
attempt
cycle
handoffGeneration
contractDigest
sourceDigest
snapshotId (when applicable)
eventType
startedAt
completedAt
durationMs
status
inputBasisDigest
evidenceRefs
parentEventId
errorClass (when applicable)
summary
```

Durations must use a monotonic clock for measurement and wall-clock timestamps
for correlation. Missing timing or evidence must be represented explicitly as
`unknown`/`not-retained`, never inferred as zero or success.

## Required reports

Each audited run must produce:

1. **Run timeline:** a chronological stage and sub-stage table with start,
   end, duration, actor, status, and evidence reference.
2. **Requirement traceability matrix:** every prepared requirement mapped to
   the Builder instruction, Builder evidence, QA check, QA result, and final
   disposition.
3. **QA cycle ledger:** every review/handoff/remediation cycle with the exact
   cause, requested action, response, and outcome.
4. **Failure taxonomy report:** counts and durations by provider, stage,
   failure class, ticket risk, and whether the failure was avoidable.
5. **Evidence completeness report:** expected versus retained host evidence,
   including missing RED/GREEN records and snapshot manifests.
6. **Provider comparison:** Claude versus Codex for equivalent fixtures,
   separating provider latency from Rafi orchestration latency.
7. **State consistency report:** comparison of CLI output, tracker state,
   recovery state, event log, and final filesystem state.
8. **Recommendations:** prioritized fixes with regression risk, affected
   contracts, targeted tests, and whether user approval is required.

## Success criteria

The audit is complete only when it can demonstrate:

- every prepared requirement reached the Builder and independent QA;
- every QA failure has a specific, evidenced cause;
- every handback can be followed to the Builder’s response and next QA result;
- every material operation has timestamps and a duration or an explicit reason
  timing was unavailable;
- RED/GREEN claims are host-verifiable when required;
- snapshot preparation is not being mistaken for provider/model latency;
- repeated cycles are justified, bounded, and non-duplicative;
- a missing evidence record produces one actionable recovery path rather than
  a loop;
- Claude and Codex runs can be compared using the same stage definitions;
- no proposed optimization weakens independent QA, contract validation,
  evidence integrity, or host authority.

## Audit execution order

Run the audit in this order:

1. Inventory the event, run, ticket, recovery, provider, QA, and snapshot
   records already available.
2. Reconstruct the latest Claude and Codex live runs without modifying them.
3. Build the two run timelines and QA-cycle ledgers.
4. Trace each prepared requirement through Builder and QA.
5. Classify every failure and repeated cycle.
6. Compare provider latency, host orchestration latency, snapshot cost, and
   test execution cost.
7. Identify missing instrumentation and implement only the smallest safe
   host-owned evidence/timing additions.
8. Add regression tests for each discovered state transition or contract
   boundary.
9. Rerun equivalent Claude and Codex journeys in parallel.
10. Publish a before/after report. Do not claim improvement from a run that
    merely completed with weaker checks or less evidence.

