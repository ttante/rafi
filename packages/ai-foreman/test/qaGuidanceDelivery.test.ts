import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";
import type { SDKMessage, SDKUserMessage, Query } from "@anthropic-ai/claude-agent-sdk";
import { runBranchPlan, type BranchRunnerOptions } from "../src/branch/runner.js";
import { Foreman } from "../src/foreman.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { BuildInterventionControl, parseManagerAction } from "../src/buildInterventions.js";
import { ContinuityAdapter } from "../src/continuity.js";
import { CurrentWorkflowGuardAdapter } from "../src/branch/currentGuard.js";
import { RecoveringAdapter } from "../src/adapters/recovering.js";
import { RoleStatusAdapter } from "../src/statusReporter.js";
import { cmdInit } from "../src/tickets/commands.js";
import { saveTickets } from "../src/tickets/ticketLoader.js";
import { Log } from "../src/log.js";
import { beginBuildAssignment, finishBuildAssignment } from "../src/buildAssignment.js";
import { qaDigest } from "../src/qaProtocolV2.js";
import type { BuilderAdapter, TurnResult } from "../src/adapters/types.js";
import type { QaSessionHandle } from "../src/qaReview.js";
import type { ProviderSessionRefV1 } from "rafi-spec";
import type { TicketDef } from "../src/tickets/ticketSchema.js";

const ticket:TicketDef={id:"T001",order:1,title:"Guard",area:"core",priority:"P2",size:"S",risk:"Low",depends_on:[],summary:"Guard empty input",acceptance:["empty input is guarded"],required_tests:["inspect"],likely_files:["source.txt"]};
const failure={version:1,summary:"Guard missing",checks_run:[{check:"inspect",outcome:"failed",evidence:"missing guard"}],findings:[{id:"QA-1",requirement:"empty input is guarded",locations:["source.txt"],problem:"missing guard",evidence:"source",expected:"guard",fix_direction:"add guard",verification:["inspect"]}],observations:[]};
const delta=JSON.stringify({version:1,decisions:[],constraints:[],discoveries:[],completedActions:["turn"],evidence:[],failures:[],blockers:[],openWork:[],nextAction:"continue"});
for(const provider of ["claude","codex"] as const)for(const target of ["builder","qa","both"] as const)for(const scenario of (target==="qa"?["in-cycle","after-pass"]:["in-cycle",...(target==="builder"?["extra-attempt"]:[]),"after-pass","after-pass-budget","after-pass-pause","after-pass-withdraw","after-pass-stale","after-pass-drift","after-pass-fails","after-pass-repeat","after-pass-branch"]))test(`${provider} ${target} ${scenario} guidance reaches the next in-cycle prompts through the production wrapper stack`,async()=>{
  const root=process.env.RAFI_GUIDANCE_CRASH_ROOT??mkdtempSync(join(tmpdir(),"guidance-delivery-"));const prompts:Array<{role:string;text:string}>=[];const adapters:BuilderAdapter[]=[];let reviews=0;let instructionId="";
  try {
    execFileSync("git",["init","-q",root]);cmdInit(root,{});saveTickets(join(root,".tickets/tickets.yaml"),[ticket]);writeFileSync(join(root,"source.txt"),"base\n");execFileSync("git",["add","."],{cwd:root});execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.test","commit","-qm","base"],{cwd:root});
    const db=new WorkflowDb(root);db.ensureRun("run");db.admitWork({runId:"run",kind:"ticket",ticketId:ticket.id,definition:ticket,approvalId:"approval",scopeRevision:"revision",provenance:{userTurn:"Build T001",reason:"Approved execution fixture"}});db.close();
    if(process.env.RAFI_GUIDANCE_CRASH==="receipt" && !scenario.startsWith("after-pass")) {
      const original=WorkflowDb.prototype.recordQaDeliveryTurn;
      WorkflowDb.prototype.recordQaDeliveryTurn=function(record) {original.call(this,record);if(record.kind==="remediation"&&record.status==="completed")process.kill(process.pid,"SIGKILL");};
    }
    if(process.env.RAFI_GUIDANCE_CRASH==="receipt" && scenario.startsWith("after-pass")) {
      const original=WorkflowDb.prototype.close;
      WorkflowDb.prototype.close=function() {const completed=this.operations("run").some(op=>(op.intent as {managerFollowup?:unknown}).managerFollowup&&op.status==="confirmed");original.call(this);if(completed)process.kill(process.pid,"SIGKILL");};
    }
    const advice="Preserve the empty-input regression\n  and independently check its edge case. 🧪";
    const make=(cwd:string,role:"builder"|"qa",resumeSessionId?:string):BuilderAdapter=>{
      const ref:ProviderSessionRefV1={version:1,provider,sessionId:resumeSessionId??`${role}-${adapters.length}`,role,stream:role,generation:0,cwd,configRoot:role==="builder"?root:cwd,ticketId:"T001",source:"observed",createdAt:new Date(0).toISOString(),validatedAt:new Date(0).toISOString()};
      const respond=(prompt:string):string=>{
        prompts.push({role,text:prompt});let text:string;
        if(role==="qa") {
          reviews++;
          if(reviews===1) {
            const command=`/guide-${target} run T001 ${advice}`;const control=new BuildInterventionControl(root,"run","T001");try{instructionId=control.enqueue(parseManagerAction(command,"guide",0)!,command).instructionId;}finally{control.close();}
            text=scenario.startsWith("after-pass")?'STEP_STATUS: qa_pass | summary="Initial work passed"':`RAFI_QA_FAILURE_REPORT_START\n${JSON.stringify(failure)}\nRAFI_QA_FAILURE_REPORT_END\nSTEP_STATUS: qa_fail | issues="guard missing"`;
          } else if((scenario==="extra-attempt"||scenario==="after-pass-fails")&&reviews===2) text=`RAFI_QA_FAILURE_REPORT_START\n${JSON.stringify(failure)}\nRAFI_QA_FAILURE_REPORT_END\nSTEP_STATUS: qa_fail | issues="guard missing"`;
          else text=`MANAGER_INSTRUCTION_VERIFIED: ${instructionId}\nSTEP_STATUS: qa_pass | summary="Edge case independently verified"`;
        } else if(prompt.includes("QA failure handoff ID:")) {
          if(process.env.RAFI_GUIDANCE_CRASH)appendFileSync(join(root,".rafi/test-dispatches"),"one\n");
          assert.match(prompt,/missing guard/);writeFileSync(join(cwd,"source.txt"),"guarded edge case\n");
          text=`RAFI_BUILDER_QA_REMEDIATION_START\n${JSON.stringify({version:3,handoff_id:/QA failure handoff ID: ([a-f0-9]+)/.exec(prompt)![1],summary:"Guarded empty input",findings:[{finding_key:/QA-1 -> ([a-f0-9]+)/.exec(prompt)![1],raw_id:"QA-1",disposition:"fixed",changes:["guarded input"],evidence:"source.txt",verification:[{check:"inspect",outcome:"passed",evidence:"guard exists"}]}],observations:[]})}\nRAFI_BUILDER_QA_REMEDIATION_END\nSTEP_STATUS: done | summary="guard implemented"`;
        } else if(prompt.includes("Builder guidance follow-up after explicit resume.")) {
          if(process.env.RAFI_GUIDANCE_CRASH)appendFileSync(join(root,".rafi/test-dispatches"),"one\n");
          assert.ok(prompt.includes(advice));assert.ok(prompt.includes("Approved ticket requirements"));
          writeFileSync(join(cwd,"source.txt"),"guarded edge case\n");
          text=`Applied instruction ${instructionId} with evidence: source.txt.\nSTEP_STATUS: done | ticket="T001" summary="Guidance applied"`;
        } else {writeFileSync(join(cwd,"source.txt"),"implementation\n");text='STEP_STATUS: done | ticket="T001" summary="implemented"';}
        if(role==="builder"&&(prompt.includes("QA failure handoff ID:")||prompt.includes("Builder guidance follow-up after explicit resume."))&&process.env.RAFI_GUIDANCE_CRASH==="submission")process.kill(process.pid,"SIGKILL");
        return text+`\nRAFI_CONTINUITY_DELTA: ${delta}`;
      };
      const options={cwd,resumeSessionId,configRoot:role==="builder"?root:cwd,sessionRole:role,sessionStream:role,ticketId:"T001",permission:async()=>({behavior:"deny" as const,message:"Deterministic transport"}),preparationTimeoutMs:2000};
      let transport:BuilderAdapter;
      if(provider==="claude") {
        const messages=new AsyncQueue<SDKMessage>();
        const query=(input:{prompt:AsyncIterable<SDKUserMessage>;options:{abortController:AbortController}}):Query=>{
          input.options.abortController.signal.addEventListener("abort",()=>messages.close());
          messages.push({type:"system",subtype:"init",session_id:ref.sessionId,cwd} as SDKMessage);
          void (async()=>{for await(const prompt of input.prompt) {
            const text=respond(String(prompt.message.content));
            messages.push({type:"result",subtype:"success",session_id:ref.sessionId,result:text,is_error:false,num_turns:1,total_cost_usd:0,usage:{input_tokens:100,output_tokens:10},modelUsage:{}} as unknown as SDKMessage);
          }})();
          return {[Symbol.asyncIterator]:()=>messages[Symbol.asyncIterator](),initializationResult:async()=>({}),getContextUsage:async()=>({maxTokens:10000,usedTokens:100,autoCompactThreshold:6500,isAutoCompactEnabled:true}),applyFlagSettings:async()=>{},interrupt:async()=>messages.close()} as unknown as Query;
        };
        transport=Reflect.construct(ClaudeAdapter,[options,query]) as ClaudeAdapter;
      } else {
        const native=new CodexAdapter(options);
        const rpc=native as unknown as {ensureConnection():Promise<void>;request(method:string,params:Record<string,unknown>):Promise<unknown>;handle(message:unknown):void};
        rpc.ensureConnection=async()=>{};
        rpc.request=async(method,params)=>{
          if(method==="thread/start"||method==="thread/resume")return {thread:{id:ref.sessionId,cwd}};
          if(method==="turn/start") {
            const prompt=(params.input as Array<{text:string}>).map(item=>item.text).join("\n");const text=respond(prompt);
            setTimeout(()=>{
              rpc.handle({method:"item/completed",params:{threadId:ref.sessionId,item:{type:"agentMessage",text}}});
              rpc.handle({method:"turn/completed",params:{threadId:ref.sessionId,turn:{id:`native-${prompts.length}`,status:"completed"}}});
            },0);
            return {turn:{id:`native-${prompts.length}`}};
          }
          return {};
        };
        transport=native;
      }
      const recovering=new RecoveringAdapter({initial:role==="builder"?new CurrentWorkflowGuardAdapter(transport,cwd):transport,runtime:provider,enabled:true,allowSwitch:false,label:role,choose:async()=>{throw new Error("Unexpected retry");},recreate:async()=>{throw new Error("Unexpected recreation");}});
      const continuous=new ContinuityAdapter({adapter:recovering,projectDir:root,runId:role==="qa"?`run:qa-${adapters.length}`:"run",role,settings:{role,source:"project",make:provider,model:"default",reasoning:"default",fast:false,session_strategy:"compact",display_session_cost:false,auto_compact_threshold_percent:65,compact_maximum:1,settings_revision:1},authoritativeStateRevision:()=>1,durableSingleTurn:role==="qa"});
      const adapter=new RoleStatusAdapter(continuous,()=>{},()=>{});if(role==="builder"&&process.env.RAFI_GUIDANCE_CRASH==="reservation") {
        const original=adapter.sendTurn.bind(adapter);
        adapter.sendTurn=async(prompt,options)=>{if(prompt.includes("QA failure handoff ID:")||prompt.includes("Builder guidance follow-up after explicit resume."))process.kill(process.pid,"SIGKILL");return original(prompt,options);};
      }
      adapters.push(adapter);return adapter;
    };
    const createQa=async(cwd:string):Promise<QaSessionHandle>=>{const adapter=make(cwd,"qa");await adapter.prepareSession?.();const confinement={version:2 as const,sourceMode:"read-only" as const,scratchMode:"isolated" as const,settingsSources:"none" as const,networkMode:"disabled" as const,environmentDigest:"1".repeat(64),policyDigest:"2".repeat(64)};return {adapter,sessionIdentity:()=>adapter.sessionRef!()!,effectiveRoleInstructions:"Independent full QA",runtimeContext:{provider},skills:[],confinement:{...confinement,digest:qaDigest("qa-confinement",confinement)},handoffReceipt:{kind:"initial"}};};
    const args:ConstructorParameters<typeof Foreman>=[make(root,"builder"),new Log(join(root,".foreman/test.jsonl")),false,true,scenario==="after-pass-budget"?0:1,root,undefined,createQa];args[13]=async adapter=>adapter;args[19]=true;args[22]="run";
    const foreman=new Foreman(...args);
    if(scenario==="after-pass-branch") {
      execFileSync("git",["config","user.name","Test"],{cwd:root});execFileSync("git",["config","user.email","test@example.test"],{cwd:root});
      const base=execFileSync("git",["branch","--show-current"],{cwd:root,encoding:"utf8"}).trim();
      const options:BranchRunnerOptions={projectDir:root,runId:"run",plan:{baseRef:base,nodes:[{ticket,branch:"ticket/T001",baseRef:base,baseBranch:base,dependencies:[],depth:0}],issues:[]},log:new Log(join(root,".foreman/branch.jsonl")),notificationsEnabled:false,qaEnabled:true,qaMaxFixAttempts:1,createPr:false,prReady:false,keepWorktrees:true,baseWorktreePolicy:"skip",createBuilder:async (cwd,sessionId)=>make(cwd,"builder",sessionId),createQa,builderSessionBoundary:async adapter=>adapter,qaContinuityManaged:true};
      const first=await runBranchPlan(options);assert.ok(["blocked","needs-human"].includes(first[0]?.buildStatus??""),JSON.stringify(first));assert.equal(reviews,1);
      const db=new WorkflowDb(root);let session:NonNullable<ReturnType<WorkflowDb["branchResumeSession"]>>;try{session=db.branchResumeSession("run","T001")!;assert.ok(session);assert.equal(db.qaTicketHead("run","T001").state,"passed");}finally{db.close();}
      const resumed=await runBranchPlan({...options,qaProtocolResumeTicket:"T001",resumeSessions:new Map([["T001",{worktreePath:session.worktreePath,sessionId:session.sessionId,sessionRef:session.sessionRef}]])});
      assert.equal(resumed[0]?.buildStatus,"done",JSON.stringify(resumed));assert.equal(reviews,2);assert.equal(prompts.filter(p=>p.role==="builder").length,2,"branch resume sends only one scoped follow-up");
    } else if(scenario.startsWith("after-pass")) {
      const assignment=beginBuildAssignment(root,"run","T001",root,"Implement T001");
      const initial=await foreman.builderAdapter().sendTurn(assignment.instruction);
      finishBuildAssignment(root,assignment,initial,{kind:"done",ticket:"T001"});
      const passed=await foreman.runPendingQaRecovery("T001",initial.text);
      assert.equal(passed.outcome,"passed",passed.detail);assert.equal(reviews,1);
      assert.equal(prompts.filter(p=>p.role==="builder").length,1,"saving guidance never dispatches Builder");
      const before=new WorkflowDb(root);try{assert.equal(before.qaTicketHead("run","T001").state,"passed");assert.ok(before.instruction(instructionId)!.deliveries.every(d=>d.state==="queued"));}finally{before.close();}
      if(scenario==="after-pass-pause"||scenario==="after-pass-withdraw") {
        const control=new BuildInterventionControl(root,"run","T001");const command=scenario==="after-pass-pause"?"/pause run T001 work":`/withdraw run T001 ${instructionId}`;
        try{control.enqueue(parseManagerAction(command,"change",control.revision())!,command);}finally{control.close();}
      }
      if(scenario==="after-pass-stale")saveTickets(join(root,".tickets/tickets.yaml"),[{...ticket,acceptance:["new unapproved requirement"]}]);
      if(scenario==="after-pass-drift")writeFileSync(join(root,"source.txt"),"source changed after the old pass\n");
      if(scenario==="after-pass-budget") {
        const stopped=await foreman.completePendingQaRecovery("T001");assert.equal(stopped.outcome,"needs-human");assert.match(stopped.detail!,/request-attempt/);assert.equal(reviews,1);assert.equal(prompts.filter(p=>p.role==="builder").length,1);
        const command="/request-attempt run T001 One Builder follow-up",control=new BuildInterventionControl(root,"run","T001");try{control.enqueue(parseManagerAction(command,"extra",control.revision())!,command);}finally{control.close();}
      }
      let recoveryForeman=foreman;
      if(scenario==="after-pass-fails") {
        const close=WorkflowDb.prototype.close;let interrupted=false;
        WorkflowDb.prototype.close=function(){const completed=this.operations("run").some(op=>(op.intent as {managerFollowup?:unknown}).managerFollowup&&op.status==="confirmed");close.call(this);if(completed&&!interrupted){interrupted=true;throw new Error("Host stopped after the completed follow-up receipt");}};
        try{const stopped=await foreman.completePendingQaRecovery("T001");assert.equal(stopped.outcome,"needs-human");assert.equal(reviews,1);assert.equal(prompts.filter(p=>p.role==="builder").length,2);}finally{WorkflowDb.prototype.close=close;}
        recoveryForeman=new Foreman(...args);
      }
      let resumed=scenario==="after-pass-fails"?await recoveryForeman.completePendingQaRecovery("T001"):scenario==="after-pass-repeat"?await foreman.runPendingQaRecovery("T001",initial.text):await foreman.completePendingQaRecovery("T001");
      if(scenario==="after-pass-fails") {
        assert.equal(resumed.outcome,"needs-human",resumed.detail);assert.equal(reviews,2);assert.equal(prompts.filter(p=>p.role==="builder").length,2,"follow-up used the last automatic attempt");
        const command="/request-attempt run T001 Fix the failure found after guidance",control=new BuildInterventionControl(root,"run","T001");try{control.enqueue(parseManagerAction(command,"post-guidance-fix",control.revision())!,command);}finally{control.close();}
        const repaired=await recoveryForeman.completePendingQaRecovery("T001");assert.equal(repaired.outcome,"passed",repaired.detail);assert.equal(reviews,3);assert.equal(prompts.filter(p=>p.role==="builder").length,3);return;
      }
      if(scenario==="after-pass-repeat") {
        assert.equal(resumed.outcome,"passed",resumed.detail);
        const command=`/guide-${target} run T001 ${advice}`,control=new BuildInterventionControl(root,"run","T001");try{instructionId=control.enqueue(parseManagerAction(command,"second-guide",control.revision())!,command).instructionId;}finally{control.close();}
        const stopped=await foreman.completePendingQaRecovery("T001");assert.equal(stopped.outcome,"needs-human");assert.match(stopped.detail!,/request-attempt/);assert.equal(reviews,2);assert.equal(prompts.filter(p=>p.role==="builder").length,2,"fresh QA never resets the automatic allowance");
        const extra="/request-attempt run T001 One further guidance follow-up",approval=new BuildInterventionControl(root,"run","T001");try{approval.enqueue(parseManagerAction(extra,"second-extra",approval.revision())!,extra);}finally{approval.close();}
        resumed=await foreman.completePendingQaRecovery("T001");
      }
      if(scenario==="after-pass-pause"||scenario==="after-pass-stale") {
        assert.equal(resumed.outcome,"needs-human",resumed.detail);assert.equal(reviews,1);assert.equal(prompts.filter(p=>p.role==="builder").length,1);return;
      }
      assert.equal(resumed.outcome,"passed",resumed.detail);assert.equal(reviews,scenario==="after-pass-repeat"?3:2);
      const check=new WorkflowDb(root);try{const old=(check as unknown as {db:import("better-sqlite3").Database}).db.prepare("SELECT consumed_by FROM qa_pass_certificates WHERE certificate_id=?").get(passed.passCertificateId) as {consumed_by:string};if(target!=="qa"&&scenario!=="after-pass-withdraw")assert.equal(old.consumed_by,"invalidated:builder-guidance-followup");assert.equal(check.qaAutomaticRemediationCount("run","T001"),target==="qa"||scenario==="after-pass-withdraw"||scenario==="after-pass-budget"?0:1);}finally{check.close();}
      if(scenario==="after-pass-withdraw") {assert.equal(prompts.filter(p=>p.role==="builder").length,1);return;}
    } else if(scenario==="extra-attempt") {
      const assignment=beginBuildAssignment(root,"run","T001",root,"Implement T001");
      const initial=await foreman.builderAdapter().sendTurn("Implement T001");
      finishBuildAssignment(root,assignment,initial,{kind:"done",ticket:"T001"});
      const stopped=await foreman.runPendingQaRecovery("T001",initial.text);
      assert.ok(["blocked","needs-human"].includes(stopped.outcome),stopped.detail);
      const command="/request-attempt run T001 One additional remediation only",control=new BuildInterventionControl(root,"run","T001");
      try {control.enqueue(parseManagerAction(command,"extra",control.revision())!,command);}finally{control.close();}
      const resumed=await foreman.completePendingQaRecovery("T001");assert.equal(resumed.outcome,"passed",resumed.detail);assert.equal(reviews,3);
    } else {
      const result=await foreman.runBatch(1);assert.equal(result.outcome,"all-done",result.detail);assert.equal(reviews,2);
    }
    const builderPrompt=prompts.find(prompt=>prompt.role==="builder"&&(prompt.text.includes("QA failure handoff ID:")||prompt.text.includes("Builder guidance follow-up after explicit resume.")))?.text??"";const qaPrompt=prompts.filter(prompt=>prompt.role==="qa").at(-1)!.text;
    if(target!=="qa")assert.ok(builderPrompt.includes(advice));else assert.ok(!builderPrompt.includes(advice));
    assert.ok(qaPrompt.includes(advice),"QA receives direct guidance or independent Builder verification context");
    const final=new WorkflowDb(root);try{const record=final.instruction(instructionId)!;assert.ok(record.deliveries.every(delivery=>delivery.state==="verified"),JSON.stringify(record));assert.equal(final.qaRemediationAttempts("run","T001").length,scenario==="extra-attempt"?2:scenario.startsWith("after-pass")?0:1);assert.equal(final.qaTicketHead("run","T001").state,"completed");}finally{final.close();}
  }finally{for(const adapter of adapters)await adapter.close();rmSync(root,{recursive:true,force:true});}
});


if(!process.env.RAFI_GUIDANCE_CRASH)for(const provider of ["claude","codex"] as const)for(const target of ["builder","both"] as const)for(const scenario of ["in-cycle","after-pass"])for(const boundary of ["reservation","submission","receipt"] as const)test(`${provider} ${target} ${scenario} guidance survives a process crash after ${boundary} through production wrappers`,{skip:process.platform==="win32"},()=>{
  const root=mkdtempSync(join(tmpdir(),"guidance-wrapper-crash-"));
  try {
    const child=spawnSync(process.execPath,["--import","tsx","--test",`--test-name-pattern=${provider} ${target} ${scenario} guidance reaches`,new URL(import.meta.url).pathname],{encoding:"utf8",timeout:60000,env:{...process.env,NODE_TEST_CONTEXT:undefined,RAFI_GUIDANCE_CRASH:boundary,RAFI_GUIDANCE_CRASH_ROOT:root}});
    // The test runner reports its killed worker as a failed process.
    assert.ok(child.signal==="SIGKILL"||child.stdout.includes("SIGKILL"),child.stdout+child.stderr);
    const db=new WorkflowDb(root);
    try {
      db.reconcileInstructionDeliveries("run","T001");
      const raw=(db as unknown as {db:import("better-sqlite3").Database}).db;
      const id=(raw.prepare("SELECT instruction_id FROM build_instructions WHERE request_id='guide'").get() as {instruction_id:string}).instruction_id;
      const delivery=db.instruction(id)!.deliveries.find(item=>item.recipient==="builder")!;
      assert.equal(delivery.state,boundary==="receipt"?(scenario==="after-pass"?"applied":"acknowledged"):"uncertain");
      if(boundary!=="receipt")assert.throws(()=>db.reserveGuidance("run","T001","builder","retry","source","Work"),/uncertain/);
      else assert.deepEqual(db.reserveGuidance("run","T001","builder","retry","source","Work").ids,[]);
      const dispatches=existsSync(join(root,".rafi/test-dispatches"))?readFileSync(join(root,".rafi/test-dispatches"),"utf8").trim().split("\n").length:0;
      assert.equal(dispatches,boundary==="reservation"?0:1);
      if(target==="both")assert.equal(db.instruction(id)!.deliveries.find(item=>item.recipient==="qa")!.state,"queued");
    } finally {db.close();}
  } finally {rmSync(root,{recursive:true,force:true});}
});
