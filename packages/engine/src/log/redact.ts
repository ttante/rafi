// The one redact() (ARCH 3.3, plan choice C8) and escapeControl() for rendering.
import type { Env } from "../deps/types.js";

export const REDACTED = "[REDACTED]";

/** Fields that hold identities rafi made (ids, digests, tree ids, paths); never secrets, never redacted. */
const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "id", "key", "digest", "tree", "base", "fp", "path", "sha", "plan_id", "instance", "entry_digest",
  "output_digest", "instruction_digest", "raw", "blob", "output", "run_id", "ticket_id",
]);

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH|PRIVATE)/i;

const KV_NAMES = "api[_-]?key|access[_-]?key|token|password|passwd|secret|authorization";
const KEY_VALUE = new RegExp(`\\b([A-Za-z0-9_-]*?(?:${KV_NAMES}))(\\s*[:=]\\s*)(["']?)([^\\s"',;&]+)\\3`, "gi");

const PATTERNS: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/g, `Bearer ${REDACTED}`],
  [/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})/g, REDACTED],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [KEY_VALUE, `$1$2$3${REDACTED}$3`],
]);

function envSecrets(env: Env): [string, string][] {
  const found: [string, string][] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 6 && SECRET_NAME.test(name)) found.push([name, value]);
  }
  return found.sort((a, b) => b[1].length - a[1].length);
}

export interface Redactor {
  text(value: string): string;
  value<T>(value: T): T;
}

/** Builds the redactor for one engine instance: the fixed patterns plus the values of secret-named env vars. */
export function redactor(env: Env): Redactor {
  const secrets = envSecrets(env);
  const text = (input: string): string => {
    let out = input;
    for (const [name, secret] of secrets) out = out.split(secret).join(`[REDACTED:${name}]`);
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  };
  const walk = (input: unknown, key: string | null): unknown => {
    if (typeof input === "string") return key !== null && IDENTITY_KEYS.has(key) ? input : text(input);
    if (Array.isArray(input)) return input.map((item) => walk(item, key));
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(input)) out[name] = walk(item, name);
      return out;
    }
    return input;
  };
  return { text, value: <T>(value: T) => walk(value, null) as T };
}

/** Escapes terminal control characters for rendering untrusted text (FLAG-MG-10, S-CLI-12). */
export function escapeControl(input: string): string {
  return input.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}
