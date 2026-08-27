import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { checkpointBuildRun, projectBuildRecovery, recoverableBuildRuns } from "ai-foreman/build-runs.js";
import { resetTickets } from "ai-foreman/ticket-reset.js";
import { WorkflowDb, type ProjectLease, type WorkflowRunSnapshot } from "ai-foreman/workflow-db.js";
import type { BuildRunRecordV2 } from "rafi-spec";
import { assertLifecycleForCommand } from "./lifecycle.js";

export type StartOverAction = "archive-restart" | "archive-new-branch" | "new-branch" | "retain-merged" | "revert-branch" | "manual" | "cancel";
export interface StartOverInventory {
  run: BuildRunRecordV2 & { active: boolean };
  worktree: string;
  branch?: string;
  head?: string;
  baseline?: string;
  baseRef?: string;
  dirtyPaths: string[];
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
  const dirtyPaths = gitStatusPaths(worktree);
  const initial = new Set(run.repository.git.initialStatusPaths);
  let unexpectedPaths = dirtyPaths.filter((path) => initial.has(path) || (run.repository.git.runOwnedPaths.length > 0 && !run.repository.git.runOwnedPaths.includes(path)));
  const pushed = Boolean(run.repository.git.upstream || (branch && gitValue(worktree, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`])));
  const openReview = branch ? detectOpenReview(worktree, branch) : undefined;
  // Uncommitted work cannot remain attached to the protected original branch
  // while switching a pushed/reviewed run to a clean restart branch.
  if ((pushed || openReview) && dirtyPaths.length) unexpectedPaths = [...new Set([...unexpectedPaths, ...dirtyPaths])].sort();
  const merged = Boolean(branch && baseRef && branch !== baseRef && gitOk(worktree, ["merge-base", "--is-ancestor", branch, baseRef]));
  const baselineComplete = Boolean(run.repository.baselineComplete && baseline && branch && head);
  if (!baselineComplete) {
    const choices: StartOverAction[] = baseRef
      ? ["archive-new-branch", "new-branch", "manual", "cancel"]
      : ["manual", "cancel"];
    return { run, worktree, branch, head, baseline, baseRef, dirtyPaths, unexpectedPaths, pushed, openReview, merged, baselineComplete, recommended: baseRef ? (dirtyPaths.length ? "archive-new-branch" : "new-branch") : "manual", choices };
  }
  if (merged) return { run, worktree, branch, head, baseline, baseRef, dirtyPaths, unexpectedPaths, pushed, openReview, merged, baselineComplete, recommended: "retain-merged", choices: ["retain-merged", "revert-branch", "manual", "cancel"] };
  if (pushed || openReview) return { run, worktree, branch, head, baseline, baseRef, dirtyPaths, unexpectedPaths, pushed, openReview, merged, baselineComplete, recommended: "new-branch", choices: ["new-branch", "manual", "cancel"] };
  return { run, worktree, branch, head, baseline, baseRef, dirtyPaths, unexpectedPaths, pushed, openReview, merged, baselineComplete, recommended: "archive-restart", choices: ["archive-restart", "manual", "cancel"] };
}

export function buildBuildStartOverCommand(): Command {
  return new Command("build:start-over")
    .description("Safely preserve an implementation run, reconcile its tracker state, and prepare a fresh restart.")
    .argument("[project]", "project directory", ".")
    .option("--run <id>", "run ID or unique prefix")
    .option("--action <action>", "archive-restart | archive-new-branch | new-branch | retain-merged | revert-branch | manual | cancel")
    .option("--yes", "confirm the preview and selected action")
    .option("--second-confirm", "acknowledge duplicate-work risk for --action retain-merged")
    .option("--inspect", "show inventory and choices without mutation")
    .action(async (project: string, opts: { run?: string; action?: string; yes?: boolean; secondConfirm?: boolean; inspect?: boolean }) => {
      const root = resolve(project);
      assertLifecycleForCommand(root, "build-start-over");
      const runs = recoverableBuildRuns(root);
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
      const inventory = pending ? pendingInventory(pending) : inventoryBuildStartOver(root, run);
      printInventory(inventory);
      if (pending) console.log(`  resuming preserved start-over operation ${pending.runId} at ${pending.checkpoint}`);
      if (run.active) throw new Error("the original build process is verified live; stop it before starting over");
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
      if (action === "manual") { printManual(inventory); return; }
      if (inventory.unexpectedPaths.length && action !== "archive-new-branch") throw new Error(`unexpected/pre-run changes must be preserved or moved first: ${inventory.unexpectedPaths.join(", ")}`);
      if (!opts.yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("mutation requires --yes outside an interactive terminal");
        const { confirm, isCancel } = await import("@clack/prompts");
        const answer = await confirm({ message: `Apply ${action} and reset ${run.tickets.length} run ticket(s)?`, initialValue: false });
        if (isCancel(answer) || !answer) return;
      }
      if (action === "retain-merged" && !opts.secondConfirm) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("retain-merged can duplicate already-merged work; pass --second-confirm");
        const { confirm, isCancel } = await import("@clack/prompts");
        const answer = await confirm({ message: "Merged code will remain. Resetting tickets can duplicate that work. Continue anyway?", initialValue: false });
        if (isCancel(answer) || !answer) return;
      }
      const workflow = new WorkflowDb(root);
      const operation = pending ?? workflow.createRun({ kind: "recovery", checkpoint: "start-over-inventory", originalWork: inventory, remainingWork: { action, tickets: run.tickets }, state: { operation: "build-start-over" } });
      let lease: ProjectLease | undefined;
      let result = preservedGitResult(operation);
      let planned = plannedGitResult(operation);
      let resetId = typeof operation.state.resetId === "string" ? operation.state.resetId : undefined;
      let plannedResetId = typeof operation.state.plannedResetId === "string" ? operation.state.plannedResetId : undefined;
      try {
        lease = workflow.acquireLease(operation.runId);
        if (!result) {
          planned ??= planStartOverGit(inventory, action);
          workflow.transition(operation.runId, { checkpoint: "preservation-before", event: "start_over_intent", remainingWork: { action, tickets: run.tickets }, state: { operation: "build-start-over", planned } });
          result = applyStartOverGit(inventory, action, planned);
          plannedResetId ??= randomUUID();
          workflow.transition(operation.runId, { checkpoint: "preservation-complete", remainingWork: { action, tickets: run.tickets }, state: { operation: "build-start-over", gitPreserved: true, result, plannedResetId } });
        }
        plannedResetId ??= randomUUID();
        let resetCount = run.tickets.length;
        if (!resetId) {
          const reset = resetTickets(root, run.tickets, "build:start-over", new Date(), { resetId: plannedResetId });
          resetId = reset.resetId;
          resetCount = reset.tickets.length;
          workflow.transition(operation.runId, { checkpoint: "tracker-reset-complete", remainingWork: { action, tickets: run.tickets }, state: { operation: "build-start-over", gitPreserved: true, result, plannedResetId, resetId } });
        }
        const superseded = checkpointBuildRun(root, run, "superseded-by-start-over", { status: "superseded", lease: undefined, supersededBy: operation.runId });
        workflow.transition(operation.runId, { status: "completed", checkpoint: "start-over-committed", remainingWork: {}, state: { operation: "build-start-over", gitPreserved: true, result, resetId, supersededRun: superseded.runId } });
        if (result.archiveBranch) console.log(`rafi build:start-over: archived old work on ${result.archiveBranch}`);
        if (result.restartBranch) console.log(`rafi build:start-over: restart branch is ${result.restartBranch}`);
        if (result.revertBranch) console.log(`rafi build:start-over: prepared revert branch ${result.revertBranch} for review; no review was opened`);
        console.log(`rafi build:start-over: reset ${resetCount} ticket(s); old run ${run.runId} is superseded`);
        console.log(`rafi build:start-over: continue with \`rafi start ${shellQuote(root)} --steps ${Math.max(1, run.tickets.length)}\``);
      } catch (error) {
        workflow.transition(operation.runId, { status: "paused", checkpoint: "start-over-failed", remainingWork: { action, tickets: run.tickets }, state: { operation: "build-start-over", ...(planned ? { planned } : {}), ...(result ? { gitPreserved: true, result } : {}), ...(plannedResetId ? { plannedResetId } : {}), ...(resetId ? { resetId } : {}), error: error instanceof Error ? error.message : String(error) } });
        throw error;
      } finally { if (lease) workflow.releaseLease(lease); workflow.close(); }
    });
}

export function planStartOverGit(inventory: StartOverInventory, action: StartOverAction): StartOverGitResult {
  const cwd = inventory.worktree;
  const original = required(inventory.branch, "original branch");
  if (action === "archive-restart") return { archiveBranch: uniqueBranch(cwd, `archive/${slug(original)}-${timestamp()}`), restartBranch: original };
  if (action === "archive-new-branch") return { archiveBranch: uniqueBranch(cwd, `archive/${slug(original)}-${timestamp()}`), restartBranch: uniqueBranch(cwd, `${original}-restart-2`) };
  if (action === "new-branch" || action === "retain-merged") return { restartBranch: uniqueBranch(cwd, `${original}-restart-2`) };
  if (action === "revert-branch") return { revertBranch: uniqueBranch(cwd, `revert/${slug(original)}-${timestamp()}`) };
  throw new Error(`unsupported start-over action: ${action}`);
}

export function applyStartOverGit(inventory: StartOverInventory, action: StartOverAction, planned = planStartOverGit(inventory, action)): StartOverGitResult {
  const cwd = inventory.worktree;
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
  return (gitValue(cwd, ["status", "--porcelain=v1", "-z"]) ?? "")
    .split("\0").filter(Boolean).map((line) => line.slice(3))
    .filter((path) => path !== ".foreman" && !path.startsWith(".foreman/") && path !== ".rafi" && !path.startsWith(".rafi/"))
    .sort();
}
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "run"; }
function timestamp(): string { return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z"); }
function required(value: string | undefined, label: string): string { if (!value) throw new Error(`missing ${label}; use manual recovery`); return value; }
function actionLabel(action: StartOverAction, recommended: boolean): string { return `${action}${recommended ? " (Recommended)" : ""}`; }
function shellQuote(value: string): string { return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`; }
