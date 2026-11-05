// A unit's `unit.ready` (4.3.2): written with the `delivery.done` of the last of its tickets, so the loop delivers
// it next. A unit that completes `none`, or whose git is left to you, has nothing to deliver and stays silent.
import type { BuildContext } from "../build/context.js";
import { commitTicket } from "./commit.js";
import { conflictHit } from "./conflict.js";
import { planOf } from "./worktree.js";

/**
 * The deliver step's git part: the ticket's commit, then the events to write with its `delivery.done` (the unit's
 * `unit.ready`). Null: a declared value is in a file to commit (C236), so the ticket is held (`step.failed`, so
 * blocked(other) with the deliver step kept) and the line names the file and the variable, never the value.
 */
export async function deliverCommit(ctx: BuildContext, id: string): Promise<{ type: string; data: unknown }[] | null> {
  const commit = await commitTicket(ctx, id);
  if (commit && !commit.ok) {
    await ctx.engine.append([{ type: "step.failed", run_id: ctx.run, ticket_id: id, actor: "engine",
      data: { category: "secret", reason: commit.held, circling: false } }]);
    ctx.ui.line(`${id} is held: ${commit.held}. Remove or ignore the file, then \`rafi tickets unblock ${id}\` and ` +
      "`rafi resume`.");
    return null;
  }
  return commit ? readyUnit(ctx, id) : [];
}

export async function readyUnit(ctx: BuildContext, ticket: string): Promise<{ type: string; data: unknown }[]> {
  const unit = planOf(ctx).units.find((u) => u.tickets.includes(ticket)) ?? (await conflictHit(ctx, ticket))?.unit;
  if (!unit || !unit.managed || unit.completion === "none") return [];
  const view = ctx.engine.fold(ctx.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
  // A unit is made ready from building (no event yet, or its conflict fix ticket added) or failed (4.3.2).
  if (!["building", "failed", undefined].includes(view.units[unit.id])) return [];
  const others = unit.tickets.filter((t) => t !== ticket);
  if (!others.every((t) => ["done", "dropped"].includes(view.tickets[t]?.state ?? ""))) return [];
  return [{ type: "unit.ready", data: { unit: unit.id } }];
}
