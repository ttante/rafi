// Real SQLite through better-sqlite3. busy_timeout is 0: the log retries on deps.clock (ARCH 3.1).
import Database from "better-sqlite3";
import type { Db } from "../types.js";

export function openRealDb(file: string, o?: { readonly?: boolean }): Db {
  const db = new Database(file, { readonly: Boolean(o?.readonly), fileMustExist: Boolean(o?.readonly) });
  db.pragma("busy_timeout = 0");
  return db as unknown as Db;
}
