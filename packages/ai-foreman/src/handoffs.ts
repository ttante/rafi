import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ContinuityDelta, HandoffLineage, HandoffManifestV1, ProviderSessionRefV1, SessionUsageSample } from "rafi-spec";
import type { BuilderAdapter } from "./adapters/types.js";
import { continuityInstruction, mergeContinuityDeltas, parseContinuityDelta } from "./continuity.js";
import { WorkflowDb } from "./workflowDb.js";
import { pauseActivityForInput } from "./activity.js";
import { signalAttention } from "./notify.js";

export const HANDOFF_CACHE_RETENTION_DAYS = 30;
export const HANDOFF_ACCEPTED = "HANDOFF_ACCEPTED";
export const HANDOFF_REQUEST_START = "RAFI_HANDOFF_REQUEST_START";
export const HANDOFF_REQUEST_END = "RAFI_HANDOFF_REQUEST_END";

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
  resources?: Array<{ label: string; content: string | Buffer; authoritative: boolean }>;
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
        digest: digest(resource.content),
        authoritative: resource.authoritative,
      }));
      resources.unshift(
        { label: "continuity-checkpoint", digest: head.digest, authoritative: true },
        { label: "authoritative-run-state", digest: runHead.digest, authoritative: true },
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
      const acceptancePrompt = [
        "Accept this validated Rafi handoff. Do not repeat completed work and reconcile host receipts before side effects.",
        staged.markdown,
        `Manifest JSON: ${JSON.stringify(staged.manifest)}`,
        ...(options.guidance ? [`Human recovery guidance: ${options.guidance}`] : []),
        `Reply with ${HANDOFF_ACCEPTED} on the first line, then ${continuityInstruction()}`,
      ].join("\n\n");
      let response = await successor.sendTurn(acceptancePrompt);
      let validation = validateHandoffAcceptance(staged, successor, response.text);
      if (validation && (validation.code === "missing-acknowledgement" || validation.code === "invalid-continuity-delta")) {
        response = await successor.sendTurn([
          `Your handoff acknowledgement was rejected: ${validation.message}.`,
          "Correction only: do not use tools, repeat completed work, or perform implementation.",
          `Reply with ${HANDOFF_ACCEPTED} on the first line, then ${continuityInstruction()}`,
        ].join("\n\n"));
        validation = validateHandoffAcceptance(staged, successor, response.text);
      }
      if (validation) throw new HandoffAcceptanceError(validation.code, staged.manifest.runId, staged.manifest.generation, validation.message);
      const parsed = parseContinuityDelta(response.text);
      const sessionId = successor.sessionId();
      const observedSuccessorRef = successor.sessionRef?.();
      const successorRef = observedSuccessorRef ? { ...observedSuccessorRef, generation: staged.manifest.generation, validatedAt: new Date().toISOString() } : undefined;
      if (!parsed.delta || !sessionId) throw new Error("validated handoff acceptance lost its parsed continuity state");
      if (successorRef) successor.adoptSessionRef?.(successorRef);
      db.appendContinuityEvent({ runId: staged.manifest.runId, role: staged.manifest.role, kind: "handoff_successor_accepted", payload: { generation: staged.manifest.generation, sessionId, sessionRef: successorRef, delta: parsed.delta }, authoritativeStateRevision: db.continuityHead(staged.manifest.runId, staged.manifest.role)?.authoritativeStateRevision ?? 0, sessionRef: successorRef });
      const checkpoint = db.publishContinuityCheckpoint({ runId: staged.manifest.runId, role: staged.manifest.role, delta: parsed.delta, authoritativeStateRevision: db.continuityHead(staged.manifest.runId, staged.manifest.role)?.authoritativeStateRevision ?? 0, sessionRef: successorRef });
      const lineage = db.acceptHandoff(staged.manifest.runId, staged.manifest.generation, successorRef ?? sessionId);
      return { ...staged, lineage, successor, successorSessionId: sessionId, acceptanceCheckpointDigest: checkpoint.digest };
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
  if (!text.trimStart().startsWith(HANDOFF_ACCEPTED)) {
    return { code: "missing-acknowledgement", message: `the first non-whitespace line must begin with ${HANDOFF_ACCEPTED}` };
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
