import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "yaml";
import { promptAgentSettings, type AgentSettingsPrompts } from "../src/agents.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";

function projectDir(): string {
  const root = mkdtempSync(join(tmpdir(), "rafi-agents-test-"));
  writeFileSync(join(root, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())), "utf8");
  return root;
}

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
