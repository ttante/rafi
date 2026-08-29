import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateRulePack,
  validateSkillManifest,
  validateAgentManifest,
  validateProjectConfig,
  assertRulePack,
  assertSkillManifest,
  assertAgentManifest,
  assertProjectConfig,
  validateBuildRunRecord,
  validateInstallManifest,
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
  agent_files: { mode: "overwrite", codex: "./AGENTS.md", claude: "./CLAUDE.md" },
  agents: {
    builder: { artifact_source: "rafi", claude: "./.claude/agents/builder.md", codex: "./.codex/agents/builder.toml" },
  },
  skills: {
    tdd: { artifact_source: "rafi", claude: "./.claude/skills/tdd/SKILL.md", codex: "./.agents/skills/tdd/SKILL.md" },
  },
};

test("valid fixtures pass", () => {
  assert.deepEqual(validateRulePack(validRulePack), { valid: true, errors: [] });
  assert.deepEqual(validateSkillManifest(validSkill), { valid: true, errors: [] });
  assert.deepEqual(validateAgentManifest(validAgent), { valid: true, errors: [] });
  assert.deepEqual(validateProjectConfig(validProject), { valid: true, errors: [] });
});

test("build-run schemas accept V1 and V2 recovery records and reject incomplete V2 snapshots", () => {
  const common = { runId: "run-1", status: "recoverable", tickets: ["T001"], branchMode: "current", checkpoint: "builder", receipts: {}, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" };
  assert.equal(validateBuildRunRecord({ version: 1, ...common, repository: { root: "/repo", worktree: "/repo", partialFingerprint: "legacy" } }).valid, true);
  const v2 = { version: 2, ...common, repository: { root: "/repo", worktree: "/repo", baselineComplete: true, git: { worktree: "/repo", statusPaths: [], initialStatusPaths: [], runOwnedPaths: [], createdBranch: false, createdWorktree: false } }, progress: { completedTickets: [], completedOperations: [], remainingTickets: ["T001"] } };
  assert.equal(validateBuildRunRecord(v2).valid, true);
  assert.equal(validateBuildRunRecord({
    ...v2,
    sessionBindings: [{
      version: 1,
      provider: "codex",
      sessionId: "thread-1",
      role: "builder",
      stream: "builder",
      generation: 0,
      cwd: "/repo",
      configRoot: "/repo",
      workspaceIdentity: "worktree-1",
      ticketId: "T001",
      source: "observed",
      createdAt: "2026-01-01T00:00:00Z",
      validatedAt: "2026-01-01T00:00:01Z",
    }],
  }).valid, true);
  assert.equal(validateBuildRunRecord({ ...v2, repository: { root: "/repo", worktree: "/repo", baselineComplete: true, git: {} } }).valid, false);
  assert.equal(validateBuildRunRecord({ ...v2, sessionBindings: [{ version: 1, provider: "codex", sessionId: "thread-1" }] }).valid, false);
});

test("install-manifest schemas accept legacy V1 and categorized V2 ownership", () => {
  const entry = { path: "README.md", sha256: null, mode: "modified", origin: "docs" };
  const common = { createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z", dependencies: [] };
  assert.equal(validateInstallManifest({ version: 1, ...common, files: [entry] }).valid, true);
  const v2 = { version: 2, ...common, repository: { rootIdentity: "root", dirtyChoice: "snapshot-and-continue", baselineComplete: true }, files: [{ ...entry, category: "documentation-modified" }] };
  assert.equal(validateInstallManifest(v2).valid, true);
  assert.equal(validateInstallManifest({ ...v2, files: [entry] }).valid, false);
});

test("project tickets build accepts current branch strategy", () => {
  const project: ProjectConfig = {
    ...validProject,
    tickets: {
      build: {
        branch_strategy: "current",
        completion: "none",
      },
    },
  };
  assert.deepEqual(validateProjectConfig(project), { valid: true, errors: [] });
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

test("project: agent file mode is validated", () => {
  assert.equal(
    validateProjectConfig({
      ...validProject,
      agent_files: { ...validProject.agent_files, mode: "merge" },
    }).valid,
    false,
  );
});

test("project: agents and skills require claude and codex paths", () => {
  assert.equal(
    validateProjectConfig({
      ...validProject,
      skills: { tdd: { claude: "./.claude/skills/tdd/SKILL.md" } },
    }).valid,
    false,
  );
});

test("project: artifact_source must be rafi or existing", () => {
  assert.equal(
    validateProjectConfig({
      ...validProject,
      agents: {
        builder: { ...validProject.agents.builder, artifact_source: "custom" },
      },
    }).valid,
    false,
  );
});

test("project: optional docs root is accepted", () => {
  assert.equal(
    validateProjectConfig({
      ...validProject,
      docs: { root: "docs-rafi" },
    }).valid,
    true,
  );
});

test("project: optional tickets setup is accepted", () => {
  assert.equal(
    validateProjectConfig({
      ...validProject,
      tickets: {
        sources: [
          { type: "local", paths: ["docs/rafi-plan.md"] },
          { type: "linear", api_key_env: "LINEAR_API_KEY", team_key: "ENG", filter: null },
          {
            type: "jira",
            site: "https://example.atlassian.net",
            email_env: "JIRA_EMAIL",
            token_env: "JIRA_API_TOKEN",
            jql: "project = ENG",
          },
        ],
        populate: {
          source_handling: "saved",
          agent_preference: "configured",
          import_cap: 500,
          comment_limit: 10,
          enrichment: "recommendations",
          recommend_split_for_xl: true,
        },
        build: {
          branch_strategy: "branch-per-ticket",
          completion: "auto-merge",
          provider: "github",
          pr_ready: true,
          merge_method: "squash",
          cleanup: true,
          auto_merge_wait: false,
          auto_merge_timeout_minutes: null,
        },
      },
    }).valid,
    true,
  );
});

test("project: shared source registry accepts immutable version metadata and rejects bad storage", () => {
  const sourceConfig = {
    ...validProject,
    sources: {
      version: 1,
      snapshot_storage: "local",
      pending: [{ description: "some files in docs", created_at: "2026-08-24T00:00:00.000Z" }],
      entries: [{
        id: "src_0123456789abcdef", type: "local", label: "requirements", active: true,
        locator: { path: "docs/requirements.md" },
        versions: [{ fingerprint: "a".repeat(64), captured_at: "2026-08-24T00:00:00.000Z", storage: "local", snapshot_path: ".rafi/source-cache/src_0123456789abcdef/a.md", manifest_path: ".rafi/source-cache/src_0123456789abcdef/a.manifest.json", bytes: 10 }],
      }],
    },
  };
  assert.equal(validateProjectConfig(sourceConfig).valid, true);
  assert.equal(validateProjectConfig({ ...sourceConfig, sources: { ...sourceConfig.sources, snapshot_storage: "cloud" } }).valid, false);
});

// ───────────────────────── assert* (throwing narrowers) ─────────────────────────
// These are part of the public surface: foreman/special-agents call them to fail
// fast on bad authoring inputs. They must pass through valid data and throw with a
// message naming the offending field on invalid data.

test("assert*: pass through valid fixtures without throwing", () => {
  assert.doesNotThrow(() => assertRulePack(validRulePack));
  assert.doesNotThrow(() => assertSkillManifest(validSkill));
  assert.doesNotThrow(() => assertAgentManifest(validAgent));
  assert.doesNotThrow(() => assertProjectConfig(validProject));
});

test("assertRulePack: throws with errors joined into the message", () => {
  assert.throws(
    () => assertRulePack({ ...validRulePack, condition: "sometimes" }),
    /Invalid rule pack:/,
  );
});

test("assertSkillManifest: throws on missing description", () => {
  const { description, ...missing } = validSkill;
  void description;
  assert.throws(() => assertSkillManifest(missing), /Invalid skill manifest:/);
});

test("assertAgentManifest: throws on bad role", () => {
  assert.throws(
    () => assertAgentManifest({ ...validAgent, role: "reviewer" }),
    /Invalid agent manifest:/,
  );
});

test("assertProjectConfig: throws on empty targets", () => {
  assert.throws(
    () => assertProjectConfig({ ...validProject, harness: { targets: [], qa: true } }),
    /Invalid project config:/,
  );
});

// ───────────────────────── optional fields round-trip ─────────────────────────

test("rule pack: supersededByForeman is accepted", () => {
  assert.equal(validateRulePack({ ...validRulePack, supersededByForeman: true }).valid, true);
});

test("skill: pins and codexPriority are optional", () => {
  const { pins, codexPriority, ...bare } = validSkill;
  void pins;
  void codexPriority;
  assert.equal(validateSkillManifest(bare).valid, true);
});

test("agent: conditionalPacks and model/effort are optional", () => {
  const bare: AgentManifest = {
    name: "qa",
    description: "Reviews one step per turn.",
    role: "qa",
    packs: ["base/*"],
    skills: [],
  };
  assert.equal(validateAgentManifest(bare).valid, true);
});

test("agent: null model and null effort are accepted", () => {
  assert.equal(validateAgentManifest({ ...validAgent, model: null, effort: null }).valid, true);
});
