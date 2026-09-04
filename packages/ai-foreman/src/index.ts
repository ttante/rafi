#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { buildTicketsCommand } from "./cli/tickets.js";
import { buildStartCommand } from "./cli/start.js";
import { buildStatusCommand } from "./cli/status.js";
import { buildDoctorCommand } from "./cli/doctor.js";
import { buildManagerCommand } from "./cli/manager.js";
import { buildAttachCommand, buildDecideCommand, buildStopCommand } from "./cli/recovery.js";
import { withActivityContext } from "./activity.js";

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
)?.version as string;

const program = new Command();
program
  .name("ai-foreman")
  .description("Keep Codex / Claude Code builders moving through their step list.")
  .version(PACKAGE_VERSION);

program.addCommand(buildTicketsCommand());
program.addCommand(buildStartCommand());
program.addCommand(buildStatusCommand());
program.addCommand(buildDoctorCommand());
program.addCommand(buildManagerCommand({ requireProject: true }));
program.addCommand(buildAttachCommand());
program.addCommand(buildDecideCommand());
program.addCommand(buildStopCommand());

// pnpm passes its `--` separator through to the script; strip it so Commander
// sees the subcommand args correctly.
const argv = [...process.argv];
if (argv[2] === "--") argv.splice(2, 1);
const command = argv.slice(2).filter((arg) => !arg.startsWith("-")).slice(0, 3).join(" ") || "ai-foreman";
withActivityContext(command, () => program.parseAsync(argv)).catch((err) => {
  console.error(`foreman: ${String(err)}`);
  process.exit(1);
});
