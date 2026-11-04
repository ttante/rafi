// Per-scenario PATH shims (plan choice C12): `codex` and `claude` (plus `.cmd` on Windows) with the script path
// baked in, so rafi never passes the fakes anything through its environment.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claudeRule } from "./claude/query.js";
import type { Behavior } from "./script/engine.js";
import { parseRule, type Selector } from "./script/parse.js";

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

/** A behavior the fake executable makes from the turn (match.mjs `behaviorOf`), with an optional host kill. */
export type Make = { kind: "happy" | "reject" | "slow"; notes?: Record<number, string>; ms?: number; every?: number;
  kill?: "before-reply" | "after-reply";
  /** The fake doesn't take rafi's cancel during this turn (only a second Ctrl+C, which ends it, stops it). */
  ignoreCancel?: boolean;
  /** An activity line at the start of the turn. */
  say?: string };

/** A process-mode rule (P8 option C): a selector and a plain behavior or a made one. */
export interface ProcessRule {
  readonly selector: Selector;
  readonly behavior?: Behavior;
  readonly make?: Make;
}

/** `pOn("qa T2#1 @review", { kind: "reject", notes: { 1: "not yet" } })` or `pOn("builder T3#1", { raw: "x" })`. */
export function pOn(selector: string, b: Behavior | Make): ProcessRule {
  const parsed = parseRule(`${selector}: x`).selector;
  return "kind" in b ? { selector: parsed, make: b as Make } : { selector: parsed, behavior: b as Behavior };
}

export function writeShims(dir: string, script: { codex: Behavior[]; claude: Behavior[] } | { rules: ProcessRule[] },
  o: { ps?: boolean } = {}): Shims {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const logs = { codex: path.join(dir, "codex.log.jsonl"), claude: path.join(dir, "claude.log.jsonl") };
  const codexScript = path.join(dir, "codex.script.json");
  const claudeScript = path.join(dir, "claude.script.json");
  if ("rules" in script) {
    // Both fakes share one rule list and one used-rules file (match.mjs), as the in-process fakes share a computer.
    const shared = path.join(dir, "rules.script.json");
    writeFileSync(shared, JSON.stringify({ rules: script.rules }));
    writeFileSync(codexScript, JSON.stringify({ log: logs.codex, match: "identity", shared, rules: script.rules,
      ps: Boolean(o.ps) }));
    writeFileSync(claudeScript, JSON.stringify({ log: logs.claude, match: "identity", shared, rules: script.rules }));
  } else {
    const codexRules = script.codex.map((behavior) => ({ behavior }));
    writeFileSync(codexScript, JSON.stringify({ log: logs.codex, rules: codexRules, ps: Boolean(o.ps) }));
    writeFileSync(claudeScript, JSON.stringify({ log: logs.claude, rules: script.claude.map(claudeRule) }));
  }
  const codexEntry = entry(bin, "codex", codexScript);
  const claudeEntry = entry(bin, "claude", claudeScript);
  return { bin, logs, codexEntry, claudeEntry, codex: executable(bin, "codex", codexEntry),
    claude: executable(bin, "claude", claudeEntry) };
}
