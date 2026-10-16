import { WorkflowReader } from "ai-foreman/workflow-reader.js";
import { recoverableBuildRuns } from "ai-foreman/build-runs.js";

type RecoveryChoice = "resume" | "restart-current" | "archive" | "cancel";
export type RecoveryOutcome = "completed" | "paused" | "cancelled";
export interface StartRecoveryActions {
  resume(project: string, runId: string): Promise<RecoveryOutcome | void>;
  restart(project: string, runId: string, action?: "restart-current"): Promise<RecoveryOutcome | void>;
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
  let outcome: RecoveryOutcome | void = "cancelled";
  if (choice === "resume") outcome = await actions.resume(project, runId);
  else if (choice === "restart-current") outcome = await actions.restart(project, runId, "restart-current");
  else if (choice === "archive") outcome = await actions.restart(project, runId);
  // Recovery handles its own confirmations and receipts. Never continue this
  // stale launch after cancellation, a pause, or a changed ticket selection.
  if (outcome === "completed") console.log("rafi: Recovery completed. Run your start command again to launch the selected new work.");
  else if (outcome === "cancelled") console.log("rafi: Recovery cancelled; no new build was launched.");
  else if (outcome === "paused") console.log("rafi: Recovery paused. Follow its recovery instructions before launching new work.");
  else console.log("rafi: Recovery returned control; review its reported outcome before launching new work.");
  return false;
}
