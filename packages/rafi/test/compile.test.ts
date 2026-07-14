/**
 * Phase 6 — end-to-end compile. Pins that `compile` writes AGENTS.md (with header
 * + byte-equivalent body), CLAUDE.md, compiled role bundles, and Claude agent files
 * for a target repo. Also verifies custom stack substitution and conditions header.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { compile, isRuntimeAuthFailure, RuntimeUpdateError } from "../src/compiler.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";
import { AGENT_ROLES } from "special-agents";

const HERE = dirname(fileURLToPath(import.meta.url));
// The same frozen snapshot the Phase 3 golden test uses.
const SNAPSHOT = readFileSync(
  join(HERE, "../../special-agents/test/fixtures/rules.snapshot.md"),
  "utf8",
);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-compile-test-"));
}

test("compile --defaults writes AGENTS.md whose body is byte-equivalent to the golden snapshot", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  compile(dir, config);

  const agentsMd = readFileSync(join(dir, "AGENTS.md"), "utf8");
  // Strip the first line (the conditions header) before comparing.
  const body = agentsMd.slice(agentsMd.indexOf("\n") + 1);
  assert.equal(body, SNAPSHOT, "AGENTS.md body diverged from golden snapshot");
});

test("AGENTS.md starts with the conditions header line", () => {
  const dir = tempDir();
  compile(dir, buildProjectConfig(defaultAnswers()));
  const first = readFileSync(join(dir, "AGENTS.md"), "utf8").split("\n")[0];
  assert.ok(first.startsWith("# rafi:"), `expected header, got: ${first}`);
  assert.ok(first.includes("ai="), "header missing ai flag");
  assert.ok(first.includes("frontend="), "header missing frontend flag");
  assert.ok(first.includes("cloud="), "header missing cloud flag");
  assert.ok(first.includes("docs=docs"), "header missing docs root");
});

test("conditions header reflects the actual flags (ai=on for default)", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers()); // usesAI:true by default
  compile(dir, config);
  const first = readFileSync(join(dir, "AGENTS.md"), "utf8").split("\n")[0];
  assert.ok(first.includes("ai=on"), `expected ai=on but got: ${first}`);
  assert.ok(first.includes("frontend=on"), `expected frontend=on but got: ${first}`);
});

test("custom stack values appear in AGENTS.md body", () => {
  const dir = tempDir();
  const config = buildProjectConfig({
    ...defaultAnswers(),
    database: "MongoDB",
    packageManager: "yarn",
  });
  compile(dir, config);
  const body = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(body.includes("MongoDB"), "custom database not in AGENTS.md");
  assert.ok(body.includes("yarn"), "custom packageManager not in AGENTS.md");
});

test("custom docs root appears in generated rules and starter docs", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  config.docs = { root: "docs-rafi" };
  compile(dir, config);

  const agentsMd = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(agentsMd.split("\n")[0]?.includes("docs=docs-rafi"));
  assert.ok(agentsMd.includes("`docs-rafi/architecture.md`"));
  assert.ok(!agentsMd.includes("`docs/architecture.md`"));
  assert.ok(existsSync(join(dir, "docs-rafi", "features.md")));
  assert.ok(readFileSync(join(dir, "docs-rafi", "features.md"), "utf8").includes("`docs-rafi/tickets.md`"));
});

test("compile validates docs root before writing generated files", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  config.docs = { root: "../docs-outside" };

  assert.throws(() => compile(dir, config), /docs root/);
  assert.ok(!existsSync(join(dir, "AGENTS.md")));
  assert.ok(!existsSync(join(dir, "CLAUDE.md")));
});

test("compile writes CLAUDE.md with header and @AGENTS.md import", () => {
  const dir = tempDir();
  compile(dir, buildProjectConfig(defaultAnswers()));
  assert.ok(existsSync(join(dir, "CLAUDE.md")));
  const content = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  assert.ok(content.startsWith("# rafi:"), "CLAUDE.md missing conditions header");
  assert.ok(content.includes("@AGENTS.md"), "CLAUDE.md missing @AGENTS.md import");
});

test("compile writes .rafi/compiled/<role>/system.md for all four roles", () => {
  const dir = tempDir();
  compile(dir, buildProjectConfig(defaultAnswers()));
  for (const role of AGENT_ROLES) {
    assert.ok(
      existsSync(join(dir, ".rafi", "compiled", role, "system.md")),
      `missing .rafi/compiled/${role}/system.md`,
    );
  }
});

test("compile writes .claude/agents/<role>.md for all four roles", () => {
  const dir = tempDir();
  compile(dir, buildProjectConfig(defaultAnswers()));
  for (const role of AGENT_ROLES) {
    assert.ok(
      existsSync(join(dir, ".claude", "agents", `${role}.md`)),
      `missing .claude/agents/${role}.md`,
    );
  }
});

test("compile writes Codex agents and project skills from rafi-config paths", () => {
  const dir = tempDir();
  compile(dir, buildProjectConfig(defaultAnswers()));
  for (const role of AGENT_ROLES) {
    assert.ok(
      existsSync(join(dir, ".codex", "agents", `${role}.toml`)),
      `missing .codex/agents/${role}.toml`,
    );
  }
  assert.ok(existsSync(join(dir, ".claude", "skills", "tdd", "SKILL.md")));
  assert.ok(existsSync(join(dir, ".agents", "skills", "tdd", "SKILL.md")));
});

test("compile with Claude-only target emits Claude artifacts and compiled bundles only", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), runtimeTargets: ["claude"] });
  compile(dir, config);

  assert.ok(!existsSync(join(dir, "AGENTS.md")), "Claude-only compile should not emit AGENTS.md");
  assert.ok(existsSync(join(dir, "CLAUDE.md")));
  assert.ok(existsSync(join(dir, ".claude", "agents", "builder.md")));
  assert.ok(existsSync(join(dir, ".claude", "skills", "tdd", "SKILL.md")));
  assert.ok(!existsSync(join(dir, ".codex", "agents", "builder.toml")));
  assert.ok(!existsSync(join(dir, ".agents", "skills", "tdd", "SKILL.md")));
  assert.ok(existsSync(join(dir, ".rafi", "compiled", "builder", "system.md")));
  const claudeMd = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  assert.doesNotMatch(claudeMd, /@AGENTS\.md/);
  assert.match(claudeMd, /# App-Level AI Agent Rules/);
});

test("compile with Codex-only target emits Codex artifacts and compiled bundles only", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), runtimeTargets: ["codex"] });
  compile(dir, config);

  assert.ok(existsSync(join(dir, "AGENTS.md")));
  assert.ok(!existsSync(join(dir, "CLAUDE.md")), "Codex-only compile should not emit CLAUDE.md");
  assert.ok(existsSync(join(dir, ".codex", "agents", "builder.toml")));
  assert.ok(existsSync(join(dir, ".agents", "skills", "tdd", "SKILL.md")));
  assert.ok(!existsSync(join(dir, ".claude", "agents", "builder.md")));
  assert.ok(!existsSync(join(dir, ".claude", "skills", "tdd", "SKILL.md")));
  assert.ok(existsSync(join(dir, ".rafi", "compiled", "builder", "system.md")));
});

test("compile preserves stale files for unselected targets", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), runtimeTargets: ["codex"] });
  const staleClaude = join(dir, ".claude", "agents", "builder.md");
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  writeFileSync(staleClaude, "STALE CLAUDE\n", "utf8");

  compile(dir, config);

  assert.equal(readFileSync(staleClaude, "utf8"), "STALE CLAUDE\n");
});

test("compiled role metadata uses configured skill names", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  config.skills.tdd = {
    artifact_source: "rafi",
    claude: "./.claude/skills/tdd-rafi/SKILL.md",
    codex: "./.agents/skills/tdd-rafi/SKILL.md",
  };
  compile(dir, config);
  const meta = JSON.parse(readFileSync(join(dir, ".rafi", "compiled", "qa", "meta.json"), "utf8"));
  assert.ok(meta.skills.includes("tdd-rafi"));
});

test("compile fails clearly when existing-owned artifact paths are missing", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  config.skills.tdd = {
    artifact_source: "existing",
    claude: "./.claude/skills/tdd/SKILL.md",
    codex: "./.agents/skills/tdd/SKILL.md",
  };
  assert.throws(
    () => compile(dir, config),
    /Configured existing Rafi artifact path\(s\) are missing/,
  );
});

test("compile validates existing-owned artifact paths only for selected targets", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), runtimeTargets: ["codex"] });
  config.skills.tdd = {
    artifact_source: "existing",
    claude: "./.claude/skills/tdd/SKILL.md",
    codex: "./.agents/skills/tdd/SKILL.md",
  };
  const codexPath = join(dir, ".agents", "skills", "tdd", "SKILL.md");
  mkdirSync(join(dir, ".agents", "skills", "tdd"), { recursive: true });
  writeFileSync(codexPath, "---\nname: tdd\ndescription: custom\n---\ncustom codex\n", "utf8");

  assert.doesNotThrow(() => compile(dir, config));
  assert.ok(!existsSync(join(dir, ".claude", "skills", "tdd", "SKILL.md")));
});

test("compile does not overwrite existing-owned skill files", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  config.skills.tdd = {
    artifact_source: "existing",
    claude: "./.claude/skills/tdd/SKILL.md",
    codex: "./.agents/skills/tdd/SKILL.md",
  };
  const claudePath = join(dir, ".claude", "skills", "tdd", "SKILL.md");
  const codexPath = join(dir, ".agents", "skills", "tdd", "SKILL.md");
  mkdirSync(join(dir, ".claude", "skills", "tdd"), { recursive: true });
  mkdirSync(join(dir, ".agents", "skills", "tdd"), { recursive: true });
  writeFileSync(claudePath, "---\nname: tdd\ndescription: custom\n---\ncustom claude\n", "utf8");
  writeFileSync(codexPath, "---\nname: tdd\ndescription: custom\n---\ncustom codex\n", "utf8");

  compile(dir, config);

  assert.equal(readFileSync(claudePath, "utf8"), "---\nname: tdd\ndescription: custom\n---\ncustom claude\n");
  assert.equal(readFileSync(codexPath, "utf8"), "---\nname: tdd\ndescription: custom\n---\ncustom codex\n");
});

test("compile does not overwrite existing-owned agent files", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  config.agents.builder = {
    artifact_source: "existing",
    claude: "./.claude/agents/builder.md",
    codex: "./.codex/agents/builder.toml",
  };
  const claudePath = join(dir, ".claude", "agents", "builder.md");
  const codexPath = join(dir, ".codex", "agents", "builder.toml");
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  mkdirSync(join(dir, ".codex", "agents"), { recursive: true });
  writeFileSync(claudePath, "---\nname: builder\ndescription: custom\n---\ncustom claude agent\n", "utf8");
  writeFileSync(codexPath, 'name = "builder"\ndescription = "custom"\ndeveloper_instructions = "custom codex agent"\n', "utf8");

  compile(dir, config);

  assert.equal(readFileSync(claudePath, "utf8"), "---\nname: builder\ndescription: custom\n---\ncustom claude agent\n");
  assert.equal(readFileSync(codexPath, "utf8"), 'name = "builder"\ndescription = "custom"\ndeveloper_instructions = "custom codex agent"\n');
});

test("compile fails clearly when existing-owned agent paths are missing", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  config.agents.builder = {
    artifact_source: "existing",
    claude: "./.claude/agents/builder.md",
    codex: "./.codex/agents/builder.toml",
  };

  assert.throws(
    () => compile(dir, config),
    /agents\.builder\.claude: \.\/\.claude\/agents\/builder\.md/,
  );
});

test("compile refreshes rafi-owned native artifacts", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  compile(dir, config);

  const agentPath = join(dir, ".claude", "agents", "builder.md");
  const skillPath = join(dir, ".agents", "skills", "tdd", "SKILL.md");
  writeFileSync(agentPath, "STALE AGENT\n", "utf8");
  writeFileSync(skillPath, "STALE SKILL\n", "utf8");

  compile(dir, config);

  assert.notEqual(readFileSync(agentPath, "utf8"), "STALE AGENT\n");
  assert.notEqual(readFileSync(skillPath, "utf8"), "STALE SKILL\n");
  assert.ok(readFileSync(agentPath, "utf8").includes("name: builder"));
  assert.ok(readFileSync(skillPath, "utf8").includes("name: tdd"));
});

test("compile writes rafi-owned artifacts to configured renamed paths", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  config.agents.builder = {
    artifact_source: "rafi",
    claude: "./.claude/agents/builder-rafi.md",
    codex: "./.codex/agents/builder-rafi.toml",
  };
  config.skills.tdd = {
    artifact_source: "rafi",
    claude: "./.claude/skills/tdd-rafi/SKILL.md",
    codex: "./.agents/skills/tdd-rafi/SKILL.md",
  };

  compile(dir, config);

  assert.ok(existsSync(join(dir, ".claude", "agents", "builder-rafi.md")));
  assert.ok(existsSync(join(dir, ".codex", "agents", "builder-rafi.toml")));
  assert.ok(existsSync(join(dir, ".claude", "skills", "tdd-rafi", "SKILL.md")));
  assert.ok(existsSync(join(dir, ".agents", "skills", "tdd-rafi", "SKILL.md")));
  assert.ok(readFileSync(join(dir, ".claude", "agents", "builder-rafi.md"), "utf8").includes("name: builder-rafi"));
  assert.ok(readFileSync(join(dir, ".agents", "skills", "tdd-rafi", "SKILL.md"), "utf8").includes("name: tdd-rafi"));
});

test("append mode replaces Rafi's prior root block instead of duplicating it", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  config.agent_files.mode = "append";
  writeFileSync(join(dir, "AGENTS.md"), "CUSTOM RULES\n", "utf8");

  compile(dir, config);
  compile(dir, config);

  const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(content.startsWith("CUSTOM RULES\n"));
  assert.equal((content.match(/<!-- rafi:start -->/g) ?? []).length, 1);
  assert.equal((content.match(/Updated Content, generated by @rafi\/cli/g) ?? []).length, 1);
  assert.ok(!existsSync(join(dir, "AGENTS-rafi.md")));
});

test("append mode writes Codex overflow guidance to AGENTS-rafi.md", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), runtimeTargets: ["codex"] });
  config.agent_files.mode = "append";
  writeFileSync(join(dir, "AGENTS.md"), `# Existing Codex Rules\n\n${"A".repeat(2_000)}\n`, "utf8");

  compile(dir, config);
  compile(dir, config);

  const root = readFileSync(join(dir, "AGENTS.md"), "utf8");
  const sidecar = readFileSync(join(dir, "AGENTS-rafi.md"), "utf8");
  assert.ok(root.startsWith("<!-- rafi:start -->"));
  assert.equal((root.match(/<!-- rafi:start -->/g) ?? []).length, 1);
  assert.ok(root.includes("Read `AGENTS-rafi.md` before planning or editing"));
  assert.ok(root.includes("\n@AGENTS-rafi.md\n"));
  assert.ok(root.includes("# Existing Codex Rules"));
  assert.ok(!root.includes("# App-Level AI Agent Rules"));
  assert.ok(sidecar.startsWith("# rafi:"));
  assert.ok(sidecar.includes("# App-Level AI Agent Rules"));
});

test("append mode sidecars an existing Codex root that is already over the runtime limit", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), runtimeTargets: ["codex"] });
  config.agent_files.mode = "append";
  const userContent = `# Large Existing Root\n\n${"B".repeat(33_000)}\n`;
  writeFileSync(join(dir, "AGENTS.md"), userContent, "utf8");

  compile(dir, config);

  const root = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(root.startsWith("<!-- rafi:start -->"));
  assert.ok(root.includes("@AGENTS-rafi.md"));
  assert.ok(root.includes(userContent));
  assert.ok(existsSync(join(dir, "AGENTS-rafi.md")));
});

test("append mode refuses to overwrite a non-Rafi Codex sidecar", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), runtimeTargets: ["codex"] });
  config.agent_files.mode = "append";
  const rootBefore = `# Existing Codex Rules\n\n${"C".repeat(2_000)}\n`;
  const sidecarBefore = "# Hand-authored sidecar\n";
  writeFileSync(join(dir, "AGENTS.md"), rootBefore, "utf8");
  writeFileSync(join(dir, "AGENTS-rafi.md"), sidecarBefore, "utf8");

  assert.throws(() => compile(dir, config), /Refusing to overwrite existing \.\/AGENTS-rafi\.md/);
  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), rootBefore);
  assert.equal(readFileSync(join(dir, "AGENTS-rafi.md"), "utf8"), sidecarBefore);
});

test("append overflow reference is inserted after frontmatter", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), runtimeTargets: ["codex"] });
  config.agent_files.mode = "append";
  writeFileSync(
    join(dir, "AGENTS.md"),
    `---\ntitle: Agent Rules\n---\n# Existing Codex Rules\n\n${"D".repeat(2_000)}\n`,
    "utf8",
  );

  compile(dir, config);

  const root = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(root.startsWith("---\ntitle: Agent Rules\n---\n<!-- rafi:start -->"));
  assert.equal((root.match(/<!-- rafi:start -->/g) ?? []).length, 1);
});

test("append mode replaces an existing inline block with a reference when it crosses the limit", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), runtimeTargets: ["codex"] });
  config.agent_files.mode = "append";
  writeFileSync(join(dir, "AGENTS.md"), "# Existing Codex Rules\n", "utf8");
  compile(dir, config);
  const inlineRoot = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(inlineRoot.includes("# App-Level AI Agent Rules"));

  writeFileSync(join(dir, "AGENTS.md"), `${"E".repeat(2_000)}\n${inlineRoot}`, "utf8");
  compile(dir, config);

  const root = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(root.startsWith("<!-- rafi:start -->"));
  assert.equal((root.match(/<!-- rafi:start -->/g) ?? []).length, 1);
  assert.ok(root.includes("@AGENTS-rafi.md"));
  assert.ok(!root.includes("# App-Level AI Agent Rules"));
  assert.ok(existsSync(join(dir, "AGENTS-rafi.md")));
});

test("append mode keeps an existing sidecar reference sticky", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), runtimeTargets: ["codex"] });
  config.agent_files.mode = "append";
  writeFileSync(join(dir, "AGENTS.md"), `# Existing Codex Rules\n\n${"F".repeat(2_000)}\n`, "utf8");
  compile(dir, config);
  const referenceBlock = readFileSync(join(dir, "AGENTS.md"), "utf8").match(
    /<!-- rafi:start -->[\s\S]*?<!-- rafi:end -->\n?/,
  )?.[0];
  assert.ok(referenceBlock);
  writeFileSync(join(dir, "AGENTS.md"), `${referenceBlock}# Small Existing Root\n`, "utf8");

  compile(dir, config);

  const root = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.equal((root.match(/<!-- rafi:start -->/g) ?? []).length, 1);
  assert.ok(root.includes("@AGENTS-rafi.md"));
  assert.ok(!root.includes("# App-Level AI Agent Rules"));
});

test("append mode writes Claude overflow guidance to CLAUDE-rafi.md", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), runtimeTargets: ["claude"] });
  config.agent_files.mode = "append";
  writeFileSync(join(dir, "CLAUDE.md"), `# Existing Claude Rules\n\n${"G".repeat(10_000)}\n`, "utf8");

  compile(dir, config);

  const root = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  const sidecar = readFileSync(join(dir, "CLAUDE-rafi.md"), "utf8");
  assert.ok(!existsSync(join(dir, "AGENTS.md")));
  assert.ok(root.startsWith("<!-- rafi:start -->"));
  assert.ok(root.includes("\n@CLAUDE-rafi.md\n"));
  assert.ok(!root.includes("# App-Level AI Agent Rules"));
  assert.ok(sidecar.startsWith("# rafi:"));
  assert.ok(sidecar.includes("# App-Level AI Agent Rules"));
});

test("both-target append keeps Claude importing AGENTS when Codex uses a sidecar", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  config.agent_files.mode = "append";
  writeFileSync(join(dir, "AGENTS.md"), `# Existing Codex Rules\n\n${"H".repeat(2_000)}\n`, "utf8");

  compile(dir, config);

  const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
  const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  assert.ok(agents.includes("@AGENTS-rafi.md"));
  assert.ok(claude.includes("@AGENTS.md"));
  assert.ok(existsSync(join(dir, "AGENTS-rafi.md")));
  assert.ok(!existsSync(join(dir, "CLAUDE-rafi.md")));
});

test("auth failure detection matches Claude 401 output", () => {
  assert.equal(
    isRuntimeAuthFailure("Error: 401 Invalid authentication credentials"),
    true,
  );
});

test("update mode throws actionable runtime update errors when agent runtime fails", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), useClaude: false });
  config.agent_files.mode = "update";
  writeFileSync(join(dir, "AGENTS.md"), "CUSTOM RULES\n", "utf8");
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  let error: unknown;
  try {
    compile(dir, config);
  } catch (err) {
    error = err;
  } finally {
    process.env.PATH = originalPath;
  }

  assert.ok(error instanceof RuntimeUpdateError);
  assert.equal(error.runtime, "codex");
  assert.equal(error.targetFile, "./AGENTS.md");
  assert.match(error.message, /codex exec/);
  assert.match(error.message, /codex login/);
  assert.match(error.message, /agent_files\.mode: append or overwrite/);
  assert.match(error.message, /--root-file-mode append\|overwrite\|update/);

  const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.equal(content, "CUSTOM RULES\n");
});

test("--root-file-mode append avoids invoking agent runtime", () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), useClaude: false });
  config.agent_files.mode = "update";
  writeFileSync(join(dir, "AGENTS.md"), "CUSTOM RULES\n", "utf8");
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    compile(dir, config, { rootFileMode: "append" });
  } finally {
    process.env.PATH = originalPath;
  }

  const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(content.startsWith("CUSTOM RULES\n"));
  assert.equal((content.match(/<!-- rafi:start -->/g) ?? []).length, 1);
  assert.ok(content.includes("Updated Content, generated by @rafi/cli"));
});

test("compile is deterministic (two runs produce identical AGENTS.md)", () => {
  const d1 = tempDir();
  const d2 = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  compile(d1, config);
  compile(d2, config);
  assert.equal(
    readFileSync(join(d1, "AGENTS.md"), "utf8"),
    readFileSync(join(d2, "AGENTS.md"), "utf8"),
  );
});
