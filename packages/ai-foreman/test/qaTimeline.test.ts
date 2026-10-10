import test from "node:test";
import assert from "node:assert/strict";
import { buildQaTimeline } from "../src/qaTimeline.js";
import type { QaEvidenceSnapshot } from "../src/qaEvidenceReader.js";

function fixture():QaEvidenceSnapshot {
  const finding=(id:string)=>({id,requirement:"Guard empty input",locations:["input.ts:1"],problem:"Throws on empty input",verification:["empty input test"]});
  const review=(ticket_id:string,review_number:number,status:string)=>({ticket_id,review_number,status,attempt_id:`${ticket_id}-${review_number}`,source_digest:`source-${review_number}`});
  const report=(review_number:number,findings:unknown[],disposition="open")=>({ticket_id:"T1",review_number,report_occurrence_id:`report-${review_number}`,report_digest:`digest-${review_number}`,disposition,report_json:JSON.stringify({findings})});
  return {runId:"run",asOf:"2026-10-09",availability:"present",capabilities:[],gaps:["Observability spans are unavailable; durations are unknown"],blobs:new Map([["malformed",Buffer.from("no QA contract")],["blocked",Buffer.from('STEP_STATUS: blocked | reason="Registry unavailable"')]]),rows:{
    qa_review_attempts:[review("T1",1,"failed"),review("T1",2,"failed"),review("T1",3,"interrupted"),review("T1",4,"started"),review("T2",1,"passed")],
    qa_reports:[report(1,[finding("QA-1")],"superseded"),report(2,[finding("QA-99"),{...finding("QA-2"),problem:"New defect"}])],
    qa_turns:[{ticket_id:"T1",review_number:3,retry_slot:"initial",receipt_json:JSON.stringify({cleanedResponseDigest:"malformed"})},{ticket_id:"T1",review_number:3,retry_slot:"correction-1"},{ticket_id:"T1",review_number:4,retry_slot:"initial",receipt_json:JSON.stringify({cleanedResponseDigest:"blocked"})}],
    qa_remediation_attempts:[{ticket_id:"T1",attempt_id:"failed-fix",review_attempt_id:"T1-1",status:"failed"},{ticket_id:"T1",attempt_id:"uncertain-fix",review_attempt_id:"T1-2",status:"uncertain"}],
    qa_report_dispositions:[{report_occurrence_id:"report-1",sequence:1,disposition:"superseded",reason:"fresh review"}],
    qa_report_chains:[{predecessor_occurrence_id:"report-1",successor_occurrence_id:"report-2",relation:"recheck-failed"}],
    qa_delivery_turns:[{report_occurrence_id:"report-1",turn_record_id:"delivery",record_json:JSON.stringify({status:"delivery-uncertain",providerElapsedMs:12})}],
    qa_source_states:[{ticket_id:"T1",digest:"source-2",content_digest:"changed",state_json:"{}"}],
  }};
}
test("ticket timelines count every outcome separately and link renumbered findings to actual failed fixes",()=>{
  const snapshot=fixture();const timeline=buildQaTimeline(snapshot,"T1");
  assert.deepEqual(timeline.counters,{failedReviews:2,passedReviews:0,blockedReviews:1,interruptedReviews:1,pendingReviews:1,malformedResponses:1,corrections:1,remediationFailures:1,uncertainRemediations:1});
  assert.equal(buildQaTimeline(snapshot,"T2").counters.failedReviews,0);assert.equal(buildQaTimeline(snapshot,"T2").counters.passedReviews,1);
  const report=timeline.events.find(event=>event.kind==="report"&&event.reviewNumber===2)!;
  const correlations=report.correlations as Array<Record<string,unknown>>;
  assert.equal(correlations[0]!.label,"possibly_recurring");assert.equal(correlations[1]!.label,"newly_observed");
  assert.deepEqual(correlations[0]!.linkedRemediations,[{attemptId:"failed-fix",status:"failed",responseDigest:undefined}]);
  assert.ok(timeline.events.some(event=>event.kind==="qa_report_dispositions"));assert.ok(timeline.events.some(event=>event.kind==="qa_report_chains"));assert.ok(timeline.events.some(event=>event.kind==="qa_delivery_turns"));
  assert.match(String(timeline.events.find(event=>event.kind==="source_basis")?.limitation),/retained diff/);
  assert.ok(timeline.events.every(event=>event.ordering!=="durable_commit"));assert.match(timeline.gaps.join(" "),/unknown/);
});
