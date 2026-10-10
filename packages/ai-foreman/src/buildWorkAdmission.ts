import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { qaDigest } from "./qaProtocolV2.js";

import { validateBuildWorkAdmissionV1, type BuildWorkAdmissionV1 } from "rafi-spec";
export type { BuildWorkAdmissionV1 } from "rafi-spec";
export interface AdmitWorkInput {
  runId: string; workId?: string; kind: "ticket" | "synthetic"; ticketId?: string;
  definition: unknown; approvalId: string; scopeRevision: string;
  provenance: BuildWorkAdmissionV1["provenance"];
}

export function admittedWork(db: Database.Database, runId: string, workId: string): BuildWorkAdmissionV1 | undefined {
  const row = db.prepare("SELECT a.record_json FROM build_work_admissions a JOIN build_work_scope s USING(run_id,work_id) WHERE a.run_id=? AND a.work_id=? AND s.state='admitted' ORDER BY a.sequence DESC LIMIT 1").get(runId, workId) as {record_json:string} | undefined;
  return row ? JSON.parse(row.record_json) : undefined;
}
export function assertAdmittedWork(db: Database.Database, runId: string, workId: string): BuildWorkAdmissionV1 {
  const admission = admittedWork(db, runId, workId);
  if (!admission) throw new Error(`Work ${runId}/${workId} is not admitted; ownership reconciliation is required before dispatch`);
  return admission;
}

/** Only host approval/reconciliation callers hold this service; reads never call it. */
export function admitWork(db: Database.Database, input: AdmitWorkInput, metadataRepair = false): BuildWorkAdmissionV1 {
  if (!input.approvalId || !input.scopeRevision || !input.provenance.reason || !(input.provenance.userTurn || input.provenance.decisionId || input.provenance.approvedPlanDigest)) throw new Error("Work admission requires explicit authorization provenance and requirements revision");
  if (input.kind === "ticket" && (!input.ticketId || input.workId && input.workId !== input.ticketId || input.ticketId.startsWith("synthetic:"))) throw new Error("Ticket work identity is invalid");
  const workId = input.kind === "ticket" ? input.ticketId! : input.workId ?? `synthetic:${randomUUID()}`;
  if (input.kind === "synthetic" && !/^synthetic:[a-f0-9-]{36}$/.test(workId)) throw new Error("Synthetic work requires a persisted opaque identity");
  const requirementsDigest = qaDigest("admitted-requirements", input.definition);
  return db.transaction(() => {
    const prior = admittedWork(db, input.runId, workId);
    if (prior?.requirementsDigest === requirementsDigest && prior.scopeRevision === input.scopeRevision) return prior;
    const run = db.prepare("SELECT status FROM workflow_runs WHERE run_id=?").get(input.runId) as {status:string} | undefined;
    if (!run || !metadataRepair && ["completed","cancelled","superseded"].includes(run.status)) throw new Error("Admission requires a nonterminal build");
    const quarantined = db.prepare("SELECT state FROM build_work_scope WHERE run_id=? AND work_id=?").get(input.runId, workId) as {state:string} | undefined;
    if (quarantined?.state === "quarantined") throw new Error("Historical work requires audited ownership reconciliation before admission");
    db.prepare("INSERT OR IGNORE INTO build_work_scope VALUES(?,?,?,?, 'admitted',?)").run(input.runId, workId, input.kind, input.ticketId ?? null, JSON.stringify(input.definition));
    const definitionBytes = Buffer.from(JSON.stringify(input.definition));
    const definitionDigest = createHash("sha256").update(definitionBytes).digest("hex");
    db.prepare("INSERT OR IGNORE INTO content_refs VALUES(?,'qa',?,?)").run(definitionDigest,definitionBytes,new Date().toISOString());
    db.prepare("UPDATE build_work_scope SET definition_json=? WHERE run_id=? AND work_id=?").run(JSON.stringify(input.definition),input.runId,workId);
    const projectId = (db.prepare("SELECT project_id FROM build_project_identity").get() as {project_id:string}).project_id;
    const record: BuildWorkAdmissionV1 = { version:1, projectId, runId: input.runId, workId, kind:input.kind, ...(input.ticketId ? {ticketId:input.ticketId} : {}), assignmentId: randomUUID(), approvalId:input.approvalId, scopeRevision:input.scopeRevision, requirementsDigest, definitionDigest, admittedAt:new Date().toISOString(), admittedSequence:0, provenance:input.provenance };
    // Reserve sequence explicitly so immutable JSON and its ordinal agree.
    record.admittedSequence = (db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM build_work_admissions").get() as {n:number}).n;
    const validation = validateBuildWorkAdmissionV1(record);
    if (!validation.valid) throw new Error(`Invalid work admission: ${validation.errors.join("; ")}`);
    db.prepare("INSERT INTO build_work_admissions VALUES(?,?,?,?,?,?,?,?,?,?)").run(record.admittedSequence, randomUUID(), record.runId, workId, record.assignmentId, record.approvalId, record.scopeRevision, requirementsDigest, JSON.stringify(record), record.admittedAt);
    const snapshot = db.prepare("SELECT state_json FROM workflow_runs WHERE run_id=?").get(input.runId) as {state_json:string};
    const state = JSON.parse(snapshot.state_json);
    if (metadataRepair && !Array.isArray(state.tickets)) state.tickets=[];
    if ((metadataRepair || state.version !== undefined) && Array.isArray(state.tickets) && !state.tickets.includes(workId)) {
      state.tickets.push(workId);
      db.prepare("UPDATE workflow_runs SET state_json=? WHERE run_id=?").run(JSON.stringify(state),input.runId);
    }
    return record;
  }).immediate();
}
