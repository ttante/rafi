import { Command } from "commander";
import { resolve } from "node:path";
import { buildRecoveryPreview, recoverableBuildRuns } from "ai-foreman/build-runs.js";
import type { BuildRunRecordV1 } from "rafi-spec";
import { assertLifecycleForCommand } from "./lifecycle.js";

type RecoverableRun = BuildRunRecordV1 & { active: boolean };

export interface BuildResumeCommandOptions {
  executeStart: (args: string[]) => Promise<number> | number;
}

export function buildBuildResumeCommand(commandOpts: BuildResumeCommandOptions): Command {
  return new Command("build:resume")
    .description("Inspect and resume one interrupted implementation run without discarding partial work.")
    .argument("[project]", "project directory", ".")
    .option("--run <id>", "run ID or unique prefix")
    .option("--ticket <id>", "select a recoverable run by ticket")
    .option("--inspect", "show recovery state and planned actions without mutation")
    .option("--yes", "accept the recovery preview (requires --run or --ticket)")
    .option("--fresh-session", "start a new provider session with compact saved context")
    .option("--agent <runtime>", "switch provider for a fresh session only (claude | codex)")
    .action(async (project: string, opts: Record<string, unknown>) => {
      const root = resolve(project);
      assertLifecycleForCommand(root, "build-resume");
      if (opts.agent && !opts.freshSession) throw new Error("--agent is accepted only with --fresh-session because provider sessions cannot switch runtimes");
      if (opts.agent && !["claude", "codex"].includes(String(opts.agent))) throw new Error("--agent must be claude or codex");
      const runs = recoverableBuildRuns(root);
      if (runs.length === 0) {
        console.log("rafi build:resume: no unfinished or recoverable runs found");
        return;
      }
      let selected = selectByFlags(runs, opts);
      if (!selected) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("provide --run <id> or --ticket <id> when not running in a TTY");
        const { select, isCancel } = await import("@clack/prompts");
        const answer = await select({
          message: "Which interrupted build should Rafi recover?",
          options: runs.map((run) => ({
            value: run.runId,
            label: `${run.runId.slice(0, 8)} — ${run.currentTicket ?? run.tickets[0] ?? "unknown"} — ${run.checkpoint}`,
            hint: `${run.active ? "active" : "interrupted"}; ${run.builder?.settings.make ?? "runtime unknown"}; ${run.repository.branch ?? "current branch"}; ${run.updatedAt}`,
          })),
        });
        if (isCancel(answer)) return;
        selected = runs.find((run) => run.runId === answer);
      }
      if (!selected) throw new Error("recoverable run not found");
      console.log("rafi build:resume preview:");
      for (const line of buildRecoveryPreview(selected)) console.log(`  ${line}`);
      if (selected.active) {
        console.log("rafi build:resume: the original process is verified live; return to it or stop it before recovery. No mutation was performed.");
        return;
      }
      if (opts.inspect) return;

      let fresh = Boolean(opts.freshSession);
      if (!opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
        const { select, isCancel } = await import("@clack/prompts");
        const exact = Boolean(selected.builder?.sessionId);
        const choice = await select({ message: "How should Rafi continue?", options: [
          ...(exact ? [{ value: "exact", label: "Resume exact Builder session (Recommended)" }] : []),
          { value: "fresh", label: `${exact ? "Start" : "Use"} a fresh session (conversation continuity will be lost)` },
          { value: "cancel", label: "Cancel" },
        ] });
        if (isCancel(choice) || choice === "cancel") return;
        fresh = choice === "fresh";
      } else if (!fresh && !selected.builder?.sessionId) {
        throw new Error("this run has no captured session ID; rerun with --fresh-session");
      }

      const args = ["start", root, "--steps", "1", "--yes"];
      if (selected.branchMode !== "current") args.push("--branch-per-ticket", "--ticket", selected.currentTicket ?? selected.tickets[0]!);
      if (!fresh && selected.builder?.sessionId) args.push("--resume", selected.builder.sessionId);
      else if (selected.branchMode !== "current") args.push("--continue");
      if (fresh && opts.agent) args.push("--agent", String(opts.agent));
      else if (selected.builder?.settings.make) args.push("--agent", selected.builder.settings.make);
      if (selected.builder?.settings.model && selected.builder.settings.model !== "default") args.push("--model", selected.builder.settings.model);
      if (selected.builder?.settings.reasoning && selected.builder.settings.reasoning !== "default") args.push("--effort", selected.builder.settings.reasoning);
      if (selected.builder?.settings.fast) args.push("--fast");
      const code = await commandOpts.executeStart(args);
      if (code !== 0) throw new Error(`build recovery exited with status ${code}`);
    });
}

function selectByFlags(runs: RecoverableRun[], opts: Record<string, unknown>): RecoverableRun | undefined {
  if (opts.run && opts.ticket) throw new Error("choose either --run or --ticket");
  if (opts.yes && !opts.run && !opts.ticket) throw new Error("--yes requires --run or --ticket");
  const matches = opts.run
    ? runs.filter((run) => run.runId === opts.run || run.runId.startsWith(String(opts.run)))
    : opts.ticket
      ? runs.filter((run) => run.currentTicket === opts.ticket || run.tickets.includes(String(opts.ticket)))
      : [];
  if (matches.length > 1) throw new Error("selection is ambiguous; provide a longer run ID");
  return matches[0];
}
