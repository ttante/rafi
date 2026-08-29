import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { buildTicketsCommand } from "ai-foreman/cli/tickets.js";
import { buildStartCommand } from "ai-foreman/cli/start.js";
import { buildStatusCommand } from "ai-foreman/cli/status.js";
import { buildDoctorCommand } from "ai-foreman/cli/doctor.js";
import { program } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const docsPath = resolve(root, "docs/cli.md");
const check = process.argv.includes("--check");

function commandByPath(names: string[], rootCommand: Command = program) {
  let command = rootCommand;
  for (const name of names) {
    const child = command.commands.find((candidate) => candidate.name() === name);
    if (!child) throw new Error(`missing Commander command: ${names.join(" ")}`);
    command = child;
  }
  return command;
}

// Build the standalone command tree without importing its executable entry
// point (which intentionally parses process.argv as a side effect).
const foremanProgram = new Command().name("ai-foreman").description("Keep Codex / Claude Code builders moving through their step list.");
foremanProgram.addCommand(buildTicketsCommand());
foremanProgram.addCommand(buildStartCommand());
foremanProgram.addCommand(buildStatusCommand());
foremanProgram.addCommand(buildDoctorCommand());

const cases: Array<[string, Command]> = [
  ["rafi --help", program],
  ["rafi resume --help", commandByPath(["resume"])],
  ["rafi create --help", commandByPath(["create"])],
  ["rafi compile --help", commandByPath(["compile"])],
  ["rafi plan --help", commandByPath(["plan"])],
  ["rafi sources --help", commandByPath(["sources"])],
  ["rafi sources list --help", commandByPath(["sources", "list"])],
  ["rafi sources refresh --help", commandByPath(["sources", "refresh"])],
  ["rafi sources remove --help", commandByPath(["sources", "remove"])],
  ["rafi sources storage --help", commandByPath(["sources", "storage"])],
  ["rafi tickets --help", commandByPath(["tickets"])],
  ["rafi tickets plan --help", commandByPath(["tickets", "plan"])],
  ["rafi tickets init --help", commandByPath(["tickets", "init"])],
  ["rafi tickets setup:init --help", commandByPath(["tickets", "setup:init"])],
  ["rafi tickets setup:update --help", commandByPath(["tickets", "setup:update"])],
  ["rafi tickets populate --help", commandByPath(["tickets", "populate"])],
  ["rafi tickets queue --help", commandByPath(["tickets", "queue"])],
  ["rafi tickets groups --help", commandByPath(["tickets", "groups"])],
  ["rafi tickets groups list --help", commandByPath(["tickets", "groups", "list"])],
  ["rafi tickets groups repair --help", commandByPath(["tickets", "groups", "repair"])],
  ["rafi tickets reset --help", commandByPath(["tickets", "reset"])],
  ["rafi build:resume --help", commandByPath(["build:resume"])],
  ["rafi handoffs --help", commandByPath(["handoffs"])],
  ["rafi handoffs inspect --help", commandByPath(["handoffs", "inspect"])],
  ["rafi handoffs prune-cache --help", commandByPath(["handoffs", "prune-cache"])],
  ["rafi handoffs delete-history --help", commandByPath(["handoffs", "delete-history"])],
  ["rafi agents --help", commandByPath(["agents"])],
  ["rafi uninstall --help", commandByPath(["uninstall"])],
  ["rafi start --help", commandByPath(["start"])],
  ["rafi doctor --help", commandByPath(["doctor"])],
  ["ai-foreman --help", foremanProgram],
  ["ai-foreman tickets --help", commandByPath(["tickets"], foremanProgram)],
  ["ai-foreman start --help", commandByPath(["start"], foremanProgram)],
  ["ai-foreman status --help", commandByPath(["status"], foremanProgram)],
  ["ai-foreman doctor --help", commandByPath(["doctor"], foremanProgram)],
];

let docs = readFileSync(docsPath, "utf8");
for (const [heading, command] of cases) {
  const block = `### \`${heading}\`\n\n\`\`\`text\n${command.helpInformation().trimEnd()}\n\`\`\``;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("### `" + escaped + "`\\n\\n```text\\n[\\s\\S]*?\\n```");
  if (pattern.test(docs)) docs = docs.replace(pattern, block);
  else docs = `${docs.trimEnd()}\n\n${block}\n`;
}

const current = readFileSync(docsPath, "utf8");
if (check) {
  if (docs !== current) {
    console.error("docs/cli.md is stale; run `pnpm docs:generate`");
    process.exitCode = 1;
  }
} else {
  writeFileSync(docsPath, docs, "utf8");
}
