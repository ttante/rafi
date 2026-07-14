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

test("Claude SDK install uses yarn workspace root flag for Yarn Classic", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }), "utf8");

  const install = buildClaudeAgentSdkInstallCommand(dir, "yarn@1.22.22");

  assert.equal(install.command, "yarn");
  assert.deepEqual(install.args, ["add", "-W", "@anthropic-ai/claude-agent-sdk"]);
  assert.equal(install.display, "yarn add -W @anthropic-ai/claude-agent-sdk");
});

test("Claude SDK install omits yarn workspace root flag for modern Yarn", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }), "utf8");

  const install = buildClaudeAgentSdkInstallCommand(dir, "yarn@4.5.0");

  assert.equal(install.command, "yarn");
  assert.deepEqual(install.args, ["add", "@anthropic-ai/claude-agent-sdk"]);
  assert.equal(install.display, "yarn add @anthropic-ai/claude-agent-sdk");
});

test("Claude SDK install detects generic yarn version when target metadata is absent", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }), "utf8");

  const install = buildClaudeAgentSdkInstallCommand(dir, "yarn", {
    resolvePackageManagerVersion: (packageManager, targetDir) => {
      assert.equal(packageManager, "yarn");
      assert.equal(targetDir, dir);
      return "1.22.22";
    },
  });

  assert.equal(install.command, "yarn");
  assert.deepEqual(install.args, ["add", "-W", "@anthropic-ai/claude-agent-sdk"]);
});

test("Claude SDK install reads package.json packageManager for generic yarn", () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ packageManager: "yarn@4.5.0", workspaces: ["packages/*"] }),
    "utf8",
  );

  const install = buildClaudeAgentSdkInstallCommand(dir, "yarn", {
    resolvePackageManagerVersion: () => {
      throw new Error("packageManager metadata should avoid external version lookup");
    },
  });

  assert.equal(install.command, "yarn");
  assert.deepEqual(install.args, ["add", "@anthropic-ai/claude-agent-sdk"]);
});

test("Claude SDK install keeps selected package manager version over target metadata", () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ packageManager: "yarn@1.22.22", workspaces: ["packages/*"] }),
    "utf8",
  );

  const install = buildClaudeAgentSdkInstallCommand(dir, "yarn@4.5.0");

  assert.equal(install.command, "yarn");
  assert.deepEqual(install.args, ["add", "@anthropic-ai/claude-agent-sdk"]);
});

test("Claude SDK install supports bun", () => {
  const dir = tempDir();

  const install = buildClaudeAgentSdkInstallCommand(dir, "bun");

  assert.equal(install.command, "bun");
  assert.deepEqual(install.args, ["add", "@anthropic-ai/claude-agent-sdk"]);
});

test("Claude SDK install falls back to npm for unknown package managers", () => {
  const dir = tempDir();

  const install = buildClaudeAgentSdkInstallCommand(dir, "custompm");

  assert.equal(install.command, "npm");
  assert.deepEqual(install.args, ["install", "@anthropic-ai/claude-agent-sdk"]);
  assert.equal(install.display, "npm install @anthropic-ai/claude-agent-sdk");
  assert.equal(install.fallbackFrom, "custompm");
});
