import { bytesDigest } from "./graph/util.js";
import { measureQaPreparation, type QaMetricEvent } from "./qaPreparationMetrics.js";
import { graphDerivedAllowed } from "./graph/derived.js";
import { readGraphRecord, type GraphRecordKind } from "./graph/storage.js";
import { type ReadinessProcess } from "./readinessCleanup.js";
import { checkBuildOwnershipSchema, canonicalProject } from "./buildAdmission.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { PendingHumanDecision, RecoveryAttemptReceipt, ResolvedAutonomyPolicy, SupervisorState, WorkflowIssue } from "rafi-spec";
import { WORKFLOW_DB_FILE, type OperationRecord, type RoleMutationLease, type ProjectLease, type WorkflowKind, type WorkflowRunSnapshot, type WorkflowRunStatus } from "./workflowDb.js";
import type { BranchResumeSession } from "./branch/resume.js";

type DbRun = { run_id: string; kind: WorkflowKind; status: WorkflowRunStatus; checkpoint: string; original_work_json: string; remaining_work_json: string; state_json: string; lease_generation: number | null; legacy: number; created_at: string; updated_at: string };

/** Inspection-only recovery access. It never creates `.rafi`, migrates, imports, checkpoints WAL, or updates timestamps. */
export class WorkflowReader {
  readonly path: string;
  private readonly db?: Database.Database;
  constructor(private readonly projectDir: string, path = join(resolve(projectDir), WORKFLOW_DB_FILE)) {
    this.path = path;
    if (!existsSync(path)) return;
    this.db = new Database(path, { readonly: true, fileMustExist: true });
    this.db.pragma("query_only = ON");
    try { checkBuildOwnershipSchema(this.db); } catch (error) { this.db.close(); throw error; }
  }
  qaPreparation(runId: string): { mode: string; works: Array<{ workId: string; state: string; digest?: string; depth?: number; detail?: string }> } {
    if (!this.db || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qa_preparation_policy'").get()) return { mode: "legacy", works: [] };
    const policy = this.db.prepare("SELECT record_json FROM qa_preparation_policy WHERE run_id=?").get(runId) as { record_json: string } | undefined;
    const rows = this.db.prepare("SELECT h.work_id,h.state,h.digest,h.detail,c.record_json FROM qa_contract_heads h LEFT JOIN qa_verification_contracts c ON c.digest=h.digest WHERE h.run_id=?").all(runId) as Array<{ work_id: string; state: string; digest?: string; detail?: string; record_json?: string }>;
    return { mode: policy ? JSON.parse(policy.record_json).mode : "legacy", works: rows.map(row => ({ workId: row.work_id, state: row.state, digest: row.digest, detail: row.detail && !this.graphEvidenceAllowed(bytesDigest(row.detail)) ? "Graph-derived preparation detail withheld; source-based recovery required" : row.detail, depth: row.record_json && this.graphEvidenceAllowed(bytesDigest(row.record_json)) ? JSON.parse(row.record_json).depthDecision?.level : undefined })) };
  }
  qaPreparationMetrics(runId: string) {
    const events = this.qaPreparationEvents(runId), withheld = events.filter(event => event.kind === "evidence-unavailable").length;
    return { ...measureQaPreparation(events.filter(event => event.kind === "metric").map(event => event.value as QaMetricEvent)), ...(withheld ? { withheldEvents: withheld, limitation: "Metrics are incomplete: graph-derived events are unavailable" } : {}) };
  }
  qaPreparationEvents(runId: string): Array<{ eventId: string; workId: string; kind: string; value: unknown }> {
    if (!this.db || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qa_preparation_events'").get()) return [];
    return (this.db.prepare("SELECT event_id,work_id,kind,record_json FROM qa_preparation_events WHERE run_id=? ORDER BY rowid").all(runId) as Array<{ event_id: string; work_id: string; kind: string; record_json: string }>).map(row => ({ eventId: row.event_id, workId: row.work_id, kind: this.graphEvidenceAllowed(bytesDigest(row.record_json)) ? row.kind : "evidence-unavailable", value: this.graphEvidenceAllowed(bytesDigest(row.record_json)) ? JSON.parse(row.record_json) : { unavailable: "graph-access-revoked", originalDigest: bytesDigest(row.record_json) } }));
  }
  graphHostProjectIdentity():string|undefined {if(!this.db||!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='build_project_identity'").get())return;return (this.db.prepare("SELECT project_id FROM build_project_identity WHERE singleton=1").get() as {project_id:string}|undefined)?.project_id;}
  graphEvidenceAllowed(digest:string):boolean {return this.db ? graphDerivedAllowed(this.db,this.projectDir,digest) : true;}
  close(): void { this.db?.close(); }
  graphRecord<T>(kind: GraphRecordKind, id: string): { revision: number; value: T } | undefined { return readGraphRecord<T>(this.db, kind, id); }
  graphReceiptSummaries(runId:string):unknown[]{
    if(!this.db || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='graph_records'").get())return [];
    return this.db.prepare("SELECT id AS receiptId,json_extract(value,'$.purpose') AS purpose,json_extract(value,'$.decision') AS decision,json_extract(value,'$.deliveredAt') AS deliveredAt,json_extract(value,'$.generationIds') AS generationIds FROM graph_records WHERE kind='receipt' AND json_extract(value,'$.runId')=? ORDER BY rowid DESC LIMIT 20").all(runId);
  }
  graphRecentJobs():Array<{id:string;state:string;reason?:string;generationId?:string}>{
    if(!this.db || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='graph_records'").get())return [];
    return this.db.prepare("SELECT id,json_extract(value,'$.state') AS state,json_extract(value,'$.reason') AS reason,json_extract(value,'$.generationId') AS generationId FROM graph_records WHERE kind='job' ORDER BY rowid DESC LIMIT 15").all() as Array<{id:string;state:string;reason?:string;generationId?:string}>;
  }
  graphGenerationForCorpus<T>(corpusDigest: string, policyDigest: string): T | undefined {
    if (!this.db || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='graph_records'").get()) return;
    const row=this.db.prepare("SELECT value FROM graph_records WHERE kind='generation' AND json_extract(value,'$.corpusDigest')=? AND json_extract(value,'$.policyDigest')=? ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 1").get(corpusDigest,policyDigest) as {value:string}|undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  readinessProcesses(): ReadinessProcess[] {
    if (!this.db) return [];
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='build_owned_processes'").get()) return [];
    return this.db.prepare("SELECT * FROM build_owned_processes WHERE state<>'quiescent'").all() as ReadinessProcess[];
  }
  available(): boolean { return Boolean(this.db); }
  getRun(runId: string): WorkflowRunSnapshot | undefined {
    if (!this.db) return undefined;
    try { const row = this.db.prepare("SELECT * FROM workflow_runs WHERE run_id=?").get(runId) as DbRun | undefined; return row ? toRun(row) : undefined; } catch { return undefined; }
  }
  activeRuns(): WorkflowRunSnapshot[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT * FROM workflow_runs WHERE status IN ('running','paused','blocked') ORDER BY created_at").all() as DbRun[]).map(toRun); } catch { return []; }
  }
  buildRuns(strict = false): WorkflowRunSnapshot[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT * FROM workflow_runs WHERE kind='build' ORDER BY updated_at DESC").all() as DbRun[]).map(toRun); } catch (error) { if(strict)throw error; return []; }
  }
  events(runId: string): Array<{ sequence: number; type: string; checkpoint: string; payload: unknown; at: string }> {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT sequence,event_type,checkpoint,payload_json,created_at FROM workflow_events WHERE run_id=? ORDER BY sequence").all(runId) as Array<Record<string, unknown>>).map(row => ({ sequence: Number(row.sequence), type: String(row.event_type), checkpoint: String(row.checkpoint), payload: JSON.parse(String(row.payload_json)), at: String(row.created_at) })); } catch { return []; }
  }
  issues(runId: string): WorkflowIssue[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT issue_json FROM workflow_issues WHERE run_id=? ORDER BY issue_id").all(runId) as Array<{ issue_json: string }>).map(row => JSON.parse(row.issue_json)); } catch { return []; }
  }
  operations(runId: string, strict = false): OperationRecord[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT * FROM operation_journal WHERE run_id=? ORDER BY created_at,idempotency_key").all(runId) as Array<Record<string, unknown>>).map(row => ({ idempotencyKey: String(row.idempotency_key), runId: String(row.run_id), kind: String(row.kind), status: String(row.status) as OperationRecord["status"], intent: JSON.parse(String(row.intent_json)), ...(row.result_json ? { result: JSON.parse(String(row.result_json)) } : {}), ...(row.external_id ? { externalId: String(row.external_id) } : {}), ...(row.error ? { error: String(row.error) } : {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at) })); } catch (error) { if (strict) throw error; return []; }
  }
  currentLease(): ProjectLease | undefined {
    if (!this.db) return undefined;
    try { const row = this.db.prepare("SELECT * FROM project_lease WHERE singleton=1").get() as Record<string, unknown> | undefined; return row ? { owner: String(row.owner), generation: Number(row.generation), pid: Number(row.pid), host: String(row.host), processStart: String(row.process_start), heartbeatAt: String(row.heartbeat_at), runId: String(row.run_id) } : undefined; } catch { return undefined; }
  }
  pendingQaTicketIds(runId: string): string[] {
    if (!this.db) return [];
    const ids: string[] = [];
    for (const query of ["SELECT ticket_id FROM qa_recovery_heads WHERE run_id=? AND pending_action<>'resolved' ORDER BY updated_at,ticket_id", "SELECT ticket_id FROM qa_ticket_heads WHERE run_id=? AND state NOT IN ('completed','waived') ORDER BY updated_at,ticket_id"]) {
      try { for (const row of this.db.prepare(query).all(runId) as Array<{ticket_id:string}>) if (!ids.includes(row.ticket_id)) ids.push(row.ticket_id); }
      catch (error) { if (!String(error).includes("no such table")) throw error; }
    }
    return ids;
  }
  preparationSuccessor(runId: string): string {
    if (!this.db) return runId;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(runId)) throw new Error("Preparation retry lineage contains a cycle");
      seen.add(runId);
      let row: {successor:string;project:string}|undefined;
      try { row = this.db.prepare("SELECT successor,project FROM build_retry_lineage WHERE predecessor=?").get(runId) as typeof row; }
      catch (error) { if (String(error).includes("no such table")) return runId; throw error; }
      if (!row) return runId;
      if (canonicalProject(row.project) !== canonicalProject(this.projectDir)) throw new Error("Preparation lineage belongs to another project");
      runId = row.successor;
    }
  }
  pendingBuildLaunches(runId: string): import("./buildAdmission.js").BuildLaunch[] {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT record_json FROM build_launches WHERE run_id=? AND state IN ('reserved','dispatching')").all(runId) as Array<{record_json:string}>).map(row => JSON.parse(row.record_json)); }
    catch (error) { if (!String(error).includes("no such table")) throw error; return []; }
  }
  buildAdmission(): import("./buildAdmission.js").BuildAdmission | undefined {
    if (!this.db) return undefined;
    try { const row = this.db.prepare("SELECT record_json FROM build_admission WHERE singleton=1").get() as {record_json:string}|undefined; return row ? JSON.parse(row.record_json) : undefined; }
    catch (error) { if (!String(error).includes("no such table")) throw error; return undefined; }
  }
  continuityHeads(runId: string): Array<{ role: string; state: string; sequence: number; digest: string; updatedAt: string }> {
    if (!this.db) return [];
    try { return (this.db.prepare("SELECT * FROM continuity_heads WHERE run_id=? ORDER BY role").all(runId) as Array<Record<string, unknown>>).map(row => ({ role: String(row.role), state: String(row.state), sequence: Number(row.event_sequence), digest: String(row.digest), updatedAt: String(row.updated_at) })); } catch { return []; }
  }
  adoptionMilestones(runId: string): Array<{ sequence: number; role: string; sessionKey?: string; at: string }> {
    if (!this.db) return [];
    try {
      return (this.db.prepare("SELECT sequence,role,session_key,created_at FROM continuity_events WHERE run_id=? AND kind='handoff_adopted' ORDER BY sequence DESC LIMIT 20").all(runId) as Array<Record<string, unknown>>)
        .map(row => ({ sequence: Number(row.sequence), role: String(row.role), ...(row.session_key ? { sessionKey: String(row.session_key) } : {}), at: String(row.created_at) }));
    } catch { return []; }
  }
  branchResumeSessions(activeOnly = true): BranchResumeSession[] {
    if (!this.db) return [];
    try { return (this.db.prepare(`SELECT s.session_json FROM branch_resume_sessions s JOIN workflow_runs r ON r.run_id=s.run_id${activeOnly ? " WHERE s.status='active' AND r.status NOT IN ('superseded','completed','cancelled')" : ""} ORDER BY s.updated_at,s.ticket`).all() as Array<{ session_json: string }>).map(row => JSON.parse(row.session_json)); } catch { return []; }
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
  autonomyPolicy(runId: string): ResolvedAutonomyPolicy | undefined {
    if (!this.db) return undefined;
    try { const row = this.db.prepare("SELECT policy_json FROM run_autonomy_policy WHERE run_id=?").get(runId) as { policy_json: string } | undefined; return row ? JSON.parse(row.policy_json) : undefined; } catch { return undefined; }
  }
  roleMutationLease(runId: string, role: "builder" | "qa"): RoleMutationLease | undefined {
    if (!this.db) return undefined;
    try {
      const row = this.db.prepare("SELECT * FROM role_mutation_leases WHERE run_id=? AND role=?").get(runId, role) as Record<string, unknown> | undefined;
      return row ? { runId, role, generation: Number(row.generation), providerSessionId: String(row.provider_session_id), movedAt: String(row.moved_at),
        ...(row.provider_session_key ? { sessionKey: String(row.provider_session_key) } : {}), ...(row.provider_session_ref_json ? { sessionRef: JSON.parse(String(row.provider_session_ref_json)) } : {}) } : undefined;
    } catch { return undefined; }
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
