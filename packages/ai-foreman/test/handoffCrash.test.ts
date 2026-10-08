import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WorkflowDb } from "../src/workflowDb.js";
for (const phase of ["before-acceptance", "accepted", "adopting", "adopted", "dispatched", "completed-before-checkpoint"]) {
  test(`SIGKILL at handoff ${phase} preserves authoritative ownership and dispatch truth`, t => {
    const root = mkdtempSync(join(tmpdir(), "rafi-handoff-kill-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("fixtures/handoff-crash.ts", import.meta.url)), root, phase], { encoding: "utf8", timeout: 15000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const db = new WorkflowDb(root);
    try {
      const accepted = phase !== "before-acceptance";
      assert.equal(db.roleMutationLease("run", "builder")?.providerSessionId, accepted ? "successor" : "old");
      assert.equal(db.branchResumeSessions()[0]?.sessionId, accepted ? "successor" : "old", "resume pointer commits with acceptance, before filesystem projection or adoption");
      assert.equal(db.handoffs("run")[0]?.generation, 3);
      assert.equal(db.handoffs("run")[0]?.state === "accepted", accepted);
      assert.equal(db.unresolvedRoleDispatches("run", "builder").length, phase === "dispatched" ? 1 : 0);
      assert.equal(existsSync(join(root, "mutation-observed.txt")), ["dispatched", "completed-before-checkpoint"].includes(phase));
      if (phase === "completed-before-checkpoint") assert.equal(db.hasUncheckpointedRoleTurn("run", "builder"), true);
    } finally { db.close(); }
  });
}
