import type { BuilderQaRemediationReport, QaFailureReportV1, QaFindingRefV2 } from "./types.js";
import type { ValidationResult } from "./validate.js";

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

export function validateBuilderFindingCoverage(report: BuilderQaRemediationReport, expected: QaFindingRefV2[]): string[] {
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
