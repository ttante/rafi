# QA handback investigation

The observed slowdown comes from repeated reviews of an unresolved environment blocker, expensive session boundaries, and Builder response formatting. QA produced valid, actionable failure reports on its first attempt in all three recorded reviews. Builder needed a response correction on every handback, and the third correction still failed. Two earlier remediation attempts were recorded as successful despite explicitly leaving the finding unresolved and changing no source.

This investigation covers the current checkout at `1b41606` plus the existing working tree, and local build records from October 7, 2026 Chicago time. The usable real sample is one MoneyFarm ticket, T001, with three reviews and three delivered handbacks. MoneyTree has zero recorded QA reviews or failure handbacks in its database. These are case measurements, not a population estimate of typical production latency or failure rates. No live model calls were needed. Production code and project run state were not changed.

## Measured timing and revision counts

| Measurement | Review 1 | Review 2 | Review 3 |
| --- | ---: | ---: | ---: |
| Complete QA review including preparation | 217.54 s | 182.84 s | 154.78 s |
| Durable review attempt after preparation | 188.51 s | 139.75 s | 125.17 s |
| QA report correction turns | 0 | 0 | 0 |
| Handback delivery invocation through final Builder validation | 166.80 s | 142.32 s | 174.01 s |
| Time before Builder remediation dispatch | 74.01 s | 29.35 s | 87.40 s |
| Initial Builder remediation model turn | 74.19 s | 97.35 s | 72.87 s |
| Builder response correction turns | 1 | 1 | 1 |
| Builder correction model turn | 17.04 s | 14.20 s | 12.41 s |
| Host handoff prompt size | 25,291 bytes | 49,250 bytes | 75,816 bytes |
| Source changed during remediation | No | No | No |
| Final delivery state | Recheck required | Recheck required | Response invalid |

QA reviews averaged 3m05s including preparation, with a median of 3m03s and range of 2m35s–3m38s. Handback delivery averaged 2m41s, with a median of 2m47s and range of 2m22s–2m54s. A review plus its completed or resumed handback invocation averaged 5m46s. Builder formatting corrections added 43.65 seconds of model time in total, averaging 14.55 seconds each.

The third handoff was first prepared at 00:02:09 UTC and finished at 00:48:32 UTC: 46m23s of elapsed time. Its final resumed delivery invocation took only 2m54s. Treating the earlier preparation timestamp as continuous service work would greatly inflate the metric. Similarly, the gap between the first completed handback and the next durable review attempt was 51m43s; the corresponding second-to-third gap was 29.63 seconds.

From first QA start to the final invalid response, 1h51m49s elapsed. The three logged QA durations plus the three final delivery invocation durations sum to about 17m18s. The rest includes failed runtime/session setup, interruptions, recovery and resume gaps; it cannot all be classified as either model work or user idle time from these records. Initial Builder implementation, before this QA loop, also took 14m31s.

QA report rewrites, Builder response corrections, fresh QA reviews, and packet manifest revisions are different quantities. Here there were three full QA reviews, zero QA report corrections, three Builder corrections, and a final recovery packet at revision one with zero QA correction turns. Counting packet revisions as agent revisions would be misleading.

## Findings and causes

### Environment blockers enter the remediation success path

All three reviews identified the absent `pnpm-lock.yaml`. The first two accepted Builder reports explicitly say the finding is valid but cannot be fixed because registry DNS returned `ENOTFOUND` and offline resolution returned `ERR_PNPM_NO_OFFLINE_META`. Both use the finding disposition `disputed`, even though their prose agrees with QA. The reviewed source digest and post-remediation digest are identical across the entire sequence.

The handoff prompt requires Builder to address or dispute each finding and end with `STEP_STATUS: done`. Its finding schema offers only `fixed` and `disputed`. A valid report takes the remediation `succeeded` path regardless of whether the findings were fixed, disputed, or accompanied by failed verification. The QA loop then spends a fix attempt and schedules another full review. This is sufficient to explain the observed repeated review of the same missing file. It does not produce a false QA pass, but it consumes time without making progress.

An unchanged source digest alone cannot justify skipping QA: a legitimate dispute or new evidence can warrant re-evaluation. The missing distinction is a structured environment blocker and whether anything relevant changed, coupled with a stop condition for the same unresolved blocker.

Code: [handoff instructions](../packages/ai-foreman/src/qaFailureDelivery.ts#L652), [successful remediation receipt](../packages/ai-foreman/src/qaFailureDelivery.ts#L425), [repeat review loop](../packages/ai-foreman/src/qaReview.ts#L313), [finding schema](../packages/spec/src/schemas.ts#L69).

### Session management adds substantial time and stops otherwise usable work

Four Builder compaction attempts are recorded: three failed after about 30 seconds, one succeeded in 27.99 seconds. Two completed fallback Builder handoffs took 42.33 and 54.72 seconds. These explain much of the 29–87 seconds before remediation dispatch. Two completed QA session transfers took 19.16 and 12.09 seconds, in addition to snapshot/session preparation.

The logs contain two readiness failures after roughly 30 seconds, with `codex exec` output that already includes `OK`, plus model-refresh/network errors. Another resume stopped because the session already had an active writer. These are distinct from report-generation failures. The readiness probe waits for process completion under a fixed deadline; receiving `OK` is not enough under its current policy. The logs do not establish why those processes failed to exit or why the competing writer remained active.

The compaction error text says “1 minutes” although the actual timeout is 30 seconds, because the message rounds minutes. This is an additional diagnostic accuracy issue.

Code: [compaction waiters](../packages/ai-foreman/src/adapters/codex.ts#L195), [runtime probe](../packages/ai-foreman/src/runtimeReadiness.ts#L80), [QA runtime creation](../packages/ai-foreman/src/cli/start.ts#L868).

### Builder formatting recovery is frequent and weakly informed

Each of the three handbacks dispatched an initial Builder turn and a 685-byte correction prompt. Two corrections were accepted. The third initial response failed because the envelope was not first; its correction ended with an extra `}` after the status summary and was rejected with `malformed STEP_STATUS field near: }`.

The initial raw responses for the first two handbacks are not individually referenced by the final delivery receipts, so their exact initial formatting errors cannot be established from those receipts. The continuity journal independently establishes both turns and their timestamps. Their correction count is not inferred from packet revisions.

The correction function does not receive the parser errors. It supplies a generic shape with placeholder JSON, handoff identity, source digest and finding keys, but neither the actual validation error nor the full response schema. The initial instruction says “Return exactly,” while the parser specifically requires the envelope to be the first nonempty content. Simulations reproduce rejection of an otherwise valid report with a prose preamble and the final extra-brace failure.

Code: [initial validation and correction](../packages/ai-foreman/src/qaFailureDelivery.ts#L240), [correction prompt](../packages/ai-foreman/src/qaFailureDelivery.ts#L373), [response parser](../packages/spec/src/qaFailureReport.ts#L76).

### An errored correction can be accepted as successful

A simulation returned a malformed initial response followed by a schema-valid correction with `isError: true`. Delivery returned `ok: true`, recorded remediation as successful and recorded `providerReturnedError: false`. The initial-turn path checks provider errors, but `tryCorrectResponse` checks source stability, tool events, turn identity and syntax without checking the correction's error flag. This is a demonstrated correctness defect, although no such errored correction was observed in the real sample.

The correction path also lacks the explicit before/after Builder session-identity comparison used for the initial turn. The follow-up simulations confirm that a correction from a replacement session is accepted while its receipt names the original session.

Code: [correction acceptance](../packages/ai-foreman/src/qaFailureDelivery.ts#L393).

### Delivery receipts mix evidence from different turns

Every real final receipt reports `hostInstructionBytes: 685`, but its `hostInstructionDigest` resolves to the original 25,291-, 49,250-, or 75,816-byte handoff. The digest is passed from initial dispatch while the length is taken from the correction turn. The final provider prompt and response describe the correction. A simulation reproduces this inconsistency.

The original rejected response and its validator errors also need their own durable, linked turn record. Without that record, the handoff receipt cannot explain the complete correction history. For the failed correction, the returned `providerTurnId` is the initial turn's ID while its returned response can be the correction's text; this is another mismatch visible in the code.

Code: [receipt fields](../packages/ai-foreman/src/qaFailureDelivery.ts#L436), [failed correction return](../packages/ai-foreman/src/qaFailureDelivery.ts#L259).

### Prompts grow despite no new source changes

The handoff grows from 25.3 KB to 49.3 KB to 75.8 KB. QA review prompts grow from 11.6 KB to 34.1 KB to 60.9 KB. Full reports, prior response summaries and historical remediation requests are reintroduced across cycles; the current report also appears in the accumulated history. The prompt contains both the complete ticket and separate acceptance/test lists, plus observations already present in the report.

This is measured redundant context growth. Its exact latency or token-cost contribution cannot be isolated from three runs with different session behavior, so no causal percentage is claimed. The host limit is 512 KiB rather than an efficiency budget. Compact, explicit unresolved-finding history would reduce repeated material while retaining exact evidence by digest.

### Blocker details can disappear from the operator message

A simulated `STEP_STATUS: blocked | reason="Registry DNS unavailable"` correctly stops remediation, but the returned detail only says the status is not valid for successful remediation. It drops the actual reason because the delivery layer uses `contract.errors` instead of `contract.fields.reason`. The raw response remains available; the operator-facing explanation is less useful than the evidence.

Code: [blocked handling](../packages/ai-foreman/src/qaFailureDelivery.ts#L246).

## Quality of the QA reports

All three reports contain one focused finding, concrete locations, an observed audit error, expected behavior, a plausible fix direction and four verification steps. They cite the ticket's reproducibility requirement, distinguish static checks from runtime checks, warn against fabricating a lockfile, and acknowledge missing Docker/dependencies. Their 9–12 checks and approximately 4.8–5.1 KB of report JSON are useful evidence for Builder. They do not claim that unexecuted tests passed.

The main quality weakness is classification: several dependency-backed commands are marked `failed` even though the prose says the tools never executed because dependencies were unavailable. `not_run` with an environment reason would be clearer. Later reports add little actionable information beyond reconfirming the same blocker. The host then asks Builder to fix something its own prior report says requires a different environment.

The QA snapshot projects existing dependency trees into the review copy, but it does not install missing dependencies. QA is read-only. In this run dependencies were absent in the delivered workspace, and QA recorded `EPERM` when attempting installation. Registry access and Docker availability need an explicit prerequisite/recovery path; repeated application review does not supply them. Whether DNS failures originated in sandbox policy or external connectivity is not established by these records.

## Recent changes and verification

The September 7 commit `a874f0f` introduced the extensive V2 changes: durable source/report identities, delivery receipts, reducer state, stronger recovery and session handoff behavior. It replaced the older multi-stage report reconstruction ladder with one same-session QA correction followed by a pause requiring fresh review. Later October 6 changes also touched QA. The current one-correction policy is covered by tests; the leftover “nine turns” text is not the active automatic path.

There is no comparable pre-change real handback sample here, so these measurements do not establish a before/after regression magnitude.

The existing targeted suite passed all 82 tests in 99.08 seconds. It covers delivery, QA recovery, snapshots, protocol transitions, handoff acceptance, runtime/session preparation and report parsing. The production delivery test previously covered one successful path.

The initial six characterization simulations in [qaHandbackInvestigation.test.ts](../packages/ai-foreman/test/qaHandbackInvestigation.test.ts) all passed and reproduced the behavior above. They use real Git captures, SQLite persistence, the production delivery service and deterministic in-memory providers. Delivery itself took 0.91–1.64 seconds on tiny fixtures with no model or compaction latency. Those values measure local control-path overhead only; they are not predicted production turnaround times. The tests intentionally assert current defects, and should be changed to desired behavior when fixes are implemented. The follow-up below expands this coverage to restart, wrapper and fault-injection scenarios.

The follow-up suite passed all 191 existing targeted tests in 111.46 seconds, covering QA, recovery, snapshots, contracts, runtime readiness, the Codex adapter, continuity, Foreman, branches and finalization. All 26 characterization simulations passed in 41.26 seconds, and the ai-foreman TypeScript check passed again. These 217 passing tests include assertions reproducing defects; they do not mean those defects are repaired. The simulation harness was corrected during development for terminal-event emission and boundary preparation, and the identical-report collision was isolated into its own test. No production behavior was changed to make tests pass. No full monorepo suite or live provider benchmark was run.

## Additional correctness findings

The extended simulations establish service and recovery defects, not additional occurrences in the three recorded MoneyFarm handbacks. They also retain positive controls for valid responses, continuity-wrapped responses, source drift, correction source changes, and duplicate-delivery prevention.

### Restart accounting does not count production handbacks

Production delivery records recovery attempts under `qa-failure-delivery:T001`, while `persistedQaFixCount` reads `qa-fix:T001`, the legacy test path's key. In one uninterrupted loop the in-memory counter still advances; on restart that protection is lost. A simulation completes one production handback, restarts `runIsolatedQa` with `maxCycles: 1`, and observes another automatic delivery request after a failing recheck. This is a demonstrated restart-budget bypass, not an assertion that an individual uninterrupted loop is unbounded.

Code: [production attempt key](../packages/ai-foreman/src/qaFailureDelivery.ts#L341), [restart counter](../packages/ai-foreman/src/qaReview.ts#L481).

### Identical reports collide across review attempts

`qaReportDigest` hashes only the report JSON, but `qa_reports` uses that digest as the primary key for a row containing run, ticket, review and disposition. A complete recheck returning the same valid report fails with `UNIQUE constraint failed: qa_reports.report_digest`. This is separate from the retry-budget issue. The database layout also makes identical report content across tickets or runs share the same collision risk.

The repair must separate content identity from scoped review occurrence. Simply ignoring the duplicate insert or updating the old row would risk attaching findings, dispositions and recovery state to the wrong review.

Code: [content digest](../packages/ai-foreman/src/qaRecovery.ts#L484), [unconditional insertion](../packages/ai-foreman/src/workflowDb.ts#L1036), [report table and foreign keys](../packages/ai-foreman/src/workflowDb.ts#L1772).

### Repair can bypass identity and outcome checks

Simulations show that the delivery service accepts a valid envelope with foreign provider-session metadata, a Builder session scoped to a different working directory, or structured provider failure metadata when `isError` is false. A malformed initial response without a turn ID can be accepted through a later correction because the initial ID check comes after the correction branch. These are service validation gaps; the simulations do not establish that production adapters normally emit these combinations.

An initial `needs_input` response goes into formatting repair and can become `done` without the question being answered. A correction returning `blocked` is classified as response-invalid, with the actual blocker omitted. Neither condition should be repaired into a success assertion.

Code: [initial acceptance ordering](../packages/ai-foreman/src/qaFailureDelivery.ts#L224), [session validation](../packages/ai-foreman/src/qaFailureDelivery.ts#L691). Compare the stronger [QA session validation](../packages/ai-foreman/src/qaReview.ts#L1356) and [QA turn identity checks](../packages/ai-foreman/src/qaReview.ts#L1453).

### Correction tool enforcement is not connected in production

`tryCorrectResponse` only checks tools through optional `controller.events`. Neither the Foreman nor branch runner supplies this array. The paired simulations emit the same tool event: supplying an event sink rejects the correction; omitting it accepts the correction. The source digest guard still rejects persistent project-file changes, but cannot prove that no tools ran or that no external side effects occurred.

Code: [optional event check](../packages/ai-foreman/src/qaFailureDelivery.ts#L383), [Foreman caller](../packages/ai-foreman/src/foreman.ts#L562), [branch caller](../packages/ai-foreman/src/branch/runner.ts#L437).

### Continuity adds a separate repair layer

The production Builder continuity wrapper can make additional provider calls inside a delivery service turn. Its continuity-only repair accepts a syntactically valid delta without checking the repair's `isError`. A wrapped simulation returns an errored continuity repair and still produces successful handback delivery. The final delivery receipt names the original turn and does not describe this internal repair. A separate positive control confirms that a normal continuity-wrapped remediation envelope is accepted correctly.

Disabling the wrapper globally would remove durable continuity guarantees. The safe repair is explicit accounting and validation of inner turns, or a coordinated single-turn mode specifically at the handback boundary with equivalent continuity validation and recovery.

Code: [continuity repair and successor paths](../packages/ai-foreman/src/continuity.ts#L153), [production Builder wrapper](../packages/ai-foreman/src/cli/start.ts#L947).

### Interrupted corrections and partial writes leave inconsistent evidence

A thrown correction dispatch is described as uncertain in its message but stored as `response-invalid`. A source-capture exception after correction escapes without a linked delivery receipt, leaving remediation started and delivery intended. Initial session replacement correctly fails closed, but that path drops the already-returned response from its receipt.

A fault injected immediately after the remediation outcome commit leaves the reducer at `recheck-required` and remediation at `succeeded`, while the handoff remains `delivery-intended` without its receipt link. Core reducer transitions are transactional, but the surrounding handoff updates are separate writes. The existing state gate still prevents straightforward replay of a completed delivery; the demonstrated problem is incomplete and inconsistent completion evidence, not proof that recovery currently duplicates side effects.

Code: [correction exceptions](../packages/ai-foreman/src/qaFailureDelivery.ts#L393), [completion writes](../packages/ai-foreman/src/qaFailureDelivery.ts#L463), [transactional core outcome](../packages/ai-foreman/src/workflowDb.ts#L1140).

## Resolution plan and regression safeguards

Correctness repairs come before latency optimization. The following is the expanded list for the inspected paths; the exact causes of provider shutdown delays and active-writer retention still require provider-level traces. None of these production repairs has been implemented in this investigation.

### First make outcomes and recovery dependable

1. **Centralize validation for every provider turn.** Check error flags and structured failures, scoped session identity, canonical working directory, turn identity and correlated completion before parsing a result as successful or starting syntax repair. Validate initial, correction and inner continuity turns equally. Preserve rejected bytes and metadata. Regression tests must cover both providers, allowed timestamp-only identity refresh, legitimate validated session transfer, missing terminal events and source drift.

2. **Make correction genuinely response-only.** Connect the existing event owner to both production delivery callers with turn correlation and a completion barrier; do not add a competing consumer of the same event stream. Enforce tool restrictions at dispatch where supported, retain source-before/source-after checks, and pause if response-only behavior cannot be established. Test delayed tool events, read-only tools, edits, edits later reverted, absent observation, and wrapper-internal repairs. Merely adding a prompt prohibition or checking unchanged source is insufficient.

3. **Distinguish blocked, needs-input, disputed and fixed outcomes.** Preserve the blocker or question from both initial and correction turns. Route genuine questions through the existing operator decision mechanism or pause safely when unattended. Add a structured environment-blocked result, including partial remediation and verification-not-run reasons. A reported fix or dispute still requires independent QA; Builder never grants its own pass. Update schemas, parser, prompts, reducer, persistence and both callers together, with backward-compatible reading of existing V2 records. Do not infer that old `disputed` prose is a trustworthy structured blocker.

4. **Unify durable retry accounting.** Use one authoritative count of dispatched remediation operations across ordinary execution and restart. Reconcile legacy and production keys without double counting; count failed or uncertain dispatches conservatively, and distinguish pre-dispatch preparation failures. Explicit operator-authorized extra attempts must be recorded separately. Test exhausted budgets across repeated restarts, all outcome paths and both production entry points.

5. **Give each report occurrence its own scoped identity.** Retain immutable report bytes by content digest, but identify each review's report, findings, disposition and chain by run, ticket and attempt. Migrate referencing tables and recovery bindings transactionally on copied databases before deployment. Test identical JSON on the same ticket, different tickets and different runs; replay of the same occurrence; and independent waiver/resolution. Do not fix the collision with `INSERT OR IGNORE` or overwrite old review metadata.

6. **Make dispatch and completion persistence consistent.** Commit local dispatch intent facts together before calling the provider. Journal initial and repair turns independently, with exact prompt/response digest-byte pairs, errors, session IDs and timing. Commit terminal outcome, handoff links and reducer transition atomically, or supply an explicit idempotent reconciliation protocol. Never hold a database transaction open across a provider call. On transport, identity or capture uncertainty, retain available evidence, pause safely, and reconcile current source before another remediation dispatch. Inject crashes at each persistence boundary and prove no duplicate Builder work, lost confirmed outcome or stale QA pass.

### Then eliminate repeated work without weakening QA

7. **Stop unchanged blocker loops.** After a structured blocker, pause the automatic fix loop with a precise recovery action. Resume when relevant source, environment capability, evidence or an authorized decision changes. Persist this state across restarts. Source equality alone must not suppress a valid dispute or a no-code fix. Finding keys are review-scoped, so loop detection needs stable issue identity rather than matching those keys or fluctuating prose verbatim. Test partial fixes, genuine disputes and environment-only recovery.

8. **Improve the first response and its one bounded repair.** Supply exact parser errors, authoritative schema and current finding coverage. Explain envelope-first and status-last requirements on the cleaned response and explicitly permit the required continuity record in the raw response. Include truthful blocked/needs-input alternatives. Coordinate continuity and remediation repair budgets so hidden inner retries cannot multiply work. Preserve strict rejection of duplicate keys, wrong handoff IDs, missing findings, oversized payloads and contradictory status markers. Do not loosen validation or restore an unlimited repair ladder.

9. **Check test prerequisites before expensive QA.** Record available dependency trees, required executables/services and the relevant network capability without attempting unapproved installations or changing source. Route missing prerequisites to an explicit environment-recovery step; validate again after changes. Bind cached prerequisite evidence to the actual worktree, lockfile, toolchain and sandbox configuration. Keep QA read-only and distinguish a failed test from a test that never ran. Test static-only projects, missing Docker, absent dependencies, changed lockfiles and offline operation.

10. **Bound prompt history while preserving evidence.** Keep the complete current requirements and unresolved findings once, summarize prior outcomes without recursively embedding previous handoffs, and retain exact historical objects by retrievable digest. Reserve model context for the response and continuity metadata, not just the 512 KiB host limit. Test long Unicode reports, many findings, multiple cycles and unavailable evidence retrieval. Never silently truncate mandatory findings or acceptance criteria.

### Finally optimize and measure session overhead

11. **Repair lifecycle handling using measured provider evidence.** Trace compaction request acknowledgement, completion and fresh usage separately; distinguish slow progress from silence and use bounded configurable deadlines. Preserve fresh-usage proof and context-capacity checks. Validate late, missing, duplicate and out-of-order events, successful slow compaction, failed fallback and cancellation. Report actual timeout units. Do not optimize by assuming compaction succeeded or by skipping necessary session validation.

12. **Separate runtime readiness from shutdown and writer ownership.** Identify why a successful-looking probe remains alive; stdout `OK` alone is not proof of clean completion. Reuse readiness evidence only when provider, executable, authentication/configuration, model, environment and confinement remain equivalent, with expiry and failure invalidation. For writer recovery, verify process identity and lease ownership, including PID reuse; never delete a live lease or kill an unrelated process to make a resume work. Test changed authentication, hung shutdown, live competing writers, stale writers and repeated resume. These require more traces before choosing a specific timeout or caching policy.

13. **Measure progress and report quality separately from transport success.** Record phase durations, all provider turns including continuity repairs, correction reasons, prompt sizes, retries, pauses, environment blockers and verification execution. Report findings fixed, disputed and blocked separately. Add semantic QA checks for `failed` versus `not_run` without declaring a pass merely because report formatting is valid. Benchmark multiple representative tickets/providers and report sample counts and latency percentiles; the current three-handback sample cannot establish general performance targets.

### Release gates

Land these in small dependency-aware changes, starting with validation, evidence preservation and retry accounting. Introduce new outcome semantics and report-occurrence identity with explicit compatibility tests and database backups; test migrations and restart on copied real records. Convert each defect characterization into a desired-behavior assertion as its repair lands, retaining successful-path controls. Expand through the actual Foreman and branch call sites instead of relying only on the legacy `fix` test seam.

Required invariants are: no automatic acceptance of errored or wrong-session work; no unanswered question coerced to done; no automatic retry beyond the durable budget; no duplicate remediation after uncertain dispatch; no lost report lineage; and no ticket completion without a current source-bound QA pass or explicit authorized waiver. Keep existing read-only QA, source-drift, pass-certificate and finalization tests green. Only then benchmark latency changes with controlled provider runs. An optimized path that weakens any of these guarantees is not an acceptable resolution.

## Reproducing the audit

The [read-only audit script](../scripts/audit-qa-handback.mjs) uses SQLite's read-only mode and reads `.foreman` JSONL records. It emits timing, prompt sizes, source changes, finding dispositions, compactions and session handoffs without launching agents or resuming builds:

```sh
node scripts/audit-qa-handback.mjs /Users/tyler/reps/moneyFarm
node --import tsx --test packages/ai-foreman/test/qaHandbackInvestigation.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/ai-foreman/tsconfig.json
```

Tests and typechecking were run under Node 20.19.0. SQLite needs normal read access to any active journal files. The audit reads a live database through multiple queries, so a concurrent build can change its results between queries; the recorded sample was unchanged across repeated inspections.

Primary local evidence is `/Users/tyler/reps/moneyFarm/.rafi/recovery.sqlite3` and the `.foreman` logs beginning `2026-10-07T22-40-36-350Z`, `2026-10-07T23-19-37-561Z`, `2026-10-08T00-33-25-613Z`, and `2026-10-08T00-45-22-059Z`. Database and log timestamps are UTC; these events occurred during the evening of October 7 in Chicago. The report preserves measurements without copying full provider transcripts into this repository.
