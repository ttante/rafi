import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GitCommandResult {
  stdout: string;
}

export interface BaseWorktreeCleanOptions {
  allowedDirtyPaths?: string[];
}

export function runGit(cwd: string, args: string[]): GitCommandResult {
  const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { stdout: stdout.trim() };
}

export function currentGitRef(cwd: string): string {
  const branch = runGit(cwd, ["branch", "--show-current"]).stdout;
  return branch || "HEAD";
}

export function generatedTrackerDirtyPaths(paths: { stateDb: string; progressDoc: string; archiveDoc?: string }): string[] {
  const stateDb = normalizeRepoPath(paths.stateDb);
  const progressDoc = normalizeRepoPath(paths.progressDoc);
  const out = [
    stateDb,
    `${stateDb}-wal`,
    `${stateDb}-shm`,
    progressDoc,
    `${progressDoc}.tmp`,
  ];
  if (paths.archiveDoc) {
    const archiveDoc = normalizeRepoPath(paths.archiveDoc);
    out.push(archiveDoc, `${archiveDoc}.tmp`);
  }
  return out;
}

export function collectBaseWorktreeDirtyPaths(cwd: string, opts: BaseWorktreeCleanOptions = {}): string[] {
  const allowedDirtyPaths = new Set([".tickets/.gitignore", ...(opts.allowedDirtyPaths ?? []).map(normalizeRepoPath)]);
  const status = runGit(cwd, ["status", "--porcelain", "--untracked-files=all"]).stdout;
  return status.split("\n").filter(Boolean).filter((line) => {
    const path = normalizeRepoPath(line.slice(3));
    return !path.startsWith(".foreman/") && !allowedDirtyPaths.has(path);
  });
}

export function ensureCleanBaseWorktree(cwd: string, opts: BaseWorktreeCleanOptions = {}): void {
  const dirty = collectBaseWorktreeDirtyPaths(cwd, opts);
  if (dirty.length > 0) {
    throw new Error(`base worktree has uncommitted changes:\n${dirty.join("\n")}`);
  }
}

export function ensureForemanExcluded(cwd: string): void {
  const excludePath = join(cwd, ".git", "info", "exclude");
  if (!existsSync(excludePath)) return;
  const line = ".foreman/";
  if (readFileSync(excludePath, "utf8").split(/\r?\n/).includes(line)) return;
  appendFileSync(excludePath, `\n${line}\n`, "utf8");
}

export function createTicketWorktree(
  projectDir: string,
  runId: string,
  branch: string,
  base: string,
): string {
  const worktreePath = join(projectDir, ".foreman", "worktrees", runId, branch.replace(/\//g, "__"));
  mkdirSync(dirname(worktreePath), { recursive: true });
  runGit(projectDir, ["worktree", "add", "-b", branch, worktreePath, base]);
  return worktreePath;
}

export function findWorktreeForBranch(projectDir: string, branch: string): string | undefined {
  const output = runGit(projectDir, ["worktree", "list", "--porcelain"]).stdout;
  let worktree: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) worktree = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}` && worktree) return worktree;
    if (!line.trim()) worktree = undefined;
  }
  return undefined;
}

export function removeTicketWorktree(projectDir: string, worktreePath: string): void {
  try {
    runGit(projectDir, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    rmSync(worktreePath, { recursive: true, force: true });
  }
}

export function currentWorktreeBranch(worktreePath: string): string {
  return runGit(worktreePath, ["branch", "--show-current"]).stdout;
}

export function hasTrackerChanges(
  worktreePath: string,
  paths: { progressDoc?: string; archiveDoc?: string } = {},
): boolean {
  const progressDoc = normalizeRepoPath(paths.progressDoc ?? "docs/ticket-progress.md");
  const archiveDoc = normalizeRepoPath(paths.archiveDoc ?? "docs/ticket-archive.md");
  const pathspecs = [
    ".tickets",
    progressDoc,
    `${progressDoc}.tmp`,
    archiveDoc,
    `${archiveDoc}.tmp`,
    "docs/ticket-progress.md",
    "ticket-progress.md",
  ];
  const status = runGit(worktreePath, ["status", "--porcelain", "--", ...unique(pathspecs)]).stdout;
  return status.trim().length > 0;
}

export function hasWorktreeChanges(worktreePath: string): boolean {
  return runGit(worktreePath, ["status", "--porcelain"]).stdout.trim().length > 0;
}

export function commitAll(worktreePath: string, message: string): string | undefined {
  if (!hasWorktreeChanges(worktreePath)) return undefined;
  runGit(worktreePath, ["add", "-A"]);
  runGit(worktreePath, ["commit", "-m", message]);
  return runGit(worktreePath, ["rev-parse", "--short", "HEAD"]).stdout;
}

export function headCommitIfAhead(worktreePath: string, base: string): string | undefined {
  try {
    const count = Number.parseInt(runGit(worktreePath, ["rev-list", "--count", `${base}..HEAD`]).stdout, 10);
    if (!Number.isInteger(count) || count < 1) return undefined;
    return runGit(worktreePath, ["rev-parse", "--short", "HEAD"]).stdout;
  } catch {
    return undefined;
  }
}

export function pushBranch(worktreePath: string, branch: string): void {
  runGit(worktreePath, ["push", "-u", "origin", branch]);
}

export function mergeBranchToLocalBase(
  projectDir: string,
  branch: string,
  baseBranch: string,
  message: string,
  method: "squash" | "merge" | "rebase" = "squash",
): string {
  if (method === "rebase") runGit(projectDir, ["rebase", baseBranch, branch]);
  if (currentGitRef(projectDir) !== baseBranch) {
    runGit(projectDir, ["checkout", baseBranch]);
  }
  if (method === "squash") {
    runGit(projectDir, ["merge", "--squash", branch]);
    runGit(projectDir, ["commit", "-m", message]);
  } else if (method === "merge") {
    runGit(projectDir, ["merge", "--no-ff", branch, "-m", message]);
  } else {
    runGit(projectDir, ["merge", "--ff-only", branch]);
  }
  return runGit(projectDir, ["rev-parse", "--short", "HEAD"]).stdout;
}

/** Compatibility export for callers compiled against the older helper. */
export function squashMergeBranchToLocalBase(projectDir: string, branch: string, baseBranch: string, message: string): string {
  return mergeBranchToLocalBase(projectDir, branch, baseBranch, message, "squash");
}

export function deleteLocalBranch(projectDir: string, branch: string): void {
  try {
    runGit(projectDir, ["branch", "-D", branch]);
  } catch {
    // Branch cleanup is best-effort; worktree removal already frees the checkout.
  }
}

function normalizeRepoPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
