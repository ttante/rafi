# QA preparation before Builder execution: implementation plan

This is the execution handoff for the Builder agent implementing [qa-prebuild-requirements.md](qa-prebuild-requirements.md). That document remains the requirements authority. This plan maps all 36 requirements to implementation tasks and behavioral verification. Implement the entire workflow, including the confirmed bugs, migration, recovery, and quality measurement; a prompt-only checklist feature is insufficient.

The intended result is a persisted verification contract delivered before implementation, with investigation depth chosen by the project planner. Every depth exposes the complete applicable requirements. Independent final QA evaluates the actual implementation against the delivered contract and current source state.

## 1. Execution rules and verified starting points

Read repository instructions and inspect the current worktree before editing. Preserve unrelated changes. Recheck the functions below before implementing: this plan describes the inspected code, and line numbers will change. Follow the repository's selective Graphify policy when applicable. Do not publish, merge, deploy, or invoke live providers merely to complete local implementation tests.

Current foundations and gaps:

| Area | Verified code locations | Implementation consequence |
|---|---|---|
| Ordinary builds | `packages/ai-foreman/src/foreman.ts`: `runPreflight`, `runBatch`, `doTurnWith`, `runQa`; `src/cli/start.ts`: build setup and approval | Builder preflight is Builder-authored planning. Ordinary step instructions are abbreviated. Add preparation for each admitted work item and a common implementation gate. |
| Branch builds | `packages/ai-foreman/src/branch/runner.ts`: initial/resume instruction helpers, `runInstruction`, independent QA call | Initial instructions omit some ticket context and the project checklist; resume omits acceptance and tests. Both contain incorrect same-Builder-session QA language. |
| Authoritative work | `buildWorkAuthorization.ts`, `buildWorkAdmission.ts`, `buildAssignment.ts`, `buildSyntheticWork.ts`, `buildApproval.ts` | Work is frozen and admission is source-bound. Preserve these protections; add contract bindings to assignments rather than replacing work authority. |
| Final QA | `qaReview.ts`: `oneReview`, `buildQaReviewHandoff`, recovery/finalization; `qaProtocolV2.ts`; `qaSnapshot.ts` | Existing review already freezes source, uses disposable snapshots and fresh provider conversations, and gates completion on certificates or authorized waivers. Extend these protections. |
| Configuration bug | `roles.ts`: `loadRoleBundle`; `cli/start.ts`: `resolveQaRuntimeMetadata`, `createQaForSettings`; `qaRuntime.ts`; `qaSnapshot.ts` | Resolving the compiled project QA bundle from the disposable snapshot loses ignored `.rafi/compiled/qa` and can use the library fallback. Resolve effective configuration from the authoritative project context, then explicitly deliver it. |
| Prerequisites | `qaPrerequisites.ts`: `checkQaPrerequisites` | Existing bounded probes run during post-build QA, distinguish source defects, and explicitly say host availability does not prove provider access. Reuse early with structured timing and runtime authority. |
| Planner and population | `packages/rafi/src/{plan,structuredPlan}.ts`; `packages/spec/src/types.ts`: `StructuredPlanSlice`; `packages/ai-foreman/src/ticketPopulation.ts`, `ticketPlanning.ts`, `cli/tickets.ts` | Planner slices and ticket population must preserve the planner's depth decision. Ticket-maker must not invent or silently change it. |
| Ticket/config persistence | `tickets/ticketSchema.ts`, `ticketLoader.ts`, `renderMarkdown.ts`, `stateDb.ts`, `setupConfig.ts`; `workflowDb.ts` | Extend validation, snapshots, publication, display, and recovery consistently. Generated Markdown is a projection, not authoritative input. |
| Remediation/guidance | `qaFailureDelivery.ts`, `buildInterventions.ts`, `qaRecovery.ts`, continuity/session/handoff modules | Attach check identities and revisions to existing durable handoffs. Retain independent Manager-guidance verification. |
| Shared types/providers | `packages/spec/src/{types,schemas,validate,index,qaFailureReport}.ts`; `packages/special-agents/content/agents/{planner,ticket-maker,builder,qa}.yaml`; adapters | Update shared protocols and phase instructions without adding a new user-configurable role unnecessarily. |
| Command integration | `packages/rafi/src/index.ts` imports the `ai-foreman` start command | Keep command wiring consistent and regenerate CLI docs if public options change. |

The earlier investigation reproduced project QA bundle loss. It did not establish a full green repository test baseline or measure improved build success. SQLite native-module/runtime compatibility affected the earlier test run; verify the current runtime and record the actual results rather than reusing those results as a baseline.

## 2. Architectural and policy decisions

### 2.1 Shared services and authority

Implement reusable services in `packages/ai-foreman/src`, with public data shapes in `rafi-spec`. Proposed filenames are new modules, not claims that those files already exist:

| Proposed module | Responsibility |
|---|---|
| `qaEffectiveConfig.ts` | Resolve effective project QA/Builder rules, checklist, skills, and provenance; deliver allowlisted immutable configuration to confined sessions. |
| `qaPreparationPolicy.ts` | Versioned depth obligations, risk minimums, planning requests, budgets, and escalation validation. |
| `qaVerificationContract.ts` | Canonical contract representation, input inventory, structured validation, digests, rendering, semantic-review result validation. |
| `qaPreparationStore.ts` | Schema migrations and transactional helpers using the existing workflow database, evidence storage, and leases. |
| `qaPreparation.ts` | Shared preparation orchestration: collect, investigate, validate, escalate, challenge, publish. |
| `qaContractDelivery.ts` | Workspace materialization, session delivery/acceptance receipts, completion-version checks. |
| `qaContractCoverage.ts` | Builder evidence and final-review coverage parsing, applicability decisions, completion checks, finding classification. |
| `qaContractFreshness.ts` | Input comparison, targeted revalidation, revision amendments, evidence/review reconciliation. |

Use existing `WorkflowDb` operations, transactions, lease generations, and evidence blobs. Add narrowly scoped helpers rather than a second database or an unrelated authorization system. Public services should accept typed dependency interfaces for providers, clock, probes, and storage so behavior can be tested without live agents. Do not continue growing the already large CLI into the primary domain implementation.

Authority rules:

1. The frozen admitted work and applicable approved plan define authorized product scope. The contract cannot add scope or confer approval.
2. Effective project rules and the validation checklist govern how that scope is implemented and verified. Conflicts with approved requirements are explicit unresolved decisions; no agent silently chooses whichever source is convenient.
3. Planner decisions govern depth, subject to host-enforced minimums. The preparer recommends changes; the host validates and records planner decisions.
4. Existing invariants and derived checks must cite inspected sources and explain their relationship to approved work. They may expose genuine defects without introducing a new product preference.
5. Suggestions, inferred risks, new product requirements, and implementation proposals carry explicit categories. Proposed new scope uses existing approval mechanisms. Routine clarifications within authorization do not create a new user-confirmation gate.
6. Only the existing authorized decision/waiver mechanisms can dispose of mandatory obligations. Neither a preparer's explanation nor a reviewer's generic success verdict supplies that authority.

### 2.2 Keep five levels

Use five levels for the initial release because they have distinct investigation outputs and dispatch conditions. Four levels would merge architectural uncertainty and independent challenge into Critical, either imposing that cost on every critical ticket or making the challenge conditional and less visible. Revisit this taxonomy using measured usefulness, preserving all obligations if levels are consolidated.

All levels first inventory every acceptance criterion, required test, applicable project rule/checklist item, and relevant invariant. Depth changes investigation, never disclosure or mandatory coverage.

| Level | Mandatory preparation output beyond the complete baseline | Ready condition |
|---|---|---|
| 1 Focused | Concrete behavior/check/evidence mapping, applicable commands or procedures, prerequisites, scope boundaries | Actionable baseline; explicit low-risk planner rationale; no unassessed consequential risk |
| 2 Standard | Relevant implementation/test inspection, source references, important edge cases, ordered verification sequence | Level 1 plus inspected evidence showing checks fit the affected behavior |
| 3 Extensive | Cross-component/dependency map, negative/failure cases, state transitions, regression and compatibility analysis | Level 2 plus checks addressing affected interactions and failure boundaries |
| 4 Critical | Explicit security/data/state invariants, adversarial cases, concurrency/retry failure analysis where applicable, rollback/recovery verification | Level 3 plus each consequential boundary has an observable invariant and practical verification or authorized disposition |
| 5 Exceptional | Bounded approach proposal and independent challenge; resolved material uncertainty; coordinated verification across components | Level 4 plus a challenge receipt from a fresh assessor session and no unresolved material challenge concern |

Standard is the ordinary starting policy. Focused requires the planner to affirm low risk, narrow affected behavior, understood dependencies, and adequate verification. Size alone does not determine depth. Missing risk data triggers planner assessment; it never defaults to Focused. The existing synthetic ticket's `risk: Low` placeholder is insufficient evidence of actual low risk.

Initial host minimums, applied to evidenced risk categories:

| Risk category | Minimum |
|---|---|
| Material interaction across components, compatibility contracts, persisted state transitions, or uncertain external dependencies | Extensive |
| Changed authorization/permissions, security boundary, data migration/integrity, consequential concurrency/retries, deployment or recovery behavior | Critical |
| Broad architecture or interacting critical boundaries with unresolved material uncertainty | Exceptional |

Apply categories to changed behavior, not merely a filename or the word "security" in a ticket. Planner and preparer supply cited risk evidence; deterministic host logic applies the declared categories and rejects decisions below their minimum. Lightweight deterministic signals can require risk assessment, but must not be advertised as complete semantic risk discovery. False-positive signals are resolved with evidence; recorded minimum overrides must follow a defined policy and cannot be arbitrary agent flags.

Store selection history: initial decision, requested escalation, planner revision, rejected downgrade, policy version, evidence, and minimum. If an escalation stays within approved scope, automatically ask the configured project planner for a revised decision and continue when valid. Planner failure yields `planner-unavailable` or `depth-decision-incomplete`, with retained evidence and a retry action. Cost, failed providers, or exhausted preparation budgets cannot justify a downgrade.

### 2.3 Bounded preparation policy

Start with these tunable limits, frozen per run under a versioned policy. They are safety limits, not claims about the time sufficient for all work:

| Level | Preparation wall-time ceiling | Investigation passes | Approach/challenge |
|---|---|---|---|
| Focused | 5 minutes | Initial pass plus one targeted follow-up | Only for a concrete unresolved approach concern |
| Standard | 10 minutes | Initial pass plus one targeted follow-up | Same |
| Extensive | 20 minutes | Initial pass plus two targeted follow-ups | Scoped approach review when interaction uncertainty warrants it |
| Critical | 30 minutes | Initial pass plus two targeted follow-ups | Scoped approach review when critical uncertainty warrants it |
| Exceptional | 45 minutes including challenge | Initial pass plus two targeted follow-ups | Required proposal, fresh independent challenge, at most one revised proposal/challenge round |

Allow at most two output-format repairs per provider result and two planner escalation revisions per logical preparation. After escalation, recompute the authorized ceiling for the new level, subtracting elapsed time; do not reset time indefinitely. Freeze provider deadlines and any configured token/cost ceiling; an unsupported provider cost counter remains unknown, not zero. Configured limits may be increased by existing authorized operational policy without reducing obligations. Exceeding limits returns an incomplete result with unfinished checks and the required next action.

Persist limits against a **logical preparation** identity independent of provider attempt, worker lease, operation generation, or process restart. Store policy version, initial start time, authorized ceiling, absolute deadline, investigation passes used, output repairs used per result, escalation revisions used, challenge rounds used, known token/cost consumption, and extension history. Attempts reference that record; acquiring a new generation or changing an idempotency key never allocates a fresh budget. Reserve a bounded round before provider dispatch and reconcile its retained result on recovery; ambiguous dispatch keeps the reservation and remains uncertain until resolved.

For the initial release, wall-time includes downtime: the persisted absolute deadline does not move on restart. A valid escalation raises the ceiling for the new level measured from the same logical start; it does not restart the clock. An authorized operational extension must be a persisted decision with actor/authority, reason, new deadline/caps, and predecessor; a retry flag is not an extension. Completed checks and partial evidence survive exhaustion. Resuming exhausted work returns incomplete unless an authorized extension exists. Test deadline expiry during downtime, crashes before/after reservations and dispatch, concurrent retries, two exhausted escalation revisions, and unknown usage without resetting counters.

Use a fresh QA-role preparation session with explicit phase instructions. Semantic assessment at Levels 1–4 uses a separate bounded assessment turn/session that receives the draft and original input inventory and reports specific gaps/conflicts. At Level 5, the mandatory challenge uses a fresh independent assessor conversation that did not author the draft or approach. It may also perform semantic assessment, but must produce separate conclusions for contract quality and approach risks. Independent means separate authorship/conversation and evidence; it does not require another model vendor. Do not claim this removes all correlated model errors.

The approach is planning only: no product writes, dependency installation, or implementation. An optional Builder-authored approach must run under a planning-only permission boundary, not the normal write-enabled Builder adapter. If the provider cannot enforce that boundary, the planner supplies the proposal. A documented equivalent challenge is accepted only through the same typed challenge receipt, fresh independent authorship, required concern categories, and material-resolution rules.

## 3. Contract, evidence, and persistence design

### 3.1 Planner depth fields

Add a shared `QaPreparationDepthDecisionV1` type containing level `1 | 2 | 3 | 4 | 5`, rationale, assessed risk factors with references, policy version, planner operation/identity, timestamp, minimum level and its reasons, and predecessor decision identity when revised.

Add optional `qa_preparation` to `StructuredPlanSlice` and `TicketDef` for legacy parsing. Newly generated plans in enforcing mode require a validated selection for every slice. Ticket population takes that approved selection from the matched slice; a different ticket-maker selection is rejected. Preserve it through retained slices, plan revision, ticket proposals/imports, materialization, definition snapshots, and display. Materialization must explicitly overwrite or clear stale retained depth data when the plan changes; spreading the old ticket must not accidentally retain an obsolete selection.

Existing/imported work without a usable decision goes through a dedicated read-only planner assessment. Record the decision as an authoritative work-planning record before first implementation. If the assessment does not change product requirements, it can be attached to the admitted frozen definition by reference; do not mutate the definition behind its approval digest. Runtime depth revisions use this linked history. If a decision changes approved scope, use ordinary plan revision, renewed approval/admission, and contract amendment.

The planner implementation must change the explicit proposal-to-plan pipeline in `packages/rafi/src/structuredPlan.ts`, not just a shared type or prompt. Extend `PlanSliceProposal`, `validateStructuredPlanProposal`, and `materializeStructuredPlan`; the materializer explicitly copies fields and otherwise drops a new `qa_preparation` field. Extend `validateMaterializedPlan`, `structuredPlanDigest`, and planner render/publication outputs so a depth decision survives validation, hashing, approval, and display. Inspect every explicit slice/ticket reconstruction for the same loss. Define separately the digest of an approved slice's initial decision and the linked runtime decision history; adding a linked escalation must not silently rewrite an already approved plan digest.

Test an actual planner proposal through validation, materialization, approval/publication, ticket population, frozen definition snapshot, and display. Repeat with a revised plan containing retained, changed, and removed slices. Assert the matched planner decision is retained or deliberately superseded/cleared, and cannot be replaced by ticket-maker output. Add `packages/rafi/test/structuredPlan.test.ts` explicitly to the affected test set.

### 3.2 Schema

Implement shared strict schemas and parsers, with size limits and bounded repair. The following is the minimum shape; use repository naming conventions when implementing:

```ts
type Obligation = "mandatory" | "advisory";
type ApplicabilityState = "applicable" | "not-applicable" | "unresolved";
type CheckTiming = "preimplementation" | "postimplementation" | "both";
type CheckOutcome = "passed" | "failed" | "not-run" | "blocked" | "not-applicable";

interface VerificationContractV1 {
  schemaVersion: 1;
  contractId: string;
  revision: number;
  contentDigest: string;
  predecessorDigest?: string;
  runId: string;
  workId: string;
  workKind: "ticket" | "synthetic";
  admissionId: string;
  requirementsDigest: string;
  depthDecisionId: string;
  depthPolicyVersion: string;
  inputs: ContractInputRef[];
  baseline: BaselineObservationRef[];
  requirements: RequirementRef[];
  checks: VerificationCheckV1[];
  coverage: RequirementCoverageRef[];
  preparationEvidence: PreparationEvidenceRef[];
  draftPayloadDigest: string;
  semanticAssessmentDigest: string;
  challengeReceiptDigest?: string;
  unresolved: UnresolvedConcern[];
  createdAt: string;
}

interface VerificationCheckV1 {
  id: string;
  requirementRefs: string[];
  origin: "explicit" | "derived" | "invariant" | "proposed" | "advisory";
  expectedBehavior: string;
  obligation: Obligation;
  timing: CheckTiming;
  applicability: {
    kind: "unconditional" | "conditional";
    predicate?: string;
    decisionOwner: "host" | "qa";
    requiredEvidence: string[];
  };
  verification: VerificationMethod[];
  expectedEvidence: string[];
  prerequisiteRefs: string[];
  dependsOnChecks: string[];
  expectedBaseline?: string;
  dispositionRef?: string;
}
```

Define the referenced types, not only the outer interface:

- `ContractInputRef`: source kind, stable reference, exact digest, authority category, resolved revision, and availability. Capture full admitted ticket, approved plan/slice, scoped decisions, project checklist, effective rule/skill contents, depth policy, and relevant inspected baseline references.
- `RequirementRef`: stable ID, source reference and locator, exact statement/digest, mandatory/advisory status, origin category, approved/invariant/proposed status, and any conflict. Host builds the initial authoritative inventory, including every acceptance/test entry and checklist item. Semantic preparation decomposes free-form role rules and context into additional cited requirements; deterministic code cannot prove that decomposition complete.
- `RequirementCoverageRef`: requirement ID, check IDs, or authorized disposition reference. An unresolved explanation is a diagnostic, not coverage satisfying readiness.
- `VerificationMethod`: command/procedure type, argv or explicit manual steps, actual workspace-relative cwd, fixtures, expected outcome, applicable runtime, timeout/resource limit, equivalent-method authority if applicable. Do not execute generated shell strings automatically.
- `BaselineObservationRef`: source digest, phase/runtime identity, command or probe, time, observed status, output evidence digest, relevance to requested behavior, and expected transition. Baseline failures are observations, not waivers.
- `PreparationEvidenceRef`: obligation category, inspected file/test locations and digests, analysis result, provider operation/session, and retained evidence reference. Include cross-component analysis/invariants/challenge obligations at the selected level.
- `UnresolvedConcern`: typed reason, affected requirement/check IDs, materiality, owner, and concrete next action. Material unresolved concerns prevent readiness; advisory observations remain advisory.
- `AuthorizedDisposition`: authority record, exact affected checks/requirements, reason, scope, source/version conditions, validity/expiry where relevant, and disposition type. A QA waiver produces an explicitly waived completion, not a passed check.

Keep mutable lifecycle, delivery receipts, applicability observations, and review outcomes outside the immutable content digest. Reference them to a specific contract revision. Otherwise accepting delivery would change the artifact just delivered. Compute the contract digest using existing canonical JSON/digest conventions, excluding the digest field itself. A human-readable rendering has its own derived digest and cannot override structured data.

Stable identities are host-managed. Initial source requirement IDs may use source kind, locator, and content fingerprint. Persist identity mappings across reorderings and equivalent revisions. Changed meaning requires a new check ID or explicit successor relationship; never reuse an ID to mean something different. Removing or superseding a check retains history and authority. Agents may propose identities; host validation allocates/accepts only valid mappings.

### 3.2.1 Non-circular digest and assessment publication

Define and test a versioned canonicalization specification for each artifact. Do not make an assessment attest to a final digest that includes that assessment's own digest. First freeze a candidate payload containing the proposed requirements/checks, authoritative inputs, baseline, depth decision, and preparation evidence, excluding `contentDigest`, `draftPayloadDigest`, `semanticAssessmentDigest`, and `challengeReceiptDigest`. Compute a domain-separated `draftPayloadDigest`. The semantic assessor and any challenge receipt bind that exact draft, inventory, applicable policy, and their own operation/session identities. Store their immutable results and compute their result digests. Assemble the final contract referencing the draft and assessment/challenge result digests, then compute `contentDigest` excluding only its own digest field.

An assessor-proposed change creates a new candidate payload and requires assessment of the changed draft; do not attach an old successful receipt to newly edited checks. Validate that each receipt's assessed draft matches the payload reconstructed from the final contract and that all required independent assessment conclusions are resolved. Mutable publication status, delivery, applicability observations, and final results stay outside these digests. Test canonical field order, semantic change sensitivity, rejected stale assessments, and reconstruction of the exact assessed payload from persisted blobs.

### 3.3 Store and lifecycle

Add versioned workflow-database migrations for these logical records, with foreign keys and unique indexes. Physical table names may follow current conventions:

| Record | Key and purpose |
|---|---|
| Depth decisions | Decision ID; work/admission/policy linkage; immutable planner history |
| Logical preparation budgets | Stable logical preparation ID; frozen limits/deadline, consumed/reserved rounds and usage, authorized extensions; never reset by attempt/generation |
| Preparation attempts | Operation ID; logical preparation budget reference; input fingerprint; depth decision; owner lease generation; status, dispatch receipt, error, and evidence |
| Contracts | Work/admission/contract ID/revision; immutable content blob/digest; predecessor and readiness assessment |
| Contract head | Work/admission; current revision and compare-and-swap lifecycle generation |
| Requirement/check identity history | Contract family/source identity; successor/retirement links |
| Delivery receipts | Run/work/revision/session/workspace/assignment operation; artifact access and acceptance evidence |
| Applicability/evidence | Contract/check/source/runtime; phase, predicate decision, Builder claims and QA observations |
| Amendment reconciliation | Old/new revision; authority; changed checks/inputs; delivery/evidence/review effects |
| Telemetry events | Stable operation/event identity; versioned classification and outcome data |

Use evidence blobs for large content and content-addressed projections for JSON/Markdown. The database and verified blobs are authoritative. Use a dedicated excluded control-artifact location under the workflow root; materialize only the needed readable files in Builder/snapshot workspaces. Register its exclusion with current source-capture/snapshot machinery and test that writing a receipt or projection does not change product-source identity. Never commit generated contracts by default or copy all of `.rafi`.

State transitions:

```text
preparation-required -> preparing -> validating -> ready -> delivering
                                                    -> implementing -> reviewing
                                                                      -> completed
                                                                      -> remediation-required
                                                                      -> waived-completion
preparing/validating -> incomplete | blocked | uncertain
ready/delivering/implementing/reviewing -> amendment-required -> reconciling
```

These are preparation/contract substates linked to existing run and QA states, not replacements for the QA reducer. `completed` and `waived-completion` remain subordinate to existing finalization, current-source, controls, and certificate/waiver checks. Keep explicit states for exact QA recovery and interrupted finalization in the existing recovery system.

Publish atomically: retain candidate/evidence blobs, validate, compare current inputs/lease/head revision, then commit the immutable revision and ready head in one transaction. Publish projections afterward with atomic file replacement; recover missing projections from verified blobs. A crash after candidate persistence does not imply ready. A crash after ready publication does not require provider regeneration when inputs remain valid.

Idempotency key includes run, work/admission, input fingerprint, authoritative depth decision, and operation generation. Never hold a SQLite transaction across an awaited provider call. Persist intent before dispatch and result before interpretation. An unknown provider dispatch is `uncertain`; investigate retained receipts before retrying. Owner generation and compare-and-swap prevent stale workers publishing or launching a second Builder. Reuse existing lease/conflict recovery rather than silently stealing ownership.

## 4. Normal execution and recovery boundaries

### 4.1 Per-work sequence

1. Classify invocation as normal implementation, remediation/guidance, exact QA-only recovery, or interrupted finalization before any preparation or Builder preflight can run.
2. Resolve selected work and complete authoritative inputs. Planner selects depth during planning/population; missing decisions invoke the read-only planning fallback.
3. Preserve existing plan approval and work admission. Read-only planning may occur earlier under current authorization, but preparation cannot authorize implementation. If the existing batch Builder preflight occurs before approval, keep it planning-only and treat its approach as context rather than the QA contract.
4. For each actual admitted work item, collect effective QA configuration and the complete input inventory. Prepare against the actual intended worktree/baseline, after dependencies needed to inspect that work have landed.
5. Run bounded prerequisites and investigation at the selected level. Route discovered risk to the planner, enforce minimums, and perform any required challenge.
6. Validate deterministic coverage and semantic assessment. Publish a ready immutable contract or an explicit failure/incomplete state.
7. Construct the actual implementation session under existing session/continuity rules. Materialize and deliver the contract after any compaction, replacement, or workspace switch. Validate acceptance against that session and workspace.
8. Atomically bind admitted assignment, current ready contract, valid delivery receipt, and owner generation; then dispatch implementation. Check the binding again at remediation/guidance turns and relevant boundaries.
9. Parse Builder completion evidence, reject stale/missing revisions, capture source, and request independent final QA with the same contract and effective rules.
10. Freeze current implementation source, create a fresh final QA conversation for its snapshot, independently resolve applicability and verify all mandatory checks. Persist structured coverage before issuing a certificate or recording a waiver.
11. Complete only through existing source-freshness and finalization protections. Failed reviews use existing remediation delivery enriched with check identities and revision bindings.

Do not precompute an entire batch against the original source when earlier tickets can change later assumptions. Reuse stable inventory/policy/config inputs but validate each work item's relevant baseline and dependencies when it reaches preparation.

### 4.2 Mandatory dispatch guard

Add enforcement to `beginBuildAssignment` or a shared pre-assignment service called by all implementation callers. Prompt helpers alone cannot enforce readiness. Inventory `Foreman.runBatch`, `runInstruction`, branch calls, synthetic work, decision continuations, `qaFailureDelivery`, and Manager Builder-followup paths. Audit direct adapter dispatches for implementation outside these functions and either route them through the shared guard or explicitly identify their non-build purpose.

The guard checks frozen feature mode, admitted identity/requirements digest, current ready revision, planner minimum/obligations, readiness validation, actual provider session/workspace, delivery receipt, input freshness, and current lease. Remediation may reuse a valid contract; it still requires delivery and binding. A format-only response repair does not become an authorized implementation dispatch. Planning/preparation commands use explicit phase types and confined adapters so they cannot evade the gate by mislabeling a write-enabled operation.

### 4.2.1 Existing planning and initialization dispatches

A contract guard on implementation assignments leaves several current direct provider calls uncovered. Explicitly convert and test:

| Current path | Required phase and boundary |
|---|---|
| `Foreman.runPreflight` | Planning-only adapter/turn; enforce confinement before any tools execute even when it runs before approval or contract readiness. |
| `Foreman.sendPreflightFeedback` | Same planning confinement on every feedback/revision turn, not just the initial preflight. |
| `cli/start.ts` branch dependency audit | Read-only audit factory/phase; current creation of a normal Builder followed by direct `sendTurn` cannot confer implementation permissions. |
| Optional Builder-authored approach | Explicit confined proposal phase; no normal write-enabled adapter reuse without a tested permission transition. |
| Codex `prepareNativeAutoCompaction` initialization and any analogous startup | Initialization-only turn with effective read-only/no-escalation policy or tools disabled before dispatch. A prompt saying no tools and an after-turn tool count do not enforce this. |

Inventory every `sendTurn`, `sendTurnInternal`, startup hook, feedback path, and wrapper forwarding call. Record phase, workspace, approval authority, effective sandbox/tool policy, readiness/delivery requirements, and recovery behavior. Phase must be host-selected; provider text cannot relabel an implementation turn as planning. Planning adapters must preserve needed context while withholding writes, installs, mutating shell commands, child-agent mutation, and permission escalation. Response-only protocol repair also needs an enforceable no-implementation boundary.

Provider tests must attempt mutation and prove denial **before execution**, with a sentinel product file unchanged because the tool was blocked. Verify preflight feedback, branch audit, initialization, and proposal independently. Detection followed by rollback or a terminal error is insufficient. If a supported provider cannot enforce a path safely, disable that path in enforcing mode with a diagnosed unsupported-capability state; do not silently allow a write-enabled planning turn.

### 4.3 Deterministic and semantic readiness

Host checks: strict schema, unique identities, resolvable source/check/disposition references, exact inventory coverage, legal obligation/timing/applicability combinations, no dependency cycles, policy minimums and required investigation receipts, current authoritative inputs, valid semantic assessment, no material unresolved concerns, and satisfied preimplementation requirements.

Semantic assessor checks: checks meaningfully cover requirements; behaviors and commands are practical; project rules have been disclosed; conditions are understandable; invariant/derived findings are justified; contradictions and accidental scope additions are identified; selected-depth analysis is useful. Persist per-concern conclusions and citations. A blanket "complete" response is invalid without assessed inventory/obligation coverage. Semantic assessment cannot waive omissions, and structurally valid data cannot overrule semantic unresolved concerns.

Conditional obligations need phase-aware treatment. For preparation readiness, every predicate must be evaluable and have an assigned evaluation point. Predicates dependent on the future implementation may remain unresolved with a recorded postimplementation owner/evidence requirement; they cannot block all implementation merely because the implementation does not exist. Predicates affecting a mandatory prerequisite must be resolved before dispatch. All mandatory applicability must be resolved before final completion.

### 4.4 Prerequisites, timing, and baseline

Extend the prerequisite service to accept structured declarations plus the legacy required-test parser. Unknown test strings remain requirements to interpret, not silently absent prerequisites. Use argv-based bounded probes and existing permissions; default probe timeout remains bounded and configurable. Distinguish host, preparation provider, Builder provider, and final reviewer access.

Policy for unavailable capability:

- Capability required to start approved implementation: readiness blocked until restored or an authorized equivalent/disposition exists.
- Capability required only for final verification: preparation may become ready for implementation if investigation/coverage is otherwise complete. Record `implementation-permitted-with-verification-dependency`, show it prominently to Builder/status, and retain completion as blocked until verified or explicitly waived. The planner can impose a stricter preimplementation gate for critical assumptions.
- Artifact/test/behavior this ticket must create or fix: record baseline absence/failure and expected transition. It is not automatically an environmental blocker.
- Missing capability that makes preparation unable to understand a material boundary: preparation incomplete even if the check would normally run only later.

Run a small set of relevant nonmutating baseline probes/tests when practical. Do not run every full suite for Focused work. Tests that write caches/output run in isolated scratch/snapshots under bounded permissions; verify product source did not change and do not expose production credentials. Existing failures still need final evaluation against approved scope. No broad grandfathering of failures.

### 4.5 Exact QA-only recovery and finalization

Keep the existing CLI early-return routing for `qaFinalizationTicket`, `qaResumedRecovery`, and `qaProtocolResumeTicket`. Branch `qaOnlyRecovery` must continue to skip Builder work. The contract feature must not call Builder preflight, generate an approach, dispatch implementation, or replay normal preparation from those paths.

For a valid bound contract, recover the exact revision, source/review basis, receipts, findings, and session/recovery history. Repair missing projections from authoritative blobs without changing the revision. Finalization may consume the original valid certificate only when all existing freshness and authority checks still pass.

For stale inputs or missing/corrupt bound artifacts, record `contract-recovery-decision-required` and preserve original authority/history. Do not substitute the latest contract file or fall through to a normal build. A deliberate recovery operation can reconcile an amended contract and start fresh independent QA with a new basis; it cannot retroactively claim prebuild delivery. If implementation is required, leave exact QA-only recovery and use the existing separately authorized remediation/continuation path.

For legacy records without a contract, preserve a marked `legacy-without-preparation` path under the frozen compatibility policy and existing QA protections. Do not manufacture receipts. If a policy upgrade requires contract-aware verification, use an explicit postimplementation verification amendment plus fresh review; this is not prebuild preparation. Interrupted legacy finalization can finish under its valid original certificate/policy. Invalid or ambiguous authority remains recoverable, never auto-approved.

## 5. Configuration, delivery, final QA, and amendments

### 5.1 Fix effective QA configuration delivery

Resolve effective role content from the canonical configuration root, with any deliberate worktree-specific rule overlay recorded explicitly. Keep provider cwd/snapshot separate from configuration origin. Freeze the loaded bundle source, instruction bytes, resolved relevant skill contents/references, checklist, config policy, and provenance once for the contract inputs.

Pass that configuration explicitly to preparation and review factories. Their actual adapter options and `QaRuntimeMetadata` must reference the same frozen bytes; do not re-resolve the bundle from a snapshot that omits `.rafi`. Existing library/fallback behavior remains allowed only when it is the intended effective source. Missing expected project content is a configuration error, not a silent fallback.

The role instructions differ by phase: common verification rules plus preparation-only or final-review-only instructions. Record the common requirements digest and each effective phase instruction digest. Phase wording can differ without invalidating the common contract; changed verification rules require revalidation. Resolve Builder rules separately and disclose every applicable QA-enforced obligation to Builder.

Only transfer allowlisted rule/skill/checklist content needed for the phase. Preserve read-only settings sources, confinement, isolated scratch, and dependency projection. Do not transfer secrets, runtime logs, approval/control state, credential files, or whole ignored directories. If an authoritative rule contains sensitive data, preserve a private source digest and a safe actionable requirement; never silently alter its meaning. A requirement that cannot be conveyed safely yields an explicit configuration/authority decision.

Final QA also reloads the validation checklist independently today: `qaReview.ts` uses `buildQaReviewHandoff` and the `beginV2Review` setup path to read `loadTicketSetupConfigWithDefaults(opts.builderWorktree).build.validation_checklist`. Fix both paths explicitly. Resolve one effective configuration snapshot before review-basis publication and pass its exact checklist bytes/representation to the handoff renderer and basis builder. The frozen checklist digest must match what the reviewer actually receives, and match the contract's common requirements unless an authorized amendment reconciles a deliberate change. Neither a later worktree reload nor a factory-only bundle fix satisfies this.

Configuration precedence is canonical project rules plus explicitly recorded authorized overlays. If worktree settings differ, resolve the difference before freezing review inputs; never hash canonical settings while prompting with worktree settings. Add integration fixtures with canonical/worktree checklist differences, ignored compiled bundles, and a settings change between basis construction and dispatch. Assert the actual prompt, runtime metadata, contract input digest, and review-basis checklist digest agree or the review is stopped for reconciliation.

### 5.2 Delivery and acknowledgment

Render full ticket context plus an ordered contract summary and durable complete JSON/Markdown artifacts. For small contracts, inline the complete relevant content. For larger contracts, include all mandatory check IDs, obligations, activation conditions, prerequisites, and evidence expectations in a bounded index, then supply accessible sections. If even the index exceeds the context limit, use bounded read-only delivery turns by section before implementation. Never silently truncate requirements.

Before dispatch:

1. Host materializes verified files at a provider-accessible path in the actual workspace or explicitly allowed read root, then checks their digests and access configuration.
2. A confined acceptance turn reads the supplied artifact or complete inline content and returns a small structured acknowledgment: work ID, revision, digest, and missing/unreadable sections. No product changes are permitted during acceptance.
3. Host validates the response, actual provider identity/generation, canonical workspace identity, delivered instruction/resource digest, and current contract head. Record an acceptance receipt linked to the upcoming assignment.
4. The write-enabled implementation session must be the session accepted by the receipt. If confined acceptance requires a separate provider session, its receipt alone is insufficient: establish delivery/acceptance for the actual implementation session through an enforceable planning-only startup step before enabling writes. Do not assume a separate reader acknowledged for Builder.

Implement an explicit adapter turn purpose such as `contract-acceptance`, distinct from existing response-only format repair. The current Codex adapter already sends a `sandboxPolicy` with each `turn/start`; extend that path to request read-only confinement and no escalation for acceptance on the same validated thread, then use normal permissions only after receipt validation. Verify the effective turn policy, preserve scoped thread identity, and reject attempted writes. The current Claude adapter constructs a persistent query with `acceptEdits` for Builder; a permission callback alone must not be assumed to intercept automatically accepted tools. Add a phase-aware provider hook/control that denies product-mutating tools before execution, including shell/agent paths, during acceptance. Prefer complete inline/segmented delivery with tools disabled when that avoids needing a read-capable permission transition. Test pre-execution denial and restoration of normal permissions, not just mutation detection afterward. If the supported SDK cannot provide that same-session boundary, implement a validated close/reopen of the exact scoped Builder conversation under normal permissions after confined acceptance, rechecking actual identity/workspace and redelivering the version binding. Never create an unrelated successor and reuse its predecessor's receipt. A provider lacking a tested supported mechanism remains explicitly unsupported for enforcement until resolved.

This is a transport/version receipt, not proof of comprehension. Keep it one short exchange or existing session-start handshake when possible. Record run/work/admission, contract digest/revision, delivery method, resource digest, session/provider/generation, workspace/config root, timestamp, and acceptance operation/response digest.

Renew after replacement, resume in a changed workspace, compaction that removes supplied context, or amendment. The full artifacts remain accessible throughout implementation. Attach the revision/digest to completion handoffs; stale/missing acknowledgments or evidence require bounded repair. Never erase foreign work markers or treat an ambiguous implementation turn as unsubmitted.

### 5.2.1 Provider-native compaction during implementation

Renewing acceptance at the next host-controlled turn is insufficient when the provider compacts context and continues implementation inside an already dispatched turn. Codex currently records a `contextCompaction` item; Claude records a compact event. Notification/accounting alone does not pause subsequent tool execution. Treat this as a separate execution boundary from Foreman-driven compaction before dispatch.

P0 must select and demonstrate a supported mechanism for each provider: (a) provider-native preserved instructions/resources with a tested guarantee that the complete binding and accessible contract survive compaction; or (b) a pre-tool barrier that pauses further implementation tools after compaction, reinjects the contract/version, validates renewed delivery, and only then resumes. Event-driven host reinjection is acceptable only if no implementation tool can race ahead before renewal. Disable native compaction or use a supported host-controlled turn interruption/restart when neither mechanism is available. Do not claim context preservation from a native event or an accessible file alone.

Persist compaction identity/sequence and receipt continuity. If interruption leaves dispatch uncertain, reconcile existing turn results and source before continuing; do not replay submitted implementation. Test native compaction halfway through a turn, immediately followed by a mutating tool: the tool either retains the tested full contract context or is blocked pending renewal. Also test multiple compactions, tool/compaction event ordering, interruption, and provider-session replacement. Keep existing source-mutation and foreign-work protections.

### 5.3 Evidence and final-review protocol

Extend the shared response protocol with a versioned contract coverage block, leaving old parsers available for intentional legacy runs. It contains work identity, contract revision/digest, reviewed source digest, and per-check applicability/evidence/outcome. Builder coverage is a claim; final QA coverage is independent assessment. Both are parsed with strict size limits and bounded response-only repair.

Per-check evidence records command/procedure, cwd/runtime, source/check version, outcome, output/test/code reference, and limitation where present. Manual observations identify who observed what and where. Reuse evidence blobs and existing result retention; do not require large prose for a straightforward test assertion.

Final QA must independently evaluate predicates. Unconditional mandatory checks are applicable. Conditional mandatory checks activated by Builder choices are equally binding. `not-applicable` requires evidence for the predicate; `unresolved`, `not-run`, `blocked`, and `failed` never count as pass. Advisory results remain visible without becoming completion blockers. Preimplementation-only checks can use independently assessed retained readiness evidence; postimplementation/both checks must address the completed source.

Extend `QaReviewBasisV2` compatibly through an explicit newer basis format or tagged contract-binding extension. Include contract digest/revision, common effective requirements, and actual phase/runtime/confinement digests in the immutable predispatch input basis; bind that basis digest and the subsequently produced final coverage digest in certificate authority using section 5.3.1. Do not reinterpret old digest formats or make newly required fields optional in enforcing runs. Preserve existing source-freeze, mutation checks, report history, unresolved finding/control checks, session identity, certificate consumption, and waiver mechanisms.

Final review creates a fresh conversation in the current disposable snapshot. It cannot inherit the preparer, approach author, Builder, or a session from another snapshot. Existing same-snapshot continuity/recovery handoff rules may operate only when their current basis/identity validation passes; contract data cannot bypass them.

Certificate issuance and consumption both verify the bound contract/basis and resolved coverage. Every applicable mandatory check requires independent passing evidence or an authorized equivalent that actually verifies the expectation. Waived obligations go through explicitly waived completion under existing authority; do not produce a normal pass certificate implying those checks passed. A generic success marker with missing coverage is protocol-incomplete and cannot complete work.

### 5.3.1 Review-basis, coverage, and certificate publication order

Preserve the existing predispatch ordering around `beginV2Review` and `commitQaReviewReady`; coverage does not exist when that basis is frozen. Use distinct immutable input and result artifacts:

1. Freeze the source snapshot and authoritative contract revision. Build a versioned **review input basis** containing source/admission identity, contract digest/revision, effective checklist/common rules, actual final-phase/runtime/confinement digests, and required review inputs. Publish it before dispatch. Its digest excludes future coverage and terminal results.
2. Persist review intent and dispatch against that basis and review attempt/session identity, then retain the complete terminal response and receipt under existing recovery rules.
3. Parse and validate immutable **final coverage** bound to the input-basis digest, contract revision/digest, reviewed source digest, attempt/session, and terminal-response digest. Persist the exact coverage blob/result and digest; retain invalid results as protocol evidence without granting completion.
4. In the `commitQaPassAttempt` transaction, validate current source/contract/basis authority, matching retained terminal receipt, coverage digest/content, applicability, mandatory outcomes, unresolved findings/controls, and attempt state. Publish a certificate binding both input-basis and coverage digests plus the existing receipt/source authority. A pass attempt must not become authoritative before these checks succeed atomically.
5. At certificate consumption/finalization, load verified basis/coverage blobs and recheck their binding and current authority. Missing/corrupt/mismatched coverage blocks consumption. Existing source-freshness and single-consumption protections remain required.

Never rewrite the original input basis with final results. A parser repair remains associated with the original substantive review and has explicit response/repair receipt provenance. Define the versioned binding for the accepted repaired coverage, rather than pretending it came from the first malformed response. A changed contract/source/input basis requires a new substantive review. Test crashes after each publication boundary, concurrent issuance, stale attempt completion, tampered coverage, and consumption after relevant amendment. Preserve intentional legacy certificates using their tagged original digest semantics.

### 5.3.2 Authorized equivalents and waiver granularity

The existing `WorkflowDb.commitQaWaiver` waives all unresolved reports and moves the ticket to waived completion. It does not provide selective check-level waiver authority. For the initial implementation, retain that whole-work completion mechanism and make its extent explicit: bind the authorized waiver decision to the work/admission, contract revision/digest, review basis/source, every affected mandatory check and unresolved report, reason, authorizing actor/mechanism, and time. Enumerating checks is traceability, not permission for an agent to turn individual checks into ordinary passes. Any mandatory check excused through this route produces waived completion; an unresolved unrelated mandatory check must also be included under the existing whole-work authority or remain blocking.

An approved equivalent verification method is different from a waiver: an existing authorized decision approves a concrete method demonstrating the same expectation. Persist its method/evidence/scope/validity conditions and authority reference, bind it to check identity and applicable contract/source/runtime assumptions, and have final QA independently assess the evidence. Only a verified equivalent can satisfy normal pass coverage. Preparers/reviewers may propose an equivalent but cannot approve it by supplying `dispositionRef` text.

Implement `AuthorizedDisposition` resolution against real persisted decisions, not arbitrary strings. Host validates actor/decision authority, applicability to this admitted scope, exact obligation, revision and validity conditions at readiness, amendment, certificate issuance, and consumption. Amendments explicitly carry forward or invalidate dispositions; changes in meaning require renewed authority. If implementation instead introduces selective waivers, that is a separately documented extension of decision/reducer/storage/UI/recovery authority with behavioral tests; do not assume existing `commitQaWaiver` supplies it. Do not add a new user confirmation requirement for decisions already authorized through existing mechanisms.

### 5.4 Findings, remediation, and amendments

Classify findings as: existing-check failure; approved-scope/invariant defect; preparation omission; proposed new scope; advisory improvement. One finding may have a defect classification and an omission tag. Approved-scope defects remain blocking even if omitted from preparation; record the missing check and issue a traceable clarification/amendment before declaring contract-complete. A new preference is advisory/proposed until authorized.

Enrich `qaFailureDelivery` and remediation responses with contract/revision/check references. Preserve original finding identities, source/report bindings, detailed ticket context, remediation generations, and retained response receipts. Manager guidance follows its existing approval/verification path; it cannot silently change contract requirements. Applicable guidance that changes obligations triggers authorized reconciliation and renewed QA when needed.

Freshness policy:

| Change | Effect |
|---|---|
| Product changes implementing this contract | Contract remains applicable; Builder evidence and final QA bind the new source. |
| Material implementation choice activates a documented predicate | Resolve that check's applicability; contract revision need not change if the condition was already defined. |
| Ticket/plan acceptance, required tests, scoped approved answers, checklist, effective rules/skills change | Compare authoritative inputs; relevant changes require revalidation/amendment and any existing scope approval. |
| Unrelated source/docs/control artifacts change | No blanket invalidation; compare inspected assumption/dependency references. |
| Referenced baseline assumption/dependency changes before dispatch | Targeted revalidation; reprepare affected checks if the assumption no longer holds. |
| Runtime/capability changes | Reprobe affected readiness/evidence; preserve semantic requirements unless changed behavior requires amendment. New final runtime changes review basis. |
| Delivery/session/workspace changes | Renew delivery receipt; do not automatically regenerate unchanged contract content. |

An amendment records authority, predecessor, reason, diff of checks/inputs, semantic/depth reevaluation, and applicability/evidence consequences. Reconcile on a safe boundary: prevent new implementation/review dispatch; retain any already-sent turn result as against the old revision; publish the new revision atomically after validation. Carry forward only evidence that remains valid for unchanged expectations and source/runtime assumptions, with explicit carry-forward records. Added/changed checks require new evidence; removed checks require traceable disposition.

Invalidate incompatible unconsumed certificates and active review bases. Publish renewed Builder delivery and start a fresh review against the reconciled revision when necessary. Never combine old evidence and a new latest-file pointer without reconciliation. Consumed/finalized work is not silently rewritten; consequential changes use existing reopen/new-work mechanisms and retain the original completion history.

## 6. Implementation work packages

Each package should be reviewable and have behavioral tests. Do not stop after the early fixes: this plan requires the end-to-end feature. Dependency order is P0 → P1/P2 → P3 → P4 → P5 → P6 → P7 → P8; some schema/config work can be developed together without bypassing integration dependencies.

### P0 — Establish baseline and enumerate execution paths

Read the files in section 1 and requirements 35–36. Trace all Builder implementation dispatches, QA completion/waiver callers, source capture exclusions, planner/population schema validators, provider session startup, and exact recovery routes. Record an entry-point matrix distinguishing build/planning/repair/recovery phases. Inspect current provider acknowledgment capabilities before choosing the mechanism in section 5.2.

Capture available historical build/QA records as the measurement baseline with explicit missing-data limitations. Run relevant existing workflow tests on a native-module-compatible Node runtime and record environmental failures. This is required evidence for implementation, not a demand to rerun every unrelated suite before coding.

Acceptance: every implementation/finalization caller has an identified guard/integration task; existing protections and baseline limitations are documented.

### P1 — Fix Builder context and effective QA bundle loss

Introduce the shared full-ticket/checklist context renderer. Use it for ordinary, initial branch, resumed branch, synthetic, and remediation contexts. Correct the same-Builder-session QA wording in branch prompts and role guidance. Add the effective QA configuration resolver and use it for actual QA adapter construction/metadata, separating config root from snapshot cwd.

Touch: `foreman.ts`, `branch/runner.ts`, `cli/start.ts`, `qaRuntime.ts`, `roles.ts` as needed, new config/context helpers, role packs, and existing context/runtime/snapshot tests.

Acceptance: mocked provider receives the entire assigned ticket and applicable checklist on initial/resumed/replacement paths; independent final review uses the intended compiled QA content even when ignored `.rafi` is absent from its snapshot. Its recorded digest matches the content actually dispatched. No broad ignored-state copy occurs.

### P2 — Add shared schemas, depth decisions, and durable storage

Implement the strict data types, schemas, bounded parsers, digest rules, identity history, and deterministic validation. Add transactional migration/store helpers. Extend plan/ticket schemas, population/proposal/import handling and display for planner selections. Add depth policy and risk minimum validation. Freeze mode and policy in build run records.

Touch: `packages/spec/src/{types,schemas,validate,index}.ts` and a focused new contract schema module; `packages/rafi/src/structuredPlan.ts` proposal/materialization/validation/digest/render pipeline; `tickets/ticketSchema.ts`, ticket validation/rendering; `ticketPopulation.ts`, `ticketPlanning.ts`, `workflowDb.ts`, `workflowReader.ts`, build-run/admission integration; new policy/store/contract modules.

Acceptance: old valid tickets/records parse intentionally; enforcing new plans require decisions; population preserves the planner selection; contracts cannot become ready with missing inventory coverage, illegal check references, unsupported dispositions, or insufficient depth. Ready publication is atomic and recoverable.

### P3 — Wire planner ownership and confined preparation

Update `packages/rafi/src/{plan,structuredPlan}.ts` and planner/ticket-maker role instructions to emit and preserve decisions. Add read-only fallback assessment for admitted legacy/imported/synthetic work. Implement escalation requests, planner revisions, minimum enforcement, and recorded downgrade validation.

Implement shared preparation service with input collection, bounded investigation, early prerequisites/baseline, semantic assessment, Level 5 proposal/challenge, targeted repair, and publication. Distinguish effective QA preparation phase from final review. Use actual permission/confinement controls, not a prompt asking a write-enabled agent to behave.

Touch: new preparation/policy modules, `agentRun.ts` or a dedicated confined session factory, `qaPrerequisites.ts`, CLI provider factories, plan/population handling, role instructions and config schemas/defaults.

Persist logical budgets/reservations/extensions as specified in section 2.3; wire every planning/startup call listed in section 4.2.1 through enforceable phase confinement. Include `packages/rafi/test/structuredPlan.test.ts` in proposal-to-population verification.

Acceptance: normal work starts at Standard unless planner evidence justifies another level; escalation is planner-owned and automatic within approved scope; planner failure and unfinished challenge leave an explicit recoverable state; incomplete semantic review or exhausted budget never dispatches implementation.

### P4 — Enforce delivery and implementation gating across modes

Implement provider-supported contract acceptance, complete renderings, accessible projections, delivery receipt persistence, and completion binding. Integrate per-work preparation into ordinary and branch execution after existing approval/admission and before implementation. Add a host guard covering assignments, continuations, remediation, and Manager followups. Fix resume/replacement/compaction delivery and test source-capture exclusion for artifacts. Implement and test the mid-turn native-compaction boundary in section 5.2.1 for each supported provider, including immediate subsequent implementation tools.

Touch: `foreman.ts`, `branch/runner.ts`, `cli/start.ts`, `buildAssignment.ts`, `buildSyntheticWork.ts`, `qaFailureDelivery.ts`, relevant session/continuity/handoff/adapters, delivery service and migrations.

Acceptance: no enforcing implementation starts without ready contract and valid actual-session receipt; ordinary/branch/synthetic paths use the same service; changed workspace or revision requires renewed acceptance. Receipt failure cannot be repaired by substituting another session's acknowledgment.

### P5 — Integrate evidence, independent final coverage, and completion

Add Builder evidence and final QA contract coverage blocks and parsers. Extend final handoff, QA review basis, report retention, recovery packets and pass/waiver authority. Evaluate applicability independently and classify findings. Implement section 5.3.1 publication ordering and section 5.3.2 persisted equivalent/whole-work waiver bindings; explicitly remove checklist reload divergence in both `qaReview.ts` handoff and basis construction paths. Preserve all existing review freshness, mutation, session, remediation, and Manager control gates.

Touch: `qaReview.ts`, `qaProtocolV2.ts`, `qaFailureDelivery.ts`, `qaRecovery.ts`, `qaRuntime.ts`, `workflowDb.ts`, shared response schemas/parsers and role prompts, new coverage service.

Acceptance: generic pass, missing IDs, unresolved predicates, not-run mandatory checks, wrong source/revision, or Builder self-QA cannot issue/consume a valid enforcing pass certificate. Fresh reviewer sees the same requirements and may still discover approved-scope defects outside preparation.

### P6 — Implement freshness, amendments, and exact recovery

Implement input-specific freshness and revision reconciliation, evidence carry-forward, certificate invalidation, lease-safe recovery, and artifact repair. Integrate exact QA-only/finalization paths before ordinary lifecycle entry. Add intentional legacy handling without manufacturing preparation/delivery history.

Touch: new freshness/store helpers, `cli/start.ts`, `branch/runner.ts`, `qaReview.ts`, QA protocol/recovery, `operationRecovery.ts`, existing recovery policy/build migration modules, admission/approval integration.

Acceptance: implementation edits do not constantly invalidate contracts; relevant requirement changes do. Amendments cannot finish with stale evidence/review authority. Exact QA-only recovery invokes no Builder preflight, proposal, implementation, or preparation replay, whether contract records are valid, stale, or legacy.

### P7 — Add telemetry, operator visibility, and migration controls

Implement versioned event accounting and reports, status/diagnostic display of depth/readiness/blockers/revision, frozen rollout modes, backwards-compatible migrations, and documentation. Propagate actual provider latency/cost when available; retain unknowns.

Touch: `observability.ts`, existing diagnostics/status/manager readers, workflow/build records, setup/config schemas, role defaults, command options if needed, user docs and generated CLI docs.

Acceptance: metrics cannot count unavailable verification or waiver as first-pass success, double-count repairs as substantive reviews, or hide preparation failures. Recovery respects the mode frozen in its run rather than current global settings. Configuration defaults/precedence and finding classifications follow sections 8.1.1 and 8.2.1, with evidence-backed sampling rather than inferred causal claims.

### P8 — End-to-end validation and final implementation handoff

Run the regression matrix below and existing affected suites, then required repository typecheck/build/test/docs checks. Resolve failures caused by the feature. Document unrelated baseline/environment failures, actual supported provider behavior, migrations, policy limits, and operational recovery commands. Update requirement traceability with implemented files/tests and any justified deviations. Confirm that all 36 requirements have acceptance evidence.

Acceptance: builder-ready feature spans planning through completion in both modes, with validated migration/recovery and no weakened review protections. Do not claim measured success gains from mock integration tests.

## 7. Regression and integration matrix

Use deterministic fake provider adapters, temporary Git repositories/worktrees, SQLite fixtures, injectable probes/clocks, and actual contract files. Test observable dispatch/authority behavior rather than mirroring implementation strings. Extend existing suites where appropriate; proposed new suites include `qaPreparationPolicy`, `qaVerificationContract`, `qaPreparation`, `qaContractDelivery`, `qaContractCoverage`, `qaContractFreshness`, and `qaPreparationMetrics`.

| ID | Behavioral scenario and required assertion | Existing suite anchors |
|---|---|---|
| T01 | Full ticket, notes, rollback, references, tests, rules/checklist delivered in ordinary/initial/resumed branch and replacement sessions; actual review is independent | `foreman.test.ts`, `branch.test.ts`, `branchPresentation.test.ts` |
| T02 | Ignored compiled QA bundle survives explicit config delivery; final adapter metadata/digests match dispatch; fallback/config changes are detected; secrets/control files excluded | `qaRuntime.test.ts`, `qaSnapshot.test.ts`, `qaSessionPreparation.test.ts` |
| T03 | Planner slice decision preserved in materialization, revisions/imports/snapshots; ticket-maker cannot override; Standard fallback assessed; Focused justified; synthetic placeholder risk reassessed | `ticketPopulation.test.ts`, `alignedPlan.test.ts`, ticket-planning/plan tests |
| T04 | Risk minimum prevents dispatch; preparer requests planner escalation; valid revised depth accepted; cost-only downgrade rejected; planner failure retains recoverable state | New policy/preparation tests |
| T05 | All level obligations differ and are enforced; Level 5 challenge fresh/independent, limited rounds, no product writes, unresolved concern blocks; budget exhaustion cannot downgrade | New preparation/policy tests |
| T06 | Missing acceptance/test/checklist coverage, duplicate IDs, missing references, dependency cycles, vague/conflicting semantic findings, unsupported dispositions cannot publish ready | New contract/preparation tests |
| T07 | Explanation does not waive a requirement; authorized scoped disposition remains traceable; structural pass cannot overrule semantic failure and vice versa | New contract/coverage tests |
| T08 | Unconditional/conditional and mandatory/advisory combinations are independent; future predicates may await implementation; activated mandatory condition blocks on failure/not-run; unresolved final predicate cannot certify | New coverage tests, `qaProtocolV2.test.ts` |
| T09 | Start capability missing blocks; final-only capability permits explicitly conditional readiness; missing requested test/source fix is expected baseline transition; existing failing test not silently waived; host/provider access differs | `qaPrerequisites.test.ts`, new preparation tests |
| T10 | Actual-session artifact access/acknowledgment before writes; missing/foreign/stale/inaccessible receipt blocks; context boundary, resume, new workspace, and amendment renew acceptance | New delivery tests, `buildAssignment.test.ts`, handoff tests |
| T11 | Ordinary, branch, synthetic, continuation, remediation, Manager followup use guard; malformed completion cannot escape; synthetic identity remains frozen and distinct | `foreman.test.ts`, `branch.test.ts`, `buildWorkAdmission.test.ts`, `qaFailureDelivery.test.ts`, guidance tests |
| T12 | Crash before/after candidate validation/publication/projection/dispatch recovers correctly; unknown dispatch not duplicated; competing owners/CAS/lease generations reject stale publication and second Builder | New store/preparation tests, recovery/lease tests |
| T13 | Product implementation edits preserve semantic contract; relevant plan/rule/checklist/skill/dependency changes revalidate; unrelated changes avoid blanket refresh | New freshness tests, snapshot/runtime tests |
| T14 | Amend while Builder/reviewer active; old turn retained; evidence carried only deliberately; new conditions/checks require evidence; old certificate invalidated; revision agreement required | New freshness/coverage tests, `qaProtocolV2.test.ts` |
| T15 | Final reviewer conversation fresh and bound to snapshot; rejects preparer/Builder/old-snapshot identity; source mutation and stale live source still block | `qaSessionPreparation.test.ts`, `qaSnapshot.test.ts`, `foreman.test.ts`, `qaHandoffAcceptance.test.ts` |
| T16 | Full mandatory coverage before certificate issue/consume; generic pass, missing IDs, wrong digest, unavailable verification and advisory-only report cannot complete; authorized waiver distinct | Protocol/review/decision tests, new coverage tests |
| T17 | New defect/invariant finding remains blocking; omission tagged/amended; new product preference not silently blocking; remediation and Manager guidance retain binding/history | `qaFailureDelivery.test.ts`, `qaGuidanceDelivery.test.ts`, new coverage tests |
| T18 | Exact ordinary/branch QA-only recovery and interrupted finalization with valid/stale/missing/legacy contract call no preflight/proposal/Builder/preparation replay; preserve history and valid original authority | `qaRecovery.test.ts`, `branchFinalization.test.ts`, `foreman.test.ts`, QA handback migration/caller tests |
| T19 | Legacy parsers/runs intentional; new enforcing runs cannot choose legacy via omitted fields; repeated migration safe; feature-mode/policy frozen on resume | `buildWorkMigration.test.ts`, QA migration/recovery tests |
| T20 | First review/report repair/substantive recheck/blocked/not-run/waiver/cancellation/amendment/preparation failure counted correctly; duplicate replay deduped; quality observation windows and missing costs/data explicit | Observability/timeline tests, new metrics tests |
| T21 | Preparation/acceptance/approach permissions reject product mutation; artifacts excluded from product capture; large contract segmented without missing mandatory conditions; timeout and parser repair bounded | New preparation/delivery tests, adapter/runtime/snapshot tests |
| T22 | Seven end-to-end scenarios in section 9 run through actual shared services in both ordinary and branch modes where applicable | Combined mocked workflow integration fixtures |

The audited execution gaps require these additional regressions; they supplement T01–T22 and are release gates for the affected packages:

| ID | Behavioral scenario and required assertion | Work package / anchors |
|---|---|---|
| T23 | Initial/revised planner proposal survives explicit materialization, validation, digest, approved publication, retained-slice handling, ticket population and snapshots; stale metadata cleared deliberately | P2/P3; `packages/rafi/test/structuredPlan.test.ts`, population/plan suites |
| T24 | Preflight, preflight feedback, branch dependency audit, proposal, response repair, and native initialization attempt writes/installs/child mutation; actual provider boundary denies before execution | P3/P4; Foreman/CLI/provider adapter tests |
| T25 | Native compaction midway through implementation followed immediately by mutating tools preserves tested full context or pauses tools until redelivery; notification alone does not pass | P4/P6; Codex/Claude adapter and delivery integration tests |
| T26 | Draft assessment hashes are non-circular; edited draft rejects old assessment; basis published before dispatch stays immutable; coverage binds source/attempt/terminal receipt; atomic certificate issue/consume rejects absent/tampered results and survives crashes | P2/P5/P6; contract/protocol/WorkflowDb/recovery tests |
| T27 | Canonical/worktree checklist differences and settings changes during review preparation cannot yield a prompt/basis/contract mismatch; bundle factory fix alone insufficient | P1/P5; runtime/review/handoff integration tests |
| T28 | Fake disposition references and stale/elevated-scope equivalents rejected; verified authorized equivalent can pass; existing whole-work waiver enumerates affected checks/reports and never produces normal pass | P2/P5/P6; decision/reducer/coverage/recovery tests |
| T29 | Crash, retry, changed lease/operation generation, downtime and escalation preserve logical consumed/reserved budgets/deadline; exhausted resume blocked absent persisted authorized extension | P2/P3/P6; injected clock/store/lease tests |
| T30 | Absent/legacy/shadow/enforce config, invalid values, precedence, planner invoked before run creation, QA disabled and changed global mode on resume all follow frozen policy | P2/P3/P7; setupConfig/planner/start/recovery fixtures |
| T31 | Disclosed Builder miss, preparation omission, ordinary defect, new scope, outside-contract finding and ambiguous causes classified from persisted evidence; replay/remediation do not inflate counts; overpreparation samples retain cost/usefulness evidence | P5/P7; coverage/metrics/sampling tests |

T24–T25 must exercise the actual provider adapter's effective SDK/RPC options and tool barrier with controlled provider events, not only a mock domain service returning `read-only`. Document any provider limitation and withhold enforcing support when these guarantees cannot be established.

Recommended validation sequence after relevant packages are implemented:

```sh
pnpm --filter rafi-spec test
pnpm --filter special-agents test
pnpm --filter ai-foreman test
pnpm --filter @rafi-ai/cli test
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
```

Use focused `tsx --test` invocations during development, including existing admission, protocol, review, recovery, branch, runtime and snapshot suites. Execute tests with the Node runtime compatible with the installed SQLite binary, or follow the repository's documented native-module repair workflow. Do not reinstall arbitrary dependencies simply because a test fails. Live-provider tests are supplementary and require existing authorization/runtime availability; mocked tests must establish the core guarantees first. Record all executed commands and distinguish pass/fail/not-run/blocker accurately.

## 8. Rollout and measurement policy

### 8.1 Modes and migration

Define `qa_preparation.mode` with `legacy`, `shadow`, and `enforce`, frozen at run creation together with policy/schema capabilities. Legacy retains existing protections and intentionally skips preparation. Shadow generates/assesses contracts and records findings without claiming an implementation gate or advance delivery if Builder proceeded independently. Enforce requires the full normal gate and contract-aware completion protocol. Explicitly mark legacy/shadow outcomes so they cannot be counted as fully prepared builds.

Roll out P1 context/config fixes first. Then ship contract and planner data handling, shared orchestration, enforcing delivery and final coverage, recovery, and telemetry. Do not turn enforce on until P4–P6 and regression guards pass. Existing in-progress runs retain their original policy; upgrading them requires a deliberate migration event, not a changed global default. New enforcing runs cannot downgrade to legacy on provider failure.

If final QA is explicitly disabled under existing authorization, preparation may still provide the contract, but record `independent-review-disabled` and retain existing completion policy. Such outcomes are not independently QA-verified or included as first-review passes. If no QA/preparation provider can be established for an enforcing run, report an explicit configuration/incomplete outcome; do not bypass preparation. Preparation never re-enables authority the user explicitly disabled.

Support old tickets with missing depth, resumed worktrees, legacy protocol records, and exact QA recovery as defined above. Additive schema migrations must preserve old evidence/certificates and be idempotent. Readers distinguish unsupported future schema from missing legacy fields. Do not remove old parsers until supported recovery records have an explicit migration path.

### 8.1.1 Configuration location, defaults, and precedence

Add `qa_preparation` to the canonical project setup configuration schema, normalization, default creation, validation, and rendering. Keep it distinct from `build.qa` or the existing final-review enablement setting. The initial code release preserves missing configuration as `legacy`; do not activate a partial feature by adding a default early. Once P4–P6 and provider release gates pass, the new-project setup template can explicitly choose `enforce`; existing configuration without the key remains `legacy` until a deliberate operator migration. `shadow` must be explicitly selected and displayed. Reject unknown modes or invalid policy overrides rather than falling back to legacy.

For a new invocation, precedence is a validated explicit invocation override (only if a public option is introduced), then the canonical project's explicit `qa_preparation` configuration, then the absent-key legacy compatibility default. Resolve authorized overlays once with provenance. For resume/recovery, the persisted run policy takes precedence over current files/options; a requested change must use a deliberate supported migration operation, otherwise fail with a diagnostic. Persist resolved mode, policy version and budget settings, effective config provenance/digest, provider capabilities, and independent-review enabled/disabled state before any gated dispatch.

The project planner command can run before a build run exists. It resolves and freezes a planning policy snapshot through the same resolver: newly generated enforcing plans require per-slice depth and policy provenance even without a run record. A later run validates that snapshot against its chosen policy/minimums; it cannot treat a missing planner field as evidence that enforcement was disabled. Legacy/shadow plans may retain optional metadata; an enforcing run obtains missing decisions through the dedicated read-only assessment.

Final QA disabled under existing authorization does not implicitly disable preparation. An enforcing run still needs a preparation provider, ready contract, and Builder delivery, while completion is marked independently unverified under its authorized final-review policy. Conversely, enabling final QA does not silently change legacy preparation mode. Explicitly test each combination and show mode/depth/review state in status without mixing these outcomes into first-review success.

### 8.2 Metric definitions

Use stable work/admission identity and event IDs. Count a primary cohort of approved work entering implementation, with adjacent approved-but-never-started and preparation-failure cohorts so failures moved earlier remain visible.

- First substantive review: first independent review of an implementation/source state that assesses correctness and verification. A response-format repair with unchanged source/basis is part of that same review, not another correctness attempt.
- First-review pass rate: work whose first substantive review independently passes all applicable mandatory checks divided by work receiving a first substantive review. Include blocked/not-run first reviews in the denominator with separate statuses; exclude advisory-only, waived, legacy-without-equivalent-data, and review-disabled outcomes from the pass numerator.
- End-to-end first-attempt success: approved started work completing with an independent first-review pass, reported alongside preparation-blocked/failed approved work. Never present a favorable subset alone as the overall success rate.
- Remediation rounds: actual implementation corrections followed by substantive recheck. Provider retries and report repairs have separate counters.
- Amendments/scope revisions: within-scope contract amendments stay linked to the work and its original first review; materially revised scope has a new admission/cohort link without deleting prior failure history. Do not reset first-attempt history merely by amending a contract.
- Environment/preparation failure: retain phase and cause separately. Unavailable mandatory checks are blocked/not-run, never success. Waivers, cancellations, retries, and abandoned work are separate dispositions with published counts.
- Quality signals: reopened work and escaped approved-scope defects observed at 7 and 30 days after completion where data exists. Missing/delayed linkage is unknown. Review a risk-stratified sample for contract completeness and review quality, including passes and failures.
- Cost/time: preparation, planning/escalation/challenge, Builder, review, repair, and remediation separately plus total; include known provider usage and operational latency. Missing usage is unknown and report coverage of measurements.

Deduplicate event replay by persisted operation/event identity. Label level, risk category, execution mode, provider/model/runtime, QA policy version, contract amendments, and relevant environment availability. Compare matched work categories or risk-stratified cohorts rather than unadjusted Level 1 versus Level 5 rates. Baseline data that lacks structured causes must be labeled inferred/unavailable.

Initial evaluation gate: gather at least 50 completed independently reviewed enforcing work items across representative modes/risk categories, and sample at least 20 contracts/reviews or all completed items if fewer are available. Compare with matched baseline work under equivalent QA standards. Target at least a 20% relative reduction in avoidable requirement-omission remediation, no material deterioration in escaped/reopened defects or sampled coverage, and improved median total cycle time or a documented quality benefit justifying added cost. Publish uncertainty and cohort sizes; these are initial evaluation targets, not a guaranteed effect or an automatic release algorithm.

If first-pass improves while mandatory coverage or sampled quality weakens, the feature has not met the objective. Adjust prompts/investigation/policy based on evidence; never weaken required checks or automatically downgrade risk to improve metrics. Separate changing provider/runtime/QA standards from the feature's estimated effect.

### 8.2.1 Finding classification and usefulness sampling

Persist evidence-backed classifications with a versioned taxonomy. The final reviewer proposes the finding/check linkage; deterministic host validation checks IDs, authority and historical delivery/evidence, and a configured independent assessor or documented human audit adjudicates ambiguous semantic causes. Record classifier identity, evidence references, confidence/unknown status, and any later correction. Never infer a cause only from a failed marker or an agent's unsupported claim.

| Classification | Evidence required and accounting |
|---|---|
| Disclosed requirement missed by Builder | Applicable requirement and actionable check were delivered before the affected implementation; actual source/evidence fails them. Count a Builder miss, not a preparation omission. |
| Preparation omission | Approved/invariant requirement existed in authoritative prebuild inputs, but the delivered contract omitted it or lacked an actionable necessary expectation. Record missing input/check mapping and independent assessment. |
| Ordinary implementation defect | Contract reasonably covered the expectation, but implementation behavior failed; retain defect category and any separate omission tag only when evidenced. |
| New authorized scope | Expectation was introduced after delivery through an approved scope/decision change. Link the new admission/amendment and do not count as a historical omission. |
| Newly discovered finding outside contract | Count the outside-contract event regardless of eventual cause, then distinguish an approved-scope/invariant defect, evidenced preparation omission, new scope, or advisory suggestion. This counter is not itself proof of preparer error. |
| Unknown/ambiguous cause | Preserve evidence and uncertainty; include in published cause coverage and adjudication sample, never silently exclude to improve rates. |

Define `avoidable-requirement-omission-remediation` as a substantive correction/recheck attributable to an evidenced preparation omission of a requirement knowable from the admitted inputs/reasonably required selected-depth investigation at delivery. An independent assessment must support knowability/actionability; hindsight alone does not qualify. Report both work-level incidence (work with at least one such remediation / comparable started work) and rounds per comparable started work. Use the work-level incidence for the section 8.2 relative-reduction target, with an explicit baseline incidence, denominators, unknown-cause coverage and matched cohorts. A zero or unavailable baseline makes relative reduction undefined. Deduplicate by finding/work linkage across repairs, amendments and rechecks; correcting a classification adds an auditable event rather than deleting history.

Sample passes as well as failures at each depth. Retain input/contract/delivery/review evidence, investigation time/known cost, which checks caught defects or guided verification, duplicate/irrelevant checks, and an assessor's specific excessive-investigation observations. A check finding no defect is not automatically unnecessary, especially for consequential rare risks. Report whether extra preparation improved observable coverage or prevented omission, and the costs of redundancy and delay. Use these samples to adjust budgets/policy or consolidate levels while keeping all applicable requirements and risk minimums; do not automatically reduce depth because a check passed.

## 9. Representative end-to-end acceptance scenarios

### S1 — Ordinary ticket

Inputs: admitted full ticket, approved plan/slice, checklist, effective rules/skills and actual source baseline. Planner chooses Standard with normal-risk rationale. Preparation inspects relevant code/tests, maps every acceptance/test/checklist requirement, records prerequisites and semantic assessment, and publishes revision 1/digest A. Actual Builder session acknowledges A before implementation. Completion supplies A and per-check evidence. Fresh final QA snapshot evaluates A against completed source B, independently verifies mandatory checks, and issues/consumes a source-and-contract-bound pass. No missing coverage can be hidden by a generic pass.

### S2 — Critical ticket with discovered interacting risk

Inputs: admitted migration/permission-boundary work, approved rollback scope, project validation rules. Planner chooses Critical; host enforces the minimum. Preparation identifies interacting authorization/data invariants and an unresolved architectural assumption, requests escalation, and receives planner-owned Exceptional revision. A planning-only approach and fresh independent challenge resolve the concern or return incomplete. Only a ready challenged contract is delivered. Builder evidence includes failure/rollback paths. Final QA independently checks adversarial and migration invariants; missing mandatory recovery verification blocks or requires an authorized explicit waiver, never an ordinary pass.

### S3 — Resumed branch build

Inputs: frozen admission, retained depth decision, contract revision 2/digest C, prior evidence and branch/source identity. Validate relevant inputs; ordinary implementation edits do not regenerate C. Repair materialized files if needed. A resumed/replaced Builder in the actual worktree receives full ticket/checklist/C and a new receipt after continuity/compaction. Builder evidence remains bound to C and current source. Final reviewer starts fresh in the new snapshot. A stale old-workspace receipt or remembered conversational checklist cannot satisfy delivery.

### S4 — Synthetic work

Inputs: immutable synthetic work ID, frozen approved plan/preflight scope, explicit unticketed authorization, full project rules. Planner assesses actual risk rather than trusting the synthetic Low placeholder and chooses Standard or higher. Preparation derives concrete checks traceable to the approved scope, retaining broad source requirements as covered rather than deleting them. Builder receives the synthetic identity and contract digest D. Evidence and final QA bind that same identity; no ordinary ticket aliases it and no unrelated scope appears. Completion uses existing synthetic finalization with contract/source authority.

### S5 — Unavailable verification environment

Inputs: approved service behavior, mandatory integration check needing Docker/service access, host and provider capability observations. Planner chooses the warranted level. If capability is required to investigate a material premise or start implementation, preparation blocks. If only final verification needs it, preparation may publish with an explicit final-verification dependency and deliver digest E. Builder can implement and report unit evidence plus the blocked integration check. Final review reports blocked/not-run, cannot issue pass, and identifies restore-capability/approved-equivalent/authorized-waiver options. Metrics record environment blocking and permitted implementation accurately.

### S6 — Mid-run contract amendment

Inputs: admitted scope, delivered revision 1/digest F, in-flight Builder or review, and a relevant authorized rule/requirement clarification. Suspend new dispatch, retain in-flight results against F, validate authority and whether approval/admission changes are needed. Publish revision 2/digest G with check diff, applicability and evidence reconciliation. Carry unchanged valid evidence explicitly; rerun affected checks. Renew Builder delivery if implementation continues. Invalidate incompatible unconsumed pass and review basis; fresh final QA reviews G/current source. Old evidence labeled F cannot silently complete G.

### S7 — Exact QA-only recovery/interrupted finalization

Inputs: retained review/certificate/recovery packet, bound revision/digest and source/basis, frozen run mode. Route recovery before preparation/preflight. Valid binding reuses the exact contract and preserves findings/history. Stale/corrupt binding yields an explicit recovery decision and no normal Builder/preparation replay; authorized fresh review uses a reconciled basis without claiming prior prebuild delivery. Legacy records are marked and follow the frozen legacy authority. Interrupted finalization consumes only a still-valid original certificate/waiver. Assert zero Builder preflight, proposal, implementation, and normal preparation calls in each variant.

## 10. Requirement traceability

The implementation agent must replace planned evidence with actual files/test results before declaring the task complete. Every row refers to the numbered requirement in the source document.

| Requirement | Implementation task and design section | Acceptance evidence |
|---|---|---|
| R01 Correct builds and predictable expectations | P0/P7; sections 2, 8 | T20; matched baseline, quality samples, cost/time, unchanged QA standards |
| R02 Durable shared contract | P2/P4/P5; section 3 | T10/T12/T16; persisted same revision supplied to Builder/final QA |
| R03 Planner selects depth | P2/P3; sections 2.2, 3.1 | T03/T04/T23/T30; planner provenance through generation/import/recovery |
| R04 Five meaningful levels | P3; sections 2.2–2.3 | T05; distinct obligations, required highest-level independent challenge |
| R05 Complete baseline at all levels | P2/P3; sections 3.2, 4.3 | T06/T07; exhaustive inventory mapping at every depth |
| R06 Explainable selection/minimums | P3; section 2.2 | T04; planner-owned revisions/minimums/no cost-only downgrade |
| R07 Adaptive bounded preparation | P3; section 2.3 | T05/T21/T24/T29; finite rounds/time, no implementation or unauthorized expansion |
| R08 Complete authoritative inputs | P1/P2/P3; sections 2.1, 3.2 | T01/T06/T13; full inputs, provenance/conflict handling |
| R09 Builder input consistency | P1/P4; sections 4.2, 5.2 | T01/T10/T11; ordinary/branch/resume use shared delivery |
| R10 Synthetic/nonstandard work | P3/P4; sections 3.1, 4.2, S4 | T03/T11; frozen scope concretized, all dispatch callers guarded |
| R11 Dedicated preimplementation phase | P3/P4/P6; section 4 | T11/T18/T21; ordering/read-only/QA-only boundary |
| R12 Shared ordinary/branch orchestration | P3/P4; sections 2.1, 4.2 | T11/T22; both modes use actual shared services |
| R13 Project QA bundle-loss fix | P1; section 5.1 | T02; ignored compiled bundle active in actual snapshot reviewer |
| R14 Effective rules/skills consistent | P1/P3/P5; sections 3.2, 5.1 | T02/T13/T15/T27; provenance and dispatched digest agree |
| R15 Misleading QA prompts fixed | P1; section 1 | T01/T15; accurate instructions and separate review session |
| R16 Structured schema/stable IDs | P2/P5; section 3.2 | T06/T08/T14; separate obligation/applicability/timing/history |
| R17 Actionable checks | P3; sections 3.2, 4.3 | T06/T07; concrete methods/outcomes and semantic assessment |
| R18 Scope protection/omissions | P3/P5/P6; sections 2.1, 5.4 | T07/T17; authority/disposition and new preference classification |
| R19 Host coverage plus semantic assessment | P2/P3; section 4.3 | T06/T07; both readiness layers required, no self-waiver |
| R20 Early prerequisites/baseline | P3; section 4.4 | T09/T21; timing/source defects/capability distinction |
| R21 Unavailable mandatory verification | P3/P5; sections 4.4, 5.3 | T08/T09/T16; blocked/not-run/waived distinguished |
| R22 Effective Builder presentation/receipts | P4; section 5.2 | T10/T21/T25; actual access/session receipt and completion-version binding |
| R23 Evidence mapped to checks | P4/P5; section 5.3 | T11/T16; concise structured Builder claims independently assessed |
| R24 Independent source-bound final QA | P5; section 5.3 | T15/T16; fresh session, current source, existing protections |
| R25 Structured final coverage | P5; section 5.3 | T08/T16/T26/T28; all mandatory outcomes before certificate issue/consume |
| R26 Newly discovered findings | P5/P6; section 5.4 | T17; defects valid, omissions recorded, new scope authorized |
| R27 Remediation/Manager guidance | P4/P5/P6; sections 4.2, 5.4 | T11/T17; existing history/bindings/control verification preserved |
| R28 Recoverable idempotent lifecycle | P2/P4/P6; sections 3.3, 4.5 | T12/T18/T19/T26/T29; crash/lease/recovery behavior without duplicate dispatch |
| R29 Precise freshness/amendments | P6; section 5.4 | T13/T14; implementation stays valid, relevant changes reconcile |
| R30 Failed/stale preparation explicit | P3/P6; sections 2.3, 3.3, 4.3 | T04/T06/T12/T13; typed errors, bounded repairs, no fallback bypass |
| R31 Proportionate/operationally safe | P1/P3/P4; sections 2.3, 4.4, 5.1–5.2 | T02/T05/T21; limits, permissions, safe artifacts, context capacity |
| R32 Quality-aware measurement | P0/P7; section 8.2 | T20/T31; stable denominators, costs, defects/reopens/samples, bias limits |
| R33 Rollout/compatibility | P2/P6/P7; sections 4.5, 8.1 | T18/T19/T30; frozen policy, deliberate legacy behavior, no receipt invention |
| R34 Meaningful regression tests | P1–P8; section 7 | T01–T31 and affected existing suites with actual results |
| R35 Existing foundations/callers | P0–P8; sections 1, 6 | Audited caller matrix; affected-module integration and tests |
| R36 Executable complete plan | This document; P8 | Traceability completed; S1–S7 validated; deviations justified |

## 11. Material risks and bounded implementation decisions

Core product policy is decided above. The builder must resolve these code-level questions during P0, record the chosen implementation, and preserve the stated acceptance criteria:

- Provider startup/acceptance: identify enforceable mechanisms for the actual Builder session on both supported providers. If session/permission APIs cannot support the proposed handshake, redesign delivery within their documented capabilities. Do not declare a separate preparer acknowledgment equivalent to Builder receipt or enable enforcement without tested access/version guarantees.
- Protocol evolution: choose a tagged newer review-basis/coverage/certificate format or a strict contract-binding extension. Keep old recovery authorities distinguishable and do not change digest meaning in place.
- Existing source exclusions: place projections and receipt artifacts where current snapshot/source-capture code can reliably exclude them without hiding product files. Verify this before delivery integration.
- Planner revision publication: carry depth metadata through approved slices and frozen work with explicit linked decisions. Existing retained-ticket spreads/publication logic must not preserve stale metadata or alter scope digests unintentionally.
- Cost/latency and correlated semantic errors: use bounded investigation, cached valid artifacts, separate assessments, and quality samples. Evaluate the initial ceilings on real work; failure to finish at a ceiling is incomplete preparation, not lower risk.
- Secrets and project-specific skills: deliver only safe effective content with provenance; unsupported or unsafe required context produces a diagnosed decision. A missing skill must not silently reduce verification obligations.
- Migration concurrency: use existing workflow lease and operation conflict semantics. Add schema fixtures for every supported legacy recovery boundary; do not fix one path by restarting an unrelated run.
- Evaluation evidence: the initial rollout sample cannot prove general improvement across rare critical failures. Report uncertainty and continue quality monitoring; do not promise consistent success from preparation alone.

### 11.1 Audit closure checklist

Before handing off or declaring implementation complete, verify the nine audit findings are closed with source and behavioral evidence:

| Audit finding | Required plan implementation | Required regression evidence |
|---|---|---|
| Write-enabled planning/startup bypass | Sections 4.2.1 and 5.2; P0/P3/P4 | T24, including pre-execution denial for every named direct path |
| Mid-turn native compaction gap | Section 5.2.1; P0/P4/P6 | T25 for each claimed supported provider |
| Circular/underspecified digest and publication ordering | Sections 3.2.1 and 5.3.1; P2/P5/P6 | T26, immutable predispatch basis and atomic result/certificate binding |
| Planner metadata lost through explicit materialization | Section 3.1; P2/P3 | T23, actual initial/revised proposal-to-population pipeline |
| Separately reloaded final checklist | Section 5.1; P1/P5 | T27, actual prompt and basis use identical frozen checklist |
| Scoped dispositions mistaken for existing waiver authority | Section 5.3.2; P2/P5/P6 | T28, real persisted authority and waived completion distinction |
| Budget reset across retry/restart/generation | Section 2.3 and budget store; P2/P3/P6 | T29, downtime and reservation recovery included |
| Undefined config defaults/precedence | Section 8.1.1; P2/P3/P7 | T30, planner-before-run and QA-disabled combinations included |
| Unspecified omission/usefulness metric classification | Section 8.2.1; P5/P7 | T31, persisted evidence, unknown causes and sampling included |

This checklist supplements the R01–R36 traceability table. None of these gaps is closed by adding only a prompt, type, telemetry label, or post-execution mutation detector.

The final implementation handoff must state what changed, actual tests/checks and results, supported legacy/provider behavior, recovery procedures, policy defaults, remaining material limitations, and a completed requirement-to-code/test matrix. No required task is complete solely because its prompt text or type definition exists.
