import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { InstallDependencyV1, InstallManifest, InstallManifestEntryV1, InstallManifestEntryV2, InstallManifestV1, InstallManifestV2, InstallOwnershipCategory } from "rafi-spec";

export const INSTALL_MANIFEST = ".rafi/install-manifest.json";
export const OWNERSHIP_BACKUPS = ".rafi/ownership-backups";

export function initializeInstallManifest(projectDir: string, dirtyChoice: InstallManifestV2["repository"]["dirtyChoice"]): InstallManifestV2 {
  const existing = readInstallManifest(projectDir);
  if (existing) return existing;
  const manifest = emptyManifest(projectDir);
  manifest.repository.dirtyChoice = dirtyChoice;
  return writeManifest(projectDir, manifest);
}

export function readInstallManifest(projectDir: string): InstallManifestV2 | undefined {
  const path = join(resolve(projectDir), INSTALL_MANIFEST);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as InstallManifest;
  validateInstallManifest(projectDir, value);
  return upgradeManifest(projectDir, value);
}

export function registerOwnedFile(
  projectDir: string,
  relativePath: string,
  input: Omit<InstallManifestEntryV1, "path" | "sha256"> & { sha256?: string | null; category?: InstallOwnershipCategory },
): InstallManifestV2 {
  const root = resolve(projectDir);
  const safe = validateOwnedPath(root, relativePath);
  const current = readInstallManifest(root) ?? emptyManifest(root);
  const sha256 = input.sha256 ?? fingerprint(join(root, safe));
  const prior = current.files.find((item) => item.path === safe);
  const entry: InstallManifestEntryV2 = {
    ...prior, path: safe, sha256, ...input,
    category: input.category ?? categorizeOwnedPath(safe, input.mode),
    installedSha256: sha256,
    lastRafiWriteAt: new Date().toISOString(),
  };
  const files = [...current.files.filter((item) => item.path !== safe), entry].sort((a, b) => a.path.localeCompare(b.path));
  return writeManifest(root, { ...current, files, updatedAt: new Date().toISOString() });
}

export function prepareOwnedWrite(projectDir: string, relativePath: string, origin: string, category: InstallOwnershipCategory): InstallManifestV2 {
  const entry = capturePreimage(projectDir, relativePath, origin, category);
  return registerOwnedFile(projectDir, entry.path, entry);
}

export function finalizePreparedOwnedWrite(projectDir: string, relativePath: string, origin: string, category: InstallOwnershipCategory): InstallManifestV2 {
  const existing = readInstallManifest(projectDir)?.files.find((entry) => entry.path === relativePath);
  if (existing) return finalizeOwnedWrite(projectDir, { ...existing, origin, category });
  return registerOwnedFile(projectDir, relativePath, { mode: "generated", origin, category });
}

/** Capture an exact pre-Rafi file before a managed write. */
export function capturePreimage(projectDir: string, relativePath: string, origin: string, category?: InstallOwnershipCategory): InstallManifestEntryV2 {
  const root = resolve(projectDir);
  const safe = validateOwnedPath(root, relativePath);
  const recorded = readInstallManifest(root)?.files.find((entry) => entry.path === safe);
  if (recorded?.mode === "created" || recorded?.mode === "generated") return { ...recorded };
  const absolute = join(root, safe);
  if (!existsSync(absolute)) return { path: safe, sha256: null, mode: "created", origin, category: category ?? categorizeOwnedPath(safe, "created"), preimageSha256: null };
  if (!lstatSync(absolute).isFile()) throw new Error(`ownership target is not a regular file: ${safe}`);
  const backupDir = join(root, OWNERSHIP_BACKUPS);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const backup = `${createHash("sha256").update(safe).digest("hex")}.original`;
  const backupPath = join(backupDir, backup);
  if (!existsSync(backupPath)) copyFileSync(absolute, backupPath);
  const preimageSha256 = fingerprint(absolute);
  return { path: safe, sha256: preimageSha256, mode: "modified", origin, backup: `${OWNERSHIP_BACKUPS}/${backup}`, category: category ?? categorizeOwnedPath(safe, "modified"), preimageSha256 };
}

export function finalizeOwnedWrite(projectDir: string, entry: InstallManifestEntryV2): InstallManifestV2 {
  return registerOwnedFile(projectDir, entry.path, { ...entry, sha256: fingerprint(join(resolve(projectDir), entry.path)) });
}

export function registerDependency(projectDir: string, dependency: InstallDependencyV1): InstallManifestV2 {
  const current = readInstallManifest(projectDir) ?? emptyManifest(projectDir);
  const dependencies = [...current.dependencies.filter((item) => !(item.manager === dependency.manager && item.package === dependency.package)), dependency];
  return writeManifest(projectDir, { ...current, dependencies, updatedAt: new Date().toISOString() });
}

export function validateInstallManifest(projectDir: string, manifest: InstallManifest): void {
  if (![1, 2].includes(manifest.version) || !Array.isArray(manifest.files) || !Array.isArray(manifest.dependencies)) throw new Error("invalid install manifest");
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    const path = validateOwnedPath(projectDir, entry.path);
    if (seen.has(path)) throw new Error(`duplicate ownership path: ${path}`);
    seen.add(path);
    if (entry.backup) validateOwnedPath(projectDir, entry.backup);
  }
  for (const dependency of manifest.dependencies) {
    if (!dependency.package || /[\s;&|`$]/.test(dependency.package)) throw new Error(`unsafe dependency name: ${dependency.package}`);
    dependency.manifests.forEach((path) => validateOwnedPath(projectDir, path));
  }
}

export function validateOwnedPath(projectDir: string, value: string): string {
  if (!value || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\0")) throw new Error(`ownership path must be repository-relative: ${value}`);
  const safe = normalize(value.replace(/\\/g, "/")).replace(/\\/g, "/").replace(/^\.\//, "");
  if (safe === "." || safe === ".." || safe.startsWith("../") || safe.split("/").includes("..")) throw new Error(`ownership path escapes project: ${value}`);
  if (safe === ".git" || safe.startsWith(".git/")) throw new Error(`ordinary ownership may not target Git metadata: ${value}`);
  const root = resolve(projectDir);
  const absolute = resolve(root, safe);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`ownership path escapes project: ${value}`);
  assertNoSymlinkEscape(root, safe);
  return safe;
}

function assertNoSymlinkEscape(root: string, safe: string): void {
  const rootReal = realpathSync(root);
  let current = root;
  for (const part of safe.split("/")) {
    current = join(current, part);
    if (!existsSync(current)) break;
    const real = realpathSync(current);
    const rel = relative(rootReal, real);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`ownership path resolves outside project: ${safe}`);
  }
}

function emptyManifest(projectDir: string, now = new Date()): InstallManifestV2 {
  const stamp = now.toISOString();
  const root = resolve(projectDir);
  const status = gitValue(root, ["status", "--porcelain=v1", "-z"]);
  return {
    version: 2, createdAt: stamp, updatedAt: stamp,
    repository: {
      rootIdentity: createHash("sha256").update(realpathSync(root)).digest("hex"),
      preInstallHead: gitValue(root, ["rev-parse", "HEAD"]),
      initialBranch: gitValue(root, ["branch", "--show-current"]),
      initialDirtyDigest: status ? createHash("sha256").update(status).digest("hex") : undefined,
      dirtyChoice: status ? "snapshot-and-continue" : "clean",
      baselineComplete: Boolean(gitValue(root, ["rev-parse", "HEAD"])),
    },
    files: [], dependencies: [],
  };
}

function writeManifest(projectDir: string, manifest: InstallManifestV2): InstallManifestV2 {
  validateInstallManifest(projectDir, manifest);
  const path = join(resolve(projectDir), INSTALL_MANIFEST);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temp, path);
  return manifest;
}

function fingerprint(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function listOwnedTree(projectDir: string, relativeDirectory: string): string[] {
  const root = resolve(projectDir);
  const safe = validateOwnedPath(root, relativeDirectory);
  const start = join(root, safe);
  if (!existsSync(start)) return [];
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`refusing recursive ownership through symlink: ${relative(root, path)}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) output.push(relative(root, path).replace(/\\/g, "/"));
    }
  };
  if (lstatSync(start).isDirectory()) visit(start); else output.push(safe);
  return output.sort();
}

export function removeOwnedPathsTransaction(projectDir: string, paths: string[]): { runId: string; recoveryId: string; removed: string[] } {
  const root = resolve(projectDir);
  const safePaths = [...new Set(paths.map((path) => validateOwnedPath(root, path)))].sort((a, b) => b.length - a.length);
  const runId = randomUUID();
  const transactionRoot = join(root, ".rafi-uninstall", runId);
  const payload = join(transactionRoot, "payload");
  mkdirSync(payload, { recursive: true, mode: 0o700 });
  const manifest = readInstallManifest(root);
  const journal = { version: 2, runId, recoveryId: runId, startedAt: new Date().toISOString(), status: "in_progress", manifest, operations: [] as Array<{ path: string; status: string; sha256: string | null }> };
  writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  const moved: Array<{ source: string; destination: string }> = [];
  try {
    for (const safe of safePaths) {
      const source = join(root, safe);
      if (!existsSync(source)) continue;
      const destination = join(payload, safe);
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(source, destination);
      moved.push({ source, destination });
      journal.operations.push({ path: safe, status: "preserved", sha256: fingerprint(destination) });
      writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    }
    journal.status = "complete";
    writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    return { runId, recoveryId: runId, removed: journal.operations.map((operation) => operation.path) };
  } catch (error) {
    for (const item of moved.reverse()) {
      if (existsSync(item.destination) && !existsSync(item.source)) {
        mkdirSync(dirname(item.source), { recursive: true });
        renameSync(item.destination, item.source);
      }
    }
    throw new Error(`uninstall transaction ${runId} rolled back: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function restoreOwnedPreimagesTransaction(projectDir: string, entries: InstallManifestEntryV2[]): { runId: string; recoveryId: string; restored: string[] } {
  const root = resolve(projectDir);
  const runId = randomUUID();
  const transactionRoot = join(root, ".rafi-uninstall", runId);
  const payload = join(transactionRoot, "payload");
  mkdirSync(payload, { recursive: true, mode: 0o700 });
  const journal = { version: 2, runId, recoveryId: runId, startedAt: new Date().toISOString(), status: "in_progress", kind: "preimage-restore", operations: [] as Array<{ path: string; backup: string; preimage: string; status: string }> };
  writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  const restored: string[] = [];
  try {
    for (const entry of entries) {
      const safe = validateOwnedPath(root, entry.path);
      if (!entry.backup) throw new Error(`no pre-Rafi backup is recorded for ${safe}`);
      const preimage = join(root, validateOwnedPath(root, entry.backup));
      if (!existsSync(preimage)) throw new Error(`pre-Rafi backup is missing for ${safe}`);
      const current = join(root, safe);
      const displaced = join(payload, "displaced-current", safe);
      if (existsSync(current)) {
        mkdirSync(dirname(displaced), { recursive: true });
        renameSync(current, displaced);
      }
      mkdirSync(dirname(current), { recursive: true });
      copyFileSync(preimage, current);
      restored.push(safe);
      journal.operations.push({ path: safe, backup: relative(root, displaced).replace(/\\/g, "/"), preimage: entry.backup, status: "restored" });
      writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    }
    journal.status = "complete";
    writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    return { runId, recoveryId: runId, restored };
  } catch (error) {
    for (const entry of entries.slice(0, restored.length).reverse()) {
      const current = join(root, entry.path);
      const displaced = join(payload, "displaced-current", entry.path);
      if (existsSync(current)) rmSync(current, { force: true });
      if (existsSync(displaced)) { mkdirSync(dirname(current), { recursive: true }); renameSync(displaced, current); }
    }
    throw new Error(`preimage restore ${runId} rolled back: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Preserve recorded pre-Rafi bytes for a file the user chose to keep today. */
export function preservePreimagesForLaterRestore(
  projectDir: string,
  entries: InstallManifestEntryV2[],
): { recoveryId: string; preserved: string[] } | undefined {
  const root = resolve(projectDir);
  const restorable = entries.filter((entry) => entry.backup && existsSync(join(root, validateOwnedPath(root, entry.backup))));
  if (!restorable.length) return undefined;
  const recoveryId = randomUUID();
  const transactionRoot = join(root, ".rafi-uninstall", recoveryId);
  const payload = join(transactionRoot, "payload");
  mkdirSync(payload, { recursive: true, mode: 0o700 });
  const operations: Array<{ path: string; status: string; sha256: string | null }> = [];
  for (const entry of restorable) {
    const safe = validateOwnedPath(root, entry.path);
    const source = join(root, validateOwnedPath(root, entry.backup!));
    const destination = join(payload, safe);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    operations.push({ path: safe, status: "preimage-preserved-for-later-restore", sha256: fingerprint(destination) });
  }
  const journal = { version: 2, recoveryId, runId: recoveryId, kind: "kept-preimage", status: "complete", createdAt: new Date().toISOString(), operations };
  writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  return { recoveryId, preserved: operations.map((operation) => operation.path) };
}

export function removeManagedBlocksTransaction(projectDir: string, entries: InstallManifestEntryV2[]): { runId: string; recoveryId: string; edited: string[] } {
  const root = resolve(projectDir); const runId = randomUUID(); const transactionRoot = join(root, ".rafi-uninstall", runId); const payload = join(transactionRoot, "payload");
  mkdirSync(payload, { recursive: true, mode: 0o700 });
  const edited: string[] = [];
  const journal = { version: 2, runId, recoveryId: runId, status: "in_progress", kind: "managed-block-removal", operations: [] as Array<{ path: string; status: string; sha256: string | null }> };
  writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  try {
    for (const entry of entries) {
      const safe = validateOwnedPath(root, entry.path); const current = join(root, safe);
      if (!existsSync(current) || !entry.marker) continue;
      const [start, end] = entry.marker.split("..");
      if (!start || !end) throw new Error(`invalid managed block marker for ${safe}`);
      const original = readFileSync(current, "utf8");
      const pattern = new RegExp(`${escapeRegExp(start)}\\r?\\n[\\s\\S]*?${escapeRegExp(end)}\\r?\\n?`, "g");
      if (!pattern.test(original)) throw new Error(`managed block markers are missing from ${safe}; choose keep or full preimage restore`);
      const backup = join(payload, safe); mkdirSync(dirname(backup), { recursive: true }); copyFileSync(current, backup);
      journal.operations.push({ path: safe, status: "intent-recorded", sha256: fingerprint(backup) });
      writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
      writeFileSync(current, original.replace(pattern, "").replace(/^\s+$/, ""), "utf8"); edited.push(safe);
      journal.operations[journal.operations.length - 1]!.status = "managed-block-removed";
      writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    }
    journal.status = "complete";
    writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    return { runId, recoveryId: runId, edited };
  } catch (error) {
    for (const safe of edited.reverse()) {
      const backup = join(payload, safe); const current = join(root, safe);
      if (existsSync(backup)) { mkdirSync(dirname(current), { recursive: true }); copyFileSync(backup, current); }
    }
    journal.status = "rolled_back";
    writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    throw new Error(`managed-block removal ${runId} rolled back: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function restoreUninstallRecovery(projectDir: string, recoveryId: string, selectedPaths?: string[], overwrite = false): { restored: string[]; collisions: string[]; backupId?: string } {
  const root = resolve(projectDir);
  const recoveryRoot = join(root, ".rafi-uninstall", validateRecoveryId(recoveryId));
  const journalPath = join(recoveryRoot, "journal.json");
  if (!existsSync(journalPath)) throw new Error(`uninstall recovery not found: ${recoveryId}`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { operations?: Array<{ path: string; sha256?: string | null }> };
  const allowed = new Set((journal.operations ?? []).map((operation) => operation.path));
  const wanted = selectedPaths?.length ? selectedPaths.map((path) => validateOwnedPath(root, path)) : [...allowed];
  const unknown = wanted.filter((path) => !allowed.has(path));
  if (unknown.length) throw new Error(`paths are not in recovery ${recoveryId}: ${unknown.join(", ")}`);
  const collisions = wanted.filter((path) => existsSync(join(root, path)));
  if (collisions.length && !overwrite) return { restored: [], collisions };
  const backupId = collisions.length ? `restore-backup-${randomUUID()}` : undefined;
  if (backupId) {
    const backupOperations: Array<{ path: string; status: string; sha256: string | null }> = [];
    for (const safe of collisions) {
      const backup = join(root, ".rafi-uninstall", backupId, "payload", safe);
      mkdirSync(dirname(backup), { recursive: true });
      renameSync(join(root, safe), backup);
      backupOperations.push({ path: safe, status: "displaced-before-restore", sha256: fingerprint(backup) });
    }
    const backupJournal = { version: 2, recoveryId: backupId, runId: backupId, kind: "restore-collision-backup", status: "complete", createdAt: new Date().toISOString(), operations: backupOperations };
    writeFileSync(join(root, ".rafi-uninstall", backupId, "journal.json"), `${JSON.stringify(backupJournal, null, 2)}\n`, "utf8");
  }
  const restored: string[] = [];
  for (const safe of wanted) {
    const source = join(recoveryRoot, "payload", safe);
    if (!existsSync(source)) continue;
    const destination = join(root, safe);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, errorOnExist: true });
    restored.push(safe);
  }
  return { restored, collisions: [], backupId };
}

export function cleanupUninstallRecovery(projectDir: string, recoveryIds: string[]): string[] {
  const root = resolve(projectDir);
  const removed: string[] = [];
  for (const id of recoveryIds.map(validateRecoveryId)) {
    const target = join(root, ".rafi-uninstall", id);
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}

export function listUninstallRecoveries(projectDir: string): string[] {
  const directory = join(resolve(projectDir), ".rafi-uninstall");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[A-Za-z0-9-]+$/.test(entry.name)).map((entry) => entry.name).sort();
}

function upgradeManifest(projectDir: string, manifest: InstallManifest): InstallManifestV2 {
  if (manifest.version === 2) return manifest;
  const legacy = manifest as InstallManifestV1;
  const root = resolve(projectDir);
  return {
    version: 2, createdAt: legacy.createdAt, updatedAt: legacy.updatedAt,
    repository: { rootIdentity: createHash("sha256").update(realpathSync(root)).digest("hex"), dirtyChoice: "legacy-unknown", baselineComplete: false },
    files: legacy.files.map((entry) => ({ ...entry, category: categorizeOwnedPath(entry.path, entry.mode), installedSha256: entry.sha256 })),
    dependencies: legacy.dependencies,
  };
}

export function categorizeOwnedPath(path: string, mode?: string): InstallOwnershipCategory {
  if (path.startsWith(".tickets/")) return "tickets";
  if (/rafi-plan|plans?\//i.test(path)) return "plans";
  if (/\/(?:skills)\//.test(`/${path}`)) return "skills";
  if (/\/(?:agents)\//.test(`/${path}`)) return "agents";
  if (/rules/i.test(path) || ["AGENTS.md", "CLAUDE.md"].includes(path)) return "rules";
  if (path === ".gitignore") return "managed-gitignore";
  if (path === "rafi-config.yaml" || path.endsWith("config.yaml")) return "config";
  if (path.startsWith(".rafi/") || path.startsWith(".foreman/")) return "runtime-state";
  if (/\.(?:md|mdx)$/i.test(path)) return mode === "modified" ? "documentation-modified" : "documentation-created";
  return "generated-other";
}

function gitValue(cwd: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { return undefined; }
}

function validateRecoveryId(value: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(value)) throw new Error(`invalid recovery ID: ${value}`);
  return value;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
