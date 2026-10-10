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
import type { BuilderAdapter } from "./adapters/types.js";
import type { QaSessionHandle } from "./qaReview.js";
import { WorkflowDb } from "./workflowDb.js";
import { createRoleBuilder, readOnlyPermissionConfig } from "./agentRun.js";
import { captureBuildSource, assertBuildAssignmentReconciled, BuildAssignmentRejected } from "./buildAssignment.js";
import { createDisposableQaSnapshotAsync } from "./qaSnapshot.js";
import { allocateStableCheckIds, authoritativeInventory, contractDigest, renderVerificationContract } from "./qaVerificationContract.js";
import { loadQaPreparationPolicy, resolveEffectiveQaConfiguration } from "./qaEffectiveConfig.js";
import { prepareVerificationContract } from "./qaPreparation.js";
import { actualContractSession, assertContractReceipt, deliverVerificationContract } from "./qaContractDelivery.js";
import { COVERAGE_INSTRUCTIONS } from "./qaContractCoverage.js";
import { renderBuildWorkContext } from "./buildWorkContext.js";
import { compareContractInputs } from "./qaContractFreshness.js";
import type { TicketDef } from "./tickets/ticketSchema.js";

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
    if (policy.mode === "enforce" && !builder.contractCapabilities?.().nativeCompactionBarrier) throw new Error(`unsupported-capability: ${builder.agent} enforcement requires proven native-compaction delivery continuity`);
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
        const budget = priorBudget!;
        if (retainedIntent?.inputDigest !== inputDigest || retainedIntent.predecessorDigest !== old.contentDigest) store.beginAmendment(budget, inventory, { reason: `Canonical authorized inputs changed: ${[...comparison.changed, ...comparison.unavailable].join(", ") || "inputs reverted during amendment"}`, inputDigest, predecessorDigest: old.contentDigest });
        amendmentPredecessor = old.contentDigest;
      }
    }
    const initial: QaContractCandidateV1 = { version: 1, contractId: head.digest ? store.contract(head.digest).contractId : `contract:${contractDigest("contract-family", { runId, workId, admission: admission.requirementsDigest })}`, revision: head.digest ? store.contract(head.digest).revision + (amendmentPredecessor ? 1 : 0) : 1,
      ...(amendmentPredecessor ? { predecessorDigest: amendmentPredecessor } : {}),
      runId, workId, admissionDigest: admission.requirementsDigest, depthDecision: ticket.qa_preparation as QaPreparationDepthDecisionV1,
      inputs, baseline: [], requirements: inventory, checks: [], coverage: [], preparationEvidence: [], unresolved: [], createdAt: new Date(priorBudget?.startMs ?? Date.now()).toISOString() };
    const result = await prepareVerificationContract(initial, inventory, {
      store, now: Date.now,
      normalizeDraft: (draft, response) => {
        const normalized = allocateStableCheckIds(draft);
        for (const observation of normalized.baseline) {
          const original = structuredClone(observation);
          observation.sourceDigest = source.digest;
          observation.observedAt = new Date().toISOString();
          observation.phase = "preimplementation-investigation";
          observation.evidenceDigest = store.putArtifact("baseline-observation", { observation: original, sourceDigest: source.digest, operationId: response.operationId, sessionId: response.sessionId, providerReceipt: store.putArtifact("investigation-evidence", response) });
        }
        for (const evidence of normalized.preparationEvidence) {
          evidence.operationId = response.operationId!; evidence.sessionId = response.sessionId;
          delete evidence.graphReceiptRefs;
          if (response.graphReceiptRefs?.length) evidence.graphReceiptRefs = [...response.graphReceiptRefs];
          evidence.evidenceDigest = store.putArtifact("investigation-evidence", response);
          for (const reference of evidence.references) {
            const path = realpathSync(resolve(workspace, reference.path)), root = realpathSync(workspace);
            if (!path.startsWith(root + sep)) throw new Error("Inspected source reference escapes actual workspace");
            reference.digest = createHash("sha256").update(readFileSync(path)).digest("hex");
          }
        }
        return normalized;
      },
      inputsCurrent: candidate => {
        if (db.assertAdmittedWork(runId, workId).requirementsDigest !== admission.requirementsDigest) return false;
        const current = resolveEffectiveQaConfiguration(projectDir, { make: state?.qa?.settings?.make ?? builder.agent });
        const compared = compareContractInputs(candidate as import("rafi-spec").QaVerificationContractV1, inputs.map(input => input.id === "effective-rules" ? { ...input, digest: current.digest } : input.id === "project-checklist" ? { ...input, digest: contractDigest("input-checklist", current.checklist) } : input));
        return !compared.changed.length && !compared.unavailable.length;
      },
      dispatch: async (phase, instruction, operationId, remainingMs) => new OperationDeadline("QA preparation operation", remainingMs).run(async () => {
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
            const turn = await sendPreparationGraphTurn(role.builder, `${instruction}\nFrozen admitted work definition: ${JSON.stringify(ticket)}\nOriginal approved plan context: ${JSON.stringify(planInput?.plan ?? null)}\nFrozen effective configuration: ${JSON.stringify(effective)}`, { phase, projectDir, workspace, sourceRef: before.digest, runId, workId, operationId, remainingMs: remaining() });
            store.event(runId, workId, `${operationId}:raw`, "preparation-provider-return", turn);
            if (captureBuildSource(workspace).contentDigest !== before.contentDigest) throw new Error("Product source changed during confined planning; reconcile retained dispatch");
            if (turn.isError || turn.failure || !role.builder.sessionId()) throw new Error(`planner-unavailable: ${turn.text}`);
            return { text: turn.text, graphReceiptRefs: turn.graphReceiptRefs, sessionId: role.builder.sessionId()!, usage: { inputTokens: turn.usage?.scope === "turn-delta" ? turn.usage.inputTokens : turn.inputTokens, outputTokens: turn.usage?.scope === "turn-delta" ? turn.usage.outputTokens : turn.outputTokens, costUsd: turn.costAuthoritative ? turn.costUsd : undefined } };
          } finally { await role.builder.close(); }
        }
        const snapshot = await createDisposableQaSnapshotAsync(workspace);
        let adapter: BuilderAdapter | undefined;
        try {
          remaining();
          const prerequisites = await checkQaPrerequisites({ snapshotPath: snapshot.path, sourceDigest: snapshot.frozenState.digest, ticket });
          const prerequisiteDigest = db.putEvidence("qa", JSON.stringify(prerequisites));
          remaining();
          if (qaFactory) adapter = (await qaFactory(snapshot.path)).adapter;
          else adapter = (await createRoleBuilder({ projectDir: snapshot.path, configRoot: projectDir, role: "qa", agent: state?.qa?.settings?.make ?? builder.agent, preloadedSkillContent: effective.skills.map(skill => ({ name: skill.name, content: skill.content })), label: "QA preparation", sandboxMode: "read-only", permissionConfig: readOnlyPermissionConfig(), yes: true, allowSwitch: false })).builder;
          const turn = await sendPreparationGraphTurn(adapter, `${instruction}\nOriginal approved plan context: ${JSON.stringify(planInput?.plan ?? null)}\nFrozen admitted work definition: ${JSON.stringify(ticket)}\nHost early prerequisite observations (host availability is not provider access; classify readiness versus final-only dependencies): ${JSON.stringify({ ...prerequisites, evidenceDigest: prerequisiteDigest })}\nFrozen effective configuration: ${JSON.stringify(effective)}\nOperation: ${operationId}; remaining wall time: ${remainingMs}ms; source: ${source.digest}`, { phase, projectDir, workspace: snapshot.path, accessWorkspace: workspace, sourceRef: snapshot.frozenState.digest, runId, workId, operationId, remainingMs: remaining() });
          store.event(runId, workId, `${operationId}:raw`, "preparation-provider-return", turn);
          if (turn.isError || turn.failure || !adapter.sessionId()) throw new Error(`Preparation provider unavailable: ${turn.text}`);
          if (captureBuildSource(workspace).contentDigest !== before.contentDigest) throw new Error("Source changed during preparation; retained dispatch requires reconciliation");
          return { text: turn.text, graphReceiptRefs: turn.graphReceiptRefs, sessionId: adapter.sessionId()!, usage: { inputTokens: turn.usage?.scope === "turn-delta" ? turn.usage.inputTokens : turn.inputTokens, outputTokens: turn.usage?.scope === "turn-delta" ? turn.usage.outputTokens : turn.outputTokens, costUsd: turn.costAuthoritative ? turn.costUsd : undefined } };
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
    return `${renderVerificationContract(result.contract)}\n${COVERAGE_INSTRUCTIONS}\nCoverage binding: ${JSON.stringify({ phase: "builder", runId, workId, revision: result.contract.revision, contractDigest: result.contract.contentDigest })}`;
  } finally { db.close(); }
}
