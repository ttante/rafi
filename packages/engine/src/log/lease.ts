// The build lease (ARCH 3.2, 4.3.1). Coordination only; no state is read from it.
// Takeover is compare-and-swap: read, ask isAlive, then replace only if nothing changed (plan choice C15). One live
// build per checkout (ARCH 8.5) is decided over the whole table: every other holder must be dead, and every row must
// still be exactly as read (all fields) inside the write transaction, so two commands can't both take ownership.
import type { Cancel, Clock, Db, Owner, Processes } from "../deps/types.js";
import type { Log } from "./db.js";

/** C136: the owner refreshes the row this often. */
export const HEARTBEAT_MS = 10_000;
/** C133 (ARCH 4.3.1): a live owner whose heartbeat is older than this is "not responding". */
export const NOT_RESPONDING_MS = 60_000;

/** Who holds a run's lease (C133): none (no row), alive, not responding (alive, old heartbeat) or dead. */
export type LeaseLiveness = "none" | "alive" | "not-responding" | "dead";

export interface LeaseRow {
  readonly run_id: string;
  readonly instance: string;
  readonly host: string;
  readonly pid: number;
  readonly started_at: string;
  readonly heartbeat_at: string;
}

export type AcquireResult =
  | { ok: true; previous: LeaseRow | null }
  | { ok: false; owner: LeaseRow | null };

const NO_START = "unknown";

export function readLease(log: Log, runId: string): LeaseRow | null {
  const row = log.db.prepare("SELECT * FROM lease WHERE run_id = ?").get(runId) as LeaseRow | undefined;
  return row ?? null;
}

/** Every row in the checkout's lease table. */
export function readLeases(log: Log): LeaseRow[] {
  return log.db.prepare("SELECT * FROM lease ORDER BY run_id").all() as unknown as LeaseRow[];
}

export function leaseOwner(row: LeaseRow): Owner {
  return { instance: row.instance, host: row.host, pid: row.pid,
    startedAt: row.started_at === NO_START ? null : row.started_at };
}

/** The table changed after it was read (`owner`: null), or a holder is alive (`owner`: its row). */
export class LeaseTaken extends Error {
  constructor(readonly owner: LeaseRow | null) {
    super(owner ? `build ${owner.run_id} is owned by ${owner.instance} on ${owner.host}`
      : "the build lease changed while rafi was checking it");
  }
}

/** The checkout's rows before a takeover, or a refusal when another holder is alive (asked outside the transaction). */
export async function leaseBefore(log: Log, processes: Processes):
  Promise<{ ok: true; before: LeaseRow[] } | { ok: false; owner: LeaseRow }> {
  const before = readLeases(log);
  for (const row of before) {
    if (row.instance !== processes.self().instance && await processes.isAlive(leaseOwner(row))) {
      return { ok: false, owner: row };
    }
  }
  return { ok: true, before };
}

const rowKey = (r: LeaseRow) => JSON.stringify([r.run_id, r.instance, r.host, r.pid, r.started_at, r.heartbeat_at]);

/**
 * Inside a write transaction: when every row is still exactly as in `before` (C15, the whole row), replaces `runId`'s
 * row with this instance's (null: checks only, for `--detach`); else throws LeaseTaken, so the transaction (and the
 * events written with it, C132) rolls back.
 */
export function swapLease(db: Db, log: Log, processes: Processes, runId: string | null,
  before: readonly LeaseRow[]): void {
  const was = new Set(before.map(rowKey));
  const current = readLeases(log);
  if (current.length !== before.length || current.some((r) => !was.has(rowKey(r)))) throw new LeaseTaken(null);
  if (runId === null) return;
  const self = processes.self();
  db.prepare("DELETE FROM lease WHERE run_id = ?").run(runId);
  db.prepare(`INSERT INTO lease (run_id, instance, host, pid, started_at, heartbeat_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(runId, self.instance, self.host, self.pid, self.startedAt ?? NO_START,
    log.clock.now().toISOString());
}

/** The newest build event's seq: what a decision to own a run was made on (ARCH 8.5; checked in the transaction). */
export function buildSeq(db: Db): number {
  const row = db.prepare("SELECT MAX(seq) AS m FROM events WHERE type LIKE 'build.%'").get() as
    { m: number | null } | undefined;
  return Number(row?.m ?? 0);
}

/** Takes the lease when no other holder in the checkout is alive. */
export async function acquireLease(log: Log, processes: Processes, runId: string): Promise<AcquireResult> {
  const checked = await leaseBefore(log, processes);
  if (!checked.ok) return checked;
  try {
    await log.write((db) => swapLease(db, log, processes, runId, checked.before));
    return { ok: true, previous: checked.before.find((r) => r.run_id === runId) ?? null };
  } catch (error) {
    if (error instanceof LeaseTaken) return { ok: false, owner: error.owner };
    throw error;
  }
}

/** C133: whether the run's lease holder is alive, and responding. */
export async function liveOwner(log: Log, processes: Processes, runId: string): Promise<LeaseLiveness> {
  const row = readLease(log, runId);
  if (!row) return "none";
  if (!(await processes.isAlive(leaseOwner(row)))) return "dead";
  const age = log.clock.now().getTime() - Date.parse(row.heartbeat_at);
  return age > NOT_RESPONDING_MS ? "not-responding" : "alive";
}

/** C136: the owner's heartbeat, every 10 s on the clock, until cancelled or the lease is someone else's. */
export function startHeartbeat(log: Log, processes: Processes, clock: Clock, runId: string): Cancel {
  let cancel: Cancel = () => undefined;
  let stopped = false;
  const arm = () => {
    cancel = clock.timer(HEARTBEAT_MS, () => {
      if (stopped) return;
      void heartbeat(log, processes, runId).then((mine) => { if (mine && !stopped) arm(); }, () => undefined);
    }, "heartbeat");
  };
  arm();
  return () => { stopped = true; cancel(); };
}

/** Refreshes the heartbeat; false when another instance holds the lease now. */
export function heartbeat(log: Log, processes: Processes, runId: string): Promise<boolean> {
  const now = log.clock.now().toISOString();
  return log.write((db) => {
    const info = db.prepare("UPDATE lease SET heartbeat_at = ? WHERE run_id = ? AND instance = ?")
      .run(now, runId, processes.self().instance);
    return info.changes === 1;
  });
}

/** Inside a write transaction: this instance holds the run's lease (M5 C235: an effect's intent is the owner's). */
export function holdsLease(db: Db, processes: Processes, runId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lease WHERE run_id = ? AND instance = ?").get(runId,
    processes.self().instance));
}

/** Inside a write transaction: drops this instance's row (C132: with build.owner_released). */
export function dropLease(db: Db, processes: Processes, runId: string): void {
  db.prepare("DELETE FROM lease WHERE run_id = ? AND instance = ?").run(runId, processes.self().instance);
}

export function releaseLease(log: Log, processes: Processes, runId: string): Promise<boolean> {
  return log.write((db) => {
    const info = db.prepare("DELETE FROM lease WHERE run_id = ? AND instance = ?")
      .run(runId, processes.self().instance);
    return info.changes === 1;
  });
}
