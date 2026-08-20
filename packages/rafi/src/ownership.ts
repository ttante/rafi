import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { InstallDependencyV1, InstallManifestEntryV1, InstallManifestV1 } from "rafi-spec";

export const INSTALL_MANIFEST = ".rafi/install-manifest.json";
export const OWNERSHIP_BACKUPS = ".rafi/ownership-backups";

export function readInstallManifest(projectDir: string): InstallManifestV1 | undefined {
  const path = join(resolve(projectDir), INSTALL_MANIFEST);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as InstallManifestV1;
  validateInstallManifest(projectDir, value);
  return value;
}

export function registerOwnedFile(
  projectDir: string,
  relativePath: string,
  input: Omit<InstallManifestEntryV1, "path" | "sha256"> & { sha256?: string | null },
): InstallManifestV1 {
  const root = resolve(projectDir);
  const safe = validateOwnedPath(root, relativePath);
  const current = readInstallManifest(root) ?? emptyManifest();
  const entry: InstallManifestEntryV1 = { path: safe, sha256: input.sha256 ?? fingerprint(join(root, safe)), ...input };
  const files = [...current.files.filter((item) => item.path !== safe), entry].sort((a, b) => a.path.localeCompare(b.path));
  return writeManifest(root, { ...current, files, updatedAt: new Date().toISOString() });
}

/** Capture an exact pre-Rafi file before a managed write. */
export function capturePreimage(projectDir: string, relativePath: string, origin: string): InstallManifestEntryV1 {
  const root = resolve(projectDir);
  const safe = validateOwnedPath(root, relativePath);
  const recorded = readInstallManifest(root)?.files.find((entry) => entry.path === safe);
  if (recorded?.mode === "created" || recorded?.mode === "generated") return { ...recorded };
  const absolute = join(root, safe);
  if (!existsSync(absolute)) return { path: safe, sha256: null, mode: "created", origin };
  if (!lstatSync(absolute).isFile()) throw new Error(`ownership target is not a regular file: ${safe}`);
  const backupDir = join(root, OWNERSHIP_BACKUPS);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const backup = `${createHash("sha256").update(safe).digest("hex")}.original`;
  const backupPath = join(backupDir, backup);
  if (!existsSync(backupPath)) copyFileSync(absolute, backupPath);
  return { path: safe, sha256: fingerprint(absolute), mode: "modified", origin, backup: `${OWNERSHIP_BACKUPS}/${backup}` };
}

export function finalizeOwnedWrite(projectDir: string, entry: InstallManifestEntryV1): InstallManifestV1 {
  return registerOwnedFile(projectDir, entry.path, { ...entry, sha256: fingerprint(join(resolve(projectDir), entry.path)) });
}

export function registerDependency(projectDir: string, dependency: InstallDependencyV1): InstallManifestV1 {
  const current = readInstallManifest(projectDir) ?? emptyManifest();
  const dependencies = [...current.dependencies.filter((item) => !(item.manager === dependency.manager && item.package === dependency.package)), dependency];
  return writeManifest(projectDir, { ...current, dependencies, updatedAt: new Date().toISOString() });
}

export function validateInstallManifest(projectDir: string, manifest: InstallManifestV1): void {
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.dependencies)) throw new Error("invalid install manifest");
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

function emptyManifest(now = new Date()): InstallManifestV1 {
  const stamp = now.toISOString();
  return { version: 1, createdAt: stamp, updatedAt: stamp, files: [], dependencies: [] };
}

function writeManifest(projectDir: string, manifest: InstallManifestV1): InstallManifestV1 {
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

export function removeOwnedPathsTransaction(projectDir: string, paths: string[]): { runId: string; removed: string[] } {
  const root = resolve(projectDir);
  const safePaths = [...new Set(paths.map((path) => validateOwnedPath(root, path)))].sort((a, b) => b.length - a.length);
  const runId = randomUUID();
  const transactionRoot = join(root, ".rafi-uninstall", runId);
  const quarantine = join(transactionRoot, "quarantine");
  mkdirSync(quarantine, { recursive: true, mode: 0o700 });
  const journal = { version: 1, runId, startedAt: new Date().toISOString(), operations: [] as Array<{ path: string; status: string }> };
  writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  const moved: Array<{ source: string; destination: string }> = [];
  try {
    for (const safe of safePaths) {
      const source = join(root, safe);
      if (!existsSync(source)) continue;
      const destination = join(quarantine, safe);
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(source, destination);
      moved.push({ source, destination });
      journal.operations.push({ path: safe, status: "quarantined" });
      writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    }
    rmSync(quarantine, { recursive: true, force: true });
    journal.operations.forEach((operation) => { operation.status = "removed"; });
    writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    return { runId, removed: journal.operations.map((operation) => operation.path) };
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
