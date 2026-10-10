import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellArgument, formatRecoveryCommand, formatDecisionCommands, withRecoveryCommandFamily } from "../src/recoveryGuidance.js";

test("recovery command executes with the owning project as one literal shell argument", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-guidance-"));
  try {
    const owning = join(root, "project ' $(not-executed); &"); mkdirSync(owning);
    const command = formatRecoveryCommand(owning, "rafi", root);
    const args = execFileSync("/bin/sh", ["-c", 'rafi() { printf "%s\\n" "$@"; }; ' + command], { encoding: "utf8", cwd: root }).trimEnd().split("\n");
    assert.deepEqual(args, ["resume", owning]);
    assert.equal(formatRecoveryCommand(owning, "rafi", owning), "rafi resume");
    const alias = join(root, "alias"); symlinkSync(owning, alias);
    assert.equal(formatRecoveryCommand(alias, "rafi", owning), "rafi resume");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("standalone family is explicit and async-local", async () => {
  await withRecoveryCommandFamily("ai-foreman", async () => {
    await Promise.resolve();
    assert.equal(formatRecoveryCommand("/tmp/project"), "ai-foreman manager /tmp/project");
    assert.equal(formatRecoveryCommand("/tmp/project", "ai-foreman", "/tmp", { id: "session", steps: 2 }), "ai-foreman start /tmp/project --steps 2 --resume session");
  });
  assert.match(formatRecoveryCommand("/tmp/project"), /^rafi resume/);
});

test("Windows guidance quotes PowerShell literals without interpolation", () => {
  assert.equal(shellArgument("C:\\work\\a'b $env:HOME", "win32"), "'C:\\work\\a''b $env:HOME'");
});

test("standalone custom answers use build:decide rather than manager review", () => {
  const lines = formatDecisionCommands("/tmp/project", "run", { decisionId: "decision", choices: [{ id: "custom", label: "Custom" }] }, "ai-foreman");
  assert.match(lines[0]!, /ai-foreman build:decide .*--choice custom with --answer/);
  assert.doesNotMatch(lines[0]!, /manager/);
});
