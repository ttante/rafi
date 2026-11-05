// Process set, part 4d (plan 10.12; C342 made the default): your shell's provider and model credentials (a real
// GITHUB_TOKEN, GH_*, GITLAB_*, GLAB_*, ANTHROPIC_*, OPENAI_*, CODEX_*, CLAUDE_*) never reach a launched rafi, its
// fakes or their state files, whatever launcher a process test uses. A variable a test passes on purpose in `env`
// still arrives. Canaries only: the real token is never read, printed or compared here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { launcher } from "../harness/process.js";
import { envFor, run } from "../harness/process-run.js";
import { deliverySetup } from "./delivery-helpers.js";

const POSIX = process.platform === "win32" ? "PATH executables need POSIX shebangs" : false;
const CANARY = "rafi-canary-4d-7c1e93";
const SHELL: Record<string, string> = { GITHUB_TOKEN: CANARY, GH_TOKEN: CANARY, GH_ENTERPRISE_TOKEN: CANARY,
  GITLAB_TOKEN: CANARY, GLAB_TOKEN: CANARY, ANTHROPIC_API_KEY: CANARY, OPENAI_API_KEY: CANARY,
  CODEX_API_KEY: CANARY, CLAUDE_CODE_OAUTH_TOKEN: CANARY, CLAUDECODE: CANARY };

/** Runs `body` with the canaries in this process's environment, then puts the environment back as it was. */
async function withShell<T>(body: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(SHELL).map((k) => [k, process.env[k]]));
  Object.assign(process.env, SHELL);
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Files under `dir` whose bytes contain `needle` (names only). */
function holding(dir: string, needle: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const info = statSync(file, { throwIfNoEntry: false });
    if (info?.isDirectory()) holding(file, needle, out);
    else if (info?.isFile() && readFileSync(file).includes(needle)) out.push(file);
  }
  return out;
}

test("4d: both launchers leave the shell's credentials out; a variable passed in `env` still arrives",
  { timeout: 60_000 }, async () => {
    await withShell(() => {
      const cwd = process.cwd();
      const env = envFor({ cwd });
      assert.deepEqual(Object.keys(SHELL).filter((k) => k in env), [], "process-run's launch");
      assert.ok(env.PATH && env.HOME, "the rest of the shell still arrives");
      assert.equal(envFor({ cwd, env: { GITHUB_TOKEN: "on-purpose" } }).GITHUB_TOKEN, "on-purpose");
      const r = launcher(["--version"], { cwd, engine: "next" });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(Object.keys(SHELL).filter((k) => k in r.env), [], "process.ts's launcher");
      assert.equal(launcher(["--version"], { cwd, env: { GH_TOKEN: "on-purpose" } }).env.GH_TOKEN, "on-purpose");
    });
  });

test("4d: a delivery build with a canary GITHUB_TOKEN in the shell: gh never gets it, no file holds it",
  { skip: POSIX, timeout: 180_000 }, async () => {
    await withShell(async () => {
      const s = deliverySetup("github", { env: { GH_TOKEN: "ghp_passed0123456789abcdefghijklmn" } });
      const opts = { cwd: s.opts.cwd, pathFirst: s.opts.pathFirst, env: s.opts.env };
      const r = await run(["start", ".", "--steps", "2", "--branch-per-ticket", "--completion", "pr"], opts);
      assert.equal(r.code, 0, r.output.slice(-2000));
      const gh = s.gh();
      assert.ok(gh.calls.length > 0);
      for (const c of gh.calls) {
        assert.deepEqual(Object.keys(SHELL).filter((k) => k !== "GH_TOKEN" && k in c.envValues), [], c.args.join(" "));
        assert.equal(c.envValues.GH_TOKEN, "ghp_passed0123456789abcdefghijklmn", "the passed token still arrives");
      }
      assert.ok(!r.output.includes(CANARY));
      assert.deepEqual(holding(s.root, CANARY), [], "no file under the run's folder holds the canary");
    });
  });
