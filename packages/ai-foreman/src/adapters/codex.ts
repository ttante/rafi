import { inheritedStructuredLiveBudget } from "../structuredLiveBudget.js";
import type { ProviderTurnPurpose } from "../providerPhase.js";
import { OperationDeadline } from "../util/deadline.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadSkill } from "special-agents";
import { BuilderEventQueue, withActivityPhase } from "../activity.js";
import { normalizeRuntimeErrorText } from "../runtimeAuth.js";
import type { BuilderAdapter, BuilderAdapterOptions, BuilderEvent, CompactResult, ContextUsage, NativeAutoCompactionPolicy, NativeCompaction, ProviderSessionUsage, ProviderSettingSwitch, TurnResult } from "./types.js";
import type { ProviderSessionRefV1, SessionAvailabilityV1 } from "rafi-spec";
import { canonicalSessionPath, createProviderSessionRef, validateProviderSessionScope } from "../sessionIdentity.js";
import { SessionUnavailableError, sessionUnavailableResult } from "./sessionFailure.js";
import { isFastModeUnavailable, reportFastModeUnavailable } from "./fastMode.js";
import { handoffSystemInstructions } from "../handoffProtocol.js";
import { providerControlOperationV2, providerWireContract, renderProviderWireInstruction, initializationOutput, validateStructuredCandidate, selectedDispatchTupleV2, structuredDigest } from "rafi-spec";
import { assertActiveProviderDispatch, withEphemeralInitializationDispatch } from "../structuredDispatchAuthority.js";
import { CodexRunawayOutputError, CodexTurnCollector, structuredReceipt } from "./structured.js";
import type { ProviderTurnPolicy } from "./types.js";

export interface CodexLineResult { events: BuilderEvent[]; sessionId?: string; text?: string }

/** Compatibility parser for recorded pre-app-server JSONL fixtures. */
export function parseCodexLine(raw: Record<string, unknown>): CodexLineResult {
  const type = raw.type as string | undefined;
  if (type === "thread.started") return { events: [], sessionId: raw.thread_id as string | undefined };
  if (type === "item.completed") {
    const item = raw.item as Record<string, unknown> | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string") return { events: [{ kind: "text", text: item.text }], text: item.text };
    if (item?.type === "command_execution") return { events: [{ kind: "tool", name: "command_execution", input: { command: item.command } }] };
  }
  if (type === "error") return { events: [{ kind: "error", message: String((raw.error as Record<string, unknown> | undefined)?.message ?? JSON.stringify(raw)) }] };
  return { events: [] };
}

type RpcMessage = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number } };
type Waiter = { predicate: (params: Record<string, unknown>) => boolean; resolve: (params: Record<string, unknown>) => void; reject: (error: Error) => void; touch?: () => void };

/** A provider can legitimately take a long time, but not without any event. */
const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 30 * 60_000;

/** Persistent JSON-RPC controller for one live Codex thread. */
export class CodexAdapter implements BuilderAdapter {
  readonly agent = "codex" as const;
  graphRuntimeSettings() { return { model: this.opts.model, effort: this.opts.effort, fast: this.opts.fast, runtimeExecutable: this.opts.runtimeExecutable }; }
  private readonly eventQueue = new BuilderEventQueue();
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notificationWaiters = new Map<string, Waiter[]>();
  private _sessionId?: string;
  private _sessionRef?: ProviderSessionRefV1;
  private sessionAvailability?: SessionAvailabilityV1;
  private initialized = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private activeText: string[] = [];
  private structuredCollector?: CodexTurnCollector;
  private turnStreamedBytes = 0;
  private streamStartedAt = 0;
  private streamActivityAt = 0;
  private streamDiagnosticAt = 0;
  private turnInFlight = false;
  private usage?: ContextUsage;
  private usageRevision = 0;
  private providerSessionUsage?: ProviderSessionUsage;
  private turnUsageBaseline?: ProviderSessionUsage;
  private lastTurnTokens?: { inputTokens?: number; outputTokens?: number };
  private stderr = "";
  private nativeAutoCompactTokenLimit?: number;
  private autoCompactionPrepared = false;
  private preparedAutoCompactThreshold?: number;
  private preparedAutoCompactionPolicy?: NativeAutoCompactionPolicy;
  private nativeCompactions: NativeCompaction[] = [];
  private nativeCompactionSequence = 0;
  private manualCompactionInFlight = false;
  private compactionPromise?: Promise<CompactResult>;
  private compactionActive = false;
  private compactionUncertain = false;
  private observedToolCalls = 0;
  private activeProviderTurnId?: string;
  private activeNativeTurnId?: string;
  private connectionGeneration = 0;
  private readonly approvalRequests = new Map<string, AbortController>();
  private readonly answeredApprovalRequests = new Set<string>();
  private activeProviderTurnSpanId?: string;
  private readonly toolSpans = new Map<string, string>();
  private effectiveModel?: string;
  private fastPreparedModel?: string;
  private fastTier?: string;
  private readonly fastUnavailableModels = new Set<string>();
  private turnSawTool = false;
  /** Native compaction is non-blocking. The next host turn gets this reminder. */
  private qaContractReminder?: string;
  private qaContractReminderPending = false;
  private qaContractReminderEvent?: (event: { kind: "installed" | "compaction-observed" | "reminder-delivered" | "reminder-retained"; at: string; sessionId?: string }) => void;

  private disableFastMode(): void {
    const model = this.opts.model ?? this.effectiveModel ?? "default";
    if (!this.fastUnavailableModels.has(model)) reportFastModeUnavailable(model);
    this.fastUnavailableModels.add(model); this.fastTier = undefined;
  }

  private async prepareFastMode(): Promise<void> {
    const model = this.opts.model ?? this.effectiveModel ?? "default";
    if (!this.opts.fast || this.fastPreparedModel === model) return;
    this.fastPreparedModel = model; this.fastTier = undefined;
    if (this.fastUnavailableModels.has(model)) return;
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await this.request("model/list", { includeHidden: true, ...(cursor ? { cursor } : {}) }) as { data?: Array<{ model: string; id?: string; serviceTiers?: Array<{ id: string; name?: string }>; additionalSpeedTiers?: string[] }>; nextCursor?: string };
        const entry = result.data?.find(item => item.model === model || item.id === model);
        if (entry) {
          this.fastTier = entry.serviceTiers?.find(tier => tier.name?.toLowerCase() === "fast" || ["fast", "priority"].includes(tier.id))?.id;
          // Older app-server versions publish only the legacy speed list.
          if (entry.serviceTiers === undefined && entry.additionalSpeedTiers?.includes("fast")) this.fastTier = "fast";
          break;
        }
        if (!result.nextCursor || result.nextCursor === cursor) break;
        cursor = result.nextCursor;
      }
    } catch { /* Optional capability discovery never blocks a standard turn. */ }
    if (!this.fastTier) this.disableFastMode();
  }

  constructor(private readonly opts: BuilderAdapterOptions) {
    inheritedStructuredLiveBudget("codex");
    this._sessionId = opts.resumeSessionRef?.sessionId ?? opts.resumeSessionId;
    this._sessionRef = opts.resumeSessionRef;
  }

  contractCapabilities() { return { sameSessionAcceptance: true, nativeCompactionBarrier: false }; }
  contractCompactionSequence(): number { return this.nativeCompactionSequence; }

  configureQaContractReminder(reminder: string, onEvent?: (event: { kind: "installed" | "compaction-observed" | "reminder-delivered" | "reminder-retained"; at: string; sessionId?: string }) => void): void {
    this.qaContractReminder = reminder;
    this.qaContractReminderEvent = onEvent;
    onEvent?.({ kind: "installed", at: new Date().toISOString(), sessionId: this._sessionId });
  }

  private qaReminderEvent(kind: "installed" | "compaction-observed" | "reminder-delivered" | "reminder-retained"): void {
    this.qaContractReminderEvent?.({ kind, at: new Date().toISOString(), sessionId: this._sessionId });
  }

  private instructionWithPendingQaReminder(instruction: string): { instruction: string; includedReminder: boolean } {
    if (!this.qaContractReminderPending || !this.qaContractReminder) return { instruction, includedReminder: false };
    // Do not clear this before the provider has completed a turn. A failed or
    // disconnected dispatch is not evidence that Codex received the reminder.
    return { instruction: `${this.qaContractReminder}\n\nContinue the assigned ticket now.\n\n${instruction}`, includedReminder: true };
  }

  buildInstruction(instruction: string): string {
    return [this.opts.systemPromptAppend,
      this.opts.sessionRole === "builder" ? `Builder runtime contract: shell network ${this.effectiveNetworkAccess() ? "explicitly approved for this build" : "disabled"}; sandbox escalation ${this.effectiveApprovalPolicy() === "on-request" ? "requires separate approval for each exact operation" : "disabled"}. Web tools do not establish shell network access. If acquisition needs unavailable capabilities, request input before running acquisition, or use a local source/dependency bundle with verified provenance. A ticket answer does not change runtime permissions.` : undefined,
      this.buildSkillsAppendix(), instruction]
      .filter((part): part is string => Boolean(part)).join("\n\n");
  }

  buildAppServerArgs(): string[] {
    const args = ["app-server", "--listen", "stdio://"];
    if (this.nativeAutoCompactTokenLimit !== undefined) {
      args.push(
        "-c", `model_auto_compact_token_limit=${this.nativeAutoCompactTokenLimit}`,
        "-c", 'model_auto_compact_token_limit_scope="total"',
      );
    }
    return args;
  }

  /** Deprecated fixture helper. Runtime execution uses only app-server. */
  buildArgs(instruction: string): string[] {
    const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", this.opts.sandboxMode ?? "workspace-write", "-C", this.opts.cwd];
    if (this.opts.model) args.push("-m", this.opts.model);
    if (this.opts.effort) args.push("-c", `model_reasoning_effort=${this.opts.effort}`);
    if (this._sessionId) args.push("resume", this._sessionId);
    args.push(instruction); return args;
  }

  async sendTurn(instruction: string, policy?: ProviderTurnPolicy): Promise<TurnResult> {
    if (this.turnInFlight) throw new Error("a turn is already in progress");
    if (policy?.output) assertActiveProviderDispatch(policy, instruction, "codex", this.sessionRef());
    if (policy?.output) {
      const selected = policy.wireContract ?? providerWireContract(policy.output, "codex", "default", { requireRegistered: true });
      if (selected.provider !== "codex" || selected.canonical.schemaDigest !== policy.output.schemaDigest) throw new Error("Codex received a mismatched provider wire contract");
      if (policy.renderedWireContractDigest && policy.renderedWireContractDigest !== selected.descriptorDigest) throw new Error("Codex received mismatched rendered wire guidance");
      instruction = renderProviderWireInstruction(instruction, selected);
      policy = { ...policy, wireContract: selected, renderedWireContractDigest: selected.descriptorDigest };
    }
    this.turnInFlight = true;
    const prepared = this.instructionWithPendingQaReminder(instruction);
    instruction = prepared.instruction;
    const turnId = policy?.dispatchId ?? randomUUID();
    this.activeProviderTurnId = turnId;
    const observer = this.opts.observer;
    if (!observer) {
      try {
        const result = await withActivityPhase(`Codex ${activityPhase(this.opts.runtimePhase)}`, () => this.sendTurnInternal(instruction, policy));
        if (prepared.includedReminder && !result.isError && !result.failure) { this.qaContractReminderPending = false; this.qaReminderEvent("reminder-delivered"); }
        else if (prepared.includedReminder) this.qaReminderEvent("reminder-retained");
        return result;
      }
      catch (error) {
        if (prepared.includedReminder) this.qaReminderEvent("reminder-retained");
        throw error;
      }
      finally { this.activeProviderTurnId = undefined; this.activeNativeTurnId = undefined; this.structuredCollector = undefined; this.turnInFlight = false; }
    }
    const context = this.observationContext();
    const spanId = observer.store.startSpan(context, { spanId: turnId, kind: "provider_turn", name: `Codex ${activityPhase(this.opts.runtimePhase)}`, providerTurnId: turnId, attributes: { provider: "codex" } });
    this.activeProviderTurnSpanId = spanId;
    observer.store.updateCurrentState({ runId: observer.runId, role: context.role ?? "host", stream: context.stream ?? "codex", executionId: observer.executionId, ticketId: context.ticketId, deliveryUnitId: context.deliveryUnitId, providerSessionId: context.providerSessionId, phase: "provider turn", activeSpanId: spanId, activeSpanKind: "provider_turn", lastSemanticProgressAt: new Date().toISOString() });
    try {
      const result = await withActivityPhase(`Codex ${activityPhase(this.opts.runtimePhase)}`, () => this.sendTurnInternal(instruction, policy));
      observer.store.finishSpan(spanId, { outcome: result.isError ? "failed" : "completed", attributes: { usage: result.usage } });
      if (prepared.includedReminder && !result.isError && !result.failure) { this.qaContractReminderPending = false; this.qaReminderEvent("reminder-delivered"); }
      else if (prepared.includedReminder) this.qaReminderEvent("reminder-retained");
      return result;
    } catch (error) {
      if (prepared.includedReminder) this.qaReminderEvent("reminder-retained");
      observer.store.finishSpan(spanId, { outcome: "failed", attributes: { error: String(error).slice(0, 500) } });
      throw error;
    } finally {
      for (const [callId, toolSpanId] of this.toolSpans) { observer.store.finishSpan(toolSpanId, { outcome: "unknown", completionKnown: false }); this.toolSpans.delete(callId); }
      this.activeProviderTurnId = undefined; this.activeNativeTurnId = undefined; this.activeProviderTurnSpanId = undefined;
      this.structuredCollector = undefined; this.turnInFlight = false;
    }
  }

  private async sendTurnInternal(instruction: string, policy?: ProviderTurnPolicy, runawayRetries = 0): Promise<TurnResult> {
    if (this.closed) throw new Error("builder is closed");
    this.eventQueue.push({ kind: "activity", state: "starting Codex turn", provider: "codex", model: this.opts.model });
    let turnStartDispatched = false;
    const providerInstruction = this.buildInstruction(instruction);
    try {
      await this.ensureThread();
      if (this.opts.fast) await this.prepareFastMode();
      const toolsBefore = this.observedToolCalls;
      this.turnSawTool = false;
      this.activeText = [];
      this.turnStreamedBytes = 0; this.streamStartedAt = 0; this.streamActivityAt = 0; this.streamDiagnosticAt = 0;
      this.lastTurnTokens = undefined;
      this.turnUsageBaseline = this.providerSessionUsage ? { ...this.providerSessionUsage } : undefined;
      const deadline = new OperationDeadline("Codex active turn", this.opts.turnDeadlineMs ?? 3_600_000);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined; };
      const resetIdle = () => {
        clearIdle();
        idleTimer = setTimeout(() => collector?.fail(new Error("Codex native turn idle deadline expired; execution outcome requires reconciliation")), this.providerIdleTimeoutMs());
        idleTimer.unref();
      };
      const wire = policy?.output ? policy.wireContract ?? providerWireContract(policy.output, "codex", "default", { requireRegistered: true }) : undefined;
      const collector = policy?.output ? this.structuredCollector = new CodexTurnCollector(this._sessionId!, true, resetIdle, wire!.maximumResponseBytes) : undefined;
      const completion = collector ? collector.completion : this.waitFor("turn/completed", (params) => params.threadId === this._sessionId, this.providerIdleTimeoutMs(), true);
      void completion.then(clearIdle, clearIdle);
      turnStartDispatched = true;
      const readOnlyTurn = Boolean(policy?.responseOnly || policy?.purpose && policy.purpose !== "implementation" || this.opts.sandboxMode === "read-only" || this.opts.sessionRole === "qa");
      const startParams = {
        ...(wire ? { outputSchema: wire.wireSchema } : {}),
        threadId: this._sessionId,
        input: [{ type: "text", text: providerInstruction, text_elements: [] }],
        cwd: this.opts.cwd,
        model: this.opts.model ?? this.effectiveModel ?? null,
        effort: this.opts.effort ?? null,
        ...(this.opts.fast ? { serviceTier: this.fastTier ?? "default" } : {}),
        approvalPolicy: policy?.responseOnly || policy?.purpose && policy.purpose !== "implementation" ? "never" : this.effectiveApprovalPolicy(),
        sandboxPolicy: readOnlyTurn
          ? { type: "readOnly", networkAccess: false }
          : { type: "workspaceWrite", writableRoots: [this.opts.cwd], networkAccess: this.effectiveNetworkAccess() },
      };
      let started: unknown;
      try { started = await deadline.run(() => this.request("turn/start", startParams)); }
      catch (error) {
        if (policy?.output || !this.fastTier || !isFastModeUnavailable(String(error)) || this.turnSawTool || this.activeText.length) throw error;
        this.disableFastMode();
        started = await this.request("turn/start", { ...startParams, serviceTier: "default" });
      }
      this.activeNativeTurnId = String((started as { turn?: { id?: string } }).turn?.id ?? "") || undefined;
      collector?.bind(this.activeNativeTurnId ?? "");
      let params: Record<string, unknown>;
      try { params = await deadline.run(() => completion); }
      catch (error) {
        // Runaway output is a definite provider rejection, not an unknown
        // outcome. A read-only turn cannot change the workspace, so after the
        // native turn is confirmed stopped it may be asked once more, inside
        // the same sealed host dispatch. Writable turns are never retried.
        const nativeTurnId = this.activeNativeTurnId;
        if (error instanceof CodexRunawayOutputError && runawayRetries < 1 && readOnlyTurn && nativeTurnId && await this.interruptNativeTurn(nativeTurnId)) {
          this.writeStreamDiagnostic("interrupted", `${error.message}; retrying once`);
          this.traceLifecycle("runaway-output-retry", { elapsedMs: 0 });
          this.eventQueue.push({ kind: "retry", provider: "codex", reason: error.message, attempt: 1, maximum: 1, managedBy: "rafi", retryId: nativeTurnId });
          return this.sendTurnInternal(instruction, policy, runawayRetries + 1);
        }
        throw error;
      }
      const turn = collector ? params : params.turn as Record<string, unknown> | undefined;
      const responseOnlyViolation = Boolean(policy?.responseOnly && (collector ? collector.tools : this.observedToolCalls !== toolsBefore));
      const failed = turn?.status !== "completed" || responseOnlyViolation;
      const error = turn?.error as Record<string, unknown> | null | undefined;
      let final: { text: string; itemId?: string } | undefined;
      let invalidFinal: string | undefined;
      try { final = collector?.final(); } catch (error) { invalidFinal = String(error); }
      if (this.streamDiagnosticAt) this.writeStreamDiagnostic(failed || invalidFinal ? "interrupted" : "completed", failed ? `Codex terminal ${String(turn?.status)}` : invalidFinal);
      const text = final?.text ?? this.activeText.join("\n");
      if (!policy?.output && failed && !responseOnlyViolation && this.fastTier && !this.turnSawTool && !text && isFastModeUnavailable(String(error?.message ?? ""))) {
        this.disableFastMode();
        return this.sendTurnInternal(instruction, policy);
      }
      let result: TurnResult = {
        text: failed ? normalizeRuntimeErrorText("codex", String(responseOnlyViolation ? "Response-only correction used tools; its result cannot authorize completion" : error?.message ?? text), null, "app-server turn") : text,
        isError: failed, numTurns: 1, costUsd: 0, costAuthoritative: false,
        turnId: this.activeProviderTurnId, hostInstruction: instruction, providerInstruction,
        rawResponse: text, cleanedResponse: failed ? normalizeRuntimeErrorText("codex", String(responseOnlyViolation ? "Response-only correction used tools; its result cannot authorize completion" : error?.message ?? text), null, "app-server turn") : text,
        providerMetadata: { provider: "codex", sessionId: this._sessionId, sessionRef: this._sessionRef },
        ...(policy?.selectedDispatch ? { selectedDispatch: policy.selectedDispatch } : {}),
        ...(this.lastTurnTokens ?? {}),
      };
      result.usage = { scope: "turn-delta", inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        ...(result.inputTokens !== undefined || result.outputTokens !== undefined ? { totalTokens: (result.inputTokens ?? 0) + (result.outputTokens ?? 0) } : {}) };
      if (policy?.output) {
        const selectedDispatch = policy.selectedDispatch;
        if (!selectedDispatch || !this._sessionId) throw new Error("Structured terminal lost its sealed dispatch tuple or session");
        result = { ...result, selectedDispatch, structured: failed ? { state: "rejected", reason: responseOnlyViolation ? "tool-policy-violation" : "execution-not-completed", detail: `Codex terminal ${String(turn?.status)}`, dispatchId: result.turnId! }
          : invalidFinal ? { state: "rejected", reason: "ambiguous-result", detail: invalidFinal, dispatchId: result.turnId! }
          : !wire || !policy.selectedDispatch
            ? { state: "rejected", reason: "invalid-contract", detail: "Codex structured turn has no sealed descriptor or tuple", dispatchId: result.turnId! }
            : structuredReceipt(policy.output, "codex", final?.itemId ? text : undefined, { dispatchId: result.turnId!, sessionId: this._sessionId, nativeTurnId: this.activeNativeTurnId, nativeItemId: final?.itemId }, "json-text", wire, policy.selectedDispatch) };
        if (result.structured.state === "rejected") result.isError = true;
      }
      this.eventQueue.push({ kind: "turn-complete", result, turnId: result.turnId });
      return result;
    } catch (error) {
      if (error instanceof SessionUnavailableError) {
        const result = sessionUnavailableResult(error);
        this.eventQueue.push({ kind: "error", message: result.text });
        result.turnId = this.activeProviderTurnId; result.hostInstruction = instruction; result.providerInstruction = providerInstruction;
        result.rawResponse = result.text; result.cleanedResponse = result.text;
        result.providerMetadata = { provider: "codex", sessionId: this._sessionId, sessionRef: this._sessionRef };
        this.eventQueue.push({ kind: "turn-complete", result, turnId: result.turnId });
        return result;
      }
      const detail = [error instanceof Error ? error.message : String(error), this.stderr].filter(Boolean).join("\n");
      if (this.turnStreamedBytes) this.writeStreamDiagnostic("interrupted", error instanceof Error ? error.message : String(error));
      const text = normalizeRuntimeErrorText("codex", detail, this.process?.exitCode ?? null, "builder turn");
      this.disconnect(new Error(text));
      const resumed = Boolean(this.opts.resumeSessionRef);
      const result: TurnResult = resumed
        ? sessionUnavailableResult(new SessionUnavailableError({
          runtime: "codex", phase: turnStartDispatched ? "turn" : "attach", dispatchState: turnStartDispatched ? "unknown" : "not-sent",
          executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: text,
          availability: { version: 1, status: turnStartDispatched ? "unknown" : "unavailable", checkedAt: new Date().toISOString(), reason: turnStartDispatched ? "probe-failed" : "attach-failed", detail: text, sessionRef: this.opts.resumeSessionRef },
        }))
        : { text, isError: true, numTurns: 1, costUsd: 0, costAuthoritative: false, failure: { runtime: "codex", phase: turnStartDispatched ? "turn" : "attach", category: "agent-stream", executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: text, dispatchState: turnStartDispatched ? "unknown" : "not-sent" } };
      this.eventQueue.push({ kind: "error", message: text });
      result.turnId = this.activeProviderTurnId; result.hostInstruction = instruction; result.providerInstruction = providerInstruction;
      result.rawResponse = result.text; result.cleanedResponse = result.text;
      result.providerMetadata = { provider: "codex", sessionId: this._sessionId, sessionRef: this._sessionRef };
      this.eventQueue.push({ kind: "turn-complete", result, turnId: result.turnId });
      return result;
    }
  }

  async compact(): Promise<CompactResult> {
    if (this.compactionPromise) return this.compactionPromise;
    const operation = this.opts.observer
      ? this.opts.observer.span("compaction", "Codex context compaction", () => this.compactInternal())
      : this.compactInternal();
    this.compactionPromise = operation;
    try { return await operation; }
    finally { if (this.compactionPromise === operation) this.compactionPromise = undefined; }
  }

  private async compactInternal(): Promise<CompactResult> {
    if (this.compactionUncertain) return { ok: false, error: "Prior compaction outcome is uncertain; validate a fresh successor before further work" };
    if (this.compactionActive) return { ok: false, error: "Compaction is already in progress for this session" };
    if (this.manualCompactionInFlight) return { ok: false, error: "Codex compaction already in flight" };
    this.compactionActive = true;
    const controller = new AbortController();
    const began = performance.now();
    const timeoutMs = Math.min(180_000, Math.max(1, this.opts.compactionTimeoutMs ?? 120_000));
    const hardTimeoutMs = Math.min(180_000, timeoutMs * 1.5);
    this.traceLifecycle("compaction-started", { timeoutMs });
    const deadline = new OperationDeadline("Codex compaction", timeoutMs, hardTimeoutMs);
    try {
      await deadline.run(() => this.ensureThread());
      this.eventQueue.push({ kind: "session-transition", transition: "compacting" });
      const usageRevision = this.usageRevision;
      // A pre-compaction observation must never be mistaken for proof that the
      // provider reduced the live context. The app server emits a fresh token
      // usage notification for the compacted thread; require it alongside the
      // explicit contextCompaction completion item.
      this.usage = undefined;
      let compactionItemId: string | undefined;
      const progress = this.waitFor("item/started", params => {
        const item = params.item as Record<string, unknown> | undefined;
        if (params.threadId !== this._sessionId || item?.type !== "contextCompaction" || typeof item.id !== "string") return false;
        compactionItemId = item.id;
        deadline.extendForCorrelatedProgress();
        this.traceLifecycle("compaction-deadline-extended", { timeoutMs: hardTimeoutMs });
        return true;
      }, hardTimeoutMs, false, controller.signal);
      void progress.catch(() => {});
      const done = this.waitFor("item/completed", (params) => {
        const item = params.item as Record<string, unknown> | undefined;
        return params.threadId === this._sessionId && item?.type === "contextCompaction" && (!compactionItemId || item.id === compactionItemId);
      }, hardTimeoutMs, false, controller.signal);
      const postCompactUsage = this.waitFor("thread/tokenUsage/updated", (params) => {
        return params.threadId === this._sessionId
          && this.usageRevision > usageRevision
          && this.usage !== undefined;
      }, hardTimeoutMs, false, controller.signal);
      this.manualCompactionInFlight = true;
      try {
        providerControlOperationV2("codex", "thread/compact/start");
        const acknowledgementFailure = this.request("thread/compact/start", { threadId: this._sessionId }).then(
          () => { this.traceLifecycle("compaction-acknowledged"); return new Promise<never>(() => {}); },
          error => {
            // A missing acknowledgement is not failure evidence. Explicit
            // completion plus fresh occupancy is sufficient to reconcile it.
            if (/deadline|timed out/i.test(String(error))) return new Promise<never>(() => {});
            throw error;
          },
        );
        await deadline.run(() => Promise.race([Promise.all([done, postCompactUsage]), acknowledgementFailure]));
      } finally { this.manualCompactionInFlight = false; }
      // Manual completion must invalidate delivery receipts just like automatic
      // compaction. Continuity accounts for this requested compaction separately.
      this.nativeCompactionSequence++;
      if (this.qaContractReminder) { this.qaContractReminderPending = true; this.qaReminderEvent("compaction-observed"); }
      this.eventQueue.push({ kind: "session-transition", transition: "compacted" });
      this.traceLifecycle("compaction-completed", { elapsedMs: performance.now() - began });
      return { ok: true };
    } catch (error) {
      if (error instanceof SessionUnavailableError) return { ok: false, error: error.message, failure: error.failure };
      this.compactionUncertain = true;
      this.usage = undefined;
      this.traceLifecycle("compaction-failed", { elapsedMs: performance.now() - began });
      const detail = error instanceof Error ? error.message : String(error);
      if (/deadline|timed out/i.test(detail)) {
        // Waiting expired, not the provider operation. Quarantine this adapter;
        // the host must reconcile it instead of automatically starting a writer.
        const failure = new SessionUnavailableError({ runtime: "codex", phase: "turn", dispatchState: "unknown", executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: detail });
        this.closed = true;
        this.disconnect(failure);
        this.eventQueue.close();
        return { ok: false, error: detail, failure: failure.failure };
      }
      return { ok: false, error: detail };
    } finally { controller.abort(); this.compactionActive = false; }
  }

  async prepareAutoCompaction(thresholdPercent = this.opts.autoCompactThresholdPercent): Promise<NativeAutoCompactionPolicy | void> {
    return new OperationDeadline("Codex auto-compaction preparation", this.opts.preparationTimeoutMs ?? 120_000).run(() => this.prepareAutoCompactionInternal(thresholdPercent), () => this.disconnect(new Error("Codex preparation expired")));
  }

  private async prepareAutoCompactionInternal(thresholdPercent = this.opts.autoCompactThresholdPercent): Promise<NativeAutoCompactionPolicy | void> {
    if (thresholdPercent === undefined) return;
    const threshold = validThreshold(thresholdPercent);
    if (this.autoCompactionPrepared && this.preparedAutoCompactThreshold === threshold) return this.preparedAutoCompactionPolicy;
    this.opts.autoCompactThresholdPercent = threshold;
    await this.ensureThread();
    // Codex reports its model context window in token-usage notifications, not
    // in thread/start. Establish the otherwise idle thread with a constrained
    // setup turn, then restart the app server with the provider-native ceiling
    // before any Builder or QA work is sent.
    if (!this.usage?.maximum) {
      if (this.opts.allowAutoCompactionSetupTurn === false) return;
      const toolsBefore = this.observedToolCalls;
      const descriptor = providerWireContract(initializationOutput, "codex");
      const instruction = renderProviderWireInstruction("Rafi internal initialization only. Do not call tools or modify files. Submit the native session-initialization result with completed payload {ready:true} and null continuity.", descriptor);
      const session = this.sessionRef();
      if (!session) throw new Error("Ephemeral Codex initialization requires a prepared session");
      const id = randomUUID();
      const tuple = selectedDispatchTupleV2({ operation: initializationOutput.operation, schemaVersion: initializationOutput.schemaVersion, schemaDigest: initializationOutput.schemaDigest,
        provider: "codex", profile: descriptor.profile, variant: descriptor.variant, descriptorDigest: descriptor.descriptorDigest,
        wireSchemaDigest: descriptor.wireSchemaDigest, guidanceDigest: descriptor.guidanceDigest, normalizerId: descriptor.normalizerId,
        normalizerVersion: descriptor.normalizerVersion, maximumSchemaBytes: descriptor.maximumSchemaBytes, maximumResponseBytes: descriptor.maximumResponseBytes,
        maximumPageBytes: descriptor.maximumPageBytes ?? null, instructionDigest: structuredDigest(instruction), actionId: id, dispatchId: id, sessionId: session.sessionId, generation: session.generation });
      const setup = await withEphemeralInitializationDispatch(this.opts.configRoot ?? this.opts.cwd, tuple, dispatchCapability => this.sendTurn(instruction,
        { purpose: "initialization", responseOnly: true, output: initializationOutput, dispatchId: id, logicalActionId: id, wireContract: descriptor,
          renderedWireContractDigest: descriptor.descriptorDigest, selectedDispatch: tuple, dispatchCapability }), session);
      if (setup.isError) throw new Error(`Codex automatic-compaction setup failed: ${setup.text.slice(0, 240)}`);
      if (this.observedToolCalls !== toolsBefore) throw new Error("Codex automatic-compaction setup unexpectedly called a tool");
      if (!setup.selectedDispatch) throw new Error("Codex initialization returned no sealed dispatch tuple");
      const accepted = validateStructuredCandidate(initializationOutput, setup.structured, providerWireContract(initializationOutput, "codex"), setup.selectedDispatch);
      if (accepted.result.kind !== "completed" || !accepted.result.payload.ready) throw new Error("Codex initialization did not confirm readiness");
    }
    const maximum = this.usage?.maximum;
    if (!maximum || !Number.isFinite(maximum) || maximum <= 0) {
      throw new Error("Codex did not report a model context window during automatic-compaction setup");
    }
    this.nativeAutoCompactTokenLimit = tokenLimit(maximum, threshold);
    await this.restartForAutoCompaction();
    await this.ensureThread();
    this.autoCompactionPrepared = true;
    this.preparedAutoCompactThreshold = threshold;
    this.preparedAutoCompactionPolicy = {
      requestedThresholdPercent: threshold,
      effectiveThresholdPercent: threshold,
      modelContextWindow: maximum,
      triggerTokens: this.nativeAutoCompactTokenLimit,
    };
    return this.preparedAutoCompactionPolicy;
  }

  requiresAutoCompactionSetupTurn(): boolean {
    return this.opts.autoCompactThresholdPercent !== undefined && !this.autoCompactionPrepared && !this.usage?.maximum;
  }

  autoCompactionPolicy(): NativeAutoCompactionPolicy | undefined { return this.preparedAutoCompactionPolicy; }

  drainNativeCompactions(): NativeCompaction[] {
    const pending = this.nativeCompactions;
    this.nativeCompactions = [];
    return pending;
  }
  restoreNativeCompactions(compactions: NativeCompaction[]): void { this.nativeCompactions.unshift(...compactions); }

  async contextUsage(): Promise<ContextUsage | undefined> { return this.usage; }
  async contextUsageAfterNativeCompaction(compaction: NativeCompaction): Promise<ContextUsage | undefined> {
    if (compaction.usageRevision === undefined || this.usageRevision > compaction.usageRevision) return this.usage;
    try {
      await this.waitFor("thread/tokenUsage/updated", () => this.usageRevision > compaction.usageRevision!, 5_000);
      return this.usage;
    } catch { return undefined; }
  }
  async sessionUsage(): Promise<ProviderSessionUsage | undefined> { return this.providerSessionUsage ? { ...this.providerSessionUsage } : undefined; }
  async switchSettings(settings: ProviderSettingSwitch): Promise<CompactResult> {
    if (settings.model !== this.opts.model || settings.fast !== this.opts.fast) this.fastPreparedModel = undefined;
    this.opts.model = settings.model; this.opts.effort = settings.effort; this.opts.fast = settings.fast;
    return { ok: true };
  }
  sessionId(): string | undefined { return this._sessionId; }
  sessionRef(): ProviderSessionRefV1 | undefined { return this._sessionRef; }
  async prepareSession(): Promise<ProviderSessionRefV1> {
    await this.ensureThread();
    if (!this._sessionRef) throw new Error("Codex did not expose a scoped thread identity during session preparation");
    if (!this._sessionRef.validatedAt) this._sessionRef = { ...this._sessionRef, validatedAt: new Date().toISOString() };
    return this._sessionRef;
  }
  adoptSessionRef(ref: ProviderSessionRefV1): void {
    if (ref.provider !== "codex" || ref.sessionId !== this._sessionId) throw new Error("cannot adopt a session reference for a different Codex thread");
    this._sessionRef = ref;
  }
  async validateSession(): Promise<SessionAvailabilityV1> {
    const checkedAt = new Date().toISOString();
    if (!this._sessionRef) return { version: 1, status: "unknown", checkedAt, reason: "legacy-unscoped", detail: "Codex raw thread IDs cannot be declared exact without a stored location scope" };
    try {
      await this.ensureThread();
      return this.sessionAvailability ?? { version: 1, status: "available", checkedAt, observedCwd: canonicalSessionPath(this.opts.cwd), sessionRef: this._sessionRef };
    } catch (error) {
      if (error instanceof SessionUnavailableError && error.failure.availability) return error.failure.availability;
      return { version: 1, status: "unknown", checkedAt, reason: "probe-failed", detail: error instanceof Error ? error.message : String(error), sessionRef: this._sessionRef };
    }
  }
  observeEvents(listener: (event: BuilderEvent) => void): () => void { return this.eventQueue.observe(listener); }

  events(): AsyncIterable<BuilderEvent> { return this.eventQueue; }

  close(): Promise<void> { return this.closePromise ??= this.closeInternal(); }
  private async closeInternal(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.turnInFlight && this.turnStreamedBytes) this.writeStreamDiagnostic("interrupted", "adapter closed during an active turn");
    const child = this.process;
    let onExit: (() => void) | undefined;
    const exited = child && child.exitCode === null ? new Promise<void>(resolve => { onExit = resolve; child.once("exit", resolve); }) : Promise.resolve();
    this.disconnect(new Error("app-server closed"));
    this.eventQueue.close();
    try {
      try { await new OperationDeadline("Codex shutdown", this.opts.shutdownTimeoutMs ?? 10_000).run(() => exited); }
      catch {
        child?.kill("SIGKILL");
        await new OperationDeadline("Codex forced shutdown", 5_000).run(() => exited);
      }
    }
    finally { if (onExit) child?.off("exit", onExit); }
  }

  private async ensureThread(): Promise<void> {
    return new OperationDeadline("Codex preparation", this.opts.preparationTimeoutMs ?? 120_000).run(() => this.ensureThreadInternal(), () => this.disconnect(new Error("Codex preparation deadline exceeded")));
  }

  private async ensureThreadInternal(): Promise<void> {
    if (this._sessionRef && !this.threadAttached) {
      if (this._sessionRef.source === "legacy-inferred") {
        const availability: SessionAvailabilityV1 = { version: 1, status: "unknown", checkedAt: new Date().toISOString(), reason: "legacy-unscoped", detail: "legacy Codex thread IDs cannot be proven exact without an observed scoped binding", sessionRef: this._sessionRef };
        this.sessionAvailability = availability;
        throw new SessionUnavailableError({ runtime: "codex", phase: "preflight", dispatchState: "not-sent", executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: availability.detail!, availability });
      }
      const scoped = validateProviderSessionScope(this._sessionRef, {
        provider: "codex", cwd: this.opts.cwd, configRoot: this.opts.configRoot ?? this.opts.cwd,
        role: this.opts.sessionRole ?? this._sessionRef.role, stream: this.opts.sessionStream ?? this._sessionRef.stream,
        workspaceIdentity: this.opts.workspaceIdentity, ticketId: this.opts.ticketId, deliveryUnitId: this.opts.deliveryUnitId,
      });
      if (scoped.status !== "available" || !scoped.sessionRef) {
        this.sessionAvailability = scoped;
        throw new SessionUnavailableError({
          runtime: "codex", phase: "preflight", dispatchState: "not-sent", executable: this.opts.runtimeExecutable ?? "codex",
          cwd: this.opts.cwd, diagnostics: scoped.detail ?? `Codex session ${this._sessionRef.sessionId} is ${scoped.status}`, availability: scoped,
        });
      }
      this._sessionRef = scoped.sessionRef;
    }
    await this.ensureConnection();
    if (this._sessionId && this.initialized === true && this.threadAttached) return;
    const method = this._sessionId ? "thread/resume" : "thread/start";
    let result: Record<string, unknown>;
    try {
      result = await this.request(method, {
        ...(this._sessionId ? { threadId: this._sessionId } : {}), cwd: this.opts.cwd,
        model: this.opts.model ?? null, approvalPolicy: this.effectiveApprovalPolicy(),
        config: { sandbox_workspace_write: { network_access: this.effectiveNetworkAccess() } },
        sandbox: this.opts.sandboxMode === "read-only" || this.opts.sessionRole === "qa" ? "read-only" : "workspace-write",
        developerInstructions: handoffSystemInstructions(this.opts.sessionRole, this.opts.systemPromptAppend) ?? null,
      }) as Record<string, unknown>;
    } catch (error) {
      if (this._sessionRef) {
        const detail = error instanceof Error ? error.message : String(error);
        const availability: SessionAvailabilityV1 = {
          version: 1, status: "unavailable", checkedAt: new Date().toISOString(),
          reason: /not found|unknown thread|no thread/i.test(detail) ? "not-found" : "attach-failed", detail, sessionRef: this._sessionRef,
        };
        this.sessionAvailability = availability;
        throw new SessionUnavailableError({ runtime: "codex", phase: "attach", dispatchState: "not-sent", executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: detail, availability, cause: error });
      }
      throw error;
    }
    const effective = result.sandbox as { type?: string; networkAccess?: boolean } | undefined;
    if (this.effectiveNetworkAccess() && !effective) throw new Error("Codex did not report an effective sandbox policy for the requested network grant; no turn dispatched");
    const requestedSandbox = this.opts.sandboxMode === "read-only" || this.opts.sessionRole === "qa" ? "readOnly" : "workspaceWrite";
    if (effective && (effective.type !== requestedSandbox || effective.networkAccess === true && !this.effectiveNetworkAccess())) throw new Error("Codex effective sandbox exceeds the authorized role policy; no turn dispatched");
    if (effective && this.effectiveNetworkAccess() && effective.networkAccess !== true) throw new Error("Codex did not enable the explicitly approved builder network; use an offline bundle or correct provider policy before implementation");
    if (result.approvalPolicy !== undefined && result.approvalPolicy !== this.effectiveApprovalPolicy()) throw new Error("Codex effective approval policy differs from the requested role policy; no turn dispatched");
    this.eventQueue.push({ kind: "activity", state: "Codex role capabilities", provider: "codex", detail: JSON.stringify({ requested: { sandbox: requestedSandbox, networkAccess: this.effectiveNetworkAccess(), approvalPolicy: this.effectiveApprovalPolicy() }, effective: effective ?? "unknown", approvalPolicy: result.approvalPolicy ?? "unknown" }) });
    const thread = result.thread as Record<string, unknown> | undefined;
    const returnedSessionId = String(thread?.id ?? this._sessionId ?? "") || undefined;
    if (this._sessionRef && returnedSessionId !== this._sessionRef.sessionId) {
      const availability: SessionAvailabilityV1 = {
        version: 1,
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        reason: "attach-failed",
        detail: `Codex resumed thread ${returnedSessionId ?? "without an ID"} instead of requested thread ${this._sessionRef.sessionId}`,
        sessionRef: this._sessionRef,
      };
      this.sessionAvailability = availability;
      throw new SessionUnavailableError({
        runtime: "codex",
        phase: "attach",
        dispatchState: "not-sent",
        executable: this.opts.runtimeExecutable ?? "codex",
        cwd: this.opts.cwd,
        diagnostics: availability.detail!,
        availability,
      });
    }
    if (!returnedSessionId?.trim()) throw new Error(`${method} did not return a thread ID`);
    const providerCwd = typeof thread?.cwd === "string" ? canonicalSessionPath(thread.cwd) : undefined;
    const expectedCwd = canonicalSessionPath(this._sessionRef?.cwd ?? this.opts.cwd);
    if ((providerCwd && providerCwd !== expectedCwd) || (!providerCwd && this.opts.sessionRole === "qa")) {
      const availability: SessionAvailabilityV1 = { version: 1, status: "unavailable", checkedAt: new Date().toISOString(), reason: "cwd-mismatch", observedCwd: providerCwd, detail: `Codex thread cwd ${providerCwd ?? "was not returned"} does not match ${expectedCwd}`, sessionRef: this._sessionRef };
      this.sessionAvailability = availability;
      throw new SessionUnavailableError({ runtime: "codex", phase: "attach", dispatchState: "not-sent", executable: this.opts.runtimeExecutable ?? "codex", cwd: this.opts.cwd, diagnostics: availability.detail!, availability });
    }
    this._sessionId = returnedSessionId;
    if (!this._sessionRef) {
      this._sessionRef = createProviderSessionRef({
        provider: "codex", sessionId: this._sessionId, cwd: providerCwd ?? this.opts.cwd, configRoot: this.opts.configRoot ?? this.opts.cwd,
        role: this.opts.sessionRole, stream: this.opts.sessionStream, generation: this.opts.sessionGeneration,
        workspaceIdentity: this.opts.workspaceIdentity, ticketId: this.opts.ticketId, deliveryUnitId: this.opts.deliveryUnitId,
        validatedAt: new Date().toISOString(),
      });
    } else {
      this._sessionRef = { ...this._sessionRef, validatedAt: new Date().toISOString() };
    }
    this.sessionAvailability = { version: 1, status: "available", checkedAt: new Date().toISOString(), observedCwd: providerCwd ?? canonicalSessionPath(this.opts.cwd), sessionRef: this._sessionRef };
    this.threadAttached = true;
    this.effectiveModel = typeof result.model === "string" ? result.model : this.opts.model;
    this.eventQueue.push({ kind: "session-transition", transition: method === "thread/resume" ? "resumed" : "started" });
  }

  private threadAttached = false;

  private async ensureConnection(): Promise<void> {
    if (this.process && this.initialized) return;
    this.stderr = "";
    const executable = this.opts.runtimeExecutable ?? "codex";
    const child = spawn(executable, this.buildAppServerArgs(), { cwd: this.opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    // A short-lived server may close stdin before its stderr/exit event. The
    // close handler owns rejection so diagnostics include the complete stderr.
    child.stdin.on("error", () => {});
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => { if (line.trim()) try { this.handle(JSON.parse(line) as RpcMessage); } catch { /* ignore non-protocol stdout */ } });
    child.stderr.on("data", (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8192); });
    child.on("error", (error) => { if (this.process === child) this.disconnect(error); });
    child.on("close", (code) => { if (this.process === child) this.disconnect(new Error(`Codex app-server exited with code ${code ?? "unknown"}`)); });
    await this.request("initialize", { clientInfo: { name: "rafi", title: "Rafi", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.write({ method: "initialized", params: {} });
    this.initialized = true;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new OperationDeadline(`Codex RPC ${method}`, this.opts.rpcTimeoutMs ?? 60_000).run(() => new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); } catch (error) { this.pending.delete(id); reject(error as Error); }
    }), () => { this.pending.delete(id); });
  }

  private write(message: RpcMessage): void {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server is not connected");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handle(message: RpcMessage): void {
    this.touchWaiters();
    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) { this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message ?? `JSON-RPC error ${message.error.code ?? "unknown"}`)) : pending.resolve(message.result); }
      return;
    }
    if (!message.method) return;
    const params = message.params ?? {};
    this.structuredCollector?.ingest(message.method, params);
    // Native receipts and tool observations must belong to the same dispatch.
    // Foreign notifications remain unable to affect completion or evidence.
    if (this.structuredCollector && (params.threadId && params.threadId !== this._sessionId || this.activeNativeTurnId && params.turnId && params.turnId !== this.activeNativeTurnId)) return;
    if (message.method === "item/agentMessage/delta") {
      if (!this.turnInFlight || params.threadId && this._sessionId && params.threadId !== this._sessionId) return;
      this.observeAgentMessageDelta(params);
    } else if (message.method === "item/started") {
      const item = params.item as Record<string, unknown> | undefined;
      if (item) this.eventQueue.push({ kind: "provider-item", provider: "codex", lifecycle: "started", itemType: String(item.type ?? "unknown"), payload: exactProviderItem(item), payloadCompleteness: "complete", providerTurnId: this.activeProviderTurnId, eventId: randomUUID(), observedAt: new Date().toISOString() });
      if (isCodexToolItem(item)) {
        this.turnSawTool = true;
        this.observedToolCalls += 1;
        const callId = codexItemId(item) ?? randomUUID();
        const name = codexToolName(item);
        this.eventQueue.push({ kind: "tool", name, input: exactToolInput(item), inputCompleteness: "complete", lifecycle: "started", callId, completionKnown: false, providerTurnId: this.activeProviderTurnId, eventId: randomUUID(), observedAt: new Date().toISOString() });
        if (this.opts.observer) {
          const spanId = this.opts.observer.store.startSpan(this.observationContext(), { kind: "tool", name, providerTurnId: this.activeProviderTurnId, attributes: { callId, input: boundedToolInput(item) } });
          this.toolSpans.set(callId, spanId);
          this.opts.observer.signal(true);
        }
      }
      const activity = codexItemActivity(item);
      if (activity) this.eventQueue.push({ kind: "activity", provider: "codex", ...activity });
    } else if (message.method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined;
      if (item) this.eventQueue.push({ kind: "provider-item", provider: "codex", lifecycle: "completed", itemType: String(item.type ?? "unknown"), payload: exactProviderItem(item), payloadCompleteness: "complete", providerTurnId: this.activeProviderTurnId, eventId: randomUUID(), observedAt: new Date().toISOString() });
      if (isCodexToolItem(item)) {
        this.turnSawTool = true;
        const callId = codexItemId(item);
        const spanId = callId ? this.toolSpans.get(callId) : undefined;
        const status = typeof item?.status === "string" ? item.status : undefined;
        const exitCode = finiteNumber(item?.exitCode ?? item?.exit_code);
        const durationMs = finiteNumber(item?.durationMs ?? item?.duration_ms);
        const output = codexOutputSummary(item);
        this.eventQueue.push({ kind: "tool", name: codexToolName(item), input: exactToolInput(item), inputCompleteness: "complete", lifecycle: "completed", callId, status, durationMs, exitCode, outputSummary: output?.summary, outputDigest: output?.digest, outputCompleteness: output?.completeness ?? "unavailable", rawOutputBytes: output?.bytes, completionKnown: true, providerTurnId: this.activeProviderTurnId, eventId: randomUUID(), observedAt: new Date().toISOString() });
        if (spanId && this.opts.observer) { this.opts.observer.store.finishSpan(spanId, { outcome: status ?? (exitCode === undefined || exitCode === 0 ? "completed" : "failed"), completionKnown: true, attributes: { callId, providerDurationMs: durationMs, exitCode, outputSummary: output?.summary, outputDigest: output?.digest } }); this.toolSpans.delete(callId!); }
        this.opts.observer?.signal(true);
      }
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        this.activeText.push(item.text);
        this.eventQueue.push({ kind: "text", text: item.text, byteCount: Buffer.byteLength(item.text), digest: createHash("sha256").update(item.text).digest("hex"), eventId: randomUUID(), observedAt: new Date().toISOString() });
        this.opts.observer?.signal(true);
      }
      else if (item?.type === "commandExecution") { /* tool completion was emitted above */
      } else if (item?.type === "contextCompaction" && !this.manualCompactionInFlight) {
        // Completion is the provider's authoritative confirmation. Token-usage
        // notifications may arrive before or after it, so do not make durable
        // compaction accounting depend on their delivery order.
        this.nativeCompactions.push({
          id: `codex:${this._sessionId ?? "unknown"}:${Date.now()}:${++this.nativeCompactionSequence}`,
          occurredAt: new Date().toISOString(),
          provider: "codex",
          usageRevision: this.usageRevision,
        });
        // A native compaction does not invalidate completed work or QA handoff.
        // The next Rafi-controlled turn re-supplies the full requirement
        // contract and tells the Builder to check it before continuing.
        if (this.qaContractReminder) { this.qaContractReminderPending = true; this.qaReminderEvent("compaction-observed"); }
        this.eventQueue.push({ kind: "session-transition", transition: "compacted", detail: "provider-native automatic compaction" });
      }
      else {
        const activity = codexItemActivity(item, true);
        if (activity) this.eventQueue.push({ kind: "activity", provider: "codex", ...activity });
      }
    } else if (message.method === "turn/plan/updated") {
      const plan = params.plan as Array<Record<string, unknown>> | undefined;
      const active = plan?.find((step) => step.status === "inProgress") ?? plan?.at(-1);
      this.eventQueue.push({ kind: "activity", provider: "codex", state: "following plan", detail: typeof active?.step === "string" ? active.step : undefined });
    } else if (message.method.includes("reasoning") || message.method === "thread/status/changed") {
      this.eventQueue.push({ kind: "activity", provider: "codex", state: message.method.includes("reasoning") ? "reasoning" : "provider working", transient: message.method.includes("Delta") });
    } else if (message.method === "thread/tokenUsage/updated") {
      const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
      const total = tokenUsage?.total as Record<string, unknown> | undefined;
      const last = tokenUsage?.last as Record<string, unknown> | undefined;
      if (this._sessionId && params.threadId !== this._sessionId) return;
      const used = optionalNonNegative(last?.totalTokens);
      const maximum = Number(tokenUsage?.modelContextWindow);
      const observedAt = new Date().toISOString();
      const totalInput = optionalNonNegative(total?.inputTokens);
      const totalOutput = optionalNonNegative(total?.outputTokens);
      const sessionTotal = optionalNonNegative(total?.totalTokens);
      if (totalInput !== undefined || totalOutput !== undefined || sessionTotal !== undefined) {
        this.providerSessionUsage = { inputTokens: totalInput, outputTokens: totalOutput, totalTokens: sessionTotal, observedAt, source: "provider" };
      }
      if ((totalInput !== undefined && this.turnUsageBaseline?.inputTokens !== undefined && totalInput < this.turnUsageBaseline.inputTokens) || (totalOutput !== undefined && this.turnUsageBaseline?.outputTokens !== undefined && totalOutput < this.turnUsageBaseline.outputTokens)) this.turnUsageBaseline = undefined;
      this.lastTurnTokens = {
        inputTokens: cumulativeDelta(this.turnUsageBaseline?.inputTokens, totalInput),
        outputTokens: cumulativeDelta(this.turnUsageBaseline?.outputTokens, totalOutput),
      };
      this.usage = undefined;
      if (used !== undefined && Number.isFinite(maximum) && maximum > 0) {
        this.usage = { used, maximum, percentage: used / maximum * 100, observedAt, source: "provider-event" };
        this.usageRevision += 1;
        this.eventQueue.push({ kind: "context-usage", ...this.usage });
      }
    } else if (message.method === "error") {
      const error = params.error as Record<string, unknown> | undefined;
      const reason = String(error?.message ?? params.message ?? "Codex app-server error");
      if (this.fastTier && isFastModeUnavailable(reason) && !this.activeText.length && !this.turnSawTool) return;
      if (params.willRetry === true) {
        const retryId = randomUUID();
        this.eventQueue.push(this.opts.observer
          ? { kind: "retry", provider: "codex", reason, managedBy: "provider", retryId, providerTurnId: this.activeProviderTurnId, eventId: retryId, observedAt: new Date().toISOString() }
          : { kind: "retry", provider: "codex", reason, managedBy: "provider" });
        if (this.opts.observer) {
          const retrySpanId = this.opts.observer.store.startSpan(this.observationContext(), { spanId: retryId, kind: "retry", name: "Codex provider retry", providerTurnId: this.activeProviderTurnId,
            attributes: { provider: "codex", reasonDigest: createHash("sha256").update(reason).digest("hex") } });
          this.opts.observer.store.recordEvent(this.observationContext(), "retry", { eventId: retryId, spanId: retrySpanId, severity: "warning", attributes: { provider: "codex", reasonDigest: createHash("sha256").update(reason).digest("hex") } });
          this.opts.observer.store.finishSpan(retrySpanId, { outcome: "reported" });
        }
      }
      else this.eventQueue.push({ kind: "error", message: reason });
    }
    const waiters = this.notificationWaiters.get(message.method) ?? [];
    const remaining: Waiter[] = [];
    for (const waiter of waiters) waiter.predicate(params) ? waiter.resolve(params) : remaining.push(waiter);
    this.notificationWaiters.set(message.method, remaining);
  }

  private observationContext() {
    const observer = this.opts.observer!;
    const inherited = observer.context();
    return { ...inherited, runId: observer.runId, executionId: observer.executionId, role: this.opts.sessionRole ?? inherited.role ?? "builder" as const,
      stream: this.opts.sessionStream ?? inherited.stream ?? this.opts.sessionRole ?? "builder", providerSessionId: this._sessionId,
      ticketId: this.opts.ticketId ?? inherited.ticketId, deliveryUnitId: this.opts.deliveryUnitId ?? inherited.deliveryUnitId,
      parentSpanId: this.activeProviderTurnSpanId ?? inherited.parentSpanId, providerTurnId: this.activeProviderTurnId ?? inherited.providerTurnId };
  }

  private waitFor(method: string, predicate: Waiter["predicate"], timeoutMs?: number, resetOnProviderActivity = false, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const began = performance.now();
      const clear = () => { if (timeout) clearTimeout(timeout); timeout = undefined; signal?.removeEventListener("abort", abort); };
      const waiter: Waiter = {
        predicate,
        resolve: (params) => { clear(); this.traceLifecycle("waiter-completed", { method, elapsedMs: performance.now() - began }); resolve(params); },
        reject: (error) => { clear(); reject(error); },
      };
      const abort = () => {
        this.notificationWaiters.set(method, (this.notificationWaiters.get(method) ?? []).filter(candidate => candidate !== waiter));
        clear();
        this.traceLifecycle("waiter-cancelled", { method });
        reject(new Error(`Codex waiter cancelled: ${method}`));
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      this.traceLifecycle("waiter-registered", { method, timeoutMs });
      const waiters = this.notificationWaiters.get(method) ?? [];
      waiters.push(waiter);
      this.notificationWaiters.set(method, waiters);
      if (timeoutMs !== undefined) {
        const arm = () => { timeout = setTimeout(() => {
          // Human approval has its own bounded deadline; it is not provider idleness.
          if (resetOnProviderActivity && this.approvalRequests.size > 0) { arm(); return; }
          const active = this.notificationWaiters.get(method) ?? [];
          this.notificationWaiters.set(method, active.filter((candidate) => candidate !== waiter));
          clear();
          this.traceLifecycle("waiter-timeout", { method, timeoutMs, elapsedMs: performance.now() - began });
          reject(new Error(`Codex provider wait timed out after ${timeoutMs} ms while waiting for ${method}; the turn may have been dispatched and will not be retried automatically`));
        }, timeoutMs); };
        if (resetOnProviderActivity) waiter.touch = () => { clear(); arm(); };
        arm();
      }
    });
  }

  /** Ask the app-server to stop a native turn; true only once its terminal is observed. */
  private async interruptNativeTurn(nativeTurnId: string): Promise<boolean> {
    const stopped = this.waitFor("turn/completed", params => params.threadId === this._sessionId && (params.turn as { id?: unknown } | undefined)?.id === nativeTurnId, 15_000)
      .then(() => true, () => false);
    try { await new OperationDeadline("Codex turn interrupt", 10_000).run(() => this.request("turn/interrupt", { threadId: this._sessionId, turnId: nativeTurnId })); }
    catch (error) { this.traceLifecycle("turn-interrupt-failed", { method: error instanceof Error ? error.message.slice(0, 200) : "unknown" }); }
    return stopped;
  }

  /** Streamed output is visible progress; it is never treated as a result. */
  private observeAgentMessageDelta(params: Record<string, unknown>): void {
    if (typeof params.delta !== "string") return;
    this.turnStreamedBytes += Buffer.byteLength(params.delta);
    const now = Date.now();
    if (!this.streamStartedAt) this.streamStartedAt = now;
    if (now - this.streamActivityAt >= 1_000) {
      this.streamActivityAt = now;
      this.eventQueue.push({ kind: "activity", provider: "codex", state: "writing response", detail: `${formatStreamBytes(this.turnStreamedBytes)} streamed`, transient: true });
    }
    if (now - (this.streamDiagnosticAt || this.streamStartedAt) >= 2_000) this.writeStreamDiagnostic("streaming");
  }

  /**
   * Bounded interruption evidence for structured turns under .foreman (Rafi's
   * git-excluded log directory). Diagnostic only: never read back as output.
   */
  private writeStreamDiagnostic(state: "streaming" | "completed" | "interrupted", detail?: string): void {
    const collector = this.structuredCollector, nativeTurnId = this.activeNativeTurnId, threadId = this._sessionId;
    if (!collector || !nativeTurnId || !threadId) return;
    this.streamDiagnosticAt = Date.now();
    try {
      const safe = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
      const dir = join(this.opts.configRoot ?? this.opts.cwd, ".foreman", "provider-streams");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `codex-${safe(threadId)}-${safe(nativeTurnId)}.json`);
      const body = { version: 1, provider: "codex", state, threadId, nativeTurnId, dispatchId: this.activeProviderTurnId, updatedAt: new Date().toISOString(),
        ...(detail ? { detail: Buffer.from(detail).subarray(0, 2_000).toString() } : {}), ...collector.streamDiagnostic() };
      writeFileSync(`${path}.tmp`, JSON.stringify(body, null, 2));
      renameSync(`${path}.tmp`, path);
    } catch { /* diagnostics cannot change execution */ }
  }

  private traceLifecycle(phase: string, data: { method?: string; timeoutMs?: number; elapsedMs?: number } = {}): void {
    try { this.opts.onLifecycleTrace?.({ phase, at: new Date().toISOString(), sessionId: this._sessionId, ...data }); } catch { /* diagnostics cannot change execution */ }
  }

  private touchWaiters(): void {
    for (const waiters of this.notificationWaiters.values()) for (const waiter of waiters) waiter.touch?.();
  }

  private providerIdleTimeoutMs(): number {
    const configured = this.opts.providerIdleTimeoutMs;
    return Number.isFinite(configured) && configured! > 0 ? configured! : DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
  }

  private effectiveNetworkAccess(): boolean {
    return this.opts.sandboxMode !== "read-only" && this.opts.sessionRole !== "qa" && this.opts.networkAccess === true;
  }

  private effectiveApprovalPolicy(): "never" | "on-request" {
    return this.opts.sandboxMode === "read-only" || this.opts.sessionRole === "qa" ? "never" : this.opts.approvalPolicy ?? "never";
  }

  /** Fail closed; approval is for this operation only, never a session cache or policy amendment. */
  private async handleServerRequest(message: RpcMessage): Promise<void> {
    await Promise.resolve();
    const id = message.id!;
    const identity = `${typeof id}:${id}`;
    if (this.approvalRequests.has(identity) || this.answeredApprovalRequests.has(identity)) return;
    const params = message.params ?? {};
    const command = message.method === "item/commandExecution/requestApproval";
    const fileChange = message.method === "item/fileChange/requestApproval";
    if (!command && !fileChange) {
      this.write({ id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } }); return;
    }
    const connection = this.process;
    const generation = this.connectionGeneration;
    const hostTurnId = this.activeProviderTurnId;
    const controller = new AbortController();
    this.approvalRequests.set(identity, controller);
    let decision: "accept" | "decline" = "decline";
    try {
      if (this.effectiveApprovalPolicy() === "on-request" && params.threadId === this._sessionId && this.activeProviderTurnId && typeof params.turnId === "string" && typeof params.itemId === "string" && params.turnId === this.activeNativeTurnId && (params.cwd === undefined || canonicalSessionPath(String(params.cwd)) === canonicalSessionPath(this.opts.cwd))) {
        const verdict = await new OperationDeadline("Codex approval", this.opts.approvalTimeoutMs ?? 300_000).run(() => this.opts.permission({
          toolName: command ? "Bash" : "Write",
          input: { ...params, providerSandboxEscalation: true, requestedCommand: params.command },
          signal: controller.signal, toolUseID: String(params.itemId),
          title: "Approve this exact sandbox escalation?", description: String(params.reason ?? "Provider requests access beyond the offline workspace sandbox"),
        }), () => controller.abort());
        if (!controller.signal.aborted && verdict.behavior === "allow" && params.threadId === this._sessionId && this.activeProviderTurnId === hostTurnId && params.turnId === this.activeNativeTurnId) decision = "accept";
      }
    } catch { controller.abort(); }
    finally {
      this.approvalRequests.delete(identity);
      this.touchWaiters();
      this.answeredApprovalRequests.add(identity);
      if (generation === this.connectionGeneration && connection === this.process && !this.closed) {
        try { this.write({ id, result: { decision } }); } catch { /* disconnected: no stale reply on another connection */ }
      }
    }
  }

  private disconnect(error: Error): void {
    this.structuredCollector?.fail(error);
    this.connectionGeneration++;
    for (const controller of this.approvalRequests.values()) controller.abort();
    this.approvalRequests.clear(); this.answeredApprovalRequests.clear();
    const child = this.process;
    this.process = undefined; this.initialized = false; this.threadAttached = false;
    if (child && child.exitCode === null) child.kill("SIGTERM");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiters of this.notificationWaiters.values()) for (const waiter of waiters) waiter.reject(error);
    this.notificationWaiters.clear();
  }

  private async restartForAutoCompaction(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    this.initialized = false;
    this.threadAttached = false;
    if (child.exitCode === null) child.kill("SIGTERM");
  }

  private buildSkillsAppendix(): string | undefined {
    if (this.opts.preloadedSkillContent?.length) {
      return ["# Preloaded Skills", "Use the following skills for this run.", ...this.opts.preloadedSkillContent.map((skill) => skill.content)].join("\n\n");
    }
    if (!this.opts.skills?.length) return undefined;
    const blocks = this.opts.skills.map((skill) => loadSkillMarkdown(this.opts.cwd, skill)).filter((block): block is string => Boolean(block));
    return blocks.length ? ["# Preloaded Skills", "Use the following skills for this run.", ...blocks].join("\n\n") : undefined;
  }
}

function optionalNonNegative(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function validThreshold(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 99) throw new Error("automatic compaction threshold must be an integer from 1 to 99");
  return value;
}

function tokenLimit(maximum: number, percentage: number): number {
  return Math.max(1, Math.floor(maximum * percentage / 100));
}

function activityPhase(phase: BuilderAdapterOptions["runtimePhase"]): string {
  if (phase === "planning") return "planning";
  if (phase === "ticket-population") return "populating tickets";
  if (phase === "qa") return "reviewing with QA";
  if (phase === "uninstaller") return "planning uninstall";
  if (phase === "manager") return "analyzing diagnostics";
  if (phase === "discovery") return "discovering project context";
  return "building";
}

function codexItemActivity(item: Record<string, unknown> | undefined, completed = false): { state: string; detail?: string } | undefined {
  if (!item) return undefined;
  const state = completed ? "completed" : "running";
  if (item.type === "commandExecution") return { state: `${state} command`, detail: typeof item.command === "string" ? item.command : undefined };
  if (item.type === "fileChange") return { state: `${state} file changes` };
  if (item.type === "mcpToolCall") return { state: `${state} MCP tool`, detail: String(item.tool ?? item.name ?? "") || undefined };
  if (item.type === "dynamicToolCall") return { state: `${state} tool`, detail: String(item.tool ?? item.name ?? "") || undefined };
  if (item.type === "webSearch") return { state: `${state} web search`, detail: typeof item.query === "string" ? item.query : undefined };
  if (item.type === "contextCompaction") return { state: completed ? "context compacted" : "compacting context" };
  if (item.type === "agentMessage") return { state: completed ? "received response" : "writing response" };
  return undefined;
}

function isCodexToolItem(item: Record<string, unknown> | undefined): boolean {
  return item?.type === "commandExecution" || item?.type === "mcpToolCall" || item?.type === "dynamicToolCall" || item?.type === "webSearch" || item?.type === "fileChange";
}

function codexItemId(item: Record<string, unknown> | undefined): string | undefined { const value = item?.id ?? item?.itemId ?? item?.callId; return typeof value === "string" && value ? value : undefined; }
function codexToolName(item: Record<string, unknown> | undefined): string { return String(item?.tool ?? item?.name ?? item?.type ?? "tool"); }
function exactProviderItem(item: Record<string, unknown>): Record<string, unknown> { return structuredClone(item); }
function exactToolInput(item: Record<string, unknown> | undefined): Record<string, unknown> { return item ? exactProviderItem(item) : {}; }
function boundedToolInput(item: Record<string, unknown> | undefined): Record<string, unknown> { if (!item) return {}; return Object.fromEntries(Object.entries(exactToolInput(item)).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 1000) : value])); }
function codexOutputSummary(item: Record<string, unknown> | undefined): { summary: string; digest: string; completeness: "complete" | "truncated"; bytes: number } | undefined { const value = item?.aggregatedOutput ?? item?.output ?? item?.stdout; if (typeof value !== "string" || !value) return undefined; const sanitized = value.replace(/\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]"); const providerTruncated = item?.outputTruncated === true || item?.truncated === true; return { summary: sanitized.slice(0, 1000), digest: createHash("sha256").update(value).digest("hex"), completeness: providerTruncated ? "truncated" : "complete", bytes: Buffer.byteLength(value) }; }
function finiteNumber(value: unknown): number | undefined { const result = Number(value); return Number.isFinite(result) ? result : undefined; }

function loadSkillMarkdown(cwd: string, skill: string): string | undefined {
  const projectPath = [join(cwd, ".codex", "skills", skill, "SKILL.md"), join(cwd, ".agents", "skills", skill, "SKILL.md")].find(existsSync);
  if (projectPath) return `## ${skill}\n${readFileSync(projectPath, "utf8").trim()}`;
  try { const bundled = loadSkill(skill); return bundled.body?.trim() ? `## ${bundled.name}\n${bundled.body.trim()}` : undefined; } catch { return undefined; }
}

function cumulativeDelta(before: number | undefined, after: number | undefined): number | undefined {
  return before !== undefined && after !== undefined && after >= before ? after - before : undefined;
}

function formatStreamBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}
