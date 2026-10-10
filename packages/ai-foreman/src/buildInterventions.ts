import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { realpathSync as realpath } from "node:fs";
import type { ManagerActionRequestV1 } from "rafi-spec";
import { validateManagerActionRequestV1 } from "rafi-spec";
import { registerHandbackWriter } from "./qaHandbackMigration.js";
import { assertAdmittedWork } from "./buildWorkAdmission.js";

export type InstructionRecipient = "builder" | "qa";
export type InstructionState = "queued" | "reserved" | "delivered" | "acknowledged" | "applied" | "verified" | "uncertain" | "rejected" | "superseded" | "withdrawn";
export interface BuildInstruction {
  instructionId: string; request: ManagerActionRequestV1; sequence: number; userTurn: string;
  textDigest: string; requirementsDigest: string; createdAt: string;
  basis: {assignmentId:string;scopeRevision:string;reviewAttemptId?:string;sourceDigest?:string};
  deliveries: Array<{recipient:InstructionRecipient;state:InstructionState;operationId?:string;sourceDigest?:string;instructionDigest?:string;receipt?:unknown;detail?:string}>;
}
export class BuildControlBoundary extends Error {}

export function migrateBuildInterventions(db: Database.Database): void {
  if (db.prepare("SELECT 1 FROM recovery_schema_migrations WHERE migration='005_manager_controls'").get()) return;
  db.transaction(() => {
    db.exec(`CREATE TABLE build_instruction_streams(run_id TEXT NOT NULL,work_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(run_id,work_id),FOREIGN KEY(run_id,work_id) REFERENCES build_work_scope(run_id,work_id));
      CREATE TABLE build_instructions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,instruction_id TEXT NOT NULL UNIQUE,request_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL,work_id TEXT NOT NULL,record_json TEXT NOT NULL,FOREIGN KEY(run_id,work_id) REFERENCES build_work_scope(run_id,work_id));
      CREATE TABLE build_instruction_deliveries(instruction_id TEXT NOT NULL REFERENCES build_instructions(instruction_id),recipient TEXT NOT NULL CHECK(recipient IN ('builder','qa')),state TEXT NOT NULL,operation_id TEXT UNIQUE,record_json TEXT NOT NULL,PRIMARY KEY(instruction_id,recipient));
      CREATE TABLE build_instruction_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,instruction_id TEXT NOT NULL REFERENCES build_instructions(instruction_id),recipient TEXT,event_json TEXT NOT NULL,created_at TEXT NOT NULL);`);
    for (const table of ["build_instruction_streams","build_instructions","build_instruction_deliveries","build_instruction_events"]) for (const action of ["INSERT","UPDATE","DELETE"]) db.exec(`CREATE TRIGGER control_protocol_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT CASE WHEN rafi_writer_protocol()<>4 THEN RAISE(ABORT,'incompatible Manager control writer') END; END`);
    for (const table of ["build_instructions","build_instruction_events"]) for (const action of ["UPDATE","DELETE"]) db.exec(`CREATE TRIGGER control_immutable_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Instruction history is immutable'); END`);
    for(const table of ["build_instructions","build_instruction_streams"])for(const action of ["INSERT","UPDATE"])db.exec(`CREATE TRIGGER control_admitted_${table}_${action} BEFORE ${action} ON ${table} WHEN NOT EXISTS(SELECT 1 FROM build_work_scope s WHERE s.run_id=NEW.run_id AND s.work_id=NEW.work_id AND s.state='admitted') BEGIN SELECT RAISE(ABORT,'Instruction work is not admitted'); END`);
    db.exec(`CREATE TRIGGER control_delivery_insert BEFORE INSERT ON build_instruction_deliveries WHEN NEW.state NOT IN ('queued','withdrawn') BEGIN SELECT RAISE(ABORT,'New controls cannot claim provider execution'); END;
      CREATE TRIGGER control_delivery_identity BEFORE UPDATE ON build_instruction_deliveries WHEN NEW.instruction_id<>OLD.instruction_id OR NEW.recipient<>OLD.recipient BEGIN SELECT RAISE(ABORT,'Instruction recipient identity is immutable'); END;`);
    db.prepare("INSERT INTO recovery_schema_migrations VALUES('005_manager_controls',?)").run(new Date().toISOString());
  }).immediate();
}

/** Questions belong to work through their ticket interruption or retained remediation stop. */
export function decisionBelongsToWork(decision: {decisionId:string;runId:string;interruptionId:string}, runId:string, workId:string, stops:Array<{runId:string;workId:string;operationId:string;decisionId?:string}>):boolean {
  return !!decision && decision.runId===runId && (decision.interruptionId===`ticket:${workId}` || stops.some(stop=>stop.runId===runId&&stop.workId===workId&&stop.operationId===decision.interruptionId&&stop.decisionId===decision.decisionId));
}
export function decisionWorkId(db:Database.Database, decision:{decisionId:string;runId:string;interruptionId:string}):string|undefined {
  if(decision.interruptionId.startsWith("ticket:"))return decision.interruptionId.slice(7);
  const rows=db.prepare("SELECT run_id,ticket_id,operation_id,record_json FROM qa_remediation_stops WHERE run_id=? AND operation_id=?").all(decision.runId,decision.interruptionId) as Array<{run_id:string;ticket_id:string;operation_id:string;record_json:string}>;
  const matches=rows.filter(row=>JSON.parse(row.record_json).decisionId===decision.decisionId);
  return matches.length===1?matches[0]!.ticket_id:undefined;
}

/** A proposal never authorizes itself. Only exact commands from the original user turn do. */
export function parseManagerAction(userTurn: string, requestId: string = randomUUID(), expectedRevision = 0): ManagerActionRequestV1 | undefined {
  const natural = userTurn.trimStart().match(/^(?:guide|tell) (builder|qa|both) (?:for )?run ([A-Za-z0-9_.:-]+) (?:ticket|work) ([A-Za-z0-9_.:-]+):[ \t]?([\s\S]+)$/i);
  const command = natural ? `/guide-${natural[1]!.toLowerCase()} ${natural[2]} ${natural[3]} ${natural[4]}` : userTurn.trimStart();
  const match = command.match(/^\/(guide-builder|guide-qa|guide-both|pause|request-attempt|withdraw|supersede|answer-question)\s+(\S+)\s+(\S+)(?:[ \t]([\s\S]*))?$/);
  if (!match) return undefined;
  const action = match[1]!.replaceAll("-","_") as ManagerActionRequestV1["action"];
  const tail = match[4] ?? "";
  const request: ManagerActionRequestV1 = {version:1,requestId,runId:match[2]!,workId:match[3]!,action,text:tail,expectedRevision};
  if (action === "withdraw" || action === "supersede") {
    const target = tail.match(/^(\S+)(?:[ \t]([\s\S]*))?$/);
    request.instructionId = target?.[1]; request.text = target?.[2] ?? "";
  }
  if (action === "answer_question") {
    const answer = tail.match(/^(\S+)\s+(\S+)(?:[ \t]([\s\S]*))?$/);
    request.decisionId = answer?.[1]; request.decisionRevision = answer?.[2]; request.text = answer?.[3] ?? "";
  }
  if (action === "pause") { request.pauseScope = tail === "run" ? "run" : "work"; request.text = "Pause at the next safe boundary"; }
  const validation = validateManagerActionRequestV1(request);
  if (!validation.valid) throw new Error(`Invalid Manager action: ${validation.errors.join("; ")}`);
  return request;
}

/** Narrow write capability coexists with a build lease and cannot dispatch or publish workflow state. */
export class BuildInterventionControl {
  private readonly db: Database.Database;
  constructor(projectDir: string, private readonly runId: string, private readonly workId: string) {
    this.db = new Database(join(projectDir,".rafi/recovery.sqlite3"),{fileMustExist:true});
    try {
      registerHandbackWriter(this.db);
      if (this.db.pragma("user_version",{simple:true}) !== 4) throw new Error("Manager controls require the work-admission upgrade");
      const project = this.db.prepare("SELECT canonical_root FROM build_project_identity").get() as {canonical_root:string};
      if (project.canonical_root !== realpath(projectDir)) throw new Error("Control project identity mismatch");
      assertAdmittedWork(this.db,runId,workId);
      // Every existing table is denied except the scoped enqueue stream. No leases, tracker, QA or budget writes.
      const quote = (value:string) => (this.db.prepare("SELECT quote(?) AS q").get(value) as {q:string}).q;
      for (const {name} of this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>) {
        for (const action of ["INSERT","UPDATE","DELETE"]) {
          let condition = "";
          if (["build_instructions","build_instruction_streams"].includes(name) && action !== "DELETE") condition = `WHEN NEW.run_id<>${quote(runId)} OR NEW.work_id<>${quote(workId)}`;
          else if (["build_instruction_deliveries","build_instruction_events"].includes(name) && action === "INSERT") condition = `WHEN NOT EXISTS(SELECT 1 FROM build_instructions i WHERE i.instruction_id=NEW.instruction_id AND i.run_id=${quote(runId)} AND i.work_id=${quote(workId)})`;
          if (name === "build_instruction_deliveries" && action === "UPDATE") condition = `WHEN OLD.state<>'queued' OR NEW.state NOT IN ('withdrawn','superseded') OR NEW.instruction_id<>OLD.instruction_id OR NEW.recipient<>OLD.recipient OR NEW.operation_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM build_instructions i WHERE i.instruction_id=NEW.instruction_id AND i.run_id=${quote(runId)} AND i.work_id=${quote(workId)})`;
          this.db.exec(`CREATE TEMP TRIGGER enqueue_only_${name}_${action} BEFORE ${action} ON main."${name}" ${condition} BEGIN SELECT RAISE(ABORT,'Manager enqueue capability cannot mutate this record'); END`);
        }
      }
    } catch (error) {this.db.close();throw error;}
  }
  close():void {this.db.close();}
  revision():number {return (this.db.prepare("SELECT revision FROM build_instruction_streams WHERE run_id=? AND work_id=?").get(this.runId,this.workId) as {revision:number}|undefined)?.revision ?? 0;}
  enqueue(request:ManagerActionRequestV1,userTurn:string):BuildInstruction {
    const parsed = parseManagerAction(userTurn,request.requestId,request.expectedRevision);
    if (!parsed || JSON.stringify(parsed)!==JSON.stringify(request) || request.runId!==this.runId || request.workId!==this.workId) throw new Error("Action requires the exact original user command and resolved scope");
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT instruction_id,record_json FROM build_instructions WHERE request_id=?").get(request.requestId) as {instruction_id:string;record_json:string}|undefined;
      if (previous) {
        const record = JSON.parse(previous.record_json) as BuildInstruction;
        if (JSON.stringify(record.request)!==JSON.stringify(request) || record.userTurn!==userTurn) throw new Error("Idempotency key was reused with different authorization");
        return instruction(this.db,previous.instruction_id)!;
      }
      if (this.revision()!==request.expectedRevision) throw new Error("Instruction stream changed; refresh and revise the request");
      const admission = assertAdmittedWork(this.db,this.runId,this.workId);
      const run = this.db.prepare("SELECT status FROM workflow_runs WHERE run_id=?").get(this.runId) as {status:string};
      if (["completed","cancelled","superseded"].includes(run.status)) throw new Error("Cannot enqueue instructions for terminal work");
      const latest=this.db.prepare("SELECT attempt_id,source_digest,status FROM qa_review_attempts WHERE run_id=? AND ticket_id=? ORDER BY review_number DESC LIMIT 1").get(this.runId,this.workId) as {attempt_id:string;source_digest:string;status:string}|undefined;
      if(request.action==="answer_question") {
        const row=this.db.prepare("SELECT decision_json,status FROM human_decisions WHERE decision_id=? AND run_id=?").get(request.decisionId,this.runId) as {decision_json:string;status:string}|undefined;
        const decision=row?JSON.parse(row.decision_json):undefined;
        if(!row||row.status!=="pending"||decisionWorkId(this.db,decision)!==this.workId||hash(row.decision_json)!==request.decisionRevision)throw new Error("Question is stale or belongs to another scope; refresh the pending decision");
      }
      if(request.action==="request_attempt"&&latest?.status!=="failed"&&!(latest?.status==="passed"&&hasQueuedBuilderGuidance(this.db,this.runId,this.workId)))throw new Error("An extra attempt requires a current failed review or waiting Builder guidance after a pass");
      const state=this.db.prepare("SELECT state_json FROM workflow_runs WHERE run_id=?").get(this.runId) as {state_json:string};
      if(JSON.parse(state.state_json).qaEnabled===false&&["guide_qa","guide_both","request_attempt"].includes(request.action))throw new Error("QA is disabled for this run; QA guidance cannot be delivered");
      let priorRecipients: InstructionRecipient[] | undefined;
      if (request.action === "withdraw" || request.action === "supersede") {
        const prior = instruction(this.db,request.instructionId!);
        if (!prior || prior.request.runId!==this.runId || prior.request.workId!==this.workId) throw new Error("Instruction belongs to another scope");
        if (prior.deliveries.some(delivery => delivery.state!=="queued")) throw new Error("Reserved or delivered guidance cannot be withdrawn; enqueue compensating guidance");
        if (request.action === "supersede" && !["guide_builder","guide_qa","guide_both","supersede"].includes(prior.request.action)) throw new Error("Only guidance may be superseded; withdraw this control explicitly");
        priorRecipients = prior.deliveries.map(delivery => delivery.recipient);
        for (const delivery of prior.deliveries) setDelivery(this.db,prior.instructionId,{...delivery,state:request.action === "withdraw" ? "withdrawn" : "superseded"});
      }
      const recipients:InstructionRecipient[] = priorRecipients ?? (request.action === "guide_builder" ? ["builder"] : request.action === "guide_qa" ? ["qa"] : request.action === "guide_both" ? ["builder","qa"] : ["builder"]);
      const record:BuildInstruction = {instructionId:randomUUID(),request,sequence:(this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM build_instructions").get() as {n:number}).n,userTurn,textDigest:hash(request.text),requirementsDigest:admission.requirementsDigest,createdAt:new Date().toISOString(),basis:{assignmentId:admission.assignmentId,scopeRevision:admission.scopeRevision,...(latest ? {reviewAttemptId:latest.attempt_id,sourceDigest:latest.source_digest} : {})},deliveries:recipients.map(recipient=>({recipient,state:request.action === "withdraw" ? "withdrawn" : "queued"}))};
      this.db.prepare("INSERT INTO build_instructions VALUES(?,?,?,?,?,?)").run(record.sequence,record.instructionId,request.requestId,this.runId,this.workId,JSON.stringify(record));
      this.db.prepare("INSERT INTO build_instruction_streams VALUES(?,?,?) ON CONFLICT(run_id,work_id) DO UPDATE SET revision=excluded.revision").run(this.runId,this.workId,request.expectedRevision+1);
      for (const delivery of record.deliveries) {this.db.prepare("INSERT INTO build_instruction_deliveries VALUES(?,?,?,NULL,?)").run(record.instructionId,delivery.recipient,delivery.state,JSON.stringify(delivery));event(this.db,record.instructionId,delivery.recipient,delivery);}
      return record;
    }).immediate();
  }
}

const hash = (text:string) => createHash("sha256").update(text).digest("hex");
export function instruction(db:Database.Database,id:string):BuildInstruction|undefined {
  const row = db.prepare("SELECT record_json FROM build_instructions WHERE instruction_id=?").get(id) as {record_json:string}|undefined;
  if (!row) return undefined;
  return {...JSON.parse(row.record_json),deliveries:(db.prepare("SELECT record_json FROM build_instruction_deliveries WHERE instruction_id=? ORDER BY recipient").all(id) as Array<{record_json:string}>).map(row=>JSON.parse(row.record_json))};
}
function event(db:Database.Database,id:string,recipient:string,value:unknown):void {db.prepare("INSERT INTO build_instruction_events(instruction_id,recipient,event_json,created_at) VALUES(?,?,?,?)").run(id,recipient,JSON.stringify(value),new Date().toISOString());}
function setDelivery(db:Database.Database,id:string,delivery:BuildInstruction["deliveries"][number]):void {db.prepare("UPDATE build_instruction_deliveries SET state=?,operation_id=?,record_json=? WHERE instruction_id=? AND recipient=?").run(delivery.state,delivery.operationId??null,JSON.stringify(delivery),id,delivery.recipient);event(db,id,delivery.recipient,delivery);}

/** Restart consumes retained completion proof, never sends a replacement provider turn. */
export function reconcileGuidance(db:Database.Database,runId:string,workId:string):void {
  const records=(db.prepare("SELECT instruction_id FROM build_instructions WHERE run_id=? AND work_id=? ORDER BY sequence").all(runId,workId) as Array<{instruction_id:string}>).map(row=>instruction(db,row.instruction_id)!);
  for(const record of records)for(const delivery of record.deliveries) {
    if(!["reserved","uncertain"].includes(delivery.state)||!delivery.operationId)continue;
    const suffix=`:${record.instructionId}:${delivery.recipient}`;
    if(!delivery.operationId.endsWith(suffix))throw new Error("Instruction dispatch linkage is corrupt");
    const operationId=delivery.operationId.slice(0,-suffix.length);
    let receipt: Record<string,unknown>|undefined;
    let state: InstructionState="uncertain";
    if(delivery.recipient==="qa") {
      const turn=db.prepare("SELECT receipt_json FROM qa_turns WHERE operation_id=? AND run_id=? AND ticket_id=? AND source_state_digest=?").get(operationId,runId,workId,delivery.sourceDigest) as {receipt_json:string|null}|undefined;
      if(turn?.receipt_json) {
        const retained=JSON.parse(turn.receipt_json);
        if(retained.dispatch==="completed"&&retained.terminalEventObserved&&retained.providerTurnId) {receipt=retained;state="applied";}
        else if(retained.dispatch==="not-dispatched") {receipt=retained;state="rejected";}
      }
    } else {
      const assignment=db.prepare("SELECT status,result_json FROM operation_journal WHERE idempotency_key=? AND run_id=? AND kind='build-assignment' AND json_extract(intent_json,'$.ticketId')=?").get(operationId,runId,workId) as {status:string;result_json:string|null}|undefined;
      if(assignment?.result_json) {
        const retained=JSON.parse(assignment.result_json);
        if(assignment.status==="confirmed"&&retained.turnId&&!retained.rejection&&!retained.sourceError) {receipt={turnId:retained.turnId,responseDigest:retained.responseDigest,providerInstructionDigest:retained.providerInstructionDigest,postSourceDigest:retained.after?.digest};state="acknowledged";}
        else if(retained.dispatchState==="not-sent") {receipt=retained;state="rejected";}
      } else {
        const turn=db.prepare("SELECT d.record_json FROM qa_delivery_turns d JOIN qa_reports r ON r.report_occurrence_id=d.report_occurrence_id WHERE d.operation_id=? AND d.kind='remediation' AND r.run_id=? AND r.ticket_id=?").get(operationId,runId,workId) as {record_json:string}|undefined;
        if(turn) {const retained=JSON.parse(turn.record_json);if(retained.status==="completed"&&retained.providerTurnId&&retained.terminalCount>0) {receipt=retained;state="acknowledged";}else if(retained.failure?.dispatchState==="not-sent"){receipt=retained;state="rejected";}}
      }
    }
    if(receipt && state!=="rejected") {
      const digest=receipt.providerInstructionDigest;
      const bytes=typeof digest==="string"?(db.prepare("SELECT content FROM content_refs WHERE digest=?").get(digest) as {content:Buffer}|undefined)?.content:undefined;
      if(!bytes||hash(bytes.toString("utf8"))!==digest||!bytes.toString("utf8").includes(`Instruction ${record.instructionId} (${record.textDigest}):\n${record.request.text}`)) {state="uncertain";receipt=undefined;}
    }
    if(state!==delivery.state || receipt)setDelivery(db,record.instructionId,{...delivery,state,...(receipt?{receipt}:{}),detail:state==="uncertain"?"No correlated durable completion proof; reconcile provider execution before retry":state==="rejected"?"Retained receipt proves this guidance was not submitted; a new explicit instruction may be queued":"Recovered correlated completion receipt; no provider replay"});
  }
}

export function queuedControls(db:Database.Database,runId:string,workId:string):BuildInstruction[] {
  return (db.prepare("SELECT instruction_id FROM build_instructions WHERE run_id=? AND work_id=? ORDER BY sequence").all(runId,workId) as Array<{instruction_id:string}>).map(row=>instruction(db,row.instruction_id)!).filter(record=>["answer_question","request_attempt"].includes(record.request.action)&&record.deliveries[0]?.state==="queued");
}
export function hasQueuedBuilderGuidance(db:Database.Database,runId:string,workId:string):boolean {
  return Boolean(db.prepare("SELECT 1 FROM build_instructions i JOIN build_instruction_deliveries d USING(instruction_id) WHERE i.run_id=? AND i.work_id=? AND d.recipient='builder' AND d.state='queued' AND json_extract(i.record_json,'$.request.action') IN ('guide_builder','guide_both','supersede') LIMIT 1").get(runId,workId));
}
export function completeControl(db:Database.Database,id:string,receipt:unknown,rejection?:string):void {
  const record=instruction(db,id)!;
  for(const delivery of record.deliveries) setDelivery(db,id,{...delivery,state:rejection?"rejected":"applied",receipt,detail:rejection});
}
export function assertFinalizationControls(db:Database.Database,runId:string,workId:string):void {
  const pending=(db.prepare("SELECT i.record_json,d.state FROM build_instructions i JOIN build_instruction_deliveries d USING(instruction_id) WHERE i.run_id=? AND d.state IN ('queued','reserved','uncertain')").all(runId) as Array<{record_json:string;state:string}>).map(row=>({...JSON.parse(row.record_json) as BuildInstruction,state:row.state}));
  if(pending.some(record=>record.request.workId===workId||record.request.action==="pause"&&record.request.pauseScope==="run")) throw new BuildControlBoundary("Manager controls arrived before finalization; preserve this pass and resume at the authorized control boundary before further mutation");
}

export function builderVerificationContext(db:Database.Database,runId:string,workId:string,sourceDigest:string):{text:string;ids:string[]} {
  const records=(db.prepare("SELECT instruction_id FROM build_instructions WHERE run_id=? AND work_id=? ORDER BY sequence").all(runId,workId) as Array<{instruction_id:string}>).map(row=>instruction(db,row.instruction_id)!);
  const eligible=records.filter(record=>(record.request.action==="guide_builder"||record.request.action==="supersede"&&!record.deliveries.some(delivery=>delivery.recipient==="qa"))&&record.deliveries.some(delivery=>delivery.recipient==="builder"&&["acknowledged","applied"].includes(delivery.state)&&(delivery.receipt as {postSourceDigest?:string}|undefined)?.postSourceDigest===sourceDigest));
  return {ids:eligible.map(record=>record.instructionId),text:eligible.length?"\n\nBuilder guidance awaiting independent verification on this exact source:\n"+eligible.map(record=>`Instruction ${record.instructionId}: ${record.request.text}`).join("\n")+"\nOnly for a relevant result independently established with supporting evidence, emit MANAGER_INSTRUCTION_VERIFIED: <instruction ID>. A general pass alone is insufficient.":""};
}

export function verifyBuilderGuidance(db:Database.Database,ids:string[],certificate:{certificateId:string;sourceStateDigest:string;reviewBasisDigest:string},response:string,turnReceiptDigest:string):void {
  const verified=new Set([...response.matchAll(/^MANAGER_INSTRUCTION_VERIFIED:\s*([A-Za-z0-9_.:-]+)\s*$/gm)].map(match=>match[1]));
  for(const id of ids) {
    if(!verified.has(id))continue;
    const record=instruction(db,id)!;
    if(!db.prepare("SELECT 1 FROM qa_pass_certificates WHERE certificate_id=? AND run_id=? AND ticket_id=? AND source_state_digest=? AND review_basis_digest=? AND turn_receipt_digest=?").get(certificate.certificateId,record.request.runId,record.request.workId,certificate.sourceStateDigest,certificate.reviewBasisDigest,turnReceiptDigest))throw new Error("Builder instruction verification certificate is not durably bound to this work and review turn");
    const delivery=record.deliveries.find(delivery=>delivery.recipient==="builder");
    if(!delivery||!["acknowledged","applied"].includes(delivery.state)||(delivery.receipt as {postSourceDigest?:string}|undefined)?.postSourceDigest!==certificate.sourceStateDigest)throw new Error("Builder instruction verification source mismatch");
    setDelivery(db,id,{...delivery,state:"verified",receipt:{deliveryReceipt:delivery.receipt,verification:certificate,independentQaTurnReceiptDigest:turnReceiptDigest}});
  }
}

/** Called only inside the owning process's existing dispatch transaction. */
export function reserveGuidance(db:Database.Database,runId:string,workId:string,recipient:InstructionRecipient,operationId:string,sourceDigest:string,instructionText:string,reserve = true):{text:string;ids:string[]} {
  return db.transaction(() => {
    const admission = assertAdmittedWork(db,runId,workId);
    reconcileGuidance(db,runId,workId);
    const records = (db.prepare("SELECT instruction_id FROM build_instructions WHERE run_id=? ORDER BY sequence").all(runId) as Array<{instruction_id:string}>).map(row=>instruction(db,row.instruction_id)!);
    const relevant = records.filter(record => record.request.workId===workId || record.request.action==="pause" && record.request.pauseScope==="run");
    if (relevant.some(record=>record.request.action==="pause" && record.deliveries.some(delivery=>delivery.state==="queued"||delivery.state==="reserved"))) throw new BuildControlBoundary("Manager pause is active at this safe boundary; guidance remains queued");
    if (relevant.some(record=>record.deliveries.some(delivery=>delivery.recipient===recipient && ["reserved","uncertain"].includes(delivery.state)))) throw new BuildControlBoundary("Instruction dispatch is uncertain; reconcile before replay");
    const eligible = relevant.filter(record=>["guide_builder","guide_qa","guide_both","supersede"].includes(record.request.action) && record.deliveries.some(delivery=>delivery.recipient===recipient&&delivery.state==="queued"));
    const selected:BuildInstruction[]=[];
    for (const record of eligible) {
      const delivery = record.deliveries.find(delivery=>delivery.recipient===recipient)!;
      if (record.requirementsDigest!==admission.requirementsDigest || record.basis.assignmentId!==admission.assignmentId || record.basis.scopeRevision!==admission.scopeRevision) {setDelivery(db,record.instructionId,{...delivery,state:"rejected",detail:"Requirements changed; renewed scope approval and guidance are required"});continue;}
      if (recipient==="qa" && record.deliveries.some(delivery=>delivery.recipient==="builder") && !record.deliveries.some(delivery=>delivery.recipient==="builder"&&["acknowledged","applied","verified"].includes(delivery.state))) throw new BuildControlBoundary("Both-agent guidance is waiting for Builder's scoped response before a fresh QA review");
      selected.push(record);
    }
    const text = instructionText + (selected.length ? "\n\nAuthorized one-use Manager guidance (mandatory requirements and findings still apply):\n"+selected.map(record=>`Instruction ${record.instructionId} (${record.textDigest}):\n${record.request.text}`).join("\n\n") + (recipient==="qa" ? "\nFor each instruction whose relevant result you independently established on this source, include MANAGER_INSTRUCTION_VERIFIED: <instruction ID> with the supporting verification evidence. A general passing review alone does not verify an unrelated instruction." : "\nReport each instruction ID whose requested action you applied, with evidence; delivery alone is not independent verification.") : "");
    if (reserve) for (const record of selected) setDelivery(db,record.instructionId,{recipient,state:"reserved",operationId:`${operationId}:${record.instructionId}:${recipient}`,sourceDigest,instructionDigest:hash(text)});
    return {text,ids:selected.map(record=>record.instructionId)};
  }).immediate();
}
export function finishGuidance(db:Database.Database,ids:string[],recipient:InstructionRecipient,result:{submitted:boolean|undefined;receipt?:unknown;applied?:boolean}):void {
  db.transaction(()=>{for(const id of ids){const record=instruction(db,id)!;const delivery=record.deliveries.find(delivery=>delivery.recipient===recipient)!;if(delivery.state!=="reserved")throw new Error("Instruction reservation changed");setDelivery(db,id,{...delivery,state:result.submitted===false?"rejected":result.submitted===undefined?"uncertain":result.applied?"applied":result.receipt?"acknowledged":"delivered",receipt:result.receipt});}}).immediate();
}

export function verifyGuidance(db:Database.Database,ids:string[],certificate:{certificateId:string;sourceStateDigest:string;reviewBasisDigest:string},response:string):void {
  const verified=new Set([...response.matchAll(/^MANAGER_INSTRUCTION_VERIFIED:\s*([A-Za-z0-9_.:-]+)\s*$/gm)].map(match=>match[1]));
  for(const id of ids) {
    if(!verified.has(id))continue;
    const record=instruction(db,id)!;
    if(!db.prepare("SELECT 1 FROM qa_pass_certificates WHERE certificate_id=? AND run_id=? AND ticket_id=? AND source_state_digest=? AND review_basis_digest=?").get(certificate.certificateId,record.request.runId,record.request.workId,certificate.sourceStateDigest,certificate.reviewBasisDigest))throw new Error("Instruction verification certificate is not durably bound to this work");
    const qa=record.deliveries.find(delivery=>delivery.recipient==="qa");
    const receipt=qa?.receipt as {sourceStateDigest?:string;reviewBasisDigest?:string}|undefined;
    if(qa?.state!=="applied"||receipt?.sourceStateDigest!==certificate.sourceStateDigest||receipt.reviewBasisDigest!==certificate.reviewBasisDigest)throw new Error("Instruction verification does not match its independent source-bound QA delivery");
    setDelivery(db,id,{...qa,state:"verified",receipt:{deliveryReceipt:receipt,verification:certificate}});
    const builder=record.deliveries.find(delivery=>delivery.recipient==="builder");
    if(builder&&["applied","acknowledged"].includes(builder.state)&&record.deliveries.some(delivery=>delivery.recipient==="qa"))setDelivery(db,id,{...builder,state:"verified",receipt:{deliveryReceipt:builder.receipt,verification:certificate}});
  }
}
