import { loadDefaults } from "special-agents";
import { assertProjectConfig } from "rafi-spec";
import type { ProjectConfig, HarnessTarget, RuntimeArtifactConfig } from "rafi-spec";

export const NO_UI = "No UI";
export const LOCAL_ONLY = "Local only";

export interface WalkthroughAnswers {
  appName: string;
  timezone: string;
  frontend: string;
  backend: string;
  database: string;
  cloud: string;
  packageManager: string;
  usesAI: boolean;
  useClaude: boolean;
  qa: boolean;
  /** Files, folders, or globs with existing tickets or planning material. */
  planningSources?: string;
}

export const RAFI_CONFIG_FILE = "rafi-config.yaml";
export const LEGACY_PROJECT_CONFIG_FILE = "project.yaml";

export const RAFI_AGENT_NAMES = ["builder", "qa", "planner", "ticket-maker"] as const;
export const RAFI_SKILL_NAMES = [
  "better-sqlite3-rebuild",
  "grill-me",
  "improve-codebase-architecture",
  "prd-to-issues",
  "tdd",
  "write-a-prd",
] as const;

export function artifactPaths(kind: "agent" | "skill", name: string, artifactSource: RuntimeArtifactConfig["artifact_source"] = "rafi"): RuntimeArtifactConfig {
  if (kind === "agent") {
    return {
      artifact_source: artifactSource,
      claude: `./.claude/agents/${name}.md`,
      codex: `./.codex/agents/${name}.toml`,
    };
  }
  return {
    artifact_source: artifactSource,
    claude: `./.claude/skills/${name}/SKILL.md`,
    codex: `./.agents/skills/${name}/SKILL.md`,
  };
}

export function defaultAgentsConfig(): Record<string, RuntimeArtifactConfig> {
  return Object.fromEntries(RAFI_AGENT_NAMES.map((name) => [name, artifactPaths("agent", name)]));
}

export function defaultSkillsConfig(): Record<string, RuntimeArtifactConfig> {
  return Object.fromEntries(RAFI_SKILL_NAMES.map((name) => [name, artifactPaths("skill", name)]));
}

/** Default answers — equivalent to running with `--defaults`. */
export function defaultAnswers(): WalkthroughAnswers {
  const d = loadDefaults();
  return {
    appName: "My App",
    timezone: "UTC",
    frontend: d.stack.frontend,
    backend: d.stack.backend,
    database: d.stack.database,
    cloud: d.stack.cloud,
    packageManager: d.stack.packageManager,
    usesAI: Boolean(d.flags.usesAI),
    useClaude: true,
    qa: true,
  };
}

/** Map walkthrough answers to a validated ProjectConfig. */
export function buildProjectConfig(answers: WalkthroughAnswers): ProjectConfig {
  const hasFrontend = answers.frontend !== NO_UI;
  const runsInCloud = answers.cloud !== LOCAL_ONLY;
  const targets: HarnessTarget[] = answers.useClaude ? ["claude", "codex"] : ["codex"];
  return {
    appName: answers.appName,
    timezone: answers.timezone,
    stack: {
      frontend: hasFrontend ? answers.frontend : "",
      backend: answers.backend,
      database: answers.database,
      cloud: runsInCloud ? answers.cloud : "",
      packageManager: answers.packageManager,
    },
    flags: {
      hasFrontend,
      usesAI: answers.usesAI,
      runsInCloud,
    },
    harness: {
      targets,
      qa: answers.qa,
    },
    agent_files: {
      mode: "overwrite",
      codex: "./AGENTS.md",
      claude: "./CLAUDE.md",
    },
    agents: defaultAgentsConfig(),
    skills: defaultSkillsConfig(),
  };
}

export function normalizeProjectConfig(raw: unknown): ProjectConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    assertProjectConfig(raw);
  }
  const cfg = raw as Partial<ProjectConfig>;
  const normalized = {
    ...cfg,
    agent_files: cfg.agent_files ?? {
      mode: "overwrite",
      codex: "./AGENTS.md",
      claude: "./CLAUDE.md",
    },
    agents: normalizeArtifactMap(cfg.agents, defaultAgentsConfig()),
    skills: normalizeArtifactMap(cfg.skills, defaultSkillsConfig()),
  };
  assertProjectConfig(normalized);
  return normalized;
}

function normalizeArtifactMap(
  raw: ProjectConfig["agents"] | undefined,
  defaults: ProjectConfig["agents"],
): ProjectConfig["agents"] {
  if (!raw) return defaults;
  return Object.fromEntries(
    Object.entries(raw as Record<string, Partial<RuntimeArtifactConfig>>).map(([name, artifact]) => [
      name,
      {
        artifact_source: artifact.artifact_source ?? "rafi",
        claude: artifact.claude,
        codex: artifact.codex,
      },
    ]),
  ) as ProjectConfig["agents"];
}
