import { createHash } from "node:crypto";
import type { ConfigurableAgentRole, ContextSample, ProviderSessionRefV1, ResolvedAgentSettings, SessionAvailabilityV1, SessionStrategy, WorkflowIssue } from "rafi-spec";
import type {
  BuilderAdapter,
  BuilderEvent,
  CompactResult,
  ContextCompactionEvent,
  ContextManagementPolicy,
  ContextUsage,
  InterruptResult,
  ManagedTurnDispatcher,
  PreparedContextManagement,
  ProviderSessionUsage,
  ProviderSettingSwitch,
  TurnResult,
} from "./adapters/types.js";
import { SessionUnavailableError, sessionUnavailableErrorFromFailure } from "./adapters/sessionFailure.js";
import { sanitizeDiagnostics } from "./runtimeReadiness.js";
import { WorkflowDb, type ThresholdGenerationRecord, type ThresholdLifecycleState } from "./workflowDb.js";
import { providerSessionKey } from "./sessionIdentity.js";
import { AsyncQueue } from "./util/asyncQueue.js";

export interface SessionTransition {
  kind: "initial" | "continued" | "compacted" | "fresh" | "missing" | "compaction-retry" | "compaction-fallback" | "settings-attempt" | "settings-continued" | "settings-fallback";
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

  /** Return the stable role facade whose sendTurn() contains the lifecycle gate. */
  manage(adapter: BuilderAdapter): ManagedRoleAdapter {
    if (!this.thresholdController) throw new Error("this role session controller does not own threshold lifecycle policy");
    const managed = this.thresholdController.manage(adapter);
    this.adapter = managed;
    return managed;
  }

  contextSnapshot(): ManagedContextSnapshot | undefined { return this.thresholdController?.snapshot(); }

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
    if ((this.options.role === "builder" || this.options.role === "qa") && this.options.settings.session_strategy === "compact") {
      const usage = await this.adapter.contextUsage?.().catch(() => undefined);
      const percentage = usage?.percentage ?? (usage?.maximum ? usage.used / usage.maximum * 100 : undefined);
      if (percentage !== undefined && percentage < (this.options.settings.auto_compact_threshold_percent ?? 50)) {
        return this.boundary("continued", `context ${percentage.toFixed(1)}% remains below the configured ${this.options.settings.auto_compact_threshold_percent ?? 50}% ceiling`);
      }
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
  /** Production Builder/QA runs require native prepare/update/interrupt support. */
  requireNativeContextManagement?: boolean;
  /** Dedicated live-settings watcher interval. */
  settingsPollMs?: number;
  now?: () => Date;
}

export interface ContextBoundaryResult {
  adapter: BuilderAdapter;
  action: "continued" | "compacted" | "handed-off" | "below-threshold";
  sample: ContextSample;
  effectiveThreshold: number;
  compactionCount: number;
}

export interface ManagedContextSnapshot {
  role: "builder" | "qa";
  provider: "claude" | "codex";
  model: string;
  lifecycleState: ThresholdLifecycleState;
  contextSample: ContextSample;
  configuredCeilingPercent: number;
  installedNativeTokenLimit?: number;
  installedNativePercent?: number;
  compactionCount: number;
  compactMaximum: number;
  settingsRevision: number;
}

interface SessionContextState {
  key: string;
  generationId: string;
  generation: number;
  state: ThresholdLifecycleState;
  settingsRevision: number;
  model: string;
  latest: ContextSample;
  latestProviderSequence: number;
  installedNativeTokenLimit?: number;
  installedNativePercent?: number;
  compactionCount: number;
  manualAttemptKey?: string;
  boundaryHandoff?: { providerEventId: string; reason: string };
  retryAfterTurn?: string;
  handoffAfterTurn?: string;
  capabilityFailure?: string;
}

/** Stable facade: every Builder/QA provider turn enters the coordinator here. */
export class ManagedRoleAdapter implements BuilderAdapter {
  private adapter: BuilderAdapter;
  private readonly queue = new AsyncQueue<BuilderEvent>();
  private eventPump?: Promise<void>;
  private processing: Promise<void> = Promise.resolve();
  private closed = false;
  private activeSessionKeyValue?: string;

  constructor(readonly coordinator: ThresholdCompactionController, adapter: BuilderAdapter) {
    this.adapter = adapter;
    this.attachDispatcher(adapter);
    this.pump(adapter);
  }

  get agent(): "claude" | "codex" { return this.adapter.agent; }
  sendTurn(text: string): Promise<TurnResult> { return this.coordinator.dispatch(this, text); }
  sessionId(): string | undefined { return this.adapter.sessionId(); }
  sessionRef(): ProviderSessionRefV1 | undefined { return this.adapter.sessionRef?.(); }
  adoptSessionRef(ref: ProviderSessionRefV1): void { this.adapter.adoptSessionRef?.(ref); }
  validateSession(): Promise<SessionAvailabilityV1> { return this.adapter.validateSession?.() ?? Promise.resolve({ version: 1, status: "unknown", checkedAt: new Date().toISOString(), reason: "legacy-unscoped" }); }
  compact(): Promise<CompactResult> { return this.coordinator.compactExplicit(this); }
  prepareContextManagement(policy: ContextManagementPolicy): Promise<PreparedContextManagement> { if (!this.adapter.prepareContextManagement) return Promise.reject(new Error("native context management unavailable")); return this.adapter.prepareContextManagement(policy); }
  updateContextManagement(policy: ContextManagementPolicy): Promise<PreparedContextManagement> { if (!this.adapter.updateContextManagement) return Promise.reject(new Error("native context reconfiguration unavailable")); return this.adapter.updateContextManagement(policy); }
  interruptTurnAtCompactionBoundary(providerEventId?: string): Promise<InterruptResult> { return this.adapter.interruptTurnAtCompactionBoundary?.(providerEventId) ?? Promise.resolve({ ok: false, error: "compaction-boundary interruption unavailable", providerEventId }); }
  contextUsage(): Promise<ContextUsage | undefined> { return Promise.resolve(this.coordinator.contextUsage(this)); }
  sessionUsage(): Promise<ProviderSessionUsage | undefined> { return this.adapter.sessionUsage?.() ?? Promise.resolve(undefined); }
  switchSettings(settings: ProviderSettingSwitch): Promise<CompactResult> { return this.adapter.switchSettings?.(settings) ?? Promise.resolve({ ok: false, error: "settings switch unavailable" }); }
  events(): AsyncIterable<BuilderEvent> { return this.queue; }
  underlying(): BuilderAdapter { return this.adapter; }

  noteActiveSession(key: string): string | undefined {
    const previous = this.activeSessionKeyValue;
    this.activeSessionKeyValue = key;
    return previous !== key ? previous : undefined;
  }

  activeSessionKey(): string | undefined { return this.activeSessionKeyValue; }
  isClosed(): boolean { return this.closed; }

  replace(adapter: BuilderAdapter): void {
    if (adapter === this.adapter) return;
    this.adapter = adapter;
    this.attachDispatcher(adapter);
    this.pump(adapter);
  }

  async settleEvents(): Promise<void> {
    // A provider may resolve sendTurn() in the same microtask that enqueues its
    // final usage/compaction event. Wait until both the event pump and its
    // serialized coordinator work reach a stable point.
    for (let attempt = 0; attempt < 10; attempt++) {
      const processing = this.processing;
      await Promise.resolve();
      await processing;
      await Promise.resolve();
      if (processing === this.processing) return;
    }
    await this.processing;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.coordinator.unregister(this);
    await this.adapter.close().catch(() => {});
    await this.eventPump?.catch(() => {});
    this.queue.close();
  }

  private pump(source: BuilderAdapter): void {
    this.eventPump = (async () => {
      try {
        for await (const event of source.events()) {
          if (source !== this.adapter && event.kind !== "turn-complete") continue;
          this.queue.push(event);
          this.processing = this.processing.then(() => this.coordinator.observe(this, source, event));
          await this.processing;
        }
      } catch (error) {
        if (!this.closed) this.queue.push({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
  }

  private attachDispatcher(adapter: BuilderAdapter): void {
    adapter.installManagedTurnDispatcher?.((text, invoke) => this.coordinator.dispatchFollowup(this, text, invoke));
  }
}

/** Per-scoped-session context state machine and the sole occupancy sample store. */
export class ThresholdCompactionController {
  private settings: ResolvedAgentSettings;
  private historicalCountUncertain: boolean;
  private readonly managed = new WeakMap<BuilderAdapter, ManagedRoleAdapter>();
  private readonly states = new Map<string, SessionContextState>();
  private readonly nativeAttempts = new Map<string, string>();
  private readonly observedCompactionPhases = new Set<string>();
  private readonly settingsWatchers = new WeakMap<ManagedRoleAdapter, { frozenAction: string; stop: () => void }>();
  private active?: ManagedRoleAdapter;
  private provisional = 0;
  private refreshingSettings?: Promise<void>;
  private dispatchDepth = 0;

  constructor(private readonly options: ThresholdCompactionOptions & { requireNativeContextManagement?: boolean; settingsPollMs?: number }) {
    this.settings = normalizeContextSettings(options.initialSettings);
    this.historicalCountUncertain = Boolean(options.historicalCountUncertain);
  }

  manage(adapter: BuilderAdapter): ManagedRoleAdapter {
    if (adapter instanceof ManagedRoleAdapter && adapter.coordinator === this) return adapter;
    const existing = this.managed.get(adapter);
    if (existing) return existing;
    const wrapper = new ManagedRoleAdapter(this, adapter);
    this.managed.set(adapter, wrapper);
    return wrapper;
  }

  async atSafeBoundary(adapter: BuilderAdapter, frozenAction: string): Promise<ContextBoundaryResult> {
    const managed = this.manage(adapter);
    this.active = managed;
    await this.refreshSettings(managed, frozenAction, true);
    let state = await this.ensureInitialized(managed, frozenAction);
    state = await this.recoverMeasurementFailure(managed, state, frozenAction);
    if (state.capabilityFailure) throw this.capability(state.capabilityFailure);
    state = await this.measureIntoState(managed, state, "provider-query").catch((error) => { throw this.capability(error); });
    if ((state.latest.percentage ?? 100) >= this.threshold()) {
      return this.enforceThreshold(managed, state, frozenAction, true);
    }
    this.transition(state, "armed");
    return this.result(managed, state, "below-threshold");
  }

  async atWorkSessionBoundary(adapter: BuilderAdapter, frozenAction: string, strategy: SessionStrategy = this.settings.session_strategy): Promise<ContextBoundaryResult> {
    const managed = this.manage(adapter);
    this.active = managed;
    await this.refreshSettings(managed, frozenAction, true);
    let state = await this.ensureInitialized(managed, frozenAction);
    state = await this.recoverMeasurementFailure(managed, state, frozenAction);
    if (state.capabilityFailure) throw this.capability(state.capabilityFailure);
    state = await this.measureIntoState(managed, state, "provider-query");
    if (strategy === "fresh") {
      return this.performHandoff(managed, state, frozenAction, "ordinary session_strategy=fresh boundary requires a validated fresh successor", false);
    }
    // `compact` is a threshold policy, not an unconditional work-boundary compact.
    if ((state.latest.percentage ?? 100) < this.threshold()) {
      this.transition(state, "armed");
      return this.result(managed, state, "below-threshold");
    }
    return this.enforceThreshold(managed, state, frozenAction, true);
  }

  effectiveSettings(): ResolvedAgentSettings { return this.settings; }
  effectiveThreshold(): number { return this.threshold(); }

  snapshot(): ManagedContextSnapshot | undefined {
    if (!this.active) return undefined;
    const state = this.stateFor(this.active, false);
    if (!state) return undefined;
    return {
      role: this.options.role, provider: this.active.agent, model: this.settings.model,
      lifecycleState: state.state, contextSample: state.latest,
      configuredCeilingPercent: this.threshold(),
      ...(state.installedNativeTokenLimit === undefined ? {} : { installedNativeTokenLimit: state.installedNativeTokenLimit }),
      ...(state.installedNativePercent === undefined ? {} : { installedNativePercent: state.installedNativePercent }),
      compactionCount: state.compactionCount, compactMaximum: this.maximum(), settingsRevision: this.settings.settings_revision,
    };
  }

  contextUsage(adapter: ManagedRoleAdapter): ContextUsage | undefined {
    const state = this.stateFor(adapter, false);
    if (!state || state.latest.freshness !== "fresh" || state.latest.used === undefined) return undefined;
    return {
      used: state.latest.used, maximum: state.latest.maximum, percentage: state.latest.percentage,
      observedAt: state.latest.observedAt, source: state.latest.source, sequence: state.latest.sequence,
      sessionId: state.latest.providerSessionId, model: state.latest.model,
    };
  }

  async dispatch(managed: ManagedRoleAdapter, frozenAction: string, resumed = false): Promise<TurnResult> {
    if (this.dispatchDepth > 0 && this.active === managed) {
      // Nested role wrappers (for example continuity repair) remain inside the
      // already-established gate and native policy.
      return managed.underlying().sendTurn(frozenAction);
    }
    this.active = managed;
    await this.refreshSettings(managed, frozenAction, true);
    let state = await this.ensureInitialized(managed, frozenAction);
    state = await this.recoverMeasurementFailure(managed, state, frozenAction);
    if (state.capabilityFailure) throw this.capability(state.capabilityFailure);
    if (state.state === "handoff_required") {
      const moved = await this.performHandoff(managed, state, frozenAction, state.handoffAfterTurn ?? "durable lifecycle recovery requires a validated successor", false);
      state = this.stateFor(moved.adapter as ManagedRoleAdapter, true)!;
    }
    if ((state.latest.percentage ?? -1) >= this.threshold() || state.state === "threshold_pending" || state.state === "retrying" || state.state === "compacted_unverified") {
      const enforced = await this.enforceThreshold(managed, state, frozenAction, true);
      state = this.stateFor(enforced.adapter as ManagedRoleAdapter, true)!;
    }

    let result: TurnResult;
    this.dispatchDepth += 1;
    try { result = await managed.underlying().sendTurn(frozenAction); }
    finally { this.dispatchDepth -= 1; }
    await managed.settleEvents();

    // A continuity-owned validated handoff may adopt its successor while the
    // outer action is still running. Establish independent successor state
    // before interpreting any post-turn lifecycle flags.
    state = this.stateFor(managed, false) ?? await this.ensureInitialized(managed, frozenAction);
    if (state.capabilityFailure) {
      // The in-flight action settled. Preserve its result, then fence the next turn.
      this.options.report?.({ kind: "capability-failure", detail: state.capabilityFailure, sample: state.latest });
      return result;
    }
    if (state.boundaryHandoff) {
      if (!result.interrupted) {
        state.capabilityFailure = "the provider completed a turn after the compact maximum boundary instead of returning a distinct interrupted result";
        this.persist(state);
        return result;
      }
      if (resumed) throw this.capability("a fresh successor immediately repeated a maximum-triggered compaction boundary");
      await this.performHandoff(managed, state, frozenAction, state.boundaryHandoff.reason, true);
      return this.dispatch(managed, frozenAction, true);
    }

    try { await this.refreshSettings(managed, frozenAction, true); }
    catch (error) {
      state.capabilityFailure = sanitize(error);
      this.persist(state);
      return result;
    }
    try { state = await this.measureIntoState(managed, this.stateFor(managed, true)!, "provider-query"); }
    catch (error) {
      state.capabilityFailure = `context measurement failed after provider action: ${sanitize(error)}`;
      this.persist(state);
      return result;
    }
    if ((state.latest.percentage ?? 100) >= this.threshold() || state.retryAfterTurn || state.handoffAfterTurn) {
      await this.enforceThreshold(managed, state, frozenAction, true);
    }
    return result;
  }

  /** Same gate for continuity repair, recursive continuation, and runtime retry. */
  async dispatchFollowup(managed: ManagedRoleAdapter, frozenAction: string, invoke: () => Promise<TurnResult>): Promise<TurnResult> {
    if (this.dispatchDepth === 0 || this.active !== managed) {
      throw this.capability("a wrapper attempted a provider follow-up outside the managed role dispatcher");
    }
    let state = this.stateFor(managed, false) ?? await this.ensureInitialized(managed, frozenAction);
    if (state.capabilityFailure) throw this.capability(state.capabilityFailure);
    if (state.state === "handoff_required") {
      await this.performHandoff(managed, state, frozenAction, state.handoffAfterTurn ?? "durable lifecycle recovery requires a validated successor", false);
      state = this.stateFor(managed, true)!;
    }
    if ((state.latest.percentage ?? -1) >= this.threshold()
      || state.state === "threshold_pending" || state.state === "retrying" || state.state === "compacted_unverified") {
      await this.enforceThreshold(managed, state, frozenAction, true);
    }
    return invoke();
  }

  async compactExplicit(managed: ManagedRoleAdapter): Promise<CompactResult> {
    try {
      const state = await this.ensureInitialized(managed, "explicit native compaction");
      const result = await this.compactAndVerify(managed, state, "explicit native compaction", true);
      return { ok: result.action === "compacted" || result.action === "handed-off" };
    } catch (error) {
      if (error instanceof SessionUnavailableError) return { ok: false, error: error.message, failure: error.failure };
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  unregister(managed: ManagedRoleAdapter): void {
    this.settingsWatchers.get(managed)?.stop();
    this.settingsWatchers.delete(managed);
    const sessionKey = managed.activeSessionKey();
    const db = new WorkflowDb(this.options.projectDir);
    try { if (sessionKey) db.clearRoleAdapterActive(this.options.runId, this.options.role, sessionKey); }
    finally { db.close(); }
    if (this.active === managed) this.active = undefined;
  }

  async observe(managed: ManagedRoleAdapter, source: BuilderAdapter, event: BuilderEvent): Promise<void> {
    if (source !== managed.underlying()) return;
    if (event.kind === "context-usage") {
      const state = this.stateFor(managed, false);
      if (!state) return;
      this.acceptUsage(managed, state, event, event.source ?? "provider-event");
      return;
    }
    if (event.kind === "context-compaction") await this.observeCompaction(managed, event);
  }

  private async ensureInitialized(managed: ManagedRoleAdapter, frozenAction: string): Promise<SessionContextState> {
    let existing = this.stateFor(managed, false);
    if (existing && existing.settingsRevision === this.settings.settings_revision && existing.model === this.settings.model) {
      this.markActive(managed, existing);
      this.ensureSettingsWatcher(managed, frozenAction);
      return existing;
    }
    const raw = managed.underlying();
    const prepared = await this.installNative(raw, this.settings, !existing);
    const key = adapterStateKey(raw) ?? `pending:${this.options.role}:${++this.provisional}`;
    if (this.options.requireNativeContextManagement && key.includes(":unscoped:")) {
      throw this.capability("provider initialized context management without a location-scoped session reference");
    }
    existing = this.states.get(key);
    if (!existing) existing = this.recoverOrCreateState(managed, key, frozenAction);
    existing.installedNativeTokenLimit = prepared.installedNativeTokenLimit;
    existing.installedNativePercent = prepared.installedNativePercent;
    existing.settingsRevision = this.settings.settings_revision;
    existing.model = this.settings.model;
    if (prepared.sample) this.acceptUsage(managed, existing, prepared.sample, prepared.sample.source ?? "provider-query");
    if (existing.latest.freshness !== "fresh") existing = await this.measureIntoState(managed, existing, "provider-query");
    if (existing.state === "native_compacting" || existing.state === "host_compacting") {
      this.reconcileIncompleteCompaction(managed, existing);
    } else if (existing.state === "compacted_unverified") {
      if ((existing.latest.percentage ?? 100) < this.threshold()) this.transition(existing, "armed");
      else existing.handoffAfterTurn = "recovered compaction remained unverified at or above the configured ceiling";
    } else if (existing.state !== "handoff_required") {
      this.transition(existing, (existing.latest.percentage ?? 100) < this.threshold() ? "armed" : "threshold_pending");
    }
    this.markActive(managed, existing);
    this.ensureSettingsWatcher(managed, frozenAction);
    return existing;
  }

  private async installNative(adapter: BuilderAdapter, settings: ResolvedAgentSettings, initial: boolean): Promise<PreparedContextManagement> {
    const strict = Boolean(this.options.requireNativeContextManagement);
    if (strict && (!adapter.prepareContextManagement || !adapter.updateContextManagement || !adapter.interruptTurnAtCompactionBoundary)) {
      throw this.capability(`${adapter.agent} does not expose prepare, live update, and compaction-boundary interruption capabilities`);
    }
    const known = this.persistedMaximum(adapter, settings.model);
    const policy: ContextManagementPolicy = {
      role: this.options.role, configuredThresholdPercent: settings.auto_compact_threshold_percent,
      compactMaximum: settings.compact_maximum, settingsRevision: settings.settings_revision, model: settings.model,
      providerSequenceStart: this.providerSequence(adapter), ...(known ? { knownModelContextWindow: known } : {}),
      nativeCompactionEnabled: true,
    };
    const method = initial ? adapter.prepareContextManagement : adapter.updateContextManagement;
    if (method) {
      const prepared = await method.call(adapter, policy);
      if (prepared.installedNativePercent > settings.auto_compact_threshold_percent + 0.01) {
        throw this.capability(`installed native ceiling ${prepared.installedNativePercent.toFixed(2)}% is later than configured ${settings.auto_compact_threshold_percent}%`);
      }
      return prepared;
    }
    const usage = await adapter.contextUsage?.();
    if (!usage?.maximum) throw this.capability("provider context occupancy and model maximum are unavailable");
    const configuredTokenLimit = Math.max(1, Math.floor(usage.maximum * settings.auto_compact_threshold_percent / 100));
    return { modelContextWindow: usage.maximum, configuredTokenLimit, installedNativeTokenLimit: configuredTokenLimit, installedNativePercent: settings.auto_compact_threshold_percent, sample: usage };
  }

  private recoverOrCreateState(managed: ManagedRoleAdapter, key: string, frozenAction: string): SessionContextState {
    const db = new WorkflowDb(this.options.projectDir);
    try {
      const prior = db.thresholdGenerations(this.options.runId, this.options.role, key).at(-1);
      if (prior && prior.model === this.settings.model && prior.settingsRevision === this.settings.settings_revision) {
        const state: SessionContextState = {
          key, generationId: prior.generationId, generation: prior.generation, state: prior.state,
          settingsRevision: prior.settingsRevision, model: prior.model,
          latest: prior.latestSample ?? this.measuringSample(managed, key, prior.generation),
          latestProviderSequence: prior.latestSample?.sequence ?? 0,
          installedNativeTokenLimit: prior.installedNativeTokenLimit,
          installedNativePercent: prior.installedNativePercent,
          compactionCount: db.successfulCompactionCount(this.options.runId, this.options.role, managed.sessionRef?.() ?? managed.sessionId()),
        };
        this.states.set(key, state);
        return state;
      }
      const generation = (prior?.generation ?? 0) + 1;
      const state: SessionContextState = {
        key, generation, generationId: this.generationId(key, generation), state: "initializing",
        settingsRevision: this.settings.settings_revision, model: this.settings.model,
        latest: this.measuringSample(managed, key, generation), latestProviderSequence: 0,
        compactionCount: db.successfulCompactionCount(this.options.runId, this.options.role, managed.sessionRef?.() ?? managed.sessionId()),
      };
      this.states.set(key, state);
      this.persist(state, frozenAction);
      return state;
    } finally { db.close(); }
  }

  private reconcileIncompleteCompaction(managed: ManagedRoleAdapter, state: SessionContextState): void {
    const db = new WorkflowDb(this.options.projectDir);
    try {
      const incomplete = db.compactionAttempts(this.options.runId, this.options.role, managed.sessionRef?.() ?? managed.sessionId())
        .filter((attempt) => attempt.status === "started" && attempt.thresholdGenerationId === state.generationId);
      if (!incomplete.length) {
        this.transition(state, (state.latest.percentage ?? 100) < this.threshold() ? "armed" : "retrying");
        return;
      }
      if ((state.latest.percentage ?? 100) < this.threshold()) {
        for (const attempt of incomplete) db.finishCompactionAttempt(attempt.idempotencyKey, { ok: true, afterSample: state.latest });
        state.compactionCount = db.successfulCompactionCount(this.options.runId, this.options.role, managed.sessionRef?.() ?? managed.sessionId());
        this.transition(state, "armed");
      } else {
        for (const attempt of incomplete) db.finishCompactionAttempt(attempt.idempotencyKey, { ok: true, status: "unverified", error: "process restarted before provider completion could be reconciled" });
        state.compactionCount = db.successfulCompactionCount(this.options.runId, this.options.role, managed.sessionRef?.() ?? managed.sessionId());
        state.handoffAfterTurn = "an in-flight compaction could not be reconciled after recovery";
        this.transition(state, "compacted_unverified");
      }
    } finally { db.close(); }
  }

  private stateFor(managed: ManagedRoleAdapter, required: boolean): SessionContextState | undefined {
    const key = adapterStateKey(managed.underlying());
    const state = key ? this.states.get(key) : undefined;
    if (!state && required) throw this.capability("managed role adapter has no initialized scoped-session state");
    return state;
  }

  private async measureIntoState(managed: ManagedRoleAdapter, state: SessionContextState, source: ContextSample["source"], requireNewerThan?: number): Promise<SessionContextState> {
    const attempts = Math.max(1, this.options.contextRetries ?? 3);
    let lastError = "truthful context occupancy is unavailable";
    for (let attempt = 0; attempt < attempts; attempt++) {
      let usage: ContextUsage | undefined;
      try { usage = await managed.underlying().contextUsage?.(); }
      catch (error) { lastError = sanitize(error); }
      if (usage && Number.isFinite(usage.used) && (usage.percentage !== undefined || usage.maximum !== undefined)) {
        const accepted = this.acceptUsage(managed, state, usage, source, requireNewerThan);
        if (accepted) return state;
        lastError = "provider returned only a stale or out-of-order context sample";
      }
      if (attempt + 1 < attempts) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw this.capability(`${lastError} after ${attempts} bounded provider query attempt(s)`);
  }

  private async recoverMeasurementFailure(managed: ManagedRoleAdapter, state: SessionContextState, frozenAction: string): Promise<SessionContextState> {
    if (!state.capabilityFailure?.startsWith("context measurement failed after provider action:")) return state;
    try {
      state = await this.measureIntoState(managed, state, "provider-query");
      state.capabilityFailure = undefined;
      this.transition(state, (state.latest.percentage ?? 100) < this.threshold() ? "armed" : "threshold_pending");
    } catch (error) {
      state.capabilityFailure = `context measurement failed after provider action: ${sanitize(error)}`;
      this.persist(state, frozenAction);
    }
    return state;
  }

  private acceptUsage(managed: ManagedRoleAdapter, state: SessionContextState, usage: ContextUsage, source: ContextSample["source"], requireNewerThan?: number): boolean {
    if (!Number.isFinite(usage.used)) return false;
    const percentage = usage.percentage ?? (usage.maximum ? usage.used / usage.maximum * 100 : undefined);
    if (percentage === undefined || !Number.isFinite(percentage)) return false;
    if (usage.sessionId && managed.sessionId() && usage.sessionId !== managed.sessionId()) return false;
    if (usage.model && this.settings.model !== "default" && usage.model !== this.settings.model) return false;
    const sequence = usage.sequence;
    if (sequence !== undefined && sequence === state.latestProviderSequence && requireNewerThan === undefined && state.latest.freshness === "fresh") return true;
    if (sequence !== undefined && sequence < state.latestProviderSequence) return false;
    if (requireNewerThan !== undefined && sequence !== undefined && sequence <= requireNewerThan) return false;
    if (requireNewerThan !== undefined && sequence === undefined
      && state.latest.used === usage.used && state.latest.maximum === usage.maximum && state.latest.percentage === percentage) return false;
    if (sequence !== undefined) state.latestProviderSequence = sequence;
    if (state.capabilityFailure?.startsWith("context measurement failed after provider action:")) state.capabilityFailure = undefined;
    const ref = managed.sessionRef?.();
    state.compactionCount = this.compactionCount(ref ?? managed.sessionId());
    state.latest = {
      version: 1, runId: this.options.runId, role: this.options.role, provider: managed.agent,
      providerSessionId: managed.sessionId(), ...(ref ? { sessionRef: ref, sessionKey: providerSessionKey(ref) } : { sessionKey: state.key }),
      model: this.settings.model, observedAt: usage.observedAt ?? this.now().toISOString(), source, freshness: "fresh",
      used: usage.used, maximum: usage.maximum, percentage, settingsRevision: this.settings.settings_revision,
      compactionCount: state.compactionCount, handoffGeneration: this.handoffGeneration(),
      ...(sequence === undefined ? {} : { sequence }), thresholdGeneration: state.generation,
    };
    const db = new WorkflowDb(this.options.projectDir);
    try { db.recordContextSample(state.latest); } finally { db.close(); }
    this.persist(state);
    this.options.report?.({
      kind: "context-sample",
      detail: `authoritative context ${percentage.toFixed(1)}% (${usage.used}${usage.maximum === undefined ? "" : `/${usage.maximum}`})`,
      sample: state.latest,
    });
    if (percentage >= this.threshold() && state.state === "armed") this.beginGeneration(state, "threshold_pending");
    return true;
  }

  private async enforceThreshold(managed: ManagedRoleAdapter, state: SessionContextState, frozenAction: string, allowHandoff: boolean): Promise<ContextBoundaryResult> {
    if (state.handoffAfterTurn) return this.performHandoff(managed, state, frozenAction, state.handoffAfterTurn, false);
    if (this.historicalCountUncertain) return this.performHandoff(managed, state, frozenAction, "historical compaction count is uncertain; handing off rather than risking the configured maximum", false);
    if ((state.latest.percentage ?? 100) < this.threshold() && !state.retryAfterTurn) {
      this.transition(state, "armed");
      return this.result(managed, state, "below-threshold");
    }
    if (state.compactionCount >= this.maximum()) return this.performHandoff(managed, state, frozenAction, `compact maximum ${this.maximum()} reached`, false);
    return this.compactAndVerify(managed, state, frozenAction, allowHandoff);
  }

  private async compactAndVerify(managed: ManagedRoleAdapter, state: SessionContextState, frozenAction: string, allowHandoff: boolean): Promise<ContextBoundaryResult> {
    const raw = managed.underlying();
    if (!raw.compact) {
      if (allowHandoff) return this.performHandoff(managed, state, frozenAction, "native compaction is unavailable", false);
      throw this.capability("fresh successor does not expose native compaction");
    }
    let failure = "native compaction failed";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const terminalAttempts = this.generationTerminalAttempts(managed, state);
      if (terminalAttempts >= 2) {
        failure = "the threshold generation exhausted its one bounded compaction retry";
        break;
      }
      state.compactionCount = this.compactionCount(managed.sessionRef?.() ?? managed.sessionId());
      if (state.compactionCount >= this.maximum()) break;
      if (attempt > 1) this.transition(state, "retrying");
      else if (state.state === "armed") this.beginGeneration(state, "threshold_pending");
      this.transition(state, "host_compacting");
      const beforeSample = state.latest;
      const beforeProviderSequence = state.latestProviderSequence;
      this.invalidateSample(managed, state);
      const crossingKey = `${state.key}:${state.generation}:${attempt}:${sha(frozenAction).slice(0, 20)}`;
      const idempotencyKey = `compact:${this.options.runId}:${this.options.role}:${sha(crossingKey).slice(0, 24)}`;
      const db = new WorkflowDb(this.options.projectDir);
      const prior = db.startCompactionAttempt({
        idempotencyKey, runId: this.options.runId, role: this.options.role,
        providerSessionId: managed.sessionId(), sessionRef: managed.sessionRef?.(), sessionKey: state.key,
        crossingKey, beforeSample, origin: "rafi-manual", thresholdGenerationId: state.generationId,
      });
      db.close();
      if (prior.status !== "started") {
        const recoveredSample = prior.afterSample ?? prior.beforeSample;
        if (recoveredSample) {
          state.latest = recoveredSample;
          state.latestProviderSequence = Math.max(state.latestProviderSequence, recoveredSample.sequence ?? 0);
        }
        state.compactionCount = this.compactionCount(managed.sessionRef?.() ?? managed.sessionId());
        if (prior.status === "succeeded" && prior.afterSample && (prior.afterSample.percentage ?? 100) < this.threshold()) {
          this.transition(state, "armed");
          return this.result(managed, state, "compacted");
        }
        if (prior.status === "unverified" || (prior.status === "succeeded" && !prior.afterSample)) {
          this.transition(state, "compacted_unverified");
          if (allowHandoff) return this.performHandoff(managed, state, frozenAction, "a recovered compaction has no authoritative post-compact sample", false);
          throw this.capability("fresh successor compaction could not be verified after recovery");
        }
        failure = prior.status === "failed"
          ? sanitize(prior.error ?? "the prior compaction attempt failed")
          : `the prior compaction remained at ${prior.afterSample?.percentage?.toFixed(1) ?? "an unknown"}%`;
        // The durable terminal attempt already consumed this ordinal. Move to
        // the one remaining retry rather than issuing the same compaction again.
        continue;
      }
      state.manualAttemptKey = idempotencyKey;
      this.options.report?.({ kind: attempt === 1 ? "compacting" : "retrying", detail: `context reached ${this.threshold()}%; compaction ${state.compactionCount + 1}/${this.maximum()}`, sample: state.latest });
      let compacted: CompactResult;
      try { compacted = await raw.compact(); }
      catch (error) { compacted = error instanceof SessionUnavailableError ? { ok: false, error: error.message, failure: error.failure } : { ok: false, error: sanitize(error) }; }
      await managed.settleEvents();
      state.manualAttemptKey = undefined;
      if (compacted.failure?.category === "session-unavailable") {
        const failed = new WorkflowDb(this.options.projectDir);
        try {
          failed.finishCompactionAttempt(idempotencyKey, { ok: false, error: compacted.error ?? compacted.failure.diagnostics });
          this.recordCompactionSessionUnavailable(failed, managed, compacted.failure);
        }
        finally { failed.close(); }
        throw sessionUnavailableErrorFromFailure(compacted.failure);
      }
      if (!compacted.ok) {
        failure = sanitize(compacted.error ?? "provider did not explicitly complete compaction");
        const failed = new WorkflowDb(this.options.projectDir);
        try { failed.finishCompactionAttempt(idempotencyKey, { ok: false, error: failure }); }
        finally { failed.close(); }
        continue; // one bounded retry; failures do not consume compact slots
      }
      let after: ContextSample | undefined;
      try {
        state = await this.measureIntoState(managed, state, "post-compact", beforeProviderSequence);
        after = state.latest;
      } catch (error) {
        failure = sanitize(error);
      }
      const completed = new WorkflowDb(this.options.projectDir);
      try {
        completed.finishCompactionAttempt(idempotencyKey, after
          ? { ok: true, afterSample: after }
          : { ok: true, status: "unverified", error: failure });
        state.compactionCount = completed.successfulCompactionCount(this.options.runId, this.options.role, managed.sessionRef?.() ?? managed.sessionId());
      } finally { completed.close(); }
      if (!after) {
        this.transition(state, "compacted_unverified");
        if (allowHandoff) return this.performHandoff(managed, state, frozenAction, "provider reported compaction but no newer authoritative post-compact sample was available", false);
        throw this.capability("fresh successor compaction could not be verified");
      }
      this.options.report?.({ kind: "compacted", detail: `context reduced to ${after.percentage?.toFixed(1)}%`, sample: after });
      if ((after.percentage ?? 100) < this.threshold()) {
        state.retryAfterTurn = undefined;
        this.transition(state, "armed");
        return this.result(managed, state, "compacted");
      }
      failure = `compaction remained at ${after.percentage?.toFixed(1)}%, at or above the configured ${this.threshold()}% ceiling`;
      if (this.generationTerminalAttempts(managed, state) >= 2 || state.compactionCount >= this.maximum()) break;
    }
    if (allowHandoff) return this.performHandoff(managed, state, frozenAction, failure, false);
    throw this.capability(`fresh successor could not get below the configured ceiling after bounded compaction: ${failure}`);
  }

  private async performHandoff(managed: ManagedRoleAdapter, state: SessionContextState, frozenAction: string, reason: string, resumeFrozenAction: boolean): Promise<ContextBoundaryResult> {
    if (!this.options.handoff) throw this.capability(`${reason}; validated handoff is unavailable`);
    this.transition(state, "handoff_required", frozenAction);
    this.options.report?.({ kind: "handoff", detail: reason, sample: state.latest });
    const predecessorKey = state.key;
    const successor = await this.options.handoff({
      reason, adapter: managed.underlying(), sample: state.latest, settings: this.settings,
      compactionCount: state.compactionCount, frozenAction,
    });
    const successorRaw = successor instanceof ManagedRoleAdapter ? successor.underlying() : successor;
    const successorKey = adapterStateKey(successorRaw);
    if (!successorKey || successorKey === predecessorKey) throw this.capability("validated handoff did not produce a genuinely fresh location-scoped successor");
    managed.replace(successorRaw);
    this.historicalCountUncertain = false;
    let next = await this.ensureInitialized(managed, frozenAction);
    this.transition(next, "resuming", frozenAction);
    next = await this.measureIntoState(managed, next, "provider-query");
    if ((next.latest.percentage ?? 100) >= this.threshold()) {
      await this.compactAndVerify(managed, next, frozenAction, false);
      next = this.stateFor(managed, true)!;
    }
    this.transition(next, "armed");
    if (resumeFrozenAction) next.boundaryHandoff = undefined;
    return this.result(managed, next, "handed-off");
  }

  private async observeCompaction(managed: ManagedRoleAdapter, event: ContextCompactionEvent): Promise<void> {
    const state = this.stateFor(managed, false);
    if (!state) return;
    if (event.sessionId && managed.sessionId() && event.sessionId !== managed.sessionId()) return;
    const eventKey = `${state.key}:${event.providerEventId}`;
    const phaseKey = `${eventKey}:${event.phase}`;
    if (this.observedCompactionPhases.has(phaseKey)) return;
    this.observedCompactionPhases.add(phaseKey);
    if (event.origin === "rafi-manual" && state.manualAttemptKey) {
      const db = new WorkflowDb(this.options.projectDir);
      try { db.linkCompactionProviderEvent(state.manualAttemptKey, event.providerEventId); }
      catch { /* a duplicate provider event is already durably linked */ }
      finally { db.close(); }
      this.nativeAttempts.set(eventKey, state.manualAttemptKey);
      return; // the host compact path owns success verification and accounting
    }
    if (event.origin === "rafi-manual" && this.nativeAttempts.has(eventKey)) return;
    if (event.phase === "started") {
      if (state.compactionCount >= this.maximum()) {
        await this.interruptForHandoff(
          managed,
          state,
          event.providerEventId,
          `compact maximum ${this.maximum()} reached at native boundary ${event.providerEventId}`,
        );
        return;
      }
      if (state.state === "armed") this.beginGeneration(state, "threshold_pending");
      if (state.handoffAfterTurn || this.generationTerminalAttempts(managed, state) >= 2) {
        await this.interruptForHandoff(
          managed,
          state,
          event.providerEventId,
          state.handoffAfterTurn
            ?? `bounded compaction retry exhausted at native boundary ${event.providerEventId}`,
        );
        return;
      }
      this.transition(state, "native_compacting", undefined, event.providerEventId);
      const beforeSample = state.latest;
      this.invalidateSample(managed, state);
      const idempotencyKey = `native:${this.options.runId}:${this.options.role}:${sha(eventKey).slice(0, 24)}`;
      const db = new WorkflowDb(this.options.projectDir);
      const attempt = db.startCompactionAttempt({
        idempotencyKey, runId: this.options.runId, role: this.options.role,
        providerSessionId: managed.sessionId(), sessionRef: managed.sessionRef?.(), sessionKey: state.key,
        crossingKey: eventKey, beforeSample, origin: event.origin,
        providerEventId: event.providerEventId, thresholdGenerationId: state.generationId,
      });
      db.close();
      this.nativeAttempts.set(eventKey, attempt.idempotencyKey);
      return;
    }
    const idempotencyKey = this.nativeAttempts.get(eventKey) ?? `native:${this.options.runId}:${this.options.role}:${sha(eventKey).slice(0, 24)}`;
    const observedStart = this.nativeAttempts.has(eventKey);
    const db = new WorkflowDb(this.options.projectDir);
    let attempt = db.compactionAttempt(idempotencyKey);
    if (!attempt) attempt = db.startCompactionAttempt({
      idempotencyKey, runId: this.options.runId, role: this.options.role,
      providerSessionId: managed.sessionId(), sessionRef: managed.sessionRef?.(), sessionKey: state.key,
      crossingKey: eventKey, beforeSample: state.latest, origin: event.origin,
      providerEventId: event.providerEventId, thresholdGenerationId: state.generationId,
    });
    if (attempt.status !== "started") { db.close(); return; }
    if (event.phase === "failed") {
      db.finishCompactionAttempt(attempt.idempotencyKey, { ok: false, error: event.reason ?? "provider-native compaction failed" });
      db.close();
      state.retryAfterTurn = event.reason ?? "provider-native compaction failed";
      this.transition(state, "retrying");
      return;
    }
    db.close();
    if (!observedStart && event.origin !== "rafi-manual") {
      state.capabilityFailure = `provider completed native compaction ${event.providerEventId} without an observable start boundary; compact maximum ${this.maximum()} cannot be enforced`;
      this.persist(state, undefined, event.providerEventId);
    }
    if (state.boundaryHandoff?.providerEventId === event.providerEventId) {
      const exceeded = new WorkflowDb(this.options.projectDir);
      try { exceeded.finishCompactionAttempt(attempt.idempotencyKey, { ok: true, status: "unverified", error: "provider completed a vetoed over-maximum compaction" }); }
      finally { exceeded.close(); }
      state.compactionCount = this.compactionCount(managed.sessionRef?.() ?? managed.sessionId());
      state.capabilityFailure = `provider completed native compaction ${event.providerEventId} beyond compact maximum ${this.maximum()}`;
      this.persist(state);
      return;
    }
    if (event.postCompactSample) this.acceptUsage(managed, state, event.postCompactSample, "post-compact");
    let verified = state.latest.freshness === "fresh" && state.latest.sequence !== undefined && state.latest.sequence > (attempt.beforeSample?.sequence ?? -1);
    if (!verified) {
      try { await this.measureIntoState(managed, state, "post-compact", attempt.beforeSample?.sequence); verified = true; }
      catch { verified = false; }
    }
    const completed = new WorkflowDb(this.options.projectDir);
    try {
      completed.finishCompactionAttempt(attempt.idempotencyKey, verified
        ? { ok: true, afterSample: state.latest }
        : { ok: true, status: "unverified", error: "no newer authoritative post-compact sample" });
      state.compactionCount = completed.successfulCompactionCount(this.options.runId, this.options.role, managed.sessionRef?.() ?? managed.sessionId());
    } finally { completed.close(); }
    if (!verified) {
      state.handoffAfterTurn = "provider-native compaction succeeded but post-compact occupancy could not be verified";
      this.transition(state, "compacted_unverified");
    } else if ((state.latest.percentage ?? 100) < this.threshold()) {
      this.transition(state, "armed");
    } else {
      state.retryAfterTurn = `provider-native compaction remained at ${state.latest.percentage?.toFixed(1)}%`;
      this.transition(state, "retrying");
    }
  }

  private async interruptForHandoff(
    managed: ManagedRoleAdapter,
    state: SessionContextState,
    providerEventId: string,
    reason: string,
  ): Promise<void> {
    state.boundaryHandoff = { providerEventId, reason };
    this.transition(state, "handoff_required", undefined, providerEventId);
    const interrupted = await managed.underlying().interruptTurnAtCompactionBoundary?.(providerEventId);
    if (!interrupted?.ok) {
      state.capabilityFailure = `provider could not stop native compaction ${providerEventId}: ${interrupted?.error ?? "interrupt unavailable"}`;
      this.persist(state);
    }
  }

  private generationTerminalAttempts(managed: ManagedRoleAdapter, state: SessionContextState): number {
    const session = managed.sessionRef?.() ?? managed.sessionId();
    if (!session) return 0;
    const db = new WorkflowDb(this.options.projectDir);
    try {
      return db.compactionAttempts(this.options.runId, this.options.role, session)
        .filter((attempt) => attempt.thresholdGenerationId === state.generationId && attempt.status !== "started")
        .length;
    } finally { db.close(); }
  }

  private async refreshSettings(managed: ManagedRoleAdapter, frozenAction: string, allowTransition: boolean): Promise<void> {
    // Timer-driven and post-turn refreshes can meet at the same provider
    // boundary. Wait for the active installation, then re-read the revision so
    // neither caller can proceed on partially applied settings or miss a newer
    // revision that arrived during the first installation.
    while (this.refreshingSettings) await this.refreshingSettings;
    if (managed.isClosed()) return;
    const candidate = this.options.readSettings?.();
    if (!candidate || candidate.settings_revision <= this.settings.settings_revision) return;
    const lifecycle = this.stateFor(managed, false)?.state;
    if (lifecycle === "native_compacting" || lifecycle === "host_compacting") return;
    const next = normalizeContextSettings(candidate);
    const providerControlsChanged = next.make !== this.settings.make || next.model !== this.settings.model || next.reasoning !== this.settings.reasoning || next.fast !== this.settings.fast;
    if (providerControlsChanged && !allowTransition) return;
    let releaseRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    this.refreshingSettings = refresh;
    try {
      if (providerControlsChanged) {
        let adopted: BuilderAdapter;
        if (this.options.settingsBoundary) {
          adopted = await this.options.settingsBoundary({ adapter: managed.underlying(), current: this.settings, next, frozenAction });
        } else if (next.make === this.settings.make && managed.underlying().switchSettings) {
          const switched = await managed.underlying().switchSettings!({ model: next.model === "default" ? undefined : next.model, effort: effort(next.reasoning), fast: next.fast });
          if (switched.failure?.category === "session-unavailable") throw sessionUnavailableErrorFromFailure(switched.failure);
          if (!switched.ok) throw this.capability(`settings revision ${next.settings_revision} could not be applied safely: ${sanitize(switched.error ?? "provider rejected settings")}`);
          adopted = managed.underlying();
        } else throw this.capability(`settings revision ${next.settings_revision} requires a validated provider/model handoff`);
        const raw = adopted instanceof ManagedRoleAdapter ? adopted.underlying() : adopted;
        if (raw.agent !== next.make) throw this.capability(`settings revision ${next.settings_revision} requested ${next.make}, but successor reports ${raw.agent}`);
        managed.replace(raw);
        this.settings = next;
        await this.ensureInitialized(managed, frozenAction);
      } else {
        // Threshold-only revisions are acknowledged only after native control is installed.
        const priorState = this.stateFor(managed, false);
        if (!priorState) {
          this.settings = next;
          await this.ensureInitialized(managed, frozenAction);
        } else {
          const prepared = await this.installNative(managed.underlying(), next, false);
          this.settings = next;
          const state = this.stateFor(managed, true)!;
          this.beginGeneration(state, (state.latest.percentage ?? 100) < this.threshold() ? "armed" : "threshold_pending");
          state.settingsRevision = next.settings_revision;
          state.model = next.model;
          state.installedNativeTokenLimit = prepared.installedNativeTokenLimit;
          state.installedNativePercent = prepared.installedNativePercent;
          if (prepared.sample) this.acceptUsage(managed, state, prepared.sample, prepared.sample.source ?? "provider-query");
          this.persist(state, frozenAction);
        }
      }
      const adoptedState = this.stateFor(managed, false);
      if (adoptedState?.capabilityFailure) {
        adoptedState.capabilityFailure = undefined;
        this.persist(adoptedState, frozenAction);
      }
      const db = new WorkflowDb(this.options.projectDir);
      try {
        const ref = managed.sessionRef?.();
        db.acknowledgeSettings({ runId: this.options.runId, role: this.options.role, providerSessionId: managed.sessionId(), ...(ref ? { sessionRef: ref, sessionKey: providerSessionKey(ref) } : {}), revision: next.settings_revision, acknowledgedAt: this.now().toISOString() });
      } finally { db.close(); }
      this.options.settingsAdopted?.(next, managed);
      this.options.report?.({ kind: "settings-adopted", detail: `adopted settings revision ${next.settings_revision}` });
    } finally {
      releaseRefresh();
      if (this.refreshingSettings === refresh) this.refreshingSettings = undefined;
    }
  }

  private ensureSettingsWatcher(managed: ManagedRoleAdapter, frozenAction: string): void {
    if (managed.isClosed()) return;
    const existing = this.settingsWatchers.get(managed);
    if (existing) {
      existing.frozenAction = frozenAction;
      return;
    }
    if (!this.options.readSettings) return;
    const watcher = { frozenAction, stop: () => {} };
    const timer = setInterval(() => {
      // Provider/model transitions may hand off only while no role turn is in
      // flight. Threshold-only changes may be attempted during a turn; an
      // adapter that cannot safely reconfigure then is retried while idle.
      void this.refreshSettings(managed, watcher.frozenAction, this.dispatchDepth === 0).catch((error) => {
        const state = this.stateFor(managed, false);
        if (state && this.dispatchDepth > 0) {
          this.options.report?.({ kind: "settings-pending", detail: sanitize(error), sample: state.latest });
          this.transition(state, "threshold_pending", watcher.frozenAction);
          return;
        }
        if (state) {
          state.capabilityFailure = `live settings revision could not be installed: ${sanitize(error)}`;
          this.options.report?.({ kind: "capability-failure", detail: state.capabilityFailure, sample: state.latest });
          this.transition(state, "threshold_pending", watcher.frozenAction);
        }
        watcher.stop();
        this.settingsWatchers.delete(managed);
      });
      const state = this.stateFor(managed, false);
      if (state) this.markActive(managed, state);
    }, Math.max(50, this.options.settingsPollMs ?? 250));
    timer.unref();
    watcher.stop = () => clearInterval(timer);
    this.settingsWatchers.set(managed, watcher);
  }

  private beginGeneration(state: SessionContextState, lifecycle: ThresholdLifecycleState): void {
    state.generation += 1;
    state.generationId = this.generationId(state.key, state.generation);
    state.state = lifecycle;
    state.latest = { ...state.latest, thresholdGeneration: state.generation, settingsRevision: this.settings.settings_revision };
    state.retryAfterTurn = undefined;
    state.handoffAfterTurn = undefined;
    this.persist(state);
  }

  private transition(state: SessionContextState, lifecycle: ThresholdLifecycleState, frozenAction?: string, providerEventId?: string): void {
    const changed = state.state !== lifecycle;
    state.state = lifecycle;
    this.persist(state, frozenAction, providerEventId);
    if (changed) this.options.report?.({ kind: "lifecycle", detail: lifecycle, sample: state.latest });
  }

  private persist(state: SessionContextState, frozenAction?: string, providerEventId?: string): void {
    const db = new WorkflowDb(this.options.projectDir);
    try {
      const ref = state.latest.sessionRef;
      db.upsertThresholdGeneration({
        generationId: state.generationId, runId: this.options.runId, role: this.options.role,
        providerSessionId: state.latest.providerSessionId, ...(ref ? { sessionRef: ref, sessionKey: providerSessionKey(ref) } : { sessionKey: state.key }),
        generation: state.generation, state: state.state, configuredCeilingPercent: this.threshold(),
        installedNativeTokenLimit: state.installedNativeTokenLimit, installedNativePercent: state.installedNativePercent,
        settingsRevision: this.settings.settings_revision, model: this.settings.model, latestSample: state.latest,
        ...(frozenAction ? { frozenActionDigest: sha(frozenAction) } : {}), ...(providerEventId ? { providerEventId } : {}),
      });
    } finally { db.close(); }
  }

  private invalidateSample(managed: ManagedRoleAdapter, state: SessionContextState): void {
    state.latest = {
      ...this.measuringSample(managed, state.key, state.generation), source: "post-compact",
      observedAt: this.now().toISOString(), freshness: "measuring", compactionCount: state.compactionCount,
    };
    const db = new WorkflowDb(this.options.projectDir);
    try { db.recordContextSample(state.latest); } finally { db.close(); }
    this.persist(state);
  }

  private measuringSample(managed: ManagedRoleAdapter, key: string, generation: number): ContextSample {
    const ref = managed.sessionRef?.();
    return {
      version: 1, runId: this.options.runId, role: this.options.role, provider: managed.agent,
      providerSessionId: managed.sessionId(), ...(ref ? { sessionRef: ref, sessionKey: providerSessionKey(ref) } : { sessionKey: key }),
      model: this.settings.model, observedAt: this.now().toISOString(), source: "provider-query", freshness: "measuring",
      settingsRevision: this.settings.settings_revision, compactionCount: 0, handoffGeneration: this.handoffGeneration(), thresholdGeneration: generation,
    };
  }

  private result(managed: ManagedRoleAdapter, state: SessionContextState, action: ContextBoundaryResult["action"]): ContextBoundaryResult {
    return { adapter: managed, action, sample: state.latest, effectiveThreshold: this.threshold(), compactionCount: state.compactionCount };
  }

  private markActive(managed: ManagedRoleAdapter, state: SessionContextState): void {
    if (managed.isClosed()) return;
    const db = new WorkflowDb(this.options.projectDir);
    try {
      const previous = managed.noteActiveSession(state.key);
      if (previous) db.clearRoleAdapterActive(this.options.runId, this.options.role, previous);
      db.markRoleAdapterActive({ runId: this.options.runId, role: this.options.role, providerSessionId: managed.sessionId(), sessionKey: state.key, settingsRevision: this.settings.settings_revision, observedAt: this.now().toISOString() });
    }
    finally { db.close(); }
  }

  private providerSequence(adapter: BuilderAdapter, state?: SessionContextState): number {
    const key = adapterStateKey(adapter);
    if (state) return state.latestProviderSequence;
    if (!key) return 0;
    const db = new WorkflowDb(this.options.projectDir);
    try {
      return Math.max(0, ...db.thresholdGenerations(this.options.runId, this.options.role, key)
        .map((generation) => generation.latestSample?.sequence ?? 0));
    } finally { db.close(); }
  }

  private recordCompactionSessionUnavailable(
    db: WorkflowDb,
    managed: ManagedRoleAdapter,
    failure: NonNullable<CompactResult["failure"]>,
  ): void {
    const sessionRef = managed.sessionRef?.();
    db.appendContinuityEvent({
      runId: this.options.runId,
      role: "host",
      kind: "session_unavailable",
      payload: {
        role: this.options.role,
        operation: "native-compaction",
        phase: failure.phase,
        dispatchState: failure.dispatchState ?? "unknown",
        reason: failure.availability?.reason,
        detail: failure.diagnostics,
      },
      authoritativeStateRevision: db.continuityHead(this.options.runId, this.options.role)?.authoritativeStateRevision ?? this.settings.settings_revision,
      sessionRef,
    });
    if (failure.dispatchState === "unknown") db.setContinuityHeadState(this.options.runId, this.options.role, "degraded");
  }

  private persistedMaximum(adapter: BuilderAdapter, model: string): number | undefined {
    const key = adapterStateKey(adapter);
    if (!key) return undefined;
    const db = new WorkflowDb(this.options.projectDir);
    try { return db.thresholdGenerations(this.options.runId, this.options.role, key).filter((item) => item.model === model).at(-1)?.latestSample?.maximum; }
    finally { db.close(); }
  }

  private compactionCount(session?: string | ProviderSessionRefV1): number {
    if (!session) return 0;
    const db = new WorkflowDb(this.options.projectDir);
    try { return db.successfulCompactionCount(this.options.runId, this.options.role, session); }
    finally { db.close(); }
  }

  private handoffGeneration(): number {
    const db = new WorkflowDb(this.options.projectDir);
    try { return db.handoffs(this.options.runId).at(-1)?.generation ?? 0; }
    finally { db.close(); }
  }

  private generationId(key: string, generation: number): string {
    return `threshold:${this.options.runId}:${this.options.role}:${sha(`${key}:${generation}`).slice(0, 24)}`;
  }
  private threshold(): number { return this.settings.auto_compact_threshold_percent; }
  private maximum(): number { return this.settings.compact_maximum; }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private capability(error: unknown): ContextCapabilityError { return error instanceof ContextCapabilityError ? error : new ContextCapabilityError(this.options.runId, this.options.role, sanitize(error)); }
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

function adapterStateKey(adapter: BuilderAdapter): string | undefined {
  return adapterSessionKey(adapter) ?? (adapter.sessionId() ? `${adapter.agent}:unscoped:${adapter.sessionId()}` : undefined);
}
