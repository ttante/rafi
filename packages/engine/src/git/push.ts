// Pushes (C198, R13): `git push <remote> refs/heads/<b>:refs/heads/<b>` for a branch rafi recorded making
// (`git.branch_created`; part 6, M5 review P1: any other is refused before the push), or the base after a direct
// merge (`{ base: true }`); never forced, never a deletion, a mirror or tags. Looked up first (`ls-remote`): the
// same commit there is adopted; a refused push looks again and adopts an equal result, else fails as `rejected`.
import type { BuildContext } from "../build/context.js";
import { effect, gitAt, logEvents, recordResult, recorded } from "./intent.js";
import { gitOut, gitTry, revOf } from "./run.js";
import { DeliveryFailed } from "./worktree.js";

export const REMOTE = "origin";

async function remoteTip(ctx: BuildContext, cwd: string, unit: string, branch: string): Promise<string | null> {
  const r = await gitTry(gitAt(ctx), cwd, ["ls-remote", "--heads", REMOTE, `refs/heads/${branch}`]);
  if (r.code !== 0) {
    throw new DeliveryFailed(unit, /could not read|unable to access|timed out|resolve host/i.test(r.stderr)
      ? "transient" : "rejected", `the remote ${REMOTE} can't be read: ${r.stderr.trim().split("\n")[0] ?? ""}`);
  }
  return r.stdout.trim().split(/\s+/)[0] || null;
}

/** Pushes `branch` as it is locally; records `git.pushed` once per commit. */
export async function pushBranch(ctx: BuildContext, cwd: string, unit: string, branch: string,
  o: { base?: boolean } = {}): Promise<string> {
  const at = gitAt(ctx);
  const local = await revOf(at, cwd, `refs/heads/${branch}`);
  if (!local) throw new DeliveryFailed(unit, "rejected", `branch ${branch} is missing, so it can't be pushed.`);
  const events = await logEvents(ctx);
  if (!o.base && !recorded(events, "git.branch_created", (d) => d.branch === branch)) {
    throw new DeliveryFailed(unit, "rejected", `branch ${branch} isn't one rafi made, so rafi doesn't push it.`);
  }
  if (recorded(events, "git.pushed", (d) => d.branch === branch && d.sha === local)) return local;
  // Speed (10.9): no lookup first: a push of what the remote already has succeeds as up to date; only a refusal
  // asks the remote what it has (R13).
  {
    const ref = `refs/heads/${branch}`;
    const r = await effect(ctx, { op: "push", unit, ticket: null, ref, old: null, new: local, tree: null }, branch,
      () => gitTry(at, cwd, ["push", "--no-verify", "--porcelain", REMOTE, `${ref}:${ref}`]));
    if (r.code !== 0 && (await remoteTip(ctx, cwd, unit, branch)) !== local) {
      throw new DeliveryFailed(unit, /non-fast-forward|fetch first|rejected/i.test(r.stderr + r.stdout) ? "rejected"
        : /could not read|unable to access|timed out/i.test(r.stderr) ? "transient" : "rejected",
      `the push of ${branch} was refused (rafi never force-pushes): ${(r.stderr || r.stdout).trim().split("\n")
        .find((l) => /rejected|error|fatal/i.test(l)) ?? "refused"}`);
    }
  }
  await recordResult(ctx, "git.pushed", null, { sha: local, branch, unit });
  return local;
}

/** The base's remote when it tracks one (`main@{upstream}` → origin), else null. */
export async function tracksRemote(ctx: BuildContext, cwd: string, base: string): Promise<boolean> {
  const r = await gitTry(gitAt(ctx), cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${base}@{upstream}`]);
  return r.code === 0 && r.stdout.trim().startsWith(`${REMOTE}/`);
}

export async function hasRemote(ctx: BuildContext): Promise<boolean> {
  const r = await gitTry(gitAt(ctx), ctx.engine.projectDir, ["remote"]);
  return r.code === 0 && r.stdout.split("\n").map((s) => s.trim()).includes(REMOTE);
}

export const headOf = (ctx: BuildContext, cwd: string) => gitOut(gitAt(ctx), cwd, ["rev-parse", "HEAD"]);
