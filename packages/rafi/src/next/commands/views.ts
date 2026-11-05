// `rafi tickets show`, `rafi stats`, `rafi status`: views of the fold; readers open the log read-only and create
// nothing (ARCH 3.6, C147).
import { eventsExport, openEngine, renderStats, runStats, statusLines, ticketsView } from "@rafi-ai/engine";
import path from "node:path";
import { line } from "../ui/lines.js";
import type { ActionContext } from "./actions.js";

/** OUT-4: the readable record: definition, state, recalculated blockers, validation history, events, delivery. */
function readable(t: Record<string, unknown>): string {
  const v = t.validation as { result: string; runs: { run: number; command: string | null; outcome: string | null }[] }
    | null;
  const block = t.block as { kind: string; reason: string } | null;
  const delivery = t.delivery as { unit: string; branch_mode: string | null; completion: string | null } | null;
  const acceptance = (t.acceptance as string[]).map((a, n) => `    R${n + 1}. ${a}`);
  const events = (t.events as { seq: number; at: string; type: string; actor: string }[])
    .map((e) => `    ${e.at}  ${e.type} (${e.actor})`);
  return [`${String(t.id)}: ${String(t.title)}`,
    `  State: ${String(t.state)}${t.step ? ` at ${String(t.step)}` : ""} (tracker: ${String(t.status)}); risk ${
      String(t.risk)}${t.size ? `, size ${String(t.size)}` : ""}`,
    `  Blockers: ${block ? `${block.kind}: ${block.reason}` : (t.waits as string[]).length ? `waits on ${(t.waits as
      string[]).join(", ")}` : "none"}`,
    `  Depends on: ${(t.depends_on as string[]).join(", ") || "nothing"}; tags: ${(t.tags as string[]).join(", ") ||
      "none"}`, "  Acceptance:", ...acceptance,
    `  Required tests: ${(t.required_tests as string[]).join("; ") || "none"}`,
    `  Validation: ${v ? `${v.result}; runs ${v.runs.map((r) => `${r.run} ${r.command ?? ""} ${r.outcome ?? ""}`
      .trim()).join(", ") || "none"}` : "none yet"}`,
    `  Delivery: ${delivery ? `unit ${delivery.unit} (${delivery.branch_mode ?? "default branch mode"}, ${
      delivery.completion ?? "default completion"})` : "not in a delivery unit"}`,
    `  Events (${events.length}):`, ...events, ""].join("\n");
}

export async function ticketsShowAction(ctx: ActionContext): Promise<number> {
  const engine = await openEngine({ projectDir: ctx.project, deps: ctx.deps, readOnly: true });
  try {
    const view = await ticketsView(engine);
    if (!view.ok) { ctx.deps.terminal.error(line(view.message)); return 1; }
    const id = ctx.args[0] as string | undefined;
    const tickets = id ? view.tickets.filter((t) => t.id === id) : view.tickets;
    if (id && !tickets.length) { ctx.deps.terminal.error(line(`There's no ticket ${id}.`)); return 1; }
    const json = `${JSON.stringify({ version: 1, tickets }, null, 2)}\n`;
    if (ctx.opts.output) {
      // OUT-30: --output appends a pretty-printed block, creating the folders it needs.
      const file = path.resolve(ctx.deps.cwd, String(ctx.opts.output));
      await ctx.deps.fs.mkdir(path.dirname(file));
      await ctx.deps.fs.append(file, json);
      ctx.deps.terminal.write(`Appended ${tickets.length} ticket(s) to ${String(ctx.opts.output)}.\n`);
      return 0;
    }
    ctx.deps.terminal.write(ctx.opts.json ? json : tickets.map((t) => readable(t)).join("\n"));
    return 0;
  } finally {
    engine.close();
  }
}

export async function statsExportAction(ctx: ActionContext): Promise<number> {
  const engine = await openEngine({ projectDir: ctx.project, deps: ctx.deps, readOnly: true });
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
  const engine = await openEngine({ projectDir: ctx.project, deps: ctx.deps, readOnly: true });
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
  const engine = await openEngine({ projectDir: ctx.project, deps: ctx.deps, readOnly: true });
  try {
    ctx.deps.terminal.write(`${(await statusLines(engine)).join("\n")}\n`);
    return 0;
  } finally {
    engine.close();
  }
}
