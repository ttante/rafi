import { ensureLocalGitExcludes } from "./gitExclude.js";
import { parseStrictJson, persistedProviderWireContract } from "rafi-spec";
import { verifyCheckpointOrigin, verifyContinuityHeads, type CheckpointOrigin } from "./continuityOrigin.js";
import { registerQaGraphJournalWriter, ensureQaGraphJournalGuards } from "./qaDeliveryJournal.js";
import { canonicalJson } from "./qaProtocolV2.js";
import { hydrateStructuredReceipt, persistedDispatchTuple, sealedDispatchRecord, verifyPersistedDispatch, type SealedDispatchRecordV2, type RetainedStructuredReceiptV2 } from "./structuredDispatchRecord.js";
import { assertStructuredCutoverComplete, cutoverOwnershipMatrix, invalidStructuredRun, purgeStructuredRun, STRUCTURED_CUTOVER_MATRIX_VERSION, STRUCTURED_CUTOVER_REASON, STRUCTURED_AUDIT_CLOSURE } from "./structuredCutover.js";
import { communicationFileEvidenceReferences, quarantineCommunicationFiles } from "./structuredCutoverFiles.js";
import { resolveEffectiveQaConfiguration } from "./qaEffectiveConfig.js";
import { registerGraphDerived, graphDerivedAllowed, currentGraphDerivedAccess, type GraphDerivedAccess } from "./graph/derived.js";
import { bindCoverageHostFields, validateContractCoverage } from "./qaContractCoverage.js";
import { findHostQaCheck, hostComparisonDigestFromCoverage, hostQaComparisonV1Schema } from "./hostQaComparison.js";
import { findGraphQaChecks, hostGraphApplicabilityDigestFromCoverage, hostGraphApplicabilityV1Schema } from "./hostGraphApplicability.js";
import { assembleFinalQaCoverage } from "./qaCoverageAssembly.js";
import { retainedQaCommandObservations } from "./qaReviewEvidence.js";
import { retainedHostBuilderObservations } from "./qaBuilderEvidence.js";
import { QaPreparationStore, migrateQaPreparation, migrateQaPreparationGuards } from "./qaPreparationStore.js";
import { GraphStore, migrateGraphStore } from "./graph/storage.js";
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
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { validateQaFailureReport, validateStructuredCandidate, qaVerdictOutput, remediationOutput, providerWireContracts, type QaVerdictPayload, type OperationResponse } from "rafi-spec";
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
import type { QaDeliveryTurn, QaDeliveryOutcome, QaDeliveryInvocationV3 } from "./qaDeliveryJournal.js";
import { providerSessionKey, canonicalSessionPath } from "./sessionIdentity.js";
import { captureFrozenQaSource } from "./qaSnapshot.js";
import { loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import { loadTickets } from "./tickets/ticketLoader.js";
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

/** Decision keys that embed the raw ticket scope revision, so a different revision means stale. */
function scopeRevisionKeyed(runId: string, key: string): boolean {
  const local = key.startsWith(`${runId}:`) ? key.slice(runId.length + 1) : key;
  return local.startsWith("builder:") || local.startsWith("ticket-question:");
}

export const WORKFLOW_DB_FILE = ".rafi/recovery.sqlite3";
export type WorkflowKind = "plan" | "ticket-plan" | "ticket-populate" | "uninstall" | "build" | "qa-remediation" | "recovery" | "legacy" | "operation";

/** Role steps that change no project files, so an interrupted one can run
 * again from its beginning with its original inputs. */
// QA preparation runs in a disposable snapshot, so its steps are restartable too.
const QA_PREPARATION_STEPS = ["qa-preparation-depth", "qa-preparation-draft", "qa-preparation-assessment", "qa-preparation-challenge"];
const RESTARTABLE_STEPS: Record<"builder" | "qa", ReadonlySet<string>> = {
  builder: new Set(["build-preflight", "session-initialization", "handoff-acceptance", "builder-coverage", "branch-dependency-audit", "qa-contract-acceptance", "qa-contract-segment", "status", "escalation", ...QA_PREPARATION_STEPS]),
  qa: new Set(["session-initialization", "handoff-acceptance", "qa-recovery-acceptance", "qa-contract-acceptance", "qa-contract-segment", ...QA_PREPARATION_STEPS]),
};

/** Journal runs for agent calls outside a build use these run-id prefixes. */
export const NON_BUILD_RUN_PREFIXES = ["operation:", "ticket-population:", "qa-"] as const;
export function isNonBuildRunId(runId: string): boolean {
  return NON_BUILD_RUN_PREFIXES.some(prefix => runId.startsWith(prefix));
}
function defaultRunKind(runId: string): WorkflowKind {
  return isNonBuildRunId(runId) ? "operation" : "build";
}
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
  db.pragma("busy_timeout = 5000");
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

export interface FreshRecoveryValidation {
  decisionDigest: string;
  predecessor: RoleMutationLease;
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
function partialQaRecoveryProcessProof(db: WorkflowDb, runId: string, ticketId: string, launchToken: string) {
    const run = db.getRun(runId);
    const launch = db.buildLaunch(launchToken);
    const supervisor = db.supervisorState(runId);
    if (!run || run.status !== "paused" || run.state.status !== "recoverable" || run.checkpoint !== "qa-recovery-complete"
      || !launch || launch.runId !== runId || launch.state !== "claimed" || !launch.claimant
      || !supervisor || supervisor.status !== "waiting_for_human" || supervisor.workerPid
      || launch.role !== "coordinator" || launch.claimant.pid !== supervisor.pid || launch.claimant.processStart !== supervisor.processStart
      || !["completed", "waived"].includes(db.qaTicketHead(runId, ticketId).state)
      || !((run.state.progress as { completedTickets?: string[] } | undefined)?.completedTickets?.includes(ticketId))
      || db.pendingHumanDecisions(runId).length || db.readinessProcesses(runId).length
      || db.unresolvedRoleDispatches(runId, "builder").length || db.unresolvedRoleDispatches(runId, "qa").length) return undefined;
    const events = db.events(runId);
    const exit = events.filter(event => event.type === "worker_exit").at(-1);
    const started = events.filter(event => event.type === "worker_started").at(-1);
    const exitProof = exit?.payload as { code?: number; signal?: string | null; stopRequested?: boolean; generation?: number } | undefined;
    const startProof = started?.payload as { generation?: number } | undefined;
    if (!exit || !started || exit.at < launch.createdAt || started.at < launch.createdAt
      || !exitProof || !startProof || exitProof.code !== 0 || exitProof.signal != null || exitProof.stopRequested !== false
      || exitProof.generation !== supervisor.workerGeneration || startProof.generation !== exitProof.generation) return undefined;
    const worker = started.payload as { workerPid?: number; processStart?: string; host?: string };
    if (!worker.workerPid || !worker.processStart || !worker.host) return undefined;
    return { worker: { pid: worker.workerPid, processStart: worker.processStart, host: worker.host }, claimant: launch.claimant,
      launchToken, checkpoint: run.checkpoint, supervisorGeneration: supervisor.generation,
      workerGeneration: supervisor.workerGeneration, startedAt: started.at, exitedAt: exit.at,
      startedSequence: started.sequence, exitedSequence: exit.sequence };
}

function partialQaProcessesSettled(proof: NonNullable<ReturnType<typeof partialQaRecoveryProcessProof>>): boolean {
  return classifyProcess(proof.worker.pid, proof.worker.processStart, proof.worker.host).state === "dead"
    && processGroupQuiescent(proof.worker.pid)
    && classifyProcess(proof.claimant.pid, proof.claimant.processStart, proof.claimant.host).state === "dead";
}

export class WorkflowDb {
  readonly path: string;
  private readonly db: Database.Database;
  private writerAuthority?: BuildAdmission;
  private writerLease?: ProjectLease;
  private coordinatorTransition = 0;
  private lineageTransition = 0;
  private workAuthority = 0;
  private readonly createdRecoveryIntents = new Set<string>();

  constructor(readonly projectDir: string, path = join(resolve(projectDir), WORKFLOW_DB_FILE), private readonly readinessAccess?: { probeId: string } | { runId: string }) {
    this.path = path;
    if (existsSync(path)) {
      const preview = new Database(path, { readonly: true, fileMustExist: true });
      try { if (readinessAccess) assertStructuredCutoverComplete(preview); checkBuildOwnershipSchema(preview); } finally { preview.close(); }
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
    registerQaGraphJournalWriter(this.db);
    if (!readinessAccess) this.db.pragma("journal_mode = WAL");
    // Short-lived coordinator/worker writes can overlap with a heartbeat or
    // another durable transition. Let SQLite wait for the owning transaction
    // instead of immediately surfacing SQLITE_BUSY to the supervisor.
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    try {
      if (readinessAccess) { assertStructuredCutoverComplete(this.db); this.restrictReadinessConnection(readinessAccess); }
      else { this.migrate(); this.applyStructuredCommunicationV2Cutover(); migrateQaPreparation(this.db); migrateBuildAdmission(this.db); this.importLegacyOnce(); migrateBuildWork(this.db, projectDir); migrateBuildInterventions(this.db); migrateQaPreparationGuards(this.db); }
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
  qaPreparationStore(): QaPreparationStore { return new QaPreparationStore(this.db, runId => this.assertInstructionOwner(runId), this.projectDir); }
  graphStore(): GraphStore { migrateGraphStore(this.db); return new GraphStore(this.db); }
  admitWork(input: AdmitWorkInput) {
    this.assertInstructionOwner(input.runId);
    this.workAuthority++;
    try {
      const result = admitWork(this.db, input);
      this.qaPreparationStore().metric(input.runId, result.workId, result.requirementsDigest, `metric:approved:${input.runId}:${result.workId}:${result.requirementsDigest}`, "approved");
      return result;
    } finally { this.workAuthority--; }
  }
  private assertInstructionOwner(runId: string): void {
    this.assertNativeRunAdmission(runId);
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
  verifyBuilderGuidance(ids:string[],certificate:Parameters<typeof verifyBuilderGuidance>[2],response:string | readonly string[],receiptDigest:string) {for(const id of ids)this.assertInstructionOwner(instruction(this.db,id)!.request.runId);return this.atomic(()=>verifyBuilderGuidance(this.db,ids,certificate,response,receiptDigest));}
  verifyGuidance(ids: string[], certificate: Parameters<typeof verifyGuidance>[2], response: string | readonly string[]) { for(const id of ids)this.assertInstructionOwner(instruction(this.db,id)!.request.runId); return this.atomic(()=>verifyGuidance(this.db,ids,certificate,response)); }
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
    const admission = this.assertAdmittedWork(runId,workId);
    this.qaPreparationStore().metric(runId, workId, admission.requirementsDigest, `metric:started:${runId}:${workId}:${admission.requirementsDigest}`, "implementation-started");
    this.workAuthority++;
    try { this.db.prepare("INSERT INTO build_assignments VALUES(?,?,?,?,?)").run(operationId,runId,workId,operationId,json(record)); } finally {this.workAuthority--;}
  }
  admittedWork(runId: string, workId: string) { return admittedWork(this.db, runId, workId); }
  assertAdmittedWork(runId: string, workId: string) { this.assertNativeRunAdmission(runId); return assertAdmittedWork(this.db, runId, workId); }

  /** Atomic local changes only; never await provider or filesystem work here. */
  atomic<T>(work: () => T): T { return this.db.transaction(work).immediate(); }

  buildAdmission(): BuildAdmission | undefined { return readAdmission(this.db); }
  /** Short synchronous tracker mutations share the build fence without retiring
   * provider receipts or granting authority to resume implementation. */
  withTrackerMutationAuthority<T>(work: () => T): T {
    if (this.writerAuthority) { this.assertBuildAdmission(this.writerAuthority); return work(); }
    let authority: BuildAdmission | undefined;
    let lease: ProjectLease | undefined;
    let intent: WorkflowRunSnapshot | undefined;
    try {
      const prior = this.buildAdmission();
      if (prior) {
        authority = this.acquireBuildRecoveryAdmission(prior.runId);
        lease = this.acquireLease(prior.runId);
      } else {
        this.atomic(() => {
          this.assertNoLegacyBuildOwner();
          for (const owner of this.runningSupervisors()) {
            if (owner.state.pid && classifyProcess(owner.state.pid, owner.state.processStart).state !== "dead") throw new Error("A live or unverified supervisor must stop before tracker reset");
          }
          for (const row of this.db.prepare("SELECT DISTINCT run_id FROM build_owned_processes WHERE state<>'quiescent'").all() as Array<{run_id:string}>) {
            if (this.unresolvedPreparationProcesses(row.run_id).length) throw new Error("Owned preparation descendants require reconciliation before tracker reset");
          }
          intent = this.createRun({ kind: "recovery", checkpoint: "tracker-mutation-intent", state: { operation: "tracker-mutation" } });
          lease = this.acquireLease(intent.runId);
          authority = this.admitLeasedBuild(lease);
        });
      }
      const result = work();
      if (intent) this.transition(intent.runId, { status: "completed", checkpoint: "tracker-mutation-completed" });
      return result;
    } catch (error) {
      if (intent && this.getRun(intent.runId) && authority && this.buildAdmission()?.token === authority.token) {
        this.transition(intent.runId, { status: "failed", checkpoint: "tracker-mutation-failed", payload: { error: error instanceof Error ? error.message : String(error) } });
      }
      throw error;
    } finally {
      try {
        if (lease) {
          this.releaseLease(lease);
          // Acquisition can have been rolled back by the outer transaction.
          // Drop only this invocation's cached token, never a replacement owner.
          if (this.currentLease()?.owner !== lease.owner) forgetOriginalLease(this.projectDir, lease);
        }
      } finally {
        if (authority && this.buildAdmission()?.token === authority.token) this.releaseBuildAdmission(authority);
        else if (authority) {
          forgetBuildAuthority(authority);
          if ((this.writerAuthority as BuildAdmission | undefined)?.token === authority.token) this.writerAuthority = undefined;
        }
      }
    }
  }
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
    this.assertNativeRunAdmission(runId);
    return this.atomic(() => {
      this.assertNoLegacyBuildOwner();
      const lease = this.currentLease();
      if (lease && classifyProcess(lease.pid, lease.processStart, lease.host).state !== "dead") throw new Error(`project workflow lease is held by ${lease.owner} for run ${lease.runId}`);
      for (const owner of this.runningSupervisors()) {
        if (owner.state.pid && classifyProcess(owner.state.pid, owner.state.processStart).state !== "dead") throw new Error(`supervisor already active for project (run ${owner.runId})`);
      }
      // Single agent calls outside builds ("operation:<id>" runs: planning,
      // ticket population, uninstall proposals) are read-only proposals; an
      // unknown outcome there cannot conflict with a build.
      const uncertain = this.db.prepare("SELECT run_id FROM operation_journal WHERE kind='provider-dispatch' AND status IN ('in_progress','uncertain') AND run_id NOT LIKE 'operation:%' AND run_id NOT LIKE 'ticket-population:%' AND run_id NOT LIKE 'qa-%' LIMIT 1").get() as {run_id:string}|undefined;
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
    this.assertNativeRunAdmission(runId);
    return this.atomic(() => {
      this.assertExecutionProtocol();
      this.assertNoLegacyBuildOwner();
      const otherDispatch = this.db.prepare("SELECT run_id FROM operation_journal WHERE run_id<>? AND kind='provider-dispatch' AND status IN ('in_progress','uncertain') AND run_id NOT LIKE 'operation:%' AND run_id NOT LIKE 'ticket-population:%' AND run_id NOT LIKE 'qa-%' LIMIT 1").get(runId) as {run_id:string}|undefined;
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

  /** A supervisor's waiting exit may represent a successful partial QA boundary.
   * Require this launch's clean worker exit and verified cleanup, never just QA. */
  successfulPartialQaRecovery(runId: string, ticketId: string, launchToken: string): boolean {
    const proof = partialQaRecoveryProcessProof(this, runId, ticketId, launchToken);
    return Boolean(proof && partialQaProcessesSettled(proof));
  }

  async waitForSuccessfulPartialQaRecovery(runId: string, ticketId: string, launchToken: string): Promise<boolean> {
    // Clean exits can precede native descendant/inventory settlement. Recheck
    // only an already validated exact boundary; never kill or relax ownership.
    const initial = partialQaRecoveryProcessProof(this, runId, ticketId, launchToken);
    if (!initial || process.platform === "win32") return false;
    const deadline = Date.now() + 3000;
    do {
      const proof = partialQaRecoveryProcessProof(this, runId, ticketId, launchToken);
      if (!proof || JSON.stringify(proof) !== JSON.stringify(initial)) return false;
      if (partialQaProcessesSettled(proof)) return true;
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return false;
  }

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
  ensureRun(runId: string, kind: WorkflowKind = defaultRunKind(runId), now = new Date()): WorkflowRunSnapshot {
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
    if (run.legacy) {
      run.status = "superseded";
      run.checkpoint = STRUCTURED_CUTOVER_REASON;
      run.state = { ...run.state, structuredCommunicationCutover: { version: 2, reason: STRUCTURED_CUTOVER_REASON, at } };
    }
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
    if (run.kind === "recovery") this.createdRecoveryIntents.add(run.runId);
    return run;
  }

  /** Record failure of an intent this connection just created, before recovery
   * authority was acquired. This cannot write build execution or publications. */
  pauseOwnStartOverIntent(runId: string, error: unknown): void {
    const run = this.getRun(runId);
    if (!this.createdRecoveryIntents.has(runId) || run?.kind !== "recovery" || run.state.operation !== "build-start-over"
      || run.checkpoint !== "start-over-inventory" || run.state.gitPreserved || this.operations(runId).length
      || this.incompletePublications().some(publication => publication.runId === runId)) throw new Error("Recovery intent is outside this connection's unstarted setup scope");
    this.coordinatorTransition++;
    try { this.transition(runId, { status: "paused", checkpoint: "start-over-setup-paused", state: { ...run.state, error: error instanceof Error ? error.message : String(error) } }); }
    finally { this.coordinatorTransition--; }
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
    this.assertNativeRunAdmission(runId);
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

  settingsAdoptionState(runId: string, role: "builder" | "qa"): "active" | "deferred" | "unknown" {
    const admission = this.buildAdmission();
    const lease = this.currentLease();
    const owner = admission?.runId === runId ? admission : lease?.runId === runId ? lease : undefined;
    if (!owner) return "deferred";
    const liveness = classifyProcess(owner.pid, owner.processStart, owner.host).state;
    if (liveness === "unknown") return "unknown";
    if (liveness !== "live" || this.getRun(runId)?.status !== "running" || this.pendingHumanDecisions(runId).length) return "deferred";
    // Historical role/session records are not proof of an active role. A
    // submitted turn can adopt saved settings at its next safe boundary.
    return this.unresolvedRoleDispatches(runId, role).some(operation => operation.status === "in_progress") ? "active" : "deferred";
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
    const graphAccess = currentGraphDerivedAccess();
    if (graphAccess) registerGraphDerived(this.db, json(safePayload), graphAccess);
    const session = sessionParts(input.sessionRef, undefined, input.sessionKey);
    const digest = digestJson({ runId: input.runId, role: input.role, kind: input.kind, payload: safePayload, authoritativeStateRevision: input.authoritativeStateRevision, sessionKey: session.key, at });
    const result = this.db.prepare(`INSERT INTO continuity_events(run_id,role,kind,payload_json,digest,authoritative_state_revision,session_key,session_ref_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(input.runId, input.role, input.kind, json(safePayload), digest, input.authoritativeStateRevision, session.key, session.refJson, at);
    return { sequence: Number(result.lastInsertRowid), runId: input.runId, role: input.role, kind: input.kind, payload: safePayload, digest, authoritativeStateRevision: input.authoritativeStateRevision, createdAt: at, ...(session.key ? { sessionKey: session.key } : {}), ...(session.ref ? { sessionRef: session.ref } : {}) };
  }

  continuityEvents(runId: string, afterSequence = 0): ContinuityEvent[] {
    const rows = this.db.prepare("SELECT * FROM continuity_events WHERE run_id=? AND sequence>? ORDER BY sequence").all(runId, afterSequence) as DbContinuityEvent[];
    for (const row of rows) this.assertGraphContinuityAccess(row.payload_json);
    return rows.map(continuityEventFromRow);
  }

  providerCheckpoint(dispatchId: string, publicationKind: string): ContinuityCheckpoint | undefined {
    const row = this.db.prepare("SELECT c.* FROM continuity_checkpoints c JOIN continuity_checkpoint_origins o USING(checkpoint_id) WHERE o.dispatch_id=? AND o.publication_kind=?").get(dispatchId, publicationKind) as DbContinuityCheckpoint | undefined;
    if (row) verifyCheckpointOrigin(this.db, this.projectDir, row.checkpoint_id);
    return row ? continuityCheckpointFromRow(row) : undefined;
  }

  publishContinuityCheckpoint(input: {
    runId: string;
    role: "builder" | "qa";
    delta: ContinuityDelta;
    state?: ContinuityHeadState;
    authoritativeStateRevision: number;
    sessionRef?: ProviderSessionRefV1;
    sessionKey?: string;
    origin?: CheckpointOrigin;
    hostEventKind?: "role-baseline" | "operator-recovery" | "source-reconciliation";
    inputCheckpointDigests?: string[];
  }, now = new Date()): ContinuityCheckpoint {
    this.ensureRun(input.runId, "build", now);
    return this.db.transaction(() => {
      const at = now.toISOString();
      if (input.origin?.kind === "provider") {
        const prior = this.db.prepare("SELECT c.* FROM continuity_checkpoints c JOIN continuity_checkpoint_origins o USING(checkpoint_id) WHERE c.run_id=? AND c.role=? AND o.dispatch_id=? AND o.publication_kind=?")
          .get(input.runId, input.role, input.origin.dispatchId, input.origin.publicationKind) as DbContinuityCheckpoint | undefined;
        if (prior) {
          verifyCheckpointOrigin(this.db, this.projectDir, prior.checkpoint_id);
          if (canonicalJson(parseJson(prior.delta_json)) !== canonicalJson(input.delta)) throw new Error("Conflicting repeated checkpoint publication");
          return continuityCheckpointFromRow(prior);
        }
      }
      const previous = this.continuityHead(input.runId, input.role);
      let origin = input.origin;
      if (!origin) {
        const event = this.appendContinuityEvent({ runId: input.runId, role: "host", kind: input.hostEventKind ?? "host_checkpoint", authoritativeStateRevision: input.authoritativeStateRevision,
          payload: { checkpointDeltaDigest: createHash("sha256").update(json(sanitizeContinuityValue(input.delta))).digest("hex"), role: input.role } });
        origin = { kind: "host", eventSequence: event.sequence, inputCheckpointDigests: input.inputCheckpointDigests ?? (previous ? [previous.digest] : []) };
      }
      const latestEvent = this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM continuity_events WHERE run_id=?").get(input.runId) as { sequence: number };
      const safeDelta = sanitizeContinuityValue(input.delta) as unknown as ContinuityDelta;
      const graphAccess = currentGraphDerivedAccess();
      if (graphAccess) registerGraphDerived(this.db, json(safeDelta), graphAccess);
      const session = sessionParts(input.sessionRef, undefined, input.sessionKey);
      const digest = digestJson({ runId: input.runId, role: input.role, sequence: latestEvent.sequence, predecessorDigest: previous?.digest, delta: safeDelta, authoritativeStateRevision: input.authoritativeStateRevision, sessionKey: session.key });
      const result = this.db.prepare(`INSERT INTO continuity_checkpoints(run_id,role,event_sequence,state,delta_json,digest,predecessor_digest,authoritative_state_revision,session_key,session_ref_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(input.runId, input.role, latestEvent.sequence, input.state ?? "current", json(safeDelta), digest, previous?.digest ?? null, input.authoritativeStateRevision, session.key, session.refJson, at);
      const checkpointId = Number(result.lastInsertRowid);
      this.db.prepare("INSERT INTO continuity_checkpoint_origins(checkpoint_id,run_id,origin_json,delta_digest,dispatch_id,publication_kind) VALUES(?,?,?,?,?,?)")
        .run(checkpointId, input.runId, json(origin), createHash("sha256").update(json(safeDelta)).digest("hex"), origin.kind === "provider" ? origin.dispatchId : null, origin.kind === "provider" ? origin.publicationKind : null);
      verifyCheckpointOrigin(this.db, this.projectDir, checkpointId);
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
    }).immediate();
  }

  continuityCheckpoints(runId: string, role?: "builder" | "qa"): ContinuityCheckpoint[] {
    const rows = role
      ? this.db.prepare("SELECT * FROM continuity_checkpoints WHERE run_id=? AND role=? ORDER BY checkpoint_id").all(runId, role)
      : this.db.prepare("SELECT * FROM continuity_checkpoints WHERE run_id=? ORDER BY checkpoint_id").all(runId);
    for (const row of rows as DbContinuityCheckpoint[]) { this.assertGraphContinuityAccess(row.delta_json); verifyCheckpointOrigin(this.db, this.projectDir, row.checkpoint_id); }
    return (rows as DbContinuityCheckpoint[]).map(continuityCheckpointFromRow);
  }

  latestContinuityCheckpoint(runId: string, role: "builder" | "qa"): ContinuityCheckpoint | undefined {
    const row = this.db.prepare("SELECT * FROM continuity_checkpoints WHERE run_id=? AND role=? ORDER BY checkpoint_id DESC LIMIT 1").get(runId, role) as DbContinuityCheckpoint | undefined;
    if (row) { this.assertGraphContinuityAccess(row.delta_json); verifyCheckpointOrigin(this.db, this.projectDir, row.checkpoint_id); }
    return row ? continuityCheckpointFromRow(row) : undefined;
  }

  private assertGraphContinuityAccess(value: string): void {
    const digest = createHash("sha256").update(value).digest("hex");
    if (!graphDerivedAllowed(this.db, this.projectDir, digest))
      throw new Error("Continuity contains revoked graph-derived evidence; explicit source-based recovery is required");
  }

  continuityHead(runId: string, role: "builder" | "qa" | "run"): ContinuityHead | undefined {
    const row = this.db.prepare("SELECT * FROM continuity_heads WHERE run_id=? AND role=?").get(runId, role) as DbContinuityHead | undefined;
    if (row) verifyContinuityHeads(this.db, this.projectDir, runId);
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

  /** Answered decisions for a run, oldest first (e.g. answered with build:decide while no worker waited). */
  answeredHumanDecisions(runId: string): PendingHumanDecision[] {
    return (this.db.prepare("SELECT decision_json FROM human_decisions WHERE run_id=? AND status='answered' ORDER BY created_at").all(runId) as Array<{ decision_json: string }>)
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
      // Only builder and ticket-question keys carry the raw scope revision. Others (such as QA
      // nonconvergence) bind scope through their own hash, so a missing revision doesn't mean stale.
      .filter(row => scopeRevisionKeyed(runId, row.decision_key) && !row.decision_key.includes(`:${scopeRevision}:`))
      .map(row => parseJson(row.decision_json) as PendingHumanDecision)
      .filter(decision => decision.interruptionId.startsWith("ticket:") && this.decisionContinuationAvailable(runId, decision.decisionId) && !this.operation(`decision-supersession:${decision.decisionId}`));
  }

  refreshStaleTicketDecisions(runId: string, scopeRevision: string, tickets?: readonly string[]): void {
    this.atomic(() => {
      for (const prior of this.pendingHumanDecisions(runId)) {
        const key = this.humanDecisionKey(prior.decisionId) ?? "";
        if (!prior.interruptionId.startsWith("ticket:") || tickets && !tickets.includes(prior.interruptionId.slice(7)) || key.includes(`:${scopeRevision}:`) || !scopeRevisionKeyed(runId, key)) continue;
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
    this.assertNativeRunAdmission(input.runId);
    const at = now.toISOString();
    const run = this.getRun(input.runId);
    if (input.kind === "provider-dispatch" && run?.checkpoint === "structured-communication-v2-cutover") {
      throw new Error("This run was fenced by the structured-communication v2 cutover; start a new native dispatch");
    }
    if (input.kind === "provider-dispatch" && this.unresolvedPreparationProcesses(input.runId).length) throw new Error("Readiness cleanup must be reconciled before provider dispatch");
    this.db.prepare(`INSERT INTO operation_journal(idempotency_key,run_id,kind,status,intent_json,created_at,updated_at)
      VALUES(?,?,?,'planned',?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`).run(input.idempotencyKey, input.runId, input.kind, json(input.intent), at, at);
    const operation = this.operation(input.idempotencyKey)!;
    if (operation.runId !== input.runId || operation.kind !== input.kind || json(operation.intent) !== json(input.intent)) {
      throw new Error(`operation idempotency collision: ${input.idempotencyKey}`);
    }
    return operation;
  }

  /** Seal a previously persisted non-authoritative preparation intent.  This
   * is intentionally legal only before provider content dispatch begins. */
  sealPlannedOperationIntent(idempotencyKey: string, intent: unknown, now = new Date()): OperationRecord {
    const prior = this.operation(idempotencyKey);
    if (!prior || prior.status !== "planned" || prior.kind !== "provider-dispatch") throw new Error("Only a planned provider dispatch may be sealed");
    const preparing = prior.intent as { protocolVersion?: unknown; state?: unknown };
    if (preparing.protocolVersion !== 2 || preparing.state !== "preparing") throw new Error("Provider dispatch did not begin as a v2 preparation intent");
    this.db.prepare("UPDATE operation_journal SET intent_json=?,updated_at=? WHERE idempotency_key=? AND status='planned'")
      .run(json(intent), now.toISOString(), idempotencyKey);
    return this.operation(idempotencyKey)!;
  }

  /** Called in the gateway's sealing transaction, before the send capability exists. */
  sealStructuredOwnerDispatch(key: string, tuple: import("rafi-spec").SelectedDispatchTupleV2, renderedInstruction: string): void {
    const sealedDispatch = sealedDispatchRecord(tuple);
    const transportSession = (this.operation(key)?.intent as { sessionRef?: ProviderSessionRefV1 } | undefined)?.sessionRef;
    const matchesSession = (session: Pick<ProviderSessionRefV1, "provider" | "sessionId" | "role" | "stream" | "generation" | "cwd" | "configRoot">): boolean => Boolean(transportSession
      && (["provider", "sessionId", "role", "stream", "generation", "cwd", "configRoot"] as const).every(field => session[field] === transportSession[field]));
    const review = this.db.prepare("SELECT intent_json,status FROM qa_turns WHERE operation_id=?").get(key) as { intent_json: string; status: string } | undefined;
    if (review) {
      const intent = parseJson(review.intent_json) as QaTurnIntentV2;
      if (review.status !== "intended" || intent.sealedDispatch || !matchesSession(intent.providerSession) || intent.providerSession.sessionId !== tuple.sessionId || intent.providerSession.generation !== tuple.generation)
        throw new Error("QA review owner cannot seal a foreign or already dispatched session");
      this.db.prepare("UPDATE qa_turns SET intent_json=? WHERE operation_id=?").run(json({ ...intent, sealedDispatch }), key);
    }
    const delivery = this.db.prepare("SELECT record_json,status FROM qa_delivery_turns WHERE turn_record_id=?").get(key) as { record_json: string; status: string } | undefined;
    if (delivery) {
      const turn = parseJson(delivery.record_json) as QaDeliveryTurn;
      if (delivery.status !== "intended" || turn.sealedDispatch || !matchesSession(turn.intendedSession) || turn.intendedSession.sessionId !== tuple.sessionId || turn.intendedSession.generation !== tuple.generation)
        throw new Error("QA remediation owner cannot seal a foreign or already dispatched session");
      this.db.prepare("UPDATE qa_delivery_turns SET record_json=? WHERE turn_record_id=?").run(json({ ...turn, sealedDispatch }), key);
      const attempt = this.db.prepare("SELECT record_json FROM qa_remediation_attempts WHERE attempt_id=?").get(turn.operationId) as { record_json: string } | undefined;
      if (!attempt) throw new Error("Remediation dispatch has no durable owner attempt");
      const fields = parseJson(attempt.record_json) as Record<string, unknown>;
      const dispatches = (fields.sealedDispatches ?? {}) as Record<string, SealedDispatchRecordV2>;
      if (dispatches[key]) throw new Error("Remediation dispatch already sealed");
      this.db.prepare("UPDATE qa_remediation_attempts SET record_json=? WHERE attempt_id=?").run(json({ ...fields, sealedDispatches: { ...dispatches, [key]: sealedDispatch } }), turn.operationId);
    }
    this.putEvidence("handoff", Buffer.from(renderedInstruction));
  }

  structuredOwnerDispatch(key: string): SealedDispatchRecordV2 {
    const transport = this.operation(key)?.intent as { sealedDispatch?: SealedDispatchRecordV2 } | undefined;
    const verifyOwner = (record: SealedDispatchRecordV2): void => {
      persistedDispatchTuple(record);
      if (json(transport?.sealedDispatch) !== json(record)) throw new Error("Domain owner tuple differs from its transport intent");
    };
    const review = this.db.prepare("SELECT intent_json FROM qa_turns WHERE operation_id=?").get(key) as { intent_json: string } | undefined;
    if (review) {
      const record = (parseJson(review.intent_json) as QaTurnIntentV2).sealedDispatch;
      if (!record) throw new Error("QA owner has no sealed dispatch");
      verifyOwner(record);
      return record;
    }
    const delivery = this.db.prepare("SELECT record_json FROM qa_delivery_turns WHERE turn_record_id=?").get(key) as { record_json: string } | undefined;
    if (delivery) {
      const turn = parseJson(delivery.record_json) as QaDeliveryTurn;
      const record = turn.sealedDispatch;
      if (!record) throw new Error("Remediation owner has no sealed dispatch");
      verifyOwner(record);
      const attempt = this.db.prepare("SELECT record_json FROM qa_remediation_attempts WHERE attempt_id=?").get(turn.operationId) as { record_json: string } | undefined;
      const sealed = attempt && (parseJson(attempt.record_json) as { sealedDispatches?: Record<string, SealedDispatchRecordV2> }).sealedDispatches?.[key];
      if (json(sealed) !== json(record)) throw new Error("Remediation attempt tuple differs from its delivery intent");
      return record;
    }
    const intent = this.operation(key)?.intent as { tuple?: import("rafi-spec").SelectedDispatchTupleV2; sealedDispatch?: SealedDispatchRecordV2 } | undefined;
    if (!intent?.sealedDispatch) throw new Error("Generic owner has no sealed dispatch");
    persistedDispatchTuple(intent.sealedDispatch);
    if (canonicalJson(intent.tuple) !== intent.sealedDispatch.tupleJson) throw new Error("Generic intent tuple differs from its sealed canonical bytes");
    return intent.sealedDispatch;
  }

  assertStructuredDispatchAdmission(runId: string, dispatchId: string, parentId: string | undefined, operation: string): void {
    const processing = this.pendingStructuredPostprocessing(runId);
    const transfers = this.db.prepare("SELECT * FROM structured_handoff_lineage WHERE run_id=? AND state<>'completed'").all(runId) as Array<Record<string, any>>;
    const linked = transfers.length === 1 && transfers[0]!.predecessor_id === parentId &&
      (operation === "handoff-acceptance" && transfers[0]!.state === "acceptance-pending" && !transfers[0]!.acceptance_id ||
       transfers[0]!.state === "continuation-planned" && transfers[0]!.continuation_id === dispatchId);
    if (processing.some(id => id !== parentId) || (processing.length || transfers.length) && !linked)
      throw new Error("Confirmed dispatch postprocessing or handoff is pending; reconcile before unrelated work");
  }
  beginStructuredHandoff(predecessorId: string): void {
    const operation = this.operation(predecessorId);
    if (!operation || operation.status !== "confirmed") throw new Error("Handoff predecessor must be confirmed");
    const changed = this.db.prepare("INSERT OR IGNORE INTO structured_handoff_lineage(predecessor_id,run_id,state) VALUES(?,?,'acceptance-pending')").run(predecessorId, operation.runId);
    if (changed.changes !== 1) throw new Error("Handoff acceptance already started; reconcile persisted lineage before recovery");
  }
  linkStructuredHandoffDispatch(dispatchId: string, parentId: string | undefined, operation: string): void {
    if (!parentId) return;
    const row = this.db.prepare("SELECT * FROM structured_handoff_lineage WHERE predecessor_id=?").get(parentId) as Record<string, any> | undefined;
    if (!row) return;
    if (operation === "handoff-acceptance") {
      if (row.state !== "acceptance-pending" || row.acceptance_id) throw new Error("Handoff acceptance already dispatched");
      this.db.prepare("UPDATE structured_handoff_lineage SET acceptance_id=? WHERE predecessor_id=?").run(dispatchId, parentId);
    } else if (row.state !== "continuation-planned" || row.continuation_id !== dispatchId) throw new Error("Foreign handoff continuation");
  }
  planStructuredContinuation(predecessorId: string, successor: ProviderSessionRefV1): string {
    return this.atomic(() => {
      const row = this.db.prepare("SELECT * FROM structured_handoff_lineage WHERE predecessor_id=?").get(predecessorId) as Record<string, any> | undefined;
      if (!row || row.state !== "acceptance-pending" || !row.acceptance_id || this.operation(row.acceptance_id)?.status !== "confirmed") throw new Error("Successor lacks confirmed native handoff acceptance lineage");
      const origin = this.db.prepare("SELECT checkpoint_id FROM continuity_checkpoint_origins WHERE dispatch_id=? AND publication_kind='handoff_acceptance'").get(row.acceptance_id) as {checkpoint_id:number}|undefined;
      if (!origin) throw new Error("Successor acceptance checkpoint is missing");
      verifyCheckpointOrigin(this.db, this.projectDir, origin.checkpoint_id);
      this.assertAcceptedStructuredSuccessor(row.run_id, origin.checkpoint_id, successor);
      const accepted = this.retainedStructuredTurn(row.acceptance_id).selectedDispatch!;
      if (accepted.sessionId !== successor.sessionId || accepted.provider !== successor.provider) throw new Error("Successor differs from the accepted provider session");
      const continuationId = randomUUID();
      this.db.prepare("UPDATE structured_handoff_lineage SET state='continuation-planned',successor_json=?,continuation_id=? WHERE predecessor_id=?")
        .run(json(successor), continuationId, predecessorId);
      return continuationId;
    });
  }
  structuredContinuation(runId: string, role: "builder" | "qa"): {predecessorId:string;continuationId:string;state:string;successor:ProviderSessionRefV1} | undefined {
    const row = this.db.prepare("SELECT * FROM structured_handoff_lineage WHERE run_id=? AND successor_json IS NOT NULL AND json_extract(successor_json,'$.role')=? ORDER BY rowid DESC LIMIT 1").get(runId,role) as Record<string,any>|undefined;
    if (!row) return;
    const origin = this.db.prepare("SELECT checkpoint_id FROM continuity_checkpoint_origins WHERE dispatch_id=? AND publication_kind='handoff_acceptance'").get(row.acceptance_id) as {checkpoint_id:number}|undefined;
    if (!origin) throw new Error("Handoff continuation lacks its accepted checkpoint");
    verifyCheckpointOrigin(this.db,this.projectDir,origin.checkpoint_id);
    this.assertAcceptedStructuredSuccessor(runId, origin.checkpoint_id, parseJson(row.successor_json) as ProviderSessionRefV1);
    return {predecessorId:row.predecessor_id,continuationId:row.continuation_id,state:row.state,successor:parseJson(row.successor_json) as ProviderSessionRefV1};
  }

  finishStructuredContinuation(dispatchId: string): void {
    if (this.operation(dispatchId)?.status !== "confirmed") throw new Error("Unconfirmed continuation cannot complete");
    this.db.prepare("UPDATE structured_handoff_lineage SET state='completed' WHERE continuation_id=?").run(dispatchId);
  }

  private assertAcceptedStructuredSuccessor(runId: string, checkpointId: number, successor: ProviderSessionRefV1): void {
    const handoff = this.db.prepare("SELECT acceptance_receipt_digest FROM handoffs WHERE run_id=? AND successor_session_key=? AND state='accepted'")
      .get(runId, providerSessionKey(successor)) as {acceptance_receipt_digest:string}|undefined;
    const checkpoint = this.db.prepare("SELECT digest FROM continuity_checkpoints WHERE checkpoint_id=? AND run_id=?").get(checkpointId, runId) as {digest:string}|undefined;
    const bytes = handoff?.acceptance_receipt_digest && this.getEvidence(handoff.acceptance_receipt_digest);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== handoff!.acceptance_receipt_digest) throw new Error("Successor lacks retained accepted ownership evidence");
    const receipt = parseJson(bytes.toString()) as HandoffAcceptanceReceiptV1;
    if (receipt.runId !== runId || receipt.acceptanceCheckpointDigest !== checkpoint?.digest
      || providerSessionKey(receipt.successorSessionRef) !== providerSessionKey(successor)) throw new Error("Successor ownership differs from accepted checkpoint lineage");
  }

  requireStructuredPostprocessing(dispatchId: string, context: unknown): void {
    const operation = this.operation(dispatchId)!;
    this.db.prepare("INSERT INTO structured_dispatch_processing(dispatch_id,run_id,state,context_json) VALUES(?,?,'pending',?)")
      .run(dispatchId, operation.runId, json(context));
  }
  structuredProcessingContext(dispatchId: string): { instruction: string; policy: import("./adapters/types.js").TurnRequest } {
    const row = this.db.prepare("SELECT context_json FROM structured_dispatch_processing WHERE dispatch_id=?").get(dispatchId) as { context_json: string } | undefined;
    if (!row) throw new Error("Missing persisted post-confirmation intent");
    return parseJson(row.context_json) as { instruction: string; policy: import("./adapters/types.js").TurnRequest };
  }
  failStructuredPostprocessing(dispatchId: string, error: string): void {
    this.db.prepare("UPDATE structured_dispatch_processing SET error=? WHERE dispatch_id=?").run(error.slice(0,4000), dispatchId);
  }
  completeStructuredPostprocessing(dispatchId: string): void {
    if (this.operation(dispatchId)?.status !== "confirmed") throw new Error("Cannot process an unconfirmed dispatch");
    this.db.prepare("UPDATE structured_dispatch_processing SET state='completed',error=NULL WHERE dispatch_id=?").run(dispatchId);
  }
  pendingStructuredPostprocessing(runId: string): string[] {
    return (this.db.prepare("SELECT dispatch_id FROM structured_dispatch_processing WHERE run_id=? AND state='pending'").all(runId) as Array<{dispatch_id:string}>).map(row => row.dispatch_id);
  }
  retainedStructuredTurn(dispatchId: string): import("./adapters/types.js").TurnResult {
    const owner = this.structuredOwnerDispatch(dispatchId), tuple = persistedDispatchTuple(owner);
    const descriptor = persistedProviderWireContract(tuple);
    if (!descriptor) throw new Error("Missing historic dispatch descriptor");
    this.replayStructuredDispatch(dispatchId, descriptor.canonical);
    const result = this.operation(dispatchId)!.result as {responseDigest: string;rawDigest?:string};
    const retained = JSON.parse(this.getEvidence(result.responseDigest)!.toString()) as RetainedStructuredReceiptV2;
    return { text: result.rawDigest ? this.getEvidence(result.rawDigest)?.toString() ?? "" : "", isError: false, numTurns: 1, costUsd: 0,
      turnId: retained.hostTurnId, selectedDispatch: tuple, structured: hydrateStructuredReceipt(retained, digest => this.getEvidence(digest)) ?? undefined };
  }

  /** A claim is never recycled, even if transport fails before writing bytes. */
  claimStructuredSubmission(tuple: import("rafi-spec").SelectedDispatchTupleV2, session?: ProviderSessionRefV1): string {
    return this.atomic(() => {
      const operation = this.operation(tuple.dispatchId);
      if (!operation || operation.status !== "in_progress" || this.structuredOwnerDispatch(tuple.dispatchId).tupleJson !== canonicalJson(tuple))
        throw new Error("Cannot mint a send capability without a committed sealed owner intent");
      this.assertNativeRunAdmission(operation.runId);
      const frozen = (operation.intent as { sessionRef: ProviderSessionRefV1 }).sessionRef;
      if (!session || canonicalJson(frozen) !== canonicalJson(session)) throw new Error("Submission claim requires the frozen provider session");
      const continuation = this.db.prepare("SELECT successor_json FROM structured_handoff_lineage WHERE continuation_id=? AND state='continuation-planned'").get(tuple.dispatchId) as {successor_json:string}|undefined;
      if (continuation && canonicalJson(parseJson(continuation.successor_json)) !== canonicalJson(session)) throw new Error("Continuation session differs from accepted lineage");
      const claimId = randomUUID();
      const changed = this.db.prepare(`INSERT OR IGNORE INTO structured_submission_claims(dispatch_id,run_id,tuple_digest,claim_id,session_json,state,created_at)
        VALUES(?,?,?,?,?,'claimed',?)`).run(tuple.dispatchId, operation.runId, tuple.digest, claimId, canonicalJson(session), new Date().toISOString());
      if (changed.changes !== 1) throw new Error("Structured dispatch already has a submission claim; reconcile before a new dispatch");
      this.db.prepare("UPDATE structured_handoff_lineage SET state='continuation-claimed' WHERE continuation_id=?").run(tuple.dispatchId);
      return claimId;
    });
  }

  consumeStructuredSubmission(tuple: import("rafi-spec").SelectedDispatchTupleV2, claimId: string, session?: ProviderSessionRefV1): void {
    this.atomic(() => {
      const operation = this.operation(tuple.dispatchId);
      if (!operation || operation.status !== "in_progress" || this.structuredOwnerDispatch(tuple.dispatchId).tupleJson !== canonicalJson(tuple))
        throw new Error("Submission owner is no longer in progress or sealed");
      this.assertNativeRunAdmission(operation.runId);
      const frozen = (operation.intent as { sessionRef: ProviderSessionRefV1 }).sessionRef;
      if (!session || canonicalJson(frozen) !== canonicalJson(session)) throw new Error("Submission session changed after sealing");
      const owner = this.roleMutationLease(operation.runId, session.role as "builder" | "qa");
      if (!(tuple.operation === "handoff-acceptance" && (operation.intent as {purpose?:string}).purpose === "contract-acceptance") && owner && (owner.providerSessionId !== session.sessionId || owner.sessionKey && owner.sessionKey !== providerSessionKey(session))) {
        this.assertFreshRecoveryValidation(tuple.dispatchId, session);
      }
      const changed = this.db.prepare(`UPDATE structured_submission_claims SET state='consumed',consumed_at=?
        WHERE dispatch_id=? AND run_id=? AND tuple_digest=? AND claim_id=? AND session_json=? AND state='claimed'`)
        .run(new Date().toISOString(), tuple.dispatchId, operation.runId, tuple.digest, claimId, canonicalJson(session));
      if (changed.changes !== 1) throw new Error("Structured submission claim already consumed or revoked");
    });
  }

  assertNativeRunAdmission(runId: string): void {
    assertStructuredCutoverComplete(this.db);
    const run = this.getRun(runId);
    if (run?.legacy || run?.checkpoint === STRUCTURED_CUTOVER_REASON || run?.state.structuredCommunicationCutover)
      throw new Error("structured-communication-v2-cutover: start a new native dispatch; this workflow cannot resume");
  }

  recordCommunicationEvidenceRefs(ownerId: string, digests: string[]): void {
    for (const digest of new Set(digests)) this.db.prepare("INSERT OR IGNORE INTO communication_evidence_refs(owner_kind,owner_id,evidence_digest,created_at) VALUES('provider-dispatch',?,?,?)").run(ownerId, digest, new Date().toISOString());
  }

  replayStructuredDispatch<T>(key: string, contract: import("rafi-spec").OutputContract<T>): T {
    const operation = this.operation(key);
    const result = operation?.result as { responseDigest?: string; validation?: string } | undefined;
    if (operation?.status !== "confirmed" || result?.validation !== "accepted" || !result.responseDigest) throw new Error("Structured dispatch has no confirmed persisted receipt");
    return this.verifyRetainedStructuredDispatch(key, contract, result.responseDigest);
  }

  private assertStructuredProviderTurn(key: string, providerTurnId: string | undefined): void {
    const result = this.operation(key)?.result as { responseDigest?: string } | undefined;
    const bytes = result?.responseDigest ? this.getEvidence(result.responseDigest) : undefined;
    if (!bytes) throw new Error("Structured dispatch receipt evidence is missing");
    const retained = JSON.parse(bytes.toString()) as RetainedStructuredReceiptV2;
    if (!providerTurnId || retained?.receipt?.state !== "candidate" || retained.hostTurnId !== providerTurnId)
      throw new Error("Domain receipt has a foreign native provider turn identity");
  }

  private verifyRetainedStructuredDispatch<T>(key: string, contract: import("rafi-spec").OutputContract<T>, responseDigest: string): T {
    const readVerifiedEvidence = (digest: string): Buffer | undefined => {
      const bytes = this.getEvidence(digest);
      if (bytes && (!graphDerivedAllowed(this.db, this.projectDir, digest) || createHash("sha256").update(bytes).digest("hex") !== digest)) throw new Error("Structured receipt evidence digest mismatch");
      return bytes;
    };
    const bytes = readVerifiedEvidence(responseDigest);
    if (!bytes) throw new Error("Structured dispatch receipt evidence is missing");
    const retained = JSON.parse(bytes.toString()) as RetainedStructuredReceiptV2;
    const owner = this.structuredOwnerDispatch(key);
    if (retained.version !== 2 || retained.tupleDigest !== owner.tupleDigest) throw new Error("Stored receipt does not match persisted owner tuple");
    return verifyPersistedDispatch(contract, owner, hydrateStructuredReceipt(retained, readVerifiedEvidence));
  }

  updateOperation(idempotencyKey: string, status: OperationLifecycle, details: { result?: unknown; externalId?: string; error?: string } = {}, now = new Date()): OperationRecord {
    const prior = this.operation(idempotencyKey); if (prior?.kind === "provider-dispatch" && status === "in_progress" && this.unresolvedPreparationProcesses(prior.runId).length) throw new Error("Readiness cleanup must be reconciled before provider dispatch");
    if (!prior) throw new Error(`operation not found: ${idempotencyKey}`);
    if (prior.kind === "provider-dispatch" && status === "confirmed") {
      const owner = this.structuredOwnerDispatch(idempotencyKey), tuple = persistedDispatchTuple(owner);
      const descriptor = persistedProviderWireContract(tuple);
      const result = details.result as { validation?: string; responseDigest?: string } | undefined;
      if (!descriptor || result?.validation !== "accepted" || !result.responseDigest) throw new Error("Provider confirmation requires verified persisted receipt evidence");
      this.verifyRetainedStructuredDispatch(idempotencyKey, descriptor.canonical, result.responseDigest);
    }
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
      if (status === "confirmed" && ["ticket-complete", "synthetic-completion"].includes(prior.kind)) {
        const workId = (prior.intent as { ticket?: string; ticketId?: string; workId?: string }).workId ?? (prior.intent as { ticket?: string }).ticket ?? (prior.intent as { ticketId?: string }).ticketId;
        const admission = workId && this.admittedWork(prior.runId, workId);
        if (admission) this.qaPreparationStore().metric(prior.runId, workId!, admission.requirementsDigest, `metric:completed:${prior.runId}:${workId}`, "completed", { status: (this.getRun(prior.runId)?.state as { qaEnabled?: boolean })?.qaEnabled === false ? "disabled" : undefined, at });
      }
      this.appendContinuityEvent({ runId: prior.runId, role: "host", kind: "operation_receipt", payload: { idempotencyKey, kind: prior.kind, status, externalId: details.externalId, error: details.error }, authoritativeStateRevision: this.continuityHead(prior.runId, "run")?.authoritativeStateRevision ?? 0 }, now);
    })();
    return this.operation(idempotencyKey)!;
  }

  unresolvedRoleDispatches(runId: string, role: string): OperationRecord[] {
    this.reconcileAnsweredInvalidJsonDispatches(runId);
    const rows = this.db.prepare("SELECT * FROM operation_journal WHERE run_id=? AND kind='provider-dispatch' AND status IN ('in_progress','uncertain')").all(runId) as DbOperation[];
    return rows.map(operationFromRow).filter(row => (row.intent as { role?: string }).role === role);
  }

  /**
   * Earlier versions left a completed answer that was not valid JSON as "uncertain", which
   * blocked every later turn for that role. The retained reply text proves the outcome, so
   * record it as answered-invalid. Only untruncated JSON-text replies that fail to parse qualify.
   */
  reconcileAnsweredInvalidJsonDispatches(runId: string): number {
    const rows = this.db.prepare("SELECT * FROM operation_journal WHERE run_id=? AND kind='provider-dispatch' AND status='uncertain'").all(runId) as DbOperation[];
    let reconciled = 0;
    for (const op of rows.map(operationFromRow)) {
      const result = op.result as { validation?: string; responseDigest?: string } | undefined;
      if (result?.validation !== "rejected" || !result.responseDigest) continue;
      const retainedBytes = this.getEvidence(result.responseDigest);
      if (!retainedBytes) continue;
      let retained: { receipt?: { state?: string; reason?: string }; rejectedValue?: { representation?: string; evidenceDigest?: string; originalBytes?: number; retainedBytes?: number } };
      try { retained = JSON.parse(retainedBytes.toString()); } catch { continue; }
      const rejected = retained.rejectedValue;
      if (retained.receipt?.state !== "rejected" || retained.receipt.reason !== "invalid-contract" || rejected?.representation !== "json-text"
        || !rejected.evidenceDigest || rejected.originalBytes !== rejected.retainedBytes) continue;
      const text = this.getEvidence(rejected.evidenceDigest);
      if (!text) continue;
      try { parseStrictJson(text.toString()); continue; } catch { /* the answer itself is not valid JSON */ }
      this.updateOperation(op.idempotencyKey, "failed", { result: { ...result, dispatchState: "answered-invalid" } });
      reconciled++;
    }
    return reconciled;
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
    const graphAccess = currentGraphDerivedAccess();
    if (graphAccess && (kind === "qa" || kind === "handoff")) registerGraphDerived(this.db, bytes, graphAccess);
    return digest;
  }

  /** Create an append-only provider page artifact before its first dispatch. */
  populationPageRecords(artifactId: string): string[] {
    return (this.db.prepare("SELECT content FROM page_ledger_pages WHERE artifact_id=? ORDER BY ordinal").all(artifactId) as Array<{ content: Buffer }>)
      .map(row => row.content.toString("utf8"));
  }

  populationPageLedger(artifactId: string): { tupleDigest: string; state: string; pageCount: number } | undefined {
    const row = this.db.prepare("SELECT tuple_digest,state,page_count FROM page_ledgers WHERE artifact_id=?").get(artifactId) as { tuple_digest: string; state: string; page_count: number } | undefined;
    return row && { tupleDigest: row.tuple_digest, state: row.state, pageCount: row.page_count };
  }

  beginPageLedger(input: { artifactId: string; runId: string; lineageId: string; tupleDigest: string; leaseId: string }, now = new Date()): void {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(input.artifactId) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.lineageId) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.leaseId) || !/^[a-f0-9]{64}$/.test(input.tupleDigest)) throw new Error("Invalid page ledger identity");
    this.ensureRun(input.runId);
    this.db.prepare(`INSERT INTO page_ledgers(artifact_id,run_id,lineage_id,tuple_digest,lease_id,state,page_count,total_bytes,created_at,updated_at)
      VALUES(?,?,?,?,?,'open',0,0,?,?) ON CONFLICT(artifact_id) DO NOTHING`).run(input.artifactId, input.runId, input.lineageId, input.tupleDigest, input.leaseId, now.toISOString(), now.toISOString());
    const row = this.db.prepare("SELECT run_id,lineage_id,tuple_digest,lease_id FROM page_ledgers WHERE artifact_id=?").get(input.artifactId) as { run_id: string; lineage_id: string; tuple_digest: string; lease_id: string };
    if (row.run_id !== input.runId || row.lineage_id !== input.lineageId || row.tuple_digest !== input.tupleDigest || row.lease_id !== input.leaseId) throw new Error("Page ledger identity collision");
  }

  /**
   * Atomically appends a page.  Duplicate delivery is accepted only when every
   * immutable byte and linkage field agrees; a provider cannot fill gaps,
   * rewrite history, or append after the terminal page.
   */
  appendPageLedger(input: { artifactId: string; lineageId: string; tupleDigest: string; leaseId: string; ordinal: number; predecessorDigest: string | null; content: string; terminal: boolean }, now = new Date()): { digest: string; duplicate: boolean } {
    if (!Number.isInteger(input.ordinal) || input.ordinal < 0 || input.ordinal >= 60) throw new Error("Page ordinal exceeds the 60-page limit");
    let canonical: string;
    let ticketCount: number;
    try {
      const parsed = JSON.parse(input.content) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("page must be a JSON object");
      const tickets = (parsed as Record<string, unknown>).tickets;
      if (!Array.isArray(tickets)) throw new Error("page must contain tickets");
      ticketCount = tickets.length;
      canonical = canonicalJson(parsed);
    } catch (error) {
      throw new Error(`Page ledger content must be canonical ticket-page JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (canonical !== input.content) throw new Error("Page ledger content must use canonical JSON bytes");
    if (ticketCount > 150) throw new Error("Page exceeds the 150-ticket limit");
    const bytes = Buffer.byteLength(input.content);
    if (bytes > 750 * 1024) throw new Error("Page exceeds the 750 KiB limit");
    const digest = createHash("sha256").update(input.content).digest("hex");
    return this.atomic(() => {
      const header = this.db.prepare("SELECT lineage_id,tuple_digest,lease_id,state,page_count,total_bytes FROM page_ledgers WHERE artifact_id=?").get(input.artifactId) as { lineage_id: string; tuple_digest: string; lease_id: string; state: string; page_count: number; total_bytes: number } | undefined;
      if (!header || header.lineage_id !== input.lineageId || header.tuple_digest !== input.tupleDigest || header.lease_id !== input.leaseId) throw new Error("Unknown or foreign page ledger");
      const existing = this.db.prepare("SELECT predecessor_digest,content_digest,content,terminal FROM page_ledger_pages WHERE artifact_id=? AND ordinal=?").get(input.artifactId, input.ordinal) as { predecessor_digest: string | null; content_digest: string; content: Buffer; terminal: number } | undefined;
      if (existing) {
        if (existing.terminal) throw new Error("Duplicate terminal page");
        if (existing.predecessor_digest === input.predecessorDigest && existing.content_digest === digest && existing.content.equals(Buffer.from(input.content)) && Boolean(existing.terminal) === input.terminal) return { digest, duplicate: true };
        throw new Error("Conflicting duplicate page");
      }
      if (header.state !== "open") throw new Error("Cannot append after terminal page");
      if (input.ordinal !== header.page_count) throw new Error("Page ordinal is out of order or has a gap");
      const prior = input.ordinal === 0 ? null : this.db.prepare("SELECT content_digest FROM page_ledger_pages WHERE artifact_id=? AND ordinal=?").get(input.artifactId, input.ordinal - 1) as { content_digest: string } | undefined;
      if ((prior?.content_digest ?? null) !== input.predecessorDigest) throw new Error("Page predecessor digest does not match");
      if (header.total_bytes + bytes > 6 * 1024 * 1024) throw new Error("Page ledger exceeds the 6 MiB aggregate limit");
      this.db.prepare("INSERT INTO page_ledger_pages(artifact_id,ordinal,predecessor_digest,content_digest,content,terminal,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(input.artifactId, input.ordinal, input.predecessorDigest, digest, Buffer.from(input.content), input.terminal ? 1 : 0, now.toISOString());
      this.db.prepare("UPDATE page_ledgers SET page_count=?,total_bytes=?,state=?,updated_at=? WHERE artifact_id=?")
        .run(header.page_count + 1, header.total_bytes + bytes, input.terminal ? "terminal" : "open", now.toISOString(), input.artifactId);
      return { digest, duplicate: false };
    });
  }

  registerGraphEvidence(value: string | Buffer, access: GraphDerivedAccess | GraphDerivedAccess[]): void { registerGraphDerived(this.db,value,access); }

  getEvidence(digest: string): Buffer | undefined {
    if(!graphDerivedAllowed(this.db,this.projectDir,digest))return undefined;
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
    const admission = this.admittedWork(next.runId, next.ticketId);
    const turns = this.db.prepare("SELECT receipt_json FROM qa_turns WHERE run_id=? AND ticket_id=? AND review_number=? AND status='completed'").all(next.runId, next.ticketId, next.reviewNumber) as Array<{ receipt_json: string }>;
    const terminalBlock = turns.some(row => {
      const receipt = parseJson(row.receipt_json) as QaTurnReceiptV2;
      const response = receipt.structuredResponseDigest && this.getEvidence(receipt.structuredResponseDigest);
      if (!receipt.terminalEventObserved || !response) return false;
      // A retained response alone is not authority in v2: this legacy receipt
      // has no sealed tuple/descriptor record to verify.  It may be inspected,
      // but cannot advance a review state.
      return false;
    });
    if (admission && (next.status === "passed" || next.status === "failed" || terminalBlock)) this.qaPreparationStore().metric(next.runId, next.ticketId, admission.requirementsDigest, `metric:review:${attemptId}`, "substantive-review", { status: next.status === "passed" ? "passed" : next.status === "failed" ? "failed" : "blocked", at: now.toISOString(), evidenceRefs: next.reportDigest ? [next.reportDigest] : [] });
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
    const raw = this.db.prepare("SELECT record_json FROM qa_remediation_attempts WHERE attempt_id=?").get(attemptId) as { record_json: string };
    this.db.prepare("UPDATE qa_remediation_attempts SET status=?,response_digest=?,summary_digest=?,record_json=?,updated_at=? WHERE attempt_id=?")
      .run(status, next.responseDigest ?? null, next.summaryDigest ?? null, json({ ...(parseJson(raw.record_json) as Record<string, unknown>), detail: next.detail, recoveryAttemptId: next.recoveryAttemptId }), next.updatedAt, attemptId);
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

  recordQaDeliveryTurn(turn: QaDeliveryTurn): void {
    if (turn.version === 4) ensureQaGraphJournalGuards(this.db);
    const prior = this.qaDeliveryTurns(turn.operationId).find(t => t.turnRecordId === turn.turnRecordId);
    if (prior) {
      if (prior.sealedDispatch) {
        if (turn.sealedDispatch && json(turn.sealedDispatch) !== json(prior.sealedDispatch)) throw new Error("Delivery owner tuple is immutable");
        turn.sealedDispatch = prior.sealedDispatch;
      }
      if (prior.status !== "intended") {
        if (json(prior) !== json(turn)) throw new Error(`conflicting completed delivery turn ${turn.turnRecordId}`);
        return;
      }
      for (const key of ["operationId", "reportOccurrenceId", "turnIndex", "kind", "hostInstructionDigest", "hostInstructionBytes", "startedAt"] as const) {
        if (prior[key] !== turn[key]) throw new Error(`delivery turn intent mismatch: ${key}`);
      }
    }
    if (turn.status === "completed") {
      const transport = this.operation(turn.turnRecordId);
      if (!prior?.sealedDispatch || json(turn.sealedDispatch) !== json(prior.sealedDispatch)
        || turn.structuredResponseDigest !== (transport?.result as { responseDigest?: string } | undefined)?.responseDigest)
        throw new Error("Completed delivery requires its persisted sealed native receipt");
      this.replayStructuredDispatch(turn.turnRecordId, remediationOutput);
      this.assertStructuredProviderTurn(turn.turnRecordId, turn.providerTurnId);
    }
    this.db.prepare(`INSERT INTO qa_delivery_turns(turn_record_id,operation_id,report_occurrence_id,turn_index,kind,status,record_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(turn_record_id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json,updated_at=excluded.updated_at`)
      .run(turn.turnRecordId, turn.operationId, turn.reportOccurrenceId, turn.turnIndex, turn.kind, turn.status, json(turn), turn.startedAt, turn.completedAt ?? turn.startedAt);
  }

  qaDeliveryTurns(operationId: string): QaDeliveryTurn[] {
    return (this.db.prepare("SELECT record_json FROM qa_delivery_turns WHERE operation_id=? ORDER BY turn_index").all(operationId) as Array<{ record_json: string }>).map(row => parseJson(row.record_json) as QaDeliveryTurn);
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
    this.assertNativeRunAdmission(runId);
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

  /**
   * Structured authority is admitted only after the one-way v2 cutover has
   * committed.  Keeping this at the common admission boundary prevents a
   * caller that opens WorkflowDb directly from bypassing the migration.
   */
  enableStructuredCommunication(): void {
    this.applyStructuredCommunicationV2Cutover();
    ensureQaGraphJournalGuards(this.db);
  }

  beginQaTurn(intent: QaTurnIntentV2): void {
    if (intent.outputContract) this.enableStructuredCommunication();
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

  /** Retire this run's unresolved dispatches on a provider session the host
   * has just closed after a failed call. The closed provider can no longer
   * act, so the call's outcome is final: unknown, never replayed. */
  retireClosedSessionDispatches(runId: string, sessionId: string | undefined, reason: string): string[] {
    if (!sessionId) return [];
    const dispatches = [...this.unresolvedRoleDispatches(runId, "builder"), ...this.unresolvedRoleDispatches(runId, "qa")]
      .filter(dispatch => (dispatch.intent as { sessionRef?: { sessionId?: string } }).sessionRef?.sessionId === sessionId);
    this.atomic(() => {
      for (const dispatch of dispatches) this.updateOperation(dispatch.idempotencyKey, "failed", { result: { recovery: "provider-closed", outcomeUnknown: true, providerReplayAuthorized: false, priorResult: dispatch.result }, error: reason });
    });
    return dispatches.map(dispatch => dispatch.idempotencyKey);
  }

  /** Retire interrupted role turns that are not implementation or bound QA
   * review work (for example build preflight, coverage, or handoff
   * acceptance) so the step restarts from its beginning. Implementation and
   * review turns keep their own recovery. The interrupted outcome stays unknown and is
   * never replayed or treated as a result. Returns the retired dispatch IDs. */
  reconcileInterruptedSteps(runId: string, role: "builder" | "qa"): string[] {
    // Only steps that are safe to run again from their beginning. Implementation
    // turns, bound QA review turns and turns of unknown kind keep their own recovery.
    const reviewTurn = this.db.prepare("SELECT 1 FROM qa_turns WHERE operation_id=?");
    const dispatches = this.unresolvedRoleDispatches(runId, role).filter(dispatch => {
      const operation = String((dispatch.intent as { operation?: unknown }).operation ?? "");
      return RESTARTABLE_STEPS[role].has(operation) && (role === "builder" || !reviewTurn.get(dispatch.idempotencyKey));
    });
    if (!dispatches.length) return [];
    const lease = this.currentLease();
    if (lease?.runId !== runId || lease.pid !== process.pid) throw new Error("Step recovery requires the original build recovery lease");
    const worker = this.events(runId).filter(event => event.type === "worker_started").at(-1)?.payload as { workerPid?: number; processStart?: string; host?: string } | undefined;
    if (!worker?.workerPid || classifyProcess(worker.workerPid, worker.processStart, worker.host).state !== "dead" || !processGroupQuiescent(worker.workerPid)
      || this.readinessProcesses().length) throw new Error("The interrupted step and all owned provider processes must be verified stopped before it restarts");
    const reconciliationId = `${role}-step-restart:${runId}:${randomUUID()}`;
    this.atomic(() => {
      for (const dispatch of dispatches) this.updateOperation(dispatch.idempotencyKey, "failed", { result: { recovery: "step-restart", reconciliationId, outcomeUnknown: true, providerReplayAuthorized: false, operation: (dispatch.intent as { operation?: unknown }).operation ?? null, priorResult: dispatch.result }, error: "Interrupted step outcome remains unknown; the step restarts from its beginning with its original inputs" });
      this.appendContinuityEvent({ runId, role: "host", kind: "interrupted_step_restarted", payload: { role, reconciliationId, dispatchIds: dispatches.map(dispatch => dispatch.idempotencyKey), outcomeUnknown: true, providerReplayAuthorized: false }, authoritativeStateRevision: this.continuityHead(runId, "run")?.authoritativeStateRevision ?? 0 });
    });
    return dispatches.map(dispatch => dispatch.idempotencyKey);
  }

  /** Retire an interrupted, proven read-only review transport, never a QA pass
   * or Builder remediation. A fresh immutable review must still run afterward. */
  reconcileInterruptedQaDispatch(runId: string, ticketId: string): boolean {
    const dispatches = this.unresolvedRoleDispatches(runId, "qa");
    if (!dispatches.length) return false;
    const lease = this.currentLease();
    if (lease?.runId !== runId || lease.pid !== process.pid) throw new Error("QA reconciliation requires the original build recovery lease");
    const worker = this.events(runId).filter(event => event.type === "worker_started").at(-1)?.payload as { workerPid?: number; processStart?: string; host?: string } | undefined;
    if (!worker?.workerPid || classifyProcess(worker.workerPid, worker.processStart, worker.host).state !== "dead" || !processGroupQuiescent(worker.workerPid)
      || this.readinessProcesses().length || this.unresolvedRoleDispatches(runId, "builder").length) throw new Error("Interrupted QA and all owned provider processes must be verified stopped before a fresh review");
    const head = this.qaTicketHead(runId, ticketId);
    if (!["turn-intended", "turn-uncertain", "operator-menu"].includes(head.state)) throw new Error("QA dispatch is not an interrupted review boundary");
    const run = this.getRun(runId)?.state as { tickets?: string[]; repository?: { branch?: string }; progress?: { completedTickets?: string[] } } | undefined;
    if (!run?.tickets?.includes(ticketId) || run.progress?.completedTickets?.includes(ticketId)) throw new Error("QA recovery cannot reopen completed or unapproved tickets");
    const definition = loadTickets(resolveTicketPaths(loadTicketsConfig(this.projectDir), this.projectDir).tickets).find(ticket => ticket.id === ticketId);
    if (!definition || qaDigest("admitted-requirements", definition) !== this.assertAdmittedWork(runId, ticketId).requirementsDigest) throw new Error("QA recovery requirements changed; approval is required");
    const owner = this.roleMutationLease(runId, "qa");
    // A cancellation can have a durable host terminal receipt while the
    // provider dispatch is still unknown. Exact frozen-turn bindings remain
    // required; the old receipt is never promoted to an accepted QA result.
    // A QA turn and its provider dispatch share one ID: the turn's operation ID
    // is the dispatch's idempotency key. Instruction digests are not comparable
    // across the two records (the dispatch hashes the full rendered provider
    // instruction), so binding is by that shared ID.
    // A host-completed turn is recoverable only when its dispatch recorded a
    // typed unknown provider outcome.
    const rows = this.db.prepare("SELECT status,intent_json FROM qa_turns WHERE run_id=? AND ticket_id=? AND status IN ('intended','uncertain','unknown','completed')").all(runId, ticketId) as Array<{ status: string; intent_json: string }>;
    const turns = new Map(rows.flatMap(row => {
      const turn = parseJson(row.intent_json) as QaTurnIntentV2;
      const result = dispatches.find(dispatch => dispatch.idempotencyKey === turn.operationId)?.result as { isError?: boolean; failure?: { dispatchState?: string } } | undefined;
      if (row.status === "completed" && !(result?.isError === true && result.failure?.dispatchState === "unknown")) return [];
      return [[turn.operationId, turn] as const];
    }));
    const bindings = dispatches.map(dispatch => {
      const intent = dispatch.intent as { sessionRef?: ProviderSessionRefV1 };
      const ref = intent.sessionRef;
      if (!ref || !owner?.sessionKey || ref.role !== "qa" || ref.stream !== "qa" || !Number.isSafeInteger(ref.generation) || ref.generation < 0
        || !ref.configRoot || canonicalProject(ref.configRoot) !== canonicalProject(this.projectDir) || !ref.validatedAt || Number.isNaN(Date.parse(ref.validatedAt))
        || ref.source !== "observed" || providerSessionKey(ref) !== owner.sessionKey) throw new Error("QA dispatch has no validated owner binding");
      const candidate = turns.get(dispatch.idempotencyKey);
      const turn = candidate && candidate.reviewNumber === head.reviewNumber
        && candidate.providerSession.sessionId === ref.sessionId && candidate.providerSession.provider === ref.provider && candidate.providerSession.generation === ref.generation
        && candidate.providerSession.cwd === ref.cwd && candidate.providerSession.configRoot === ref.configRoot ? candidate : undefined;
      if (!turn || turn.sourceStateDigest !== head.sourceStateDigest || turn.reviewBasisDigest !== head.reviewBasisDigest) throw new Error("QA dispatch does not match the frozen review turn");
      const sessions = this.db.prepare("SELECT session_json FROM qa_sessions WHERE run_id=? AND ticket_id=? AND generation=? AND source_state_digest=? AND review_basis_digest=?").all(runId, ticketId, ref.generation, turn.sourceStateDigest, turn.reviewBasisDigest) as Array<{ session_json: string }>;
      const session = sessions.map(row => parseJson(row.session_json) as { session: ProviderSessionRefV1; confinement?: Record<string, unknown> }).find(session => providerSessionKey(session.session) === owner.sessionKey && session.confinement);
      const confinement = session?.confinement;
      if (!confinement) throw new Error("Interrupted QA lacks a retained read-only confinement proof");
      const { digest, ...fields } = confinement;
      if (fields.version !== 2 || fields.sourceMode !== "read-only" || fields.scratchMode !== "isolated" || !["none", "user"].includes(String(fields.settingsSources))
        || !["disabled", "provider-required"].includes(String(fields.networkMode)) || !/^[a-f0-9]{64}$/.test(String(fields.environmentDigest)) || !/^[a-f0-9]{64}$/.test(String(fields.policyDigest)) || digest !== qaDigest("qa-confinement", fields)) throw new Error("Interrupted QA confinement is invalid");
      const sourceRow = this.db.prepare("SELECT state_json FROM qa_source_states WHERE run_id=? AND ticket_id=? AND digest=?").get(runId, ticketId, turn.sourceStateDigest) as { state_json: string } | undefined;
      const frozen = sourceRow ? parseJson(sourceRow.state_json) as FrozenQaSourceStateV2 : undefined;
      if (!frozen || frozen.version !== 2 || frozen.runId !== runId || frozen.ticketId !== ticketId || frozen.digest !== turn.sourceStateDigest || !/^[a-f0-9]{64}$/.test(frozen.contentDigest) || !/^[a-f0-9]{64}$/.test(frozen.originDigest) || !Array.isArray(frozen.paths)) throw new Error("Interrupted QA frozen source binding is missing or invalid");
      const basisRow = this.db.prepare("SELECT basis_json FROM qa_review_bases WHERE run_id=? AND ticket_id=? AND digest=?").get(runId, ticketId, turn.reviewBasisDigest) as { basis_json: string } | undefined;
      if (!basisRow) throw new Error("Interrupted QA review basis is missing");
      const basis = parseJson(basisRow.basis_json) as QaReviewBasisV2;
      const { digest: basisDigest, ...basisFields } = basis;
      if (basisDigest !== qaDigest("review-basis-fields", basisFields) || basis.confinementDigest !== digest || basis.ticketDigest !== qaDigest("ticket", definition)) throw new Error("Interrupted QA review basis is invalid");
      return { dispatch, turn, confinementDigest: digest };
    });
    const source = captureFrozenQaSource(this.projectDir);
    if (run.repository?.branch && execFileSync("git", ["branch", "--show-current"], { cwd: this.projectDir, encoding: "utf8" }).trim() !== run.repository.branch) throw new Error("Return to the build's owning branch before QA recovery");
    this.atomic(() => {
      if (captureFrozenQaSource(this.projectDir).digest !== source.digest) throw new Error("QA source changed during recovery inspection; retry");
      const reconciliationId = `qa-review-resume:${runId}:${randomUUID()}`;
      for (const { dispatch, turn, confinementDigest } of bindings) this.updateOperation(dispatch.idempotencyKey, "failed", { result: { recovery: "interrupted-read-only-qa", reconciliationId, outcomeUnknown: true, providerReplayAuthorized: false, priorResult: dispatch.result, qaTurnId: turn.operationId, reviewedSourceDigest: turn.sourceStateDigest, currentSourceDigest: source.digest, confinementDigest }, error: "Interrupted read-only QA outcome remains unknown; replaced by a fresh immutable full review, never replayed or treated as a pass" });
      this.appendContinuityEvent({ runId, role: "host", kind: "interrupted_qa_reconciled", payload: { reconciliationId, ticketId, dispatchIds: dispatches.map(dispatch => dispatch.idempotencyKey), currentSourceDigest: source.digest, outcomeUnknown: true, providerReplayAuthorized: false }, authoritativeStateRevision: this.continuityHead(runId, "run")?.authoritativeStateRevision ?? 0 });
    });
    return true;
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
      const prior = this.db.prepare("SELECT source_state_digest,review_basis_digest,status,intent_json FROM qa_turns WHERE operation_id=?").get(receipt.operationId) as { source_state_digest: string; review_basis_digest: string; status: string; intent_json: string } | undefined;
      if (!prior) throw new Error(`QA turn intent not found: ${receipt.operationId}`);
      const intent = parseJson(prior.intent_json) as QaTurnIntentV2;
      if (receipt.dispatch === "completed") {
        if (!intent.outputContract) throw new Error("Completed QA receipt requires its sealed native contract");
        const owner = this.structuredOwnerDispatch(receipt.operationId);
        if (json(receipt.sealedDispatch) !== json(owner)) throw new Error("QA receipt differs from sealed owner intent");
        if (receipt.structuredResponseDigest !== (this.operation(receipt.operationId)?.result as { responseDigest?: string } | undefined)?.responseDigest) throw new Error("QA receipt references foreign native evidence");
        const descriptor = persistedProviderWireContract(persistedDispatchTuple(owner));
        if (!descriptor) throw new Error("QA receipt contract is unavailable");
        this.replayStructuredDispatch(receipt.operationId, descriptor.canonical);
        this.assertStructuredProviderTurn(receipt.operationId, receipt.providerTurnId);
      }
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
      const admission = this.admittedWork(input.runId, input.ticketId), preparation = this.qaPreparationStore();
      if (admission && preparation.policy(input.runId)) {
        const evidence = preparation.putArtifact("finding-classification-input", { report: input, contractHead: preparation.head(input.runId, input.ticketId, admission.requirementsDigest), evidenceDisposition: "Cause remains unknown until supported assessment" });
        for (const findingId of findingIds) preparation.metric(input.runId, input.ticketId, admission.requirementsDigest, `metric:finding-unknown:${current.reportOccurrenceId}:${findingId}`, "finding-classification", { findingId, classifier: "host-evidence-boundary", cause: "unknown", confidence: "unknown", evidenceRefs: [evidence], at: now.toISOString() });
      }
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

  authorizeContractQaWaiver(runId: string, workId: string, decisionId: string): string {
    this.assertInstructionOwner(runId);
    const decision = this.humanDecision(decisionId);
    if (!decision || decision.runId !== runId || decision.status !== "answered" || decision.selectedChoiceId !== "yes" || decision.interruptionId !== `ticket:${workId}` || !this.humanDecisionKey(decisionId)?.startsWith(`${runId}:qa-nonconvergence:`) || !decision.prompt.includes("QA waiver confirmation")) throw new Error("Whole-work waiver requires the actual answered operator confirmation");
    const admission = this.assertAdmittedWork(runId, workId), store = this.qaPreparationStore(), head = store.head(runId, workId, admission.requirementsDigest), qa = this.qaTicketHead(runId, workId);
    if (head.state !== "ready" || !head.digest) throw new Error("Whole-work waiver requires a current ready contract");
    return store.putArtifact("waiver-authorization", { decisionId, runId, workId, admissionDigest: admission.requirementsDigest, contractDigest: head.digest, qaRevision: qa.revision, sourceDigest: qa.sourceStateDigest, reviewBasisDigest: qa.reviewBasisDigest, authorizedAt: decision.answeredAt });
  }

  commitQaWaiver(runId: string, ticketId: string, expectedRevision: number, reason: string, now = new Date(), authorizationRef?: string): QaReducerStateV2 {
    return this.db.transaction(() => {
      const head = this.qaTicketHead(runId, ticketId);
      if (head.revision !== expectedRevision) throw new Error(`QA waiver raced for ${runId}/${ticketId}`);
      const store = this.qaPreparationStore();
      if (store.policy(runId)?.mode === "enforce") {
        const admission = this.assertAdmittedWork(runId, ticketId), contractHead = store.head(runId, ticketId, admission.requirementsDigest);
        if (contractHead.state !== "ready" || !contractHead.digest || !reason.trim()) throw new Error("Whole-work waiver requires exact contract scope and operator reason");
        const authority = authorizationRef ? store.artifact<{ decisionId: string; runId: string; workId: string; admissionDigest: string; contractDigest: string; qaRevision: number; sourceDigest: string; reviewBasisDigest: string }>(authorizationRef, "waiver-authorization") : undefined;
        const decision = authority && this.humanDecision(authority.decisionId);
        if (!authority || authority.runId !== runId || authority.workId !== ticketId || authority.admissionDigest !== admission.requirementsDigest || authority.contractDigest !== contractHead.digest || authority.qaRevision !== expectedRevision || authority.sourceDigest !== head.sourceStateDigest || authority.reviewBasisDigest !== head.reviewBasisDigest || decision?.status !== "answered" || decision.selectedChoiceId !== "yes") throw new Error("Missing or stale whole-work waiver authorization");
        const contract = store.contract(contractHead.digest), review = this.qaReviewAttempts(runId, ticketId).at(-1);
        store.event(runId, ticketId, `whole-work-waiver:${runId}:${ticketId}:${head.revision}`, "whole-work-waiver", { version: 1, runId, workId: ticketId, admissionDigest: admission.requirementsDigest, contractDigest: contract.contentDigest, revision: contract.revision, sourceDigest: review?.sourceDigest ?? null, reviewBasisDigest: head.reviewBasisDigest ?? null, mandatoryCheckIds: contract.checks.filter(check => check.obligation === "mandatory").map(check => check.id), unresolvedReports: this.unresolvedQaReports(runId, ticketId).map(report => report.reportOccurrenceId), reason, actor: "operator", authorizationRef, decisionId: authority.decisionId, mechanism: "existing-qa-nonconvergence-decision", at: now.toISOString(), completion: "waived" });
      }
      for (const report of this.unresolvedQaReports(runId, ticketId)) this.setQaReportDisposition(report.reportOccurrenceId, "waived", reason, now);
      const admission = this.admittedWork(runId, ticketId);
      if (admission) store.metric(runId, ticketId, admission.requirementsDigest, `metric:waiver:${runId}:${ticketId}:${head.revision}`, "waived", { at: now.toISOString() });
      return this.transitionQa(runId, ticketId, head.revision, { type: "waived" }, now);
    })();
  }

  builderRemediationReceipt(operationId: string): BuilderRemediationReceiptV2 | BuilderRemediationReceiptV3 | undefined {
    const row = this.db.prepare("SELECT receipt_json FROM qa_remediation_receipts WHERE operation_id=?").get(operationId) as { receipt_json: string } | undefined;
    return row ? parseJson(row.receipt_json) as BuilderRemediationReceiptV2 | BuilderRemediationReceiptV3 : undefined;
  }

  verifiedBuilderRemediationReceipt(operationId: string): BuilderRemediationReceiptV3 | undefined {
    const receipt = this.builderRemediationReceipt(operationId);
    if (!receipt) return undefined;
    this.assertBuilderRemediationReceipt(receipt);
    return receipt as BuilderRemediationReceiptV3;
  }

  hasConfirmedQaRemediationForRecheck(runId: string, ticketId: string): boolean {
    const head = this.qaTicketHead(runId, ticketId);
    const attempt = this.qaRemediationAttempts(runId, ticketId).at(-1);
    if (head.state !== "recheck-required" || !attempt || attempt.status !== "succeeded"
      || attempt.generation !== head.remediationGeneration || this.unresolvedRoleDispatches(runId, "builder").length) return false;
    const receipt = this.builderRemediationReceipt(attempt.attemptId);
    if (receipt) this.assertBuilderRemediationReceipt(receipt);
    const review = this.qaReviewAttempt(attempt.reviewAttemptId);
    const transition = this.db.prepare("SELECT to_revision,event_json FROM qa_transitions WHERE run_id=? AND ticket_id=? ORDER BY to_revision DESC LIMIT 1").get(runId, ticketId) as { to_revision: number; event_json: string } | undefined;
    return Boolean(receipt && review && review.status === "failed" && receipt.runId === runId && receipt.ticketId === ticketId
      && receipt.operationId === attempt.attemptId && receipt.requestDigest === attempt.requestDigest
      && receipt.responseDigest === attempt.responseDigest && receipt.summaryDigest === attempt.summaryDigest
      && receipt.sourceStateDigest === review.sourceDigest && receipt.reportDigest === review.reportDigest && receipt.providerTurnId
      && transition?.to_revision === head.revision && (parseJson(transition.event_json) as { type?: string }).type === "remediation-received");
  }

  recordBuilderRemediationReceipt(receipt: BuilderRemediationReceiptV2 | BuilderRemediationReceiptV3): void {
    this.assertBuilderRemediationReceipt(receipt);
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

  private assertBuilderRemediationReceipt(receipt: BuilderRemediationReceiptV2 | BuilderRemediationReceiptV3): void {
    if (receipt.version !== 3) throw new Error("Legacy Builder receipt cannot authorize native remediation");
    this.assertNativeRunAdmission(receipt.runId);
    const attempt = this.qaRemediationAttempt(receipt.operationId);
    const review = attempt && this.qaReviewAttempt(attempt.reviewAttemptId);
    const turn = this.qaDeliveryTurns(receipt.operationId).find(value => value.turnRecordId === receipt.turnRecordId);
    if (!attempt || !review || !turn || turn.status !== "completed" || attempt.status !== "succeeded"
      || attempt.runId !== receipt.runId || attempt.ticketId !== receipt.ticketId
      || review.sourceDigest !== receipt.sourceStateDigest || review.reportDigest !== receipt.reportDigest
      || attempt.requestDigest !== receipt.requestDigest || attempt.responseDigest !== receipt.responseDigest
      || attempt.summaryDigest !== receipt.summaryDigest || turn.rawResponseDigest !== receipt.responseDigest
      || turn.providerTurnId !== receipt.providerTurnId || turn.reportOccurrenceId !== receipt.reportOccurrenceId)
      throw new Error("Builder receipt differs from its persisted remediation owner");
    const transport = this.operation(turn.turnRecordId);
    if (turn.structuredResponseDigest !== (transport?.result as { responseDigest?: string } | undefined)?.responseDigest)
      throw new Error("Builder receipt has a foreign native evidence reference");
    const result = this.replayStructuredDispatch(turn.turnRecordId, remediationOutput) as OperationResponse<import("rafi-spec").RemediationPayload>;
    this.assertStructuredProviderTurn(turn.turnRecordId, receipt.providerTurnId);
    const handoff = this.db.prepare("SELECT handoff_id FROM qa_failure_handoffs WHERE operation_id=?").get(receipt.operationId) as { handoff_id: string } | undefined;
    if (result.result.kind !== "completed" || result.result.payload.status !== "done" || result.result.payload.report.handoff_id !== handoff?.handoff_id
      || createHash("sha256").update(result.result.payload.report.summary).digest("hex") !== receipt.summaryDigest)
      throw new Error("Builder receipt requires its completed native remediation result and summary");
  }

  commitBuilderRemediationSuccess(receipt: BuilderRemediationReceiptV2 | BuilderRemediationReceiptV3, expectedRevision: number, now = new Date()): QaReducerStateV2 {
    return this.db.transaction(() => {
      this.recordBuilderRemediationReceipt(receipt);
      this.markQaReportsRecheckRequired(receipt.runId, receipt.ticketId, "Builder remediation received; QA recheck required", now);
      const admission = this.admittedWork(receipt.runId, receipt.ticketId);
      const remediation = this.qaRemediationAttempt(receipt.operationId);
      const review = remediation ? this.qaReviewAttempt(remediation.reviewAttemptId) : undefined;
      if (admission) this.qaPreparationStore().metric(receipt.runId, receipt.ticketId, admission.requirementsDigest, `metric:remediation:${receipt.operationId}`, "remediation", { phase: "remediation", findingIds: review?.namespacedFindingIds ?? [], at: now.toISOString() });
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

  private assertNativeQaCertificate(input: Pick<QaPassCertificateV2, "runId" | "ticketId" | "qaRevision" | "sourceStateDigest" | "reviewBasisDigest" | "turnReceiptDigest">, phase: "issue" | "consume" | "resume", certificateId?: string): void {
    this.assertNativeRunAdmission(input.runId);
    const head = this.qaTicketHead(input.runId, input.ticketId);
    const rows = this.db.prepare("SELECT * FROM qa_turns WHERE run_id=? AND ticket_id=? AND source_state_digest=? AND review_basis_digest=? AND status='completed'")
      .all(input.runId, input.ticketId, input.sourceStateDigest, input.reviewBasisDigest) as Array<Record<string, any>>;
    const row = rows.find(row => {
      try { return qaDigest("turn-receipt", parseJson(row.receipt_json)) === input.turnReceiptDigest; } catch { return false; }
    });
    if (!row) throw new Error("Pass requires the persisted sealed native QA owner receipt");
    const receipt = parseJson(row.receipt_json) as QaTurnReceiptV2;
    const intent = parseJson(row.intent_json) as QaTurnIntentV2;
    if (!receipt.terminalEventObserved || receipt.dispatch !== "completed" || receipt.operationId !== row.operation_id || intent.operationId !== row.operation_id ||
      intent.runId !== input.runId || intent.ticketId !== input.ticketId || intent.reviewNumber !== head.reviewNumber || intent.reviewNumber !== row.review_number || intent.sessionGeneration !== head.sessionGeneration ||
      intent.sourceStateDigest !== input.sourceStateDigest || intent.reviewBasisDigest !== input.reviewBasisDigest ||
      receipt.sourceStateDigest !== input.sourceStateDigest || receipt.reviewBasisDigest !== input.reviewBasisDigest ||
      !receipt.sealedDispatch || canonicalJson(receipt.sealedDispatch) !== canonicalJson(this.structuredOwnerDispatch(receipt.operationId)))
      throw new Error("Native pass owner/source/review binding mismatch");
    this.assertStructuredProviderTurn(receipt.operationId, receipt.providerTurnId);
    const verdict = this.replayStructuredDispatch(receipt.operationId, qaVerdictOutput) as OperationResponse<QaVerdictPayload>;
    if (verdict.result.kind !== "completed" || verdict.result.payload.kind !== "passed") throw new Error("Pass requires a verified native passed verdict");
    const operation = this.operation(receipt.operationId)!;
    const tuple = persistedDispatchTuple(this.structuredOwnerDispatch(receipt.operationId));
    if (operation.runId !== input.runId || intent.providerSession.sessionId !== tuple.sessionId || intent.providerSession.generation !== tuple.generation || intent.providerSession.provider !== tuple.provider)
      throw new Error("Native pass session/tuple binding mismatch");
    const attempt = this.qaReviewAttempt((operation.intent as { logicalActionId?: string }).logicalActionId ?? "");
    if ((operation.intent as {logicalActionId?:string}).logicalActionId && !attempt) throw new Error("Native pass review attempt is missing");
    if (attempt && (attempt.runId !== input.runId || attempt.ticketId !== input.ticketId || attempt.reviewNumber !== head.reviewNumber || attempt.sourceDigest !== input.sourceStateDigest || attempt.status !== "passed"))
      throw new Error("Native pass review attempt is not completed and bound");
    if (head.sourceStateDigest !== input.sourceStateDigest || head.reviewBasisDigest !== input.reviewBasisDigest ||
      (phase === "issue" ? head.state !== "turn-intended" || input.qaRevision !== head.revision + 1 :
        head.passCertificateId !== certificateId || (phase === "consume" ? head.state !== "passed" || input.qaRevision !== head.revision : head.state !== "finalizing" || input.qaRevision + 1 !== head.revision)))
      throw new Error("Native pass certificate does not match the reducer phase/revision");
  }

  private assertContractCertificate(input: Pick<QaPassCertificateV2, "runId" | "ticketId" | "sourceStateDigest" | "reviewBasisDigest" | "turnReceiptDigest" | "contractCoverage">): void {
    const store = this.qaPreparationStore();
    if (store.policy(input.runId)?.mode !== "enforce") return;
    const binding = input.contractCoverage;
    if (!binding || binding.version !== 1) throw new Error("Enforcing pass requires tagged contract coverage authority");
    const verifiedBinding = binding;
    const admission = this.assertAdmittedWork(input.runId, input.ticketId);
    const head = store.head(input.runId, input.ticketId, admission.requirementsDigest);
    if (head.state !== "ready" || head.digest !== binding.contractDigest) throw new Error("Pass contract is stale or incomplete");
    const contract = store.contract(binding.contractDigest);
    if (contract.revision !== binding.revision) throw new Error("Pass revision mismatch");
    const basisRow = this.db.prepare("SELECT basis_json FROM qa_review_bases WHERE digest=? AND run_id=? AND ticket_id=?").get(input.reviewBasisDigest, input.runId, input.ticketId) as { basis_json: string } | undefined;
    if (!basisRow) throw new Error("Pass lacks immutable input basis");
    const basis = parseJson(basisRow.basis_json) as QaReviewBasisV2;
    const definition = this.workDefinitions(input.runId).find(work => work.workId === input.ticketId)?.definition;
    if (!definition || basis.ticketDigest !== qaDigest("ticket", definition)) throw new Error("Pass ticket basis differs from frozen admitted scope");
    const { digest, ...fields } = basis;
    if (digest !== qaDigest("review-basis-fields", fields) || basis.contractBinding?.digest !== contract.contentDigest || basis.contractBinding.admissionDigest !== admission.requirementsDigest) throw new Error("Pass basis/contract binding mismatch");
    const configuredMake = (this.getRun(input.runId)?.state as { qa?: { settings?: { make?: "claude" | "codex" } } })?.qa?.settings?.make;
    if (configuredMake && resolveEffectiveQaConfiguration(this.projectDir, { make: configuredMake }).digest !== basis.contractBinding.commonConfigDigest) throw new Error("Effective QA configuration changed before pass authority; reconcile contract");
    const attempt = this.qaReviewAttempt(verifiedBinding.attemptId);
    if (!attempt || attempt.runId !== input.runId || attempt.ticketId !== input.ticketId || attempt.sourceDigest !== input.sourceStateDigest || attempt.reviewNumber !== this.qaTicketHead(input.runId, input.ticketId).reviewNumber) throw new Error("Coverage review attempt is stale or foreign");
    const coverage = store.artifact<import("rafi-spec").QaContractCoverageV1>(verifiedBinding.coverageDigest, "final-coverage");
    for (const check of contract.checks) for (const method of check.verification) if (method.equivalentAuthorityId && !store.equivalentResolver()(method.equivalentAuthorityId, contract, check, method, input.sourceStateDigest)) throw new Error("Equivalent verification authority is stale or foreign");
    const initialTurns = this.db.prepare("SELECT intent_json FROM qa_turns WHERE run_id=? AND ticket_id=? AND review_number=? AND source_state_digest=? AND review_basis_digest=?").all(input.runId, input.ticketId, attempt.reviewNumber, input.sourceStateDigest, input.reviewBasisDigest) as Array<{ intent_json: string }>;
    const initial = initialTurns.map(row => parseJson(row.intent_json) as QaTurnIntentV2).find(turn => turn.slot === "initial");
    if (!initial || initial.providerSession.sessionId !== verifiedBinding.sessionId) throw new Error("Coverage lacks the actual fresh review dispatch identity");
    const dispatchedInstruction = this.getEvidence(initial.instructionDigest)?.toString();
    const envelope = `\nImmutable input-basis digest: ${basis.digest}. Coverage must bind this inputBasisDigest.`;
    if (basis.contractBinding.transportVersion !== 1 || !dispatchedInstruction?.endsWith(envelope) || qaDigest("instruction", dispatchedInstruction.slice(0, -envelope.length)) !== basis.instructionDigest) throw new Error("Actual review dispatch differs from frozen base instruction and tagged input-basis envelope");
    const receipts = this.db.prepare("SELECT receipt_json FROM qa_turns WHERE run_id=? AND ticket_id=? AND source_state_digest=? AND review_basis_digest=? AND status='completed'").all(input.runId, input.ticketId, input.sourceStateDigest, input.reviewBasisDigest) as Array<{ receipt_json: string }>;
    const receipt = receipts.map(row => parseJson(row.receipt_json) as QaTurnReceiptV2).find(row => qaDigest("turn-receipt", row) === input.turnReceiptDigest && row.terminalEventObserved);
    const response = receipt?.structuredResponseDigest ? this.getEvidence(receipt.structuredResponseDigest) : undefined;
    if (!response || !receipt) throw new Error("Pass requires a retained native QA verdict receipt");
    const owner = this.structuredOwnerDispatch(receipt.operationId);
    if (json(receipt.sealedDispatch) !== json(owner)) throw new Error("Pass receipt lacks its persisted v2 owner tuple");
    if (persistedDispatchTuple(owner).sessionId !== verifiedBinding.sessionId) throw new Error("Pass native receipt has a foreign session");
    const verdict = this.replayStructuredDispatch(receipt.operationId, qaVerdictOutput) as OperationResponse<QaVerdictPayload>;
    if (verdict.result.kind !== "completed" || verdict.result.payload.kind !== "passed" || !verdict.result.payload.coverage) throw new Error("Pass requires complete coverage in the retained native passed verdict");
    const retainedProviderCoverage = bindCoverageHostFields(verdict.result.payload.coverage as import("rafi-spec").QaContractCoverageV1, contract, {
      phase: "qa", sourceDigest: input.sourceStateDigest, inputBasisDigest: input.reviewBasisDigest,
      attemptId: verifiedBinding.attemptId, sessionId: verifiedBinding.sessionId,
    });
    let retainedCoverage = retainedProviderCoverage;
    let retainedHostComparison: { result: import("./hostQaComparison.js").HostQaComparisonV1; resultDigest: string } | undefined;
    const hostCheck = findHostQaCheck(contract);
    if (hostCheck !== undefined) {
      const hostDigest = hostComparisonDigestFromCoverage(coverage, hostCheck!.id);
      if (!hostDigest) throw new Error("Coverage is missing the host-owned comparison artifact reference");
      const verifiedHostDigest: string = hostDigest!;
      const hostResult = hostQaComparisonV1Schema.parse(store.artifact(verifiedHostDigest, "host-qa-comparison"));
      retainedHostComparison = { result: hostResult, resultDigest: verifiedHostDigest };
    }
    const commandObservations = [
      ...retainedQaCommandObservations(this.projectDir, input.runId, input.ticketId, false),
      ...retainedHostBuilderObservations(this, input.runId, input.ticketId),
    ];
    const graphCheck = findGraphQaChecks(contract)[0];
    let retainedHostGraph: { result: import("./hostGraphApplicability.js").HostGraphApplicabilityV1; resultDigest: string } | undefined;
    if (graphCheck) {
      const graphDigest = hostGraphApplicabilityDigestFromCoverage(coverage, graphCheck.id);
      if (!graphDigest) throw new Error("Coverage is missing the host-owned Graphify applicability artifact reference");
      const verifiedGraphDigest: string = graphDigest!;
      const graphResult = hostGraphApplicabilityV1Schema.parse(store.artifact(verifiedGraphDigest, "host-graph-applicability"));
      retainedHostGraph = { result: graphResult, resultDigest: verifiedGraphDigest };
    }
    if (retainedCoverage) retainedCoverage = assembleFinalQaCoverage({
      providerCoverage: retainedCoverage,
      contract,
      projectDir: this.projectDir,
      commandObservations,
      hostComparison: retainedHostComparison,
      hostGraph: retainedHostGraph,
    });
    if (!retainedCoverage) throw new Error("Coverage lacks the retained terminal review receipt and authorized host augmentation");
    const errors = validateContractCoverage(contract, retainedCoverage, { phase: "qa", sourceDigest: input.sourceStateDigest, inputBasisDigest: input.reviewBasisDigest, attemptId: verifiedBinding.attemptId, sessionId: verifiedBinding.sessionId });
    if (errors.length) throw new Error(errors.join("; "));
    if (!receipt || !retainedCoverage || canonicalJson(retainedCoverage) !== canonicalJson(coverage)) throw new Error("Coverage is not bound to the retained terminal review receipt and authorized host augmentation");
  }

  issueQaPassCertificate(input: Omit<QaPassCertificateV2, "version" | "certificateId" | "unresolvedReportCount" | "issuedAt">, now = new Date()): QaPassCertificateV2 {
    this.assertNativeQaCertificate(input, "issue");
    this.assertContractCertificate(input);
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
      this.assertContractCertificate(input);
      this.finishQaReviewAttempt(attemptId, { status: "passed", detail }, now);
      return this.commitQaPass(input, expectedRevision, now);
    })();
  }

  consumeQaPassCertificate(runId: string, ticketId: string, certificateId: string, consumer: string, now = new Date()): QaPassCertificateV2 {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM qa_pass_certificates WHERE certificate_id=? AND run_id=? AND ticket_id=?").get(certificateId, runId, ticketId) as Record<string, any> | undefined;
      if (!row) throw new Error("QA pass certificate is missing or scoped to another run/ticket");
      if (row.consumed_at) throw new Error("QA pass certificate has already been consumed");
      const value = parseJson(row.certificate_json) as QaPassCertificateV2;
      if (value.certificateId !== row.certificate_id || value.runId !== runId || value.ticketId !== ticketId || value.qaRevision !== row.qa_revision ||
        value.sourceStateDigest !== row.source_state_digest || value.reviewBasisDigest !== row.review_basis_digest || value.turnReceiptDigest !== row.turn_receipt_digest || value.issuedAt !== row.issued_at)
        throw new Error("Pass certificate SQL identity mismatch");
      this.assertNativeQaCertificate(value, "consume", certificateId);
      this.assertContractCertificate(parseJson(row.certificate_json) as QaPassCertificateV2);
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

  assertQaFinalizationAuthority(runId: string, ticketId: string): void {
    const steps = this.qaFinalizationSteps(runId, ticketId).filter(step => step.status !== "invalidated");
    if (!steps.length) throw new Error("QA finalization intent is missing");
    for (const step of steps) {
      const row = this.db.prepare("SELECT * FROM qa_pass_certificates WHERE certificate_id=? AND run_id=? AND ticket_id=?")
        .get(step.certificateId, runId, ticketId) as Record<string, any> | undefined;
      if (!row || !row.consumed_at || row.consumed_by !== step.kind) throw new Error("Finalization certificate consumer binding mismatch");
      const certificate = parseJson(row.certificate_json) as QaPassCertificateV2;
      if (certificate.consumedAt !== row.consumed_at || certificate.consumedBy !== row.consumed_by
        || certificate.certificateId !== row.certificate_id || certificate.runId !== row.run_id || certificate.ticketId !== row.ticket_id
        || certificate.qaRevision !== row.qa_revision || certificate.sourceStateDigest !== row.source_state_digest
        || certificate.reviewBasisDigest !== row.review_basis_digest || certificate.turnReceiptDigest !== row.turn_receipt_digest
        || certificate.issuedAt !== row.issued_at) throw new Error("Finalization certificate SQL identity mismatch");
      this.assertNativeQaCertificate(certificate, "resume", step.certificateId);
      this.assertContractCertificate(certificate);
    }
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
      this.assertQaFinalizationAuthority(runId,ticketId);
      const head = this.qaTicketHead(runId, ticketId);
      if (head.revision !== expectedRevision || head.state !== "finalizing") throw new Error(`QA finalization completion raced for ${runId}/${ticketId}`);
      this.finishPendingQaFinalizationSteps(runId, ticketId, receipt, now);
      const admission = this.admittedWork(runId, ticketId);
      if (admission) this.qaPreparationStore().metric(runId, ticketId, admission.requirementsDigest, `metric:completed:${runId}:${ticketId}`, "completed", { at: now.toISOString() });
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

  freshRecoveryValidation(runId: string, role: "builder" | "qa"): FreshRecoveryValidation {
    const decision = this.recoveryDecisions(runId).at(-1);
    const predecessor = this.roleMutationLease(runId, role);
    if (!decision || decision.mode !== "fresh-recovery-only" || decision.role !== role || !predecessor)
      throw new Error("Fresh recovery validation requires an explicit current recovery decision and predecessor lease");
    return { decisionDigest: digestJson(decision), predecessor };
  }

  /** This grants one response-only initialization, never ownership or business work. */
  assertFreshRecoveryValidation(dispatchId: string, session: ProviderSessionRefV1): void {
    const operation = this.operation(dispatchId);
    const intent = operation?.intent as { operation?: string; responseOnly?: boolean; sessionRef?: ProviderSessionRefV1; freshRecoveryValidation?: FreshRecoveryValidation } | undefined;
    const authorization = intent?.freshRecoveryValidation;
    const decision = operation && this.recoveryDecisions(operation.runId).at(-1);
    if (!operation || !authorization || !decision || intent?.operation !== "session-initialization" || intent.responseOnly !== true ||
      canonicalJson(intent.sessionRef) !== canonicalJson(session) ||
      (session.role !== "builder" && session.role !== "qa") || decision.mode !== "fresh-recovery-only" || decision.role !== session.role ||
      authorization.decisionDigest !== digestJson(decision) || dispatchId !== `fresh-recovery:${authorization.decisionDigest}` ||
      canonicalJson(this.roleMutationLease(operation.runId, session.role)) !== canonicalJson(authorization.predecessor) ||
      decision.runId !== operation.runId || canonicalSessionPath(session.cwd) !== canonicalSessionPath(decision.worktree) ||
      session.provider !== (decision.requestedSuccessor?.agent ?? decision.settings.make) ||
      session.sessionId === authorization.predecessor.providerSessionId ||
      decision.predecessorSessionId && decision.predecessorSessionId !== authorization.predecessor.providerSessionId ||
      decision.predecessorSessionRef && providerSessionKey(decision.predecessorSessionRef) !== authorization.predecessor.sessionKey)
      throw new Error("Submission session no longer owns its role: fresh recovery decision or predecessor changed");
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
    const pending = new Map<number, string | undefined>();
    for (const event of events) {
      if (event.kind === "turn_started" && event.role === "host" && (event.payload as { role?: string }).role === role) {
        const dispatchId = (event.payload as { dispatchId?: unknown }).dispatchId;
        pending.set(event.sequence, typeof dispatchId === "string" ? dispatchId : undefined);
      } else if (event.role === role && event.kind === "turn_not_sent") {
        const dispatchId = (event.payload as { dispatchId?: unknown }).dispatchId;
        if (typeof dispatchId === "string") for (const [sequence, id] of pending) { if (id === dispatchId) pending.delete(sequence); }
      } else if (event.role === role
        && (event.kind === "turn_completed" || event.kind === "turn_completed_after_repair" || event.kind === "handback_turn_completed" || event.kind === "fresh_successor_accepted" || event.kind === "handoff_successor_accepted")) {
        pending.clear();
      }
    }
    return pending.size > 0;
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
        if (record?.communicationProtocolVersion === 2) continue;
        const isBuild = (record?.version === 1 || record?.version === 2) && typeof record.runId === "string";
        const runId = isBuild ? String(record!.runId) : `legacy_${digest.slice(0, 24)}`;
        if (!this.getRun(runId)) {
          this.createRun({ runId, kind: isBuild ? "build" : "legacy", checkpoint: isBuild && typeof record?.checkpoint === "string" ? record.checkpoint : "legacy-imported", originalWork: isBuild ? { tickets: record?.tickets ?? [] } : { source: path }, remainingWork: isBuild ? { tickets: record?.tickets ?? [] } : {}, state: isBuild ? record! : { source: path, record: parsed }, legacy: true }, now);
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

  /**
   * One-way cutover fence.  We deliberately do not attempt to convert an old
   * receipt into authority: any pre-existing run with legacy state or a
   * provider dispatch that lacks a sealed tuple is terminally superseded.
   * User/project artifacts remain in their own tables; only workflow authority
   * is fenced.  The marker is committed atomically with the classification.
   */
  private applyStructuredCommunicationV2Cutover(): void {
    const migration = STRUCTURED_AUDIT_CLOSURE;
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS structured_communication_cutover(migration TEXT PRIMARY KEY,completed_at TEXT NOT NULL,details_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS structured_cutover_quarantine(run_id TEXT NOT NULL,table_name TEXT NOT NULL,row_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS structured_handoff_lineage(predecessor_id TEXT PRIMARY KEY REFERENCES operation_journal(idempotency_key),run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),state TEXT NOT NULL,acceptance_id TEXT UNIQUE,successor_json TEXT,continuation_id TEXT UNIQUE);
        CREATE TABLE IF NOT EXISTS continuity_checkpoint_origins(checkpoint_id INTEGER PRIMARY KEY REFERENCES continuity_checkpoints(checkpoint_id),run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),origin_json TEXT NOT NULL,delta_digest TEXT NOT NULL,dispatch_id TEXT,publication_kind TEXT,UNIQUE(run_id,dispatch_id,publication_kind));
        CREATE TABLE IF NOT EXISTS structured_dispatch_processing(dispatch_id TEXT PRIMARY KEY REFERENCES operation_journal(idempotency_key),run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),state TEXT NOT NULL CHECK(state IN ('pending','completed')),context_json TEXT NOT NULL,error TEXT);
        CREATE TABLE IF NOT EXISTS structured_submission_claims(dispatch_id TEXT PRIMARY KEY REFERENCES operation_journal(idempotency_key),run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),tuple_digest TEXT NOT NULL,claim_id TEXT NOT NULL UNIQUE,session_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('claimed','consumed')),created_at TEXT NOT NULL,consumed_at TEXT);
        CREATE TABLE IF NOT EXISTS communication_evidence_refs(owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,evidence_digest TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner_kind,owner_id,evidence_digest));
        CREATE TABLE IF NOT EXISTS page_ledgers(artifact_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),lineage_id TEXT NOT NULL,tuple_digest TEXT NOT NULL,lease_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('open','terminal','cancelled')),page_count INTEGER NOT NULL,total_bytes INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS page_ledger_pages(artifact_id TEXT NOT NULL REFERENCES page_ledgers(artifact_id),ordinal INTEGER NOT NULL,predecessor_digest TEXT,content_digest TEXT NOT NULL,content BLOB NOT NULL,terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),created_at TEXT NOT NULL,PRIMARY KEY(artifact_id,ordinal));`);
      const prior = this.db.prepare("SELECT details_json FROM structured_communication_cutover WHERE migration=?").get(migration) as { details_json: string } | undefined;
      if (this.db.prepare("SELECT 1 FROM structured_communication_cutover WHERE migration='003_structured_communication_v2_cutover'").get() && prior && JSON.parse(prior.details_json).ownershipMatrixVersion === STRUCTURED_CUTOVER_MATRIX_VERSION) return;
      // Upgrade only an unambiguous host baseline. Historical provider deltas
      // without an exact dispatch origin remain fenced; timestamps are not proof.
      for (const checkpoint of this.db.prepare(`SELECT c.* FROM continuity_checkpoints c JOIN workflow_runs r USING(run_id)
        WHERE json_valid(r.state_json) AND c.session_ref_json IS NULL
        AND NOT EXISTS(SELECT 1 FROM continuity_checkpoint_origins o WHERE o.checkpoint_id=c.checkpoint_id)`).all() as DbContinuityCheckpoint[]) {
        let delta: ContinuityDelta;
        try { delta = parseJson(checkpoint.delta_json) as ContinuityDelta; } catch { continue; }
        if (!delta || delta.version !== 1 || delta.nextAction !== "Await the first role action." ||
          [delta.decisions,delta.constraints,delta.discoveries,delta.completedActions,delta.evidence,delta.failures,delta.blockers,delta.openWork].some(items => !Array.isArray(items) || items.length)) continue;
        const baseline = this.db.prepare("SELECT sequence,payload_json FROM continuity_events WHERE run_id=? AND role='host' AND kind='role_baseline' AND sequence<=? ORDER BY sequence DESC LIMIT 1")
          .get(checkpoint.run_id, checkpoint.event_sequence) as {sequence:number;payload_json:string}|undefined;
        if (!baseline || JSON.parse(baseline.payload_json).role !== checkpoint.role) continue;
        const deltaDigest = createHash("sha256").update(checkpoint.delta_json).digest("hex");
        const event = this.appendContinuityEvent({runId:checkpoint.run_id,role:"host",kind:"host_checkpoint",authoritativeStateRevision:checkpoint.authoritative_state_revision,
          payload:{checkpointDeltaDigest:deltaDigest,sourceBaselineSequence:baseline.sequence,role:checkpoint.role}});
        this.db.prepare("INSERT INTO continuity_checkpoint_origins(checkpoint_id,run_id,origin_json,delta_digest) VALUES(?,?,?,?)")
          .run(checkpoint.checkpoint_id,checkpoint.run_id,json({kind:"host",eventSequence:event.sequence,inputCheckpointDigests:[]}),deltaDigest);
      }
      const matrix = cutoverOwnershipMatrix(this.db);
      const fileReferences = communicationFileEvidenceReferences(this.projectDir);
      const affected = (this.db.prepare("SELECT * FROM workflow_runs").all() as Array<Record<string, any>>).filter(run => invalidStructuredRun(this.db, run, this.projectDir));
      const lease = this.db.prepare("SELECT run_id,pid,process_start,host FROM project_lease WHERE singleton=1").get() as { run_id: string; pid: number; process_start: string; host: string } | undefined;
      if (lease && affected.some(run => run.run_id === lease.run_id) && classifyProcess(lease.pid, lease.process_start, lease.host).state !== "dead")
        throw new Error("v2-cutover-pending: stop the existing workflow owner before structured communication cutover");
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='build_owned_processes'").get()) {
        const processes = this.db.prepare("SELECT run_id,pid,process_start,host FROM build_owned_processes WHERE state<>'quiescent'").all() as Array<{ run_id: string; pid: number | null; process_start: string | null; host: string }>;
        if (processes.some(process => affected.some(run => run.run_id === process.run_id)
          && (!process.pid || !process.process_start || classifyProcess(process.pid, process.process_start, process.host).state !== "dead")))
          throw new Error("v2-cutover-pending: reconcile owned build processes before structured communication cutover");
      }
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='build_admission'").get()) {
        const row = this.db.prepare("SELECT record_json FROM build_admission WHERE singleton=1").get() as { record_json: string } | undefined;
        if (row) {
          let admission: BuildAdmission;
          try { admission = JSON.parse(row.record_json); }
          catch { throw new Error("v2-cutover-pending: malformed build admission requires reconciliation"); }
          if (affected.some(run => run.run_id === admission.runId) && classifyProcess(admission.pid, admission.processStart, admission.host).state !== "dead")
            throw new Error("v2-cutover-pending: stop the existing build owner before structured communication cutover");
        }
      }
      // Existing domain guards must not block the authorized cutover. Restore
      // them in this same transaction, omitting only superseded v1 comms guards.
      const triggers = this.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>;
      for (const trigger of triggers) {
        if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(trigger.name)) throw new Error("Unexpected cutover trigger identity");
        this.db.exec(`DROP TRIGGER "${trigger.name}"`);
      }
      const now = new Date().toISOString();
      for (const { run_id } of affected) {
        const row = this.db.prepare("SELECT state_json FROM workflow_runs WHERE run_id=?").get(run_id) as { state_json: string };
        const originalBytesDigest = createHash("sha256").update(row.state_json).digest("hex");
        this.db.prepare("INSERT INTO structured_cutover_quarantine(run_id,table_name,row_json) VALUES(?,?,?)").run(run_id, "workflow_runs.state_json", json({ originalBytes: row.state_json, originalBytesDigest }));
        let original: Record<string, unknown> = {};
        try { const parsed = parseJson(row.state_json); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) original = parsed as Record<string, unknown>; } catch { /* quarantined verbatim above */ }
        const state = { ...original, structuredCommunicationCutover: { version: 2, reason: "structured-communication-v2-cutover", originalBytesDigest, at: now } };
        purgeStructuredRun(this.db, run_id, matrix, fileReferences);
        this.db.prepare("UPDATE workflow_runs SET status='superseded',checkpoint='structured-communication-v2-cutover',state_json=?,updated_at=? WHERE run_id=?")
          .run(json(state), now, run_id);
      }
      quarantineCommunicationFiles(this.projectDir, this.db);
      for (const trigger of triggers) if (!trigger.name.startsWith("structured_comms_v1_")) this.db.exec(trigger.sql);
      this.db.prepare("INSERT INTO structured_communication_cutover(migration,completed_at,details_json) VALUES(?,?,?) ON CONFLICT(migration) DO UPDATE SET completed_at=excluded.completed_at,details_json=excluded.details_json")
        .run(migration, now, json({ ownershipMatrixVersion: STRUCTURED_CUTOVER_MATRIX_VERSION, ownershipMatrix: matrix, fencedRuns: affected.map(row => row.run_id), policy: "legacy-or-unsealed-provider-authority-is-non-resumable" }));
      this.db.prepare("INSERT OR IGNORE INTO structured_communication_cutover(migration,completed_at,details_json) VALUES(?,?,?)")
        .run("003_structured_communication_v2_cutover", now, json({ ownershipMatrixVersion: STRUCTURED_CUTOVER_MATRIX_VERSION }));
      ensureQaGraphJournalGuards(this.db);
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS structured_cutover_terminal_run BEFORE UPDATE ON workflow_runs
        WHEN OLD.checkpoint='structured-communication-v2-cutover'
        BEGIN SELECT CASE WHEN NEW.status<>'superseded' OR NEW.checkpoint<>OLD.checkpoint OR NEW.state_json<>OLD.state_json
          THEN RAISE(ABORT,'structured-communication-v2-cutover: workflow permanently non-resumable') END; END;`);
    })();
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
  ensureLocalGitExcludes(projectDir, [WORKFLOW_DB_FILE, `${WORKFLOW_DB_FILE}-wal`, `${WORKFLOW_DB_FILE}-shm`, ".rafi/cache/handoffs/", ".rafi/backups/work-admission-v4/"], { fallbackToGitignore: true });
}
