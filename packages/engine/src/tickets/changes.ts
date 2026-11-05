// P41 and C210/C211: each change to `.tickets/tickets.yaml` or `.tickets/delivery.yaml` is recorded once, by
// whichever process sees it first. `recordChange` appends `tickets.changed` with the files' digests, and inside the
// append's own transaction it compares them with the newest recorded pair: equal means someone recorded this exact
// content already, so nothing is written (R2). `rereadDefinitions` is the safe point's re-read (ARCH 4.6 item 3):
// the build compares the files with the digests it planned from; a difference is recorded (unless already) and
// applied from the next step, change-then-tell, with one line. An invalid file keeps the last good definitions with
// one line naming the file and field (M6 makes it the build-wide question).
import type { DeliveryUnit, TicketV1 } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import type { BuildContext } from "../build/context.js";
import type { Db } from "../deps/types.js";
import { MATERIAL_FIELDS } from "../state/ticket.js";
import { digestsNow, loadTickets, sameDigests, type Digests } from "./load.js";

export type ChangeItem = { ticket: string; field: string } | { unit: string; field: string };

/** The definitions a build plans from, with the digests of the files it read them from. */
export interface Definitions extends Digests {
  readonly tickets: readonly TicketV1[];
  readonly units: readonly DeliveryUnit[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function fieldsChanged<T extends { id: string }>(before: readonly T[], after: readonly T[], key: "ticket" | "unit"):
  ChangeItem[] {
  const items: ChangeItem[] = [];
  const item = (id: string, field: string) => items.push(key === "ticket" ? { ticket: id, field }
    : { unit: id, field });
  for (const next of after) {
    const prev = before.find((x) => x.id === next.id);
    if (!prev) { item(next.id, "added"); continue; }
    const fields = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const f of [...fields].sort()) {
      if (!same((prev as Record<string, unknown>)[f], (next as Record<string, unknown>)[f])) item(next.id, f);
    }
  }
  for (const prev of before) if (!after.some((x) => x.id === prev.id)) item(prev.id, "removed");
  return items;
}

/** What changed between two sets of definitions, ticket by ticket and unit by unit, field by field. */
export function changeItems(before: Pick<Definitions, "tickets" | "units">, after: Pick<Definitions, "tickets" |
  "units">): ChangeItem[] {
  return [...fieldsChanged(before.tickets, after.tickets, "ticket"), ...fieldsChanged(before.units, after.units,
    "unit")];
}

export const isMaterial = (items: readonly ChangeItem[]) => items.some((i) => "ticket" in i &&
  (MATERIAL_FIELDS.has(i.field) || i.field === "removed" || i.field === "order")) || items.some((i) => "unit" in i);

/** The newest digests the log recorded (`tickets.changed` or `tickets.populated`), read inside a transaction. */
export function newestDigests(db: Db): Digests | null {
  const row = db.prepare("SELECT data FROM events WHERE type IN ('tickets.changed', 'tickets.populated') " +
    "ORDER BY seq DESC LIMIT 1").get() as { data: string } | undefined;
  if (!row) return null;
  const data = JSON.parse(row.data) as Partial<Digests>;
  return { digest: data.digest ?? null, delivery_digest: data.delivery_digest ?? null };
}

class AlreadyRecorded extends Error {}

/** Appends `tickets.changed` for these files' digests unless the newest record already has them (R2). */
export async function recordChange(engine: Engine, digests: Digests, items: readonly ChangeItem[],
  o: { actor: string; source: "terminal" | "flag" | null; run?: string | null }): Promise<"recorded" | "already"> {
  try {
    await engine.append([{ type: "tickets.changed", run_id: o.run ?? null, actor: o.actor, source: o.source,
      data: { by: "user", items, material: isMaterial(items), digest: digests.digest,
        delivery_digest: digests.delivery_digest } }], { inTx: (db) => {
      const newest = newestDigests(db);
      if (newest && same(newest, { digest: digests.digest, delivery_digest: digests.delivery_digest })) {
        throw new AlreadyRecorded();
      }
    } });
    return "recorded";
  } catch (error) {
    if (error instanceof AlreadyRecorded) return "already";
    throw error;
  }
}

const describe = (items: readonly ChangeItem[]) => {
  const by = new Map<string, string[]>();
  for (const i of items) {
    const id = "ticket" in i ? i.ticket : i.unit;
    by.set(id, [...(by.get(id) ?? []), i.field]);
  }
  return [...by].map(([id, fields]) => `${id} (${fields.join(", ")})`).join(", ");
};

/**
 * The safe point's re-read (C211). Null: nothing to apply (the files are as planned). An invalid file: the last good
 * definitions with the file's digests (C364). Otherwise the
 * new definitions; a ticket being worked on keeps its definition if the file dropped it, so its step can finish.
 */
export async function rereadDefinitions(engine: Engine, current: Definitions, o: { run: string;
  active: readonly string[]; line(text: string): void; warned: Set<string> }): Promise<Definitions | null> {
  if (sameDigests(await digestsNow(engine.deps.fs, engine.projectDir), current)) return null;
  const loaded = await loadTickets(engine.deps.fs, engine.projectDir);
  if (!loaded.ok) {
    if (!o.warned.has(loaded.message)) {
      o.warned.add(loaded.message);
      o.line(`${loaded.message} Rafi keeps building from the last good definitions until it's fixed.`);
    }
    // threat-1 (C364): the invalid file's digests count as seen, so a delivery step's intent (C238) doesn't send
    // the build back here forever; the definitions stay the last good ones, and fixing the file re-reads it.
    return { ...current, ...(await digestsNow(engine.deps.fs, engine.projectDir)) };
  }
  if (same({ d: loaded.digest, u: loaded.delivery_digest }, { d: current.digest, u: current.delivery_digest })) {
    return null;
  }
  const kept = current.tickets.filter((t) => o.active.includes(t.id) && !loaded.tickets.some((x) => x.id === t.id));
  const next: Definitions = { tickets: [...loaded.tickets, ...kept], units: loaded.units, digest: loaded.digest,
    delivery_digest: loaded.delivery_digest };
  const items = changeItems(current, next);
  await recordChange(engine, next, items, { actor: "engine", source: null, run: o.run });
  if (items.length) {
    o.line(`.tickets/ changed: ${describe(items)}; applied from the next step.`);
  }
  return next;
}

const ACTIVE: ReadonlySet<string> = new Set(["building", "reviewing", "fixing"]);

/** The build's context with the definitions as the files now hold them, or null when nothing changed (C211). */
export async function refreshed(ctx: BuildContext, warned: Set<string>): Promise<BuildContext | null> {
  if (!ctx.digests) return null;
  const view = ctx.engine.fold(ctx.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
  const active = Object.values(view.tickets).filter((t) => ACTIVE.has(t.state)).map((t) => t.id);
  const next = await rereadDefinitions(ctx.engine, { tickets: ctx.tickets, units: ctx.units, ...ctx.digests },
    { run: ctx.run, active, line: (text) => ctx.ui.line(text), warned });
  return next && { ...ctx, tickets: next.tickets, units: await unitsKept(ctx, view.units, next.units),
    digests: { digest: next.digest, delivery_digest: next.delivery_digest } };
}

/** C238: a unit delivering or delivered keeps what it did (said once); a unit's branch rafi already created keeps
 * its name for this build (the new name applies to the next build). */
async function unitsKept(ctx: BuildContext, states: Readonly<Record<string, string>>,
  units: readonly DeliveryUnit[]): Promise<DeliveryUnit[]> {
  const out: DeliveryUnit[] = [];
  let created: Set<string> | null = null;
  for (const u of units) {
    const was = ctx.units.find((x) => x.id === u.id);
    if (was && !same(was, u) && ["merge_waiting", "delivered"].includes(states[u.id] ?? "")) {
      ctx.ui.line(`${u.id} was already delivering when .tickets/delivery.yaml changed; it keeps what it did.`);
    }
    if (was?.branch && u.branch !== was.branch) {
      created ??= new Set<string>();
      for await (const e of ctx.engine.events()) {
        const d = (e.data ?? {}) as { unit?: string };
        if (e.type === "git.branch_created" && d.unit) created.add(d.unit);
      }
      if (created.has(u.id)) {
        ctx.ui.line(`${u.id} keeps ${was.branch}, which already exists; the new name applies to the next build.`);
        out.push({ ...u, branch: was.branch });
        continue;
      }
    }
    out.push(u);
  }
  return out;
}
