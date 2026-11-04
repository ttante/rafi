// P8 option C (M4 plan, Q1): the fake executables sit beyond the real transport, which drops `meta`, so they read
// the turn's identity from rafi's own log: the `role`, `ticket`, `step` and `attempt` of the newest `turn.intent`
// rafi committed before sending the turn (SCN 7.3, ARCH 11.6). Read-only, through node:sqlite; `key` is never
// parsed. A QA copy lives under the project's `.rafi/cache/`, so the log is found by walking up from the cwd.
// With no log (or capture level `none`), it's null and the fakes apply rules in order.
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The project's `.rafi/state.sqlite3` at or above `cwd`, or null. */
export function findLog(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = path.join(dir, ".rafi", "state.sqlite3");
    if (existsSync(file)) return file;
    if (path.dirname(dir) === dir) return null;
  }
}

/** `{ role, ticket, step, attempt }` of the newest turn.intent (v 2), or null. */
export function turnIdentity(cwd) {
  const file = findLog(cwd);
  if (!file) return null;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT v, data FROM events WHERE type = 'turn.intent' ORDER BY seq DESC LIMIT 1").get();
    if (!row || row.v !== 2) return null;
    const data = JSON.parse(String(row.data));
    return { role: data.role ?? null, ticket: data.ticket ?? null, step: data.step ?? null,
      attempt: data.attempt ?? null };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
