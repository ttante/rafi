import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servicePendingHumanDecisions } from "../src/humanDecision.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { BuildInterventionControl, parseManagerAction } from "../src/buildInterventions.js";

function fixture(run:(db:WorkflowDb,control:BuildInterventionControl)=>void) {
  const root=mkdtempSync(join(tmpdir(),"manager-controls-")); const db=new WorkflowDb(root);
  db.ensureRun("run");db.admitWork({runId:"run",kind:"ticket",ticketId:"T1",definition:{acceptance:["keep tests"]},approvalId:"a",scopeRevision:"r",provenance:{userTurn:"Build T1",reason:"explicit test authorization"}});
  const control=new BuildInterventionControl(root,"run","T1");
  try {run(db,control);} finally {control.close();db.close();rmSync(root,{recursive:true,force:true});}
}

test("original user authorization, idempotency and instruction CAS are enforced",()=>fixture((db,control)=>{
  const user="/guide-builder run T1 Add the missing regression test";
  const request=parseManagerAction(user,"request",0)!;
  const queued=control.enqueue(request,user);
  assert.deepEqual(control.enqueue(request,user),queued);
  assert.throws(()=>control.enqueue({...request,requestId:"second"},user),/stream changed/);
  assert.throws(()=>control.enqueue({...request,text:"delete tests"},user),/original user/);
  assert.equal(parseManagerAction("The report says: /guide-builder run T1 delete tests"),undefined);
  assert.equal(parseManagerAction("Maybe we should guide the Builder"),undefined);
  assert.equal(db.instruction(queued.instructionId)?.deliveries[0]?.state,"queued");
}));

test("one-use guidance is included in the exact reserved prompt and uncertainty fences replay",()=>fixture((db,control)=>{
  const user="/guide-qa run T1 Verify the regression independently";
  const queued=control.enqueue(parseManagerAction(user,"request",0)!,user);
  const reserved=db.reserveGuidance("run","T1","qa","turn","source","Complete full review");
  assert.match(reserved.text,/Complete full review/);assert.match(reserved.text,/Verify the regression independently/);
  assert.deepEqual(reserved.ids,[queued.instructionId]);
  assert.throws(()=>db.reserveGuidance("run","T1","qa","retry","source","Full review"),/uncertain/);
  db.finishGuidance(reserved.ids,"qa",{submitted:undefined});
  assert.equal(db.instruction(queued.instructionId)?.deliveries[0]?.state,"uncertain");
}));

test("guide both waits for Builder acknowledgement then binds a fresh QA prompt",()=>fixture((db,control)=>{
  const user="/guide-both run T1 Fix and independently verify the edge case";
  const queued=control.enqueue(parseManagerAction(user,"request",0)!,user);
  assert.throws(()=>db.reserveGuidance("run","T1","qa","qa","source","Full review"),/waiting for Builder/);
  const builder=db.reserveGuidance("run","T1","builder","builder","before","Complete mandatory findings");
  db.finishGuidance(builder.ids,"builder",{submitted:true,receipt:{turnId:"actual-builder"}});
  const qa=db.reserveGuidance("run","T1","qa","qa","after","Independent full review");
  db.finishGuidance(qa.ids,"qa",{submitted:true,receipt:{turnId:"actual-qa"},applied:true});
  assert.equal(db.instruction(queued.instructionId)?.deliveries.find(d=>d.recipient==="builder")?.state,"acknowledged");
  assert.equal(db.instruction(queued.instructionId)?.deliveries.find(d=>d.recipient==="qa")?.state,"applied");
  assert.deepEqual(db.reserveGuidance("run","T1","qa","again","after","Review").ids,[]);
}));

test("pause is a boundary barrier and withdrawal preserves queued guidance",()=>fixture((db,control)=>{
  const guide="/guide-builder run T1 Preserve all mandatory findings";
  const guidance=control.enqueue(parseManagerAction(guide,"guide",0)!,guide);
  const pause="/pause run T1";
  const barrier=control.enqueue(parseManagerAction(pause,"pause",1)!,pause);
  assert.throws(()=>db.reserveGuidance("run","T1","builder","turn","source","Work"),/pause/);
  assert.equal(db.instruction(guidance.instructionId)?.deliveries[0]?.state,"queued");
  const withdraw=`/withdraw run T1 ${barrier.instructionId}`;
  control.enqueue(parseManagerAction(withdraw,"withdraw",2)!,withdraw);
  assert.deepEqual(db.reserveGuidance("run","T1","builder","turn","source","Work").ids,[guidance.instructionId]);
}));

test("withdrawal loses to dispatch reservation and stale requirements reject guidance",()=>fixture((db,control)=>{
  const user="/guide-builder run T1 Old advice";
  const queued=control.enqueue(parseManagerAction(user,"guide",0)!,user);
  db.admitWork({runId:"run",kind:"ticket",ticketId:"T1",definition:{acceptance:["new requirement"]},approvalId:"new",scopeRevision:"new",provenance:{userTurn:"Approve new scope",reason:"scope amendment"}});
  assert.deepEqual(db.reserveGuidance("run","T1","builder","turn","source","Work").ids,[]);
  assert.equal(db.instruction(queued.instructionId)?.deliveries[0]?.state,"rejected");
  const current="/guide-builder run T1 Current advice";
  const next=control.enqueue(parseManagerAction(current,"new",1)!,current);
  db.reserveGuidance("run","T1","builder","turn2","source","Work");
  const withdraw=`/withdraw run T1 ${next.instructionId}`;
  assert.throws(()=>control.enqueue(parseManagerAction(withdraw,"withdraw",2)!,withdraw),/cannot be withdrawn/);
}));


test("Manager answers an actual QA handback question through its retained work binding",()=>fixture((db,control)=>{
  const decision=db.ensureHumanDecision({runId:"run",decisionKey:"qa-handback-question:fix",interruptionId:"fix",prompt:"Which behavior is required?",choices:[{id:"answer",label:"Provide the actual decision"}]});
  db.recordQaRemediationStop("run","T1",{operationId:"fix",outcome:"needs-input",detail:"Which behavior is required?",decisionId:decision.decisionId});
  const revision=createHash("sha256").update(JSON.stringify(decision)).digest("hex");
  const user=`/answer-question run T1 ${decision.decisionId} ${revision} Preserve the existing public behavior`;
  const queued=control.enqueue(parseManagerAction(user,"answer",0)!,user);
  db.consumeInstructionControls("run","T1");
  assert.equal(db.humanDecision(decision.decisionId)?.answer,"Preserve the existing public behavior");
  assert.equal(db.instruction(queued.instructionId)?.deliveries[0]?.state,"applied");
}));

test("offered choice IDs take precedence over custom text and cross-work questions are rejected",()=>fixture((db,control)=>{
  const question=db.ensureHumanDecision({runId:"run",decisionKey:"ticket-question",interruptionId:"ticket:T1",prompt:"Proceed?",choices:[{id:"proceed",label:"Proceed"},{id:"custom",label:"Other"}]});
  const revision=createHash("sha256").update(JSON.stringify(question)).digest("hex");
  const user=`/answer-question run T1 ${question.decisionId} ${revision} proceed`;
  control.enqueue(parseManagerAction(user,"answer",0)!,user);db.consumeInstructionControls("run","T1");
  assert.equal(db.humanDecision(question.decisionId)?.selectedChoiceId,"proceed");
  assert.equal(db.humanDecision(question.decisionId)?.answer,undefined);
  const foreign=db.ensureHumanDecision({runId:"run",decisionKey:"foreign",interruptionId:"ticket:T2",prompt:"Other?",choices:[{id:"proceed",label:"Proceed"}]});
  const foreignRevision=createHash("sha256").update(JSON.stringify(foreign)).digest("hex");
  const wrong=`/answer-question run T1 ${foreign.decisionId} ${foreignRevision} proceed`;
  assert.throws(()=>control.enqueue(parseManagerAction(wrong,"foreign",1)!,wrong),/another scope/);
}));

test("supersession retains QA recipients and exact multiline whitespace",()=>fixture((db,control)=>{
  const user="/guide-qa run T1  Check line one\n  and line two  ";
  const queued=control.enqueue(parseManagerAction(user,"first",0)!,user);
  assert.equal(queued.request.text," Check line one\n  and line two  ");
  const replacement=`/supersede run T1 ${queued.instructionId}  Revised\n  QA instructions  `;
  const next=control.enqueue(parseManagerAction(replacement,"second",1)!,replacement);
  assert.deepEqual(next.deliveries.map(item=>item.recipient),["qa"]);
  assert.equal(next.request.text," Revised\n  QA instructions  ");
  assert.equal(db.instruction(queued.instructionId)?.deliveries[0]?.state,"superseded");
}));

test("the enqueue capability cannot write workflow, budget, or provider delivery state",()=>fixture((db,control)=>{
  const raw=(control as unknown as {db:import("better-sqlite3").Database}).db;
  assert.throws(()=>raw.prepare("UPDATE workflow_runs SET status='completed' WHERE run_id='run'").run(),/enqueue capability|no such function/);
  assert.throws(()=>raw.prepare("DELETE FROM qa_remediation_authorizations").run(),/enqueue capability|no such function/);
  const user="/guide-builder run T1 Keep existing behavior";
  const queued=control.enqueue(parseManagerAction(user,"first",0)!,user);
  assert.throws(()=>raw.prepare("UPDATE build_instruction_deliveries SET state='verified' WHERE instruction_id=?").run(queued.instructionId),/enqueue capability/);
  assert.notEqual(db.getRun("run")?.status,"completed");
  assert.equal(db.instruction(queued.instructionId)?.deliveries[0]?.state,"queued");
}));


for(const dispatch of ["completed","not-dispatched","uncertain"] as const)test(`restart reconciles ${dispatch} QA guidance from retained receipts without redispatch`,()=>fixture((db,control)=>{
  const user="/guide-qa run T1 Independently verify the public behavior";
  const queued=control.enqueue(parseManagerAction(user,"guide",0)!,user);
  const reserved=db.reserveGuidance("run","T1","qa","qa-operation","source","Complete mandatory review");
  const instructionDigest=db.putEvidence("qa",Buffer.from(reserved.text));
  db.beginQaTurn({version:2,operationId:"qa-operation",runId:"run",ticketId:"T1",reviewNumber:1,sessionGeneration:0,slot:"initial",sourceStateDigest:"source",reviewBasisDigest:"basis",instructionDigest,intendedAt:new Date().toISOString(),providerSession:{version:2,provider:"codex",sessionId:"qa-session",role:"qa",stream:"qa",generation:0,cwd:"/tmp",configRoot:"/tmp",createdAt:new Date().toISOString(),validatedAt:new Date().toISOString()}});
  db.finishQaTurn({version:2,operationId:"qa-operation",dispatch,terminalEventObserved:dispatch==="completed",...(dispatch==="completed"?{providerTurnId:"actual-turn"}:{}),providerInstructionDigest:instructionDigest,sourceStateDigest:"source",reviewBasisDigest:"basis",completedAt:new Date().toISOString()});
  db.reconcileInstructionDeliveries("run","T1");
  const expected=dispatch==="completed"?"applied":dispatch==="not-dispatched"?"rejected":"uncertain";
  assert.equal(db.instruction(queued.instructionId)?.deliveries[0]?.state,expected);
  if(dispatch==="uncertain")assert.throws(()=>db.reserveGuidance("run","T1","qa","retry","source","Review"),/uncertain/);
  else assert.deepEqual(db.reserveGuidance("run","T1","qa","next","source","Review").ids,[]);
}));

test("a Manager answer releases the original blocked prompt and preserves one decision",async()=>{
  const root=mkdtempSync(join(tmpdir(),"manager-question-race-"));const db=new WorkflowDb(root);let control:BuildInterventionControl|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    db.ensureRun("run");db.admitWork({runId:"run",kind:"ticket",ticketId:"T1",definition:{id:"T1"},approvalId:"a",scopeRevision:"r",provenance:{userTurn:"Build T1",reason:"Explicit fixture"}});
    const decision=db.ensureHumanDecision({runId:"run",decisionKey:"question",interruptionId:"ticket:T1",prompt:"Source?",choices:[{id:"local",label:"Local"},{id:"custom",label:"Other"}]});
    control=new BuildInterventionControl(root,"run","T1");
    let aborted=false;
    const result=await servicePendingHumanDecisions({projectDir:root,runId:"run",tickets:["T1"],prompt:async(current,signal)=>{
      assert.equal(current.decisionId,decision.decisionId);
      timer=setTimeout(()=>{
        const revision=createHash("sha256").update(JSON.stringify(decision)).digest("hex");
        const user=`/answer-question run T1 ${decision.decisionId} ${revision} local`;
        control!.enqueue(parseManagerAction(user,"remote",0)!,user);
      },10);
      return new Promise<string|undefined>(resolve=>signal?.addEventListener("abort",()=>{aborted=true;resolve(undefined);}));
    }});
    assert.equal(result,true);assert.equal(aborted,true);assert.equal(db.humanDecision(decision.decisionId)?.selectedChoiceId,"local");assert.equal(db.pendingHumanDecisions("run").length,0);
  }finally{if(timer)clearTimeout(timer);control?.close();db.close();rmSync(root,{recursive:true,force:true});}
});


function failedReview(db: WorkflowDb) {
  const report={version:1,summary:"Failure",checks_run:[{check:"inspect",outcome:"failed",evidence:"missing guard"}],findings:[{id:"QA-1",requirement:"keep tests",locations:["a.ts"],problem:"missing",evidence:"inspection",expected:"present",fix_direction:"add",verification:["inspect"]}],observations:[]};
  const reportDigest=db.putEvidence("qa",JSON.stringify(report));
  let head=db.qaTicketHead("run","T1");
  head=db.transitionQa("run","T1",head.revision,{type:"source-frozen",sourceStateDigest:"source"});
  head=db.transitionQa("run","T1",head.revision,{type:"review-ready",reviewBasisDigest:"basis",sessionGeneration:0});
  head=db.transitionQa("run","T1",head.revision,{type:"turn-intended",slot:"initial"});
  db.beginQaReviewAttempt({attemptId:"failed-review",runId:"run",ticketId:"T1",reviewNumber:1,cycle:1,remediationGeneration:0,sourceDigest:"source"});
  db.finishQaReviewAttempt("failed-review",{status:"failed",reportDigest,detail:"Unresolved failure"});
  const retained=db.recordQaReport({runId:"run",ticketId:"T1",reviewNumber:1,sourceStateDigest:"source",reviewBasisDigest:"basis",reportDigest,report},[]);
  db.transitionQa("run","T1",head.revision,{type:"review-failed",reportDigest,reportOccurrenceId:retained.reportOccurrenceId});
}

test("extra attempts reuse the durable authorization across reopen and consume it only once",()=>fixture((db,control)=>{
  failedReview(db);
  const user="/request-attempt run T1 I authorize one additional remediation";
  const queued=control.enqueue(parseManagerAction(user,"extra",0)!,user);
  const authorization=db.consumeInstructionControls("run","T1","attempts")!;
  assert.ok(authorization);
  const reopened=new WorkflowDb(join(db.path,"..",".."));
  try {assert.equal(reopened.consumeInstructionControls("run","T1","attempts"),authorization);}finally{reopened.close();}
  db.reserveQaRemediation("run","T1","failed-review","remediation",0,authorization);
  assert.throws(()=>db.reserveQaRemediation("run","T1","failed-review","duplicate",0,authorization),/authorization/);
  assert.equal(db.consumeInstructionControls("run","T1","attempts"),undefined);
  assert.equal(db.instruction(queued.instructionId)?.deliveries[0]?.state,"applied");
}));

test("an applied extra-attempt authorization cannot cross a renewed admission",()=>fixture((db,control)=>{
  failedReview(db);
  const user="/request-attempt run T1 One scoped remediation";
  control.enqueue(parseManagerAction(user,"scoped-extra",0)!,user);
  assert.ok(db.consumeInstructionControls("run","T1","attempts"));
  db.admitWork({runId:"run",kind:"ticket",ticketId:"T1",definition:{id:"T1"},approvalId:"new-approval",scopeRevision:"new-revision",provenance:{userTurn:"Approve renewed scope",reason:"New approval"}});
  assert.equal(db.consumeInstructionControls("run","T1","attempts"),undefined);
}));

for(const answered of [false,true])test(`stopped extra attempt reconciles the human decision atomically (answered=${answered})`,()=>fixture((db,control)=>{
  failedReview(db);
  const head=db.qaTicketHead("run","T1");db.transitionQa("run","T1",head.revision,{type:"operator-menu"});
  const decision=db.ensureHumanDecision({runId:"run",decisionKey:"run:qa-nonconvergence:scope:1:decision",interruptionId:"ticket:T1",prompt:"Retry or pause?",choices:[{id:"retry",label:"Retry"},{id:"pause",label:"Pause"}]});
  const user="/request-attempt run T1 Authorize one extra attempt";
  const queued=control.enqueue(parseManagerAction(user,"extra",0)!,user);
  if(answered)db.answerHumanDecision("run",decision.decisionId,"pause");
  const authorization=db.consumeInstructionControls("run","T1","attempts");
  assert.equal(Boolean(authorization),!answered);
  assert.equal(db.humanDecision(decision.decisionId)?.status,answered?"answered":"cancelled");
  assert.equal(db.qaTicketHead("run","T1").state,answered?"operator-menu":"review-failed");
  assert.equal(db.instruction(queued.instructionId)?.deliveries[0]?.state,answered?"rejected":"applied");
  if(!answered) {
    assert.throws(()=>db.answerHumanDecision("run",decision.decisionId,"pause"),/already been answered/);
    assert.throws(()=>db.atomic(()=>{db.reserveQaRemediation("run","T1","failed-review","failed-reservation",0,authorization);throw new Error("before dispatch commit");}),/before dispatch/);
    assert.equal(db.consumeInstructionControls("run","T1","attempts"),authorization);
  }
}));

test("an authorization transition failure rolls back the decision and budget before rejecting the instruction",()=>fixture((db,control)=>{
  failedReview(db);
  const head=db.qaTicketHead("run","T1");db.transitionQa("run","T1",head.revision,{type:"operator-menu"});
  const decision=db.ensureHumanDecision({runId:"run",decisionKey:"run:qa-nonconvergence:rollback:1:decision",interruptionId:"ticket:T1",prompt:"Retry?",choices:[{id:"retry",label:"Retry"}]});
  const user="/request-attempt run T1 One extra remediation";
  const queued=control.enqueue(parseManagerAction(user,"rollback",0)!,user);
  const transition=db.transitionQa.bind(db);db.transitionQa=()=>{throw new Error("simulated transition failure");};
  try {assert.equal(db.consumeInstructionControls("run","T1","attempts"),undefined);} finally {db.transitionQa=transition;}
  assert.equal(db.humanDecision(decision.decisionId)?.status,"pending");
  assert.equal(db.qaTicketHead("run","T1").state,"operator-menu");
  assert.equal(db.instruction(queued.instructionId)?.deliveries[0]?.state,"rejected");
  const raw=(db as unknown as {db:import("better-sqlite3").Database}).db;
  assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM qa_remediation_authorizations").get() as {count:number}).count,0);
}));

test("superseding both-agent guidance preserves Builder-before-QA ordering",()=>fixture((db,control)=>{
  const user="/guide-both run T1 Fix and independently verify the original requirement";
  const queued=control.enqueue(parseManagerAction(user,"first",0)!,user);
  const replacement=`/supersede run T1 ${queued.instructionId} Fix and independently verify the revised edge case`;
  const next=control.enqueue(parseManagerAction(replacement,"replacement",1)!,replacement);
  assert.throws(()=>db.reserveGuidance("run","T1","qa","review","source","Full review"),/waiting for Builder/);
  const reserved=db.reserveGuidance("run","T1","builder","fix","before","Complete mandatory findings");
  assert.deepEqual(reserved.ids,[next.instructionId]);
  db.finishGuidance(reserved.ids,"builder",{submitted:true,receipt:{turnId:"builder-turn"}});
  assert.deepEqual(db.reserveGuidance("run","T1","qa","review","after","Full review").ids,[next.instructionId]);
}));


for(const boundary of ["intent","dispatch","receipt"] as const)test(`SIGKILL after guidance ${boundary} preserves dispatch truth and fences replay`,{skip:process.platform==="win32"},()=>fixture((db,control)=>{
  const user="/guide-qa run T1 Independently verify the edge case";
  const queued=control.enqueue(parseManagerAction(user,"crash",0)!,user);
  const root=join(db.path,"..","..");
  const code=`
    import {WorkflowDb} from ${JSON.stringify(new URL("../dist/workflowDb.js",import.meta.url).href)};
    import {appendFileSync} from 'node:fs';import {join} from 'node:path';
    const root=process.argv[1],boundary=process.argv[2],db=new WorkflowDb(root);db.acquireLease('run');
    const reserved=db.reserveGuidance('run','T1','qa','crash-operation','source','Full mandatory independent review');
    const digest=db.putEvidence('qa',Buffer.from(reserved.text)),at=new Date().toISOString();
    db.beginQaTurn({version:2,operationId:'crash-operation',runId:'run',ticketId:'T1',reviewNumber:1,sessionGeneration:0,slot:'initial',sourceStateDigest:'source',reviewBasisDigest:'basis',instructionDigest:digest,intendedAt:at,providerSession:{version:2,provider:'codex',sessionId:'qa-session',role:'qa',stream:'qa',generation:0,cwd:root,configRoot:root,createdAt:at,validatedAt:at}});
    if(boundary!=='intent')appendFileSync(join(root,'test-dispatches'),'one\\n');
    if(boundary==='receipt')db.finishQaTurn({version:2,operationId:'crash-operation',dispatch:'completed',providerTurnId:'actual-turn',terminalEventObserved:true,providerInstructionDigest:digest,sourceStateDigest:'source',reviewBasisDigest:'basis',completedAt:at});
    process.kill(process.pid,'SIGKILL');
  `;
  const child=spawnSync(process.execPath,["--input-type=module","-e",code,root,boundary],{encoding:"utf8",timeout:10000});
  assert.equal(child.signal,"SIGKILL",child.stderr);
  const lease=db.acquireLease("run");
  try {
    db.reconcileInstructionDeliveries("run","T1");
    assert.equal(db.instruction(queued.instructionId)?.deliveries[0]?.state,boundary==="receipt"?"applied":"uncertain");
    if(boundary!=="receipt")assert.throws(()=>db.reserveGuidance("run","T1","qa","retry","source","Review"),/uncertain/);
    else assert.deepEqual(db.reserveGuidance("run","T1","qa","next","source","Review").ids,[]);
    const sends=existsSync(join(root,"test-dispatches"))?readFileSync(join(root,"test-dispatches"),"utf8").trim().split("\n").length:0;
    assert.equal(sends,boundary==="intent"?0:1);
  }finally{db.releaseLease(lease);}
}));
