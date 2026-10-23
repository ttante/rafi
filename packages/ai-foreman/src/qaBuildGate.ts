import { operationPayload } from "./structuredOperation.js";
import { loadGraphConfig } from "./graph/config.js";
import { resolveQaPreparationConfig } from "./qaPreparationPolicy.js";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isTicketsInitialized, loadTicketsConfig } from "./tickets/config.js";
import { loadTickets } from "./tickets/ticketLoader.js";
import { qaDigest } from "./qaProtocolV2.js";
import { admittedPlanInput } from "./qaPreparationInputs.js";
import { checkQaPrerequisites } from "./qaPrerequisites.js";
import { OperationDeadline } from "./util/deadline.js";
import { sendPreparationGraphTurn } from "./graph/preparation.js";
import { withGraphDerivedAccess } from "./graph/derived.js";
import { randomUUID } from "node:crypto";
import type { ContractInputRef, QaContractCandidateV1, QaPreparationDepthDecisionV1 } from "rafi-spec";
import type { BuilderAdapter, TurnResult } from "./adapters/types.js";
import type { QaSessionHandle } from "./qaReview.js";
import { WorkflowDb } from "./workflowDb.js";
import { createRoleBuilder, readOnlyPermissionConfig } from "./agentRun.js";
import { captureBuildSource, assertBuildAssignmentReconciled, BuildAssignmentRejected } from "./buildAssignment.js";
import { createDisposableQaSnapshotAsync } from "./qaSnapshot.js";
import { allocateStableCheckIds, authoritativeInventory, bindUniqueBaselineCheckIds, contractDigest, ensureHostScopeCheck, mapSnapshotWorkingDirectories, normalizeSnapshotPaths, renderVerificationContract, rewriteProviderHostScopeChecks } from "./qaVerificationContract.js";
import { loadQaPreparationPolicy, resolveEffectiveQaConfiguration } from "./qaEffectiveConfig.js";
import { prepareVerificationContract, draftOutput, depthOutput, assessmentOutput, challengeOutput } from "./qaPreparation.js";
import { qaHostGraphFact } from "./qaHostFacts.js";
import { actualContractSession, assertContractReceipt, deliverVerificationContract } from "./qaContractDelivery.js";
import { BUILDER_WORK_COVERAGE_INSTRUCTIONS } from "./qaContractCoverage.js";
import { renderBuildWorkContext } from "./buildWorkContext.js";
import { compareContractInputs } from "./qaContractFreshness.js";
import type { TicketDef } from "./tickets/ticketSchema.js";
import { readBuildRuns } from "./buildRuns.js";
import { normalizeGraphQaChecks } from "./hostGraphApplicability.js";

/** A received response missing only continuity metadata is a bounded format defect. */
export function preparationTurnPayload(turn: TurnResult): { text: string; formatErrors: string[] } {
  const formatErrors = turn.continuityErrors ?? [];
  return {
    text: formatErrors.length ? turn.rawResponse ?? turn.cleanedResponse ?? turn.text : turn.text,
    formatErrors,
  };
}

/**
 * The selected QA bundle is already injected as immutable system context for
 * the isolated provider session.  Repeat only its identity here: the exact
 * requirements remain in the authoritative inventory, while repeating full
 * rules and skill bodies in every operation wastes context and makes native
 * structured submission needlessly fragile.
 */
export function preparationConfigurationReference(effective: ReturnType<typeof resolveEffectiveQaConfiguration>) {
  return {
    digest: effective.digest,
    configRoot: effective.configRoot,
    roleSource: effective.roleSource,
    checklistDigest: contractDigest("input-checklist", effective.checklist),
    qaRulesDigest: contractDigest("qa-rules", effective.qaRules),
    builderRulesDigest: contractDigest("builder-rules", effective.builderRules),
    skills: effective.skills.map(skill => ({ name: skill.name, path: skill.path, digest: skill.digest })),
  };
}

/** Shared by ordinary, branch, synthetic, remediation and Manager followups. */
export async function ensureBuilderContract(projectDir: string, runId: string, workId: string, workspace: string, builder: BuilderAdapter, qaFactory?: (cwd: string) => Promise<QaSessionHandle>): Promise<string> {
  return withGraphDerivedAccess([], () => ensureBuilderContractWithProvenance(projectDir, runId, workId, workspace, builder, qaFactory));
}
async function ensureBuilderContractWithProvenance(projectDir: string, runId: string, workId: string, workspace: string, builder: BuilderAdapter, qaFactory?: (cwd: string) => Promise<QaSessionHandle>): Promise<string> {
  const db = new WorkflowDb(projectDir);
  try {
    db.ensureRun(runId);
    const store = db.qaPreparationStore();
    const policy = store.policy(runId) ?? store.freezePolicy(runId, resolveQaPreparationConfig(undefined));
    if (policy.mode === "legacy") return "";
    assertBuildAssignmentReconciled(projectDir, runId, workspace);
    const admission = db.assertAdmittedWork(runId, workId);
    const ticket = db.workDefinitions(runId).find(work => work.workId === workId)?.definition as TicketDef | undefined;
    if (!ticket) throw new Error("Preparation requires the frozen admitted work definition");
    if (admission.kind === "ticket" && isTicketsInitialized(projectDir)) {
      const current = loadTickets(join(projectDir, loadTicketsConfig(projectDir).paths.tickets)).find(ticket => ticket.id === workId);
      if (!current || qaDigest("admitted-requirements", current) !== admission.requirementsDigest) throw new Error("Ticket changed from frozen admitted scope; renewed approval is required before preparation or implementation");
    }
    const state = db.getRun(runId)?.state as { qa?: { settings?: { make?: "claude" | "codex" } } } | undefined;
    const effective = resolveEffectiveQaConfiguration(projectDir, { make: state?.qa?.settings?.make ?? builder.agent });
    const configurationEvent = `preparation-configuration:${runId}:${workId}:${effective.digest}`;
    if (!store.eventRecord(configurationEvent)) store.event(runId, workId, configurationEvent, "effective-preparation-configuration", { policy, effectiveDigest: effective.digest, configRoot: effective.configRoot, roleSource: effective.roleSource, provider: builder.agent, capabilities: builder.contractCapabilities?.() ?? null, finalReviewEnabled: (db.getRun(runId)?.state as { qaEnabled?: boolean })?.qaEnabled ?? null });
    const inputs: ContractInputRef[] = [
      { id: "communication-contract", kind: "policy", reference: "structured-provider-output-v1", digest: contractDigest("communication-contract", {
        protocolVersion: 1, hostValidation: "typed-invariants-v1", schemas: [draftOutput, depthOutput, assessmentOutput, challengeOutput].map(output => ({ operation: output.operation, version: output.schemaVersion, digest: output.schemaDigest })),
      }), authority: "planner-policy", revision: "1", availability: "available" },
      { id: "admitted-ticket", kind: "ticket", reference: admission.assignmentId, digest: contractDigest("input-ticket", ticket), authority: "approved-scope", revision: admission.scopeRevision, availability: "available" },
      { id: "project-checklist", kind: "checklist", reference: "tickets.build.validation_checklist", digest: contractDigest("input-checklist", effective.checklist), authority: "project-rule", revision: "current", availability: "available" },
      { id: "effective-rules", kind: "rules", reference: effective.configRoot, digest: effective.digest, authority: "project-rule", revision: "current", availability: "available" },
      { id: "preparation-policy", kind: "policy", reference: policy.policyVersion, digest: contractDigest("input-policy", policy), authority: "planner-policy", revision: policy.policyVersion, availability: "available" },
    ];
    const planInput = admittedPlanInput(projectDir, ticket);
    if (planInput) inputs.push(planInput.input);
    const inventory = [...authoritativeInventory(ticket, effective.checklist, inputs), ...(planInput?.requirements ?? [])];
    for (const [locator, statement] of [["qa-rules", effective.qaRules], ["builder-rules", effective.builderRules], ...effective.skills.map(skill => [`skill:${skill.name}`, skill.content])] as Array<[string, string]>) {
      if (!statement.trim()) continue;
      inventory.push({ id: `req-rules-${contractDigest("rule-identity", { locator, statement }).slice(0, 24)}`, inputRef: "effective-rules", locator, statement, digest: contractDigest("statement", statement), obligation: "mandatory", origin: "explicit", authority: "approved" });
    }
    const source = captureBuildSource(workspace);
    const preimplementationPathManifestDigest = contractDigest("preimplementation-path-manifest", source.pathInventory.map(path => ({
      path: path.path,
      staged: path.staged,
      unstaged: path.unstaged,
      ...(path.headObject ? { headObject: path.headObject } : {}),
      ...(path.indexObject ? { indexObject: path.indexObject } : {}),
      ...(path.worktreeObject ? { worktreeObject: path.worktreeObject } : {}),
      ...(path.untracked ? { untracked: path.untracked } : {}),
    })));
    const baselineEvidence = store.putArtifact("baseline-observation", {
      kind: "host-captured-preimplementation-source",
      sourceDigest: source.digest,
      contentDigest: source.contentDigest,
      head: source.head,
      captureMode: source.captureMode,
      capturedAt: source.capturedAt,
    });
    inputs.push({ id: "preimplementation-source", kind: "baseline", reference: "builder.preimplementation-source", digest: source.digest, authority: "inspected-context", revision: source.head, availability: "available" });
    const head = store.head(runId, workId, admission.requirementsDigest);
    const priorBudget = store.budget(runId, workId, admission.requirementsDigest);
    if (priorBudget) store.applyAnsweredExtensions(priorBudget);
    let amendmentPredecessor: string | undefined;
    if (head.digest) {
      const old = store.contract(head.digest);
      const comparison = compareContractInputs(old, inputs);
      const inputDigest = contractDigest("amended-inputs", inputs);
      const retainedIntent = priorBudget ? store.progress<{ inputDigest: string; predecessorDigest: string }>(priorBudget, "amendment-inputs") : undefined;
      const changedDuringAmendment = head.state !== "ready" && retainedIntent?.predecessorDigest === old.contentDigest && retainedIntent.inputDigest !== inputDigest;
      if (comparison.changed.length || comparison.unavailable.length || changedDuringAmendment) {
        const qaHead = db.qaTicketHead(runId, workId);
        if (["completed", "waived", "finalizing", "turn-intended", "turn-uncertain", "remediation-intended", "remediation-uncertain"].includes(qaHead.state)) throw new Error("Active or finalized QA authority requires explicit recovery/reopen before contract amendment");
        if (!priorBudget) throw new Error("Retained contract lacks its preparation budget; explicit recovery is required before amendment");
        const budget = priorBudget;
        if (retainedIntent?.inputDigest !== inputDigest || retainedIntent.predecessorDigest !== old.contentDigest) store.beginAmendment(budget, inventory, { reason: `Canonical authorized inputs changed: ${[...comparison.changed, ...comparison.unavailable].join(", ") || "inputs reverted during amendment"}`, inputDigest, predecessorDigest: old.contentDigest });
        amendmentPredecessor = old.contentDigest;
      }
    }
    const hostBaseline = { id: "host-preimplementation-source", sourceDigest: source.digest, phase: "preimplementation-host-capture", runtime: "Rafi host", procedure: "Host-captured source identity and per-file path manifest before Builder edits", observedAt: source.capturedAt, status: "passed" as const, evidenceDigest: baselineEvidence, relevance: `Authoritative comparison basis for unchanged-file and scope checks; exact host-owned path-manifest digest is ${preimplementationPathManifestDigest}`, expectedTransition: "Rafi compares the complete postimplementation path inventory with this host-owned baseline; providers do not need the raw manifest" };
    const initial: QaContractCandidateV1 = { version: 1, contractId: head.digest ? store.contract(head.digest).contractId : `contract:${contractDigest("contract-family", { runId, workId, admission: admission.requirementsDigest })}`, revision: head.digest ? store.contract(head.digest).revision + (amendmentPredecessor ? 1 : 0) : 1,
      ...(amendmentPredecessor ? { predecessorDigest: amendmentPredecessor } : {}),
      runId, workId, admissionDigest: admission.requirementsDigest, depthDecision: ticket.qa_preparation as QaPreparationDepthDecisionV1,
      documentation: structuredClone(ticket.documentation ?? { required: false, targets: [], criteria: [] }),
      inputs, baseline: [hostBaseline], requirements: inventory, checks: [], coverage: [], preparationEvidence: [], unresolved: [], createdAt: new Date(priorBudget?.startMs ?? Date.now()).toISOString() };
    const buildRun = readBuildRuns(projectDir).find(run => run.runId === runId);
    const deliveryFact = buildRun?.branchMode === "current"
      ? "Host-owned delivery-mode fact: this admitted build uses current-branch semantics. Do not require an isolated ticket branch, a multiply-only branch, branch identity, or a branch-alone test merely to prove additive ticket independence. HEAD may predate already completed sibling tickets, so never use git status, git diff HEAD, or a HEAD-based whole-tree comparison as the ticket-scope proof. Evaluate independence with the host-captured preimplementation baseline observation, approved product-path scope, ticket-owned tests, and permitted project tests. An isolated execution remains required only if the original approved requirement explicitly says so."
      : buildRun?.branchMode === "per-ticket"
        ? "Host-owned delivery-mode fact: this admitted build uses isolated branch-per-ticket semantics. Verify branch/worktree identity when the contract requires it; do not infer it from the independent QA snapshot."
        : "Host-owned delivery-mode fact: delivery mode was not available from the authoritative build record; do not invent branch-isolation requirements without an explicit approved requirement.";
    const result = await prepareVerificationContract(initial, inventory, {
      provider: builder.agent,
      store, now: Date.now, hostFacts: `${qaHostGraphFact(projectDir)}\n${deliveryFact}\nHost-owned baseline fact: Rafi captured the complete preimplementation per-file path manifest and will perform the exact unchanged-file and scope comparison. Its digest is ${preimplementationPathManifestDigest}. Do not require the provider to receive or reproduce the raw manifest; cite the retained host-preimplementation-source observation and assess the host comparison result instead. Do not author a provider-executed check for Rafi's host postimplementation path manifest, complete changed-path inventory, or unchanged-file comparison; Rafi performs that comparison outside the provider snapshot. Ordinary approved product paths, exports, and tests are not a material QA concern merely because the provider cannot prove whether they were present before implementation; Rafi owns that comparison. Do not reconstruct or disclose the full baseline. For current-branch additive tickets, a provider-authored or inferred request to test the branch with an already-completed sibling feature removed is not an applicable requirement when the approved scope says not to remove or reconstruct that sibling; verify the ticket's own behavior and tests against the shared baseline instead. Treat sibling-absence testing as binding only when the user explicitly approved that absence requirement. Escalate only an actual host-observed out-of-scope, destructive, protected-file, or requirement-relevant change.`,
      normalizeDraft: (draft, response) => {
        // The dispatch already retains the selected contract digest. Do not
        // recursively embed its validator/schema in every evidence summary.
        const { output, ...providerReceipt } = response;
        const investigationEvidence = store.putArtifact("investigation-evidence", {
          ...providerReceipt,
          ...(output ? { selectedContract: { operation: output.operation, schemaVersion: output.schemaVersion, schemaDigest: output.schemaDigest } } : {}),
        });
        const normalized = allocateStableCheckIds(bindUniqueBaselineCheckIds(normalizeGraphQaChecks(ensureHostScopeCheck(draft, hostBaseline.id), loadGraphConfig(projectDir).enabled)));
        if (!normalized.baseline.some(observation => observation.id === hostBaseline.id)) normalized.baseline.unshift(structuredClone(hostBaseline));
        for (const check of normalized.checks) for (const method of check.verification) {
          if (response.workspacePaths && Object.hasOwn(response.workspacePaths, method.cwd)) method.cwd = response.workspacePaths[method.cwd]!;
        }
        for (const observation of normalized.baseline) {
          const original = structuredClone(observation);
          observation.sourceDigest = source.digest;
          observation.observedAt = new Date().toISOString();
          observation.phase = "preimplementation-investigation";
          observation.evidenceDigest = store.putArtifact("baseline-observation", { observation: original, sourceDigest: source.digest, operationId: response.operationId, sessionId: response.sessionId, providerReceipt: investigationEvidence });
        }
        for (const evidence of normalized.preparationEvidence) {
          evidence.operationId = response.operationId!; evidence.sessionId = response.sessionId;
          delete evidence.graphReceiptRefs;
          if (response.graphReceiptRefs?.length) evidence.graphReceiptRefs = [...response.graphReceiptRefs];
          evidence.evidenceDigest = investigationEvidence;
          for (const reference of evidence.references) {
            if (response.workspacePaths && Object.hasOwn(response.workspacePaths, reference.path)) reference.path = response.workspacePaths[reference.path]!;
            let path: string;
            try { path = realpathSync(resolve(workspace, reference.path)); }
            catch { throw new Error(`Inspected source reference ${JSON.stringify(reference.path)} is missing or inaccessible; cite an existing file actually inspected in the frozen workspace`); }
            const root = realpathSync(workspace);
            if (!path.startsWith(root + sep)) throw new Error("Inspected source reference escapes actual workspace");
            try { reference.digest = createHash("sha256").update(readFileSync(path)).digest("hex"); }
            catch { throw new Error(`Inspected source reference ${JSON.stringify(reference.path)} is not a readable file`); }
          }
        }
        return normalized;
      },
      inputsCurrent: candidate => {
        if (db.assertAdmittedWork(runId, workId).requirementsDigest !== admission.requirementsDigest) return false;
        const currentSource = captureBuildSource(workspace);
        if (currentSource.contentDigest !== source.contentDigest) return false;
        const current = resolveEffectiveQaConfiguration(projectDir, { make: state?.qa?.settings?.make ?? builder.agent });
        const compared = compareContractInputs(candidate as import("rafi-spec").QaVerificationContractV1, inputs.map(input => input.id === "effective-rules" ? { ...input, digest: current.digest } : input.id === "project-checklist" ? { ...input, digest: contractDigest("input-checklist", current.checklist) } : input.id === "preimplementation-source" ? { ...input, digest: currentSource.digest, revision: currentSource.head } : input));
        return !compared.changed.length && !compared.unavailable.length;
      },
      dispatch: async (phase, instruction, operationId, remainingMs, output) => new OperationDeadline("QA preparation operation", remainingMs).run(async () => {
        const started = performance.now();
        const remaining = () => {
          const value = remainingMs - (performance.now() - started);
          if (value <= 0) throw new Error("QA preparation deadline expired during session setup; completion is unknown");
          return value;
        };
        const before = captureBuildSource(workspace);
        if (phase === "planner") {
          const role = await createRoleBuilder({ projectDir: workspace, configRoot: projectDir, role: "planner", label: "QA depth assessment", sandboxMode: "read-only", permissionConfig: readOnlyPermissionConfig(), yes: true, allowSwitch: false });
          try {
            const turn = await sendPreparationGraphTurn(role.builder, `This is a read-only QA planning subturn, not Builder work. Do not implement anything, edit files, run project tests, or describe a TDD implementation plan. Return the requested native depth result.\n${instruction}\nFrozen admitted work definition: ${JSON.stringify(ticket)}\nOriginal approved plan context: ${JSON.stringify(planInput?.plan ?? null)}\nFrozen effective configuration reference (authoritative requirements are in the candidate): ${JSON.stringify(preparationConfigurationReference(effective))}`, { phase, projectDir, workspace, sourceRef: before.digest, runId, workId, operationId, remainingMs: remaining(), output });
            store.event(runId, workId, `${operationId}:raw`, "preparation-provider-return", turn);
            if (captureBuildSource(workspace).contentDigest !== before.contentDigest) throw new Error("Product source changed during confined planning; reconcile retained dispatch");
            const payload = preparationTurnPayload(turn);
            if (turn.isError || turn.failure || !role.builder.sessionId()) throw new Error(`planner-unavailable: ${turn.text}`);
            return { text: payload.text, structured: turn.structured, output, graphReceiptRefs: turn.graphReceiptRefs, sessionId: role.builder.sessionId()!, usage: { inputTokens: turn.usage?.scope === "turn-delta" ? turn.usage.inputTokens : turn.inputTokens, outputTokens: turn.usage?.scope === "turn-delta" ? turn.usage.outputTokens : turn.outputTokens, costUsd: turn.costAuthoritative ? turn.costUsd : undefined } };
          } finally { await role.builder.close(); }
        }
        const snapshot = await createDisposableQaSnapshotAsync(workspace);
        let adapter: BuilderAdapter | undefined;
        try {
          remaining();
          const prerequisites = await checkQaPrerequisites({ snapshotPath: snapshot.path, sourceDigest: snapshot.frozenState.digest, ticket });
          const prerequisiteDigest = db.putEvidence("qa", Buffer.from(JSON.stringify(prerequisites)));
          remaining();
          if (qaFactory) adapter = (await qaFactory(snapshot.path)).adapter;
          else adapter = (await createRoleBuilder({ projectDir: snapshot.path, configRoot: projectDir, role: "qa", agent: state?.qa?.settings?.make ?? builder.agent, preloadedSkillContent: effective.skills.map(skill => ({ name: skill.name, content: skill.content })), label: "QA preparation", sandboxMode: "read-only", permissionConfig: readOnlyPermissionConfig(), yes: true, allowSwitch: false })).builder;
          const turn = await sendPreparationGraphTurn(adapter, `${instruction}\nOriginal approved plan context: ${JSON.stringify(planInput?.plan ?? null)}\nFrozen admitted work definition: ${JSON.stringify(ticket)}\nHost early prerequisite observations (host availability is not provider access; classify readiness versus final-only dependencies): ${JSON.stringify({ ...prerequisites, evidenceDigest: prerequisiteDigest })}\nFrozen effective configuration reference (the exact QA rules and skills are already loaded as immutable system context; authoritative requirements are in the inventory): ${JSON.stringify(preparationConfigurationReference(effective))}\nOperation: ${operationId}; remaining wall time: ${remainingMs}ms; source: ${source.digest}`, { phase, projectDir, workspace: snapshot.path, accessWorkspace: workspace, sourceRef: snapshot.frozenState.digest, runId, workId, operationId, remainingMs: remaining(), output });
          store.event(runId, workId, `${operationId}:raw`, "preparation-provider-return", turn);
          const payload = preparationTurnPayload(turn);
          payload.text = normalizeSnapshotPaths(payload.text);
          if (turn.isError || turn.failure || !adapter.sessionId()) throw new Error(`Preparation provider unavailable: ${turn.text}`);
          if (captureBuildSource(workspace).contentDigest !== before.contentDigest) throw new Error("Source changed during preparation; retained dispatch requires reconciliation");
          return { text: payload.text, structured: turn.structured, output, graphReceiptRefs: turn.graphReceiptRefs, sessionId: adapter.sessionId()!, workspacePaths: mapSnapshotWorkingDirectories(operationPayload<Partial<QaContractCandidateV1>>(turn, output), snapshot.path), usage: { inputTokens: turn.usage?.scope === "turn-delta" ? turn.usage.inputTokens : turn.inputTokens, outputTokens: turn.usage?.scope === "turn-delta" ? turn.usage.outputTokens : turn.outputTokens, costUsd: turn.costAuthoritative ? turn.costUsd : undefined } };
        } finally { try { await adapter?.close(); } finally { await snapshot.remove(); } }
      }),
    });
    if (result.status !== "ready") {
      if (policy.mode === "shadow") return "";
      const budget = store.budget(runId, workId, admission.requirementsDigest);
      if (budget && /budget exhausted|allowance exhausted|deadline expired/i.test(result.detail)) {
        const decision = db.ensureHumanDecision({ runId, decisionKey: `qa-preparation-extension:${budget.id}:${budget.deadlineMs}:${budget.extensions.length}`, interruptionId: `qa-preparation:${budget.id}`, prompt: `Preparation allowance exhausted. Additional time/rounds require an operational extension, preserving depth, scope, original start and all consumed/uncertain dispatches. Supply JSON {"budgetId":"${budget.id}","reason":"operator reason","deadlineMs":<absolute epoch milliseconds>,"caps":{"investigation":<total round ceiling>,"assessment":<total round ceiling>}}. Current budget: ${JSON.stringify(budget)}`, choices: [{ id: "custom", label: "Provide a scoped operational extension using --answer" }] });
        throw new Error(`QA preparation ${result.status}: ${result.detail}. Answer ${decision.decisionId} with rafi build:decide --run ${runId} --decision ${decision.decisionId} --choice custom --answer '<scoped JSON>', then resume. Uncertain dispatches still require reconciliation.`);
      }
      throw new Error(`QA preparation ${result.status}: ${result.detail}. ${result.nextAction}`);
    }
    amendmentPredecessor = result.contract.predecessorDigest;
    if (amendmentPredecessor && !store.eventRecord(`amendment:${result.contract.contentDigest}`)) {
      db.atomic(() => {
        db.invalidateUnconsumedQaPassCertificates(runId, workId, "contract-amended");
        db.markQaReportsRecheckRequired(runId, workId, "contract-amended");
        const qaHead = db.qaTicketHead(runId, workId);
        db.transitionQa(runId, workId, qaHead.revision, { type: "contract-amended", predecessorDigest: amendmentPredecessor!, contractDigest: result.contract.contentDigest, reason: "Canonical authorized input reconciliation" });
        store.metric(runId, workId, admission.requirementsDigest, `metric:amendment:${result.contract.contentDigest}`, "amendment");
        store.event(runId, workId, `amendment:${result.contract.contentDigest}`, "contract-amendment", { predecessorDigest: amendmentPredecessor, contractDigest: result.contract.contentDigest, evidenceCarryForward: [], disposition: "All final checks require independent current-source review; no evidence silently carried" });
      });
    }
    if (policy.mode === "shadow") return "";
    await builder.prepareSession?.();
    try { assertContractReceipt(store, runId, workId, admission.requirementsDigest, actualContractSession(builder, workspace, projectDir), builder); }
    catch { await deliverVerificationContract(result.contract, store, builder, workspace, projectDir, renderBuildWorkContext(ticket, effective.checklist)); }
    return `${renderVerificationContract(result.contract)}\n${BUILDER_WORK_COVERAGE_INSTRUCTIONS}`;
  } finally { db.close(); }
}
