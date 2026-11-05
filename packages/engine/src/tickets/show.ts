// `rafi tickets show` (ARCH 3.6: readers never write): each ticket with its state from the fold, its tracker
// status, its depth and its validation runs. Rafi-owned tickets (C212) come first, from the fold, with `owned`.
import type { Engine } from "../api/engine.js";
import { runsOf } from "../facts/runs.js";
import { loadTickets } from "./load.js";
import { ownedTicket } from "./owned.js";
import { declaredValues } from "../agents/env.js";
import { loadConfig } from "../config/load.js";

/** P40: a reader registers the project's declared values too, so a ticket's text never shows one (C362). */
async function declare(engine: Engine): Promise<void> {
  const loaded = await loadConfig(engine.deps.fs, engine.projectDir);
  if (!loaded.ok) return;
  const c = loaded.config as { checks?: { env?: string[] }; agents?: { env?: string[] } };
  const names = [...(c.checks?.env ?? []), ...(c.agents?.env ?? [])];
  for (const [name, value] of declaredValues(engine.deps.env, names, engine.deps.machine.platform)) {
    engine.secret(value, name);
  }
}

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
  await declare(engine);
  const view = engine.fold(loaded.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
  const all = await events(engine);
  const owned = Object.values(view.tickets).filter((t) => t.rafiOwned && t.owned &&
    !loaded.tickets.some((d) => d.id === t.id)).flatMap((t) => {
    const def = ownedTicket(t);
    return def ? [{ def, owned: { source: t.owned!.source, requirements: [...t.owned!.requirements],
      hint: t.owned!.hint, unit: t.owned!.unit } }] : [];
  });
  const listed = [...owned, ...loaded.tickets.map((def) => ({ def, owned: undefined }))];
  const tickets = listed.map(({ def: t, owned: own }) => {
    const state = view.tickets[t.id];
    const done = all.filter((e) => e.ticket_id === t.id && e.type === "delivery.done").at(-1)?.data as
      { validation: { result: string; runs: number[]; unverified: number[] } } | undefined;
    const runs = runsOf(all, t.id);
    const written = all.filter((e) => e.ticket_id === t.id && e.type === "requirements.written").at(-1)?.data as
      { depth: string } | undefined;
    const waiver = all.filter((e) => e.ticket_id === t.id && e.type === "waiver.recorded").at(-1)?.data as
      { kind: string; note: string; findings: string[] } | undefined;
    const unit = loaded.units.find((u) => u.tickets.includes(t.id));
    return { ...t, ...(own ? { owned: own } : {}), status: TRACKER[state?.state ?? "queued"],
      state: state?.state ?? "queued",
      // OUT-4: blockers recalculated from the fold, the ticket's events, and its delivery context.
      waits: t.depends_on.filter((d) => view.tickets[d]?.state !== "done"),
      events: all.filter((e) => e.ticket_id === t.id).map((e) => ({ seq: e.seq, at: e.at, type: e.type,
        actor: e.actor })),
      delivery: unit ? { unit: unit.id, branch_mode: unit.branch_mode ?? null, completion: unit.completion ?? null,
        branch: unit.branch ?? null } : null,
      step: state?.node ?? null, block: state?.block ?? null, fixes: state?.fixesUsed ?? 0,
      depth: written?.depth ?? null,
      validation: done ? { result: done.validation.result, unverified: done.validation.unverified,
        waiver: done.validation.result === "passed" || !waiver ? null
          : { kind: waiver.kind, note: waiver.note, findings: waiver.findings },
        runs: done.validation.runs.map((n) => { const r = runs.find((x) => x.run === n);
          return { run: n, command: r?.command ?? null, outcome: r?.outcome ?? null }; }) } : null };
  });
  return { ok: true, tickets: JSON.parse(engine.redact(JSON.stringify(tickets))) as Record<string, unknown>[] };
}
