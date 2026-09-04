import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { PendingHumanDecision, RecoveryAttemptReceipt, SupervisorState, WorkflowIssue } from "rafi-spec";
import { WORKFLOW_DB_FILE, type OperationRecord, type ProjectLease, type WorkflowKind, type WorkflowRunSnapshot, type WorkflowRunStatus } from "./workflowDb.js";
import type { BranchResumeSession } from "./branch/resume.js";

type DbRun = { run_id: string; kind: WorkflowKind; status: WorkflowRunStatus; checkpoint: string; original_work_json: string; remaining_work_json: string; state_json: string; lease_generation: number | null; legacy: number; created_at: string; updated_at: string };

/** Inspection-only recovery access. It never creates `.rafi`, migrates, imports, checkpoints WAL, or updates timestamps. */
export class WorkflowReader {
  readonly path: string;
  private readonly db?: Database.Database;
  constructor(projectDir: string, path = join(resolve(projectDir), WORKFLOW_DB_FILE)) {
    this.path = path;
    if (!existsSync(path)) return;
    this.db = new Database(path, { readonly: true, fileMustExist: true });
    this.db.pragma("query_only = ON");
  }
  close(): void { this.db?.close(); }
  available(): boolean { return Boolean(this.db); }
  getRun(runId: string): WorkflowRunSnapshot | undefined {
    if (!this.db) return undefined;
    try { const row = this.db.prepare("SELECT * FROM workflow_runs WHERE run_id=?").get(runId) as DbRun | undefined; return row ? toRun(row) : undefined; } catch { return undefined; }
  }
  activeRuns(): WorkflowRunSnapshot[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT * FROM workflow_runs WHERE status IN ('running','paused','blocked') ORDER BY created_at").all() as DbRun[]).map(toRun); } catch { return []; }
  }
  buildRuns(): WorkflowRunSnapshot[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT * FROM workflow_runs WHERE kind='build' ORDER BY updated_at DESC").all() as DbRun[]).map(toRun); } catch { return []; }
  }
  events(runId: string): Array<{ sequence: number; type: string; checkpoint: string; payload: unknown; at: string }> {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT sequence,event_type,checkpoint,payload_json,created_at FROM workflow_events WHERE run_id=? ORDER BY sequence").all(runId) as Array<Record<string, unknown>>).map(row => ({ sequence: Number(row.sequence), type: String(row.event_type), checkpoint: String(row.checkpoint), payload: JSON.parse(String(row.payload_json)), at: String(row.created_at) })); } catch { return []; }
  }
  issues(runId: string): WorkflowIssue[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT issue_json FROM workflow_issues WHERE run_id=? ORDER BY issue_id").all(runId) as Array<{ issue_json: string }>).map(row => JSON.parse(row.issue_json)); } catch { return []; }
  }
  operations(runId: string): OperationRecord[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT * FROM operation_journal WHERE run_id=? ORDER BY created_at,idempotency_key").all(runId) as Array<Record<string, unknown>>).map(row => ({ idempotencyKey: String(row.idempotency_key), runId: String(row.run_id), kind: String(row.kind), status: String(row.status) as OperationRecord["status"], intent: JSON.parse(String(row.intent_json)), ...(row.result_json ? { result: JSON.parse(String(row.result_json)) } : {}), ...(row.external_id ? { externalId: String(row.external_id) } : {}), ...(row.error ? { error: String(row.error) } : {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at) })); } catch { return []; }
  }
  currentLease(): ProjectLease | undefined {
    if (!this.db) return undefined;
    try { const row = this.db.prepare("SELECT * FROM project_lease WHERE singleton=1").get() as Record<string, unknown> | undefined; return row ? { owner: String(row.owner), generation: Number(row.generation), pid: Number(row.pid), host: String(row.host), processStart: String(row.process_start), heartbeatAt: String(row.heartbeat_at), runId: String(row.run_id) } : undefined; } catch { return undefined; }
  }
  continuityHeads(runId: string): Array<{ role: string; state: string; sequence: number; digest: string; updatedAt: string }> {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT * FROM continuity_heads WHERE run_id=? ORDER BY role").all(runId) as Array<Record<string, unknown>>).map(row => ({ role: String(row.role), state: String(row.state), sequence: Number(row.event_sequence), digest: String(row.digest), updatedAt: String(row.updated_at) })); } catch { return []; }
  }
  branchResumeSessions(activeOnly = true): BranchResumeSession[] {
    if (!this.db) return [];
    try { return (this.db.prepare(`SELECT session_json FROM branch_resume_sessions${activeOnly ? " WHERE status='active'" : ""} ORDER BY updated_at,ticket`).all() as Array<{ session_json: string }>).map(row => JSON.parse(row.session_json)); } catch { return []; }
  }
  recoveryAttempts(runId: string): RecoveryAttemptReceipt[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT receipt_json FROM recovery_attempts WHERE run_id=? ORDER BY intended_at,attempt_id").all(runId) as Array<{ receipt_json: string }>).map((row) => JSON.parse(row.receipt_json)); } catch { return []; }
  }
  pendingHumanDecisions(runId: string): PendingHumanDecision[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT decision_json FROM human_decisions WHERE run_id=? AND status='pending' ORDER BY created_at").all(runId) as Array<{ decision_json: string }>).map((row) => JSON.parse(row.decision_json)); } catch { return []; }
  }
  supervisorState(runId: string): SupervisorState | undefined {
    if (!this.db) return undefined;
    try { const row = this.db.prepare("SELECT state_json FROM supervisor_leases WHERE run_id=?").get(runId) as { state_json: string } | undefined; return row ? JSON.parse(row.state_json) : undefined; } catch { return undefined; }
  }
  /** Bounded bulk evidence read. Uses one query per table, never one connection or query per run. */
  runEvidence(runIds: readonly string[], perKindLimit = 100): Record<string, { events: ReturnType<WorkflowReader["events"]>; issues: WorkflowIssue[]; operations: OperationRecord[]; continuity: ReturnType<WorkflowReader["continuityHeads"]> }> {
    const result: Record<string, { events: ReturnType<WorkflowReader["events"]>; issues: WorkflowIssue[]; operations: OperationRecord[]; continuity: ReturnType<WorkflowReader["continuityHeads"]> }> = {};
    if (!this.db || !runIds.length) return result;
    const ids = [...new Set(runIds)].slice(0, 5);
    for (const id of ids) result[id] = { events: [], issues: [], operations: [], continuity: [] };
    const marks = ids.map(() => "?").join(","); const limit = Math.max(1, Math.min(500, perKindLimit));
    try {
      const events = this.db.prepare(`SELECT * FROM (SELECT run_id,sequence,event_type,checkpoint,payload_json,created_at,ROW_NUMBER() OVER(PARTITION BY run_id ORDER BY sequence DESC) rn FROM workflow_events WHERE run_id IN (${marks})) WHERE rn<=? ORDER BY run_id,sequence`).all(...ids, limit) as Array<Record<string, unknown>>;
      for (const row of events) result[String(row.run_id)]?.events.push({ sequence: Number(row.sequence), type: String(row.event_type), checkpoint: String(row.checkpoint), payload: JSON.parse(String(row.payload_json)), at: String(row.created_at) });
      const issues = this.db.prepare(`SELECT * FROM (SELECT run_id,issue_json,ROW_NUMBER() OVER(PARTITION BY run_id ORDER BY issue_id DESC) rn FROM workflow_issues WHERE run_id IN (${marks})) WHERE rn<=? ORDER BY run_id,rn DESC`).all(...ids, limit) as Array<Record<string, unknown>>;
      for (const row of issues) result[String(row.run_id)]?.issues.push(JSON.parse(String(row.issue_json)) as WorkflowIssue);
      const operations = this.db.prepare(`SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY run_id ORDER BY created_at DESC,idempotency_key) rn FROM operation_journal WHERE run_id IN (${marks})) WHERE rn<=? ORDER BY run_id,created_at,idempotency_key`).all(...ids, limit) as Array<Record<string, unknown>>;
      for (const row of operations) result[String(row.run_id)]?.operations.push({ idempotencyKey: String(row.idempotency_key), runId: String(row.run_id), kind: String(row.kind), status: String(row.status) as OperationRecord["status"], intent: JSON.parse(String(row.intent_json)), ...(row.result_json ? { result: JSON.parse(String(row.result_json)) } : {}), ...(row.external_id ? { externalId: String(row.external_id) } : {}), ...(row.error ? { error: String(row.error) } : {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at) });
      const continuity = this.db.prepare(`SELECT * FROM continuity_heads WHERE run_id IN (${marks}) ORDER BY run_id,role`).all(...ids) as Array<Record<string, unknown>>;
      for (const row of continuity) result[String(row.run_id)]?.continuity.push({ role: String(row.role), state: String(row.state), sequence: Number(row.event_sequence), digest: String(row.digest), updatedAt: String(row.updated_at) });
    } catch { /* an older recovery schema exposes only the legacy per-run accessors */ }
    return result;
  }
}

function toRun(row: DbRun): WorkflowRunSnapshot {
  return { runId: row.run_id, kind: row.kind, status: row.status, checkpoint: row.checkpoint, originalWork: JSON.parse(row.original_work_json), remainingWork: JSON.parse(row.remaining_work_json), state: JSON.parse(row.state_json), ...(row.lease_generation === null ? {} : { leaseGeneration: row.lease_generation }), legacy: Boolean(row.legacy), createdAt: row.created_at, updatedAt: row.updated_at };
}
