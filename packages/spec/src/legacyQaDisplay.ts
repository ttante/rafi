/** Private legacy parser for human display only. Never returns a report or receipt publicly. */
import type { QaFailureReportV1 } from "./types.js";
import { validateQaFailureReport } from "./validate.js";
import { QA_FAILURE_REPORT_START, QA_FAILURE_REPORT_END, QA_FAILURE_REPORT_MAX_BYTES, parseStrictJson, type ParsedQaFailureReport, type QaResponseContract } from "./qaFailureReport.js";

export function describeHistoricalQaTranscript(text: string): { status: string; valid: boolean; issues?: string } {
  if (Buffer.byteLength(text, "utf8") > QA_FAILURE_REPORT_MAX_BYTES + 4096) return { status: "unknown", valid: false };
  const parsed = parseQaResponseContract(text);
  return { status: parsed.status, valid: parsed.valid, issues: parsed.fields.issues };
}

/** Parse and strictly validate the JSON body of one QA report envelope. */
function parseQaFailureReport(input: string): ParsedQaFailureReport {
  // Enforce the boundary on the exact provider payload before trimming or
  // removing optional Markdown fences. A fence is transport syntax, not free
  // bytes outside the protocol limit.
  if (Buffer.byteLength(input, "utf8") > QA_FAILURE_REPORT_MAX_BYTES) return invalid(`serialized report exceeds ${QA_FAILURE_REPORT_MAX_BYTES} bytes`);
  const raw = unwrapFence(input);
  if (raw instanceof Error) return invalid(raw.message);
  let value: unknown;
  try {
    value = parseStrictJson(raw);
  } catch (error) {
    return invalid(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validation = validateQaFailureReport(value);
  const errors = validation.errors;
  return errors.length
    ? { rawJson: raw, validation: { valid: false, errors } }
    : { rawJson: raw, report: value as QaFailureReportV1, validation: { valid: true, errors: [] } };
}
/** Validate the envelope and final status as a single, contradiction-free response. */
function parseQaResponseContract(text: string, options: { continuityRequired?: boolean } = {}): QaResponseContract {
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
  let plainReportPayload = false;
  if (start.length === 1 && end.length === 1 && start[0]! < end[0]!) {
    const parsed = parseQaFailureReport(lines.slice(start[0]! + 1, end[0]).join("\n"));
    errors.push(...parsed.validation.errors);
    report = parsed.report;
    rawReportJson = parsed.rawJson;
  } else if (parsedStatus.status === "qa_fail" && start.length === 0 && end.length === 0 && statusLine) {
    // The wrapper is optional for the report payload, but STEP_STATUS remains
    // mandatory. The remaining content must be one complete JSON report.
    const continuityPattern = /^\s*RAFI_CONTINUITY_DELTA(?:\s|$)/;
    const payloadLines = lines.slice(0, statusLine.index);
    const firstPayloadLine = payloadLines.findIndex((line) => line.trim() && !continuityPattern.test(line));
    const continuityIndex = payloadLines.findIndex((line) => continuityPattern.test(line));
    if (options.continuityRequired && continuityIndex >= 0 && firstPayloadLine >= 0 && continuityIndex > firstPayloadLine) {
      errors.push("continuity marker must precede the failure report");
    }
    const body = payloadLines
      .filter((line) => !continuityPattern.test(line))
      .join("\n")
      .trim();
    plainReportPayload = true;
    const parsed = parseQaFailureReport(body);
    errors.push(...parsed.validation.errors);
    report = parsed.report;
    rawReportJson = parsed.rawJson;
  }
  if (parsedStatus.status === "qa_fail" && start.length !== 1 && !plainReportPayload) errors.push("qa_fail requires one valid failure report");
  if (parsedStatus.status !== "qa_fail" && start.length) errors.push(`${parsedStatus.status} must not include a failure report`);
  if (parsedStatus.status === "qa_fail" && !report && start.length === 1) errors.push("qa_fail failure report is invalid");

  return { valid: errors.length === 0, errors: [...new Set(errors)], status: parsedStatus.status, fields: parsedStatus.fields, report, rawReportJson };
}

function invalid(message: string): ParsedQaFailureReport {
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

