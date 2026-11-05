// The org policy file, `~/.rafi/policy.yaml` (ARCH 8.6, 13; M5 plan C184): `version: 1` and `locked:`, a map of
// `rafi-config.yaml` dot paths to the value each must have. Every path must name a key (or lie inside one, such as
// `agent_defaults.roles.qa.model`), and each value is checked against that key's type.
import { CONFIG_KEYS, keyFor } from "./config-keys.js";

export type PolicyCheck = { ok: true; locked: Record<string, unknown> } | { ok: false; message: string };

const NAME = "policy.yaml";

export function checkPolicy(value: unknown): PolicyCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: `${NAME} must be a mapping with version and locked.` };
  }
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return { ok: false, message: `${NAME}: version must be the number 1.` };
  const extra = Object.keys(v).find((k) => k !== "version" && k !== "locked");
  if (extra) return { ok: false, message: `${NAME}: unknown key ${extra}.` };
  const locked = v.locked ?? {};
  if (!locked || typeof locked !== "object" || Array.isArray(locked)) {
    return { ok: false, message: `${NAME}: locked must be a mapping of setting paths to values.` };
  }
  for (const [path, item] of Object.entries(locked)) {
    const key = keyFor(path);
    if (!key) return { ok: false, message: `${NAME}: unknown key ${path}.` };
    if (key.key === path && CONFIG_KEYS[path]) {
      const checked = key.schema.safeParse(item);
      if (!checked.success) {
        return { ok: false, message: `${NAME}: ${path} ${checked.error.issues[0]?.message ?? "is invalid"}.` };
      }
    }
  }
  return { ok: true, locked: locked as Record<string, unknown> };
}
