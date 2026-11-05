// Delivery conflicts (ARCH 4.3.2; C237, C240). A conflict fix ticket (`ticket.added {source: conflict, unit}`) works
// in its unit's existing worktree: rafi starts merging the base's tip into the unit's branch there (agents can't
// write git's files), the builder edits the conflicted files, the check step adds "no conflict markers", and the
// deliver step commits the merge with both parents. A PR the provider reports conflicting gets the base merged into
// its branch by rafi; when only rafi's own views conflict, rafi writes them as the last safe point did, commits
// and pushes without force; any other conflicted path fails the unit as `conflict`.
import path from "node:path";
import type { BuildContext } from "../build/context.js";
import type { StepResult } from "../build/checks.js";
import { nextRun } from "../facts/runs.js";
import { optionalBlob } from "../log/blobs.js";
import { effect, gitAt, logEvents, recorded } from "./intent.js";
import type { Group, UnitPlan } from "./plan.js";
import { pushBranch, REMOTE } from "./push.js";
import { gitOut, gitTry, revOf, type GitAt } from "./run.js";
import { DeliveryFailed, baseRef, planOf } from "./worktree.js";

const VIEW_FILES: readonly string[] = [".rafi/progress.yaml", "docs/ticket-progress.md"];
const EXCLUDES: readonly string[] = [":(exclude).rafi", ":(exclude).foreman"];
const MARKER = /^(<{7}|={7}|>{7})( |$)/m;

/** The unit a conflict fix ticket repairs, from the fold. */
export function conflictUnit(ctx: BuildContext, ticket: string): string | null {
  const owned = ctx.engine.fold().tickets[ticket]?.owned;
  return owned?.source === "conflict" ? owned.unit : null;
}

/** The commit of the base a merge into the unit's branch starts from: local for direct-merge, else the remote's. */
async function baseTip(ctx: BuildContext, at: GitAt, cwd: string, unit: UnitPlan): Promise<string> {
  const base = await baseRef(ctx, planOf(ctx));
  if (unit.completion === "direct-merge") {
    const tip = await revOf(at, cwd, `refs/heads/${base}`);
    if (!tip) throw new DeliveryFailed(unit.id, "rejected", `the base branch ${base} doesn't exist.`);
    return tip;
  }
  const r = await gitTry(at, cwd, ["fetch", "-q", "--no-tags", REMOTE, `refs/heads/${base}`]);
  if (r.code !== 0) throw new DeliveryFailed(unit.id, "transient", `fetching ${base} from ${REMOTE} failed: ` +
    `${r.stderr.trim().split("\n")[0] ?? ""}`);
  return gitOut(at, cwd, ["rev-parse", "FETCH_HEAD"]);
}

const contains = async (at: GitAt, cwd: string, tip: string, ref: string) =>
  (await gitTry(at, cwd, ["merge-base", "--is-ancestor", tip, ref])).code === 0;

/** The unit's group whose branch the conflict is in: the one the merge was started in, else the first that
 * conflicts with the base's tip, else its last. */
async function conflictGroup(ctx: BuildContext, unit: UnitPlan, ticket: string): Promise<Group> {
  const started = recorded(await logEvents(ctx), "git.intent", (d, e) => d.op === "merge" && e.ticket_id === ticket);
  const named = unit.groups.find((g) => `refs/heads/${g.branch}` === started?.ref);
  if (named || unit.groups.length === 1) return named ?? unit.groups[0]!;
  const at = gitAt(ctx);
  const tip = await baseTip(ctx, at, ctx.engine.projectDir, unit);
  for (const g of unit.groups) {
    const r = await gitTry(at, ctx.engine.projectDir, ["merge-tree", "--write-tree", "--name-only", tip, g.branch]);
    if (r.code === 1) return g;
  }
  return unit.groups.at(-1)!;
}

/** A conflict fix ticket's unit and group (its branch and worktree), or null for any other ticket. */
export async function conflictHit(ctx: BuildContext, ticket: string): Promise<{ unit: UnitPlan; group: Group } | null> {
  const id = conflictUnit(ctx, ticket);
  const unit = id ? planOf(ctx).units.find((u) => u.id === id) : undefined;
  return unit ? { unit, group: await conflictGroup(ctx, unit, ticket) } : null;
}

export const mergeHead = (at: GitAt, cwd: string) => revOf(at, cwd, "MERGE_HEAD");

/** A conflict fix ticket's workspace: the unit's worktree with the base's merge started (once). Null otherwise. */
export async function conflictWorkspace(ctx: BuildContext, ticket: string): Promise<string | null> {
  const hit = await conflictHit(ctx, ticket);
  if (!hit) return null;
  const { unit, group: g } = hit;
  const at = gitAt(ctx);
  if ((await ctx.deps.fs.stat(path.join(g.worktree, ".git")))?.kind !== "file") {
    await gitOut(at, ctx.engine.projectDir, ["worktree", "add", "-q", "--", g.worktree, g.branch]);
  }
  if (await mergeHead(at, g.worktree)) {
    await settleViews(at, g.worktree);
    return g.worktree;
  }
  const started = recorded(await logEvents(ctx), "git.intent", (d, e) => d.op === "merge" && e.ticket_id === ticket);
  const tip = typeof started?.new === "string" ? started.new : await baseTip(ctx, at, g.worktree, unit);
  if (await contains(at, g.worktree, tip, `refs/heads/${g.branch}`)) return g.worktree;
  const old = await gitOut(at, g.worktree, ["rev-parse", "HEAD"]);
  await effect(ctx, { op: "merge", unit: unit.id, ticket, ref: `refs/heads/${g.branch}`, old, new: tip, tree: null },
    g.branch, () => gitTry(at, g.worktree, ["merge", "--no-commit", "--no-ff", "--no-verify", "-q", tip]));
  await settleViews(at, g.worktree);
  return g.worktree;
}

/** Part 6: in a merge rafi started, rafi's own views take the branch's side (the fix ticket's commit writes rafi's
 * latest), so none is left unmerged for the builder or the snapshot (also after a crash right after the merge). */
async function settleViews(at: GitAt, wt: string): Promise<void> {
  const views = (await gitOut(at, wt, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0")
    .filter((f) => VIEW_FILES.includes(f));
  if (!views.length) return;
  await gitOut(at, wt, ["checkout", "--ours", "--", ...views]);
  await gitOut(at, wt, ["add", "-f", "--", ...views]);
}

/** The conflicted files of the merge in progress still holding conflict markers. */
async function marked(ctx: BuildContext, at: GitAt, cwd: string): Promise<string[]> {
  const files = (await gitOut(at, cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
  const out: string[] = [];
  for (const f of files) {
    const full = path.join(cwd, f);
    if ((await ctx.deps.fs.stat(full)) && MARKER.test(await ctx.deps.fs.read(full))) out.push(f);
  }
  return out;
}

/** C237: a conflict fix ticket's checks add "no conflict markers in <files>", recorded as rafi's own run. */
export async function withMarkers(ctx: BuildContext, ticket: string, req: number, r: StepResult):
  Promise<StepResult> {
  if (!conflictUnit(ctx, ticket)) return r;
  const at = gitAt(ctx);
  if (!(await mergeHead(at, ctx.project))) return r;
  const left = await marked(ctx, at, ctx.project);
  const events = await logEvents(ctx);
  const run = nextRun(events, ticket);
  const text = left.length ? `Conflict markers are still in ${left.join(", ")}.\n` : "No conflict markers left.\n";
  await ctx.engine.append([{ type: "check.run", run_id: ctx.run, ticket_id: ticket, actor: "engine", data: { run,
    ticket, command: "rafi: no conflict markers in the merged files", asked_by: "rafi", tree: "none",
    exit_code: left.length ? 1 : 0, outcome: left.length ? "failed" : "passed", tests: [], duration_ms: 0,
    output: await optionalBlob(ctx.engine, text, { what: `run ${run}'s output`, key: `${ticket}:markers-${run}`,
      run: ctx.run, ticket }), changed_tracked: [], restored: [], refused: null, sandbox: "none" } }]);
  if (!left.length) return { ...r, runs: [...r.runs, run] };
  return { ...r, outcome: r.outcome === "too-slow" ? r.outcome : "failed", failing: [...r.failing, { req, run }] };
}

/** C240: merges the base into a conflicting PR's branch in its worktree; only rafi's views may conflict. */
export async function updateFromBase(ctx: BuildContext, unit: UnitPlan, g: Group): Promise<void> {
  const at = gitAt(ctx);
  const wt = g.worktree;
  if ((await ctx.deps.fs.stat(path.join(wt, ".git")))?.kind !== "file") {
    await gitOut(at, ctx.engine.projectDir, ["worktree", "add", "-q", "--", wt, g.branch]);
  }
  const tip = await baseTip(ctx, at, wt, unit);
  if (await contains(at, wt, tip, `refs/heads/${g.branch}`)) return;
  const old = await gitOut(at, wt, ["rev-parse", "HEAD"]);
  await gitTry(at, wt, ["merge", "--no-commit", "--no-ff", "--no-verify", "-q", tip]);
  const conflicted = (await gitOut(at, wt, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0")
    .filter(Boolean);
  const others = conflicted.filter((f) => !VIEW_FILES.includes(f));
  if (others.length) {
    await gitTry(at, wt, ["merge", "--abort"]);
    throw new DeliveryFailed(unit.id, "conflict", `merging the base into ${g.branch} conflicts in ` +
      `${others.slice(0, 5).join(", ")}${others.length > 5 ? ", …" : ""}.`);
  }
  for (const rel of VIEW_FILES) {
    const from = path.join(ctx.engine.projectDir, rel);
    if (!(await ctx.deps.fs.stat(from))) continue;
    await ctx.deps.fs.writeAtomic(path.join(wt, rel), await ctx.deps.fs.readBytes(from));
  }
  await gitOut(at, wt, ["add", "-A", "--", ".", ...EXCLUDES]);
  const views = [];
  for (const rel of VIEW_FILES) if (await ctx.deps.fs.stat(path.join(wt, rel))) views.push(rel);
  if (views.length) await gitOut(at, wt, ["add", "-f", "--", ...views]);
  const tree = await gitOut(at, wt, ["write-tree"]);
  const base = await baseRef(ctx, planOf(ctx));
  const sha = await gitOut(at, wt, ["commit-tree", tree, "-p", old, "-p", tip, "-m",
    ctx.engine.redact(`Merge ${base} into ${g.branch} (rafi, ${unit.id})`)]);
  const ref = `refs/heads/${g.branch}`;
  const moved = await effect(ctx, { op: "commit", unit: unit.id, ticket: null, ref, old, new: sha, tree }, g.branch,
    () => gitTry(at, wt, ["update-ref", "-m", `rafi: merge ${base}`, ref, sha, old]));
  await gitTry(at, wt, ["merge", "--quit"]);
  if (moved.code !== 0) throw new DeliveryFailed(unit.id, "transient", `${g.branch} moved while rafi merged ${base}.`);
  await pushBranch(ctx, ctx.engine.projectDir, unit.id, g.branch);
}
