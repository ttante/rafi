// Read-only views of the fold (ARCH 3.6: readers never write): `rafi tickets show`, `rafi stats export`.
import type { Engine } from "./engine.js";
import { migrations } from "../log/migrations/index.js";
import { runsOf } from "../facts/runs.js";
import { loadTickets } from "../tickets/load.js";

const TRACKER: Readonly<Record<string, string>> = Object.freeze({ queued: "planned", building: "in_progress",
  reviewing: "in_progress", fixing: "in_progress", blocked: "blocked", done: "done", dropped: "canceled" });

async function events(engine: Engine) {
  const out = [];
  for await (const e of engine.events()) out.push(e);
  return out;
}

export async function ticketsView(engine: Engine): Promise<{ ok: true; tickets: Record<string, unknown>[] } |
  { ok: false; message: string }> {
  const loaded = await loadTickets(engine.deps.fs, engine.projectDir);
  if (!loaded.ok) return loaded;
  const view = engine.fold(loaded.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
  const all = await events(engine);
  const tickets = loaded.tickets.map((t) => {
    const state = view.tickets[t.id];
    const done = all.filter((e) => e.ticket_id === t.id && e.type === "delivery.done").at(-1)?.data as
      { validation: { result: string; runs: number[]; unverified: number[] } } | undefined;
    const runs = runsOf(all, t.id);
    return { ...t, status: TRACKER[state?.state ?? "queued"], state: state?.state ?? "queued",
      step: state?.node ?? null, block: state?.block ?? null, fixes: state?.fixesUsed ?? 0,
      validation: done ? { result: done.validation.result, unverified: done.validation.unverified,
        runs: done.validation.runs.map((n) => { const r = runs.find((x) => x.run === n);
          return { run: n, command: r?.command ?? null, outcome: r?.outcome ?? null }; }) } : null };
  });
  return { ok: true, tickets };
}

/** ARCH 3.5: `{ format: "rafi-events", schema, events }`, stable JSON (same input, same output). */
export async function eventsExport(engine: Engine, o: { run?: string } = {}): Promise<string> {
  const list = (await events(engine)).filter((e) => !o.run || e.run_id === o.run);
  return `${JSON.stringify({ format: "rafi-events", schema: migrations.length, events: list.map((e) => ({
    seq: e.seq, id: e.id, run_id: e.run_id, ticket_id: e.ticket_id, type: e.type, v: e.v, class: e.class, at: e.at,
    actor: e.actor, source: e.source, origin: e.origin, data: e.data })) }, null, 2)}\n`;
}
