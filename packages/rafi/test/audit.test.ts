import { test } from "node:test";
import assert from "node:assert/strict";
import { assessAuditHealth, renderAuditReport, type AuditReport } from "../src/audit.js";
import type { ManagerDiagnosticReportV1 } from "rafi-spec";

function report(overrides: Partial<ManagerDiagnosticReportV1> = {}): ManagerDiagnosticReportV1 {
  return {
    version: 1,
    observabilitySchemaVersion: 2,
    generatedAt: "2026-10-20T00:00:00.000Z",
    runId: "run-1",
    runStatus: "completed",
    legacy: false,
    capabilities: { version: 1, sources: { observability: { source: "observability", state: "available", observedAt: "2026-10-20T00:00:00.000Z" } } },
    currentState: [],
    timing: { calendarAgeMs: 10, activeExecutionMs: 10, pausedOfflineMs: 0, explicitWaitMs: 0, attributedMs: 10, unattributedMs: 0, byKind: {}, inclusiveByKind: {}, exclusiveByKind: {}, observedRetryMs: 0, reportedRetryDelayMs: 0, topContributors: [] },
    counts: { qaAttempts: 1, qaFailures: 0, fixes: 0, retries: 0, waits: 0 },
    findings: [],
    evidence: [],
    detail: { spans: [], omittedSpans: 0 },
    digest: "digest",
    ...overrides,
  };
}

test("audit health reports complete when canonical diagnostics are intact", () => {
  assert.deepEqual(assessAuditHealth(report(), []), { status: "complete", reasons: [] });
});

test("audit health reports partial without turning optional gaps into build failure", () => {
  const result = assessAuditHealth(report({ legacy: true, detail: { spans: [], omittedSpans: 2 } }), []);
  assert.equal(result.status, "partial");
  assert.match(result.reasons.join(" "), /predates|omitted/);
});

test("audit health reports corrupt span invariants", () => {
  const result = assessAuditHealth(report(), [
    { version: 1, spanId: "span", runId: "run-1", parentSpanId: "missing", kind: "phase", name: "phase", startedAt: "2026-10-20T00:00:01.000Z", endedAt: "2026-10-20T00:00:00.000Z", durationMs: -1, completionKnown: true },
  ]);
  assert.equal(result.status, "corrupt");
  assert.ok(result.reasons.length >= 2);
});

test("audit health blocks terminal QA runs without required host evidence", () => {
  const result = assessAuditHealth(report(), [], { required: true, availability: "missing", gaps: ["workflow database is missing"] });
  assert.equal(result.status, "blocked");
  assert.match(result.reasons.join(" "), /required QA evidence|workflow database/);
});

test("audit health rejects malformed timestamps", () => {
  const result = assessAuditHealth(report(), [{ version: 1, spanId: "span", runId: "run-1", kind: "phase", name: "phase", startedAt: "not-a-date", completionKnown: true }]);
  assert.equal(result.status, "corrupt");
  assert.match(result.reasons.join(" "), /invalid start timestamp/);
});

test("audit export is bounded and exposes health separately from build status", () => {
  const audit: AuditReport = { version: 1, generatedAt: "2026-10-20T00:00:00.000Z", selectedRun: { runId: "run-1", selection: "latest" }, logging: { schemaVersion: 2, summaryOnly: false, sources: {} }, evidence: { availability: "present", gaps: [], required: false }, health: { status: "partial", reasons: ["trace budget exhausted"] }, report: report({ runStatus: "completed" }) };
  const markdown = renderAuditReport(audit, "markdown");
  assert.match(markdown, /Build status: completed/);
  assert.match(markdown, /Audit health: \*\*partial\*\*/);
  const json = JSON.parse(renderAuditReport(audit, "json")) as AuditReport;
  assert.equal(json.health.status, "partial");
  assert.equal(json.report.runStatus, "completed");
});

test("audit export keeps oversized Markdown and JSON within the byte budget", () => {
  const audit: AuditReport = { version: 1, generatedAt: "2026-10-20T00:00:00.000Z", selectedRun: { runId: "run-1", selection: "latest" }, logging: { schemaVersion: 2, summaryOnly: false, sources: {} }, evidence: { availability: "present", gaps: [], required: false }, health: { status: "partial", reasons: ["x".repeat(500_000)] }, report: report({ findings: Array.from({ length: 100 }, () => ({ code: "large", title: "x".repeat(10_000), summary: "y".repeat(10_000), confidence: "limited", evidenceIds: [] })) }) };
  assert.ok(Buffer.byteLength(renderAuditReport(audit, "markdown"), "utf8") <= 256 * 1024);
  const json = renderAuditReport(audit, "json");
  assert.ok(Buffer.byteLength(json, "utf8") <= 256 * 1024);
  assert.doesNotThrow(() => JSON.parse(json));
});
