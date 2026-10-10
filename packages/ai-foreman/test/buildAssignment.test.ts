import { admitFixtureWork, seedQaReceipt } from "./helpers/workAdmission.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginBuildAssignment, finishBuildAssignment, assertBuildAssignmentReconciled } from "../src/buildAssignment.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { BuildInterventionControl, parseManagerAction } from "../src/buildInterventions.js";
import { qaDigest } from "../src/qaProtocolV2.js";

test("assignment conflict retains large existing and changed product files within evidence item limits", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-assignment-large-"));
  try {
    const path = join(root, "asset.bin");
    const before = Buffer.alloc(20 * 1024 * 1024, 42);
    const after = Buffer.alloc(20 * 1024 * 1024, 43);
    writeFileSync(path, before);
    const setup = new WorkflowDb(root);
    try {admitFixtureWork(setup,"run","T002");} finally {setup.close();}
    const assignment = beginBuildAssignment(root, "run", "T002", root, "Implement T002");
    writeFileSync(path, after);
    const response = 'STEP_STATUS: done | ticket="T001" summary="foreign work"';
    assert.match(finishBuildAssignment(root, assignment, { text: response, isError: false, numTurns: 1, costUsd: 0 }, { kind: "done", ticket: "T001" })!, /assigned to T002/);
    const db = new WorkflowDb(root);
    try {
      const operation = db.operations("run")[0]!;
      type Retained = { untracked: Array<{ path: string; evidenceChunks: string[]; byteLength: number }> };
      const original = (operation.intent as { before: Retained }).before.untracked.find(file => file.path === "asset.bin")!;
      const changed = (operation.result as { after: Retained }).after.untracked.find(file => file.path === "asset.bin")!;
      for (const [record, bytes] of [[original, before], [changed, after]] as const) {
        assert.equal(record.byteLength, bytes.length);
        assert.equal(record.evidenceChunks.length, 3);
        assert.deepEqual(Buffer.concat(record.evidenceChunks.map(digest => db.getEvidence(digest)!)), bytes);
      }
      assert.equal(db.getEvidence((operation.result as { responseDigest: string }).responseDigest)!.toString(), response);
      assert.deepEqual(readFileSync(path), after);
    } finally { db.close(); }
    assert.throws(() => assertBuildAssignmentReconciled(root, "run"), /requires assignment reconciliation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("completed assignments in removed worktrees do not block another run",()=>{
  const root=mkdtempSync(join(tmpdir(),"assignment-project-")),oldWorktree=mkdtempSync(join(tmpdir(),"assignment-old-worktree-"));
  try {
    const db=new WorkflowDb(root);try{admitFixtureWork(db,"old","T1");admitFixtureWork(db,"new","T2");}finally{db.close();}
    const assignment=beginBuildAssignment(root,"old","T1",oldWorktree,"Implement T1");
    finishBuildAssignment(root,assignment,{text:'STEP_STATUS: done | ticket="T1" summary="done"',isError:false,numTurns:1,costUsd:0,turnId:"completed-turn"},{kind:"done",ticket:"T1"});
    rmSync(oldWorktree,{recursive:true,force:true});
    assert.doesNotThrow(()=>assertBuildAssignmentReconciled(root,"new",root));
  }finally{rmSync(root,{recursive:true,force:true});rmSync(oldWorktree,{recursive:true,force:true});}
});

test("an unresolved assignment in the same canonical workspace fences another run",()=>{
  const root=mkdtempSync(join(tmpdir(),"assignment-shared-workspace-"));
  try {
    const db=new WorkflowDb(root);try{admitFixtureWork(db,"old","T1");admitFixtureWork(db,"new","T2");}finally{db.close();}
    beginBuildAssignment(root,"old","T1",root,"Implement T1");
    assert.throws(()=>assertBuildAssignmentReconciled(root,"new",root),/requires assignment reconciliation/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

for (const boundary of ["budget", "requirements", "withdraw", "rollback"] as const) test(`Builder follow-up ${boundary} leaves no partial reservation or invalidated pass`,()=>{
  const root=mkdtempSync(join(tmpdir(),"assignment-followup-"));
  let certificateId:string, authorizationId:string|undefined;
  try {
    writeFileSync(join(root,"source.txt"),"completed source\n");
    const db=new WorkflowDb(root);
    try {
      admitFixtureWork(db,"run","T1");
      let head=db.qaTicketHead("run","T1");
      head=db.transitionQa("run","T1",head.revision,{type:"source-frozen",sourceStateDigest:"source"});
      head=db.transitionQa("run","T1",head.revision,{type:"review-ready",reviewBasisDigest:"basis",sessionGeneration:0});
      head=db.transitionQa("run","T1",head.revision,{type:"turn-intended",slot:"initial"});
      db.beginQaReviewAttempt({attemptId:"passed-review",runId:"run",ticketId:"T1",reviewNumber:head.reviewNumber,cycle:1,remediationGeneration:0,sourceDigest:"source"});
      db.finishQaReviewAttempt("passed-review",{status:"passed"});
      const certificate=db.commitQaPass({runId:"run",ticketId:"T1",qaRevision:head.revision+1,sourceStateDigest:"source",reviewBasisDigest:"basis",turnReceiptDigest:seedQaReceipt(db,"run","T1",head.reviewNumber,"source","basis")},head.revision);
      certificateId=certificate.certificateId;
      const control=new BuildInterventionControl(root,"run","T1");
      try {
        const user="/guide-builder run T1 Check empty input",record=control.enqueue(parseManagerAction(user,"guide",0)!,user);
        if(boundary==="withdraw") {const user=`/withdraw run T1 ${record.instructionId}`;control.enqueue(parseManagerAction(user,"withdraw",control.revision())!,user);}
        if(boundary==="rollback") {const user="/request-attempt run T1 One follow-up";control.enqueue(parseManagerAction(user,"extra",control.revision())!,user);authorizationId=db.consumeInstructionControls("run","T1","attempts");assert.ok(authorizationId);}
      }finally{control.close();}
    }finally{db.close();}
    const original=WorkflowDb.prototype.planOperation;
    if(boundary==="rollback")WorkflowDb.prototype.planOperation=function(){throw new Error("Injected failure after budget and certificate writes");};
    try {assert.throws(()=>beginBuildAssignment(root,"run","T1",root,"Follow waiting guidance",{reviewAttemptId:"passed-review",requirementsDigest:boundary==="requirements"?"foreign":qaDigest("admitted-requirements",{id:"T1"}),maximum:boundary==="budget"?0:1,authorizationId}),/budget exhausted|requirements changed|No eligible|Injected failure/);}finally{WorkflowDb.prototype.planOperation=original;}
    const check=new WorkflowDb(root);
    try {
      assert.equal(check.qaTicketHead("run","T1").state,"passed");assert.equal(check.qaAutomaticRemediationCount("run","T1"),0);assert.equal(check.operations("run").length,0);
      if(authorizationId)assert.equal(check.consumeInstructionControls("run","T1","attempts"),authorizationId);
      check.consumeQaPassCertificate("run","T1",certificateId!,"unchanged-pass");
    }finally{check.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});
