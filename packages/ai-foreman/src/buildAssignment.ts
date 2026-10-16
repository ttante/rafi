import { assertBuilderContractCoverage } from "./qaBuilderCoverage.js";
import { resolveEffectiveQaConfiguration } from "./qaEffectiveConfig.js";
import { contractDigest } from "./qaVerificationContract.js";
import { queueGraphMaintenance } from "./graph/boundary.js";
import { actualContractSession, assertContractReceipt } from "./qaContractDelivery.js";
import type { BuilderAdapter } from "./adapters/types.js";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { StepStatus } from "./foreman.js";
import type { TurnResult } from "./adapters/types.js";
import { captureFrozenQaSource, type FrozenQaSourceState } from "./qaSnapshot.js";
import { WorkflowDb } from "./workflowDb.js";
import { WorkflowReader } from "./workflowReader.js";
import type { BuildRunRecordV2, ProviderSessionRefV1 } from "rafi-spec";
import { classifyProcess, processGroupQuiescent } from "./processIdentity.js";
import { loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import { loadTickets } from "./tickets/ticketLoader.js";
import { qaDigest } from "./qaProtocolV2.js";
import { providerSessionKey } from "./sessionIdentity.js";

/** Work responses confirm an assignment; they never select the next ticket. */
export function validateBuildAssignment(ticketId: string, status: StepStatus, responseText = ""): string | undefined {
  // An unmarked response may receive the existing bounded response-only repair.
  // Explicit foreign markers must not be erased by a parser error or correction.
  const named = [...responseText.matchAll(/\bticket="([^"]*)"/g)].map(match => match[1]);
  if (status.kind === "unknown" && !status.ticket && named.every(id => id === ticketId)) return undefined;
  if (status.ticket !== ticketId) {
    return `Builder response named ${status.ticket ?? "no ticket"}, but this turn was assigned to ${ticketId}. Preserved work requires ownership reconciliation before further execution.`;
  }
  if (status.kind === "qa_pass" || status.kind === "qa_fail") return `Builder emitted QA status ${status.kind} for assigned ticket ${ticketId}; independent QA is required.`;
  return undefined;
}

export interface BuildAssignmentCapture {
  operationId: string;
  runId: string;
  ticketId: string;
  worktree: string;
  before: BuildSourceState;
  instruction: string;
  guidanceIds: string[];
}

type BuildSourceState = Pick<FrozenQaSourceState, "digest" | "head" | "contentDigest" | "capturedAt" | "pathInventory" | "stagedDiff" | "unstagedDiff" | "untracked"> & { captureMode: "git" | "filesystem"; omissions?: string[] };

export class BuildAssignmentRejected extends Error {}

/** A frozen exact-session Builder decision may defer unrelated pending QA. */
export function isInterruptedBuilderRecovery(run: BuildRunRecordV2 | undefined): boolean {
  if (!run) return false;
  const decision = run.recoveryDecision;
  const continuation = (run as BuildRunRecordV2 & { interruptedBuilderContinuation?: { ticketIds?: string[]; sessionRef?: ProviderSessionRefV1; recovery?: string; reconciliationId?: string } }).interruptedBuilderContinuation;
  if (continuation?.recovery === "source-reconciled" && continuation.reconciliationId) {
    return decision?.runId === run.runId && decision.role === "builder" && decision.mode === "fresh-with-handoff"
      && Boolean(continuation.ticketIds?.length === 1 && decision.executionTickets?.includes(continuation.ticketIds[0]!)
        && run.tickets.includes(continuation.ticketIds[0]!));
  }
  return decision?.runId === run.runId && decision.role === "builder" && decision.mode === "exact-session"
    && Boolean(decision.executionTickets?.length && decision.executionTickets.every(id => run.tickets.includes(id)))
    && Boolean(continuation?.ticketIds?.length === 1 && decision.executionTickets?.includes(continuation.ticketIds[0]!))
    && Boolean(continuation?.sessionRef && decision.predecessorSessionRef && sameSession(continuation.sessionRef, decision.predecessorSessionRef));
}

/** Recovery requires current source, assignment and admission proofs.
 * A V3 or migrated record alone never grants continuation authority;
 * full eligibility is verified before any unknown receipt is reconciled. */
export function canReconcileInterruptedBuilderSource(projectDir: string, runId: string): boolean {
  const db = new WorkflowReader(projectDir);
  try {
    const state = db.getRun(runId)?.state as unknown as BuildRunRecordV2 | undefined;
    const assignments = db.operations(runId, true).filter(op => op.kind === "build-assignment" && ["in_progress", "uncertain"].includes(op.status));
    if (state?.version !== 3 || state.branchMode !== "current" || assignments.length !== 1) return false;
    const intent = assignments[0]!.intent as { ticketId?: string; before?: { digest?: string }; requirementsDigest?: string; instructionDigest?: string };
    return Boolean(intent.ticketId && state.tickets.includes(intent.ticketId) && intent.before?.digest && intent.requirementsDigest && intent.instructionDigest
      && db.events(runId).some(event => event.type === "worker_started"));
  } finally { db.close(); }
}

/** Resume the existing approved build from observed local source, never replay
 * the interrupted instruction or pretend its unknown outcome was successful.
 * The caller must own recovery admission and the original run's workflow lease. */
export function prepareInterruptedBuilderSourceContinuation(projectDir: string, runId: string): { ticketIds: string[]; reconciliationId: string; sourceDigest: string; contentDigest: string } {
  const db = new WorkflowDb(projectDir);
  try {
    const lease = db.currentLease();
    if (lease?.runId !== runId || lease.pid !== process.pid) throw new BuildAssignmentRejected("Source recovery requires the original run's current recovery lease");
    if (!canReconcileInterruptedBuilderSource(projectDir, runId)) throw new BuildAssignmentRejected("Interrupted work lacks current source-bound assignment authority; use guided recovery or preserve files and restart");
    const run = db.getRun(runId)!.state as unknown as BuildRunRecordV2;
    if (run.builderCapabilities?.grantedNetwork) throw new BuildAssignmentRejected("Interrupted network-enabled work requires explicit side-effect reconciliation; source inspection cannot establish remote outcomes");
    if (db.readinessProcesses().length || db.unresolvedRoleDispatches(runId, "qa").length) throw new BuildAssignmentRejected("Owned processes or a separate QA dispatch must be reconciled before Builder source recovery");
    if (db.incompletePublications().some(item => item.runId === runId && (item.intent as {operation?:string}).operation !== "build-run-projection")) throw new BuildAssignmentRejected("A pending source/tracker publication must be reconciled before Builder source recovery");
    const worker = db.events(runId).filter(event => event.type === "worker_started").at(-1)?.payload as { workerPid?: number; processStart?: string; host?: string } | undefined;
    if (!worker?.workerPid || classifyProcess(worker.workerPid, worker.processStart, worker.host).state !== "dead" || !processGroupQuiescent(worker.workerPid)) {
      throw new BuildAssignmentRejected("The interrupted worker and its owned process group must be verified stopped before source recovery");
    }
    const assignment = db.operations(runId).find(op => op.kind === "build-assignment" && ["in_progress", "uncertain"].includes(op.status))!;
    const intent = assignment.intent as { ticketId: string; worktree: string; requirementsDigest: string; before: { digest: string } };
    if (realpathSync(intent.worktree) !== realpathSync(projectDir) || realpathSync(run.repository.worktree) !== realpathSync(projectDir)) throw new BuildAssignmentRejected("Interrupted source belongs to another worktree");
    if (run.progress.completedTickets.includes(intent.ticketId) || ["completed", "waived"].includes(db.qaTicketHead(runId, intent.ticketId).state)) throw new BuildAssignmentRejected("A completed ticket cannot be reopened by interrupted source recovery");
    const admission = db.assertAdmittedWork(runId, intent.ticketId);
    const definition = loadTickets(resolveTicketPaths(loadTicketsConfig(projectDir), projectDir).tickets).find(ticket => ticket.id === intent.ticketId);
    if (!definition || admission.requirementsDigest !== intent.requirementsDigest || qaDigest("admitted-requirements", definition) !== intent.requirementsDigest) throw new BuildAssignmentRejected("Interrupted ticket requirements changed; current scope needs approval before recovery");
    const dispatches = db.unresolvedRoleDispatches(runId, "builder");
    const owner = db.roleMutationLease(runId, "builder");
    if (!dispatches.length || !owner?.sessionRef || !owner.sessionKey || owner.sessionRef.source !== "observed" || !owner.sessionRef.validatedAt
      || Number.isNaN(Date.parse(owner.sessionRef.validatedAt)) || dispatches.some(op => {
        const ref=(op.intent as {sessionRef?:unknown}).sessionRef;
        return !sameSession(ref,owner.sessionRef!) || providerSessionKey(ref as ProviderSessionRefV1)!==owner.sessionKey;
      })) throw new BuildAssignmentRejected("Interrupted dispatch is not bound to the recorded Builder owner");
    const source = captureBuildSource(projectDir);
    if (run.repository.branch && sourceBranch(projectDir) !== run.repository.branch) throw new BuildAssignmentRejected("The current branch changed; return to the interrupted build's owning branch before source recovery");
    const reconciliationId = `source-resume:${runId}:${randomUUID()}`;
    db.atomic(() => {
      if (captureBuildSource(projectDir).digest !== source.digest) throw new BuildAssignmentRejected("Preserved source changed during recovery inspection; retry from the current files");
      const retained = retainSource(db, source);
      const receipt = { recovery: "source-reconciled", reconciliationId, outcomeUnknown: true, providerReplayAuthorized: false, source: retained, ticketId: intent.ticketId, requirementsDigest: intent.requirementsDigest, worker, at: new Date().toISOString() };
      for (const dispatch of dispatches) db.updateOperation(dispatch.idempotencyKey, "failed", { result: { ...receipt, priorResult: dispatch.result }, error: "Interrupted provider outcome remains unknown; verified stopped local execution is replaced by source inspection and fresh QA, without replay" });
      db.updateOperation(assignment.idempotencyKey, "failed", { result: { ...receipt, priorResult: assignment.result }, error: "Interrupted assignment preserved for source-bound continuation; completion is not established" });
      const event = db.appendContinuityEvent({ runId, role: "host", kind: "interrupted_source_reconciled", payload: { ...receipt, dispatchIds: dispatches.map(op => op.idempotencyKey), assignmentId: assignment.idempotencyKey }, authoritativeStateRevision: db.continuityHead(runId, "run")?.authoritativeStateRevision ?? 0 });
      db.publishContinuityCheckpoint({ runId, role: "builder", state: "current", authoritativeStateRevision: event.authoritativeStateRevision, delta: {
        version: 1, decisions: [`Continue already-approved ticket ${intent.ticketId} in the SAME build from preserved source; this host reconciliation is not a successful provider turn.`],
        constraints: ["Never replay the interrupted provider instruction or assume its side effects did not happen. Inspect current files first, implement only missing approved work, and require independent QA. Preserve all completed tickets and accepted QA.", "The predecessor session's compaction history remains unknown; use a validated fresh handoff before any new implementation."],
        discoveries: [], completedActions: [], evidence: [`Host-observed source digest ${source.digest}; interrupted assignment ${assignment.idempotencyKey}; reconciliation ${reconciliationId}`],
        failures: ["The interrupted provider outcome is unknown and remains preserved in the historical receipt."], blockers: [], openWork: [`Inspect preserved implementation of ${intent.ticketId}; complete remaining criteria and obtain fresh QA.`], nextAction: `Accept a fresh source-bound handoff, inspect ${intent.ticketId}, then continue all remaining approved tickets.`,
      } });
      const current = db.getRun(runId)!;
      db.transition(runId, { checkpoint: "builder-source-reconciled", state: { ...current.state, interruptedBuilderContinuation: { recovery: "source-reconciled", ticketIds: [intent.ticketId], reconciliationId, sourceDigest: source.digest, contentDigest: source.contentDigest, productDigest: interruptedProductDigest(projectDir, source) } }, event: "builder_source_continuation_authorized", payload: receipt });
    });
    return { ticketIds: [intent.ticketId], reconciliationId, sourceDigest: source.digest, contentDigest: source.contentDigest };
  } finally { db.close(); }
}

/** A launch may not consume a recovery snapshot after product source changes. */
export function assertInterruptedSourceSnapshot(projectDir: string, run: BuildRunRecordV2): void {
  const continuation = (run as BuildRunRecordV2 & { interruptedBuilderContinuation?: { recovery?: string; contentDigest?: string; productDigest?: string; firstAssignmentId?: string; ticketIds?: string[] } }).interruptedBuilderContinuation;
  if (continuation?.recovery !== "source-reconciled" || continuation.firstAssignmentId || !continuation.ticketIds?.some(id => !run.progress.completedTickets.includes(id))) return;
  const reader = new WorkflowReader(projectDir);
  try {
    // A stale in-memory snapshot can lag the atomic consumption marker. The
    // source-bound assignment journal is durable and cannot be overwritten by
    // the next ordinary run projection.
    const reconciliationId = (continuation as {reconciliationId?:string}).reconciliationId;
    if (reconciliationId && reader.operations(run.runId, true).some(op => op.kind === "build-assignment" && (op.intent as {sourceRecoveryId?:string}).sourceRecoveryId === reconciliationId)) return;
  } finally { reader.close(); }
  const source = captureBuildSource(projectDir);
  if (continuation.productDigest ? interruptedProductDigest(projectDir, source) !== continuation.productDigest : source.contentDigest !== continuation.contentDigest) throw new BuildAssignmentRejected("Preserved implementation changed after recovery preparation; inspect the current files with rafi resume before launching new work");
}

function interruptedProductDigest(projectDir: string, source: BuildSourceState): string {
  const paths = resolveTicketPaths(loadTicketsConfig(projectDir), projectDir);
  // Ticket status/rendering is host bookkeeping, not product mutation. Ticket
  // definitions and other documents remain bound, including unrelated docs.
  const bookkeeping = new Set([paths.stateDb, `${paths.stateDb}-wal`, `${paths.stateDb}-shm`, paths.progressDoc, paths.archiveDoc].map(path => relative(projectDir, path).replace(/\\/g, "/")));
  return createHash("sha256").update(JSON.stringify({ head: source.head, branch: sourceBranch(projectDir), paths: source.pathInventory.filter(path => !bookkeeping.has(path.path)) })).digest("hex");
}

function sourceBranch(projectDir: string): string | undefined {
  const result=spawnSync("git",["branch","--show-current"],{cwd:projectDir,encoding:"utf8",stdio:["ignore","pipe","ignore"]});
  return result.status===0 ? result.stdout.trim() : undefined;
}

/**
 * Retire only the host-side records for a Builder turn that was interrupted
 * before Rafi received a durable response.  The next turn is sent to the
 * *same validated provider session*, so it continues the outstanding work
 * rather than treating unknown work as complete or replaying it in a new
 * conversation.
 */
export function prepareExactSessionBuilderContinuation(
  projectDir: string,
  runId: string,
  session: ProviderSessionRefV1,
): { ticketIds: string[]; dispatchIds: string[]; assignmentIds: string[] } {
  const db = new WorkflowDb(projectDir);
  try {
    const dispatches = db.unresolvedRoleDispatches(runId, "builder");
    if (!dispatches.length) throw new BuildAssignmentRejected("No interrupted Builder dispatch is awaiting exact-session continuation");
    if (dispatches.some(dispatch => !sameSession((dispatch.intent as { sessionRef?: unknown }).sessionRef, session))) {
      throw new BuildAssignmentRejected("Interrupted Builder dispatch is not bound to the validated exact provider session");
    }
    const assignments = db.operations(runId).filter(operation => operation.kind === "build-assignment" && ["in_progress", "uncertain"].includes(operation.status));
    if (!assignments.length) throw new BuildAssignmentRejected("Interrupted Builder dispatch has no durable in-progress assignment");
    const ticketIds = assignments.map(operation => (operation.intent as { ticketId?: unknown }).ticketId)
      .filter((ticketId): ticketId is string => typeof ticketId === "string");
    if (ticketIds.length !== assignments.length) throw new BuildAssignmentRejected("Interrupted Builder assignment is missing its ticket identity");

    db.atomic(() => {
      const resumedAt = new Date().toISOString();
      for (const dispatch of dispatches) {
        db.updateOperation(dispatch.idempotencyKey, "failed", {
          result: { recovery: "exact-session-continuation", resumedAt, sessionRef: session },
          error: "Host interruption: the same validated Builder session will reconcile and continue this turn",
        });
      }
      for (const assignment of assignments) {
        db.updateOperation(assignment.idempotencyKey, "failed", {
          result: { recovery: "exact-session-continuation", resumedAt, sessionRef: session },
          error: "Host interruption: work remains assigned to the validated Builder session; do not send it to QA yet",
        });
      }
      const run = db.getRun(runId);
      if (run) db.transition(runId, {
        checkpoint: "builder-exact-session-continuation",
        state: { ...run.state, interruptedBuilderContinuation: { ticketIds, sessionRef: session, resumedAt } },
        event: "builder_exact_session_continuation_authorized",
        payload: { ticketIds, sessionRef: session },
      });
    });
    return { ticketIds: [...new Set(ticketIds)], dispatchIds: dispatches.map(item => item.idempotencyKey), assignmentIds: assignments.map(item => item.idempotencyKey) };
  } finally { db.close(); }
}

/** Retire uncertain execution for an explicitly selected start-over, never claim
 * that a provider did not run or that its preserved implementation passed QA. */
export function retireBuildExecutionForStartOver(projectDir: string, runId: string, operationId: string): void {
  const db = new WorkflowDb(projectDir);
  let admission: ReturnType<WorkflowDb["acquireBuildRecoveryAdmission"]> | undefined;
  let lease: ReturnType<WorkflowDb["acquireLease"]> | undefined;
  try {
    const operation = db.getRun(operationId);
    const original = operation?.originalWork as { run?: { runId?: string } } | undefined;
    if (operation?.kind !== "recovery" || operation.state.operation !== "build-start-over" || original?.run?.runId !== runId) throw new Error("Execution retirement requires a recorded start-over intent for this run");
    admission = db.acquireBuildRecoveryAdmission(runId);
    lease = db.acquireLease(runId);
    if (db.readinessProcesses().length) throw new Error("Owned process cleanup must be verified before starting over");
    if (db.incompletePublications().some(item => {
      if (item.runId !== runId) return false;
      const intent = item.intent as { operation?: string; target?: string };
      return intent.operation !== "build-run-projection" || intent.target !== join(resolve(projectDir), ".foreman", "runs", `${runId}.json`);
    })) throw new Error("Finish pending publication recovery before starting over; preserved files may still be awaiting publication");
    db.atomic(() => {
      for (const dispatch of [...db.unresolvedRoleDispatches(runId, "builder"), ...db.unresolvedRoleDispatches(runId, "qa")]) {
        db.updateOperation(dispatch.idempotencyKey, "failed", { result: { recovery: "start-over", operationId, outcomeUnknown: true, providerReplayAuthorized: false }, error: "Operator chose a fresh run from preserved source; historical execution outcome remains unknown" });
      }
      const run = db.getRun(runId);
      if (!run) throw new Error("Original run disappeared before start-over");
      db.transition(runId, { checkpoint: "execution-retired-for-start-over", state: { ...run.state, executionRetiredForStartOver: operationId }, event: "execution_retired_for_start_over", payload: { operationId, providerReplayAuthorized: false } });
    });
  } finally {
    try { if (lease) db.releaseLease(lease); } finally { try { if (admission) db.releaseBuildAdmission(admission); } finally { db.close(); } }
  }
}

function sameSession(value: unknown, session: ProviderSessionRefV1): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProviderSessionRefV1>;
  return candidate.provider === session.provider
    && candidate.sessionId === session.sessionId
    && candidate.generation === session.generation
    && session.role === "builder" && session.stream === "builder"
    && candidate.role === "builder"
    && candidate.stream === "builder"
    && candidate.cwd === session.cwd
    && candidate.configRoot === session.configRoot;
}

export interface BuilderGuidanceFollowup {
  reviewAttemptId: string;
  requirementsDigest: string;
  maximum: number;
  authorizationId?: string;
}

export function assertBuildAssignmentReconciled(projectDir: string, runId: string, worktree = projectDir): void {
  const reader = new WorkflowReader(projectDir);
  try {
    const runs = [...new Set([runId,...reader.buildRuns(true).map(run=>run.runId)])];
    const retiredRuns = new Set<string>();
    for (const operation of runs.flatMap(id=>reader.operations(id,true))) {
      if (operation.kind !== "build-assignment") continue;
      if (retiredRuns.has(operation.runId)) continue;
      const owner = reader.getRun(operation.runId);
      // An explicit start-over retires execution, while retaining assignments
      // as historical evidence. It never authorizes their provider replay.
      const retirement = typeof owner?.state.supersededBy === "string" ? reader.getRun(owner.state.supersededBy) : undefined;
      if (owner?.status === "superseded" && retirement?.kind === "recovery" && retirement.state.operation === "build-start-over"
        && retirement.state.gitPreserved === true && typeof retirement.state.resetId === "string"
        && (retirement.originalWork as { run?: { runId?: string } }).run?.runId === operation.runId
        && reader.events(operation.runId).some(event => event.type === "execution_retired_for_start_over" && (event.payload as { operationId?: string }).operationId === retirement.runId)) {
        retiredRuns.add(operation.runId);
        continue;
      }
      const result = operation.result as { rejection?: string; sourceError?: string } | undefined;
      if ((result as {reconciliationId?:string}|undefined)?.reconciliationId) continue;
      if(!result?.rejection&&!result?.sourceError&&operation.status!=="in_progress"&&operation.status!=="uncertain")continue;
      const intent = operation.intent as {worktree?: string};
      if(operation.runId !== runId) {
        if(!intent.worktree)continue;
        try {if(realpathSync(intent.worktree)!==realpathSync(worktree))continue;}
        catch {if(resolve(intent.worktree)!==resolve(worktree))continue;}
      }
      if (result?.rejection || result?.sourceError || operation.status === "in_progress" || operation.status === "uncertain") {
        throw new BuildAssignmentRejected(`Build ${runId} requires assignment reconciliation for ${operation.idempotencyKey}: ${result?.rejection ?? result?.sourceError ?? "provider dispatch outcome is unconfirmed"}. Inspect with rafi manager --ask '/qa-conflicts ${runId}'.`);
      }
    }
  } finally { reader.close(); }
}

/** Commit response/source bytes before interpreting any scoped outcome. */
export function beginBuildAssignment(projectDir: string, runId: string, ticketId: string, worktree: string, instruction: string, followup?: BuilderGuidanceFollowup, adapter?: BuilderAdapter): BuildAssignmentCapture {
  assertBuildAssignmentReconciled(projectDir, runId,worktree);
  const operationId = `build-assignment:${runId}:${randomUUID()}`;
  const db = new WorkflowDb(projectDir);
  try {
    const before = captureBuildSource(worktree);
    let guidance = {text: instruction, ids: [] as string[]};
    db.atomic(() => {
      db.ensureRun(runId);
      const admission = db.assertAdmittedWork(runId, ticketId);
      const continuationState = db.getRun(runId)!;
      const sourceContinuation = continuationState.state.interruptedBuilderContinuation as { recovery?: string; ticketIds?: string[]; firstAssignmentId?: string } | undefined;
      if (sourceContinuation?.recovery === "source-reconciled" && sourceContinuation.ticketIds?.includes(ticketId) && !sourceContinuation.firstAssignmentId) {
        assertInterruptedSourceSnapshot(projectDir, continuationState.state as unknown as BuildRunRecordV2);
        db.transition(runId, { checkpoint: continuationState.checkpoint, state: { ...continuationState.state, interruptedBuilderContinuation: { ...sourceContinuation, firstAssignmentId: operationId } }, event: "builder_source_continuation_consumed", payload: { ticketId, operationId, sourceDigest: before.digest } });
      }
      let contractBinding: { digest: string; revision: number; receiptOperationId: string; session: ReturnType<typeof actualContractSession> } | undefined;
      if (db.qaPreparationStore().policy(runId)?.mode === "enforce") {
        const contract = assertContractReceipt(db.qaPreparationStore(), runId, ticketId, admission.requirementsDigest, adapter ? actualContractSession(adapter, worktree, projectDir) : undefined, adapter);
        const session = actualContractSession(adapter!, worktree, projectDir);
        const receipt = db.qaPreparationStore().receipts(contract.contentDigest).find(row => row.sessionId === session.sessionId && row.generation === session.generation && row.workspace === session.workspace && row.compactionSequence === session.compactionSequence)!;
        contractBinding = { digest: contract.contentDigest, revision: contract.revision, receiptOperationId: receipt.operationId, session };
        const qaMake = (db.getRun(runId)?.state as { qa?: { settings?: { make?: "claude" | "codex" } } })?.qa?.settings?.make ?? adapter!.agent;
        const current = resolveEffectiveQaConfiguration(projectDir, { make: qaMake });
        if (contract.inputs.find(input => input.kind === "rules")?.digest !== current.digest || contract.inputs.find(input => input.kind === "checklist")?.digest !== contractDigest("input-checklist", current.checklist)) throw new BuildAssignmentRejected("Canonical QA rules, skills or checklist changed after delivery; reconcile the contract before implementation");
      }
      const continuation = db.getRun(runId)?.state.interruptedBuilderContinuation as { recovery?: string; ticketIds?: string[]; reconciliationId?: string } | undefined;
      const recoveredInstruction = continuation?.recovery === "source-reconciled" && continuation.ticketIds?.includes(ticketId)
        ? `${instruction}\n\nHost recovery ${continuation.reconciliationId}: an earlier assignment was interrupted with an unknown result. Inspect the preserved files before acting. Do not replay the old instruction, repeat completed side effects, or redo completed tickets. Implement only missing acceptance criteria for this ticket, validate the current implementation and return truthful evidence for independent fresh QA.`
        : instruction;
      guidance = db.reserveGuidance(runId, ticketId, "builder", operationId, before.digest, recoveredInstruction);
      if (followup) {
        if (admission.requirementsDigest !== followup.requirementsDigest) throw new BuildAssignmentRejected("Ticket requirements changed; renewed scope approval is required before the Builder follow-up");
        if (!guidance.ids.length) throw new BuildAssignmentRejected("No eligible Builder guidance remains; no follow-up was dispatched");
        const latest = db.qaReviewAttempts(runId, ticketId).at(-1);
        const head = db.qaTicketHead(runId, ticketId);
        if (latest?.attemptId !== followup.reviewAttemptId || latest.status !== "passed" || head.state !== "passed") throw new BuildAssignmentRejected("Builder follow-up requires the current unfinalized QA pass");
        db.reserveQaRemediation(runId, ticketId, latest.attemptId, operationId, followup.maximum, followup.authorizationId);
        db.invalidateUnconsumedQaPassCertificates(runId, ticketId, "builder-guidance-followup");
        db.transitionQa(runId, ticketId, head.revision, { type: "builder-guidance-followup-intended" });
      }
      const instructionDigest = db.putEvidence("qa", Buffer.from(guidance.text));
      db.planOperation({ runId, idempotencyKey: operationId, kind: "build-assignment", intent: { ticketId, worktree, admissionId: admission.assignmentId, requirementsDigest: admission.requirementsDigest, instructionDigest, ...(continuation?.recovery === "source-reconciled" && continuation.ticketIds?.includes(ticketId) ? { sourceRecoveryId: continuation.reconciliationId } : {}), ...(contractBinding ? { contractBinding } : {}), before: retainSource(db, before), ...(followup ? { managerFollowup: followup } : {}) } });
      db.recordWorkAssignment(runId,ticketId,operationId,{requirementsDigest:admission.requirementsDigest,worktree,sourceDigest:before.digest,ownerGeneration:db.currentLease()?.generation,instructionDigest});
      db.updateOperation(operationId, "in_progress");
    });
    return { operationId, runId, ticketId, worktree, before, instruction:guidance.text, guidanceIds:guidance.ids };
  } finally { db.close(); }
}

export function finishBuildAssignment(projectDir: string, assignment: BuildAssignmentCapture, result: TurnResult, status: StepStatus): string | undefined {
  let rejection = result.failure?.dispatchState === "not-sent" ? undefined : validateBuildAssignment(assignment.ticketId, status, result.text);
  // Source capture can fail after an external turn. Keep the response even then.
  let after: BuildSourceState | undefined;
  let sourceError: string | undefined;
  try { after = captureBuildSource(assignment.worktree); } catch (error) { sourceError = error instanceof Error ? error.message : String(error); }
  if (result.failure?.dispatchState === "not-sent" && after && after.contentDigest !== assignment.before.contentDigest) rejection = "Provider claimed an unsubmitted turn but product source changed; reconcile the captured source before continuing";
  const db = new WorkflowDb(projectDir);
  try {
    db.atomic(() => {
      if (!rejection && !result.isError && !result.failure && ["done", "plan_complete"].includes(status.kind) && after) {
        try { assertBuilderContractCoverage(db, assignment.runId, assignment.ticketId, assignment.operationId, after.digest); }
        catch (error) { rejection = String(error); }
      }
      const responseDigest = db.putEvidence("qa", Buffer.from(result.rawResponse ?? result.text));
      const cleanedResponseDigest = db.putEvidence("qa", Buffer.from(result.cleanedResponse ?? result.text));
      const providerInstructionDigest = result.providerInstruction ? db.putEvidence("qa", Buffer.from(result.providerInstruction)) : undefined;
      db.updateOperation(assignment.operationId, result.failure?.dispatchState === "unknown" || result.isError && !result.failure?.dispatchState && status.kind === "unknown" ? "uncertain" : "confirmed", { result: { turnId:result.turnId, responseDigest, cleanedResponseDigest, providerInstructionDigest, providerMetadata: result.providerMetadata, dispatchState: result.failure?.dispatchState, status, rejection, sourceError, after: after ? retainSource(db, after) : undefined } });
      const admission = db.assertAdmittedWork(assignment.runId, assignment.ticketId);
      db.qaPreparationStore().metric(assignment.runId, assignment.ticketId, admission.requirementsDigest, `metric:builder-result:${assignment.operationId}`, "phase-observation", { phase: "builder", durationMs: Math.max(0, Date.now() - Date.parse(assignment.before.capturedAt)), costUsd: result.costAuthoritative ? result.costUsd : null, inputTokens: result.inputTokens ?? null, outputTokens: result.outputTokens ?? null });
      db.finishGuidance(assignment.guidanceIds, "builder", {submitted: result.failure?.dispatchState === "not-sent" ? false : result.turnId ? true : undefined, receipt: result.turnId ? {turnId:result.turnId,responseDigest,providerInstructionDigest,postSourceDigest:after?.digest} : undefined, applied: !rejection && status.kind === "done" && assignment.guidanceIds.every(id => result.text.includes(id))});
      if (rejection || sourceError) {
        const run = db.getRun(assignment.runId)!;
        db.transition(assignment.runId, { checkpoint: "build-assignment-rejected", state: { ...run.state, assignmentConflict: { operationId: assignment.operationId, ticketId: assignment.ticketId, worktree: assignment.worktree, responseDigest, rejection, sourceError } }, event: "build_assignment_rejected", payload: { operationId: assignment.operationId, ticketId: assignment.ticketId, returnedTicketId: status.ticket, responseDigest, rejection, sourceError } });
      }
    });
  } finally { db.close(); }
  if(!rejection&&!sourceError&&!result.isError&&status.kind==="done"&&after){try{queueGraphMaintenance(projectDir,assignment.worktree,assignment.operationId,result.text,after.contentDigest!==assignment.before.contentDigest);}catch(error){console.error(`Graph maintenance deferred: ${String(error)}`);}}
  return rejection ?? (sourceError ? `Builder source evidence is unavailable: ${sourceError}. Reconcile before continuing.` : undefined);
}

function retainSource(db: WorkflowDb, source: BuildSourceState): Record<string, unknown> {
  const staged = retainDiff(db, source.stagedDiff);
  const unstaged = retainDiff(db, source.unstagedDiff);
  return { digest: source.digest, head: source.head, captureMode: source.captureMode, omissions: source.omissions, contentDigest: source.contentDigest, capturedAt: source.capturedAt, pathInventory: source.pathInventory,
    stagedDiffDigest: staged.digest, stagedDiffChunks: staged.chunks, stagedDiffBytes: source.stagedDiff.length,
    unstagedDiffDigest: unstaged.digest, unstagedDiffChunks: unstaged.chunks, unstagedDiffBytes: source.unstagedDiff.length,
    untracked: source.untracked.map(file => { const evidence = retainDiff(db, file.bytes); return { path: file.path, mode: file.mode, kind: file.kind, digest: file.digest, evidenceDigest: evidence.digest, evidenceChunks: evidence.chunks, byteLength: file.bytes.length }; }) };
}

/** Preserve large product files without changing the shared per-item evidence limits. */
function retainDiff(db: WorkflowDb, bytes: Buffer): { digest?: string; chunks?: string[] } {
  if (bytes.length <= 16 * 1024 * 1024) return { digest: db.putEvidence("diff", bytes) };
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8 * 1024 * 1024) chunks.push(db.putEvidence("diff", bytes.subarray(offset, offset + 8 * 1024 * 1024)));
  return { chunks };
}

export function captureBuildSource(worktree: string): BuildSourceState {
  const head = spawnSync("git", ["-C", worktree, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (head.status === 0) return { ...captureFrozenQaSource(worktree), captureMode: "git" };
  if ((head.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT" && !/not a git repository|Needed a single revision|unknown revision/.test(head.stderr ?? "")) throw head.error ?? new Error(`Git source identity is unavailable: ${head.stderr}`);
  const capture = (): BuildSourceState => {
    const root = resolve(worktree);
    const untracked: FrozenQaSourceState["untracked"] = [];
    const ignored = new Set([".git", ".rafi", ".foreman", "node_modules"]);
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (ignored.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() || entry.isSymbolicLink()) {
          const kind = entry.isSymbolicLink() ? "symlink" : "file";
          const bytes = kind === "symlink" ? Buffer.from(readlinkSync(path)) : readFileSync(path);
          untracked.push({ path: relative(root, path).replace(/\\/g, "/"), kind, bytes, mode: lstatSync(path).mode, digest: createHash("sha256").update(bytes).digest("hex") });
        } else throw new Error(`Unsupported source path type: ${path}`);
      }
    };
    visit(root);
    const contentDigest = createHash("sha256").update(JSON.stringify(untracked.map(({ bytes: _, ...identity }) => identity))).digest("hex");
    return { digest: contentDigest, head: "unavailable", captureMode: "filesystem", omissions: ["Git baseline/diff unavailable: project is not a repository or has no first commit"], contentDigest, capturedAt: new Date().toISOString(),
      pathInventory: untracked.map(file => ({ path: file.path, staged: [], unstaged: [], untracked: { kind: file.kind, mode: file.mode, digest: file.digest } })), untracked, stagedDiff: Buffer.alloc(0), unstagedDiff: Buffer.alloc(0) };
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = capture(); const after = capture();
    if (before.digest === after.digest) return after;
  }
  throw new Error("Product source changed during assignment evidence capture; retry at a stable boundary");
}
