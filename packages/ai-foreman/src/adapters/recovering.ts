import { isCancel, log, select } from "@clack/prompts";
import type { AgentRuntime } from "../runtimeAuth.js";
import { AsyncQueue } from "../util/asyncQueue.js";
import { pauseActivityForInput, reportBuilderEvent } from "../activity.js";
import type { BuilderAdapter, BuilderEvent, CompactResult, ContextUsage, NativeAutoCompactionPolicy, NativeCompaction, ProviderSessionUsage, TurnResult } from "./types.js";
import type { ProviderSessionRefV1, SessionAvailabilityV1 } from "rafi-spec";
import type { RunObserver } from "../observability.js";
import { randomUUID } from "node:crypto";

export type TurnRecoveryChoice = "retry" | "switch" | "cancel";

export interface RecoveringAdapterOptions {
  initial: BuilderAdapter;
  runtime: AgentRuntime;
  enabled: boolean;
  allowSwitch: boolean;
  label: string;
  recreate: (runtime: AgentRuntime, resumeSessionId?: string, resumeSessionRef?: ProviderSessionRefV1) => Promise<BuilderAdapter>;
  choose?: (result: TurnResult, runtime: AgentRuntime, otherRuntime: AgentRuntime) => Promise<TurnRecoveryChoice>;
  onRuntimeChange?: (runtime: AgentRuntime) => void;
  onSessionRef?: (ref: ProviderSessionRefV1) => void;
  observer?: RunObserver;
}

/** Adds interactive recovery around structured runtime turn failures. */
export class RecoveringAdapter implements BuilderAdapter {
  private adapter: BuilderAdapter;
  private runtime: AgentRuntime;
  private readonly eventQueue = new AsyncQueue<BuilderEvent>();
  private eventPump: Promise<void>;
  private closed = false;
  private contractEnforcing = false;

  constructor(private readonly opts: RecoveringAdapterOptions) {
    this.adapter = opts.initial;
    this.runtime = opts.runtime;
    this.eventPump = this.forwardEvents(this.adapter);
  }

  graphRuntimeSettings() { return this.adapter.graphRuntimeSettings?.(); }
  get agent(): "claude" | "codex" {
    return this.adapter.agent;
  }

  contractCapabilities() { return this.adapter.contractCapabilities?.() ?? { sameSessionAcceptance: false, nativeCompactionBarrier: false }; }
  enableContractEnforcement(): void { this.contractEnforcing = true; this.adapter.enableContractEnforcement?.(); }
  contractCompactionSequence(): number { return this.adapter.contractCompactionSequence?.() ?? 0; }
  acceptContractDelivery(sequence: number): void { this.adapter.acceptContractDelivery?.(sequence); }
  async sendTurn(text: string, policy?: Parameters<BuilderAdapter["sendTurn"]>[1]): Promise<TurnResult> {
    while (true) {
      const result = await this.adapter.sendTurn(text, policy);
      const sessionRef = this.adapter.sessionRef?.();
      if (sessionRef && this.opts.onSessionRef) {
        try { this.opts.onSessionRef(sessionRef); }
        catch (error) {
          this.eventQueue.push({ kind: "error", message: `failed to persist scoped provider session binding: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      if (policy?.handback || !this.opts.enabled || !result.isError || !result.failure) return result;
      // The host cannot know whether a missing exact session received this
      // instruction. Never replay it or silently switch providers.
      if (result.failure.category === "session-unavailable" || result.failure.dispatchState === "unknown") return result;
      // A replacement has new host-side barriers, even when it resumes the
      // same native session. Only the shared build gate can renew acceptance.
      if (this.contractEnforcing) return { ...result, text: `${result.text}\nContract-enforcing runtime recovery requires an explicit host resume through the shared preparation/delivery gate; this turn was not replayed.` };

      const otherRuntime = this.runtime === "claude" ? "codex" : "claude";
      const choice = this.opts.choose
        ? await this.opts.choose(result, this.runtime, otherRuntime)
        : await (this.opts.observer
          ? this.opts.observer.span("user_wait", "runtime recovery choice", () => pauseActivityForInput(() => promptTurnRecovery(result, this.opts.label, this.runtime, otherRuntime, this.opts.allowSwitch)))
          : pauseActivityForInput(() => promptTurnRecovery(result, this.opts.label, this.runtime, otherRuntime, this.opts.allowSwitch)));
      if (choice === "cancel") return result;
      if (choice === "switch" && !this.opts.allowSwitch) return result;

      const recoveryEvent: BuilderEvent = choice === "retry"
        ? { kind: "retry", provider: this.runtime, reason: `${this.opts.label} failed`, managedBy: "rafi" }
        : { kind: "activity", provider: otherRuntime, state: `switching to ${otherRuntime}`, detail: "starting a fresh provider session" };
      this.eventQueue.push(recoveryEvent);
      reportBuilderEvent(recoveryEvent);
      if (choice === "retry" && this.opts.observer) {
        const retryId = randomUUID();
        const context = this.opts.observer.context();
        const spanId = this.opts.observer.store.startSpan(context, { spanId: retryId, kind: "retry", name: "Rafi recovery retry", attributes: { provider: this.runtime, managedBy: "rafi" } });
        this.opts.observer.store.recordEvent(context, "retry", { eventId: retryId, spanId, severity: "warning", attributes: { provider: this.runtime, managedBy: "rafi" } });
        this.opts.observer.store.finishSpan(spanId, { outcome: "scheduled" });
      }

      const nextRuntime = choice === "switch" ? otherRuntime : this.runtime;
      const resumeSessionId = choice === "retry" ? this.adapter.sessionId() : undefined;
      const resumeSessionRef = choice === "retry" ? this.adapter.sessionRef?.() : undefined;
      await this.replaceAdapter(nextRuntime, resumeSessionId, resumeSessionRef);
      if (choice === "switch") {
        log.info(`Using ${nextRuntime} for the rest of this run. This is a fresh provider session; conversational continuity was not transferred.`);
      }
    }
  }

  sessionId(): string | undefined {
    return this.adapter.sessionId();
  }
  sessionRef(): ProviderSessionRefV1 | undefined { return this.adapter.sessionRef?.(); }
  prepareSession(): Promise<ProviderSessionRefV1> {
    if (!this.adapter.prepareSession) return Promise.reject(new Error("wrapped adapter cannot establish a provider session without a work turn"));
    return this.adapter.prepareSession();
  }
  adoptSessionRef(ref: ProviderSessionRefV1): void { this.adapter.adoptSessionRef?.(ref); }
  validateSession(): Promise<SessionAvailabilityV1> {
    return this.adapter.validateSession?.() ?? Promise.resolve({ version: 1, status: "unknown", checkedAt: new Date().toISOString(), reason: "legacy-unscoped", detail: "wrapped adapter does not expose scoped session validation" });
  }

  compact(): Promise<CompactResult> { return this.adapter.compact?.() ?? Promise.resolve({ ok: false, error: "native compaction unavailable" }); }
  prepareAutoCompaction(thresholdPercent?: number): Promise<NativeAutoCompactionPolicy | void> { return this.adapter.prepareAutoCompaction?.(thresholdPercent) ?? Promise.resolve(); }
  requiresAutoCompactionSetupTurn(): boolean { return this.adapter.requiresAutoCompactionSetupTurn?.() ?? false; }
  autoCompactionPolicy(): NativeAutoCompactionPolicy | undefined { return this.adapter.autoCompactionPolicy?.(); }
  drainNativeCompactions(): import("./types.js").NativeCompaction[] { return this.adapter.drainNativeCompactions?.() ?? []; }
  restoreNativeCompactions(compactions: NativeCompaction[]): void { this.adapter.restoreNativeCompactions?.(compactions); }
  contextUsageAfterNativeCompaction(compaction: NativeCompaction): Promise<ContextUsage | undefined> { return this.adapter.contextUsageAfterNativeCompaction?.(compaction) ?? Promise.resolve(undefined); }
  contextUsage(): Promise<ContextUsage | undefined> { return this.adapter.contextUsage?.() ?? Promise.resolve(undefined); }
  sessionUsage(): Promise<ProviderSessionUsage | undefined> { return this.adapter.sessionUsage?.() ?? Promise.resolve(undefined); }

  events(): AsyncIterable<BuilderEvent> {
    return this.eventQueue;
  }

  observeEvents(listener: (event: BuilderEvent) => void): () => void {
    if (!this.adapter.observeEvents) throw new Error("wrapped provider does not expose turn observation");
    // Observe synchronously at the provider, before sendTurn resolves. The async
    // display pump may still have buffered events when the journal unsubscribes.
    return this.adapter.observeEvents(listener);
  }
  acceptHandbackTurn(turn: TurnResult): void { this.adapter.acceptHandbackTurn?.(turn); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.adapter.close().catch(() => {});
    await this.eventPump.catch(() => {});
    this.eventQueue.close();
  }

  private async replaceAdapter(runtime: AgentRuntime, resumeSessionId?: string, resumeSessionRef?: ProviderSessionRefV1): Promise<void> {
    await this.adapter.close().catch(() => {});
    await this.eventPump.catch(() => {});
    this.adapter = await this.opts.recreate(runtime, resumeSessionId, resumeSessionRef);
    this.runtime = runtime;
    this.opts.onRuntimeChange?.(runtime);
    this.eventPump = this.forwardEvents(this.adapter);
  }

  private async forwardEvents(adapter: BuilderAdapter): Promise<void> {
    for await (const event of adapter.events()) this.eventQueue.push(event);
  }
}

async function promptTurnRecovery(
  result: TurnResult,
  label: string,
  runtime: AgentRuntime,
  otherRuntime: AgentRuntime,
  allowSwitch: boolean,
): Promise<TurnRecoveryChoice> {
  log.error(result.text);
  const choice = await select({
    message: `${runtime} failed during ${label}. What should Rafi do?`,
    options: [
      { value: "retry", label: "Fix the runtime manually, then retry this turn" },
      ...(allowSwitch
        ? [{ value: "switch", label: `Switch to ${otherRuntime} for this run (fresh session)` }]
        : []),
      { value: "cancel", label: "Cancel this command and keep project state" },
    ],
  });
  if (isCancel(choice)) return "cancel";
  return choice as TurnRecoveryChoice;
}
