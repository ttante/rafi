// Per-scenario PATH shims (plan choice C12): `codex` and `claude` (plus `.cmd` on Windows) with the script path
// baked in, so rafi never passes the fakes anything through its environment.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claudeRule } from "./claude/query.js";
import type { Behavior } from "./script/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKES = Object.freeze({ codex: path.join(here, "codex-cli.mjs"), claude: path.join(here, "claude-cli.mjs") });

export interface Shims {
  readonly bin: string;
  readonly codex: string;
  readonly claude: string;
  /** `.mjs` entry points the Agent SDK runs with node (pathToClaudeCodeExecutable). */
  readonly claudeEntry: string;
  readonly codexEntry: string;
  readonly logs: { codex: string; claude: string };
}

function entry(bin: string, name: "codex" | "claude", script: string): string {
  const file = path.join(bin, `${name}-entry.mjs`);
  writeFileSync(file, `import { main } from ${JSON.stringify(pathToFileURL(FAKES[name]).href)};\n` +
    `main(${JSON.stringify(script)});\n`);
  return file;
}

function executable(bin: string, name: string, entryFile: string): string {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(entryFile).href)});\n`);
  chmodSync(file, 0o755);
  if (process.platform === "win32") {
    writeFileSync(`${file}.cmd`, `@echo off\r\nnode "${entryFile}" %*\r\n`);
  }
  return file;
}

export function writeShims(dir: string, script: { codex: Behavior[]; claude: Behavior[] },
  o: { ps?: boolean } = {}): Shims {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const logs = { codex: path.join(dir, "codex.log.jsonl"), claude: path.join(dir, "claude.log.jsonl") };
  const codexScript = path.join(dir, "codex.script.json");
  const claudeScript = path.join(dir, "claude.script.json");
  const codexRules = script.codex.map((behavior) => ({ behavior }));
  writeFileSync(codexScript, JSON.stringify({ log: logs.codex, rules: codexRules, ps: Boolean(o.ps) }));
  writeFileSync(claudeScript, JSON.stringify({ log: logs.claude, rules: script.claude.map(claudeRule) }));
  const codexEntry = entry(bin, "codex", codexScript);
  const claudeEntry = entry(bin, "claude", claudeScript);
  return { bin, logs, codexEntry, claudeEntry, codex: executable(bin, "codex", codexEntry),
    claude: executable(bin, "claude", claudeEntry) };
}
