// `rafi tickets show` (ARCH 3.6: readers never write): each ticket with its state from the fold, its tracker
// status, its depth and its validation runs.
import type { Engine } from "../api/engine.js";
import { runsOf } from "../facts/runs.js";
import { loadTickets } from "./load.js";

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
    const written = all.filter((e) => e.ticket_id === t.id && e.type === "requirements.written").at(-1)?.data as
      { depth: string } | undefined;
    const waiver = all.filter((e) => e.ticket_id === t.id && e.type === "waiver.recorded").at(-1)?.data as
      { kind: string; note: string; findings: string[] } | undefined;
    return { ...t, status: TRACKER[state?.state ?? "queued"], state: state?.state ?? "queued",
      step: state?.node ?? null, block: state?.block ?? null, fixes: state?.fixesUsed ?? 0,
      depth: written?.depth ?? null,
      validation: done ? { result: done.validation.result, unverified: done.validation.unverified,
        waiver: done.validation.result === "passed" || !waiver ? null
          : { kind: waiver.kind, note: waiver.note, findings: waiver.findings },
        runs: done.validation.runs.map((n) => { const r = runs.find((x) => x.run === n);
          return { run: n, command: r?.command ?? null, outcome: r?.outcome ?? null }; }) } : null };
  });
  return { ok: true, tickets };
}
