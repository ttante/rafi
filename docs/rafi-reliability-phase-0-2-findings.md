# Rafi reliability investigation: Phase 0–2 findings

Prepared 2026-10-12 from the focused reliability plan. This is the first review point: inventory, deterministic reproduction, disposable-repository field testing, and the initial performance baseline. It does not implement the repairs yet.

## Executive result

All seven reported problem areas are real or have a directly supported failure path. Five are reproduced end-to-end with the local Rafi CLI and scripted providers. The Claude Enterprise activity symptom is reproduced through its adapter/presentation logic but still needs one sanitized real event shape before its exact provider semantics can be classified. The slow publish gate is independently confirmed as an offline test-architecture problem, not a model-speed problem.

The most important result is that these are not one underlying failure:

- invalid `tickets plan` output bypasses its intended correction branch;
- ticket reads eagerly initialize workflow storage and can demand writer-safe migration;
- Manager diagnostics are keyed to build runs rather than the project;
- cleanliness policies differ by command and provide no consistent preserved-work continuation;
- Claude `tool_result` events lose the originating tool identity and collapse provider outcomes into a generic failure;
- the publish test command forces roughly 90 files through one serial lane; and
- successful branch execution can still be followed by a misleading unfinished `rafi status` result.

No original MoneyTree or MoneyFarm application files or Rafi state were changed by these tests. All state-changing scenarios ran in disposable copies under `/private/tmp/rafi-reliability-20261012.D7pNTp`.

The end-of-phase checksum comparison found the original application and durable Rafi files identical to the untouched baseline copies. The only filesystem difference was that each untouched copy retained the baseline `recovery.sqlite3-wal` and `recovery.sqlite3-shm` sidecars while those transient files were no longer present in the originals, plus the resulting `.rafi` directory timestamp. No command in this investigation opened the originals through Rafi; this distinction is recorded rather than treating transient SQLite sidecars as durable application drift.

## Scope and safety record

- Rafi source revision under test: `dfd64697f03700069c17140b7c93b0e56abcd737`.
- Local and globally installed CLI versions: `0.9.21`; all product tests used the locally built CLI explicitly.
- Runtime used for controlled testing: Node `20.19.0`. The shell default was Node `24.21.0`, so commands pin Node 20 to avoid mixing runtime effects with Rafi defects.
- Provider CLIs observed: Claude `2.1.296`, Codex `0.162.1`.
- Rafi's `spec`, `ai-foreman`, and CLI packages built successfully from source.
- Narrow baseline suites passed: 119 ai-foreman tests and 29 Rafi CLI/planning tests.
- Live planning and build work used local scripted provider binaries. No live implementation, QA, planning, or Manager conversation was intentionally run.
- During the first readiness probes, five commands reached the real Codex readiness executable before failing process cleanup. These may have consumed a minimal readiness request. The mistake was identified, disclosed, and all subsequent provider-facing scenarios were isolated behind scripted binaries.
- The original repositories remain outside the state-changing test lane. A path-bound MoneyFarm state-transfer rehearsal was not attempted because the supported export would write into the original repository.

Graphify was not used. Inventory, source tracing, database inspection, fixture execution, and tests were sufficient; no graph build or graph-assisted edit was necessary in these phases.

## Reproducibility table

| ID | Reported symptom | Result | Minimal evidence | Cause boundary |
| --- | --- | --- | --- | --- |
| R1 | `tickets plan` rejects empty `required_tests` | Reproduced | Full CLI run returned `tickets[NDT-12]/required_tests: must NOT have fewer than 1 items` | Proposal extraction validates and throws before the later repair branch |
| R2 | Medium-or-higher risk ticket lacks rollback notes | Reproduced | Full CLI run returned `tickets[NDT-01]: Medium risk ticket requires rollback/mitigation notes` | Same early validation path |
| R3 | Invalid priority enum | Reproduced | Full CLI run returned `tickets[TICKET-027]/priority: must be equal to one of the allowed values` | Same early validation path |
| R4 | No recovery command for invalid ticket plan | Reproduced | `rafi resume .` reported no unfinished build/interview; help has no `plan:doctor`; only a plan JSONL retained the failed session identity | Standard ticket planning does not create a durable repairable interview and error output gives no recovery route |
| R5 | Manager unavailable before a build | Reproduced | Fresh created fixtures returned `no build runs found for this project; start one with rafi start before opening Manager` | `projectDiagnostics` requires at least one build run ID |
| R6 | ai-foreman publish tests take too long | Reproduced | Normal suite took 22m 53s for 1,091 tests across 90 files with `--test-concurrency=1`; one offline case took 130.8s | Real waits, process/Git/SQLite fixture work, and generated matrices are serialized; ordinary tests do not use models |
| R7 | Claude prints repeated `tool failed - ... tool_result (TIME_ELAPSED)` | Partially reproduced; exact enterprise payload pending | Adapter maps `tool_result.is_error` directly to failed and presents the event name as `tool_result` | Call/result correlation and normalized timeout/recovery semantics are absent |
| R8 | MoneyTree queue demands a stopped, verified owner | Reproduced | `tickets validate`, `tickets show`, and `tickets queue` all returned the exact admission-upgrade error in independent copies | Read-only ticket commands eagerly open a migration-capable workflow database |
| R9 | Dirty work prevents continuation | Reproduced | Dirty noninteractive `create` and dirty branch start both stopped; branch start offered no safe alternative | Cleanliness gates are command-specific and build start only throws |

## Finding 1: ticket-plan validation cannot reach its own repair logic

The production validator correctly rejects all three known invalid proposals. The defect is control flow, not schema strictness.

In `packages/rafi/src/ticketPlan.ts`, the initial call to `extractTicketPlanProposal(...)` validates and throws immediately. The code that subsequently computes validation issues and asks the same session for a corrected response therefore cannot run for schema-invalid output. The equivalent general `rafi plan` workflow already has a bounded same-session repair loop, which is a useful internal precedent.

The full CLI reproduction used a scripted Codex session and one deliberately invalid proposal containing all three failures. It exited with `invalid planner proposal` and the expected issue list. No tickets were applied, which is the correct safety behavior.

Recovery is not durable enough:

- `rafi resume .` does not discover the failed ticket-plan session;
- the normal ticket-plan path does not write an interview record unless exhaustive questioning is enabled;
- the remaining `.foreman` JSONL contains lifecycle/session metadata but not a normal, user-facing repair operation; and
- the error does not point to any doctor or retry command.

An additional side effect was observed: the failed planning command updated timestamps in tracked `.rafi/install-manifest.json`, leaving the fixture dirty even though no plan was applied.

### Required repair contract

Keep the validator. Move issue extraction ahead of the throw, give the bound session a small number of response-only correction turns, and persist the proposal plus normalized errors before each turn. If correction is exhausted or interrupted, the error must end with a flagless `rafi plan:doctor` recovery instruction.

## Finding 2: a flagless planning doctor needs new durable session records

The requested doctor cannot be only a new command name over current data. Standard failed ticket planning currently leaves too little durable workflow state for reliable discovery and selection.

The repair needs a compact project-level record containing:

- workflow type (`create`, general plan, ticket plan, or population);
- provider and provider session identity;
- creation/update time and terminal state;
- source/ticket fingerprints;
- original response location or redacted copy;
- normalized validation errors and correction attempt count; and
- whether same-session continuation remains possible.

`rafi plan:doctor [project]` can then select the only relevant record automatically or show multiple records with workflow, short ID, state, provider, and relative age. Noninteractive invocation should list exact resumable commands instead of guessing. The default public surface should remain one top-level doctor; a `tickets doctor` alias can be decided after the interaction is demonstrated.

## Finding 3: Manager is artificially coupled to build history

On corrected clean-room fixtures with `.rafi`, `.tickets`, and project configuration but no `.foreman` history, Manager fails before provider conversation with:

```text
rafi: no build runs found for this project; start one with rafi start before opening Manager
```

The source and current tests encode this as intended behavior. On copies containing historical `.foreman` runs, Manager can enumerate those runs, demonstrating that project detection itself is not the blocker.

The repair should introduce a project-level diagnostic packet that is valid without a run ID. It should include installation, plan/interview, ticket validation/queue, provider readiness, dirty-state, and recovery findings. Build-, QA-, or finalization-specific actions can remain disabled until a valid run exists. Starting a consultation must not create a fake build or open writer databases just to satisfy the old abstraction.

## Finding 4: the publish delay is an offline test-layout problem

The ordinary `ai-foreman` package suite contains 90 files and many generated cases. Its package script explicitly uses `--test-concurrency=1`. Live provider suites are opt-in behind environment variables and were not enabled, so using faster models cannot shorten this gate.

The complete controlled run passed, but took almost 23 minutes:

| Metric | Result |
| --- | ---: |
| Tests | 1,091 |
| Passed | 1,079 |
| Failed | 0 |
| Skipped | 12 |
| TAP duration | 1,372.99 s |
| Wall time | 1,373.13 s (22m 53s) |
| User CPU | 808.20 s |
| System CPU | 346.53 s |

Older retained full-suite logs on the same machine took roughly 7m 32s–7m 49s for 591–596 tests. That is not an apples-to-apples performance regression because the current gate has grown to 1,091 tests, but it shows why the publish experience has become dramatically longer as coverage accumulated in the single serial lane.

The largest observed per-test costs in the serial baseline include:

| Time | Test behavior |
| ---: | --- |
| 130.8 s | actual supervised CLI hung-worker case |
| 11.9 s | denied process-inventory recovery case |
| 11.3 s | readiness redirected-stdio-child containment case |
| 10.3 s | generated prebuild Foreman/branch policy case |
| 9.9 s | resumed-operator errored full-review case |
| 9.6 s | generated Codex QA-guidance failure case |
| 9.4 s | generated Claude QA-guidance failure and QA report-recovery cases |
| 8–9.3 s each | many more QA guidance, prebuild, and recovery matrix cases |

The costs cluster in process lifecycle, temporary Git repositories/worktrees, SQLite recovery state, and crash/QA integration. These tests protect important behavior, so deleting them or moving all of them out of the publish gate would be unsafe.

The 130.8-second hung-worker case is a direct optimization target: it uses a 160-second test timeout to exercise real heartbeat and cleanup timing. Preserve one bounded process-level smoke case, but make the contract tests use a test-configured short threshold or controllable clock.

File-level isolation and parallelism are also necessary, but they are not sufficient. A single 205-line QA-guidance file generates dozens of slow production-wrapper cases and a 153-line prebuild file generates a 14-case Foreman/branch matrix; both are serial within their file. These matrices need measured sharding or bounded subtest concurrency in addition to shared immutable build artifacts, event barriers/fake clocks where wall time is not the subject, and separate reported lanes:

1. fast hermetic contracts;
2. offline process/migration/crash integration;
3. packaged-artifact verification; and
4. explicit live canaries.

A second expensive comparison was intentionally deferred until the implementation slice can pair it with timing instrumentation and a concrete isolation/parallelism change. The baseline run left no new supervised/provider fixture process behind; the previously identified Oct 8 orphan remained unchanged.

## Finding 5: Claude tool-result presentation loses essential semantics

Claude assistant `tool_use` events contain an original tool name and call ID. The later user-side `tool_result` event is currently emitted with the literal display name `tool_result`; it is marked failed whenever `is_error === true`. The activity layer prints every failed/error event as `tool failed`. No correlation restores the original name, and no normalized distinction exists among definitive failure, timeout, cancellation, provider progress, recovered retry, and unknown completion.

That path explains the reported output shape and why it can repeat while work continues. It does not prove that Enterprise `TIME_ELAPSED` is harmless; hiding all such events could suppress a genuine timeout.

Implementation should keep a bounded call-ID correlation map, normalize outcomes, and coalesce repeated recovered/transient events while retaining diagnostic detail. A sanitized real Enterprise event is still required before encoding the exact meaning of `TIME_ELAPSED`.

## Finding 6: MoneyTree's admission error is a read/write boundary defect

In a stateful MoneyTree copy, each of these independent commands failed with the same message:

- `rafi tickets validate`
- `rafi tickets show --all --json`
- `rafi tickets queue`

The copied recovery database is schema version 3. Its persisted admission owner refers to:

- PID `10817`;
- process start `Fri Oct 9 14:01:38 2026`;
- host `Tylers-MacBook-Pro-2.local`;
- a run ID and project path under the repository's former location; and
- heartbeat `2026-10-09T19:01:58.762Z`.

The current hostname/path do not match those stored values. Rafi correctly refuses to assert that this ambiguous remote/moved owner is dead. The unsafe response would be to remove the owner check.

The defect is that ticket inspection eagerly reaches `buildWorkMigration.ts`, whose migration checks writer ownership before any upgrade. `status` and storage doctor remain usable, proving the state can be inspected without stealing the lease. Read-only ticket commands should likewise open a non-migrating view and report any deferred upgrade separately. A build or explicit recovery operation can perform the backed-up migration once ownership is resolved.

The current message is also not actionable. When a mutating operation truly requires migration, Rafi should explain in ordinary language whether the owner is active, dead, remote/unverifiable, or corrupt and offer attach/status, graceful stop, automatic dead-owner reconciliation, or a flagless recovery doctor as appropriate.

## Finding 7: dirty-worktree behavior is inconsistent and incomplete

Two controlled reproductions demonstrate the gap:

- dirty noninteractive `rafi create` exits with a message to rerun interactively for exact-preimage capture or commit/stash first;
- dirty branch-per-ticket `rafi start` exits after listing modified and untracked paths, with no continuation choice.

Interactive create already has an exact-preimage concept, but this is not a shared policy. Build start's `ensureCleanBaseWorktree` simply throws. State export/import also reject dirty work with commit/stash guidance.

The user-facing policy should consistently offer:

1. preserve current changes and continue in Rafi-owned isolation;
2. explicitly include current checkout state as build input, when the delivery mode can preserve it safely; or
3. stop for manual commit/stash.

This is not a blind `--ignore-dirty` switch. Rafi must record the selected baseline, index and untracked-file digests, overlap risks, and the preservation boundary. The original controlled files were byte-for-byte untouched in the failed-start reproduction.

## MoneyTree field result

The stateful copy reliably reproduces the admission-upgrade failure. `rafi status` reports seven unfinished or recoverable historical runs with no verified active run and recommends build resume. Storage doctor is available. Failed read commands still create/remove SQLite sidecars or touch directory metadata, so commands described as read-only are not fully byte-read-only today.

The stored owner/path/host mismatch is sufficient to develop a legacy-owner fixture without mutating the original repository. No original-state confirmation is necessary for the first implementation slice.

## MoneyFarm field result

Stateful copies correctly reject their changed canonical path with:

```text
rafi: Build project identity requires explicit state-transfer rebinding
```

This is separate from MoneyTree's owner failure and should not be bypassed. The database is already at schema version 4 and has no current admission owner. Testing that exact state through normal CLI commands at a new path requires a supported export from the original repository; that write was intentionally not authorized.

Direct read-only fixture inspection found ten schema-valid tickets. T001 is stored as blocked with no specific blocker notes or last error; T002–T010 are dependency-blocked behind it. `rafi status` describes T001 as recoverable from a `branch-run-interrupted` checkpoint, so the likely normal action is resume, not a fresh start. The generic queue wording does not explain this relationship well enough.

## Clean-room and scripted-build result

A minimal repository completed `rafi create`, ticket initialization, validation, and queue using scripted Codex readiness. A one-ticket branch-per-ticket build then completed Builder and QA in about 10.6 seconds without a live model. This proves the fundamental offline path works and provides a stable integration fixture.

The first scripted QA response intentionally used a malformed evidence marker and was correctly rejected. Its recovery output exposed two secondary defects:

- the suggested recovery command used `ai-foreman start` instead of the user-facing `rafi start`; and
- it injected `--provider github` even though the selected completion mode was `none`.

After the corrected successful run, `rafi tickets queue` reported no remaining tickets, but `rafi status .` reported:

```text
ai-foreman: run is still in progress or did not finish
```

That is a new status/projection defect: a successful command, completed ticket, and retained branch are not reflected consistently by status.

Even with a zero-latency scripted provider, the run spent several seconds preparing and hashing a disposable QA snapshot and emitted repeated session/capability lines. This supports measuring setup and snapshot costs independently from model latency.

## Additional defects discovered

| Priority | Defect | Why it matters |
| --- | --- | --- |
| High | Successful branch build can be reported unfinished by `rafi status` | Users cannot trust completion/recovery guidance |
| High | Failed ticket planning dirties tracked install-manifest timestamps | A non-applied plan creates unrelated source noise |
| Medium | Failed QA recovery command names internal `ai-foreman` CLI and adds an irrelevant GitHub provider | Recovery instructions are wrong for the invoked Rafi workflow |
| Medium | Read-oriented commands touch SQLite sidecars and observability state | Inspection can change evidence and complicate backups |
| Medium | MoneyFarm blocked root ticket has generic, under-specified guidance | The user is told there is an external prerequisite but not that a recoverable run exists |
| Medium | Setup/readiness failure can occur after partial installation writes | A failed first command may leave a project half-created with no flagless repair action |
| Medium | Provider readiness cleanup is process-local and does not guide retry/reconciliation | Repeated commands can relaunch probes without resolving prior process state |
| Performance | Scripted one-ticket build has substantial snapshot/setup overhead | Model improvements alone will not address end-to-end latency |

A pre-existing orphaned Codex process was also found. Its command line matches the temporary fixture naming used by `supervisedStart.test.ts`, its parent is PID 1, and it predates this investigation. It has not been killed. This is evidence for a process-lifecycle regression test, not proof that every current test run leaks.

## Proposed implementation slices

The evidence supports the following order. Each slice should begin with the minimal regression fixture already established and stop at a reviewable contract boundary.

### Slice 1: read-only storage boundary and owner guidance

- Add a non-migrating workflow/ticket open path for validate, show, queue, status, storage doctor, and project diagnostics.
- Move work-admission migration to build/mutating preparation or explicit recovery.
- Add owner classification and plain-language actions without weakening writer exclusion.
- Verify against the exact version-3 remote/unverifiable MoneyTree fixture plus active, dead, PID-reused, corrupt, and interrupted migration cases.

### Slice 2: ticket-plan correction and durable failure records

- Refactor extraction so normalized issues are returned before a terminal throw.
- Add bounded same-session response-only correction.
- Persist failed/corrected planning records without dirtying the install manifest.
- Cover all three reported errors alone and together, exhausted correction, interruption, and valid-no-extra-turn controls.

### Slice 3: `rafi plan:doctor`

- Discover failed create/general-plan/ticket-plan/population records.
- Select one automatically or present an age-labeled list.
- Revalidate source fingerprints, repair locally when possible, and resume the original semantic session when needed.
- Put the exact doctor command in planner errors and normal doctor output.

### Slice 4: project-level Manager

- Build diagnostics from project state first and attach run evidence optionally.
- Make setup, planning, tickets, provider readiness, dirtiness, and recovery consultable before any build.
- Keep run-mutating actions gated on an actual valid run.

### Slice 5: truthful Claude activity

- Correlate call IDs to original tool names.
- Normalize completed, failed, timed-out, cancelled, recovered, and unknown outcomes.
- Coalesce repeated transient messages while preserving diagnostics.
- Finalize `TIME_ELAPSED` handling only after a sanitized Enterprise payload is available.

### Slice 6: preserved dirty-work continuation

- Centralize cleanliness classification and policy prompts.
- Implement Rafi-owned isolation as the recommended path.
- Add explicit-current-checkout input where safe, with digest/overlap recording.
- Exercise create, plan, tickets, start, resume, finalization, state transfer, and uninstall against staged, unstaged, untracked, conflicted, and overlapping changes.

### Slice 7: test performance

- Add per-file timing and child-process leak reporting first.
- Prove safe parallel groups; keep only demonstrated shared-state groups serial.
- Reuse immutable compiled/package fixtures and replace non-semantic sleeps.
- Retain a complete offline publish gate and keep live provider canaries explicit.
- Establish a regression budget from repeated cold/warm baselines after the first speedup.

### Slice 8: projection and recovery-message cleanup

- Reconcile successful branch completion with `rafi status` and ticket state.
- Generate recovery commands through the public Rafi CLI with only relevant options.
- Make Manager and doctor explain blocked ticket/recoverable-run relationships.

## Review gates before later phases

Offline source/test implementation can proceed after this review. The following still need explicit decisions only when reached:

1. permission to write a supported MoneyFarm state export in the original repository, if an exact relocated-state CLI test remains necessary;
2. permission and time/cost limits for a bounded Claude Enterprise payload capture and live Rafi canaries;
3. whether to expose `rafi tickets doctor` as an alias after the `plan:doctor` interaction exists; and
4. publish, commit, push, or cleanup authorization.

The next recommended action is Slice 1, followed immediately by Slice 2. Together they remove the two clearest hard stops while preserving Rafi's concurrency and ticket-quality protections.
