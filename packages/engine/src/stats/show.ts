// `rafi stats show` (M2's first version; ARCH 3.6, 5.3 NEW-SO-4): a run's turns by role and runtime, retries by
// reason, the malformed-reply count by runtime and role, and the failed replies kept with their errors.
import type { Engine } from "../api/engine.js";

type Data = Record<string, unknown>;

export interface RunStats {
  readonly run: string;
  readonly state: string;
  readonly done: string[];
  readonly turns: Record<string, number>;
  readonly retries: Record<string, number>;
  readonly malformed: Record<string, number>;
  readonly failed: { ticket: string | null; key: string; outcome: string; errors: string[]; raw: string | null }[];
  /** NEW-REQ-6: one delivery receipt per QA review turn. */
  readonly receipts: { key: string; at: string; path: string; supplied: string | null; observed: string | null;
    status: string; read: boolean }[];
}

export async function runStats(engine: Engine, o: { run?: string; ticket?: string } = {}): Promise<RunStats | null> {
  const all = [];
  for await (const e of engine.events()) all.push(e);
  const run = o.run ? all.find((e) => e.type === "build.started" && e.run_id?.startsWith(o.run!))?.run_id
    : all.filter((e) => e.type === "build.started").at(-1)?.run_id;
  if (!run) return null;
  const mine = all.filter((e) => e.run_id === run && (!o.ticket || e.ticket_id === o.ticket));
  const intents = new Map<string, Data>();
  const stats: RunStats = { run, state: engine.fold().builds[run]?.state ?? "unknown",
    done: mine.filter((e) => e.type === "delivery.done").map((e) => e.ticket_id!), turns: {}, retries: {},
    malformed: {}, failed: [], receipts: [] };
  for (const e of mine) {
    const d = e.data as Data;
    if (e.type === "turn.intent") {
      intents.set(String(d.key), d);
      const label = `${String(d.role)} (${String(d.runtime)})`;
      stats.turns[label] = (stats.turns[label] ?? 0) + 1;
    } else if (e.type === "turn.retry") {
      stats.retries[String(d.category)] = (stats.retries[String(d.category)] ?? 0) + 1;
    } else if (e.type === "turn.reply" && d.outcome !== "ok") {
      const intent = intents.get(String(d.key)) ?? {};
      if (d.outcome === "format") {
        const label = `${String(intent.role)} on ${String(intent.runtime)}`;
        stats.malformed[label] = (stats.malformed[label] ?? 0) + 1;
      }
      stats.failed.push({ ticket: e.ticket_id, key: String(d.key), outcome: String(d.outcome),
        errors: d.errors as string[], raw: (d.raw as string | null) ?? null });
    } else if (e.type === "requirements.receipt") {
      stats.receipts.push({ key: String(d.key), at: e.at, path: String(d.path), supplied: d.fp_supplied as string,
        observed: (d.fp_observed as string | null) ?? null, status: String(d.status), read: Boolean(d.read) });
    } else if (e.type === "turn.repair" && !d.accepted) {
      const last = stats.failed.at(-1);
      if (last) last.errors.push(`the repair was rejected: ${String(d.why)}`);
    }
  }
  return stats;
}

const list = (r: Record<string, number>) => Object.entries(r).map(([k, n]) => `${k}: ${n}`).join(", ") || "none";

export function renderStats(s: RunStats): string {
  const lines = [`Run ${s.run}: ${s.state}; done: ${s.done.join(", ") || "none"}`, `Turns: ${list(s.turns)}`,
    `Retries: ${list(s.retries)}`, `Malformed replies: ${list(s.malformed)}`];
  if (s.failed.length) {
    lines.push("Failed replies kept:");
    for (const f of s.failed) {
      const [ticket, step, attempt] = f.key.split(":");
      lines.push(`- ${ticket ?? f.ticket} ${step} attempt ${attempt}: ${f.outcome} — ${f.errors.join("; ")}` +
        `${f.raw ? ` (raw ${f.raw})` : ""}`);
    }
  }
  if (s.receipts.length) {
    lines.push("Requirements file receipts:");
    for (const r of s.receipts) {
      const [ticket, step, attempt] = r.key.split(":");
      lines.push(`- receipt ${ticket} ${step} attempt ${attempt} at ${r.at}: ${r.path}, ` +
        `supplied ${r.supplied ?? "none"}, observed ${r.observed ?? "none"}, ${r.status}, ` +
        `read: ${r.read ? "yes" : "no"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
