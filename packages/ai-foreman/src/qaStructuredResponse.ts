import { qaVerdictOutput, validateQaFailureReport, validateBuilderQaRemediationReport, type QaVerdictPayload, type QaResponseContract } from "rafi-spec";
import type { TurnResult } from "./adapters/types.js";
import { operationResponse } from "./structuredOperation.js";
import type { StepStatus } from "./foreman.js";
import { remediationOutput, validateBuilderFindingCoverage, type RemediationPayload, type BuilderQaRemediationContract, type QaFindingRefV2 } from "rafi-spec";

export function qaStructuredResponse(turn: TurnResult): QaResponseContract {
  try {
    const response = operationResponse<QaVerdictPayload>(turn, qaVerdictOutput);
    if (response.result.kind === "blocked") return { valid: true, errors: [], status: "blocked", fields: { reason: response.result.reason } };
    if (response.result.kind === "needs-input") return { valid: true, errors: [], status: "needs_input", fields: { question: response.result.question, choices: response.result.choices.join("|") } };
    if (response.result.kind !== "completed") throw new Error("Unconsumed QA intermediate result");
    const payload = response.result.payload;
    if (payload.kind === "failed") {
      const validation = validateQaFailureReport(payload.report);
      if (!validation.valid) throw new Error(validation.errors.join("; "));
    }
    return payload.kind === "passed" ? { valid: true, errors: [], status: "qa_pass", fields: { summary: response.result.summary } }
      : { valid: true, errors: [], status: "qa_fail", fields: { issues: response.result.summary }, report: payload.report, rawReportJson: JSON.stringify(payload.report) };
  } catch (error) { return { valid: false, errors: [String(error)], status: "unknown", fields: {} }; }
}
export function qaStructuredStatus(turn: TurnResult): StepStatus {
  const contract = qaStructuredResponse(turn);
  return { kind: contract.status, ...contract.fields, choices: contract.fields.choices?.split("|"), error: contract.errors.join("; ") || undefined };
}

export function remediationStructuredResponse(turn: TurnResult, expected: { handoffId?: string; findings?: QaFindingRefV2[] }): BuilderQaRemediationContract {
  try {
    const { result } = operationResponse<RemediationPayload>(turn, remediationOutput);
    if (result.kind === "blocked") return { valid: true, errors: [], status: "blocked", fields: { reason: result.reason } };
    if (result.kind === "needs-input") return { valid: true, errors: [], status: "needs_input", fields: { question: result.question } };
    if (result.kind !== "completed") throw new Error("Unconsumed remediation intermediate result");
    const { report, status, reason } = result.payload;
    const validation = validateBuilderQaRemediationReport(report);
    if (!validation.valid) throw new Error(validation.errors.join("; "));
    const errors = expected.findings ? validateBuilderFindingCoverage(report, expected.findings) : [];
    if (expected.handoffId && report.handoff_id !== expected.handoffId) errors.push("Remediation handoff identity mismatch");
    const blocked = report.findings.some(finding => finding.disposition === "blocked");
    if (blocked !== (status === "blocked") || status === "blocked" && !reason || status === "done" && reason !== null) errors.push("Contradictory remediation outcome");
    for (const finding of report.findings) if (Boolean(finding.blocker) !== (finding.disposition === "blocked")) errors.push(`Invalid blocker for ${finding.finding_key}`);
    return { valid: !errors.length, errors, status, fields: status === "blocked" ? { reason: reason! } : { summary: result.summary }, report, rawReportJson: JSON.stringify(report) };
  } catch (error) { return { valid: false, errors: [String(error)], status: "unknown", fields: {} }; }
}

/** Describe a retained native qa-verdict response for evidence and display.
 * It never authorizes a result; workflow decisions use qaStructuredResponse. */
export function describeNativeQaResponse(text: string): { status: "qa_pass" | "qa_fail" | "blocked" | "needs_input" | "unknown"; valid: boolean; issues?: string; reportJson?: string } {
  let value: { operation?: unknown; result?: { kind?: unknown; summary?: unknown; reason?: unknown; question?: unknown; payload?: { kind?: unknown; report?: unknown } } };
  try { value = JSON.parse(text); } catch { return { status: "unknown", valid: false, issues: "Response is not native JSON" }; }
  const result = value?.result;
  if (value?.operation !== "qa-verdict" || !result || typeof result !== "object") return { status: "unknown", valid: false, issues: "Response is not a qa-verdict result" };
  if (result.kind === "blocked") return { status: "blocked", valid: true, issues: typeof result.reason === "string" ? result.reason : undefined };
  if (result.kind === "needs-input") return { status: "needs_input", valid: true, issues: typeof result.question === "string" ? result.question : undefined };
  const summary = typeof result.summary === "string" ? result.summary : undefined;
  if (result.kind === "completed" && result.payload?.kind === "passed") return { status: "qa_pass", valid: true, issues: summary };
  if (result.kind === "completed" && result.payload?.kind === "failed") return { status: "qa_fail", valid: true, issues: summary, reportJson: JSON.stringify(result.payload.report ?? {}) };
  return { status: "unknown", valid: false, issues: summary };
}
