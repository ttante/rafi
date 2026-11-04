// `rafi reset`'s working-tree actions (ARCH 8.9; C154; FLAG-RE-1..3). Restart-current keeps the branch and your
// files, then the cleanup: stash (tracked files only, no -u), discard (tracked files back to HEAD) or handled
// (nothing). Archive-restart commits the unfinished tracked work to `rafi/archive/<run>` through a temporary index
// and `update-ref` of that one branch, then puts the tracked files back at HEAD. Argument arrays only; never a push,
// `--force`, `clean`, a branch deletion or a remote call; untracked files are never touched.
import path from "node:path";
import type { Env, ExecOptions, ExecResult } from "../deps/types.js";

export interface ResetGit {
  git(args: string[], o: ExecOptions): Promise<ExecResult>;
  env: Env;
}

export type ResetAction = { action: "restart-current"; cleanup: "stash" | "discard" | "handled"; run: string } |
  { action: "archive-restart"; cleanup: null; run: string };

export type ResetOutcome = { ok: true; archive: string | null; lines: string[] } | { ok: false; message: string };

const IDENTITY: readonly string[] = Object.freeze(["-c", "user.name=rafi", "-c", "user.email=rafi@localhost"]);

async function run(deps: ResetGit, cwd: string, args: string[], env: Env = deps.env): Promise<string> {
  const r = await deps.git(args, { cwd, env });
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
