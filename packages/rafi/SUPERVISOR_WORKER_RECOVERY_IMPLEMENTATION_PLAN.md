# Supervisor and Worker Recovery Reliability — Implementation Plan

## Purpose

Make Rafi's supervised build lifecycle reliable across readiness, planning,
Builder execution, interruption, recovery, and completion.

The objective is not to guarantee that an operating system, provider, or
database can never fail. The objective is that Rafi:

- does not stop a healthy worker because of one transient persistence error;
- never silently loses a worker or mislabels the reason;
- never continues when ownership cannot be verified safely;
- resumes the same durable run without duplicate supervisors or ambiguous
  provider replay;
- distinguishes normal human pauses from worker/supervisor failures; and
- provides enough durable evidence to diagnose every transition.

No readiness, QA, provider, or handoff validation may be weakened to achieve
these outcomes.

## Confirmed current behavior

The relevant path is already implemented across:

- `packages/ai-foreman/src/supervisor.ts`
- `packages/ai-foreman/src/supervisedStart.ts`
- `packages/ai-foreman/src/workflowDb.ts`
- `packages/rafi/src/buildResume.ts`
- `packages/rafi/src/resumeLauncher.ts`
- `packages/ai-foreman/src/buildLaunchGate.ts`

The durable supervisor already owns worker generations, launch tokens,
heartbeats, process identity, readiness cleanup, and recovery checkpoints.
This work is a reliability correction to that existing system, not a rewrite
of the supervision architecture.

The primary confirmed defect is in `supervisor.ts`:

```ts
try { saveState(); } catch { this.requestStop(); }
```

A single failed supervisor-state write can request worker termination. The
failure reason is not retained, so the resulting worker-exit event can report
`stopRequested: true` with `source: "unknown"`.

MoneyTree evidence showed the worker reaching `ticket-selected`, then exiting
with `SIGKILL` and `stopRequested: true`. The first earlier stop was different:
it was an intentional durable pause for the pending plan-approval decision.

## Non-goals and safety boundaries

This plan does not:

- bypass independent QA;
- accept truncated or incomplete evidence;
- replay uncertain provider dispatches;
- grant broader provider shell or network access;
- delete or globally retain additional provider data;
- automatically kill a process whose identity cannot be verified;
- mark a supervisor dead merely because its database heartbeat is old; or
- make every human decision automatic.

If durable ownership cannot be confirmed after bounded recovery attempts, Rafi
must stop safely and create an actionable recovery state. “Never stop” means
“never stop silently or for a recoverable transient error,” not “continue
without ownership proof.”

## Phase 1: model and record stop causes

### Files

- `packages/ai-foreman/src/supervisedStart.ts`
- `packages/ai-foreman/src/supervisor.ts`
- `packages/spec/src/...` for any shared persisted state schema
- related workflow event types and serializers

### Changes

Define a closed set of supervisor/worker stop causes, including:

- `user-sigint`;
- `parent-sigterm`;
- `heartbeat-timeout`;
- `heartbeat-persistence-failure`;
- `readiness-failure`;
- `launch-failure`;
- `worker-exit`;
- `worker-disconnect`;
- `human-decision`; and
- `supervisor-process-exit`.

Every worker-exit, worker-reconciliation, supervisor-failure, and recovery
checkpoint must persist the cause, source process, generation, PID/process
identity where available, and the last durable checkpoint.

Do not use `source: "unknown"` when the supervisor itself initiated the stop.
Retain `unknown` only when the operating system or an external process truly
provides no evidence.

## Phase 2: make heartbeat persistence resilient

### Current risk

`DurableSupervisor` writes state from a ten-second interval. The callback is
synchronous, can overlap with other database writes, and immediately calls
`requestStop()` on any error.

### Changes

Implement a serialized heartbeat persistence mechanism:

1. Do not start a second heartbeat write while one is in flight.
2. Classify retryable SQLite errors, especially `busy` and `locked`.
3. Retry those errors with bounded backoff.
4. Preserve the latest heartbeat timestamp rather than queueing stale writes.
5. Record retry count and final failure reason in observability data.
6. Reset the retry state after a successful write.
7. Keep a hard deadline for ownership persistence.

The implementation may use a SQLite busy timeout, explicit bounded retries, or
both. It must not use an unbounded loop or blocking sleep that prevents signal
handling and worker cleanup.

When the deadline is exceeded:

- mark the supervisor state as degraded or recovery-required if possible;
- record `heartbeat-persistence-failure`;
- request safe worker shutdown;
- wait for process-group quiescence;
- mark the build recoverable with an exact reason; and
- never claim successful completion.

The worker may continue through transient database contention, but it may not
continue indefinitely when Rafi cannot prove ownership.

## Phase 3: reduce database contention safely

Audit all high-frequency and long-running database interactions around the
supervisor:

- heartbeat writes;
- status and attach commands;
- observation/audit writes;
- workflow publication transactions;
- readiness callbacks; and
- recovery inspection.

Use short transactions and avoid holding a write transaction across provider,
filesystem, process, or prompt work. Confirm that inspection paths use the
read-only workflow reader where appropriate.

Do not solve contention by disabling WAL, lowering durability, or suppressing
write failures without an ownership fallback.

## Phase 4: distinguish expected pauses from worker loss

The state machine must clearly separate:

- pending plan approval;
- pending Builder/QA human decision;
- normal worker completion;
- worker crash or signal termination;
- supervisor process exit;
- readiness cleanup failure; and
- database/ownership failure.

For a human decision:

- persist the decision and exact checkpoint before exiting;
- persist the supervisor as `waiting_for_human`;
- release only the appropriate runtime lease/admission;
- retain the run as recoverable;
- resume the same run after `build:decide`; and
- avoid creating a duplicate active run.

Recovery must not interpret a normal human pause as a lost worker.

## Phase 5: clarify `--yes` plan-approval semantics

The current approval gate requires stored plan approval for some `--yes` paths,
which is why a new MoneyTree build still stopped at “How does this plan look?”.

Decide and implement one explicit contract:

- interactive runs continue to require the plan decision;
- `--yes` approves the exact currently generated and validated plan, bound to
  its plan digest, ticket definitions, scope revision, and workflow
  consequences; or
- `--yes` remains insufficient, but Rafi must clearly state that a separate
  `build:decide` action is required.

Given the intended unattended/build workflow, the recommended behavior is the
second-stage exact approval: `--yes` may approve the current exact plan only
after host validation succeeds. It must not approve future plan changes or
changed ticket scope.

Add a contract test covering changed plan digest, changed ticket definition,
changed workflow consequences, and unchanged exact plan reuse.

## Phase 6: harden launch and recovery handoff

### Files

- `packages/ai-foreman/src/buildLaunchGate.ts`
- `packages/rafi/src/resumeLaunchGate.ts`
- `packages/rafi/src/resumeLauncher.ts`
- `packages/rafi/src/buildResume.ts`
- `packages/ai-foreman/src/workflowDb.ts`

### Requirements

Guarantee that:

- launch registration is acknowledged before provider work starts;
- a launch token is claimed exactly once;
- failed launches are retired deterministically;
- the supervisor generation and worker generation are persisted before work;
- a recovery child receives the exact frozen recovery decision;
- parent lease release cannot race child admission;
- startup timeout cannot kill a child that already completed registration;
- detached supervisor startup does not depend on the caller's terminal; and
- every launch outcome is one of `claimed`, `retired`, or `unknown` with a
  recovery instruction.

Audit signal forwarding in `resumeLauncher.ts` separately for attached and
detached operation. A parent SIGTERM must not accidentally terminate a
detached supervisor, while attached recovery must still forward user
termination correctly.

## Phase 7: reconcile stale runs and supervisors

Before starting or resuming a build, perform single-flight reconciliation:

1. Identify candidate supervisor rows and their recorded PID/process identity.
2. Verify process liveness and identity.
3. Check launch-token state and owned readiness processes.
4. Check unresolved provider dispatches.
5. Mark only verified-dead supervisors as stale/reconciled.
6. Refuse to start if ownership is live or unverified.
7. Never delete durable history or silently merge unrelated runs.

This must address the multiple stale/recoverable MoneyTree records without
blindly resetting them or selecting a different run.

## Phase 8: improve worker liveness and cleanup

Retain the existing safety model:

- verify PID and process-start identity;
- monitor worker heartbeats;
- terminate the owned process group on confirmed shutdown;
- wait for verified quiescence;
- reconcile readiness descendants;
- preserve uncertain provider dispatches; and
- restart only when the durable recovery rules prove it is safe.

Add explicit diagnostics for whether failure was caused by the worker,
supervisor, provider, readiness process, parent signal, or database.

## Phase 9: deterministic regression tests

Add injectable persistence and timing hooks to `DurableSupervisor` so tests can
force persistence failures without depending on timing-sensitive external
SQLite locks.

Add tests for:

- one transient heartbeat write failure followed by success;
- multiple retryable failures followed by recovery;
- persistent heartbeat failure causing a bounded safe stop;
- non-retryable persistence failure;
- no overlapping heartbeat writes;
- explicit stop-reason persistence;
- plan approval pause and same-run resume;
- exact `--yes` plan approval behavior;
- detached supervisor surviving parent exit;
- attached recovery signal forwarding;
- supervisor crash after readiness;
- worker crash after `ticket-selected`;
- launch registration/acknowledgement race;
- duplicate launch rejection;
- stale supervisor reconciliation;
- readiness descendant cleanup; and
- uncertain provider dispatch not being replayed.

Relevant suites:

- `packages/ai-foreman/test/supervisedStart.test.ts`
- `packages/ai-foreman/test/runtimeReadiness081.test.ts`
- `packages/rafi/test/resumeLauncher.test.ts`
- `packages/rafi/test/buildResume.test.ts`
- `packages/rafi/test/buildStartOver.test.ts`

## Phase 10: disposable end-to-end validation

Use a disposable fixture and run both Claude and Codex journeys with QA
enabled:

1. create;
2. plan;
3. ticket setup;
4. ticket population;
5. validate;
6. queue;
7. start;
8. approve or exact-auto-approve the validated plan;
9. complete Builder work;
10. run independent QA;
11. resolve any QA failure through the normal recovery path; and
12. run the fixture tests independently.

Inject one fault per run where safe:

- transient SQLite lock;
- parent process exit;
- worker interruption after readiness;
- supervisor interruption;
- readiness descendant cleanup; or
- recovery relaunch.

Do not call an E2E run successful unless Builder work, independent QA, and
independent fixture tests all complete.

## Verification and acceptance criteria

The implementation is complete only when:

- no transient heartbeat write causes an unnecessary worker stop;
- persistent ownership failure stops safely and reports the exact cause;
- normal human pauses resume the same run;
- `--yes` behavior is explicit and digest-bound;
- stale runs are reconciled without destructive cleanup;
- launch tokens and admissions do not remain unresolved after failed startup;
- worker process groups are verified quiescent before recovery claims safety;
- uncertain provider dispatches are never automatically replayed;
- focused tests pass;
- the full offline suite passes; and
- fresh Claude and Codex E2E journeys reach completed Builder work, independent
  QA, and independently passing fixture tests.

## Approval boundaries

No additional provider-output disclosure, global retention, shell access, or
network access is required by this plan. Any expansion beyond the existing
bounded evidence policy requires explicit approval before implementation.
