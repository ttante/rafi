import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { BUILD_RUN_DIRECTORY, buildRecoveryPreview, completeBuildRun, createBuildRun, heartbeatBuildRun, persistBuildSession, readBuildRuns, recordBuildReceipt, recoverableBuildRuns, releaseBuildLease } from "../src/buildRuns.js";
import { cmdInit } from "../src/tickets/commands.js";
import { StateDb } from "../src/tickets/stateDb.js";

test("build records atomically retain sessions, receipts, and completed history", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-run-"));
  try {
    const settings = { role: "builder" as const, source: "project" as const, make: "codex" as const, model: "default", reasoning: "high", fast: false };
    let run = createBuildRun({ tickets: ["T001", "T002"], repositoryRoot: dir, builder: settings, qa: { ...settings, role: "qa" } });
    run = persistBuildSession(dir, run, "builder", "session-1");
    run = recordBuildReceipt(dir, run, "commit:T001", { externalId: "abc123" });
    const duplicate = recordBuildReceipt(dir, run, "commit:T001", { externalId: "wrong" });
    assert.equal(duplicate.receipts["commit:T001"]?.externalId, "abc123");
    assert.match(buildRecoveryPreview(run).join("\n"), /Builder session candidate requires validation/);
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

test("pure heartbeats update only the authoritative lease row", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-heartbeat-"));
  try {
    const created = createBuildRun({ runId: "heartbeat-run", tickets: ["T001"], repositoryRoot: dir, now: new Date("2025-01-01T00:00:00.000Z") });
    const snapshot = join(dir, BUILD_RUN_DIRECTORY, `${created.runId}.json`);
    const beforeMtime = statSync(snapshot).mtimeMs;
    const db = new Database(join(dir, ".rafi", "recovery.sqlite3"), { readonly: true });
    const count = (table: string): number => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    const before = { events: count("workflow_events"), sessions: count("provider_sessions"), imports: count("legacy_imports") };
    db.close();

    const next = heartbeatBuildRun(dir, created, new Date("2025-01-01T00:00:10.000Z"));
    assert.equal(next.lease?.heartbeatAt, "2025-01-01T00:00:10.000Z");
    assert.equal(statSync(snapshot).mtimeMs, beforeMtime);
    const afterDb = new Database(join(dir, ".rafi", "recovery.sqlite3"), { readonly: true });
    const afterCount = (table: string): number => Number((afterDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    assert.deepEqual({ events: afterCount("workflow_events"), sessions: afterCount("provider_sessions"), imports: afterCount("legacy_imports") }, before);
    assert.equal((afterDb.prepare("SELECT heartbeat_at FROM project_lease WHERE singleton=1").get() as { heartbeat_at: string }).heartbeat_at, "2025-01-01T00:00:10.000Z");
    assert.equal((afterDb.prepare("SELECT legacy FROM workflow_runs WHERE run_id=?").get(created.runId) as { legacy: number }).legacy, 0);
    afterDb.close();
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

test("recoverable runs infer tickets omitted by legacy current-branch records", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-run-legacy-ticket-"));
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    let run = createBuildRun({
      tickets: [],
      repositoryRoot: dir,
      branchMode: "current",
      now: new Date("2025-01-01T00:00:00.000Z"),
    });
    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      db.insertEvent({
        timestamp: "2025-01-01T00:00:01.000Z",
        actor: "foreman",
        ticket_id: "T030",
        event_type: "update",
        old_status: "next",
        new_status: "in_progress",
        summary: "Starting step 1 of 1",
        validation: null,
        evidence: null,
        payload_json: "{}",
      });
    } finally {
      db.close();
    }
    run = releaseBuildLease(dir, run, "recoverable");

    const recovered = recoverableBuildRuns(dir).find((candidate) => candidate.runId === run.runId);
    assert.deepEqual(recovered?.tickets, ["T030"]);
    assert.equal(recovered?.currentTicket, "T030");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
