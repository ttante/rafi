import { QA_RISK_MINIMUMS, qaContractCandidateV1Schema, qaSemanticAssessmentV1Schema, qaChallengeReceiptV1Schema, qaPreparationDepthDecisionV1Schema } from "rafi-spec";
import { randomUUID } from "node:crypto";
import type { QaContractCandidateV1, QaPreparationDepthDecisionV1, QaSemanticAssessmentV1, QaChallengeReceiptV1, RequirementRef, QaVerificationContractV1 } from "rafi-spec";
import type { QaPreparationStore, LogicalPreparationBudget } from "./qaPreparationStore.js";
import { depthObligations, validateDepthDecision } from "./qaPreparationPolicy.js";
import { canonicalContractJson, assembleContract, draftDigest, inventoryDigest, parsePreparationArtifact, validateCandidate } from "./qaVerificationContract.js";

export interface PreparationProviderResult { operationId?: string; text: string; sessionId: string; graphReceiptRefs?: string[]; usage?: Partial<LogicalPreparationBudget["usage"]> }
export interface PreparationDependencies {
  store: QaPreparationStore; now(): number;
  /** Each dispatch is a fresh, confined conversation, with a persisted reservation. */
  dispatch(phase: "planner" | "prepare" | "assess" | "challenge" | "repair", instruction: string, operationId: string, remainingMs: number): Promise<PreparationProviderResult>;
  inputsCurrent(candidate: QaContractCandidateV1): boolean;
  normalizeDraft?(draft: QaContractCandidateV1, response: PreparationProviderResult): QaContractCandidateV1;
}
export type PreparationOutcome = { status: "ready"; contract: QaVerificationContractV1 } | { status: "incomplete" | "blocked" | "uncertain"; detail: string; nextAction: string };

export async function prepareVerificationContract(initial: QaContractCandidateV1, inventory: RequirementRef[], deps: PreparationDependencies): Promise<PreparationOutcome> {
  const store = deps.store;
  const head = store.head(initial.runId, initial.workId, initial.admissionDigest);
  if (head.state === "ready" && head.digest) {
    const contract = store.contract(head.digest);
    if (deps.inputsCurrent(contract)) return { status: "ready", contract };
    store.setState(initial.runId, initial.workId, initial.admissionDigest, "amendment-required", "Relevant authoritative inputs changed", head.generation);
    return { status: "blocked", detail: "Contract amendment required", nextAction: "Reconcile changed inputs and retained evidence before publishing a successor" };
  }
  const decisionIssues = initial.depthDecision ? validateDepthDecision(initial.depthDecision) : ["Missing planner depth assessment"];
  // Missing decisions begin with Standard's ceiling, never the synthetic Low placeholder.
  const budget = store.ensureBudget(initial.runId, initial.workId, initial.admissionDigest, decisionIssues.length ? 2 : initial.depthDecision.level, deps.now());
  const unresolvedDispatch = budget.reservations.find(item => !item.resultDigest);
  if (unresolvedDispatch) return { status: "uncertain", detail: head.detail ?? `Uncertain preparation dispatch ${unresolvedDispatch.operationId}`, nextAction: "Reconcile retained provider receipt before retrying" };
  const retained = store.progress<{ candidate: QaContractCandidateV1; authorSessionId: string }>(budget, "draft");
  const priorAssessment = store.progress<QaSemanticAssessmentV1>(budget, "assessment");
  const priorChallenge = store.progress<QaChallengeReceiptV1>(budget, "challenge");
  const targetedConcerns = [...(priorAssessment?.concerns ?? []), ...(priorChallenge?.concerns ?? []), ...(priorChallenge?.approachConcerns ?? [])].filter(concern => concern.material);
  const retainedDepth = store.progress<QaPreparationDepthDecisionV1>(budget, "depth-decision");
  store.retainProgress(budget, "inventory", inventory);
  let candidate = retained ? structuredClone(retained.candidate) : structuredClone(initial);
  if (retainedDepth) candidate.depthDecision = retainedDepth;
  if (retained && canonicalContractJson(candidate.inputs) !== canonicalContractJson(initial.inputs)) return { status: "blocked", detail: "Retained draft inputs changed", nextAction: "Reconcile authoritative input changes" };
  const run = async (phase: Parameters<PreparationDependencies["dispatch"]>[0], kind: LogicalPreparationBudget["reservations"][number]["kind"], instruction: string, resultId?: string): Promise<PreparationProviderResult> => {
    const operationId = `qa-preparation:${randomUUID()}`;
    store.setState(initial.runId, initial.workId, initial.admissionDigest, ["assess", "challenge"].includes(phase) ? "validating" : "preparing", `Read-only ${phase} operation intended`, store.head(initial.runId, initial.workId, initial.admissionDigest).generation);
    store.reserve(budget, operationId, kind, { phase, instruction, inputDigest: inventoryDigest(inventory) }, deps.now(), resultId);
    const current = store.budget(initial.runId, initial.workId, initial.admissionDigest)!;
    const dispatchedAt = deps.now();
    const result = await deps.dispatch(phase, instruction, operationId, Math.max(1, current.deadlineMs - deps.now()));
    store.retainResult(budget, operationId, result, result.usage);
    store.metric(initial.runId, initial.workId, initial.admissionDigest, `metric:preparation-operation:${operationId}`, kind === "repair" ? "format-repair" : "phase-observation", { phase: phase === "planner" ? "planning" : phase === "challenge" ? "challenge" : phase === "repair" ? "repair" : "preparation", durationMs: Math.max(0, deps.now() - dispatchedAt), costUsd: result.usage?.costUsd ?? null, inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null });
    if (deps.now() >= current.deadlineMs) throw new Error("Preparation deadline expired; partial evidence retained");
    return { ...result, operationId };
  };
  const parsed = async <T>(result: PreparationProviderResult, tag: string): Promise<T> => {
    let response = result;
    for (let repair = 0; ; repair++) {
      try { return parsePreparationArtifact<T>(response.text, tag); }
      catch (error) {
        if (repair >= 2) throw error;
        response = await run("repair", "repair", `Format-only repair; no investigation, tools, or scope changes. Return the exact retained result as one ${tag}_START JSON ${tag}_END envelope.\nRetained response:\n${response.text}`, result.operationId ?? result.sessionId);
      }
    }
  };
  try {
    if (!retained && !retainedDepth && decisionIssues.length) {
      const response = await run("planner", "planning", `Read-only depth assessment of admitted scope. Select Standard or higher unless explicit Focused low-risk evidence is established. Return RAFI_QA_DEPTH_START/END with QaPreparationDepthDecisionV1. Schema: ${JSON.stringify(qaPreparationDepthDecisionV1Schema)}. Policy qa-preparation-v1. Host minimums: interactions/compatibility/state/external dependencies=3; authorization/security/data/migration/concurrency/recovery/deployment=4; unresolved architectural uncertainty=5.\n${JSON.stringify(initial)}`);
      candidate.depthDecision = await parsed<QaPreparationDepthDecisionV1>(response, "RAFI_QA_DEPTH");
      candidate.depthDecision.plannerOperationId = response.operationId!; candidate.depthDecision.plannerIdentity = response.sessionId;
      const issues = validateDepthDecision(candidate.depthDecision); if (issues.length) throw new Error(`depth-decision-incomplete: ${issues.join("; ")}`);
      store.reviseDepth(budget, candidate.depthDecision);
    } else store.reviseDepth(budget, candidate.depthDecision);
    store.retainProgress(budget, "depth-decision", candidate.depthDecision);
    let authorSessionId = retained?.authorSessionId ?? "";
    for (let pass = 0; pass < (candidate.depthDecision.level <= 2 ? 2 : 3) && (!retained || targetedConcerns.length > 0 || validateCandidate(candidate, inventory, store.equivalentResolver()).length > 0); pass++) {
      const response = await run("prepare", "investigation", `QA preparation only. Inspect relevant source/tests; do not implement, install dependencies, or expand admitted product scope. Return RAFI_QA_CANDIDATE_START/END with a complete QaContractCandidateV1. Schema: ${JSON.stringify(qaContractCandidateV1Schema)}. Preserve host identity, inputs, depth and every authoritative inventory requirement exactly. Supply concrete check methods/evidence, complete coverage and cited investigation for each obligation. No disposition or waiver can be agent-authored. If risks exceed selected depth, return a separate RAFI_QA_ESCALATION_START/END JSON block {"rationale":"...","riskFactors":[{"category":"...","rationale":"...","references":["..."]}]}; do not change the depth yourself.\nPreviously retained independent concerns requiring targeted investigation and concrete resolution: ${JSON.stringify(targetedConcerns)}\nRequired obligations: ${depthObligations(candidate.depthDecision.level).join(", ")}\nAuthoritative candidate/input inventory:\n${JSON.stringify(candidate)}`);
      const draft = await parsed<QaContractCandidateV1>(response, "RAFI_QA_CANDIDATE");
      if (draft.runId !== candidate.runId || draft.workId !== candidate.workId || draft.admissionDigest !== candidate.admissionDigest || draft.contractId !== candidate.contractId || draft.revision !== candidate.revision || draft.predecessorDigest !== candidate.predecessorDigest || draft.createdAt !== candidate.createdAt || canonicalContractJson(draft.depthDecision) !== canonicalContractJson(candidate.depthDecision) || canonicalContractJson(draft.inputs) !== canonicalContractJson(candidate.inputs)) throw new Error("Preparation changed host-owned identity/depth/input authority");
      candidate = deps.normalizeDraft ? deps.normalizeDraft(draft, response) : draft; authorSessionId = response.sessionId;
      for (const evidence of candidate.preparationEvidence) { evidence.operationId = response.operationId!; evidence.sessionId = response.sessionId; }
      if (response.text.includes("RAFI_QA_ESCALATION_START")) {
        const request = parsePreparationArtifact<{ rationale: string; riskFactors: QaPreparationDepthDecisionV1["riskFactors"] }>(response.text, "RAFI_QA_ESCALATION");
        if (!request.rationale?.trim() || !request.riskFactors?.length || request.riskFactors.some(risk => !(risk.category in QA_RISK_MINIMUMS) || !risk.references?.length)) throw new Error("Incomplete risk escalation evidence");
        const minimum = Math.max(candidate.depthDecision.level, ...request.riskFactors.map(risk => QA_RISK_MINIMUMS[risk.category]));
        const revision = await run("planner", "escalation", `Revise only the QA depth for this admitted scope. Do not expand product scope. Host minimum ${minimum}; keep predecessorDecisionId ${candidate.depthDecision.decisionId}. Return RAFI_QA_DEPTH_START/END following ${JSON.stringify(qaPreparationDepthDecisionV1Schema)}. Previous decision: ${JSON.stringify(candidate.depthDecision)}; cited risk evidence: ${JSON.stringify(request)}`);
        const decision = await parsed<QaPreparationDepthDecisionV1>(revision, "RAFI_QA_DEPTH"); decision.plannerIdentity = revision.sessionId; decision.plannerOperationId = revision.operationId!;
        const errors = validateDepthDecision(decision, candidate.depthDecision);
        if (decision.level < minimum || request.riskFactors.some(risk => !decision.riskFactors.some(actual => actual.category === risk.category))) errors.push("Planner revision does not address evidenced risk minimum");
        if (errors.length) throw new Error(`depth-decision-incomplete: ${errors.join("; ")}`);
        candidate.depthDecision = decision; store.reviseDepth(budget, decision); store.retainProgress(budget, "depth-decision", decision); continue;
      }
      const structural = validateCandidate(candidate, inventory, store.equivalentResolver());
      if (!structural.length) break;
      candidate.unresolved.push({ reason: structural.join("; "), requirementIds: [], checkIds: [], material: true, owner: "qa", nextAction: "Targeted investigation to resolve contract validation gaps" });
    }
    store.retainProgress(budget, "draft", { candidate, authorSessionId });
    const structural = validateCandidate(candidate, inventory, store.equivalentResolver()); if (structural.length) throw new Error(`Contract incomplete: ${structural.join("; ")}`);
    const binding = { draftPayloadDigest: draftDigest(candidate), inventoryDigest: inventoryDigest(candidate.requirements), policyVersion: candidate.depthDecision.policyVersion, authorSessionId };
    const retainedAssessment = store.progress<QaSemanticAssessmentV1>(budget, "assessment");
    const assessmentResponse = retainedAssessment?.draftPayloadDigest === draftDigest(candidate) ? undefined : await run("assess", "assessment", `Independent semantic assessment in a fresh conversation. Assess each original requirement and selected-depth obligation; identify omissions, conflicts, practical verification gaps, accidental scope, and unsupported dispositions. Return RAFI_QA_ASSESSMENT_START/END with QaSemanticAssessmentV1 (schema: ${JSON.stringify(qaSemanticAssessmentV1Schema)}) and specific material concerns (empty only when resolved). Bind exactly ${JSON.stringify(binding)}.\nPrior independent concerns requiring concrete resolution evidence: ${JSON.stringify(targetedConcerns)}\nOriginal inventory:\n${JSON.stringify(inventory)}\nDraft:\n${JSON.stringify(candidate)}`);
    const assessment = assessmentResponse ? await parsed<QaSemanticAssessmentV1>(assessmentResponse, "RAFI_QA_ASSESSMENT") : retainedAssessment!;
    if (assessmentResponse) { assessment.sessionId = assessmentResponse.sessionId; assessment.operationId = assessmentResponse.operationId!; }
    store.retainProgress(budget, "assessment", assessment);
    let challenge = store.progress<QaChallengeReceiptV1>(budget, "challenge");
    if (challenge?.draftPayloadDigest !== draftDigest(candidate)) challenge = undefined;
    if (candidate.depthDecision.level === 5 && !challenge) {
      const response = await run("challenge", "challenge", `Independent approach challenge, fresh assessor conversation. Planning only. Return RAFI_QA_CHALLENGE_START/END with QaChallengeReceiptV1 (schema: ${JSON.stringify(qaChallengeReceiptV1Schema)}): independently critique the author's retained approach-proposal evidence (do not author a replacement), independent contract conclusions and separate approachConcerns for scope, invariants, failure-boundaries, verification. Unresolved material concerns prevent readiness. Binding: ${JSON.stringify(binding)}. Previously retained concerns requiring concrete resolution: ${JSON.stringify(targetedConcerns)}.\n${JSON.stringify(candidate)}`);
      challenge = await parsed<QaChallengeReceiptV1>(response, "RAFI_QA_CHALLENGE"); challenge.sessionId = response.sessionId; challenge.operationId = response.operationId!; store.retainProgress(budget, "challenge", challenge);
    }
    const contract = assembleContract(candidate, inventory, assessment, authorSessionId, challenge, store.equivalentResolver());
    store.putArtifact("semantic-assessment", assessment); if (challenge) store.putArtifact("approach-challenge", challenge);
    if (!deps.inputsCurrent(candidate)) throw new Error("Authoritative preparation inputs changed before publication");
    store.publish(contract, store.head(initial.runId, initial.workId, initial.admissionDigest).generation, deps.now());
    store.event(initial.runId, initial.workId, `prepared:${contract.contentDigest}`, "preparation-ready", { contractDigest: contract.contentDigest, level: contract.depthDecision.level });
    return { status: "ready", contract };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const current = store.budget(initial.runId, initial.workId, initial.admissionDigest)!;
    const status = current.reservations.some(reservation => !reservation.resultDigest) ? "uncertain" : "incomplete";
    store.setState(initial.runId, initial.workId, initial.admissionDigest, status, detail, store.head(initial.runId, initial.workId, initial.admissionDigest).generation);
    store.metric(initial.runId, initial.workId, initial.admissionDigest, `metric:preparation-failure:${current.id}:${current.reservations.length}`, "preparation-failure", { status: "blocked" });
    store.event(initial.runId, initial.workId, `preparation-failure:${current.id}:${current.reservations.length}`, "preparation-failure", { status, detail });
    return { status, detail, nextAction: status === "uncertain" ? "Reconcile retained provider dispatch; do not replay uncertain work" : "Resolve remaining concerns or record authorized operational extension, then retry" };
  }
}
