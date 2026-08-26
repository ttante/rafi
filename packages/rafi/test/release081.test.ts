import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { missingAgentFlags, resolveAgentSettings, saveAgentDefaults } from "../src/agents.js";
import { detectProjectLifecycle, lifecycleCommandError } from "../src/lifecycle.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";
import { buildUninstallPlan } from "../src/uninstall.js";
import { finalizeOwnedWrite, capturePreimage, readInstallManifest, validateOwnedPath } from "../src/ownership.js";

function temp(): string { return mkdtempSync(join(tmpdir(), "rafi-081-")); }

test("lifecycle distinguishes uninitialized, initializing, initialized, and missing-state risk", () => {
  const dir = temp();
  try {
    assert.equal(detectProjectLifecycle(dir).state, "uninitialized");
    writeFileSync(join(dir, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())));
    assert.equal(detectProjectLifecycle(dir).state, "initializing");
    assert.equal(lifecycleCommandError("agents", detectProjectLifecycle(dir)), undefined);
    mkdirSync(join(dir, ".tickets"));
    writeFileSync(join(dir, ".tickets/config.yaml"), "app_name: Test\n");
    writeFileSync(join(dir, ".tickets/tickets.yaml"), "tickets: []\n");
    writeFileSync(join(dir, ".tickets/ticket-state.sqlite"), Buffer.from("SQLite format 3\0"));
    assert.equal(detectProjectLifecycle(dir).state, "initialized");
    rmSync(join(dir, ".tickets/ticket-state.sqlite"));
    assert.equal(detectProjectLifecycle(dir).state, "partial");
    assert.equal(lifecycleCommandError("agents", detectProjectLifecycle(dir)), undefined);
    writeFileSync(join(dir, ".tickets/tickets.yaml"), "tickets:\n  - id: T001\n");
    assert.equal(detectProjectLifecycle(dir).state, "corrupt");
    assert.match(lifecycleCommandError("tickets-plan", detectProjectLifecycle(dir)) ?? "", /repair|validate|corrupt/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agent defaults can be saved while initialization is pending", () => {
  const dir = temp();
  try {
    const config = buildProjectConfig(defaultAnswers());
    writeFileSync(join(dir, "rafi-config.yaml"), stringify(config));
    const next = saveAgentDefaults(dir, config, {
      version: 1,
      revision: 1,
      roles: { planner: { make: "codex", session_strategy: "fresh" } },
    });
    const saved = readFileSync(join(dir, "rafi-config.yaml"), "utf8");
    assert.equal(next.agent_defaults?.roles.planner?.make, "codex");
    assert.match(saved, /make: codex/);
    assert.equal(detectProjectLifecycle(dir).state, "initializing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agent settings enforce complete flags and documented precedence", () => {
  assert.deepEqual(missingAgentFlags({ agentType: "all", agentMake: "codex" }), ["--model", "--reasoning"]);
  const project = { version: 1 as const, roles: { planner: { make: "claude" as const, model: "opus", reasoning: "high", fast: false } } };
  assert.equal(resolveAgentSettings({ role: "planner", project }).source, "project");
  assert.equal(resolveAgentSettings({ role: "planner", project, resumed: { make: "codex", model: "gpt", reasoning: "xhigh", fast: true } }).source, "resume");
  assert.equal(resolveAgentSettings({ role: "planner", project, cli: { make: "claude", model: "sonnet", reasoning: "medium", fast: false } }).source, "cli");
});

test("ownership rejects traversal and uninstall preserves modified files by default", () => {
  const dir = temp();
  try {
    assert.throws(() => validateOwnedPath(dir, "../outside"), /escapes/);
    const entry = capturePreimage(dir, "generated.txt", "test");
    writeFileSync(join(dir, "generated.txt"), "generated\n");
    finalizeOwnedWrite(dir, entry);
    writeFileSync(join(dir, "generated.txt"), "user edit\n");
    const manifest = readInstallManifest(dir);
    assert.equal(manifest?.files[0]?.mode, "created");
    const plan = buildUninstallPlan(dir, [{ category: "core", remove: true }]);
    assert.ok(plan.preserve.includes("generated.txt"));
    assert.doesNotMatch(readFileSync(join(dir, "generated.txt"), "utf8"), /generated\n$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
