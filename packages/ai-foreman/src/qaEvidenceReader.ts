import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ManagerEvidenceAvailability } from "rafi-spec";
import { WORKFLOW_DB_FILE } from "./workflowDb.js";
import { evidenceDigest } from "./managerEvidenceArtifacts.js";

export type EvidenceRow = Record<string, unknown>;
export interface QaEvidenceSnapshot {
  asOf: string;
  runId: string;
  availability: ManagerEvidenceAvailability;
  capabilities: string[];
  gaps: string[];
  rows: Record<string, EvidenceRow[]>;
  blobs: Map<string, Buffer>;
}
const scopedTables = ["qa_review_attempts", "qa_reports", "qa_remediation_attempts", "qa_turns", "qa_ticket_heads", "qa_recovery_heads", "qa_transitions", "qa_pass_certificates", "qa_finalization_steps", "qa_failure_handoffs", "qa_operation_journal", "qa_packet_projections", "qa_source_states", "qa_review_bases", "qa_remediation_receipts", "qa_remediation_stops", "build_work_scope", "build_work_admissions", "build_assignments", "build_ownership_conflicts", "build_reconciliations", "build_work_events", "build_instructions", "build_instruction_streams"] as const;

/** Inspection never registers a writer, runs a migration, or probes packet paths. */
export function readQaEvidenceSnapshot(projectDir: string, runId: string): QaEvidenceSnapshot {
  const result: QaEvidenceSnapshot = { runId, asOf: new Date().toISOString(), availability: "missing", capabilities: [], gaps: [], rows: {}, blobs: new Map() };
  const path = join(resolve(projectDir), WORKFLOW_DB_FILE);
  if (!existsSync(path)) { result.gaps.push("workflow database is missing"); return result; }
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    const connection = db;
    connection.transaction(() => {
      const tables = new Set((connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
      const read = (name: string, query: string, ...args: string[]): void => {
        if (!tables.has(name)) { result.gaps.push(`${name}: unsupported legacy schema`); return; }
        try { result.rows[name] = connection.prepare(query).all(...args) as EvidenceRow[]; }
        catch (error) {
          if (!/no such column|no such table/i.test(String(error))) throw error;
          result.gaps.push(`${name}: unsupported legacy columns`);
          return;
        }
        result.capabilities.push(name);
        // Invalid JSON must remain visible instead of becoming empty history.
        for (const row of result.rows[name]!) for (const [field, value] of Object.entries(row)) {
          if (field.endsWith("_json") && typeof value === "string") {
            try { JSON.parse(value); } catch { result.gaps.push(`${name}/${field}: corrupt retained JSON`); result.availability = "corrupt"; }
          }
        }
      };
      read("workflow_runs", "SELECT * FROM workflow_runs WHERE run_id=?", runId);
      if (!result.rows.workflow_runs?.length) { result.gaps.push("requested workflow run is missing"); return; }
      if (result.availability !== "corrupt") result.availability = "present";
      for (const table of scopedTables) read(table, `SELECT * FROM ${table} WHERE run_id=?`, runId);
      read("qa_remediation_authorizations","SELECT * FROM qa_remediation_authorizations WHERE run_id=?",runId);
      read("workflow_events", "SELECT * FROM workflow_events WHERE run_id=? ORDER BY sequence", runId);
      read("continuity_events", "SELECT * FROM continuity_events WHERE run_id=? ORDER BY sequence", runId);
      read("operation_journal", "SELECT * FROM operation_journal WHERE run_id=?", runId);
      read("human_decisions", "SELECT * FROM human_decisions WHERE run_id=?", runId);
      if (tables.has("qa_delivery_turns") && tables.has("qa_reports")) {
        const columns = connection.prepare("PRAGMA table_info(qa_reports)").all() as Array<{ name: string }>;
        if (columns.some(column => column.name === "report_occurrence_id")) read("qa_delivery_turns", "SELECT d.* FROM qa_delivery_turns d JOIN qa_reports r ON r.report_occurrence_id=d.report_occurrence_id WHERE r.run_id=?", runId);
        else result.gaps.push("qa_delivery_turns: occurrence identity unsupported");
      } else result.gaps.push("qa_delivery_turns: unsupported legacy schema");
      for (const [name,query] of Object.entries({
        build_instruction_deliveries:"SELECT d.* FROM build_instruction_deliveries d JOIN build_instructions i USING(instruction_id) WHERE i.run_id=?",
        build_instruction_events:"SELECT e.* FROM build_instruction_events e JOIN build_instructions i USING(instruction_id) WHERE i.run_id=? ORDER BY e.sequence",
        qa_report_dispositions:"SELECT d.* FROM qa_report_dispositions d JOIN qa_reports r USING(report_occurrence_id) WHERE r.run_id=? ORDER BY d.sequence",
        qa_report_chains:"SELECT c.* FROM qa_report_chains c JOIN qa_reports r ON r.report_occurrence_id=c.predecessor_occurrence_id WHERE r.run_id=?",
      })) read(name,query,runId);
      for(const report of result.rows.qa_reports??[]) {
        if(typeof report.report_occurrence_id!=="string") {result.gaps.push("qa_reports: legacy digest identity may be ambiguous; use the retained run/work/review scope");continue;}
        const parent=(result.rows.qa_review_attempts??[]).find(row=>row.ticket_id===report.ticket_id&&row.review_number===report.review_number);
        if(!parent||parent.source_digest!==report.source_state_digest||parent.report_digest!==report.report_digest) {
          result.gaps.push(`qa_reports/${report.report_occurrence_id}: contradictory or missing review parent`);result.availability="corrupt";
        }
      }
      for(const [name,rows] of Object.entries(result.rows))if(name.startsWith("qa_"))for(const row of rows) {
        if("run_id" in row&&row.run_id!==runId||"ticket_id" in row&&typeof row.ticket_id!=="string") {result.gaps.push(`${name}: corrupt scoped row identity`);result.availability="corrupt";}
        if("review_number" in row&&(!Number.isSafeInteger(row.review_number)||Number(row.review_number)<1)) {result.gaps.push(`${name}: corrupt review ordinal`);result.availability="corrupt";}
      }
      // Copy only blobs referenced by scoped rows. Never allow a guessed digest read.
      const references = new Set<string>();
      const collect = (value: unknown): void => {
        if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) references.add(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
      };
      for (const rows of Object.values(result.rows)) for (const row of rows) for (const [field, value] of Object.entries(row)) {
        if (field.endsWith("_json") && typeof value === "string") { try { collect(JSON.parse(value)); } catch { /* already disclosed */ } }
        else collect(value);
      }
      if (!tables.has("content_refs")) result.gaps.push("content_refs: unsupported legacy schema");
      else for (const digest of references) {
        const row = connection.prepare("SELECT content FROM content_refs WHERE digest=?").get(digest) as { content: Buffer } | undefined;
        if (row) {
          const bytes = Buffer.from(row.content);
          if (evidenceDigest(bytes) !== digest) { result.gaps.push(`content ${digest}: corrupt digest`); result.availability = "corrupt"; }
          else result.blobs.set(digest, bytes);
        }
      }
      if (!result.capabilities.includes("qa_review_attempts") && result.availability !== "corrupt") result.availability = "unsupported_legacy";
    })();
  } catch (error) {
    result.availability = /malformed|not a database|corrupt/i.test(String(error)) ? "corrupt" : "unreadable";
    result.gaps.push(`workflow evidence ${result.availability}: ${String(error)}`);
    // Do not expose a partial transaction as a complete snapshot.
    result.rows = {}; result.blobs.clear();
  } finally { db?.close(); }
  return result;
}

export function evidenceRecord(row: EvidenceRow, field = "record_json"): EvidenceRow | undefined {
  try { const parsed: unknown = JSON.parse(String(row[field])); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as EvidenceRow : undefined; } catch { return undefined; }
}
