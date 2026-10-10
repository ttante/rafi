import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { WorkflowDb } from "../src/workflowDb.js";

test("admission is explicit, immutable, run-scoped and survives completion", () => {
  const root = mkdtempSync(join(tmpdir(), "work-admission-"));
  const db = new WorkflowDb(root);
  try {
    db.ensureRun("one"); db.ensureRun("two");
    assert.throws(() => db.assertAdmittedWork("one", "T001"), /not admitted/);
    const input = {runId:"one",kind:"ticket" as const,ticketId:"T001",definition:{acceptance:["A"]},approvalId:"approval",scopeRevision:"revision",provenance:{userTurn:"Build T001",reason:"explicit selected work"}};
    const first = db.admitWork(input);
    assert.deepEqual(db.admitWork(input), first);
    assert.throws(() => db.assertAdmittedWork("two", "T001"), /not admitted/);
    db.transition("one", {status:"completed",checkpoint:"complete"});
    assert.deepEqual(db.assertAdmittedWork("one","T001"), first);
    assert.throws(() => db.admitWork({...input,definition:{acceptance:["B"]}}), /nonterminal/);
    const raw = new Database(db.path);
    try {
      raw.function("rafi_writer_protocol", () => 3);
      assert.throws(() => raw.prepare("UPDATE build_project_identity SET canonical_root='foreign'").run(), /incompatible/);
      raw.function("rafi_writer_protocol", () => 4);
      raw.function("rafi_work_authority", () => 0);
      assert.throws(() => raw.prepare("UPDATE build_work_scope SET state='quarantined'").run(), /authority/);
      assert.throws(() => raw.prepare("DELETE FROM build_work_admissions").run(), /immutable|authority/);
    } finally { raw.close(); }
  } finally { db.close(); rmSync(root,{recursive:true,force:true}); }
});

test("synthetic work has a frozen opaque identity and cannot alias a ticket", () => {
  const root = mkdtempSync(join(tmpdir(), "synthetic-admission-"));
  const db = new WorkflowDb(root);
  try {
    db.ensureRun("run");
    const input = {runId:"run",kind:"synthetic" as const,definition:{summary:"explicit unticketed work"},approvalId:"a",scopeRevision:"r",provenance:{userTurn:"Implement this unticketed task",reason:"explicit unticketed authorization"}};
    const admission = db.admitWork(input);
    assert.match(admission.workId, /^synthetic:/);
    assert.deepEqual(db.admitWork({...input,workId:admission.workId}),admission);
    assert.throws(() => db.admitWork({...input,kind:"ticket",ticketId:admission.workId}), /identity/);
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});


test("direct SQL cannot move admitted QA rows or attach evidence to another parent",()=>{
  const root=mkdtempSync(join(tmpdir(),"work-sql-guards-"));const db=new WorkflowDb(root);
  try {
    for(const runId of ["one","two"]) {db.ensureRun(runId);db.admitWork({runId,kind:"ticket",ticketId:"T1",definition:{id:"T1"},approvalId:"a",scopeRevision:"r",provenance:{userTurn:"Build T1",reason:"Explicit scope"}});db.beginQaReviewAttempt({runId,ticketId:"T1",attemptId:runId,reviewNumber:1,cycle:1,remediationGeneration:0,sourceDigest:"source"});}
    const raw=(db as unknown as {db:import("better-sqlite3").Database}).db;
    assert.throws(()=>raw.prepare("UPDATE qa_review_attempts SET run_id='two' WHERE attempt_id='one'").run(),/immutable/);
    assert.throws(()=>db.beginQaRemediationAttempt({attemptId:"wrong-parent",runId:"one",ticketId:"T1",reviewAttemptId:"two",generation:1,mode:"validated-report",requestDigest:"request"}),/parent ownership/);
    db.finishQaReviewAttempt("one",{status:"failed",reportDigest:"report"});
    const report=db.recordQaReport({runId:"one",ticketId:"T1",reviewNumber:1,sourceStateDigest:"source",reviewBasisDigest:"basis",reportDigest:"report",report:{version:1,summary:"failed",checks_run:[],findings:[],observations:[]}},[]);
    assert.throws(()=>raw.prepare("INSERT INTO qa_findings(finding_id,report_digest,report_occurrence_id,ordinal,created_at) VALUES('foreign','wrong',?,0,'now')").run(report.reportOccurrenceId),/digest ownership|FOREIGN KEY/);
    assert.throws(()=>db.issueQaPassCertificate({runId:"two",ticketId:"T1",qaRevision:1,sourceStateDigest:"source",reviewBasisDigest:"basis",turnReceiptDigest:"foreign-turn"}),/completion receipt ownership/);
    const tables=raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'qa_%'").all() as Array<{name:string}>;
    for(const {name} of tables) {
      const columns=raw.prepare(`PRAGMA table_info(${name})`).all() as Array<{name:string}>;
      if(!columns.some(column=>column.name==="run_id")||!columns.some(column=>column.name==="ticket_id"))continue;
      for(const action of ["INSERT","UPDATE","DELETE"])assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(`work_v4_scope_${name}_${action}`),`${name} ${action} lacks admission protection`);
    }
    assert.equal(raw.pragma("integrity_check",{simple:true}),"ok");assert.deepEqual(raw.pragma("foreign_key_check"),[]);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
