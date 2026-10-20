# Unexpected Build Exit Recovery Plan

## Problem

The moneyTree run reached preflight, then the recovery record automatically
approved plan updates and entered Builder work. The process stopped immediately
after `batch-start`, without a completed step, user prompt, blocker report, or
clean shutdown. The durable run record was left as `running` while the process
was no longer active.

This violates the expected Rafi behavior: an active build should continue until
the work completes, a real recoverable blocker is reported, or the user sends
Ctrl+C.

## Revised resolution

The existing supervisor already has bounded restart counters and deliberately
withholds retries when provider dispatch or remote side effects are uncertain.
The implementation must preserve that safety boundary. The goal is to prevent
silent termination, not to replay an unknown provider action.

1. **Reproduce and classify the disappearance first**

   - Instrument the boundary around `batch-start`, worker launch/registration,
     provider dispatch, worker exit, supervisor exit, signal handling, and final
     run publication.
   - Reproduce the moneyTree failure with a disposable fixture and determine
     whether the worker crashed, was signalled, lost its IPC parent, or the
     supervisor returned without cleanup.
   - Persist the classification and last durable checkpoint so an unexpected
     loss can never leave an unexplained `running` record.

2. **Make unexpected worker loss a supervised recovery event**

   - Detect when the Builder worker or supervisor disappears while the run is
     still `running`.
   - Persist a recovery checkpoint and reconcile the lease/ownership state.
   - Automatically restart only when no provider action was dispatched, or when
     the action has a proven idempotency boundary.
   - If dispatch status is uncertain, do not replay the provider turn. Pause
     with a durable, explicit recovery reason and an exact resume command.
   - If the frozen restart budget is exhausted, report a durable recoverable
     failure rather than silently returning to the shell.

3. **Do not silently choose plan approval during an interactive build**

   - A fresh interactive build must display the plan approval prompt before
     Builder implementation.
   - Persist the approval source: explicit interactive choice, explicit
     `--yes`, or legacy/unknown provenance.
   - Reuse `planUpdateApproval: auto` only for a current, explicitly authorized
     decision. Legacy or ambiguous approvals must prompt again.
   - Recovery must display whether approval was reused and why.

4. **Keep the build alive without hiding legitimate blockers**

   - Treat planning-only Builder output as an implementation retry, not as
     completion.
   - After `batch-start`, every path must either continue, perform a safe
     bounded recovery, or persist a clear resumable blocker.
   - Rafi must not silently return to the shell while work is still marked
     active. A genuine human decision, uncertain provider dispatch, exhausted
     restart budget, or unrecoverable startup/configuration error may pause or
     terminate the process, but must be durable, explicit, and actionable.
   - Ctrl+C remains the normal user-controlled interruption path.

5. **Repair stale run state safely on the next command**

   - When a run says `running` but its owner is inactive, verify process-start
     identity, lease ownership, supervisor state, and worker state before
     releasing anything.
   - Reconcile only an independently proven stale owner; otherwise preserve the
     run as uncertain and require recovery review.
   - Preserve the vendored StarNet checkout and all existing work.
   - Never mark T001 complete without live StarNet verification and independent
     project tests.

6. **Add regression coverage**

   Cover at least:

   - supervisor/worker loss after `batch-start`;
   - worker loss before dispatch, proving bounded automatic restart;
   - worker loss after uncertain dispatch, proving no automatic replay;
   - stale `running` records with inactive owners;
   - interactive recovery requiring a visible approval prompt;
   - approval provenance for interactive choice, explicit `--yes`, and legacy
     ambiguous state;
   - planning-only Builder output retrying implementation;
   - bounded worker restart and final recoverable failure;
   - supervisor/worker signal and IPC-loss cleanup;
   - Ctrl+C remaining the normal user-controlled interruption path.

## Immediate recovery

Do not resume the stranded run until the recovery changes and regression tests
pass. After that, from the moneyTree repository, resume the existing run using
the normal interactive command:

```sh
rafi resume /Users/tyler/reps/activeWork/moneyTree --run 08e0dda0-1834-433b-8056-053bcf7cda40
```

Use `--yes` only when intentionally running a non-interactive recovery and
recording that explicit authorization is acceptable. Keep StarNet running at
`http://localhost:8787`. Resuming uses the vendored checkout and existing
static tickets; it does not regenerate or replace the tickets.

Do not treat T001 as complete until Rafi performs the live task, status,
artifact, stop, reconnect, and disconnect checks and the independent project
tests pass.
