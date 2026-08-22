import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

export interface QaChangeManifest { diffDigest: string; untracked: Array<{ path: string; kind: "file" | "symlink"; mode: number; digest: string }> }
export interface DisposableQaSnapshot { path: string; manifest: QaChangeManifest; verify(): void; qaChanges(): string[]; remove(): void }

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

export function changeManifest(worktree: string): QaChangeManifest {
  const diff = execFileSync("git", ["-C", worktree, "diff", "--binary", "HEAD"], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
  const untracked = untrackedPaths(worktree).map((path) => {
    const absolute = join(worktree, path); const stat = lstatSync(absolute); const kind = stat.isSymbolicLink() ? "symlink" as const : "file" as const;
    const bytes = kind === "symlink" ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    return { path, kind, mode: stat.mode & 0o7777, digest: createHash("sha256").update(bytes).digest("hex") };
  });
  return { diffDigest: createHash("sha256").update(diff).digest("hex"), untracked };
}

function untrackedPaths(worktree: string): string[] {
  const raw = execFileSync("git", ["-C", worktree, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer" });
  return raw.toString().split("\0").filter(Boolean).sort();
}
function copyUntracked(source: string, target: string, path: string): void {
  const from = join(source, path); const to = join(target, path); mkdirSync(dirname(to), { recursive: true });
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) { if (existsSync(to)) rmSync(to, { force: true }); symlinkSync(readlinkSync(from), to); }
  else cpSync(from, to, { preserveTimestamps: true });
}
function manifestDifference(before: QaChangeManifest, after: QaChangeManifest): string[] {
  const changes: string[] = [];
  if (before.diffDigest !== after.diffDigest) changes.push("tracked diff changed");
  const left = new Map(before.untracked.map((item) => [item.path, item])); const right = new Map(after.untracked.map((item) => [item.path, item]));
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) if (JSON.stringify(left.get(path)) !== JSON.stringify(right.get(path))) changes.push(path);
  return changes;
}
