// Building on uncommitted work (C206, PRM-75, FILE-50, S-BATCH-3). Your checkout is dirty when `git status` lists
// anything outside rafi's own files. A build that would make a worktree asks "Uncommitted work found. How should the
// isolated build start?" in a terminal; `--dirty-work` answers it; without either, it exits 1 naming the flag.
// `preserve`: worktrees from your branch's last commit. `include`: a baseline commit of your tracked and
// non-ignored untracked files made through a temporary index (your index, branch and files untouched), recorded
// under `.foreman/dirty-baselines/`, and worktrees from it. Either way the worktrees are kept and no unit merges or
// opens a PR (completion `none`). The choice is recorded with the build's settings, so `rafi resume` keeps it.
import path from "node:path";
import type { Settings } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import type { Fs } from "../deps/types.js";
import { rafisView } from "../tickets/views.js";
import { gitOut, type GitAt } from "./run.js";

export type DirtyMode = "preserve" | "include";

const RAFIS = /^(\.rafi|\.foreman)(\/|$)/;
const VIEW = /^docs\/ticket-(progress|archive)\.md$/;

/** The paths `git status` lists outside rafi's own files (porcelain v2, NUL-separated). Part 6: a view counts as
 * rafi's only while its bytes are the ones rafi last wrote; an edit of yours to it is your uncommitted work. */
export async function dirtyPaths(at: GitAt, cwd: string, fs: Fs): Promise<string[]> {
  const out = await gitOut(at, cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  const paths: string[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i]!;
    if (!p) continue;
    const kind = p[0];
    const file = kind === "?" || kind === "!" ? p.slice(2) : kind === "1" ? p.split(" ").slice(8).join(" ")
      : kind === "2" ? p.split(" ").slice(9).join(" ") : kind === "u" ? p.split(" ").slice(10).join(" ") : "";
    if (kind === "2") i += 1;
    if (kind !== "!" && file && !RAFIS.test(file)) paths.push(file);
  }
  const yours: string[] = [];
  for (const f of paths) if (!VIEW.test(f) || !(await rafisView(fs, at.project, path.join(cwd, f)))) yours.push(f);
  return yours;
}

/** C206 include: the baseline commit, made through a temporary index; your index, branch and files stay as they are. */
export async function baseline(engine: Engine, at: GitAt): Promise<string> {
  const main = engine.projectDir;
  const id = engine.deps.random.id();
  const index = path.join(main, ".rafi", "cache", `dirty-index-${id}`);
  await engine.deps.fs.mkdir(path.dirname(index));
  const env = { ...engine.deps.env, GIT_INDEX_FILE: index };
  try {
    await gitOut(at, main, ["read-tree", "HEAD"], env);
    await gitOut(at, main, ["add", "-A", "--", ".", ":(exclude).rafi", ":(exclude).foreman"], env);
    const tree = await gitOut(at, main, ["write-tree"], env);
    const head = await gitOut(at, main, ["rev-parse", "HEAD"]);
    const commit = await gitOut(at, main, ["commit-tree", tree, "-p", head, "-m",
      "rafi: your uncommitted work, as an isolated build's baseline"]);
    const dir = path.join(main, ".foreman", "dirty-baselines");
    await engine.deps.fs.mkdir(dir);
    await engine.deps.fs.writeAtomic(path.join(dir, `${id}.json`), `${JSON.stringify({ commit, tree, head,
      at: engine.deps.clock.now().toISOString() }, null, 2)}\n`);
    return commit;
  } finally {
    await engine.deps.fs.remove(index).catch(() => undefined);
  }
}

/** Applies the choice to this build's settings (recorded in build.started, so a resume keeps it). */
export function applyDirty(settings: Settings, mode: DirtyMode, base: string | null): void {
  settings.dirty_work = { value: mode, source: "flag" };
  settings["tickets.build.keep_worktrees"] = { value: true, source: "flag" };
  settings["tickets.build.completion"] = { value: "none", source: "flag" };
  if (base) settings["tickets.build.base_branch"] = { value: base, source: "flag" };
}
