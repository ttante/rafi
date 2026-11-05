// The 1.0 config: the format marker, the reserved workflows key (M1, C17), and every 1.0 key by dot path with its
// type and default (config-keys.ts, M5 C182). A wrong type names the key; an unknown key exits 1 naming it.
import { z } from "zod";
import { CONFIG_KEYS, firstProblem, lookup } from "./config-keys.js";

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
  const problem = firstProblem(value as Record<string, unknown>);
  if (problem) return { ok: false, message: problem.message };
  return { ok: true, config: parsed.data };
}

/** Each registered key's default (wildcard keys have none). */
export const SETTING_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze(
  Object.fromEntries(Object.values(CONFIG_KEYS).filter((k) => !k.key.endsWith(".*")).map((k) => [k.key, k.default])));

export type SettingSource = "default" | "project" | "flag" | "saved" | "auto-approve" | "terminal" | "policy";
export type Settings = Record<string, { value: unknown; source: SettingSource }>;

/** Each key's effective value from a checked config, with its source: project when set, else default. Wildcard
 * keys (`agents.*`, `skills.*`) aren't settings. The engine adds the policy, flag and `--set` layers (ARCH 8.6). */
export function settingsOf(config: Record<string, unknown>): Settings {
  const out: Settings = {};
  for (const setting of Object.values(CONFIG_KEYS)) {
    if (setting.key.endsWith(".*")) continue;
    const found = lookup(config, setting.key);
    out[setting.key] = found === undefined ? { value: setting.default, source: "default" }
      : { value: found, source: "project" };
  }
  return out;
}

