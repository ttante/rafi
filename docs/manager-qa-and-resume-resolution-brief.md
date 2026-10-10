# Rafi Manager and QA Resume Resolution Brief

Prepare an implementation plan for two agreed improvements: make Rafi Manager useful for understanding and resolving repeated QA failures, and prevent builds from creating QA recovery state that their own resume system rejects.

This is a planning handoff. The product scope below is agreed; implementation design remains the planning agent's responsibility. Produce a concrete, dependency-ordered implementation plan with affected files, data contracts, migration and recovery behavior, tests, and release gates. Do not implement changes as part of the planning task.

This brief incorporates the code audit and agreed corrections from October 9, 2026. The requirements and acceptance scenarios include those corrections; they are not optional follow-up work.

## Agreed outcomes

Users must be able to ask Manager to show any ticket's retained QA reports from a build, understand why a ticket keeps cycling between Builder and QA, discuss a resolution, and direct Builder, QA, or both toward that resolution. Manager must report whether instructions were actually delivered and whether subsequent verification resolved the issue.

Rafi must save consistent build and ticket ownership before work begins. Every review, report, and recovery packet must refer to work admitted to that build. Interrupted work must remain recoverable without discarding code or evidence. Existing inconsistent records need a controlled reconciliation path.

Preserve these established behaviors: approved unchanged work can continue without repeated approval, and eligible independent tickets can continue when another ticket is blocked, subject to the run's frozen policy. Discussing a possible intervention is not itself an instruction to execute it; explicit user direction should authorize the corresponding concrete action without redundant confirmation.

## Findings about Manager

### Report bodies are saved but inaccessible

Validated failure reports are stored in `qa_reports.report_json`. Report occurrences identify the run, ticket, and review; content digests identify report content. The evidence store also retains report and provider-response bytes. Manager's `WorkflowReader` does not expose these bodies or a complete QA history.

Manager's evidence protocol allows only `list_runs`, `get_run_details`, `aggregate_runs`, and `compare_runs`. Run details contain diagnostic summaries and spans, not full QA reports. Provider-native tools are restricted, so the model cannot independently retrieve the missing evidence.

### Existing diagnostics do not explain one ticket's repeated failures

The `qa_rework` finding summarizes run-wide counts and time. It does not compare successive findings, Builder remediations, source changes, or verification results. The diagnostic failure count includes non-passing review outcomes such as blocked or interrupted work.

Grouping current aggregates by ticket assigns a run's metrics to each ticket in that run. This measures runs involving a ticket, not work attributable to that ticket. It must not become the basis for claims about that ticket's own QA cycles.

`loadDurableQaHistory` is remediation context, not a complete diagnostic timeline: it selects failed reviews and a successful remediation associated with each. Manager also needs unsuccessful and uncertain remediation, protocol corrections, interrupted and passing reviews, report dispositions, and verification evidence.

### Retrieval limits need redesign

Manager caps an entire packet at 48 KiB, while a valid QA failure report can be 64 KiB. Oversized packets can be replaced by a limitation notice. Only two evidence lookup rounds are allowed per question. Adding bodies to the existing packet alone cannot provide dependable complete access.

### Intervention exists in separate workflows

Manager's instructions prohibit modifying another agent session and even proposing project mutations. Its host interface has no intervention operation.

Elsewhere, the nonconvergence workflow supports retry, pause, explicit waiver, and Planner-assisted remediation. Planner receives ticket requirements, QA history, and the Builder diff; approved instructions can reach Builder. Durable human decisions accept scoped answers through `rafi build:decide`.

The report-recovery handler can save and return QA guidance, but the audit found no current execution path that consumes those instructions in a fresh QA prompt. The remaining recovery-menu calls occur when source capture or session identity is invalid, where fresh/guidance actions are unavailable. Normal report-repair exhaustion now retries a fresh review or pauses. The existing guidance test verifies the handler's returned object, not delivery to QA. Treat working QA guidance delivery as missing implementation work.

These facilities are useful foundations, but they do not provide a general Manager conversation for steering a selected ticket during a build. Recording a decision is also distinct from delivering it or resuming execution; the supervisor can exit while waiting for input.

One `runIsolatedQa` call can perform multiple reviews and Builder fixes before returning. Checking for Manager instructions only between tickets would not let the user intervene in the current ticket's cycle.

## Findings about the resume failure

The reported error was equivalent to:

```text
rafi: QA recovery packet ticket T001 is not part of run SOME_HASH
```

In `buildResume.ts`, this check follows validation that the packet matches the selected run's durable QA recovery head. The error therefore indicates disagreement between that run's saved ticket list and its QA recovery records. It does not, by itself, prove that the user selected the wrong run.

### A demonstrated creation path

A temporary characterization used the production batch selection, checkpoint, packet-persistence, and resume code, with simulated Builder and QA boundaries:

1. Start a current-branch build with an empty ticket list, as the CLI normally does.
2. Let the queue select T002 and the ticket-start callback save T002 into the build.
3. Supply a simulated successful Builder response naming T001.
4. Observe `runBatch` route QA to T001. The simulated QA boundary creates a real recovery packet for T001 and pauses.
5. Release the build as recoverable and invoke the resume command.
6. Resume emits the exact ticket-membership error. The saved build lists T002; its pending QA recovery lists T001.

No provider was called. This proves a reachable routing and persistence gap, not the cause of the user's particular incident. The affected project folder, run ID, and installed version were not supplied, so incident-specific attribution remains open. The temporary reproduction was removed; recreate it as a regression test.

### Additional confirmed routing gaps

Temporary audit probes used production queue and tracker code with simulated Builder responses and QA boundaries. No live provider was called.

| Scenario | Observed behavior |
| --- | --- |
| T002 assigned; Builder reports T001 blocked | T001 becomes blocked while T002 remains in progress. |
| Ticket queue is empty | A Builder turn still runs without admitting a ticket; QA resolves to `STEP-1`. |
| T002 assigned; Builder reports an unknown ticket | QA falls back to `STEP-1`. |

These probes establish dispatch, tracker, and QA-selection gaps; they did not run a complete provider or resume lifecycle. Deliberately authorized unticketed work must be distinguished from accidental fallback after ticket selection fails.

The branch runner routes QA using the assigned node, so it does not use the same wrong-ticket QA route. However, it currently accepts a conflicting Builder ticket marker without rejecting it. Both execution paths need identity validation.

### Missing enforcement

`Foreman.runBatch` checks a response's ticket against the selected ticket only when `recoveryTickets` is supplied. That argument also carries explicit ticket scope for some new builds. Automatically selected new builds can lack it. QA routing then prefers `status.ticket` over `pendingTicketId`.

The storage APIs for QA recovery heads, review attempts, and reducer transitions ensure the run exists but do not enforce membership in the build's ticket list. Their tables reference the run, without a corresponding authoritative run-and-ticket membership constraint. Build snapshot validation also does not enforce consistency with existing QA work.

Older current-branch runs may omit ticket membership. `inferLegacyRunTickets` tries to infer it from tracker events attributed to Foreman within the run's timestamps, and only when the saved list is empty. Missing events or partially populated lists can leave gaps. Timestamp inference alone is not reliable proof of ownership.

The repository already has QA migrations and writer-protocol guards in `qaHandbackMigration.ts`. Those distinguish protocol versions; they do not automatically prevent an older writer using the same protocol from bypassing newly added membership checks. Enforcement needs an upgrade and compatibility strategy.

## Requirements for the implementation plan

### Complete QA access

- Enumerate all tickets in a selected build and every retained QA attempt for each ticket, including resolved historical failures.
- Also expose conflicting QA records whose tickets are absent from the saved build scope. Label them as inconsistencies, not authorized membership; do not hide the evidence needed for repair.
- Retrieve report bodies and related remediation evidence using scoped identities. Identical report content across reviews, tickets, or runs must remain distinguishable.
- When asked to show a report, provide the retained body through faithful rendering or a host-provided artifact, not only a model-generated summary. Include its identity and any disclosed redactions.
- Separate validated failure reports, passing reviews, malformed responses, blocked verification, pending work, and unavailable historical evidence. Do not invent a failure-report body for a passing review.
- Use paginated or chunked retrieval with explicit completeness, omissions, and continuation information. All retained reports must be reachable even when they cannot fit in one prompt or lookup budget. Define a consistent pagination boundary while an active build adds reviews, so pages do not silently skip or duplicate attempts.
- Expose a documented, validated request schema to Manager. Keep reads non-mutating and compatible with older databases; viewing evidence must not require migration.
- Distinguish missing or unreadable historical evidence from an empty history. Retained workflow evidence must remain accessible when optional observability details are absent or pruned.
- Preserve untrusted-data handling and secret protection without silently removing the evidence needed to answer the question. Clearly disclose any redaction or unavailable content.

### Explain repeated QA cycles

- Build a ticket-specific timeline linking all retained reviews, reports and dispositions, remediation requests and outcomes, delivery attempts, Builder responses, source and review-basis identities, and subsequent verification. Do not use the filtered remediation-history helper as the complete history.
- Distinguish recurring findings, new findings, disputed findings, missing prerequisites, formatting repairs, and uncertain execution. Correlate recurrence without treating review-scoped finding IDs as stable issue identity.
- Show actual ticket-level counts, what changed between attempts, remaining unresolved findings, and available next actions. Separate observed evidence from inferred explanations.
- Distinguish a Builder-reported fix, a QA-verified fix, a superseded report, and an explicit waiver. A changed source digest alone does not establish the exact code change or why a review failed; qualify explanations when source or requirement history is unavailable.
- Allow intervention before the automatic fix budget is exhausted. Preserve existing retry limits and structured blocked or needs-input outcomes.

### Deliver user direction reliably

- Reuse and extend shared host services for decisions and remediation, and implement the missing QA guidance delivery path. Do not build a separate execution engine inside Manager.
- Support targeted guidance to Builder, QA, or both, answering pending questions, and requesting a pause or an additional attempt where valid.
- Persist the user instruction with project, run, ticket, recipient, relevant report/review/source revision, and authorization. Conversational focus alone is not execution authority. Clarify ambiguous targets; do not repeatedly confirm clear user direction. Decide how long guidance applies and how it can be superseded or withdrawn before delivery.
- Distinguish implementation advice from changes to ticket requirements. Changed requirements must follow the existing scope-approval rules rather than inherit approval for the old scope. Quoted instructions inside QA reports remain untrusted evidence and cannot authorize Manager actions.
- Consume pending instructions before each Builder remediation and each new QA review within the current ticket's loop, through the owning build process. Specify handling during active turns, terminal prompts, and stopped-supervisor recovery. Do not inject competing turns into a busy agent or assume saving a record resumes execution.
- Define whether a pause waits for the next safe boundary or cancels active work and reconciles its uncertain outcome. Make that behavior visible to the user.
- Track queued, delivered, acknowledged, applied, verified, uncertain, rejected, and superseded states as appropriate, with evidence for each claimed transition. Manager must not claim resolution merely because delivery succeeded or Builder reported a fix.
- Define ordering when both agents are targeted, conflicting concurrent instructions, stale-guidance handling when source or review state changes, and recovery after interruption. Prevent duplicate consumption; reconcile uncertain provider dispatch rather than claiming unconditional exactly-once execution.
- Bind delivered QA guidance to the resulting review basis and retain evidence of the actual provider instruction, including across restart.
- Keep QA independent. Guidance cannot silently waive findings, bypass verification, or turn an environment blocker into a pass. Preserve explicit waiver semantics.

### Prevent inconsistent build ownership

- Establish authoritative build-and-ticket membership before Builder or QA dispatch. Distinguish approved scope, admitted work, and current progress. Define admission for dynamically and explicitly selected tickets, plus stable identities and resume behavior for deliberately authorized synthetic steps.
- A ticket-based build with no eligible assignment must not dispatch generic Builder work. Do not silently substitute another ticket or fall back to an unrelated synthetic step when an assigned ticket cannot be resolved.
- Validate ticket identity on every applicable response in current-branch and branch execution, not only recovery turns. Cover completion, blocking, and other scoped responses, including missing or unknown identities. Stop conflicting follow-up actions before QA or tracker mutation; retain the response and any unexpected work for reconciliation. A post-turn check cannot undo edits already made by Builder.
- Enforce membership at persistence boundaries for QA attempts, reports, heads, packets, remediation, source/review bindings, delivery records, and finalization. Reject snapshot changes that would orphan existing work.
- Use atomic local updates and explicit reconciliation for database/file publication boundaries. Preserve one-owner execution and existing lease, revision, and uncertain-dispatch checks.
- Define schema migration, writer compatibility, import validation, and interrupted-upgrade behavior. Older binaries and direct storage callers must not silently bypass the invariant. Preserve read-only inspection and controlled repair access to existing inconsistent records.
- Audit both ordinary and branch build paths, explicit and automatic selection, current and legacy records, and all resume entry points.

### Recover existing inconsistencies

- Detect mismatches before asking the user to choose a resume mode. Explain the saved run scope, conflicting ticket, available evidence, and recovery options in plain language.
- Reconstruct missing membership only when durable provenance establishes legitimate ownership and authorization. A packet's existence alone must not expand approved scope.
- For ambiguous or genuinely conflicting ownership, preserve code and evidence and offer a controlled reconciliation decision. Do not simply append the packet ticket, delete the packet, disable the membership check, or recommend restarting from scratch by default.
- Make any migration or repair auditable, restartable, and safe to repeat. Test copied legacy data and interrupted repairs. Manager should expose this condition through the same diagnostics and recovery services.

The plan must specify a usable outcome for each case, not stop at another generic refusal:

| Evidence | Required recovery outcome |
| --- | --- |
| Authorized work occurred, but membership was not saved | Repair membership with recorded provenance, then revalidate recovery bindings. |
| Builder actually switched to another ticket | Preserve the conflicting work and evidence; reconcile what belongs to the original assignment before fresh QA. Adding the foreign ticket alone is not a repair. |
| Ownership cannot be established | Explain the uncertainty and provide a concrete operator-assisted reconciliation path with defined choices and consequences. Preserve evidence and prevent unverified replay. |

## Source map

| Area | Starting points |
| --- | --- |
| Manager runtime and restrictions | [cli/manager.ts](../packages/ai-foreman/src/cli/manager.ts), [manager-diagnostics.md](../packages/special-agents/content/agents/manager-diagnostics.md), [manager.yaml](../packages/special-agents/content/agents/manager.yaml) |
| Evidence protocol and packet limits | [projectDiagnostics.ts](../packages/ai-foreman/src/projectDiagnostics.ts), [managerPacket.ts](../packages/ai-foreman/src/managerPacket.ts), `ManagerEvidenceOperationV1` in [types.ts](../packages/spec/src/types.ts) |
| Diagnostic reads and attribution | [diagnostics.ts](../packages/ai-foreman/src/diagnostics.ts), [workflowReader.ts](../packages/ai-foreman/src/workflowReader.ts) |
| QA storage and execution | [workflowDb.ts](../packages/ai-foreman/src/workflowDb.ts), [qaReview.ts](../packages/ai-foreman/src/qaReview.ts), [qaRecovery.ts](../packages/ai-foreman/src/qaRecovery.ts), [qaFailureDelivery.ts](../packages/ai-foreman/src/qaFailureDelivery.ts) |
| QA protocol, delivery evidence, and migration | [qaProtocolV2.ts](../packages/ai-foreman/src/qaProtocolV2.ts), [qaDeliveryJournal.ts](../packages/ai-foreman/src/qaDeliveryJournal.ts), [qaHandbackMigration.ts](../packages/ai-foreman/src/qaHandbackMigration.ts) |
| Existing operator workflows | `createQaNonconvergenceHandler` and `createQaReportRecoveryHandler` in [cli/start.ts](../packages/ai-foreman/src/cli/start.ts), [humanDecision.ts](../packages/ai-foreman/src/humanDecision.ts), [cli/recovery.ts](../packages/ai-foreman/src/cli/recovery.ts), [supervisor.ts](../packages/ai-foreman/src/supervisor.ts) |
| Ticket selection and persistence | `runBatch` and `ticketForQa` in [foreman.ts](../packages/ai-foreman/src/foreman.ts), `onTicketStart` in [cli/start.ts](../packages/ai-foreman/src/cli/start.ts), [branch/runner.ts](../packages/ai-foreman/src/branch/runner.ts), [buildRuns.ts](../packages/ai-foreman/src/buildRuns.ts) |
| Ownership, recovery, and imports | [buildAdmission.ts](../packages/ai-foreman/src/buildAdmission.ts), [operationRecovery.ts](../packages/ai-foreman/src/operationRecovery.ts), [stateTransfer.ts](../packages/ai-foreman/src/stateTransfer.ts) |
| Resume validation | [buildResume.ts](../packages/rafi/src/buildResume.ts) |
| Diagnostics and decision tests | [projectDiagnostics.test.ts](../packages/ai-foreman/test/projectDiagnostics.test.ts), [qaDecisions.test.ts](../packages/ai-foreman/test/qaDecisions.test.ts) |
| Routing and resume tests | [foreman.test.ts](../packages/ai-foreman/test/foreman.test.ts), [branch.test.ts](../packages/ai-foreman/test/branch.test.ts), [buildResume.test.ts](../packages/rafi/test/buildResume.test.ts), [buildAdmission.test.ts](../packages/ai-foreman/test/buildAdmission.test.ts) |
| QA delivery and recovery tests | [qaFailureDelivery.test.ts](../packages/ai-foreman/test/qaFailureDelivery.test.ts), [qaHandbackCallers.test.ts](../packages/ai-foreman/test/qaHandbackCallers.test.ts), [qaHandbackSafety.test.ts](../packages/ai-foreman/test/qaHandbackSafety.test.ts), [qaRecovery.test.ts](../packages/ai-foreman/test/qaRecovery.test.ts), [qaProtocolV2.test.ts](../packages/ai-foreman/test/qaProtocolV2.test.ts), [qaHandbackMigration.test.ts](../packages/ai-foreman/test/qaHandbackMigration.test.ts) |

Read the existing [QA handback plan](qa-handback-implementation-plan.md), [build stall repair plan](build-stall-repair-plan.md), and [build resume gap plan](build-resume-gap-implementation-plan.md) for overlapping mechanisms and completed work. Their historical findings are not proof that a defect remains. Recheck current code and preserve unrelated changes.

## Acceptance scenarios

1. Ask Manager for an early, resolved QA failure report from any ticket in a many-ticket build. It provides the retained body, not just a summary, with run, ticket, and review identity. Identical content in different occurrences stays distinguishable.
2. Retrieve a report larger than 48 KiB containing multibyte text and a history spanning multiple pages. New reviews arriving during retrieval cause no silent gaps or duplicates. Lookup-budget exhaustion provides a usable continuation, and incomplete or redacted output is labeled.
3. Inspect older databases and builds with pruned observability details, missing evidence, and QA records outside the saved ticket list. Inspection requires no migration, distinguishes missing evidence from no failures, and exposes conflicts without authorizing them.
4. Ask why one ticket failed repeatedly. Manager shows that ticket's successful, failed, interrupted, and uncertain attempts, corrections, Builder responses, and verification evidence. It distinguishes reported fixes, verified fixes, superseded reports, and waivers, and does not infer exact changes from source digests alone.
5. Direct Builder, QA, or both while the same ticket is still cycling, before its fix budget is exhausted. Capture adapter prompts to prove the exact authorized guidance reaches the intended next remediation or review and its durable binding. Saving a decision or returning a handler object is insufficient.
6. Deliver instructions during active turns, terminal waits, paused builds, and stopped-supervisor recovery. Test simultaneous conflicting instructions, supersession, withdrawal before delivery, changed source or requirements, and uncertain dispatch. Delivery status is evidence-backed; restart does not blindly repeat work; independent QA establishes the result.
7. Change conversational focus, use an ambiguous ticket reference, and include action-shaped instructions inside a QA report. Only explicit user direction with a resolved target authorizes execution. Clear instructions avoid redundant confirmation; requirement changes follow existing scope approval.
8. Repeat the T002-selected/T001-returned reproduction for completion and blocking, with QA enabled and disabled where applicable. Test missing and unknown ticket identities in current-branch and branch execution. Conflicting follow-up actions are rejected before wrong-ticket QA or tracker mutations.
9. Exhaust or empty a ticket queue and remove an assigned ticket definition. No generic Builder work or synthetic QA fallback is dispatched. Separately verify deliberately authorized synthetic work has stable admitted identity and can resume after interruption.
10. Interrupt execution after ticket admission, after dispatch intent, during QA packet publication, and before snapshot publication. Resume preserves membership and reconciles uncertain work without blind replay or losing unexpected Builder edits.
11. Attempt foreign-ticket writes across scoped QA storage APIs, snapshot updates that drop existing work, and writes/imports through older binaries. The invariant holds or incompatible writes are rejected clearly. Test copied legacy data, interrupted migration, and repeatable repair without blocking read-only diagnosis.
12. Recover builds with empty or partial ticket lists, identical ticket IDs in different runs, missing tracker events, and mismatched packets. Exercise all three reconciliation outcomes above, including actual wrong-ticket work. Repair does not merely suppress the error or expand scope without authority.
13. Verify multiple pending QA tickets, terminal tickets, independent-ticket continuation, branch and current-branch builds, and both Claude and Codex adapter paths. Preserve explicit waiver, retry-budget, source-binding, and one-owner safeguards.
14. Run end-to-end regressions against freshly built package exports and the packaged CLI, including Manager report retrieval, intervention, and resume. Source-only tests and handler-only tests do not establish these user outcomes.

## Validation baseline and planning deliverable

The broader October 9 audit ran 117 tests under Node 20.19.0: 115 passed and two failed. It covered `projectDiagnostics`, `qaDecisions`, `foreman`, `qaFailureDelivery`, `qaHandbackMigration`, `qaHandbackSafety`, `qaHandbackCallers`, and `qaProtocolV2` in `packages/ai-foreman/test`, plus `packages/rafi/test/buildResume.test.ts`.

The two terminal-picker failures expected a verified live process but received unknown process ownership. These are the same failures observed in the earlier 53-of-55 resume/Foreman run; their cause remains unresolved. Earlier Manager diagnostics, observability, and QA decision checks passed 21 of 21. The baseline is not fully green, and these tests do not establish the proposed features or the cause of the user's incident.

The default Node 24 runtime could not load the SQLite binary compiled for Node 20. No dependencies were rebuilt. CLI source imports resolve some `ai-foreman` dependencies through compiled `dist` exports; the audit did not rebuild them. The implementation validation must build dependencies and packages deliberately before running packaged-CLI tests, so it does not mix changed source with stale compiled behavior.

The implementation plan should specify shared contracts, authoritative storage, API changes, UI behavior, recovery and migration rules, affected files, and meaningful tests for each work package. Prioritize preventing new inconsistent state and enabling complete evidence reads; sequence intervention controls behind reliable scope and delivery semantics, including the missing QA guidance path. Include a strategy for existing affected builds and remaining incident-specific investigation. Map every acceptance scenario to a work package and release check. Do not treat changing prompts, increasing packet limits, saving guidance without delivering it, or removing resume checks as a complete resolution.
