import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir,hostname} from "node:os";
import {join} from "node:path";
import {stringify} from "yaml";
import type Database from "better-sqlite3";
import {cmdInit} from "../src/tickets/commands.js";
import {loadTickets} from "../src/tickets/ticketLoader.js";
import {createBuildRun,releaseBuildLease,persistBuildSession} from "../src/buildRuns.js";
import {createProviderSessionRef} from "../src/sessionIdentity.js";
import {WorkflowDb} from "../src/workflowDb.js";
import {captureFrozenQaSource} from "../src/qaSnapshot.js";
import {qaDigest,type QaTurnIntentV2} from "../src/qaProtocolV2.js";
import {processStartIdentity} from "../src/processIdentity.js";

function fixture(confinementMode="read-only", unknownResult: unknown = {unknown:"retained"}) {
 const root=mkdtempSync(join(tmpdir(),"rafi-qa-resume-"));cmdInit(root,{});
 const definition={id:"T001",order:1,title:"Feature",area:"tests",priority:"P2",size:"XS",risk:"Low",depends_on:[],summary:"Feature",acceptance:["Feature works"],required_tests:[],likely_files:["feature.txt"],notes:"Fixture"};
 writeFileSync(join(root,".tickets/tickets.yaml"),stringify({tickets:[definition]}));writeFileSync(join(root,"feature.txt"),"implementation\n");
 const git=(args:string[])=>execFileSync("git",args,{cwd:root,stdio:"pipe"});git(["init","-q","-b","main"]);git(["config","user.email","fixture@example.test"]);git(["config","user.name","Fixture"]);git(["add","."]);git(["commit","-qm","Baseline"]);
 let run=createBuildRun({repositoryRoot:root,tickets:["T001"],builder:{role:"builder",source:"project",make:"codex",model:"default",reasoning:"default",fast:false},qa:{role:"qa",source:"project",make:"codex",model:"default",reasoning:"default",fast:false}});
 const ref={...createProviderSessionRef({provider:"codex",sessionId:"fixture-qa",role:"qa",stream:"qa",cwd:root,configRoot:root,source:"observed"}),validatedAt:new Date().toISOString()};run=persistBuildSession(root,run,"qa",ref);
 const db=new WorkflowDb(root);db.admitWork({runId:run.runId,kind:"ticket",ticketId:"T001",definition:loadTickets(join(root,".tickets/tickets.yaml"))[0],approvalId:"approved",scopeRevision:"scope",provenance:{userTurn:"Approved T001",reason:"Fixture"}});db.claimInitialRoleLease(run.runId,"qa",ref);
 const deadPid=Number(execFileSync(process.execPath,["-e","process.stdout.write(String(process.pid))"],{encoding:"utf8"}));db.transition(run.runId,{checkpoint:"qa-review",event:"worker_started",payload:{workerPid:deadPid,processStart:"dead-fixture",host:hostname()}});
 const source=captureFrozenQaSource(root);const fields={version:2,sourceMode:confinementMode,scratchMode:"isolated",networkMode:"disabled",settingsSources:"none",environmentDigest:"e".repeat(64),policyDigest:"a".repeat(64)};const confinement={...fields,digest:qaDigest("qa-confinement",fields)};
 const basisFields={version:2 as const,ticketDigest:qaDigest("ticket",loadTickets(join(root,".tickets/tickets.yaml"))[0]),instructionDigest:"instruction",roleInstructionsDigest:"role",skillsDigest:"skills",runtimeDigest:"runtime",validationChecklistDigest:"check",confinementDigest:confinement.digest};const basis={...basisFields,digest:qaDigest("review-basis-fields",basisFields)};
 const head=db.commitQaReviewReady({version:2,runId:run.runId,ticketId:"T001",originDigest:source.originDigest,contentDigest:source.contentDigest,digest:source.digest,capturedAt:source.capturedAt,paths:source.pathInventory},basis,ref,confinement,{attemptId:"review-1",cycle:1,remediationGeneration:0},0);
 const turn:QaTurnIntentV2={version:2,operationId:"qa-turn",runId:run.runId,ticketId:"T001",reviewNumber:head.reviewNumber,sessionGeneration:ref.generation,slot:"initial",sourceStateDigest:source.digest,reviewBasisDigest:basis.digest,providerSession:{version:2,provider:ref.provider,sessionId:ref.sessionId,role:"qa",stream:"qa",generation:ref.generation,cwd:ref.cwd!,configRoot:ref.configRoot!,createdAt:ref.createdAt,validatedAt:ref.validatedAt},instructionDigest:"raw-instruction-digest",intendedAt:new Date().toISOString()};db.commitQaTurnIntent(turn,head.revision);
 db.planOperation({runId:run.runId,idempotencyKey:"qa-dispatch",kind:"provider-dispatch",intent:{role:"qa",sessionRef:ref,instructionDigest:turn.instructionDigest}});db.updateOperation("qa-dispatch","in_progress");db.updateOperation("qa-dispatch","uncertain",{result:unknownResult});db.close();run=releaseBuildLease(root,run,"recoverable");
 const recovery=new WorkflowDb(root);const admission=recovery.acquireBuildRecoveryAdmission(run.runId);const lease=recovery.acquireLease(run.runId);
 return {root,run,ref,recovery,close(){recovery.releaseLease(lease);recovery.releaseBuildAdmission(admission);recovery.close();rmSync(root,{recursive:true,force:true});}};
}

test("interrupted read-only QA requires native quiescence and never invents a pass, replay or Builder mutation",()=>{const f=fixture();try{const before=f.recovery.qaTicketHead(f.run.runId,"T001");
 if(process.platform==="win32") {
  assert.throws(()=>f.recovery.reconcileInterruptedQaDispatch(f.run.runId,"T001"),/verified stopped/);
  assert.equal(f.recovery.operation("qa-dispatch")!.status,"uncertain");
  assert.deepEqual(f.recovery.operation("qa-dispatch")!.result,{unknown:"retained"});
  assert.deepEqual(f.recovery.qaTicketHead(f.run.runId,"T001"),before);
  return;
 }
 assert.equal(f.recovery.reconcileInterruptedQaDispatch(f.run.runId,"T001"),true);const op=f.recovery.operation("qa-dispatch")!;assert.equal(op.status,"failed");assert.equal((op.result as any).outcomeUnknown,true);assert.equal((op.result as any).providerReplayAuthorized,false);assert.deepEqual((op.result as any).priorResult,{unknown:"retained"});assert.deepEqual(f.recovery.qaTicketHead(f.run.runId,"T001"),before);assert.equal(f.recovery.reconcileInterruptedQaDispatch(f.run.runId,"T001"),false);}finally{f.close();}});

test("interrupted QA reconciles an exact recorded host-completed turn with unknown provider outcome without accepting it",()=>{const f=fixture("read-only",{isError:true,failure:{dispatchState:"unknown"}});try{
 const receipt={dispatch:"completed",hostInterrupted:true};
 (f.recovery as any).db.prepare("UPDATE qa_turns SET status='completed',receipt_json=? WHERE operation_id='qa-turn'").run(JSON.stringify(receipt));
 const before=f.recovery.qaTicketHead(f.run.runId,"T001");
 if(process.platform==="win32"){assert.throws(()=>f.recovery.reconcileInterruptedQaDispatch(f.run.runId,"T001"));return;}
 assert.equal(f.recovery.reconcileInterruptedQaDispatch(f.run.runId,"T001"),true);
 assert.deepEqual(f.recovery.qaTicketHead(f.run.runId,"T001"),before);
 assert.deepEqual(JSON.parse((f.recovery as any).db.prepare("SELECT receipt_json FROM qa_turns WHERE operation_id='qa-turn'").get().receipt_json),receipt);
 assert.equal((f.recovery.operation("qa-dispatch")!.result as any).outcomeUnknown,true);
}finally{f.close();}});

test("a completed QA turn without a typed unknown provider failure cannot be reinterpreted",()=>{const f=fixture();try{
 (f.recovery as any).db.prepare("UPDATE qa_turns SET status='completed' WHERE operation_id='qa-turn'").run();
 assert.throws(()=>f.recovery.reconcileInterruptedQaDispatch(f.run.runId,"T001"));
 assert.equal(f.recovery.operation("qa-dispatch")!.status,"uncertain");
}finally{f.close();}});

for(const condition of ["writable-confinement","live-worker","changed-requirements","foreign-dispatch","builder-unknown","completed","branch"] as const)test(`interrupted QA blocks ${condition} without retiring its unknown receipt`,()=>{const f=fixture(condition==="writable-confinement"?"writable":"read-only");try{
 if(condition==="live-worker")f.recovery.transition(f.run.runId,{checkpoint:"qa-review",event:"worker_started",payload:{workerPid:process.pid,processStart:processStartIdentity(),host:hostname()}});
 if(condition==="changed-requirements"){const tickets=loadTickets(join(f.root,".tickets/tickets.yaml"));tickets[0].acceptance.push("New scope");writeFileSync(join(f.root,".tickets/tickets.yaml"),stringify({tickets}));}
 if(condition==="foreign-dispatch"||condition==="builder-unknown"){f.recovery.planOperation({runId:f.run.runId,idempotencyKey:"other-dispatch",kind:"provider-dispatch",intent:{role:condition==="builder-unknown"?"builder":"qa",sessionRef:{...f.ref,sessionId:"foreign"},instructionDigest:"wrong"}});f.recovery.updateOperation("other-dispatch","in_progress");f.recovery.updateOperation("other-dispatch","uncertain");}
 if(condition==="completed"){const state=f.recovery.getRun(f.run.runId)!.state;f.recovery.transition(f.run.runId,{checkpoint:"completed",state:{...state,progress:{...(state.progress as object),completedTickets:["T001"]}}});}
 if(condition==="branch")execFileSync("git",["switch","-qc","other"],{cwd:f.root,stdio:"pipe"});
 assert.throws(()=>f.recovery.reconcileInterruptedQaDispatch(f.run.runId,"T001"));assert.equal(f.recovery.operation("qa-dispatch")!.status,"uncertain");
 }finally{f.close();}});

for (const condition of ["confinement-checksum","basis-checksum","missing-source","wrong-generation","wrong-config-root","wrong-role","wrong-instruction","wrong-turn-source"] as const) test(`interrupted QA preserves uncertainty for invalid ${condition} proof`,()=>{
 const f=fixture();
 try {
  // Fault injection uses the already-authorized fixture connection, preserving
  // schema writer guards rather than weakening production persistence.
  const sql=(f.recovery as unknown as {db:Database.Database}).db;
  {
   const mutate=(table:string,column:string,change:(value:any)=>void)=>{
    const row=sql.prepare(`SELECT ${column} AS value FROM ${table} WHERE run_id=?`).get(f.run.runId) as {value:string};
    const value=JSON.parse(row.value);change(value);sql.prepare(`UPDATE ${table} SET ${column}=? WHERE run_id=?`).run(JSON.stringify(value),f.run.runId);
   };
   if(condition==="confinement-checksum")mutate("qa_sessions","session_json",value=>{value.confinement.digest="0".repeat(64);});
   if(condition==="basis-checksum")mutate("qa_review_bases","basis_json",value=>{value.validationChecklistDigest="changed-without-rebinding";});
   if(condition==="missing-source")sql.prepare("DELETE FROM qa_source_states WHERE run_id=?").run(f.run.runId);
   if(condition==="wrong-generation")mutate("operation_journal","intent_json",value=>{value.sessionRef.generation+=1;});
   if(condition==="wrong-config-root")mutate("operation_journal","intent_json",value=>{value.sessionRef.configRoot=tmpdir();});
   if(condition==="wrong-role")mutate("operation_journal","intent_json",value=>{value.sessionRef.role="builder";});
   if(condition==="wrong-instruction")mutate("operation_journal","intent_json",value=>{value.instructionDigest="foreign-turn";});
   if(condition==="wrong-turn-source")mutate("qa_turns","intent_json",value=>{value.sourceStateDigest="foreign-source";});
  }
  assert.throws(()=>f.recovery.reconcileInterruptedQaDispatch(f.run.runId,"T001"));
  assert.equal(f.recovery.operation("qa-dispatch")!.status,"uncertain");
  assert.deepEqual(f.recovery.operation("qa-dispatch")!.result,{unknown:"retained"});
 }finally{f.close();}
});
