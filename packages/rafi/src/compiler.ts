import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { stringify } from "yaml";
import {
  emitCodexAgents,
  emitMappedClaudeAgents,
  emitSkills,
  emitCompiledBundles,
  renderAgentsMd,
  renderClaudeMd,
  type Defaults,
} from "special-agents";
import type { AgentRole, HarnessTarget, ProjectConfig, ProjectFlags } from "rafi-spec";
import { copyDocs, validateDocsRoot, type CopyDocsOptions } from "./docs.js";
import { DEFAULT_DOCS_ROOT, RAFI_CONFIG_FILE } from "./project.js";
import { capturePreimage, finalizeOwnedWrite, registerOwnedFile } from "./ownership.js";

const RAFI_APPEND_START = "<!-- rafi:start -->";
const RAFI_APPEND_END = "<!-- rafi:end -->";
const CLAUDE_APPEND_CHAR_LIMIT = 40_000;
const CODEX_APPEND_BYTE_LIMIT = 32 * 1024;
const ROOT_FILE_MODES = ["append", "update", "overwrite"] as const;
export type AgentRuntime = "claude" | "codex";

export interface CompileProjectOptions extends CopyDocsOptions {
  /** Skip doc copying entirely (useful in tests that don't need docs). */
  skipDocs?: boolean;
  /** Skip native skill/subagent files; useful when compile should only refresh runtime bundles. */
  skipNativeArtifacts?: boolean;
  /** Override agent_files.mode for this compile only. */
  rootFileMode?: ProjectConfig["agent_files"]["mode"];
}

export interface RuntimeUpdateErrorOptions {
  runtime: AgentRuntime;
  targetFile: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  cause?: unknown;
}

export class RuntimeUpdateError extends Error {
  readonly runtime: AgentRuntime;
  readonly targetFile: string;
  readonly exitCode?: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly authLikely: boolean;

  constructor(opts: RuntimeUpdateErrorOptions) {
    super(formatRuntimeUpdateFailure(opts), { cause: opts.cause });
    this.name = "RuntimeUpdateError";
    this.runtime = opts.runtime;
    this.targetFile = opts.targetFile;
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout ?? "";
    this.stderr = opts.stderr ?? "";
    this.authLikely = isRuntimeAuthFailure(`${this.stderr}\n${this.stdout}`);
  }
}

/** Map a ProjectConfig to the Defaults shape special-agents compile functions expect. */
export function projectConfigToDefaults(config: ProjectConfig): Defaults {
  return {
    stack: config.stack as unknown as Record<string, string>,
    flags: config.flags as unknown as Record<string, boolean>,
    docsRoot: config.docs?.root ?? DEFAULT_DOCS_ROOT,
  };
}

/** Map ProjectFlags to the ConditionFlags shape (for role-specific compilation). */
function flagsToConditions(flags: ProjectFlags) {
  return {
    ai: flags.usesAI,
    frontend: flags.hasFrontend,
    cloud: flags.runsInCloud,
  };
}

/**
 * Full compile: write AGENTS.md, CLAUDE.md, lean Claude agents,
 * compiled role bundles, and (optionally) starter docs to `targetDir`.
 */
export function compile(targetDir: string, config: ProjectConfig, opts: CompileProjectOptions = {}): void {
  const docsRoot = validateDocsRoot(targetDir, config.docs?.root ?? DEFAULT_DOCS_ROOT);
  const defaults = { ...projectConfigToDefaults(config), docsRoot };
  const conditions = flagsToConditions(config.flags);
  const targets = runtimeTargets(config);
  validateExistingArtifacts(targetDir, config, targets);
  const skillNames = configuredSkillNames(config, targets);
  const rootFileMode = opts.rootFileMode ?? config.agent_files.mode;

  // Target-native root instruction files.
  if (targets.includes("codex")) {
    writeInstructionFile(targetDir, config.agent_files.codex, renderAgentsMd({ defaults }), rootFileMode, "codex");
  }
  if (targets.includes("claude")) {
    const claudeRoot = targets.includes("codex")
      ? renderClaudeMd({ defaults })
      : renderStandaloneClaudeMd({ defaults });
    writeInstructionFile(targetDir, config.agent_files.claude, claudeRoot, rootFileMode, "claude");
  }

  // Target-native subagent and skill files (role-filtered).
  if (!opts.skipNativeArtifacts) {
    const rafiOwnedAgentRoles = rafiOwnedNames(config.agents) as AgentRole[];
    const rafiOwnedSkillNames = rafiOwnedNames(config.skills);
    if (targets.includes("claude")) {
      emitMappedClaudeAgents(targetDir, {
        defaults,
        conditions,
        roles: rafiOwnedAgentRoles,
        force: true,
        paths: rafiOwnedPaths(config.agents, "claude"),
      });
      emitSkills(targetDir, {
        names: rafiOwnedSkillNames,
        force: true,
        paths: rafiOwnedPaths(config.skills, "claude"),
      });
    }
    if (targets.includes("codex")) {
      emitCodexAgents(targetDir, {
        defaults,
        conditions,
        roles: rafiOwnedAgentRoles,
        force: true,
        paths: rafiOwnedPaths(config.agents, "codex"),
      });
      emitSkills(targetDir, {
        names: rafiOwnedSkillNames,
        force: true,
        paths: rafiOwnedPaths(config.skills, "codex"),
      });
    }
  }

  // Compiled role bundles for foreman (role-filtered)
  emitCompiledBundles(targetDir, { defaults, conditions, skillNames });

  for (const [name, paths] of Object.entries(config.agents)) {
    if (paths.artifact_source !== "rafi") continue;
    for (const target of targets) registerOwnedFile(targetDir, paths[target], { mode: "generated", origin: `compile:agent:${name}` });
    registerCompiledRole(targetDir, name);
  }
  for (const [name, paths] of Object.entries(config.skills)) {
    if (paths.artifact_source !== "rafi") continue;
    for (const target of targets) registerOwnedFile(targetDir, paths[target], { mode: "generated", origin: `compile:skill:${name}` });
  }

  // Starter docs (flag-gated)
  if (!opts.skipDocs) {
    copyDocs(targetDir, config.flags, { force: opts.force, docsRoot });
  }
}

/**
 * Write `rafi-config.yaml` to `<targetDir>/rafi-config.yaml`. Creates the directory
 * if it does not exist.
 */
export function writeRafiConfigYaml(targetDir: string, config: ProjectConfig): void {
  mkdirSync(targetDir, { recursive: true });
  const ownership = capturePreimage(targetDir, RAFI_CONFIG_FILE, "configuration");
  writeFileSync(join(targetDir, RAFI_CONFIG_FILE), stringify(config), "utf8");
  finalizeOwnedWrite(targetDir, ownership);
}

export const writeProjectYaml = writeRafiConfigYaml;

function renderStandaloneClaudeMd(opts: { defaults: Defaults }): string {
  return renderAgentsMd(opts).replace(
    "For Codex, copy this content into the repository root as `AGENTS.md`.\n" +
    "For Claude Code, create a repository-root `CLAUDE.md` that imports the same rules:\n\n" +
    "```md\n@AGENTS.md\n```\n\n",
    "This `CLAUDE.md` contains the canonical project instruction source for Claude Code.\n\n",
  );
}

function writeInstructionFile(
  targetDir: string,
  relPath: string,
  generated: string,
  mode: ProjectConfig["agent_files"]["mode"],
  runtime: AgentRuntime,
): void {
  const path = join(targetDir, relPath);
  mkdirSync(dirname(path), { recursive: true });
  const ownership = capturePreimage(targetDir, relPath, `compile:root:${runtime}`);
  if (!existsSync(path) || mode === "overwrite") {
    writeFileSync(path, generated, "utf8");
    finalizeOwnedWrite(targetDir, ownership);
    return;
  }
  if (mode === "append") {
    writeAppendInstructionFile(targetDir, relPath, generated, runtime);
    finalizeOwnedWrite(targetDir, { ...ownership, mode: "managed-block", marker: `${RAFI_APPEND_START}..${RAFI_APPEND_END}` });
    return;
  }
  updateInstructionFileWithAgent(targetDir, relPath, generated, runtime);
  finalizeOwnedWrite(targetDir, ownership);
}

function registerCompiledRole(targetDir: string, role: string): void {
  for (const file of ["system.md", "meta.json"]) {
    const path = `.rafi/compiled/${role}/${file}`;
    if (existsSync(join(targetDir, path))) registerOwnedFile(targetDir, path, { mode: "generated", origin: `compile:bundle:${role}` });
  }
}

function writeAppendInstructionFile(
  targetDir: string,
  relPath: string,
  generated: string,
  runtime: AgentRuntime,
): void {
  const rootPath = join(targetDir, relPath);
  const existing = readFileSync(rootPath, "utf8");
  const inlineBlock = rafiAppendBlock(generated);
  const inlineContent = replaceOrInsertManagedBlock(existing, inlineBlock, "end");
  const sidecarRelPath = sidecarPathForRootInstruction(relPath);
  const sidecarFileName = basename(sidecarRelPath);
  const stickySidecar = managedBlockReferencesSidecar(existing, sidecarFileName);

  if (!stickySidecar && !exceedsAppendLimit(runtime, inlineContent)) {
    writeFileSync(rootPath, inlineContent, "utf8");
    return;
  }

  const sidecarPath = join(targetDir, sidecarRelPath);
  validateRafiSidecar(sidecarPath, sidecarRelPath);
  mkdirSync(dirname(sidecarPath), { recursive: true });
  writeFileSync(sidecarPath, generated, "utf8");
  registerOwnedFile(targetDir, sidecarRelPath, { mode: "generated", origin: `compile:sidecar:${runtime}` });
  const referenceBlock = rafiAppendReferenceBlock(runtime, sidecarFileName);
  const referenceContent = replaceOrInsertManagedBlock(existing, referenceBlock, "top");
  writeFileSync(rootPath, referenceContent, "utf8");
}

function rafiAppendBlock(generated: string): string {
  const date = new Date().toISOString();
  return `${RAFI_APPEND_START}\nUpdated Content, generated by @rafi/cli on ${date}\n\n${generated.trimEnd()}\n${RAFI_APPEND_END}\n`;
}

function rafiAppendReferenceBlock(runtime: AgentRuntime, sidecarFileName: string): string {
  const date = new Date().toISOString();
  const reference = runtime === "claude"
    ? [
      `Rafi-generated guidance is in \`${sidecarFileName}\`. Claude Code should import it from:`,
      "",
      `@${sidecarFileName}`,
    ].join("\n")
    : [
      `Rafi-generated guidance is in \`${sidecarFileName}\`. Read \`${sidecarFileName}\` before planning or editing in this repository.`,
      "",
      `@${sidecarFileName}`,
    ].join("\n");
  return `${RAFI_APPEND_START}\nUpdated Content, generated by @rafi/cli on ${date}\n\n${reference}\n${RAFI_APPEND_END}\n`;
}

export function sidecarPathForRootInstruction(relPath: string): string {
  const match = /^(.*?)([^/\\]+)$/.exec(relPath);
  if (!match) return `${relPath}-rafi`;
  const [, dir, file] = match;
  const dot = file.lastIndexOf(".");
  if (dot > 0) {
    return `${dir}${file.slice(0, dot)}-rafi${file.slice(dot)}`;
  }
  return `${dir}${file}-rafi`;
}

export function appendLimitForRuntime(runtime: AgentRuntime): number {
  return runtime === "claude" ? CLAUDE_APPEND_CHAR_LIMIT : CODEX_APPEND_BYTE_LIMIT;
}

export function exceedsAppendLimit(runtime: AgentRuntime, content: string): boolean {
  const size = runtime === "claude" ? content.length : Buffer.byteLength(content, "utf8");
  return size > appendLimitForRuntime(runtime);
}

function replaceOrInsertManagedBlock(existing: string, block: string, placement: "end" | "top"): string {
  const managedBlock = rafiManagedBlockRegExp();
  if (managedBlock.test(existing)) {
    if (placement === "top") {
      return insertManagedBlockNearTop(existing.replace(managedBlock, ""), block);
    }
    return existing.replace(managedBlock, block);
  }
  if (placement === "top") {
    return insertManagedBlockNearTop(existing, block);
  }
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${block}`;
}

function insertManagedBlockNearTop(existing: string, block: string): string {
  const insertionIndex = topManagedBlockInsertionIndex(existing);
  const before = existing.slice(0, insertionIndex);
  const after = existing.slice(insertionIndex);
  const afterSeparator = after.length === 0 || after.startsWith("\n") || after.startsWith("\r\n") ? "" : "\n";
  return `${before}${block}${afterSeparator}${after}`;
}

function topManagedBlockInsertionIndex(existing: string): number {
  const bomLength = existing.startsWith("\uFEFF") ? 1 : 0;
  const frontmatter = /^---[ \t]*(?:\r?\n)(?:[\s\S]*?(?:\r?\n))?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(
    existing.slice(bomLength),
  );
  if (frontmatter) return bomLength + frontmatter[0].length;
  return bomLength;
}

function managedBlockReferencesSidecar(existing: string, sidecarFileName: string): boolean {
  const block = existing.match(rafiManagedBlockRegExp())?.[0] ?? "";
  return block.includes(`@${sidecarFileName}`) || block.includes(`\`${sidecarFileName}\``);
}

function validateRafiSidecar(sidecarPath: string, sidecarRelPath: string): void {
  if (!existsSync(sidecarPath)) return;
  const existing = readFileSync(sidecarPath, "utf8");
  if (isRafiGeneratedSidecar(existing)) return;
  throw new Error(
    `Refusing to overwrite existing ${sidecarRelPath}. ` +
    "Rafi append overflow sidecars must be missing or clearly Rafi-generated.",
  );
}

export function isRafiGeneratedSidecar(content: string): boolean {
  return content.startsWith("# rafi:");
}

function rafiManagedBlockRegExp(): RegExp {
  return new RegExp(`${escapeRegExp(RAFI_APPEND_START)}[\\s\\S]*?${escapeRegExp(RAFI_APPEND_END)}\\n?`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateInstructionFileWithAgent(
  targetDir: string,
  relPath: string,
  generated: string,
  runtime: AgentRuntime,
): void {
  const prompt =
    `Update ${relPath} in this repository.\n\n` +
    "Preserve useful existing project-specific guidance, remove stale or conflicting guidance, " +
    "and incorporate the following Rafi-generated guidance. Edit the file directly and do not modify unrelated files.\n\n" +
    "RAFI GENERATED GUIDANCE:\n\n" +
    generated;
  try {
    if (runtime === "codex") {
      execFileSync("codex", ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", targetDir, prompt], {
        cwd: targetDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      execFileSync("claude", ["-p", prompt], {
        cwd: targetDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  } catch (err) {
    const failure = err as {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    throw new RuntimeUpdateError({
      runtime,
      targetFile: relPath,
      exitCode: failure.status,
      stdout: outputToString(failure.stdout),
      stderr: outputToString(failure.stderr),
      cause: err,
    });
  }
}

export function isRootFileMode(value: string): value is ProjectConfig["agent_files"]["mode"] {
  return (ROOT_FILE_MODES as readonly string[]).includes(value);
}

export function rootFileModeValues(): readonly ProjectConfig["agent_files"]["mode"][] {
  return ROOT_FILE_MODES;
}

export function isRuntimeAuthFailure(output: string): boolean {
  return [
    /\b401\b/i,
    /invalid authentication credentials/i,
    /not logged in/i,
    /login required/i,
    /unauthenticated/i,
    /unauthorized/i,
    /expired[\w\s-]*token/i,
    /token[\w\s-]*expired/i,
    /session expired/i,
    /authentication.*expired/i,
  ].some((pattern) => pattern.test(output));
}

export function runtimeCommandLabel(runtime: AgentRuntime): string {
  return runtime === "claude" ? "claude -p" : "codex exec";
}

export function runtimeRepairCommands(runtime: AgentRuntime): string {
  if (runtime === "claude") {
    return [
      "claude auth logout",
      "claude auth login --claudeai",
      'claude -p "Return exactly OK"',
      "",
      "Claude subscription users may also need:",
      "claude setup-token",
    ].join("\n");
  }
  return [
    "codex login",
    'codex exec "Return exactly OK"',
  ].join("\n");
}

export function formatRuntimeUpdateFailure(opts: RuntimeUpdateErrorOptions): string {
  const command = runtimeCommandLabel(opts.runtime);
  const output = [opts.stderr, opts.stdout].filter(Boolean).join("\n").trim();
  const exit = opts.exitCode === undefined || opts.exitCode === null ? "unknown" : String(opts.exitCode);
  const authLikely = isRuntimeAuthFailure(output);
  const authLine = authLikely
    ? "The runtime output looks like an authentication failure."
    : "This often means the selected agent runtime is missing or not authenticated.";
  const details = output ? `\n\nRuntime output:\n${truncateRuntimeOutput(output)}` : "";
  return (
    `Could not update ${opts.targetFile} with ${command} (exit code ${exit}).\n\n` +
    `${authLine}\n\n` +
    "Repair and verify:\n" +
    indent(runtimeRepairCommands(opts.runtime)) +
    "\n\nFallback options:\n" +
    `  - Edit ${RAFI_CONFIG_FILE} and set agent_files.mode: append or overwrite.\n` +
    "  - Or rerun with --root-file-mode append|overwrite|update." +
    details
  );
}

function outputToString(value: string | Buffer | undefined): string {
  if (!value) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function truncateRuntimeOutput(output: string): string {
  const max = 2000;
  if (output.length <= max) return output;
  return `${output.slice(0, max).trimEnd()}\n... truncated ...`;
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function runtimeTargets(config: ProjectConfig): AgentRuntime[] {
  const targets: AgentRuntime[] = [];
  for (const target of config.harness.targets) {
    if ((target === "claude" || target === "codex") && !targets.includes(target)) {
      targets.push(target);
    }
  }
  return targets.length > 0 ? targets : ["claude", "codex"];
}

function skillNameRuntime(targets: readonly AgentRuntime[]): HarnessTarget {
  return targets.includes("claude") ? "claude" : "codex";
}

function configuredSkillNames(config: ProjectConfig, targets: readonly AgentRuntime[]): Record<string, string> {
  const runtime = skillNameRuntime(targets);
  return Object.fromEntries(
    Object.entries(config.skills).map(([generic, paths]) => [generic, skillNameFromPath(paths[runtime], generic)]),
  );
}

function validateExistingArtifacts(
  targetDir: string,
  config: ProjectConfig,
  targets: readonly AgentRuntime[],
): void {
  const missing: string[] = [];
  for (const [name, artifact] of Object.entries(config.agents)) {
    if (artifact.artifact_source !== "existing") continue;
    for (const runtime of targets) {
      if (!existsSync(join(targetDir, artifact[runtime]))) {
        missing.push(`agents.${name}.${runtime}: ${artifact[runtime]}`);
      }
    }
  }
  for (const [name, artifact] of Object.entries(config.skills)) {
    if (artifact.artifact_source !== "existing") continue;
    for (const runtime of targets) {
      if (!existsSync(join(targetDir, artifact[runtime]))) {
        missing.push(`skills.${name}.${runtime}: ${artifact[runtime]}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      "Configured existing Rafi artifact path(s) are missing:\n" +
      missing.map((m) => `- ${m}`).join("\n") +
      "\nUpdate rafi-config.yaml or rerun rafi create to choose Rafi-managed artifacts.",
    );
  }
}

function rafiOwnedPaths(
  artifacts: ProjectConfig["agents"],
  runtime: "claude" | "codex",
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(artifacts)
      .filter(([, artifact]) => artifact.artifact_source === "rafi")
      .map(([name, artifact]) => [name, artifact[runtime]]),
  );
}

function rafiOwnedNames(artifacts: ProjectConfig["agents"]): string[] {
  return Object.entries(artifacts)
    .filter(([, artifact]) => artifact.artifact_source === "rafi")
    .map(([name]) => name);
}

function skillNameFromPath(path: string, fallback: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const file = parts[parts.length - 1];
  if (file === "SKILL.md" && parts.length >= 2) return parts[parts.length - 2];
  return file?.replace(/\.(md|toml)$/i, "") || fallback;
}
