import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export type RecoveryCommandFamily = "rafi" | "ai-foreman";
const commandFamily = new AsyncLocalStorage<RecoveryCommandFamily>();
export function withRecoveryCommandFamily<T>(family: RecoveryCommandFamily, work: () => T): T { return commandFamily.run(family, work); }
export function shellArgument(value: string, platform = process.platform): string {
  if (platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}
function canonical(path: string): string { try { return realpathSync(resolve(path)); } catch { return resolve(path); } }
/** POSIX shell command (PowerShell on Windows). The owning project is supplied explicitly, never a QA snapshot. */
export function formatRecoveryCommand(projectDir: string, family: RecoveryCommandFamily = commandFamily.getStore() ?? "rafi", cwd = process.cwd(), session?: { id: string; steps: number }): string {
  if (family === "ai-foreman") {
    if (session) return `ai-foreman start ${shellArgument(resolve(projectDir))} --steps ${session.steps} --resume ${shellArgument(session.id)}`;
    return `ai-foreman manager ${shellArgument(resolve(projectDir))}`;
  }
  return canonical(projectDir) === canonical(cwd) ? "rafi resume" : `rafi resume ${shellArgument(resolve(projectDir))}`;
}

/** Fixed choices are executable; custom answers use the owning CLI's input flow. */
export function formatDecisionCommands(projectDir: string, runId: string, decision: { decisionId: string; choices: Array<{ id: string; label: string }> }, family: RecoveryCommandFamily = commandFamily.getStore() ?? "rafi"): string[] {
  return decision.choices.flatMap(choice => choice.id === "custom"
    ? [family === "ai-foreman"
      ? `  Custom response: use ${family} build:decide ${shellArgument(resolve(projectDir))} --run ${shellArgument(runId)} --decision ${shellArgument(decision.decisionId)} --choice custom with --answer followed by your shell-quoted response.`
      : `  Custom response: run ${formatExactRunRecovery(projectDir, runId, family)} in an interactive terminal.`]
    : [`  ${choice.label}`, `  ${family} build:decide ${shellArgument(resolve(projectDir))} --run ${shellArgument(runId)} --decision ${shellArgument(decision.decisionId)} --choice ${shellArgument(choice.id)}`]);
}
export function formatExactRunRecovery(projectDir: string, runId: string, family: RecoveryCommandFamily = commandFamily.getStore() ?? "rafi"): string {
  if (family === "ai-foreman") return `ai-foreman manager ${shellArgument(resolve(projectDir))} --run ${shellArgument(runId)}`;
  return `rafi resume ${shellArgument(resolve(projectDir))} --run ${shellArgument(runId)}`;
}
