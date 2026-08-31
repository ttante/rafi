import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { buildAgentsCommand, missingAgentFlags, resolveAgentSettings, saveAgentDefaults, waitForLiveSettingsAcknowledgments } from "../src/agents.js";
import { detectProjectLifecycle, lifecycleCommandError } from "../src/lifecycle.js";
import { buildProjectConfig, defaultAnswers, normalizeProjectAgentDefaults } from "../src/project.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";
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

test("legacy Builder and QA context settings normalize independently without changing the input", () => {
  const legacy = { version: 1 as const, revision: 4, roles: { builder: { auto_compact_threshold_percent: 35 }, qa: { compact_maximum: 3 } } };
  const normalized = normalizeProjectAgentDefaults(legacy);
  assert.deepEqual(legacy, { version: 1, revision: 4, roles: { builder: { auto_compact_threshold_percent: 35 }, qa: { compact_maximum: 3 } } });
  assert.equal(normalized.roles.builder?.auto_compact_threshold_percent, 35);
  assert.equal(normalized.roles.builder?.compact_maximum, 10);
  assert.equal(normalized.roles.qa?.auto_compact_threshold_percent, 50);
  assert.equal(normalized.roles.qa?.compact_maximum, 3);
});

test("rafi agents accepts independent QA context controls and rejects them for non-work roles or ambiguous all", async () => {
  const dir = temp();
  try {
    writeFileSync(join(dir, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())));
    await buildAgentsCommand().parseAsync([
      "node", "agents", dir, "--agent-type", "qa", "--auto-compact-threshold", "27", "--compact-maximum", "4",
    ]);
    const saved = readFileSync(join(dir, "rafi-config.yaml"), "utf8");
    assert.match(saved, /qa:[\s\S]*auto_compact_threshold_percent: 27[\s\S]*compact_maximum: 4/);
    const revisionDb = new WorkflowDb(dir);
    const targets = revisionDb.projectSettingsRevisionTargets(1);
    revisionDb.close();
    assert.deepEqual(targets.qa, ["auto_compact_threshold_percent", "compact_maximum"]);
    assert.equal(targets.builder, undefined);
    await assert.rejects(() => buildAgentsCommand().parseAsync([
      "node", "agents", dir, "--agent-type", "planner", "--auto-compact-threshold", "20",
    ]), /require --agent-type builder or --agent-type qa/);
    await assert.rejects(() => buildAgentsCommand().parseAsync([
      "node", "agents", dir, "--agent-type", "all", "--compact-maximum", "2",
    ]), /require --agent-type builder or --agent-type qa/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("live settings acknowledgment waits only for roles with active managed adapters", async () => {
  const dir = temp();
  try {
    const db = new WorkflowDb(dir);
    const run = db.createRun({ kind: "build", runId: "run-1" });
    db.markRoleAdapterActive({ runId: run.runId, role: "builder", providerSessionId: "builder-1", sessionKey: "builder-key", settingsRevision: 1, observedAt: new Date().toISOString() });
    db.acknowledgeSettings({ runId: run.runId, role: "builder", providerSessionId: "builder-1", sessionKey: "builder-key", revision: 2, acknowledgedAt: new Date().toISOString() });
    db.close();
    const report = await waitForLiveSettingsAcknowledgments(dir, 2, ["builder", "qa"], { waitMs: 20, pollMs: 5 });
    assert.deepEqual(report.map((row) => [row.role, row.acknowledged]), [["builder", true]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("live settings acknowledgment tracks concurrent scoped Builder adapters independently", async () => {
  const dir = temp();
  try {
    const db = new WorkflowDb(dir);
    const run = db.createRun({ kind: "build", runId: "run-1" });
    const observedAt = new Date().toISOString();
    db.markRoleAdapterActive({ runId: run.runId, role: "builder", providerSessionId: "builder-1", sessionKey: "builder-key-1", settingsRevision: 1, observedAt });
    db.markRoleAdapterActive({ runId: run.runId, role: "builder", providerSessionId: "builder-2", sessionKey: "builder-key-2", settingsRevision: 1, observedAt });
    db.acknowledgeSettings({ runId: run.runId, role: "builder", providerSessionId: "builder-1", sessionKey: "builder-key-1", revision: 2, acknowledgedAt: observedAt });
    db.close();
    const partial = await waitForLiveSettingsAcknowledgments(dir, 2, ["builder"], { waitMs: 20, pollMs: 5 });
    assert.deepEqual(partial.map((row) => [row.providerSessionId, row.acknowledged]), [
      ["builder-1", true],
      ["builder-2", false],
    ]);
    const acknowledgeSecond = new WorkflowDb(dir);
    acknowledgeSecond.acknowledgeSettings({ runId: run.runId, role: "builder", providerSessionId: "builder-2", sessionKey: "builder-key-2", revision: 2, acknowledgedAt: new Date().toISOString() });
    acknowledgeSecond.close();
    const complete = await waitForLiveSettingsAcknowledgments(dir, 2, ["builder"], { waitMs: 20, pollMs: 5 });
    assert.deepEqual(complete.map((row) => [row.providerSessionId, row.acknowledged]), [
      ["builder-1", true],
      ["builder-2", true],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
