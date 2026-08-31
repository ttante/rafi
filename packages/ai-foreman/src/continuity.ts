import { createHash } from "node:crypto";
import type { ContinuityCheckpoint, ContinuityDelta, ResolvedAgentSettings } from "rafi-spec";
import type { BuilderAdapter, CompactResult, ContextUsage, NativeCompaction, ProviderSessionUsage, ProviderSettingSwitch, RuntimeFailure, TurnResult } from "./adapters/types.js";
import { BuilderEventQueue } from "./activity.js";
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

export function continuityInstruction(): string {
  return [
    "Before your final STEP_STATUS line (or as the final line when STEP_STATUS is not requested), emit exactly one single-line continuity record:",
    `${CONTINUITY_MARKER} {"version":1,"decisions":[],"constraints":[],"discoveries":[],"completedActions":[],"evidence":[],"failures":[],"blockers":[],"openWork":[],"nextAction":"specific next action"}`,
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
  handleHandoffRequest?: (text: string, predecessor: BuilderAdapter, frozenAction: string) => Promise<BuilderAdapter | undefined>;
}

/** Enforces a durable role checkpoint after every completed provider turn. */
export class ContinuityAdapter implements BuilderAdapter {
  private adapter: BuilderAdapter;
  private readonly queue = new BuilderEventQueue();
  private sourcePump?: Promise<void>;
  private recoveryLeasePending: boolean;

  constructor(private readonly options: ContinuityAdapterOptions) {
    this.adapter = options.adapter;
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

  get agent(): "claude" | "codex" { return this.adapter.agent; }

  async sendTurn(instruction: string): Promise<TurnResult> {
    const db = new WorkflowDb(this.options.projectDir);
    try {
      db.appendContinuityEvent({ runId: this.options.runId, role: "host", kind: "turn_started", payload: { role: this.options.role, instructionDigest: sha(instruction), instructionBytes: Buffer.byteLength(instruction) }, authoritativeStateRevision: this.revision() });
    } finally { db.close(); }

    const original = await this.adapter.sendTurn(`${instruction}\n\n${continuityInstruction()}`);
    const activeSession = this.adapter.sessionRef?.() ?? this.adapter.sessionId();
    if (activeSession) {
      const leaseDb = new WorkflowDb(this.options.projectDir);
      try { leaseDb.claimInitialRoleLease(this.options.runId, this.options.role, activeSession); }
      finally { leaseDb.close(); }
    }
    if (original.failure?.category === "session-unavailable") {
      this.recordSessionUnavailable(original.failure, instruction);
      throw new SessionUnavailableContinuityError(this.options.runId, this.options.role, original.failure);
    }
    const parsed = parseContinuityDelta(original.text);
    if (parsed.delta) {
      this.publish(parsed.delta, "turn_completed", original);
      this.moveRecoveryLeaseAfterCheckpoint();
      const successor = await this.options.handleHandoffRequest?.(original.text, this.adapter, instruction);
      if (successor && successor !== this.adapter) {
        await this.adoptValidatedSuccessor(successor);
        return this.sendTurn([
          "Continue the frozen action after the accepted Rafi handoff. Do not repeat completed side effects.",
          instruction,
        ].join("\n\n"));
      }
      return { ...original, text: parsed.cleanText };
    }

    const repair = await this.adapter.sendTurn([
      "Continuity protocol repair only. Do not run tools, repeat work, or change files.",
      `Your prior turn's continuity record was invalid: ${parsed.error?.problems.join("; ")}.`,
      continuityInstruction(),
      "Return only the continuity record.",
    ].join("\n"));
    const repaired = parseContinuityDelta(repair.text);
    if (repaired.delta) {
      this.publish(repaired.delta, "turn_completed_after_repair", original);
      this.moveRecoveryLeaseAfterCheckpoint();
      return { ...original, text: parsed.cleanText };
    }

    const invalidDb = new WorkflowDb(this.options.projectDir);
    try {
      invalidDb.appendContinuityEvent({ runId: this.options.runId, role: "host", kind: "continuity_invalid_twice", payload: { original: parsed.error?.problems, repair: repaired.error?.problems }, authoritativeStateRevision: this.revision() });
      invalidDb.setContinuityHeadState(this.options.runId, this.options.role, "invalid");
    } finally { invalidDb.close(); }
    const handoff = this.reconstructionHandoff();
    if (this.options.recoverWithHandoff) {
      let successor: BuilderAdapter;
      try {
        successor = await this.options.recoverWithHandoff({
          reason: "continuity delta and same-session repair were both invalid",
          reconstruction: handoff,
          predecessor: this.adapter,
        });
      } catch (error) {
        throw new ContinuityRecoveryRequiredError(
          this.options.runId,
          this.options.role,
          `fresh validated successor also failed after the same-session repair: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!successor.sessionId() || successor.sessionId() === this.adapter.sessionId()) {
        await successor.close().catch(() => {});
        throw new ContinuityRecoveryRequiredError(this.options.runId, this.options.role, "validated recovery callback did not return a genuinely fresh successor");
      }
      await this.adoptValidatedSuccessor(successor);
      return { ...original, text: parsed.cleanText };
    }
    if (!this.options.createSuccessor) throw new ContinuityRecoveryRequiredError(this.options.runId, this.options.role, "continuity repair failed in the original session and no validated successor is configured");

    const successor = await this.options.createSuccessor(handoff);
    const accepted = await successor.sendTurn(`${handoff}\n\nReply with HANDOFF_ACCEPTED on the first line, then ${continuityInstruction()}`);
    const successorDelta = parseContinuityDelta(accepted.text);
    if (!/^HANDOFF_ACCEPTED\b/m.test(accepted.text) || !successorDelta.delta || !successor.sessionId()) {
      await successor.close().catch(() => {});
      throw new ContinuityRecoveryRequiredError(this.options.runId, this.options.role, "fresh successor did not validate and accept the cumulative checkpoint");
    }
    await this.adoptValidatedSuccessor(successor);
    this.publish(successorDelta.delta, "fresh_successor_accepted", accepted);
    const leaseDb = new WorkflowDb(this.options.projectDir);
    try { leaseDb.moveRoleLeaseAfterValidatedRecovery(this.options.runId, this.options.role, successor.sessionRef?.() ?? successor.sessionId()!, "double-invalid continuity recovery"); }
    finally { leaseDb.close(); }
    return { ...original, text: parsed.cleanText };
  }

  sessionId(): string | undefined { return this.adapter.sessionId(); }
  sessionRef(): import("rafi-spec").ProviderSessionRefV1 | undefined { return this.adapter.sessionRef?.(); }
  adoptSessionRef(ref: import("rafi-spec").ProviderSessionRefV1): void { this.adapter.adoptSessionRef?.(ref); }
  validateSession(): Promise<import("rafi-spec").SessionAvailabilityV1> { return this.adapter.validateSession?.() ?? Promise.resolve({ version: 1, status: "unknown", checkedAt: new Date().toISOString(), reason: "legacy-unscoped" }); }
  compact(): Promise<CompactResult> { return this.adapter.compact ? this.adapter.compact() : Promise.resolve({ ok: false, error: "provider adapter does not expose native compaction" }); }
  prepareAutoCompaction(thresholdPercent?: number): Promise<void> { return this.adapter.prepareAutoCompaction?.(thresholdPercent) ?? Promise.resolve(); }
  drainNativeCompactions(): import("./adapters/types.js").NativeCompaction[] { return this.adapter.drainNativeCompactions?.() ?? []; }
  restoreNativeCompactions(compactions: NativeCompaction[]): void { this.adapter.restoreNativeCompactions?.(compactions); }
  contextUsageAfterNativeCompaction(compaction: NativeCompaction): Promise<ContextUsage | undefined> { return this.adapter.contextUsageAfterNativeCompaction?.(compaction) ?? Promise.resolve(undefined); }
  contextUsage(): Promise<ContextUsage | undefined> { return this.adapter.contextUsage?.() ?? Promise.resolve(undefined); }
  sessionUsage(): Promise<ProviderSessionUsage | undefined> { return this.adapter.sessionUsage?.() ?? Promise.resolve(undefined); }
  switchSettings(settings: ProviderSettingSwitch): Promise<CompactResult> { return this.adapter.switchSettings ? this.adapter.switchSettings(settings) : Promise.resolve({ ok: false, error: "provider adapter does not support settings changes" }); }
  events(): AsyncIterable<import("./adapters/types.js").BuilderEvent> { return this.queue; }
  async close(): Promise<void> { await this.adapter.close(); await this.sourcePump?.catch(() => {}); this.queue.close(); }

  /** Keep the observable wrapper and event stream stable while moving to an accepted successor. */
  async adoptValidatedSuccessor(successor: BuilderAdapter): Promise<void> {
    if (successor === this.adapter) return;
    const prior = this.adapter;
    this.adapter = successor;
    this.pumpEvents();
    await prior.close().catch(() => {});
  }

  private publish(delta: ContinuityDelta, kind: string, result: TurnResult): ContinuityCheckpoint {
    const db = new WorkflowDb(this.options.projectDir);
    try {
      const sessionRef = this.adapter.sessionRef?.();
      db.appendContinuityEvent({ runId: this.options.runId, role: this.options.role, kind, payload: { isError: result.isError, numTurns: result.numTurns, sessionId: this.adapter.sessionId(), sessionRef, delta }, authoritativeStateRevision: this.revision(), sessionRef });
      return db.publishContinuityCheckpoint({ runId: this.options.runId, role: this.options.role, delta, authoritativeStateRevision: this.revision(), sessionRef });
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

  private reconstructionHandoff(): string {
    const db = new WorkflowDb(this.options.projectDir);
    try {
      const checkpoints = db.continuityCheckpoints(this.options.runId, this.options.role);
      const events = db.continuityEvents(this.options.runId, checkpoints.at(-1)?.sequence ?? 0);
      return [
        `Validated cumulative recovery for run ${this.options.runId}, role ${this.options.role}.`,
        JSON.stringify(mergeContinuityDeltas(checkpoints.map((checkpoint) => checkpoint.delta))),
        `Later host facts: ${JSON.stringify(events.map((event) => ({ kind: event.kind, payload: event.payload, digest: event.digest })))}`,
        "The prior in-flight operation is unknown unless a host fact proves completion. Reconcile receipts before retrying side effects.",
      ].join("\n\n");
    } finally { db.close(); }
  }

  private revision(): number { return this.options.authoritativeStateRevision?.() ?? this.options.settings.settings_revision; }

  private pumpEvents(): void {
    const source = this.adapter;
    this.sourcePump = (async () => {
      try { for await (const event of source.events()) {
        this.queue.push(event);
        if (event.kind === "tool" || event.kind === "session-transition" || event.kind === "context-usage") {
          const db = new WorkflowDb(this.options.projectDir);
          try {
            const payload = event.kind === "tool"
              ? { name: event.name, inputDigest: sha(JSON.stringify(event.input ?? null)) }
              : event;
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
