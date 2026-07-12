import type { BuilderAdapter, EffortLevel } from "../adapters/types.js";
import { Foreman, MARKER_SPEC } from "../foreman.js";
import type { Log } from "../log.js";
import { fireNotification } from "../notify.js";
import { cmdBlock, cmdComplete, cmdUpdate } from "../tickets/commands.js";
import type { BranchPlan, BranchPlanNode, BranchRunSummary, GitHubFailureCode, PrResult } from "./types.js";
import {
  commitAll,
  createTicketWorktree,
  currentWorktreeBranch,
  ensureCleanBaseWorktree,
  ensureForemanExcluded,
  hasTrackerChanges,
  hasWorktreeChanges,
  headCommitIfAhead,
  removeTicketWorktree,
} from "./git.js";
import { createOrReusePr, pushBranchForPr } from "./github.js";

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
  qaEnabled: boolean;
  createPr: boolean;
  prReady: boolean;
  keepWorktrees: boolean;
  allowedBaseDirtyPaths?: string[];
  trackerPaths?: { progressDoc: string; archiveDoc: string };
  resumeSessions?: Map<string, { worktreePath: string; sessionId: string }>;
  createBuilder: (cwd: string, sessionId?: string) => Promise<BuilderAdapter>;
  observeBuilder?: (builder: BuilderAdapter) => Promise<void>;
}

export async function runBranchPlan(opts: BranchRunnerOptions): Promise<BranchRunSummary[]> {
  ensureCleanBaseWorktree(opts.projectDir, { allowedDirtyPaths: opts.allowedBaseDirtyPaths });
  ensureForemanExcluded(opts.projectDir);

  const summaries: BranchRunSummary[] = [];
  const successfulBranches = new Set<string>();
  const pushedBranches = new Set<string>();

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

    if (opts.createPr) {
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

    opts.log.write("branch-start", {
      ticket: node.ticket.id,
      branch: node.branch,
      base: node.baseBranch,
      dependencies: node.dependencies,
    });

    const resumeSession = opts.resumeSessions?.get(node.ticket.id);
    const worktreePath = resumeSession?.worktreePath
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
        });
      }

      cmdUpdate(opts.projectDir, node.ticket.id, {
        status: "in_progress",
        actor: "foreman",
        summary: resumeSession ? `Resuming branch ${node.branch}` : `Starting branch ${node.branch}`,
      });

      builder = await opts.createBuilder(worktreePath, resumeSession?.sessionId);
      viewer = opts.observeBuilder?.(builder);
      const foreman = new Foreman(
        builder,
        opts.log,
        opts.notificationsEnabled,
        opts.qaEnabled,
        3,
        undefined,
      );

      const { result, status } = await foreman.runInstruction(
        resumeSession ? buildBranchTicketResumeInstruction(node, opts.trackerPaths) : buildBranchTicketInstruction(node, opts.trackerPaths),
      );
      const sessionId = builder.sessionId();
      if (sessionId) {
        opts.log.write("branch-session", {
          ticket: node.ticket.id,
          branch: node.branch,
          base: node.baseBranch,
          worktreePath,
          sessionId,
          agent: opts.agent,
          model: opts.model,
          effort: opts.effort,
          fast: opts.fast,
          qaEnabled: opts.qaEnabled,
          createPr: opts.createPr,
          prReady: opts.prReady,
          keepWorktrees: opts.keepWorktrees,
        });
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
        cmdBlock(opts.projectDir, node.ticket.id, { summary: detail, actor: "foreman" });
        summaries.push(summaryFor(node, status.kind === "blocked" ? "blocked" : "needs-human", detail));
        continue;
      }

      let qaSummary: string | undefined;
      if (opts.qaEnabled) {
        const qa = await foreman.runQaReview(summaries.length + 1);
        if (qa.outcome !== "passed") {
          const detail = qa.detail ?? "QA did not pass";
          cmdBlock(opts.projectDir, node.ticket.id, { summary: detail, actor: "foreman" });
          summaries.push(summaryFor(node, qa.outcome === "blocked" ? "blocked" : "needs-human", detail));
          continue;
        }
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
        commit = commitAll(worktreePath, `${node.ticket.id}: ${node.ticket.title}`);
      }
      if (!commit && opts.createPr) {
        commit = headCommitIfAhead(worktreePath, node.baseBranch);
      }

      const summary = summaryFor(node, "done", commit ? undefined : "no_changes");
      summary.commit = commit;

      if (commit && opts.createPr) {
        const push = pushBranchForPr(worktreePath, node.branch);
        if (push.ok) {
          opts.log.write("branch-push", { ticket: node.ticket.id, branch: node.branch, status: "pushed" });
          summary.pushStatus = "pushed";
        } else {
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
        const pr = createOrReusePr(opts.projectDir, {
          node,
          ready: opts.prReady,
          runId: opts.runId,
          qaEvidence: qaSummary,
          commit,
        });
        summary.pr = pr;
        if (pr.status === "created") opts.log.write("pr-created", { ticket: node.ticket.id, branch: node.branch, url: pr.url });
        if (pr.status === "existing") opts.log.write("pr-existing", { ticket: node.ticket.id, branch: node.branch, url: pr.url });
        if (pr.status === "failed") {
          opts.log.write("pr-failed", failureLogFields(node, pr));
          blockBranchIssue(
            opts,
            node,
            summary,
            pr.code ?? "pr_create_failed",
            `PR creation failed: ${pr.message ?? pr.error ?? "unknown error"}`,
            pr,
          );
          summaries.push(summary);
          continue;
        }
      } else if (opts.createPr) {
        summary.pushStatus = "skipped";
        summary.pr = { status: "skipped", error: commit ? undefined : "no_changes" };
      }

      cmdComplete(opts.projectDir, node.ticket.id, {
        actor: "foreman",
        summary: status.summary ?? `Completed ${node.ticket.id}`,
        validationResult: opts.qaEnabled ? "passed" : "not_applicable",
        validationNotes: opts.qaEnabled ? "Foreman QA emitted qa_pass" : "Foreman QA disabled for this run",
        evidence: opts.qaEnabled ? (qaSummary ?? "Foreman QA emitted qa_pass") : undefined,
      });

      successfulBranches.add(node.ticket.id);
      summaries.push(summary);
      opts.log.write("branch-complete", {
        ticket: node.ticket.id,
        branch: node.branch,
        commit,
        status: "done",
        detail: summary.detail,
      });

      if (!opts.keepWorktrees) removeTicketWorktree(opts.projectDir, worktreePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code: "branch_switch" | "tracker_touched" | "builder_error" = message.includes("switched branch")
        ? "branch_switch"
        : message.includes("tracker/control")
        ? "tracker_touched"
        : "builder_error";
      opts.log.write("branch-issue", { ticket: node.ticket.id, code, message, blocking: false });
      notifyIssue(opts.notificationsEnabled, `${node.ticket.id}: ${message}`);
      cmdBlock(opts.projectDir, node.ticket.id, { summary: message, actor: "foreman" });
      summaries.push(summaryFor(node, "blocked", message));
    } finally {
      await builder?.close().catch(() => {});
      await viewer?.catch(() => {});
    }
  }

  return summaries;
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
  cmdBlock(opts.projectDir, node.ticket.id, { summary: message, actor: "foreman" });
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
