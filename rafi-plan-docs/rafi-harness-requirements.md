# Rafi harness improvement requirements

> Handoff copy packaged 2026-10-10. Place this folder at the Rafi repository root. Source/test links resolve against that repository; historical observations describe the inspected reference snapshot. Read [agent implementation instructions](AGENT-INSTRUCTIONS.md) before execution.

- Date: 2026-10-09
- Status: requirements for agent planning; implementation and rollout are not authorized by this document
- Primary objective: improve Rafi's ability to deliver substantial, correct application work with little avoidable human intervention
- Cost preference: use existing Codex and Claude subscriptions where supported; metered services are optional

Planning documents: [implementation design brief](rafi-harness-implementation-design.md) and [ordered implementation plan](rafi-harness-implementation-plan.md). The plan maps all requirements and regression risks to proposed steps; current implementation evidence remains an implementation-time obligation.

## 1. Purpose and scope

This document preserves the harness investigation and turns its recommendations into requirements a planning agent can use. The intended sequence has five parts:

1. Establish thorough deterministic tests, live evals, independent scoring, and reproducible baselines.
2. Verify existing repairs and improve baseline reliability, context, verification, QA, and operator visibility.
3. Evaluate and selectively integrate practices from major native runtimes and other harnesses.
4. Use the evidence to choose execution granularity, review policy, context strategy, and concurrency.
5. Migrate, release, and maintain the resulting system without weakening its guarantees.

The fifth part makes rollout and continued evaluation explicit. Instrumentation begins in Part 1; it must not wait until all fixes are complete. A reproduced safety defect can receive a narrow repair as soon as its regression exists. Optional optimizations require comparison evidence.

This is a Rafi product requirements document stored in MoneyFarm's `docs/` directory. It does not change MoneyFarm's approved app plan, ticket queue, agent rules, or runtime configuration. The reference clone is an investigation source, not an instruction to modify that copy or deploy its contents. A future implementation plan must identify the actual Rafi development checkout.

### 1.1 Findings to preserve

The strongest direction is a thin Rafi coordinator around capable native coding runtimes. Rafi should own approved intent, dependency eligibility, mutation authority, durable evidence, independent acceptance, and recovery. Native runtimes should handle their supported coding tools, local reasoning loops, and context management. The boundary must be explicit and tested; two layers must not independently recover or redispatch the same work.

Large authorized assignments need durable internal checkpoints. Tickets remain useful for traceability and dependencies, but a ticket does not necessarily need to be one provider turn, one session, or one review boundary. Larger assignments are a hypothesis to test, not a license to bypass acceptance or approval.

Quality comes from observable behavior and calibrated evaluation. Browser verification, realistic environments, clear contracts, small relevant context, and recoverable state are stronger candidates than extra self-check wording or a larger agent count. Source-bound QA evidence establishes what was reviewed; it does not establish that the reviewer caught all defects.

### 1.2 Reference snapshot and evidence limits

The inspected reference is `@rafi-ai/cli` 0.9.20 and `ai-foreman` 1.7.20 at commit `4aa437b3cf19d83d7bb5dc8482bb4b04709c887a`. Its repair documents record substantial completed local fixes and tests. Historical defect descriptions must not be presented as confirmed defects in that newer source.

The preceding research used source inspection and primary-source web research. This document does not claim a fresh Rafi test run, live provider benchmark, native Windows/Linux validation, production migration, or controlled comparison of alternative harnesses. Results quoted below belong to their named sources. Referenced product availability and authentication policies are a dated research snapshot and must be rechecked before integration.

### 1.3 Requirement conventions

- **MUST:** necessary product behavior or evidence. Implement only the missing portion; preserve and verify an existing implementation.
- **EVALUATE:** build a bounded comparison or integration spike. Adoption depends on results and compatibility.
- **CONDITIONAL:** required if the corresponding feature is adopted or the platform is claimed as supported.
- Each numbered requirement has an acceptance condition. A planning agent must add its implementation owner, dependencies, concrete tests, and verification commands.
- “Verified existing” is a valid disposition when backed by current production-path coverage. A filename, historical test log, or checkbox alone is insufficient.
- Numeric performance, confidence, and cost thresholds not specified here must be set from baselines and owner-approved tradeoffs. Do not invent improvement claims.

## 2. Preserved research and design constraints

### 2.1 What external evidence supports

| Finding | Evidence | Planning implication | Limit |
| --- | --- | --- | --- |
| Harness changes can materially improve outcomes with a fixed model | LangChain reported Terminal-Bench 2 improvement from 52.8% to 66.5% using environment context, verification enforcement, and loop detection [S7] | Test environment packets, verification hooks, and stalled-loop handling independently | Vendor-reported benchmark result; not a guarantee for app v1 builds |
| Excess context can add work without adding success | An AGENTS.md study reported reduced success tendencies and over 20% added inference cost for evaluated context configurations [S10] | Minimize irrelevant instructions and measure context changes | Repository issue tasks; not proof that all project rules are harmful |
| Curated skills can help, with large domain variation | SkillsBench reported +16.2 percentage points overall; software gains were smaller, around +4.5 points [S11] | Prefer focused, evaluated skills with correct examples | Some tasks regressed; generated skills did not reliably help on average |
| Smaller harnesses can preserve performance | Deep Agents v0.7 reported roughly 65% reduction in base context without a statistically clear reward change across tested models [S8] | Evaluate instruction/tool reduction by model and task | Particular harness and evals; not a universal prompt-size target |
| More orchestration is sometimes unnecessary with stronger models | Anthropic simplified a long-running app harness as model capability improved, retaining useful evaluation and repair [S3] | Re-evaluate scaffolding on model upgrades | Demonstrations and case studies, not a controlled Rafi comparison |
| Experienced users can misjudge productivity | METR's early-2025 mature-repository study measured 19% slower completion despite perceived speedup [S12] | Measure accepted outcomes and human attention | Older models and familiar repositories; not a prediction for today's greenfield work |
| Durable plans and executable feedback support long runs | OpenAI and Anthropic describe long-horizon work with external state and repeated verification [S1–S3] | Keep restartable state and test actual workflows | Long-run anecdotes do not establish a universally best harness |

Treat long-duration demos, token totals, lines of code, stars, and framework popularity as discovery signals. They are not acceptance metrics. No cited study proves that exactly three self-checks, cross-model review, always-fresh sessions, or maximal parallelism is the best policy for Rafi.

### 2.2 Existing Rafi capabilities worth preserving

| Capability | Required preservation |
| --- | --- |
| Interview and approved structured plans | Keep versioned intent, approval, provenance, dependencies, acceptance, required tests, and delivery scope |
| Plan-to-ticket validation | Keep exact slice coverage, stable references, dependency validation, and explicit retirement rules |
| Dependency-aware queue | Preserve blockers, leases, delivery constraints, and frozen autonomy policy |
| Independent QA | Preserve frozen source, isolated review workspace, source-bound certificate, and finalization guard |
| Session lifecycle and handoffs | Preserve validated identity, lineage, checkpoints, and authoritative ownership |
| Durable supervision | Preserve bounded restart accounting, worker fencing, and reconciliation before replacement |
| State export/import and recovery | Preserve evidence and explicit uncertainty; never convert unavailable historical evidence into permission |

### 2.3 Non-negotiable constraints

1. Approved scope, pending decisions, dependency eligibility, and execution scope must agree before every mutation dispatch.
2. One authoritative writer owns a mutable scope at a time. Parallelism requires explicit isolation or proven nonconflicting ownership.
3. Acknowledgement, execution, completion, acceptance, and publication are different events.
4. A timeout does not prove that external work stopped. Uncertain side effects must be reconciled before replay.
5. Formatting success, a clean process exit, a heartbeat, or a model's `done` claim cannot substitute for accepted completion evidence.
6. Retry and correction budgets survive sessions, wrappers, restarts, and alternate commands.
7. Read-only QA remains read-only. Missing prerequisites are different from failing source behavior.
8. Existing user changes, worktrees, commits, configuration overrides, and immutable evidence must be preserved.
9. Subscription usage has quotas and availability limits. Unknown dollar cost remains unknown; API prices must not be silently applied to subscription tokens.
10. Project security, financial, data, and approval requirements must remain enforceable when prompts are shortened or external tools are used.
11. Builder cannot approve its own work. Findings are resolved through independent acceptance or an explicitly authorized, scoped, audited waiver; neither a dispute nor a retry override is a waiver.
12. Without provider-side idempotency, do not promise exactly-once external execution. Durable intent and conservative reconciliation prevent automatic duplicate dispatch; an unresolved remote outcome remains explicitly uncertain.

## Part 1 — Tests, evals, instrumentation, and baselines

### E01 — Current-state inventory and traceability — MUST

Inventory the implementation checkout, package/provider versions, active changes, configuration, supported platforms, and existing suites. Map every requirement to one disposition: verified existing, incomplete implementation, confirmed defect, proposed experiment, or blocked by missing evidence.

**Acceptance:** a machine-readable or consistently structured coverage ledger links requirement, code surface, test, production caller, result, and remaining limit. Historical investigations remain available. Existing unrelated failures and changes are identified separately.

### E02 — Deterministic provider and event simulation — MUST

Provide reusable Codex/Claude fixtures with scripted RPC replies, tool events, context samples, approvals, streaming, interruptions, and failure outcomes. Control time and event ordering. Include adversarial stale, duplicate, missing, and foreign-session events.

**Acceptance:** ordinary CI requires no provider login or network. Fake clocks exercise long timeouts quickly. Tests run the full adapter wrapper stack and real host callers, not only direct adapter helpers.

Cover fragmented/malformed streams, unsupported or changed event fields, reconnects, duplicate terminal events, cancellation/completion races, and interleaved sessions. Use narrow fault hooks rather than uncontrolled global monkeypatching; restore and serialize unavoidable shared patches. Add seeded event-order permutations and state-machine/property checks for authority, budgets, and terminal-state invariants; retain failing seeds as small deterministic regressions.

### E03 — Durable state and crash testing — MUST

Test SQLite reopen, transaction failure, disk/publication failure, concurrent revisions, process death, lost acknowledgement, and partially published projections. Use disposable repositories and databases. Capture WAL consistently when creating persisted-state fixtures.

**Acceptance:** crash injection covers before dispatch, after send, before completion capture, after authoritative commit, before projection publication, and during adoption/cleanup. Every case proves safe blocking while uncertain and legitimate progress after reconciliation.

Include database busy, full/unwritable disk, failed evidence writes, and real child-process kill/reopen coverage. Evidence objects are durable before committed references; orphaned objects may be recoverable, dangling authoritative references are not. Faults must not destroy previously committed findings, decisions, or receipts.

### E04 — Historical defect regression suites — MUST

Preserve the eight build-stall characterizations and all 26 QA handback diagnostics as desired-behavior coverage. Include the later recovery, wrapper forwarding, migration identity, launch, containment, execution-scope, and repeated-resume findings.

**Acceptance:** the ledger maps the historical scenarios to current assertions and production paths. A passing test that merely reproduces a defect is not treated as a repair. Already-fixed behavior receives regression coverage rather than duplicate implementation.

### E05 — Packaged CLI and launch integration — MUST

Exercise shipped command entry points, including `start`, `resume`, `build:resume`, start-over, supervised/direct/detached modes, ordinary/current-branch/isolated/shared delivery, and QA on/off. Use real argument parsing, launch gates, frozen receipts, and persisted nonempty ticket state.

**Acceptance:** tests assert implementation bytes and exact ticket identity, run lineage, approval binding, outcomes, and dispatch counts. Fixtures derive ticket identity from the actual assignment. Stubbing the decisive command action is insufficient.

Publish a risk-based coverage matrix across provider, role, delivery mode, QA setting, launch/recovery command, and fresh/compact strategy. Cover every production boundary and known dangerous interaction; do not require an unmanageable full Cartesian product. Include PTY, redirected/noninteractive output, Ctrl-C, and detached reattachment cases.

### E06 — Representative work benchmark corpus — MUST

Build versioned tasks covering greenfield foundations, a complete vertical slice, existing-code bug fixes, database migration, auth/permissions, UI states and accessibility, cross-module contracts, multi-context work, and dependency-aware multi-ticket completion.

**Acceptance:** every fixture has a starting snapshot, explicit input, acceptance rubric, independent oracle, environment definition, limits, and expected artifacts. Include both easy controls and tasks beyond a short single-turn edit. MoneyFarm can inspire cases, but evaluators must not mutate its active state.

### E07 — Recovery and hostile-environment corpus — MUST

Include unavailable registry/network, missing executable, dependency failure, unavailable database/container, wrong permissions, prompt injection in repository/tool content, pending decisions, quota exhaustion, corrupt/missing tracker state, stalled initialization, long healthy tools, and interrupted writes.

**Acceptance:** cases specify expected outcome and recovery requirement. Passing means accurate diagnosis, bounded behavior, preserved scope, and eventual safe continuation where possible; refusing everything is not sufficient.

Include healthy long-running positive controls, output floods, abandoned event subscriptions, and repeated start/cancel/resume cycles. Check bounded memory, queues, artifact growth, and process/file-descriptor cleanup against recorded limits. Stress tests must distinguish permitted retained evidence from leaked temporary resources.

### E08 — Independent completion scoring — MUST

Score artifacts and observed behavior independently of the builder's report. Maintain held-out acceptance checks outside the builder's mutation authority. Validate business/API contracts, negative cases, permissions, and complete user flows where relevant.

**Acceptance:** deleting tests, weakening assertions, writing a convincing summary, or reporting nonexistent execution cannot increase accepted completion. Record partial completion and severity-weighted defects alongside aggregate success.

Validate each oracle against known-good and seeded-bad artifacts. Distinguish flaky checks and evaluator failures from product failures; retain every rerun and its reason rather than rerunning until green. Control seeds, dependency/runtime versions, time, and external-service fixtures where practical. Model-judged criteria require a calibrated rubric and adjudication path, not agreement or self-confidence alone.

### E09 — QA calibration dataset — MUST

Create correct solutions, seeded defects, false-alarm traps, incomplete evidence, legitimate disputes, environment blockers, and ambiguous outcomes. Include full input/output examples for reviewers and correction workflows; keep calibration and held-out evaluation sets separate.

**Acceptance:** measure missed defects, false findings, severity accuracy, actionable location/evidence, blocker classification, and correction convergence. Critical auth/data/integrity defects must have explicit promotion gates. Correct examples are curated and versioned with their rubric.

Include red-to-green repair fixtures: a meaningful check fails on defective source, the repair makes that same check pass, and related regression checks stay green. Negative controls cover already-green checks, unrelated environment failures, weakened/deleted assertions, fabricated output, stale evidence, and a fix that passes the target check while breaking a neighboring contract. The harness must distinguish each from a verified repair.

### E10 — Browser and real-user-flow evals — MUST

Include browser-capable verification for UI work: navigation, persistence after reload, forms and validation, keyboard access, error/loading/empty states, and role-specific permissions. Use screenshots when appearance matters and behavioral assertions when function matters.

**Acceptance:** a rendered screenshot alone does not pass a functional flow. Save appropriate console/network errors and failure artifacts. Tests distinguish product failure from browser/environment inability to run.

### E11 — Structured run telemetry — MUST

Record correlated run, assignment, ticket, role, session, operation, turn, source revision, review occurrence, and policy identities. Capture phase transitions, dispatch certainty, tool execution, evidence, approval, retries, corrections, compaction, transfers, and supervision.

**Acceptance:** a normal trace explains the last accepted progress, current wait, next action, and owner without transcript archaeology. Prompts and sensitive outputs use protected references and redaction rather than default raw logging.

### E12 — Timing, attention, and cost accounting — MUST

Measure time to first implementation, time to independently accepted completion, human active attention, required interventions, non-overlapping phase durations, and idle/unknown gaps. Record available tokens, cached usage, retries, latency, and provider quota outcomes.

**Acceptance:** wall time, active work, and human wait are distinguishable. Nested spans do not inflate totals. Subscription cost is reported honestly; missing provider counters and uncertain gaps remain missing/unknown.

### E13 — Prompt and tool overhead measurement — MUST

Measure actual rendered context per role/turn: system rules, task packet, history, examples, tool schemas, retrieved material, and repeated instructions. Track which component was loaded rather than estimating every turn from on-disk file size.

**Acceptance:** reports support model- and task-specific attribution. The inspected 4,577-word AGENTS.md, 3,285-word builder artifact, and 1,155-word QA artifact are snapshot sizes, not proof that their sum was injected on each turn.

### E14 — Fair experiment runner — MUST

Run baseline and candidate configurations against equivalent starting states, permissions, tools, models, effort, environments, and budgets. Randomize/interleave order where practical; record unavoidable provider/version changes. Preserve all failures, cancellations, and quota exits.

**Acceptance:** reports show task-level paired results, sample counts, dispersion, and uncertainty. Begin with at least five runs per representative live scenario as a canary, then choose sample size from variance and decision importance. Five runs do not establish reliable tail latency or a small improvement.

### E15 — Baseline and ablation matrix — MUST

Compare at minimum: native runtime with the same approved intent; current Rafi; Rafi with slimmer context; milestone-sized execution; browser-backed QA; and one selected external practice. Isolate individual changes before testing useful combinations.

**Acceptance:** publish outcome, attention, correctness, recovery, overhead, and usage together. An apparent speedup that weakens review, changes scope, grants extra permissions, or excludes failures is rejected.

### E16 — Live-provider safety and quota control — MUST

Keep authenticated evals explicitly opt-in, disposable, bounded, and pausable. Prefer supported subscription-backed native CLI use. Set task/run limits and concurrency; detect quota/credential issues without futile retry loops. API-backed runs require an explicit budget and approved credential path.

**Acceptance:** deterministic coverage remains usable when live quota is unavailable. No eval starts or resumes a production build, modifies MoneyFarm's active state, or stores credentials in fixtures.

### E17 — CI, reproducibility, and regression reporting — MUST

Separate fast deterministic checks, packaged integration, native platform checks, and opt-in live comparisons. Version fixture/rubric/prompt/config inputs; provide repeatable scripts and diff-friendly reports with links to artifacts.

**Acceptance:** changed protocol/recovery behavior runs applicable deterministic gates; changed model/prompt/skill policy runs applicable evals. Reports distinguish pass, fail, skipped, not run, and historical evidence. Native platform sign-off requires actual native execution.

### E18 — Extend existing Rafi test infrastructure — MUST

Reuse or adapt `live-build-stalls.ts`, live create/interview/ticket-plan/provider scripts, audit scripts, existing disposable app fixtures, and investigation test suites before creating a second framework.

**Acceptance:** identify gaps rather than replacing working infrastructure wholesale. One documented command family produces consistent artifacts. The simple sum-task stall canary is retained as a control but does not stand in for a complete app benchmark.

## Part 2 — Baseline reliability and quality improvements

The historical repair requirements below are preservation and current-validation obligations. The reference documents record many as implemented. Their inclusion must not turn historical findings into an invented current backlog.

### B01 — Correct context and usage accounting — MUST

Separate current context occupancy, cumulative consumption, and whole-host-turn usage. Use authoritative current samples with session/window/revision/time. For the inspected Codex event shape, `last.totalTokens` represents current occupancy and `total` cumulative consumption. Handle resets, cached tokens, duplicate events, model changes, and unknown fields.

**Acceptance:** historical 3,555,538 cumulative / 111,524 current / 258,400 window yields about 43.16% occupancy; after current usage falls to 23,635 it yields about 9.15% without resetting lifetime usage. Foreign/stale samples are rejected; unknown occupancy never becomes zero or lifetime totals.

### B02 — Avoid unnecessary compaction — MUST

Ordinary boundaries consult the effective threshold policy. Preserve explicit manual compaction and intentionally fresh boundaries. Deduplicate manual/native events, retain limits and hysteresis, and identify bootstrap instructions that exceed capacity.

**Acceptance:** known 10% occupancy under a 65% threshold produces no ordinary compaction. Threshold crossing produces one owned operation. Capacity failure produces a useful diagnostic instead of a compact/handoff loop.

### B03 — Correlated compaction lifecycle — MUST

Represent request, acknowledgement, completion, fresh usage, cancellation, and unresolved state separately. Observe before dispatch; correlate or serialize where IDs are unavailable. Register a bounded deadline before startup/RPC and reconcile late events before fallback.

**Acceptance:** recorded 27/39/48/50/53-second durations and a 90-second control do not produce false failure under the evaluated policy. Missing usage is unresolved measurement, not assumed failure. No successor mutation overlaps unresolved predecessor work. Current 120-second/180-second policies are tuning inputs, not universal guarantees.

### B04 — Safe handoff generations and acceptance — MUST

Allocate successors above validated predecessor and run high-water marks. Validate role/provider/worktree/settings/lineage/owner before acceptance changes authority. Prepare acceptance without implementation authority, then durably commit and adopt.

**Acceptance:** a generation-2 predecessor continued in a new run gets generation 3 or greater. Invalid acceptance leaves the old owner intact. No database transaction remains open across a provider await.

Canonicalize project/worktree identity using the existing path policy. Test legitimate symlink aliases, inaccessible paths, timestamp-only identity refresh, and unexplained identity changes; neither raw path-string equality nor stale metadata establishes authority.

### B05 — Accepted work must dispatch or explain its pause — MUST

Journal the frozen next action and distinguish accepted, adopted, dispatch intended, sent, and completed. Reconcile crashes at each transition. Retire the predecessor with bounded cleanup and fence late events.

**Acceptance:** accepted-but-idle successors become a precise recoverable state. Known unsent authorized work can continue once; unknown sends are reconciled before replay. An acceptance receipt never masquerades as implementation progress.

### B06 — Authoritative resume and start-over state — MUST

Use one authoritative owner/session binding with revisioned DB/file/status projections. Reject terminal/superseded owners and stale pointers. Publish every QA-driven Builder transfer to all recovery indexes. Start-over retires old ownership according to the selected operation while preserving source.

**Acceptance:** a crash after QA transfer resumes the accepted successor; old JSON, JSONL fallback, or existing worktree cannot resurrect superseded authority. Projection failure is reconciled, not treated as a separate truth.

### B07 — Approved scope starts without redundant approval — MUST

Reuse valid approval when intent, execution scope, and material consequences are unchanged. Ask through the existing durable flow when behavior, cost, security, data, APIs, delivery scope, or other material terms change. Recheck approval before every selected ticket's dispatch.

**Acceptance:** unchanged approved work starts under ordinary `--steps` use. A later ticket or between-turn material edit cannot inherit stale approval. `--yes` and legacy behavior do not manufacture authority beyond their established contract.

### B08 — Durable visible questions and waits — MUST

Persist decisions before prompting. Show question, scope, age, waiting owner, and continuation path in terminal/status/manager views. Preserve answers and supersession history; route attention reliably under streaming activity and redirected I/O.

**Acceptance:** restart cannot lose a question or consume an answer twice. Resume alone never answers a question. A stale answer receives a usable, scope-bound replacement decision rather than silently authorizing work or permanently blocking it.

### B09 — Continue eligible independent work — MUST

Defer blocked tickets and their dependents; continue authorized independent tickets when the effective frozen policy allows. Distinguish ticket, delivery-unit, and run-wide blockers. Check shared-worktree compatibility.

**Acceptance:** with A blocked, B depending on A, and C independent, C can complete while A remains visible and B remains deferred. A global permission/integrity/ownership issue blocks all affected work. Existing configuration overrides remain intact.

### B10 — Preserve execution truth across repair — MUST

Validate provider failure, dispatch certainty, identity, and terminal outcome before parsing success or requesting format correction. Preserve initial and corrected evidence. One validated completion path processes original handoff/checkpoint intent exactly once.

**Acceptance:** an errored implementation followed by clean `done` formatting completes zero steps, including QA-off mode. A continuity repair cannot drop an original valid handoff or invent a new one from correction text.

### B11 — Shared durable retry and remediation budgets — MUST

Reserve attempts before dispatch and account by logical operation across wrappers, roles, sessions, commands, and restarts. Keep protocol correction distinct from substantive remediation and supervisor recovery. Uncertain sends retain reservations pending reconciliation.

**Acceptance:** renaming a blocker, changing a session, or restarting cannot replenish the same allowance. Human waits do not spend provider retry budget. Exhaustion leaves actionable state, not an endless loop.

Test limits 0/1/N, competing reservations, legacy operation deduplication, proven unsent preparation failure, and consumed scoped operator overrides. The final independent QA recheck after the last authorized fix remains permitted; a remediation limit must not prevent deciding whether that fix succeeded.

### B12 — Stop unchanged blockers — MUST

Fingerprint meaningful environment/permission/source/evidence causes. A structured unchanged blocker defers promptly. Permit at most one bounded explanation for an uninformative blocker, then stop. Reopen only after relevant evidence changes or explicit scoped retry authorization.

**Acceptance:** changed wording or arbitrary file churn cannot reset progress. Genuine no-code disputes and new evidence remain valid progress. An unchanged registry blocker is not sent through repeated full QA/remediation cycles.

### B13 — Bound every execution phase — MUST

Cover initialize, thread/session prepare, settings/context RPCs, acknowledgement, execution, compaction, drain, interrupt, and close with enclosing deadlines and cancellation. Distinguish inactivity, hard deadline, and useful-progress age; propagate remaining time rather than resetting it in nested retries.

**Acceptance:** alive-but-silent startup, generic status spam, failed shutdown, and missing acknowledgement are bounded. Healthy declared long tools and intentional human waits retain their distinct handling. Every await has a deadline, documented enclosing bound, or durable intentional wait.

Cancellation is durable, idempotent, and propagated through wrappers and owned tools. Once recorded, it blocks new mutation dispatch; late results remain attached to their original operation and may support reconciliation without silently resuming the run. Ctrl-C, repeated cancel, and cancel/terminal races preserve evidence and report whether remote work is confirmed stopped or still uncertain.

### B14 — Readiness checks reflect actual capabilities — MUST

Derive bounded nonmutating checks from required verification. Scope reusable results to executable/version/model/config/environment/confinement and invalidate on relevant change. Host Docker/DNS availability cannot establish provider permission to use them.

**Acceptance:** missing tooling becomes an actionable prerequisite outcome. Readiness success, provider terminal result, process exit, and verified cleanup are separately evidenced. `OK` output with a hanging child is not readiness completion.

### B15 — Safe process ownership and cleanup — MUST

Use canonical project, run, original owner incarnation, PID/start identity, generation, and containment evidence. Persist probe intent and register trusted launch helpers before provider execution. Share cleanup across success/error/cancel/crash/recovery; inspect escaped owned descendants within the documented containment contract.

**Acceptance:** zero replay while a supported owned descendant may still execute; verified cleanup permits legitimate continuation. PID reuse, absent IPC, lost registration, live Windows Job creator, unavailable inventory, and concurrent cleanup are covered. Tags are attribution, not universal adversarial containment.

### B16 — Real supervision with safe replacement — MUST

Use durable supervisor/worker leases and generations in actual CLI paths. Detect dead/hung workers independently of their event loop. Fence stale workers, verify owned tools are quiescent, reconcile remote effects, and apply frozen restart budgets/backoff.

**Acceptance:** child-process kill/hang, parent death, two simultaneous starts, cancellation, and exhausted budgets yield one legitimate writer. Heartbeats do not imply progress. Pending ticket decisions permit independent work where safe; unsupervised mode reports itself honestly.

### B17 — Exact recovery scope and actual remaining progress — MUST

Separate saved context from invocation execution tickets. Bare resume may use saved authorized scope; explicit ticket selection and QA-only recovery use their subset. Reconcile all saved-scope tickets with durable tracker, pending QA/questions, and unresolved dispatch, irrespective of ordering or current-ticket pointer.

**Acceptance:** a later done ticket cannot hide an earlier blocked one. Missing/corrupt tracker evidence stays unfinished and inspectable without changing its bytes. Pending QA takes precedence. Explicit blocked T001 does not run eligible T002; later bare resume can continue eligible scope.

### B18 — Assignment and completion identity — MUST

Every ticketed Builder instruction, continuation, question answer, correction, and handoff states the selected ticket/assignment and completion contract. Validate returned identity before QA or ticket completion. Fresh owner validation is response-only, scoped, and cannot bypass admission or uncertain-dispatch fences.

**Acceptance:** missing/wrong ticket markers cannot finalize or trigger replay merely to fix ambiguity. Invalid fresh-session validation preserves the old owner and closes the unused replacement. Repeated resumptions keep correct scope, policy, and budgets.

### B19 — QA report identity and evidence journals — MUST

Separate content digest, review occurrence, remediation operation, and provider turn. Bind reports/receipts to run/ticket/review/source/generation/session. Journal each send and preserve original/correction responses and storage failures.

**Acceptance:** identical report content on different reviews remains independent. Foreign or superseded review/remediation identity dispatches zero work. Partial write recovery restores consistent outcomes without redispatch or evidence mixing.

Same-occurrence/same-content replay is idempotent; same-occurrence/conflicting-content replay is a consistency error. Atomically reserve intent/budget and commit local outcomes with revision checks, without holding transactions across capture or provider waits. Digest/byte/session/turn pairs round-trip to their exact evidence; unavailable provider-transformed prompts stay unavailable rather than being replaced with host-prompt claims.

### B20 — Enforce response-only corrections — MUST

Provide exact parser errors and the actual response contract to the one permitted QA format correction. Enforce no-tools using supported capabilities, event observation, terminal/drain barrier, and source checks. Forward policy/observation through every production wrapper.

**Acceptance:** tool use, missing observation, source change, provider failure, or identity drift rejects acceptance. Correction does not repeat implementation. A syntactically invalid result remains invalid with its correct turn evidence.

Fan out observations through the existing event-stream owner; competing iterators must not steal terminal/tool events. Test read-only tools, reverted edits, subevents near terminal completion, replaced adapters, subscriber cleanup, and event starvation. Continuity-only and envelope repair share the one handback response-repair allowance; separate hidden wrapper loops cannot multiply it. Normal non-handback continuity remains compatible.

### B21 — Typed outcomes and partial remediation — MUST

Represent passed, failed, blocked environment, needs input, legitimate dispute, partial remediation, cancelled, and uncertain outcomes without overloading `ok`. Preserve findings and each disposition.

**Acceptance:** environment limitation is neither fixed source nor a QA pass. Every required check can be recorded as passed/failed/not run with reason. A valid dispute can cause a targeted independent recheck but cannot waive acceptance.

Keep issue fingerprints for loop detection separate from authoritative finding IDs. Each finding retains fixed/disputed/unresolved disposition and supporting evidence; a fingerprint match cannot resolve another review's finding. Waivers require the existing explicit scope, authority, reason, and audit trail and remain distinct from claimed fixes.

### B22 — Source-bound isolated QA — MUST

Keep frozen staged/unstaged/untracked source capture, confined disposable review, appropriate scratch/dependency projection, mutation detection, and certificate/finalization binding. Invalidate review when its authoritative basis changes.

**Acceptance:** reviewer edits cannot silently enter accepted source. Reused sessions cannot cross incompatible snapshot identities. Generated tracker publication after review is accounted for explicitly rather than misrepresented as reviewed app behavior.

### B23 — Bounded nonrecursive history — MUST

Render complete current requirements/findings once and bounded typed prior summaries with retrievable evidence references. Do not embed previous full packets, handoffs, reports, and correction transcripts recursively. Budget by actual model context.

**Acceptance:** repeated fixed-issue cycles do not create unbounded prompt growth. Clipping never drops mandatory current findings silently. If mandatory material cannot fit, report capacity failure or use validated retrieval instead of looping.

### B24 — One truthful state projection — MUST

Project authoritative preparing/implementing/verifying/compacting/transferring/waiting/blocked/reconciling/completed/failed state to terminal, run record, status, and manager. Show phase age, last accepted progress, scope, branch/worktree, next action, and uncertainty.

**Acceptance:** returned `{ok:false}` is a failed outcome even when a promise resolves. Accepted versus sent work is visible. A manager can diagnose ordinary stalls without raw transcripts or falsely claiming the main checkout has no work when a worktree does.

### B25 — Small relevant execution packets — MUST

Compile task-specific intent, constraints, affected contracts, acceptance commands, environment, and evidence references. Keep canonical policies once; retrieve detailed docs/skills when needed. Measure persistent instruction semantics across resume/compaction before deduplicating them.

**Acceptance:** slimming preserves required security/data/business rules and approved provenance. No prompt experiment silently edits MoneyFarm's canonical rules. Packet tests verify mandatory content and scope while E13/E15 establish actual quality/overhead.

### B26 — Explicit runtime/coordinator ownership — MUST

Document who owns tools, native compaction, thread/session lifecycle, approvals, retries, dispatch journals, and cancellation for each adapter. Prefer runtime-native mechanisms where reliable, while retaining Rafi's authority/evidence guarantees.

**Acceptance:** no overlapping automatic replay or competing compaction policies. Unsupported capabilities are explicit. Wrapper composition preserves events, identity, cancellation, deadlines, policy, and accounting.

### B27 — Acceptance criteria become verification contracts — MUST

Associate each criterion with check type, command/scenario, expected result, evidence, prerequisites, and reviewer responsibility. Include negative and user-facing states. Keep independent acceptance checks distinct from builder-authored convenience tests.

**Acceptance:** the planner can identify unverified criteria before execution. A precompletion gate requires source-bound executed evidence for every mandatory check. A blocked/not-run outcome is recorded and keeps the affected criterion incomplete; only the existing explicitly authorized waiver path can permit an exception. Merely saying tests were run or producing files cannot complete the assignment.

Before execution, discover the project's actual verification commands and relevant prerequisites. After a change, run targeted behavioral checks, then the applicable typecheck/lint/build/integration/browser gates. Feed concrete failure output into bounded correction and rerun affected checks against the changed source. A previously green result is invalidated when its source, test, command, or relevant environment basis changes; wider verification follows the impact, not just the edited filename.

### B28 — Observable red-to-green validation and practical TDD — MUST

Use test-first development where practical, record meaningful failing/passing checks, and protect important acceptance tests. Distinguish prompt instructions to use TDD from observed red/green evidence; use documented exceptions for impractical cases.

**Acceptance:** tests target behavior, contracts, permissions, and failure modes rather than mirroring implementation. No reward for artificial failing tests or test deletion. Do not claim independently enforced TDD based on builder wording alone.

For an applicable bug fix or test-first feature, capture the actual sequence: define the expected behavior; run the relevant check before implementation and observe a failure attributable to that missing/incorrect behavior; implement the change; rerun the same check and observe success; run related regression checks. Record command/check identity, test definition or digest, source revision/digest, execution order, exit/result, and diagnostic evidence through the harness's execution observer. Builder-written summaries are supplementary evidence.

If a behavioral test definition changes between red and green, record why and re-establish that the final test detects the original defect using disposable pre-fix source where practical. A missing tool, infrastructure outage, unrelated compilation error, deliberately false assertion, or assertion deletion is not the required behavioral red. Already-green validation is useful verification but is not a demonstrated red-to-green repair. Where TDD is impractical, preserve the reason and require appropriate post-change independent checks; do not fabricate a red phase.

### B29 — Calibrated actionable QA — MUST

Require specific failure evidence, affected criterion, severity, and location/reproduction where applicable. Calibrate against E09. Preserve independent judgment by avoiding unnecessary anchoring on the builder's confidence or proposed verdict.

**Acceptance:** review accuracy and false blocker rate are visible. Self-reported confidence is not an acceptance score. Reviewer inability to run a check remains visible, and no critical gap is hidden by a polished report.

### B30 — Policy configuration and instruction hygiene — MUST

Centralize effective frozen settings with documented defaults/overrides. Make self-check counts, example injection, review cadence, context strategy, and other experimental policies configurable where adopted. Provide versioned correct examples and precise structured response contracts.

**Acceptance:** changing a prompt/policy produces a reproducible version and runs applicable evals. Exactly three generic self-checks is treated as an existing rule to evaluate, not a proven booster; changing canonical defaults requires an explicit plan/decision. Distinct tests or evidence checks are evaluated as alternatives.

Reject invalid or contradictory effective settings before provider work and expose their origin/precedence. Decide which setting changes apply only to a future run and which require explicit scoped reauthorization; restarting must not silently replace the current run's frozen policy.

### B31 — Supported launch and recovery modes — MUST

Share syntax normalization and semantic authorization across ordinary start, preparation successor, established recovery, supervisor worker, detached launch, and both short resume aliases. Separate launch capability from ordinary execution options and prevent inherited outer tokens from replacing child authority.

**Acceptance:** malformed/conflicting modes fail before provider work. Registered-child/run/role/project/digest checks remain intact. Successful recovery uses the original established run, exact pending ticket/QA state, and remaining authorized step count.

### B32 — Fail safely without permanent dead ends — MUST

Provide restricted reconciliation for readiness cleanup, stale projections, incomplete publication, obsolete answers, and accepted-but-idle state. Keep storage upgrade separate from unrelated provider uncertainty. Recovery tools may repair evidence within their authority without acquiring mutation permission from the current owner.

**Acceptance:** every recoverable safety block has a documented action and a positive continuation test. Legacy missing provenance is not fabricated. Neither blind replay nor permanent refusal is accepted as the complete recovery design.

## Part 3 — Selective integration of external practices

Every item below is an evaluation requirement, not automatic dependency adoption. Favor importing a small practice or adapter capability over stacking complete planners, state stores, approval systems, and recovery loops. Recheck current documentation, authentication terms, licensing, availability, and costs before building.

Screen all candidates for fit and record a disposition; deeply trial only the highest-value subset first. Native-runtime comparisons and verification tooling take priority over additional planning frameworks. A documented incompatibility, redundant capability, or unfavorable maintenance/authentication tradeoff can justify deferral without implementing an adapter merely to reject it.

### H01 — Native Codex execution baseline and adapter choices — EVALUATE

Compare the current app-server adapter with native execution supplied the same approved packet. Assess `codex exec` structured output/event streaming, the SDK's thread execution/resumption, and app-server's richer persistent events/approval integration [S4–S6].

**Acceptance:** select by needed capability and measured overhead. Retaining app-server is valid. A replacement must pass identity, cancellation, approval, uncertainty, context, resume, and usage conformance; simplicity cannot justify losing these guarantees.

### H02 — Claude native workflows and supported authentication — EVALUATE

Assess native Claude Code execution and dynamic workflows for isolated review, fan-out/synthesis, or milestone execution. Compare against Rafi's current SDK adapter and identify where native orchestration could replace duplicate host logic [S13–S15].

**Acceptance:** document personal local CLI, subscription-backed native workflow, and distributed SDK product authentication separately. Do not assume a user's subscription authorizes all third-party SDK usage. Use supported credentials and cost controls; recheck terms before release.

### H03 — Superpowers practices — EVALUATE

Trial focused planning, debugging, test-first, and review skills from Superpowers, including its native execution alternative to heavier subagent development [S16]. Do not add another mandatory product-planning pass after valid Rafi approval.

**Acceptance:** compare selected skills against the same tasks without them; record context and attention overhead. Reviewer output has concrete evidence. Reconcile instructions with Rafi scope, permissions, and no-unsolicited-commit rules.

### H04 — GSD phase and fresh-context practices — EVALUATE

Use the current Open GSD/GSD Core project as the reference, not an inactive former repository. Evaluate durable phase state, targeted discovery, focused context packets, dependency waves, and verification [S17].

**Acceptance:** one system owns approved intent and completion. A bridge preserves Rafi IDs/provenance and imports useful outputs without running competing planners or duplicating state. Fresh-context benefit is measured against resume/compaction alternatives.

### H05 — Ralph-style bounded continuation — EVALUATE

Evaluate the simple durable backlog/progress plus repeat-until-acceptance loop [S18]. Use Rafi's external completion evidence, ownership, and retry accounting rather than model-reported done flags alone.

**Acceptance:** iteration caps, quota stops, unchanged-blocker detection, and uncertain-dispatch handling work. Do not import automatic commit behavior or permission-bypass defaults into projects that prohibit them.

### H06 — Pi and OpenCode adapter experiments — EVALUATE

Assess Pi's minimal runtime/SDK/RPC/extensibility and OpenCode's server/typed-client integration as future adapter options [S19–S20]. Build only the minimum capability prototype needed to compare one representative task and recovery flow.

**Acceptance:** produce an adapter conformance matrix and maintenance estimate. Supported subscriptions/login paths are verified, not assumed. Add an adapter only if it offers a demonstrated capability, reliability, cost, or user-demand benefit.

### H07 — Deep Agents harness engineering — EVALUATE

Evaluate environment injection, precompletion verification, repeated-loop detection, trace-guided fixes, selective tools, and model-family-specific profiles [S7–S9]. Apply one at a time before combining.

**Acceptance:** every middleware mechanism has an observed failure it addresses and measured overhead. Forced extra reflection is not counted as verification. Model-specific gains are not generalized to all providers without evidence.

### H08 — OpenSpec and Spec Kit interoperability — EVALUATE

Assess change proposals, spec/design/task artifacts, brownfield delta handling, and links from approved intent to implementation [S21–S22]. Prefer import/export or mapping over replacing Rafi's structured plan.

**Acceptance:** resolve identities, revision, approvals, dependencies, supersession, and conflicts deterministically. An imported artifact cannot silently widen scope or imply user approval. Preserve a single execution source of truth.

### H09 — BMAD planning and perspective coverage — EVALUATE

Evaluate rightsized product/architecture/UX/testing perspectives for complex app plans and missing-acceptance discovery [S23]. Use additional roles when their output addresses a demonstrated gap.

**Acceptance:** report added findings, rework avoided, planning delay, and duplicated prose. Small tasks must remain small. Automatic whole-epic execution cannot bypass Rafi's authority/evidence gates.

### H10 — Factory and hosted/headless execution — EVALUATE

Assess headless structured execution, worktree/session handling, missions, and permission modes as a capability reference or optional paid adapter [S24]. Treat hosted execution as a separate operational/cost decision.

**Acceptance:** compare benefits against native subscriptions first. Record external data exposure, credential path, limits, total operating cost, and approval boundaries. No hosted service is introduced by default.

### H11 — Playwright CLI/skills versus MCP — EVALUATE

Compare browser tooling through task-focused CLI/skills with persistent Playwright MCP for relevant UI tasks [S25]. Measure schemas/context, interaction reliability, debugging artifacts, and workflow fit.

**Acceptance:** preserve E10 browser coverage whichever interface wins. CLI is not assumed universally better; MCP remains appropriate where persistent state or interactive integration provides value.

### H12 — Long-running native-agent practices — EVALUATE

Evaluate initializer/environment scripts, living execution plans, a durable verified feature ledger, and native runtime checkpoints from OpenAI and Anthropic guidance [S1–S3]. Keep progress files as projections of trustworthy state where Rafi already has a database.

**Acceptance:** a fresh session reconstructs intent, last verified progress, pending decisions, and exact next work without rereading the entire transcript. Native reasoning state and Rafi durable authority do not compete.

### H13 — Parallel planner/worker patterns — EVALUATE

Use Cursor's large-agent experiments as design references for contract partitioning, specialized context, and synthesis [S26–S27]. Start with a small number of independent assignments, not a swarm or custom version-control system.

**Acceptance:** owned files/modules/worktrees and shared contract changes are explicit. Measure accepted throughput and integration defects. A reconciler must detect semantic inconsistency, not just text merge conflicts.

### H14 — External integration contracts — CONDITIONAL

For any adopted tool, define packet input, structured result, event/progress mapping, permissions, cancellation, recovery, evidence capture, version compatibility, and licensing. Treat repository/tool outputs as untrusted data.

**Acceptance:** external `done` cannot finalize Rafi work without Rafi acceptance. One authoritative ledger covers each logical dispatch. Missing conformance fails clearly or selects an explicitly supported fallback.

## Part 4 — Improvements selected from measured findings

### F01 — Decision records for every promoted policy — MUST

Each experiment states hypothesis, tasks, baseline, changed variable, budgets, acceptance/safety gates, and stop criteria before running. Record outcomes including negative results, then choose adopt/revise/reject/defer.

**Acceptance:** every production optimization links to reproducible evidence and an ADR where consequential. No framework is selected solely because it is popular or a demo lasted many hours.

### F02 — Milestone-sized assignments — EVALUATE

Compare one-ticket/one-turn execution with a bounded coherent milestone containing several traceable tickets and internal verification checkpoints. Define permissible dependency order, maximum scope, escalation rules, and completion evidence per ticket.

**Acceptance:** a failed milestone cannot falsely mark all tickets done. Approved scope stays fixed; completed subwork is resumable. Preserve public `--steps` semantics or explicitly version/document any change. Promote only if accepted throughput/attention improves without material correctness/recovery regression.

### F03 — Adaptive checkpoint and review cadence — EVALUATE

Compare every-ticket review, milestone-end full QA with lightweight internal checks, and risk-triggered review. Use consequence, source change, prior failures, and verification strength as inputs.

**Acceptance:** auth, financial/data integrity, migrations, permissions, and uncertain evidence retain appropriate gates. Review policy is frozen/explainable per run. Reduced QA time does not count as improvement when defect escape rises beyond agreed bounds.

### F04 — Evidence-driven context continuity — EVALUATE

Compare persistent native sessions, threshold compaction, fresh sessions, and milestone handoffs by task/model. Evaluate prompt reduction and retrieval separately from session strategy.

**Acceptance:** measure repeated exploration, lost constraints, first-work delay, transfers, correctness, and recovery. A model upgrade triggers re-evaluation; always-fresh or always-compact is not an unexamined default.

### F05 — Model and reviewer routing — EVALUATE

Compare available subscription models/effort for planning, implementation, review, and correction. Include same-model and cross-model QA. Use calibrated reviewers and task-specific evidence, not intuition about independence.

**Acceptance:** quality, attention, usage/quota, and latency inform the choice. Costly fallback is opt-in. Cross-model agreement or confidence alone never establishes correctness.

### F06 — Selective parallel execution — EVALUATE

Start with independent discovery or isolated implementation modules. Bound fan-out, concurrency, shared dependencies, and review capacity. Freeze interfaces before parallel work that consumes them; reconcile contract drift.

**Acceptance:** no duplicate writer or unauthorized shared-file changes. Worktree startup/merge/review overhead and semantic defects are included in results. Increase concurrency only while accepted throughput benefits survive full integration.

### F07 — Targeted review and verification reuse — EVALUATE

Assess incremental checks and review reuse using source/contract/environment identities, affected dependencies, and known check coverage. Keep full review where impact cannot be bounded.

**Acceptance:** no cache hit across incompatible source, settings, approvals, prerequisites, or test semantics. Full rechecks remain available. Seeded cross-module regressions expose unsafe narrowing before promotion.

### F08 — Focused examples, skills, and self-check policies — EVALUATE

Compare curated few-shot examples, targeted domain/debugging skills, distinct evidence checks, and generic repeated self-check instructions. Control instruction size and leakage from eval examples.

**Acceptance:** useful examples/skills improve held-out results or reduce attention without quality loss. Version prompt/example selection and allow toggles. Negative examples are included where helpful; generic model-generated advice is not assumed to be a booster.

### F09 — Convergence-aware execution controls — MUST

Define meaningful progress as accepted criteria, verified behavior, relevant evidence, resolved dependency/decision, or safely reconciled state. Detect repetition and plateaus using traces without mistaking healthy exploration for failure.

**Acceptance:** stalls lead to a bounded diagnostic, alternate approach, or explicit pause. Lines changed, token volume, heartbeat text, and arbitrary file churn are not standalone progress scores. Controls pass healthy long-task positive cases.

Expose meaningful validation transitions such as an independently observed failing criterion becoming passing on changed source, with related checks still passing. Preserve the last verified checkpoint and unresolved criteria through handoff/restart. A green checkpoint describes its checked scope; it does not imply that the whole application is complete or authorize destructive source rollback.

### F10 — Reduce avoidable human attention — EVALUATE

Use scoped approval reuse, precise questions, clear status, and safe independent continuation to reduce interventions. Compare attention spent reviewing results, recovering failures, answering questions, and reconstructing intent.

**Acceptance:** reduced interruptions do not hide unresolved decisions or lower transparency. Necessary product/security/cost choices remain visible. Report attention separately from elapsed time.

### F11 — Capability-aware defaults and rollback — MUST

Promote successful policies per model/task/risk where appropriate. Keep compatibility profiles and fallback behavior for missing capabilities, model changes, quota constraints, and regressions. Defaults have an evidence/version identity.

**Acceptance:** a runtime/model change cannot silently inherit unvalidated context, tool, or review assumptions. Each optimization can be disabled without losing authoritative state or accepted work.

### F12 — Negative results and complexity removal — MUST

Remove or avoid scaffolding that does not improve required outcomes: redundant planning, duplicate task state, repeated full-history injection, low-value reviewers, unnecessary tool schemas, and unused recovery layers.

**Acceptance:** retain a decision record of what was removed and why. Simplification still passes safety and behavior conformance. Additional abstraction/tooling must address a real measured need or explicit supported feature.

## Part 5 — Compatibility, rollout, and continued learning

### R01 — Coordinated schema and protocol compatibility — MUST

Inventory persisted changes and publish compatible spec/runtime/CLI contracts. Support old readers where feasible; prevent incompatible writers. Preserve immutable receipts, generations, source digests, findings, and decisions.

**Acceptance:** legacy/ambiguous records remain explicit rather than gaining invented authority. Upgrade is transactional/idempotently recoverable. Package and lockfile compatibility is checked together.

### R02 — Migration rehearsal and recovery evidence — MUST

Stop affected writers, take consistent database-plus-evidence backups, and rehearse on copies. Check row counts, foreign keys, immutable digests, ownership/lineage, budgets, pending decisions, dispatch journals, and QA certificates.

**Acceptance:** interrupted migration recovers safely. A backup rollback cannot discard later work/evidence without reconciliation. Storage upgrade does not resolve unrelated remote uncertainty by assumption.

### R03 — Platform-specific verification — CONDITIONAL

Run real native checks on every claimed supported platform, particularly Windows Job/helper cleanup and Unix ownership inventories. Separate local portable tests from native execution.

**Acceptance:** required native cases run with no unexplained skips and archived OS/runtime/revision output. The reference's pending Windows/Linux sign-off remains pending until actually completed.

### R04 — Canary and promotion gates — MUST

Promote deterministic correctness first, then live representative canaries, then operational rollout under appropriate authorization. Monitor false completion, stale owner selection, duplicate dispatch, unanswered approval bypass, evidence loss, blocker loops, and defect escapes.

**Acceptance:** any invariant breach stops promotion. Optional performance changes can be reverted independently. Report paired before/after outcomes; historical current-only canaries are not speedup evidence.

### R05 — Documentation and operator recovery — MUST

Document commands, policy/default changes, configuration, scopes, supported adapters/auth, quotas, telemetry, migration, troubleshooting, and release/rollback steps. Maintain machine-readable CLI docs alongside code.

**Acceptance:** a user can answer “what is running, why is it waiting, what is authorized, what has passed, and what should I do next?” from supported views/docs. Generated docs and config examples match shipped behavior.

### R06 — Evidence governance and privacy — MUST

Define retention, redaction, access, export/deletion, replay, and incident handling for prompts, source snapshots, provider events, examples, and eval traces. Use synthetic/redacted cases unless real data use is authorized.

**Acceptance:** no credentials or sensitive user/project data enter public fixtures or default logs. Replay is explicit about unavailable sensitive inputs. Third-party/hosted integration describes external data exposure before adoption.

### R07 — Ongoing regression and model-upgrade process — MUST

Turn corrected production failures into curated regressions, examples, and held-out cases as appropriate. Re-evaluate model/prompt/tool/profile changes against quality, attention, latency, usage, and recovery.

**Acceptance:** changes have comparable reports, documented thresholds, and rollback paths. Eval suites evolve without erasing historical failures or training directly on the entire held-out set.

### R08 — Final product acceptance — MUST

Declare success from independently accepted substantial work, bounded safe recovery, preserved scope, lower avoidable attention, and justified operating overhead. Publish remaining limits and unresolved findings.

**Acceptance:** no claim of universal best harness or zero possible failures. The result identifies which tasks/models benefit, which do not, and which optional integrations were rejected or deferred.

## 3. Planning-agent handoff contract

### 3.1 Required first actions

1. Locate the actual implementation checkout and inspect its instruction files, Git state, versions, and current repair status.
2. Read the local evidence documents below, including later sections that explicitly supersede earlier completion claims, and the [codebase regression review](rafi-harness-regression-review.md).
3. Build the E01 coverage ledger. Reconcile verified repairs before assigning implementation work.
4. Discover existing scripts and establish deterministic baseline results on disposable state.
5. Produce an ordered implementation plan with reviewable boundaries and cross-requirement dependencies.
6. Separate safe baseline fixes from optional experiments, consequential product decisions, and rollout actions.

### 3.2 Ticket/step schema

Each planned ticket or step must include:

- Stable ID, requirement IDs, title, priority, and user/engineering value.
- Disposition: preserve/verify, repair, new capability, experiment, migration, or documentation.
- Current evidence and exact remaining gap; distinguish historical from newly reproduced behavior.
- Owned files/modules and production callers; shared contract or schema changes.
- Applicable CR risks from the [regression review](rafi-harness-regression-review.md), protected existing behavior/tests, and positive continuation as well as negative safety gates.
- Dependencies and prerequisite decisions; no circular or hidden execution dependencies.
- Observable acceptance criteria, positive controls, failure/recovery cases, and test-integrity checks.
- Test-first approach for behavior changes; appropriate exceptions for documentation or impractical TDD.
- Concrete verification commands, fixture/artifact locations, and live quota/budget requirements.
- Compatibility, migration, rollout/rollback, and documentation obligations where applicable.
- Expected review boundary and evidence needed to mark done.

Do not populate MoneyFarm's app ticket queue with Rafi implementation work. Choose a separate Rafi backlog/location in the implementation plan. Do not modify source merely because a requirement exists: verified existing requirements need evidence, not gratuitous rewrites.

### 3.3 Recommended dependency sequence

| Stage | Work | Gate before advancing |
| --- | --- | --- |
| A | E01–E05, E11–E13, E17–E18: inventory, regression foundation, telemetry | Current behavior and production-path gaps are understood |
| B | E06–E10, E14–E16: benchmark corpus, scoring, live runner | Comparable native/current-Rafi baselines and calibrated reviewers |
| C | Missing B01–B24/B31–B32 reliability obligations | Ownership, dispatch truth, scope, budgets, decisions, and QA pass deterministic/packaged gates |
| D | B25–B30: packets, contracts, verification and reviewer quality | No mandatory-policy loss; independent scoring is meaningful |
| E | H01–H14: selected bounded integration spikes | Conformance, auth/licensing, overhead and measured benefit are documented |
| F | F01–F12: granularity/cadence/context/model/concurrency experiments | Held-out comparative evidence meets agreed quality/attention gates |
| G | R01–R08: compatibility, canary, release and learning | Migration/platform/operational gates passed under explicit rollout authorization |

Some independent corpus or documentation work can overlap. Do not enable broader automatic recovery, larger mutation scope, or concurrency before its authority and uncertainty gates pass. Begin R01/R06 design early when schema or evidence storage changes arise.

This sequence is not a waterfall. E01–E05 may expose a safety defect that must be repaired in Stage C before a live Stage B run can proceed safely. Build the runner/corpus in parallel, but quarantine unsafe configurations and record the unavailable comparison rather than exercising known unsafe recovery. Define promotion thresholds, critical-defect vetoes, and experiment stop rules before collecting candidate results; unresolved thresholds block promotion, not deterministic fixture preparation.

### 3.4 Completion evidence required from the planner

The plan must include a requirements coverage matrix with no unexplained omission, an experiment matrix, a consolidated ownership/state contract, a schema/version impact list, a prioritized risk list, and explicit unresolved choices. It must identify which work can proceed without additional decisions and why any requested decision changes behavior, cost, security, data, or public contracts.

Proposed decision points include milestone/`--steps` semantics, review gates by risk, provider authentication paths, permissible paid usage, eval retention, acceptable quality/latency tradeoffs, and supported platform claims. These need concrete alternatives before approval; they do not block preparation of tests and current-state evidence.

## 4. Finding-to-requirement coverage

| Research recommendation or failure class | Requirements |
| --- | --- |
| Thorough evals, independent oracles, real app/user-flow tasks | E02–E10, E14–E18, B27–B29 |
| Fixed-model harness comparison and ablations | E14–E15, F01, F11–F12 |
| Current/lifetime token confusion; unnecessary/false compaction | B01–B03, E02, E12–E13 |
| Accepted idle successor; invalid generation; stale resume | B04–B06, B17–B18, E03–E05 |
| Redundant approvals; invisible questions; scope widening on resume | B07–B09, B17–B18, B31, F10 |
| Provider failure hidden by correction; original handoff lost | B10, B18–B21, E04 |
| Unbounded retries; unchanged blocker loops; fake progress | B11–B12, B21, F09 |
| Initialization/shutdown hangs; readiness cleanup; writer theft | B13–B16, B31–B32, E03/E05/E07 |
| QA occurrence collision, mixed receipts, missing wrapper enforcement | B19–B22, E04–E05 |
| Source-bound approval versus actual reviewer correctness | B22, B27–B29, E08–E10 |
| Prompt/history bloat; excessive broad policies; tool overhead | B23, B25–B26, B30, E13, H07, F04/F08/F12 |
| Truthful status, attributable timing, real cost and attention | E11–E13, B24, F09–F10 |
| Thin Rafi/native runtime hybrid | B26, H01–H02, H12/H14 |
| Curated skills and methodology without competing frameworks | H03–H09, F08/F12 |
| Browser CLI/skills/MCP comparison | E10, H11 |
| Milestone assignments and calibrated selective QA | F02–F03, F07 |
| Same/cross-model QA, effort and model-specific scaffolding | E09/E15, H07, F04–F05/F11 |
| Selective parallelism, contract partitioning and semantic integration | H13–H14, F06 |
| Subscription-first operation and honest policy/auth boundaries | E12/E16, H01–H02/H06/H10, R06 |
| Existing repairs, migration limits, native platform gaps | E01/E04, R01–R04 |
| No evidence that three self-checks or more agents always help | B30, F05–F06/F08, E14–E15 |

### 4.1 Reliability fixture checklist

Each family needs a normal positive control, failure assertions, persisted recovery where applicable, and proof that legitimate continuation is possible. The coverage ledger must link concrete cases and production callers; this checklist supplements rather than replaces the numbered acceptance criteria.

| Fixture family | Required cases | Requirements |
| --- | --- | --- |
| Provider streams and wrappers | Fragmented/malformed events; duplicate/late/missing/foreign terminal and tool events; reconnect; wrapper fan-out and cleanup; reproducible event permutations | E02, B10, B18–B20, B26 |
| Context and compaction | Current versus cumulative usage; reset/cache/model change; stale samples; below/above threshold; slow successful, missing-usage, duplicate and late compaction | E02/E04, B01–B03 |
| Ownership and handoffs | Invalid acceptance; generation high-water mark; accepted-but-idle; adoption crash; stale predecessor; concurrent starts; path aliases and inaccessible identity | E03–E05, B04–B06, B15–B18 |
| Dispatch and durable evidence | Kill/reopen around every commit/send/capture boundary; lost acknowledgement; DB busy/disk failure; projection publication; duplicate/conflicting evidence; unknown remote effects | E03, B05/B10–B11/B19/B32 |
| Approval and questions | Same approved scope; between-turn material edits; hidden/durable questions; stale/duplicate answers; resume without answer; explicit selection versus saved scope | E05/E07, B07–B09/B17–B18/B31 |
| Ticket scheduling and recovery | Blocked dependency plus eligible independent work; missing/corrupt tracker; out-of-order done tickets; exact QA recovery; repeated aliases; no unselected mutation | E04–E05, B09/B17–B18/B31–B32 |
| Retries and blockers | Limits 0/1/N; restart/competing callers; wrapper correction counts; unchanged cause with new wording; scoped override replay; last-fix QA recheck | E04/E07, B11–B12/B20–B21 |
| Deadlines, cancellation, and supervision | Silent initialization; status-only activity; healthy long tools; hang/kill/parent death; repeated cancellation; cancel/terminal race; exhausted restart allowance | E02–E05/E07, B13–B16 |
| Readiness and containment | Missing executable/dependency/database; host versus provider permissions; hanging successful probe; PID reuse; escaped owned child; unavailable inventory; Windows creator/Job lifecycle | E05/E07, B14–B16, R03 |
| QA and correction isolation | Identical content in distinct occurrences; foreign review; failed provider with valid envelope; read-only tools/reverted edits in correction; source drift; partial/disputed findings | E04/E09, B19–B22/B29 |
| Acceptance and test integrity | Known-good and seeded-bad solutions; observed behavioral red-to-green with related regressions green; already-green and environment-failure controls; deleted/weakened tests; fabricated/stale execution; evaluator failure/flakiness; negative auth/data cases; held-out checks | E06/E08–E09, B27–B29 |
| Browser behavior | Navigation, forms, reload persistence, roles, keyboard access, loading/empty/error states; visual criteria where needed; console/network failure artifacts | E06/E10, B27–B29, H11 |
| History, resources, and visibility | Many handback cycles; mandatory-context overflow; output flood; subscription/process/descriptor leaks; truthful terminal/manager views; PTY and redirected waits | E05/E07/E11–E13, B08/B23–B25/B30 |
| Compatibility and migration | Legacy ambiguous records; interrupted/idempotent upgrade; old-writer exclusion; backup with WAL/evidence; upgrade with preserved remote uncertainty; native packaged checks | E03–E05/E17, B32, R01–R04 |

### 4.2 Requirements audit record — 2026-10-09

Reviewed all 84 requirements against their acceptance criteria, dependency sequence, preserved recommendations, and the historical repair plans, including the later superseding recovery sections. This was a requirements/source-document audit, not a runtime or live-provider verification.

The audit made explicit: seeded event-order/state-machine checks; real durability and storage faults; oracle validation and flaky-eval accounting; production coverage selection; path identity; final QA after budget exhaustion; durable cancellation; conflicting occurrence writes and exact evidence attribution; event-owner fan-out and shared correction limits; scoped waivers; configuration precedence; resource cleanup; and safe sequencing of live experiments. The 84 stable IDs remain unchanged.

A follow-up review made observable behavioral red-to-green validation explicit in B28 and E09, clarified that blocked/not-run mandatory checks cannot satisfy B27 completion, and tied verified criterion transitions/checkpoints to F09 progress. These strengthen existing requirements rather than adding a second validation system.

No major recommendation was removed. Historical fixes remain preserve-and-verify obligations. Optional harness comparisons remain selective experiments. Current implementation dispositions, numeric promotion thresholds, provider conformance, and native Windows/Linux evidence remain work for the planning/implementation agent rather than claims of this audit.

### 4.3 Codebase implementation regression review — 2026-10-09

The [companion review](rafi-harness-regression-review.md) records 24 concrete implementation regression risks, linked source surfaces, existing test protections, and required new gates. It distinguishes existing safeguards from new evidence requirements; source/test inspection is not a claim of fresh runtime verification. The reference clone had no installed dependencies, so runtime, packaged and live checks remain unrun in this review.

Planning must explicitly resolve four cross-part dependencies: execution evidence integrated with current source-bound QA/certificates; practical red-to-green applicability and exceptions; milestone scope/completion semantics; and ownership/responsibility contracts for parallel or external runtimes. Preserve existing SQL admission fences, per-dispatch approval, uncertainty, budgets, read-only QA and finalization while adding new behavior. Do not introduce a competing completion gate or bypass safeguards to make an experiment work. The 84 requirement IDs remain unchanged.

## 5. Evidence and source index

### 5.1 Local Rafi evidence

- [Rafi README](../README.md): product and supported workflow overview.
- [Structured plan](../packages/rafi/src/structuredPlan.ts) and [ticket population](../packages/ai-foreman/src/ticketPopulation.ts): approved intent and ticket provenance.
- [Eligibility](../packages/ai-foreman/src/tickets/eligibility.ts) and [Foreman](../packages/ai-foreman/src/foreman.ts): queue and execution boundaries.
- [QA review](../packages/ai-foreman/src/qaReview.ts), [snapshot](../packages/ai-foreman/src/qaSnapshot.ts), and [protocol](../packages/ai-foreman/src/qaProtocolV2.ts): review/evidence foundations.
- [Codex adapter](../packages/ai-foreman/src/adapters/codex.ts), [Claude adapter](../packages/ai-foreman/src/adapters/claude.ts), and [session lifecycle](../packages/ai-foreman/src/sessionLifecycle.ts): runtime ownership and context.
- [Supervised start](../packages/ai-foreman/src/supervisedStart.ts) and [supervisor](../packages/ai-foreman/src/supervisor.ts): production supervision.
- [QA prerequisites](../packages/ai-foreman/src/qaPrerequisites.ts) and [bounded handback history](../packages/ai-foreman/src/qaHandbackHistory.ts).
- [Build-stall investigation](../docs/build-stall-investigation.md) and [repair plan](../docs/build-stall-repair-plan.md): eight historical scenarios, W0–W10, current repair evidence, and rollout limits.
- [QA handback investigation](../docs/qa-handback-investigation.md) and [implementation plan](../docs/qa-handback-implementation-plan.md): 26 diagnostics, P0–P13, wrapper/migration follow-up audits.
- [Build-resume gap implementation plan](../docs/build-resume-gap-implementation-plan.md): launch/ownership/readiness, later superseding sections, execution scope, pending questions, repeated resume, and native verification limits.
- [Live build-stall runner](../scripts/live-build-stalls.ts), [live ticket planning](../scripts/live-ticket-plan.mjs), [live create](../scripts/live-create.mjs), and [live interview](../scripts/live-interview.mjs): existing live foundations.
- [Build-stall audit](../scripts/audit-build-stalls.py) and [QA handback audit](../scripts/audit-qa-handback.mjs): existing read-only investigation tooling.

### 5.2 Primary external sources from the investigation

These references preserve the preceding research; recheck version-sensitive details before implementation.

| ID | Source | Use |
| --- | --- | --- |
| S1 | [OpenAI: run long-horizon tasks with Codex](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex) | Long work, persistent artifacts, verification |
| S2 | [OpenAI: Codex execution plans](https://developers.openai.com/cookbook/articles/codex_exec_plans) | Restartable living plans |
| S3 | [Anthropic: harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps), [effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Initializer, browser verification, evaluator calibration, simplification |
| S4 | [Codex SDK](https://developers.openai.com/codex/sdk) | Programmatic thread execution/resume |
| S5 | [Codex app-server](https://learn.chatgpt.com/docs/app-server) | Persistent integration/events/approvals |
| S6 | [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform) | Headless execution and integration tradeoffs |
| S7 | [LangChain: improving Deep Agents with harness engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering) | Fixed-model harness changes and reported benchmark result |
| S8 | [LangChain: Deep Agents v0.7](https://www.langchain.com/blog/deep-agents-v0-7) | Smaller prompt/tools and measured tradeoffs |
| S9 | [LangChain: tuning for different models](https://www.langchain.com/blog/tuning-deep-agents-different-models) | Model-specific profiles |
| S10 | [Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988) | Context-file cost/success evidence |
| S11 | [SkillsBench](https://arxiv.org/abs/2602.12670) | Curated skills evidence and domain variation |
| S12 | [METR: experienced open-source developers study](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) | Measured productivity versus perception |
| S13 | [Claude: dynamic workflows](https://claude.dev/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code/), [workflow introduction](https://claude.com/resources/articles/introducing-dynamic-workflows-in-claude-code) | Native isolated/parallel workflows and plan availability |
| S14 | [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | SDK capabilities and authentication constraints |
| S15 | [Claude context engineering](https://claude.dev/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models/), [power-user practices](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips) | Focused instructions and practical verification |
| S16 | [Superpowers](https://github.com/obra/superpowers), [releases](https://github.com/obra/superpowers/releases) | Focused methodology skills and execution alternatives |
| S17 | [GSD Core](https://github.com/open-gsd/gsd-core) | Phase planning, durable state, fresh context |
| S18 | [Ralph](https://github.com/snarktank/ralph) | Bounded progress loops |
| S19 | [Pi coding agent](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) | Minimal extensible runtime |
| S20 | [OpenCode SDK](https://opencode.ai/docs/sdk/) | Server/client adapter capability |
| S21 | [OpenSpec](https://github.com/Fission-AI/OpenSpec) | Change artifacts and brownfield intent |
| S22 | [Spec Kit](https://github.com/github/spec-kit) | Spec/plan/task interoperability |
| S23 | [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) | Product/architecture/UX/testing perspectives |
| S24 | [Factory Droid exec](https://docs.factory.com/droid-exec/overview) | Headless/hosted execution reference |
| S25 | [Playwright MCP](https://github.com/microsoft/playwright-mcp), [Playwright CLI](https://github.com/microsoft/playwright-cli) | Browser integration comparison |
| S26 | [Cursor: scaling agents](https://cursor.com/blog/scaling-agents) | Planner/worker partitioning |
| S27 | [Cursor: agent swarm model economics](https://cursor.com/blog/agent-swarm-model-economics) | Specialized context, contract reconciliation, scale limits |

## 6. Document acceptance

- The four requested workstreams are explicit, with a fifth for release and continued evaluation.
- Baseline requirements include historical repairs as preservation/verification obligations, plus proposed quality and design improvements.
- Every numbered requirement has an observable acceptance condition; experiments do not imply automatic adoption.
- Research evidence, uncertainty, subscription preference, compatibility, independent QA, and approval constraints are preserved.
- A planning agent has requirement IDs, dependency guidance, backlog boundaries, source references, and a concrete handoff schema.
- This document changes no application behavior, approved plan, canonical policy, ticket state, or runtime configuration.
