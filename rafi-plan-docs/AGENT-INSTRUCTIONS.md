# Agent instructions: implement the Rafi improvement plan

Prepared 2026-10-10. Scope: Rafi's engineering harness, all six phases in the [implementation plan](rafi-harness-implementation-plan.md). This is an implementation workflow for an agent the user starts in the actual Rafi repository. The user's request and applicable repository instructions govern authorization; this file does not replace the repository's canonical agent rules.

## 1. Your objective and sources of truth

Improve reliable delivery of substantial approved application work, with independent verification, bounded recovery, truthful progress and lower avoidable human attention. Prefer supported existing Codex/Claude subscriptions. Preserve Rafi's approved intent, ticket provenance, dependency eligibility, writer authority, budgets, uncertainty, independent QA and source-bound finalization.

Read repository `AGENTS.md` or the applicable equivalent, then this package in README order. The [requirements](rafi-harness-requirements.md) define acceptance; the [regression review](rafi-harness-regression-review.md) defines preservation hazards; the [design brief](rafi-harness-implementation-design.md) defines proposed boundaries and pending choices; the [plan](rafi-harness-implementation-plan.md) supplies order and review gates. Resolve any inconsistency explicitly against user instructions and current implementation; do not silently drop a requirement or weaken a safeguard.

Distinguish four outcomes: verified existing, newly repaired/implemented, experiment adopted, and experiment rejected/deferred with evidence. Many baseline repairs may already exist. Verify rather than rewrite them. Baseline MUST requirements still need current evidence; they cannot close merely as optional deferral.

## 2. First execution session: IMP-01 and IMP-02

1. Confirm the checkout is Rafi: inspect `pwd`, Git root/branch/status, applicable instructions, package manifests, lockfile, workspace configuration, source/test paths and existing tracker. Inspect changes before editing; preserve all user-owned work. Receiving this folder in the real Rafi repo can resolve D01 without asking for a path already evident from context.
2. Compare current versions/source with the historical reference commit. Read existing build-stall, QA handback and build-resume investigation/repair documents, including later superseding audits. Report historical repairs as historical until verified on current production paths.
3. Discover actual install/build/test/typecheck/docs/lint commands and native prerequisites. Use the repository package manager and lockfile. Install existing locked dependencies in the authorized development checkout where needed; do not upgrade packages or add major dependencies as incidental setup. Follow native-module troubleshooting instructions if relevant.
4. Run the package validator. Reconcile moved/renamed source links rather than treating the historical snapshot as authoritative. Establish deterministic baseline results on disposable repositories/databases before behavior changes. Build prerequisite artifacts when tests import `dist`; never test stale artifacts and call that current source validation.
5. Create the coverage ledger, separate implementation backlog, decision register and progress record described below. Map all 84 requirements, CR01–CR24, IMP-01–IMP-47 and VT01–VT12. Record actual callers, assertions, commands/results and limitations.
6. Distinguish unrelated preexisting failures, environment blockers and newly reproduced defects. A reproduced safety defect gets a narrow regression/repair as soon as practical; do not wait for the entire benchmark system. Quarantine unsafe live configurations while continuing safe fixture work.

Do this work, then continue to dependency-ready implementation. Do not stop after repeating the plan or asking the user to approve ordinary read-only inventory, local test setup or already-authorized reversible work.

## 3. Durable implementation tracking

Use an existing configured Rafi tracker where appropriate; otherwise create `docs/rafi-harness-backlog.md`. Link it from the repository's actual ticket index. Do not add these tickets to a sample application's queue or trigger a live application build to track harness work.

Suggested additional locations, adaptable to repository conventions:

- `docs/rafi-harness-coverage.md`: requirement, disposition, current code/caller, protected/new tests, command/result, evidence reference, remaining gap and owning ticket.
- `docs/rafi-harness-decisions.md`: D01–D12 and consequential ADR links, proposed alternatives, affected steps, status, evidence and actual approval where required.
- `docs/rafi-harness-progress.md`: current revision/worktree, completed/active/blocked steps, last verified progress, exact next work, pending decisions, test baseline, uncertainty and evidence references.
- Existing ignored artifact storage: raw/protected test, migration and eval evidence. Keep versioned sanitized summaries where appropriate. Do not commit credentials, private prompts or large sensitive transcripts.

Keep IMP IDs stable; split large steps into child tickets such as `IMP-19.1`. Each ticket includes status/priority/value, requirements, CR risks, exact owned files and production caller, dependencies/decisions, current gap, test impact manifest, observable acceptance, verification commands, compatibility/privacy/docs obligations and review boundary. Use repository status conventions. Done requires evidence, not a written summary alone.

These are suggested files to create during implementation, not pretend-existing records supplied by this handoff. Update them after every reviewable slice and before a session ends. A fresh agent must be able to identify unfinished authorized work without rereading the full transcript.

## 4. Work sequence across all phases

Follow the plan's explicit dependency edges, including the audited scope/owner/budget/cleanup prerequisites before IMP-19 launches checks. Use its suggested first sequence, then finish remaining fixtures and baseline preservation before promoting experimental behavior.

| Phase | Steps | Required outcome |
| --- | --- | --- |
| 0: inventory/design | IMP-01–02 and IMP-10 | Current baseline, ledger and reviewed contracts; unresolved consequential decisions remain explicit |
| 1: tests/evals | IMP-03–09 | Deterministic provider/fault fixtures, calibrated independent oracles, isolated app/browser corpus, honest telemetry and bounded opt-in comparisons |
| 2: reliability/quality | IMP-11–26 | Existing repairs protected; missing behavior implemented; executed check evidence and practical red/green integrated with independent QA/recovery/finalization |
| 3: other harnesses | IMP-27–33 | All named candidates screened; only useful subset trialed; supported auth and one owner per responsibility; measured adopt/reject/defer results |
| 4: evidence-driven improvements | IMP-34–41 | Milestones, review cadence, context, routing, parallelism and reuse evaluated; only supported winners become defaults |
| 5: compatibility/release/learning | IMP-42–47 | Migration/native/package evidence, docs, canary results, authorized operational promotion and independent acceptance |

Do not implement every external harness merely because it has an H ID. Keep baseline behavior while experiments are disabled. A justified rejection/defer can complete an optional evaluation; it does not complete an adopted feature's conformance. Large milestones, reduced QA or production parallelism are hypotheses requiring their contract decisions and tests.

This package does not itself authorize subagent delegation. Follow the user's and active repository/session rules; if delegation is authorized, assign exact file ownership and coordinate shared contracts. Never confuse agent scheduling with permission for parallel production writers.

## 5. Mandatory test-first regression workflow

For each behavior slice, use the plan's mandatory regression-test contract and CR test matrix:

1. Identify the real production caller and exact protected existing assertions. Record the test impact manifest before editing.
2. Add a meaningful failing regression or new behavioral control first where practical. A defect test must fail for the target behavior, not an unrelated setup error. Record justified TDD exceptions.
3. Implement the smallest missing behavior and retain existing invariants. Refactor only within the necessary boundary.
4. Run the changed behavior tests and protected existing cases. Include negative safety assertions and successful legitimate continuation after reconciliation or prerequisite restoration.
5. Run applicable typecheck/static/lint/format, full practical tests, rebuilt package, migration and smoke/E2E gates from G0–G6. Discover current commands rather than treating reference examples as guaranteed runnable.
6. Ensure CI/repeatable scripts actually select these cases before shipping. Archive executed/skipped counts, test IDs, seeds, source and resolved package versions, exit/outcome and justified skips. Zero selected/all-skipped, stale `dist`, missing provider branches or filtered-out safety cases cannot count as passing.
7. Review independently against original acceptance and CR safeguards. Report tests changed and why. Update coverage/backlog/progress and affected docs.

Do not delete, weaken, skip or rewrite protected assertions to make an implementation green. An obsolete expectation needs an explicit contract decision and replacement coverage. Live tests are separate from ordinary offline tests; native-OS claims require actual native execution. If a required gate cannot run, record the exact reason and leave its claim/promotion pending; continue useful unaffected work.

## 6. Invariants to preserve in every implementation

- **Scope and approvals:** saved context is not invocation permission. Explicit ticket selection cannot substitute another ticket; unchanged approvals can be reused, material changes must revalidate. Resume is not an answer. Preserve pending QA and correctly scoped durable questions.
- **Ownership and uncertainty:** keep original admission/lease fences and generation high-water marks. Timeout/close/heartbeat does not prove stopped execution. Reconcile uncertain effects before replay. The check runner is an execution boundary with the same scope, budgets, cancellation and owned-child protections.
- **Correction and budgets:** malformed output never causes implementation replay just to fix formatting. Response-only repairs are observed and bounded. Budgets survive wrappers/sessions/restarts/aliases. Last permitted fix still receives an independent recheck; overrides/disputes are not waivers.
- **Verification:** bind criterion/check identity, actual tested source/test/env basis, execution order/completeness and evidence. Independent QA remains required where configured; valid `qa_pass` alone is not mandatory execution proof. Initial/recovered/finalization paths enforce the agreed versioned contract.
- **Practical red/green:** genuine behavioral failure → same meaningful check passing → related regression checks green. Infra/fake red, deleted assertions or fabricated output do not count. Already-green and justified exceptions remain honestly classified with postchecks.
- **Snapshot and isolation:** distinguish original source authority, snapshot content mapping and execution origin. Disposable is not automatically immutable. Preserve staged/untracked/binary/mode/symlink/dirty-base protection; prevent dependency write-through and live app/data/auth reuse. Control receipts cannot hide product changes or cause endless self-invalidation.
- **Durability and privacy:** retain occurrence identity separately from content digest; respect CAS/fences/size limits. SQLite BLOB/ref writes may commit atomically; external evidence precedes references if adopted. Preserve raw/redacted provenance and protected evidence through migration/retention/transfer.
- **Existing compatibility:** preserve sanctioned live-setting safe boundaries/acknowledgements and public dirty/live-owner transfer refusals. Do not remove them to satisfy a new frozen-policy or backup abstraction.
- **Optimization:** current singleton writer remains unless an approved scoped authority design passes tests. Passing components are not integrated acceptance. Milestones preserve per-ticket criteria and public step semantics. Cache only proven relevant basis/coverage; keep mandatory critical gates.
- **External ownership:** one system owns each planner/approval/retry/compaction/tool/publication responsibility. No automatic foreign commit/push, self-acceptance or silently widened permissions. Unknown subscription dollar cost remains unknown.

Use CR01–CR24 and VT01–VT12 for the detailed assertions. A confident report, long run, tokens, arbitrary churn or passing convenience check cannot replace them.

## 7. Decisions, live evals and authorization

An explicit user request to implement this plan authorizes ordinary local implementation, existing-dependency setup, deterministic testing, documentation and disposable migration rehearsals within the actual Rafi repo. Keep decisions concrete and honor prior authorization; do not ask again for work already approved.

The package contains proposed D01–D12, not recorded approvals. Resolve ordinary technical choices within existing contracts from evidence. Consult the user before consequential public behavior/API, security posture, data-model/retention, paid service, new external data sharing or production parallelism changes required by applicable rules. Present alternatives, affected steps, tests and a recommendation; continue unaffected preparation meanwhile.

Recheck current primary documentation, versions, authentication terms and licenses before adopting external runtimes/tools. Existing subscriptions are preferred only where supported. Authenticated evals remain opt-in, disposable, pausable and bounded by agreed quotas/concurrency; never exercise active customer/sample app state. API/hosted spending requires an explicit budget and approved credentials. Do not silently substitute metered services after quota failure.

Do not commit, push, tag, open PRs, publish packages, deploy or perform destructive restoration unless explicitly instructed. Finish concrete release evidence and reviewable preparation before requesting the actual operational authorization. Disabling an optimization differs from restoring a database; neither can discard later/external work without reconciliation.

## 8. Reporting, continuation and completion

Send concise progress updates explaining verified findings, current work, material blockers and next gates. Keep implementation work moving; do not repeatedly return a plan when dependency-ready authorized tickets remain. Stop affected work for an unresolved required decision while continuing independent tickets.

At each review boundary report: step IDs/dispositions, behavior changed or verified, tests/checks and actual outcomes, docs/compatibility/privacy updates, pending choices, remaining risks and exact next ready step. Preserve durable session continuation context and never claim a test passed unless it ran successfully against the relevant bytes.

Before final completion, IMP-47 reconciles all 84 requirements and 24 risks, all adopted conditional contracts, platform claims and deferred experiments. Independently accepted substantial work, bounded safe recovery, scope preservation, human attention and justified overhead determine success. Publish negative results and remaining follow-ups; do not claim a universal best harness or zero possible failures.
