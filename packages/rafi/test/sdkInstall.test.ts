import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeAgentSdkInstallCommand } from "../src/sdkInstall.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-sdk-install-test-"));
}

test("Claude SDK install uses pnpm workspace-root add in pnpm monorepos", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n', "utf8");

  const install = buildClaudeAgentSdkInstallCommand(dir, "pnpm");

  assert.equal(install.command, "pnpm");
  assert.deepEqual(install.args, ["add", "-w", "@anthropic-ai/claude-agent-sdk"]);
  assert.equal(install.display, "pnpm add -w @anthropic-ai/claude-agent-sdk");
});

test("Claude SDK install uses plain pnpm add outside workspaces", () => {
  const dir = tempDir();

  const install = buildClaudeAgentSdkInstallCommand(dir, "pnpm");

  assert.equal(install.command, "pnpm");
  assert.deepEqual(install.args, ["add", "@anthropic-ai/claude-agent-sdk"]);
});

test("Claude SDK install supports packageManager versions", () => {
  const dir = tempDir();

  const install = buildClaudeAgentSdkInstallCommand(dir, "pnpm@10.2.1");

  assert.equal(install.command, "pnpm");
  assert.deepEqual(install.args, ["add", "@anthropic-ai/claude-agent-sdk"]);
});

test("Claude SDK install uses yarn workspace root flag for yarn workspaces", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }), "utf8");

  const install = buildClaudeAgentSdkInstallCommand(dir, "yarn");

  assert.equal(install.command, "yarn");
  assert.deepEqual(install.args, ["add", "-W", "@anthropic-ai/claude-agent-sdk"]);
});

test("Claude SDK install falls back to npm for unknown package managers", () => {
  const dir = tempDir();

  const install = buildClaudeAgentSdkInstallCommand(dir, "custompm");

  assert.equal(install.command, "npm");
  assert.deepEqual(install.args, ["install", "@anthropic-ai/claude-agent-sdk"]);
});
