import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDb } from "../src/workflowDb.js";
import { probeRuntime } from "../src/runtimeReadiness.js";

for (const runtime of ["claude", "codex"] as const) test(`authenticated ${runtime} readiness retains and releases preparation ownership`, { skip: process.env.RAFI_LIVE_BUILD_ADMISSION !== "1", timeout: 150000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), `rafi-${runtime}-admission-live-`));
  const db = new WorkflowDb(root);
  try {
    const authority = db.acquireBuildAdmission("live-readiness", "worker");
    const result = await probeRuntime(root, runtime, { timeoutMs: 120000, build: { project: root, runId: authority.runId, authority } });
    assert.equal(result.ok, true, `${runtime}: ${result.category}: ${result.diagnostics}`);
    assert.equal(db.buildAdmission()?.token, authority.token);
    assert.deepEqual(db.unresolvedPreparationProcesses(authority.runId), []);
    assert.equal(db.preparationEligibility(authority.runId).eligible, true);
    db.releaseBuildAdmission(authority);
    assert.equal(db.buildAdmission(), undefined);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
