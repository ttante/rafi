/**
 * Phase 7 — packed-files gate for @rafi-ai/cli.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(HERE, "..");
const packageJson = JSON.parse(
  readFileSync(join(PKG_DIR, "package.json"), "utf8"),
) as { dependencies?: Record<string, string>; bundledDependencies?: string[] };
const aiForemanPackageJson = JSON.parse(
  readFileSync(join(PKG_DIR, "..", "ai-foreman", "package.json"), "utf8"),
) as { version: string };

function packList(): string[] {
  const out = execSync("npm pack --dry-run --json 2>/dev/null", {
    cwd: PKG_DIR,
    encoding: "utf8",
  });
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return parsed[0].files.map((f) => f.path);
}

test("@rafi-ai/cli pack includes dist/ output", () => {
  const files = packList();
  assert.ok(files.some((f) => f.startsWith("dist/")), "no dist/ files in pack");
});

test("@rafi-ai/cli pack excludes test/ files", () => {
  const files = packList();
  assert.ok(!files.some((f) => f.startsWith("test/")), `test/ files found in pack: ${files.filter((f) => f.startsWith("test/")).join(", ")}`);
});

test("@rafi-ai/cli pack excludes TypeScript source files", () => {
  const files = packList();
  assert.ok(!files.some((f) => f.startsWith("src/")), `src/ TypeScript files found in pack: ${files.filter((f) => f.startsWith("src/")).join(", ")}`);
});

test("@rafi-ai/cli pack includes package.json and README.md", () => {
  const files = packList();
  assert.ok(files.includes("package.json"), "package.json missing from pack");
  assert.ok(files.includes("README.md"), "README.md missing from pack");
});

test("@rafi-ai/cli pack includes LICENSE", () => {
  const files = packList();
  assert.ok(files.includes("LICENSE"), "LICENSE missing from pack");
});

test("@rafi-ai/cli depends on published rafi-spec", () => {
  assert.equal(packageJson.dependencies?.["rafi-spec"], "0.4.0");
  assert.ok(!packageJson.bundledDependencies?.includes("rafi-spec"), "rafi-spec should not be bundled");
  assert.ok(packageJson.dependencies?.ajv, "ajv must be a direct dependency for rafi-spec runtime imports");
});

test("@rafi-ai/cli depends on the published ai-foreman version", () => {
  assert.equal(aiForemanPackageJson.version, "1.3.1");
  assert.equal(packageJson.dependencies?.["ai-foreman"], aiForemanPackageJson.version);
});
