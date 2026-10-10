# QA prebuild implementation handoff

This records the implementation of [the plan](qa-prebuild-implementation-plan.md) and [requirements](qa-prebuild-requirements.md). The feature is opt-in. Missing configuration remains `legacy`; existing final QA enablement is independent of preparation.

## Operation and supported providers

Set the following in the canonical project's `rafi-config.yaml` before creating a new run:

```yaml
qa_preparation:
  mode: enforce # legacy | shadow | enforce
```

The resolved mode, policy version and five wall-time ceilings are immutable per run. Resume uses that record. Older runs without the record acquire the explicit legacy compatibility policy, even when the current file enables enforcement. Invalid new configuration fails validation. Planner commands resolve the same policy before a build run exists and retain their policy/depth provenance in approved plans.

`legacy` retains the existing QA protocol and skips preparation. `shadow` prepares and assesses a contract without representing its result as an implementation gate or inventing delivery receipts. `enforce` requires a ready contract, acceptance by the actual scoped Builder session, structured Builder evidence and contract-aware final coverage whenever independent final QA is enabled. Disabling final QA does not disable enforcing preparation; such completion remains independently unverified.

Claude supports enforcing delivery through the actual SDK `PreToolUse` and `PreCompact` hooks. Preparation, planning, response repair, initialization and acceptance are confined before tool execution. Native compaction revokes acceptance; mutating tools remain blocked until host delivery renews it. Child-agent tools are denied under enforcement. Read-only preparation intentionally denies shell tools rather than attempting to infer that arbitrary shell commands are harmless.

Codex uses actual RPC read-only/approval options for confined phases, but its adapter does not expose a proven native mid-turn compaction barrier. **Codex enforcing preparation is unsupported and stops before implementation with an `unsupported-capability` diagnostic.** Legacy/shadow remain available. The new-project template consequently remains legacy. No live provider evaluation or provider capability claim beyond the controlled adapter tests was made.

## Runtime and persistence

Public artifacts and strict schemas live in `packages/spec/src/qaPreparation.ts` and `qaPreparationSchemas.ts`. The implementation uses the existing WorkflowDb connection, admissions, original lease fences, operation journal, human decisions, review reducer, finalization and source snapshots. It does not introduce another authority database.

| Service | Responsibility |
|---|---|
| `qaPreparationPolicy.ts` | Cumulative five-level obligations, host risk minimums, explicit Focused justification, depth revision validation and configuration resolution |
| `qaPreparationInputs.ts`, `buildWorkContext.ts` | Full admitted ticket, exact approved plan/slice and complete context; accurate independent-review wording |
| `qaEffectiveConfig.ts` | Canonical rules, compiled role bundle, checklist and explicitly loaded skills with provenance; shared final-role instructions |
| `qaVerificationContract.ts` | Authoritative inventory, non-circular digest domains, stable check identity, deterministic coverage/readiness and independent semantic/challenge validation |
| `qaPreparationStore.ts` | Immutable contract/artifact/history records, mutable CAS head, logical budgets, reserved operations, retained progress, extensions and measurement events |
| `qaPreparation.ts` | Shared bounded planner/investigation/assessment/challenge orchestration and retained-result recovery |
| `qaBuildGate.ts` | Frozen policy, actual authoritative inputs, confined providers, readiness, amendments and shared preimplementation delivery |
| `qaContractDelivery.ts`, `providerPhase.ts` | Actual-session acceptance, excluded projections, lossless segmented delivery, scoped receipts and mutation barriers |
| `qaBuilderCoverage.ts`, `qaContractCoverage.ts` | Source-bound structured Builder claims and independently validated final per-check coverage |
| `qaContractFreshness.ts` | Authority-specific freshness and check/evidence reconciliation |
| `qaAuthorizedDisposition.ts` | Real persisted, exactly scoped equivalent-verification authority |
| `qaPreparationMetrics.ts` | Stable denominators, cause evidence, observation windows, missing-data handling and usefulness samples |

Standard is the fallback, obtained through a dedicated confined planner assessment rather than treating omitted metadata as a selection. Interaction, compatibility, state or external-dependency risks require at least Extensive; consequential authorization/security/data/migration/concurrency/recovery/deployment risks require Critical; unresolved architecture requires Exceptional. Every level retains the complete acceptance/test/checklist/rules inventory and separate semantic assessment. Exceptional additionally requires a fresh approach challenge with separate contract-quality and approach-risk conclusions.

Approved-plan input resolution includes global acceptance criteria/test plans as well as the exact admitted slice's acceptance/tests. Broader conditions remain explicit and must receive concrete coverage/applicability evidence; they are not dropped because a ticket represents only one slice. Requirement identity uses statement occurrences rather than list positions, so harmless reordering does not change check identity.

Logical budgets are keyed by run/work/admission, not provider attempt or lease generation. Default wall time is 5/10/20/30/45 minutes, measured from the original start and including downtime. Investigation allows two passes at Levels 1–2 and three at Levels 3–5; planner escalation and challenge are capped; each returned result has at most two format repairs. Dispatch reserves allowance before sending. Unknown dispatch remains uncertain and cannot be replayed automatically. A higher warranted depth raises the ceiling from the original start without resetting consumption.

Exhaustion retains evidence and creates a scoped durable human decision. A custom answer specifying `budgetId`, `reason`, an absolute `deadlineMs` and optional phase `caps` is accepted only from that answered decision. Resume applies the authorized extension without clearing consumed or uncertain reservations. Extending time does not reconcile an ambiguous external dispatch.

Retained semantic and approach concerns are explicitly supplied to targeted investigation and fresh assessment/challenge on resume. An unresolved Exceptional approach can use its single revised challenge round; it cannot disappear through an unchanged cached receipt or receive an unbounded retry budget.

Contract JSON/Markdown projections are under excluded `.foreman/qa-contracts`. The immutable DB artifact remains authoritative. Projections reject control-directory symlinks. Large delivery is Unicode-safe and byte-bounded, acknowledges every digest-bound section in the same session, and then acknowledges the complete contract. A missing section, foreign workspace, changed session/generation or compaction sequence cannot authorize implementation.

All normal implementation dispatches use the shared gate: Foreman, branch builds, synthetic work, Builder continuations, QA remediation and Manager-guided followups. Assignment SQL guards also reject old callers omitting the enforcing contract binding. Planning/startup and response correction use explicit confined purposes. Replacement Builders cannot automatically continue or replay an uncertain completed turn; they require host reconciliation and fresh delivery.

The post-implementation audit reproduced an additional recovery bypass: interactive runtime retry/switch could replace the inner adapter and replay an enforcing turn. Enforcing runtime failures now return to the host without choosing or creating a replacement; the failure explains that explicit resume must pass through the shared gate. Legacy recovery keeps its existing retry/switch behavior. A historical receipt alone cannot admit a newly constructed adapter, even when the native session ID, generation and compaction counter match. Delivery records an adapter-local acceptance only after durable receipt publication and barrier acceptance; assignment, remediation and Builder coverage verify it. Native compaction invalidates that acceptance through its sequence binding, and failed renewal clears it.

## Review, authority and recovery

The actual fresh final reviewer receives canonical rules/skills/checklist explicitly, even when ignored compiled configuration is absent from its disposable source snapshot. Prompt construction freezes that checklist once. Runtime metadata is compared with the actual canonical bundle. Author, assessor, challenger and Builder session identities cannot be reused as final-review identity.

Final review also receives the complete structured contract, retained baseline observation artifacts and their provider evidence, plus confirmed Builder coverage claims matching the current work, contract and source. A read-only JSON projection inside the QA snapshot carries the full context; its content digest is part of the instruction bound into the immutable review basis. Context up to 128 KiB is also inline; larger context is delivered as the complete readable resource. The reviewer must report inaccessible required evidence as blocked. Baselines remain historical evidence whose relevance must be assessed, and Builder claims remain subject to independent verification. Integration tests generate coverage exclusively from the provider-facing context, including preimplementation-only checks, rather than accessing host fixture contracts.

The predispatch review basis includes the contract revision/digest/admission and common configuration digest. It is persisted before dispatch. The input-basis envelope is appended after computing the base-instruction digest, avoiding a circular hash. Existing QA v2 canonicalization/digest semantics remain unchanged; new optional bindings are version-tagged.

Every check receives a final result, including advisory and conditional checks. Mandatory applicable failure, blocked/not-run verification, unresolved predicates, absent IDs or stale evidence prevent ordinary pass. Conditional not-applicable results require predicate evidence. Preimplementation-only success requires the retained baseline observation; postimplementation/both checks require current-source evidence. Builder claims are collected in a tools-disabled actual-session turn and do not substitute for independent QA.

Certificate issue and consumption both validate current ready head, revision/admission, immutable input basis, actual initial reviewer session, retained terminal receipt and exact structured coverage artifact. A generic `qa_pass` cannot complete enforcing work. The durable reducer/finalization protocol remains responsible for interrupted tracker or branch publication.

Preparation and final review reject a current ticket that differs from the frozen admitted definition; certificate authority additionally checks that exact ticket basis. Unapproved ticket edits cannot silently become new requirements or reuse an earlier contract/pass. QA-only tests cover this changed-scope rejection without replaying preparation or Builder work.

An equivalent method requires a real answered custom human decision scoped to `qa-equivalent:<contractId>:<revision>:<checkId>`, exact admission/expectation/method/runtime, expiry and optional source restriction. A fabricated reference or an agent explanation does not waive coverage. Whole-work waiver uses the existing explicit operator confirmation, retains its authorization, enumerates mandatory checks/unresolved reports and completes as `waived`, with no normal pass certificate. There is no new automatic per-check waiver.

Ordinary product edits do not stale the semantic contract. Changed authoritative plan/rules/checklist/skills/policy inputs require an immutable successor and renewed delivery. All predecessor evidence remains retained; the initial reconciliation policy reruns checks rather than silently carrying old evidence. A relevant change during an active/uncertain/finalized QA boundary stops normal amendment and requires explicit recovery/reopen. Material scope changes still require the existing new admission/approval path.

Amendment reconciliation tracks the authoritative input digest and predecessor, including provenance-only changes with an identical requirement inventory. Resuming the same amendment retains its progress; a further input change or reversion replaces obsolete drafts without resetting the original budget, consumed rounds or depth. Outstanding unknown dispatches prevent that reset and preserve all retained progress for explicit reconciliation.

Exact QA-only recovery routes directly into the retained review boundary. It does not run preparation or Builder preflight/proposal/implementation. Valid contract authority can support fresh final review. Stale or missing contract authority fails explicitly before review dispatch. Unknown provider or Builder evidence turns remain uncertain rather than replaying. Deliberate operator recovery is required; this release does not invent a safe automatic reconciliation of unknown external outcomes.

## Validation and acceptance scenarios

Provider tests inject SDK/RPC events into the actual adapters. They assert pre-execution rejection and effective options rather than trusting a mock's read-only label. Workflow tests use real SQLite stores, admissions, gates, source capture, snapshots and reducers with controlled provider responses. They do not prove model quality or replace live provider acceptance testing.

| Scenario | Implemented evidence |
|---|---|
| S1 Ordinary ticket | `qaPrebuildCallers.test.ts` exercises actual Foreman preparation → independent assessment → actual-session acceptance → implementation → structured claims. `qaPreparationIntegration.test.ts` exercises actual isolated final review, certificate authority and stale consumption. These are complementary fixtures, not a claimed single live-provider run. |
| S2 Critical interacting risk | `qaPreparation.test.ts` exercises discovered architecture risk, planner-owned escalation, a fresh Exceptional challenge and retained logical budget. Contract tests reject insufficient levels, missing challenge and same-author challenge. |
| S3 Resumed branch | Actual branch runner exercises shared preparation/delivery/evidence with final QA disabled. Delivery/integration tests reject old workspace/session/compaction receipts; existing branch, continuity and finalization suites exercise resume and publication. |
| S4 Synthetic work | Real WorkflowDb synthetic admission, distinct identity, delivery, assignment and source-bound claims are exercised in `qaPreparationIntegration.test.ts`; existing synthetic admission/finalization suites retain their authority checks. |
| S5 Unavailable environment | Candidate tests distinguish start-time blocking from a postimplementation expected transition. Coverage tests reject blocked/not-run mandatory checks and unresolved predicates. Existing prerequisite suites retain host/runtime capability checks. |
| S6 Amendment | Actual Foreman caller repeats the full gate after canonical rule clarification and publishes revision 2 with predecessor and renewed acceptance. Freshness tests retain revision 1 immutably; certificate integration rejects stale consumption. |
| S7 Exact QA-only recovery | Actual Foreman QA-only API tests valid, stale, missing and changed-scope enforcing contracts and assert zero Builder calls/reserved preparation turns. Existing ordinary/branch recovery/finalization suites exercise legacy and interrupted publication. |

The end-to-end acceptance evidence is composed from real caller/service fixtures and existing recovery suites. All seven scenarios were not executed as a single combined live-provider matrix in both execution modes. Codex enforcement is intentionally withheld, and external quality/cost rollout evidence remains outstanding.

## Requirement traceability

| Requirement | Implementation and evidence |
|---|---|
| R01 | Prepared expectations and honest success/quality measurements; metrics tests. Actual effectiveness awaits matched rollout data. |
| R02 | Immutable store, shared delivery/review binding; store/delivery/integration tests. |
| R03 | Structured plan materialization, policy snapshot and ticket metadata; structuredPlan/population tests. |
| R04 | Five cumulative obligation sets and fresh Level 5 challenge; contract/preparation tests. |
| R05 | Exhaustive authoritative coverage at every level; contract tests. |
| R06 | Host minimums, rationale and planner-owned escalation; policy/preparation tests. |
| R07 | Durable round/time budgets and confined phases; store/preparation/provider tests. |
| R08 | Full ticket/exact plan/canonical rules/checklist/skills; caller/config/review tests. |
| R09 | Shared full context and actual-session delivery; ordinary/branch caller tests. |
| R10 | Immutable synthetic admission and guarded nonstandard callers; integration/admission tests. |
| R11 | Dedicated confined phase and QA-only bypass of normal preparation; provider/recovery tests. |
| R12 | Shared orchestrator used by Foreman and branch runner; actual caller tests. |
| R13 | Explicit ignored compiled bundle delivery; actual snapshot reviewer integration. |
| R14 | Canonical metadata/digest comparison and freshness; effective-config/review tests. |
| R15 | Full context and accurate independent-review wording; caller/reviewer tests. |
| R16 | Strict schemas, separate applicability/obligation/timing and meaning-based IDs; contract/freshness tests. |
| R17 | Concrete methods/outcomes/evidence plus semantic assessment; contract/preparation tests. |
| R18 | Proposed scope cannot become mandatory; persisted disposition/cause authority; contract/authority tests. |
| R19 | Structural and independent semantic validation both required; preparation tests. |
| R20 | Source-bound baseline and timing/capability distinction; contract/prerequisite tests. |
| R21 | Mandatory unavailable verification cannot pass; coverage/waiver tests. |
| R22 | Same-session acceptance, bounded complete transport and compaction renewal; delivery/provider tests. |
| R23 | Structured source-bound Builder claims; actual caller/integration tests. |
| R24 | Fresh source-bound independent QA; snapshot/runtime/integration tests. |
| R25 | Full coverage bound atomically to receipt/certificate; integration/protocol tests. |
| R26 | Existing blocking findings retained; evidence-supported causal assessment, unknown default; finding/metrics tests. |
| R27 | Shared remediation/Manager gate and existing durable history; failure/guidance suites. |
| R28 | CAS/lease fences, reserve-before-send, retained progress and existing recovery; store/recovery/migration suites. |
| R29 | Precise input freshness, immutable successors, renewed acceptance and stale-pass rejection; actual amendment/freshness tests. |
| R30 | Explicit incomplete/uncertain/stale/unsupported diagnostics and bounded repairs; preparation/provider tests. |
| R31 | Read-only boundaries, excluded artifacts, deadline and segmented transport; provider/delivery tests. |
| R32 | Stable identity/denominators, causal evidence, quality windows and unknown usage; metrics tests. Rollout sampling must supply real observations. |
| R33 | Frozen legacy/shadow/enforce policy and intentional old-run compatibility; configuration/store/caller tests. |
| R34 | New domain/provider/workflow tests plus affected existing suites; validation record below. |
| R35 | Existing admissions, leases, operation journal, decisions, reducers and finalization used; caller/migration suites. |
| R36 | This handoff records implementation, concrete evidence and remaining provider/evaluation gates. |

## Regression matrix and audit closure

| Plan tests | Concrete suites |
|---|---|
| T01–T02 | `qaPrebuildCallers`, `qaPreparationIntegration`, existing Foreman/branch/runtime/snapshot/session preparation |
| T03–T05, T23 | `structuredPlan`, `ticketPopulation`, `qaVerificationContract`, `qaPreparation`, `qaPreparationInputs`, existing planning/alignment |
| T06–T09 | `qaVerificationContract`, `qaContractCoverage`, `qaAuthorizedDisposition`, existing prerequisites/protocol |
| T10–T12 | `qaContractDelivery`, `qaPreparationStore`, `qaPreparation`, `qaPreparationIntegration`, existing assignment/admission/lease/recovery |
| T13–T17 | `qaContractFreshness`, `qaPreparationIntegration`, `qaContractCoverage`, existing snapshot/session/failure/guidance/protocol |
| T18–T19 | `qaPreparationIntegration` valid/stale/missing QA-only cases, `qaPrebuildCallers` old-run mode; existing QA recovery, branch finalization and migration |
| T20–T22 | `qaPreparationMetrics`, `qaContractDelivery`, `qaProviderBoundary`, actual caller/integration fixtures and S1–S7 evidence above |
| T24–T25 | `qaProviderBoundary` actual Claude SDK hooks and Codex RPC options; `qaContractDelivery` renewal and missing section rejection |
| T26–T28 | Contract non-circular digests; actual reviewer/basis/certificate integration; real scoped authority and whole-work waiver tests |
| T29–T30 | Store downtime/reservations/escalation; real authorized extension; schema/project normalization; actual QA-disabled enforcing/legacy/shadow callers; frozen/old-run policy |
| T31 | Persisted causal-assessment validation, unknown classifications, linked correction/recheck counting, observation windows and sample representation |

The nine audited gaps are addressed in production boundaries: write-enabled startup/planning (phase policy); native compaction (Claude barrier, Codex unsupported); digest/publication ordering (separate domains and immutable basis); lost planner metadata (explicit materialization); checklist reload mismatch (one frozen canonical checklist); fabricated disposition authority (real answered decisions); reset budgets (logical durable identity); undefined configuration (shared resolver/frozen policy); unsupported omission attribution (retained evidence and unknown causes).

## Measurement and release limits

The event ledger records approved work, implementation start, preparation failure, substantive reviews, format repair, provider retry, completed remediation, amendments and completion/waiver/cancellation. Stable IDs deduplicate replay. Amendments do not reset first-review history. Legacy/shadow generic passes cannot inflate contract-aware rates; equivalent review data must be explicitly supplied. Approved-never-started and preparation failure remain visible beside comparable started work.

Initial finding causes remain unknown. `findingAssessment` accepts retained input/Builder/scope evidence and verifies contract/check scope and independent authorship. Preparation omission additionally requires supported knowability/actionability; a newly discovered outside-contract finding is not automatically an omission. Omission remediation requires a linked completed correction followed by substantive recheck. Report repairs and provider retries remain separate.

Costs are known observations or explicit unknown samples, never fabricated zeroes. Completed work without sufficiently late, fully linked observations is unknown at 7/30 days. Usefulness samples validate the scoped contract, independent assessor, known checks, retained input evidence and terminal contract-bound review. Reports retain depth/cohort, costs, investigation duration and specific observations. The storage APIs support evidence capture; they do not claim a running external defect tracker, automatic independent adjudication, or scheduled quality followup.

No matched baseline, 50 completed independently reviewed enforcing work items, 20-contract sample, or measured 20% relative omission-remediation reduction exists from these local tests. Those plan evaluation gates remain release evidence to gather. Cross-provider/model/runtime/risk comparisons must be stratified using real retained observations, not inferred from the default policy/level cohort label. A zero/missing/mismatched baseline yields undefined relative reduction. No performance or defect-reduction claim is made.

## Validation record

Validation uses Node 20.19.0, matching the existing native SQLite installation. Controlled provider tests make no live model calls.

| Validation | Result |
|---|---|
| Original implementation: full sequential workspace test run (`pnpm -r --workspace-concurrency=1 test`) | 1,406 passed, 14 skipped, zero failures: runtime 998/12 skipped; CLI 268/2 skipped; agent library 48; spec 92; predates the four reproduced review findings |
| New preparation/contract/provider/caller/measurement suites | 48 passed, zero skipped/failures |
| Latest adjacent metrics/remediation/continuity suites | 41 passed, zero failures |
| Final active-session delivery, review and caller checks | 19 passed, zero failures; includes native-session ID/role rejection |
| Workspace build | All four packages passed |
| Workspace typecheck | All four packages passed |
| Generated CLI documentation check | Passed |
| Git whitespace check | Passed |
| Post-review fixes: preparation/contract/provider/caller suites plus recovering adapter | 58 passed, zero skipped/failures; covers renewed adapter acceptance, compaction, provenance-only amendments, final baseline evidence and bounded final-review resources |
| Post-review fixes: final direct-assignment and provider-context checks | 5 passed, 9 excluded by name filter; includes current-source Builder claims and provider-only preimplementation coverage |
| Post-review fixes: assignment, QA failure delivery, QA protocol and recovery suites | 60 passed, zero skipped/failures |
| Post-review fixes: workspace build/typecheck, CLI documentation and whitespace | All passed |

The full workspace run covered the broad existing regression surface. Later audit changes were verified with the focused feature and affected caller/domain suites, followed by a fresh build/typecheck/documentation check. These counts overlap and must not be summed as distinct tests. An intermediate typecheck saw a concurrently edited Graphify source field absent from the previously generated spec declaration; rebuilding the workspace resolved it while preserving that agent's changes.

Graph artifacts were left unchanged while another agent was editing the Graphify integration. The shared workflow reserves graph writing for one coordinator after concurrent edits settle; deferred files remain unstamped for that update.
