import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertBuilderQaRemediationReport,
  assertQaFailureReport,
  validateBuilderQaRemediationReport,
  validateQaFailureReport,
  parseStrictJson,
  validateBuilderFindingCoverage,
  type BuilderQaRemediationReportV2,
  type QaFailureReportV1,
  type QaFindingRefV2,
  type QaResult,
  type BuilderQaHandoff,
} from "../src/index.js";

const report: QaFailureReportV1 = {
  version: 1,
  summary: "One blocking problem",
  checks_run: [{ check: "unit tests", command: "pnpm test", outcome: "failed", evidence: "one assertion failed" }],
  findings: [{
    id: "QA-1", requirement: "empty input is supported", locations: ["src/input.ts:9"],
    problem: "empty input throws", evidence: "test output shows TypeError", expected: "empty input returns []",
    fix_direction: "handle empty arrays before indexing", verification: ["run the empty-input unit test"],
  }],
  observations: ["The neighboring success path is covered"],
};

test("validates and asserts a V1 QA failure report", () => {
  assert.deepEqual(validateQaFailureReport(report), { valid: true, errors: [] });
  assert.doesNotThrow(() => assertQaFailureReport(report));
});

test("rejects malformed, empty, oversized, duplicate-id, unknown, mistyped, and duplicate-key reports", () => {
  assert.throws(() => parseStrictJson("{"));
  assert.equal(validateQaFailureReport({ ...report, findings: [] }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, summary: "x".repeat(4097) }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, findings: [report.findings[0], report.findings[0]] }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, extra: true }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, version: "1" }).valid, false);
  const duplicate = JSON.stringify(report).replace('"version":1', '"version":1,"version":1');
  assert.throws(() => parseStrictJson(duplicate), /duplicate field/);
});

test("enforces every collection and nested-collection limit at its exact boundary", () => {
  const stringBoundary = { ...report, summary: "x".repeat(4096) };
  assert.equal(validateQaFailureReport(stringBoundary).valid, true);
  const checks = Array.from({ length: 25 }, (_, index) => ({ check: `check ${index}`, outcome: "passed" as const, evidence: "ok" }));
  const findings = Array.from({ length: 25 }, (_, index) => ({ ...report.findings[0]!, id: `QA-${index}`, locations: Array.from({ length: 10 }, (_, at) => `src/${index}:${at}`), verification: Array.from({ length: 10 }, (_, at) => `verify ${at}`) }));
  assert.equal(validateQaFailureReport({ ...report, checks_run: checks, findings, observations: Array.from({ length: 25 }, (_, index) => `note ${index}`) }).valid, true);
  assert.equal(validateQaFailureReport({ ...report, checks_run: [...checks, checks[0]!] }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, findings: [...findings, { ...findings[0]!, id: "QA-extra" }] }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, observations: Array.from({ length: 26 }, (_, index) => `note ${index}`) }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, findings: [{ ...report.findings[0]!, locations: Array.from({ length: 11 }, (_, index) => `src:${index}`) }] }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, findings: [{ ...report.findings[0]!, verification: Array.from({ length: 11 }, (_, index) => `verify ${index}`) }] }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, checks_run: [] }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, findings: [{ ...report.findings[0]!, locations: [] }] }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, findings: [{ ...report.findings[0]!, verification: [] }] }).valid, false);
});

test("enforces the 4 KiB boundary for every report string position", () => {
  const boundary = "x".repeat(4096);
  const tooLong = `${boundary}x`;
  const replacements: Array<(value: string) => QaFailureReportV1> = [
    (value) => ({ ...report, summary: value }),
    (value) => ({ ...report, checks_run: [{ ...report.checks_run[0]!, check: value }] }),
    (value) => ({ ...report, checks_run: [{ ...report.checks_run[0]!, command: value }] }),
    (value) => ({ ...report, checks_run: [{ ...report.checks_run[0]!, evidence: value }] }),
    (value) => ({ ...report, findings: [{ ...report.findings[0]!, id: value }] }),
    (value) => ({ ...report, findings: [{ ...report.findings[0]!, requirement: value }] }),
    (value) => ({ ...report, findings: [{ ...report.findings[0]!, locations: [value] }] }),
    (value) => ({ ...report, findings: [{ ...report.findings[0]!, problem: value }] }),
    (value) => ({ ...report, findings: [{ ...report.findings[0]!, evidence: value }] }),
    (value) => ({ ...report, findings: [{ ...report.findings[0]!, expected: value }] }),
    (value) => ({ ...report, findings: [{ ...report.findings[0]!, fix_direction: value }] }),
    (value) => ({ ...report, findings: [{ ...report.findings[0]!, verification: [value] }] }),
    (value) => ({ ...report, observations: [value] }),
  ];
  for (const replace of replacements) {
    assert.equal(validateQaFailureReport(replace(boundary)).valid, true);
    assert.equal(validateQaFailureReport(replace(tooLong)).valid, false);
  }
});

const findingRefs: QaFindingRefV2[] = [{
  version: 2,
  findingKey: "finding-key-1",
  reportDigest: "report-digest",
  reviewAttemptId: "review-1",
  ordinal: 0,
  rawId: "QA-1",
}];

const builderReport: BuilderQaRemediationReportV2 = {
  version: 2,
  handoff_id: "handoff-1",
  summary: "Fixed the empty input handling.",
  findings: [{
    finding_key: "finding-key-1",
    raw_id: "QA-1",
    disposition: "fixed",
    changes: ["Added an explicit empty input guard."],
    evidence: "src/input.ts now returns [] for empty arrays.",
    verification: [{ check: "empty input unit test", outcome: "passed", evidence: "pnpm test passed" }],
  }],
  observations: [],
};

test("validates native Builder remediation objects and exact finding coverage", () => {
  assert.deepEqual(validateBuilderQaRemediationReport(builderReport), { valid: true, errors: [] });
  assert.doesNotThrow(() => assertBuilderQaRemediationReport(builderReport));
  assert.deepEqual(validateBuilderFindingCoverage(builderReport, findingRefs), []);
  assert.match(validateBuilderFindingCoverage({ ...builderReport, findings: [] }, findingRefs).join(" "), /missing finding_key/);
});

test("legacy QA compatibility interfaces retain their published shapes", () => {
  const result = { outcome: "approve", findings: [] } satisfies QaResult;
  const handoff = { ticket: "T1", requirements: ["works"], builderResult: "done", worktree: "/tmp/work", diffSummary: "one file", tests: ["test"], evidence: ["pass"] } satisfies BuilderQaHandoff;
  assert.equal(result.outcome, "approve");
  assert.equal(handoff.ticket, "T1");
});
