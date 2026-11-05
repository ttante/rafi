// Process set, M5 plan item 20 (slice 11; SCN `:1609`; C199, C216, C340): real `gh` and `glab` executables first on
// PATH, driven by the built launcher. F-BRANCH `--steps 2 --branch-per-ticket --completion pr`, once per provider:
// one PR per ticket, each from its own body file under `.foreman/pr-bodies/`; the provider's environment holds no
// canary from rafi's shell and no variable outside C199's allowlist; a failed readiness check without a terminal
// exits 1 with the fix line, before any agent turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BASE } from "../../engine/src/agents/env.js";
import { loadState, saveState } from "../fakes/gh-cli.mjs";
import { run } from "../harness/process-run.js";
import { deliverySetup, flagOf, type Provider } from "./delivery-helpers.js";

const POSIX = process.platform === "win32" ? "PATH executables need POSIX shebangs" : false;
const CANARY = "rafi-shell-canary-5f3a9c";
const TOKENS: Record<Provider, Record<string, string>> = {
  github: { GH_TOKEN: "ghp_proc0123456789abcdefghijklmn" },
  gitlab: { GITLAB_TOKEN: "glpat-proc0123456789abcdefgh" },
};
const PROVIDER_NAMES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN", "GITLAB_TOKEN", "GITLAB_HOST"];
// C341: macOS's CoreFoundation adds `__CF_USER_TEXT_ENCODING` inside every node child (`env -i PATH=… node` shows
// it), so it isn't something rafi passed.
const OS_ADDED = process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [];
const allowed = (name: string) => OS_ADDED.includes(name) || BASE.names.includes(name) ||
  PROVIDER_NAMES.includes(name) ||
  (BASE.prefixes ?? []).some((p) => name.startsWith(p)) || name.startsWith("GLAB_");
const HEADS = ["feature/T1-add-the-parser", "feature/T2-add-the-printer"];

for (const provider of ["github", "gitlab"] as const) {
  const cmd = provider === "github" ? "gh" : "glab";
  test(`item 20 (${provider}): one PR per ticket from its body file; ${cmd} gets only C199's allowlist`,
    { skip: POSIX, timeout: 180_000 }, async () => {
      const s = deliverySetup(provider, { env: { RAFI_TEST_CANARY: CANARY, MY_API_SECRET: CANARY,
        ...TOKENS[provider] } });
      const r = await run(["start", ".", "--steps", "2", "--branch-per-ticket", "--completion", "pr"], s.opts);
      assert.equal(r.code, 0, r.output.slice(-2000));
      const gh = s.gh();
      assert.ok(gh.calls.length > 0 && gh.calls.every((c) => c.cmd === cmd), gh.calls.map((c) => c.cmd).join(" "));
      assert.deepEqual(gh.prs.map((p) => p.head).sort(), HEADS, "one PR per ticket");
      assert.ok(gh.prs.every((p) => p.draft && p.state === "OPEN"));
      const creates = gh.calls.filter((c) => c.args[1] === "create");
      assert.equal(creates.length, 2, "one create per ticket");
      for (const [i, c] of creates.entries()) {
        const file = flagOf(c.args, provider === "github" ? "--body-file" : "--description-file")!;
        assert.ok(file.startsWith(path.join(s.project, ".foreman", "pr-bodies") + path.sep), file);
        assert.ok(existsSync(file), file);
        const pr = gh.prs.find((p) => p.head === (flagOf(c.args, "--head") ?? flagOf(c.args, "--source-branch")))!;
        assert.equal(pr.body, readFileSync(file, "utf8"), "the PR's body is its body file");
        assert.match(pr.body, new RegExp(`T${i + 1}: Add the p`));
      }
      const e = await s.exported();
      assert.deepEqual(e.events.filter((x) => x.type === "pr.created").map((x) => (x.data as { url: string }).url)
        .sort(), gh.prs.map((p) => p.url).sort());
      for (const c of gh.calls) {
        assert.ok(!JSON.stringify(c.envValues).includes(CANARY), `no canary in ${cmd}'s environment`);
        assert.deepEqual(c.env.filter((n) => !allowed(n)), [], `${cmd} got only allowlisted names`);
        assert.ok(c.env.includes("PATH"));
        for (const [name, value] of Object.entries(TOKENS[provider])) assert.equal(c.envValues[name], value);
        assert.ok(!c.args.some((a) => Object.values(TOKENS[provider]).some((v) => a.includes(v))), "no token in argv");
      }
    });
}

test("item 20: readiness fails without a terminal: exit 1 with the fix line, before any agent turn",
  { skip: POSIX, timeout: 120_000 }, async () => {
    const s = deliverySetup("github");
    const state = loadState(s.state);
    state.notReady = true;
    saveState(state, s.state);
    const r = await run(["start", ".", "--steps", "2", "--branch-per-ticket", "--completion", "pr"], s.opts);
    assert.equal(r.code, 1, r.output.slice(-2000));
    assert.match(r.output, new RegExp("GitHub isn't ready: You are not logged into any GitHub hosts\\. " +
      "Fix it with `gh auth login`, then run `rafi resume`\\."));
    const gh = s.gh();
    assert.deepEqual(gh.calls.map((c) => c.args.slice(0, 2).join(" ")), ["auth status"]);
    const e = await s.exported();
    assert.ok(!e.events.some((x) => x.type === "turn.intent"), "no agent turn");
    assert.equal(gh.prs.length, 0);
  });
