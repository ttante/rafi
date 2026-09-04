import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createBuildRun } from "../src/buildRuns.js";
import { collectManagerDiagnostics, unionDuration } from "../src/diagnostics.js";
import { buildManagerPacket, MANAGER_PACKET_MAX_BYTES } from "../src/managerPacket.js";
import { ManagerSessionRecorder, OBSERVABILITY_DB_FILE, ObservabilityReader, ObservabilityStore, RunObserver, sanitizeDiagnosticValue } from "../src/observability.js";

function temp(): string { return mkdtempSync(join(tmpdir(), "rafi-observability-")); }

test("read-only observability construction causes zero filesystem changes", () => {
  const root = temp();
  try {
    const before = statSync(root).mtimeMs;
    const reader = new ObservabilityReader(root);
    assert.equal(reader.available(), false);
    reader.close();
    assert.equal(existsSync(join(root, ".rafi")), false);
    assert.equal(statSync(root).mtimeMs, before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Manager session accounting neither creates nor migrates observability storage", () => {
  const root = temp();
  try {
    const absent = new ManagerSessionRecorder(root);
    absent.record({ sessionId: "none", runId: "run", startedAt: new Date(0).toISOString(), scope: "project" });
    absent.close();
    assert.equal(existsSync(join(root, ".rafi")), false);
    mkdirSync(join(root, ".rafi"), { recursive: true });
    const path = join(root, OBSERVABILITY_DB_FILE);
    const db = new Database(path);
    db.exec("CREATE TABLE observability_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO observability_meta VALUES('schema_version','1'); CREATE TABLE manager_sessions(session_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,provider TEXT,started_at TEXT NOT NULL,ended_at TEXT,outcome TEXT,report_digest TEXT,input_tokens INTEGER,output_tokens INTEGER,cost_usd REAL,error_code TEXT);");
    db.close();
    const recorder = new ManagerSessionRecorder(root);
    recorder.record({ sessionId: "legacy", runId: "run", startedAt: new Date(0).toISOString(), scope: "project", projectReportDigest: "ignored-by-v1" });
    recorder.close();
    const verify = new Database(path, { readonly: true });
    assert.equal((verify.prepare("SELECT value FROM observability_meta WHERE key='schema_version'").get() as { value: string }).value, "1");
    assert.equal((verify.prepare("SELECT COUNT(*) count FROM manager_sessions").get() as { count: number }).count, 1);
    assert.equal((verify.prepare("PRAGMA table_info(manager_sessions)").all() as Array<{ name: string }>).some(item => item.name === "scope"), false);
    verify.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spans use monotonic duration through wall clock rollback and current state coalesces", () => {
  const root = temp();
  let wall = new Date("2026-01-01T00:00:10.000Z");
  let mono = 1000;
  try {
    const store = new ObservabilityStore(root, { now: () => wall, monotonicNow: () => mono });
    const observer = new RunObserver(store, "run-1");
    const parent = store.startSpan({ runId: "run-1", executionId: observer.executionId }, { kind: "builder_work", name: "build" });
    mono += 125;
    wall = new Date("2026-01-01T00:00:00.000Z");
    store.finishSpan(parent, { outcome: "completed" });
    store.updateCurrentState({ runId: "run-1", role: "builder", stream: "builder", phase: "one" });
    store.updateCurrentState({ runId: "run-1", role: "builder", stream: "builder", phase: "two" });
    store.close();
    const reader = new ObservabilityReader(root);
    assert.equal(reader.spans("run-1")[0]?.durationMs, 125);
    assert.deepEqual(reader.currentState("run-1").map(item => item.phase), ["two"]);
    reader.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("metric samples are minute-bucketed and boundary samples remain distinct", () => {
  const root = temp();
  let wall = new Date("2026-01-01T00:00:00.000Z");
  try {
    const store = new ObservabilityStore(root, { now: () => wall });
    const context = { runId: "run-2", role: "builder" as const, stream: "builder" };
    for (let seconds = 0; seconds < 60; seconds += 10) { wall = new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1000); store.recordMetric(context, "context", seconds); }
    store.recordMetric(context, "context", 99, { boundary: true });
    store.close();
    const db = new Database(join(root, OBSERVABILITY_DB_FILE), { readonly: true });
    assert.equal((db.prepare("SELECT COUNT(*) count FROM metric_samples").get() as { count: number }).count, 2);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("interval unions do not double-count overlaps", () => {
  assert.equal(unionDuration([[0, 100], [20, 40], [80, 140], [200, 220]]), 160);
});

test("diagnostic collector ranks measured work and exposes capability gaps", () => {
  const root = temp();
  const start = new Date("2026-01-01T00:00:00.000Z");
  let wall = new Date(start);
  let mono = 0;
  try {
    const run = createBuildRun({ runId: "diagnostic-run", tickets: ["T001"], repositoryRoot: root, now: start,
      builder: { role: "builder", source: "project", make: "codex", model: "default", reasoning: "high", fast: false } });
    const store = new ObservabilityStore(root, { now: () => wall, monotonicNow: () => mono });
    const observer = new RunObserver(store, run.runId);
    const build = store.startSpan({ runId: run.runId, executionId: observer.executionId, role: "builder", stream: "builder" }, { kind: "builder_work", name: "implementation" });
    mono = 120_000; wall = new Date(start.getTime() + mono);
    store.finishSpan(build, { outcome: "completed" });
    const qa = store.startSpan({ runId: run.runId, executionId: observer.executionId, role: "qa", stream: "qa" }, { kind: "qa_attempt", name: "review" });
    mono = 150_000; wall = new Date(start.getTime() + mono);
    store.finishSpan(qa, { outcome: "failed" });
    observer.finish("completed", { branchMode: "current", qaEnabled: true, primaryProvider: "codex", ticketCount: 1, createdAt: start.toISOString(), completedAt: wall.toISOString() });
    store.close();
    const report = collectManagerDiagnostics(root, { runId: run.runId, now: wall, external: "off", commandRunner: () => ({ ok: false, stdout: "", stderr: "not a git repository" }) });
    assert.equal(report.timing.topContributors[0]?.kind, "builder_work");
    assert.equal(report.timing.exclusiveByKind.builder_work, 120_000);
    assert.ok(report.findings.some(item => item.code === "largest_contributors"));
    assert.equal(report.capabilities.sources.external?.state, "not_applicable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Manager packets are bounded and omit raw payload excess deterministically", () => {
  const report = {
    version: 1 as const, observabilitySchemaVersion: 1 as const, generatedAt: new Date(0).toISOString(), runId: "r", runStatus: "running", legacy: false,
    capabilities: { version: 1 as const, sources: {} }, currentState: [],
    timing: { calendarAgeMs: 0, activeExecutionMs: 0, pausedOfflineMs: 0, explicitWaitMs: 0, attributedMs: 0, unattributedMs: 0, byKind: {}, inclusiveByKind: {}, exclusiveByKind: {}, observedRetryMs: 0, reportedRetryDelayMs: 0, topContributors: [] },
    counts: { qaAttempts: 0, qaFailures: 0, fixes: 0, retries: 0, waits: 0 }, findings: [],
    evidence: Array.from({ length: 200 }, (_, index) => ({ evidenceId: String(index), source: "test", kind: "large", summary: "x".repeat(2000) })),
    detail: { spans: [], omittedSpans: 0 }, digest: "digest",
  };
  const packet = buildManagerPacket(report, "why slow?");
  assert.ok(Buffer.byteLength(packet.prompt) <= MANAGER_PACKET_MAX_BYTES);
});

test("diagnostic sanitization removes common secret forms and transcript fields", () => {
  const value = sanitizeDiagnosticValue({ token: "secret", message: "password=hunter2 https://me:pass@example.test", transcript: "private" }) as Record<string, unknown>;
  assert.equal(value.token, undefined);
  assert.equal(value.transcript, undefined);
  assert.doesNotMatch(String(value.message), /hunter2|me:pass/);
});

test("permanent summaries honor usage counter scope and survive detail pruning", () => {
  const root = temp();
  let wall = new Date("2025-01-01T00:00:00.000Z");
  try {
    const store = new ObservabilityStore(root, { now: () => wall, config: { detail_retention_days: 30 } });
    const first = store.startSpan({ runId: "usage-run", providerSessionId: "session-a" }, { kind: "provider_turn", name: "turn one" });
    wall = new Date("2025-01-01T00:00:01.000Z");
    store.finishSpan(first, { outcome: "completed", attributes: { usage: { scope: "turn-delta", inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
    const second = store.startSpan({ runId: "usage-run", providerSessionId: "session-a" }, { kind: "provider_turn", name: "turn two" });
    wall = new Date("2025-01-01T00:00:02.000Z");
    store.finishSpan(second, { outcome: "completed", attributes: { usage: { scope: "turn-delta", inputTokens: 7, outputTokens: 3, totalTokens: 10 } } });
    store.finalizeRun("usage-run", { status: "completed", primaryProvider: "codex", model: "test", ticketIds: ["T1"], createdAt: "2025-01-01T00:00:00.000Z", completedAt: wall.toISOString() });
    wall = new Date("2025-03-01T00:00:00.000Z");
    store.enforceLimits();
    store.close();
    const reader = new ObservabilityReader(root);
    assert.equal(reader.spans("usage-run").length, 0);
    const summary = reader.runSummaries({ runIds: ["usage-run"] })[0]!;
    assert.equal(summary.usage.scope, "turn-deltas");
    assert.equal(summary.usage.inputTokens, 17);
    assert.equal(summary.usage.outputTokens, 8);
    assert.equal(summary.usage.totalTokens, 25);
    assert.equal(summary.usage.authoritativeCostUsd, undefined);
    assert.deepEqual(summary.ticketIds, ["T1"]);
    assert.equal(summary.detailLevel, "rollup");
    reader.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("log retention compresses and deletes only indexed terminal logs", () => {
  const root = temp();
  let wall = new Date("2026-01-01T00:00:00.000Z");
  try {
    const logs = join(root, ".foreman");
    mkdirSync(logs, { recursive: true });
    const owned = join(logs, "owned.jsonl");
    const unindexed = join(logs, "legacy.jsonl");
    writeFileSync(owned, `${JSON.stringify({ event: "done" })}\n`);
    writeFileSync(unindexed, `${JSON.stringify({ event: "legacy" })}\n`);
    const store = new ObservabilityStore(root, { now: () => wall, config: { log_retention_days: 30 } });
    store.indexLogFile(owned, "run-logs");
    store.closeLogFile(owned, "completed");
    wall = new Date("2026-01-03T00:00:00.000Z");
    assert.equal(store.maintainLogs(root).compressed, 1);
    assert.equal(existsSync(`${owned}.gz`), true);
    assert.equal(existsSync(unindexed), true);
    wall = new Date("2026-02-02T00:00:00.000Z");
    assert.equal(store.maintainLogs(root).deleted, 1);
    assert.equal(existsSync(`${owned}.gz`), false);
    assert.equal(existsSync(unindexed), true);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
