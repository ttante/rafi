// The `rafi tickets` subcommands built on the log in M5 part 4a (C181, C208): each parses, calls one engine function
// and prints one line. Writes record `--actor` (default user) and the source (`flag`, or `terminal` when a person
// typed the command in one). The rest of S-CLI-4's subcommands are in tickets-more.ts (part 4a-2).
import {
  adoptProject, cancelTicket, initTracker, loadConfig, loadTickets, openEngine, queueRows, refreshPrs, reorderTicket,
  setTicketStatus,
  validateTickets,
  VALIDATION_PASSED, writeProgressDoc, type Engine, type TicketWrite,
} from "@rafi-ai/engine";
import { line } from "../ui/lines.js";
import type { Action, ActionContext } from "./actions.js";

export async function docsRoot(ctx: ActionContext): Promise<string> {
  const config = await loadConfig(ctx.deps.fs, ctx.project);
  const root = config.ok ? (config.config as { docs?: { root?: unknown } }).docs?.root : undefined;
  return typeof root === "string" ? root : "docs";
}

export async function withEngine(ctx: ActionContext, fn: (engine: Engine) => Promise<number>): Promise<number> {
  const engine = await openEngine({ projectDir: ctx.project, deps: ctx.deps });
  try {
    // ARCH 4.4 (C62): the first command that writes records a hand-written project as created.
    const [config, tickets] = [await loadConfig(ctx.deps.fs, ctx.project), await loadTickets(ctx.deps.fs, ctx.project)];
    if (config.ok && tickets.ok) await adoptProject(engine, config.config, tickets.tickets.map((t) => t.id));
    return await fn(engine);
  } finally { engine.close(); }
}

export const who = (ctx: ActionContext) => ({ actor: String(ctx.opts.actor ?? "user"),
  source: ctx.deps.terminal.isTTY ? "terminal" as const : "flag" as const });

export function said(ctx: ActionContext, r: TicketWrite): number {
  if (!r.ok) { ctx.deps.terminal.error(line(r.message)); return 1; }
  ctx.deps.terminal.write(`${r.line}\n`);
  return 0;
}

const id = (ctx: ActionContext) => String(ctx.args[0]);
const text = (v: unknown) => (v === undefined ? null : String(v));
const STATUSES: readonly string[] = ["planned", "next", "in_progress", "blocked", "done", "canceled"];

const update: Action = (ctx) => withEngine(ctx, async (engine) => {
  const status = String(ctx.opts.status ?? "planned");
  if (!STATUSES.includes(status)) return said(ctx, { ok: false, message: `--status takes ${STATUSES.join(", ")}.` });
  if (status === "canceled") return said(ctx, await cancelTicket(engine, id(ctx), "", who(ctx)));
  return said(ctx, await setTicketStatus(engine, id(ctx), { status: status as "planned", summary: text(ctx.opts
    .summary), evidence: text(ctx.opts.evidence), validation: text(ctx.opts.validationResult) }, who(ctx)));
});

const complete: Action = (ctx) => withEngine(ctx, async (engine) => {
  const result = String(ctx.opts.validationResult ?? "passed");
  if (ctx.opts.evidence === undefined && result !== "not_applicable") {
    return said(ctx, { ok: false, message: "rafi tickets complete needs --evidence (or --validation-result " +
      "not_applicable)." });
  }
  return said(ctx, await setTicketStatus(engine, id(ctx), { status: "done", summary: text(ctx.opts.summary),
    validation: result, evidence: text(ctx.opts.evidence) }, who(ctx)));
});

const block: Action = (ctx) => withEngine(ctx, async (engine) => said(ctx, await setTicketStatus(engine, id(ctx),
  { status: "blocked", summary: text(ctx.opts.summary) }, who(ctx))));

const unblock: Action = (ctx) => withEngine(ctx, async (engine) => said(ctx, await setTicketStatus(engine, id(ctx),
  { status: "planned", summary: text(ctx.opts.summary) }, who(ctx))));

const cancel: Action = (ctx) => withEngine(ctx, async (engine) => {
  if (ctx.opts.summary === undefined) return said(ctx, { ok: false, message: "rafi tickets cancel needs --summary " +
    "saying why." });
  return said(ctx, await cancelTicket(engine, id(ctx), String(ctx.opts.summary), who(ctx)));
});

const reorder: Action = (ctx) => withEngine(ctx, async (engine) => said(ctx, await reorderTicket(engine, id(ctx),
  { order: ctx.opts.order === undefined ? undefined : Number(ctx.opts.order), after: ctx.opts.after as string
    | undefined }, who(ctx))));

const render: Action = async (ctx) => {
  const root = await docsRoot(ctx);
  return withEngine(ctx, async (engine) => {
    const file = await writeProgressDoc(engine, engine.fold(), { docsRoot: root, force: true });
    ctx.deps.terminal.write(`Wrote ${file}.\n`);
    return 0;
  });
};

const validate: Action = async (ctx) => {
  const root = await docsRoot(ctx);
  const engine = await openEngine({ projectDir: ctx.project, deps: ctx.deps, readOnly: true });
  try {
    const problems = await validateTickets(engine, root);
    if (!problems.length) { ctx.deps.terminal.write(`${VALIDATION_PASSED}\n`); return 0; }
    ctx.deps.terminal.error(`${problems.map((p) => line(p)).join("")}`);
    return 1;
  } finally { engine.close(); }
};

const queue: Action = async (ctx) => {
  const engine = await openEngine({ projectDir: ctx.project, deps: ctx.deps, readOnly: true });
  try {
    const loaded = await loadTickets(ctx.deps.fs, ctx.project);
    if (!loaded.ok) { ctx.deps.terminal.error(line(loaded.message)); return 1; }
    const view = engine.fold(loaded.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
    const limit = ctx.opts.limit === undefined ? Infinity : Number(ctx.opts.limit);
    const rows = queueRows(view).slice(0, limit);
    if (!rows.length) { ctx.deps.terminal.write("No remaining tickets.\n"); return 0; }
    rows.forEach((r, n) => ctx.deps.terminal.write(`${String(n + 1).padStart(3)}. ${r.id}  ${loaded.tickets.find((t) =>
      t.id === r.id)?.title ?? "(rafi's fix ticket)"}  ${r.waits.length ? `waits on ${r.waits.join(", ")}` : ""}\n`));
    if (ctx.opts.refresh) {
      const prs = await refreshPrs(engine);
      ctx.deps.terminal.write(prs.length ? `Pull requests:\n${prs.map((p) => `  ${p.unit} ${p.branch}: ${p.state} ` +
        `${p.url}\n`).join("")}` : "Pull requests: none opened by rafi.\n");
    }
    return 0;
  } finally { engine.close(); }
};

const init: Action = async (ctx) => {
  const root = String(ctx.opts.docsRoot ?? await docsRoot(ctx));
  return withEngine(ctx, async (engine) => {
    const made = await initTracker(engine, { appName: ctx.opts.appName as string | undefined, timezone: ctx.opts
      .timezone as string | undefined, implementationLimit: Number(ctx.opts.implementationLimit ?? 500),
    viewLimit: Number(ctx.opts.viewLimit ?? 20000), docsRoot: root });
    ctx.deps.terminal.write(made.length ? `Created ${made.join(", ")}.\n` : "The tracker is already set up.\n");
    return 0;
  });
};

export const ticketActions: Readonly<Record<string, Action>> = Object.freeze({
  "tickets update": update, "tickets complete": complete, "tickets block": block, "tickets unblock": unblock,
  "tickets cancel": cancel, "tickets reorder": reorder, "tickets render": render, "tickets validate": validate,
  "tickets queue": queue, "tickets init": init,
});
