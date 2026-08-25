import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { program } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const docsPath = resolve(root, "docs/cli.md");
const check = process.argv.includes("--check");

function commandByPath(names: string[]) {
  let command = program;
  for (const name of names) {
    const child = command.commands.find((candidate) => candidate.name() === name);
    if (!child) throw new Error(`missing Commander command: ${names.join(" ")}`);
    command = child;
  }
  return command;
}

const cases: Array<[string, typeof program]> = [
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
  ["rafi build:resume --help", commandByPath(["build:resume"])],
  ["rafi agents --help", commandByPath(["agents"])],
  ["rafi uninstall --help", commandByPath(["uninstall"])],
  ["rafi start --help", commandByPath(["start"])],
  ["rafi doctor --help", commandByPath(["doctor"])],
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
