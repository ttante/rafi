// The 1.0 config: the format marker, the reserved workflows key (M1, C17), and M2's settings with their defaults
// (ARCH 5.6, 6.9, 8.6; M2 plan 2.1). A wrong type for a known key names the key; unknown keys pass until M5.
import { z } from "zod";

export const CUSTOM_WORKFLOWS_MESSAGE = "Custom workflows aren't supported yet.";

export const configV1Schema = z
  .object({ format_version: z.literal(1) })
  .passthrough()
  .superRefine((value, ctx) => {
    if ("workflows" in value) ctx.addIssue({ code: "custom", message: CUSTOM_WORKFLOWS_MESSAGE, path: ["workflows"] });
  });

export type ConfigV1 = z.infer<typeof configV1Schema>;

export type ConfigCheck = { ok: true; config: ConfigV1 } | { ok: false; message: string };

export function checkConfigV1(value: unknown): ConfigCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "rafi-config.yaml must be a mapping of settings." };
  }
  const parsed = configV1Schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "workflows") return { ok: false, message: CUSTOM_WORKFLOWS_MESSAGE };
    return { ok: false, message: "rafi-config.yaml: format_version must be the number 1." };
  }
  for (const [key, setting] of Object.entries(SETTINGS)) {
    const found = lookup(value as Record<string, unknown>, key);
    if (found === undefined) continue;
    const checked = setting.schema.safeParse(found);
    if (!checked.success) {
      return { ok: false, message: `rafi-config.yaml: ${key} ${checked.error.issues[0]?.message ?? "is invalid"}.` };
    }
  }
  return { ok: true, config: parsed.data };
}

const count = z.number().int().nonnegative();
const minutes = z.number().positive();
const role = z.object({
  make: z.enum(["claude", "codex"]).optional(), model: z.string().optional(), reasoning: z.string().optional(),
  fast: z.boolean().optional(), session_strategy: z.enum(["fresh", "compact"]).optional(),
}).passthrough();

interface Setting {
  readonly schema: z.ZodType;
  readonly default: unknown;
}

const set = (schema: z.ZodType, value: unknown): Setting => Object.freeze({ schema, default: value });

/** C92: exact environment-variable names, no patterns (FMT-C28, FMT-C30); the first invalid one is named. */
const envNames = z.array(z.string(), { message: "must be a list of environment variable names" })
  .superRefine((names, ctx) => {
    const bad = names.find((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
    if (bad !== undefined) ctx.addIssue({ code: "custom", message: `has ${JSON.stringify(bad)}, which isn't an ` +
      "environment variable name (letters, digits and _, no patterns)" });
  });

/** M2's settings by dot path. `undefined` defaults are resolved by the engine (C34, C42). */
const SETTINGS: Readonly<Record<string, Setting>> = Object.freeze({
  "harness.targets": set(z.array(z.enum(["claude", "codex"])).min(1), ["claude", "codex"]),
  "harness.qa": set(z.boolean(), true),
  "agent_defaults.roles": set(z.record(z.string(), role), {}),
  "retries.fixes": set(count, 3),
  "retries.turn": set(count, 3),
  "retries.circling_repeats": set(z.number().int().positive(), 2),
  "retries.quota_wait_hours": set(z.number().nonnegative(), 6),
  "timeouts.idle_minutes": set(minutes, 30),
  "timeouts.check_quiet_minutes": set(minutes, 2),
  "timeouts.check_minutes": set(minutes, 5),
  "timeouts.suite_minutes": set(minutes, 20),
  "checks.test_runner": set(z.string().min(1), undefined),
  "checks.output_paths": set(z.array(z.string()), ["coverage/", "test-results/"]),
  "checks.run_without_sandbox": set(z.boolean({ message: "must be true or false" }), false),
  "checks.env": set(envNames, []),
  "agents.env": set(envNames, []),
  "docs.root": set(z.string().min(1), "docs"),
  "logs.capture": set(z.enum(["none", "normal", "detailed"]), "normal"),
  "tickets.build.branch_strategy": set(z.enum(["current", "batch", "branch-per-ticket"]), "current"),
  "tickets.build.completion": set(z.enum(["pr", "pr-ready", "auto-merge", "direct-merge", "none"]), "none"),
  "git.managed_by": set(z.enum(["rafi", "me"]), "rafi"),
  "approvals.mode": set(z.enum(["manual", "auto"]), "manual"),
  "manual_checks": set(z.enum(["wait", "none", "track"]), "wait"),
});

export const SETTING_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze(
  Object.fromEntries(Object.entries(SETTINGS).map(([key, s]) => [key, s.default])));

function lookup(config: Record<string, unknown>, key: string): unknown {
  let node: unknown = config;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

export type SettingSource = "default" | "project" | "flag" | "saved" | "auto-approve" | "terminal";
export type Settings = Record<string, { value: unknown; source: SettingSource }>;

/** Each M2 setting's effective value from a checked config, with its source (ARCH 8.6 minus policy and --set). */
export function settingsOf(config: Record<string, unknown>): Settings {
  const out: Settings = {};
  for (const [key, setting] of Object.entries(SETTINGS)) {
    const found = lookup(config, key);
    out[key] = found === undefined ? { value: setting.default, source: "default" } : { value: found, source: "project" };
  }
  return out;
}

