import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { DEFAULT_CONFIG } from "../src/config.js";

test("routine project test forms are allowed without permitting shell escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-shell-"));
  const project = join(root, "project"); mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(root, "outside")); symlinkSync(join(root, "outside"), join(project, "escape"), process.platform === "win32" ? "junction" : "dir");
  const policy = new PermissionPolicy(DEFAULT_CONFIG.permissions, project, { currentBranchWorkflow: true });
  try {
    if (process.platform !== "win32") {
      mkdirSync(join(project, ".venv/bin"), { recursive: true });
      writeFileSync(join(root, "outside/python3.14"), "native interpreter fixture");
      symlinkSync(join(root, "outside/python3.14"), join(project, ".venv/bin/python"));
      symlinkSync(process.execPath, join(project, ".venv/bin/python3"));
      assert.equal(policy.classify({ toolName: "Bash", input: { command: ".venv/bin/python -m pytest" } }).decision, "allow");
      assert.equal(policy.classify({ toolName: "Bash", input: { command: ".venv/bin/python3 -m pytest" } }).decision, "escalate");
    }
    for (const command of [
      "cd src && python -m pytest", "cd 'src' && PYTHONPATH=. python -m pytest 2>&1",
      "PYTHONPATH=src .venv/bin/python -m pytest", "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 pytest 2>&1",
      ".venv/bin/python -m pytest", "uv run --offline --no-sync python -m pytest",
      "cd src && uv run --offline --no-sync python -m pytest", "python -m pytest 2>&1 | cat package.json",
    ]) assert.equal(policy.classify({ toolName: "Bash", input: { command } }).decision, "allow", command);
    for (const command of [
      "cd .. && python -m pytest", "cd escape && pytest", "cd ~ && pytest", "cd src || pytest",
      "PATH=/tmp python -m pytest", "NODE_OPTIONS=--require=evil pytest", "PYTHONPATH=/tmp pytest",
      "PYTHONPATH=$(pwd) pytest", "cd src && pytest > result.txt", "cd src && pytest &",
      "cd src && pytest\npython -c bad", "cd src && uv run python -m pytest", "cd src && git reset --hard",
      "cd src | pytest", "CI=1 pytest || python -m pytest", "cd src && pytest 2>&1 | frobnicate",
      "CI=1 'python -m pytest'", "cd src && pytest &&",
    ]) assert.equal(policy.classify({ toolName: "Bash", input: { command } }).decision, "escalate", command);
    assert.equal(policy.classify({ toolName: "Bash", executionCwd: join(project, "src"), input: { command: "cd .. && python -m pytest" } }).decision, "allow");
    assert.equal(policy.classify({ toolName: "Bash", executionCwd: join(root, "outside"), input: { command: "CI=1 pytest" } }).decision, "escalate");
    assert.equal(policy.classify({ toolName: "Edit", executionCwd: join(project, "src"), input: { file_path: "../index.py" } }).decision, "allow");
    assert.equal(policy.classify({ toolName: "Edit", executionCwd: join(project, "src"), input: { file_path: "../../outside/secret.py" } }).decision, "escalate");
    assert.equal(policy.classify({ toolName: "Edit", executionCwd: join(project, "src"), input: { file_path: "../.git/config" } }).decision, "escalate");
    assert.equal(policy.classify({ toolName: "Write", input: { file_path: "escape/new-file.py" } }).decision, "escalate");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
