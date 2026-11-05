// Direct merge into the base (C200, C202, R16; today's finalization.ts): the merge's tree is computed from the base
// tip the lookup saw (`merge-tree --write-tree`), recorded in the intent, committed with both parents (`squash`: the
// base alone), and published only from that tip: `update-ref` when the base isn't checked out, else `merge
// --ff-only` in the main checkout (git refuses if the tip moved or your changes are in the way). A refused publish
// starts again from the new tip, at most 3 times. Conflicts in rafi's own views are resolved with the branch's
// side (rafi rewrites them at its next safe point); any other conflicted path fails the unit as `conflict`.
import path from "node:path";
import type { BuildContext } from "../build/context.js";
import { VIEWS } from "./commit.js";
import { effect, gitAt } from "./intent.js";
import { gitOut, gitTry, revOf, type GitAt } from "./run.js";
import { DeliveryFailed } from "./worktree.js";
import { rafisView } from "../tickets/views.js";

interface MergeTree { readonly tree: string | null; readonly conflicts: readonly string[] }

async function mergeTree(at: GitAt, cwd: string, base: string, source: string): Promise<MergeTree> {
  // Part 6: `-z`, so a file name is git's own bytes, never its C-quoted form ("src/\033[31m…").
  const r = await gitTry(at, cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", base, source]);
  const lines = r.stdout.split("\0");
  if (r.code === 0) return { tree: lines[0]!, conflicts: [] };
  if (r.code !== 1) throw new Error(`git merge-tree failed: ${r.stderr.trim().split("\n")[0] ?? ""}`);
  return { tree: lines[0]!, conflicts: [...new Set(lines.slice(1).filter(Boolean))] };
}

/** A tree with each of `paths` taken from `source` (C202: rafi's views take the branch's side). */
async function withSourceSide(ctx: BuildContext, at: GitAt, tree: string, source: string, paths: readonly string[]) {
  const main = ctx.engine.projectDir;
  const index = path.join(main, ".rafi", "cache", `index-merge-${ctx.deps.random.id()}`);
  await ctx.deps.fs.mkdir(path.dirname(index));
  const env = { ...ctx.deps.env, GIT_INDEX_FILE: index };
  try {
    await gitOut(at, main, ["read-tree", tree], env);
    for (const p of paths) {
      const entry = (await gitOut(at, main, ["ls-tree", source, "--", p])).split(/\s+/);
      const info = `${entry[0]},${entry[2]},${p}`;
      if (entry.length >= 3) await gitOut(at, main, ["update-index", "--cacheinfo", info], env);
      else await gitOut(at, main, ["update-index", "--force-remove", "--", p], env);
    }
    return await gitOut(at, main, ["write-tree"], env);
  } finally {
    await ctx.deps.fs.remove(index).catch(() => undefined);
  }
}

/** The merged tree of `source` into `tip`, or a conflict naming its files. */
export async function mergedTree(ctx: BuildContext, unit: string, tip: string, source: string): Promise<string> {
  const at = gitAt(ctx);
  const m = await mergeTree(at, ctx.engine.projectDir, tip, source);
  if (!m.conflicts.length) return m.tree!;
  const others = m.conflicts.filter((f) => !VIEWS.includes(f));
  if (others.length) {
    throw new DeliveryFailed(unit, "conflict", `merging into the base conflicts in ${others.slice(0, 5).join(", ")}` +
      `${others.length > 5 ? ", …" : ""}.`);
  }
  return withSourceSide(ctx, at, m.tree!, source, m.conflicts);
}

/** Your checkout's branch, when it's `base` (its files must follow the merge). */
async function checkedOut(at: GitAt, main: string, base: string): Promise<boolean> {
  const r = await gitTry(at, main, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return r.code === 0 && r.stdout.trim() === base;
}

/** Rafi's untracked views in your checkout would block the fast-forward; rafi rewrites them at its next safe point.
 * Part 6: only bytes rafi wrote (`.rafi/` is rafi's; a view outside it only while it holds rafi's last write). */
async function clearViews(ctx: BuildContext, at: GitAt, main: string): Promise<void> {
  const mine = async (f: string) => f.startsWith(".rafi/") || rafisView(ctx.deps.fs, main, path.join(main, f));
  const r = await gitTry(at, main, ["ls-files", "--others", "--", ...VIEWS]);
  for (const f of r.stdout.split("\n").filter(Boolean)) if (await mine(f)) await ctx.deps.fs.remove(path.join(main, f));
  // Tracked views (committed by an earlier merge) that rafi's safe point rewrote: back to HEAD's copy.
  const changed = await gitTry(at, main, ["diff", "--name-only", "HEAD", "--", ...VIEWS]);
  const files = [];
  for (const f of changed.stdout.split("\n").filter(Boolean)) if (await mine(f)) files.push(f);
  if (files.length) await gitTry(at, main, ["checkout", "HEAD", "--", ...files]);
}

/** Merges `branch` into `base`; the base's new tip (its old one when the branch was already in it). */
export async function directMerge(ctx: BuildContext, unit: string, branch: string, base: string,
  method: string): Promise<string> {
  const at = gitAt(ctx);
  const main = ctx.engine.projectDir;
  const source = await revOf(at, main, `refs/heads/${branch}`);
  if (!source) throw new DeliveryFailed(unit, "rejected", `branch ${branch} is missing, so it can't be merged.`);
  for (let tries = 0; tries < 3; tries += 1) {
    const tip = await revOf(at, main, `refs/heads/${base}`);
    if (!tip) throw new DeliveryFailed(unit, "rejected", `the base branch ${base} doesn't exist.`);
    if ((await gitTry(at, main, ["merge-base", "--is-ancestor", source, tip])).code === 0) return tip;
    const tree = await mergedTree(ctx, unit, tip, source);
    const parents = method === "squash" ? ["-p", tip] : ["-p", tip, "-p", source];
    const merge = await gitOut(at, main, ["commit-tree", tree, ...parents, "-m",
      ctx.engine.redact(`Merge ${branch} into ${base} (rafi, ${unit})`)]);
    const ref = `refs/heads/${base}`;
    const ok = await effect(ctx, { op: "merge", unit, ticket: null, ref, old: tip, new: merge, tree }, branch,
      async () => {
        if (!(await checkedOut(at, main, base))) {
          return (await gitTry(at, main, ["update-ref", "-m", `rafi: merge ${branch}`, ref, merge, tip])).code === 0;
        }
        if ((await revOf(at, main, "HEAD")) !== tip) return false;
        await clearViews(ctx, at, main);
        const r = await gitTry(at, main, ["merge", "--ff-only", "--no-verify", "-q", merge]);
        if (r.code !== 0 && (await revOf(at, main, "HEAD")) === tip) {
          throw new DeliveryFailed(unit, "rejected", `your checkout's changes are in the way of merging ${branch} ` +
            `into ${base}: ${r.stderr.trim().split("\n")[0] ?? ""}`);
        }
        return r.code === 0;
      });
    if (ok) return merge;
  }
  throw new DeliveryFailed(unit, "transient", `${base} kept moving while rafi merged ${branch} into it.`);
}
