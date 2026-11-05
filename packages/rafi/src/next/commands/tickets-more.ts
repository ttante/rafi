// The rest of `rafi tickets` on the log (M5 part 4a-2; REQ 2.4): setup:init and setup:update with PRM-50–54,
// waive-risk-notes (PRM-56), repair --risk-notes, groups list and repair (PRM-59), reset (PRM-57, PRM-58), discover,
// accept-future-work, review and archive. Each parses, asks where a terminal is and no flag answers, calls engine
// functions and prints one line per result; `-y`/`--defaults` answer every question with its default.
import path from "node:path";
import {
  acceptFutureWork, applyReset, archiveDone, discover, groups, initTracker, managedByMe, previewReset,
  applyRollbacks, proposeRollbacks, recommendations, repairGroups, review, riskGaps, setupTickets, ungrouped,
  validateTickets, waiveRiskNotes, writeProgressDoc,
  type Engine, type SetupAnswers, type Source,
} from "@rafi-ai/engine";
import { askText, choose } from "../ui/prompts.js";
import { line } from "../ui/lines.js";
import type { Action, ActionContext } from "./actions.js";
import { docsRoot, said, who, withEngine } from "./tickets-run.js";

const asks = (ctx: ActionContext) => ctx.deps.terminal.isTTY && !ctx.opts.yes && !ctx.opts.defaults;
const str = (v: unknown) => (v === undefined ? undefined : String(v));
const yes = async (ctx: ActionContext, q: string) => (await choose(ctx.deps, q, ["Yes (Recommended)", "No"])) === 0;
const list = (v: string | null | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

async function rerender(ctx: ActionContext, engine: Engine): Promise<void> {
  await writeProgressDoc(engine, engine.fold(), { docsRoot: await docsRoot(ctx) });
}

/** The sources the flags name; undefined when none does (FLAG-TK-2: a source flag replaces the saved ones). */
function flagSources(o: Record<string, unknown>): Source[] | undefined {
  const out: Source[] = [];
  if (o.localSource) out.push({ type: "local", paths: list(str(o.localSource)) });
  if (o.urlSource) out.push({ type: "url", url: String(o.urlSource) });
  if (o.linear || o.linearTeamKey) out.push({ type: "linear", api_key_env: "LINEAR_API_KEY",
    team_key: str(o.linearTeamKey) ?? null, filter: str(o.linearFilter) ?? null });
  if (o.jiraSite) out.push({ type: "jira", site: String(o.jiraSite), email_env: "JIRA_EMAIL",
    token_env: "JIRA_API_TOKEN", jql: str(o.jiraJql) ?? "order by created DESC" });
  return out.length ? out : undefined;
}

/** PRM-54: where tickets come from. */
async function askSources(ctx: ActionContext): Promise<Source[] | undefined> {
  const where = await choose(ctx.deps, "Where do tickets come from?", ["Local files", "An HTTP(S) URL",
    "An external ticket provider", "Nowhere yet (Recommended)"]);
  const text = (q: string) => askText(ctx.deps, q, { required: true, refusal: "Type a value." });
  if (where === 0) return [{ type: "local", paths: list(await text("Local paths (comma-separated):")) }];
  if (where === 1) return [{ type: "url", url: String(await text("HTTP(S) URL:")) }];
  if (where !== 2) return undefined;
  const provider = await choose(ctx.deps, "External ticket provider:", ["Linear", "Jira"]);
  if (provider === 0) {
    const team = await text("Linear team key:");
    const filter = await askText(ctx.deps, "Linear filter (optional):", { required: false, refusal: "" });
    return [{ type: "linear", api_key_env: "LINEAR_API_KEY", team_key: team, filter: filter || null }];
  }
  return [{ type: "jira", site: String(await text("Jira site:")), email_env: "JIRA_EMAIL",
    token_env: "JIRA_API_TOKEN", jql: String(await text("Jira JQL:")) }];
}

const SIZES: Readonly<Record<string, string>> = Object.freeze({ XS: "shared", S: "shared", M: "per-ticket",
  L: "per-ticket", XL: "per-ticket" });
const STRATEGIES: readonly string[] = Object.freeze(["current", "batch", "branch-per-ticket"]);
const COMPLETIONS: readonly string[] = Object.freeze(["pr", "pr-ready", "auto-merge", "direct-merge", "none"]);

/** PRM-52 (skipped when you manage git, ARCH-6): base, prefix, strategy or size policy, title standard, delivery. */
async function askBuild(ctx: ActionContext, b: Record<string, unknown>): Promise<void> {
  const o = ctx.opts;
  if (o.base === undefined) b.base_branch = await askText(ctx.deps, "Base branch:", { required: false, refusal: "" })
    || undefined;
  if (o.branchPrefix === undefined) b.branch_prefix = await askText(ctx.deps, "Branch prefix:",
    { required: false, refusal: "" }) || undefined;
  if (o.branchStrategy === undefined) {
    const global = await choose(ctx.deps, "Use one global branch strategy or choose by inferred ticket size?",
      ["One global strategy (Recommended)", "Choose by ticket size"]);
    if (global === 0) b.branch_strategy = STRATEGIES[await choose(ctx.deps, "Branch strategy:", STRATEGIES) ?? 0];
    else {
      const keep = await yes(ctx, "Keep the recommended size mapping?");
      b.branch_policy = { mode: "size", global_strategy: "branch-per-ticket", by_size: keep ? SIZES
        : { ...SIZES, M: "shared" } };
    }
  }
  const title = await choose(ctx.deps, "PR/MR title standard:", ["Ticket id and title (Recommended)",
    "Conventional commits", "Custom"]);
  const template = title === 2 ? await askText(ctx.deps, "Custom title template (use {id} and {title}):",
    { required: true, refusal: "Type a template." }) : null;
  b.review = { title_style: ["ticket-title", "conventional", "custom"][title ?? 0], title_template: template,
    description_sections: [] };
  if (o.completion === undefined) b.completion = COMPLETIONS[await choose(ctx.deps,
    "How should finished work be delivered?", COMPLETIONS) ?? 4];
}

async function answers(ctx: ActionContext, engine: Engine, update: boolean): Promise<SetupAnswers | string> {
  const o = ctx.opts;
  const completion = str(o.completion);
  if (completion && !COMPLETIONS.includes(completion)) return `--completion takes ${COMPLETIONS.join(", ")}.`;
  const strategy = str(o.branchStrategy);
  if (strategy && !STRATEGIES.includes(strategy)) return `--branch-strategy takes ${STRATEGIES.join(", ")}.`;
  const build: Record<string, unknown> = { branch_strategy: strategy, branch_prefix: str(o.branchPrefix), completion,
    provider: str(o.provider), auto_merge_wait: o.autoMergeWait ? true : undefined,
    auto_merge_timeout_minutes: o.autoMergeTimeoutMinutes === undefined ? undefined
      : Number(o.autoMergeTimeoutMinutes) };
  const populate: Record<string, unknown> = { mode: str(o.populationMode), agent_preference: str(o.agentPreference) };
  let sources = flagSources(o);
  let checklist: string[] | undefined;
  if (asks(ctx)) {
    if (!(await yes(ctx, "Use the recommended population settings?"))) {
      populate.source_handling = ["saved", "prompt", "manual"][await choose(ctx.deps,
        "How should saved sources be handled?", ["Use the saved sources", "Ask each time", "Manual"]) ?? 0];
      populate.agent_preference ??= ["configured", "claude", "codex"][await choose(ctx.deps,
        "When both runtimes are configured, which should populate use?", ["The configured one", "Claude",
          "Codex"]) ?? 0];
      populate.recommend_split_for_xl = await yes(ctx, "Recommend splitting XL tickets?");
    }
    if (!(await managedByMe(engine))) await askBuild(ctx, build);
    checklist = list(await askText(ctx.deps, "Project-wide checks for QA to verify on every ticket " +
      "(comma-separated):", { required: false, refusal: "" }));
    if (!sources && !update) sources = await askSources(ctx);
  }
  return { appName: str(o.appName), docsRoot: str(o.docsRoot), sources, populate, build, checklist };
}

const setup = (update: boolean): Action => (ctx) => withEngine(ctx, async (engine) => {
  const tracker = Boolean(await ctx.deps.fs.stat(path.join(ctx.project, ".tickets", "config.yaml")));
  if (!update && !tracker && (!asks(ctx) || await yes(ctx, "Initialize the ticket tracker now?"))) {
    const limits = !asks(ctx) || await yes(ctx, "Keep both default limits?") ? { implementation: 500, view: 20000 }
      : { implementation: Number(await askText(ctx.deps, "Rows in the progress doc:", { required: true,
        refusal: "Type a number." })), view: Number(await askText(ctx.deps, "View size:", { required: true,
        refusal: "Type a number." })) };
    await initTracker(engine, { appName: str(ctx.opts.appName), docsRoot: str(ctx.opts.docsRoot) ??
      await docsRoot(ctx), implementationLimit: limits.implementation, viewLimit: limits.view });
  }
  const a = await answers(ctx, engine, update);
  if (typeof a === "string") return said(ctx, { ok: false, message: a });
  const r = await setupTickets(engine, a, { update, skipAccessCheck: Boolean(ctx.opts.skipAccessCheck) });
  for (const l of r.lines) ctx.deps.terminal.write(`${l}\n`);
  return r.ok ? 0 : said(ctx, { ok: false, message: r.message });
});

const waive: Action = (ctx) => withEngine(ctx, async (engine) => {
  const ids = ctx.opts.tickets as string[] | undefined;
  let reason = str(ctx.opts.reason);
  if (reason === undefined && ctx.deps.terminal.isTTY) {
    const gaps = await riskGaps(engine);
    const named = ids?.join(", ") ?? (typeof gaps === "string" ? "" : gaps.map((g) => g.id).join(", "));
    reason = await askText(ctx.deps, `Reason for waiving rollback plans for ${named}:`, { required: true,
      refusal: "A waiver needs a reason." }) ?? undefined;
  }
  return said(ctx, await waiveRiskNotes(engine, ids, reason ?? "", who(ctx)));
});

const repair: Action = (ctx) => withEngine(ctx, async (engine) => {
  if (!ctx.opts.riskNotes) return said(ctx, { ok: false, message: "rafi tickets repair takes --risk-notes." });
  const gaps = await riskGaps(engine);
  if (typeof gaps === "string") return said(ctx, { ok: false, message: gaps });
  const open = gaps.filter((g) => !g.waived);
  if (!open.length) return said(ctx, { ok: true, line: "Every Medium and High ticket has a rollback plan or a " +
    "waiver." });
  ctx.deps.terminal.write(`${open.map((g) => `${g.id} (${g.risk}) has no rollback plan.`).join("\n")}\n`);
  if (!ctx.opts.apply) return 0;
  if (!ctx.opts.yes && !ctx.deps.terminal.isTTY) {
    return said(ctx, { ok: false, message: "repair --risk-notes --apply asks before writing; pass -y to apply " +
      "without asking." });
  }
  const o = ctx.opts;
  const flags = { agent: o.agent as "claude" | "codex" | undefined, model: str(o.model), effort: str(o.effort),
    fast: o.fast ? true : undefined };
  const proposed = await proposeRollbacks(engine, flags, (t) => ctx.deps.terminal.write(line(t)));
  if (!proposed.ok) return said(ctx, proposed);
  for (const p of proposed.proposals) ctx.deps.terminal.write(`  ${p.id}: ${p.rollback}\n`);
  const ids = proposed.proposals.map((p) => p.id).join(", ");
  if (!o.yes && !(await yes(ctx, `Apply rollback-only repairs to ${ids}?`))) {
    return said(ctx, { ok: true, line: "Cancelled; no ticket definitions changed." });
  }
  const r = await applyRollbacks(engine, proposed.proposals, who(ctx));
  if (!r.ok) return said(ctx, r);
  await rerender(ctx, engine);
  const problems = await validateTickets(engine, await docsRoot(ctx));
  if (problems.length) return said(ctx, { ok: false, message: `The repair was written, but validation still ` +
    `fails: ${problems[0]}` });
  return said(ctx, r);
});

const groupsList: Action = (ctx) => withEngine(ctx, async (engine) => {
  const all = await groups(engine);
  if (ctx.opts.json) {
    ctx.deps.terminal.write(`${JSON.stringify({ version: 1, groups: all.map((g) => ({ id: g.id, created_at: g.at,
      origin: g.origin, tickets: g.members.map((m) => m.ticket) })) }, null, 2)}\n`);
    return 0;
  }
  ctx.deps.terminal.write(all.length ? `${all.map((g) => `${g.id}  ${g.origin}  ${g.members.map((m) => m.ticket)
    .join(", ")}`).join("\n")}\n` : "No creation groups yet. `rafi tickets groups repair` makes one.\n");
  return 0;
});

const groupsRepair: Action = (ctx) => withEngine(ctx, async (engine) => {
  const outside = await ungrouped(engine);
  if (typeof outside === "string") return said(ctx, { ok: false, message: outside });
  if (!outside.length) return said(ctx, { ok: true, line: "Every ticket is already in a group." });
  if (!ctx.opts.yes) {
    if (!ctx.deps.terminal.isTTY) return said(ctx, { ok: false, message: "Pass --yes to create the group." });
    if (!(await yes(ctx, `Create one repair group for exactly ${outside.length} ticket(s)? (${outside.map((t) => t.id)
      .join(", ")})`))) return said(ctx, { ok: true, line: "Nothing was changed." });
  }
  return said(ctx, await repairGroups(engine, outside.length, who(ctx)));
});

function resetTarget(ctx: ActionContext) {
  const o = ctx.opts;
  return { ticket: str(ctx.args[0]), scope: str(o.scope), group: str(o.group), groupIndex: o.groupIndex === undefined
    ? undefined : Number(o.groupIndex), recentGroups: o.recentGroups === undefined ? undefined
    : Number(o.recentGroups), allGroups: Boolean(o.allGroups) };
}

const reset: Action = (ctx) => withEngine(ctx, async (engine) => {
  const t = resetTarget(ctx);
  const tty = ctx.deps.terminal.isTTY;
  const targets = [t.ticket, t.scope ?? (ctx.opts.all ? "all" : undefined), t.group, t.groupIndex, t.recentGroups,
    t.allGroups || undefined].filter((x) => x !== undefined);
  if (targets.length !== 1) return said(ctx, { ok: false, message: "Name one target: a ticket, --scope, --all, " +
    "--group, --group-index, --recent-groups or --all-groups." });
  if (ctx.opts.all && !t.scope) {
    if (!tty) return said(ctx, { ok: false, message: "--all asks which tickets in a terminal; use --scope <scope> " +
      "--yes without one." });
    const scopes = ["all", "completed-and-unfinished", "unfinished"];
    const picked = await choose(ctx.deps, "Which tickets should return to an unworked state?", ["All tickets",
      "Completed and unfinished (not canceled)", "Unfinished only (not done or canceled)"]);
    if (picked === null) return said(ctx, { ok: true, line: "Nothing was changed." });
    t.scope = scopes[picked];
  }
  const p = await previewReset(engine, t);
  if ("message" in p) return said(ctx, { ok: false, message: p.message });
  if (p.live) return said(ctx, { ok: false, message: `Build ${p.live} is running; stop it first (\`rafi stop\`).` });
  for (const r of p.tickets) ctx.deps.terminal.write(`  ${r.id}: ${r.title} [${r.status}]\n`);
  if (p.interrupted) {
    ctx.deps.terminal.write(`${p.interrupted.tickets.join(", ")} belong to build ${p.interrupted.run}, which was ` +
      "interrupted. A tracker reset doesn't restart it: `rafi reset` (this build → restart-current) does.\n");
    if (tty && !ctx.opts.yes) {
      const pick = await choose(ctx.deps, "These tickets belong to an interrupted build. What should rafi do?", [
        `Restart build ${p.interrupted.run} from your current files: use \`rafi reset\``,
        "Reset tracker state only; leave the build's recovery as it is", "Cancel"]);
      if (pick === 0) return said(ctx, { ok: true, line: "Nothing was changed. Run `rafi reset`, choose this build, " +
        "then restart-current." });
      if (pick !== 1) return said(ctx, { ok: true, line: "Nothing was changed." });
    }
  }
  let restore = ctx.opts.deletedTickets === "restore";
  if (ctx.opts.deletedTickets !== undefined && !["ignore", "restore"].includes(String(ctx.opts.deletedTickets))) {
    return said(ctx, { ok: false, message: "--deleted-tickets takes ignore or restore." });
  }
  if (p.missing.length && ctx.opts.deletedTickets === undefined && tty) {
    restore = (await choose(ctx.deps, `${p.missing.map((d) => d.id).join(", ")} ${p.missing.length > 1 ? "were" :
      "was"} deleted from tickets.yaml. Restore their definitions?`, ["Leave them out (Recommended)",
      "Restore them"])) === 1;
  }
  const n = p.tickets.length + (restore ? p.missing.length : 0);
  if (!n) return said(ctx, { ok: true, line: "No ticket matches; nothing was changed." });
  if (!ctx.opts.yes) {
    if (!tty) return said(ctx, { ok: false, message: "Pass --yes to reset without a terminal." });
    const q = p.grouped ? `Apply this frozen ${n}-member reset selection?`
      : `Reset ${n} ticket(s)? Historical events and validation remain available.`;
    if (!(await yes(ctx, q))) return said(ctx, { ok: true, line: "Nothing was changed." });
  }
  const r = await applyReset(engine, p, { ...who(ctx), restore });
  if (r.ok) await rerender(ctx, engine);
  return said(ctx, r);
});

const discoverAction: Action = (ctx) => withEngine(ctx, async (engine) => {
  const o = ctx.opts;
  const r = await discover(engine, { summary: str(o.summary), sourceTicket: str(o.sourceTicket),
    proposedTicket: str(o.proposedTicket), priority: str(o.priorityGuess), area: str(o.area),
    rationale: str(o.rationale), needsDecisionFrom: str(o.needsDecisionFrom) }, who(ctx));
  if (r.ok) await rerender(ctx, engine);
  return said(ctx, r);
});

const accept: Action = (ctx) => withEngine(ctx, async (engine) => {
  const r = await acceptFutureWork(engine, String(ctx.args[0]), { ticketId: str(ctx.opts.ticketId),
    order: ctx.opts.order === undefined ? undefined : Number(ctx.opts.order) }, who(ctx));
  if (r.ok) await rerender(ctx, engine);
  return said(ctx, r);
});

const reviewAction: Action = (ctx) => withEngine(ctx, async (engine) => {
  const o = ctx.opts;
  const actions = (["accept", "dismiss", "defer"] as const).filter((a) => o[a] || o[`${a}All`]);
  if (actions.length > 1) return said(ctx, { ok: false, message: "Pick one of accept, dismiss or defer." });
  if (!actions.length) {
    const open = (await recommendations(engine)).filter((r) => r.status === "open");
    ctx.deps.terminal.write(open.length ? `${open.map((r) => `${r.id}  ${r.kind}  ${r.text}`).join("\n")}\n`
      : "No open recommendations.\n");
    return 0;
  }
  const action = actions[0]!;
  const all = Boolean(o[`${action}All`]);
  if (!all && o.id === undefined) return said(ctx, { ok: false, message: `--${action} needs --id (or use ` +
    `--${action}-all).` });
  const r = await review(engine, action, all ? "all" : [String(o.id)], who(ctx));
  if (r.ok) await rerender(ctx, engine);
  return said(ctx, r);
});

const archive: Action = async (ctx) => {
  const root = await docsRoot(ctx);
  return withEngine(ctx, async (engine) => said(ctx, await archiveDone(engine, Number(ctx.opts.olderThanDays ?? 30),
    root)));
};

export const moreTicketActions: Readonly<Record<string, Action>> = Object.freeze({
  "tickets setup:init": setup(false), "tickets setup:update": setup(true), "tickets waive-risk-notes": waive,
  "tickets repair": repair, "tickets groups list": groupsList, "tickets groups repair": groupsRepair,
  "tickets reset": reset, "tickets discover": discoverAction, "tickets accept-future-work": accept,
  "tickets review": reviewAction, "tickets archive": archive,
});
