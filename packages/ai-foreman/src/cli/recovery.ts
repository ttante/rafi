import { Command } from "commander";
import { resolve } from "node:path";
import { readBuildRuns } from "../buildRuns.js";
import { WorkflowDb } from "../workflowDb.js";

export function buildAttachCommand(): Command {
  return new Command("build:attach")
    .description("Attach to a supervised build and show its durable recovery state.")
    .argument("[project]", "project directory", ".")
    .requiredOption("--run <id>", "build run ID")
    .action((project: string, opts: { run: string }) => {
      const projectDir = resolve(project); const run = readBuildRuns(projectDir).find((item) => item.runId === opts.run);
      if (!run) throw new Error(`build run not found: ${opts.run}`);
      const db = new WorkflowDb(projectDir);
      try {
        const supervisor = db.supervisorState(run.runId);
        console.log(`rafi: run ${run.runId}`);
        console.log(`rafi: phase ${"phase" in run && typeof run.phase === "string" ? run.phase : run.checkpoint}; status ${run.status}`);
        console.log(`rafi: supervisor ${supervisor?.status ?? "unavailable"}${supervisor?.pid ? ` pid=${supervisor.pid}` : ""}`);
        const attempts = db.recoveryAttempts(run.runId);
        console.log(`rafi: recovery attempts ${attempts.length}`);
        for (const decision of db.pendingHumanDecisions(run.runId)) console.log(`rafi: decision ${decision.decisionId}: ${decision.prompt} [${decision.choices.map((choice) => choice.id).join(" | ")}]`);
      } finally { db.close(); }
    });
}

export function buildDecideCommand(): Command {
  return new Command("build:decide")
    .description("Answer a durable supervised-build decision.")
    .argument("[project]", "project directory", ".")
    .requiredOption("--run <id>", "build run ID")
    .requiredOption("--decision <id>", "decision ID")
    .requiredOption("--choice <id>", "stable choice ID")
    .action((project: string, opts: { run: string; decision: string; choice: string }) => {
      const db = new WorkflowDb(resolve(project));
      try {
        const decision = db.answerHumanDecision(opts.run, opts.decision, opts.choice);
        console.log(`rafi: recorded ${decision.decisionId}=${opts.choice}`);
      } finally { db.close(); }
    });
}

export function buildStopCommand(): Command {
  return new Command("build:stop")
    .description("Request graceful termination of a supervised build.")
    .argument("[project]", "project directory", ".")
    .requiredOption("--run <id>", "build run ID")
    .action((project: string, opts: { run: string }) => {
      const db = new WorkflowDb(resolve(project));
      try {
        const state = db.supervisorState(opts.run);
        if (!state) throw new Error(`supervisor state not found for run ${opts.run}`);
        const next = { ...state, status: "stopping" as const, stopRequestedAt: new Date().toISOString() };
        db.putSupervisorState(opts.run, next);
        if (state.workerPid) { try { process.kill(state.workerPid, "SIGTERM"); } catch { /* stale worker */ } }
        if (state.pid && state.pid !== process.pid) { try { process.kill(state.pid, "SIGTERM"); } catch { /* stale supervisor */ } }
        console.log(`rafi: stop requested for ${opts.run}`);
      } finally { db.close(); }
    });
}
