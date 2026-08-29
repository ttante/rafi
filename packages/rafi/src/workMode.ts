import type { TicketBuildBranchStrategy } from "rafi-spec";

export const CURRENT_BRANCH_WORK_MODE_LABEL = "Current branch — Rafi works here; you manage Git";

export function workModeLabel(mode: TicketBuildBranchStrategy): string {
  if (mode === "current") return CURRENT_BRANCH_WORK_MODE_LABEL;
  if (mode === "batch") return "Batch branch — Rafi isolates an approved delivery batch";
  return "Branch per ticket — Rafi isolates each ticket";
}

export function workModeConsequences(mode: TicketBuildBranchStrategy): string {
  if (mode === "current") return "Rafi may edit, test, run QA, and update tracker/recovery state, but performs no branch/worktree, commit, push, merge, rebase, or review lifecycle operation.";
  if (mode === "batch") return "Rafi creates and manages shared isolated delivery branches and may perform the explicitly approved completion workflow.";
  return "Rafi creates isolated ticket branches/worktrees and may perform the explicitly approved completion workflow.";
}

export async function promptPlanningWorkMode(current?: TicketBuildBranchStrategy): Promise<TicketBuildBranchStrategy> {
  const { select, isCancel } = await import("@clack/prompts");
  const answer = await select({
    message: "Default ticket work mode:",
    initialValue: current ?? "branch-per-ticket",
    options: [
      { value: "current", label: CURRENT_BRANCH_WORK_MODE_LABEL },
      { value: "batch", label: "Batch branch — shared branches for explicit delivery batches" },
      { value: "branch-per-ticket", label: "Branch per ticket — isolate each ticket" },
    ],
  });
  if (isCancel(answer)) throw new Error("work-mode selection cancelled");
  return answer as TicketBuildBranchStrategy;
}

export function isTicketWorkMode(value: unknown): value is TicketBuildBranchStrategy {
  return value === "current" || value === "batch" || value === "branch-per-ticket";
}
