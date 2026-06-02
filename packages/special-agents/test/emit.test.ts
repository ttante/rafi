/**
 * Phase 3/4 — file emit. Pins that `emitCompiledBundles` writes
 * `.rafi/compiled/<role>/{system.md,meta.json}` for all four roles, and that
 * `emitClaudeAgents` writes `.claude/agents/<role>.md` with valid front-matter.
 * All I/O goes to a temp dir so the tests are self-contained.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emitCompiledBundles, emitClaudeAgents } from "../src/compile.js";
import { AGENT_ROLES } from "../src/agents.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-emit-test-"));
}

test("emitCompiledBundles writes system.md and meta.json for all four roles", () => {
  const dir = tempDir();
  emitCompiledBundles(dir);
  for (const role of AGENT_ROLES) {
    const base = join(dir, ".rafi", "compiled", role);
    assert.ok(existsSync(join(base, "system.md")), `${role}/system.md missing`);
    assert.ok(existsSync(join(base, "meta.json")), `${role}/meta.json missing`);
  }
});

test("meta.json skills match the agent manifest, model and effort are present", () => {
  const dir = tempDir();
  emitCompiledBundles(dir);
  for (const role of AGENT_ROLES) {
    const meta = JSON.parse(
      readFileSync(join(dir, ".rafi", "compiled", role, "meta.json"), "utf8"),
    );
    assert.ok(Array.isArray(meta.skills), `${role} meta.skills is not an array`);
    assert.ok("model" in meta, `${role} meta.model key missing`);
    assert.ok("effort" in meta, `${role} meta.effort key missing`);
  }
});

test("system.md for each role is non-empty and contains the base heading", () => {
  const dir = tempDir();
  emitCompiledBundles(dir);
  for (const role of AGENT_ROLES) {
    const sys = readFileSync(join(dir, ".rafi", "compiled", role, "system.md"), "utf8");
    assert.ok(sys.length > 0, `${role} system.md is empty`);
    assert.ok(
      sys.includes("## Core Working Agreement"),
      `${role} system.md missing base heading`,
    );
  }
});

test("emitCompiledBundles is deterministic (two runs produce identical bytes)", () => {
  const d1 = tempDir();
  const d2 = tempDir();
  emitCompiledBundles(d1);
  emitCompiledBundles(d2);
  for (const role of AGENT_ROLES) {
    const sys1 = readFileSync(join(d1, ".rafi", "compiled", role, "system.md"), "utf8");
    const sys2 = readFileSync(join(d2, ".rafi", "compiled", role, "system.md"), "utf8");
    assert.equal(sys1, sys2, `${role} system.md not deterministic`);
    const m1 = readFileSync(join(d1, ".rafi", "compiled", role, "meta.json"), "utf8");
    const m2 = readFileSync(join(d2, ".rafi", "compiled", role, "meta.json"), "utf8");
    assert.equal(m1, m2, `${role} meta.json not deterministic`);
  }
});

test("emitClaudeAgents writes .claude/agents/<role>.md with front-matter for all four roles", () => {
  const dir = tempDir();
  emitClaudeAgents(dir);
  for (const role of AGENT_ROLES) {
    const path = join(dir, ".claude", "agents", `${role}.md`);
    assert.ok(existsSync(path), `.claude/agents/${role}.md missing`);
    const content = readFileSync(path, "utf8");
    assert.ok(content.startsWith("---\n"), `${role}.md missing YAML front-matter`);
    assert.ok(content.includes("name:"), `${role}.md front-matter missing name`);
    assert.ok(content.includes("description:"), `${role}.md front-matter missing description`);
  }
});
