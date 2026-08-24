/**
 * Phase 6 — answer-mapping. Pins that `buildProjectConfig` correctly maps
 * walkthrough answers to ProjectConfig, including sentinel values for flags.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectConfig,
  defaultAnswers,
  normalizeProjectConfig,
  NO_UI,
  LOCAL_ONLY,
  runtimeSelectionToTargets,
  findNearestRafiProject,
  resolveExplicitRafiProject,
} from "../src/project.js";
import { validateProjectConfig } from "rafi-spec";
import { loadDefaults } from "special-agents";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("--defaults produces a config that validates against ProjectConfig schema", () => {
  const config = buildProjectConfig(defaultAnswers());
  assert.ok(validateProjectConfig(config).valid, "default config failed schema validation");
  assert.deepEqual(config.agent_defaults?.roles, {
    builder: { session_strategy: "compact" },
    qa: { session_strategy: "compact" },
    "ticket-maker": { session_strategy: "compact" },
    planner: { session_strategy: "fresh" },
    uninstaller: { session_strategy: "fresh" },
  });
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

test("runtimeTargets can select both, Claude only, or Codex only", () => {
  assert.deepEqual(
    buildProjectConfig({ ...defaultAnswers(), runtimeTargets: runtimeSelectionToTargets("both") }).harness.targets,
    ["claude", "codex"],
  );
  assert.deepEqual(
    buildProjectConfig({ ...defaultAnswers(), runtimeTargets: runtimeSelectionToTargets("claude") }).harness.targets,
    ["claude"],
  );
  assert.deepEqual(
    buildProjectConfig({ ...defaultAnswers(), runtimeTargets: runtimeSelectionToTargets("codex") }).harness.targets,
    ["codex"],
  );
});

test("--defaults keeps useClaude:true and harness.targets includes claude", () => {
  const config = buildProjectConfig(defaultAnswers());
  assert.deepEqual(config.harness.targets, ["claude", "codex"]);
});

test("--defaults includes root agent files and native agent/skill paths", () => {
  const config = buildProjectConfig(defaultAnswers());
  assert.deepEqual(config.docs, { root: "docs" });
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
  assert.equal(normalized.docs?.root, "docs");
  assert.equal(normalized.agent_files.codex, "./AGENTS.md");
  assert.equal(normalized.agents.qa.artifact_source, "rafi");
  assert.equal(normalized.agents.qa.claude, "./.claude/agents/qa.md");
  assert.equal(normalized.skills["grill-me"].artifact_source, "rafi");
  assert.equal(normalized.skills["grill-me"].codex, "./.agents/skills/grill-me/SKILL.md");
});

test("buildProjectConfig preserves a custom docs root", () => {
  const config = buildProjectConfig({ ...defaultAnswers(), docsRoot: "docs-rafi" });
  assert.deepEqual(config.docs, { root: "docs-rafi" });
});

test("create preserves the complete source answer as pending registry input", () => {
  const config = buildProjectConfig({ ...defaultAnswers(), planningSources: "docs/brief.md, notes/** docs/brief.md" });
  assert.equal(config.planning, undefined);
  assert.equal(config.sources?.snapshot_storage, "local");
  assert.deepEqual(config.sources?.pending?.map((item) => item.description), ["docs/brief.md, notes/** docs/brief.md"]);
  const legacy = normalizeProjectConfig({ ...config, planning: { sources: "docs/brief.md" } });
  assert.deepEqual(legacy.planning, { sources: ["docs/brief.md"] });
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

test("project discovery finds nearest active config from nested directories", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-discovery-"));
  const nested = join(root, "packages", "web", "src");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, "rafi-config.yaml"), "appName: Discovery\n", "utf8");
  assert.deepEqual(findNearestRafiProject(nested), { root, configFile: "rafi-config.yaml", legacy: false });
});

test("explicit project resolution never searches ancestors and recognizes legacy config", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-explicit-"));
  const child = join(root, "child");
  mkdirSync(child);
  writeFileSync(join(root, "project.yaml"), "appName: Legacy\n", "utf8");
  assert.equal(resolveExplicitRafiProject(child), undefined);
  assert.deepEqual(resolveExplicitRafiProject(root), { root, configFile: "project.yaml", legacy: true });
});
