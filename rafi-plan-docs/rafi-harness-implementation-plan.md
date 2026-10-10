# Rafi harness implementation plan

> Handoff copy packaged 2026-10-10. Place this folder at the Rafi repository root. Source/test links resolve against that repository; historical observations describe the inspected reference snapshot. Read [agent implementation instructions](AGENT-INSTRUCTIONS.md) before execution.

Date: 2026-10-09. Status: planning complete; implementation steps are proposed backlog work. Source changes, new services, live spending, publication and operational rollout are not authorized by this document.

Based on the [84 requirements](rafi-harness-requirements.md), [24 implementation regression risks](rafi-harness-regression-review.md), and prerequisite [implementation design brief](rafi-harness-implementation-design.md). The design brief supplies execution-evidence, certificate, ownership and recovery boundaries before several implementation streams create overlapping mechanisms.

## 1. Outcome and execution policy

Deliver substantial approved application work with independently verified correctness, bounded recovery, preserved intent and less avoidable human attention. Prefer supported existing subscriptions. Keep native coding runtimes capable and Rafi's authority/evidence coordinator small.

This is an ordered plan, not an assertion that every baseline requirement is currently broken. Each preserve/verify step first tests current production behavior; only a reproduced gap creates repair work. The reference snapshot is CLI 0.9.20/runtime 1.7.20 at `4aa437b3cf19d83d7bb5dc8482bb4b04709c887a`; actual implementation may differ. No runtime baseline or live experiment was executed while writing this plan.

Implementation belongs in the actual Rafi development checkout identified by IMP-01. Proposed backlog destination there: `docs/rafi-harness-backlog.md`, or its configured external tracker. This document remains the planning source; generated tickets link to it. Do not insert Rafi work into MoneyFarm's approved app queue, mutate `.rafi` app state, or assume `rafi-ref` is the implementation checkout.

All proposed steps start **Backlog**. Mark a step Ready only after its dependencies and affected decisions have evidence. A verified-existing result can complete a preservation step without code changes. Experiment screening can close as reject/defer with a rationale; an adopted conditional feature must satisfy its full conformance requirements. Baseline MUST requirements cannot close merely as optional deferral.

## 2. Phases and review gates

| Phase | Steps | Exit evidence |
| --- | --- | --- |
| 0 — Inventory and design | IMP-01–02, IMP-10 | Real checkout/backlog; baseline limits; reviewed evidence and authority contracts |
| 1 — Tests, evals and instrumentation | IMP-03–09 | Deterministic faults, calibrated oracle, UI/recovery corpus, reproducible reports and safe opt-in live gate |
| 2 — Baseline preservation and quality | IMP-11–26 | Current repairs verified; executed verification and behavioral red/green integrated with QA; truthful recovery/checkpoints; compatible shipped paths |
| 3 — External practices and hybrids | IMP-27–33 | All named candidates screened; bounded subset compared; owner/auth/conformance explicit; decisions recorded |
| 4 — Evidence-selected improvements | IMP-34–41 | Milestone/context/review/routing/parallel/reuse hypotheses resolved; only supported winners adopted |
| 5 — Migration, release and learning | IMP-42–47 | Rehearsed compatibility, native claims, docs, canaries, authorized rollout and independent acceptance |

Phase numbers describe the work, not a rigid waterfall. IMP-10 depends on early fixtures and is completed before evidence enforcement. IMP-27 screening can begin once the runner/design exist. A narrowly reproduced safety defect can be repaired immediately after its regression is written; do not wait for an entire benchmark framework. Live optimization trials must not bypass unresolved safety gaps. Early native baselines can run in disposable environments once their safety/auth gates pass; production-style comparisons wait for IMP-26.

Suggested first sequence: IMP-01 → IMP-02 → IMP-03 → IMP-04 → IMP-06 → IMP-08 → IMP-10. Then finish the remaining Phase 1 fixtures and audit the Phase 2 preservation steps before implementing missing quality capabilities. This order establishes source binding and durable identity before new completion gates depend on them.

## 3. Shared contract for every step

Each step below identifies requirements, CR risks, dependencies, owned surfaces, existing tests, concrete work, acceptance and verification. Convert a step into smaller reviewable tickets when it spans multiple behavior changes; retain its ID as an epic and assign child IDs such as `IMP-19.1`. Do not invent calendar estimates before current-state inventory. Size from verified remaining gaps, not requirement count.

For every implementation ticket:

1. State user/engineering value and current disposition: verified existing, incomplete, newly reproduced defect, experiment, or missing evidence. Cite actual current caller and source/test locations from the coverage ledger.
2. Claim specific files/modules before editing. Shared schema, adapters and workflow authority changes require a coordinated owner. This is a scheduling constraint, not authorization to spawn agents or run parallel production writers.
3. Preserve linked existing assertions. Add meaningful failing behavior coverage first where practical, implement minimally, then refactor. Documentation-only steps need document checks rather than mirrored tests. Explain justified TDD exceptions.
4. Include negative safety gates and a positive legitimate continuation. Tests that merely refuse all work do not satisfy recovery requirements.
5. Use disposable state. Respect uncommitted changes and existing process/lease authority. No reset, forced checkout, blind replay or destructive restoration is implied.
6. Identify schema/public contract/config/auth/privacy/operational effects. Attach reviewed design/ADR and migration compatibility before those changes. Resolve consequential pending decisions with the user; continue unaffected work.
7. Run appropriate gates below, retain exact results and implementation/package versions, and update affected Rafi docs/backlog. A not-run result is a limitation, not a pass.
8. Independent review closes the ticket against requirement acceptance, applicable CR safeguards and current evidence. No provider done marker, self-confidence or green convenience test alone marks Done.

### Mandatory regression-test contract

Before a behavior-changing ticket is Ready, record a **test impact manifest**: requirement/CR IDs; real production caller; exact protected test cases; proposed new assertions and their expected failure; commands/configuration/platforms; positive continuation; fault boundary; required executed evidence; and an owner. Review that manifest independently. A filename in this plan is a starting point, not proof that the required assertion exists or ran.

For a reproduced defect, observe the behavioral regression fail before repair and pass afterward where practical. For a new invariant/capability, add behavioral negative and positive controls first; if practical red is unavailable, record the exception without inventing proof. Run protected existing cases unchanged before and after the affected change. Extend tests without deleting, skipping, weakening, or replacing an inconvenient invariant assertion; genuinely obsolete expectations need an explicit explained contract decision and replacement coverage.

Required safety cases must actually execute in the affected verification tier. Reject zero selected tests, all-skipped runs, missing provider/role branches, stale compiled imports and command filters that omit protected cases. Report total/executed/skipped counts, test IDs, seed, source/package revision, exit/outcome and skip rationale. A missing required platform/capability blocks its claim or promotion, not unrelated local work. Routine offline suites must not inherit live-provider skip conditions.

Fault cases assert dispatch/tool/publication counts, authoritative state and evidence as well as output text. Each recoverable denial is paired with legitimate continuation after the blocker changes. The new verification runner must pass the same scope/admission/ownership/cancellation/uncertainty protections as other execution; it cannot become an unjournaled side channel.

Wire the affected protected and new cases into repeatable package/CI commands before shipping the behavior. Add a CI path where absent; do not merely propose a test file that no gate selects. Use risk-based provider/role/mode coverage rather than a full Cartesian product. In particular, preserve the existing both-provider full adapter stack and both-resume-alias tests. Live and native-OS tiers remain separate with explicit required status. Critical escape, authority or evidence-integrity failures veto promotion.

Priority: **P0** for a reproduced authority, duplicate-dispatch, invalid acceptance or state-corruption defect; **P1** for baseline correctness/recovery and necessary test/evidence work; **P2** for bounded optimization trials; **P3** for optional integrations without a demonstrated gap. The default steps are P1 except experiments (P2), IMP-32 (P3), and conditional adoption (priority inherited from evidence). A risk's Critical label is not a claim of a current P0 bug.

### Verification profiles

Run commands from the actual Rafi checkout, not MoneyFarm. Re-discover scripts in IMP-01; the commands below are verified from reference package manifests, not executed results. Install/setup prerequisites only in the authorized implementation workspace. Keep package test concurrency conventions; the runtime currently serializes its suite.

| Gate | Commands/evidence | Use |
| --- | --- | --- |
| G0 — Planning/docs | Ledger/links/schema examples, requirement and risk coverage, dependency DAG, config/docs accuracy | All steps |
| G1 — Deterministic | Targeted `pnpm --filter ai-foreman exec tsx --test --test-concurrency=1 test/<name>.test.ts`; spec tests via `pnpm --filter rafi-spec exec tsx --test test/<name>.test.ts`; applicable package tests; `pnpm typecheck`; full practical `pnpm test` before completion of a behavior slice | Host/adapter/schema/QA changes; ordinary tests must need no live credentials |
| G2 — Process/integration | Existing actual kill/reopen, admission, supervisor, handoff, browser and resource fixtures through package test commands | Durable state, ownership, cancellation and real environment behavior |
| G3 — Built/shipped CLI | `pnpm build`, applicable `pnpm --filter @rafi-ai/cli test`, packaged alias/launch/PTY tests, `pnpm docs:check` | Rebuild before artifact-dependent tests; source tests alone do not prove resolved published package bytes |
| G4 — Opt-in live/eval | Existing `pnpm test:live-providers`, `pnpm test:live-create`, `pnpm test:live-ticket-plan`, `pnpm test:live-interview` and discovered stall/audit commands; proposed unified runner after IMP-09 | Supported authenticated subscriptions, explicit limits, disposable fixtures, all attempts retained; existing live scripts may mutate fixtures, so audit paths first |
| G5 — Migration/evidence | qaHandbackMigration, stateTransfer, buildAdmission old-writer/fault cases plus new schema/evidence rehearsal | Real SQLite reopen, immutable artifact verification, interrupted upgrades, consistent backup/import |
| G6 — Native platforms | Actual native process/launch/containment/PTY matrix and archived OS/runtime revisions | Every claimed supported platform; mocks do not replace native sign-off |

Run targeted checks first, then typecheck/static analysis and available lint/format checks, full practical tests, build, affected migration and smoke/E2E checks. No root lint/format script is present in the inspected manifest; discover package conventions and propose missing checks rather than claim them. Build dependent spec/runtime artifacts before tests that import built paths. Avoid rerunning broad suites without a new change/failure/uncertainty. Future runner/CI commands must be added and documented before this plan cites them as available.

Artifact layout proposed for the Rafi implementation repository: versioned `test/fixtures/harness-evals/` for synthetic task/rubric inputs, existing test locations for regressions, `docs/harness-evals/` for diff-friendly sanitized summaries, and the project's ignored run-artifact location for protected raw evidence. Final locations are selected in IMP-01/08; do not create a second evidence authority or commit secrets/large raw transcripts.

## 4. Detailed ordered steps

Every step inherits the shared contract and original requirement acceptance; concise acceptance below supplements it. Dependency lists are strict implementation prerequisites. Conditional trial dependencies can close with an explicit reject/defer disposition, while required safety and contract dependencies must pass.

### Inventory and baseline

#### IMP-01 — Establish the implementation checkout and evidence ledger

- **Requirement coverage:** E01, E04, E18. **Regression risks:** CR24.
- **Dependencies:** None. **Disposition:** Preserve/verify.
- **Owned surfaces/callers:** Implementation repository inventory, historical repair docs, package manifests and scripts; no runtime edits.
- **Existing protection to retain:** build-stall and QA handback investigation suites; later build-resume plan sections. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Locate the actual Rafi development checkout, read applicable instructions, record Git state and package/provider/platform versions, and reconcile the reference snapshot with current source. Create the separate Rafi backlog and an 84-row coverage ledger; locate all eight stall scenarios and 26 QA diagnostics, recording desired behavior rather than historical defect labels.
- **Acceptance and positive/negative controls:** Every requirement has current disposition, production caller, existing test, actual result or not-run reason, and remaining gap. Differences from reference commit are explicit. No MoneyFarm app tickets or reference source are changed.
- **Verification:** Inventory and G0; discover existing commands before invoking them.
- **Decisions/compatibility:** D01. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-02 — Baseline the repository and packaged command paths

- **Requirement coverage:** E05, E17. **Regression risks:** CR07, CR08, CR09, CR24.
- **Dependencies:** IMP-01. **Disposition:** Preserve/verify.
- **Owned surfaces/callers:** Existing package scripts, packages/rafi/test packaged tests, ai-foreman launch/admission tests and CI.
- **Existing protection to retain:** resumePackaged, establishedPackaged, interruptedPackaged, resumePty, buildAdmission, supervisedStart. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Run current deterministic suites, typecheck, build and generated-doc checks on disposable state. Record failures without treating them as regressions introduced by this plan. Construct a risk-based provider/role/launch/delivery/QA/context matrix, covering both resume aliases and public step accounting.
- **Acceptance and positive/negative controls:** Baseline artifacts identify implementation bytes resolved by the shipped CLI, exact selected tickets, dispatch counts and outcomes. Dangerous interactions have owners; missing native OS evidence stays pending. Helpers are not substituted for decisive CLI callers.
- **Verification:** G1, G2, G3; packaged and PTY commands from current scripts.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

### Test/eval foundations

#### IMP-03 — Reusable deterministic provider, clock and event fixtures

- **Requirement coverage:** E02. **Regression risks:** CR03, CR10, CR14, CR15.
- **Dependencies:** IMP-02. **Disposition:** New capability or extend existing.
- **Owned surfaces/callers:** ai-foreman/test adapter fixtures; adapters/types and recovering only where test seams are necessary.
- **Existing protection to retain:** codex, adapters, qaHandbackSafety, unifiedContinuity. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Extract reusable scripted Codex/Claude fakes without bypassing production wrappers. Add controlled clock, correlated tool events, stale/duplicate/foreign replies, partial streams, reconnect and cancellation races. Use seeded permutations and retain failing seeds.
- **Audited test depth:** Add state-machine/property assertions for sole authority, durable budget conservation, terminal identity and unresolved-dispatch no-replay; retain minimal failing seeds as ordinary deterministic regressions. Use existing dependencies or a small fixture generator before adding a new property-test framework.
- **Acceptance and positive/negative controls:** A single fixture can exercise fresh, resumed, correcting and handed-off roles through the real event owner. Malformed/missing terminal events cannot fabricate success. Tests are deterministic and require neither network nor provider login.
- **Verification:** G1 adapter/wrapper suites; fixture reproducibility across repeated seeds.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-04 — Crash, concurrent-writer and artifact fault fixtures

- **Requirement coverage:** E03. **Regression risks:** CR11, CR15, CR16, CR17, CR18, CR24.
- **Dependencies:** IMP-03. **Disposition:** New capability or extend existing.
- **Owned surfaces/callers:** workflowDb/buildAdmission test seams, disposable repositories, process kill/reopen helpers.
- **Existing protection to retain:** qaHandbackMigration, qaHandbackLease, handoffCrash, buildAdmission, stateTransfer. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Add narrow faults around reservation, dispatch, acknowledgement, artifact write, authoritative commit, projection publication, adoption and cleanup. Include busy/unwritable/full-storage simulation, concurrent revisions, real child kill/reopen and consistent SQLite backups.
- **Acceptance and positive/negative controls:** Every crash location has a negative safety assertion and a legitimate continuation after reconciliation. Previously committed evidence/findings survive; no dangling authoritative artifact references or duplicate automatic dispatch occur. Shared fault hooks are restored and serialized.
- **Verification:** G1 durable suites and G2 real process tests; G5 on persisted fixtures.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-05 — Recovery, hostile environment and resource-bound corpus

- **Requirement coverage:** E07. **Regression risks:** CR04, CR09, CR14, CR15, CR18, CR23.
- **Dependencies:** IMP-03, IMP-04. **Disposition:** New capability or extend existing.
- **Owned surfaces/callers:** test fixtures, readiness/supervision/browser harness test utilities.
- **Existing protection to retain:** readinessRecovery, supervisedStart, runtimeReadiness081, qaPrerequisites. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Add missing tools/services/network/registry, quota, permissions, injection, corrupt/missing tracker, healthy long tools, output floods, stuck initialization and repeated cancel/resume scenarios. Define resource limits from observed baseline and distinguish retained evidence from leaked temporary state.
- **Acceptance and positive/negative controls:** Cases distinguish product defect, setup inability and uncertain execution; each recoverable block has a successful continuation. Long healthy work is not interrupted as a stall. Memory/queues/processes/FDs/artifact growth remain within recorded limits.
- **Verification:** G1, G2 fault/resource runs; repeatability and cleanup assertions.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-06 — Independent task corpus and calibrated acceptance oracle

- **Requirement coverage:** E06, E08, E09. **Regression risks:** CR01, CR02, CR04, CR22, CR23.
- **Dependencies:** IMP-02. **Disposition:** New capability.
- **Owned surfaces/callers:** Versioned disposable app tasks and oracle/rubric fixtures outside builder mutation authority.
- **Existing protection to retain:** Reuse test/fixtures/live-todo-app and existing QA seeded-defect scenarios. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Define greenfield, vertical-slice, brownfield repair, database/auth/UI, cross-module and multi-context tasks. Seed known-good and defective solutions. Separate training examples, reviewer calibration and held-out acceptance. Add behavioral red/green, already-green, fake red, stale/fabricated output, weakened assertions and neighboring regression controls.
- **Acceptance and positive/negative controls:** Each case has starting state, environment, expected artifacts, oracle coverage and limits. Test deletion or confident summaries cannot improve the score. Critical misses, false positives, blocker accuracy, flakiness and adjudication are recorded separately.
- **Verification:** G1 oracle calibration against known-good/seeded-bad cases; independently inspect rubric.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-07 — Browser-flow fixture and isolated execution environment

- **Requirement coverage:** E10. **Regression risks:** CR04, CR06, CR22, CR23.
- **Dependencies:** IMP-05, IMP-06. **Disposition:** New capability.
- **Owned surfaces/callers:** Browser eval harness, disposable app startup/data fixtures and qaRuntime integration boundary.
- **Existing protection to retain:** qaRuntime, qaSnapshot, qaPrerequisites; reuse app fixtures. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Cover navigation, forms, validation, reload persistence, keyboard behavior, roles, error/loading/empty states and relevant appearance. Establish app port/data/service ownership, cleanup and artifacts without mutating the accepted source or source-linked dependency trees.
- **Acceptance and positive/negative controls:** Screenshots alone cannot pass functional acceptance. Host browser availability and provider permission differ. Missing services become blockers; restored services permit fresh checks. Child cleanup and network/credential exposure are explicit.
- **Verification:** G1 and G2 browser synthetic fixtures; G4 only for authorized environments.
- **Decisions/compatibility:** D05; select existing browser tooling where possible, approve meaningful new dependencies. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-08 — Correlated telemetry with honest timing, usage and prompt measurement

- **Requirement coverage:** E11, E12, E13, R06. **Regression risks:** CR03, CR14, CR20, CR23.
- **Dependencies:** IMP-03, IMP-04. **Disposition:** New capability or extend existing.
- **Owned surfaces/callers:** observability, workflow evidence boundaries, adapter event projection and rendered prompt capture.
- **Existing protection to retain:** observability, qaHandbackSafety, codex usage tests. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Add missing operation/check/source identities, phase spans, dispatch certainty, rendered-context attribution, attention interventions, quota outcomes and unavailable counters. Define protected evidence versus optional logs, redacted views and access/retention. Preserve provider-specific scope and interval unions.
- **Acceptance and positive/negative controls:** One trace explains owner, wait, last accepted progress and next action. Nested spans and duplicate wrapper events do not inflate totals. Unknown subscription dollar cost remains unknown. Secret-bearing synthetic data is redacted appropriately without corrupting immutable proof.
- **Verification:** G1 telemetry/retention tests; G5 evidence reopen/export; G0 privacy review.
- **Decisions/compatibility:** D05 before additional sensitive persistence. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-09 — Reproducible paired experiment runner and safe live gates

- **Requirement coverage:** E14, E15, E16, E17, E18, F01. **Regression risks:** CR20, CR21, CR23, CR24.
- **Dependencies:** IMP-05, IMP-06, IMP-07, IMP-08. **Disposition:** New capability or extend existing.
- **Owned surfaces/callers:** Existing scripts/live-* and audit scripts, eval reports and CI command family.
- **Existing protection to retain:** live harness test sources; retain simple sum-task stall control. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Unify run/artifact identities across existing scripts. Define native/current-Rafi baseline, slim packets, milestones, browser QA and one external-practice variants. Pair equivalent models/tools/permissions/budgets, interleave runs, record all outcomes and publish uncertainty. Keep live auth opt-in and bounded; freeze hypotheses and promotion margins before results.
- **Audited live control:** Pause/cancel must stop new eval dispatch, retain partial attempts and uncertain owned executions, and resume only after reconciliation within the remaining frozen limits. Never stop a production run or borrow its ownership to satisfy an eval cleanup path.
- **Acceptance and positive/negative controls:** Offline mode is independently usable. At least five representative live canary repetitions begin variance estimation when authorized; this is not enough to claim reliable tails or small improvements. Quota exits, cancellations, setup/evaluator time and reruns remain in reports. No active MoneyFarm state is used.
- **Verification:** G1 runner/report tests; G4 only with supported auth and explicit limits.
- **Decisions/compatibility:** D07; API/hosted spending requires budget approval. Apply shared migration, documentation and independent review obligations when behavior changes.

### Prerequisite contract design

#### IMP-10 — Verification and completion contract design checkpoint

- **Requirement coverage:** B26, B27, B28, B30, R01. **Regression risks:** CR01, CR02, CR03, CR04, CR17, CR21, CR24.
- **Dependencies:** IMP-01, IMP-03, IMP-04, IMP-06, IMP-08. **Disposition:** Design.
- **Owned surfaces/callers:** spec schemas, adapters/types, QA review basis and workflow storage contracts; design docs.
- **Existing protection to retain:** qaFailureReport, qaProtocolV2, qaSnapshot, qaHandbackMigration. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Resolve D02–D06 using the companion brief. Specify criterion mapping, source-at-check capture, observation completeness, TDD applicability, mandatory checks, QA-off semantics, waiver compatibility, certificate extension, legacy continuation and evidence governance. Prototype only enough to choose the execution boundary.
- **Acceptance and positive/negative controls:** Reviewed contract examples cover genuine pass, missing proof, uncertain execution, environment blocker, already-green and TDD exception. Current authority/certificate guarantees are preserved; open consequential changes block only their affected implementation. No stronger proof is retroactively invented.
- **Verification:** G0 design review plus G1 executable contract examples.
- **Decisions/compatibility:** D02 D03 D04 D05 D06. Apply shared migration, documentation and independent review obligations when behavior changes.

### Baseline reliability preservation

#### IMP-11 — Audit approval, exact execution scope, questions and independent queue continuation

- **Requirement coverage:** B07, B08, B09, B17. **Regression risks:** CR07, CR08, CR09, CR24.
- **Dependencies:** IMP-02, IMP-03. **Disposition:** Preserve/verify, then narrow repair if reproduced.
- **Owned surfaces/callers:** cli/start, packages/rafi/src/buildResume, foreman, durable question/plan records.
- **Existing protection to retain:** foreman, buildStallRepairs, buildResume, supervisedStart, resumePackaged. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Verify executionTickets travels through approval/selection/dispatch; material plan revision is checked at every relevant dispatch; unanswered resume is not an answer. Audit superseded answers, pending QA precedence, corrupt tracker handling and independently eligible work.
- **Acceptance and positive/negative controls:** Explicit blocked T001 never selects T002; later bare authorized resume can. A changed material plan requires approval; unchanged valid approval does not prompt again. Run-wide waits and ticket waits behave correctly. Any defect repair includes the real caller, not only helper coverage.
- **Verification:** G1 focused suites, G2 CLI paths, G3 affected modes.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-12 — Audit handoff generations, authoritative resume and completion identity

- **Requirement coverage:** B04, B05, B06, B18. **Regression risks:** CR10, CR11, CR15, CR24.
- **Dependencies:** IMP-03, IMP-04, IMP-11. **Disposition:** Preserve/verify, then narrow repair if reproduced.
- **Owned surfaces/callers:** continuity/session identity/handoffs, buildRuns, start/resume callers.
- **Existing protection to retain:** unifiedContinuity, handoffCrash, qaHandbackSafety, buildResume. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Verify canonical identities, high-water generations, prepare/commit/adopt boundaries, narrow response-only validation, authoritative pointer recovery and accepted-but-idle continuation. Wrong/missing assignment markers never finalize or cause implementation replay.
- **Acceptance and positive/negative controls:** Invalid successor leaves predecessor intact; accepted successor dispatches or explains the durable blocker. Two resumptions retain exact selected scope, lineage, policy and budgets. Source/projection disagreement is inspectable and safely reconcilable.
- **Verification:** G1 handoff/resume suites; G2 kill/reopen; G3 aliases.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-13 — Audit execution truth, event fan-out and response-only corrections

- **Requirement coverage:** B10, B19, B20. **Regression risks:** CR10, CR14, CR15, CR16, CR17.
- **Dependencies:** IMP-03, IMP-04. **Disposition:** Preserve/verify, then narrow repair if reproduced.
- **Owned surfaces/callers:** adapters/recovering, qaReview, report parsers, handback journals and foreman.
- **Existing protection to retain:** qaHandbackSafety, qaFailureDelivery, qaFailureReport, qaHandbackMigration. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Exercise original provider failures, exact turn/raw/cleaned binding, format repair, continuity repair and one shared allowance. Audit observation forwarding/drain ordering through wrappers and occurrence-versus-digest replay rules.
- **Acceptance and positive/negative controls:** Errored implementation followed by clean done completes zero steps, including QA-off. No-tools repair rejects read-only tools, reverted edits, missing observation and source drift. Identical bytes across reviews remain distinct; same-occurrence conflicts fail. Observers do not steal or delay terminal events.
- **Verification:** G1 full wrapper stacks and parser/journal suites; G2 crash evidence cases.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-14 — Audit durable budgets, cancellation and uncertainty across restarts

- **Requirement coverage:** B11, B13. **Regression risks:** CR10, CR15, CR16, CR17.
- **Dependencies:** IMP-03, IMP-04, IMP-13. **Disposition:** Preserve/verify, then narrow repair if reproduced.
- **Owned surfaces/callers:** workflowDb reservations, util/deadline, adapter operations, recovery policy and supervisor interfaces.
- **Existing protection to retain:** buildStallRepairs, qaHandbackSafety, supervisedStart, codex. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Inventory every await/enclosing deadline, intentional wait, cancellation propagation and attempt reservation. Test limits 0/1/N, competing reservations, proven-unsent versus uncertain sends and scoped overrides across wrappers/sessions/aliases.
- **Acceptance and positive/negative controls:** No new mutation after durable cancel. Timeout remains uncertain until reconciled; late success stays on original occurrence. Healthy long work and human waits have distinct handling. The final independent recheck after last allowed fix can run without authorizing another fix.
- **Verification:** G1 deadline/budget races; G2 restart/cancel races; G3 Ctrl-C.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-15 — Audit readiness capabilities, process ownership and supervision

- **Requirement coverage:** B14, B15, B16, B32. **Regression risks:** CR04, CR15, CR18, CR24.
- **Dependencies:** IMP-04, IMP-05, IMP-14. **Disposition:** Preserve/verify, then narrow repair if reproduced.
- **Owned surfaces/callers:** runtimeReadiness, process ownership/containment, supervisor, admission and recovery CLI.
- **Existing protection to retain:** readinessRecovery, processIdentity, buildAdmission, supervisedStart. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Verify bounded nonmutating capability probes, registered owner incarnation, PID/start identity, trusted helpers, escaped descendant policy and common cleanup. Audit dead/hung worker/parent detection, stale-worker fencing, limited cleanup authority and storage upgrade independent of provider uncertainty.
- **Acceptance and positive/negative controls:** No replacement while owned execution may continue; confirmed cleanup allows progress. Unknown inventory is not dead; PID reuse cannot kill another process. Restricted cleanup cannot obtain mutation authority. Competing starts yield one writer; final status states unsupervised operation honestly.
- **Verification:** G1 and G2 containment/restart tests; G6 for native claims.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-16 — Audit context occupancy, compaction lifecycle and provider ceilings

- **Requirement coverage:** B01, B02, B03. **Regression risks:** CR15, CR20.
- **Dependencies:** IMP-03, IMP-08, IMP-14. **Disposition:** Preserve/verify, then narrow repair if reproduced.
- **Owned surfaces/callers:** adapters/codex and claude, continuity, effective policy and usage projections.
- **Existing protection to retain:** codex, unifiedContinuity, buildStallRepairs, observability. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Verify current-versus-cumulative usage, sample identity/freshness, reset handling, threshold/hysteresis, manual/native deduplication and effective ceilings. Retain request/ack/terminal/fresh-usage distinctions and shared bounded compaction deadline.
- **Acceptance and positive/negative controls:** Historical sample yields about 43.16%, then 9.15% after compaction without erasing lifetime usage. Ten percent under 65% does not trigger ordinary compaction. 27–53s cases and 90s healthy control are not false failures under evaluated policy. Unknown occupancy is not zero; unresolved compaction cannot overlap successor work.
- **Verification:** G1 context/compaction suites; G4 optional later tuning, not necessary for deterministic preservation.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-17 — Audit frozen QA snapshots, certificate consumption and finalization

- **Requirement coverage:** B22. **Regression risks:** CR01, CR05, CR06, CR17, CR22, CR24.
- **Dependencies:** IMP-04, IMP-10. **Disposition:** Preserve/verify, then narrow repair if reproduced.
- **Owned surfaces/callers:** qaSnapshot, qaRuntime, qaReview, branch/runner and finalization.
- **Existing protection to retain:** qaSnapshot, qaRuntime, qaProtocolV2, branchFinalization. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Verify HEAD/index/staged/unstaged/untracked, binary/mode/symlink and repository metadata bindings; dirty user work protection; isolated dependency projection; source revalidation; single-use certificates and narrow generated-path exceptions.
- **Acceptance and positive/negative controls:** A changed app source or review basis invalidates acceptance. Reviewer writes cannot enter accepted source. Read-only-symlink receipt is not represented as enforcement proof. Merge/rebase/squash and publication crashes preserve user changes and distinguish reviewed behavior from tracker projection.
- **Verification:** G1 snapshot/certificate/finalization; G2 publication crashes; G5 source/receipt transfer.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

### Baseline quality implementation

#### IMP-18 — Version criterion and observed execution schemas with durable persistence

- **Requirement coverage:** B19, B21, B27, R01, R06. **Regression risks:** CR01, CR03, CR16, CR17, CR23, CR24.
- **Dependencies:** IMP-04, IMP-08, IMP-10, IMP-13, IMP-14, IMP-17. **Disposition:** New capability/migration.
- **Owned surfaces/callers:** packages/spec contracts, workflowDb, buildAdmission schema fences and stateTransfer; propose focused verification modules.
- **Existing protection to retain:** qaHandbackMigration, qaFailureReport, stateTransfer, buildAdmission. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Implement minimal versioned criterion/execution/outcome types, immutable evidence storage, revisions and occurrence identity. Add schema migration, old-writer exclusion and transfer/inspection/export support in the same slice. Keep finding IDs, loop fingerprints and waiver/override identities separate.
- **Acceptance and positive/negative controls:** Round-trip exact evidence bytes/refs and typed missing outcomes. Reservation/artifact/commit ordering survives faults without dangling refs. Same-content different occurrence is distinct. Legacy records remain classified at original evidence strength; compatible readers and forbidden writers are documented.
- **Verification:** G1 schema/journal tests; G5 migration/transfer/old writer; G2 fault matrix.
- **Decisions/compatibility:** D03 D05 settled; do not split storage writes from compatibility enforcement. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-19 — Implement complete execution observation and controlled check capture

- **Requirement coverage:** E02, E11, B27, B28. **Regression risks:** CR02, CR03, CR04, CR06, CR14, CR15, CR17, CR23.
- **Dependencies:** IMP-03, IMP-07, IMP-10, IMP-11, IMP-12, IMP-13, IMP-14, IMP-15, IMP-18. **Disposition:** New capability.
- **Audited execution boundary:** Scope, original-owner, budget, cancellation and process-cleanup protections must pass before the runner launches checks; observation alone does not authorize execution.
- **Owned surfaces/callers:** Existing adapter event owner, types and QA/runtime boundary; focused verification runner/observer modules if justified.
- **Existing protection to retain:** qaHandbackSafety observation tests, qaSnapshot, qaRuntime, adapter fixtures. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Implement the selected D02 boundary. Capture tested source/test/env basis at execution, lifecycle ordering, terminal result, coverage/completeness and immutable artifacts. Prefer stable disposable snapshot checks for completion; native observations supplement ordered in-session TDD when reliable.
- **Acceptance and positive/negative controls:** Pass-then-edit, concurrent/reverted mutation during execution, shell chains, background jobs, truncation, nonzero exit, missing terminal and late outcomes cannot falsely certify current source. Missing native fields are unavailable, not reconstructed from summaries. Resource cleanup and full wrapper fan-out pass.
- **Verification:** G1 controlled-runner/observer negatives and positives; G2 kill/late event tests.
- **Decisions/compatibility:** D02 D05; command, service and network authority remain existing scoped permission. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-20 — Compile approved acceptance into project verification contracts

- **Requirement coverage:** B14, B25, B27. **Regression risks:** CR01, CR03, CR04, CR19, CR22.
- **Dependencies:** IMP-10, IMP-18, IMP-19. **Disposition:** New capability.
- **Owned surfaces/callers:** Ticket/planning contract compilation, manifest discovery, qaPrerequisites and task packets.
- **Existing protection to retain:** ticketPopulation, qaPrerequisites, structuredPlan and ticketPlan tests. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Map each criterion to checks, expected behavior, cwd, prerequisites, evidence and review responsibility. Discover actual nested package commands and environment requirements. Keep independent protected acceptance separate from builder convenience tests. Detect mandatory criteria with no executable/rubric coverage before dispatch.
- **Acceptance and positive/negative controls:** Custom/nested commands are not silently omitted. Host presence does not imply provider permission. Provisioning remains authorized setup. Failure output reaches bounded correction; changed source/test/command/relevant environment invalidates applicable evidence.
- **Verification:** G1 compiler/prerequisite cases; G2 representative disposable app.
- **Decisions/compatibility:** D04; imports cannot change approved scope or invent new approval. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-21 — Enforce verification evidence through independent QA and finalization

- **Requirement coverage:** B21, B22, B27, B29, R01. **Regression risks:** CR01, CR04, CR05, CR10, CR16, CR17, CR22, CR24.
- **Dependencies:** IMP-14, IMP-17, IMP-18, IMP-19, IMP-20. **Disposition:** New capability/compatibility.
- **Owned surfaces/callers:** qaReview fresh/recovered paths, spec pass contract, qaProtocolV2, branch finalization and QA-off completion path.
- **Existing protection to retain:** qaProtocolV2, qaFailureReport, qaHandbackSafety, branchFinalization. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Bind mandatory executed check evidence and criterion dispositions into the existing review basis/certificate. Enforce fresh, recovered and finalization-only paths; add actionable missing/stale/incomplete proof outcomes. Preserve independent QA and scoped authorized waivers; implement the agreed legacy and QA-off policy.
- **Acceptance and positive/negative controls:** Valid qa_pass without required proof cannot complete under the new contract. Passing checks without independent QA cannot claim reviewed completion. Complete proof plus valid QA finalizes once. Blocked/not-run remains incomplete; budget override/dispute is not waiver. Last-fix recheck remains allowed.
- **Verification:** G1 end-to-end acceptance; G2 crash/recovery; G3 shipped completion; G5 legacy continuation.
- **Decisions/compatibility:** D03 D04; consequential completion behavior approved before enforcement. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-22 — Implement observed behavioral red-to-green and practical exceptions

- **Requirement coverage:** B28, E09. **Regression risks:** CR02, CR03, CR04, CR22, CR23.
- **Dependencies:** IMP-06, IMP-19, IMP-20, IMP-21. **Disposition:** New capability.
- **Owned surfaces/callers:** Criterion applicability, execution histories, reviewer rubric and builder packet; focused red/green evaluator.
- **Existing protection to retain:** New calibrated repair fixtures plus existing independent QA suites. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Record meaningful pre-fix failure, same final check passing after fix and neighboring checks. Persist ordered occurrence/source/test digests across restart/handoff. Classify already-green and legitimate TDD exceptions; independently assess failure attribution and changed test semantics.
- **Acceptance and positive/negative controls:** Fake red, infra outage, unrelated compile failure, removed assertions, fabricated/stale output and target-green/neighbor-red cannot be counted as verified repair. Changed test is justified and checks defective source on a disposable copy where practical. Documentation/refactor/unsupported observation do not invent red or bypass required postchecks.
- **Verification:** G1 E09 calibration and interruption tests; G2 disposable pre-fix reconstruction; no user checkout reset.
- **Decisions/compatibility:** D04; applicability review cannot create a blanket waiver. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-23 — Actionable calibrated QA and bounded remediation convergence

- **Requirement coverage:** B12, B21, B29, F09. **Regression risks:** CR02, CR04, CR09, CR16, CR22, CR23.
- **Dependencies:** IMP-06, IMP-14, IMP-21, IMP-22. **Disposition:** New capability or verified repair.
- **Owned surfaces/callers:** QA finding contracts, remediation/blocker fingerprints, progress and retry policy.
- **Existing protection to retain:** qaFailureDelivery, qaHandbackSafety, buildStallRepairs; calibrated E09 corpus. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Emit criterion/location/severity/repro/evidence with fixed/disputed/unresolved dispositions. Detect unchanged meaningful blocker causes without resetting on wording/churn. Allow bounded clarification, targeted independent dispute recheck and legitimate new evidence; separate calibrated correctness from confidence.
- **Acceptance and positive/negative controls:** Correct code blocked by missing registry/database is not repeatedly edited. False positives and critical misses are visible. Healthy exploration survives stall controls. New evidence resumes appropriately; no findings disappear across partial remediation and no claimed fix resolves another occurrence.
- **Verification:** G1 seeded defect/false alarm/blocker convergence; G2 bounded remediation/restart.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-24 — Durable verified checkpoints and truthful operator state

- **Requirement coverage:** B05, B24, B32, F09, F10. **Regression risks:** CR07, CR09, CR11, CR15, CR18, CR22, CR23.
- **Dependencies:** IMP-08, IMP-11, IMP-12, IMP-15, IMP-21, IMP-22, IMP-23. **Disposition:** New capability or extend existing.
- **Owned surfaces/callers:** observability/status/manager projections, durable checkpoint references and recovery CLI.
- **Existing protection to retain:** observability, supervisedStart, buildResume, readinessRecovery. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Expose preparing/implementing/verifying/compacting/transferring/waiting/blocked/reconciling/completed/failed plus phase age, owner, worktree, checked scope, unresolved criteria and exact next action. Project observed failing-to-passing transitions and recoverable last verified progress.
- **Acceptance and positive/negative controls:** Returned ok:false is failure. Accepted is distinct from sent. Handoff/restart reconstructs checked scope and unresolved work without transcript archaeology or implementation replay. Checkpoint is not whole-app completion or rollback permission. Every recoverable block has a documented positive action.
- **Verification:** G1 projection integrity; G2 checkpoint crash/reopen; G3 status/manager/CLI.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-25 — Frozen policy configuration and bounded relevant execution packets

- **Requirement coverage:** B23, B25, B26, B30. **Regression risks:** CR08, CR19, CR20, CR21, CR22.
- **Dependencies:** IMP-08, IMP-10, IMP-11, IMP-16, IMP-20, IMP-23. **Disposition:** New capability or extend existing.
- **Owned surfaces/callers:** Effective configuration, role prompt compiler, history rendering, skills/examples references and docs.
- **Existing protection to retain:** qaRuntime frozen basis, unifiedContinuity, foreman, prompt tests. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Centralize effective defaults/precedence/origin and reject contradictions before provider work. Render current requirements/findings once, bounded typed history and retrievable detail. Keep canonical security/data/business constraints and loaded skill versions; expose actual context measurements. Freeze current-run policy and define reauthorization for material changes.
- **Audited preservation:** Keep supported threshold/provider/model live revisions through their existing safe-boundary validation and acknowledgement; freezing authorization does not forbid sanctioned settings changes. Retain `unifiedContinuity` and `workflowArchitecture` live-update assertions, including rejected-switch fallback. New evidence records effective revision without resetting budgets or falsely preserving affected old checks.
- **Acceptance and positive/negative controls:** Capacity overflow reports actionable failure; mandatory current findings never silently clip. Resume cannot replace frozen policy via new ambient defaults. Retrieval and slimmer packets preserve approval provenance, exact scope, unresolved findings and independent QA. Configured self-check/example changes are versioned experiments, not assumed boosters.
- **Verification:** G1 packet/policy/retrieval/capacity tests; G4 later paired measurement.
- **Decisions/compatibility:** D06; canonical default changes require explicit decision, not editing MoneyFarm rules. Apply shared migration, documentation and independent review obligations when behavior changes.

### Baseline integration checkpoint

#### IMP-26 — Baseline reliability release checkpoint and packaged regression matrix

- **Requirement coverage:** B31, B32, E04, E05, E17, R01, R02, R03, R05. **Regression risks:** CR07, CR08, CR09, CR11, CR15, CR17, CR18, CR24.
- **Dependencies:** IMP-11, IMP-12, IMP-13, IMP-14, IMP-15, IMP-16, IMP-17, IMP-18, IMP-21, IMP-24, IMP-25. **Disposition:** Verification/migration/documentation.
- **Owned surfaces/callers:** CLI packaging, launch normalization, stateTransfer, generated docs, config examples and native CI.
- **Existing protection to retain:** All relevant baseline suites; packaged alias/mode and state transfer tests. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Close every baseline ledger row with current evidence or explicit remaining limitation. Run all affected fresh/preparation/recovery/supervised/direct/detached and delivery paths against built packages. Rehearse upgrade/reopen/export/import, pending findings/questions/budgets, interrupted migration and unsupported old writer rejection.
- **Acceptance and positive/negative controls:** No known safety invariant breach enters live optimization trials. Native OS claims require actual native results; absent results narrow claims. No alias expands scope. New tables/artifacts participate in backup/transfer. Operator docs explain evidence limitations and recovery.
- **Verification:** G1, G2, G3, G5, G6; G4 baseline canary only when safely authorized.
- **Decisions/compatibility:** D12 for platform claims; this checkpoint does not authorize publication. Apply shared migration, documentation and independent review obligations when behavior changes.

### External practices

#### IMP-27 — Screen all external candidates and choose a bounded trial portfolio

- **Requirement coverage:** H01, H02, H03, H04, H05, H06, H07, H08, H09, H10, H11, H12, H13, H14, F01, F12. **Regression risks:** CR19, CR20, CR21, CR24.
- **Dependencies:** IMP-09, IMP-10. **Disposition:** Experiment planning.
- **Owned surfaces/callers:** Versioned candidate registry, primary-source capability/auth/license review and experiment manifests.
- **Existing protection to retain:** Contract examples and existing native adapter suite baseline. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Record fit, distinctive value, competing ownership, supported auth, maintenance, data exposure and disposition for every H item. Prioritize native runtime and verification tools; select only a small high-value subset for deep trials. Recheck external facts before prototype or live use.
- **Acceptance and positive/negative controls:** All 14 candidates have trial/reject/defer rationale; a documented unsuitable candidate need not get an adapter. Each trial changes one variable, has safety/stop gates, owner, artifacts and budget. No second authoritative planner or automatic commit/push is imported.
- **Verification:** G0 screened decision record; G1 manifests/conformance where executable.
- **Decisions/compatibility:** D06 D07 D11; major dependencies, paid services and exposure consult before adoption. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-28 — Native Codex and Claude capability and execution comparison

- **Requirement coverage:** H01, H02, H14, B26. **Regression risks:** CR07, CR08, CR09, CR15, CR16, CR19, CR20, CR21, CR24.
- **Dependencies:** IMP-09, IMP-25, IMP-26, IMP-27. **Disposition:** Experiment.
- **Owned surfaces/callers:** Existing adapters/codex and claude; experimental native exec/SDK/app-server runners and conformance fixture.
- **Existing protection to retain:** codex, adapters, qaHandbackSafety, unifiedContinuity, runtimeAuth. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Compare approved-intent-equivalent native workflows with Rafi. Prototype the minimum alternative bridge only if current app-server/SDK has a measured gap. Declare owner for tools, compaction, approval, cancellation and recovery; distinguish local subscription CLI from distributed SDK credentials.
- **Acceptance and positive/negative controls:** Current adapters can win. Replacement must retain identity, exact scope, permission, resume, usage and uncertainty conformance, including dropped ack/cancel/quota. Native baseline acceptance is still independently scored. Authentication terms and supported cost path are current and explicit.
- **Verification:** G1 full adapter conformance; G3 prototype invocation; G4 paired representative tasks.
- **Decisions/compatibility:** D06 D07 D11. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-29 — Focused skill, environment packet and bounded-loop hybrid trials

- **Requirement coverage:** H03, H05, H07, F08. **Regression risks:** CR02, CR04, CR16, CR19, CR21, CR23.
- **Dependencies:** IMP-09, IMP-22, IMP-23, IMP-25, IMP-26, IMP-27. **Disposition:** Experiment.
- **Owned surfaces/callers:** Versioned experimental skills/examples/prompt profiles, environment packets and loop policy.
- **Existing protection to retain:** E09 calibration plus E06 representative corpus; existing blocker/budget tests. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Trial Superpowers-style test/debug/review skills, Ralph-style bounded continuation and Deep Agents environment/verification/loop practices individually. Compare curated examples, distinct checks and generic self-check wording with size controlled; keep held-out cases separate.
- **Acceptance and positive/negative controls:** No extra mandatory product planning, competing budgets, model-done completion or publication defaults. Useful gains survive held-out independent scoring and attention measurement. Generated skills and extra reflection are not assumed improvements; negative results are retained.
- **Verification:** G1 policy/loop/permission tests; G4 paired ablations.
- **Decisions/compatibility:** D07; changes to default self-check count require explicit decision. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-30 — Durable phase state, living plans and specification interoperability trials

- **Requirement coverage:** H04, H08, H09, H12. **Regression risks:** CR07, CR08, CR09, CR13, CR19, CR21, CR22.
- **Dependencies:** IMP-09, IMP-24, IMP-25, IMP-26, IMP-27. **Disposition:** Experiment.
- **Owned surfaces/callers:** Experimental import/export maps, versioned intent/progress projections and focused planning perspectives.
- **Existing protection to retain:** ticketPopulation, structuredPlan, ticketPlan, buildResume; restart corpus. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Assess current GSD phase/fresh-context practices and OpenAI/Anthropic durable plans as Rafi projections. Evaluate OpenSpec/Spec Kit deltas and BMAD perspectives where a real acceptance gap exists. Preserve IDs, revision, approvals, dependencies and deterministic conflict/supersession handling.
- **Acceptance and positive/negative controls:** A new session reconstructs exact next work and unresolved state. Imported output remains proposal until Rafi approval. No dual execution ledger, silent scope widening or redundant whole-project planning. Report useful findings and avoided rework alongside duplicated prose/delay.
- **Verification:** G1 round-trip/revision/conflict tests; G4 selected long-context/planning tasks.
- **Decisions/compatibility:** D06; foreign proposals cannot imply user approval. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-31 — Browser CLI/skills and MCP interface comparison

- **Requirement coverage:** H11, H14. **Regression risks:** CR04, CR06, CR19, CR21, CR23.
- **Dependencies:** IMP-07, IMP-09, IMP-26, IMP-27. **Disposition:** Experiment.
- **Owned surfaces/callers:** Experimental browser tool integration profiles and existing isolated E10 harness.
- **Existing protection to retain:** E10 behavior cases, qaRuntime confinement and artifact cleanup. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Compare focused CLI/skills with persistent MCP on the same UI tasks, tracking schemas/context, persistent state, permission fit, debug artifacts, reliability and cleanup. Do not change accepted browser coverage to make a tool look faster.
- **Acceptance and positive/negative controls:** Winning interface passes equivalent functional assertions and environment classifications. Neither screenshots alone nor smaller schema size establishes success. Browser app credentials, service processes, ports, dependency writes and network exposure are isolated.
- **Verification:** G1 tool contract cases; G2 synthetic browser; G4 paired UI tasks.
- **Decisions/compatibility:** D05 D07 D11 if adoption adds meaningful dependency/exposure. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-32 — Conditional alternative-runtime and hosted capability spikes

- **Requirement coverage:** H06, H10, H14. **Regression risks:** CR15, CR16, CR19, CR20, CR21, CR23, CR24.
- **Dependencies:** IMP-09, IMP-26, IMP-27. **Disposition:** Conditional experiment.
- **Owned surfaces/callers:** Isolated Pi/OpenCode or hosted/headless prototype; no default production dependency.
- **Existing protection to retain:** Adapter conformance, representative task and one uncertainty/recovery flow. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Only if screening identifies distinct value, implement minimum Pi RPC/SDK or OpenCode typed-server bridge; assess Factory/hosted execution as a reference first. Verify supported subscription/auth path, licensing, maintenance and data/cost boundary.
- **Acceptance and positive/negative controls:** A justified defer/reject completes screening without code. Any chosen bridge runs one accepted task and recovery flow with one dispatch ledger and bounded cancellation/retry. Hosted trial cannot begin on assumed budget or data permission.
- **Verification:** G0 capability/cost/terms review; G1 conformance; G4 only approved bounded trial.
- **Decisions/compatibility:** D06 D07 D11; hosted/API trial needs explicit authorization. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-33 — Synthesize hybrid trial findings before changing production defaults

- **Requirement coverage:** F01, F11, F12, H14. **Regression risks:** CR19, CR20, CR21, CR22, CR23.
- **Dependencies:** IMP-28, IMP-29, IMP-30, IMP-31, IMP-32. **Disposition:** Decision/conditional adoption.
- **Owned surfaces/callers:** Experiment registry, compatibility profiles, ADRs and selected integration code only.
- **Existing protection to retain:** All conformance gates for selected candidates plus paired report integrity. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Adopt/revise/reject/defer every selected practice, including negative results. Import the smallest proven capability rather than whole competing harnesses. Define explicit capability fallback, versions, owner and independent disable switch for successful policies.
- **Acceptance and positive/negative controls:** Each promoted change links to raw paired outcomes, correctness/attention/recovery evidence and applicable ADR. Conditional IMP-32 may close as deferred. Unknown capabilities and authentication remain limitations; disabling an integration preserves accepted state.
- **Verification:** G0 decision review; G1/G3 adopted paths; G4 evidence summaries.
- **Decisions/compatibility:** D07 D11; evidence does not itself authorize cost/security/public API changes. Apply shared migration, documentation and independent review obligations when behavior changes.

### Evidence-driven execution improvements

#### IMP-34 — Milestone assignment semantics and recovery prototype

- **Requirement coverage:** F02. **Regression risks:** CR07, CR08, CR09, CR13, CR16, CR22.
- **Dependencies:** IMP-09, IMP-24, IMP-26, IMP-30. **Disposition:** Design/experiment.
- **Owned surfaces/callers:** Assignment model, foreman/ticketPopulation boundary and experimental milestone policy.
- **Existing protection to retain:** ticketPopulation, foreman, buildResume, durable budgets and checkpoint tests. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Define opt-in fixed milestones over existing approved tickets, dependency order, per-ticket criteria, internal checkpoints, budget and escalation. Keep public steps semantics unchanged initially. Prototype partial completion, crash and explicit subset resume before any live throughput comparison.
- **Acceptance and positive/negative controls:** Failed milestone cannot mark all tickets done. Accepted subwork is resumable, pending decisions and plan revisions still gate affected work, and explicit ticket selection is respected. Interruption does not replay accepted implementation or silently alter population/retirement.
- **Verification:** G1 milestone/partial/restart cases; G2 checkpoint crash; G4 after semantics pass.
- **Decisions/compatibility:** D08; changed public step semantics require versioned approved decision. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-35 — Calibrated adaptive review cadence experiment

- **Requirement coverage:** F03. **Regression risks:** CR01, CR04, CR05, CR13, CR22, CR23.
- **Dependencies:** IMP-09, IMP-21, IMP-23, IMP-26, IMP-34. **Disposition:** Experiment.
- **Owned surfaces/callers:** Experimental review policy, criterion risk classes and final integrated QA boundary.
- **Existing protection to retain:** E09 defect/false-alarm calibration, qaProtocolV2, branchFinalization. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Compare current every-ticket QA with milestone-end full QA and risk-triggered checkpoints while keeping mandatory executed evidence. Freeze explainable risk policy and critical acceptance classes; run seeded auth/data/migration and cross-module failures.
- **Acceptance and positive/negative controls:** Lower review time cannot conceal increased defect escape. Protected critical gates remain mandatory and final integrated source is reviewed. Unknown impact falls back to full checks. Cadence can be disabled without losing findings or accepted evidence.
- **Verification:** G1 critical gating/seeded escapes; G4 paired accepted-work/attention results.
- **Decisions/compatibility:** D09; security/acceptance posture requires consultation. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-36 — Context continuity and packet ablation by task and model

- **Requirement coverage:** F04. **Regression risks:** CR11, CR15, CR19, CR20, CR22.
- **Dependencies:** IMP-09, IMP-16, IMP-25, IMP-26, IMP-28, IMP-30. **Disposition:** Experiment.
- **Owned surfaces/callers:** Experimental persistent/compact/fresh/handoff policies and context report profiles.
- **Existing protection to retain:** unifiedContinuity, codex, E06 multi-context tasks. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Compare persistent native sessions, effective threshold compaction, fresh contexts and milestone handoffs. Vary packet reduction separately from continuity. Measure repeated exploration, lost constraints, first-work delay, transfers and recovery alongside accepted outcomes.
- **Acceptance and positive/negative controls:** No default assumes fresh or compact always wins. Mandatory frozen policy and current findings survive each strategy. Actual context occupancy and capability ceilings are used; model upgrade invalidates applicability until re-evaluated.
- **Verification:** G1 strategy conformance; G4 paired multi-context tasks.
- **Decisions/compatibility:** D07; continue using tested current policy until evidence supports promotion. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-37 — Model, effort and reviewer routing experiments

- **Requirement coverage:** F05. **Regression risks:** CR01, CR20, CR21, CR23.
- **Dependencies:** IMP-09, IMP-23, IMP-26, IMP-28. **Disposition:** Experiment.
- **Owned surfaces/callers:** Versioned experimental model/effort/routing profiles and reviewer calibration.
- **Existing protection to retain:** E09 calibrated reviewers; usage/model-switch conformance. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Compare available subscription models for planning/implementation/review/correction, including same-model and cross-model review. Record available usage/quota, accepted quality, critical misses, attention and latency; keep missing dollar counters unknown.
- **Acceptance and positive/negative controls:** Cross-model agreement/confidence is not acceptance. Routing gains are task/risk-specific and survive independent scoring. Quota fallback does not silently widen permissions, reset budgets or use paid APIs. Frozen model/profile identity remains inspectable.
- **Verification:** G1 route/quota/fallback identity tests; G4 calibrated paired comparisons.
- **Decisions/compatibility:** D07 D11 for costly fallback or new auth path. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-38 — Parallel execution architecture checkpoint and minimal isolated trial

- **Requirement coverage:** F06, H13. **Regression risks:** CR07, CR08, CR12, CR13, CR15, CR16, CR17, CR22, CR24.
- **Dependencies:** IMP-04, IMP-09, IMP-15, IMP-17, IMP-26, IMP-34. **Disposition:** Design/conditional experiment.
- **Owned surfaces/callers:** Writer admission/coordination design; isolated experimental repositories/worktrees and integration QA.
- **Existing protection to retain:** buildAdmission, qaHandbackLease, supervisedStart, branchFinalization. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Begin with read-only discovery or isolated experiment scopes. Before production writers, specify scoped leases, coordinator authority, owned files/modules/contracts, shared changes, crash recovery, serialized publication and integrated QA. Compare two independent modules rather than a swarm.
- **Acceptance and positive/negative controls:** No worktree-only bypass of singleton admission. Overlapping/shared-contract assignments block or serialize. Individually green but semantically conflicting changes fail integrated acceptance. Include startup/merge/review overhead and quotas. No production concurrency until approved architecture passes safety evidence.
- **Verification:** G0 architecture review; G1 ownership/fencing/semantic controls; G2 crash; G4 isolated trial.
- **Decisions/compatibility:** D10; retain production singleton unless replacement is explicitly approved. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-39 — Safe incremental verification and review reuse experiment

- **Requirement coverage:** F07. **Regression risks:** CR01, CR03, CR05, CR06, CR17, CR22.
- **Dependencies:** IMP-09, IMP-17, IMP-19, IMP-20, IMP-21, IMP-26, IMP-35. **Disposition:** Experiment.
- **Owned surfaces/callers:** Verification impact/coverage model, optional cache and certificate integration.
- **Existing protection to retain:** qaSnapshot, qaProtocolV2, branchFinalization; E06 cross-module controls. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Start with conservative full rechecks. Prototype reuse keyed by complete source/test/command/env/policy/approval basis and declared coverage; distinguish reusable check evidence from occurrence-specific QA certificates. Preserve full recheck on unknown impact.
- **Acceptance and positive/negative controls:** Changed dependencies, tests, environment, source basis or scope cannot unsafe-hit cache. Passing subtrees do not certify combined tree. Protected gates remain enforced and final tree acceptance binds current evidence. Cached evidence loss/retention reports unavailable rather than invented pass.
- **Verification:** G1 invalidation matrix and cross-module seeded regressions; G5 evidence retention/reopen; G4 overhead comparison.
- **Decisions/compatibility:** D09; no broader caching claims than demonstrated coverage. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-40 — Measure operator attention and choose useful execution combinations

- **Requirement coverage:** F10, F01. **Regression risks:** CR08, CR09, CR13, CR19, CR22, CR23.
- **Dependencies:** IMP-09, IMP-24, IMP-33, IMP-34, IMP-35, IMP-36, IMP-37, IMP-38, IMP-39. **Disposition:** Experiment synthesis.
- **Owned surfaces/callers:** Attention instrumentation, paired experiment portfolio and operator recovery docs.
- **Existing protection to retain:** Question/scope/recovery positive controls and calibrated report fixtures. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Compare intervention count and active time answering questions, reviewing, recovering and reconstructing intent. After single-variable tests, evaluate only promising combinations such as slim packets plus native runtime plus browser QA, or milestones plus verified checkpoints. Include disabled/deferred variants honestly.
- **Acceptance and positive/negative controls:** Lower attention does not hide decisions, unverified work or necessary cost/security choices. Report wall time separately. A combination must retain quality/recovery invariants and beat the relevant control under predefined margins; no additive gain is assumed.
- **Verification:** G1 attention accounting; G4 paired combined candidates; G0 evidence review.
- **Decisions/compatibility:** D07; no waiting for rejected/deferred prototypes to start independent analysis. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-41 — Production adoption, defaults and complexity removal

- **Requirement coverage:** F11, F12, F01. **Regression risks:** CR11, CR15, CR19, CR20, CR21, CR22, CR24.
- **Dependencies:** IMP-33, IMP-40. **Disposition:** Conditional implementation/decision.
- **Owned surfaces/callers:** Selected production policy/adapter/packet code, compatibility profiles, decision history.
- **Existing protection to retain:** Applicable baseline and candidate conformance suites. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Promote only supported winners with versioned capability/task/model profiles and independent flags. Remove measured redundant state/planning/prompts/recovery only after demonstrating equivalent authority and acceptance. Record rejected/default-unchanged decisions as valid outcomes.
- **Acceptance and positive/negative controls:** Runtime upgrade cannot silently inherit unvalidated assumptions. Each optimization can be disabled independently without losing authoritative state, pending decisions or accepted work. No code is added merely to satisfy an experiment ID; removed scaffolding has evidence and recovery coverage.
- **Verification:** G1/G2 adopted behavior; G3 package paths; G4 winning evidence; G5 affected schema.
- **Decisions/compatibility:** D07–D11 as applicable; consequential adoption requires its pending decision. Apply shared migration, documentation and independent review obligations when behavior changes.

### Rollout and continued learning

#### IMP-42 — Final compatibility and migration rehearsal

- **Requirement coverage:** R01, R02. **Regression risks:** CR01, CR05, CR11, CR15, CR16, CR17, CR23, CR24.
- **Dependencies:** IMP-26, IMP-41. **Disposition:** Migration/verification.
- **Owned surfaces/callers:** Spec/runtime/CLI package versions, buildAdmission migration, stateTransfer and evidence retention.
- **Existing protection to retain:** qaHandbackMigration, buildAdmission, stateTransfer, branchFinalization. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Use copies of realistic old states including pending questions, incomplete remediation, uncertain dispatch, handoff generation, dirty source and old certificates. Stop affected writers, capture consistent DB/evidence backups, migrate/reopen/export/import and inject interruption. Check artifacts/counts/FKs/digests/lineage/budgets.
- **Audited preservation:** Public `stateTransfer` export/import currently refuses dirty Git and live owners; test those refusals rather than weakening them. Dirty-source migration rehearsal uses disposable consistent copies through an appropriate backup path. A clean eligible transfer must still succeed. Never clean or reset user work to manufacture a passing rehearsal.
- **Acceptance and positive/negative controls:** Migration is transactional/idempotently recoverable; incompatible writers reject before mutation. No invented old proof. Supported rollback distinguishes disabling policy from database restore and reconciles later/external work before restoration. New evidence is included in transfer and privacy policy.
- **Verification:** G5 complete rehearsal, G2 crash boundaries, G3 coherent built package versions.
- **Decisions/compatibility:** D03 D05 D12; destructive restore is not authorized by rehearsal plan. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-43 — Native platform and shipped release verification

- **Requirement coverage:** R03, E05, E17. **Regression risks:** CR14, CR15, CR18, CR20, CR24.
- **Dependencies:** IMP-41, IMP-42. **Disposition:** Verification.
- **Owned surfaces/callers:** Native OS CI/runtime fixtures, packaged CLI/install artifacts and supported platform docs.
- **Existing protection to retain:** processIdentity, readinessRecovery, supervisedStart, resumePackaged, resumePty. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Run actual claimed Windows/Linux/macOS process containment, launch quoting, PTY/redirected output, Ctrl-C, detached reattachment and aliases. Test coherent built/package-resolved dependencies; detect stale dist. Record OS/Node/provider/tool versions and all skips.
- **Acceptance and positive/negative controls:** Mocks and local macOS success cannot count as native Windows/Linux sign-off. Unsupported/unverified claims are narrowed explicitly. No unexplained required skip; native cleanup/quiescence is proved and legitimate continuation passes.
- **Verification:** G2, G3, G6; full practical verification G1 for final code.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-44 — Operator, developer, AI and release documentation

- **Requirement coverage:** R05, R06. **Regression risks:** CR01, CR04, CR09, CR15, CR18, CR19, CR21, CR23, CR24.
- **Dependencies:** IMP-24, IMP-25, IMP-41, IMP-42, IMP-43. **Disposition:** Documentation.
- **Owned surfaces/callers:** Actual Rafi README, generated CLI docs, architecture/AI/eval/cost/security/operations docs, changelog and config examples.
- **Existing protection to retain:** Existing docs generation/check scripts and CLI docs tests. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Document new contracts, auth/quotas, policy precedence, criterion status, TDD exceptions, snapshots, evidence governance, exact resume scope, recovery/cancel uncertainty, migration, supported integrations/platforms and rollback. Update diagrams/API schema references and decisions index in the Rafi repo.
- **Acceptance and positive/negative controls:** A user can determine what is authorized/running/waiting/passed and the next safe action. Examples match shipped commands and config. No raw secrets enter docs/fixtures, and unavailable replay/retention limits are explicit. No MoneyFarm architecture rewrite.
- **Verification:** G0 link/config/example checks; G3 generated docs check; G1 docs tests.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-45 — Representative canary and staged operational promotion

- **Requirement coverage:** R04, F11. **Regression risks:** CR01, CR07, CR08, CR09, CR11, CR12, CR15, CR17, CR22, CR23, CR24.
- **Dependencies:** IMP-42, IMP-43, IMP-44. **Disposition:** Verification/conditional rollout.
- **Owned surfaces/callers:** Disposable canary apps, capability flags, monitoring/recovery procedures and release checklist.
- **Existing protection to retain:** Full deterministic and packaged safety gates plus selected live corpus. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Run bounded subscription-backed representative canaries against baseline/candidate pairs. Watch false completion, stale authority, duplicate dispatch, answer bypass, evidence loss, blocker loops and escaped defects. Publish remaining limitations before any authorized release/cohort rollout.
- **Acceptance and positive/negative controls:** Any invariant breach stops promotion regardless of average speed. Optional optimization flags revert independently. Canary quality/attention/latency/recovery evidence is current and comparable; historical current-only runs are not speedup evidence. No deployment/publication occurs merely because this plan says canary.
- **Verification:** G4 paired canaries after G1–G3/G5/G6; release checklist.
- **Decisions/compatibility:** D07 D11 D12; obtain operational authorization at actual release boundary. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-46 — Production failure learning and model/tool upgrade gates

- **Requirement coverage:** R07, E17, F01, F11. **Regression risks:** CR01, CR02, CR19, CR20, CR21, CR22, CR23, CR24.
- **Dependencies:** IMP-44, IMP-45. **Disposition:** New capability/operations.
- **Owned surfaces/callers:** Curated regression/example pipeline, versioned eval history, CI and upgrade runbooks.
- **Existing protection to retain:** Report integrity, privacy, seeded defect and compatibility tests. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Convert approved synthetic/redacted failure cases into regression fixtures and curated examples; reserve new held-out cases. Require comparable quality/attention/latency/usage/recovery results for prompt/model/tool/profile changes. Preserve historical failures, negative results and rollback profiles.
- **Acceptance and positive/negative controls:** Dataset consent/retention and access are respected. Held-out data is not fully injected into prompts. Gradual drift and critical regressions are visible; upgrade promotion blocks or has explicitly authorized documented exception. Tests/examples/rubrics have stable versions.
- **Verification:** G1 pipeline/report/retention checks; G4 upgrade comparison when authorized.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

#### IMP-47 — Final independent product acceptance and remaining-work report

- **Requirement coverage:** R08, E01, F12. **Regression risks:** CR01, CR02, CR07, CR08, CR09, CR12, CR15, CR17, CR22, CR23, CR24.
- **Dependencies:** IMP-45, IMP-46. **Disposition:** Independent acceptance/documentation.
- **Owned surfaces/callers:** Coverage ledger, Rafi backlog, release evidence and final product report.
- **Existing protection to retain:** All accepted baseline, migration, native and live outcomes; independent oracle. Test names refer to current suite basenames; resolve actual paths/results in IMP-01.
- **Work and value:** Reconcile all 84 requirements and 24 risks with current evidence. Distinguish baseline requirements implemented/verified from experiments adopted/rejected/deferred and conditional platforms/integrations. Independently assess substantial accepted work, bounded recovery, scope preservation, human attention and operating overhead.
- **Acceptance and positive/negative controls:** Report which task/model profiles benefit and which do not; every unresolved requirement has owner/reason/follow-up, not a fake Done. No universal-best or zero-failure claim. Backlog/ADRs/docs match the final implementation and authorized rollout state.
- **Verification:** G0 final traceability audit; inspect actual G1–G6 artifacts and all exclusions.
- **Decisions/compatibility:** None beyond existing contracts. Apply shared migration, documentation and independent review obligations when behavior changes.

## 5. Requirement-to-step traceability

Each requirement has at least one explicit step. Coverage means planned responsibility, not completed implementation; the IMP-01 ledger records actual disposition and evidence. For EVALUATE items, screening/rejection can satisfy evaluation only with the documented acceptance rationale; adoption activates full conditional conformance.

| Requirement | Planned steps |
| --- | --- |
| E01 | IMP-01, IMP-47 |
| E02 | IMP-03, IMP-19 |
| E03 | IMP-04 |
| E04 | IMP-01, IMP-26 |
| E05 | IMP-02, IMP-26, IMP-43 |
| E06 | IMP-06 |
| E07 | IMP-05 |
| E08 | IMP-06 |
| E09 | IMP-06, IMP-22 |
| E10 | IMP-07 |
| E11 | IMP-08, IMP-19 |
| E12 | IMP-08 |
| E13 | IMP-08 |
| E14 | IMP-09 |
| E15 | IMP-09 |
| E16 | IMP-09 |
| E17 | IMP-02, IMP-09, IMP-26, IMP-43, IMP-46 |
| E18 | IMP-01, IMP-09 |
| B01 | IMP-16 |
| B02 | IMP-16 |
| B03 | IMP-16 |
| B04 | IMP-12 |
| B05 | IMP-12, IMP-24 |
| B06 | IMP-12 |
| B07 | IMP-11 |
| B08 | IMP-11 |
| B09 | IMP-11 |
| B10 | IMP-13 |
| B11 | IMP-14 |
| B12 | IMP-23 |
| B13 | IMP-14 |
| B14 | IMP-15, IMP-20 |
| B15 | IMP-15 |
| B16 | IMP-15 |
| B17 | IMP-11 |
| B18 | IMP-12 |
| B19 | IMP-13, IMP-18 |
| B20 | IMP-13 |
| B21 | IMP-18, IMP-21, IMP-23 |
| B22 | IMP-17, IMP-21 |
| B23 | IMP-25 |
| B24 | IMP-24 |
| B25 | IMP-20, IMP-25 |
| B26 | IMP-10, IMP-25, IMP-28 |
| B27 | IMP-10, IMP-18, IMP-19, IMP-20, IMP-21 |
| B28 | IMP-10, IMP-19, IMP-22 |
| B29 | IMP-21, IMP-23 |
| B30 | IMP-10, IMP-25 |
| B31 | IMP-26 |
| B32 | IMP-15, IMP-24, IMP-26 |
| H01 | IMP-27, IMP-28 |
| H02 | IMP-27, IMP-28 |
| H03 | IMP-27, IMP-29 |
| H04 | IMP-27, IMP-30 |
| H05 | IMP-27, IMP-29 |
| H06 | IMP-27, IMP-32 |
| H07 | IMP-27, IMP-29 |
| H08 | IMP-27, IMP-30 |
| H09 | IMP-27, IMP-30 |
| H10 | IMP-27, IMP-32 |
| H11 | IMP-27, IMP-31 |
| H12 | IMP-27, IMP-30 |
| H13 | IMP-27, IMP-38 |
| H14 | IMP-27, IMP-28, IMP-31, IMP-32, IMP-33 |
| F01 | IMP-09, IMP-27, IMP-33, IMP-40, IMP-41, IMP-46 |
| F02 | IMP-34 |
| F03 | IMP-35 |
| F04 | IMP-36 |
| F05 | IMP-37 |
| F06 | IMP-38 |
| F07 | IMP-39 |
| F08 | IMP-29 |
| F09 | IMP-23, IMP-24 |
| F10 | IMP-24, IMP-40 |
| F11 | IMP-33, IMP-41, IMP-45, IMP-46 |
| F12 | IMP-27, IMP-33, IMP-41, IMP-47 |
| R01 | IMP-10, IMP-18, IMP-21, IMP-26, IMP-42 |
| R02 | IMP-26, IMP-42 |
| R03 | IMP-26, IMP-43 |
| R04 | IMP-45 |
| R05 | IMP-26, IMP-44 |
| R06 | IMP-08, IMP-18, IMP-44 |
| R07 | IMP-46 |
| R08 | IMP-47 |

## 6. Regression-risk ownership and release evidence

Use the full [regression review](rafi-harness-regression-review.md) for observed behavior and safeguards. The table identifies planned owners, not a substitute for CR-specific test controls. Every affected ticket must preserve existing tests and add missing regression assertions. Final acceptance checks all risk rows, including interactions between individually successful steps.

| Risk | Planned steps |
| --- | --- |
| CR01 | IMP-06, IMP-10, IMP-17, IMP-18, IMP-20, IMP-21, IMP-35, IMP-37, IMP-39, IMP-42, IMP-44, IMP-45, IMP-46, IMP-47 |
| CR02 | IMP-06, IMP-10, IMP-19, IMP-22, IMP-23, IMP-29, IMP-46, IMP-47 |
| CR03 | IMP-03, IMP-08, IMP-10, IMP-18, IMP-19, IMP-20, IMP-22, IMP-39 |
| CR04 | IMP-05, IMP-06, IMP-07, IMP-10, IMP-15, IMP-19, IMP-20, IMP-21, IMP-22, IMP-23, IMP-29, IMP-31, IMP-35, IMP-44 |
| CR05 | IMP-17, IMP-21, IMP-35, IMP-39, IMP-42 |
| CR06 | IMP-07, IMP-17, IMP-19, IMP-31, IMP-39 |
| CR07 | IMP-02, IMP-11, IMP-24, IMP-26, IMP-28, IMP-30, IMP-34, IMP-38, IMP-45, IMP-47 |
| CR08 | IMP-02, IMP-11, IMP-25, IMP-26, IMP-28, IMP-30, IMP-34, IMP-38, IMP-40, IMP-45, IMP-47 |
| CR09 | IMP-02, IMP-05, IMP-11, IMP-23, IMP-24, IMP-26, IMP-28, IMP-30, IMP-34, IMP-40, IMP-44, IMP-45, IMP-47 |
| CR10 | IMP-03, IMP-12, IMP-13, IMP-14, IMP-21 |
| CR11 | IMP-04, IMP-12, IMP-24, IMP-26, IMP-36, IMP-41, IMP-42, IMP-45 |
| CR12 | IMP-38, IMP-45, IMP-47 |
| CR13 | IMP-30, IMP-34, IMP-35, IMP-38, IMP-40 |
| CR14 | IMP-03, IMP-05, IMP-08, IMP-13, IMP-19, IMP-43 |
| CR15 | IMP-03, IMP-04, IMP-05, IMP-12, IMP-13, IMP-14, IMP-15, IMP-16, IMP-19, IMP-24, IMP-26, IMP-28, IMP-32, IMP-36, IMP-38, IMP-41, IMP-42, IMP-43, IMP-44, IMP-45, IMP-47 |
| CR16 | IMP-04, IMP-13, IMP-14, IMP-18, IMP-21, IMP-23, IMP-28, IMP-29, IMP-32, IMP-34, IMP-38, IMP-42 |
| CR17 | IMP-04, IMP-10, IMP-13, IMP-14, IMP-17, IMP-18, IMP-19, IMP-21, IMP-26, IMP-38, IMP-39, IMP-42, IMP-45, IMP-47 |
| CR18 | IMP-04, IMP-05, IMP-15, IMP-24, IMP-26, IMP-43, IMP-44 |
| CR19 | IMP-20, IMP-25, IMP-27, IMP-28, IMP-29, IMP-30, IMP-31, IMP-32, IMP-33, IMP-36, IMP-40, IMP-41, IMP-44, IMP-46 |
| CR20 | IMP-08, IMP-09, IMP-16, IMP-25, IMP-27, IMP-28, IMP-32, IMP-33, IMP-36, IMP-37, IMP-41, IMP-43, IMP-46 |
| CR21 | IMP-09, IMP-10, IMP-25, IMP-27, IMP-28, IMP-29, IMP-30, IMP-31, IMP-32, IMP-33, IMP-37, IMP-41, IMP-44, IMP-46 |
| CR22 | IMP-06, IMP-07, IMP-17, IMP-20, IMP-21, IMP-22, IMP-23, IMP-24, IMP-25, IMP-30, IMP-33, IMP-34, IMP-35, IMP-36, IMP-38, IMP-39, IMP-40, IMP-41, IMP-45, IMP-46, IMP-47 |
| CR23 | IMP-05, IMP-06, IMP-07, IMP-08, IMP-09, IMP-18, IMP-19, IMP-22, IMP-23, IMP-24, IMP-29, IMP-31, IMP-32, IMP-33, IMP-35, IMP-37, IMP-40, IMP-42, IMP-44, IMP-45, IMP-46, IMP-47 |
| CR24 | IMP-01, IMP-02, IMP-04, IMP-09, IMP-10, IMP-11, IMP-12, IMP-15, IMP-17, IMP-18, IMP-21, IMP-26, IMP-27, IMP-28, IMP-32, IMP-38, IMP-41, IMP-42, IMP-43, IMP-44, IMP-45, IMP-46, IMP-47 |

### 6.1 Codebase-backed regression test matrix

The suites below exist in the inspected reference and their relevant assertions were inspected. They were **not executed during this audit**. A listed suite may supply only part of a risk's coverage: add missing assertions, retain protected cases, and test the real production caller. IMP-01 must refresh this matrix against the actual implementation checkout.

Proposed new suite names below are planning targets, not existing files: `verificationExecution.test.ts`, `verificationCompletion.test.ts`, `verificationRedGreen.test.ts`, `verificationIsolation.test.ts`, and `verificationEvidenceMigration.test.ts`, normally under `packages/ai-foreman/test/`. Reuse existing suites where that provides clearer ownership; either way wire cases into executable gates. Parser/schema changes also need `packages/spec/test/` coverage and shipped behavior needs `packages/rafi/test/` coverage.

| Risk / owning steps | Current production surface and protected suite(s) | Required preserved or additional assertions |
| --- | --- | --- |
| CR01 / IMP-10/17/21 | [qaReview](../packages/ai-foreman/src/qaReview.ts), [qaProtocolV2 tests](../packages/ai-foreman/test/qaProtocolV2.test.ts), [parser tests](../packages/spec/test/qaFailureReport.test.ts) | New completion cases exercise initial pass, report-recovery pass, restart and finalization-only callers. Valid `qa_pass` without complete mandatory evidence never certifies the stronger contract. Complete observed evidence plus independent QA succeeds once. Preserve legacy level, QA-off policy, scoped waiver and certificate consumption. |
| CR02 / IMP-06/22/23 | [Foreman](../packages/ai-foreman/src/foreman.ts), [handback safety](../packages/ai-foreman/test/qaHandbackSafety.test.ts) | New red/green cases distinguish a real behavioral repair, already-green, documentation/refactor exception, unavailable observer, infra/compile red, fake assertion, changed/deleted assertion and target-green/neighbor-red. Check interruption and changed final test against disposable defective source. Exceptions still need postchecks. |
| CR03 / IMP-19/20/21 | [adapter events](../packages/ai-foreman/src/adapters/types.ts), [snapshot tests](../packages/ai-foreman/test/qaSnapshot.test.ts) | New execution cases prove source-at-check mapping and ordering: pass-then-edit, during-check/reverted edits, shell early failure, detached/background runner, truncated output, missing terminal, timeout/late result. Include zero selected/all-skipped tests and weakened runner filters. Stable authorized snapshot execution must pass. |
| CR04 / IMP-05/07/20/23 | [prerequisite caller](../packages/ai-foreman/src/qaPrerequisites.ts), [prerequisite tests](../packages/ai-foreman/test/qaPrerequisites.test.ts) | Preserve bounded nonmutating root probes and bounded history. Add nested/custom command, host-present/provider-denied, browser/database/network unavailable and missing source lockfile classifications. Restore prerequisite and prove fresh verification succeeds without editing correct app code or installing during read-only QA. |
| CR05 / IMP-17/19/39/42 | [source snapshot](../packages/ai-foreman/src/qaSnapshot.ts), [snapshot tests](../packages/ai-foreman/test/qaSnapshot.test.ts), [finalization tests](../packages/ai-foreman/test/branchFinalization.test.ts) | Retain stable-pair failures, staged/unstaged/untracked/binary/mode/symlink and dirty-base protections. Add original-source versus clone content/origin mapping, foreign identical-content rejection, publication-then-source revalidation, and control-evidence writes that do not self-invalidate. Do not broaden exclusions to hide app/test edits. |
| CR06 / IMP-07/17/19/31 | [dependency projection](../packages/ai-foreman/src/qaSnapshot.ts), [runtime tests](../packages/ai-foreman/test/qaRuntime.test.ts) | New isolation tests attempt writes through shared node_modules, ignored outputs, browser live/hostile endpoint, shared test DB/auth storage and port collisions. Cancelled child servers are cleaned or remain uncertain. Isolated legitimate dependency-backed/browser flows succeed; provider-required connectivity remains separately permitted. |
| CR07 / IMP-11/19/26/34 | [start scope](../packages/ai-foreman/src/cli/start.ts), [Foreman tests](../packages/ai-foreman/test/foreman.test.ts), [packaged resume](../packages/rafi/test/resumePackaged.test.mjs) | Preserve explicit blocked T001 → zero T002 mutation, bare saved-scope eligible continuation and selected ticket identity. Add verification runner and milestone dispatch/checks with the same scope; both aliases and relevant launch modes assert actual bytes and dispatch counts. `--steps` never grants scope. |
| CR08 / IMP-11/25/28/34 | [build approval](../packages/ai-foreman/src/buildApproval.ts), [stall repairs](../packages/ai-foreman/test/buildStallRepairs.test.ts), [Foreman tests](../packages/ai-foreman/test/foreman.test.ts) | Preserve unchanged approved scope starting without redundant questions, later-ticket material edits and between-turn changes requiring authorization even with yes. New packets/native/milestones cannot key approval solely by plan ID or infer approval from provider tool permission. Recompute selection after feedback. |
| CR09 / IMP-11/23/24/34 | [resume caller](../packages/rafi/src/buildResume.ts), [Foreman tests](../packages/ai-foreman/test/foreman.test.ts), [handback safety](../packages/ai-foreman/test/qaHandbackSafety.test.ts) | Resume without an answer dispatches no affected work. Preserve run-wide versus ticket waits, foreign/empty/stale/out-of-scope answer rejection and idempotent consumption. Test superseded question → current answer → scoped continuation after restart; pending QA cannot hide behind tracker Done. |
| CR10 / IMP-12/13/21/28 | [handback/QA caller](../packages/ai-foreman/src/qaReview.ts), [handback safety](../packages/ai-foreman/test/qaHandbackSafety.test.ts), [Foreman tests](../packages/ai-foreman/test/foreman.test.ts) | Preserve both-provider full wrapper valid/repair/tool/error/missing-observer branches. Implementation bytes changed plus malformed/missing marker never replays implementation just to repair response. Provider error plus done completes zero steps, including QA-off. QA-only recovery has zero new Builder dispatch. |
| CR11 / IMP-12/19/36/38 | [continuity](../packages/ai-foreman/src/continuity.ts), [unified continuity](../packages/ai-foreman/test/unifiedContinuity.test.ts), [handoff crash](../packages/ai-foreman/test/handoffCrash.test.ts) | Preserve generation high-water, sole role lease, response-only ownership validation, exact acceptance receipt and rejection retaining predecessor. Test valid/invalid/error/unknown for both roles, two resumptions, stale writes and accepted-but-idle positive dispatch. Fresh context does not replenish durable budgets. |
| CR12 / IMP-15/38/41 | [admission fences](../packages/ai-foreman/src/buildAdmission.ts), [admission tests](../packages/ai-foreman/test/buildAdmission.test.ts), [lease tests](../packages/ai-foreman/test/qaHandbackLease.test.ts) | Existing singleton competing-start/stale-connection cases stay enabled. Production parallel experiment adds allowed isolated ownership, rejected shared paths/contracts, two coordinators, stale writer/cancel races, serialized publication and integrated semantic defects. Worktree creation cannot disable fences. |
| CR13 / IMP-30/34/35 | [ticket population](../packages/ai-foreman/src/ticketPopulation.ts), [population tests](../packages/ai-foreman/test/ticketPopulation.test.ts), [Foreman tests](../packages/ai-foreman/test/foreman.test.ts) | Preserve exact mappings, stable IDs, explicit retirement and unrelated tickets. New milestones cover done-second/blocked-first, partial completion, crash/checkpoint recovery, selected subset and 0/1/N remaining steps. Imported deltas cannot duplicate tickets or complete unfinished criteria. |
| CR14 / IMP-03/13/19 | [recovering adapter](../packages/ai-foreman/src/adapters/recovering.ts), [handback safety](../packages/ai-foreman/test/qaHandbackSafety.test.ts) | Preserve synchronous provider observation before send resolves and non-stealing consumers. Add simultaneous display/journal/validation, subevents near terminal, duplicate events, throwing/slow observers, adapter replacement, queue flood and repeated cleanup. Missing required proof blocks acceptance; optional observer failure creates no authority. |
| CR15 / IMP-14/15/19/28 | [shared deadline](../packages/ai-foreman/src/util/deadline.ts), [supervised start](../packages/ai-foreman/test/supervisedStart.test.ts), [stall repairs](../packages/ai-foreman/test/buildStallRepairs.test.ts) | Preserve exhausted outer budget not starting next phase and cleanup errors not extending it. New runner/native cases cover lost ack, timeout/late success, durable cancel, transport loss, hung child and parent death with zero blind replay. Healthy long work passes; known unsent can retry after authorized reconciliation. |
| CR16 / IMP-14/18/21/23 | [workflow budgets](../packages/ai-foreman/src/workflowDb.ts), [stall repairs](../packages/ai-foreman/test/buildStallRepairs.test.ts), [handback safety](../packages/ai-foreman/test/qaHandbackSafety.test.ts) | Preserve reopen/wording/checkpoint non-reset, competing reservation and single-use scoped grants. Add all provider/wrapper/continuity/verification allowance interactions at 0/1/N. Final allowed fix gets QA pass/fail recheck without another fix. Overrides/disputes never become waivers. |
| CR17 / IMP-04/18/19/42 | [workflow evidence](../packages/ai-foreman/src/workflowDb.ts), [migration tests](../packages/ai-foreman/test/qaHandbackMigration.test.ts), [admission tests](../packages/ai-foreman/test/buildAdmission.test.ts) | Preserve different occurrences with identical content and interrupted/ambiguous migration rollback. New evidence cases cover atomic DB BLOB/ref commit, external write-before-ref if adopted, dangling ref prevention, item size boundaries/oversized output, busy/disk faults, conflicting same-occurrence replay, CAS and incompatible old writes. |
| CR18 / IMP-15/19/26/43 | [readiness recovery](../packages/ai-foreman/test/readinessRecovery.test.ts), [lease tests](../packages/ai-foreman/test/qaHandbackLease.test.ts) | Preserve restricted connection rejection, live/unknown owner protection, PID reuse, foreign-project/cyclic provenance and competing reconcilers. New check runner cannot get general authority through readiness. Confirm cleanup then legitimate continuation; native Job/helper and Unix descendants need actual platform evidence. |
| CR19 / IMP-25/29/30/36 | [frozen QA runtime](../packages/ai-foreman/src/qaRuntime.ts), [runtime tests](../packages/ai-foreman/test/qaRuntime.test.ts), [prerequisite/history tests](../packages/ai-foreman/test/qaPrerequisites.test.ts) | Preserve actual effective settings/confinement and bounded UTF-8/nonrecursive history. New packet/retrieval tests retain mandatory security/business/scope/current findings and loaded artifact versions across resume/compaction. Capacity overflow is actionable; no silent clipping or basis-equivalent reuse across changed policy. |
| CR20 / IMP-16/25/28/37 | [Codex usage/context](../packages/ai-foreman/src/adapters/codex.ts), [Codex tests](../packages/ai-foreman/test/codex.test.ts), [unified continuity](../packages/ai-foreman/test/unifiedContinuity.test.ts), [workflow architecture](../packages/ai-foreman/test/workflowArchitecture.test.ts) | Preserve current/cumulative distinction, fresh correlated usage and effective native ceilings. Preserve threshold-only reconfigure-before-ack, validated provider revision and rejected live-switch fallback. Foreign/stale samples, model changes, quota and unknown cost cannot reset counters or falsify occupancy. |
| CR21 / IMP-27/28/32/33 | [adapter contracts](../packages/ai-foreman/src/adapters/types.ts), [handback safety](../packages/ai-foreman/test/qaHandbackSafety.test.ts), [runtime auth](../packages/ai-foreman/test/runtimeAuth.test.ts) | New integration conformance proves one owner of each dispatch/retry/tool/compaction/publication responsibility. External done/plan approval cannot accept or widen work. Test permission/auth settings separately from QA policy, loss of ack/cancel and unsupported capability fallbacks. No automatic commit/push or assumed subscription credentials. |
| CR22 / IMP-21/24/35/38/39 | [finalization](../packages/ai-foreman/src/branch/runner.ts), [finalization tests](../packages/ai-foreman/test/branchFinalization.test.ts), [QA protocol tests](../packages/ai-foreman/test/qaProtocolV2.test.ts) | Preserve final-tree/source/certificate guards. New cadence/cache/checkpoint cases include passing components with broken integration, changed test/command/env/policy, unresolved criteria and invalidated checkpoint. Protected checks cannot be skipped, cache reuse is coverage-bound, and checkpoint cannot authorize rollback. |
| CR23 / IMP-08/09/18/24/46 | [observability tests](../packages/ai-foreman/test/observability.test.ts), [read-only audit cases](../packages/ai-foreman/test/qaHandbackSafety.test.ts) | Preserve no-write inspection, interval unions, usage scope, bounded manager packets and retained summaries. Add protected proof pruning/export/reopen, raw/string/Buffer secret handling, changed redacted digest and failed/blocked/cancelled/rerun accounting. Independent oracles and runner coverage cannot be builder-weakened. |
| CR24 / IMP-02/26/42/43 | [packaged aliases](../packages/rafi/test/resumePackaged.test.mjs), [admission](../packages/ai-foreman/test/buildAdmission.test.ts), [state transfer](../packages/ai-foreman/test/stateTransfer.test.ts) | Preserve both aliases and actual command arguments/implementation bytes, dirty-transfer/live-owner refusal and import rollback. Add coherent packed CLI/spec/runtime install smoke in disposable state with resolved versions recorded, stale-dist detection and new evidence transfer. Claimed OS paths execute natively with required cases not skipped. |

### 6.2 Required new verification-case groups

These groups distinguish new behavior from existing source-bound QA coverage. Attach stable case IDs to the actual test functions in IMP-01/18–22; suite names alone do not close the rows.

| Case group | Mandatory behavior | Gates and owner |
| --- | --- | --- |
| VT01 — Source and identity | Original source, snapshot content and execution origin are explicitly bound; foreign identical content and post-check edits rejected | G1/G2; IMP-19/21 |
| VT02 — Observation and ordering | Both providers through wrappers; terminal/drain/fan-out completeness; partial, background, duplicate and late events | G1/G2; IMP-03/13/19 |
| VT03 — Acceptance paths | Initial, recovered, finalization-only and approved QA-off/legacy behavior; valid marker without proof rejected; genuine complete work accepted once | G1/G3/G5; IMP-21 |
| VT04 — Practical TDD | Meaningful same-check red→green with neighboring green; exceptions and changed test definitions; fake/infra red not credited | G1/G2; IMP-06/22 |
| VT05 — Check-set integrity | Zero/all-skipped/filtered-out tests, deleted/weak assertions, changed config or classification cannot reduce mandatory coverage | G1/G3; IMP-06/20/21/22 |
| VT06 — Environment and confinement | Host/provider mismatch, nested/custom commands, immutable/dependency boundaries and isolated browser/services/data/auth | G1/G2; IMP-07/19/20 |
| VT07 — Runner authority and recovery | Original admission/scope, durable reservations/cancel, deadlines/owned children and uncertain no-replay | G1/G2/G3; IMP-14/15/19 |
| VT08 — Evidence durability | DB/external artifact ordering, size limits, conflicts/CAS, WAL reopen, old-writer fences and copied-state migration | G1/G2/G5; IMP-04/18/42 |
| VT09 — Settings and invalidation | Sanctioned safe-boundary live revisions preserved; ambient defaults cannot replace authority; affected evidence invalidated | G1; IMP-16/25 |
| VT10 — Privacy and control storage | No secret exposure, raw/redacted provenance preserved, mandatory proof survives allowed pruning; own receipts cannot hide app changes or cause invalidation loops | G1/G5; IMP-08/18/24 |
| VT11 — Checkpoint and integration | Checked scope/unresolved work preserved after crash; final integrated source recertified; no checkpoint rollback permission | G1/G2; IMP-24/34/35/38/39 |
| VT12 — Shipping and gate selection | Required tests actually selected, package-resolved bytes correct, both aliases work, supported native cases execute and missing claims remain explicit | G1/G3/G6; IMP-02/26/43 |

## 7. Critical dependency chains and implementation boundaries

- **Completion evidence:** IMP-10 → IMP-18 → IMP-19 → IMP-20 → IMP-21 → IMP-22 → IMP-23/24. Do not deploy a schema-only certificate change that accepts summaries as execution proof, or an observer-only gate without compatibility and independent QA.
- **Recovery authority:** IMP-11/12/13/14/15/17 preserve scope, leases, budgets, questions and uncertainty before new defaults. A missing assertion is a fixture task; a reproduced gap is a narrow repair.
- **Milestones:** IMP-24/26/30 → IMP-34 → IMP-35/40. The population, step-count and partial-completion design precedes reduced review cadence.
- **Parallel writers:** IMP-04/15/17/26 → D10/IMP-38. Existing singleton fences stay enabled until a proven scoped authority design replaces them; worktrees alone are insufficient.
- **Review reuse:** IMP-18/19/20/21/26/35 → IMP-39. Stable basis/coverage and certificate semantics precede cache speed comparisons.
- **Shipping:** IMP-41 → IMP-42 → IMP-43 → IMP-44 → IMP-45 → IMP-46 → IMP-47. Migrations and packaged/native results precede operational rollout.

These are review boundaries, not permission to run multiple writers. Independent tests, corpora, docs and read-only screening can be scheduled concurrently when authorized, but shared `workflowDb`, admission, adapter types and QA contracts need one coordinated owner. Schema migration, exclusion of old writers and transfer support form one atomic delivery slice. Keep prototype code isolated and disabled by default.

### Suggested child-ticket boundaries for the largest steps

These splits prevent a broad step from becoming an unreviewable implementation assignment. Child tickets inherit parent requirements/risks and may not weaken the parent exit gate. Select exact files and commands after IMP-01; do not create speculative rewrites of verified code.

| Parent | Suggested ordered child tickets | Integration gate |
| --- | --- | --- |
| IMP-03/04 | Shared fake clock/provider contract; wrapper/event ordering controls; durable artifact fault hooks; actual kill/reopen fixtures; seeded race corpus | Real callers retain authority and legitimate continuation across the whole fixture stack |
| IMP-06/07 | Task snapshot/rubric format; known-good/seeded-bad oracle; repair/red-green cases; UI service isolation; functional/accessibility cases | Independent oracle integrity and reusable disposable environment |
| IMP-18 | Versioned spec/example contracts; additive persistence with migration/fences; artifact integrity and idempotency; transfer/privacy/reopen coverage | Storage changes ship with writer compatibility and evidence preservation, even if higher-level enforcement is still disabled |
| IMP-19 | Capture-boundary prototype; complete runner result/basis binding; safe adapter observation; partial/background/late-event cases; resource cleanup | No completion-critical evidence is accepted from an incomplete or incorrectly bound occurrence |
| IMP-20/21 | Criterion/check compiler; prerequisites and actual command discovery; review-basis evidence binding; fresh/recovered enforcement; finalization/QA-off/legacy behavior | Every completion route enforces the approved contract without replacing independent QA |
| IMP-22/23/24 | TDD applicability; ordered red/green attribution; test-integrity controls; calibrated findings/blocker convergence; checkpoint recovery; operator projection | Verified progress and unresolved work remain truthful through interruptions |
| IMP-25 | Effective frozen settings; task packet compiler; bounded history; retrieval/version identity; actual context measurement | Mandatory policy/scope/current findings survive every packet strategy |
| IMP-34/35 | Milestone/step semantics; per-ticket checkpoint/recovery; internal verification; protected risk classes; cadence comparison | Larger chunks cannot weaken ticket acceptance or hide partial failures |
| IMP-38 | Scoped authority design only; read-only or isolated trial; overlap/shared-contract detection; admission/crash prototype; integrated QA and serialized publication | Production singleton remains until reviewed replacement and consequential decision are approved |
| IMP-42/43 | Schema/version inventory; consistent copied-state backups; migration/fault/transfer rehearsal; actual built package resolution; native OS matrix | No release from helper-only, stale-artifact or mocked-platform evidence |

Do not spread one authoritative schema transition over independently releasable tickets without compatible intermediate states and feature gating. A schema can be additive before enforcement; a new acceptance claim cannot precede its complete capture, certificate and compatibility protections.

## 8. Decision and experiment discipline

Carry D01–D12 from the [design brief](rafi-harness-implementation-design.md) into the Rafi backlog with owner, proposed choice, evidence, affected steps and decision status. Do not mark a proposal approved because it appears in a plan. Ask the user only when the affected consequential decision is concrete; finish independent preparation first.

Every live experiment manifest records hypothesis, exact baseline/candidate versions, one changed variable, task/rubric/held-out split, model/effort, permission/environment equality, seed/order, quotas, retry policy, check coverage, evidence level, expected improvement and safety/stop margins. Report accepted completion, partial criteria, critical defects/false blockers, recovery behavior, human active attention, wall/phase time, usage/quota and maintenance overhead. Retain every cancelled, blocked, failed, timed-out and rerun attempt; identify evaluator failures separately.

The minimum canary repetitions begin variance measurement. Choose larger sample sizes from variance and decision importance. Predefine what constitutes material quality/attention change with the owner; this plan intentionally does not invent percentages or p-values. Critical invariant breaches always veto promotion. Fixed-model isolated improvements precede useful combination trials, and provider/version changes are confounders rather than hidden differences.

Recommended first hybrids to compare: Rafi approved intent and evidence with native Codex/Claude execution; focused tested skills/environment packets; browser-backed acceptance; and durable living plans/checkpoints projected from Rafi state. Larger milestones follow trustworthy verification. Production parallelism and new hosted adapters are later conditional options, rather than prerequisites for reliable large chunks.

### 8.1 Initial experiment matrix

All comparisons use IMP-09's paired runner and independent acceptance. Screening may reject/defer a candidate before live trials; retain the reason. Models, effort, tools, permissions and task states are held equivalent unless that row explicitly varies them.

| Experiment | Control → candidate | Primary outcomes and decisive negative controls | Owner |
| --- | --- | --- | --- |
| Native execution | Current Rafi adapter → equivalent native Codex/Claude workflow or minimal bridge | Accepted work, attention, overhead; lost identity, cancellation, scope or uncertain replay vetoes | IMP-28 |
| Focused skills/examples | Current instructions → one curated debugging/TDD/review skill or example policy | Held-out correctness and attention; context overhead, fake red and example leakage | IMP-29 |
| Environment/verification middleware | Current packet/loop → environment packet, verification hook or cause-aware stop, independently | Blocker accuracy, convergence, bounded retries; healthy long work must continue | IMP-29 |
| Phase/living plans | Current durable resume → focused phase packet and verified progress projection | Repeated exploration, lost requirements and recovery; stale projections cannot acquire authority | IMP-30 |
| Spec/planning perspectives | Approved Rafi plan → mapped proposal/delta or focused additional perspective | Useful missing criteria/rework avoided versus delay; no inferred approval or dual backlog | IMP-30 |
| Browser tooling | Equivalent UI checks through CLI/skills → persistent MCP, or reverse | Functional success, context, reliability/artifacts; identical UI assertions and confinement | IMP-31 |
| Alternative/hosted runtime | Native subscription control → screened minimal alternative bridge | Capability/recovery benefit and full cost/exposure; no assumed subscription entitlement | IMP-32 |
| Milestones | One-ticket strategy → bounded approved multi-ticket assignment | Accepted throughput, attention, recovery; partial completion, steps and selective resume integrity | IMP-34 |
| Review cadence | Every-ticket QA → milestone-end or risk-triggered QA | Critical escape/false blockers and attention; integrated source and protected checks remain gated | IMP-35 |
| Context strategy | Current continuity → persistent, threshold compact, fresh, handoff; packet size varied separately | Accepted work, re-exploration, constraint loss, delay, recovery; provider usage semantics preserved | IMP-36 |
| Model/reviewer routing | Existing model/effort/reviewer → supported subscription variant | Calibrated defects, acceptance, attention, quota, latency; agreement/confidence is not the oracle | IMP-37 |
| Parallelism | Sequential isolated modules → two partitioned assignments | Integrated accepted throughput including merge/review overhead; lease and semantic-conflict controls | IMP-38 |
| Verification reuse | Full applicable checks/review → declared impact-based reuse | Same defect detection with lower overhead; changed basis/coverage and cross-module traps | IMP-39 |
| Combinations and attention | Best relevant control → only independently promising combinations | Accepted quality/recovery plus measured active human time; no hidden decisions or excluded failures | IMP-40 |

### 8.2 Schema, protocol and public contract impact inventory

These are proposed impact areas, not approved field names or a demand to replace existing structures. IMP-10 and IMP-18 choose minimal changes. Capture exact versioning and migration decisions before code uses a new contract.

| Surface | Potential change | Compatibility obligation | Owning steps |
| --- | --- | --- | --- |
| Approved plan/ticket criteria | Stable criterion/check revisions and required evidence mapping | Preserve exact approved slices, dependencies, retirement and proposal approval semantics | IMP-10/20/30/34 |
| Adapter events/capabilities | Observation completeness, tool correlation, actual source-at-check capture | Optional/unsupported fields remain unavailable; wrappers preserve identity, fan-out and terminal order | IMP-10/13/19/28 |
| Workflow storage and evidence | Execution occurrences, criterion dispositions and checkpoint references | Atomic reservation/revision fences, evidence before refs, distinct occurrence/content identity, old-writer exclusion | IMP-18/19/24/42 |
| QA report/review basis/certificate | Bound check evidence and mandatory-criterion completeness | Independent review, single-use finalization, source revalidation, legacy evidence level and scoped waivers | IMP-10/17/21/42 |
| Status/manager/progress projections | Verified scope, missing checks, red/green transitions and uncertainty | Read-only projections; authoritative state is not inferred from human-readable summaries | IMP-08/24/44 |
| Effective policy/configuration | Versioned strategy, evidence, example and capability profiles | Defined defaults/origin/precedence; frozen current runs cannot silently adopt new ambient policy | IMP-25/33/41 |
| Start/resume/step semantics | Milestone execution or new recovery views if adopted | Both aliases, explicit invocation scope, remaining authorized counts and launch gates; public behavior changes require decision | IMP-11/12/26/34 |
| Admission and writer ownership | Scoped authority only if parallel production execution is adopted | Existing singleton remains default; one coordinator, shared-contract fencing, crash and publication integration | IMP-38 |
| Backup/export/import/retention | New artifact classes and protected evidence refs | Consistent DB/artifact capture, path/lineage handling, privacy, missing-proof classification and uncertain remote outcomes | IMP-18/42/44 |
| Published packages/generated docs | Coherent spec/runtime/CLI versions and documented commands | Actual resolved package bytes, no stale dist, native supported-platform evidence | IMP-26/43/44 |

### 8.3 Risk priority and stop conditions

Treat CR01/03/05/22 as acceptance-integrity gates; CR07–12/15 as scope, ownership and duplicate-execution gates; CR14/17/18 as event/storage/cleanup-authority gates; and CR19/21 as policy/integration gates. Any reproduced breach is P0 and blocks affected live or release paths until a targeted regression and repair pass. These labels describe consequences, not confirmed current defects.

CR02/04/13/16/20 address practical quality, environment diagnosis, ticket semantics, budget continuation and provider accounting; they are necessary P1 baseline protections. CR06/23/24 cover confinement, evidence governance and shipped/platform integrity and can also veto promotion. Critical misses and data/execution integrity failures cannot be offset by faster averages or fewer user questions.

Optional trials may stop as rejected/deferred when conformance, supported authentication, budget, distinct benefit or maintenance justification is absent. Stop at the affected boundary; continue unrelated deterministic fixtures and documented baseline verification. Failure to observe a command cannot be resolved by weakening mandatory evidence or fabricating a legacy result.

## 9. Completion packet for each step and final acceptance

A step's review packet contains its requirement/CR IDs, actual production caller, before/after behavior or verified-existing finding, source/package versions, observed test results and limitations, negative and positive controls, migration/privacy/permission effects, updated docs/ADRs/backlog, and remaining questions. Test changes explain which expectation changed and why. Plans and reports cannot substitute for executed results.

IMP-47's final report must reconcile all 84 requirements and 24 risks; distinguish accepted production behavior from prototypes and unverified platform claims; link independent substantial-work acceptance; state model/task-specific gains and negative findings; and publish remaining scoped follow-ups. No universal best-harness claim is required. A safer, simpler coordinator with verified work and honest recovery is the product outcome.

## 10. Validation of this planning document

During preparation, source package scripts and existing test locations were inspected. Document checks validate all requirement/risk mappings, unique ordered step IDs, dependency references/acyclicity, local links, whitespace and Markdown fences. These are planning checks only. Runtime suites, provider trials, migrations and native platform checks remain implementation work; no dependencies were installed or application/reference source changed.

### Audit and revision — 2026-10-09

The audit reconciled the design and plan against all 84 requirements and inspected actual QA pass/recovery/finalization, start/resume scope, adapter observation, workflow evidence/admission, snapshot projection, deadlines and existing regression assertions. All 47 steps remain; no requirement or CR risk was dropped.

Corrections made: added an enforceable regression-test manifest/CI selection contract; mapped CR01–CR24 to protected suites and missing assertions; specified VT01–VT12 for new verification behavior; added accounting/scope/ownership/cleanup dependencies before the check runner; preserved sanctioned live settings, SQLite evidence semantics and dirty-transfer refusals; distinguished clone content mapping from original source authority; and protected against zero/skipped/filtered tests, evidence self-invalidation, incomplete output and relaxed confinement. State-machine/seeded controls and pausable eval dispatch are now explicit.

Existing regression suites are preservation obligations, not fresh passing results. New execution evidence, completion-contract and red/green suites are planning targets. Dependencies were not installed; runtime commands were not run because the reference lacks `node_modules` and its local `tsx` test runner. The remaining runtime risk is unverified behavior in the actual implementation environment; IMP-01/02 must establish it before code changes. This audit's successful document checks do not certify production reliability.
