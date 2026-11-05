// A ticket's workspace (C194, R12): the worktree of its group's branch under `.foreman/worktrees/<slug>` (excluded
// through `.git/info/exclude`), made from the group it stacks on, else the build's base. Part 6 (M5 review P1): the
// branch is created only by git's create-only update (`update-ref <ref> <start> <null id>`, a compare-and-set that
// fails on any existing branch), with rafi's own reflog message. An existing branch is adopted only when rafi made
// it: its `git.branch_created` is recorded, or (a crash between the create and its record) rafi's `git.intent` names
// that ref and tip and the branch's first reflog entry is rafi's create. Any other, whatever its tip, is someone
// else's: refused (`rejected`, naming it), never reset, reused, committed to or pushed.
import path from "node:path";
import type { BuildContext } from "../build/context.js";
import { setting } from "../build/context.js";
import { conflictWorkspace } from "./conflict.js";
import { effect, gitAt, logEvents, recordResult, recorded } from "./intent.js";
import { deliveryPlan, groupFor, type Group, type Plan } from "./plan.js";
import { gitOut, gitTry, headFromFiles, revOf } from "./run.js";

/** A git or gh/glab step failed for a unit (4.3.2): the category of 5.1 and one line. */
export class DeliveryFailed extends Error {
  constructor(readonly unit: string, readonly category: "transient" | "conflict" | "auth" | "rejected",
    message: string) { super(message); }
}

/** The build's delivery plan; a rafi-owned ticket (M5 C272) works in the last group of its unit. */
export function planOf(ctx: BuildContext): Plan {
  const plan = deliveryPlan({ tickets: ctx.tickets, units: ctx.units, settings: ctx.settings,
    project: ctx.engine.projectDir, run: ctx.run, redact: (t) => ctx.engine.redact(t) });
  const owned = [...(ctx.owned ?? new Map()).entries()].filter(([, o]) => o.unit);
  if (!owned.length) return plan;
  return { ...plan, units: plan.units.map((u) => {
    const mine = owned.filter(([, o]) => o.unit === u.id).map(([id]) => id);
    const last = u.groups.at(-1);
    if (!mine.length || !last) return u;
    return { ...u, groups: [...u.groups.slice(0, -1), { ...last, tickets: [...last.tickets, ...mine] }] };
  }) };
}

/** The build's base: `--base` or `tickets.build.base_branch`, else the main checkout's branch, else its HEAD. */
export async function baseRef(ctx: BuildContext, plan: Plan): Promise<string> {
  if (plan.base) return plan.base;
  const read = await headFromFiles(ctx.deps.fs, ctx.engine.projectDir);
  if (read) return read.branch;
  const at = gitAt(ctx);
  const branch = await gitTry(at, ctx.engine.projectDir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return branch.code === 0 && branch.stdout.trim() ? branch.stdout.trim()
    : gitOut(at, ctx.engine.projectDir, ["rev-parse", "HEAD"]);
}

/** `.foreman/` never shows in your `git status` (C194); `info/exclude` is shared by every worktree. */
async function excludeForeman(ctx: BuildContext): Promise<void> {
  const dotGit = path.join(ctx.engine.projectDir, ".git");
  const common = (await ctx.deps.fs.stat(dotGit))?.kind === "dir" ? dotGit : path.resolve(ctx.engine.projectDir,
    await gitOut(gitAt(ctx), ctx.engine.projectDir, ["rev-parse", "--git-common-dir"]));
  const file = path.join(common, "info", "exclude");
  const now = (await ctx.deps.fs.stat(file)) ? await ctx.deps.fs.read(file) : "";
  if (!/^\/?\.foreman\/?$/m.test(now)) {
    await ctx.deps.fs.mkdir(path.dirname(file));
    await ctx.deps.fs.writeAtomic(file, `${now}${now && !now.endsWith("\n") ? "\n" : ""}/.foreman/\n`);
  }
}

/** Where the group's branch starts: the branch it stacks on, else the build's base. A stacked-on group rafi never
 * made a branch for (its tickets dropped) gives no branch: its own start is used, never a same-named one of yours. */
async function startOf(ctx: BuildContext, plan: Plan, g: Group): Promise<string> {
  const on = g.stackOn ? plan.units.flatMap((u) => u.groups).find((x) => x.id === g.stackOn) : null;
  if (!on) return baseRef(ctx, plan);
  return (await madeByRafi(ctx, on.branch)) ? on.branch : startOf(ctx, plan, on);
}

/** True when rafi recorded making `branch` (`git.branch_created`, in any run). */
async function madeByRafi(ctx: BuildContext, branch: string): Promise<boolean> {
  return !!recorded(await logEvents(ctx), "git.branch_created", (d) => d.branch === branch);
}

const createMessage = (ctx: BuildContext, branch: string) => `rafi: create ${branch} (build ${ctx.run})`;

/** A crash after rafi's create and before its record: rafi's intent names the ref at this tip, and the branch's
 * oldest reflog entry is rafi's create (a branch someone else made at the same commit has their own entry). */
async function crashedCreate(ctx: BuildContext, events: Parameters<typeof recorded>[0], branch: string,
  tip: string): Promise<boolean> {
  const meant = recorded(events, "git.intent", (d) => d.op === "branch" && d.ref === `refs/heads/${branch}` &&
    d.new === tip);
  if (!meant) return false;
  const log = await gitTry(gitAt(ctx), ctx.engine.projectDir, ["reflog", "show", "--format=%gs",
    `refs/heads/${branch}`, "--"]);
  const first = log.code === 0 ? log.stdout.trim().split("\n").at(-1) : undefined;
  return !!first?.startsWith(`rafi: create ${branch} (build `);
}

const foreign = (g: Group) => new DeliveryFailed(g.unit, "rejected", `branch ${g.branch} already exists and isn't ` +
  "rafi's; rafi leaves it as it is (rename or delete it, then `rafi resume`).");

async function createBranch(ctx: BuildContext, plan: Plan, g: Group, ticket: string): Promise<void> {
  const at = gitAt(ctx);
  const main = ctx.engine.projectDir;
  const start = await startOf(ctx, plan, g);
  const from = await revOf(at, main, start);
  if (!from) throw new DeliveryFailed(g.unit, "rejected", `${start} doesn't exist, so ${g.branch} can't start there.`);
  const events = await logEvents(ctx);
  const mine = recorded(events, "git.branch_created", (d) => d.branch === g.branch);
  const ref = `refs/heads/${g.branch}`;
  const tip = await revOf(at, main, ref);
  if (tip && !mine && !(await crashedCreate(ctx, events, g.branch, tip))) throw foreign(g);
  await excludeForeman(ctx);
  const intent = { op: "branch" as const, unit: g.unit, ticket, ref, old: null, new: tip ?? from, tree: null };
  await effect(ctx, intent, g.branch, async () => {
    if (!tip) {
      // R12: create only if absent; someone who made it since the lookup makes this fail, and their branch is theirs.
      const made = await gitTry(at, main, ["update-ref", "--create-reflog", "-m", createMessage(ctx, g.branch), ref,
        from, "0".repeat(from.length)]);
      if (made.code !== 0) {
        if (await revOf(at, main, ref)) throw foreign(g);
        throw new DeliveryFailed(g.unit, "rejected", `git couldn't create ${g.branch}: ` +
          `${made.stderr.trim().split("\n")[0] ?? ""}`);
      }
    }
    await gitOut(at, main, ["worktree", "add", "-q", "--", g.worktree, g.branch]);
  });
  if (!mine) {
    await recordResult(ctx, "git.branch_created", ticket, { sha: tip ?? from, branch: g.branch, unit: g.unit });
  }
}

/**
 * The folder a ticket's steps run in: its group's worktree (made on first use), or the main checkout when git is
 * left to you. Thrown DeliveryFailed: the loop records it for the ticket and its unit.
 */
export async function workspaceFor(ctx: BuildContext, ticket: string): Promise<string> {
  const plan = planOf(ctx);
  const hit = groupFor(plan, ticket);
  const fix = hit ? null : await conflictWorkspace(ctx, ticket);
  if (fix) return fix;
  if (!hit || !hit.unit.managed || setting<string>(ctx, "git.managed_by") === "me") return ctx.engine.projectDir;
  const g = hit.group;
  const dotGit = await ctx.deps.fs.stat(path.join(g.worktree, ".git"));
  if (dotGit?.kind === "file") {
    const events = await logEvents(ctx);
    if (recorded(events, "git.branch_created", (d) => d.branch === g.branch)) return g.worktree;
    // C320: a crash between the worktree's creation and its record. Rafi's own intent names the branch and where it
    // started; the worktree is on that branch, still there: adopted and recorded, not made again.
    const meant = recorded(events, "git.intent", (d) => d.op === "branch" && d.ref === `refs/heads/${g.branch}`);
    const head = meant ? await headFromFiles(ctx.deps.fs, g.worktree) : null;
    const tip = head?.branch === g.branch ? await revOf(gitAt(ctx), ctx.engine.projectDir, `refs/heads/${g.branch}`)
      : null;
    if (meant && tip && (tip === meant.new || head?.sha === tip)) {
      await recordResult(ctx, "git.branch_created", ticket, { sha: String(meant.new), branch: g.branch, unit: g.unit });
      return g.worktree;
    }
  }
  await createBranch(ctx, plan, g, ticket);
  return g.worktree;
}
