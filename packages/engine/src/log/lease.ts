// The build lease (ARCH 3.2, 4.3.1). Coordination only; no state is read from it.
// Takeover is compare-and-swap: read, ask isAlive, then replace only if nothing changed (plan choice C15).
import type { Owner, Processes } from "../deps/types.js";
import type { Log } from "./db.js";

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
  | { ok: false; owner: LeaseRow };

const NO_START = "unknown";

export function readLease(log: Log, runId: string): LeaseRow | null {
  const row = log.db.prepare("SELECT * FROM lease WHERE run_id = ?").get(runId) as LeaseRow | undefined;
  return row ?? null;
}

export function leaseOwner(row: LeaseRow): Owner {
  return { instance: row.instance, host: row.host, pid: row.pid,
    startedAt: row.started_at === NO_START ? null : row.started_at };
}

/** Takes the lease when there's no row or its owner isn't alive. */
export async function acquireLease(log: Log, processes: Processes, runId: string): Promise<AcquireResult> {
  const before = readLease(log, runId);
  if (before && before.instance !== processes.self().instance) {
    if (await processes.isAlive(leaseOwner(before))) return { ok: false, owner: before };
  }
  const self = processes.self();
  const now = log.clock.now().toISOString();
  return log.write((db) => {
    const current = readLease(log, runId);
    const unchanged = (current === null && before === null) ||
      (current !== null && before !== null && current.instance === before.instance &&
        current.heartbeat_at === before.heartbeat_at);
    if (!unchanged) return { ok: false, owner: current! } as AcquireResult;
    db.prepare("DELETE FROM lease WHERE run_id = ?").run(runId);
    db.prepare(`INSERT INTO lease (run_id, instance, host, pid, started_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(runId, self.instance, self.host, self.pid, self.startedAt ?? NO_START, now);
    return { ok: true, previous: before } as AcquireResult;
  });
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

export function releaseLease(log: Log, processes: Processes, runId: string): Promise<boolean> {
  return log.write((db) => {
    const info = db.prepare("DELETE FROM lease WHERE run_id = ? AND instance = ?")
      .run(runId, processes.self().instance);
    return info.changes === 1;
  });
}
