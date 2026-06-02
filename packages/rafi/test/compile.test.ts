/**
 * Phase 6 — end-to-end compile. Pins that `compile` writes AGENTS.md (with header
 * + byte-equivalent body), CLAUDE.md, compiled role bundles, and Claude agent files
 * for a target repo. Also verifies custom stack substitution and conditions header.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { compile } from "../src/compiler.js";
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
});

test("conditions header reflects the actual flags (ai=off for default)", () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers()); // usesAI:false by default
  compile(dir, config);
  const first = readFileSync(join(dir, "AGENTS.md"), "utf8").split("\n")[0];
  assert.ok(first.includes("ai=off"), `expected ai=off but got: ${first}`);
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
