/**
 * Phase 7 — packed-files gate for ai-foreman.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(HERE, "..");

function packList(): string[] {
  const out = execSync("npm pack --dry-run --json 2>/dev/null", {
    cwd: PKG_DIR,
    encoding: "utf8",
  });
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return parsed[0].files.map((f) => f.path);
}

test("ai-foreman pack includes dist/ output", () => {
  const files = packList();
  assert.ok(files.some((f) => f.startsWith("dist/")), "no dist/ files in pack");
});

test("ai-foreman pack includes agent-run exported subpath files", () => {
  const files = packList();
  assert.ok(files.includes("dist/agentRun.js"), "dist/agentRun.js missing from pack");
  assert.ok(files.includes("dist/agentRun.d.ts"), "dist/agentRun.d.ts missing from pack");
});

test("ai-foreman pack includes the exported Claude adapter used by Rafi readiness", () => {
  const files = packList();
  assert.ok(files.includes("dist/adapters/claude.js"), "dist/adapters/claude.js missing from pack");
  assert.ok(files.includes("dist/adapters/claude.d.ts"), "dist/adapters/claude.d.ts missing from pack");
});

test("ai-foreman pack includes foreman.yaml", () => {
  const files = packList();
  assert.ok(files.includes("foreman.yaml"), "foreman.yaml missing from pack");
});

test("ai-foreman pack excludes test/ files", () => {
  const files = packList();
  assert.ok(!files.some((f) => f.startsWith("test/")), `test/ files found in pack: ${files.filter((f) => f.startsWith("test/")).join(", ")}`);
});

test("ai-foreman pack excludes TypeScript source files", () => {
  const files = packList();
  assert.ok(!files.some((f) => f.startsWith("src/")), `src/ TypeScript files found in pack: ${files.filter((f) => f.startsWith("src/")).join(", ")}`);
});

test("ai-foreman pack includes package.json and README.md", () => {
  const files = packList();
  assert.ok(files.includes("package.json"), "package.json missing from pack");
  assert.ok(files.includes("README.md"), "README.md missing from pack");
});
