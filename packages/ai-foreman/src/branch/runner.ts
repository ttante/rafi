import type { BuilderAdapter, EffortLevel } from "../adapters/types.js";
import type { ProviderSessionRefV1, SessionStrategy } from "rafi-spec";
import { buildDurableQaFixHandoff, compactWithRetry, runIsolatedQa, type QaNonconvergenceContext, type QaNonconvergenceDecision, type QaStreamState } from "../qaReview.js";
import { changeManifestAsync } from "../qaSnapshot.js";
import { Foreman, MARKER_SPEC, parseStepStatus } from "../foreman.js";
import type { Log } from "../log.js";
import { fireNotification } from "../notify.js";
import { cmdBlock, cmdComplete, cmdUnblock, cmdUpdate } from "../tickets/commands.js";
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
  mergeBranchToLocalBase,
} from "./git.js";
import { checkGitHubPrMerged, createOrReusePr, enableGitHubAutoMerge, pushBranchForPr } from "./github.js";
import { checkGitLabMrMerged, createOrReuseMr, enableGitLabAutoMerge, pushBranchForMr } from "./gitlab.js";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkflowDb } from "../workflowDb.js";
import { currentActivity, withActivityPhase } from "../activity.js";
import { SessionUnavailableError } from "../adapters/sessionFailure.js";
import { SessionUnavailableContinuityError } from "../continuity.js";

export interface DeliveryUnitSession { unitId: string; branch: string; worktreePath: string; sessionId: string; sessionRef?: ProviderSessionRefV1; ticket: string; }
export type BaseWorktreePolicy = "enforce" | "warn" | "skip";

export function readDeliveryUnitSession(projectDir: string, unitId: string): DeliveryUnitSession | undefined {
  const path = deliverySessionPath(projectDir, unitId);
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as DeliveryUnitSession; } catch { return undefined; }
}

function deliverySessionPath(projectDir: string, unitId: string): string {
  return join(projectDir, ".foreman", "delivery-sessions", `${unitId}.json`);
}

export interface BranchRunnerOptions {
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
  createQa?: (cwd: string, sessionId?: string) => Promise<BuilderAdapter>;
  builderSessionStrategy?: SessionStrategy;
  qaSessionStrategy?: SessionStrategy;
  observeBuilder?: (builder: BuilderAdapter) => Promise<void>;
  observeBuilderNativeCompactions?: (builder: BuilderAdapter, cwd: string) => Promise<void>;
  observeQaNativeCompactions?: (adapter: BuilderAdapter) => Promise<void>;
  qaNonconvergence?: (context: QaNonconvergenceContext) => Promise<QaNonconvergenceDecision>;
  beforeBuilderTurn?: (adapter: BuilderAdapter, frozenAction: string, cwd: string) => Promise<BuilderAdapter>;
  builderSessionBoundary?: (adapter: BuilderAdapter, frozenAction: string, strategy: SessionStrategy, cwd: string) => Promise<BuilderAdapter>;
  qaSessionBoundary?: (adapter: BuilderAdapter, frozenAction: string, strategy: SessionStrategy, cwd: string) => Promise<BuilderAdapter>;
}

export async function runBranchPlan(opts: BranchRunnerOptions): Promise<BranchRunSummary[]> {
  const baseWorktreePolicy = opts.baseWorktreePolicy ?? "enforce";
  if (baseWorktreePolicy !== "skip") {
    try {
      ensureCleanBaseWorktree(opts.projectDir, { allowedDirtyPaths: opts.allowedBaseDirtyPaths });
    } catch (error) {
      if (baseWorktreePolicy === "warn") {
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

  for (const node of orderNodes(opts.plan.nodes)) {
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

    opts.log.write("branch-start", {
      ticket: node.ticket.id,
      branch: node.branch,
      base: node.baseBranch,
      dependencies: node.dependencies,
    });
    workflowCheckpoint(opts.projectDir, opts.runId, "builder-before", node.ticket.id, { branch: node.branch, worktree: node.worktreePath });

    const resumeSession = opts.resumeSessions?.get(node.ticket.id);
    const worktreePath = resumeSession?.worktreePath
      ?? (sharedUnit ? findWorktreeForBranch(opts.projectDir, node.branch) : undefined)
      ?? createTicketWorktree(opts.projectDir, opts.runId, node.branch, node.baseBranch);
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

      journalTracker(opts.projectDir, opts.runId, `${opts.runId}:tracker-update:${node.ticket.id}:in-progress`, { ticket: node.ticket.id, status: "in_progress" }, () => {
        if (resumeSession) cmdUnblock(opts.projectDir, node.ticket.id, { actor: "foreman", summary: `Reopened by explicit branch recovery for ${node.branch}` });
        cmdUpdate(opts.projectDir, node.ticket.id, {
          status: "in_progress", actor: "foreman",
          summary: resumeSession ? `Resuming branch ${node.branch}` : `Starting branch ${node.branch}`,
        });
      });

      const ticketInstruction = resumeSession ? buildBranchTicketResumeInstruction(node, opts.trackerPaths) : buildBranchTicketInstruction(node, opts.trackerPaths);
      // Reattach the predecessor even for a `fresh` strategy so the host can
      // publish and validate a cumulative handoff before creating its successor.
      const sameWorktreeStream = builderStream && canonical(builderStream.worktreePath) === canonical(worktreePath) ? builderStream : undefined;
      const continuedBuilderSession = resumeSession?.sessionId ?? sameWorktreeStream?.sessionId;
      const continuedBuilderRef = resumeSession?.sessionRef ?? sameWorktreeStream?.sessionRef;
      builder = await opts.createBuilder(worktreePath, continuedBuilderSession, continuedBuilderRef);
      if (builderWorkSessions > 0 && continuedBuilderSession) {
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
      builderWorkSessions += 1;
      viewer = opts.observeBuilder?.(builder);
      const foreman = new Foreman(
        builder,
        opts.log,
        { desktop: opts.notificationsEnabled, terminalBell: opts.terminalBellEnabled ?? true },
        opts.qaEnabled,
        3,
        undefined,
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
      );

      const { result, status } = await foreman.runInstruction(ticketInstruction);
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
        opts.log.write("branch-session", {
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
        });
        if (node.deliveryUnitId) {
          const path = deliverySessionPath(opts.projectDir, node.deliveryUnitId);
          mkdirSync(join(opts.projectDir, ".foreman", "delivery-sessions"), { recursive: true });
          writeFileSync(path, `${JSON.stringify({ unitId: node.deliveryUnitId, branch: node.branch, worktreePath, sessionId, sessionRef: builder.sessionRef?.(), ticket: node.ticket.id }, null, 2)}\n`, "utf8");
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
        journalTracker(opts.projectDir, opts.runId, `${opts.runId}:tracker-update:${node.ticket.id}:builder-block`, { ticket: node.ticket.id, status: "blocked", detail }, () => cmdBlock(opts.projectDir, node.ticket.id, { summary: detail, actor: "foreman" }));
        summaries.push(summaryFor(node, status.kind === "blocked" ? "blocked" : "needs-human", detail));
        continue;
      }

      let qaSummary: string | undefined;
      let qaWaived = false;
      if (opts.qaEnabled) {
        if (!opts.createQa) throw new Error("independent disposable QA factory is required when QA is enabled");
        workflowCheckpoint(opts.projectDir, opts.runId, "qa-before", node.ticket.id, { worktree: worktreePath });
        const qa = await runIsolatedQa({
          ticket: node.ticket, builderWorktree: worktreePath, builderSummary: status.summary ?? result.text,
          qaStrategy: opts.qaSessionStrategy ?? "compact", state: qaStream, createQa: opts.createQa, maxCycles: 3,
          sessionBoundary: opts.qaSessionBoundary,
          observeNativeCompactions: opts.observeQaNativeCompactions,
          resolveBlocked: (adapter, reason) => foreman.resolveBlocker(adapter, reason),
          evidence: (entry) => opts.log.write("qa-evidence", { ticket: node.ticket.id, ...entry }),
          fix: async (issues) => {
            if (!builder) return { ok: false, detail: "Builder session unavailable" };
            builderWorkSessions += 1;
            const digest = (await withActivityPhase("recording QA fix changes", () => changeManifestAsync(
              worktreePath,
              (state, detail) => currentActivity()?.update(state, detail),
              "recording QA fix changes",
            ))).diffDigest;
            const fixInstruction = buildDurableQaFixHandoff(node.ticket, issues, worktreePath, result.text, digest);
            const strategy = opts.builderSessionStrategy ?? "compact";
            if (opts.builderSessionBoundary) {
              builder = await opts.builderSessionBoundary(builder, fixInstruction, strategy, worktreePath);
            } else if (strategy === "compact" && builder.sessionId()) {
              const compacted = await compactWithRetry(builder);
              if (!compacted.ok) { await builder.close(); builder = await opts.createBuilder(worktreePath); }
            } else if (strategy === "fresh") {
              await builder.close(); builder = await opts.createBuilder(worktreePath);
            }
            if (opts.beforeBuilderTurn) builder = await opts.beforeBuilderTurn(builder, fixInstruction, worktreePath);
            let fixed = await builder.sendTurn(fixInstruction);
            let fixedStatus = parseStepStatus(fixed.text);
            if (!fixed.isError && fixedStatus.kind === "blocked") {
              const resolved = await foreman.resolveBlocker(builder, fixedStatus.reason ?? "Builder QA fix reported an unspecified blocker");
              fixed = resolved.result;
              fixedStatus = resolved.status;
            }
            const fixedSessionId = builder.sessionId();
            const fixedSessionRef = builder.sessionRef?.();
            if (fixedSessionId) builderStream = { sessionId: fixedSessionId, ...(fixedSessionRef ? { sessionRef: fixedSessionRef } : {}), worktreePath };
            if (fixedSessionId) {
              opts.recordBuilderSession?.(fixedSessionRef ?? fixedSessionId, node.ticket.id, worktreePath);
              workflowCheckpoint(opts.projectDir, opts.runId, "builder-session-scoped", node.ticket.id, { sessionId: fixedSessionId, sessionRef: fixedSessionRef, worktree: worktreePath, branch: node.branch });
            }
            return { ok: !fixed.isError && fixedStatus.kind === "done", detail: fixedStatus.error ?? fixed.text.slice(0, 500) };
          },
          onNonconvergence: opts.qaNonconvergence,
        });
        if (qaStream.sessionId) opts.recordQaSession?.(qaStream.sessionRef ?? qaStream.sessionId, node.ticket.id, worktreePath);
        workflowCheckpoint(opts.projectDir, opts.runId, "qa-after", node.ticket.id, { outcome: qa.outcome, detail: qa.detail });
        if (qa.outcome !== "passed" && qa.outcome !== "waived") {
          const detail = qa.detail ?? "QA did not pass";
          journalTracker(opts.projectDir, opts.runId, `${opts.runId}:tracker-update:${node.ticket.id}:qa-block`, { ticket: node.ticket.id, status: "blocked", detail }, () => cmdBlock(opts.projectDir, node.ticket.id, { summary: detail, actor: "foreman" }));
          summaries.push(summaryFor(node, qa.outcome === "blocked" ? "blocked" : "needs-human", detail)); continue;
        }
        qaWaived = qa.outcome === "waived";
        qaSummary = qa.summary;
      } else {
        opts.log.write("qa", {
          stepIndex: summaries.length + 1,
          cycle: 0,
          statusKind: "qa_pass",
          issues: undefined,
          costUsd: 0,
          isError: false,
        });
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
        workflowCheckpoint(opts.projectDir, opts.runId, "commit-before", node.ticket.id, { branch: node.branch });
        const operation = `${opts.runId}:commit:${node.ticket.id}`;
        planJournal(opts.projectDir, opts.runId, operation, "commit", { ticket: node.ticket.id, branch: node.branch, worktreePath });
        try { commit = commitAll(worktreePath, `${node.ticket.id}: ${node.ticket.title}`); confirmJournal(opts.projectDir, operation, commit, { sha: commit }); workflowCheckpoint(opts.projectDir, opts.runId, "commit-after", node.ticket.id, { sha: commit }); }
        catch (error) { failJournal(opts.projectDir, operation, error, false); throw error; }
      }
      if (!commit && (createsReviewForNode || (completionMode === "direct-merge" && completesSharedUnit))) {
        commit = headCommitIfAhead(worktreePath, node.baseBranch);
      }

      const summary = summaryFor(node, "done", commit ? undefined : "no_changes");
      summary.commit = commit;

      if (commit && createsReviewForNode) {
        workflowCheckpoint(opts.projectDir, opts.runId, "push-before", node.ticket.id, { branch: node.branch, sha: commit });
        const pushOperation = `${opts.runId}:push:${node.branch}`;
        planJournal(opts.projectDir, opts.runId, pushOperation, "push", { branch: node.branch, sha: commit, remote: "origin" });
        const push = await withActivityPhase(`pushing ${node.branch}`, async () => {
          currentActivity()?.update(`pushing ${node.branch}`, `publishing ${node.ticket.id}`);
          return reviewProvider === "gitlab"
            ? pushBranchForMr(worktreePath, node.branch)
            : pushBranchForPr(worktreePath, node.branch);
        });
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
        const pr = await withActivityPhase(`creating ${reviewProvider === "gitlab" ? "merge request" : "pull request"}`, async () => {
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
        });
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
          const autoMerge = await withActivityPhase("enabling GitHub auto-merge", async () => {
            currentActivity()?.update("enabling GitHub auto-merge", node.branch);
            return enableGitHubAutoMerge(opts.projectDir, node.branch, opts.cleanupBranches ?? true, opts.mergeMethod ?? "squash");
          });
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
          const autoMerge = await withActivityPhase("enabling GitLab auto-merge", async () => {
            currentActivity()?.update("enabling GitLab auto-merge", node.branch);
            return enableGitLabAutoMerge(opts.projectDir, node.branch, opts.cleanupBranches ?? true, opts.mergeMethod ?? "squash");
          });
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
        if (!opts.keepWorktrees) removeTicketWorktree(opts.projectDir, worktreePath);
        const mergeCommit = mergeBranchToLocalBase(
          opts.projectDir,
          node.branch,
          node.baseBranch,
          `${node.ticket.id}: ${node.ticket.title}`,
          opts.mergeMethod ?? "squash",
        );
        summary.pr = { status: "merged", url: mergeCommit };
        opts.log.write("branch-direct-merge", {
          ticket: node.ticket.id,
          branch: node.branch,
          base: node.baseBranch,
          commit: mergeCommit,
        });
        if (opts.cleanupBranches ?? true) deleteLocalBranch(opts.projectDir, node.branch);
      }

      const completionOperation = `${opts.runId}:ticket-complete:${node.ticket.id}`;
      workflowCheckpoint(opts.projectDir, opts.runId, "ticket-completion-before", node.ticket.id, { validationResult: qaWaived ? "failed" : opts.qaEnabled ? "passed" : "not_applicable" });
      planJournal(opts.projectDir, opts.runId, completionOperation, "ticket-complete", { ticket: node.ticket.id });
      cmdComplete(opts.projectDir, node.ticket.id, {
        actor: "foreman",
        summary: status.summary ?? `Completed ${node.ticket.id}`,
        validationResult: qaWaived ? "failed" : opts.qaEnabled ? "passed" : "not_applicable",
        validationNotes: qaWaived ? "User explicitly waived unresolved QA failures" : opts.qaEnabled ? "Foreman QA emitted qa_pass" : "Foreman QA disabled for this run",
        evidence: opts.qaEnabled ? (qaSummary ?? (qaWaived ? "Unresolved QA issues preserved in run evidence" : "Foreman QA emitted qa_pass")) : undefined,
      });
      confirmJournal(opts.projectDir, completionOperation, node.ticket.id, { status: "done" });
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

      if (node.deliveryUnitId && node.deliveryUnitFinal) rmSync(deliverySessionPath(opts.projectDir, node.deliveryUnitId), { force: true });

      if (!opts.keepWorktrees && completionMode !== "direct-merge" && completesSharedUnit) removeTicketWorktree(opts.projectDir, worktreePath);
    } catch (err) {
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
      journalTracker(opts.projectDir, opts.runId, `${opts.runId}:tracker-update:${node.ticket.id}:runtime-block`, { ticket: node.ticket.id, status: "blocked", detail: message }, () => cmdBlock(opts.projectDir, node.ticket.id, { summary: message, actor: "foreman" }));
      summaries.push(summaryFor(node, "blocked", message));
    } finally {
      await builder?.close().catch(() => {});
      await viewer?.catch(() => {});
    }
  }

  return summaries;
}

function planJournal(projectDir: string, runId: string, key: string, kind: string, intent: unknown): void {
  const db = new WorkflowDb(projectDir); try { if (!db.getRun(runId)) db.createRun({ runId, kind: "build", originalWork: {}, state: {} }); db.planOperation({ runId, idempotencyKey: key, kind, intent }); db.updateOperation(key, "in_progress"); } finally { db.close(); }
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

  while (true) {
    const pending: string[] = [];
    for (const dep of dependencyNodes) {
      const status = provider === "gitlab"
        ? checkGitLabMrMerged(opts.projectDir, dep.branch)
        : checkGitHubPrMerged(opts.projectDir, dep.branch);
      if (!status.ok) {
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
    if (deadline !== null && Date.now() >= deadline) {
      return {
        ok: false,
        code: "dependency_unavailable",
        message: `${message}; timed out waiting for dependency merge`,
      };
    }

    opts.log.write("branch-auto-merge-wait", {
      ticket: node.ticket.id,
      pending,
      timeoutMinutes: opts.autoMergeTimeoutMinutes ?? null,
    });
    await sleep(autoMergePollMs());
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
