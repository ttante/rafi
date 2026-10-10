import type { BuilderQaRemediationReport, QaFailureReportV1, QaFindingRefV2 } from "./types.js";
import { validateBuilderQaRemediationReport, validateQaFailureReport, type ValidationResult } from "./validate.js";

export const QA_FAILURE_REPORT_START = "RAFI_QA_FAILURE_REPORT_START";
export const QA_FAILURE_REPORT_END = "RAFI_QA_FAILURE_REPORT_END";
export const QA_FAILURE_REPORT_MAX_BYTES = 64 * 1024;
export const BUILDER_QA_REMEDIATION_START = "RAFI_BUILDER_QA_REMEDIATION_START";
export const BUILDER_QA_REMEDIATION_END = "RAFI_BUILDER_QA_REMEDIATION_END";
export const BUILDER_QA_REMEDIATION_MAX_BYTES = 128 * 1024;

export interface ParsedQaFailureReport {
  report?: QaFailureReportV1;
  rawJson?: string;
  validation: ValidationResult;
}

export interface QaResponseContract {
  valid: boolean;
  errors: string[];
  status: "qa_pass" | "qa_fail" | "blocked" | "needs_input" | "unknown";
  fields: Record<string, string>;
  report?: QaFailureReportV1;
  rawReportJson?: string;
}

export interface ParsedBuilderQaRemediation {
  report?: BuilderQaRemediationReport;
  rawJson?: string;
  validation: ValidationResult;
}

export interface BuilderQaRemediationContract {
  valid: boolean;
  errors: string[];
  status: "done" | "blocked" | "needs_input" | "qa_pass" | "qa_fail" | "unknown";
  fields: Record<string, string>;
  report?: BuilderQaRemediationReport;
  rawReportJson?: string;
}

/** Parse and strictly validate the JSON body of one QA report envelope. */
export function parseQaFailureReport(input: string): ParsedQaFailureReport {
  // Enforce the boundary on the exact provider payload before trimming or
  // removing optional Markdown fences. A fence is transport syntax, not free
  // bytes outside the protocol limit.
  if (Buffer.byteLength(input, "utf8") > QA_FAILURE_REPORT_MAX_BYTES) return invalid(`serialized report exceeds ${QA_FAILURE_REPORT_MAX_BYTES} bytes`);
  const raw = unwrapFence(input);
  if (raw instanceof Error) return invalid(raw.message);
  let value: unknown;
  try {
    const scanned = scanJson(raw);
    value = scanned.value;
  } catch (error) {
    return invalid(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validation = validateQaFailureReport(value);
  const errors = validation.errors;
  return errors.length
    ? { rawJson: raw, validation: { valid: false, errors } }
    : { rawJson: raw, report: value as QaFailureReportV1, validation: { valid: true, errors: [] } };
}
export const parseQaFailureReportV1 = parseQaFailureReport;

/** Parse and strictly validate the JSON body of one Builder remediation envelope. */
export function parseBuilderQaRemediationReport(input: string): ParsedBuilderQaRemediation {
  if (Buffer.byteLength(input, "utf8") > BUILDER_QA_REMEDIATION_MAX_BYTES) return invalidBuilder(`serialized Builder QA remediation report exceeds ${BUILDER_QA_REMEDIATION_MAX_BYTES} bytes`);
  const raw = unwrapFence(input);
  if (raw instanceof Error) return invalidBuilder(raw.message);
  let value: unknown;
  try {
    const scanned = scanJson(raw);
    value = scanned.value;
  } catch (error) {
    return invalidBuilder(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validation = validateBuilderQaRemediationReport(value);
  return validation.valid
    ? { rawJson: raw, report: value as BuilderQaRemediationReport, validation: { valid: true, errors: [] } }
    : { rawJson: raw, validation };
}
export function parseBuilderQaRemediationReportV2(input: string): ParsedBuilderQaRemediation {
  const parsed = parseBuilderQaRemediationReport(input);
  return parsed.report && parsed.report.version !== 2 ? invalidBuilder("expected Builder remediation V2") : parsed;
}
export function parseBuilderQaRemediationReportV3(input: string): ParsedBuilderQaRemediation {
  const parsed = parseBuilderQaRemediationReport(input);
  return parsed.report && parsed.report.version !== 3 ? invalidBuilder("expected Builder remediation V3") : parsed;
}

export function parseBuilderQaRemediationContract(text: string, expected?: { handoffId?: string; findings?: QaFindingRefV2[] }): BuilderQaRemediationContract {
  if (Buffer.byteLength(text) > BUILDER_QA_REMEDIATION_MAX_BYTES + 4096) return { valid: false, errors: ["Builder response exceeds maximum bytes"], status: "unknown", fields: {} };
  const lines = text.split(/\r?\n/);
  const start = indexes(lines, BUILDER_QA_REMEDIATION_START);
  const end = indexes(lines, BUILDER_QA_REMEDIATION_END);
  const statusLines = lines.map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => /^STEP_STATUS:/.test(line));
  const errors: string[] = [];
  if (statusLines.length !== 1) errors.push(statusLines.length ? "multiple STEP_STATUS markers" : "missing STEP_STATUS marker");
  const finalNonempty = lines.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => line).at(-1);
  const statusLine = statusLines.at(-1);
  if (statusLine && finalNonempty?.index !== statusLine.index) errors.push("STEP_STATUS marker must be the final non-empty line");
  const parsedStatus = statusLine ? parseBuilderStatus(statusLine.line) : { status: "unknown" as const, fields: {}, error: undefined };
  if (parsedStatus.error) errors.push(parsedStatus.error);
  if (start.length !== end.length || start.length > 1) errors.push("Builder remediation requires exactly one ordered start/end marker pair");
  if (start.length === 1 && end.length === 1 && start[0]! >= end[0]!) errors.push("Builder remediation markers are out of order");
  if (end[0] !== undefined && statusLine && end[0] >= statusLine.index) errors.push("Builder remediation envelope must precede STEP_STATUS");
  const firstNonempty = lines.findIndex((line) => line.trim());
  if (start[0] !== undefined && firstNonempty !== start[0]) errors.push("Builder remediation envelope must be the first non-empty content");

  let report: BuilderQaRemediationReport | undefined;
  let rawReportJson: string | undefined;
  if (start.length === 1 && end.length === 1 && start[0]! < end[0]!) {
    const parsed = parseBuilderQaRemediationReport(lines.slice(start[0]! + 1, end[0]).join("\n"));
    errors.push(...parsed.validation.errors);
    report = parsed.report;
    rawReportJson = parsed.rawJson;
  }
  if (parsedStatus.status === "done" && start.length !== 1) errors.push("done requires one valid Builder remediation report");
  const partialBlocked = report?.version === 3 && report.findings.some(f => f.disposition === "blocked");
  if (parsedStatus.status !== "done" && start.length && !(parsedStatus.status === "blocked" && partialBlocked)) errors.push(`${parsedStatus.status} must not include a Builder remediation report`);
  if (partialBlocked && parsedStatus.status !== "blocked") errors.push("blocked findings require STEP_STATUS: blocked");
  if (report?.version === 3) for (const finding of report.findings) {
    if (finding.disposition === "blocked" && !finding.blocker) errors.push(`blocked finding ${finding.finding_key} requires a structured blocker`);
    if (finding.disposition !== "blocked" && finding.blocker) errors.push(`nonblocked finding ${finding.finding_key} must not contain a blocker`);
  }
  if (end[0] !== undefined && statusLine && lines.slice(end[0] + 1, statusLine.index).some(line => line.trim())) errors.push("unexpected content between remediation envelope and status");
  if (parsedStatus.status === "done" && !report && start.length === 1) errors.push("done Builder remediation report is invalid");
  if (report && expected?.handoffId && report.handoff_id !== expected.handoffId) errors.push(`handoff_id ${report.handoff_id} does not match expected ${expected.handoffId}`);
  if (report && expected?.findings) errors.push(...validateBuilderFindingCoverage(report, expected.findings));

  return { valid: errors.length === 0, errors: [...new Set(errors)], status: parsedStatus.status, fields: parsedStatus.fields, report, rawReportJson };
}

/** Validate the envelope and final status as a single, contradiction-free response. */
export function parseQaResponseContract(text: string, options: { continuityRequired?: boolean } = {}): QaResponseContract {
  const lines = text.split(/\r?\n/);
  const start = indexes(lines, QA_FAILURE_REPORT_START);
  const end = indexes(lines, QA_FAILURE_REPORT_END);
  const statusLines = lines.map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => /^STEP_STATUS:/.test(line));
  const continuityLines = lines.map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => /^RAFI_CONTINUITY_DELTA(?:\s|$)/.test(line));
  const errors: string[] = [];
  if (statusLines.length !== 1) errors.push(statusLines.length ? "multiple STEP_STATUS markers" : "missing STEP_STATUS marker");
  const finalNonempty = lines.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => line).at(-1);
  const statusLine = statusLines.at(-1);
  if (statusLine && finalNonempty?.index !== statusLine.index) errors.push("STEP_STATUS marker must be the final non-empty line");
  const parsedStatus = statusLine ? parseStatus(statusLine.line) : { status: "unknown" as const, fields: {}, error: undefined };
  if (parsedStatus.error) errors.push(parsedStatus.error);
  if (options.continuityRequired) {
    if (continuityLines.length !== 1) errors.push(continuityLines.length ? "multiple continuity markers" : "missing continuity marker");
    if (continuityLines[0] && start[0] !== undefined && continuityLines[0].index >= start[0]) errors.push("continuity marker must precede the failure report");
  }
  if (start.length !== end.length || start.length > 1) errors.push("failure report requires exactly one ordered start/end marker pair");
  if (start.length === 1 && end.length === 1 && start[0]! >= end[0]!) errors.push("failure report markers are out of order");
  if (end[0] !== undefined && statusLine && end[0] >= statusLine.index) errors.push("failure report must precede STEP_STATUS");

  let report: QaFailureReportV1 | undefined;
  let rawReportJson: string | undefined;
  if (start.length === 1 && end.length === 1 && start[0]! < end[0]!) {
    const parsed = parseQaFailureReport(lines.slice(start[0]! + 1, end[0]).join("\n"));
    errors.push(...parsed.validation.errors);
    report = parsed.report;
    rawReportJson = parsed.rawJson;
  }
  if (parsedStatus.status === "qa_fail" && start.length !== 1) errors.push("qa_fail requires one valid failure report");
  if (parsedStatus.status !== "qa_fail" && start.length) errors.push(`${parsedStatus.status} must not include a failure report`);
  if (parsedStatus.status === "qa_fail" && !report && start.length === 1) errors.push("qa_fail failure report is invalid");

  return { valid: errors.length === 0, errors: [...new Set(errors)], status: parsedStatus.status, fields: parsedStatus.fields, report, rawReportJson };
}

function invalid(message: string): ParsedQaFailureReport {
  return { validation: { valid: false, errors: [message] } };
}

function invalidBuilder(message: string): ParsedBuilderQaRemediation {
  return { validation: { valid: false, errors: [message] } };
}

function indexes(lines: string[], marker: string): number[] {
  return lines.flatMap((line, index) => line.trim() === marker ? [index] : []);
}

function unwrapFence(input: string): string | Error {
  // The size boundary applies to the exact JSON payload supplied by QA.  In
  // particular, do not trim the fenced body before byte accounting: JSON
  // whitespace is still provider output and must not be usable to bypass the
  // same limit imposed on an unfenced payload.
  const trimmed = input.trim();
  if (!trimmed.startsWith("```")) return input;
  const match = trimmed.match(/^```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```$/i);
  return match ? match[1]! : new Error("malformed or multiple JSON code fences in report envelope");
}

function parseStatus(line: string): { status: QaResponseContract["status"]; fields: Record<string, string>; error?: string } {
  const match = line.match(/^STEP_STATUS:\s*(qa_pass|qa_fail|blocked|needs_input)\b\s*(?:\|\s*(.*))?$/);
  if (!match) return { status: "unknown", fields: {}, error: "malformed or unsupported QA STEP_STATUS marker" };
  const fields: Record<string, string> = {};
  let rest = (match[2] ?? "").trim();
  while (rest) {
    const key = rest.match(/^(\w+)="/);
    if (!key) return { status: match[1] as QaResponseContract["status"], fields, error: `malformed STEP_STATUS field near: ${rest.slice(0, 40)}` };
    const name = key[1]!;
    let i = key[0].length, value = "", closed = false;
    for (; i < rest.length; i++) {
      if (rest[i] === "\\") { if (i + 1 >= rest.length) break; value += rest[++i]; continue; }
      if (rest[i] === '"') { closed = true; i++; break; }
      value += rest[i];
    }
    if (!closed) return { status: match[1] as QaResponseContract["status"], fields, error: `unterminated STEP_STATUS field: ${name}` };
    if (fields[name] !== undefined) return { status: match[1] as QaResponseContract["status"], fields, error: `duplicate STEP_STATUS field: ${name}` };
    fields[name] = value; rest = rest.slice(i).trim();
  }
  const allowed: Record<string, string[]> = { qa_pass: ["summary"], qa_fail: ["issues"], blocked: ["reason"], needs_input: ["question", "choices"] };
  const unknown = Object.keys(fields).filter((key) => !allowed[match[1]!]!.includes(key));
  return unknown.length
    ? { status: match[1] as QaResponseContract["status"], fields, error: `unknown STEP_STATUS field(s): ${unknown.join(", ")}` }
    : { status: match[1] as QaResponseContract["status"], fields };
}

function parseBuilderStatus(line: string): { status: BuilderQaRemediationContract["status"]; fields: Record<string, string>; error?: string } {
  const match = line.match(/^STEP_STATUS:\s*(done|blocked|needs_input|qa_pass|qa_fail)\b\s*(?:\|\s*(.*))?$/);
  if (!match) return { status: "unknown", fields: {}, error: "malformed or unsupported Builder QA remediation STEP_STATUS marker" };
  const fields: Record<string, string> = {};
  let rest = (match[2] ?? "").trim();
  while (rest) {
    const key = rest.match(/^(\w+)="/);
    if (!key) return { status: match[1] as BuilderQaRemediationContract["status"], fields, error: `malformed STEP_STATUS field near: ${rest.slice(0, 40)}` };
    const name = key[1]!;
    let i = key[0].length, value = "", closed = false;
    for (; i < rest.length; i++) {
      if (rest[i] === "\\") { if (i + 1 >= rest.length) break; value += rest[++i]; continue; }
      if (rest[i] === '"') { closed = true; i++; break; }
      value += rest[i];
    }
    if (!closed) return { status: match[1] as BuilderQaRemediationContract["status"], fields, error: `unterminated STEP_STATUS field: ${name}` };
    if (fields[name] !== undefined) return { status: match[1] as BuilderQaRemediationContract["status"], fields, error: `duplicate STEP_STATUS field: ${name}` };
    fields[name] = value; rest = rest.slice(i).trim();
  }
  if (match[1] === "blocked" || match[1] === "needs_input") {
    const required = match[1] === "blocked" ? "reason" : "question";
    const unknown = Object.keys(fields).filter(key => key !== required);
    return { status: match[1], fields, ...(!fields[required]?.trim() ? { error: `${match[1]} requires ${required}` } : unknown.length ? { error: `unknown STEP_STATUS field(s): ${unknown.join(", ")}` } : {}) };
  }
  if (match[1] !== "done") return { status: match[1] as BuilderQaRemediationContract["status"], fields, error: `${match[1]} is not a valid successful Builder QA remediation status` };
  const unknown = Object.keys(fields).filter((key) => key !== "summary");
  return unknown.length
    ? { status: "done", fields, error: `unknown STEP_STATUS field(s): ${unknown.join(", ")}` }
    : { status: "done", fields };
}

function validateBuilderFindingCoverage(report: BuilderQaRemediationReport, expected: QaFindingRefV2[]): string[] {
  const errors: string[] = [];
  const expectedByKey = new Map(expected.map((finding) => [finding.findingKey, finding]));
  const seen = new Set<string>();
  for (const finding of report.findings) {
    if (seen.has(finding.finding_key)) errors.push(`duplicate finding_key: ${finding.finding_key}`);
    seen.add(finding.finding_key);
    const reference = expectedByKey.get(finding.finding_key);
    if (!reference) errors.push(`unknown finding_key: ${finding.finding_key}`);
    else if (reference.rawId !== finding.raw_id) errors.push(`raw_id ${finding.raw_id} does not match finding_key ${finding.finding_key}`);
    if (finding.disposition === "fixed" && !finding.changes.some((item) => item.trim())) errors.push(`fixed finding ${finding.finding_key} must describe a change or no-code-change explanation`);
    if (finding.disposition === "disputed" && !finding.evidence.trim()) errors.push(`disputed finding ${finding.finding_key} must provide evidence`);
    for (const verification of finding.verification) {
      if (verification.outcome === "not_run" && !verification.evidence.trim()) errors.push(`not_run verification for ${finding.finding_key} must include a reason`);
    }
  }
  for (const expectedFinding of expected) {
    if (!seen.has(expectedFinding.findingKey)) errors.push(`missing finding_key: ${expectedFinding.findingKey}`);
  }
  return errors;
}

/** JSON.parse with duplicate-key rejection. */
export function parseStrictJson(source: string): unknown { scanJson(source); return JSON.parse(source) as unknown; }

function scanJson(source: string): { value: unknown; objectKeys: Map<string, string[]> } {
  let at = 0;
  const objectKeys = new Map<string, string[]>();
  const ws = () => { while (/\s/.test(source[at] ?? "")) at++; };
  const string = (): string => {
    const start = at;
    if (source[at++] !== '"') throw new Error(`expected string at byte ${start}`);
    while (at < source.length) {
      if (source[at] === "\\") { at += 2; continue; }
      if (source[at++] === '"') return JSON.parse(source.slice(start, at)) as string;
    }
    throw new Error("unterminated string");
  };
  const value = (path: string): unknown => {
    ws(); const ch = source[at];
    if (ch === '"') return string();
    if (ch === "{") {
      at++; ws(); const result: Record<string, unknown> = {}; const keys: string[] = [];
      if (source[at] === "}") { at++; objectKeys.set(path, keys); return result; }
      while (true) {
        ws(); const key = string();
        if (keys.includes(key)) throw new Error(`duplicate field ${path}/${key}`);
        keys.push(key); ws(); if (source[at++] !== ":") throw new Error(`expected ':' after ${key}`);
        result[key] = value(`${path}/${key}`); ws();
        if (source[at] === "}") { at++; break; }
        if (source[at++] !== ",") throw new Error(`expected ',' in ${path || "/"}`);
      }
      objectKeys.set(path, keys); return result;
    }
    if (ch === "[") {
      at++; ws(); const result: unknown[] = [];
      if (source[at] === "]") { at++; return result; }
      while (true) { result.push(value(`${path}/${result.length}`)); ws(); if (source[at] === "]") { at++; break; } if (source[at++] !== ",") throw new Error(`expected ',' in array`); }
      return result;
    }
    const token = source.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw new Error(`unexpected token at byte ${at}`);
    at += token.length; return JSON.parse(token) as unknown;
  };
  const parsed = value(""); ws(); if (at !== source.length) throw new Error(`trailing content at byte ${at}`);
  return { value: parsed, objectKeys };
}
