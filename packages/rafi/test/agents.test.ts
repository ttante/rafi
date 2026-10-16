import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "yaml";
import { promptAgentSettings, waitForLiveSettingsAcknowledgments, type AgentSettingsPrompts } from "../src/agents.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";

function projectDir(): string {
  const root = mkdtempSync(join(tmpdir(), "rafi-agents-test-"));
  writeFileSync(join(root, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())), "utf8");
  return root;
}

test("settings do not wait for a dead attempt or a role that has never started", async () => {
  const root = projectDir();
  const db = new WorkflowDb(root);
  db.ensureRun("dead-attempt", "build"); db.close();
  const started = performance.now();
  const rows = await waitForLiveSettingsAcknowledgments(root, 1, ["builder", "qa"], { waitMs: 5000 });
  assert.ok(performance.now() - started < 1000, "Inactive roles caused a wait");
  assert.deepEqual(rows.map(row => row.adoption), ["deferred", "deferred"]);
});

test("settings wait only for the submitted live role and observe its acknowledgement", async () => {
  const root = projectDir();
  const db = new WorkflowDb(root);
  const authority = db.acquireBuildAdmission("live", "worker");
  try {
    db.planOperation({ runId: "live", idempotencyKey: "builder-turn", kind: "provider-dispatch", intent: { role: "builder" } });
    db.updateOperation("builder-turn", "in_progress");
    const timer = setTimeout(() => db.acknowledgeSettings({ runId: "live", role: "builder", revision: 2, acknowledgedAt: new Date().toISOString() }), 30);
    try {
      const rows = await waitForLiveSettingsAcknowledgments(root, 2, ["builder", "qa"], { waitMs: 1000, pollMs: 10 });
      assert.equal(rows.find(row => row.role === "builder")?.acknowledged, true);
      assert.equal(rows.find(row => row.role === "qa")?.adoption, "deferred");
    } finally { clearTimeout(timer); }
  } finally { db.releaseBuildAdmission(authority); db.close(); }
});

test("settings stop waiting when the owner releases admission", async () => {
  const root = projectDir();
  const db = new WorkflowDb(root);
  const authority = db.acquireBuildAdmission("exit", "worker");
  db.planOperation({ runId: "exit", idempotencyKey: "turn", kind: "provider-dispatch", intent: { role: "builder" } }); db.updateOperation("turn", "in_progress");
  let released = false;
  const timer = setTimeout(() => { db.releaseBuildAdmission(authority); released = true; }, 30);
  try {
    const rows = await waitForLiveSettingsAcknowledgments(root, 2, ["builder"], { waitMs: 5000, pollMs: 10 });
    assert.equal(rows[0]?.adoption, "deferred");
    assert.equal(rows[0]?.acknowledged, false);
  } finally { clearTimeout(timer); if (!released) db.releaseBuildAdmission(authority); db.close(); }
});

function scriptedPrompts(roles: string[], textAnswers: string[], confirmAnswers: boolean[], summaries: string[]): AgentSettingsPrompts {
  const selects = ["claude", "default", "default", "compact"];
  return {
    multiselect: async () => roles,
    select: async () => selects.shift(),
    confirm: async () => confirmAnswers.shift(),
    text: async () => textAnswers.shift(),
    isCancel: () => false,
    log: { info: (message) => summaries.push(message) },
  };
}

test("interactive agents wizard collects and summarizes independent Builder and QA compaction settings", async () => {
  const summaries: string[] = [];
  const result = await promptAgentSettings(
    projectDir(),
    scriptedPrompts(["builder", "qa"], ["61", "3", "72", "4"], [false, true], summaries),
  );

  assert.deepEqual(result.selected, ["builder", "qa"]);
  assert.deepEqual(result.roleSettings, {
    builder: { auto_compact_threshold_percent: 61, compact_maximum: 3 },
    qa: { auto_compact_threshold_percent: 72, compact_maximum: 4 },
  });
  assert.equal(summaries.length, 1);
  assert.match(summaries[0]!, /Builder: compact at 61%, maximum 3/);
  assert.match(summaries[0]!, /QA: compact at 72%, maximum 4/);
});

test("interactive agents wizard does not ask for compaction settings when Builder and QA are not selected", async () => {
  const summaries: string[] = [];
  let textCalls = 0;
  const prompts = scriptedPrompts(["planner"], [], [false, true], summaries);
  prompts.text = async () => {
    textCalls += 1;
    return "unexpected";
  };

  const result = await promptAgentSettings(projectDir(), prompts);

  assert.deepEqual(result.selected, ["planner"]);
  assert.deepEqual(result.roleSettings, {});
  assert.equal(textCalls, 0);
  assert.deepEqual(summaries, []);
});

test("Builder and QA interviews recommend 65 percent by default", async () => {
  const defaults: string[] = [];
  const prompts = scriptedPrompts(["builder", "qa"], [], [false, true], []);
  prompts.text = async rawOptions => {
    const options = rawOptions as { message: string; defaultValue: string };
    if (options.message.includes("threshold")) defaults.push(options.defaultValue);
    return options.defaultValue;
  };
  const result = await promptAgentSettings(projectDir(), prompts);
  assert.deepEqual(defaults, ["65", "65"]);
  assert.equal(result.roleSettings?.builder?.auto_compact_threshold_percent, 65);
  assert.equal(result.roleSettings?.qa?.auto_compact_threshold_percent, 65);
});
