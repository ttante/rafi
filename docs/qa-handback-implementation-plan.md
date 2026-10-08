# QA → Builder handback implementation plan

Status: implemented in the working tree; verification and deployment limits are recorded in section 11. Original production compaction/readiness causes remain unproven; no live projects were upgraded or resumed.

Audience: the implementation agent working in the Rafi monorepo. Correctness, recoverability, and independent QA approval take priority over speed. Implement in small, dependency-aware changes; do not treat this as permission to rewrite unrelated orchestration.

## 1. Objective and evidence

Make failed-QA handbacks reliably deliver actionable findings, preserve every provider turn, stop safely on blockers or uncertainty, and avoid repeated work. Then reduce demonstrated prompt and session overhead without weakening QA or recovery guarantees.

Read [the investigation](qa-handback-investigation.md) before implementing. It contains the evidence, measurements, source references, and the original 13 resolutions. The baseline was checkout `1b41606` plus an already-dirty working tree; re-inspect the current checkout rather than assuming those line numbers remain current.

Evidence strength matters:

- Real observation: one MoneyFarm ticket, three QA reviews and three handbacks. Complete reviews averaged 3m05s; final delivery invocations averaged 2m41s. QA needed zero report corrections; Builder needed one response correction on every handback. No source changed. Two accepted responses disputed a valid finding because the environment prevented fixing it.
- Deterministic reproduction: 26 diagnostic scenarios demonstrate additional identity, outcome, persistence, restart-budget, and report-identity defects. These are not 26 observed production incidents.
- Unresolved cause: readiness processes printed `OK` but timed out; active-writer and compaction delays also occurred. Their exact lifecycle causes require traces before selecting a fix.
- Prior verification: 191 existing targeted tests and 26 characterization scenarios passed; ai-foreman typechecking passed. Some characterization assertions deliberately expect defects. Passing them does not establish correctness after implementation.

Do not claim a population-wide latency baseline or a measured pre/post regression from the three-handback sample.

## 2. Scope and working rules

In scope: the failure-delivery service, its Foreman and branch callers, continuity behavior at this boundary, report identities and database migration, retry accounting, typed outcomes and operator recovery, prerequisite checks, prompt construction, observability, and evidence-driven session lifecycle fixes.

Out of scope: relaxing QA acceptance, automatically waiving findings, changing product requirements, installing missing project dependencies without existing authority, broad provider rewrites, or automatically resuming the user's real builds as a test.

Before edits:

1. Read applicable `AGENTS.md` files and inspect `git status --short` and relevant diffs. The investigation found substantial unrelated edits, including overlapping orchestration, adapter, schema, and question-handling files. Preserve them. Re-check overlapping files immediately before editing.
2. Read the investigation, `scripts/audit-qa-handback.mjs`, and `packages/ai-foreman/test/qaHandbackInvestigation.test.ts` completely. Identify which behaviors still reproduce.
3. Use the installed Node >=20 and repository package-manager configuration (`pnpm@10.2.1` at plan creation). Do not rewrite a lockfile or install packages merely to establish a baseline.
4. Work on temporary Git repositories and isolated SQLite databases. For real-record migration tests, obtain a consistent SQLite backup/snapshot, including the referenced evidence store; do not copy only a live main database while ignoring WAL state.
5. Do not mutate MoneyFarm/MoneyTree run state, real recovery databases, active provider sessions, or writer leases. Controlled live tests require explicit authorization for provider cost and a disposable project.
6. Update this plan's completion checklist with actual tests and results. Never mark a work package complete solely because its old characterization test still passes.

## 3. Non-negotiable invariants

Every implementation and optimization must preserve these:

1. Builder cannot approve its own work. A fixed or disputed finding remains subject to independent QA. Finalization requires the existing current source-bound pass certificate or an explicitly authorized waiver through the existing audited path.
2. A valid-looking envelope is insufficient when provider execution failed, identity is mismatched, completion is uncorrelated, or dispatch/source state is uncertain.
3. Questions and blockers are outcomes, not formatting errors. No correction may invent an answer or turn an unresolved blocker into `done`.
4. A formatting correction performs no new remediation and uses no tools. Source stability is necessary but not sufficient to establish this.
5. Initial work, formatting repair, continuity repair, session transfer, and QA recheck are distinct operations/turns. Their identities, counts, and timing must remain distinguishable.
6. An uncertain dispatch must not trigger blind replay. Without provider-side idempotency, do not promise exactly-once execution; provide durable intent, conservative recovery, and no automatic duplicate dispatch.
7. Automatic remediation limits survive restart and competing entry points. An operator override is explicit, scoped, and durable.
8. Identical report content can occur in different reviews without sharing disposition, findings ownership, waiver, or recovery state.
9. Evidence is immutable and correctly attributed. A digest, byte count, session, turn ID, and response on one turn record must all describe that turn.
10. QA remains read-only with existing confinement, source-drift detection, and recovery validation. A missing prerequisite or malformed report is never a QA pass.
11. Existing durable records remain interpretable. Incomplete legacy evidence is marked unknown; do not fabricate missing turns, timestamps, terminal events, or scoped identities.
12. Timeout, cancellation, storage failure, and process death leave an explainable, recoverable state. They must not silently remove a finding or consume a pass certificate.

## 4. Code map to inspect

Paths are relative to the repository root. Search symbols rather than relying on investigation line numbers.

| Concern | Main implementation surfaces | Existing test surfaces |
| --- | --- | --- |
| Failure delivery and envelope | `packages/ai-foreman/src/qaFailureDelivery.ts`; `packages/spec/src/qaFailureReport.ts`, `schemas.ts`, `types.ts` | `qaFailureDelivery.test.ts`, spec `qaFailureReport.test.ts` |
| QA loop, budgets, recovery | `packages/ai-foreman/src/qaReview.ts`, `qaRecovery.ts`, `qaProtocolV2.ts` | `qaRecovery.test.ts`, `qaProtocolV2.test.ts` |
| Persistence and evidence | `packages/ai-foreman/src/workflowDb.ts`; find all report-digest readers, writers, packet projections, and recovery consumers | Database/recovery tests plus new migration and fault-injection suites |
| Production integration | `packages/ai-foreman/src/foreman.ts`, `branch/runner.ts`, `cli/start.ts` | `foreman.test.ts`, `branch.test.ts`, `branchFinalization.test.ts` |
| Provider turn and event ownership | `packages/ai-foreman/src/adapters/types.ts`, `adapters/codex.ts`, `adapters/claude.ts`, `agentRun.ts` | Adapter tests and production-caller integration tests |
| Continuity and boundaries | `packages/ai-foreman/src/continuity.ts`, `sessionLifecycle.ts`, `sessionIdentity.ts`, `handoffs.ts` | `unifiedContinuity.test.ts`, `qaHandoffAcceptance.test.ts`, `qaSessionPreparation.test.ts` |
| QA environment | `packages/ai-foreman/src/qaSnapshot.ts`, `qaRuntime.ts`, `cli/start.ts` | `qaSnapshot.test.ts`, `qaRuntime.test.ts` |
| Readiness and ownership | `packages/ai-foreman/src/runtimeReadiness.ts`, `sessionAvailability.ts`; trace provider ownership checks and the CLI integration | `runtimeReadiness081.test.ts` plus provider/session tests |
| Questions and operator visibility | Existing blocker/question/recovery routes, including `providerQuestions.ts`, recovery CLI, activity/logging and projections | Existing question, recovery, activity and CLI tests |

All unqualified test names above are under `packages/ai-foreman/test/`. New test-file names below are suggestions, not existing APIs.

## 5. Target model and design decisions

### 5.1 Keep content, occurrence, operation, and turn identity separate

Use four distinct concepts:

- `reportDigest`: immutable content identity; identical canonical report bytes legitimately share it.
- `reportOccurrenceId`: scoped report occurrence bound to run, ticket, and durable review attempt. Prefer a deterministic identity from that tuple, not a timestamp or report content alone. One attempt's final accepted report should be immutable; a conflicting replay must fail explicitly.
- `operationId`: one remediation operation bound to a report occurrence and remediation generation. Preserve existing operation identities for historical records.
- `turnRecordId`: one actual provider invocation within the operation, including correction or continuity-only repair, with a durable intent created before dispatch. Provider `turnId` may become known only after dispatch and must not be used as the sole pre-dispatch identity.

Keep review-scoped finding keys for authoritative response coverage. Introduce a separate, conservative issue fingerprint only for detecting repeated blockers; it must never authorize a waiver, resolution, or cross-review finding substitution.

### 5.2 Use typed outcomes rather than overloading `ok`

The names below are proposed internal semantics; integrate them with existing reducer/API conventions and version externally persisted contracts where necessary.

| Outcome | Meaning | Permitted automatic next action |
| --- | --- | --- |
| `remediation-reported` | Healthy, bound completion with valid fixed/disputed coverage | Independent QA recheck of the resulting source/evidence |
| `blocked` | Environment or other prerequisite prevents completion; partial progress may exist | Persist reason and recovery requirement; pause remediation loop |
| `needs-input` | A real operator decision is required | Existing scoped question flow; pause if unattended |
| `response-invalid` | Execution completion is known, but the response contract remains invalid | At most the authorized response-only repair, otherwise pause |
| `delivery-uncertain` | Dispatch, session, terminal event, or capture uncertainty prevents a reliable result | Reconcile/pause; no blind remediation redispatch |
| `source-drift` | Reviewed source binding no longer matches before remediation | Invalidate/supersede the affected review and require fresh QA |

A contract-valid response is not equivalent to findings resolved. Operator displays and telemetry must make this distinction even if legacy `succeeded` remains as a transport compatibility field.

Classification priority: record available evidence first; validate execution/identity/completion; then interpret blocked/questions; then validate remediation coverage; only then consider syntax repair. Do not use a readable blocker sentence to override a provider error. If the source capture fails after work, preserve the returned bytes and the failure, but prohibit acceptance or finalization until source is reconciled.

### 5.3 Version and compatibility decisions

- Specify the next response/receipt schema version before adding new disposition values or required fields. Do not silently change the meaning of persisted V2 objects.
- New writers emit the new contract; readers explicitly recognize supported old and new versions. Old `disputed` reports remain disputes, not blockers inferred from prose.
- Historical digest-only lookup must not silently return an arbitrary occurrence. Require scope, or return an explicit ambiguity error for callers that cannot resolve it.
- Retain raw legacy evidence and old identifiers. Use mappings/projections for migration rather than rewriting signed/digested bytes in place.
- Older binaries must not write a database whose schema/protocol they cannot interpret. Establish an actual version/write-compatibility guard; a new-binary-only convention does not protect against an old binary. If an old binary cannot be guarded, rollout must explicitly prevent mixed-version writers.

## 6. Implementation work packages

Recommended order: P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7/P8/P9/P10 → P11 → P12/P13. Add basic tracing while building P2; P11 completes aggregation and performance evaluation. Small fail-closed validation patches may land earlier if independently tested and compatible with the later journal design. Do not land a half-migrated state machine or half-updated caller contract.

### P0 — Establish a trustworthy baseline

Deliverables:

- Re-run the targeted tests and all 26 diagnostics on the current dirty checkout. Separate pre-existing failures from changes introduced by this work.
- Create a coverage inventory mapping each diagnostic name to its owning fix and desired assertion (section 7).
- Preserve positive controls for normal responses, wrapped responses, pre-dispatch drift, correction source changes, and completed-operation replay.
- Extend fixture providers to emit realistic scoped identities and correlated terminal/tool events. Do not weaken production validation to accommodate incomplete test doubles.
- Prefer explicit test hooks or narrow dependency injection for faults over process-global monkeypatching. If existing monkeypatches remain, guarantee restoration and serialized execution.

Acceptance: repeatable, network-free tests on isolated fixtures; actual baseline recorded with Node version and test counts.

### P1 — Separate report occurrence from report content

Resolves investigation resolution 5. Dependencies: P0.

Implementation:

1. Inventory every `reportDigest` database lookup, foreign key, in-memory type, reducer event, handoff, remediation receipt, finding reference, report chain, waiver, recovery packet, and CLI projection. Distinguish content access from occurrence access.
2. Introduce the scoped occurrence identity and uniqueness rule from section 5. A repeated write of the same occurrence and content is idempotent; a repeated occurrence with conflicting content is a hard consistency error. Distinct attempts can reference identical content.
3. Migrate at least `qa_reports`, `qa_findings`, `qa_report_dispositions`, `qa_report_chains`, `qa_failure_handoffs`, and `qa_remediation_receipts`, plus embedded bindings and additional consumers found by the inventory. Keep immutable content accessible by digest.
4. Backfill occurrence scope from stored run/ticket/review-attempt evidence. Do not guess ambiguous or missing lineage. Report a repair requirement and stop the migration safely when an authoritative mapping cannot be established.
5. Preserve historical finding/handoff/operation IDs where they are already persisted; introduce explicit legacy-to-occurrence mappings if needed. New identity generation must remain stable across restart.
6. Implement migration transactionality and idempotency using the repository's migration mechanism. Verify referential integrity, counts, chains, dispositions, and evidence digests before marking migration complete.

Tests: identical JSON on consecutive reviews of one ticket; identical JSON on different tickets and runs; same-occurrence replay; conflicting same-occurrence replay; independent resolve/waive/supersede; failed/interrupted migration; rerun migration; empty DB; legacy pending, uncertain, completed, and waived records; copied real records where available.

Acceptance: `restart-identical-report` completes the review without a unique-key exception; independent histories never merge. `INSERT OR IGNORE` against the old digest primary key and overwriting an old report row are not acceptable fixes.

### P2 — Journal each dispatch and commit local state consistently

Resolves investigation resolution 6 and provides the foundation for 13. Dependencies: P1.

Implementation:

1. Create a durable per-turn record linked to operation and report occurrence. Include turn kind/index, parent turn when applicable, intended and observed session identities, host/provider prompt digest-byte pairs, raw/cleaned response digests, parsed-response digest, parser errors, provider flags/failure metadata, tool/terminal evidence, source capture outcome, and timestamps.
2. Preserve both initial and corrected responses. If the provider-transformed prompt is unavailable, mark it unavailable rather than calling the host prompt exact provider evidence. Return the ID of the response actually returned to callers.
3. Commit dispatch intent, recovery/budget reservation, remediation record, handoff state, and reducer revision together before sending. Do not hold a database transaction across source capture, provider calls, event waits, or network I/O.
4. Commit local terminal outcome, response/receipt links, recovery status, handoff state, and reducer transition atomically using existing compare-and-set/revision protection. If external evidence objects are written separately, write them durably before committing references; tolerate orphaned objects, never dangling committed references.
5. Journal initial and correction dispatch exceptions consistently as uncertain unless there is affirmative proof no dispatch occurred. A completed invalid response is different from a lost response.
6. Catch capture/identity/persistence failures without discarding available responses. If storage itself is unavailable, stop further dispatch; do not claim a receipt was persisted. Recovery must inspect durable intent and any independently recoverable evidence.
7. Reconcile historical partial states deterministically. A confirmed outcome with a missing handoff link should be linked idempotently, not rerun. An intent with no reliable completion remains uncertain. Recapture/review changed source as required; source equality alone cannot prove that no external side effects occurred.

Fault matrix: crash before intent; after intent before send; after send before response; after response before capture; after capture before receipt; before/after outcome commit; during handoff-link update; duplicate completion; stale reducer revision; evidence write failure; database busy/disk error; cancellation at each awaited phase. Use thrown-fault unit tests and at least one child-process kill/reopen test for real durability.

Acceptance: every crash yields either an atomic known outcome or an explicit recoverable uncertainty; no automatic duplicate remediation. Receipt digest/byte/session/turn pairs round-trip to their exact stored evidence.

### P3 — Centralize execution and identity validation

Resolves investigation resolution 1. Dependencies: P2.

Implementation:

1. Extract/reuse the established identity semantics from QA turn/session validation without weakening QA's existing checks. Avoid a blanket rewrite of both paths in one patch.
2. Validate provider/role/stream, adapter session ID, stable scoped session reference, canonical worktree, ticket scope where required, generation, configuration scope, returned provider metadata, and correlated completion. Document provider-specific metadata availability; absent required evidence is not equivalent to a match.
3. Canonicalize paths with the existing path policy. Test valid symlink aliases and fail safely for inaccessible/nonexistent paths; raw string comparison is insufficient.
4. Check `isError` and structured `failure` metadata before any success or correction. Validate the original turn ID before entering repair. Compare session identity before/after every dispatch, including continuity-only repair.
5. Allow legitimate validation timestamp refresh without changing stable identity. A validated successor chosen before dispatch is allowed; an unexplained replacement during a turn is not.
6. Persist rejected text and both intended/observed identity metadata. Missing or conflicting identity/terminal evidence must not be laundered through a later valid envelope.

Tests: both providers; original/correction/continuity errors; `isError: false` plus failure metadata; missing turn ID; foreign returned session; wrong worktree; timestamp-only refresh; legitimate pre-dispatch transfer; missing/late/duplicate/wrong-turn terminal event; cancellation; session replacement and session-reference access failure.

Acceptance: no errored or incorrectly bound provider turn produces remediation acceptance or starts a formatting repair intended to hide that error.

### P4 — Make response-only repair observable and bounded across wrappers

Resolves investigation resolution 2 and continuity aspects of 8. Dependencies: P2–P3.

Implementation:

1. Trace the existing owner of each provider event stream, including `ContinuityAdapter.pumpEvents()`. Add turn-scoped fan-out/observation through that owner; do not create a competing iterator that steals terminal or tool events.
2. Wire observation through both `Foreman` and `branch/runner.ts`, including replaced adapters. An optional array omitted by production is not sufficient. Clean up subscriptions on completion, timeout, session replacement, and cancellation.
3. Establish a terminal/drain barrier with explicit adapter ordering guarantees. Tool events must be correlated to the correction, including provider subevents. If a provider cannot prove a correction was tool-free, pause or disable automatic correction for that capability; do not infer safety from silence.
4. Request no-tools capability at dispatch where supported. Keep event validation and before/after source captures as independent safeguards. Detect read-only tools and reverted edits as well as persistent writes.
5. Coordinate continuity with delivery. Prefer an explicit handback turn policy that prevents opaque successor redispatch and exposes any continuity-only repair as a journaled child turn. Evaluate existing `durableSingleTurn` behavior before reusing it: it is QA-oriented and cannot simply be enabled globally for Builder.
6. Define a single automatic response-repair allowance for the handback. A continuity-only repair consumes that allowance; if a separate envelope repair is then needed, pause instead of allowing hidden multiplication. If one combined correction can repair both contracts, validate both. Session acceptance/bootstrap calls remain separately bounded and recorded, never disguised as corrections.
7. Preserve ordinary non-handback continuity behavior and valid checkpoint publication. Never publish an authoritative checkpoint from an errored/mismatched repair. Do not remove continuity requirements to improve speed.

Tests: tool event with/without legacy sink; tools emitted just before terminal; wrongly correlated events; reverted edits; missing observation; wrapper repair error; wrapper source/tool use; valid wrapped result; handoff request inside initial work; bounded double-invalid continuity/envelope case; both real production callers; subscriber cleanup and no event starvation.

Acceptance: at most one initial remediation work turn and one automatic response-only repair within a bound handback operation. Every actual provider invocation is visible, validated, and attributable. No repair repeats work or silently moves to another session.

### P5 — Enforce a durable automatic remediation budget

Resolves investigation resolution 4. Dependencies: P2; compatible with P1 identity mappings.

Implementation:

1. Replace the split accounting (`qa-failure-delivery:<ticket>` writes versus `qa-fix:<ticket>` reads) with one authoritative run/ticket operation ledger or query.
2. Count remediation operations, not raw provider turns. One response-only repair does not consume a second remediation operation; its own repair allowance remains separate.
3. Reserve/check budget atomically with dispatch intent. Proven pre-dispatch preparation failures do not consume a dispatched attempt; ambiguous intent/dispatch consumes or holds a reservation until reconciled. Failed or blocked dispatched work still counts.
4. Reconcile legacy and production records using explicit operation/attempt linkage. Do not blindly sum the two keys or take their maximum. If historical records cannot be deduplicated reliably, fail conservatively with an explanation rather than granting extra work.
5. Apply the same guard in both production entry points and recovery paths, not only in the in-memory loop. Keep `maxCycles`/fix-limit public semantics stable or document a deliberate compatible transition.
6. Record operator-authorized additional attempts, Planner remediation, and their scope separately. Restart cannot invent or reuse a consumed authorization.

Tests: limit 0/1/N; repeated restarts before and after all outcomes; uncertain dispatch; pre-dispatch source drift; correction count; mixed legacy/new records; two competing callers; exhausted budget with operator retry; consumed override replay; final QA recheck after the last authorized fix still permitted.

Acceptance: `restart-budget` requests no additional unauthorized Builder operation. Budget exhaustion blocks more remediation, not the independent QA review needed to evaluate work already completed.

### P6 — Represent blockers, questions, disputes, and partial remediation truthfully

Resolves investigation resolution 3. Dependencies: P1–P5.

Implementation:

1. Extend the versioned response contract with structured blocked outcomes/reasons and partial finding coverage semantics. Include affected findings, blocker category, evidence, required recovery/decision, and verification `not_run` reasons. Keep required finding identity and duplicate/unknown-key validation.
2. Parse valid terminal blocked/needs-input statuses before deciding whether an envelope requires formatting repair. A normal blocked/question response need not fabricate a success envelope. Contradictory terminal markers remain invalid; do not salvage arbitrary conflicting text as a trusted outcome.
3. Preserve initial and correction blocker/question text in durable receipts and operator-visible output. Use status fields, not generic parser errors, for the actionable explanation.
4. Replace boolean-only routing with the typed outcome semantics in the delivery service, QA loop, both callers, reducer, recovery packets, and CLI/activity projections. Keep compatibility adapters explicit at legacy boundaries.
5. Use the existing operator question mechanism with durable correlation and authorization. Persist the pending question before waiting; answer consumption is idempotent and scoped. Unattended execution pauses without requesting the same unanswered question on every restart.
6. Keep disputes distinct from blockers and fixes. A legitimate dispute may require no source change and still deserves QA evaluation. Do not infer structured truth from old free-form prose.
7. When partial changes exist with a blocker, preserve them and invalidate any stale pass. Pause further automatic remediation; ensure subsequent acceptance still requires QA of the changed source.

Tests: initial/corrected blocked; initial/corrected needs-input; resumed pending question; duplicate/foreign answer; partial fixed+blocked coverage; valid dispute; malformed/contradictory status; legacy V2 responses; both providers and callers; no implicit waiver/finalization.

Acceptance: `needs-input` is never repaired into done without an answer; `blocked` and `blocked-correction` surface the actual registry reason; partial work remains recoverable and unapproved.

### P7 — Stop repeated unresolved-blocker loops

Resolves investigation resolution 7. Dependencies: P5–P6.

Implementation:

1. Persist blocker state and a conservative fingerprint based on authoritative requirement/location/category and relevant capability, separate from review-scoped finding keys.
2. Store the source, environment capability, evidence, and operator-decision revisions relevant to that blocker. Repeated prose changes or new review IDs alone are not progress.
3. After a structured blocker, stop automatic remediation and explain what would permit recovery. Before resuming, revalidate the relevant changed inputs and choose fresh QA or authorized remediation based on current source binding and budget.
4. Allow environment-only recovery and evidence-only disputes. Do not use unchanged source as a universal no-progress rule.
5. Detect legacy repeated no-change patterns conservatively for operator diagnosis, without retroactively treating an old dispute as a structured blocker or resolving it automatically.

Tests: unchanged blocker across several restarts; changed blocker wording; unrelated source change; real environment recovery; partial fixes; new relevant evidence; genuine no-code dispute; fingerprint collisions; changed ticket requirements; explicit authorized retry.

Acceptance: a MoneyFarm-like registry-blocked fixture stops after the first structured blocker and resumes only with relevant evidence/authority. It cannot loop through full QA solely because a response is syntactically valid.

### P8 — Make first-response instructions and bounded repair precise

Resolves the remaining parts of investigation resolution 8. Dependencies: P4, P6.

Implementation:

1. Render authoritative response schema or an exact valid template plus constraints, current finding coverage, identity fields, and truthful blocked/needs-input alternatives in the initial prompt.
2. Explicitly document envelope-first and status-last requirements on the cleaned response. Explain where the required continuity record belongs in raw output; avoid contradictory wrapper and delivery instructions.
3. Pass actual parser/schema errors into correction, together with the original response/evidence reference, correct IDs, and the exact permitted shape. Tell Builder to preserve the original substantive outcome and not invent changes, evidence, verification, or answers.
4. Retain strict rejection of duplicate JSON keys/findings, unknown or missing findings, wrong handoff identity, trailing garbage, contradictory statuses, and oversized payloads. Keep QA evidence labeled as untrusted data, never host instructions.
5. Stop after the shared repair allowance. Persist the original error, correction error, and both responses for diagnosis.

Tests: prose prologue; trailing brace; Unicode; malformed JSON; every required field; unknown/duplicate/missing findings; wrong IDs; injection-like finding text; raw continuity placement; oversized error lists/responses; truthful blocked alternative; correction preserving disputed/not-run meaning.

Acceptance: targeted diagnostics include real parser errors rather than placeholder JSON. Valid normal/wrapped responses pass; malformed responses do not pass because validation was loosened.

### P9 — Detect unavailable verification prerequisites before costly QA

Resolves investigation resolution 9. Dependencies: P6–P7.

Implementation:

1. Derive prerequisites from actual project/ticket verification requirements; do not make Docker, network, or installed dependencies mandatory for every project.
2. Add bounded, non-mutating capability checks for required executables, dependency availability, services, and necessary connectivity. No package installation, lockfile generation, source edits, or external resource creation in preflight or read-only QA.
3. Persist evidence scoped to actual worktree/snapshot, lockfile/manifests, toolchain/provider environment, and sandbox/configuration. Cache only reusable facts; volatile services/network need short freshness or revalidation. Invalidate on relevant changes.
4. Surface actionable environment recovery separately from application defects. Static checks can still run when useful; required unexecuted verification remains `not_run` and cannot produce an unconditional pass.
5. Require existing user/workflow authority for provisioning or environment changes. A preflight classification must not suppress real source findings such as a required missing lockfile.

Tests: static-only ticket; installed/missing dependencies; absent optional/required Docker; registry unavailable; offline-capable project; changed lockfile/toolchain/sandbox; snapshot dependency projection; permission denied; hanging capability probe; required tests not run.

Acceptance: missing prerequisites are explained before redundant full cycles, QA remains read-only, and test-not-run is distinct from test-executed-and-failed.

### P10 — Bound prompt history without losing required evidence

Resolves investigation resolution 10. Dependencies: P1–P2, P6; coordinate with P8.

Implementation:

1. Replace recursive full prior handoff/request embedding with a typed bounded history projection: occurrence/operation IDs, concise outcome, outstanding issue/blocker summary, meaningful changes, and exact evidence references.
2. Include complete current requirements and unresolved findings once. Remove duplicate current report, acceptance/test lists, and observations only where the authoritative copy remains present and unambiguous.
3. Persist every referenced historical object in the evidence store. A digest alone is not retrievable context: verify that the receiving role has an authorized retrieval path, or supply necessary exact evidence within the prompt. If essential evidence cannot fit or be accessed, pause with an explicit capacity error.
4. Account for provider/wrapper instruction overhead and response/continuity reserve against actual model context capability. Keep the existing byte limit as a hard safety cap, not the efficiency target. Do not treat byte counts as exact token counts.
5. Compact optional history deterministically and UTF-8 safely; never silently truncate mandatory finding coverage or acceptance criteria. Preserve provenance and advisory-only Planner content.

Tests: 1/3/10/20 cycles with unchanged issues; many distinct findings; large requirements; Unicode; missing evidence object; unavailable retrieval; narrow context window; history injection; restart reconstruction; both prompt renderers and wrappers.

Acceptance: no nested historical handoff/request copies, bounded optional history, and no avoidable per-cycle prompt growth for a fixed issue set. Required content is either available in full or yields a clear safe stop.

### P11 — Measure latency, correction frequency, and actual progress

Resolves investigation resolution 13. Dependencies: P2 and typed outcomes; instrument earlier packages as they land.

Implementation:

1. Correlate run, ticket, review attempt, report occurrence, remediation operation, provider turn, session generation, and resumed invocation. Avoid making raw prompt/response text a default log field; use protected evidence references and redact secrets in diagnostics.
2. Record preparation, source capture, compaction, transfer, readiness, initial work, each correction, validation/persistence, QA recheck, pause, and resume separately. Use monotonic elapsed timing within a process plus wall-clock timestamps for cross-process ordering; unavailable durations remain unknown.
3. Distinguish QA report correction count, Builder formatting correction count, continuity-only repair count, session acceptance turns, remediation operations, full QA reviews, and packet revisions.
4. Record contract acceptance, claimed fixed/disputed/blocked findings, verification executed/failed/not-run, subsequent QA-confirmed resolution, source/evidence changes, no-progress recurrence, retry exhaustion, and uncertain dispatch independently.
5. Extend the audit script for old/new schemas without opening the DB through a mutating constructor. Use a coherent read transaction/snapshot for a consistent sample. Show sample counts and missing-data counts; do not fill legacy gaps with zero.
6. Report active service time, full elapsed time, known pause/recovery time, and unclassified gaps separately. Do not sum nested phase spans as if disjoint. Report median and tail statistics only with sample-size caveats.

Tests: deterministic timestamps and correlated turns; missing legacy fields; multiple resumes; failed preparation then delivery; overlapping phase spans; absent response; UTF-8 byte/digest checks; privacy filtering; audit on legacy and migrated fixture DBs without writes.

Acceptance: an operator can answer how many turns occurred, why a correction happened, whether any finding progressed, and where elapsed time went without reading raw transcripts. The audit does not call formatting acceptance a QA pass.

### P12 — Diagnose and repair compaction lifecycle overhead

Resolves investigation resolution 11. Dependencies: P3–P4, P11. This is an evidence-gated package, not an instruction to increase or remove timeouts.

Implementation:

1. Trace request submission, acknowledgement, provider completion, fresh usage receipt, waiter registration/removal, cancellation, fallback, and session generation. Use recorded/fake event streams first; request authorization before live provider reproduction.
2. Determine whether a timeout is genuine slow work, a lost/racing event, missing usage evidence, or process failure. Fix demonstrated ordering/correlation defects before tuning deadlines.
3. Use bounded configurable deadlines with explicit semantics; progress may justify a bounded extension, never indefinite waiting. Report actual units and durations instead of rounding a 30-second timeout to “1 minutes.”
4. Preserve fresh usage/context-capacity proof, configured compaction counts, and validated fallback successor acceptance. Late completion cannot revive a closed predecessor or overwrite the successor's state.

Tests: acknowledgement without completion; completion before waiter registration; usage before/after completion; wrong-session events; duplicates; late completion after timeout; slow valid completion; failed fresh transfer; cancellation; provider-native automatic compaction; fallback budget/counter correctness.

Acceptance: the identified lifecycle defect has a replayable regression test, deadlines remain bounded, and no path proceeds on assumed compaction success or stale usage. If no cause is established, retain safe behavior and document the unresolved trace requirement rather than inventing a fix.

### P13 — Diagnose readiness shutdown and writer ownership safely

Resolves investigation resolution 12. Dependencies: P11; coordinate with existing runtime/session work in the dirty checkout.

Implementation:

1. Trace readiness process spawn, output, exit, stdio closure, child cleanup, timeout, and cancellation. Establish why the `OK` probe does not complete; stdout alone is not readiness success.
2. Only add readiness reuse if equivalent evidence can be scoped to provider executable/version, model, authentication/configuration revision, environment, and confinement. Use non-secret fingerprints, expiry, and invalidation after relevant failures. Readiness caching must not replace actual session/writer validation.
3. Trace who creates, holds, releases, and reclaims writer ownership. Check process identity/start time and lease generation to protect against PID reuse. A fresh live writer remains exclusive even if another resume is waiting.
4. Permit stale-owner recovery only through verified ownership and an atomic compare-and-set reclamation path. Never delete a live lease or kill an unrelated process. Bound and explain waits; expose a precise operator recovery action when ownership cannot be proven.

Tests: `OK` plus clean exit; `OK` plus hung shutdown; output without valid completion; changed executable/auth/model/config; cancellation and owned-child cleanup; live competing writer; dead writer; PID reuse; raced reclamation; repeated resume; cache expiry/invalidation; no cache leak across confinement contexts.

Acceptance: any lifecycle optimization is supported by traces and deterministic regression tests. Unexplained cases remain safe, explicit blockers; no arbitrary timeout/cache policy is advertised as a proven resolution.

## 7. Convert all 26 diagnostics into desired-behavior coverage

Do not delete a failing characterization to make the suite green. As each fix lands, change the relevant assertion from observed defect to desired invariant, retaining setup and evidence checks. Move mature cases into focused production test files if useful, but retain this mapping.

| Existing scenario(s) | Required assertion after repair | Owner |
| --- | --- | --- |
| `valid`, `wrapped-valid` | Healthy contract accepted; independent QA still required; continuity intact | P3–P4, P6 |
| `disputed` | Legacy dispute remains a dispute, never QA approval; add a new structured environment-blocked companion that pauses instead of claiming resolution | P6–P7 |
| `prologue` | One allowed tool-free correction; exact errors and separately linked initial/correction receipts | P2, P4, P8 |
| `trailing-brace` | Still invalid; response and reported turn ID refer to the same correction | P2, P8 |
| `errored-correction`, `failure-metadata` | Provider failure cannot be accepted despite a valid envelope | P3 |
| `blocked`, `blocked-correction` | Typed blocked outcome with actual reason, no automatic success repair | P6 |
| `correction-session-switch`, `foreign-turn-metadata`, `wrong-worktree`, `initial-session-switch` | Wrong identity rejected; returned evidence preserved; no acceptance | P2–P3 |
| `missing-initial-turn` | Original missing identity stops repair and records uncertainty | P3 |
| `needs-input` | Question persisted/routed; no done without authorized answer | P6 |
| `correction-dispatch-error` | Durable uncertain correction, not completed-invalid | P2 |
| `correction-capture-error` | Returned response retained where storage works; capture failure linked; safe reconciliation | P2 |
| `correction-tool-with-sink`, `correction-tool-without-sink` | Production observation enforces no-tools; missing observation is not acceptance | P4 |
| `correction-source-change` | Correction rejected; changed source requires re-evaluation before acceptance | P4 |
| `completion-write-error` | Atomic completion or idempotent reconciliation, no split authoritative outcome | P2 |
| `restart-budget` | Exhausted budget survives restart; no extra automatic remediation | P5 |
| `pre-dispatch-drift` | Zero remediation sends; fresh source-bound QA required | P3 |
| `wrapped-repair-error` | Inner repair failure visible and rejected; no invalid checkpoint accepted | P3–P4 |
| `replay-completed` | No second provider dispatch; completed receipt returned or explicit already-completed result | P2 |
| `restart-identical-report` | New occurrence accepted without collision or cross-review linkage | P1 |

Add integration cases that call the actual Foreman and branch delivery paths with deterministic providers. Unit coverage only through the legacy `fix` callback is insufficient.

## 8. Verification commands and gates

Use the repository's installed tooling. The investigation used Node 20.19.0. The direct Node test runner below avoids the `tsx` CLI IPC issue seen in the investigation sandbox.

Baseline and converted diagnostics:

```sh
node --import tsx --test packages/ai-foreman/test/qaHandbackInvestigation.test.ts
```

Existing targeted regression gate:

```sh
node --import tsx --test --test-concurrency=2 \
  packages/ai-foreman/test/qaFailureDelivery.test.ts \
  packages/ai-foreman/test/qaProtocolV2.test.ts \
  packages/ai-foreman/test/qaRecovery.test.ts \
  packages/ai-foreman/test/qaSnapshot.test.ts \
  packages/ai-foreman/test/qaHandoffAcceptance.test.ts \
  packages/ai-foreman/test/qaRuntime.test.ts \
  packages/ai-foreman/test/qaSessionPreparation.test.ts \
  packages/spec/test/qaFailureReport.test.ts \
  packages/ai-foreman/test/unifiedContinuity.test.ts \
  packages/ai-foreman/test/runtimeReadiness081.test.ts \
  packages/ai-foreman/test/codex.test.ts \
  packages/ai-foreman/test/foreman.test.ts \
  packages/ai-foreman/test/branch.test.ts \
  packages/ai-foreman/test/branchFinalization.test.ts
```

Also run all new migration, fault-injection, budget, caller-integration, Claude adapter, question, and observability tests added or affected by each package. The list above is a historical baseline, not the final coverage ceiling.

Fast typecheck and final workspace gates:

```sh
node node_modules/typescript/bin/tsc --noEmit -p packages/ai-foreman/tsconfig.json
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Inspect the current scripts before execution and record environmental failures honestly. Do not count skipped or unrun tests as passed. Run generated-document checks if CLI/schema documentation changes require them. Do not run `test:live-*` as part of the ordinary offline gate.

Migration gate:

- Consistent backup plus evidence before upgrade; no active competing writer.
- Successful migration and restart on fresh fixtures and copied legacy records.
- Foreign-key/integrity checks clean; count/lineage/digest reconciliation complete.
- Interrupted migration retries safely; pending/uncertain operations do not redispatch.
- Independent report dispositions and finalization certificates remain correct.
- Old-writer compatibility is enforced operationally or technically, not assumed.

Performance gate:

- First demonstrate deterministic reductions: bounded correction count, no unchanged-blocker loop, no recursive prompt growth, no unnecessary duplicate boundary work.
- Replay a fixed scenario matrix: valid remediation; syntax repair; genuine dispute; environment blocker; partial fix; uncertainty/restart; large findings; fresh/compact sessions; both providers.
- For authorized live comparisons, hold project fixture, model/provider settings, confinement, environment, and session strategy constant. Report sample sizes, correction frequency, prompt sizes, active/elapsed phase distributions, and independent QA outcomes.
- Set numeric latency targets only after a representative baseline. Tiny fake-provider timing is host overhead, not a forecast of model turnaround. Never accept a speed improvement that worsens correctness, tool confinement, evidence completeness, or safe recovery.

## 9. Rollout and rollback

1. Land narrow reviewable changes with their desired-behavior tests. Keep correctness protections enabled; feature-gate optional performance changes if needed, not the rejection of invalid work.
2. Deploy schema/reader compatibility and migration protections before new writers depend on them. Version contract changes and update both callers together. Document any intentional pause for ambiguous historical state.
3. Stop affected writers for migration using existing safe shutdown procedures, take a consistent backup, validate upgrade on a copy, then upgrade the intended database. Never migrate the user's live projects during implementation tests.
4. Start with disposable deterministic runs; then, only with authorization, canary representative real workflows. Verify evidence links, retry totals, blocked/question recovery, and fresh QA finalization before expanding.
5. Roll back optional prompt/cache/deadline optimizations independently if metrics regress. Do not roll back by re-enabling unsafe correction acceptance, hiding uncertainty, or ignoring report collisions.
6. Schema rollback is not just running an old binary. Prefer a forward repair. Restoring a pre-upgrade backup requires stopping writers and explicitly accounting for all work/evidence created since the backup; never erase those outcomes silently or replay their side effects. Do not provide an automatic destructive down-migration.

Stop rollout for: false accepted provider failure; unanswered question marked done; report cross-linkage; lost response evidence; automatic over-budget or uncertain redispatch; migration ambiguity; live lease theft; stale/source-unbound QA approval; or unexplained correctness regressions. Record the exact failing invariant and evidence.

## 10. Traceability and completion checklist

Original investigation resolutions map to work packages as follows:

| Resolution | Work package(s) |
| --- | --- |
| 1. Per-turn validation | P3 |
| 2. Response-only correction enforcement | P4 |
| 3. Distinct outcomes | P6 |
| 4. Durable retry accounting | P5 |
| 5. Report occurrence identity | P1 |
| 6. Consistent persistence and evidence | P2 |
| 7. Stop blocker loops | P7 |
| 8. Better instructions and bounded repair | P4, P8 |
| 9. Prerequisite checks | P9 |
| 10. Bounded prompt history | P10 |
| 11. Compaction lifecycle | P12 |
| 12. Readiness and writer ownership | P13 |
| 13. Metrics and report quality | P11, P6, P9 |

Implementation-agent checklist:

- [x] P0: current baseline and dirty-worktree ownership recorded.
- [x] P1: scoped report identity and migration verified.
- [x] P2: per-turn evidence, atomic local transitions, and crash recovery verified.
- [x] P3: initial/correction/wrapper validation parity verified.
- [x] P4: no-tools enforcement and shared repair allowance verified through both callers.
- [x] P5: durable limits and explicit overrides verified across restart/races.
- [x] P6: blocked/question/dispute/partial-result semantics integrated end to end.
- [x] P7: repeated blockers stop; recovery requires explicit recovery acceptance and fresh QA/prerequisite evaluation.
- [x] P8: exact initial/repair instructions validated without parser relaxation.
- [x] P9: prerequisite evidence and `not_run` classification verified.
- [x] P10: bounded history and mandatory evidence availability verified; required current evidence is inline, optional historical references are advisory.
- [x] P11: phase/turn/progress metrics and read-only audit verified.
- [x] P12: demonstrated waiter/correlation protections tested; original production compaction cause remains explicitly unresolved below.
- [x] P13: deterministic shutdown and writer protections tested; original production readiness/writer delays remain explicitly unresolved below.
- [x] All 26 scenarios converted to passing desired-behavior tests.
- [x] New migration, fault, provider, caller, and finalization regression gates passed.
- [x] Workspace tests, typecheck, build, and applicable doc checks passed; intermediate failures and final skips disclosed below.
- [x] Rollout/rollback instructions and protocol/schema compatibility documented.
- [x] Final handoff lists changed files, verified behavior, commands/results, measurements, and remaining risks.

Do not report all 13 resolutions implemented if the lifecycle packages remain trace-only. A safe partial delivery must clearly distinguish repaired defects, implemented instrumentation, and unresolved causes. This document itself is a plan, not evidence that any repair has shipped.

## 11. Implementation record

### Implemented contracts and state

The response, new handoff, delivery journal, and remediation receipt contracts are V3. Readers retain explicit V2 response/receipt support; historical disputes keep their original meaning. Legacy immutable evidence is not rewritten. Report content remains addressed by its SHA-256 digest; report occurrence is a deterministic identity of `(runId, ticketId, reviewNumber)`, whose review number is already durably unique within that run/ticket. Findings, dispositions, chains, handoffs, and receipts use occurrence ownership. An ambiguous digest-only lookup or conflicting occurrence replay is an error.

Migration `003_qa_report_occurrences_and_turns` sets SQLite `user_version=3`, transactionally rebuilds the six affected tables, verifies lineage/counts/evidence/foreign keys/integrity, and installs connection-local writer-protocol checks on durable tables. A historical writer lacking `rafi_writer_protocol()` cannot mutate the upgraded database. Heartbeat and state-transfer writers register the same protocol. Newer unknown database versions are rejected. Migration refuses an active or unverified writer lease and rolls back on ambiguous lineage or interruption. Original reducer events, recovery packet bytes, and historical operation/finding/handoff IDs are retained; occurrence ownership is projected from authoritative database scope rather than retroactively changing digested packets.

Delivery reserves its budget, recovery operation, reducer revision, and initial turn intent atomically before dispatch. Terminal outcome, receipt links, recovery state, question/stop state, and reducer transition commit together. Returned bytes are saved before identity/source inspection. Every dispatched work/repair turn has separate evidence and identity; replay returns a completed result or stops at uncertainty without sending again. Historical succeeded operations missing a handoff receipt link are reconciled from their existing receipt with incomplete legacy evidence explicitly marked.

Execution errors, missing/wrong scoped identities, uncorrelated terminals, missing observation, and source-capture failure cannot be accepted. Scope validation canonicalizes existing worktree/configuration paths and ignores refresh timestamps while retaining generation and stable identity. Event fan-out preserves the existing stream consumer. Handbacks disable opaque continuity redispatch/repair and permit one combined response-only repair. Claude denies tools on that repair; providers also need correlated terminal/tool observation. Codex does not receive an invented unsupported no-tools option. Repair tool use and source drift remain independently enforced and journaled.

Structured blockers, questions, disputes, and partial results remain distinct. Blockers/questions persist a stop and do not automatically repeat QA/remediation. Actual question answers are durably scoped, bounded, checked against the stored decision, and idempotent; recovery clears a stop only after validated fresh-session acceptance. Independent source-bound QA or the existing explicit waiver path still controls finalization. Automatic attempts use one durable ledger across both callers and restart; overrides require a scoped single-use authorization. Ambiguous historical retry linkage requires reconciliation instead of silently granting more attempts.

Preflight checks only recognizable, explicitly required executable/dependency/service/connectivity capabilities. Evidence includes source/snapshot, manifests/lockfiles, Node/PATH, runtime configuration, requirements, and timestamps. It never installs dependencies or provisions services. Required unexecuted verification is `not_run`; a missing required lockfile remains a source defect. Host availability and DNS resolution are not proof of provider confinement or successful network/service verification. Checks are rerun rather than cached.

Optional history is limited to four typed entries with UTF-8-safe summaries; nested old requests are excluded. Complete current requirements and findings remain inline. Exact history and responses remain in the protected evidence store; optional digests do not imply a provider retrieval capability. Mandatory content over the hard byte cap, or the conservative available-context/reserve bound when capacity is known, stops delivery rather than dropping findings.

### Verification evidence

Tooling: installed Node `20.19.0`, pnpm `10.2.1`; no dependency installation or lockfile rewrite. The original dirty diff/status were saved under `/tmp/rafi-qa-handback-baseline/`. Pre-existing and concurrently changing ticket, activity, session, question, and build-stall work was preserved. No additional agents were spawned.

- Baseline: 191 existing targeted tests plus all 26 original characterization cases passed (217 total). The characterization assertions were then converted; their old green result is not counted as repair evidence.
- All 26 desired-behavior diagnostics passed. The later delivery/migration/crash/caller gate passed 52/52; the final focused adapter/Foreman/audit/migration/safety gate passed 62/62. These suites overlap and must not be added together as a unique test count.
- Fault coverage includes dispatch uncertainty, returned response before capture failure, completion transaction rollback, migration interruption after copying tables, ambiguous lineage rollback/retry, competing entry points, single-use authorization, restart, and an actual child-process `SIGKILL` after committed dispatch intent. The killed process's reopened database retained intent and made zero new remediation sends. Real disk-full and live-provider cancellation are not claimed as exercised faults.
- Both actual Foreman and branch paths were exercised with deterministic scoped providers, including truthful blockers and tool-using response corrections. Existing independent-QA/finalization suites were retained.
- Audit tests cover legacy and migrated databases, exact prompt-byte/digest attribution, unknown legacy durations, failed preparation plus later delivery, setup/report-correction separation, prompt-secret omission, and unchanged database bytes during audit.
- The final full `pnpm test` run passed: **877 tests, 873 passed, 4 skipped, 0 failed**. Spec: 48/48; special-agents: 92/92; CLI: 199 passed and 2 skipped; ai-foreman: 534 passed and 2 skipped. The four skips are the two platform-dependent TTY runner checks and two opt-in authenticated live-provider smoke tests. Skips are not counted as passes.
- The final receipt/audit/migration check passed 23/23 after the last replay refinement. Readiness cleanup passed 9/9, including an owned descendant that ignored TERM and redirected its pipes; the full suite also included this regression. These overlap the workspace suite.
- Final `pnpm typecheck`, `pnpm build`, `node --import tsx packages/rafi/scripts/generate-cli-docs.ts --check`, and `git diff --check` all passed. Typecheck caught and corrected a new audit fixture's Builder-versus-QA identity mismatch before the final passing run.

Final full-suite log: `/tmp/rafi-qa-handback-baseline/workspace-test-verified.log`; final type/build logs: `typecheck-last.log` and `build-last.log` in the same directory. Receipt/audit regression log: `receipt-audit-final.log`. The checkout continued to receive unrelated concurrent edits, so these are the actual observed test results, not a claim that untested future edits are covered. Source changes made during the final run received the focused follow-up checks above and final workspace compilation.

The final workspace commands used the installed runtime explicitly:

```sh
PATH=/Users/tyler/.nvm/versions/node/v20.19.0/bin:$PATH NPM_CONFIG_CACHE=/tmp/rafi-qa-handback-baseline/npm-cache pnpm test
PATH=/Users/tyler/.nvm/versions/node/v20.19.0/bin:$PATH pnpm typecheck
PATH=/Users/tyler/.nvm/versions/node/v20.19.0/bin:$PATH pnpm build
/Users/tyler/.nvm/versions/node/v20.19.0/bin/node --import tsx packages/rafi/scripts/generate-cli-docs.ts --check
git diff --check
```

Deterministic measurements from the converted fixture gate (not production/model latency):

| Scenario | Total Builder sends | Prompt bytes per send | Result |
| --- | ---: | --- | --- |
| Valid | 1 | 5,785 | Remediation reported; QA still required |
| Valid with continuity wrapper | 1 | 6,253 | Remediation reported; QA still required |
| Prologue requiring response repair | 2 | 5,785; 4,140 | One combined repair, accepted contract |
| Genuine blocker | 1 | 5,785 | Blocked and stopped |
| Actual question | 1 | 5,785 | Needs input and stopped |
| Completed-operation replay | 1 across both calls | 5,785 | No second dispatch |

The 20-cycle history regression stayed within four entries, excluded nested reports/requests, and limited cycle-20 growth to 30 bytes over cycle 4 for the fixed issue fixture. These measurements demonstrate bounded operations/prompt history only; they do not establish a live pre/post latency improvement.

The sandbox prevents the `tsx` CLI's local IPC and some test subprocess inspection/package operations. The ordinary offline `pnpm test` runs therefore used the approved unrestricted execution profile with a temporary npm cache. Direct focused tests used `node --import tsx --test`. No `test:live-*` suite or real provider session was invoked.

The first unrestricted workspace run exposed four ticket-population failures; all four also reproduced on a reconstruction of the original dirty checkout. Concurrent ticket changes subsequently fixed those cases. Later verification caught an empty-output readiness fixture and an outdated noninteractive-blocker message assertion: the fixtures now require actual `OK` completion and the durable waiting/resume message respectively. Final results below supersede intermediate failures; intermediate logs are retained.

### Consistent real-record copies

SQLite's backup API read the originals using `mode=ro`, including WAL-visible data and the complete inline `content_refs` evidence store. Only isolated temporary copies were migrated. Nonportable copied writer-lease rows were removed on those copies, never on the originals. Both copies migrated and reopened twice with `integrity_check=ok`, zero foreign-key errors, unchanged evidence bytes, and unchanged counts:

| Project copy | Reports | Findings | Dispositions | Chains | Handoffs | Receipts | Evidence objects |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MoneyFarm | 3 | 3 | 6 | 3 | 3 | 2 | 153 |
| MoneyTree | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

MoneyFarm's historical missing turn journals remain unknown in the audit; no turns or terminal events were fabricated. This verifies the records available in these copies, not every possible legacy state or external recovery-packet restore. The original databases, active leases, provider sessions, and real builds were not upgraded, resumed, or repaired.

### Files and regression surfaces

- New implementation modules: `qaHandbackMigration.ts`, `qaDeliveryJournal.ts`, `qaHandbackHistory.ts`, and `qaPrerequisites.ts` under `packages/ai-foreman/src/`.
- Delivery/persistence integration: `qaFailureDelivery.ts`, `workflowDb.ts`, `qaProtocolV2.ts`, `qaReview.ts`, `foreman.ts`, `branch/runner.ts`, `stateTransfer.ts`, and the recovery CLI.
- Provider/lifecycle integration: `activity.ts`, adapter types/Codex/Claude, `continuity.ts`, runtime readiness/authentication, `agentRun.ts`, CLI startup/readiness logging, and log event types. Existing concurrent changes in these files remain present.
- Public contract: spec types, schemas, validation, response parser, and exports; CLI `--answer` help/documentation.
- New focused suites: `qaHandbackMigration`, `qaHandbackSafety`, `qaHandbackCallers`, `qaHandbackLease`, `qaPrerequisites`, and spec `qaRemediationV3`; converted `qaHandbackInvestigation`; frozen `fixtures/qa-handback-v2.sql`. Existing delivery, recovery, Foreman, Codex, readiness, and CLI fixture tests were updated where stronger required evidence changed their setup.
- Diagnostics: `scripts/audit-qa-handback.mjs` opens a coherent read-only transaction and emits metadata without default raw prompts/responses. This plan retains the 26-case ownership mapping in section 7.

### Remaining evidence and deployment limits

P12/P13 are not claims that the original production latency causes are solved. Compaction now has correlated waiters, cleanup, bounded configurable deadlines, and explicit uncertainty handling; readiness traces spawn/output/exit/stdio/cleanup and requires both `OK` and clean completion. A live writer is not stolen merely because its heartbeat expired; verified dead-owner reclamation remains fenced. Deterministic tests demonstrate these protections, but they do not establish which lifecycle event caused the original MoneyFarm/MoneyTree waits. No readiness cache was introduced.

For the original causes, the remaining evidence is a correlated request/acknowledgement/completion/fresh-usage trace for compaction, and a spawn/exit/stdio/process-ownership trace for the readiness/writer wait. Collect those only in an authorized disposable live canary before making latency or timeout-policy claims. Historical pause durations remain unknown rather than inferred from unexplained elapsed gaps. Fake-provider timing is host overhead; there is no claimed production latency improvement or population baseline.

Deploy using section 9: stop writers, take a consistent backup including evidence, validate a copy, then upgrade deliberately. An old binary is not a schema rollback. Prefer a forward repair; restoring an older backup requires accounting for later outcomes and preventing their side effects from being replayed. No destructive down-migration, live rollout, dependency provisioning, or automatic waiver is part of this implementation.

## 12. Follow-up audit and review

The requested follow-up audit found four correctness gaps despite the earlier passing suite. Each is fixed in the working tree:

1. **P1 — Production wrappers hid required observation.** `RecoveringAdapter`, `CurrentWorkflowGuardAdapter`, and `RoleStatusAdapter` did not forward `observeEvents` or deferred handback checkpoint acceptance. The CLI composes these wrappers, so direct-provider and continuity-only fixtures missed a path that stopped valid production handbacks before dispatch. The wrappers now forward synchronous provider observation and checkpoint acceptance while preserving the ordinary event consumer. Ten new cases exercise both providers through the complete wrapper stack: normal completion, one response correction, tool-using correction, provider error, and missing observation. Hidden recovery retries remain prohibited.
2. **P2 — Recovery did not recognize handback completion.** `hasUncheckpointedRoleTurn` and the Builder handoff progress counter did not recognize `handback_turn_completed`. Accepted work could therefore appear unfinished or unproductive. Both readers now recognize the new event and require the matching role. The new progress test also exposed an existing counter error: useful work since the previous request did not reset the limit until another request was already recorded. The counter now resets before deciding whether to allow that request. Tests verify accepted checkpoints clear Builder uncertainty, another role cannot clear it, and real handback progress resets the unproductive-handoff limit.
3. **P1 — Legacy receipt validation was incomplete.** Migration checked report ownership but did not reconcile each receipt's remediation/review attempt, embedded scope, or embedded evidence references. Three reproductions previously migrated successfully despite a receipt from another review, conflicting receipt scope, or missing response evidence. Migration now rejects those cases transactionally; tests verify rollback and successful retry after explicit fixture repair. Handoff attempt validation also checks the complete run/ticket/review/source/report binding.
4. **P1 — Delivery did not fully bind its current review.** The caller could supply a foreign review attempt, stale remediation generation, or superseded report while retaining matching content/source inputs. Three reproductions dispatched work before the fix. Validation now checks the durable failed attempt, open report occurrence, source/review basis, current review number, and remediation generation before preparation and again inside intent reservation. All three cases now perform zero preparations and zero Builder sends.

The audit also removed a duplicated readiness cleanup signal/trace. Unrelated existing work was preserved. No agents or live provider sessions were used.

The new wrapper and migration tests were run before fixes and failed for the expected reasons; the checkpoint assertion then exposed the second integration gap after wrapper forwarding was repaired. Red-test logs are `audit-wrappers-red.log`, `audit-migration-red.log`, `audit-fixes-focused.log`, and `audit-scope-red.log` under `/tmp/rafi-qa-handback-baseline/`. The passing wrapper/migration/recovery/continuity gate was 61/61; the later delivery/caller/all-26-diagnostic gate was 63/63. Those gates overlap. Seventeen new cases were added overall, with an existing uncertainty test strengthened as well. The first full audit run caught duplicate synthetic events in the newly added progress fixture; correcting their identities exposed the counter defect above (`audit-progress-red.log`), which was then fixed and verified.

The stricter migration was rechecked on fresh backups of the previously captured temporary MoneyFarm/MoneyTree copies. Only these new temporary fixtures were restored to the frozen V2 table layout and upgraded twice. All original evidence bytes and the section 11 row counts remained unchanged; integrity and foreign-key checks passed. These fixtures are under `/var/folders/g1/wq3b58m917qdvtbjzqxr0n740000gn/T/rafi-qa-audit-copies-x2dkSy/`. This is a compatibility recheck using existing captured records, not a new live snapshot or live upgrade.

Workspace typecheck, build, and CLI documentation checks passed after the audit fixes. Intermediate full runs are retained in `audit-workspace-test.log` and `audit-workspace-verified.log`. The second run exposed an older Foreman expectation after concurrent ticket-deferral changes: it now asserts a blocked deferred batch, zero completed tickets, and preserved missing QA approval. Its complete nine-test suite passed afterward. A readiness fixture also timed out before its shell produced output under suite load; the test deadline now permits one second for startup (production deadlines are unchanged), retains the bounded-completion assertion, and still checks that the owned descendant cannot survive cleanup. All nine readiness tests passed afterward. The section 11 live-provider and original production-cause limitations still apply.

Final full workspace run: **903 tests, 899 passed, 4 skipped, 0 failed**, exit 0. Spec: 48/48; special-agents: 92/92; CLI: 199 passed, 2 skipped; ai-foreman: 560 passed, 2 skipped. This includes concurrent additions elsewhere in the checkout, not just the 17 cases added by this audit. Skips remain the two platform-dependent TTY checks and two opt-in authenticated provider tests. Final log: `/tmp/rafi-qa-handback-baseline/audit-workspace-final.log`. Final typecheck and build logs are `audit-typecheck-final.log` and `audit-build-final.log`; focused progress, Foreman, and readiness logs are `audit-progress-final.log`, `audit-foreman-final.log`, and `audit-readiness-final.log` in that directory. CLI documentation and `git diff --check` also passed. No unresolved failure remains in these completed checks.
