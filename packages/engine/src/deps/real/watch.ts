// The real `deps.logChanged` (ARCH 8.2, C139): its own read-only connection polls `PRAGMA data_version` every
// 250 ms; the value changes when any other connection commits (another rafi process, or this process's own log
// connection), and the callback runs once per change seen. The timer is unref'd and stops when cancelled.
import { openRealDb } from "./db.js";
import type { Cancel, Db } from "../types.js";

export const WATCH_MS = 250;

export function realLogChanged(file: string, onChange: () => void): Cancel {
  let db: Db | null = null;
  let last: number | null = null;
  const version = () => {
    try {
      db ??= openRealDb(file, { readonly: true });
      return Number(db.pragma("data_version", { simple: true }));
    } catch {
      return null;
    }
  };
  last = version();
  const timer = setInterval(() => {
    const now = version();
    if (now !== null && last !== null && now !== last) onChange();
    if (now !== null) last = now;
  }, WATCH_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    db?.close();
    db = null;
  };
}
