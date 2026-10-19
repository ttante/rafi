import { QA_RISK_MINIMUMS, parseProviderContract, qaContractCandidateV1Schema, qaPreparationEscalationProposalV1Schema, qaSemanticAssessmentV1Schema, qaChallengeReceiptV1Schema, qaPreparationDepthDecisionV1Schema as qaDepthDecisionSchema } from "rafi-spec";
import { createHash, randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import type { QaContractCandidateV1, QaPreparationDepthDecisionV1, QaSemanticAssessmentV1, QaChallengeReceiptV1, RequirementRef, QaVerificationContractV1 } from "rafi-spec";
import type { QaPreparationStore, LogicalPreparationBudget } from "./qaPreparationStore.js";
const qaPreparationDepthDecisionV1Schema = qaSemanticAssessmentV1Schema;
import { depthObligations, validateDepthDecision } from "./qaPreparationPolicy.js";
import { canonicalContractJson, assembleContract, draftDigest, inventoryDigest, parsePreparationArtifact, validateAssessment, validateCandidate } from "./qaVerificationContract.js";

export interface PreparationProviderResult { operationId?: string; text: string; sessionId: string; graphReceiptRefs?: string[]; workspacePaths?: Record<string, string>; usage?: Partial<LogicalPreparationBudget["usage"]> }
export interface PreparationDependencies {
  store: QaPreparationStore; now(): number;
  /** Provider-specific wording is allowed; contract ownership is not. */
  provider?: "claude" | "codex";
  /** Each dispatch is a fresh, confined conversation, with a persisted reservation. */
  dispatch(phase: "planner" | "prepare" | "assess" | "challenge" | "repair", instruction: string, operationId: string, remainingMs: number): Promise<PreparationProviderResult>;
  inputsCurrent(candidate: QaContractCandidateV1): boolean;
  normalizeDraft?(draft: QaContractCandidateV1, response: PreparationProviderResult): QaContractCandidateV1;
  hostFacts?: string;
}
export type PreparationOutcome = { status: "ready"; contract: QaVerificationContractV1 } | { status: "incomplete" | "blocked" | "uncertain"; detail: string; nextAction: string };

export const FILE_SCOPE_GUIDANCE = `File lists in plans and tickets, including likely_files and generated file-only diff expectations, are estimates of implementation, not exhaustive boundaries. Different named files or an extra relevant file do not by themselves create a material conflict or block the build. Retain and assess every original requirement; for file-list checks verify that changes serve the approved work rather than requiring an exact file list or a pre-edit snapshot proving no other files changed. Rafi owns tracker lifecycle updates. Generated instructions to mark a ticket done in a document are bookkeeping, not a Builder acceptance criterion or a material conflict; do not require the Builder to perform them, and do not require the host to amend the plan before building. Do not disregard explicit user-established security, privacy, access, or other safety restrictions, or expand the approved product functionality. Report genuine substantive or safety conflicts.`;
export const ROLLBACK_VERIFICATION_GUIDANCE = `When an original requirement explicitly asks to verify that rollback restores behavior, specify concrete future verification evidence rather than only inspecting rollback prose. A rollback plan alone does not require a rollback execution or mutation-testing rehearsal. For an npm test project where current uncommitted product changes represent the change to rehearse, the Builder may run rafi qa-rehearse-rollback alone from the project root; it runs npm test before and after reverting a synthetic commit of all uncommitted product changes in an independent temporary repository. It also runs git diff --exit-code against the captured pre-change HEAD after the revert and tests; success proves the tracked files match that baseline. For a requirement that a particular string be absent after rollback, inspecting its absence in the captured baseline plus that successful whole-tree comparison is concrete evidence of absence in the reverted tracked file. The rehearsal cannot use installed dependencies or symbolic links and does not prove ticket isolation or that an actual existing ticket commit was reverted. Assess whether this evidence satisfies the original requirement; do not claim it does when the original explicitly requires the actual ticket commit. Do not assume copying files to external scratch, arbitrary scripts or mutation experiments are allowed. If actual rollback execution is explicitly required but no permitted method satisfies it, report the limitation. Never perform destructive rollback in the source workspace or claim a rehearsal has already happened.`;
export const EXECUTABLE_CHECK_GUIDANCE = `Choose verification procedures compatible with the Builder's project permissions and workspace. Documentation is disabled unless the host-bound contract documentation.required is true. When it is false, do not invent documentation checks merely because a docs directory or API-looking path exists; an absent documentation surface is not a failure. When it is true, use only the contract's exact targets and criteria, and define an actionable absent-target outcome. Do not invent mandatory inline node -e or node --eval commands: the Builder policy may refuse them. For a JavaScript behavior or export check, prefer a project-local test file executed with the project's existing test command, or a permitted node --test invocation. Do not invent a mandatory test-first RED phase or other historical sequence merely because a plan requires tests before and after implementation: a passing baseline test is not a failing new test. When an original requirement actually requires a historical sequence, preserve it and specify concrete independently reviewable evidence paths or retained host events for each required step; a generic statement that sequencing evidence exists is not actionable, and a later passing test does not prove past events. If the project policy makes raw stdout redirection or scratch-log creation unavailable, do not turn log-file capture into a blocker: use the retained bounded tool output and host events instead, and never cite a scratch path unless that exact file was successfully created and inspected. The independent QA snapshot may have a detached HEAD even when the Builder source workspace is on a branch; do not use its branch name to infer the Builder source branch. Diff and scope checks must compare the current snapshot with the captured pre-implementation baseline, not blindly with repository HEAD: previously approved or completed ticket changes are part of that baseline and must not be reported as new work. A scope check must first enumerate every changed path outside the explicit bookkeeping/evidence exclusions, then compare that complete host-observed set with the approved product/ticket scope; do not pre-filter the list to expected filenames, because that would hide accidental extra product edits. Bounded evidence-only paths such as scratch/ are not product scope and must be excluded from product-path scope checks while their retained evidence remains subject to QA review. For a current-branch multi-ticket build, do not invent a mandatory branch-alone execution check merely to prove ticket independence; use baseline-aware source/test inspection and the permitted project tests unless the original requirement explicitly requires an actual isolated execution. For additive tickets in a current-branch multi-ticket build, “acceptable on its own” is satisfied by showing that each ticket's own tests import and exercise only its own feature, pass with the shared baseline and required project tests, and do not depend on the sibling feature; do not require removing another additive feature or perform a destructive rollback experiment unless the approved requirement explicitly requires absence testing or an isolated branch. Preserve explicitly requested procedures and substantive requirements; if a required procedure cannot be run, identify the limitation rather than claiming it was executed. Independently assess whether proposed evidence actually tests the required behavior.`;

/** Baseline bookkeeping must not block ordinary approved implementation work. */
export const APPROVED_PATH_BASELINE_GUIDANCE = `Baseline membership is host-owned bookkeeping, not a Builder requirement. An approved product path, export, or test file is not a material QA concern merely because the provider cannot prove whether it was present before implementation. Do not reconstruct or disclose the full baseline, and do not turn that uncertainty into an unresolved concern. Rafi performs the exact host comparison. Do not author a provider-executed check that asks for Rafi's host postimplementation path manifest, complete changed-path inventory, or unchanged-file comparison; that host-owned comparison is already performed outside the provider snapshot and must be represented by the retained host observation, not by raw manifest disclosure or a provider check. For current-branch additive tickets, a provider-authored or inferred request to test the branch with an already-completed sibling feature removed is not an applicable requirement when the approved scope says not to remove or reconstruct that sibling; verify the ticket's own behavior and tests against the shared baseline instead. Treat sibling-absence testing as binding only when the user explicitly approved that absence requirement. Escalate only an actual host-observed out-of-scope, destructive, protected-file, or requirement-relevant change.`;

/** Ignore known non-authoritative annotations; the original provider response remains retained. */
export function normalizeAssessmentMetadata<T extends QaSemanticAssessmentV1>(assessment: T): T {
  const copy = { ...assessment } as T & { createdAt?: unknown; policyVersion_note?: unknown };
  delete copy.createdAt;
  delete copy.policyVersion_note;
  return copy;
}

/** Accept only an exact known obligation label when a provider wraps it in a
 * descriptive object. This is a representation repair, not a host decision:
 * unknown or ambiguous objects remain unchanged and fail schema validation. */
export function normalizeAssessmentObligations<T extends QaSemanticAssessmentV1>(assessment: T, allowed: string[]): T {
  const copy = structuredClone(assessment);
  if (!Array.isArray(copy.assessedObligations)) return copy;
  const known = new Set(allowed);
  copy.assessedObligations = copy.assessedObligations.map(item => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return item as never;
    const matches = Object.values(item as Record<string, unknown>).filter(value => typeof value === "string" && known.has(value));
    return matches.length === 1 ? matches[0]! : item as never;
  }) as unknown as string[];
  return copy;
}

/** A preparation assessor must not block on the expected absence of future
 * Builder work. Keep the concern for auditability, but make it non-material
 * only when every referenced check is postimplementation and the concern is
 * explicitly asking the Builder to implement/rerun that check. Concerns tied
 * to preimplementation checks, missing procedures, or other semantic gaps
 * remain blocking. */
export function normalizeExpectedFutureAssessment<T extends QaSemanticAssessmentV1>(assessment: T, candidate: QaContractCandidateV1): T {
  const copy = structuredClone(assessment);
  const checks = new Map(candidate.checks.map(check => [check.id, check]));
  copy.concerns = copy.concerns.map(concern => {
    if (!concern.material || !concern.checkIds.length || !concern.checkIds.every(id => checks.get(id)?.timing === "postimplementation")) return concern;
    const expectedFutureAbsence = /\b(absent|missing|not (?:yet )?(?:implemented|present|available)|could not find|not found|does not exist|fails? with)\b/i.test(concern.reason)
      && /\b(?:before|pre[- ]?builder|not yet)\b/i.test(concern.reason)
      && /\b(?:implement|add|create|rerun|re-?run|builder|after implementation)\b/i.test(concern.nextAction);
    return expectedFutureAbsence ? { ...concern, material: false } : concern;
  });
  return copy;
}

// The provider proposes verification work; the host owns contract identity,
// approved inputs, requirement text, depth, timestamps and evidence hashes.
const durableFields = qaContractCandidateV1Schema.properties;
const providerEvidence = { type: "object", additionalProperties: false, required: ["obligation", "references", "analysis"], properties: {
  obligation: { type: "string", minLength: 1 }, analysis: { type: "string", minLength: 1 },
  references: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["path", "locator"], properties: { path: { type: "string", minLength: 1 }, locator: { type: "string", minLength: 1 } } } },
} };
const providerBaseline = { type: "object", additionalProperties: false, required: ["id", "runtime", "procedure", "status", "relevance", "expectedTransition"], properties: {
  id: { type: "string", minLength: 1 }, checkId: { type: "string", minLength: 1 }, applicability: { enum: ["applicable", "not-applicable", "unresolved"] }, predicateEvidence: { type: "array", items: { type: "string" } }, runtime: { type: "string", minLength: 1 }, procedure: { type: "string", minLength: 1 }, status: { enum: ["passed", "failed", "blocked", "not-run"] }, relevance: { type: "string", minLength: 1 }, expectedTransition: { type: "string", minLength: 1 },
} };
const providerDraftSchema = { type: "object", additionalProperties: false, required: ["checks", "coverage", "baseline", "preparationEvidence", "unresolved"], properties: {
  checks: durableFields.checks, coverage: durableFields.coverage, baseline: { type: "array", items: providerBaseline }, preparationEvidence: { type: "array", minItems: 1, items: providerEvidence }, unresolved: durableFields.unresolved,
} };
const contractValidator = new Ajv({ allErrors: true });
const validateProviderDraft = contractValidator.compile(providerDraftSchema);
const validateAssessmentContract = contractValidator.compile(qaSemanticAssessmentV1Schema);
const validateChallengeContract = contractValidator.compile(qaChallengeReceiptV1Schema);

/** Providers sometimes echo host-owned evidence metadata into the draft. */
function normalizeProviderDraftMetadata(value: Partial<QaContractCandidateV1>): Partial<QaContractCandidateV1> {
  const copy = structuredClone(value);
  for (const evidence of copy.preparationEvidence ?? []) {
    const metadata = evidence as unknown as Record<string, unknown>;
    delete metadata.operationId;
    delete metadata.sessionId;
    delete metadata.evidenceDigest;
    delete metadata.graphReceiptRefs;
    for (const reference of evidence.references ?? []) delete (reference as unknown as Record<string, unknown>).digest;
  }
  return copy;
}

/**
 * A mandatory requirement must have at least one mandatory verification check.
 * Providers occasionally return a concrete check with the weaker advisory
 * label. Promote the existing covering check at the host boundary; never
 * invent a check, evidence, or requirement, and let the normal validator still
 * enforce readiness and independent-QA requirements for the promoted check.
 */
export function enforceMandatoryCoverage(candidate: QaContractCandidateV1): QaContractCandidateV1 {
  const copy = structuredClone(candidate);
  const requirementIds = new Set(copy.requirements.map(requirement => requirement.id));
  // Coverage is an explicit provider claim that a check verifies a
  // requirement. Make that claim internally consistent by retaining the
  // requirement on the check as well; do not add checks or coverage rows.
  for (const row of copy.coverage) {
    for (const checkId of row.checkIds) {
      const check = copy.checks.find(item => item.id === checkId);
      const hasUnknownReference = check?.requirementRefs.some(id => !requirementIds.has(id));
      if (check && !hasUnknownReference && requirementIds.has(row.requirementId) && !check.requirementRefs.includes(row.requirementId)) check.requirementRefs.push(row.requirementId);
    }
  }
  for (const requirement of copy.requirements) {
    if (requirement.obligation !== "mandatory") continue;
    const coverage = copy.coverage.find(row => row.requirementId === requirement.id);
    const covering = coverage?.checkIds
      .map(id => copy.checks.find(check => check.id === id))
      .find(check => check?.requirementRefs.includes(requirement.id));
    if (covering && covering.obligation !== "mandatory") covering.obligation = "mandatory";
  }
  return copy;
}

/**
 * Codex occasionally appends a made-up requirement ID to an otherwise valid
 * check. Remove only those extraneous annotations when the check still has an
 * exact authoritative reference. Never invent or remap an ID, and leave a
 * check with no valid references untouched so normal validation fails closed.
 */
export function removeExtraneousRequirementReferences(candidate: QaContractCandidateV1, inventory: RequirementRef[]): QaContractCandidateV1 {
  const copy = structuredClone(candidate);
  const allowed = new Set(inventory.map(requirement => requirement.id));
  for (const check of copy.checks) {
    const valid = check.requirementRefs.filter(id => allowed.has(id));
    if (valid.length > 0 && valid.length !== check.requirementRefs.length) check.requirementRefs = [...new Set(valid)];
  }
  return copy;
}

function providerBlocker(text: string, tag: string): string | undefined {
  // A refusal is not a malformed candidate and cannot be repaired by formatting.
  if (text.includes(`${tag}_START`) && text.includes(`${tag}_END`) && /\{[\s\S]*\}/.test(text.slice(text.indexOf(`${tag}_START`) + tag.length + 6, text.indexOf(`${tag}_END`)))) return undefined;
  if (!/\b(?:cannot|can't|unable|blocked|denied|not permitted|lack(?:s|ing) access)\b/i.test(text)) return undefined;
  const explanation = text.replace(/\s+/g, " ").trim().slice(0, 500);
  return `QA provider could not produce ${tag}: ${explanation}`;
}

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
  let correctionIssues: string[] = [];
  const run = async (phase: Parameters<PreparationDependencies["dispatch"]>[0], kind: LogicalPreparationBudget["reservations"][number]["kind"], instruction: string, resultId?: string): Promise<PreparationProviderResult> => {
    const effectivePhase = phase === "prepare" && correctionIssues.length > 0 ? "repair" : phase;
    if (phase === "assess") instruction = `This is QA PREPARATION semantic assessment before Builder work, not final QA. Do not emit RAFI_QA_FAILURE_REPORT, RAFI_QA_COVERAGE, QA findings, or STEP_STATUS; return only the requested RAFI_QA_ASSESSMENT envelope.\n\n${instruction}`;
    if (phase === "assess" && deps.provider === "codex") instruction = `Codex role boundary: you are the independent PRE-BUILD QA ASSESSOR. Do not perform or summarize final QA, do not report Builder results, and do not emit RAFI_QA_FAILURE_REPORT_START/END. Your only output is the requested RAFI_QA_ASSESSMENT_START/END object describing whether the proposed contract is complete before Builder work.\n\n${instruction}`;
    if (phase === "assess" && deps.provider === "claude") instruction = `Claude response contract: every concerns entry MUST be an object exactly shaped as {"reason":"...","requirementIds":["exact-id"],"checkIds":["exact-check-id"],"material":true,"owner":"qa","nextAction":"..."}. Never use a legacy summary field, string concerns, or fields such as severity, title, message, evidence, category, or resolution. If there are no concerns, use concerns: [].\n\n${instruction}`;
    if (phase === "prepare") instruction = `This is a fresh draft response. Use only check IDs declared in this response; do not copy allocated check IDs or baseline/coverage references from an earlier draft or correction attempt. Every check reference in prose, procedures, expected evidence, and mappings must use the exact check.id declared in this response; never use descriptive aliases such as qa-subtract-export. Rafi will allocate stable IDs after validating this response.\n\n${instruction}`;
    if (phase === "assess") instruction = `The authoritative scope is the exact inventory and admitted slice in this prompt. Plan-level acceptance or test criteria outside the admitted slice are context only and must not be reported as missing inventory requirements.\n\n${instruction}`;
    if (effectivePhase === "repair") instruction = `Targeted QA contract repair only. Preserve valid checks, methods, bindings, and evidence; change only what the validation issues require. Do not redo investigation, expand scope, invent evidence, or change host-owned fields. Return the complete corrected five-field draft.\n\n${instruction}`;
    if (["prepare", "assess", "challenge"].includes(phase) && deps.hostFacts) instruction = `${deps.hostFacts}\n\n${instruction}`;
    if (["prepare", "assess", "challenge"].includes(phase)) instruction = `${FILE_SCOPE_GUIDANCE}\n\n${instruction}`;
    if (["prepare", "assess", "challenge"].includes(phase)) instruction = `${EXECUTABLE_CHECK_GUIDANCE}\n\n${APPROVED_PATH_BASELINE_GUIDANCE}\n\nHost scope rule for current-branch multi-ticket builds: never use git status, git diff HEAD, or a HEAD-based whole-tree comparison as ticket-scope proof because HEAD may predate a completed sibling ticket. Use the host-captured preimplementation baseline observation and approved product paths/ticket-owned files.\n\n${instruction}`;
    if (["prepare", "assess", "challenge"].includes(phase)) instruction = `${ROLLBACK_VERIFICATION_GUIDANCE}\nThe Builder must invoke the exact launching CLI as: ${process.env.RAFI_REHEARSAL_COMMAND ?? "rafi qa-rehearse-rollback"}\n\n${instruction}`;
    const operationId = `qa-preparation:${randomUUID()}`;
    store.setState(initial.runId, initial.workId, initial.admissionDigest, ["assess", "challenge"].includes(phase) ? "validating" : "preparing", `Read-only ${phase} operation intended`, store.head(initial.runId, initial.workId, initial.admissionDigest).generation);
    store.reserve(budget, operationId, kind, { phase, instruction, inputDigest: inventoryDigest(inventory) }, deps.now(), resultId);
    const current = store.budget(initial.runId, initial.workId, initial.admissionDigest)!;
    const dispatchedAt = deps.now();
    const result = await deps.dispatch(effectivePhase, instruction, operationId, Math.max(1, current.deadlineMs - deps.now()));
    store.retainResult(budget, operationId, result, result.usage);
    store.metric(initial.runId, initial.workId, initial.admissionDigest, `metric:preparation-operation:${operationId}`, kind === "repair" ? "format-repair" : "phase-observation", { phase: phase === "planner" ? "planning" : phase === "challenge" ? "challenge" : phase === "repair" ? "repair" : "preparation", durationMs: Math.max(0, deps.now() - dispatchedAt), costUsd: result.usage?.costUsd ?? null, inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null });
    if (deps.now() >= current.deadlineMs) throw new Error("Preparation deadline expired; partial evidence retained");
    return { ...result, operationId };
  };
  const parsed = async <T>(result: PreparationProviderResult, tag: string): Promise<T> => {
    let response = result;
    const phaseBoundary = tag === "RAFI_QA_ASSESSMENT"
      ? "This is QA PREPARATION semantic assessment before Builder work, not final QA. Do not emit RAFI_QA_FAILURE_REPORT, RAFI_QA_COVERAGE, QA findings, or STEP_STATUS. Return only the requested RAFI_QA_ASSESSMENT envelope."
      : tag === "RAFI_QA_CANDIDATE"
        ? "This is QA PREPARATION contract drafting before Builder work, not final QA. Do not emit RAFI_QA_FAILURE_REPORT, RAFI_QA_COVERAGE, or STEP_STATUS. Return only the requested RAFI_QA_CANDIDATE envelope."
        : "";
    for (let repair = 0; ; repair++) {
      try { return parsePreparationArtifact<T>(response.text, tag); }
      catch (error) {
        // A provider can answer the preparation assessor with a final-QA
        // artifact from the wrong role. That is a repairable protocol error,
        // not a refusal to participate in preparation.
        const blocker = tag === "RAFI_QA_ASSESSMENT" && response.text.includes("RAFI_QA_FAILURE_REPORT_START")
          ? undefined
          : providerBlocker(response.text, tag);
        if (blocker) throw new Error(blocker);
        // A provider can return a short progress/prose response without any
        // JSON at all. Treat that as a bounded format defect unless it is an
        // explicit refusal; the repair turn is still required to produce the
        // exact envelope and is subject to the same strict parser below.
        if (repair >= 2) throw error;
        response = await run("repair", "repair", `${phaseBoundary}\nBounded format repair of the retained result. You may use read-only tools to inspect the frozen QA snapshot if needed, but do not edit files, redo the investigation, expand scope, invent evidence, or change host-owned fields. Return exactly one ${tag}_START JSON ${tag}_END envelope and no prose. If this is RAFI_QA_ASSESSMENT, it is still the pre-build assessor role: never convert the response into a final QA report or RAFI_QA_FAILURE_REPORT. If the retained response contains one JSON object without markers, copy that exact object between the markers; do not summarize it, add fields, or infer missing values. If it contains multiple objects or no complete object, return a corrected artifact only when the retained response itself unambiguously identifies the one requested object.\nRetained response:\n${response.text}`, result.operationId ?? result.sessionId);
      }
    }
  };
  /**
   * Validate provider-owned artifacts at their response boundary.  A provider
   * sometimes copies the preparation draft into an independent assessment;
   * that is not an assessment contract and must be repaired as a bounded
   * schema error rather than being allowed to fail much later in assembly.
   */
  const parsedContract = async <T>(result: PreparationProviderResult, tag: string, validate: ((value: unknown) => boolean) & { errors?: unknown[] | null }, name: string, normalize?: (value: T, response: PreparationProviderResult) => T): Promise<{ value: T; response: PreparationProviderResult }> => {
    let response = result;
    for (let repair = 0; ; repair++) {
      try {
        const value = normalize ? normalize(await parsed<T>(response, tag), response) : await parsed<T>(response, tag);
        if (!validate(value)) throw new Error(`${name} contract validation failed: ${(validate.errors ?? []).map(error => JSON.stringify(error)).join("; ")}`);
        return { value, response };
      } catch (error) {
        if (repair >= 2) throw error;
        const assessmentRepairContract = name === "QA semantic assessment"
          ? `Every concerns item must be an object with exactly these six fields and no others: {"reason":"...","requirementIds":[],"checkIds":[],"material":true,"owner":"qa","nextAction":"..."}. Replace legacy fields such as description, summary, severity, title, message, evidence, category, and resolution; do not merely wrap or rename an incomplete object. Use exact authoritative IDs only, and use concerns: [] when no supported concern remains.`
          : "";
        response = await run("repair", "repair", `Bounded schema repair for ${name}. You may use read-only tools to inspect the frozen QA snapshot if needed, but preserve the substantive independent assessment and return ONLY the exact ${tag}_START/END artifact matching the supplied schema. Do not edit files, add evidence, requirements, checks, scope, or host-owned identity. For RAFI_QA_ASSESSMENT, remain in the pre-build assessment role and never return a final QA failure report. ${assessmentRepairContract} Validation error: ${error instanceof Error ? error.message : String(error)}\nRetained response:\n${response.text}`, response.operationId ?? response.sessionId);
      }
    }
  };
  try {
    if (!retained && !retainedDepth && decisionIssues.length) {
      let plannerIssues = decisionIssues;
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await run("planner", attempt ? "repair" : "planning", `Read-only depth assessment of admitted scope. Select Standard or higher unless explicit Focused low-risk evidence is established. Return RAFI_QA_DEPTH_START/END with QaPreparationDepthDecisionV1. Schema: ${JSON.stringify(qaDepthDecisionSchema)}. Policy qa-preparation-v1. Host minimums: interactions/compatibility/state/external dependencies=3; authorization/security/data/migration/concurrency/recovery/deployment=4; unresolved architectural uncertainty=5. Do not change the admitted scope, inputs, requirements, or risk evidence. Every riskFactors.category must appear verbatim in minimumReasons. ${attempt ? `Correct these validation issues from the previous response: ${JSON.stringify(plannerIssues)}` : ""}\n${JSON.stringify(initial)}`);
        let proposed: QaPreparationDepthDecisionV1;
        try {
          proposed = await parsed<QaPreparationDepthDecisionV1>(response, "RAFI_QA_DEPTH");
        } catch (error) {
          plannerIssues = [`QA planner response was not a valid RAFI_QA_DEPTH envelope: ${error instanceof Error ? error.message : String(error)}`];
          if (attempt === 2) throw new Error(`depth-decision-incomplete: ${plannerIssues.join("; ")}`);
          continue;
        }
        proposed.plannerOperationId = response.operationId!; proposed.plannerIdentity = response.sessionId;
        // minimumReasons is a host-validated restatement of the planner's
        // riskFactors. Fill only omitted exact category labels; never alter
        // the selected level, risk evidence, or rationale.
        const requiredReasons = proposed.riskFactors.map(risk => risk.category);
        proposed.minimumReasons = [...proposed.minimumReasons, ...requiredReasons.filter(category => !proposed.minimumReasons.includes(category))];
        plannerIssues = validateDepthDecision(proposed);
        if (!plannerIssues.length) { candidate.depthDecision = proposed; store.reviseDepth(budget, candidate.depthDecision); break; }
        if (attempt === 2) throw new Error(`depth-decision-incomplete: ${plannerIssues.join("; ")}`);
      }
    } else store.reviseDepth(budget, candidate.depthDecision);
    store.retainProgress(budget, "depth-decision", candidate.depthDecision);
    let authorSessionId = retained?.authorSessionId ?? "";
    for (let pass = 0; pass < (candidate.depthDecision.level <= 2 ? 2 : 3) && (!retained || targetedConcerns.length > 0 || validateCandidate(candidate, inventory, store.equivalentResolver()).length > 0); pass++) {
      const response = await run("prepare", "investigation", `QA preparation only. Inspect relevant source/tests; do not implement, install dependencies, or expand admitted product scope. Return RAFI_QA_CANDIDATE_START/END with the provider draft schema: ${JSON.stringify(providerDraftSchema)}. Return ONLY the five draft fields in that schema: do not return contract identity, depth, inputs or requirements. Rafi owns and calculates timestamps, source and evidence hashes, operation/session identities and requirement text; you do not need shell access or hash calculations. Cite existing workspace-relative file paths and locations that you inspected. Use only the exact authoritative requirement IDs listed in the inventory below. Never invent, shorten, rename, derive, or copy a requirement ID from a filename, check ID, plan text, or sibling ticket. Every check.requirementRefs entry must be an exact ID from the inventory, and every coverage.requirementId must be an exact ID from the inventory; if a check has no applicable requirement, do not emit that check. Use the supplied requirement IDs and cover each original requirement, including rules and skills, with at least one mandatory check for each mandatory requirement. Each coverage row's checkIds must name checks whose requirementRefs array includes that exact row requirementId; every check must have at least one valid requirementRef. Verification cwd must be relative to the workspace; never copy an absolute disposable-snapshot path into cwd, commands, evidence, or prose. Use the stable relative location scratch/<filename> for bounded temporary logs. dependsOnChecks references other check IDs; prerequisiteRefs references only IDs of observations in baseline, not check IDs or host-preflight labels. Use empty arrays when none apply. Checks for future Builder work must use postimplementation timing; only checks already verified before Builder starts may use preimplementation or both timing, and every mandatory preimplementation/both check requires a matching passed baseline observation bound by checkId. Conditional observations also need predicate evidence. In this schema preimplementation means already verified before Builder starts, not a step Builder must perform before editing. For test-first or other Builder-executed sequencing, use postimplementation timing and require retained evidence proving the prescribed order; do not claim a future step has already passed. Future implementation and verification evidence is expected to be produced by Builder and final QA; specify it in the checks rather than treating its ordinary pre-build absence as a material unresolved concern. Do report genuine current blockers or uncertainties as unresolved. Scope checks must filter to approved product paths or ticket files; never require an exact whole-worktree status because Rafi-owned bookkeeping paths such as .tickets, .rafi, docs, configuration, and agent instructions are expected host changes. Supply one preparationEvidence entry for EACH required obligation, using its exact obligation label separately, with its own analysis and cited existing files; do not combine labels into a single entry. Supply concrete check methods/evidence and complete coverage. No disposition or waiver can be agent-authored. If risks exceed selected depth, return a separate RAFI_QA_ESCALATION_START/END JSON block {"version":1,"rationale":"...","riskFactors":[{"category":"...","rationale":"...","references":["..."]}]}; do not change the depth yourself.\nValidation issues to correct from the previous draft: ${JSON.stringify(correctionIssues)}\nPreviously retained independent concerns requiring targeted investigation and concrete resolution: ${JSON.stringify(targetedConcerns)}\nRequired obligations: ${depthObligations(candidate.depthDecision.level).join(", ")}\nThe authoritative candidate/input inventory below contains the exact allowed requirement ID set.\nAuthoritative candidate/input inventory:\n${JSON.stringify(candidate)}`);
      const rawProposal = await parsed<Partial<QaContractCandidateV1>>(response, "RAFI_QA_CANDIDATE");
      const legacy = Object.hasOwn(rawProposal, "runId");
      const proposal = legacy ? rawProposal : normalizeProviderDraftMetadata(rawProposal);
      if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) throw new Error("QA preparation draft must be an object");
      if (!legacy && !validateProviderDraft(proposal)) {
        correctionIssues = (validateProviderDraft.errors ?? []).map(error => `${error.instancePath || "/"} ${error.message}`);
        if (pass + 1 >= (candidate.depthDecision.level <= 2 ? 2 : 3)) throw new Error(`QA preparation draft correction exhausted: ${correctionIssues.join("; ")}`);
        continue;
      }
      if (legacy) {
        const depth = proposal.depthDecision;
        const inputs = proposal.inputs;
        // Legacy models sometimes remove Markdown code ticks from descriptive
        // text. Compare those fields narrowly; never normalize references or
        // risk categories and never publish the provider's copy.
        const prose = (value: string): string => value.replace(/`/g, "");
        const sameDepthProse = !!depth && typeof depth.rationale === "string" && Array.isArray(depth.minimumReasons) && depth.minimumReasons.every(item => typeof item === "string") && Array.isArray(depth.riskFactors) && depth.riskFactors.every(item => item && typeof item.rationale === "string") && (!depth.lowRisk || [depth.lowRisk.narrowBehavior, depth.lowRisk.understoodDependencies, depth.lowRisk.adequateVerification].every(item => typeof item === "string")) && prose(depth.rationale) === prose(candidate.depthDecision.rationale)
          && canonicalContractJson(depth.minimumReasons.map(prose)) === canonicalContractJson(candidate.depthDecision.minimumReasons.map(prose))
          && canonicalContractJson(depth.riskFactors.map(risk => ({ ...risk, rationale: prose(risk.rationale) }))) === canonicalContractJson(candidate.depthDecision.riskFactors.map(risk => ({ ...risk, rationale: prose(risk.rationale) })))
          && canonicalContractJson(depth.lowRisk ? { narrowBehavior: prose(depth.lowRisk.narrowBehavior), understoodDependencies: prose(depth.lowRisk.understoodDependencies), adequateVerification: prose(depth.lowRisk.adequateVerification) } : null) === canonicalContractJson(candidate.depthDecision.lowRisk ? { narrowBehavior: prose(candidate.depthDecision.lowRisk.narrowBehavior), understoodDependencies: prose(candidate.depthDecision.lowRisk.understoodDependencies), adequateVerification: prose(candidate.depthDecision.lowRisk.adequateVerification) } : null);
        const matchingReference = (actual: string, expected: string): boolean => actual === expected || (!actual.startsWith("/") && !actual.split(/[\\/]/).includes("..") && expected.endsWith(`/${actual}`));
        const matchingInputs = Array.isArray(inputs) && inputs.length === candidate.inputs.length && inputs.every((input, index) => {
          const expected = candidate.inputs[index];
          return expected && input && typeof input.reference === "string" && matchingReference(input.reference, expected.reference) && canonicalContractJson({ ...input, reference: expected.reference }) === canonicalContractJson(expected);
        });
        if (proposal.runId !== candidate.runId || proposal.workId !== candidate.workId || proposal.admissionDigest !== candidate.admissionDigest || proposal.contractId !== candidate.contractId || proposal.revision !== candidate.revision || !depth || depth.level !== candidate.depthDecision.level || depth.minimumLevel !== candidate.depthDecision.minimumLevel || depth.policyVersion !== candidate.depthDecision.policyVersion || depth.decisionId !== candidate.depthDecision.decisionId || !sameDepthProse || !matchingInputs) throw new Error("Preparation changed host-owned identity/depth/input authority");
      } else if (Object.keys(proposal).some(key => !["checks", "coverage", "baseline", "preparationEvidence", "unresolved"].includes(key))) throw new Error("QA preparation draft contains unexpected host-owned or unsupported fields");
      if (![proposal.checks, proposal.coverage, proposal.baseline, proposal.preparationEvidence, proposal.unresolved].every(Array.isArray)) throw new Error("QA preparation draft is missing required proposal arrays");
      if (!legacy && !deps.normalizeDraft) throw new Error("QA preparation host evidence normalization is unavailable");
      const draft = { ...structuredClone(candidate), checks: proposal.checks!, coverage: proposal.coverage!, baseline: proposal.baseline!, preparationEvidence: proposal.preparationEvidence!, unresolved: proposal.unresolved!, ...(legacy && proposal.requirements ? { requirements: proposal.requirements } : {}) } as QaContractCandidateV1;
      draft.createdAt = candidate.createdAt;
      if (candidate.predecessorDigest === undefined) delete draft.predecessorDigest; else draft.predecessorDigest = candidate.predecessorDigest;
      if (Array.isArray(draft.requirements)) {
        const authoritative = new Map(inventory.map(item => [item.id, item]));
        const ids = draft.requirements.map(item => item.id);
        if (ids.some(id => !authoritative.has(id)) || new Set(ids).size !== ids.length) throw new Error("QA preparation draft contains unknown or duplicate requirement identities");
        draft.requirements = draft.requirements.map(item => authoritative.has(item.id) ? structuredClone(authoritative.get(item.id)!) : item);
        const present = new Set(draft.requirements.map(item => item.id));
        draft.requirements.push(...inventory.filter(item => !present.has(item.id)).map(item => structuredClone(item)));
      }
      try {
        candidate = removeExtraneousRequirementReferences(enforceMandatoryCoverage(deps.normalizeDraft ? deps.normalizeDraft(draft, response) : draft), inventory);
      }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        correctionIssues = [`Draft could not be normalized: ${detail}`];
        if (pass + 1 >= (candidate.depthDecision.level <= 2 ? 2 : 3)) throw new Error(`QA preparation draft correction exhausted: ${detail}`);
        continue;
      }
      authorSessionId = response.sessionId;
      for (const evidence of candidate.preparationEvidence) { evidence.operationId = response.operationId!; evidence.sessionId = response.sessionId; }
      if (response.text.includes("RAFI_QA_ESCALATION_START")) {
        const request = parseProviderContract(qaPreparationEscalationProposalV1Schema, parsePreparationArtifact<unknown>(response.text, "RAFI_QA_ESCALATION"), "QA preparation escalation");
        const minimum = Math.max(candidate.depthDecision.level, ...request.riskFactors.map(risk => QA_RISK_MINIMUMS[risk.category]));
        const revision = await run("planner", "escalation", `Revise only the QA depth for this admitted scope. Do not expand product scope. Host minimum ${minimum}; keep predecessorDecisionId ${candidate.depthDecision.decisionId}. Return RAFI_QA_DEPTH_START/END following ${JSON.stringify(qaDepthDecisionSchema)}. Previous decision: ${JSON.stringify(candidate.depthDecision)}; cited risk evidence: ${JSON.stringify(request)}`);
        const decision = await parsed<QaPreparationDepthDecisionV1>(revision, "RAFI_QA_DEPTH"); decision.plannerIdentity = revision.sessionId; decision.plannerOperationId = revision.operationId!;
        const errors = validateDepthDecision(decision, candidate.depthDecision);
        if (decision.level < minimum || request.riskFactors.some(risk => !decision.riskFactors.some(actual => actual.category === risk.category))) errors.push("Planner revision does not address evidenced risk minimum");
        if (errors.length) throw new Error(`depth-decision-incomplete: ${errors.join("; ")}`);
        candidate.depthDecision = decision; store.reviseDepth(budget, decision); store.retainProgress(budget, "depth-decision", decision); continue;
      }
      const structural = validateCandidate(candidate, inventory, store.equivalentResolver());
      if (!structural.length) break;
      correctionIssues = structural;
    }
    store.retainProgress(budget, "draft", { candidate, authorSessionId });
    const structural = validateCandidate(candidate, inventory, store.equivalentResolver()); if (structural.length) throw new Error(`Contract incomplete: ${structural.join("; ")}`);
    const binding = { draftPayloadDigest: draftDigest(candidate), inventoryDigest: inventoryDigest(candidate.requirements), policyVersion: candidate.depthDecision.policyVersion, authorSessionId };
    const retainedAssessment = store.progress<QaSemanticAssessmentV1>(budget, "assessment");
    const normalizeAssessment = <T extends QaSemanticAssessmentV1>(value: T, response: PreparationProviderResult, fallback?: QaSemanticAssessmentV1): T => {
      const normalized = normalizeAssessmentObligations(normalizeAssessmentMetadata(value), depthObligations(candidate.depthDecision.level));
      // These bindings are host-owned. A repair may omit them or emit a
      // placeholder; restore only the exact current binding and retained
      // obligation labels, never provider-invented content.
      normalized.draftPayloadDigest = binding.draftPayloadDigest;
      normalized.inventoryDigest = binding.inventoryDigest;
      normalized.policyVersion = binding.policyVersion;
      normalized.authorSessionId = binding.authorSessionId;
      // Provider JSON does not own dispatch metadata. Bind the actual adapter
      // receipt before schema validation so an omitted echo cannot block QA.
      normalized.sessionId = response.sessionId;
      if (response.operationId) normalized.operationId = response.operationId;
      if ((!normalized.assessedObligations || normalized.assessedObligations.length === 0) && fallback?.assessedObligations?.length) normalized.assessedObligations = [...fallback.assessedObligations];
      if ((!normalized.assessedRequirementIds || normalized.assessedRequirementIds.length === 0) && fallback?.assessedRequirementIds?.length) normalized.assessedRequirementIds = [...fallback.assessedRequirementIds];
      return normalized as T;
    };
    let assessmentResponse = retainedAssessment?.draftPayloadDigest === draftDigest(candidate) ? undefined : await run("assess", "assessment", `Independent semantic assessment in a fresh conversation. Assess each original requirement and selected-depth obligation; identify omissions, conflicts, practical verification gaps, accidental scope, and unsupported dispositions. Treat Rafi-owned bookkeeping paths (.tickets, .rafi, generated docs/configuration, and agent instructions) as expected host changes. Scope concerns must be evaluated against approved product paths and ticket requirements; do not require an exact full-worktree status listing. Future Builder actions are not preparation failures: when an approved requirement specifies test-first ordering, a migration, rollback rehearsal, or other implementation-time sequence, represent it as a mandatory postimplementation check requiring retained Builder evidence. Do not mark the absence of that future evidence before Builder starts as a material concern, and do not demand that preparation reproduce historical order. Only report a material concern when the contract cannot state an actionable postimplementation check or when an already-required preimplementation fact is missing. Return RAFI_QA_ASSESSMENT_START/END with QaSemanticAssessmentV1 (schema: ${JSON.stringify(qaPreparationDepthDecisionV1Schema)}). The concerns field is an array of objects, never strings; every concern object must have exactly these six fields and no others: {reason:string, requirementIds:string[], checkIds:string[], material:boolean, owner:string, nextAction:string}. Do not use legacy fields such as severity, evidence, title, message, category, or resolution. Use concerns: [] only when all issues are resolved. assessedRequirementIds MUST contain every ID in this exact list, even when a requirement is host-owned or has no concern: ${JSON.stringify(candidate.requirements.map(requirement => requirement.id))}. Put every individually assessed required obligation label in assessedObligations, using the exact labels below; do not combine labels or claim to have assessed anything you did not assess. Required obligation labels: ${JSON.stringify(depthObligations(candidate.depthDecision.level))}. Bind exactly ${JSON.stringify(binding)}.\nPrior independent concerns requiring concrete resolution evidence: ${JSON.stringify(targetedConcerns)}\nOriginal inventory:\n${JSON.stringify(inventory)}\nDraft:\n${JSON.stringify(candidate)}`);
    let assessed = assessmentResponse
      ? await parsedContract<QaSemanticAssessmentV1>(assessmentResponse, "RAFI_QA_ASSESSMENT", validateAssessmentContract, "QA semantic assessment", (value, response) => normalizeAssessment(value, response))
      : { value: retainedAssessment!, response: undefined };
    // The author identity is host-owned. The provider must supply an independent
    // session identity, but it cannot prove or safely author the builder's ID.
    assessed.value.authorSessionId = binding.authorSessionId;
    for (let repair = 0; assessmentResponse && repair < 3; repair++) {
      const semanticIssues = validateAssessment(candidate, assessed.value, authorSessionId);
      if (!semanticIssues.length) break;
      if (repair === 2) throw new Error(semanticIssues.join("; "));
      const preservedAuthorSessionId = assessed.value.authorSessionId;
      const boundedRetainedAssessment = {
        concerns: assessed.value.concerns,
        assessedRequirementIds: assessed.value.assessedRequirementIds,
        assessedObligations: assessed.value.assessedObligations,
        draftPayloadDigest: assessed.value.draftPayloadDigest,
        inventoryDigest: assessed.value.inventoryDigest,
        policyVersion: assessed.value.policyVersion,
        authorSessionId: assessed.value.authorSessionId,
      };
      const freshAssessment = semanticIssues.includes("Assessment lacks independent authorship");
      assessmentResponse = await run(freshAssessment ? "assess" : "repair", freshAssessment ? "assessment" : "repair", `${freshAssessment ? "Fresh independent assessment required: use a new QA provider session, distinct from the preparation author session. Do not reuse or claim the preparation session." : "Bounded semantic repair for QA semantic assessment."} Preserve the independent review, but correct only these host validation issues: ${JSON.stringify(semanticIssues)}. Use only requirement IDs from the authoritative inventory and only check IDs declared in the supplied draft; never invent aliases such as qa-c1 or qa-c6, and never cite undefined retained evidence. If a concern is not supported by an actual requirement or declared check, remove or rewrite that concern. Return only RAFI_QA_ASSESSMENT_START/END with the complete corrected assessment. Binding: ${JSON.stringify(binding)}\nAuthoritative requirement IDs: ${JSON.stringify(candidate.requirements.map(requirement => requirement.id))}\nDeclared check IDs: ${JSON.stringify(candidate.checks.map(check => check.id))}\nBounded retained assessment fields to preserve or correct:\n${JSON.stringify(boundedRetainedAssessment)}`, assessed.response?.operationId ?? assessed.response?.sessionId);
      const repaired = await parsedContract<QaSemanticAssessmentV1>(assessmentResponse, "RAFI_QA_ASSESSMENT", validateAssessmentContract, "QA semantic assessment", (value, response) => normalizeAssessment(value, response, assessed.value));
      // Repairs may omit this immutable binding while rewriting concerns. Preserve
      // it only when the prior parsed assessment supplied it; a conflicting value
      // remains visible to validateAssessment and still fails closed.
      if (repaired.value.authorSessionId === undefined && preservedAuthorSessionId !== undefined) repaired.value.authorSessionId = preservedAuthorSessionId;
      repaired.value.authorSessionId = binding.authorSessionId;
      assessed = repaired;
    }
    const assessment = normalizeExpectedFutureAssessment(normalizeAssessmentMetadata(assessed.value), candidate);
    // These binding fields are host-owned. Providers frequently copy or
    // truncate the inventory digest while describing their assessment; that
    // must not invalidate an otherwise substantive independent review.
    assessment.draftPayloadDigest = binding.draftPayloadDigest;
    assessment.inventoryDigest = binding.inventoryDigest;
    assessment.policyVersion = binding.policyVersion;
    if (assessmentResponse) { assessment.sessionId = assessed.response!.sessionId; assessment.operationId = assessed.response!.operationId!; }
    store.retainProgress(budget, "assessment", assessment);
    let challenge = store.progress<QaChallengeReceiptV1>(budget, "challenge");
    if (challenge?.draftPayloadDigest !== draftDigest(candidate)) challenge = undefined;
    if (candidate.depthDecision.level === 5 && !challenge) {
      const response = await run("challenge", "challenge", `Independent approach challenge, fresh assessor conversation. Planning only. Return RAFI_QA_CHALLENGE_START/END with QaChallengeReceiptV1 (schema: ${JSON.stringify(qaChallengeReceiptV1Schema)}): independently critique the author's retained approach-proposal evidence (do not author a replacement), independent contract conclusions and separate approachConcerns for scope, invariants, failure-boundaries, verification. Unresolved material concerns prevent readiness. Binding: ${JSON.stringify(binding)}. Previously retained concerns requiring concrete resolution: ${JSON.stringify(targetedConcerns)}.\n${JSON.stringify(candidate)}`);
      const challenged = await parsedContract<QaChallengeReceiptV1>(response, "RAFI_QA_CHALLENGE", validateChallengeContract, "QA approach challenge", (value, response) => normalizeAssessment(value, response));
      challenge = normalizeAssessmentMetadata(challenged.value); challenge.sessionId = challenged.response.sessionId; challenge.operationId = challenged.response.operationId!; store.retainProgress(budget, "challenge", challenge);
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
    const failureDigest = createHash("sha256").update(JSON.stringify({ status, detail })).digest("hex");
    store.event(initial.runId, initial.workId, `preparation-failure:${current.id}:${current.reservations.length}:${failureDigest}`, "preparation-failure", { status, detail });
    return { status, detail, nextAction: status === "uncertain" ? "Reconcile retained provider dispatch; do not replay uncertain work" : "Resolve remaining concerns or record authorized operational extension, then retry" };
  }
}
