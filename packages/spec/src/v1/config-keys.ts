// Every 1.0 `rafi-config.yaml` key by dot path, with its type and default (ARCH 13, FMT-C1–C34; M5 plan C182).
// A key whose feature comes in a later milestone is accepted and type-checked but does nothing yet. Structured keys
// (maps such as `tools`, `tags`, `agent_defaults.roles`) are one key whose value has its own schema; a dot path
// inside one (`agent_defaults.roles.qa.model`) belongs to it, for `--set` and the org policy.
import { z } from "zod";

export interface ConfigKey {
  readonly key: string;
  readonly schema: z.ZodType;
  readonly default: unknown;
}

const count = z.number().int().nonnegative();
const minutes = z.number().positive();
const text = z.string().min(1);
const texts = z.array(z.string());
const bool = z.boolean({ message: "must be true or false" });

/** C92: exact environment-variable names, no patterns (FMT-C28, FMT-C30); the first invalid one is named. */
const envNames = z.array(z.string(), { message: "must be a list of environment variable names" })
  .superRefine((names, ctx) => {
    const bad = names.find((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
    if (bad !== undefined) ctx.addIssue({ code: "custom", message: `has ${JSON.stringify(bad)}, which isn't an ` +
      "environment variable name (letters, digits and _, no patterns)" });
  });

export const ROLE_NAMES = ["planner", "builder", "qa", "ticket-maker", "uninstaller", "manager", "discovery"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** FMT-C7: one role's settings; builder and QA also take the compaction pair. */
export const roleSettings = z.object({
  make: z.enum(["claude", "codex"]), model: text, reasoning: text, fast: bool,
  session_strategy: z.enum(["compact", "fresh"]), display_session_cost: bool,
  auto_compact_threshold_percent: z.number().int().min(1).max(99), compact_maximum: z.number().int().min(1),
}).partial().strict();

const roles = z.object(Object.fromEntries(ROLE_NAMES.map((r) => [r, roleSettings])) as Record<RoleName,
  typeof roleSettings>).partial().strict();

/** FMT-C5: a role file or skill's paths per runtime. */
const artifactPaths = z.object({ artifact_source: z.enum(["rafi", "existing"]), claude: text, codex: text }).strict();

/** FMT-C8: a ticket source (today's `schemas.ts:203-246`). */
const source = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local"), paths: z.array(text).min(1) }).strict(),
  z.object({ type: z.literal("linear"), api_key_env: text.optional(), team_key: z.string().nullable().optional(),
    filter: z.string().nullable().optional() }).strict(),
  z.object({ type: z.literal("jira"), site: text, email_env: text.optional(), token_env: text.optional(),
    jql: text }).strict(),
  z.object({ type: z.literal("url"), url: z.string().regex(/^https?:\/\//) }).strict(),
]);

const strategy = z.enum(["current", "batch", "branch-per-ticket"]);
const sizes = ["XS", "S", "M", "L", "XL"] as const;
const branchPolicy = z.object({
  mode: z.enum(["global", "size"]), global_strategy: strategy,
  by_size: z.object(Object.fromEntries(sizes.map((s) => [s, z.enum(["shared", "per-ticket"])]))).strict(),
}).strict();
const review = z.object({
  title_style: z.enum(["ticket-title", "conventional", "none", "custom"]), title_template: z.string().nullable()
    .optional(), description_sections: z.array(text),
}).strict();

/** FMT-C13 (C220's shape): a project tag with optional file patterns and a description. */
const tag = z.object({ patterns: z.array(text).optional(), description: z.string().optional() }).strict();

/** FMT-C12, ARCH 10.3: a tool entry (validated in full by the engine's `tools/registry.ts`). */
const tool = z.object({
  kind: z.enum(["mcp", "command"]), start: z.object({ command: text, args: texts.optional() }).strict(),
  description: z.string(), roles: z.array(z.enum(ROLE_NAMES)).optional(), tags: texts.optional(),
  permissions: texts.optional(), stop: z.string().optional(), evidence: z.record(z.string(), z.unknown()).optional(),
  versions: z.string().optional(), license: z.string().optional(), setup_notes: z.string().optional(),
  show_browser: bool.optional(),
}).strict();

const keep = z.union([z.enum(["ticket", "build", "forever"]),
  z.object({ builds: z.number().int().positive() }).strict(), z.object({ days: z.number().int().positive() }).strict()]);

/** Free-form maps whose shape a later milestone settles (FMT-C6 `sources`, `graph`; FMT-C17; FMT-C21). */
const later = z.record(z.string(), z.unknown());

const K = (key: string, schema: z.ZodType, value: unknown = undefined): [string, ConfigKey] =>
  [key, Object.freeze({ key, schema, default: value })];

export const CONFIG_KEYS: Readonly<Record<string, ConfigKey>> = Object.freeze(Object.fromEntries([
  K("format_version", z.literal(1), 1),
  K("appName", text), K("timezone", text, "UTC"),
  K("stack", z.object(Object.fromEntries(["frontend", "backend", "database", "cloud", "packageManager"]
    .map((k) => [k, z.string()]))).partial().strict()),
  K("flags", z.object({ hasFrontend: bool, usesAI: bool, runsInCloud: bool }).partial().strict()),
  K("harness.targets", z.array(z.enum(["claude", "codex"])).min(1), ["claude", "codex"]),
  K("harness.qa", z.boolean(), true),
  K("agent_files", z.object({ mode: z.enum(["append", "update", "overwrite"]), codex: text, claude: text })
    .partial().strict()),
  K("agents.env", envNames, []),
  K("agents.*", artifactPaths), K("skills.*", artifactPaths),
  K("docs.root", text, "docs"), K("planning.sources", texts, []), K("sources", later), K("graph", later),
  K("retries.fixes", count, 3), K("retries.turn", count, 3),
  K("retries.circling_repeats", z.number().int().positive(), 2), K("retries.quota_wait_hours", z.number()
    .nonnegative(), 6),
  K("timeouts.idle_minutes", minutes, 30), K("timeouts.check_quiet_minutes", minutes, 2),
  K("timeouts.check_minutes", minutes, 5), K("timeouts.suite_minutes", minutes, 20),
  K("checks.ci_tests", z.enum(["full", "light", "none"]), "full"),
  K("checks.ci_when", z.enum(["each-ticket", "each-pr", "end-of-build", "light-each-pr-full-end"]), "end-of-build"),
  K("checks.ci_blocks_merge", bool, false),
  K("checks.test_runner", text), K("checks.output_paths", texts, ["coverage/", "test-results/"]),
  K("checks.run_without_sandbox", bool, false), K("checks.env", envNames, []), K("checks.secrets", envNames, []),
  K("checks.secrets_with_internet", z.enum(["allow", "warn", "ask"]), "warn"),
  K("checks.sandbox", z.enum(["preferred", "required"]), "preferred"),
  K("security.preset", z.enum(["greenfield", "standard", "sensitive"]), "standard"),
  K("isolation.home", z.enum(["real", "guarded", "empty"]), "guarded"),
  K("isolation.deny_read", texts, []),
  K("grants.remember", bool, true),
  K("git.managed_by", z.enum(["rafi", "me"]), "rafi"),
  K("approvals.mode", z.enum(["manual", "auto"]), "manual"),
  K("plan_updates", z.enum(["change-then-tell", "ask-first"]), "change-then-tell"),
  K("manual_checks", z.enum(["wait", "none", "track"]), "wait"),
  K("locked_requirements", texts, []),
  K("tags", z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "tag names are lowercase letters, digits and -"), tag),
    {}),
  K("tools", z.record(z.string(), tool), {}),
  K("notifications", later), K("agent_permissions", later),
  K("logs.location", z.enum(["machine", "project"]), "machine"),
  K("logs.capture", z.enum(["none", "normal", "detailed"]), "normal"),
  K("recordings.save", z.enum(["failures", "all"]), "failures"),
  K("recordings.keep", keep, { builds: 5 }),
  K("agent_defaults.version", z.literal(1), 1), K("agent_defaults.revision", count, 0),
  K("agent_defaults.roles", roles, {}),
  K("tickets.limits", z.object({ implementation: z.number().int().min(1), view: z.number().int().min(1) }).strict()),
  K("tickets.sources", z.array(source), []),
  K("tickets.populate.mode", z.enum(["approved_plan", "external_import"])),
  K("tickets.populate.source_handling", z.enum(["saved", "prompt", "manual"])),
  K("tickets.populate.agent_preference", z.enum(["configured", "claude", "codex"]), "configured"),
  K("tickets.populate.import_cap", z.number().int().min(1)),
  K("tickets.populate.comment_limit", count),
  K("tickets.populate.enrichment", z.enum(["none", "recommendations", "agent"])),
  K("tickets.populate.recommend_split_for_xl", bool),
  K("tickets.build.branch_strategy", strategy, "current"),
  K("tickets.build.completion", z.enum(["pr", "pr-ready", "auto-merge", "direct-merge", "none"]), "none"),
  K("tickets.build.provider", z.enum(["auto", "github", "gitlab", "local"]), "auto"),
  K("tickets.build.merge_method", z.enum(["squash", "merge", "rebase"]), "merge"),
  K("tickets.build.cleanup", bool, true),
  K("tickets.build.auto_merge_wait", bool, true),
  K("tickets.build.auto_merge_timeout_minutes", z.number().int().min(1).nullable(), 60),
  K("tickets.build.base_branch", text), K("tickets.build.branch_prefix", text, "feature"),
  K("tickets.build.branch_policy", branchPolicy),
  K("tickets.build.review", review), K("tickets.build.validation_checklist", z.array(text), []),
  K("tickets.build.max_branch_depth", z.number().int().min(1), 5),
  K("tickets.build.keep_worktrees", bool, false),
]));

/** Keys removed in 1.0 that a project may still carry, with what replaced them (Q-CFG-1, FMT-C10, FMT-C11). */
export const REMOVED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "tickets.build.pr_ready": "use tickets.build.completion: pr-ready",
});

/** Reserved keys refused as custom workflows are (FMT-C26, FMT-C31). */
export const RESERVED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  workflows: "Custom workflows aren't supported yet.",
  "isolation.workspace": "isolation.workspace isn't supported yet.",
});

const wildcard = (path: string): string => path.replace(/^([^.]+)\.[^.]+/, "$1.*");

/** The registered key a dot path names or lies inside (`agent_defaults.roles.qa.model` → `agent_defaults.roles`). */
export function keyFor(path: string): ConfigKey | null {
  const parts = path.split(".");
  for (let n = parts.length; n >= 1; n -= 1) {
    const prefix = parts.slice(0, n).join(".");
    const found = CONFIG_KEYS[prefix] ?? (n === 2 && prefix !== "agents.env" ? CONFIG_KEYS[wildcard(prefix)] : null);
    if (found) return found;
  }
  return null;
}

/** Whether a dot path is a section holding keys (`retries`, `tickets.build`), not a key itself. */
export function isSection(path: string): boolean {
  return Object.keys(CONFIG_KEYS).some((k) => k.startsWith(`${path}.`));
}

export type Problem = { path: string; message: string };

/** The first problem in a config mapping: an unknown, removed or reserved key, or a value of the wrong type. */
export function firstProblem(value: Record<string, unknown>, at = ""): Problem | null {
  for (const [name, child] of Object.entries(value)) {
    const path = at ? `${at}.${name}` : name;
    if (RESERVED_KEYS[path]) return { path, message: RESERVED_KEYS[path]! };
    if (REMOVED_KEYS[path]) return { path, message: `rafi-config.yaml: ${path} was removed in 1.0; ${REMOVED_KEYS[path]}.` };
    const exact = CONFIG_KEYS[path] ?? (!at || path === "agents.env" ? null : CONFIG_KEYS[wildcard(path)] ?? null);
    if (exact && (exact.key.endsWith(".*") ? at.split(".").length === 1 : true)) {
      const checked = exact.schema.safeParse(child);
      if (!checked.success) return issueProblem(path, checked.error.issues[0]);
      continue;
    }
    if (isSection(path) && child && typeof child === "object" && !Array.isArray(child)) {
      const inner = firstProblem(child as Record<string, unknown>, path);
      if (inner) return inner;
      continue;
    }
    if (isSection(path)) return { path, message: `rafi-config.yaml: ${path} must be a mapping of settings.` };
    return { path, message: `rafi-config.yaml: unknown key ${path}.` };
  }
  return null;
}

function issueProblem(path: string, issue: z.core.$ZodIssue | undefined): Problem {
  if (issue?.code === "unrecognized_keys") {
    const where = [path, ...issue.path.map(String), issue.keys[0]].join(".");
    return { path: where, message: `rafi-config.yaml: unknown key ${where}.` };
  }
  const where = [path, ...(issue?.path ?? []).map(String)].join(".");
  return { path: where, message: `rafi-config.yaml: ${where} ${issue?.message ?? "is invalid"}.` };
}

/** Reads a dot path out of a mapping. */
export function lookup(config: Record<string, unknown>, key: string): unknown {
  let node: unknown = config;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}
