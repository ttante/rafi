import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import type { AgentRole, ProjectConfig, ProjectFlags } from "rafi-spec";
import { copyDocs, type CopyDocsOptions } from "./docs.js";
import { RAFI_CONFIG_FILE } from "./project.js";

const RAFI_APPEND_START = "<!-- rafi:start -->";
const RAFI_APPEND_END = "<!-- rafi:end -->";

export interface CompileProjectOptions extends CopyDocsOptions {
  /** Skip doc copying entirely (useful in tests that don't need docs). */
  skipDocs?: boolean;
  /** Skip native skill/subagent files; useful when compile should only refresh runtime bundles. */
  skipNativeArtifacts?: boolean;
}

/** Map a ProjectConfig to the Defaults shape special-agents compile functions expect. */
export function projectConfigToDefaults(config: ProjectConfig): Defaults {
  return {
    stack: config.stack as unknown as Record<string, string>,
    flags: config.flags as unknown as Record<string, boolean>,
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
  const defaults = projectConfigToDefaults(config);
  const conditions = flagsToConditions(config.flags);
  validateExistingArtifacts(targetDir, config);
  const skillNames = configuredSkillNames(config);
  const updateRuntime = config.harness.targets.includes("claude") ? "claude" : "codex";

  // Flat Codex doc + lean Claude entrypoint
  writeInstructionFile(targetDir, config.agent_files.codex, renderAgentsMd({ defaults }), config.agent_files.mode, updateRuntime);
  writeInstructionFile(targetDir, config.agent_files.claude, renderClaudeMd({ defaults }), config.agent_files.mode, updateRuntime);

  // Lean Claude subagent files (role-filtered)
  if (!opts.skipNativeArtifacts) {
    const rafiOwnedAgentRoles = rafiOwnedNames(config.agents) as AgentRole[];
    const rafiOwnedSkillNames = rafiOwnedNames(config.skills);
    emitMappedClaudeAgents(targetDir, {
      defaults,
      conditions,
      roles: rafiOwnedAgentRoles,
      force: true,
      paths: rafiOwnedPaths(config.agents, "claude"),
    });
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
      paths: rafiOwnedPaths(config.skills, "claude"),
    });
    emitSkills(targetDir, {
      names: rafiOwnedSkillNames,
      force: true,
      paths: rafiOwnedPaths(config.skills, "codex"),
    });
  }

  // Compiled role bundles for foreman (role-filtered)
  emitCompiledBundles(targetDir, { defaults, conditions, skillNames });

  // Starter docs (flag-gated)
  if (!opts.skipDocs) {
    copyDocs(targetDir, config.flags, { force: opts.force });
  }
}

/**
 * Write `rafi-config.yaml` to `<targetDir>/rafi-config.yaml`. Creates the directory
 * if it does not exist.
 */
export function writeRafiConfigYaml(targetDir: string, config: ProjectConfig): void {
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, RAFI_CONFIG_FILE), stringify(config), "utf8");
}

export const writeProjectYaml = writeRafiConfigYaml;

function writeInstructionFile(
  targetDir: string,
  relPath: string,
  generated: string,
  mode: ProjectConfig["agent_files"]["mode"],
  runtime: "claude" | "codex",
): void {
  const path = join(targetDir, relPath);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || mode === "overwrite") {
    writeFileSync(path, generated, "utf8");
    return;
  }
  if (mode === "append") {
    const existing = readFileSync(path, "utf8");
    const block = rafiAppendBlock(generated);
    const managedBlock = new RegExp(`${escapeRegExp(RAFI_APPEND_START)}[\\s\\S]*?${escapeRegExp(RAFI_APPEND_END)}\\n?`);
    if (managedBlock.test(existing)) {
      writeFileSync(path, existing.replace(managedBlock, block), "utf8");
      return;
    }
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(path, `${existing}${separator}${block}`, "utf8");
    return;
  }
  updateInstructionFileWithAgent(targetDir, relPath, generated, runtime);
}

function rafiAppendBlock(generated: string): string {
  const date = new Date().toISOString();
  return `${RAFI_APPEND_START}\nUpdated Content, generated by @rafi/cli on ${date}\n\n${generated.trimEnd()}\n${RAFI_APPEND_END}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateInstructionFileWithAgent(
  targetDir: string,
  relPath: string,
  generated: string,
  runtime: "claude" | "codex",
): void {
  const prompt =
    `Update ${relPath} in this repository.\n\n` +
    "Preserve useful existing project-specific guidance, remove stale or conflicting guidance, " +
    "and incorporate the following Rafi-generated guidance. Edit the file directly and do not modify unrelated files.\n\n" +
    "RAFI GENERATED GUIDANCE:\n\n" +
    generated;
  try {
    if (runtime === "codex") {
      execFileSync("codex", ["exec", "--sandbox", "workspace-write", "-C", targetDir, prompt], { stdio: "inherit" });
    } else {
      execFileSync("claude", ["-p", prompt], { cwd: targetDir, stdio: "inherit" });
    }
  } catch (err) {
    throw new Error(
      `Cannot update ${relPath}: ${runtime} runtime is not available or failed. ` +
      "Choose append/overwrite or install the selected agent runtime.",
      { cause: err },
    );
  }
}

function configuredSkillNames(config: ProjectConfig): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config.skills).map(([generic, paths]) => [generic, skillNameFromPath(paths.claude || paths.codex, generic)]),
  );
}

function validateExistingArtifacts(targetDir: string, config: ProjectConfig): void {
  const missing: string[] = [];
  for (const [name, artifact] of Object.entries(config.agents)) {
    if (artifact.artifact_source !== "existing") continue;
    if (!existsSync(join(targetDir, artifact.claude))) missing.push(`agents.${name}.claude: ${artifact.claude}`);
    if (!existsSync(join(targetDir, artifact.codex))) missing.push(`agents.${name}.codex: ${artifact.codex}`);
  }
  for (const [name, artifact] of Object.entries(config.skills)) {
    if (artifact.artifact_source !== "existing") continue;
    if (!existsSync(join(targetDir, artifact.claude))) missing.push(`skills.${name}.claude: ${artifact.claude}`);
    if (!existsSync(join(targetDir, artifact.codex))) missing.push(`skills.${name}.codex: ${artifact.codex}`);
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
