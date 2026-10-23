import { dispatchWithGraphAccess, withGraphSessionAccess } from "./graph/session.js";
import { localBuildAuthority, type BuildAdmission } from "./buildAdmission.js";
import { randomUUID, createHash } from "node:crypto";
import type { ContinuityCheckpoint, ContinuityDelta, ResolvedAgentSettings } from "rafi-spec";
import { continuityDeltaV1Schema, initializationOutput, providerWireContract, validateStructuredCandidate, type OperationResponse, zodIssues } from "rafi-spec";
import type { BuilderAdapter, CompactResult, ContextUsage, NativeAutoCompactionPolicy, NativeCompaction, ProviderSessionUsage, ProviderSettingSwitch, RuntimeFailure, TurnResult } from "./adapters/types.js";
import { BuilderEventQueue } from "./activity.js";
import { providerSessionKey } from "./sessionIdentity.js";
import { nativePolicy, operationInstruction, journalStructuredDispatch } from "./structuredOperation.js";
import type { BuilderHandoffRequest } from "./handoffs.js";
import { WorkflowDb } from "./workflowDb.js";

export const CONTINUITY_MARKER = "RAFI_CONTINUITY_DELTA:";

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

export function parseContinuityDelta(text: string): { delta?: ContinuityDelta; cleanText: string; error?: ContinuityValidationError } {
  const lines = text.split(/\r?\n/);
  const markerIndexes = lines.flatMap((line, index) => line.trimStart().startsWith(CONTINUITY_MARKER) ? [index] : []);
  const cleanText = lines.filter((_line, index) => !markerIndexes.includes(index)).join("\n").trimEnd();
  if (markerIndexes.length !== 1) return { cleanText, error: new ContinuityValidationError([markerIndexes.length ? "multiple continuity markers" : "missing continuity marker"]) };
  const raw = lines[markerIndexes[0]!]!.trimStart().slice(CONTINUITY_MARKER.length).trim();
  try { return { delta: validateContinuityDelta(JSON.parse(raw)), cleanText }; }
  catch (error) { return { cleanText, error: error instanceof ContinuityValidationError ? error : new ContinuityValidationError([`marker is not valid JSON: ${String(error)}`]) }; }
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

export function continuityInstruction(role?: "builder" | "qa"): string {
  return [
    "Before your final STEP_STATUS line (or as the final line when STEP_STATUS is not requested), emit exactly one single-line continuity record:",
    `${CONTINUITY_MARKER} {"version":1,"decisions":[],"constraints":[],"discoveries":[],"completedActions":[],"evidence":[],"failures":[],"blockers":[],"openWork":[],"nextAction":"specific next action"}`,
    "The continuity record is JSON. A requested STEP_STATUS line is separate plain text: never add JSON braces, a trailing comma, or a code fence to that status line.",
    ...(role === "qa" ? ["QA protocol: this continuity record is required even when the review requests only a report or status. Put it before RAFI_QA_FAILURE_REPORT_START when returning a failure envelope, outside the report JSON. Rafi strips the record before validating the report, so keep the report envelope immediately followed by STEP_STATUS."] : []),
    "Keep it concise and cumulative for facts learned this turn. Do not include credentials, hidden reasoning, or raw transcripts.",
  ].join("\n");
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
        db.publishContinuityCheckpoint({ runId: options.runId, role: options.role, delta: baselineContinuityDelta(), authoritativeStateRevision: this.revision() });
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
      const result = await this.sendTurn("Fresh recovery validation only. Do not use tools, change files, implement work, or request a handoff. Acknowledge this new session and include the required continuity object. " + operationInstruction(initializationOutput), nativePolicy(initializationOutput, { responseOnly: true, journalRunId: this.options.runId }));
      if (result.isError || result.failure || this.recoveryLeasePending) throw new ContinuityRecoveryRequiredError(this.options.runId, this.options.role, "fresh recovery did not establish a valid continuity checkpoint");
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    } finally { this.validatingFreshRecovery = false; }
  }

  get agent(): "claude" | "codex" { return this.adapter.agent; }

  async sendTurn(instruction: string, policy?: import("./adapters/types.js").TurnPolicy): Promise<TurnResult> {
    if (!policy?.output) throw new Error("Continuity dispatch requires a native operation contract");
    return withGraphSessionAccess(this.options.projectDir, this.adapter, () => policy?.output && !policy.journaled
      ? journalStructuredDispatch(this.options.projectDir, this.adapter, instruction, { ...policy, journalRunId: policy.journalRunId ?? this.options.runId, journalRole: this.options.role }, (text, selected) => this.sendTurnOwned(text, selected))
      : this.sendTurnOwned(instruction, policy));
  }
  private async sendTurnOwned(instruction: string, policy?: import("./adapters/types.js").TurnPolicy): Promise<TurnResult> {
    const providerInstruction = `${instruction}\n\nInclude the required bounded continuity object in the operation response; continuity cannot be null for this session.`;
    const journal = new WorkflowDb(this.options.projectDir);
    const dispatchId = policy?.dispatchId ?? `dispatch:${this.options.runId}:${this.options.role}:${randomUUID()}`;
    const beforeSession = this.adapter.sessionRef?.();
    let original: TurnResult;
    try {
      journal.atomic(() => {
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
        if (!policy?.journaled) journal.planOperation({ runId: this.options.runId, idempotencyKey: dispatchId, kind: "provider-dispatch", intent: { role: this.options.role, sessionRef: this.adapter.sessionRef?.(), instructionDigest: sha(instruction), instructionBytes: Buffer.byteLength(instruction) } });
        if (!policy?.journaled) journal.updateOperation(dispatchId, "in_progress");
        journal.appendContinuityEvent({ runId: this.options.runId, role: "host", kind: "turn_started", payload: { role: this.options.role, dispatchId, instructionDigest: sha(instruction), instructionBytes: Buffer.byteLength(instruction) }, authoritativeStateRevision: this.revision() });
      });
      try { original = await dispatchWithGraphAccess(this.options.projectDir, this.adapter, providerInstruction, policy, (text, p) => this.adapter.sendTurn(text, p)); }
      catch (error) { if (!policy?.journaled) journal.updateOperation(dispatchId, "uncertain", { error: String(error) }); throw error; }
      // Preserve the native transport result before interpreting it or publishing
      // a checkpoint. The outer journal remains the sole completion owner.
      // journalStructuredDispatch owns the one retained raw receipt for native
      // turns. Continuity records retain only its durable reference/fact.
      const responseDigest = policy?.journaled ? undefined : journal.putEvidence("handoff", Buffer.from(JSON.stringify(original)));
      journal.atomic(() => {
        journal.appendContinuityEvent({ runId: this.options.runId, role: this.options.role, kind: "provider_response_received",
          payload: { dispatchId, ...(responseDigest ? { responseDigest } : { journalOwnedEvidence: true }) }, authoritativeStateRevision: this.revision() });
        if (!policy?.journaled) journal.updateOperation(dispatchId, original.failure?.dispatchState === "unknown" ? "uncertain" : original.failure?.dispatchState === "not-sent" ? "failed" : "confirmed", { result: { responseDigest, isError: original.isError, failure: original.failure, turnId: original.turnId, sessionRef: this.adapter.sessionRef?.() } });
        if (original.failure?.dispatchState === "not-sent") journal.appendContinuityEvent({ runId: this.options.runId, role: this.options.role, kind: "turn_not_sent", payload: { dispatchId, role: this.options.role }, authoritativeStateRevision: this.revision() });
      });
    } finally { journal.close(); }
    if (original.failure?.category === "session-unavailable") {
      this.recordSessionUnavailable(original.failure, instruction);
      throw new SessionUnavailableContinuityError(this.options.runId, this.options.role, original.failure);
    }
    const observedSession = this.adapter.sessionRef?.() ?? this.adapter.sessionId();
    if (observedSession && !this.recoveryLeasePending) {
      const leases = new WorkflowDb(this.options.projectDir);
      try { leases.claimInitialRoleLease(this.options.runId, this.options.role, observedSession); } finally { leases.close(); }
    }
    if (policy?.output) {
      if (original.isError || original.failure) return original;
      try {
        const currentSession = this.adapter.sessionRef?.();
        const expectedWire = policy.wireContract ?? providerWireContract(policy.output, this.adapter.agent, "default", { requireRegistered: true });
        if (original.structured?.state !== "candidate" || original.structured.dispatchId !== dispatchId ||
          original.structured.sessionId !== this.adapter.sessionId() || original.structured.profile !== expectedWire.profile ||
          original.structured.wireContractDigest !== expectedWire.descriptorDigest || original.structured.wireSchemaDigest !== expectedWire.wireSchemaDigest ||
          original.structured.wireVariant !== expectedWire.variant ||
          beforeSession && currentSession && (beforeSession.sessionId !== currentSession.sessionId || beforeSession.generation !== currentSession.generation)) {
          throw new Error("Continuity receipt does not match the dispatched provider session");
        }
        const response = validateStructuredCandidate(policy.output, original.structured) as OperationResponse;
        const delta = validateContinuityDelta(response.continuity);
        if (!policy.handback) {
          this.publish(delta, "turn_completed", original);
          this.moveRecoveryLeaseAfterCheckpoint();
        }
        if (response.result.kind === "handoff-request") {
          if (policy.handback || this.options.durableSingleTurn || this.validatingFreshRecovery) throw new Error("This operation cannot transfer its session");
          const successor = await this.options.handleHandoffRequest?.({ version: 1, reason: response.result.reason, roleState: response.result.roleState, delta }, this.adapter, instruction);
          if (!successor || successor === this.adapter) throw new Error("Handoff request did not establish a validated successor");
          await this.adoptValidatedSuccessor(successor);
          return this.sendTurn("Continue the frozen action after the accepted handoff. Reconcile receipts; do not repeat completed side effects.\n" + instruction,
            nativePolicy(policy.output, { ...policy, dispatchId: randomUUID(), parentDispatchId: dispatchId, journaled: false }));
        }
        return { ...original, hostInstruction: instruction, continuityErrors: [], continuity: delta };
      } catch (error) {
        // No suffix repair or automatic fresh-session handoff on the native path.
        return { ...original, isError: true, continuityErrors: [String(error)] };
      }
    }
    throw new Error("Missing native continuity operation contract");
  }

  observeEvents(listener: (event: import("./adapters/types.js").BuilderEvent) => void): () => void {
    if (!this.adapter.observeEvents) throw new Error("wrapped provider does not expose turn observation");
    return this.adapter.observeEvents(listener);
  }
  acceptHandbackTurn(turn: TurnResult): void {
    if (turn.structured) {
      if (turn.isError || turn.failure || turn.structured.state !== "candidate") throw new Error("cannot publish an invalid handback checkpoint");
      this.publish(validateContinuityDelta(turn.continuity), "handback_turn_completed", turn);
      this.moveRecoveryLeaseAfterCheckpoint();
      return;
    }
    throw new Error("Handback acceptance requires a native receipt and validated continuity");
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
      return db.atomic(() => {
        db.appendContinuityEvent({ runId: this.options.runId, role: this.options.role, kind, payload: { isError: result.isError, numTurns: result.numTurns, sessionId: this.adapter.sessionId(), sessionRef, delta }, authoritativeStateRevision: this.revision(), sessionRef });
        return db.publishContinuityCheckpoint({ runId: this.options.runId, role: this.options.role, delta, authoritativeStateRevision: this.revision(), sessionRef });
      });
    } finally { db.close(); }
  }

  private moveRecoveryLeaseAfterCheckpoint(): void {
    if (!this.recoveryLeasePending) return;
    const session = this.adapter.sessionRef?.() ?? this.adapter.sessionId();
    if (!session) return;
    const db = new WorkflowDb(this.options.projectDir);
    try { db.moveRoleLeaseAfterValidatedRecovery(this.options.runId, this.options.role, session, "explicit fresh-recovery-only continuation"); }
    finally { db.close(); }
    this.recoveryLeasePending = false;
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
