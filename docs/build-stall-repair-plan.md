# Build stall repair plan

Rafi must either advance authorized work or explain exactly what prevents it from doing so. This plan addresses every finding in the [build stall investigation](build-stall-investigation.md): incorrect context pressure, excessive and falsely failed compactions, accepted successors that receive no work, stale recovery pointers, hidden decisions, repeated blockers, lost execution failures, incomplete watchdogs, inactive supervision, and misleading status. It also incorporates the complementary QA correctness and performance work.

Status: implementation and regression validation are recorded below. Live canaries and an affected-project migration rehearsal are complete; production rollout is not performed. Existing unrelated working-tree changes were preserved. Source references name files and symbols because line numbers are moving.

## Confirmed product decisions

The user selected both of these behaviors while preparing this plan:

1. **Start automatically when approved scope is unchanged.** `rafi start . --steps 10` should reuse valid approval of the selected plan and tickets. Ask about material changes. A new implementation outline within that approved scope does not itself require another approval.
2. **Continue independent tickets when one is blocked.** Persist and display the blocker immediately. Defer its dependent work, continue eligible independent work, and pause when no eligible work remains. A project-wide permission, integrity, or ownership problem still stops all affected work.

Reuse `continue_independent_tickets` and the frozen autonomy policy instead of introducing a competing switch. Preserve explicitly configured overrides and frozen policies for existing runs; show their effective behavior. These selections establish the intended default for new runs, not permission to silently rewrite historical policy or answer unrelated questions.

Technical defaults below are implementation recommendations. Deadline values require validation against representative workloads before release; the recorded 39–53 second compactions establish that 30 seconds is inadequate, not a universal service-level guarantee.

## Invariants and ownership

- Context occupancy, cumulative session consumption, and per-host-turn consumption remain distinct. Unknown measurements remain unknown.
- One authoritative owner can dispatch mutation work for a role/workspace at a time. A successor is validated before acceptance changes ownership, and accepted work is durably tracked through dispatch.
- Persistence never implies an external operation completed unless its evidence establishes completion. Uncertain dispatch is reconciled before any replay.
- Questions, blockers, execution failures, and formatting errors are distinct outcomes. A syntactically valid response cannot erase a failed implementation or unanswered question.
- Automatic retry budgets survive restart, handoff, wrapper layers, and alternate entry points. Human waiting is visible and does not spend provider-retry budget.
- Independent QA and current source-bound approval remain mandatory where configured. A blocked prerequisite, valid dispute, or formatted remediation report is not a QA pass.
- Recovery preserves worktrees, commits, evidence, and completed side effects. Starting over retires obsolete session ownership according to the selected start-over operation; this plan adds no additional source deletion.

The workflow database owns session transitions, pending decisions, dispatch intent, and budgets. Delivery JSON, build-run files, status views, and logs are projections with an authoritative revision. Database updates can be atomic; database and filesystem publication require durable reconciliation, not a claim of cross-resource atomicity.

The [QA handback implementation plan](qa-handback-implementation-plan.md) remains the detailed specification for QA report identity, delivery journals, outcome contracts, correction enforcement, and QA migration. Its P1–P11 are incorporated here. This plan supplies the broader session, start, and supervisor integration; W2 and W8 below refine its P12/P13 using the additional build-stall evidence. The [activity output plan](../ACTIVITY_OUTPUT_RESOLUTION_PLAN.md) owns rendering mechanics; W5 and W10 supply durable waiting and truthful state. Implement each shared mechanism once.

## Complete problem coverage

| Problem | Required solution | Work package |
| --- | --- | --- |
| Lifetime Codex tokens masquerade as current context | Separate live occupancy, cumulative usage, and turn deltas; correct unrealistic fixtures | W1 |
| Every ordinary compact boundary compacts | Use occupancy and explicit policy; keep intentional fresh-session boundaries | W1 |
| Successful slow compactions trigger replacement | Correlated bounded lifecycle, fresh usage, late-result reconciliation | W2 |
| New-run successor generation regresses | Allocate above both run high-water mark and validated predecessor | W3 |
| Validation occurs after acceptance and predecessor closure | Validate first; commit ownership; adopt; journal next dispatch | W3 |
| QA transfers and start-over leave stale session pointers | One authoritative transition, revisioned projections, owner-aware selection and retirement | W4 |
| Already approved work asks for another plan approval | Reuse scoped approval; require a decision for material changes | W5 |
| Human decisions disappear behind activity and running state | Persist before prompting; visible waiting state, attention, resumable answers | W5 |
| One blocked ticket prevents other eligible work | Scoped deferral, dependency-aware scheduling, shared-worktree checks | W5–W6 |
| Interactive blocker recovery can loop forever | Durable shared budgets and unchanged-blocker stop conditions | W6 |
| A correction hides a provider failure | Validate execution first; preserve all turns and failure metadata | W6–W7 |
| Continuity repair drops an original handoff request | Common validated completion path; process transfer once | W6 |
| QA repeats an unchanged environment blocker | Structured blocked outcomes, prerequisite checks, relevant-change recovery | W7 |
| QA identities, receipts, correction and restart accounting are unreliable | Scoped report occurrence, per-turn journal, atomic outcome/budget commits | W7 |
| QA prompts and repeated instructions grow excessively | Bounded nonrecursive history; exact correction guidance; measured instruction overhead | W7–W10 |
| Startup, settings, context and shutdown can hang outside turn timeout | End-to-end phase deadlines, cancellation, cleanup, honest uncertainty | W8 |
| Readiness or writer ownership appears stuck | Trace completion/exit and lease identity; bounded, verified recovery | W8 |
| Supervisor settings promise protection that start does not use | Wire the production entry points after recovery invariants hold | W9 |
| Logs and manager cannot distinguish waiting, acceptance, dispatch and progress | Shared state projection, separate milestones and non-overlapping timing | W10 |

## Implementation sequence

Use the work packages as reviewable changes with their own tests. W0 establishes the current baseline. W1 can land first. Build the W3/W4 ownership changes as one compatible sequence, and complete W2 with that safe fallback path. W5 visibility and approval work can proceed independently after W0. W6 and W7 share the outcome/budget contracts and must not introduce separate counters. W8 supplies bounded phase execution. Enable W9 only after W3–W8 pass their integration gates. W10 instrumentation begins with the first change; benchmarking and optimization finish last.

Do not hold the metric fix or visible-wait correction until every performance optimization is complete. Conversely, do not enable new automatic recovery before ownership, dispatch reconciliation, decision scope, and retry limits work end to end.

### W0 Establish the current baseline

**Surfaces:** both investigation reports, their audit scripts and characterization tests, `git status`, affected package scripts and existing diffs.

1. Inventory existing changes before implementation. The checkout now includes QA journal/migration/history/prerequisite work and adapter tracing/deadline edits beyond the original investigation snapshot. Presence of a new file is not proof its production integration or tests are complete.
2. Re-run the eight build-stall characterizations and the QA plan's 26 scenarios. Classify each as still reproduced, already repaired with a desired-behavior test, or changed behavior needing investigation. Preserve the original evidence fixtures.
3. Use the supported Node runtime and installed tooling. Node 20.19.0 matched the native SQLite dependency during the investigation; record the actual runtime and baseline results. Do not change dependencies or the lockfile merely to get a baseline.
4. Use temporary repositories, scripted providers, controllable clocks, and isolated databases. Obtain consistent SQLite backups with evidence objects for historical migration fixtures; account for WAL. Do not run tests against the user's active build state.
5. Record package/provider versions, frozen configuration, and sample size with measurements. The exact reported five-hour/three-hour incident remains uncorrelated; the fixes have independent evidence and must not depend on finding that incident.

**Acceptance:** each coverage row has an implementation owner, a reproducible current behavior or explicit trace requirement, and a desired assertion. Pre-existing failures and ongoing edits remain distinguishable from the implementation changes.

### W1 Correct context accounting and boundary policy

**Surfaces:** [Codex adapter](../packages/ai-foreman/src/adapters/codex.ts), adapter types, [session lifecycle](../packages/ai-foreman/src/sessionLifecycle.ts), context samples/accounting, `codex.test.ts`, `unifiedContinuity.test.ts`.

1. Populate current occupancy from the provider's current/latest context sample (`last.totalTokens` in the recorded Codex payloads), paired with its model context window, session, revision and timestamp. Preserve `total` as cumulative consumption. Never substitute lifetime totals when current occupancy is missing.
2. Compute host-turn usage from correlated cumulative deltas across the whole host turn, including multiple provider requests. On attach/reset, establish a baseline or mark the delta unknown; do not charge historical session usage or substitute only the final request. Handle missing fields, cached tokens, duplicate events, counter resets, model/window changes, and session replacement explicitly.
3. Reject stale or foreign-session measurements. A fresh compaction sample must belong to the operation's session and be newer than its pre-operation revision. Persist unknown capability as a recoverable condition rather than inventing zero occupancy.
4. Make ordinary `session_strategy=compact` boundaries consult the same threshold policy as safe boundaries. A known below-threshold sample continues without a compaction RPC. Preserve explicit manual compaction and intentional `fresh` boundaries, especially QA snapshots with a different location. Document the change to compact-strategy semantics.
5. Keep native compaction counts, `compact_maximum`, hysteresis, settings revisions, bootstrap checks, and historical-uncertainty protection. Deduplicate an operation observed through both manual and native events. Do not create a compaction/handoff loop when required bootstrap instructions exceed capacity; report the actual capacity problem.

**Tests and acceptance:** the recorded 3,555,538 cumulative / 111,524 latest / 258,400 window reports about 43.16%, then about 9.15% after compaction to 23,635 while cumulative usage stays unchanged. A 10% sample with a 65% threshold sends zero ordinary compactions. Threshold crossing sends one, duplicate native completion counts once, and multiple requests produce the correct turn delta. Correct the existing total=72/last=12 test and cumulative-decreases-after-compaction fixture. An absent current sample must not pass as known low occupancy.

### W2 Make compaction completion reliable

**Surfaces:** both adapters, `ThresholdCompactionController.compactSession`, compaction persistence/events; coordinate with QA P12 and W8's deadline utility.

1. Represent request intent, acknowledgement, completion, fresh usage, cancellation, and terminal outcome separately. Register event observation before dispatch. Correlate by provider/session and operation/turn/item IDs where available; where the provider lacks an operation ID, serialize compaction and enforce explicit sequence ownership rather than inventing correlation.
2. Start the operation deadline before initialization or RPC submission. Proposed policy: 120 seconds for normal completion, with an extension up to a 180-second total only for correlated ongoing progress. These are starting defaults, not claims about provider guarantees. Repeated generic status messages must not extend the hard limit. Expose one validated project policy and freeze it for the run.
3. Require explicit successful completion and authoritative fresh usage. Handle acknowledgement/completion/usage in either order. Completion with missing usage means context measurement is unresolved, not that compaction certainly failed. Attempt one bounded authoritative refresh if supported; otherwise pause or use the validated recovery path.
4. At timeout, reconcile already-arrived completion and query supported operation state before choosing fallback. Distinguish known failure, cancellation, lost measurement, and unknown in-flight state. A timed-out wait does not cancel the provider operation by itself.
5. Quarantine unresolved predecessor state: send no new implementation there. Drain/cancel the owned operation and bound shutdown before successor mutation is allowed. Retain dispatch uncertainty for any interrupted implementation; a fresh session does not erase it. Fence late events so they cannot update successor occupancy, ownership or counts. Persist a late completion against its original attempt.
6. W3's validated handoff is the fallback only when authority and the prior action are reconciled. Use a bounded recovery allowance, not recursive replacement. Report actual elapsed seconds and deadline type, not a rounded claim of provider silence.

**Tests and acceptance:** replay all five observed attempt durations, including 39, 48, 50 and 53 seconds; none should falsely time out under the proposed default. Test 90-second success, hard-deadline expiry, lost acknowledgement, missing usage, wrong session, duplicate/native events, cancellation, and late completion both before and after fallback. Fake clocks keep tests fast. A replacement never runs concurrently with unresolved predecessor mutation, and a slow successful compaction does not launch a handoff.

### W3 Make accepted handoffs adoptable and dispatchable

**Surfaces:** [handoffs.ts](../packages/ai-foreman/src/handoffs.ts), `WorkflowDb.stageHandoff`/`acceptHandoff`, `RoleSessionController.acceptManagedTransition`, continuity adoption, all Builder/QA/settings/recovery callbacks in `cli/start.ts`, `buildResume.ts`.

1. Define generation consistently: `(runId, generation)` identifies a durable handoff, and every successor generation must exceed its validated predecessor. Allocate `max(currentRunHighWater, validatedPredecessor.generation) + 1` under a transaction/reservation. Gaps are valid. Keep manifest, receipt, successor reference and lease generation aligned. Do not conflate this with QA remediation generation or supervisor worker generation.
2. Validate the predecessor's current authority and scope before using its generation. An imported predecessor needs an explicit recovery/ownership transition; an old JSON pointer alone cannot import it. Audit every generation consumer for assumptions that a new run starts at one or generations are contiguous. Retain historical immutable generations and manifests.
3. Extract a shared, side-effect-free transition validator. Check role, provider identity, stream, canonical worktree/config scope, settings, generation, acceptance evidence, and expected current owner before committing. Legitimate location changes use the explicitly prepared destination. Keep the existing strict checks; move them earlier.
4. Prepare the successor with its reserved target generation before obtaining acceptance, so the prepared reference, observed turn and final receipt agree. Obtain acceptance without granting implementation authority. Revalidate the durable revision/owner, then commit acceptance receipt, role ownership, authoritative session binding and recovery-projection intent in one database transaction. A failed pre-commit validation leaves the predecessor owner unchanged and the unused successor closed. No database transaction stays open across a provider/network await; persist immutable evidence before committing references to it.
5. Adopt the committed successor in memory; emit `adopted` separately; retire/close the predecessor with bounded cleanup. Journal the frozen next action before dispatch. Record `dispatch_intended`, provider dispatch observation, and completion separately. Do not advertise implementation progress merely because acceptance succeeded.
6. On restart, reconcile an accepted-but-not-adopted successor from durable evidence. If no implementation dispatch was intended, dispatch the frozen remaining action once. If dispatch is uncertain, reconcile or pause instead of repeating completed side effects. An adoption failure after commit is recoverable pending adoption, not a reason to restore predecessor ownership blindly.

**Tests and acceptance:** a validated generation-2 predecessor imported into a new run receives generation 3 or greater, and the successor receives the implementation instruction after acceptance. Reject an invalid successor before closing the predecessor. Inject faults before acceptance, before/after commit, during adoption/close, before dispatch and after send; restart yields one owner and either one known dispatch or explicit uncertainty. Include concurrent staging, settings changes, both roles/providers, and the actual start/branch callbacks.

### W4 Make resume pointers authoritative and retire stale ownership

**Surfaces:** [branch runner](../packages/ai-foreman/src/branch/runner.ts), [resume selection](../packages/ai-foreman/src/branch/resume.ts), `WorkflowDb`, `WorkflowReader`, shared-delivery loading in `cli/start.ts`, [buildStartOver.ts](../packages/rafi/src/buildStartOver.ts), build-run projections.

1. Introduce one session-transition persistence path used by normal Builder work, QA remediation, continuity transfer, settings/provider change, exact resume and fresh recovery. It updates the accepted session binding and structured branch index together; remove competing pointer writers.
2. Version delivery-session JSON with owning run, scoped reference, accepted-transition identity, revision and status. Publish it and build-run files from a durable projection queue/marker, using atomic file replacement. Readers check authoritative state; stale/missing files are repairable caches, not fallback permission to resume.
3. Filter by run ownership/status, ticket/delivery identity, canonical location, accepted session/lease and revision. A worktree's existence is insufficient. Exact-session resume must resolve the current accepted reference or explain why it is unavailable. Continuing preserved source work from another run uses an explicit validated import or fresh checkpoint handoff.
4. Include session retirement in the durable start-over workflow. Superseding a run makes its provider pointers ineligible immediately, even if file cleanup is interrupted. Preserve the selected Git/archive operation and its idempotency; do not reset or delete additional work.
5. Make legacy JSONL fallback obey the same retirement and owner filters. Distinguish “no structured legacy data exists” from “structured authority explicitly rejects this candidate.” Never resurrect a rejected session from older logs. Unscoped ambiguous legacy sessions require scoped recovery, not silent adoption.
6. Migrate/reconcile old pointers from accepted handoff evidence and the current owner. MoneyFarm-like generation-2 pointers with a generation-6 accepted successor become a reconciliation case, not a blind numeric-largest selection. Conflicting or incomplete evidence produces an actionable pause. Do not rewrite historic evidence to look consistent.

**Tests and acceptance:** QA transfer followed immediately by process death resumes the accepted successor; start-over followed by shared-delivery startup never reuses the superseded session. Test stale JSON, cache write failure, absent cache, terminal owners, explicit cross-run continuation, old JSONL-only records, path aliases and competing readers/writers. Every recovery view agrees with the authoritative accepted binding or explicitly reports a stale projection.

### W5 Make approvals and decisions visible and scoped

**Surfaces:** both plan gates and `withObservedUserWait` in [cli/start.ts](../packages/ai-foreman/src/cli/start.ts), [planning approval receipts](../packages/rafi/src/plan.ts), plan/ticket binding, `providerQuestions.ts`, recovery CLI, activity/status/manager projections, branch scheduling.

1. Resolve build authorization from the stored approved plan identity/revision/digest, selected ticket bindings and approved workflow consequences. Validate the current plan pair and ticket mapping. A new preflight outline must stay within that scope; text saying “approved” is not evidence.
2. Skip both the ordinary and branch implementation-plan gate when the approval still covers the work. Persist a reused-approval receipt explaining the binding. Treat changes to requirements, acceptance criteria, dependency semantics, selected unapproved work or delivery consequences as material and require the appropriate decision. Compare structured plan/ticket changes with host-owned rules; an agent's claim that a change is minor cannot authorize it. Internal implementation choices within approved scope proceed. Handle stale, missing, ambiguous and legacy approval explicitly, and test that unchanged narrative outlines do not accidentally restore the redundant gate.
3. Consolidate precedence across new start, resume, `--yes`, supervised/balanced/unattended policy, and `planUpdateApproval`. `--yes` may preserve its documented initial-plan behavior but must not answer material-scope changes, permission questions, or QA waivers silently. The current unattended plan-change policy also needs this material-change guard. Freeze and display the effective approval policy.
4. Use one durable decision service for plan approval/feedback, provider questions, blocker choices, runtime/handoff recovery and QA guidance. Persist the scoped decision, evidence and run/ticket checkpoint before waiting. Extend the existing decision contract for scope and custom text where needed; version it. Stable decision keys prevent restart duplicates, and answers are consumed idempotently against the matching revision.
5. Give the prompt exclusive terminal input/rendering ownership. Pause competing activity rendering, show the full question and waiting duration, signal attention once according to notification settings, and restore rendering in `finally`. Non-TTY/CI execution writes a durable decision plus an exact recovery command and returns a documented needs-input exit outcome instead of waiting for unavailable input. Cancellation preserves an explainable paused/cancelled state.
6. While independent tickets are eligible, defer a ticket-scoped decision instead of blocking on an interactive prompt. Show it and provide the existing decision-answer command; reconsider answered decisions at safe scheduling boundaries. Exclude dependents and unsafe shared-worktree/delivery-unit siblings. A project-wide decision gates all affected work. When no eligible work remains, enter `waiting_for_human` and either present the interactive prompt or exit recoverably in noninteractive mode.
7. Decision waits have no silent approval deadline. Display them immediately and durably; do not let wait time look like active model work. A configured reminder may notify again, but never selects an answer. Document that `--steps` limits completed work and is not a wall-clock or model-turn budget.

**Tests and acceptance:** an unchanged approved plan starts implementation with plain `rafi start . --steps 10`; materially changed scope dispatches no affected implementation before a decision. Test both plan gates, external/legacy tickets, all autonomy profiles, `--yes`, resume, answer replay, custom text, interruption and redirected input/output. A PTY test emits activity during a prompt without hiding it. With tickets A blocked, B dependent on A and C independent, C runs, B does not, and the pending A decision remains visible. Include shared delivery units and a global blocker.

### W6 Bound recovery and preserve execution truth

**Surfaces:** [Foreman send/status loops](../packages/ai-foreman/src/foreman.ts), [continuity wrapper](../packages/ai-foreman/src/continuity.ts), recovering adapter, `RecoveryDispatcher`, frozen policy/spec, branch runner. Share QA P2–P7's ledger and turn semantics.

1. Validate execution failure flags, scoped identity, correlated terminal outcome and dispatch certainty before interpreting success text or requesting format repair. Apply this to the initial turn, every correction, post-answer turn and blocker-approach turn. Preserve original and repaired responses; never replace an errored implementation result with a successful-looking `done`.
2. Consolidate original-valid and repaired-continuity handling into one completion path. Publish a checkpoint only from healthy, bound evidence. After a valid repair, process the original handoff request exactly once. Do not manufacture a handoff from repair text or automatically redispatch the entire action when its prior side effects are uncertain. Respect the handback-specific policy that forbids opaque transfer/replay.
3. Give each logical action durable child turns: implementation, protocol/continuity repair, blocker explanation, acceptance and reconciliation. Use one correction allowance across wrappers; the QA handback retains its stricter one-response-only-repair cap. Ordinary limits come from the frozen policy. Reservations and outcomes use the same ledger in every caller.
4. Stop immediately on a structured unchanged environment/permission blocker. If a terse generic blocker lacks an actionable explanation, allow at most one bounded explanation turn per unchanged blocker/action; another `blocked` response then defers the ticket. Renaming a cause, transferring sessions, restarting, or rephrasing the response does not reset the budget.
5. Track progress using relevant source, test/evidence, environment capability, completed action and authorized decision revisions. A valid no-code dispute can be progress; arbitrary file churn or heartbeat text is insufficient. Require relevant change or an explicit scoped retry authorization before reopening an unchanged blocker. Do not let repeated clarifying questions or formatting success reset the action budget.
6. Charge dispatched failed/blocked attempts; retain reservations for uncertain sends until reconciliation. Proven pre-dispatch failures follow the existing bounded transient policy. Human answers authorize their scoped continuation, not unlimited retries or automatic waivers. Budget exhaustion persists a clear recovery requirement and feeds W5's scheduler.

**Tests and acceptance:** the eight-consecutive-blocked fixture stops within the configured allowance rather than producing nine calls. Initial provider error plus a clean `done` correction completes zero steps, including QA-off mode. A repaired continuity delta still processes the original valid handoff once. Include correction failure, session change, tools during response-only repair, restart/handoff/alternate-caller budget reuse, changed blocker wording, valid questions and legitimate evidence-only progress.

### W7 Complete QA correctness and eliminate repeated QA work

**Surfaces:** `qaFailureDelivery.ts`, `qaReview.ts`, `qaProtocolV2.ts`, workflow DB/spec, both Foreman and branch callers; use the [QA implementation plan](qa-handback-implementation-plan.md) and reconcile its in-progress implementation.

All QA work packages P1–P11 remain required. In particular:

| QA problem | Required implementation and acceptance |
| --- | --- |
| Identical reports collide across reviews | Separate content digest from scoped report occurrence; migrate all findings/dispositions/chains/receipts. Identical content on distinct reviews remains independent. |
| Original and correction evidence is mixed or lost | Journal each actual dispatch before sending; preserve both responses, correct digest/byte/session/turn pairs, capture failures and uncertainty. Commit related local outcomes consistently; recover partial writes without redispatch. |
| Failure or wrong identity passes validation | Shared execution/identity/completion checks on every turn, including real Foreman/branch integration and replacement adapters. |
| “No tools” correction is only a prompt instruction | Correlated event observation and terminal/drain barrier, provider no-tools capability where supported, source checks and one shared repair allowance. Missing proof does not imply tool-free execution. |
| Restart bypasses remediation limits | One authoritative durable operation budget with reservation before dispatch; reconcile legacy keys without double counting or granting extra attempts. |
| Blocked work is mislabeled fixed/disputed | Versioned blocked/needs-input/uncertain outcomes, partial progress and required recovery. Preserve legitimate disputes and independent QA. |
| Same environment blocker triggers full reviews | Stop after the first structured blocker; resume on relevant environment/source/evidence/decision changes. No source change alone does not disqualify a legitimate dispute. |
| Required tooling/network is unavailable | Bounded non-mutating checks derived from actual ticket verification requirements; distinguish test-not-run from test-failed. Keep missing required source artifacts as findings. |
| Every Builder response needs weakly informed repair | Exact initial response contract and actual parser errors in the one permitted correction; preserve the substantive outcome and finding coverage. |
| Recursive history enlarges every prompt | Typed bounded history with complete current findings once, retrievable protected evidence, and explicit capacity failure if mandatory content cannot fit. |
| Performance cannot be attributed | Correlated phase timing and counts for initial work, formatting, continuity, acceptance, full QA and recovery. |

Forward the explicit handback/response-only policy through every adapter wrapper, including recovery wrappers; preserve the turn journal when a session is replaced. Fresh QA snapshots retain their location identity and read-only confinement. Do not reuse a session across incompatible snapshots to save setup time. Do not install dependencies, create lockfiles or provision services from read-only QA preflight; use the existing authorized implementation/recovery route.

**Acceptance:** all 26 QA diagnostic scenarios have their desired assertions plus actual-caller integration. The MoneyFarm-like unchanged registry blocker defers after its first structured outcome. A real environment fix or evidence-backed dispute permits an appropriate recheck; fixed claims still require independent QA. History does not recursively grow for a fixed issue set, and restart grants no extra remediation budget.

### W8 Cover every hanging phase and diagnose readiness

**Surfaces:** Codex `request`/`ensureThread`, Claude initialization/settings/context/interrupt/close, adapter wrappers and pumps, readiness/session availability, process ownership and cancellation; coordinate with QA P13.

1. Add a shared operation deadline/cancellation context at adapter entry, before any await. Propagate remaining time through nested startup, RPC acknowledgement, provider execution, event drain and shutdown; an inner retry cannot restart the outer clock. Clear pending requests, timers, listeners and event subscriptions on every terminal path.
2. Keep different meanings for transport inactivity, operation deadline and useful-progress age. Only correlated events update a phase's activity. Status/retry spam cannot evade a hard operation deadline. Expose overrides and the effective frozen values; do not scatter unrelated timeout constants.

Proposed initial policy for validation:

| Phase | Proposed bound and behavior |
| --- | --- |
| Readiness, initialize and thread start/resume | 120-second overall preparation deadline, including retries; classify whether implementation was sent |
| Standalone context/settings RPC | 60 seconds, also constrained by any enclosing operation deadline |
| Manual compaction | W2: 120-second normal deadline, at most 180 seconds total with correlated progress |
| Owned provider shutdown | 10 seconds graceful plus 5 seconds for owned-process termination/cleanup; record incomplete cleanup |
| Ordinary work turn | Preserve the existing 30-minute transport-idle ceiling; propose a configurable 60-minute active-turn hard bound and a visible 5-minute no-useful-progress warning |
| Intentional human decision | No inferred answer or model timeout; W5 persists and exposes the wait |

The ordinary-turn hard bound is a recoverable checkpoint/pause policy, not proof that long work failed. Known long-running verification can use an explicit declared operation deadline. Do not interrupt a healthy declared tool merely because no source file changed; also do not treat endless output as unlimited extension. Exclude intentional human-wait time from active deadlines while continuing lease/ownership monitoring. Tune the proposed defaults from measured workloads and retain explicit long-job configuration.

3. Preserve dispatch state across timeout and cancellation. “Not sent” permits policy-controlled retry; a sent request with lost acknowledgement is uncertain. Cover fresh as well as resumed adapters. Forward cancellation to owned processes; do not kill unrelated sessions or treat transport closure as proof remote effects stopped.
4. Trace readiness spawn, first output, terminal provider result, process exit, stdio closure and owned-child shutdown. Resolve why a probe can print `OK` yet hang before optimizing it. Only cache a proven reusable readiness result scoped to executable/version, model, non-secret auth/config revision, environment and confinement; expire and invalidate it after relevant failure.
5. Validate writer ownership using PID plus process-start identity/lease generation and authoritative revision. A live writer is exclusive; a stale heartbeat alone does not authorize theft. Reclaim only after verified stale ownership with compare-and-set protection. Bound waiting and expose a precise recovery action for ambiguous owners. Test supported platform-specific liveness behavior; do not assume a Linux process probe works on macOS.

**Tests and acceptance:** a process accepting writes but never replying times out during initialization. Test each hanging RPC, alive-but-silent process, status spam, long healthy tool, cancellation, failed shutdown, child cleanup and missing dispatch acknowledgement. Test `OK` plus clean exit versus hung shutdown, changed readiness identity, active competing writer, dead owner, PID reuse and raced reclamation. Every await is covered by a deadline, an intentional durable wait, or a documented enclosing bound.

### W9 Wire supervision into real builds

**Surfaces:** [DurableSupervisor](../packages/ai-foreman/src/supervisor.ts), `cli/start.ts`, `buildRuns.ts`, resume/start-over entry points, workflow leases and frozen recovery policy.

1. Refactor worker execution behind one entry point used by both ordinary and branch builds. The parent owns the supervisor lease; exactly one worker owns project mutation authority. Route interactive decisions to the one terminal owner. `supervisorEnabled=false` retains direct execution with truthful disabled status.
2. Enforce supervisor lease acquisition/renewal with durable compare-and-set and verified process identity, not just a status-row read followed by a write. Separate supervisor and worker lease lifetimes; fence stale workers at every host dispatch/mutation boundary. Before replacement mutation, establish that the prior worker and its owned provider/tool children are quiescent and reconcile any in-flight remote action. Host fencing alone cannot stop a tool that was already executing; unresolved ownership pauses that scope.
3. Observe structured worker phase, last meaningful progress, operation deadline, pending dispatch uncertainty, and scoped decisions. A heartbeat proves liveness, not useful progress. Consume W8 timeout outcomes; an external supervisor must also detect a dead/hung worker when its own event loop cannot run the timeout.
4. Restart only a reconciled recoverable checkpoint within the existing frozen per-checkpoint and per-run limits/backoff. Do not reset counts because a superficial checkpoint label or log message changed. Do not retry deterministic identity failures, pending human input, exhausted budgets or uncertain side effects blindly. Cancellation remains cancellation.
5. Replace the current “any pending decision stops the worker” rule with W5's scope-aware eligibility: a ticket-scoped decision permits other independent work. Report waiting only when all eligible work is gated. Restart preserves deferred tickets and consumes no answered decision twice.
6. Resume/start-over use the same lease and worker-generation rules so concurrent CLI invocations cannot double-spawn or resurrect a retired worker. Signal handling requests a safe checkpoint, bounds cleanup, and persists the actual final state.

**Tests and acceptance:** invoke the actual CLI in child processes with scripted providers, not only the supervisor class. Kill a worker before/after a durable dispatch, hang its event loop, kill the parent, race two starts, cancel, and exhaust restart budgets. Verify lease rows and worker generations advance correctly, one worker can mutate, uncertain work is not replayed, and independent work continues around a pending ticket decision. Until this gate passes, status must not describe unstarted supervision as active protection.

### W10 Make progress understandable and verify speed improvements

**Surfaces:** observability/log/activity/status, `WorkflowReader`, `managerPacket.ts`, diagnostics, both audit scripts, CLI documentation and release notes.

1. Project one authoritative state model into terminal, durable run record, status and manager packet: preparing, implementing, verifying, compacting, transferring, waiting for a decision, blocked on a prerequisite, reconciling uncertain work, completed or failed. Include current phase age, last useful progress, affected tickets, pending decision and next action.
2. Record accepted, adopted, dispatch intended, dispatched and completed successor milestones separately. If an accepted successor has no dispatch, show why and the recovery state. Include the actual worktree/branch so completed code outside the main checkout is visible.
3. Mark returned failures such as `{ok:false}` as failed outcomes even if the promise resolved. Preserve known failure versus unknown completion. Keep host/provider prompt byte counts and digests attached to the exact respective turn.
4. Distinguish elapsed run time, active provider work, setup/compaction/transfer, known human wait, retry/recovery and unknown gaps. Avoid summing nested or overlapping spans. Across sleep/process interruption, wall time remains elapsed; do not infer active compute.
5. Record transport activity, meaningful progress and durable state revision separately. Extend read-only audits for both old/new schemas, unknown legacy fields and stale projections. Keep raw prompts/secrets out of default logs; use protected evidence references.
6. Measure repeated system/skill instruction overhead separately from QA history. Move stable instructions to a provider-supported persistent mechanism only after capability and equivalence tests establish they survive resume/compaction and update on configuration changes. Otherwise retain correct repetition and optimize the host history. Never remove required instructions merely to reduce bytes.
7. Compare fixed fixtures before/after with the same provider/model versions, confinement, requirements, environment and strategy. Measure time to first implementation, handoffs/compactions per completed ticket, setup time, correction turns, repeated blockers, prompt size and QA outcomes. Report sample counts and active versus elapsed timing. Use at least five runs per representative live scenario for an initial canary; treat that as a small sample, not a reliable tail-latency estimate.

**Acceptance:** the manager can explain a stall from normal structured records without reading raw transcripts. Recorded compaction examples cause zero false-failure handoffs; low occupancy causes zero automatic compactions; a successful accepted handoff reaches implementation or an explicit durable pause; no unchanged blocker is automatically re-reviewed. Optional cache/prompt optimization ships only with preserved identity, instructions and QA correctness. Numeric latency targets follow a representative baseline rather than an invented percentage speedup.

## Regression and crash verification

Convert the existing [eight characterization tests](../packages/ai-foreman/test/buildStallInvestigation.test.ts) instead of retaining passing assertions that demonstrate defects:

| Current characterization | Desired assertion | Owner |
| --- | --- | --- |
| Accepted new-run handoff rejects predecessor generation two | Generation advances; validation precedes ownership change; next implementation dispatch occurs | W3 |
| Superseded run remains selectable | Superseded pointer is rejected through DB, JSON and legacy fallback | W4 |
| Ordinary boundary compacts at ten percent | Zero compact calls below threshold absent explicit manual policy | W1 |
| Repeated blocked replies exceed budget | Bounded calls, durable deferral, budget preserved after restart | W6 |
| Status correction overwrites provider error | Zero completed steps; original failure remains authoritative | W6 |
| Continuity repair skips original handoff | One validated handoff processing event after healthy repair | W6 |
| Initialization outlives the configured watchdog | Startup is bounded independently of ordinary-turn idle handling | W8 |
| Recorded usage compacts and rejects successful bootstrap | Correct current percentage, cumulative total retained, usable bootstrap continues | W1–W2 |

Required additional integration scenarios:

- Approved unchanged plan → preflight → implementation under plain `--steps 10`, with no redundant gate.
- Material scope change → durable decision → answer → resume exactly once; interrupted and noninteractive variants.
- Blocked A, dependent B, independent C → C completes, A remains visible, B remains deferred; repeat with shared delivery and a global blocker.
- Slow compaction → fresh usage → same session continues; timeout → late completion → reconciled fallback without stale events affecting successor.
- QA transfers Builder → process dies before projection publication → resume uses the accepted session.
- Start-over → new run in a preserved worktree → obsolete provider pointer rejected, preserved source handled according to the selected operation.
- Accepted successor → crash before/after dispatch → known remaining work continues or uncertain dispatch pauses without duplicate side effects.
- Structured environment blocker → no repeated QA → prerequisite change → authorized remediation and independent QA.
- Production supervisor → worker crash/hang → bounded reconciliation/restart; pending scoped decisions do not disable independent work.

Use fake clocks for deadline ordering, real SQLite reopen tests for durability, and child-process kills for at least handoff adoption, dispatch uncertainty, projection publication and supervision. Fault-inject storage failure, stale revision, cancellation, duplicate completion and lost acknowledgement. Positive controls must preserve healthy long-running work, ordinary questions, legitimate disputes, native compaction, fresh QA snapshots and both providers.

Run targeted tests after each package; run affected package suites and final monorepo gates after integration. Inspect scripts before running them and record actual results. The relevant existing suites include `codex`, `adapters`, `unifiedContinuity`, `recoveringAdapter`, `foreman`, `branch`, `branchFinalization`, `buildRuns081`, `workflowArchitecture`, `sessionLocation`, `start-output`, `activity`, `observability`, provider questions, the QA plan's suite list, and Rafi's `buildResume`, `buildStartOver`, `createHandoff`, `plan` and planning-runtime suites.

```sh
node --import tsx --test packages/ai-foreman/test/buildStallInvestigation.test.ts
node --import tsx --test packages/ai-foreman/test/qaHandbackInvestigation.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/ai-foreman/tsconfig.json
pnpm typecheck
pnpm test
pnpm build
pnpm docs:check
git diff --check
```

Run PTY/manual checks for visible prompts, Ctrl-C, redirected output and manager agreement. Live-provider benchmarking is a separate implementation validation step on disposable projects under the applicable authorization; planning does not start or resume a real build. Offline passing tests cannot establish live model latency.

## Migration and rollout

1. Land the narrow metric/policy and visibility fixes with realistic regression tests. Then land compatible ownership/projection and outcome/budget changes; deploy supervisor integration after those gates. Keep optional readiness caching and instruction deduplication independently reversible.
2. Inventory persisted schema/protocol changes across this plan and QA P1/P2/P6. Introduce one coordinated migration/version strategy. New readers must understand old records; ambiguous ownership, approval or dispatch remains explicitly unknown. Do not infer approval from prose or rewrite signed/digested evidence.
3. Stop affected writers before migration, make a consistent database-plus-evidence backup, and validate upgrade on a copy. Check foreign keys, row counts, immutable evidence digests, accepted lineage, pointer revisions, pending decisions, budget reservations and QA certificates. Interrupted migration must be idempotently recoverable.
4. Existing impossible handoffs require reconciliation: inspect accepted receipt, actual owner, provider availability, worktree and dispatch journal. An acceptance-only successor may resume only once no conflicting or uncertain action remains. Preserve historical generation values; any new recovery transfer allocates a valid new generation. Superseded-run pointers remain retired regardless of recoverability of their worktrees.
5. Prevent mixed-version writers against upgraded state. If an old binary cannot honor a new write-version guard, enforce exclusive rollout operationally rather than pretending the guard protects it. Do not publish new contracts with only one caller updated.
6. Canary deterministic fixtures first, then representative live workflows with both providers, QA on/off, ordinary/branch/shared delivery, fresh/compact, restart, blocker and question cases. Package compatible spec/runtime/CLI versions together and update generated CLI docs, configuration defaults and release notes.
7. Stop rollout for lost evidence, false completion, unanswered approval bypass, duplicate uncertain dispatch, live-writer theft, unbounded loops, stale resume selection, or weakened QA. Revert optional optimizations separately. Prefer forward schema repair; a pre-upgrade backup cannot replace newer work/evidence without explicit reconciliation.

## Completion checklist

- [x] W0 records the current baseline and overlapping implementation status.
- [x] W1 separates all token meanings and eliminates unnecessary ordinary compaction.
- [x] W2 handles slow, out-of-order and late compactions without false replacement.
- [x] W3 validates before ownership change and durably advances accepted successors into work.
- [x] W4 makes every resume view agree and prevents superseded-session resurrection.
- [x] W5 implements both confirmed product decisions with visible durable questions.
- [x] W6 bounds all recovery layers and preserves failures and handoff requests.
- [x] W7 completes the QA plan's correctness, migration and repeated-work gates.
- [x] W8 covers every blocking phase and resolves or explicitly bounds readiness/ownership uncertainty.
- [x] W9 demonstrably supervises both actual start paths without duplicate workers or replay.
- [x] W10 makes manager/status truthful and records correctness-preserving performance results.
- [x] All eight build-stall and all 26 QA scenarios have desired assertions; added crash and CLI scenarios pass.
- [x] Migration rehearsal, package compatibility, terminal behavior and documentation gates pass.
- [ ] Production rollout: stop writers, back up, deploy compatible packages and monitor. Not performed by this implementation task.
- [ ] Paired live before/after latency comparison. The recorded live runs establish correctness and current latency, not a measured speedup.

Planning review: all investigation findings are mapped above; source checks included the current dirty checkout, both start gates, approval receipts, generation storage/consumers, all three resume sources, current recovery limits, and the supervisor's treatment of pending decisions. Implementation evidence and test scope are recorded below; the unchecked deployment and comparative-performance items are explicit boundaries.

## Implementation verification record — 2026-10-08

The implementation was developed against Node 20.19.0 without dependency or lockfile changes. The original eight build-stall defects were reproduced before repair, then converted into desired-behavior regression assertions. The existing 26 QA diagnostic scenarios passed their desired assertions and were retained alongside caller, journal, migration, prerequisite, and recovery coverage. Existing unrelated checkout changes were preserved.

| Area | Implemented behavior and evidence |
| --- | --- |
| W1 | Codex uses latest context occupancy, keeps lifetime consumption separate, and computes host-turn cumulative deltas. Missing/reset samples stay unknown. Ordinary low-occupancy boundaries do not compact. |
| W2 | Compaction waits are registered before dispatch, serialized, bounded before initialization, and require explicit completion plus fresh usage. Completion can reconcile a lost acknowledgement. Recorded 27/39/48/50/53-second durations and a 90-second control pass fake-clock regressions. Unknown completion quarantines the adapter and requires recovery. |
| W3 | Generation allocation includes predecessor and owner high-water marks. Scoped identity is checked before acceptance and rechecked transactionally. Acceptance evidence precedes rejection; ownership/checkpoint/receipt commit together. Adoption and provider dispatch have separate records. Role and worker fences are checked before dispatch. |
| W4 | Active resume selection uses authoritative workflow status and accepted bindings. Completed/superseded owners cannot be resurrected by JSON or JSONL fallback. Acceptance updates branch pointers transactionally; reads reconcile stale build projections. |
| W5 | Immutable ticket-publication evidence or an exact digested plan-slice match permits approval reuse. Mutable tracker snapshots cannot confer approval. Scope fingerprints include plan, tickets, configuration, delivery, and supplied workflow consequences. Questions persist before prompting; redirected input returns a recoverable outcome. Independent work continues around ticket blockers; answered ordinary-ticket questions are consumed once at safe boundaries. |
| W6 | Execution failures remain authoritative through corrections. Wrapper and Foreman correction budgets share durable reservations. Repeated blocker explanations are bounded across restart. Repaired continuity still processes the original handoff. Tool-using response-only corrections cannot authorize success. |
| W7 | Existing QA occurrence identity, turn journaling, atomic receipts/budgets, migration guards, prerequisite checks, and bounded history are integrated and exercised by the full suites. Structured blocked outcomes remain blocked and do not become QA passes. |
| W8 | Preparation, standalone RPC, compaction, turn, and shutdown bounds are configurable and frozen. Cleanup handles readiness descendants; Codex waits for forced process termination after graceful shutdown expires. Claude intentional question waits suspend its active-turn timer. Uncertain dispatch is not replayed. |
| W9 | Actual ordinary, branch, detached, and crash CLI scenarios use the parent supervisor. Generation is published before spawn, ownership renewals use compare-and-set, and losing ownership stops the worker. Crashed workers with unresolved work pause for reconciliation. Supervisor retry budgets do not reset on cosmetic checkpoint changes. Stop commands verify process incarnation. |
| W10 | Diagnostics expose pending decisions, unresolved dispatch, accepted/adopted milestones, and worktree location. Returned failures are recorded as failures. Process elapsed time is explicitly distinguished from provider compute. Runtime behavior and recovery commands are documented in the runtime README and unreleased changelog. |

Verification was incremental: targeted suites followed each change, followed by monorepo type checking, build, tests, CLI documentation validation, and whitespace checks. The final full monorepo run passed 937 tests total: 933 passed, zero failed, four intentionally skipped. Package results: spec 48/48, special-agents 92/92, CLI 199 passed plus two skipped, runtime 594 passed plus two skipped. The skipped cases are two optional TTY-runner harness checks and two opt-in native live-provider session tests; the separate 20-build live canary and manual PTY checks are recorded below. Final type checking, all four package builds, generated CLI documentation validation, and `git diff --check` also passed. The last deadline/adapter/continuity focused run passed 81/81 and manager diagnostics 11/11 before the final full run. Evidence: `/private/tmp/rafi-full-tests-8.log`, `/private/tmp/rafi-final-types-8.log`, `/private/tmp/rafi-final-build-8.log`, `/private/tmp/rafi-final-docs-8.log`. Tests use disposable repositories and scripted providers; no active user build was resumed or migrated.

### Additional implementation and verification

- Claude SDK 0.3.159 / CLI 2.1.292 acknowledges initialization before exposing session identity. A capability-checked, built-in `/context` command establishes scoped identity with zero model cost and denied tools. Context/settings preparation now follows that initialization; a real local-only probe reproduced a control-query deadlock when the order was reversed. Regression tests cover lazy identity, wrong cwd, timeout, and initialization-before-context ordering.
- Runtime readiness, build-plan feedback, QA nonconvergence, both waiver decisions, Planner guidance/approval/revision, and report-recovery guidance now use durable questions. Readiness retry answers are spent once. Successful read-only Planner proposals persist against exact instructions/settings/source state; interrupted proposals require explicit, bounded retry authorization.
- Ordinary and branch schedulers reconsider answered ticket questions at safe boundaries. The branch test covers A asking, dependent B deferring, independent C answering A's question while completing, then A resuming exactly once in its preserved worktree and B completing.
- Compaction deadlines extend only for correlated operation progress, up to the hard ceiling. Unknown completion remains `uncertain`, survives reopening, and blocks another boundary/settings transition on that session. Late completion during bounded cleanup is recorded against the original attempt, with duplicate accounting suppressed. Explicit completion with missing occupancy pauses for reconciliation rather than falsely declaring failure.
- Build-run publication now journals filesystem projection intent with the authoritative database update. Reads retain database-authoritative runs when projections or their entire directory are missing. Fault injection proves a failed rename preserves pending publication and a later safe publication reconciles it.
- Real process kills cover six handoff/adoption/dispatch/response boundaries. Actual CLI cases cover ordinary, branch, detached, uncertain implementation crash, parent death, cancellation, competing starts, worker event-loop hang, and preparation restart. Preparation restarts require no implementation authority, no dispatch/handoff record, and verified quiescence of registered readiness children and the worker. Other interrupted checkpoints remain explicit recovery, without speculative replay. Group liveness uses verified process incarnation and a process inventory when signal probes cannot distinguish absence or zombies.
- Final terminal status preserves paused/interrupted outcomes instead of labeling every closed reporter completed. Interrupted runs list pending decisions and exact run-scoped answer/resume commands. Manager findings expose pending decisions and unresolved dispatch, with acceptance, adoption and dispatch evidence kept separate. A PTY check confirmed visible prompts, Enter continuation, Ctrl-C safe pause (exit 2), retained pending decisions and manager agreement. Redirected-input behavior is also covered by an actual supervised CLI regression.
- An already exhausted outer deadline cannot dispatch the next phase, and a throwing timeout cleanup callback cannot escape as an uncaught timer error.
- Activity output separately warns after five minutes without a completed tool or agent turn. Transport/status spam does not reset that clock; intentional human waits are excluded. The warning does not cancel healthy long-running work.

### Live-provider canaries

The user authorized both authenticated providers. Twenty disposable builds passed: five per provider and scenario. Every successful run was independently tested with `node --test sum.test.js`, and original test bytes were checked for modification. All runs completed, with zero handoffs and zero compactions on these low-occupancy tasks. This is a small correctness/latency sample, not a paired speedup benchmark or a tail-latency estimate.

| Provider / scenario | Samples | Median elapsed (range), seconds | Median first source change, seconds | Median provider-turn span total, seconds | Median journaled host instruction bytes |
| --- | --- | --- | --- | --- | --- |
| Claude / current, QA off | 5 | 42.4 (37.2–108.9) | 29.7 | 32.5 | 6,490 |
| Claude / branch, QA on | 5 | 113.0 (104.6–287.5) | 57.0 | 86.6 | 9,021 |
| Codex / current, QA off | 5 | 89.3 (82.3–202.2) | 77.2 | 51.9 | 6,490 |
| Codex / branch, QA on | 5 | 247.0 (229.8–368.4) | 121.0 | 150.2 | 8,756 |

Provider-turn spans measure host-observed elapsed time, including provider/tool waits; they are not model compute. Host instruction bytes exclude provider-added system content. First source change uses 100-ms polling, including authoritative worktree locations. QA-on cases used independent disposable review snapshots and retained worktrees for verification. Settings were default provider models, Builder compact strategy at configured 65%, fresh QA, 300-second turn limit, and no publishing/merge. Claude reported its supported effective compaction threshold where clamped. Versions: Claude CLI 2.1.292, SDK 0.3.159; Codex CLI 0.160.1; Node 20.19.0. Canary host digest: `14fc2acd13b900816ec4b6408e71401dfa3754f2e59b7b2e98a5c65863329b54`. The later durable-question, progress, late-compaction, branch-answer and supervisor recovery refinements were validated with focused and full regression suites; the live timing table pertains to this recorded canary build.

Local evidence: `/private/tmp/rafi-live-five.log`, `/private/tmp/rafi-live-canary-metrics.json`, and the disposable run root `/var/folders/g1/wq3b58m917qdvtbjzqxr0n740000gn/T/rafi-live-build-stalls-ymHDX6`. Earlier failed pilots are retained separately and are not included as successful samples.

### Affected-project migration rehearsal

The user's `moneyFarm` recovery database and protected evidence remained available. Inspection found the historical accepted generation-1 successor after a generation-2 predecessor. There was no recovery-database writer or project mutation lease; a separate observability reader/writer was left untouched. A SQLite backup plus protected evidence copy was migrated in `/private/tmp/rafi-moneyfarm-migration-jfxrrw82` and reopened successfully. All 153 evidence blobs retained their SHA-256 digests; existing row counts were unchanged except the additional migration receipt; integrity was `ok` and foreign-key violations were zero.

On that isolated copy, explicit recovery staging allocated generation 3 from the accepted owner while preserving the historical generation-1 evidence unchanged. No provider was dispatched and no original project record was modified. New generation allocation includes validated historical predecessor/successor high-water marks, so recovery cannot repeat an old regression. Existing recovery inspection and explicit fresh-with-handoff recovery remain the path for historical runs; missing legacy dispatch evidence is not proof that no work was sent.

### Rollout boundaries

- No production database was migrated, no interrupted user build was resumed, and no release was published. Deployment still requires exclusive writers and a consistent backup; the successful rehearsal does not authorize modifying the original project.
- Automatic restart is deliberately limited to the proven preparation checkpoint. Established work, unknown provider side effects, unverifiable process ownership, and incomplete cleanup require explicit reconciliation.
- Late provider work that cannot be observed or queried remains unknown; a timeout never establishes cancellation or permits blind replacement. Optional readiness caching and persistent instruction deduplication remain disabled without equivalence evidence.
- The live fixtures exercise ordinary builds without QA and branch builds with QA. Shared delivery, blocker/question recovery, fresh handoffs and crash boundaries have deterministic integration coverage; this sample does not establish live latency for every combination.

