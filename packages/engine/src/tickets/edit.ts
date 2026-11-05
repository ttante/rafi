// The definitions writer (ARCH 4.6 item 3, 7.10; M5 plan C210, P41): rafi's own edits of `.tickets/tickets.yaml`
// (`reorder`, `accept-future-work`, `repair --risk-notes`, `reset --deleted-tickets restore`) keep comments and every
// other field (the yaml Document API), validate the whole file before writing, rename it atomically, and record one
// `tickets.changed {by: user}` naming what changed, with both files' digests. One rafi writer at a time holds the
// file's lock (config/lock.ts); the record is skipped when a build's safe point already recorded that exact content
// (R2, tickets/changes.ts). Reordering is a plan update (FLAG-TK-17).
import path from "node:path";
import { checkTicketsFile } from "rafi-spec/v1";
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import type { Engine } from "../api/engine.js";
import { withFileLock } from "../log/lock.js";
import { boundary } from "../deps/hooks.js";
import { InvalidEventError } from "../log/append.js";
import type { NewEvent } from "../log/types.js";
import { recordChange, type ChangeItem } from "./changes.js";
import { DELIVERY, fileDigest, TICKETS } from "./load.js";
import type { TicketWrite } from "./status.js";
import { ACTORS } from "./status.js";

export { fileDigest };

/** An edit's result: the line to print, what changed, and events that go with it (written after the record). */
export type DocEdit = { ok: true; line: string; items: ChangeItem[]; extra?: readonly NewEvent[] }
  | { ok: false; message: string };
type Who = { actor: string; source: "terminal" | "flag" };

/** The tickets as yaml maps, in the file's order. */
export const ticketMaps = (doc: Document): YAMLMap[] => {
  const list = doc.get("tickets");
  return isSeq(list) ? (list.items.filter(isMap) as YAMLMap[]) : [];
};

async function writeOnce(engine: Engine, edit: (doc: Document) => DocEdit, o: Who): Promise<TicketWrite> {
  const { fs } = engine.deps;
  const file = path.join(engine.projectDir, TICKETS);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = await fs.read(file);
    const doc = parseDocument(before);
    if (doc.errors.length || !isSeq(doc.get("tickets"))) return { ok: false, message: `${TICKETS} isn't a valid ` +
      "tickets file." };
    const r = edit(doc);
    if (!r.ok) return r;
    const text = doc.toString();
    const checked = checkTicketsFile(doc.toJS());
    if (!checked.ok) return { ok: false, message: checked.message };
    if ((await fs.read(file)) !== before) continue;
    const delivery = path.join(engine.projectDir, DELIVERY);
    const deliveryDigest = (await fs.stat(delivery)) ? fileDigest(await fs.read(delivery)) : null;
    await fs.writeAtomic(file, text);
    await boundary(engine.deps.hooks, "7: after the tickets.yaml rename, before its record");
    try {
      const recorded = await recordChange(engine, { digest: fileDigest(text), delivery_digest: deliveryDigest },
        r.items, o);
      if (r.extra?.length) await engine.append(r.extra);
      return { ok: true, line: recorded === "already" ? `${r.line} (the running build had already recorded it.)`
        : r.line };
    } catch (error) {
      if (!(error instanceof InvalidEventError)) throw error;
      await fs.writeAtomic(file, before);
      return { ok: false, message: error.message.split("\n")[0]!.replace(/^invalid transition: /, "") };
    }
  }
  return { ok: false, message: `${TICKETS} kept changing while rafi edited it; try again.` };
}

/** Applies one edit to tickets.yaml under its lock, and records it once (C210). */
export async function writeDefinitions(engine: Engine, edit: (doc: Document) => DocEdit, o: Who):
  Promise<TicketWrite> {
  if (!ACTORS.includes(o.actor)) return { ok: false, message: `--actor takes ${ACTORS.join(", ")}.` };
  const locked = await withFileLock(engine.deps, engine.projectDir, "tickets.yaml", () => writeOnce(engine, edit, o));
  return locked.ok ? locked.value : locked;
}

/** Puts `moving` at index `at` among the others (sorted by order) and renumbers `order` 1..N; the changed ids. */
export function placeAt(doc: Document, moving: YAMLMap, at: number): string[] {
  const list = doc.get("tickets");
  const items = ticketMaps(doc);
  const rest = [...items].sort((a, b) => Number(a.get("order") ?? 0) - Number(b.get("order") ?? 0))
    .filter((t) => t !== moving);
  rest.splice(at, 0, moving);
  const changed = rest.filter((t, n) => Number(t.get("order")) !== n + 1).map((t) => String(t.get("id")));
  rest.forEach((t, n) => t.set("order", n + 1));
  if (isSeq(list) && items.length === list.items.length) list.items.splice(0, list.items.length, ...rest);
  return changed;
}

/** `rafi tickets reorder <id> --order <n> | --after <id>`: moves the ticket and renumbers `order` 1..N. */
export async function reorderTicket(engine: Engine, id: string, to: { order?: number; after?: string }, o: Who):
  Promise<TicketWrite> {
  if ((to.order === undefined) === (to.after === undefined)) {
    return { ok: false, message: "rafi tickets reorder takes one of --order <n> or --after <ticket>." };
  }
  return writeDefinitions(engine, (doc) => {
    const items = ticketMaps(doc);
    const byOrder = [...items].sort((a, b) => Number(a.get("order") ?? 0) - Number(b.get("order") ?? 0));
    const moving = byOrder.find((t) => t.get("id") === id);
    if (!moving) return { ok: false, message: `There's no ticket ${id}.` };
    const rest = byOrder.filter((t) => t !== moving);
    const at = to.after !== undefined ? rest.findIndex((t) => t.get("id") === to.after) + 1 : (to.order ?? 1) - 1;
    if (to.after !== undefined && at === 0) return { ok: false, message: `There's no ticket ${to.after}.` };
    if (!Number.isInteger(at) || at < 0 || at > rest.length) {
      return { ok: false, message: `--order takes a position from 1 to ${items.length}.` };
    }
    const changed = placeAt(doc, moving, at);
    return { ok: true, line: `${id} is now number ${at + 1} in the queue.`,
      items: changed.map((ticket) => ({ ticket, field: "order" })) };
  }, o);
}
