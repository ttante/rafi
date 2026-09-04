import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type {
  BuildRecoveryDecisionReceipt,
  ContextSample,
  ContinuityCheckpoint,
  ContinuityDelta,
  ContinuityEvent,
  ContinuityHead,
  ContinuityHeadState,
  HandoffLineage,
  HandoffManifestV1,
  LiveSettingsAcknowledgment,
  OperationLifecycle,
  PendingHumanDecision,
  ProviderSessionRefV1,
  RecoveryAttemptOutcome,
  RecoveryAttemptReceipt,
  ResolvedAutonomyPolicy,
  ResolvedAgentSettings,
  SessionUsageSample,
  StructuredInterruption,
  SupervisorState,
  WorkflowIssue,
} from "rafi-spec";
import { providerSessionKey } from "./sessionIdentity.js";
import type { BranchResumeSession } from "./branch/resume.js";

export const WORKFLOW_DB_FILE = ".rafi/recovery.sqlite3";
export type WorkflowKind = "plan" | "ticket-plan" | "ticket-populate" | "uninstall" | "build" | "qa-remediation" | "recovery" | "legacy";
export type WorkflowRunStatus = "running" | "paused" | "blocked" | "completed" | "failed" | "cancelled" | "superseded";

export interface WorkflowRunSnapshot {
  runId: string;
  kind: WorkflowKind;
  status: WorkflowRunStatus;
  checkpoint: string;
  originalWork: unknown;
  remainingWork: unknown;
  state: Record<string, unknown>;
  leaseGeneration?: number;
  legacy: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OperationRecord {
  idempotencyKey: string;
  runId: string;
  kind: string;
  status: OperationLifecycle;
  intent: unknown;
  result?: unknown;
  externalId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectLease {
  owner: string;
  generation: number;
  pid: number;
  host: string;
  processStart: string;
  heartbeatAt: string;
  runId: string;
}

/** Read the current project lease without creating or migrating recovery state. */
export function readCurrentWorkflowLease(projectDir: string): ProjectLease | undefined {
  const path = join(resolve(projectDir), WORKFLOW_DB_FILE);
  if (!existsSync(path)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT * FROM project_lease WHERE singleton=1").get() as DbLease | undefined;
    return row ? { owner: row.owner, generation: row.generation, pid: row.pid, host: row.host, processStart: row.process_start, heartbeatAt: row.heartbeat_at, runId: row.run_id } : undefined;
  } catch (error) {
    if (String(error).includes("no such table")) return undefined;
    throw error;
  } finally {
    db?.close();
  }
}

/** Heartbeat-only writer: one conditional UPDATE and no migrations, imports, events, or snapshots. */
export function heartbeatCurrentWorkflowLease(projectDir: string, lease: ProjectLease, now = new Date()): ProjectLease {
  const path = join(resolve(projectDir), WORKFLOW_DB_FILE);
  if (!existsSync(path)) throw new Error("workflow recovery database not found");
  const db = new Database(path, { fileMustExist: true });
  try {
    const at = now.toISOString();
    const result = db.prepare("UPDATE project_lease SET heartbeat_at=? WHERE singleton=1 AND owner=? AND generation=? AND run_id=?")
      .run(at, lease.owner, lease.generation, lease.runId);
    if (result.changes !== 1) throw new Error("workflow lease ownership changed");
    return { ...lease, heartbeatAt: at };
  } finally { db.close(); }
}
export interface PublicationTransaction { transactionId: string; runId: string; status: "prepared" | "staged" | "tracker_committed" | "published" | "committed" | "rolled_back"; intent: unknown; previousDigests: unknown; createdAt: string; updatedAt: string }
export interface CompactionAttemptRecord {
  idempotencyKey: string;
  runId: string;
  role: "builder" | "qa";
  providerSessionId?: string;
  sessionRef?: ProviderSessionRefV1;
  sessionKey?: string;
  crossingKey: string;
  status: "started" | "succeeded" | "failed";
  beforeSample?: ContextSample;
  afterSample?: ContextSample;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface RoleMutationLease {
  runId: string;
  role: "builder" | "qa";
  generation: number;
  providerSessionId: string;
  sessionRef?: ProviderSessionRefV1;
  sessionKey?: string;
  movedAt: string;
}

/** Authoritative persistence for every resumable workflow in a project. */
export class WorkflowDb {
  readonly path: string;
  private readonly db: Database.Database;

  constructor(readonly projectDir: string, path = join(resolve(projectDir), WORKFLOW_DB_FILE)) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    ensureRecoveryGitignore(resolve(projectDir));
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.importLegacyOnce();
  }

  close(): void { this.db.close(); }

  /** Ensure non-workflow build records can use the same durable event store. */
  ensureRun(runId: string, kind: WorkflowKind = "build", now = new Date()): WorkflowRunSnapshot {
    const existing = this.getRun(runId);
    if (existing) return existing;
    const at = now.toISOString();
    this.db.transaction(() => {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO workflow_runs(run_id,kind,status,checkpoint,original_work_json,remaining_work_json,state_json,legacy,created_at,updated_at)
        VALUES(?,?,'running','durable-baseline','{}','{}','{}',0,?,?)`).run(runId, kind, at, at);
      if (inserted.changes) this.insertEvent(runId, "durable_baseline", "durable-baseline", { source: "host" }, at);
    })();
    return this.getRun(runId)!;
  }

  createRun(input: { runId?: string; kind: WorkflowKind; checkpoint?: string; originalWork?: unknown; remainingWork?: unknown; state?: Record<string, unknown>; legacy?: boolean }, now = new Date()): WorkflowRunSnapshot {
    const at = now.toISOString();
    const run: WorkflowRunSnapshot = {
      runId: input.runId ?? randomUUID(), kind: input.kind, status: "running", checkpoint: input.checkpoint ?? "created",
      originalWork: input.originalWork ?? {}, remainingWork: input.remainingWork ?? input.originalWork ?? {}, state: input.state ?? {},
      legacy: Boolean(input.legacy), createdAt: at, updatedAt: at,
    };
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workflow_runs(run_id,kind,status,checkpoint,original_work_json,remaining_work_json,state_json,legacy,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(run.runId, run.kind, run.status, run.checkpoint, json(run.originalWork), json(run.remainingWork), json(run.state), run.legacy ? 1 : 0, at, at);
      this.insertEvent(run.runId, "run_created", run.checkpoint, { kind: run.kind }, at);
    })();
    return run;
  }

  getRun(runId: string): WorkflowRunSnapshot | undefined {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE run_id=?").get(runId) as DbRun | undefined;
    return row ? rowToRun(row) : undefined;
  }

  activeRuns(): WorkflowRunSnapshot[] {
    return (this.db.prepare("SELECT * FROM workflow_runs WHERE status IN ('running','paused','blocked') ORDER BY created_at").all() as DbRun[]).map(rowToRun);
  }

  resumableRuns(kind?: WorkflowKind): WorkflowRunSnapshot[] {
    const rows = kind
      ? this.db.prepare("SELECT * FROM workflow_runs WHERE kind=? AND status NOT IN ('completed','cancelled','superseded') ORDER BY created_at").all(kind)
      : this.db.prepare("SELECT * FROM workflow_runs WHERE status NOT IN ('completed','cancelled','superseded') ORDER BY created_at").all();
    return (rows as DbRun[]).map(rowToRun);
  }

  transition(runId: string, update: { status?: WorkflowRunStatus; checkpoint: string; remainingWork?: unknown; state?: Record<string, unknown>; event?: string; payload?: unknown }, now = new Date()): WorkflowRunSnapshot {
    const at = now.toISOString();
    return this.db.transaction(() => {
      const current = this.getRun(runId); if (!current) throw new Error(`workflow run not found: ${runId}`);
      const next = { ...current, status: update.status ?? current.status, checkpoint: update.checkpoint, remainingWork: update.remainingWork ?? current.remainingWork, state: update.state ?? current.state, updatedAt: at };
      this.db.prepare("UPDATE workflow_runs SET status=?,checkpoint=?,remaining_work_json=?,state_json=?,updated_at=? WHERE run_id=?")
        .run(next.status, next.checkpoint, json(next.remainingWork), json(next.state), at, runId);
      this.insertEvent(runId, update.event ?? "checkpoint", update.checkpoint, update.payload ?? {}, at);
      return next;
    })();
  }

  events(runId: string): Array<{ sequence: number; type: string; checkpoint: string; payload: unknown; at: string }> {
    const rows = this.db.prepare("SELECT sequence,event_type,checkpoint,payload_json,created_at FROM workflow_events WHERE run_id=? ORDER BY sequence").all(runId) as Array<{ sequence: number; event_type: string; checkpoint: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ sequence: row.sequence, type: row.event_type, checkpoint: row.checkpoint, payload: parseJson(row.payload_json), at: row.created_at }));
  }

  recordSettings(runId: string, role: string, boundary: number, settings: ResolvedAgentSettings, now = new Date()): void {
    this.ensureRun(runId, "build", now);
    this.db.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO role_settings(run_id,role,boundary,revision,settings_json,created_at) VALUES(?,?,?,?,?,?)")
        .run(runId, role, boundary, settings.settings_revision, json(settings), now.toISOString());
      this.insertEvent(runId, "settings_boundary", `role:${role}:${boundary}`, { revision: settings.settings_revision }, now.toISOString());
    })();
  }

  recordProjectSettingsRevision(revision: number, defaults: unknown, now = new Date()): void {
    this.db.prepare("INSERT OR REPLACE INTO project_settings_revisions(revision,defaults_json,created_at) VALUES(?,?,?)").run(revision, json(defaults), now.toISOString());
  }

  recordTelemetry(runId: string, snapshot: unknown, now = new Date()): void {
    this.ensureRun(runId, "build", now);
    this.db.prepare("INSERT INTO workflow_telemetry(run_id,snapshot_json,created_at) VALUES(?,?,?)").run(runId, json(snapshot), now.toISOString());
  }

  recordContextSample(sample: ContextSample): void {
    this.ensureRun(sample.runId);
    const session = sessionParts(sample.sessionRef, sample.providerSessionId, sample.sessionKey);
    if (session.ref) this.recordProviderSessionBinding(session.ref, new Date(sample.observedAt));
    const normalized = { ...sample, ...(session.ref ? { sessionRef: session.ref } : {}), ...(session.key ? { sessionKey: session.key } : {}) };
    this.db.prepare(`INSERT INTO context_samples(run_id,role,provider_session_id,session_key,session_ref_json,sample_json,observed_at)
      VALUES(?,?,?,?,?,?,?)`).run(sample.runId, sample.role, session.id, session.key, session.refJson, json(normalized), sample.observedAt);
  }

  contextSamples(runId: string, role?: "builder" | "qa"): ContextSample[] {
    const rows = role
      ? this.db.prepare("SELECT sample_json FROM context_samples WHERE run_id=? AND role=? ORDER BY sample_id").all(runId, role)
      : this.db.prepare("SELECT sample_json FROM context_samples WHERE run_id=? ORDER BY sample_id").all(runId);
    return (rows as Array<{ sample_json: string }>).map((row) => parseJson(row.sample_json) as ContextSample);
  }

  recordSessionUsage(sample: SessionUsageSample): void {
    this.ensureRun(sample.runId);
    const session = sessionParts(sample.sessionRef, sample.providerSessionId, sample.sessionKey);
    if (session.ref) this.recordProviderSessionBinding(session.ref, new Date(sample.observedAt));
    const normalized = { ...sample, ...(session.ref ? { sessionRef: session.ref } : {}), ...(session.key ? { sessionKey: session.key } : {}) };
    this.db.prepare(`INSERT INTO session_usage_samples(run_id,role,provider_session_id,session_key,session_ref_json,sample_json,observed_at)
      VALUES(?,?,?,?,?,?,?)`).run(sample.runId, sample.role, session.id, session.key, session.refJson, json(normalized), sample.observedAt);
  }

  sessionUsageSamples(runId: string, role?: "builder" | "qa"): SessionUsageSample[] {
    const rows = role
      ? this.db.prepare("SELECT sample_json FROM session_usage_samples WHERE run_id=? AND role=? ORDER BY sample_id").all(runId, role)
      : this.db.prepare("SELECT sample_json FROM session_usage_samples WHERE run_id=? ORDER BY sample_id").all(runId);
    return (rows as Array<{ sample_json: string }>).map((row) => parseJson(row.sample_json) as SessionUsageSample);
  }

  acknowledgeSettings(ack: LiveSettingsAcknowledgment): void {
    this.ensureRun(ack.runId);
    const session = sessionParts(ack.sessionRef, ack.providerSessionId, ack.sessionKey);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO live_settings_acknowledgments(run_id,role,provider_session_id,session_key,session_ref_json,revision,acknowledged_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,role,revision) DO UPDATE SET provider_session_id=excluded.provider_session_id,session_key=excluded.session_key,session_ref_json=excluded.session_ref_json,acknowledged_at=excluded.acknowledged_at`)
        .run(ack.runId, ack.role, session.id, session.key, session.refJson, ack.revision, ack.acknowledgedAt);
      this.insertEvent(ack.runId, "live_settings_acknowledged", `settings:${ack.revision}`, { role: ack.role, providerSessionId: session.id, sessionKey: session.key }, ack.acknowledgedAt);
    })();
  }

  settingsAcknowledgments(revision: number): LiveSettingsAcknowledgment[] {
    const rows = this.db.prepare("SELECT * FROM live_settings_acknowledgments WHERE revision=? ORDER BY acknowledged_at").all(revision) as Array<{
      run_id: string; role: "builder" | "qa"; provider_session_id: string | null; session_key: string | null; session_ref_json: string | null; revision: number; acknowledged_at: string;
    }>;
    return rows.map((row) => ({ runId: row.run_id, role: row.role, ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}), ...(row.session_key ? { sessionKey: row.session_key } : {}), ...(row.session_ref_json ? { sessionRef: parseJson(row.session_ref_json) as ProviderSessionRefV1 } : {}), revision: row.revision, acknowledgedAt: row.acknowledged_at }));
  }

  appendContinuityEvent(input: {
    runId: string;
    role: "builder" | "qa" | "host";
    kind: string;
    payload: unknown;
    authoritativeStateRevision: number;
    sessionRef?: ProviderSessionRefV1;
    sessionKey?: string;
  }, now = new Date()): ContinuityEvent {
    this.ensureRun(input.runId, "build", now);
    const at = now.toISOString();
    const safePayload = sanitizeContinuityValue(input.payload);
    const session = sessionParts(input.sessionRef, undefined, input.sessionKey);
    const digest = digestJson({ runId: input.runId, role: input.role, kind: input.kind, payload: safePayload, authoritativeStateRevision: input.authoritativeStateRevision, sessionKey: session.key, at });
    const result = this.db.prepare(`INSERT INTO continuity_events(run_id,role,kind,payload_json,digest,authoritative_state_revision,session_key,session_ref_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(input.runId, input.role, input.kind, json(safePayload), digest, input.authoritativeStateRevision, session.key, session.refJson, at);
    return { sequence: Number(result.lastInsertRowid), runId: input.runId, role: input.role, kind: input.kind, payload: safePayload, digest, authoritativeStateRevision: input.authoritativeStateRevision, createdAt: at, ...(session.key ? { sessionKey: session.key } : {}), ...(session.ref ? { sessionRef: session.ref } : {}) };
  }

  continuityEvents(runId: string, afterSequence = 0): ContinuityEvent[] {
    const rows = this.db.prepare("SELECT * FROM continuity_events WHERE run_id=? AND sequence>? ORDER BY sequence").all(runId, afterSequence) as DbContinuityEvent[];
    return rows.map(continuityEventFromRow);
  }

  publishContinuityCheckpoint(input: {
    runId: string;
    role: "builder" | "qa";
    delta: ContinuityDelta;
    state?: ContinuityHeadState;
    authoritativeStateRevision: number;
    sessionRef?: ProviderSessionRefV1;
    sessionKey?: string;
  }, now = new Date()): ContinuityCheckpoint {
    this.ensureRun(input.runId, "build", now);
    return this.db.transaction(() => {
      const at = now.toISOString();
      const previous = this.continuityHead(input.runId, input.role);
      const latestEvent = this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM continuity_events WHERE run_id=?").get(input.runId) as { sequence: number };
      const safeDelta = sanitizeContinuityValue(input.delta) as unknown as ContinuityDelta;
      const session = sessionParts(input.sessionRef, undefined, input.sessionKey);
      const digest = digestJson({ runId: input.runId, role: input.role, sequence: latestEvent.sequence, predecessorDigest: previous?.digest, delta: safeDelta, authoritativeStateRevision: input.authoritativeStateRevision, sessionKey: session.key });
      const result = this.db.prepare(`INSERT INTO continuity_checkpoints(run_id,role,event_sequence,state,delta_json,digest,predecessor_digest,authoritative_state_revision,session_key,session_ref_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(input.runId, input.role, latestEvent.sequence, input.state ?? "current", json(safeDelta), digest, previous?.digest ?? null, input.authoritativeStateRevision, session.key, session.refJson, at);
      const checkpoint: ContinuityCheckpoint = {
        checkpointId: Number(result.lastInsertRowid), runId: input.runId, role: input.role,
        sequence: latestEvent.sequence, state: input.state ?? "current", delta: safeDelta, digest,
        ...(previous ? { predecessorDigest: previous.digest } : {}),
        authoritativeStateRevision: input.authoritativeStateRevision, createdAt: at,
        ...(session.key ? { sessionKey: session.key } : {}), ...(session.ref ? { sessionRef: session.ref } : {}),
      };
      this.upsertContinuityHead({ runId: input.runId, role: input.role, state: checkpoint.state, sequence: checkpoint.sequence, digest, authoritativeStateRevision: input.authoritativeStateRevision, updatedAt: at });
      this.refreshRunContinuityHead(input.runId, input.authoritativeStateRevision, at);
      this.insertEvent(input.runId, "continuity_checkpoint", `continuity:${input.role}`, { checkpointId: checkpoint.checkpointId, digest, state: checkpoint.state }, at);
      return checkpoint;
    })();
  }

  continuityCheckpoints(runId: string, role?: "builder" | "qa"): ContinuityCheckpoint[] {
    const rows = role
      ? this.db.prepare("SELECT * FROM continuity_checkpoints WHERE run_id=? AND role=? ORDER BY checkpoint_id").all(runId, role)
      : this.db.prepare("SELECT * FROM continuity_checkpoints WHERE run_id=? ORDER BY checkpoint_id").all(runId);
    return (rows as DbContinuityCheckpoint[]).map(continuityCheckpointFromRow);
  }

  latestContinuityCheckpoint(runId: string, role: "builder" | "qa"): ContinuityCheckpoint | undefined {
    const row = this.db.prepare("SELECT * FROM continuity_checkpoints WHERE run_id=? AND role=? ORDER BY checkpoint_id DESC LIMIT 1").get(runId, role) as DbContinuityCheckpoint | undefined;
    return row ? continuityCheckpointFromRow(row) : undefined;
  }

  continuityHead(runId: string, role: "builder" | "qa" | "run"): ContinuityHead | undefined {
    const row = this.db.prepare("SELECT * FROM continuity_heads WHERE run_id=? AND role=?").get(runId, role) as DbContinuityHead | undefined;
    return row ? continuityHeadFromRow(row) : undefined;
  }

  setContinuityHeadState(runId: string, role: "builder" | "qa", state: ContinuityHeadState, now = new Date()): ContinuityHead | undefined {
    const head = this.continuityHead(runId, role);
    if (!head) return undefined;
    const next = { ...head, state, updatedAt: now.toISOString() };
    this.upsertContinuityHead(next);
    this.refreshRunContinuityHead(runId, head.authoritativeStateRevision, next.updatedAt);
    return next;
  }

  recordSession(runId: string, role: string, stream: string, session: string | ProviderSessionRefV1 | undefined, transition: string, settings: ResolvedAgentSettings, now = new Date()): void {
    this.ensureRun(runId, "build", now);
    const scoped = sessionParts(typeof session === "object" ? session : undefined, typeof session === "string" ? session : undefined);
    if (scoped.ref) this.recordProviderSessionBinding(scoped.ref, now);
    const duplicate = this.db.prepare(`SELECT 1 FROM provider_sessions WHERE run_id=? AND role=? AND stream=? AND provider=? AND model=?
      AND COALESCE(session_id,'')=COALESCE(?,'') AND COALESCE(session_key,'')=COALESCE(?,'') AND transition=? AND settings_revision=? ORDER BY id DESC LIMIT 1`)
      .get(runId, role, stream, settings.make, settings.model, scoped.id, scoped.key, transition, settings.settings_revision);
    if (duplicate) return;
    this.db.prepare(`INSERT INTO provider_sessions(run_id,role,stream,provider,model,session_id,session_key,session_ref_json,transition,settings_revision,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(runId, role, stream, settings.make, settings.model, scoped.id, scoped.key, scoped.refJson, transition, settings.settings_revision, now.toISOString());
  }

  providerSessionRefs(runId: string, role?: string): ProviderSessionRefV1[] {
    const rows = role
      ? this.db.prepare("SELECT session_ref_json FROM provider_sessions WHERE run_id=? AND role=? AND session_ref_json IS NOT NULL ORDER BY id").all(runId, role)
      : this.db.prepare("SELECT session_ref_json FROM provider_sessions WHERE run_id=? AND session_ref_json IS NOT NULL ORDER BY id").all(runId);
    const refs = (rows as Array<{ session_ref_json: string }>).map((row) => parseJson(row.session_ref_json) as ProviderSessionRefV1);
    return [...new Map(refs.map((ref) => [providerSessionKey(ref), ref])).values()];
  }

  /** Project-local lookup used to resolve compatibility raw IDs into scoped references. */
  recordProviderSessionBinding(ref: ProviderSessionRefV1, now = new Date()): void {
    const key = providerSessionKey(ref);
    this.db.prepare(`INSERT INTO provider_session_bindings(session_key,provider_session_id,role,session_ref_json,observed_at)
      VALUES(?,?,?,?,?) ON CONFLICT(session_key) DO UPDATE SET session_ref_json=excluded.session_ref_json,observed_at=excluded.observed_at`)
      .run(key, ref.sessionId, ref.role, json(ref), now.toISOString());
  }

  providerSessionBindings(sessionId?: string, role?: string): ProviderSessionRefV1[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (sessionId) { clauses.push("provider_session_id=?"); values.push(sessionId); }
    if (role) { clauses.push("role=?"); values.push(role); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT session_ref_json FROM provider_session_bindings${where} ORDER BY observed_at`).all(...values) as Array<{ session_ref_json: string }>;
    return rows.map((row) => parseJson(row.session_ref_json) as ProviderSessionRefV1);
  }

  recordIssue(runId: string, issue: WorkflowIssue): number {
    const result = this.db.prepare("INSERT INTO workflow_issues(run_id,code,issue_json,created_at) VALUES(?,?,?,?)").run(runId, issue.code, json(issue), issue.occurred_at);
    this.insertEvent(runId, "issue", issue.phase, { issueId: Number(result.lastInsertRowid), code: issue.code }, issue.occurred_at);
    return Number(result.lastInsertRowid);
  }

  issues(runId: string): WorkflowIssue[] {
    return (this.db.prepare("SELECT issue_json FROM workflow_issues WHERE run_id=? ORDER BY issue_id").all(runId) as Array<{ issue_json: string }>).map((row) => parseJson(row.issue_json) as WorkflowIssue);
  }

  freezeAutonomyPolicy(runId: string, policy: ResolvedAutonomyPolicy, now = new Date()): ResolvedAutonomyPolicy {
    this.ensureRun(runId, "build", now);
    this.db.prepare("INSERT INTO run_autonomy_policy(run_id,digest,policy_json,frozen_at) VALUES(?,?,?,?) ON CONFLICT(run_id) DO NOTHING")
      .run(runId, policy.digest, json(policy), now.toISOString());
    return this.autonomyPolicy(runId)!;
  }

  autonomyPolicy(runId: string): ResolvedAutonomyPolicy | undefined {
    const row = this.db.prepare("SELECT policy_json FROM run_autonomy_policy WHERE run_id=?").get(runId) as { policy_json: string } | undefined;
    return row ? parseJson(row.policy_json) as ResolvedAutonomyPolicy : undefined;
  }

  recordInterruption(interruption: StructuredInterruption): StructuredInterruption {
    this.ensureRun(interruption.runId);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO recovery_interruptions(interruption_id,run_id,code,domain,phase,cause,dispatch_state,operation_key,interruption_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(interruption_id) DO NOTHING`).run(
        interruption.id, interruption.runId, interruption.code, interruption.domain, interruption.phase, interruption.cause,
        interruption.dispatchState, interruption.operation?.idempotencyKey ?? null, json(interruption), interruption.occurredAt,
      );
      this.insertEvent(interruption.runId, "recovery_interruption", interruption.phase, { interruptionId: interruption.id, code: interruption.code, domain: interruption.domain }, interruption.occurredAt);
    })();
    return interruption;
  }

  interruptions(runId: string): StructuredInterruption[] {
    return (this.db.prepare("SELECT interruption_json FROM recovery_interruptions WHERE run_id=? ORDER BY created_at,interruption_id").all(runId) as Array<{ interruption_json: string }>)
      .map((row) => parseJson(row.interruption_json) as StructuredInterruption);
  }

  recoveryAttemptCount(runId: string, ticket: string | undefined, phase: string, cause: string, operationKey: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM recovery_attempts
      WHERE run_id=? AND ticket IS ? AND phase=? AND cause=? AND operation_key=? AND outcome IN ('intended','started','succeeded','failed')`)
      .get(runId, ticket ?? null, phase, cause, operationKey) as { count: number };
    return row.count;
  }

  recordRecoveryAttempt(receipt: RecoveryAttemptReceipt): RecoveryAttemptReceipt {
    this.ensureRun(receipt.runId);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO recovery_attempts(attempt_id,run_id,ticket,phase,cause,operation_key,attempt,disposition,action,outcome,receipt_json,intended_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(receipt.attemptId, receipt.runId, receipt.ticket ?? null, receipt.phase, receipt.cause,
        receipt.operationKey, receipt.attempt, receipt.disposition, receipt.action, receipt.outcome, json(receipt), receipt.intendedAt, receipt.intendedAt);
      this.insertEvent(receipt.runId, "recovery_attempt_intended", receipt.phase, { attemptId: receipt.attemptId, attempt: receipt.attempt, action: receipt.action }, receipt.intendedAt);
    })();
    return receipt;
  }

  updateRecoveryAttempt(attemptId: string, outcome: RecoveryAttemptOutcome, detail?: string, now = new Date()): RecoveryAttemptReceipt {
    const row = this.db.prepare("SELECT receipt_json FROM recovery_attempts WHERE attempt_id=?").get(attemptId) as { receipt_json: string } | undefined;
    if (!row) throw new Error(`recovery attempt not found: ${attemptId}`);
    const prior = parseJson(row.receipt_json) as RecoveryAttemptReceipt;
    const at = now.toISOString();
    const next: RecoveryAttemptReceipt = { ...prior, outcome, ...(outcome === "started" ? { startedAt: at } : {}), ...(["succeeded", "failed", "cancelled"].includes(outcome) ? { completedAt: at } : {}), ...(detail ? { detail } : {}) };
    this.db.prepare("UPDATE recovery_attempts SET outcome=?,receipt_json=?,updated_at=? WHERE attempt_id=?").run(outcome, json(next), at, attemptId);
    this.insertEvent(next.runId, `recovery_attempt_${outcome}`, next.phase, { attemptId, detail }, at);
    return next;
  }

  recoveryAttempts(runId: string): RecoveryAttemptReceipt[] {
    return (this.db.prepare("SELECT receipt_json FROM recovery_attempts WHERE run_id=? ORDER BY intended_at,attempt_id").all(runId) as Array<{ receipt_json: string }>)
      .map((row) => parseJson(row.receipt_json) as RecoveryAttemptReceipt);
  }

  ensureHumanDecision(input: { decisionKey: string; runId: string; interruptionId: string; prompt: string; choices: PendingHumanDecision["choices"]; evidence?: PendingHumanDecision["evidence"] }, now = new Date()): PendingHumanDecision {
    this.ensureRun(input.runId);
    const existing = this.db.prepare("SELECT decision_json FROM human_decisions WHERE decision_key=?").get(input.decisionKey) as { decision_json: string } | undefined;
    if (existing) return parseJson(existing.decision_json) as PendingHumanDecision;
    const decision: PendingHumanDecision = { decisionId: randomUUID(), runId: input.runId, interruptionId: input.interruptionId, prompt: input.prompt, choices: input.choices, status: "pending", createdAt: now.toISOString(), ...(input.evidence ? { evidence: input.evidence } : {}) };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO human_decisions(decision_id,decision_key,run_id,status,decision_json,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)")
        .run(decision.decisionId, input.decisionKey, input.runId, json(decision), decision.createdAt, decision.createdAt);
      this.insertEvent(input.runId, "human_decision_pending", "waiting-for-human", { decisionId: decision.decisionId, choices: decision.choices.map((choice) => choice.id) }, decision.createdAt);
    })();
    return decision;
  }

  humanDecision(decisionId: string): PendingHumanDecision | undefined {
    const row = this.db.prepare("SELECT decision_json FROM human_decisions WHERE decision_id=?").get(decisionId) as { decision_json: string } | undefined;
    return row ? parseJson(row.decision_json) as PendingHumanDecision : undefined;
  }

  pendingHumanDecisions(runId: string): PendingHumanDecision[] {
    return (this.db.prepare("SELECT decision_json FROM human_decisions WHERE run_id=? AND status='pending' ORDER BY created_at").all(runId) as Array<{ decision_json: string }>)
      .map((row) => parseJson(row.decision_json) as PendingHumanDecision);
  }

  answerHumanDecision(runId: string, decisionId: string, choiceId: string, now = new Date()): PendingHumanDecision {
    const decision = this.humanDecision(decisionId);
    if (!decision || decision.runId !== runId) throw new Error(`pending decision not found for run ${runId}: ${decisionId}`);
    if (decision.status !== "pending") throw new Error(`decision ${decisionId} has already been answered`);
    if (!decision.choices.some((choice) => choice.id === choiceId)) throw new Error(`invalid choice ${choiceId} for decision ${decisionId}`);
    const at = now.toISOString();
    const next: PendingHumanDecision = { ...decision, status: "answered", answeredAt: at, selectedChoiceId: choiceId };
    this.db.prepare("UPDATE human_decisions SET status='answered',decision_json=?,updated_at=? WHERE decision_id=? AND status='pending'").run(json(next), at, decisionId);
    this.insertEvent(runId, "human_decision_answered", "decision-received", { decisionId, choiceId }, at);
    return next;
  }

  putSupervisorState(runId: string, state: SupervisorState, now = new Date()): SupervisorState {
    this.ensureRun(runId);
    this.db.prepare(`INSERT INTO supervisor_leases(run_id,status,pid,generation,heartbeat_at,state_json,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,pid=excluded.pid,generation=excluded.generation,heartbeat_at=excluded.heartbeat_at,state_json=excluded.state_json,updated_at=excluded.updated_at`)
      .run(runId, state.status, state.pid ?? null, state.generation, state.heartbeatAt ?? null, json(state), now.toISOString());
    return state;
  }

  supervisorState(runId: string): SupervisorState | undefined {
    const row = this.db.prepare("SELECT state_json FROM supervisor_leases WHERE run_id=?").get(runId) as { state_json: string } | undefined;
    return row ? parseJson(row.state_json) as SupervisorState : undefined;
  }

  planOperation(input: { runId: string; idempotencyKey: string; kind: string; intent: unknown }, now = new Date()): OperationRecord {
    const at = now.toISOString();
    this.db.prepare(`INSERT INTO operation_journal(idempotency_key,run_id,kind,status,intent_json,created_at,updated_at)
      VALUES(?,?,?,'planned',?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`).run(input.idempotencyKey, input.runId, input.kind, json(input.intent), at, at);
    return this.operation(input.idempotencyKey)!;
  }

  updateOperation(idempotencyKey: string, status: OperationLifecycle, details: { result?: unknown; externalId?: string; error?: string } = {}, now = new Date()): OperationRecord {
    const prior = this.operation(idempotencyKey); if (!prior) throw new Error(`operation not found: ${idempotencyKey}`);
    const at = now.toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE operation_journal SET status=?,result_json=?,external_id=?,error=?,updated_at=? WHERE idempotency_key=?")
        .run(status, details.result === undefined ? null : json(details.result), details.externalId ?? null, details.error ?? null, at, idempotencyKey);
      this.appendContinuityEvent({ runId: prior.runId, role: "host", kind: "operation_receipt", payload: { idempotencyKey, kind: prior.kind, status, externalId: details.externalId, error: details.error }, authoritativeStateRevision: this.continuityHead(prior.runId, "run")?.authoritativeStateRevision ?? 0 }, now);
    })();
    return this.operation(idempotencyKey)!;
  }

  operation(idempotencyKey: string): OperationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM operation_journal WHERE idempotency_key=?").get(idempotencyKey) as DbOperation | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  operations(runId: string): OperationRecord[] {
    return (this.db.prepare("SELECT * FROM operation_journal WHERE run_id=? ORDER BY created_at,idempotency_key").all(runId) as DbOperation[]).map(operationFromRow);
  }

  putEvidence(kind: "handoff" | "diff" | "test" | "qa", value: string | Buffer, now = new Date()): string {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(sanitizeText(value));
    const digest = createHash("sha256").update(bytes).digest("hex");
    this.db.prepare("INSERT OR IGNORE INTO content_refs(digest,kind,content,created_at) VALUES(?,?,?,?)").run(digest, kind, bytes, now.toISOString());
    return digest;
  }

  getEvidence(digest: string): Buffer | undefined {
    const row = this.db.prepare("SELECT content FROM content_refs WHERE digest=?").get(digest) as { content: Buffer } | undefined;
    return row?.content;
  }

  stageHandoff(manifest: HandoffManifestV1, markdown: string): HandoffLineage {
    this.ensureRun(manifest.runId);
    const manifestText = stableJson(sanitizeContinuityValue(manifest));
    const manifestDigest = this.putEvidence("handoff", manifestText);
    const markdownDigest = this.putEvidence("handoff", markdown);
    const lineage: HandoffLineage = {
      runId: manifest.runId,
      generation: manifest.generation,
      manifestDigest,
      markdownDigest,
      ...(manifest.predecessorSessionId ? { predecessorSessionId: manifest.predecessorSessionId } : {}),
      ...(manifest.predecessorSessionRef ? { predecessorSessionRef: manifest.predecessorSessionRef } : {}),
      state: "staged",
      createdAt: manifest.createdAt,
    };
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT manifest_digest,markdown_digest FROM handoffs WHERE run_id=? AND generation=?").get(manifest.runId, manifest.generation) as { manifest_digest: string; markdown_digest: string } | undefined;
      if (existing && (existing.manifest_digest !== manifestDigest || existing.markdown_digest !== markdownDigest)) {
        throw new Error(`handoff generation ${manifest.generation} is immutable`);
      }
      const predecessor = sessionParts(manifest.predecessorSessionRef, manifest.predecessorSessionId);
      this.db.prepare(`INSERT OR IGNORE INTO handoffs(run_id,generation,role,manifest_digest,markdown_digest,predecessor_session_id,predecessor_session_key,predecessor_session_ref_json,state,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(manifest.runId, manifest.generation, manifest.role, manifestDigest, markdownDigest, predecessor.id, predecessor.key, predecessor.refJson, "staged", manifest.createdAt);
      this.insertEvent(manifest.runId, "handoff_staged", `handoff:${manifest.generation}`, { generation: manifest.generation, manifestDigest, markdownDigest, resources: manifest.resources }, manifest.createdAt);
    })();
    return this.handoff(manifest.runId, manifest.generation) ?? lineage;
  }

  acceptHandoff(runId: string, generation: number, successor: string | ProviderSessionRefV1, now = new Date()): HandoffLineage {
    const session = sessionParts(typeof successor === "object" ? successor : undefined, typeof successor === "string" ? successor : undefined);
    if (!session.id?.trim()) throw new Error("a validated successor session ID is required before handoff acceptance");
    if (session.ref) this.recordProviderSessionBinding(session.ref, now);
    return this.db.transaction(() => {
      const prior = this.handoff(runId, generation);
      if (!prior) throw new Error(`handoff generation ${generation} not found for run ${runId}`);
      if (prior.state === "failed") throw new Error("a failed handoff cannot be accepted");
      const at = now.toISOString();
      this.db.prepare(`UPDATE handoffs SET state='accepted',successor_session_id=?,successor_session_key=?,successor_session_ref_json=?,accepted_at=? WHERE run_id=? AND generation=?`)
        .run(session.id, session.key, session.refJson, at, runId, generation);
      this.db.prepare(`INSERT INTO role_mutation_leases(run_id,role,generation,provider_session_id,provider_session_key,provider_session_ref_json,moved_at)
        SELECT run_id,role,generation,?,?,?,? FROM handoffs WHERE run_id=? AND generation=?
        ON CONFLICT(run_id,role) DO UPDATE SET generation=excluded.generation,provider_session_id=excluded.provider_session_id,provider_session_key=excluded.provider_session_key,provider_session_ref_json=excluded.provider_session_ref_json,moved_at=excluded.moved_at`)
        .run(session.id, session.key, session.refJson, at, runId, generation);
      this.insertEvent(runId, "handoff_accepted", `handoff:${generation}`, { generation, successorSessionId: session.id, sessionKey: session.key, leaseMoved: true }, at);
      return this.handoff(runId, generation)!;
    })();
  }

  /** Fence the initial role owner without overwriting a lease already moved by a handoff. */
  claimInitialRoleLease(runId: string, role: "builder" | "qa", providerSession: string | ProviderSessionRefV1, now = new Date()): RoleMutationLease {
    const session = sessionParts(typeof providerSession === "object" ? providerSession : undefined, typeof providerSession === "string" ? providerSession : undefined);
    if (!session.id?.trim()) throw new Error("a provider session ID is required to claim the role lease");
    this.ensureRun(runId);
    this.db.prepare(`INSERT OR IGNORE INTO role_mutation_leases(run_id,role,generation,provider_session_id,provider_session_key,provider_session_ref_json,moved_at) VALUES(?,?,?,?,?,?,?)`)
      .run(runId, role, 0, session.id, session.key, session.refJson, now.toISOString());
    return this.roleMutationLease(runId, role)!;
  }

  roleMutationLease(runId: string, role: "builder" | "qa"): RoleMutationLease | undefined {
    const row = this.db.prepare(`SELECT run_id,role,generation,provider_session_id,provider_session_key,provider_session_ref_json,moved_at FROM role_mutation_leases WHERE run_id=? AND role=?`)
      .get(runId, role) as { run_id: string; role: "builder" | "qa"; generation: number; provider_session_id: string; provider_session_key: string | null; provider_session_ref_json: string | null; moved_at: string } | undefined;
    return row ? { runId: row.run_id, role: row.role, generation: row.generation, providerSessionId: row.provider_session_id, ...(row.provider_session_key ? { sessionKey: row.provider_session_key } : {}), ...(row.provider_session_ref_json ? { sessionRef: parseJson(row.provider_session_ref_json) as ProviderSessionRefV1 } : {}), movedAt: row.moved_at } : undefined;
  }

  /** Move a dead predecessor's lease only after a fresh recovery produced a schema-valid checkpoint. */
  moveRoleLeaseAfterValidatedRecovery(
    runId: string,
    role: "builder" | "qa",
    providerSession: string | ProviderSessionRefV1,
    reason: string,
    now = new Date(),
  ): RoleMutationLease {
    const session = sessionParts(typeof providerSession === "object" ? providerSession : undefined, typeof providerSession === "string" ? providerSession : undefined);
    if (!session.id?.trim()) throw new Error("a validated recovery session ID is required to move the role lease");
    this.ensureRun(runId);
    const prior = this.roleMutationLease(runId, role);
    if ((session.key && prior?.sessionKey === session.key) || (!session.key && prior?.providerSessionId === session.id)) return prior;
    const at = now.toISOString();
    const generation = (prior?.generation ?? -1) + 1;
    return this.db.transaction(() => {
      this.db.prepare(`INSERT INTO role_mutation_leases(run_id,role,generation,provider_session_id,provider_session_key,provider_session_ref_json,moved_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(run_id,role) DO UPDATE SET generation=excluded.generation,provider_session_id=excluded.provider_session_id,provider_session_key=excluded.provider_session_key,provider_session_ref_json=excluded.provider_session_ref_json,moved_at=excluded.moved_at`)
        .run(runId, role, generation, session.id, session.key, session.refJson, at);
      this.insertEvent(runId, "validated_recovery_lease_moved", `recovery:${role}:${generation}`, {
        role, generation, predecessorSessionId: prior?.providerSessionId, successorSessionId: session.id, successorSessionKey: session.key,
        reason: sanitizeText(reason).slice(0, 500),
      }, at);
      return this.roleMutationLease(runId, role)!;
    })();
  }

  failHandoff(runId: string, generation: number, reason: string, now = new Date()): HandoffLineage {
    const prior = this.handoff(runId, generation);
    if (!prior) throw new Error(`handoff generation ${generation} not found for run ${runId}`);
    if (prior.state === "accepted") throw new Error("an accepted handoff cannot be failed");
    const at = now.toISOString();
    this.db.prepare("UPDATE handoffs SET state='failed',failure=? WHERE run_id=? AND generation=?").run(sanitizeText(reason).slice(0, 2000), runId, generation);
    this.insertEvent(runId, "handoff_failed", `handoff:${generation}`, { generation, reason: sanitizeText(reason).slice(0, 500) }, at);
    return this.handoff(runId, generation)!;
  }

  handoff(runId: string, generation: number): HandoffLineage | undefined {
    const row = this.db.prepare("SELECT * FROM handoffs WHERE run_id=? AND generation=?").get(runId, generation) as DbHandoff | undefined;
    return row ? handoffFromRow(row) : undefined;
  }

  handoffs(runId: string): HandoffLineage[] {
    return (this.db.prepare("SELECT * FROM handoffs WHERE run_id=? ORDER BY generation").all(runId) as DbHandoff[]).map(handoffFromRow);
  }

  handoffContent(runId: string, generation: number): { lineage: HandoffLineage; manifest: HandoffManifestV1; markdown: string } | undefined {
    const lineage = this.handoff(runId, generation);
    if (!lineage) return undefined;
    const manifest = this.getEvidence(lineage.manifestDigest);
    const markdown = this.getEvidence(lineage.markdownDigest);
    if (!manifest || !markdown) throw new Error(`handoff ${runId}/${generation} references missing durable content`);
    return { lineage, manifest: JSON.parse(manifest.toString("utf8")) as HandoffManifestV1, markdown: markdown.toString("utf8") };
  }

  deleteHandoffHistory(runId: string): number {
    const run = this.getRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (!["completed", "cancelled", "superseded"].includes(run.status)) throw new Error(`run ${runId} is active or recoverable; durable handoff history cannot be deleted`);
    const rows = this.db.prepare("SELECT manifest_digest,markdown_digest FROM handoffs WHERE run_id=?").all(runId) as Array<{ manifest_digest: string; markdown_digest: string }>;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM role_mutation_leases WHERE run_id=?").run(runId);
      this.db.prepare("DELETE FROM handoffs WHERE run_id=?").run(runId);
      for (const row of rows) {
        for (const digest of [row.manifest_digest, row.markdown_digest]) {
          const referenced = this.db.prepare("SELECT 1 FROM handoffs WHERE manifest_digest=? OR markdown_digest=? LIMIT 1").get(digest, digest);
          if (!referenced) this.db.prepare("DELETE FROM content_refs WHERE digest=? AND kind='handoff'").run(digest);
        }
      }
    })();
    return rows.length;
  }

  startCompactionAttempt(input: {
    idempotencyKey: string;
    runId: string;
    role: "builder" | "qa";
    providerSessionId?: string;
    sessionRef?: ProviderSessionRefV1;
    sessionKey?: string;
    crossingKey: string;
    beforeSample?: ContextSample;
  }, now = new Date()): CompactionAttemptRecord {
    this.ensureRun(input.runId);
    const at = now.toISOString();
    const session = sessionParts(input.sessionRef, input.providerSessionId, input.sessionKey);
    this.db.prepare(`INSERT OR IGNORE INTO compaction_attempts(idempotency_key,run_id,role,provider_session_id,session_key,session_ref_json,crossing_key,status,before_sample_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'started',?,?,?)`).run(input.idempotencyKey, input.runId, input.role, session.id, session.key, session.refJson, input.crossingKey, input.beforeSample ? json(input.beforeSample) : null, at, at);
    return this.compactionAttempt(input.idempotencyKey)!;
  }

  finishCompactionAttempt(idempotencyKey: string, input: { ok: boolean; afterSample?: ContextSample; error?: string }, now = new Date()): CompactionAttemptRecord {
    const prior = this.compactionAttempt(idempotencyKey);
    if (!prior) throw new Error(`compaction attempt not found: ${idempotencyKey}`);
    if (prior.status !== "started") return prior;
    this.db.prepare("UPDATE compaction_attempts SET status=?,after_sample_json=?,error=?,updated_at=? WHERE idempotency_key=?")
      .run(input.ok ? "succeeded" : "failed", input.afterSample ? json(input.afterSample) : null, input.error ? sanitizeText(input.error).slice(0, 2000) : null, now.toISOString(), idempotencyKey);
    this.insertEvent(prior.runId, input.ok ? "compaction_succeeded" : "compaction_failed", `context:${prior.role}`, { idempotencyKey, providerSessionId: prior.providerSessionId, sessionKey: prior.sessionKey, crossingKey: prior.crossingKey }, now.toISOString());
    return this.compactionAttempt(idempotencyKey)!;
  }

  /** Attach an eventually available measurement without changing confirmed accounting. */
  recordCompactionAfterSample(idempotencyKey: string, afterSample: ContextSample, now = new Date()): CompactionAttemptRecord {
    const prior = this.compactionAttempt(idempotencyKey);
    if (!prior) throw new Error(`compaction attempt not found: ${idempotencyKey}`);
    if (prior.status !== "succeeded") return prior;
    this.db.prepare("UPDATE compaction_attempts SET after_sample_json=?,updated_at=? WHERE idempotency_key=?")
      .run(json(afterSample), now.toISOString(), idempotencyKey);
    return this.compactionAttempt(idempotencyKey)!;
  }

  compactionAttempt(idempotencyKey: string): CompactionAttemptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM compaction_attempts WHERE idempotency_key=?").get(idempotencyKey) as DbCompactionAttempt | undefined;
    return row ? compactionAttemptFromRow(row) : undefined;
  }

  successfulCompactionCount(runId: string, role: "builder" | "qa", providerSession?: string | ProviderSessionRefV1): number {
    if (!providerSession) return 0;
    const session = sessionParts(typeof providerSession === "object" ? providerSession : undefined, typeof providerSession === "string" ? providerSession : undefined);
    const row = session.key
      ? this.db.prepare(`SELECT COUNT(*) AS count FROM compaction_attempts WHERE run_id=? AND role=? AND session_key=? AND status='succeeded'`).get(runId, role, session.key) as { count: number }
      : this.db.prepare(`SELECT COUNT(*) AS count FROM compaction_attempts WHERE run_id=? AND role=? AND provider_session_id=? AND session_key IS NULL AND status='succeeded'`).get(runId, role, session.id) as { count: number };
    return row.count;
  }

  recordRecoveryDecision(receipt: BuildRecoveryDecisionReceipt): void {
    this.ensureRun(receipt.runId);
    const digest = digestJson(receipt);
    const session = sessionParts(receipt.predecessorSessionRef, receipt.predecessorSessionId);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO recovery_decisions(run_id,decided_at,mode,digest,session_key,session_ref_json,receipt_json)
        VALUES(?,?,?,?,?,?,?)`).run(receipt.runId, receipt.decidedAt, receipt.mode, digest, session.key, session.refJson, json(receipt));
      this.insertEvent(receipt.runId, "recovery_decision", "recovery", { mode: receipt.mode, digest }, receipt.decidedAt);
    })();
  }

  recoveryDecisions(runId: string): BuildRecoveryDecisionReceipt[] {
    return (this.db.prepare("SELECT receipt_json FROM recovery_decisions WHERE run_id=? ORDER BY decision_id").all(runId) as Array<{ receipt_json: string }>).map((row) => parseJson(row.receipt_json) as BuildRecoveryDecisionReceipt);
  }

  /**
   * A process may die after dispatching a provider turn but before its durable
   * continuity checkpoint. The provider may have compacted during that gap, so
   * recovery must not treat that role session's compaction history as complete.
   */
  hasUncheckpointedRoleTurn(runId: string, role: "builder" | "qa"): boolean {
    const events = this.continuityEvents(runId);
    let startSequence = 0;
    for (const event of events) {
      if (event.kind === "turn_started" && event.role === "host" && (event.payload as { role?: string }).role === role) {
        startSequence = event.sequence;
      } else if (startSequence && event.sequence > startSequence
        && (event.kind === "turn_completed" || event.kind === "turn_completed_after_repair" || event.kind === "fresh_successor_accepted")) {
        startSequence = 0;
      }
    }
    return startSequence > 0;
  }

  beginPublication(runId: string, intent: unknown, previousDigests: unknown, now = new Date()): PublicationTransaction {
    const transactionId = randomUUID(); const at = now.toISOString();
    this.db.prepare("INSERT INTO publication_transactions(transaction_id,run_id,status,intent_json,previous_digests_json,created_at,updated_at) VALUES(?,?,'prepared',?,?,?,?)")
      .run(transactionId, runId, json(intent), json(previousDigests), at, at);
    this.insertEvent(runId, "publication_prepared", "publication", { transactionId }, at);
    return { transactionId, runId, status: "prepared", intent, previousDigests, createdAt: at, updatedAt: at };
  }

  updatePublication(transactionId: string, status: PublicationTransaction["status"], now = new Date()): PublicationTransaction {
    const current = this.publication(transactionId); if (!current) throw new Error(`publication transaction not found: ${transactionId}`);
    this.db.prepare("UPDATE publication_transactions SET status=?,updated_at=? WHERE transaction_id=?").run(status, now.toISOString(), transactionId);
    this.insertEvent(current.runId, `publication_${status}`, "publication", { transactionId }, now.toISOString());
    return { ...current, status, updatedAt: now.toISOString() };
  }

  publication(transactionId: string): PublicationTransaction | undefined {
    const row = this.db.prepare("SELECT * FROM publication_transactions WHERE transaction_id=?").get(transactionId) as { transaction_id: string; run_id: string; status: PublicationTransaction["status"]; intent_json: string; previous_digests_json: string; created_at: string; updated_at: string } | undefined;
    return row ? { transactionId: row.transaction_id, runId: row.run_id, status: row.status, intent: parseJson(row.intent_json), previousDigests: parseJson(row.previous_digests_json), createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }

  incompletePublications(): PublicationTransaction[] {
    const rows = this.db.prepare("SELECT transaction_id FROM publication_transactions WHERE status NOT IN ('committed','rolled_back') ORDER BY created_at").all() as Array<{ transaction_id: string }>;
    return rows.map((row) => this.publication(row.transaction_id)!);
  }

  acquireLease(runId: string, owner = `${hostname()}:${process.pid}:${randomUUID()}`, now = new Date(), staleMs = 45_000): ProjectLease {
    const at = now.toISOString(); const host = hostname(); const pid = process.pid; const processStart = processStartIdentity();
    return this.db.transaction(() => {
      const current = this.currentLease();
      if (current && leaseVerifiedLive(current, now, staleMs)) throw new Error(`project workflow lease is held by ${current.owner} for run ${current.runId}`);
      const generation = (current?.generation ?? 0) + 1;
      this.db.prepare(`INSERT INTO project_lease(singleton,owner,generation,pid,host,process_start,heartbeat_at,run_id)
        VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,pid=excluded.pid,host=excluded.host,process_start=excluded.process_start,heartbeat_at=excluded.heartbeat_at,run_id=excluded.run_id`)
        .run(owner, generation, pid, host, processStart, at, runId);
      this.db.prepare("UPDATE workflow_runs SET lease_generation=? WHERE run_id=?").run(generation, runId);
      this.insertEvent(runId, current ? "lease_takeover" : "lease_acquired", "lease", { owner, generation, previous: current?.owner }, at);
      return { owner, generation, pid, host, processStart, heartbeatAt: at, runId };
    })();
  }

  heartbeatLease(lease: ProjectLease, now = new Date()): ProjectLease {
    const at = now.toISOString();
    const result = this.db.prepare("UPDATE project_lease SET heartbeat_at=? WHERE singleton=1 AND owner=? AND generation=?").run(at, lease.owner, lease.generation);
    if (result.changes !== 1) throw new Error("workflow lease ownership changed");
    return { ...lease, heartbeatAt: at };
  }

  releaseLease(lease: ProjectLease, now = new Date()): void {
    this.db.transaction(() => {
      const result = this.db.prepare("DELETE FROM project_lease WHERE singleton=1 AND owner=? AND generation=?").run(lease.owner, lease.generation);
      if (result.changes === 1) this.insertEvent(lease.runId, "lease_released", "lease", { generation: lease.generation }, now.toISOString());
    })();
  }

  currentLease(): ProjectLease | undefined {
    const row = this.db.prepare("SELECT * FROM project_lease WHERE singleton=1").get() as DbLease | undefined;
    return row ? { owner: row.owner, generation: row.generation, pid: row.pid, host: row.host, processStart: row.process_start, heartbeatAt: row.heartbeat_at, runId: row.run_id } : undefined;
  }

  recordBranchResumeSession(runId: string, session: BranchResumeSession, now = new Date()): void {
    this.ensureRun(runId, "build", now);
    this.db.prepare(`INSERT INTO branch_resume_sessions(run_id,ticket,status,session_json,updated_at)
      VALUES(?,?,'active',?,?) ON CONFLICT(run_id,ticket) DO UPDATE SET status='active',session_json=excluded.session_json,updated_at=excluded.updated_at`)
      .run(runId, session.ticket, json(sanitizeContinuityValue(session)), now.toISOString());
  }

  completeBranchResumeSession(runId: string, ticket: string, status: "completed" | "superseded" = "completed", now = new Date()): void {
    this.db.prepare("UPDATE branch_resume_sessions SET status=?,updated_at=? WHERE run_id=? AND ticket=?").run(status, now.toISOString(), runId, ticket);
  }

  branchResumeSessions(activeOnly = true): BranchResumeSession[] {
    const rows = this.db.prepare(`SELECT session_json FROM branch_resume_sessions${activeOnly ? " WHERE status='active'" : ""} ORDER BY updated_at,ticket`).all() as Array<{ session_json: string }>;
    return rows.map(row => parseJson(row.session_json) as BranchResumeSession);
  }

  pruneTerminalTelemetry(retentionDays: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - Math.max(1, retentionDays) * 86_400_000).toISOString();
    const result = this.db.prepare(`DELETE FROM workflow_telemetry
      WHERE run_id IN (SELECT run_id FROM workflow_runs WHERE status IN ('completed','failed','cancelled','superseded') AND updated_at<?)
      AND id NOT IN (SELECT MAX(id) FROM workflow_telemetry GROUP BY run_id)`).run(cutoff);
    this.db.pragma("incremental_vacuum(200)");
    return result.changes;
  }

  compactStorage(): void {
    const lease = this.currentLease();
    if (lease && Date.now() - new Date(lease.heartbeatAt).getTime() <= 45_000) throw new Error("refusing recovery database compaction while a live project lease exists");
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.exec("VACUUM");
  }

  importLegacyOnce(now = new Date()): number {
    const migration = "legacy-files-v1";
    if (this.db.prepare("SELECT 1 FROM recovery_schema_migrations WHERE migration=?").get(migration)) return 0;
    const sources = [join(this.projectDir, ".foreman", "runs"), join(this.projectDir, ".rafi", "interviews"), join(this.projectDir, ".tickets", "delivery-sessions")];
    let count = 0;
    this.db.transaction(() => { for (const directory of sources) {
      if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
      for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
        const path = join(directory, name); const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        if (this.db.prepare("SELECT 1 FROM legacy_imports WHERE source_path=? AND digest=?").get(path, digest)) continue;
        let parsed: unknown; try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { parsed = { unreadable: true }; }
        const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
        const isBuild = (record?.version === 1 || record?.version === 2) && typeof record.runId === "string";
        const runId = isBuild ? String(record!.runId) : `legacy_${digest.slice(0, 24)}`;
        if (!this.getRun(runId)) {
          this.createRun({ runId, kind: isBuild ? "build" : "legacy", checkpoint: isBuild && typeof record?.checkpoint === "string" ? record.checkpoint : "legacy-imported", originalWork: isBuild ? { tickets: record?.tickets ?? [] } : { source: path }, remainingWork: isBuild ? { tickets: record?.tickets ?? [] } : {}, state: isBuild ? record! : { source: path, record: parsed }, legacy: true }, now);
          if (!isBuild) this.transition(runId, { status: "superseded", checkpoint: "legacy-imported", remainingWork: {}, event: "legacy_record_preserved" }, now);
        }
        this.db.prepare("INSERT INTO legacy_imports(source_path,digest,run_id,imported_at) VALUES(?,?,?,?)").run(path, digest, runId, now.toISOString()); count += 1;
      }
    }
    this.db.prepare("INSERT INTO recovery_schema_migrations(migration,completed_at) VALUES(?,?)").run(migration, now.toISOString()); })();
    return count;
  }

  private upsertContinuityHead(head: ContinuityHead): void {
    this.db.prepare(`INSERT INTO continuity_heads(run_id,role,state,event_sequence,digest,authoritative_state_revision,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,role) DO UPDATE SET state=excluded.state,event_sequence=excluded.event_sequence,digest=excluded.digest,authoritative_state_revision=excluded.authoritative_state_revision,updated_at=excluded.updated_at`)
      .run(head.runId, head.role, head.state, head.sequence, head.digest, head.authoritativeStateRevision, head.updatedAt);
  }

  private refreshRunContinuityHead(runId: string, authoritativeStateRevision: number, at: string): void {
    const rows = this.db.prepare("SELECT role,state,event_sequence,digest FROM continuity_heads WHERE run_id=? AND role IN ('builder','qa') ORDER BY role").all(runId) as Array<{ role: string; state: ContinuityHeadState; event_sequence: number; digest: string }>;
    if (!rows.length) return;
    const state: ContinuityHeadState = rows.some((row) => row.state === "invalid") ? "invalid"
      : rows.some((row) => row.state === "degraded") ? "degraded"
        : rows.some((row) => row.state === "stale") ? "stale" : "current";
    const sequence = Math.max(...rows.map((row) => row.event_sequence));
    const digest = digestJson(rows.map((row) => ({ role: row.role, digest: row.digest })));
    this.upsertContinuityHead({ runId, role: "run", state, sequence, digest, authoritativeStateRevision, updatedAt: at });
  }

  private insertEvent(runId: string, type: string, checkpoint: string, payload: unknown, at: string): void {
    this.db.prepare("INSERT INTO workflow_events(run_id,event_type,checkpoint,payload_json,created_at) VALUES(?,?,?,?,?)").run(runId, type, checkpoint, json(payload), at);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs(run_id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,checkpoint TEXT NOT NULL,original_work_json TEXT NOT NULL,remaining_work_json TEXT NOT NULL,state_json TEXT NOT NULL,lease_generation INTEGER,legacy INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_schema_migrations(migration TEXT PRIMARY KEY,completed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS branch_resume_sessions(run_id TEXT NOT NULL,ticket TEXT NOT NULL,status TEXT NOT NULL,session_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,ticket));
      CREATE TABLE IF NOT EXISTS run_autonomy_policy(run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),digest TEXT NOT NULL,policy_json TEXT NOT NULL,frozen_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_interruptions(interruption_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),code TEXT NOT NULL,domain TEXT NOT NULL,phase TEXT NOT NULL,cause TEXT NOT NULL,dispatch_state TEXT NOT NULL,operation_key TEXT,interruption_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_attempts(attempt_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket TEXT,phase TEXT NOT NULL,cause TEXT NOT NULL,operation_key TEXT NOT NULL,attempt INTEGER NOT NULL,disposition TEXT NOT NULL,action TEXT NOT NULL,outcome TEXT NOT NULL,receipt_json TEXT NOT NULL,intended_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS human_decisions(decision_id TEXT PRIMARY KEY,decision_key TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),status TEXT NOT NULL,decision_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor_leases(run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),status TEXT NOT NULL,pid INTEGER,generation INTEGER NOT NULL,heartbeat_at TEXT,state_json TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),event_type TEXT NOT NULL,checkpoint TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS role_settings(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,boundary INTEGER NOT NULL,revision INTEGER NOT NULL,settings_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(run_id,role,boundary));
      CREATE TABLE IF NOT EXISTS project_settings_revisions(revision INTEGER PRIMARY KEY,defaults_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_telemetry(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,stream TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,session_id TEXT,session_key TEXT,session_ref_json TEXT,transition TEXT NOT NULL,settings_revision INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_session_bindings(session_key TEXT PRIMARY KEY,provider_session_id TEXT NOT NULL,role TEXT NOT NULL,session_ref_json TEXT NOT NULL,observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_issues(issue_id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),code TEXT NOT NULL,issue_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_journal(idempotency_key TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),kind TEXT NOT NULL,status TEXT NOT NULL,intent_json TEXT NOT NULL,result_json TEXT,external_id TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_refs(digest TEXT PRIMARY KEY,kind TEXT NOT NULL,content BLOB NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,generation INTEGER NOT NULL,pid INTEGER NOT NULL,host TEXT NOT NULL,process_start TEXT NOT NULL,heartbeat_at TEXT NOT NULL,run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_imports(source_path TEXT NOT NULL,digest TEXT NOT NULL,run_id TEXT NOT NULL,imported_at TEXT NOT NULL,PRIMARY KEY(source_path,digest));
      CREATE TABLE IF NOT EXISTS publication_transactions(transaction_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,status TEXT NOT NULL,intent_json TEXT NOT NULL,previous_digests_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_samples(sample_id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,provider_session_id TEXT,session_key TEXT,session_ref_json TEXT,sample_json TEXT NOT NULL,observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_usage_samples(sample_id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,provider_session_id TEXT,session_key TEXT,session_ref_json TEXT,sample_json TEXT NOT NULL,observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS live_settings_acknowledgments(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,provider_session_id TEXT,session_key TEXT,session_ref_json TEXT,revision INTEGER NOT NULL,acknowledged_at TEXT NOT NULL,PRIMARY KEY(run_id,role,revision));
      CREATE TABLE IF NOT EXISTS continuity_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,authoritative_state_revision INTEGER NOT NULL,session_key TEXT,session_ref_json TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS continuity_checkpoints(checkpoint_id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,event_sequence INTEGER NOT NULL,state TEXT NOT NULL,delta_json TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,predecessor_digest TEXT,authoritative_state_revision INTEGER NOT NULL,session_key TEXT,session_ref_json TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS continuity_heads(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,state TEXT NOT NULL,event_sequence INTEGER NOT NULL,digest TEXT NOT NULL,authoritative_state_revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,role));
      CREATE TABLE IF NOT EXISTS handoffs(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),generation INTEGER NOT NULL,role TEXT NOT NULL,manifest_digest TEXT NOT NULL,markdown_digest TEXT NOT NULL,predecessor_session_id TEXT,predecessor_session_key TEXT,predecessor_session_ref_json TEXT,successor_session_id TEXT,successor_session_key TEXT,successor_session_ref_json TEXT,state TEXT NOT NULL,failure TEXT,created_at TEXT NOT NULL,accepted_at TEXT,PRIMARY KEY(run_id,generation));
      CREATE TABLE IF NOT EXISTS role_mutation_leases(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,generation INTEGER NOT NULL,provider_session_id TEXT NOT NULL,provider_session_key TEXT,provider_session_ref_json TEXT,moved_at TEXT NOT NULL,PRIMARY KEY(run_id,role));
      CREATE TABLE IF NOT EXISTS compaction_attempts(idempotency_key TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,provider_session_id TEXT,session_key TEXT,session_ref_json TEXT,crossing_key TEXT NOT NULL,status TEXT NOT NULL,before_sample_json TEXT,after_sample_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_decisions(decision_id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),decided_at TEXT NOT NULL,mode TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,session_key TEXT,session_ref_json TEXT,receipt_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_events_run ON workflow_events(run_id,sequence);
      CREATE INDEX IF NOT EXISTS operations_run ON operation_journal(run_id,status);
      CREATE INDEX IF NOT EXISTS recovery_attempt_scope ON recovery_attempts(run_id,ticket,phase,cause,operation_key,outcome);
      CREATE INDEX IF NOT EXISTS human_decisions_run ON human_decisions(run_id,status,created_at);
      CREATE INDEX IF NOT EXISTS context_samples_run_role ON context_samples(run_id,role,sample_id);
      CREATE INDEX IF NOT EXISTS continuity_events_run ON continuity_events(run_id,sequence);
      CREATE INDEX IF NOT EXISTS continuity_checkpoints_run_role ON continuity_checkpoints(run_id,role,checkpoint_id);
      CREATE INDEX IF NOT EXISTS compaction_session ON compaction_attempts(run_id,role,provider_session_id,status);
    `);
    for (const [table, columns] of Object.entries({
      provider_sessions: { session_key: "TEXT", session_ref_json: "TEXT" },
      context_samples: { session_key: "TEXT", session_ref_json: "TEXT" },
      session_usage_samples: { session_key: "TEXT", session_ref_json: "TEXT" },
      live_settings_acknowledgments: { session_key: "TEXT", session_ref_json: "TEXT" },
      continuity_events: { session_key: "TEXT", session_ref_json: "TEXT" },
      continuity_checkpoints: { session_key: "TEXT", session_ref_json: "TEXT" },
      handoffs: { predecessor_session_key: "TEXT", predecessor_session_ref_json: "TEXT", successor_session_key: "TEXT", successor_session_ref_json: "TEXT" },
      role_mutation_leases: { provider_session_key: "TEXT", provider_session_ref_json: "TEXT" },
      compaction_attempts: { session_key: "TEXT", session_ref_json: "TEXT" },
      recovery_decisions: { session_key: "TEXT", session_ref_json: "TEXT" },
    })) {
      for (const [column, definition] of Object.entries(columns)) this.ensureColumn(table, column, definition);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS provider_sessions_scoped ON provider_sessions(run_id,role,session_key,id);
      CREATE INDEX IF NOT EXISTS provider_session_bindings_id ON provider_session_bindings(provider_session_id,role,observed_at);
      CREATE INDEX IF NOT EXISTS context_samples_scoped ON context_samples(run_id,role,session_key,sample_id);
      CREATE INDEX IF NOT EXISTS session_usage_scoped ON session_usage_samples(run_id,role,session_key,sample_id);
      CREATE INDEX IF NOT EXISTS compaction_session_scoped ON compaction_attempts(run_id,role,session_key,status);
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((existing) => existing.name === column)) {
      this.db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
    }
  }
}

type DbRun = { run_id: string; kind: WorkflowKind; status: WorkflowRunStatus; checkpoint: string; original_work_json: string; remaining_work_json: string; state_json: string; lease_generation: number | null; legacy: number; created_at: string; updated_at: string };
type DbOperation = { idempotency_key: string; run_id: string; kind: string; status: OperationLifecycle; intent_json: string; result_json: string | null; external_id: string | null; error: string | null; created_at: string; updated_at: string };
type DbLease = { owner: string; generation: number; pid: number; host: string; process_start: string; heartbeat_at: string; run_id: string };
type DbContinuityEvent = { sequence: number; run_id: string; role: "builder" | "qa" | "host"; kind: string; payload_json: string; digest: string; authoritative_state_revision: number; session_key: string | null; session_ref_json: string | null; created_at: string };
type DbContinuityCheckpoint = { checkpoint_id: number; run_id: string; role: "builder" | "qa"; event_sequence: number; state: ContinuityHeadState; delta_json: string; digest: string; predecessor_digest: string | null; authoritative_state_revision: number; session_key: string | null; session_ref_json: string | null; created_at: string };
type DbContinuityHead = { run_id: string; role: "builder" | "qa" | "run"; state: ContinuityHeadState; event_sequence: number; digest: string; authoritative_state_revision: number; updated_at: string };
type DbHandoff = { run_id: string; generation: number; manifest_digest: string; markdown_digest: string; predecessor_session_id: string | null; predecessor_session_key: string | null; predecessor_session_ref_json: string | null; successor_session_id: string | null; successor_session_key: string | null; successor_session_ref_json: string | null; state: HandoffLineage["state"]; created_at: string; accepted_at: string | null };
type DbCompactionAttempt = { idempotency_key: string; run_id: string; role: "builder" | "qa"; provider_session_id: string | null; session_key: string | null; session_ref_json: string | null; crossing_key: string; status: CompactionAttemptRecord["status"]; before_sample_json: string | null; after_sample_json: string | null; error: string | null; created_at: string; updated_at: string };

function rowToRun(row: DbRun): WorkflowRunSnapshot { return { runId: row.run_id, kind: row.kind, status: row.status, checkpoint: row.checkpoint, originalWork: parseJson(row.original_work_json), remainingWork: parseJson(row.remaining_work_json), state: parseJson(row.state_json) as Record<string, unknown>, ...(row.lease_generation === null ? {} : { leaseGeneration: row.lease_generation }), legacy: Boolean(row.legacy), createdAt: row.created_at, updatedAt: row.updated_at }; }
function operationFromRow(row: DbOperation): OperationRecord { return { idempotencyKey: row.idempotency_key, runId: row.run_id, kind: row.kind, status: row.status, intent: parseJson(row.intent_json), ...(row.result_json ? { result: parseJson(row.result_json) } : {}), ...(row.external_id ? { externalId: row.external_id } : {}), ...(row.error ? { error: row.error } : {}), createdAt: row.created_at, updatedAt: row.updated_at }; }
function continuityEventFromRow(row: DbContinuityEvent): ContinuityEvent { return { sequence: row.sequence, runId: row.run_id, role: row.role, kind: row.kind, payload: parseJson(row.payload_json), digest: row.digest, authoritativeStateRevision: row.authoritative_state_revision, createdAt: row.created_at, ...(row.session_key ? { sessionKey: row.session_key } : {}), ...(row.session_ref_json ? { sessionRef: parseJson(row.session_ref_json) as ProviderSessionRefV1 } : {}) }; }
function continuityCheckpointFromRow(row: DbContinuityCheckpoint): ContinuityCheckpoint { return { checkpointId: row.checkpoint_id, runId: row.run_id, role: row.role, sequence: row.event_sequence, state: row.state, delta: parseJson(row.delta_json) as ContinuityDelta, digest: row.digest, ...(row.predecessor_digest ? { predecessorDigest: row.predecessor_digest } : {}), authoritativeStateRevision: row.authoritative_state_revision, createdAt: row.created_at, ...(row.session_key ? { sessionKey: row.session_key } : {}), ...(row.session_ref_json ? { sessionRef: parseJson(row.session_ref_json) as ProviderSessionRefV1 } : {}) }; }
function continuityHeadFromRow(row: DbContinuityHead): ContinuityHead { return { runId: row.run_id, role: row.role, state: row.state, sequence: row.event_sequence, digest: row.digest, authoritativeStateRevision: row.authoritative_state_revision, updatedAt: row.updated_at }; }
function handoffFromRow(row: DbHandoff): HandoffLineage { return { runId: row.run_id, generation: row.generation, manifestDigest: row.manifest_digest, markdownDigest: row.markdown_digest, ...(row.predecessor_session_id ? { predecessorSessionId: row.predecessor_session_id } : {}), ...(row.predecessor_session_ref_json ? { predecessorSessionRef: parseJson(row.predecessor_session_ref_json) as ProviderSessionRefV1 } : {}), ...(row.successor_session_id ? { successorSessionId: row.successor_session_id } : {}), ...(row.successor_session_ref_json ? { successorSessionRef: parseJson(row.successor_session_ref_json) as ProviderSessionRefV1 } : {}), state: row.state, createdAt: row.created_at, ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}) }; }
function compactionAttemptFromRow(row: DbCompactionAttempt): CompactionAttemptRecord { return { idempotencyKey: row.idempotency_key, runId: row.run_id, role: row.role, ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}), ...(row.session_key ? { sessionKey: row.session_key } : {}), ...(row.session_ref_json ? { sessionRef: parseJson(row.session_ref_json) as ProviderSessionRefV1 } : {}), crossingKey: row.crossing_key, status: row.status, ...(row.before_sample_json ? { beforeSample: parseJson(row.before_sample_json) as ContextSample } : {}), ...(row.after_sample_json ? { afterSample: parseJson(row.after_sample_json) as ContextSample } : {}), ...(row.error ? { error: row.error } : {}), createdAt: row.created_at, updatedAt: row.updated_at }; }
function json(value: unknown): string { return JSON.stringify(value ?? null); }
function parseJson(value: string): unknown { return JSON.parse(value); }
function sessionParts(ref?: ProviderSessionRefV1, rawId?: string, suppliedKey?: string): {
  id: string | null;
  key: string | null;
  ref?: ProviderSessionRefV1;
  refJson: string | null;
} {
  const key = ref ? providerSessionKey(ref) : suppliedKey;
  return { id: ref?.sessionId ?? rawId ?? null, key: key ?? null, ...(ref ? { ref } : {}), refJson: ref ? json(ref) : null };
}
function sanitizeText(value: string): string { return value.replace(/\b(sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|password)\s*[:=]\s*\S+)/gi, "[REDACTED]"); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
function digestJson(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function sanitizeContinuityValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[TRUNCATED]";
  if (typeof value === "string") return sanitizeText(value).slice(0, 20_000);
  if (Array.isArray(value)) return value.slice(0, 500).map((entry) => sanitizeContinuityValue(entry, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !/^(credential|secret|hidden_reasoning|raw_transcript|api_key|token|password)$/i.test(key)).slice(0, 500).map(([key, entry]) => [key, sanitizeContinuityValue(entry, depth + 1)]));
  return value;
}
function processStartIdentity(pid = process.pid): string { try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21] ?? "unavailable"; } catch { return "unavailable"; } }
function leaseVerifiedLive(lease: ProjectLease, now: Date, staleMs: number): boolean {
  if (now.getTime() - new Date(lease.heartbeatAt).getTime() > staleMs) return false;
  if (lease.host !== hostname()) return true;
  try { process.kill(lease.pid, 0); return processStartIdentity(lease.pid) === lease.processStart; } catch { return false; }
}
function ensureRecoveryGitignore(projectDir: string): void {
  const localExclude = join(projectDir, ".git", "info", "exclude");
  const path = existsSync(localExclude) ? localExclude : join(projectDir, ".gitignore");
  const entries = [WORKFLOW_DB_FILE, `${WORKFLOW_DB_FILE}-wal`, `${WORKFLOW_DB_FILE}-shm`, ".rafi/cache/handoffs/"];
  const existing = existsSync(path) ? readFileSync(path, "utf8") : ""; const missing = entries.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (missing.length) appendFileSync(path, `${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, "utf8");
}
