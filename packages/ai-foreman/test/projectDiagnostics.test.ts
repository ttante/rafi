import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { ManagerRunSummaryV1 } from "rafi-spec";
import { createBuildRun } from "../src/buildRuns.js";
import { buildManagerProjectPacket, MANAGER_PACKET_MAX_BYTES } from "../src/managerPacket.js";
import { OBSERVABILITY_DB_FILE, ObservabilityReader, ObservabilityStore } from "../src/observability.js";
import { aggregateManagerRuns, collectManagerProjectDiagnostics, parseManagerEvidenceRequest, resolveManagerQuestionRuns } from "../src/projectDiagnostics.js";

function temp(): string { return mkdtempSync(join(tmpdir(), "rafi-project-diagnostics-")); }
function summary(runId: string, activeExecutionMs: number | undefined, status = "completed"): ManagerRunSummaryV1 {
  const createdAt = `2026-01-${String(Number(runId.replace(/\D/g, "")) || 1).padStart(2, "0")}T00:00:00.000Z`;
  const withoutDigest: Omit<ManagerRunSummaryV1, "digest"> = {
    version: 1, runId, status, createdAt, updatedAt: createdAt, completedAt: createdAt, activeState: "inactive", ticketIds: [`T-${runId}`], branchMode: "current", qaEnabled: true, provider: "codex", model: "test",
    timing: { calendarMs: activeExecutionMs, activeExecutionMs, pausedOfflineMs: activeExecutionMs === undefined ? undefined : 0, explicitWaitMs: 0, attributedMs: activeExecutionMs, unattributedMs: activeExecutionMs === undefined ? undefined : 0, inclusiveByKind: {}, exclusiveByKind: {} },
    counts: { byKind: {}, byOutcome: {}, qaAttempts: 0, qaFailures: 0, fixes: 0, retries: 0, tools: 0, providerTurns: 0, waits: 0, executions: 1 },
    usage: { scope: "unavailable" }, retry: { observedMs: 0, reportedDelayMs: 0 }, topOperations: [], detailLevel: activeExecutionMs === undefined ? "legacy" : "detailed",
    metricCoverage: { timing: activeExecutionMs === undefined ? "unavailable" : "available", usage: "unavailable" }, capabilities: { version: 1, sources: {} }, evidenceIds: [`run:${runId}`],
  };
  return { ...withoutDigest, digest: runId };
}

test("project aggregates calculate exact percentiles and exclude missing metrics from totals", () => {
  const runs = [summary("r1", 10), summary("r2", 20), summary("r3", 30), summary("r4", 40), summary("r5", 50), summary("r6", undefined, "failed")];
  const result = aggregateManagerRuns(runs, { version: 1, metrics: ["activeExecutionMs"], operations: ["sum", "count", "minimum", "maximum", "average", "median", "p75", "p90"] });
  const group = result.groups[0]!;
  assert.equal(group.values.activeExecutionMs?.sum, 150);
  assert.equal(group.values.activeExecutionMs?.count, 5);
  assert.equal(group.values.activeExecutionMs?.median, 30);
  assert.equal(group.values.activeExecutionMs?.p75, 40);
  assert.equal(group.values.activeExecutionMs?.p90, 46);
  assert.deepEqual(group.coverage.activeExecutionMs, { eligibleRuns: 6, coveredRuns: 5, missingRuns: 1, state: "partial" });
  const unavailable = aggregateManagerRuns(runs, { version: 1, metrics: ["authoritativeCostUsd"], operations: ["sum", "count"] }).groups[0]!;
  assert.deepEqual(unavailable.values.authoritativeCostUsd, {});
  assert.equal(unavailable.coverage.authoritativeCostUsd?.state, "unavailable");
});

test("aggregate grouping by ticket emits evidence-bearing deterministic groups", () => {
  const result = aggregateManagerRuns([summary("r1", 10), summary("r2", 20)], { version: 1, groupBy: ["ticket"], metrics: ["activeExecutionMs"], operations: ["sum"] });
  assert.deepEqual(result.groups.map(item => item.key), [{ ticket: "T-r1" }, { ticket: "T-r2" }]);
  assert.deepEqual(result.groups[0]?.evidenceIds, ["run:r1"]);
});

test("ten-thousand-run aggregation remains bounded without dropping totals or coverage", () => {
  const runs = Array.from({ length: 10_000 }, (_, index) => summary(`scale-${index + 1}`, 1));
  const result = aggregateManagerRuns(runs, { version: 1, metrics: ["activeExecutionMs"], operations: ["sum", "count", "p90"] });
  assert.equal(result.matchedRunCount, 10_000);
  assert.equal(result.groups[0]?.values.activeExecutionMs?.sum, 10_000);
  assert.equal(result.groups[0]?.coverage.activeExecutionMs?.coveredRuns, 10_000);
  assert.equal(result.groups[0]?.evidenceIds.length, 100);
  assert.equal(result.groups[0]?.omittedEvidenceCount, 9_900);
});

test("evidence request parser permits only the fixed read-only protocol", () => {
  assert.ok(parseManagerEvidenceRequest(JSON.stringify({ version: 1, requestId: "q1", operations: [{ kind: "get_run_details", runIds: ["r1"] }] })));
  assert.equal(parseManagerEvidenceRequest(JSON.stringify({ version: 1, requestId: "q2", operations: [{ kind: "aggregate_runs", query: { version: 1, metrics: [], operations: [], sql: "drop table" } }] })), undefined);
  assert.equal(parseManagerEvidenceRequest(JSON.stringify({ version: 1, requestId: "q3", operations: [{ kind: "shell", command: "git status" }] })), undefined);
});

test("conversational run references use creation order, completion time, and retained antecedents", () => {
  const runs = [summary("r1", 10), summary("r2", 20), summary("r3", 30), summary("r4", 40), summary("r5", 50), summary("r6", 60)];
  runs[0]!.createdAt = "2026-01-01T00:00:00Z"; runs[1]!.createdAt = "2026-01-02T00:00:00Z"; runs[2]!.createdAt = "2026-01-03T00:00:00Z";
  assert.deepEqual(resolveManagerQuestionRuns(runs, "the previous run", "r3"), { focusRunId: "r2", referencedRunIds: ["r2"] });
  assert.equal(resolveManagerQuestionRuns(runs, "what about that run?", "r3", ["r1"]).focusRunId, "r1");
  assert.equal(resolveManagerQuestionRuns(runs, "compare the last five successful runs", "r6").referencedRunIds.length, 5);
});

test("V1 observability migration is idempotent and backfills a permanent partial summary", () => {
  const root = temp();
  try {
    const path = join(root, OBSERVABILITY_DB_FILE);
    const first = new ObservabilityStore(root); first.close();
    const db = new Database(path);
    db.prepare("UPDATE observability_meta SET value='1' WHERE key='schema_version'").run();
    db.prepare("DELETE FROM run_summaries").run();
    db.prepare(`INSERT INTO run_rollups(run_id,status,created_at,completed_at,calendar_ms,active_execution_ms,explicit_wait_ms,attributed_ms,unattributed_ms,totals_json) VALUES('legacy','completed','2025-01-01T00:00:00Z','2025-01-01T00:01:00Z',60000,50000,0,40000,10000,'{}')`).run();
    db.close();
    const migrated = new ObservabilityStore(root); migrated.close();
    const again = new ObservabilityStore(root); again.close();
    const reader = new ObservabilityReader(root);
    assert.equal(reader.schemaVersion(), 2);
    const summaries = reader.runSummaries({ runIds: ["legacy"] });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.detailLevel, "rollup");
    assert.equal(summaries[0]?.metricCoverage.usage, "unavailable");
    reader.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project collection identifies stale recovery state and produces a bounded valid packet", () => {
  const root = temp();
  try {
    const old = new Date("2026-01-01T00:00:00.000Z");
    const run = createBuildRun({ runId: "stale-run", tickets: ["T1"], repositoryRoot: root, now: old, builder: { role: "builder", source: "project", make: "codex", model: "default", reasoning: "high", fast: false } });
    assert.equal(run.status, "running");
    const collection = collectManagerProjectDiagnostics(root, { now: new Date("2026-01-02T00:00:00.000Z") });
    assert.equal(collection.report.verifiedActiveRunId, undefined);
    assert.deepEqual(collection.report.staleRecoveryRunIds, ["stale-run"]);
    const bloated = { ...collection.report, runCatalog: Array.from({ length: 200 }, (_, index) => ({ ...collection.report.runCatalog[0]!, runId: `run-${index}`, digest: `digest-${index}`, topOperations: [{ kind: "tool", name: "x".repeat(1000), durationMs: index, evidenceId: `e-${index}` }] })), totalRunCount: 200 };
    const packet = buildManagerProjectPacket(bloated, "compare all runs");
    assert.ok(Buffer.byteLength(packet.prompt) <= MANAGER_PACKET_MAX_BYTES);
    assert.doesNotThrow(() => JSON.parse(packet.prompt.slice(packet.prompt.indexOf("EVIDENCE PACKET:\n") + "EVIDENCE PACKET:\n".length)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project collection exits actionably when no build runs exist", () => {
  const root = temp();
  try { assert.throws(() => collectManagerProjectDiagnostics(root), /no build runs found.*rafi start/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
