import { deliverBuilderGuidanceFollowup } from "../builderGuidanceFollowup.js";
import { qaDigest } from "../qaProtocolV2.js";
import { loadTickets } from "../tickets/ticketLoader.js";
import { BuildControlBoundary } from "../buildInterventions.js";
import { formatRecoveryCommand } from "../recoveryGuidance.js";
import { WorkflowReader } from "../workflowReader.js";
import { buildScopeRevision } from "../buildApproval.js";
import type { BuilderAdapter, EffortLevel } from "../adapters/types.js";
import type { RunObserver } from "../observability.js";
import type { ProviderSessionRefV1, SessionStrategy } from "rafi-spec";
import { beginQaFinalization, completeQaFinalization, verifyPendingQaFinalizationSource, compactWithRetry, runIsolatedQa, type QaNonconvergenceContext, type QaNonconvergenceDecision, type QaReportRecoveryHandler, type QaSessionBoundaryRecovery, type QaSessionHandle, type QaStreamState } from "../qaReview.js";
import { QaFailureDeliveryService } from "../qaFailureDelivery.js";
import { Foreman, MARKER_SPEC } from "../foreman.js";
import type { Log } from "../log.js";
import { fireNotification } from "../notify.js";
import { cmdBlock, cmdComplete, cmdUnblock, cmdUpdate } from "../tickets/commands.js";
import { loadTicketsConfig, resolveTicketPaths } from "../tickets/config.js";
import { StateDb } from "../tickets/stateDb.js";
import type { BranchPlan, BranchPlanNode, BranchRunSummary, CompletionMode, GitHubFailureCode, MergeMethod, PrResult, ReviewProvider } from "./types.js";
import {
  commitAll,
  createTicketWorktree,
  findWorktreeForBranch,
  currentWorktreeBranch,
  deleteLocalBranch,
  ensureCleanBaseWorktree,
  ensureForemanExcluded,
  hasTrackerChanges,
  hasWorktreeChanges,
  headCommitIfAhead,
  removeTicketWorktree,
  runGit,
} from "./git.js";
import { DirectMergeSourceChangedError, executeDirectMerge, hasExactStagedDirectMerge, prepareDirectMerge, readDirectMergeIntent, reconcileDirectMerge, removeDirectMergeWorktree, verifyDirectMergeWorktree } from "./finalization.js";
import { checkGitHubPrMerged, createOrReusePr, enableGitHubAutoMerge, pushBranchForPr } from "./github.js";
import { checkGitLabMrMerged, createOrReuseMr, enableGitLabAutoMerge, pushBranchForMr } from "./gitlab.js";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkflowDb } from "../workflowDb.js";
import { assertBuildAssignmentReconciled, BuildAssignmentRejected } from "../buildAssignment.js";
import { currentActivity, withActivityPhase } from "../activity.js";
import { SessionUnavailableError } from "../adapters/sessionFailure.js";
import { SessionUnavailableContinuityError } from "../continuity.js";
import type { QaRecoveryPacket } from "../qaRecovery.js";

export interface DeliveryUnitSession { runId?: string; unitId: string; branch: string; worktreePath: string; sessionId: string; sessionRef?: ProviderSessionRefV1; ticket: string; }
export type BaseWorktreePolicy = "enforce" | "warn" | "skip";

export function readDeliveryUnitSession(projectDir: string, unitId: string): DeliveryUnitSession | undefined {
  const path = deliverySessionPath(projectDir, unitId);
  if (!existsSync(path)) return undefined;
  try {
    const cached = JSON.parse(readFileSync(path, "utf8")) as DeliveryUnitSession;
    const reader = new WorkflowReader(projectDir);
    try {
      const known = reader.branchResumeSessions(false);
      const active = reader.branchResumeSessions().filter(row => row.deliveryUnitId === unitId && row.worktreePath === cached.worktreePath && row.branch === cached.branch).at(-1);
      if (active) return { ...cached, sessionId: active.sessionId, sessionRef: active.sessionRef, ticket: active.ticket };
      if (known.some(row => row.deliveryUnitId === unitId) || reader.buildRuns().length || (cached.runId && reader.getRun(cached.runId))) return undefined;
      return cached;
    } finally { reader.close(); }
  } catch { return undefined; }
}

function deliverySessionPath(projectDir: string, unitId: string): string {
  return join(projectDir, ".foreman", "delivery-sessions", `${unitId}.json`);
}

export interface BranchRunnerOptions {
  continueIndependentTickets?: boolean;
  projectDir: string;
  runId: string;
  plan: BranchPlan;
  log: Log;
  agent?: string;
  model?: string;
  effort?: EffortLevel;
  fast?: boolean;
  notificationsEnabled: boolean;
  terminalBellEnabled?: boolean;
  qaEnabled: boolean;
  qaMaxFixAttempts?: number;
  createPr: boolean;
  completionMode?: CompletionMode;
  reviewProvider?: ReviewProvider;
  prReady: boolean;
  keepWorktrees: boolean;
  cleanupBranches?: boolean;
  autoMergeWait?: boolean;
  autoMergeTimeoutMinutes?: number | null;
  mergeMethod?: MergeMethod;
  allowedBaseDirtyPaths?: string[];
  baseWorktreePolicy?: BaseWorktreePolicy;
  trackerPaths?: { progressDoc: string; archiveDoc: string };
  resumeSessions?: Map<string, { worktreePath: string; sessionId: string; sessionRef?: ProviderSessionRefV1 }>;
  createBuilder: (cwd: string, sessionId?: string, sessionRef?: ProviderSessionRefV1) => Promise<BuilderAdapter>;
  /** Persist every observed Builder binding before later work can supersede it. */
  recordBuilderSession?: (session: string | ProviderSessionRefV1, ticketId: string, worktreePath: string) => void;
  recordQaSession?: (session: string | ProviderSessionRefV1, ticketId: string, worktreePath: string) => void;
  /** Notify the host and stop the branch plan without discarding its worktree. */
  onSessionUnavailable?: (error: SessionUnavailableError | SessionUnavailableContinuityError) => void;
  createQa?: (cwd: string, sessionId?: string) => Promise<QaSessionHandle>;
  builderSessionStrategy?: SessionStrategy;
  qaSessionStrategy?: SessionStrategy;
  observeBuilder?: (builder: BuilderAdapter) => Promise<void>;
  observeBuilderNativeCompactions?: (builder: BuilderAdapter, cwd: string) => Promise<void>;
  observeQaNativeCompactions?: (adapter: BuilderAdapter) => Promise<void>;
  qaNonconvergence?: (context: QaNonconvergenceContext) => Promise<QaNonconvergenceDecision>;
  beforeBuilderTurn?: (adapter: BuilderAdapter, frozenAction: string, cwd: string) => Promise<BuilderAdapter>;
  builderSessionBoundary?: (adapter: BuilderAdapter, frozenAction: string, strategy: SessionStrategy, cwd: string) => Promise<BuilderAdapter>;
  qaSessionBoundary?: (handle: QaSessionHandle, frozenAction: string, strategy: SessionStrategy, cwd: string, recovery?: QaSessionBoundaryRecovery) => Promise<import("../qaReview.js").QaSessionBoundaryResult>;
  observer?: RunObserver;
  qaRuntimeContext?: unknown;
  qaContinuityManaged?: boolean;
  qaReportRecovery?: QaReportRecoveryHandler;
  qaResumedRecovery?: QaRecoveryPacket;
  qaProtocolResumeTicket?: string;
}

export async function runBranchPlan(opts: BranchRunnerOptions): Promise<BranchRunSummary[]> {
  assertBuildAssignmentReconciled(opts.projectDir, opts.runId);
  let qaResumedRecovery = opts.qaResumedRecovery;
  if (qaResumedRecovery) {
    const matches = opts.plan.nodes.filter((node) => node.ticket.id === qaResumedRecovery!.manifest.ticketId);
    if (matches.length !== 1 || opts.plan.nodes.length !== 1) {
      throw new Error(`exact QA recovery must be confined to its single packet ticket ${qaResumedRecovery.manifest.ticketId}`);
    }
    if (!opts.resumeSessions?.has(qaResumedRecovery.manifest.ticketId)) {
      throw new Error(`exact QA recovery requires the preserved worktree/session for ${qaResumedRecovery.manifest.ticketId}`);
    }
  }
  if (opts.qaProtocolResumeTicket) {
    const matches = opts.plan.nodes.filter((node) => node.ticket.id === opts.qaProtocolResumeTicket);
    if (matches.length !== 1 || opts.plan.nodes.length !== 1 || !opts.resumeSessions?.has(opts.qaProtocolResumeTicket)) {
      throw new Error(`exact QA protocol recovery must be confined to its preserved single ticket ${opts.qaProtocolResumeTicket}`);
    }
  }
  const baseWorktreePolicy = opts.baseWorktreePolicy ?? "enforce";
  if (baseWorktreePolicy !== "skip") {
    try {
      ensureCleanBaseWorktree(opts.projectDir, { allowedDirtyPaths: opts.allowedBaseDirtyPaths });
    } catch (error) {
      const recoveryDb = new WorkflowDb(opts.projectDir);
      let exactInterruptedMerge = false;
      try {
        exactInterruptedMerge = opts.plan.nodes.some((node) => {
          if (recoveryDb.qaTicketHead(opts.runId, node.ticket.id).state !== "finalizing") return false;
          const operation = recoveryDb.operation(finalizationOperationKey(recoveryDb, opts.runId, node.ticket.id, "direct-merge"));
          if (operation?.status !== "in_progress") return false;
          try { return hasExactStagedDirectMerge(opts.projectDir, readDirectMergeIntent(operation.intent)); } catch { return false; }
        });
      } finally { recoveryDb.close(); }
      if (exactInterruptedMerge) {
        opts.log.write("branch-resume", { detail: "Base contains exactly the staged tree of its durable interrupted merge" });
      } else if (baseWorktreePolicy === "warn") {
        console.warn(`foreman: warning: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        throw error;
      }
    }
  }
  ensureForemanExcluded(opts.projectDir);

  const completionMode: CompletionMode = opts.completionMode ?? (opts.createPr ? "pr" : "none");
  const reviewProvider: ReviewProvider = opts.reviewProvider ?? "github";
  const createsReview = completionMode === "pr" || completionMode === "auto-merge";
  const summaries: BranchRunSummary[] = [];
  const successfulBranches = new Set<string>();
  const pushedBranches = new Set<string>();
  let builderStream: { sessionId: string; sessionRef?: ProviderSessionRefV1; worktreePath: string } | undefined;
  let builderWorkSessions = 0;
  const qaStream: QaStreamState = { reviews: 0, modificationViolations: 0 };

  for (const issue of opts.plan.issues) {
    opts.log.write("branch-issue", { ...issue });
    notifyIssue(opts.notificationsEnabled, issue.message);
    if (issue.blocking) {
      summaries.push({
        ticket: issue.ticket ?? "plan",
        branch: "",
        base: opts.plan.baseRef,
        buildStatus: "blocked",
        detail: issue.message,
      });
    }
  }
  if (opts.plan.issues.some((issue) => issue.blocking)) return summaries;

  const pendingNodes = orderNodes(opts.plan.nodes);
  while (true) {
    const decisionDb = new WorkflowDb(opts.projectDir);
    const answered = decisionDb.answeredTicketDecisions(opts.runId, buildScopeRevision(opts.projectDir));
    decisionDb.close();
    for (let index = summaries.length - 1; index >= 0; index--) {
      const summary = summaries[index]!;
      if (summary.buildStatus === "done") continue;
      const candidate = opts.plan.nodes.find(item => item.ticket.id === summary.ticket);
      if (!candidate || pendingNodes.some(item => item.ticket.id === candidate.ticket.id)) continue;
      const hasAnswer = answered.some(decision => decision.interruptionId === `ticket:${candidate.ticket.id}`);
      const dependencyDeferred = summary.detail === "deferred because a dependency or shared delivery unit is blocked";
      const dependenciesReady = candidate.dependencies.every(id => successfulBranches.has(id));
      const sharedReady = !summaries.some(prior => prior.ticket !== candidate.ticket.id && prior.buildStatus !== "done" && prior.detail !== "deferred because a dependency or shared delivery unit is blocked" && opts.plan.nodes.some(item => item.ticket.id === prior.ticket && item.deliveryUnitId && item.deliveryUnitId === candidate.deliveryUnitId));
      if ((hasAnswer || dependencyDeferred) && dependenciesReady && sharedReady) {
        summaries.splice(index, 1);
        pendingNodes.push(candidate);
      }
    }
    const node = pendingNodes.shift();
    if (!node) break;
    const continuations = answered.filter(decision => decision.interruptionId === `ticket:${node.ticket.id}`);
    const continuationSuffix = continuations.length ? `:answers:${continuations.map(decision => decision.decisionId).join(",")}` : "";
    const blocked = summaries.filter(summary => summary.buildStatus !== "done");
    if (blocked.length && opts.continueIndependentTickets === false) break;
    if (blocked.some(summary => node.dependencies.includes(summary.ticket)
      || opts.plan.nodes.some(prior => prior.ticket.id === summary.ticket && prior.deliveryUnitId && prior.deliveryUnitId === node.deliveryUnitId))) {
      summaries.push(summaryFor(node, "blocked", "deferred because a dependency or shared delivery unit is blocked"));
      continue;
    }
    const protocolDb = new WorkflowDb(opts.projectDir);
    const protocolHead = protocolDb.qaTicketHead(opts.runId, node.ticket.id);
    const finalizationRecovery = protocolHead.state === "finalizing";
    const directMergeOperation = finalizationOperationKey(protocolDb, opts.runId, node.ticket.id, "direct-merge");
    const commitOperation = finalizationOperationKey(protocolDb, opts.runId, node.ticket.id, "commit");
    const completionOperation = finalizationOperationKey(protocolDb, opts.runId, node.ticket.id, "ticket-complete");
    let completedDirectMerge = finalizationRecovery ? protocolDb.operation(directMergeOperation) : undefined;
    try { if(finalizationRecovery)protocolDb.assertFinalizationControls(opts.runId,node.ticket.id); }
    catch(error) { protocolDb.close();summaries.push(summaryFor(node,"needs-human",error instanceof Error?error.message:String(error)));continue; }
    if (completedDirectMerge?.status === "in_progress") {
      try {
        const intent = readDirectMergeIntent(completedDirectMerge.intent);
        const mergeCommit = reconcileDirectMerge(opts.projectDir, intent)
          ?? await observeNode(opts, node, "git", "resuming durable direct merge", () => executeDirectMerge(opts.projectDir, intent, `${node.ticket.id}: ${node.ticket.title}`));
        if (mergeCommit) {
          confirmJournal(opts.projectDir, directMergeOperation, mergeCommit, { branch: node.branch, base: node.baseBranch, mergeCommit, sourceCommit: intent.sourceCommit });
          completedDirectMerge = { ...completedDirectMerge, status: "confirmed" };
        }
      } catch (error) {
        protocolDb.close();
        const paused = invalidateUnpublishedMergeDrift(opts.projectDir, opts.runId, node.ticket.id, directMergeOperation, error);
        summaries.push(summaryFor(node, "blocked", paused instanceof Error ? paused.message : String(paused)));
        continue;
      }
    }
    protocolDb.close();
    if (finalizationRecovery && completedDirectMerge?.status === "confirmed") {
      let existingWorktree: string | undefined;
      try {
        const intent = readDirectMergeIntent(completedDirectMerge.intent);
        if (!reconcileDirectMerge(opts.projectDir, intent)) throw new Error("Confirmed direct merge no longer exists on its base branch");
        existingWorktree = verifyDirectMergeWorktree(opts.projectDir, intent);
      } catch (error) {
        summaries.push(summaryFor(node, "blocked", error instanceof Error ? error.message : String(error)));
        continue;
      }
      if (existingWorktree && !opts.keepWorktrees) removeDirectMergeWorktree(opts.projectDir, readDirectMergeIntent(completedDirectMerge.intent), existingWorktree);
      if (!opts.keepWorktrees && (opts.cleanupBranches ?? true)) {
        try { deleteLocalBranch(opts.projectDir, node.branch); } catch { /* already removed or retained by repository policy */ }
      }
      if (!ticketIsDone(opts.projectDir, node.ticket.id)) {
        cmdComplete(opts.projectDir, node.ticket.id, { actor: "foreman", summary: `Completed ${node.ticket.id} after reconciling its durable direct merge`, validationResult: "passed", validationNotes: "Durable QA pass and direct-merge receipt reconciled", evidence: "Durable direct-merge receipt" });
      }
      completeQaFinalization(opts.projectDir, opts.runId, node.ticket.id);
      const resumeDb = new WorkflowDb(opts.projectDir);
      try { resumeDb.completeBranchResumeSession(opts.runId, node.ticket.id); } finally { resumeDb.close(); }
      workflowCheckpoint(opts.projectDir, opts.runId, "ticket-completion-after", node.ticket.id, { status: "done", reconciledDirectMerge: true });
      successfulBranches.add(node.ticket.id);
      summaries.push(summaryFor(node, "done"));
      continue;
    }
    const qaOnlyRecovery = qaResumedRecovery?.manifest.ticketId === node.ticket.id || opts.qaProtocolResumeTicket === node.ticket.id || finalizationRecovery;
    const sharedUnit = Boolean(node.deliveryUnitId);
    const completesSharedUnit = !sharedUnit || Boolean(node.deliveryUnitFinal);
    const createsReviewForNode = createsReview && completesSharedUnit;
    const missingDependency = node.dependencies.find((dep) => !successfulBranches.has(dep));
    if (missingDependency) {
      const detail = `dependency ${missingDependency} did not complete`;
      summaries.push(summaryFor(node, "skipped", detail));
      opts.log.write("branch-issue", {
        ticket: node.ticket.id,
        code: "dependency_unavailable",
        message: detail,
        blocking: false,
      });
      notifyIssue(opts.notificationsEnabled, detail);
      continue;
    }

    if (createsReview && !sharedUnit) {
      const missingPush = node.dependencies.find((dep) => {
        const depNode = opts.plan.nodes.find((candidate) => candidate.ticket.id === dep);
        return depNode && !pushedBranches.has(depNode.branch);
      });
      if (missingPush) {
        const detail = `dependency ${missingPush} branch was not pushed`;
        summaries.push(summaryFor(node, "skipped", detail, "skipped"));
        opts.log.write("branch-issue", {
          ticket: node.ticket.id,
          code: "dependency_unavailable",
          message: detail,
          blocking: false,
        });
        notifyIssue(opts.notificationsEnabled, detail);
        continue;
      }
    }

    if (completionMode === "auto-merge" && node.dependencies.length > 0 && !sharedUnit) {
      const mergeReadiness = await waitForAutoMergeDependencies(opts, node, reviewProvider);
      if (!mergeReadiness.ok) {
        summaries.push(summaryFor(node, "skipped", mergeReadiness.message, "skipped"));
        opts.log.write("branch-issue", {
          ticket: node.ticket.id,
          code: mergeReadiness.code,
          message: mergeReadiness.message,
          blocking: false,
          repairCommands: mergeReadiness.repairCommands,
          command: mergeReadiness.command,
          output: mergeReadiness.output,
        });
        notifyIssue(opts.notificationsEnabled, `${node.ticket.id}: ${mergeReadiness.message}`);
        continue;
      }
    }

    const admissionDb = new WorkflowDb(opts.projectDir);
    try { admissionDb.assertAdmittedWork(opts.runId, node.ticket.id); } finally { admissionDb.close(); }
    opts.log.write("branch-start", {
      ticket: node.ticket.id,
      branch: node.branch,
      base: node.baseBranch,
      dependencies: node.dependencies,
    });
    workflowCheckpoint(opts.projectDir, opts.runId, "builder-before", node.ticket.id, { branch: node.branch, worktree: node.worktreePath });

    const continuationDb = new WorkflowDb(opts.projectDir);
    const continuationSession = continuations.length ? continuationDb.branchResumeSession(opts.runId, node.ticket.id) : undefined;
    continuationDb.close();
    const resumeSession = continuationSession ?? opts.resumeSessions?.get(node.ticket.id);
    const worktreePath = resumeSession?.worktreePath
      ?? (sharedUnit ? findWorktreeForBranch(opts.projectDir, node.branch) : undefined)
      ?? await observeNode(opts, node, "git", "creating ticket worktree", () => createTicketWorktree(opts.projectDir, opts.runId, node.branch, node.baseBranch));
    node.worktreePath = worktreePath;
    let builder: BuilderAdapter | undefined;
    let viewer: Promise<void> | undefined;

    try {
      if (resumeSession) {
        opts.log.write("branch-resume", {
          ticket: node.ticket.id,
          branch: node.branch,
          base: node.baseBranch,
          worktreePath,
          sessionId: resumeSession.sessionId,
          sessionRef: resumeSession.sessionRef,
        });
      }

      if (!qaOnlyRecovery) journalTracker(opts.projectDir, opts.runId, `${opts.runId}:tracker-update:${node.ticket.id}:in-progress${continuationSuffix}`, { ticket: node.ticket.id, status: "in_progress" }, () => {
        if (resumeSession) cmdUnblock(opts.projectDir, node.ticket.id, { actor: "foreman", summary: `Reopened by explicit branch recovery for ${node.branch}` });
        cmdUpdate(opts.projectDir, node.ticket.id, {
          status: "in_progress", actor: "foreman",
          summary: resumeSession ? `Resuming branch ${node.branch}` : `Starting branch ${node.branch}`,
        });
      });

      let ticketInstruction = resumeSession ? buildBranchTicketResumeInstruction(node, opts.trackerPaths) : buildBranchTicketInstruction(node, opts.trackerPaths);
      if (continuations.length) ticketInstruction += "\n\nScoped answers authorizing this ticket continuation:\n" + continuations.map(decision => `${decision.prompt}\nAnswer: ${decision.answer ?? decision.selectedChoiceId}`).join("\n");
      // Reattach the predecessor even for a `fresh` strategy so the host can
      // publish and validate a cumulative handoff before creating its successor.
      const sameWorktreeStream = builderStream && canonical(builderStream.worktreePath) === canonical(worktreePath) ? builderStream : undefined;
      const continuedBuilderSession = resumeSession?.sessionId ?? sameWorktreeStream?.sessionId;
      const continuedBuilderRef = resumeSession?.sessionRef ?? sameWorktreeStream?.sessionRef;
      builder = await opts.createBuilder(worktreePath, continuedBuilderSession, continuedBuilderRef);
      if (!qaOnlyRecovery && builderWorkSessions > 0 && continuedBuilderSession) {
        const strategy = opts.builderSessionStrategy ?? "compact";
        if (opts.builderSessionBoundary) {
          builder = await opts.builderSessionBoundary(builder, ticketInstruction, strategy, worktreePath);
        } else if (strategy === "compact") {
          const compacted = await compactWithRetry(builder);
          if (!compacted.ok) { await builder.close(); builder = await opts.createBuilder(worktreePath); }
        } else {
          await builder.close(); builder = await opts.createBuilder(worktreePath);
        }
      }
      if (!qaOnlyRecovery) builderWorkSessions += 1;
      viewer = opts.observeBuilder?.(builder);
      const foreman = new Foreman(
        builder,
        opts.log,
        { desktop: opts.notificationsEnabled, terminalBell: opts.terminalBellEnabled ?? true },
        opts.qaEnabled,
        3,
        opts.projectDir,
        undefined,
        undefined,
        opts.qaSessionStrategy ?? "compact",
        undefined,
        opts.builderSessionStrategy ?? "compact",
        undefined,
        opts.beforeBuilderTurn ? (adapter, action) => opts.beforeBuilderTurn!(adapter, action, worktreePath) : undefined,
        undefined,
        undefined,
        undefined,
        async (adapter) => opts.observeBuilderNativeCompactions?.(adapter, worktreePath),
        opts.observer, undefined, false, undefined, undefined, opts.runId,
        opts.continueIndependentTickets ?? true, node.ticket.id, worktreePath,
      );

      const turn = async () => {
        const db = new WorkflowDb(opts.projectDir);
        try {
          db.atomic(() => { for (const decision of continuations) {
            const key = `decision-continuation:${decision.decisionId}`;
            db.planOperation({ runId: opts.runId, idempotencyKey: key, kind: "decision-continuation", intent: { decisionId: decision.decisionId, ticketId: node.ticket.id } });
            db.updateOperation(key, "in_progress");
          } });
          const response = await foreman.runInstruction(ticketInstruction);
          for (const decision of continuations) db.updateOperation(`decision-continuation:${decision.decisionId}`, response.result.failure?.dispatchState === "unknown" ? "uncertain" : "confirmed", { result: { isError: response.result.isError } });
          return response;
        } finally { db.close(); }
      };
      const { result, status } = qaOnlyRecovery
        ? { result: { text: "Exact QA-only recovery; Builder work dispatch was intentionally skipped.", isError: false, numTurns: 0, costUsd: 0 }, status: { kind: "done" as const, summary: "Resuming exact QA boundary", ticket: node.ticket.id } }
        : opts.observer
          ? await opts.observer.withContext({ role: "builder", stream: "builder", ticketId: node.ticket.id, deliveryUnitId: node.deliveryUnitId }, turn)
          : await turn();
      builder = foreman.builderAdapter();
      workflowCheckpoint(opts.projectDir, opts.runId, "builder-after", node.ticket.id, { status: status.kind, sessionId: builder.sessionId(), worktree: worktreePath });
      const sessionId = builder.sessionId();
      const sessionRef = builder.sessionRef?.();
      if (sessionId) builderStream = { sessionId, ...(sessionRef ? { sessionRef } : {}), worktreePath };
      if (sessionId) {
        opts.recordBuilderSession?.(sessionRef ?? sessionId, node.ticket.id, worktreePath);
        workflowCheckpoint(opts.projectDir, opts.runId, "builder-session-scoped", node.ticket.id, { sessionId, sessionRef, worktree: worktreePath, branch: node.branch });
      }
      if (sessionId) {
        const resumeSession = {
          ticket: node.ticket.id,
          branch: node.branch,
          base: node.baseBranch,
          worktreePath,
          sessionId,
          sessionRef: builder.sessionRef?.(),
          agent: opts.agent,
          model: opts.model,
          effort: opts.effort,
          fast: opts.fast,
          qaEnabled: opts.qaEnabled,
          createPr: createsReview,
          completionMode,
          reviewProvider,
          prReady: opts.prReady,
          keepWorktrees: opts.keepWorktrees,
          deliveryUnitId: node.deliveryUnitId,
          deliveryUnitFinal: node.deliveryUnitFinal,
          logPath: "structured-recovery",
          ts: new Date().toISOString(),
        };
        opts.log.write("branch-session", resumeSession);
        const resumeDb = new WorkflowDb(opts.projectDir); try { resumeDb.recordBranchResumeSession(opts.runId, resumeSession); } finally { resumeDb.close(); }
        if (node.deliveryUnitId) {
          const path = deliverySessionPath(opts.projectDir, node.deliveryUnitId);
          mkdirSync(join(opts.projectDir, ".foreman", "delivery-sessions"), { recursive: true });
          writeFileSync(path, `${JSON.stringify({ runId: opts.runId, unitId: node.deliveryUnitId, branch: node.branch, worktreePath, sessionId, sessionRef: builder.sessionRef?.(), ticket: node.ticket.id }, null, 2)}\n`, "utf8");
        }
      }
      opts.log.write("step", {
        index: summaries.length + 1,
        statusKind: status.kind,
        summary: status.summary,
        ticket: status.ticket ?? node.ticket.id,
        branchDependency: status.branchDependency,
        costUsd: result.costUsd,
        isError: result.isError,
      });

      if (result.isError) throw new Error(`builder turn errored: ${result.text.slice(0, 200)}`);
      if (status.branchDependency) {
        throw new Error(`builder requested branch_dependency=${status.branchDependency}; retry is not available after ticket start in this run`);
      }
      if (status.kind !== "done" && status.kind !== "plan_complete") {
        const detail = status.reason ?? status.error ?? `builder emitted ${status.kind}`;
        journalTracker(opts.projectDir, opts.runId, `${opts.runId}:tracker-update:${node.ticket.id}:builder-block${continuationSuffix}`, { ticket: node.ticket.id, status: "blocked", detail }, () => cmdBlock(opts.projectDir, node.ticket.id, { summary: detail, actor: "foreman" }));
        summaries.push(summaryFor(node, status.kind === "blocked" ? "blocked" : "needs-human", detail));
        continue;
      }

      let qaSummary: string | undefined;
      let qaWaived = false;
      let qaPassCertificateId: string | undefined;
      let qaSourceStateDigest: string | undefined;
      if (opts.qaEnabled && !finalizationRecovery) {
        if (!opts.createQa) throw new Error("independent disposable QA factory is required when QA is enabled");
        workflowCheckpoint(opts.projectDir, opts.runId, "qa-before", node.ticket.id, { worktree: worktreePath });
        const qa = await runIsolatedQa({
          ticket: node.ticket, builderWorktree: worktreePath, builderSummary: result.text,
          qaStrategy: opts.qaSessionStrategy ?? "compact", state: qaStream, createQa: opts.createQa, maxCycles: opts.qaMaxFixAttempts ?? 3,
          recovery: { projectDir: opts.projectDir, runId: opts.runId },
          observer: opts.observer,
          qaRuntimeContext: opts.qaRuntimeContext,
          continuityManaged: opts.qaContinuityManaged,
          onReportRecovery: opts.qaReportRecovery,
          resumedRecovery: qaResumedRecovery,
          sessionBoundary: opts.qaSessionBoundary ?? (async () => { throw new Error("QA recovery requires a validated durable session boundary"); }),
          observeNativeCompactions: opts.observeQaNativeCompactions,
          resolveBlocked: (adapter, reason) => foreman.resolveBlocker(adapter, reason, "qa"),
          evidence: (entry) => opts.log.write("qa-evidence", { ticket: node.ticket.id, ...entry }),
          resumeBuilderGuidance: qaOnlyRecovery,
          deliverBuilderFollowup: (instruction, followup) => deliverBuilderGuidanceFollowup({ projectDir: opts.projectDir, runId: opts.runId, ticketId: node.ticket.id, worktree: worktreePath }, instruction, followup, {
            prepare: async instruction => {
              if (!builder) throw new Error("Builder session unavailable");
              const strategy = opts.builderSessionStrategy ?? "compact";
              if (opts.builderSessionBoundary) builder = await opts.builderSessionBoundary(builder, instruction, strategy, worktreePath);
              else if (strategy === "fresh") { await builder.close(); builder = await opts.createBuilder(worktreePath); }
              else if (builder.sessionId()) { const compacted = await compactWithRetry(builder); if (!compacted.ok) { await builder.close(); builder = await opts.createBuilder(worktreePath); } }
              if (opts.beforeBuilderTurn) builder = await opts.beforeBuilderTurn(builder, instruction, worktreePath);
              return builder;
            },
            validateRequirements: () => {
              const current = loadTickets(resolveTicketPaths(loadTicketsConfig(opts.projectDir),opts.projectDir).tickets).find(ticket => ticket.id === node.ticket.id);
              if (!current || qaDigest("admitted-requirements",current) !== followup.requirementsDigest) throw new BuildAssignmentRejected("Ticket requirements changed during session preparation; renewed scope approval is required");
            },
            recordSession: adapter => {
              const sessionId=adapter.sessionId(),sessionRef=adapter.sessionRef?.();
              if (!sessionId) return;
              builderStream={sessionId,...(sessionRef?{sessionRef}:{}),worktreePath};
              const db=new WorkflowDb(opts.projectDir);
              try {db.recordBranchResumeSession(opts.runId,{ticket:node.ticket.id,branch:node.branch,base:node.baseBranch,worktreePath,sessionId,sessionRef,logPath:"structured-recovery",deliveryUnitId:node.deliveryUnitId});} finally {db.close();}
              opts.recordBuilderSession?.(sessionRef??sessionId,node.ticket.id,worktreePath);
            },
            completed: async (operationId,adapter) => {
              builderWorkSessions += 1;
              await opts.observeBuilderNativeCompactions?.(adapter,worktreePath);
              opts.log.write("qa-fix",{kind:"builder-guidance-followup",ticket:node.ticket.id,operationId});
            },
          }),
          deliverFailure: async (request) => {
            if (!builder) return { ok: false, detail: "Builder session unavailable" };
            builderWorkSessions += 1;
            const delivery = new QaFailureDeliveryService();
            const result = await delivery.deliver(request, {
              adapter: () => builder,
              setAdapter: (adapter) => { builder = adapter; },
              sessionStrategy: opts.builderSessionStrategy ?? "compact",
              prepareBoundary: async (adapter, instruction, strategy) => {
                if (opts.builderSessionBoundary) return opts.builderSessionBoundary(adapter, instruction, strategy, worktreePath);
                if (strategy === "compact" && adapter.sessionId()) {
                  const compacted = await compactWithRetry(adapter);
                  if (compacted.ok) return adapter;
                  await adapter.close();
                  return opts.createBuilder(worktreePath);
                }
                if (strategy === "fresh") {
                  await adapter.close();
                  return opts.createBuilder(worktreePath);
                }
                return adapter;
              },
              beforeTurn: async (adapter, instruction, worktree) => opts.beforeBuilderTurn ? opts.beforeBuilderTurn(adapter, instruction, worktree) : adapter,
              recordSession: (session) => {
                const sessionRef = typeof session === "string" ? undefined : session;
                const sessionId = typeof session === "string" ? session : session.sessionId;
                builderStream = { sessionId, ...(sessionRef ? { sessionRef } : {}), worktreePath };
                const resumeDb = new WorkflowDb(opts.projectDir);
                try { resumeDb.recordBranchResumeSession(opts.runId, { ticket: node.ticket.id, branch: node.branch, base: node.baseBranch, worktreePath, sessionId, sessionRef, logPath: "structured-recovery", deliveryUnitId: node.deliveryUnitId }); }
                finally { resumeDb.close(); }
                opts.recordBuilderSession?.(sessionRef ?? sessionId, node.ticket.id, worktreePath);
                workflowCheckpoint(opts.projectDir, opts.runId, "builder-session-scoped", node.ticket.id, { sessionId, sessionRef, worktree: worktreePath, branch: node.branch });
              },
            });
            opts.log.write("qa-fix", { ticket: node.ticket.id, outcome: result.outcome, operationId: result.operationId, turnRecordId: result.turnRecordId, detail: result.detail });
            return result;
          },
          onNonconvergence: opts.qaNonconvergence,
        });
        if (qaResumedRecovery) {
          const recoveryDb = new WorkflowDb(opts.projectDir);
          try { if (recoveryDb.qaRecoveryHead(opts.runId, qaResumedRecovery.manifest.ticketId)?.pendingAction === "resolved") qaResumedRecovery = undefined; }
          finally { recoveryDb.close(); }
        }
        if (qaStream.sessionId) opts.recordQaSession?.(qaStream.sessionRef ?? qaStream.sessionId, node.ticket.id, worktreePath);
        workflowCheckpoint(opts.projectDir, opts.runId, "qa-after", node.ticket.id, { outcome: qa.outcome, detail: qa.detail });
        if (qa.outcome !== "passed" && qa.outcome !== "waived") {
          const detail = qa.detail ?? "QA did not pass";
          journalTracker(opts.projectDir, opts.runId, `${opts.runId}:tracker-update:${node.ticket.id}:qa-block${continuationSuffix}`, { ticket: node.ticket.id, status: "blocked", detail }, () => cmdBlock(opts.projectDir, node.ticket.id, { summary: detail, actor: "foreman" }));
          summaries.push(summaryFor(node, qa.outcome === "blocked" ? "blocked" : "needs-human", detail)); continue;
        }
        qaWaived = qa.outcome === "waived";
        qaSummary = qa.summary;
        qaPassCertificateId = qa.passCertificateId;
        qaSourceStateDigest = qa.sourceStateDigest;
      } else if (!finalizationRecovery) {
        opts.log.write("qa", {
          stepIndex: summaries.length + 1,
          cycle: 0,
          statusKind: "qa_pass",
          issues: undefined,
          costUsd: 0,
          isError: false,
        });
      }

      const finalControlsDb=new WorkflowDb(opts.projectDir);
      try { finalControlsDb.assertFinalizationControls(opts.runId,node.ticket.id); } finally {finalControlsDb.close();}

      if (opts.qaEnabled && !qaWaived && !finalizationRecovery) {
        if (!qaPassCertificateId || !qaSourceStateDigest) throw new Error("QA passed without a durable pass certificate");
        await beginQaFinalization(opts.projectDir, worktreePath, opts.runId, node.ticket.id, qaPassCertificateId, qaSourceStateDigest, `branch-finalization:${node.ticket.id}`);
      }

      if (opts.qaEnabled && !qaWaived && finalizationRecovery) {
        await verifyPendingQaFinalizationSource(opts.projectDir, worktreePath, opts.runId, node.ticket.id, !hasWorktreeChanges(worktreePath), commitOperation);
      }

      const currentBranch = currentWorktreeBranch(worktreePath);
      if (currentBranch !== node.branch) {
        throw new Error(`builder switched branch from ${node.branch} to ${currentBranch}`);
      }
      if (hasTrackerChanges(worktreePath, opts.trackerPaths)) {
        throw new Error("builder modified tracker/control files in ticket worktree");
      }

      let commit: string | undefined;
      if (hasWorktreeChanges(worktreePath)) {
        if (opts.qaEnabled && !qaWaived) await verifyPendingQaFinalizationSource(opts.projectDir, worktreePath, opts.runId, node.ticket.id, false);
        workflowCheckpoint(opts.projectDir, opts.runId, "commit-before", node.ticket.id, { branch: node.branch });
        const operation = commitOperation;
        planJournal(opts.projectDir, opts.runId, operation, "commit", { ticket: node.ticket.id, branch: node.branch, worktreePath });
        try { commit = await observeNode(opts, node, "git", "committing ticket changes", () => commitAll(worktreePath, `${node.ticket.id}: ${node.ticket.title}`)); confirmJournal(opts.projectDir, operation, commit, { sha: commit }); workflowCheckpoint(opts.projectDir, opts.runId, "commit-after", node.ticket.id, { sha: commit }); }
        catch (error) { failJournal(opts.projectDir, operation, error, false); throw error; }
      }
      if (!commit && (createsReviewForNode || (completionMode === "direct-merge" && completesSharedUnit))) {
        commit = headCommitIfAhead(worktreePath, node.baseBranch);
      }
      if (opts.qaEnabled && !qaWaived) {
        await verifyPendingQaFinalizationSource(opts.projectDir, worktreePath, opts.runId, node.ticket.id, true, commitOperation);
      }

      const summary = summaryFor(node, "done", commit ? undefined : "no_changes");
      summary.commit = commit;

      if (commit && createsReviewForNode) {
        workflowCheckpoint(opts.projectDir, opts.runId, "push-before", node.ticket.id, { branch: node.branch, sha: commit });
        const pushOperation = `${opts.runId}:push:${node.branch}`;
        planJournal(opts.projectDir, opts.runId, pushOperation, "push", { branch: node.branch, sha: commit, remote: "origin" });
        const push = await observeNode(opts, node, "git", `pushing ${node.branch}`, () => withActivityPhase(`pushing ${node.branch}`, async () => {
          currentActivity()?.update(`pushing ${node.branch}`, `publishing ${node.ticket.id}`);
          return reviewProvider === "gitlab"
            ? pushBranchForMr(worktreePath, node.branch)
            : pushBranchForPr(worktreePath, node.branch);
        }));
        if (push.ok) {
          confirmJournal(opts.projectDir, pushOperation, node.branch, { sha: commit });
          opts.log.write("branch-push", { ticket: node.ticket.id, branch: node.branch, status: "pushed" });
          summary.pushStatus = "pushed";
          workflowCheckpoint(opts.projectDir, opts.runId, "push-after", node.ticket.id, { branch: node.branch, sha: commit });
        } else {
          failJournal(opts.projectDir, pushOperation, push.message, push.code === "network_or_timeout");
          summary.pushStatus = "failed";
          summary.pr = {
            status: "skipped",
            error: `push failed: ${push.message}`,
            code: push.code,
            message: push.message,
            repairCommands: push.repairCommands,
            command: push.command,
            output: push.output,
          };
          opts.log.write("branch-push", {
            ticket: node.ticket.id,
            branch: node.branch,
            status: "failed",
            code: push.code,
            message: push.message,
            repairCommands: push.repairCommands,
            command: push.command,
            output: push.output,
          });
          blockBranchIssue(opts, node, summary, push.code, `push failed: ${push.message}`, push);
          summaries.push(summary);
          continue;
        }

        pushedBranches.add(node.branch);
        workflowCheckpoint(opts.projectDir, opts.runId, "review-creation-before", node.ticket.id, { provider: reviewProvider, head: node.branch, base: node.baseBranch });
        const reviewOperation = `${opts.runId}:${reviewProvider === "gitlab" ? "mr" : "pr"}:${node.branch}:${node.baseBranch}`;
        planJournal(opts.projectDir, opts.runId, reviewOperation, reviewProvider === "gitlab" ? "mr-create" : "pr-create", { head: node.branch, base: node.baseBranch, sha: commit });
        const pr = await observeNode(opts, node, "external_check", `creating ${reviewProvider === "gitlab" ? "merge request" : "pull request"}`, () => withActivityPhase(`creating ${reviewProvider === "gitlab" ? "merge request" : "pull request"}`, async () => {
          currentActivity()?.update(`creating ${reviewProvider === "gitlab" ? "merge request" : "pull request"}`, node.ticket.id);
          return reviewProvider === "gitlab"
            ? createOrReuseMr(opts.projectDir, {
              node,
              ready: opts.prReady || completionMode === "auto-merge",
              runId: opts.runId,
              qaEvidence: qaSummary,
              commit,
              autoMerge: false,
              cleanup: opts.cleanupBranches ?? true,
              mergeMethod: opts.mergeMethod ?? "squash",
            })
            : createOrReusePr(opts.projectDir, {
              node,
              ready: opts.prReady || completionMode === "auto-merge",
              runId: opts.runId,
              qaEvidence: qaSummary,
              commit,
            });
        }));
        summary.pr = pr;
        if (pr.status === "created" || pr.status === "existing") { confirmJournal(opts.projectDir, reviewOperation, pr.url, { head: node.branch, base: node.baseBranch, url: pr.url }); workflowCheckpoint(opts.projectDir, opts.runId, "review-creation-after", node.ticket.id, { provider: reviewProvider, head: node.branch, base: node.baseBranch, url: pr.url }); }
        else if (pr.status === "failed") failJournal(opts.projectDir, reviewOperation, pr.message ?? pr.error ?? "review creation failed", pr.code === "network_or_timeout");
        if (pr.status === "created") opts.log.write(reviewProvider === "gitlab" ? "mr-created" : "pr-created", { ticket: node.ticket.id, branch: node.branch, url: pr.url });
        if (pr.status === "existing") opts.log.write(reviewProvider === "gitlab" ? "mr-existing" : "pr-existing", { ticket: node.ticket.id, branch: node.branch, url: pr.url });
        if (pr.status === "failed") {
          opts.log.write(reviewProvider === "gitlab" ? "mr-failed" : "pr-failed", failureLogFields(node, pr));
          blockBranchIssue(
            opts,
            node,
            summary,
            pr.code ?? (reviewProvider === "gitlab" ? "mr_create_failed" : "pr_create_failed"),
            `${reviewProvider === "gitlab" ? "MR" : "PR"} creation failed: ${pr.message ?? pr.error ?? "unknown error"}`,
            pr,
          );
          summaries.push(summary);
          continue;
        }
        if (completionMode === "auto-merge" && reviewProvider === "github") {
          const autoMerge = await observeNode(opts, node, "external_check", "enabling GitHub auto-merge", () => withActivityPhase("enabling GitHub auto-merge", async () => {
            currentActivity()?.update("enabling GitHub auto-merge", node.branch);
            return enableGitHubAutoMerge(opts.projectDir, node.branch, opts.cleanupBranches ?? true, opts.mergeMethod ?? "squash");
          }));
          summary.pr = autoMerge.status === "failed" ? autoMerge : { ...pr, status: "auto_merge_enabled", url: autoMerge.url ?? pr.url };
          if (autoMerge.status === "failed") {
            opts.log.write("pr-auto-merge-failed", failureLogFields(node, autoMerge));
            blockBranchIssue(
              opts,
              node,
              summary,
              autoMerge.code ?? "pr_create_failed",
              `PR auto-merge failed: ${autoMerge.message ?? autoMerge.error ?? "unknown error"}`,
              autoMerge,
            );
            summaries.push(summary);
            continue;
          }
          opts.log.write("pr-auto-merge-enabled", { ticket: node.ticket.id, branch: node.branch, url: summary.pr.url });
        } else if (completionMode === "auto-merge" && reviewProvider === "gitlab") {
          const autoMerge = await observeNode(opts, node, "external_check", "enabling GitLab auto-merge", () => withActivityPhase("enabling GitLab auto-merge", async () => {
            currentActivity()?.update("enabling GitLab auto-merge", node.branch);
            return enableGitLabAutoMerge(opts.projectDir, node.branch, opts.cleanupBranches ?? true, opts.mergeMethod ?? "squash");
          }));
          summary.pr = autoMerge.status === "failed" ? autoMerge : { ...pr, status: "auto_merge_enabled", url: autoMerge.url ?? pr.url };
          if (autoMerge.status === "failed") {
            opts.log.write("mr-auto-merge-failed", failureLogFields(node, autoMerge));
            blockBranchIssue(
              opts,
              node,
              summary,
              autoMerge.code ?? "mr_create_failed",
              `MR auto-merge failed: ${autoMerge.message ?? autoMerge.error ?? "unknown error"}`,
              autoMerge,
            );
            summaries.push(summary);
            continue;
          }
          opts.log.write("mr-auto-merge-enabled", { ticket: node.ticket.id, branch: node.branch, url: summary.pr.url });
        }
      } else if (createsReviewForNode) {
        summary.pushStatus = "skipped";
        summary.pr = { status: "skipped", error: commit ? undefined : "no_changes" };
      } else if (commit && completionMode === "direct-merge" && completesSharedUnit) {
        const mergeDb = new WorkflowDb(opts.projectDir);
        let existingMerge;
        try { existingMerge = mergeDb.operation(directMergeOperation); } finally { mergeDb.close(); }
        const mergeIntent = existingMerge ? readDirectMergeIntent(existingMerge.intent)
          : prepareDirectMerge(opts.projectDir, node.ticket.id, node.branch, node.baseBranch, opts.mergeMethod ?? "squash");
        planJournal(opts.projectDir, opts.runId, directMergeOperation, "direct-merge", mergeIntent);
        let mergeCommit: string;
        try { mergeCommit = await observeNode(opts, node, "git", "merging ticket branch to local base", () => executeDirectMerge(opts.projectDir, mergeIntent, `${node.ticket.id}: ${node.ticket.title}`)); }
        catch (error) { throw invalidateUnpublishedMergeDrift(opts.projectDir, opts.runId, node.ticket.id, directMergeOperation, error); }
        summary.pr = { status: "merged", url: mergeCommit };
        opts.log.write("branch-direct-merge", {
          ticket: node.ticket.id,
          branch: node.branch,
          base: node.baseBranch,
          commit: mergeCommit,
        });
        confirmJournal(opts.projectDir, directMergeOperation, mergeCommit, { branch: node.branch, base: node.baseBranch, mergeCommit, sourceCommit: mergeIntent.sourceCommit });
        verifyDirectMergeWorktree(opts.projectDir, mergeIntent);
        if (!opts.keepWorktrees) removeDirectMergeWorktree(opts.projectDir, mergeIntent, worktreePath);
        if (!opts.keepWorktrees && (opts.cleanupBranches ?? true)) deleteLocalBranch(opts.projectDir, node.branch);
      }

      workflowCheckpoint(opts.projectDir, opts.runId, "ticket-completion-before", node.ticket.id, { validationResult: qaWaived ? "failed" : opts.qaEnabled ? "passed" : "not_applicable" });
      const priorCompletion = operationStatus(opts.projectDir, completionOperation);
      if (priorCompletion !== "confirmed") {
        planJournal(opts.projectDir, opts.runId, completionOperation, "ticket-complete", { ticket: node.ticket.id });
        if (!ticketIsDone(opts.projectDir, node.ticket.id)) {
          cmdComplete(opts.projectDir, node.ticket.id, {
            actor: "foreman",
            summary: status.summary ?? `Completed ${node.ticket.id}`,
            validationResult: qaWaived ? "failed" : opts.qaEnabled ? "passed" : "not_applicable",
            validationNotes: qaWaived ? "User explicitly waived unresolved QA failures" : opts.qaEnabled ? "Foreman QA emitted qa_pass" : "Foreman QA disabled for this run",
            evidence: opts.qaEnabled ? (qaSummary ?? (qaWaived ? "Unresolved QA issues preserved in run evidence" : "Foreman QA emitted qa_pass")) : undefined,
          });
        }
        confirmJournal(opts.projectDir, completionOperation, node.ticket.id, { status: "done" });
      }
      if (opts.qaEnabled && !qaWaived) completeQaFinalization(opts.projectDir, opts.runId, node.ticket.id);
      workflowCheckpoint(opts.projectDir, opts.runId, "ticket-completion-after", node.ticket.id, { status: "done" });

      successfulBranches.add(node.ticket.id);
      summaries.push(summary);
      opts.log.write("branch-complete", {
        ticket: node.ticket.id,
        branch: node.branch,
        commit,
        status: "done",
        detail: summary.detail,
      });
      const resumeDb = new WorkflowDb(opts.projectDir); try { resumeDb.completeBranchResumeSession(opts.runId, node.ticket.id); } finally { resumeDb.close(); }

      if (node.deliveryUnitId && node.deliveryUnitFinal) rmSync(deliverySessionPath(opts.projectDir, node.deliveryUnitId), { force: true });

      if (!opts.keepWorktrees && completionMode !== "direct-merge" && completesSharedUnit) await observeNode(opts, node, "cleanup", "removing ticket worktree", () => removeTicketWorktree(opts.projectDir, worktreePath));
    } catch (err) {
      if (err instanceof BuildAssignmentRejected) {
        summaries.push(summaryFor(node, "needs-human", err.message));
        return summaries;
      }
      if (err instanceof SessionUnavailableError || err instanceof SessionUnavailableContinuityError) {
        const message = err.message;
        opts.log.write("branch-issue", { ticket: node.ticket.id, code: "session_unavailable", message, blocking: true });
        notifyIssue(opts.notificationsEnabled, `${node.ticket.id}: ${message}`);
        summaries.push(summaryFor(node, "blocked", message));
        opts.onSessionUnavailable?.(err);
        return summaries;
      }
      const message = err instanceof Error ? err.message : String(err);
      const code: "branch_switch" | "tracker_touched" | "builder_error" = message.includes("switched branch")
        ? "branch_switch"
        : message.includes("tracker/control")
        ? "tracker_touched"
        : "builder_error";
      opts.log.write("branch-issue", { ticket: node.ticket.id, code, message, blocking: false });
      notifyIssue(opts.notificationsEnabled, `${node.ticket.id}: ${message}`);
      journalTracker(opts.projectDir, opts.runId, `${opts.runId}:tracker-update:${node.ticket.id}:runtime-block${continuationSuffix}`, { ticket: node.ticket.id, status: "blocked", detail: message }, () => cmdBlock(opts.projectDir, node.ticket.id, { summary: message, actor: "foreman" }));
      summaries.push(summaryFor(node, "blocked", message));
    } finally {
      await builder?.close().catch(() => {});
      await viewer?.catch(() => {});
    }
  }

  return summaries;
}

function planJournal(projectDir: string, runId: string, key: string, kind: string, intent: unknown): void {
  const db = new WorkflowDb(projectDir); try { if (!db.getRun(runId)) db.createRun({ runId, kind: "build", originalWork: {}, state: {} }); const operation = db.planOperation({ runId, idempotencyKey: key, kind, intent }); if (operation.status !== "confirmed") db.updateOperation(key, "in_progress"); } finally { db.close(); }
}

function finalizationOperationKey(db: WorkflowDb, runId: string, ticketId: string, kind: string): string {
  const invalidated = db.qaFinalizationSteps(runId, ticketId).filter((step) => step.status === "invalidated").length;
  return `${runId}:${kind}:${ticketId}${invalidated ? `:qa-recheck-${invalidated}` : ""}`;
}

function invalidateUnpublishedMergeDrift(projectDir: string, runId: string, ticketId: string, operationId: string, error: unknown): unknown {
  if (!(error instanceof DirectMergeSourceChangedError)) return error;
  const db = new WorkflowDb(projectDir);
  try {
    const head = db.qaTicketHead(runId, ticketId);
    const operation = db.operation(operationId);
    if (head.state !== "finalizing" || !operation || !["planned", "in_progress"].includes(operation.status)) return error;
    const intent = readDirectMergeIntent(operation.intent);
    if (runGit(projectDir, ["rev-parse", intent.base]).stdout !== intent.baseCommit || hasWorktreeChanges(projectDir)) return error;
    // No base ref/index/worktree mutation occurred. Keep the abandoned intent
    // and source edits, but retire its dispatch slot before scheduling new QA.
    db.updateOperation(operationId, "failed", { error: error.message });
    const paused = db.invalidateQaFinalization(runId, ticketId, head.revision, error.message, intent.branch);
    return new Error(`${error.message}. A complete QA recheck is required. Resume with: ${formatRecoveryCommand(projectDir)}`);
  } catch { return error; }
  finally { db.close(); }
}
function operationStatus(projectDir: string, key: string): import("rafi-spec").OperationLifecycle | undefined {
  const db = new WorkflowDb(projectDir); try { return db.operation(key)?.status; } finally { db.close(); }
}
function ticketIsDone(projectDir: string, ticketId: string): boolean {
  const paths = resolveTicketPaths(loadTicketsConfig(projectDir), projectDir);
  const db = new StateDb(paths.stateDb);
  try { return db.getState(ticketId)?.status === "done"; } finally { db.close(); }
}
function confirmJournal(projectDir: string, key: string, externalId: string | undefined, result: unknown): void {
  const db = new WorkflowDb(projectDir); try { db.updateOperation(key, "confirmed", { externalId, result }); } finally { db.close(); }
}
function failJournal(projectDir: string, key: string, error: unknown, uncertain: boolean): void {
  const db = new WorkflowDb(projectDir); try { db.updateOperation(key, uncertain ? "uncertain" : "failed", { error: error instanceof Error ? error.message : String(error) }); } finally { db.close(); }
}
function journalTracker(projectDir: string, runId: string, key: string, intent: unknown, action: () => void): void {
  planJournal(projectDir, runId, key, "tracker-update", intent);
  try { action(); confirmJournal(projectDir, key, undefined, intent); }
  catch (error) { failJournal(projectDir, key, error, false); throw error; }
}
function workflowCheckpoint(projectDir: string, runId: string, checkpoint: string, ticket: string, payload: Record<string, unknown>): void {
  const db = new WorkflowDb(projectDir);
  try {
    const run = db.getRun(runId); if (!run) return;
    db.transition(runId, { checkpoint, state: { ...run.state, currentTicket: ticket, ...payload }, event: checkpoint, payload: { ticket, ...payload } });
    db.appendContinuityEvent({ runId, role: "host", kind: checkpoint, payload: { ticket, ...payload }, authoritativeStateRevision: db.continuityHead(runId, "run")?.authoritativeStateRevision ?? 0 });
  } finally { db.close(); }
}

interface AutoMergeDependencyResult {
  ok: boolean;
  code?: GitHubFailureCode | "dependency_unavailable";
  message?: string;
  repairCommands?: string[];
  command?: string;
  output?: string;
}

async function waitForAutoMergeDependencies(
  opts: BranchRunnerOptions,
  node: BranchPlanNode,
  provider: ReviewProvider,
): Promise<AutoMergeDependencyResult> {
  return withActivityPhase("checking dependency merges", () => waitForAutoMergeDependenciesInternal(opts, node, provider));
}

async function waitForAutoMergeDependenciesInternal(
  opts: BranchRunnerOptions,
  node: BranchPlanNode,
  provider: ReviewProvider,
): Promise<AutoMergeDependencyResult> {
  const dependencyNodes = node.dependencies
    .map((dep) => opts.plan.nodes.find((candidate) => candidate.ticket.id === dep))
    .filter((dep): dep is BranchPlanNode => Boolean(dep));
  if (dependencyNodes.length === 0) return { ok: true };

  const timeoutMs = opts.autoMergeTimeoutMinutes === null || opts.autoMergeTimeoutMinutes === undefined
    ? null
    : opts.autoMergeTimeoutMinutes * 60_000;
  const deadline = opts.autoMergeWait && timeoutMs !== null ? Date.now() + timeoutMs : null;
  let waitSpanId: string | undefined;
  let waitOutcome = "completed";
  let waitLogged = false;

  try { while (true) {
    const pending: string[] = [];
    for (const dep of dependencyNodes) {
      const status = provider === "gitlab"
        ? checkGitLabMrMerged(opts.projectDir, dep.branch)
        : checkGitHubPrMerged(opts.projectDir, dep.branch);
      if (!status.ok) {
        waitOutcome = "failed";
        return {
          ok: false,
          code: status.code,
          message: `dependency ${dep.ticket.id} merge check failed: ${status.message}`,
          repairCommands: status.repairCommands,
          command: status.command,
          output: status.output,
        };
      }
      if (!status.merged) pending.push(`${dep.ticket.id}${status.state ? ` (${status.state})` : ""}`);
    }
    if (pending.length === 0) return { ok: true };

    const message = `auto-merge dependency ${pending.join(", ")} has not merged into the root base yet`;
    currentActivity()?.update("waiting for dependency merge", pending.join(", "));
    if (!opts.autoMergeWait) {
      return {
        ok: false,
        code: "dependency_unavailable",
        message: `${message}; rerun after it merges or enable auto-merge wait in ticket setup`,
      };
    }
    if (!waitSpanId && opts.observer) {
      waitSpanId = opts.observer.store.startSpan({ runId: opts.runId, executionId: opts.observer.executionId, role: "host", stream: "dependency", ticketId: node.ticket.id }, { kind: "dependency_wait", name: "waiting for dependency merge", attributes: { dependencies: pending } });
      opts.observer.store.updateCurrentState({ runId: opts.runId, role: "host", stream: "dependency", executionId: opts.observer.executionId, ticketId: node.ticket.id, phase: "waiting for dependency merge", activeSpanId: waitSpanId, activeSpanKind: "dependency_wait", lastSemanticProgressAt: new Date().toISOString() });
    }
    if (!waitLogged) {
      opts.log.write("branch-auto-merge-wait", {
        ticket: node.ticket.id,
        pending,
        timeoutMinutes: opts.autoMergeTimeoutMinutes ?? null,
      });
      waitLogged = true;
    }
    if (deadline !== null && Date.now() >= deadline) {
      waitOutcome = "timed_out";
      return {
        ok: false,
        code: "dependency_unavailable",
        message: `${message}; timed out waiting for dependency merge`,
      };
    }

    await sleep(autoMergePollMs());
  } } finally {
    if (waitSpanId && opts.observer) opts.observer.store.finishSpan(waitSpanId, { outcome: waitOutcome });
    if (waitLogged) opts.log.write("branch-auto-merge-wait", { ticket: node.ticket.id, outcome: waitOutcome, terminal: true });
  }
}

function autoMergePollMs(): number {
  const raw = process.env.RAFI_AUTO_MERGE_POLL_MS;
  if (!raw) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function observeNode<T>(opts: BranchRunnerOptions, node: BranchPlanNode, kind: string, name: string, operation: () => Promise<T> | T): Promise<T> {
  if (!opts.observer) return Promise.resolve().then(operation);
  return opts.observer.withContext({ role: "host", stream: kind, ticketId: node.ticket.id, deliveryUnitId: node.deliveryUnitId },
    () => opts.observer!.span(kind, name, operation));
}

function canonical(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

function notifyIssue(enabled: boolean, message: string): void {
  if (enabled) fireNotification("Foreman branch issue", message);
}

function blockBranchIssue(
  opts: BranchRunnerOptions,
  node: BranchPlanNode,
  summary: BranchRunSummary,
  code: GitHubFailureCode,
  message: string,
  details?: Pick<PrResult, "repairCommands" | "command" | "output">,
): void {
  summary.buildStatus = "blocked";
  summary.detail = message;
  opts.log.write("branch-issue", {
    ticket: node.ticket.id,
    code,
    message,
    blocking: false,
    repairCommands: details?.repairCommands,
    command: details?.command,
    output: details?.output,
  });
  notifyIssue(opts.notificationsEnabled, `${node.ticket.id}: ${message}`);
  journalTracker(opts.projectDir, opts.runId, `${opts.runId}:tracker-update:${node.ticket.id}:remote-block`, { ticket: node.ticket.id, status: "blocked", detail: message }, () => cmdBlock(opts.projectDir, node.ticket.id, { summary: message, actor: "foreman" }));
}

function failureLogFields(node: BranchPlanNode, pr: PrResult): Record<string, unknown> {
  return {
    ticket: node.ticket.id,
    branch: node.branch,
    code: pr.code ?? "pr_create_failed",
    message: pr.message ?? pr.error ?? "unknown error",
    error: pr.error,
    repairCommands: pr.repairCommands,
    command: pr.command,
    output: pr.output,
  };
}

export function buildBranchTicketInstruction(
  node: BranchPlanNode,
  trackerPaths: { progressDoc?: string; archiveDoc?: string } = {},
): string {
  const progressDoc = trackerPaths.progressDoc ?? "docs/ticket-progress.md";
  return `Implement exactly this ticket in the current branch/worktree:

${node.ticket.id}: ${node.ticket.title}

Summary:
${node.ticket.summary}

Acceptance criteria:
${node.ticket.acceptance.map((item) => `- ${item}`).join("\n")}

Required tests:
${node.ticket.required_tests.map((item) => `- ${item}`).join("\n")}

Likely files:
${node.ticket.likely_files.length ? node.ticket.likely_files.map((item) => `- ${item}`).join("\n") : "- Unknown"}

Branch-mode rules:
- Implement only ${node.ticket.id}.
- Do not switch branches.
- Do not push, create PRs, or run git commit.
- Do not edit .tickets/, ${progressDoc}, or other tracker state.
- If another selected ticket is required before this one can be completed, stop and end with STEP_STATUS: blocked | ticket="${node.ticket.id}" branch_dependency="<ticket-id>" reason="<why>".
- End with STEP_STATUS: done | ticket="${node.ticket.id}" summary="<what changed>" when the ticket is implemented.

QA will happen in this same builder session after implementation.

${MARKER_SPEC}`;
}

export function buildBranchTicketResumeInstruction(
  node: BranchPlanNode,
  trackerPaths: { progressDoc?: string; archiveDoc?: string } = {},
): string {
  const progressDoc = trackerPaths.progressDoc ?? "docs/ticket-progress.md";
  return `Continue the existing builder session for this ticket in the current branch/worktree:

${node.ticket.id}: ${node.ticket.title}

Resume from the current repository state. Inspect the worktree if needed, then finish only this ticket.

Branch-mode rules:
- Implement only ${node.ticket.id}.
- Do not switch branches.
- Do not push, create PRs, or run git commit.
- Do not edit .tickets/, ${progressDoc}, or other tracker state.
- If another selected ticket is required before this one can be completed, stop and end with STEP_STATUS: blocked | ticket="${node.ticket.id}" branch_dependency="<ticket-id>" reason="<why>".
- End with STEP_STATUS: done | ticket="${node.ticket.id}" summary="<what changed>" when the ticket is implemented.

QA will happen in this same builder session after implementation.

${MARKER_SPEC}`;
}

function summaryFor(
  node: BranchPlanNode,
  buildStatus: BranchRunSummary["buildStatus"],
  detail?: string,
  pushStatus?: BranchRunSummary["pushStatus"],
): BranchRunSummary {
  return {
    ticket: node.ticket.id,
    branch: node.branch,
    base: node.baseBranch,
    buildStatus,
    pushStatus,
    detail,
  };
}

function orderNodes(nodes: BranchPlanNode[]): BranchPlanNode[] {
  const byId = new Map(nodes.map((node) => [node.ticket.id, node]));
  const out: BranchPlanNode[] = [];
  const seen = new Set<string>();

  function visit(node: BranchPlanNode): void {
    if (seen.has(node.ticket.id)) return;
    for (const dep of node.dependencies) {
      const depNode = byId.get(dep);
      if (depNode) visit(depNode);
    }
    seen.add(node.ticket.id);
    out.push(node);
  }

  for (const node of nodes) visit(node);
  return out;
}
