// QA isolation (ARCH 4.7, Q-COPY-1, NEW-COPY-1/2; C118, C119, P25 B). The review runs in place: the builder never
// runs during a review, so there's no copy at the start. Rafi fingerprints your worktree before and after the
// review turn, lightly (its snapshot tree) or in full (High risk, or `qa_isolation: full`). If it changed, the
// in-place verdict is discarded and the review is redone in a copy: a detached git worktree of the builder's
// snapshot under `.rafi/cache/qa-copy/`, made from an unreferenced commit, so no ref moves and the real index isn't
// touched; it's removed (only that path) as soon as the review ends.
import path from "node:path";
import type { TicketV1 } from "rafi-spec/v1";
import type { Clock, ExecOptions, ExecResult, Env, Fs } from "../deps/types.js";
import { fullFingerprint } from "../facts/fingerprint.js";
import { changedBetween, snapshot } from "../facts/snapshot.js";
import { escapeControl } from "../log/redact.js";
import { append, closeSession, type AgentOutcome, type BuildContext } from "./context.js";

export interface CopyDeps {
  git(args: string[], o: ExecOptions): Promise<ExecResult>;
  fs: Pick<Fs, "stat" | "realpath" | "remove">;
  env: Env;
}

export const COPY_ROOT = path.join(".rafi", "cache", "qa-copy");

/** P25 B: full isolation for High risk or `qa_isolation: full`; `why` says which. */
export function isolationFor(ticket: { risk: string; qa_isolation?: string }): { full: boolean; why: string } {
  if (ticket.risk === "High") return { full: true, why: "full fingerprint (High risk)" };
  if (ticket.qa_isolation === "full") return { full: true, why: "full fingerprint (qa_isolation: full)" };
  return { full: false, why: "light fingerprint" };
}

async function git(deps: CopyDeps, cwd: string, args: string[]): Promise<string> {
  const r = await deps.git(args, { cwd, env: deps.env });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split("\n")[0]}`);
  return r.stdout.trim();
}

/**
 * A copy path is only ever a direct child of `<project>/.rafi/cache/qa-copy/`, and none of `.rafi`, `cache`,
 * `qa-copy` or the copy itself may be a symlink (or junction): each one that exists must resolve to the same place
 * under the project's own resolved path, so the copy is never made, or force-removed, anywhere else.
 */
async function checkedCopy(deps: CopyDeps, project: string, dir: string): Promise<string> {
  const base = path.resolve(project, COPY_ROOT);
  const target = path.resolve(dir);
  if (path.dirname(target) !== base || !path.basename(target)) {
    throw new Error(`refusing to touch ${dir}: it's outside .rafi/cache/qa-copy/`);
  }
  let at = path.resolve(project);
  let expected = await deps.fs.realpath(at);
  if (expected === null) throw new Error(`refusing to touch ${dir}: the project folder ${project} doesn't exist`);
  for (const part of [...COPY_ROOT.split(path.sep), path.basename(target)]) {
    at = path.join(at, part);
    expected = path.join(expected, part);
    const real = await deps.fs.realpath(at);
    if (real === null) break;
    if (real !== expected) {
      throw new Error(`refusing to touch ${dir}: ${path.relative(project, at)} is a symlink that leads to ${real}`);
    }
  }
  return target;
}

export async function makeCopy(deps: CopyDeps, project: string, tree: string, name: string): Promise<string> {
  const dir = await checkedCopy(deps, project, path.join(project, COPY_ROOT, name));
  // Threat 1 (10.8): a copy a crash left behind at this path is removed first, never reused.
  if (await deps.fs.stat(dir)) {
    await deps.git(["worktree", "remove", "--force", dir], { cwd: project, env: deps.env });
    await deps.fs.remove(dir, { recursive: true });
  }
  await git(deps, project, ["worktree", "prune"]);
  const commit = await git(deps, project, ["-c", "user.name=rafi", "-c", "user.email=rafi@invalid", "commit-tree",
    tree, "-p", "HEAD", "-m", "rafi: QA copy of the builder's snapshot"]);
  await git(deps, project, ["worktree", "add", "--quiet", "--detach", dir, commit]);
  return dir;
}

export async function removeCopy(deps: CopyDeps, project: string, dir: string): Promise<void> {
  const target = await checkedCopy(deps, project, dir);
  await git(deps, project, ["worktree", "remove", "--force", target]);
  await git(deps, project, ["worktree", "prune"]);
}

const ms = (deps: { clock: Clock }, since: number) => deps.clock.now().getTime() - since;

/**
 * Runs QA's review turn in place, fingerprinting your worktree before and after (C118). On drift: one line, the
 * in-place session closed and its reply discarded, the review redone in a new session rooted at a copy of the
 * builder's snapshot, that session closed, the copy removed (C119, C128). Records `qa.isolation` either way.
 */
export async function isolated(ctx: BuildContext, ticket: TicketV1, r: { id: string; attempt: number },
  before: string | null, review: (root: string) => Promise<AgentOutcome>): Promise<AgentOutcome> {
  const { deps } = ctx;
  const iso = isolationFor(ticket);
  const time = { copy: 0, hash: 0, verify: 0, cleanup: 0 };
  let started = deps.clock.now().getTime();
  const full = iso.full ? await fullFingerprint(deps, ctx.project, `${r.id}-before`) : null;
  time.hash = ms(deps, started);
  const out = await review(ctx.project);
  started = deps.clock.now().getTime();
  const after = await snapshot(deps, ctx.project, `${r.id}-review-after`, { files: false });
  const fullAfter = full ? await fullFingerprint(deps, ctx.project, `${r.id}-after`) : null;
  time.verify = ms(deps, started);
  const drifted = before !== null && after.ok && (after.tree !== before || (full && fullAfter!.fp !== full.fp));
  const size = { files: full?.files ?? 0, bytes: full?.bytes ?? 0 };
  if (!drifted) {
    await append(ctx, r.id, { type: "qa.isolation", data: { mode: "in-place", ...size, ms: time,
      why: `${iso.why} unchanged during the review; no copy, because the builder never runs during a review` } });
    return out;
  }
  const files = after.ok ? await changedBetween(deps, ctx.project, before, after.tree) : [];
  const named = files.map((f) => escapeControl(f)).join(", ") || "your files";
  ctx.ui.line(`${r.id}: source drift during QA's review (${named} changed); QA reviews again in full on a copy of ` +
    "the builder's snapshot. Your changes stay as they are.");
  await closeSession(ctx, r.id, "qa", "verdict");
  started = deps.clock.now().getTime();
  const copy = await makeCopy(deps, ctx.project, before, `${r.id}-${r.attempt}`);
  time.copy = ms(deps, started);
  let redone: AgentOutcome;
  try {
    redone = await review(copy);
  } finally {
    await closeSession(ctx, r.id, "qa", "verdict", copy);
    started = deps.clock.now().getTime();
    await removeCopy(deps, ctx.project, copy);
    time.cleanup = ms(deps, started);
  }
  await append(ctx, r.id, { type: "qa.isolation", data: { mode: "copy", ...size, ms: time,
    why: `source drift: ${named} changed during the in-place review (${iso.why}); redone on a copy` } });
  return redone;
}
