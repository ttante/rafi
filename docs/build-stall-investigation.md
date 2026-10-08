# Build stall investigation — October 7, 2026

Several concrete defects explain the reported symptoms. The strongest chain is: Codex context usage is calculated from cumulative token consumption; ordinary boundaries also compact regardless of occupancy; successful but slow compactions are declared failed after 30 seconds; fallback handoffs create additional sessions; stale resume records can bring an older generation into a new run; that run accepts a successor and then rejects its generation before dispatching implementation. Separately, the initial plan approval can wait indefinitely while the display and persisted run still imply work is running.

These conclusions come from current source, commit history, local project databases and JSONL logs, provider transcripts, and isolated reproductions. They are not inferred solely from status messages. The exact reported five-hour run and three-hour decision wait have not been positively identified: the available MoneyTree records establish an even longer plan wait, and MoneyFarm contains the accepted-but-idle successor failure. Confirmation of the project and approximate incident time would complete that correlation.

Scope: checkout `1b41606` plus its pre-existing working-tree edits; history back through the August 27 v0.9.6 baseline and earlier origins where relevant; local MoneyTree and MoneyFarm records through October 8 UTC (October 7 Chicago evening). Existing local edits were preserved. This investigation adds only this report, a read-only audit script, and eight characterization tests. No live model sessions were launched or resumed, and no production fixes were applied. The pre-existing [QA handback investigation](qa-handback-investigation.md) is complementary; its real-run measurements were independently rerun against the databases.

## Evidence at a glance

| Finding | Evidence level | Practical consequence |
| --- | --- | --- |
| Cumulative Codex usage treated as context occupancy | Recorded values, production source, replay test | False context pressure; compaction cannot lower the displayed value; bootstrap can pause despite successful compaction |
| 30-second compaction deadline | Five host attempts correlated with same-session provider completions | Four successes were classified as failures and entered handoff recovery |
| Accepted successor rejected for generation regression | Real log and provider transcript; real SQLite/handoff/controller reproduction | New agent receives setup and acceptance but no implementation instruction |
| Stale session pointers survive QA transfers and start-over | Real database/file divergence; source; superseded-run reproduction | Resume reuses an obsolete session and crosses run-generation scopes |
| Invisible/unbounded initial plan approval | Three MoneyTree wait spans; no implementation events; source | Hours of elapsed time with no build dispatch |
| Unchanged environment blocker repeatedly re-reviewed | Three MoneyFarm reviews and remediation deliveries | Minutes of repeated QA/remediation, growing prompts, no source progress |
| Blocker recovery has no attempt budget | Production loop; eight consecutive blocked replies reproduced | A responsive provider can loop indefinitely without consuming a completed step |
| Startup RPCs have no deadline; supervisor is not wired into start | Fake-transport reproduction and production call-site search | New ordinary-turn timeout does not cover all hanging phases |
| Repair paths lose errors or handoff requests | Isolated production-path reproductions | Protocol repair can count failed work as done or skip a requested transfer |

## 1. Context pressure is calculated from lifetime consumption

In [the Codex notification handler](../packages/ai-foreman/src/adapters/codex.ts#L511), `used` is assigned `tokenUsage.total.totalTokens`, then divided by `modelContextWindow`. The same `total` correctly supplies cumulative session accounting, but it is not current context occupancy. Actual transcripts distinguish this cumulative total from `last_token_usage.total_tokens` and show the former remaining unchanged after compaction while the latter shrinks.

MoneyFarm's first implementation session, `01a11887-fdd0-7931-a2d4-9325be43b727`, reported at `2026-10-07T22:56:43.877Z`:

| Quantity | Tokens | Share of 258,400-token window |
| --- | ---: | ---: |
| Cumulative session consumption used by Rafi | 3,555,538 | 1,375.98% |
| Latest provider context/usage sample | 111,524 | 43.16% |
| Latest sample after successful compaction | 23,635 | 9.15% |

The cumulative total stayed 3,555,538 after compaction. The durable `compaction_attempts.before_sample_json` independently contains Rafi's 1,375.98% reading. A later session reports 420,765 cumulative tokens, which Rafi treats as 162.83% full, although its latest sample is 76,415 tokens, or 29.57%. Subsequent compactions lower the latest sample to approximately 57,000 tokens while cumulative consumption remains 420,765.

This corrupts a control input, not just a display. [ThresholdCompactionController](../packages/ai-foreman/src/sessionLifecycle.ts#L394) uses the sample to gate work, compact, or hand off. The recorded-value reproduction drives the real adapter notification handler and controller: a below-threshold session is compacted; the mock successful completion publishes the recorded smaller latest sample; Rafi still sees 1,376% and rejects a fresh bootstrap with `fresh bootstrap remained at 1376.0% after compaction`. That final pause is reproduced behavior, not a claim that this exact error appeared in the historical logs.

There is also an independent source of excess compaction: [ordinary `session_strategy=compact` boundaries](../packages/ai-foreman/src/sessionLifecycle.ts#L468) call compaction even below the configured threshold. A separate reproduction compacts at 10% occupancy with a 65% threshold. The real successful 23:57 attempt starts at only 29.56% even under Rafi's inflated calculation. Correcting the metric alone therefore will not remove all unnecessary boundaries. This ordinary compact strategy predates the recent durable handoff machinery and should be evaluated as policy, not falsely attributed entirely to a new regression.

**History and missed coverage.** The total-based mapping originates in `13a1c68` (v0.9.0, August 22). `b12b302` (v0.9.7, August 28) made truthful occupancy central to durable compaction/handoff decisions. Crucially, `5b55595` on August 31 at 09:41 Chicago changed `used` to `last.totalTokens` and increased the compaction deadline to 120 seconds. `61a7ff6`, at 10:19, reverted that whole change. The current line is attributed to that revert. The later v0.9.9/v0.9.10 compaction rework retained the bad mapping and short deadline.

The existing test named [“Codex token usage keeps live context and cumulative provider totals separate”](../packages/ai-foreman/test/codex.test.ts#L242) supplies total=72 and last=12 but expects context used=72. The compaction fixture immediately below makes the cumulative total decrease from 80 to 24, hiding the real behavior. These passing tests encode the wrong model. Repair should separate current context, cumulative session accounting, and per-host-turn consumption; using the latest single provider request for the latter would also undercount a multi-request agent turn.

## 2. Successful compactions are timed out and turned into handoffs

[CodexAdapter.compactInternal](../packages/ai-foreman/src/adapters/codex.ts#L194) starts two fixed 30,000 ms waiters: one for the `contextCompaction` completion item and one for fresh usage. Neither is the configurable ordinary-turn idle timeout. When either rejects, compaction returns `ok: false`; [the lifecycle controller](../packages/ai-foreman/src/sessionLifecycle.ts#L603) immediately requests a fresh validated handoff.

The following five host attempts correlate with explicit `compacted` records and task completions in the same provider sessions. All times are UTC; durations start at the durable host attempt timestamp.

| Host start | Host outcome / elapsed | Provider completion | Provider elapsed |
| --- | --- | --- | ---: |
| Oct 7 23:00:22.260 | Failed / 30.019 s | 23:01:15.574 | 53.314 s |
| Oct 7 23:57:12.200 | Succeeded / 27.990 s | 23:57:40.135 | 27.935 s |
| Oct 8 00:02:09.306 | Failed / 30.036 s | 00:02:59.428 | 50.122 s |
| Oct 8 00:45:40.320 | Failed / 30.013 s | 00:46:19.416 | 39.096 s |
| Oct 8 01:41:29.943 | Failed / 30.011 s | 01:42:18.438 | 48.495 s |

Four of five compactions in this sample completed after Rafi had already classified them as failures. This is a sample count, not an estimate of the general failure rate. Correlation uses session identity and the immediately following completion; the saved rollout is not a capture of the original JSON-RPC request IDs. Nonetheless, explicit same-session compaction completion plus matching task completion establishes that the provider did finish the operation. The audit labels this correlation `providerCompletionCandidate` to preserve that distinction.

The original request is not cancelled at the timeout. Rafi can prepare a replacement while the predecessor is still finishing a successful compaction. New-session work includes readiness checks, context-window discovery/setup, sometimes restarting the app server to install the native threshold, acceptance, and validation before implementation. Thus a 30-second false failure costs substantially more than 30 seconds and exposes the handoff defects below.

OpenAI's [app-server documentation](https://learn.chatgpt.com/docs/app-server) describes `thread/compact/start` as asynchronous: the request returns immediately, with progress and completion reported through normal notifications. It does not promise completion within 30 seconds. The empirical 39–53 second successes are the direct evidence that Rafi's current deadline is unsuitable for these runs.

The error text further says the provider was silent for “1 minutes,” because [the generic waiter](../packages/ai-foreman/src/adapters/codex.ts#L565) rounds 30 seconds to minutes. These compaction waiters do not reset on provider activity, so “silent” is not necessarily true either. Keep a bounded deadline, but distinguish operation progress, completion, transport inactivity, and a late result; do not solve this by assuming success or discarding fresh-usage validation.

## 3. The accepted-but-idle successor is a confirmed host-side failure

MoneyFarm's log `.foreman/2026-10-08T01-40-48-949Z.jsonl` contains this sequence:

| Time UTC | Event |
| --- | --- |
| 01:41:29.685 | New run resumes session `01a118c9-…`, generation 2, from the old run's worktree |
| 01:41:29.943 | Compaction begins using the inflated 162.83% sample |
| 01:41:59.954 | Host declares compaction failed after 30 seconds |
| 01:42:18.438 | Predecessor actually finishes compaction |
| 01:42:48.729 | New run durably accepts successor `01a1192c-…`, generation 1 |
| 01:42:48.736 | `handoff-transfer` logged |
| 01:42:48.759 | `builder_error`: `handoff successor generation did not advance after validated acceptance` |

The successor's provider transcript contains exactly two task turns: setup and handoff acceptance. It contains no subsequent implementation turn. This directly matches the reported “handoff happened and the new agent did nothing” behavior: the host fails before sending it work.

The contradiction spans three production components:

1. [HandoffService.stage](../packages/ai-foreman/src/handoffs.ts#L185) computes generation from prior handoffs **within the current run**: `(prior?.generation ?? 0) + 1`. In a new run this is 1, even if the imported predecessor reference is generation 2.
2. [Acceptance](../packages/ai-foreman/src/handoffs.ts#L368) writes that generation onto the successor, persists accepted state, and moves ownership. The [start callback](../packages/ai-foreman/src/cli/start.ts#L1772) logs success and adopts the successor through the continuity wrapper, closing the predecessor.
3. Only afterward, [RoleSessionController.acceptManagedTransition](../packages/ai-foreman/src/sessionLifecycle.ts#L304) requires `successor.generation > predecessor.generation` and throws.

The new run is `f8baf5ed-9cf6-4558-9d35-32ad3afc0e40`; the predecessor belonged to `7810b84b-5261-4c0f-a722-3aa108185dc8`. Both incompatible generation rules date to `b12b302` (v0.9.7). This is not evidence of a model refusing to act.

The reproduction uses the real HandoffService, SQLite persistence, and managed RoleSessionController with scripted providers. It verifies all four facts: successor accepted, generation regressed, predecessor closed, successor received acceptance only. Fix generation scope and transition ordering together. Merely removing the comparison would weaken session identity checks while leaving stale recovery and contradictory ownership records intact.

## 4. Resume records preserve the wrong session across handoffs and start-over

The old MoneyFarm run is durably `superseded`, yet its `branch_resume_sessions` row remains `active` and points to generation 2. `.foreman/delivery-sessions/foundation.json` also points to generation 2 even though the old run later accepted generation 6 (`01a118f9-e487-79e2-8a39-e9accb258921`). The subsequent new run actually resumes that generation-2 session.

There are two independent persistence gaps:

- [Branch runner](../packages/ai-foreman/src/branch/runner.ts#L365) writes the structured resume row and delivery-session JSON after the main Builder step, before QA. When QA remediation changes Builder sessions, [its recordSession callback](../packages/ai-foreman/src/branch/runner.ts#L460) updates the stream, main run record, and checkpoint, but not those two resume indexes.
- [build:start-over](../packages/rafi/src/buildStartOver.ts#L133) resets tickets and supersedes the old run without retiring its branch-session records or delivery-session pointer. [WorkflowDb.branchResumeSessions](../packages/ai-foreman/src/workflowDb.ts#L1662) and WorkflowReader select session status `active` without joining the owning run's terminal/superseded status. [findResumableBranchSessions](../packages/ai-foreman/src/branch/resume.ts#L30) accepts those rows if the worktree exists.

The shared-delivery path can bypass structured selection altogether: [start.ts](../packages/ai-foreman/src/cli/start.ts#L1618) accepts saved delivery state when the branch matches and the directory exists. That JSON has no owning run ID with which to reject a superseded lineage. Preserving a worktree intentionally across a restart is compatible with retiring obsolete provider-session identity; the current code conflates them.

A characterization test supersedes a real workflow run and proves its session is still selected. The stale QA pointer is independently established by the source path and real database/file divergence. Start-over behavior dates to `e149a4d` (August 27); shared-delivery reuse predates that; the structured database selection was added in `3c721b8` (v0.9.13). Scoped generations and more frequent QA transfers make these older pointer assumptions more damaging.

Repair needs one authoritative accepted-session transition that updates every recovery view, ownership checks when selecting candidates, and explicit run/lineage handling at start-over. The legacy JSONL fallback also needs terminal-run filtering, or it can resurrect a session after structured records are correctly retired.

## 5. The initial plan gate can account for hours with no code

MoneyTree has three recorded build executions whose logs stop at preflight. There are no implementation step, QA, or handoff events for these executions.

| Build run prefix | Preflight | Observed `build plan decision` wait |
| --- | ---: | ---: |
| `55d1bc38` | 15.06 s | 17 h 18 m 24 s |
| `38b16436` | 7.80 s | 4 m 8 s |
| `e1be042a` | 22.72 s | 20 m 10 s |

The long wait begins `2026-10-05T23:25:00.387Z` and ends `2026-10-06T16:43:24.092Z`: October 5 at 6:25 pm through October 6 at 11:43 am Chicago time. The span's duration includes the entire interval until interruption; it should not be interpreted as proof that the terminal remained awake and interactive every second. It does prove the build did not advance into implementation during the recorded execution.

[Preflight explicitly tells Builder](../packages/ai-foreman/src/foreman.ts#L223), “Do not implement anything yet.” [start.ts](../packages/ai-foreman/src/cli/start.ts#L2184) then waits on “How does this plan look?” with no deadline. `--steps 10` does not authorize that plan automatically and is not a wall-clock or model-turn budget. [autoApprovePlanUpdates](../packages/ai-foreman/src/cli/start.ts#L470) comes from `--yes` or an automatic recovery decision, not simply the unattended autonomy profile.

The visibility problem is substantial:

- The activity/status reporter is started before preflight and remains alive during this prompt. The [withObservedUserWait helper](../packages/ai-foreman/src/cli/start.ts#L2330) only opens a telemetry span; it does not pause activity rendering or change the displayed phase to waiting for the user.
- This gate does not send the attention notification used by Builder's normal `needs_input` path.
- No human decision is persisted for these waits. The three workflow records remain `running` at `preflight-complete`, and `human_decisions` has no rows for them, even after the execution interruptions.
- The older terminal activity redraw could interfere with prompt visibility. The v0.9.18/current local activity changes improve output handling but do not make this gate persist and advertise its pending decision.

The prompt itself is old (`4b87963`, June 6); it is not a newly introduced requirement. Activity/status changes can make an existing wait look like active work. New recovery machinery does not consistently represent that old prompt as a durable decision. This is the strongest explanation for the no-code/long-decision symptom in the available MoneyTree evidence, but cannot be equated to the user's exact five-hour/three-hour incident without its identity.

For a plan already intentionally approved, `--yes` bypasses this initial approval. It does not bypass all later questions and does not repair the other defects. The product fix is explicit durable waiting state, visible input ownership, attention signaling, noninteractive behavior, and resumable decisions—not silently inventing the user's answer.

## 6. QA repeatedly spends work on an unchanged environment blocker

MoneyFarm's initial Builder turn did perform implementation: approximately 14m31s, followed by QA. Its worktree is under `.foreman/worktrees/7810b84b-5261-4c0f-a722-3aa108185dc8/feature__foundation`; inspecting only the main checkout can miss that work. This distinguishes that run from MoneyTree's preflight-only executions.

The three QA reviews all identify the same absent `pnpm-lock.yaml`. Remediation encounters registry `ENOTFOUND` and missing offline metadata. Dependencies and Docker are also unavailable for the required runtime checks. All three reviews and remediation source captures have the same digest. The first two Builder reports explicitly agree the finding is valid but label it `disputed`, because the successful-report schema offers `fixed` or `disputed` and lacks an environment-blocked outcome.

[finishSuccess](../packages/ai-foreman/src/qaFailureDelivery.ts#L425) records a valid remediation report as succeeded, and [the review loop](../packages/ai-foreman/src/qaReview.ts#L313) schedules a full recheck. It does not claim a QA pass, but it spends time repeating an unchanged blocker. This loop is budgeted, unlike the Foreman blocker loop below.

| Measurement | Cycle 1 | Cycle 2 | Cycle 3 |
| --- | ---: | ---: | ---: |
| QA including preparation | 217.54 s | 182.84 s | 154.78 s |
| Completed/resumed remediation delivery invocation | 166.80 s | 142.32 s | 174.01 s |
| Time before remediation dispatch | 74.01 s | 29.35 s | 87.40 s |
| Host remediation prompt | 25,291 bytes | 49,250 bytes | 75,816 bytes |
| Builder response corrections | 1 | 1 | 1 |
| Source changed | No | No | No |

QA itself needed zero report corrections in these three reviews. Every Builder handback needed correction; the third still failed on a malformed trailing `}`. [The correction prompt](../packages/ai-foreman/src/qaFailureDelivery.ts#L373) does not include the actual parser errors and complete schema. It asks for shape repair with limited diagnostic information. Continuity wrapping supplies another potential repair layer inside a host turn.

Prompt history also grows while the source does not: prior remediation requests already containing history are included again, and the current report is repeated. QA prompts grow approximately 11.6 → 34.1 → 60.9 KB. Moreover, [Codex buildInstruction](../packages/ai-foreman/src/adapters/codex.ts#L68) prepends system-append and skill material on every turn. In a recorded correction, the 685-byte host instruction becomes approximately 32.6 KB at the provider. These measurements establish redundant context; the sample cannot isolate an exact percentage of latency caused by prompt size.

Fresh disposable QA snapshots also require new location-scoped sessions. That protection is reasonable, but each cycle pays session initialization, readiness, acceptance, and sometimes compaction. The recorded first-QA-to-last-handback interval is 1h51m49s, whereas the three QA durations plus the three final delivery invocations sum to about 17m18s. The difference includes setup failures, interruptions, recovery, and resume gaps; it must not all be attributed to active QA or model time.

The main regression window here is `3c721b8` (v0.9.13) and especially `a874f0f` (v0.9.14): durable QA failure delivery, source identities, stronger handoff/recovery, and more session boundaries. The V2 work also bounded some older repair behavior; it was not uniformly a regression. Retain its safety checks while adding a structured blocked outcome and a stop/resume condition for unchanged environmental prerequisites. A legitimate dispute or environment-only fix can warrant re-review even with unchanged source, so digest equality alone is insufficient.

## 7. Other reproduced ways to stall or conceal lack of progress

**Unbounded blocked recovery, introduced in v0.9.12.** [Foreman's outer loop](../packages/ai-foreman/src/foreman.ts#L420) asks a blocked agent to suggest approaches and expects `needs_input`. If the provider returns `blocked` again in an interactive terminal, it repeats without an attempt count, elapsed budget, or unchanged-blocker check. The reproduction returns eight blocked responses and then a fixture stop, producing nine provider calls; nothing in the production loop would have stopped the ninth blocked response. This path was added in `c701f73`. Responsive model output prevents a silence watchdog from helping. No such multi-hour loop was positively identified in the inspected project logs.

**Protocol correction overwrites provider failure.** [Foreman](../packages/ai-foreman/src/foreman.ts#L400) specially handles `session-unavailable`, but otherwise parses text before rejecting `isError`. A malformed/missing status starts a correction and replaces `result`. The reproduction returns an errored implementation turn followed by a syntactically valid `done`; `runBatch(1)` reports one completed step when QA is disabled. QA can catch some missing work when enabled, but the host must not erase the failure. This behavior predates the newest changes. The separate QA investigation also reproduces errored corrections being accepted in QA delivery.

**Continuity repair skips handoff handling.** A valid original continuity delta reaches [handleHandoffRequest](../packages/ai-foreman/src/continuity.ts#L170). When the original response contains a handoff request but its continuity delta needs repair, [the repaired-delta branch](../packages/ai-foreman/src/continuity.ts#L199) publishes and returns the original cleaned response without processing that original handoff request. A reproduction verifies the callback is never invoked. That can strand an agent at a context-requested boundary. It is a code-path finding, distinct from the confirmed generation failure.

**Provider startup is outside the new idle watchdog.** [Codex sendTurnInternal](../packages/ai-foreman/src/adapters/codex.ts#L127) awaits `ensureThread()` before installing its completion waiter. [The JSON-RPC request method](../packages/ai-foreman/src/adapters/codex.ts#L431) has no timeout; initialization, thread start/resume, and other request acknowledgements can remain pending while the process stays alive. A fake transport accepting writes but never replying remains pending beyond a configured 10 ms provider idle deadline; closing it finally releases the request. This requires no real provider call to reproduce.

v0.9.18 (`65b45fd`) added a default 30-minute ordinary-turn idle limit, improving the prior unbounded wait. It does not cover startup, and any provider message resets the idle timer; repeated retry/status notifications do not prove useful work. Claude's native-compaction initialization/settings calls, context queries, and shutdown also contain awaits without a separate host deadline. Those Claude paths were inspected, but the real incident evidence here is Codex, not proof of a Claude outage.

**Configured durable supervision does not supervise this entry point.** [DurableSupervisor](../packages/ai-foreman/src/supervisor.ts#L28), added with v0.9.13, implements worker/recovery logic, and default policy enables a supervisor. Production call-site searches find no construction of that class; `start` directly runs the Foreman/branch path. Both inspected recovery databases have zero supervisor lease rows. Those restart settings therefore do not establish that a supervisor will detect or restart a stalled build. Wiring one in also requires meaningful progress/waiting signals; a heartbeat alone cannot distinguish these failure modes.

## 8. Observability can mislead the manager and operator

The underlying records are useful, but their meanings are inconsistent at several boundaries:

- Initial human waits get `user_wait` spans while run state remains `running` and durable human decisions are absent. A manager reading only workflow state can miss the actual wait.
- Failed compactions can have observability spans marked completed because the operation returned `{ok: false}` rather than throwing; `compaction_attempts.status` has the actual failure. A completed span is not necessarily successful compaction.
- An accepted handoff does not prove its successor was adopted or received work: the real generation failure happens after acceptance.
- “Active execution” wall time can contain human waits; nested span durations cannot simply be added to wall time. Restart gaps cannot be assigned to model work without further evidence.
- QA delivery receipts in the existing sample pair the original prompt digest with a 685-byte correction length. That discrepancy makes prompt and correction cost analysis unreliable unless the individual turn journal is consulted.
- New session probes can fail after approximately 30 seconds even when their output includes `OK`; model-catalog/network errors also appear. The records do not establish whether shutdown, connectivity, sandbox restrictions, or a provider defect kept the probe alive. Likewise, an active-writer rejection was observed but does not justify assuming its owner was dead.

The v0.9.18 macOS process-liveness and activity improvements address some earlier diagnostics problems, but they do not correct context math, compaction deadlines, generation scope, stale resume indexes, or durable decision state. Treating the latest logging changes as a full resolution would leave the main failure paths intact.

## Version assessment

| Change | Contribution to the current problem |
| --- | --- |
| `13a1c68`, Aug 22, v0.9.0 | Cumulative Codex total used for context; app-server RPC waits without deadlines |
| `e149a4d`, Aug 27, before v0.9.7 | Start-over supersedes run but does not invalidate all session pointers |
| `b12b302`, Aug 28, v0.9.7 | Durable context/handoff control, 30-second compaction deadlines, incompatible generation scopes |
| `5b55595` then `61a7ff6`, Aug 31 | Correct context metric and 120-second deadline briefly added, then entirely reverted |
| `e810557`, `6591115`, `f09ff13`, Aug 31, through v0.9.10 | Native compaction rework retained cumulative metric and 30-second manual wait |
| `c701f73`, Sep 1, v0.9.12 | Unbounded blocked-recovery conversation; more resume/boundary interactions |
| `3c721b8`, Sep 4, v0.9.13 | Durable QA delivery, structured branch recovery, supervisor infrastructure, user-wait observations |
| `a874f0f`, Sep 7, v0.9.14 | QA V2 and fresh snapshot/session behavior amplify repeated blocker/boundary costs |
| `65b45fd`, Oct 7, v0.9.18 | Adds ordinary-turn idle timeout and liveness/logging fixes; important gaps remain |

“Eight or nine versions ago” from v0.9.18 roughly points to the v0.9.9/v0.9.10 compaction era. The evidence supports interacting lifecycle and recovery regressions, not a single proven bad release. Some harmful ingredients predate that window and become much more expensive as later QA and resume changes exercise them. No controlled live-provider benchmark or historical good/bad bisect was run, so this report does not certify a rollback target. Provider rollout metadata also differs between the sampled projects (Codex 0.160.0 versus 0.160.1); that does not explain deterministic host failures but limits a release-wide latency comparison.

## Repair order and acceptance criteria

1. **Repair context accounting and compaction lifecycle together.** Use the authoritative current-context metric, preserve cumulative accounting separately, replace the 30-second false-failure policy with bounded progress-aware handling, and reconcile late completion before replacing a session. Replay recorded values and slow/out-of-order compaction events. A normal below-threshold boundary should not compact unless an explicit independent policy calls for it.
2. **Make transfer and resume identity coherent.** Choose an explicit generation scope, validate before durable acceptance/adoption/closing the predecessor, atomically update recovery pointers or reconcile them durably, and retire superseded session ownership. Test QA transfer followed by interruption, start-over followed by shared-delivery reuse, cross-run predecessor generations, and crashes at every acceptance/pointer boundary. Preserve worktrees and completed side effects.
3. **Represent human waiting honestly.** Persist the actual decision before waiting, publish a waiting state, stop competing activity rendering, notify once, support an explicit noninteractive result, and restore the decision on resume. Verify plain `start . --steps 10`, approved `--yes`, unattended policy, interruption, redirected output, and actual terminal prompt behavior.
4. **Bound nonproductive recovery.** Give repeated blockers and protocol repairs a durable shared budget. Preserve error/uncertain-dispatch state through every wrapper and repair. Add explicit blocked remediation with prerequisites for re-entry, then avoid repeated full reviews when no relevant source, evidence, environment, or authorized decision changed.
5. **Finish watchdog coverage and progress reporting.** Bound startup/settings/context/shutdown RPC phases separately; distinguish no transport activity, no useful progress, and intentional human wait. Integrate durable supervision only with those accurate states. Record accepted, adopted, dispatched, and completed successor milestones separately.
6. **Reduce overhead after correctness is restored.** Bound nonrecursive QA history, pass actual validation errors to the one permitted response correction, measure readiness/setup separately, and cache only evidence whose executable/configuration/environment identity remains valid. Benchmark representative tickets with QA and both providers; do not loosen source-bound QA or session identity checks merely to improve elapsed time.

## Verification and reproduction

Added [eight characterization tests](../packages/ai-foreman/test/buildStallInvestigation.test.ts). All eight pass by demonstrating the current defects, not by asserting the desired repaired behavior. Convert each to a desired-behavior regression test as its fix lands. The fixtures use actual Foreman, lifecycle, handoff, continuity and SQLite paths with scripted providers; they do not make live model calls.

Also ran 227 existing tests across Foreman, Codex/adapters, continuity, recovery, branching, status/activity, start output, observability, session location, QA delivery/protocol/recovery/snapshot/runtime/acceptance/preparation. All passed. The two grouped invocations reported 99 and 135 tests; the latter included the first seven new characterizations, so those are not counted twice in the 227 existing total. The final separate run passed all eight characterizations. `ai-foreman` TypeScript checking passed. These are targeted checks of the implicated systems, not a claim that the entire monorepo test suite was run.

The [read-only audit](../scripts/audit-build-stalls.py) prints relevant run state, waits, compactions, handoffs, resume pointers, and selected matching provider transcript timing/token fields. It does not print transcript bodies or launch providers. It opens existing databases read-only, with a checked immutable fallback only for an inactive database lacking a WAL file. Each database read has its own transaction; the combined output is not an atomic snapshot across a live project and its provider logs.

```sh
python3 scripts/audit-build-stalls.py /Users/tyler/reps/moneyTree /Users/tyler/reps/moneyFarm \
  --codex-sessions /Users/tyler/.codex/sessions
node --import tsx --test packages/ai-foreman/test/buildStallInvestigation.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/ai-foreman/tsconfig.json
```

Tests here used Node 20.19.0 to match the installed native SQLite dependency. The local evidence snapshot is `/private/tmp/rafi-build-stall-evidence.json`; it is deliberately outside version control. Key original sources are each project's `.rafi/observability.sqlite3`, `.rafi/recovery.sqlite3`, `.foreman/*.jsonl`, `.foreman/delivery-sessions/*.json`, and the matching rollout files under `/Users/tyler/.codex/sessions/2026/10/07/`. Source line links describe this inspected checkout and may move with other local edits.
