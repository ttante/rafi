import { Command } from "commander";

/** Shared public options; the build command remains the sole semantic validator. */
export function addBuildRecoveryOptions(command: Command): Command {
  return command
    .option("--ticket <id>", "narrow mutation scope to one ticket while retaining run-wide context")
    .option("--qa-revision <number>", "exact durable QA protocol revision to resume")
    .option("--inspect", "show recovery state and planned actions without mutation")
    .option("--yes", "auto-approve the implementation plan and later plan updates for this resumed process")
    .option("--no", "review the implementation plan and later plan updates for this resumed process")
    .option("--fresh-with-handoff", "start a genuinely fresh session from validated cumulative context")
    .option("--fresh-session", "compatibility mode: ordinary fresh recovery without cumulative handoff")
    .option("--guided-recovery", "repair a degraded role checkpoint interactively, then start a validated successor")
    .option("--agent <runtime>", "fresh-mode provider (claude | codex)")
    .option("--model <model>", "fresh-mode model override");
}

export function buildRecoveryArguments(opts: Record<string, unknown>): string[] {
  const args: string[] = [];
  for (const option of addBuildRecoveryOptions(new Command()).options) {
    const value = opts[option.attributeName()];
    if (value === undefined || value === false) continue;
    args.push(option.long!);
    if (option.required) args.push(String(value));
  }
  return args;
}
