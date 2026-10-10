import { randomUUID } from "node:crypto";
import { WorkflowDb } from "./workflowDb.js";
import { buildScopeRevision } from "./buildApproval.js";
import type { TicketDef } from "./tickets/ticketSchema.js";

/** Explicit unticketed CLI mode freezes each work definition before its first dispatch. */
export function initializeSyntheticWork(projectDir:string,runId:string,steps:number,authorization:string,approvedPlan="Explicit unticketed work authorized by the host"):string[] {
  if(!Number.isSafeInteger(steps)||steps<1||steps>10000)throw new Error("Invalid synthetic work step limit");
  if(!approvedPlan.trim()||Buffer.byteLength(approvedPlan)>262144)throw new Error("Synthetic work requires a bounded, frozen approved preflight plan");
  const db=new WorkflowDb(projectDir);
  try {
    return db.atomic(()=>{
      db.ensureRun(runId);
      const existing=db.workDefinitions(runId).filter(work=>work.kind==="synthetic");
      if(existing.length)return existing.map(work=>work.workId);
      const ids:string[]=[];
      for(let step=1;step<=steps;step++) {
        const id=`synthetic:${randomUUID()}`;
        const definition:TicketDef={id,order:step,title:`Authorized unticketed step ${step}`,area:"project",priority:"P2",size:"M",risk:"Low",depends_on:[],summary:`Implement step ${step} of the explicitly authorized project work`,acceptance:["Satisfy the approved project requirements and the host preflight plan"],required_tests:["Run the relevant project validation"],likely_files:[],notes:`Frozen approved preflight plan:\n${approvedPlan}`};
        db.admitWork({runId,kind:"synthetic",workId:id,definition,approvalId:`unticketed:${runId}`,scopeRevision:buildScopeRevision(projectDir),provenance:{userTurn:authorization,reason:"Explicit unticketed CLI invocation after approval"}});
        ids.push(id);
      }
      return ids;
    });
  } finally {db.close();}
}
