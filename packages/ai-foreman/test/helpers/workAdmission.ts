import { existsSync } from "node:fs";
import { initializeSyntheticWork } from "../../src/buildSyntheticWork.js";
import { qaDigest } from "../../src/qaProtocolV2.js";
import { randomUUID } from "node:crypto";
import { WorkflowDb } from "../../src/workflowDb.js";
import { Foreman } from "../../src/foreman.js";
import { loadTicketsConfig, resolveTicketPaths } from "../../src/tickets/config.js";
import { loadTickets } from "../../src/tickets/ticketLoader.js";
import type { IsolatedQaOptions } from "../../src/qaReview.js";
import { runIsolatedQa } from "../../src/qaReview.js";
import { runBranchPlan, type BranchRunnerOptions } from "../../src/branch/runner.js";
import { createQaRecoveryPacket } from "../../src/qaRecovery.js";

/** Test setup uses the same explicit host admission service as production approval. */
export function admitFixtureWork(db:WorkflowDb,runId:string,ticketId:string,definition:unknown={id:ticketId}):void {
  db.ensureRun(runId);
  db.admitWork({runId,kind:"ticket",ticketId,definition,approvalId:"fixture-approval",scopeRevision:"fixture-revision",provenance:{userTurn:`Test explicitly authorizes ${ticketId} in ${runId}`,reason:"Authorized execution fixture"}});
}

export class AuthorizedForeman extends Foreman {
  constructor(...args:ConstructorParameters<typeof Foreman>) {
    if(args[5]) {
      args[22] ??= `fixture-${randomUUID()}`;
      const db=new WorkflowDb(args[5]);
      try {
        const path=resolveTicketPaths(loadTicketsConfig(args[5]),args[5]).tickets;
        const state=db.getRun(args[22]!)?.state;
        const scope=state?.version!==undefined&&Array.isArray(state.tickets)?state.tickets:undefined;
        if(existsSync(path)) {for(const ticket of loadTickets(path))if(!scope||scope.includes(ticket.id))admitFixtureWork(db,args[22]!,ticket.id,ticket);}
        else initializeSyntheticWork(args[5],args[22]!,10,"Explicit unticketed execution fixture");
      } finally {db.close();}
    }
    super(...args);
  }
}
export async function runAuthorizedQa(opts:IsolatedQaOptions) {
  const db=new WorkflowDb(opts.recovery.projectDir);
  try {admitFixtureWork(db,opts.recovery.runId,opts.ticket.id,opts.ticket);} finally {db.close();}
  return runIsolatedQa(opts);
}
export async function runAuthorizedBranchPlan(opts:BranchRunnerOptions) {
  const db=new WorkflowDb(opts.projectDir);
  try {for(const node of opts.plan.nodes)admitFixtureWork(db,opts.runId,node.ticket.id,node.ticket);} finally {db.close();}
  return runBranchPlan(opts);
}
export function createAuthorizedQaRecoveryPacket(input:Parameters<typeof createQaRecoveryPacket>[0]) {
  const db=new WorkflowDb(input.projectDir);
  try {if(!db.admittedWork(input.runId,input.ticketId))admitFixtureWork(db,input.runId,input.ticketId);}finally{db.close();}
  return createQaRecoveryPacket(input);
}


/** Source-bound fixture receipt, retained through the production turn journal. */
export function seedQaReceipt(db:WorkflowDb,runId:string,ticketId:string,reviewNumber:number,sourceStateDigest:string,reviewBasisDigest:string):string {
  const operationId=randomUUID(),at=new Date().toISOString();
  db.beginQaTurn({version:2,operationId,runId,ticketId,reviewNumber,sessionGeneration:0,slot:"initial",sourceStateDigest,reviewBasisDigest,instructionDigest:db.putEvidence("qa","Independent review"),intendedAt:at,providerSession:{version:2,provider:"codex",sessionId:operationId,role:"qa",stream:"qa",generation:0,cwd:"/tmp",configRoot:"/tmp",createdAt:at,validatedAt:at}});
  const receipt={version:2 as const,operationId,dispatch:"completed" as const,providerTurnId:operationId,terminalEventObserved:true,sourceStateDigest,reviewBasisDigest,completedAt:at,rawResponseDigest:db.putEvidence("qa",'STEP_STATUS: qa_pass | summary="Verified fixture"')};
  db.finishQaTurn(receipt);return qaDigest("turn-receipt",receipt);
}
