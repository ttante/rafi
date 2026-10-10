import { admitFixtureWork } from "./helpers/workAdmission.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { WorkflowDb } from "../src/workflowDb.js";
import { migrateQaHandback, registerHandbackWriter, reportOccurrenceId } from "../src/qaHandbackMigration.js";

const tables = ["qa_reports", "qa_findings", "qa_report_dispositions", "qa_report_chains", "qa_failure_handoffs", "qa_remediation_receipts"];
const report = { version: 1, summary: "same content", findings: [], observations: [] };

function seed(db: WorkflowDb, runId: string, ticketId: string, reviewNumber: number) {
  admitFixtureWork(db,runId,ticketId);
  const attemptId = `${runId}/${ticketId}/${reviewNumber}`;
  const reportDigest = db.putEvidence("qa", Buffer.from(JSON.stringify(report)));
  db.beginQaReviewAttempt({ attemptId, runId, ticketId, reviewNumber, cycle: reviewNumber, remediationGeneration: reviewNumber - 1, sourceDigest: "source" });
  db.finishQaReviewAttempt(attemptId, { status: "failed", reportDigest });
  const input = { reportDigest, runId, ticketId, reviewNumber, sourceStateDigest: "source", reviewBasisDigest: "basis", report };
  return { input, attemptId, record: db.recordQaReport(input, [`finding:${attemptId}`]) };
}

function downgradeFixture(root: string): void {
  const raw = new Database(join(root, ".rafi/recovery.sqlite3"));
  registerHandbackWriter(raw);
  try {
    raw.pragma("foreign_keys = OFF");
    raw.transaction(() => {
      for (const row of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>) raw.exec(`DROP TRIGGER ${row.name}`);
      const saved = new Map(tables.map(table => [table, raw.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>]));
      for (const table of [...tables].reverse()) raw.exec(`DROP TABLE ${table}`);
      raw.exec(readFileSync(new URL("./fixtures/qa-handback-v2.sql", import.meta.url), "utf8"));
      for (const table of tables) for (const row of saved.get(table)!) {
        const old = Object.fromEntries(Object.entries(row).filter(([key]) => !key.includes("occurrence_id")));
        const keys = Object.keys(old);
        raw.prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...Object.values(old));
      }
      for (const table of ["qa_delivery_turns", "qa_remediation_authorizations", "qa_remediation_stops"]) raw.exec(`DROP TABLE ${table}`);
      for(const table of ["build_instruction_events","build_instruction_deliveries","build_instructions","build_instruction_streams","build_work_events","build_reconciliations","build_ownership_conflicts","build_assignments","build_work_admissions","build_work_scope","build_project_identity","build_work_upgrade_backup"])raw.exec(`DROP TABLE IF EXISTS ${table}`);
      raw.prepare("DELETE FROM recovery_schema_migrations WHERE migration IN ('003_qa_report_occurrences_and_turns','004_admitted_build_work','005_manager_controls')").run();
      raw.pragma("user_version = 2");
    })();
  } finally { raw.close(); }
}

test("identical content owns independent occurrences, findings, dispositions, and scoped replay", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-occurrences-"));
  const db = new WorkflowDb(root);
  try {
    const first = seed(db, "run", "T1", 1);
    const second = seed(db, "run", "T1", 2);
    const otherTicket = seed(db, "run", "T2", 1);
    const otherRun = seed(db, "other", "T1", 1);
    assert.equal(new Set([first, second, otherTicket, otherRun].map(item => item.record.reportOccurrenceId)).size, 4);
    assert.equal(new Set([first, second, otherTicket, otherRun].map(item => item.record.reportDigest)).size, 1);
    assert.throws(() => db.qaReport(first.record.reportDigest), /ambiguous/);
    assert.deepEqual(db.recordQaReport(first.input, [`finding:${first.attemptId}`]), first.record);
    assert.throws(() => db.recordQaReport({ ...first.input, report: { ...report, summary: "conflict" } }, [`finding:${first.attemptId}`]), /conflicting QA report occurrence/);
    assert.throws(() => db.recordQaReport(first.input, ["foreign-finding"]), /ownership/);
    db.setQaReportDisposition(first.record.reportOccurrenceId, "waived", "explicit test waiver");
    db.setQaReportDisposition(second.record.reportOccurrenceId, "superseded", "new source");
    db.resolveQaReportsAfterPass("other", "T1");
    assert.equal(db.qaReport(first.record.reportOccurrenceId)?.disposition, "waived");
    assert.equal(db.qaReport(otherTicket.record.reportOccurrenceId)?.disposition, "open");
    assert.equal(db.qaReport(otherRun.record.reportOccurrenceId)?.disposition, "verified-fixed");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy migration preserves evidence, finding IDs, handoff IDs and dispositions across restart; old writers fail", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-migrate-"));
  try {
    const db = new WorkflowDb(root);
    const seeded = seed(db, "run", "T1", 1);
    const evidence = db.putEvidence("handoff", "historical exact bytes 🐢");
    db.recordQaFailureHandoffPrepared({ handoffId: "historical-handoff", operationId: "historical-operation", runId: "run", ticketId: "T1", reviewAttemptId: seeded.attemptId, reportDigest: seeded.input.reportDigest, generation: 1, reviewedContentDigest: "source", reviewBasisDigest: "basis", handoffDigest: evidence, hostInstructionDigest: evidence });
    db.transitionQaFailureHandoff("historical-handoff", "delivery-uncertain", { detail: "legacy dispatch uncertainty" });
    db.setQaReportDisposition(seeded.record.reportOccurrenceId, "waived", "historical authorized waiver");
    db.close();
    downgradeFixture(root);
    const path = join(root, ".rafi/recovery.sqlite3");
    const beforeAudit = readFileSync(path);
    const audit = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("../../../scripts/audit-qa-handback.mjs", import.meta.url)), root], { encoding: "utf8" }));
    assert.equal(audit.schemaVersion, 2);
    assert.equal(audit.counts.formattingCorrections, null);
    assert.equal(audit.handoffs[0].activeSeconds, null);
    assert.deepEqual(readFileSync(path), beforeAudit);
    for (let restart = 0; restart < 2; restart++) {
      const migrated = new WorkflowDb(root);
      try {
        assert.equal(migrated.qaReport(seeded.input.reportDigest)?.reportOccurrenceId, reportOccurrenceId("run", "T1", 1));
        assert.equal(migrated.qaReport(seeded.input.reportDigest)?.disposition, "waived");
        assert.equal(migrated.qaFailureHandoff("historical-handoff")?.operationId, "historical-operation");
        assert.equal(migrated.qaFailureHandoff("historical-handoff")?.state, "delivery-uncertain");
        assert.equal(migrated.getEvidence(evidence)?.toString(), "historical exact bytes 🐢");
      } finally { migrated.close(); }
    }
    const raw = new Database(join(root, ".rafi/recovery.sqlite3"));
    try {
      assert.deepEqual(raw.pragma("foreign_key_check"), []);
      assert.equal(raw.pragma("integrity_check", { simple: true }), "ok");
      assert.throws(() => raw.prepare("UPDATE workflow_runs SET status='running' WHERE run_id='run'").run(), /rafi_writer_protocol/);
      assert.equal((raw.prepare("SELECT finding_id FROM qa_findings").get() as { finding_id: string }).finding_id, `finding:${seeded.attemptId}`);
    } finally { raw.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ambiguous legacy lineage aborts migration transactionally and remains repairable", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-migrate-fault-"));
  try {
    const db = new WorkflowDb(root); seed(db, "run", "T1", 1); db.close();
    downgradeFixture(root);
    const path = join(root, ".rafi/recovery.sqlite3");
    const raw = new Database(path);
    raw.prepare("UPDATE qa_review_attempts SET report_digest='wrong'").run();
    raw.close();
    for (let retry = 0; retry < 2; retry++) assert.throws(() => new WorkflowDb(root), /lineage repair/);
    const inspect = new Database(path);
    try {
      assert.equal(inspect.pragma("user_version", { simple: true }), 2);
      assert.equal((inspect.prepare("SELECT count(*) n FROM qa_reports").get() as { n: number }).n, 1);
      assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v3'").all().length, 0);
      inspect.prepare("UPDATE qa_review_attempts SET report_digest=(SELECT report_digest FROM qa_reports)").run();
    } finally { inspect.close(); }
    const repaired = new WorkflowDb(root); repaired.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("interruption after copying a migration table rolls back and retries safely", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-migrate-interrupted-"));
  try {
    const db = new WorkflowDb(root); const seeded = seed(db, "run", "T1", 1); db.close();
    downgradeFixture(root);
    const raw = new Database(join(root, ".rafi/recovery.sqlite3")); registerHandbackWriter(raw);
    try {
      assert.throws(() => migrateQaHandback(raw, { afterTableCopy: table => { if (table === "qa_findings") throw new Error("migration interruption"); } }), /migration interruption/);
      assert.equal(raw.pragma("user_version", { simple: true }), 2);
      assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v3'").all().length, 0);
      assert.equal((raw.prepare("SELECT count(*) n FROM qa_findings").get() as { n: number }).n, 1);
      assert.equal(raw.pragma("foreign_keys", { simple: true }), 1);
    } finally { raw.close(); }
    const migrated = new WorkflowDb(root);
    try { assert.equal(migrated.qaReport(seeded.input.reportDigest)?.reportOccurrenceId, seeded.record.reportOccurrenceId); }
    finally { migrated.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const defect of ["foreign-review", "missing-response-evidence", "foreign-receipt-scope"] as const) test(`legacy receipt migration rejects ${defect} without inventing occurrence ownership`, () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-migrate-receipt-"));
  try {
    const db = new WorkflowDb(root);
    const seeded = seed(db, "run", "T1", 1);
    const evidence = db.putEvidence("qa", "original provider response");
    db.beginQaReviewAttempt({ attemptId: "other-review", runId: "run", ticketId: "T1", reviewNumber: 2, cycle: 2, remediationGeneration: 1, sourceDigest: "source" });
    db.finishQaReviewAttempt("other-review", { status: "failed", reportDigest: seeded.input.reportDigest });
    db.beginQaRemediationAttempt({ attemptId: "operation", runId: "run", ticketId: "T1", reviewAttemptId: seeded.attemptId, generation: 1, mode: "validated-report", requestDigest: evidence });
    const receipt = { version: 2 as const, operationId: "operation", runId: "run", ticketId: "T1", reportDigest: seeded.input.reportDigest, sourceStateDigest: "source", requestDigest: evidence, responseDigest: evidence, summaryDigest: evidence, providerTurnId: "turn", completedAt: new Date().toISOString() };
    db.recordBuilderRemediationReceipt(receipt);
    db.close(); downgradeFixture(root);
    const path = join(root, ".rafi/recovery.sqlite3");
    const raw = new Database(path);
    if (defect === "foreign-review") raw.prepare("UPDATE qa_remediation_attempts SET review_attempt_id='other-review'").run();
    else raw.prepare("UPDATE qa_remediation_receipts SET receipt_json=?").run(JSON.stringify({ ...receipt, ...(defect === "missing-response-evidence" ? { responseDigest: "f".repeat(64) } : { ticketId: "foreign" }) }));
    raw.close();
    assert.throws(() => new WorkflowDb(root), /QA migration.*(?:receipt|evidence|attempt)/);
    const inspect = new Database(path);
    try {
      assert.equal(inspect.pragma("user_version", { simple: true }), 2);
      assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v3'").all().length, 0);
      inspect.prepare("UPDATE qa_remediation_attempts SET review_attempt_id=?").run(seeded.attemptId);
      inspect.prepare("UPDATE qa_remediation_receipts SET receipt_json=?").run(JSON.stringify(receipt));
    } finally { inspect.close(); }
    const migrated = new WorkflowDb(root);
    try { assert.deepEqual(migrated.builderRemediationReceipt("operation"), receipt); assert.equal(migrated.getEvidence(evidence)?.toString(), "original provider response"); }
    finally { migrated.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
