// `rafi tickets archive --older-than-days <n>` (FLAG-TK-22, FILE-28): done tickets finished more than n days ago (on
// `deps.clock`) move to the archive doc (`paths.archive_doc`, else `<docs>/ticket-archive.md`), and the progress doc
// stops listing them. Both are rafi's views; the archive doc's own rows say what's archived.
import path from "node:path";
import type { Engine } from "../api/engine.js";
import { ENGINE_VERSION_LINE } from "../version.js";
import { eventsOf } from "./inbox.js";
import { loadTickets } from "./load.js";
import { archiveDocPath, archivedIds, writeProgressDoc } from "./render.js";
import type { TicketWrite } from "./status.js";
import { writeView } from "./views.js";

const DAY_MS = 86_400_000;

export async function archiveDone(engine: Engine, days: number, docsRoot: string): Promise<TicketWrite> {
  if (!Number.isFinite(days) || days < 0) return { ok: false, message: "--older-than-days takes a number of days." };
  const loaded = await loadTickets(engine.deps.fs, engine.projectDir);
  if (!loaded.ok) return loaded;
  const view = engine.fold(loaded.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
  const finished = await eventsOf(engine, ["delivery.done", "ticket.status_set"]);
  const cutoff = engine.deps.clock.now().getTime() - days * DAY_MS;
  const before = await archivedIds(engine, docsRoot);
  const rows = loaded.tickets.filter((t) => view.tickets[t.id]?.state === "done" && !before.has(t.id)).flatMap((t) => {
    const at = finished.filter((e) => e.ticket_id === t.id && (e.type === "delivery.done" ||
      (e.data as { status?: string }).status === "done")).at(-1)?.at;
    return at && Date.parse(at) < cutoff ? [`| ${t.id} | ${t.title.replace(/\|/g, "\\|")} | ${at} |`] : [];
  });
  if (!rows.length) return { ok: true, line: `No done ticket is older than ${days} day(s).` };
  const file = await archiveDocPath(engine, docsRoot);
  const old = (await engine.deps.fs.stat(file)) ? (await engine.deps.fs.read(file)).trimEnd() : ["# Ticket Archive",
    "", `> ${ENGINE_VERSION_LINE}. Done tickets that \`rafi tickets archive\` moved out of the progress doc.`, "",
    "| Ticket | Title | Done at |", "|---|---|---|"].join("\n");
  await writeView(engine, file, engine.redact(`${old}\n${rows.join("\n")}\n`), true);
  await writeProgressDoc(engine, view, { docsRoot });
  return { ok: true, line: `Archived ${rows.length} done ticket(s) to ${path.relative(engine.projectDir, file)}.` };
}
