// The inbox (FLAG-TK-15, -16, -18; M5 plan item 7): `rafi tickets discover` adds future work, `accept-future-work`
// makes one a ticket at a queue position (through the definitions writer, with a creation group), and `review`
// accepts, dismisses or defers split, combine and duplicate recommendations; accepting one applies its ticket change
// through the definitions writer. Everything is an event (ARCH 3.4 :277), read back from the log.
import type { Document } from "yaml";
import type { Engine } from "../api/engine.js";
import type { NewEvent, StoredEvent } from "../log/types.js";
import type { ChangeItem } from "./changes.js";
import { placeAt, ticketMaps, writeDefinitions } from "./edit.js";
import { groupEvent } from "./groups.js";
import { ACTORS, type TicketWrite } from "./status.js";

type Who = { actor: string; source: "terminal" | "flag" };

export async function eventsOf(engine: Engine, types: readonly string[]): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  for await (const e of engine.events()) if (types.includes(e.type)) out.push(e);
  return out;
}

export interface FutureWork {
  readonly id: string;
  readonly title: string;
  readonly from: string | null;
  readonly priority: string | null;
  readonly area: string | null;
  readonly rationale: string | null;
  readonly accepted: string | null;
}

/** Every future-work item, with the ticket it became (if any). */
export async function futureWork(engine: Engine): Promise<FutureWork[]> {
  const events = await eventsOf(engine, ["future_work.added", "future_work.accepted"]);
  return events.filter((e) => e.type === "future_work.added").map((e) => {
    const d = e.data as Omit<FutureWork, "accepted">;
    const done = events.find((x) => x.type === "future_work.accepted" && (x.data as { id: string }).id === d.id);
    return { ...d, accepted: done ? (done.data as { ticket: string }).ticket : null };
  });
}

export interface Discovery {
  readonly summary?: string;
  readonly sourceTicket?: string;
  readonly proposedTicket?: string;
  readonly priority?: string;
  readonly area?: string;
  readonly rationale?: string;
  readonly needsDecisionFrom?: string;
}

/** `rafi tickets discover`: one `future_work.added` (FW-<n>). */
export async function discover(engine: Engine, d: Discovery, o: Who): Promise<TicketWrite> {
  if (!ACTORS.includes(o.actor)) return { ok: false, message: `--actor takes ${ACTORS.join(", ")}.` };
  if (!d.summary?.trim()) return { ok: false, message: "rafi tickets discover needs --summary." };
  if (d.priority && !["P0", "P1", "P2", "P3"].includes(d.priority)) {
    return { ok: false, message: "--priority-guess takes P0, P1, P2 or P3." };
  }
  const id = `FW-${(await futureWork(engine)).length + 1}`;
  await engine.append([{ type: "future_work.added", actor: o.actor, source: o.source, data: { id,
    title: d.summary.trim(), from: d.sourceTicket ?? null, proposed_ticket: d.proposedTicket ?? null,
    priority: d.priority ?? null, area: d.area ?? null, rationale: d.rationale ?? null,
    needs_decision_from: d.needsDecisionFrom ?? null } }]);
  return { ok: true, line: `${id} is in the inbox: ${d.summary.trim()}` };
}

/** `rafi tickets accept-future-work <id> --ticket-id <new> --order <n>`. */
export async function acceptFutureWork(engine: Engine, id: string, to: { ticketId?: string; order?: number },
  o: Who): Promise<TicketWrite> {
  if (!to.ticketId || to.order === undefined) {
    return { ok: false, message: "rafi tickets accept-future-work needs --ticket-id and --order." };
  }
  const item = (await futureWork(engine)).find((f) => f.id === id);
  if (!item) return { ok: false, message: `There's no future work ${id}.` };
  if (item.accepted) return { ok: false, message: `${id} is already ticket ${item.accepted}.` };
  const ticket = { id: to.ticketId, title: item.title, area: item.area ?? "General", summary: item.title,
    priority: item.priority ?? "P2", size: "M", risk: "Low", depends_on: [], tags: [],
    acceptance: ["TODO: fill in the acceptance criteria."], required_tests: [], likely_files: [], rollback: null,
    notes: item.rationale };
  const extra: NewEvent[] = [{ type: "future_work.accepted", actor: o.actor, source: o.source,
    data: { id, ticket: to.ticketId } }, await groupEvent(engine, [ticket], "future-work", o)];
  return writeDefinitions(engine, (doc) => {
    const maps = ticketMaps(doc);
    if (maps.some((t) => t.get("id") === to.ticketId)) return { ok: false, message: `${to.ticketId} already exists.` };
    if (!Number.isInteger(to.order) || to.order! < 1 || to.order! > maps.length + 1) {
      return { ok: false, message: `--order takes a position from 1 to ${maps.length + 1}.` };
    }
    const node = doc.createNode({ ...ticket, order: maps.length + 1 });
    (doc.get("tickets") as { items: unknown[] }).items.push(node);
    const moved = placeAt(doc, node as never, to.order! - 1).filter((t) => t !== to.ticketId);
    return { ok: true, line: `${id} is now ticket ${to.ticketId}, number ${to.order} in the queue.`, extra,
      items: [{ ticket: to.ticketId!, field: "added" }, ...moved.map((t) => ({ ticket: t, field: "order" }))] };
  }, o);
}

export interface Recommendation {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly ticket: string | null;
  readonly patch: { add: Record<string, unknown>[]; update: { id: string; set: Record<string, unknown> }[];
    remove: string[] };
  readonly status: "open" | "accepted" | "dismissed" | "deferred";
}

export async function recommendations(engine: Engine): Promise<Recommendation[]> {
  const events = await eventsOf(engine, ["recommendation.recorded", "recommendation.resolved"]);
  return events.filter((e) => e.type === "recommendation.recorded").map((e) => {
    const d = e.data as Omit<Recommendation, "status">;
    const last = events.filter((x) => x.type === "recommendation.resolved" && (x.data as { id: string }).id === d.id)
      .at(-1)?.data as { resolution: Recommendation["status"] } | undefined;
    return { ...d, status: last?.resolution ?? "open" };
  });
}

function applyPatch(doc: Document, recs: readonly Recommendation[]): ChangeItem[] | string {
  const items: ChangeItem[] = [];
  const list = doc.get("tickets") as { items: unknown[] };
  for (const r of recs) {
    for (const id of r.patch.remove) {
      const at = ticketMaps(doc).findIndex((t) => t.get("id") === id);
      if (at < 0) return `${r.id} removes ${id}, which isn't a ticket.`;
      list.items.splice(list.items.indexOf(ticketMaps(doc)[at]), 1);
      items.push({ ticket: id, field: "removed" });
    }
    for (const u of r.patch.update) {
      const t = ticketMaps(doc).find((x) => x.get("id") === u.id);
      if (!t) return `${r.id} changes ${u.id}, which isn't a ticket.`;
      for (const [field, value] of Object.entries(u.set)) {
        if (field === "id") continue;
        t.set(field, doc.createNode(value));
        items.push({ ticket: u.id, field });
      }
    }
    for (const add of r.patch.add) {
      if (ticketMaps(doc).some((x) => x.get("id") === add.id)) return `${r.id} adds ${String(add.id)}, which exists.`;
      list.items.push(doc.createNode(add));
      items.push({ ticket: String(add.id), field: "added" });
    }
  }
  return items;
}

/** `rafi tickets review`: with no action, the open recommendations; else accept, dismiss or defer `ids`. */
export async function review(engine: Engine, action: "accept" | "dismiss" | "defer", ids: readonly string[] | "all",
  o: Who): Promise<TicketWrite> {
  const open = (await recommendations(engine)).filter((r) => r.status === "open");
  const chosen = ids === "all" ? open : ids.map((id) => open.find((r) => r.id === id));
  const missing = ids === "all" ? -1 : chosen.findIndex((r) => !r);
  if (missing >= 0) return { ok: false, message: `There's no open recommendation ${String(ids[missing])}.` };
  if (!chosen.length) return { ok: true, line: "No open recommendations." };
  const recs = chosen as Recommendation[];
  const resolved: NewEvent[] = recs.map((r) => ({ type: "recommendation.resolved", actor: o.actor, source: o.source,
    data: { id: r.id, resolution: action === "accept" ? "accepted" : action === "dismiss" ? "dismissed"
      : "deferred" } }));
  const line = `${recs.map((r) => r.id).join(", ")}: ${resolved.map((e) => (e.data as { resolution: string })
    .resolution)[0]}.`;
  if (action !== "accept") {
    if (!ACTORS.includes(o.actor)) return { ok: false, message: `--actor takes ${ACTORS.join(", ")}.` };
    await engine.append(resolved);
    return { ok: true, line };
  }
  return writeDefinitions(engine, (doc) => {
    const items = applyPatch(doc, recs);
    return typeof items === "string" ? { ok: false, message: items } : { ok: true, line, items, extra: resolved };
  }, o);
}
