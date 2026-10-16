import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import { bindBuildAuthority, checkpointBuildRun, projectBuildRecovery, recoverableBuildRuns, readBuildRuns } from "ai-foreman/build-runs.js";
import { retireBuildExecutionForStartOver } from "ai-foreman/build-assignment.js";
import { previewTicketReset, resetTickets } from "ai-foreman/ticket-reset.js";
import { WorkflowDb, type ProjectLease, type WorkflowRunSnapshot } from "ai-foreman/workflow-db.js";
import type { BuildRunRecordV2 } from "rafi-spec";
import { assertLifecycleForCommand } from "./lifecycle.js";
import { readInstallManifest } from "./ownership.js";
import { ticketOwnershipReceipts } from "ai-foreman/cli/tickets.js";
import type { RecoveryOutcome } from "./startRecovery.js";

export type StartOverAction = "restart-current" | "archive-restart" | "archive-new-branch" | "new-branch" | "retain-merged" | "revert-branch" | "manual" | "cancel";
export interface StartOverInventory {
  run: BuildRunRecordV2 & { active: boolean };
  worktree: string;
  branch?: string;
  head?: string;
  baseline?: string;
  baseRef?: string;
  dirtyPaths: string[];
  sourceDigest?: string;
  unexpectedPaths: string[];
  pushed: boolean;
  openReview?: string;
  merged: boolean;
  baselineComplete: boolean;
  recommended: StartOverAction;
  choices: StartOverAction[];
}
export interface StartOverGitResult { archiveBranch?: string; restartBranch?: string; revertBranch?: string }

export function inventoryBuildStartOver(projectDir: string, run: BuildRunRecordV2 & { active: boolean }): StartOverInventory {
  const projection = projectBuildRecovery(projectDir, run);
  const worktree = projection.worktree;
  const branch = gitValue(worktree, ["branch", "--show-current"]) ?? projection.branch ?? run.repository.git.branch ?? run.repository.branch;
  const head = gitValue(worktree, ["rev-parse", "HEAD"]);
  const baseline = run.repository.git.baselineHead ?? run.repository.baseHead;
  const baseRef = run.repository.git.baseRef ?? detectCurrentBaseRef(worktree, branch);
  const gitRepository = gitValue(worktree, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const dirtyPaths = gitRepository ? gitStatusPaths(worktree) : [];
  const sourceDigest = gitRepository ? startOverSourceDigest(worktree) : undefined;
  // Older inventories collapse untracked directories; current inventories
  // enumerate their files so owned artifacts cannot hide unrelated documents.
  const matches = (paths: string[], path: string) => paths.some(prior => prior === path || (prior.endsWith("/") && path.startsWith(prior)));
  let unexpectedPaths = dirtyPaths.filter((path) => matches(run.repository.git.initialStatusPaths, path) || (run.repository.git.runOwnedPaths.length > 0 && !matches(run.repository.git.runOwnedPaths, path)));
  const pushed = Boolean(run.repository.git.upstream || (branch && gitValue(worktree, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`])));
  const openReview = branch ? detectOpenReview(worktree, branch) : undefined;
  // Uncommitted work cannot remain attached to the protected original branch
  // while switching a pushed/reviewed run to a clean restart branch.
  if ((pushed || openReview) && dirtyPaths.length) unexpectedPaths = [...new Set([...unexpectedPaths, ...dirtyPaths])].sort();
  const merged = Boolean(branch && baseRef && branch !== baseRef && gitOk(worktree, ["merge-base", "--is-ancestor", branch, baseRef]));
  const baselineComplete = Boolean(run.repository.baselineComplete && baseline && branch && head);
  if (!baselineComplete) {
    const choices: StartOverAction[] = baseRef
      ? ["restart-current", "archive-new-branch", "new-branch", "manual", "cancel"]
      : ["restart-current", "manual", "cancel"];
    return { run, worktree, branch, head, baseline, baseRef, dirtyPaths, sourceDigest, unexpectedPaths, pushed, openReview, merged, baselineComplete, recommended: "restart-current", choices };
  }
  if (merged) return { run, worktree, branch, head, baseline, baseRef, dirtyPaths, sourceDigest, unexpectedPaths, pushed, openReview, merged, baselineComplete, recommended: "restart-current", choices: ["restart-current", "retain-merged", "revert-branch", "manual", "cancel"] };
  if (pushed || openReview) return { run, worktree, branch, head, baseline, baseRef, dirtyPaths, sourceDigest, unexpectedPaths, pushed, openReview, merged, baselineComplete, recommended: "restart-current", choices: ["restart-current", "new-branch", "manual", "cancel"] };
  return { run, worktree, branch, head, baseline, baseRef, dirtyPaths, sourceDigest, unexpectedPaths, pushed, openReview, merged, baselineComplete, recommended: "restart-current", choices: ["restart-current", "archive-restart", "manual", "cancel"] };
}

export function buildBuildStartOverCommand(faults: { afterSupersession?: () => void; onOutcome?: (outcome: RecoveryOutcome) => void } = {}): Command {
  return new Command("build:start-over")
    .description("Safely preserve an implementation run, reconcile its tracker state, and prepare a fresh restart.")
    .argument("[project]", "project directory", ".")
    .option("--run <id>", "run ID or unique prefix")
    .option("--action <action>", "restart-current (keep files and branch) | archive-restart | archive-new-branch | new-branch | retain-merged | revert-branch | manual | cancel")
    .option("--tickets <ids>", "explicit comma-separated run tickets to reset (restart-current defaults to unfinished tickets)")
    .option("--cleanup <choice>", "stash | discard | handled (for unexpected working-tree changes)")
    .option("--yes", "confirm the preview and selected action")
    .option("--second-confirm", "acknowledge duplicate-work risk for --action retain-merged")
    .option("--inspect", "show inventory and choices without mutation")
    .action(async (project: string, opts: { run?: string; action?: string; yes?: boolean; secondConfirm?: boolean; inspect?: boolean; tickets?: string; cleanup?: string }) => {
      faults.onOutcome?.("cancelled");
      const root = resolve(project);
      if (opts.cleanup && !["stash", "discard", "handled"].includes(opts.cleanup)) throw new Error("--cleanup must be stash, discard, or handled");
      const runs = recoverableBuildRuns(root);
      // A crash after supersession but before the operation's final receipt
      // must still be resumable, even though the original run is now terminal.
      const recovery = new WorkflowDb(root);
      try {
        for (const pending of recovery.resumableRuns("recovery").filter(item => item.state.operation === "build-start-over")) {
          const id = (pending.originalWork as StartOverInventory).run?.runId;
          const original = readBuildRuns(root).find(item => item.runId === id && item.status === "superseded" && item.supersededBy === pending.runId);
          if (original && !runs.some(item => item.runId === original.runId)) runs.push({ ...original, active: false, ownership: "dead", ownershipReason: "original run superseded by this pending start-over" });
        }
      } finally { recovery.close(); }
      let run = selectRun(runs, opts.run);
      if (!run) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("provide --run <id> outside an interactive terminal");
        const { select, isCancel } = await import("@clack/prompts");
        const answer = await select({ message: "Which build should start over?", options: runs.map((candidate) => ({ value: candidate.runId, label: `${candidate.runId.slice(0, 8)} — ${candidate.currentTicket ?? candidate.tickets[0] ?? "legacy run"} — ${candidate.status}` })) });
        if (isCancel(answer)) return;
        run = runs.find((candidate) => candidate.runId === answer);
      }
      if (!run) throw new Error("recoverable build run not found");
      const pending = findPendingStartOver(root, run.runId);
      if (!pending) assertLifecycleForCommand(root, "build-start-over");
      let inventory = pending ? pendingInventory(pending) : inventoryBuildStartOver(root, run);
      printInventory(inventory);
      if (pending) console.log(`  resuming preserved start-over operation ${pending.runId} at ${pending.checkpoint}`);
      if (run.active) throw new Error("the original build process is verified live; stop it before starting over");
      if (recoverableBuildRuns(root).find(item => item.runId === run!.runId)?.ownership === "unknown") throw new Error("Build ownership is unknown; reconcile it before starting over");
      if (opts.inspect) return;
      const pendingAction = pending ? ((pending.remainingWork as { action?: StartOverAction }).action) : undefined;
      let action = opts.action as StartOverAction | undefined;
      if (pendingAction && action && action !== pendingAction) throw new Error(`start-over operation ${pending?.runId ?? "pending"} already recorded action ${pendingAction}; resume with that action`);
      action ??= pendingAction;
      if (action && !inventory.choices.includes(action)) throw new Error(`action ${action} is unsafe for this run; available choices: ${inventory.choices.join(", ")}`);
      if (!action) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("provide --action and --yes outside an interactive terminal");
        const { select, isCancel } = await import("@clack/prompts");
        const answer = await select({ message: "How should Rafi preserve and restart this run?", options: inventory.choices.map((choice) => ({ value: choice, label: actionLabel(choice, choice === inventory.recommended) })) });
        if (isCancel(answer)) return;
        action = answer as StartOverAction;
      }
      if (action === "cancel") { console.log("rafi build:start-over: cancelled; nothing changed"); return; }
      if (action === "manual") { faults.onOutcome?.("paused"); printManual(inventory); return; }
      if (opts.tickets && action !== "restart-current") throw new Error("--tickets is available only with restart-current; Git rollback actions reset the whole saved run");
      if (inventory.unexpectedPaths.length && action !== "archive-new-branch" && action !== "restart-current") {
        const cleaned = await resolveStartOverCleanup(inventory, opts.cleanup);
        if (!cleaned) { faults.onOutcome?.("paused"); return; }
        const originalBranch = inventory.branch;
        inventory = inventoryBuildStartOver(root, run);
        if (inventory.branch !== originalBranch) throw new Error("Working branch changed during cleanup; return to the inspected branch and retry. Nothing was reset.");
        if (!inventory.choices.includes(action)) throw new Error(`Repository state changed during cleanup; ${action} is no longer safe. Available choices: ${inventory.choices.join(", ")}`);
        if (inventory.unexpectedPaths.length) { faults.onOutcome?.("paused"); printCleanupGuidance(inventory); return; }
      }
      const pendingTickets = pending ? (pending.remainingWork as { tickets?: string[] }).tickets : undefined;
      let resetTargets = pendingTickets ?? (opts.tickets ? [...new Set(opts.tickets.split(",").map(item => item.trim()).filter(Boolean))] : action === "restart-current" ? previewTicketReset(root, "unfinished").tickets.map(item => item.id).filter(id => run!.tickets.includes(id)) : [...run.tickets]);
      if (resetTargets.some(id => !run!.tickets.includes(id))) throw new Error("--tickets must contain only tickets in the selected run");
      if (pendingTickets && opts.tickets && JSON.stringify([...resetTargets].sort()) !== JSON.stringify([...new Set(opts.tickets.split(",").map(item => item.trim()))].sort())) throw new Error("A pending start-over has a frozen ticket selection; finish it before selecting different tickets");
      if (!pending && action === "restart-current" && !opts.tickets && process.stdin.isTTY && process.stdout.isTTY) {
        const { multiselect, isCancel } = await import("@clack/prompts");
        const answer = await multiselect({ message: "Which unfinished run tickets should restart from your current files?", options: resetTargets.map(value => ({ value, label: value })), initialValues: resetTargets, required: false });
        if (isCancel(answer)) return;
        resetTargets = answer as string[];
      }
      if (!resetTargets.length) { console.log("rafi build:start-over: no tickets selected; nothing changed"); return; }
      console.log(`  restarting tickets ${resetTargets.join(", ")}; ${action === "restart-current" ? "current branch and implementation files will be kept" : "Git preservation action will be applied"}`);
      const previewGitPlan = pending ? plannedGitResult(pending) ?? preservedGitResult(pending) ?? planStartOverGit(inventory, action) : planStartOverGit(inventory, action);
      if (action === "archive-restart") {
        console.log(`  archive destination ${previewGitPlan.archiveBranch}; active branch ${inventory.branch} will reset to ${inventory.baseline}`);
        const commits = git(inventory.worktree, ["log", "--format=%h %s", `${inventory.baseline}..${inventory.head}`]);
        console.log("  post-baseline commits will remain on the archive branch and leave the active branch:");
        for (const commit of commits?.split("\n").filter(Boolean) ?? []) console.log(`    ${commit}`);
        if (!commits) console.log("    none recorded");
      }
      if (!opts.yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("mutation requires --yes outside an interactive terminal");
        const { confirm, isCancel } = await import("@clack/prompts");
        const answer = await confirm({ message: `Apply ${action} and reset ${resetTargets.length} selected ticket(s)?`, initialValue: false });
        if (isCancel(answer) || !answer) return;
      }
      if (action === "retain-merged" && !opts.secondConfirm) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("retain-merged can duplicate already-merged work; pass --second-confirm");
        const { confirm, isCancel } = await import("@clack/prompts");
        const answer = await confirm({ message: "Merged code will remain. Resetting tickets can duplicate that work. Continue anyway?", initialValue: false });
        if (isCancel(answer) || !answer) return;
      }
      if (!pending && inventory.sourceDigest && inventory.sourceDigest !== startOverSourceDigest(inventory.worktree)) throw new Error("Implementation files changed during the start-over preview. Nothing was reset; inspect and retry with the current files.");
      const workflow = new WorkflowDb(root);
      let operation: WorkflowRunSnapshot;
      try { operation = pending ?? workflow.createRun({ kind: "recovery", checkpoint: "start-over-inventory", originalWork: inventory, remainingWork: { action, tickets: resetTargets }, state: { operation: "build-start-over" } }); }
      catch (error) { workflow.close(); throw error; }
      let lease: ProjectLease | undefined;
      let admission: ReturnType<WorkflowDb["acquireBuildRecoveryAdmission"]> | undefined;
      let result = preservedGitResult(operation);
      let planned = plannedGitResult(operation) ?? previewGitPlan;
      let resetId = typeof operation.state.resetId === "string" ? operation.state.resetId : undefined;
      let plannedResetId = typeof operation.state.plannedResetId === "string" ? operation.state.plannedResetId : undefined;
      try {
        // Reconcile only this run's owned processes before retiring execution.
        const cleanup = new WorkflowDb(root);
        try {
          const unresolved = await cleanup.reconcileReadiness(run.runId);
          if (unresolved.length) throw new Error("Process cleanup remains unverified; run rafi resume to reconcile before starting over");
        } finally { cleanup.close(); }
        if (workflow.getRun(run.runId)?.status !== "superseded") retireBuildExecutionForStartOver(root, run.runId, operation.runId);
        admission = workflow.acquireBuildRecoveryAdmission(operation.runId);
        lease = workflow.acquireLease(operation.runId);
        const recordedBackup = startOverControlBackup(root, operation.runId);
        if (pending && !preservedGitResult(operation) && existsSync(recordedBackup)) restoreStartOverControlFiles(inventory.worktree, readControlBackup(recordedBackup));
        assertLifecycleForCommand(root, "build-start-over");
        if (!result) {
          planned ??= planStartOverGit(inventory, action);
          workflow.transition(operation.runId, { checkpoint: "preservation-before", event: "start_over_intent", remainingWork: { action, tickets: resetTargets }, state: { operation: "build-start-over", planned } });
          if (action === "restart-current") result = applyStartOverGit(inventory, action, planned);
          else {
            const backup = startOverControlBackup(root, operation.runId);
            const controlFiles = existsSync(backup) ? readControlBackup(backup) : captureStartOverControlFiles(inventory.worktree);
            if (!existsSync(backup)) writeControlBackup(backup, controlFiles);
            try { result = applyStartOverGit(inventory, action, planned); }
            finally { restoreStartOverControlFiles(inventory.worktree, controlFiles); }
          }
          plannedResetId ??= randomUUID();
          workflow.transition(operation.runId, { checkpoint: "preservation-complete", remainingWork: { action, tickets: resetTargets }, state: { operation: "build-start-over", gitPreserved: true, result, plannedResetId } });
        }
        plannedResetId ??= randomUUID();
        let resetCount = resetTargets.length;
        if (!resetId) {
          const reset = resetTickets(root, resetTargets, "build:start-over", new Date(), { resetId: plannedResetId });
          resetId = reset.resetId;
          resetCount = reset.tickets.length;
          workflow.transition(operation.runId, { checkpoint: "tracker-reset-complete", remainingWork: { action, tickets: resetTargets }, state: { operation: "build-start-over", gitPreserved: true, result, plannedResetId, resetId } });
        }
        const superseded = checkpointBuildRun(root, bindBuildAuthority(run, lease), "superseded-by-start-over", { status: "superseded", lease: undefined, supersededBy: operation.runId });
        faults.afterSupersession?.();
        workflow.transition(operation.runId, { status: "completed", checkpoint: "start-over-committed", remainingWork: {}, state: { operation: "build-start-over", gitPreserved: true, result, resetId, supersededRun: superseded.runId } });
        if (result.archiveBranch) console.log(`rafi build:start-over: archived old work on ${result.archiveBranch}`);
        if (result.restartBranch) console.log(`rafi build:start-over: restart branch is ${result.restartBranch}`);
        if (result.revertBranch) console.log(`rafi build:start-over: prepared revert branch ${result.revertBranch} for review; no review was opened`);
        console.log(`rafi build:start-over: reset ${resetCount} ticket(s); old run ${run.runId} is superseded`);
        faults.onOutcome?.("completed");
        for (const ticket of resetTargets) console.log(`rafi build:start-over: continue with \`rafi start ${shellQuote(root)} --ticket ${shellQuote(ticket)} --steps 1\``);
      } catch (error) {
        faults.onOutcome?.("paused");
        if (admission) workflow.transition(operation.runId, { status: "paused", checkpoint: "start-over-failed", remainingWork: { action, tickets: resetTargets }, state: { operation: "build-start-over", ...(planned ? { planned } : {}), ...(result ? { gitPreserved: true, result } : {}), ...(plannedResetId ? { plannedResetId } : {}), ...(resetId ? { resetId } : {}), error: error instanceof Error ? error.message : String(error) } });
        else if (!pending) workflow.pauseOwnStartOverIntent(operation.runId, error);
        throw error;
      } finally {
        try { if (lease) workflow.releaseLease(lease); if (admission) workflow.releaseBuildAdmission(admission); }
        finally { workflow.close(); }
      }
    });
}

export function planStartOverGit(inventory: StartOverInventory, action: StartOverAction): StartOverGitResult {
  const cwd = inventory.worktree;
  if (action === "restart-current") return {};
  const original = required(inventory.branch, "original branch");
  if (action === "archive-restart") return { archiveBranch: uniqueBranch(cwd, `archive/${slug(original)}-${timestamp()}`), restartBranch: original };
  if (action === "archive-new-branch") return { archiveBranch: uniqueBranch(cwd, `archive/${slug(original)}-${timestamp()}`), restartBranch: uniqueBranch(cwd, `${original}-restart-2`) };
  if (action === "new-branch" || action === "retain-merged") return { restartBranch: uniqueBranch(cwd, `${original}-restart-2`) };
  if (action === "revert-branch") return { revertBranch: uniqueBranch(cwd, `revert/${slug(original)}-${timestamp()}`) };
  throw new Error(`unsupported start-over action: ${action}`);
}

export function applyStartOverGit(inventory: StartOverInventory, action: StartOverAction, planned = planStartOverGit(inventory, action)): StartOverGitResult {
  const cwd = inventory.worktree;
  if (action === "restart-current") return {};
  const original = required(inventory.branch, "original branch");
  const baseline = inventory.baseline;
  if (action === "archive-restart") {
    const resetTarget = required(baseline, "recorded baseline");
    const archiveBranch = required(planned.archiveBranch, "planned archive branch");
    switchBranch(cwd, archiveBranch);
    const runOwned = gitStatusPaths(cwd).filter((path) => !inventory.run.repository.git.initialStatusPaths.includes(path));
    if (runOwned.length) {
      git(cwd, ["add", "--", ...runOwned]);
      if (!gitOk(cwd, ["diff", "--cached", "--quiet"])) git(cwd, ["commit", "-m", `Archive interrupted Rafi run ${inventory.run.runId}`]);
    }
    git(cwd, ["switch", original]);
    git(cwd, ["reset", "--hard", resetTarget]);
    return { archiveBranch, restartBranch: original };
  }
  if (action === "archive-new-branch") {
    const source = required(inventory.baseRef, "current base ref");
    const archiveBranch = required(planned.archiveBranch, "planned archive branch");
    switchBranch(cwd, archiveBranch);
    const dirtyPaths = gitStatusPaths(cwd);
    if (dirtyPaths.length) {
      // An incomplete legacy ownership record cannot distinguish run-owned and
      // pre-existing paths. Archiving all current bytes is deliberately
      // preservation-only: the original branch is not reset or rewritten.
      git(cwd, ["add", "--", ...dirtyPaths]);
      if (!gitOk(cwd, ["diff", "--cached", "--quiet"])) git(cwd, ["commit", "-m", `Archive interrupted Rafi run ${inventory.run.runId}`]);
    }
    const restartBranch = required(planned.restartBranch, "planned restart branch");
    switchBranch(cwd, restartBranch, source);
    return { archiveBranch, restartBranch };
  }
  if (action === "new-branch" || action === "retain-merged") {
    const source = action === "retain-merged" || !inventory.baselineComplete
      ? required(inventory.baseRef, "current base ref")
      : required(baseline, "recorded baseline");
    const restartBranch = required(planned.restartBranch, "planned restart branch");
    switchBranch(cwd, restartBranch, source);
    return { restartBranch };
  }
  if (action === "revert-branch") {
    const base = required(inventory.baseRef, "base ref");
    const revertBranch = required(planned.revertBranch, "planned revert branch");
    switchBranch(cwd, revertBranch, base);
    const baseHead = required(gitValue(cwd, ["rev-parse", base]), "current base commit");
    if (gitValue(cwd, ["rev-parse", "HEAD"]) === baseHead && gitStatusPaths(cwd).length === 0) {
      git(cwd, ["revert", "--no-commit", `${required(baseline, "recorded baseline")}..${required(inventory.head, "run head")}`]);
    }
    if (gitStatusPaths(cwd).length) {
      git(cwd, ["add", "--all"]);
      git(cwd, ["commit", "-m", `Prepare reviewable revert of Rafi run ${inventory.run.runId}`]);
    }
    return { revertBranch };
  }
  throw new Error(`unsupported start-over action: ${action}`);
}

function selectRun(runs: Array<BuildRunRecordV2 & { active: boolean }>, value?: string) {
  if (!value) return undefined;
  const matches = runs.filter((run) => run.runId === value || run.runId.startsWith(value));
  if (matches.length > 1) throw new Error("run prefix is ambiguous");
  if (!matches.length) throw new Error(`recoverable build run not found: ${value}`);
  return matches[0];
}

function findPendingStartOver(projectDir: string, originalRunId: string): WorkflowRunSnapshot | undefined {
  const workflow = new WorkflowDb(projectDir);
  try {
    return workflow.resumableRuns("recovery")
      .filter((candidate) => candidate.state.operation === "build-start-over")
      .filter((candidate) => {
        const original = candidate.originalWork as Partial<StartOverInventory>;
        return original.run?.runId === originalRunId;
      })
      .at(-1);
  } finally { workflow.close(); }
}

function pendingInventory(operation: WorkflowRunSnapshot): StartOverInventory {
  const value = operation.originalWork as Partial<StartOverInventory>;
  if (!value.run || !value.worktree || !Array.isArray(value.dirtyPaths) || !Array.isArray(value.choices)) {
    throw new Error(`start-over operation ${operation.runId} has incomplete inventory; use manual recovery`);
  }
  return value as StartOverInventory;
}

function plannedGitResult(operation: WorkflowRunSnapshot): StartOverGitResult | undefined {
  const value = operation.state.planned;
  return value && typeof value === "object" ? value as StartOverGitResult : undefined;
}

function preservedGitResult(operation: WorkflowRunSnapshot): StartOverGitResult | undefined {
  const value = operation.state.result;
  return operation.state.gitPreserved === true && value && typeof value === "object" ? value as StartOverGitResult : undefined;
}

function printInventory(item: StartOverInventory): void {
  console.log(`rafi build:start-over preview — run ${item.run.runId}`);
  console.log(`  branch ${item.branch ?? "unknown"}; baseline ${item.baseline ?? "missing"}; head ${item.head ?? "missing"}`);
  console.log(`  tickets ${item.run.tickets.join(", ") || "none recorded"}; dirty ${item.dirtyPaths.join(", ") || "clean"}`);
  console.log(`  pushed ${item.pushed ? "yes" : "no"}; open review ${item.openReview ?? "none detected"}; merged ${item.merged ? "yes" : "no"}`);
  if (!item.baselineComplete) console.log("  ! baseline ownership is incomplete; automatic reset of the original branch is unavailable");
  if (item.unexpectedPaths.length) console.log(`  ! unexpected/pre-run paths: ${item.unexpectedPaths.join(", ")}`);
  console.log(`  choices ${item.choices.join(", ")}; recommended ${item.recommended}`);
  console.log("  remote branches and reviews will not be deleted, rewritten, closed, or merged");
}

function printManual(item: StartOverInventory): void {
  console.log("rafi build:start-over manual guidance:");
  console.log(`  preserve branch/worktree ${item.branch ?? item.run.repository.worktree}`);
  console.log(`  recorded baseline ${item.baseline ?? "unavailable — choose a trusted base manually"}`);
  console.log(`  after Git reconciliation, reset only these tickets: ${item.run.tickets.join(", ")}`);
  console.log("  do not force-push, delete remote branches, or close reviews as part of tracker reset");
}

function detectOpenReview(cwd: string, branch: string): string | undefined {
  for (const [tool, args] of [["gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--limit", "1"]], ["glab", ["mr", "list", "--source-branch", branch, "--state", "opened", "--output", "json"]]] as const) {
    try {
      const parsed = JSON.parse(execFileSync(tool, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })) as Array<{ url?: string; web_url?: string }>;
      const url = parsed[0]?.url ?? parsed[0]?.web_url; if (url) return url;
    } catch { /* provider unavailable or offline; upstream still protects pushed work */ }
  }
  return undefined;
}

function detectCurrentBaseRef(cwd: string, currentBranch?: string): string | undefined {
  const remoteHead = gitValue(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead && remoteHead !== currentBranch) return remoteHead;
  const configured = gitValue(cwd, ["config", "init.defaultBranch"]);
  for (const candidate of [configured, "main", "master"]) {
    if (candidate && candidate !== currentBranch && gitOk(cwd, ["rev-parse", "--verify", `${candidate}^{commit}`])) return candidate;
  }
  return undefined;
}

function uniqueBranch(cwd: string, requested: string): string {
  const match = /^(.*?)(\d+)$/.exec(requested);
  const prefix = match?.[1] ?? `${requested}-`;
  let index = match ? Number(match[2]) : 2;
  let value = requested;
  while (gitOk(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${value}`])) value = `${prefix}${++index}`;
  return value;
}
function switchBranch(cwd: string, branch: string, startPoint?: string): void {
  if (gitValue(cwd, ["branch", "--show-current"]) === branch) return;
  if (gitOk(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) git(cwd, ["switch", branch]);
  else git(cwd, startPoint ? ["switch", "-c", branch, startPoint] : ["switch", "-c", branch]);
}
function git(cwd: string, args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function gitValue(cwd: string, args: string[]): string | undefined { try { return git(cwd, args) || undefined; } catch { return undefined; } }
function gitOk(cwd: string, args: string[]): boolean { try { execFileSync("git", args, { cwd, stdio: "ignore" }); return true; } catch { return false; } }
function gitStatusPaths(cwd: string): string[] {
  const controls = startOverArtifactPaths(cwd);
  const records = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "-z"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const line = records[i];
    if (!line) continue;
    paths.push(line.slice(3));
    if (line.slice(0, 2).includes("R") || line.slice(0, 2).includes("C")) paths.push(records[++i]);
  }
  return paths
    .filter(Boolean)
    .filter((path) => !isStartOverControlPath(path) && !controls.has(path))
    .sort();
}

function printCleanupGuidance(inventory: StartOverInventory): void {
  console.log(`rafi build:start-over: this action needs a clean working tree. Preserve or discard these changes first: ${(inventory.unexpectedPaths.length ? inventory.unexpectedPaths : inventory.dirtyPaths).join(", ")}`);
  console.log("  git stash push --include-untracked preserves tracked and untracked work; restore it later with git stash pop.");
  console.log("  git reset --hard discards tracked changes only. Untracked files remain; move or remove them yourself after inspection. Rafi keeps its tracker and configuration.");
  console.log("  Or handle the files in another terminal, then select ‘I handled it; check again’. Rafi rechecks before proceeding.");
  console.log(`  Keep all implementation files instead: rafi build:start-over --run ${inventory.run.runId} --action restart-current`);
}

export interface StartOverCleanupPrompts {
  choose(): Promise<"stash" | "discard" | "handled" | "cancel">;
  confirm(message: string): Promise<boolean>;
}

export async function resolveStartOverCleanup(inventory: StartOverInventory, choice?: string, prompts?: StartOverCleanupPrompts): Promise<boolean> {
  printCleanupGuidance(inventory);
  if (choice && !["stash", "discard", "handled"].includes(choice)) throw new Error("--cleanup must be stash, discard, or handled");
  if (!prompts && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    // --yes confirms the restart, never an additional destructive Git action.
    // Automation may handle files itself and request a verified recheck.
    if (choice !== "handled") {
      console.log("  Non-interactive: run your chosen Git command, then retry with --cleanup handled. Nothing changed.");
      process.exitCode = 2;
      return false;
    }
    const clean = gitStatusPaths(inventory.worktree).length === 0;
    if (!clean) { console.log("rafi build:start-over: changes remain; cleanup is paused."); process.exitCode = 2; }
    return clean;
  }
  const { select, confirm, isCancel } = await import("@clack/prompts");
  while (true) {
    const answer = choice ?? (prompts ? await prompts.choose() : await select({ message: "How should the working tree be prepared?", options: [
      { value: "stash", label: "Run git stash push --include-untracked (preserve changes)" },
      { value: "handled", label: "I handled it in another terminal; check again" },
      { value: "discard", label: "Run git reset --hard (discard tracked changes; keep untracked files)" },
      { value: "cancel", label: "Cancel; keep everything" },
    ] }));
    choice = undefined;
    if (isCancel(answer) || answer === "cancel") return false;
    if (answer === "stash" || answer === "discard") {
      const message = answer === "stash" ? "Stash tracked and untracked implementation changes while keeping Rafi's tracker and configuration?" : "Permanently discard uncommitted tracked changes with git reset --hard? Rafi keeps its tracker and configuration; untracked files remain.";
      const approved = prompts ? await prompts.confirm(message) : await confirm({ message, initialValue: false });
      if (isCancel(approved) || !approved) continue;
      const owner = recoverableBuildRuns(inventory.run.repository.root).find(item => item.runId === inventory.run.runId);
      if (owner?.active || owner?.ownership === "unknown") throw new Error("Build ownership changed; stop and reconcile the owner before changing Git files");
      const processes = new WorkflowDb(inventory.run.repository.root);
      let authority: ReturnType<WorkflowDb["acquireBuildRecoveryAdmission"]> | undefined;
      let lease: ProjectLease | undefined;
      try {
        authority = processes.acquireBuildRecoveryAdmission(inventory.run.runId);
        lease = processes.acquireLease(inventory.run.runId);
        if (processes.readinessProcesses().length) throw new Error("Owned processes remain unverified; run rafi resume before working-tree cleanup");
        if (gitValue(inventory.worktree, ["branch", "--show-current"]) !== inventory.branch) throw new Error("Working branch changed during cleanup; inspect and retry");
        if (answer === "stash") {
          const controlFiles = captureStartOverControlFiles(inventory.worktree);
          // A path-scoped Git stash rejects the old side of a staged rename.
          // Use a temporary exclusion file for untracked runtime metadata,
          // retaining the user's global ignore rules, and preserve tracked
          // configuration independently. No repository Git config is changed.
          const excludes = join(inventory.run.repository.root, ".rafi", `start-over-${randomUUID()}.exclude`);
          const configured = gitValue(inventory.worktree, ["config", "--path", "--get", "core.excludesFile"]);
          const existing = configured ? resolve(inventory.worktree, configured) : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git", "ignore");
          mkdirSync(resolve(excludes, ".."), { recursive: true });
          const artifactExcludes = [...startOverArtifactPaths(inventory.worktree)].map(path => `/${path.replace(/[\\*?\[\]]/g, "\\$&")}`).join("\n");
          writeFileSync(excludes, `${existsSync(existing) ? readFileSync(existing, "utf8") : ""}\n/.rafi/\n/.foreman/\n/.tickets/\n/rafi-config.yaml\n${artifactExcludes}\n`, { mode: 0o600 });
          try { git(inventory.worktree, ["-c", `core.excludesFile=${excludes}`, "stash", "push", "--include-untracked", "-m", `Rafi start-over ${inventory.run.runId}`]); }
          finally { restoreStartOverControlFiles(inventory.worktree, controlFiles); rmSync(excludes, { force: true }); }
        } else {
          const controlFiles = captureStartOverControlFiles(inventory.worktree);
          try { git(inventory.worktree, ["reset", "--hard"]); }
          finally { restoreStartOverControlFiles(inventory.worktree, controlFiles); }
        }
      } finally {
        try { if (lease) processes.releaseLease(lease); }
        finally { try { if (authority) processes.releaseBuildAdmission(authority); } finally { processes.close(); } }
      }
    }
    if (gitStatusPaths(inventory.worktree).length === 0) return true;
    console.log("rafi build:start-over: changes remain. Move or preserve untracked files in another terminal, then check again.");
  }
}
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "run"; }
function timestamp(): string { return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z"); }
function required(value: string | undefined, label: string): string { if (!value) throw new Error(`missing ${label}; use manual recovery`); return value; }
function actionLabel(action: StartOverAction, recommended: boolean): string { return `${action === "restart-current" ? "Restart execution from current files (keep branch and implementation)" : action}${recommended ? " (Recommended)" : ""}`; }
function shellQuote(value: string): string { return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`; }

function isStartOverControlPath(path: string): boolean {
  return [".foreman", ".rafi", ".tickets"].some(dir => path === dir || path === `${dir}/` || path.startsWith(`${dir}/`)) || path === "rafi-config.yaml";
}

function startOverArtifactPaths(root: string): Set<string> {
  const manifest = readInstallManifest(root);
  return new Set([
    ...ticketOwnershipReceipts(root, "start-over", false).map(receipt => receipt.path),
    ...(manifest?.files.filter(file => file.category === "tickets" || file.category === "plans").map(file => file.path) ?? []),
  ]);
}

type StartOverControlFiles = Map<string, { content: Buffer; mode: number }>;

function captureStartOverControlFiles(root: string): StartOverControlFiles {
  // Git must never overwrite a live SQLite database. Those files belong in
  // ignored runtime directories, not the implementation's tracked tree.
  const tracked = git(root, ["ls-files", "-z"]).split("\0").filter(path => isStartOverControlPath(path));
  if (tracked.some(path => path.startsWith(".rafi/") || path.startsWith(".foreman/") || /\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm|journal))?$/.test(path))) throw new Error("Tracked Rafi databases cannot be reset safely; choose restart-current to preserve current files");
  const files: StartOverControlFiles = new Map();
  const visit = (path: string) => {
    const absolute = join(root, path);
    if (!existsSync(absolute)) return;
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`Rafi control path ${path} is a symbolic link; preserve it manually before resetting Git`);
    if (info.isDirectory()) { for (const entry of readdirSync(absolute)) visit(`${path}/${entry}`); }
    else if (!/\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm|journal))?$/.test(path)) files.set(path, { content: readFileSync(absolute), mode: info.mode & 0o777 });
  };
  visit("rafi-config.yaml"); visit(".tickets");
  for (const path of startOverArtifactPaths(root)) visit(path);
  return files;
}

function restoreStartOverControlFiles(root: string, files: StartOverControlFiles): void {
  for (const [path, { content, mode }] of files) {
    for (const prefix of path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))) {
      const target = join(root, prefix);
      try {
        if (lstatSync(target).isSymbolicLink()) throw new Error(`Cannot restore Rafi control files through symbolic link ${prefix}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    mkdirSync(resolve(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content, { mode });
    chmodSync(join(root, path), mode);
  }
}

function startOverControlBackup(root: string, operationId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(operationId)) throw new Error("Invalid start-over operation identity");
  return join(root, ".rafi", "start-over-control", `${operationId}.json`);
}

function writeControlBackup(path: string, files: StartOverControlFiles): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify([...files].map(([name, { content, mode }]) => [name, content.toString("base64"), mode])), { mode: 0o600 });
  renameSync(temporary, path);
}

function readControlBackup(path: string): StartOverControlFiles {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value) || value.some(item => !Array.isArray(item) || item.length !== 3 || !Number.isInteger(item[2]) || item[2] < 0 || item[2] > 0o777 || typeof item[0] !== "string" || typeof item[1] !== "string"
    || !/^(rafi-config\.yaml|\.tickets\/[^\\]+)$/.test(item[0]) || item[0].split("/").some(part => part === ".." || part === "."))) throw new Error("Invalid preserved Rafi control-file backup");
  return new Map(value.map(([name, content, mode]: [string, string, number]) => [name, { content: Buffer.from(content, "base64"), mode }]));
}

function startOverSourceDigest(root: string): string {
  const hash = createHash("sha256");
  hash.update(gitValue(root, ["rev-parse", "HEAD"]) ?? "unborn").update("\0");
  const scope = ["--", ".", ":(exclude).rafi/**", ":(exclude).foreman/**", ":(exclude).tickets/**", ":(exclude)rafi-config.yaml"];
  for (const args of [["diff", "--cached", "--binary", "--no-ext-diff", ...scope], ["diff", "--binary", "--no-ext-diff", ...scope]]) {
    hash.update(execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })).update("\0");
  }
  const controls = startOverArtifactPaths(root);
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(path => path && !isStartOverControlPath(path) && !controls.has(path)).sort();
  for (const path of untracked) {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    hash.update(JSON.stringify([path, stat.mode])).update("\0");
    hash.update(stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute)).update("\0");
  }
  return hash.digest("hex");
}
