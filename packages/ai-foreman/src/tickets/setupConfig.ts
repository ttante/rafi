import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadDefaults } from "special-agents";
import { appendLegacyTicketSources, loadSourceRegistry } from "../sources/sourceRegistry.js";

export const RAFI_CONFIG_FILE = "rafi-config.yaml";

export type HarnessTarget = "claude" | "codex";
export type TicketBuildCompletionMode = "pr" | "auto-merge" | "direct-merge" | "none";
export type TicketBuildProvider = "auto" | "github" | "gitlab" | "local";
export type TicketBuildMergeMethod = "squash" | "merge" | "rebase";
export type TicketBuildBranchStrategy = "current" | "batch" | "branch-per-ticket";
export type TicketBranchPolicyMode = "global" | "size";
export type TicketTitleStyle = "ticket-title" | "conventional" | "none" | "custom";
export type TicketPopulateAgentPreference = "configured" | "claude" | "codex";
export type TicketPopulateEnrichmentPolicy = "none" | "recommendations" | "agent";

export type TicketSourceConfig =
  | { type: "local"; paths: string[] }
  | { type: "linear"; api_key_env: string; team_key?: string | null; filter?: string | null }
  | { type: "jira"; site: string; email_env: string; token_env: string; jql: string }
  | { type: "url"; url: string };

export interface TicketPopulateSetupConfig {
  source_handling: "saved" | "prompt" | "manual";
  agent_preference: TicketPopulateAgentPreference;
  import_cap: number;
  comment_limit: number;
  enrichment: TicketPopulateEnrichmentPolicy;
  recommend_split_for_xl: boolean;
}

export interface TicketBuildSetupConfig {
  branch_strategy: TicketBuildBranchStrategy;
  completion: TicketBuildCompletionMode;
  provider: TicketBuildProvider;
  pr_ready: boolean;
  merge_method: TicketBuildMergeMethod;
  cleanup: boolean;
  auto_merge_wait: boolean;
  auto_merge_timeout_minutes: number | null;
  base_branch: string;
  branch_policy: {
    mode: TicketBranchPolicyMode;
    global_strategy: TicketBuildBranchStrategy;
    by_size: Record<"XS" | "S" | "M" | "L" | "XL", "shared" | "per-ticket">;
  };
  review: {
    title_style: TicketTitleStyle;
    title_template: string | null;
    description_sections: string[];
  };
  validation_checklist: string[];
}

export interface TicketsSetupConfig {
  sources: TicketSourceConfig[];
  populate: TicketPopulateSetupConfig;
  build: TicketBuildSetupConfig;
  limits: { implementation: number; view: number };
}

export interface MinimalRafiConfigOptions {
  appName?: string;
  timezone?: string;
  docsRoot?: string;
  targets?: HarnessTarget[];
}

const AGENT_NAMES = ["builder", "qa", "planner", "ticket-maker", "uninstaller"] as const;
const SKILL_NAMES = [
  "better-sqlite3-rebuild",
  "grill-me",
  "improve-codebase-architecture",
  "prd-to-issues",
  "tdd",
  "write-a-prd",
] as const;

export const DEFAULT_TICKET_SETUP: TicketsSetupConfig = {
  sources: [],
  limits: { implementation: 500, view: 20_000 },
  populate: {
    source_handling: "saved",
    agent_preference: "configured",
    import_cap: 500,
    comment_limit: 10,
    enrichment: "recommendations",
    recommend_split_for_xl: true,
  },
  build: {
    branch_strategy: "branch-per-ticket",
    completion: "none",
    provider: "auto",
    pr_ready: false,
    merge_method: "squash",
    cleanup: true,
    auto_merge_wait: false,
    auto_merge_timeout_minutes: null,
    base_branch: "main",
    branch_policy: {
      mode: "global",
      global_strategy: "branch-per-ticket",
      by_size: { XS: "shared", S: "shared", M: "per-ticket", L: "per-ticket", XL: "per-ticket" },
    },
    review: {
      title_style: "ticket-title",
      title_template: null,
      description_sections: ["Summary", "Linked ticket", "Changes made", "Tests and validation performed", "Risks or rollback notes", "Checklist"],
    },
    validation_checklist: [
      "Acceptance criteria satisfied",
      "Required tests pass",
      "Configured project checks pass",
      "Documentation updated when needed",
      "Database and deployment changes reviewed when present",
      "Validation evidence attached",
    ],
  },
};

export function loadRafiConfigObject(projectDir: string): Record<string, unknown> | undefined {
  const configPath = join(projectDir, RAFI_CONFIG_FILE);
  if (!existsSync(configPath)) return undefined;
  const raw = parse(readFileSync(configPath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${RAFI_CONFIG_FILE}: expected a YAML object`);
  }
  return raw as Record<string, unknown>;
}

export function loadTicketSetupConfig(projectDir: string): TicketsSetupConfig | undefined {
  const raw = loadRafiConfigObject(projectDir);
  if (!raw || raw.tickets === undefined) return undefined;
  const setup = normalizeTicketsSetupConfig(raw.tickets, `${RAFI_CONFIG_FILE}.tickets`);
  if (setup.sources.length === 0) setup.sources = legacySourcesFromRegistry(loadSourceRegistry(projectDir).registry.entries);
  return setup;
}

export function loadTicketSetupConfigWithDefaults(projectDir: string): TicketsSetupConfig {
  return loadTicketSetupConfig(projectDir) ?? cloneTicketSetup(DEFAULT_TICKET_SETUP);
}

export function hasTicketSetupConfig(projectDir: string): boolean {
  const raw = loadRafiConfigObject(projectDir);
  return Boolean(raw?.tickets);
}

export function saveTicketSetupConfig(
  projectDir: string,
  setup: TicketsSetupConfig,
  opts: MinimalRafiConfigOptions = {},
): void {
  const config = loadRafiConfigObject(projectDir) ?? minimalRafiConfig(projectDir, opts);
  const normalized = normalizeTicketsSetupConfig(setup, "tickets");
  const ticketConfig = denormalizeTicketsSetupConfig(normalized);
  delete ticketConfig.sources;
  config.tickets = ticketConfig;
  config.sources = appendLegacyTicketSources(loadSourceRegistry(projectDir).registry, normalized.sources);
  const planning = config.planning && typeof config.planning === "object" && !Array.isArray(config.planning) ? config.planning as Record<string, unknown> : undefined;
  if (planning) { delete planning.sources; if (Object.keys(planning).length === 0) delete config.planning; }
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, RAFI_CONFIG_FILE), stringify(config, { lineWidth: 100 }), "utf8");
}

/** Synchronize pending setup limits into the tracker, once the tracker exists. */
export function syncTicketLimits(projectDir: string, limits: TicketsSetupConfig["limits"]): void {
  const path = join(projectDir, ".tickets", "config.yaml");
  if (!existsSync(path)) return;
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: expected a YAML object`);
  raw.implementation_limit = positiveInteger(limits.implementation, 500, "tickets.limits.implementation");
  raw.view_limit = positiveInteger(limits.view, 20_000, "tickets.limits.view");
  writeFileSync(path, stringify(raw, { lineWidth: 100 }), "utf8");
}

export function ensureRafiConfigForTicketSetup(
  projectDir: string,
  opts: MinimalRafiConfigOptions = {},
): Record<string, unknown> {
  const existing = loadRafiConfigObject(projectDir);
  if (existing) return existing;
  const config = minimalRafiConfig(projectDir, opts);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, RAFI_CONFIG_FILE), stringify(config, { lineWidth: 100 }), "utf8");
  return config;
}

export function normalizeTicketsSetupConfig(value: unknown, label = "tickets"): TicketsSetupConfig {
  if (value === undefined || value === null) return cloneTicketSetup(DEFAULT_TICKET_SETUP);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  const raw = value as Record<string, unknown>;
  const setup: TicketsSetupConfig = {
    sources: normalizeSources(raw.sources, `${label}.sources`),
    limits: normalizeLimits(raw.limits, `${label}.limits`),
    populate: normalizePopulate(raw.populate, `${label}.populate`),
    build: normalizeBuild(raw.build, `${label}.build`),
  };
  return setup;
}

export function denormalizeTicketsSetupConfig(setup: TicketsSetupConfig): Record<string, unknown> {
  return {
    sources: setup.sources.map((source) => ({ ...source })),
    limits: { ...setup.limits },
    populate: { ...setup.populate },
    build: { ...setup.build },
  };
}

export function mergeTicketSetup(
  current: TicketsSetupConfig | undefined,
  patch: Partial<{
    sources: TicketSourceConfig[];
    limits: TicketsSetupConfig["limits"];
    populate: Partial<TicketPopulateSetupConfig>;
    build: Partial<TicketBuildSetupConfig>;
  }>,
): TicketsSetupConfig {
  const base = current ? cloneTicketSetup(current) : cloneTicketSetup(DEFAULT_TICKET_SETUP);
  return normalizeTicketsSetupConfig({
    sources: patch.sources ?? base.sources,
    limits: patch.limits ?? base.limits,
    populate: { ...base.populate, ...(patch.populate ?? {}) },
    build: { ...base.build, ...(patch.build ?? {}) },
  });
}

export function localSourcePaths(setup: TicketsSetupConfig | undefined): string[] {
  return unique((setup?.sources ?? [])
    .filter((source): source is Extract<TicketSourceConfig, { type: "local" }> => source.type === "local")
    .flatMap((source) => source.paths));
}

/**
 * Create records planning hints separately from completed ticket setup.  Use
 * them only as a setup prefill so `tickets.sources` remains the source of
 * truth once the user has configured ticket ingestion.
 */
export function configuredPlanningSources(projectDir: string): string[] {
  const raw = loadRafiConfigObject(projectDir);
  const planning = raw?.planning as Record<string, unknown> | undefined;
  if (!Array.isArray(planning?.sources)) return [];
  return unique(planning.sources.filter((source): source is string => typeof source === "string" && source.trim().length > 0).map((source) => source.trim()));
}

export function externalSources(setup: TicketsSetupConfig | undefined): Extract<TicketSourceConfig, { type: "linear" | "jira" }>[] {
  return (setup?.sources ?? []).filter(
    (source): source is Extract<TicketSourceConfig, { type: "linear" | "jira" }> =>
      source.type === "linear" || source.type === "jira",
  );
}

export function urlSources(setup: TicketsSetupConfig | undefined): Extract<TicketSourceConfig, { type: "url" }>[] {
  return (setup?.sources ?? []).filter((source): source is Extract<TicketSourceConfig, { type: "url" }> => source.type === "url");
}

export function normalizedSourceKey(source: TicketSourceConfig): string {
  if (source.type === "local") return `local:${unique(source.paths.map((path) => path.trim())).sort().join("|")}`;
  if (source.type === "url") {
    const url = new URL(source.url);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    return `url:${url.toString()}`;
  }
  if (source.type === "linear") return `linear:${source.api_key_env}:${source.team_key ?? ""}:${source.filter ?? ""}`;
  return `jira:${source.site.replace(/\/+$/, "").toLowerCase()}:${source.jql}`;
}

export function dedupeTicketSources(sources: TicketSourceConfig[]): TicketSourceConfig[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = normalizedSourceKey(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function configuredDocsRoot(projectDir: string): string | undefined {
  const raw = loadRafiConfigObject(projectDir);
  const docs = raw?.docs as Record<string, unknown> | undefined;
  return typeof docs?.root === "string" ? docs.root : undefined;
}

export function configuredAppName(projectDir: string): string | undefined {
  const raw = loadRafiConfigObject(projectDir);
  return typeof raw?.appName === "string" && raw.appName.trim() ? raw.appName : undefined;
}

export function configuredHarnessTargets(projectDir: string): HarnessTarget[] | undefined {
  const raw = loadRafiConfigObject(projectDir);
  const harness = raw?.harness as Record<string, unknown> | undefined;
  if (!Array.isArray(harness?.targets)) return undefined;
  const targets = normalizeTargets(harness.targets);
  return targets.length > 0 ? targets : undefined;
}

export function detectPackageName(projectDir: string): string | undefined {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
    return typeof pkg.name === "string" && pkg.name.trim() ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

export function defaultAppName(projectDir: string): string {
  return configuredAppName(projectDir) ?? detectPackageName(projectDir) ?? "My App";
}

export function detectGitProvider(projectDir: string): Exclude<TicketBuildProvider, "auto" | "local"> | undefined {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().toLowerCase();
    if (remote.includes("github.com") || remote.includes("github.")) return "github";
    if (remote.includes("gitlab.com") || remote.includes("gitlab.")) return "gitlab";
  } catch {
    return undefined;
  }
  return undefined;
}

export function detectDefaultBranch(projectDir: string): string {
  const attempts = [
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    ["config", "--get", "init.defaultBranch"],
    ["branch", "--show-current"],
  ];
  for (const args of attempts) {
    try {
      const value = execFileSync("git", args, { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (value) return value.replace(/^origin\//, "");
    } catch { /* try the next safe source */ }
  }
  return "main";
}

export function recommendedBuildDefaults(projectDir: string): TicketBuildSetupConfig {
  const provider = detectGitProvider(projectDir);
  return {
    ...DEFAULT_TICKET_SETUP.build,
    provider: provider ?? "local",
    completion: provider ? "auto-merge" : "direct-merge",
    pr_ready: Boolean(provider),
    merge_method: "squash",
    cleanup: true,
    base_branch: detectDefaultBranch(projectDir),
  };
}

function minimalRafiConfig(projectDir: string, opts: MinimalRafiConfigOptions): Record<string, unknown> {
  const defaults = loadDefaults();
  const docsRoot = opts.docsRoot ?? "docs";
  const targets = normalizeTargets(opts.targets).length > 0 ? normalizeTargets(opts.targets) : ["claude", "codex"];
  return {
    appName: opts.appName ?? defaultAppName(projectDir),
    timezone: opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    stack: {
      frontend: defaults.stack.frontend,
      backend: defaults.stack.backend,
      database: defaults.stack.database,
      cloud: defaults.stack.cloud,
      packageManager: defaults.stack.packageManager,
    },
    flags: {
      hasFrontend: Boolean(defaults.flags.hasFrontend),
      usesAI: Boolean(defaults.flags.usesAI),
      runsInCloud: Boolean(defaults.flags.runsInCloud),
    },
    harness: {
      targets,
      qa: true,
    },
    agent_files: {
      mode: "overwrite",
      codex: "./AGENTS.md",
      claude: "./CLAUDE.md",
    },
    docs: {
      root: docsRoot,
    },
    agents: Object.fromEntries(AGENT_NAMES.map((name) => [name, artifactPaths("agent", name)])),
    skills: Object.fromEntries(SKILL_NAMES.map((name) => [name, artifactPaths("skill", name)])),
  };
}

function artifactPaths(kind: "agent" | "skill", name: string): Record<string, string> {
  if (kind === "agent") {
    return {
      artifact_source: "rafi",
      claude: `./.claude/agents/${name}.md`,
      codex: `./.codex/agents/${name}.toml`,
    };
  }
  return {
    artifact_source: "rafi",
    claude: `./.claude/skills/${name}/SKILL.md`,
    codex: `./.agents/skills/${name}/SKILL.md`,
  };
}

function normalizeSources(value: unknown, label: string): TicketSourceConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`);
  return value.map((item, index) => normalizeSource(item, `${label}[${index}]`));
}

function normalizeSource(value: unknown, label: string): TicketSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  const raw = value as Record<string, unknown>;
  if (raw.type === "local") {
    if (!Array.isArray(raw.paths) || !raw.paths.every((path) => typeof path === "string" && path.trim())) {
      throw new Error(`${label}.paths: expected non-empty string array`);
    }
    return { type: "local", paths: unique(raw.paths.map((path) => String(path).trim())) };
  }
  if (raw.type === "linear") {
    return {
      type: "linear",
      api_key_env: stringField(raw.api_key_env, "LINEAR_API_KEY"),
      team_key: nullableString(raw.team_key),
      filter: nullableString(raw.filter),
    };
  }
  if (raw.type === "jira") {
    const site = stringField(raw.site);
    const jql = stringField(raw.jql);
    if (!site) throw new Error(`${label}.site: expected a non-empty Jira Cloud site URL`);
    if (!jql) throw new Error(`${label}.jql: expected a non-empty JQL string`);
    return {
      type: "jira",
      site: site.replace(/\/+$/, ""),
      email_env: stringField(raw.email_env, "JIRA_EMAIL"),
      token_env: stringField(raw.token_env, "JIRA_API_TOKEN"),
      jql,
    };
  }
  if (raw.type === "url") {
    const url = stringField(raw.url);
    if (!url) throw new Error(`${label}.url: expected a public HTTP(S) URL`);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`${label}.url: expected a valid URL`); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      throw new Error(`${label}.url: expected HTTP(S) without embedded credentials`);
    }
    parsed.hash = "";
    return { type: "url", url: parsed.toString() };
  }
  throw new Error(`${label}.type: expected local, linear, jira, or url`);
}

function normalizePopulate(value: unknown, label: string): TicketPopulateSetupConfig {
  const raw = objectOrEmpty(value, label);
  return {
    source_handling: enumField(raw.source_handling, ["saved", "prompt", "manual"], DEFAULT_TICKET_SETUP.populate.source_handling, `${label}.source_handling`),
    agent_preference: enumField(raw.agent_preference, ["configured", "claude", "codex"], DEFAULT_TICKET_SETUP.populate.agent_preference, `${label}.agent_preference`),
    import_cap: positiveInteger(raw.import_cap, DEFAULT_TICKET_SETUP.populate.import_cap, `${label}.import_cap`),
    comment_limit: nonNegativeInteger(raw.comment_limit, DEFAULT_TICKET_SETUP.populate.comment_limit, `${label}.comment_limit`),
    enrichment: enumField(raw.enrichment, ["none", "recommendations", "agent"], DEFAULT_TICKET_SETUP.populate.enrichment, `${label}.enrichment`),
    recommend_split_for_xl: booleanField(raw.recommend_split_for_xl, DEFAULT_TICKET_SETUP.populate.recommend_split_for_xl, `${label}.recommend_split_for_xl`),
  };
}

function normalizeBuild(value: unknown, label: string): TicketBuildSetupConfig {
  const raw = objectOrEmpty(value, label);
  return {
    branch_strategy: enumField(raw.branch_strategy, ["current", "batch", "branch-per-ticket"], DEFAULT_TICKET_SETUP.build.branch_strategy, `${label}.branch_strategy`),
    completion: enumField(raw.completion, ["pr", "auto-merge", "direct-merge", "none"], DEFAULT_TICKET_SETUP.build.completion, `${label}.completion`),
    provider: enumField(raw.provider, ["auto", "github", "gitlab", "local"], DEFAULT_TICKET_SETUP.build.provider, `${label}.provider`),
    pr_ready: booleanField(raw.pr_ready, DEFAULT_TICKET_SETUP.build.pr_ready, `${label}.pr_ready`),
    merge_method: enumField(raw.merge_method, ["squash", "merge", "rebase"], DEFAULT_TICKET_SETUP.build.merge_method, `${label}.merge_method`),
    cleanup: booleanField(raw.cleanup, DEFAULT_TICKET_SETUP.build.cleanup, `${label}.cleanup`),
    auto_merge_wait: booleanField(raw.auto_merge_wait, DEFAULT_TICKET_SETUP.build.auto_merge_wait, `${label}.auto_merge_wait`),
    auto_merge_timeout_minutes: nullablePositiveInteger(raw.auto_merge_timeout_minutes, DEFAULT_TICKET_SETUP.build.auto_merge_timeout_minutes, `${label}.auto_merge_timeout_minutes`),
    base_branch: stringField(raw.base_branch, DEFAULT_TICKET_SETUP.build.base_branch),
    branch_policy: normalizeBranchPolicy(raw.branch_policy, raw.branch_strategy, `${label}.branch_policy`),
    review: normalizeReview(raw.review, `${label}.review`),
    validation_checklist: stringArray(raw.validation_checklist, DEFAULT_TICKET_SETUP.build.validation_checklist, `${label}.validation_checklist`),
  };
}

function normalizeLimits(value: unknown, label: string): TicketsSetupConfig["limits"] {
  const raw = objectOrEmpty(value, label);
  return {
    implementation: positiveInteger(raw.implementation, DEFAULT_TICKET_SETUP.limits.implementation, `${label}.implementation`),
    view: positiveInteger(raw.view, DEFAULT_TICKET_SETUP.limits.view, `${label}.view`),
  };
}

function normalizeBranchPolicy(value: unknown, legacyStrategy: unknown, label: string): TicketBuildSetupConfig["branch_policy"] {
  const raw = objectOrEmpty(value, label);
  const sizes = objectOrEmpty(raw.by_size, `${label}.by_size`);
  const globalStrategy = enumField(raw.global_strategy ?? legacyStrategy, ["current", "batch", "branch-per-ticket"], DEFAULT_TICKET_SETUP.build.branch_policy.global_strategy, `${label}.global_strategy`);
  return {
    mode: enumField(raw.mode, ["global", "size"], DEFAULT_TICKET_SETUP.build.branch_policy.mode, `${label}.mode`),
    global_strategy: globalStrategy,
    by_size: {
      XS: enumField(sizes.XS, ["shared", "per-ticket"], "shared", `${label}.by_size.XS`),
      S: enumField(sizes.S, ["shared", "per-ticket"], "shared", `${label}.by_size.S`),
      M: enumField(sizes.M, ["shared", "per-ticket"], "per-ticket", `${label}.by_size.M`),
      L: enumField(sizes.L, ["shared", "per-ticket"], "per-ticket", `${label}.by_size.L`),
      XL: enumField(sizes.XL, ["shared", "per-ticket"], "per-ticket", `${label}.by_size.XL`),
    },
  };
}

function normalizeReview(value: unknown, label: string): TicketBuildSetupConfig["review"] {
  const raw = objectOrEmpty(value, label);
  const titleStyle = enumField(raw.title_style, ["ticket-title", "conventional", "none", "custom"], DEFAULT_TICKET_SETUP.build.review.title_style, `${label}.title_style`);
  const titleTemplate = nullableString(raw.title_template);
  if (titleStyle === "custom" && !titleTemplate) throw new Error(`${label}.title_template: required for custom title style`);
  return {
    title_style: titleStyle,
    title_template: titleTemplate,
    description_sections: stringArray(raw.description_sections, DEFAULT_TICKET_SETUP.build.review.description_sections, `${label}.description_sections`),
  };
}

function objectOrEmpty(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function enumField<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${label}: expected one of ${allowed.join(", ")}`);
}

function stringField(value: unknown, fallback?: string): string {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    return "";
  }
  if (typeof value !== "string" || !value.trim()) throw new Error("expected a non-empty string");
  return value.trim();
}

function nullableString(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("expected a string or null");
  return value.trim() || null;
}

function booleanField(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${label}: expected a boolean`);
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`${label}: expected a positive integer`);
}

function nonNegativeInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (Number.isInteger(value) && Number(value) >= 0) return Number(value);
  throw new Error(`${label}: expected a non-negative integer`);
}

function nullablePositiveInteger(value: unknown, fallback: number | null, label: string): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`${label}: expected a positive integer or null`);
}

function stringArray(value: unknown, fallback: string[], label: string): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) throw new Error(`${label}: expected non-empty strings`);
  return [...new Set(value.map((item) => String(item).trim()))];
}

function normalizeTargets(value: unknown): HarnessTarget[] {
  if (!Array.isArray(value)) return [];
  const out: HarnessTarget[] = [];
  for (const item of value) {
    if ((item === "claude" || item === "codex") && !out.includes(item)) out.push(item);
  }
  return out;
}

function cloneTicketSetup(setup: TicketsSetupConfig): TicketsSetupConfig {
  return {
    sources: setup.sources.map((source) => ({ ...source, ...(source.type === "local" ? { paths: [...source.paths] } : {}) }) as TicketSourceConfig),
    limits: { ...setup.limits },
    populate: { ...setup.populate },
    build: {
      ...setup.build,
      branch_policy: { ...setup.build.branch_policy, by_size: { ...setup.build.branch_policy.by_size } },
      review: { ...setup.build.review, description_sections: [...setup.build.review.description_sections] },
      validation_checklist: [...setup.build.validation_checklist],
    },
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function legacySourcesFromRegistry(entries: import("rafi-spec").ProjectSourceEntry[]): TicketSourceConfig[] {
  const out: TicketSourceConfig[] = [];
  for (const entry of entries.filter((item) => item.active)) {
    if (entry.type === "local" && entry.locator.path) out.push({ type: "local", paths: [entry.locator.path] });
    else if (entry.type === "url" && entry.locator.url) out.push({ type: "url", url: entry.locator.url });
    else if (entry.type === "linear") out.push({ type: "linear", api_key_env: entry.locator.api_key_env ?? "LINEAR_API_KEY", team_key: entry.locator.team_key, filter: entry.locator.filter });
    else if (entry.type === "jira" && entry.locator.site && entry.locator.jql) out.push({ type: "jira", site: entry.locator.site, email_env: entry.locator.email_env ?? "JIRA_EMAIL", token_env: entry.locator.token_env ?? "JIRA_API_TOKEN", jql: entry.locator.jql });
  }
  return dedupeTicketSources(out);
}
