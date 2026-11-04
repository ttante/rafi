// Opening the log: WAL, migrations in one transaction, BEGIN IMMEDIATE writes, busy retry on deps.clock.
import type { Clock, Db } from "../deps/types.js";
import { latestVersion, migrations } from "./migrations/index.js";

export const BUSY_LIMIT_MS = 30_000;
const BACKOFF_MS: readonly number[] = Object.freeze([50, 100, 250, 500, 1000]);

export class StorageError extends Error {
  readonly category = "storage";
  constructor(message: string, readonly path: string) {
    super(message);
  }
}

export interface Log {
  readonly db: Db;
  readonly path: string;
  readonly clock: Clock;
  /** Runs fn in one BEGIN IMMEDIATE transaction, retrying SQLITE_BUSY on the clock for up to 30 s. */
  write<T>(fn: (db: Db) => T): Promise<T>;
  close(): void;
}

export function isBusy(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function runMigrations(db: Db): number {
  const current = Number(db.pragma("user_version", { simple: true }) ?? 0);
  if (current >= latestVersion) return 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of migrations.filter((m) => m.version > current)) db.exec(migration.sql);
    db.pragma(`user_version = ${latestVersion}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return latestVersion - current;
}

function transact<T>(db: Db, fn: (db: Db) => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export async function withBusyRetry<T>(clock: Clock, path: string, fn: () => T): Promise<T> {
  const started = clock.now().getTime();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isBusy(error)) throw error;
      const waited = clock.now().getTime() - started;
      if (waited >= BUSY_LIMIT_MS) {
        throw new StorageError(`The rafi database at ${path} stayed busy for 30 seconds.`, path);
      }
      const delay = Math.min(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!, BUSY_LIMIT_MS - waited);
      await clock.sleep(delay, "backoff");
    }
  }
}

/** `readOnly` (C147): readers open the log without writing: no WAL switch, no migrations. */
export async function openLog(deps: { db: { open(path: string, o?: { readonly?: boolean }): Db }; clock: Clock },
  path: string, o: { readOnly?: boolean } = {}): Promise<Log> {
  if (o.readOnly) {
    const db = deps.db.open(path, { readonly: true });
    const version = userVersion(db);
    if (version !== latestVersion) {
      db.close();
      throw new StorageError(`The rafi database at ${path} is at schema ${version}, not ${latestVersion}; a ` +
        "command that writes (`rafi resume`, `rafi start`) updates it.", path);
    }
    return { db, path, clock: deps.clock, close: () => db.close(),
      write: () => Promise.reject(new StorageError(`The rafi database at ${path} is open read-only.`, path)) };
  }
  const db = deps.db.open(path);
  await withBusyRetry(deps.clock, path, () => {
    db.pragma("journal_mode = WAL");
    runMigrations(db);
  });
  return {
    db,
    path,
    clock: deps.clock,
    write: (fn) => withBusyRetry(deps.clock, path, () => transact(db, fn)),
    close: () => db.close(),
  };
}

export function userVersion(db: Db): number {
  return Number(db.pragma("user_version", { simple: true }) ?? 0);
}

/** A reader's view of a project whose log doesn't exist yet: no events, and nothing can be written (C147). */
export function emptyLog(file: string, clock: Clock): Log {
  const none = { exec: () => undefined, prepare: () => ({ run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => undefined, all: () => [] }), pragma: () => 0, close: () => undefined, inTransaction: false };
  return { db: none, path: file, clock, close: () => undefined,
    write: () => Promise.reject(new Error("rafi: there's no event log here to write to")) };
}
