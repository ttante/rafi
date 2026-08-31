import type { ContextSample, SessionUsageSample } from "rafi-spec";
import { providerSessionKey } from "./sessionIdentity.js";
import type { BuilderAdapter, BuilderEvent, CompactResult, ContextUsage, ProviderSessionUsage, ProviderSettingSwitch, TurnResult } from "./adapters/types.js";

export interface AgentStatusSnapshot {
  role: "builder" | "qa";
  provider: "claude" | "codex";
  model: string;
  reasoning: string;
  fast: boolean;
  ticket?: string;
  stack?: string;
  step: number;
  total: number;
  phase: string;
  qaCycle?: number;
  /** Compatibility projection. New consumers should use contextSample. */
  context?: { used: number; maximum?: number; percentage?: number };
  contextSample: ContextSample;
  sessionUsage?: SessionUsageSample;
  sessionTransition: string;
  lifecycleState?: string;
  configuredCeilingPercent?: number;
  installedNativeTokenLimit?: number;
  installedNativePercent?: number;
  compactionCount?: number;
  compactMaximum?: number;
  settingsRevision?: number;
  at: string;
}

export interface StatusClock {
  now(): Date;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: StatusClock = {
  now: () => new Date(),
  setInterval: (callback, milliseconds) => {
    const handle = setInterval(callback, milliseconds);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface AgentStatusReporterInput {
  runId: string;
  role: "builder" | "qa";
  provider: "claude" | "codex";
  model: string;
  reasoning: string;
  fast: boolean;
  ticket?: string;
  stack?: string;
  step: number;
  total: number;
  phase: string;
  qaCycle?: number;
  sessionTransition: string;
  settingsRevision: number;
  displaySessionCost: boolean;
  adapter: BuilderAdapter | (() => BuilderAdapter);
  compactionCount?: number | (() => number);
  handoffGeneration?: number | (() => number);
  /** Shared enforcement snapshot. When supplied, status never polls occupancy independently. */
  contextSnapshot?: () => {
    role: "builder" | "qa";
    provider: "claude" | "codex";
    model: string;
    lifecycleState: string;
    contextSample: ContextSample;
    configuredCeilingPercent: number;
    installedNativeTokenLimit?: number;
    installedNativePercent?: number;
    compactionCount: number;
    compactMaximum: number;
    settingsRevision: number;
  } | undefined;
}

/**
 * A non-blocking ten-second reporter. It never invents occupancy or cost: an
 * absent provider sample is rendered as measuring, stale, or unavailable.
 */
export class AgentStatusReporter {
  private handle?: unknown;
  private lastGoodContext?: ContextSample;
  private readonly lastGoodByRole = new Map<"builder" | "qa", ContextSample>();

  constructor(
    private readonly input: AgentStatusReporterInput,
    private readonly emit: (line: string, snapshot: AgentStatusSnapshot) => void,
    private readonly clock: StatusClock = systemClock,
    private readonly intervalMs = 10_000,
  ) {}

  start(): void {
    if (this.handle !== undefined) return;
    this.emitSnapshot(this.measuringSample(), undefined);
    this.handle = this.clock.setInterval(() => void this.tick(), this.intervalMs);
  }

  async tick(): Promise<void> {
    const adapter = this.adapter();
    const now = this.clock.now();
    let contextSample: ContextSample;
    const hasCoordinator = this.input.contextSnapshot !== undefined;
    const coordinated = this.input.contextSnapshot?.();
    if (coordinated && coordinated.role === this.input.role) {
      contextSample = coordinated.contextSample;
      this.input.provider = coordinated.provider;
      this.input.model = coordinated.model;
      this.input.settingsRevision = coordinated.settingsRevision;
      this.input.compactionCount = coordinated.compactionCount;
      if (contextSample.freshness === "fresh") {
        this.lastGoodContext = contextSample;
        this.lastGoodByRole.set(this.input.role, contextSample);
      }
    } else if (!hasCoordinator) {
      let observed: ContextUsage | undefined;
      try { observed = await adapter.contextUsage?.(); } catch { observed = undefined; }
      if (observed && Number.isFinite(observed.used)) contextSample = this.contextSample(observed, now);
      else if (this.lastGoodContext) contextSample = { ...this.lastGoodContext, freshness: "stale" };
      else contextSample = { ...this.measuringSample(now), freshness: "unavailable" };
    } else {
      const prior = this.lastGoodByRole.get(this.input.role);
      contextSample = prior
        ? { ...prior, freshness: "stale" }
        : { ...this.measuringSample(now), freshness: "unavailable" };
    }
    if (contextSample.freshness === "fresh") {
      this.lastGoodContext = contextSample;
      this.lastGoodByRole.set(this.input.role, contextSample);
    }

    let sessionUsage: SessionUsageSample | undefined;
    if (this.input.displaySessionCost) {
      try {
        const usage = await adapter.sessionUsage?.();
        const ref = adapter.sessionRef?.();
        sessionUsage = usage ? {
          version: 1,
          runId: this.input.runId,
          role: this.input.role,
          provider: this.input.provider,
          providerSessionId: adapter.sessionId(),
          ...(ref ? { sessionRef: ref, sessionKey: providerSessionKey(ref) } : {}),
          observedAt: usage.observedAt,
          source: usage.source,
          cumulativeInputTokens: usage.inputTokens,
          cumulativeOutputTokens: usage.outputTokens,
          cumulativeTotalTokens: usage.totalTokens,
          authoritativeCostUsd: usage.authoritativeCostUsd,
        } : unavailableUsage(this.input, adapter, now);
      } catch {
        sessionUsage = unavailableUsage(this.input, adapter, now);
      }
    }
    this.emitSnapshot(contextSample, sessionUsage, now);
  }

  stop(finalPhase = "completed"): void {
    if (this.handle === undefined) return;
    this.clock.clearInterval(this.handle);
    this.handle = undefined;
    this.input.phase = finalPhase;
    this.emitSnapshot(this.lastGoodContext ?? { ...this.measuringSample(), freshness: "unavailable" }, undefined);
  }

  updateState(patch: Partial<Omit<AgentStatusReporterInput, "runId">>): void {
    const priorRole = this.input.role;
    const priorAdapter = this.adapter();
    const priorSessionId = priorAdapter.sessionId();
    if (this.lastGoodContext) this.lastGoodByRole.set(priorRole, this.lastGoodContext);
    Object.assign(this.input, patch);
    if (priorRole !== this.input.role
      || priorAdapter !== this.adapter()
      || priorSessionId !== this.adapter().sessionId()
      || patch.sessionTransition !== undefined) this.lastGoodContext = this.lastGoodByRole.get(this.input.role);
    this.emitSnapshot(this.measuringSample(), undefined);
  }

  private emitSnapshot(contextSample: ContextSample, sessionUsage?: SessionUsageSample, now = this.clock.now()): void {
    const coordinated = this.input.contextSnapshot?.();
    const { adapter: _adapter, displaySessionCost: _display, compactionCount: _compactions, handoffGeneration: _handoffs, contextSnapshot: _contextSnapshot, ...base } = this.input;
    const context = contextSample.used === undefined ? undefined : {
      used: contextSample.used,
      maximum: contextSample.maximum,
      percentage: contextSample.percentage,
    };
    const snapshot: AgentStatusSnapshot = {
      ...base,
      ...(context ? { context } : {}),
      contextSample,
      ...(sessionUsage ? { sessionUsage } : {}),
      ...(coordinated && coordinated.role === this.input.role ? {
        lifecycleState: coordinated.lifecycleState,
        configuredCeilingPercent: coordinated.configuredCeilingPercent,
        installedNativeTokenLimit: coordinated.installedNativeTokenLimit,
        installedNativePercent: coordinated.installedNativePercent,
        compactionCount: coordinated.compactionCount,
        compactMaximum: coordinated.compactMaximum,
        settingsRevision: coordinated.settingsRevision,
      } : {
        compactionCount: contextSample.compactionCount,
        settingsRevision: contextSample.settingsRevision,
      }),
      at: now.toISOString(),
    };
    const line = [
      `${snapshot.role} ${snapshot.provider}/${snapshot.model}`,
      `activity=${snapshot.phase}`,
      formatContext(contextSample),
      ...(snapshot.configuredCeilingPercent === undefined ? [] : [`ceiling=${snapshot.configuredCeilingPercent}%`]),
      ...(snapshot.installedNativePercent === undefined ? [] : [`native=${snapshot.installedNativePercent.toFixed(1)}%${snapshot.installedNativeTokenLimit === undefined ? "" : `/${snapshot.installedNativeTokenLimit}`}`]),
      ...(snapshot.lifecycleState ? [`state=${formatLifecycle(snapshot.lifecycleState)}`] : []),
      `compactions=${snapshot.compactionCount ?? contextSample.compactionCount}${snapshot.compactMaximum === undefined ? "" : `/${snapshot.compactMaximum}`}`,
      `revision=${snapshot.settingsRevision ?? contextSample.settingsRevision}`,
      `handoff=${contextSample.handoffGeneration}`,
      `session=${snapshot.sessionTransition}`,
      ...(this.input.displaySessionCost ? [formatSessionUsage(sessionUsage)] : []),
    ].join("; ");
    this.emit(`[${snapshot.at}] ${line}`, snapshot);
  }

  private measuringSample(now = this.clock.now()): ContextSample {
    const ref = this.adapter().sessionRef?.();
    return {
      version: 1,
      runId: this.input.runId,
      role: this.input.role,
      provider: this.input.provider,
      providerSessionId: this.adapter().sessionId(),
      ...(ref ? { sessionRef: ref, sessionKey: providerSessionKey(ref) } : {}),
      model: this.input.model,
      observedAt: now.toISOString(),
      source: "provider-query",
      freshness: "measuring",
      settingsRevision: this.input.settingsRevision,
      compactionCount: numeric(this.input.compactionCount),
      handoffGeneration: numeric(this.input.handoffGeneration),
    };
  }

  private contextSample(usage: ContextUsage, now: Date): ContextSample {
    const ref = this.adapter().sessionRef?.();
    return {
      ...this.measuringSample(now),
      providerSessionId: this.adapter().sessionId(),
      ...(ref ? { sessionRef: ref, sessionKey: providerSessionKey(ref) } : {}),
      observedAt: usage.observedAt ?? now.toISOString(),
      source: usage.source ?? "provider-query",
      freshness: "fresh",
      used: usage.used,
      maximum: usage.maximum,
      percentage: usage.percentage ?? (usage.maximum ? (usage.used / usage.maximum) * 100 : undefined),
    };
  }

  private adapter(): BuilderAdapter {
    return typeof this.input.adapter === "function" ? this.input.adapter() : this.input.adapter;
  }
}

/** Switches the shared live status to a role for the lifetime of its adapter. */
export class RoleStatusAdapter implements BuilderAdapter {
  readonly agent: "claude" | "codex";
  constructor(private readonly adapter: BuilderAdapter, private readonly onActive: (adapter: BuilderAdapter) => void, private readonly onClose: () => void) { this.agent = adapter.agent; }
  async sendTurn(text: string): Promise<TurnResult> { this.onActive(this.adapter); return this.adapter.sendTurn(text); }
  sessionId(): string | undefined { return this.adapter.sessionId(); }
  sessionRef(): import("rafi-spec").ProviderSessionRefV1 | undefined { return this.adapter.sessionRef?.(); }
  adoptSessionRef(ref: import("rafi-spec").ProviderSessionRefV1): void { this.adapter.adoptSessionRef?.(ref); }
  validateSession(): Promise<import("rafi-spec").SessionAvailabilityV1> { return this.adapter.validateSession?.() ?? Promise.resolve({ version: 1, status: "unknown", checkedAt: new Date().toISOString(), reason: "legacy-unscoped" }); }
  compact(): Promise<CompactResult> { this.onActive(this.adapter); return this.adapter.compact?.() ?? Promise.resolve({ ok: false, error: "native compaction unavailable" }); }
  prepareContextManagement(policy: import("./adapters/types.js").ContextManagementPolicy): Promise<import("./adapters/types.js").PreparedContextManagement> { this.onActive(this.adapter); if (!this.adapter.prepareContextManagement) return Promise.reject(new Error("native context management unavailable")); return this.adapter.prepareContextManagement(policy); }
  updateContextManagement(policy: import("./adapters/types.js").ContextManagementPolicy): Promise<import("./adapters/types.js").PreparedContextManagement> { if (!this.adapter.updateContextManagement) return Promise.reject(new Error("native context reconfiguration unavailable")); return this.adapter.updateContextManagement(policy); }
  interruptTurnAtCompactionBoundary(providerEventId?: string): Promise<import("./adapters/types.js").InterruptResult> { return this.adapter.interruptTurnAtCompactionBoundary?.(providerEventId) ?? Promise.resolve({ ok: false, error: "compaction-boundary interruption unavailable", providerEventId }); }
  installManagedTurnDispatcher(dispatcher: import("./adapters/types.js").ManagedTurnDispatcher): void { this.adapter.installManagedTurnDispatcher?.(dispatcher); }
  contextUsage(): Promise<ContextUsage | undefined> { return this.adapter.contextUsage?.() ?? Promise.resolve(undefined); }
  sessionUsage(): Promise<ProviderSessionUsage | undefined> { return this.adapter.sessionUsage?.() ?? Promise.resolve(undefined); }
  switchSettings(settings: ProviderSettingSwitch): Promise<CompactResult> { return this.adapter.switchSettings?.(settings) ?? Promise.resolve({ ok: false, error: "settings switch unavailable" }); }
  events(): AsyncIterable<BuilderEvent> { return this.adapter.events(); }
  async close(): Promise<void> { try { await this.adapter.close(); } finally { this.onClose(); } }
}

function unavailableUsage(input: AgentStatusReporterInput, adapter: BuilderAdapter, now: Date): SessionUsageSample {
  const ref = adapter.sessionRef?.();
  return {
    version: 1,
    runId: input.runId,
    role: input.role,
    provider: input.provider,
    providerSessionId: adapter.sessionId(),
    ...(ref ? { sessionRef: ref, sessionKey: providerSessionKey(ref) } : {}),
    observedAt: now.toISOString(),
    source: "unavailable",
  };
}

function numeric(value: number | (() => number) | undefined): number {
  const resolved = typeof value === "function" ? value() : value;
  return Number.isSafeInteger(resolved) && (resolved ?? -1) >= 0 ? resolved! : 0;
}

function formatContext(sample: ContextSample): string {
  if (sample.freshness === "measuring") return "context measuring…";
  if (sample.freshness === "unavailable") return "context unavailable";
  const occupancy = sample.percentage === undefined
    ? `${sample.used ?? "unknown"}/${sample.maximum ?? "unknown"}`
    : `${sample.percentage.toFixed(1)}% (${sample.used ?? "unknown"}/${sample.maximum ?? "unknown"})`;
  return `context ${occupancy}${sample.freshness === "stale" ? " stale" : ""}`;
}

function formatLifecycle(state: string): string {
  if (state === "initializing") return "measuring";
  if (state === "threshold_pending") return "pending";
  if (state === "native_compacting" || state === "host_compacting") return "compacting";
  if (state === "compacted_unverified") return "verifying";
  if (state === "handoff_required" || state === "resuming") return "handing off";
  return state;
}

function formatSessionUsage(sample: SessionUsageSample | undefined): string {
  if (!sample || sample.source === "unavailable") return "session usage unavailable";
  if (sample.authoritativeCostUsd !== undefined) return `session cost $${sample.authoritativeCostUsd.toFixed(4)} (provider)`;
  if (sample.cumulativeTotalTokens !== undefined) return `session tokens ${sample.cumulativeTotalTokens}`;
  const total = (sample.cumulativeInputTokens ?? 0) + (sample.cumulativeOutputTokens ?? 0);
  return total > 0 ? `session tokens ${total}` : "session usage unavailable";
}
