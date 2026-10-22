# Handoff: Complete Supervisor, Worker, and Recovery Reliability

## Handoff purpose

This document is for the next implementation agent continuing the supervisor and
worker-recovery work in Rafi.

The heartbeat-persistence portion of the recovery plan has been implemented and
audited. The remaining work is to complete the broader recovery contract without
weakening provider validation, independent QA, evidence validation, process
ownership checks, or uncertain-dispatch protection.

The intended outcome is:

```text
start/resume
  -> one verified supervisor owner
  -> one acknowledged worker launch
  -> durable worker and supervisor checkpoints
  -> explicit stop/reconciliation cause
  -> safe human pause or safe recovery
  -> same-run continuation when ownership is proven
```

“Never stop in the middle” must mean that Rafi does not silently stop or stop
for a recoverable transient condition. It must not mean that Rafi continues
after ownership, process identity, or provider-dispatch state becomes
unverifiable. In those cases Rafi must stop safely, preserve evidence, and give
an actionable recovery instruction.

## Current implementation status

### Already implemented in this work

The following changes are present and should be preserved:

- `packages/ai-foreman/src/workflowDb.ts`
  - Configures SQLite `busy_timeout = 5000` for the workflow database.
  - Applies the timeout to heartbeat persistence as well as the normal DB
    connection.

- `packages/ai-foreman/src/supervisor.ts`
  - Exports `persistWithBoundedRetry()`.
  - Retries only recognized SQLite contention (`SQLITE_BUSY`, `SQLITE_LOCKED`,
    or matching `database is busy/locked` messages).
  - Fails immediately for ownership changes and other non-retryable errors.
  - Serializes heartbeat persistence so interval ticks cannot overlap.
  - Waits for the last heartbeat task before closing the DB.
  - Calls `requestStop("heartbeat-persistence-failure")` after the bounded
    retry budget is exhausted.
  - Supports `onStopRequested` and injectable `heartbeatIntervalMs`.

- `packages/ai-foreman/src/supervisedStart.ts`
  - Receives the supervisor stop callback.
  - Preserves external signal causes such as `parent-SIGINT` and
    `parent-SIGTERM`.
  - Records the internal heartbeat failure cause as
    `heartbeat-persistence-failure`.

- `packages/ai-foreman/test/supervisedStart.test.ts`
  - Covers transient SQLite contention with bounded retries and no overlap.
  - Covers non-retryable ownership failure being rejected immediately.

Do not undo these behaviors by making all persistence errors retryable, by
removing the ownership check, or by swallowing the final persistence failure.

### Not yet fully implemented

The following parts of the larger plan remain incomplete:

1. A shared, closed, persisted stop-cause contract.
2. Consistent cause propagation through worker exit, supervisor exit,
   reconciliation, and recovery checkpoints.
3. Exact digest-bound `--yes` plan approval semantics across every resume path.
4. Complete stale-supervisor and stale-launch reconciliation before start or
   resume.
5. A full audit and hardening of attached/detached launch signal behavior.
6. Deterministic regression coverage for the above cases.
7. Fresh Claude and Codex disposable E2E runs proving Builder completion,
   independent QA completion, and independently passing fixture tests.

There is already partial implementation for some of these areas. The next
agent must audit the existing behavior before adding parallel abstractions.

## Required source audit before editing

Read these files and their tests first:

- `packages/ai-foreman/src/supervisor.ts`
- `packages/ai-foreman/src/supervisedStart.ts`
- `packages/ai-foreman/src/workflowDb.ts`
- `packages/ai-foreman/src/buildLaunchGate.ts`
- `packages/ai-foreman/src/buildAdmission.ts`
- `packages/ai-foreman/src/processIdentity.ts`
- `packages/rafi/src/buildResume.ts`
- `packages/rafi/src/resumeLauncher.ts`
- `packages/rafi/src/resumeLaunchGate.ts`
- `packages/rafi/src/buildStartOver.ts`
- `packages/rafi/src/buildRuns.ts`
- `packages/rafi/test/buildResume.test.ts`
- `packages/rafi/test/resumeLauncher.test.ts`
- `packages/rafi/test/buildStartOver.test.ts`
- `packages/ai-foreman/test/supervisedStart.test.ts`
- `packages/ai-foreman/test/runtimeReadiness081.test.ts`

Also inspect the shared persisted types in `packages/spec`, especially
supervisor state, workflow events, run snapshots, launch records, and recovery
decision receipts. If a new persisted field is needed, add it to the shared
contract rather than writing an untyped JSON convention in one package.

Before changing behavior, map each existing writer and reader of:

- supervisor state;
- worker-exit events;
- launch records and launch tokens;
- build admission and recovery admission;
- pending human decisions;
- workflow checkpoints;
- unresolved provider dispatches; and
- recovery decision receipts.

## Safety invariants

These are non-negotiable acceptance conditions:

1. Independent QA remains independent. Builder output cannot self-approve QA.
2. Truncated, incomplete, stale, foreign, or malformed evidence remains
   rejected.
3. Uncertain provider dispatches are never automatically replayed.
4. Provider output cannot override host-owned paths, hashes, process identity,
   launch tokens, run IDs, ticket IDs, or evidence locations.
5. A live or unverified supervisor is never marked stale merely because its
   heartbeat is old.
6. No recovery path deletes durable run history or silently merges runs.
7. Every child launch ends durably as `claimed`, `retired`, or `unknown`.
8. A human pause is not classified as a worker crash.
9. A worker or supervisor failure is not classified as a successful build.
10. Retry loops are bounded and must not block signal handling or cleanup.
11. No new provider shell, network, retention, or evidence-disclosure scope is
    introduced by this work.
12. Existing dirty worktree changes and unrelated plans must be preserved.

## Workstream A: introduce a shared stop-cause contract

### Problem

The current path can persist a worker-exit event with a generic source such as
`unknown`, even when Rafi itself initiated the stop. The current code also uses
several ad hoc strings (`parent-SIGINT`, `heartbeat-timeout`, `operator`, and
others) without one shared schema or a clear distinction between the cause,
the actor, and the evidence source.

### Required design

Define a shared persisted contract in `packages/spec` (or the existing shared
workflow contract location). Prefer a Zod schema if that is the repository's
established pattern. The contract should distinguish:

- `cause`: why the transition occurred;
- `source`: which component initiated or observed it;
- `actor`: user, supervisor, worker, parent, provider, database, readiness,
  or external/unknown;
- `runId`, supervisor generation, and worker generation;
- PID and process-start identity where available;
- checkpoint and timestamp;
- whether the stop was requested or observed after the fact; and
- bounded diagnostic detail.

Use a closed cause set including at least:

- `user-sigint`;
- `parent-sigterm`;
- `heartbeat-timeout`;
- `heartbeat-persistence-failure`;
- `readiness-failure`;
- `launch-failure`;
- `worker-exit`;
- `worker-disconnect`;
- `supervisor-process-exit`;
- `human-decision`; and
- `worker-reconciliation-required`.

Do not force a false cause merely to avoid `unknown`. Keep an explicit
`unknown`/`unclassified` observation only when the host genuinely provides no
stronger evidence, and document why it is unknown.

### Propagation requirements

Use the shared contract in all of these records:

- `worker_exit` event payloads;
- `worker_reconciliation_required` event payloads;
- `supervisor_process_exit` events;
- supervisor state when it is stopped, failed, or waiting for a human;
- launch failure/reconciliation records;
- recovery checkpoint projections; and
- final recovery outcomes.

The callback from `DurableSupervisor` should carry the typed cause, not an
arbitrary string. Signal handlers should map signals once at the boundary.
Internal persistence failure should remain distinct from a parent signal.

### Tests

Add tests proving that:

- heartbeat persistence failure is recorded as
  `heartbeat-persistence-failure`;
- parent SIGINT and SIGTERM retain their distinct causes;
- a normal human decision is recorded as `human-decision`;
- worker crash and worker disconnect are distinct;
- supervisor process exit records the last durable checkpoint;
- truly unavailable host evidence remains explicitly unclassified; and
- malformed or unknown persisted causes are rejected or migrated safely.

## Workstream B: finish exact `--yes` plan approval

### Current behavior to preserve and clarify

`packages/rafi/src/buildResume.ts` already contains plan-update approval
handling, including `--yes`, `--no`, interactive review, and persisted
`planUpdateApproval` metadata. The remaining task is to make the contract
explicit and digest-bound across all relevant resume and preparation paths.

The intended behavior is:

- interactive mode asks for approval when the current plan has changed;
- `--yes` approves only the exact currently generated and host-validated plan;
- the approval is bound to the plan digest, ticket definitions, scope
  revision, and workflow consequences;
- changing any of those inputs invalidates the approval;
- `--yes` does not approve future plan changes;
- corrected preparation arguments do not inherit stale `--yes` authority; and
- a noninteractive run without valid exact approval fails clearly before
  provider mutation.

### Implementation checklist

1. Identify the existing plan digest and scope-revision functions. Reuse them;
   do not create a second digest algorithm.
2. Define a shared approval receipt containing the exact bound inputs.
3. Validate the receipt immediately before implementation work starts.
4. Ensure the receipt is persisted before the provider receives implementation
   authority.
5. Ensure a changed ticket definition, changed ticket set, changed plan,
   changed workflow consequence, or changed scope revision invalidates it.
6. Ensure resume of an unchanged exact plan reuses the receipt without asking
   again when `--yes` was explicitly supplied.
7. Ensure `--yes` is not silently inherited from saved arguments after an
   argument correction or a new preparation retry.
8. Keep current-waiver behavior separate from a newly generated plan approval.
9. Print a concise actionable error naming the invalidated input and the
   required command/action.

### Required tests

Add or strengthen tests for:

- unchanged exact plan plus explicit `--yes`;
- changed plan digest;
- changed ticket definition;
- changed ticket set or scope revision;
- changed workflow consequence;
- stale receipt from another run;
- corrected preparation arguments dropping inherited `--yes`;
- interactive review choosing approval or rejection; and
- noninteractive missing approval refusing mutation.

The tests must verify that the provider is not invoked when approval is stale.

## Workstream C: complete stale supervisor reconciliation

### Existing partial behavior

`packages/rafi/src/buildResume.ts` contains `reconcileStaleSupervisor()`. It
only reconciles when all of the following are true:

- the selected run is not active;
- ownership is independently classified as `dead`;
- supervisor state says `running`; and
- a recorded supervisor PID exists.

It preserves unresolved dispatches by choosing either
`uncertain-worker-dispatch` or `unexpected-supervisor-exit`.

This is the correct conservative shape, but it needs to be audited against all
start/resume paths and launch-token states. Do not broaden it to “heartbeat is
old, therefore dead.”

### Required reconciliation sequence

Before `start`, `resume`, preparation retry, or recovery relaunch:

1. Select the requested run explicitly or apply the documented first-eligible
   selection rule.
2. Acquire the appropriate recovery/admission lease.
3. Read supervisor state and verify PID plus process-start identity.
4. Inspect worker PID/process identity and owned readiness descendants.
5. Inspect build-launch records and launch-token state.
6. Inspect unresolved Builder and QA provider dispatches.
7. If supervisor ownership is live, refuse a second owner.
8. If identity is unavailable or contradictory, refuse mutation and show an
   inspect/recovery instruction.
9. If ownership is proven dead, atomically mark only that supervisor stale.
10. Retire a launch only when the launch protocol proves that no child claimed
    it; otherwise preserve it as `unknown` and require reconciliation.
11. Re-read the run after reconciliation before launching anything.
12. Release the recovery lease only after the durable transition is committed.

### Multiple stale records

When several recoverable records exist, do not reset all of them and do not
silently choose a different run. The selected run must remain the selected
run. Other live or unknown runs must be reported. A stale supervisor can be
reconciled only for the exact selected run and only with verified-dead
ownership.

### Required tests

Add or strengthen tests for:

- live supervisor blocks a second start;
- dead supervisor is reconciled once;
- unknown process identity blocks mutation;
- stale heartbeat with live PID does not reconcile;
- stale supervisor with unresolved dispatch preserves the dispatch and pauses
  at `uncertain-worker-dispatch`;
- a claimed launch is not retired as an unclaimed launch;
- an unclaimed launch is retired exactly once;
- duplicate reconciliation is idempotent;
- another run's readiness cleanup blocks the selected run; and
- multiple stale/recoverable runs remain separately inspectable.

## Workstream D: audit launch registration and signal forwarding

### Components

- `packages/ai-foreman/src/buildLaunchGate.ts`
- `packages/rafi/src/resumeLaunchGate.ts`
- `packages/rafi/src/resumeLauncher.ts`
- `packages/ai-foreman/src/supervisedStart.ts`

### Required behavior

The launch protocol must be explicit:

```text
reserve -> spawn gate -> child registers -> parent acknowledges
-> child claims/starts work -> outcome is claimed/retired/unknown
```

Verify all race windows:

- parent dies before child registration;
- child dies before registration;
- child registers but parent dies before acknowledgement;
- acknowledgement is sent but durable claim fails;
- child claims and then exits;
- startup timeout fires after registration; and
- child disconnects while the launch is unresolved.

For attached recovery:

- SIGINT/SIGTERM from the user must reach the active child/supervisor;
- handler cleanup must always run;
- a child that already registered must not be treated as unspawned merely due
  to a parent-side timer race.

For detached recovery:

- the supervisor must not depend on the caller terminal remaining open;
- the caller must not forward a later unrelated signal to the detached
  supervisor; and
- startup failure must leave an actionable durable launch state.

Do not grant the child provider authority before registration and acknowledgement
are complete.

## Workstream E: cleanup and liveness diagnostics

Preserve the existing PID/process-start identity checks and owned process-group
cleanup. Improve only the evidence and deterministic handling:

- identify whether the worker, supervisor, provider, readiness process, parent,
  or database caused the transition;
- record whether readiness was active and whether cleanup was verified;
- record whether the worker group was verified quiescent;
- record unresolved dispatch idempotency keys;
- record launch-token state; and
- retain the last durable checkpoint.

If process identity is unavailable, report that limitation. Never turn
unavailable identity into a positive ownership claim.

On confirmed shutdown, wait for verified process-group quiescence before
claiming the run is safe to restart. If cleanup remains unresolved, pause with
an explicit recovery action. Do not automatically kill unrelated processes.

## Workstream F: deterministic test harness and regression matrix

Use injectable clocks, sleep functions, persistence functions, process identity
probes, child launchers, and signal sources wherever possible. Avoid tests that
need real timing or global process visibility unless they are explicitly marked
as integration tests.

Required focused coverage:

- `packages/ai-foreman/test/supervisedStart.test.ts`
- `packages/ai-foreman/test/runtimeReadiness081.test.ts`
- `packages/rafi/test/buildResume.test.ts`
- `packages/rafi/test/resumeLauncher.test.ts`
- `packages/rafi/test/buildStartOver.test.ts`

Minimum matrix:

| Scenario | Expected result |
| --- | --- |
| One transient SQLite busy error | Retry, worker continues |
| Repeated SQLite busy errors within budget | Retry, then recover |
| Persistent heartbeat failure | Bounded safe stop with exact cause |
| Ownership changed | Immediate fail-closed stop |
| Human decision | `waiting_for_human`, same run recoverable |
| Parent SIGINT | Explicit user stop cause |
| Parent SIGTERM | Explicit parent termination cause |
| Worker crash after readiness | Cleanup/reconcile before restart |
| Supervisor crash after readiness | Stale reconciliation only after identity proof |
| Unresolved provider dispatch | No automatic replay |
| Claimed launch | Never retire as unclaimed |
| Unclaimed launch | Retire exactly once |
| Unknown ownership | No mutation; inspect/recovery guidance |
| Exact unchanged plan with `--yes` | Provider may proceed |
| Changed plan with old `--yes` receipt | Provider blocked; fresh approval |

## Verification commands

Run from the repository root with the repository's supported Node/pnpm setup.
Preserve logs under `/private/tmp` or another disposable location.

Suggested sequence:

```text
pnpm --filter ai-foreman typecheck
pnpm --filter ai-foreman build
pnpm --filter @rafi-ai/cli test
pnpm --filter @rafi-ai/cli typecheck
pnpm --filter ai-foreman test
git diff --check
```

Use the actual package name from `package.json` if the CLI filter differs.
Run focused tests first after each workstream, then the package suites. A full
offline-suite failure caused by host process-identity/IPC restrictions must be
reported as an environment limitation, not “fixed” by weakening ownership
checks.

## Live E2E acceptance

After focused and package tests pass, use fresh disposable fixtures for both
providers. Run Claude and Codex in parallel only if each has isolated project,
database, logs, provider session, and temporary directories.

Each journey must reach all of:

1. create;
2. plan;
3. ticket setup;
4. ticket population;
5. validate;
6. queue;
7. start/resume;
8. completed Builder work;
9. Rafi-launched independent QA;
10. final QA acceptance; and
11. independently executed fixture tests passing.

Record for every run:

- provider and model/reasoning configuration;
- run ID and ticket IDs;
- exact command lines;
- stage start/end timestamps and durations;
- worker/supervisor generations;
- launch and admission outcomes;
- every QA failure and recovery handback;
- final Builder and independent-QA evidence; and
- fixture-test command and result.

Do not report E2E success if only the provider responded, if Builder stopped at
a plan, if QA was skipped, or if fixture tests were not run independently.

## Failure triage rules for the next agent

When a test or E2E run fails:

1. Identify the exact stage and first durable event showing the divergence.
2. Compare host-owned state with provider output.
3. Determine whether the issue is a contract violation, ownership ambiguity,
   launch race, provider behavior, environment limitation, or test fixture.
4. Fix only obvious in-scope defects that preserve the safety invariants.
5. Add a regression test before rerunning the full journey.
6. Do not weaken validation, evidence completeness, independent QA, or
   process-identity checks merely to make the run advance.
7. If the proposed fix changes disclosure, retention, shell/network authority,
   or destructive recovery semantics, stop and ask for approval.

## Definition of done

The remaining work is complete only when:

- all persisted stop causes use one validated shared contract;
- internal and external stop causes are distinguishable;
- transient heartbeat contention does not stop a healthy worker;
- persistent ownership failure stops safely with exact evidence;
- human pauses resume the same run without duplicate ownership;
- exact `--yes` approval is digest-bound and cannot authorize changed work;
- stale supervisors are reconciled only after verified death;
- launch outcomes are deterministic and race-safe;
- attached and detached signal behavior is tested;
- readiness cleanup and process-group quiescence remain fail-closed;
- uncertain provider dispatches are never replayed automatically;
- focused tests and package tests pass in a supported environment; and
- fresh Claude and Codex journeys complete Builder work, Rafi-launched
  independent QA, and independent fixture tests.

## Important handoff warning

Do not describe the heartbeat patch as completion of the entire supervisor
recovery plan. It fixes one confirmed failure mode: transient or bounded
heartbeat persistence contention no longer immediately kills the worker, and
non-retryable ownership failures remain fail-closed. The shared cause model,
exact approval contract, complete stale-run reconciliation, launch race audit,
and live end-to-end proof still require implementation and verification.
