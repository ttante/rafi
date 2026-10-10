# Manager QA access and build ownership implementation plan

Resolve the outcomes in [the resolution brief](manager-qa-and-resume-resolution-brief.md) through shared workflow services: prevent unauthorized ticket routing, make all retained QA evidence accessible, recover inconsistent historical builds, and deliver explicit user direction to the owning Builder and QA processes.

This is a planning deliverable dated October 9, 2026. Runtime changes are not implemented by this document. Release requires the regression gates below; a plan or a passing test suite cannot prove the absence of every regression. The reported incident remains unattributed until the affected project, run and installed version are available.

Implementation progress and actual validation are recorded in [the implementation validation record](manager-qa-and-resume-validation.json). Admission, assignment routing, QA evidence snapshots/artifacts, audited ownership repair, ticket timelines, scoped Manager controls, and in-cycle guidance are implemented. The validation record tracks the final regression and packaged checks separately from external platform/live-provider release gates. Release readiness must be assessed from those actual results.

## Baseline behavior and preserved mechanisms

Pre-implementation source inspection established these integration points and gaps. Final behavior and validation are recorded separately above:

| Area | Current behavior | Consequence for implementation |
| --- | --- | --- |
| `Foreman.runBatch` in `foreman.ts` | Identity rejection is conditional on `recoveryTickets`; completion and blocking prefer `status.ticket`. An empty automatic queue can reach Builder. | Validate every assigned work response before scoped side effects, regardless of selection mode or QA setting. |
| `ticketForQa` in `foreman.ts` | Missing ticket resolution falls through to `STEP-${stepIndex}`. | Ticket resolution must fail explicitly; authorized synthetic work needs a separate admitted identity. |
| `cli/start.ts` ticket callback | Approval precedes a checkpoint that appends the selected ticket. | Move authoritative admission into a shared transaction; retain the approval/reselection checks already present. |
| `branch/runner.ts` | QA uses the assigned node, but conflicting response markers are accepted. | Reuse the same response validator without changing assigned-node QA routing. |
| `buildRuns.ts` | Database-first snapshots already use a publication journal and lease fencing. Legacy inference uses timestamp-bounded tracker events only when the list is empty. | Extend publication reconciliation; replace timestamp inference as execution authority with explicit provenance assessment. |
| `buildResume.ts` | Checks packet/head binding before ticket membership, and also checks pending QA protocol membership. | Preserve these checks and add pre-mode reconciliation. The error is not proof of wrong run selection. |
| `WorkflowReader` | Opens SQLite read-only; many getters return empty values on errors. | Add capability-aware QA reads with explicit unavailable/corrupt results, not a writable `WorkflowDb` read path. |
| Manager protocol | Four aggregate/run operations, 48 KiB packets, two lookup rounds. | Add scoped versioned evidence operations, stable pagination and host rendering independent of model lookup budget. |
| QA execution | `runIsolatedQa` owns several reviews and fixes inside one call. `createQaReportRecoveryHandler` returns guidance; this does not establish prompt delivery. | Place intervention boundaries inside that loop and verify exact adapter prompts. |
| QA storage | Occurrence identities, turn receipts, source bindings, reducer revisions and delivery journals already exist. Writer protocol is currently schema version 3. | Extend these mechanisms; do not replace them or assume protocol 3 guards enforce the new invariant. |

The [QA handback plan](qa-handback-implementation-plan.md), [build stall plan](build-stall-repair-plan.md), and [resume gap plan](build-resume-gap-implementation-plan.md), especially its section 13, document completed mechanisms as well as historical findings. Preserve scoped approval reuse, frozen execution scope, pending-question gates, stale-answer replacement, independent-ticket continuation, fresh-session ownership validation, unresolved-dispatch fences, source-bound pass certificates, explicit waivers, and terminal completion checks. Reproduce a defect before reopening completed work.

## Decisions and invariants

1. **Separate approval, admission and progress.** Approval authorizes scope at a requirements revision. Admission associates a stable work identity with a run before dispatch. Progress records what happened; it neither grants authority nor deletes admission.
2. **Use assigned identity throughout execution.** A response confirms its assignment; it cannot select another ticket. Missing, unknown or conflicting identity on an applicable work response becomes a structured reconciliation stop. Capture returned bytes and changed work before interpreting that response.
3. **Database state is authoritative.** Build JSON and QA packet files are revisioned publications. Commit local state atomically; reconcile publication failures without pretending SQLite and filesystem writes are one transaction.
4. **Evidence identity includes occurrence.** Address a report by project, run, work/ticket identity, review attempt and report occurrence. A content digest verifies bytes, never ownership.
5. **Inspection grants no authority.** Display conflicting historical records even when they cannot execute. Reads do not migrate databases, consume instructions, update leases or repair membership.
6. **Instructions apply once by default.** Guidance targets the next eligible remediation/review at the specified basis. Longer-lived guidance requires an explicit bounded scope and renewed validation at each delivery. This release implements one-use guidance; recurring instructions are not silently inferred.
7. **Pause is cooperative.** The default waits for the next safe boundary and does not cancel an active provider turn. Display that delay. Emergency cancellation continues to use existing cancellation/reconciliation services and must not be described as a completed pause until its outcome is known.
8. **Delivery is not resolution.** Provider dispatch, correlated acknowledgement, Builder-reported application and independent QA verification remain separate facts. Waivers remain waivers, never passes.
9. **One process owns execution.** Manager may enqueue a scoped instruction under a narrow control-write capability; it never acquires the Builder/QA role to send competing turns. Existing owner/generation/revision checks govern consumption.
10. **No silent budget reset.** Guidance does not grant another attempt. An explicit extra attempt consumes a scoped single-use authorization through the existing durable budget ledger. Blockers and unanswered questions remain structured stops.

## Shared contracts

Names below are proposed API and table names. Add public types, strict schemas and validators together in `packages/spec/src/{types,schemas,validate,index}.ts`. Keep V1 read requests compatible; do not silently change V1 interpretation.

### Admission and historical ownership

`BuildWorkAdmissionV1` contains `projectId`, `runId`, `workId`, `kind: ticket | synthetic`, optional `ticketId`, `assignmentId`, `approvalId`, `scopeRevision`, `requirementsDigest`, `admittedAt`, `admittedSequence`, and provenance references. Use a persisted project identity plus the existing canonical-root check. Copied/imported projects require explicit project rebinding through state transfer; a filesystem path alone is not portable identity.

For ticket work, enforce unique `(runId, ticketId)` membership with assignment history beneath it. For synthetic work, allocate a persisted opaque work ID and frozen definition before dispatch; a display label such as `STEP-1` is not its key. Retain a compatibility mapping if existing QA tables use `ticket_id`, and prove that a synthetic key cannot collide with a real ticket ID. Explicit unticketed mode records authorization, requirements and stable resume identity. Failed ticket lookup never enables that mode.

Proposed storage:

| Record | Purpose and constraint |
| --- | --- |
| `build_work_scope` | Registry of observed run/work identities. State is `admitted` or `quarantined`; quarantine preserves historical evidence without authorizing execution. |
| `build_work_admissions` | Immutable authorized membership, referencing scope registry and approval/provenance. Scope revision amendments are append-only. |
| `build_assignments` | Selected work, requirements/source basis, owner generation, dispatch linkage and outcome. Only admitted work may receive a dispatch intent. |
| `build_ownership_conflicts` | Saved scope, conflicting records, evidence refs, reason, affected workspace and unresolved/reconciled status. |
| `build_reconciliations` | Operator or proven-provenance decision, expected revision, choices, before/after digests, publication state and audit receipt. |

The registry permits copied legacy conflicts to remain inspectable. Composite foreign keys enforce record identity; triggers additionally require **admitted** status for ordinary insert/update operations. A foreign key to a quarantined registry row alone is not sufficient. Quarantined records may only change through a restricted reconciliation transaction that creates an audit receipt and validates its expected revision.

`assessBuildOwnership(project, run)` returns saved scope, authoritative admissions, observed conflicts, source provenance, allowed recovery choices and unavailable evidence. It is shared by Manager, CLI preview, resume and import validation.

### Evidence requests and responses

Add `ManagerEvidenceRequestV2` with a discriminated operation union:

| Operation | Required scope | Result |
| --- | --- | --- |
| `list_build_work` | `runId`, optional cursor | Admitted tickets/synthetic work and separately labeled conflicting historical work. |
| `list_qa_attempts` | `runId`, `workId`, optional snapshot/cursor | Every retained review, including passing, malformed, blocked, pending and interrupted attempts. |
| `get_qa_report` | `runId`, `workId`, `attemptId`, `occurrenceId` | Report identity, availability, content digest, body chunks or host artifact handle. |
| `get_qa_evidence` | Same scope plus typed `evidenceRef` | Retained remediation request, response, correction, delivery receipt, diff or verification evidence. |
| `get_qa_timeline` | `runId`, `workId`, optional snapshot/cursor | Ordered events and ticket-only counters with explicit gaps. |
| `get_intervention_status` | `runId`, `workId`, `instructionId` | Per-recipient delivery and verification evidence. |
| `get_ownership_conflicts` | `runId` | Read-only assessment and concrete reconciliation options. |

All fields have length/size limits; reject unknown fields, arbitrary SQL, commands, user-provided paths and out-of-scope references. Evidence references are resolved by the host against durable ownership. A guessed digest or a valid reference from another run cannot retrieve that run's evidence through the wrong scope. Retain the existing V1 four-operation protocol for old consumers.

Each page carries `snapshotId`, `asOf`, `items`, `nextCursor`, `complete`, `omissions`, `availability`, `schemaCapabilities` and `redactions`. Availability distinguishes `present`, `empty`, `unsupported_legacy`, `missing`, `unreadable`, `corrupt` and `pruned`; do not collapse these into `[]`. Full report identity and content digest accompany every chunk/artifact. A passing review has verification evidence and no invented failure-report body.

**Stable pagination:** on first access, read a consistent SQLite transaction and materialize an immutable host snapshot of the scoped ordered rows, mutable dispositions and evidence references. Use explicit sequences with deterministic ID tie-breakers, not timestamps or SQL offsets. A cursor binds the project/run/work/filter, snapshot ID and next ordinal. Subsequent pages use that snapshot. New reviews and later dispositions appear only on refresh. Cursor tampering or scope mismatch is invalid; expired/lost snapshots return `snapshot_expired` with an explicit restart action, not a silently restarted page. Large snapshots may spool to private host temporary storage; no workflow database writes. Artifact assembly pins/copies necessary evidence bytes so concurrent retention cannot silently change a partially downloaded body. Missing bytes discovered during assembly are disclosed.

**Bodies beyond prompt limits:** keep bounded model packets, but let the host render/export complete retained JSON or text directly using opaque artifact handles. Add deterministic Manager UI commands such as `/qa-report <run> <ticket> <attempt>` and `/more <cursor>` alongside conversational requests; finalize exact syntax with CLI help/tests. The host fetches all chunks for a selected report without charging each chunk as a model lookup. Page browsing can continue across questions after the two model rounds are exhausted. Provide a usable continuation command, never just a limitation notice. Chunk by UTF-8 bytes without splitting code points; include offset, returned bytes, total bytes and display digest. Do not drop a requested body because the enclosing packet exceeds 48 KiB.

Protected raw bytes remain retained. Default display uses the existing secret policy and escapes terminal control sequences. Disclose redaction categories, affected fields/spans, raw digest and rendered digest; never claim redacted text is byte-identical. Where byte-faithful display is unsafe, provide the protected artifact through a host-controlled local viewer/export with explicit access, not the model prompt. Do not silently redact whole findings. Markdown, code fences and action-shaped report text are untrusted content, never executable instructions.

### Interventions and delivery

`ManagerActionRequestV1` is separate from read requests. Supported actions are `guide_builder`, `guide_qa`, `guide_both`, `answer_question`, `pause`, `request_attempt`, `supersede` and `withdraw`. An explicit waiver invokes the existing waiver decision service with its existing semantics; it is never represented as QA guidance.

Persist `instructionId`, project/run/work/assignment scope, recipient(s), action, exact user text digest, trusted conversation turn reference, resolved authorization, requirement revision, source digest, review/occurrence basis, expected instruction-stream revision, creation sequence, lifetime and optional `supersedes`. `answer_question` also requires its actual pending decision ID and current decision revision. An action parser's proposal is not authorization: the host checks the original user turn and resolved target. A report or model-generated suggestion cannot mint authorization. Clarify ambiguous references; clear direction with one resolved target proceeds without another approval prompt.

Store immutable instruction events and separate recipient delivery records. Use an append-only stream plus compare-and-swap revision for concurrent controls. Reusing a request/idempotency key returns the existing instruction; it does not enqueue another send. Manager receives a narrowly scoped enqueue authority that coexists with an active build lease but cannot update snapshots, approvals, tracker state or provider operations. The owning process reserves dispatch using its normal execution authority.

| State | Evidence needed |
| --- | --- |
| `queued` | Valid authorization and scope committed; supervisor may be stopped. |
| `reserved` | Owner/generation, basis, budget and operation/turn intent committed atomically. Internal state, exposed as preparing delivery. |
| `delivered` | Actual provider submission with matching turn identity and instruction digest observed. |
| `acknowledged` | Correlated provider acknowledgement/response for that turn; absence stays unknown. |
| `applied` | Builder's scoped outcome/receipt reports the requested action, or the QA turn demonstrably used the bound guidance. This is not verification. |
| `verified` | Subsequent independent source-bound QA evidence establishes the relevant result. Unrelated QA success cannot verify another instruction. |
| `uncertain` | Dispatch/outcome evidence is incomplete; reconciliation required before replay. |
| `rejected` | Invalid authority, recipient, prerequisite, stale basis or conflicting control with a structured reason and resolution action. |
| `superseded` / `withdrawn` | Replacement/withdrawal wins before reservation, preserving the old text and audit event. |

Statuses are per recipient and delivery; an instruction is not globally verified because one recipient finished. Failure, partial application, dispute and pending verification remain visible. A withdrawn instruction that already reached a provider cannot be retracted; report delivered and allow a new compensating instruction at the next boundary.

Ordering uses committed sequence. A pause is a boundary barrier: it stops new dispatch before other queued guidance is consumed, preserving that guidance until authorized continuation. Ticket-scoped pauses preserve eligible independent continuation under the frozen policy; explicitly requested run-wide pauses stop all run dispatch and use a run-scope action variant rather than an invented ticket. Additive instructions can be combined only if compatible and all text fits; otherwise ask for explicit supersession or pause delivery with a resolvable conflict. Contradictory concurrent instructions do not use silent last-write-wins. `guide_both` creates a linked pair: Builder consumes first; QA consumes on the next review of that Builder result. Bind the QA child to the resulting source plus unchanged requirements and the parent receipt. This explicitly authorized source transition is distinct from unrelated source drift. If Builder fails, is uncertain or changes requirements, the QA child waits for reconciliation. QA-only guidance starts a new full review at the next valid boundary; it is not injected into a report-format correction.

Any requirements change enters the existing scope-approval flow and supersedes/invalidate bindings as appropriate. Approval for old scope never authorizes new requirements. Unrelated source/review changes make queued guidance stale; show old/new basis and offer rebind, revise or withdraw. Rebinding is a new durable scoped decision; do not silently apply stale guidance.

## Dependency ordered work packages

### P0 Establish the baseline and executable acceptance fixtures

**Files:** existing suites listed in the brief; `packages/ai-foreman/test/fixtures/`, `packages/rafi/test/`, packaged CLI fixture helpers, and a validation record alongside this plan.

Record checkout status, runtime, package versions, compiled exports and actual failures. Preserve unrelated untracked plans and `.github/`. Build dependencies before baseline tests because CLI source imports resolve `ai-foreman` through `dist`. Use installed Node 20.19.0 for the present SQLite binary; test other supported runtimes in isolated installations with matching native binaries, not by rebuilding the shared dependency tree during diagnosis.

Recreate the brief's production T002 assignment/T001 response/real recovery packet/resume reproduction with simulated provider boundaries. First record the old failure, then convert it into a desired-behavior regression: zero wrong-ticket QA, zero wrong-ticket tracker writes, retained response/work evidence, recoverable assigned work. Add completion/blocking, missing/unknown identities, empty queue and removed definition variants. Tests use temporary projects and production persistence/checkpoint/CLI services, not substitutes that bypass admission.

Investigate the two live-owner terminal-picker failures with process identity and sandbox evidence. Do not weaken the live-owner check, classify unknown as dead, or permanently skip them to turn the suite green. Run the same unchanged tests outside the restrictive sandbox when necessary and record that distinction. All new feature tests must fail against the pre-change behavior for the intended reason.

**Exit gate:** reproducible baseline, desired assertions, reusable crash/provider fixtures, and documented environmental versus product failures. No claim of incident-specific causation.

### P1 Introduce authoritative membership and a compatible schema upgrade

**Dependencies:** P0. **Files:** `workflowDb.ts`, `buildAdmission.ts`, `buildRuns.ts`, `qaHandbackMigration.ts`, `stateTransfer.ts`; new `buildWorkAdmission.ts` and `buildWorkMigration.ts`; spec contracts and exports.

Implement the scope registry/admission/assignment contracts and shared `admitWork`/`assertAdmittedWork` services. Admission rechecks approved execution scope, current requirements, eligibility, owner generation and expected revision atomically. Dynamic selection admits one eligible ticket before work; explicit selection admits only authorized selected work. Saved run membership projects all admitted work and cannot shrink away existing assignments, QA records or finalization. Completion does not remove membership. Direct `WorkflowDb.transition` and snapshot imports must enforce the same consistency rules as `saveBuildRun`.

Audit every scoped writer: review attempts, raw response bindings, reports, findings/dispositions/chains, ticket/recovery heads, reducer events, packets/publications, remediation attempts/handoffs/receipts, source/review bindings, pass certificates, finalization, instruction deliveries, branch sessions and dispatch intents. Validate both membership and parent occurrence/source/run ownership. Global content-addressed bytes may be shared, but every scoped reference requires admission or explicitly quarantined historical import.

Use a new schema/writer compatibility level (proposed version 4 after checking the final schema registry), not another rule under protocol 3. Upgrade all normal writers, heartbeat writers, import connections and control-write connections together. Install durable triggers that reject old connection protocol/capability values and enforce scope on insert/update/delete, plus composite foreign keys. Protect snapshot JSON mutations and scope deletions too. Direct SQL connections without the registered protocol fail; old binaries fail before any mutation. This protects supported storage callers and ordinary direct SQL, not a malicious administrator intentionally removing database guards.

Upgrade under the existing storage-upgrade authority, independently of provider dispatch authority. Require stopped/verified writers and a consistent SQLite backup including WAL-visible evidence and external packet files. In one restartable schema transaction, classify legacy scope: proven authorized work becomes admitted; inconsistent/uncertain references enter quarantine with an audit conflict. Never infer admission merely from packet existence or tracker timestamps. Keep original evidence bytes and digests. An irreconcilable schema/evidence corruption rolls back the upgrade; read-only diagnosis still works and presents a repair/export path.

Do not require all historical conflicts to be resolved before inspecting or upgrading other valid records. Quarantine blocks affected execution, and a shared-workspace integrity conflict may block that whole workspace. Migration journal/version and guards commit together. Kill/throw at table-copy, guard-install and commit boundaries; reopening must yield either the complete old schema or complete new schema. Do not advance a manifest/version on partial publication. Imports stage, validate protocol and provenance, classify conflicts, then commit; a JSON import cannot bypass membership checks.

**Tests/gate:** new `buildWorkAdmission.test.ts` and `buildWorkMigration.test.ts`; extend `buildAdmission`, `qaHandbackMigration`, `qaProtocolV2`, `stateTransfer` and workflow storage suites. Parameterize every writer with foreign run/ticket, same ticket ID across runs, missing admission, quarantined identity, mismatched parent and dropped snapshot member. Run an actual old-writer child process against a copied upgraded database. Verify counts, original evidence hashes, integrity, foreign keys, idempotent upgrade and unchanged read-only copies.

### P2 Enforce assignment at both execution paths

**Dependencies:** P1. **Files:** `foreman.ts`, `branch/runner.ts`, `cli/start.ts`, `buildRuns.ts`, response parsing/validation helpers; new shared `buildAssignment.ts`.

Admission must precede tracker `in_progress`, worktree/provider dispatch and QA. Preserve approval feedback reselection: if requirements or eligibility change while awaiting approval, discard the candidate and select/revalidate again. Journal tracker publication separately where its database cannot participate in the workflow transaction.

Ticket mode with no eligible assignment returns `all-done` only when authorized work is durably complete; otherwise return blocked/needs-input with dependency or question reasons. It performs zero generic Builder turns. An unresolved explicit ticket never substitutes an independent ticket outside the invocation scope. A removed definition requires a scoped decision; do not synthesize a replacement.

Shared response validation applies to done, plan-complete, blocked, error, question and other scoped work outcomes across current-branch and branch execution, including QA disabled. Define which transport/setup/handoff messages are not work completions; their existing session protocol remains separate. Every work response must match the assigned identity. A response-only repair may correct a safely identifiable format problem within existing budgets, but cannot rerun implementation or manufacture certainty about conflicting work.

Persist raw response, assignment, dispatch receipt, pre/post source identities and available patch/untracked-file inventory before accepting scoped effects. If identity conflicts, stop QA/completion/blocking of the foreign ticket and retain unexpected edits for P4. A post-turn check cannot undo edits already made. Shared current-branch worktree ambiguity blocks further mutation until reconciled; isolated unaffected work can continue only under the frozen policy and existing workspace safety checks.

Replace `ticketForQa` fallback with resolution from admitted assignment. Explicit synthetic mode uses its frozen stable definition and admission; test restart through the same QA persistence APIs. Direct APIs such as `runQaReview`/`runPendingQaRecovery` require a resolvable admitted identity and cannot evade the invariant.

**Tests/gate:** `foreman.test.ts`, `branch.test.ts`, `buildResume.test.ts`, new `buildAssignment.test.ts`. Assert provider send counts, exact selected prompts, both tickets' tracker state, packet/head ownership and preserved source artifacts, not merely returned errors. Include later turns, blocked-first/done-second, handoffs, explicit/bare resume and definition changes between approval and dispatch.

### P3 Provide complete non-mutating evidence access

**Dependencies:** P0; read support can be developed alongside P1/P2 and must read pre-upgrade databases. **Files:** `workflowReader.ts`, `projectDiagnostics.ts`, `managerPacket.ts`, `cli/manager.ts`, `diagnostics.ts`, spec schemas; new `qaEvidenceReader.ts` and `managerEvidenceArtifacts.ts`; Manager agent instructions.

Implement the V2 contract, read capability detection and stable snapshot service. Read workflow evidence directly even without observability databases/spans or a complete run JSON projection. Legacy digest-only links are resolved only where unambiguous; return an ambiguity with candidate identities otherwise. Enumerate the union of saved work, admitted work and QA-observed work, labeling each source of scope. Do not require admission to read retained conflict evidence.

Render exact retained report content through the host and provide explicit continuation for pages, artifacts and budget exhaustion. Summaries cite occurrence/attempt identities but never stand in for a requested report body. Document commands and JSON envelopes in Manager instructions and CLI docs; update restrictions to permit only host-scoped reads and, later, the separate action protocol. Keep native provider SQL/filesystem tools restricted.

**Tests/gate:** extend `projectDiagnostics.test.ts`; new `qaEvidenceReader.test.ts`, `managerEvidence.test.ts` and spec schema tests. Include a valid near-64 KiB multibyte report, packet framing below 48 KiB, identical bodies in multiple occurrences, early resolved reports, all outcome classes, concurrent append/disposition changes, cursor expiry/tampering, pruning, missing/corrupt blobs, absent observability, older schemas and no database present. Compare host artifact content byte-for-byte where unredacted; verify redacted rendering/digests/disclosure separately. Hash database files and verify no migration, timestamp, lease or workflow event changes after inspection.

### P4 Reconcile existing inconsistent builds before resume selection

**Dependencies:** P1/P2; P3 supplies diagnostics. **Files:** `buildRuns.ts`, `operationRecovery.ts`, `buildResume.ts`, `cli/recovery.ts`, `stateTransfer.ts`, `supervisor.ts`; new shared `buildOwnershipReconciliation.ts`.

Run ownership assessment before choosing exact/fresh/guided resume mode for both aliases and direct recovery entry points. Candidate discovery must find a run with conflicting pending QA even when its saved ticket list omits that ticket; choosing that diagnostic candidate grants no execution scope. Display saved scope, assignment, conflicting packet/review identity, evidence availability, preserved work location and supported repair choices.

| Classification | Required usable path |
| --- | --- |
| Authorized work with missing saved membership | Require durable approval covering that requirements revision plus a run-bound assignment/dispatch/checkpoint/session-worktree chain. Validate no competing ownership. Atomically record provenance and membership repair, republish the snapshot, then revalidate packet/head/source/session bindings. A stale source still requires fresh QA; membership repair alone does not make the old review current. |
| Builder switched from T002 to T001 | Preserve worktree, commits, untracked files, response and packets. Produce an operator-reviewable diff/assignment map. Choose to separate foreign edits into a preserved branch/artifact and restore the intended baseline, explicitly authorize/reassign selected work through scope approval, or keep the build paused for manual reconciliation. Do not alter source merely because the response marker differs. Verify the resulting T002 workspace and require fresh QA; retain T001 evidence as conflicting/superseded history. Adding T001 alone is not repair. |
| Ownership cannot be established | Provide an evidence bundle and a durable decision with choices: supply/link existing approval and assignment provenance; explicitly authorize a reconciled scope and map preserved changes to it for fresh verification; or quarantine conflicting work while continuing only provably independent work. Manual reconciliation includes inspected source snapshot, approved target requirements, reviewed change mapping and operator attestation. Attestation authorizes future reconciliation; it does not invent a historical receipt or permit uncertain replay. |

Repairs use expected revisions, unique idempotency keys, audit events and publication intent. Recheck after acquiring repair authority; reject a competing owner or changed evidence. Store the approved repair plan before changing source/membership, and checkpoint each external file/branch step for restart. Never delete packets, discard code, disable resume checks or automatically restart the build. Retire stale recovery pointers only after retaining them as historical evidence and establishing a validated successor binding. Reconciliation of uncertain provider dispatch precedes any fresh execution.

Existing timestamp inference becomes a labeled diagnostic hint, not executable membership. Handle empty and partial saved lists, absent tracker events, multiple pending QA tickets, terminal tickets and run ID isolation. Terminal records can receive audited metadata repair without reopening execution; any new work follows existing terminal-run policy.

**Tests/gate:** copied legacy fixtures for all three outcomes through `buildResume.test.ts`, `qaRecovery.test.ts`, new `buildOwnershipReconciliation.test.ts`, and state-transfer tests. Kill after repair decision, membership commit, file publication and head rebinding; repeat repair and prove one audit outcome, no duplicate provider work and retained byte hashes. Verify no resume-mode prompt appears before unresolved conflict choices.

### P5 Construct ticket timelines and explain recurrence

**Dependencies:** P3. **Files:** `diagnostics.ts`, `projectDiagnostics.ts`, QA evidence reader, Manager instructions; new `qaTimeline.ts`.

Join all retained attempts, raw/corrected report turns, report dispositions, remediation requests/outcomes, delivery records, Builder responses, source/review basis, questions, waivers and pass/finalization evidence. Do not use `loadDurableQaHistory` as the timeline source. Optional observability enriches durations; absent spans leave unknown duration rather than deleting a workflow event.

Count failed QA reviews separately from blocked verification, malformed responses, corrections, interrupted/pending reviews, remediation failures and passes. Attribute events by actual run/work/attempt linkage, never by copying a run metric to every ticket. Display observed counters with snapshot boundaries and gaps.

Within a ticket, correlate possible recurring issues using normalized finding content, location/rule/test identity and linked remediation outcomes. Review-local finding IDs are not stable issue IDs. Store/display correlation confidence and evidence; let disputed/new/recurring labels remain distinct. Exact code-change explanations require retained diff/blob/commit evidence and requirements history. Changed digests establish changed content only. Unknown or missing histories produce qualified explanations.

Show reported fixes, subsequently verified fixes, superseded reports and explicit waivers distinctly. A pass verifies only its current review basis; unresolved findings remain open unless a valid disposition establishes their result. Present available actions from host eligibility, not invented model commands.

**Tests/gate:** new `qaTimeline.test.ts` plus diagnostics tests. Use two tickets with sharply different failure counts in one run, renumbered finding IDs, repeated identical text, new defects, disputed findings, failed/uncertain remediation, protocol-only repairs and source changes without diffs. Assert exact counts and provenance of explanations.

### P6 Implement durable user instructions and authorization

**Dependencies:** P1/P4 and shared contracts. **Files:** `humanDecision.ts`, `workflowDb.ts`, `qaDeliveryJournal.ts`, `operationRecovery.ts`, `cli/recovery.ts`; new `buildInterventions.ts`; spec contracts.

Implement action validation, enqueue-only control authority, ordering, per-recipient states, idempotency, supersession/withdrawal and basis validation. Reuse durable human decisions for questions and approvals, and remediation authorization for additional attempts. Do not add another retry ledger or a separate Manager execution engine.

Bind natural-language authorization to the actual user turn and resolved scope. Discussion, changed conversational focus, quoted report instructions and a model's recommendation are insufficient. A clear instruction with resolved target creates the action without redundant confirmation. Requirement changes invoke scope approval; ordinary implementation advice within approved requirements does not.

Add a boundary query/reservation API that the owning loop uses atomically with instruction revision, role generation, source/review basis, operation intent and budget. Reserving alone is not delivery. Cancellation/supersession racing reservation must have one durable winner; once reserved, show whether dispatch can still be safely stopped. Conflict results include a concrete revise/supersede choice.

**Tests/gate:** new `buildInterventions.test.ts`, `qaDecisions.test.ts`, schema tests. Exercise ambiguous/focused/explicit targets, report prompt injection, scope edits, stale questions, duplicate requests, conflicting simultaneous writers, narrow control capability misuse, pre/post-reservation withdrawal, exhausted budgets and single-use extra attempts. No provider sends occur in these storage/authorization tests.

### P7 Deliver guidance inside the active QA loop

**Dependencies:** P2/P6. **Files:** `qaReview.ts`, `qaFailureDelivery.ts`, `qaDeliveryJournal.ts`, `qaProtocolV2.ts`, `qaRecovery.ts`, `foreman.ts`, `branch/runner.ts`, `cli/start.ts`, `supervisor.ts`, production adapter wrappers.

Check pending controls before each Builder work/remediation dispatch, each fresh QA review, after a provider turn returns and before finalization. Include loops within `runIsolatedQa`; a between-ticket hook is insufficient. Recheck controls after asynchronous session/source preparation immediately before reserving dispatch. Active provider turns finish under the original instruction; report queued guidance as waiting for that boundary. A pause arriving before finalization prevents subsequent mutation until its next authorized continuation. New QA guidance accepted before finalization changes the intended review basis: preserve the earlier pass as history, but require the newly authorized review before consuming a certificate. Revalidate available budget or request a scoped extra attempt; never silently finalize against the earlier basis or grant another attempt.

After QA passes with Builder guidance still queued, an explicit resume uses existing admitted scope and the remaining Builder fix allowance for one recorded follow-up, then runs complete fresh QA. Invalidate the earlier pass certificate atomically with the follow-up reservation. Count follow-ups against the same durable allowance as failure remediation, including interrupted intents; an exhausted allowance requires an explicit single-use `/request-attempt` bound to that passed review and waiting guidance. Changed requirements require renewed scope approval. Apply this policy to current-branch and isolated-worktree resume; saving guidance alone does not authorize starting a process. This policy was explicitly approved by the user.

Builder guidance becomes a bound addition to the complete remediation request without dropping findings. QA guidance is included in the **actual full-review prompt**, hashed into the review basis together with requirements/source/runtime inputs, and referenced by the QA turn intent/receipt. Retain the exact final provider instruction digest and protected bytes, including wrapper additions. Thread the existing report-recovery handler through the shared service where fresh review is valid; invalid source/session identity still requires repair first. Guidance never turns a formatting-only correction into verification or waives a finding.

At terminal prompts, persist the question first; prompt completion and remote Manager answers race via the same decision revision, so only one answer is consumed. The owning process subscribes to control revisions using a local wake notification plus bounded polling as a fallback; notifications are hints and SQLite remains authoritative. A terminal wait races its input against a durable decision update, cancels/dismisses the obsolete prompt and rechecks the decision revision before continuing. Wake/refresh the owning loop without writing a second provider turn. If the supervisor has exited, show `queued; build stopped`. An explicit user request to resume uses existing recovery/admission services and a new validated owner. Merely saving guidance does not start a process; a compound clear instruction to guide and resume can authorize both actions without redundant confirmation.

On restart, reconcile reserved/dispatched instructions using operation journal, provider turn/session evidence and source state. Known unsubmitted reservations may be released safely; uncertain submission is not blindly retried. Known completed receipts are reused. Delivering again requires reconciled nonexecution or a new explicit attempt authorization. Never promise unconditional exactly-once provider execution.

**Tests/gate:** `qaFailureDelivery`, `qaHandbackCallers`, `qaHandbackSafety`, `qaRecovery`, `qaProtocolV2`, plus new `qaGuidanceDelivery.test.ts`. Capture prompts through real Claude/Codex adapters or their deterministic transports and the full production wrapper stack. Assert exact guidance text/digest reaches Builder, QA, and ordered both-agent cases within the same cycle before budget exhaustion. Simulate active turn, blocked prompt, stopped supervisor, fresh resume, child-process death after intent/send/response, source drift and requirement changes. Verify uncertainty, no duplicate sends, QA independence, unchanged mandatory findings and existing retry limits.

### P8 Connect Manager UI and run end to end release validation

**Dependencies:** P3/P4/P5/P7. **Files:** `cli/manager.ts`, `managerPacket.ts`, `projectDiagnostics.ts`, `packages/special-agents/content/agents/{manager.yaml,manager-diagnostics.md}`, package exports, CLI help/generated docs and packaged tests.

Manager shows selected build/ticket, report identities, completeness, diagnosed ownership conflicts and intervention eligibility. Separate discussion from explicit action requests. Render host acknowledgements such as “Queued for QA after the current turn”, “Builder reported applied; QA pending”, “Delivery uncertain; reconcile before retry”, and “Verified by review N at source digest …”. Status refresh is read-only. Manager cannot claim success solely from an action request or handler return.

Expose the shared recovery choices directly from diagnostics. Make full report browsing usable without a model round trip for every page, and preserve commands/artifact handles when the model budget is exhausted. Update agent restrictions specifically for scoped host actions; do not grant general project mutation tools.

Build packages in dependency order and test installed tarballs in a temporary consumer outside the workspace, with no source paths or workspace symlinks masking missing exports. Script deterministic provider executables for Manager retrieval, in-cycle intervention, both resume aliases and conflict repair. Assert report bytes, exact adapter prompts, source files, tracker state, final verification and restart behavior. Test both provider paths, current/branch mode and explicit/automatic selection.

**Exit gate:** all acceptance rows below, full workspace tests, typecheck/build/docs checks, compatibility and crash suites, and required native-platform jobs pass on the same final revision. Keep authenticated live-provider canaries separately reported; deterministic transports establish wiring, not production model quality or latency.

## Acceptance and regression release matrix

Numbers correspond exactly to the brief's acceptance scenarios. New test filenames above are proposed; implementation must record final case names and logs here.

| Scenario | Work packages | Release evidence required |
| --- | --- | --- |
| 1 Historical report bodies and repeated content | P3/P8 | Installed CLI returns exact retained early report and distinct run/ticket/review identities. |
| 2 Large reports, pagination and concurrent reviews | P3/P8 | Multibyte byte-equality, stable snapshot pages, explicit continuation/redaction and no silent omissions. |
| 3 Old databases and conflicting/missing evidence | P1/P3/P4 | Read-only file hashes unchanged; capabilities/gaps/conflicts accurately surfaced. |
| 4 Complete ticket-specific explanations | P5/P8 | Timeline fixture counts and evidence links include all outcomes; no run-to-ticket metric attribution. |
| 5 Guidance reaches intended next turns | P6/P7/P8 | Actual adapter prompts and persisted review basis show authorized text for all recipients. |
| 6 Concurrent, stopped and interrupted delivery | P6/P7 | Prompt/decision races and crash/restart tests establish truthful status and no blind duplicate dispatch. |
| 7 Explicit authority and changed requirements | P6/P8 | Injection/focus/ambiguity tests, clear-action no-extra-confirmation test, changed-scope approval gate. |
| 8 All response identity mismatches | P0/P2 | Production reproduction converted to desired behavior; current/branch, QA on/off, completion/blocking/missing/unknown identities. |
| 9 No ticket fallback and valid synthetic resume | P1/P2 | Zero sends on empty/exhausted/removed assignment; synthetic interruption resumes the same admitted work. |
| 10 Interrupted admission and publication | P1/P2/P4/P7 | Faults after admission/intent and during packet/snapshot publication preserve ownership and unexpected edits. |
| 11 Storage, old writers and import enforcement | P1/P4 | Every scoped API and direct SQL guard tested; actual old writer rejected; repeatable copied-data upgrade/repair. |
| 12 Three legacy reconciliation outcomes | P4/P8 | Each produces a usable tested operator path, including wrong-ticket source reconciliation and missing provenance. |
| 13 Existing execution safeguards | P2/P4/P7/P8 | Multiple pending/terminal tickets, independent continuation, approvals, waivers, budgets, source binding and one-owner tests for both providers/modes. |
| 14 Built exports and packaged CLI | P8 | Fresh tarball consumer completes report retrieval, intervention and both resume aliases without workspace source access. |

Cross-cutting tests must additionally assert that foreign-ticket rejection leaves the foreign tracker untouched; no pass/finalization exists without a matching source-bound certificate or explicit waiver; no final completion bypasses pending questions, QA or uncertain dispatch; an unchanged approved revision does not prompt again; and blocked independent tickets retain the run's frozen continuation policy. Do not count skipped platform/live tests as passes.

### Implemented validation mapping

The [validation record](manager-qa-and-resume-validation.json) maps all fourteen rows to the actual suites, records final source and tarball digests, and separates local results from pending release gates. The final local commands use frozen package sources; the installed consumer is outside the workspace and has no workspace source imports or package symlinks.

| Area | Actual suites |
| --- | --- |
| Admission, migration and storage parents | `buildWorkAdmission.test.ts`, `buildWorkMigration.test.ts`, `qaProtocolV2.test.ts`, `stateTransfer.test.ts` |
| Assignment identity and workspace fencing | `foreman.test.ts`, `branch.test.ts`, `buildAssignment.test.ts` |
| Evidence and timeline | `managerEvidence.test.ts`, `qaTimeline.test.ts`, `managerPackaged.test.mjs` |
| Audited repair and pre-mode resume assessment | `buildOwnershipReconciliation.test.ts`, `buildResume.test.ts` |
| Controls, question races and crash recovery | `buildInterventions.test.ts`, `qaGuidanceDelivery.test.ts`, `qaHandbackSafety.test.ts` |
| Installed CLI journeys | `managerPackaged.test.mjs`, `syntheticPackaged.test.mjs`, `interruptedPackaged.test.mjs`, `establishedPackaged.test.mjs` |

Legacy migration conservatively quarantines observed QA; proven historical authorization can be linked through audited operator repair. Source separation/restoration remains an inspected operator step. Repair publication tests inject failures at four boundaries; guidance recovery additionally kills child processes after intent, dispatch and receipt. These checks do not establish exhaustive coverage of every storage method/invalid-field combination or every repair crash mechanism. Native Linux/Windows verification, authenticated provider canaries and release rehearsal are separately reported. The full release exit gate is not satisfied solely by the local checks.

## Validation commands and rollout gates

Use this workspace's installed compatible runtime for local verification:

```sh
export PATH=/Users/tyler/.nvm/versions/node/v20.19.0/bin:$PATH
pnpm --filter rafi-spec build
pnpm --filter special-agents build
pnpm --filter ai-foreman build
pnpm --filter @rafi-ai/cli build
pnpm typecheck
pnpm test
node --import tsx packages/rafi/scripts/generate-cli-docs.ts --check
git diff --check
```

For focused investigation, `node --import tsx --test --test-concurrency=1 <test files>` avoids the `tsx` CLI IPC requirement. This does not eliminate subprocess/process-inspection restrictions; record the execution environment. Rebuild after source changes before rerunning CLI/import tests. Add the new suites to ordinary package test discovery and CI; do not leave them as uncommitted investigation scripts.

1. **Characterization gate:** baseline recorded and every newly fixed defect has a meaningful failing-before/passing-after assertion. Diagnose current failures rather than hiding them.
2. **Invariant gate:** P1/P2 enforce membership and identity across all writers/callers; no new inconsistent state can be produced through supported APIs.
3. **Compatibility gate:** legacy read access, copied upgrades, old-writer rejection, imports, repair interruption and database/file reconciliation pass. No production migration is required to browse evidence.
4. **Delivery gate:** enable Manager mutations only after actual prompt delivery and restart tests pass. Reads may ship earlier once P3 passes; unsafe mutation routes remain unavailable with a clear explanation.
5. **Workspace and package gate:** fresh build/typecheck/full tests/docs plus installed-package scenarios pass. Resolve the two picker baseline failures or establish supported-environment passing evidence; an unexplained failure blocks sign-off.
6. **Platform gate:** run process ownership, migration, terminal and packaged flows on supported native macOS/Linux/Windows runners. Earlier plans recorded outstanding native verification; local success does not close it. Native-dependency/runtime matrices use fresh isolated installations.
7. **Release rehearsal:** stop writers, take a coherent backup, rehearse migration and repair on copies, verify evidence hashes and dry-run operator decisions, then stage deployment. Record package/protocol versions, rejected-write diagnostics and queued/uncertain instruction counts. Do not automatically migrate or repair the user's actual affected build during planning.

Rollback disables new action ingress and pauses execution; it does not run an older writer against the upgraded database. Prefer forward repair. Restoring a backup requires accounting for all external work after that backup to avoid replay; preserve newer source/evidence before any restore. Do not down-migrate away admission or instruction history.

## Incident investigation and planning validation

The implementation does not depend on identifying the original incident. To attribute it, obtain the affected project/run/version and an operator-approved consistent copy of build snapshots, workflow database/WAL-visible evidence, packet manifests, assignment/session/lease history and relevant source state. Compare saved membership, actual dispatch assignment and response identity. Report separately whether it matches the demonstrated wrong-ticket route, missing membership with legitimate provenance, or another inconsistency. Do not infer that selecting another run is the fix from the membership error alone.

Actual implementation results, revision, runtime, commands, counts, skips and log locations are recorded in [the validation record](manager-qa-and-resume-validation.json). The following planning baseline is retained as historical context; its passing tests do not establish the implemented features.

Planning validation on October 9, 2026 used Node 20.19.0 and the installed dependencies without a lockfile/dependency change. The root `pnpm build` passed, but its output launched all four packages concurrently; the release commands above deliberately specify dependency order instead of assuming the root script provides it.

The nine suites named in the brief were rerun after that build: **117 tests, 115 passed, 2 failed, 0 skipped**. Failures were the unchanged `resume` and `build:resume` live-owner picker inspections, which returned unknown process incarnation in the restricted sandbox. Rerunning the four unchanged real-terminal-picker cases outside the sandbox passed **4 of 4**, with 29 unrelated cases filtered/skipped. `processIdentity.ts` uses `ps` for macOS process-start identity and conservatively returns unknown when that probe is unavailable. The environment comparison supports restricted process inspection as the local failure explanation; it does not prove every ownership/platform path correct or attribute the original QA incident. No assertions or runtime code were changed.

After explicitly rebuilding `rafi-spec`, `special-agents`, `ai-foreman`, then `@rafi-ai/cli`, the entire same nine-suite baseline was rerun outside the sandbox: **117 tests, 117 passed, 0 failed, 0 skipped**. This establishes a green targeted baseline in that environment. It is not a full-workspace run or validation of the future implementation; the complete release matrix remains required.

Logs: `/private/tmp/rafi-manager-plan-build.log`, `/private/tmp/rafi-manager-plan-foreman-build.log`, `/private/tmp/rafi-manager-plan-cli-build.log`, `/private/tmp/rafi-manager-plan-baseline.log`, `/private/tmp/rafi-manager-plan-picker-unsandboxed.log`, and `/private/tmp/rafi-manager-plan-baseline-unsandboxed.log`. These runs overlap and their test counts must not be summed. All 14 acceptance rows, nine work packages and relative document links were checked, along with whitespace and code fences. Only this new plan was added; existing untracked files were preserved. No Graphify graph or `.graphifyignore` exists in this checkout, so there is no adopted graph to refresh.
