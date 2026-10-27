import { addBuildRecoveryOptions, buildRecoveryArguments } from "./buildRecoveryOptions.js";
import { Command } from "commander";
import { resolve } from "node:path";
import { projectBuildRecovery, recoverableBuildRuns } from "ai-foreman/build-runs.js";
import { completeInterview, discardInterview, findInterviewRecord, readInterviewRecords, type InterviewRecord } from "ai-foreman/interviews.js";
import { detectProjectLifecycle } from "./lifecycle.js";

export interface ResumeChoice {
  value: string;
  label: string;
  hint: string;
  updatedAt: string;
  kind: "build" | "interview";
  id: string;
  cleanupOnly?: boolean;
}

export function resumeChoices(projectDir: string): ResumeChoice[] {
  const builds = recoverableBuildRuns(projectDir).map(run => {
    const projection = projectBuildRecovery(projectDir, run);
    return { value: `build:${run.runId}`, kind: "build" as const, id: run.runId, updatedAt: run.updatedAt, cleanupOnly: run.cleanupOnly,
      label: `Build ${run.runId.slice(0, 8)} — ${run.cleanupOnly ? "Readiness cleanup only (no build replay)" : projection.compactLabel}`,
      hint: `${run.active ? "verified process active; " : run.ownership === "unknown" ? `ownership unknown: ${run.ownershipReason}; ` : ""}${projection.compactHint}` };
  });
  const interviews = readInterviewRecords(projectDir).records.filter(record => record.status !== "completed").map(record => ({
    cleanupOnly: false, value: `interview:${record.id}`, kind: "interview" as const, id: record.id, updatedAt: record.updatedAt,
    label: `${record.workflow} — ${record.checkpoint} — ${record.status}${record.failure?.summary ? `: ${record.failure.summary}` : ""}`, hint: record.updatedAt,
  }));
  return [...builds, ...interviews].sort((a, b) => Number(a.cleanupOnly ?? false) - Number(b.cleanupOnly ?? false) || b.updatedAt.localeCompare(a.updatedAt) || a.value.localeCompare(b.value));
}

export function buildResumeCommand(options: {
  resumeBuild: (args: string[]) => Promise<void>;
  resumeInterview: (projectDir: string, record: InterviewRecord, options?: { yes?: boolean }) => Promise<void>;
  select?: (choices: ResumeChoice[]) => Promise<string | undefined>;
}): Command {
  return addBuildRecoveryOptions(new Command("resume")
    .description("Select an unfinished build or saved create, plan, or ticket-setup interview to resume.")
    .argument("[project]", "path to the target repo", ".")
    .option("--run <id>", "build run ID or unique prefix")
    .option("--id <id>", "saved interview id (or unique prefix) to resume")
    .option("--discard <id>", "discard a saved interview id (or unique prefix)"))
    .action(async (project: string, opts) => {
      if ([opts.run, opts.id, opts.discard].filter(Boolean).length > 1) throw new Error("choose only one of --run, --id, or --discard");
      const projectDir = resolve(project);
      const recoveryArgs = buildRecoveryArguments(opts);
      // --yes also applies to saved interviews; other build recovery options do not.
      const buildOnlyArgs = recoveryArgs.filter(arg => arg !== "--yes");
      if (buildOnlyArgs.length && (opts.id || opts.discard)) throw new Error("Build recovery options cannot be used with an interview operation");
      if (opts.discard) {
        if (!discardInterview(projectDir, String(opts.discard))) throw new Error(`interview not found: ${opts.discard}`);
        console.log(`rafi resume: discarded ${opts.discard}`);
        return;
      }
      if (opts.run) return options.resumeBuild([projectDir, "--run", String(opts.run), ...recoveryArgs]);
      let record = opts.id ? findInterviewRecord(projectDir, String(opts.id)) : undefined;
      if (!opts.id) {
        const choices = resumeChoices(projectDir);
        if (!choices.length) { console.log("rafi resume: no unfinished builds or interviews found"); return; }
        let chosen: string | undefined;
        const resumable = choices.filter(choice => !choice.cleanupOnly);
        if (options.select) chosen = await options.select(choices);
        else if (opts.yes && resumable.length) {
          // --yes never stops to ask: resume the most recently updated unfinished item.
          chosen = resumable[0]!.value;
          console.log(`rafi resume: resuming the most recent unfinished item (${resumable[0]!.label})${resumable.length > 1 ? `; ${resumable.length - 1} other(s) remain, see rafi resume` : ""}`);
        } else {
          if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("provide --run <id> or --id <id> when stdin/stdout is not a TTY");
          const { select, isCancel } = await import("@clack/prompts");
          const answer = await select({ message: "What should Rafi resume?", options: choices });
          if (!isCancel(answer)) chosen = answer;
        }
        if (!chosen) return;
        const choice = choices.find(item => item.value === chosen);
        if (!choice) throw new Error("selected resume entry is no longer available");
        if (choice.kind === "build") return options.resumeBuild([projectDir, "--run", choice.id, ...recoveryArgs]);
        if (buildOnlyArgs.length) throw new Error("Build recovery options cannot be used with an interview operation");
        record = findInterviewRecord(projectDir, choice.id);
      }
      if (!record) throw new Error(`interview not found: ${opts.id}`);
      if (record.status === "incompatible") throw new Error(`interview ${record.id} uses an incompatible state version; use --discard ${record.id} to remove it`);
      if (record.workflow === "create" && record.checkpoint === "ticket-setup-prompt" && detectProjectLifecycle(projectDir).state === "initialized") {
        completeInterview(projectDir, record);
        console.log("rafi resume: setup is already complete; the saved create walkthrough is now closed.");
        return;
      }
      console.log(`rafi resume: ${record.workflow} at ${record.checkpoint}`);
      if (record.runtime.sessionId) console.log(`rafi resume: saved ${record.runtime.runtime ?? "agent"} session ${record.runtime.sessionId} will be requested by the workflow.`);
      else if (record.checkpoint === "agent-run") console.log("rafi resume: the prior agent session is unavailable; the workflow will start a fresh session with the saved brief and answers.");
      await options.resumeInterview(projectDir, record, { yes: Boolean(opts.yes) });
    });
}
