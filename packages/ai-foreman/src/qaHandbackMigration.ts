import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { qaDigest } from "./qaProtocolV2.js";

export const HANDBACK_SCHEMA_VERSION = 4;
const migration = "003_qa_report_occurrences_and_turns";

/** Review numbers are durably unique within a run/ticket, including before V3. */
export function reportOccurrenceId(runId: string, ticketId: string, reviewNumber: number): string {
  return qaDigest("qa-report-occurrence-v3", { runId, ticketId, reviewNumber });
}

export function registerHandbackWriter(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > HANDBACK_SCHEMA_VERSION) throw new Error(`Recovery database schema ${version} requires a newer Rafi writer`);
  db.function("rafi_writer_protocol", () => version >= 4 ? 4 : 3);
}

/** No provider work or file I/O occurs inside this migration transaction. */
export function migrateQaHandback(db: Database.Database, faults?: { afterTableCopy?(table: string): void }): void {
  if (db.prepare("SELECT 1 FROM recovery_schema_migrations WHERE migration=?").get(migration)) return;
  const tables = ["qa_reports", "qa_findings", "qa_report_dispositions", "qa_report_chains", "qa_failure_handoffs", "qa_remediation_receipts"];
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      const lease = db.prepare("SELECT pid,host FROM project_lease WHERE singleton=1").get() as { pid: number; host: string } | undefined;
      if (lease) {
        let demonstrablyDead = false;
        if (lease.host === hostname()) {
          try { process.kill(lease.pid, 0); } catch (error) { demonstrablyDead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        }
        if (!demonstrablyDead) throw new Error("QA occurrence migration requires stopped writers and a consistent backup; active or unverified lease remains");
      }
      const verifyEvidence = (digest: unknown): void => {
        if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return;
        const row = db.prepare("SELECT content FROM content_refs WHERE digest=?").get(digest) as { content: Buffer } | undefined;
        if (!row || createHash("sha256").update(row.content).digest("hex") !== digest) throw new Error(`QA migration evidence repair required: ${digest}`);
      };
      const reports = db.prepare("SELECT * FROM qa_reports").all() as Array<Record<string, any>>;
      const occurrences = new Map<string, string>();
      for (const report of reports) {
        const attempts = db.prepare("SELECT attempt_id,source_digest,report_digest FROM qa_review_attempts WHERE run_id=? AND ticket_id=? AND review_number=?")
          .all(report.run_id, report.ticket_id, report.review_number) as Array<Record<string, any>>;
        if (attempts.length !== 1 || attempts[0]!.report_digest !== report.report_digest || attempts[0]!.source_digest !== report.source_state_digest) {
          throw new Error(`QA occurrence migration requires lineage repair for ${report.run_id}/${report.ticket_id}/${report.review_number}`);
        }
        occurrences.set(report.report_digest, reportOccurrenceId(report.run_id, report.ticket_id, report.review_number));
        verifyEvidence(report.report_digest);
      }
      const occurrence = (digest: string): string => {
        const id = occurrences.get(digest);
        if (!id) throw new Error(`QA occurrence migration has orphan report reference ${digest}`);
        return id;
      };
      const verifyAttempt = (attemptId: unknown, report: Record<string, any>): void => {
        const attempt = typeof attemptId === "string" ? db.prepare("SELECT * FROM qa_review_attempts WHERE attempt_id=?").get(attemptId) as Record<string, any> | undefined : undefined;
        if (!attempt || attempt.run_id !== report.run_id || attempt.ticket_id !== report.ticket_id || attempt.review_number !== report.review_number
          || attempt.report_digest !== report.report_digest || attempt.source_digest !== report.source_state_digest) throw new Error("QA migration receipt/handoff attempt mismatch; lineage repair required");
      };
      for (const table of tables) {
        const original = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql;
        let schema = original.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_v3`).replace(`CREATE TABLE "${table}"`, `CREATE TABLE ${table}_v3`)
          .replaceAll(" REFERENCES qa_reports(report_digest)", "");
        const additions = table === "qa_report_chains"
          ? "predecessor_occurrence_id TEXT NOT NULL REFERENCES qa_reports(report_occurrence_id),successor_occurrence_id TEXT NOT NULL REFERENCES qa_reports(report_occurrence_id),"
          : `report_occurrence_id TEXT ${table === "qa_reports" ? "PRIMARY KEY" : "NOT NULL REFERENCES qa_reports(report_occurrence_id)"},`;
        schema = schema.replace("(", `(${additions}`);
        if (table === "qa_reports") schema = schema.replace("report_digest TEXT PRIMARY KEY", "report_digest TEXT NOT NULL").replace(/\)$/, ",UNIQUE(run_id,ticket_id,review_number))");
        if (table === "qa_report_chains") schema = schema.replace("PRIMARY KEY(predecessor_report_digest,successor_report_digest)", "PRIMARY KEY(predecessor_occurrence_id,successor_occurrence_id)");
        db.exec(schema);
        const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, any>>;
        for (const row of rows) {
          for (const key of ["handoff_digest", "host_instruction_digest", "receipt_digest", "response_digest", "parsed_response_digest"]) verifyEvidence(row[key]);
          const projected = table === "qa_report_chains"
            ? { ...row, predecessor_occurrence_id: occurrence(row.predecessor_report_digest), successor_occurrence_id: occurrence(row.successor_report_digest) }
            : { ...row, report_occurrence_id: occurrence(row.report_digest) };
          if (table === "qa_failure_handoffs" || table === "qa_remediation_receipts") {
            const report = reports.find(r => r.report_digest === row.report_digest)!;
            if (report.run_id !== row.run_id || report.ticket_id !== row.ticket_id) throw new Error(`QA migration cross-scope reference in ${table}`);
            if (table === "qa_failure_handoffs") {
              verifyAttempt(row.review_attempt_id, report);
            } else {
              const remediation = db.prepare("SELECT * FROM qa_remediation_attempts WHERE attempt_id=?").get(row.operation_id) as Record<string, any> | undefined;
              if (!remediation || remediation.run_id !== row.run_id || remediation.ticket_id !== row.ticket_id) throw new Error("QA migration receipt missing scoped remediation attempt");
              verifyAttempt(remediation.review_attempt_id, report);
              const receipt = JSON.parse(row.receipt_json);
              if (!receipt || ![2, 3].includes(receipt.version) || receipt.operationId !== row.operation_id || receipt.runId !== row.run_id
                || receipt.ticketId !== row.ticket_id || receipt.reportDigest !== row.report_digest || receipt.sourceStateDigest !== report.source_state_digest) throw new Error("QA migration receipt scope mismatch");
              for (const key of ["requestDigest", "responseDigest", "summaryDigest"]) {
                if (typeof receipt[key] !== "string" || !/^[a-f0-9]{64}$/.test(receipt[key])) throw new Error(`QA migration receipt evidence digest invalid: ${key}`);
                verifyEvidence(receipt[key]);
              }
            }
          }
          const columns = Object.keys(projected);
          db.prepare(`INSERT INTO ${table}_v3(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(projected));
        }
        const count = (db.prepare(`SELECT count(*) AS n FROM ${table}_v3`).get() as { n: number }).n;
        if (count !== rows.length) throw new Error(`QA migration row count mismatch: ${table}`);
        faults?.afterTableCopy?.(table);
      }
      for (const table of [...tables].reverse()) db.exec(`DROP TABLE ${table}`);
      for (const table of tables) db.exec(`ALTER TABLE ${table}_v3 RENAME TO ${table}`);
      db.exec(`CREATE INDEX qa_report_open ON qa_reports(run_id,ticket_id,disposition,review_number);
        CREATE INDEX qa_report_content ON qa_reports(report_digest);
        CREATE INDEX qa_failure_handoff_history ON qa_failure_handoffs(run_id,ticket_id,generation,state);
        CREATE TABLE qa_delivery_turns(turn_record_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,report_occurrence_id TEXT NOT NULL REFERENCES qa_reports(report_occurrence_id),turn_index INTEGER NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,record_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(operation_id,turn_index));
        CREATE TABLE qa_remediation_authorizations(authorization_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,ticket_id TEXT NOT NULL,review_attempt_id TEXT NOT NULL,reason TEXT NOT NULL,consumed_by TEXT UNIQUE,created_at TEXT NOT NULL);
        CREATE TABLE qa_remediation_stops(run_id TEXT NOT NULL,ticket_id TEXT NOT NULL,operation_id TEXT NOT NULL,outcome TEXT NOT NULL,record_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(run_id,ticket_id));`);
      if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("QA occurrence migration failed foreign key reconciliation");
      if ((db.pragma("integrity_check", { simple: true }) as string) !== "ok") throw new Error("QA occurrence migration failed integrity check");
      db.prepare("INSERT INTO recovery_schema_migrations(migration,completed_at) VALUES(?,?)").run(migration, new Date().toISOString());
      // Old binaries cannot register this connection-local function. Guard every
      // durable table, including leases and recovery, before allowing new writes.
      const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
      for (const { name } of allTables) for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TRIGGER handback_v3_${name}_${action} BEFORE ${action} ON "${name}" BEGIN SELECT CASE WHEN rafi_writer_protocol() != 3 THEN RAISE(ABORT,'incompatible Rafi writer') END; END;`);
      }
      db.pragma("user_version = 3");
    }).immediate();
  } finally { db.pragma("foreign_keys = ON"); }
}
