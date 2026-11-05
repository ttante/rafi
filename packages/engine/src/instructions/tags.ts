// Tags (ARCH 10.1; M5 plan C220, C239): rafi's fixed list (special-agents' tags.yaml) plus the project's `tags:`
// with file patterns. Before a
// builder starts, a pattern matching one of the ticket's likely files adds that tag; before QA reviews, a pattern
// matching a file the builder changed does. Tags are only added, each once with its reason, as `ticket.tags_added`,
// decided inside the append's transaction (R18): the tags already recorded are read there, and a tag recorded by
// someone else meanwhile is never added twice. No agent call is involved.
import path from "node:path";
import type { Settings, TicketV1 } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import { changedBetween } from "../facts/snapshot.js";

export type TagPatterns = Readonly<Record<string, readonly string[]>>;
export interface TagReason { readonly tag: string; readonly reason: string }

/** The fixed list's patterns (special-agents' `content/tags.yaml`, `fixedTags` in packs.ts) with the project's
 * added (FMT-C13). */
export function tagPatterns(settings: Settings, fixed: TagPatterns): TagPatterns {
  const project = (settings.tags?.value ?? {}) as Record<string, { patterns?: string[] }>;
  const out: Record<string, string[]> = {};
  for (const [tag, patterns] of Object.entries(fixed)) out[tag] = [...patterns];
  for (const [tag, entry] of Object.entries(project)) out[tag] = [...new Set([...(out[tag] ?? []),
    ...(entry.patterns ?? [])])];
  return out;
}

/** POSIX-form paths, so Windows-style ones match too (C220). */
const posix = (file: string) => file.replace(/\\/g, "/").replace(/^\.\//, "");

/** Tags these files add that aren't in `current`, with the first matching file as the reason (pure). */
export function tagAdditions(current: ReadonlySet<string>, files: readonly string[], patterns: TagPatterns,
  why: "likely" | "changed"): TagReason[] {
  const out: TagReason[] = [];
  for (const [tag, list] of Object.entries(patterns)) {
    if (current.has(tag)) continue;
    for (const file of files.map(posix)) {
      const pattern = list.find((p) => path.posix.matchesGlob(file, p));
      if (!pattern) continue;
      out.push({ tag, reason: why === "likely" ? `${file} matches ${pattern}` :
        `builder changed ${file} (matches ${pattern})` });
      break;
    }
  }
  return out;
}

// A reset of the ticket (`build.reset`, S-TAG-5 step 2) takes it back to its definition's tags; rafi adds again.
const RECORDED = "SELECT data FROM events WHERE type = 'ticket.tags_added' AND ticket_id = ? AND seq > COALESCE(" +
  "(SELECT MAX(r.seq) FROM events r WHERE r.type = 'build.reset' AND EXISTS (SELECT 1 FROM json_each(r.data, " +
  "'$.tickets') WHERE value = ?)), 0)";

function recorded(rows: readonly { data: string }[]): Set<string> {
  return new Set(rows.flatMap((r) => (JSON.parse(r.data) as { tags: TagReason[] }).tags.map((t) => t.tag)));
}

class Raced extends Error {}

/** The ticket's tags now: its definition's and every one rafi or you added since the ticket was last reset. */
export async function ticketTags(engine: Engine, ticket: TicketV1): Promise<Set<string>> {
  let added = new Set<string>();
  for await (const e of engine.events()) {
    if (e.type === "build.reset" && ((e.data as { tickets?: string[] }).tickets ?? []).includes(ticket.id)) {
      added = new Set();
    }
    if (e.type === "ticket.tags_added" && e.ticket_id === ticket.id) {
      for (const t of (e.data as { tags: TagReason[] }).tags) added.add(t.tag);
    }
  }
  return new Set([...(ticket.tags ?? []), ...added]);
}

/** Adds the tags `compute` finds missing from the ticket's tags now, once each, deciding inside the append's
 * transaction (R18): a tag someone else records meanwhile makes it look again. */
async function addReasons(engine: Engine, run: string, ticket: TicketV1,
  compute: (current: ReadonlySet<string>) => TagReason[], line: (text: string) => void): Promise<TagReason[]> {
  for (let tries = 0; tries < 5; tries += 1) {
    const adds = compute(await ticketTags(engine, ticket));
    if (!adds.length) return [];
    try {
      await engine.append([{ type: "ticket.tags_added", run_id: run, ticket_id: ticket.id, actor: "engine",
        data: { tags: adds } }], { inTx: (db) => {
        const now = recorded(db.prepare(RECORDED).all(ticket.id, ticket.id) as { data: string }[]);
        if (adds.some((a) => now.has(a.tag))) throw new Raced();
      } });
      for (const a of adds) line(`${ticket.id}: tag ${a.tag} added (${a.reason})`);
      return adds;
    } catch (error) {
      if (!(error instanceof Raced)) throw error;
    }
  }
  return [];
}

/** Adds the tags these files call for (patterns on likely or changed files). */
export async function addTags(engine: Engine, run: string, ticket: TicketV1, files: readonly string[],
  o: { patterns: TagPatterns; why: "likely" | "changed"; line: (text: string) => void }): Promise<TagReason[]> {
  return addReasons(engine, run, ticket, (current) => tagAdditions(current, files, o.patterns, o.why), o.line);
}

/** QA preparation's `add_tags` (ARCH 10.1, 6.3): each known tag the ticket lacks, "added by QA preparation"; an
 * unknown one is skipped with one line naming it and the known list. */
export async function addQaTags(engine: Engine, run: string, ticket: TicketV1, tags: readonly string[],
  known: TagPatterns, line: (text: string) => void): Promise<TagReason[]> {
  const names = Object.keys(known);
  for (const tag of tags.filter((t) => !names.includes(t))) {
    line(`${ticket.id}: QA preparation's tag ${escapeTag(tag)} isn't a known tag (known: ${names.join(", ")}); ` +
      "skipped");
  }
  const wanted = [...new Set(tags.filter((t) => names.includes(t)))];
  return addReasons(engine, run, ticket, (current) => wanted.filter((t) => !current.has(t))
    .map((tag) => ({ tag, reason: "added by QA preparation" })), line);
}

/** An agent's tag text in a terminal line: printable, short. */
const escapeTag = (tag: string) => JSON.stringify(tag.slice(0, 40)).slice(1, -1).replace(/[^\x20-\x7e]/g, "?");

/** The files this ticket's builder changed: the worktree against the tree the last recorded snapshot before this
 * ticket started held (another ticket's work on the same branch isn't this builder's), else against HEAD. */
export async function changedByBuilder(engine: Engine, ticket: string, now: { tree: string; files: string[] }):
  Promise<string[]> {
  let started = 0;
  const snaps: { seq: number; tree: string }[] = [];
  for await (const e of engine.events()) {
    if (e.type === "ticket.started" && e.ticket_id === ticket) started = e.seq;
    if (e.type === "facts.snapshot") snaps.push({ seq: e.seq, tree: (e.data as { tree: string }).tree });
  }
  const base = snaps.filter((s) => s.seq < started).at(-1)?.tree;
  return base ? changedBetween(engine.deps, engine.projectDir, base, now.tree) : now.files;
}
