import { createHash } from "node:crypto";
import type { ConfigurableAgentRole, ContextSample, ProviderSessionRefV1, ResolvedAgentSettings, SessionAvailabilityV1, SessionStrategy, WorkflowIssue } from "rafi-spec";
import type { BuilderAdapter, ContextUsage } from "./adapters/types.js";
import { SessionUnavailableError, sessionUnavailableErrorFromFailure } from "./adapters/sessionFailure.js";
import { sanitizeDiagnostics } from "./runtimeReadiness.js";
import { WorkflowDb } from "./workflowDb.js";
import { providerSessionKey } from "./sessionIdentity.js";

export interface SessionTransition {
  kind: "initial" | "compacted" | "fresh" | "missing" | "compaction-retry" | "compaction-fallback" | "settings-attempt" | "settings-continued" | "settings-fallback";
  role: ConfigurableAgentRole;
  workSession: number;
  sessionId?: string;
  message: string;
}

export interface SessionBoundary {
  adapter: BuilderAdapter;
  transition: SessionTransition;
  issue?: WorkflowIssue;
}

export interface RoleSessionControllerOptions {
  role: ConfigurableAgentRole;
  settings: ResolvedAgentSettings;
  create: (settings: ResolvedAgentSettings, resumeSessionId?: string, resumeSessionRef?: ProviderSessionRefV1) => Promise<BuilderAdapter>;
  report?: (transition: SessionTransition) => void;
  now?: () => Date;
  initialSessionId?: string;
  initialSessionRef?: ProviderSessionRefV1;
  /** Publish/validate cumulative state and return the accepted fresh successor. */
  handoff?: (input: {
    predecessor: BuilderAdapter;
    durableHandoff: string;
    reason: string;
    settings: ResolvedAgentSettings;
  }) => Promise<BuilderAdapter>;
}

export class RoleSessionValidationError extends Error {
  constructor(readonly role: ConfigurableAgentRole, readonly availability: SessionAvailabilityV1) {
    super(`exact ${role} session is ${availability.status} (${availability.reason ?? "validation failed"}): ${availability.detail ?? "no provider detail"}`);
    this.name = "RoleSessionValidationError";
  }
}

/** One lifecycle implementation shared by interviews, builds, QA, and recovery. */
export class RoleSessionController {
  private adapter?: BuilderAdapter;
  private workSessions = 0;
  private thresholdController?: ThresholdCompactionController;

  constructor(private readonly options: RoleSessionControllerOptions) {}

  /**
   * Production facade: the role owner authorizes scoped adapters and validated
   * successors while the threshold controller remains delegated policy and
   * accounting. Compatibility callers may still construct the threshold
   * controller directly.
   */
  static managed(options: ThresholdCompactionOptions): RoleSessionController {
    const controller = new RoleSessionController({
      role: options.role,
      settings: options.initialSettings,
      create: async () => { throw new Error("managed role sessions create adapters only through validated lifecycle callbacks"); },
    });
    const settingsBoundary = options.settingsBoundary
      ? async (input: Parameters<NonNullable<ThresholdCompactionOptions["settingsBoundary"]>>[0]): Promise<BuilderAdapter> => {
          const predecessor = controller.captureManagedIdentity(input.adapter);
          const successor = await options.settingsBoundary!(input);
          return controller.acceptManagedTransition(predecessor, successor, "settings");
        }
      : undefined;
    const handoff = options.handoff
      ? async (input: Parameters<NonNullable<ThresholdCompactionOptions["handoff"]>>[0]): Promise<BuilderAdapter> => {
          const predecessor = controller.captureManagedIdentity(input.adapter);
          const successor = await options.handoff!(input);
          return controller.acceptManagedTransition(predecessor, successor, "handoff");
        }
      : undefined;
    controller.thresholdController = new ThresholdCompactionController({ ...options, settingsBoundary, handoff });
    return controller;
  }

  async atSafeBoundary(adapter: BuilderAdapter, frozenAction: string): Promise<ContextBoundaryResult> {
    if (!this.thresholdController) throw new Error("this role session controller does not own threshold lifecycle policy");
    await this.adoptManagedAdapter(adapter);
    const result = await this.thresholdController.atSafeBoundary(adapter, frozenAction);
    this.adapter = result.adapter;
    return result;
  }

  async atWorkSessionBoundary(
    adapter: BuilderAdapter,
    frozenAction: string,
    strategy?: SessionStrategy,
  ): Promise<ContextBoundaryResult> {
    if (!this.thresholdController) throw new Error("this role session controller does not own threshold lifecycle policy");
    await this.adoptManagedAdapter(adapter);
    const result = await this.thresholdController.atWorkSessionBoundary(adapter, frozenAction, strategy);
    this.adapter = result.adapter;
    return result;
  }

  effectiveSettings(): ResolvedAgentSettings {
    return this.thresholdController?.effectiveSettings() ?? this.options.settings;
  }

  effectiveThreshold(): number {
    if (!this.thresholdController) return this.options.settings.auto_compact_threshold_percent ?? 50;
    return this.thresholdController.effectiveThreshold();
  }

  async next(durableHandoff: string, nextSettings?: ResolvedAgentSettings): Promise<SessionBoundary> {
    this.workSessions += 1;
    if (!this.adapter) {
      if (nextSettings) this.options.settings = nextSettings;
      if (this.options.initialSessionId && !this.options.initialSessionRef) {
        throw new RoleSessionValidationError(this.options.role, {
          version: 1, status: "unknown", checkedAt: (this.options.now?.() ?? new Date()).toISOString(),
          reason: "legacy-unscoped", detail: "a raw provider session ID has no verifiable location scope",
        });
      }
      this.adapter = await this.options.create(this.options.settings, this.options.initialSessionRef?.sessionId ?? this.options.initialSessionId, this.options.initialSessionRef);
      if (this.options.initialSessionRef) {
        const availability = await (this.adapter.validateSession?.() ?? Promise.resolve<SessionAvailabilityV1>({
          version: 1, status: "unknown", checkedAt: (this.options.now?.() ?? new Date()).toISOString(),
          reason: "legacy-unscoped", detail: "provider adapter does not expose exact-session validation", sessionRef: this.options.initialSessionRef,
        }));
        if (availability.status !== "available" || !availability.sessionRef) {
          await this.adapter.close().catch(() => {});
          this.adapter = undefined;
          throw new RoleSessionValidationError(this.options.role, availability);
        }
        this.adapter.adoptSessionRef?.(availability.sessionRef);
      }
      return this.boundary("initial", "started a workflow-scoped provider conversation");
    }
    if (nextSettings) {
      const current = this.options.settings;
      if (nextSettings.make !== current.make) {
        this.options.settings = nextSettings;
        const validated = await this.moveFresh(durableHandoff, `provider changed from ${current.make} to ${nextSettings.make}`);
        return this.boundary("settings-fallback", `${validated ? "validated cumulative handoff" : "fresh compatibility fallback"} after provider changed from ${current.make} to ${nextSettings.make}`);
      }
      const changed = nextSettings.model !== current.model || nextSettings.reasoning !== current.reasoning || nextSettings.fast !== current.fast;
      this.options.settings = nextSettings;
      if (changed) {
        this.emit("settings-attempt", `attempting same-conversation settings switch to ${nextSettings.model}, reasoning=${nextSettings.reasoning}, fast=${nextSettings.fast}`);
        const switched = this.adapter.switchSettings
          ? await this.adapter.switchSettings({ model: nextSettings.model === "default" ? undefined : nextSettings.model, effort: effort(nextSettings.reasoning), fast: nextSettings.fast })
          : { ok: false, error: "provider adapter does not support an in-conversation settings switch" };
        if (switched.failure?.category === "session-unavailable") throw sessionUnavailableErrorFromFailure(switched.failure);
        if (!switched.ok) {
          const detail = sanitize(switched.error ?? "settings switch failed");
          const validated = await this.moveFresh(durableHandoff, `settings switch failed: ${detail}`);
          const issue = this.issue("session_model_switch_failure", detail, validated ? "The role continued through a validated cumulative handoff." : "A validated handoff callback was unavailable; inspect continuity before proceeding.");
          return this.boundary("settings-fallback", `settings switch failed (${detail}); ${validated ? "continued through a validated fresh successor" : "used the compatibility fresh fallback"}`, issue);
        }
        this.emit("settings-continued", "provider accepted the same-conversation settings switch");
      }
    }
    if (this.options.settings.session_strategy === "fresh") {
      const validated = await this.moveFresh(durableHandoff, "ordinary session_strategy=fresh boundary");
      const result = this.boundary("fresh", validated ? "transferred to a validated fresh successor with the durable handoff" : "started a compatibility fresh conversation without host validation");
      return result;
    }
    if (!this.adapter.sessionId()) {
      const validated = await this.moveFresh(durableHandoff, "exact provider session identity is unavailable");
      const issue = this.issue("session_missing", "exact provider session is unavailable", validated ? "Continued through a validated cumulative handoff." : "Validated handoff support is unavailable; inspect continuity before proceeding.");
      const result = this.boundary("missing", validated ? "exact session unavailable; transferred to a validated fresh successor" : "exact session unavailable; used the compatibility fresh fallback", issue);
      return result;
    }
    let firstError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const compacted = this.adapter.compact
          ? await this.adapter.compact()
          : { ok: false, error: "provider adapter does not expose native compaction" };
        if (compacted.failure?.category === "session-unavailable") throw sessionUnavailableErrorFromFailure(compacted.failure);
        if (compacted.ok) return this.boundary("compacted", attempt === 1 ? "compacted and continued the exact conversation" : "compaction retry succeeded; continued the exact conversation");
        firstError = sanitize(compacted.error ?? "provider reported compaction failure");
      } catch (error) {
        if (error instanceof SessionUnavailableError) throw error;
        firstError = sanitize(error);
      }
      if (attempt === 1) this.emit("compaction-retry", `compaction failed (${firstError}); retrying once`);
    }
    const validated = await this.moveFresh(durableHandoff, `native compaction failed twice: ${firstError}`);
    const issue = this.issue("session_compaction_failure", firstError, validated ? "Inspect provider health; the role continued through a validated cumulative handoff." : "Validated handoff support is unavailable; inspect continuity before proceeding.");
    const result = this.boundary("compaction-fallback", `compaction failed twice (${firstError}); ${validated ? "continued through a validated fresh successor" : "used the compatibility fresh fallback"}`, issue);
    return result;
  }

  current(): BuilderAdapter | undefined { return this.adapter; }
  count(): number { return this.workSessions; }
  async usage(): Promise<ContextUsage | undefined> { return this.adapter?.contextUsage?.(); }
  async close(): Promise<void> { await this.adapter?.close(); this.adapter = undefined; }

  private async moveFresh(durableHandoff: string, reason: string): Promise<boolean> {
    const predecessor = this.adapter!;
    if (this.options.handoff) {
      const successor = await this.options.handoff({ predecessor, durableHandoff, reason, settings: this.options.settings });
      const predecessorRef = predecessor.sessionRef?.();
      const successorRef = successor.sessionRef?.();
      if (predecessorRef && (!successorRef || providerSessionKey(predecessorRef) === providerSessionKey(successorRef))) {
        if (successor !== predecessor) await successor.close().catch(() => {});
        throw new Error("validated handoff did not return a genuinely fresh location-scoped successor");
      }
      this.adapter = successor;
      if (successor !== predecessor) await predecessor.close().catch(() => {});
      return true;
    }
    await predecessor.close();
    this.adapter = await this.options.create(this.options.settings);
    return false;
  }

  private async adoptManagedAdapter(adapter: BuilderAdapter): Promise<void> {
    const sessionId = adapter.sessionId();
    let ref = adapter.sessionRef?.();
    if (sessionId && !ref) {
      throw new RoleSessionValidationError(this.options.role, {
        version: 1,
        status: "unknown",
        checkedAt: (this.options.now?.() ?? new Date()).toISOString(),
        reason: "legacy-unscoped",
        detail: "a live provider session ID has no location-scoped reference",
      });
    }
    if (ref?.role !== undefined && ref.role !== this.options.role) {
      throw new RoleSessionValidationError(this.options.role, {
        version: 1,
        status: "unavailable",
        checkedAt: (this.options.now?.() ?? new Date()).toISOString(),
        reason: "role-mismatch",
        detail: `provider session belongs to role ${ref.role}, not ${this.options.role}`,
        sessionRef: ref,
      });
    }
    if (ref?.source === "legacy-inferred" && !ref.validatedAt) {
      const availability = await (adapter.validateSession?.() ?? Promise.resolve<SessionAvailabilityV1>({
        version: 1,
        status: "unknown",
        checkedAt: (this.options.now?.() ?? new Date()).toISOString(),
        reason: "legacy-unscoped",
        detail: "provider adapter does not expose exact-session validation",
        sessionRef: ref,
      }));
      if (availability.status !== "available" || !availability.sessionRef) throw new RoleSessionValidationError(this.options.role, availability);
      ref = availability.sessionRef;
      adapter.adoptSessionRef?.(ref);
    }
    this.adapter = adapter;
  }

  private captureManagedIdentity(adapter: BuilderAdapter): { sessionId?: string; sessionRef?: ProviderSessionRefV1; sessionKey?: string } {
    const sessionRef = adapter.sessionRef?.();
    return {
      ...(adapter.sessionId() ? { sessionId: adapter.sessionId() } : {}),
      ...(sessionRef ? { sessionRef, sessionKey: providerSessionKey(sessionRef) } : {}),
    };
  }

  private acceptManagedTransition(
    predecessor: { sessionId?: string; sessionRef?: ProviderSessionRefV1; sessionKey?: string },
    successor: BuilderAdapter,
    kind: "settings" | "handoff",
  ): BuilderAdapter {
    const successorRef = successor.sessionRef?.();
    const successorId = successor.sessionId();
    if (!successorId || !successorRef) {
      throw new RoleSessionValidationError(this.options.role, {
        version: 1,
        status: "unknown",
        checkedAt: (this.options.now?.() ?? new Date()).toISOString(),
        reason: "legacy-unscoped",
        detail: `${kind} transition did not return a location-scoped successor`,
      });
    }
    if (successorRef.role !== this.options.role) {
      throw new RoleSessionValidationError(this.options.role, {
        version: 1,
        status: "unavailable",
        checkedAt: (this.options.now?.() ?? new Date()).toISOString(),
        reason: "role-mismatch",
        detail: `${kind} successor belongs to role ${successorRef.role}`,
        sessionRef: successorRef,
      });
    }
    const successorKey = providerSessionKey(successorRef);
    const changed = predecessor.sessionKey !== successorKey;
    if (kind === "handoff" && !changed) throw new Error("validated handoff reused the predecessor's scoped provider session");
    if (changed) {
      if (!successorRef.validatedAt) throw new Error(`${kind} successor was not validated before adoption`);
    }
    if (changed && predecessor.sessionRef) {
      if (successorRef.generation <= predecessor.sessionRef.generation) {
        throw new Error(`${kind} successor generation did not advance after validated acceptance`);
      }
    }
    this.adapter = successor;
    return successor;
  }

  private boundary(kind: SessionTransition["kind"], message: string, issue?: WorkflowIssue): SessionBoundary {
    const transition = this.emit(kind, message);
    return { adapter: this.adapter!, transition, issue };
  }

  private emit(kind: SessionTransition["kind"], message: string): SessionTransition {
    const transition = { kind, role: this.options.role, workSession: this.workSessions, sessionId: this.adapter?.sessionId(), message };
    this.options.report?.(transition);
    return transition;
  }

  private issue(code: "session_missing" | "session_compaction_failure" | "session_model_switch_failure", detail: string, action: string): WorkflowIssue {
    return {
      code, role: this.options.role, phase: "session-boundary", provider: this.options.settings.make,
      model: this.options.settings.model, detail, human_required: false, recoverable: true,
      suggested_action: action, occurred_at: (this.options.now?.() ?? new Date()).toISOString(),
    };
  }
}

export class ContextCapabilityError extends Error {
  constructor(readonly runId: string, readonly role: "builder" | "qa", message: string) {
    super(`${message}; new ${role} work is paused because truthful context occupancy is required for run ${runId}`);
  }
}

export interface ThresholdCompactionOptions {
  projectDir: string;
  runId: string;
  role: "builder" | "qa";
  initialSettings: ResolvedAgentSettings;
  /** Read durable settings at every safe boundary. A newer revision wins. */
  readSettings?: () => ResolvedAgentSettings;
  /** Apply provider/model controls before a newer durable revision is acknowledged. */
  settingsBoundary?: (input: {
    adapter: BuilderAdapter;
    current: ResolvedAgentSettings;
    next: ResolvedAgentSettings;
    frozenAction: string;
  }) => Promise<BuilderAdapter>;
  settingsAdopted?: (settings: ResolvedAgentSettings, adapter: BuilderAdapter) => void;
  handoff?: (input: {
    reason: string;
    adapter: BuilderAdapter;
    sample: ContextSample;
    settings: ResolvedAgentSettings;
    compactionCount: number;
    frozenAction: string;
  }) => Promise<BuilderAdapter>;
  report?: (event: { kind: string; detail: string; sample?: ContextSample }) => void;
  contextRetries?: number;
  historicalCountUncertain?: boolean;
  now?: () => Date;
}

export interface ContextBoundaryResult {
  adapter: BuilderAdapter;
  action: "continued" | "compacted" | "handed-off" | "below-threshold";
  sample: ContextSample;
  effectiveThreshold: number;
  compactionCount: number;
}

/** Threshold-triggered native compaction at host-owned safe boundaries. */
export class ThresholdCompactionController {
  private settings: ResolvedAgentSettings;
  private armed = true;
  private crossing = 0;
  private readonly seenSessions = new Set<string>();
  private runOnlyThreshold?: number;
  private bootstrapScheduled = false;
  private bootstrapRecoveryDepth = 0;
  private historicalCountUncertain: boolean;

  constructor(private readonly options: ThresholdCompactionOptions) {
    this.settings = normalizeContextSettings(options.initialSettings);
    this.historicalCountUncertain = Boolean(options.historicalCountUncertain);
  }

  async atSafeBoundary(adapter: BuilderAdapter, frozenAction: string): Promise<ContextBoundaryResult> {
    adapter = await this.adoptSettings(adapter, frozenAction);
    if (!adapter.sessionId() && !this.bootstrapScheduled) {
      this.bootstrapScheduled = true;
      const sample: ContextSample = {
        version: 1, runId: this.options.runId, role: this.options.role, provider: adapter.agent,
        model: this.settings.model, observedAt: this.now().toISOString(), source: "provider-query", freshness: "measuring",
        settingsRevision: this.settings.settings_revision, compactionCount: 0, handoffGeneration: this.handoffGeneration(),
      };
      const db = new WorkflowDb(this.options.projectDir);
      try { db.recordContextSample(sample); } finally { db.close(); }
      return { adapter, action: "continued", sample, effectiveThreshold: this.threshold(), compactionCount: 0 };
    }
    let sample = await this.measure(adapter, "provider-query");
    const threshold = this.threshold();
    let session = adapter.sessionRef?.() ?? adapter.sessionId();
    let sessionKey = adapterSessionKey(adapter);
    const firstObservedSession = Boolean(sessionKey && !this.seenSessions.has(sessionKey));
    if (sessionKey) this.seenSessions.add(sessionKey);
    const db = new WorkflowDb(this.options.projectDir);
    let count = 0;
    try {
      db.recordContextSample(sample);
      count = db.successfulCompactionCount(this.options.runId, this.options.role, session);
    } finally { db.close(); }

    if ((sample.percentage ?? -1) < threshold) {
      this.armed = true;
      return { adapter, action: "below-threshold", sample, effectiveThreshold: threshold, compactionCount: count };
    }
    if (!this.armed) return { adapter, action: "continued", sample, effectiveThreshold: threshold, compactionCount: count };
    this.armed = false;
    this.crossing += 1;
    let freshBootstrap = firstObservedSession;

    // A settings command published while the action settled is newer intent.
    const revisionBeforeSettle = this.settings.settings_revision;
    const sessionBeforeSettle = adapterSessionKey(adapter);
    adapter = await this.adoptSettings(adapter, frozenAction);
    if (this.settings.settings_revision !== revisionBeforeSettle || adapterSessionKey(adapter) !== sessionBeforeSettle) {
      sample = await this.measure(adapter, "provider-query");
      session = adapter.sessionRef?.() ?? adapter.sessionId();
      sessionKey = adapterSessionKey(adapter);
      freshBootstrap = Boolean(sessionKey && !this.seenSessions.has(sessionKey));
      if (sessionKey) this.seenSessions.add(sessionKey);
      const refreshed = new WorkflowDb(this.options.projectDir);
      try {
        refreshed.recordContextSample(sample);
        count = refreshed.successfulCompactionCount(this.options.runId, this.options.role, adapter.sessionRef?.() ?? adapter.sessionId());
      } finally { refreshed.close(); }
    }
    const revisedThreshold = this.threshold();
    if ((sample.percentage ?? -1) < revisedThreshold) {
      this.armed = true;
      return { adapter, action: "continued", sample, effectiveThreshold: revisedThreshold, compactionCount: count };
    }

    const crossingKey = `${sessionKey ?? "missing"}:${this.crossing}:${revisedThreshold}`;
    return this.compactSession(adapter, sample, count, frozenAction, crossingKey, true, freshBootstrap);
  }

  /** Apply the configured ordinary work-session boundary without bypassing handoff or compaction accounting. */
  async atWorkSessionBoundary(
    adapter: BuilderAdapter,
    frozenAction: string,
    strategy: SessionStrategy = this.settings.session_strategy,
  ): Promise<ContextBoundaryResult> {
    adapter = await this.adoptSettings(adapter, frozenAction);
    const sample = await this.measure(adapter, "provider-query");
    const db = new WorkflowDb(this.options.projectDir);
    let count = 0;
    try {
      db.recordContextSample(sample);
      count = db.successfulCompactionCount(this.options.runId, this.options.role, adapter.sessionRef?.() ?? adapter.sessionId());
    } finally { db.close(); }
    if (strategy === "fresh") {
      return this.performHandoff(adapter, sample, count, frozenAction, "ordinary session_strategy=fresh boundary requires a validated fresh successor");
    }
    const crossingKey = `${adapterSessionKey(adapter) ?? "missing"}:ordinary:${count + 1}:${sha(frozenAction).slice(0, 20)}`;
    return this.compactSession(adapter, sample, count, frozenAction, crossingKey, false, false);
  }

  effectiveSettings(): ResolvedAgentSettings { return this.settings; }
  effectiveThreshold(): number { return this.threshold(); }

  private async compactSession(
    adapter: BuilderAdapter,
    sample: ContextSample,
    count: number,
    frozenAction: string,
    crossingKey: string,
    thresholdCrossing: boolean,
    freshBootstrap: boolean,
  ): Promise<ContextBoundaryResult> {
    const threshold = this.threshold();
    const sessionId = adapter.sessionId();
    const sessionRef = adapter.sessionRef?.();
    const sessionKey = sessionRef ? providerSessionKey(sessionRef) : undefined;
    if (this.historicalCountUncertain) return this.performHandoff(adapter, sample, count, frozenAction, "historical compaction count is uncertain; handing off rather than risking the configured maximum");
    if (!sessionId) return this.performHandoff(adapter, sample, count, frozenAction, "the provider session identity is unavailable");
    if (!sessionRef) return this.performHandoff(adapter, sample, count, frozenAction, "the provider session has no validated location-scoped identity");
    if (count >= (this.settings.compact_maximum ?? 10)) return this.performHandoff(adapter, sample, count, frozenAction, `compact maximum ${this.settings.compact_maximum ?? 10} reached`);
    if (!adapter.compact) return this.performHandoff(adapter, sample, count, frozenAction, "native compaction is unavailable for this provider session");

    const idempotencyKey = `compact:${this.options.runId}:${this.options.role}:${sha(crossingKey).slice(0, 24)}`;
    const attemptDb = new WorkflowDb(this.options.projectDir);
    const prior = attemptDb.startCompactionAttempt({ idempotencyKey, runId: this.options.runId, role: this.options.role, providerSessionId: sessionId, sessionRef, sessionKey, crossingKey, beforeSample: sample });
    attemptDb.close();
    if (prior.status === "succeeded" && prior.afterSample) {
      const replayDb = new WorkflowDb(this.options.projectDir);
      try { count = replayDb.successfulCompactionCount(this.options.runId, this.options.role, sessionRef ?? sessionId); }
      finally { replayDb.close(); }
      return { adapter, action: "compacted", sample: prior.afterSample, effectiveThreshold: threshold, compactionCount: count };
    }

    this.options.report?.({ kind: "compacting", detail: thresholdCrossing
      ? `context ${sample.percentage?.toFixed(1)}% reached ${threshold}%`
      : `ordinary compact session boundary (${count}/${this.settings.compact_maximum ?? 10})`, sample });
    let compacted;
    try { compacted = await adapter.compact(); }
    catch (error) {
      compacted = error instanceof SessionUnavailableError
        ? { ok: false, error: error.message, failure: error.failure }
        : { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (compacted.failure?.category === "session-unavailable") {
      const failedDb = new WorkflowDb(this.options.projectDir);
      try {
        failedDb.finishCompactionAttempt(idempotencyKey, { ok: false, error: compacted.error ?? compacted.failure.diagnostics });
        failedDb.appendContinuityEvent({
          runId: this.options.runId,
          role: "host",
          kind: "session_unavailable",
          payload: {
            role: this.options.role,
            operation: "native-compaction",
            phase: compacted.failure.phase,
            dispatchState: compacted.failure.dispatchState ?? "unknown",
            reason: compacted.failure.availability?.reason,
            detail: compacted.failure.diagnostics,
          },
          authoritativeStateRevision: failedDb.continuityHead(this.options.runId, this.options.role)?.authoritativeStateRevision ?? this.settings.settings_revision,
          sessionRef,
        });
        if (compacted.failure.dispatchState === "unknown") failedDb.setContinuityHeadState(this.options.runId, this.options.role, "degraded");
      } finally { failedDb.close(); }
      throw sessionUnavailableErrorFromFailure(compacted.failure);
    }
    if (!compacted.ok) {
      const failedDb = new WorkflowDb(this.options.projectDir);
      try { failedDb.finishCompactionAttempt(idempotencyKey, { ok: false, error: compacted.error ?? "provider did not explicitly complete compaction" }); }
      finally { failedDb.close(); }
      return this.performHandoff(adapter, sample, count, frozenAction, `native compaction failed: ${sanitize(compacted.error ?? "no explicit completion")}`);
    }

    let after: ContextSample;
    try { after = await this.measure(adapter, "post-compact"); }
    catch (error) {
      const failedDb = new WorkflowDb(this.options.projectDir);
      try { failedDb.finishCompactionAttempt(idempotencyKey, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
      finally { failedDb.close(); }
      return this.performHandoff(adapter, sample, count, frozenAction, "provider reported compaction but no authoritative post-compact occupancy sample was available");
    }
    const completedDb = new WorkflowDb(this.options.projectDir);
    try {
      completedDb.recordContextSample(after);
      completedDb.finishCompactionAttempt(idempotencyKey, { ok: true, afterSample: after });
      count = completedDb.successfulCompactionCount(this.options.runId, this.options.role, sessionRef ?? sessionId);
    } finally { completedDb.close(); }
    this.options.report?.({ kind: "compacted", detail: `context reduced to ${after.percentage?.toFixed(1)}%`, sample: after });

    if (freshBootstrap && (after.percentage ?? -1) >= threshold) {
      const adjusted = Math.min(99, Math.ceil((after.percentage ?? 0) + 10));
      if (adjusted <= (after.percentage ?? 0)) throw new ContextCapabilityError(this.options.runId, this.options.role, `fresh bootstrap remained at ${after.percentage?.toFixed(1)}% after compaction and no safe run-only threshold exists`);
      this.runOnlyThreshold = adjusted;
      this.options.report?.({ kind: "threshold-adjusted", detail: `fresh bootstrap remained high; run-only threshold is now ${adjusted}%`, sample: after });
    }
    this.armed = thresholdCrossing ? (after.percentage ?? 100) < this.threshold() : true;
    return { adapter, action: "compacted", sample: after, effectiveThreshold: this.threshold(), compactionCount: count };
  }

  private async performHandoff(adapter: BuilderAdapter, sample: ContextSample, count: number, frozenAction: string, reason: string): Promise<ContextBoundaryResult> {
    if (!this.options.handoff) throw new ContextCapabilityError(this.options.runId, this.options.role, `${reason}; validated handoff is unavailable`);
    this.options.report?.({ kind: "handoff", detail: reason, sample });
    const successor = await this.options.handoff({ reason, adapter, sample, settings: this.settings, compactionCount: count, frozenAction });
    const post = await this.measure(successor, "provider-query");
    this.historicalCountUncertain = false;
    const successorSessionId = successor.sessionId();
    const successorSessionKey = adapterSessionKey(successor);
    if (successorSessionKey) this.seenSessions.add(successorSessionKey);
    const db = new WorkflowDb(this.options.projectDir);
    try { db.recordContextSample(post); } finally { db.close(); }
    if ((post.percentage ?? 100) >= this.threshold()) {
      if (this.bootstrapRecoveryDepth >= 1) {
        throw new ContextCapabilityError(this.options.runId, this.options.role, `fresh successor bootstrap remained at ${post.percentage?.toFixed(1)}% after compaction-failure recovery`);
      }
      this.bootstrapRecoveryDepth += 1;
      try {
        const bootstrapped = await this.compactSession(
          successor,
          post,
          0,
          frozenAction,
          `${successorSessionKey ?? successorSessionId ?? "missing"}:fresh-bootstrap:${sha(frozenAction).slice(0, 20)}`,
          true,
          true,
        );
        return { ...bootstrapped, action: "handed-off" };
      } finally { this.bootstrapRecoveryDepth -= 1; }
    }
    this.armed = true;
    return { adapter: successor, action: "handed-off", sample: post, effectiveThreshold: this.threshold(), compactionCount: 0 };
  }

  private async adoptSettings(adapter: BuilderAdapter, frozenAction: string): Promise<BuilderAdapter> {
    const candidate = this.options.readSettings?.();
    if (!candidate || candidate.settings_revision <= this.settings.settings_revision) return adapter;
    const next = normalizeContextSettings(candidate);
    const providerControlsChanged = next.make !== this.settings.make
      || next.model !== this.settings.model
      || next.reasoning !== this.settings.reasoning
      || next.fast !== this.settings.fast;
    let adoptedAdapter = adapter;
    if (providerControlsChanged) {
      if (this.options.settingsBoundary) {
        adoptedAdapter = await this.options.settingsBoundary({ adapter, current: this.settings, next, frozenAction });
      } else if (next.make === this.settings.make && adapter.switchSettings) {
        const switched = await adapter.switchSettings({ model: next.model === "default" ? undefined : next.model, effort: effort(next.reasoning), fast: next.fast });
        if (switched.failure?.category === "session-unavailable") throw sessionUnavailableErrorFromFailure(switched.failure);
        if (!switched.ok) throw new ContextCapabilityError(this.options.runId, this.options.role, `settings revision ${next.settings_revision} could not be applied safely: ${sanitize(switched.error ?? "provider rejected the settings switch")}`);
      } else {
        throw new ContextCapabilityError(this.options.runId, this.options.role, `settings revision ${next.settings_revision} requires a validated provider/model handoff, but no settings boundary is available`);
      }
      if (adoptedAdapter.agent !== next.make) {
        throw new ContextCapabilityError(this.options.runId, this.options.role, `settings revision ${next.settings_revision} requested ${next.make}, but the adopted session reports ${adoptedAdapter.agent}`);
      }
    }
    this.settings = next;
    this.runOnlyThreshold = undefined;
    const db = new WorkflowDb(this.options.projectDir);
    try { const ref = adoptedAdapter.sessionRef?.(); db.acknowledgeSettings({ runId: this.options.runId, role: this.options.role, providerSessionId: adoptedAdapter.sessionId(), ...(ref ? { sessionRef: ref, sessionKey: providerSessionKey(ref) } : {}), revision: next.settings_revision, acknowledgedAt: this.now().toISOString() }); }
    finally { db.close(); }
    this.options.settingsAdopted?.(next, adoptedAdapter);
    this.options.report?.({ kind: "settings-adopted", detail: `adopted settings revision ${next.settings_revision}` });
    return adoptedAdapter;
  }

  private async measure(adapter: BuilderAdapter, source: ContextSample["source"]): Promise<ContextSample> {
    const attempts = Math.max(1, this.options.contextRetries ?? 3);
    let usage: ContextUsage | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { usage = await adapter.contextUsage?.(); } catch { usage = undefined; }
      if (usage && Number.isFinite(usage.used) && (usage.percentage !== undefined || usage.maximum !== undefined)) break;
    }
    if (!usage || !Number.isFinite(usage.used)) throw new ContextCapabilityError(this.options.runId, this.options.role, `truthful context occupancy was unavailable after ${attempts} provider attempt(s)`);
    const percentage = usage.percentage ?? (usage.maximum ? usage.used / usage.maximum * 100 : undefined);
    if (percentage === undefined || !Number.isFinite(percentage)) throw new ContextCapabilityError(this.options.runId, this.options.role, "provider context occupancy lacks a usable percentage and maximum");
    const ref = adapter.sessionRef?.();
    return {
      version: 1, runId: this.options.runId, role: this.options.role, provider: adapter.agent,
      providerSessionId: adapter.sessionId(), ...(ref ? { sessionRef: ref, sessionKey: providerSessionKey(ref) } : {}), model: this.settings.model, observedAt: usage.observedAt ?? this.now().toISOString(),
      source, freshness: "fresh", used: usage.used, maximum: usage.maximum, percentage,
      settingsRevision: this.settings.settings_revision,
      compactionCount: adapter.sessionId() ? this.compactionCount(ref ?? adapter.sessionId()!) : 0,
      handoffGeneration: this.handoffGeneration(),
    };
  }

  private compactionCount(session: string | ProviderSessionRefV1): number {
    const db = new WorkflowDb(this.options.projectDir);
    try { return db.successfulCompactionCount(this.options.runId, this.options.role, session); }
    finally { db.close(); }
  }
  private handoffGeneration(): number {
    const db = new WorkflowDb(this.options.projectDir);
    try { return db.handoffs(this.options.runId).at(-1)?.generation ?? 0; }
    finally { db.close(); }
  }
  private threshold(): number { return this.runOnlyThreshold ?? this.settings.auto_compact_threshold_percent ?? 50; }
  private now(): Date { return this.options.now?.() ?? new Date(); }
}

function normalizeContextSettings(settings: ResolvedAgentSettings): ResolvedAgentSettings {
  const threshold = settings.auto_compact_threshold_percent ?? 50;
  const maximum = settings.compact_maximum ?? 10;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 99) throw new Error("auto_compact_threshold_percent must be an integer from 1 to 99");
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("compact_maximum must be a positive safe integer");
  return { ...settings, display_session_cost: settings.display_session_cost ?? false, auto_compact_threshold_percent: threshold, compact_maximum: maximum };
}

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function effort(value: string): "low" | "medium" | "high" | "xhigh" | undefined {
  return ["low", "medium", "high", "xhigh"].includes(value) ? value as "low" | "medium" | "high" | "xhigh" : undefined;
}

function sanitize(error: unknown): string {
  return sanitizeDiagnostics(error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function adapterSessionKey(adapter: BuilderAdapter): string | undefined {
  const ref = adapter.sessionRef?.();
  return ref ? providerSessionKey(ref) : undefined;
}
