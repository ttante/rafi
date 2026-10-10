import { reconcileWork, type BuildOwnershipRepairV1 } from "./buildWorkReconciliation.js";
import { migrateBuildInterventions, hasQueuedBuilderGuidance, reconcileGuidance, decisionWorkId, queuedControls, completeControl, verifyGuidance, builderVerificationContext, verifyBuilderGuidance, assertFinalizationControls, reserveGuidance, finishGuidance, instruction, type InstructionRecipient } from "./buildInterventions.js";
import { migrateBuildWork } from "./buildWorkMigration.js";
import { admitWork, admittedWork, assertAdmittedWork, type AdmitWorkInput } from "./buildWorkAdmission.js";
import { cleanupReadiness, inspectReadiness, readinessMetadata, type ReadinessProcess } from "./readinessCleanup.js";
import { windowsProbeJobState } from "./windowsProbeJob.js";
import { originalBuildLease, rememberOriginalLease, forgetOriginalLease, registerLaunchChild, acknowledgeLaunchChild, reconcileLaunch, checkBuildOwnershipSchema, canonicalProject, launchDigest, localBuildAuthority, rememberBuildAuthority, forgetBuildAuthority, migrateBuildAdmission, acquireAdmission, readAdmission, assertAdmission, releaseAdmission, reserveLaunch, setLaunchState, claimLaunch, readLaunch, type BuildAdmission, type BuildLaunch } from "./buildAdmission.js";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { validateQaFailureReport } from "rafi-spec";
import { migrateQaHandback, registerHandbackWriter, reportOccurrenceId } from "./qaHandbackMigration.js";
import type {
  BuildRecoveryDecisionReceipt,
  ContextSample,
  ContinuityCheckpoint,
  ContinuityDelta,
  ContinuityEvent,
  ContinuityHead,
  ContinuityHeadState,
  HandoffLineage,
  HandoffAcceptanceReceiptV1,
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
import type { QaDeliveryTurnV3, QaDeliveryOutcome, QaDeliveryInvocationV3 } from "./qaDeliveryJournal.js";
import { providerSessionKey } from "./sessionIdentity.js";
import { processGroupQuiescent, taggedProcesses, classifyProcess, isLiveProcessIdentity, processStartIdentity } from "./processIdentity.js";
import type { BranchResumeSession } from "./branch/resume.js";
import {
  initialQaReducerState,
  qaDigest,
  reduceQaState,
  type BuilderRemediationReceiptV2,
  type BuilderRemediationReceiptV3,
  type FrozenQaSourceStateV2,
  type HandoffAcceptanceReceiptV2,
  type QaPassCertificateV2,
  type QaReducerEventV2,
  type QaReducerStateV2,
  type QaReportDisposition,
  type QaReviewBasisV2,
  type QaTurnIntentV2,
  type QaTurnReceiptV2,
} from "./qaProtocolV2.js";

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
  db.function("rafi_protocol_v3", () => 1);
  registerHandbackWriter(db);
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
  status: "started" | "succeeded" | "failed" | "uncertain";
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

export interface QaRecoveryHeadRecord {
  runId: string;
  ticketId: string;
  packetId: string;
  packetPath: string;
  packetDigest: string;
  reviewedStateDigest: string;
  revision: number;
  correctionTurns: number;
  pendingAction: string;
  updatedAt: string;
}

export interface QaPacketProjectionRecord {
  runId: string;
  ticketId: string;
  packetRevision: number;
  packetDigest: string;
  path: string;
  /** Exact canonical manifest bytes needed to finish an interrupted filesystem publication. */
  manifestJson?: string;
  status: "intended" | "published";
  createdAt: string;
}

export interface QaFinalizationStepRecord {
  operationId: string;
  runId: string;
  ticketId: string;
  certificateId: string;
  kind: string;
  status: "intended" | "completed" | "invalidated";
  intent: { expectedSourceStateDigest: string; expectedGitTree: string; allowedProjectionPaths: string[]; reducerRevision: number };
  receipt?: unknown;
}

export interface QaReviewAttemptRecord {
  attemptId: string;
  runId: string;
  ticketId: string;
  reviewNumber: number;
  cycle: number;
  remediationGeneration: number;
  sourceDigest: string;
  status: "started" | "passed" | "failed" | "interrupted";
  reportDigest?: string;
  findingIds?: string[];
  namespacedFindingIds?: string[];
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QaRemediationAttemptRecord {
  recoveryAttemptId?: string;
  attemptId: string;
  runId: string;
  ticketId: string;
  reviewAttemptId: string;
  generation: number;
  mode: "validated-report" | "planner-remediation";
  status: "intended" | "started" | "succeeded" | "failed" | "uncertain";
  requestDigest: string;
  responseDigest?: string;
  summaryDigest?: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export type QaFailureHandoffState =
  | "prepared"
  | "delivery-intended"
  | "delivery-uncertain"
  | "response-invalid"
  | "builder-blocked"
  | "remediation-reported"
  | "recheck-required"
  | "source-drift";

export interface QaFailureHandoffRecord {
  handoffId: string;
  operationId: string;
  runId: string;
  ticketId: string;
  reviewAttemptId: string;
  reportDigest: string;
  generation: number;
  reviewedContentDigest: string;
  reviewBasisDigest: string;
  state: QaFailureHandoffState;
  handoffDigest: string;
  hostInstructionDigest: string;
  builderSession?: ProviderSessionRefV1;
  providerTurnId?: string;
  receiptDigest?: string;
  responseDigest?: string;
  parsedResponseDigest?: string;
  postSourceDigest?: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QaTransitionRecordV2 {
  sequence: number;
  runId: string;
  ticketId: string;
  fromRevision: number;
  toRevision: number;
  event: QaReducerEventV2;
  state: QaReducerStateV2;
  createdAt: string;
}

export interface QaReportRecordV2 {
  reportOccurrenceId: string;
  reportDigest: string;
  runId: string;
  ticketId: string;
  reviewNumber: number;
  sourceStateDigest: string;
  reviewBasisDigest: string;
  disposition: QaReportDisposition;
  report: unknown;
  createdAt: string;
  updatedAt: string;
}

/** Authoritative persistence for every resumable workflow in a project. */
export class WorkflowDb {
  readonly path: string;
  private readonly db: Database.Database;
  private writerAuthority?: BuildAdmission;
  private writerLease?: ProjectLease;
  private coordinatorTransition = 0;
  private lineageTransition = 0;
  private workAuthority = 0;

  constructor(readonly projectDir: string, path = join(resolve(projectDir), WORKFLOW_DB_FILE), private readonly readinessAccess?: { probeId: string } | { runId: string }) {
    this.path = path;
    if (existsSync(path)) {
      const preview = new Database(path, { readonly: true, fileMustExist: true });
      try { checkBuildOwnershipSchema(preview); } finally { preview.close(); }
    }
    if (!readinessAccess) {
      mkdirSync(dirname(path), { recursive: true });
      ensureRecoveryGitignore(resolve(projectDir));
    }
    this.db = new Database(path, { fileMustExist: Boolean(readinessAccess) });
    this.db.function("rafi_protocol_v3", () => 1);
    this.writerAuthority = localBuildAuthority(projectDir);
    this.writerLease = originalBuildLease(projectDir);
    this.db.function("rafi_build_lease_owner", () => this.writerLease?.owner ?? "");
    this.db.function("rafi_build_lease_generation", () => this.writerLease?.generation ?? -1);
    this.db.function("rafi_build_writer_token", () => this.writerAuthority?.token ?? "");
    this.db.function("rafi_build_writer_run", () => this.writerAuthority?.runId ?? "");
    this.db.function("rafi_work_authority", () => this.workAuthority);
    registerHandbackWriter(this.db);
    if (!readinessAccess) this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    try {
      if (readinessAccess) this.restrictReadinessConnection(readinessAccess);
      else { this.migrate(); migrateBuildAdmission(this.db); this.importLegacyOnce(); migrateBuildWork(this.db, projectDir); migrateBuildInterventions(this.db); }
    } catch (error) { this.db.close(); throw error; }
  }

  /** Connection-local SQL fences: helper/reconciler cannot gain general writer rights. */
  private restrictReadinessConnection(access: { probeId: string } | { runId: string }): void {
    const value = "probeId" in access ? access.probeId : access.runId;
    const literal = (this.db.prepare("SELECT quote(?) AS literal").get(value) as {literal:string}).literal;
    for (const {name} of this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>) {
      if (!/^[a-z_]+$/.test(name)) throw new Error("Unexpected readiness storage table");
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const allowed = name === "build_owned_processes" && action === "UPDATE";
        const condition = allowed ? `WHEN OLD.${"probeId" in access ? "id" : "run_id"}<>${literal} OR NEW.id<>OLD.id OR NEW.run_id<>OLD.run_id OR NEW.owner<>OLD.owner OR NEW.host<>OLD.host` : "";
        this.db.exec(`CREATE TEMP TRIGGER readiness_scope_${name}_${action} BEFORE ${action} ON main.${name} ${condition} BEGIN SELECT RAISE(ABORT,'Restricted readiness connection cannot mutate this record'); END`);
      }
    }
  }

  close(): void { this.db.close(); }
  admitWork(input: AdmitWorkInput) {
    this.assertInstructionOwner(input.runId);
    this.workAuthority++;
    try { return admitWork(this.db, input); } finally { this.workAuthority--; }
  }
  private assertInstructionOwner(runId: string): void {
    if(this.writerAuthority) {assertAdmission(this.db,this.writerAuthority);if(this.writerAuthority.runId!==runId&&!this.db.prepare("SELECT 1 FROM build_child_runs WHERE child=? AND parent=?").get(runId,this.writerAuthority.runId))throw new Error("Instruction execution authority belongs to another run");return;}
    if(this.buildAdmission())throw new Error("Instruction consumption requires the original build owner");
    if(this.db.prepare("SELECT 1 FROM build_runtime_runs WHERE run_id=?").get(runId)) {
      const held=this.currentLease();
      if(!held||!this.writerLease||held.owner!==this.writerLease.owner||held.generation!==this.writerLease.generation||held.runId!==runId)throw new Error("Instruction execution requires the original workflow lease");
    }
  }
  reserveGuidance(runId: string, workId: string, recipient: InstructionRecipient, operationId: string, sourceDigest: string, text: string, reserve = true) {
    this.assertInstructionOwner(runId);
    return reserveGuidance(this.db, runId, workId, recipient, operationId, sourceDigest, text, reserve);
  }
  reconcileInstructionDeliveries(runId:string,workId:string):void {this.assertInstructionOwner(runId);this.atomic(()=>reconcileGuidance(this.db,runId,workId));}
  decisionWorkId(decision:PendingHumanDecision):string|undefined {return decisionWorkId(this.db,decision);}
  finishGuidance(ids: string[], recipient: InstructionRecipient, result: Parameters<typeof finishGuidance>[3]) { for(const id of ids)this.assertInstructionOwner(instruction(this.db,id)!.request.runId); finishGuidance(this.db, ids, recipient, result); }
  builderVerificationContext(runId:string,workId:string,sourceDigest:string) {return builderVerificationContext(this.db,runId,workId,sourceDigest);}
  verifyBuilderGuidance(ids:string[],certificate:Parameters<typeof verifyBuilderGuidance>[2],response:string,receiptDigest:string) {for(const id of ids)this.assertInstructionOwner(instruction(this.db,id)!.request.runId);return this.atomic(()=>verifyBuilderGuidance(this.db,ids,certificate,response,receiptDigest));}
  verifyGuidance(ids: string[], certificate: Parameters<typeof verifyGuidance>[2], response: string) { for(const id of ids)this.assertInstructionOwner(instruction(this.db,id)!.request.runId); return this.atomic(()=>verifyGuidance(this.db,ids,certificate,response)); }
  hasQueuedBuilderGuidance(runId:string,workId:string):boolean { return hasQueuedBuilderGuidance(this.db,runId,workId); }
  instruction(id: string) { return instruction(this.db, id); }
  assertFinalizationControls(runId: string, workId: string) { assertFinalizationControls(this.db,runId,workId); }
  consumeInstructionControls(runId: string, workId: string, kind: "questions" | "attempts" = "questions"): string | undefined {
    return this.atomic(() => {
      this.assertInstructionOwner(runId);
      const admission = this.assertAdmittedWork(runId,workId);
      const latestReview=this.qaReviewAttempts(runId,workId).at(-1);
      let authorization: string | undefined = kind==="attempts" && latestReview && ["failed","passed"].includes(latestReview.status) ? (this.db.prepare("SELECT a.authorization_id FROM qa_remediation_authorizations a JOIN build_instruction_deliveries d ON json_extract(d.record_json,'$.receipt.authorizationId')=a.authorization_id JOIN build_instructions i USING(instruction_id) WHERE a.run_id=? AND a.ticket_id=? AND a.review_attempt_id=? AND a.consumed_by IS NULL AND d.state='applied' AND json_extract(i.record_json,'$.requirementsDigest')=? AND json_extract(i.record_json,'$.basis.assignmentId')=? AND json_extract(i.record_json,'$.basis.scopeRevision')=? ORDER BY i.sequence LIMIT 1").get(runId,workId,latestReview.attemptId,admission.requirementsDigest,admission.assignmentId,admission.scopeRevision) as {authorization_id:string}|undefined)?.authorization_id : undefined;
      if (authorization) {
        const head = this.qaTicketHead(runId,workId);
        const eligible = latestReview?.status === "passed"
          ? head.state === "passed" && this.hasQueuedBuilderGuidance(runId,workId)
          : head.state === "review-failed" && this.unresolvedQaReports(runId,workId).some(report=>report.reviewNumber===latestReview!.reviewNumber&&report.reportDigest===latestReview!.reportDigest);
        if (!eligible) authorization = undefined;
      }
      for (const record of queuedControls(this.db,runId,workId).filter(record=>kind==="questions" ? record.request.action==="answer_question" : record.request.action==="request_attempt")) {
        const priorAuthorization=authorization;
        try {
          this.atomic(()=>{
          if (record.requirementsDigest !== admission.requirementsDigest) throw new Error("Instruction requirements are stale");
          if (record.request.action === "answer_question") {
            const decision = this.humanDecision(record.request.decisionId!);
            if (!decision || decision.runId!==runId || this.decisionWorkId(decision)!==workId || createHash("sha256").update(json(decision)).digest("hex")!==record.request.decisionRevision) throw new Error("Pending question identity or revision changed");
            const choice = decision.choices.find(choice=>choice.id===record.request.text||choice.label===record.request.text) ?? decision.choices.find(choice=>choice.id==="custom"||choice.id==="answer");
            if (!choice) throw new Error("Answer must name an offered choice or use a question accepting custom text");
            const answer = this.answerHumanDecision(runId,decision.decisionId,choice.id,new Date(),choice.id==="custom"||choice.id==="answer"?record.request.text:undefined);
            completeControl(this.db,record.instructionId,{decisionId:answer.decisionId,status:answer.status});
          } else {
            const latest = this.qaReviewAttempts(runId,workId).at(-1);
            if (!latest || !["failed","passed"].includes(latest.status) || latest.attemptId!==record.basis.reviewAttemptId || authorization) throw new Error("One extra attempt requires the current eligible review; another authorization is already available");
            if (record.basis.assignmentId !== admission.assignmentId || record.basis.scopeRevision !== admission.scopeRevision) throw new Error("Attempt authorization scope changed");
            const head=this.qaTicketHead(runId,workId);
            if (latest.status === "passed") {
              if (head.state !== "passed" || !this.hasQueuedBuilderGuidance(runId,workId)) throw new Error("Follow-up authorization requires waiting Builder guidance on the current unfinalized pass");
              authorization = this.authorizeQaRemediation(runId,workId,latest.attemptId,record.request.text);
              completeControl(this.db,record.instructionId,{authorizationId:authorization,reviewAttemptId:latest.attemptId,consumed:false,kind:"builder-guidance-followup"});
              return;
            }
            const report=this.unresolvedQaReports(runId,workId).find(report=>report.reviewNumber===latest.reviewNumber&&report.reportDigest===latest.reportDigest&&report.sourceStateDigest===latest.sourceDigest&&report.reviewBasisDigest===head.reviewBasisDigest);
            if(!report||!validateQaFailureReport(report.report).valid||head.reviewNumber!==latest.reviewNumber||head.sourceStateDigest!==latest.sourceDigest||!["review-failed","operator-menu"].includes(head.state)||this.qaRemediationAttempts(runId,workId).some(attempt=>attempt.reviewAttemptId===latest.attemptId))throw new Error("Extra attempt requires an unconsumed validated failed-review basis; reconcile uncertain execution separately");
            const decisions=(this.db.prepare("SELECT decision_id,status,decision_json FROM human_decisions WHERE run_id=? AND decision_key LIKE ?").all(runId,`${runId}:qa-nonconvergence:%`) as Array<{decision_id:string;status:string;decision_json:string}>).filter(row=>this.decisionWorkId(parseJson(row.decision_json) as PendingHumanDecision)===workId&&(parseJson(row.decision_json) as PendingHumanDecision).createdAt>=latest.createdAt);
            if(decisions.some(row=>row.status==="answered"))throw new Error("The nonconvergence decision was already answered; resume that decision before requesting another attempt");
            authorization = this.authorizeQaRemediation(runId,workId,latest.attemptId,record.request.text);
            for(const row of decisions.filter(row=>row.status==="pending")) {
              const decision=parseJson(row.decision_json) as PendingHumanDecision;
              const at=new Date().toISOString();
              this.db.prepare("UPDATE human_decisions SET status='cancelled',decision_json=?,updated_at=? WHERE decision_id=? AND status='pending'").run(json({...decision,status:"cancelled",cancellationReason:`Superseded by scoped attempt instruction ${record.instructionId}`,cancelledAt:at}),at,row.decision_id);
              this.insertEvent(runId,"human_decision_cancelled","attempt-authorized",{decisionId:row.decision_id,instructionId:record.instructionId},at);
            }
            if(head.state==="operator-menu")this.transitionQa(runId,workId,head.revision,{type:"failed-review-restored",reviewNumber:latest.reviewNumber,sourceStateDigest:latest.sourceDigest,reportDigest:report.reportDigest});
            completeControl(this.db,record.instructionId,{authorizationId:authorization,reviewAttemptId:latest.attemptId,consumed:false});
          }
          });
        } catch (error) {authorization=priorAuthorization;completeControl(this.db,record.instructionId,undefined,String(error));}
      }
      return authorization;
    });
  }
  reconcileWork(request: BuildOwnershipRepairV1, input: Parameters<typeof reconcileWork>[2]) {
    this.assertInstructionOwner(request.runId);
    if (this.writerAuthority) assertAdmission(this.db,this.writerAuthority);
    this.workAuthority++;
    try {return this.atomic(()=>reconcileWork(this.db,request,input));} finally {this.workAuthority--;}
  }
  reconciliation(id: string): Record<string,unknown> | undefined {
    const row=this.db.prepare("SELECT record_json FROM build_reconciliations WHERE reconciliation_id=?").get(id) as {record_json:string}|undefined;
    return row?JSON.parse(row.record_json):undefined;
  }
  workDefinitions(runId: string): Array<{workId:string;kind:string;definition:unknown}> {
    return (this.db.prepare("SELECT work_id,kind,definition_json FROM build_work_scope WHERE run_id=? AND state='admitted' ORDER BY rowid").all(runId) as Array<{work_id:string;kind:string;definition_json:string}>).map(row=>({workId:row.work_id,kind:row.kind,definition:JSON.parse(row.definition_json)}));
  }
  recordWorkAssignment(runId: string, workId: string, operationId: string, record: unknown): void {
    this.assertInstructionOwner(runId);
    this.assertAdmittedWork(runId,workId); this.workAuthority++;
    try { this.db.prepare("INSERT INTO build_assignments VALUES(?,?,?,?,?)").run(operationId,runId,workId,operationId,json(record)); } finally {this.workAuthority--;}
  }
  admittedWork(runId: string, workId: string) { return admittedWork(this.db, runId, workId); }
  assertAdmittedWork(runId: string, workId: string) { return assertAdmittedWork(this.db, runId, workId); }

  /** Atomic local changes only; never await provider or filesystem work here. */
  atomic<T>(work: () => T): T { return this.db.transaction(work).immediate(); }

  buildAdmission(): BuildAdmission | undefined { return readAdmission(this.db); }
  private assertNoLegacyBuildOwner(): void {
    for (const row of this.db.prepare("SELECT run_id,state_json FROM workflow_runs WHERE kind='build' AND legacy=1").all() as Array<{run_id:string;state_json:string}>) {
      const state = parseJson(row.state_json) as { status?: string; lease?: {pid:number;processStart?:string;hostname?:string} };
      if (!state.lease || ["completed", "cancelled", "superseded"].includes(state.status ?? "")) continue;
      const owner = classifyProcess(state.lease.pid, state.lease.processStart, state.lease.hostname ?? "unknown-host");
      if (owner.state !== "dead") throw new Error(`Legacy build ${row.run_id} ownership is ${owner.state}: ${owner.reason}; reconcile before starting another writer`);
    }
  }
  private assertExecutionProtocol(): void {
    if ((this.db.prepare("SELECT version FROM build_ownership_schema").get() as {version:number}).version !== 3) throw new Error("Ownership migration is pending legacy execution cleanup; use rafi resume before starting work");
  }
  acquireBuildAdmission(runId: string, phase: BuildAdmission["phase"]): BuildAdmission {
    return this.atomic(() => {
      this.assertNoLegacyBuildOwner();
      const lease = this.currentLease();
      if (lease && classifyProcess(lease.pid, lease.processStart, lease.host).state !== "dead") throw new Error(`project workflow lease is held by ${lease.owner} for run ${lease.runId}`);
      for (const owner of this.runningSupervisors()) {
        if (owner.state.pid && classifyProcess(owner.state.pid, owner.state.processStart).state !== "dead") throw new Error(`supervisor already active for project (run ${owner.runId})`);
      }
      const uncertain = this.db.prepare("SELECT run_id FROM operation_journal WHERE kind='provider-dispatch' AND status IN ('in_progress','uncertain') LIMIT 1").get() as {run_id:string}|undefined;
      if (uncertain) throw new Error(`Build ${uncertain.run_id} has unresolved provider dispatch; reconcile before another launch`);
      for (const row of this.db.prepare("SELECT DISTINCT run_id FROM build_owned_processes WHERE state<>'quiescent'").all() as Array<{run_id:string}>) {
        if (this.unresolvedPreparationProcesses(row.run_id).length) throw new Error(`Build ${row.run_id} has unverified preparation descendants; reconcile before another launch`);
      }
      const prior = this.buildAdmission();
      if (prior && this.unresolvedPreparationProcesses(prior.runId).length) throw new Error(`Build ${prior.runId} has unverified preparation descendants; reconcile before another launch`);
      if (prior && [...this.unresolvedRoleDispatches(prior.runId, "builder"), ...this.unresolvedRoleDispatches(prior.runId, "qa")].length) throw new Error(`Build ${prior.runId} has unresolved provider dispatch; reconcile before another launch`);
      this.assertExecutionProtocol();
      this.ensureRun(runId, "build");
      const authority = acquireAdmission(this.db, this.projectDir, runId, phase);
      this.writerAuthority = authority;
      rememberBuildAuthority(authority);
      return authority;
    });
  }
  acquireBuildRecoveryAdmission(runId: string): BuildAdmission {
    return this.atomic(() => {
      this.assertExecutionProtocol();
      this.assertNoLegacyBuildOwner();
      const otherDispatch = this.db.prepare("SELECT run_id FROM operation_journal WHERE run_id<>? AND kind='provider-dispatch' AND status IN ('in_progress','uncertain') LIMIT 1").get(runId) as {run_id:string}|undefined;
      if (otherDispatch) throw new Error(`Build ${otherDispatch.run_id} has unresolved provider dispatch; reconcile before starting another recovery workflow`);
      const current = localBuildAuthority(this.projectDir);
      if (current && current.runId === runId && this.buildAdmission()?.token === current.token) { this.writerAuthority = current; return current; }
      const prior = this.buildAdmission();
      if (prior && prior.runId !== runId) return this.acquireBuildAdmission(runId, "coordinator");
      if (this.unresolvedPreparationProcesses(runId).length) throw new Error("Owned preparation descendants require reconciliation before recovery");
      const lease = this.currentLease();
      if (lease && classifyProcess(lease.pid, lease.processStart, lease.host).state !== "dead") throw new Error(`project workflow lease is held by ${lease.owner} for run ${lease.runId}`);
      for (const owner of this.runningSupervisors()) if (owner.state.pid && classifyProcess(owner.state.pid, owner.state.processStart).state !== "dead") throw new Error(`supervisor already active for project (run ${owner.runId})`);
      const authority = acquireAdmission(this.db, this.projectDir, runId, "coordinator");
      this.writerAuthority = authority; rememberBuildAuthority(authority);
      return authority;
    });
  }
  admitLeasedBuild(lease: ProjectLease): BuildAdmission {
    return this.atomic(() => {
      this.assertExecutionProtocol();
      const held = this.currentLease();
      if (!held || held.owner !== lease.owner || held.generation !== lease.generation || held.runId !== lease.runId) throw new Error("workflow lease ownership changed");
      const existing = localBuildAuthority(this.projectDir);
      const authority = existing && existing.runId === lease.runId && this.buildAdmission()?.token === existing.token ? existing : acquireAdmission(this.db, this.projectDir, lease.runId, "coordinator");
      this.writerAuthority = authority;
      rememberBuildAuthority(authority);
      return authority;
    });
  }
  reacquireBuildCoordinator(runId: string): BuildAdmission {
    return this.atomic(() => {
      const owner = this.supervisorState(runId);
      if (owner?.pid !== process.pid || owner.processStart !== processStartIdentity()) throw new Error("Supervisor ownership changed");
      const authority = acquireAdmission(this.db, this.projectDir, runId, "coordinator");
      this.writerAuthority = authority;
      rememberBuildAuthority(authority);
      return authority;
    });
  }
  assertBuildAdmission(authority: BuildAdmission): void { assertAdmission(this.db, authority); }
  releaseBuildAdmission(authority: BuildAdmission): void {
    this.atomic(() => {
      assertAdmission(this.db, authority);
      if (this.unresolvedPreparationProcesses(authority.runId).length) throw new Error("Unresolved owned processes or provider dispatch require reconciliation");
      releaseAdmission(this.db, authority); forgetBuildAuthority(authority);
      if (this.writerAuthority?.token === authority.token) this.writerAuthority = undefined;
    });
  }
  reserveBuildLaunch(authority: BuildAdmission, role: BuildAdmission["phase"], digest: string, protocol?: BuildLaunch["protocol"]): BuildLaunch { return reserveLaunch(this.db, authority, role, digest, protocol); }
  dispatchBuildLaunch(authority: BuildAdmission, token: string): void { setLaunchState(this.db, authority, token, "dispatching"); }
  failBuildLaunch(authority: BuildAdmission, token: string): void { setLaunchState(this.db, authority, token, "failed"); }
  claimBuildLaunch(runId: string, token: string, role: BuildAdmission["phase"], digest: string): BuildAdmission { const authority = claimLaunch(this.db, this.projectDir, runId, token, role, digest); this.writerAuthority = authority; rememberBuildAuthority(authority); return authority; }
  registerBuildLaunchChild(token: string): void { registerLaunchChild(this.db, token, this.projectDir); }
  acknowledgeBuildLaunchChild(authority: BuildAdmission, token: string, pid: number): void { acknowledgeLaunchChild(this.db, authority, token, pid); }
  reconcileBuildLaunches(runId: string, original?: BuildAdmission): "retired" | "claimed" | "unknown" {
    return this.atomic(() => {
      let result: "retired" | "claimed" | "unknown" = "retired";
      for (const row of this.db.prepare("SELECT token FROM build_launches WHERE run_id=? AND state IN ('reserved','dispatching')").all(runId) as Array<{token:string}>) {
        const state = reconcileLaunch(this.db, row.token, original);
        if (state === "unknown") return state;
        if (state === "claimed") result = state;
      }
      return result;
    });
  }
  buildLaunch(token: string): BuildLaunch | undefined { return readLaunch(this.db, token); }

  preparationSuccessor(runId: string): string {
    const seen = new Set<string>();
    let current = runId;
    while (true) {
      if (seen.has(current)) throw new Error("Preparation retry lineage contains a cycle");
      seen.add(current);
      const link = this.db.prepare("SELECT successor,project FROM build_retry_lineage WHERE predecessor=?").get(current) as {successor:string;project:string}|undefined;
      if (!link) return current;
      if (link.project !== canonicalProject(this.projectDir)) throw new Error("Preparation lineage belongs to another project");
      current = link.successor;
    }
  }
  reservePreparationRetry(predecessor: string, args: string[], expectedStartArgs?: string): { runId: string; launch: BuildLaunch; authority: BuildAdmission } {
    return this.atomic(() => {
      this.lineageTransition++;
      try {
      const existing = this.preparationSuccessor(predecessor);
      if (existing !== predecessor) throw new Error(`Preparation already retried as ${existing}; select that successor instead`);
      const eligibility = this.preparationEligibility(predecessor);
      if (!eligibility.eligible) throw new Error(`Preparation requires reconciliation: ${eligibility.reasons.join("; ")}`);
      const previous = this.getRun(predecessor)!;
      if (expectedStartArgs !== undefined && JSON.stringify(previous.state.startArgs ?? null) !== expectedStartArgs) throw new Error("Saved preparation options changed before launch reservation; select the build again with rafi resume");
      const authority = this.acquireBuildAdmission(predecessor, "coordinator");
      if (typeof previous.state.predecessor === "string") {
        this.transition(predecessor, { checkpoint: "preparing", state: { ...previous.state, startArgs: args }, event: "preparation_relaunch_reserved" });
        return { runId: predecessor, authority, launch: reserveLaunch(this.db, authority, "coordinator", launchDigest(args), "registered-v2") };
      }
      const runId = randomUUID();
      this.ensureRun(runId, "build");
      for (const row of this.db.prepare("SELECT decision_key,decision_json,created_at,updated_at FROM human_decisions WHERE run_id=? AND status='answered'").all(predecessor) as Array<{decision_key:string;decision_json:string;created_at:string;updated_at:string}>) {
        if (!row.decision_key.startsWith(`${predecessor}:`)) throw new Error("Legacy approval key cannot be attributed safely to retry scope");
        const decision = { ...JSON.parse(row.decision_json), decisionId: randomUUID(), runId };
        this.db.prepare("INSERT INTO human_decisions VALUES(?,?,?,'answered',?,?,?)").run(decision.decisionId, `${runId}:${row.decision_key.slice(predecessor.length + 1)}`, runId, JSON.stringify(decision), row.created_at, row.updated_at);
      }
      const policy = this.autonomyPolicy(predecessor);
      if (policy) this.freezeAutonomyPolicy(runId, policy);
      const supervisor = this.supervisorState(predecessor);
      if (supervisor) this.putSupervisorState(runId, { ...supervisor, status: "stopped", pid: undefined, workerPid: undefined, processStart: undefined });
      this.transition(runId, { checkpoint: "preparing", state: { ...previous.state, startArgs: args, predecessor }, event: "preparation_retry_reserved" });
      this.db.prepare("INSERT INTO build_retry_lineage VALUES(?,?,?,?)").run(predecessor, runId, canonicalProject(this.projectDir), new Date().toISOString());
      this.transition(predecessor, { status: "superseded", checkpoint: "preparation-superseded", state: { ...previous.state, successor: runId }, event: "preparation_superseded", payload: { successor: runId } });
      const next = { ...authority, runId };
      this.db.prepare("UPDATE build_admission SET record_json=? WHERE singleton=1").run(JSON.stringify(next));
      this.writerAuthority = next;
      rememberBuildAuthority(next);
      return { runId, authority: next, launch: reserveLaunch(this.db, next, "coordinator", launchDigest(args), "registered-v2") };
      } finally { this.lineageTransition--; }
    });
  }

  beginOwnedPreparationProcess(authority: BuildAdmission, tag?: string, gated = false): string {
    return this.atomic(() => {
      assertAdmission(this.db, authority);
      const id = tag ?? randomUUID();
      if (gated && (this.db.prepare("SELECT version FROM build_ownership_schema").get() as {version:number}).version !== 3) throw new Error("Legacy build ownership needs reconciliation before readiness protocol migration");
      if (this.unresolvedPreparationProcesses(authority.runId).length) throw new Error("Previous readiness cleanup is unresolved");
      this.db.prepare("INSERT INTO build_owned_processes(id,run_id,owner,pid,process_start,host,state,outcome_json) VALUES(?,?,?,NULL,NULL,?,'intended',?)").run(id, authority.runId, authority.token, authority.host, JSON.stringify(gated ? { protocol: "gated-v3", startup: "intended", revision: 0, authority, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : { protocol: process.platform === "win32" ? "windows-job-v1" : "tagged-v2" }));
      return id;
    });
  }
  recordOwnedPreparationProcess(authority: BuildAdmission, id: string, pid: number): void {
    this.atomic(() => {
      assertAdmission(this.db, authority);
      const row = this.readinessProcesses().find(row => row.id === id);
      if (row && readinessMetadata(row).protocol === "gated-v3") throw new Error("Gated readiness requires helper registration");
      if (this.db.prepare("UPDATE build_owned_processes SET pid=?,process_start=?,state='running' WHERE id=? AND owner=? AND state='intended'").run(pid, processStartIdentity(pid), id, authority.token).changes !== 1) throw new Error("Owned process launch changed");
    });
  }
  finishOwnedPreparationProcess(authority: BuildAdmission, id: string, noChild = false, outcome?: { ready: boolean; exitCode: number | null; timedOut: boolean; cancelled: boolean }): void {
    this.atomic(() => {
      assertAdmission(this.db, authority);
      const row = this.db.prepare("SELECT * FROM build_owned_processes WHERE id=? AND owner=?").get(id, authority.token) as {pid:number|null;process_start:string|null;host:string}|undefined;
      if (!row) throw new Error("Owned process record disappeared");
      const processRow = this.db.prepare("SELECT * FROM build_owned_processes WHERE id=?").get(id) as ReadinessProcess;
      const meta = readinessMetadata(processRow);
      if (outcome) this.db.prepare("UPDATE build_owned_processes SET outcome_json=? WHERE id=?").run(JSON.stringify({ ...meta, ...outcome }), id);
      if ((noChild && row.pid === null && meta.protocol !== "gated-v3") || inspectReadiness(processRow).state === "quiescent") this.db.prepare("UPDATE build_owned_processes SET state='quiescent' WHERE id=?").run(id);


    });
  }
  readinessProcesses(runId?: string): ReadinessProcess[] {
    return this.db.prepare("SELECT * FROM build_owned_processes WHERE state<>'quiescent'" + (runId ? " AND run_id=?" : "")).all(...(runId ? [runId] : [])) as ReadinessProcess[];
  }
  unresolvedPreparationProcesses(runId: string): string[] {
    const parent = (this.db.prepare("SELECT parent FROM build_child_runs WHERE child=?").get(runId) as {parent:string}|undefined)?.parent;
    return this.readinessProcesses().filter(row => row.run_id === runId || row.run_id === parent).map(row => row.id);
  }
  registerReadinessHelper(id: string): void {
    this.atomic(() => {
      const row = this.readinessProcesses().find(row => row.id === id);
      const meta = row && readinessMetadata(row);
      const start = processStartIdentity();
      if (!row || meta?.protocol !== "gated-v3" || meta.startup !== "intended" || row.pid || row.host !== hostname() || start === "unavailable") throw new Error("Readiness registration rejected");
      this.db.prepare("UPDATE build_owned_processes SET pid=?,process_start=?,outcome_json=? WHERE id=?").run(process.pid, start, JSON.stringify({ ...meta, startup: "registered", revision: meta.revision + 1, updatedAt: new Date().toISOString() }), id);
    });
  }
  authorizeReadinessHelper(authority: BuildAdmission, id: string, pid: number): void {
    this.atomic(() => {
      assertAdmission(this.db, authority);
      const row = this.readinessProcesses().find(row => row.id === id);
      const meta = row && readinessMetadata(row);
      if (!row || row.owner !== authority.token || meta?.startup !== "registered" || row.pid !== pid || classifyProcess(pid, row.process_start ?? undefined, row.host).state !== "live") throw new Error("Readiness authorization rejected");
      this.db.prepare("UPDATE build_owned_processes SET outcome_json=? WHERE id=?").run(JSON.stringify({ ...meta, startup: "authorized", revision: meta.revision + 1, updatedAt: new Date().toISOString() }), id);
    });
  }
  assertReadinessHelper(id: string): ReadinessProcess {
    const row = this.readinessProcesses().find(row => row.id === id);
    if (!row || readinessMetadata(row).startup !== "authorized" || row.pid !== process.pid || row.process_start !== processStartIdentity() || row.host !== hostname()) throw new Error("Readiness execution capability rejected");
    return row;
  }
  recordReadinessCreator(id: string, pid: number): void {
    this.atomic(() => {
      const row = this.assertReadinessHelper(id);
      const meta = readinessMetadata(row);
      const start = processStartIdentity(pid);
      if (meta.creator || start === "unavailable") throw new Error("Windows creator registration rejected");
      this.db.prepare("UPDATE build_owned_processes SET outcome_json=? WHERE id=?").run(JSON.stringify({ ...meta, creator: {pid, start}, revision: meta.revision + 1, updatedAt: new Date().toISOString() }), id);
    });
  }
  private assertReadinessRelationships(runId: string): void {
    // Inspect each directed lineage separately; cleanup never broadens to siblings.
    for (const relation of ["parent", "successor", "predecessor"] as const) {
      let current = runId;
      const seen = new Set<string>();
      while (true) {
        if (seen.has(current)) throw new Error("Readiness run relationship contains a cycle");
        seen.add(current);
        const link = relation === "parent"
          ? this.db.prepare("SELECT parent AS target FROM build_child_runs WHERE child=?").get(current) as {target:string;project?:string}|undefined
          : this.db.prepare(`SELECT ${relation} AS target,project FROM build_retry_lineage WHERE ${relation === "successor" ? "predecessor" : "successor"}=?`).get(current) as {target:string;project?:string}|undefined;
        if (!link) break;
        if (!this.getRun(link.target) || (link.project && canonicalProject(link.project) !== canonicalProject(this.projectDir))) throw new Error("Readiness relationship is missing or belongs to another project");
        current = link.target;
      }
    }
  }
  readinessCleanupDetails(runId: string): string[] {
    return this.readinessProcesses(runId).map(row => {
      const meta = readinessMetadata(row);
      try { this.assertReadinessRelationships(runId); this.assertReadinessCleanupOwner(row); }
      catch (error) { return `${row.id}: ${(error as Error).message}`; }
      return `${row.id}: ${meta.cleanup?.reason ?? inspectReadiness(row).reason}`;
    });
  }
  private assertReadinessCleanupOwner(row: ReadinessProcess, original?: BuildAdmission): void {
    const held = this.buildAdmission();
    if (original && held?.token === original.token && row.owner === original.token && original.project === canonicalProject(this.projectDir) && held.project === original.project) return;
    const recorded = readinessMetadata(row).authority as BuildAdmission | undefined;
    const owner = recorded?.token === row.owner ? recorded : held?.token === row.owner ? held : undefined;
    if (owner && (owner.project !== canonicalProject(this.projectDir) || owner.host !== row.host)) throw new Error("Readiness ownership belongs to another project or host");
    if (!owner || classifyProcess(owner.pid, owner.processStart, owner.host).state !== "dead") throw new Error("Readiness owner is live, unknown, or lacks attributable provenance");
  }
  revokeReadinessHelper(id: string, original?: BuildAdmission): void {
    this.atomic(() => {
      const row = this.readinessProcesses().find(row => row.id === id);
      if (!row) return;
      this.assertReadinessCleanupOwner(row, original);
      const meta = readinessMetadata(row);
      if (meta.protocol !== "gated-v3" || !["intended", "registered", "revoked"].includes(meta.startup)) throw new Error("Authorized readiness cannot be revoked; verify cleanup instead");
      if (meta.startup === "revoked") return;
      this.db.prepare("UPDATE build_owned_processes SET outcome_json=? WHERE id=?").run(JSON.stringify({ ...meta, startup: "revoked", revision: meta.revision + 1, updatedAt: new Date().toISOString() }), id);
    });
  }
  async reconcileReadiness(runId: string, original?: BuildAdmission, deadline = Date.now() + 5000): Promise<string[]> {
    // Exact run scope: related/different blockers remain independently selectable.
    for (const initial of this.readinessProcesses(runId)) {
      if (Date.now() >= deadline) break;
      let row = initial;
      try {
        this.atomic(() => {
          this.assertReadinessRelationships(runId);
          this.assertReadinessCleanupOwner(row, original);
          const meta = readinessMetadata(row);
          if (meta.protocol === "gated-v3" && ["intended", "registered"].includes(meta.startup)) this.revokeReadinessHelper(row.id, original);
        });
        row = this.readinessProcesses(runId).find(item => item.id === row.id)!;
        if (!row) continue;
        const meta = readinessMetadata(row);
        let evidence = await cleanupReadiness(row, deadline);
        // tagged-v2 launched directly from its recorded owner, without a delayed helper.
        if (!row.pid && meta.protocol === "tagged-v2" && row.host === hostname() && (() => { const owner = this.buildAdmission(); return owner?.token === row.owner && classifyProcess(owner.pid, owner.processStart, owner.host).state === "dead"; })() && taggedProcesses(row.id)?.length === 0) evidence = { state: "quiescent", reason: "verified dead direct-spawn owner and complete empty tag inventory" };
        this.atomic(() => {
          this.assertReadinessRelationships(runId);
          this.assertReadinessCleanupOwner(row, original);
          const current = this.readinessProcesses(runId).find(item => item.id === row.id);
          if (!current || current.outcome_json !== row.outcome_json || current.pid !== row.pid) return;
          this.db.prepare("UPDATE build_owned_processes SET state=?,outcome_json=? WHERE id=?").run(evidence.state === "quiescent" ? "quiescent" : row.state, JSON.stringify({ ...meta, cleanup: { ...evidence, checkedAt: new Date().toISOString() }, revision: (meta.revision ?? 0) + 1, updatedAt: new Date().toISOString() }), row.id);
        });
      } catch { /* Preserve durable blocker, including after storage/authority failures. */ }
    }
    return this.readinessProcesses(runId).map(row => row.id);
  }

  preparationEligibility(runId: string): { eligible: boolean; reasons: string[] } {
    const run = this.getRun(runId);
    const reasons: string[] = [];
    for (const row of this.db.prepare("SELECT state_json FROM workflow_runs WHERE kind='legacy' AND legacy=1").all() as Array<{state_json:string}>) {
      const legacy = parseJson(row.state_json) as {source?:string;record?:{sessionId?:string}};
      if (legacy.source && /delivery-sessions/.test(legacy.source) && existsSync(legacy.source) && legacy.record?.sessionId) reasons.push("unattributed legacy branch session requires reconciliation");
    }
    if (this.pendingHumanDecisions(runId).length) reasons.push("pending decisions require an answer");
    if (this.unresolvedPreparationProcesses(runId).length) reasons.push("owned preparation processes are still running or unverified");
    if (this.incompletePublications().some(item => item.runId === runId)) reasons.push("unfinished publication requires reconciliation");
    if (!run || ["completed", "cancelled", "superseded"].includes(run.status)) reasons.push("run is missing or terminal");
    if (run?.state.version !== undefined || run?.state.runId) reasons.push("implementation snapshot exists");
    const tables = ["operation_journal", "provider_sessions", "continuity_heads", "handoffs", "role_mutation_leases", "branch_resume_sessions", "qa_ticket_heads", "qa_recovery_heads", "recovery_attempts"];
    for (const table of tables) if (this.db.prepare(`SELECT 1 FROM ${table} WHERE run_id=? LIMIT 1`).get(runId)) reasons.push(`${table} contains execution evidence or decisions`);
    return { eligible: reasons.length === 0, reasons };
  }

  /** Ensure non-workflow build records can use the same durable event store. */
  ensureRun(runId: string, kind: WorkflowKind = "build", now = new Date()): WorkflowRunSnapshot {
    const existing = this.getRun(runId);
    if (existing) return existing;
    const at = now.toISOString();
    this.db.transaction(() => {
      if (this.writerAuthority) assertAdmission(this.db, this.writerAuthority);
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO workflow_runs(run_id,kind,status,checkpoint,original_work_json,remaining_work_json,state_json,legacy,created_at,updated_at)
        VALUES(?,?,'running','durable-baseline','{}','{}','{}',0,?,?)`).run(runId, kind, at, at);
      if (inserted.changes && this.writerAuthority && this.writerAuthority.runId !== runId) {
        this.db.prepare("INSERT INTO build_child_runs VALUES(?,?)").run(runId, this.writerAuthority.runId);
        this.db.prepare("INSERT OR IGNORE INTO build_runtime_runs VALUES(?)").run(runId);
      }
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
      if (this.writerAuthority) assertAdmission(this.db, this.writerAuthority);
      this.db.prepare(`INSERT INTO workflow_runs(run_id,kind,status,checkpoint,original_work_json,remaining_work_json,state_json,legacy,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(run.runId, run.kind, run.status, run.checkpoint, json(run.originalWork), json(run.remainingWork), json(run.state), run.legacy ? 1 : 0, at, at);
      if (this.writerAuthority && this.writerAuthority.runId !== run.runId) {
        this.db.prepare("INSERT INTO build_child_runs VALUES(?,?)").run(run.runId, this.writerAuthority.runId);
        this.db.prepare("INSERT OR IGNORE INTO build_runtime_runs VALUES(?)").run(run.runId);
      }
      this.insertEvent(run.runId, "run_created", run.checkpoint, { kind: run.kind }, at);
    })();
    return run;
  }

  getRun(runId: string): WorkflowRunSnapshot | undefined {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE run_id=?").get(runId) as DbRun | undefined;
    return row ? rowToRun(row) : undefined;
  }

  /** Publication intents are immutable; mutable tracker snapshots are not approval evidence. */
  approvedPopulationDefinitions(): unknown[] {
    return (this.db.prepare("SELECT intent_json FROM publication_transactions WHERE status='committed' ORDER BY created_at DESC").all() as Array<{ intent_json: string }>)
      .flatMap(row => {
        const intent = parseJson(row.intent_json) as { operation?: string; approvedDefinitions?: unknown[] };
        return intent.operation === "ticket-populate" ? intent.approvedDefinitions ?? [] : [];
      });
  }

  completedPlanApprovals(): Array<Record<string, unknown>> {
    return (this.db.prepare("SELECT state_json FROM workflow_runs WHERE kind='plan' AND status='completed' ORDER BY updated_at DESC").all() as Array<{ state_json: string }>).map(row => parseJson(row.state_json) as Record<string, unknown>);
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

  /** Supervisors may pause a worker generation; they cannot publish worker state. */
  transitionSupervisor(runId: string, workerGeneration: number, update: { status?: WorkflowRunStatus; checkpoint: string; event?: string; payload?: unknown }): WorkflowRunSnapshot {
    return this.atomic(() => {
      const owner = this.supervisorState(runId);
      if (!owner || owner.pid !== process.pid || owner.processStart !== processStartIdentity() || owner.workerGeneration !== workerGeneration) throw new Error("Supervisor generation no longer owns the lifecycle transition");
      this.coordinatorTransition++;
      try { return this.transition(runId, update); }
      finally { this.coordinatorTransition--; }
    });
  }

  transition(runId: string, update: { status?: WorkflowRunStatus; checkpoint: string; remainingWork?: unknown; state?: Record<string, unknown>; event?: string; payload?: unknown }, now = new Date()): WorkflowRunSnapshot {
    const at = now.toISOString();
    return this.db.transaction(() => {
      if (!this.coordinatorTransition && (this.writerAuthority || this.buildAdmission())) {
        if (!this.writerAuthority) throw new Error("Workflow transition requires original build admission authority");
        assertAdmission(this.db, this.writerAuthority);
        const supersession = update.status === "superseded" && update.state?.supersededBy === this.writerAuthority.runId && this.getRun(this.writerAuthority.runId)?.kind === "recovery";
        if (!this.lineageTransition && this.writerAuthority.runId !== runId && !this.db.prepare("SELECT 1 FROM build_child_runs WHERE child=? AND parent=?").get(runId, this.writerAuthority.runId) && !supersession) throw new Error("Workflow authority belongs to another run");
      }
      const current = this.getRun(runId); if (!current) throw new Error(`workflow run not found: ${runId}`);
      if (["completed", "cancelled", "superseded"].includes(current.status) && update.status && update.status !== current.status) throw new Error(`Cannot reactivate terminal ${current.status} workflow`);
      if (!this.coordinatorTransition && this.db.prepare("SELECT 1 FROM build_runtime_runs WHERE run_id=?").get(runId) && !this.writerAuthority) {
        const lease = this.currentLease();
        if (!this.writerLease || !lease || lease.owner !== this.writerLease.owner || lease.generation !== this.writerLease.generation) throw new Error("Workflow transition requires original build authority");
        const supersession = update.status === "superseded" && update.state?.supersededBy === lease.runId && this.getRun(lease.runId)?.kind === "recovery";
        if (lease.runId !== runId && !supersession) throw new Error("Workflow authority belongs to another run");
      }
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

  cancelPendingHumanDecisions(runId: string, reason: string, now = new Date()): void {
    this.atomic(() => {
      for (const decision of this.pendingHumanDecisions(runId)) {
        const next = { ...decision, status: "cancelled", cancellationReason: reason, cancelledAt: now.toISOString() };
        this.db.prepare("UPDATE human_decisions SET status='cancelled',decision_json=?,updated_at=? WHERE decision_id=? AND status='pending'").run(json(next), now.toISOString(), decision.decisionId);
        this.insertEvent(runId, "human_decision_cancelled", "cancelled", { decisionId: decision.decisionId, reason }, now.toISOString());
      }
    });
  }

  humanDecisionKey(decisionId: string): string | undefined {
    return (this.db.prepare("SELECT decision_key FROM human_decisions WHERE decision_id=?").get(decisionId) as { decision_key: string } | undefined)?.decision_key;
  }

  humanDecision(decisionId: string): PendingHumanDecision | undefined {
    const row = this.db.prepare("SELECT decision_json FROM human_decisions WHERE decision_id=?").get(decisionId) as { decision_json: string } | undefined;
    return row ? parseJson(row.decision_json) as PendingHumanDecision : undefined;
  }

  pendingHumanDecisions(runId: string): PendingHumanDecision[] {
    return (this.db.prepare("SELECT decision_json FROM human_decisions WHERE run_id=? AND status='pending' ORDER BY created_at").all(runId) as Array<{ decision_json: string }>)
      .map((row) => parseJson(row.decision_json) as PendingHumanDecision);
  }

  decisionContinuationAvailable(runId: string, decisionId: string): boolean {
    const prior = this.operations(runId).filter(op => op.kind === "decision-continuation" && (op.intent as { decisionId?: string }).decisionId === decisionId);
    return prior.every(op => op.status === "failed" && (op.result as { dispatchState?: string } | undefined)?.dispatchState === "not-sent");
  }

  nextDecisionContinuationKey(runId: string, decisionId: string): string {
    if (!this.decisionContinuationAvailable(runId, decisionId)) throw new Error("Decision continuation requires reconciliation before replay");
    const count = this.operations(runId).filter(op => op.kind === "decision-continuation" && (op.intent as { decisionId?: string }).decisionId === decisionId).length;
    return `decision-continuation:${decisionId}${count ? `:retry-${count}` : ""}`;
  }

  answeredTicketDecisions(runId: string, scopeRevision: string): PendingHumanDecision[] {
    return (this.db.prepare("SELECT decision_key,decision_json FROM human_decisions WHERE run_id=? AND status='answered'").all(runId) as Array<{ decision_key: string; decision_json: string }>)
      .filter(row => row.decision_key.includes(`:${scopeRevision}:`))
      .map(row => parseJson(row.decision_json) as PendingHumanDecision)
      .filter(decision => decision.interruptionId.startsWith("ticket:") && this.decisionContinuationAvailable(runId, decision.decisionId) && !this.operation(`decision-supersession:${decision.decisionId}`));
  }

  /** Unconsumed answers to an older definition must not silently reopen a ticket. */
  staleTicketDecisions(runId: string, scopeRevision: string): PendingHumanDecision[] {
    return (this.db.prepare("SELECT decision_key,decision_json FROM human_decisions WHERE run_id=? AND status='answered'").all(runId) as Array<{ decision_key: string; decision_json: string }>)
      .filter(row => !row.decision_key.includes(`:${scopeRevision}:`))
      .map(row => parseJson(row.decision_json) as PendingHumanDecision)
      .filter(decision => decision.interruptionId.startsWith("ticket:") && this.decisionContinuationAvailable(runId, decision.decisionId) && !this.operation(`decision-supersession:${decision.decisionId}`));
  }

  refreshStaleTicketDecisions(runId: string, scopeRevision: string, tickets?: readonly string[]): void {
    this.atomic(() => {
      for (const prior of this.pendingHumanDecisions(runId)) {
        const key = this.humanDecisionKey(prior.decisionId) ?? "";
        if (!prior.interruptionId.startsWith("ticket:") || tickets && !tickets.includes(prior.interruptionId.slice(7)) || key.includes(`:${scopeRevision}:`) || !(key.startsWith(`${runId}:builder:`) || key.startsWith(`${runId}:ticket-question:`))) continue;
        this.ensureHumanDecision({ runId, decisionKey: `${runId}:ticket-question:${scopeRevision}:supersedes:${prior.decisionId}`, interruptionId: prior.interruptionId, prompt: prior.prompt, choices: prior.choices, evidence: prior.evidence });
        this.db.prepare("UPDATE human_decisions SET status='cancelled',decision_json=?,updated_at=? WHERE decision_id=? AND status='pending'").run(json({ ...prior, status: "cancelled", cancellationReason: "ticket scope changed before the question was answered" }), new Date().toISOString(), prior.decisionId);
        this.insertEvent(runId, "human_decision_superseded", "question-revised", { decisionId: prior.decisionId, scopeRevision }, new Date().toISOString());
      }
      for (const prior of this.staleTicketDecisions(runId, scopeRevision)) {
        if (tickets && !tickets.includes(prior.interruptionId.slice(7))) continue;
        const next = this.ensureHumanDecision({ runId, decisionKey: `${runId}:ticket-question:${scopeRevision}:supersedes:${prior.decisionId}`, interruptionId: prior.interruptionId,
          prompt: prior.prompt, choices: prior.choices, evidence: prior.evidence });
        const key = `decision-supersession:${prior.decisionId}`;
        this.planOperation({ runId, idempotencyKey: key, kind: "decision-supersession", intent: { priorDecisionId: prior.decisionId, replacementDecisionId: next.decisionId, reason: "ticket scope changed before answer was used" } });
        this.updateOperation(key, "in_progress");
        this.updateOperation(key, "confirmed");
      }
    });
  }

  answerHumanDecision(runId: string, decisionId: string, choiceId: string, now = new Date(), answer?: string): PendingHumanDecision {
    return this.atomic(() => {
    const decision = this.humanDecision(decisionId);
    if (!decision || decision.runId !== runId) throw new Error(`pending decision not found for run ${runId}: ${decisionId}`);
    const identity = this.db.prepare("SELECT decision_key FROM human_decisions WHERE decision_id=?").get(decisionId) as { decision_key: string };
    const handbackQuestion = identity.decision_key.startsWith("qa-handback-question:");
    if ((handbackQuestion || choiceId === "custom") && (!answer?.trim() || Buffer.byteLength(answer) > 16_384)) throw new Error("QA handback question requires --answer with the actual decision (maximum 16384 bytes)");
    if (decision.status === "answered" && decision.selectedChoiceId === choiceId && decision.answer === answer) return decision;
    if (decision.status !== "pending") throw new Error(`decision ${decisionId} has already been answered`);
    if (!decision.choices.some((choice) => choice.id === choiceId)) throw new Error(`invalid choice ${choiceId} for decision ${decisionId}`);
    const at = now.toISOString();
    const next: PendingHumanDecision = { ...decision, status: "answered", answeredAt: at, selectedChoiceId: choiceId, ...(answer !== undefined ? { answer } : {}) };
    this.db.prepare("UPDATE human_decisions SET status='answered',decision_json=?,updated_at=? WHERE decision_id=? AND status='pending'").run(json(next), at, decisionId);
    this.insertEvent(runId, "human_decision_answered", "decision-received", { decisionId, choiceId }, at);
    return next;
    });
  }

  putSupervisorState(runId: string, state: SupervisorState, now = new Date()): SupervisorState {
    this.ensureRun(runId);
    this.db.prepare(`INSERT INTO supervisor_leases(run_id,status,pid,generation,heartbeat_at,state_json,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,pid=excluded.pid,generation=excluded.generation,heartbeat_at=excluded.heartbeat_at,state_json=excluded.state_json,updated_at=excluded.updated_at`)
      .run(runId, state.status, state.pid ?? null, state.generation, state.heartbeatAt ?? null, json(state), now.toISOString());
    return state;
  }

  runningSupervisors(): Array<{ runId: string; state: SupervisorState }> {
    return (this.db.prepare("SELECT run_id,state_json FROM supervisor_leases WHERE status='running'").all() as Array<{ run_id: string; state_json: string }>).map(row => ({ runId: row.run_id, state: parseJson(row.state_json) as SupervisorState }));
  }

  supervisorState(runId: string): SupervisorState | undefined {
    const row = this.db.prepare("SELECT state_json FROM supervisor_leases WHERE run_id=?").get(runId) as { state_json: string } | undefined;
    return row ? parseJson(row.state_json) as SupervisorState : undefined;
  }

  planOperation(input: { runId: string; idempotencyKey: string; kind: string; intent: unknown }, now = new Date()): OperationRecord {
    const at = now.toISOString();
    if (input.kind === "provider-dispatch" && this.unresolvedPreparationProcesses(input.runId).length) throw new Error("Readiness cleanup must be reconciled before provider dispatch");
    this.db.prepare(`INSERT INTO operation_journal(idempotency_key,run_id,kind,status,intent_json,created_at,updated_at)
      VALUES(?,?,?,'planned',?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`).run(input.idempotencyKey, input.runId, input.kind, json(input.intent), at, at);
    const operation = this.operation(input.idempotencyKey)!;
    if (operation.runId !== input.runId || operation.kind !== input.kind || json(operation.intent) !== json(input.intent)) {
      throw new Error(`operation idempotency collision: ${input.idempotencyKey}`);
    }
    return operation;
  }

  updateOperation(idempotencyKey: string, status: OperationLifecycle, details: { result?: unknown; externalId?: string; error?: string } = {}, now = new Date()): OperationRecord {
    const prior = this.operation(idempotencyKey); if (prior?.kind === "provider-dispatch" && status === "in_progress" && this.unresolvedPreparationProcesses(prior.runId).length) throw new Error("Readiness cleanup must be reconciled before provider dispatch");
    if (!prior) throw new Error(`operation not found: ${idempotencyKey}`);
    const allowed: Record<OperationLifecycle, OperationLifecycle[]> = {
      planned: ["planned", "in_progress", "failed"],
      in_progress: ["in_progress", "confirmed", "failed", "uncertain"],
      uncertain: ["uncertain", "confirmed", "failed"],
      confirmed: ["confirmed"],
      failed: ["failed"],
    };
    if (!allowed[prior.status].includes(status)) throw new Error(`invalid operation transition ${prior.status} -> ${status}: ${idempotencyKey}`);
    if (prior.status === status && prior.status !== "planned" && json(prior.result) !== json(details.result)) throw new Error(`conflicting terminal operation receipt: ${idempotencyKey}`);
    const at = now.toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE operation_journal SET status=?,result_json=?,external_id=?,error=?,updated_at=? WHERE idempotency_key=?")
        .run(status, details.result === undefined ? null : json(details.result), details.externalId ?? null, details.error ?? null, at, idempotencyKey);
      this.appendContinuityEvent({ runId: prior.runId, role: "host", kind: "operation_receipt", payload: { idempotencyKey, kind: prior.kind, status, externalId: details.externalId, error: details.error }, authoritativeStateRevision: this.continuityHead(prior.runId, "run")?.authoritativeStateRevision ?? 0 }, now);
    })();
    return this.operation(idempotencyKey)!;
  }

  unresolvedRoleDispatches(runId: string, role: string): OperationRecord[] {
    const rows = this.db.prepare("SELECT * FROM operation_journal WHERE run_id=? AND kind='provider-dispatch' AND status IN ('in_progress','uncertain')").all(runId) as DbOperation[];
    return rows.map(operationFromRow).filter(row => (row.intent as { role?: string }).role === role);
  }

  reserveRecoveryAllowance(runId: string, scope: string, kind: string, maximum: number): boolean {
    return this.atomic(() => {
      const prefix = `recovery-budget:${runId}:${scope}:${kind}:`;
      const count = (this.db.prepare("SELECT COUNT(*) count FROM operation_journal WHERE run_id=? AND kind='recovery-budget' AND substr(idempotency_key,1,?)=?").get(runId, prefix.length, prefix) as { count: number }).count;
      if (count >= maximum) return false;
      this.ensureRun(runId);
      this.planOperation({ runId, idempotencyKey: `${prefix}${count + 1}`, kind: "recovery-budget", intent: { scope, kind, maximum } });
      return true;
    });
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
    const maximum = kind === "qa" ? 8 * 1024 * 1024 : 16 * 1024 * 1024;
    if (bytes.length > maximum) throw new Error(`${kind} evidence exceeds the durable ${maximum}-byte item limit`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    this.db.prepare("INSERT OR IGNORE INTO content_refs(digest,kind,content,created_at) VALUES(?,?,?,?)").run(digest, kind, bytes, now.toISOString());
    return digest;
  }

  getEvidence(digest: string): Buffer | undefined {
    const row = this.db.prepare("SELECT content FROM content_refs WHERE digest=?").get(digest) as { content: Buffer } | undefined;
    return row?.content;
  }

  putQaRecoveryHead(input: Omit<QaRecoveryHeadRecord, "updatedAt">, now = new Date()): QaRecoveryHeadRecord {
    this.ensureRun(input.runId);
    const at = now.toISOString();
    this.db.transaction(() => {
      const prior = this.qaRecoveryHead(input.runId, input.ticketId);
      if (prior) {
        if (prior.packetId !== input.packetId && prior.pendingAction !== "resolved") throw new Error(`QA recovery packet identity changed for ${input.runId}/${input.ticketId}`);
        if (prior.packetId === input.packetId && (input.revision < prior.revision || (input.revision === prior.revision && input.packetDigest !== prior.packetDigest))) throw new Error("stale or conflicting QA recovery head");
        // The packet loader validates the complete immutable lineage before it
        // reconciles a filesystem-ahead crash, so a head may legitimately
        // advance across more than one already-durable revision here.
      }
      this.db.prepare(`INSERT INTO qa_recovery_heads(run_id,ticket_id,packet_id,packet_path,packet_digest,reviewed_state_digest,revision,correction_turns,pending_action,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,ticket_id) DO UPDATE SET packet_id=excluded.packet_id,packet_path=excluded.packet_path,packet_digest=excluded.packet_digest,reviewed_state_digest=excluded.reviewed_state_digest,revision=excluded.revision,correction_turns=excluded.correction_turns,pending_action=excluded.pending_action,updated_at=excluded.updated_at`)
        .run(input.runId, input.ticketId, input.packetId, input.packetPath, input.packetDigest, input.reviewedStateDigest, input.revision, input.correctionTurns, input.pendingAction, at);
      this.insertEvent(input.runId, "qa_recovery_head", `qa-recovery:${input.ticketId}:${input.revision}`, input, at);
    })();
    return this.qaRecoveryHead(input.runId, input.ticketId)!;
  }

  qaRecoveryHead(runId: string, ticketId?: string): QaRecoveryHeadRecord | undefined {
    const row = (ticketId
      ? this.db.prepare("SELECT * FROM qa_recovery_heads WHERE run_id=? AND ticket_id=?").get(runId, ticketId)
      : this.db.prepare("SELECT * FROM qa_recovery_heads WHERE run_id=? AND pending_action<>'resolved' ORDER BY updated_at DESC LIMIT 1").get(runId)) as DbQaRecoveryHead | undefined;
    return row ? qaRecoveryHeadFromRow(row) : undefined;
  }

  pendingQaRecoveryHeads(runId: string): QaRecoveryHeadRecord[] {
    const rows = this.db.prepare("SELECT * FROM qa_recovery_heads WHERE run_id=? AND pending_action<>'resolved' ORDER BY updated_at,ticket_id").all(runId) as DbQaRecoveryHead[];
    return rows.map(qaRecoveryHeadFromRow);
  }

  beginQaReviewAttempt(input: Omit<QaReviewAttemptRecord, "status" | "createdAt" | "updatedAt">, now = new Date()): QaReviewAttemptRecord {
    this.ensureRun(input.runId); const at = now.toISOString();
    this.db.prepare(`INSERT INTO qa_review_attempts(attempt_id,run_id,ticket_id,review_number,cycle,remediation_generation,source_digest,status,record_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'started','{}',?,?)`)
      .run(input.attemptId, input.runId, input.ticketId, input.reviewNumber, input.cycle, input.remediationGeneration, input.sourceDigest, at, at);
    return this.qaReviewAttempt(input.attemptId)!;
  }

  finishQaReviewAttempt(attemptId: string, patch: Pick<QaReviewAttemptRecord, "status"> & Partial<Pick<QaReviewAttemptRecord, "reportDigest" | "findingIds" | "namespacedFindingIds" | "detail">>, now = new Date()): QaReviewAttemptRecord {
    const prior = this.qaReviewAttempt(attemptId); if (!prior) throw new Error(`QA review attempt not found: ${attemptId}`);
    if (prior.status !== "started") {
      const same = prior.status === patch.status && (patch.reportDigest === undefined || patch.reportDigest === prior.reportDigest);
      if (!same) throw new Error(`QA review attempt ${attemptId} is already terminal (${prior.status})`);
      return prior;
    }
    const next = { ...prior, ...patch, updatedAt: now.toISOString() };
    this.db.prepare("UPDATE qa_review_attempts SET status=?,report_digest=?,record_json=?,updated_at=? WHERE attempt_id=?")
      .run(next.status, next.reportDigest ?? null, json({ findingIds: next.findingIds, namespacedFindingIds: next.namespacedFindingIds, detail: next.detail }), next.updatedAt, attemptId);
    return next;
  }

  qaReviewAttempts(runId: string, ticketId: string): QaReviewAttemptRecord[] {
    return (this.db.prepare("SELECT * FROM qa_review_attempts WHERE run_id=? AND ticket_id=? ORDER BY review_number").all(runId, ticketId) as DbQaReviewAttempt[]).map(qaReviewAttemptFromRow);
  }

  qaReviewAttempt(attemptId: string): QaReviewAttemptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM qa_review_attempts WHERE attempt_id=?").get(attemptId) as DbQaReviewAttempt | undefined;
    return row ? qaReviewAttemptFromRow(row) : undefined;
  }

  beginQaRemediationAttempt(input: Omit<QaRemediationAttemptRecord, "status" | "createdAt" | "updatedAt">, now = new Date()): QaRemediationAttemptRecord {
    this.ensureRun(input.runId); const at = now.toISOString();
    this.db.prepare(`INSERT INTO qa_remediation_attempts(attempt_id,run_id,ticket_id,review_attempt_id,generation,mode,status,request_digest,record_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'intended',?,'{}',?,?)`)
      .run(input.attemptId, input.runId, input.ticketId, input.reviewAttemptId, input.generation, input.mode, input.requestDigest, at, at);
    return this.qaRemediationAttempt(input.attemptId)!;
  }

  commitQaRemediationIntent(
    expectedRevision: number,
    recovery: RecoveryAttemptReceipt,
    remediation: Omit<QaRemediationAttemptRecord, "status" | "createdAt" | "updatedAt">,
    now = new Date(),
  ): QaReducerStateV2 {
    return this.db.transaction(() => {
      const head = this.qaTicketHead(remediation.runId, remediation.ticketId);
      if (head.revision !== expectedRevision || head.state !== "review-failed") throw new Error(`Builder remediation intent raced for ${remediation.runId}/${remediation.ticketId}`);
      const next = this.transitionQa(remediation.runId, remediation.ticketId, head.revision, { type: "remediation-intended" }, now);
      if (next.remediationGeneration !== remediation.generation) throw new Error("Builder remediation generation mismatch");
      this.recordRecoveryAttempt(recovery);
      this.updateRecoveryAttempt(recovery.attemptId, "started", undefined, now);
      this.beginQaRemediationAttempt(remediation, now);
      this.updateQaRemediationAttempt(remediation.attemptId, "started", {}, now);
      this.db.prepare("UPDATE qa_remediation_attempts SET record_json=json_set(record_json,'$.recoveryAttemptId',?) WHERE attempt_id=?").run(recovery.attemptId, remediation.attemptId);
      return next;
    })();
  }

  updateQaRemediationAttempt(attemptId: string, status: QaRemediationAttemptRecord["status"], patch: Partial<Pick<QaRemediationAttemptRecord, "responseDigest" | "summaryDigest" | "detail">> = {}, now = new Date()): QaRemediationAttemptRecord {
    const prior = this.qaRemediationAttempt(attemptId); if (!prior) throw new Error(`QA remediation attempt not found: ${attemptId}`);
    const next = { ...prior, ...patch, status, updatedAt: now.toISOString() };
    this.db.prepare("UPDATE qa_remediation_attempts SET status=?,response_digest=?,summary_digest=?,record_json=?,updated_at=? WHERE attempt_id=?")
      .run(status, next.responseDigest ?? null, next.summaryDigest ?? null, json({ detail: next.detail, recoveryAttemptId: next.recoveryAttemptId }), next.updatedAt, attemptId);
    return next;
  }

  qaRemediationAttempts(runId: string, ticketId: string): QaRemediationAttemptRecord[] {
    return (this.db.prepare("SELECT * FROM qa_remediation_attempts WHERE run_id=? AND ticket_id=? ORDER BY generation,created_at").all(runId, ticketId) as DbQaRemediationAttempt[]).map(qaRemediationAttemptFromRow);
  }

  qaRemediationAttempt(attemptId: string): QaRemediationAttemptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM qa_remediation_attempts WHERE attempt_id=?").get(attemptId) as DbQaRemediationAttempt | undefined;
    return row ? qaRemediationAttemptFromRow(row) : undefined;
  }

  recordQaDeliveryInvocation(record: QaDeliveryInvocationV3): void {
    const intent = { version: record.version, invocationId: record.invocationId, runId: record.runId, ticketId: record.ticketId, reviewAttemptId: record.reviewAttemptId, reportOccurrenceId: record.reportOccurrenceId, startedAt: record.startedAt };
    this.db.prepare(`INSERT INTO qa_operation_journal(operation_id,run_id,ticket_id,kind,intent_digest,intent_json,status,receipt_json,created_at,updated_at)
      VALUES(?,?,?,'handback-invocation',?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET status=excluded.status,receipt_json=excluded.receipt_json,updated_at=excluded.updated_at`)
      .run(record.invocationId, record.runId, record.ticketId, qaDigest("handback-invocation", intent), json(intent), record.status, json(record), record.startedAt, record.completedAt ?? new Date().toISOString());
  }

  recordQaDeliveryTurn(turn: QaDeliveryTurnV3): void {
    const prior = this.qaDeliveryTurns(turn.operationId).find(t => t.turnRecordId === turn.turnRecordId);
    if (prior) {
      if (prior.status !== "intended") {
        if (json(prior) !== json(turn)) throw new Error(`conflicting completed delivery turn ${turn.turnRecordId}`);
        return;
      }
      for (const key of ["operationId", "reportOccurrenceId", "turnIndex", "kind", "hostInstructionDigest", "hostInstructionBytes", "startedAt"] as const) {
        if (prior[key] !== turn[key]) throw new Error(`delivery turn intent mismatch: ${key}`);
      }
    }
    this.db.prepare(`INSERT INTO qa_delivery_turns(turn_record_id,operation_id,report_occurrence_id,turn_index,kind,status,record_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(turn_record_id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json,updated_at=excluded.updated_at`)
      .run(turn.turnRecordId, turn.operationId, turn.reportOccurrenceId, turn.turnIndex, turn.kind, turn.status, json(turn), turn.startedAt, turn.completedAt ?? turn.startedAt);
  }

  qaDeliveryTurns(operationId: string): QaDeliveryTurnV3[] {
    return (this.db.prepare("SELECT record_json FROM qa_delivery_turns WHERE operation_id=? ORDER BY turn_index").all(operationId) as Array<{ record_json: string }>).map(row => parseJson(row.record_json) as QaDeliveryTurnV3);
  }

  /** Attempts, including ambiguous intents, are the common legacy/production ledger. */
  qaAutomaticRemediationCount(runId: string, ticketId: string): number {
    const attempts = this.qaRemediationAttempts(runId, ticketId);
    const recoveries = this.recoveryAttempts(runId).filter(r => r.ticket === ticketId && r.phase === "qa-remediation" && r.cause === "qa.nonconvergence");
    // Legacy recovery-only entries cannot safely be deduplicated by summing keys.
    const linked = new Set<string>();
    for (const attempt of attempts) {
      const candidates = recoveries.filter(recovery => recovery.attemptId === attempt.recoveryAttemptId
        || !attempt.recoveryAttemptId && (recovery.attemptId === qaDigest("qa-failure-delivery-recovery-attempt", { operationId: attempt.attemptId, attempt: recovery.attempt })
          || recovery.operationKey === `qa-fix:${ticketId}` && recovery.detail === `caused by QA review ${attempt.reviewAttemptId}`));
      if (candidates.length > 1 || candidates[0] && linked.has(candidates[0].attemptId)) throw new Error("QA remediation budget requires ambiguous legacy attempt reconciliation");
      if (candidates[0]) linked.add(candidates[0].attemptId);
      else if (attempt.recoveryAttemptId) throw new Error("QA remediation budget references missing recovery evidence");
    }
    if (linked.size !== recoveries.length) throw new Error("QA remediation budget requires legacy attempt reconciliation");
    const authorized = new Set((this.db.prepare("SELECT consumed_by FROM qa_remediation_authorizations WHERE run_id=? AND ticket_id=? AND consumed_by IS NOT NULL").all(runId, ticketId) as Array<{ consumed_by: string }>).map(r => r.consumed_by));
    const followups = this.operations(runId).filter(operation => operation.kind === "build-assignment" && (operation.intent as {ticketId?:string;managerFollowup?:unknown}).ticketId === ticketId && (operation.intent as {managerFollowup?:unknown}).managerFollowup);
    return attempts.filter(a => !authorized.has(a.attemptId)).length + followups.filter(operation => !authorized.has(operation.idempotencyKey)).length;
  }

  authorizeQaRemediation(runId: string, ticketId: string, reviewAttemptId: string, reason: string): string {
    const authorizationId = randomUUID();
    if (!reason.trim() || this.qaReviewAttempt(reviewAttemptId)?.runId !== runId || this.qaReviewAttempt(reviewAttemptId)?.ticketId !== ticketId) throw new Error("QA retry authorization requires exact review scope and reason");
    this.db.prepare("INSERT INTO qa_remediation_authorizations(authorization_id,run_id,ticket_id,review_attempt_id,reason,created_at) VALUES(?,?,?,?,?,?)")
      .run(authorizationId, runId, ticketId, reviewAttemptId, reason, new Date().toISOString());
    return authorizationId;
  }

  reserveQaRemediation(runId: string, ticketId: string, reviewAttemptId: string, operationId: string, maximum: number, authorizationId?: string): void {
    if (authorizationId) {
      const result = this.db.prepare("UPDATE qa_remediation_authorizations SET consumed_by=? WHERE authorization_id=? AND run_id=? AND ticket_id=? AND review_attempt_id=? AND consumed_by IS NULL")
        .run(operationId, authorizationId, runId, ticketId, reviewAttemptId);
      if (result.changes !== 1) throw new Error("QA retry authorization is missing, foreign, or already consumed");
    } else if (!Number.isSafeInteger(maximum) || maximum < 0 || this.qaAutomaticRemediationCount(runId, ticketId) >= maximum) {
      throw new Error(`QA remediation budget exhausted (${maximum}); explicit scoped authorization required`);
    }
  }

  qaRemediationStop(runId: string, ticketId: string): { operationId: string; outcome: QaDeliveryOutcome; detail: string; decisionId?: string; sourceDigest?: string; fingerprints?: string[] } | undefined {
    const row = this.db.prepare("SELECT record_json FROM qa_remediation_stops WHERE run_id=? AND ticket_id=?").get(runId, ticketId) as { record_json: string } | undefined;
    return row ? parseJson(row.record_json) as ReturnType<WorkflowDb["qaRemediationStop"]> : undefined;
  }

  recordQaRemediationStop(runId: string, ticketId: string, stop: NonNullable<ReturnType<WorkflowDb["qaRemediationStop"]>>): void {
    this.db.prepare("INSERT INTO qa_remediation_stops(run_id,ticket_id,operation_id,outcome,record_json,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,ticket_id) DO UPDATE SET operation_id=excluded.operation_id,outcome=excluded.outcome,record_json=excluded.record_json,created_at=excluded.created_at")
      .run(runId, ticketId, stop.operationId, stop.outcome, json(stop), new Date().toISOString());
  }

  /** A validated operator recovery boundary, never a change in prose or review ID. */
  clearQaRemediationStop(runId: string, ticketId: string, reason: string): void {
    const stop = this.qaRemediationStop(runId, ticketId);
    if (!stop) return;
    if (!reason.trim()) throw new Error("QA recovery requires evidence or an explicit decision");
    if (stop.decisionId && this.humanDecision(stop.decisionId)?.status !== "answered") throw new Error("QA remediation question is still unanswered");
    this.db.prepare("DELETE FROM qa_remediation_stops WHERE run_id=? AND ticket_id=?").run(runId, ticketId);
    this.insertEvent(runId, "qa_remediation_recovery", "qa-full-review", { ticketId, operationId: stop.operationId, reason }, new Date().toISOString());
  }

  recordQaFailureHandoffPrepared(input: {
    handoffId: string;
    operationId: string;
    runId: string;
    ticketId: string;
    reviewAttemptId: string;
    reportDigest: string;
    generation: number;
    reviewedContentDigest: string;
    reviewBasisDigest: string;
    handoffDigest: string;
    hostInstructionDigest: string;
  }, now = new Date()): QaFailureHandoffRecord {
    const at = now.toISOString();
    this.db.prepare(`INSERT INTO qa_failure_handoffs(
      handoff_id,operation_id,run_id,ticket_id,review_attempt_id,report_digest,report_occurrence_id,generation,reviewed_content_digest,review_basis_digest,state,
      handoff_digest,host_instruction_digest,record_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',?,?, '{}',?,?)
    ON CONFLICT(handoff_id) DO UPDATE SET
      operation_id=excluded.operation_id,
      handoff_digest=excluded.handoff_digest,
      host_instruction_digest=excluded.host_instruction_digest,
      updated_at=excluded.updated_at
    WHERE qa_failure_handoffs.state='prepared'`)
      .run(input.handoffId, input.operationId, input.runId, input.ticketId, input.reviewAttemptId, input.reportDigest, reportOccurrenceId(input.runId, input.ticketId, this.qaReviewAttempt(input.reviewAttemptId)!.reviewNumber), input.generation,
        input.reviewedContentDigest, input.reviewBasisDigest, input.handoffDigest, input.hostInstructionDigest, at, at);
    const record = this.qaFailureHandoff(input.handoffId);
    if (!record) throw new Error(`QA failure handoff was not recorded: ${input.handoffId}`);
    if (record.operationId !== input.operationId || record.reportDigest !== input.reportDigest || record.reviewedContentDigest !== input.reviewedContentDigest
      || record.reviewBasisDigest !== input.reviewBasisDigest || record.state !== "prepared") {
      throw new Error(`QA failure handoff collision: ${input.handoffId}`);
    }
    return record;
  }

  markQaFailureHandoffDeliveryIntended(handoffId: string, builderSession: ProviderSessionRefV1, now = new Date()): QaFailureHandoffRecord {
    return this.transitionQaFailureHandoff(handoffId, "delivery-intended", { builderSession }, now);
  }

  transitionQaFailureHandoff(handoffId: string, state: QaFailureHandoffState, patch: Partial<Pick<QaFailureHandoffRecord, "builderSession" | "providerTurnId" | "receiptDigest" | "responseDigest" | "parsedResponseDigest" | "postSourceDigest" | "detail">> = {}, now = new Date()): QaFailureHandoffRecord {
    const prior = this.qaFailureHandoff(handoffId);
    if (!prior) throw new Error(`QA failure handoff not found: ${handoffId}`);
    const next = { ...prior, ...patch, state, updatedAt: now.toISOString() };
    const priorRecordRow = this.db.prepare("SELECT record_json FROM qa_failure_handoffs WHERE handoff_id=?").get(handoffId) as { record_json: string } | undefined;
    const priorRecord = parseJson(priorRecordRow?.record_json ?? "{}") as { transitions?: unknown[] };
    const priorTransitions = Array.isArray(priorRecord.transitions) ? priorRecord.transitions : [];
    const recordJson = json({ ...priorRecord, transitions: [...priorTransitions, { state, detail: patch.detail, at: next.updatedAt }] });
    this.db.prepare(`UPDATE qa_failure_handoffs SET state=?,builder_session_json=?,provider_turn_id=?,receipt_digest=?,response_digest=?,parsed_response_digest=?,post_source_digest=?,detail=?,record_json=?,updated_at=? WHERE handoff_id=?`)
      .run(state, next.builderSession ? json(next.builderSession) : null, next.providerTurnId ?? null, next.receiptDigest ?? null, next.responseDigest ?? null,
        next.parsedResponseDigest ?? null, next.postSourceDigest ?? null, next.detail ?? null,
        recordJson, next.updatedAt, handoffId);
    return this.qaFailureHandoff(handoffId)!;
  }

  qaFailureHandoff(handoffId: string): QaFailureHandoffRecord | undefined {
    const row = this.db.prepare("SELECT * FROM qa_failure_handoffs WHERE handoff_id=?").get(handoffId) as DbQaFailureHandoff | undefined;
    return row ? qaFailureHandoffFromRow(row) : undefined;
  }

  qaFailureHandoffs(runId: string, ticketId: string): QaFailureHandoffRecord[] {
    const rows = this.db.prepare("SELECT * FROM qa_failure_handoffs WHERE run_id=? AND ticket_id=? ORDER BY generation,created_at").all(runId, ticketId) as DbQaFailureHandoff[];
    return rows.map(qaFailureHandoffFromRow);
  }

  qaTicketHead(runId: string, ticketId: string): QaReducerStateV2 {
    const row = this.db.prepare("SELECT state_json FROM qa_ticket_heads WHERE run_id=? AND ticket_id=?").get(runId, ticketId) as { state_json: string } | undefined;
    return row ? parseJson(row.state_json) as QaReducerStateV2 : initialQaReducerState(runId, ticketId);
  }

  pendingQaTicketHeads(runId: string): QaReducerStateV2[] {
    const rows = this.db.prepare("SELECT state_json FROM qa_ticket_heads WHERE run_id=? AND state NOT IN ('completed','waived') ORDER BY updated_at,ticket_id").all(runId) as Array<{ state_json: string }>;
    return rows.map((row) => parseJson(row.state_json) as QaReducerStateV2);
  }

  /** Compare-and-swap the authoritative QA reducer head and append its event atomically. */
  transitionQa(runId: string, ticketId: string, expectedRevision: number, event: QaReducerEventV2, now = new Date()): QaReducerStateV2 {
    this.ensureRun(runId);
    return this.db.transaction(() => {
      const current = this.qaTicketHead(runId, ticketId);
      if (current.revision !== expectedRevision) throw new Error(`stale QA transition for ${runId}/${ticketId}: expected revision ${expectedRevision}, found ${current.revision}`);
      const next = reduceQaState(current, event);
      const at = now.toISOString();
      this.db.prepare(`INSERT INTO qa_ticket_heads(run_id,ticket_id,revision,state,state_json,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,ticket_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,state_json=excluded.state_json,updated_at=excluded.updated_at
        WHERE qa_ticket_heads.revision=?`)
        .run(runId, ticketId, next.revision, next.state, json(next), at, expectedRevision);
      this.db.prepare("INSERT INTO qa_transitions(run_id,ticket_id,from_revision,to_revision,event_json,state_json,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(runId, ticketId, current.revision, next.revision, json(event), json(next), at);
      return next;
    })();
  }

  qaTransitions(runId: string, ticketId: string): QaTransitionRecordV2[] {
    const rows = this.db.prepare("SELECT * FROM qa_transitions WHERE run_id=? AND ticket_id=? ORDER BY sequence").all(runId, ticketId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ sequence: Number(row.sequence), runId: String(row.run_id), ticketId: String(row.ticket_id), fromRevision: Number(row.from_revision), toRevision: Number(row.to_revision), event: parseJson(String(row.event_json)) as QaReducerEventV2, state: parseJson(String(row.state_json)) as QaReducerStateV2, createdAt: String(row.created_at) }));
  }

  assertQaRunFinalizable(runId: string): void {
    const rows = this.db.prepare("SELECT ticket_id,state FROM qa_ticket_heads WHERE run_id=? AND state NOT IN ('completed','waived') ORDER BY ticket_id").all(runId) as Array<{ ticket_id: string; state: string }>;
    if (rows.length) throw new Error(`build run has non-final QA state: ${rows.map((row) => `${row.ticket_id}=${row.state}`).join(", ")}`);
  }

  putQaSourceState(state: FrozenQaSourceStateV2): void {
    this.db.prepare("INSERT OR IGNORE INTO qa_source_states(digest,run_id,ticket_id,origin_digest,content_digest,state_json,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(state.digest, state.runId, state.ticketId, state.originDigest, state.contentDigest, json(state), state.capturedAt);
    const stored = this.db.prepare("SELECT origin_digest,content_digest,state_json FROM qa_source_states WHERE run_id=? AND ticket_id=? AND digest=?").get(state.runId, state.ticketId, state.digest) as { origin_digest: string; content_digest: string; state_json: string };
    const { capturedAt: _storedCapturedAt, ...storedIdentity } = parseJson(stored.state_json) as FrozenQaSourceStateV2;
    const { capturedAt: _currentCapturedAt, ...currentIdentity } = state;
    if (stored.origin_digest !== state.originDigest || stored.content_digest !== state.contentDigest || json(storedIdentity) !== json(currentIdentity)) throw new Error(`QA source-state digest collision: ${state.digest}`);
  }

  putQaReviewBasis(runId: string, ticketId: string, basis: QaReviewBasisV2, now = new Date()): void {
    this.db.prepare("INSERT OR IGNORE INTO qa_review_bases(digest,run_id,ticket_id,basis_json,created_at) VALUES(?,?,?,?,?)")
      .run(basis.digest, runId, ticketId, json(basis), now.toISOString());
    const stored = this.db.prepare("SELECT basis_json FROM qa_review_bases WHERE run_id=? AND ticket_id=? AND digest=?").get(runId, ticketId, basis.digest) as { basis_json: string };
    if (qaDigest("review-basis", parseJson(stored.basis_json)) !== qaDigest("review-basis", basis)) throw new Error(`QA review-basis digest collision: ${basis.digest}`);
  }

  commitQaReviewReady(
    source: FrozenQaSourceStateV2,
    basis: QaReviewBasisV2,
    session: ProviderSessionRefV1,
    confinement: { digest: string },
    attempt: { attemptId: string; cycle: number; remediationGeneration: number },
    expectedRevision: number,
    now = new Date(),
  ): QaReducerStateV2 {
    return this.db.transaction(() => {
      this.putQaSourceState(source);
      this.putQaReviewBasis(source.runId, source.ticketId, basis, now);
      let head = this.qaTicketHead(source.runId, source.ticketId);
      if (head.revision !== expectedRevision) throw new Error(`stale QA review preparation for ${source.runId}/${source.ticketId}`);
      if (head.state === "passed") this.invalidateUnconsumedQaPassCertificates(source.runId, source.ticketId, "new-review", now);
      if (head.state === "turn-intended") head = this.transitionQa(source.runId, source.ticketId, head.revision, { type: "source-drift" }, now);
      head = this.transitionQa(source.runId, source.ticketId, head.revision, { type: "source-frozen", sourceStateDigest: source.digest }, now);
      const next = this.transitionQa(source.runId, source.ticketId, head.revision, { type: "review-ready", reviewBasisDigest: basis.digest, sessionGeneration: session.generation }, now);
      const sessionJson = { version: 2, session, sourceStateDigest: source.digest, reviewBasisDigest: basis.digest, confinement };
      const sessionKey = qaDigest("qa-session", { runId: source.runId, ticketId: source.ticketId, reviewNumber: next.reviewNumber, providerSessionKey: providerSessionKey(session) });
      this.db.prepare(`INSERT INTO qa_sessions(session_key,run_id,ticket_id,generation,source_state_digest,review_basis_digest,confinement_digest,session_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionKey, source.runId, source.ticketId, session.generation, source.digest, basis.digest,
        confinement.digest, json(sessionJson), now.toISOString());
      const at = now.toISOString();
      this.db.prepare(`UPDATE qa_review_attempts SET status='interrupted',record_json=?,updated_at=?
        WHERE run_id=? AND ticket_id=? AND status='started'`)
        .run(json({ detail: "superseded by a new immutable QA review basis" }), at, source.runId, source.ticketId);
      this.db.prepare(`INSERT INTO qa_review_attempts(attempt_id,run_id,ticket_id,review_number,cycle,remediation_generation,source_digest,status,record_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'started','{}',?,?)`)
        .run(attempt.attemptId, source.runId, source.ticketId, next.reviewNumber, attempt.cycle, attempt.remediationGeneration, source.digest, at, at);
      return next;
    })();
  }

  recordQaHandoffReceipt(receipt: HandoffAcceptanceReceiptV2): void {
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT receipt_json FROM qa_handoffs WHERE operation_id=?").get(receipt.operationId) as { receipt_json: string | null } | undefined;
      if (existing) {
        if (!existing.receipt_json || json(parseJson(existing.receipt_json)) !== json(receipt)) throw new Error(`conflicting QA handoff receipt: ${receipt.operationId}`);
        return;
      }
      this.db.prepare(`INSERT INTO qa_handoffs(operation_id,run_id,ticket_id,qa_revision,source_state_digest,review_basis_digest,status,intent_json,receipt_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'accepted',?,?,?,?)`).run(receipt.operationId, receipt.runId, receipt.ticketId, receipt.qaRevision,
        receipt.sourceStateDigest, receipt.reviewBasisDigest, json({ packetDigest: receipt.packetDigest, predecessor: receipt.predecessor,
          confinementDigest: receipt.confinementDigest, inventoryDigest: receipt.inventoryDigest }), json(receipt), receipt.acceptedAt, receipt.acceptedAt);
      const sessionKey = qaDigest("qa-handoff-successor-session", { operationId: receipt.operationId, successor: receipt.successor });
      this.db.prepare(`INSERT INTO qa_sessions(session_key,run_id,ticket_id,generation,source_state_digest,review_basis_digest,confinement_digest,session_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionKey, receipt.runId, receipt.ticketId, receipt.successor.generation, receipt.sourceStateDigest,
        receipt.reviewBasisDigest, receipt.confinementDigest, json({ version: 2, session: receipt.successor, acceptedHandoffReceiptDigest: qaDigest("qa-handoff-receipt", receipt) }), receipt.acceptedAt);
    })();
  }

  qaHandoffReceipt(operationId: string): HandoffAcceptanceReceiptV2 | undefined {
    const row = this.db.prepare("SELECT receipt_json FROM qa_handoffs WHERE operation_id=? AND status='accepted'").get(operationId) as { receipt_json: string | null } | undefined;
    return row?.receipt_json ? parseJson(row.receipt_json) as HandoffAcceptanceReceiptV2 : undefined;
  }

  beginQaTurn(intent: QaTurnIntentV2): void {
    const at = intent.intendedAt;
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT intent_json FROM qa_turns WHERE operation_id=?").get(intent.operationId) as { intent_json: string } | undefined;
      if (existing && json(parseJson(existing.intent_json)) !== json(intent)) throw new Error(`QA turn operation collision: ${intent.operationId}`);
      this.db.prepare(`INSERT OR IGNORE INTO qa_turns(operation_id,run_id,ticket_id,review_number,session_generation,retry_slot,source_state_digest,review_basis_digest,status,intent_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?, 'intended',?,?,?)`).run(intent.operationId, intent.runId, intent.ticketId, intent.reviewNumber, intent.sessionGeneration, intent.slot, intent.sourceStateDigest, intent.reviewBasisDigest, json(intent), at, at);
      this.db.prepare("INSERT OR IGNORE INTO qa_retry_slots(run_id,ticket_id,review_number,session_generation,retry_slot,operation_id,status,updated_at) VALUES(?,?,?,?,?,?,'intended',?)")
        .run(intent.runId, intent.ticketId, intent.reviewNumber, intent.sessionGeneration, intent.slot, intent.operationId, at);
    })();
  }

  commitQaTurnIntent(intent: QaTurnIntentV2, expectedRevision: number): QaReducerStateV2 {
    return this.db.transaction(() => {
      const next = this.transitionQa(intent.runId, intent.ticketId, expectedRevision, { type: "turn-intended", slot: intent.slot }, new Date(intent.intendedAt));
      this.beginQaTurn(intent);
      return next;
    })();
  }

  finishQaTurn(receipt: QaTurnReceiptV2): void {
    this.db.transaction(() => {
      const prior = this.db.prepare("SELECT source_state_digest,review_basis_digest,status FROM qa_turns WHERE operation_id=?").get(receipt.operationId) as { source_state_digest: string; review_basis_digest: string; status: string } | undefined;
      if (!prior) throw new Error(`QA turn intent not found: ${receipt.operationId}`);
      if (prior.source_state_digest !== receipt.sourceStateDigest || prior.review_basis_digest !== receipt.reviewBasisDigest) throw new Error("QA turn receipt binding mismatch");
      if (prior.status === "completed") {
        const existing = this.db.prepare("SELECT receipt_json FROM qa_turns WHERE operation_id=?").get(receipt.operationId) as { receipt_json: string };
        if (json(parseJson(existing.receipt_json)) !== json(receipt)) throw new Error(`conflicting QA turn receipt: ${receipt.operationId}`);
        return;
      }
      this.db.prepare("UPDATE qa_turns SET status=?,receipt_json=?,updated_at=? WHERE operation_id=?")
        .run(receipt.dispatch === "completed" ? "completed" : receipt.dispatch, json(receipt), receipt.completedAt, receipt.operationId);
      this.db.prepare("UPDATE qa_retry_slots SET status=?,updated_at=? WHERE operation_id=?")
        .run(receipt.dispatch === "completed" ? "consumed" : receipt.dispatch, receipt.completedAt, receipt.operationId);
      this.db.prepare("INSERT INTO qa_turn_events(operation_id,event_index,event_json,event_digest,created_at) VALUES(?,?,?,?,?)")
        .run(receipt.operationId, 0, json(receipt), qaDigest("turn-receipt", receipt), receipt.completedAt);
    })();
  }

  recordQaReport(input: Omit<QaReportRecordV2, "reportOccurrenceId" | "disposition" | "createdAt" | "updatedAt">, findingIds: string[], now = new Date()): QaReportRecordV2 {
    const at = now.toISOString();
    const occurrence = reportOccurrenceId(input.runId, input.ticketId, input.reviewNumber);
    this.atomic(() => {
      const prior = this.qaReport(occurrence);
      if (prior) {
        if (prior.reportDigest !== input.reportDigest || json(prior.report) !== json(input.report)
          || prior.sourceStateDigest !== input.sourceStateDigest || prior.reviewBasisDigest !== input.reviewBasisDigest) throw new Error(`conflicting QA report occurrence: ${occurrence}`);
        const keys = (this.db.prepare("SELECT finding_id FROM qa_findings WHERE report_occurrence_id=? ORDER BY ordinal").all(occurrence) as Array<{ finding_id: string }>).map(r => r.finding_id);
        if (json(keys) !== json(findingIds)) throw new Error(`conflicting QA finding ownership: ${occurrence}`);
        return;
      }
      this.db.prepare(`INSERT INTO qa_reports(report_occurrence_id,report_digest,run_id,ticket_id,review_number,source_state_digest,review_basis_digest,disposition,report_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'open',?,?,?)`).run(occurrence, input.reportDigest, input.runId, input.ticketId, input.reviewNumber, input.sourceStateDigest, input.reviewBasisDigest, json(input.report), at, at);
      const insertFinding = this.db.prepare("INSERT INTO qa_findings(finding_id,report_digest,report_occurrence_id,ordinal,created_at) VALUES(?,?,?,?,?)");
      findingIds.forEach((id, ordinal) => insertFinding.run(id, input.reportDigest, occurrence, ordinal, at));
      this.db.prepare("INSERT INTO qa_report_dispositions(report_digest,report_occurrence_id,disposition,reason,created_at) VALUES(?,?,'open','QA rejected reviewed state',?)").run(input.reportDigest, occurrence, at);
    });
    return this.qaReport(occurrence)!;
  }

  commitQaFailure(input: Omit<QaReportRecordV2, "reportOccurrenceId" | "disposition" | "createdAt" | "updatedAt">, findingIds: string[], expectedRevision: number, now = new Date()): QaReducerStateV2 {
    return this.db.transaction(() => {
      const predecessors = this.unresolvedQaReports(input.runId, input.ticketId);
      const current = this.recordQaReport(input, findingIds, now);
      for (const predecessor of predecessors) {
        if (predecessor.reportOccurrenceId === current.reportOccurrenceId) continue;
        this.db.prepare(`INSERT OR IGNORE INTO qa_report_chains(predecessor_report_digest,successor_report_digest,predecessor_occurrence_id,successor_occurrence_id,relation,created_at)
          VALUES(?,?,?,?,'recheck-failed',?)`).run(predecessor.reportDigest, input.reportDigest, predecessor.reportOccurrenceId, current.reportOccurrenceId, now.toISOString());
      }
      return this.transitionQa(input.runId, input.ticketId, expectedRevision, { type: "review-failed", reportDigest: input.reportDigest, reportOccurrenceId: current.reportOccurrenceId }, now);
    })();
  }

  /** Accept a failed verdict, its exact attempt outcome, report, findings, and reducer edge atomically. */
  commitQaFailureAttempt(
    attemptId: string,
    input: Omit<QaReportRecordV2, "reportOccurrenceId" | "disposition" | "createdAt" | "updatedAt">,
    rawFindingIds: string[],
    namespacedFindingIds: string[],
    detail: string,
    expectedRevision: number,
    now = new Date(),
  ): QaReducerStateV2 {
    return this.db.transaction(() => {
      const attempt = this.qaReviewAttempt(attemptId);
      if (attempt?.status === "failed" && attempt.reportDigest === input.reportDigest && attempt.runId === input.runId && attempt.ticketId === input.ticketId && attempt.reviewNumber === input.reviewNumber) {
        this.recordQaReport(input, namespacedFindingIds, now);
        return this.qaTicketHead(input.runId, input.ticketId);
      }
      if (!attempt || attempt.runId !== input.runId || attempt.ticketId !== input.ticketId
        || attempt.reviewNumber !== input.reviewNumber || attempt.sourceDigest !== input.sourceStateDigest || attempt.status !== "started") {
        throw new Error(`QA failure attempt binding mismatch: ${attemptId}`);
      }
      this.finishQaReviewAttempt(attemptId, { status: "failed", reportDigest: input.reportDigest, findingIds: rawFindingIds, namespacedFindingIds, detail }, now);
      return this.commitQaFailure(input, namespacedFindingIds, expectedRevision, now);
    })();
  }

  qaReportChains(identity: string): Array<{ predecessorReportDigest: string; successorReportDigest: string; predecessorOccurrenceId: string; successorOccurrenceId: string; relation: string; createdAt: string }> {
    const occurrence = this.qaReport(identity)?.reportOccurrenceId;
    if (!occurrence) return [];
    const rows = this.db.prepare(`SELECT * FROM qa_report_chains WHERE predecessor_occurrence_id=? OR successor_occurrence_id=? ORDER BY created_at`).all(occurrence, occurrence) as Array<Record<string, string>>;
    return rows.map(row => ({ predecessorReportDigest: row.predecessor_report_digest!, successorReportDigest: row.successor_report_digest!, predecessorOccurrenceId: row.predecessor_occurrence_id!, successorOccurrenceId: row.successor_occurrence_id!, relation: row.relation!, createdAt: row.created_at! }));
  }

  /** Digest-only compatibility reads fail explicitly when content is shared. */
  qaReport(identity: string, scope?: { runId: string; ticketId: string; reviewNumber: number }): QaReportRecordV2 | undefined {
    if (scope) {
      const report = this.qaReport(reportOccurrenceId(scope.runId, scope.ticketId, scope.reviewNumber));
      if (report && report.reportDigest !== identity && report.reportOccurrenceId !== identity) throw new Error("QA report scope/content mismatch");
      return report;
    }
    const exact = this.db.prepare("SELECT * FROM qa_reports WHERE report_occurrence_id=?").get(identity) as Record<string, unknown> | undefined;
    if (exact) return qaReportV2FromRow(exact);
    const rows = this.db.prepare("SELECT * FROM qa_reports WHERE report_digest=?").all(identity) as Array<Record<string, unknown>>;
    if (rows.length > 1) throw new Error(`ambiguous QA report digest ${identity}; report occurrence scope required`);
    return rows[0] ? qaReportV2FromRow(rows[0]) : undefined;
  }

  unresolvedQaReports(runId: string, ticketId: string): QaReportRecordV2[] {
    return (this.db.prepare("SELECT * FROM qa_reports WHERE run_id=? AND ticket_id=? AND disposition IN ('open','recheck-required') ORDER BY review_number,created_at").all(runId, ticketId) as Array<Record<string, unknown>>).map(qaReportV2FromRow);
  }

  setQaReportDisposition(reportDigest: string, disposition: QaReportDisposition, reason: string, now = new Date()): void {
    const at = now.toISOString();
    this.db.transaction(() => {
      const report = this.qaReport(reportDigest);
      if (!report) throw new Error(`QA report not found: ${reportDigest}`);
      const changed = this.db.prepare("UPDATE qa_reports SET disposition=?,updated_at=? WHERE report_occurrence_id=?").run(disposition, at, report.reportOccurrenceId);
      if (changed.changes !== 1) throw new Error(`QA report not found: ${reportDigest}`);
      this.db.prepare("INSERT INTO qa_report_dispositions(report_digest,report_occurrence_id,disposition,reason,created_at) VALUES(?,?,?,?,?)").run(report.reportDigest, report.reportOccurrenceId, disposition, reason, at);
    })();
  }

  markQaReportsRecheckRequired(runId: string, ticketId: string, reason: string, now = new Date()): void {
    for (const report of this.unresolvedQaReports(runId, ticketId)) this.setQaReportDisposition(report.reportOccurrenceId, "recheck-required", reason, now);
  }

  resolveQaReportsAfterPass(runId: string, ticketId: string, now = new Date()): void {
    for (const report of this.unresolvedQaReports(runId, ticketId)) this.setQaReportDisposition(report.reportOccurrenceId, "verified-fixed", "subsequent bound QA review passed", now);
  }

  commitQaWaiver(runId: string, ticketId: string, expectedRevision: number, reason: string, now = new Date()): QaReducerStateV2 {
    return this.db.transaction(() => {
      const head = this.qaTicketHead(runId, ticketId);
      if (head.revision !== expectedRevision) throw new Error(`QA waiver raced for ${runId}/${ticketId}`);
      for (const report of this.unresolvedQaReports(runId, ticketId)) this.setQaReportDisposition(report.reportOccurrenceId, "waived", reason, now);
      return this.transitionQa(runId, ticketId, head.revision, { type: "waived" }, now);
    })();
  }

  builderRemediationReceipt(operationId: string): BuilderRemediationReceiptV2 | BuilderRemediationReceiptV3 | undefined {
    const row = this.db.prepare("SELECT receipt_json FROM qa_remediation_receipts WHERE operation_id=?").get(operationId) as { receipt_json: string } | undefined;
    return row ? parseJson(row.receipt_json) as BuilderRemediationReceiptV2 | BuilderRemediationReceiptV3 : undefined;
  }

  recordBuilderRemediationReceipt(receipt: BuilderRemediationReceiptV2 | BuilderRemediationReceiptV3): void {
    const text = json(receipt);
    const existing = this.db.prepare("SELECT receipt_json FROM qa_remediation_receipts WHERE operation_id=?").get(receipt.operationId) as { receipt_json: string } | undefined;
    if (existing && json(parseJson(existing.receipt_json)) !== text) throw new Error(`Builder remediation receipt collision: ${receipt.operationId}`);
    const remediation = this.qaRemediationAttempt(receipt.operationId);
    const review = remediation ? this.qaReviewAttempt(remediation.reviewAttemptId) : undefined;
    const occurrence = this.qaReport(receipt.reportDigest, review ? { runId: receipt.runId, ticketId: receipt.ticketId, reviewNumber: review.reviewNumber } : undefined);
    if (!occurrence) throw new Error("Builder receipt missing report occurrence");
    this.db.prepare("INSERT OR IGNORE INTO qa_remediation_receipts(operation_id,run_id,ticket_id,report_digest,report_occurrence_id,receipt_json,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(receipt.operationId, receipt.runId, receipt.ticketId, receipt.reportDigest, occurrence.reportOccurrenceId, text, receipt.completedAt);
  }

  commitBuilderRemediationSuccess(receipt: BuilderRemediationReceiptV2 | BuilderRemediationReceiptV3, expectedRevision: number, now = new Date()): QaReducerStateV2 {
    return this.db.transaction(() => {
      this.recordBuilderRemediationReceipt(receipt);
      this.markQaReportsRecheckRequired(receipt.runId, receipt.ticketId, "Builder remediation received; QA recheck required", now);
      return this.transitionQa(receipt.runId, receipt.ticketId, expectedRevision, { type: "remediation-received" }, now);
    })();
  }

  commitQaRemediationOutcome(input: {
    recoveryAttemptId: string;
    remediationAttemptId: string;
    outcome: "succeeded" | "failed" | "uncertain";
    detail?: string;
    responseDigest?: string;
    summaryDigest?: string;
    receipt?: BuilderRemediationReceiptV2 | BuilderRemediationReceiptV3;
    expectedRevision: number;
  }, now = new Date()): QaReducerStateV2 {
    return this.db.transaction(() => {
      const remediation = this.qaRemediationAttempt(input.remediationAttemptId);
      if (!remediation) throw new Error(`QA remediation attempt not found: ${input.remediationAttemptId}`);
      const head = this.qaTicketHead(remediation.runId, remediation.ticketId);
      if (head.revision !== input.expectedRevision || head.state !== "remediation-intended") throw new Error(`Builder remediation outcome raced for ${remediation.runId}/${remediation.ticketId}`);
      this.updateRecoveryAttempt(input.recoveryAttemptId, input.outcome === "uncertain" ? "failed" : input.outcome, input.detail, now);
      this.updateQaRemediationAttempt(input.remediationAttemptId, input.outcome, { responseDigest: input.responseDigest, summaryDigest: input.summaryDigest, detail: input.detail }, now);
      if (input.outcome === "succeeded") {
        if (!input.receipt || input.receipt.operationId !== input.remediationAttemptId) throw new Error("successful Builder remediation is missing its bound receipt");
        return this.commitBuilderRemediationSuccess(input.receipt, head.revision, now);
      }
      return this.transitionQa(remediation.runId, remediation.ticketId, head.revision,
        { type: input.outcome === "uncertain" ? "remediation-uncertain" : "remediation-failed" }, now);
    })();
  }

  issueQaPassCertificate(input: Omit<QaPassCertificateV2, "version" | "certificateId" | "unresolvedReportCount" | "issuedAt">, now = new Date()): QaPassCertificateV2 {
    if (this.unresolvedQaReports(input.runId, input.ticketId).length) throw new Error("cannot issue QA pass certificate while reports remain unresolved");
    const certificate: QaPassCertificateV2 = { version: 2, certificateId: qaDigest("pass-certificate", { ...input, issuedAt: now.toISOString() }), ...input, unresolvedReportCount: 0, issuedAt: now.toISOString() };
    this.db.prepare("INSERT INTO qa_pass_certificates(certificate_id,run_id,ticket_id,qa_revision,source_state_digest,review_basis_digest,turn_receipt_digest,certificate_json,issued_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(certificate.certificateId, certificate.runId, certificate.ticketId, certificate.qaRevision, certificate.sourceStateDigest, certificate.reviewBasisDigest, certificate.turnReceiptDigest, json(certificate), certificate.issuedAt);
    return certificate;
  }

  commitQaPass(input: Omit<QaPassCertificateV2, "version" | "certificateId" | "unresolvedReportCount" | "issuedAt">, expectedRevision: number, now = new Date()): QaPassCertificateV2 {
    return this.db.transaction(() => {
      this.resolveQaReportsAfterPass(input.runId, input.ticketId, now);
      const certificate = this.issueQaPassCertificate(input, now);
      this.transitionQa(input.runId, input.ticketId, expectedRevision, { type: "review-passed", passCertificateId: certificate.certificateId }, now);
      return certificate;
    })();
  }

  /** Accept a passing verdict, its review-attempt outcome, report resolution, certificate, and reducer edge atomically. */
  commitQaPassAttempt(
    attemptId: string,
    input: Omit<QaPassCertificateV2, "version" | "certificateId" | "unresolvedReportCount" | "issuedAt">,
    detail: string,
    expectedRevision: number,
    now = new Date(),
  ): QaPassCertificateV2 {
    return this.db.transaction(() => {
      const attempt = this.qaReviewAttempt(attemptId);
      if (!attempt || attempt.runId !== input.runId || attempt.ticketId !== input.ticketId
        || attempt.reviewNumber !== this.qaTicketHead(input.runId, input.ticketId).reviewNumber
        || attempt.sourceDigest !== input.sourceStateDigest || attempt.status !== "started") {
        throw new Error(`QA pass attempt binding mismatch: ${attemptId}`);
      }
      this.finishQaReviewAttempt(attemptId, { status: "passed", detail }, now);
      return this.commitQaPass(input, expectedRevision, now);
    })();
  }

  consumeQaPassCertificate(runId: string, ticketId: string, certificateId: string, consumer: string, now = new Date()): QaPassCertificateV2 {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT certificate_json,consumed_at FROM qa_pass_certificates WHERE certificate_id=? AND run_id=? AND ticket_id=?").get(certificateId, runId, ticketId) as { certificate_json: string; consumed_at: string | null } | undefined;
      if (!row) throw new Error("QA pass certificate is missing or scoped to another run/ticket");
      if (row.consumed_at) throw new Error("QA pass certificate has already been consumed");
      if (this.unresolvedQaReports(runId, ticketId).length) throw new Error("QA pass certificate cannot be consumed with unresolved reports");
      const at = now.toISOString();
      const certificate = { ...(parseJson(row.certificate_json) as QaPassCertificateV2), consumedAt: at, consumedBy: consumer };
      const changed = this.db.prepare("UPDATE qa_pass_certificates SET certificate_json=?,consumed_at=?,consumed_by=? WHERE certificate_id=? AND consumed_at IS NULL").run(json(certificate), at, consumer, certificateId);
      if (changed.changes !== 1) throw new Error("QA pass certificate consumption raced with another finalizer");
      return certificate;
    })();
  }

  invalidateUnconsumedQaPassCertificates(runId: string, ticketId: string, reason: string, now = new Date(), issuedBefore?: string): void {
    const at = now.toISOString();
    this.db.prepare("UPDATE qa_pass_certificates SET consumed_at=?,consumed_by=? WHERE run_id=? AND ticket_id=? AND consumed_at IS NULL AND (? IS NULL OR issued_at<=?)").run(at, `invalidated:${reason}`, runId, ticketId, issuedBefore??null, issuedBefore??null);
  }

  invalidateQaPassBeforeFinalization(input: {
    runId: string; ticketId: string; certificateId: string; expectedSourceStateDigest: string;
    expectedRevision: number; reason: string;
  }, now = new Date()): QaReducerStateV2 {
    return this.db.transaction(() => {
      const head = this.qaTicketHead(input.runId, input.ticketId);
      if (head.revision !== input.expectedRevision || head.state !== "passed") throw new Error(`QA pass invalidation raced for ${input.runId}/${input.ticketId}`);
      if (head.passCertificateId !== input.certificateId || head.sourceStateDigest !== input.expectedSourceStateDigest) {
        throw new Error("QA pass invalidation does not match the accepted pass/source binding");
      }
      this.invalidateUnconsumedQaPassCertificates(input.runId, input.ticketId, input.reason, now);
      return this.transitionQa(input.runId, input.ticketId, head.revision, { type: "pass-invalidated", reason: input.reason }, now);
    })();
  }

  beginQaFinalization(input: {
    runId: string; ticketId: string; certificateId: string; consumer: string;
    expectedSourceStateDigest: string; expectedGitTree: string; allowedProjectionPaths: string[]; expectedRevision: number; operationId: string;
  }, now = new Date()): QaReducerStateV2 {
    return this.db.transaction(() => {
      this.assertFinalizationControls(input.runId,input.ticketId);
      const head = this.qaTicketHead(input.runId, input.ticketId);
      if (head.revision !== input.expectedRevision || head.state !== "passed") throw new Error(`QA finalization start raced for ${input.runId}/${input.ticketId}`);
      if (head.passCertificateId !== input.certificateId || head.sourceStateDigest !== input.expectedSourceStateDigest) {
        throw new Error("QA finalization does not match the reducer's accepted pass/source binding");
      }
      const certificate = this.consumeQaPassCertificate(input.runId, input.ticketId, input.certificateId, input.consumer, now);
      if (certificate.qaRevision !== head.revision || certificate.sourceStateDigest !== input.expectedSourceStateDigest
        || certificate.reviewBasisDigest !== head.reviewBasisDigest) {
        throw new Error("QA finalization certificate does not match the durable reducer head");
      }
      const next = this.transitionQa(input.runId, input.ticketId, head.revision, { type: "finalization-started" }, now);
      this.planQaFinalizationStep({ operationId: input.operationId, runId: input.runId, ticketId: input.ticketId, certificateId: input.certificateId,
        kind: input.consumer, intent: { expectedSourceStateDigest: input.expectedSourceStateDigest, expectedGitTree: input.expectedGitTree,
          allowedProjectionPaths: [...input.allowedProjectionPaths].sort(), reducerRevision: next.revision } }, now);
      return next;
    })();
  }

  planQaFinalizationStep(input: { operationId: string; runId: string; ticketId: string; certificateId: string; kind: string; intent: unknown }, now = new Date()): void {
    const at = now.toISOString(); const intentText = json(input.intent);
    const existing = this.db.prepare("SELECT run_id,ticket_id,certificate_id,kind,intent_json FROM qa_finalization_steps WHERE operation_id=?").get(input.operationId) as Record<string, unknown> | undefined;
    if (existing && (existing.run_id !== input.runId || existing.ticket_id !== input.ticketId || existing.certificate_id !== input.certificateId || existing.kind !== input.kind || json(parseJson(String(existing.intent_json))) !== intentText)) throw new Error(`QA finalization operation collision: ${input.operationId}`);
    this.db.prepare("INSERT OR IGNORE INTO qa_finalization_steps(operation_id,run_id,ticket_id,certificate_id,kind,status,intent_json,created_at,updated_at) VALUES(?,?,?,?,?,'intended',?,?,?)")
      .run(input.operationId, input.runId, input.ticketId, input.certificateId, input.kind, intentText, at, at);
  }

  finishQaFinalizationStep(operationId: string, receipt: unknown, now = new Date()): void {
    const at = now.toISOString();
    const changed = this.db.prepare("UPDATE qa_finalization_steps SET status='completed',receipt_json=?,updated_at=? WHERE operation_id=? AND status='intended'").run(json(receipt), at, operationId);
    if (changed.changes !== 1) {
      const prior = this.db.prepare("SELECT status,receipt_json FROM qa_finalization_steps WHERE operation_id=?").get(operationId) as { status: string; receipt_json: string | null } | undefined;
      if (!prior || prior.status !== "completed" || json(parseJson(prior.receipt_json!)) !== json(receipt)) throw new Error(`QA finalization step cannot be completed: ${operationId}`);
    }
  }

  finishPendingQaFinalizationSteps(runId: string, ticketId: string, receipt: unknown, now = new Date()): void {
    const rows = this.db.prepare("SELECT operation_id FROM qa_finalization_steps WHERE run_id=? AND ticket_id=? AND status='intended' ORDER BY created_at").all(runId, ticketId) as Array<{ operation_id: string }>;
    if (!rows.length) throw new Error(`QA finalization intent is missing for ${runId}/${ticketId}`);
    for (const row of rows) this.finishQaFinalizationStep(row.operation_id, receipt, now);
  }

  qaFinalizationSteps(runId: string, ticketId: string): QaFinalizationStepRecord[] {
    const rows = this.db.prepare("SELECT * FROM qa_finalization_steps WHERE run_id=? AND ticket_id=? ORDER BY created_at,operation_id").all(runId, ticketId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      operationId: String(row.operation_id), runId: String(row.run_id), ticketId: String(row.ticket_id),
      certificateId: String(row.certificate_id), kind: String(row.kind), status: String(row.status) as QaFinalizationStepRecord["status"],
      intent: parseJson(String(row.intent_json)) as QaFinalizationStepRecord["intent"],
      ...(typeof row.receipt_json === "string" ? { receipt: parseJson(row.receipt_json) } : {}),
    }));
  }

  invalidateQaFinalization(runId: string, ticketId: string, expectedRevision: number, reason: string, branch?: string, now = new Date()): QaReducerStateV2 {
    return this.db.transaction(() => {
      const head = this.qaTicketHead(runId, ticketId);
      if (head.state !== "finalizing" || head.revision !== expectedRevision) throw new Error("QA finalization invalidation raced with another transition");
      const published = this.operations(runId).find((operation) => {
        if (!["direct-merge", "push", "pr-create", "mr-create", "ticket-complete"].includes(operation.kind)
          || !["in_progress", "uncertain", "confirmed"].includes(operation.status)) return false;
        const intent = operation.intent as { ticket?: string; branch?: string; head?: string };
        return intent.ticket === ticketId || Boolean(branch && (intent.branch === branch || intent.head === branch));
      });
      if (published) throw new Error(`QA source drift requires reconciliation of existing publication ${published.idempotencyKey}; its durable evidence is preserved`);
      const at = now.toISOString();
      const updated = this.db.prepare("UPDATE qa_finalization_steps SET status='invalidated',receipt_json=?,updated_at=? WHERE run_id=? AND ticket_id=? AND status='intended'")
        .run(json({ invalidatedAt: at, reason }), at, runId, ticketId);
      if (updated.changes !== 1) throw new Error("QA finalization invalidation requires exactly one pending intent");
      return this.transitionQa(runId, ticketId, head.revision, { type: "finalization-invalidated", reason }, now);
    })();
  }

  completeQaFinalization(runId: string, ticketId: string, expectedRevision: number, receipt: unknown, now = new Date()): QaReducerStateV2 {
    return this.db.transaction(() => {
      this.assertFinalizationControls(runId,ticketId);
      const head = this.qaTicketHead(runId, ticketId);
      if (head.revision !== expectedRevision || head.state !== "finalizing") throw new Error(`QA finalization completion raced for ${runId}/${ticketId}`);
      this.finishPendingQaFinalizationSteps(runId, ticketId, receipt, now);
      return this.transitionQa(runId, ticketId, head.revision, { type: "completed" }, now);
    })();
  }

  planQaPacketProjection(input: { runId: string; ticketId: string; qaRevision: number; packetDigest: string; path: string; manifestJson: string }, now = new Date()): void {
    this.ensureRun(input.runId);
    this.db.prepare("INSERT INTO qa_packet_projections(run_id,ticket_id,qa_revision,packet_digest,path,manifest_json,status,created_at) VALUES(?,?,?,?,?,?,'intended',?) ON CONFLICT(packet_digest) DO NOTHING")
      .run(input.runId, input.ticketId, input.qaRevision, input.packetDigest, input.path, input.manifestJson, now.toISOString());
    const row = this.db.prepare("SELECT run_id,ticket_id,qa_revision,path,manifest_json FROM qa_packet_projections WHERE packet_digest=?").get(input.packetDigest) as { run_id: string; ticket_id: string; qa_revision: number; path: string; manifest_json: string | null };
    if (row.run_id !== input.runId || row.ticket_id !== input.ticketId || row.qa_revision !== input.qaRevision || row.path !== input.path
      || row.manifest_json !== input.manifestJson) throw new Error(`QA packet projection collision: ${input.packetDigest}`);
  }

  finishQaPacketProjection(runId: string, ticketId: string, packetDigest: string): void {
    const changed = this.db.prepare("UPDATE qa_packet_projections SET status='published' WHERE run_id=? AND ticket_id=? AND packet_digest=? AND status='intended'").run(runId, ticketId, packetDigest);
    if (changed.changes !== 1) {
      const row = this.db.prepare("SELECT status FROM qa_packet_projections WHERE run_id=? AND ticket_id=? AND packet_digest=?").get(runId, ticketId, packetDigest) as { status: string } | undefined;
      if (row?.status !== "published") throw new Error(`QA packet projection intent is missing: ${packetDigest}`);
    }
  }

  qaPacketProjection(packetDigest: string): QaPacketProjectionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM qa_packet_projections WHERE packet_digest=?").get(packetDigest) as Record<string, unknown> | undefined;
    return row ? {
      runId: String(row.run_id), ticketId: String(row.ticket_id), packetRevision: Number(row.qa_revision),
      packetDigest: String(row.packet_digest), path: String(row.path), status: String(row.status) as QaPacketProjectionRecord["status"],
      ...(typeof row.manifest_json === "string" ? { manifestJson: row.manifest_json } : {}),
      createdAt: String(row.created_at),
    } : undefined;
  }

  qaPacketProjectionsAtPath(path: string): QaPacketProjectionRecord[] {
    const rows = this.db.prepare("SELECT * FROM qa_packet_projections WHERE path=? ORDER BY created_at,packet_digest").all(path) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      runId: String(row.run_id), ticketId: String(row.ticket_id), packetRevision: Number(row.qa_revision),
      packetDigest: String(row.packet_digest), path: String(row.path), status: String(row.status) as QaPacketProjectionRecord["status"],
      ...(typeof row.manifest_json === "string" ? { manifestJson: String(row.manifest_json) } : {}),
      createdAt: String(row.created_at),
    }));
  }

  pendingQaPacketProjections(runId: string): QaPacketProjectionRecord[] {
    const rows = this.db.prepare("SELECT * FROM qa_packet_projections WHERE run_id=? AND status='intended' ORDER BY created_at,packet_digest").all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      runId: String(row.run_id), ticketId: String(row.ticket_id), packetRevision: Number(row.qa_revision),
      packetDigest: String(row.packet_digest), path: String(row.path), status: "intended",
      ...(typeof row.manifest_json === "string" ? { manifestJson: String(row.manifest_json) } : {}),
      createdAt: String(row.created_at),
    }));
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

  acceptHandoff(runId: string, generation: number, successor: string | ProviderSessionRefV1, now = new Date(), receipt?: HandoffAcceptanceReceiptV1): HandoffLineage {
    const session = sessionParts(typeof successor === "object" ? successor : undefined, typeof successor === "string" ? successor : undefined);
    if (!session.id?.trim()) throw new Error("a validated successor session ID is required before handoff acceptance");
    return this.db.transaction(() => {
      const prior = this.handoff(runId, generation);
      if (!prior) throw new Error(`handoff generation ${generation} not found for run ${runId}`);
      if (prior.state === "failed") throw new Error("a failed handoff cannot be accepted");
      if (prior.state === "accepted") {
        if (prior.successorSessionId !== session.id) throw new Error("accepted handoff cannot change successors");
        return prior;
      }
      const manifest = this.handoffContent(runId, generation)!.manifest;
      const owner = this.roleMutationLease(runId, manifest.role);
      if (owner && manifest.predecessorSessionId && owner.providerSessionId !== manifest.predecessorSessionId) throw new Error("handoff predecessor lost ownership before acceptance");
      if (owner?.sessionKey && manifest.predecessorSessionRef && owner.sessionKey !== providerSessionKey(manifest.predecessorSessionRef)) throw new Error("handoff predecessor scope changed before acceptance");
      if (session.ref && (session.ref.role !== manifest.role || session.ref.generation !== generation || !session.ref.validatedAt
        || generation <= (manifest.predecessorSessionRef?.generation ?? -1))) throw new Error("handoff successor scope or generation is invalid");
      if (session.ref) this.recordProviderSessionBinding(session.ref, now);
      const at = now.toISOString();
      const receiptDigest = receipt ? this.putEvidence("handoff", Buffer.from(JSON.stringify(receipt))) : undefined;
      this.db.prepare(`UPDATE handoffs SET state='accepted',successor_session_id=?,successor_session_key=?,successor_session_ref_json=?,accepted_at=?,acceptance_receipt_digest=? WHERE run_id=? AND generation=?`)
        .run(session.id, session.key, session.refJson, at, receiptDigest ?? null, runId, generation);
      this.db.prepare(`INSERT INTO role_mutation_leases(run_id,role,generation,provider_session_id,provider_session_key,provider_session_ref_json,moved_at)
        SELECT run_id,role,generation,?,?,?,? FROM handoffs WHERE run_id=? AND generation=?
        ON CONFLICT(run_id,role) DO UPDATE SET generation=excluded.generation,provider_session_id=excluded.provider_session_id,provider_session_key=excluded.provider_session_key,provider_session_ref_json=excluded.provider_session_ref_json,moved_at=excluded.moved_at`)
        .run(session.id, session.key, session.refJson, at, runId, generation);
      if (manifest.role === "builder" && session.ref) {
        const rows = this.db.prepare("SELECT ticket,session_json FROM branch_resume_sessions WHERE run_id=? AND status='active'").all(runId) as Array<{ ticket: string; session_json: string }>;
        for (const row of rows) {
          const current = parseJson(row.session_json) as BranchResumeSession;
          if (current.sessionId !== manifest.predecessorSessionId || resolve(current.worktreePath) !== resolve(session.ref.cwd)) continue;
          this.recordBranchResumeSession(runId, { ...current, sessionId: session.id!, sessionRef: session.ref }, now);
        }
      }
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

  finishCompactionAttempt(idempotencyKey: string, input: { ok: boolean; uncertain?: boolean; afterSample?: ContextSample; error?: string }, now = new Date()): CompactionAttemptRecord {
    const prior = this.compactionAttempt(idempotencyKey);
    if (!prior) throw new Error(`compaction attempt not found: ${idempotencyKey}`);
    if (prior.status !== "started" && prior.status !== "uncertain") return prior;
    const status = input.ok ? "succeeded" : input.uncertain ? "uncertain" : "failed";
    this.db.prepare("UPDATE compaction_attempts SET status=?,after_sample_json=?,error=?,updated_at=? WHERE idempotency_key=?")
      .run(status, input.afterSample ? json(input.afterSample) : null, input.error ? sanitizeText(input.error).slice(0, 2000) : null, now.toISOString(), idempotencyKey);
    this.insertEvent(prior.runId, `compaction_${status}`, `context:${prior.role}`, { idempotencyKey, providerSessionId: prior.providerSessionId, sessionKey: prior.sessionKey, crossingKey: prior.crossingKey, lateCompletion: prior.status === "uncertain" && input.ok }, now.toISOString());
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

  unresolvedCompactions(runId: string, role: "builder" | "qa", sessionKey: string): CompactionAttemptRecord[] {
    return (this.db.prepare("SELECT * FROM compaction_attempts WHERE run_id=? AND role=? AND session_key=? AND status IN ('started','uncertain')").all(runId, role, sessionKey) as DbCompactionAttempt[]).map(compactionAttemptFromRow);
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
      } else if (startSequence && event.sequence > startSequence && event.role === role
        && (event.kind === "turn_completed" || event.kind === "turn_completed_after_repair" || event.kind === "handback_turn_completed" || event.kind === "fresh_successor_accepted")) {
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
      const admission = this.buildAdmission();
      if (admission) {
        const local = localBuildAuthority(this.projectDir);
        if (!local || local.token !== admission.token || local.runId !== runId) {
          const state = classifyProcess(admission.pid, admission.processStart, admission.host);
          if (state.state !== "dead") throw new Error(`Build ${admission.runId} admission is ${state.state}: ${state.reason}`);
          if (this.db.prepare("SELECT 1 FROM build_launches WHERE run_id=? AND state IN ('reserved','dispatching')").get(admission.runId)) throw new Error("Unresolved build launch requires reconciliation");
        } else assertAdmission(this.db, local);
      }
      const current = this.currentLease();
      if (current && leaseVerifiedLive(current, now, staleMs)) throw new Error(`project workflow lease is held by ${current.owner} for run ${current.runId}`);
      const sequence = this.db.prepare("SELECT generation FROM workflow_lease_sequence WHERE singleton=1").get() as {generation:number};
      const generation = Math.max(sequence.generation, current?.generation ?? 0) + 1;
      this.db.prepare("UPDATE workflow_lease_sequence SET generation=? WHERE singleton=1").run(generation);
      this.db.prepare(`INSERT INTO project_lease(singleton,owner,generation,pid,host,process_start,heartbeat_at,run_id)
        VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,pid=excluded.pid,host=excluded.host,process_start=excluded.process_start,heartbeat_at=excluded.heartbeat_at,run_id=excluded.run_id`)
        .run(owner, generation, pid, host, processStart, at, runId);
      this.db.prepare("UPDATE workflow_runs SET lease_generation=? WHERE run_id=?").run(generation, runId);
      this.insertEvent(runId, current ? "lease_takeover" : "lease_acquired", "lease", { owner, generation, previous: current?.owner }, at);
      const lease = { owner, generation, pid, host, processStart, heartbeatAt: at, runId };
      this.writerLease = lease;
      rememberOriginalLease(this.projectDir, lease);
      if (this.getRun(runId)?.kind === "build") this.db.prepare("INSERT OR IGNORE INTO build_runtime_runs VALUES(?)").run(runId);
      return lease;
    }).immediate();
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
      if (result.changes === 1) forgetOriginalLease(this.projectDir, lease);
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
    const rows = this.db.prepare(`SELECT s.session_json FROM branch_resume_sessions s JOIN workflow_runs r ON r.run_id=s.run_id${activeOnly ? " WHERE s.status='active' AND r.status NOT IN ('superseded','completed','cancelled')" : ""} ORDER BY s.updated_at,s.ticket`).all() as Array<{ session_json: string }>;
    return rows.map(row => parseJson(row.session_json) as BranchResumeSession);
  }

  branchResumeSession(runId: string, ticket: string): BranchResumeSession | undefined {
    const row = this.db.prepare("SELECT s.session_json FROM branch_resume_sessions s JOIN workflow_runs r ON r.run_id=s.run_id WHERE s.run_id=? AND s.ticket=? AND s.status='active' AND r.status NOT IN ('superseded','completed','cancelled')").get(runId, ticket) as { session_json: string } | undefined;
    return row ? parseJson(row.session_json) as BranchResumeSession : undefined;
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
      CREATE TABLE IF NOT EXISTS qa_recovery_heads(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,packet_id TEXT NOT NULL,packet_path TEXT NOT NULL,packet_digest TEXT NOT NULL,reviewed_state_digest TEXT NOT NULL,revision INTEGER NOT NULL,correction_turns INTEGER NOT NULL,pending_action TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,ticket_id));
      CREATE TABLE IF NOT EXISTS qa_review_attempts(attempt_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,review_number INTEGER NOT NULL,cycle INTEGER NOT NULL,remediation_generation INTEGER NOT NULL,source_digest TEXT NOT NULL,status TEXT NOT NULL,report_digest TEXT,record_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(run_id,ticket_id,review_number));
      CREATE TABLE IF NOT EXISTS qa_remediation_attempts(attempt_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,review_attempt_id TEXT NOT NULL REFERENCES qa_review_attempts(attempt_id),generation INTEGER NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,request_digest TEXT NOT NULL,response_digest TEXT,summary_digest TEXT,record_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qa_ticket_heads(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,state_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,ticket_id));
      CREATE TABLE IF NOT EXISTS qa_transitions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,from_revision INTEGER NOT NULL,to_revision INTEGER NOT NULL,event_json TEXT NOT NULL,state_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(run_id,ticket_id,to_revision));
      CREATE TABLE IF NOT EXISTS qa_source_states(digest TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,origin_digest TEXT NOT NULL,content_digest TEXT NOT NULL,state_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(run_id,ticket_id,digest));
      CREATE TABLE IF NOT EXISTS qa_review_bases(digest TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,basis_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(run_id,ticket_id,digest));
      CREATE TABLE IF NOT EXISTS qa_sessions(session_key TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,generation INTEGER NOT NULL,source_state_digest TEXT NOT NULL,review_basis_digest TEXT NOT NULL,confinement_digest TEXT NOT NULL,session_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qa_retry_slots(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,review_number INTEGER NOT NULL,session_generation INTEGER NOT NULL,retry_slot TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,ticket_id,review_number,session_generation,retry_slot));
      CREATE TABLE IF NOT EXISTS qa_turns(operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,review_number INTEGER NOT NULL,session_generation INTEGER NOT NULL,retry_slot TEXT NOT NULL,source_state_digest TEXT NOT NULL,review_basis_digest TEXT NOT NULL,status TEXT NOT NULL,intent_json TEXT NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qa_turn_events(operation_id TEXT NOT NULL REFERENCES qa_turns(operation_id),event_index INTEGER NOT NULL,event_json TEXT NOT NULL,event_digest TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(operation_id,event_index));
      CREATE TABLE IF NOT EXISTS qa_reports(report_digest TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,review_number INTEGER NOT NULL,source_state_digest TEXT NOT NULL,review_basis_digest TEXT NOT NULL,disposition TEXT NOT NULL,report_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qa_findings(finding_id TEXT PRIMARY KEY,report_digest TEXT NOT NULL REFERENCES qa_reports(report_digest),ordinal INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qa_report_dispositions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,report_digest TEXT NOT NULL REFERENCES qa_reports(report_digest),disposition TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qa_report_chains(predecessor_report_digest TEXT NOT NULL REFERENCES qa_reports(report_digest),successor_report_digest TEXT NOT NULL REFERENCES qa_reports(report_digest),relation TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(predecessor_report_digest,successor_report_digest));
      CREATE TABLE IF NOT EXISTS qa_failure_handoffs(handoff_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,review_attempt_id TEXT NOT NULL REFERENCES qa_review_attempts(attempt_id),report_digest TEXT NOT NULL REFERENCES qa_reports(report_digest),generation INTEGER NOT NULL,reviewed_content_digest TEXT NOT NULL,review_basis_digest TEXT NOT NULL,state TEXT NOT NULL,handoff_digest TEXT NOT NULL,host_instruction_digest TEXT NOT NULL,builder_session_json TEXT,provider_turn_id TEXT,receipt_digest TEXT,response_digest TEXT,parsed_response_digest TEXT,post_source_digest TEXT,detail TEXT,record_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(run_id,ticket_id,review_attempt_id,report_digest,generation));
      CREATE TABLE IF NOT EXISTS qa_handoffs(operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,qa_revision INTEGER NOT NULL,source_state_digest TEXT NOT NULL,review_basis_digest TEXT NOT NULL,status TEXT NOT NULL,intent_json TEXT NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qa_remediation_receipts(operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,report_digest TEXT NOT NULL REFERENCES qa_reports(report_digest),receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qa_pass_certificates(certificate_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,qa_revision INTEGER NOT NULL,source_state_digest TEXT NOT NULL,review_basis_digest TEXT NOT NULL,turn_receipt_digest TEXT NOT NULL,certificate_json TEXT NOT NULL,issued_at TEXT NOT NULL,consumed_at TEXT,consumed_by TEXT);
      CREATE TABLE IF NOT EXISTS qa_finalization_steps(operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,certificate_id TEXT NOT NULL REFERENCES qa_pass_certificates(certificate_id),kind TEXT NOT NULL,status TEXT NOT NULL,intent_json TEXT NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qa_operation_journal(operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,kind TEXT NOT NULL,intent_digest TEXT NOT NULL,intent_json TEXT NOT NULL,status TEXT NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qa_packet_projections(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),ticket_id TEXT NOT NULL,qa_revision INTEGER NOT NULL,packet_digest TEXT PRIMARY KEY,path TEXT NOT NULL,manifest_json TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_events_run ON workflow_events(run_id,sequence);
      CREATE INDEX IF NOT EXISTS operations_run ON operation_journal(run_id,status);
      CREATE INDEX IF NOT EXISTS recovery_attempt_scope ON recovery_attempts(run_id,ticket,phase,cause,operation_key,outcome);
      CREATE INDEX IF NOT EXISTS human_decisions_run ON human_decisions(run_id,status,created_at);
      CREATE INDEX IF NOT EXISTS context_samples_run_role ON context_samples(run_id,role,sample_id);
      CREATE INDEX IF NOT EXISTS continuity_events_run ON continuity_events(run_id,sequence);
      CREATE INDEX IF NOT EXISTS continuity_checkpoints_run_role ON continuity_checkpoints(run_id,role,checkpoint_id);
      CREATE INDEX IF NOT EXISTS compaction_session ON compaction_attempts(run_id,role,provider_session_id,status);
      CREATE INDEX IF NOT EXISTS qa_review_history ON qa_review_attempts(run_id,ticket_id,review_number);
      CREATE INDEX IF NOT EXISTS qa_remediation_history ON qa_remediation_attempts(run_id,ticket_id,generation);
      CREATE INDEX IF NOT EXISTS qa_failure_handoff_history ON qa_failure_handoffs(run_id,ticket_id,generation,state);
      CREATE INDEX IF NOT EXISTS qa_transition_history ON qa_transitions(run_id,ticket_id,sequence);
      CREATE INDEX IF NOT EXISTS qa_report_open ON qa_reports(run_id,ticket_id,disposition,review_number);
      CREATE INDEX IF NOT EXISTS qa_turn_history ON qa_turns(run_id,ticket_id,review_number,session_generation);
    `);
    for (const [table, columns] of Object.entries({
      provider_sessions: { session_key: "TEXT", session_ref_json: "TEXT" },
      context_samples: { session_key: "TEXT", session_ref_json: "TEXT" },
      session_usage_samples: { session_key: "TEXT", session_ref_json: "TEXT" },
      live_settings_acknowledgments: { session_key: "TEXT", session_ref_json: "TEXT" },
      continuity_events: { session_key: "TEXT", session_ref_json: "TEXT" },
      continuity_checkpoints: { session_key: "TEXT", session_ref_json: "TEXT" },
      handoffs: { predecessor_session_key: "TEXT", predecessor_session_ref_json: "TEXT", successor_session_key: "TEXT", successor_session_ref_json: "TEXT", acceptance_receipt_digest: "TEXT" },
      role_mutation_leases: { provider_session_key: "TEXT", provider_session_ref_json: "TEXT" },
      compaction_attempts: { session_key: "TEXT", session_ref_json: "TEXT" },
      recovery_decisions: { session_key: "TEXT", session_ref_json: "TEXT" },
      qa_packet_projections: { manifest_json: "TEXT" },
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
    const migration = "002_qa_protocol_v2";
    const migrationDigest = createHash("sha256").update(migration).update("\0qa-v2-schema-2026-09-04").digest("hex");
    const existingMigration = this.db.prepare("SELECT completed_at FROM recovery_schema_migrations WHERE migration=?").get(`${migration}:${migrationDigest}`);
    if (!existingMigration) this.db.prepare("INSERT INTO recovery_schema_migrations(migration,completed_at) VALUES(?,?)").run(`${migration}:${migrationDigest}`, new Date().toISOString());
    migrateQaHandback(this.db);
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
type DbHandoff = { run_id: string; generation: number; manifest_digest: string; markdown_digest: string; predecessor_session_id: string | null; predecessor_session_key: string | null; predecessor_session_ref_json: string | null; successor_session_id: string | null; successor_session_key: string | null; successor_session_ref_json: string | null; acceptance_receipt_digest: string | null; state: HandoffLineage["state"]; created_at: string; accepted_at: string | null };
type DbCompactionAttempt = { idempotency_key: string; run_id: string; role: "builder" | "qa"; provider_session_id: string | null; session_key: string | null; session_ref_json: string | null; crossing_key: string; status: CompactionAttemptRecord["status"]; before_sample_json: string | null; after_sample_json: string | null; error: string | null; created_at: string; updated_at: string };
type DbQaRecoveryHead = { run_id: string; ticket_id: string; packet_id: string; packet_path: string; packet_digest: string; reviewed_state_digest: string; revision: number; correction_turns: number; pending_action: string; updated_at: string };
type DbQaReviewAttempt = { attempt_id: string; run_id: string; ticket_id: string; review_number: number; cycle: number; remediation_generation: number; source_digest: string; status: QaReviewAttemptRecord["status"]; report_digest: string | null; record_json: string; created_at: string; updated_at: string };
type DbQaRemediationAttempt = { attempt_id: string; run_id: string; ticket_id: string; review_attempt_id: string; generation: number; mode: QaRemediationAttemptRecord["mode"]; status: QaRemediationAttemptRecord["status"]; request_digest: string; response_digest: string | null; summary_digest: string | null; record_json: string; created_at: string; updated_at: string };
type DbQaFailureHandoff = { handoff_id: string; operation_id: string; run_id: string; ticket_id: string; review_attempt_id: string; report_digest: string; generation: number; reviewed_content_digest: string; review_basis_digest: string; state: QaFailureHandoffState; handoff_digest: string; host_instruction_digest: string; builder_session_json: string | null; provider_turn_id: string | null; receipt_digest: string | null; response_digest: string | null; parsed_response_digest: string | null; post_source_digest: string | null; detail: string | null; record_json: string; created_at: string; updated_at: string };

function rowToRun(row: DbRun): WorkflowRunSnapshot { return { runId: row.run_id, kind: row.kind, status: row.status, checkpoint: row.checkpoint, originalWork: parseJson(row.original_work_json), remainingWork: parseJson(row.remaining_work_json), state: parseJson(row.state_json) as Record<string, unknown>, ...(row.lease_generation === null ? {} : { leaseGeneration: row.lease_generation }), legacy: Boolean(row.legacy), createdAt: row.created_at, updatedAt: row.updated_at }; }
function operationFromRow(row: DbOperation): OperationRecord { return { idempotencyKey: row.idempotency_key, runId: row.run_id, kind: row.kind, status: row.status, intent: parseJson(row.intent_json), ...(row.result_json ? { result: parseJson(row.result_json) } : {}), ...(row.external_id ? { externalId: row.external_id } : {}), ...(row.error ? { error: row.error } : {}), createdAt: row.created_at, updatedAt: row.updated_at }; }
function continuityEventFromRow(row: DbContinuityEvent): ContinuityEvent { return { sequence: row.sequence, runId: row.run_id, role: row.role, kind: row.kind, payload: parseJson(row.payload_json), digest: row.digest, authoritativeStateRevision: row.authoritative_state_revision, createdAt: row.created_at, ...(row.session_key ? { sessionKey: row.session_key } : {}), ...(row.session_ref_json ? { sessionRef: parseJson(row.session_ref_json) as ProviderSessionRefV1 } : {}) }; }
function continuityCheckpointFromRow(row: DbContinuityCheckpoint): ContinuityCheckpoint { return { checkpointId: row.checkpoint_id, runId: row.run_id, role: row.role, sequence: row.event_sequence, state: row.state, delta: parseJson(row.delta_json) as ContinuityDelta, digest: row.digest, ...(row.predecessor_digest ? { predecessorDigest: row.predecessor_digest } : {}), authoritativeStateRevision: row.authoritative_state_revision, createdAt: row.created_at, ...(row.session_key ? { sessionKey: row.session_key } : {}), ...(row.session_ref_json ? { sessionRef: parseJson(row.session_ref_json) as ProviderSessionRefV1 } : {}) }; }
function continuityHeadFromRow(row: DbContinuityHead): ContinuityHead { return { runId: row.run_id, role: row.role, state: row.state, sequence: row.event_sequence, digest: row.digest, authoritativeStateRevision: row.authoritative_state_revision, updatedAt: row.updated_at }; }
function handoffFromRow(row: DbHandoff): HandoffLineage { return { runId: row.run_id, generation: row.generation, manifestDigest: row.manifest_digest, markdownDigest: row.markdown_digest, ...(row.predecessor_session_id ? { predecessorSessionId: row.predecessor_session_id } : {}), ...(row.predecessor_session_ref_json ? { predecessorSessionRef: parseJson(row.predecessor_session_ref_json) as ProviderSessionRefV1 } : {}), ...(row.successor_session_id ? { successorSessionId: row.successor_session_id } : {}), ...(row.successor_session_ref_json ? { successorSessionRef: parseJson(row.successor_session_ref_json) as ProviderSessionRefV1 } : {}), ...(row.acceptance_receipt_digest ? { acceptanceReceiptDigest: row.acceptance_receipt_digest } : {}), state: row.state, createdAt: row.created_at, ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}) }; }
function compactionAttemptFromRow(row: DbCompactionAttempt): CompactionAttemptRecord { return { idempotencyKey: row.idempotency_key, runId: row.run_id, role: row.role, ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}), ...(row.session_key ? { sessionKey: row.session_key } : {}), ...(row.session_ref_json ? { sessionRef: parseJson(row.session_ref_json) as ProviderSessionRefV1 } : {}), crossingKey: row.crossing_key, status: row.status, ...(row.before_sample_json ? { beforeSample: parseJson(row.before_sample_json) as ContextSample } : {}), ...(row.after_sample_json ? { afterSample: parseJson(row.after_sample_json) as ContextSample } : {}), ...(row.error ? { error: row.error } : {}), createdAt: row.created_at, updatedAt: row.updated_at }; }
function qaReportV2FromRow(row: Record<string, unknown>): QaReportRecordV2 { return { reportDigest: String(row.report_digest), reportOccurrenceId: String(row.report_occurrence_id), runId: String(row.run_id), ticketId: String(row.ticket_id), reviewNumber: Number(row.review_number), sourceStateDigest: String(row.source_state_digest), reviewBasisDigest: String(row.review_basis_digest), disposition: String(row.disposition) as QaReportDisposition, report: parseJson(String(row.report_json)), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function qaRecoveryHeadFromRow(row: DbQaRecoveryHead): QaRecoveryHeadRecord { return { runId: row.run_id, ticketId: row.ticket_id, packetId: row.packet_id, packetPath: row.packet_path, packetDigest: row.packet_digest, reviewedStateDigest: row.reviewed_state_digest, revision: row.revision, correctionTurns: row.correction_turns, pendingAction: row.pending_action, updatedAt: row.updated_at }; }
function qaReviewAttemptFromRow(row: DbQaReviewAttempt): QaReviewAttemptRecord { const record = parseJson(row.record_json) as Partial<QaReviewAttemptRecord>; return { attemptId: row.attempt_id, runId: row.run_id, ticketId: row.ticket_id, reviewNumber: row.review_number, cycle: row.cycle, remediationGeneration: row.remediation_generation, sourceDigest: row.source_digest, status: row.status, ...(row.report_digest ? { reportDigest: row.report_digest } : {}), ...(record.findingIds ? { findingIds: record.findingIds } : {}), ...(record.namespacedFindingIds ? { namespacedFindingIds: record.namespacedFindingIds } : {}), ...(record.detail ? { detail: record.detail } : {}), createdAt: row.created_at, updatedAt: row.updated_at }; }
function qaRemediationAttemptFromRow(row: DbQaRemediationAttempt): QaRemediationAttemptRecord { const record = parseJson(row.record_json) as Partial<QaRemediationAttemptRecord>; return { attemptId: row.attempt_id, runId: row.run_id, ticketId: row.ticket_id, reviewAttemptId: row.review_attempt_id, generation: row.generation, mode: row.mode, status: row.status, requestDigest: row.request_digest, ...(row.response_digest ? { responseDigest: row.response_digest } : {}), ...(row.summary_digest ? { summaryDigest: row.summary_digest } : {}), ...(record.detail ? { detail: record.detail } : {}), ...(record.recoveryAttemptId ? { recoveryAttemptId: record.recoveryAttemptId } : {}), createdAt: row.created_at, updatedAt: row.updated_at }; }
function qaFailureHandoffFromRow(row: DbQaFailureHandoff): QaFailureHandoffRecord { return { handoffId: row.handoff_id, operationId: row.operation_id, runId: row.run_id, ticketId: row.ticket_id, reviewAttemptId: row.review_attempt_id, reportDigest: row.report_digest, generation: row.generation, reviewedContentDigest: row.reviewed_content_digest, reviewBasisDigest: row.review_basis_digest, state: row.state, handoffDigest: row.handoff_digest, hostInstructionDigest: row.host_instruction_digest, ...(row.builder_session_json ? { builderSession: parseJson(row.builder_session_json) as ProviderSessionRefV1 } : {}), ...(row.provider_turn_id ? { providerTurnId: row.provider_turn_id } : {}), ...(row.receipt_digest ? { receiptDigest: row.receipt_digest } : {}), ...(row.response_digest ? { responseDigest: row.response_digest } : {}), ...(row.parsed_response_digest ? { parsedResponseDigest: row.parsed_response_digest } : {}), ...(row.post_source_digest ? { postSourceDigest: row.post_source_digest } : {}), ...(row.detail ? { detail: row.detail } : {}), createdAt: row.created_at, updatedAt: row.updated_at }; }
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
function leaseVerifiedLive(lease: ProjectLease, now: Date, staleMs: number): boolean {
  void now; void staleMs;
  return classifyProcess(lease.pid, lease.processStart, lease.host).state !== "dead";
}
function ensureRecoveryGitignore(projectDir: string): void {
  const localExclude = join(projectDir, ".git", "info", "exclude");
  const path = existsSync(localExclude) ? localExclude : join(projectDir, ".gitignore");
  const entries = [WORKFLOW_DB_FILE, `${WORKFLOW_DB_FILE}-wal`, `${WORKFLOW_DB_FILE}-shm`, ".rafi/cache/handoffs/", ".rafi/backups/work-admission-v4/"];
  const existing = existsSync(path) ? readFileSync(path, "utf8") : ""; const missing = entries.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (missing.length) appendFileSync(path, `${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, "utf8");
}
