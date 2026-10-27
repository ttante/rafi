import { operationPayload, operationInstruction, nativePolicy, sendRoleGraphTurn } from "ai-foreman/agent-run.js";
import { createHash } from "node:crypto";
import {
  createRoleBuilder,
  readOnlyPermissionConfig,
  type EffortLevel,
  type RoleBuilder,
} from "ai-foreman/agent-run.js";
import {
  GRILL_ME_STOP_CHOICE,
  isGrillMeProviderQuestion,
  type AnsweredProviderQuestion,
} from "ai-foreman/provider-questions.js";
import { grillAuditOutput, grillAuditVerdictV1Schema, parseProviderContract } from "rafi-spec";

export { GRILL_ME_STOP_CHOICE } from "ai-foreman/provider-questions.js";

export { grillAuditOutput } from "rafi-spec";

export const GRILL_STATE_DECISION_KEY = "grillVerification";

export type GrillAuditStatus =
  | "not_audited"
  | "running"
  | "complete"
  | "needs_user_input"
  | "stopped"
  | "failed"
  | "interrupted";

export interface GrillAuditQuestion {
  id: string;
  question: string;
  recommendation: string;
  rationale: string;
  alternatives: string[];
}

export interface GrillAuditAnswer {
  questionId: string;
  answer: string;
}

export interface GrillVerificationState {
  version: 1;
  exhaustiveActive: boolean;
  activationEpoch: number;
  validAnsweredQuestionCount: number;
  auditStatus: GrillAuditStatus;
  candidateDigest?: string;
  auditAttempted: boolean;
  evidence?: string;
  pendingQuestions: GrillAuditQuestion[];
  answers: GrillAuditAnswer[];
  stopped: boolean;
  failure?: string;
  recoveryRetryUsed: boolean;
}

export type GrillAuditVerdict =
  | { status: "complete"; evidence: string }
  | { status: "needs_user_input"; questions: GrillAuditQuestion[] };

export interface RunGrillAuditOptions {
  projectDir: string;
  originalRequest: string;
  knownDecisions: unknown;
  repositoryContext: unknown;
  candidate: unknown;
  runtime: "claude" | "codex";
  model?: string;
  effort?: EffortLevel;
  createAuditor?: typeof createRoleBuilder;
  onState?: (state: GrillVerificationState, event: string) => void;
  initialState?: GrillVerificationState;
  allowRecoveryRetry?: boolean;
}

export interface GrillAuditRunResult {
  state: GrillVerificationState;
  verdict?: GrillAuditVerdict;
}

export function defaultGrillVerificationState(exhaustiveActive = false, activationEpoch = exhaustiveActive ? 1 : 0): GrillVerificationState {
  return {
    version: 1,
    exhaustiveActive,
    activationEpoch,
    validAnsweredQuestionCount: 0,
    auditStatus: "not_audited",
    auditAttempted: false,
    pendingQuestions: [],
    answers: [],
    stopped: false,
    recoveryRetryUsed: false,
  };
}

export function readGrillVerificationState(
  decisions: Record<string, unknown> | undefined,
  exhaustiveActive: boolean,
): GrillVerificationState {
  const raw = decisions?.[GRILL_STATE_DECISION_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultGrillVerificationState(exhaustiveActive);
  const value = raw as Partial<GrillVerificationState>;
  const base = defaultGrillVerificationState(exhaustiveActive);
  const restoredStatus = value.auditStatus === "running" ? "interrupted" : value.auditStatus;
  return {
    ...base,
    ...value,
    version: 1,
    exhaustiveActive,
    activationEpoch: positiveInteger(value.activationEpoch) ?? base.activationEpoch,
    validAnsweredQuestionCount: nonnegativeInteger(value.validAnsweredQuestionCount) ?? 0,
    pendingQuestions: Array.isArray(value.pendingQuestions) ? value.pendingQuestions.filter(isAuditQuestion) : [],
    answers: Array.isArray(value.answers) ? value.answers.filter(isAuditAnswer) : [],
    stopped: value.stopped === true,
    auditAttempted: value.auditAttempted === true,
    recoveryRetryUsed: value.recoveryRetryUsed === true,
    auditStatus: restoredStatus ?? base.auditStatus,
    failure: value.auditStatus === "running"
      ? "the prior process stopped while the independent audit was running"
      : value.failure,
  };
}

export function decisionsWithGrillState(
  decisions: Record<string, unknown>,
  state: GrillVerificationState,
): Record<string, unknown> {
  return { ...decisions, [GRILL_STATE_DECISION_KEY]: state };
}

export function activateExhaustiveGrill(state: GrillVerificationState): GrillVerificationState {
  if (state.exhaustiveActive) return state;
  return {
    ...defaultGrillVerificationState(true, state.activationEpoch + 1),
  };
}

export function recordNativeGrillAnswer(
  state: GrillVerificationState,
  event: AnsweredProviderQuestion,
): { state: GrillVerificationState; qualified: boolean } {
  const qualified = state.exhaustiveActive && event.answer.trim().length > 0 && isGrillMeProviderQuestion(event);
  return {
    qualified,
    state: qualified
      ? { ...state, validAnsweredQuestionCount: state.validAnsweredQuestionCount + 1 }
      : state,
  };
}

export function isGrillMeTextQuestion(question: string | undefined, choices: readonly string[] | undefined): boolean {
  if (!question?.trim() || !choices || choices.length < 3) return false;
  const normalized = choices.map((choice) => choice.trim());
  if (!normalized[0]?.endsWith("(Recommended)")) return false;
  const stopIndex = normalized.indexOf(GRILL_ME_STOP_CHOICE);
  if (stopIndex < 0) return false;
  return normalized.some((choice, index) => index > 0 && index !== stopIndex && choice.length > 0);
}

export function recordTextGrillAnswer(
  state: GrillVerificationState,
  input: { question?: string; choices?: readonly string[]; answer?: string },
): { state: GrillVerificationState; qualified: boolean } {
  const qualified = state.exhaustiveActive
    && Boolean(input.answer?.trim())
    && isGrillMeTextQuestion(input.question, input.choices);
  return {
    qualified,
    state: qualified
      ? { ...state, validAnsweredQuestionCount: state.validAnsweredQuestionCount + 1 }
      : state,
  };
}

export function candidateDigest(candidate: unknown): string {
  return createHash("sha256").update(stableStringify(candidate)).digest("hex");
}

export function needsIndependentGrillAudit(state: GrillVerificationState): boolean {
  return state.exhaustiveActive && state.validAnsweredQuestionCount === 0 && !state.auditAttempted;
}

export function buildGrillAuditInstruction(input: {
  originalRequest: string;
  knownDecisions: unknown;
  repositoryContext: unknown;
  candidate: unknown;
}): string {
  return `You are Rafi's independent grill-me completeness auditor. This is a fresh, read-only session with the real grill-me skill loaded.

Audit only unresolved user judgments in the validated candidate. Inspect repository-discoverable facts yourself; never turn a discoverable fact into a user question. Do not edit anything. Do not call AskUserQuestion or any other interactive question tool. You get exactly one turn.

Original request:
${input.originalRequest}

Known user decisions:
${JSON.stringify(input.knownDecisions, null, 2)}

Repository and source context:
${JSON.stringify(input.repositoryContext, null, 2)}

Validated candidate:
${JSON.stringify(input.candidate, null, 2)}

Return the verdict in result.payload of the native grill-audit response:
{"status":"complete","evidence":"concrete evidence that no unresolved user judgments remain"}
Or, when material user decisions are missing:
{"status":"needs_user_input","questions":[{"id":"stable-short-id","question":"one focused question","recommendation":"recommended answer","rationale":"why this is the best default","alternatives":["meaningful alternative"]}]}
Return one to five highest-impact questions, each with one recommendation and one to three alternatives. Rafi adds the stop option.`;
}

export async function runIndependentGrillAudit(opts: RunGrillAuditOptions): Promise<GrillAuditRunResult> {
  let state = opts.initialState ?? defaultGrillVerificationState(true);
  const digest = candidateDigest(opts.candidate);
  const recovering = state.auditStatus === "interrupted" && opts.allowRecoveryRetry === true && !state.recoveryRetryUsed;
  if (state.auditAttempted && !recovering) return { state };
  state = {
    ...state,
    auditAttempted: true,
    auditStatus: "running",
    candidateDigest: digest,
    failure: undefined,
    recoveryRetryUsed: state.recoveryRetryUsed || recovering,
  };
  opts.onState?.(state, "audit_started");

  let role: RoleBuilder | undefined;
  let interactiveToolAttempted = false;
  try {
    role = await (opts.createAuditor ?? createRoleBuilder)({
      projectDir: opts.projectDir,
      role: "planner",
      extraSkills: ["grill-me"],
      agent: opts.runtime,
      model: opts.model,
      effort: opts.effort,
      yes: true,
      allowSwitch: false,
      label: "rafi grill-me audit",
      permissionConfig: readOnlyPermissionConfig(),
      sandboxMode: "read-only",
      onProviderQuestion: () => { interactiveToolAttempted = true; },
    });
    const result = await sendRoleGraphTurn(role, `${buildGrillAuditInstruction(opts)}\n\n${operationInstruction(grillAuditOutput)}`, "planning-audit", nativePolicy(grillAuditOutput, { purpose: "assessment" }));
    if (interactiveToolAttempted) throw new Error("auditor attempted an interactive question tool");
    if (result.isError) throw new Error(`auditor agent failed: ${result.text.slice(0, 300)}`);
    const verdict = operationPayload<GrillAuditVerdict>(result, grillAuditOutput);
    state = verdict.status === "complete"
      ? { ...state, auditStatus: "complete", evidence: verdict.evidence, pendingQuestions: [] }
      : { ...state, auditStatus: "needs_user_input", pendingQuestions: verdict.questions };
    opts.onState?.(state, verdict.status === "complete" ? "audit_complete" : "audit_needs_user_input");
    return { state, verdict };
  } catch (error) {
    const interrupted = isInterruption(error);
    state = {
      ...state,
      auditStatus: interrupted ? "interrupted" : "failed",
      failure: safeFailure(error),
    };
    opts.onState?.(state, interrupted ? "audit_interrupted" : "audit_failed");
    return { state };
  } finally {
    await role?.builder.close().catch(() => {});
  }
}

export interface AuditQuestionPrompt {
  (question: GrillAuditQuestion, choices: string[]): Promise<string | undefined>;
}

export async function collectGrillAuditAnswers(
  initialState: GrillVerificationState,
  prompt: AuditQuestionPrompt,
  onState?: (state: GrillVerificationState, event: string, questionId?: string) => void,
): Promise<GrillVerificationState> {
  let state = initialState;
  const answered = new Set(state.answers.map((answer) => answer.questionId));
  for (const question of state.pendingQuestions) {
    if (answered.has(question.id) || state.stopped) continue;
    const choices = [
      `${question.recommendation} (Recommended)`,
      ...question.alternatives,
      GRILL_ME_STOP_CHOICE,
    ];
    const answer = await prompt(question, choices);
    if (answer === undefined) {
      state = { ...state, auditStatus: "interrupted", failure: "audit question input was cancelled" };
      onState?.(state, "audit_interrupted", question.id);
      return state;
    }
    const trimmed = answer.trim();
    if (!trimmed) {
      state = { ...state, auditStatus: "interrupted", failure: "audit question answer was empty" };
      onState?.(state, "audit_interrupted", question.id);
      return state;
    }
    state = {
      ...state,
      answers: [...state.answers, { questionId: question.id, answer: trimmed }],
      stopped: trimmed === GRILL_ME_STOP_CHOICE,
      auditStatus: trimmed === GRILL_ME_STOP_CHOICE ? "stopped" : "needs_user_input",
    };
    onState?.(state, state.stopped ? "audit_stopped" : "audit_answered", question.id);
  }
  if (!state.stopped && state.pendingQuestions.every((question) => state.answers.some((answer) => answer.questionId === question.id))) {
    state = { ...state, auditStatus: "complete" };
    onState?.(state, "audit_answers_complete");
  }
  return state;
}

export function buildAuditAnswersContinuation(state: GrillVerificationState): string {
  const questions = new Map(state.pendingQuestions.map((question) => [question.id, question]));
  const answered = state.answers.map((answer) => ({
    question_id: answer.questionId,
    question: questions.get(answer.questionId)?.question ?? answer.questionId,
    answer: answer.answer,
  }));
  return `Rafi's independent grill-me audit found unresolved user judgments and Rafi collected the answers below.

Audit answers (preserve exactly):
${JSON.stringify(answered, null, 2)}
User stopped further questions: ${state.stopped ? "yes" : "no"}

Return a full replacement candidate that incorporates these decisions. Preserve all other validated work. Use the host-selected native structured operation and return the complete replacement proposal in its completed payload, with continuity at the top level. Do not append status markers or external proposal delimiters. Do not ask more grill-me questions; the one-time independent audit is complete for this exhaustive activation.`;
}

function isAuditQuestion(value: unknown): value is GrillAuditQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<GrillAuditQuestion>;
  return typeof item.id === "string" && Boolean(item.id.trim())
    && typeof item.question === "string" && Boolean(item.question.trim())
    && typeof item.recommendation === "string" && Boolean(item.recommendation.trim())
    && typeof item.rationale === "string" && Boolean(item.rationale.trim())
    && Array.isArray(item.alternatives)
    && item.alternatives.every((entry) => typeof entry === "string" && Boolean(entry.trim()));
}

function isAuditAnswer(value: unknown): value is GrillAuditAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<GrillAuditAnswer>;
  return typeof item.questionId === "string" && Boolean(item.questionId.trim())
    && typeof item.answer === "string" && Boolean(item.answer.trim());
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isInterruption(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return /interrupt|cancel|abort|signal/i.test(error instanceof Error ? error.message : String(error));
}

function safeFailure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
