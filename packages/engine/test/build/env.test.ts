// M2 plan 11.4 (the secrets floor, ARCH 7.12, C75–C79): the base set, the test allowlist with checks.env and
// env_missing, the agent allowlist with each runtime's own login only, Windows names, and Codex's shell policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { agentEnv, codexShellPolicy, declaredValues, MIN_DECLARED, testEnv } from "../../src/build/env.js";
import { redactor } from "../../src/log/redact.js";

const SHELL = Object.freeze({
  PATH: "/usr/bin", HOME: "/home/u", USER: "u", LOGNAME: "u", SHELL: "/bin/zsh", LANG: "en_US.UTF-8",
  LC_ALL: "C", LC_CTYPE: "UTF-8", TZ: "UTC", TERM: "xterm", CI: "1", HTTPS_PROXY: "http://proxy:8080",
  https_proxy: "http://proxy:8080", NO_PROXY: "localhost", NODE_EXTRA_CA_CERTS: "/etc/ca.pem", SSL_CERT_FILE: "/c",
  TMPDIR: "/var/tmp/u", SSH_AUTH_SOCK: "/tmp/agent.sock", RAFI_CANARY_TOKEN: "canary-0123456789abcdef01234567",
  STRIPE_KEY: "canary-stripe", DATABASE_URL: "postgres://localhost/test", PROJECT_FLAG: "1",
  ANTHROPIC_API_KEY: "sk-ant-fake", CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CONFIG_DIR: "/home/u/.claude",
  OPENAI_API_KEY: "sk-openai-fake", CODEX_HOME: "/home/u/.codex", AWS_SECRET_ACCESS_KEY: "aws-secret",
  GOOGLE_APPLICATION_CREDENTIALS: "/g.json", npm_config_cache: "/home/u/.npm",
});

const BASE = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "CI",
  "HTTPS_PROXY", "https_proxy", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

test("tests get the base set, the cache variables and checks.env; nothing else; unset names are env_missing", () => {
  const cache = "/p/.rafi/cache";
  const { env, missing } = testEnv(SHELL, { checksEnv: ["DATABASE_URL", "UNSET_NAME"], cache, platform: "darwin" });
  assert.deepEqual(Object.keys(env).sort(), [...BASE, "DATABASE_URL", "npm_config_cache", "YARN_CACHE_FOLDER",
    "XDG_CACHE_HOME", "TMPDIR"].sort());
  assert.equal(env.DATABASE_URL, "postgres://localhost/test");
  assert.equal(env.npm_config_cache, path.join(cache, "npm"), "the cache variables win over the shell's");
  assert.equal(env.TMPDIR, path.join(cache, "tmp"));
  assert.deepEqual(missing, ["UNSET_NAME"]);
  for (const name of ["RAFI_CANARY_TOKEN", "STRIPE_KEY", "SSH_AUTH_SOCK", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    assert.equal(name in env, false, `${name} withheld from tests`);
  }
  assert.ok(Object.isFrozen(env));
});

test("agents get the base set, TMPDIR, agents.env and only their own runtime's login", () => {
  const claude = agentEnv(SHELL, "claude", ["PROJECT_FLAG"], "darwin", "builder");
  assert.deepEqual(Object.keys(claude).sort(), [...BASE, "TMPDIR", "PROJECT_FLAG", "ANTHROPIC_API_KEY",
    "CLAUDE_CONFIG_DIR"].sort());
  const codex = agentEnv(SHELL, "codex", ["PROJECT_FLAG"], "darwin", "builder");
  assert.deepEqual(Object.keys(codex).sort(), [...BASE, "TMPDIR", "PROJECT_FLAG", "OPENAI_API_KEY",
    "CODEX_HOME"].sort());
  for (const env of [claude, codex]) {
    for (const name of ["RAFI_CANARY_TOKEN", "STRIPE_KEY", "DATABASE_URL", "SSH_AUTH_SOCK", "AWS_SECRET_ACCESS_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS", "npm_config_cache"]) assert.equal(name in env, false, name);
  }
});

test("Claude QA gets no TMPDIR, even a declared one (P20, ARCH 7.11); Codex QA keeps it", () => {
  assert.equal("TMPDIR" in agentEnv(SHELL, "claude", ["TMPDIR"], "darwin", "qa"), false);
  assert.equal("tmpdir" in agentEnv({ ...SHELL, TMPDIR: undefined, tmpdir: "/t" }, "claude", [], "win32", "qa"), false);
  assert.equal(agentEnv(SHELL, "codex", [], "darwin", "qa").TMPDIR, SHELL.TMPDIR);
  assert.equal(agentEnv(SHELL, "claude", [], "darwin", "qa").PATH, SHELL.PATH);
});

test("Claude on Bedrock or Vertex also gets those logins; Codex never does", () => {
  const bedrock = agentEnv({ ...SHELL, CLAUDE_CODE_USE_BEDROCK: "1" }, "claude", [], "linux", "builder");
  assert.equal(bedrock.AWS_SECRET_ACCESS_KEY, "aws-secret");
  assert.equal(bedrock.CLAUDE_CODE_USE_BEDROCK, "1");
  const vertex = agentEnv({ ...SHELL, CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "us-east5",
    GCLOUD_PROJECT: "p" }, "claude", [], "linux", "builder");
  assert.deepEqual([vertex.GOOGLE_APPLICATION_CREDENTIALS, vertex.CLOUD_ML_REGION, vertex.GCLOUD_PROJECT],
    ["/g.json", "us-east5", "p"]);
  assert.equal("AWS_SECRET_ACCESS_KEY" in vertex, false);
  const codex = agentEnv({ ...SHELL, CLAUDE_CODE_USE_BEDROCK: "1" }, "codex", [], "linux", "builder");
  assert.equal("AWS_SECRET_ACCESS_KEY" in codex, false);
});

test("Windows names pass, matched case-insensitively there; exact elsewhere", () => {
  const win = { Path: "C:\\Windows", SystemRoot: "C:\\Windows", ComSpec: "cmd.exe", PATHEXT: ".EXE",
    USERPROFILE: "C:\\Users\\u", APPDATA: "a", LOCALAPPDATA: "l", TEMP: "t", TMP: "t", windir: "C:\\Windows",
    Secret_Thing: "x" };
  const env = testEnv(win, { checksEnv: [], cache: "C:\\p\\.rafi\\cache", platform: "win32" }).env;
  for (const name of ["Path", "SystemRoot", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP",
    "TMP"]) assert.equal(env[name], win[name as keyof typeof win], name);
  assert.equal("Secret_Thing" in env, false);
  assert.equal("Path" in testEnv(win, { checksEnv: [], cache: "/c", platform: "linux" }).env, false);
  assert.equal(agentEnv(win, "codex", [], "win32", "builder").Path, "C:\\Windows");
});

test("checks.env and agents.env names reach only their own side", () => {
  const tests = testEnv(SHELL, { checksEnv: ["PROJECT_FLAG"], cache: "/c", platform: "darwin" }).env;
  assert.equal(tests.PROJECT_FLAG, "1");
  assert.equal("PROJECT_FLAG" in agentEnv(SHELL, "claude", [], "darwin", "builder"), false);
  assert.equal("DATABASE_URL" in agentEnv(SHELL, "codex", ["PROJECT_FLAG"], "darwin", "builder"), false);
});

test("Codex's shells: the agent environment minus Codex's own API key (C79)", () => {
  assert.deepEqual(codexShellPolicy(), { inherit: "all", exclude: ["OPENAI_*"] });
});

test("every declared value is learned for redaction, whatever its name (C81, NEW-SEC-8, review 2 finding 1)", () => {
  const shell = { ...SHELL, SENTRY_DSN: "https://k@sentry.example/1", SESSION_COOKIE: "abcdef123",
    DB_URL: "postgres://db.internal/app", DEPLOY_REGION: "eu-west-7" };
  const names = ["SENTRY_DSN", "SESSION_COOKIE", "DB_URL", "DEPLOY_REGION", "DATABASE_URL", "UNSET", "DB_URL"];
  assert.deepEqual(declaredValues(shell, names, "darwin"), [["SENTRY_DSN", shell.SENTRY_DSN],
    ["SESSION_COOKIE", "abcdef123"], ["DB_URL", shell.DB_URL], ["DEPLOY_REGION", "eu-west-7"],
    ["DATABASE_URL", "postgres://localhost/test"]], "each once; an unset name has no value");
});

test("a plain name's value is learned from 8 characters; a secret-looking name's as before (6)", () => {
  assert.equal(MIN_DECLARED, 8);
  const shell = { SEVEN: "1234567", EIGHT: "12345678", MY_TOKEN: "abcdef", MY_KEY: "abcde" };
  assert.deepEqual(declaredValues(shell, ["SEVEN", "EIGHT", "MY_TOKEN", "MY_KEY"], "linux"),
    [["EIGHT", "12345678"], ["MY_TOKEN", "abcdef"], ["MY_KEY", "abcde"]]);
  const r = redactor({});
  for (const [name, value] of declaredValues(shell, ["SEVEN", "EIGHT", "MY_KEY"], "linux")) r.add(name, value);
  assert.equal(r.text("1234567 12345678 abcde"), "1234567 [REDACTED:EIGHT] abcde", "the redactor's floor is 6");
});

test("the base set and the cache variables are never learned, even when declared, in any casing on Windows", () => {
  const plain = [...BASE, "npm_config_cache", "YARN_CACHE_FOLDER", "XDG_CACHE_HOME", "TMPDIR", "LC_MESSAGES"];
  const shell = { ...SHELL, YARN_CACHE_FOLDER: "/home/u/.yarn", XDG_CACHE_HOME: "/home/u/.c",
    LC_MESSAGES: "en_US.UTF-8" };
  assert.deepEqual(declaredValues(shell, plain, "darwin"), []);
  const win = { Path: "C:\\Windows\\System32", userprofile: "C:\\Users\\u", SystemRoot: "C:\\Windows" };
  assert.deepEqual(declaredValues(win, ["PATH", "USERPROFILE", "SYSTEMROOT"], "win32"), []);
});

test("a declared plain value is redacted raw and encoded, labeled with its name", () => {
  const value = "postgres://db.internal:5432/app_main";
  const r = redactor({ DB_URL: value });
  assert.equal(r.text(`url ${value}`), `url ${value}`, "not learned from the shell by its name alone");
  for (const [name, v] of declaredValues({ DB_URL: value }, ["DB_URL"], "linux")) r.add(name, v);
  const bytes = Buffer.from(value);
  for (const form of [value, bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex"),
    encodeURIComponent(value)]) {
    assert.equal(r.text(`printed ${form}.`), "printed [REDACTED:DB_URL].", form);
  }
});

test("Windows: a declared name finds the shell's differently cased one, for env_missing and redaction (review 2)",
  () => {
  const shell = { Path: "C:\\Windows", sentry_dsn: "https://k@sentry.example/1" };
  const win = testEnv(shell, { checksEnv: ["SENTRY_DSN", "UNSET"], cache: "C:\\c", platform: "win32" });
  assert.equal(win.env.sentry_dsn, shell.sentry_dsn);
  assert.deepEqual(win.missing, ["UNSET"]);
  assert.deepEqual(declaredValues(shell, ["SENTRY_DSN"], "win32"), [["SENTRY_DSN", shell.sentry_dsn]]);
  const linux = testEnv(shell, { checksEnv: ["SENTRY_DSN"], cache: "/c", platform: "linux" });
  assert.deepEqual(linux.missing, ["SENTRY_DSN"]);
  assert.deepEqual(declaredValues(shell, ["SENTRY_DSN"], "linux"), [], "exact elsewhere");
});
