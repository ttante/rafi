import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WorkflowDb } from "../src/workflowDb.js";
for (const phase of ["before-acceptance", "accepted", "adopting", "adopted", "dispatched", "receipt-before-commit", "completed-before-checkpoint", "event-before-checkpoint"]) {
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
      assert.equal(db.unresolvedRoleDispatches("run", "builder").length, ["dispatched", "receipt-before-commit"].includes(phase) ? 1 : 0);
      assert.equal(existsSync(join(root, "mutation-observed.txt")), ["dispatched", "receipt-before-commit", "completed-before-checkpoint", "event-before-checkpoint"].includes(phase));
      if (["completed-before-checkpoint", "event-before-checkpoint"].includes(phase)) {
        assert.equal(db.hasUncheckpointedRoleTurn("run", "builder"), true);
        const dispatch = db.operations("run").find(operation => operation.status === "confirmed" &&
          (operation.intent as { operation?: string }).operation === "work-report")!;
        assert.ok(dispatch, "the journal confirms its verified native receipt before checkpoint publication");
        const receipt = db.continuityEvents("run").find(event => event.kind === "provider_response_received" && (event.payload as { dispatchId: string }).dispatchId === dispatch.idempotencyKey);
        assert.ok(receipt, "full native receipt survives before checkpoint publication");
        assert.equal((receipt.payload as { journalOwnedEvidence: boolean }).journalOwnedEvidence, true);
        const responseDigest = (dispatch.result as { responseDigest: string }).responseDigest;
        assert.ok(responseDigest);
        assert.ok(db.getEvidence(responseDigest), "the receipt is retained exactly once by its journal owner");
        assert.equal(db.retainedStructuredTurn(dispatch.idempotencyKey).structured?.state, "candidate");
        assert.ok(db.structuredProcessingContext(dispatch.idempotencyKey), "confirmed dispatch retains pending checkpoint work");
      }
    } finally { db.close(); }
  });
}
