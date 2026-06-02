import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  emitAgentsMd,
  emitClaudeMd,
  emitClaudeAgents,
  emitCompiledBundles,
  type Defaults,
} from "special-agents";
import type { ProjectConfig, ProjectFlags } from "rafi-spec";
import { copyDocs, type CopyDocsOptions } from "./docs.js";

export interface CompileProjectOptions extends CopyDocsOptions {
  /** Skip doc copying entirely (useful in tests that don't need docs). */
  skipDocs?: boolean;
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

  // Flat Codex doc + lean Claude entrypoint
  emitAgentsMd(targetDir, { defaults });
  emitClaudeMd(targetDir, { defaults });

  // Lean Claude subagent files (role-filtered)
  emitClaudeAgents(targetDir, { defaults, conditions });

  // Compiled role bundles for foreman (role-filtered)
  emitCompiledBundles(targetDir, { defaults, conditions });

  // Starter docs (flag-gated)
  if (!opts.skipDocs) {
    copyDocs(targetDir, config.flags, { force: opts.force });
  }
}

/**
 * Write `project.yaml` to `<targetDir>/project.yaml`. Creates the directory
 * if it does not exist.
 */
export function writeProjectYaml(targetDir: string, config: ProjectConfig): void {
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "project.yaml"), stringify(config), "utf8");
}
