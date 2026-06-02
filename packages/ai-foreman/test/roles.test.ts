/**
 * Phase 5 — roles.ts loader. Pins the 3-tier fallback contract:
 * (a) compiled bundle in target repo, (b) library defaults, (c) hardcoded fallback.
 * Also pins that MARKER_SPEC and QA_MARKER_SPEC preserve the STEP_STATUS protocol.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRoleBundle } from "../src/roles.js";
import { MARKER_SPEC, QA_MARKER_SPEC } from "../src/markers.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "foreman-roles-test-"));
}

function writeCompiledBundle(projectDir: string, role: string, system: string, skills: string[]): void {
  const dir = join(projectDir, ".rafi", "compiled", role);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "system.md"), system, "utf8");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ skills, model: null, effort: null }, null, 2) + "\n", "utf8");
}

// --- tier 1 ---

test("tier 1: loads compiled bundle from .rafi/compiled when present", () => {
  const dir = tempDir();
  writeCompiledBundle(dir, "builder", "## Custom System\nBuilt from compiled bundle.", ["tdd"]);

  const bundle = loadRoleBundle("builder", { projectDir: dir });
  assert.equal(bundle.source, "compiled");
  assert.ok(bundle.system.includes("## Custom System"));
  assert.deepEqual(bundle.skills, ["tdd"]);
  assert.equal(bundle.model, null);
  assert.equal(bundle.effort, null);
});

test("tier 1: picks target repo bundle even when library getter is provided", () => {
  const dir = tempDir();
  writeCompiledBundle(dir, "qa", "## Compiled QA\n", ["grill-me"]);

  const bundle = loadRoleBundle("qa", {
    projectDir: dir,
    libraryGetAgent: () => ({ system: "LIBRARY", skills: [], model: null, effort: null }),
  });
  assert.equal(bundle.source, "compiled", "should prefer compiled over library");
  assert.ok(bundle.system.includes("Compiled QA"));
});

// --- tier 2 ---

test("tier 2: uses injected library getter when no compiled bundle", () => {
  const dir = tempDir(); // empty — no .rafi/compiled
  const bundle = loadRoleBundle("builder", {
    projectDir: dir,
    libraryGetAgent: () => ({ system: "## Library System\n", skills: ["tdd"], model: null, effort: null }),
  });
  assert.equal(bundle.source, "library");
  assert.ok(bundle.system.includes("## Library System"));
  assert.deepEqual(bundle.skills, ["tdd"]);
});

test("tier 2: uses real special-agents library when no opts provided", () => {
  const bundle = loadRoleBundle("builder");
  assert.equal(bundle.source, "library");
  assert.ok(bundle.system.includes("## Core Working Agreement"), "real library system text expected");
  assert.ok(bundle.skills.length > 0, "real library should include skills");
});

// --- tier 3 ---

test("tier 3: returns fallback source when libraryGetAgent is null and no compiled bundle", () => {
  const dir = tempDir();
  const bundle = loadRoleBundle("builder", { projectDir: dir, libraryGetAgent: null });
  assert.equal(bundle.source, "fallback");
  assert.deepEqual(bundle.skills, []);
  assert.equal(bundle.model, null);
  assert.equal(bundle.effort, null);
});

test("tier 3: returns fallback even with no projectDir when library is null", () => {
  const bundle = loadRoleBundle("builder", { libraryGetAgent: null });
  assert.equal(bundle.source, "fallback");
});

// --- STEP_STATUS protocol pins ---

test("MARKER_SPEC contains all four builder marker kinds", () => {
  for (const kind of ["done", "blocked", "plan_complete", "needs_input"]) {
    assert.ok(MARKER_SPEC.includes(`STEP_STATUS: ${kind}`), `MARKER_SPEC missing: ${kind}`);
  }
});

test("QA_MARKER_SPEC contains qa_pass, qa_fail, and blocked marker kinds", () => {
  for (const kind of ["qa_pass", "qa_fail", "blocked"]) {
    assert.ok(QA_MARKER_SPEC.includes(`STEP_STATUS: ${kind}`), `QA_MARKER_SPEC missing: ${kind}`);
  }
});
