import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { WorkflowDb } from "../src/workflowDb.js";
import { registerHandbackWriter } from "../src/qaHandbackMigration.js";
import { migrateBuildWork } from "../src/buildWorkMigration.js";
import { makeLegacyWorkFixture } from "./helpers/legacyWork.js";
import { admitFixtureWork } from "./helpers/workAdmission.js";
import { readQaEvidenceSnapshot } from "../src/qaEvidenceReader.js";

for(const boundary of ["beforeGuards","beforeCommit"] as const)test(`work upgrade rollback at ${boundary} preserves the old schema and original bytes`,()=>{
  const root=mkdtempSync(join(tmpdir(),"work-migration-"));
  try {
    const seed=new WorkflowDb(root);admitFixtureWork(seed,"run","T1");
    const bytes=Buffer.from("exact retained QA bytes\n");const digest=seed.putEvidence("qa",bytes);const path=seed.path;seed.close();
    makeLegacyWorkFixture(path);
    let db=new Database(path);registerHandbackWriter(db);db.function("rafi_protocol_v3",()=>1);
    assert.throws(()=>migrateBuildWork(db,root,{[boundary]:()=>{throw new Error("simulated crash");}}),/simulated crash/);
    assert.equal(db.pragma("user_version",{simple:true}),3);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='build_work_scope'").get(),undefined);
    assert.deepEqual((db.prepare("SELECT content FROM content_refs WHERE digest=?").get(digest) as {content:Buffer}).content,bytes);
    db.close();db=new Database(path);registerHandbackWriter(db);db.function("rafi_work_authority",()=>0);db.function("rafi_protocol_v3",()=>1);
    migrateBuildWork(db,root);assert.equal(db.pragma("user_version",{simple:true}),4);
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");assert.deepEqual(db.pragma("foreign_key_check"),[]);db.close();
    const old=spawnSync(process.execPath,["--input-type=module","-e",`import Database from 'better-sqlite3';const db=new Database(process.argv[1]);db.function('rafi_writer_protocol',()=>3);db.function('rafi_protocol_v3',()=>1);db.function('rafi_build_writer_run',()=>"");db.function('rafi_build_writer_token',()=>"");db.function('rafi_build_lease_owner',()=>"");db.function('rafi_build_lease_generation',()=>-1);try{db.prepare("UPDATE workflow_runs SET checkpoint='old-writer'").run();process.exitCode=1;}catch(error){if(!String(error).includes('incompatible'))throw error;}finally{db.close();}`,path],{cwd:process.cwd(),encoding:"utf8"});
    assert.equal(old.status,0,old.stderr);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("legacy observed QA is quarantined rather than inferred as authorized work",()=>{
  const root=mkdtempSync(join(tmpdir(),"legacy-work-"));
  try {
    const db=new WorkflowDb(root);admitFixtureWork(db,"run","T1");
    db.beginQaReviewAttempt({attemptId:"review",runId:"run",ticketId:"T1",reviewNumber:1,cycle:1,remediationGeneration:0,sourceDigest:"source"});const path=db.path;db.close();makeLegacyWorkFixture(path);
    const readerBefore=readQaEvidenceSnapshot(root,"run");assert.equal(readerBefore.rows.qa_review_attempts?.length,1);
    const upgraded=new WorkflowDb(root);
    assert.throws(()=>upgraded.assertAdmittedWork("run","T1"),/not admitted/);
    assert.throws(()=>upgraded.finishQaReviewAttempt("review",{status:"interrupted"}),/not admitted/);
    upgraded.close();const after=readQaEvidenceSnapshot(root,"run");
    assert.equal(after.rows.build_work_scope?.[0]?.state,"quarantined");assert.equal(after.rows.qa_review_attempts?.[0]?.status,"started");
  }finally{rmSync(root,{recursive:true,force:true});}
});
