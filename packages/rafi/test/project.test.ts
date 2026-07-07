/**
 * Phase 6 — answer-mapping. Pins that `buildProjectConfig` correctly maps
 * walkthrough answers to ProjectConfig, including sentinel values for flags.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProjectConfig, defaultAnswers, normalizeProjectConfig, NO_UI, LOCAL_ONLY } from "../src/project.js";
import { validateProjectConfig } from "rafi-spec";
import { loadDefaults } from "special-agents";

test("--defaults produces a config that validates against ProjectConfig schema", () => {
  const config = buildProjectConfig(defaultAnswers());
  assert.ok(validateProjectConfig(config).valid, "default config failed schema validation");
});

test("--defaults stack matches defaults.yaml verbatim", () => {
  const defaults = loadDefaults();
  const config = buildProjectConfig(defaultAnswers());
  assert.equal(config.stack.frontend, defaults.stack.frontend);
  assert.equal(config.stack.backend, defaults.stack.backend);
  assert.equal(config.stack.database, defaults.stack.database);
  assert.equal(config.stack.cloud, defaults.stack.cloud);
  assert.equal(config.stack.packageManager, defaults.stack.packageManager);
});

test("--defaults flags match defaults.yaml", () => {
  const defaults = loadDefaults();
  const config = buildProjectConfig(defaultAnswers());
  assert.equal(config.flags.hasFrontend, defaults.flags.hasFrontend);
  assert.equal(config.flags.usesAI, defaults.flags.usesAI);
  assert.equal(config.flags.runsInCloud, defaults.flags.runsInCloud);
});

test(`frontend="${NO_UI}" sets hasFrontend:false and clears stack.frontend`, () => {
  const config = buildProjectConfig({ ...defaultAnswers(), frontend: NO_UI });
  assert.equal(config.flags.hasFrontend, false);
  assert.equal(config.stack.frontend, "");
});

test(`cloud="${LOCAL_ONLY}" sets runsInCloud:false and clears stack.cloud`, () => {
  const config = buildProjectConfig({ ...defaultAnswers(), cloud: LOCAL_ONLY });
  assert.equal(config.flags.runsInCloud, false);
  assert.equal(config.stack.cloud, "");
});

test("usesAI:true sets the flag", () => {
  const config = buildProjectConfig({ ...defaultAnswers(), usesAI: true });
  assert.equal(config.flags.usesAI, true);
});

test("custom stack strings pass through unchanged", () => {
  const answers = {
    ...defaultAnswers(),
    frontend: "Vue 3",
    backend: "Django",
    database: "MySQL",
    cloud: "GCP",
    packageManager: "npm",
  };
  const config = buildProjectConfig(answers);
  assert.equal(config.stack.frontend, "Vue 3");
  assert.equal(config.stack.backend, "Django");
  assert.equal(config.stack.database, "MySQL");
  assert.equal(config.stack.cloud, "GCP");
  assert.equal(config.stack.packageManager, "npm");
});

test("appName and timezone pass through", () => {
  const config = buildProjectConfig({ ...defaultAnswers(), appName: "Acme", timezone: "America/New_York" });
  assert.equal(config.appName, "Acme");
  assert.equal(config.timezone, "America/New_York");
});

test("useClaude:false sets harness.targets to codex only", () => {
  const config = buildProjectConfig({ ...defaultAnswers(), useClaude: false });
  assert.deepEqual(config.harness.targets, ["codex"]);
});

test("--defaults keeps useClaude:true and harness.targets includes claude", () => {
  const config = buildProjectConfig(defaultAnswers());
  assert.deepEqual(config.harness.targets, ["claude", "codex"]);
});

test("--defaults includes root agent files and native agent/skill paths", () => {
  const config = buildProjectConfig(defaultAnswers());
  assert.deepEqual(config.agent_files, {
    mode: "overwrite",
    codex: "./AGENTS.md",
    claude: "./CLAUDE.md",
  });
  assert.equal(config.agents.builder.artifact_source, "rafi");
  assert.equal(config.agents.builder.claude, "./.claude/agents/builder.md");
  assert.equal(config.agents.builder.codex, "./.codex/agents/builder.toml");
  assert.equal(config.skills.tdd.artifact_source, "rafi");
  assert.equal(config.skills.tdd.claude, "./.claude/skills/tdd/SKILL.md");
  assert.equal(config.skills.tdd.codex, "./.agents/skills/tdd/SKILL.md");
});

test("normalizeProjectConfig adds new fields to legacy project config", () => {
  const { agent_files, agents, skills, ...legacy } = buildProjectConfig(defaultAnswers());
  void agent_files;
  void agents;
  void skills;
  const normalized = normalizeProjectConfig(legacy);
  assert.equal(normalized.agent_files.codex, "./AGENTS.md");
  assert.equal(normalized.agents.qa.artifact_source, "rafi");
  assert.equal(normalized.agents.qa.claude, "./.claude/agents/qa.md");
  assert.equal(normalized.skills["grill-me"].artifact_source, "rafi");
  assert.equal(normalized.skills["grill-me"].codex, "./.agents/skills/grill-me/SKILL.md");
});

test("normalizeProjectConfig adds artifact_source to legacy artifact entries", () => {
  const legacy = buildProjectConfig(defaultAnswers());
  const { artifact_source, ...legacySkill } = legacy.skills.tdd;
  void artifact_source;
  const normalized = normalizeProjectConfig({
    ...legacy,
    skills: { tdd: legacySkill },
  });
  assert.equal(normalized.skills.tdd.artifact_source, "rafi");
});

test("normalizeProjectConfig preserves custom existing artifact paths", () => {
  const config = buildProjectConfig(defaultAnswers());
  const normalized = normalizeProjectConfig({
    ...config,
    agents: {
      builder: {
        artifact_source: "existing",
        claude: "./.claude/agents/custom-builder.md",
        codex: "./.codex/agents/custom-builder.toml",
      },
    },
    skills: {
      tdd: {
        artifact_source: "existing",
        claude: "./.claude/skills/custom-tdd/SKILL.md",
        codex: "./.agents/skills/custom-tdd/SKILL.md",
      },
    },
  });

  assert.deepEqual(normalized.agents.builder, {
    artifact_source: "existing",
    claude: "./.claude/agents/custom-builder.md",
    codex: "./.codex/agents/custom-builder.toml",
  });
  assert.deepEqual(normalized.skills.tdd, {
    artifact_source: "existing",
    claude: "./.claude/skills/custom-tdd/SKILL.md",
    codex: "./.agents/skills/custom-tdd/SKILL.md",
  });
});
