import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRecoveryPreview, completeBuildRun, createBuildRun, persistBuildSession, readBuildRuns, recordBuildReceipt, releaseBuildLease } from "../src/buildRuns.js";

test("build records atomically retain sessions, receipts, and completed history", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-run-"));
  try {
    const settings = { role: "builder" as const, source: "project" as const, make: "codex" as const, model: "default", reasoning: "high", fast: false };
    let run = createBuildRun({ tickets: ["T001", "T002"], repositoryRoot: dir, builder: settings, qa: { ...settings, role: "qa" } });
    run = persistBuildSession(dir, run, "builder", "session-1");
    run = recordBuildReceipt(dir, run, "commit:T001", { externalId: "abc123" });
    const duplicate = recordBuildReceipt(dir, run, "commit:T001", { externalId: "wrong" });
    assert.equal(duplicate.receipts["commit:T001"]?.externalId, "abc123");
    assert.match(buildRecoveryPreview(run).join("\n"), /exact Builder session available/);
    run = completeBuildRun(dir, run);
    assert.equal(readBuildRuns(dir)[0]?.status, "completed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("released build leases become recoverable without deleting partial state", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-run-"));
  try {
    let run = createBuildRun({ tickets: ["T010"], repositoryRoot: dir });
    run = releaseBuildLease(dir, run, "recoverable");
    assert.equal(run.lease, undefined);
    assert.equal(readBuildRuns(dir)[0]?.checkpoint, "created");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build records persist shared and mixed branch allocation modes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-run-modes-"));
  try {
    const shared = createBuildRun({ tickets: ["T020"], repositoryRoot: dir, branchMode: "shared" });
    releaseBuildLease(dir, shared, "recoverable");
    const mixed = createBuildRun({ tickets: ["T021", "T022"], repositoryRoot: dir, branchMode: "mixed" });
    releaseBuildLease(dir, mixed, "recoverable");
    assert.deepEqual(readBuildRuns(dir).map((run) => run.branchMode).sort(), ["mixed", "shared"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
