The planner should choose the preparation depth for each ticket, while every depth must give the Builder a complete account of the applicable requirements. Depth should change how extensively QA investigates and validates that account—not whether important requirements are disclosed.

I recommend starting with five levels and letting the implementation planner refine them based on measurable differences in usefulness. The following is a standalone handoff for that agent.

---

Plan the implementation of **QA preparation before Builder execution in Rafi**.

The objective is to maximize consistent Builder success by giving the Builder a complete, actionable description of what QA will verify before implementation begins. The project planner must select the appropriate preparation depth for each ticket. Preserve independent post-build QA, source-bound completion checks, and the existing approval and work-admission protections.

Produce a thorough implementation plan grounded in the current codebase. Do not implement changes yet. Investigate the relevant orchestration, ticket generation, role configuration, persistence, recovery, and QA paths before proposing the final design.

The requirements below include the findings and fixes from the preceding investigation.

1. **Define success around correct builds and predictable expectations.**

   Optimize for Builders satisfying the approved requirements on the first QA review, with fewer avoidable remediation cycles and fewer surprises about verification expectations.

   Success must not come from weakening QA, reducing required checks, narrowing approved scope, or treating missing evidence as passing. Measure both build quality and the combined cost of preparation, implementation, and review. Do not promise that advance preparation can anticipate every implementation defect.

2. **Introduce a durable, shared verification contract.**

   Before the Builder starts implementation, create an authoritative verification contract describing the requirements, expected behavior, checks, prerequisites, and evidence that will govern QA.

   The Builder and final QA reviewer must receive the same contract version. The contract must be a persisted, structured artifact, with a human-readable rendering. It must survive process restarts, retries, worktree recovery, and session changes; it cannot exist only in an agent’s conversation.

3. **Make the project planner responsible for selecting preparation depth.**

   The planner that defines or decomposes the work must assign a QA preparation depth to each ticket, including a concise justification and the risk factors supporting that choice.

   Identify the actual planner and ticket-generation entry points in Rafi and determine where this decision belongs. Do not quietly transfer the decision to the Builder or final reviewer.

   For existing tickets, imported tickets, synthetic work, and other work that lacks this selection, define an explicit planning fallback before implementation starts. A missing selection must not silently produce minimal preparation.

   Use Standard preparation as the initial policy for ordinary work. The planner may select a lower level with an explicit low-risk justification, or a higher level based on risk and uncertainty. Standard is a starting policy, not a substitute for assessment or a ceiling on investigation. Missing risk information must trigger assessment rather than automatically being interpreted as low risk.

   Record the planner's selection, rationale, applicable policy version, and any host-enforced minimum alongside the ticket or its authoritative planning record. Preserve these decisions through ticket generation, import, work admission, and recovery. Identify how the planner is invoked when existing work has no usable depth decision.

4. **Use five preparation levels as the starting design.**

   Refine the names and boundaries if investigation supports a better taxonomy, but preserve meaningful, enforceable differences between levels.

   | Level | Intended work | Expected preparation |
   |---|---|---|
   | 1 — Focused | Narrow, well-understood, low-risk changes | Resolve all applicable requirements, identify relevant checks and commands, confirm prerequisites, and define expected evidence. |
   | 2 — Standard | Ordinary feature work and bug fixes | Level 1 plus relevant code and test inspection, behavior-to-check mapping, important edge cases, and a concrete verification sequence. |
   | 3 — Extensive | Changes involving multiple components, significant state, or uncertain behavior | Level 2 plus cross-component interactions, negative cases, failure paths, regression risks, and compatibility concerns. |
   | 4 — Critical | Security, permissions, migrations, concurrency, deployment, or similarly consequential changes | Level 3 plus explicit invariants, adversarial cases, recovery and rollback expectations, and deeper review of affected boundaries. |
   | 5 — Exceptional | Broad architectural work, substantial ambiguity, or several interacting high-risk concerns | Level 4 plus focused independent challenge of the proposed approach, resolution of material uncertainties, and a coordinated verification plan across affected components. |

   A short ticket may still need a high level. A long ticket does not automatically require one. These levels must describe useful investigation, not merely larger token budgets.

   At Level 5, require a focused independent challenge of the proposed approach before implementation. Define who performs the challenge, what inputs they receive, how material concerns are resolved, and what evidence records completion. A documented equivalent assessment may satisfy this obligation if the plan defines its equivalence and preserves independence. Do not make this Level 5 obligation an optional step hidden behind general budget language.

   Compare four- and five-level designs explicitly. Retain five levels only if their investigation obligations, readiness criteria, and escalation boundaries are meaningfully distinct. If the implementation plan recommends four levels, map every obligation in this table into the replacement policy, including the highest-level independent challenge. Do not reduce requirement completeness when consolidating levels.

5. **Keep the requirements baseline complete at every level.**

   Every level must capture all applicable approved acceptance criteria, required tests, project validation requirements, effective role instructions, and relevant existing invariants.

   Lower depth must never mean omitting requirements that QA will later enforce. Higher depth should uncover implications and investigate uncertainty more thoroughly.

   Separate completeness of the requirements list from depth of investigation. Both must be assessed before the contract is ready.

6. **Make depth selection explainable and enforce minimums.**

   Assess factors including security exposure, permission boundaries, data integrity, migrations, compatibility, external dependencies, concurrency, retries, state transitions, deployment effects, user-facing consequences, test coverage, ambiguity, and breadth of affected components.

   Define host-enforced minimum preparation levels for consequential categories where appropriate. An agent’s unsupported declaration that work is “simple” must not bypass those minimums.

   Allow preparation to recommend a higher level when it discovers additional risk. Record any changed selection and its reason. Any downgrade must preserve applicable minimums and be explainable.

   The planner owns the authoritative depth decision and any revision. The QA preparer may report new risks and recommend escalation, but must not silently replace that decision. Define a bounded automatic path that routes the evidence to the planner, applies host-enforced minimums, records the revised selection, and continues within already authorized scope. Routine escalation within that scope must not introduce a new user-confirmation gate.

   A host-enforced minimum may prevent dispatch at an insufficient level while the planner updates its decision. Define the outcome when the planner is unavailable or fails to respond: preparation remains explicitly incomplete or recoverable rather than silently proceeding at a lower level.

   Only the planner may authorize a downgrade under the applicable policy. Record the evidence supporting it, retain the decision history, and revalidate obligations and coverage. Expense, exhausted budget, provider failure, or incomplete preparation are not evidence that the work is lower risk.

7. **Allow adaptive preparation without endless planning loops.**

   Start at the planner-selected level, then expand investigation when concrete evidence reveals unresolved risks or missing requirements.

   Define completion criteria, budgets, and escalation conditions for each level. Budget exhaustion must produce an explicit incomplete or blocked result with remaining uncertainties, rather than an apparently complete contract.

   At Level 5, perform the required focused independent challenge, which may examine a Builder-authored approach proposal. At other levels, use a focused approach review when the selected policy or concrete uncertainty warrants it. Avoid repeated open-ended debates between agents.

   Define a bounded number of planning, challenge, and repair rounds, with explicit exit criteria. An approach proposal is planning only and must not start implementation. A challenge may clarify verification and identify risks; it must not silently expand approved product scope or dictate incidental implementation choices. Unresolved material concerns must produce a concrete incomplete or blocked outcome with the required next action.

8. **Build preparation from the complete authoritative inputs.**

   Use the full ticket definition, relevant approved plan, acceptance criteria, required tests, dependencies, likely files, notes, rollback expectations, source references, project configuration, validation checklist, effective role instructions, and relevant skills.

   Distinguish authoritative requirements from helpful context and inferred risks. Define precedence when sources conflict.

   Do not derive the contract solely from a ticket title, summary, generated progress document, or abbreviated queue entry.

9. **Fix the current differences in Builder input across execution paths.**

   The investigation found that ordinary builds, initial branch builds, and resumed branch builds do not receive equally complete requirements.

   Ordinary Builder instructions do not consistently inline the full assigned ticket and QA checklist. Initial branch instructions include acceptance criteria and required tests but omit other ticket context and the project checklist. Branch resume instructions do not repeat acceptance criteria and required tests.

   Provide a shared mechanism that supplies the full applicable contract and necessary ticket context in every path. Resuming work must not depend on the previous session remembering requirements.

10. **Include synthetic and other nonstandard work.**

    Synthetic work currently can have broad requirements such as satisfying the approved plan and running relevant validation.

    Translate that approved scope into concrete, traceable checks before implementation. Preserve the existing frozen work identity and admission protections. Synthetic work must not acquire unrelated scope or alias an ordinary ticket.

    Investigate every entry point capable of dispatching Builder implementation and define how preparation applies to it.

11. **Add a dedicated QA preparation phase before implementation.**

    The existing Builder preflight is Builder-authored planning, not QA-authored requirements preparation. Add a distinct phase with explicit inputs, outputs, status, and readiness criteria.

    Identify the correct ordering among work approval, admission, preparation, optional Builder approach review, and implementation. Preparation must respect existing authorization boundaries and must not itself grant approval to implement new scope.

    The phase should inspect and plan without making product changes or starting implementation.

    Distinguish this normal preimplementation sequence from exact QA-only recovery and interrupted finalization. Those paths must preserve their existing recovery boundary and must not accidentally invoke Builder preflight, approach generation, or implementation dispatch. Specify where preparation is required for new work and how already-started work is handled without replaying an earlier lifecycle phase.

12. **Share orchestration between ordinary and branch builds.**

    Use a shared preparation service or equivalent common abstraction for both execution modes.

    Avoid separate prompt-only implementations that gradually diverge in checklist handling, depth selection, persistence, or readiness checks. Enumerate mode-specific differences and isolate them behind clear interfaces.

    Ensure all dispatch paths enforce the same requirement that an applicable contract exists before implementation starts.

13. **Fix the confirmed project QA role configuration issue.**

    The investigation reproduced a case where the main workspace loaded an ignored project-specific `.rafi/compiled/qa` bundle, while the disposable QA snapshot lacked that bundle and loaded the library fallback.

    Trace the interaction between `loadRoleBundle`, QA runtime resolution, snapshot creation, and `.rafi` exclusion. Ensure preparation and review use the intended effective project QA instructions.

    Prefer explicit, provenance-tracked delivery of effective configuration. Do not solve the problem by indiscriminately copying ignored files, secrets, mutable control state, or the entire `.rafi` directory into QA snapshots.

14. **Keep effective instructions and skills consistent and auditable.**

    Record the effective role instructions, relevant skills, project checklist, and configuration used to generate a contract and perform its review.

    Resolve project-specific configuration deliberately and detect relevant changes. Preparation and review must not silently use different fallback rules.

    Account for meaningful differences between Builder and QA role packs. Any requirement QA can enforce must be represented in the Builder’s contract or explicitly supplied applicable rules; it must not remain hidden in reviewer-only context.

    Preserve appropriate differences between planning, implementation, and review responsibilities.

15. **Correct misleading prompts about QA execution.**

    Initial and resumed branch instructions currently say QA will happen in the same Builder session, although the active workflow uses independent QA.

    Correct that wording and inspect other prompts for similar inaccuracies, including language that presents independent review as Builder self-review.

    Explain the actual phases and the Builder’s responsibility for implementation and evidence accurately.

16. **Define a structured contract schema with stable check identities.**

    Each check should have a stable identifier, clear expected behavior, requirement source, verification method, applicability, required evidence, and obligation category.

    Represent obligation and applicability as separate dimensions. Obligation distinguishes mandatory checks from advisory checks. Applicability distinguishes unconditional checks from checks activated by an explicit condition. A conditional check may be mandatory; it must not lose its blocking status because it is conditional. Advisory suggestions must not silently become completion blockers.

    Each conditional check must identify its activation predicate, the evidence needed to evaluate it, and the role responsible for evaluating it. Record applicability as applicable, not applicable, or unresolved. Unresolved applicability cannot silently become not applicable; resolve it before a mandatory completion decision. If implementation choices activate a condition, require the corresponding check and preserve the applicability evidence.

    Represent check timing separately: preimplementation readiness, postimplementation verification, or both. Where useful, include expected baseline state and dependencies between checks. A requirement to create a test or fix existing behavior must not be mistaken for a requirement that the final result already exist before implementation.

    Include ticket identity, preparation depth and rationale, contract version, lifecycle status, input provenance, relevant digests, unresolved questions, and prerequisite results.

    Distinguish the contract schema version, immutable contract revision or content digest, and depth-policy version. Include provenance for planner selections and changes, baseline observations, authorized dispositions, and delivery records. Define how stable check identities survive revisions and how materially changed or removed checks retain traceable history.

    Avoid relying on free-form string lists as the sole machine-readable representation.

17. **Make every check actionable for the Builder.**

    Describe observable behavior and a practical means of verifying it. Identify relevant commands, working directories, test locations, manual procedures, fixtures, or environment setup where known.

    Cover applicable happy paths, invalid inputs, boundary conditions, failure behavior, authorization, persistence, compatibility, and regressions.

    Separate the expected outcome from an implementation suggestion. Let the Builder choose the implementation unless the approved requirements or existing architecture impose a constraint.

    Avoid vague checks such as “make it robust” or “ensure security” without a concrete expectation.

18. **Preserve the approved scope while surfacing omissions.**

    Preparation may derive necessary checks from approved requirements and existing invariants, but must not silently expand the product request.

    Label explicit requirements, derived checks, existing invariants, ambiguities, and proposed new requirements separately.

    When preparation discovers conflicting requirements or a consequential unresolved decision, follow the existing authority and approval rules. Resolve routine implementation choices autonomously when already authorized. Do not introduce unnecessary confirmation gates.

19. **Validate contract completeness in host code.**

    The host must validate schema, identities, required fields, references, applicability, and coverage before declaring the contract ready.

    Separate deterministic host validation from semantic preparation review. Host code must enforce machine-checkable rules such as schema validity, unique identities, resolvable references, declared coverage, required fields, legal states, depth-policy obligations, and applicability records. Agent review must assess semantic issues such as whether checks meaningfully represent requirements, whether expectations conflict, and whether descriptions are actionable or unsupported. Identify the owner, evidence, and readiness consequences of each assessment.

    Every acceptance criterion and required test must map to an actionable check or an explicit explanation that prevents silent omission. Include the project checklist and applicable depth obligations in coverage validation.

    An explanation that a requirement is difficult, ambiguous, unavailable, or uncovered does not satisfy it. Such a requirement remains unresolved until an actionable check or an authorized disposition addresses it. Any waiver, supersession, or scope amendment must reference the applicable authority and be preserved in the contract history. The preparation agent cannot approve its own omission by supplying an explanation.

    Use deterministic validation and semantic review together to detect duplicate, contradictory, unsupported, or unusably vague checks. Structural validation must not be presented as proof that the agent discovered every relevant requirement. Semantic review must produce explicit conclusions and unresolved concerns rather than a blanket claim of completeness. Neither layer may silently bypass the other when it is required for readiness.

20. **Run useful prerequisite checks before implementation.**

    Move or reuse applicable prerequisite checks early enough to identify predictable blockers before the Builder spends time implementing.

    The current checker provides bounded, nonmutating checks derived from certain required-test strings, including tool availability, dependencies, lockfiles, Docker, and limited connectivity. Retain that behavior where useful, while assessing whether structured prerequisite declarations are needed.

    Distinguish missing environment capabilities from source defects. Do not automatically install dependencies, provision services, or alter infrastructure without existing authorization.

    A successful host check must not imply that the Builder or QA provider sandbox has the same capability.

    Evaluate readiness requirements in the environment and at the phase where they matter. Distinguish an existing capability needed to begin work from a capability needed only for final verification, and distinguish both from a product artifact the ticket requires creating. Define whether a final-verification blocker prevents implementation or permits implementation with an explicit unresolved verification dependency; do not leave that decision to an accidental parser result.

    Where practical, run relevant bounded checks against the preparation baseline and record existing failures, intentionally failing tests, and unavailable checks. Preserve enough command, runtime, source, and outcome information to distinguish a regression from a pre-existing condition. Baseline collection must not require exhaustive full-suite execution for every ticket or mutate product files.

    A missing test that the ticket requires creating, or a source defect the ticket requires fixing, is not automatically an environmental readiness failure. Record the expected transition from baseline to completed behavior. Pre-existing failures do not automatically excuse final failures; define their relevance to the approved work and the disposition needed for completion.

21. **Define explicit handling for unavailable mandatory verification.**

    Represent passed, failed, not run, blocked, and not applicable outcomes distinctly.

    Mandatory checks cannot pass because they could not be executed. Define the permitted resolution: restore capability, use an approved equivalent verification method, obtain an existing authorized waiver, or leave completion blocked.

    Preserve evidence explaining the limitation. Conditional checks marked not applicable must include the applicability reasoning.

    An activated mandatory conditional check follows the same completion rules as an unconditional mandatory check. Unknown applicability or an unexecuted mandatory check cannot be represented as a pass. Preserve the distinction between not applicable, not run, blocked, and failed in host validation, Builder evidence, QA reporting, and pass-certificate issuance.

22. **Give the Builder an effective contract presentation.**

    Present the applicable requirements and checks clearly before implementation, including prerequisites and expected evidence.

    Keep the presentation usable within context limits. Provide durable access to the complete contract and repeat essential requirements at relevant session boundaries.

    Do not truncate away mandatory requirements, activation conditions, or blocking prerequisites. A successful dispatch is not sufficient evidence that the Builder actually received the authoritative contract.

    Define a testable contract delivery mechanism. Before each implementation session is allowed to proceed, the host must record the work and run identity, contract revision and digest, delivery method, provider session identity, and workspace identity. Confirm that the contract supplied in the prompt or referenced artifact is accessible in that session's actual workspace. Define the acknowledgment or receipt used to establish the version the session is working against.

    Bind the Builder's completion handoff and subsequent QA request to that delivered contract version. A missing, inaccessible, stale, or mismatched contract must produce an explicit repair or recovery outcome. Do not accept evidence against one version as completion of another without deliberate reconciliation and validation.

    Renew delivery records when a session is replaced, resumed in a changed workspace, or supplied an amended contract. Durable delivery and version checks establish what was supplied; do not claim they prove that the agent understood every requirement. Keep the mechanism lightweight enough that it does not become a separate implementation exercise for the Builder.

23. **Collect evidence against contract checks.**

    Require the Builder’s completion handoff to map each applicable check to implementation and verification evidence.

    Evidence may include commands and outcomes, test references, relevant code locations, and documented manual observations. Keep it concise and structured.

    Treat Builder evidence as a claim to assess, not an automatic QA pass. Avoid unnecessary evidence bureaucracy for straightforward checks.

24. **Preserve independent final QA and source-bound completion.**

    Final QA must independently inspect the completed work, evaluate the contract, and rerun relevant verification where possible.

    Preserve disposable review snapshots, read-only restrictions, source mutation detection, review freshness checks, and pass-certificate or explicit-waiver completion gating.

    A preparation result must never count as a final QA pass. A Builder’s checklist completion must never replace independent review.

    Bind the review to the actual implementation state and the contract version used.

    Final QA must start in a fresh provider conversation for the disposable review snapshot. Do not continue the preparation conversation as the final reviewer, reuse the Builder conversation, or move an old provider session into a new snapshot directory. Preserve existing provider-session identity and snapshot validation rules.

    Supply preparation results as versioned artifacts with provenance, not as inherited conversational authority. The final reviewer may inspect the preparation reasoning but must independently assess the implementation and evidence. Define distinct phase instructions and session identities for preparation and final review while preserving consistency of applicable requirements, project rules, and skills.

25. **Require structured final coverage of the contract.**

    Final QA should report a result for every applicable contract check, with supporting evidence or a reason verification was unavailable.

    Prevent a generic success verdict from masking missing mandatory coverage. Reconcile contract coverage with the existing QA report protocol and pass-certificate rules.

    Host completion checks must require a resolved applicability decision and an acceptable verification result or authorized disposition for every applicable mandatory check. Coverage records must reference the reviewed contract revision and source state. A generic pass marker, an advisory-only success report, or a report with missing check identities cannot substitute for the required coverage.

    Preserve the reviewer’s ability to discover defects beyond the advance plan.

26. **Handle newly discovered findings without moving the goalposts.**

    Classify post-build findings as failures of existing contract checks, defects violating approved scope or existing invariants, preparation omissions, proposed new requirements, or advisory improvements.

    Genuine defects remain valid even if preparation missed them. Conversely, a new product preference must not silently become a blocking acceptance requirement.

    Define how findings become remediation instructions or contract amendments. Record omissions so preparation can improve.

27. **Integrate remediation and Manager guidance.**

    Preserve the existing detailed QA-to-Builder remediation handoff and source/review bindings. Attach contract check identifiers to findings wherever applicable.

    Retain current findings, relevant history, and structured remediation expectations. Distinguish clarification of an existing requirement from an authorized scope change.

    Integrate Manager guidance and its independent verification without conflating it with QA preparation. Guidance must not bypass contract validation or silently rewrite completion criteria.

28. **Persist a recoverable, idempotent lifecycle.**

    Define states such as preparation required, preparing, incomplete, ready, implementing, reviewing, and remediation required, or map equivalent states onto the existing lifecycle.

    Identify the authoritative records and transitions. Recover safely from crashes between generation, validation, persistence, and dispatch.

    Retries must not duplicate work admission, create conflicting authoritative contracts, or launch multiple Builders for the same work. Concurrent preparation or recovery must have defined ownership and conflict handling.

    Preserve the contract and essential context through branch resumes and session changes.

    Name exact QA-only recovery and interrupted QA finalization as separate lifecycle cases. Preserve the existing disabled-Builder boundary in those cases: no Builder preflight, approach proposal, implementation dispatch, or unrelated preparation replay may occur merely because recovery is invoked.

    Reuse the contract already bound to the interrupted review when it remains valid. If a relevant change prevents reuse, enter an explicit recovery decision that preserves the existing authoritative state and history. Do not silently replace the contract, discard the review, or fall through into a normal build sequence. Define how legacy recovery records without a contract are handled and when fresh review or an authorized disposition is necessary.

29. **Define precise freshness and invalidation rules.**

    Bind contracts to the relevant approved ticket, plan, checklist, effective instructions, skills, and preparation baseline.

    Ordinary Builder implementation changes must not invalidate the contract simply because source bytes changed. Relevant upstream changes, changed requirements, changed rules, or altered assumptions may require revalidation or preparation.

    Define targeted refresh where safe, and version any amendment. The Builder and reviewer must never silently use different contract versions.

    When a contract changes during a run, reconcile the amendment with delivered Builder versions, applicability decisions, existing evidence, and any active or completed review. Identify which evidence remains valid and which checks require renewed work or review. Preserve prior revisions and findings. Version agreement must be established before completion rather than inferred from the latest artifact on disk.

    Integrate with existing work-admission digests, approval records, QA review basis, history, and recovery mechanisms rather than adding unrelated parallel authority.

30. **Handle stale and failed preparation explicitly.**

    Malformed output, missing coverage, conflicting inputs, provider errors, timeouts, configuration failures, and incomplete investigation must produce distinct, diagnosable outcomes.

    Define bounded retry and repair behavior. Do not silently fall back to implementation without preparation.

    Ensure recovery instructions are concrete and that completed preparation can be reused when its inputs remain valid.

31. **Keep preparation proportionate and operationally safe.**

    Use bounded investigations that satisfy the selected depth’s obligations. Reuse valid context and preparation artifacts where appropriate.

    Maintain existing read-only and tool permission boundaries. Keep secrets out of contracts, prompts, logs, and evidence artifacts.

    Use deeper investigation where risk warrants it, without requiring exhaustive repository-wide analysis for every ticket. Include context-size, latency, and provider-failure considerations in the design.

32. **Measure whether the feature improves Builder success.**

    Establish a baseline before rollout. Track first-review pass rate, remediation rounds, requirement omissions, environmental blockers, new findings outside the contract, preparation failures, and total preparation/build/review time and cost.

    Break results down by preparation level, work category, execution mode, and relevant risk factors. Account for selection bias: higher-risk tickets will naturally have different failure rates.

    Detect both underpreparation and preparation that adds cost without useful benefit. Do not use raw first-pass rate alone to judge quality.

    Include quality signals beyond the workflow's own pass verdict where observations are available: escaped defects, reopened work, and sampled assessment of contract completeness and review quality. Define observation windows and acknowledge missing or delayed outcome data. A higher first-pass rate is not improvement if it results from weaker checks or more defects escaping review.

    Define metric semantics before rollout. State what counts as a first review, how report-repair attempts differ from substantive reviews, how blocked or not-run reviews enter denominators, and how waivers, cancellations, retries, revised scope, and contract amendments are counted. Distinguish failure of preparation from failure of implementation. Keep categories stable enough that moving a failure to another phase does not manufacture an apparent success.

    Define how baseline and rollout comparisons account for work difficulty, preparation depth, provider/runtime changes, and changes to QA standards. Include a practical sampling or evaluation approach, measurable success criteria, and evidence that would justify adjusting the depth policy. Do not automatically lower standards or downgrade depth solely to improve a metric.

33. **Provide a deliberate rollout and compatibility strategy.**

    Plan the input-consistency and configuration fixes first, followed by shared contract infrastructure and preparation orchestration.

    Define behavior for legacy tickets, existing in-progress runs, old persisted records, resumed worktrees, and environments where the feature is not yet enabled.

    Use explicit rollout controls where useful. Preserve existing completion protections throughout migration. Avoid accidentally requiring every existing run to restart or regenerate unrelated planning.

    Specify compatibility for legacy QA-only recovery, interrupted finalization, and runs that began before contract delivery was introduced. Define any migration, explicit legacy status, or required fresh review without claiming those runs received advance preparation that never occurred. Rollout controls must distinguish intentionally supported legacy behavior from an accidental bypass of preparation for newly enabled work.

34. **Include meaningful regression and integration tests.**

    Cover both ordinary and branch execution, initial and resumed sessions, synthetic work, planner depth selection, minimum-depth enforcement, escalation, complete requirement delivery, and contract readiness before Builder dispatch.

    Include regression coverage for the confirmed project-specific QA bundle loss and misleading same-session assumptions.

    Test missing acceptance coverage, conditional applicability, blocked mandatory checks, prerequisite failures, malformed preparation output, stale inputs, contract amendments, recovery, concurrent ownership, and provider errors.

    Verify that implementation edits preserve a valid contract while relevant requirement changes invalidate it. Verify that final completion still requires independent QA against the current source and contract.

    Favor behavioral tests over tests that merely reproduce prompt strings.

    Add explicit coverage for planner-owned initial selection and revisions, Standard as the ordinary starting policy, justified low-depth selection, unresolved-risk assessment, host-enforced minimums, bounded automatic escalation, planner failure, and rejection of downgrades justified only by cost or incomplete work. Verify the highest-level independent challenge obligation and its completion or blocked outcome.

    Test obligation and applicability independently: unconditional mandatory checks, activated mandatory conditional checks, advisory checks, unresolved predicates, and implementation choices that activate additional checks. Ensure unresolved applicability and not-run mandatory checks cannot produce a pass certificate.

    Test deterministic coverage enforcement separately from semantic review orchestration. Verify that an explanation alone cannot waive an acceptance criterion, that authorized dispositions are traceable, and that malformed or semantically unresolved contracts cannot become ready through a blanket success response.

    Cover prerequisite timing and baseline interpretation: capabilities required before implementation, capabilities needed only for final verification, missing tests to be created by the ticket, source defects the work intends to fix, existing failing tests, and differing host/provider capabilities. Verify that known baseline failures do not silently excuse relevant final failures.

    Verify contract artifact access and delivery receipts in initial, replacement, resumed, and amended sessions. Reject missing or mismatched digests in completion evidence. Verify that the final reviewer starts a fresh provider conversation, receives the bound contract and effective project rules, and cannot reuse a preparation or Builder session as its review session.

    Add exact QA-only recovery and interrupted-finalization regressions that assert no Builder preflight or dispatch occurs. Cover valid bound-contract reuse, stale contracts, legacy records without contracts, and preservation of authoritative recovery history. Test amendment reconciliation so outdated evidence or review results cannot complete a newer contract.

    Validate telemetry classification for blocked reviews, report repairs, substantive retries, waivers, scope changes, and preparation failures. Ensure phase changes do not count the same event twice or turn unavailable verification into a first-pass success. Keep metric tests focused on observable accounting behavior.

35. **Use the existing codebase foundations deliberately.**

    Investigate at least these areas and their callers:

    - `packages/ai-foreman/src/foreman.ts`
    - `packages/ai-foreman/src/cli/start.ts`
    - `packages/ai-foreman/src/branch/runner.ts`
    - `packages/ai-foreman/src/qaReview.ts`
    - `packages/ai-foreman/src/qaProtocolV2.ts`
    - `packages/ai-foreman/src/qaSnapshot.ts`
    - `packages/ai-foreman/src/qaPrerequisites.ts`
    - `packages/ai-foreman/src/qaFailureDelivery.ts`
    - `packages/ai-foreman/src/roles.ts`
    - `packages/ai-foreman/src/buildSyntheticWork.ts`
    - Work approval, authorization, admission, interventions, and recovery code.
    - Ticket schemas, population, rendering, setup configuration, and review standards.
    - Builder and QA role definitions, instruction packs, and skills.
    - Rafi’s command integration and relevant tests.

    Confirm current behavior directly; these investigation findings are starting points, not a substitute for reading the current files. Respect existing uncommitted changes and repository instructions.

36. **Deliver an implementation plan detailed enough for execution.**

    The final plan must include the proposed architecture and sequence, depth-selection policy, contract schema, lifecycle, persistence, freshness rules, prompt changes, configuration delivery, evidence model, review integration, and migration strategy.

    Map every requirement above to an implementation task and validation method. Identify dependencies, affected files or modules, behavioral acceptance criteria, material risks, and unresolved decisions.

    Give the confirmed bugs explicit tasks and regression coverage so they cannot disappear into the broader feature work.

    Explain any recommended changes to the five-level design. Prefer decisions the implementation agent can execute without inventing essential policy later.

    Include explicit policy and acceptance decisions for planner-owned depth changes, Standard defaults, highest-level challenge obligations, obligation versus applicability, deterministic versus semantic validation, check timing, contract delivery receipts, fresh final-review sessions, exact QA-only recovery, amendment reconciliation, and quality-aware metric definitions. These audited issues must not remain implicit in broad architecture descriptions.

    Provide representative end-to-end scenarios covering an ordinary ticket, a critical ticket, a resumed branch build, synthetic work, an unavailable verification environment, a mid-run contract amendment, and exact QA-only recovery. For each, show the authoritative inputs, depth decision, preparation and readiness steps, delivered contract version, Builder evidence where applicable, review result, and permitted completion or recovery outcome.

The intended outcome is that, before building, the Builder knows the applicable requirements, how QA will evaluate them, what evidence is expected, and which prerequisites could block verification. The planner chooses how deeply QA prepares that account, and independent final QA determines whether the completed implementation satisfies it.
