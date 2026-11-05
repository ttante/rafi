// The worktree snapshot after each builder turn (ARCH 4.7): a git tree id from a temporary index under
// `.rafi/cache/`, seeded from the real index so only changed files are hashed and `.gitignore` is respected; the
// real index is never touched. Changed files are computed against HEAD's tree. `.rafi/` is rafi's, never listed.
import path from "node:path";
import type { Env, ExecOptions, ExecResult, Fs } from "../deps/types.js";
import { nulPaths } from "../git/run.js";

export interface SnapshotDeps {
  git(args: string[], o: ExecOptions): Promise<ExecResult>;
  fs: Fs;
  env: Env;
}

export type Snapshot = { ok: true; tree: string; base: string; files: string[] } | { ok: false; noCommit: true };

const RAFI_DIR = /^\.rafi(\/|$)/;
/** Rafi's own views (ARCH 3.8; M5 C207) at their default paths: rafi's writes, never the builder's work. */
const VIEWS: readonly string[] = ["docs/ticket-progress.md", "docs/ticket-archive.md"];
const rafis = (f: string) => RAFI_DIR.test(f) || VIEWS.includes(f);

/** Q1 a (C197; M5 10.10): no repository hook runs under rafi's git, set through git's environment config so each
 * call's arguments stay as they are; a hooks folder under `.git` can't exist in a worktree, and agents can't write
 * `.git`. */
export const hooksOff = (env: Env, cwd: string): Env => ({ ...env, GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: path.join(cwd, ".git", "rafi-no-hooks") });

/** `git add` exits 1 when an exclude pathspec names a path `.gitignore` ignores; everything else was staged. */
export const ignoredOnly = (r: ExecResult): boolean => r.code === 1 &&
  /^The following paths are ignored by one of your \.gitignore files:/.test(r.stderr);

async function git(deps: SnapshotDeps, cwd: string, args: string[], env: Env = deps.env): Promise<string> {
  const r = await deps.git(args, { cwd, env: hooksOff(env, cwd) });
  if (r.code !== 0 && !(args[0] === "add" && ignoredOnly(r))) {
    throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split("\n")[0]}`);
  }
  return args.includes("-z") ? r.stdout : r.stdout.trim();
}

/** The real index's path without a git call when the folder is a repo's top (`.git` a folder, or a worktree's
 * `gitdir:` file); otherwise git says (M3 section 6: fewer git spawns per snapshot). */
async function realIndex(deps: SnapshotDeps, cwd: string): Promise<string> {
  const dotGit = path.join(cwd, ".git");
  const stat = await deps.fs.stat(dotGit);
  if (stat?.kind === "dir") return path.join(dotGit, "index");
  if (stat?.kind === "file") {
    const linked = /^gitdir: (.+)$/m.exec(await deps.fs.read(dotGit))?.[1]?.trim();
    if (linked) return path.join(path.resolve(cwd, linked), "index");
  }
  return path.resolve(cwd, await git(deps, cwd, ["rev-parse", "--git-path", "index"]));
}

/** HEAD's commit read from the git folder (a loose ref or a detached HEAD), or null when git must say. */
async function headCommit(fs: Fs, cwd: string): Promise<string | null> {
  const dir = path.join(cwd, ".git");
  if ((await fs.stat(dir))?.kind !== "dir") return null;
  try {
    const head = (await fs.read(path.join(dir, "HEAD"))).trim();
    const ref = /^ref: (refs\/[^\s]+)$/.exec(head)?.[1];
    if (!ref) return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
    const file = path.join(dir, ...ref.split("/"));
    if (!(await fs.stat(file))) return null;
    const sha = (await fs.read(file)).trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** HEAD's tree. M4 (speed): with `heads`, one git call per commit HEAD points at, found by reading the ref. */
async function headTree(deps: SnapshotDeps, cwd: string, heads?: Map<string, string>): Promise<string | null> {
  const commit = heads ? await headCommit(deps.fs, cwd) : null;
  const known = commit ? heads!.get(commit) : undefined;
  if (known) return known;
  const r = await deps.git(["rev-parse", "--verify", "-q", "HEAD^{tree}"], { cwd, env: deps.env });
  if (r.code !== 0) return null;
  const tree = r.stdout.trim();
  if (commit) heads!.set(commit, tree);
  return tree;
}

/** `files: false` gives only the tree (no HEAD lookup, no diff), for callers that compare trees. `heads`: a
 * per-build cache of HEAD commit → tree. */
export async function snapshot(deps: SnapshotDeps, cwd: string, key = "snapshot",
  o: { files?: boolean; heads?: Map<string, string> } = {}): Promise<Snapshot> {
  const listed = o.files !== false;
  const head = listed ? await headTree(deps, cwd, o.heads) : "";
  if (head === null) return { ok: false, noCommit: true };
  const base = head;
  const cache = path.join(cwd, ".rafi", "cache");
  await deps.fs.mkdir(cache);
  const index = path.join(cache, `index-${key}`);
  const real = await realIndex(deps, cwd);
  if (await deps.fs.stat(real)) await deps.fs.writeAtomic(index, await deps.fs.readBytes(real));
  const env = { ...deps.env, GIT_INDEX_FILE: index };
  try {
    await git(deps, cwd, ["add", "-A", "--", ".", ":(exclude).rafi", ...VIEWS.map((v) => `:(exclude)${v}`)], env);
    const tree = await git(deps, cwd, ["write-tree"], env);
    if (!listed) return { ok: true, tree, base, files: [] };
    const files = nulPaths(await git(deps, cwd, ["diff", "--name-only", "--no-renames", "-z", base, tree]))
      .filter((f) => !rafis(f)).sort();
    return { ok: true, tree, base, files };
  } finally {
    await deps.fs.remove(index);
  }
}

/** Files changed between two trees (for staleness and QA restore), rafi's folder left out. */
export async function changedBetween(deps: SnapshotDeps, cwd: string, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  return nulPaths(await git(deps, cwd, ["diff", "--name-only", "--no-renames", "-z", from, to]))
    .filter((f) => !rafis(f)).sort();
}

/**
 * Puts the worktree's `files` back as they are in `tree` (QA's runs, ARCH 6.9): files the tree doesn't have were
 * added by the run and are removed; the rest are restored from it. One `git restore` with a path the tree lacks
 * fails as a whole, so the two are split (threat-model 10.7, threat 12).
 */
export async function restoreTree(deps: SnapshotDeps, cwd: string, tree: string, files: readonly string[]):
  Promise<void> {
  if (!files.length) return;
  const known = new Set(nulPaths(await git(deps, cwd, ["ls-tree", "-r", "--name-only", "-z", tree, "--", ...files])));
  for (const file of files.filter((f) => !known.has(f))) await deps.fs.remove(path.join(cwd, file));
  const kept = files.filter((f) => known.has(f));
  if (kept.length) await git(deps, cwd, ["restore", `--source=${tree}`, "--worktree", "--", ...kept]);
}
