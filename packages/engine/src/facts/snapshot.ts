// The worktree snapshot after each builder turn (ARCH 4.7): a git tree id from a temporary index under
// `.rafi/cache/`, seeded from the real index so only changed files are hashed and `.gitignore` is respected; the
// real index is never touched. Changed files are computed against HEAD's tree. `.rafi/` is rafi's, never listed.
import path from "node:path";
import type { Env, ExecOptions, ExecResult, Fs } from "../deps/types.js";

export interface SnapshotDeps {
  git(args: string[], o: ExecOptions): Promise<ExecResult>;
  fs: Fs;
  env: Env;
}

export type Snapshot = { ok: true; tree: string; base: string; files: string[] } | { ok: false; noCommit: true };

const RAFI_DIR = /^\.rafi(\/|$)/;

async function git(deps: SnapshotDeps, cwd: string, args: string[], env: Env = deps.env): Promise<string> {
  const r = await deps.git(args, { cwd, env });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split("\n")[0]}`);
  return r.stdout.trim();
}

export async function snapshot(deps: SnapshotDeps, cwd: string, key = "snapshot"): Promise<Snapshot> {
  const head = await deps.git(["rev-parse", "--verify", "-q", "HEAD^{tree}"], { cwd, env: deps.env });
  if (head.code !== 0) return { ok: false, noCommit: true };
  const base = head.stdout.trim();
  const cache = path.join(cwd, ".rafi", "cache");
  await deps.fs.mkdir(cache);
  const index = path.join(cache, `index-${key}`);
  const real = path.resolve(cwd, await git(deps, cwd, ["rev-parse", "--git-path", "index"]));
  if (await deps.fs.stat(real)) await deps.fs.writeAtomic(index, await deps.fs.readBytes(real));
  const env = { ...deps.env, GIT_INDEX_FILE: index };
  try {
    await git(deps, cwd, ["add", "-A", "--", ".", ":(exclude).rafi"], env);
    const tree = await git(deps, cwd, ["write-tree"], env);
    const diff = await git(deps, cwd, ["diff", "--name-only", "--no-renames", base, tree]);
    const files = diff ? diff.split("\n").filter((f) => !RAFI_DIR.test(f)).sort() : [];
    return { ok: true, tree, base, files };
  } finally {
    await deps.fs.remove(index);
  }
}

/** Files changed between two trees (for staleness and QA restore), rafi's folder left out. */
export async function changedBetween(deps: SnapshotDeps, cwd: string, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  const diff = await git(deps, cwd, ["diff", "--name-only", "--no-renames", from, to]);
  return diff ? diff.split("\n").filter((f) => !RAFI_DIR.test(f)).sort() : [];
}

/**
 * Puts the worktree's `files` back as they are in `tree` (QA's runs, ARCH 6.9): files the tree doesn't have were
 * added by the run and are removed; the rest are restored from it. One `git restore` with a path the tree lacks
 * fails as a whole, so the two are split (threat-model 10.7, threat 12).
 */
export async function restoreTree(deps: SnapshotDeps, cwd: string, tree: string, files: readonly string[]):
  Promise<void> {
  if (!files.length) return;
  const known = new Set((await git(deps, cwd, ["ls-tree", "-r", "--name-only", tree, "--", ...files]))
    .split("\n").filter(Boolean));
  for (const file of files.filter((f) => !known.has(f))) await deps.fs.remove(path.join(cwd, file));
  const kept = files.filter((f) => known.has(f));
  if (kept.length) await git(deps, cwd, ["restore", `--source=${tree}`, "--worktree", "--", ...kept]);
}
