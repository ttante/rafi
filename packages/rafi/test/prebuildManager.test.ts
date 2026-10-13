import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";

for (const partial of [false, true]) test(`scripted Manager consults ${partial ? "partial installation" : "configured project"} before any build`, { timeout: 30000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-prebuild-manager-"));
  try {
    mkdirSync(join(root, ".rafi")); mkdirSync(join(root, "bin"));
    if (!partial) writeFileSync(join(root, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())));
    const provider = join(root, "bin/codex");
    copyFileSync(fileURLToPath(new URL("../../ai-foreman/test/fixtures/build-stall-codex.cjs", import.meta.url)), provider); chmodSync(provider, 0o755);
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/index.ts", import.meta.url)), "manager", root, "--agent", "codex", "--ask", "How can I fix planning and ticket setup?"], { cwd: root, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` }, encoding: "utf8", timeout: 25000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /0 retained build runs/);
    assert.match(result.stdout, /project setup and planning/);
    assert.equal(existsSync(join(root, ".foreman/runs")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
