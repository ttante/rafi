import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ContinuityDelta, HandoffAcceptanceReceiptV1, HandoffLineage, HandoffManifestV1, ProviderSessionRefV1, SessionUsageSample } from "rafi-spec";
import type { BuilderAdapter, BuilderEvent, TurnResult } from "./adapters/types.js";
import { continuityInstruction, mergeContinuityDeltas, parseContinuityDelta } from "./continuity.js";
import { WorkflowDb } from "./workflowDb.js";
import { pauseActivityForInput } from "./activity.js";
import { signalAttention } from "./notify.js";

export const HANDOFF_CACHE_RETENTION_DAYS = 30;
export const HANDOFF_ACCEPTED = "HANDOFF_ACCEPTED";
export const HANDOFF_REQUEST_START = "RAFI_HANDOFF_REQUEST_START";
export const HANDOFF_REQUEST_END = "RAFI_HANDOFF_REQUEST_END";

function handoffSessionIdentity(ref: ProviderSessionRefV1): string {
  return JSON.stringify([ref.version, ref.provider, ref.sessionId, ref.role, ref.stream, ref.generation, resolve(ref.cwd), resolve(ref.configRoot), ref.workspaceIdentity, ref.ticketId, ref.deliveryUnitId]);
}

async function collectHandoffTerminalEvents(adapter: BuilderAdapter, turnId: string): Promise<BuilderEvent[]> {
  const events: BuilderEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const collect = (async () => {
    for await (const event of adapter.events()) {
      events.push(event);
      if (event.kind === "turn-complete" && (event.turnId ?? event.result.turnId) === turnId) break;
    }
  })();
  try {
    await Promise.race([collect, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
  } catch (error) {
    events.push({ kind: "error", message: `handoff event stream failed: ${error instanceof Error ? error.message : String(error)}` });
  } finally { if (timer) clearTimeout(timer); }
  // A missing terminal event makes acceptance fail below and closes the
  // successor, ending any pending iterator read before it can perform work.
  void collect.catch(() => {});
  return events;
}

export interface BuilderHandoffRequest {
  version: 1;
  reason: string;
  delta: ContinuityDelta;
  roleState: Record<string, unknown>;
}

export function parseBuilderHandoffRequest(text: string): BuilderHandoffRequest | undefined {
  const starts = [...text.matchAll(/RAFI_HANDOFF_REQUEST_START/g)];
  const ends = [...text.matchAll(/RAFI_HANDOFF_REQUEST_END/g)];
  if (starts.length === 0 && ends.length === 0) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || starts[0]!.index! >= ends[0]!.index!) throw new Error("malformed structured Builder handoff request envelope");
  const raw = text.slice(starts[0]!.index! + HANDOFF_REQUEST_START.length, ends[0]!.index!).trim();
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error("Builder handoff request is not valid JSON"); }
  const expected = new Set(["version", "reason", "decisions", "constraints", "discoveries", "completed_actions", "evidence", "failures", "blockers", "open_work", "next_action", "role_state"]);
  const unknown = Object.keys(parsed).filter((key) => !expected.has(key));
  if (unknown.length) throw new Error(`Builder handoff request has unknown fields: ${unknown.join(", ")}`);
  if (parsed.version !== 1 || typeof parsed.reason !== "string" || !parsed.reason.trim() || !parsed.role_state || typeof parsed.role_state !== "object" || Array.isArray(parsed.role_state)) throw new Error("Builder handoff request is missing required v1 fields");
  const list = (key: string): string[] => {
    const value = parsed[key];
    if (!Array.isArray(value) || value.length > 500 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 4_000)) throw new Error(`Builder handoff request field ${key} must be a bounded string array`);
    return value as string[];
  };
  if (typeof parsed.next_action !== "string" || !parsed.next_action.trim() || parsed.next_action.length > 4_000) throw new Error("Builder handoff next_action must be a non-empty bounded string");
  return {
    version: 1,
    reason: clean(parsed.reason, 2_000),
    delta: {
      version: 1,
      decisions: list("decisions"), constraints: list("constraints"), discoveries: list("discoveries"),
      completedActions: list("completed_actions"), evidence: list("evidence"), failures: list("failures"),
      blockers: list("blockers"), openWork: list("open_work"), nextAction: parsed.next_action.trim(),
    },
    roleState: sanitizeObject(parsed.role_state as Record<string, unknown>),
  };
}

export interface CreateHandoffInput {
  runId: string;
  role: "builder" | "qa";
  reason: string;
  predecessorSessionId?: string;
  predecessorSessionRef?: ProviderSessionRefV1;
  roleState?: Record<string, unknown>;
  sessionUsage?: SessionUsageSample;
  compactionCount: number;
  compactMaximum: number;
  resources?: Array<{ label: string; content?: string | Buffer; digest?: string; authoritative: boolean; requiredForRecovery?: boolean; mediaType?: string; path?: string; purpose?: string; bytes?: number }>;
  requestedByBuilder?: boolean;
  /** Internal recovery path: use the last valid checkpoint while its head is marked degraded/invalid. */
  allowNonCurrentContinuity?: boolean;
}

export interface StagedHandoff {
  manifest: HandoffManifestV1;
  markdown: string;
  lineage: HandoffLineage;
  cacheDirectory: string;
}

export interface HandoffTransferResult extends StagedHandoff {
  successor: BuilderAdapter;
  successorSessionId: string;
  acceptanceCheckpointDigest: string;
  acceptanceReceipt?: HandoffAcceptanceReceiptV1;
}

export class HandoffLoopError extends Error {
  constructor(readonly runId: string) {
    super(`third consecutive Builder-requested handoff for run ${runId} has been paused; record a useful verified action or use guided recovery`);
  }
}

export type HandoffAcceptanceFailureCode =
  | "missing-acknowledgement"
  | "invalid-continuity-delta"
  | "missing-successor-session"
  | "missing-scoped-successor-session"
  | "provider-turn-failed"
  | "successor-identity-mismatch"
  | "missing-terminal-event"
  | "reused-predecessor-session";

export class HandoffAcceptanceError extends Error {
  constructor(
    readonly code: HandoffAcceptanceFailureCode,
    readonly runId: string,
    readonly generation: number,
    detail: string,
  ) {
    super(`handoff acceptance rejected (${code}): ${detail}; predecessor retains the lease`);
    this.name = "HandoffAcceptanceError";
  }
}

export class HandoffRecoveryPausedError extends Error {
  constructor(readonly runId: string, readonly generation: number, detail: string) {
    super(`handoff recovery paused safely: ${detail}`);
    this.name = "HandoffRecoveryPausedError";
  }
}

export type HandoffRecoveryChoice = "retry" | "switch" | "custom" | "pause";
export interface HandoffRecoveryOptions {
  /** Enables the provider-switch choice. The callback must honor the requested runtime. */
  allowProviderSwitch?: boolean;
  choose?: (error: HandoffAcceptanceError, currentRuntime: "claude" | "codex") => Promise<HandoffRecoveryChoice>;
  customGuidance?: () => Promise<string | undefined>;
  desktopNotifications?: boolean;
  terminalBell?: boolean;
  /** Persist run-local provider selection only after validated acceptance. */
  onAccepted?: (result: HandoffTransferResult) => void | Promise<void>;
}

/** Durable, validated ownership transfer; cache copies are never authoritative. */
export class HandoffService {
  readonly projectDir: string;
  readonly cacheRoot: string;

  constructor(projectDir: string) {
    this.projectDir = resolve(projectDir);
    this.cacheRoot = join(this.projectDir, ".rafi", "cache", "handoffs");
  }

  stage(input: CreateHandoffInput, now = new Date()): StagedHandoff {
    this.pruneExpiredCache(now);
    const db = new WorkflowDb(this.projectDir);
    try {
      db.ensureRun(input.runId);
      if (input.requestedByBuilder && this.consecutiveBuilderRequests(db, input.runId) >= 2) {
        db.appendContinuityEvent({
          runId: input.runId, role: "host", kind: "builder_handoff_loop_paused",
          payload: { reason: clean(input.reason, 2_000), recovery: `rafi build:resume --run ${input.runId} --guided-recovery` },
          authoritativeStateRevision: db.continuityHead(input.runId, "builder")?.authoritativeStateRevision ?? 0,
        }, now);
        db.setContinuityHeadState(input.runId, "builder", "degraded", now);
        throw new HandoffLoopError(input.runId);
      }
      const checkpoints = db.continuityCheckpoints(input.runId, input.role);
      const head = db.continuityHead(input.runId, input.role);
      const runHead = db.continuityHead(input.runId, "run") ?? head;
      if (!head || !runHead || checkpoints.length === 0 || (head.state !== "current" && !input.allowNonCurrentContinuity)) {
        throw new Error(`cannot hand off ${input.role}: the latest continuity checkpoint is ${head?.state ?? "missing"}`);
      }
      const prior = db.handoffs(input.runId).at(-1);
      const generation = (prior?.generation ?? 0) + 1;
      const resources = (input.resources ?? []).map((resource) => ({
        label: resource.label,
        digest: resource.digest && /^[a-f0-9]{64}$/.test(resource.digest) ? resource.digest : digest(resource.content ?? ""),
        authoritative: resource.authoritative,
        requiredForRecovery: resource.requiredForRecovery ?? false,
        mediaType: resource.mediaType ?? "application/octet-stream",
        path: resource.path ?? `embedded:${resource.label}`,
        purpose: resource.purpose ?? `Declared ${input.role} handoff resource: ${resource.label}`,
        bytes: resource.bytes ?? (resource.content !== undefined ? Buffer.byteLength(resource.content) : 0),
      }));
      resources.unshift(
        { label: "continuity-checkpoint", digest: head.digest, authoritative: true, requiredForRecovery: false, mediaType: "application/vnd.rafi.digest", path: "db:continuity-checkpoint", purpose: "Digest reference to the durable role continuity checkpoint", bytes: Buffer.byteLength(head.digest) },
        { label: "authoritative-run-state", digest: runHead.digest, authoritative: true, requiredForRecovery: false, mediaType: "application/vnd.rafi.digest", path: "db:authoritative-run-state", purpose: "Digest reference to the durable run continuity state", bytes: Buffer.byteLength(runHead.digest) },
      );
      const manifest: HandoffManifestV1 = {
        version: 1,
        runId: input.runId,
        generation,
        role: input.role,
        reason: clean(input.reason, 2_000),
        ...(input.predecessorSessionId ? { predecessorSessionId: input.predecessorSessionId } : {}),
        ...(input.predecessorSessionRef ? { predecessorSessionRef: input.predecessorSessionRef } : {}),
        ...(prior ? { predecessorManifestDigest: prior.manifestDigest } : {}),
        continuityCheckpointDigest: head.digest,
        authoritativeStateDigest: runHead.digest,
        cumulative: mergeContinuityDeltas(checkpoints.map((checkpoint) => checkpoint.delta)),
        roleState: sanitizeObject(input.roleState ?? {}),
        lineage: db.handoffs(input.runId).map((item) => item.manifestDigest),
        ...(input.sessionUsage ? { sessionUsage: input.sessionUsage } : {}),
        compactionCount: input.compactionCount,
        compactMaximum: input.compactMaximum,
        resources,
        createdAt: now.toISOString(),
      };
      const markdown = renderHandoffMarkdown(manifest);
      const lineage = db.stageHandoff(manifest, markdown);
      db.appendContinuityEvent({
        runId: input.runId, role: "host", kind: input.requestedByBuilder ? "builder_handoff_requested" : "handoff_requested",
        payload: {
          generation, reason: manifest.reason,
          occupancy: input.roleState?.contextSample ?? input.roleState?.occupancy ?? "unavailable",
          sessionUsage: input.sessionUsage ?? "unavailable",
          compactionCount: input.compactionCount, compactMaximum: input.compactMaximum, resources,
        },
        authoritativeStateRevision: head.authoritativeStateRevision,
      }, now);
      const cacheDirectory = this.materialize(manifest, markdown);
      return { manifest, markdown, lineage, cacheDirectory };
    } finally { db.close(); }
  }

  async transfer(
    input: CreateHandoffInput,
    createSuccessor: (handoff: StagedHandoff, requestedRuntime?: "claude" | "codex") => Promise<BuilderAdapter>,
    recovery: HandoffRecoveryOptions = {},
  ): Promise<HandoffTransferResult> {
    const staged = this.stage(input);
    const successor = await createSuccessor(staged);
    return this.acceptStagedWithRecovery(staged, successor, createSuccessor, recovery);
  }

  async acceptStagedWithRecovery(
    staged: StagedHandoff,
    initialSuccessor: BuilderAdapter,
    createSuccessor: (handoff: StagedHandoff, requestedRuntime?: "claude" | "codex") => Promise<BuilderAdapter>,
    recovery: HandoffRecoveryOptions = {},
  ): Promise<HandoffTransferResult> {
    let successor = initialSuccessor;
    let guidance: string | undefined;
    while (true) {
      try {
        const accepted = await this.acceptStaged(staged, successor, { finalizeFailure: false, guidance });
        await recovery.onAccepted?.(accepted);
        return accepted;
      } catch (error) {
        if (!(error instanceof HandoffAcceptanceError)) {
          this.failStaged(staged, error instanceof Error ? error.message : String(error));
          throw error;
        }
        if ((!process.stdin.isTTY || !process.stdout.isTTY) && !recovery.choose) {
          this.failStaged(staged, error.message);
          throw error;
        }
        signalAttention("Rafi handoff needs input", error.message, recovery.desktopNotifications, recovery.terminalBell);
        const currentRuntime = successor.agent;
        const choice = recovery.choose
          ? await recovery.choose(error, currentRuntime)
          : await promptHandoffRecovery(error, currentRuntime, Boolean(recovery.allowProviderSwitch));
        if (choice === "pause") {
          this.failStaged(staged, `user paused after ${error.code}`);
          throw new HandoffRecoveryPausedError(staged.manifest.runId, staged.manifest.generation, error.message);
        }
        guidance = undefined;
        let requestedRuntime: "claude" | "codex" | undefined;
        if (choice === "switch") requestedRuntime = currentRuntime === "claude" ? "codex" : "claude";
        if (choice === "custom") {
          guidance = recovery.customGuidance ? await recovery.customGuidance() : await promptCustomHandoffGuidance();
          if (!guidance) {
            successor = await createSuccessor(staged);
            continue;
          }
        }
        successor = await createSuccessor(staged, requestedRuntime);
        if (requestedRuntime && successor.agent !== requestedRuntime) {
          await successor.close().catch(() => {});
          console.warn(`foreman: ${requestedRuntime} was not available from the successor factory; choose another handoff recovery option`);
          successor = await createSuccessor(staged);
        }
      }
    }
  }

  async acceptStaged(
    staged: StagedHandoff,
    successor: BuilderAdapter,
    options: { finalizeFailure?: boolean; guidance?: string } = {},
  ): Promise<HandoffTransferResult> {
    const db = new WorkflowDb(this.projectDir);
    try {
      const qaBoundary = staged.manifest.role === "qa";
      const preparedRef = successor.sessionRef?.();
      if (qaBoundary && (!preparedRef || preparedRef.version !== 1 || preparedRef.source !== "observed"
        || preparedRef.role !== "qa" || preparedRef.stream !== "qa" || preparedRef.provider !== successor.agent
        || !preparedRef.sessionId.trim() || /^(?:unknown|unavailable)$/i.test(preparedRef.sessionId.trim())
        || !preparedRef.cwd || !preparedRef.configRoot || !Number.isSafeInteger(preparedRef.generation) || preparedRef.generation < 0
        || !preparedRef.validatedAt || Number.isNaN(Date.parse(preparedRef.validatedAt)) || Number.isNaN(Date.parse(preparedRef.createdAt))
        || preparedRef.sessionId !== successor.sessionId())) {
        throw new HandoffAcceptanceError("missing-scoped-successor-session", staged.manifest.runId, staged.manifest.generation, "QA acceptance requires a prepared, validated scoped successor");
      }
      const acceptanceAttempts: Array<{ hostPromptDigest: string; providerPromptDigest: string; rawResponseDigest: string; cleanedResponseDigest: string; providerTurnId?: string; eventStreamDigest?: string }> = [];
      const sendAcceptance = async (prompt: string): Promise<TurnResult> => {
        const hostPromptDigest = db.putEvidence("handoff", Buffer.from(prompt));
        db.appendContinuityEvent({ runId: staged.manifest.runId, role: "host", kind: "handoff_acceptance_intended", payload: { generation: staged.manifest.generation, attempt: acceptanceAttempts.length + 1, hostPromptDigest, preparedRef }, authoritativeStateRevision: db.continuityHead(staged.manifest.runId, staged.manifest.role)?.authoritativeStateRevision ?? 0 });
        const response = await successor.sendTurn(prompt);
        const events = qaBoundary && response.turnId ? await collectHandoffTerminalEvents(successor, response.turnId) : [];
        const attempt = {
          hostPromptDigest,
          providerPromptDigest: db.putEvidence("handoff", Buffer.from(response.providerInstruction ?? response.hostInstruction ?? prompt)),
          rawResponseDigest: db.putEvidence("handoff", Buffer.from(response.rawResponse ?? response.text)),
          cleanedResponseDigest: db.putEvidence("handoff", Buffer.from(response.cleanedResponse ?? response.text)),
          ...(response.turnId ? { providerTurnId: response.turnId } : {}),
          ...(qaBoundary ? { eventStreamDigest: db.putEvidence("handoff", Buffer.from(JSON.stringify(events))) } : {}),
        };
        acceptanceAttempts.push(attempt);
        db.appendContinuityEvent({ runId: staged.manifest.runId, role: "host", kind: "handoff_acceptance_observed", payload: { generation: staged.manifest.generation, attempt, isError: response.isError, failure: response.failure, providerMetadata: response.providerMetadata, activeSession: successor.sessionRef?.() }, authoritativeStateRevision: db.continuityHead(staged.manifest.runId, staged.manifest.role)?.authoritativeStateRevision ?? 0 });
        if (response.isError || response.failure) throw new HandoffAcceptanceError("provider-turn-failed", staged.manifest.runId, staged.manifest.generation, "provider rejected or failed the acknowledgement turn");
        const activeRef = successor.sessionRef?.();
        const reportedRef = response.providerMetadata?.sessionRef;
        if ((preparedRef && (!activeRef || handoffSessionIdentity(activeRef) !== handoffSessionIdentity(preparedRef)))
          || (qaBoundary && (!response.providerMetadata || !reportedRef || response.providerMetadata.provider !== preparedRef!.provider
            || response.providerMetadata.sessionId !== preparedRef!.sessionId || successor.sessionId() !== preparedRef!.sessionId
            || successor.agent !== preparedRef!.provider || handoffSessionIdentity(reportedRef) !== handoffSessionIdentity(preparedRef!)))) {
          throw new HandoffAcceptanceError("successor-identity-mismatch", staged.manifest.runId, staged.manifest.generation, "acknowledgement did not come from the prepared successor identity");
        }
        if (qaBoundary && (!response.turnId || !events.some((event) => event.kind === "turn-complete" && (event.turnId ?? event.result.turnId) === response.turnId))) {
          throw new HandoffAcceptanceError("missing-terminal-event", staged.manifest.runId, staged.manifest.generation, "QA acknowledgement has no correlated terminal provider event");
        }
        return response;
      };
      const acceptancePrompt = [
        "Accept this validated Rafi handoff. Do not repeat completed work and reconcile host receipts before side effects.",
        staged.markdown,
        `Manifest JSON: ${JSON.stringify(staged.manifest)}`,
        ...(options.guidance ? [`Human recovery guidance: ${options.guidance}`] : []),
        `Reply with ${HANDOFF_ACCEPTED} on the first line, then ${continuityInstruction()}`,
      ].join("\n\n");
      let response = await sendAcceptance(acceptancePrompt);
      let validation = validateHandoffAcceptance(staged, successor, response.text);
      if (validation && (validation.code === "missing-acknowledgement" || validation.code === "invalid-continuity-delta")) {
        const repairPrompt = [
          `Your handoff acknowledgement was rejected: ${validation.message}.`,
          "Correction only: do not use tools, repeat completed work, or perform implementation.",
          `Reply with ${HANDOFF_ACCEPTED} on the first line, then ${continuityInstruction()}`,
        ].join("\n\n");
        response = await sendAcceptance(repairPrompt);
        validation = validateHandoffAcceptance(staged, successor, response.text);
      }
      if (validation) throw new HandoffAcceptanceError(validation.code, staged.manifest.runId, staged.manifest.generation, validation.message);
      const parsed = parseContinuityDelta(response.text);
      const sessionId = successor.sessionId();
      const observedSuccessorRef = successor.sessionRef?.();
      const successorRef = observedSuccessorRef ? { ...observedSuccessorRef, generation: staged.manifest.generation, validatedAt: new Date().toISOString() } : undefined;
      if (!parsed.delta || !sessionId) throw new Error("validated handoff acceptance lost its parsed continuity state");
      if (staged.manifest.resources.some((resource) => resource.requiredForRecovery)
        && (!successorRef || staged.manifest.resources.some((resource) => resource.requiredForRecovery && (!resource.purpose || !Number.isSafeInteger(resource.bytes) || resource.bytes! < 0)))) {
        throw new HandoffAcceptanceError("missing-scoped-successor-session", staged.manifest.runId, staged.manifest.generation, "recovery handoffs require a scoped successor and complete resource purpose/byte metadata");
      }
      if (successorRef) successor.adoptSessionRef?.(successorRef);
      db.appendContinuityEvent({ runId: staged.manifest.runId, role: staged.manifest.role, kind: "handoff_successor_accepted", payload: { generation: staged.manifest.generation, sessionId, sessionRef: successorRef, delta: parsed.delta, acceptanceAttempts }, authoritativeStateRevision: db.continuityHead(staged.manifest.runId, staged.manifest.role)?.authoritativeStateRevision ?? 0, sessionRef: successorRef });
      const checkpoint = db.publishContinuityCheckpoint({ runId: staged.manifest.runId, role: staged.manifest.role, delta: parsed.delta, authoritativeStateRevision: db.continuityHead(staged.manifest.runId, staged.manifest.role)?.authoritativeStateRevision ?? 0, sessionRef: successorRef });
      const receipt: HandoffAcceptanceReceiptV1 | undefined = successorRef ? { version: 1, runId: staged.manifest.runId, generation: staged.manifest.generation, role: staged.manifest.role,
        manifestDigest: staged.lineage.manifestDigest, continuityCheckpointDigest: staged.manifest.continuityCheckpointDigest, acceptanceCheckpointDigest: checkpoint.digest,
        ...(staged.manifest.predecessorSessionRef ? { predecessorSessionRef: staged.manifest.predecessorSessionRef } : {}), successorSessionRef: successorRef,
        resources: staged.manifest.resources, acceptedAt: new Date().toISOString() } : undefined;
      const lineage = db.acceptHandoff(staged.manifest.runId, staged.manifest.generation, successorRef ?? sessionId, undefined, receipt);
      return { ...staged, lineage, successor, successorSessionId: sessionId, acceptanceCheckpointDigest: checkpoint.digest, ...(receipt ? { acceptanceReceipt: receipt } : {}) };
    } catch (error) {
      if (error instanceof HandoffAcceptanceError) await successor.close().catch(() => {});
      const current = db.handoff(staged.manifest.runId, staged.manifest.generation);
      if (options.finalizeFailure !== false && current?.state === "staged") db.failHandoff(staged.manifest.runId, staged.manifest.generation, error instanceof Error ? error.message : String(error));
      throw error;
    } finally { db.close(); }
  }

  private failStaged(staged: StagedHandoff, detail: string): void {
    const db = new WorkflowDb(this.projectDir);
    try {
      if (db.handoff(staged.manifest.runId, staged.manifest.generation)?.state === "staged") {
        db.failHandoff(staged.manifest.runId, staged.manifest.generation, detail);
      }
    } finally { db.close(); }
  }

  inspect(runId: string, generation?: number): { manifest: HandoffManifestV1; markdown: string; lineage: HandoffLineage } {
    const db = new WorkflowDb(this.projectDir);
    try {
      const selected = generation ?? db.handoffs(runId).at(-1)?.generation;
      if (selected === undefined) throw new Error(`no handoff history found for run ${runId}`);
      const value = db.handoffContent(runId, selected);
      if (!value) throw new Error(`handoff ${runId}/${selected} not found`);
      return value;
    } finally { db.close(); }
  }

  loadStaged(runId: string, generation: number): StagedHandoff {
    const value = this.inspect(runId, generation);
    if (value.lineage.state !== "staged") throw new Error(`handoff ${runId}/${generation} is ${value.lineage.state}, not staged`);
    return { ...value, cacheDirectory: this.materialize(value.manifest, value.markdown) };
  }

  pruneCache(runId: string, keepLatest = 1): string[] {
    if (!Number.isSafeInteger(keepLatest) || keepLatest < 0) throw new Error("--keep-latest must be a non-negative safe integer");
    const runDir = this.safeRunCache(runId);
    if (!existsSync(runDir)) return [];
    const generations = readdirSync(runDir).filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => b - a);
    const removed: string[] = [];
    for (const generation of generations.slice(keepLatest)) {
      const target = join(runDir, String(generation));
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
    return removed;
  }

  pruneExpiredCache(now = new Date(), retentionDays = HANDOFF_CACHE_RETENTION_DAYS): string[] {
    if (!existsSync(this.cacheRoot)) return [];
    const db = new WorkflowDb(this.projectDir);
    const protectedRuns = new Set(db.resumableRuns().map((run) => run.runId));
    db.close();
    const cutoff = now.getTime() - retentionDays * 86_400_000;
    const removed: string[] = [];
    for (const runId of readdirSync(this.cacheRoot)) {
      if (protectedRuns.has(runId)) continue;
      const runDir = this.safeRunCache(runId);
      for (const generation of existsSync(runDir) ? readdirSync(runDir) : []) {
        const target = join(runDir, generation);
        if (statSync(target).mtimeMs < cutoff) { rmSync(target, { recursive: true, force: true }); removed.push(target); }
      }
    }
    return removed;
  }

  private materialize(manifest: HandoffManifestV1, markdown: string): string {
    const runDir = this.safeRunCache(manifest.runId);
    mkdirSync(runDir, { recursive: true });
    const target = join(runDir, String(manifest.generation));
    if (existsSync(target)) return target;
    const temporary = mkdtempSync(join(runDir, `.stage-${manifest.generation}-`));
    writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(temporary, "handoff.md"), markdown, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    return target;
  }

  private safeRunCache(runId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === "..") throw new Error("unsafe handoff run ID");
    const path = join(this.cacheRoot, runId);
    if (!path.startsWith(`${this.cacheRoot}/`)) throw new Error("unsafe handoff cache path");
    return path;
  }

  private consecutiveBuilderRequests(db: WorkflowDb, runId: string): number {
    let count = 0;
    let usefulSinceLastRequest = false;
    const events = db.continuityEvents(runId);
    for (const event of events) {
      if (event.kind === "turn_completed" || event.kind === "turn_completed_after_repair") {
        const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : undefined;
        const delta = payload?.delta;
        if (isContinuityDelta(delta) && useful(delta)) usefulSinceLastRequest = true;
        continue;
      }
      if (event.kind === "builder_handoff_requested") {
        if (usefulSinceLastRequest) count = 0;
        count += 1;
        usefulSinceLastRequest = false;
      }
    }
    return count;
  }
}

function validateHandoffAcceptance(
  staged: StagedHandoff,
  successor: BuilderAdapter,
  text: string,
): { code: HandoffAcceptanceFailureCode; message: string } | undefined {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (firstLine !== HANDOFF_ACCEPTED) {
    return { code: "missing-acknowledgement", message: `the first non-whitespace line must equal ${HANDOFF_ACCEPTED}` };
  }
  const parsed = parseContinuityDelta(text);
  if (!parsed.delta) {
    return { code: "invalid-continuity-delta", message: parsed.error?.problems.join("; ") ?? "the continuity delta is missing or malformed" };
  }
  const sessionId = successor.sessionId();
  if (!sessionId) return { code: "missing-successor-session", message: "the provider did not expose a successor session ID" };
  if (staged.manifest.predecessorSessionRef && !successor.sessionRef?.()) {
    return { code: "missing-scoped-successor-session", message: "the provider did not expose a location-scoped successor session reference" };
  }
  if (staged.manifest.predecessorSessionId && sessionId === staged.manifest.predecessorSessionId) {
    return { code: "reused-predecessor-session", message: `successor reused predecessor session ${sessionId}; a genuinely fresh session is required` };
  }
  return undefined;
}

async function promptHandoffRecovery(
  error: HandoffAcceptanceError,
  runtime: "claude" | "codex",
  allowProviderSwitch: boolean,
): Promise<HandoffRecoveryChoice> {
  const { select, isCancel } = await import("@clack/prompts");
  return pauseActivityForInput(async () => {
    console.error(`foreman: ${error.message}`);
    const other = runtime === "claude" ? "codex" : "claude";
    const answer = await select<HandoffRecoveryChoice>({
      message: "How should Rafi recover the rejected successor handoff?",
      options: [
        { value: "retry", label: `Retry ${runtime} with a fresh successor (Recommended)`, hint: "The rejected successor is closed; the predecessor keeps its lease" },
        ...(allowProviderSwitch ? [{ value: "switch" as const, label: `Switch to verified ${other}`, hint: "Use a fresh provider session without changing project defaults" }] : []),
        { value: "custom", label: "Add custom guidance and retry", hint: "Give the next fresh successor an explicit correction" },
        { value: "pause", label: "Pause safely", hint: "Keep the predecessor lease and return recovery instructions" },
      ],
    });
    return isCancel(answer) ? "pause" : answer;
  });
}

async function promptCustomHandoffGuidance(): Promise<string | undefined> {
  const { text, isCancel } = await import("@clack/prompts");
  return pauseActivityForInput(async () => {
    const answer = await text({
      message: "Guidance for the next fresh successor:",
      validate: (value) => String(value ?? "").trim() ? undefined : "Enter guidance",
    });
    return isCancel(answer) ? undefined : String(answer);
  });
}

export function renderHandoffMarkdown(manifest: HandoffManifestV1): string {
  const section = (title: string, values: string[]) => [`## ${title}`, "", ...(values.length ? values.map((value) => `- ${value}`) : ["- None recorded."]), ""];
  return [
    `# Rafi handoff — ${manifest.runId} / generation ${manifest.generation}`,
    "",
    `Role: ${manifest.role}`,
    `Reason: ${manifest.reason}`,
    `Created: ${manifest.createdAt}`,
    `Compactions: ${manifest.compactionCount}/${manifest.compactMaximum}`,
    "",
    ...section("Decisions", manifest.cumulative.decisions),
    ...section("Constraints", manifest.cumulative.constraints),
    ...section("Discoveries", manifest.cumulative.discoveries),
    ...section("Completed work and evidence", [...manifest.cumulative.completedActions, ...manifest.cumulative.evidence]),
    ...section("Failures and blockers", [...manifest.cumulative.failures, ...manifest.cumulative.blockers]),
    ...section("Remaining actions", [...manifest.cumulative.openWork, `Next: ${manifest.cumulative.nextAction}`]),
    "## Role state",
    "",
    "```json",
    JSON.stringify(manifest.roleState, null, 2),
    "```",
    "",
    "## Authoritative source digests",
    "",
    "| Source | Digest | Authoritative |",
    "|---|---|---|",
    ...manifest.resources.map((resource) => `| ${escapeCell(resource.label)} | \`${resource.digest}\` | ${resource.authoritative ? "yes" : "no"} |`),
    "",
  ].join("\n");
}

export function writeHandoffInspection(path: string, content: string): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
}

function useful(delta: ContinuityDelta): boolean {
  return delta.completedActions.length > 0 || delta.evidence.length > 0 || delta.decisions.length > 0 || delta.discoveries.length > 0 || delta.blockers.length > 0;
}
function isContinuityDelta(value: unknown): value is ContinuityDelta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ContinuityDelta>;
  return candidate.version === 1
    && [candidate.completedActions, candidate.evidence, candidate.decisions, candidate.discoveries, candidate.blockers].every(Array.isArray);
}
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function clean(value: string, maximum: number): string { return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum); }
function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> { return JSON.parse(JSON.stringify(value, (key, entry) => /credential|secret|token|password|raw.?transcript|hidden.?reasoning/i.test(key) ? undefined : typeof entry === "string" ? entry.slice(0, 20_000) : entry)) as Record<string, unknown>; }
function escapeCell(value: string): string { return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " "); }
