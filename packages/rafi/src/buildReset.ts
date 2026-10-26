import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { parse } from "yaml";
import { resetTickets } from "ai-foreman/tickets/reset.js";
import { readCompletedPlanApprovals, readRecoveryOwners, type CompletedPlanApproval } from "ai-foreman/recovery-owners.js";
import { classifyProcess } from "ai-foreman/process-identity.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";

/** The approved plan currently published in the project, if any. */
function currentPlan(root: string): { planId: string; revision: number; digest: string } | undefined {
  try {
    const config = parse(readFileSync(join(root, "rafi-config.yaml"), "utf8")) as { docs?: { root?: string } } | undefined;
    const plan = JSON.parse(readFileSync(join(root, config?.docs?.root ?? "docs", "rafi-plan.json"), "utf8"));
    return { planId: plan.plan_id, revision: plan.revision, digest: plan.content_digest };
  } catch { return undefined; }
}

/**
 * Find the newest approval of the current plan: first in the database being
 * archived, then in earlier archives (older resets dropped approvals).
 */
function approvalToCarry(root: string, dbPath: string): CompletedPlanApproval | undefined {
  const plan = currentPlan(root);
  if (!plan) return undefined;
  const matches = (approval: CompletedPlanApproval): boolean => approval.state.planId === plan.planId
    && approval.state.revision === plan.revision && approval.state.digest === plan.digest
    && (approval.state.decisionReceipt as { planDigest?: unknown } | undefined)?.planDigest === plan.digest;
  const newest = (approvals: CompletedPlanApproval[]) => approvals.filter(matches).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
  const current = newest(readCompletedPlanApprovals(dbPath));
  if (current) return current;
  const archives = join(root, ".rafi", "recovery-archive");
  if (!existsSync(archives)) return undefined;
  const archived = readdirSync(archives).sort().reverse()
    .map(name => join(archives, name, "recovery.sqlite3")).filter(path => existsSync(path))
    .flatMap(path => { try { return readCompletedPlanApprovals(path); } catch { return []; } });
  return newest(archived);
}

/**
 * Return the project to the durable state immediately after ticket
 * population. Recovery history is retained in a timestamped archive; it is
 * not allowed to participate in the next build.
 */
export function resetBuildState(projectDir: string, now = new Date()): { archiveDir: string; tickets: string[]; planApprovalCarried: boolean } {
  const root = resolve(projectDir);
  const dbPath = join(root, ".rafi", "recovery.sqlite3");
  // Inspect owners without migrating: a database written by an older Rafi
  // cannot be opened as a writer while it still holds a dead build's admission.
  for (const owner of readRecoveryOwners(dbPath)) {
    if (owner.pid === null || classifyProcess(owner.pid, owner.processStart, owner.host).state !== "dead") {
      throw new Error(`cannot reset while a live or unverified Rafi process owns the project (${owner.source} pid ${owner.pid ?? "unknown"}, run ${owner.runId})`);
    }
  }

  const approval = approvalToCarry(root, dbPath);

  const stamp = now.toISOString().replaceAll(/[^0-9A-Za-z-]/g, "-");
  const archiveDir = join(root, ".rafi", "recovery-archive", stamp);
  mkdirSync(archiveDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const source = `${dbPath}${suffix}`;
    if (existsSync(source)) renameSync(source, join(archiveDir, `recovery.sqlite3${suffix}`));
  }

  const runsDir = join(root, ".foreman", "runs");
  const archivedRuns = join(archiveDir, "foreman-runs");
  if (existsSync(runsDir)) {
    mkdirSync(archivedRuns, { recursive: true });
    for (const name of readdirSync(runsDir)) {
      if (name.endsWith(".json")) renameSync(join(runsDir, name), join(archivedRuns, name));
    }
  }

  // Plan approval is pre-build state; without it no later run can be resumed.
  if (approval) {
    const workflow = new WorkflowDb(root);
    try {
      workflow.createRun({ runId: approval.runId, kind: "plan", checkpoint: "plan-approval-carried-forward", originalWork: approval.originalWork, remainingWork: {}, state: approval.state }, now);
      workflow.transition(approval.runId, { status: "completed", checkpoint: "plan-pair-and-config-published", remainingWork: {}, state: approval.state, event: "plan_approval_carried_forward", payload: { archiveDir } }, now);
    } finally { workflow.close(); }
  }

  const reset = resetTickets(root, "all", "build-reset", now);
  return { archiveDir, tickets: reset.tickets, planApprovalCarried: Boolean(approval) };
}

export function buildResetCommand(): Command {
  return new Command("build:reset")
    .description("Archive all Rafi recovery state and reset tickets to their post-population state.")
    .argument("[project]", "project directory", ".")
    .option("--yes", "confirm the destructive-to-recovery-state reset")
    .action((project: string, opts: { yes?: boolean }) => {
      if (!opts.yes) throw new Error("build:reset archives all recovery state; rerun with --yes");
      const result = resetBuildState(project);
      console.log(`rafi: archived recovery state at ${result.archiveDir}`);
      console.log(`rafi: reset ${result.tickets.length} ticket(s) to planned`);
      console.log(result.planApprovalCarried ? "rafi: carried the current plan approval forward" : "rafi: no approval of the current plan was found; approve it again before resuming builds");
      console.log("rafi: source files and diagnostic logs were preserved");
    });
}
