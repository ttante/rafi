import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  BuildRunRecordV2,
  DiagnosticSourceResultV1,
  ManagerAggregateMetric,
  ManagerAggregateOperation,
  ManagerAggregateQueryV1,
  ManagerAggregateResultV1,
  ManagerDiagnosticReportV1,
  ManagerEvidenceRequestV1,
  ManagerEvidenceResponseV1,
  ManagerMetricCoverageV1,
  ManagerProjectDiagnosticReportV1,
  ManagerRunActiveState,
  ManagerRunSummaryV1,
  RunRollupV1,
} from "rafi-spec";
import { BUILD_LEASE_STALE_MS, readBuildRuns } from "./buildRuns.js";
import { collectManagerDiagnostics } from "./diagnostics.js";
import { diagnosticDigest, ObservabilityReader } from "./observability.js";
import { WorkflowReader } from "./workflowReader.js";

export const MANAGER_CATALOG_LIMIT = 30;
export const MANAGER_LOOKUP_MAX_ROUNDS = 2;
export const MANAGER_LOOKUP_MAX_OPERATIONS = 6;
export const MANAGER_LOOKUP_MAX_DETAIL_RUNS = 5;
export const MANAGER_LOOKUP_MAX_LIST_ROWS = 50;

const AGGREGATE_METRICS: ManagerAggregateMetric[] = [
  "calendarMs", "activeExecutionMs", "pausedOfflineMs", "explicitWaitMs", "attributedMs", "unattributedMs",
  "observedRetryMs", "reportedRetryDelayMs", "qaAttempts", "qaFailures", "fixes", "retries", "tools",
  "providerTurns", "waits", "executions", "inputTokens", "outputTokens", "totalTokens", "authoritativeCostUsd",
];
const AGGREGATE_OPERATIONS: ManagerAggregateOperation[] = ["sum", "count", "minimum", "maximum", "average", "median", "p75", "p90"];

export interface CollectManagerProjectOptions {
  initialFocusRunId?: string;
  currentFocusRunId?: string;
  referencedRunIds?: string[];
  question?: string;
  now?: Date;
  maxCatalog?: number;
  external?: "auto" | "on" | "off";
}

export interface ManagerProjectCollection {
  report: ManagerProjectDiagnosticReportV1;
  allSummaries: ManagerRunSummaryV1[];
}

export function collectManagerProjectDiagnostics(projectDir: string, options: CollectManagerProjectOptions = {}): ManagerProjectCollection {
  const root = resolve(projectDir);
  const now = options.now ?? new Date();
  const buildRuns = readBuildRuns(root);
  const observability = new ObservabilityReader(root);
  const workflow = new WorkflowReader(root);
  try {
    const stored = observability.runSummaries({ limit: 10_000 });
    const rollups = observability.rollups();
    const workflowRuns = workflow.buildRuns();
    const lease = workflow.currentLease();
    const activeRunId = verifiedActiveRunId(lease, now) ?? buildRuns.find(run => verifiedSnapshotLease(run, now))?.runId;
    const buildById = new Map(buildRuns.map(run => [run.runId, run]));
    const storedById = new Map(stored.map(summary => [summary.runId, summary]));
    const rollupById = new Map(rollups.map(rollup => [rollup.runId, rollup]));
    const workflowById = new Map(workflowRuns.map(run => [run.runId, run]));
    const ids = new Set<string>([...buildById.keys(), ...storedById.keys(), ...rollupById.keys(), ...workflowById.keys()]);
    if (!ids.size) throw new Error("no build runs found for this project; start one with `rafi start` before opening Manager");

    const defaultFocus = activeRunId && ids.has(activeRunId)
      ? activeRunId
      : [...ids].sort((a, b) => runUpdatedAt(b, buildById, storedById, workflowById, rollupById).localeCompare(runUpdatedAt(a, buildById, storedById, workflowById, rollupById)))[0]!;
    const initialFocus = options.initialFocusRunId ?? defaultFocus;
    if (!ids.has(initialFocus)) throw new Error(`build run not found: ${initialFocus}`);
    const currentFocus = options.currentFocusRunId ?? initialFocus;
    if (!ids.has(currentFocus)) throw new Error(`build run not found: ${currentFocus}`);

    const summaries = [...ids].map(runId => mergeSummary({ runId, build: buildById.get(runId), stored: storedById.get(runId), rollup: rollupById.get(runId), workflow: workflowById.get(runId), activeRunId, leaseRunId: lease?.runId, now, schemaVersion: observability.schemaVersion() }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || a.runId.localeCompare(b.runId));

    const detailIds = [...new Set([currentFocus, activeRunId, ...(options.referencedRunIds ?? [])].filter((id): id is string => Boolean(id && buildById.has(id))))].slice(0, 5);
    const focusedReports = detailIds.map(runId => collectManagerDiagnostics(root, { runId, question: options.question, external: runId === currentFocus ? options.external ?? "off" : "off", now, maxDetailSpans: 50 }));
    for (const report of focusedReports) {
      const index = summaries.findIndex(item => item.runId === report.runId);
      if (index >= 0) summaries[index] = mergeDetailedReport(summaries[index]!, report);
    }

    const allRunsQuery: ManagerAggregateQueryV1 = { version: 1, metrics: AGGREGATE_METRICS, operations: AGGREGATE_OPERATIONS };
    const successfulQuery: ManagerAggregateQueryV1 = { version: 1, filters: { statuses: ["completed"] }, metrics: AGGREGATE_METRICS, operations: AGGREGATE_OPERATIONS };
    const allRuns = aggregateManagerRuns(summaries, allRunsQuery);
    const successfulCompletedRuns = aggregateManagerRuns(summaries, successfulQuery);
    const topRuns = {
      activeTime: rank(summaries, "activeExecutionMs"), waitTime: rank(summaries, "explicitWaitMs"),
      qaTime: rankDerived(summaries, item => item.metricCoverage.timing === "unavailable" && !Object.keys(item.timing.inclusiveByKind).length ? undefined : sumKinds(item.timing.inclusiveByKind, ["qa_attempt", "qa_fix", "fix"])),
      retryTime: rank(summaries, "observedRetryMs"), unattributedTime: rank(summaries, "unattributedMs"),
    };
    const recent = summaries.slice(0, 20);
    const relevant = [...topRuns.activeTime, ...topRuns.waitTime, ...topRuns.qaTime, ...topRuns.retryTime, ...topRuns.unattributedTime]
      .map(item => summaries.find(summary => summary.runId === item.runId)).filter((item): item is ManagerRunSummaryV1 => Boolean(item)).slice(0, 10);
    const preferred = [summaries.find(item => item.runId === activeRunId), summaries.find(item => item.runId === currentFocus), ...recent, ...relevant]
      .filter((item): item is ManagerRunSummaryV1 => Boolean(item));
    const runCatalog = dedupe(preferred).slice(0, Math.max(1, options.maxCatalog ?? MANAGER_CATALOG_LIMIT));
    const statusDistribution = distribution(summaries.map(item => item.status));
    const capabilityDistribution = distribution(summaries.flatMap(item => [`detail:${item.detailLevel}`, ...Object.values(item.capabilities.sources).map(source => `${source.source}:${source.state}`)]));
    const sourceCoverage = coverageForAllMetrics(summaries);
    const staleRecoveryRunIds = summaries.filter(item => item.activeState === "stale_recovery").map(item => item.runId);
    const completedDates = summaries.filter(item => item.status === "completed").map(item => item.completedAt).filter((item): item is string => Boolean(item)).sort();
    const createdDates = summaries.map(item => item.createdAt).sort();
    const projectBasis = { ids: summaries.map(item => [item.runId, item.digest]), activeRunId, initialFocus, currentFocus };
    const withoutDigest: Omit<ManagerProjectDiagnosticReportV1, "digest"> = {
      version: 1, generatedAt: now.toISOString(), projectDigest: diagnosticDigest(projectBasis), totalRunCount: summaries.length,
      dateRange: { earliestCreatedAt: createdDates[0]!, latestCreatedAt: createdDates.at(-1)!, ...(completedDates.length ? { latestCompletedAt: completedDates.at(-1)! } : {}) },
      statusDistribution, capabilityDistribution, ...(activeRunId ? { verifiedActiveRunId: activeRunId } : {}), staleRecoveryRunIds,
      initialFocusRunId: initialFocus, currentFocusRunId: currentFocus, allRuns, successfulCompletedRuns, topRuns,
      runCatalog, omittedRunCount: Math.max(0, summaries.length - runCatalog.length), focusedReports,
      findings: crossRunFindings(summaries, successfulCompletedRuns), sourceCoverage,
    };
    return { report: { ...withoutDigest, digest: diagnosticDigest(withoutDigest) }, allSummaries: summaries };
  } finally { observability.close(); workflow.close(); }
}

export function aggregateManagerRuns(summaries: readonly ManagerRunSummaryV1[], query: ManagerAggregateQueryV1): ManagerAggregateResultV1 {
  const filtered = summaries.filter(summary => matches(summary, query.filters));
  const dimensions = [...new Set(query.groupBy ?? [])];
  const groups = new Map<string, ManagerRunSummaryV1[]>();
  for (const summary of filtered) {
    const keys = groupKeys(summary, dimensions);
    for (const key of keys) {
      const digest = JSON.stringify(key);
      groups.set(digest, [...(groups.get(digest) ?? []), summary]);
    }
  }
  if (!groups.size && !dimensions.length) groups.set("{}", []);
  const rows = [...groups.entries()].map(([encoded, runs]) => {
    const values: ManagerAggregateResultV1["groups"][number]["values"] = {};
    const coverage: ManagerAggregateResultV1["groups"][number]["coverage"] = {};
    for (const metric of [...new Set(query.metrics)]) {
      const measured = runs.map(item => metricValue(item, metric)).filter((value): value is number => value !== undefined && Number.isFinite(value));
      coverage[metric] = metricCoverage(runs.length, measured.length);
      const sorted = measured.sort((a, b) => a - b);
      const operations: Partial<Record<ManagerAggregateOperation, number>> = {};
      if (sorted.length) for (const operation of [...new Set(query.operations)]) operations[operation] = aggregateOperation(sorted, operation);
      values[metric] = operations;
    }
    const evidenceIds = runs.slice(0, 100).map(item => `run:${item.runId}`);
    return { key: JSON.parse(encoded) as Record<string, string | number | boolean>, runCount: runs.length, values, coverage, evidenceIds, ...(runs.length > evidenceIds.length ? { omittedEvidenceCount: runs.length - evidenceIds.length } : {}) };
  }).sort((a, b) => JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)));
  const bounded = rows.slice(0, 200);
  const basis = { version: 1 as const, query, matchedRunCount: filtered.length, groups: bounded, omittedGroupCount: Math.max(0, rows.length - bounded.length) };
  return { ...basis, digest: diagnosticDigest(basis) };
}

export function executeManagerEvidenceRequest(
  projectDir: string,
  request: ManagerEvidenceRequestV1,
  collection: ManagerProjectCollection,
  lookupRound: number,
): ManagerEvidenceResponseV1 {
  const results: ManagerEvidenceResponseV1["results"] = [];
  const operations = request.operations.slice(0, MANAGER_LOOKUP_MAX_OPERATIONS);
  for (const operation of operations) {
    if (operation.kind === "list_runs") {
      const filtered = collection.allSummaries.filter(item => matches(item, operation.filters));
      const offset = decodeCursor(operation.cursor);
      const limit = Math.max(1, Math.min(MANAGER_LOOKUP_MAX_LIST_ROWS, operation.limit ?? 20));
      const rows = filtered.slice(offset, offset + limit);
      results.push({ kind: operation.kind, status: operation.limit && operation.limit > limit ? "limited" : "ok", data: { runs: rows, total: filtered.length, omittedCount: Math.max(0, filtered.length - offset - rows.length), nextCursor: offset + rows.length < filtered.length ? String(offset + rows.length) : undefined }, ...(operation.limit && operation.limit > limit ? { limitation: `list limit reduced to ${limit}` } : {}) });
    } else if (operation.kind === "aggregate_runs") {
      results.push({ kind: operation.kind, status: "ok", data: aggregateManagerRuns(collection.allSummaries, operation.query) });
    } else if (operation.kind === "compare_runs") {
      const ids = [...new Set(operation.runIds)].slice(0, MANAGER_LOOKUP_MAX_DETAIL_RUNS);
      const runs = ids.map(id => collection.allSummaries.find(item => item.runId === id)).filter((item): item is ManagerRunSummaryV1 => Boolean(item));
      results.push({ kind: operation.kind, status: runs.length === operation.runIds.length ? "ok" : "limited", data: { runs: runs.map(run => ({ runId: run.runId, status: run.status, values: Object.fromEntries(operation.metrics.map(metric => [metric, metricValue(run, metric)])), coverage: Object.fromEntries(operation.metrics.map(metric => [metric, metricValue(run, metric) === undefined ? "unavailable" : run.metricCoverage[metric] ?? "available"])), evidenceIds: [`run:${run.runId}`] })) }, ...(runs.length !== operation.runIds.length ? { limitation: "some requested runs were unavailable or over the five-run limit" } : {}) });
    } else if (operation.kind === "get_run_details") {
      const ids = [...new Set(operation.runIds)].slice(0, MANAGER_LOOKUP_MAX_DETAIL_RUNS);
      const reports: ManagerDiagnosticReportV1[] = [];
      const unavailable: string[] = [];
      for (const runId of ids) {
        try { reports.push(collectManagerDiagnostics(projectDir, { runId, external: "off", maxDetailSpans: Math.max(1, Math.min(100, operation.maxSpans ?? 50)) })); }
        catch { unavailable.push(runId); }
      }
      const limited = operation.runIds.length > ids.length || unavailable.length > 0;
      results.push({ kind: operation.kind, status: limited ? "limited" : "ok", data: { reports, unavailableRunIds: unavailable }, ...(limited ? { limitation: "details are limited to five retained build snapshots and available evidence" } : {}) });
    }
  }
  if (request.operations.length > operations.length) results.push({ kind: request.operations[operations.length]!.kind, status: "limited", limitation: `only ${MANAGER_LOOKUP_MAX_OPERATIONS} operations are allowed per lookup round` });
  const withoutDigest: Omit<ManagerEvidenceResponseV1, "digest"> = { version: 1, requestId: request.requestId, results, lookupRound, remainingRounds: Math.max(0, MANAGER_LOOKUP_MAX_ROUNDS - lookupRound) };
  return { ...withoutDigest, digest: diagnosticDigest(withoutDigest) };
}

export function parseManagerEvidenceRequest(text: string): ManagerEvidenceRequestV1 | undefined {
  const candidate = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? text.trim();
  if (!candidate.startsWith("{")) return undefined;
  let value: unknown;
  try { value = JSON.parse(candidate); } catch { return undefined; }
  if (!isRecord(value) || value.version !== 1 || typeof value.requestId !== "string" || !Array.isArray(value.operations) || value.operations.length < 1) return undefined;
  if (Object.keys(value).some(key => !["version", "requestId", "operations"].includes(key))) return undefined;
  if (!value.operations.every(validateOperation)) return undefined;
  return value as unknown as ManagerEvidenceRequestV1;
}

export function resolveManagerQuestionRuns(summaries: readonly ManagerRunSummaryV1[], question: string, currentFocus: string, priorReferences: readonly string[] = []): { focusRunId: string; referencedRunIds: string[] } {
  const lower = question.toLowerCase();
  const ordered = [...summaries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
  const references: string[] = [];
  for (const summary of summaries) if (question.includes(summary.runId)) references.push(summary.runId);
  if (/\bactive run\b/i.test(question)) references.push(...summaries.filter(item => item.activeState === "verified_active").map(item => item.runId));
  if (/\blast completed\b/i.test(question)) {
    const last = summaries.filter(item => item.status === "completed" && item.completedAt).sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))[0];
    if (last) references.push(last.runId);
  }
  if (/\bprevious run\b/i.test(question)) {
    const index = ordered.findIndex(item => item.runId === currentFocus);
    if (index > 0) references.push(ordered[index - 1]!.runId);
  }
  if (/\bthat run\b/i.test(question)) references.push(priorReferences.at(-1) ?? currentFocus);
  const lastSuccessful = lower.match(/\blast\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+successful runs?\b/);
  if (lastSuccessful) references.push(...summaries.filter(item => item.status === "completed").sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt)).slice(0, Math.min(50, numberWord(lastSuccessful[1]!))).map(item => item.runId));
  const unique = [...new Set(references.filter(Boolean))];
  return { focusRunId: unique.length === 1 ? unique[0]! : currentFocus, referencedRunIds: unique };
}

function mergeSummary(input: { runId: string; build?: BuildRunRecordV2; stored?: ManagerRunSummaryV1; rollup?: RunRollupV1; workflow?: ReturnType<WorkflowReader["buildRuns"]>[number]; activeRunId?: string; leaseRunId?: string; now: Date; schemaVersion?: number }): ManagerRunSummaryV1 {
  const { runId, build, stored, rollup, workflow, activeRunId, leaseRunId, now } = input;
  const status = workflow?.status ?? build?.status ?? stored?.status ?? rollup?.status ?? "unknown";
  const createdAt = build?.createdAt ?? workflow?.createdAt ?? stored?.createdAt ?? rollup?.createdAt ?? now.toISOString();
  const updatedAt = build?.updatedAt ?? workflow?.updatedAt ?? stored?.updatedAt ?? rollup?.completedAt ?? rollup?.createdAt ?? createdAt;
  const completedAt = build?.completedAt ?? stored?.completedAt ?? rollup?.completedAt;
  const activeState: ManagerRunActiveState = activeRunId === runId ? "verified_active" : leaseRunId === runId || ["running", "paused", "blocked"].includes(status) ? "stale_recovery" : ["recoverable", "interrupted"].includes(status) ? "recoverable" : "inactive";
  const timing = stored?.timing ?? { calendarMs: rollup?.calendarMs ?? Math.max(0, Date.parse(completedAt ?? updatedAt) - Date.parse(createdAt)), activeExecutionMs: rollup?.activeExecutionMs, pausedOfflineMs: rollup ? Math.max(0, rollup.calendarMs - rollup.activeExecutionMs) : undefined, explicitWaitMs: rollup?.explicitWaitMs, attributedMs: rollup?.attributedMs, unattributedMs: rollup?.unattributedMs, inclusiveByKind: rollup?.totals ?? {}, exclusiveByKind: rollup?.totals ?? {} };
  const sourceState = stored ? "available" : rollup ? "partial" : "unavailable";
  const source: DiagnosticSourceResultV1 = { source: stored ? "run_summary_v2" : rollup ? "run_rollup_v1" : "build_snapshot", state: sourceState, observedAt: now.toISOString(), ...(sourceState === "partial" ? { detail: "legacy rollup lacks some project summary fields" } : sourceState === "unavailable" ? { detail: "only build or recovery snapshot facts are available" } : {}) };
  const conflicts = [
    build && stored && build.status !== stored.status ? `status snapshot=${build.status},summary=${stored.status}` : undefined,
    build?.builder?.settings.make && stored?.provider && build.builder.settings.make !== stored.provider ? `provider snapshot=${build.builder.settings.make},summary=${stored.provider}` : undefined,
    build?.builder?.settings.model && stored?.model && build.builder.settings.model !== stored.model ? `model snapshot=${build.builder.settings.model},summary=${stored.model}` : undefined,
  ].filter((item): item is string => Boolean(item));
  const capabilities = stored?.capabilities ?? { version: 1 as const, sources: { summary: source } };
  if (conflicts.length) capabilities.sources = { ...capabilities.sources, source_conflict: { source: "source_conflict", state: "partial", observedAt: now.toISOString(), detail: conflicts.join("; ") } };
  const withoutDigest: Omit<ManagerRunSummaryV1, "digest"> = {
    version: 1, runId, status, createdAt, updatedAt, ...(completedAt ? { completedAt } : {}), ...(build?.checkpoint ?? workflow?.checkpoint ?? stored?.checkpoint ? { checkpoint: build?.checkpoint ?? workflow?.checkpoint ?? stored?.checkpoint } : {}), activeState,
    ticketIds: build?.tickets ?? stored?.ticketIds ?? ticketsFromWorkflow(workflow), ...(build?.deliveryUnit ?? stored?.deliveryUnit ? { deliveryUnit: build?.deliveryUnit ?? stored?.deliveryUnit } : {}),
    ...(build?.branchMode ?? stored?.branchMode ?? rollup?.branchMode ? { branchMode: build?.branchMode ?? stored?.branchMode ?? rollup?.branchMode } : {}),
    qaEnabled: build ? Boolean(build.qa) : stored?.qaEnabled ?? rollup?.qaEnabled,
    ...(build?.builder?.settings.make ?? stored?.provider ?? rollup?.primaryProvider ? { provider: build?.builder?.settings.make ?? stored?.provider ?? rollup?.primaryProvider } : {}),
    ...(build?.builder?.settings.model ?? stored?.model ? { model: build?.builder?.settings.model ?? stored?.model } : {}), timing,
    counts: stored?.counts ?? { byKind: {}, byOutcome: {} }, usage: stored?.usage ?? { scope: "unavailable" }, retry: stored?.retry ?? {},
    ...(build?.failure?.category ?? build?.interruption?.category ?? stored?.failureCategory ? { failureCategory: build?.failure?.category ?? build?.interruption?.category ?? stored?.failureCategory } : {}),
    topOperations: stored?.topOperations ?? [], ...(stored?.git ? { git: stored.git } : build ? { git: { branch: build.repository.git.branch ?? build.repository.branch, changedPathCount: build.repository.git.runOwnedPaths.length, historical: true } } : {}),
    detailLevel: stored?.detailLevel ?? (rollup ? "rollup" : "legacy"),
    metricCoverage: stored?.metricCoverage ?? { timing: rollup ? "partial" : "unavailable", counts: "unavailable", usage: "unavailable", git: build ? "partial" : "unavailable" },
    capabilities, evidenceIds: stored?.evidenceIds ?? [`run:${runId}`],
  };
  return { ...withoutDigest, digest: diagnosticDigest(withoutDigest) };
}

function mergeDetailedReport(summary: ManagerRunSummaryV1, report: ManagerDiagnosticReportV1): ManagerRunSummaryV1 {
  const byKind: Record<string, number> = {}; const byOutcome: Record<string, number> = {};
  for (const span of report.detail.spans) { byKind[span.kind] = (byKind[span.kind] ?? 0) + 1; const outcome = span.outcome ?? (span.endedAt ? "unknown" : "open"); byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1; }
  const measuredTiming = { ...summary.timing, calendarMs: report.timing.calendarAgeMs, activeExecutionMs: report.timing.activeExecutionMs, pausedOfflineMs: report.timing.pausedOfflineMs, explicitWaitMs: report.timing.explicitWaitMs, attributedMs: report.timing.attributedMs, unattributedMs: report.timing.unattributedMs, inclusiveByKind: report.timing.inclusiveByKind, exclusiveByKind: report.timing.exclusiveByKind };
  const measuredCounts = { ...summary.counts, byKind: report.detail.omittedSpans ? summary.counts.byKind : byKind, byOutcome: report.detail.omittedSpans ? summary.counts.byOutcome : byOutcome, qaAttempts: report.counts.qaAttempts, qaFailures: report.counts.qaFailures, fixes: report.counts.fixes, retries: report.counts.retries, waits: report.counts.waits };
  const withoutDigest: Omit<ManagerRunSummaryV1, "digest"> = { ...summary, timing: report.legacy ? summary.timing : measuredTiming, counts: report.legacy ? summary.counts : measuredCounts, detailLevel: report.legacy ? summary.detailLevel : "detailed", capabilities: report.capabilities, evidenceIds: [...new Set([...summary.evidenceIds, ...report.evidence.map(item => item.evidenceId)])], metricCoverage: { ...summary.metricCoverage, timing: report.legacy ? summary.metricCoverage.timing ?? "partial" : "available", counts: report.legacy ? summary.metricCoverage.counts ?? "partial" : report.detail.omittedSpans ? "partial" : "available" } };
  return { ...withoutDigest, digest: diagnosticDigest(withoutDigest) };
}

function verifiedActiveRunId(lease: ReturnType<WorkflowReader["currentLease"]>, now: Date): string | undefined {
  if (!lease || now.getTime() - Date.parse(lease.heartbeatAt) > BUILD_LEASE_STALE_MS) return undefined;
  if (lease.host !== hostname()) return undefined;
  try {
    process.kill(lease.pid, 0);
    const start = readFileSync(`/proc/${lease.pid}/stat`, "utf8").split(" ")[21];
    return start === lease.processStart ? lease.runId : undefined;
  } catch { return undefined; }
}
function verifiedSnapshotLease(run: BuildRunRecordV2, now: Date): boolean {
  const lease = run.lease;
  if (!lease || now.getTime() - Date.parse(lease.heartbeatAt) > BUILD_LEASE_STALE_MS || lease.hostname !== hostname()) return false;
  try { process.kill(lease.pid, 0); return readFileSync(`/proc/${lease.pid}/stat`, "utf8").split(" ")[21] === lease.processStart; }
  catch { return false; }
}

function runUpdatedAt(runId: string, builds: Map<string, BuildRunRecordV2>, stored: Map<string, ManagerRunSummaryV1>, workflows: Map<string, ReturnType<WorkflowReader["buildRuns"]>[number]>, rollups: Map<string, RunRollupV1>): string { return builds.get(runId)?.updatedAt ?? workflows.get(runId)?.updatedAt ?? stored.get(runId)?.updatedAt ?? rollups.get(runId)?.completedAt ?? rollups.get(runId)?.createdAt ?? ""; }
function ticketsFromWorkflow(run: ReturnType<WorkflowReader["buildRuns"]>[number] | undefined): string[] { const value = run?.originalWork as { tickets?: unknown } | undefined; return Array.isArray(value?.tickets) ? value.tickets.filter((item): item is string => typeof item === "string") : []; }
function rank(summaries: readonly ManagerRunSummaryV1[], metric: "activeExecutionMs" | "explicitWaitMs" | "observedRetryMs" | "unattributedMs") { return rankDerived(summaries, item => metric === "observedRetryMs" ? item.retry.observedMs : item.timing[metric]); }
function rankDerived(summaries: readonly ManagerRunSummaryV1[], get: (summary: ManagerRunSummaryV1) => number | undefined) { return summaries.map(item => ({ runId: item.runId, value: get(item), evidenceIds: [`run:${item.runId}`] })).filter((item): item is { runId: string; value: number; evidenceIds: string[] } => item.value !== undefined).sort((a, b) => b.value - a.value || a.runId.localeCompare(b.runId)).slice(0, 5); }
function dedupe(summaries: ManagerRunSummaryV1[]): ManagerRunSummaryV1[] { const seen = new Set<string>(); return summaries.filter(item => !seen.has(item.runId) && Boolean(seen.add(item.runId))); }
function distribution(values: string[]): Record<string, number> { const result: Record<string, number> = {}; for (const value of values) result[value] = (result[value] ?? 0) + 1; return result; }
function sumKinds(values: Record<string, number>, kinds: string[]): number { return kinds.reduce((sum, kind) => sum + (values[kind] ?? 0), 0); }
function metricCoverage(eligibleRuns: number, coveredRuns: number): ManagerMetricCoverageV1 { return { eligibleRuns, coveredRuns, missingRuns: eligibleRuns - coveredRuns, state: coveredRuns === 0 ? "unavailable" : coveredRuns === eligibleRuns ? "available" : "partial" }; }
function coverageForAllMetrics(summaries: readonly ManagerRunSummaryV1[]): Record<string, ManagerMetricCoverageV1> { return Object.fromEntries(AGGREGATE_METRICS.map(metric => { const count = summaries.filter(item => metricValue(item, metric) !== undefined).length; return [metric, metricCoverage(summaries.length, count)]; })); }
function metricValue(summary: ManagerRunSummaryV1, metric: ManagerAggregateMetric): number | undefined {
  if (["calendarMs", "activeExecutionMs", "pausedOfflineMs", "explicitWaitMs", "attributedMs", "unattributedMs"].includes(metric)) return summary.timing[metric as keyof Pick<ManagerRunSummaryV1["timing"], "calendarMs" | "activeExecutionMs" | "pausedOfflineMs" | "explicitWaitMs" | "attributedMs" | "unattributedMs">] as number | undefined;
  if (metric === "observedRetryMs") return summary.retry.observedMs;
  if (metric === "reportedRetryDelayMs") return summary.retry.reportedDelayMs;
  if (["qaAttempts", "qaFailures", "fixes", "retries", "tools", "providerTurns", "waits", "executions"].includes(metric)) return summary.counts[metric as keyof Omit<ManagerRunSummaryV1["counts"], "byKind" | "byOutcome">] as number | undefined;
  return summary.usage[metric as keyof Omit<ManagerRunSummaryV1["usage"], "scope">] as number | undefined;
}
function aggregateOperation(sorted: number[], operation: ManagerAggregateOperation): number {
  if (operation === "count") return sorted.length;
  if (!sorted.length) return 0;
  if (operation === "sum") return sorted.reduce((a, b) => a + b, 0);
  if (operation === "minimum") return sorted[0]!;
  if (operation === "maximum") return sorted.at(-1)!;
  if (operation === "average") return sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return percentile(sorted, operation === "median" ? 0.5 : operation === "p75" ? 0.75 : 0.9);
}
function percentile(sorted: number[], p: number): number { if (!sorted.length) return 0; const index = (sorted.length - 1) * p; const lower = Math.floor(index); const upper = Math.ceil(index); return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower); }
function matches(summary: ManagerRunSummaryV1, filters: ManagerAggregateQueryV1["filters"]): boolean {
  if (!filters) return true;
  return (!filters.runIds?.length || filters.runIds.includes(summary.runId)) && (!filters.statuses?.length || filters.statuses.includes(summary.status))
    && (!filters.providers?.length || Boolean(summary.provider && filters.providers.includes(summary.provider))) && (!filters.models?.length || Boolean(summary.model && filters.models.includes(summary.model)))
    && (!filters.branchModes?.length || Boolean(summary.branchMode && filters.branchModes.includes(summary.branchMode))) && (filters.qaEnabled === undefined || summary.qaEnabled === filters.qaEnabled)
    && (!filters.ticketIds?.length || filters.ticketIds.some(ticket => summary.ticketIds.includes(ticket))) && (!filters.detailLevels?.length || filters.detailLevels.includes(summary.detailLevel))
    && (!filters.createdFrom || summary.createdAt >= filters.createdFrom) && (!filters.createdTo || summary.createdAt <= filters.createdTo)
    && (!filters.completedFrom || Boolean(summary.completedAt && summary.completedAt >= filters.completedFrom)) && (!filters.completedTo || Boolean(summary.completedAt && summary.completedAt <= filters.completedTo));
}
function groupKeys(summary: ManagerRunSummaryV1, dimensions: NonNullable<ManagerAggregateQueryV1["groupBy"]>): Array<Record<string, string | number | boolean>> {
  if (!dimensions.length) return [{}];
  let keys: Array<Record<string, string | number | boolean>> = [{}];
  for (const dimension of dimensions) {
    const values: Array<string | number | boolean> = dimension === "ticket" ? (summary.ticketIds.length ? summary.ticketIds : ["unknown"]) : [dimension === "status" ? summary.status : dimension === "provider" ? summary.provider ?? "unknown" : dimension === "model" ? summary.model ?? "unknown" : dimension === "branchMode" ? summary.branchMode ?? "unknown" : dimension === "qaEnabled" ? summary.qaEnabled ?? "unknown" : summary.detailLevel];
    keys = keys.flatMap(key => values.map(value => ({ ...key, [dimension]: value })));
  }
  return keys;
}
function crossRunFindings(summaries: readonly ManagerRunSummaryV1[], baseline: ManagerAggregateResultV1): ManagerProjectDiagnosticReportV1["findings"] {
  const successful = summaries.filter(item => item.status === "completed");
  const cohort = successful.filter(item => item.timing.activeExecutionMs !== undefined);
  if (cohort.length < 5) return [];
  const p90 = baseline.groups[0]?.values.activeExecutionMs?.p90;
  if (p90 === undefined) return [];
  const missingMetric = successful.length - cohort.length;
  return cohort.filter(item => item.timing.activeExecutionMs! > p90).map(item => ({ code: "project_duration_outlier", title: "Active time exceeds the successful-run p90", summary: `Run ${item.runId} has ${item.timing.activeExecutionMs}ms active time versus a ${p90}ms p90 across ${cohort.length} successful completed runs; ${missingMetric} successful run(s) lacked this metric and ${summaries.length - successful.length} non-successful/incomplete run(s) were outside the baseline.`, confidence: "derived", evidenceIds: [`run:${item.runId}`, ...baseline.groups[0]!.evidenceIds], runIds: [item.runId], excludedRunCount: missingMetric }));
}
function decodeCursor(cursor: string | undefined): number { const value = Number(cursor); return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function numberWord(value: string): number { return Number(value) || (({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 } as Record<string, number>)[value] ?? 1); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function validateOperation(operation: unknown): boolean {
  if (!isRecord(operation) || typeof operation.kind !== "string" || !["list_runs", "get_run_details", "aggregate_runs", "compare_runs"].includes(operation.kind)) return false;
  const allowed = operation.kind === "list_runs" ? ["kind", "filters", "limit", "cursor"] : operation.kind === "get_run_details" ? ["kind", "runIds", "maxSpans"] : operation.kind === "aggregate_runs" ? ["kind", "query"] : ["kind", "runIds", "metrics"];
  if (Object.keys(operation).some(key => !allowed.includes(key))) return false;
  if (operation.kind === "list_runs" && operation.limit !== undefined && (typeof operation.limit !== "number" || !Number.isSafeInteger(operation.limit) || operation.limit < 1)) return false;
  if (operation.kind === "list_runs" && operation.cursor !== undefined && typeof operation.cursor !== "string") return false;
  if (operation.kind === "get_run_details" && operation.maxSpans !== undefined && (typeof operation.maxSpans !== "number" || !Number.isSafeInteger(operation.maxSpans) || operation.maxSpans < 1)) return false;
  if ((operation.kind === "get_run_details" || operation.kind === "compare_runs") && (!Array.isArray(operation.runIds) || !operation.runIds.every(item => typeof item === "string"))) return false;
  if (operation.kind === "list_runs" && operation.filters !== undefined && !validateFilters(operation.filters)) return false;
  if (operation.kind === "aggregate_runs" && !validateAggregateQuery(operation.query)) return false;
  if (operation.kind === "compare_runs" && (!Array.isArray(operation.metrics) || !operation.metrics.every(item => AGGREGATE_METRICS.includes(item as ManagerAggregateMetric)))) return false;
  return !containsForbiddenKey(operation);
}
function containsForbiddenKey(value: unknown): boolean { if (Array.isArray(value)) return value.some(containsForbiddenKey); if (!isRecord(value)) return false; return Object.entries(value).some(([key, item]) => /sql|command|path|tool/i.test(key) || containsForbiddenKey(item)); }
function validateAggregateQuery(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1 || Object.keys(value).some(key => !["version", "filters", "groupBy", "metrics", "operations"].includes(key))) return false;
  if (value.filters !== undefined && !validateFilters(value.filters)) return false;
  if (value.groupBy !== undefined && (!Array.isArray(value.groupBy) || !value.groupBy.every(item => ["status", "provider", "model", "branchMode", "qaEnabled", "ticket", "detailLevel"].includes(String(item))))) return false;
  return Array.isArray(value.metrics) && value.metrics.every(item => AGGREGATE_METRICS.includes(item as ManagerAggregateMetric))
    && Array.isArray(value.operations) && value.operations.every(item => AGGREGATE_OPERATIONS.includes(item as ManagerAggregateOperation));
}
function validateFilters(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some(key => !["runIds", "statuses", "createdFrom", "createdTo", "completedFrom", "completedTo", "providers", "models", "branchModes", "qaEnabled", "ticketIds", "detailLevels"].includes(key))) return false;
  const arrays = ["runIds", "statuses", "providers", "models", "branchModes", "ticketIds", "detailLevels"];
  if (arrays.some(key => value[key] !== undefined && (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(item => typeof item === "string")))) return false;
  if (["createdFrom", "createdTo", "completedFrom", "completedTo"].some(key => value[key] !== undefined && typeof value[key] !== "string")) return false;
  if (value.qaEnabled !== undefined && typeof value.qaEnabled !== "boolean") return false;
  if (Array.isArray(value.providers) && !value.providers.every(item => item === "claude" || item === "codex")) return false;
  if (Array.isArray(value.detailLevels) && !value.detailLevels.every(item => ["detailed", "rollup", "legacy"].includes(String(item)))) return false;
  return true;
}
