import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ContinuityDelta, HandoffLineage, HandoffManifestV1, ProviderSessionRefV1, SessionUsageSample } from "rafi-spec";
import type { BuilderAdapter } from "./adapters/types.js";
import { continuityInstruction, mergeContinuityDeltas, parseContinuityDelta } from "./continuity.js";
import { WorkflowDb } from "./workflowDb.js";

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

  async transfer(input: CreateHandoffInput, createSuccessor: (handoff: StagedHandoff) => Promise<BuilderAdapter>): Promise<HandoffTransferResult> {
    const staged = this.stage(input);
    const successor = await createSuccessor(staged);
    return this.acceptStaged(staged, successor);
  }

  async acceptStaged(staged: StagedHandoff, successor: BuilderAdapter): Promise<HandoffTransferResult> {
    const db = new WorkflowDb(this.projectDir);
    try {
      const response = await successor.sendTurn([
        "Accept this validated Rafi handoff. Do not repeat completed work and reconcile host receipts before side effects.",
        staged.markdown,
        `Manifest JSON: ${JSON.stringify(staged.manifest)}`,
        `Reply with ${HANDOFF_ACCEPTED} on the first line, then ${continuityInstruction()}`,
      ].join("\n\n"));
      const parsed = parseContinuityDelta(response.text);
      const sessionId = successor.sessionId();
      const observedSuccessorRef = successor.sessionRef?.();
      const successorRef = observedSuccessorRef ? { ...observedSuccessorRef, generation: staged.manifest.generation, validatedAt: new Date().toISOString() } : undefined;
      if (!response.text.trimStart().startsWith(HANDOFF_ACCEPTED) || !parsed.delta || !sessionId || (staged.manifest.predecessorSessionRef && !successorRef)) {
        db.failHandoff(staged.manifest.runId, staged.manifest.generation, "successor did not provide HANDOFF_ACCEPTED, a valid continuity delta, and a fresh session identity");
        await successor.close().catch(() => {});
        throw new Error("fresh successor failed validated handoff acceptance; predecessor retains the lease");
      }
      if (staged.manifest.predecessorSessionId && sessionId === staged.manifest.predecessorSessionId) {
        db.failHandoff(staged.manifest.runId, staged.manifest.generation, "successor reused predecessor session ID");
        await successor.close().catch(() => {});
        throw new Error("handoff successor must be a genuinely fresh provider session");
      }
      if (successorRef) successor.adoptSessionRef?.(successorRef);
      db.appendContinuityEvent({ runId: staged.manifest.runId, role: staged.manifest.role, kind: "handoff_successor_accepted", payload: { generation: staged.manifest.generation, sessionId, sessionRef: successorRef, delta: parsed.delta }, authoritativeStateRevision: db.continuityHead(staged.manifest.runId, staged.manifest.role)?.authoritativeStateRevision ?? 0, sessionRef: successorRef });
      const checkpoint = db.publishContinuityCheckpoint({ runId: staged.manifest.runId, role: staged.manifest.role, delta: parsed.delta, authoritativeStateRevision: db.continuityHead(staged.manifest.runId, staged.manifest.role)?.authoritativeStateRevision ?? 0, sessionRef: successorRef });
      const lineage = db.acceptHandoff(staged.manifest.runId, staged.manifest.generation, successorRef ?? sessionId);
      return { ...staged, lineage, successor, successorSessionId: sessionId, acceptanceCheckpointDigest: checkpoint.digest };
    } catch (error) {
      const current = db.handoff(staged.manifest.runId, staged.manifest.generation);
      if (current?.state === "staged") db.failHandoff(staged.manifest.runId, staged.manifest.generation, error instanceof Error ? error.message : String(error));
      throw error;
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
