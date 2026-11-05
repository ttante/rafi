// The environments rafi hands its children (ARCH 7.12, 6.9; M2 plan 11, C75–C79). Tests get the test allowlist:
// the base set, the cache variables and `checks.env`. Agents get the agent allowlist: the base set, TMPDIR, their
// own runtime's login variables and `agents.env`. Nothing else in the shell reaches a child: secrets stay out of
// anything an agent can read by never being put there. Pure; `deps.env` stays the whole shell, read only by rafi.
import path from "node:path";
import type { Env } from "../deps/types.js";
import { looksSecret } from "../log/redact.js";

/** Names and prefixes one rule passes. */
interface Allow { readonly names: readonly string[]; readonly prefixes?: readonly string[] }

const both = (names: readonly string[]) => names.flatMap((n) => [n, n.toLowerCase()]);

/** C76: proxies in both cases; certificate bundles. */
const PROXY = both(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"]);
const CERTS: readonly string[] = ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE", "GIT_SSL_CAINFO"];
const WINDOWS: readonly string[] = ["SystemRoot", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP"];

/** ARCH 7.12's base set (NEW-SEC-3). `SSH_AUTH_SOCK` isn't in it (C77): list it in checks.env or agents.env. */
export const BASE: Allow = Object.freeze({ names: ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "TERM",
  "CI", ...PROXY, ...CERTS, ...WINDOWS], prefixes: ["LC_"] });

/** C78: each runtime's own login and config variables; Claude's cloud logins only when that cloud is on. */
function login(env: Env, runtime: "codex" | "claude"): Allow {
  if (runtime === "codex") return { names: ["CODEX_HOME"], prefixes: ["OPENAI_"] };
  const prefixes = ["ANTHROPIC_", "CLAUDE_CODE_"];
  const names = ["CLAUDE_CONFIG_DIR"];
  if (env.CLAUDE_CODE_USE_BEDROCK) prefixes.push("AWS_");
  if (env.CLAUDE_CODE_USE_VERTEX) {
    prefixes.push("GOOGLE_", "GCLOUD_");
    names.push("CLOUD_ML_REGION");
  }
  return { names, prefixes };
}

/** Windows matches environment names case-insensitively (`Path`, `sentry_dsn`); other platforms exactly. */
const folder = (platform: string) => (platform === "win32" ? (s: string) => s.toUpperCase() : (s: string) => s);

/** The values `env` holds under `name`: exactly, or on Windows under any casing (as `pick` matches it). */
function lookup(env: Env, name: string, platform: string): string[] {
  const fold = folder(platform);
  return Object.entries(env).flatMap(([n, v]) => (v !== undefined && fold(n) === fold(name) ? [v] : []));
}

/** Whether the rules pass a name; on Windows, names match case-insensitively (`Path`). */
function passes(rules: readonly Allow[], platform: string): (name: string) => boolean {
  const fold = folder(platform);
  const names = new Set(rules.flatMap((r) => r.names.map(fold)));
  const prefixes = rules.flatMap((r) => (r.prefixes ?? []).map(fold));
  return (name) => names.has(fold(name)) || prefixes.some((p) => fold(name).startsWith(p));
}

/** The variables of `env` the rules pass. */
function pick(env: Env, rules: readonly Allow[], platform: string): Record<string, string> {
  const ok = passes(rules, platform);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && ok(name)) out[name] = value;
  return out;
}

/** C41: caches and TMPDIR that tests would write to the home folder point under `.rafi/cache/`. */
export function cacheVars(cache: string): Env {
  return Object.freeze({ npm_config_cache: path.join(cache, "npm"), YARN_CACHE_FOLDER: path.join(cache, "yarn"),
    XDG_CACHE_HOME: path.join(cache, "xdg"), TMPDIR: path.join(cache, "tmp") });
}

/** Every test run's environment (6.9), and the declared `checks.env` names that aren't set (`env_missing`, C82). */
export function testEnv(env: Env, o: { checksEnv: readonly string[]; cache: string; platform: string }):
  { env: Env; missing: string[] } {
  const passed = pick(env, [BASE, { names: o.checksEnv }], o.platform);
  const missing = o.checksEnv.filter((name) => !lookup(env, name, o.platform).length);
  return { env: Object.freeze({ ...passed, ...cacheVars(o.cache) }), missing };
}

/**
 * An agent runtime's environment: the base set, TMPDIR (C77), its own login and `agents.env`. Claude's QA gets no
 * TMPDIR from rafi, even a declared one: its temp files go to Claude Code's own sandbox temp folder (ARCH 7.11, P20).
 */
export function agentEnv(env: Env, runtime: "codex" | "claude", agentsEnv: readonly string[], platform: string,
  role: "builder" | "qa"): Env {
  const out = pick(env, [BASE, { names: ["TMPDIR", ...agentsEnv] }, login(env, runtime)], platform);
  if (runtime === "claude" && role === "qa") {
    for (const name of Object.keys(out)) if (folder(platform)(name) === "TMPDIR") delete out[name];
  }
  return Object.freeze(out);
}

/** C199: `gh` and `glab` get the base set plus their own login and host variables, as set; nothing else. */
export function providerEnv(env: Env, platform: string): Env {
  return Object.freeze(pick(env, [BASE, { names: ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN",
    "GITLAB_TOKEN", "GITLAB_HOST"], prefixes: ["GLAB_"] }], platform));
}

/** The shortest declared value under a plain name that redaction learns (NEW-SEC-8; shorter ones are words). */
export const MIN_DECLARED = 8;

/** Never learned, even when declared: the base set and the cache variables, TMPDIR among them (NEW-SEC-8). */
const PLAIN: readonly Allow[] = Object.freeze([BASE, { names: Object.keys(cacheVars("")) }]);

/**
 * C81, review 2 finding 1 (NEW-SEC-8): every value a declared name (checks.env, agents.env) hands a child, with its
 * name, for the redactor; a plain name's value only from 8 characters, a secret-looking name's as the redactor's own
 * floor allows. A name is looked up the way `pick` passes it, so on Windows `SENTRY_DSN` finds the shell's
 * `sentry_dsn` (review 2, finding 2).
 */
export function declaredValues(env: Env, names: readonly string[], platform: string): [string, string][] {
  const plain = passes(PLAIN, platform);
  return [...new Set(names)].filter((name) => !plain(name)).flatMap((name) => lookup(env, name, platform)
    .filter((value) => value && (looksSecret(name) || value.length >= MIN_DECLARED))
    .map((value): [string, string] => [name, value]));
}
