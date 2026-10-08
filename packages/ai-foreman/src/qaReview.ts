import { checkQaPrerequisites } from "./qaPrerequisites.js";
import { boundedQaHistory } from "./qaHandbackHistory.js";
import {
  QA_FAILURE_REPORT_END, QA_FAILURE_REPORT_START, parseQaResponseContract, qaFailureReportV1Schema,
  type ProviderSessionRefV1, type QaFailureReportV1, type QaFindingRefV2, type SessionStrategy,
} from "rafi-spec";
import type { BuilderAdapter, BuilderEvent, CompactResult, TurnResult } from "./adapters/types.js";
import { SessionUnavailableError } from "./adapters/sessionFailure.js";
import { currentActivity, withActivityPhase } from "./activity.js";
import { buildQaInstruction, parseStepStatus } from "./foreman.js";
import { captureFrozenQaSourceAsync, captureProspectiveGitTree, createDisposableQaSnapshotAsync, deterministicChangeSummaryAsync, prospectiveGitTreeMatches, QaSourceInstabilityError, type FrozenQaSourceState } from "./qaSnapshot.js";
import type { RunObserver } from "./observability.js";
import type { TicketDef } from "./tickets/ticketSchema.js";
import { loadTicketSetupConfigWithDefaults } from "./tickets/setupConfig.js";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { WorkflowDb } from "./workflowDb.js";
import { canonicalSessionPath } from "./sessionIdentity.js";
import type { QaFailureDeliveryInput, QaFailureDeliveryResult } from "./qaFailureDelivery.js";
import { loadProjectAutonomyConfig, resolveAutonomyPolicy } from "./recoveryPolicy.js";
import {
  appendQaRecoveryAttempt, appendQaRecoveryResource, appendQaRecoveryReviewedState, compareQaRecoveryReviewedState, createQaRecoveryPacket, ensureQaRecoveryExcluded, loadQaRecoveryPacket, materializeQaRecoveryContext, qaRecoveryInventory,
  qaReportDigest, renderQaRecoveryAcknowledgementInstruction, updateQaRecoveryPosition, updateQaRecoveryReviewIdentity,
  validateManualQaReport, validateQaRecoveryAcknowledgement, type QaRecoveryPacket, type QaRecoveryPacketInput, type QaRecoveryPendingAction,
} from "./qaRecovery.js";
import { canonicalJson, createQaFindingRefs, qaDigest, type FrozenQaSourceStateV2, type HandoffAcceptanceReceiptV2, type QaConfinementV2, type QaReviewBasisV2, type QaTurnIntentV2, type QaTurnReceiptV2 } from "./qaProtocolV2.js";

export interface QaStreamState {
  sessionId?: string;
  sessionRef?: ProviderSessionRefV1;
  reviews: number;
  modificationViolations: number;
  remediationGeneration?: number;
  /** Exact host-observed Builder responses; prompt-facing summaries remain separately bounded. */
  builderResponseHistory?: Array<{ ticketId: string; cycle: number; kind: "completion" | "remediation" | "plain-fallback"; response: string; summary: string }>;
}
export interface QaReportHistoryEntry { cycle: number; reviewAttempt?: number; remediationGeneration?: number; attemptId?: string; outcome: string; detail: string; reportDigest?: string; report?: QaFailureReportV1; findingIds?: string[]; remediationRequestDigest?: string; remediationRequest?: string; fixSummaryDigest?: string; fixSummary?: string; remediationDigest?: string; remediation?: string }
export interface QaNonconvergenceContext { ticket: TicketDef; history: QaReportHistoryEntry[]; builderWorktree: string }
export type QaNonconvergenceDecision = { action: "retry" | "pause" | "waive" | "remediate"; remediation?: string };
export type QaFixRequest =
  | { kind: "validated-report"; report: QaFailureReportV1; reportDigest: string; history: QaReportHistoryEntry[]; latestBuilderResult: string }
  | { kind: "planner-remediation"; report: QaFailureReportV1; reportDigest: string; remediation: string; history: QaReportHistoryEntry[]; latestBuilderResult: string };
export type QaFixResult =
  | { outcome?: import("./qaDeliveryJournal.js").QaDeliveryOutcome; ok: true; response: string; summary: string; detail?: string; providerTurnId?: string }
  | { outcome?: import("./qaDeliveryJournal.js").QaDeliveryOutcome; ok: false; detail?: string; response?: string; summary?: string; providerTurnId?: string };
export interface QaSessionHandle {
  adapter: BuilderAdapter;
  sessionIdentity(): ProviderSessionRefV1;
  effectiveRoleInstructions: string;
  runtimeContext: unknown;
  skills: Array<{ name: string; digest: string; path: string; content: string }>;
  confinement: QaConfinementV2 & { digest: string };
  handoffReceipt: { kind: "initial" } | { kind: "accepted"; receipt: HandoffAcceptanceReceiptV2 };
}
export interface QaSessionBoundaryResult { handle: QaSessionHandle; receipt: HandoffAcceptanceReceiptV2 }
export interface QaSessionBoundaryRecovery {
  runId: string;
  ticketId: string;
  packetId: string;
  packetDigest: string;
  reviewedStateDigest: string;
  packetPath: string;
  resources: Array<{ label: string; purpose: string; bytes: number; digest: string; requiredForRecovery: boolean; mediaType: string; path: string }>;
}
export type QaReportRecoveryDecision =
  | { action: "fresh" }
  | { action: "plain" }
  | { action: "manual" }
  | { action: "guidance"; instructions: string; route?: "current" | "compact" | "fresh" }
  | { action: "pause" };
export type QaReportRecoveryHandler = NonNullable<IsolatedQaOptions["onReportRecovery"]>;
export interface IsolatedQaOptions {
  ticket: TicketDef;
  builderWorktree: string;
  builderSummary: string;
  qaStrategy: SessionStrategy;
  state: QaStreamState;
  createQa: (cwd: string, sessionId?: string) => Promise<QaSessionHandle>;
  /** Host-owned ordinary QA boundary. Fresh strategies must return a validated successor. */
  sessionBoundary: (handle: QaSessionHandle, frozenAction: string, strategy: SessionStrategy, cwd: string, recovery?: QaSessionBoundaryRecovery) => Promise<QaSessionBoundaryResult>;
  /** Persist provider-native automatic compactions without imposing an ordinary QA boundary. */
  observeNativeCompactions?: (adapter: BuilderAdapter) => Promise<void>;
  /** Legacy test seam. Production QA-failure remediation must use deliverFailure. */
  fix?: (request: QaFixRequest) => Promise<QaFixResult>;
  /** Canonical production delivery path for validated QA failure reports. */
  deliverFailure?: (request: QaFailureDeliveryInput) => Promise<QaFailureDeliveryResult>;
  maxCycles: number;
  /** Durable QA execution scope; review/fix budgets survive worker restarts. */
  recovery: { projectDir: string; runId: string };
  observer?: RunObserver;
  evidence?: (entry: { cycle: number; reviewAttempt?: number; remediationGeneration?: number; attemptId?: string; outcome: string; detail: string; durationMs?: number; qaDiff?: string[] }) => void;
  onNonconvergence?: (context: QaNonconvergenceContext) => Promise<QaNonconvergenceDecision>;
  /** Resolve a QA blocker with the same still-open QA session before disposal. */
  resolveBlocked?: (adapter: BuilderAdapter, reason: string) => Promise<{ result: import("./adapters/types.js").TurnResult; status: import("./foreman.js").StepStatus }>;
  onReportRecovery?: (context: { packet: QaRecoveryPacket; menu: readonly string[]; originalIssues?: string; liveSession: boolean; contextUsage?: unknown }) => Promise<QaReportRecoveryDecision>;
  /** Single-use operator retry authorization, consumed with durable intent. */
  qaRemediationAuthorization?: string;
  qaOperatorAnswer?: { decisionId: string; answer: string };
  /** Accumulated authoritative QA/fix history, populated by runIsolatedQa. */
  qaHistory?: QaReportHistoryEntry[];
  qaRuntimeContext?: unknown;
  /** A durable packet selected by build:resume and transferred by validated handoff. */
  resumedRecovery?: QaRecoveryPacket;
  /** True when a continuity wrapper validates and strips deltas before returning turn text. */
  continuityManaged?: boolean;
}

export interface IsolatedQaResult { outcome: "passed" | "blocked" | "needs-human" | "nonconverged" | "waived"; detail?: string; summary?: string; passCertificateId?: string; sourceStateDigest?: string; reviewBasisDigest?: string }

function ensureProtocolPausePacket(opts: IsolatedQaOptions, head: import("./qaProtocolV2.js").QaReducerStateV2, stage: string, detail: string, frozenState?: FrozenQaSourceState): void {
  const db = new WorkflowDb(opts.recovery.projectDir);
  try {
    const pending = db.qaRecoveryHead(opts.recovery.runId, opts.ticket.id);
    if (pending && pending.pendingAction !== "resolved") {
      const packet = loadQaRecoveryPacket(pending.packetPath);
      updateQaRecoveryPosition(packet, stage, pending.correctionTurns, "operator-menu");
      return;
    }
    const attempt = db.qaReviewAttempts(opts.recovery.runId, opts.ticket.id)
      .filter((item) => item.reviewNumber === head.reviewNumber && item.sourceDigest === head.sourceStateDigest)
      .at(-1);
    if (!attempt) throw new Error(`cannot construct a QA recovery packet without review attempt ${head.reviewNumber}`);
    createQaRecoveryPacket({
      projectDir: opts.recovery.projectDir, ...(frozenState ? { frozenState } : { reviewedWorktree: opts.builderWorktree }),
      runId: opts.recovery.runId, ticketId: opts.ticket.id, cycle: attempt.cycle,
      reviewAttempt: head.reviewNumber, reviewAttemptId: attempt.attemptId,
      recoveryStage: stage, pendingAction: "operator-menu",
      resources: {
        "protocol-state": { value: head, purpose: "Exact durable QA reducer state at the fail-closed recovery pause" },
        "pause-reason": { value: detail, purpose: "Host-observed reason automatic replay is prohibited", exactText: true },
      },
    });
  } finally { db.close(); }
}

function pauseQaReview(opts: IsolatedQaOptions, stage: string, detail: string, frozenState: FrozenQaSourceState): IsolatedQaResult {
  const db = new WorkflowDb(opts.recovery.projectDir);
  let head: import("./qaProtocolV2.js").QaReducerStateV2;
  try {
    head = db.qaTicketHead(opts.recovery.runId, opts.ticket.id);
    if (head.state !== "operator-menu") head = db.transitionQa(opts.recovery.runId, opts.ticket.id, head.revision, { type: "operator-menu" });
  } finally { db.close(); }
  ensureProtocolPausePacket(opts, head, stage, detail, frozenState);
  return { outcome: "needs-human", detail: `${detail}. Resume with: rafi build:resume ${opts.recovery.projectDir} --run ${opts.recovery.runId} --ticket ${opts.ticket.id} --qa-revision ${head.revision} --fresh-with-handoff` };
}

function pauseQaProtocol(opts: IsolatedQaOptions, stage: string, detail: string, outcome: IsolatedQaResult["outcome"] = "needs-human"): IsolatedQaResult {
  const db = new WorkflowDb(opts.recovery.projectDir);
  let head: import("./qaProtocolV2.js").QaReducerStateV2;
  try {
    head = db.qaTicketHead(opts.recovery.runId, opts.ticket.id);
    if (head.state !== "operator-menu") head = db.transitionQa(opts.recovery.runId, opts.ticket.id, head.revision, { type: "operator-menu" });
  } finally { db.close(); }
  ensureProtocolPausePacket(opts, head, stage, detail);
  return { outcome, detail: `${detail}. Resume with: rafi build:resume ${opts.recovery.projectDir} --run ${opts.recovery.runId} --ticket ${opts.ticket.id} --qa-revision ${head.revision} --fresh-with-handoff` };
}

function loadDurableQaHistory(db: WorkflowDb, runId: string, ticketId: string): {
  reviews: ReturnType<WorkflowDb["qaReviewAttempts"]>;
  remediations: ReturnType<WorkflowDb["qaRemediationAttempts"]>;
  history: QaNonconvergenceContext["history"];
} {
  const reviews = db.qaReviewAttempts(runId, ticketId);
  const remediations = db.qaRemediationAttempts(runId, ticketId);
  const history = reviews.filter((item) => item.status === "failed" && item.reportDigest).map((item) => {
    const raw = item.reportDigest ? db.getEvidence(item.reportDigest)?.toString() : undefined;
    let report: QaFailureReportV1 | undefined;
    try { report = raw ? JSON.parse(raw) as QaFailureReportV1 : undefined; } catch { report = undefined; }
    const remediation = remediations.filter((candidate) => candidate.reviewAttemptId === item.attemptId && candidate.status === "succeeded").at(-1);
    const remediationRequest = remediation?.requestDigest ? db.getEvidence(remediation.requestDigest)?.toString() : undefined;
    const remediationText = remediation?.responseDigest ? db.getEvidence(remediation.responseDigest)?.toString() : undefined;
    const fixSummary = remediation?.summaryDigest ? db.getEvidence(remediation.summaryDigest)?.toString() : undefined;
    return {
      cycle: item.cycle, reviewAttempt: item.reviewNumber, remediationGeneration: item.remediationGeneration,
      attemptId: item.attemptId, outcome: "qa_fail" as const, detail: item.detail ?? report?.summary ?? "QA failed",
      reportDigest: item.reportDigest, report, findingIds: item.namespacedFindingIds ?? item.findingIds,
      ...(remediationRequest ? { remediationRequest: boundedBuilderSummary(remediationRequest), remediationRequestDigest: remediation!.requestDigest } : {}),
      ...(remediationText ? { remediation: boundedBuilderSummary(remediationText), remediationDigest: remediation!.responseDigest } : {}),
      ...(fixSummary ? { fixSummary, fixSummaryDigest: remediation!.summaryDigest } : {}),
    };
  });
  return { reviews, remediations, history };
}

export async function runIsolatedQa(opts: IsolatedQaOptions): Promise<IsolatedQaResult> {
  if (opts.resumedRecovery && (opts.resumedRecovery.manifest.runId !== opts.recovery.runId || opts.resumedRecovery.manifest.ticketId !== opts.ticket.id)) {
    return { outcome: "needs-human", detail: `QA recovery packet ${opts.resumedRecovery.manifest.runId}/${opts.resumedRecovery.manifest.ticketId} does not match requested scope ${opts.recovery.runId}/${opts.ticket.id}; no QA work was dispatched` };
  }
  const scopeDb = new WorkflowDb(opts.recovery.projectDir);
  let durablePolicy: ReturnType<typeof resolveAutonomyPolicy>;
  let history: QaNonconvergenceContext["history"];
  let durableReviews: ReturnType<WorkflowDb["qaReviewAttempts"]>;
  let durableRemediations: ReturnType<WorkflowDb["qaRemediationAttempts"]>;
  try {
    scopeDb.ensureRun(opts.recovery.runId);
    durablePolicy = scopeDb.autonomyPolicy(opts.recovery.runId) ?? scopeDb.freezeAutonomyPolicy(opts.recovery.runId, resolveAutonomyPolicy(loadProjectAutonomyConfig(opts.recovery.projectDir)));
    const stop = scopeDb.qaRemediationStop(opts.recovery.runId, opts.ticket.id);
    if (stop) {
      const decision = stop.decisionId ? scopeDb.humanDecision(stop.decisionId) : undefined;
      if (decision?.status === "answered" && decision.answer) {
        opts.qaOperatorAnswer = { decisionId: decision.decisionId, answer: decision.answer };
        opts.builderSummary += `\nAuthorized operator answer (${decision.decisionId}): ${JSON.stringify(decision.answer)}`;
      }
      if (!opts.resumedRecovery || stop.outcome === "needs-input" && !opts.qaOperatorAnswer) return { outcome: stop.outcome === "needs-input" ? "needs-human" : "blocked", detail: stop.detail };
    }
    let protocolHead = scopeDb.qaTicketHead(opts.recovery.runId, opts.ticket.id);
    if (protocolHead.state === "turn-intended") {
      protocolHead = scopeDb.transitionQa(opts.recovery.runId, opts.ticket.id, protocolHead.revision, { type: "turn-uncertain" });
    }
    if (protocolHead.state === "turn-uncertain") {
      protocolHead = scopeDb.transitionQa(opts.recovery.runId, opts.ticket.id, protocolHead.revision, { type: "operator-menu" });
      if (!opts.resumedRecovery) {
        ensureProtocolPausePacket(opts, protocolHead, "turn-uncertain", "A QA provider turn may have been dispatched before the prior process stopped");
        return { outcome: "needs-human", detail: `A QA provider turn may have been dispatched before the prior process stopped. Reconcile it before retrying. Resume with: rafi build:resume ${opts.recovery.projectDir} --run ${opts.recovery.runId} --ticket ${opts.ticket.id} --qa-revision ${protocolHead.revision} --fresh-with-handoff` };
      }
    }
    if (protocolHead.state === "remediation-intended" || protocolHead.state === "remediation-uncertain") {
      if (protocolHead.state === "remediation-intended") protocolHead = scopeDb.transitionQa(opts.recovery.runId, opts.ticket.id, protocolHead.revision, { type: "remediation-uncertain" });
      protocolHead = scopeDb.transitionQa(opts.recovery.runId, opts.ticket.id, protocolHead.revision, { type: "operator-menu" });
      if (!opts.resumedRecovery) {
        ensureProtocolPausePacket(opts, protocolHead, "remediation-uncertain", "Builder remediation has an uncertain external outcome; QA must review current source without replaying Builder");
        return { outcome: "needs-human", detail: `Builder remediation has an uncertain external outcome and cannot be replayed automatically. Resume with: rafi build:resume ${opts.recovery.projectDir} --run ${opts.recovery.runId} --ticket ${opts.ticket.id} --qa-revision ${protocolHead.revision} --fresh-with-handoff` };
      }
    }
    if (protocolHead.state === "source-frozen" || protocolHead.state === "review-ready") {
      protocolHead = scopeDb.transitionQa(opts.recovery.runId, opts.ticket.id, protocolHead.revision, { type: "operator-menu" });
    }
    if (opts.resumedRecovery && protocolHead.state === "recheck-required" && opts.resumedRecovery.manifest.pendingAction !== "qa-full-review") {
      opts.resumedRecovery = updateQaRecoveryPosition(opts.resumedRecovery, "qa-full-review", opts.resumedRecovery.manifest.correctionTurns, "qa-full-review");
    }
    durableReviews = scopeDb.qaReviewAttempts(opts.recovery.runId, opts.ticket.id);
    for (const interrupted of durableReviews.filter((item) => item.status === "started")) scopeDb.finishQaReviewAttempt(interrupted.attemptId, { status: "interrupted", detail: "host restarted before the QA attempt reached a durable outcome" });
    durableReviews = scopeDb.qaReviewAttempts(opts.recovery.runId, opts.ticket.id);
    durableRemediations = scopeDb.qaRemediationAttempts(opts.recovery.runId, opts.ticket.id);
    for (const uncertain of durableRemediations.filter((item) => item.status === "intended" || item.status === "started")) scopeDb.updateQaRemediationAttempt(uncertain.attemptId, "uncertain", { detail: "host restarted without a durable Builder completion receipt" });
    durableRemediations = scopeDb.qaRemediationAttempts(opts.recovery.runId, opts.ticket.id);
    ({ history } = loadDurableQaHistory(scopeDb, opts.recovery.runId, opts.ticket.id));
  } finally { scopeDb.close(); }
  opts.state.builderResponseHistory ??= [];
  if (!opts.state.builderResponseHistory.some((entry) => entry.ticketId === opts.ticket.id && entry.kind === "completion" && sha(entry.response) === sha(opts.builderSummary))) {
    opts.state.builderResponseHistory.push({ ticketId: opts.ticket.id, cycle: 0, kind: "completion", response: opts.builderSummary, summary: boundedBuilderSummary(opts.builderSummary) });
  }
  let cycle = 1;
  const policy = durablePolicy;
  const durableLimit = policy.rules["qa.nonconvergence"].max_attempts ?? policy.limits.builderQaFixesPerTicket;
  const maxBuilderFixes = Math.min(opts.maxCycles, durableLimit);
  let automaticFixes = persistedQaFixCount(opts);
  let reviewAttempt = Math.max(opts.state.reviews, ...durableReviews.map((item) => item.reviewNumber), 0);
  let remediationGeneration = Math.max(opts.state.remediationGeneration ?? 0, ...durableReviews.map((item) => item.remediationGeneration), ...durableRemediations.map((item) => item.generation), 0);
  const resumedHeadDb = new WorkflowDb(opts.recovery.projectDir);
  let resumedHead = resumedHeadDb.qaTicketHead(opts.recovery.runId, opts.ticket.id);
  let resumedReport = resumedHead.state === "review-failed"
    ? resumedHeadDb.unresolvedQaReports(opts.recovery.runId, opts.ticket.id).at(-1)
    : undefined;
  resumedHeadDb.close();
  if (resumedHead.state === "review-failed") {
    const resumedReviewNumber = resumedReport?.reviewNumber;
    const causing = resumedReviewNumber === undefined ? undefined : durableReviews.find((item) => item.reviewNumber === resumedReviewNumber)?.attemptId;
    if (!resumedReport || !causing) {
      const missing = !resumedReport
        ? "Durable QA reducer says review-failed but its unresolved report is missing"
        : `Unresolved QA report ${resumedReport.reportDigest} has no durable review attempt`;
      const recoveryDb = new WorkflowDb(opts.recovery.projectDir);
      try { resumedHead = recoveryDb.transitionQa(opts.recovery.runId, opts.ticket.id, resumedHead.revision, { type: "operator-menu" }); }
      finally { recoveryDb.close(); }
      if (opts.resumedRecovery) {
        opts.resumedRecovery = updateQaRecoveryPosition(opts.resumedRecovery, "operator-menu", opts.resumedRecovery.manifest.correctionTurns, "operator-menu");
        resumedReport = undefined;
      } else {
        ensureProtocolPausePacket(opts, resumedHead, "missing-review-evidence", missing);
        return { outcome: "needs-human", detail: `${missing}. Resume with: rafi build:resume ${opts.recovery.projectDir} --run ${opts.recovery.runId} --ticket ${opts.ticket.id} --qa-revision ${resumedHead.revision} --fresh-with-handoff` };
      }
    }
  }
  if (resumedHead.state === "review-failed" && resumedReport) {
    const durableReport = resumedReport;
    if (automaticFixes >= maxBuilderFixes) return pauseQaProtocol(opts, "qa-nonconvergence", `QA remediation budget is exhausted with unresolved report ${durableReport.reportDigest}`, "nonconverged");
    const report = durableReport.report as QaFailureReportV1;
    const causing = durableReviews.find((item) => item.reviewNumber === durableReport.reviewNumber)?.attemptId;
    if (!causing) throw new Error("QA recovery invariant lost its causing review attempt after validation");
    const request: QaFixRequest = {
      kind: "validated-report", report, reportDigest: resumedReport.reportDigest, history: [...history], latestBuilderResult: latestBuilderResponse(opts),
    };
    const fix = await observedQaFix(opts, "resuming pending QA remediation", request, causing);
    if (!fix.ok) return pauseQaProtocol(opts, "builder-remediation-failed", fix.detail ?? "Builder QA remediation failed during restart recovery", fix.outcome === "needs-input" ? "needs-human" : "blocked");
    const fixSummary = boundedBuilderSummary(fix.summary ?? fix.response ?? "Builder reported remediation complete");
    opts.state.builderResponseHistory.push({ ticketId: opts.ticket.id, cycle: durableReport.reviewNumber, kind: "remediation", response: fix.response!, summary: fixSummary });
    opts.builderSummary = fix.response!;
    const prior = history.find((item) => item.attemptId === causing);
    if (prior) {
      const exactRequest = JSON.stringify(request);
      prior.remediationRequest = boundedBuilderSummary(exactRequest); prior.remediationRequestDigest = persistQaEvidence(opts, exactRequest);
      prior.remediation = boundedBuilderSummary(fix.response ?? ""); prior.remediationDigest = persistQaEvidence(opts, fix.response ?? "");
      prior.fixSummary = fixSummary; prior.fixSummaryDigest = persistQaEvidence(opts, fixSummary);
    }
    remediationGeneration += 1; opts.state.remediationGeneration = remediationGeneration;
    automaticFixes += 1; cycle += 1;
  }
  while (true) {
    opts.qaHistory = [...history];
    reviewAttempt += 1;
    const attemptId = randomUUID();
    const review = await withActivityPhase(`running QA review ${cycle} (${automaticFixes}/${maxBuilderFixes} fixes used)`, () => observedQaReview(opts, { cycle, reviewAttempt, remediationGeneration, attemptId }));
    if (review.outcome === "retry-modification") {
      const durableFixes = persistedQaFixCount(opts);
      cycle += Math.max(0, durableFixes - automaticFixes);
      automaticFixes = Math.max(automaticFixes, durableFixes);
      const refreshDb = new WorkflowDb(opts.recovery.projectDir);
      try {
        const head = refreshDb.qaTicketHead(opts.recovery.runId, opts.ticket.id);
        remediationGeneration = Math.max(remediationGeneration, head.remediationGeneration);
        reviewAttempt = Math.max(reviewAttempt, head.reviewNumber);
        const refreshed = loadDurableQaHistory(refreshDb, opts.recovery.runId, opts.ticket.id);
        durableReviews = refreshed.reviews;
        durableRemediations = refreshed.remediations;
        history.splice(0, history.length, ...refreshed.history);
        opts.qaHistory = [...history];
      } finally { refreshDb.close(); }
      opts.state.remediationGeneration = remediationGeneration;
      continue;
    }
    if (review.outcome === "passed") return review;
    if (review.outcome !== "failed") return review;
    reviewAttempt = Math.max(reviewAttempt, review.reviewAttempt);
    history.push({ cycle, reviewAttempt: review.reviewAttempt, remediationGeneration, attemptId: review.reviewAttemptId, outcome: "qa_fail", detail: review.detail, reportDigest: review.reportDigest, report: review.report, findingIds: review.report?.findings.map((finding) => finding.id) });
    if (automaticFixes < maxBuilderFixes) {
      const request: QaFixRequest = { kind: "validated-report", report: review.report, reportDigest: review.reportDigest, history: [...history], latestBuilderResult: latestBuilderResponse(opts) };
      const fix = await observedQaFix(opts, "applying QA fixes", request, review.reviewAttemptId);
      if (!fix.ok) return pauseQaProtocol(opts, "builder-remediation-failed", fix.detail ?? "Builder QA fix failed", fix.outcome === "needs-input" ? "needs-human" : "blocked");
      const fixSummary = boundedBuilderSummary(fix.summary ?? fix.response ?? fix.detail ?? "Builder reported remediation complete");
      opts.state.builderResponseHistory.push({
        ticketId: opts.ticket.id,
        cycle,
        kind: "remediation",
        response: fix.response ?? fix.detail ?? "",
        summary: fixSummary,
      });
      history[history.length - 1]!.fixSummaryDigest = persistQaEvidence(opts, fixSummary);
      history[history.length - 1]!.fixSummary = fixSummary;
      history[history.length - 1]!.remediation = boundedBuilderSummary(fix.response ?? "");
      history[history.length - 1]!.remediationDigest = persistQaEvidence(opts, fix.response ?? "");
      const exactRemediationRequest = JSON.stringify(request);
      history[history.length - 1]!.remediationRequest = boundedBuilderSummary(exactRemediationRequest);
      history[history.length - 1]!.remediationRequestDigest = persistQaEvidence(opts, exactRemediationRequest);
      opts.builderSummary = fix.response!;
      remediationGeneration += 1;
      opts.state.remediationGeneration = remediationGeneration;
      cycle += 1;
      automaticFixes += 1;
      continue;
    }
    const detail = `QA could not converge after ${maxBuilderFixes} Builder fix attempt(s); choose retry, pause, waive, or Planner remediation`;
    if (!opts.onNonconvergence) return pauseQaProtocol(opts, "qa-nonconvergence", detail, "nonconverged");
    const decision = await opts.onNonconvergence({ ticket: opts.ticket, history: [...history], builderWorktree: opts.builderWorktree });
    if (decision.action === "pause") return pauseQaProtocol(opts, "qa-nonconvergence", detail, "nonconverged");
    if (decision.action === "waive") { waiveV2Reports(opts, "Operator explicitly waived unresolved QA findings"); markQaRecoveryResolved(opts); return { outcome: "waived", detail: history.at(-1)?.detail ?? detail, summary: "QA explicitly waived by user" }; }
    const latest = review;
    const remediation = decision.action === "remediate" ? decision.remediation : undefined;
    if (decision.action === "remediate" && !remediation) return pauseQaProtocol(opts, "planner-remediation-missing", "Planner remediation did not produce approved fix instructions", "nonconverged");
    const request: QaFixRequest = remediation
      ? { kind: "planner-remediation", report: latest.report, reportDigest: latest.reportDigest, remediation, history: [...history], latestBuilderResult: latestBuilderResponse(opts) }
      : { kind: "validated-report", report: latest.report, reportDigest: latest.reportDigest, history: [...history], latestBuilderResult: latestBuilderResponse(opts) };
    const authorizationDb = new WorkflowDb(opts.recovery.projectDir);
    try { opts.qaRemediationAuthorization = authorizationDb.authorizeQaRemediation(opts.recovery.runId, opts.ticket.id, review.reviewAttemptId, `Operator selected ${decision.action}`); }
    finally { authorizationDb.close(); }
    const fix = await observedQaFix(opts, "applying QA remediation", request, review.reviewAttemptId, true);
    opts.qaRemediationAuthorization = undefined;
    if (!fix.ok) return pauseQaProtocol(opts, "builder-remediation-failed", fix.detail ?? "Builder QA fix failed", fix.outcome === "needs-input" ? "needs-human" : "blocked");
    const fixSummary = boundedBuilderSummary(fix.summary ?? fix.response ?? fix.detail ?? "Builder reported remediation complete");
    opts.state.builderResponseHistory.push({
      ticketId: opts.ticket.id,
      cycle,
      kind: "remediation",
      response: fix.response ?? fix.detail ?? "",
      summary: fixSummary,
    });
    opts.builderSummary = fix.response!;
    if (remediation) {
      history[history.length - 1]!.remediation = boundedBuilderSummary(`${remediation}\n\nBuilder response:\n${fix.response ?? ""}`);
      history[history.length - 1]!.remediationDigest = persistQaEvidence(opts, `${remediation}\n\nBuilder response:\n${fix.response ?? ""}`);
    } else {
      history[history.length - 1]!.remediation = boundedBuilderSummary(fix.response ?? "");
      history[history.length - 1]!.remediationDigest = persistQaEvidence(opts, fix.response ?? "");
    }
    const exactRemediationRequest = JSON.stringify(request);
    history[history.length - 1]!.remediationRequest = boundedBuilderSummary(exactRemediationRequest);
    history[history.length - 1]!.remediationRequestDigest = persistQaEvidence(opts, exactRemediationRequest);
    history[history.length - 1]!.fixSummary = fixSummary;
    history[history.length - 1]!.fixSummaryDigest = persistQaEvidence(opts, fixSummary);
    remediationGeneration += 1;
    opts.state.remediationGeneration = remediationGeneration;
    cycle += 1;
    automaticFixes += 1;
  }
}

async function observedQaReview(
  opts: IsolatedQaOptions,
  identity: { cycle: number; reviewAttempt: number; remediationGeneration: number; attemptId: string },
): Promise<Awaited<ReturnType<typeof oneReview>>> {
  const run = async (): Promise<Awaited<ReturnType<typeof oneReview>>> => {
    if (!opts.observer) return oneReview(opts, identity);
    const context = opts.observer.context();
    const spanId = opts.observer.store.startSpan(context, {
      kind: "qa_attempt",
      name: `QA review attempt ${identity.reviewAttempt}`,
      attributes: identity,
    });
    opts.observer.store.updateCurrentState({ runId: opts.observer.runId, role: "qa", stream: "qa", executionId: opts.observer.executionId,
      ticketId: opts.ticket.id, phase: `QA review attempt ${identity.reviewAttempt}`, activeSpanId: spanId, activeSpanKind: "qa_attempt",
      lastSemanticProgressAt: new Date().toISOString() });
    try {
      const review = await opts.observer.withContext({ parentSpanId: spanId }, () => oneReview(opts, identity));
      opts.observer.store.finishSpan(spanId, { outcome: review.outcome, attributes: { reviewAttempt: identity.reviewAttempt, cycle: identity.cycle,
        remediationGeneration: identity.remediationGeneration, attemptId: identity.attemptId } });
      return review;
    } catch (error) {
      opts.observer.store.finishSpan(spanId, { outcome: "failed", attributes: { attemptId: identity.attemptId } });
      throw error;
    }
  };
  return opts.observer
    ? opts.observer.withContext({ role: "qa", stream: "qa", ticketId: opts.ticket.id }, run)
    : run();
}

async function observedQaFix(opts: IsolatedQaOptions, phase: string, request: QaFixRequest, causingAttemptId: string, remediation = false): Promise<QaFixResult> {
  const durable = opts.deliverFailure ? undefined : beginQaFixAttempt(opts, causingAttemptId, remediation, request);
  const run = async () => {
    try {
      if (durable?.remediationId) {
        markQaRecoveryAction(opts, "builder-remediation-in-flight");
      }
      const result = await withActivityPhase(phase, () => deliverQaFailureOrLegacyFix(opts, request, causingAttemptId));
      const responseStatus = typeof result.response === "string" ? parseStepStatus(result.response) : undefined;
      const accepted = result.ok
        && typeof result.response === "string" && result.response.length > 0
        && typeof result.summary === "string" && result.summary.length > 0
        && typeof result.providerTurnId === "string" && result.providerTurnId.length > 0
        && responseStatus?.kind === "done";
      const normalized = accepted ? result : result.ok ? { ...result, ok: false, detail: result.detail ?? "Builder remediation success requires an actual response, bounded summary, provider turn identity, and STEP_STATUS: done" } : result;
      finishQaFixAttempt(opts, durable, normalized.ok ? "succeeded" : "failed", normalized.detail, normalized.response, normalized.summary, normalized.providerTurnId);
      if (normalized.ok) markQaRecoveryAction(opts, "qa-full-review");
      return normalized;
    } catch (error) {
      finishQaFixAttempt(opts, durable, "uncertain", error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  if (!opts.observer) return run();
  return opts.observer.withContext({ role: "builder", stream: "qa-fix", ticketId: opts.ticket.id }, async () => {
    const spanId = opts.observer!.store.startSpan(opts.observer!.context(), { kind: "qa_fix", name: phase,
      attributes: { causingAttemptId, remediation } });
    try {
      const result = await opts.observer!.withContext({ parentSpanId: spanId }, run);
      opts.observer!.store.finishSpan(spanId, { outcome: result.ok ? "completed" : "failed", attributes: { causingAttemptId, remediation } });
      return result;
    } catch (error) {
      opts.observer!.store.finishSpan(spanId, { outcome: "failed", attributes: { causingAttemptId, remediation } });
      throw error;
    }
  });
}

function deliverQaFailureOrLegacyFix(opts: IsolatedQaOptions, request: QaFixRequest, causingAttemptId: string): Promise<QaFixResult> {
  if (opts.deliverFailure) {
    const headDb = new WorkflowDb(opts.recovery.projectDir);
    try {
      const attempt = headDb.qaReviewAttempt(causingAttemptId);
      const reportDigest = request.reportDigest;
      if (!attempt) throw new Error(`QA failure delivery is missing review attempt ${causingAttemptId}`);
      const input: QaFailureDeliveryInput = {
        projectDir: opts.recovery.projectDir,
        runId: opts.recovery.runId,
        ticket: opts.ticket,
        builderWorktree: opts.builderWorktree,
        report: request.report,
        reportDigest,
        reviewAttemptId: causingAttemptId,
        reviewNumber: attempt.reviewNumber,
        reviewedSourceStateDigest: attempt.sourceDigest,
        reviewBasisDigest: headDb.qaTicketHead(opts.recovery.runId, opts.ticket.id).reviewBasisDigest ?? "",
        remediationGeneration: attempt.remediationGeneration,
        latestBuilderResult: request.latestBuilderResult,
        history: request.history,
        maxRemediationOperations: opts.maxCycles,
        authorizationId: opts.qaRemediationAuthorization,
        operatorAnswer: opts.qaOperatorAnswer,
        ...(request.kind === "planner-remediation" ? { plannerRemediation: request.remediation } : {}),
      };
      return opts.deliverFailure(input).then((result): QaFixResult => result.ok
        ? { ok: true, response: result.response ?? "", summary: result.summary ?? result.response ?? "Builder reported QA remediation complete", detail: result.detail, providerTurnId: result.providerTurnId, outcome: result.outcome }
        : { ok: false, detail: result.detail, response: result.response, summary: result.summary, providerTurnId: result.providerTurnId, outcome: result.outcome });
    } finally { headDb.close(); }
  }
  if (!opts.fix) throw new Error("QA failure remediation requires the canonical delivery service");
  return opts.fix(request);
}

function qaFixScope(opts: IsolatedQaOptions): { phase: string; cause: string; operationKey: string } {
  return { phase: "qa-remediation", cause: "qa.nonconvergence", operationKey: `qa-fix:${opts.ticket.id}` };
}

function persistedQaFixCount(opts: IsolatedQaOptions): number {
  if (!opts.recovery) return 0;
  const db = new WorkflowDb(opts.recovery.projectDir);
  try {
    return db.qaAutomaticRemediationCount(opts.recovery.runId, opts.ticket.id);
  } finally { db.close(); }
}

function beginQaFixAttempt(opts: IsolatedQaOptions, causingAttemptId: string, remediation: boolean, request: QaFixRequest): { recoveryId: string; remediationId: string; operationId: string; reportDigest: string; requestDigest: string; sourceStateDigest: string } | undefined {
  if (!opts.recovery) return undefined;
  const db = new WorkflowDb(opts.recovery.projectDir);
  try {
    const scope = qaFixScope(opts); const at = new Date().toISOString();
    const head = db.qaTicketHead(opts.recovery.runId, opts.ticket.id);
    if (head.state !== "review-failed") throw new Error(`Builder remediation requires review-failed state, found ${head.state}`);
    const attempt = db.recoveryAttemptCount(opts.recovery.runId, opts.ticket.id, scope.phase, scope.cause, scope.operationKey) + 1;
    const receipt = {
      attemptId: randomUUID(), runId: opts.recovery.runId, ticket: opts.ticket.id, ...scope, attempt,
      disposition: "configured_decision", action: remediation ? "planner_remediation" : "retry_builder", outcome: "intended", intendedAt: at,
      detail: `caused by QA review ${causingAttemptId}`,
    } as const;
    const requestDigest = db.putEvidence("qa", Buffer.from(JSON.stringify(request)));
    const reportDigest = request.reportDigest;
    if (!reportDigest) throw new Error("Builder remediation is missing its causing QA report");
    const generation = head.remediationGeneration + 1;
    const operationId = qaDigest("builder-remediation-operation", { runId: opts.recovery.runId, ticketId: opts.ticket.id, reportDigest, requestDigest, generation });
    const remediationId = operationId;
    db.commitQaRemediationIntent(head.revision, receipt, { attemptId: remediationId, runId: opts.recovery.runId, ticketId: opts.ticket.id, reviewAttemptId: causingAttemptId,
      generation, mode: request.kind, requestDigest });
    return { recoveryId: receipt.attemptId, remediationId, operationId, reportDigest, requestDigest, sourceStateDigest: head.sourceStateDigest! };
  } finally { db.close(); }
}

function finishQaFixAttempt(opts: IsolatedQaOptions, attempt: { recoveryId: string; remediationId: string; operationId: string; reportDigest: string; requestDigest: string; sourceStateDigest: string } | undefined, outcome: "succeeded" | "failed" | "uncertain", detail?: string, response?: string, summary?: string, providerTurnId?: string): void {
  if (!opts.recovery || !attempt) return;
  const db = new WorkflowDb(opts.recovery.projectDir);
  try {
    const responseDigest = typeof response === "string" ? db.putEvidence("qa", Buffer.from(response)) : undefined;
    const summaryDigest = typeof summary === "string" ? db.putEvidence("qa", Buffer.from(boundedBuilderSummary(summary))) : undefined;
    const head = db.qaTicketHead(opts.recovery.runId, opts.ticket.id);
    let receipt: import("./qaProtocolV2.js").BuilderRemediationReceiptV2 | undefined;
    if (outcome === "succeeded") {
      if (!responseDigest || !summaryDigest) throw new Error("successful Builder remediation is missing response evidence");
      if (!providerTurnId) throw new Error("successful Builder remediation is missing its provider turn identity");
      receipt = { version: 2, operationId: attempt.operationId, runId: opts.recovery.runId, ticketId: opts.ticket.id, reportDigest: attempt.reportDigest, sourceStateDigest: attempt.sourceStateDigest, requestDigest: attempt.requestDigest, responseDigest, summaryDigest, providerTurnId, completedAt: new Date().toISOString() };
    }
    db.commitQaRemediationOutcome({ recoveryAttemptId: attempt.recoveryId, remediationAttemptId: attempt.remediationId, outcome, detail, responseDigest, summaryDigest, receipt, expectedRevision: head.revision });
  } finally { db.close(); }
}

async function oneReview(opts: IsolatedQaOptions, identity: { cycle: number; reviewAttempt: number; remediationGeneration: number; attemptId: string }): Promise<IsolatedQaResult | { outcome: "retry-modification" } | { outcome: "failed"; detail: string; report: QaFailureReportV1; reportDigest: string; reviewAttempt: number; reviewAttemptId: string }> {
  const { cycle, remediationGeneration, attemptId } = identity;
  let { reviewAttempt } = identity;
  const started = performance.now();
  const progress = (state: string, detail?: string): void => currentActivity()?.update(state, detail);
  ensureQaRecoveryExcluded(opts.recovery?.projectDir ?? opts.builderWorktree);
  let snapshot: Awaited<ReturnType<typeof createDisposableQaSnapshotAsync>>;
  try {
    snapshot = await withActivityPhase("preparing disposable QA snapshot", () => opts.observer
      ? opts.observer.span("snapshot", "preparing disposable QA snapshot", () => createDisposableQaSnapshotAsync(opts.builderWorktree, progress))
      : createDisposableQaSnapshotAsync(opts.builderWorktree, progress));
  } catch (error) {
    if (!(error instanceof QaSourceInstabilityError)) throw error;
    if (opts.resumedRecovery) {
      let packet = appendQaRecoveryResource(
        opts.resumedRecovery,
        `recovery-history/source-capture-failure-${opts.resumedRecovery.manifest.revision + 1}.json`,
        { message: error.message, attempts: error.attempts },
        { purpose: "Stable source capture failure while resuming QA recovery" },
      );
      const recovery = normalizeUnsupportedOperator(
        await exhausted(packet, "", opts, error.message, undefined, undefined, false, "a stable source snapshot could not be captured"),
        "a stable source snapshot could not be captured",
      );
      if (recovery.outcome === "failed") return recovery.result;
      if (recovery.outcome === "retry") return { outcome: "retry-modification" };
      return { outcome: "needs-human", detail: error.message };
    }
    const db = new WorkflowDb(opts.recovery.projectDir);
    let qaRevision = 0;
    try {
      const run = db.getRun(opts.recovery.runId) ?? db.ensureRun(opts.recovery.runId);
      let head = db.qaTicketHead(opts.recovery.runId, opts.ticket.id);
      if (head.state === "idle") head = db.transitionQa(opts.recovery.runId, opts.ticket.id, head.revision, { type: "operator-menu" });
      qaRevision = head.revision;
      db.transition(opts.recovery.runId, { status: "paused", checkpoint: "qa-source-capture", remainingWork: run.remainingWork, state: run.state,
        event: "qa_source_capture_unstable", payload: { ticketId: opts.ticket.id, attempts: error.attempts } });
    } finally { db.close(); }
    return { outcome: "needs-human", detail: `${error.message}. No QA session or report was created. Resume with: rafi build:resume ${opts.recovery.projectDir} --run ${opts.recovery.runId} --ticket ${opts.ticket.id} --qa-revision ${qaRevision} --fresh-session` };
  }
  let qa: BuilderAdapter | undefined;
  let recoverySnapshot: Awaited<ReturnType<typeof createDisposableQaSnapshotAsync>> | undefined;
  let recoveryContext: ReturnType<typeof materializeQaRecoveryContext> | undefined;
  let resumedPacket = opts.resumedRecovery;
  let resumedFullReviewNeedsBinding = false;
  let durableReviewStarted = false;
  let durableReviewFinished = false;
  try {
    const prerequisiteEvidence = await checkQaPrerequisites({ snapshotPath: snapshot.path, sourceDigest: snapshot.frozenState.digest, ticket: opts.ticket, runtimeContext: opts.qaRuntimeContext });
    const prerequisiteDb = new WorkflowDb(opts.recovery.projectDir);
    try { prerequisiteDb.putEvidence("qa", Buffer.from(JSON.stringify(prerequisiteEvidence))); } finally { prerequisiteDb.close(); }
    const missingPrerequisites = prerequisiteEvidence.checks.filter(check => check.outcome === "not_run");
    if (missingPrerequisites.length && !prerequisiteEvidence.sourceDefects.length) return { outcome: "blocked", detail: `QA verification prerequisites unavailable; required checks were not_run: ${missingPrerequisites.map(check => check.evidence).join("; ")}. Restore the required environment with existing authority, then resume for fresh QA.` };
    let handoff = buildQaReviewHandoff(opts.ticket, opts.builderSummary, snapshot.manifest.diffDigest, loadTicketSetupConfigWithDefaults(opts.builderWorktree).build.validation_checklist, snapshot.frozenState.changeSummary, opts.qaHistory);
    handoff += `\nHost prerequisite evidence (availability does not prove provider sandbox access): ${JSON.stringify(prerequisiteEvidence)}\nRecord tests prevented from executing as not_run with the actual reason. Never install dependencies, create a lockfile, provision services, or claim an unconditional pass when required verification was not run.`;
    // Every disposable snapshot has a distinct cwd and therefore must have a
    // fresh provider conversation. Cumulative QA state remains in the durable
    // continuity/checkpoint stream; an old provider session is never moved
    // into a newly-created /tmp/rafi-qa-* directory.
    let qaHandle = await opts.createQa(snapshot.path);
    qa = qaHandle.adapter;
    const qaEvents = startQaEventRecorder(qa);
    try { validateQaSessionHandle(qaHandle, snapshot.path); }
    catch (error) {
      if (!resumedPacket) throw error;
      const detail = `QA recovery session identity is invalid: ${error instanceof Error ? error.message : String(error)}`;
      const recovery = await exhausted(resumedPacket, "", opts, detail, undefined, snapshot, false, "the resumed QA session identity is not valid");
      if (recovery.outcome === "failed") return recovery.result;
      if (recovery.outcome === "retry") return { outcome: "retry-modification" };
      return { outcome: "needs-human", detail };
    }
    const v2Binding = beginV2Review(opts, snapshot.frozenState, snapshot.path, handoff, qaHandle, { attemptId, cycle, remediationGeneration });
    bindQaTurnAdapter(qa, v2Binding);
    reviewAttempt = v2Binding.reviewNumber;
    identity = { ...identity, reviewAttempt };
    durableReviewStarted = true;
    if (resumedPacket) resumedPacket = v2Binding.recoveryPacket;
    let preparedTurn: TurnResult | undefined;
    let preparedContract: ReturnType<typeof parseQaResponseContract> | undefined;
    if (opts.resumedRecovery) {
      if (opts.resumedRecovery.manifest.ticketId !== opts.ticket.id) return { outcome: "needs-human", detail: `QA recovery packet ticket ${opts.resumedRecovery.manifest.ticketId} does not match current ticket ${opts.ticket.id}` };
      try {
        if (qaHandle.handoffReceipt.kind !== "accepted") throw new Error("QA recovery resume requires a validated fresh-session acceptance receipt");
        validateBoundaryReceipt(qaHandle.handoffReceipt.receipt, opts.resumedRecovery, qaHandle);
        const recoveryDb = new WorkflowDb(opts.recovery.projectDir);
        try { recoveryDb.clearQaRemediationStop(opts.recovery.runId, opts.ticket.id, "Validated fresh-session recovery acceptance; QA must re-evaluate current source and prerequisites"); }
        finally { recoveryDb.close(); }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const synthetic: TurnResult = { text: "", rawResponse: "", cleanedResponse: "", isError: true, numTurns: 0, costUsd: 0 };
        const recovery = await repairResumedFailureReport(opts, identity, resumedPacket!, snapshot, qaHandle, synthetic, [detail], qaEvents, undefined, true);
        if (recovery.outcome === "failed") return recovery.result;
        if (recovery.outcome === "retry") return { outcome: "retry-modification" };
        if (recovery.outcome === "passed") return recovery.result;
        qa = recovery.qa; recoverySnapshot = recovery.snapshot;
        if (recovery.outcome === "manual") {
          const text = `${QA_FAILURE_REPORT_START}\n${JSON.stringify(recovery.report)}\n${QA_FAILURE_REPORT_END}\nSTEP_STATUS: qa_fail | issues="operator repaired report"`;
          preparedTurn = { text, rawResponse: text, cleanedResponse: text, isError: false, numTurns: 0, costUsd: 0 };
          preparedContract = { valid: true, errors: [], status: "qa_fail", fields: { issues: "operator repaired report" }, report: recovery.report, rawReportJson: JSON.stringify(recovery.report) };
        } else { preparedTurn = recovery.turn; preparedContract = recovery.contract; }
      }
      let comparison: ReturnType<typeof compareQaRecoveryReviewedState>;
      try { comparison = compareQaRecoveryReviewedState(opts.resumedRecovery, snapshot.frozenState); }
      catch (error) {
        const reason = `QA recovery error: current reviewed state cannot be reconstructed: ${error instanceof Error ? error.message : String(error)}`;
        const synthetic: TurnResult = { text: "", rawResponse: "", cleanedResponse: "", isError: true, numTurns: 0, costUsd: 0 };
        const recovery = await repairResumedFailureReport(opts, identity, resumedPacket!, snapshot, qaHandle, synthetic, [reason], qaEvents, undefined, true, reason);
        if (recovery.outcome === "failed") return recovery.result;
        if (recovery.outcome === "retry") return { outcome: "retry-modification" };
        if (recovery.outcome === "passed") return recovery.result;
        if (recovery.outcome === "manual") return { outcome: "needs-human", detail: `${reason}; a manual reconstruction cannot replace missing reviewed-state evidence` };
        qa = recovery.qa; recoverySnapshot = recovery.snapshot;
        preparedTurn = recovery.turn; preparedContract = recovery.contract;
        const recoveredState = (recovery.snapshot ?? snapshot).frozenState;
        comparison = { matches: true, originalDigest: recoveredState.digest, currentDigest: recoveredState.digest, drift: [], frozenState: recoveredState };
      }
      if (!preparedTurn) {
      if (!comparison.matches) {
        resumedPacket = appendQaRecoveryResource(resumedPacket!, `recovery-history/drift-${identity.attemptId}.json`, { originalDigest: comparison.originalDigest, currentDigest: comparison.currentDigest, drift: comparison.drift, priorReports: "historical" }, { purpose: "Deterministic current-source drift summary; every earlier report is historical" });
        if (resumedPacket.manifest.reviewedStateDigest !== snapshot.frozenState.digest) {
          resumedPacket = appendQaRecoveryReviewedState(resumedPacket, snapshot.frozenState, `reviewed-state/current-r${resumedPacket.manifest.revision + 1}`);
        }
      }
      try {
        recoveryContext = materializeQaRecoveryContext(resumedPacket!, snapshot.path);
        bindQaRecoveryContext(qa, recoveryContext);
      }
      catch (error) {
        const detail = `QA recovery context could not be materialized: ${error instanceof Error ? error.message : String(error)}`;
        const synthetic: TurnResult = { text: "", rawResponse: "", cleanedResponse: "", isError: true, numTurns: 0, costUsd: 0 };
        const recovery = await repairResumedFailureReport(opts, identity, resumedPacket!, snapshot, qaHandle, synthetic, [detail], qaEvents, undefined, true);
        if (recovery.outcome === "failed") return recovery.result;
        if (recovery.outcome === "retry") return { outcome: "retry-modification" };
        if (recovery.outcome === "passed") return recovery.result;
        qa = recovery.qa; recoverySnapshot = recovery.snapshot;
        if (recovery.outcome === "manual") {
          const text = `${QA_FAILURE_REPORT_START}\n${JSON.stringify(recovery.report)}\n${QA_FAILURE_REPORT_END}\nSTEP_STATUS: qa_fail | issues="operator repaired report"`;
          preparedTurn = { text, rawResponse: text, cleanedResponse: text, isError: false, numTurns: 0, costUsd: 0 };
          preparedContract = { valid: true, errors: [], status: "qa_fail", fields: { issues: "operator repaired report" }, report: recovery.report, rawReportJson: JSON.stringify(recovery.report) };
        } else { preparedTurn = recovery.turn; preparedContract = recovery.contract; }
      }
      if (!preparedTurn) {
      if (!recoveryContext) throw new Error("QA recovery context invariant failed after successful materialization");
      const acknowledgement = renderQaRecoveryAcknowledgementInstruction(resumedPacket!, recoveryContext.relativePath);
      const acknowledged = await performRecoveryAcknowledgement(resumedPacket!, qa, acknowledgement, qaEvents, Boolean(opts.continuityManaged), "resume-entry", recoveryContext);
      resumedPacket = acknowledged.packet;
      const ackErrors = acknowledged.errors;
      if (ackErrors.length) {
        const synthetic: TurnResult = { text: "", rawResponse: "", cleanedResponse: "", isError: true, numTurns: 0, costUsd: 0 };
        const recovery = await repairResumedFailureReport(opts, identity, resumedPacket, snapshot, qaHandle, synthetic, ackErrors, qaEvents, recoveryContext, true);
        if (recovery.outcome === "failed") return recovery.result;
        if (recovery.outcome === "retry") return { outcome: "retry-modification" };
        if (recovery.outcome === "passed") return recovery.result;
        qa = recovery.qa; recoverySnapshot = recovery.snapshot;
        if (recovery.outcome === "manual") {
          const text = `${QA_FAILURE_REPORT_START}\n${JSON.stringify(recovery.report)}\n${QA_FAILURE_REPORT_END}\nSTEP_STATUS: qa_fail | issues="recovered report"`;
          preparedTurn = { text, rawResponse: text, cleanedResponse: text, isError: false, numTurns: 0, costUsd: 0 };
          preparedContract = { valid: true, errors: [], status: "qa_fail", fields: { issues: "recovered report" }, report: recovery.report, rawReportJson: JSON.stringify(recovery.report) };
        } else { preparedTurn = recovery.turn; preparedContract = recovery.contract; }
      }
      if (!preparedTurn) {
        try { recoveryContext.verify(); }
        catch (error) { return pauseQaReview(opts, "recovery-context-mutation", error instanceof Error ? error.message : String(error), (recoverySnapshot ?? snapshot).frozenState); }
        handoff = `${handoff}\n\nThis is a fresh QA session. Perform a complete review of the current immutable snapshot; use every prior report only as historical evidence.${comparison.matches ? "" : ` The source has drifted. Original reviewed-state digest: ${comparison.originalDigest}. Current reviewed-state digest: ${comparison.currentDigest}. Deterministic drift inventory: ${JSON.stringify(comparison.drift)}.`}`;
        resumedFullReviewNeedsBinding = true;
      }
      }
      }
      opts.resumedRecovery = undefined;
    }
    if (resumedFullReviewNeedsBinding) {
      const resumedReviewBinding = beginV2Review(opts, snapshot.frozenState, snapshot.path, handoff, qaHandle, { attemptId: randomUUID(), cycle, remediationGeneration });
      bindQaTurnAdapter(qa, resumedReviewBinding);
      resumedPacket = resumedReviewBinding.recoveryPacket;
      reviewAttempt = resumedReviewBinding.reviewNumber;
    }
    let turn = preparedTurn ?? await sendDurableQaTurn(qa, handoff, qaEvents, "initial"); let status = parseStepStatus(turn.text);
    recoveryContext = qaTurnBindings.get(qa)?.recoveryContext;
    try {
      if (!preparedTurn) recoveryContext?.verify();
      await opts.observeNativeCompactions?.(qa);
      recoveryContext?.verify();
    } catch (error) {
      return pauseQaReview(opts, "recovery-context-mutation", error instanceof Error ? error.message : String(error), (recoverySnapshot ?? snapshot).frozenState);
    }
    let responseContract = preparedContract ?? parseQaResponseContract(turn.text);
    let responseProtocolError: string | undefined;
    if (status.kind !== "qa_fail" && status.kind !== "unknown" && !responseContract.valid) {
      responseProtocolError = `invalid QA response contract: ${responseContract.errors.join("; ")}`;
    }
    if (!turn.isError && status.kind === "blocked" && opts.resolveBlocked) {
      const reason = status.reason ?? "QA reported an unspecified blocker";
      turn = await sendDurableQaTurn(qa, [
        `Your QA review reported a blocker: ${reason}`,
        "Resolve the blocker if possible without changing project files. Otherwise return a precise STEP_STATUS: blocked marker.",
        "If you can finish the review, return the complete QA response contract.",
      ].join("\n\n"), qaEvents, "blocked-recovery");
      try { recoveryContext?.verify(); }
      catch (error) { return pauseQaReview(opts, "recovery-context-mutation", error instanceof Error ? error.message : String(error), (recoverySnapshot ?? snapshot).frozenState); }
      status = parseStepStatus(turn.text);
      try {
        await opts.observeNativeCompactions?.(qa);
        recoveryContext?.verify();
      } catch (error) {
        return pauseQaReview(opts, "recovery-context-mutation", error instanceof Error ? error.message : String(error), (recoverySnapshot ?? snapshot).frozenState);
      }
      responseContract = parseQaResponseContract(turn.text);
      responseProtocolError = undefined;
      if (status.kind !== "qa_fail" && status.kind !== "unknown" && !responseContract.valid) {
        responseProtocolError = `invalid QA response contract after blocker recovery: ${responseContract.errors.join("; ")}`;
      }
    }
    opts.state.reviews += 1; opts.state.sessionId = qa.sessionId(); opts.state.sessionRef = qa.sessionRef?.();
    const reviewedSnapshot = recoverySnapshot ?? snapshot;
    const changes = await withActivityPhase("checking QA file changes", () => reviewedSnapshot.qaChanges());
    if (changes.length) {
      opts.state.modificationViolations += 1;
      opts.evidence?.({ cycle, reviewAttempt, remediationGeneration, attemptId, outcome: "qa_file_modification", detail: "QA modified the disposable review copy", durationMs: Math.max(0, performance.now() - started), qaDiff: changes });
      if (opts.state.modificationViolations === 1) return { outcome: "retry-modification" };
      return pauseQaReview(opts, "qa-mutation", `QA modified files twice: ${changes.join(", ")}`, reviewedSnapshot.frozenState);
    }
    opts.state.modificationViolations = 0;
    const liveSource = await captureFrozenQaSourceAsync(opts.builderWorktree, progress);
    let activeBinding = qaTurnBindings.get(qa);
    if (!activeBinding) throw new Error("QA verdict is missing its durable source/review-basis binding");
    if (liveSource.digest !== activeBinding.sourceStateDigest || reviewedSnapshot.frozenState.digest !== activeBinding.sourceStateDigest) {
      const driftDb = new WorkflowDb(opts.recovery.projectDir);
      try {
        const head = driftDb.qaTicketHead(opts.recovery.runId, opts.ticket.id);
        if (head.state === "turn-intended") driftDb.transitionQa(opts.recovery.runId, opts.ticket.id, head.revision, { type: "source-drift" });
      } finally { driftDb.close(); }
      finishDurableQaReview(opts, activeBinding.reviewAttemptId, { status: "interrupted", detail: `Builder source drifted before verdict acceptance (${activeBinding.sourceStateDigest} -> ${liveSource.digest})` });
      durableReviewFinished = true;
      return { outcome: "retry-modification" };
    }
    if (responseProtocolError) return pauseQaReview(opts, "invalid-response-contract", responseProtocolError, reviewedSnapshot.frozenState);
    if (turn.isError || turn.failure) return pauseQaReview(opts, "qa-turn-error", `QA turn failed: ${sanitizePreview(turn.text)}`, reviewedSnapshot.frozenState);
    if (status.kind === "blocked") return pauseQaReview(opts, "qa-blocked", status.reason ?? "QA reported blocked", reviewedSnapshot.frozenState);
      if (status.kind === "qa_pass") {
      const contract = responseContract;
      if (!contract.valid) return pauseQaReview(opts, "invalid-pass-contract", `invalid QA pass response: ${contract.errors.join("; ")}`, reviewedSnapshot.frozenState);
      if (missingPrerequisites.length) return pauseQaReview(opts, "verification-not-run", "Required verification remains not_run; prerequisite recovery and fresh QA required", reviewedSnapshot.frozenState);
      const certificate = finishV2Pass(opts, qa, status.summary ?? "qa_pass");
      markQaRecoveryResolved(opts);
      durableReviewFinished = true;
      opts.evidence?.({ cycle, reviewAttempt: activeBinding.reviewNumber, remediationGeneration, attemptId: activeBinding.reviewAttemptId, outcome: "passed", detail: status.summary ?? "qa_pass", durationMs: Math.max(0, performance.now() - started) }); return { outcome: "passed", summary: status.summary, passCertificateId: certificate.certificateId, sourceStateDigest: certificate.sourceStateDigest, reviewBasisDigest: certificate.reviewBasisDigest };
    }
    if (status.kind === "qa_fail" || responseContract.status === "qa_fail") {
      let contract = responseContract;
      if (!contract.valid || !contract.report) {
        const recovery = resumedPacket
          ? await repairResumedFailureReport(opts, identity, resumedPacket, snapshot, qaHandle, turn, contract.errors, qaEvents, recoveryContext)
          : await repairInvalidFailureReport(opts, identity, snapshot, qa, qaHandle, handoff, turn, contract.errors, qaEvents);
        if (recovery.outcome === "failed") return recovery.result;
        if (recovery.outcome === "retry") return { outcome: "retry-modification" };
        if (recovery.outcome === "passed") return recovery.result;
        if (recovery.outcome === "manual") {
          qa = recovery.qa; recoverySnapshot = recovery.snapshot; contract = { valid: true, errors: [], status: "qa_fail", fields: {}, report: recovery.report };
        } else {
          qa = recovery.qa; recoverySnapshot = recovery.snapshot; turn = recovery.turn; contract = recovery.contract;
        }
        const recoveryChanges = await (recoverySnapshot ?? snapshot).qaChanges();
        if (recoveryChanges.length) return { outcome: "needs-human", detail: `QA modified files during report recovery: ${recoveryChanges.join(", ")}` };
        activeBinding = qaTurnBindings.get(qa);
        if (!activeBinding) throw new Error("Recovered QA verdict is missing its durable source/review-basis binding");
        const recoveredLiveSource = await captureFrozenQaSourceAsync(opts.builderWorktree, progress);
        const recoveredSnapshot = recoverySnapshot ?? snapshot;
        if (recoveredLiveSource.digest !== activeBinding.sourceStateDigest || recoveredSnapshot.frozenState.digest !== activeBinding.sourceStateDigest) {
          const driftDb = new WorkflowDb(opts.recovery.projectDir);
          try {
            const head = driftDb.qaTicketHead(opts.recovery.runId, opts.ticket.id);
            if (head.state === "turn-intended") driftDb.transitionQa(opts.recovery.runId, opts.ticket.id, head.revision, { type: "source-drift" });
          } finally { driftDb.close(); }
          finishDurableQaReview(opts, activeBinding.reviewAttemptId, { status: "interrupted", detail: `Builder source drifted before recovered verdict acceptance (${activeBinding.sourceStateDigest} -> ${recoveredLiveSource.digest})` });
          durableReviewFinished = true;
          return { outcome: "retry-modification" };
        }
        if (contract.valid && contract.status === "qa_pass") {
          if (missingPrerequisites.length) return pauseQaReview(opts, "verification-not-run", "Required verification remains not_run; prerequisite recovery and fresh QA required", reviewedSnapshot.frozenState);
          const certificate = finishV2Pass(opts, qa, contract.fields.summary ?? "qa_pass");
          markQaRecoveryResolved(opts);
          durableReviewFinished = true;
          opts.evidence?.({ cycle, reviewAttempt: activeBinding.reviewNumber, remediationGeneration, attemptId: activeBinding.reviewAttemptId, outcome: "passed", detail: contract.fields.summary ?? "qa_pass", durationMs: Math.max(0, performance.now() - started) });
          return { outcome: "passed", summary: contract.fields.summary, passCertificateId: certificate.certificateId, sourceStateDigest: certificate.sourceStateDigest, reviewBasisDigest: certificate.reviewBasisDigest };
        }
      }
      const acceptedBinding = activeBinding;
      const report = contract.report!;
      const rawFindingIds = report.findings.map((finding) => finding.id);
      const digest = qaReportDigest(report); const detail = report.summary;
      const findingRefs = qaFindingRefs(opts.recovery.runId, opts.ticket.id, acceptedBinding.reviewAttemptId, digest, rawFindingIds);
      if (opts.recovery) { const db = new WorkflowDb(opts.recovery.projectDir); try { const stored = db.putEvidence("qa", Buffer.from(canonicalJson(report))); if (stored !== digest) throw new Error("QA report evidence digest mismatch"); db.putEvidence("qa", Buffer.from(canonicalJson(findingRefs))); } finally { db.close(); } }
      opts.evidence?.({ cycle, reviewAttempt: acceptedBinding.reviewNumber, remediationGeneration, attemptId: acceptedBinding.reviewAttemptId, outcome: "failed", detail: `${detail} [report ${digest}]`, durationMs: Math.max(0, performance.now() - started) });
      finishV2Failure(opts, qa, digest, report, rawFindingIds, findingRefs); durableReviewFinished = true;
      markQaRecoveryPendingBuilder(opts);
      return { outcome: "failed", detail, report, reportDigest: digest, reviewAttempt: acceptedBinding.reviewNumber, reviewAttemptId: acceptedBinding.reviewAttemptId };
    }
    return pauseQaReview(opts, "unrecognized-qa-outcome", status.error ?? `QA returned ${status.kind}`, reviewedSnapshot.frozenState);
  } finally {
    if (durableReviewStarted && !durableReviewFinished) {
      try {
        const cleanupDb = new WorkflowDb(opts.recovery.projectDir);
        try {
          for (const unfinished of cleanupDb.qaReviewAttempts(opts.recovery.runId, opts.ticket.id).filter((item) => item.status === "started")) {
            cleanupDb.finishQaReviewAttempt(unfinished.attemptId, { status: "interrupted", detail: "QA review ended without a terminal accepted report" });
          }
        } finally { cleanupDb.close(); }
      } catch { /* preserve the primary result */ }
    }
    if (qa) await withActivityPhase("closing QA session", () => qa!.close().catch(() => {}));
    if (recoverySnapshot) await recoverySnapshot.remove().catch(() => {});
    await withActivityPhase("cleaning up disposable QA snapshot", () => opts.observer
      ? opts.observer.span("cleanup", "cleaning up disposable QA snapshot", () => snapshot.remove())
      : snapshot.remove());
  }
}

function finishDurableQaReview(opts: IsolatedQaOptions, attemptId: string, patch: Parameters<WorkflowDb["finishQaReviewAttempt"]>[1]): void {
  const db = new WorkflowDb(opts.recovery.projectDir);
  try { db.finishQaReviewAttempt(attemptId, patch); } finally { db.close(); }
}

function qaFindingRefs(runId: string, ticketId: string, reviewAttemptId: string, reportDigest: string, rawFindingIds: string[]): QaFindingRefV2[] {
  return createQaFindingRefs({ runId, ticketId, reviewAttemptId, reportDigest, rawFindingIds });
}

async function repairResumedFailureReport(
  opts: IsolatedQaOptions,
  identity: { cycle: number; reviewAttempt: number; remediationGeneration: number; attemptId: string },
  initialPacket: QaRecoveryPacket,
  snapshot: Awaited<ReturnType<typeof createDisposableQaSnapshotAsync>>,
  originalHandle: QaSessionHandle,
  originalTurn: TurnResult,
  originalErrors: string[],
  qaEvents: BuilderEvent[],
  recoveryContext?: ReturnType<typeof materializeQaRecoveryContext>,
  startAtMenu = false,
  requireFreshReviewReason?: string,
): Promise<
  | { outcome: "recovered"; qa: BuilderAdapter; snapshot?: Awaited<ReturnType<typeof createDisposableQaSnapshotAsync>>; turn: import("./adapters/types.js").TurnResult; contract: ReturnType<typeof parseQaResponseContract> }
  | { outcome: "failed"; result: IsolatedQaResult }
  | { outcome: "passed"; result: IsolatedQaResult }
  | { outcome: "retry" }
  | { outcome: "manual"; qa: BuilderAdapter; snapshot?: Awaited<ReturnType<typeof createDisposableQaSnapshotAsync>>; report: QaFailureReportV1 }
> {
  const originalQa = originalHandle.adapter;
  const originalResponse = effectiveTurnText(originalTurn);
  let packet = appendQaRecoveryResource(initialPacket, `qa-responses/resumed-${identity.attemptId}.txt`, originalResponse, {
    purpose: "Exact first cleaned QA report response after resumed packet acknowledgement", exact: true,
  });
  await awaitQaTurnEvent(qaEvents, originalTurn);
  packet = await appendTurnObservation(packet, `resumed-original-${identity.attemptId}`, originalTurn, originalTurn.hostInstruction, originalErrors, "resumed-fail-closed", qaEvents);
  packet = appendQaRecoveryResource(packet, `validation/resumed-${identity.attemptId}.json`, {
    status: parseStepStatus(originalResponse), errors: originalErrors, recoveryStage: "resumed-fail-closed",
  }, { purpose: "Validation result for the first resumed QA report response" });

  void packet;
  void requireFreshReviewReason;
  return { outcome: "failed", result: pauseQaReview(opts, "resumed-reconstruction-disabled", "Resumed QA report reconstruction is no longer authoritative; run a complete fresh QA review of current source", snapshot.frozenState) };
}

export function buildQaReviewHandoff(ticket: TicketDef, builderSummary: string, diffDigest: string, validationChecklist: string[], changeSummary?: unknown, history: QaReportHistoryEntry[] = []): string {
  return [
    buildQaInstruction(), "", "QA handoff:", `Complete ticket definition: ${JSON.stringify(ticket)}`,
    `Actual Builder result: ${boundedBuilderSummary(builderSummary)}`,
    `Builder worktree change digest: ${diffDigest}`, `Deterministic change summary: ${JSON.stringify(changeSummary ?? { diffDigest })}`,
    `Project validation checklist: ${validationChecklist.join("; ")}`,
    `Prior authoritative QA/report and Builder-remediation history: ${history.length ? JSON.stringify(boundedQaHistory(history)) : "(none; perform a complete first review)"}`,
    `Failure report JSON Schema: ${JSON.stringify(qaFailureReportV1Schema)}`,
    `A failing response must use exactly:\n${QA_FAILURE_REPORT_START}\n{...valid QaFailureReportV1 JSON...}\n${QA_FAILURE_REPORT_END}\nSTEP_STATUS: qa_fail | issues="short plain-text synopsis"`,
    "Be very thorough. Don't leave anything out. Make sure all required fields are added. Triple check your work to ensure nothing is left out and all required fields are added and populated correctly.",
    "Do not change source, configuration, documentation, tickets, or control files. Only ignored cache, coverage, and build output is allowed.",
  ].join("\n");
}

export async function compactWithRetry(adapter: BuilderAdapter): Promise<CompactResult> {
  if (!adapter.compact) return { ok: false, error: "native compaction unavailable" };
  try {
    const result = await adapter.compact();
    return result.ok ? { ok: true } : result;
  } catch (failure) {
    if (failure instanceof SessionUnavailableError) return { ok: false, error: failure.message, failure: failure.failure };
    return { ok: false, error: failure instanceof Error ? failure.message : String(failure) };
  }
}

export const QA_REPORT_RECOVERY_MENU = [
  "Try a complete fresh QA review.", "Manually fix saved JSON for human inspection.", "Give QA specific instructions for a fresh review.", "Pause.",
] as const;

function correctionInstruction(errors: string[], guidance?: string): string {
  return [
    "Report correction only. Reconstruct the already-completed QA review without rerunning tools, tests, or repository inspection.",
    `The prior failure report was invalid: ${errors.join("; ")}`,
    guidance ? `Operator guidance: ${guidance}` : "",
    `Return exactly one valid envelope in this order:\n${QA_FAILURE_REPORT_START}\n{...valid JSON matching the supplied schema...}\n${QA_FAILURE_REPORT_END}\nSTEP_STATUS: qa_fail | issues="short plain-text synopsis"`,
    "Do not omit any completed finding, check, evidence, or observation.",
  ].filter(Boolean).join("\n\n");
}

async function repairInvalidFailureReport(
  opts: IsolatedQaOptions,
  identity: { cycle: number; reviewAttempt: number; remediationGeneration: number; attemptId: string },
  snapshot: Awaited<ReturnType<typeof createDisposableQaSnapshotAsync>>,
  originalQa: BuilderAdapter,
  qaHandle: QaSessionHandle,
  reviewPrompt: string,
  originalTurn: TurnResult,
  originalErrors: string[],
  qaEvents: BuilderEvent[],
): Promise<
  | { outcome: "recovered"; qa: BuilderAdapter; snapshot?: Awaited<ReturnType<typeof createDisposableQaSnapshotAsync>>; turn: import("./adapters/types.js").TurnResult; contract: ReturnType<typeof parseQaResponseContract> }
  | { outcome: "failed"; result: IsolatedQaResult }
  | { outcome: "passed"; result: IsolatedQaResult }
  | { outcome: "retry" }
  | { outcome: "manual"; qa: BuilderAdapter; snapshot?: Awaited<ReturnType<typeof createDisposableQaSnapshotAsync>>; report: QaFailureReportV1 }
> {
  const originalResponse = effectiveTurnText(originalTurn);
  const runId = opts.recovery?.runId ?? `volatile-${identity.attemptId}`;
  const continuity = qaContinuityRecoveryContext(opts);
  await awaitQaTurnEvent(qaEvents, originalTurn);
  const packetInput: QaRecoveryPacketInput = {
    projectDir: opts.recovery?.projectDir ?? opts.builderWorktree, frozenState: snapshot.frozenState,
    runId, ticketId: opts.ticket.id, cycle: identity.cycle, reviewAttempt: identity.reviewAttempt,
    reviewAttemptId: identity.attemptId,
    recoveryStage: "same-session", correctionTurns: 0, reportJson: extractReportBody(originalResponse),
    resources: {
      ticket: { value: opts.ticket, purpose: "Complete authoritative ticket definition" },
      "qa-review-prompt": { value: reviewPrompt, purpose: "Exact original QA review instruction", exactText: true },
      "report-schema": { value: qaFailureReportV1Schema, purpose: "Authoritative QA failure report schema" },
      "builder-result": { value: opts.builderSummary, purpose: "Latest bounded Builder context supplied to QA", exactText: true },
      "builder-response-history": { value: (opts.state.builderResponseHistory ?? []).filter((entry) => entry.ticketId === opts.ticket.id), purpose: "Every exact host-observed Builder completion/remediation response and its bounded prompt summary" },
      "original-host-prompt": { value: originalTurn.hostInstruction ?? reviewPrompt, purpose: "Exact host-requested original QA instruction", exactText: true },
      "original-provider-prompt": { value: originalTurn.providerInstruction ?? { unavailable: "adapter did not expose provider-dispatched instruction" }, purpose: "Exact provider-dispatched original QA instruction or explicit unavailable marker", exactText: typeof originalTurn.providerInstruction === "string" },
      "original-raw-response": { value: originalTurn.rawResponse ?? originalResponse, purpose: "Exact raw provider response before cleanup", exactText: true },
      "original-cleaned-response": { value: originalResponse, purpose: "Exact cleaned original response used for contract validation", exactText: true },
      "original-validation": { value: { errors: originalErrors, parsedStatus: parseStepStatus(originalResponse), responseBytes: Buffer.byteLength(originalResponse), turn: turnMetadata(originalTurn) }, purpose: "Parsed status, validator result, and complete host-observable turn metadata" },
      "qa-history": { value: opts.qaHistory ?? [], purpose: "Earlier valid reports, observations, fixes, and unresolved history" },
      "tool-events": { value: qaEvents.length ? qaEvents : { unavailable: true }, purpose: "All QA tool/activity events available through BuilderEvent, or an explicit unavailable marker" },
      continuity: { value: continuity, purpose: "Cumulative continuity checkpoints, later host facts, handoff lineage, and recovery history" },
      settings: { value: { runtime: originalQa.agent, session: qaHandle.sessionIdentity(), runtimeSettings: qaHandle.runtimeContext, effectiveRoleInstructions: qaHandle.effectiveRoleInstructions, roleInstructionDigest: sha(qaHandle.effectiveRoleInstructions), loadedSkills: qaHandle.skills, handoffReceipt: qaHandle.handoffReceipt }, purpose: "Effective QA role instructions, actual loaded skills, runtime settings, and handoff receipt captured at session creation" },
      "context-usage": { value: await originalQa.contextUsage?.().catch(() => undefined) ?? { unavailable: true }, purpose: "Provider context usage sample or explicit unavailable marker" },
    },
  };
  const packetDb = new WorkflowDb(opts.recovery.projectDir);
  let existingPacket: QaRecoveryPacket | undefined;
  try {
    const pending = packetDb.qaRecoveryHead(runId, opts.ticket.id);
    if (pending && pending.pendingAction !== "resolved") existingPacket = loadQaRecoveryPacket(pending.packetPath);
  } finally { packetDb.close(); }
  let packet = existingPacket ? appendQaRecoveryAttempt(existingPacket, packetInput) : createQaRecoveryPacket(packetInput);
  let qa = originalQa; let activeQaHandle = qaHandle; let errors = originalErrors; let turns = 0;
  let recoveryContextSeal: ReturnType<typeof materializeQaRecoveryContext> | undefined;
  let protocolViolation: string | undefined;
  const attemptCorrections = async (count: number, stage: string, guidance?: string) => {
    for (let index = 0; index < count; index++) {
      turns++; packet = updateQaRecoveryPosition(packet, stage, turns, "qa-correction");
      const prompt = correctionInstruction(errors, guidance);
      packet = appendQaRecoveryResource(packet, `prompts/${String(turns).padStart(2, "0")}.txt`, prompt, { purpose: `Exact QA report-correction prompt ${turns} (${stage})`, exact: true });
      try { recoveryContextSeal?.verify(); } catch (error) { protocolViolation = error instanceof Error ? error.message : String(error); return undefined; }
      const result = await sendDurableQaTurn(qa, prompt, qaEvents, `${stage}:correction-${index + 1}`);
      try { recoveryContextSeal?.verify(); } catch (error) { protocolViolation = error instanceof Error ? error.message : String(error); return undefined; }
      const contract = parseQaResponseContract(result.text);
      packet = await appendTurnObservation(packet, `correction-${String(turns).padStart(2, "0")}`, result, prompt, contract.errors, stage, qaEvents);
      packet = appendQaRecoveryResource(packet, `qa-responses/${String(turns).padStart(2, "0")}.txt`, result.text, { purpose: `Exact QA correction response ${turns} (${stage})`, exact: true });
      packet = appendQaRecoveryResource(packet, `validation/${String(turns).padStart(2, "0")}.json`, {
        status: contract.status, fields: contract.fields, errors: contract.errors,
        turn: { isError: result.isError, numTurns: result.numTurns, costUsd: result.costUsd, inputTokens: result.inputTokens ?? "unavailable", outputTokens: result.outputTokens ?? "unavailable" }, stage,
      }, { purpose: `Parsed status, validator result, turn metadata, and recovery stage for correction ${turns}` });
      packet = appendQaRecoveryResource(packet, "context/tool-events.json", qaEvents.length ? qaEvents : { unavailable: true }, { purpose: "Latest complete set of QA BuilderEvent records available to the host" });
      try { recoveryContextSeal?.verify(); } catch (error) { protocolViolation = error instanceof Error ? error.message : String(error); return undefined; }
      if (!result.isError && !result.failure && contract.valid && contract.report) return { result, contract };
      errors = result.isError ? [`QA correction turn errored: ${sanitizePreview(result.text)}`] : contract.errors;
    }
    return undefined;
  };
  let fixed = await attemptCorrections(1, "same-session");
  if (fixed && !protocolViolation) return { outcome: "recovered", qa, turn: fixed.result, contract: fixed.contract };
  if (protocolViolation) packet = appendQaRecoveryResource(packet, `recovery-history/context-mutation-${packet.manifest.revision + 1}.txt`, protocolViolation, { purpose: "Recovery-context mutation protocol violation", exact: true });

  void packet;
  return { outcome: "failed", result: pauseQaReview(opts, "report-correction-exhausted", protocolViolation ?? "QA report correction exhausted after one same-session turn; a complete fresh QA review is required", snapshot.frozenState) };
}
async function exhausted(
  packet: QaRecoveryPacket, originalResponse: string, opts: IsolatedQaOptions,
  prefix = "QA report correction exhausted after nine turns", qa?: BuilderAdapter,
  snapshot?: Awaited<ReturnType<typeof createDisposableQaSnapshotAsync>>,
  liveSession = Boolean(qa),
  unavailableOperatorReason?: string,
  requireFreshReviewReason?: string,
): Promise<{ outcome: "failed"; result: IsolatedQaResult } | { outcome: "retry" } | { outcome: "manual"; qa: BuilderAdapter; snapshot?: Awaited<ReturnType<typeof createDisposableQaSnapshotAsync>>; report: QaFailureReportV1 } | { outcome: "operator"; decision: Extract<QaReportRecoveryDecision, { action: "fresh" | "guidance" }>; packet: QaRecoveryPacket }> {
  const synopsis = parseQaResponseContract(originalResponse).fields.issues?.trim();
  let currentPrefix = prefix;
  if (packet.manifest.pendingAction !== "operator-menu") {
    packet = updateQaRecoveryPosition(packet, "operator-menu", packet.manifest.correctionTurns, "operator-menu");
  }
  while (opts.onReportRecovery) {
    const contextUsage = qa ? await qa.contextUsage?.().catch(() => undefined) : undefined;
    const decision = await opts.onReportRecovery({ packet, menu: QA_REPORT_RECOVERY_MENU, originalIssues: synopsis || undefined, liveSession, contextUsage: contextUsage ?? { unavailable: true } });
    if (decision.action === "manual" && requireFreshReviewReason) {
      currentPrefix = `A complete fresh QA review is required because ${requireFreshReviewReason}`;
      continue;
    }
    if (decision.action === "plain") {
      currentPrefix = synopsis
        ? "Plain issues are preserved only as a human synopsis; they are not an authoritative Builder remediation request"
        : "No valid structured QA report is available; a complete fresh QA review is required";
      continue;
    }
    if (decision.action === "manual") {
      const validated = validateManualQaReport(packet); packet = validated.packet;
      currentPrefix = validated.report
        ? "Manual report.json is valid for human inspection, but manual JSON injection is not an authoritative QA-to-Builder handoff; run a complete fresh QA review"
        : `Manual report.json is invalid: ${validated.errors.join("; ")}`;
      continue;
    }
    if (decision.action === "fresh" || decision.action === "guidance") {
      if (unavailableOperatorReason) { currentPrefix = `Requested QA recovery route is unavailable because ${unavailableOperatorReason}`; continue; }
      return { outcome: "operator", decision, packet };
    }
    break;
  }
  if (packet.manifest.pendingAction !== "operator-menu") packet = updateQaRecoveryPosition(packet, "operator-menu", packet.manifest.correctionTurns, "operator-menu");
  let resumeRevision = packet.manifest.revision;
  if (opts.recovery) {
    const db = new WorkflowDb(opts.recovery.projectDir);
    try {
      let qaHead = db.qaTicketHead(opts.recovery.runId, opts.ticket.id);
      if (qaHead.state !== "operator-menu") qaHead = db.transitionQa(opts.recovery.runId, opts.ticket.id, qaHead.revision, { type: "operator-menu" });
      resumeRevision = qaHead.revision;
      const current = db.getRun(opts.recovery.runId) ?? db.ensureRun(opts.recovery.runId);
      db.transition(opts.recovery.runId, {
        status: "paused", checkpoint: "qa-report-recovery", remainingWork: current.remainingWork,
        state: current.state,
        event: "qa_report_recovery_paused", payload: { packetPath: packet.directory, packetDigest: packet.manifest.packetDigest, reviewedStateDigest: packet.manifest.reviewedStateDigest, revision: packet.manifest.revision, ladderPosition: packet.manifest.correctionTurns, pendingAction: "operator-menu", ticketId: packet.manifest.ticketId },
      });
    } finally { db.close(); }
  }
  return { outcome: "failed", result: { outcome: "needs-human", detail: `${currentPrefix}. Recovery packet: ${packet.directory} (${packet.manifest.packetDigest}). Resources:\n${boundedRecoveryInventory(packet)}\n${QA_REPORT_RECOVERY_MENU.map((item, index) => `${index + 1}. ${item}`).join("\n")}\nResume with: rafi build:resume ${opts.recovery?.projectDir ?? opts.builderWorktree} --run ${opts.recovery?.runId ?? packet.manifest.runId} --ticket ${packet.manifest.ticketId} --qa-revision ${resumeRevision} --fresh-with-handoff` } };
}

function normalizeUnsupportedOperator<T extends { outcome: string }>(result: T, reason: string): Exclude<T, { outcome: "operator" }> | { outcome: "failed"; result: IsolatedQaResult } {
  return result.outcome === "operator"
    ? { outcome: "failed", result: { outcome: "needs-human", detail: `Requested QA recovery route is unavailable because ${reason}` } }
    : result as Exclude<T, { outcome: "operator" }>;
}

function extractReportBody(text: string): string {
  const start = text.split(/\r?\n/).findIndex((line) => line.trim() === QA_FAILURE_REPORT_START);
  const lines = text.split(/\r?\n/); const end = lines.findIndex((line, index) => index > start && line.trim() === QA_FAILURE_REPORT_END);
  return start >= 0 && end > start ? lines.slice(start + 1, end).join("\n") : "{}\n";
}
function boundedBuilderSummary(text: string): string { return Buffer.from(text).subarray(0, 16 * 1024).toString(); }
function latestBuilderResponse(opts: IsolatedQaOptions): string {
  return opts.state.builderResponseHistory?.filter((entry) => entry.ticketId === opts.ticket.id).at(-1)?.response ?? opts.builderSummary;
}
function sanitizePreview(text: string, maximum = 500): string {
  return text.replace(/\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").slice(0, maximum);
}
function boundedRecoveryInventory(packet: QaRecoveryPacket): string { return sanitizePreview(qaRecoveryInventory(packet), 16 * 1024); }
import { createHash as createHashCompatNode } from "node:crypto";
function sha(text: string): string { return createHashCompatNode("sha256").update(text).digest("hex"); }
function persistQaEvidence(opts: IsolatedQaOptions, text: string): string {
  if (!opts.recovery) return sha(text);
  const db = new WorkflowDb(opts.recovery.projectDir);
  try { return db.putEvidence("qa", Buffer.from(text)); } finally { db.close(); }
}
function markQaRecoveryResolved(opts: IsolatedQaOptions): void {
  if (!opts.recovery) return;
  const db = new WorkflowDb(opts.recovery.projectDir);
  try {
    const run = db.getRun(opts.recovery.runId);
    const pending = db.qaRecoveryHead(opts.recovery.runId, opts.ticket.id);
    if (!run || !pending || pending.pendingAction === "resolved") return;
    const packet = updateQaRecoveryPosition(loadQaRecoveryPacket(pending.packetPath), "resolved", pending.correctionTurns, "resolved");
    db.transition(opts.recovery.runId, {
      status: "running",
      checkpoint: "qa-report-recovery-resolved",
      remainingWork: run.remainingWork,
      state: run.state,
      event: "qa_report_recovery_resolved", payload: { ticketId: opts.ticket.id, packetDigest: packet.manifest.packetDigest, revision: packet.manifest.revision },
    });
  } finally { db.close(); }
}

function markQaRecoveryPendingBuilder(opts: IsolatedQaOptions): void {
  markQaRecoveryAction(opts, "builder-remediation-pending");
}

function markQaRecoveryAction(opts: IsolatedQaOptions, action: QaRecoveryPendingAction): void {
  if (!opts.recovery) return;
  const db = new WorkflowDb(opts.recovery.projectDir);
  try {
    const pending = db.qaRecoveryHead(opts.recovery.runId, opts.ticket.id);
    if (!pending || pending.pendingAction === "resolved") return;
    updateQaRecoveryPosition(loadQaRecoveryPacket(pending.packetPath), action, pending.correctionTurns, action);
  } finally { db.close(); }
}
interface QaEventRecorderState {
  waits: Map<string, Array<() => void>>;
  activePumps: number;
}
const qaEventRecorders = new WeakMap<BuilderEvent[], QaEventRecorderState>();

function startQaEventRecorder(adapter: BuilderAdapter): BuilderEvent[] {
  const events: BuilderEvent[] = [];
  qaEventRecorders.set(events, { waits: new Map(), activePumps: 0 });
  attachQaEventRecorder(events, adapter);
  return events;
}

function attachQaEventRecorder(events: BuilderEvent[], adapter: BuilderAdapter): void {
  const state = qaEventRecorders.get(events);
  if (!state) throw new Error("QA event recorder is unavailable");
  state.activePumps++;
  void (async () => {
    try {
      for await (const event of adapter.events()) {
        events.push(event);
        if (event.kind === "turn-complete") {
          const id = event.turnId ?? event.result.turnId;
          if (id) { for (const resolve of state.waits.get(id) ?? []) resolve(); state.waits.delete(id); }
        }
      }
    } catch (error) {
      events.push({ kind: "error", message: `QA event stream unavailable: ${error instanceof Error ? error.message : String(error)}` });
    } finally { state.activePumps--; }
  })();
}

async function awaitQaTurnEvent(events: BuilderEvent[], turn: TurnResult): Promise<void> {
  const id = turn.turnId;
  const state = qaEventRecorders.get(events);
  if (!state || !id) {
    events.push({ kind: "error", message: `turn-complete correlation unavailable for turn ${id ?? "without a stable ID"}` });
    return;
  }
  if (events.some((event) => event.kind === "turn-complete" && (event.turnId ?? event.result.turnId) === id)) return;
  if (state.activePumps === 0) {
    events.push({ kind: "error", message: `turn-complete event unavailable for turn ${id}` });
    return;
  }
  let timeout: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve) => {
    const done = () => { if (timeout) clearTimeout(timeout); resolve(); };
    state.waits.set(id, [...(state.waits.get(id) ?? []), done]);
    timeout = setTimeout(() => {
      state.waits.set(id, (state.waits.get(id) ?? []).filter((item) => item !== done));
      events.push({ kind: "error", message: `turn-complete event incomplete for turn ${id}` });
      resolve();
    }, 250);
  });
}

async function appendTurnObservation(packet: QaRecoveryPacket, label: string, turn: TurnResult, requestedPrompt: string | undefined, errors: string[], stage: string, events: BuilderEvent[]): Promise<QaRecoveryPacket> {
  await awaitQaTurnEvent(events, turn);
  const hostPrompt = turn.hostInstruction ?? requestedPrompt;
  let next = appendQaRecoveryResource(packet, `turns/${label}/host-prompt.${hostPrompt === undefined ? "json" : "txt"}`, hostPrompt ?? { unavailable: "adapter did not expose the host-requested instruction" }, { purpose: `Host-requested QA instruction for ${label}`, exact: hostPrompt !== undefined });
  const providerPrompt = turn.providerInstruction;
  next = appendQaRecoveryResource(next, `turns/${label}/provider-prompt.${providerPrompt === undefined ? "json" : "txt"}`, providerPrompt ?? { unavailable: "adapter did not expose the provider-dispatched instruction" }, { purpose: `Provider-dispatched QA instruction for ${label}`, exact: providerPrompt !== undefined });
  next = appendQaRecoveryResource(next, `turns/${label}/raw-response.txt`, turn.rawResponse ?? turn.text, { purpose: `Raw provider QA response for ${label}`, exact: true });
  next = appendQaRecoveryResource(next, `turns/${label}/cleaned-response.txt`, effectiveTurnText(turn), { purpose: `Cleaned QA response used for contract validation for ${label}`, exact: true });
  next = appendQaRecoveryResource(next, `turns/${label}/metadata.json`, { stage, validationErrors: errors, turn: turnMetadata(turn), eventCompletion: turn.turnId ? events.some((event) => event.kind === "turn-complete" && (event.turnId ?? event.result.turnId) === turn.turnId) ? "complete" : "incomplete" : "unavailable" }, { purpose: `Turn metadata, validation result, and event completeness for ${label}` });
  return appendQaRecoveryResource(next, `turns/${label}/events.json`, events.length ? events : { unavailable: true }, { purpose: `Complete host-observed event set through ${label}` });
}

async function performRecoveryAcknowledgement(
  packet: QaRecoveryPacket,
  qa: BuilderAdapter,
  prompt: string,
  events: BuilderEvent[],
  continuityAlreadyValidated: boolean,
  label: string,
  seal?: { verify(): void },
): Promise<{ packet: QaRecoveryPacket; errors: string[] }> {
  // Both turns acknowledge the same already-materialized revision. Observing
  // either response advances the owner-only packet afterward, so validation
  // must continue to use this immutable target rather than the new revision.
  const target = packet;
  try { seal?.verify(); } catch (error) { return { packet, errors: [`recovery context mutated before acknowledgement: ${error instanceof Error ? error.message : String(error)}`] }; }
  const first = await sendDurableQaTurn(qa, prompt, events, `${label}:acknowledgement`);
  let errors = validateQaRecoveryAcknowledgement(effectiveTurnText(first), target, { continuityAlreadyValidated });
  try { seal?.verify(); } catch (error) { errors.push(`recovery context mutated during acknowledgement: ${error instanceof Error ? error.message : String(error)}`); }
  packet = await appendTurnObservation(packet, `${label}-acknowledgement`, first, prompt, errors, "packet-acknowledgement", events);
  if (first.isError || first.failure) return { packet, errors: [...errors, "QA acknowledgement provider turn failed"] };
  try { seal?.verify(); } catch (error) { errors.push(`recovery context mutated after acknowledgement: ${error instanceof Error ? error.message : String(error)}`); }
  if (errors.length) {
    const correction = `${prompt}\n\nAcknowledgement correction only. Do not produce the report yet. Errors: ${errors.join("; ")}`;
    try { seal?.verify(); } catch (error) { return { packet, errors: [`recovery context mutated before acknowledgement repair: ${error instanceof Error ? error.message : String(error)}`] }; }
    const repaired = await sendDurableQaTurn(qa, correction, events, `${label}:acknowledgement-repair`);
    errors = validateQaRecoveryAcknowledgement(effectiveTurnText(repaired), target, { continuityAlreadyValidated });
    try { seal?.verify(); } catch (error) { errors.push(`recovery context mutated during acknowledgement repair: ${error instanceof Error ? error.message : String(error)}`); }
    packet = await appendTurnObservation(packet, `${label}-acknowledgement-repair`, repaired, correction, errors, "packet-acknowledgement-repair", events);
    if (repaired.isError || repaired.failure) errors.push("QA acknowledgement repair provider turn failed");
    try { seal?.verify(); } catch (error) { errors.push(`recovery context mutated after acknowledgement repair: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { packet, errors };
}

function validateBoundaryReceipt(receipt: HandoffAcceptanceReceiptV2, packet: QaRecoveryPacket, successorHandle: QaSessionHandle): void {
  const observedSuccessor = successorHandle.sessionIdentity();
  const { operationId, ...receiptBody } = receipt;
  if (receipt.version !== 2 || receipt.runId !== packet.manifest.runId || receipt.ticketId !== packet.manifest.ticketId
    || receipt.sourceStateDigest !== packet.manifest.reviewedStateDigest || receipt.packetDigest !== packet.manifest.packetDigest
    || receipt.requiresFullReview !== true || receipt.confinementDigest !== successorHandle.confinement.digest
    || receipt.predecessor.role !== "qa" || receipt.successor.role !== "qa" || receipt.successor.stream !== "qa"
    || receipt.predecessor.stream !== "qa" || !receipt.predecessor.sessionId || !receipt.successor.sessionId
    || /^(?:unavailable|unknown)$/i.test(receipt.predecessor.sessionId.trim())
    || /^(?:unavailable|unknown)$/i.test(receipt.successor.sessionId.trim()) || receipt.predecessor.sessionId === receipt.successor.sessionId
    || receipt.predecessor.version !== 2 || receipt.successor.version !== 2
    || !Number.isSafeInteger(receipt.predecessor.generation) || receipt.predecessor.generation < 0
    || !Number.isSafeInteger(receipt.successor.generation) || receipt.successor.generation < 0
    || !receipt.predecessor.cwd || !receipt.predecessor.configRoot || !receipt.successor.cwd || !receipt.successor.configRoot
    || receipt.successor.provider !== observedSuccessor.provider || receipt.successor.sessionId !== observedSuccessor.sessionId
    || receipt.successor.generation !== observedSuccessor.generation || receipt.successor.cwd !== observedSuccessor.cwd
    || receipt.successor.configRoot !== observedSuccessor.configRoot
    || operationId !== qaDigest("qa-handoff-operation", receiptBody)
    || !/^[a-f0-9]{64}$/.test(receipt.predecessorSourceStateDigest) || !/^[a-f0-9]{64}$/.test(receipt.reviewBasisDigest)
    || !Number.isSafeInteger(receipt.qaRevision) || receipt.qaRevision < 1 || Number.isNaN(Date.parse(receipt.acceptedAt))
    || !/^[a-f0-9]{64}$/.test(receipt.manifestDigest)
    || !/^[a-f0-9]{64}$/.test(receipt.continuityCheckpointDigest) || !/^[a-f0-9]{64}$/.test(receipt.acceptanceCheckpointDigest)) {
    throw new Error("QA recovery boundary returned an incomplete or mismatched acceptance receipt");
  }
  if (new Set(receipt.resources.map((resource) => resource.label)).size !== receipt.resources.length) throw new Error("QA recovery acceptance receipt contains duplicate resource labels");
  if (receipt.resources.some((resource) => !resource.label || !resource.path || !resource.purpose || !resource.mediaType
    || !/^[a-f0-9]{64}$/.test(resource.digest) || !Number.isSafeInteger(resource.bytes) || resource.bytes < 0
    || resource.authoritative !== true || typeof resource.requiredForRecovery !== "boolean")) {
    throw new Error("QA recovery acceptance receipt contains invalid resource metadata");
  }
  for (const required of ["continuity-checkpoint", "authoritative-run-state", "frozen-qa-action"]) {
    if (!receipt.resources.some((resource) => resource.label === required)) throw new Error(`QA recovery acceptance receipt is missing ${required}`);
  }
  if (receipt.inventoryDigest !== qaDigest("handoff-inventory", receipt.resources)) throw new Error("QA recovery acceptance receipt inventory digest mismatch");
  const receiptDb = new WorkflowDb(packet.projectDir);
  try {
    const durable = receiptDb.qaHandoffReceipt(receipt.operationId);
    if (!durable || canonicalJson(durable) !== canonicalJson(receipt)) throw new Error("QA recovery acceptance receipt is not durably recorded");
  } finally { receiptDb.close(); }
  const byLabel = new Map(receipt.resources.map((resource) => [resource.label, resource]));
  for (const expected of packet.manifest.resources) {
    const actual = byLabel.get(expected.path);
    if (!actual || actual.authoritative !== true || actual.digest !== expected.digest || actual.path !== expected.path || actual.purpose !== expected.purpose
      || actual.bytes !== expected.bytes || actual.mediaType !== expected.mediaType || actual.requiredForRecovery !== expected.requiredForRecovery) {
      throw new Error(`QA recovery acceptance receipt did not validate resource ${expected.path}`);
    }
  }
}

function effectiveTurnText(turn: TurnResult): string { return turn.cleanedResponse ?? turn.text; }

interface QaTurnBinding {
  projectDir: string;
  runId: string;
  ticketId: string;
  reviewNumber: number;
  reviewAttemptId: string;
  sourceStateDigest: string;
  reviewBasisDigest: string;
  sessionGeneration: number;
  sessionRef: ProviderSessionRefV1;
  reviewedSnapshotPath: string;
  frozenSource: FrozenQaSourceState;
  recoveryPacket?: QaRecoveryPacket;
  recoveryContext?: ReturnType<typeof materializeQaRecoveryContext>;
  nextTurn: number;
  lastReceiptDigest?: string;
}

const qaTurnBindings = new WeakMap<BuilderAdapter, QaTurnBinding>();

function beginV2Review(
  opts: IsolatedQaOptions,
  source: FrozenQaSourceState,
  reviewedSnapshotPath: string,
  instruction: string,
  handle: QaSessionHandle,
  attempt: { attemptId: string; cycle: number; remediationGeneration: number },
): QaTurnBinding {
  const db = new WorkflowDb(opts.recovery.projectDir);
  try {
    const sourceV2: FrozenQaSourceStateV2 = {
      version: 2, runId: opts.recovery.runId, ticketId: opts.ticket.id,
      originDigest: source.originDigest, contentDigest: source.contentDigest, digest: source.digest,
      capturedAt: source.capturedAt, paths: source.pathInventory,
    };
    const checklist = loadTicketSetupConfigWithDefaults(opts.builderWorktree).build.validation_checklist;
    const basisWithoutDigest = {
      version: 2 as const,
      ticketDigest: qaDigest("ticket", opts.ticket),
      instructionDigest: qaDigest("instruction", instruction),
      roleInstructionsDigest: qaDigest("role-instructions", handle.effectiveRoleInstructions),
      skillsDigest: qaDigest("skills", handle.skills.map((skill) => ({ name: skill.name, digest: skill.digest, path: skill.path }))),
      runtimeDigest: qaDigest("runtime", handle.runtimeContext),
      validationChecklistDigest: qaDigest("validation-checklist", checklist),
      confinementDigest: handle.confinement.digest,
    };
    const basis: QaReviewBasisV2 = { ...basisWithoutDigest, digest: qaDigest("review-basis-fields", basisWithoutDigest) };
    let head = db.qaTicketHead(opts.recovery.runId, opts.ticket.id);
    if (head.state === "waived" || head.state === "completed") throw new Error(`QA protocol for ${opts.ticket.id} is already terminal`);
    const identity = validateQaSessionHandle(handle, reviewedSnapshotPath);
    const pending = db.qaRecoveryHead(opts.recovery.runId, opts.ticket.id);
    let recoveryPacket = pending && pending.pendingAction !== "resolved" ? loadQaRecoveryPacket(pending.packetPath) : undefined;
    if (recoveryPacket && recoveryPacket.manifest.pendingAction !== "qa-full-review") {
      recoveryPacket = updateQaRecoveryPosition(recoveryPacket, "qa-full-review", recoveryPacket.manifest.correctionTurns, "qa-full-review");
    }
    if (recoveryPacket && recoveryPacket.manifest.reviewedStateDigest !== source.digest) {
      const comparison = compareQaRecoveryReviewedState(recoveryPacket, source);
      recoveryPacket = appendQaRecoveryResource(recoveryPacket, `recovery-history/review-source-${attempt.attemptId}.json`, {
        originalDigest: comparison.originalDigest, currentDigest: comparison.currentDigest, drift: comparison.drift,
        disposition: "prior reports are historical; a complete immutable-source review is required",
      }, { purpose: "Source binding before the next durable QA review" });
      recoveryPacket = appendQaRecoveryReviewedState(recoveryPacket, source, `reviewed-state/current-r${recoveryPacket.manifest.revision + 1}`);
    }
    // Publish source first. A crash can leave a packet ahead of the old review,
    // or exactly one undispatched review ahead of the packet identity; both
    // states are linked by an exact transition intent before allocation.
    if (recoveryPacket) {
      recoveryPacket = appendQaRecoveryResource(recoveryPacket, `review-transitions/${attempt.attemptId}.json`, {
        runId: opts.recovery.runId, ticketId: opts.ticket.id, predecessorReviewNumber: head.reviewNumber,
        predecessorAttemptId: recoveryPacket.manifest.reviewAttemptId, reviewNumber: head.reviewNumber + 1,
        reviewAttemptId: attempt.attemptId, sourceStateDigest: source.digest, cycle: attempt.cycle,
      }, { purpose: "Exact next-review allocation intent used to reconcile a crash before packet identity publication" });
    }
    head = db.commitQaReviewReady(sourceV2, basis, identity, handle.confinement, attempt, head.revision);
    if (recoveryPacket) recoveryPacket = updateQaRecoveryReviewIdentity(recoveryPacket, head.reviewNumber, attempt.attemptId, attempt.cycle);
    return { projectDir: opts.recovery.projectDir, runId: opts.recovery.runId, ticketId: opts.ticket.id, reviewNumber: head.reviewNumber, reviewAttemptId: attempt.attemptId, sourceStateDigest: source.digest, reviewBasisDigest: basis.digest, sessionGeneration: identity.generation, sessionRef: identity, reviewedSnapshotPath: identity.cwd, frozenSource: source, recoveryPacket, nextTurn: 0 };
  } finally { db.close(); }
}

function validateQaSessionHandle(handle: QaSessionHandle, reviewedSnapshotPath: string): ProviderSessionRefV1 {
  const identity = handle.sessionIdentity();
  const adapterIdentity = handle.adapter.sessionRef?.();
  const confinement = handle.confinement;
  const { digest, ...confinementFields } = confinement;
  if (identity.version !== 1 || identity.role !== "qa" || identity.stream !== "qa" || identity.provider !== handle.adapter.agent
    || !identity.sessionId || /^(?:unavailable|unknown)$/i.test(identity.sessionId.trim())
    || !Number.isSafeInteger(identity.generation) || identity.generation < 0
    || canonicalSessionPath(identity.cwd) !== canonicalSessionPath(reviewedSnapshotPath) || !identity.configRoot
    || Number.isNaN(Date.parse(identity.createdAt)) || !identity.validatedAt || Number.isNaN(Date.parse(identity.validatedAt))
    || handle.adapter.sessionId() !== identity.sessionId || !adapterIdentity
    || stableProviderSessionIdentity(adapterIdentity) !== stableProviderSessionIdentity(identity)) {
    throw new Error("QA session handle has an invalid or mismatched scoped identity");
  }
  if (!handle.effectiveRoleInstructions.trim() || confinement.version !== 2 || confinement.sourceMode !== "read-only"
    || confinement.scratchMode !== "isolated" || !["none", "user"].includes(confinement.settingsSources)
    || !["disabled", "provider-required"].includes(confinement.networkMode)
    || !/^[a-f0-9]{64}$/.test(confinement.environmentDigest) || !/^[a-f0-9]{64}$/.test(confinement.policyDigest)
    || digest !== qaDigest("qa-confinement", confinementFields)) {
    throw new Error("QA session handle has an invalid confinement receipt");
  }
  for (const skill of handle.skills) {
    if (!skill.name || !skill.path || !skill.content || !/^[a-f0-9]{64}$/.test(skill.digest)
      || sha(skill.content) !== skill.digest) {
      throw new Error("QA session handle has an invalid loaded-skill receipt");
    }
  }
  return identity;
}

function bindQaTurnAdapter(adapter: BuilderAdapter, binding: QaTurnBinding): void {
  const previous = qaTurnBindings.get(adapter);
  if (previous?.reviewedSnapshotPath === binding.reviewedSnapshotPath) binding.recoveryContext = previous.recoveryContext;
  qaTurnBindings.set(adapter, binding);
}

function bindQaRecoveryContext(adapter: BuilderAdapter, context: ReturnType<typeof materializeQaRecoveryContext>): void {
  const binding = qaTurnBindings.get(adapter);
  if (!binding) throw new Error("QA recovery context requires a durable review binding");
  binding.recoveryContext = context;
}

async function sendDurableQaTurn(adapter: BuilderAdapter, instruction: string, events: BuilderEvent[], slot?: string): Promise<TurnResult> {
  const binding = qaTurnBindings.get(adapter);
  if (!binding) throw new Error("QA provider dispatch requires a durable source/review-basis binding");
  if (slot !== "session-initialization") {
    try { await adapter.prepareAutoCompaction?.(); }
    catch (error) {
      return { text: `QA session could not install provider-native automatic compaction before review: ${error instanceof Error ? error.message : String(error)}`,
        isError: true, numTurns: 0, costUsd: 0, hostInstruction: instruction };
    }
  }
  if (slot !== "session-initialization" && adapter.requiresAutoCompactionSetupTurn?.()) {
    const eventOffset = events.length;
    const initialized = await sendDurableQaTurn(adapter, [
      "Rafi QA session initialization only.",
      "Do not inspect source, call tools, make findings, or modify files.",
      "Reply briefly that the context is ready, followed by the required continuity record.",
    ].join("\n"), events, "session-initialization");
    const setupCalledTools = events.slice(eventOffset).some((event) => event.kind === "tool");
    if (initialized.isError || setupCalledTools || adapter.requiresAutoCompactionSetupTurn?.()) {
      return { ...initialized, isError: true,
        text: `QA session could not establish provider-native automatic compaction before review${setupCalledTools ? " without tool use" : ""}: ${initialized.text.slice(0, 240)}` };
    }
  }
  const session = binding.sessionRef;
  if (!session || session.role !== "qa" || session.stream !== "qa") throw new Error("QA provider dispatch requires a validated scoped QA session identity");
  const turnIndex = binding.nextTurn++;
  const retrySlot = slot ?? `turn-${turnIndex}`;
  const operationId = qaDigest("turn-operation", { runId: binding.runId, ticketId: binding.ticketId, reviewNumber: binding.reviewNumber, sessionGeneration: binding.sessionGeneration, retrySlot });
  const intendedAt = new Date().toISOString();
  const providerSession = { version: 2 as const, provider: session.provider, sessionId: session.sessionId, role: "qa" as const, stream: "qa" as const, generation: session.generation, cwd: session.cwd, configRoot: session.configRoot, createdAt: session.createdAt, validatedAt: session.validatedAt ?? intendedAt };
  const db = new WorkflowDb(binding.projectDir);
  try {
    const instructionDigest = db.putEvidence("qa", Buffer.from(instruction));
    const intent: QaTurnIntentV2 = { version: 2, operationId, runId: binding.runId, ticketId: binding.ticketId, reviewNumber: binding.reviewNumber, sessionGeneration: binding.sessionGeneration, slot: retrySlot, sourceStateDigest: binding.sourceStateDigest, reviewBasisDigest: binding.reviewBasisDigest, providerSession, instructionDigest, intendedAt };
    const head = db.qaTicketHead(binding.runId, binding.ticketId);
    db.commitQaTurnIntent(intent, head.revision);
  } finally { db.close(); }
  let result: TurnResult;
  try { result = await adapter.sendTurn(instruction); }
  catch (error) {
    const failedDb = new WorkflowDb(binding.projectDir);
    try {
      const receipt: QaTurnReceiptV2 = {
        version: 2, operationId, dispatch: "uncertain", terminalEventObserved: false,
        eventStreamDigest: failedDb.putEvidence("qa", Buffer.from(canonicalJson(events))),
        sourceStateDigest: binding.sourceStateDigest, reviewBasisDigest: binding.reviewBasisDigest, completedAt: new Date().toISOString(),
      };
      failedDb.finishQaTurn(receipt);
      const head = failedDb.qaTicketHead(binding.runId, binding.ticketId);
      if (head.state === "turn-intended") failedDb.transitionQa(binding.runId, binding.ticketId, head.revision, { type: "turn-uncertain" });
    } finally { failedDb.close(); }
    ensureUncertainQaTurnPacket(binding, instruction, error instanceof Error ? error.message : String(error));
    throw error;
  }
  await awaitQaTurnEvent(events, result);
  const activeSession = adapter.sessionRef?.();
  const reportedSession = result.providerMetadata?.sessionRef;
  const identityMismatch = adapter.agent !== session.provider
    || adapter.sessionId() !== session.sessionId
    || !activeSession
    || stableProviderSessionIdentity(activeSession) !== stableProviderSessionIdentity(session)
    || (result.providerMetadata !== undefined && (result.providerMetadata.provider !== session.provider
      || result.providerMetadata.sessionId !== session.sessionId
      || !reportedSession
      || stableProviderSessionIdentity(reportedSession) !== stableProviderSessionIdentity(session)));
  if (identityMismatch) {
    const detail = `QA provider identity changed during durable turn ${operationId}; the verdict is not bound to the intended session`;
    const failedDb = new WorkflowDb(binding.projectDir);
    try {
      const receipt: QaTurnReceiptV2 = {
        version: 2, operationId, dispatch: "uncertain", terminalEventObserved: false,
        providerTurnId: result.turnId,
        rawResponseDigest: failedDb.putEvidence("qa", Buffer.from(result.rawResponse ?? result.text)),
        cleanedResponseDigest: failedDb.putEvidence("qa", Buffer.from(result.cleanedResponse ?? result.text)),
        providerInstructionDigest: failedDb.putEvidence("qa", Buffer.from(result.providerInstruction ?? result.hostInstruction ?? instruction)),
        eventStreamDigest: failedDb.putEvidence("qa", Buffer.from(canonicalJson({ events, rejectedProviderMetadata: result.providerMetadata, activeSession }))),
        sourceStateDigest: binding.sourceStateDigest, reviewBasisDigest: binding.reviewBasisDigest, completedAt: new Date().toISOString(),
      };
      failedDb.finishQaTurn(receipt);
      const head = failedDb.qaTicketHead(binding.runId, binding.ticketId);
      if (head.state === "turn-intended") failedDb.transitionQa(binding.runId, binding.ticketId, head.revision, { type: "turn-uncertain" });
    } finally { failedDb.close(); }
    ensureUncertainQaTurnPacket(binding, instruction, detail);
    throw new Error(detail);
  }
  const completedAt = new Date().toISOString();
  const terminalEventObserved = Boolean(result.turnId
    && events.some((event) => event.kind === "turn-complete" && (event.turnId ?? event.result.turnId) === result.turnId));
  const receiptDb = new WorkflowDb(binding.projectDir);
  try {
    const rawResponseDigest = receiptDb.putEvidence("qa", Buffer.from(result.rawResponse ?? result.text));
    const providerInstruction = result.providerInstruction ?? result.hostInstruction ?? instruction;
    const providerInstructionDigest = receiptDb.putEvidence("qa", Buffer.from(providerInstruction));
    const cleanedResponseDigest = receiptDb.putEvidence("qa", Buffer.from(result.cleanedResponse ?? result.text));
    const eventStreamDigest = receiptDb.putEvidence("qa", Buffer.from(canonicalJson(events)));
    const receipt: QaTurnReceiptV2 = {
      version: 2, operationId, dispatch: terminalEventObserved ? "completed" : "uncertain", providerTurnId: result.turnId,
      providerInstructionDigest, rawResponseDigest, cleanedResponseDigest, eventStreamDigest,
      terminalEventObserved, sourceStateDigest: binding.sourceStateDigest, reviewBasisDigest: binding.reviewBasisDigest, completedAt,
    };
    receiptDb.finishQaTurn(receipt);
    binding.lastReceiptDigest = qaDigest("turn-receipt", receipt);
    if (!terminalEventObserved) {
      const head = receiptDb.qaTicketHead(binding.runId, binding.ticketId);
      receiptDb.transitionQa(binding.runId, binding.ticketId, head.revision, { type: "turn-uncertain" });
      ensureUncertainQaTurnPacket(binding, instruction, `QA turn ${operationId} has no correlated terminal provider event`);
      throw new Error(`QA turn ${operationId} has no correlated terminal provider event; its outcome is uncertain`);
    }
  } finally { receiptDb.close(); }
  try { await adapter.prepareAutoCompaction?.(); }
  catch (error) {
    return { ...result, isError: true, text: `QA session could not install native automatic compaction after its first observed usage sample: ${error instanceof Error ? error.message : String(error)}` };
  }
  return result;
}

function ensureUncertainQaTurnPacket(binding: QaTurnBinding, instruction: string, detail: string): void {
  const db = new WorkflowDb(binding.projectDir);
  try { if (db.qaRecoveryHead(binding.runId, binding.ticketId)?.pendingAction !== undefined) return; }
  finally { db.close(); }
  createQaRecoveryPacket({
    projectDir: binding.projectDir, frozenState: binding.frozenSource, runId: binding.runId, ticketId: binding.ticketId,
    cycle: binding.reviewNumber, reviewAttempt: binding.reviewNumber, reviewAttemptId: binding.reviewAttemptId, recoveryStage: "turn-uncertain", pendingAction: "operator-menu",
    resources: {
      "uncertain-turn-instruction": { value: instruction, purpose: "Exact host instruction for the provider turn whose terminal outcome is uncertain", exactText: true },
      "uncertain-turn-detail": { value: detail, purpose: "Host-observed reason the provider outcome is uncertain", exactText: true },
      "review-binding": { value: { sourceStateDigest: binding.sourceStateDigest, reviewBasisDigest: binding.reviewBasisDigest, sessionGeneration: binding.sessionGeneration }, purpose: "Durable review binding for the uncertain turn" },
    },
  });
}

function stableProviderSessionIdentity(ref: ProviderSessionRefV1): string {
  return qaDigest("provider-session-identity", {
    version: ref.version, provider: ref.provider, sessionId: ref.sessionId, role: ref.role, stream: ref.stream,
    generation: ref.generation, cwd: resolve(ref.cwd), configRoot: resolve(ref.configRoot),
    workspaceIdentity: ref.workspaceIdentity, ticketId: ref.ticketId, deliveryUnitId: ref.deliveryUnitId,
  });
}

function finishV2Failure(opts: IsolatedQaOptions, adapter: BuilderAdapter, reportDigest: string, report: QaFailureReportV1, rawFindingIds: string[], findingRefs?: QaFindingRefV2[]): void {
  const binding = qaTurnBindings.get(adapter); if (!binding) throw new Error("QA failure has no durable review binding");
  const db = new WorkflowDb(binding.projectDir);
  try {
    const head = db.qaTicketHead(binding.runId, binding.ticketId);
    const refs = findingRefs ?? qaFindingRefs(binding.runId, binding.ticketId, binding.reviewAttemptId, reportDigest, rawFindingIds);
    db.commitQaFailureAttempt(binding.reviewAttemptId, { reportDigest, runId: binding.runId, ticketId: binding.ticketId, reviewNumber: binding.reviewNumber, sourceStateDigest: binding.sourceStateDigest, reviewBasisDigest: binding.reviewBasisDigest, report }, rawFindingIds, refs.map((finding) => finding.findingKey), report.summary, head.revision);
  } finally { db.close(); }
}

function finishV2Pass(opts: IsolatedQaOptions, adapter: BuilderAdapter, detail: string): { certificateId: string; sourceStateDigest: string; reviewBasisDigest: string } {
  const binding = qaTurnBindings.get(adapter); if (!binding?.lastReceiptDigest) throw new Error("QA pass has no completed durable turn receipt");
  const db = new WorkflowDb(binding.projectDir);
  try {
    const head = db.qaTicketHead(binding.runId, binding.ticketId);
    const certificate = db.commitQaPassAttempt(binding.reviewAttemptId, { runId: binding.runId, ticketId: binding.ticketId, qaRevision: head.revision + 1, sourceStateDigest: binding.sourceStateDigest, reviewBasisDigest: binding.reviewBasisDigest, turnReceiptDigest: binding.lastReceiptDigest }, detail, head.revision);
    return { certificateId: certificate.certificateId, sourceStateDigest: binding.sourceStateDigest, reviewBasisDigest: binding.reviewBasisDigest };
  } finally { db.close(); }
}

function waiveV2Reports(opts: IsolatedQaOptions, reason: string): void {
  const db = new WorkflowDb(opts.recovery.projectDir);
  try {
    const head = db.qaTicketHead(opts.recovery.runId, opts.ticket.id);
    db.commitQaWaiver(opts.recovery.runId, opts.ticket.id, head.revision, reason);
  } finally { db.close(); }
}

export async function beginQaFinalization(projectDir: string, sourceWorktree: string, runId: string, ticketId: string, certificateId: string, expectedSourceStateDigest: string, consumer: string, allowedProjectionPaths: string[] = []): Promise<void> {
  const invalidatePass = (reason: string): never => {
    const db = new WorkflowDb(projectDir);
    try {
      const head = db.qaTicketHead(runId, ticketId);
      const paused = db.invalidateQaPassBeforeFinalization({ runId, ticketId, certificateId, expectedSourceStateDigest, expectedRevision: head.revision, reason });
      throw new Error(`${reason}; a complete QA recheck is required. Resume with: rafi build:resume ${projectDir} --run ${runId} --ticket ${ticketId} --qa-revision ${paused.revision} --fresh-with-handoff`);
    } finally { db.close(); }
  };
  let live: FrozenQaSourceState;
  try { live = await captureFrozenQaSourceAsync(sourceWorktree); }
  catch (error) { return invalidatePass(`Builder source could not be stably captured after QA pass: ${error instanceof Error ? error.message : String(error)}`); }
  if (live.digest !== expectedSourceStateDigest) invalidatePass(`Builder source changed after QA pass (${expectedSourceStateDigest} -> ${live.digest})`);
  const expectedGitTree = captureProspectiveGitTree(sourceWorktree);
  let afterTree: FrozenQaSourceState;
  try { afterTree = await captureFrozenQaSourceAsync(sourceWorktree); }
  catch (error) { return invalidatePass(`Builder source could not be stably recaptured while binding the QA finalization tree: ${error instanceof Error ? error.message : String(error)}`); }
  if (afterTree.digest !== live.digest) invalidatePass("Builder source changed while binding the QA finalization tree");
  const db = new WorkflowDb(projectDir);
  try {
    const head = db.qaTicketHead(runId, ticketId);
    const operationId = qaDigest("finalization-operation", { runId, ticketId, certificateId, consumer });
    db.beginQaFinalization({ runId, ticketId, certificateId, consumer, expectedSourceStateDigest, expectedGitTree, allowedProjectionPaths, expectedRevision: head.revision, operationId });
  } finally { db.close(); }
}

export async function verifyPendingQaFinalizationSource(projectDir: string, sourceWorktree: string, runId: string, ticketId: string, allowProjection = false, projectionOperationId?: string): Promise<void> {
  const db = new WorkflowDb(projectDir);
  let step: ReturnType<WorkflowDb["qaFinalizationSteps"]>[number] | undefined;
  let projectionAuthorized = !projectionOperationId;
  try {
    const head = db.qaTicketHead(runId, ticketId);
    if (head.state !== "finalizing") throw new Error(`QA finalization is not active for ${ticketId}`);
    step = db.qaFinalizationSteps(runId, ticketId).find((item) => item.status === "intended");
    if (projectionOperationId) {
      const operation = db.operation(projectionOperationId);
      projectionAuthorized = Boolean(operation && operation.runId === runId && operation.kind === "commit" && ["in_progress", "confirmed"].includes(operation.status));
    }
  } finally { db.close(); }
  if (!step) throw new Error(`QA finalization intent is missing for ${runId}/${ticketId}`);
  const live = await captureFrozenQaSourceAsync(sourceWorktree);
  if (live.digest === step.intent.expectedSourceStateDigest) return;
  if (allowProjection && projectionAuthorized && prospectiveGitTreeMatches(sourceWorktree, step.intent.expectedGitTree, step.intent.allowedProjectionPaths ?? [])) return;
  const reason = `Source changed after QA pass and does not match an authorized finalization projection (${step.intent.expectedSourceStateDigest} -> ${live.digest})`;
  if (allowProjection && !projectionOperationId) throw new Error(`${reason}; tracker completion is already confirmed and its publication must be reconciled`);
  const invalidationDb = new WorkflowDb(projectDir);
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: sourceWorktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const head = invalidationDb.qaTicketHead(runId, ticketId);
    const paused = invalidationDb.invalidateQaFinalization(runId, ticketId, head.revision, reason, branch);
    throw new Error(`${reason}; a complete QA recheck is required. Resume with: rafi build:resume ${projectDir} --run ${runId} --ticket ${ticketId} --qa-revision ${paused.revision} --fresh-with-handoff`);
  } finally { invalidationDb.close(); }
}

export function completeQaFinalization(projectDir: string, runId: string, ticketId: string): void {
  const db = new WorkflowDb(projectDir);
  try {
    const head = db.qaTicketHead(runId, ticketId);
    if (head.state !== "finalizing") throw new Error(`QA finalization is not active for ${ticketId}`);
    db.completeQaFinalization(runId, ticketId, head.revision, { completedAt: new Date().toISOString(), reducerRevision: head.revision + 1 });
  } finally { db.close(); }
}

function turnMetadata(turn: TurnResult): unknown {
  return {
    turnId: turn.turnId ?? "unavailable",
    isError: turn.isError,
    numTurns: turn.numTurns,
    costUsd: turn.costUsd,
    costAuthoritative: turn.costAuthoritative ?? false,
    inputTokens: turn.inputTokens ?? "unavailable",
    outputTokens: turn.outputTokens ?? "unavailable",
    usage: turn.usage ?? { unavailable: true },
    failure: turn.failure ?? null,
    provider: turn.providerMetadata ?? { unavailable: true },
  };
}
function qaContinuityRecoveryContext(opts: IsolatedQaOptions): unknown {
  if (!opts.recovery) return { unavailable: "no durable run scope" };
  const db = new WorkflowDb(opts.recovery.projectDir);
  try {
    return {
      checkpoints: db.continuityCheckpoints(opts.recovery.runId, "qa"),
      events: db.continuityEvents(opts.recovery.runId),
      handoffs: db.handoffs(opts.recovery.runId),
      recoveryAttempts: db.recoveryAttempts(opts.recovery.runId).filter((attempt) => attempt.ticket === opts.ticket.id),
    };
  } finally { db.close(); }
}
