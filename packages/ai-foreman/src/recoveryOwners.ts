import { existsSync } from "node:fs";
import Database from "better-sqlite3";

export interface RecoveryOwner {
  source: "build-admission" | "project-lease" | "supervisor" | "owned-process";
  runId: string;
  pid: number | null;
  processStart?: string;
  host?: string;
}

export interface CompletedPlanApproval {
  runId: string;
  originalWork: unknown;
  state: { planId?: string; revision?: number; digest?: string; decisionReceipt?: unknown } & Record<string, unknown>;
  updatedAt: string;
}

/**
 * Reads completed `rafi plan` approval runs without migrating. They are
 * planning state that predates any build, so a build reset must carry them
 * into the fresh database; build recovery refuses to resume without one.
 */
export function readCompletedPlanApprovals(dbPath: string): CompletedPlanApproval[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get()) return [];
    const rows = db.prepare("SELECT run_id,original_work_json,state_json,updated_at FROM workflow_runs WHERE kind='plan' AND status='completed' ORDER BY updated_at")
      .all() as Array<{ run_id: string; original_work_json: string; state_json: string; updated_at: string }>;
    const approvals: CompletedPlanApproval[] = [];
    for (const row of rows) {
      try { approvals.push({ runId: row.run_id, originalWork: JSON.parse(row.original_work_json), state: JSON.parse(row.state_json), updatedAt: row.updated_at }); }
      catch { /* a malformed historical row is not an approval */ }
    }
    return approvals;
  } finally {
    db.close();
  }
}

/**
 * Lists every process that may still own a recovery database, without
 * migrating it. Archiving tools need this because opening a database from an
 * older Rafi through WorkflowDb runs the structured-communication cutover, and
 * a stale build admission left by a dead process makes that cutover fail.
 * Unknown or malformed tables are skipped; callers decide liveness.
 */
export function readRecoveryOwners(dbPath: string): RecoveryOwner[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const has = (table: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const owners: RecoveryOwner[] = [];
    if (has("build_admission")) {
      const row = db.prepare("SELECT record_json FROM build_admission WHERE singleton=1").get() as { record_json: string } | undefined;
      if (row) {
        let record: Record<string, any> | undefined;
        try { record = JSON.parse(row.record_json); } catch { /* malformed: report as unverifiable */ }
        owners.push({ source: "build-admission", runId: String(record?.runId ?? ""), pid: typeof record?.pid === "number" ? record.pid : null, processStart: record?.processStart, host: record?.host });
      }
    }
    if (has("project_lease")) {
      for (const row of db.prepare("SELECT * FROM project_lease").all() as Array<Record<string, any>>) {
        owners.push({ source: "project-lease", runId: String(row.run_id ?? ""), pid: typeof row.pid === "number" ? row.pid : null, processStart: row.process_start ?? undefined, host: row.host ?? undefined });
      }
    }
    if (has("supervisor_leases") && has("workflow_runs")) {
      const rows = db.prepare(`SELECT s.run_id,s.state_json FROM supervisor_leases s JOIN workflow_runs r USING(run_id)
        WHERE r.kind='build' AND r.status NOT IN ('completed','cancelled','superseded')`).all() as Array<{ run_id: string; state_json: string }>;
      for (const row of rows) {
        let state: Record<string, any> | undefined;
        try { state = JSON.parse(row.state_json); } catch { /* malformed: report as unverifiable */ }
        // Matches the prior reset rule: only a supervisor recorded as running owns the run.
        if (state && state.status !== "running") continue;
        owners.push({ source: "supervisor", runId: row.run_id, pid: typeof state?.pid === "number" ? state.pid : null, processStart: state?.processStart });
      }
    }
    if (has("build_owned_processes")) {
      for (const row of db.prepare("SELECT run_id,pid,process_start,host FROM build_owned_processes WHERE state<>'quiescent'").all() as Array<Record<string, any>>) {
        owners.push({ source: "owned-process", runId: String(row.run_id), pid: typeof row.pid === "number" ? row.pid : null, processStart: row.process_start ?? undefined, host: row.host ?? undefined });
      }
    }
    return owners;
  } finally {
    db.close();
  }
}
