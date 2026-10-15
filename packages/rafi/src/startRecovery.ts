import { WorkflowReader } from "ai-foreman/workflow-reader.js";
import { recoverableBuildRuns } from "ai-foreman/build-runs.js";

type RecoveryChoice = "resume" | "restart-current" | "archive" | "cancel";
export interface StartRecoveryActions {
  resume(project: string, runId: string): Promise<void>;
  restart(project: string, runId: string, action?: "restart-current"): Promise<void>;
  choose?(runId: string): Promise<RecoveryChoice>;
}

/** Intercept a fresh launch before ticket selection or provider preparation. */
export async function offerStartRecovery(project: string, actions: StartRecoveryActions): Promise<boolean> {
  const reader = new WorkflowReader(project);
  let blocked: string[];
  try {
    blocked = reader.buildRuns(true).filter(run => reader.operations(run.runId, true).some(operation =>
      operation.kind === "provider-dispatch" && ["in_progress", "uncertain"].includes(operation.status),
    )).map(run => run.runId);
  } finally { reader.close(); }
  if (!blocked.length) return true;
  const runId = blocked[0]!;
  const quotedProject = `'${project.replace(/'/g, `'"'"'`)}'`;
  console.log(`rafi: Build ${runId} was interrupted with an unconfirmed provider result. Resume it or explicitly start over before launching new work.`);
  console.log(`  Resume: rafi build:resume ${quotedProject} --run ${runId}`);
  console.log(`  Keep files and restart: rafi build:start-over ${quotedProject} --run ${runId} --action restart-current`);
  console.log(`  Archive and restart: rafi build:start-over ${quotedProject} --run ${runId}`);
  if (blocked.length > 1) console.log(`  Other interrupted builds also need recovery: ${blocked.slice(1).join(", ")}`);
  const owner = recoverableBuildRuns(project).find(run => run.runId === runId);
  if (!owner || owner.active || owner.ownership === "unknown") {
    console.log("rafi: Stop the owning build or restore process visibility first; restart is unavailable until ownership is verified inactive.");
    process.exitCode = 2;
    return false;
  }
  if (!actions.choose && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    process.exitCode = 2;
    return false;
  }
  let choice: RecoveryChoice;
  if (actions.choose) choice = await actions.choose(runId);
  else {
    const { select, isCancel } = await import("@clack/prompts");
    const answer = await select({ message: "How should Rafi recover the interrupted build?", options: [
      { value: "resume", label: "Resume interrupted work" },
      { value: "restart-current", label: "Restart from current files (keep branch and implementation)" },
      { value: "archive", label: "Archive and restart (choose a safe preservation action)" },
      { value: "cancel", label: "Cancel" },
    ] });
    if (isCancel(answer)) return false;
    choice = answer as RecoveryChoice;
  }
  if (choice === "resume") await actions.resume(project, runId);
  else if (choice === "restart-current") await actions.restart(project, runId, "restart-current");
  else if (choice === "archive") await actions.restart(project, runId);
  // Recovery handles its own confirmations and receipts. Never continue this
  // stale launch after cancellation, a pause, or a changed ticket selection.
  if (choice !== "cancel") console.log("rafi: Recovery finished or paused. When it reports completion, run your start command again to launch the selected new work.");
  return false;
}
