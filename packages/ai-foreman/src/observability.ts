import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statfsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { hostname, loadavg } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import type {
  ConfigurableAgentRole,
  DiagnosticSourceResultV1,
  ManagerRunSummaryV1,
  RunCurrentStateV1,
  RunRollupV1,
  RunSpanV1,
} from "rafi-spec";

export const OBSERVABILITY_DB_FILE = ".rafi/observability.sqlite3";
export const OBSERVABILITY_SCHEMA_VERSION = 2 as const;

export interface ObservabilityConfig {
  enabled: boolean;
  sample_interval_seconds: number;
  detail_retention_days: number;
  log_retention_days: number;
  detail_soft_limit_mb: number;
  detail_hard_limit_mb: number;
  log_limit_mb: number;
}

export const DEFAULT_OBSERVABILITY_CONFIG: ObservabilityConfig = {
  enabled: true,
  sample_interval_seconds: 60,
  detail_retention_days: 30,
  log_retention_days: 30,
  detail_soft_limit_mb: 192,
  detail_hard_limit_mb: 256,
  log_limit_mb: 128,
};

export interface ObservationContext {
  runId: string;
  executionId?: string;
  parentSpanId?: string;
  providerTurnId?: string;
  ticketId?: string;
  deliveryUnitId?: string;
  role?: ConfigurableAgentRole | "host";
  stream?: string;
  providerSessionId?: string;
}

export interface StartSpanInput extends Partial<Omit<RunSpanV1, "version" | "spanId" | "runId" | "startedAt" | "completionKnown">> {
  spanId?: string;
  kind: string;
  name: string;
  attributes?: Record<string, unknown>;
}

export interface FinishSpanInput {
  outcome?: string;
  completionKnown?: boolean;
  attributes?: Record<string, unknown>;
}

export interface ObservabilityStoreOptions {
  path?: string;
  config?: Partial<ObservabilityConfig>;
  now?: () => Date;
  monotonicNow?: () => number;
  ensureIgnore?: boolean;
}

export interface ManagerSessionRecord {
  sessionId: string; runId: string; provider?: string; startedAt: string; endedAt?: string; outcome?: string;
  reportDigest?: string; inputTokens?: number; outputTokens?: number; costUsd?: number; errorCode?: string;
  scope?: "project"; latestFocusRunId?: string; projectReportDigest?: string; lookupRounds?: number; lookupOperations?: number;
}

type DbSpan = {
  span_id: string; run_id: string; execution_id: string | null; parent_span_id: string | null;
  provider_turn_id: string | null; ticket_id: string | null; delivery_unit_id: string | null;
  role: string | null; stream: string | null; provider_session_id: string | null; kind: string; name: string;
  started_at: string; ended_at: string | null; duration_ms: number | null; outcome: string | null;
  completion_known: number; attributes_json: string | null;
};

/**
 * Bounded, failure-isolated writer for diagnostic data. Recovery never depends on
 * this database. Boundary records are synchronous; high-rate state and samples
 * are coalesced by primary key and minute bucket.
 */
export class ObservabilityStore {
  readonly path: string;
  readonly config: ObservabilityConfig;
  private readonly db: Database.Database;
  private readonly projectDir: string;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly openMonotonic = new Map<string, number>();
  private disabled = false;
  private warned = false;
  private summaryOnly = false;
  private priorCpu?: { userCPUTime: number; systemCPUTime: number };

  constructor(projectDir: string, options: ObservabilityStoreOptions = {}) {
    this.projectDir = resolve(projectDir);
    this.path = options.path ?? join(this.projectDir, OBSERVABILITY_DB_FILE);
    this.config = { ...DEFAULT_OBSERVABILITY_CONFIG, ...options.config };
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    mkdirSync(dirname(this.path), { recursive: true });
    if (options.ensureIgnore !== false) ensureObservabilityIgnore(resolve(projectDir));
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.backfillBuildSnapshots();
    this.summaryOnly = this.meta("summary_only") === "1";
  }

  close(): void { if (this.db.open) this.db.close(); }
  isDisabled(): boolean { return this.disabled; }
  isSummaryOnly(): boolean { return this.summaryOnly; }

  recordCapabilities(runId: string, capabilities: Record<string, DiagnosticSourceResultV1>, rafiVersion?: string): void {
    this.guard(() => this.db.prepare(`INSERT INTO run_capabilities(run_id,rafi_version,capabilities_json,recorded_at)
      VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET rafi_version=excluded.rafi_version,capabilities_json=excluded.capabilities_json,recorded_at=excluded.recorded_at`)
      .run(runId, rafiVersion ?? null, safeJson(capabilities), this.now().toISOString()));
  }

  beginExecution(input: { runId: string; executionId?: string; leaseGeneration?: number; pid?: number; host?: string; processStart?: string }): string {
    const executionId = input.executionId ?? randomUUID();
    this.guard(() => this.db.prepare(`INSERT INTO run_executions(execution_id,run_id,lease_generation,host,pid,process_start,started_at)
      VALUES(?,?,?,?,?,?,?)`).run(executionId, input.runId, input.leaseGeneration ?? null, input.host ?? hostname(), input.pid ?? process.pid, input.processStart ?? processStartIdentity(input.pid ?? process.pid), this.now().toISOString()));
    return executionId;
  }

  endExecution(executionId: string, outcome: string): void {
    this.guard(() => this.db.prepare("UPDATE run_executions SET ended_at=?,outcome=? WHERE execution_id=? AND ended_at IS NULL")
      .run(this.now().toISOString(), outcome, executionId));
  }

  attachExecutionLease(executionId: string, leaseGeneration: number | undefined): void {
    if (leaseGeneration === undefined) return;
    this.guard(() => this.db.prepare("UPDATE run_executions SET lease_generation=? WHERE execution_id=?")
      .run(leaseGeneration, executionId));
  }

  abandonPriorExecutionSpans(runId: string, executionId: string): void {
    this.guard(() => this.db.prepare(`UPDATE run_spans SET outcome='abandoned',completion_known=0
      WHERE run_id=? AND execution_id<>? AND ended_at IS NULL`).run(runId, executionId));
  }

  startSpan(context: ObservationContext, input: StartSpanInput): string {
    const spanId = input.spanId ?? randomUUID();
    const startedAt = this.now().toISOString();
    const record = (): void => {
      this.db.prepare(`INSERT INTO run_spans(span_id,run_id,execution_id,parent_span_id,provider_turn_id,ticket_id,delivery_unit_id,role,stream,provider_session_id,kind,name,started_at,completion_known,attributes_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(spanId, context.runId, input.executionId ?? context.executionId ?? null,
        input.parentSpanId ?? context.parentSpanId ?? null, input.providerTurnId ?? context.providerTurnId ?? null,
        input.ticketId ?? context.ticketId ?? null, input.deliveryUnitId ?? context.deliveryUnitId ?? null,
        input.role ?? context.role ?? null, input.stream ?? context.stream ?? null,
        input.providerSessionId ?? context.providerSessionId ?? null, input.kind, input.name, startedAt,
        input.attributes ? safeJson(sanitizeValue(input.attributes)) : null);
      this.openMonotonic.set(spanId, this.monotonicNow());
    };
    this.guard(record);
    return spanId;
  }

  finishSpan(spanId: string, input: FinishSpanInput = {}): void {
    this.guard(() => {
      const row = this.db.prepare("SELECT run_id,kind,role,ticket_id,attributes_json,started_at,ended_at FROM run_spans WHERE span_id=?").get(spanId) as { run_id: string; kind: string; role: string | null; ticket_id: string | null; attributes_json: string | null; started_at: string; ended_at: string | null } | undefined;
      if (!row) return;
      if (row.ended_at) return;
      const monotonicStarted = this.openMonotonic.get(spanId);
      const durationMs = monotonicStarted === undefined
        ? Math.max(0, this.now().getTime() - new Date(row.started_at).getTime())
        : Math.max(0, this.monotonicNow() - monotonicStarted);
      const attributes = input.attributes
        ? { ...(row.attributes_json ? JSON.parse(row.attributes_json) as object : {}), ...sanitizeValue(input.attributes) as object }
        : row.attributes_json ? JSON.parse(row.attributes_json) : undefined;
      this.db.prepare(`UPDATE run_spans SET ended_at=?,duration_ms=?,outcome=?,completion_known=?,attributes_json=?
        WHERE span_id=? AND ended_at IS NULL`).run(this.now().toISOString(), Math.round(durationMs), input.outcome ?? null,
        input.completionKnown === false ? 0 : 1, attributes ? safeJson(attributes) : null, spanId);
      this.db.prepare(`INSERT INTO phase_rollups(run_id,phase,role,ticket_id,duration_ms,count) VALUES(?,?,?,?,?,1)
        ON CONFLICT(run_id,phase,role,ticket_id) DO UPDATE SET duration_ms=duration_ms+excluded.duration_ms,count=count+1`)
        .run(row.run_id, row.kind, row.role ?? "", row.ticket_id ?? "", Math.round(durationMs));
      this.db.prepare(`UPDATE run_current_state SET active_span_id=NULL,active_span_kind=NULL,updated_at=? WHERE active_span_id=?`)
        .run(this.now().toISOString(), spanId);
      if (this.summaryOnly && row.kind === "tool") this.db.prepare(`DELETE FROM run_spans WHERE span_id IN (
        SELECT span_id FROM run_spans WHERE kind='tool' AND ended_at IS NOT NULL AND COALESCE(outcome,'') NOT IN ('failed','error','blocked')
        ORDER BY COALESCE(duration_ms,0) DESC,span_id LIMIT -1 OFFSET 100)`).run();
      this.openMonotonic.delete(spanId);
    });
  }

  recordEvent(context: ObservationContext, kind: string, input: { eventId?: string; spanId?: string; severity?: string; attributes?: Record<string, unknown> } = {}): string {
    const eventId = input.eventId ?? randomUUID();
    this.guard(() => this.db.prepare(`INSERT OR IGNORE INTO run_events(event_id,run_id,execution_id,span_id,ticket_id,role,stream,kind,severity,attributes_json,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, context.runId, context.executionId ?? null, input.spanId ?? context.parentSpanId ?? null,
      context.ticketId ?? null, context.role ?? null, context.stream ?? null, kind, input.severity ?? null,
      input.attributes ? safeJson(sanitizeValue(input.attributes)) : null, this.now().toISOString()));
    return eventId;
  }

  updateCurrentState(state: Omit<RunCurrentStateV1, "version" | "updatedAt"> & { updatedAt?: string }): void {
    this.guard(() => this.db.prepare(`INSERT INTO run_current_state(run_id,role,stream,execution_id,ticket_id,delivery_unit_id,provider_session_id,phase,active_span_id,active_span_kind,last_signal_at,last_semantic_progress_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,role,stream) DO UPDATE SET
      execution_id=excluded.execution_id,ticket_id=excluded.ticket_id,delivery_unit_id=excluded.delivery_unit_id,
      provider_session_id=excluded.provider_session_id,phase=excluded.phase,active_span_id=excluded.active_span_id,
      active_span_kind=excluded.active_span_kind,last_signal_at=COALESCE(excluded.last_signal_at,run_current_state.last_signal_at),
      last_semantic_progress_at=COALESCE(excluded.last_semantic_progress_at,run_current_state.last_semantic_progress_at),updated_at=excluded.updated_at`)
      .run(state.runId, state.role, state.stream, state.executionId ?? null, state.ticketId ?? null,
        state.deliveryUnitId ?? null, state.providerSessionId ?? null, state.phase ?? null, state.activeSpanId ?? null,
        state.activeSpanKind ?? null, state.lastSignalAt ?? null, state.lastSemanticProgressAt ?? null,
        state.updatedAt ?? this.now().toISOString()));
  }

  recordMetric(context: ObservationContext, metric: string, value: number, input: { unit?: string; boundary?: boolean; attributes?: Record<string, unknown> } = {}): void {
    if (!Number.isFinite(value)) return;
    this.guard(() => {
      const observedAt = this.now();
      const interval = Math.max(1, this.config.sample_interval_seconds) * 1000;
      const bucket = input.boundary ? observedAt.getTime() : Math.floor(observedAt.getTime() / interval) * interval;
      this.db.prepare(`INSERT INTO metric_samples(run_id,role,stream,provider_session_id,metric,bucket_ms,value,unit,boundary,attributes_json,observed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,role,stream,provider_session_id,metric,bucket_ms,boundary)
        DO UPDATE SET value=excluded.value,attributes_json=excluded.attributes_json,observed_at=excluded.observed_at`)
        .run(context.runId, context.role ?? "host", context.stream ?? "host", context.providerSessionId ?? "", metric,
          bucket, value, input.unit ?? null, input.boundary ? 1 : 0, input.attributes ? safeJson(sanitizeValue(input.attributes)) : null, observedAt.toISOString());
    });
  }

  sampleProcess(context: ObservationContext, eventLoopDelayMs?: number, boundary = false): void {
    const usage = process.resourceUsage();
    const mem = process.memoryUsage();
    const disk = availableDiskBytes(dirname(this.path));
    this.recordMetric(context, "process_rss_bytes", mem.rss, { unit: "bytes", boundary });
    this.recordMetric(context, "process_cpu_user_delta_us", Math.max(0, usage.userCPUTime - (this.priorCpu?.userCPUTime ?? usage.userCPUTime)), { unit: "microseconds", boundary });
    this.recordMetric(context, "process_cpu_system_delta_us", Math.max(0, usage.systemCPUTime - (this.priorCpu?.systemCPUTime ?? usage.systemCPUTime)), { unit: "microseconds", boundary });
    this.priorCpu = { userCPUTime: usage.userCPUTime, systemCPUTime: usage.systemCPUTime };
    this.recordMetric(context, "system_load_1m", loadavg()[0] ?? 0, { unit: "load", boundary });
    if (eventLoopDelayMs !== undefined) this.recordMetric(context, "event_loop_delay_ms", eventLoopDelayMs, { unit: "milliseconds", boundary });
    if (disk !== undefined) this.recordMetric(context, "disk_available_bytes", disk, { unit: "bytes", boundary });
  }

  upsertRollup(rollup: RunRollupV1): void {
    this.guard(() => this.db.prepare(`INSERT INTO run_rollups(run_id,project_id,status,branch_mode,qa_enabled,primary_provider,ticket_count,ticket_count_bucket,ticket_size_bucket,created_at,completed_at,calendar_ms,active_execution_ms,explicit_wait_ms,attributed_ms,unattributed_ms,totals_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET project_id=excluded.project_id,status=excluded.status,branch_mode=excluded.branch_mode,
      qa_enabled=excluded.qa_enabled,primary_provider=excluded.primary_provider,ticket_count=excluded.ticket_count,ticket_count_bucket=excluded.ticket_count_bucket,
      ticket_size_bucket=excluded.ticket_size_bucket,created_at=excluded.created_at,completed_at=excluded.completed_at,
      calendar_ms=excluded.calendar_ms,active_execution_ms=excluded.active_execution_ms,explicit_wait_ms=excluded.explicit_wait_ms,
      attributed_ms=excluded.attributed_ms,unattributed_ms=excluded.unattributed_ms,totals_json=excluded.totals_json`)
      .run(rollup.runId, rollup.projectId ?? null, rollup.status, rollup.branchMode ?? null, rollup.qaEnabled === undefined ? null : rollup.qaEnabled ? 1 : 0,
        rollup.primaryProvider ?? null, rollup.ticketCount ?? null, rollup.ticketCountBucket ?? null, rollup.ticketSizeBucket ?? null,
        rollup.createdAt, rollup.completedAt ?? null, rollup.calendarMs, rollup.activeExecutionMs, rollup.explicitWaitMs,
        rollup.attributedMs, rollup.unattributedMs, safeJson(rollup.totals)));
  }

  upsertRunSummary(summary: ManagerRunSummaryV1): void {
    this.guard(() => {
      const transaction = this.db.transaction(() => {
        this.db.prepare(`INSERT INTO run_summaries(run_id,status,created_at,updated_at,completed_at,provider,model,branch_mode,qa_enabled,detail_level,summary_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,created_at=excluded.created_at,
          updated_at=excluded.updated_at,completed_at=excluded.completed_at,provider=excluded.provider,model=excluded.model,
          branch_mode=excluded.branch_mode,qa_enabled=excluded.qa_enabled,detail_level=excluded.detail_level,summary_json=excluded.summary_json`)
          .run(summary.runId, summary.status, summary.createdAt, summary.updatedAt, summary.completedAt ?? null, summary.provider ?? null,
            summary.model ?? null, summary.branchMode ?? null, summary.qaEnabled === undefined ? null : summary.qaEnabled ? 1 : 0,
            summary.detailLevel, safeJson(sanitizeValue(summary)));
        this.db.prepare("DELETE FROM run_summary_tickets WHERE run_id=?").run(summary.runId);
        const insert = this.db.prepare("INSERT INTO run_summary_tickets(run_id,ticket_id) VALUES(?,?)");
        for (const ticketId of [...new Set(summary.ticketIds)].sort()) insert.run(summary.runId, ticketId);
      });
      transaction();
    });
  }

  finalizeRun(runId: string, input: { status: string; branchMode?: string; qaEnabled?: boolean; primaryProvider?: "claude" | "codex"; model?: string; ticketCount?: number; ticketIds?: string[]; deliveryUnit?: string; checkpoint?: string; failureCategory?: string; ticketSizeBucket?: string; createdAt?: string; updatedAt?: string; completedAt?: string; git?: ManagerRunSummaryV1["git"] }): RunRollupV1 | undefined {
    let rollup: RunRollupV1 | undefined;
    this.guard(() => {
      const spans = (this.db.prepare("SELECT * FROM run_spans WHERE run_id=?").all(runId) as DbSpan[]).map(spanFromRow);
      const executions = this.db.prepare("SELECT started_at,ended_at FROM run_executions WHERE run_id=?").all(runId) as Array<{ started_at: string; ended_at: string | null }>;
      const observedEnd = input.completedAt ?? this.now().toISOString();
      const completedAt = input.completedAt ?? (["completed", "failed", "superseded"].includes(input.status) ? observedEnd : undefined);
      const createdAt = input.createdAt ?? executions[0]?.started_at ?? observedEnd;
      const activeExecutionMs = unionMs(executions.map(item => [new Date(item.started_at).getTime(), new Date(item.ended_at ?? observedEnd).getTime()]));
      const attributedMs = unionMs(spans.map(item => [new Date(item.startedAt).getTime(), new Date(item.endedAt ?? observedEnd).getTime()]));
      const explicitWaitMs = unionMs(spans.filter(item => ["user_wait", "dependency_wait", "external_ci_wait"].includes(item.kind)).map(item => [new Date(item.startedAt).getTime(), new Date(item.endedAt ?? observedEnd).getTime()]));
      const totals: Record<string, number> = {};
      const phases = this.db.prepare("SELECT phase,SUM(duration_ms) AS duration_ms FROM phase_rollups WHERE run_id=? GROUP BY phase").all(runId) as Array<{ phase: string; duration_ms: number }>;
      for (const phase of phases) totals[phase.phase] = Number(phase.duration_ms);
      rollup = { version: 1, runId, status: input.status, branchMode: input.branchMode, qaEnabled: input.qaEnabled, primaryProvider: input.primaryProvider,
        ticketCount: input.ticketCount, ticketCountBucket: input.ticketCount === undefined ? undefined : input.ticketCount <= 1 ? "1" : input.ticketCount <= 3 ? "2-3" : input.ticketCount <= 7 ? "4-7" : "8+",
        ticketSizeBucket: input.ticketSizeBucket, createdAt, completedAt, calendarMs: Math.max(0, new Date(observedEnd).getTime() - new Date(createdAt).getTime()), activeExecutionMs,
        explicitWaitMs, attributedMs, unattributedMs: Math.max(0, activeExecutionMs - attributedMs), totals };
      this.upsertRollup(rollup);
      const summary = buildStoredRunSummary(this.db, spans, executions, rollup, input, this.summaryOnly, this.now());
      this.upsertRunSummary(summary);
    });
    return rollup;
  }

  recordManagerSession(input: ManagerSessionRecord): void {
    this.guard(() => this.db.prepare(`INSERT INTO manager_sessions(session_id,run_id,provider,started_at,ended_at,outcome,report_digest,input_tokens,output_tokens,cost_usd,error_code,scope,latest_focus_run_id,project_report_digest,lookup_rounds,lookup_operations)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET ended_at=excluded.ended_at,outcome=excluded.outcome,
      provider=excluded.provider,report_digest=excluded.report_digest,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cost_usd=excluded.cost_usd,error_code=excluded.error_code,
      scope=excluded.scope,latest_focus_run_id=excluded.latest_focus_run_id,project_report_digest=excluded.project_report_digest,lookup_rounds=excluded.lookup_rounds,lookup_operations=excluded.lookup_operations`)
      .run(input.sessionId, input.runId, input.provider ?? null, input.startedAt, input.endedAt ?? null, input.outcome ?? null,
        input.reportDigest ?? null, input.inputTokens ?? null, input.outputTokens ?? null, input.costUsd ?? null, input.errorCode ?? null,
        input.scope ?? null, input.latestFocusRunId ?? null, input.projectReportDigest ?? null, input.lookupRounds ?? 0, input.lookupOperations ?? 0));
  }

  indexLogFile(path: string, runId: string): void {
    this.guard(() => this.db.prepare(`INSERT INTO log_files(path,run_id,status,indexed,resume_required,bytes,updated_at)
      VALUES(?,?,'active',1,1,?,?) ON CONFLICT(path) DO UPDATE SET run_id=excluded.run_id,status='active',indexed=1,resume_required=1,bytes=excluded.bytes,updated_at=excluded.updated_at`)
      .run(resolve(path), runId, fileSize(path), this.now().toISOString()));
  }

  closeLogFile(path: string, status: string): void {
    const terminal = status === "completed";
    this.guard(() => this.db.prepare(`UPDATE log_files SET status=?,resume_required=?,bytes=?,closed_at=?,updated_at=? WHERE path=?`)
      .run(status, terminal ? 0 : 1, fileSize(path), this.now().toISOString(), this.now().toISOString(), resolve(path)));
  }

  maintainLogs(projectDir: string): { compressed: number; deleted: number; reclaimedBytes: number } {
    const result = { compressed: 0, deleted: 0, reclaimedBytes: 0 };
    this.guard(() => {
      const root = resolve(projectDir, ".foreman");
      const compressBefore = this.now().getTime() - 86_400_000;
      const deleteBefore = this.now().getTime() - this.config.log_retention_days * 86_400_000;
      const rows = this.db.prepare(`SELECT path,run_id,closed_at FROM log_files WHERE indexed=1 AND resume_required=0 AND status='completed' ORDER BY closed_at,path`).all() as Array<{ path: string; run_id: string; closed_at: string | null }>;
      for (const row of rows) {
        if (!safeOwnedLogPath(root, row.path) || !row.closed_at || !existsSync(row.path)) continue;
        const closed = new Date(row.closed_at).getTime();
        if (row.path.endsWith(".jsonl") && closed <= compressBefore) {
          const gzPath = `${row.path}.gz`;
          const temporary = `${gzPath}.${process.pid}.tmp`;
          const before = fileSize(row.path);
          writeFileSync(temporary, gzipSync(readFileSync(row.path), { level: 6 }), { mode: 0o600 });
          renameSync(temporary, gzPath);
          unlinkSync(row.path);
          const after = fileSize(gzPath);
          this.db.prepare("DELETE FROM log_files WHERE path=?").run(row.path);
          this.db.prepare(`INSERT OR REPLACE INTO log_files(path,run_id,status,indexed,resume_required,bytes,closed_at,updated_at)
            VALUES(?,?,'completed',1,0,?,?,?)`)
            .run(gzPath, row.run_id, after, row.closed_at, this.now().toISOString());
          result.compressed += 1;
          result.reclaimedBytes += Math.max(0, before - after);
        }
      }
      const candidates = this.db.prepare(`SELECT path,closed_at,bytes FROM log_files WHERE indexed=1 AND resume_required=0 AND status='completed' AND path LIKE '%.jsonl.gz' ORDER BY closed_at,path`).all() as Array<{ path: string; closed_at: string | null; bytes: number }>;
      let total = directoryIndexedLogBytes(this.db);
      const limit = this.config.log_limit_mb * 1024 * 1024;
      for (const row of candidates) {
        const expired = row.closed_at ? new Date(row.closed_at).getTime() <= deleteBefore : false;
        if (!expired && total <= limit) continue;
        if (!safeOwnedLogPath(root, row.path) || !existsSync(row.path)) continue;
        const bytes = fileSize(row.path);
        unlinkSync(row.path);
        this.db.prepare("DELETE FROM log_files WHERE path=?").run(row.path);
        total = Math.max(0, total - bytes);
        result.deleted += 1;
        result.reclaimedBytes += bytes;
      }
    });
    return result;
  }

  enforceLimits(protectedRunIds: readonly string[] = []): { summaryOnly: boolean; prunedRows: number } {
    let prunedRows = 0;
    this.guard(() => {
      const cutoff = new Date(this.now().getTime() - this.config.detail_retention_days * 86_400_000).toISOString();
      const automaticProtected = this.db.prepare(`SELECT DISTINCT run_id FROM run_executions WHERE ended_at IS NULL
        UNION SELECT run_id FROM run_rollups WHERE status IN ('running','recoverable','interrupted','blocked','paused')`).all() as Array<{ run_id: string }>;
      const protectedIds = [...new Set([...protectedRunIds, ...automaticProtected.map(row => row.run_id)])];
      const protectedSql = protectedIds.length ? ` AND run_id NOT IN (${protectedIds.map(() => "?").join(",")})` : "";
      for (const table of ["metric_samples", "run_events", "run_spans"] as const) {
        const column = table === "run_spans" ? "COALESCE(ended_at,started_at)" : "observed_at";
        const terminal = table === "run_spans" ? " AND ended_at IS NOT NULL" : "";
        const result = this.db.prepare(`DELETE FROM ${table} WHERE ${column}<?${terminal}${protectedSql} AND run_id IN (SELECT run_id FROM run_summaries)`).run(cutoff, ...protectedIds);
        prunedRows += result.changes;
      }
      const expiredDetail = this.db.prepare(`SELECT s.run_id FROM run_summaries s WHERE s.detail_level='detailed' AND s.status NOT IN ('running','recoverable','interrupted','blocked','paused') AND NOT EXISTS (SELECT 1 FROM run_spans p WHERE p.run_id=s.run_id)`).all() as Array<{ run_id: string }>;
      demoteRunSummaries(this.db, expiredDetail.map(row => row.run_id), this.now(), "retained detail expired; permanent summary remains available");
      const bytes = databaseBytes(this.path);
      if (bytes >= this.config.detail_hard_limit_mb * 1024 * 1024) {
        this.summaryOnly = true;
        this.setMeta("summary_only", "1");
        this.setMeta("summary_only_reason", "detail_hard_limit");
        const protectedKinds = ["provider_turn", "qa_attempt", "retry", "user_wait", "dependency_wait", "external_ci_wait"];
        const marks = protectedKinds.map(() => "?").join(",");
        const result = this.db.prepare(`DELETE FROM run_spans WHERE ended_at IS NOT NULL AND kind NOT IN (${marks}) AND COALESCE(outcome,'') NOT IN ('failed','error','blocked')${protectedSql} AND run_id IN (SELECT run_id FROM run_summaries)
          AND span_id NOT IN (SELECT span_id FROM run_spans WHERE kind='tool' ORDER BY duration_ms DESC LIMIT 100)`).run(...protectedKinds, ...protectedIds);
        prunedRows += result.changes;
        const partialDetail = this.db.prepare(`SELECT run_id FROM run_summaries WHERE detail_level='detailed' AND status NOT IN ('running','recoverable','interrupted','blocked','paused')`).all() as Array<{ run_id: string }>;
        demoteRunSummaries(this.db, partialDetail.map(row => row.run_id), this.now(), "detail hard limit pruned low-priority rows; permanent summary remains available");
      }
      this.setMeta("last_maintenance_at", this.now().toISOString());
    });
    return { summaryOnly: this.summaryOnly, prunedRows };
  }

  checkpoint(): void { this.guard(() => { this.db.pragma("wal_checkpoint(PASSIVE)"); }); }
  compact(): void { this.guard(() => { this.db.pragma("wal_checkpoint(TRUNCATE)"); this.db.exec("VACUUM"); }); }

  private meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM observability_meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO observability_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  private guard(action: () => void): void {
    if (this.disabled || !this.config.enabled) return;
    try { action(); } catch (error) {
      this.disabled = true;
      if (!this.warned) {
        this.warned = true;
        process.stderr.write(`rafi: observability disabled after a storage error: ${sanitizeText(String(error)).slice(0, 300)}\n`);
      }
    }
  }
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observability_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO observability_meta(key,value) VALUES('schema_version','2');
      CREATE TABLE IF NOT EXISTS run_capabilities(run_id TEXT PRIMARY KEY,rafi_version TEXT,capabilities_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_executions(execution_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,lease_generation INTEGER,host TEXT NOT NULL,pid INTEGER NOT NULL,process_start TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,outcome TEXT);
      CREATE TABLE IF NOT EXISTS run_current_state(run_id TEXT NOT NULL,role TEXT NOT NULL,stream TEXT NOT NULL,execution_id TEXT,ticket_id TEXT,delivery_unit_id TEXT,provider_session_id TEXT,phase TEXT,active_span_id TEXT,active_span_kind TEXT,last_signal_at TEXT,last_semantic_progress_at TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,role,stream));
      CREATE TABLE IF NOT EXISTS run_spans(span_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,execution_id TEXT,parent_span_id TEXT,provider_turn_id TEXT,ticket_id TEXT,delivery_unit_id TEXT,role TEXT,stream TEXT,provider_session_id TEXT,kind TEXT NOT NULL,name TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,duration_ms INTEGER,outcome TEXT,completion_known INTEGER NOT NULL DEFAULT 0,attributes_json TEXT);
      CREATE TABLE IF NOT EXISTS run_events(event_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,execution_id TEXT,span_id TEXT,ticket_id TEXT,role TEXT,stream TEXT,kind TEXT NOT NULL,severity TEXT,attributes_json TEXT,observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metric_samples(run_id TEXT NOT NULL,role TEXT NOT NULL,stream TEXT NOT NULL,provider_session_id TEXT NOT NULL DEFAULT '',metric TEXT NOT NULL,bucket_ms INTEGER NOT NULL,value REAL NOT NULL,unit TEXT,boundary INTEGER NOT NULL DEFAULT 0,attributes_json TEXT,observed_at TEXT NOT NULL,PRIMARY KEY(run_id,role,stream,provider_session_id,metric,bucket_ms,boundary));
      CREATE TABLE IF NOT EXISTS run_rollups(run_id TEXT PRIMARY KEY,project_id TEXT,status TEXT NOT NULL,branch_mode TEXT,qa_enabled INTEGER,primary_provider TEXT,ticket_count INTEGER,ticket_count_bucket TEXT,ticket_size_bucket TEXT,created_at TEXT NOT NULL,completed_at TEXT,calendar_ms INTEGER NOT NULL,active_execution_ms INTEGER NOT NULL,explicit_wait_ms INTEGER NOT NULL,attributed_ms INTEGER NOT NULL,unattributed_ms INTEGER NOT NULL,totals_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS phase_rollups(run_id TEXT NOT NULL,phase TEXT NOT NULL,role TEXT NOT NULL DEFAULT '',ticket_id TEXT NOT NULL DEFAULT '',duration_ms INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(run_id,phase,role,ticket_id));
      CREATE TABLE IF NOT EXISTS log_files(path TEXT PRIMARY KEY,run_id TEXT,status TEXT NOT NULL,indexed INTEGER NOT NULL,resume_required INTEGER NOT NULL,bytes INTEGER NOT NULL,closed_at TEXT,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_sessions(session_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,provider TEXT,started_at TEXT NOT NULL,ended_at TEXT,outcome TEXT,report_digest TEXT,input_tokens INTEGER,output_tokens INTEGER,cost_usd REAL,error_code TEXT);
      CREATE TABLE IF NOT EXISTS run_summaries(run_id TEXT PRIMARY KEY,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT,provider TEXT,model TEXT,branch_mode TEXT,qa_enabled INTEGER,detail_level TEXT NOT NULL,summary_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_summary_tickets(run_id TEXT NOT NULL,ticket_id TEXT NOT NULL,PRIMARY KEY(run_id,ticket_id));
      CREATE INDEX IF NOT EXISTS run_spans_run_time ON run_spans(run_id,started_at);
      CREATE INDEX IF NOT EXISTS run_spans_kind_duration ON run_spans(run_id,kind,duration_ms);
      CREATE INDEX IF NOT EXISTS run_events_run_time ON run_events(run_id,observed_at);
      CREATE INDEX IF NOT EXISTS run_executions_run ON run_executions(run_id,started_at);
      CREATE INDEX IF NOT EXISTS run_rollups_cohort ON run_rollups(status,completed_at,branch_mode,qa_enabled,primary_provider);
      CREATE INDEX IF NOT EXISTS run_summaries_completed ON run_summaries(completed_at DESC,run_id);
      CREATE INDEX IF NOT EXISTS run_summaries_status ON run_summaries(status,updated_at DESC,run_id);
      CREATE INDEX IF NOT EXISTS run_summaries_provider_model ON run_summaries(provider,model,updated_at DESC);
      CREATE INDEX IF NOT EXISTS run_summaries_branch_qa ON run_summaries(branch_mode,qa_enabled,updated_at DESC);
      CREATE INDEX IF NOT EXISTS run_summary_tickets_ticket ON run_summary_tickets(ticket_id,run_id);
    `);
    addColumn(this.db, "manager_sessions", "scope", "TEXT");
    addColumn(this.db, "manager_sessions", "latest_focus_run_id", "TEXT");
    addColumn(this.db, "manager_sessions", "project_report_digest", "TEXT");
    addColumn(this.db, "manager_sessions", "lookup_rounds", "INTEGER NOT NULL DEFAULT 0");
    addColumn(this.db, "manager_sessions", "lookup_operations", "INTEGER NOT NULL DEFAULT 0");
    this.setMeta("schema_version", String(OBSERVABILITY_SCHEMA_VERSION));
    const legacy = this.db.prepare("SELECT r.* FROM run_rollups r LEFT JOIN run_summaries s ON s.run_id=r.run_id WHERE s.run_id IS NULL").all() as Array<Record<string, unknown>>;
    for (const row of legacy) this.upsertRunSummary(legacySummaryFromRollup(rollupFromRow(row), this.now()));
  }
  private backfillBuildSnapshots(): void {
    const directory = join(this.projectDir, ".foreman", "runs");
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory).filter(item => item.endsWith(".json")).sort()) {
      let run: Record<string, unknown>;
      try { run = JSON.parse(readFileSync(join(directory, name), "utf8")) as Record<string, unknown>; } catch { continue; }
      if (typeof run.runId !== "string" || typeof run.createdAt !== "string" || typeof run.updatedAt !== "string" || typeof run.status !== "string") continue;
      let existing: ManagerRunSummaryV1 | undefined;
      try { const row = this.db.prepare("SELECT summary_json FROM run_summaries WHERE run_id=?").get(run.runId) as { summary_json?: string } | undefined; if (row?.summary_json) existing = JSON.parse(row.summary_json) as ManagerRunSummaryV1; } catch { continue; }
      const builder = isRecord(run.builder) && isRecord(run.builder.settings) ? run.builder.settings : undefined;
      const repository = isRecord(run.repository) ? run.repository : undefined;
      const git = repository && isRecord(repository.git) ? repository.git : undefined;
      const tickets = Array.isArray(run.tickets) ? run.tickets.filter((item): item is string => typeof item === "string") : existing?.ticketIds ?? [];
      const completedAt = typeof run.completedAt === "string" ? run.completedAt : existing?.completedAt;
      const calendarMs = Math.max(0, Date.parse(completedAt ?? run.updatedAt) - Date.parse(run.createdAt));
      const withoutDigest: Omit<ManagerRunSummaryV1, "digest"> = existing ? {
        ...existing, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, completedAt,
        ...(typeof run.checkpoint === "string" ? { checkpoint: run.checkpoint } : {}), ticketIds: tickets,
        ...(typeof run.deliveryUnit === "string" ? { deliveryUnit: run.deliveryUnit } : {}), ...(typeof run.branchMode === "string" ? { branchMode: run.branchMode } : {}),
        qaEnabled: Boolean(run.qa), ...(builder?.make === "claude" || builder?.make === "codex" ? { provider: builder.make } : {}), ...(typeof builder?.model === "string" ? { model: builder.model } : {}),
        ...(isRecord(run.failure) && typeof run.failure.category === "string" ? { failureCategory: run.failure.category } : isRecord(run.interruption) && typeof run.interruption.category === "string" ? { failureCategory: run.interruption.category } : {}),
      } : {
        version: 1, runId: run.runId, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, ...(completedAt ? { completedAt } : {}), ...(typeof run.checkpoint === "string" ? { checkpoint: run.checkpoint } : {}), activeState: "inactive", ticketIds: tickets,
        ...(typeof run.deliveryUnit === "string" ? { deliveryUnit: run.deliveryUnit } : {}), ...(typeof run.branchMode === "string" ? { branchMode: run.branchMode } : {}), qaEnabled: Boolean(run.qa),
        ...(builder?.make === "claude" || builder?.make === "codex" ? { provider: builder.make } : {}), ...(typeof builder?.model === "string" ? { model: builder.model } : {}),
        timing: { calendarMs, inclusiveByKind: {}, exclusiveByKind: {} }, counts: { byKind: {}, byOutcome: {} }, usage: { scope: "unavailable" }, retry: {},
        ...(isRecord(run.failure) && typeof run.failure.category === "string" ? { failureCategory: run.failure.category } : isRecord(run.interruption) && typeof run.interruption.category === "string" ? { failureCategory: run.interruption.category } : {}),
        topOperations: [], ...(git || repository ? { git: { ...(typeof git?.branch === "string" ? { branch: git.branch } : typeof repository?.branch === "string" ? { branch: repository.branch } : {}), changedPathCount: Array.isArray(git?.runOwnedPaths) ? git.runOwnedPaths.length : undefined, historical: true } } : {}), detailLevel: "legacy",
        metricCoverage: { calendarMs: "available", timing: "partial", counts: "unavailable", usage: "unavailable", git: git || repository ? "partial" : "unavailable" },
        capabilities: { version: 1, sources: { migration: { source: "build_snapshot", state: "partial", observedAt: this.now().toISOString(), detail: "backfilled only exact snapshot facts" } } }, evidenceIds: [`snapshot:${run.runId}`],
      };
      this.upsertRunSummary({ ...withoutDigest, digest: diagnosticDigest(withoutDigest) });
    }
  }
}

/** Strictly read-only access. Construction never creates directories, journals, migrations, or ignore entries. */
export class ObservabilityReader {
  readonly path: string;
  private readonly db?: Database.Database;
  constructor(projectDir: string, path = join(resolve(projectDir), OBSERVABILITY_DB_FILE)) {
    this.path = path;
    if (!existsSync(path)) return;
    this.db = new Database(path, { readonly: true, fileMustExist: true });
    this.db.pragma("query_only = ON");
  }
  close(): void { this.db?.close(); }
  available(): boolean { return Boolean(this.db); }
  schemaVersion(): number | undefined {
    if (!this.db) return undefined;
    try { return Number((this.db.prepare("SELECT value FROM observability_meta WHERE key='schema_version'").get() as { value: string } | undefined)?.value); }
    catch { return undefined; }
  }
  currentState(runId: string): RunCurrentStateV1[] {
    if (!this.db) return [];
    try {
      return (this.db.prepare("SELECT * FROM run_current_state WHERE run_id=? ORDER BY role,stream").all(runId) as Array<Record<string, unknown>>).map(row => ({
        version: 1, runId: String(row.run_id), role: String(row.role) as RunCurrentStateV1["role"], stream: String(row.stream),
        ...optional("executionId", row.execution_id), ...optional("ticketId", row.ticket_id), ...optional("deliveryUnitId", row.delivery_unit_id),
        ...optional("providerSessionId", row.provider_session_id), ...optional("phase", row.phase), ...optional("activeSpanId", row.active_span_id),
        ...optional("activeSpanKind", row.active_span_kind), ...optional("lastSignalAt", row.last_signal_at),
        ...optional("lastSemanticProgressAt", row.last_semantic_progress_at), updatedAt: String(row.updated_at),
      }));
    } catch { return []; }
  }
  spans(runId: string): RunSpanV1[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT * FROM run_spans WHERE run_id=? ORDER BY started_at,span_id").all(runId) as DbSpan[]).map(spanFromRow); }
    catch { return []; }
  }
  executions(runId: string): Array<{ executionId: string; startedAt: string; endedAt?: string; outcome?: string; leaseGeneration?: number }> {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT * FROM run_executions WHERE run_id=? ORDER BY started_at").all(runId) as Array<Record<string, unknown>>).map(row => ({
      executionId: String(row.execution_id), startedAt: String(row.started_at), ...optional("endedAt", row.ended_at),
      ...optional("outcome", row.outcome), ...(row.lease_generation === null ? {} : { leaseGeneration: Number(row.lease_generation) }),
    })); } catch { return []; }
  }
  rollups(): RunRollupV1[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT * FROM run_rollups ORDER BY COALESCE(completed_at,created_at) DESC").all() as Array<Record<string, unknown>>).map(rollupFromRow); }
    catch { return []; }
  }
  runSummaries(input: { runIds?: readonly string[]; statuses?: readonly string[]; providers?: readonly string[]; models?: readonly string[]; branchModes?: readonly string[]; qaEnabled?: boolean; ticketIds?: readonly string[]; createdFrom?: string; createdTo?: string; completedFrom?: string; completedTo?: string; detailLevels?: readonly string[]; limit?: number; offset?: number } = {}): ManagerRunSummaryV1[] {
    if (!this.db) return [];
    try {
      const clauses: string[] = [];
      const parameters: unknown[] = [];
      const values = (column: string, items: readonly string[] | undefined): void => {
        if (!items?.length) return;
        clauses.push(`${column} IN (${items.map(() => "?").join(",")})`);
        parameters.push(...items);
      };
      values("s.run_id", input.runIds); values("s.status", input.statuses); values("s.provider", input.providers);
      values("s.model", input.models); values("s.branch_mode", input.branchModes); values("s.detail_level", input.detailLevels);
      if (input.qaEnabled !== undefined) { clauses.push("s.qa_enabled=?"); parameters.push(input.qaEnabled ? 1 : 0); }
      if (input.createdFrom) { clauses.push("s.created_at>=?"); parameters.push(input.createdFrom); }
      if (input.createdTo) { clauses.push("s.created_at<=?"); parameters.push(input.createdTo); }
      if (input.completedFrom) { clauses.push("s.completed_at>=?"); parameters.push(input.completedFrom); }
      if (input.completedTo) { clauses.push("s.completed_at<=?"); parameters.push(input.completedTo); }
      if (input.ticketIds?.length) {
        clauses.push(`EXISTS (SELECT 1 FROM run_summary_tickets t WHERE t.run_id=s.run_id AND t.ticket_id IN (${input.ticketIds.map(() => "?").join(",")}))`);
        parameters.push(...input.ticketIds);
      }
      const limit = Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? 10_000)));
      const offset = Math.max(0, Math.trunc(input.offset ?? 0));
      const sql = `SELECT s.summary_json FROM run_summaries s${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY s.updated_at DESC,s.run_id LIMIT ? OFFSET ?`;
      parameters.push(limit, offset);
      return (this.db.prepare(sql).all(...parameters) as Array<{ summary_json: string }>).flatMap(row => {
        try { return [JSON.parse(row.summary_json) as ManagerRunSummaryV1]; } catch { return []; }
      });
    } catch { return []; }
  }
  phaseRollups(runIds: readonly string[]): Array<{ runId: string; phase: string; role: string; ticketId: string; durationMs: number; count: number }> {
    if (!this.db || !runIds.length) return [];
    try {
      const ids = [...new Set(runIds)].slice(0, 100);
      return (this.db.prepare(`SELECT * FROM phase_rollups WHERE run_id IN (${ids.map(() => "?").join(",")}) ORDER BY run_id,phase,role,ticket_id`).all(...ids) as Array<Record<string, unknown>>)
        .map(row => ({ runId: String(row.run_id), phase: String(row.phase), role: String(row.role), ticketId: String(row.ticket_id), durationMs: Number(row.duration_ms), count: Number(row.count) }));
    } catch { return []; }
  }
  boundedSpans(runIds: readonly string[], perRunLimit = 100): Record<string, RunSpanV1[]> {
    const result: Record<string, RunSpanV1[]> = {};
    if (!this.db || !runIds.length) return result;
    try {
      const ids = [...new Set(runIds)].slice(0, 5);
      const rows = this.db.prepare(`SELECT * FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY COALESCE(duration_ms,0) DESC,started_at DESC,span_id) AS rn FROM run_spans WHERE run_id IN (${ids.map(() => "?").join(",")})) WHERE rn<=? ORDER BY run_id,rn`).all(...ids, Math.max(1, Math.min(500, perRunLimit))) as Array<DbSpan & { rn: number }>;
      for (const row of rows) (result[row.run_id] ??= []).push(spanFromRow(row));
    } catch { /* older SQLite or schema: bounded detail is unavailable */ }
    return result;
  }
  boundedEvidence(runIds: readonly string[], perRunLimit = 100): Record<string, { spans: RunSpanV1[]; events: Array<{ eventId: string; kind: string; severity?: string; observedAt: string; attributes?: unknown }>; metrics: Array<{ metric: string; value: number; unit?: string; observedAt: string }>; currentState: RunCurrentStateV1[]; executions: ReturnType<ObservabilityReader["executions"]> }> {
    const result: Record<string, { spans: RunSpanV1[]; events: Array<{ eventId: string; kind: string; severity?: string; observedAt: string; attributes?: unknown }>; metrics: Array<{ metric: string; value: number; unit?: string; observedAt: string }>; currentState: RunCurrentStateV1[]; executions: ReturnType<ObservabilityReader["executions"]> }> = {};
    if (!this.db || !runIds.length) return result;
    const ids = [...new Set(runIds)].slice(0, 5); const marks = ids.map(() => "?").join(","); const limit = Math.max(1, Math.min(500, perRunLimit));
    for (const id of ids) result[id] = { spans: [], events: [], metrics: [], currentState: [], executions: [] };
    const spans = this.boundedSpans(ids, limit); for (const id of ids) result[id]!.spans = spans[id] ?? [];
    try {
      const events = this.db.prepare(`SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY run_id ORDER BY observed_at DESC,event_id) rn FROM run_events WHERE run_id IN (${marks})) WHERE rn<=? ORDER BY run_id,observed_at,event_id`).all(...ids, limit) as Array<Record<string, unknown>>;
      for (const row of events) result[String(row.run_id)]?.events.push({ eventId: String(row.event_id), kind: String(row.kind), ...optional("severity", row.severity), observedAt: String(row.observed_at), ...(row.attributes_json ? { attributes: JSON.parse(String(row.attributes_json)) } : {}) });
      const metrics = this.db.prepare(`SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY run_id ORDER BY observed_at DESC,metric) rn FROM metric_samples WHERE run_id IN (${marks})) WHERE rn<=? ORDER BY run_id,observed_at,metric`).all(...ids, limit) as Array<Record<string, unknown>>;
      for (const row of metrics) result[String(row.run_id)]?.metrics.push({ metric: String(row.metric), value: Number(row.value), ...optional("unit", row.unit), observedAt: String(row.observed_at) });
      const states = this.db.prepare(`SELECT * FROM run_current_state WHERE run_id IN (${marks}) ORDER BY run_id,role,stream`).all(...ids) as Array<Record<string, unknown>>;
      for (const row of states) result[String(row.run_id)]?.currentState.push({ version: 1, runId: String(row.run_id), role: String(row.role) as RunCurrentStateV1["role"], stream: String(row.stream), ...optional("executionId", row.execution_id), ...optional("ticketId", row.ticket_id), ...optional("deliveryUnitId", row.delivery_unit_id), ...optional("providerSessionId", row.provider_session_id), ...optional("phase", row.phase), ...optional("activeSpanId", row.active_span_id), ...optional("activeSpanKind", row.active_span_kind), ...optional("lastSignalAt", row.last_signal_at), ...optional("lastSemanticProgressAt", row.last_semantic_progress_at), updatedAt: String(row.updated_at) });
      const executions = this.db.prepare(`SELECT * FROM run_executions WHERE run_id IN (${marks}) ORDER BY run_id,started_at`).all(...ids) as Array<Record<string, unknown>>;
      for (const row of executions) result[String(row.run_id)]?.executions.push({ executionId: String(row.execution_id), startedAt: String(row.started_at), ...optional("endedAt", row.ended_at), ...optional("outcome", row.outcome), ...(row.lease_generation === null ? {} : { leaseGeneration: Number(row.lease_generation) }) });
    } catch { /* bounded evidence remains empty against older schemas */ }
    return result;
  }
  capability(runId: string): { rafiVersion?: string; sources: Record<string, DiagnosticSourceResultV1> } | undefined {
    if (!this.db) return undefined;
    try {
      const row = this.db.prepare("SELECT * FROM run_capabilities WHERE run_id=?").get(runId) as { rafi_version: string | null; capabilities_json: string } | undefined;
      return row ? { ...(row.rafi_version ? { rafiVersion: row.rafi_version } : {}), sources: JSON.parse(row.capabilities_json) } : undefined;
    } catch { return undefined; }
  }
  storage(): { databaseBytes: number; walBytes: number; summaryOnly: boolean } {
    const databaseBytesValue = existsSync(this.path) ? statSync(this.path).size : 0;
    const wal = `${this.path}-wal`;
    let summaryOnly = false;
    if (this.db) try { summaryOnly = (this.db.prepare("SELECT value FROM observability_meta WHERE key='summary_only'").get() as { value?: string } | undefined)?.value === "1"; } catch { /* legacy */ }
    return { databaseBytes: databaseBytesValue, walBytes: existsSync(wal) ? statSync(wal).size : 0, summaryOnly };
  }
}

/** Records Manager session accounting only when observability already exists. It never creates or migrates schema. */
export class ManagerSessionRecorder {
  private readonly db?: Database.Database;
  private readonly v2: boolean;
  constructor(projectDir: string, path = join(resolve(projectDir), OBSERVABILITY_DB_FILE)) {
    if (!existsSync(path)) { this.v2 = false; return; }
    let db: Database.Database | undefined;
    try {
      db = new Database(path, { fileMustExist: true });
      const columns = db.prepare("PRAGMA table_info(manager_sessions)").all() as Array<{ name: string }>;
      if (!columns.some(item => item.name === "session_id")) { db.close(); this.v2 = false; return; }
      this.db = db;
      this.v2 = columns.some(item => item.name === "project_report_digest");
    } catch { db?.close(); this.v2 = false; }
  }
  close(): void { try { this.db?.close(); } catch { /* diagnostics must not fail on accounting */ } }
  record(input: ManagerSessionRecord): void {
    if (!this.db) return;
    try {
      if (this.v2) this.db.prepare(`INSERT INTO manager_sessions(session_id,run_id,provider,started_at,ended_at,outcome,report_digest,input_tokens,output_tokens,cost_usd,error_code,scope,latest_focus_run_id,project_report_digest,lookup_rounds,lookup_operations)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET provider=excluded.provider,ended_at=excluded.ended_at,outcome=excluded.outcome,report_digest=excluded.report_digest,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cost_usd=excluded.cost_usd,error_code=excluded.error_code,scope=excluded.scope,latest_focus_run_id=excluded.latest_focus_run_id,project_report_digest=excluded.project_report_digest,lookup_rounds=excluded.lookup_rounds,lookup_operations=excluded.lookup_operations`)
        .run(input.sessionId, input.runId, input.provider ?? null, input.startedAt, input.endedAt ?? null, input.outcome ?? null, input.reportDigest ?? null, input.inputTokens ?? null, input.outputTokens ?? null, input.costUsd ?? null, input.errorCode ?? null, input.scope ?? null, input.latestFocusRunId ?? null, input.projectReportDigest ?? null, input.lookupRounds ?? 0, input.lookupOperations ?? 0);
      else this.db.prepare(`INSERT INTO manager_sessions(session_id,run_id,provider,started_at,ended_at,outcome,report_digest,input_tokens,output_tokens,cost_usd,error_code)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET provider=excluded.provider,ended_at=excluded.ended_at,outcome=excluded.outcome,report_digest=excluded.report_digest,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cost_usd=excluded.cost_usd,error_code=excluded.error_code`)
        .run(input.sessionId, input.runId, input.provider ?? null, input.startedAt, input.endedAt ?? null, input.outcome ?? null, input.reportDigest ?? null, input.inputTokens ?? null, input.outputTokens ?? null, input.costUsd ?? null, input.errorCode ?? null);
    } catch { /* session accounting is best-effort and never weakens Manager isolation */ }
  }
}

/** One observer is owned by one build process attachment. */
export class RunObserver {
  readonly executionId: string;
  private readonly storage = new AsyncLocalStorage<ObservationContext>();
  private resourceTimer?: NodeJS.Timeout;
  constructor(readonly store: ObservabilityStore, readonly runId: string, input: { executionId?: string; leaseGeneration?: number } = {}) {
    this.executionId = store.beginExecution({ runId, ...input });
    store.abandonPriorExecutionSpans(runId, this.executionId);
  }
  context(): ObservationContext { return this.storage.getStore() ?? { runId: this.runId, executionId: this.executionId, role: "host", stream: "host" }; }
  withContext<T>(values: Partial<ObservationContext>, fn: () => T): T {
    return this.storage.run({ ...this.context(), ...values, runId: this.runId, executionId: this.executionId }, fn);
  }
  async span<T>(kind: string, name: string, fn: () => Promise<T> | T, attributes?: Record<string, unknown>): Promise<T> {
    const parent = this.context();
    const spanId = this.store.startSpan(parent, { kind, name, attributes });
    this.store.updateCurrentState({ runId: this.runId, role: parent.role ?? "host", stream: parent.stream ?? "host", executionId: this.executionId, ticketId: parent.ticketId, deliveryUnitId: parent.deliveryUnitId, providerSessionId: parent.providerSessionId, phase: name, activeSpanId: spanId, activeSpanKind: kind, lastSemanticProgressAt: new Date().toISOString() });
    try {
      const value = await this.withContext({ parentSpanId: spanId }, fn);
      this.store.finishSpan(spanId, { outcome: "completed" });
      return value;
    } catch (error) {
      this.store.finishSpan(spanId, { outcome: "failed", attributes: { error: sanitizeText(String(error)).slice(0, 500) } });
      throw error;
    }
  }
  signal(semantic = false): void {
    const context = this.context();
    const at = new Date().toISOString();
    this.store.updateCurrentState({ runId: this.runId, role: context.role ?? "host", stream: context.stream ?? "host", executionId: this.executionId, ticketId: context.ticketId, deliveryUnitId: context.deliveryUnitId, providerSessionId: context.providerSessionId, lastSignalAt: at, ...(semantic ? { lastSemanticProgressAt: at } : {}) });
  }
  startResourceSampling(): void {
    if (this.resourceTimer) return;
    this.store.sampleProcess(this.context(), 0, true);
    let scheduled = performance.now();
    this.resourceTimer = setInterval(() => {
      const now = performance.now();
      const delay = Math.max(0, now - scheduled - this.store.config.sample_interval_seconds * 1000);
      scheduled = now;
      this.store.sampleProcess(this.context(), delay);
    }, this.store.config.sample_interval_seconds * 1000);
    this.resourceTimer.unref();
  }
  finish(outcome: string, metadata: Omit<Parameters<ObservabilityStore["finalizeRun"]>[1], "status"> = {}): void {
    if (this.resourceTimer) clearInterval(this.resourceTimer);
    this.store.sampleProcess(this.context(), undefined, true);
    this.store.endExecution(this.executionId, outcome);
    this.store.finalizeRun(this.runId, { status: outcome, ...metadata });
    this.store.checkpoint();
  }
}

function spanFromRow(row: DbSpan): RunSpanV1 {
  return { version: 1, spanId: row.span_id, runId: row.run_id, ...optional("executionId", row.execution_id),
    ...optional("parentSpanId", row.parent_span_id), ...optional("providerTurnId", row.provider_turn_id), ...optional("ticketId", row.ticket_id),
    ...optional("deliveryUnitId", row.delivery_unit_id), ...(row.role ? { role: row.role as RunSpanV1["role"] } : {}), ...optional("stream", row.stream),
    ...optional("providerSessionId", row.provider_session_id), kind: row.kind, name: row.name, startedAt: row.started_at,
    ...optional("endedAt", row.ended_at), ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }), ...optional("outcome", row.outcome),
    completionKnown: Boolean(row.completion_known), ...(row.attributes_json ? { attributes: JSON.parse(row.attributes_json) } : {}) };
}
function rollupFromRow(row: Record<string, unknown>): RunRollupV1 {
  return { version: 1, runId: String(row.run_id), ...optional("projectId", row.project_id), status: String(row.status),
    ...optional("branchMode", row.branch_mode), ...(row.qa_enabled === null ? {} : { qaEnabled: Boolean(row.qa_enabled) }),
    ...(row.primary_provider ? { primaryProvider: String(row.primary_provider) as "claude" | "codex" } : {}),
    ...(row.ticket_count === null ? {} : { ticketCount: Number(row.ticket_count) }), ...optional("ticketCountBucket", row.ticket_count_bucket),
    ...optional("ticketSizeBucket", row.ticket_size_bucket), createdAt: String(row.created_at), ...optional("completedAt", row.completed_at),
    calendarMs: Number(row.calendar_ms), activeExecutionMs: Number(row.active_execution_ms), explicitWaitMs: Number(row.explicit_wait_ms),
    attributedMs: Number(row.attributed_ms), unattributedMs: Number(row.unattributed_ms), totals: JSON.parse(String(row.totals_json)) };
}
function addColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function legacySummaryFromRollup(rollup: RunRollupV1, now: Date): ManagerRunSummaryV1 {
  const withoutDigest: Omit<ManagerRunSummaryV1, "digest"> = {
    version: 1, runId: rollup.runId, status: rollup.status, createdAt: rollup.createdAt,
    updatedAt: rollup.completedAt ?? rollup.createdAt, ...(rollup.completedAt ? { completedAt: rollup.completedAt } : {}), activeState: "inactive",
    ticketIds: [], ...(rollup.branchMode ? { branchMode: rollup.branchMode } : {}), ...(rollup.qaEnabled === undefined ? {} : { qaEnabled: rollup.qaEnabled }),
    ...(rollup.primaryProvider ? { provider: rollup.primaryProvider } : {}),
    timing: { calendarMs: rollup.calendarMs, activeExecutionMs: rollup.activeExecutionMs, pausedOfflineMs: Math.max(0, rollup.calendarMs - rollup.activeExecutionMs), explicitWaitMs: rollup.explicitWaitMs, attributedMs: rollup.attributedMs, unattributedMs: rollup.unattributedMs, inclusiveByKind: rollup.totals, exclusiveByKind: rollup.totals },
    counts: { byKind: {}, byOutcome: {} }, usage: { scope: "unavailable" }, retry: {}, topOperations: [], detailLevel: "rollup",
    metricCoverage: { timing: "partial", counts: "unavailable", usage: "unavailable", git: "unavailable" },
    capabilities: { version: 1, sources: { migration: { source: "run_rollup_v1", state: "partial", observedAt: now.toISOString(), detail: "backfilled exactly from V1 rollup; unavailable facts were not reconstructed" } } }, evidenceIds: [`rollup:${rollup.runId}`],
  };
  return { ...withoutDigest, digest: diagnosticDigest(withoutDigest) };
}
function demoteRunSummaries(db: Database.Database, runIds: readonly string[], now: Date, detail: string): void {
  const read = db.prepare("SELECT summary_json FROM run_summaries WHERE run_id=?");
  const write = db.prepare("UPDATE run_summaries SET detail_level='rollup',summary_json=? WHERE run_id=?");
  for (const runId of runIds) {
    try {
      const row = read.get(runId) as { summary_json?: string } | undefined;
      if (!row?.summary_json) continue;
      const summary = JSON.parse(row.summary_json) as ManagerRunSummaryV1;
      const withoutDigest: Omit<ManagerRunSummaryV1, "digest"> = { ...summary, detailLevel: "rollup", capabilities: { ...summary.capabilities, sources: { ...summary.capabilities.sources, retained_detail: { source: "retained_detail", state: "partial", observedAt: now.toISOString(), detail } } } };
      write.run(safeJson({ ...withoutDigest, digest: diagnosticDigest(withoutDigest) }), runId);
    } catch { /* one corrupt summary must not disable retention for other runs */ }
  }
}

function buildStoredRunSummary(
  db: Database.Database,
  spans: RunSpanV1[],
  executions: Array<{ started_at: string; ended_at: string | null }>,
  rollup: RunRollupV1,
  input: { status: string; branchMode?: string; qaEnabled?: boolean; primaryProvider?: "claude" | "codex"; model?: string; ticketIds?: string[]; deliveryUnit?: string; checkpoint?: string; failureCategory?: string; updatedAt?: string; git?: ManagerRunSummaryV1["git"] },
  summaryOnly: boolean,
  now: Date,
): ManagerRunSummaryV1 {
  let existing: ManagerRunSummaryV1 | undefined;
  try { const row = db.prepare("SELECT summary_json FROM run_summaries WHERE run_id=?").get(rollup.runId) as { summary_json?: string } | undefined; if (row?.summary_json) existing = JSON.parse(row.summary_json) as ManagerRunSummaryV1; } catch { /* first summary */ }
  const completedAt = rollup.completedAt ?? now.toISOString();
  const inclusiveByKind = durationUnionsByKind(spans, completedAt);
  const exclusiveByKind = exclusiveDurationTotals(spans, completedAt);
  const byKind: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  try {
    const phases = db.prepare("SELECT phase,SUM(count) count FROM phase_rollups WHERE run_id=? GROUP BY phase").all(rollup.runId) as Array<{ phase: string; count: number }>;
    for (const phase of phases) byKind[phase.phase] = Number(phase.count);
  } catch { /* optional legacy table */ }
  for (const span of spans) {
    if (byKind[span.kind] === undefined) byKind[span.kind] = spans.filter(item => item.kind === span.kind).length;
    const outcome = span.outcome ?? (span.endedAt ? "unknown" : "open");
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
  }
  const measuredUsage = storedUsage(spans);
  const usage = measuredUsage.scope === "unavailable" && existing?.usage ? existing.usage : measuredUsage;
  const topOperations = spans.filter(span => span.durationMs !== undefined).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0) || a.spanId.localeCompare(b.spanId)).slice(0, 10)
    .map(span => ({ kind: span.kind, name: span.name.slice(0, 160), durationMs: span.durationMs ?? 0, ...(span.outcome ? { outcome: span.outcome } : {}), evidenceId: `span:${span.spanId}` }));
  let capabilitySources: Record<string, DiagnosticSourceResultV1> = {};
  try { capabilitySources = JSON.parse((db.prepare("SELECT capabilities_json FROM run_capabilities WHERE run_id=?").get(rollup.runId) as { capabilities_json?: string } | undefined)?.capabilities_json ?? "{}"); } catch { /* optional */ }
  const timingState = summaryOnly ? "partial" as const : "available" as const;
  const usageState = usage.scope === "unavailable" ? "unavailable" as const : summaryOnly ? "partial" as const : "available" as const;
  const withoutDigest: Omit<ManagerRunSummaryV1, "digest"> = {
    version: 1, runId: rollup.runId, status: input.status, createdAt: rollup.createdAt, updatedAt: input.updatedAt ?? completedAt,
    ...(rollup.completedAt ? { completedAt: rollup.completedAt } : {}), ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}), activeState: "inactive",
    ticketIds: [...new Set(input.ticketIds ?? existing?.ticketIds ?? [])].sort(), ...(input.deliveryUnit ?? existing?.deliveryUnit ? { deliveryUnit: input.deliveryUnit ?? existing?.deliveryUnit } : {}),
    ...(input.branchMode ?? existing?.branchMode ? { branchMode: input.branchMode ?? existing?.branchMode } : {}), ...(input.qaEnabled === undefined ? existing?.qaEnabled === undefined ? {} : { qaEnabled: existing.qaEnabled } : { qaEnabled: input.qaEnabled }),
    ...(input.primaryProvider ?? existing?.provider ? { provider: input.primaryProvider ?? existing?.provider } : {}), ...(input.model ?? existing?.model ? { model: input.model ?? existing?.model } : {}),
    timing: { calendarMs: rollup.calendarMs, activeExecutionMs: rollup.activeExecutionMs,
      pausedOfflineMs: Math.max(0, rollup.calendarMs - rollup.activeExecutionMs), explicitWaitMs: rollup.explicitWaitMs,
      attributedMs: rollup.attributedMs, unattributedMs: rollup.unattributedMs, inclusiveByKind, exclusiveByKind },
    counts: { byKind, byOutcome, qaAttempts: byKind.qa_attempt ?? 0, qaFailures: spans.filter(span => span.kind === "qa_attempt" && ["failed", "rejected"].includes(span.outcome ?? "")).length,
      fixes: (byKind.qa_fix ?? 0) + (byKind.fix ?? 0), retries: byKind.retry ?? 0, tools: byKind.tool ?? 0,
      providerTurns: byKind.provider_turn ?? 0, waits: [...WAIT_SUMMARY_KINDS].reduce((sum, kind) => sum + (byKind[kind] ?? 0), 0), executions: executions.length },
    usage, retry: { observedMs: inclusiveByKind.retry ?? 0, reportedDelayMs: spans.filter(span => span.kind === "retry").reduce((sum, span) => sum + finiteAttribute(span.attributes?.reportedDelayMs), 0) },
    ...(input.failureCategory ?? existing?.failureCategory ? { failureCategory: input.failureCategory ?? existing?.failureCategory } : {}), topOperations: topOperations.length ? topOperations : existing?.topOperations ?? [], ...(input.git ?? existing?.git ? { git: input.git ?? existing?.git } : {}),
    detailLevel: summaryOnly ? "rollup" : "detailed",
    metricCoverage: { timing: timingState, counts: timingState, usage: usageState, git: input.git ? "available" : "unavailable" },
    capabilities: { version: 1, sources: capabilitySources }, evidenceIds: topOperations.map(item => item.evidenceId),
  };
  return { ...withoutDigest, digest: diagnosticDigest(withoutDigest) };
}

const WAIT_SUMMARY_KINDS = new Set(["user_wait", "dependency_wait", "external_ci_wait"]);
function durationUnionsByKind(spans: RunSpanV1[], fallbackEnd: string): Record<string, number> {
  const grouped = new Map<string, number[][]>();
  for (const span of spans) (grouped.get(span.kind) ?? (grouped.set(span.kind, []), grouped.get(span.kind)!)).push([Date.parse(span.startedAt), Date.parse(span.endedAt ?? fallbackEnd)]);
  return Object.fromEntries([...grouped].map(([kind, intervals]) => [kind, unionMs(intervals)]));
}
function exclusiveDurationTotals(spans: RunSpanV1[], fallbackEnd: string): Record<string, number> {
  const children = new Map<string, number[][]>();
  for (const span of spans) if (span.parentSpanId) (children.get(span.parentSpanId) ?? (children.set(span.parentSpanId, []), children.get(span.parentSpanId)!)).push([Date.parse(span.startedAt), Date.parse(span.endedAt ?? fallbackEnd)]);
  const grouped = new Map<string, number[][]>();
  for (const span of spans) {
    const start = Date.parse(span.startedAt); const end = Date.parse(span.endedAt ?? fallbackEnd);
    const cuts = (children.get(span.spanId) ?? []).map(([a, b]) => [Math.max(a!, start), Math.min(b!, end)]).filter(([a, b]) => b! >= a!);
    const segments = subtractDurationIntervals([start, end], cuts);
    grouped.set(span.kind, [...(grouped.get(span.kind) ?? []), ...segments]);
  }
  return Object.fromEntries([...grouped].map(([kind, intervals]) => [kind, unionMs(intervals)]));
}
function subtractDurationIntervals(base: number[], cuts: number[][]): number[][] {
  const sorted = cuts.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!); const merged: number[][] = [];
  for (const cut of sorted) { const last = merged.at(-1); if (!last || cut[0]! > last[1]!) merged.push([...cut]); else last[1] = Math.max(last[1]!, cut[1]!); }
  const result: number[][] = []; let cursor = base[0]!;
  for (const cut of merged) { if (cut[0]! > cursor) result.push([cursor, cut[0]!]); cursor = Math.max(cursor, cut[1]!); }
  if (cursor < base[1]!) result.push([cursor, base[1]!]);
  return result;
}
function storedUsage(spans: RunSpanV1[]): ManagerRunSummaryV1["usage"] {
  const delta = { inputTokens: 0, outputTokens: 0, totalTokens: 0, authoritativeCostUsd: 0 };
  const observed = { inputTokens: false, outputTokens: false, totalTokens: false, authoritativeCostUsd: false };
  let deltaObserved = false;
  const cumulative = new Map<string, { inputTokens?: number; outputTokens?: number; totalTokens?: number; authoritativeCostUsd?: number }>();
  for (const span of spans.filter(item => item.kind === "provider_turn")) {
    const attributes = span.attributes ?? {};
    const turn = isRecord(attributes.turnDelta) ? attributes.turnDelta : isRecord(attributes.usage) && attributes.usage.scope === "turn-delta" ? attributes.usage : undefined;
    if (turn && [turn.inputTokens, turn.outputTokens, turn.totalTokens, turn.costUsd].some(item => optionalFinite(item) !== undefined)) {
      deltaObserved = true;
      const input = optionalFinite(turn.inputTokens); const output = optionalFinite(turn.outputTokens); const total = optionalFinite(turn.totalTokens); const cost = optionalFinite(turn.costUsd);
      if (input !== undefined) { observed.inputTokens = true; delta.inputTokens += input; }
      if (output !== undefined) { observed.outputTokens = true; delta.outputTokens += output; }
      if (total !== undefined) { observed.totalTokens = true; delta.totalTokens += total; }
      else if (input !== undefined && output !== undefined) { observed.totalTokens = true; delta.totalTokens += input + output; }
      if (cost !== undefined) { observed.authoritativeCostUsd = true; delta.authoritativeCostUsd += cost; }
      continue;
    }
    const session = isRecord(attributes.cumulativeUsage) ? attributes.cumulativeUsage : isRecord(attributes.usage) && attributes.usage.scope === "session-cumulative" ? attributes.usage : undefined;
    if (session && span.providerSessionId) cumulative.set(span.providerSessionId, { inputTokens: optionalFinite(session.inputTokens), outputTokens: optionalFinite(session.outputTokens), totalTokens: optionalFinite(session.totalTokens), authoritativeCostUsd: optionalFinite(session.costUsd) });
  }
  if (!deltaObserved && !cumulative.size) return { scope: "unavailable" };
  const values = [...cumulative.values()];
  const inputValues = values.map(item => item.inputTokens).filter((item): item is number => item !== undefined);
  const outputValues = values.map(item => item.outputTokens).filter((item): item is number => item !== undefined);
  const totalValues = values.map(item => item.totalTokens).filter((item): item is number => item !== undefined);
  const costValues = values.map(item => item.authoritativeCostUsd).filter((item): item is number => item !== undefined);
  const result = {
    ...(observed.inputTokens || inputValues.length ? { inputTokens: delta.inputTokens + inputValues.reduce((sum, item) => sum + item, 0) } : {}),
    ...(observed.outputTokens || outputValues.length ? { outputTokens: delta.outputTokens + outputValues.reduce((sum, item) => sum + item, 0) } : {}),
    ...(observed.totalTokens || totalValues.length ? { totalTokens: delta.totalTokens + totalValues.reduce((sum, item) => sum + item, 0) } : {}),
    ...(observed.authoritativeCostUsd || costValues.length ? { authoritativeCostUsd: delta.authoritativeCostUsd + costValues.reduce((sum, item) => sum + item, 0) } : {}),
  };
  return { ...result, scope: deltaObserved && cumulative.size ? "mixed" : deltaObserved ? "turn-deltas" : "session-cumulative-deduplicated" };
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function optionalFinite(value: unknown): number | undefined { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : undefined; }
function finiteAttribute(value: unknown): number { return optionalFinite(value) ?? 0; }
function optional<K extends string>(key: K, value: unknown): { [P in K]?: string } { return value === null || value === undefined ? {} : { [key]: String(value) } as { [P in K]?: string }; }
function sanitizeText(value: string): string {
  return value
    .replace(/\b(?:sk|ghp|glpat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
export function sanitizeDiagnosticValue(value: unknown): unknown { return sanitizeValue(value); }
function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return sanitizeText(value).slice(0, 4096);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeValue(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/^(prompt|response|reasoning|transcript|credential|secret|token|password|api[_-]?key)$/i.test(key))
    .slice(0, 100).map(([key, item]) => [key, sanitizeValue(item, depth + 1)]));
  return value;
}
function safeJson(value: unknown): string { return JSON.stringify(value ?? null); }
export function diagnosticDigest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
function processStartIdentity(pid: number): string { try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21] ?? "unavailable"; } catch { return "unavailable"; } }
function databaseBytes(path: string): number { return [path, `${path}-wal`, `${path}-shm`].reduce((sum, item) => sum + (existsSync(item) ? statSync(item).size : 0), 0); }
function fileSize(path: string): number { try { return statSync(path).size; } catch { return 0; } }
function safeOwnedLogPath(root: string, path: string): boolean { const target = resolve(path); return target.startsWith(`${root}${sep}`) && (target.endsWith(".jsonl") || target.endsWith(".jsonl.gz")); }
function directoryIndexedLogBytes(db: Database.Database): number { return Number((db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM log_files").get() as { bytes: number }).bytes); }
function availableDiskBytes(path: string): number | undefined {
  try { const stats = statfsSync(path); return Number(stats.bavail) * Number(stats.bsize); }
  catch { return undefined; }
}
function unionMs(intervals: number[][]): number {
  const sorted = intervals.filter(item => item.length === 2 && item.every(Number.isFinite) && item[1]! >= item[0]!).sort((a, b) => a[0]! - b[0]!);
  let total = 0; let start: number | undefined; let end = 0;
  for (const [a, b] of sorted as Array<[number, number]>) { if (start === undefined) { start = a; end = b; } else if (a <= end) end = Math.max(end, b); else { total += end - start; start = a; end = b; } }
  return total + (start === undefined ? 0 : end - start);
}
function ensureObservabilityIgnore(projectDir: string): void {
  const localExclude = join(projectDir, ".git", "info", "exclude");
  const path = existsSync(localExclude) ? localExclude : join(projectDir, ".gitignore");
  const entries = [OBSERVABILITY_DB_FILE, `${OBSERVABILITY_DB_FILE}-wal`, `${OBSERVABILITY_DB_FILE}-shm`];
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const missing = entries.filter(entry => !existing.split(/\r?\n/).includes(entry));
  if (missing.length) appendFileSync(path, `${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, "utf8");
}
