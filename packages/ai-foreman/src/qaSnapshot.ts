import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

export interface QaChangeManifest { diffDigest: string; untracked: Array<{ path: string; kind: "file" | "symlink"; mode: number; digest: string }> }
export interface DisposableQaSnapshot { path: string; manifest: QaChangeManifest; verify(): void; qaChanges(): string[]; remove(): void }
export interface AsyncDisposableQaSnapshot { path: string; manifest: QaChangeManifest; verify(): Promise<void>; qaChanges(): Promise<string[]>; remove(): Promise<void> }
export type QaSnapshotProgress = (state: string, detail?: string) => void;

/** Reproduce the Builder's exact change set in a detached disposable worktree. */
export function createDisposableQaSnapshot(builderWorktree: string): DisposableQaSnapshot {
  const source = resolve(builderWorktree);
  const root = execFileSync("git", ["-C", source, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const tempRoot = mkdtempSync(join(tmpdir(), "rafi-qa-"));
  const review = join(tempRoot, "review");
  const head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const added = spawnSync("git", ["-C", root, "worktree", "add", "--detach", review, head], { encoding: "utf8" });
  if (added.status !== 0) { rmSync(tempRoot, { recursive: true, force: true }); throw new Error(`cannot create disposable QA worktree: ${added.stderr.trim()}`); }
  try {
    const diff = execFileSync("git", ["-C", source, "diff", "--binary", "HEAD"], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
    if (diff.length) {
      const applied = spawnSync("git", ["-C", review, "apply", "--index", "--binary", "--whitespace=nowarn", "-"], { input: diff, encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
      if (applied.status !== 0) throw new Error(`cannot apply Builder diff to QA worktree: ${Buffer.from(applied.stderr).toString().trim()}`);
    }
    for (const path of untrackedPaths(source)) copyUntracked(source, review, path);
    const manifest = changeManifest(source);
    const snapshot: DisposableQaSnapshot = {
      path: review, manifest,
      verify: () => {
        const actual = changeManifest(review);
        if (JSON.stringify(actual) !== JSON.stringify(manifest)) throw new Error(`disposable QA snapshot does not match Builder change manifest: expected ${JSON.stringify(manifest)}, got ${JSON.stringify(actual)}`);
      },
      qaChanges: () => manifestDifference(manifest, changeManifest(review)),
      remove: () => {
        spawnSync("git", ["-C", root, "worktree", "remove", "--force", review], { encoding: "utf8" });
        rmSync(tempRoot, { recursive: true, force: true });
      },
    };
    snapshot.verify(); return snapshot;
  } catch (error) {
    spawnSync("git", ["-C", root, "worktree", "remove", "--force", review], { encoding: "utf8" });
    rmSync(tempRoot, { recursive: true, force: true }); throw error;
  }
}

/**
 * Async form used by the live CLI. Git and filesystem work yields to the event
 * loop so the activity reporter can keep animating during large snapshots.
 */
export async function createDisposableQaSnapshotAsync(
  builderWorktree: string,
  progress: QaSnapshotProgress = () => {},
): Promise<AsyncDisposableQaSnapshot> {
  const source = resolve(builderWorktree);
  progress("preparing disposable QA snapshot", "locating Builder worktree");
  const root = (await runGit(source, ["rev-parse", "--show-toplevel"])).toString().trim();
  const tempRoot = await mkdtemp(join(tmpdir(), "rafi-qa-"));
  const review = join(tempRoot, "review");
  const head = (await runGit(source, ["rev-parse", "HEAD"])).toString().trim();
  progress("preparing disposable QA snapshot", "creating detached review worktree");
  try {
    await runGit(root, ["worktree", "add", "--detach", review, head]);
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error(`cannot create disposable QA worktree: ${errorMessage(error)}`);
  }

  try {
    progress("preparing disposable QA snapshot", "copying tracked Builder changes");
    const diff = await runGit(source, ["diff", "--binary", "HEAD"]);
    if (diff.length) {
      try {
        await runGit(review, ["apply", "--index", "--binary", "--whitespace=nowarn", "-"], diff);
      } catch (error) {
        throw new Error(`cannot apply Builder diff to QA worktree: ${errorMessage(error)}`);
      }
    }

    const paths = await untrackedPathsAsync(source);
    for (let index = 0; index < paths.length; index++) {
      progress("preparing disposable QA snapshot", `copying untracked files ${index + 1}/${paths.length}`);
      await copyUntrackedAsync(source, review, paths[index]!);
    }

    progress("preparing disposable QA snapshot", "recording Builder change manifest");
    const manifest = await changeManifestAsync(source, progress, "preparing disposable QA snapshot");
    const snapshot: AsyncDisposableQaSnapshot = {
      path: review,
      manifest,
      verify: async () => {
        const actual = await changeManifestAsync(review, progress, "preparing disposable QA snapshot");
        if (JSON.stringify(actual) !== JSON.stringify(manifest)) {
          throw new Error(`disposable QA snapshot does not match Builder change manifest: expected ${JSON.stringify(manifest)}, got ${JSON.stringify(actual)}`);
        }
      },
      qaChanges: async () => manifestDifference(manifest, await changeManifestAsync(review, progress)),
      remove: async () => {
        progress("cleaning up disposable QA snapshot", "removing detached review worktree");
        await runGit(root, ["worktree", "remove", "--force", review]).catch(() => {});
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
    progress("preparing disposable QA snapshot", "verifying review copy");
    await snapshot.verify();
    return snapshot;
  } catch (error) {
    await runGit(root, ["worktree", "remove", "--force", review]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export function changeManifest(worktree: string): QaChangeManifest {
  const diff = execFileSync("git", ["-C", worktree, "diff", "--binary", "HEAD"], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
  const untracked = untrackedPaths(worktree).map((path) => {
    const absolute = join(worktree, path); const stat = lstatSync(absolute); const kind = stat.isSymbolicLink() ? "symlink" as const : "file" as const;
    const bytes = kind === "symlink" ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    return { path, kind, mode: stat.mode & 0o7777, digest: createHash("sha256").update(bytes).digest("hex") };
  });
  return { diffDigest: createHash("sha256").update(diff).digest("hex"), untracked };
}

export async function changeManifestAsync(
  worktree: string,
  progress: QaSnapshotProgress = () => {},
  state = "checking QA file changes",
): Promise<QaChangeManifest> {
  const diff = await runGit(worktree, ["diff", "--binary", "HEAD"]);
  const paths = await untrackedPathsAsync(worktree);
  const untracked: QaChangeManifest["untracked"] = [];
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index]!;
    progress(state, `hashing untracked files ${index + 1}/${paths.length}`);
    const absolute = join(worktree, path);
    const stat = await lstat(absolute);
    const kind = stat.isSymbolicLink() ? "symlink" as const : "file" as const;
    const bytes = kind === "symlink" ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
    untracked.push({ path, kind, mode: stat.mode & 0o7777, digest: createHash("sha256").update(bytes).digest("hex") });
  }
  return { diffDigest: createHash("sha256").update(diff).digest("hex"), untracked };
}

function untrackedPaths(worktree: string): string[] {
  const raw = execFileSync("git", ["-C", worktree, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer" });
  return raw.toString().split("\0").filter(Boolean).sort();
}
async function untrackedPathsAsync(worktree: string): Promise<string[]> {
  const raw = await runGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return raw.toString().split("\0").filter(Boolean).sort();
}
function copyUntracked(source: string, target: string, path: string): void {
  const from = join(source, path); const to = join(target, path); mkdirSync(dirname(to), { recursive: true });
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) { if (existsSync(to)) rmSync(to, { force: true }); symlinkSync(readlinkSync(from), to); }
  else cpSync(from, to, { preserveTimestamps: true });
}
async function copyUntrackedAsync(source: string, target: string, path: string): Promise<void> {
  const from = join(source, path); const to = join(target, path); await mkdir(dirname(to), { recursive: true });
  const stat = await lstat(from);
  if (stat.isSymbolicLink()) {
    await rm(to, { force: true });
    await symlink(await readlink(from), to);
  } else {
    await cp(from, to, { preserveTimestamps: true });
  }
}

function runGit(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout));
      else reject(new Error(Buffer.concat(stderr).toString().trim() || `git exited with status ${code ?? "unknown"}`));
    });
    child.stdin.end(input);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function manifestDifference(before: QaChangeManifest, after: QaChangeManifest): string[] {
  const changes: string[] = [];
  if (before.diffDigest !== after.diffDigest) changes.push("tracked diff changed");
  const left = new Map(before.untracked.map((item) => [item.path, item])); const right = new Map(after.untracked.map((item) => [item.path, item]));
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) if (JSON.stringify(left.get(path)) !== JSON.stringify(right.get(path))) changes.push(path);
  return changes;
}
