// M5 slice 1 (plan items 23, C182, C184): every 1.0 rafi-config.yaml key by dot path with its type; unknown keys
// exit 1 naming them; the org policy file's checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConfigV1, settingsOf } from "../../src/v1/config.js";
import { CONFIG_KEYS, keyFor } from "../../src/v1/config-keys.js";
import { checkPolicy } from "../../src/v1/policy.js";

/** A 1.0 config using every key family of ARCH 13 `:1661` and FMT-C1–C34 (S-CLI-19's setup). */
export const FULL_CONFIG = {
  format_version: 1, appName: "fixture", timezone: "UTC",
  stack: { frontend: "react", backend: "node", database: "postgres", cloud: "none", packageManager: "pnpm" },
  flags: { hasFrontend: true, usesAI: false, runsInCloud: false },
  harness: { targets: ["claude", "codex"], qa: true },
  agent_files: { mode: "append", codex: "AGENTS.md", claude: "CLAUDE.md" },
  agents: { env: ["A_NAME"], builder: { artifact_source: "rafi", claude: ".claude/agents/b.md", codex: "b.md" } },
  skills: { tdd: { artifact_source: "existing", claude: ".claude/skills/tdd", codex: ".codex/skills/tdd" } },
  docs: { root: "docs" }, planning: { sources: ["docs/brief.md"] },
  retries: { fixes: 3, turn: 3, circling_repeats: 2, quota_wait_hours: 6 },
  timeouts: { idle_minutes: 30, check_quiet_minutes: 2, check_minutes: 5, suite_minutes: 20 },
  checks: { ci_tests: "full", ci_when: "end-of-build", ci_blocks_merge: false, test_runner: "npm test",
    output_paths: ["coverage/"], run_without_sandbox: false, env: ["DATABASE_URL"], secrets: ["API_KEY"],
    secrets_with_internet: "warn", sandbox: "preferred" },
  security: { preset: "standard" }, isolation: { home: "guarded", deny_read: ["~/.aws"] },
  grants: { remember: true }, git: { managed_by: "rafi" }, approvals: { mode: "manual" },
  plan_updates: "change-then-tell", manual_checks: "wait", locked_requirements: ["Always use PostgreSQL"],
  tags: { payments: { patterns: ["src/pay/**"], description: "Payment code" } },
  tools: { playwright: { kind: "mcp", start: { command: "npx", args: ["@playwright/mcp"] }, description: "Browser",
    roles: ["qa"], tags: ["ui"], permissions: ["local-servers"] } },
  notifications: { enabled: true }, logs: { location: "machine", capture: "normal" },
  recordings: { save: "failures", keep: { builds: 5 } }, agent_permissions: { allow: [] },
  agent_defaults: { version: 1, revision: 2, roles: { builder: { make: "codex", model: "m", reasoning: "high",
    fast: false, session_strategy: "fresh", display_session_cost: true, auto_compact_threshold_percent: 80,
    compact_maximum: 3 }, uninstaller: { make: "claude" } } },
  tickets: {
    limits: { implementation: 500, view: 20000 }, sources: [{ type: "local", paths: [".tickets/import.yaml"] }],
    populate: { mode: "approved_plan", source_handling: "saved", agent_preference: "configured", import_cap: 50,
      comment_limit: 10, enrichment: "none", recommend_split_for_xl: true },
    build: { branch_strategy: "branch-per-ticket", completion: "pr-ready", provider: "github", merge_method: "squash",
      cleanup: true, auto_merge_wait: true, auto_merge_timeout_minutes: 30, base_branch: "main", branch_prefix: "work",
      branch_policy: { mode: "size", global_strategy: "current", by_size: { XS: "shared", S: "shared",
        M: "per-ticket", L: "per-ticket", XL: "per-ticket" } },
      review: { title_style: "ticket-title", description_sections: ["Summary"] },
      validation_checklist: ["Tests pass"], max_branch_depth: 5, keep_worktrees: false },
  },
};

test("a 1.0 config using every key validates (S-CLI-19)", () => {
  const r = checkConfigV1(FULL_CONFIG);
  assert.equal(r.ok, true, r.ok ? "" : r.message);
});

test("an unknown key anywhere exits 1 naming its dot path; removed keys too", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ nosuch: { key: 1 } }, /unknown key nosuch/],
    [{ checks: { nope: 1 } }, /unknown key checks\.nope/],
    [{ tickets: { build: { pr_ready: true } } }, /tickets\.build\.pr_ready.*completion: pr-ready/],
    [{ agent_defaults: { roles: { painter: {} } } }, /agent_defaults\.roles\.painter/],
    [{ agent_defaults: { roles: { qa: { colour: "x" } } } }, /agent_defaults\.roles\.qa\.colour/],
    [{ autonomy: { profile: "balanced" } }, /unknown key autonomy/],
  ];
  for (const [extra, message] of cases) {
    const r = checkConfigV1({ format_version: 1, ...extra });
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.match(r.ok ? "" : r.message, message);
  }
});

test("reserved keys: workflows and isolation.workspace exit 1 like custom workflows", () => {
  for (const extra of [{ workflows: [] }, { isolation: { workspace: "copy" } }]) {
    const r = checkConfigV1({ format_version: 1, ...extra });
    assert.match(r.ok ? "" : r.message, /aren't supported yet|isn't supported yet/);
  }
});

test("each key's type is checked and named; the defaults of FMT-C9, C23, C27, C32 and Q-CFG-1", () => {
  for (const [extra, key] of [[{ checks: { ci_when: "never" } }, "checks.ci_when"],
    [{ tickets: { build: { max_branch_depth: 0 } } }, "tickets.build.max_branch_depth"],
    [{ security: { preset: "loose" } }, "security.preset"], [{ grants: { remember: "yes" } }, "grants.remember"],
    [{ tickets: { build: { completion: "merge" } } }, "tickets.build.completion"]] as const) {
    const r = checkConfigV1({ format_version: 1, ...extra });
    assert.match(r.ok ? "" : r.message, new RegExp(key.replace(/\./g, "\\.")), key);
  }
  const s = settingsOf({ format_version: 1 });
  assert.deepEqual(s["checks.ci_tests"], { value: "full", source: "default" });
  assert.deepEqual(s["checks.ci_when"], { value: "end-of-build", source: "default" });
  assert.deepEqual(s["checks.ci_blocks_merge"], { value: false, source: "default" });
  assert.deepEqual(s["security.preset"], { value: "standard", source: "default" });
  assert.deepEqual(s["grants.remember"], { value: true, source: "default" });
  assert.deepEqual(s["tickets.build.max_branch_depth"], { value: 5, source: "default" });
  assert.deepEqual(s["tickets.build.keep_worktrees"], { value: false, source: "default" });
});

test("keyFor finds the registered key a dot path names or lies inside", () => {
  assert.equal(keyFor("retries.fixes")?.key, "retries.fixes");
  assert.equal(keyFor("agent_defaults.roles.qa.model")?.key, "agent_defaults.roles");
  assert.equal(keyFor("tools.playwright.show_browser")?.key, "tools");
  assert.equal(keyFor("nosuch.key"), null);
  assert.equal(keyFor("retries"), null, "a section, not a key");
  assert.ok(Object.keys(CONFIG_KEYS).length >= 60);
});

test("the org policy file: version 1, locked keys by dot path, each value checked against its key (C184)", () => {
  assert.equal(checkPolicy({ version: 1, locked: { "security.preset": "sensitive" } }).ok, true);
  assert.equal(checkPolicy({ version: 1, locked: { "agent_defaults.roles.qa.model": "m-qa" } }).ok, true);
  for (const [value, message] of [[{ version: 2, locked: {} }, /version/], [{ version: 1, locked: { nope: 1 } },
    /unknown key nope/], [{ version: 1, locked: { "security.preset": "loose" } }, /security\.preset/],
  [{ version: 1, locked: [] }, /locked/], [null, /mapping/]] as const) {
    const r = checkPolicy(value);
    assert.equal(r.ok, false, JSON.stringify(value));
    assert.match(r.ok ? "" : r.message, message);
  }
});
