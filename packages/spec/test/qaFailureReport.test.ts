import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILDER_QA_REMEDIATION_END,
  BUILDER_QA_REMEDIATION_START,
  QA_FAILURE_REPORT_END,
  QA_FAILURE_REPORT_START,
  assertBuilderQaRemediationReport,
  assertQaFailureReport,
  parseBuilderQaRemediationContract,
  parseBuilderQaRemediationReport,
  parseQaFailureReport,
  parseQaResponseContract,
  validateBuilderQaRemediationReport,
  validateQaFailureReport,
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

const response = (body = JSON.stringify(report, null, 2), issues = "empty input throws") =>
  `${QA_FAILURE_REPORT_START}\n${body}\n${QA_FAILURE_REPORT_END}\nSTEP_STATUS: qa_fail | issues="${issues}"`;

test("validates and asserts a V1 QA failure report", () => {
  assert.deepEqual(validateQaFailureReport(report), { valid: true, errors: [] });
  assert.doesNotThrow(() => assertQaFailureReport(report));
});

test("parses indented and optionally fenced report JSON", () => {
  assert.deepEqual(parseQaFailureReport(JSON.stringify(report, null, 2)).report, report);
  assert.deepEqual(parseQaFailureReport(`\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``).report, report);
});

test("rejects malformed, empty, oversized, duplicate-id, unknown, mistyped, and duplicate-key reports", () => {
  assert.equal(parseQaFailureReport("{").validation.valid, false);
  assert.equal(validateQaFailureReport({ ...report, findings: [] }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, summary: "x".repeat(4097) }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, findings: [report.findings[0], report.findings[0]] }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, extra: true }).valid, false);
  assert.equal(validateQaFailureReport({ ...report, version: "1" }).valid, false);
  const duplicate = JSON.stringify(report).replace('"version":1', '"version":1,"version":1');
  assert.match(parseQaFailureReport(duplicate).validation.errors.join(" "), /duplicate field/);
});

test("accepts semantically valid QA report fields in any JSON object order", () => {
  const reordered = JSON.stringify({ summary: report.summary, version: 1, checks_run: report.checks_run, findings: report.findings, observations: [] });
  assert.equal(parseQaFailureReport(reordered).validation.valid, true);
});

test("parses response atomically and ignores marker-like JSON strings", () => {
  const nested = structuredClone(report);
  nested.findings[0]!.evidence = "literal STEP_STATUS: qa_pass text is not a marker";
  const parsed = parseQaResponseContract(response(JSON.stringify(nested, null, 2)));
  assert.equal(parsed.valid, true, parsed.errors.join("; "));
  assert.equal(parsed.status, "qa_fail");
  assert.equal(parsed.report?.findings[0]?.id, "QA-1");
});

test("enforces status/report contradictions and continuity ordering", () => {
  assert.equal(parseQaResponseContract('STEP_STATUS: qa_fail | issues="x"').valid, false);
  assert.equal(parseQaResponseContract(`${response()}\nSTEP_STATUS: qa_pass`).valid, false);
  assert.equal(parseQaResponseContract(`${QA_FAILURE_REPORT_START}\n${JSON.stringify(report)}\n${QA_FAILURE_REPORT_END}\nSTEP_STATUS: qa_pass`).valid, false);
  assert.equal(parseQaResponseContract(`${QA_FAILURE_REPORT_START}\n${JSON.stringify(report)}\n${QA_FAILURE_REPORT_END}\nSTEP_STATUS: blocked | reason="dependency"`).valid, false);
  assert.equal(parseQaResponseContract(`${QA_FAILURE_REPORT_START}\n${JSON.stringify(report)}\n${QA_FAILURE_REPORT_END}\nSTEP_STATUS: needs_input | question="choose" choices="a,b"`).valid, false);
  assert.equal(parseQaResponseContract(response(), { continuityRequired: true }).valid, false);
  assert.equal(parseQaResponseContract(`RAFI_CONTINUITY_DELTA {"summary":"reviewed"}\n${response()}`, { continuityRequired: true }).valid, true);
  assert.equal(parseQaResponseContract(`${response()}\nRAFI_CONTINUITY_DELTA {"summary":"late"}`, { continuityRequired: true }).valid, false);
});

test("accepts an absent qa_fail synopsis but exposes only a nonempty one", () => {
  const parsed = parseQaResponseContract(response(JSON.stringify(report), ""));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.fields.issues, "");
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

test("enforces the raw 64 KiB report boundary exactly", () => {
  const json = JSON.stringify(report);
  const exact = `${json}${" ".repeat(64 * 1024 - Buffer.byteLength(json))}`;
  assert.equal(Buffer.byteLength(exact), 64 * 1024);
  assert.equal(parseQaFailureReport(exact).validation.valid, true);
  assert.match(parseQaFailureReport(`${exact} `).validation.errors.join(" "), /exceeds 65536 bytes/);
  assert.match(parseQaFailureReport(`\`\`\`json\n${exact}\n\`\`\``).validation.errors.join(" "), /exceeds 65536 bytes/);
  assert.match(parseQaFailureReport(`\`\`\`json\n${exact} \n\`\`\``).validation.errors.join(" "), /exceeds 65536 bytes/);
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

const builderResponse = (body = JSON.stringify(builderReport, null, 2), status = 'STEP_STATUS: done | summary="fixed"') =>
  `${BUILDER_QA_REMEDIATION_START}\n${body}\n${BUILDER_QA_REMEDIATION_END}\n${status}`;

test("validates and parses Builder QA remediation reports", () => {
  assert.deepEqual(validateBuilderQaRemediationReport(builderReport), { valid: true, errors: [] });
  assert.doesNotThrow(() => assertBuilderQaRemediationReport(builderReport));
  assert.deepEqual(parseBuilderQaRemediationReport(JSON.stringify(builderReport)).report, builderReport);
  const parsed = parseBuilderQaRemediationContract(builderResponse(), { handoffId: "handoff-1", findings: findingRefs });
  assert.equal(parsed.valid, true, parsed.errors.join("; "));
  assert.equal(parsed.status, "done");
  assert.equal(parsed.report?.findings[0]?.finding_key, "finding-key-1");
});

test("Builder remediation contract rejects ambiguous or incomplete successful responses", () => {
  assert.equal(parseBuilderQaRemediationContract('STEP_STATUS: done | summary="x"', { handoffId: "handoff-1", findings: findingRefs }).valid, false);
  assert.equal(parseBuilderQaRemediationContract(`${builderResponse()}\nSTEP_STATUS: done`).valid, false);
  assert.equal(parseBuilderQaRemediationContract(builderResponse(JSON.stringify({ ...builderReport, extra: true }))).valid, false);
  assert.equal(parseBuilderQaRemediationContract(builderResponse(JSON.stringify({ ...builderReport, handoff_id: "wrong" })), { handoffId: "handoff-1", findings: findingRefs }).valid, false);
  assert.equal(parseBuilderQaRemediationContract(builderResponse(JSON.stringify({ ...builderReport, findings: [] })), { handoffId: "handoff-1", findings: findingRefs }).valid, false);
  assert.equal(parseBuilderQaRemediationContract(builderResponse(JSON.stringify({ ...builderReport, findings: [{ ...builderReport.findings[0]!, finding_key: "unknown" }] })), { handoffId: "handoff-1", findings: findingRefs }).valid, false);
  assert.equal(parseBuilderQaRemediationContract(builderResponse(JSON.stringify({ ...builderReport, findings: [{ ...builderReport.findings[0]!, raw_id: "wrong" }] })), { handoffId: "handoff-1", findings: findingRefs }).valid, false);
  assert.equal(parseBuilderQaRemediationContract(builderResponse(JSON.stringify(builderReport), 'STEP_STATUS: blocked | reason="stuck"')).valid, false);
  assert.equal(parseBuilderQaRemediationContract(`extra\n${builderResponse()}`).valid, false);
});

test("Builder remediation parser enforces exact raw byte boundary and duplicate keys", () => {
  const json = JSON.stringify(builderReport);
  const exact = `${json}${" ".repeat(128 * 1024 - Buffer.byteLength(json))}`;
  assert.equal(parseBuilderQaRemediationReport(exact).validation.valid, true);
  assert.match(parseBuilderQaRemediationReport(`${exact} `).validation.errors.join(" "), /exceeds 131072 bytes/);
  const duplicate = JSON.stringify(builderReport).replace('"version":2', '"version":2,"version":2');
  assert.match(parseBuilderQaRemediationReport(duplicate).validation.errors.join(" "), /duplicate field/);
});

test("legacy QA compatibility interfaces retain their published shapes", () => {
  const result = { outcome: "approve", findings: [] } satisfies QaResult;
  const handoff = { ticket: "T1", requirements: ["works"], builderResult: "done", worktree: "/tmp/work", diffSummary: "one file", tests: ["test"], evidence: ["pass"] } satisfies BuilderQaHandoff;
  assert.equal(result.outcome, "approve");
  assert.equal(handoff.ticket, "T1");
});
