// `rafi tickets show` and `rafi stats export`: views of the fold; readers never write (ARCH 3.6).
import { eventsExport, openEngine, renderStats, runStats, statusLines, ticketsView } from "@rafi-ai/engine";
import { line } from "../ui/lines.js";
import type { ActionContext } from "./actions.js";

export async function ticketsShowAction(ctx: ActionContext): Promise<number> {
  const engine = await openEngine({ projectDir: ctx.project, deps: ctx.deps });
  try {
    const view = await ticketsView(engine);
    if (!view.ok) { ctx.deps.terminal.error(line(view.message)); return 1; }
    const id = ctx.args[0] as string | undefined;
    const tickets = id ? view.tickets.filter((t) => t.id === id) : view.tickets;
    if (id && !tickets.length) { ctx.deps.terminal.error(line(`There's no ticket ${id}.`)); return 1; }
    if (ctx.opts.json) { ctx.deps.terminal.write(`${JSON.stringify({ tickets }, null, 2)}\n`); return 0; }
    for (const t of tickets) {
      const block = t.block as { reason: string } | null;
      ctx.deps.terminal.write(`${String(t.id)}  ${String(t.status)}  ${String(t.title)}` +
        `${block ? ` — ${block.reason}` : ""}\n`);
    }
    return 0;
  } finally {
    engine.close();
  }
}

export async function statsExportAction(ctx: ActionContext): Promise<number> {
  const engine = await openEngine({ projectDir: ctx.project, deps: ctx.deps });
  try {
    const text = await eventsExport(engine, { run: ctx.opts.run as string | undefined });
    if (ctx.opts.output) await ctx.deps.fs.writeAtomic(String(ctx.opts.output), text);
    else ctx.deps.terminal.write(text);
    return 0;
  } finally {
    engine.close();
  }
}

export async function statsShowAction(ctx: ActionContext): Promise<number> {
  const engine = await openEngine({ projectDir: ctx.project, deps: ctx.deps });
  try {
    const stats = await runStats(engine, { run: ctx.opts.run as string | undefined,
      ticket: ctx.opts.ticket as string | undefined });
    if (!stats) { ctx.deps.terminal.error(line("No build has run in this project yet.")); return 1; }
    ctx.deps.terminal.write(ctx.opts.format === "json" ? `${JSON.stringify(stats, null, 2)}\n` : renderStats(stats));
    return 0;
  } finally {
    engine.close();
  }
}

export async function statusAction(ctx: ActionContext): Promise<number> {
  const engine = await openEngine({ projectDir: ctx.project, deps: ctx.deps });
  try {
    ctx.deps.terminal.write(`${(await statusLines(engine)).join("\n")}\n`);
    return 0;
  } finally {
    engine.close();
  }
}
