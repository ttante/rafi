import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type {
  BuildRunRecordV2,
  DiagnosticEvidenceV1,
  DiagnosticFindingV1,
  DiagnosticSourceResultV1,
  ManagerDiagnosticReportV1,
  RunRollupV1,
  RunSpanV1,
} from "rafi-spec";
import { readBuildRuns } from "./buildRuns.js";
import { diagnosticDigest, ObservabilityReader, sanitizeDiagnosticValue } from "./observability.js";
import { WorkflowReader } from "./workflowReader.js";
import { isTicketsInitialized, loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import { loadTickets } from "./tickets/ticketLoader.js";

export type ExternalDiagnosticMode = "auto" | "on" | "off";
export interface DiagnosticCommandResult { ok: boolean; stdout: string; stderr?: string; timedOut?: boolean }
export type DiagnosticCommandRunner = (command: string, args: readonly string[], options: { cwd: string; timeoutMs: number }) => DiagnosticCommandResult;
export interface CollectManagerDiagnosticsOptions {
  runId?: string;
  question?: string;
  external?: ExternalDiagnosticMode;
  now?: Date;
  commandRunner?: DiagnosticCommandRunner;
  maxDetailSpans?: number;
}

const WAIT_KINDS = new Set(["user_wait", "dependency_wait", "external_ci_wait"]);
const ALLOWED_GIT = new Set(["status", "rev-parse", "rev-list", "diff"]);

export function selectDiagnosticRun(projectDir: string, requestedRunId?: string): BuildRunRecordV2 {
  const runs = readBuildRuns(projectDir);
  if (requestedRunId) {
    const exact = runs.find(run => run.runId === requestedRunId);
    if (!exact) throw new Error(`build run not found: ${requestedRunId}`);
    return exact;
  }
  const workflow = new WorkflowReader(projectDir);
  try {
    const lease = workflow.currentLease();
    const leased = lease && evaluateLease(lease, new Date()).live ? runs.find(run => run.runId === lease.runId) : undefined;
    if (leased) return leased;
  } finally { workflow.close(); }
  const latest = runs[0];
  if (!latest) throw new Error("no build runs found for this project");
  return latest;
}

/** Collects and calculates a canonical report. The provider receives this report, never raw database rows. */
export function collectManagerDiagnostics(projectDir: string, options: CollectManagerDiagnosticsOptions = {}): ManagerDiagnosticReportV1 {
  const root = resolve(projectDir);
  const now = options.now ?? new Date();
  const run = selectDiagnosticRun(root, options.runId);
  const observable = new ObservabilityReader(root);
  const workflow = new WorkflowReader(root);
  const sources: Record<string, DiagnosticSourceResultV1> = {};
  const evidence: DiagnosticEvidenceV1[] = [];
  try {
    const schema = observable.schemaVersion();
    sources.observability = source("observability", schema === 1 || schema === 2 ? "available" : observable.available() ? "partial" : "unavailable", now,
      schema === 1 || schema === 2 ? undefined : observable.available() ? `unsupported schema ${schema ?? "unknown"}` : "observability database is absent");
    sources.recovery = source("recovery", workflow.available() ? "available" : "unavailable", now, workflow.available() ? undefined : "recovery database is absent");
    sources.build_snapshot = source("build_snapshot", "available", now);
    sources.ticket_definitions = source("ticket_definitions", existsSync(join(root, ".tickets", "tickets.yaml")) ? "available" : "not_applicable", now);

    const spans = observable.spans(run.runId);
    const retainedSpanCount = spans.length;
    const currentState = reconcileCurrentState(observable.currentState(run.runId), spans, now);
    const executions = observable.executions(run.runId);
    const workflowRun = workflow.getRun(run.runId);
    const workflowEvents = workflow.events(run.runId);
    const issues = workflow.issues(run.runId);
    const operations = workflow.operations(run.runId);
    const lease = workflow.currentLease();
    const leaseEvidence = evaluateLease(lease?.runId === run.runId ? lease : undefined, now);
    const continuity = workflow.continuityHeads(run.runId);
    sources.continuity = source("continuity", continuity.length ? "available" : workflow.available() ? "partial" : "unavailable", now,
      continuity.length ? undefined : "no continuity head is recorded for this run");
    for (const head of continuity) evidence.push({ evidenceId: `continuity-${head.role}`, source: "continuity", kind: "continuity_head",
      summary: `${head.role} continuity is ${head.state} at sequence ${head.sequence}`, observedAt: head.updatedAt });

    if (!spans.length) {
      const legacy = readLegacyLifecycle(root, run, options.maxDetailSpans ?? 50);
      spans.push(...legacy.spans);
      sources.legacy_jsonl = source("legacy_jsonl", legacy.found ? "partial" : "unavailable", now,
        legacy.found ? "legacy lifecycle timing is incomplete" : "no correlated legacy lifecycle records found");
    } else sources.legacy_jsonl = source("legacy_jsonl", "not_applicable", now);

    const storedSummary = observable.runSummaries({ runIds: [run.runId], limit: 1 })[0];
    if (leaseEvidence.live) {
      const git = collectGit(root, run.repository.worktree, options.commandRunner ?? defaultCommandRunner);
      sources.git = source("git", git.state, now, git.detail);
      for (const item of git.evidence) evidence.push(item);
    } else if (storedSummary?.git) {
      sources.git = source("git", "available", now, "saved terminal Git summary; no unrelated current repository state was queried");
      evidence.push({ evidenceId: "git-summary", source: "git", kind: "git", summary: `saved branch=${storedSummary.git.branch ?? "unknown"}, head=${storedSummary.git.terminalHead?.slice(0, 12) ?? "unknown"}, commits=${storedSummary.git.commitCount ?? "unavailable"}, changedPaths=${storedSummary.git.changedPathCount ?? "unavailable"}`, observedAt: storedSummary.git.observedAt });
      if (storedSummary.git.pullRequest) evidence.push({ evidenceId: `external-${storedSummary.git.pullRequest.provider}-${storedSummary.git.pullRequest.id}`, source: "external", kind: storedSummary.git.pullRequest.provider === "github" ? "pull_request" : "merge_request", summary: `saved ${storedSummary.git.pullRequest.provider} review ${storedSummary.git.pullRequest.id}, state=${storedSummary.git.pullRequest.state ?? "unknown"}`, observedAt: storedSummary.git.observedAt });
    } else sources.git = source("git", "partial", now, "no saved terminal Git summary; current repository state was not attributed to this historical run");

    const shouldExternal = options.external === "on" || (options.external !== "off" && /\b(?:pr|pull request|mr|merge request|ci|pipeline|check|dependency|waiting)\b/i.test(`${options.question ?? ""} ${run.checkpoint}`));
    const external = shouldExternal && leaseEvidence.live
      ? collectExternal(run.repository.worktree, options.commandRunner ?? defaultCommandRunner, now)
      : shouldExternal && storedSummary?.git?.pullRequest
        ? { state: "available" as const, detail: "saved historical external evidence", evidence: [] as DiagnosticEvidenceV1[] }
        : { state: shouldExternal ? "partial" as const : "not_applicable" as const, detail: shouldExternal ? "live external refresh is limited to a verified active run; saved historical evidence is unavailable" : undefined, evidence: [] as DiagnosticEvidenceV1[] };
    sources.external = source("external", external.state, now, external.detail);
    evidence.push(...external.evidence);

    const terminalEnd = run.completedAt ?? (["completed", "failed", "superseded"].includes(run.status) ? run.updatedAt : undefined);
    const observationEnd = leaseEvidence.live ? now : new Date(terminalEnd ?? run.updatedAt);
    const calendarAgeMs = Math.max(0, observationEnd.getTime() - new Date(run.createdAt).getTime());
    const executionIntervals = executions.length
      ? executions.map(item => interval(item.startedAt, item.endedAt ?? observationEnd.toISOString(), observationEnd))
      : leaseEvidence.live ? [interval(run.createdAt, undefined, now)] : [interval(run.createdAt, terminalEnd ?? run.updatedAt, observationEnd)];
    const activeExecutionMs = unionDuration(executionIntervals);
    const explicitWaitMs = unionDuration(spans.filter(span => WAIT_KINDS.has(span.kind)).map(span => spanInterval(span, now)));
    const attributedMs = unionDuration(spans.map(span => spanInterval(span, now)));
    const inclusiveByKind = durationsByKind(spans, now);
    const exclusiveByKind = exclusiveDurationsByKind(spans, now);
    const byKind = exclusiveByKind;
    const observedRetryMs = inclusiveByKind.retry ?? 0;
    const reportedRetryDelayMs = spans.filter(span => span.kind === "retry").reduce((sum, span) => sum + numericAttribute(span, "reportedDelayMs"), 0);
    const unattributedMs = Math.max(0, activeExecutionMs - attributedMs);
    const pausedOfflineMs = Math.max(0, calendarAgeMs - activeExecutionMs);
    const topContributors = Object.entries(byKind).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([kind, durationMs]) => ({ kind, durationMs }));

    evidence.push({ evidenceId: "timing-active", source: "observability", kind: "active_execution", summary: `Active execution accounted for ${activeExecutionMs} ms`, durationMs: activeExecutionMs });
    for (const [index, contributor] of topContributors.entries()) evidence.push({ evidenceId: `timing-${index + 1}`, source: "observability", kind: contributor.kind, summary: `${contributor.kind} accounted for ${contributor.durationMs} ms`, durationMs: contributor.durationMs });
    const significantSpans = spans.filter(span => WAIT_KINDS.has(span.kind) || ["retry", "qa_attempt", "qa_fix", "fix"].includes(span.kind)
      || ["failed", "error", "blocked"].includes(span.outcome ?? ""))
      .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime()).slice(0, 30);
    for (const span of significantSpans) evidence.push({ evidenceId: `span-${span.spanId}`, source: "observability", kind: span.kind,
      summary: `${span.name}: ${span.outcome ?? (span.endedAt ? "completed" : "open")}`, observedAt: span.endedAt ?? span.startedAt,
      durationMs: span.durationMs ?? liveDuration(span, now), spanId: span.spanId });
    const longOperations = spans.filter(span => span.kind === "tool" || span.kind === "provider_turn")
      .sort((left, right) => (right.durationMs ?? liveDuration(right, now)) - (left.durationMs ?? liveDuration(left, now))).slice(0, 6);
    for (const span of longOperations) evidence.push({ evidenceId: `long-${span.spanId}`, source: "observability", kind: span.kind,
      summary: `${span.endedAt ? "completed" : "open"} ${span.kind}: ${span.name}`, observedAt: span.endedAt ?? span.startedAt,
      durationMs: span.durationMs ?? liveDuration(span, now), spanId: span.spanId });
    sources.process_health = source("process_health", run.status !== "running" ? "not_applicable" : leaseEvidence.live || leaseEvidence.failureObserved ? "available" : "partial", now, leaseEvidence.summary);
    evidence.push({ evidenceId: "lease-health", source: "recovery", kind: "lease", summary: leaseEvidence.summary, observedAt: lease?.heartbeatAt });
    for (const issue of issues.slice(-10)) evidence.push({ evidenceId: `issue-${evidence.length + 1}`, source: "recovery", kind: issue.code, summary: safeSummary(issue.detail, 500), observedAt: issue.occurred_at });
    for (const operation of operations.filter(item => item.status === "failed" || item.status === "uncertain").slice(-10)) evidence.push({ evidenceId: `operation-${evidence.length + 1}`, source: "recovery", kind: operation.kind, summary: safeSummary(`${operation.kind}: ${operation.status}${operation.error ? ` (${operation.error.slice(0, 300)})` : ""}`, 500), observedAt: operation.updatedAt });

    const counts = {
      qaAttempts: spans.filter(span => span.kind === "qa_attempt").length,
      qaFailures: spans.filter(span => span.kind === "qa_attempt" && span.outcome && !["passed", "completed"].includes(span.outcome)).length,
      fixes: spans.filter(span => span.kind === "qa_fix" || span.kind === "fix").length,
      retries: spans.filter(span => span.kind === "retry").length + workflowEvents.filter(item => item.type.includes("retry")).length,
      waits: spans.filter(span => WAIT_KINDS.has(span.kind)).length,
    };
    const comparisons = chooseComparison(observable.rollups(), run, ticketSizeBucketForRun(root, run.tickets), now);
    const findings = buildFindings({ run, now, spans, currentState, evidence, topContributors, activeExecutionMs, explicitWaitMs, unattributedMs, byKind, counts, comparisons, leaseEvidence });
    if (findings.every((finding) => finding.code === "largest_contributors")) findings.push({ code: "progressing", title: "Run appears to be progressing", summary: `No supported anomaly is present; the longest current phase is ${topContributors[0]?.kind ?? run.checkpoint}.`, confidence: spans.length ? "derived" : "limited", evidenceIds: topContributors[0] ? ["timing-1", "lease-health"] : ["lease-health"] });

    const max = Math.max(1, options.maxDetailSpans ?? 100);
    const sortedDetail = [...spans].sort((a, b) => (b.durationMs ?? liveDuration(b, now)) - (a.durationMs ?? liveDuration(a, now)) || a.spanId.localeCompare(b.spanId));
    const capability = observable.capability(run.runId);
    if (observable.storage().summaryOnly) sources.observability = source("observability", "partial", now, "detail hard limit reached; summary-only mode is active");
    const withoutDigest: Omit<ManagerDiagnosticReportV1, "digest"> = {
      version: 1, observabilitySchemaVersion: schema === 2 ? 2 : 1, generatedAt: now.toISOString(), runId: run.runId,
      runStatus: workflowRun?.status ?? run.status, legacy: Boolean(workflowRun?.legacy || !observable.available() || (!retainedSpanCount && !executions.length && !storedSummary)),
      capabilities: { version: 1, ...(capability?.rafiVersion ? { rafiVersion: capability.rafiVersion } : {}), sources: { ...capability?.sources, ...sources } },
      currentState, timing: { calendarAgeMs, activeExecutionMs, pausedOfflineMs, explicitWaitMs, attributedMs, unattributedMs, byKind, inclusiveByKind, exclusiveByKind, observedRetryMs, reportedRetryDelayMs, topContributors },
      counts, ...(comparisons ? { comparisons } : {}), findings, evidence,
      detail: { spans: sortedDetail.slice(0, max), omittedSpans: Math.max(0, sortedDetail.length - max) },
    };
    return { ...withoutDigest, digest: diagnosticDigest(withoutDigest) };
  } finally { observable.close(); workflow.close(); }
}

function buildFindings(input: {
  run: BuildRunRecordV2; now: Date; spans: RunSpanV1[]; currentState: ManagerDiagnosticReportV1["currentState"];
  evidence: DiagnosticEvidenceV1[]; topContributors: Array<{ kind: string; durationMs: number }>;
  activeExecutionMs: number; explicitWaitMs: number; unattributedMs: number; byKind: Record<string, number>;
  counts: ManagerDiagnosticReportV1["counts"]; comparisons?: NonNullable<ManagerDiagnosticReportV1["comparisons"]>;
  leaseEvidence: ReturnType<typeof evaluateLease>;
}): DiagnosticFindingV1[] {
  const findings: DiagnosticFindingV1[] = [];
  if (input.topContributors.length) findings.push({ code: "largest_contributors", title: "Largest measured contributors", summary: input.topContributors.map(item => `${item.kind} (${formatDuration(item.durationMs)})`).join(", "), confidence: input.spans.length ? "derived" : "limited", evidenceIds: input.topContributors.map((_, index) => `timing-${index + 1}`) });
  if (input.comparisons && (input.activeExecutionMs > input.comparisons.p90Ms || input.activeExecutionMs >= input.comparisons.medianMs * 1.5)) findings.push({ code: "duration_abnormal", title: "Duration exceeds comparable runs", summary: `Active execution is ${formatDuration(input.activeExecutionMs)} versus a ${formatDuration(input.comparisons.medianMs)} cohort median and ${formatDuration(input.comparisons.p90Ms)} p90.`, confidence: "derived", evidenceIds: ["timing-active"] });
  const qaMs = (input.byKind.qa_attempt ?? 0) + (input.byKind.qa_fix ?? 0) + (input.byKind.fix ?? 0);
  if (input.counts.qaFailures > 1 || (input.activeExecutionMs > 0 && qaMs / input.activeExecutionMs > 0.3)) findings.push({ code: "qa_rework", title: "QA rework is a material contributor", summary: `${input.counts.qaFailures} failed review(s), ${input.counts.fixes} fix pass(es), and ${formatDuration(qaMs)} of QA/fix time were observed.`, confidence: "derived", evidenceIds: evidenceForKinds(input.evidence, ["qa_attempt", "qa_fix", "fix"]) });
  const retryMs = input.byKind.retry ?? 0;
  const reportedRetryMs = input.spans.filter(span => span.kind === "retry").reduce((sum, span) => sum + numericAttribute(span, "reportedDelayMs"), 0);
  if (retryMs > 60_000 || reportedRetryMs > 60_000 || (input.activeExecutionMs > 0 && Math.max(retryMs, reportedRetryMs) / input.activeExecutionMs > 0.1)) findings.push({ code: "retry_overhead", title: "Retry overhead is material", summary: `${formatDuration(retryMs)} observed and ${formatDuration(reportedRetryMs)} provider-reported delay across ${input.counts.retries} retry record(s).`, confidence: "derived", evidenceIds: evidenceForKinds(input.evidence, ["retry"]) });
  if (input.unattributedMs > 60_000 && input.activeExecutionMs > 0 && input.unattributedMs / input.activeExecutionMs > 0.1) findings.push({ code: "unattributed_time", title: "Material time is unattributed", summary: `${formatDuration(input.unattributedMs)} of active execution has no correlated span.`, confidence: "limited", evidenceIds: ["timing-active", "lease-health"] });
  if (input.explicitWaitMs > 0) findings.push({ code: "explicit_wait", title: "The run includes an explicit wait", summary: `${formatDuration(input.explicitWaitMs)} is attributed to user, dependency, or CI waiting.`, confidence: "observed", evidenceIds: evidenceForKinds(input.evidence, [...WAIT_KINDS]) });
  const latestProgress = input.currentState.map(state => state.lastSemanticProgressAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const staleMs = latestProgress ? Math.max(0, input.now.getTime() - new Date(latestProgress).getTime()) : 0;
  const activeWait = input.spans.some(span => WAIT_KINDS.has(span.kind) && !span.endedAt);
  if (!activeWait && input.run.status === "running" && staleMs >= 300_000 && input.leaseEvidence.live) findings.push({ code: "possibly_stalled", title: "Execution is possibly stalled", summary: `No semantic progress has been observed for ${formatDuration(staleMs)} while the lease/process evidence remains live.`, confidence: "derived", evidenceIds: ["lease-health"] });
  if (input.leaseEvidence.failureObserved) findings.push({ code: "lease_process_failure", title: "Lease or process failure observed", summary: input.leaseEvidence.summary, confidence: "observed", evidenceIds: ["lease-health"] });
  return findings;
}

function reconcileCurrentState(
  states: ManagerDiagnosticReportV1["currentState"],
  spans: RunSpanV1[],
  now: Date,
): ManagerDiagnosticReportV1["currentState"] {
  const open = new Map<string, RunSpanV1>();
  for (const span of spans.filter(item => !item.endedAt)) {
    const role = span.role ?? "host";
    const stream = span.stream ?? role;
    const key = `${role}\u0000${stream}`;
    const current = open.get(key);
    if (!current || new Date(span.startedAt).getTime() > new Date(current.startedAt).getTime()) open.set(key, span);
  }
  const seen = new Set<string>();
  const reconciled = states.map((state) => {
    const key = `${state.role}\u0000${state.stream}`;
    seen.add(key);
    const active = open.get(key);
    const { activeSpanId: _activeSpanId, activeSpanKind: _activeSpanKind, ...base } = state;
    return active ? { ...base, phase: active.name, activeSpanId: active.spanId, activeSpanKind: active.kind } : base;
  });
  for (const [key, span] of open) {
    if (seen.has(key)) continue;
    reconciled.push({ version: 1, runId: span.runId, role: span.role ?? "host", stream: span.stream ?? span.role ?? "host",
      ...(span.executionId ? { executionId: span.executionId } : {}), ...(span.ticketId ? { ticketId: span.ticketId } : {}),
      ...(span.deliveryUnitId ? { deliveryUnitId: span.deliveryUnitId } : {}), ...(span.providerSessionId ? { providerSessionId: span.providerSessionId } : {}),
      phase: span.name, activeSpanId: span.spanId, activeSpanKind: span.kind, updatedAt: now.toISOString() });
  }
  return reconciled;
}

function chooseComparison(rollups: RunRollupV1[], run: BuildRunRecordV2, sizeBucket: string | undefined, now: Date): NonNullable<ManagerDiagnosticReportV1["comparisons"]> | undefined {
  const cutoff = now.getTime() - 90 * 86_400_000;
  const candidates = rollups.filter(item => item.runId !== run.runId && item.status === "completed" && item.completedAt && new Date(item.completedAt).getTime() >= cutoff).slice(0, 50);
  const provider = run.builder?.settings.make;
  const qa = Boolean(run.qa);
  const countBucket = ticketCountBucket(run.tickets.length);
  const levels: Array<{ cohort: Record<string, string | number | boolean>; match: (item: RunRollupV1) => boolean }> = [
    { cohort: { branchMode: run.branchMode, qaEnabled: qa, primaryProvider: provider ?? "unknown", ticketCountBucket: countBucket, ticketSizeBucket: sizeBucket ?? "unknown" }, match: item => item.branchMode === run.branchMode && item.qaEnabled === qa && item.primaryProvider === provider && item.ticketCountBucket === countBucket && item.ticketSizeBucket === sizeBucket },
    { cohort: { branchMode: run.branchMode, qaEnabled: qa, primaryProvider: provider ?? "unknown" }, match: item => item.branchMode === run.branchMode && item.qaEnabled === qa && item.primaryProvider === provider },
    { cohort: { branchMode: run.branchMode, qaEnabled: qa }, match: item => item.branchMode === run.branchMode && item.qaEnabled === qa },
  ];
  for (const level of levels) {
    const sample = candidates.filter(level.match).map(item => item.activeExecutionMs).filter(value => value >= 0).sort((a, b) => a - b);
    if (sample.length < 5) continue;
    return { cohort: level.cohort, sampleSize: sample.length, medianMs: percentile(sample, 0.5), p75Ms: percentile(sample, 0.75), p90Ms: percentile(sample, 0.9) };
  }
  return undefined;
}

function durationsByKind(spans: RunSpanV1[], now: Date): Record<string, number> {
  const grouped = new Map<string, Array<[number, number]>>();
  for (const span of spans) grouped.set(span.kind, [...(grouped.get(span.kind) ?? []), spanInterval(span, now)]);
  return Object.fromEntries([...grouped].map(([kind, intervals]) => [kind, unionDuration(intervals)]));
}
function exclusiveDurationsByKind(spans: RunSpanV1[], now: Date): Record<string, number> {
  const byParent = new Map<string, RunSpanV1[]>();
  for (const span of spans) if (span.parentSpanId) byParent.set(span.parentSpanId, [...(byParent.get(span.parentSpanId) ?? []), span]);
  const grouped = new Map<string, Array<[number, number]>>();
  for (const span of spans) {
    const base = spanInterval(span, now);
    const children = (byParent.get(span.spanId) ?? []).map(child => intersect(base, spanInterval(child, now))).filter((value): value is [number, number] => Boolean(value));
    const segments = subtractIntervals(base, children);
    grouped.set(span.kind, [...(grouped.get(span.kind) ?? []), ...segments]);
  }
  return Object.fromEntries([...grouped].map(([kind, intervals]) => [kind, unionDuration(intervals)]));
}
function subtractIntervals(base: [number, number], cuts: Array<[number, number]>): Array<[number, number]> {
  const merged = mergeIntervals(cuts);
  const result: Array<[number, number]> = [];
  let cursor = base[0];
  for (const [start, end] of merged) { if (start > cursor) result.push([cursor, start]); cursor = Math.max(cursor, end); }
  if (cursor < base[1]) result.push([cursor, base[1]]);
  return result;
}
function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = intervals.sort((a, b) => a[0] - b[0]); const out: Array<[number, number]> = [];
  for (const item of sorted) { const last = out.at(-1); if (!last || item[0] > last[1]) out.push([...item]); else last[1] = Math.max(last[1], item[1]); }
  return out;
}
function intersect(left: [number, number], right: [number, number]): [number, number] | undefined { const start = Math.max(left[0], right[0]); const end = Math.min(left[1], right[1]); return end >= start ? [start, end] : undefined; }
function spanInterval(span: RunSpanV1, now: Date): [number, number] { return interval(span.startedAt, span.endedAt, now); }
function interval(start: string, end: string | undefined, now: Date): [number, number] { const a = new Date(start).getTime(); const b = end ? new Date(end).getTime() : now.getTime(); return [a, Math.max(a, b)]; }
export function unionDuration(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).map(([a, b]) => [a, b] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0; let start: number | undefined; let end = 0;
  for (const [a, b] of sorted) { if (start === undefined) { start = a; end = b; } else if (a <= end) end = Math.max(end, b); else { total += end - start; start = a; end = b; } }
  return total + (start === undefined ? 0 : end - start);
}

function evaluateLease(lease: ReturnType<WorkflowReader["currentLease"]>, now: Date): { summary: string; live: boolean; failureObserved: boolean } {
  if (!lease) return { summary: "No current project lease exists.", live: false, failureObserved: false };
  const age = Math.max(0, now.getTime() - new Date(lease.heartbeatAt).getTime());
  if (lease.host !== hostname()) return { summary: `Remote lease heartbeat is ${formatDuration(age)} old; matching remote process identity cannot be verified.`, live: false, failureObserved: false };
  let exists = false; try { process.kill(lease.pid, 0); exists = true; } catch { exists = false; }
  let sameStart = false; try { sameStart = readFileSync(`/proc/${lease.pid}/stat`, "utf8").split(" ")[21] === lease.processStart; } catch { sameStart = false; }
  const live = age <= 45_000 && exists && sameStart;
  return { summary: live ? `Lease heartbeat is fresh (${formatDuration(age)} old) and PID/start identity match.` : `Lease health failed: heartbeat age ${formatDuration(age)}, process exists=${exists}, process-start matches=${sameStart}.`, live, failureObserved: !live && (!exists || !sameStart) };
}

function collectGit(root: string, cwd: string, runner: DiagnosticCommandRunner): { state: DiagnosticSourceResultV1["state"]; detail?: string; evidence: DiagnosticEvidenceV1[] } {
  const evidence: DiagnosticEvidenceV1[] = [];
  try {
    const head = runGit(runner, cwd, ["rev-parse", "HEAD"]);
    const branch = runGit(runner, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = runGit(runner, cwd, ["status", "--porcelain=v1"]);
    const diff = runGit(runner, cwd, ["diff", "--shortstat"]);
    evidence.push({ evidenceId: "git-summary", source: "git", kind: "git", summary: `branch=${branch.stdout.trim() || "unknown"}, head=${head.stdout.trim().slice(0, 12) || "unknown"}, changedPaths=${status.stdout.split("\n").filter(Boolean).length}, diff=${diff.stdout.trim() || "none"}` });
    return { state: [head, branch, status, diff].every(item => item.ok) ? "available" : "partial", evidence };
  } catch (error) { return { state: "unavailable", detail: String(error).slice(0, 300), evidence }; }
  finally { void root; }
}
function runGit(runner: DiagnosticCommandRunner, cwd: string, args: string[]): DiagnosticCommandResult {
  if (!ALLOWED_GIT.has(args[0] ?? "")) throw new Error("diagnostic git command is not allowlisted");
  return runner("git", args, { cwd, timeoutMs: 5_000 });
}
function collectExternal(cwd: string, runner: DiagnosticCommandRunner, now: Date): { state: DiagnosticSourceResultV1["state"]; detail?: string; evidence: DiagnosticEvidenceV1[] } {
  const remote = runner("git", ["remote", "get-url", "origin"], { cwd, timeoutMs: 5_000 });
  if (remote.timedOut) return { state: "timed_out", detail: "Git remote inspection exceeded five seconds", evidence: [] };
  const gitlab = /gitlab/i.test(remote.stdout);
  const command = gitlab ? "glab" : "gh";
  const args = gitlab ? ["mr", "view", "--output", "json"] : ["pr", "view", "--json", "number,state,statusCheckRollup,url"];
  const result = runner(command, args, { cwd, timeoutMs: 5_000 });
  if (result.timedOut) return { state: "timed_out", detail: `${gitlab ? "GitLab" : "GitHub"} CLI check exceeded five seconds`, evidence: [] };
  if (!result.ok) return { state: "unavailable", detail: safeSummary(result.stderr || `${gitlab ? "GitLab" : "GitHub"} CLI unavailable or unauthenticated`, 300), evidence: [] };
  return { state: "available", evidence: [{ evidenceId: gitlab ? "external-mr" : "external-pr", source: "external", kind: gitlab ? "merge_request" : "pull_request", summary: safeSummary(result.stdout, 2000), observedAt: now.toISOString() }] };
}
function defaultCommandRunner(command: string, args: readonly string[], options: { cwd: string; timeoutMs: number }): DiagnosticCommandResult {
  if (command !== "git" && command !== "gh" && command !== "glab") return { ok: false, stdout: "", stderr: "command is not allowlisted" };
  try { return { ok: true, stdout: execFileSync(command, [...args], { cwd: options.cwd, timeout: options.timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (error) { const item = error as { stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean; signal?: string }; return { ok: false, stdout: String(item.stdout ?? ""), stderr: String(item.stderr ?? error), timedOut: Boolean(item.killed || item.signal === "SIGTERM") }; }
}

function readLegacyLifecycle(root: string, run: BuildRunRecordV2, limit: number): { found: boolean; spans: RunSpanV1[] } {
  const dir = join(root, ".foreman"); if (!existsSync(dir)) return { found: false, spans: [] };
  const files = readdirSync(dir).filter(name => name.endsWith(".jsonl")).sort().slice(-5);
  const spans: RunSpanV1[] = [];
  for (const file of files) {
    let rows: Array<Record<string, unknown>> = []; try { rows = readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { continue; }
    for (const [index, row] of rows.entries()) {
      const at = typeof row.timestamp === "string" ? row.timestamp : typeof row.at === "string" ? row.at : undefined;
      if (!at || new Date(at).getTime() < new Date(run.createdAt).getTime() || new Date(at).getTime() > new Date(run.updatedAt).getTime() + 60_000) continue;
      if (!["step", "branch-complete", "branch-issue", "retry", "escalation"].includes(String(row.event))) continue;
      spans.push({ version: 1, spanId: `legacy:${file}:${index}`, runId: run.runId, kind: `legacy_${String(row.event)}`, name: String(row.event), startedAt: at, endedAt: at, durationMs: 0, outcome: typeof row.outcome === "string" ? row.outcome : undefined, completionKnown: false });
      if (spans.length >= limit) return { found: true, spans };
    }
  }
  return { found: spans.length > 0, spans };
}
function source(name: string, state: DiagnosticSourceResultV1["state"], now: Date, detail?: string): DiagnosticSourceResultV1 { return { source: name, state, observedAt: now.toISOString(), ...(detail ? { detail } : {}) }; }
function evidenceForKinds(evidence: DiagnosticEvidenceV1[], kinds: string[]): string[] { const ids = evidence.filter(item => kinds.includes(item.kind)).map(item => item.evidenceId); return ids.length ? ids : ["timing-1"].filter(id => evidence.some(item => item.evidenceId === id)); }
function liveDuration(span: RunSpanV1, now: Date): number { return Math.max(0, now.getTime() - new Date(span.startedAt).getTime()); }
function numericAttribute(span: RunSpanV1, key: string): number { const value = Number(span.attributes?.[key]); return Number.isFinite(value) && value >= 0 ? value : 0; }
function percentile(sorted: number[], p: number): number { if (!sorted.length) return 0; const index = (sorted.length - 1) * p; const lower = Math.floor(index); const upper = Math.ceil(index); return Math.round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower)); }
function ticketCountBucket(count: number): string { return count <= 1 ? "1" : count <= 3 ? "2-3" : count <= 7 ? "4-7" : "8+"; }
export function ticketSizeBucketForRun(projectDir: string, ticketIds: readonly string[]): string | undefined {
  if (!ticketIds.length || !isTicketsInitialized(projectDir)) return undefined;
  try {
    const paths = resolveTicketPaths(loadTicketsConfig(projectDir), projectDir);
    const selected = loadTickets(paths.tickets).filter(ticket => ticketIds.includes(ticket.id));
    const order = ["XS", "S", "M", "L", "XL"];
    return selected.length ? selected.map(ticket => ticket.size).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] : undefined;
  } catch { return undefined; }
}
function formatDuration(ms: number): string { if (ms < 1000) return `${Math.round(ms)}ms`; if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`; if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`; return `${(ms / 3_600_000).toFixed(1)}h`; }
function safeSummary(value: string, maximum: number): string { return String(sanitizeDiagnosticValue(value)).slice(0, maximum); }
