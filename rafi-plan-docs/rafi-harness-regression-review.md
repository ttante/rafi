# Rafi harness requirements: implementation regression review

> Handoff copy packaged 2026-10-10. Place this folder at the Rafi repository root. Source/test links resolve against that repository; historical observations describe the inspected reference snapshot. Read [agent implementation instructions](AGENT-INSTRUCTIONS.md) before execution.

Date: 2026-10-09. Applies to [the harness requirements](rafi-harness-requirements.md).

This review compares the proposed requirements with the local `rafi-ref` implementation at commit `4aa437b3cf19d83d7bb5dc8482bb4b04709c887a`, CLI 0.9.20 and runtime 1.7.20. It identifies behavior to preserve, gaps the new requirements should close, and interactions that could regress during implementation. It does not authorize implementation or rollout.

The principal risk is replacing working authority and evidence contracts with simpler-looking orchestration. Several baseline requirements already have substantial implementation and regression tests. Preserve those contracts and strengthen their production-path evidence before rewriting them.

## Evidence and limits

Direct inspection covered the Foreman and start/resume callers, workflow storage and admission fences, QA review/snapshot/runtime/prerequisites, adapter contracts and event forwarding, supervision/deadlines, ticket population, and related tests. Later recovery-plan sections were compared with current code and test cases. Source links below identify the implementation surfaces; test links identify existing assertions to preserve, not a claim that those tests passed during this review.

The reference checkout was clean. Its `node_modules` and local `tsx` executable were absent, so runtime tests, typechecks, builds, packaged tests, and live-provider runs were not performed. No dependencies were installed, providers invoked, app state changed, or reference source edited. Historical passing results remain historical. Native Windows/Linux verification still needs its own evidence.

Risk priorities below describe the consequences of an implementation regression, not confirmed severity of a present production bug. **Critical** risks can permit unauthorized work, duplicate effects, invalid acceptance, or state corruption. **High** risks can stall legitimate work, lose recovery/evidence, or create materially misleading results.

## A. Validation and baseline quality

### CR01 — Add executed verification without bypassing source-bound QA — Critical

**Requirements:** B22, B27–B29, E08–E09, F07, R01.

**Observed:** [QA review](../packages/ai-foreman/src/qaReview.ts), including the `qa_pass` branches and `finishV2Pass`, checks the durable turn, source/review binding, response validity, and known missing prerequisites before issuing a certificate. [The response parser](../packages/spec/src/qaFailureReport.ts) permits `qa_pass` with a summary; that response contract does not demand a per-check execution manifest. [Prerequisite checks](../packages/ai-foreman/src/qaPrerequisites.ts) explicitly establish host availability, not successful provider execution. This is a concrete distinction between the existing certificate and B27's proposed stronger proof.

**Regression risk:** accepting a test manifest instead of independent QA would lose source and finalization guarantees. Conversely, continuing to treat a valid QA marker as proof that all commands ran would leave B27 unimplemented. Applying the new rule to old certificates without migration could strand valid recoveries.

**Required safeguard:** integrate criterion execution evidence into the existing review basis/certificate/finalization contract. Bind check identity, command/scenario, source/test/environment basis, result and evidence. Keep independent QA, single-use certificate consumption, and source revalidation. Version new contracts; legacy evidence must be explicitly classified rather than fabricated or silently grandfathered into stronger claims.

**Gate:** a valid `qa_pass` with missing, stale, fabricated or incomplete mandatory execution evidence cannot satisfy the new contract; complete observed evidence plus independent QA can. Preserve [QA protocol/finalization tests](../packages/ai-foreman/test/qaProtocolV2.test.ts) and [parser compatibility tests](../packages/spec/test/qaFailureReport.test.ts). Exercise fresh, recovered and finalization-only production paths.

### CR02 — Red-to-green must remain practical and behavior-based — High

**Requirements:** B27–B28, E09, F09.

**Observed:** [Foreman](../packages/ai-foreman/src/foreman.ts) orchestrates implementation turns and QA, while the [adapter event contract](../packages/ai-foreman/src/adapters/types.ts) allows tool output and exit/completion fields to be unavailable. An instruction to use TDD and a turn-level completion are not a complete behavioral test history.

**Regression risk:** requiring a red phase for every task would block documentation, refactoring, already-correct behavior, and legitimate impractical-TDD cases; agents might manufacture failures to satisfy the gate. A tool exit code alone can also misclassify an unavailable dependency or unrelated compiler failure as a useful red.

**Required safeguard:** classify applicability before work. For applicable repairs/features, observe meaningful pre-change behavioral failure and post-change success with test identity and related regression checks. For exceptions, retain reason and appropriate independent post-change validation. Unsupported observation must remain unavailable, not invented. Reconstruct pre-fix tests only in disposable state; never reset the user's working checkout to manufacture evidence.

**Gate:** include real repair, already-green, documentation/refactor, missing tool, unrelated compile failure, changed/removed assertion, provider lacking execution output, and interrupted red/green sequences. Exceptions do not count as demonstrated TDD or eliminate mandatory post-change checks.

### CR03 — Observe the source at each check, not only at turn completion — Critical

**Requirements:** B27–B28, E02–E03, E11, F07/F09.

**Observed:** [Builder events](../packages/ai-foreman/src/adapters/types.ts) carry tool lifecycle and correlation data, but fields are optional. [QA capture](../packages/ai-foreman/src/qaSnapshot.ts) freezes source for review; it does not by itself reconstruct every intermediate Builder edit inside a turn.

**Regression risk:** a final source digest attached to earlier test output can falsely certify changes made after that test. Missing/truncated output, multi-command shells, background jobs, and test runners that report partial success can produce a false green. Capturing twice around the entire turn cannot prove the intermediate red-to-green order.

**Required safeguard:** define an execution-evidence capture boundary, through supported tool observation or a dedicated controlled check runner. Capture the tested basis at execution, final outcome, ordering and coverage. Preserve raw-evidence integrity and distinguish complete, partial and unavailable observations. Do not infer a successful command merely from a later assistant statement.

**Gate:** check-pass-then-edit, concurrent edit during check, shell chain with an earlier failure, detached test process, nonzero exit, timeout with late success, and truncated output. A later source change invalidates affected evidence without erasing the earlier execution history.

### CR04 — Stronger verification must not confuse environment and source defects — High

**Requirements:** B12/B14/B21/B27/B32, E07/E09/E10.

**Observed:** [Prerequisites](../packages/ai-foreman/src/qaPrerequisites.ts) distinguish unavailable executable/dependency/service/network checks from missing required lockfiles. Detection currently recognizes selected command patterns and root manifests; it is not a universal parser for all project tooling. [Prerequisite tests](../packages/ai-foreman/test/qaPrerequisites.test.ts) preserve non-mutating, bounded probes.

**Regression risk:** discovering a script or host executable could be mistaken for provider access; unsupported nested-project commands could be silently omitted. Automatic provisioning could change lockfiles or external services during supposedly read-only QA. Repeated remediation could keep editing correct code to fix a missing database.

**Required safeguard:** derive checks from approved verification contracts, including nested workspace cwd, prerequisites and permission context. Host preflight remains advisory. Provisioning belongs to an authorized setup phase; QA never gains setup authority simply because verification is blocked. Preserve a usable recovery path and independent continuation where scope permits.

**Gate:** host-present/provider-denied, nested manifest, custom script, unavailable database/browser, missing source-owned lockfile, and restored prerequisite followed by successful fresh verification.

### CR05 — Preserve snapshot identity, finalization and dirty-user-state protection — Critical

**Requirements:** B22/B27, F07, R01/R02.

**Observed:** [QA snapshots](../packages/ai-foreman/src/qaSnapshot.ts) include HEAD, index/staging distinctions, tracked and untracked bytes, modes, symlinks, and repository metadata; capture requires a stable pair. Finalization compares a prospective Git tree with narrowly allowed host projections. [Snapshot tests](../packages/ai-foreman/test/qaSnapshot.test.ts) and [branch finalization tests](../packages/ai-foreman/test/branchFinalization.test.ts) cover these protections.

**Regression risk:** caching by HEAD, edited filename, or a plain diff can miss untracked files, staged differences, permissions or repository changes. Broadly excluding generated paths can accidentally exclude product files. New evidence files in the worktree can themselves trigger invalidation loops.

**Required safeguard:** keep exact source/review identity and final publication checks. Store execution records in appropriate control storage; explicitly version any digest semantics or exclusions. Separate portable content identity from repository/session/environment identity without substituting one for another. Concurrent user edits invalidate acceptance rather than being discarded.

**Gate:** staged/unstaged split, binary/untracked/symlink/mode changes, source drift during capture/finalization, unrelated dirty base, and legitimate host tracker updates. Cache reuse must prove unchanged relevant basis and coverage.

### CR06 — Browser checks and QA dependency reuse need actual isolation — Critical

**Requirements:** E07/E10, B14/B22/B27, H11, R06.

**Observed:** [Snapshot dependency projection](../packages/ai-foreman/src/qaSnapshot.ts), `projectDependencyTrees`, links ignored `node_modules` directories from the source checkout. [QA runtime receipts](../packages/ai-foreman/src/qaRuntime.ts) describe read-only source and isolated scratch; a symlink or receipt label alone is not proof that all subprocesses and browser tools are confined.

**Regression risk:** tests/install scripts can write through shared dependencies. Browser testing can access a live MoneyFarm server or production data, reuse authentication storage, leave servers running, or mutate databases despite read-only source. Tightening filesystem/network access indiscriminately can also break legitimate verification or provider authentication.

**Required safeguard:** verify effective confinement for shared dependency targets and every launched tool. Use immutable dependency reuse or disposable writable dependency state when necessary. Give browser fixtures isolated services, ports, data, credentials and explicit cleanup/ownership. Separate provider-required connectivity from application network authority.

**Gate:** attempt writes through dependency symlinks, browser-to-hostile/live endpoint, service port collision, test database mutation, auth-storage leakage, ignored-output writes, and cancellation leaving a child server. Include legitimate successful browser and dependency-backed checks.

## B. Recovery, authority and scheduling

### CR07 — Saved run context must not become execution permission — Critical

**Requirements:** B07–B09/B17–B18/B31, F02/F06.

**Observed:** [Start](../packages/ai-foreman/src/cli/start.ts), [build resume](../packages/rafi/src/buildResume.ts), and [Foreman](../packages/ai-foreman/src/foreman.ts) carry invocation execution tickets separately from saved run tickets. [Recovery tests](../packages/ai-foreman/test/foreman.test.ts) cover blocked explicit selection, bare independent continuation and out-of-scope completion.

**Regression risk:** larger work chunks, external planners or shared packets may dispatch another eligible ticket when an explicitly selected ticket is blocked. Using `--steps` as permission or taking the union of saved/selected scopes widens authorization.

**Required safeguard/gate:** freeze the same execution set through planning, approval, answer consumption, eligibility and every dispatch. Explicit T001 cannot implement T002; bare resume may continue eligible saved scope. Retain actual ticket markers and no-unselected-mutation assertions through both aliases and all launch modes.

### CR08 — Approval reuse must retain material-change rechecks — Critical

**Requirements:** B07/B25/B30, F02/F10, H01–H09.

**Observed:** `createBuildApprovalGate` is wired into [start](../packages/ai-foreman/src/cli/start.ts) and covers execution scope; [Foreman tests](../packages/ai-foreman/test/foreman.test.ts) and [stall repair tests](../packages/ai-foreman/test/buildStallRepairs.test.ts) cover later-ticket changes, between-turn edits and unchanged approved scope.

**Regression risk:** optimizing away approvals by plan ID alone, or letting an external harness approve its own refreshed plan, can retain authorization after a material change. Conversely, approval keyed to every telemetry/config byte can produce endless prompts.

**Required safeguard/gate:** reuse only the approved material revision and consequences, recheck before mutation, and recompute selection after feedback. Test unchanged scope with no redundant question; changed acceptance/dependencies/delivery on a later ticket requires authorization. Keep provider tool permissions distinct from Rafi plan approval.

### CR09 — Resume is not an answer; stale answers need scoped replacement — Critical

**Requirements:** B08–B09/B17/B21/B32, F10.

**Observed:** [Foreman decision tests](../packages/ai-foreman/test/foreman.test.ts) cover pending, answered, stale, outside-scope and run-wide questions. [Workflow storage](../packages/ai-foreman/src/workflowDb.ts) records decision supersession; [handback safety tests](../packages/ai-foreman/test/qaHandbackSafety.test.ts) cover durable correlated answers.

**Regression risk:** treating resume/retry/approval as a question response; consuming an answer on the wrong ticket; hiding pending QA behind a tracker `Done`; or making a stale answered question permanently unanswerable.

**Required safeguard/gate:** preserve decision binding, exactly scoped consumption and supersession history. Pending run-wide decisions stop dispatch; ticket decisions permit only legitimate independent work. Replacement question → current answer → successful scoped continuation must work after restart without reopening an unselected ticket.

### CR10 — Do not replay work to repair a completion envelope — Critical

**Requirements:** B05/B10/B18–B20, B26/B31, H14.

**Observed:** [Foreman](../packages/ai-foreman/src/foreman.ts) pins assignments and distinguishes pending QA recovery from new Builder work. [Handback safety tests](../packages/ai-foreman/test/qaHandbackSafety.test.ts) reject missing/foreign/duplicate terminal evidence, provider errors, stale reports and correction tools.

**Regression risk:** a new verification hook or native adapter may redispatch implementation when the code was changed but the marker/report was malformed. Valid output can mask an errored provider turn; repair output can be attributed to the original execution incorrectly.

**Required safeguard/gate:** preserve original turn identity, outcome and raw evidence; response repair is bounded and tool-free. Missing ticket identity cannot finalize another ticket. Test implementation bytes changed followed by ambiguous marker, errored valid-looking response, correction reading/reverting files, and QA-only recovery with zero new Builder dispatch.

### CR11 — Preserve handoff fencing and the narrow ownership-validation exception — Critical

**Requirements:** B04–B06/B15–B18, F04/F06.

**Observed:** [Unified continuity tests](../packages/ai-foreman/test/unifiedContinuity.test.ts) cover sole-role lease transfer, precise rejection causes, fresh recovery ownership validation for both roles, and accepted successor receipts. [Crash tests](../packages/ai-foreman/test/handoffCrash.test.ts) cover process death at handoff boundaries.

**Regression risk:** replacing durable generation high-water marks with a session counter allows stale owners back in. Fresh sessions inheriting predecessor compaction state can immediately stall. Removing the response-only validation exception can deadlock recovery; making it generic allows work before ownership transfer.

**Required safeguard/gate:** transfer only after valid scoped identity/checkpoint/acceptance and retain predecessor authority on rejection. Fresh-session context accounting starts fresh while run budgets survive. Test valid/invalid/error/unknown ownership validation, accepted-but-idle, two consecutive resumes, and stale predecessor writes; validation cannot invoke implementation tools.

### CR12 — Parallelism conflicts with current project-wide writer admission — Critical

**Requirements:** B16/B26, F06, H13–H14, R01/R02.

**Observed:** [Workflow DB](../packages/ai-foreman/src/workflowDb.ts) has a singleton project lease; [admission](../packages/ai-foreman/src/buildAdmission.ts) enforces authority through SQL fences. [Admission tests](../packages/ai-foreman/test/buildAdmission.test.ts) require competing starts to be rejected. Worktrees alone do not replace this ownership model.

**Regression risk:** enabling several native/external builders on one project can violate admission, tracker publication and finalization assumptions. Disabling existing fences to make parallel tests pass permits stale owners or conflicting writers.

**Required safeguard/gate:** treat F06 as an explicit ownership architecture experiment. Define coordinator versus per-isolated-scope authority, shared-file/dependency conflicts, publication serialization, integration acceptance and cancellation. Preserve current single-writer behavior by default. Prove allowed nonconflicting concurrency and rejected overlapping work; recertify the integrated source before publication.

### CR13 — Milestones must not silently redefine tickets or completion budgets — High

**Requirements:** F02/F03, B17–B18/B27, H08/H12.

**Observed:** [Foreman primers/batch execution](../packages/ai-foreman/src/foreman.ts) specify one ticket/step per turn. [Ticket population](../packages/ai-foreman/src/ticketPopulation.ts) requires exact approved slice mappings, stable identities and explicit retirements; [population tests](../packages/ai-foreman/test/ticketPopulation.test.ts) protect them.

**Regression risk:** one milestone `done` marks multiple unfinished tickets complete, changes `--steps` meaning, skips an unresolved dependency, loses independent QA, or duplicates tickets when importing another spec framework.

**Required safeguard/gate:** retain versioned ticket traceability and per-criterion status within a milestone. Specify partial completion, remaining budgets, pending questions, review cadence and legacy CLI semantics before enabling it. Test blocked-first/done-second ordering, crash mid-milestone, selective recovery and imported plan updates with stable IDs.

## C. Durable execution and lifecycle

### CR14 — New observers must not steal or delay authoritative events — Critical

**Requirements:** E02/E11, B19–B20/B26/B28, H14.

**Observed:** [Recovering adapter](../packages/ai-foreman/src/adapters/recovering.ts) owns its async event pump and forwards synchronous `observeEvents` before `sendTurn` resolves. [Handback safety tests](../packages/ai-foreman/test/qaHandbackSafety.test.ts) assert one subscriber does not steal another consumer's terminal events.

**Regression risk:** the red/green observer consumes the display iterator; buffered terminal events arrive after journal unsubscription; observers duplicate persisted events; subscriber exceptions or slow hashing affect provider completion. A provider replacement can strand subscriptions.

**Required safeguard/gate:** one transport event owner, safe fan-out, stable correlation/deduplication and explicit observer teardown. Keep required execution evidence durable; optional display/analytics failure must not create authority. Test concurrent display/journal/check observers, slow/throwing listeners, replacement, output flood and repeated cancellation with bounded resources.

### CR15 — Preserve uncertainty across timeout, restart and adapter replacement — Critical

**Requirements:** B05/B10/B13/B16/B26/B32, H01–H02/H14.

**Observed:** [Deadlines](../packages/ai-foreman/src/util/deadline.ts) explicitly say expiry does not prove cancellation. [Supervisor](../packages/ai-foreman/src/supervisor.ts) fences workers before dispatch and withholds uncertain restart. [Supervised start tests](../packages/ai-foreman/test/supervisedStart.test.ts) cover unresolved dispatch and durable restart limits.

**Regression risk:** a native harness timeout/retry or stronger precompletion hook triggers a second execution while the first keeps running. Status text resets a deadline; each nested phase starts a fresh unlimited budget. CLI close is mistaken for stopped remote effects.

**Required safeguard/gate:** share enclosing phase budgets, correlate meaningful progress, classify proven not-sent separately from unknown, and reconcile before replay. Native recovery must not operate alongside a competing host replay loop. Test timeout/late completion/cancel races, healthy long tools, status-only loops, parent death and transport disconnect with zero blind duplicate dispatch.

### CR16 — Preserve durable budgets, final QA and override semantics — High

**Requirements:** B11–B12/B20–B21, F03/F09, H05.

**Observed:** [Workflow budget storage](../packages/ai-foreman/src/workflowDb.ts), [stall tests](../packages/ai-foreman/test/buildStallRepairs.test.ts), [handback safety tests](../packages/ai-foreman/test/qaHandbackSafety.test.ts) and [supervision tests](../packages/ai-foreman/test/supervisedStart.test.ts) preserve accounting across reopen, competing callers and changed wording/checkpoint labels.

**Regression risk:** new validation retries bypass existing correction caps; a final permitted fix cannot receive its QA recheck; new session/model/check labels reset limits; an override is mistaken for a waiver or permanent unlimited permission. New wording produces fake progress.

**Required safeguard/gate:** inventory and coordinate provider, wrapper, continuity, correction and supervision allowances. Reserve atomically before dispatch; preserve identity and counters across restart. Keep final recheck possible without granting another fix. Limits 0/1/N, competing reservations, unchanged cause, scoped single-use grant and final-fix-pass/final-fix-fail need coverage.

### CR17 — Evidence/schema changes must retain crash atomicity and occurrence identity — Critical

**Requirements:** E03, B19/B27–B28/B32, R01/R02/R06.

**Observed:** [Workflow evidence](../packages/ai-foreman/src/workflowDb.ts) is content-addressed with item byte limits; SQL admission/protocol fences reject incompatible writers. [Migration tests](../packages/ai-foreman/test/qaHandbackMigration.test.ts) preserve identical-content independent occurrences and abort ambiguous lineage transactionally. [Safety tests](../packages/ai-foreman/test/qaHandbackSafety.test.ts) cover WAL reopen after committed intent.

**Regression risk:** deduplicating by output digest collapses separate executions; new check tables lack authority triggers; references commit before artifacts; oversized browser/test payloads fail after dispatch; downgrade lets old writers corrupt new state.

**Required safeguard/gate:** keep occurrence, content, operation, turn and certificate identities distinct. Include new authoritative tables in fences and migrations; publish evidence before durable references, with transaction/reconciliation semantics. Define oversized-output handling without silently converting incomplete evidence into pass. Test crash boundaries, DB/disk faults, same bytes from separate checks, conflicting same-occurrence writes, old writers and interrupted upgrade.

### CR18 — Readiness cleanup must not acquire general mutation authority — Critical

**Requirements:** B14–B16/B31–B32, E05/E07, R03.

**Observed:** [Readiness recovery tests](../packages/ai-foreman/test/readinessRecovery.test.ts) cover terminal cleanup, restricted connections, PID reuse, unknown inventory, project identity, live legacy execution and migrated uncertain dispatch. [Lease tests](../packages/ai-foreman/test/qaHandbackLease.test.ts) reject stealing live or unverified writers after heartbeat expiry.

**Regression risk:** eager cleanup kills a reused PID or unrelated process, opens a second writer, or treats missing inventory as proof of death. Conversely, tying storage upgrade to unrelated provider uncertainty can make inspection/repair permanently unavailable.

**Required safeguard/gate:** preserve process incarnation, owning project/run/role, registered-child and Windows Job relationships; reconcile only within restricted cleanup authority. Cleanup completion does not imply build completion or permit replay. Test provably dead positive recovery, live/unknown refusal, creator paused before spawn, terminal history cleanup and successful later authorized start.

## D. Harness integration and efficiency

### CR19 — Smaller packets must preserve effective policy and review basis — Critical

**Requirements:** B23/B25/B30, F04/F08/F12, H03–H09/H12.

**Observed:** [QA runtime](../packages/ai-foreman/src/qaRuntime.ts) retains actual frozen settings, instructions and loaded skills. [QA review](../packages/ai-foreman/src/qaReview.ts) binds them into a review basis; [history/prerequisite tests](../packages/ai-foreman/test/qaPrerequisites.test.ts) protect bounded history through repeated cycles.

**Regression risk:** prompt slimming removes pending findings, policy or scope; progressive retrieval follows stale/mutable references; full policy is redundantly reinjected after every compaction. Adding another framework's rules can contradict Rafi ownership, QA or publication rules.

**Required safeguard/gate:** version compiled effective instructions and retrieval resources, define precedence, and preserve mandatory semantics across initial, resumed, compacted and transferred sessions. Do not edit canonical user rules to satisfy an experiment. Test conflicting instructions, stale retrieval, mandatory overflow and many cycles; measure actual rendered context and held-out quality.

### CR20 — Context/cost optimization must retain provider-specific semantics — High

**Requirements:** B01–B03/B26/B30, E12–E13, F04/F05/F11, H01–H02.

**Observed:** [Codex adapter](../packages/ai-foreman/src/adapters/codex.ts) uses correlated compaction events, fresh usage, bounded deadlines and uncertain compaction state. [Adapter types](../packages/ai-foreman/src/adapters/types.ts) distinguish turn-delta/session-cumulative usage and effective native thresholds. [Continuity tests](../packages/ai-foreman/test/unifiedContinuity.test.ts) cover clamped policies and live settings changes.

**Regression risk:** replacing the adapter with a simpler runtime reinstates lifetime-token occupancy, false compaction success or two compaction owners. Switching model/provider keeps an invalid old context ceiling or session identity. Unknown subscription cost becomes a misleading zero/API estimate.

**Required safeguard/gate:** conformance includes counter/reset/cache semantics, effective thresholds, correlated completion, exact resume availability and frozen-policy changes. Test model switch, missing/stale usage, slow/duplicate/late compaction and unavailable costs. Retain unsupported capabilities explicitly; no silent fallback that weakens recovery guarantees.

### CR21 — External harnesses must not compete over tools, recovery or publication — Critical

**Requirements:** B26/B31, H01–H14, F06/F12.

**Observed:** [Adapter contracts](../packages/ai-foreman/src/adapters/types.ts), [admission fences](../packages/ai-foreman/src/buildAdmission.ts) and [branch runner](../packages/ai-foreman/src/branch/runner.ts) already govern execution identity, host authority and delivery/finalization. Native runtime success is not Rafi acceptance.

**Regression risk:** a Ralph/GSD/SDK/hosted integration autonomously restarts, consumes questions, changes plans, commits, publishes, or broadens tool permissions while Rafi assumes control. Imported spec tasks may bypass approved slice validation. Removing all Claude user settings may break supported personal authentication; allowing all inherited project hooks may weaken QA isolation.

**Required safeguard/gate:** declare one owner per responsibility, capability limits and a stop/reconciliation protocol. Start with approved-packet native baselines or focused skill/tool imports. Preserve plan/ticket mappings, scoped permissions and explicit delivery authority; do not add commits/pushes as an implicit integration convenience. Test callbacks, hook/settings inheritance, unsupported event evidence, disconnect/retry and attempts at unauthorized external side effects. Recheck current provider auth terms before adoption.

### CR22 — Selective QA, caching and checkpoints must not accept unreviewed integration — Critical

**Requirements:** F03/F07/F09, B22/B27/B29, H13.

**Observed:** [QA protocol tests](../packages/ai-foreman/test/qaProtocolV2.test.ts) enforce scoped, single-use certificates. [Branch finalization tests](../packages/ai-foreman/test/branchFinalization.test.ts) protect source/base changes and crash recovery around merge publication.

**Regression risk:** risk routing skips a critical check, a passing subtask certifies a combined tree, changed test definitions reuse old results, or a green checkpoint rolls back user changes. Cosmetic status advances reset stall detection.

**Required safeguard/gate:** protected critical gates remain mandatory; cache by complete relevant basis and declared coverage. Recheck affected integrated behavior and bind final acceptance to the final tree. Checkpoints retain unresolved work and evidence, without granting rollback authority. Test individually passing conflicting branches, changed command/env/test, unresolved findings and lost completion checkpoints without replaying implementation.

## E. Evaluation, packaging and operational evidence

### CR23 — Better telemetry must not erase authoritative evidence or hide failures — High

**Requirements:** E08/E11–E15, B19/B24/B28, F01/F09–F10, R06/R07.

**Observed:** [Observability](../packages/ai-foreman/src/observability.ts) supports retention/pruning and summary accounting. [Observability tests](../packages/ai-foreman/test/observability.test.ts) preserve read-only behavior, interval unions, usage scopes, secret sanitization and permanent summaries. `WorkflowDb.putEvidence` treats string sanitization and supplied Buffer bytes differently; raw durable evidence and redacted diagnostic views need distinct handling.

**Regression risk:** pruning logs removes mandatory test proof; redaction changes bytes without rebinding digests; raw browser/test evidence leaks secrets; double-counted wrapper events make native integration look slower. Failures/timeouts are dropped from comparison, or evaluator provisioning/test retries are charged inconsistently.

**Required safeguard/gate:** separate authoritative protected evidence from optional telemetry and redacted exports; document retention/access and unavailable evidence behavior. Keep raw/redacted provenance without rewriting immutable historical records. Include failed, blocked, timed-out and rerun attempts; distinguish agent, setup, evaluator and human time. Test pruning/export/reopen with finalization still valid, secret-bearing output, overlap and counter resets. Critical defects veto promotion regardless of a higher aggregate score.

### CR24 — Package, migration and platform checks must follow the actual shipped path — High

**Requirements:** E01/E04–E05/E17–E18, B31–B32, R01–R05.

**Observed:** [CLI package](../packages/rafi/package.json) depends on versioned runtime/spec/library packages and publishes built output. [Packaged resume tests](../packages/rafi/test/resumePackaged.test.mjs), [admission tests](../packages/ai-foreman/test/buildAdmission.test.ts) and [supervised tests](../packages/ai-foreman/test/supervisedStart.test.ts) exercise paths helper-only tests miss. [State transfer tests](../packages/ai-foreman/test/stateTransfer.test.ts) protect SQLite backups, path rewriting, lineage and import rollback.

**Regression risk:** source tests use new sibling code while the published CLI resolves an older runtime/spec; stale `dist` makes packaged results misleading. New evidence tables are absent from transfer/inspection/migration. Tests pass through one alias or POSIX mock while Windows registration, quoting, process control or PTY handling breaks.

**Required safeguard/gate:** validate coherent package/protocol versions and built artifacts, generated docs, ordinary/preparation/recovery/supervised/detached modes, both aliases and explicit command scope. Include new authoritative artifacts in state transfer and privacy controls. Run native claimed-platform checks; platform mocks remain preparatory evidence. Rehearse upgrade/reopen/import and supported rollback, preserving uncertain remote outcomes and rejecting incompatible old writers.

## Implementation planning obligations

Every implementation ticket must cite the relevant CR risks, existing tests to retain, actual production callers, new negative and positive controls, and schema/compatibility consequences. A risk with no existing assertion requires a regression fixture; an existing assertion does not justify rewriting verified behavior. CR02/CR03 need new validation-specific coverage; CR01 needs explicit completion-contract design.

Prioritize as follows:

1. Inventory and establish baseline evidence. Preserve existing tests, including later recovery repairs, before changing orchestration.
2. Design execution-evidence capture and its integration with current QA/certificates. Specify practical TDD exceptions and scoped waiver compatibility before enforcing new gates.
3. Add fault, evidence-integrity and positive-continuation fixtures for the affected production paths. Fix reproduced safety gaps before live experiments.
4. Implement missing baseline behavior in bounded changes. Keep existing scope, admission, uncertainty, budget and finalization protections continuously enabled.
5. Trial smaller packets/native adapters first. Treat milestones, selective QA and parallel writers as separate experiments with explicit contract decisions.
6. Promote only after deterministic, packaged, migration and claimed-platform gates pass. Record quality, attention, latency and failure/recovery results rather than relying on historical logs or helper-level success.

The four proposed implementation parts remain viable. The evidence/certificate integration, parallel ownership model, milestone semantics and external-runtime responsibility boundaries are the main cross-part design dependencies. They should be settled in the plan before several parts independently implement overlapping mechanisms.
