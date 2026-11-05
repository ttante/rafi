// Where delivery meets the build loop (M5 slice 5): a ticket's steps run in its workspace; a delivery failure is
// recorded for the unit (`unit.failed` with 5.1's category) and, when a ticket's step hit it, for that ticket
// (`step.failed`, so it's blocked(other) with its resume step kept); the rest of the build goes on (NEW-KEEP-2).
import { openDelivery } from "../ask/delivery.js";
import type { BuildContext } from "../build/context.js";
import { setting } from "../build/context.js";
import type { TicketDefinition } from "../state/types.js";
import { deliverUnit } from "./deliver.js";
import { DefinitionsChanged } from "./intent.js";
import { ProviderFailed } from "./provider.js";
import { GitFailed } from "./run.js";
import { DeliveryFailed, planOf, workspaceFor } from "./worktree.js";

async function failed(ctx: BuildContext, unit: string, category: string, message: string, ticket: string | null) {
  const line = ctx.engine.redact(message.split("\n")[0]!.slice(0, 300));
  await ctx.engine.append([
    ...(ticket ? [{ type: "step.failed", run_id: ctx.run, ticket_id: ticket, actor: "engine",
      data: { category: "delivery", reason: line, circling: false } }] : []),
    { type: "unit.failed", run_id: ctx.run, ticket_id: null, actor: "engine", data: { unit, category, message: line } },
  ]);
  ctx.ui.line(`Delivery unit ${unit} failed (${category}): ${line.replace(/\.?$/, ".")} ${ticket ? `${ticket} waits; `
    : ""}the units that don't wait on it go on.`);
  // C203: a unit's conflict asks the delivery question; `auth` and `rejected` are build-wide questions (M6).
  if (category === "conflict" && !ticket) {
    const tickets = planOf(ctx).units.find((u) => u.id === unit)?.tickets ?? [];
    const files = /conflicts in (.+?)\.?$/.exec(line)?.[1]?.split(", ").filter((f) => f !== "…");
    await openDelivery(ctx.engine, ctx.run, { unit, tickets, why: "conflict", message: line, files });
  }
}

function asFailure(error: unknown, unit: string): DeliveryFailed | null {
  if (error instanceof DeliveryFailed) return error;
  if (error instanceof ProviderFailed) return new DeliveryFailed(unit, error.category, error.message);
  if (error instanceof GitFailed) return new DeliveryFailed(unit, "rejected", error.message);
  return null;
}

const unitOf = (ctx: BuildContext, ticket: string) =>
  planOf(ctx).units.find((u) => u.tickets.includes(ticket))?.id ?? `U-${ticket}`;

/** Runs one step of `ticket` in its workspace (the main checkout when git is left to you). */
export async function inWorkspace(ctx: BuildContext, ticket: string, run: (c: BuildContext) => Promise<void>) {
  let project: string;
  try {
    project = await workspaceFor(ctx, ticket);
  } catch (error) {
    if (error instanceof DefinitionsChanged) return; // C238: back to the safe point, nothing done
    const f = asFailure(error, unitOf(ctx, ticket));
    if (!f) throw error;
    return failed(ctx, f.unit, f.category, f.message, ticket);
  }
  try {
    return await run(project === ctx.project ? ctx : { ...ctx, project });
  } catch (error) {
    if (error instanceof DefinitionsChanged) return; // C238: back to the safe point, nothing done
    const f = asFailure(error, unitOf(ctx, ticket));
    if (!f) throw error;
    return failed(ctx, f.unit, f.category, f.message, ticket);
  }
}

/** The loop's `deliver-unit` action, with its failure recorded for the unit. A `transient` failure (5.1) is
 * retried with backoff on the clock, up to `retries.turn` times, before it's recorded. */
export async function deliverAction(ctx: BuildContext, unit: string, state: string): Promise<void> {
  const retries = setting<number>(ctx, "retries.turn") ?? 3;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await deliverUnit(ctx, unit, state);
    } catch (error) {
      if (error instanceof DefinitionsChanged) return;
      const f = asFailure(error, unit);
      if (!f) throw error;
      if (f.category !== "transient" || attempt >= retries) return failed(ctx, f.unit, f.category, f.message, null);
      ctx.ui.line(`${unit}: ${f.message.split("\n")[0]} Retrying in ${5 * 2 ** attempt} s.`);
      await ctx.deps.clock.sleep(5000 * 2 ** attempt, "backoff", ctx.control?.now.signal);
    }
  }
}

/**
 * The fold's ticket definitions with delivery's waits: a ticket whose unit depends on another with `wait` or
 * `stack` starts once that unit is delivered (`after`); on a unit that completes `none` (nothing to deliver), once
 * its tickets are done. `combine` joins the units' tickets as dependencies.
 */
export function definitionsOf(ctx: BuildContext): TicketDefinition[] {
  const plan = planOf(ctx);
  return ctx.tickets.map((t) => {
    const unit = plan.units.find((u) => u.tickets.includes(t.id));
    const deps = (unit?.dependsOn ?? []).map((d) => plan.units.find((u) => u.id === d)).filter((u) => u !== undefined);
    const waitOn = deps.filter((d) => unit!.dependencyMode !== "combine" && d.completion !== "none" && d.managed);
    const ticketsOf = deps.filter((d) => !waitOn.includes(d)).flatMap((d) => d.tickets);
    return { id: t.id, dependsOn: [...new Set([...t.depends_on, ...ticketsOf])],
      ...(waitOn.length ? { after: waitOn.map((d) => d.id) } : {}) };
  });
}
