// `rafi stats export` (ARCH 3.5, 3.6: readers never write): every event as stable JSON.
import type { Engine } from "../api/engine.js";
import { migrations } from "../log/migrations/index.js";

async function events(engine: Engine) {
  const out = [];
  for await (const e of engine.events()) out.push(e);
  return out;
}

/** ARCH 3.5: `{ format: "rafi-events", schema, events }`, stable JSON (same input, same output). */
export async function eventsExport(engine: Engine, o: { run?: string } = {}): Promise<string> {
  const list = (await events(engine)).filter((e) => !o.run || e.run_id === o.run);
  return `${JSON.stringify({ format: "rafi-events", schema: migrations.length, events: list.map((e) => ({
    seq: e.seq, id: e.id, run_id: e.run_id, ticket_id: e.ticket_id, type: e.type, v: e.v, class: e.class, at: e.at,
    actor: e.actor, source: e.source, origin: e.origin, data: e.data })) }, null, 2)}\n`;
}
