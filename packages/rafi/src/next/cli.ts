// runCli(argv, deps): the new CLI layer's entry (ARCH 8.1). A fresh Commander program per call, no globals,
// output through deps.terminal, never process.exit. Order (plan choice C13): dropped check → parse (version
// and help answered here) → find the project → format check → the command.
import { Command, CommanderError, Option } from "commander";
import { loadConfig, unfinishedLegacyBuild, type Deps } from "@rafi-ai/engine";
import { droppedRefusal } from "./commands/dropped.js";
import type { CommandSpec } from "./commands/spec.js";
import { actions } from "./commands/actions.js";
import { commands } from "./commands/table.js";
import { findProject, NEW_ENGINE_REFUSAL, readFormat, type FormatFs } from "./format.js";
import { legacyRunLine, line, notBuiltLine, storageLine } from "./ui/lines.js";

export const VERSION = "1.0.0-next.0";

interface Outcome {
  code: number;
}

function formatFs(deps: Deps): FormatFs {
  return {
    async readText(file) {
      const info = await deps.fs.stat(file);
      return info?.kind === "file" ? deps.fs.read(file) : null;
    },
    async isDir(dir) {
      return (await deps.fs.stat(dir))?.kind === "dir";
    },
  };
}

type Checked = { refusal: string } | { project: string | null };

async function checkProject(spec: CommandSpec, args: unknown[], argv: string[], deps: Deps): Promise<Checked> {
  const fs = formatFs(deps);
  const projectArg = spec.projectArg === undefined ? undefined : (args[spec.projectArg] as string | undefined);
  const project = await findProject(argv, deps.cwd, fs, projectArg);
  const refusal = await refuseProject(spec, project, fs, deps);
  return refusal ? { refusal } : { project };
}

async function refuseProject(spec: CommandSpec, project: string | null, fs: FormatFs, deps: Deps) {
  if (spec.noProject || spec.anyFormat) return null;
  if (!project) return line("No rafi project here (no rafi-config.yaml). Run `rafi create <project>` first.");
  const format = await readFormat(project, fs);
  if (format.format === "none") {
    return line(`No rafi-config.yaml in ${project}. Run \`rafi create <project>\` first.`);
  }
  if (format.format === "invalid") return line(format.message ?? "rafi-config.yaml is invalid.");
  if (format.format === "0.10.x") {
    const legacy = await unfinishedLegacyBuild(deps, project);
    return legacy ? legacyRunLine(legacy.runId) : line(NEW_ENGINE_REFUSAL);
  }
  const config = await loadConfig(deps.fs, project);
  if (!config.ok) return line(config.message);
  return null;
}

function addOptions(command: Command, spec: CommandSpec): void {
  for (const option of spec.options ?? []) {
    const built = new Option(option.flags, option.description);
    if (option.defaultValue !== undefined) built.default(option.defaultValue);
    if (option.repeat) built.argParser((value: string, previous?: string[]) => [...(previous ?? []), value]);
    command.addOption(built);
  }
}

function build(parent: Command, spec: CommandSpec, deps: Deps, argv: string[], outcome: Outcome, path: string) {
  const command = parent.command(spec.name).description(spec.summary);
  if (spec.args) command.arguments(spec.args);
  addOptions(command, spec);
  command.exitOverride();
  const name = path ? `${path} ${spec.name}` : spec.name;
  for (const sub of spec.subcommands ?? []) build(command, sub, deps, argv, outcome, name);
  if (spec.subcommands?.length) command.helpCommand(true);
  if (spec.subcommands?.length && !spec.milestone) return;
  command.action(async (...actionArgs: unknown[]) => {
    const checked = await checkProject(spec, actionArgs, argv, deps);
    if ("refusal" in checked) {
      deps.terminal.error(checked.refusal);
      outcome.code = 1;
      return;
    }
    const action = actions[name];
    if (action && checked.project) {
      try {
        outcome.code = await action({ deps, project: checked.project, args: actionArgs.slice(0, -2),
          opts: command.opts(), argv });
      } catch (error) {
        const said = storageLine(error, checked.project);
        if (!said) throw error;
        deps.terminal.error(said);
        outcome.code = 1;
      }
      return;
    }
    deps.terminal.error(notBuiltLine(name, spec.milestone ?? "M10"));
    outcome.code = 1;
  });
}

function program(deps: Deps, argv: string[], outcome: Outcome): Command {
  const root = new Command("rafi")
    .description("Interactive AI app engineering for Claude and Codex: plan, ticket and build with QA.")
    .version(VERSION, "-V, --version", "print the version")
    .helpOption("-h, --help", "show help")
    .showSuggestionAfterError(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => deps.terminal.write(text),
      writeErr: (text) => deps.terminal.error(text),
      outputError: (text, write) => write(line(text.replace(/^error: /, "").trimEnd())),
    });
  for (const spec of commands) build(root, spec, deps, argv, outcome, "");
  return root;
}

/** Parses argv and runs one command. Returns the exit code. */
export async function runCli(argv: string[], deps: Deps): Promise<number> {
  const dropped = droppedRefusal(argv);
  if (dropped) {
    deps.terminal.error(line(dropped.message));
    return 1;
  }
  const outcome: Outcome = { code: 0 };
  try {
    await program(deps, argv, outcome).parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 1;
    deps.terminal.error(line(`Internal error: ${(error as Error).message}`));
    return 1;
  }
  return outcome.code;
}
