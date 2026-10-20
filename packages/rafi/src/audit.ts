import { Command } from "commander";
import { collectManagerDiagnostics } from "ai-foreman/diagnostics.js";
import { ObservabilityReader } from "ai-foreman/observability.js";
import { readBuildRuns } from "ai-foreman/build-runs.js";
import { readQaEvidenceSnapshot } from "ai-foreman/qa-evidence-reader.js";
import type { DiagnosticSourceResultV1, ManagerDiagnosticReportV1, RunSpanV1 } from "rafi-spec";
import { findNearestRafiProject, resolveExplicitRafiProject } from "./project.js";

export type AuditHealth = "complete" | "partial" | "blocked" | "corrupt";
export type AuditOutputFormat = "json" | "markdown";

export interface AuditHealthReport {
  status: AuditHealth;
  reasons: string[];
}

export interface AuditReport {
  version: 1;
  generatedAt: string;
  selectedRun: { runId: string; selection: "latest" | "ticket" | "explicit" };
  logging: { schemaVersion?: number; summaryOnly: boolean; sources: Record<string, DiagnosticSourceResultV1> };
  evidence: { availability: string; gaps: string[]; required: boolean };
  health: AuditHealthReport;
  report: ManagerDiagnosticReportV1;
}

export interface AuditOptions {
  runId?: string;
  ticketId?: string;
  maxSpans?: number;
}

/** Selects a run without opening or migrating either project database. */
export function selectAuditRun(projectDir: string, requestedRunId?: string, requestedTicketId?: string): { runId: string; selection: "latest" | "ticket" | "explicit" } {
  const runs = readBuildRuns(projectDir);
  if (requestedRunId) {
    if (requestedRunId === "latest") return selectAuditRun(projectDir, undefined, requestedTicketId);
    const run = runs.find(run => run.runId === requestedRunId);
    if (!run) throw new Error(`build run not found: ${requestedRunId}`);
    if (requestedTicketId && !run.tickets.includes(requestedTicketId)) throw new Error(`ticket ${requestedTicketId} is not part of build run ${requestedRunId}`);
    return { runId: requestedRunId, selection: "explicit" };
  }
  if (requestedTicketId) {
    const matches = runs.filter(run => run.tickets.includes(requestedTicketId));
    if (!matches.length) throw new Error(`no build run contains ticket ${requestedTicketId}`);
    if (matches.length > 1) throw new Error(`ticket ${requestedTicketId} matches multiple build runs; use --run <run-id>`);
    return { runId: matches[0]!.runId, selection: "ticket" };
  }
  const latest = runs[0];
  if (!latest) throw new Error("no build runs found for this project");
  return { runId: latest.runId, selection: "latest" };
}

/**
 * Builds the operator report from the existing canonical Manager diagnostics.
 * It never creates, migrates, checkpoints, or changes project state.
 */
export function collectAuditReport(projectDir: string, options: AuditOptions = {}): AuditReport {
  const selectedRun = selectAuditRun(projectDir, options.runId, options.ticketId);
  const run = readBuildRuns(projectDir).find(candidate => candidate.runId === selectedRun.runId);
  const report = collectManagerDiagnostics(projectDir, {
    runId: selectedRun.runId,
    external: "off",
    maxDetailSpans: Math.max(0, Math.min(200, options.maxSpans ?? 100)),
  });
  const observability = new ObservabilityReader(projectDir);
  try {
    const spans = observability.spans(selectedRun.runId);
    const requiredEvidence = (run as ({ qaEnabled?: boolean } | undefined))?.qaEnabled === true;
    const evidence = readQaEvidenceSnapshot(projectDir, selectedRun.runId);
    return {
      version: 1,
      generatedAt: report.generatedAt,
      selectedRun,
      logging: {
        ...(observability.schemaVersion() === undefined ? {} : { schemaVersion: observability.schemaVersion() }),
        summaryOnly: observability.storage().summaryOnly,
        sources: report.capabilities.sources,
      },
      evidence: { availability: evidence.availability, gaps: evidence.gaps.slice(0, 50), required: requiredEvidence },
      health: assessAuditHealth(report, spans, { required: requiredEvidence, availability: evidence.availability, gaps: evidence.gaps }),
      report,
    };
  } finally {
    observability.close();
  }
}

export function assessAuditHealth(report: ManagerDiagnosticReportV1, spans: readonly RunSpanV1[], evidence?: { required: boolean; availability: string; gaps: readonly string[] }): AuditHealthReport {
  const reasons: string[] = [];
  const ids = new Set<string>();
  const spanIds = new Set(spans.map(span => span.spanId));
  for (const span of spans) {
    if (ids.has(span.spanId)) reasons.push(`duplicate span id ${span.spanId}`);
    ids.add(span.spanId);
    if (span.runId !== report.runId) reasons.push(`span ${span.spanId} belongs to another run`);
    if (span.parentSpanId && !spanIds.has(span.parentSpanId)) reasons.push(`span ${span.spanId} has a missing parent`);
    if (span.durationMs !== undefined && (!Number.isFinite(span.durationMs) || span.durationMs < 0)) reasons.push(`span ${span.spanId} has an invalid duration`);
    const started = Date.parse(span.startedAt);
    if (!Number.isFinite(started)) reasons.push(`span ${span.spanId} has an invalid start timestamp`);
    if (span.endedAt) {
      const ended = Date.parse(span.endedAt);
      if (!Number.isFinite(ended)) reasons.push(`span ${span.spanId} has an invalid end timestamp`);
      else if (ended < started) reasons.push(`span ${span.spanId} ends before it starts`);
    }
  }
  if (reasons.length) return { status: "corrupt", reasons: reasons.slice(0, 20) };

  const unavailable = Object.values(report.capabilities.sources).filter(source => source.state === "unavailable");
  const partial = Object.values(report.capabilities.sources).filter(source => ["partial", "timed_out"].includes(source.state));
  if (report.detail.omittedSpans > 0) reasons.push(`${report.detail.omittedSpans} diagnostic spans were omitted by the bounded report`);
  if (report.legacy) reasons.push("the run predates the current diagnostic schema");
  for (const source of [...unavailable, ...partial]) reasons.push(`${source.source}: ${source.detail ?? source.state}`);
  if (report.timing.unattributedMs > 0) reasons.push(`${report.timing.unattributedMs} ms of active time is unattributed`);
  const terminal = ["completed", "failed", "blocked", "cancelled", "superseded"].includes(report.runStatus);
  if (evidence?.required) {
    if (evidence.availability === "corrupt") return { status: "corrupt", reasons: [...reasons, ...evidence.gaps].slice(0, 20) };
    if (terminal && evidence.availability !== "present") reasons.push(`required QA evidence is ${evidence.availability}`);
    if (evidence.availability !== "present") reasons.push(...evidence.gaps.slice(0, 10));
  }
  if ((unavailable.length || (evidence?.required && terminal && evidence.availability !== "present")) && !terminal) return { status: "blocked", reasons: reasons.slice(0, 20) };
  if (evidence?.required && terminal && evidence.availability !== "present") return { status: "blocked", reasons: reasons.slice(0, 20) };
  return { status: reasons.length ? "partial" : "complete", reasons: reasons.slice(0, 20) };
}

export function renderAuditReport(audit: AuditReport, format: AuditOutputFormat = "markdown"): string {
  const rendered = format === "json" ? `${JSON.stringify(audit, null, 2)}\n` : renderMarkdown(audit);
  if (Buffer.byteLength(rendered, "utf8") <= MAX_AUDIT_OUTPUT_BYTES) return rendered;
  const notice = "Output exceeded the audit byte budget; detailed spans and evidence rows were omitted. Use a narrower run or lower --max-spans.\n";
  if (format === "markdown") return boundedUtf8(`${notice}${renderMarkdown(compactAudit(audit))}`);
  const compactAuditValue = compactAudit(audit);
  const compact = JSON.stringify(compactAuditValue, null, 2);
  if (Buffer.byteLength(compact, "utf8") <= MAX_AUDIT_OUTPUT_BYTES) return `${compact}\n`;
  return `${JSON.stringify({ version: compactAuditValue.version, generatedAt: compactAuditValue.generatedAt, selectedRun: compactAuditValue.selectedRun, logging: compactAuditValue.logging, evidence: compactAuditValue.evidence, health: compactAuditValue.health, report: { version: compactAuditValue.report.version, runId: compactAuditValue.report.runId, runStatus: compactAuditValue.report.runStatus, legacy: compactAuditValue.report.legacy, timing: compactAuditValue.report.timing, counts: compactAuditValue.report.counts } }, null, 2)}\n`;
}

const MAX_AUDIT_OUTPUT_BYTES = 256 * 1024;

function boundedUtf8(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_AUDIT_OUTPUT_BYTES) return value;
  return Buffer.from(value, "utf8").subarray(0, MAX_AUDIT_OUTPUT_BYTES).toString("utf8");
}

function compactAudit(audit: AuditReport): AuditReport {
  const compactReport = { ...audit.report, findings: audit.report.findings.slice(0, 20).map(item => ({ ...item, title: item.title.slice(0, 200), summary: item.summary.slice(0, 500) })), evidence: [], detail: { spans: [], omittedSpans: audit.report.detail.omittedSpans + audit.report.detail.spans.length } };
  return { ...audit, evidence: { ...audit.evidence, gaps: audit.evidence.gaps.slice(0, 20).map(item => item.slice(0, 500)) }, health: { ...audit.health, reasons: audit.health.reasons.slice(0, 20).map(item => item.slice(0, 500)) }, report: compactReport };
}

function renderMarkdown(audit: AuditReport): string {
  const report = audit.report;
  const lines = [
    `# Rafi audit report`, "",
    `- Run: \`${audit.selectedRun.runId}\` (${audit.selectedRun.selection})`,
    `- Build status: ${report.runStatus}`,
    `- Audit health: **${audit.health.status}**`,
    `- Generated: ${audit.generatedAt}`,
    `- Diagnostic schema: ${audit.logging.schemaVersion ?? "unavailable"}`,
    `- Summary-only retention: ${audit.logging.summaryOnly ? "yes" : "no"}`, "",
    `- QA evidence: ${audit.evidence.required ? audit.evidence.availability : "not required"}`, "",
    "## Timing", "",
    `- Calendar age: ${report.timing.calendarAgeMs} ms`,
    `- Active execution: ${report.timing.activeExecutionMs} ms`,
    `- Attributed: ${report.timing.attributedMs} ms`,
    `- Unattributed: ${report.timing.unattributedMs} ms`,
    `- QA attempts/failures: ${report.counts.qaAttempts}/${report.counts.qaFailures}`,
    `- Fixes/retries: ${report.counts.fixes}/${report.counts.retries}`, "",
    "## Largest phases", "",
    ...(report.timing.topContributors.length ? report.timing.topContributors.slice(0, 10).map(item => `- ${item.kind}: ${item.durationMs} ms`) : ["- unavailable"]), "",
    "## Findings", "",
    ...(report.findings.length ? report.findings.slice(0, 20).map(item => `- ${item.title}: ${item.summary} (${item.confidence})`) : ["- none"]), "",
    "## Audit limitations", "",
    ...(audit.health.reasons.length ? audit.health.reasons.map(reason => `- ${reason}`) : ["- none"]), "",
  ];
  return lines.join("\n");
}

export function buildAuditCommand(options: { resolveProject?: (project: string | undefined) => string } = {}): Command {
  return new Command("audit")
    .description("Inspect one retained build run with bounded, read-only audit evidence.")
    .argument("[project]", "project directory")
    .option("--run <run-id>", "inspect an exact retained build run")
    .option("--ticket <ticket-id>", "select the only retained run containing this ticket")
    .option("--format <format>", "json or markdown", "markdown")
    .option("--max-spans <count>", "maximum diagnostic spans to include", "100")
    .action((project: string | undefined, opts: Record<string, unknown>) => {
      const root = options.resolveProject ? options.resolveProject(project) : resolveAuditProject(project);
      if (!root) throw new Error("no Rafi project found; provide a project directory");
      const format = opts.format === "json" || opts.format === "markdown" ? opts.format : undefined;
      if (!format) throw new Error("--format must be json or markdown");
      const maxSpans = Number(opts.maxSpans);
      if (!Number.isInteger(maxSpans) || maxSpans < 0 || maxSpans > 200) throw new Error("--max-spans must be an integer from 0 to 200");
      process.stdout.write(renderAuditReport(collectAuditReport(root, { runId: typeof opts.run === "string" ? opts.run : undefined, ticketId: typeof opts.ticket === "string" ? opts.ticket : undefined, maxSpans }), format));
    });
}

function resolveAuditProject(project: string | undefined): string | undefined {
  return (project ? resolveExplicitRafiProject(project) : findNearestRafiProject(process.cwd()))?.root;
}
