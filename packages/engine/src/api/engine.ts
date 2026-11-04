// openEngine (ARCH 8.3): opens the log, runs the workflow load checks, reads events, folds; M4 adds read-only opens
// for readers (C147) and owning a run: the lease row with the owner events in one transaction (C132), the
// heartbeat (C136) and the owner's liveness (C133). The rest of the API arrives with its milestone.
import path from "node:path";
import type { Db, Deps } from "../deps/types.js";
import { append, type AppendResult } from "../log/append.js";
import { emptyLog, openLog, type Log } from "../log/db.js";
import {
  buildSeq, dropLease, leaseBefore, LeaseTaken, liveOwner, readLease, startHeartbeat, swapLease, type LeaseLiveness,
  type LeaseRow,
} from "../log/lease.js";
import { getBlob, putBlob } from "../log/blobs.js";
import { redactor } from "../log/redact.js";
import { readEvents } from "../log/read.js";
import type { NewEvent, StoredEvent } from "../log/types.js";
import type { Violation } from "../state/types.js";
import { applyEvent, cloneAcc, emptyAcc, fold, type FoldAcc, type FoldContext } from "../state/fold.js";
import type { Folded, TicketDefinition } from "../state/types.js";
import { checkWorkflow } from "../workflow/checks.js";
import { builtInWorkflows } from "../workflow/load.js";

export const STATE_DB = path.join(".rafi", "state.sqlite3");

export interface Engine {
  events(q?: { from?: number; run?: string }): AsyncIterable<StoredEvent>;
  fold(definitions?: readonly TicketDefinition[]): Folded;
  append(events: readonly NewEvent[], o?: { idemKey?: string; inTx?: (db: Db) => void }): Promise<AppendResult>;
  /** Stores a redacted blob; returns its digest. */
  blob(text: string, o?: { sensitive?: boolean }): Promise<string>;
  readBlob(digest: string): string | null;
  /** Registers a secret with the one redactor: a session token (C39), or a declared value (C81, NEW-SEC-8). */
  secret(token: string, name?: string): void;
  /** The one redactor, with the session tokens it has learned (C39). */
  redact(text: string): string;
  readonly projectDir: string;
  readonly deps: Deps;
  /** The log's file (for deps.logChanged). */
  readonly logPath: string;
  /** The newest event's seq (0 for an empty log): a watcher's starting cursor. */
  lastSeq(): number;
  /** Opened read-only (C147): appends throw; a missing log reads as empty. */
  readonly readOnly: boolean;
  /** Takes the run's lease with these events in one transaction (C132; null: the checks only, for `--detach`).
   * Refused when another holder here is alive (`owner`, ARCH 8.5), or (`owner` null) when the lease table changed
   * after it was read or a build event came after `since` (build/claim.ts). */
  own(run: string | null, events: readonly NewEvent[], o?: { since?: number }):
    Promise<{ ok: true } | { ok: false; owner: LeaseRow | null }>;
  /** The newest build event's seq, for own's `since`. */
  buildSeq(): number;
  /** Writes these events (build.owner_released) and drops this instance's lease row, in one transaction. */
  disown(run: string, events: readonly NewEvent[]): Promise<void>;
  /** The run's lease holder: none, alive, not responding or dead (C133). */
  liveness(run: string): Promise<LeaseLiveness>;
  lease(run: string): LeaseRow | null;
  /** C136: refreshes the lease every 10 s until cancelled. */
  heartbeat(run: string): () => void;
  close(): void;
}

export class WorkflowLoadError extends Error {}

/**
 * The transition check every append runs (ARCH 3.3). M4 (speed): the fold of everything committed so far is kept and
 * only newer events are applied, other writers' included (read inside the append's own BEGIN IMMEDIATE transaction);
 * the trial result is kept only once the transaction commits.
 */
function transitionCheck(log: Log, ctx: FoldContext) {
  const state: { cache: { acc: FoldAcc; seq: number } | null; pending: { acc: FoldAcc; seq: number } | null } =
    { cache: null, pending: null };
  const check = (written: readonly StoredEvent[]): string | null => {
    const base = state.cache ?? { acc: emptyAcc(ctx), seq: 0 };
    const mine = new Set(written.map((w) => w.seq));
    const acc = cloneAcc(base.acc);
    let seq = base.seq;
    for (const event of readEvents(log.db, { from: base.seq }).events) {
      seq = Math.max(seq, event.seq);
      if (!mine.has(event.seq)) applyEvent(acc, event, ctx);
    }
    const known = acc.violations.length;
    for (const event of written) applyEvent(acc, event, ctx);
    state.pending = { acc, seq: Math.max(seq, ...written.map((w) => w.seq)) };
    return acc.violations.slice(known).map((v) => v.reason).join("; ") || null;
  };
  /** After an append: keep the trial fold if it committed; drop it otherwise. */
  const settle = (committed: boolean) => {
    if (committed && state.pending) state.cache = state.pending;
    state.pending = null;
  };
  return { check, settle };
}

export async function openEngine(o: { projectDir: string; deps: Deps; readOnly?: boolean }): Promise<Engine> {
  for (const workflow of builtInWorkflows) {
    const problems = checkWorkflow(workflow);
    if (problems.length) throw new WorkflowLoadError(`workflow ${workflow.id}: ${problems[0]!.message}`);
  }
  const { deps } = o;
  const file = path.join(o.projectDir, STATE_DB);
  const readOnly = Boolean(o.readOnly);
  if (!readOnly) await deps.fs.mkdir(path.join(o.projectDir, ".rafi"));
  const log = readOnly && !(await deps.fs.stat(file)) ? emptyLog(file, deps.clock)
    : await openLog(deps, file, { readOnly });
  const ctx: FoldContext = { workflows: builtInWorkflows };
  const redact = redactor(deps.env);
  const transitions = transitionCheck(log, ctx);
  const appendCtx = {
    log, redact, now: () => deps.clock.now(), newId: () => deps.random.id(), checkTransition: transitions.check,
  };
  const write: typeof append = async (c, events, opts) => {
    try {
      const out = await append(c, events, opts);
      transitions.settle(!out.replayed);
      return out;
    } catch (error) {
      transitions.settle(false);
      throw error;
    }
  };
  // M4 (speed): the log is append-only, so the rows this engine already read and validated are kept; each read
  // validates only the newer ones (other writers' included).
  const seen = { events: [] as StoredEvent[], violations: [] as Violation[], cursor: 0 };
  const refresh = () => {
    const read = readEvents(log.db, { from: seen.cursor });
    seen.events.push(...read.events);
    seen.violations.push(...read.violations);
    seen.cursor = read.cursor;
  };
  return {
    async *events(q = {}) {
      refresh();
      for (const event of seen.events) {
        if (event.seq > (q.from ?? 0) && (q.run === undefined || event.run_id === q.run)) yield event;
      }
    },
    fold: (definitions) => {
      refresh();
      const folded = fold(seen.events, { ...ctx, definitions });
      return { ...folded, violations: [...seen.violations, ...folded.violations] };
    },
    append: (events, opts) => write(appendCtx, events, opts),
    blob: async (text, opts) => (await putBlob(log, redact, text, { sensitive: Boolean(opts?.sensitive) })).digest,
    readBlob: (digest) => getBlob(log, digest)?.data ?? null,
    secret: (token, name = "RAFI_SESSION_TOKEN") => redact.add(name, token),
    redact: (text) => redact.text(text),
    projectDir: o.projectDir,
    deps,
    logPath: file,
    readOnly,
    lastSeq: () => Number((log.db.prepare("SELECT MAX(seq) AS m FROM events").get() as { m: number | null } | undefined)
      ?.m ?? 0),
    buildSeq: () => buildSeq(log.db),
    async own(run, events, opts = {}) {
      const checked = await leaseBefore(log, deps.processes);
      if (!checked.ok) return checked;
      try {
        await write(appendCtx, events, { inTx: (db) => {
          if (opts.since !== undefined && buildSeq(db) !== opts.since) throw new LeaseTaken(null);
          swapLease(db, log, deps.processes, run, checked.before);
        } });
        return { ok: true };
      } catch (error) {
        if (error instanceof LeaseTaken) return { ok: false, owner: error.owner };
        throw error;
      }
    },
    disown: async (run, events) => {
      await write(appendCtx, events, { inTx: (db) => dropLease(db, deps.processes, run) });
    },
    liveness: (run) => liveOwner(log, deps.processes, run),
    lease: (run) => readLease(log, run),
    heartbeat: (run) => startHeartbeat(log, deps.processes, deps.clock, run),
    close: () => log.close(),
  };
}
