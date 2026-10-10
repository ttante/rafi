import { decisionBelongsToWork } from "./buildInterventions.js";
import { evidenceRecord, type EvidenceRow, type QaEvidenceSnapshot } from "./qaEvidenceReader.js";
import { parseQaResponseContract } from "rafi-spec";

export interface QaTicketTimeline {
  counters: { failedReviews: number; passedReviews: number; blockedReviews: number; interruptedReviews: number; pendingReviews: number; malformedResponses: number; corrections: number; remediationFailures: number; uncertainRemediations: number };
  events: Array<Record<string, unknown>>;
  gaps: string[];
}

/** All counters are scoped rows. A changed digest is never a code-change explanation. */
export function buildQaTimeline(snapshot: QaEvidenceSnapshot, workId: string): QaTicketTimeline {
  const scoped = (table: string): EvidenceRow[] => (snapshot.rows[table] ?? []).filter(row => row.ticket_id === workId);
  const counters = { failedReviews: 0, passedReviews: 0, blockedReviews: 0, interruptedReviews: 0, pendingReviews: 0, malformedResponses: 0, corrections: 0, remediationFailures: 0, uncertainRemediations: 0 };
  const events: QaTicketTimeline["events"] = [];
  for (const row of scoped("qa_review_attempts")) {
    const record = evidenceRecord(row);
    const status = String(row.status);
    if (status === "failed") counters.failedReviews++;
    else if (status === "passed") counters.passedReviews++;
    else if (status === "started") counters.pendingReviews++;
    else if (status === "interrupted") counters.interruptedReviews++;
    events.push({ kind: "review", id: row.attempt_id, reviewNumber: row.review_number, status, sourceDigest: row.source_digest, detail: record?.detail, asOf: row.updated_at, sequence: Number(row.review_number), order: 0 });
  }
  for (const row of scoped("qa_turns")) {
    const receipt = evidenceRecord(row, "receipt_json");
    const slot = String(row.retry_slot);
    if (/correction|repair/.test(slot)) counters.corrections++;
    const bytes = typeof receipt?.cleanedResponseDigest === "string" ? snapshot.blobs.get(receipt.cleanedResponseDigest) : undefined;
    const contract = bytes ? parseQaResponseContract(bytes.toString("utf8")) : undefined;
    const classification = contract ? contract.valid ? contract.status : "malformed" : "unavailable";
    if (slot === "initial" && classification === "malformed") counters.malformedResponses++;
    if (slot === "initial" && classification === "blocked") counters.blockedReviews++;
    events.push({ kind: "qa_turn", id: row.operation_id, reviewNumber: row.review_number, slot, status: row.status, classification, responseDigest: receipt?.rawResponseDigest, sequence: Number(row.review_number), order: 1 });
  }
  for (const row of scoped("qa_remediation_attempts")) {
    if (row.status === "failed") counters.remediationFailures++;
    if (row.status === "uncertain") counters.uncertainRemediations++;
    const parent = scoped("qa_review_attempts").find(attempt => attempt.attempt_id === row.review_attempt_id);
    events.push({ kind: "remediation", id: row.attempt_id, reviewAttemptId: row.review_attempt_id, generation: row.generation, status: row.status, requestDigest: row.request_digest, responseDigest: row.response_digest, verification: "requires subsequent source-bound QA", sequence: Number(parent?.review_number ?? -1), order: 3 });
  }
  const prior = new Map<string, { occurrenceId: unknown; ordinal: number; reviewNumber: unknown; disposition: unknown }>();
  for (const row of scoped("qa_reports").sort((a, b) => Number(a.review_number) - Number(b.review_number))) {
    const report = evidenceRecord(row, "report_json");
    const findings = Array.isArray(report?.findings) ? report.findings : [];
    const correlations = findings.map((value: unknown, ordinal: number) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return { ordinal, label: "unavailable", confidence: "unestablished", limitation: "Corrupt retained finding; no issue correlation was inferred" };
      const finding = value as EvidenceRow;
      const key = JSON.stringify([finding.requirement, finding.locations, finding.problem, finding.verification]).toLowerCase().replace(/\s+/g, " ");
      const previous = prior.get(key);
      prior.set(key, { occurrenceId: row.report_occurrence_id, ordinal, reviewNumber:row.review_number, disposition:row.disposition });
      const previousAttempt=previous?scoped("qa_review_attempts").find(attempt=>attempt.review_number===previous.reviewNumber):undefined;
      const linkedRemediations=previousAttempt?scoped("qa_remediation_attempts").filter(remediation=>remediation.review_attempt_id===previousAttempt.attempt_id).map(remediation=>({attemptId:remediation.attempt_id,status:remediation.status,responseDigest:remediation.response_digest})):[];
      return { ordinal, rawId: finding.id, label: previous ? "possibly_recurring" : "newly_observed", confidence: previous ? "exact_normalized_content" : "unestablished", previous, linkedRemediations, limitation: "Matching content is correlation; review-local IDs and changed source digests do not prove issue identity or exact code changes" };
    });
    events.push({ kind: "report", id: row.report_occurrence_id ?? row.report_digest, reviewNumber: row.review_number, reportDigest: row.report_digest, disposition: row.disposition, correlations, sequence: Number(row.review_number), order: 2 });
  }
  for (const table of ["qa_transitions", "qa_pass_certificates", "qa_finalization_steps", "qa_recovery_heads"]) for (const row of scoped(table)) {
    events.push({ kind: table, id: row.operation_id ?? row.certificate_id ?? row.sequence ?? row.packet_id, revision: row.to_revision ?? row.qa_revision ?? row.revision, state: row.status ?? row.pending_action, event: row.event_json ? evidenceRecord(row, "event_json") : undefined, certificateId: row.certificate_id, sourceDigest: row.source_state_digest ?? row.reviewed_state_digest, sequence: Number(row.sequence ?? row.qa_revision ?? row.revision), order: 4 });
  }
  for (const row of snapshot.rows.human_decisions ?? []) {
    const decision = evidenceRecord(row, "decision_json");
    if (!decisionBelongsToWork(decision as unknown as {decisionId:string;runId:string;interruptionId:string},snapshot.runId,workId,(snapshot.rows.qa_remediation_stops??[]).map(stop=>({runId:String(stop.run_id),workId:String(stop.ticket_id),operationId:String(stop.operation_id),decisionId:evidenceRecord(stop)?.decisionId as string|undefined})))) continue;
    events.push({ kind: "human_decision", id: row.decision_id, status: row.status, decision, sequence: -1, order: 5 });
  }
  for (const row of snapshot.rows.operation_journal ?? []) {
    const intent = evidenceRecord(row, "intent_json");
    if (row.kind !== "build-assignment" || intent?.ticketId !== workId) continue;
    const result=evidenceRecord(row,"result_json");
    const diffReferences: Array<Record<string,unknown>>=[];
    for(const side of ["before","after"]) {
      const source=(side==="before"?intent?.before:result?.after) as Record<string,unknown>|undefined;
      if(!source)continue;
      for(const kind of ["staged","unstaged"])if(source[`${kind}DiffDigest`]||Array.isArray(source[`${kind}DiffChunks`]))diffReferences.push({id:`${row.idempotency_key}:${side}:${kind}`,sourceDigest:source.digest,byteLength:source[`${kind}DiffBytes`],digest:source[`${kind}DiffDigest`],chunks:source[`${kind}DiffChunks`]});
      for(const [index,file] of ((source.untracked??[]) as Array<Record<string,unknown>>).entries())diffReferences.push({id:`${row.idempotency_key}:${side}:untracked-${index}`,sourceDigest:source.digest,path:file.path,byteLength:file.byteLength,digest:file.evidenceDigest,chunks:file.evidenceChunks});
    }
    events.push({ kind: "builder_assignment", id: row.idempotency_key, status: row.status, intent, result, diffReferences, sequence: -1, order: 5 });
  }
  for (const row of snapshot.rows.continuity_events ?? []) {
    const payload = evidenceRecord(row, "payload_json");
    if (payload?.ticketId !== workId && payload?.ticket !== workId) continue;
    events.push({ kind: "continuity", id: row.sequence, type: row.kind, payload, sequence: row.sequence, order: 5 });
  }
  const occurrences=new Set(scoped("qa_reports").map(row=>row.report_occurrence_id));
  for(const table of ["qa_report_dispositions","qa_report_chains","qa_delivery_turns"])for(const row of snapshot.rows[table]??[]) {
    if(!occurrences.has(row.report_occurrence_id??row.predecessor_occurrence_id))continue;
    const record=evidenceRecord(row);
    const parsed=typeof record?.parsedResponseDigest==="string"?snapshot.blobs.get(record.parsedResponseDigest):undefined;
    let reportedFindings:unknown;
    if(parsed)try {reportedFindings=JSON.parse(parsed.toString("utf8")).findings;}catch {/* snapshot discloses retained corruption */}
    events.push({kind:table,id:row.sequence??row.turn_record_id??row.successor_occurrence_id,...row,record,reportedFindings,applicationEvidence:"Builder-reported dispositions; independent source-bound QA establishes verification",providerElapsedMs:record?.providerElapsedMs??null,sequence:Number(row.sequence??-1),order:6});
  }
  for(const row of scoped("qa_source_states"))events.push({kind:"source_basis",id:row.digest,originDigest:row.origin_digest,contentDigest:row.content_digest,paths:evidenceRecord(row,"state_json")?.paths,limitation:"Content changes require retained diff evidence for exact code-change explanations",sequence:-1,order:6});
  for(const row of snapshot.rows.build_instructions??[])if(row.work_id===workId)events.push({kind:"manager_instruction",id:row.instruction_id,record:evidenceRecord(row),deliveries:(snapshot.rows.build_instruction_deliveries??[]).filter(delivery=>delivery.instruction_id===row.instruction_id).map(delivery=>evidenceRecord(delivery)),sequence:Number(row.sequence),order:6});
  const committed=(snapshot.rows.build_work_events??[]).filter(row=>row.work_id===workId).sort((a,b)=>Number(a.sequence)-Number(b.sequence));
  if(committed.length) {
    const ordered=committed.map(row=>({kind:"committed_work_event",id:row.sequence,commitSequence:row.sequence,table:row.table_name,recordKey:row.record_key,action:row.action,stateAtEvent:evidenceRecord(row),createdAt:row.created_at,ordering:"durable_commit_sequence"}));
    return {counters,events:[...ordered,...events.map(event=>({...event,ordering:"snapshot_record_or_legacy_history",commitSequence:null}))],gaps:[...snapshot.gaps,"Snapshot records and pre-upgrade history are separately labeled; only indexed events have a proven cross-table commit order. Exact fixes require retained diffs; absent timing evidence leaves duration unknown."]};
  }
  // Independent event streams retain their own explicit sequence; timestamps do not establish ownership.
  events.sort((a, b) => Number(a.sequence) - Number(b.sequence) || Number(a.order) - Number(b.order) || String(a.id).localeCompare(String(b.id)));
  return { counters, events, gaps: [...snapshot.gaps, "No retained diff is interpreted as proof of the exact fix; durations are unavailable without correlated timing evidence"] };
}
