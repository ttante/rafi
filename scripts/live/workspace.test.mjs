import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLiveWorkspace, liveProjectPath } from "./workspace.mjs";

test("live provider workspace stays short and is independent from evidence root", () => {
  const evidenceBase = mkdtempSync(join(tmpdir(), "rf-evidence-"));
  const evidenceRoot = join(evidenceBase, "a".repeat(120));
  const live = createLiveWorkspace("test", { evidenceRoot });
  try {
    assert.equal(live.evidenceRoot, evidenceRoot);
    assert.notEqual(live.evidenceRoot, live.workspaceRoot);
    assert.ok(live.workspaceRoot.length <= 64);
    assert.equal(liveProjectPath(live.workspaceRoot, "claude-1"), join(live.workspaceRoot, "claude-1"));
  } finally {
    rmSync(live.workspaceRoot, { recursive: true, force: true });
    rmSync(evidenceBase, { recursive: true, force: true });
  }
});

test("live project paths reject provider cwd paths without sandbox headroom", () => {
  assert.throws(
    () => liveProjectPath("/tmp/" + "w".repeat(60), "claude-1"),
    /provider cwd is too long/,
  );
});

test("live workspace honors an explicit short work root", () => {
  const base = mkdtempSync("/tmp/rf-");
  const previous = process.env.RAFI_LIVE_WORK_ROOT;
  process.env.RAFI_LIVE_WORK_ROOT = base;
  try {
    const live = createLiveWorkspace("test");
    assert.ok(live.workspaceRoot.startsWith(base));
    rmSync(live.workspaceRoot, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.RAFI_LIVE_WORK_ROOT;
    else process.env.RAFI_LIVE_WORK_ROOT = previous;
    rmSync(base, { recursive: true, force: true });
  }
});
