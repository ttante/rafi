// C235 (P51): every git or gh/glab effect of delivery is a lookup, then `git.intent` naming what the effect should
// leave, written only while this instance holds the build's lease (checked inside the append's transaction), then
// boundary "6: before …", the effect with git's or the provider's own compare-and-set, boundary "6: after …", and
// the result event. A redo looks for the recorded result first, then for the effect in the world, and adopts it.
// C238 (R19): right before that write, `.tickets/delivery.yaml` is compared with the definitions the build plans
// from (C284: the transaction is synchronous and can't read the file); a difference means no intent and no effect:
// DefinitionsChanged sends the step back to the safe point, which records the change once and decides again.
// A unit's delivery checks at its first intent only, then goes ahead as intended (C283).
import type { BuildContext } from "../build/context.js";
import { boundary } from "../deps/hooks.js";
import { holdsLease } from "../log/lease.js";
import type { StoredEvent } from "../log/types.js";
import { digestsNow } from "../tickets/load.js";
import type { GitAt } from "./run.js";

export type IntentOp = "branch" | "commit" | "push" | "pr-create" | "pr-ready" | "auto-merge" | "merge";

export interface Intent {
  readonly op: IntentOp;
  readonly unit: string | null;
  readonly ticket: string | null;
  readonly ref: string | null;
  readonly old: string | null;
  readonly new: string | null;
  readonly tree: string | null;
}

/** The build lost its lease between the lookup and the effect: no further effect is made (R9). */
export class NotOwner extends Error {
  constructor(run: string) { super(`build ${run} isn't owned by this rafi any more; no git action was taken`); }
}

/** `.tickets/delivery.yaml` isn't what the build plans from (R19): no git action was taken. */
export class DefinitionsChanged extends Error {
  constructor() { super(".tickets/delivery.yaml changed; rafi decides again before any git action"); }
}

export const gitAt = (ctx: BuildContext): GitAt => ({ deps: ctx.deps, project: ctx.engine.projectDir });

/** Writes the intent through the owner's guarded write; throws NotOwner when this instance lost the lease, and
 * DefinitionsChanged when delivery.yaml isn't the one the build planned from (C238). */
export async function intend(ctx: BuildContext, i: Intent): Promise<void> {
  const planned = ctx.digests && !ctx.delivering?.checked ? ctx.digests.delivery_digest : undefined;
  const file = planned === undefined ? undefined
    : (await digestsNow(ctx.deps.fs, ctx.engine.projectDir)).delivery_digest;
  if (file !== planned) throw new DefinitionsChanged();
  await ctx.engine.append([{ type: "git.intent", run_id: ctx.run, ticket_id: i.ticket, actor: "engine",
    data: i }], { inTx: (db) => {
    if (!holdsLease(db, ctx.deps.processes, ctx.run)) throw new NotOwner(ctx.run);
  } });
  if (ctx.delivering) ctx.delivering.checked = true;
}

/** The effect between its two boundaries (ARCH 4.6 row 6, C226): "6: before push (U1 feature/T1-…)". */
export async function effect<T>(ctx: BuildContext, i: Intent, what: string, act: () => Promise<T>): Promise<T> {
  await intend(ctx, i);
  const label = `${i.op} (${[i.ticket ?? i.unit, what].filter(Boolean).join(" ")})`;
  await boundary(ctx.deps.hooks, `6: before ${label}`);
  const out = await act();
  await boundary(ctx.deps.hooks, `6: after ${label}`);
  return out;
}

/** Appends the result event (state, build scope unless a ticket is named). */
export function recordResult(ctx: BuildContext, type: string, ticket: string | null,
  data: { sha?: string | null; branch?: string | null; url?: string | null; unit: string | null }) {
  return ctx.engine.append([{ type, run_id: ctx.run, ticket_id: ticket, actor: "engine",
    data: { sha: data.sha ?? null, branch: data.branch ?? null, url: data.url ?? null, unit: data.unit } }]);
}

/** Every event of the log, for "was this result recorded already?" lookups. */
export async function logEvents(ctx: BuildContext): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  for await (const e of ctx.engine.events()) out.push(e);
  return out;
}

/** The newest recorded result of `type` matching `where`, in any run (a redo adopts what an earlier try did). */
export function recorded(events: readonly StoredEvent[], type: string,
  where: (d: Record<string, unknown>, e: StoredEvent) => boolean): Record<string, unknown> | null {
  const hit = events.filter((e) => e.type === type && where((e.data ?? {}) as Record<string, unknown>, e)).at(-1);
  return hit ? (hit.data as Record<string, unknown>) : null;
}
