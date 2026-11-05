// Throwaway worktrees for rafi's CI points (ARCH 6.10; M5 C213, C234): the combined result a point tests (the base
// with every unit already merged, plus each group branch of the units still to deliver merged in), and past commits
// for reruns, each a detached worktree under `.rafi/cache/ci/`, removed afterwards (the folder, then `worktree
// prune`; never `--force`). The builder's worktrees are never touched. Conflicts only in rafi's own views take the
// branch's side (C202); any other conflict fails the unit as `conflict`, as its delivery would. The runs a point
// makes in them (the suite, the reruns, the hint's search) are recorded by build/ci.ts, under the fix ticket.
import path from "node:path";
import { executeCheck, relatedTests, type Executed } from "../build/checks.js";
import { append, checkEnvFor, setting, type BuildContext } from "../build/context.js";
import { VIEWS } from "./commit.js";
import { gitAt } from "./intent.js";
import type { Plan, UnitPlan } from "./plan.js";
import { GitFailed, gitOut, gitTry, nulPaths } from "./run.js";
import { DeliveryFailed, baseRef } from "./worktree.js";

export interface Throwaway {
  readonly dir: string;
  head(): Promise<string>;
  /** Moves the worktree to `commit` (a rerun at a ticket's commit). */
  at(commit: string): Promise<void>;
  remove(): Promise<void>;
}

/** A detached worktree at `commit`. */
export async function throwaway(ctx: BuildContext, commit: string): Promise<Throwaway> {
  const g = gitAt(ctx);
  const main = ctx.engine.projectDir;
  const dir = path.join(main, ".rafi", "cache", "ci", ctx.deps.random.id());
  await ctx.deps.fs.mkdir(path.dirname(dir));
  await gitOut(g, main, ["worktree", "add", "-q", "--detach", "--", dir, commit]);
  return {
    dir,
    head: () => gitOut(g, dir, ["rev-parse", "HEAD"]),
    at: async (c) => { await gitOut(g, dir, ["checkout", "-q", "--detach", c]); },
    remove: async () => {
      await ctx.deps.fs.remove(dir, { recursive: true });
      await gitTry(g, main, ["worktree", "prune"]);
    },
  };
}

async function mergeIn(ctx: BuildContext, t: Throwaway, unit: string, branch: string): Promise<void> {
  const g = gitAt(ctx);
  const msg = ["-m", `rafi CI: merge ${branch}`];
  if ((await gitTry(g, t.dir, ["merge", "-q", "--no-ff", "--no-edit", "--no-verify", ...msg, branch])).code === 0) {
    return;
  }
  const conflicted = (await gitOut(g, t.dir, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0")
    .filter(Boolean);
  if (conflicted.length && conflicted.every((f) => VIEWS.includes(f))) {
    await gitOut(g, t.dir, ["checkout", "--theirs", "--", ...conflicted]);
    await gitOut(g, t.dir, ["add", "--", ...conflicted]);
    await gitOut(g, t.dir, ["commit", "-q", "--no-verify", ...msg]);
    return;
  }
  await gitTry(g, t.dir, ["merge", "--abort"]);
  throw new DeliveryFailed(unit, "conflict", `merging ${branch} for rafi's CI conflicts in ` +
    `${conflicted.filter((f) => !VIEWS.includes(f)).slice(0, 5).join(", ") || "its files"}.`);
}

/** What a CI point tests: the base's tip with each of `units`' branches merged in. */
export async function combined(ctx: BuildContext, plan: Plan, units: readonly UnitPlan[]): Promise<Throwaway> {
  const t = await throwaway(ctx, await baseRef(ctx, plan));
  try {
    for (const u of units) for (const grp of u.groups) await mergeIn(ctx, t, u.id, grp.branch);
    return t;
  } catch (error) {
    await t.remove();
    throw error;
  }
}

/** The build's starting commit for `units`: where their first branch left the base. */
export async function startOf(ctx: BuildContext, plan: Plan, units: readonly UnitPlan[]): Promise<string> {
  const base = await baseRef(ctx, plan);
  const branch = units.flatMap((u) => u.groups)[0]?.branch;
  return branch ? gitOut(gitAt(ctx), ctx.engine.projectDir, ["merge-base", base, branch])
    : gitOut(gitAt(ctx), ctx.engine.projectDir, ["rev-parse", base]);
}

/** The files changed between two commits (`light` runs the tests related to them; a rerun after a fix too). */
export async function changedBetween(ctx: BuildContext, from: string, to: string): Promise<string[]> {
  const args = ["diff", "--name-only", "-z", from, to, "--"];
  const r = await gitTry(gitAt(ctx), ctx.engine.projectDir, args);
  if (r.code !== 0) throw new GitFailed(args, r);
  return nulPaths(r.stdout);
}

export interface SuiteRun {
  /** Test files with a failing test, sorted; with no per-test results, the files asked for (or the command). */
  readonly failing: string[];
  readonly passing: string[];
  readonly record: Executed["record"];
}

/** One run of the test runner in `t` (every test, or `files`), recorded only by the caller (C271). */
export async function suiteIn(ctx: BuildContext, t: Throwaway, ticket: string, files: readonly string[] | null):
  Promise<SuiteRun> {
  const out = await executeCheck(checkEnvFor(ctx, ticket, t.dir), [...ctx.runner!, ...(files ?? [])], "rafi",
    undefined, true);
  const set = (outcome: string) => [...new Set(out.record.tests.filter((x) => x.outcome === outcome)
    .map((x) => x.file ?? ""))].filter(Boolean).sort();
  let failing = set("failed");
  if (!out.record.tests.length && out.record.outcome !== "passed") failing = [...(files ?? [out.record.command])];
  // The record as check.run stores it (per-test errors stay in the runner's report, as executeCheck keeps them).
  const tests = out.record.tests as unknown as ({ error?: string | null } & Record<string, unknown>)[];
  const record = { ...out.record, tests: tests.map(({ error: _e, ...x }) => x) };
  return { failing, passing: set("passed").filter((f) => !failing.includes(f)),
    record: record as unknown as Executed["record"] };
}

/** The tests related to `changed` (C44's query), or null when the runner can't say (then everything runs). */
export function relatedIn(ctx: BuildContext, t: Throwaway, ticket: string, changed: readonly string[]) {
  return changed.length ? relatedTests(checkEnvFor(ctx, ticket, t.dir), changed) : Promise.resolve([]);
}

/**
 * Which ticket probably broke `real` (6.10 step 2, C213): rerun them at each delivered ticket's commit of this build,
 * in order (at most 8), and name the first where one fails; else the first ticket whose changed files the related
 * tests query matches.
 */
export async function hintFor(ctx: BuildContext, tickets: readonly string[], real: readonly string[], id: string,
  events: readonly { type: string; run_id: string | null; ticket_id: string | null; data: unknown }[]) {
  const commits = events.filter((e) => e.type === "git.committed" && e.run_id === ctx.run && e.ticket_id &&
    tickets.includes(e.ticket_id)).map((e) => ({ ticket: e.ticket_id!, sha: String((e.data as { sha: string }).sha) }))
    .slice(0, 8);
  if (!commits.length) return null;
  const t = await throwaway(ctx, commits[0]!.sha);
  try {
    for (const c of commits) {
      await t.at(c.sha);
      if ((await suiteIn(ctx, t, id, real)).failing.length) return c.ticket;
    }
    for (const c of commits) {
      const related = await relatedIn(ctx, t, id, await changedBetween(ctx, `${c.sha}^`, c.sha));
      if (related?.some((f) => real.includes(f))) return c.ticket;
    }
    return null;
  } finally {
    await t.remove();
  }
}

interface Last { readonly commit: string; readonly failing: readonly string[]; readonly preexisting: readonly string[] }

/**
 * The tests a point runs (C213, "nothing runs twice"): every test; `light`, the tests related to what the build
 * changed; after a fix, the last run's failures plus the tests related to what changed since, with the rest of what
 * passed last time reused. Null files: every test (the runner can't say what's related).
 */
export async function testsFor(ctx: BuildContext, t: Throwaway, id: string, o: { light: boolean; start: string;
  last: Last | null; prior: readonly { file: string | null; outcome: string }[] | null }) {
  const tip = await t.head();
  const since = o.last && o.prior ? await changedBetween(ctx, o.last.commit, tip)
    : o.light ? await changedBetween(ctx, o.start, tip) : null;
  const related = since ? await relatedIn(ctx, t, id, since) : null;
  const files = related && o.last && o.prior ? [...new Set([...o.last.failing, ...related])] : related;
  const reused = files && o.prior ? [...new Set(o.prior.filter((x) => x.outcome === "passed")
    .map((x) => x.file ?? ""))].filter((f) => f && !files.includes(f)).sort() : [];
  return { tip, files, reused };
}

/** Each failing test rerun at the starting commit (failing there: already broken), then at the same commit. */
export async function rerunFailures(ctx: BuildContext, t: Throwaway, id: string, start: string,
  failing: readonly string[], known: readonly string[]) {
  const atStart = new Set(known.filter((f) => failing.includes(f)));
  const onRerun = new Set<string>();
  const unknown = failing.filter((f) => !atStart.has(f));
  if (!unknown.length) return { atStart, onRerun };
  const old = await throwaway(ctx, start);
  try {
    for (const f of (await suiteIn(ctx, old, id, unknown)).failing) atStart.add(f);
  } finally {
    await old.remove();
  }
  const again = unknown.filter((f) => !atStart.has(f));
  if (again.length) for (const f of (await suiteIn(ctx, t, id, again)).failing) onRerun.add(f);
  return { atStart, onRerun };
}

/** combined(), or null with the unit's `unit.failed` recorded when merging it in conflicts (as delivery would). */
export async function combinedOrFailed(ctx: BuildContext, plan: Plan, units: readonly UnitPlan[]) {
  try {
    return await combined(ctx, plan, units);
  } catch (error) {
    if (!(error instanceof DeliveryFailed)) throw error;
    ctx.ui.line(`Delivery unit ${error.unit} failed (conflict): ${error.message}`);
    await append(ctx, null, { type: "unit.failed", data: { unit: error.unit, category: error.category,
      message: error.message } });
    return null;
  }
}

/** Closes a CI point: passed, fixed, or with tests still failing unfixed-merged (unfixed-pushed with
 * `checks.ci_blocks_merge`), with one line; `suite` is this run's `suite.run`, written first. */
export function ciResult(ctx: BuildContext, key: string, fix: string | null, still: readonly string[],
  suite?: unknown) {
  const outcome = !still.length ? (fix ? "fixed" : "passed")
    : setting<boolean>(ctx, "checks.ci_blocks_merge") ? "unfixed-pushed" : "unfixed-merged";
  ctx.ui.line(!still.length ? `CI ${fix ? `passed after ${fix}` : "passed"} (${key}).` : `CI: ${fix} didn't fix ` +
    `${still.join(", ")}; ${outcome === "unfixed-pushed" ? "pushing without merging" : "delivering anyway"}.`);
  return append(ctx, null, ...(suite ? [{ type: "suite.run", data: suite }] : []),
    { type: "ci.result", data: { unit: key, outcome, fix_ticket: fix, still_failing: [...still] } });
}
