import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { cmdInit } from "../src/tickets/commands.js";
import { loadTickets } from "../src/tickets/ticketLoader.js";
import { createBuildRun, persistBuildSession, releaseBuildLease, readBuildRuns } from "../src/buildRuns.js";
import { createProviderSessionRef } from "../src/sessionIdentity.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { beginBuildAssignment, canReconcileInterruptedBuilderSource, prepareInterruptedBuilderSourceContinuation, assertInterruptedSourceSnapshot, assertBuildAssignmentReconciled } from "../src/buildAssignment.js";
import { HandoffService } from "../src/handoffs.js";
import { processStartIdentity } from "../src/processIdentity.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rafi-source-resume-"));
  cmdInit(root, {});
  const definitions = [1,2,3,4,5,6,7,8].map(order => ({id:`T00${order}`,order,title:`Feature ${order}`,area:"tests",priority:"P2",size:"XS",risk:"Low",depends_on:[],summary:`Feature ${order}`,acceptance:[`Feature ${order} works`],required_tests:[],likely_files:[`feature${order}.txt`],notes:"Fixture"}));
  writeFileSync(join(root,".tickets/tickets.yaml"),stringify({tickets:definitions}));
  writeFileSync(join(root,"feature4.txt"),"before\n");
  const git = (args:string[])=>execFileSync("git",args,{cwd:root,stdio:"pipe"});
  git(["init","-q","-b","main"]);git(["config","user.email","fixture@example.test"]);git(["config","user.name","Fixture"]);git(["add","."]);git(["commit","-qm","Source baseline"]);
  let run = createBuildRun({repositoryRoot:root,tickets:definitions.map(t=>t.id),builder:{role:"builder",source:"project",make:"codex",model:"default",reasoning:"default",fast:false},builderCapabilities:{requestedNetwork:false,grantedNetwork:false}});
  const ref = {...createProviderSessionRef({provider:"codex",sessionId:"fixture-builder",role:"builder",stream:"builder",cwd:root,configRoot:root,source:"observed"}),validatedAt:new Date().toISOString()};
  run=persistBuildSession(root,run,"builder",ref);
  const db = new WorkflowDb(root);
  for(const definition of definitions)db.admitWork({runId:run.runId,kind:"ticket",ticketId:definition.id,definition,approvalId:"fixture-approved",scopeRevision:"fixture-scope",provenance:{userTurn:`Fixture authorizes ${definition.id}`,reason:"Explicit approved test scope"}});
  db.claimInitialRoleLease(run.runId,"builder",ref);
  db.publishContinuityCheckpoint({runId:run.runId,role:"builder",delta:{version:1,decisions:[],constraints:[],discoveries:[],completedActions:["Earlier work remains recorded"],evidence:[],failures:[],blockers:[],openWork:["Finish T004"],nextAction:"Finish T004"},authoritativeStateRevision:0});
  const deadPid=Number(execFileSync(process.execPath,["-e","process.stdout.write(String(process.pid))"],{encoding:"utf8"}));
  db.transition(run.runId,{checkpoint:"ticket-selected",event:"worker_started",payload:{workerPid:deadPid,processStart:"fixture-incarnation",host:run.lease!.hostname,generation:1}});
  db.close();
  const assignment=beginBuildAssignment(root,run.runId,"T004",root,"Implement approved T004");
  const turn=new WorkflowDb(root);
  turn.planOperation({runId:run.runId,idempotencyKey:"interrupted-turn",kind:"provider-dispatch",intent:{role:"builder",sessionRef:ref,instructionDigest:"frozen-instruction"}});
  turn.updateOperation("interrupted-turn","in_progress");
  turn.appendContinuityEvent({runId:run.runId,role:"host",kind:"turn_started",payload:{role:"builder",dispatchId:"interrupted-turn"},authoritativeStateRevision:0});
  turn.updateOperation("interrupted-turn","uncertain",{result:{originalOutcome:"unknown",rawResponseDigest:"retained-original"}});
  turn.close();
  writeFileSync(join(root,"feature4.txt"),"partial preserved implementation\n");
  run=releaseBuildLease(root,run,"recoverable");
  const recovery=new WorkflowDb(root);const authority=recovery.acquireBuildRecoveryAdmission(run.runId);const lease=recovery.acquireLease(run.runId);
  return {root,run,ref,assignment,recovery,authority,lease,close(){recovery.releaseLease(lease);try{recovery.releaseBuildAdmission(authority);}finally{recovery.close();rmSync(root,{recursive:true,force:true});}}};
}

test("source continuation requires native quiescence and preserves unknown history without a completion claim",()=>{
  const f=fixture();try{
    if(process.platform==="win32") {
      assert.equal(canReconcileInterruptedBuilderSource(f.root,f.run.runId),true,"Structural candidacy does not grant process-quiescence authority");
      assert.throws(()=>prepareInterruptedBuilderSourceContinuation(f.root,f.run.runId),/verified stopped/);
      assert.equal(f.recovery.operation("interrupted-turn")!.status,"uncertain");
      assert.equal(f.recovery.operation(f.assignment.operationId)!.status,"in_progress");
      return;
    }
    assert.equal(canReconcileInterruptedBuilderSource(f.root,f.run.runId),true);
    const before=readFileSync(join(f.root,"feature4.txt"),"utf8");
    const receipt=prepareInterruptedBuilderSourceContinuation(f.root,f.run.runId);
    assert.deepEqual(receipt.ticketIds,["T004"]);
    const turn=f.recovery.operation("interrupted-turn")!;
    assert.equal(turn.status,"failed");assert.equal((turn.result as any).outcomeUnknown,true);assert.equal((turn.result as any).providerReplayAuthorized,false);
    assert.deepEqual((turn.result as any).priorResult,{originalOutcome:"unknown",rawResponseDigest:"retained-original"});
    assert.equal(f.recovery.hasUncheckpointedRoleTurn(f.run.runId,"builder"),true,"Historical provider compaction must stay unknown until a fresh handoff is accepted");
    assert.doesNotThrow(()=>assertBuildAssignmentReconciled(f.root,f.run.runId));
    assert.equal(readFileSync(join(f.root,"feature4.txt"),"utf8"),before);
    assert.deepEqual((f.recovery.getRun(f.run.runId)!.state.progress as any).completedTickets,[]);
    assert.deepEqual(f.recovery.latestContinuityCheckpoint(f.run.runId,"builder")!.delta.completedActions,[]);
    const handoff=new HandoffService(f.root).stage({runId:f.run.runId,role:"builder",reason:"Source-bound resume",predecessorSessionId:f.ref.sessionId,predecessorSessionRef:f.ref,compactionCount:0,compactMaximum:10});
    assert.ok(handoff.manifest.cumulative.completedActions.includes("Earlier work remains recorded"));
    assert.ok(handoff.manifest.cumulative.failures.some(text=>text.includes("unknown")));
    assert.equal(f.recovery.roleMutationLease(f.run.runId,"builder")?.providerSessionId,f.ref.sessionId,"Staging is not ownership transfer");
  }finally{f.close();}
});

for(const condition of ["live-worker","unknown-worker","network","changed-requirements","foreign-session","foreign-generation","foreign-worktree","foreign-branch","completed-ticket","second-assignment","pending-qa"] as const)test(`source continuation blocks ${condition} without retiring unknown work`,()=>{
  const f=fixture();try{
    if(condition==="live-worker")f.recovery.transition(f.run.runId,{checkpoint:"ticket-selected",event:"worker_started",payload:{workerPid:process.pid,processStart:processStartIdentity(),host:f.recovery.currentLease()?.host}});
    if(condition==="unknown-worker")f.recovery.transition(f.run.runId,{checkpoint:"ticket-selected",event:"worker_started",payload:{workerPid:process.pid,processStart:processStartIdentity(),host:"unavailable-other-host"}});
    if(condition==="network"||condition==="completed-ticket"){
      const state=f.recovery.getRun(f.run.runId)!.state;
      f.recovery.transition(f.run.runId,{checkpoint:"ticket-selected",state:{...state,...(condition==="network"?{builderCapabilities:{requestedNetwork:true,grantedNetwork:true}}:{progress:{...(state.progress as object),completedTickets:["T004"]}})}});
    }
    if(condition==="changed-requirements"){const definitions=loadTickets(join(f.root,".tickets/tickets.yaml"));definitions.find(t=>t.id==="T004")!.acceptance.push("Changed requirement");writeFileSync(join(f.root,".tickets/tickets.yaml"),stringify({tickets:definitions}));}
    if(condition==="foreign-session"){f.recovery.planOperation({runId:f.run.runId,idempotencyKey:"foreign",kind:"provider-dispatch",intent:{role:"builder",sessionRef:{...f.ref,sessionId:"foreign"}}});f.recovery.updateOperation("foreign","in_progress");}
    if(condition==="foreign-generation"){f.recovery.planOperation({runId:f.run.runId,idempotencyKey:"foreign-generation",kind:"provider-dispatch",intent:{role:"builder",sessionRef:{...f.ref,generation:1}}});f.recovery.updateOperation("foreign-generation","in_progress");}
    if(condition==="second-assignment"){f.recovery.planOperation({runId:f.run.runId,idempotencyKey:"second-assignment",kind:"build-assignment",intent:{ticketId:"T005"}});f.recovery.updateOperation("second-assignment","in_progress");}
    if(condition==="pending-qa"){f.recovery.planOperation({runId:f.run.runId,idempotencyKey:"pending-qa",kind:"provider-dispatch",intent:{role:"qa"}});f.recovery.updateOperation("pending-qa","in_progress");}
    if(condition==="foreign-worktree"){
      const state=f.recovery.getRun(f.run.runId)!.state;
      f.recovery.transition(f.run.runId,{checkpoint:"ticket-selected",state:{...state,repository:{...(state.repository as object),worktree:tmpdir()}}});
    }
    if(condition==="foreign-branch")execFileSync("git",["switch","-qc","unrelated-branch"],{cwd:f.root,stdio:"pipe"});
    assert.throws(()=>prepareInterruptedBuilderSourceContinuation(f.root,f.run.runId),/verified stopped|network-enabled|requirements changed|recorded Builder|another worktree|completed ticket|source-bound assignment authority|separate QA dispatch|current branch changed/);
    assert.equal(f.recovery.operation("interrupted-turn")!.status,"uncertain");
    assert.equal(f.recovery.operation(f.assignment.operationId)!.status,"in_progress");
  }finally{f.close();}
});

test("a dead worker with an executing orphan in its owned group cannot authorize source recovery",{skip:process.platform==="win32"?"POSIX detached-group fixture; negative-PID cleanup is unsupported on Windows":false},async()=>{
  const f=fixture();let group:number|undefined;
  try{
    const worker=spawn(process.execPath,["-e","const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();"],{detached:true,stdio:"ignore"});
    group=worker.pid;assert.ok(group && group>1);
    const code=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>{worker.kill("SIGKILL");reject(new Error("Fixture worker timeout"));},5000);worker.once("error",error=>{clearTimeout(timer);reject(error);});worker.once("close",code=>{clearTimeout(timer);resolve(code);});});
    assert.equal(code,0);
    f.recovery.transition(f.run.runId,{checkpoint:"ticket-selected",event:"worker_started",payload:{workerPid:group,processStart:"fixture-dead-incarnation",host:f.recovery.currentLease()?.host}});
    assert.throws(()=>prepareInterruptedBuilderSourceContinuation(f.root,f.run.runId),/verified stopped/);
    assert.equal(f.recovery.operation("interrupted-turn")!.status,"uncertain");
  }finally{if(group){try{process.kill(-group,"SIGKILL");}catch{}}f.close();}
});

test("recovery snapshot fences changed product at launch and first assignment, ignores only host tracker rendering, and is consumed once",{skip:process.platform==="win32"?"Source continuation requires supported native owned-group proof":false},()=>{
  const f=fixture();try{
    prepareInterruptedBuilderSourceContinuation(f.root,f.run.runId);
    const run=()=>f.recovery.getRun(f.run.runId)!.state as unknown as typeof f.run;
    assert.doesNotThrow(()=>assertInterruptedSourceSnapshot(f.root,run()));
    writeFileSync(join(f.root,"docs/ticket-progress.md"),"Host rendering changed\n");
    assert.doesNotThrow(()=>assertInterruptedSourceSnapshot(f.root,run()));
    const preserved=readFileSync(join(f.root,"feature4.txt"),"utf8");writeFileSync(join(f.root,"feature4.txt"),"Concurrent uninspected change\n");
    assert.throws(()=>assertInterruptedSourceSnapshot(f.root,run()),/changed after recovery preparation/);
    assert.throws(()=>beginBuildAssignment(f.root,f.run.runId,"T004",f.root,"Fresh approved work"),/changed after recovery preparation/);
    writeFileSync(join(f.root,"feature4.txt"),preserved);
    const resumed=beginBuildAssignment(f.root,f.run.runId,"T004",f.root,"Fresh approved work");
    assert.match(resumed.instruction,/Inspect the preserved files before acting/);
    assert.equal((run() as any).interruptedBuilderContinuation.firstAssignmentId,resumed.operationId);
    writeFileSync(join(f.root,"feature4.txt"),"New legitimate implementation\n");
    assert.doesNotThrow(()=>assertInterruptedSourceSnapshot(f.root,run()),"Historical snapshot must not permanently fence legitimate new source after consumption");
    const stale={...run(),interruptedBuilderContinuation:{...(run() as any).interruptedBuilderContinuation,firstAssignmentId:undefined}};
    assert.doesNotThrow(()=>assertInterruptedSourceSnapshot(f.root,stale),"A stale projection cannot resurrect a consumed source fence; the assignment journal remains authoritative");
  }finally{f.close();}
});

test("checkpoint publication failure atomically rolls back dispatch retirement and recovery marker",{skip:process.platform==="win32"?"Source continuation requires supported native owned-group proof":false},()=>{
  const f=fixture();const original=WorkflowDb.prototype.publishContinuityCheckpoint;
  try{
    WorkflowDb.prototype.publishContinuityCheckpoint=function(){throw new Error("Injected checkpoint failure");};
    assert.throws(()=>prepareInterruptedBuilderSourceContinuation(f.root,f.run.runId),/Injected checkpoint failure/);
    assert.equal(f.recovery.operation("interrupted-turn")!.status,"uncertain");assert.equal(f.recovery.operation(f.assignment.operationId)!.status,"in_progress");
    assert.equal(f.recovery.getRun(f.run.runId)!.state.interruptedBuilderContinuation,undefined);
  }finally{WorkflowDb.prototype.publishContinuityCheckpoint=original;f.close();}
});

test("a new HEAD cannot consume an old source-recovery snapshot even if product bytes are unchanged",{skip:process.platform==="win32"?"Source continuation requires supported native owned-group proof":false},()=>{
  const f=fixture();try{
    prepareInterruptedBuilderSourceContinuation(f.root,f.run.runId);
    execFileSync("git",["commit","--allow-empty","-qm","Concurrent HEAD change"],{cwd:f.root,stdio:"pipe"});
    assert.throws(()=>assertInterruptedSourceSnapshot(f.root,f.recovery.getRun(f.run.runId)!.state as unknown as typeof f.run),/changed after recovery preparation/);
  }finally{f.close();}
});

test("switching branches at the same HEAD cannot consume another branch's recovery snapshot",{skip:process.platform==="win32"?"Source continuation requires supported native owned-group proof":false},()=>{
  const f=fixture();try{
    prepareInterruptedBuilderSourceContinuation(f.root,f.run.runId);
    execFileSync("git",["switch","-qc","other-branch"],{cwd:f.root,stdio:"pipe"});
    assert.throws(()=>assertInterruptedSourceSnapshot(f.root,f.recovery.getRun(f.run.runId)!.state as unknown as typeof f.run),/changed after recovery preparation/);
  }finally{f.close();}
});
