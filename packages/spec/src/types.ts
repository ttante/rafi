/**
 * Rafi neutral schema — the shapes that the `special-agents` library and the
 * `ai-foreman` runtime must agree on. Authoring inputs (rule packs, skills,
 * agent manifests) and the per-project configuration that drives composition.
 */

// ───────────────────────────── Rule packs ─────────────────────────────

/** Which category a rule pack belongs to (drives default load behavior). */
export type PackCategory = "base" | "process" | "domain" | "templated";

/**
 * When a pack applies. `always` packs load for every project; the others load
 * only when the matching project flag is on (see {@link ProjectFlags}).
 */
export type PackCondition = "always" | "frontend" | "ai" | "cloud" | "backend";

/** The YAML front-matter carried by each rule pack markdown file. */
export interface RulePackFrontmatter {
  /** Unique, kebab-case identifier (e.g. `security`). */
  name: string;
  category: PackCategory;
  /** One-line summary used in indexes and pack pickers. */
  description: string;
  condition: PackCondition;
  /** True when the body contains `{{placeholders}}` / `{{#if}}` directives. */
  template: boolean;
  /** When true, the pack is omitted while the foreman ticket tracker is active. */
  supersededByForeman?: boolean;
}

/** A fully loaded rule pack: its front-matter plus the markdown body. */
export interface RulePack extends RulePackFrontmatter {
  /** The rule text (bullets) below the front-matter. */
  body: string;
}

// ───────────────────────────── Skills ─────────────────────────────

/** How a skill should be treated when flattening for Codex (which can't lazy-load). */
export type CodexPriority = "inline" | "reference";

/**
 * A skill manifest. Keeps the existing Anthropic `SKILL.md` format and adds two
 * optional composition fields that non-Rafi tools can safely ignore.
 */
export interface SkillManifest {
  /** Unique, kebab-case identifier matching the skill directory name. */
  name: string;
  /** One-line trigger description (the cheap progressive-disclosure index). */
  description: string;
  /** Rule packs this skill wants loaded alongside it. */
  pins?: string[];
  /** Whether Codex flattening should inline this skill's body or just reference it. */
  codexPriority?: CodexPriority;
  /** The skill body (instructions). Optional in metadata-only contexts. */
  body?: string;
}

// ───────────────────────────── Agents (roles) ─────────────────────────────

/** The role an agent fills, mapped to an ai-foreman turn-type or command. */
export type AgentRole = "builder" | "qa" | "planner" | "ticket-maker";

/** Reasoning effort levels accepted by the builders. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh";

/** Packs added to a role only when the matching project flag is on. */
export interface ConditionalPacks {
  ai?: string[];
  frontend?: string[];
  cloud?: string[];
  backend?: string[];
}

/**
 * A role manifest: a named composition of rule packs + skills that the runtime
 * loads for a given turn-type.
 */
export interface AgentManifest {
  /** Unique, kebab-case identifier (usually equals {@link role}). */
  name: string;
  description: string;
  role: AgentRole;
  /** Pack references; globs like `base/*` are allowed and expanded at compile time. */
  packs: string[];
  /** Skill names this role preloads. */
  skills: string[];
  /** Extra packs gated on project flags. */
  conditionalPacks?: ConditionalPacks;
  /** Model override; null inherits the runtime's `--model`. */
  model?: string | null;
  /** Effort override; null inherits the runtime's `--effort`. */
  effort?: EffortLevel | null;
}

// ───────────────────────────── Project config ─────────────────────────────

/** Which harness targets to emit native config for. */
export type HarnessTarget = "claude" | "codex";

/** The stack choices collected by `rafi create` (free-text strings). */
export interface ProjectStack {
  frontend: string;
  backend: string;
  database: string;
  cloud: string;
  packageManager: string;
}

/** Boolean flags that gate conditional packs and docs. */
export interface ProjectFlags {
  hasFrontend: boolean;
  usesAI: boolean;
  runsInCloud: boolean;
}

/** Harness emission + QA preferences. */
export interface HarnessConfig {
  targets: HarnessTarget[];
  qa: boolean;
}

/**
 * The committed `project.yaml` in a target repo. Skipping the walkthrough uses
 * the library defaults, which reproduce today's hardcoded guidance.
 */
export interface ProjectConfig {
  appName: string;
  timezone: string;
  stack: ProjectStack;
  flags: ProjectFlags;
  harness: HarnessConfig;
}
