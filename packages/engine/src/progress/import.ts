// The clone import (ARCH 3.7 `:413`; M5 C224, P49): `.rafi/progress.yaml` read into a database that's missing (a
// fresh clone) or older than its entries. Each ticket entry newer than the database's latest event for that ticket
// whose status or fix count differs is imported as `progress.imported` (source `progress-file`), with one line.
// A ticket tickets.yaml doesn't have is skipped and named, except an entry with `owned`: for a ticket the database
// doesn't have, `ticket.added` from those fields comes first, so it comes back rafi-owned; one with the same
// identity imports only its status; one whose id this database uses for a different rafi-owned ticket arrives under
// the next free FIX-<n>, with one line. Every event is one append, decided against the log as it is inside that
// transaction (a writer in between: decide again). A damaged, conflicted or oversized file imports nothing (the
// database wins; the safe point rewrites it). A conflicted file is merged first (C225, `merge.ts`).
import path from "node:path";
import { checkProgressFile, type ProgressFile } from "rafi-spec/v1";
import { parse, stringify } from "yaml";
import type { Engine } from "../api/engine.js";
import { hooksOff } from "../facts/snapshot.js";
import { withFileLock } from "../log/lock.js";
import type { NewEvent } from "../log/types.js";
import { nextFixId } from "../tickets/owned.js";
import { hasMarkers, mergeConflicted } from "./merge.js";
import { HEADER, PROGRESS, status } from "./write.js";

const MAX_BYTES = 1_000_000;
const MAX_SEQ = "SELECT MAX(seq) AS n FROM events";
class Moved extends Error {}
type Owned = NonNullable<ProgressFile["tickets"][string]["owned"]>;
type Read = { file: ProgressFile; said: string[] } | null;

async function textOf(engine: Engine): Promise<string | null> {
  const file = path.join(engine.projectDir, PROGRESS);
  if ((await engine.deps.fs.stat(file))?.kind !== "file") return null;
  const text = await engine.deps.fs.read(file);
  return Buffer.byteLength(text) > MAX_BYTES ? null : text;
}

function parsed(text: string): ProgressFile | null {
  try {
    const checked = checkProgressFile(parse(text, { maxAliasCount: 100 }));
    return checked.ok ? checked.file : null;
  } catch {
    return null;
  }
}

/** C301: when git left the file unmerged in your index (your merge is in progress), the clean file rafi wrote is
 * staged as that path's resolution, so rafi's snapshots (and your `git commit`) see one version; nothing else of
 * your merge is touched. Hooks off (C197); `add` runs none anyway. */
async function stageResolved(engine: Engine): Promise<void> {
  const o = { cwd: engine.projectDir, env: hooksOff(engine.deps.env, engine.projectDir) };
  const rel = PROGRESS.split(path.sep).join("/");
  const unmerged = await engine.deps.git(["ls-files", "-u", "--", rel], o);
  if (unmerged.code === 0 && unmerged.stdout.trim()) await engine.deps.git(["add", "-f", "--", rel], o);
}

/** C225, R6: a conflicted file merged and written back clean inside the progress file's lock, read again there, so
 * two writers merging at once write one clean file and only the one that merged says what it kept. */
async function mergeInLock(engine: Engine, seen: string): Promise<{ said: string[] } | null> {
  const taken = new Set(Object.keys(engine.fold().tickets));
  const locked = await withFileLock(engine.deps, engine.projectDir, "progress.yaml", async () => {
    // Read again inside the lock: what this writer `seen` before it may have been merged by another one meanwhile.
    const now = await textOf(engine);
    if (now === null || (now !== seen && !hasMarkers(now))) return { said: [] };
    const merged = mergeConflicted(now, taken);
    if ("invalid" in merged) return null;
    await engine.deps.fs.writeAtomic(path.join(engine.projectDir, PROGRESS),
      HEADER + stringify(merged.file, { sortMapEntries: true }));
    await stageResolved(engine);
    return { said: merged.lines };
  });
  return locked.ok ? locked.value : { said: [locked.message] };
}

/** The file as this command reads it; `write`: a conflicted one is merged and written back clean (C225). */
async function fileOf(engine: Engine, write: boolean): Promise<Read> {
  const text = await textOf(engine);
  if (text === null) return null;
  if (!hasMarkers(text)) {
    const file = parsed(text);
    return file && { file, said: [] };
  }
  if (!write) {
    const merged = mergeConflicted(text, new Set(Object.keys(engine.fold().tickets)));
    return "invalid" in merged ? null : { file: merged.file, said: merged.lines };
  }
  const merged = await mergeInLock(engine, text);
  if (!merged) return null;
  const clean = await textOf(engine);
  const file = clean === null || hasMarkers(clean) ? null : parsed(clean);
  return file && { file, said: merged.said };
}

/** Q-PORT-2: "always allow" stays on each machine, so a grant key in the file is refused and named. */
function grants(file: ProgressFile): string[] {
  return Object.keys(file.answers).filter((k) => k.startsWith("grant|")).map((k) => `Refused ${k} in ` +
    `${PROGRESS.split(path.sep).join("/")}: "always allow" grants stay on each computer.`);
}

const same = (a: Owned, b: { source: string; requirements: readonly string[]; hint: string | null }) =>
  a.source === b.source && a.hint === b.hint && JSON.stringify(a.requirements) === JSON.stringify(b.requirements);

async function plan(engine: Engine, file: ProgressFile, known: readonly string[]) {
  const latest: Record<string, string> = {};
  let seq = 0;
  for await (const e of engine.events()) {
    seq = e.seq;
    if (e.ticket_id) latest[e.ticket_id] = e.at;
  }
  const tickets = { ...engine.fold(known.map((id) => ({ id, dependsOn: [] }))).tickets };
  const events: NewEvent[] = [];
  const said: string[] = [];
  const skipped: string[] = [];
  const add = (type: string, ticket: string, data: unknown) => events.push({ type, run_id: null, ticket_id: ticket,
    actor: "engine", source: "progress-file", data });
  for (const [id, entry] of Object.entries(file.tickets).sort(([a], [b]) => a.localeCompare(b))) {
    if (latest[id] && Date.parse(latest[id]!) >= Date.parse(entry.at)) continue;
    let key = id;
    const have = tickets[id];
    // Nothing to rebuild: the database already says the same (a ticket with no events yet is written as "now").
    if (have && status(have) === entry.status && (entry.fixes ?? have.fixesUsed) === have.fixesUsed &&
      (!entry.owned || (have.owned && same(entry.owned, have.owned)))) continue;
    if (entry.owned && (!have || !have.owned || !same(entry.owned, have.owned))) {
      if (have) {
        key = nextFixId({ tickets });
        said.push(`${id} in ${PROGRESS} is a different fix ticket than this computer's ${id}; added it as ${key}.`);
      }
      add("ticket.added", key, { ticket: key, ...entry.owned });
      tickets[key] = { ...tickets[id]!, id: key, rafiOwned: true, owned: entry.owned };
    } else if (!entry.owned && !known.includes(id)) {
      skipped.push(id);
      continue;
    }
    add("progress.imported", key, { entry: { kind: "ticket", key, status: entry.status,
      at: new Date(Date.parse(entry.at)).toISOString(), ...(entry.fixes === undefined ? {} : { fixes: entry.fixes }),
      ...(entry.owned ? { owned: entry.owned } : {}) }, chose: "theirs" });
  }
  if (skipped.length) said.push(`Skipped ${skipped.join(", ")} from ${PROGRESS}: not in .tickets/tickets.yaml.`);
  return { seq, events, said };
}

/** The events the file's newer entries would add, and their lines, without writing (`rafi status`, ARCH 3.6). */
export async function pendingImport(engine: Engine, known: readonly string[]):
  Promise<{ events: NewEvent[]; said: string[] } | null> {
  const read = await fileOf(engine, false);
  if (!read) return null;
  const p = await plan(engine, read.file, known);
  return { events: p.events, said: [...read.said, ...grants(read.file), ...p.said] };
}

/** Imports the file's newer entries (a command that writes calls it before its own work). */
export async function importProgress(engine: Engine, known: readonly string[], line: (text: string) => void) {
  const read = await fileOf(engine, true);
  if (!read) return;
  for (const text of [...read.said, ...grants(read.file)]) line(text);
  for (let tries = 0; ; tries += 1) {
    const p = await plan(engine, read.file, known);
    if (!p.events.length) return;
    try {
      await engine.append(p.events, { inTx: (db) => {
        if (Number((db.prepare(MAX_SEQ).get() as { n: number | null }).n ?? 0) !== p.seq) throw new Moved();
      } });
    } catch (error) {
      if (error instanceof Moved && tries < 3) continue;
      throw error;
    }
    for (const text of p.said) line(text);
    line(`Rebuilt build state from ${PROGRESS.split(path.sep).join("/")}.`);
    return;
  }
}
