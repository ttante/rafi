// Test helpers for engine unit tests: a temp dir, a manual clock, and a log opened on real SQLite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Clock, Db, Processes } from "../src/deps/types.js";
import { openRealDb } from "../src/deps/real/db.js";
import { openLog, type Log } from "../src/log/db.js";
import { redactor } from "../src/log/redact.js";
import type { AppendContext } from "../src/log/append.js";

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "rafi-engine-"));
}

/** A clock whose sleeps move time at once and are recorded. */
export function manualClock(start = Date.parse("2026-11-01T14:00:00Z")): Clock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => new Date(now),
    timer: () => () => undefined,
    async sleep(ms) {
      slept.push(ms);
      now += ms;
    },
  };
}

/** A db whose writes report SQLITE_BUSY until `busyUntil(clock)` is false. */
export function busyDb(file: string, busy: () => boolean): Db {
  const real = openRealDb(file);
  const fail = () => {
    if (busy()) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  };
  return {
    exec(sql) { if (sql.startsWith("BEGIN")) fail(); real.exec(sql); },
    prepare: (sql) => real.prepare(sql),
    pragma: (sql, o) => real.pragma(sql, o),
    close: () => real.close(),
    get inTransaction() { return real.inTransaction; },
  };
}

export async function testLog(o: { dir?: string; clock?: Clock; db?: (file: string) => Db } = {}) {
  const dir = o.dir ?? tempDir();
  const clock = o.clock ?? manualClock();
  const file = path.join(dir, "state.sqlite3");
  const log: Log = await openLog({ db: { open: o.db ?? ((f) => openRealDb(f)) }, clock }, file);
  let n = 0;
  const ctx: AppendContext = {
    log, redact: redactor({ RAFI_TEST_TOKEN: "s3cr3t-value-123" }), now: () => clock.now(),
    newId: () => `id-${String(++n).padStart(6, "0")}`,
  };
  return { dir, file, clock, log, ctx };
}

export function processesFor(instance: string, alive: (instance: string) => boolean): Processes {
  return {
    self: () => ({ instance, host: "h", pid: 1, startedAt: null }),
    isAlive: async (owner) => alive(owner.instance),
  };
}
