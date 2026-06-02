import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateRulePack,
  validateSkillManifest,
  validateAgentManifest,
  validateProjectConfig,
} from "../src/validate.js";
import type {
  RulePackFrontmatter,
  SkillManifest,
  AgentManifest,
  ProjectConfig,
} from "../src/types.js";

// ───────────────────────────── valid fixtures ─────────────────────────────

const validRulePack: RulePackFrontmatter = {
  name: "security",
  category: "domain",
  description: "Security, privacy, and compliance rules.",
  condition: "always",
  template: false,
};

const validSkill: SkillManifest = {
  name: "tdd",
  description: "Test-driven development with red-green-refactor.",
  pins: ["code-quality", "testing"],
  codexPriority: "inline",
};

const validAgent: AgentManifest = {
  name: "builder",
  description: "Implements one ticket or step per turn.",
  role: "builder",
  packs: ["base/*", "process/testing", "templated/*"],
  skills: ["tdd", "improve-codebase-architecture"],
  conditionalPacks: { ai: ["domain/ai-safety"], frontend: ["domain/accessibility"] },
  model: null,
  effort: null,
};

const validProject: ProjectConfig = {
  appName: "My App",
  timezone: "UTC",
  stack: {
    frontend: "React with TypeScript",
    backend: "Node.js",
    database: "PostgreSQL",
    cloud: "AWS",
    packageManager: "pnpm",
  },
  flags: { hasFrontend: true, usesAI: false, runsInCloud: true },
  harness: { targets: ["claude", "codex"], qa: true },
};

test("valid fixtures pass", () => {
  assert.deepEqual(validateRulePack(validRulePack), { valid: true, errors: [] });
  assert.deepEqual(validateSkillManifest(validSkill), { valid: true, errors: [] });
  assert.deepEqual(validateAgentManifest(validAgent), { valid: true, errors: [] });
  assert.deepEqual(validateProjectConfig(validProject), { valid: true, errors: [] });
});

// ───────────────────────────── invalid fixtures ─────────────────────────────

test("rule pack: bad condition enum is rejected", () => {
  const r = validateRulePack({ ...validRulePack, condition: "sometimes" });
  assert.equal(r.valid, false);
  assert.ok(r.errors.length > 0);
});

test("rule pack: missing required field is rejected", () => {
  const { template, ...missing } = validRulePack;
  void template;
  assert.equal(validateRulePack(missing).valid, false);
});

test("rule pack: unknown property is rejected", () => {
  assert.equal(validateRulePack({ ...validRulePack, extra: 1 }).valid, false);
});

test("rule pack: non-kebab name is rejected", () => {
  assert.equal(validateRulePack({ ...validRulePack, name: "Security_Rules" }).valid, false);
});

test("skill: missing description is rejected", () => {
  const { description, ...missing } = validSkill;
  void description;
  assert.equal(validateSkillManifest(missing).valid, false);
});

test("skill: bad codexPriority is rejected", () => {
  assert.equal(
    validateSkillManifest({ ...validSkill, codexPriority: "maybe" }).valid,
    false,
  );
});

test("agent: bad role is rejected", () => {
  assert.equal(validateAgentManifest({ ...validAgent, role: "reviewer" }).valid, false);
});

test("agent: bad effort is rejected", () => {
  assert.equal(validateAgentManifest({ ...validAgent, effort: "ultra" }).valid, false);
});

test("agent: unknown conditionalPacks key is rejected", () => {
  assert.equal(
    validateAgentManifest({
      ...validAgent,
      conditionalPacks: { mobile: ["x"] },
    }).valid,
    false,
  );
});

test("project: empty targets is rejected", () => {
  const r = validateProjectConfig({
    ...validProject,
    harness: { targets: [], qa: true },
  });
  assert.equal(r.valid, false);
});

test("project: non-boolean flag is rejected", () => {
  assert.equal(
    validateProjectConfig({
      ...validProject,
      flags: { hasFrontend: "yes", usesAI: false, runsInCloud: true },
    }).valid,
    false,
  );
});

test("project: unknown stack key is rejected", () => {
  assert.equal(
    validateProjectConfig({
      ...validProject,
      stack: { ...validProject.stack, mobile: "React Native" },
    }).valid,
    false,
  );
});
