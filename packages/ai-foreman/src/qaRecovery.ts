import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync,
  realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseQaFailureReport, type QaFailureReportV1 } from "rafi-spec";
import { calculateFrozenQaStateDigest, captureFrozenQaSource, type FrozenQaSourceState, type QaUntrackedCapture } from "./qaSnapshot.js";
import { WorkflowDb } from "./workflowDb.js";

export const QA_RECOVERY_ROOT = ".foreman/qa-report-recovery";
export const QA_CONTEXT_ROOT = ".foreman/qa-recovery-context";

export type QaRecoveryIntegrityPolicy = "sealed" | "operator_editable";

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
  pendingAction: string;
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
  pendingAction?: string;
  resources: Record<string, { value: unknown; purpose: string; mediaType?: string; requiredForRecovery?: boolean; exactText?: boolean }>;
  reportJson?: string;
}

export function loadQaRecoveryPacket(directory: string): QaRecoveryPacket {
  const root = resolve(directory);
  if (!existsSync(root) || realpathSync(root) !== root) throw new Error(`symlink is not allowed in recovery path: ${root}`);
  assertNoSymlinkComponents(root, root);
  let raw = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as QaRecoveryManifestV1 | QaRecoveryManifestV2;
  if (raw.version === 1) throw new LegacyQaRecoveryPacketError(root, raw);
  const publishedRevision = raw.revision;
  raw = recoverInterruptedPublication(root, raw);
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
  const packet = { directory: root, projectDir, manifest: raw };
  if (raw.revision !== publishedRevision) persistPendingState(packet);
  return packet;
}

function recoverInterruptedPublication(root: string, initial: QaRecoveryManifestV2): QaRecoveryManifestV2 {
  let current = initial;
  while (existsSync(join(root, "manifests", revisionName(current.revision + 1)))) {
    const path = join(root, "manifests", revisionName(current.revision + 1));
    const candidate = JSON.parse(readFileSync(path, "utf8")) as QaRecoveryManifestV1 | QaRecoveryManifestV2;
    assertManifestShape(candidate);
    if (candidate.packetId !== current.packetId || candidate.revision !== current.revision + 1 || candidate.parentPacketDigest !== current.packetDigest) {
      throw new Error(`invalid interrupted QA recovery publication at revision ${current.revision + 1}`);
    }
    for (const resource of candidate.resources) validateResource(root, resource);
    validateReviewedStates(root, candidate);
    if (calculatePacketDigest(root, candidate) !== candidate.packetDigest) throw new Error(`invalid interrupted QA recovery digest at revision ${candidate.revision}`);
    // All referenced objects and projections are durable. Completing the one
    // missing atomic pointer replacement is safe and preserves append-only
    // lineage after a process interruption.
    atomicWrite(join(root, "manifest.json"), readFileSync(path));
    current = candidate;
  }
  return current;
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
  const originalInventory = sourceInventory(packet, "reviewed-state/original");
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

/** Create a unique owner-only V2 packet from the immutable state QA reviewed. */
export function createQaRecoveryPacket(input: QaRecoveryPacketInput): QaRecoveryPacket {
  ensureQaRecoveryExcluded(input.projectDir);
  const frozen = input.frozenState ?? captureFrozenQaSource(input.reviewedWorktree ?? input.projectDir);
  const reviewAttemptId = input.reviewAttemptId ?? randomUUID();
  const root = containedRecoveryDirectory(input.projectDir, input.runId, input.ticketId, reviewAttemptId);
  if (existsSync(root)) throw new Error(`QA recovery packet directory already exists: ${root}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodRecoveryDirectoryChain(input.projectDir, root);
  mkdirSync(join(root, "objects"), { mode: 0o700 });
  mkdirSync(join(root, "manifests"), { mode: 0o700 });
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

export function appendQaRecoveryResource(packet: QaRecoveryPacket, relativePath: string, value: string | Buffer | unknown, options: { purpose: string; mediaType?: string; requiredForRecovery?: boolean; exact?: boolean }): QaRecoveryPacket {
  const requested = safeRelative(relativePath);
  const path = uniqueResourcePath(packet.manifest.resources, requested);
  const bytes = Buffer.isBuffer(value) ? value : encodeValue(value, Boolean(options.exact));
  const resource = storeSealed(packet.directory, path, bytes, options.purpose, options.mediaType ?? (options.exact ? "text/plain" : "application/json"), options.requiredForRecovery ?? true);
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

export function updateQaRecoveryPosition(packet: QaRecoveryPacket, stage: string, correctionTurns: number, pendingAction = "automatic-recovery"): QaRecoveryPacket {
  return revise(packet, { recoveryStage: stage, correctionTurns, pendingAction });
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

export function qaReportDigest(report: QaFailureReportV1): string { return hash(Buffer.from(JSON.stringify(report))); }

export function ensureQaRecoveryExcluded(projectDir: string): void {
  let exclude: string;
  try { exclude = execFileSync("git", ["-C", resolve(projectDir), "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim(); } catch { return; }
  if (!resolve(exclude).startsWith(sep)) exclude = resolve(projectDir, exclude);
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
    [`${prefix}/integrity.json`, Buffer.from(`${stableJson({ digest: state.digest, capturedAt: state.capturedAt })}\n`), "application/json", "Reviewed-state integrity manifest"],
    [`${prefix}/untracked-manifest.json`, Buffer.from(`${stableJson(inventory)}\n`), "application/json", "Untracked path, type, mode, digest, and object mapping"],
  ];
  state.untracked.forEach((item, index) => values.push([`${prefix}/untracked/${String(index).padStart(6, "0")}.bin`, item.bytes, "application/octet-stream", `Exact untracked ${item.kind} bytes for ${item.path}`]));
  return values.map(([path, bytes, mediaType, purpose]) => storeSealed(root, safeRelative(path), bytes, purpose, mediaType, true));
}

function sourceInventory(packet: QaRecoveryPacket, prefix: string): Map<string, string> {
  const resource = packet.manifest.resources.find((candidate) => candidate.path === `${prefix}/untracked-manifest.json`);
  const rows = new Map<string, string>();
  for (const candidate of packet.manifest.resources.filter((item) => item.path.startsWith(`${prefix}/`) && !item.path.includes("/untracked/"))) rows.set(candidate.path.slice(prefix.length + 1), candidate.digest);
  if (resource?.objectPath) {
    const inventory = JSON.parse(readFileSync(join(packet.directory, resource.objectPath), "utf8")) as Array<{ path: string; digest: string; kind: string; mode: number }>;
    for (const item of inventory) rows.set(`untracked:${item.path}`, `${item.kind}:${item.mode}:${item.digest}`);
  }
  return rows;
}

function inventoryFromFrozen(state: FrozenQaSourceState): Map<string, string> {
  const rows = new Map<string, string>([
    ["head.txt", hash(Buffer.from(`${state.head}\n`))], ["status.bin", hash(state.status)], ["tracked-head.diff", hash(state.combinedDiff)],
    ["staged.diff", hash(state.stagedDiff)], ["unstaged.diff", hash(state.unstagedDiff)], ["change-summary.txt", hash(Buffer.from(`${state.changeSummary}\n`))],
  ]);
  for (const item of state.untracked) rows.set(`untracked:${item.path}`, `${item.kind}:${item.mode}:${item.digest}`);
  return rows;
}

function deterministicDrift(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().filter((key) => before.get(key) !== after.get(key));
}

function storeSealed(root: string, path: string, bytes: Buffer, purpose: string, mediaType: string, requiredForRecovery: boolean): QaRecoveryResourceV2 {
  const digest = hash(bytes); const objectPath = `objects/${digest}`;
  const absolute = join(root, objectPath);
  if (!existsSync(absolute)) atomicWrite(absolute, bytes);
  else if (hash(readFileSync(absolute)) !== digest) throw new Error(`content-addressed QA recovery object collision: ${digest}`);
  const projection = join(root, path);
  if (existsSync(projection)) throw new Error(`QA recovery resource path already exists: ${path}`);
  mkdirSync(dirname(projection), { recursive: true, mode: 0o700 });
  copyFileSync(absolute, projection);
  chmodSync(projection, 0o600);
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
    return;
  }
  if (resource.integrityPolicy !== "sealed" || !resource.objectPath) throw new Error(`invalid integrity policy for ${resource.path}`);
  const objectPath = resolve(root, safeRelative(resource.objectPath));
  if (!objectPath.startsWith(`${root}${sep}`) || !existsSync(objectPath)) throw new Error(`missing or unsafe QA recovery object: ${resource.path}`);
  assertNoSymlinkComponents(root, objectPath);
  const bytes = readFileSync(objectPath);
  if (bytes.length !== resource.bytes || hash(bytes) !== resource.digest) throw new Error(`QA recovery resource digest mismatch: ${resource.path}`);
  const projection = resolve(root, resource.path);
  if (!projection.startsWith(`${root}${sep}`) || !existsSync(projection)) throw new Error(`missing QA recovery resource projection: ${resource.path}`);
  assertNoSymlinkComponents(root, projection);
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
  const required = ["head.txt", "status.bin", "tracked-head.diff", "staged.diff", "unstaged.diff", "change-summary.txt", "integrity.json", "untracked-manifest.json"];
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
  const declared = JSON.parse(bytes("integrity.json").toString()) as { digest?: unknown };
  const state = {
    head: bytes("head.txt").toString().trimEnd(),
    status: bytes("status.bin"),
    combinedDiff: bytes("tracked-head.diff"),
    stagedDiff: bytes("staged.diff"),
    unstagedDiff: bytes("unstaged.diff"),
    changeSummary: bytes("change-summary.txt").toString().replace(/\n$/, ""),
    untracked,
  };
  const digest = calculateFrozenQaStateDigest(state);
  if (declared.digest !== digest) throw new Error(`reviewed-state integrity digest mismatch: ${prefix}`);
  return digest;
}

function revise(packet: QaRecoveryPacket, changes: Partial<Omit<QaRecoveryManifestV2, "version" | "packetId" | "packetDigest" | "revision" | "parentPacketDigest" | "createdAt" | "updatedAt">>): QaRecoveryPacket {
  const current = loadQaRecoveryPacket(packet.directory);
  if (current.manifest.packetDigest !== packet.manifest.packetDigest) throw new Error("stale QA recovery packet revision cannot be appended");
  const { packetDigest: _digest, ...base } = current.manifest;
  const draft = {
    ...base, ...changes,
    revision: current.manifest.revision + 1,
    parentPacketDigest: current.manifest.packetDigest,
    updatedAt: new Date().toISOString(),
  };
  return publish(packet.directory, packet.projectDir, draft);
}

function publish(root: string, projectDir: string, draft: Omit<QaRecoveryManifestV2, "packetDigest">): QaRecoveryPacket {
  const manifest = { ...draft, resources: draft.resources.slice().sort(resourceOrder), packetDigest: "" } as QaRecoveryManifestV2;
  manifest.packetDigest = calculatePacketDigest(root, manifest);
  const bytes = Buffer.from(`${stableJson(manifest)}\n`);
  const revisionPath = join(root, "manifests", revisionName(manifest.revision));
  if (existsSync(revisionPath)) throw new Error(`QA recovery revision already exists: ${manifest.revision}`);
  atomicWrite(revisionPath, bytes);
  atomicWrite(join(root, "manifest.json"), bytes);
  chmodTreeOwnerOnly(root);
  const packet = { directory: root, projectDir, manifest };
  persistPendingState(packet);
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
    const qaReportRecovery = {
      packetPath: packet.directory,
      packetDigest: packet.manifest.packetDigest,
      reviewedStateDigest: packet.manifest.reviewedStateDigest,
      revision: packet.manifest.revision,
      ladderPosition: packet.manifest.correctionTurns,
      pendingAction: packet.manifest.pendingAction,
      ticketId: packet.manifest.ticketId,
      packetId: packet.manifest.packetId,
      retentionProtected: true,
    };
    db.transition(packet.manifest.runId, {
      status: run.status, checkpoint: run.checkpoint, remainingWork: run.remainingWork,
      state: { ...run.state, qaReportRecovery }, event: "qa_recovery_packet_revision",
      payload: { packetDigest: packet.manifest.packetDigest, revision: packet.manifest.revision, pendingAction: packet.manifest.pendingAction, ticketId: packet.manifest.ticketId },
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

function uniqueResourcePath(resources: QaRecoveryResourceV2[], requested: string): string {
  if (!resources.some((resource) => resource.path === requested)) return requested;
  const dot = requested.lastIndexOf("."); const stem = dot > requested.lastIndexOf("/") ? requested.slice(0, dot) : requested; const extension = dot > requested.lastIndexOf("/") ? requested.slice(dot) : "";
  let sequence = 2; while (resources.some((resource) => resource.path === `${stem}.seq-${String(sequence).padStart(4, "0")}${extension}`)) sequence++;
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
function atomicWrite(path: string, bytes: Buffer, mode = 0o600): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`); writeFileSync(temp, bytes, { mode }); chmodSync(temp, mode); renameSync(temp, path); chmodSync(path, mode); }
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function statOwner(path: string): number { return lstatSync(path).uid; }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
function digestTree(root: string): string { const rows: string[] = []; const visit = (directory: string) => { for (const name of readdirSync(directory).sort()) { const path = join(directory, name); const rel = relative(root, path); const stat = lstatSync(path); if (stat.isDirectory()) visit(path); else { const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path); rows.push(`${rel}\0${stat.mode & 0o7777}\0${hash(bytes)}`); } } }; visit(root); return hash(Buffer.from(rows.join("\n"))); }
function chmodTreeOwnerOnly(root: string): void { for (const name of readdirSync(root)) { const path = join(root, name); const stat = lstatSync(path); if (stat.isDirectory()) { chmodSync(path, 0o700); chmodTreeOwnerOnly(path); } else if (!stat.isSymbolicLink()) chmodSync(path, 0o600); } chmodSync(root, 0o700); }
function assertNoSymlinkComponents(base: string, target: string): void { const root = resolve(base); const absolute = resolve(target); if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error(`path escapes recovery containment: ${target}`); let cursor = root; if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink is not allowed in recovery path: ${cursor}`); for (const part of relative(root, absolute).split(sep).filter(Boolean)) { cursor = join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink is not allowed in recovery path: ${cursor}`); } }
