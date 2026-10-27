import { persistedProviderWireContract } from "rafi-spec";
import { markDispatchNotSent } from "./dispatchNotSent.js";
import { dispatchWithGraphAccess, withGraphSessionAccess } from "./graph/session.js";
import { localBuildAuthority, type BuildAdmission } from "./buildAdmission.js";
import { randomUUID, createHash } from "node:crypto";
import type { ContinuityCheckpoint, ContinuityDelta, ResolvedAgentSettings } from "rafi-spec";
import { continuityDeltaV1Schema, initializationOutput, providerWireContracts, providerWireContract, validateStructuredCandidate, type OperationResponse, zodIssues } from "rafi-spec";
import type { BuilderAdapter, CompactResult, ContextUsage, NativeAutoCompactionPolicy, NativeCompaction, ProviderSessionUsage, ProviderSettingSwitch, RuntimeFailure, TurnResult } from "./adapters/types.js";
import { BuilderEventQueue } from "./activity.js";
import { providerSessionKey } from "./sessionIdentity.js";
import { nativePolicy, operationInstruction, journalStructuredDispatch, continuationPolicy } from "./structuredOperation.js";
import type { BuilderHandoffRequest } from "./handoffs.js";
import { WorkflowDb } from "./workflowDb.js";
import { assertSealedDispatch, withFreshRecoveryValidation } from "./structuredDispatchAuthority.js";
import { verifyPersistedDispatch } from "./structuredDispatchRecord.js";


export class ContinuityValidationError extends Error {
  constructor(readonly problems: string[]) { super(`invalid continuity delta: ${problems.join("; ")}`); }
}

export class ContinuityRecoveryRequiredError extends Error {
  constructor(readonly runId: string, readonly role: "builder" | "qa", message: string) {
    super(`${message}; run rafi build:resume --run ${runId} --guided-recovery in a TTY`);
  }
}

/**
 * Exact-session loss is a host recovery boundary, never a continuity-repair
 * prompt. `guidedRecovery` is true when the provider may already have received
 * the frozen instruction, so a fresh successor must reconcile receipts first.
 */
export class SessionUnavailableContinuityError extends Error {
  readonly guidedRecovery: boolean;

  constructor(
    readonly runId: string,
    readonly role: "builder" | "qa",
    readonly failure: RuntimeFailure,
  ) {
    const guidedRecovery = failure.dispatchState === "unknown";
    super(guidedRecovery
      ? `the exact ${role} session became unavailable after dispatch may have begun; run rafi build:resume --run ${runId} --guided-recovery in a TTY`
      : `the exact ${role} session is unavailable before dispatch; inspect run ${runId} and choose fresh-with-handoff recovery`);
    this.name = "SessionUnavailableContinuityError";
    this.guidedRecovery = guidedRecovery;
  }
}

export const CONTINUITY_REQUIRED_INSTRUCTION = "Include the required bounded continuity object in the operation response; continuity cannot be null for this session.";

export function validateContinuityDelta(value: unknown): ContinuityDelta {
  const problems: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContinuityValidationError(["delta must be an object"]);
  const input = value as Record<string, unknown>;
  const contract = continuityDeltaV1Schema.safeParse(value);
  if (!contract.success) problems.push(...zodIssues(contract.error));
  if (input.version !== 1) problems.push("version must be 1");
  const output: ContinuityDelta = {
    version: 1,
    decisions: strings(input.decisions, "decisions", problems),
    constraints: strings(input.constraints, "constraints", problems),
    discoveries: strings(input.discoveries, "discoveries", problems),
    completedActions: strings(input.completedActions, "completedActions", problems),
    evidence: strings(input.evidence, "evidence", problems),
    failures: strings(input.failures, "failures", problems),
    blockers: strings(input.blockers, "blockers", problems),
    openWork: strings(input.openWork, "openWork", problems),
    nextAction: typeof input.nextAction === "string" ? clean(input.nextAction, 4_000) : "",
  };
  if (!output.nextAction) problems.push("nextAction must be a non-empty string");
  if (JSON.stringify(output).length > 64_000) problems.push("delta exceeds 64 KiB");
  if (problems.length) throw new ContinuityValidationError(problems);
  return output;
}

export function mergeContinuityDeltas(deltas: readonly ContinuityDelta[]): ContinuityDelta {
  const result = baselineContinuityDelta();
  for (const delta of deltas) {
    for (const key of ["decisions", "constraints", "discoveries", "completedActions", "evidence", "failures", "blockers", "openWork"] as const) {
      result[key] = unique([...result[key], ...delta[key]]).slice(-500);
    }
    if (delta.nextAction) result.nextAction = delta.nextAction;
  }
  return result;
}

export function baselineContinuityDelta(nextAction = "Await the first role action."): ContinuityDelta {
  return { version: 1, decisions: [], constraints: [], discoveries: [], completedActions: [], evidence: [], failures: [], blockers: [], openWork: [], nextAction };
}

export interface ContinuityAdapterOptions {
  adapter: BuilderAdapter;
  projectDir: string;
  runId: string;
  role: "builder" | "qa";
  settings: ResolvedAgentSettings;
  authoritativeStateRevision?: () => number;
  /** Fresh successor creation after the same-session repair also fails. */
  createSuccessor?: (handoff: string) => Promise<BuilderAdapter>;
  /**
   * Production recovery path for a double-invalid delta. The callback must
   * publish a versioned handoff, validate a genuinely fresh successor, and
   * move the role lease before returning it.
   */
  recoverWithHandoff?: (input: { reason: string; reconstruction: string; predecessor: BuilderAdapter }) => Promise<BuilderAdapter>;
  /** Explicit compatibility recovery may replace a dead predecessor lease only after its first valid checkpoint. */
  replaceRecoveryLeaseAfterCheckpoint?: boolean;
  /** Host-owned validated Builder handoff request processing at a safe turn boundary. */
  handleHandoffRequest?: (text: string | BuilderHandoffRequest, predecessor: BuilderAdapter, frozenAction: string) => Promise<BuilderAdapter | undefined>;
  /** QA journals each provider turn separately; wrappers must not repair or redispatch inside one host turn. */
  durableSingleTurn?: boolean;
}

/** Enforces a durable role checkpoint after every completed provider turn. */
export class ContinuityAdapter implements BuilderAdapter {
  private adapter: BuilderAdapter;
  contractCapabilities() { return this.adapter.contractCapabilities?.() ?? { sameSessionAcceptance: false, nativeCompactionBarrier: false }; }
  private contractEnforcing = false;
  enableContractEnforcement(): void { this.contractEnforcing = true; this.adapter.enableContractEnforcement?.(); }
  contractCompactionSequence(): number { return this.adapter.contractCompactionSequence?.() ?? 0; }
  acceptContractDelivery(sequence: number): void { this.adapter.acceptContractDelivery?.(sequence); }
  configureQaContractReminder(reminder: string, onEvent?: Parameters<NonNullable<BuilderAdapter["configureQaContractReminder"]>>[1]): void { this.adapter.configureQaContractReminder?.(reminder, onEvent); }

  private readonly queue = new BuilderEventQueue();
  private sourcePump?: Promise<void>;
  private recoveryLeasePending: boolean;
  private validatingFreshRecovery = false;
  private readonly buildAuthority?: BuildAdmission;

  constructor(private readonly options: ContinuityAdapterOptions) {
    this.adapter = options.adapter;
    this.buildAuthority = localBuildAuthority(options.projectDir);
    this.recoveryLeasePending = Boolean(options.replaceRecoveryLeaseAfterCheckpoint);
    const db = new WorkflowDb(options.projectDir);
    try {
      db.ensureRun(options.runId);
      if (!db.continuityHead(options.runId, options.role)) {
        db.appendContinuityEvent({ runId: options.runId, role: "host", kind: "role_baseline", payload: { role: options.role, provider: options.settings.make, model: options.settings.model }, authoritativeStateRevision: this.revision() });
        db.publishContinuityCheckpoint({ runId: options.runId, role: options.role, delta: baselineContinuityDelta(), hostEventKind: "role-baseline", inputCheckpointDigests: [], authoritativeStateRevision: this.revision() });
      }
      const initialSession = options.adapter.sessionRef?.() ?? options.adapter.sessionId();
      if (initialSession) db.claimInitialRoleLease(options.runId, options.role, initialSession);
    } finally { db.close(); }
    this.pumpEvents();
  }

  /** Establish an explicitly requested fresh owner before context probes or work. */
  async validateFreshRecovery(): Promise<void> {
    if (!this.recoveryLeasePending) return;
    const db = new WorkflowDb(this.options.projectDir);
    let owner;
    try { owner = db.roleMutationLease(this.options.runId, this.options.role); } finally { db.close(); }
    const current = this.adapter.sessionRef?.();
    if (!owner || (current && owner.sessionKey === providerSessionKey(current))) { this.recoveryLeasePending = false; return; }
    this.validatingFreshRecovery = true;
    try {
      const result = await withFreshRecoveryValidation(this.options.projectDir, this.options.runId, this.options.role, authorization =>
        this.sendTurn("Fresh recovery validation only. Do not use tools, change files, implement work, or request a handoff. Acknowledge this new session and include the required continuity object. " + operationInstruction(initializationOutput), nativePolicy(initializationOutput, { responseOnly: true, journalRunId: this.options.runId, dispatchId: `fresh-recovery:${authorization.decisionDigest}` })));
      if (result.isError || result.failure || this.recoveryLeasePending) throw new ContinuityRecoveryRequiredError(this.options.runId, this.options.role, "fresh recovery did not establish a valid continuity checkpoint");
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    } finally { this.validatingFreshRecovery = false; }
  }

  get agent(): "claude" | "codex" { return this.adapter.agent; }

  /** Every confirmed dispatch publishes a checkpoint, so continuity is mandatory. */
  structuredDispatchRequirement(): import("./adapters/types.js").StructuredDispatchRequirement {
    return { instruction: CONTINUITY_REQUIRED_INSTRUCTION, validate: response => { validateContinuityDelta(response.continuity); } };
  }

  async sendTurn(instruction: string, policy?: import("./adapters/types.js").TurnRequest): Promise<TurnResult> {
    if (!policy?.output) throw new Error("Continuity dispatch requires a native operation contract");
    if (policy.dispatchCapability) {
      assertSealedDispatch(this.options.projectDir, policy.dispatchCapability, policy.selectedDispatch, instruction);
      return this.sendTurnOwned(instruction, policy);
    }
    // The continuity requirement is applied by journalStructuredDispatch through
    // structuredDispatchRequirement(), before sealing, on every dispatch path.
    const hostInstruction = instruction;
    return withGraphSessionAccess(this.options.projectDir, this.adapter, () => policy?.output
      ? journalStructuredDispatch(this.options.projectDir, this, instruction, { ...policy, journalRunId: policy.journalRunId ?? this.options.runId }, (text, selected) => this.sendTurnOwned(text, selected))
      : this.sendTurnOwned(instruction, policy)).then(result => {
        if (result.failure?.category === "session-unavailable") {
          this.recordSessionUnavailable(result.failure, hostInstruction);
          throw new SessionUnavailableContinuityError(this.options.runId, this.options.role, result.failure);
        }
        return { ...result, hostInstruction };
      });
  }
  private async sendTurnOwned(instruction: string, policy?: import("./adapters/types.js").TurnRequest): Promise<TurnResult> {
    const providerInstruction = instruction;
    const journal = new WorkflowDb(this.options.projectDir);
    const dispatchId = policy?.dispatchId ?? `dispatch:${this.options.runId}:${this.options.role}:${randomUUID()}`;
    const beforeSession = this.adapter.sessionRef?.();
    let original: TurnResult;
    try {
      try { journal.atomic(() => {
        if (this.buildAuthority) journal.assertBuildAdmission(this.buildAuthority);
        else if (journal.buildAdmission()) throw new ContinuityRecoveryRequiredError(this.options.runId, this.options.role, "dispatch requires original build admission authority");
        if (process.send && process.env.RAFI_BUILD_WORKER_RUN === this.options.runId) {
          const supervisor = journal.supervisorState(this.options.runId);
          if (!process.connected || supervisor?.status !== "running" || supervisor.workerGeneration !== Number(process.env.RAFI_BUILD_WORKER_GENERATION)) throw new ContinuityRecoveryRequiredError(this.options.runId, this.options.role, "supervised worker no longer owns dispatch authority");
        }
        const owner = journal.roleMutationLease(this.options.runId, this.options.role);
        const ref = this.adapter.sessionRef?.();
        const session = ref?.sessionId ?? this.adapter.sessionId();
        if (!(this.validatingFreshRecovery && this.recoveryLeasePending && policy?.responseOnly) && owner && session && (owner.providerSessionId !== session || (owner.sessionKey && ref && owner.sessionKey !== providerSessionKey(ref)))) {
          throw new ContinuityRecoveryRequiredError(this.options.runId, this.options.role, "provider session no longer owns role dispatch authority");
        }
        if (journal.unresolvedRoleDispatches(this.options.runId, this.options.role).filter(item => item.idempotencyKey !== dispatchId).length) throw new ContinuityRecoveryRequiredError(this.options.runId, this.options.role, "a previous dispatched turn has no durable completion; reconcile it before sending more work");
        if (!policy?.selectedDispatch) journal.planOperation({ runId: this.options.runId, idempotencyKey: dispatchId, kind: "provider-dispatch", intent: { role: this.options.role, sessionRef: this.adapter.sessionRef?.(), instructionDigest: sha(instruction), instructionBytes: Buffer.byteLength(instruction) } });
        if (!policy?.selectedDispatch) journal.updateOperation(dispatchId, "in_progress");
        journal.appendContinuityEvent({ runId: this.options.runId, role: "host", kind: "turn_started", payload: { role: this.options.role, dispatchId, instructionDigest: sha(instruction), instructionBytes: Buffer.byteLength(instruction) }, authoritativeStateRevision: this.revision() });
      }); } catch (error) { throw markDispatchNotSent(error); }
      try { original = await dispatchWithGraphAccess(this.options.projectDir, this.adapter, providerInstruction, policy, (text, p) => this.adapter.sendTurn(text, p)); }
      catch (error) { if (!policy?.selectedDispatch) journal.updateOperation(dispatchId, "uncertain", { error: String(error) }); throw error; }
      // Preserve the native transport result before interpreting it or publishing
      // a checkpoint. The outer journal remains the sole completion owner.
      // journalStructuredDispatch owns the one retained raw receipt for native
      // turns. Continuity records retain only its durable reference/fact.
      const responseDigest = policy?.selectedDispatch ? undefined : journal.putEvidence("handoff", Buffer.from(JSON.stringify(original)));
      journal.atomic(() => {
        journal.appendContinuityEvent({ runId: this.options.runId, role: this.options.role, kind: "provider_response_received",
          payload: { dispatchId, ...(responseDigest ? { responseDigest } : { journalOwnedEvidence: true }) }, authoritativeStateRevision: this.revision() });
        if (!policy?.selectedDispatch) journal.updateOperation(dispatchId, original.failure?.dispatchState === "unknown" ? "uncertain" : original.failure?.dispatchState === "not-sent" ? "failed" : "confirmed", { result: { responseDigest, isError: original.isError, failure: original.failure, turnId: original.turnId, sessionRef: this.adapter.sessionRef?.() } });
        if (original.failure?.dispatchState === "not-sent") journal.appendContinuityEvent({ runId: this.options.runId, role: this.options.role, kind: "turn_not_sent", payload: { dispatchId, role: this.options.role }, authoritativeStateRevision: this.revision() });
      });
    } finally { journal.close(); }
    return original;
  }

  async postConfirmedDispatch(reference: import("./adapters/types.js").ConfirmedDispatchReference): Promise<TurnResult> {
    const db = new WorkflowDb(this.options.projectDir);
    let original: TurnResult;
    let context: ReturnType<WorkflowDb["structuredProcessingContext"]>;
    let response: OperationResponse;
    try {
      const operation = db.operation(reference.dispatchId);
      if (operation?.runId !== this.options.runId || reference.runId !== this.options.runId || db.structuredOwnerDispatch(reference.dispatchId).tupleDigest !== reference.tupleDigest)
        throw new Error("Continuity postprocessing belongs to a foreign dispatch");
      original = db.retainedStructuredTurn(reference.dispatchId);
      context = db.structuredProcessingContext(reference.dispatchId);
      const tuple = original.selectedDispatch!;
      const contract = persistedProviderWireContract(tuple)!.canonical;
      response = db.replayStructuredDispatch(reference.dispatchId, contract) as OperationResponse;
    } finally { db.close(); }
    const delta = validateContinuityDelta(response.continuity);
    if (this.recoveryLeasePending && (response.result.kind !== "completed" || !(response.result.payload as { ready?: boolean }).ready))
      throw new Error("Fresh recovery requires a completed initialization checkpoint");
    if (!context.policy.handback) {
      this.publish(delta, "turn_completed", original);
    }
    if (response.result.kind === "handoff-request") {
      if (context.policy.handback || this.options.durableSingleTurn || this.validatingFreshRecovery) throw new Error("This operation cannot transfer its session");
      // Publication is complete before the explicitly linked acceptance stage.
      const completed = new WorkflowDb(this.options.projectDir);
      try { completed.beginStructuredHandoff(reference.dispatchId); completed.completeStructuredPostprocessing(reference.dispatchId); } finally { completed.close(); }
      const successor = await this.options.handleHandoffRequest?.({ version: 1, reason: response.result.reason, roleState: response.result.roleState, delta, predecessorDispatchId: reference.dispatchId }, this.adapter, context.instruction);
      if (!successor || successor === this.adapter) throw new Error("Handoff request did not establish a validated successor");
      const continuation = new WorkflowDb(this.options.projectDir);
      let continuationId: string;
      try {
        const session = successor.sessionRef?.();
        if (!session) throw new Error("Handoff successor has no scoped session");
        continuationId = continuation.planStructuredContinuation(reference.dispatchId, session);
      } finally { continuation.close(); }
      await this.adoptValidatedSuccessor(successor);
      const tuple = original.selectedDispatch!;
      const output = persistedProviderWireContract(tuple)!.canonical;
      return this.sendTurn("Continue the frozen action after the accepted handoff. Reconcile receipts; do not repeat completed side effects.\n" + context.instruction,
        nativePolicy(output, { ...continuationPolicy(context.policy, reference.dispatchId), dispatchId: continuationId }));
    }
    return { ...original, hostInstruction: context.instruction, continuityErrors: [], continuity: delta };
  }

  observeEvents(listener: (event: import("./adapters/types.js").BuilderEvent) => void): () => void {
    if (!this.adapter.observeEvents) throw new Error("wrapped provider does not expose turn observation");
    return this.adapter.observeEvents(listener);
  }
  acceptHandbackTurn(turn: TurnResult): void {
    if (turn.structured) {
      if (turn.isError || turn.failure || turn.structured.state !== "candidate") throw new Error("cannot publish an invalid handback checkpoint");
      const db = new WorkflowDb(this.options.projectDir);
      let retained: TurnResult;
      try { if (!turn.selectedDispatch || db.operation(turn.selectedDispatch.dispatchId)?.runId !== this.options.runId) throw new Error("Foreign handback dispatch"); retained = db.retainedStructuredTurn(turn.selectedDispatch.dispatchId); }
      finally { db.close(); }
      const tuple = retained.selectedDispatch!;
      const owner = new WorkflowDb(this.options.projectDir);
      try {
        const response = verifyPersistedDispatch(persistedProviderWireContract(tuple)!.canonical, owner.structuredOwnerDispatch(tuple.dispatchId), retained.structured, tuple) as OperationResponse;
        this.publish(validateContinuityDelta(response.continuity), "handback_turn_completed", retained);
      } finally { owner.close(); }
      return;
    }
    throw new Error("Handback acceptance requires a native receipt and validated continuity");
  }

  /** Explicit restart recovery of the already accepted action; never repeats acceptance. */
  async resumePlannedContinuation(): Promise<TurnResult | undefined> {
    const db = new WorkflowDb(this.options.projectDir);
    let continuation: ReturnType<WorkflowDb["structuredContinuation"]>;
    let context: ReturnType<WorkflowDb["structuredProcessingContext"]>;
    let output: import("rafi-spec").OutputContract;
    try {
      continuation = db.structuredContinuation(this.options.runId,this.options.role);
      if (!continuation) return;
      const operation = db.operation(continuation.continuationId);
      if (operation?.status === "confirmed") {
        if (db.pendingStructuredPostprocessing(this.options.runId).includes(continuation.continuationId)) {
          await this.postConfirmedDispatch({ dispatchId: continuation.continuationId, runId: this.options.runId,
            tupleDigest: db.structuredOwnerDispatch(continuation.continuationId).tupleDigest });
          db.completeStructuredPostprocessing(continuation.continuationId);
          db.finishStructuredContinuation(continuation.continuationId);
        }
        const turn = db.retainedStructuredTurn(continuation.continuationId);
        const descriptor = persistedProviderWireContract(turn.selectedDispatch!);
        const response = db.replayStructuredDispatch(continuation.continuationId,descriptor.canonical) as OperationResponse;
        return {...turn,continuity:validateContinuityDelta(response.continuity)};
      }
      if (continuation.state !== "continuation-planned" || operation && operation.status !== "planned") throw new Error("Continuation may already have been submitted; explicit reconciliation is required");
      const current = this.adapter.sessionRef?.();
      if (!current || providerSessionKey(current) !== providerSessionKey(continuation.successor)) throw new Error("Reattach the durably accepted successor before continuation recovery");
      context = db.structuredProcessingContext(continuation.predecessorId);
      const predecessor = db.retainedStructuredTurn(continuation.predecessorId);
      output = persistedProviderWireContract(predecessor.selectedDispatch!).canonical;
    } finally {db.close();}
    return this.sendTurn("Continue the frozen action after the accepted handoff. Reconcile receipts; do not repeat completed side effects.\n"+context.instruction,
      nativePolicy(output,{...continuationPolicy(context.policy,continuation.predecessorId),dispatchId:continuation.continuationId}));
  }

  async recoverConfirmedPublications(): Promise<void> {
    const db = new WorkflowDb(this.options.projectDir);
    let pending: string[];
    try { pending = db.pendingStructuredPostprocessing(this.options.runId); } finally { db.close(); }
    for (const dispatchId of pending) {
      const current = new WorkflowDb(this.options.projectDir);
      let reference: import("./adapters/types.js").ConfirmedDispatchReference;
      try { reference = {dispatchId, runId:this.options.runId, tupleDigest:current.structuredOwnerDispatch(dispatchId).tupleDigest}; } finally { current.close(); }
      await this.postConfirmedDispatch(reference);
      const completed = new WorkflowDb(this.options.projectDir);
      try { completed.completeStructuredPostprocessing(dispatchId); completed.finishStructuredContinuation(dispatchId); } finally { completed.close(); }
    }
  }

  sessionId(): string | undefined { return this.adapter.sessionId(); }
  sessionRef(): import("rafi-spec").ProviderSessionRefV1 | undefined { return this.adapter.sessionRef?.(); }
  prepareSession(): Promise<import("rafi-spec").ProviderSessionRefV1> {
    if (!this.adapter.prepareSession) return Promise.reject(new Error("wrapped adapter cannot establish a provider session without a work turn"));
    return this.adapter.prepareSession();
  }
  adoptSessionRef(ref: import("rafi-spec").ProviderSessionRefV1): void { this.adapter.adoptSessionRef?.(ref); }
  validateSession(): Promise<import("rafi-spec").SessionAvailabilityV1> { return this.adapter.validateSession?.() ?? Promise.resolve({ version: 1, status: "unknown", checkedAt: new Date().toISOString(), reason: "legacy-unscoped" }); }
  compact(): Promise<CompactResult> { return this.adapter.compact ? this.adapter.compact() : Promise.resolve({ ok: false, error: "provider adapter does not expose native compaction" }); }
  prepareAutoCompaction(thresholdPercent?: number): Promise<NativeAutoCompactionPolicy | void> { return this.adapter.prepareAutoCompaction?.(thresholdPercent) ?? Promise.resolve(); }
  requiresAutoCompactionSetupTurn(): boolean { return this.adapter.requiresAutoCompactionSetupTurn?.() ?? false; }
  autoCompactionPolicy(): NativeAutoCompactionPolicy | undefined { return this.adapter.autoCompactionPolicy?.(); }
  drainNativeCompactions(): import("./adapters/types.js").NativeCompaction[] { return this.adapter.drainNativeCompactions?.() ?? []; }
  restoreNativeCompactions(compactions: NativeCompaction[]): void { this.adapter.restoreNativeCompactions?.(compactions); }
  contextUsageAfterNativeCompaction(compaction: NativeCompaction): Promise<ContextUsage | undefined> { return this.adapter.contextUsageAfterNativeCompaction?.(compaction) ?? Promise.resolve(undefined); }
  contextUsage(): Promise<ContextUsage | undefined> { return this.adapter.contextUsage?.() ?? Promise.resolve(undefined); }
  graphRuntimeSettings() { return this.adapter.graphRuntimeSettings?.(); }
  sessionUsage(): Promise<ProviderSessionUsage | undefined> { return this.adapter.sessionUsage?.() ?? Promise.resolve(undefined); }
  switchSettings(settings: ProviderSettingSwitch): Promise<CompactResult> { return this.adapter.switchSettings ? this.adapter.switchSettings(settings) : Promise.resolve({ ok: false, error: "provider adapter does not support settings changes" }); }
  events(): AsyncIterable<import("./adapters/types.js").BuilderEvent> { return this.queue; }
  async close(): Promise<void> { await this.adapter.close(); await this.sourcePump?.catch(() => {}); this.queue.close(); }

  /** Keep the observable wrapper and event stream stable while moving to an accepted successor. */
  async adoptValidatedSuccessor(successor: BuilderAdapter): Promise<void> {
    if (this.contractEnforcing) {
      successor.enableContractEnforcement?.();
      if (successor !== this.adapter) await successor.close().catch(() => {});
      throw new ContinuityRecoveryRequiredError(this.options.runId, this.options.role, "Replacement Builder requires host contract delivery before any continuation; completed turn must be reconciled without automatic replay");
    }
    if (successor === this.adapter) return;
    const prior = this.adapter;
    await prior.close();
    this.adapter = successor;
    const db = new WorkflowDb(this.options.projectDir);
    try { db.appendContinuityEvent({ runId: this.options.runId, role: this.options.role, kind: "handoff_adopted", payload: { predecessorSessionId: prior.sessionId(), successorSessionId: successor.sessionId(), sessionRef: successor.sessionRef?.() }, authoritativeStateRevision: this.revision(), sessionRef: successor.sessionRef?.() }); }
    finally { db.close(); }
    this.pumpEvents();
  }

  private publish(delta: ContinuityDelta, kind: string, result: TurnResult): ContinuityCheckpoint {
    const db = new WorkflowDb(this.options.projectDir);
    try {
      const sessionRef = this.adapter.sessionRef?.();
      let moved = false;
      const checkpoint = db.atomic(() => {
        if (this.recoveryLeasePending && sessionRef) db.assertFreshRecoveryValidation(result.selectedDispatch!.dispatchId, sessionRef);
        const prior = db.providerCheckpoint(result.selectedDispatch!.dispatchId, kind);
        if (prior) {
          if (JSON.stringify(prior.delta) !== JSON.stringify(delta)) throw new Error("Conflicting repeated continuity publication");
          return prior;
        }
        db.appendContinuityEvent({ runId: this.options.runId, role: this.options.role, kind, payload: { dispatchId: result.selectedDispatch!.dispatchId, isError: result.isError, numTurns: result.numTurns, sessionId: this.adapter.sessionId(), sessionRef, delta }, authoritativeStateRevision: this.revision(), sessionRef });
        const published = db.publishContinuityCheckpoint({ runId: this.options.runId, role: this.options.role, delta, authoritativeStateRevision: this.revision(), sessionRef, origin: { kind: "provider", dispatchId: result.selectedDispatch!.dispatchId, publicationKind: kind } });
        if (this.recoveryLeasePending && sessionRef) {
          db.moveRoleLeaseAfterValidatedRecovery(this.options.runId, this.options.role, sessionRef, "explicit fresh-recovery-only continuation");
          moved = true;
        }
        return published;
      });
      if (moved) this.recoveryLeasePending = false;
      return checkpoint;
    } finally { db.close(); }
  }

  private recordSessionUnavailable(failure: RuntimeFailure, instruction: string): void {
    const sessionRef = this.adapter.sessionRef?.();
    const db = new WorkflowDb(this.options.projectDir);
    try {
      db.appendContinuityEvent({
        runId: this.options.runId,
        role: "host",
        kind: "session_unavailable",
        payload: {
          role: this.options.role,
          phase: failure.phase,
          dispatchState: failure.dispatchState ?? "unknown",
          reason: failure.availability?.reason,
          detail: failure.diagnostics,
          instructionDigest: sha(instruction),
        },
        authoritativeStateRevision: this.revision(),
        sessionRef,
      });
      if (failure.dispatchState === "unknown") {
        db.setContinuityHeadState(this.options.runId, this.options.role, "degraded");
      }
    } finally { db.close(); }
  }

  private revision(): number { return this.options.authoritativeStateRevision?.() ?? this.options.settings.settings_revision; }

  private pumpEvents(): void {
    const source = this.adapter;
    this.sourcePump = (async () => {
      try { for await (const event of source.events()) {
        this.queue.push(event);
        // Continuity stores only recovery-relevant transitions. High-rate tool
        // and context telemetry belongs exclusively to observability.
        if (event.kind === "session-transition") {
          const db = new WorkflowDb(this.options.projectDir);
          try {
            const payload = event;
            db.appendContinuityEvent({ runId: this.options.runId, role: "host", kind: `provider_${event.kind.replace(/-/g, "_")}`, payload, authoritativeStateRevision: this.revision() });
          } finally { db.close(); }
        }
      } }
      catch (error) { this.queue.push({ kind: "error", message: error instanceof Error ? error.message : String(error) }); }
    })();
  }
}

function strings(value: unknown, field: string, problems: string[]): string[] {
  if (!Array.isArray(value)) { problems.push(`${field} must be an array`); return []; }
  if (value.length > 500) problems.push(`${field} exceeds 500 entries`);
  const result: string[] = [];
  for (const entry of value.slice(0, 500)) {
    if (typeof entry !== "string" || !entry.trim()) problems.push(`${field} entries must be non-empty strings`);
    else result.push(clean(entry, 4_000));
  }
  return unique(result);
}

function clean(value: string, maximum: number): string {
  return value.replace(/\b(sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|password)\s*[:=]\s*\S+)/gi, "[REDACTED]").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, maximum);
}
function unique(values: string[]): string[] { return [...new Set(values)]; }
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
