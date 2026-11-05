// One delivery unit's delivery (ARCH 4.3.2; C200, C204): `none` commits only (nothing at the unit's level); `pr`
// pushes each branch and opens a draft PR; `pr-ready` a ready one; `auto-merge` turns auto-merge on, then waits
// (`unit.merge_waiting`, polled on the clock every 60 s) unless `auto_merge_wait` is off; `direct-merge` merges each
// branch into the base locally and pushes the base when it tracks a remote. Every effect goes through intent.ts.
// The unit's worktrees are removed once it's delivered, unless `keep_worktrees`; branches are never deleted.
import path from "node:path";
import type { BuildContext } from "../build/context.js";
import {
  autoMerge, createPr, findPr, providerFor, readyPr, viewPr, ProviderFailed, type Provider,
} from "./provider.js";
import { effect, gitAt, logEvents, recordResult, recorded } from "./intent.js";
import { openDelivery } from "../ask/delivery.js";
import { updateFromBase } from "./conflict.js";
import { directMerge } from "./merge.js";
import { pushBranch, tracksRemote } from "./push.js";
import type { Group, Plan, UnitPlan } from "./plan.js";
import { gitTry } from "./run.js";
import { DeliveryFailed, baseRef, planOf } from "./worktree.js";
import { writeSince } from "../build/claim.js";

const POLL_MS = 60_000;

function unitEvent(ctx: BuildContext, type: string, data: Record<string, unknown>) {
  return ctx.engine.append([{ type, run_id: ctx.run, ticket_id: null, actor: "engine", data }]);
}

function body(ctx: BuildContext, unit: UnitPlan, g: Group): string {
  const lines = [`Delivered by rafi (build ${ctx.run}, unit ${unit.id}).`, "", "Tickets:"];
  for (const id of g.tickets) lines.push(`- ${id}: ${ctx.tickets.find((t) => t.id === id)?.title ?? id}`);
  return ctx.engine.redact(`${lines.join("\n")}\n`);
}

const titleOf = (ctx: BuildContext, unit: UnitPlan, g: Group) => ctx.engine.redact(g.tickets.length === 1
  ? `${g.tickets[0]}: ${ctx.tickets.find((t) => t.id === g.tickets[0])?.title ?? ""}`
  : `${unit.id}: ${g.tickets.join(", ")}`);

/** The branch a group's PR targets: the group it stacks on, else the build's base. */
function prBase(plan: Plan, g: Group, base: string): string {
  return plan.units.flatMap((u) => u.groups).find((x) => x.id === g.stackOn)?.branch ?? base;
}

async function openPr(ctx: BuildContext, plan: Plan, unit: UnitPlan, g: Group, p: Provider, base: string) {
  const cwd = ctx.engine.projectDir;
  let pr = await findPr(ctx, p, cwd, g.branch);
  if (!pr) {
    const dir = path.join(cwd, ".foreman", "pr-bodies");
    const bodyFile = path.join(dir, `${ctx.run}-${g.branch.replace(/\//g, "-")}.md`);
    await ctx.deps.fs.mkdir(dir);
    await ctx.deps.fs.writeAtomic(bodyFile, body(ctx, unit, g));
    pr = await effect(ctx, { op: "pr-create", unit: unit.id, ticket: null, ref: g.branch, old: null, new: null,
      tree: null }, g.branch, () => createPr(ctx, p, cwd, { branch: g.branch, base: prBase(plan, g, base),
      title: titleOf(ctx, unit, g), bodyFile, draft: unit.completion === "pr" }));
  }
  const events = await logEvents(ctx);
  if (!recorded(events, "pr.created", (d) => d.url === pr!.url)) {
    await recordResult(ctx, "pr.created", null, { url: pr.url, branch: g.branch, unit: unit.id });
  }
  return pr;
}

/** A PR the provider reports merged: `pr.merged` once. */
async function mergedPr(ctx: BuildContext, unit: UnitPlan, g: Group, url: string): Promise<void> {
  if (!recorded(await logEvents(ctx), "pr.merged", (d) => d.url === url)) {
    await recordResult(ctx, "pr.merged", null, { url, branch: g.branch, unit: unit.id });
  }
}

/** R15: an action on a PR the provider says is merged or closed is never retried; merged counts as delivered. */
async function prAction(ctx: BuildContext, unit: UnitPlan, g: Group, p: Provider, url: string,
  op: "pr-ready" | "auto-merge", act: () => Promise<unknown>): Promise<"merged" | "done"> {
  try {
    await effect(ctx, { op, unit: unit.id, ticket: null, ref: g.branch, old: null, new: url, tree: null }, g.branch,
      act);
    return "done";
  } catch (error) {
    if (!(error instanceof ProviderFailed)) throw error;
    const now = await viewPr(ctx, p, ctx.engine.projectDir, url);
    if (now?.state === "merged") { await mergedPr(ctx, unit, g, url); return "merged"; }
    if (now?.state === "closed") throw new DeliveryFailed(unit.id, "rejected", `${url} was closed; rafi doesn't ` +
      "reopen or recreate it.");
    throw new DeliveryFailed(unit.id, error.category, error.message);
  }
}

async function viaProvider(ctx: BuildContext, plan: Plan, unit: UnitPlan, p: Provider): Promise<void> {
  const base = await baseRef(ctx, plan);
  let merged = 0;
  for (const g of unit.groups) {
    await pushBranch(ctx, ctx.engine.projectDir, unit.id, g.branch);
    const pr = await openPr(ctx, plan, unit, g, p, base);
    if (pr.state === "merged") { await mergedPr(ctx, unit, g, pr.url); merged += 1; continue; }
    if (pr.state === "closed") throw new DeliveryFailed(unit.id, "rejected", `${pr.url} was closed; rafi doesn't ` +
      "reopen or recreate it.");
    // C240: before marking it ready or turning on auto-merge, a conflicting PR gets the base merged in.
    if (pr.conflicting && unit.completion !== "pr") await updateFromBase(ctx, unit, g);
    if (unit.completion === "pr-ready" && pr.draft) {
      if (await prAction(ctx, unit, g, p, pr.url, "pr-ready", () => readyPr(ctx, p, ctx.engine.projectDir,
        pr.url)) === "merged") { merged += 1; continue; }
    }
    if (unit.completion === "auto-merge") {
      if (await prAction(ctx, unit, g, p, pr.url, "auto-merge", () => autoMerge(ctx, p, ctx.engine.projectDir,
        pr.url, unit.mergeMethod)) === "merged") merged += 1;
    }
  }
  if (merged === unit.groups.length) return finished(ctx, plan, unit, "merged");
  if (unit.completion === "auto-merge" && plan.autoMergeWait) {
    const until = new Date(ctx.deps.clock.now().getTime() + (plan.timeoutMinutes ?? 60 * 24 * 365) * 60_000);
    await unitEvent(ctx, "unit.merge_waiting", { unit: unit.id, until: until.toISOString() });
    ctx.ui.line(`${unit.id}: waiting for its PR to merge (until ${until.toISOString().slice(11, 16)} UTC).`);
    return;
  }
  await finished(ctx, plan, unit, "pr-opened");
}

/** `since` (R10): a merge wait's outcome is written only if no build event (a stop request) came since the poll
 * began; else nothing is written and the loop decides again (the next poll, on `rafi resume`, records it). */
async function finished(ctx: BuildContext, plan: Plan, unit: UnitPlan, how: "merged" | "pushed" | "pr-opened" |
  "none", since?: number) {
  const event = { type: "unit.delivered", run_id: ctx.run, ticket_id: null, actor: "engine",
    data: { unit: unit.id, how } };
  if (since === undefined) await ctx.engine.append([event]);
  else if (!(await writeSince(ctx.engine, [event], since))) return;
  ctx.ui.line(`${unit.id} delivered (${how === "pr-opened" ? "PR opened" : how === "none" ? "completion none: its "
    + "commits stay on its branch" : how}).`);
  if (plan.keepWorktrees) return;
  const at = gitAt(ctx);
  for (const g of unit.groups) {
    if (!(await ctx.deps.fs.stat(g.worktree))) continue;
    // Plain `worktree remove` refuses a worktree with changes; then it's kept, and said so.
    const r = await gitTry(at, ctx.engine.projectDir, ["worktree", "remove", "--", g.worktree]);
    if (r.code !== 0) ctx.ui.line(`Kept ${path.relative(ctx.engine.projectDir, g.worktree)}: it has changes.`);
  }
}

/** A merge wait's poll (C204): every PR merged → delivered; one closed → rejected; past `until` → the timeout. */
async function poll(ctx: BuildContext, plan: Plan, unit: UnitPlan, p: Provider): Promise<void> {
  const since = ctx.engine.buildSeq();
  await ctx.deps.clock.sleep(POLL_MS, "poll", ctx.control?.now.signal);
  const events = await logEvents(ctx);
  const waiting = recorded(events, "unit.merge_waiting", (d) => d.unit === unit.id);
  let merged = 0;
  for (const g of unit.groups) {
    const url = recorded(events, "pr.created", (d) => d.branch === g.branch)?.url;
    const pr = typeof url === "string" ? await viewPr(ctx, p, ctx.engine.projectDir, url) : null;
    if (pr?.state === "closed") throw new DeliveryFailed(unit.id, "rejected", `${pr.url} was closed while rafi ` +
      "waited for it to merge.");
    if (pr?.state === "merged") {
      merged += 1;
      await mergedPr(ctx, unit, g, pr.url);
    } else if (pr?.conflicting) await updateFromBase(ctx, unit, g);
  }
  if (merged === unit.groups.length) return finished(ctx, plan, unit, "merged", since);
  // 4.3.2: past `until`, the delivery question asks Keep waiting / Merge it myself / Skip (C203).
  if (waiting && ctx.deps.clock.now().getTime() > Date.parse(String(waiting.until))) {
    await openDelivery(ctx.engine, ctx.run, { unit: unit.id, tickets: unit.tickets, why: "timeout",
      message: `It didn't merge within ${plan.timeoutMinutes} minutes.` });
  }
}

/** The loop's `deliver-unit` action: deliver a ready unit, or poll a waiting one. */
export async function deliverUnit(start: BuildContext, id: string, state: string): Promise<void> {
  const ctx: BuildContext = { ...start, delivering: { checked: false } };
  const plan = planOf(ctx);
  const planned = plan.units.find((u) => u.id === id);
  if (!planned) {
    throw new DeliveryFailed(id, "rejected", `delivery unit ${id} isn't in .tickets/delivery.yaml any more.`);
  }
  // Part 6: a group rafi never made a branch for (every ticket in it dropped) has nothing to deliver; a same-named
  // branch of yours is never merged, pushed or given a PR.
  const events = await logEvents(ctx);
  const made = (g: Group) => !!recorded(events, "git.branch_created", (d) => d.branch === g.branch);
  const unit: UnitPlan = { ...planned, groups: planned.groups.filter(made) };
  // C282: delivery.yaml now says `none` for a ready unit (R19): its commits stay on its branch; nothing is pushed.
  if (unit.completion === "none" || !unit.managed) return finished(ctx, plan, unit, "none");
  if (unit.completion === "direct-merge") {
    const base = await baseRef(ctx, plan);
    for (const g of unit.groups) await directMerge(ctx, unit.id, g.branch, base, unit.mergeMethod);
    if (await tracksRemote(ctx, ctx.engine.projectDir, base)) {
      await pushBranch(ctx, ctx.engine.projectDir, unit.id, base, { base: true });
    }
    return finished(ctx, plan, unit, "merged");
  }
  const p = await providerFor(ctx, unit.provider);
  if (!p) {
    for (const g of unit.groups) await pushBranch(ctx, ctx.engine.projectDir, unit.id, g.branch);
    return finished(ctx, plan, unit, "pushed");
  }
  if (state === "merge_waiting") return poll(ctx, plan, unit, p);
  return viaProvider(ctx, plan, unit, p);
}
