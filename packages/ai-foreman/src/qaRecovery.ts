import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync,
  realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseQaFailureReport, type QaFailureReportV1 } from "rafi-spec";
import { calculateFrozenQaStateDigest, captureFrozenQaSource, type FrozenQaSourceState, type QaSourcePathState, type QaUntrackedCapture } from "./qaSnapshot.js";
import { WorkflowDb } from "./workflowDb.js";

export const QA_RECOVERY_ROOT = ".foreman/qa-report-recovery";
export const QA_CONTEXT_ROOT = ".foreman/qa-recovery-context";

export type QaRecoveryIntegrityPolicy = "sealed" | "operator_editable";
export type QaRecoveryPendingAction = "automatic-recovery" | "successor-acknowledgement" | "qa-correction" | "qa-full-review" | "operator-menu" | "validated-report" | "builder-remediation-pending" | "builder-remediation-in-flight" | "resolved";

export interface QaRecoveryResourceV2 {
  path: string;
  purpose: string;
  mediaType: string;
  bytes: number;
  digest: string;
  requiredForRecovery: boolean;
  integrityPolicy: QaRecoveryIntegrityPolicy;
  objectPath?: string;
}

export interface QaRecoveryManifestV2 {
  version: 2;
  packetId: string;
  packetDigest: string;
  revision: number;
  parentPacketDigest?: string;
  runId: string;
  ticketId: string;
  cycle: number;
  reviewAttempt: number;
  reviewAttemptId: string;
  /** @deprecated numeric compatibility alias for reviewAttempt. */
  attempt: number;
  recoveryStage: string;
  correctionTurns: number;
  pendingAction: QaRecoveryPendingAction;
  originalReviewedStateDigest: string;
  currentReviewedStateDigest: string;
  /** Current digest compatibility alias used by handoff APIs. */
  reviewedStateDigest: string;
  createdAt: string;
  updatedAt: string;
  resources: QaRecoveryResourceV2[];
}

/** Only for detecting and routing old packets; V1 is never authoritative. */
export interface QaRecoveryManifestV1 {
  version: 1;
  packetId?: string;
  packetDigest?: string;
  runId?: string;
  ticketId?: string;
  resources?: Array<{ path?: string; purpose?: string; mediaType?: string; bytes?: number; digest?: string }>;
}

export class LegacyQaRecoveryPacketError extends Error {
  constructor(readonly directory: string, readonly manifest: QaRecoveryManifestV1) {
    super("legacy QA recovery V1 packet requires a clean protected review or non-authoritative historical-context review");
    this.name = "LegacyQaRecoveryPacketError";
  }
}

export interface QaRecoveryPacket { directory: string; projectDir: string; manifest: QaRecoveryManifestV2 }

export interface QaRecoveryPacketInput {
  projectDir: string;
  frozenState?: FrozenQaSourceState;
  /** Compatibility input; captured immediately when frozenState is unavailable. */
  reviewedWorktree?: string;
  runId: string;
  ticketId: string;
  cycle: number;
  reviewAttempt: number;
  reviewAttemptId?: string;
  attempt?: number;
  recoveryStage: string;
  correctionTurns?: number;
  pendingAction?: QaRecoveryPendingAction;
  resources: Record<string, { value: unknown; purpose: string; mediaType?: string; requiredForRecovery?: boolean; exactText?: boolean }>;
  reportJson?: string;
}

export function loadQaRecoveryPacket(directory: string): QaRecoveryPacket {
  const root = resolve(directory);
  if (!existsSync(root) || realpathSync(root) !== root) throw new Error(`symlink is not allowed in recovery path: ${root}`);
  assertNoSymlinkComponents(root, root);
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) throw new Error("missing or unsafe QA recovery manifest");
  let raw = JSON.parse(readFileSync(manifestPath, "utf8")) as QaRecoveryManifestV1 | QaRecoveryManifestV2;
  if (raw.version === 1) throw new LegacyQaRecoveryPacketError(root, raw);
  assertPrivateTree(root);
  assertManifestShape(raw);
  for (const resource of raw.resources) validateResource(root, resource);
  validateReviewedStates(root, raw);
  const actualDigest = calculatePacketDigest(root, raw);
  if (actualDigest !== raw.packetDigest) throw new Error("QA recovery packet digest mismatch");
  const revisionPath = join(root, "manifests", revisionName(raw.revision));
  if (!existsSync(revisionPath) || readFileSync(revisionPath, "utf8") !== readFileSync(join(root, "manifest.json"), "utf8")) {
    throw new Error(`QA recovery revision ${raw.revision} is missing or inconsistent`);
  }
  let parent: QaRecoveryManifestV2 | undefined;
  for (let revision = 1; revision <= raw.revision; revision++) {
    const path = join(root, "manifests", revisionName(revision));
    if (!existsSync(path)) throw new Error(`QA recovery revision lineage is missing revision ${revision}`);
    const item = JSON.parse(readFileSync(path, "utf8")) as QaRecoveryManifestV1 | QaRecoveryManifestV2;
    assertManifestShape(item);
    if (item.revision !== revision || item.packetId !== raw.packetId) throw new Error(`QA recovery revision lineage mismatch at revision ${revision}`);
    if (revision === 1 ? item.parentPacketDigest !== undefined : item.parentPacketDigest !== parent?.packetDigest) throw new Error(`QA recovery parent digest mismatch at revision ${revision}`);
    if (calculatePacketDigest(root, item) !== item.packetDigest) throw new Error(`QA recovery historical revision digest mismatch at revision ${revision}`);
    parent = item;
  }
  const projectDir = recoveryProjectRoot(root);
  return { directory: root, projectDir, manifest: raw };
}

export function inspectLegacyQaRecoveryPacket(directory: string): { directory: string; manifest: QaRecoveryManifestV1 } | undefined {
  const root = resolve(directory);
  if (!existsSync(join(root, "manifest.json"))) return undefined;
  assertNoSymlinkComponents(root, root);
  const raw = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as QaRecoveryManifestV1 | QaRecoveryManifestV2;
  return raw.version === 1 ? { directory: root, manifest: raw } : undefined;
}

export function materializeLegacyQaHistoricalContext(projectDir: string, legacy: { directory: string; manifest: QaRecoveryManifestV1 }): { directory: string; readable: string[]; rejected: Array<{ path: string; reason: string }> } {
  const source = realpathSync(resolve(legacy.directory));
  assertNoSymlinkComponents(source, source);
  if (typeof process.getuid === "function" && statOwner(source) !== process.getuid()) throw new Error("legacy QA recovery packet is not owned by the current operator");
  const target = join(realpathSync(resolve(projectDir)), ".foreman", "qa-legacy-history", `${safeSlug(legacy.manifest.packetId ?? "legacy")}-${randomUUID()}`);
  if (existsSync(target)) throw new Error(`legacy QA historical context already exists: ${target}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const readable: string[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  for (const item of legacy.manifest.resources ?? []) {
    const name = typeof item.path === "string" ? item.path : "";
    try {
      const relativePath = safeRelative(name); const input = resolve(source, relativePath);
      if (!input.startsWith(`${source}${sep}`) || !existsSync(input)) throw new Error("missing or outside packet containment");
      assertNoSymlinkComponents(source, input);
      if (typeof process.getuid === "function" && statOwner(input) !== process.getuid()) throw new Error("not owned by the current operator");
      const bytes = readFileSync(input);
      if (typeof item.bytes === "number" && bytes.length !== item.bytes) throw new Error("byte count mismatch");
      if (typeof item.digest === "string" && hash(bytes) !== item.digest) throw new Error("digest mismatch");
      const output = join(target, "resources", relativePath); mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); atomicWrite(output, bytes);
      readable.push(relativePath);
    } catch (error) { rejected.push({ path: name || "(missing path)", reason: error instanceof Error ? error.message : String(error) }); }
  }
  atomicWrite(join(target, "historical-context.json"), Buffer.from(`${stableJson({ authoritative: false, incomplete: true, legacyVersion: 1, source, readable, rejected })}\n`));
  chmodTreeOwnerOnly(target);
  return { directory: target, readable, rejected };
}

export function compareQaRecoveryReviewedState(packet: QaRecoveryPacket, source: string | FrozenQaSourceState): { matches: boolean; originalDigest: string; currentDigest: string; drift: string[]; frozenState: FrozenQaSourceState } {
  const current = typeof source === "string" ? captureFrozenQaSource(source) : source;
  const originalInventory = sourceInventory(packet, currentReviewedStatePrefix(packet));
  const currentInventory = inventoryFromFrozen(current);
  const drift = deterministicDrift(originalInventory, currentInventory);
  return {
    matches: current.digest === packet.manifest.currentReviewedStateDigest,
    originalDigest: packet.manifest.currentReviewedStateDigest,
    currentDigest: current.digest,
    drift,
    frozenState: current,
  };
}

function currentReviewedStatePrefix(packet: QaRecoveryPacket): string {
  const matches = packet.manifest.resources.filter((resource) => resource.path.endsWith("/integrity.json") && resource.objectPath).filter((resource) => {
    try {
      const declared = JSON.parse(readFileSync(join(packet.directory, resource.objectPath!), "utf8")) as { digest?: unknown };
      return declared.digest === packet.manifest.currentReviewedStateDigest;
    } catch { return false; }
  });
  const selected = matches.at(-1);
  if (!selected) throw new Error("current reviewed-state inventory is missing");
  return selected.path.slice(0, -"/integrity.json".length);
}

/** Create a unique owner-only V2 packet from the immutable state QA reviewed. */
export function createQaRecoveryPacket(input: QaRecoveryPacketInput): QaRecoveryPacket {
  ensureQaRecoveryExcluded(input.projectDir);
  const frozen = input.frozenState ?? captureFrozenQaSource(input.reviewedWorktree ?? input.projectDir);
  const reviewAttemptId = input.reviewAttemptId ?? randomUUID();
  const root = containedRecoveryDirectory(input.projectDir, input.runId, input.ticketId, reviewAttemptId);
  if (existsSync(root)) {
    assertPrivatePath(root, true);
    const db = new WorkflowDb(input.projectDir);
    let durableProjections: ReturnType<WorkflowDb["qaPacketProjectionsAtPath"]>;
    try { durableProjections = db.qaPacketProjectionsAtPath(root); }
    finally { db.close(); }
    if (durableProjections.length > 0) {
      throw new Error(`QA recovery packet directory has a durable publication record and must be reconciled, not replaced: ${root}`);
    }
    const manifests = join(root, "manifests");
    if (existsSync(join(root, "manifest.json")) || (existsSync(manifests) && readdirSync(manifests).some((name) => name.endsWith(".json")))) {
      throw new Error(`QA recovery packet directory already exists with published content: ${root}`);
    }
    // A crash before publication intent may leave only staged objects. Keep
    // those bytes for forensics, but move them out of the deterministic retry
    // path so the same durable review attempt can be packetized safely.
    const abandoned = `${root}.abandoned-${randomUUID()}`;
    renameSync(root, abandoned);
    fsyncDirectory(dirname(root));
  }
  durableMkdir(root);
  chmodRecoveryDirectoryChain(input.projectDir, root);
  durableMkdir(join(root, "objects"));
  durableMkdir(join(root, "manifests"));
  const resources: QaRecoveryResourceV2[] = [];
  for (const [name, resource] of Object.entries(input.resources)) {
    const path = join("context", `${safeSlug(name)}.${resource.exactText ? "txt" : "json"}`).replaceAll("\\", "/");
    const bytes = encodeValue(resource.value, Boolean(resource.exactText));
    resources.push(storeSealed(root, path, bytes, resource.purpose, resource.mediaType ?? (resource.exactText ? "text/plain" : "application/json"), resource.requiredForRecovery ?? true));
  }
  resources.push(...storeFrozenState(root, frozen, "reviewed-state/original"));
  if (input.reportJson !== undefined) resources.push(writeEditableReport(root, Buffer.from(input.reportJson)));
  const now = new Date().toISOString();
  const draft: Omit<QaRecoveryManifestV2, "packetDigest"> = {
    version: 2,
    packetId: randomUUID(),
    revision: 1,
    runId: input.runId,
    ticketId: input.ticketId,
    cycle: input.cycle,
    reviewAttempt: input.reviewAttempt,
    reviewAttemptId,
    attempt: input.attempt ?? input.reviewAttempt,
    recoveryStage: input.recoveryStage,
    correctionTurns: input.correctionTurns ?? 0,
    pendingAction: input.pendingAction ?? "automatic-recovery",
    originalReviewedStateDigest: frozen.digest,
    currentReviewedStateDigest: frozen.digest,
    reviewedStateDigest: frozen.digest,
    createdAt: now,
    updatedAt: now,
    resources: resources.sort(resourceOrder),
  };
  return publish(root, resolve(input.projectDir), draft);
}

/**
 * Finish a packet publication whose immutable files reached disk before the
 * authoritative SQLite head was advanced. This is deliberately explicit:
 * ordinary packet loading remains a read-only integrity check.
 */
export function reconcileQaRecoveryPacketPublication(packet: QaRecoveryPacket): QaRecoveryPacket {
  const loaded = loadQaRecoveryPacket(packet.directory);
  const db = new WorkflowDb(loaded.projectDir);
  try {
    const projection = db.qaPacketProjection(loaded.manifest.packetDigest);
    if (!projection || resolve(projection.path) !== loaded.directory || projection.runId !== loaded.manifest.runId
      || projection.ticketId !== loaded.manifest.ticketId || projection.packetRevision !== loaded.manifest.revision) {
      throw new Error("QA recovery packet has no matching durable publication intent");
    }
    const head = db.qaRecoveryHead(loaded.manifest.runId, loaded.manifest.ticketId);
    if (head?.packetDigest === loaded.manifest.packetDigest && head.revision === loaded.manifest.revision) {
      if (projection.status === "intended") db.finishQaPacketProjection(loaded.manifest.runId, loaded.manifest.ticketId, loaded.manifest.packetDigest);
      return loaded;
    }
    if (projection.status !== "intended") throw new Error("published QA recovery projection disagrees with its durable recovery head");
    if (head) {
      if (head.packetId !== loaded.manifest.packetId || loaded.manifest.revision !== head.revision + 1
        || loaded.manifest.parentPacketDigest !== head.packetDigest) {
        throw new Error("QA recovery packet cannot be reconciled across a non-contiguous durable head");
      }
    } else if (loaded.manifest.revision !== 1 || loaded.manifest.parentPacketDigest !== undefined) {
      throw new Error("initial QA recovery packet publication is not revision one");
    }
  } finally { db.close(); }
  persistPendingState(loaded);
  const completed = new WorkflowDb(loaded.projectDir);
  try { completed.finishQaPacketProjection(loaded.manifest.runId, loaded.manifest.ticketId, loaded.manifest.packetDigest); }
  finally { completed.close(); }
  return loaded;
}

/** Recover only packet files named by an existing SQLite publication intent. */
export function recoverPendingQaRecoveryPublications(projectDir: string, runId: string): QaRecoveryPacket[] {
  const root = realpathSync(resolve(projectDir));
  const db = new WorkflowDb(root);
  let pending: ReturnType<WorkflowDb["pendingQaPacketProjections"]>;
  try { pending = db.pendingQaPacketProjections(runId); }
  finally { db.close(); }
  const recovered: QaRecoveryPacket[] = [];
  for (const projection of pending) {
    const directory = resolve(projection.path);
    if (!directory.startsWith(`${root}${sep}`)) throw new Error("QA packet publication intent escapes the project root");
    assertPublicationTree(root, directory);
    const manifestPath = join(directory, "manifest.json");
    if (!existsSync(manifestPath)) {
      restoreIntendedRevision(directory, projection);
      promoteIntendedRevision(directory, projection.packetRevision, projection.packetDigest);
    } else {
      const current = loadQaRecoveryPacket(directory);
      if (current.manifest.packetDigest !== projection.packetDigest) {
        if (projection.packetRevision !== current.manifest.revision + 1) throw new Error("pending QA packet revision is not contiguous with its current manifest");
        restoreIntendedRevision(directory, projection, current.manifest);
        promoteIntendedRevision(directory, projection.packetRevision, projection.packetDigest, current.manifest);
      }
    }
    recovered.push(reconcileQaRecoveryPacketPublication(loadQaRecoveryPacket(directory)));
  }
  // A new review is committed after its frozen source/intent reaches the
  // packet, and before the packet's review identity advances. Reconcile only
  // that exact, still-undispatched allocation; never infer a successor merely
  // because its review number is adjacent.
  const reviewDb = new WorkflowDb(root);
  try {
    for (const pendingHead of reviewDb.pendingQaRecoveryHeads(runId)) {
      const head = reviewDb.qaTicketHead(runId, pendingHead.ticketId);
      if (head.state !== "review-ready") continue;
      const packet = loadQaRecoveryPacket(pendingHead.packetPath);
      if (head.reviewNumber !== packet.manifest.reviewAttempt + 1 || head.sourceStateDigest !== packet.manifest.reviewedStateDigest) continue;
      const attempt = reviewDb.qaReviewAttempts(runId, pendingHead.ticketId).find((item) => item.reviewNumber === head.reviewNumber);
      if (!attempt || attempt.status !== "started" || attempt.sourceDigest !== head.sourceStateDigest) continue;
      const resource = packet.manifest.resources.find((item) => item.path === `review-transitions/${attempt.attemptId}.json`);
      if (!resource?.objectPath || resource.integrityPolicy !== "sealed") continue;
      const intent = JSON.parse(readFileSync(join(packet.directory, resource.objectPath), "utf8")) as Record<string, unknown>;
      if (intent.runId !== runId || intent.ticketId !== pendingHead.ticketId
        || intent.predecessorReviewNumber !== packet.manifest.reviewAttempt || intent.predecessorAttemptId !== packet.manifest.reviewAttemptId
        || intent.reviewNumber !== head.reviewNumber || intent.reviewAttemptId !== attempt.attemptId
        || intent.sourceStateDigest !== head.sourceStateDigest || intent.cycle !== attempt.cycle) {
        throw new Error("QA packet next-review intent does not match its committed successor");
      }
      recovered.push(updateQaRecoveryReviewIdentity(packet, head.reviewNumber, attempt.attemptId, attempt.cycle));
    }
  } finally { reviewDb.close(); }
  // A pass/waiver is committed in SQLite before the derived packet projection
  // is marked resolved. Complete that one-way projection after a crash so a
  // terminal QA decision can never leave a resumable packet behind.
  const terminalDb = new WorkflowDb(root);
  let terminalPackets: Array<{ packetPath: string; correctionTurns: number }> = [];
  try {
    terminalPackets = terminalDb.pendingQaRecoveryHeads(runId)
      .filter((head) => ["passed", "waived", "finalizing", "completed"].includes(terminalDb.qaTicketHead(runId, head.ticketId).state))
      .map((head) => ({ packetPath: head.packetPath, correctionTurns: head.correctionTurns }));
  } finally { terminalDb.close(); }
  for (const terminal of terminalPackets) {
    const resolved = updateQaRecoveryPosition(loadQaRecoveryPacket(terminal.packetPath), "resolved", terminal.correctionTurns, "resolved");
    recovered.push(resolved);
  }
  return recovered;
}

export function appendQaRecoveryResource(packet: QaRecoveryPacket, relativePath: string, value: string | Buffer | unknown, options: { purpose: string; mediaType?: string; requiredForRecovery?: boolean; exact?: boolean }): QaRecoveryPacket {
  const requested = safeRelative(relativePath);
  const bytes = Buffer.isBuffer(value) ? value : encodeValue(value, Boolean(options.exact));
  const mediaType = options.mediaType ?? (options.exact ? "text/plain" : "application/json");
  const requiredForRecovery = options.requiredForRecovery ?? true;
  const interruptedPath = join(packet.directory, "manifests", revisionName(packet.manifest.revision + 1));
  if (existsSync(interruptedPath)) {
    const candidate = readAndValidateRevision(packet.directory, packet.manifest.revision + 1, packet.manifest);
    const added = candidate.resources.filter((resource) => !packet.manifest.resources.some((prior) => prior.path === resource.path));
    const resource = added.length === 1 ? added[0] : undefined;
    if (!resource || resource.path !== requested || resource.digest !== hash(bytes) || resource.bytes !== bytes.length
      || resource.purpose !== options.purpose || resource.mediaType !== mediaType || resource.requiredForRecovery !== requiredForRecovery) {
      throw new Error(`QA recovery revision already exists with different content: ${candidate.revision}`);
    }
    return recoverInterruptedRevision(packet, { resources: candidate.resources })!;
  }
  const path = uniqueResourcePath(packet.manifest.resources, requested, packet.directory);
  const resource = storeSealed(packet.directory, path, bytes, options.purpose, mediaType, requiredForRecovery);
  return revise(packet, { resources: [...packet.manifest.resources, resource].sort(resourceOrder) });
}

export function appendQaRecoveryReviewedState(packet: QaRecoveryPacket, source: string | FrozenQaSourceState, prefix = "current-state"): QaRecoveryPacket {
  const frozen = typeof source === "string" ? captureFrozenQaSource(source) : source;
  const safePrefix = safeRelative(prefix);
  const resources = [...packet.manifest.resources, ...storeFrozenState(packet.directory, frozen, safePrefix)].sort(resourceOrder);
  return revise(packet, {
    resources,
    currentReviewedStateDigest: frozen.digest,
    reviewedStateDigest: frozen.digest,
  });
}

export function updateQaRecoveryPosition(packet: QaRecoveryPacket, stage: string, correctionTurns: number, pendingAction: QaRecoveryPendingAction = "automatic-recovery"): QaRecoveryPacket {
  return revise(packet, { recoveryStage: stage, correctionTurns, pendingAction });
}

export function updateQaRecoveryReviewIdentity(packet: QaRecoveryPacket, reviewAttempt: number, reviewAttemptId: string, cycle = packet.manifest.cycle): QaRecoveryPacket {
  if (!Number.isSafeInteger(reviewAttempt) || reviewAttempt < 1 || !reviewAttemptId) throw new Error("invalid QA recovery review identity");
  return revise(packet, { reviewAttempt, attempt: reviewAttempt, reviewAttemptId, cycle });
}

/** Keep one unresolved packet and append the next malformed review's exact evidence. */
export function appendQaRecoveryAttempt(packet: QaRecoveryPacket, input: QaRecoveryPacketInput): QaRecoveryPacket {
  if (packet.manifest.runId !== input.runId || packet.manifest.ticketId !== input.ticketId
    || packet.manifest.reviewAttempt !== input.reviewAttempt || packet.manifest.reviewAttemptId !== input.reviewAttemptId
    || !input.frozenState || packet.manifest.reviewedStateDigest !== input.frozenState.digest) {
    throw new Error("QA recovery attempt does not match the active packet review/source identity");
  }
  let next = packet;
  for (const [name, resource] of Object.entries(input.resources)) {
    const path = `reviews/r${input.reviewAttempt}/context/${safeSlug(name)}.${resource.exactText ? "txt" : "json"}`;
    next = appendQaRecoveryResource(next, path, resource.value, {
      purpose: resource.purpose, mediaType: resource.mediaType, requiredForRecovery: resource.requiredForRecovery,
      exact: Boolean(resource.exactText),
    });
  }
  if (input.reportJson !== undefined) {
    const report = writeEditableReport(packet.directory, Buffer.from(input.reportJson));
    next = revise(next, { resources: [...next.manifest.resources.filter((resource) => resource.path !== "report.json"), report].sort(resourceOrder) });
  }
  return revise(next, { cycle: input.cycle, recoveryStage: input.recoveryStage,
    correctionTurns: input.correctionTurns ?? 0, pendingAction: input.pendingAction ?? "automatic-recovery" });
}

export function readManualQaReport(packetDirectory: string): unknown { return JSON.parse(readFileSync(join(resolve(packetDirectory), "report.json"), "utf8")) as unknown; }

export function validateManualQaReport(packet: QaRecoveryPacket): { packet: QaRecoveryPacket; report?: QaFailureReportV1; errors: string[] } {
  const path = join(packet.directory, "report.json");
  const raw = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  const parsed = parseQaFailureReport(raw.toString());
  let next = appendQaRecoveryResource(packet, `validation/manual-repair-r${packet.manifest.revision + 1}.json`, parsed.validation, { purpose: "Validation result for the latest operator-edited report.json" });
  const editable = writeEditableReport(packet.directory, raw);
  next = revise(next, { resources: next.manifest.resources.filter((resource) => resource.path !== "report.json").concat(editable).sort(resourceOrder) });
  if (parsed.report) {
    next = appendQaRecoveryResource(next, `accepted-reports/report-r${next.manifest.revision + 1}.json`, raw, {
      purpose: "Exact operator-edited report accepted by schema validation", mediaType: "application/json", exact: true,
    });
    next = updateQaRecoveryPosition(next, "manual-report-accepted", next.manifest.correctionTurns, "validated-report");
  }
  return { packet: next, report: parsed.report, errors: parsed.validation.errors };
}

/** Copy one exact sealed revision into a fresh snapshot and return a mutation seal. */
export function materializeQaRecoveryContext(packet: QaRecoveryPacket, qaWorktree: string): { path: string; relativePath: string; digest: string; verify(): void } {
  const loaded = loadQaRecoveryPacket(packet.directory);
  if (loaded.manifest.packetDigest !== packet.manifest.packetDigest) throw new Error("cannot materialize a stale QA recovery packet revision");
  ensureQaRecoveryExcluded(qaWorktree);
  const relativePath = join(QA_CONTEXT_ROOT, `${packet.manifest.packetId}-r${packet.manifest.revision}`);
  const target = join(resolve(qaWorktree), relativePath);
  assertNoSymlinkComponents(resolve(qaWorktree), dirname(target));
  if (existsSync(target)) throw new Error(`QA recovery context already exists: ${target}`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  cpSync(packet.directory, target, { recursive: true, dereference: false, preserveTimestamps: true });
  chmodTreeOwnerOnly(target);
  const digest = digestTree(target);
  return { path: target, relativePath, digest, verify: () => {
    const after = digestTree(target);
    if (after !== digest) throw new Error(`QA recovery context mutation detected: expected ${digest}, got ${after}`);
  } };
}

export function renderQaRecoveryAcknowledgementInstruction(packet: QaRecoveryPacket, relativePath: string): string {
  const required = packet.manifest.resources.filter((resource) => resource.requiredForRecovery).map((resource) =>
    `- path=${resource.path} purpose=${JSON.stringify(resource.purpose)} media_type=${resource.mediaType} bytes=${resource.bytes} digest=${resource.digest}`).join("\n");
  return [
    "Read and verify every required recovery resource in this exact sealed packet revision before replying.",
    `Recovery context directory: ${relativePath}`,
    `Packet ID: ${packet.manifest.packetId}`,
    `Packet revision: ${packet.manifest.revision}`,
    `Packet digest: ${packet.manifest.packetDigest}`,
    `Reviewed-state digest: ${packet.manifest.reviewedStateDigest}`,
    "Required resources:", required,
    "Reply with exactly the following acknowledgement line, followed by the required RAFI_CONTINUITY_DELTA record:",
    `RAFI_QA_RECOVERY_ACK packet="${packet.manifest.packetDigest}" reviewed_state="${packet.manifest.reviewedStateDigest}" required_resources_read="all"`,
  ].join("\n");
}

export function validateQaRecoveryAcknowledgement(text: string, packet: QaRecoveryPacket, options: { continuityAlreadyValidated?: boolean } = {}): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const expected = `RAFI_QA_RECOVERY_ACK packet="${packet.manifest.packetDigest}" reviewed_state="${packet.manifest.reviewedStateDigest}" required_resources_read="all"`;
  const errors: string[] = [];
  if (lines[0] !== expected) errors.push("missing or malformed exact recovery-packet acknowledgement");
  if (options.continuityAlreadyValidated) {
    if (lines.length !== 1) errors.push("recovery acknowledgement must not contain additional text");
  } else if (lines.length !== 2 || !/^RAFI_CONTINUITY_DELTA(?:\s|$)/.test(lines[1] ?? "")) errors.push("exactly one continuity record must follow the recovery acknowledgement");
  return errors;
}

export function qaRecoveryInventory(packet: QaRecoveryPacket): string {
  return packet.manifest.resources.map((resource) => `${resource.path}\t${resource.purpose}\t${resource.mediaType}\t${resource.bytes}\t${resource.digest}\t${resource.integrityPolicy}`).join("\n");
}

export function qaReportDigest(report: QaFailureReportV1): string { return hash(Buffer.from(canonicalJson(report))); }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function ensureQaRecoveryExcluded(projectDir: string): void {
  let exclude: string;
  let common: string;
  try {
    exclude = execFileSync("git", ["-C", resolve(projectDir), "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
    common = execFileSync("git", ["-C", resolve(projectDir), "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  } catch { return; }
  exclude = resolve(exclude); common = resolve(common);
  if (exclude !== common && !exclude.startsWith(`${common}${sep}`)) throw new Error(`git exclude path escapes the target repository: ${exclude}`);
  const entries = [`/${QA_RECOVERY_ROOT}/`, `/${QA_CONTEXT_ROOT}/`];
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const missing = entries.filter((entry) => !current.split(/\r?\n/).includes(entry));
  if (!missing.length) return;
  mkdirSync(dirname(exclude), { recursive: true });
  atomicWrite(exclude, Buffer.from(`${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`), 0o600);
}

function storeFrozenState(root: string, state: FrozenQaSourceState, prefix: string): QaRecoveryResourceV2[] {
  const inventory = state.untracked.map(({ path, kind, mode, digest }, index) => ({ path, kind, mode, digest, stored: `${prefix}/untracked/${String(index).padStart(6, "0")}.bin` }));
  const values: Array<[string, Buffer, string, string]> = [
    [`${prefix}/head.txt`, Buffer.from(`${state.head}\n`), "text/plain", "Base HEAD for the immutable reviewed state"],
    [`${prefix}/status.bin`, state.status, "application/octet-stream", "Exact porcelain-v2 source status"],
    [`${prefix}/tracked-head.diff`, state.combinedDiff, "application/octet-stream", "Exact combined tracked binary diff against HEAD"],
    [`${prefix}/staged.diff`, state.stagedDiff, "application/octet-stream", "Exact staged tracked binary diff"],
    [`${prefix}/unstaged.diff`, state.unstagedDiff, "application/octet-stream", "Exact unstaged tracked binary diff"],
    [`${prefix}/change-summary.txt`, Buffer.from(`${state.changeSummary}\n`), "text/plain", "Deterministic path-level source summary"],
    [`${prefix}/path-inventory.json`, Buffer.from(`${stableJson(state.pathInventory)}\n`), "application/json", "Structured staged, unstaged, and untracked source paths"],
    [`${prefix}/repository.json`, Buffer.from(`${stableJson(state.repository)}\n`), "application/json", "Repository identity, refs, configuration, sparse-checkout, submodule, and index metadata"],
    [`${prefix}/integrity.json`, Buffer.from(`${stableJson({ digest: state.digest, originDigest: state.originDigest, contentDigest: state.contentDigest, capturedAt: state.capturedAt })}\n`), "application/json", "Reviewed-state integrity manifest"],
    [`${prefix}/untracked-manifest.json`, Buffer.from(`${stableJson(inventory)}\n`), "application/json", "Untracked path, type, mode, digest, and object mapping"],
  ];
  state.untracked.forEach((item, index) => values.push([`${prefix}/untracked/${String(index).padStart(6, "0")}.bin`, item.bytes, "application/octet-stream", `Exact untracked ${item.kind} bytes for ${item.path}`]));
  return values.map(([path, bytes, mediaType, purpose]) => storeSealed(root, safeRelative(path), bytes, purpose, mediaType, true));
}

function sourceInventory(packet: QaRecoveryPacket, prefix: string): Map<string, string> {
  const rows = new Map<string, string>();
  const head = packet.manifest.resources.find((candidate) => candidate.path === `${prefix}/head.txt`);
  if (head) rows.set("HEAD", head.digest);
  const resource = packet.manifest.resources.find((candidate) => candidate.path === `${prefix}/path-inventory.json`);
  if (resource?.objectPath) for (const item of JSON.parse(readFileSync(join(packet.directory, resource.objectPath), "utf8")) as QaSourcePathState[]) rows.set(item.path, stableJson(item));
  return rows;
}

function inventoryFromFrozen(state: FrozenQaSourceState): Map<string, string> {
  const rows = new Map<string, string>([["HEAD", hash(Buffer.from(`${state.head}\n`))]]);
  for (const item of state.pathInventory) rows.set(item.path, stableJson(item));
  return rows;
}

function deterministicDrift(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().filter((key) => before.get(key) !== after.get(key));
}

function storeSealed(root: string, path: string, bytes: Buffer, purpose: string, mediaType: string, requiredForRecovery: boolean): QaRecoveryResourceV2 {
  const digest = hash(bytes); const objectPath = `objects/${digest}`;
  // SQLite is authoritative. Persist the exact bytes before writing either
  // the content-addressed cache object or its human-readable projection.
  const evidenceDb = new WorkflowDb(recoveryProjectRoot(root));
  try {
    const durableDigest = evidenceDb.putEvidence("qa", bytes);
    if (durableDigest !== digest) throw new Error(`durable QA resource digest mismatch: ${path}`);
  } finally { evidenceDb.close(); }
  const absolute = join(root, objectPath);
  if (!existsSync(absolute)) atomicWrite(absolute, bytes);
  else if (hash(readFileSync(absolute)) !== digest) throw new Error(`content-addressed QA recovery object collision: ${digest}`);
  const projection = join(root, path);
  if (existsSync(projection)) {
    const existing = readFileSync(projection);
    if (existing.length !== bytes.length || hash(existing) !== digest) throw new Error(`QA recovery resource path already exists with different content: ${path}`);
  } else atomicWrite(projection, bytes);
  return { path, purpose, mediaType, bytes: bytes.length, digest, requiredForRecovery, integrityPolicy: "sealed", objectPath };
}

function writeEditableReport(root: string, bytes: Buffer): QaRecoveryResourceV2 {
  atomicWrite(join(root, "report.json"), bytes);
  return { path: "report.json", purpose: "Operator-editable QA failure report", mediaType: "application/json", bytes: bytes.length, digest: hash(bytes), requiredForRecovery: false, integrityPolicy: "operator_editable" };
}

function validateResource(root: string, resource: QaRecoveryResourceV2): void {
  safeRelative(resource.path);
  if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || !/^[a-f0-9]{64}$/.test(resource.digest)) throw new Error(`invalid QA recovery resource metadata: ${resource.path}`);
  if (resource.integrityPolicy === "operator_editable") {
    if (resource.path !== "report.json") throw new Error(`only report.json may be operator editable: ${resource.path}`);
    const path = join(root, "report.json");
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error("missing or unsafe operator-editable report.json");
    assertPrivatePath(path, false);
    return;
  }
  if (resource.integrityPolicy !== "sealed" || !resource.objectPath) throw new Error(`invalid integrity policy for ${resource.path}`);
  const objectPath = resolve(root, safeRelative(resource.objectPath));
  if (!objectPath.startsWith(`${root}${sep}`) || !existsSync(objectPath)) throw new Error(`missing or unsafe QA recovery object: ${resource.path}`);
  assertNoSymlinkComponents(root, objectPath);
  assertPrivatePath(objectPath, false);
  const bytes = readFileSync(objectPath);
  if (bytes.length !== resource.bytes || hash(bytes) !== resource.digest) throw new Error(`QA recovery resource digest mismatch: ${resource.path}`);
  const projection = resolve(root, resource.path);
  if (!projection.startsWith(`${root}${sep}`) || !existsSync(projection)) throw new Error(`missing QA recovery resource projection: ${resource.path}`);
  assertNoSymlinkComponents(root, projection);
  assertPrivatePath(projection, false);
  const projected = readFileSync(projection);
  if (projected.length !== resource.bytes || hash(projected) !== resource.digest) throw new Error(`QA recovery resource projection mismatch: ${resource.path}`);
}

function validateReviewedStates(root: string, manifest: QaRecoveryManifestV2): void {
  const prefixes = manifest.resources
    .map((resource) => resource.path.endsWith("/integrity.json") ? resource.path.slice(0, -"/integrity.json".length) : undefined)
    .filter((prefix): prefix is string => Boolean(prefix?.startsWith("reviewed-state/")));
  if (!prefixes.includes("reviewed-state/original")) throw new Error("QA recovery packet is missing its original reviewed-state core resources");
  const digests = new Map(prefixes.map((prefix) => [prefix, validateReviewedState(root, manifest, prefix)]));
  if (digests.get("reviewed-state/original") !== manifest.originalReviewedStateDigest) throw new Error("QA recovery original reviewed-state digest mismatch");
  if (![...digests.values()].includes(manifest.currentReviewedStateDigest) || manifest.reviewedStateDigest !== manifest.currentReviewedStateDigest) {
    throw new Error("QA recovery current reviewed-state digest mismatch");
  }
}

function validateReviewedState(root: string, manifest: QaRecoveryManifestV2, prefix: string): string {
  const required = ["head.txt", "status.bin", "tracked-head.diff", "staged.diff", "unstaged.diff", "change-summary.txt", "path-inventory.json", "repository.json", "integrity.json", "untracked-manifest.json"];
  const byPath = new Map(manifest.resources.map((resource) => [resource.path, resource]));
  const bytes = (suffix: string): Buffer => {
    const resource = byPath.get(`${prefix}/${suffix}`);
    if (!resource || resource.integrityPolicy !== "sealed" || !resource.objectPath) throw new Error(`QA recovery packet is missing reviewed-state core resource: ${prefix}/${suffix}`);
    return readFileSync(join(root, resource.objectPath));
  };
  for (const suffix of required) bytes(suffix);
  const inventory = JSON.parse(bytes("untracked-manifest.json").toString()) as Array<{ path?: unknown; kind?: unknown; mode?: unknown; digest?: unknown; stored?: unknown }>;
  if (!Array.isArray(inventory)) throw new Error(`invalid reviewed-state untracked inventory: ${prefix}`);
  const untracked: QaUntrackedCapture[] = inventory.map((item) => {
    const mode = Number(item.mode);
    if (typeof item.path !== "string" || (item.kind !== "file" && item.kind !== "symlink") || !Number.isInteger(mode) || typeof item.digest !== "string" || typeof item.stored !== "string") throw new Error(`invalid reviewed-state untracked entry: ${prefix}`);
    const resource = byPath.get(item.stored);
    if (!resource || resource.integrityPolicy !== "sealed" || !resource.objectPath) throw new Error(`missing reviewed-state untracked bytes: ${item.path}`);
    const value = readFileSync(join(root, resource.objectPath));
    if (hash(value) !== item.digest) throw new Error(`reviewed-state untracked digest mismatch: ${item.path}`);
    return { path: item.path, kind: item.kind, mode, digest: item.digest, bytes: value };
  });
  const declared = JSON.parse(bytes("integrity.json").toString()) as { digest?: unknown; originDigest?: unknown; contentDigest?: unknown };
  const repository = JSON.parse(bytes("repository.json").toString()) as FrozenQaSourceState["repository"];
  const pathInventory = JSON.parse(bytes("path-inventory.json").toString()) as QaSourcePathState[];
  if (!Array.isArray(pathInventory) || pathInventory.some((item) => !item || typeof item.path !== "string" || !Array.isArray(item.staged) || !Array.isArray(item.unstaged))) throw new Error(`invalid reviewed-state path inventory: ${prefix}`);
  const state = {
    head: bytes("head.txt").toString().trimEnd(),
    status: bytes("status.bin"),
    combinedDiff: bytes("tracked-head.diff"),
    stagedDiff: bytes("staged.diff"),
    unstagedDiff: bytes("unstaged.diff"),
    changeSummary: bytes("change-summary.txt").toString().replace(/\n$/, ""),
    pathInventory,
    untracked,
    repository,
    originDigest: String(declared.originDigest ?? ""),
    contentDigest: String(declared.contentDigest ?? ""),
  };
  const digest = calculateFrozenQaStateDigest(state);
  if (declared.digest !== digest) throw new Error(`reviewed-state integrity digest mismatch: ${prefix}`);
  return digest;
}

function revise(packet: QaRecoveryPacket, changes: Partial<Omit<QaRecoveryManifestV2, "version" | "packetId" | "packetDigest" | "revision" | "parentPacketDigest" | "createdAt" | "updatedAt">>): QaRecoveryPacket {
  const current = loadQaRecoveryPacket(packet.directory);
  if (current.manifest.packetDigest !== packet.manifest.packetDigest) throw new Error("stale QA recovery packet revision cannot be appended");
  const interrupted = recoverInterruptedRevision(current, changes);
  if (interrupted) return interrupted;
  const { packetDigest: _digest, ...base } = current.manifest;
  const draft = {
    ...base, ...changes,
    revision: current.manifest.revision + 1,
    parentPacketDigest: current.manifest.packetDigest,
    updatedAt: new Date().toISOString(),
  };
  return publish(packet.directory, packet.projectDir, draft);
}

function recoverInterruptedRevision(packet: QaRecoveryPacket, changes: Partial<Omit<QaRecoveryManifestV2, "version" | "packetId" | "packetDigest" | "revision" | "parentPacketDigest" | "createdAt" | "updatedAt">>): QaRecoveryPacket | undefined {
  const revision = packet.manifest.revision + 1;
  const path = join(packet.directory, "manifests", revisionName(revision));
  if (!existsSync(path)) return undefined;
  const candidate = readAndValidateRevision(packet.directory, revision, packet.manifest);
  const { packetDigest: _currentDigest, updatedAt: _currentUpdated, ...currentBase } = packet.manifest;
  const { packetDigest: _candidateDigest, updatedAt: _candidateUpdated, ...candidateBase } = candidate;
  const expected = { ...currentBase, ...changes, revision, parentPacketDigest: packet.manifest.packetDigest };
  if (stableJson(candidateBase) !== stableJson(expected)) throw new Error(`QA recovery revision already exists with different content: ${revision}`);
  promoteIntendedRevision(packet.directory, revision, candidate.packetDigest, packet.manifest);
  return reconcileQaRecoveryPacketPublication(loadQaRecoveryPacket(packet.directory));
}

function promoteIntendedRevision(root: string, revision: number, expectedDigest: string, parent?: QaRecoveryManifestV2): void {
  assertPublicationTree(recoveryProjectRoot(root), root);
  const candidate = readAndValidateRevision(root, revision, parent);
  if (candidate.packetDigest !== expectedDigest) throw new Error("QA recovery revision does not match its durable publication intent");
  const projectDir = recoveryProjectRoot(root);
  const db = new WorkflowDb(projectDir);
  try {
    const projection = db.qaPacketProjection(expectedDigest);
    if (!projection || projection.status !== "intended" || resolve(projection.path) !== resolve(root)
      || projection.runId !== candidate.runId || projection.ticketId !== candidate.ticketId || projection.packetRevision !== revision) {
      throw new Error("QA recovery revision promotion lacks a matching durable publication intent");
    }
  } finally { db.close(); }
  atomicWrite(join(root, "manifest.json"), readFileSync(join(root, "manifests", revisionName(revision))));
  chmodTreeOwnerOnly(root);
}

/** Recreate a revision that was durably intended in SQLite but not yet fsynced to the packet tree. */
function restoreIntendedRevision(root: string, projection: import("./workflowDb.js").QaPacketProjectionRecord, parent?: QaRecoveryManifestV2): void {
  assertPublicationTree(recoveryProjectRoot(root), root);
  const path = join(root, "manifests", revisionName(projection.packetRevision));
  if (existsSync(path)) return;
  if (!projection.manifestJson) throw new Error("QA packet publication intent does not contain recoverable manifest bytes");
  const candidate = JSON.parse(projection.manifestJson) as QaRecoveryManifestV1 | QaRecoveryManifestV2;
  assertManifestShape(candidate);
  if (candidate.packetDigest !== projection.packetDigest || candidate.revision !== projection.packetRevision
    || candidate.runId !== projection.runId || candidate.ticketId !== projection.ticketId
    || (parent ? candidate.packetId !== parent.packetId || candidate.parentPacketDigest !== parent.packetDigest
      : candidate.revision !== 1 || candidate.parentPacketDigest !== undefined)) {
    throw new Error("QA packet publication intent contains mismatched manifest bytes");
  }
  for (const resource of candidate.resources) validateResource(root, resource);
  validateReviewedStates(root, candidate);
  if (calculatePacketDigest(root, candidate) !== candidate.packetDigest) throw new Error("QA packet publication intent manifest digest mismatch");
  atomicWrite(path, Buffer.from(projection.manifestJson));
}

function readAndValidateRevision(root: string, revision: number, parent?: QaRecoveryManifestV2): QaRecoveryManifestV2 {
  assertPrivateTree(root);
  const path = join(root, "manifests", revisionName(revision));
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error(`QA recovery revision ${revision} is missing or unsafe`);
  const candidate = JSON.parse(readFileSync(path, "utf8")) as QaRecoveryManifestV1 | QaRecoveryManifestV2;
  assertManifestShape(candidate);
  if (candidate.revision !== revision || (parent && candidate.packetId !== parent.packetId)
    || (revision === 1 ? candidate.parentPacketDigest !== undefined : candidate.parentPacketDigest !== parent?.packetDigest)) {
    throw new Error(`QA recovery revision lineage mismatch at revision ${revision}`);
  }
  for (const resource of candidate.resources) validateResource(root, resource);
  validateReviewedStates(root, candidate);
  if (calculatePacketDigest(root, candidate) !== candidate.packetDigest) throw new Error(`QA recovery revision digest mismatch at revision ${revision}`);
  return candidate;
}

/** Validate ancestors before crash recovery writes into a persisted path. */
function assertPublicationTree(projectDir: string, directory: string): void {
  const project = realpathSync(resolve(projectDir));
  const root = resolve(directory);
  if (!root.startsWith(`${project}${sep}`) || !existsSync(root) || realpathSync(root) !== root) throw new Error("unsafe or symlinked QA packet publication path");
  assertNoSymlinkComponents(project, root);
  assertPrivateTree(root);
}

function publish(root: string, projectDir: string, draft: Omit<QaRecoveryManifestV2, "packetDigest">): QaRecoveryPacket {
  const manifest = { ...draft, resources: draft.resources.slice().sort(resourceOrder), packetDigest: "" } as QaRecoveryManifestV2;
  manifest.packetDigest = calculatePacketDigest(root, manifest);
  const bytes = Buffer.from(`${stableJson(manifest)}\n`);
  const revisionPath = join(root, "manifests", revisionName(manifest.revision));
  const db = new WorkflowDb(projectDir);
  try { db.planQaPacketProjection({ runId: manifest.runId, ticketId: manifest.ticketId, qaRevision: manifest.revision, packetDigest: manifest.packetDigest, path: root, manifestJson: bytes.toString() }); }
  finally { db.close(); }
  if (existsSync(revisionPath)) {
    if (!readFileSync(revisionPath).equals(bytes)) throw new Error(`QA recovery revision already exists with different content: ${manifest.revision}`);
  } else atomicWrite(revisionPath, bytes);
  atomicWrite(join(root, "manifest.json"), bytes);
  chmodTreeOwnerOnly(root);
  const packet = { directory: root, projectDir, manifest };
  persistPendingState(packet);
  const completed = new WorkflowDb(projectDir);
  try { completed.finishQaPacketProjection(manifest.runId, manifest.ticketId, manifest.packetDigest); }
  finally { completed.close(); }
  return packet;
}

function calculatePacketDigest(root: string, manifest: QaRecoveryManifestV2): string {
  const canonical = { ...manifest, packetDigest: undefined } as Record<string, unknown>;
  delete canonical.packetDigest;
  const h = createHash("sha256").update(stableJson(canonical));
  for (const resource of manifest.resources.filter((item) => item.integrityPolicy === "sealed").sort(resourceOrder)) {
    h.update("\0").update(resource.path).update("\0").update(readFileSync(join(root, resource.objectPath!)));
  }
  return h.digest("hex");
}

function persistPendingState(packet: QaRecoveryPacket): void {
  let db: WorkflowDb | undefined;
  try {
    db = new WorkflowDb(packet.projectDir);
    const run = db.getRun(packet.manifest.runId);
    if (!run) return;
    db.putQaRecoveryHead({
      runId: packet.manifest.runId, ticketId: packet.manifest.ticketId, packetId: packet.manifest.packetId,
      packetPath: packet.directory, packetDigest: packet.manifest.packetDigest, reviewedStateDigest: packet.manifest.reviewedStateDigest,
      revision: packet.manifest.revision, correctionTurns: packet.manifest.correctionTurns, pendingAction: packet.manifest.pendingAction,
    });
    // Compatibility projection only. Readers that make recovery decisions use
    // qa_recovery_heads, so saveBuildRun cannot destroy authoritative state.
    db.transition(packet.manifest.runId, {
      status: run.status, checkpoint: run.checkpoint, remainingWork: run.remainingWork,
      state: { ...run.state, qaReportRecovery: { packetPath: packet.directory, packetDigest: packet.manifest.packetDigest,
        reviewedStateDigest: packet.manifest.reviewedStateDigest, revision: packet.manifest.revision,
        ladderPosition: packet.manifest.correctionTurns, pendingAction: packet.manifest.pendingAction,
        ticketId: packet.manifest.ticketId, packetId: packet.manifest.packetId, retentionProtected: true } },
      event: "qa_recovery_packet_revision", payload: { ticketId: packet.manifest.ticketId, revision: packet.manifest.revision, packetDigest: packet.manifest.packetDigest, pendingAction: packet.manifest.pendingAction },
    });
  } finally { db?.close(); }
}

function assertManifestShape(value: QaRecoveryManifestV1 | QaRecoveryManifestV2): asserts value is QaRecoveryManifestV2 {
  if (value.version !== 2
    || !Array.isArray(value.resources)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.cycle) || value.cycle < 0
    || !Number.isSafeInteger(value.reviewAttempt) || value.reviewAttempt < 0
    || !Number.isSafeInteger(value.correctionTurns) || value.correctionTurns < 0
    || !/^[a-f0-9]{64}$/.test(value.packetDigest)
    || !value.packetId || !value.reviewAttemptId || !value.runId || !value.ticketId
    || !["automatic-recovery", "successor-acknowledgement", "qa-correction", "qa-full-review", "operator-menu", "validated-report", "builder-remediation-pending", "builder-remediation-in-flight", "resolved"].includes(value.pendingAction)
    || !/^[a-f0-9]{64}$/.test(value.originalReviewedStateDigest)
    || !/^[a-f0-9]{64}$/.test(value.currentReviewedStateDigest)
    || !/^[a-f0-9]{64}$/.test(value.reviewedStateDigest)) throw new Error("invalid QA recovery V2 manifest");
}

function containedRecoveryDirectory(projectDir: string, run: string, ticket: string, attemptId: string): string {
  const project = realpathSync(resolve(projectDir)); const base = resolve(project, QA_RECOVERY_ROOT);
  const result = resolve(base, slugWithHash(run), slugWithHash(ticket), slugWithHash(attemptId));
  if (!base.startsWith(`${project}${sep}`) || !result.startsWith(`${base}${sep}`)) throw new Error("unsafe QA recovery packet path");
  assertNoSymlinkComponents(project, result);
  return result;
}

function recoveryProjectRoot(packetRoot: string): string {
  const marker = `${sep}${QA_RECOVERY_ROOT.split("/").join(sep)}${sep}`;
  const index = packetRoot.indexOf(marker);
  return index >= 0 ? packetRoot.slice(0, index) : dirname(packetRoot);
}

function chmodRecoveryDirectoryChain(projectDir: string, target: string): void {
  const project = realpathSync(resolve(projectDir)); const base = resolve(project, QA_RECOVERY_ROOT); let cursor = base;
  for (const part of ["", ...relative(base, target).split(sep).filter(Boolean)]) { if (part) cursor = join(cursor, part); if (existsSync(cursor)) chmodSync(cursor, 0o700); }
}

function uniqueResourcePath(resources: QaRecoveryResourceV2[], requested: string, root?: string): string {
  const occupied = (candidate: string) => resources.some((resource) => resource.path === candidate) || Boolean(root && existsSync(join(root, candidate)));
  if (!occupied(requested)) return requested;
  const dot = requested.lastIndexOf("."); const stem = dot > requested.lastIndexOf("/") ? requested.slice(0, dot) : requested; const extension = dot > requested.lastIndexOf("/") ? requested.slice(dot) : "";
  let sequence = 2; while (occupied(`${stem}.seq-${String(sequence).padStart(4, "0")}${extension}`)) sequence++;
  return `${stem}.seq-${String(sequence).padStart(4, "0")}${extension}`;
}

function safeRelative(path: string): string {
  const clean = path.replace(/\\/g, "/");
  if (!clean || clean.startsWith("/") || clean.split("/").includes("..")) throw new Error(`unsafe recovery resource path: ${path}`);
  return clean;
}

function safeSlug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 64) || "unknown"; }
function slugWithHash(value: string): string { return `${safeSlug(value)}-${hash(Buffer.from(value)).slice(0, 12)}`; }
function revisionName(revision: number): string { return `revision-${String(revision).padStart(8, "0")}.json`; }
function resourceOrder(a: QaRecoveryResourceV2, b: QaRecoveryResourceV2): number { return a.path.localeCompare(b.path); }
function encodeValue(value: unknown, exact: boolean): Buffer { return exact ? Buffer.from(typeof value === "string" ? value : String(value)) : Buffer.from(`${stableJson(value)}\n`); }
function atomicWrite(path: string, bytes: Buffer, mode = 0o600): void {
  const parent = dirname(path);
  durableMkdir(parent);
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temp, bytes, { mode });
  chmodSync(temp, mode);
  const fd = openSync(temp, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  chmodSync(path, mode);
  fsyncDirectory(parent);
}
function durableMkdir(path: string): void {
  const target = resolve(path);
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  let cursor = target;
  fsyncDirectory(cursor);
  while (cursor !== existing) {
    cursor = dirname(cursor);
    fsyncDirectory(cursor);
  }
}
function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, "r"); fsyncSync(fd); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function assertPrivatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`unsafe QA recovery ${directory ? "directory" : "file"}: ${path}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`QA recovery path is not owned by the current operator: ${path}`);
  if (process.platform !== "win32") {
    const expected = directory ? 0o700 : 0o600;
    if ((stat.mode & 0o777) !== expected) throw new Error(`QA recovery path has unsafe permissions: ${path}`);
  }
}
function assertPrivateTree(root: string): void {
  assertPrivatePath(root, true);
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    assertPrivatePath(path, stat.isDirectory());
    if (stat.isDirectory()) assertPrivateTree(path);
  }
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function statOwner(path: string): number { return lstatSync(path).uid; }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
function digestTree(root: string): string { const rows: string[] = []; const visit = (directory: string) => { for (const name of readdirSync(directory).sort()) { const path = join(directory, name); const rel = relative(root, path); const stat = lstatSync(path); if (stat.isDirectory()) visit(path); else { const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path); rows.push(`${rel}\0${stat.mode & 0o7777}\0${hash(bytes)}`); } } }; visit(root); return hash(Buffer.from(rows.join("\n"))); }
function chmodTreeOwnerOnly(root: string): void { for (const name of readdirSync(root)) { const path = join(root, name); const stat = lstatSync(path); if (stat.isDirectory()) { chmodSync(path, 0o700); chmodTreeOwnerOnly(path); } else if (!stat.isSymbolicLink()) chmodSync(path, 0o600); } chmodSync(root, 0o700); }
function assertNoSymlinkComponents(base: string, target: string): void { const root = resolve(base); const absolute = resolve(target); if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error(`path escapes recovery containment: ${target}`); let cursor = root; if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink is not allowed in recovery path: ${cursor}`); for (const part of relative(root, absolute).split(sep).filter(Boolean)) { cursor = join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink is not allowed in recovery path: ${cursor}`); } }
