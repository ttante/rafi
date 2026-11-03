// The committed progress file, `.rafi/progress.yaml` (ARCH 3.7): a snapshot of the fold, rewritten at every safe
// point with an atomic write, sorted keys, one entry per line. Never permissions, never run history.
import path from "node:path";
import { stringify } from "yaml";
import type { Engine } from "../api/engine.js";
import type { Folded, TicketState } from "../state/types.js";

export const PROGRESS = path.join(".rafi", "progress.yaml");
const HEADER = "# Written by rafi from its database at every safe point. Commit it; don't edit it.\n";

function status(t: TicketState): string {
  if (t.state === "done") return "done";
  if (t.state === "blocked") return "blocked";
  if (t.state === "dropped") return t.dropped === "obsolete" ? "obsolete" : "canceled";
  if (t.state === "queued") return "planned";
  return "in_progress";
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]!]));
}

export async function writeProgress(engine: Engine, view: Folded): Promise<void> {
  const last: Record<string, string> = {};
  for await (const e of engine.events()) if (e.ticket_id) last[e.ticket_id] = e.at;
  const tickets: Record<string, Record<string, unknown>> = {};
  for (const t of Object.values(view.tickets)) {
    const at = last[t.id] ?? engine.deps.clock.now().toISOString();
    const entry: Record<string, unknown> = { status: status(t), at };
    if (t.block) entry.reason = t.block.reason;
    if (entry.status === "in_progress") Object.assign(entry, { step: t.node ?? "", fixes: t.fixesUsed });
    tickets[t.id] = entry;
  }
  const questions: Record<string, unknown> = {};
  for (const q of Object.values(view.questions)) {
    if (q.status === "open") questions[String(q.no)] = { at: q.openedAt ?? "", kind: q.kind, tickets: q.tickets,
      text: q.text, options: [] };
  }
  const body = stringify({ version: 1, tickets: sorted(tickets), questions: sorted(questions), answers: {} },
    { sortMapEntries: true });
  engine.deps.hooks.crash("5: during the progress-file write");
  await engine.deps.fs.writeAtomic(path.join(engine.projectDir, PROGRESS), HEADER + body);
}
