// The committed progress file, `.rafi/progress.yaml` (ARCH 3.7): a snapshot of the fold, rewritten at every safe
// point with an atomic write, sorted keys, one entry per line. Never permissions, never run history.
import path from "node:path";
import { stringify } from "yaml";
import type { Engine } from "../api/engine.js";
import { boundary } from "../deps/hooks.js";
import type { Folded, TicketState } from "../state/types.js";
import { writeProgressDoc } from "../tickets/render.js";

export const PROGRESS = path.join(".rafi", "progress.yaml");
export const UNTOUCHED = new Date(0).toISOString();
export const HEADER = "# Written by rafi from its database at every safe point. Commit it; don't edit it.\n";

export function status(t: TicketState): string {
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
  const keys: Record<string, { key: string | null; options: string[] }> = {};
  const answers: Record<string, unknown> = {};
  for await (const e of engine.events()) {
    if (e.ticket_id) last[e.ticket_id] = e.at;
    const d = e.data as { id: string; key?: string | null; choice?: string | null;
      options?: { label: string }[] };
    if (e.type === "question.opened") {
      keys[d.id] = { key: d.key ?? null, options: (d.options ?? []).map((o) => o.label) };
    }
    // C121: saved answers by key, with when, the choice and where; a note stays out of the committed file.
    const key = keys[d.id]?.key;
    if (e.type === "question.answered" && key) {
      answers[key] = { at: e.at, choice: d.choice ?? null, source: e.source ?? "unknown" };
    }
  }
  const tickets: Record<string, Record<string, unknown>> = {};
  for (const t of Object.values(view.tickets)) {
    // C300: a ticket this database never changed says so with the epoch, so a clone's merge (newer `at` wins, C225)
    // never prefers "planned here" over a real change made on the other computer.
    const at = last[t.id] ?? UNTOUCHED;
    const entry: Record<string, unknown> = { status: status(t), at };
    if (t.block) entry.reason = t.block.reason;
    if (entry.status === "in_progress") Object.assign(entry, { step: t.node ?? "", fixes: t.fixesUsed });
    // P49: a rafi-owned ticket isn't in tickets.yaml, so its entry carries what its ticket.added recorded.
    if (t.rafiOwned && t.owned) entry.owned = { source: t.owned.source, requirements: [...t.owned.requirements],
      hint: t.owned.hint, unit: t.owned.unit };
    tickets[t.id] = entry;
  }
  const questions: Record<string, unknown> = {};
  for (const q of Object.values(view.questions)) {
    if (q.status === "open") questions[String(q.no)] = { at: q.openedAt ?? "", kind: q.kind, tickets: q.tickets,
      text: q.text, options: keys[q.id]?.options ?? [] };
  }
  const body = stringify({ version: 1, tickets: sorted(tickets), questions: sorted(questions),
    answers: sorted(answers) }, { sortMapEntries: true });
  await boundary(engine.deps.hooks, "5: during the progress-file write");
  await engine.deps.fs.writeAtomic(path.join(engine.projectDir, PROGRESS), HEADER + body);
  const docs = view.run ? view.builds[view.run]?.settings["docs.root"]?.value : undefined;
  await writeProgressDoc(engine, view, { docsRoot: typeof docs === "string" ? docs : "docs" });
}
