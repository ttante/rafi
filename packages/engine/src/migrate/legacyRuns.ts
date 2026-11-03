// Read-only lookup of an unfinished 0.10.x build, for the format refusal line (ARCH 9.2, plan choice C23).
import path from "node:path";
import type { Deps } from "../deps/types.js";

export const LEGACY_DB = path.join(".rafi", "recovery.sqlite3");
const FINISHED = "('completed', 'cancelled', 'superseded')";

export interface LegacyRun {
  readonly runId: string;
  readonly status: string;
}

/** The newest unfinished 0.10.x build in `.rafi/recovery.sqlite3`, or null. Opens the file read-only. */
export async function unfinishedLegacyBuild(
  deps: Pick<Deps, "db" | "fs">, projectDir: string,
): Promise<LegacyRun | null> {
  const file = path.join(projectDir, LEGACY_DB);
  if (!(await deps.fs.stat(file))) return null;
  const db = deps.db.open(file, { readonly: true });
  try {
    const row = db.prepare(`SELECT run_id, status FROM workflow_runs WHERE kind = 'build'
      AND status NOT IN ${FINISHED} ORDER BY updated_at DESC LIMIT 1`).get() as
      { run_id: string; status: string } | undefined;
    return row ? { runId: row.run_id, status: row.status } : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
