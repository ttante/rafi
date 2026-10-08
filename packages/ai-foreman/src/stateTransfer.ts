import Database from "better-sqlite3";
import { registerHandbackWriter } from "./qaHandbackMigration.js";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { StateDb } from "./tickets/stateDb.js";
import { DEFAULT_TICKETS_CONFIG } from "./tickets/config.js";
import { WorkflowDb, readCurrentWorkflowLease, WORKFLOW_DB_FILE } from "./workflowDb.js";
import { OBSERVABILITY_DB_FILE } from "./observability.js";

export const STATE_BUNDLE_FORMAT = "rafi-state-bundle.v1";
export const STATE_MANIFEST_PATH = "rafi-state-manifest.v1.json";
export const STATE_LINEAGE_PATH = ".rafi/state-transfer.json";

export interface StateBundleManifestV1 {
  format: typeof STATE_BUNDLE_FORMAT;
  bundleId: string;
  createdAt: string;
  lineage?: StateBundleLineage;
  source: {
    root: string;
    git: GitSummary;
    fingerprint: string;
  };
  packages: {
    aiForemanVersion: string;
  };
  compatibility: {
    dbBackedTicketsRequired: true;
    providerSessionsPortable: false;
    diagnosticsIncluded: true;
  };
  files: Array<{
    path: string;
    kind: "file" | "sqlite";
    size: number;
    sha256: string;
  }>;
}

export interface StateBundleLineage {
  baseBundleId?: string;
  baseFingerprint: string;
  sourceCurrentFingerprint: string;
}

export interface GitSummary {
  branch?: string;
  head?: string;
  dirty?: boolean;
  available: boolean;
}

export interface StateInspectResult {
  manifest: StateBundleManifestV1;
  valid: boolean;
}

interface ArchiveEntry {
  path: string;
  data: string;
}

interface ArchivePayload {
  format: typeof STATE_BUNDLE_FORMAT;
  entries: ArchiveEntry[];
}

interface LineageFile {
  version: 1;
  lastImportedBundleId?: string;
  lastExportedBundleId?: string;
  sourceRoot?: string;
  sourceFingerprint?: string;
  currentFingerprint?: string;
  updatedAt: string;
}

const TRANSFER_ROOTS = [
  ".tickets/tickets.yaml",
  ".tickets/config.yaml",
  ".tickets/delivery.yaml",
  ".tickets/tracker-rules.md",
  "docs/ticket-progress.md",
  "docs/ticket-archive.md",
  ".foreman/runs",
  ".foreman/delivery-sessions",
  ".foreman/qa-report-recovery",
  ".foreman/qa-recovery-context",
  ".rafi/compiled",
  ".rafi/source-cache",
  ".rafi/interviews",
  DEFAULT_TICKETS_CONFIG.paths.stateDb,
  WORKFLOW_DB_FILE,
  OBSERVABILITY_DB_FILE,
] as const;

const STATE_PATHS: readonly string[] = [
  ...TRANSFER_ROOTS.filter((path) => !isKnownSqlitePath(path)),
] as readonly string[];

const DIAGNOSTIC_TRANSFER_DIRS = [
  ".foreman/runs",
  ".foreman/delivery-sessions",
  ".foreman/qa-report-recovery",
  ".foreman/qa-recovery-context",
] as const;

export async function exportStateBundle(projectDir: string, outputFile: string, opts: { now?: Date; packageVersion?: string } = {}): Promise<StateBundleManifestV1> {
  const root = resolve(projectDir);
  assertDbBackedTickets(root);
  assertNoLiveLease(root);
  runCurrentMigrations(root);
  assertCleanGit(root, "export");

  const work = mkdtempSync(join(tmpdir(), "rafi-state-export-"));
  try {
    const staged = join(work, "state");
    mkdirSync(staged, { recursive: true });
    stageRegularStateFiles(root, staged);
    await stageSqliteBackup(root, DEFAULT_TICKETS_CONFIG.paths.stateDb, join(staged, DEFAULT_TICKETS_CONFIG.paths.stateDb));
    if (existsSync(join(root, WORKFLOW_DB_FILE))) await stageSqliteBackup(root, WORKFLOW_DB_FILE, join(staged, WORKFLOW_DB_FILE));
    if (existsSync(join(root, OBSERVABILITY_DB_FILE))) await stageSqliteBackup(root, OBSERVABILITY_DB_FILE, join(staged, OBSERVABILITY_DB_FILE));

    const filePaths = listFiles(staged).sort();
    const currentFingerprint = fingerprintState(root);
    const priorLineage = readLineage(root);
    const baseFingerprint = priorLineage?.currentFingerprint ?? currentFingerprint;
    const manifest: StateBundleManifestV1 = {
      format: STATE_BUNDLE_FORMAT,
      bundleId: randomUUID(),
      createdAt: (opts.now ?? new Date()).toISOString(),
      lineage: {
        ...(priorLineage?.lastImportedBundleId || priorLineage?.lastExportedBundleId ? { baseBundleId: priorLineage.lastImportedBundleId ?? priorLineage.lastExportedBundleId } : {}),
        baseFingerprint,
        sourceCurrentFingerprint: currentFingerprint,
      },
      source: {
        root,
        git: gitSummary(root),
        fingerprint: currentFingerprint,
      },
      packages: {
        aiForemanVersion: opts.packageVersion ?? packageVersion(),
      },
      compatibility: {
        dbBackedTicketsRequired: true,
        providerSessionsPortable: false,
        diagnosticsIncluded: true,
      },
      files: filePaths.map((path) => {
        const abs = join(staged, path);
        return { path, kind: isSqlitePath(path) ? "sqlite" : "file", size: statSync(abs).size, sha256: sha256(readFileSync(abs)) };
      }),
    };
    writeFileSync(join(staged, STATE_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const entries = listFiles(staged).sort().map((path) => ({ path, data: readFileSync(join(staged, path)).toString("base64") }));
    const payload: ArchivePayload = { format: STATE_BUNDLE_FORMAT, entries };
    mkdirSync(dirname(resolve(outputFile)), { recursive: true });
    writeFileSync(resolve(outputFile), gzipSync(Buffer.from(JSON.stringify(payload), "utf8")));
    writeLineage(root, {
      version: 1,
      lastExportedBundleId: manifest.bundleId,
      sourceRoot: root,
      sourceFingerprint: manifest.source.fingerprint,
      currentFingerprint: manifest.source.fingerprint,
      updatedAt: manifest.createdAt,
    });
    return manifest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function inspectStateBundle(bundleFile: string): StateInspectResult {
  const archive = readArchive(bundleFile);
  const manifestEntry = archive.entries.find((entry) => entry.path === STATE_MANIFEST_PATH);
  if (!manifestEntry) throw new Error(`bundle is missing ${STATE_MANIFEST_PATH}`);
  const manifest = JSON.parse(Buffer.from(manifestEntry.data, "base64").toString("utf8")) as StateBundleManifestV1;
  validateManifest(manifest);
  validateArchiveAgainstManifest(archive, manifest);
  const byPath = new Map(archive.entries.map((entry) => [entry.path, entry]));
  for (const file of manifest.files) {
    const entry = byPath.get(file.path);
    if (!entry) throw new Error(`bundle is missing file entry ${file.path}`);
    const data = Buffer.from(entry.data, "base64");
    if (data.length !== file.size) throw new Error(`bundle file size mismatch for ${file.path}`);
    if (sha256(data) !== file.sha256) throw new Error(`bundle digest mismatch for ${file.path}`);
  }
  return { manifest, valid: true };
}

export async function importStateBundle(projectDir: string, bundleFile: string, opts: { yes?: boolean; now?: Date } = {}): Promise<{ manifest: StateBundleManifestV1; backupDir?: string }> {
  const root = resolve(projectDir);
  const archive = readArchive(bundleFile);
  const inspected = inspectStateBundle(bundleFile);
  const manifest = inspected.manifest;
  assertNoLiveLease(root, "import");
  assertCleanGit(root, "import");
  assertCompatibleGit(root, manifest);
  assertLineageAllowsImport(root, manifest);
  if (hasTransferableState(root) && !opts.yes) throw new Error("refusing to replace existing local Rafi state without confirmation; rerun with --yes or approve the interactive prompt");

  const work = mkdtempSync(join(tmpdir(), "rafi-state-import-"));
  let backupDir: string | undefined;
  let rollbackDir: string | undefined;
  try {
    const staged = join(work, "state");
    mkdirSync(staged, { recursive: true });
    for (const entry of archive.entries) {
      if (entry.path === STATE_MANIFEST_PATH) continue;
      assertSafeRelativePath(entry.path);
      if (!isAllowedStateTransferPath(entry.path)) throw new Error(`bundle file is outside the Rafi state transfer allowlist: ${entry.path}`);
      const out = join(staged, entry.path);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(entry.data, "base64"));
    }
    const backup = backupExistingState(root, opts.now ?? new Date());
    backupDir = backup?.durableBackupDir;
    rollbackDir = backup?.snapshotDir;
    replaceTransferableState(root, staged);
    rewriteImportedPaths(root, manifest.source.root);
    assertDbBackedTickets(root);
    runCurrentMigrations(root);
    const currentFingerprint = fingerprintState(root);
    writeLineage(root, {
      version: 1,
      lastImportedBundleId: manifest.bundleId,
      sourceRoot: manifest.source.root,
      sourceFingerprint: manifest.source.fingerprint,
      currentFingerprint,
      updatedAt: (opts.now ?? new Date()).toISOString(),
    });
    return { manifest, backupDir };
  } catch (error) {
    restoreBackup(root, rollbackDir);
    throw error;
  } finally {
    if (rollbackDir && existsSync(rollbackDir)) rmSync(rollbackDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

export function fingerprintState(projectDir: string): string {
  const root = resolve(projectDir);
  const hash = createHash("sha256");
  for (const rel of [...new Set(TRANSFER_ROOTS)].sort()) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    if (rel === STATE_LINEAGE_PATH || rel.includes(".rafi/state-transfer-backups")) continue;
    for (const file of (statSync(abs).isDirectory() ? listFiles(abs).map((child) => join(rel, child)) : [rel]).sort()) {
      if (file.endsWith("-wal") || file.endsWith("-shm") || file === STATE_LINEAGE_PATH || file.includes(".rafi/state-transfer-backups")) continue;
      const full = join(root, file);
      if (!existsSync(full) || statSync(full).isDirectory()) continue;
      hash.update(file);
      hash.update("\0");
      hash.update(readFileSync(full));
      hash.update("\0");
    }
  }
  for (const file of rootDiagnosticFiles(root).sort()) {
    if (file === STATE_LINEAGE_PATH || file.includes(".rafi/state-transfer-backups")) continue;
    const full = join(root, file);
    if (!existsSync(full) || statSync(full).isDirectory()) continue;
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(full));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function assertDbBackedTickets(root: string): void {
  const indicators = [
    DEFAULT_TICKETS_CONFIG.paths.tickets,
    ".tickets/delivery.yaml",
    ".tickets/config.yaml",
    "docs/ticket-progress.md",
    "docs/ticket-archive.md",
    ".foreman/delivery-sessions",
    ".tickets/delivery-sessions",
    ".tickets/history.jsonl",
    ".tickets/history",
    ".tickets/events",
    ".tickets/imports",
    ".tickets/backups",
  ];
  const found = indicators.find((rel) => existsSync(join(root, rel)));
  if (found && !existsSync(join(root, DEFAULT_TICKETS_CONFIG.paths.stateDb))) {
    throw new Error(`DB-backed ticket state is required: found ${found} but missing ${DEFAULT_TICKETS_CONFIG.paths.stateDb}`);
  }
}

function assertNoLiveLease(root: string, operation = "export"): void {
  const lease = readCurrentWorkflowLease(root);
  if (!lease) return;
  const ageMs = Date.now() - new Date(lease.heartbeatAt).getTime();
  if (ageMs <= 45_000) throw new Error(`refusing to ${operation} while live workflow lease exists for run ${lease.runId}; stop or pause the active run first, then retry the state ${operation}`);
}

function runCurrentMigrations(root: string): void {
  if (existsSync(join(root, DEFAULT_TICKETS_CONFIG.paths.stateDb))) {
    const db = new StateDb(join(root, DEFAULT_TICKETS_CONFIG.paths.stateDb));
    db.close();
  }
  if (existsSync(join(root, WORKFLOW_DB_FILE)) || existsSync(join(root, ".foreman", "runs")) || existsSync(join(root, ".rafi", "interviews")) || existsSync(join(root, ".tickets", "delivery-sessions"))) {
    const db = new WorkflowDb(root);
    db.close();
  }
}

function stageRegularStateFiles(root: string, staged: string): void {
  const seen = new Set<string>();
  for (const rel of STATE_PATHS) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    for (const file of statSync(abs).isDirectory() ? listFiles(abs).map((child) => join(rel, child)) : [rel]) {
      if (seen.has(file) || shouldSkipRuntimeFile(file) || isSqlitePath(file) || !isAllowedStateTransferPath(file)) continue;
      seen.add(file);
      const source = join(root, file);
      const dest = join(staged, file);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
    }
  }
  for (const file of rootDiagnosticFiles(root)) {
    if (seen.has(file) || shouldSkipRuntimeFile(file) || !isAllowedStateTransferPath(file)) continue;
    seen.add(file);
    const source = join(root, file);
    const dest = join(staged, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
  }
}

async function stageSqliteBackup(root: string, rel: string, dest: string): Promise<void> {
  const source = join(root, rel);
  if (!existsSync(source)) return;
  mkdirSync(dirname(dest), { recursive: true });
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
}

function backupExistingState(root: string, now: Date): { durableBackupDir?: string; snapshotDir: string } | undefined {
  const existing = [...new Set([...transferRootsWithLineage(), ...rootDiagnosticFiles(root)])].filter((rel) => existsSync(join(root, rel)));
  const snapshotDir = mkdtempSync(join(tmpdir(), "rafi-state-import-rollback-"));
  for (const rel of existing) {
    const source = join(root, rel);
    const dest = join(snapshotDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(source, dest, { recursive: true, force: true });
  }
  if (!existing.length) return { snapshotDir };
  const backupDir = join(root, ".rafi", "state-transfer-backups", now.toISOString().replace(/[:.]/g, "-"));
  for (const rel of existing) {
    const source = join(root, rel);
    const dest = join(backupDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(source, dest, { recursive: true, force: true });
  }
  return { durableBackupDir: backupDir, snapshotDir };
}

function replaceTransferableState(root: string, staged: string): void {
  removeTransferableState(root);
  for (const file of listFiles(staged)) {
    if (!isAllowedStateTransferPath(file)) throw new Error(`staged file is outside the Rafi state transfer allowlist: ${file}`);
    const source = join(staged, file);
    const dest = join(root, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
  }
}

function removeTransferableState(root: string): void {
  for (const rel of [...new Set([...transferRootsWithLineage(), ...rootDiagnosticFiles(root)])]) {
    if (rel === ".rafi" || rel === ".foreman" || rel === ".tickets" || rel === "docs") continue;
    const target = join(root, rel);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
}

function restoreBackup(root: string, backupDir: string | undefined): void {
  removeTransferableState(root);
  if (!backupDir) return;
  for (const file of listFiles(backupDir)) {
    const source = join(backupDir, file);
    const dest = join(root, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
  }
  rmSync(backupDir, { recursive: true, force: true });
}

function assertLineageAllowsImport(root: string, manifest: StateBundleManifestV1): void {
  const hasState = hasTransferableState(root);
  if (!hasState) return;
  const lineage = readLineage(root);
  if (!lineage) {
    if (!manifest.lineage) return;
    throw new Error(`target already has local Rafi state but no ${STATE_LINEAGE_PATH}; refusing to overwrite without state-transfer lineage. Export from the advanced machine first or start from a clean target state.`);
  }
  const current = fingerprintState(root);
  if (lineage.currentFingerprint && current !== lineage.currentFingerprint) {
    throw new Error("target Rafi state has advanced since the last state transfer; export from this machine first or start with a clean target state");
  }
  if (!manifest.lineage) {
    throw new Error("incoming state bundle has no lineage metadata; import it only into a clean target or export a new bundle with current Rafi first");
  }
  const expectedBundleId = lineage.lastImportedBundleId ?? lineage.lastExportedBundleId;
  const bundleMatches = Boolean(expectedBundleId && manifest.lineage.baseBundleId === expectedBundleId);
  const fingerprintMatches = Boolean(lineage.currentFingerprint && manifest.lineage.baseFingerprint === lineage.currentFingerprint);
  if (!bundleMatches && !fingerprintMatches) {
    throw new Error("incoming state bundle diverges from the target state lineage; export from the advanced machine, switch branches or check out the expected Git HEAD, or start from a clean target state");
  }
}

function readLineage(root: string): LineageFile | undefined {
  const path = join(root, STATE_LINEAGE_PATH);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as LineageFile;
}

function writeLineage(root: string, lineage: LineageFile): void {
  const path = join(root, STATE_LINEAGE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(lineage, null, 2)}\n`, "utf8");
}

function rewriteImportedPaths(root: string, sourceRoot: string): void {
  for (const rel of listFiles(join(root, ".foreman", "runs"), true).map((child) => join(".foreman", "runs", child))) {
    rewriteJsonFile(root, rel, (value) => rewriteBuildRunJson(value, sourceRoot, root));
  }
  for (const rel of listFiles(join(root, ".foreman", "delivery-sessions"), true).map((child) => join(".foreman", "delivery-sessions", child))) {
    rewriteJsonFile(root, rel, (value) => rewriteKnownPathKeys(value, sourceRoot, root, new Set(["worktreePath"])));
  }
  for (const rel of listFiles(join(root, ".foreman", "qa-report-recovery"), true).map((child) => join(".foreman", "qa-report-recovery", child))) {
    if (rel.endsWith(".json")) rewriteJsonFile(root, rel, (value) => rewriteKnownPathKeys(value, sourceRoot, root, new Set(["packetPath", "worktreePath", "builderWorktree"])));
  }
  rewriteWorkflowDb(root, sourceRoot);
}

function rewriteWorkflowDb(root: string, sourceRoot: string): void {
  const path = join(root, WORKFLOW_DB_FILE);
  if (!existsSync(path)) return;
  const db = new Database(path);
  registerHandbackWriter(db);
  try {
    rewriteSqlJsonColumn(db, "workflow_runs", "run_id", ["original_work_json", "remaining_work_json", "state_json"], sourceRoot, root);
    rewriteSqlJsonColumn(db, "branch_resume_sessions", "rowid", ["session_json"], sourceRoot, root);
    if (tableExists(db, "qa_recovery_heads")) {
      const rows = db.prepare("SELECT rowid,packet_path FROM qa_recovery_heads").all() as Array<{ rowid: number; packet_path: string }>;
      for (const row of rows) db.prepare("UPDATE qa_recovery_heads SET packet_path=? WHERE rowid=?").run(rewriteProjectPath(row.packet_path, sourceRoot, root), row.rowid);
    }
    if (tableExists(db, "qa_packet_projections")) {
      const rows = db.prepare("SELECT rowid,path,manifest_json FROM qa_packet_projections").all() as Array<{ rowid: number; path: string; manifest_json: string | null }>;
      for (const row of rows) {
        const manifest = row.manifest_json ? JSON.stringify(rewriteKnownPathKeys(JSON.parse(row.manifest_json), sourceRoot, root, new Set(["path", "packetPath", "worktreePath"]))) : null;
        db.prepare("UPDATE qa_packet_projections SET path=?,manifest_json=? WHERE rowid=?").run(rewriteProjectPath(row.path, sourceRoot, root), manifest, row.rowid);
      }
    }
  } finally {
    db.close();
  }
}

function rewriteSqlJsonColumn(db: Database.Database, table: string, idColumn: string, columns: string[], sourceRoot: string, root: string): void {
  if (!tableExists(db, table)) return;
  const quotedColumns = columns.map((column) => `"${column}"`).join(",");
  const rows = db.prepare(`SELECT ${idColumn} AS id,${quotedColumns} FROM ${table}`).all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const column of columns) {
      const raw = row[column];
      if (typeof raw !== "string") continue;
      sets.push(`"${column}"=?`);
      values.push(JSON.stringify(rewriteKnownPathKeys(JSON.parse(raw), sourceRoot, root, new Set(["root", "worktree", "worktreePath", "packetPath"]))));
    }
    if (!sets.length) continue;
    values.push(row.id);
    db.prepare(`UPDATE ${table} SET ${sets.join(",")} WHERE ${idColumn}=?`).run(...values);
  }
}

function rewriteBuildRunJson(value: unknown, sourceRoot: string, root: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  const repository = copy.repository;
  if (repository && typeof repository === "object" && !Array.isArray(repository)) {
    copy.repository = rewriteKnownPathKeys(repository, sourceRoot, root, new Set(["root", "worktree"]));
  }
  return rewriteKnownPathKeys(copy, sourceRoot, root, new Set(["worktreePath"]));
}

function rewriteKnownPathKeys(value: unknown, sourceRoot: string, root: string, keys: Set<string>, currentKey?: string): unknown {
  if (typeof value === "string") return currentKey && keys.has(currentKey) ? rewriteProjectPath(value, sourceRoot, root) : value;
  if (Array.isArray(value)) return value.map((item) => rewriteKnownPathKeys(item, sourceRoot, root, keys));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) out[key] = rewriteKnownPathKeys(child, sourceRoot, root, keys, key);
  return out;
}

function rewriteProjectPath(value: string, sourceRoot: string, root: string): string {
  const source = resolve(sourceRoot);
  const candidate = isAbsolute(value) ? resolve(value) : value;
  if (typeof candidate === "string" && isAbsolute(candidate)) {
    const rel = relative(source, candidate);
    if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) return join(root, rel);
  }
  return value;
}

function rewriteJsonFile(root: string, rel: string, rewrite: (value: unknown) => unknown): void {
  const path = join(root, rel);
  if (!existsSync(path) || statSync(path).isDirectory()) return;
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  writeFileSync(path, `${JSON.stringify(rewrite(value), null, 2)}\n`, "utf8");
}

function readArchive(bundleFile: string): ArchivePayload {
  const payload = JSON.parse(gunzipSync(readFileSync(resolve(bundleFile))).toString("utf8")) as ArchivePayload;
  if (payload.format !== STATE_BUNDLE_FORMAT || !Array.isArray(payload.entries)) throw new Error("unsupported Rafi state bundle format; upgrade Rafi to read this bundle");
  const seen = new Set<string>();
  for (const entry of payload.entries) {
    assertSafeRelativePath(entry.path);
    if (seen.has(entry.path)) throw new Error(`duplicate bundle archive entry: ${entry.path}`);
    seen.add(entry.path);
  }
  return payload;
}

function validateManifest(manifest: StateBundleManifestV1): void {
  if (manifest.format !== STATE_BUNDLE_FORMAT) throw new Error("unsupported Rafi state bundle manifest; upgrade Rafi to read this bundle");
  if (!manifest.compatibility?.dbBackedTicketsRequired) throw new Error("unsupported state bundle compatibility flags");
  const seen = new Set<string>();
  for (const file of manifest.files ?? []) {
    assertSafeRelativePath(file.path);
    if (seen.has(file.path)) throw new Error(`duplicate manifest file path: ${file.path}`);
    seen.add(file.path);
    if (!isAllowedStateTransferPath(file.path)) throw new Error(`manifest file is outside the Rafi state transfer allowlist: ${file.path}`);
    if (file.kind === "sqlite" && !isKnownSqlitePath(file.path)) throw new Error(`manifest sqlite file is outside the Rafi sqlite allowlist: ${file.path}`);
    if (file.kind === "file" && isKnownSqlitePath(file.path)) throw new Error(`manifest sqlite database must use sqlite kind: ${file.path}`);
  }
  if (manifest.lineage && manifest.lineage.sourceCurrentFingerprint !== manifest.source.fingerprint) throw new Error("manifest lineage source fingerprint does not match source fingerprint");
}

function validateArchiveAgainstManifest(archive: ArchivePayload, manifest: StateBundleManifestV1): void {
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  for (const entry of archive.entries) {
    if (entry.path === STATE_MANIFEST_PATH) continue;
    if (!manifestPaths.has(entry.path)) throw new Error(`bundle contains unmanifested file entry: ${entry.path}`);
  }
  const archivePaths = new Set(archive.entries.map((entry) => entry.path));
  if (!archivePaths.has(STATE_MANIFEST_PATH)) throw new Error(`bundle is missing ${STATE_MANIFEST_PATH}`);
  for (const file of manifest.files) {
    if (!archivePaths.has(file.path)) throw new Error(`bundle is missing file entry ${file.path}`);
  }
}

function assertCompatibleGit(root: string, manifest: StateBundleManifestV1): void {
  const target = gitSummary(root);
  const source = manifest.source.git;
  if (source.available && !target.available) throw new Error("target repository must have Git available before importing this state bundle");
  if (source.branch && target.branch && source.branch !== target.branch) throw new Error(`target Git branch mismatch: expected ${source.branch}, found ${target.branch}; switch branch before importing Rafi state`);
  if (source.head && target.head && source.head !== target.head) throw new Error(`target Git HEAD mismatch: expected ${source.head}, found ${target.head}; sync the source tree or check out the expected HEAD before importing Rafi state`);
}

function gitSummary(root: string): GitSummary {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (head.status !== 0) return { available: false };
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return {
    available: true,
    head: head.stdout.trim() || undefined,
    branch: branch.status === 0 ? branch.stdout.trim() || undefined : undefined,
    dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : undefined,
  };
}

function listFiles(root: string, missingOk = false): string[] {
  if (!existsSync(root)) return missingOk ? [] : [];
  const out: string[] = [];
  const walk = (dir: string, prefix = ""): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = statSync(abs);
      if (stat.isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  else out.push(basename(root));
  return out;
}

function shouldSkipRuntimeFile(path: string): boolean {
  return path.endsWith("-wal") || path.endsWith("-shm") || path === STATE_LINEAGE_PATH || path.includes(".rafi/state-transfer-backups");
}

function isSqlitePath(path: string): boolean {
  return path.endsWith(".sqlite") || path.endsWith(".sqlite3");
}

function isKnownSqlitePath(path: string): boolean {
  return path === DEFAULT_TICKETS_CONFIG.paths.stateDb || path === WORKFLOW_DB_FILE || path === OBSERVABILITY_DB_FILE;
}

function transferRootsWithLineage(): string[] {
  return [...new Set([...TRANSFER_ROOTS, STATE_LINEAGE_PATH])].sort();
}

export function hasTransferableState(projectDir: string): boolean {
  const root = resolve(projectDir);
  return transferRootsWithLineage().some((rel) => existsSync(join(root, rel))) || rootDiagnosticFiles(root).length > 0;
}

function rootDiagnosticFiles(root: string): string[] {
  const dir = join(root, ".foreman");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") || name.endsWith(".jsonl"))
    .map((name) => `.foreman/${name}`)
    .filter((path) => isAllowedStateTransferPath(path));
}

function isAllowedStateTransferPath(path: string): boolean {
  if (path === STATE_MANIFEST_PATH) return true;
  if (path.endsWith("-wal") || path.endsWith("-shm")) return false;
  if (path.startsWith(".foreman/worktrees/")) return false;
  if (isKnownSqlitePath(path)) return true;
  for (const root of STATE_PATHS) {
    if (path === root || path.startsWith(`${root}/`)) return true;
  }
  for (const root of DIAGNOSTIC_TRANSFER_DIRS) {
    if (path === root || path.startsWith(`${root}/`)) return true;
  }
  if (/^\.foreman\/[^/]+\.jsonl?$/.test(path)) return true;
  return false;
}

function assertCleanGit(root: string, operation: "export" | "import"): void {
  const git = gitSummary(root);
  if (!git.available || git.dirty === false) return;
  throw new Error(`refusing to ${operation} Rafi state from a dirty Git checkout because source code is not bundled; commit or stash local changes, sync the source tree, then retry`);
}

function assertSafeRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes(`.${sep}`)) throw new Error(`unsafe bundle path: ${path}`);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function packageVersion(): string {
  try {
    const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return String((JSON.parse(text) as { version?: string }).version ?? "unknown");
  } catch {
    return "unknown";
  }
}
