import { WorkflowDb } from "./workflowDb.js";
import { WorkflowReader } from "./workflowReader.js";
import { readQaEvidenceSnapshot, evidenceRecord } from "./qaEvidenceReader.js";
import { assessBuildOwnership, ownershipRevision } from "./buildOwnershipReconciliation.js";
import { captureBuildSource } from "./buildAssignment.js";
import { buildScopeRevision } from "./buildApproval.js";
import { loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import { loadTickets } from "./tickets/ticketLoader.js";
import { bindBuildAuthority, checkpointBuildRun } from "./buildRuns.js";
import { classifyProcess } from "./processIdentity.js";
import { validateOwnershipRepair, type BuildOwnershipRepairV1 } from "./buildWorkReconciliation.js";
import type { BuildRunRecordV2 } from "rafi-spec";

export function prepareOwnershipRepair(projectDir:string,runId:string,workId:string) {
  const snapshot=readQaEvidenceSnapshot(projectDir,runId);
  if(snapshot.availability==="corrupt"||snapshot.availability==="unreadable"||snapshot.availability==="missing")throw new Error("Ownership evidence must be readable and intact before repair");
  const assignment=(snapshot.rows.operation_journal??[]).filter(row=>row.kind==="build-assignment"&&evidenceRecord(row,"intent_json")?.ticketId===workId).sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||String(a.idempotency_key).localeCompare(String(b.idempotency_key))).at(-1);
  const intent=assignment?evidenceRecord(assignment,"intent_json"):undefined;
  const worktree=typeof intent?.worktree==="string"?intent.worktree:projectDir;
  const source=captureBuildSource(worktree);
  const before=intent?.before as {pathInventory?:Array<{path:string}>}|undefined;
  const requiredPaths=[...new Set([...source.pathInventory.map(path=>path.path),...(before?.pathInventory??[]).map(path=>path.path)])].sort();
  return {runId,workId,expectedRevision:ownershipRevision(snapshot),inspectedSourceDigest:source.digest,scopeRevision:buildScopeRevision(projectDir),requiredPaths,worktree,sourceInventory:source.pathInventory,ownership:assessBuildOwnership(projectDir,runId,snapshot),sourceMutationAuthorized:false,choices:["link_provenance","authorize_mapped_work","quarantine"]};
}

export function repairOwnership(projectDir:string,value:unknown,userTurn:string,faults?:{afterDecision?():void;afterMembership?():void;afterLocalCommit?():void;afterPublication?():void}):Record<string,unknown> {
  validateOwnershipRepair(value);const request=value;
  if(!userTurn.trim().startsWith("/qa-repair ")||JSON.stringify(JSON.parse(userTurn.trim().slice("/qa-repair ".length)))!==JSON.stringify(request))throw new Error("Repair requires the original explicit host request");
  const reader=new WorkflowReader(projectDir);
  try {
    const lease=reader.currentLease();const admission=reader.buildAdmission();
    if(lease&&classifyProcess(lease.pid,lease.processStart,lease.host).state!=="dead"||admission&&classifyProcess(admission.pid,admission.processStart,admission.host).state!=="dead")throw new Error("Stop and verify the build owner before repairing ownership");
  } finally {reader.close();}
  const db=new WorkflowDb(projectDir);
  let authority:ReturnType<WorkflowDb["acquireBuildRecoveryAdmission"]>|undefined;
  let lease:ReturnType<WorkflowDb["acquireLease"]>|undefined;
  try {
    authority=db.acquireBuildRecoveryAdmission(request.runId);
    lease=db.acquireLease(request.runId);
    const prior=db.reconciliation(request.requestId);
    const plan=prepareOwnershipRepair(projectDir,request.runId,request.workId);
    if(request.scopeRevision!==plan.scopeRevision)throw new Error("Requirements changed after the repair was prepared; inspect and approve current scope");
    if(prior && prior.sourceDigest!==plan.inspectedSourceDigest)throw new Error("Inspected source changed after the committed repair; prepare a new reconciliation before publication");
    const definition=loadTickets(resolveTicketPaths(loadTicketsConfig(projectDir),projectDir).tickets).find(ticket=>ticket.id===request.workId);
    if(!definition&&request.choice!=="quarantine")throw new Error("Approved target ticket definition is unavailable; preserve quarantine until scope is resolved");
    const receipt=db.atomic(()=>{
      faults?.afterDecision?.();
      const receipt=db.reconcileWork(request,{revision:plan.expectedRevision,sourceDigest:plan.inspectedSourceDigest,definition,requiredPaths:plan.requiredPaths,userTurn});
      faults?.afterMembership?.();
      if(prior&&!prior.executionDisposition&&request.choice!=="quarantine"&&!["completed","waived"].includes(db.qaTicketHead(request.runId,request.workId).state)) {
        // Compatibility for old receipts: retire only certificates predating
        // this repair, never a fresh review issued after its committed outcome.
        db.invalidateUnconsumedQaPassCertificates(request.runId,request.workId,"ownership-repair",new Date(),String(prior.createdAt));
      }
      if(!prior&&request.choice!=="quarantine") {
        const head=db.qaTicketHead(request.runId,request.workId);
        if(!["completed","waived"].includes(head.state)) db.invalidateUnconsumedQaPassCertificates(request.runId,request.workId,"ownership-repair");
        if(!["idle","operator-menu","completed","waived"].includes(head.state)) {
          if(head.state==="passed")db.transitionQa(request.runId,request.workId,head.revision,{type:"pass-invalidated",reason:"Ownership repair requires fresh QA on inspected source"});
          else if(!["finalizing","remediation-intended"].includes(head.state))db.transitionQa(request.runId,request.workId,head.revision,{type:"operator-menu"});
          else throw new Error("Reconcile pending finalization/remediation before ownership repair");
        }
        const packet=db.qaRecoveryHead(request.runId,request.workId);
        if(packet && packet.pendingAction!=="resolved") db.putQaRecoveryHead({...packet,pendingAction:"resolved"});
        if(!prior)db.transition(request.runId,{checkpoint:"ownership-reconciled",event:"build_ownership_reconciled",payload:{...receipt,retainedHistoricalPacket:packet}});
      }
      return receipt;
    });
    faults?.afterLocalCommit?.();
    if(request.choice!=="quarantine") {
      // Publication remains journaled separately; an interrupted publication can be repeated.
      const state=db.getRun(request.runId)?.state;
      if(state?.version!==undefined)checkpointBuildRun(projectDir,bindBuildAuthority(state as unknown as BuildRunRecordV2,lease),"ownership-reconciled");
    }
    faults?.afterPublication?.();
    // Older immutable receipts used requiresFreshQa for every non-quarantine
    // repair. Clarify execution eligibility without rewriting that history.
    const head=db.qaTicketHead(request.runId,request.workId);
    return receipt.executionDisposition ? receipt : {...receipt,executionDisposition:request.choice==="quarantine"?"quarantined":head.state==="completed"?"terminal_metadata_repaired":head.state==="waived"?"existing_waiver_policy":"fresh_qa_required",requiresFreshQa:request.choice!=="quarantine"&&!["completed","waived"].includes(head.state),executionReopened:false};
  } finally {
    try {if(lease)db.releaseLease(lease);} finally {try {if(authority)db.releaseBuildAdmission(authority);} finally {db.close();}}
  }
}
