import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { createBuildRun, persistBuildSession, releaseBuildLease, projectBuildRecovery, readBuildRuns } from "ai-foreman/build-runs.js";
import { beginBuildAssignment, isInterruptedBuilderRecovery } from "ai-foreman/build-assignment.js";
import { createProviderSessionRef } from "ai-foreman/session-identity.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";
import { HandoffService } from "ai-foreman/handoffs.js";
import { cmdInit } from "../../ai-foreman/dist/tickets/commands.js";
import { StateDb } from "../../ai-foreman/dist/tickets/stateDb.js";
import { buildBuildResumeCommand, type BuildResumeCommandOptions } from "../src/buildResume.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";
import { processStartIdentity } from "../../ai-foreman/dist/processIdentity.js";

function approveFixturePlan(projectDir: string, ticketIds: string[]) {
  const config = parse(readFileSync(join(projectDir, "rafi-config.yaml"), "utf8"));
  const file = join(projectDir, ".tickets/tickets.yaml");
  const definitions = (parse(readFileSync(file, "utf8"))?.tickets ?? []) as Array<Record<string, unknown>>;
  for (const id of ticketIds) if (!definitions.some(ticket => ticket.id === id)) definitions.push({ id, order: definitions.length + 1, title: `Fixture ${id}`, area: "tests", priority: "P2", size: "S", risk: "Low", depends_on: [], summary: `Approved work ${id}`, acceptance: ["Fixture work is complete"], required_tests: [], likely_files: [], rollback: null, notes: null });
  writeFileSync(file, stringify({ tickets: definitions }));
  const plan = { version: 1, plan_id: "resume-fixture-plan", revision: 1, content_digest: "", slices: definitions.map(ticket => ({ ...ticket, slice_ref: ticket.id })) };
  const canonical = (value: unknown): string => JSON.stringify(value, (_, child) => child && typeof child === "object" && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
  plan.content_digest = createHash("sha256").update(canonical(plan)).digest("hex");
  const directory = join(projectDir, config.docs?.root ?? "docs"); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "rafi-plan.json"), JSON.stringify(plan));
  const db = new WorkflowDb(projectDir);
  try {
    const runId = `fixture-plan-approval:${plan.content_digest}`;
    if (!db.getRun(runId)) db.createRun({ runId, kind: "plan" });
    db.transition(runId, { status: "completed", checkpoint: "approved", state: { planId: plan.plan_id, revision: plan.revision, digest: plan.content_digest, decisionReceipt: { planDigest: plan.content_digest } } });
  } finally { db.close(); }
}

function fixture() {
  const root=mkdtempSync(join(tmpdir(),"rafi-multiticket-resume-"));
  // This recovery fixture models an assignment created before QA preparation.
  const config=buildProjectConfig(defaultAnswers()); config.qa_preparation=false;
  writeFileSync(join(root,"rafi-config.yaml"),stringify(config));
  cmdInit(root,{});
  const tickets=[1,2,3,4,5,6,7,8].map(order=>({id:`T00${order}`,order,title:`Feature ${order}`,area:"tests",priority:"P2",size:"XS",risk:"Low",depends_on:[],summary:`Feature ${order}`,acceptance:[`Feature ${order} works`],required_tests:[],likely_files:[`feature${order}.txt`],notes:"Fixture"}));
  writeFileSync(join(root,".tickets/tickets.yaml"),stringify({tickets}));
  writeFileSync(join(root,"feature4.txt"),"Initial source\n");
  const git=(args:string[])=>execFileSync("git",args,{cwd:root,stdio:"pipe"});
  git(["init","-q","-b","main"]);git(["config","user.email","fixture@example.test"]);git(["config","user.name","Fixture"]);git(["add","."]);git(["commit","-qm","Baseline"]);
  const tracker=new StateDb(join(root,".tickets/ticket-state.sqlite"));
  for(const ticket of tickets)tracker.upsertState(ticket.id,{status:ticket.order<4?"done":"planned",...(ticket.order<4?{completed_at:"2026-10-15T00:00:00Z",validation_result:"passed" as const}:{})},new Date().toISOString());
  tracker.close();
  approveFixturePlan(root, tickets.map(ticket => ticket.id));
  let run=createBuildRun({repositoryRoot:root,tickets:tickets.map(t=>t.id),builder:{role:"builder",source:"project",make:"codex",model:"default",reasoning:"default",fast:false},builderCapabilities:{requestedNetwork:false,grantedNetwork:false}});
  const ref={...createProviderSessionRef({provider:"codex",sessionId:"unavailable-original",role:"builder",stream:"builder",cwd:root,configRoot:root,source:"observed"}),validatedAt:new Date().toISOString()};
  run=persistBuildSession(root,run,"builder",ref);
  const db=new WorkflowDb(root);
  for(const ticket of tickets)db.admitWork({runId:run.runId,kind:"ticket",ticketId:ticket.id,definition:ticket,approvalId:"fixture-scope",scopeRevision:"fixture-revision",provenance:{userTurn:`Fixture authorizes ${ticket.id}`,reason:"Explicit approved scope"}});
  db.claimInitialRoleLease(run.runId,"builder",ref);
  db.publishContinuityCheckpoint({runId:run.runId,role:"builder",delta:{version:1,decisions:[],constraints:[],discoveries:[],completedActions:[],evidence:[],failures:[],blockers:[],openWork:["Finish T004"],nextAction:"Finish T004"},authoritativeStateRevision:0});
  const deadPid=Number(execFileSync(process.execPath,["-e","process.stdout.write(String(process.pid))"],{encoding:"utf8"}));
  db.transition(run.runId,{checkpoint:"ticket-selected",event:"worker_started",payload:{workerPid:deadPid,processStart:"fixture-incarnation",host:run.lease!.hostname,generation:1}});
  db.close();
  const assignment=beginBuildAssignment(root,run.runId,"T004",root,"Implement T004");
  const turn=new WorkflowDb(root);
  turn.planOperation({runId:run.runId,idempotencyKey:"unknown-builder-turn",kind:"provider-dispatch",intent:{role:"builder",sessionRef:ref,instructionDigest:"old-frozen-instruction"}});turn.updateOperation("unknown-builder-turn","in_progress");
  turn.appendContinuityEvent({runId:run.runId,role:"host",kind:"turn_started",payload:{role:"builder",dispatchId:"unknown-builder-turn"},authoritativeStateRevision:0});
  turn.close();writeFileSync(join(root,"feature4.txt"),"Preserved partial implementation\n");
  run=releaseBuildLease(root,run,"recoverable");
  return {root,run,assignment};
}
const unavailableProjection:NonNullable<BuildResumeCommandOptions["resolveProjection"]> = async (root,run,now,ticket)=>projectBuildRecovery(root,run,now,ticket);

test("public resume keeps the same eight-ticket run, preserves three completed tickets and admits every remaining ticket with an unavailable predecessor",{skip:process.platform==="win32"?"Source continuation requires supported native owned-group proof":false},async()=>{
  const f=fixture();try{
    let args:string[]|undefined;
    await buildBuildResumeCommand({resolveProjection:unavailableProjection,executeStart:value=>{args=value;return 0;}}).parseAsync([f.root,"--run",f.run.runId,"--yes"],{from:"user"});
    assert.ok(args);assert.equal(args[args.indexOf("--recover-run")+1],f.run.runId);
    assert.equal(args[args.indexOf("--steps")+1],"5");assert.equal(args[args.indexOf("--ticket")+1],"T004");
    assert.equal(args[args.indexOf("--recovery-mode")+1],"fresh-with-handoff");assert.equal(args.includes("--resume"),false);
    const run=readBuildRuns(f.root).find(run=>run.runId===f.run.runId)!;
    assert.deepEqual(run.recoveryDecision!.executionTickets,["T004","T005","T006","T007","T008"]);
    assert.deepEqual(run.progress.completedTickets,["T001","T002","T003"]);
    assert.equal(isInterruptedBuilderRecovery(run),true);
    const db=new WorkflowDb(f.root);try{
      assert.equal(db.operation("unknown-builder-turn")!.status,"failed");assert.equal((db.operation("unknown-builder-turn")!.result as any).outcomeUnknown,true);
      assert.equal(db.operation(f.assignment.operationId)!.status,"failed");assert.equal(db.getRun(f.run.runId)!.status,"paused");
      assert.equal(db.handoffs(f.run.runId).length,1);assert.equal(db.hasUncheckpointedRoleTurn(f.run.runId,"builder"),true);
    }finally{db.close();}
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test("crash after source reconciliation but before handoff staging retries the same run without re-retiring unknown history",{skip:process.platform==="win32"?"Source continuation requires supported native owned-group proof":false},async()=>{
  const f=fixture();const original=HandoffService.prototype.stage;try{
    HandoffService.prototype.stage=function(){throw new Error("Injected staging crash");};
    await assert.rejects(buildBuildResumeCommand({resolveProjection:unavailableProjection,executeStart:()=>{throw new Error("must not launch");}}).parseAsync([f.root,"--run",f.run.runId,"--yes"],{from:"user"}),/Injected staging crash/);
    HandoffService.prototype.stage=original;
    const db=new WorkflowDb(f.root);let preserved:unknown;try{preserved=db.operation("unknown-builder-turn")!.result;assert.equal(db.operation("unknown-builder-turn")!.status,"failed");}finally{db.close();}
    let launched:string[]|undefined;
    await buildBuildResumeCommand({resolveProjection:unavailableProjection,executeStart:args=>{launched=args;return 0;}}).parseAsync([f.root,"--run",f.run.runId,"--yes"],{from:"user"});
    assert.equal(launched![launched!.indexOf("--steps")+1],"5");
    const after=new WorkflowDb(f.root);try{assert.deepEqual(after.operation("unknown-builder-turn")!.result,preserved);assert.equal(after.events(f.run.runId).filter(event=>event.type==="builder_source_continuation_authorized").length,1);}finally{after.close();}
  }finally{HandoffService.prototype.stage=original;rmSync(f.root,{recursive:true,force:true});}
});

test("public source resume reports an actionable safe pause if the worker is still alive, without launching or retiring uncertainty",async()=>{
  const f=fixture();const originalExit=process.exitCode;try{
    const db=new WorkflowDb(f.root);const lease=db.acquireLease(f.run.runId);
    db.transition(f.run.runId,{checkpoint:"ticket-selected",event:"worker_started",payload:{workerPid:process.pid,processStart:processStartIdentity(),host:lease.host}});db.releaseLease(lease);db.close();
    let launched=false;let outcome:string|undefined;
    await buildBuildResumeCommand({resolveProjection:unavailableProjection,onOutcome:value=>{outcome=value;},executeStart:()=>{launched=true;return 0;}}).parseAsync([f.root,"--run",f.run.runId,"--yes"],{from:"user"});
    assert.equal(launched,false);assert.equal(outcome,"paused");assert.equal(process.exitCode,2);
    const after=new WorkflowDb(f.root);try{assert.equal(after.operation("unknown-builder-turn")!.status,"in_progress");assert.equal(after.operation(f.assignment.operationId)!.status,"in_progress");assert.equal(after.currentLease(),undefined);}finally{after.close();}
  }finally{process.exitCode=originalExit;rmSync(f.root,{recursive:true,force:true});}
});
