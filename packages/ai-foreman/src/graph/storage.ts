import type Database from "better-sqlite3";
import { bytesDigest, canonical } from "./util.js";
export type GraphRecordKind = "evidence-reservation" | "session-access" | "adoption" | "capability" | "generation" | "head" | "job" | "exchange" | "receipt" | "retention" | "revocation" | "storage-reservation";
export function migrateGraphStore(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS graph_schema(version INTEGER NOT NULL);
    INSERT INTO graph_schema(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM graph_schema);`);
  if ((db.prepare("SELECT version FROM graph_schema").get() as {
    version: number;
  }).version !== 1)
    throw new Error("Unsupported graph control schema");
  db.exec(`CREATE TABLE IF NOT EXISTS graph_records(kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS graph_leases(scope TEXT PRIMARY KEY, owner TEXT NOT NULL, fence INTEGER NOT NULL, expires INTEGER NOT NULL);`);
}
export function readGraphRecord<T>(db: Database.Database | undefined, kind: GraphRecordKind, id: string): {
  revision: number;
  value: T;
} | undefined {
  if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='graph_records'").get())
    return undefined;
  const row = db.prepare("SELECT revision,value FROM graph_records WHERE kind=? AND id=?").get(kind, id) as {
    revision: number;
    value: string;
  } | undefined;
  return row ? { revision: row.revision, value: JSON.parse(row.value) as T } : undefined;
}
export class GraphStore {
  constructor(private readonly db: Database.Database) { }
  get<T>(kind: GraphRecordKind, id: string): {
    revision: number;
    value: T;
  } | undefined { return readGraphRecord<T>(this.db, kind, id); }
  list<T>(kind: GraphRecordKind): Array<{
    id: string;
    revision: number;
    value: T;
  }> {
    return (this.db.prepare("SELECT id,revision,value FROM graph_records WHERE kind=? ORDER BY id").all(kind) as Array<{
      id: string;
      revision: number;
      value: string;
    }>).map(row => ({ ...row, value: JSON.parse(row.value) as T }));
  }
  put(kind: GraphRecordKind, id: string, value: unknown, expectedRevision?: number): number {
    return this.db.transaction(() => {
      const current = this.get(kind, id);
      if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision)
        throw new Error("Graph record changed concurrently");
      if (kind === "generation" && current && canonical(current.value) !== canonical(value))
        throw new Error("Graph generations are immutable");
      const revision = (current?.revision ?? 0) + 1;
      this.db.prepare("INSERT INTO graph_records(kind,id,revision,value) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,value=excluded.value").run(kind, id, revision, canonical(value));
      return revision;
    }).immediate();
  }
  remove(kind: GraphRecordKind, id: string): void { this.db.prepare("DELETE FROM graph_records WHERE kind=? AND id=?").run(kind, id); }
  reserveStorage(id: string, bytes: number, used: number, limit: number, lease?: { scope: string; owner: string; fence: number }): void {
    this.db.transaction(() => {
      // Expired publishers cannot commit. Their staged bytes remain in `used`,
      // but their abandoned reservation must not permanently consume capacity.
      for (const row of this.list<{ scope?: string; owner?: string; fence?: number }>("storage-reservation")) {
        if (row.value.scope && row.value.owner && row.value.fence !== undefined && !this.ownsLease(row.value.scope, row.value.owner, row.value.fence, Date.now()))
          this.remove("storage-reservation", row.id);
      }
      const reserved = this.list<{
        bytes: number;
      }>("storage-reservation").filter(r => r.id !== id).reduce((n, r) => n + r.value.bytes, 0);
      if (used + reserved + bytes > limit)
        throw new Error("Graph storage admission exceeded; prune unprotected generations or explicitly increase the policy");
      this.put("storage-reservation", id, { bytes, ...lease, createdAt: new Date().toISOString() });
    }).immediate();
  }
  /** Reserve optional evidence bytes cumulatively across concurrent operations.
   * Mandatory QA artifacts remain governed by their owning protocol. */
  admitEvidence(runId: string, operationId: string, bytes: number, limit: number): boolean {
    return this.db.transaction(() => {
      const prior = this.get<{ runId: string; bytes: number }>("evidence-reservation", operationId);
      if (prior && prior.value.runId !== runId) throw new Error("Graph evidence operation changed run scope");
      const used = this.db.prepare("SELECT COALESCE(SUM(json_extract(value,'$.bytes')),0) AS bytes FROM graph_records WHERE kind='evidence-reservation' AND json_extract(value,'$.runId')=? AND id<>?").get(runId, operationId) as { bytes: number };
      const reserved = Math.max(bytes, prior?.value.bytes ?? 0);
      if (used.bytes + reserved > limit) return false;
      this.put("evidence-reservation", operationId, { runId, bytes: reserved });
      return true;
    }).immediate();
  }
  lease(scope: string, owner: string, now: number, durationMs: number): number {
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT owner,fence,expires FROM graph_leases WHERE scope=?").get(scope) as {
        owner: string;
        fence: number;
        expires: number;
      } | undefined;
      if (prior && prior.expires > now)
        throw new Error("Graph maintenance already owned by another operation");
      const fence = (prior?.fence ?? 0) + 1;
      this.db.prepare("INSERT INTO graph_leases(scope,owner,fence,expires) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,expires=excluded.expires").run(scope, owner, fence, now + durationMs);
      return fence;
    }).immediate();
  }
  ownsLease(scope: string, owner: string, fence: number, now: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM graph_leases WHERE scope=? AND owner=? AND fence=? AND expires>?").get(scope, owner, fence, now));
  }
  publish(scope: string, owner: string, fence: number, now: number, priorRevision: number, generation: {
    id: string;
  }, job: unknown): void {
    this.db.transaction(() => {
      const lease = this.db.prepare("SELECT owner,fence,expires FROM graph_leases WHERE scope=?").get(scope) as {
        owner: string;
        fence: number;
        expires: number;
      } | undefined;
      if (!lease || lease.owner !== owner || lease.fence !== fence || lease.expires <= now)
        throw new Error("Graph publication lease expired or superseded");
      this.put("generation", generation.id, generation);
      this.put("head", scope, { generationId: generation.id }, priorRevision);
      this.put("job", owner, job);
      this.db.prepare("UPDATE graph_leases SET expires=0 WHERE scope=? AND owner=? AND fence=?").run(scope, owner, fence);
    }).immediate();
  }
  release(scope: string, owner: string, fence: number): void { this.db.prepare("UPDATE graph_leases SET expires=0 WHERE scope=? AND owner=? AND fence=?").run(scope, owner, fence); }
}
/** Only invoke against the staged export/import connection, never the live DB. */
export function normalizeTransferredGraphState(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='graph_records'").get())
    return;
  if ((db.prepare("SELECT version FROM graph_schema").get() as {
    version: number;
  })?.version !== 1)
    throw new Error("Unsupported graph transfer schema");
  // This connection owns only an offline copy. Clear deleted bytes from its
  // free pages as well as removing SQL-level references before export.
  db.pragma("secure_delete = ON");
  db.transaction(() => {
    // Derived graph-containing blobs cannot carry destination access grants.
    // Keep their content IDs and receipts, but explicitly withhold the bytes.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='graph_derived_refs'").get()) {
      // Live-table immutability remains intact. Temporarily remove guards only
      // within this staged-copy transaction, and restore their exact SQL.
      const projections = [["continuity_events", "payload_json"], ["continuity_checkpoints", "delta_json"],
        ["qa_contract_artifacts", "record_json"], ["qa_verification_contracts", "record_json"],
        ["qa_contract_check_history", "record_json"], ["qa_preparation_events", "record_json"],
        ["qa_depth_decisions", "record_json"], ["qa_contract_receipts", "record_json"],
        ["qa_preparation_attempts", "intent_json"], ["qa_preparation_budgets", "record_json"],
        ["qa_preparation_policy", "record_json"], ["qa_contract_heads", "detail"]];
      const tables = ["content_refs", ...projections.map(([table]) => table)];
      const triggers = db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (${tables.map(() => "?").join(",")})`).all(...tables) as Array<{ name: string; sql: string }>;
      for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
      for (const [table, column] of projections) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) continue;
        let after = 0;
        for (;;) {
          const rows = db.prepare(`SELECT rowid AS id,${column} AS value FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 8`).all(after) as Array<{ id: number; value: string }>;
          if (!rows.length) break;
          after = rows.at(-1)!.id;
          for (const row of rows) {
          if (row.value == null) continue;
          const originalDigest = bytesDigest(row.value);
          if (!db.prepare("SELECT 1 FROM graph_derived_refs WHERE digest=?").get(originalDigest)) continue;
          if (column !== "detail" && JSON.parse(row.value)?.kind === "graph-evidence-withheld") continue;
          if (column === "detail" && row.value.startsWith('{"kind":"graph-evidence-withheld"')) continue;
          // This is explicitly an unavailable projection, never replacement
          // evidence under the old digest. Recovery readers reject its grant.
          const placeholder = canonical({ kind: "graph-evidence-withheld", originalContentDigest: originalDigest, reason: "transfer-requires-source-based-recovery" });
          db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(placeholder, row.id);
          db.prepare("INSERT OR REPLACE INTO graph_derived_refs(digest,access_json) VALUES(?,?)").run(bytesDigest(placeholder), canonical({ transferWithheld: true }));
          }
        }
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_refs'").get())
        db.prepare("DELETE FROM content_refs WHERE digest IN (SELECT digest FROM graph_derived_refs)").run();
      // Exported session markers cannot inherit the source machine's grants.
      db.prepare("UPDATE graph_derived_refs SET access_json=?").run(canonical({ transferWithheld: true }));
      for (const trigger of triggers) db.exec(trigger.sql);
    }
    db.prepare("DELETE FROM graph_records WHERE kind IN ('capability','head','retention','storage-reservation','evidence-reservation')").run();
    db.prepare("DELETE FROM graph_leases").run();
    for (const row of db.prepare("SELECT kind,id,value FROM graph_records WHERE kind IN ('job','exchange')").all() as Array<{
      kind: string;
      id: string;
      value: string;
    }>) {
      const value = JSON.parse(row.value);
      db.prepare("UPDATE graph_records SET value=?,revision=revision+1 WHERE kind=? AND id=?").run(canonical({ version: 1, state: "imported-history", priorState: value.state, operationId: value.operationId ?? row.id, generationId: value.generationId, limitation: "Destination source/capability validation and explicit recovery required" }), row.kind, row.id);
    }
  })();
}
