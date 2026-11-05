// Every git call rafi's delivery makes (M5 slice 5). Argument arrays only. C197 (Q1 a): each call gets
// `-c core.hooksPath=<an empty folder under .rafi/cache>`, so no repository hook runs (a worktree is agent-writable,
// and `core.hooksPath` may name a folder in it); commits, merges and pushes also pass `--no-verify` where git has it.
// Rafi passes no identity (C195): with none configured, the commit fails with git's own message.
import path from "node:path";
import type { Env, ExecOptions, ExecResult, Fs } from "../deps/types.js";

export interface GitDeps {
  git(args: string[], o: ExecOptions): Promise<ExecResult>;
  env: Env;
}

/** Where rafi's git calls run from: the main checkout (the log, the hooks folder) and the folder of this call. */
export interface GitAt {
  readonly deps: GitDeps;
  /** The main checkout (its `.rafi/cache/no-hooks` is the empty hooks folder). */
  readonly project: string;
}

export class GitFailed extends Error {
  constructor(readonly args: readonly string[], readonly result: ExecResult) {
    super(`git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""} failed: ` +
      `${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""}`);
  }
}

export const noHooks = (project: string): string[] =>
  ["-c", `core.hooksPath=${path.join(project, ".rafi", "cache", "no-hooks")}`];

/** C201, C229: git couldn't write its own files (a full disk, a read-only folder): C155's storage stop, not a unit
 * failure. `code` is what the CLI's storage line reads; `folder` the folder git ran in. */
export class GitStorage extends Error {
  constructor(readonly code: string, readonly folder: string, text: string) { super(text); }
}

const NO_SPACE = /unable to write new index file|No space left on device|Disk quota exceeded/i;
const READ_ONLY = /Read-only file system|Permission denied.*\.git\b/i;

/** One git call; the result whatever its exit code (a storage failure throws GitStorage). */
export async function gitTry(at: GitAt, cwd: string, args: readonly string[], env?: Env): Promise<ExecResult> {
  const r = await at.deps.git([...noHooks(at.project), ...args], { cwd, env: env ?? at.deps.env });
  const text = r.stderr.trim().split("\n")[0] ?? "";
  if (r.code !== 0 && NO_SPACE.test(r.stderr)) throw new GitStorage("ENOSPC", cwd, text);
  if (r.code !== 0 && READ_ONLY.test(r.stderr)) throw new GitStorage("EROFS", cwd, text);
  return r;
}

/** One git call that must succeed; its trimmed stdout. */
export async function gitOut(at: GitAt, cwd: string, args: readonly string[], env?: Env): Promise<string> {
  const r = await gitTry(at, cwd, args, env);
  if (r.code !== 0) throw new GitFailed(args, r);
  return r.stdout.trim();
}

/**
 * Speed (M5 10.9): a checkout's HEAD read from its git folder: the main checkout's `.git/HEAD`, or a worktree's
 * (`.git` names its folder; `commondir` names the shared one), and the branch's commit from a loose ref. Null when
 * the files don't say (a packed ref, a detached or missing HEAD): then the caller asks git.
 */
export async function headFromFiles(fs: Fs, dir: string): Promise<{ branch: string; sha: string | null } | null> {
  try {
    const dotGit = path.join(dir, ".git");
    const stat = await fs.stat(dotGit);
    let gitDir = dotGit;
    let common = dotGit;
    if (stat?.kind === "file") {
      const linked = /^gitdir: (.+)$/m.exec(await fs.read(dotGit))?.[1]?.trim();
      if (!linked) return null;
      gitDir = path.resolve(dir, linked);
      const pointer = path.join(gitDir, "commondir");
      const rel = (await fs.stat(pointer)) ? (await fs.read(pointer)).trim() : ".";
      common = path.resolve(gitDir, rel);
    } else if (stat?.kind !== "dir") return null;
    const ref = /^ref: refs\/heads\/(\S+)$/.exec((await fs.read(path.join(gitDir, "HEAD"))).trim())?.[1];
    if (!ref) return null;
    const file = path.join(common, "refs", "heads", ...ref.split("/"));
    const sha = (await fs.stat(file)) ? (await fs.read(file)).trim() : null;
    return { branch: ref, sha: sha && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null };
  } catch {
    return null;
  }
}

/** Part 6: paths from a `-z` listing, git's own bytes (with `core.quotePath`, a plain listing C-quotes any name
 * with a non-ASCII byte or a control character: `"src/Caf\303\251.tsx"`). */
export const nulPaths = (out: string): string[] => out.split("\0").filter(Boolean);

/** A ref's commit, or null when it doesn't exist. */
export async function revOf(at: GitAt, cwd: string, ref: string): Promise<string | null> {
  const r = await gitTry(at, cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}
