import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { WorkflowDb } from "../src/workflowDb.js";
import { registerHandbackWriter } from "../src/qaHandbackMigration.js";

test("expired heartbeat cannot steal a live or unverified writer; a proven dead owner can be reclaimed atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-handback-lease-"));
  const first = new WorkflowDb(root), second = new WorkflowDb(root);
  try {
    first.ensureRun("run"); const lease = first.acquireLease("run", "owner", new Date(0));
    assert.throws(() => second.acquireLease("run", "competitor", new Date(), 1), /held by owner/);
    const raw = new Database(first.path); registerHandbackWriter(raw); raw.function("rafi_protocol_v3", () => 1);
    try { raw.prepare("UPDATE project_lease SET pid=2147483647,process_start='dead'").run(); } finally { raw.close(); }
    const successor = second.acquireLease("run", "successor"); assert.equal(successor.generation, lease.generation + 1);
    assert.throws(() => first.heartbeatLease(lease), /ownership changed/);
    first.releaseLease(lease); assert.equal(second.currentLease()?.owner, "successor");
    second.releaseLease(successor);
  } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});
