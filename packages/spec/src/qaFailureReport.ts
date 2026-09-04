import type { QaFailureReportV1 } from "./types.js";
import { validateQaFailureReport, type ValidationResult } from "./validate.js";

export const QA_FAILURE_REPORT_START = "RAFI_QA_FAILURE_REPORT_START";
export const QA_FAILURE_REPORT_END = "RAFI_QA_FAILURE_REPORT_END";
export const QA_FAILURE_REPORT_MAX_BYTES = 64 * 1024;

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

/** Parse and strictly validate the JSON body of one QA report envelope. */
export function parseQaFailureReport(input: string): ParsedQaFailureReport {
  const raw = unwrapFence(input);
  if (raw instanceof Error) return invalid(raw.message);
  if (Buffer.byteLength(raw, "utf8") > QA_FAILURE_REPORT_MAX_BYTES) return invalid(`serialized report exceeds ${QA_FAILURE_REPORT_MAX_BYTES} bytes`);
  let value: unknown;
  let objectKeys: Map<string, string[]>;
  try {
    const scanned = scanJson(raw);
    value = scanned.value;
    objectKeys = scanned.objectKeys;
  } catch (error) {
    return invalid(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const orderErrors = validateFieldOrder(objectKeys);
  const validation = validateQaFailureReport(value);
  const errors = [...orderErrors, ...validation.errors];
  return errors.length
    ? { rawJson: raw, validation: { valid: false, errors } }
    : { rawJson: raw, report: value as QaFailureReportV1, validation: { valid: true, errors: [] } };
}
export const parseQaFailureReportV1 = parseQaFailureReport;

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

function indexes(lines: string[], marker: string): number[] {
  return lines.flatMap((line, index) => line.trim() === marker ? [index] : []);
}

function unwrapFence(input: string): string | Error {
  const trimmed = input.trim();
  if (!trimmed.startsWith("```")) return input;
  const match = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return match ? match[1]!.trim() : new Error("malformed or multiple JSON code fences in report envelope");
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

/** JSON.parse with duplicate-key and property-order metadata. */
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

function validateFieldOrder(keys: Map<string, string[]>): string[] {
  const errors: string[] = [];
  const expected = (path: string, names: string[]) => {
    const actual = keys.get(path);
    if (actual && actual.join("\0") !== names.join("\0")) errors.push(`${path || "/"} fields are missing, unknown, duplicated, or out of order`);
  };
  expected("", ["version", "summary", "checks_run", "findings", "observations"]);
  for (const [path, actual] of keys) {
    if (/^\/checks_run\/\d+$/.test(path)) expected(path, actual.includes("command") ? ["check", "command", "outcome", "evidence"] : ["check", "outcome", "evidence"]);
    if (/^\/findings\/\d+$/.test(path)) expected(path, ["id", "requirement", "locations", "problem", "evidence", "expected", "fix_direction", "verification"]);
  }
  return errors;
}
