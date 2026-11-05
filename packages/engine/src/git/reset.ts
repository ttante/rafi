// `rafi reset`'s working-tree actions (ARCH 8.9; C154; FLAG-RE-1..3). Restart-current keeps the branch and your
// files, then the cleanup: stash (tracked files only, no -u), discard (tracked files back to HEAD) or handled
// (nothing). Archive-restart commits the unfinished tracked work to `rafi/archive/<run>` through a temporary index
// and `update-ref` of that one branch, then puts the tracked files back at HEAD. Argument arrays only; never a push,
// `--force`, `clean`, a branch deletion or a remote call; untracked files are never touched.
import path from "node:path";
import type { Env, ExecOptions, ExecResult } from "../deps/types.js";
import { hooksOff } from "../facts/snapshot.js";

export interface ResetGit {
  git(args: string[], o: ExecOptions): Promise<ExecResult>;
  env: Env;
}

export type ResetAction = { action: "restart-current"; cleanup: "stash" | "discard" | "handled"; run: string } |
  { action: "archive-restart"; cleanup: null; run: string };

export type ResetOutcome = { ok: true; archive: string | null; lines: string[] } | { ok: false; message: string };

const IDENTITY: readonly string[] = Object.freeze(["-c", "user.name=rafi", "-c", "user.email=rafi@localhost"]);

async function run(deps: ResetGit, cwd: string, args: string[], env: Env = deps.env): Promise<string> {
  const r = await deps.git(args, { cwd, env: hooksOff(env, cwd) });
  if (r.code !== 0) throw new Error(`git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""} ` +
    `failed: ${r.stderr.trim().split("\n")[0]}`);
  return r.stdout.trim();
}

/** Tracked files back as HEAD has them; untracked files stay. */
const restoreTracked = (deps: ResetGit, cwd: string) =>
  run(deps, cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ":/"]);

async function changedTracked(deps: ResetGit, cwd: string): Promise<boolean> {
  return (await run(deps, cwd, ["status", "--porcelain", "--untracked-files=no"])) !== "";
}

async function archive(deps: ResetGit, cwd: string, runId: string, index: string): Promise<string> {
  const branch = `rafi/archive/${runId}`;
  const env = { ...deps.env, GIT_INDEX_FILE: index };
  await run(deps, cwd, ["read-tree", "HEAD"], env);
  await run(deps, cwd, ["add", "-u", "--", ":/"], env);
  const tree = await run(deps, cwd, ["write-tree"], env);
  const commit = await run(deps, cwd, [...IDENTITY, "commit-tree", tree, "-p", "HEAD", "-m",
    `rafi: unfinished work of build ${runId}, archived by rafi reset`]);
  await run(deps, cwd, ["update-ref", `refs/heads/${branch}`, commit, ""]);
  return branch;
}

/** The worktrees (other than your checkout) whose branch is one of `branches`, from `git worktree list`. */
async function treesOf(deps: ResetGit, cwd: string, branches: readonly string[]): Promise<string[]> {
  const out = await run(deps, cwd, ["worktree", "list", "--porcelain"]);
  const main = path.resolve(cwd);
  return out.split("\n\n").map((block) => ({ dir: /^worktree (.+)$/m.exec(block)?.[1] ?? "",
    branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "" }))
    .filter((t) => t.dir && path.resolve(t.dir) !== main && branches.includes(t.branch)).map((t) => t.dir);
}

/**
 * C261: a build that worked in worktrees (per-ticket or batch branches) is reset where it worked: in each of its
 * worktrees with changes to tracked files, never your checkout, so your own edits and untracked files there stay as
 * they are. A build that worked in your checkout is reset there, as before. Archives are `rafi/archive/<run>`, then
 * `-2`, `-3` for further worktrees.
 */
export async function resetTrees(deps: ResetGit, cwd: string, a: ResetAction, branches: readonly string[]):
  Promise<ResetOutcome> {
  let trees: string[];
  try { trees = branches.length ? await treesOf(deps, cwd, branches) : []; } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  if (!trees.length) return resetWorktree(deps, cwd, a);
  const lines: string[] = [];
  let archive: string | null = null;
  let n = 0;
  for (const dir of trees) {
    if (!(await changedTracked(deps, dir).catch(() => false))) continue;
    const named = { ...a, run: n++ ? `${a.run}-${n}` : a.run };
    const done = await resetWorktree(deps, dir, named);
    if (!done.ok) return done;
    archive ??= done.archive;
    lines.push(`In ${path.relative(cwd, dir)}: ${done.lines.join(" ")}`);
  }
  return { ok: true, archive, lines: lines.length ? [...lines, "Your checkout was left as it is."]
    : ["The build's worktrees have no changes to tracked files; your checkout was left as it is."] };
}

export async function resetWorktree(deps: ResetGit, cwd: string, a: ResetAction, o: { index?: string } = {}):
  Promise<ResetOutcome> {
  try {
    if (a.action === "archive-restart") {
      const index = o.index ?? path.resolve(cwd, await run(deps, cwd, ["rev-parse", "--git-path",
        `rafi-reset-index-${a.run}`]));
      const branch = await archive(deps, cwd, a.run, index);
      await restoreTracked(deps, cwd);
      return { ok: true, archive: branch, lines: [`The unfinished work is on ${branch}; your files are back at the ` +
        "branch's last commit. Untracked files were left alone."] };
    }
    if (a.cleanup === "handled" || !(await changedTracked(deps, cwd))) {
      return { ok: true, archive: null, lines: ["Your files were left as they are."] };
    }
    if (a.cleanup === "stash") {
      await run(deps, cwd, [...IDENTITY, "stash", "push", "--message", `rafi reset ${a.run}`]);
      return { ok: true, archive: null, lines: [`Your changes to tracked files are in a stash ("rafi reset ` +
        `${a.run}"); \`git stash pop\` brings them back. Untracked files were left alone.`] };
    }
    await restoreTracked(deps, cwd);
    return { ok: true, archive: null, lines: ["Tracked files are back at the branch's last commit; untracked files " +
      "were left alone."] };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
