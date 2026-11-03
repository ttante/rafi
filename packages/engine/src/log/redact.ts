// The one redact() (ARCH 3.3, plan choice C8) and escapeControl() for rendering.
import type { Env } from "../deps/types.js";

export const REDACTED = "[REDACTED]";

/** Fields that hold identities rafi made (ids, digests, tree ids, paths); never secrets, never redacted. */
const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "id", "key", "digest", "tree", "base", "fp", "path", "sha", "plan_id", "instance", "entry_digest",
  "output_digest", "instruction_digest", "raw", "blob", "output", "run_id", "ticket_id",
]);

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH|PRIVATE)/i;

/** A name that looks like it holds a secret: the shell test plus DSN, COOKIE and SESSION (C81, for declared names). */
export function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name) || /(DSN|COOKIE|SESSION)/i.test(name);
}

/**
 * C80: a learned value raw and in its casual encodings (ARCH 7.12): base64 with and without padding, base64url,
 * hex in either case, URL-encoded; for values of 12 or more characters also the three base64 offset cores, so the
 * value encoded inside a longer string is caught whatever its byte offset. Not deliberate encodings.
 */
export function encodings(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const b64 = bytes.toString("base64");
  const hex = bytes.toString("hex");
  const out = [value, b64, b64.replace(/=+$/, ""), bytes.toString("base64url"), hex, hex.toUpperCase(),
    encodeURIComponent(value)];
  if (value.length >= 12) {
    for (const k of [0, 1, 2]) {
      const shifted = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64");
      const core = shifted.slice(k ? 4 : 0, Math.floor((k + bytes.length) / 3) * 4);
      out.push(core, core.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return [...new Set(out)].filter((form) => form.length >= 6);
}

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

/** [name, form] for every learned value's forms, longest first, so a longer form is replaced before its prefix. */
function learn(found: [string, string][], name: string, value: string): void {
  if (value.length < 6) return;
  for (const form of encodings(value)) found.push([name, form]);
  found.sort((a, b) => b[1].length - a[1].length);
}

function envSecrets(env: Env): [string, string][] {
  const found: [string, string][] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && SECRET_NAME.test(name)) learn(found, name, value);
  }
  return found;
}

export interface Redactor {
  text(value: string): string;
  value<T>(value: T): T;
  /** Registers a secret (a session token, C39; a declared value, C81, NEW-SEC-8); later writes redact it. */
  add(name: string, secret: string): void;
}

/** Builds the redactor for one engine instance: the fixed patterns plus the values of secret-named env vars. */
export function redactor(env: Env): Redactor {
  const secrets = envSecrets(env);
  const add = (name: string, secret: string) => learn(secrets, name, secret);
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
  return { text, value: <T>(value: T) => walk(value, null) as T, add };
}

/** Escapes terminal control characters for rendering untrusted text (FLAG-MG-10, S-CLI-12). */
export function escapeControl(input: string): string {
  return input.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}
