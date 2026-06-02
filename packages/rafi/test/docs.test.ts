/**
 * Phase 6 — doc copy. Pins flag-gated copying behavior: AI docs only when
 * usesAI, no clobber by default, --force overwrites.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyDocs } from "../src/docs.js";
import type { ProjectFlags } from "rafi-spec";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-docs-test-"));
}

const ALL_ON: ProjectFlags = { hasFrontend: true, usesAI: true, runsInCloud: true };
const AI_OFF: ProjectFlags = { hasFrontend: true, usesAI: false, runsInCloud: true };
const FRONTEND_OFF: ProjectFlags = { hasFrontend: false, usesAI: false, runsInCloud: true };

test("always-gated docs are copied regardless of flags", () => {
  const dir = tempDir();
  const copied = copyDocs(dir, AI_OFF);
  assert.ok(copied.includes("architecture.md"), "architecture.md should always be copied");
  assert.ok(existsSync(join(dir, "docs", "architecture.md")));
});

test("AI docs are copied when usesAI:true", () => {
  const dir = tempDir();
  const copied = copyDocs(dir, ALL_ON);
  assert.ok(copied.includes("ai.md"), "ai.md should be copied when usesAI");
  assert.ok(copied.includes("ai-evals.md"));
  assert.ok(copied.includes("ai-costs.md"));
});

test("AI docs are NOT copied when usesAI:false", () => {
  const dir = tempDir();
  const copied = copyDocs(dir, AI_OFF);
  assert.ok(!copied.includes("ai.md"), "ai.md must not be copied when usesAI:false");
  assert.ok(!existsSync(join(dir, "docs", "ai.md")));
});

test("existing files are not clobbered by default", () => {
  const dir = tempDir();
  const destPath = join(dir, "docs", "architecture.md");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(destPath, "# My custom architecture\n", "utf8");

  const copied = copyDocs(dir, AI_OFF);
  assert.ok(!copied.includes("architecture.md"), "existing file should not be in copied list");

  assert.equal(readFileSync(destPath, "utf8"), "# My custom architecture\n");
});

test("--force overwrites existing files", () => {
  const dir = tempDir();
  const destPath = join(dir, "docs", "architecture.md");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(destPath, "# stale content\n", "utf8");

  const copied = copyDocs(dir, AI_OFF, { force: true });
  assert.ok(copied.includes("architecture.md"), "forced copy should appear in list");

  const content = readFileSync(destPath, "utf8");
  assert.ok(content !== "# stale content\n", "stale content should have been replaced");
});

test("copyDocs returns paths of files actually written", () => {
  const dir = tempDir();
  const copied = copyDocs(dir, AI_OFF);
  assert.ok(copied.length > 0, "should return at least one path");
  for (const p of copied) {
    assert.ok(existsSync(join(dir, "docs", p)), `returned path missing on disk: ${p}`);
  }
});
