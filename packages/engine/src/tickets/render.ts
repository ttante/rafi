// `docs/ticket-progress.md` (ARCH 3.8, 12.5; Q-FMT-2; M5 plan C207): a view for people, rewritten from the fold
// after ticket changes and by `rafi tickets render`, never read back as state. Today's layout with the queue under
// `Next up` (not `LLM_NEXT_QUEUE`), a version line, and only 1.0 command names. As today, it's the tracker's: rafi
// writes it once `.tickets/config.yaml` exists (FMT-K1, `paths.progress_doc`), or when the file is already there.
import path from "node:path";
import type { TicketV1 } from "rafi-spec/v1";
import { parse } from "yaml";
import type { Engine } from "../api/engine.js";
import { ENGINE_VERSION_LINE } from "../version.js";
import type { Folded } from "../state/types.js";
import { futureWork } from "./inbox.js";
import { loadTickets } from "./load.js";
import { writeView } from "./views.js";

export const TRACKER_CONFIG = path.join(".tickets", "config.yaml");

const TRACKER: Readonly<Record<string, string>> = Object.freeze({ queued: "planned", building: "in_progress",
  reviewing: "in_progress", fixing: "in_progress", blocked: "blocked", done: "done", dropped: "canceled" });

const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
function table(headers: readonly string[], rows: readonly string[][], empty: string): string {
  if (!rows.length) return `_${empty}_`;
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

export interface RenderInput {
  readonly tickets: readonly TicketV1[];
  readonly view: Folded;
  readonly app: string;
  readonly now: string;
  readonly limit?: number;
  /** Open future work (`rafi tickets discover`), listed under `Future work`. */
  readonly inbox?: readonly { id: string; title: string; from: string | null }[];
  /** Tickets `rafi tickets archive` moved to the archive doc; they're left out here. */
  readonly archived?: ReadonlySet<string>;
}

/** The doc's text (pure). Every ticket in queue order under `Next up` with its status, dependencies and blockers. */
export function renderProgressDoc(i: RenderInput): string {
  const status = (id: string) => TRACKER[i.view.tickets[id]?.state ?? "queued"] ?? "planned";
  const order = i.view.queue.map((d) => d.id);
  const defs = [...i.tickets].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    .filter((t) => !i.archived?.has(t.id));
  const open = defs.filter((t) => !["done", "canceled"].includes(status(t.id)));
  const waiting = (t: TicketV1) => t.depends_on.filter((d) => status(d) !== "done");
  const rows = open.slice(0, i.limit ?? 500).map((t, n) => [String(n + 1), t.id, t.title, status(t.id),
    t.depends_on.join(", ") || "None", waiting(t).join(", ") || "None", t.size ?? "", t.risk,
    t.required_tests.join("; ")]);
  const all = defs.map((t) => [t.id, t.title, status(t.id), i.view.tickets[t.id]?.node ?? "",
    i.view.tickets[t.id]?.block?.reason ?? ""]);
  const blocked = defs.filter((t) => status(t.id) === "blocked").map((t) => [t.id,
    i.view.tickets[t.id]?.block?.kind ?? "", i.view.tickets[t.id]?.block?.reason ?? ""]);
  return [
    "# Ticket Progress", "",
    `> ${ENGINE_VERSION_LINE}. Generated from rafi's records; don't edit it. Change tickets with \`rafi tickets\`.`,
    "", "## Tracker Metadata", "",
    table(["Field", "Value"], [["App", i.app], ["Generated At", i.now], ["Remaining Tickets", String(open.length)]],
      ""),
    "", "## Next up", "",
    table(["Rank", "Ticket", "Title", "Status", "Depends On", "Blocked By", "Size", "Risk", "Required Tests"], rows,
      "No remaining tickets. All work is complete or no tickets have been defined."),
    "", "## Ticket Status", "",
    table(["Ticket", "Title", "Status", "Step", "Note"], all, "No tickets."),
    "", "## Blocked Tickets", "",
    table(["Ticket", "Kind", "Reason"], blocked, "No blocked tickets."),
    "", "## Future work", "",
    table(["Item", "Summary", "Found in"], (i.inbox ?? []).map((f) => [f.id, f.title, f.from ?? ""]),
      "No open future work."), "",
  ].join("\n");
}

/** Where the doc goes: the tracker config's `paths.progress_doc`, else `<docs.root>/ticket-progress.md`; null when
 * there's no tracker and no doc yet. */
export async function progressDocPath(engine: Engine, docsRoot: string): Promise<{ file: string; app: string }
  | null> {
  const { fs } = engine.deps;
  const config = path.join(engine.projectDir, TRACKER_CONFIG);
  const fallback = path.join(engine.projectDir, docsRoot, "ticket-progress.md");
  if ((await fs.stat(config))?.kind !== "file") return (await fs.stat(fallback)) ? { file: fallback, app: "" } : null;
  let parsed: { app_name?: unknown; paths?: { progress_doc?: unknown } } = {};
  try { parsed = (parse(await fs.read(config)) ?? {}) as typeof parsed; } catch { /* the default path */ }
  const doc = typeof parsed.paths?.progress_doc === "string" ? parsed.paths.progress_doc : null;
  const file = doc && !path.isAbsolute(doc) && !doc.split(/[\\/]/).includes("..") ? path.join(engine.projectDir, doc)
    : fallback;
  return { file, app: typeof parsed.app_name === "string" ? parsed.app_name : "" };
}

/** Rewrites the doc from the fold (after ticket changes, and `rafi tickets render` with `force`). */
export async function writeProgressDoc(engine: Engine, view: Folded, o: { docsRoot: string; force?: boolean }):
  Promise<string | null> {
  const at = await progressDocPath(engine, o.docsRoot) ?? (o.force ? { file: path.join(engine.projectDir,
    o.docsRoot, "ticket-progress.md"), app: "" } : null);
  if (!at) return null;
  const loaded = await loadTickets(engine.deps.fs, engine.projectDir);
  if (!loaded.ok) return null;
  const v = view.queue.length ? view : engine.fold(loaded.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
  const inbox = (await futureWork(engine)).filter((f) => !f.accepted);
  const text = renderProgressDoc({ tickets: loaded.tickets, view: v, app: at.app, inbox,
    archived: await archivedIds(engine, o.docsRoot), now: engine.deps.clock.now().toISOString() });
  // Part 6: never over an edit of yours (writeView); `rafi tickets render` (force) rewrites it.
  return (await writeView(engine, at.file, engine.redact(text), o.force)) ? at.file : null;
}

export async function archiveDocPath(engine: Engine, docsRoot: string): Promise<string> {
  const fallback = path.join(engine.projectDir, docsRoot, "ticket-archive.md");
  try {
    const doc = (parse(await engine.deps.fs.read(path.join(engine.projectDir, TRACKER_CONFIG))) as
      { paths?: { archive_doc?: unknown } } | null)?.paths?.archive_doc;
    return typeof doc === "string" && !path.isAbsolute(doc) && !doc.split(/[\\/]/).includes("..")
      ? path.join(engine.projectDir, doc) : fallback;
  } catch {
    return fallback;
  }
}

/** The ticket ids the archive doc lists. */
export async function archivedIds(engine: Engine, docsRoot: string): Promise<Set<string>> {
  const file = await archiveDocPath(engine, docsRoot);
  if (!(await engine.deps.fs.stat(file))) return new Set();
  const rows = (await engine.deps.fs.read(file)).split("\n").map((l) => /^\| ([A-Za-z][\w-]*) \|/.exec(l)?.[1]);
  return new Set(rows.filter((id): id is string => Boolean(id) && id !== "Ticket"));
}
