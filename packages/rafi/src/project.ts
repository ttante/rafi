import { loadDefaults } from "special-agents";
import { assertProjectConfig } from "rafi-spec";
import type { AgentDefaultsV1, ProjectConfig, HarnessTarget, RuntimeArtifactConfig, TicketBuildBranchStrategy } from "rafi-spec";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CreateGitignoreSelection } from "./gitignore.js";

export const NO_UI = "No UI";
export const LOCAL_ONLY = "Local only";
export const DEFAULT_DOCS_ROOT = "docs";
export const RUNTIME_SELECTIONS = ["both", "claude", "codex"] as const;
export const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 50;
export const DEFAULT_COMPACT_MAXIMUM = 10;
export const DEFAULT_BRANCH_PREFIX = "feature";
export type RuntimeSelection = typeof RUNTIME_SELECTIONS[number];

export interface WalkthroughAnswers {
  appName: string;
  timezone: string;
  frontend: string;
  backend: string;
  database: string;
  cloud: string;
  packageManager: string;
  usesAI: boolean;
  runtimeTargets?: HarnessTarget[];
  /** Legacy input accepted for compatibility with callers built before --runtime. */
  useClaude?: boolean;
  qa: boolean;
  /** Repo-relative folder where Rafi project docs are written. */
  docsRoot?: string;
  /** Files, folders, or globs with existing tickets or planning material. */
  planningSources?: string | string[];
  /** Storage preference for future immutable source captures. */
  sourceStorage?: "local" | "tracked";
  /** Optional create-time compact/fresh defaults for configurable Rafi roles. */
  agentDefaults?: AgentDefaultsV1;
  /** Default ticket work mode passed into ticket setup. */
  branchStrategy?: TicketBuildBranchStrategy;
  /** Create-time Rafi .gitignore choice, saved so handoff resume can reapply it. */
  gitignoreMode?: CreateGitignoreSelection;
}

export const RAFI_CONFIG_FILE = "rafi-config.yaml";
export const LEGACY_PROJECT_CONFIG_FILE = "project.yaml";

export interface DiscoveredRafiProject {
  root: string;
  configFile: typeof RAFI_CONFIG_FILE | typeof LEGACY_PROJECT_CONFIG_FILE;
  legacy: boolean;
}

/** Walk upward and return the nearest active or legacy Rafi project. */
export function findNearestRafiProject(startDir = process.cwd()): DiscoveredRafiProject | undefined {
  let current = resolve(startDir);
  if (existsSync(current) && !statSync(current).isDirectory()) current = dirname(current);
  while (true) {
    if (existsSync(join(current, RAFI_CONFIG_FILE))) {
      return { root: current, configFile: RAFI_CONFIG_FILE, legacy: false };
    }
    if (existsSync(join(current, LEGACY_PROJECT_CONFIG_FILE))) {
      return { root: current, configFile: LEGACY_PROJECT_CONFIG_FILE, legacy: true };
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Resolve an explicit project directory without searching its ancestors. */
export function resolveExplicitRafiProject(project: string): DiscoveredRafiProject | undefined {
  const root = resolve(project);
  if (!existsSync(root) || !statSync(root).isDirectory()) return undefined;
  if (existsSync(join(root, RAFI_CONFIG_FILE))) {
    return { root, configFile: RAFI_CONFIG_FILE, legacy: false };
  }
  if (existsSync(join(root, LEGACY_PROJECT_CONFIG_FILE))) {
    return { root, configFile: LEGACY_PROJECT_CONFIG_FILE, legacy: true };
  }
  return undefined;
}

export const RAFI_AGENT_NAMES = ["builder", "qa", "planner", "ticket-maker", "uninstaller"] as const;
export const RAFI_SKILL_NAMES = [
  "better-sqlite3-rebuild",
  "grill-me",
  "handoff",
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

export function runtimeSelectionToTargets(selection: RuntimeSelection): HarnessTarget[] {
  if (selection === "claude") return ["claude"];
  if (selection === "codex") return ["codex"];
  return ["claude", "codex"];
}

export function runtimeTargetsToSelection(targets: readonly HarnessTarget[]): RuntimeSelection {
  const normalized = normalizeHarnessTargets(targets);
  if (normalized.length === 1) return normalized[0];
  return "both";
}

export function parseRuntimeSelection(value: unknown): RuntimeSelection | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (RUNTIME_SELECTIONS as readonly string[]).includes(value)) {
    return value as RuntimeSelection;
  }
  throw new Error(`--runtime must be one of: ${RUNTIME_SELECTIONS.join(", ")}`);
}

export function normalizeHarnessTargets(targets: readonly HarnessTarget[] | undefined): HarnessTarget[] {
  if (!targets || targets.length === 0) return ["claude", "codex"];
  const out: HarnessTarget[] = [];
  for (const target of targets) {
    if ((target === "claude" || target === "codex") && !out.includes(target)) {
      out.push(target);
    }
  }
  return out.length > 0 ? out : ["claude", "codex"];
}

function targetsFromAnswers(answers: WalkthroughAnswers): HarnessTarget[] {
  if (answers.runtimeTargets) return normalizeHarnessTargets(answers.runtimeTargets);
  return answers.useClaude === false ? ["codex"] : ["claude", "codex"];
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
  const targets = targetsFromAnswers(answers);
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
    docs: {
      root: answers.docsRoot ?? DEFAULT_DOCS_ROOT,
    },
    agent_defaults: normalizeProjectAgentDefaults(answers.agentDefaults),
    ...(normalizePlanningSources(answers.planningSources).length > 0
      ? { sources: {
        version: 1 as const,
        snapshot_storage: answers.sourceStorage ?? "local",
        entries: [],
        pending: normalizePlanningSources(answers.planningSources).map((description) => ({ description, created_at: new Date().toISOString() })),
      } }
      : {}),
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
    docs: {
      root: cfg.docs?.root ?? DEFAULT_DOCS_ROOT,
    },
    ...(normalizePlanningSources(cfg.planning?.sources).length > 0
      ? { planning: { sources: normalizePlanningSources(cfg.planning?.sources) } }
      : {}),
    agent_defaults: normalizeProjectAgentDefaults(cfg.agent_defaults),
    ...(cfg.tickets ? {
      tickets: {
        ...cfg.tickets,
        ...(cfg.tickets.build ? { build: { branch_prefix: DEFAULT_BRANCH_PREFIX, ...cfg.tickets.build } } : {}),
      },
    } : {}),
    agents: normalizeArtifactMap(cfg.agents, defaultAgentsConfig()),
    skills: normalizeArtifactMap(cfg.skills, defaultSkillsConfig()),
  };
  assertProjectConfig(normalized);
  return normalized;
}

/** Fill runtime defaults in memory without causing a config write. */
export function normalizeProjectAgentDefaults(defaults?: AgentDefaultsV1): AgentDefaultsV1 {
  const sessionDefaults = {
    builder: "compact",
    qa: "compact",
    "ticket-maker": "compact",
    planner: "fresh",
    uninstaller: "fresh",
  } as const;
  const roles = { ...(defaults?.roles ?? {}) } as AgentDefaultsV1["roles"];
  for (const [role, sessionStrategy] of Object.entries(sessionDefaults)) {
    const current = roles[role as keyof typeof sessionDefaults] ?? {};
    roles[role as keyof typeof sessionDefaults] = {
      ...current,
      session_strategy: current.session_strategy ?? sessionStrategy,
      display_session_cost: current.display_session_cost ?? false,
      ...(role === "builder" || role === "qa" ? {
        auto_compact_threshold_percent: current.auto_compact_threshold_percent ?? DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
        compact_maximum: current.compact_maximum ?? DEFAULT_COMPACT_MAXIMUM,
      } : {}),
    };
  }
  return { version: 1, revision: defaults?.revision ?? 0, roles };
}

export function normalizePlanningSources(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [...new Set(raw.map((entry) => String(entry).trim()).filter(Boolean))];
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
