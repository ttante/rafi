import { realpathSync } from "node:fs";
import type Database from "better-sqlite3";
import { admitWork } from "./buildWorkAdmission.js";
import { qaDigest } from "./qaProtocolV2.js";

import { validateBuildOwnershipRepairV1, type BuildOwnershipRepairV1 } from "rafi-spec";
export type { BuildOwnershipRepairV1 } from "rafi-spec";
export function validateOwnershipRepair(value:unknown):asserts value is BuildOwnershipRepairV1 {
  const validation=validateBuildOwnershipRepairV1(value);
  if(!validation.valid)throw new Error(`Invalid ownership repair: ${validation.errors.join("; ")}`);
  const request=value as BuildOwnershipRepairV1;
  if([request.authorization,request.attestation].some(text=>!text.trim()||Buffer.byteLength(text)>16384))throw new Error("Repair requires bounded authorization and attestation");
  if(new Set(request.mapping.map(item=>item.path)).size!==request.mapping.length)throw new Error("Repair mapping paths must be unique");
}

/** Audited metadata repair; source separation/restoration must be inspected before this commit. */
export function reconcileWork(db:Database.Database,request:BuildOwnershipRepairV1,input:{revision:string;sourceDigest:string;definition:unknown;requiredPaths:string[];userTurn:string}):Record<string,unknown> {
  const prior=db.prepare("SELECT record_json FROM build_reconciliations WHERE reconciliation_id=?").get(request.requestId) as {record_json:string}|undefined;
  if(prior){const receipt=JSON.parse(prior.record_json);if(receipt.requestDigest!==qaDigest("ownership-repair-request",request))throw new Error("Repair idempotency key collision");return receipt;}
  if(request.expectedRevision!==input.revision||request.inspectedSourceDigest!==input.sourceDigest)throw new Error("Ownership or inspected source changed; inspect the current revision before repair");
  if(input.requiredPaths.some(path=>!request.mapping.some(item=>item.path===path&&item.workId===request.workId)))throw new Error("Every preserved change must have an inspected mapping to the authorized target work");
  if(request.mapping.some(item=>item.workId!==request.workId||!input.requiredPaths.includes(item.path)))throw new Error("Mapping contains a foreign work identity or an uninspected path");
  const uncertain=db.prepare("SELECT 1 FROM operation_journal WHERE run_id=? AND kind='provider-dispatch' AND status IN ('in_progress','uncertain')").get(request.runId);
  if(uncertain)throw new Error("Provider dispatch must be reconciled separately before ownership repair; attestation cannot establish nonexecution");
  if(request.choice==="link_provenance") {
    const decision=request.decisionId?db.prepare("SELECT * FROM human_decisions WHERE decision_id=? AND run_id=? AND status='answered'").get(request.decisionId,request.runId) as {decision_key:string;decision_json:string}|undefined:undefined;
    const approval=decision?JSON.parse(decision.decision_json):undefined;
    const assignments=db.prepare("SELECT intent_json,result_json FROM operation_journal WHERE run_id=? AND kind='build-assignment' AND json_extract(intent_json,'$.ticketId')=? AND status='confirmed'").all(request.runId,request.workId) as Array<{intent_json:string;result_json:string}>;
    const assignment=assignments.some(row=>{
      const intent=JSON.parse(row.intent_json),result=JSON.parse(row.result_json),session=result.providerMetadata?.sessionRef;
      if(result.rejection||result.sourceError||!result.turnId||!result.responseDigest||!result.after?.digest||!intent.before?.digest||intent.requirementsDigest!==qaDigest("admitted-requirements",input.definition)||!session||session.source!=="observed"||!session.validatedAt||session.role!=="builder"||session.ticketId!==request.workId)return false;
      try {if(realpathSync(session.cwd)!==realpathSync(intent.worktree))return false;}catch{return false;}
      return !!db.prepare("SELECT 1 FROM provider_sessions WHERE run_id=? AND role='builder' AND session_id=? AND session_ref_json=?").get(request.runId,session.sessionId,JSON.stringify(session));
    });
    const checkpoint=db.prepare("SELECT 1 FROM workflow_events WHERE run_id=? AND (json_extract(payload_json,'$.ticketId')=? OR json_extract(payload_json,'$.currentTicket')=?)").get(request.runId,request.workId,request.workId);
    if(!decision?.decision_key.includes(request.scopeRevision)||approval?.selectedChoiceId!=="proceed"||!assignment||!checkpoint)throw new Error("Approval, assignment and checkpoint provenance is incomplete; use explicit mapped-work authorization instead");
  }
  const now=new Date().toISOString();
  const state=(db.prepare("SELECT state FROM qa_ticket_heads WHERE run_id=? AND ticket_id=?").get(request.runId,request.workId) as {state:string}|undefined)?.state;
  const requiresFreshQa=request.choice!=="quarantine"&&state!=="completed"&&state!=="waived";
  const receipt={version:1,reconciliationId:request.requestId,runId:request.runId,workId:request.workId,requestDigest:qaDigest("ownership-repair-request",request),request,userTurn:input.userTurn,beforeRevision:input.revision,sourceDigest:input.sourceDigest, historicalAuthorityProven:request.choice==="link_provenance",requiresFreshQa,executionDisposition:request.choice==="quarantine"?"quarantined":state==="completed"?"terminal_metadata_repaired":state==="waived"?"existing_waiver_policy":"fresh_qa_required",executionReopened:false,providerReplayAuthorized:false,createdAt:now};
  db.prepare("INSERT INTO build_reconciliations VALUES(?,?,?,?,?)").run(request.requestId,request.runId,request.expectedRevision,JSON.stringify(receipt),now);
  if(request.choice==="quarantine") {
    db.prepare("UPDATE build_work_scope SET state='quarantined' WHERE run_id=? AND work_id=?").run(request.runId,request.workId);
    db.prepare("UPDATE build_ownership_conflicts SET record_json=json_set(record_json,'$.manualDecision',?),revision=revision+1 WHERE run_id=? AND work_id=? AND status='unresolved'").run(request.requestId,request.runId,request.workId);
    return receipt;
  }
  db.prepare("UPDATE build_work_scope SET state='admitted' WHERE run_id=? AND work_id=?").run(request.runId,request.workId);
  admitWork(db,{runId:request.runId,kind:"ticket",ticketId:request.workId,definition:input.definition,approvalId:request.requestId,scopeRevision:request.scopeRevision,provenance:{userTurn:input.userTurn,decisionId:request.decisionId,reason:request.choice==="link_provenance"?"Audited run-bound authorization provenance":"Operator explicitly authorized inspected preserved changes for fresh verification"}},true);
  db.prepare("UPDATE build_ownership_conflicts SET status='reconciled',revision=revision+1,record_json=json_set(record_json,'$.reconciliationId',?) WHERE run_id=? AND work_id=? AND status='unresolved'").run(request.requestId,request.runId,request.workId);
  // Retain every old byte and outcome. The audit permits fresh QA, never replay of this turn.
  db.prepare("UPDATE operation_journal SET result_json=json_set(COALESCE(result_json,'{}'),'$.reconciliationId',?,'$.replayForbidden',1),updated_at=? WHERE run_id=? AND kind='build-assignment' AND json_extract(intent_json,'$.ticketId')=?").run(request.requestId,now,request.runId,request.workId);
  return receipt;
}
