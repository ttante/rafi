import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createBuildRun, releaseBuildLease, readBuildRuns } from "../src/buildRuns.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { prepareOwnershipRepair, repairOwnership } from "../src/buildOwnershipRepair.js";
import { assessBuildOwnership } from "../src/buildOwnershipReconciliation.js";
import { buildScopeRevision } from "../src/buildApproval.js";
import { beginBuildAssignment, finishBuildAssignment } from "../src/buildAssignment.js";
import { cmdInit } from "../src/tickets/commands.js";
import { saveTickets } from "../src/tickets/ticketLoader.js";
import { admitFixtureWork, seedQaReceipt } from "./helpers/workAdmission.js";
import { makeLegacyWorkFixture } from "./helpers/legacyWork.js";
import type { BuildOwnershipRepairV1 } from "../src/buildWorkReconciliation.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";

const ticket:TicketDef={id:"T1",order:1,title:"Guard",area:"core",priority:"P2",size:"S",risk:"Low",depends_on:[],summary:"Add a guard",acceptance:["guard"],required_tests:["inspect"],likely_files:["source.txt"]};
function fixture(proven=false,returnedTicket="T1",qaState?:"passed"|"completed"|"waived") {
  const root=mkdtempSync(join(tmpdir(),"ownership-repair-"));
  execFileSync("git",["init","-q",root]);cmdInit(root,{});saveTickets(join(root,".tickets/tickets.yaml"),[ticket]);writeFileSync(join(root,"source.txt"),"base\n");
  execFileSync("git",["add","."],{cwd:root});execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.test","commit","-qm","base"],{cwd:root});
  const run=createBuildRun({runId:"run",repositoryRoot:root,tickets:["T1"]});
  let db=new WorkflowDb(root);admitFixtureWork(db,"run","T1",ticket);
  const decision=db.ensureHumanDecision({runId:"run",decisionKey:`approval:${buildScopeRevision(root)}`,interruptionId:"approval",prompt:"Approve T1",choices:[{id:"proceed",label:"Proceed"}]});
  if(proven)db.answerHumanDecision("run",decision.decisionId,"proceed");
  db.transition("run",{checkpoint:"ticket-selected",event:"ticket-selected",payload:{ticketId:"T1"}});db.close();
  const assignment=beginBuildAssignment(root,"run","T1",root,"Implement T1");writeFileSync(join(root,"source.txt"),"preserved guard\n");
  const session={version:1 as const,provider:"codex" as const,sessionId:"scoped-builder",role:"builder" as const,stream:"builder",generation:0,cwd:realpathSync(root),configRoot:realpathSync(root),ticketId:"T1",source:"observed" as const,createdAt:new Date().toISOString(),validatedAt:new Date().toISOString()};
  db=new WorkflowDb(root);db.recordSession("run","builder","builder",session,"started",{role:"builder",source:"project",make:"codex",model:"default",reasoning:"default",fast:false,session_strategy:"compact",settings_revision:1,display_session_cost:false,auto_compact_threshold_percent:65,compact_maximum:1});db.close();
  finishBuildAssignment(root,assignment,{text:`STEP_STATUS: done | ticket="${returnedTicket}" summary="guard"`,providerMetadata:{provider:"codex",sessionId:session.sessionId,sessionRef:session},isError:false,numTurns:1,costUsd:0,turnId:"builder-turn"},{kind:"done",ticket:returnedTicket});
  db=new WorkflowDb(root);db.beginQaReviewAttempt({attemptId:"review",runId:"run",ticketId:"T1",reviewNumber:1,cycle:1,remediationGeneration:0,sourceDigest:"legacy-source"});
  let certificateId: string | undefined;
  if(qaState) {
    let head=db.qaTicketHead("run","T1");
    if(qaState==="waived") {
      head=db.transitionQa("run","T1",head.revision,{type:"operator-menu"});
      db.transitionQa("run","T1",head.revision,{type:"waived"});
    } else {
      head=db.transitionQa("run","T1",head.revision,{type:"source-frozen",sourceStateDigest:"legacy-source"});
      head=db.transitionQa("run","T1",head.revision,{type:"review-ready",reviewBasisDigest:"basis",sessionGeneration:0});
      head=db.transitionQa("run","T1",head.revision,{type:"turn-intended",slot:"initial"});
      const certificate=db.issueQaPassCertificate({runId:"run",ticketId:"T1",qaRevision:head.revision+1,sourceStateDigest:"legacy-source",reviewBasisDigest:"basis",turnReceiptDigest:seedQaReceipt(db,"run","T1",head.reviewNumber,"legacy-source","basis")});certificateId=certificate.certificateId;
      head=db.transitionQa("run","T1",head.revision,{type:"review-passed",passCertificateId:certificateId});
      if(qaState==="completed") {
        head=db.beginQaFinalization({runId:"run",ticketId:"T1",certificateId,consumer:"fixture",expectedSourceStateDigest:"legacy-source",expectedGitTree:"tree",allowedProjectionPaths:[],expectedRevision:head.revision,operationId:"finalize"});
        db.completeQaFinalization("run","T1",head.revision,{completed:true});
      }
    }
  }
  const path=db.path;db.close();releaseBuildLease(root,run,"recoverable");makeLegacyWorkFixture(path);db=new WorkflowDb(root);db.close();
  return {root,certificateId,decisionId:decision.decisionId,close:()=>rmSync(root,{recursive:true,force:true})};
}

for(const state of ["passed","completed","waived"] as const)test(`repair of ${state} work accurately reports execution eligibility and retains history`,()=>{
  const f=fixture(false,"T1",state);
  try {
    const plan=prepareOwnershipRepair(f.root,"run","T1");
    const request:BuildOwnershipRepairV1={version:1,requestId:"repair-state",runId:"run",workId:"T1",choice:"authorize_mapped_work",expectedRevision:plan.expectedRevision,inspectedSourceDigest:plan.inspectedSourceDigest,scopeRevision:plan.scopeRevision,authorization:"Authorize inspected work",attestation:"Inspected preserved source",mapping:plan.requiredPaths.map(path=>({path,workId:"T1"}))};
    const receipt=repairOwnership(f.root,request,`/qa-repair ${JSON.stringify(request)}`);
    assert.equal(receipt.requiresFreshQa,state==="passed");
    assert.equal(receipt.executionReopened,false);
    const db=new WorkflowDb(f.root), authority=db.acquireBuildRecoveryAdmission("run"), lease=db.acquireLease("run");
    try {
      assert.equal(db.reconciliation(request.requestId)?.requiresFreshQa,state==="passed");
      const head=db.qaTicketHead("run","T1");assert.equal(head.state,state==="passed"?"operator-menu":state);
      if(f.certificateId)assert.throws(()=>db.consumeQaPassCertificate("run","T1",f.certificateId!,"old-pass"),/already been consumed/);
      if(state==="completed")assert.throws(()=>db.transitionQa("run","T1",head.revision,{type:"source-frozen",sourceStateDigest:"new-source"}),/invalid QA V2 transition/);
      assert.equal(db.qaReviewAttempts("run","T1").length,1);
    } finally {db.releaseLease(lease);db.releaseBuildAdmission(authority);db.close();}
    if(state==="passed") {
      const fresh=new WorkflowDb(f.root),authority=fresh.acquireBuildRecoveryAdmission("run"),lease=fresh.acquireLease("run");let certificateId:string;
      try {
        let head=fresh.qaTicketHead("run","T1");
        head=fresh.transitionQa("run","T1",head.revision,{type:"source-frozen",sourceStateDigest:"fresh-source"});
        head=fresh.transitionQa("run","T1",head.revision,{type:"review-ready",reviewBasisDigest:"fresh-basis",sessionGeneration:0});
        head=fresh.transitionQa("run","T1",head.revision,{type:"turn-intended",slot:"initial"});
        const certificate=fresh.issueQaPassCertificate({runId:"run",ticketId:"T1",qaRevision:head.revision+1,sourceStateDigest:"fresh-source",reviewBasisDigest:"fresh-basis",turnReceiptDigest:seedQaReceipt(fresh,"run","T1",head.reviewNumber,"fresh-source","fresh-basis")});certificateId=certificate.certificateId;
        fresh.transitionQa("run","T1",head.revision,{type:"review-passed",passCertificateId:certificateId});
      } finally {fresh.releaseLease(lease);fresh.releaseBuildAdmission(authority);fresh.close();}
      assert.deepEqual(repairOwnership(f.root,request,`/qa-repair ${JSON.stringify(request)}`),receipt);
      const check=new WorkflowDb(f.root),owner=check.acquireBuildRecoveryAdmission("run"),lock=check.acquireLease("run");
      try {assert.equal(check.qaTicketHead("run","T1").state,"passed");assert.ok(check.consumeQaPassCertificate("run","T1",certificateId!,"fresh-finalizer"));}
      finally {check.releaseLease(lock);check.releaseBuildAdmission(owner);check.close();}
    }
  } finally {f.close();}
});
for(const choice of ["link_provenance","authorize_mapped_work","quarantine"] as const)test(`legacy ${choice} retains source and evidence with one immutable operator outcome`,()=>{
  const f=fixture(choice==="link_provenance");
  try {
    const plan=prepareOwnershipRepair(f.root,"run","T1");
    const source=readFileSync(join(f.root,"source.txt"));
    const request:BuildOwnershipRepairV1={version:1,requestId:"repair",runId:"run",workId:"T1",expectedRevision:plan.expectedRevision,choice,inspectedSourceDigest:plan.inspectedSourceDigest,scopeRevision:plan.scopeRevision,authorization:"I authorize this inspected decision",attestation:"All preserved changes were inspected and mapped; fresh QA is required",mapping:plan.requiredPaths.map(path=>({path,workId:"T1"})),...(choice==="link_provenance"?{decisionId:f.decisionId}:{})};
    const command=`/qa-repair ${JSON.stringify(request)}`;
    const receipt=repairOwnership(f.root,request,command);
    assert.deepEqual(repairOwnership(f.root,request,command),receipt);
    assert.deepEqual(readFileSync(join(f.root,"source.txt")),source);
    const db=new WorkflowDb(f.root);
    try {assert.equal(db.qaReviewAttempts("run","T1").length,1);assert.equal(db.operations("run").filter(op=>op.kind==="build-assignment").length,1);assert.equal(receipt.providerReplayAuthorized,false);if(choice==="quarantine")assert.throws(()=>db.assertAdmittedWork("run","T1"),/not admitted/);else assert.equal(db.assertAdmittedWork("run","T1").workId,"T1");}finally{db.close();}
    if(choice!=="quarantine")assert.equal(assessBuildOwnership(f.root,"run").conflicts.length,0);
  }finally{f.close();}
});
test("stale source and incomplete historical provenance cannot authorize repaired membership",()=>{
  const f=fixture();try {
    const plan=prepareOwnershipRepair(f.root,"run","T1");
    const request:BuildOwnershipRepairV1={version:1,requestId:"repair",runId:"run",workId:"T1",expectedRevision:plan.expectedRevision,choice:"link_provenance",inspectedSourceDigest:plan.inspectedSourceDigest,scopeRevision:plan.scopeRevision,authorization:"Approve inspected mapping",attestation:"Inspected",mapping:plan.requiredPaths.map(path=>({path,workId:"T1"})),decisionId:f.decisionId};
    assert.throws(()=>repairOwnership(f.root,request,`/qa-repair ${JSON.stringify(request)}`),/provenance is incomplete/);
    writeFileSync(join(f.root,"source.txt"),"new uninspected change\n");
    request.choice="authorize_mapped_work";
    assert.throws(()=>repairOwnership(f.root,request,`/qa-repair ${JSON.stringify(request)}`),/changed/);
    const db=new WorkflowDb(f.root);try{assert.equal(db.reconciliation("repair"),undefined);assert.throws(()=>db.assertAdmittedWork("run","T1"),/not admitted/);}finally{db.close();}
  }finally{f.close();}
});
for(const boundary of ["afterDecision","afterMembership","afterLocalCommit","afterPublication"] as const)test(`ownership repair interruption at ${boundary} is repeatable without provider replay`,()=>{
  const f=fixture();try {
    const plan=prepareOwnershipRepair(f.root,"run","T1");
    const request:BuildOwnershipRepairV1={version:1,requestId:"repair",runId:"run",workId:"T1",expectedRevision:plan.expectedRevision,choice:"authorize_mapped_work",inspectedSourceDigest:plan.inspectedSourceDigest,scopeRevision:plan.scopeRevision,authorization:"Authorize this inspected scope",attestation:"All changes inspected",mapping:plan.requiredPaths.map(path=>({path,workId:"T1"}))};
    const command=`/qa-repair ${JSON.stringify(request)}`;
    assert.throws(()=>repairOwnership(f.root,request,command,{[boundary]:()=>{throw new Error("simulated crash");}}),/simulated crash/);
    const committed=["afterLocalCommit","afterPublication"].includes(boundary);
    const check=new WorkflowDb(f.root);try{assert.equal(Boolean(check.reconciliation("repair")),committed);}finally{check.close();}
    const receipt=repairOwnership(f.root,request,command);assert.deepEqual(repairOwnership(f.root,request,command),receipt);assert.ok(readBuildRuns(f.root).find(run=>run.runId==="run")?.tickets.includes("T1"));
    const db=new WorkflowDb(f.root);try{assert.equal(db.operations("run").filter(operation=>operation.kind==="build-assignment").length,1);assert.equal(db.qaReviewAttempts("run","T1").length,1);}finally{db.close();}
    assert.equal(readFileSync(join(f.root,"source.txt"),"utf8"),"preserved guard\n");
  }finally{f.close();}
});


test("wrong-ticket response repair preserves the returned bytes and source without admitting the foreign ticket",()=>{
  const f=fixture(false,"T2");try {
    const plan=prepareOwnershipRepair(f.root,"run","T1");
    assert.ok(plan.ownership.conflicts.some(item=>item.classification==="assignment_response_conflict"));
    const request:BuildOwnershipRepairV1={version:1,requestId:"mapped",runId:"run",workId:"T1",choice:"authorize_mapped_work",expectedRevision:plan.expectedRevision,inspectedSourceDigest:plan.inspectedSourceDigest,scopeRevision:plan.scopeRevision,authorization:"Authorize only the inspected T1 changes",attestation:"All changes mapped to T1 after inspection; require fresh QA",mapping:plan.requiredPaths.map(path=>({path,workId:"T1"}))};
    repairOwnership(f.root,request,`/qa-repair ${JSON.stringify(request)}`);
    const db=new WorkflowDb(f.root);try {
      assert.throws(()=>db.assertAdmittedWork("run","T2"),/not admitted/);
      const operation=db.operations("run").find(item=>item.kind==="build-assignment")!;
      const retained=operation.result as {responseDigest:string;rejection:string;replayForbidden:number};
      assert.ok(db.getEvidence(retained.responseDigest)?.toString().includes('ticket="T2"'));
      assert.ok(retained.rejection);assert.equal(retained.replayForbidden,1);
      assert.equal(db.qaReviewAttempts("run","T1").length,1);
    }finally{db.close();}
    assert.equal(readFileSync(join(f.root,"source.txt"),"utf8"),"preserved guard\n");
  }finally{f.close();}
});
