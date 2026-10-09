# Build resume gap implementation plan

Status: section 12 records the latest integration-gap repairs and the runtime defects their tests exposed. Section 11 supersedes conflicting migration statements in section 10. Earlier sections retain historical evidence. Native Windows and Linux verification remain pending; the user approved preparing CI and leaving Windows verification open. No commit or publication was performed.

This supplements `build-stall-repair-plan.md` and `qa-handback-implementation-plan.md`. Its scope is the three findings from the subsequent resume audit and the additional failure cases discovered while reviewing their resolutions. Preserve the existing, uncommitted QA recovery and resume work. Do not repeat that implementation or change unrelated planning documents.

## 1. Agreed behavior

- `rafi resume` and `rafi build:resume` select unfinished work in the current project. An explicit project argument selects that project. Do not add machine-wide discovery.
- Unfinished preparation is discoverable even before a full build snapshot exists. The latest unfinished attempt remains available, including failed launch and uncertain ownership states.
- An approved, unchanged scope starts automatically. Material scope changes use the existing approval flow. Retrying does not create new approval authority.
- A blocked ticket does not prevent eligible independent tickets from proceeding under the frozen policy. Pause when no eligible work remains.
- A retry must not start duplicate preparation or implementation. Active work is inspectable; unknown ownership or provider execution requires reconciliation before another writer starts.
- Recovery instructions remain short and open the owning project. Keep exact ticket/revision/handoff handling internal without weakening its validation.

## 2. Findings and current evidence

| Finding | Pre-implementation evidence | Required result |
| --- | --- | --- |
| F1: retrying preparation leaves the old attempt replayable | `packages/rafi/src/buildResume.ts` acquires a lease, checks partial evidence, releases it, and calls `executeStart(args)` without a successor link or supersession | One durable successor per predecessor; repeated/concurrent retries resolve to that successor |
| F2: live preparation can look inactive | `supervisedStart.ts` saves arguments but the disabled-supervisor path has no durable process owner; `createBuildRun` publishes before acquiring the implementation lease | Ownership starts before readiness/provider work and persists across preparation, launch, and implementation |
| F3: short recovery instructions can target the wrong project | Bare `rafi resume` strings appear in `cli/start.ts`, `qaReview.ts`, and `branch/runner.ts`, even when the project differs from the caller's working directory | Shared formatter emits a short command with the owning project path when necessary |

Related gaps verified in the same code review:

1. Picker liveness and lease admission disagree about expired heartbeats, unknown process identity, and foreign hosts.
2. Heartbeat/release helpers read the latest lease by run ID, allowing a stale caller to use a replacement owner's token.
3. Lease generation can reset after deletion; generation alone cannot identify an ownership incarnation.
4. The supervisor deliberately does not own the worker mutation lease. Giving both the same early lease would cause self-conflict.
5. `runSelfCommandStatus` uses `spawnSync`; parent JavaScript timers cannot maintain ownership during its wait.
6. Manual preparation retry and supervisor preparation restart use different eligibility checks. Absence of a full snapshot is not proof that nothing executed.
7. Saved argv does not preserve approvals, frozen policy, or consumed recovery budgets. It may contain stale internal recovery arguments.
8. JSON publication happens outside the database transaction. Stale projections must not resurrect superseded or terminal records.

The two reported production QA failures occurred on another computer. Their original records are unavailable; this plan uses code evidence and reproducible local scenarios, not a claim to have reconstructed those incidents.

## 3. Correctness contract

Use these invariants as acceptance criteria for every task:

1. At most one admitted execution lineage can control a project; only its currently authorized worker can dispatch or mutate. Supervisor coordination and worker mutation are distinct authorities.
2. Every ownership-sensitive operation receives the caller's original token. It never obtains authority by reading whichever token is current.
3. Authority is checked atomically with the durable mutation or dispatch-intent reservation. A preflight check outside the transaction is insufficient.
4. A stopped local process does not prove its provider operation or descendants stopped. Preserve uncertain dispatch and reconcile it before replay.
5. Retry lineage, launch intent, and predecessor supersession commit together or not at all. Child execution requires a matching, claimable launch record.
6. Database state wins over JSON projections; historical evidence, budget consumption, approvals, and QA dispositions survive retry and migration.
7. QA still requires an independent, current-source-bound pass. Metadata repair, retry, and fresh QA fallback cannot approve code or replay uncertain Builder work.
8. Picker inspection and cancellation do not acquire mutation authority, import/migrate records, publish projections, or launch providers. Preserve explicitly requested interview discard behavior.
9. Unknown ownership is visible and actionable, never represented as verified inactivity. Heartbeat age alone does not authorize takeover.
10. No claim of exactly-once external execution: enforce durable intent, exclusive claim, and conservative recovery when dispatch outcome is unknown.

## 4. Implementation sequence

Each task includes desired-behavior tests. Run them and the affected existing suites before proceeding. Do not retain unsafe compatibility fallbacks merely to keep a test green.

### T0 — Establish the baseline and mutation inventory

1. Inspect repository instructions, status, and relevant diffs; preserve all prior and unrelated work. Record the baseline commit plus working-tree changes.
2. Use the installed supported runtime matching native SQLite (Node 20.19.0 was previously usable). Record versions. Do not install dependencies or rewrite the lockfile to mask environmental failures.
3. Reproduce F1 with repeated and simultaneous retries, F2 with a real unsupervised child stopped in preparation, and F3 by starting project B from directory A.
4. Inventory all start/admission paths and mutation consumers: normal, unsupervised, detached, embedded API, build resume, supervisor restart, branch execution, start-over, checkpoint, heartbeat, release, publication, and provider dispatch. Record the owning API and regression test for each in the implementation results.
5. Identify every persisted policy, approval, restart counter, and recovery allowance used by those paths. Map whether it is run-scoped, ticket-scoped, or lineage-scoped before changing retry behavior.

Acceptance: reproducible desired assertions for F1–F3, baseline results, and a complete call-site inventory. Existing failures are recorded separately.

### T1 — Add durable ownership and retry storage primitives

Primary surfaces: `workflowDb.ts`, `workflowReader.ts`, `processIdentity.ts`, relevant spec types/schema, and database tests.

1. Add versioned storage for a project admission reservation, distinct worker authority, retry predecessor/successor links, and launch attempts. Prefer additive migration through existing migration infrastructure.
2. Admission identity contains canonical project, run/lineage, host, PID/start identity, unique incarnation, phase, and heartbeat. Use an unrepeatable incarnation token in addition to any numeric generation. Releasing and reacquiring must never revive an old token.
3. Launch records bind predecessor/successor, canonical project, validated argument digest, frozen configuration/scope reference, launcher incarnation, intended role, claim state, and claimant identity. Distinguish each launch attempt from its successor run.
4. Enforce unique successor-per-predecessor and single current launch claim in storage, not only application checks. Reject cycles, cross-project links, conflicting claims, and invalid transitions.
5. Add conditional transaction APIs for admission, transfer, launch intent/claim, mutation fencing, heartbeat, release, and terminalization. Return typed stale-owner/unknown-owner/invalid-state results with useful diagnostics.
6. Centralize process classification as live/dead/unknown with reason. Known PID reuse means the recorded process is gone, but still requires descendant/dispatch reconciliation. EPERM, missing identity, foreign host, and incomplete inventory remain unknown. Parse Linux process identity robustly when names contain spaces/parentheses; preserve supported historical identities.
7. Make migrations idempotent and transactional. Legacy ownership without enough identity is unknown, not automatically transferable. Do not infer retry links from similar timestamps or argv.
8. Keep read-only readers capable of interpreting older schemas without creating tables. Mutation entry points migrate before admission. Explicitly reject unsupported future schema versions rather than silently dropping state.

Tests: migration twice; interrupted migration rollback; legacy/empty/current databases; unique successor races; invalid link cycles; token reuse after release; same PID/different incarnation; foreign hosts; identity unavailable; process-name parsing; read-only inspection before migration.

### T2 — Enforce ownership throughout the real lifecycle

Primary surfaces: `supervisedStart.ts`, `supervisor.ts`, `cli/start.ts`, `buildRuns.ts`, `buildStartOver.ts`, provider dispatch/publication callers identified in T0.

1. Admit and register the run before readiness, provider dispatch, or workflow mutation. Read-only argument/config loading can precede admission; revalidate its digest when freezing the launch. Avoid holding a database transaction while prompting, spawning, or awaiting providers.
2. All entry modes participate in the same admission transaction. A live unsupervised preparation must block a supervised start and vice versa. Existing legacy leases/supervisors remain part of admission checks during migration.
3. Separate the coordinator reservation from the worker mutation token. The parent authorizes transfer, the intended supervisor/worker atomically claims it, and the predecessor loses the transferred authority. No release-then-unowned launch window.
4. Record worker-generation authorization before spawn and let the child claim before work. A fast child must not depend on the parent's later `workerPid` write. Never treat an environment variable alone as authority.
5. Transition preparation to implementation under existing valid worker authority. Acquire/validate it before publishing the full running snapshot. Update `createBuildRun` and `resumeBuildRun` to accept the legitimate context without reacquiring against themselves.
6. Pass explicit authority through heartbeat, save, finalization, release, role-dispatch and checkpoint paths. Stale callers cannot borrow current authority by run ID, overwrite current state, release a successor, or submit new work. Separate historical import/projection repair APIs from authorized runtime mutation; do not make runtime authority optional as a shortcut.
7. Fence durable publication intent and reconcile interrupted file publications from database truth. Guard final publication against stale ownership/version and retain authoritative DB precedence if a crash leaves an older JSON file. File projection writes must never confer execution authority.
8. Replace synchronous waiting on the resume-to-start launch path with asynchronous spawn/wait, preserving inherited terminal I/O, exit status, spawn errors and signal forwarding. The parent maintains its coordinator reservation until the durable transfer is claimed, then stops acting as owner. Leave unrelated synchronous subprocess helpers alone. Do not rely on blocked JavaScript timers.
9. Cover success, preparation failure, provider error, SIGINT/SIGTERM, detached launch, parent death, worker death, and storage errors. Release only the caller's authority. Leave durable interrupted/unknown state when cleanup cannot be proven.
10. Fence future dispatch, but do not assume that fencing stops an already-running external operation or filesystem writer. Reconcile/stop owned process groups and unresolved provider dispatch before replacement execution. Unknown ownership produces a visible reason and the specific evidence needed to resolve it; do not add an unsafe force-unlock shortcut.
11. Keep supervisor restart counters and independent-ticket behavior intact. Lease heartbeats must remain lightweight; do not turn each heartbeat into migrations or full snapshot publication.

Tests: two actual competing processes across supervised/unsupervised modes; embedded admission; detached transfer; fast child claim; delayed heartbeat on a live process; stale owner's heartbeat/save/release/dispatch; phase transition without self-conflict; old process dying after transfer; orphan descendants; unresolved remote dispatch; start-over while active/unknown; crash during projection publication; terminal cleanup; asynchronous launcher exit codes, spawn errors, signal forwarding and inherited terminal input.

### T3 — Make preparation retry atomic and idempotent

Primary surfaces: `packages/rafi/src/buildResume.ts`, `supervisedStart.ts`, T1 database APIs, internal start parsing/launch integration.

1. Share one structured eligibility assessment between manual retry and supervisor restart. Inspect the selected run's operations, unresolved dispatches, sessions/continuity, QA protocol/recovery state, handoffs, decisions, role leases, branch records/work, incomplete publications, and implementation evidence. Return eligible, established-work, or reconciliation-required with reasons.
2. Scope checks to the selected run; unrelated historical branch sessions must not block a clean retry. Unattributable legacy evidence remains explicitly uncertain. Reconcile eligible incomplete publications before reassessing; never treat a missing snapshot as sufficient evidence.
3. Under admission and one transaction, re-read eligibility and authority, follow any existing successor, or create exactly one successor, preserve lineage state, mark predecessor superseded, and authorize launch. Release transaction before spawn. Concurrent callers discover the committed successor and never spawn independently.
4. Preserve approved scope and frozen autonomy policy by durable reference or validated copy. Account for consumed restart/recovery allowances across lineage; changing run ID cannot refill them. Keep attempt-local telemetry distinct. Material scope changes require the existing approval flow; `--yes` cannot silently bypass it.
5. Validate saved arguments against canonical project and supported options. Strip old internal run IDs, launch claims, recovery digests, and mode receipts, then issue current internal authorization. Handle explicit overrides through normal validation and policy/approval rules. Invalid or incomplete legacy arguments require a clear diagnostic; do not invent an approved scope.
6. Persist the launch transition before spawn. Child claim validates project, run, incarnation, role, argument/config digest and one-time authorization. Duplicate/stale/wrong-project children exit before readiness or dispatch.
7. A definite spawn failure keeps the successor visible and retryable. Reuse that successor with a new fenced launch attempt only after proving the prior attempt cannot execute. Parent death, missing acknowledgement, and an unclaimed record alone are not that proof.
8. Explicit old run IDs follow validated successor links. A completed successor is reported completed; a live successor is inspected; an unknown successor is reconciled. Never replay the predecessor. Resolve chains with cycle detection and project checks.
9. Keep normal established-work recovery on its existing validated session/QA path. Supervisor retry of the same run uses the shared eligibility/launch mechanisms and existing budgets; it need not fabricate a new run for every worker restart.

Required launch-state cases:

| Durable state / observation | Allowed next action |
| --- | --- |
| Successor reserved; launch never attempted, creator dead and fenced | Authorize a launch of the same successor |
| Launch intent written; launcher died around spawn | Reconcile; no automatic second launch based only on absent claim |
| Spawn definitively failed before creating a child | Record failure; allow a new authorized attempt for the same successor |
| Child claimed; parent acknowledgement missing | Use child's authoritative ownership; no duplicate |
| Child died after claim | Reconcile descendants/dispatch; choose established recovery or safe preparation restart |
| Successor terminal | Report terminal outcome; retain predecessor history |

Tests: repeated old-ID retry; competing retry processes; failure before/after transaction commit, before/after spawn, before/after claim and acknowledgement; lost IPC; bad digest/expired claim; preserved budgets/policy/approval; changed tickets; branch/QA evidence; interrupted publication; legacy unlinked records; successful retry appears once.

### T4 — Make discovery consistent and project-scoped

Primary surfaces: `buildRuns.ts`, `workflowReader.ts`, `packages/rafi/src/resume.ts`, `buildResume.ts`, start-over projections.

1. Derive live/dead/unknown status from T1's shared classifier and both coordinator and worker ownership. Keep unknown distinct in the public projection; do not squeeze it into a false `active` boolean.
2. Use read-only readers for selection and inspection. Audit `new WorkflowDb` in preview paths and interview cleanup during picker listing for unintended writes; move necessary migration/cleanup to explicit mutation paths.
3. Apply database terminal/superseded status even when durable state is partial and stale JSON exists. Hide superseded duplicates in ordinary choices, retaining explicit-ID history and successor navigation. Define cancelled records as terminal unless the existing contract explicitly provides recovery.
4. Include incomplete preparation, failed launch, paused and unknown attempts. Sort deterministically by durable activity time with a stable tie-breaker; inspection must not refresh that time. Preserve mixed build/interview selection and completed interview exclusion.
5. Keep selection within the requested canonical project. Revalidate selection, authority and recovery revisions at action time to handle completion/transfer after the menu opens.
6. Preserve no-flag TTY selection, explicit-ID non-TTY behavior, cancellation, ambiguous-prefix errors, incompatible interview diagnostics, and explicit interview discard. Do not auto-start the most recent entry merely because it is listed first.

Tests: legacy/current mixed inventory; DB terminal + stale JSON; latest incomplete attempt; equal timestamps; active/unknown selection; menu cancellation without DB/file writes; changes while menu open; current project A never lists project B; symlink aliases; existing interview resume/discard and start-over tests.

### T5 — Centralize short, correct recovery instructions

Primary surfaces: `cli/start.ts`, `qaReview.ts`, `branch/runner.ts`, resume command integration and CLI docs.

1. Add a shared formatter accepting owning project root, command family, and caller working directory. Avoid a reverse dependency from ai-foreman to the Rafi CLI package.
2. For Rafi, emit `rafi resume` when the caller resolves to the owning project; otherwise emit `rafi resume '<absolute owning project>'` with correct supported-shell quoting. Never substitute a QA snapshot or ticket worktree for the owning project.
3. Preserve standalone ai-foreman recovery behavior and its supported command syntax. Do not infer the command family from incidental text; pass explicit context through common call sites.
4. Replace all affected recovery guidance, including thrown errors and branch finalization failures. Preserve useful uncertainty/blocker reasons alongside the command. Do not print hidden receipt/revision flags in normal guidance.
5. Keep diagnostic logs intelligible outside their original directory by recording the owning project with the run. Document that bare resume is project-local and explicit path targets another project.
6. Test argv generated from the formatted command, not just string snapshots. Support and test the repository's documented shells; never use JSON encoding as shell escaping. If platform-specific quoting is required, provide a platform-specific formatter rather than a misleading universal command.

Tests: same/different cwd; spaces/apostrophes/metacharacters; relative paths/symlinks; QA worktree and branch execution; real CLI aliases; standalone ai-foreman; TTY/non-TTY; two disposable projects demonstrating the command opens the intended project.

### T6 — Integrate, regress, and document evidence

1. Run task-local tests after each task, then all touched package tests, repository tests, build, typecheck, and CLI documentation checks. Typical final commands are `pnpm test`, `pnpm build`, `pnpm typecheck`, `pnpm docs:check` using the compatible runtime. Record exact commands and actual totals.
2. Retain existing QA regressions: missing continuity marker triggers the bounded fresh review; stale resumed report authority requires complete fresh review; provider uncertainty prohibits blind replay; source drift prevents finalization; exhausted fresh-review allowance survives restart; independent-ticket continuation and visible decisions remain intact.
3. Run process tests against real child processes in disposable projects, with controlled barriers/fault injection instead of timing-only sleeps. Verify provider-dispatch counts and durable state, not merely exit code. Run a real PTY smoke test for both resume aliases and cancellation.
4. Run supported-platform process/quoting checks where available. A sandbox preventing process identity inspection is an environment limitation: rerun with appropriate process visibility rather than weakening assertions. Record untested platforms explicitly.
5. Scripted providers are required for deterministic failure coverage. Existing authorization permits authenticated provider smoke tests on disposable projects; use them only where they exercise changed provider/lifecycle integration. They do not replace crash/race tests. Do not run or migrate the unavailable real project.
6. Update CLI docs, relevant READMEs and changelog. Add schema/upgrade compatibility notes. Do not promise older binaries can safely mutate new ownership records: check compatibility and require stopping old workers before upgrade where necessary. Never delete lineage/ownership data to downgrade.
7. Review the final diff against the T0 inventory and every invariant. Confirm no path bypasses admission, borrows current tokens, refills budgets, drops unknown runs, or hardcodes projectless recovery guidance incorrectly.

Completion requires all acceptance tests passing or a specifically documented external limitation that does not undermine a correctness claim. Do not call a failing release gate complete, and do not equate a passing historical suite with proof of the new behavior.

## 5. Plan audit and corrections incorporated

The plan was reviewed against the actual lifecycle rather than just the three visible symptoms. The following potential flaws in a simpler solution are explicitly addressed:

| Audit question | Resolution in this plan | Verification gate |
| --- | --- | --- |
| Could early locking deadlock the child? | Separate coordinator reservation and worker authority; explicit transfer | T2 self-conflict and detached/fast-child tests |
| Could concurrent retries both launch? | Unique successor plus atomic launch authorization/claim | T1 storage races and T3 actual-process races |
| Could a crash between commit and spawn lose the build? | Successor remains discoverable; launch uncertainty has a durable state | T3 boundary fault injection, T4 listing |
| Could absent acknowledgement cause duplicate work? | Claim/dispatch evidence is authoritative; absence is not permission | T3 lost IPC/parent-death tests |
| Could a stale process steal a new lease token? | Original caller token required at mutation transaction | T2 stale heartbeat/save/release/dispatch tests |
| Could deleted lease generations repeat? | Unique ownership incarnation survives numeric generation reuse | T1 reacquisition tests |
| Could a live but slow worker look dead? | One tri-state classifier; heartbeat age is diagnostic only | T1/T2 delayed heartbeat and restricted visibility |
| Could local death conceal remote work? | Reconcile owned descendants and unresolved dispatch before replacement | T2 orphan/remote dispatch tests |
| Could retries bypass approval or budgets? | Durable scope/policy lineage and accounting, independent of argv | T0 inventory and T3 scope/budget tests |
| Could old JSON resurrect finished work? | DB status wins even without a full snapshot | T2 publication faults and T4 mixed-state tests |
| Could unrelated history prevent retry forever? | Run-scoped eligibility; ambiguous evidence gets a reason | T3 branch/legacy tests |
| Could an inspection modify the workflow? | Read-only reader and explicit separation of migration/cleanup | T4 byte/state comparisons on inspect/cancel |
| Could a short command open the wrong repository? | Owning-project formatter and current-project discovery | T5 two-project executed-command tests |
| Could ownership changes weaken QA? | Preserve exact recovery validation and source-bound independent approval | T6 existing QA and budget regressions |
| Could old binaries bypass new fences? | Explicit upgrade compatibility gate and no unsupported concurrent writers | T6 compatibility review/tests |

Audit outcome: the plan covers the three identified findings and the known lifecycle, persistence, compatibility, and recovery gaps above. No unresolved product choice requires consultation. Implementation may uncover unsupported legacy evidence or platform constraints; record those and consult the user if resolving them would change approved behavior. No finite plan can establish coverage of every unknown cause or guarantee zero regressions; the implementation gates provide evidence for the defined contract.

## 6. Execution checklist

- [x] T0: baseline and caller/state inventory recorded.
- [x] T1: migration, ownership and launch primitives verified.
- [ ] T2: close readiness ownership/cleanup and missing-authority gaps; verify all execution modes and stale-writer fences.
- [ ] T3: complete validation and failed-launch reconciliation; verify recovery progress as well as duplicate-execution prevention.
- [ ] T4: preserve project-local, read-only discovery while making selected failed launches recoverable.
- [x] T5: short project-correct commands verified.
- [ ] T6: rerun integration, QA regressions, real-process/PTY checks and documentation after the repairs.
- [ ] Final implementation audit records new test commands, results, environment limits and remaining risks against section 8.

Previously completed verification is recorded below. The reopened gates require new evidence after implementation; passing historical tests did not detect the four audited gaps.

## 7. Historical implementation evidence

Baseline: commit `9f00d79754000004a9e41685fec742ef1fc3267b`, with the pre-existing QA/resume working-tree changes retained. Runtime: Node 20.19.0, matching installed native SQLite. The original four-file baseline passed 30/30 outside the macOS process-inspection sandbox. The sandbox run could not inspect process start identities; assertions were not weakened.

Mutation inventory used during implementation:

| Surface | Ownership/authority boundary | Regression coverage |
| --- | --- | --- |
| Normal, unsupervised and embedded start | `superviseStart`, before readiness | admission and supervised CLI tests |
| Detached supervisor and worker restart | persisted one-time launch claim, before child readiness | detached/preparation-crash CLI tests |
| Preparation retry | atomic successor, supersession and launch reservation | build admission and build resume tests |
| Established build recovery | reconciliation admission, original mutation lease, launch transfer | build resume/QA revision tests |
| Initial snapshot and resumed snapshot | lease acquisition before publication | build run tests |
| Checkpoint, completion, heartbeat and release | original token carried on in-memory run; never serialized as authority | build run fencing/publication tests |
| Provider dispatch, role lease, QA head and publication intent | transaction-level admission fences plus role/session validation | continuity, QA and admission tests |
| Readiness subprocesses | durable launch intent and owned process-group inventory | runtime readiness and supervisor tests |
| Start-over | tri-state discovery plus mutation lease admission | start-over tests |
| Inspection/picker | `WorkflowReader`; no interview pruning | resume/PTY tests |

State inventory: autonomy policy is frozen per run and copied to a preparation successor; supervisor restart counters are copied rather than reset; answered decisions are copied only with attributable keys (scope/prompt hashes remain part of those keys). Pending decisions, recovery attempts, operations, provider/continuity/QA/branch evidence, and unfinished publications prohibit plain preparation replay. Established recovery retains its existing run ID, approval receipt and recovery allowances. Launch attempts are separate from successor IDs. A definite spawn failure can reuse the successor; an uncertain launch remains visible and cannot be dispatched again automatically.

The first full-suite run during implementation reached 614 Foreman tests with one failure in a standalone guidance expectation; 611 passed and two optional tests skipped. The failure exposed a master-run guidance regression: a standalone session-only resume command would lose durable run context. The implementation was corrected to keep master-run recovery on the project-qualified Rafi picker. This intermediate run is not the release gate; the successful final results follow.


### Final audit corrections

- Fenced direct workflow status transitions as well as snapshot writes. Supervisors use a separate generation-checked lifecycle transition that cannot publish worker state.
- Extended admission to embedded supervisors, and required the shared preparation eligibility check before their automatic crash retries.
- Recorded readiness subprocess intent before spawn. An unacknowledged launch or unverified orphan blocks replay; a confirmed completed probe is distinct from proof of process-group quiescence.
- Added explicit start-over authority for superseding a different run; the same token cannot reactivate that run.
- Classified definite OS spawn failures separately from uncertain child outcomes for both preparation and established recovery. No error-code guess authorizes replay.
- Normalized and validated saved options without executing the command; default values do not count as supplied internal recovery authority. Symlink aliases identify the same owning project.
- Preserved standalone master-run recovery through the Rafi picker instead of replacing it with a session-only command that loses durable run context. Updated human-decision guidance too.
- Kept state import on an explicit offline historical writer path. Imported ownership is retained as historical/unknown rather than adopted; live or unknown preparation blocks state transfer. Retry lineage remains immutable outside that migration path.
- Inspection never runs provider probes or writes durable state. Native read-only SQLite may create a shared-memory read-lock file and an empty WAL; the regression test permits only this engine bookkeeping, and compares every durable project file byte-for-byte by hash. Replacing SQLite's coherent WAL reader with an unsafe file-copy shortcut was avoided.

Platform coverage: actual process, Git, signal, and PTY checks ran on macOS. Linux process-stat parsing and unknown/foreign/reused identities have deterministic coverage. Windows PowerShell quoting has a unit test; a Windows process tree was not available here. The original remote failed project was unavailable and was not modified. Authenticated readiness smoke tests passed for both Claude (about 4.1 seconds) and Codex (about 10.5 seconds), using disposable projects.

### Final verification results

All commands used `PATH=/Users/tyler/.nvm/versions/node/v20.19.0/bin:$PATH`. Process/PTY tests and the documentation command ran with the required local process/IPC visibility.

| Command | Verified result |
| --- | --- |
| `pnpm test` | Exit 0: 988 tests, 982 passed, 6 skipped, 0 failed. Spec 48/48; special-agents 92/92; Rafi 214 passed + 2 skipped; Foreman 628 passed + 4 skipped. |
| `node --import tsx --test packages/ai-foreman/test/buildAdmission.test.ts packages/ai-foreman/test/workflowArchitecture.test.ts packages/ai-foreman/test/buildRuns081.test.ts packages/ai-foreman/test/stateTransfer.test.ts packages/rafi/test/buildResume.test.ts packages/rafi/test/buildStartOver.test.ts packages/rafi/test/resumeLauncher.test.ts` | 76/76 passed after the final transition-fencing and launcher refinements. This follow-up covers edits made while the full suite was running. |
| `node --import tsx --test packages/rafi/test/buildResume.test.ts` | 26/26 passed after adding two final real-PTY cancellation cases. Both aliases now exercise terminal selection and Ctrl-C cancellation. These two added tests are not included in the earlier full-suite total. |
| `RAFI_LIVE_BUILD_ADMISSION=1 node --import tsx --test packages/ai-foreman/test/buildAdmissionLive.test.ts` | 2/2 passed using authenticated Claude and Codex in disposable projects. These are readiness/ownership smoke tests, not a latency benchmark or complete live build. |
| `pnpm build` | All four packages passed. |
| `pnpm typecheck` | All four packages passed. |
| `pnpm docs:check` | Passed; generated CLI documentation matches the commands. |
| `git diff --check` | Passed. |

Full regression coverage includes QA fresh-review fallback, stale report/source rejection, recovery budgets, independent-ticket continuation, decision visibility, real supervisor crashes, parent death, cancellation, competing starts, and hung-worker handling. Targeted tests additionally verify atomic retry lineage, original-token fences, definite versus uncertain launch failure, preserved approvals/policy/budgets, state-import compatibility, and read-only discovery. Intermediate failures were corrected and their affected suites rerun; no known failing gate remains.

Historical completion assessment (superseded by section 8): the implementation was initially considered complete. The subsequent audit disproved that assessment for four cases despite passing existing tests. Existing uncommitted work was preserved. Older workers must be stopped before upgrading because old binaries cannot be assumed to honor the new ownership protocol. The unavailable production failures were not reconstructed.

## 8. Updated resolution plan for the four implementation findings

Historical status: implemented and locally verified at the time of section 9, with native Windows execution pending. Section 10 reopens this assessment after three additional defects were reproduced. Preserve the agreed behavior in section 1 and the existing QA/resume work. Do not change unrelated planning documents.

### R0 — Establish contracts and failing regressions

The read-only implementation audit passed 171 existing tests and reproduced all four gaps in disposable fixtures. Those passes do not establish coverage of these failures:

| Finding | Confirmed behavior | Repair surfaces |
| --- | --- | --- |
| A1: failed launch cannot recover | Saved `--steps 1 --stacks 1` passes preparation validation; the child rejects it before claim, leaving a dispatching launch with no implemented retirement path | `cli/start.ts`, `buildAdmission.ts`, `workflowDb.ts`, `supervisedStart.ts`, Rafi `buildResume.ts` and `resumeLauncher.ts` |
| A2: successful probe hides surviving descendants | Probe returns OK, a descendant remains alive, unresolved inventory is empty, and another build is admitted | `runtimeReadiness.ts`, `workflowDb.ts`, process identity and supervisor cleanup |
| A3: worktree probe bypasses ownership | Probe in a worktree succeeds with zero owned-process records in the main project's recovery database | `runtimeReadiness.ts`, `runtimeAuth.ts`, `cli/runtimeAuthPrompt.ts`, Builder/QA callers |
| A4: missing authority permits snapshot mutation | A deserialized completed build can be saved as running when no lease exists | `buildRuns.ts`, workflow transitions, publication and historical writer APIs |

1. Convert each reproduction into a failing desired-behavior regression before changing production behavior. Record the current baseline and retain unrelated working-tree changes.
2. Inventory every affected launch, readiness, mutation, import and repair caller. Map each to authority type, owning project, execution directory, durable state, cleanup owner and regression test.
3. Define the launch state machine, process cleanup contract and terminal transition matrix before schema/API changes. Physical child lifecycle, launch authorization and provider execution are separate facts.
4. Use this authority matrix; do not apply worker requirements indiscriminately to every workflow:

| Operation | Required authority |
| --- | --- |
| Build snapshots, checkpoints, sessions, completion and worker publication | Original worker authority |
| Supervisor lifecycle updates | Restricted coordinator authority |
| Failed-launch reconciliation | Restricted recovery authority; no provider dispatch permission |
| Historical import and projection repair | Explicit maintenance path with conflicting execution excluded |
| Non-build workflows | Their applicable existing authority contract |

Acceptance: each finding fails for the demonstrated reason; all affected callers have an assigned contract. Do not silently weaken assertions to accommodate current behavior.

### R1 — Shared validation and recoverable launch failure (A1)

1. Extract shared, side-effect-free option normalization and validation for ordinary start and preparation retry. Cover mutually exclusive steps/stacks, positive counts, ticket selection/recovery combinations, provider, effort, autonomy, supported options, canonical project identity and internal authorization flags. Preserve legitimate interactive start behavior.
2. Separate interactive choices from validation. Resolve required choices before reserving a launch; saved retries cannot unexpectedly prompt before claim. Validate before successor creation, then revalidate relevant configuration under acquired authority before freezing launch inputs. No transaction remains open across a prompt or subprocess wait.
3. Preserve approved scope, frozen policy and consumed recovery budgets. Missing or invalid saved arguments receive a specific diagnostic and a supported correction path through normal validation and approval. Do not infer approval, silently change scope, or require the user to keep replaying invalid arguments. Define the concrete correction interaction before implementing it; keep normal guidance on `rafi resume`.
4. Track definite spawn failure, child registration, durable claim, child exit and unresolved execution independently. Bind evidence to launch token, canonical project, launcher incarnation, child identity and available containment evidence. A numeric return code alone is insufficient reconciliation evidence; evolve the launcher result contract accordingly.
5. Introduce an acknowledged startup protocol covering the spawn-to-PID-recording window. A child must durably register its identity and claim authorization before readiness, provider work or build mutation. Define bounded waiting and parent-death behavior at every handshake stage so the protocol cannot create an indefinitely waiting child. Lost acknowledgement after a successful durable claim must not cause replay.
6. Add restricted reconciliation that works after the original launcher dies. Re-read launch, admission, claim, child/descendant and provider evidence. Atomically compete with claim and fence the retired authorization. Either claim wins and recovery follows its owner, or retirement wins and the old child cannot execute. Unknown or live ownership is not permission to take over.
7. Trigger reconciliation for child exit regardless of exit code. Definite no-child spawn failure can retire directly under valid authority; all other outcomes require the applicable process/dispatch evidence. A missing PID, unclaimed record, stale heartbeat or dead parent alone does not prove safe replay.
8. Reuse the committed successor with a new authorization after safe retirement. Keep unique retry lineage, budgets and history intact. If established work exists, use established recovery instead of preparation replay.
9. Selecting a recoverable launch in either resume alias invokes supported reconciliation. Inspection and cancellation remain read-only. Unknown cases remain visible with the exact missing evidence and available next action; no force-unlock shortcut.

Minimum launch outcomes:

| Observation | Required outcome |
| --- | --- |
| Invalid arguments before reservation | Diagnostic/correction path; no successor or launch mutation |
| Reserved launch, verified dead and fenced creator, never dispatched | Safely authorize the same successor |
| Definite failure to create child | Persist failure; retry same successor with new authorization |
| Dispatch intent, incomplete registration/acknowledgement | Reconcile using handshake and execution evidence; no blind replay |
| Claim races retirement | Exactly one wins; loser cannot dispatch or mutate |
| Child claimed, acknowledgement lost | Follow authoritative child ownership |
| Child exits before or after claim | Reconcile descendants and dispatch; choose safe preparation or established recovery |
| Terminal successor | Report terminal result; never replay predecessor |

Tests: shared valid/invalid option parity; no writes on invalid retry; correction with unchanged/materially changed scope; failures before/after reservation, spawn, registration, claim and acknowledgement; parent/child death at each boundary; successful/nonzero/signalled preclaim exits; fast claim; duplicate children; competing reconcilers; lingering descendants; remote uncertainty; old-ID repeat; successor reuse; approvals and budgets preserved. Use barriers and real processes; assert dispatch counts and eventual recoverability, not just rejection.

Acceptance: verified failed launches recover through the short command; live, claimed or uncertain executions cannot duplicate work. The handshake introduces no indefinite wait.

### R2 — Mandatory owning-project context for build readiness (A3)

1. Define build readiness context containing canonical owning project, run ID and original admitted authority, independently of execution cwd. Build-facing APIs require it. Standalone authentication uses a separate entry point or explicit discriminated mode, never an implicit fallback for missing context.
2. Thread context through initial readiness, Builder and QA worktrees, retry, provider fallback, supervisor restart, detached and embedded paths. Capture original authority from the admitted invocation; never borrow a token by reading the current database owner.
3. Validate context before intent recording or spawn. Reject absent, stale, wrong-run and wrong-project authority. Resolve canonical aliases consistently without requiring a worktree to be beneath the main project directory.
4. Write owned-process intent and lifecycle records only to the owning project. Keep the intended execution directory unchanged and do not create a recovery database in the worktree.
5. If post-spawn registration fails, perform owned cleanup and retain durable uncertainty through the previously recorded intent. Do not return ordinary readiness success or leave an untracked child.
6. Preserve standalone readiness behavior and provider-free, read-only inspection.

Tests: Builder/QA worktrees, external worktrees, symlinks, retry/fallback context retention, separate concurrent project contexts, stale transfer token, missing context before spawn, registration failure, main-project recovery after crash, explicit standalone calls and no worktree recovery DB.

Acceptance: every build readiness probe has exactly one durable owning build regardless of execution cwd; malformed context cannot silently disable tracking.

### R3 — Separate successful readiness from verified cleanup (A2)

1. Store probe outcome and cleanup outcome independently. OK/exit-zero proves neither descendant shutdown nor remote operation completion. Successful but unverified process records remain unresolved.
2. Retain supervisor cleanup responsibility until owned execution is verified stopped, including when the direct child closes pipes or exits first. Cover success, failure, timeout, cancellation and journal errors with bounded cleanup and durable results.
3. Block subsequent provider execution in the current build as well as admission of competing execution while readiness cleanup is unresolved. Expose cleanup/ownership errors separately from authentication failure; neither auth retry nor provider switching may spawn more probes around unresolved cleanup.
4. Establish supported containment and identity checks before claiming descendant coverage. Signal only verifiably owned processes; account for PID/group reuse, escaped or reparented descendants, redirected pipes, unavailable inventory and platform differences. A process-group scan alone does not prove escaped descendants stopped. If available primitives cannot establish containment, record the limitation and retain uncertainty rather than claiming complete cleanup.
5. Reconcile local processes separately from unresolved remote dispatch. Bounded waiting must terminate in verified cleanup or a visible, persisted unresolved state, never an indefinite wait.
6. Specify selective legacy reconciliation: identify records attributable to unresolved execution lineages and classify available terminal/cleanup evidence. Do not scan all historical completed probes as presumed active blockers; do not bulk-mark ambiguous records safe. Define retirement evidence and test both a legitimate completed history and a surviving orphan. Historical ambiguity that cannot be safely resolved is an explicit limitation requiring investigation.

Tests: normal successful probe; OK with lingering child; redirected stdio; TERM-resistant child; escaped group/reparenting within supported containment; timeout/cancel; interrupted cleanup; storage failure; unavailable inventory; reused identity; concurrent start during cleanup. Assert zero subsequent dispatch by both the original and competing build until safe. Test recovery once sufficient evidence becomes available, including across restart.

Acceptance: readiness authorizes continued execution only after the required cleanup checks pass. Normal probes remain fast; unresolved cleanup is bounded, visible and recoverable where evidence permits.

### R4 — Close missing-authority writes without breaking legitimate operations (A4)

1. Enforce the R0 operation matrix. Runtime build mutations require original authority even when no admission or lease currently exists. Check canonical project, run and ownership incarnation atomically with mutation; never adopt current authority from a database read.
2. Audit direct transitions and lower-level session, dispatch and publication APIs for bypasses. Keep supervisor/reconciliation powers narrow. Preserve legitimate non-build workflows with their own contracts.
3. Reject unauthorized saves before creating snapshot directories, temporary files or publication records. Separate migration/setup from the runtime write path where necessary; test rejection against an initialized database separately from migration.
4. Keep historical import and projection repair explicit and restricted, with conflicting execution excluded. No general skip-authorization parameter. Projections derive from authoritative database state and never confer execution authority.
5. Define terminal transition rules at both database and snapshot boundaries. Completed, cancelled and superseded runs cannot become active through ordinary writes. Preserve legitimate finalization, idempotent completion of an already committed result, interrupted-run recovery and separately authorized start-over. State which repeated operations are verified no-ops versus rejected writes.
6. Fence publication intent and final publication with original authority and durable revision checks. Delayed JSON cannot override newer or terminal state. Recover interrupted publications from database truth.
7. Update fixtures to acquire legitimate authority or use explicit historical import; do not preserve the production loophole for tests.

Tests: no token/no lease; token after release; replaced owner; wrong project/run; serialized token loss; lower-level bypass; completed/cancelled/superseded resurrection; delayed publication; clean rejection without file/DB mutation; legitimate checkpoint/finalization/idempotence; supervisor and recovery boundaries; start-over; import/export; non-build workflow regressions.

Acceptance: unauthorized calls cannot change build state or its projections, including on an unlocked project. Authorized build, coordinator, maintenance and non-build paths retain their intended behavior.

### R5 — Integration, compatibility and final audit

Implementation order: R0 contracts and failing tests; shared storage/API changes needed by R1–R4; R2 and R3 together; R1 launch validation/reconciliation; R4 write enforcement; integrated resume UX and documentation. R4 authority requirements govern earlier API design even though full enforcement lands later.

1. Run each task's new tests and affected existing suites before proceeding. Pair every safety test that blocks recovery with a progress test showing how sufficient evidence restores recovery, or a documented case where evidence is genuinely unavailable.
2. Make schema changes transactional and versioned. Test idempotence, rollback, existing/legacy records, read-only compatibility and future-version rejection. Do not assert compatibility with concurrently running older writers.
3. Test both resume aliases in real PTYs, explicit IDs/non-TTY use, cancellation, current-project-only discovery, explicit paths, symlink projects, failed preparation and established recovery. Inspection must not probe providers or mutate durable state.
4. Retain QA regression gates: missing-marker fresh review, stale-report/current-source checks, uncertain provider execution, bounded allowances across restart, independent eligible tickets and immediately visible decisions. Also retain supervisor/worker transfer, start-over and state-transfer coverage.
5. Run `pnpm test`, `pnpm build`, `pnpm typecheck`, `pnpm docs:check` and `git diff --check` using the compatible installed runtime. Record exact results, skips and environment limitations; do not reuse historical totals as new evidence.
6. Use deterministic scripted providers for failure coverage and real disposable processes for launch/cleanup races. Test platform-specific containment where available and record unsupported/unverified behavior explicitly. Authenticated smoke tests may exercise changed readiness integration under the existing authorization; they do not replace crash tests.
7. Update relevant CLI documentation, READMEs and changelog with actual recovery behavior and compatibility limits. Guidance must remain short and project-correct; do not expose internal authorization flags as the ordinary recovery route.
8. Audit the final diff against every finding, operation-matrix row, launch-state case and caller in R0. Reopen any failing gate. Completion requires evidence of safe execution and useful recovery, not merely conservative rejection.

### Resolution-plan audit and completion checklist

| Audit correction | Included in |
| --- | --- |
| Shared validation alone does not cover other preclaim failures | R1 handshake, outcome tracking and all-boundary faults |
| Handshake can create a new indefinite stall | R1 bounded waits and explicit parent-death outcomes |
| Invalid saved arguments need a usable correction path | R1 validation/approval interaction before reservation |
| Successful readiness must block the current build too | R3 continued-dispatch gate and dispatch-count tests |
| Process-group scans miss escaped descendants | R3 explicit containment contract and limitation tests |
| Optional ownership can silently recreate worktree bypass | R2 mandatory build context and explicit standalone mode |
| Stricter fences can break supervisors/import/non-build workflows | R0 operation matrix and R4 legitimate-path tests |
| Unauthorized calls can still create projection artifacts | R4 early rejection and initialized-DB side-effect tests |
| Blanket historical checks can block healthy projects | R3 selective legacy reconciliation and retirement evidence |
| Rejection-only tests can preserve unusable recovery | R1/R3/R5 paired recovery-progress assertions |

- [x] R0 contracts, caller inventory and four failing reproductions recorded.
- [x] Shared storage changes migrate safely and preserve read-only inspection on the local platform.
- [ ] R2/R3 worktree attribution and bounded readiness cleanup verified on all required platforms (macOS passed; native Windows pending).
- [x] R1 validation, correction, handshake and failed-launch recovery verified on macOS.
- [x] R4 mandatory runtime authority and legitimate-path compatibility verified on macOS.
- [ ] R5 full regression gates and final cross-finding audit pass on all required platforms (local gates passed; native Windows pending).

Plan-review conclusion: the four findings have clear corrective directions, with the additional audit gaps incorporated. Historical missing evidence and escaped-process containment remain explicit technical limits until the implementation establishes the applicable evidence and platform behavior. No additional product decision is currently required. Consult the user if recovery would require abandoning potentially executing work, changing approved scope behavior, or accepting a weaker ownership guarantee. No finite test suite guarantees zero regressions; completion claims must be limited to verified contracts and recorded platform coverage.

## 9. Section 8 implementation and verification record

Baseline: `9f00d79754000004a9e41685fec742ef1fc3267b`, with existing uncommitted QA/resume changes preserved. The initial added regressions reproduced invalid saved-count combinations, successful probes leaving redirected descendants, external-worktree ownership loss, and deserialized completed snapshots being writable. The initial 37-test run had 28 passes and nine failures (eight regression assertions plus an existing process-visibility test under the sandbox). Process-dependent checks were subsequently run with local process visibility. Unrelated planning documents were not edited.

### Implemented contracts and caller inventory

| Caller / operation | Authority and state contract | Coverage |
| --- | --- | --- |
| Ordinary `start`, embedded and unsupervised starts | Shared option validator; admission before readiness; original authority retained in invocation context | `startArguments`, `buildAdmission`, `supervisedStart` |
| Supervised worker and detached coordinator launch | Durable registered-v2 token; bootstrap registers before CLI import; parent acknowledges; CLI atomically claims before work | Real supervised/detached/preparation-crash tests |
| Resume preparation and established recovery | Original launcher context passed to async launcher; structured result; restricted reconciliation on exit; one successor | `buildResume`, `resumeLauncher`, admission race tests |
| Invalid saved preparation options | Read-only validation before reservation; interactive JSON-array correction; cancellation creates no successor; corrections drop `--yes` and re-enter approval | Invalid/corrected saved-argument tests |
| Initial, fallback, Builder and QA readiness (all eight start call sites) | Explicit original admission, owning project and run; execution cwd stays unchanged; owner DB records intent before spawn | Runtime readiness/auth tests, external worktree tests, live smoke checks |
| Standalone auth / agent capability commands | Explicit standalone probe path; no invented build authority | Existing readiness/auth tests |
| Probe shutdown and supervisor cleanup | Outcome independent of quiescence; original process identity/tag retained; next probe, current dispatch and competing admission blocked while unresolved | Lingering/escaped descendants, journal faults, blocked-then-recovered dispatch |
| Snapshot/checkpoint/session/continuity/QA/publication writes | Original admission or original lease; runtime marker survives release; explicit child-workflow association; no authority borrowed from current DB owner | Admission, snapshot, QA, continuity and branch suites |
| Supervisor lifecycle | Restricted existing coordinator paths, separate from worker mutation | Supervision, worker-death and hung-worker tests |
| Failed-launch reconciliation | Restricted retirement only; cannot dispatch or claim on behalf of a child | Registration/acknowledgement, duplicate/retired child, real preclaim exit tests |
| Historical import and projection repair | Maintenance path with execution exclusion; fence SQL functions explicitly registered | State-transfer and publication tests |
| Unadmitted state-machine/non-runtime fixtures | Existing low-level setup contract; not a substitute for runtime snapshot authority | Existing workflow tests; QA crash fixtures assert no runtime/admission before raw injection |

Runtime ownership schema 2 adds managed-run markers, explicit child-run association and owned-process outcome storage. Migration is transactional, repeatable and refuses future schemas; already-current connections avoid repeating DDL. Child associations fixed an integration regression where legitimate branch workflows were incorrectly treated as unrelated runs. Five raw QA crash fixtures initially failed because they did not register the new SQLite fence functions; their test-only setup now explicitly verifies the absence of runtime/admission authority before registering those functions. Production fences were not relaxed for those fixtures.

The final code audit also found that a rejected detached acknowledgement could leave an exit callback referring to a closed database. Startup listeners now detach on success and rejection. A fault-injected late exit/error regression and a real detached success case both pass.

### Launch and terminal-state audit

| State/evidence | Implemented result |
| --- | --- |
| Invalid arguments | Correct/cancel before launch reservation; no successor side effect |
| Reserved launch, original owner or verified dead owner | Atomic retirement fences late dispatch; retry reuses successor |
| registered-v2 dispatch without acknowledgement | Token can be fenced; delayed bootstrap cannot claim or enter provider work |
| Acknowledged child verified live/unknown | No retirement or duplicate retry |
| Acknowledged child verified dead, no claim | Retire preclaim authorization; later eligibility check still rejects established/provider uncertainty |
| Claimed launch | Remains authoritative; use established ownership/recovery, never preparation replay |
| Legacy ungated dispatch with insufficient evidence | Visible unknown; no automatic retirement |
| Parent dies before acknowledgement | Bootstrap disconnect failure or ten-second deadline; CLI is not imported |
| Launcher waits for registration | Fifteen-second startup bound in resume, supervised and detached launchers |
| Completed/cancelled/superseded runtime snapshot | Ordinary activation rejected at snapshot and transition boundaries |
| Identical repeated completion | Verified read-only no-op; cannot overwrite a newer snapshot |
| Stale/serialized/released authority | Reject before snapshot directories/publications; atomic DB check retained |
| Legitimate interrupted recovery/start-over | Existing authorized recovery path; explicit child/supersession relationship where required |

Readiness success is stored independently of cleanup. New probes use tagged-v2 on Unix or windows-job-v1 on Windows. Legacy completed rows are considered selectively for unfinished lineages; legitimate terminal history does not become a global blocker. Unresolved local process evidence and uncertain remote provider dispatch remain separate reasons to withhold execution.

### Windows implementation and platform limits

The user explicitly required Windows support before completion. `windowsProbeJob.ts` creates a named, non-breakaway Job Object with kill-on-close. `PROC_THREAD_ATTRIBUTE_JOB_LIST` assigns containment atomically during suspended process creation, before provider execution. The helper monitors the original owner's PID and start time. Helper death closes the job handle; owner death terminates the job. Queries distinguish absent/empty jobs from active/unknown jobs. User/provider arguments travel as JSON data, not PowerShell source; standard npm shims are resolved to direct Node argv. This requires Windows 10 / Server 2016 or later and Windows PowerShell `Add-Type`.

Five Windows-only integration cases cover normal readiness, detached descendants, cancellation, helper death and owner death. Portable tests verify configuration separation, command length, identity validation and npm-shim handling. `.github/workflows/build-recovery.yml` builds dependencies in order and runs native containment, identity, argument and launcher tests on `windows-latest`. Unix SIGTERM forwarding is explicitly skipped there because Windows termination is not a catchable Unix signal.

Native Windows execution is **pending**: the implementation host is macOS, and the workflow has not been pushed or dispatched. Portable test passes do not establish native ABI, PowerShell policy, handle inheritance or OS cleanup behavior. Windows readiness containment is implemented, but Windows completion cannot be claimed until the native gate runs successfully. Arbitrary Builder subprocesses retain their existing conservative recovery behavior; this Job Object is specifically for readiness providers.

On Unix, group plus inherited-tag inventory covers tested redirected, reparented and escaped-group descendants. It is not OS-enforced containment against a descendant that both detaches and deliberately scrubs its ownership environment. Unavailable inventory is blocked, but an intentionally untraceable descendant is outside this verified contract. Legacy records missing containment evidence stay unknown. Original remote-machine production failures remain unavailable; these tests reproduce the code-level failure classes, not those exact incidents.

### Verification evidence for this implementation

Local runtime: Node 20.19.0, pnpm 10.2.1, macOS. Each implementation area was exercised with its new regressions and affected suites; broader runs caught the child-workflow and raw QA-fixture regressions described above. Historical totals from section 7 are not reused.

| Gate | Current result |
| --- | --- |
| Shared start arguments | 7/7 passed |
| Initial readiness/auth/process integration | 27/27 passed |
| Expanded affected admission/resume/snapshot/continuity suites | 140/140 passed |
| Full supervision plus readiness follow-up | 28/28 passed, including real hangs/crashes |
| Real internal current/branch/detached/crash launch gates | Four selected tests passed |
| Detached startup final audit | Real detached success and rejected-acknowledgement late exit/error both passed |
| Previously failing raw QA crash fixtures | Five selected tests passed after fixture correction |
| Version-1 ownership upgrade | Passed; retained original owner and ambiguous legacy completed-probe evidence while installing version-2 storage |
| Authenticated readiness in disposable projects | Claude and Codex both passed; disposable data removed |
| Portable Windows tests | Two passed; five native cases skipped on macOS |
| Windows CI subset plus README tests on macOS | 19 passed, five native Windows cases skipped |
| Final `pnpm typecheck` | All four packages passed |
| Final `pnpm test` | 1,023 total: 1,012 passed, zero failed, 11 skipped; exit 0 |
| Final `pnpm build` | All four packages passed |
| Final `pnpm docs:check` | Passed with local IPC permission; initial sandbox invocation was blocked by `EPERM` |
| Final `git diff --check` | Passed |
| Native Windows workflow | Not run; required platform verification remains open |

Full-suite package results: spec 48/48, special-agents 92/92, Rafi 220 passed/two skipped, ai-foreman 652 passed/nine skipped (about 587 seconds). Skips comprise two preexisting TTY-journey cases, four opt-in live-provider cases and five Windows-only cases. The two readiness live cases were run successfully in a separate authenticated check; native compaction smoke tests were not rerun for this repair. The final full suite includes the detached rejection regression; the subsequently added v1 upgrade case passed separately. The final portable CI subset passed 19 tests with five Windows-only skips. Latest typecheck includes all added tests.

Historical implementation conclusion (superseded by section 10): each A1–A4 finding was considered locally covered. The subsequent audit found three additional defects despite passing tests. Native Windows verification also remains open. No claim of zero regressions or exactly-once external execution is made.

## 10. Post-implementation audit repair plan

Status: implementation and final local regression verification have passed. Native Windows and Linux verification remain open. This section supersedes conflicting completion claims in sections 7–9 and supplements, rather than replaces, the R0–R5 contracts. Preserve all previously agreed product behavior.

### 10.1 Findings, evidence and completion standard

| ID | Confirmed finding | Root cause and adjacent cases to cover | Required result |
| --- | --- | --- | --- |
| B1 | Established recovery exits before claiming its launch | `validateStartOptions` requires preparation-run whenever launch-token exists, although `buildResume` correctly supplies recover-run for established recovery; existing launcher tests bypass the actual start action | Real preparation and established launches both validate and claim correctly; malformed or unauthorized launches cannot dispatch |
| B2 | Supervisor reports quiescent with an escaped tagged descendant alive | Supervisor Unix helper ignores the tag; cleanup only runs on signal/stopping; IPC maps alone miss early crashes and lost messages | All applicable exit paths use one durable ownership inventory and one cleanup contract; cleanup succeeds before replay or remains visibly unresolved |
| B3 | Transient readiness registration failure can permanently block a project | Provider starts before PID registration; failure returns early, leaving PID-less intent; recovery has no restricted owned-process reconciliation | New launches cannot execute before registration; interrupted recording/cleanup can be reconciled safely through either short resume command |
| B4 | Windows support is unverified | Native tests and workflow exist but have not run; current workflow omits several affected integration paths | Required native tests, including new repairs, execute and pass before cross-platform sign-off |

Audit evidence: 121 existing tests passed, five native Windows tests skipped, and `git diff --check` passed. Separate reproductions confirmed B1 rejection, B2 `quiescent` with one live tagged survivor, and B3 rejection after verified owner death and zero tagged survivors. These passes demonstrate missing coverage, not absence of defects. The original production project is unavailable; use faithful disposable fixtures and copied legacy-state fixtures.

Completion requires paired safety and progress evidence: no duplicate or unauthorized dispatch while ownership is uncertain, followed by successful recovery when sufficient evidence exists. Do not weaken ownership checks to make tests pass. Tests reduce regression risk; neither this plan nor a passing suite proves every possible environmental failure impossible.

### 10.2 B1 — Validate each launch mode and exercise the actual CLI

Primary surfaces: `cli/start.ts`, `supervisedStart.ts`, `buildLaunchGate.ts`, Rafi `buildResume.ts`, `resumeLauncher.ts`, both resume command registrations, and argument/launcher/CLI integration tests.

1. Inventory parsed CLI options, saved preparation arguments, worker environment, detached-supervisor environment and actual re-exec argv. Define an explicit launch context independent of ordinary ticket/session recovery options. Keep syntactic validation separate from durable authorization.
2. Replace the preparation-only pairing rule with these contracts:

| Invocation | Syntax contract | Authorization contract |
| --- | --- | --- |
| Ordinary start | No internal run/token pair required | Acquire normal admission before readiness |
| Preparation successor | preparation-run plus its launch token; no recover-run | Claim exact successor, role, project, digest and registered child |
| Established recovery launched by resume | recover-run plus its launch token; no preparation-run | Claim exact existing run, role, project, digest and registered child; preserve recovery receipt |
| Supported direct recovery without transferred token | Existing supported recovery options remain valid | Acquire the appropriate existing admission; never manufacture transfer authority |
| Supervised worker or detached child | Run/role/token obtained from the intended gate context | Preserve the gate's exact registered-child and role checks |
| Conflicting run modes, orphan token, missing preparation token or mismatched child context | Reject before readiness and workflow execution | No fallback to ordinary admission |

3. Account for nested launches: a supervisor's argv can retain an outer CLI token while its worker receives a new environment token. Normalize each boundary to its own intended authorization, preferably removing/replacing inherited internal launch options in re-exec argv. Do not blindly require the historical outer token to equal the new worker token. Reject unexplained conflicting sources without breaking legitimate transfer. Environment variables alone cannot establish a worker role or bypass the durable gate.
4. Keep saved preparation validation stricter: persisted preparation must not contain internal launch or established-recovery authority. Validate generated established-recovery argv before reserving/dispatching its launch as well as in the child. Use the same parser/normalization rules; verify digest stability across parent, gate and actual child options.
5. Keep pure validation free of DB writes, provider starts and prompts. Preserve interactive count selection, steps/stacks validation, repeatable tickets, negative flags and existing session recovery behavior. Invalid input must not create a successor or consume a recovery allowance merely to discover invalid syntax.
6. Add real subprocess tests through the shipped CLI entry point, gate and start action. Do not replace the action or stub `executeStart` for the decisive regressions. Use disposable projects and local fake providers/fixtures to reach a durable launch claim and observable legitimate recovery progress without network calls.
7. Test both `rafi resume` and `rafi build:resume`, with interactive selection exercised through a PTY where supported and explicit selection in noninteractive tests. Cover preparation retry, established Builder recovery, QA recovery, supervised, unsupervised and detached transfer. Confirm selected run identity, launch claim, preserved approved scope/policy/budgets and absence of an unintended preparation successor.
8. Negative matrix: missing/mismatched/retired/duplicate tokens, both run modes, wrong project/run/role/digest, forged worker environment, stale saved internal flags, all existing invalid count/option cases, and preclaim child exits. Invalid attempts make zero provider dispatches. Retired preclaim failures remain recoverable through the short commands.

Acceptance: the original B1 argv passes the actual CLI and claims the correct launch; token acceptance does not bypass any existing authority checks. The nested supervisor/worker launch also reaches execution, not merely parser success.

### 10.3 B2 — Share cleanup and make durable records authoritative

Primary surfaces: `runtimeReadiness.ts`, `supervisedStart.ts`, `processIdentity.ts`, `windowsProbeJob.ts`, `workflowDb.ts`, and a shared readiness cleanup module if needed. Design this together with B3.

1. Define a shared cleanup input containing canonical project, run, probe ID, protocol version, original owner incarnation, registered helper/provider identities and containment identity. Return structured `quiescent`, `active` or `unknown` evidence with a reason, rather than a group-only boolean. Readiness success is a separate field.
2. Use the same cleanup implementation for worker completion, registration errors, supervisor recovery and selected-run reconciliation. Keep OS inspection/signalling separate from the restricted transaction that persists the result. Never hold a DB transaction while waiting for processes or user input.
3. On Unix, inspect both the dedicated group and inherited ownership tag. Recheck recorded process incarnation before signalling each owned process; never kill a newly reused leader PID or an unverified group. Re-inventory after TERM/KILL to catch children created during cleanup. Treat inventory errors, truncation, inaccessible identity and unsupported protocol as unknown. Zombie-only membership is nonexecuting where verified. Group absence alone cannot establish cleanup.
4. Retain the existing Unix coverage boundary: group members and escaped/reparented children that retain the probe tag. Tags are attribution evidence, not a sandbox against a child deliberately removing the tag and escaping its group. Do not claim universal containment. If evidence indicates ownership escaped this contract, require investigation rather than declare quiescence. Stronger adversarial Unix containment is a separate design requirement, not implied by this repair.
5. On Windows, use Job Object state and helper identity together. An absent job while a helper could still create it is unknown, not safe. Confirm the creating helper has exited or its unconsumed startup authorization is irrevocably fenced before using job absence as proof. Keep native containment and process-incarnation checks; do not substitute unverified `taskkill` tree traversal.
6. On every worker exit/error that may have created readiness work, reconcile its durable probe records, including numeric nonzero exits and unexpected zero exits. Run this before early completion/restart returns. Determine worker outcome after cleanup, preserving intentional pause/completion semantics. Cleanup of a completed probe must not convert a failed readiness result into success.
7. Load outstanding records by exact worker/owner incarnation and run lineage. IPC notifications accelerate cleanup but cannot be its only inventory. Do not omit a probe because its registration message was lost, arrived late, or an `active:false` message preceded the durable cleanup receipt. Parent/child run associations must resolve to the correct owning project without touching a new owner's probes.
8. Use one bounded cleanup deadline per recovery operation, including subprocess inspection timeouts; avoid multiplying a full deadline by every record. Coalesce duplicate cleanup requests and use compare-and-swap persistence so worker/supervisor/reconciler races are idempotent. A late failure must not overwrite verified completion; a stale success must not clear newer work.
9. Persist the final evidence/reason before authorizing further work. If persistence fails, stop further dispatch, retain the outstanding intent and expose a retryable reconciliation state. Do not drop the remaining cleanup handles or report success solely because the in-memory inspection succeeded.
10. Keep readiness cleanup distinct from Builder/QA remote dispatch uncertainty and arbitrary worker descendants. Verified local probe cleanup alone does not authorize replay of established work. Apply the existing preparation eligibility and remote-dispatch checks after cleanup.

Required tests: the exact escaped-descendant reproduction; redirected pipes; direct parent exiting first; TERM-resistant and reparented children; child creation during cleanup; success/nonzero/signal/cancel paths; worker death before IPC registration; missing/duplicate/late IPC; explicit pause; parent and supervisor death; unavailable inventory; reused PID/group; two concurrent cleanup callers; other project/new owner untouched. Every recoverable case must prove both zero dispatch while unresolved and successful subsequent execution after cleanup. Use real process barriers, not timing-only sleeps, for critical races.

Acceptance: supervisor never reports quiescent while a supported owned descendant remains; cleanup no longer depends on signal-only handling or reliable IPC delivery; normal completed probes and intentional pauses retain their existing behavior.

### 10.4 B3 — Gate readiness execution and add restricted reconciliation

Primary surfaces: `runtimeReadiness.ts`, `buildAdmission.ts` schema, `workflowDb.ts`, `workflowReader.ts`, Rafi `buildResume.ts`, supervisor integration, and a minimal readiness startup helper. The build launch gate provides a pattern, but readiness must not claim/replace the build's admission merely to launch a probe.

#### Durable startup and cleanup model

Add a versioned readiness protocol with separate startup, probe outcome and cleanup state. Persist original owning admission/incarnation, canonical project/run, unique probe capability/tag, helper PID/start/host, containment identity, revision and timestamps. Persist enough information to inspect the probe without relying on a currently live in-memory authority object. Missing fields in older records remain missing evidence, not fabricated defaults.

Proposed startup states: `intended -> registered -> authorized`; `intended` or `registered` may become `revoked`. Once authorized, it is potentially executing until verified cleanup. Cleanup independently records pending/unknown/quiescent. All updates compare the original probe identity, protocol and revision.

1. Persist intent under valid original build authority before spawning anything. Spawn only a minimal trusted helper; no provider import, provider executable, Job creator or other external work may start yet. The helper must durably register its own identity before receiving execution permission. Use a dedicated group on Unix whose provider descendants initially remain in that group; use the native contained execution path on Windows.
2. The parent validates the registered helper and atomically authorizes this exact probe under still-valid build authority. This authorization and revocation compete in the database. The helper checks the committed authorization before launching the provider. The registered identity covers any pause between that check and process creation: recovery cannot clear an authorized live/unknown helper merely because no provider/job exists yet.
3. Reuse existing bounded startup timing policy where appropriate (10-second child wait, 15-second parent limit), with disconnect/error/cancellation handling. A lost acknowledgement must not create an unregistered provider or a second attempt. Read the durable startup state: atomically revoke only `intended` or `registered`; if `authorized`, follow and clean up the recorded helper and descendants. Missing acknowledgement, elapsed timeout, or absent provider/job never proves authorization was unconsumed. Reject `authorized -> revoked` in the storage API; verified cleanup changes cleanup state without rewriting authorization history. Helper startup timeout is a cleanup/startup error, not an authentication failure.
4. Registration, authorization and revocation must not obtain authority by reading and adopting the current owner. Bind registration to the original single-probe capability; parent authorization requires the original build authority; reconciliation has only the restricted powers below. Duplicate helper registration fails.
5. Preserve the readiness timeout, output cap, argument quoting, environment, provider phase, cancellation and cwd behavior. Bound helper overhead and measure it; do not add a second unbounded preflight before each probe. Standalone auth remains explicitly standalone and does not create a build recovery database.
6. Route every spawn/registration/authorization/output/exit/storage failure through one settlement/cleanup path. Attach child error/exit handlers early enough to catch fast exits and registration failures. Retain the in-memory PID/incarnation even if DB registration fails. Perform verified cleanup, then make a bounded attempt to persist evidence with the original authority. Never mark `noChild` after a child was actually spawned.
7. If storage stays unavailable or authority changes, preserve the durable intent and visible unresolved status. No provider fallback, repeated readiness or build dispatch may bypass it. Later recovery must not depend on the original process surviving or a temporary log being present.

#### Restricted reconciliation and recovery UX

1. Add an explicit selected-run reconciliation operation usable before acquiring ordinary recovery admission; otherwise the unresolved-probe check creates a circular dependency. It may inspect/stop verified-owned readiness processes, revoke capabilities only in `intended` or `registered` state and persist verified cleanup. It cannot dispatch providers, acquire worker mutation rights, edit tickets, alter approvals/budgets or mark remote actions complete.
2. Reject takeover of a verified live owner. Permit cleanup by the original valid owner/supervisor within its existing contract, or by restricted recovery after the former owner is verified dead/fenced. Unknown/foreign-host ownership remains unresolved. Use exact owner/probe revisions and recheck immediately before committing; competing normal start, helper authorization and reconciliation must have one consistent winner.
3. For new-protocol intents whose durable startup state is `intended` or `registered`, atomically revoke before declaring execution impossible. The conditional transition must fail if authorization won the race; reread and apply the authorized-probe cleanup path instead. A delayed helper may register only if the intent is still valid; it cannot launch after revocation. Stop any identifiable helper and record its disposition separately. A fenced, provider-incapable helper is not proof that a previously authorized provider was stopped.
4. For authorized probes, prove the helper cannot still spawn and all supported owned descendants/jobs are quiescent through B2. Never infer safety from a missing PID, absent job, zero exit code, stale heartbeat, empty IPC map or dead parent alone.
5. Invoke reconciliation after a user selects an unfinished build or an explicit cleanup-only entry in either alias, and from applicable supervisor recovery. Do not mutate state during candidate listing, inspection, an abandoned selector, or diagnostics of active work. Refresh the selected recovery projection after reconciliation before acquiring recovery admission or choosing preparation versus established recovery.
6. Preserve the latest unfinished run in current-project selection even when cleanup is unresolved. Give a concise reason and next step, for example: cleanup verified and recovery continuing; owner still running; process visibility unavailable; older incomplete ownership requires investigation. Do not advertise an automatic repair that the implementation cannot perform. Keep normal guidance to `rafi resume` without generated flag lists.
7. After verified reconciliation, reuse the correct existing successor/run and original policy, approvals and budgets. Do not create a retry loop or reset exhausted allowances. For established work, return to its normal Builder/QA recovery; for preparation-only work, apply full preparation eligibility before retry.
8. Make every readiness blocker used by admission reachable through a read-only cleanup projection, independently of resumable build snapshots. Include outstanding records attached to completed, cancelled or superseded runs, and attributable parent/child and retry relationships. Build the projection from durable ownership records; missing or invalid build JSON must not hide a blocker. Share the blocker predicate with admission, so an entry cannot block admission while being absent from recovery discovery. Verified-quiescent historical probes are not candidates.
9. Keep cleanup-only entries visibly distinct from resumable builds and preserve the latest unfinished build's normal ordering. Show them even when no unfinished build exists, through both aliases and explicit run selection; resolve terminal-run cleanup before the current terminal early return or successor redirect would hide it. Listing, inspection and selector cancellation remain read-only. Selection authorizes only the restricted cleanup operation, not reopening the terminal run, retrying its tickets or creating a successor. When selecting unfinished work blocked by a different run, identify that blocker and expose its cleanup entry rather than silently expanding the selected cleanup scope. After cleanup-only completion, return a concise result; a later ordinary start/resume must pass normal admission.
10. Resolve relationship traversal explicitly: enumerate the selected record's attributable owning run and relevant outstanding related probes with cycle/dangling-link checks and exact owner identities. Do not treat all siblings or successors as one cleanup authority. Unknown relationships stay visible and unresolved; another live owner, unrelated run or project remains untouched. Keep original run status, receipts, approvals and budgets byte-for-byte unchanged by cleanup-only reconciliation.

#### Existing records and migration

1. Add a transactional ownership-schema migration from supported v1/v2 to the new version; update both writer and read-only compatibility checks. Test migration rollback and concurrent open. Exclude conflicting live old-version writers before upgrading execution semantics: an old process may already have passed its schema check, so a version bump alone does not fence it. Do not require the new schema just to inspect a live legacy run. Old binaries must reject the newer schema rather than treat a gated intent as legacy safe state.
   Implement the exclusion as a transactionally installed compatibility fence, not a one-time process scan. Under an immediate write transaction, revalidate the authoritative admission, lease, supervisor, pending launch and owned-probe evidence. Refuse execution-semantic migration while an old owner is live/unknown or an acknowledged/delayed legacy launch could still execute. A preauthorization registered launch may be retired only using its existing protocol's proven-safe rules. Do not kill unrelated processes to enable migration.
   Install persistent database guards in the same transaction as the schema/data changes. Use a connection-specific new-protocol capability/function absent from old connections, plus the existing original-owner checks. Guard admission/lease acquisition and replacement, launch and owned-process writes, and every runtime mutation surface that an already-open legacy writer could otherwise use to regain or exercise build authority. New minimal helper registration and restricted reconciliation get only their narrow operations, not blanket writer authority. Audit legacy migration/DDL paths too: an older opener must not be able to remove or replace the guards before rejecting the new schema. Roll back the entire upgrade if these conditions cannot be established. These guards protect cooperating application versions, not arbitrary direct SQL tampering.
   Database fencing cannot retract an OS spawn or remote dispatch already authorized by old code. Require verified quiescence or irrevocable preauthorization retirement for those paths before the upgrade commits; otherwise leave migration pending and inspection available. Test the actual supported older writer paths with connections opened before migration, including a process paused after its initial schema check and one paused immediately before launch. Release those barriers after upgrade: old writes must fail and no delayed old execution may become newly possible. Also prove a new writer can subsequently admit, probe and recover normally, and that competing migrators, transaction rollback and read-only legacy inspection remain correct.
2. Preserve tagged-v2 and windows-job-v1 records as their original protocol. Do not reinterpret old PID-less intents as new, never-authorized helper intents: the old code may already have executed the provider. Preserve historical completed records, outcomes, lineage and unrelated runs.
3. Existing records with registered identities can be reconciled through verified owner death, supported containment and provider evidence. Exclude verified-quiescent historical probes; a terminal run status alone cannot hide an unresolved owned-process record. Expose such records through the cleanup-only projection above.
4. Old PID-less records may be reconciled only when attributable evidence proves the old execution cannot still run or appear later. Available original-process cleanup evidence or verified helper identity can establish this in some cases. Owner death plus an empty scan alone is insufficient if an unrecorded helper could still create a job/provider later. Require the same platform containment contract and distinguish local cleanup from remote effects.
   For the reproduced Unix tagged-v2 case, explicitly evaluate its direct-spawn protocol: if the original spawning owner is attributable and verified dead, no separate delayed spawn helper exists under that protocol, and a complete supported tag inventory is empty, retirement can be justified within the documented inherited-tag contract. Require protocol/provenance checks and a test of this exact already-persisted failure, not just newly gated probes. An unknown protocol, missing owner provenance, incomplete inventory or evidence of tag loss cannot use this path. Do not transfer this rule to windows-job-v1, whose unregistered helper can outlive its owner and create the job later.
5. If the necessary historical evidence is absent, there is no universal safe automatic resolution. Keep the build selectable, explain exactly what is missing, and allow reassessment after trustworthy evidence is supplied. Do not delete the DB, bulk-clear intents, invent a successful receipt or add a force-unlock shortcut. This limitation is explicit; the new protocol prevents future PID-less ambiguity but cannot reconstruct missing history.

Required fault matrix (each recoverable case must eventually resume):

| Failure boundary | Required safety outcome | Progress assertion |
| --- | --- | --- |
| Intent committed; helper not spawned | No provider | Revoke intent; retry with a new probe capability |
| Helper spawned; registration fails transiently | No provider; bounded helper cleanup | Persist cleanup or reconcile revoked intent; subsequent readiness succeeds |
| Registration/authorization delayed; parent dies | No unregistered execution | Atomic revoke or follow recorded authorized helper; no duplicate |
| Authorization committed; acknowledgement lost | Reject revocation even if no provider is visible | Reconcile exact helper and descendants before retry; preserve authorization history |
| Authorized helper paused before provider/job creation | Do not declare safe from empty inventory/job absence | Stop/verify helper, then reconcile; released barrier cannot create late work |
| Provider runs; worker/supervisor dies | Supported descendants remain tracked | Restricted cleanup and successful resume |
| Cleanup succeeds; final DB write fails | No subsequent dispatch yet | New process persists verified reconciliation once DB recovers |
| Authority replaced during cleanup | No current-owner mutation or provider fallback | Narrow compare-and-swap result or visible retry; new owner untouched |
| Two reconcilers race helper authorization | One durable winner | At most one authorized probe; losing helper cannot execute |
| Legacy incomplete record, sufficient evidence | No blind reinterpretation as new protocol | Supported migration/reconciliation and resume |
| Legacy incomplete record, insufficient evidence | Visible unresolved state | Remains selectable; later evidence can be reassessed without destructive edits |
| Terminal run has outstanding probe; no unfinished builds exist | Cleanup-only selection cannot reopen or replay terminal work | Both aliases and explicit selection reach cleanup; later ordinary admission succeeds |
| Related or different run owns the blocking probe | Show exact attribution; do not clean another live owner's work | All admission blockers have reachable cleanup entries; selected eligible work can resume afterward |
| Old writer already open when migration begins | Atomic guards reject incompatible writes; old executable paths are quiescent or safely fenced before commit | Release old-writer barriers without new dispatch; new writer can recover |
| Revocation races committed authorization | Exactly one legal state transition; authorized-to-revoked always rejected | Winning authorization requires verified cleanup before another probe |

Also test persistent storage failure, cancellation at each startup boundary, fast helper/provider exit, errors before listeners attach, malformed/unsupported protocol, external worktrees, symlinked project paths, separate simultaneous projects and unchanged standalone authentication. Use counters for provider starts and subsequent build dispatch; test both while blocked and after recovery.

Acceptance: a transient recording failure under the new protocol is bounded and recoverable after the original owner exits; no missing-registration path can execute untracked provider work. Historical cases are repaired only where evidence supports it, with remaining limits stated accurately.

### 10.5 B4 — Native platform verification is a completion gate

1. Retain Windows support as required, not optional. Obtain a Windows machine or authorized CI runner. The user selected “Prepare CI; keep verification pending.” The workflow is prepared; native sign-off remains open until an authorized runner executes it successfully.
2. Expand `.github/workflows/build-recovery.yml` beyond the current narrow subset to run the B1 real CLI paths, B2/B3 ownership and reconciliation tests, schema compatibility, both aliases and Windows native helper/Job tests. Run equivalent focused process tests on macOS and Linux to validate both Unix inventory implementations. Preserve pinned compatible tool versions and build dependencies in order.
3. Native Windows cases must include normal probe; lingering/detached child; cancellation; worker/helper/owner death; helper suspended before job creation; registration/final-recording failure; denied/unknown inventory; nested launch token handling; two competing recoveries; and successful short-command recovery after cleanup. Exercise real packaged `.js` helper paths, paths with spaces, Node/npm command resolution and supported PowerShell invocation.
4. Assert required native cases actually ran, rather than counting a green job with skipped tests as success. Fail if containment setup or identity is unavailable in a case intended to prove it; use separate negative tests for deliberate permission failure. Record OS, Node, PowerShell, revision, command, counts and logs.
5. A modern Windows runner proves only that tested configuration. Keep the documented supported Windows baseline accurate; test the minimum supported configuration or narrow the support claim explicitly before sign-off. Do not silently broaden operating-system guarantees.
6. If no native runner is available, record B4 as blocked on verification and leave overall completion open. Preparing a workflow or passing portable mocks does not satisfy the user's Windows requirement. Do not publish the unrelated dirty checkout merely to trigger CI.

### 10.6 Implementation sequence and regression gates

1. **Baseline and reproductions:** capture the current diff; preserve unrelated files; add failing B1/B2/B3 regressions and an affected-callsite matrix. Identify test fixtures that replace production actions or omit authority; retain useful unit tests but add actual boundary coverage.
2. **B1:** implement mode-aware validation and nested launch normalization. Run argument, start, both resume aliases, launcher, supervised/detached and QA recovery suites. Confirm actual durable claim/progress, then re-audit generated argv and digest handling.
3. **B2/B3 contracts and storage:** finalize the shared cleanup interface, readiness state machine, restricted reconciliation authority and schema migration. Test unauthorized transitions, owner replacement, claim/revoke races, readers, import/export, rollback and already-open legacy writers before caller integration. Prove migration installs its compatibility guards atomically and excludes delayed old execution; do not defer this mechanism to caller integration. Do not ship an intermediate state that recognizes new records without enforcing the execution gate.
4. **B2/B3 integration:** wire helper registration, all settlement paths, worker/supervisor inventory, selected-run reconciliation and terminal cleanup-only discovery together. Test both aliases with no unfinished builds, terminal explicit selection, missing projections and related-run blockers; ensure cleanup does not replay work or alter terminal status. Run the real-process fault matrix after each coherent change; verify subsequent successful recovery and no orphan fixtures. Re-run B1 tests because helper/gate changes share startup boundaries.
5. **Platform gates:** run native Windows and focused Linux/macOS suites against the same implementation revision. Fix platform failures and rerun affected plus shared suites. Do not treat a Windows skip on macOS as Windows evidence.
6. **Final regression:** run workspace `pnpm test`, `pnpm typecheck`, ordered/workspace builds, `pnpm docs:check`, and `git diff --check`; verify packaged CLI/helper resolution. Run authenticated Claude and Codex readiness smoke tests where available, in disposable projects, reporting unavailable providers explicitly. Fake providers handle destructive fault injection.
7. **Preserve existing behavior:** require missing-QA-marker fresh review, stale QA report/current-source checks, bounded recovery across restarts, independent-ticket continuation, visible decisions, unchanged-scope approvals, material-scope approval, latest unfinished current-project selection, cancellation, start-over, state transfer, branch/worktree recovery, standalone auth and runtime mutation fences to remain green. No extra compaction, approval or provider fallback may be introduced as an accidental recovery side effect.
8. **Final audit:** map every B1–B4 row, launch mode, fault boundary, platform and caller to implementation and a named test/result. Verify no helper/provider can launch after a state declared safe, no cleanup path depends exclusively on IPC, and no success test only checks rejection/exit status. Record failures and skips honestly. Update older completion statements only with current evidence.

### 10.7 Resolution-plan audit and explicit limits

| Potential gap in a superficial fix | Plan coverage |
| --- | --- |
| Relaxing one validator lets invalid tokens through | B1 mode syntax plus unchanged exact durable claim checks and negative matrix |
| Parent tests pass while real child rejects arguments | B1 actual shipped CLI/action tests and nested worker/detached tests |
| A new conflict check rejects legitimate outer/inner tokens | B1 boundary-specific normalization and transfer/digest tests |
| Tag cleanup runs only after a signal | B2 all exit paths, before early returns |
| Supervisor never heard about the probe | B2 durable inventory; B3 provider gate before registration |
| Group appears empty but escaped child survives | B2 group plus tag inventory and shared cleanup |
| Windows job is absent before a delayed helper creates it | B2 helper lifecycle plus B3 registered authorization/revocation tests |
| Registration error is caught but leaves permanent intent | B3 gated execution, one cleanup path, restricted restart reconciliation |
| Recovery cannot reconcile until it owns admission, which unresolved probes block | B3 narrow pre-admission reconciliation API |
| Clearing an intent races a helper that is about to execute | B3 atomic revoke versus authorize; authorized helper must be verified stopped |
| Migration falsely grants legacy records new guarantees | B3 protocol-preserving migration and evidence-specific legacy handling |
| A terminal run blocks admission but cannot be selected | B3 shared admission-blocker/cleanup projection, both aliases, terminal and relationship fixtures |
| An already-open old binary writes after schema upgrade | B3 atomic compatibility guards, execution-quiescence eligibility and barrier-controlled old-writer tests |
| Lost acknowledgement is mistaken for unused authorization | B3 revocation only from intended/registered; storage rejects authorized-to-revoked; paused-helper tests |
| Local cleanup erases uncertain remote work | B2/B3 distinct remote dispatch checks and existing QA recovery gates |
| Recovery mutation happens just by opening the picker | B3 read-only discovery/inspection/cancellation tests |
| Another conservative check only replaces the stall | Paired blocked-then-successful recovery assertions at each boundary |
| Windows code exists but does not work natively | B4 required executed native matrix and explicit open gate |

All confirmed findings have a concrete resolution and acceptance gate. The plan covers identified causal paths and adjacent races, not every unknowable external failure. Two limits cannot be resolved by assertions or local tests: historical missing evidence may preclude safe automatic cleanup, and native Windows behavior requires a native run. Existing decisions already prohibit blind replay of uncertain work; preserve that policy. No new product-policy decision is needed for B1–B3. Native Windows verification remains explicitly pending, as requested by the user.

- [x] B1 actual preparation and established resume work through the real CLI, including nested transfer.
- [x] B2 durable shared cleanup passes local worker-exit and Unix descendant tests; native Windows/Linux evidence remains under B4.
- [x] B3 local gated-readiness, restricted-reconciliation and migration regressions pass, including terminal cleanup-only reachability, atomic old-writer fencing and strict revocation transitions. Native coverage remains under B4.
- [ ] B4 native Windows tests run and pass; Unix platform checks pass; support limits match evidence.
- [x] Full local regression, documentation and finding-to-test audit pass on the final working tree. Cross-platform sign-off remains under B4.


### 10.8 Implementation and verification record (2026-10-08)

The implementation preserves the existing QA recovery, approval and no-blind-replay contracts. It changes startup ownership, readiness containment, reconciliation and discovery. No production build state was migrated in this turn; all migration/fault/provider experiments used disposable projects. The historical crashed project on the other computer remains unavailable.

| Repair | Implementation | Direct regression evidence |
| --- | --- | --- |
| B1 launch validation | `validateStartOptions` accepts preparation and established recovery separately; `validateRecoveryArguments` checks generated argv before reservation; nested re-exec replaces the outer token | `startArguments.test.ts`; actual preparation and established CLI claims in `buildAdmission.test.ts`, including supervised, direct and detached modes |
| B2 durable cleanup | `readinessCleanup.ts` supplies the shared group/tag or Windows Job evidence; supervisor reads outstanding records owned by its claimed worker on all numeric/signal exits and waits for cleanup before settling child errors | `supervisedStart.test.ts` numeric 0/1 exits suppress IPC and leave escaped descendants; assertions prove cleanup and subsequent readiness, plus existing crash/cancel/parent-death tests |
| B3 registered startup | `readinessGate.ts` registers before authorization and preserves the registered group leader until settlement; revisioned startup history is separate from provider outcome and cleanup evidence; Windows creator stdin stays closed to execution until identity recording | `readinessRecovery.test.ts` paused authorized helper and strict revocation; `runtimeReadiness081.test.ts` registration failure, lost acknowledgement, recording failure, subsequent retry, output and signal preservation |
| Restricted cleanup | Selected-run connections skip migrations/imports and install connection-local SQL guards permitting only updates to the selected readiness records; helpers cannot acquire admission or mutate work through those connections | `readinessRecovery.test.ts` directly attempts forbidden admission, workflow and other-record writes; live/foreign/copied ownership remains untouched |
| Cleanup-only reachability | All non-quiescent durable records use the same predicate for admission and discovery, independent of terminal status or build JSON; owning runs are selected individually; relationship cycles/dangling links prevent cleanup rather than broadening scope | Both aliases in `buildResume.test.ts`; real packaged CLI selectors under PTYs in `resumePty.test.ts`; terminal, missing-projection, cycle and foreign-project fixtures |
| Migration and old writers | Ownership v3 installs persistent compatibility guards transactionally; existing v1/v2 inspection and restricted cleanup remain possible when execution-semantic migration is deferred; new execution requires v3 | Pre-opened connection and unchanged admission-writer path reject after upgrade; rollback, live-legacy deferral, legacy PID-less direct-spawn repair and insufficient-evidence tests in `readinessRecovery.test.ts` |
| Standalone behavior | Unix uses a group-holding helper without constructing a recovery database; Windows retains its standalone Job path; helper re-exec does not inherit eval/debug/CLI arguments from embedded callers | Inherited-pipe, TERM-resistant, scrubbed-environment group, missing executable, cancellation, provider signal and packaged embedded-eval tests |
| B4 platform gate | CI matrix covers Windows/macOS/Linux, shared recovery tests, native process paths and packaged Windows helper execution; native Windows skips fail that gate | Workflow prepared; native Windows/Linux runs not available locally and not claimed as passed |

Unix cleanup signals a group only while its leader incarnation is verified. After losing that proof, it stops verified tagged processes and retains unknown remaining ownership. Tags do not contain adversarial descendants that both remove their tag and escape the group. Windows requires both the creating helper's lifecycle and Job state; an authorized helper with no visible job is never treated as unused authorization.

Cleanup-only reconciliation does not reopen a terminal run, retry tickets, create a successor, or clear remote Builder/QA dispatch uncertainty. Related runs remain independently selectable, and invalid relationships remain visible with an explanation. Historical evidence that cannot establish ownership/quiescence is retained; no force-unlock or database deletion was added.

Five local fake-provider measurements per path (milliseconds): direct executable median **4**, standalone helper **643**, durable build helper **712**. These were measured during test activity and are fixture overhead observations, not provider latency guarantees. Authenticated Claude and Codex readiness both passed on the final helper implementation; each released preparation ownership after verified cleanup.

Final workspace regression: **1,061 tests, 1,049 passed, 0 failed, 12 skipped** (spec 48/48; special-agents 92/92; Rafi 228 passed/2 skipped; foreman 681 passed/10 skipped). The skips comprise two existing TTY-runner cases, two live readiness cases executed separately and passed, two live native compaction/session cases, and six Windows-native cases. New packaged short-command PTY tests passed. Separate packaged `rafi resume` and `rafi build:resume` integration runs both completed a real supervised disposable build with a fake provider, produced code, and left zero outstanding probes. Workspace typecheck, ordered builds, generated CLI documentation check and whitespace checks passed. Source/test hashes remained unchanged throughout the final full-suite run. Native Windows and Linux execution remain pending; CI preparation is not native evidence, and overall platform sign-off remains open. Earlier failed runs exposed a heartbeat connection missing its new compatibility function, fake-provider/approval fixture assumptions, a detached-fixture teardown race, and standalone group cleanup timing; these were corrected and given targeted reruns. Their failed results are not counted as final passes.

## 11. Follow-up audit resolutions (2026-10-09)

Scope: repair all three findings from the section 10 implementation audit; preserve unrelated work. Native Windows/Linux execution remains pending under the user's decision to prepare CI. No test suite guarantees the absence of every possible regression.

### C1 — Separate storage upgrade from provider reconciliation

The deadlock is caused by requiring remote dispatch resolution before schema upgrade while recovery admission requires the upgraded schema. Install schema 3 and its atomic old-writer fences once existing local admission, lease, supervisor, launch and readiness checks establish migration eligibility. Preserve uncertain/in-progress operation records byte-for-byte. Uncertain remote execution is a recovery obligation, not a reason to withhold compatible storage. This supersedes section 10's requirement to finish remote operations before migration; it does not authorize replay.

Regression gates: schema 2 with both in-progress and uncertain Builder/QA records upgrades, retains records, rejects ordinary/different-run admission, and permits owning-run recovery; live/unknown local owners still defer migration; already-open old writers remain fenced; interrupted migrations roll back. Existing QA current-source and no-blind-replay tests remain required.

### C2 — Fail closed for standalone cleanup

Apply unverified-cleanup failure to standalone probes as well as build probes, regardless of success output, timeout, cancellation or exit code. Retain process identity/tag and cleanup evidence in process-local standalone state; subsequent probes must reconcile pending cleanup first. Disconnect the trusted Unix holding helper on failure so it cannot keep a caller alive indefinitely, without treating disconnection as proof of cleanup. Keep standalone commands free of build databases and give standalone-specific diagnostics. Never signal an unverified PID/group. A new process cannot reconstruct lost standalone history; this is not durable build recovery.

Regression gates: unavailable inventory cannot produce ready; retries while unavailable start no provider; restored inventory permits cleanup and successful retry; no recovery DB is created; existing success/missing-executable/cancel/timeout/descendant tests pass. Test packaged helper paths and retain bounded cleanup deadlines.

### C3 — Complete prepared cross-platform coverage

Add portable packaged CLI coverage for both short resume aliases and nested launch transfer, with real processes and disposable projects; use Windows npm shims and platform path delimiters. Add native Windows fault tests for registration failure, committed authorization with lost acknowledgement, final-recording failure, denied inventory, paused job creation, competing cleanup, and successful retry. Retain existing normal/descendant/cancel/helper-death/owner-death cases. Each recoverable fault must assert no unsafe dispatch before cleanup and progress afterward. Run shared recovery tests on all platforms. Require named native cases with no skips and retain logs plus platform/runtime/revision metadata. Native Windows/Linux execution is an explicit open acceptance gate, not satisfied by local mocks.

Implementation order: C1 plus targeted migration tests; C2 plus targeted lifecycle tests; C3 plus packaged CLI/fault tests; ordered builds, typecheck, workspace tests, documentation and whitespace checks. Review final diffs against each acceptance gate and record actual results and remaining platform limits below.

### 11.1 Implementation review and evidence

- C1: `migrateReadinessProtocol` retains all local ownership/launch/readiness gates and installs compatibility triggers transactionally. It no longer waits for remote journal resolution. Four regressions cover Builder/QA × in-progress/uncertain, compare full journal rows before/after, reject old writers and ordinary/different-run admission, and permit owning recovery. Existing live-owner deferral and rollback tests remain intact.
- C2: standalone cleanup failure throws `RuntimeCleanupError`, retains the original containment record, and disconnects the trusted holder without declaring it quiescent. A shared deadline bounds reassessment of pending records before another probe. The Unix denial regression proves false success is rejected, blocked retry launches nothing, restored visibility permits progress, and no build DB appears. Build cleanup and missing-executable behavior remain separate.
- C3: `readinessFaultsPackaged.test.mjs` exercises registration, committed-authorization acknowledgement, cleanup-recording, denied identity, competing cleanup processes and worker death against built JavaScript. `resumePackaged.test.mjs` tests both real aliases through terminal cleanup and a completed preparation successor that produces implementation output. `establishedPackaged.test.mjs` tests real supervised/direct/detached established recovery with unchanged run identity. Windows native tests add a creator held behind its startup gate, cancellation before release, and successful later readiness. The CI native gate requires these named cases, zero skips, and archives both native output and OS/Node/PowerShell/revision metadata.

Coverage limits remain explicit: the denied-identity packaged test injects missing identity into the read-only containment check; it is not evidence of actual Windows ACL behavior. The Unix standalone denial test removes process-inventory availability. Real Windows Job/creator execution is prepared in CI but cannot be established on this Mac. Legacy missing provenance still requires trustworthy evidence; none of these changes clears it automatically.

Targeted local results: 41 migration/runtime tests passed; both packaged short-command build tests passed; all three packaged established modes passed after replacing an incomplete readiness-only fake provider with the existing app-server fixture. The initial incomplete fixture failed all three modes and is not counted as passing evidence. The five initial packaged fault cases passed; the added worker-death case is also included in the final workspace gate. Authenticated Claude and Codex readiness passed (2/2). Ordered workspace builds, typecheck, generated CLI documentation check, README tests and CI YAML parsing passed. Full workspace results are recorded below after completion.

Final local verification: workspace `pnpm test` completed successfully with **1,075 tests: 1,062 passed, 0 failed, 13 skipped** (spec 48/48; special-agents 92/92; Rafi 230 passed/2 skipped; foreman 692 passed/11 skipped). All six packaged fault cases, including worker death, passed in that run. Three additional packaged established-recovery tests were added after the workspace run began and passed separately in supervised/direct/detached modes. The two authenticated readiness tests skipped by default in the workspace run were run separately and both passed. Remaining skips are the existing two TTY-runner cases, two live native compaction/session cases, and seven Windows-native cases. Runtime implementation did not change during the full run. Final whitespace checks passed.

Logs: `/private/tmp/rafi-c123-workspace.log`, `/private/tmp/rafi-c3-established-fixed.log`, `/private/tmp/rafi-c123-live.log`; initial targeted gates are in `/private/tmp/rafi-c12-tests.log`, `/private/tmp/rafi-c3-cli.log`, and `/private/tmp/rafi-c3-faults.log`. All provider/migration experiments used disposable projects. No production state, commit, push, or publication was performed.

- [x] C1 implementation, preservation/admission regressions, existing migration and QA recovery gates.
- [x] C2 implementation, unavailable-inventory blocked-then-successful retry, existing lifecycle regressions.
- [x] C3 prepared CI, local packaged fault/CLI regressions, required native-case and zero-skip assertions.
- [ ] Native Windows and Linux execution/sign-off, explicitly pending per the user's instruction. CI preparation is not native evidence.

## 12. Close the follow-up audit's integration coverage gaps

The two findings concern missing regression evidence, not confirmed new runtime defects. Keep the existing migration, admission, provider uncertainty, approval, QA source binding and containment contracts. Add tests through production boundaries; change runtime code only if a failing regression demonstrates a defect. No production build state or provider quota is needed. Native Windows/Linux execution remains pending under the existing user decision.

### D1 — Persisted interrupted ticket recovery through both real aliases

Keep the existing supervised/direct/detached transfer tests as narrow launch-contract checks. Add packaged `rafi resume` and `rafi build:resume` tests for both Builder interruption and pending QA. Use a real initialized Git/ticket project, a nonempty ticket, captured provider settings and persisted interruption state; do not supply a fabricated recovery decision or replace the command action/projection/launcher. Let the actual resume command freeze its decision and transfer ownership to the actual CLI and supervisor/worker. Use a deterministic local provider and observe provider turns, implementation output and durable ticket/QA outcomes.

For Builder recovery, require completion under the original run and ticket, with no preparation successor or leftover readiness. For QA, require an existing pending durable QA state to reach a new full review and an authoritative pass for current source, preserving earlier review history. Exercise stale revision rejection before provider work, then successful recovery using current state. Assert the decision receipt is created by resume, original scope/settings remain bound, and provider work is not duplicated. Use explicit fresh recovery for noninteractive fixtures; this does not change interactive selection or authorize replay of uncertain provider operations. Existing uncertainty, packet integrity, source drift, continuity and budget tests remain regression gates.

### D2 — Production reconciliation of a paused Windows creator

Replace the manual-kill proof with a real registered/authorized helper and real Windows Job creator held behind its stdin gate. The fixture uses production registration, authorization, creator recording and containment commands; only the execution barrier is test-owned. Confirm absent Job plus live creator remains unknown and blocks another probe. Exercise an expired reconciliation deadline first to prove unresolved state cannot authorize retry. Then invoke production durable reconciliation to stop the helper/creator and persist verified cleanup. Only after reconciliation reports success attempt late authorization; it must not execute the provider. Assert recorded incarnations are dead, Job absent/empty, authorization history remains authorized, cleanup is quiescent and a subsequent real readiness probe succeeds. Manual process termination is permitted only in fixture teardown, never as the decisive assertion.

Keep separate EOF, normal execution, descendant, cancellation and owner-death tests. Require the new reconciliation case by name in Windows CI with zero skips. Preserve bounded timeouts and disposable-only teardown. Native execution is required before platform sign-off; passing syntax/typechecks on macOS is insufficient.

### Verification and plan audit

Run each new integration matrix after its implementation and fix demonstrated failures before moving on. Run existing selector/launcher, QA recovery and readiness/migration suites, ordered builds, workspace typechecking, full workspace tests, generated documentation and whitespace checks on the final changes. Record actual failures, fixes, skips and results below. The paired blocked-then-successful assertions cover the identified failure paths; they cannot prove every external failure impossible or guarantee zero regressions. Do not mark native verification complete without native results.

### D1 defects exposed by integration, and bounded repairs

The first integration run exposed a missing context-window response in the fake provider; correct that fixture. The subsequent run reached production recovery and exposed three gaps: the short alias rejects explicit recovery options; current-branch resume does not forward its projected interrupted ticket, allowing generic work to complete while that ticket remains in progress; successful QA-only recovery leaves its finished run recoverable, which the supervisor correctly treats as unfinished and returns exit 2.

Share the existing build recovery option definitions with the short alias, forwarding explicit options to the existing semantic validator. Reject those options for interview resume/discard before side effects, including picker selections. Preserve bare selector behavior, mode/approval conflicts and unknown-option rejection.

Bind current-branch recovery to the same ticket as its frozen preview, rejecting out-of-scope tickets. Preserve isolated-branch multi-ticket behavior. At successful current-branch ticket/QA/finalization boundaries, inspect actual ticket states for the saved run scope: complete only if every ticket is done and the existing QA finalization guard passes; otherwise retain a recoverable run, record completed tickets and select the next unfinished one. Missing/blocked/in-progress states do not count as done. Never widen the scope, infer QA success from provider output, or alter uncertain dispatch records. Cover partial scope, missing state, out-of-order completion and QA guard rejection in unit tests, and actual one-ticket completion through both packaged aliases.

Final review adds a positive continuation gate: inferring the first recovery ticket must not implicitly reduce a multi-ticket Builder recovery to one step. Preserve its remaining step count unless the operator explicitly selects one ticket or the command is recovering a QA-only boundary. Bound the resumed batch to saved-scope tickets, stop when none are eligible rather than dispatch generic/out-of-scope work, and reject a provider completion naming a different ticket from the selected work item. Two packaged eligible-independent-ticket cases failed before this adjustment; require them to pass afterward, alongside blocked-scope and explicit-selection cases. Ordinary unscoped batches and isolated-branch behavior retain their existing contract.

### 12.1 Implementation and review record

| Finding or exposed defect | Implementation | Regression evidence |
| --- | --- | --- |
| D1 established recovery lacks interrupted-ticket evidence | `interruptedPackaged.test.mjs` runs both real aliases against persisted nonempty Builder and QA scope using a local app-server provider; no recovery receipt, projection or launch action is substituted | Ten cases: both aliases × Builder/QA × complete/another blocked ticket, plus both aliases continuing eligible independent Builder work; stale QA revision starts zero provider work; original run identity, policy, scope, implementation bytes, exact work-turn counts and ticket outcomes asserted |
| Missing current-branch ticket selection | `currentBranchRecoveryTicket` binds the frozen preview to saved scope, used by both the resume wrapper and direct start; current-branch resume forwards the ticket | Actual packaged recovery completes T001 rather than generic work; helper rejects out-of-scope state and preserves unticketed compatibility; existing isolated transfer tests remain |
| Successful QA recovery reported unfinished | `finishRecoveredTicketScope` checks actual saved-scope ticket states after successful Builder/QA/finalization boundaries; existing QA finalization validation still gates terminal completion | Packaged QA exits successfully for finished scope; partial scope stays recoverable with the other ticket blocked; unit cases cover missing, blocked, in-progress, out-of-order done states and non-final QA rejection |
| Short alias rejects explicit recovery options | Shared option definitions and forwarding, with semantic validation retained in `build:resume`; interview routes reject build options before mutation | Explicit and picker-selected build forwarding; interview ID/discard/picker rejection; existing bare picker and interview tests |
| D2 paused Windows creator bypasses production cleanup in test | Real helper registration, authorization and creator recording with a test-owned stdin barrier; production `reconcileReadiness` owns the decisive termination and persisted receipt | Native case checks unknown live-creator evidence, expired-deadline blocked retry, verified helper/creator death, unchanged authorization history, late acknowledgement rejection and successful subsequent build readiness; native execution pending |

The QA integration validates the certificate's frozen source against implementation bytes and completed finalization receipts. Generated tracker publication legitimately changes the broader source inventory after QA; comparing the whole post-publication inventory with the earlier review digest was an incorrect test assertion and was corrected. Early fixture failures (missing provider context-window response) are also excluded from passing evidence. Production failures in ticket selection and QA completion were reproduced before repair; they were not bypassed by weakening test outcomes.

Local task gates: initial selector/state/integration regression **66/66 passed**; final ticket-scope/start-argument checks **29/29 passed**; final scope/alias/packaged/README checks **40/40 passed**; broader QA/readiness/migration/packaged checks **103 tests, 96 passed, zero failures, seven native Windows skips**. Ordered builds, workspace typechecking and generated documentation checks passed. CI serializes test files to avoid accidental contention from independent PowerShell compilers while retaining deliberate process races inside their named tests. Native Windows/Linux execution remains pending.

The final continuation adjustment passed all **ten packaged interruption cases** and **45 queue/selector regressions**, including an oversized step budget, unrelated eligible tickets, exhausted/blocked scope and wrong-ticket provider output. Logs: `/private/tmp/rafi-d1-eligible-fixed.log`, `/private/tmp/rafi-d12-continuation-regression.log`. The before-fix eligible-work reproduction failed both aliases as expected; its log is `/private/tmp/rafi-d1-eligible-before.log`.

Final workspace verification on the completed implementation: **1,102 tests, 1,089 passed, zero failed, 13 skipped**. Breakdown: spec 48/48; special-agents 92/92; Rafi 248 passed/2 skipped; foreman 701 passed/11 skipped. The skips are two TTY-only cases, two opt-in authenticated readiness cases, two opt-in native provider session/compaction cases and seven native Windows cases. This turn used local providers only; prior authenticated results remain historical rather than new evidence. The earlier workspace run also passed but preceded the final independent-ticket adjustment; the authoritative final log is `/private/tmp/rafi-d12-workspace-final.log`.

All **269 source/test/package/CI files** recorded at the final suite's start retained identical hashes through completion, with no added or removed files in that inventory (`/private/tmp/rafi-d12-final-hashes.json`). Ordered builds, final workspace typechecking, generated CLI documentation, CI YAML/required-case checks and whitespace checks passed. The user confirmed the concurrent version bumps were intentional; ai-foreman 1.7.20, Rafi 0.9.20 and their lockfile references were preserved and checked for agreement.

Other task-gate logs: `/private/tmp/rafi-d1-regression.log`, `/private/tmp/rafi-d12-scope-check.log`, `/private/tmp/rafi-d12-final-scope.log`, `/private/tmp/rafi-d12-targeted.log`, `/private/tmp/rafi-d12-final-typecheck.log`. All experiments used disposable projects. No production state, provider quota, commit, push or publication was performed by this implementation turn.

- [x] D1 both aliases, persisted Builder/QA state, current-source certificate/finalization evidence, original scope and eligible independent continuation.
- [x] D2 production reconciliation regression implemented, typechecked and required by name in prepared native CI; existing portable checks pass.
- [x] Final full local regression and source-to-plan review, including the runtime defects exposed by the new tests.
- [ ] Native Windows/Linux execution and platform sign-off, pending under the user's existing instruction. Local skips and CI preparation are not native execution evidence.

## 13. Recovery dispatch and interrupted-progress repairs

This section supersedes section 12's completion, inferred-selection and scope behavior where they conflict. The read-only audit confirmed five remaining defects. Preserve existing version bumps, lease/generation fencing, exact QA recovery, uncertain-dispatch protection, isolated worktree behavior and native verification status.

1. **Reconcile interrupted progress and selection.** Current-branch progress must include every saved-scope ticket not durably done, irrespective of ordering/currentTicket. Consult ticket state and unresolved QA/question records, including on read-only previews after an abrupt crash. Never infer completion for missing state. Prioritize pending QA recovery over new Builder work. Reconcile at successful and interrupted batch boundaries; terminal completion still requires the existing QA guard and no unanswered decisions. Tests cover blocked-first/done-second, out-of-order completion, stale snapshots, absent state, QA finalization and legacy/isolated compatibility.
2. **Freeze execution scope separately from saved context.** Add optional execution ticket IDs to the recovery receipt. Bare resume permits the saved run scope; explicit selection and QA-only recovery permit only the selected ticket. Validate subset and command/receipt agreement. Old receipts and direct commands with explicit tickets conservatively retain the explicit subset. Carry this scope into planning, approval, eligibility, unblocking and dispatch, never substitute a completion budget for authorization. Test both aliases, explicit blocked selection with another eligible ticket, and bare independent continuation.
3. **Do not treat resume as an answer.** Exclude tickets with pending decisions (even if their tracker row says next/in-progress). Run-wide pending questions stop dispatch. Stale, unconsumed answers cannot authorize reopening; scope-valid answers are consumed only for the selected authorized ticket. Perform unblocking only after selection/approval, within invocation scope. Preserve ordinary retry of blocked tickets without a question. Tests cover pending/answered/stale/out-of-scope questions and eligible independent work; terminal completion rejects pending decisions.
4. **Approve all executable work and recheck before dispatch.** Approval covers the invocation execution scope rather than its first ticket. Capture the approved source revision after the existing durable approval flow; compare it again before every selected ticket is mutated/dispatched. A changed revision re-enters the same durable approval flow, so a later ticket cannot inherit outdated authorization. Include branch/delivery consequences. Planning prompts remain within execution scope. Test later-ticket material edits, unchanged approved scope, legacy --yes behavior and edits between work turns.
5. **Bind prompts and completions to the actual selected ticket.** Include an explicit assignment and required ticket marker in every ticketed Builder work instruction (including later turns/handoffs). Scoped recovery rejects missing or mismatched ticket identity before QA/completion; do not replay implementation merely to repair an ambiguous completion. Update the packaged provider fixture to derive its ticket from the prompt, write distinct ticket output and name that ticket. Assert both outputs and no unselected mutation, rather than just counting turns.

Implementation order: progress/selection and regression tests; receipt/dispatch scope plus questions; approval and prompt binding; packaged end-to-end evidence. After each coherent change run its focused regression suite. Then build in dependency order, typecheck, run the complete workspace suite, check generated documentation and whitespace, and audit the final diff against every item above. If testing exposes additional interactions, repair and retest them before recording completion. Native Windows/Linux execution remains pending under the user's existing instruction; local tests cannot guarantee the absence of every regression.

Plan audit: the same ticket set must govern planning, approval and dispatch; a valid answer does not authorize out-of-scope mutation; tracker completion cannot erase unresolved QA or questions; read-only crash recovery must not rely solely on a final checkpoint; partial completion must preserve earlier blocked work; explicit selection must not disable independent continuation for bare resume. These are acceptance criteria, not assumptions. No unresolved product choice requires another user decision.

### 13.1 Additional interactions exposed by implementation tests

The new two-invocation packaged cases failed even after correcting ticket progress: explicit fresh recovery inherited legacy compaction uncertainty and attempted to transfer ownership from its new session while the old role lease still owned the run. A second failure exposed the underlying lease mismatch before provider work. Repair both causes: fresh sessions do not inherit predecessor compaction counts; when a predecessor role lease exists, establish the new owner with a response-only validation turn and a valid continuity checkpoint before context probes/work. Limit this exception to the explicit validation method; retain admission, worker-generation and unresolved-dispatch fences. Invalid/error validation cannot move ownership or fall through to implementation. Apply the shared validation to Builder and QA decorators; accepted existing owners need no extra validation turn. Test both roles, valid/invalid/error/unknown outcomes and two consecutive resumptions through both packaged aliases.

Stale unused answers also require a usable resolution path. Atomically persist a replacement question bound to the current scope and an explicit supersession receipt; preserve the old answer as history. Do not create replacements outside the invocation scope, consume answers for unselected tickets, or leave an obsolete answered question as an unanswerable permanent blocker. Test answering the replacement and then successfully resuming.

### 13.2 Implemented resolution map

| Audit finding | Resolution and acceptance evidence |
| --- | --- |
| Completed later ticket hides earlier deferred work | Read-only `currentBranchTicketProgress` reconciles all saved tickets with tracker, pending QA and questions. Interrupted snapshots reconcile through `saveBuildRun`; ordinary and recovered batch boundaries settle actual scope. Packaged repeated resumes preserve T001 when T002 completes, and both aliases finalize a lost completion checkpoint without replaying planning/Builder/QA. |
| Explicit selection executes another ticket | Optional `executionTickets` in the frozen receipt separates invocation authorization from saved context. `recoveryExecutionTickets` validates subsets and conservatively handles legacy/direct commands. The same set reaches preflight, approval, answer handling and batch selection. Both aliases prove a blocked explicit T001 leaves eligible T002 untouched; subsequent bare resume completes remaining scope. |
| Resume bypasses questions | Pending decisions prevent dispatch regardless of tracker selection. Only the selected in-scope ticket is unblocked after approval. Stale unused answers receive atomic, current-scope replacement questions, preserving historical answers. Tests prove pending/run-wide/stale/out-of-scope behavior, answer consumption and successful replacement-answer continuation. Unfinished dependencies also remain blockers. |
| Approval misses later tickets | `createBuildApprovalGate` covers execution scope, caches only its approved source revision and rechecks before each ticket. Selection is recomputed if approval feedback changes definitions or eligibility. Tests prove materially changed T002 asks even when T001 is approved, and edits between turns trigger approval before dispatch. |
| Ambiguous later prompts and false-positive fixture | Every selected work prompt names its ticket. Question answers and protocol corrections retain ticket scope across safe boundaries; correction instructions prohibit replaying tools/implementation. Scoped completion without the matching ID cannot run QA or complete a ticket. The packaged provider derives its ticket from the prompt and writes independently asserted T001/T002 files. |

Final review also added two defensive checks: failed fresh-session validation closes the unused replacement; terminal completion rejects unresolved Builder/QA dispatches even when the tracker says done. These preserve the old owner and uncertainty evidence. The new crash test initially counted provider setup as planning; its fixture now identifies the real planning instruction separately, while still requiring zero planning, Builder and QA work after completed-scope recovery.

Final verification results are recorded below after the full workspace run and a rebuild/retest of changes made during the final review. Native Windows/Linux execution remains pending. Existing version bumps and unrelated edits are preserved; this task does not publish or commit.

The first full workspace run passed all runtime tests (721 passed, 11 platform/opt-in skips), then exposed 22 CLI failures rooted in legacy fixture tracker files that were not valid SQLite databases. Read-only progress reconciliation now treats missing/unreadable tracker evidence as unfinished work, leaves the original bytes unchanged, and keeps the recovery entry inspectable. Actual dispatch still requires a usable tracker; this fallback grants neither completion nor execution authority. The dedicated corrupted-tracker regression passes. Rebuild and rerun the affected CLI/terminal tests before the final full workspace rerun; the failing workspace run is not completion evidence.

### 13.3 Final verification and audit result

All five findings and the additional interactions above are implemented and reviewed against their callers, durable state, provider boundaries and regression tests. Final workspace coverage: **1,131 tests; 1,118 passed; zero failures; 13 skipped**.

| Package | Passed | Skipped |
| --- | ---: | ---: |
| ai-foreman | 724 | 11 |
| Rafi CLI | 254 | 2 |
| rafi-spec | 48 | 0 |
| special-agents | 92 | 0 |

The final full runtime run passed all 735 cases (724 passed, 11 skipped). The subsequent CLI run exposed two older preparation-recovery fixtures that omitted the now-required ticket identity. Production correctly rejected those ambiguous completions. Both fixture callers now reuse the ticket-aware provider and assert exact T001 implementation bytes. The entire 256-case CLI suite was rerun successfully, followed by the complete spec and special-agents suites. No production changes were made after the final full runtime run. The corrected fixture caller is the only change among the 288 recorded source/test/package/CI inputs since that run began; its full package rerun covers it. Final hashes: `/private/tmp/rafi-repair-completed-hashes.json`.

Builds in dependency order, workspace typechecking, generated documentation and whitespace checks passed. The focused final repair gate also passed **133/133** cases, including selector/terminal-picker compatibility. The 16 packaged interruption cases cover both aliases, partial scope, distinct independent output, explicit blocked selection, repeated recovery, lost completion checkpoints and exact QA recovery. Runtime tests cover source-bound approval changes, scoped pending/answered/stale questions, missing/mismatched completion identity, protocol-correction ticket scope, missing/corrupt state, dependencies and uncertain-dispatch completion guards. Fresh-session validation tests cover Builder and QA with valid, invalid, error and unknown-dispatch outcomes, including cleanup of failed replacements.

Authoritative logs: `/private/tmp/rafi-repair-workspace-verified.log` (successful full runtime section), `/private/tmp/rafi-repair-rafi-verified.log`, `/private/tmp/rafi-repair-spec-verified.log`, `/private/tmp/rafi-repair-agents-verified.log`, `/private/tmp/rafi-repair-final-focused.log`, `/private/tmp/rafi-repair-recheck-types.log`, `/private/tmp/rafi-repair-docs-verified.log`. The earlier failed runs are retained as diagnostic evidence, not counted as successful validation.

The skips comprise seven native Windows cases, four opt-in authenticated provider cases and two TTY-only cases. Native Windows/Linux execution remains pending under the user's existing instruction. All new integration work used disposable projects and local providers. Versions ai-foreman 1.7.20 and Rafi 0.9.20 and unrelated edits were preserved; no commit, push, publication or production-state migration was performed.

- [x] Five audit findings repaired and audited against the final implementation.
- [x] Additional defects exposed by repeated-resume, stale-answer and legacy compatibility tests repaired.
- [x] Final builds, typechecks, all workspace package tests, documentation and whitespace validation.
- [ ] Native Windows/Linux execution and platform sign-off, still pending.
