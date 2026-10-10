import { WorkflowReader } from "./workflowReader.js";
import { decisionBelongsToWork } from "./buildInterventions.js";
import { randomUUID } from "node:crypto";
import { validateManagerEvidenceRequestV2, type ManagerEvidenceOperationV2, type ManagerEvidencePageV2, type ManagerEvidenceRequestV2 } from "rafi-spec";
import { ManagerEvidenceArtifacts, renderEvidenceText, evidenceDigest } from "./managerEvidenceArtifacts.js";
import { evidenceRecord, readQaEvidenceSnapshot, type EvidenceRow, type QaEvidenceSnapshot } from "./qaEvidenceReader.js";
import { buildQaTimeline } from "./qaTimeline.js";
import { qaDigest } from "./qaProtocolV2.js";
import { assessBuildOwnership, observedBuildWork } from "./buildOwnershipReconciliation.js";

interface SnapshotPage { scope: string; workId?: string; snapshot: QaEvidenceSnapshot; page: ManagerEvidencePageV2; hostRedactions: ManagerEvidencePageV2["redactions"]; expires: number }
interface Cursor { snapshotId: string; ordinal: number; scope: string }

/** Per-host immutable snapshots and opaque continuations are independent of model lookup budgets. */
export class ManagerEvidenceService {
  readonly artifacts: ManagerEvidenceArtifacts;
  private graphPermitted(digest:string):boolean{const reader=new WorkflowReader(this.projectDir);try{return reader.graphEvidenceAllowed(digest);}finally{reader.close();}}
  private readonly snapshots = new Map<string, SnapshotPage>();
  private readonly cursors = new Map<string, Cursor>();
  private readonly hostMetadata = new Map<string, unknown>();
  constructor(readonly projectDir: string, private readonly now = Date.now, private readonly lifetimeMs = 15 * 60 * 1000) { this.artifacts=new ManagerEvidenceArtifacts(digest=>this.graphPermitted(digest)); }
  close(): void { this.snapshots.clear(); this.cursors.clear(); this.hostMetadata.clear(); this.artifacts.clear(); }
  execute(request: ManagerEvidenceRequestV2): ManagerEvidencePageV2 {
    if (!validateManagerEvidenceRequestV2(request).valid) return this.failure("invalid_scope", "Use a valid scoped ManagerEvidenceRequestV2 request");
    const operation = request.operation;
    const { cursor: _, snapshotId: __, ...binding } = operation as ManagerEvidenceOperationV2 & { cursor?: string; snapshotId?: string };
    const scope = qaDigest("manager-evidence-scope", binding);
    if ("cursor" in operation && operation.cursor) return this.more(operation.cursor, scope);
    let snapshot: QaEvidenceSnapshot;
    if ("snapshotId" in operation && operation.snapshotId) {
      const prior = this.snapshots.get(operation.snapshotId);
      if (!prior || prior.expires <= this.now()) return this.failure("snapshot_expired", "Restart the scoped request without its snapshotId/cursor");
      if (prior.snapshot.runId !== operation.runId) return this.failure("invalid_scope", "Refresh evidence for the selected run");
      if (prior.workId && (!('workId' in operation) || prior.workId !== operation.workId)) return this.failure("invalid_scope", "Refresh evidence for the selected work identity");
      snapshot = prior.snapshot;
    } else snapshot = readQaEvidenceSnapshot(this.projectDir, operation.runId);
    const snapshotId = randomUUID();
    const page: ManagerEvidencePageV2 = { version: 2, snapshotId, asOf: snapshot.asOf, items: [], complete: true, omissions: [...snapshot.gaps], availability: snapshot.availability, schemaCapabilities: [...snapshot.capabilities], redactions: [] };
    if (snapshot.availability !== "missing" && snapshot.availability !== "unreadable") this.populate(operation, snapshot, page);
    if (page.availability === "present" && !page.items.length) page.availability = "empty";
    // Retained text remains untrusted. Escape controls and disclose redaction of metadata too.
    const render = (item: unknown, field: string): unknown => {
      if (typeof item === "string") {
        const rendered = renderEvidenceText(item);
        page.redactions.push(...rendered.redactions.map(span => ({ ...span, field })));
        return rendered.text;
      }
      if (Array.isArray(item)) return item.map((value, index) => render(value, `${field}/${index}`));
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, value]) => {
        if (/^(credential|secret|token|password|api[_-]?key|authorization)$/i.test(key) && value !== undefined && value !== null) {
          page.redactions.push({ category: "secret_field", field: `${field}/${key}`, start: 0, end: JSON.stringify(value).length });
          return [key, "[REDACTED]"];
        }
        return [key, render(value, `${field}/${key}`)];
      }));
      return item;
    };
    page.items = page.items.map((item, index) => render(item, `items/${index}`));
    const hostRedactions=structuredClone(page.redactions);
    if (page.redactions.length > 32) {
      page.omissions.push(`${page.redactions.length - 32} additional redaction spans are available in full host artifact metadata; do not claim byte-identical display`);
      page.redactions = page.redactions.slice(0, 32);
    }
    this.snapshots.set(snapshotId, { scope, workId: "workId" in operation ? operation.workId : undefined, snapshot, page, hostRedactions, expires: this.now() + this.lifetimeMs });
    return this.page(snapshotId, 0);
  }
  more(cursor: string, expectedScope?: string): ManagerEvidencePageV2 {
    const continuation = this.cursors.get(cursor);
    if (!continuation || expectedScope && continuation.scope !== expectedScope) return this.failure("invalid_cursor", "Restart the original scoped request");
    return this.page(continuation.snapshotId, continuation.ordinal);
  }
  /** Full disclosure for host rendering; never substituted into a model packet. */
  hostRedactions(snapshotId: string): ManagerEvidencePageV2["redactions"] { return structuredClone(this.snapshots.get(snapshotId)?.hostRedactions ?? []); }
  /** Preserve the already-sanitized structure; rendered report text need not be valid JSON. */
  hostMetadataItem(handle: string): unknown {
    if (!this.hostMetadata.has(handle)) throw new Error("Metadata artifact expired; retrieve the scoped evidence again");
    this.artifacts.bytes(handle);
    return structuredClone(this.hostMetadata.get(handle));
  }
  private page(snapshotId: string, ordinal: number): ManagerEvidencePageV2 {
    const stored = this.snapshots.get(snapshotId);
    if (!stored || stored.expires <= this.now()) return this.failure("snapshot_expired", "Restart the original scoped request without its cursor");
    if([...stored.snapshot.blobs.keys()].some(digest=>!this.graphPermitted(digest)))return this.failure("snapshot_expired","Graph-derived evidence access changed; restart the scoped request");
    const items: unknown[] = [];
    let byteCount = 0;
    let next = ordinal;
    // Both row count and packet bytes are bounded. Bodies are separately chunked/artifacts.
    while (next < stored.page.items.length && items.length < 10) {
      const item = stored.page.items[next];
      const bytes = Buffer.byteLength(JSON.stringify(item));
      if (items.length && byteCount + bytes > 24 * 1024) break;
      if (bytes > 24 * 1024) {
        // Keep complete retained metadata in a host artifact rather than silently dropping it.
        const artifact = this.artifacts.create({ runId: stored.snapshot.runId, workId: "metadata", attemptId: "metadata", occurrenceId: `item-${next}` }, Buffer.from(JSON.stringify(item)));
        this.hostMetadata.set(artifact.handle, item);
        items.push({ metadataArtifact: artifact, continuation: `/artifact ${artifact.handle}` });
      } else { items.push(item); byteCount += bytes; }
      next++;
    }
    const complete = next >= stored.page.items.length;
    let nextCursor: string | undefined;
    if (!complete) { nextCursor = randomUUID(); this.cursors.set(nextCursor, { snapshotId, ordinal: next, scope: stored.scope }); }
    return structuredClone({ ...stored.page, items, complete, nextCursor });
  }
  private failure(error: NonNullable<ManagerEvidencePageV2["error"]>, restartAction: string): ManagerEvidencePageV2 {
    return { version: 2, snapshotId: "unavailable", asOf: new Date(this.now()).toISOString(), items: [], complete: false, availability: "missing", omissions: [error], schemaCapabilities: [], redactions: [], error, restartAction };
  }
  private populate(operation: ManagerEvidenceOperationV2, snapshot: QaEvidenceSnapshot, page: ManagerEvidencePageV2): void {
    const ownership = assessBuildOwnership(this.projectDir, operation.runId, snapshot);
    if (operation.kind === "list_build_work") {
      const qaObserved = new Set(Object.entries(snapshot.rows).filter(([table]) => table.startsWith("qa_")).flatMap(([, rows]) => rows.flatMap(row => typeof row.ticket_id === "string" ? [row.ticket_id] : [])));
      page.items = [...new Set([...ownership.savedScope, ...observedBuildWork(snapshot)])].sort().map(workId => ({ workId, savedMembership: ownership.savedScope.includes(workId), qaObserved: qaObserved.has(workId), admitted: (snapshot.rows.build_work_scope??[]).some(row=>row.work_id===workId&&row.state==="admitted") && ownership.authoritativeAdmissions.some(row => row.work_id === workId || row.ticket_id === workId), conflictingHistorical: !ownership.savedScope.includes(workId), inspectionGrantsAuthority: false, pendingQuestions:(snapshot.rows.human_decisions??[]).filter(row=>row.status==="pending"&&decisionBelongsToWork(evidenceRecord(row,"decision_json") as unknown as {decisionId:string;runId:string;interruptionId:string},snapshot.runId,workId,(snapshot.rows.qa_remediation_stops??[]).map(stop=>({runId:String(stop.run_id),workId:String(stop.ticket_id),operationId:String(stop.operation_id),decisionId:evidenceRecord(stop,"record_json")?.decisionId as string|undefined})))).map(row=>({decisionId:row.decision_id,revision:evidenceDigest(Buffer.from(String(row.decision_json))),decision:evidenceRecord(row,"decision_json")})) }));
      return;
    }
    if (operation.kind === "get_ownership_conflicts") { page.items = [ownership]; return; }
    if (operation.kind === "get_intervention_status") {
      if (!snapshot.capabilities.includes("build_instructions")) {page.availability="unsupported_legacy";page.omissions.push("Durable Manager instruction storage is unavailable");return;}
      const row=(snapshot.rows.build_instructions??[]).find(row=>row.instruction_id===operation.instructionId&&row.work_id===operation.workId);
      if(!row){page.availability="missing";page.error="invalid_scope";return;}
      const record=evidenceRecord(row);
      page.items=[{...record,deliveries:(snapshot.rows.build_instruction_deliveries??[]).filter(delivery=>delivery.instruction_id===operation.instructionId).map(delivery=>{const retained=evidenceRecord(delivery);const receipt=retained?.receipt as {authorizationId?:string}|undefined;const authorization=(snapshot.rows.qa_remediation_authorizations??[]).find(row=>row.authorization_id===receipt?.authorizationId);return {...retained,...(authorization?{authorization:{...authorization,consumed:Boolean(authorization.consumed_by)}}:{})};}),events:(snapshot.rows.build_instruction_events??[]).filter(event=>event.instruction_id===operation.instructionId).map(event=>evidenceRecord(event,"event_json"))}];return;
    }
    if (!("workId" in operation)) return;
    const workId = operation.workId;
    if (!ownership.savedScope.includes(workId) && !observedBuildWork(snapshot).includes(workId)) { page.error = "invalid_scope"; page.availability = "missing"; page.omissions.push("Work identity is not retained in this run"); return; }
    const scoped = (table: string) => (snapshot.rows[table] ?? []).filter(row => row.ticket_id === workId);
    const attempts = scoped("qa_review_attempts").sort((a, b) => Number(a.review_number) - Number(b.review_number) || String(a.attempt_id).localeCompare(String(b.attempt_id)));
    if (operation.kind === "list_qa_attempts") {
      page.items = attempts.map(row => ({ attemptId: row.attempt_id, reviewNumber: row.review_number, status: row.status, sourceDigest: row.source_digest, createdAt: row.created_at, asOf: row.updated_at,
        reports: scoped("qa_reports").filter(report => report.review_number === row.review_number).map(report => ({ occurrenceId: report.report_occurrence_id ?? report.report_digest, reportDigest: report.report_digest, disposition: report.disposition, identityAvailability: report.report_occurrence_id ? "present" : "unsupported_legacy" })),
        verification: scoped("qa_pass_certificates").filter(cert => cert.source_state_digest === row.source_digest && scoped("qa_turns").some(turn => {
          const receipt = evidenceRecord(turn, "receipt_json");
          return turn.review_number === row.review_number && receipt && qaDigest("turn-receipt", receipt) === cert.turn_receipt_digest;
        })).map(cert => ({ certificateId: cert.certificate_id, sourceDigest: cert.source_state_digest, reviewBasisDigest: cert.review_basis_digest, consumedAt: cert.consumed_at })) }));
      if (!snapshot.capabilities.includes("qa_review_attempts")) page.availability = "unsupported_legacy";
      return;
    }
    if (operation.kind === "get_qa_timeline") { const timeline = buildQaTimeline(snapshot, workId); page.items = [{ kind: "ticket_counters", workId, asOf: snapshot.asOf, counters: timeline.counters }, ...timeline.events]; page.omissions = timeline.gaps; return; }
    if (!("attemptId" in operation)) return;
    const attempt = attempts.find(row => row.attempt_id === operation.attemptId);
    if (operation.kind === "get_qa_evidence" && operation.evidenceRef.kind === "verification" && attempt?.status === "passed" && operation.occurrenceId === operation.attemptId) {
      const certificate = scoped("qa_pass_certificates").find(cert => cert.certificate_id === operation.evidenceRef.id && scoped("qa_turns").some(turn => {
        const receipt = evidenceRecord(turn, "receipt_json");
        return turn.review_number === attempt.review_number && turn.source_state_digest === attempt.source_digest && receipt && qaDigest("turn-receipt", receipt) === cert.turn_receipt_digest;
      }));
      if (!certificate) { page.availability = "missing"; page.omissions.push("No certificate is correlated to this passing review's actual turn receipt"); return; }
      const artifact = this.artifacts.create({ runId: operation.runId, workId, attemptId: operation.attemptId, occurrenceId: operation.attemptId }, Buffer.from(String(certificate.certificate_json)));
      page.redactions.push(...artifact.redactions); page.items = this.artifacts.chunks(artifact.handle); return;
    }
    if (operation.kind === "get_qa_evidence" && attempt && operation.occurrenceId === operation.attemptId && ["turn_response","delivery_receipt"].includes(operation.evidenceRef.kind)) {
      const turn=scoped("qa_turns").find(row=>row.operation_id===operation.evidenceRef.id&&row.review_number===attempt.review_number&&row.source_state_digest===attempt.source_digest);
      const receipt=turn?evidenceRecord(turn,"receipt_json"):undefined;
      const bytes=operation.evidenceRef.kind==="delivery_receipt"&&receipt?Buffer.from(String(turn!.receipt_json)):typeof receipt?.rawResponseDigest==="string"?snapshot.blobs.get(receipt.rawResponseDigest):undefined;
      if(!bytes){page.availability="missing";page.omissions.push("No retained scoped turn evidence is available for this attempt");return;}
      const artifact=this.artifacts.create({runId:operation.runId,workId,attemptId:operation.attemptId,occurrenceId:operation.attemptId},bytes);
      page.redactions.push(...artifact.redactions);page.items=this.artifacts.chunks(artifact.handle);return;
    }
    if (operation.kind === "get_qa_evidence" && attempt && operation.evidenceRef.kind === "diff") {
      if (operation.occurrenceId !== operation.attemptId && !scoped("qa_reports").some(row => row.report_occurrence_id===operation.occurrenceId && row.review_number===attempt.review_number && row.report_digest===attempt.report_digest && row.source_state_digest===attempt.source_digest)) {page.error="invalid_scope";page.availability="missing";page.omissions.push("Diff occurrence is not bound to the selected review");return;}
      const match=operation.evidenceRef.id.match(/^(.*):(before|after):(staged|unstaged|untracked-([0-9]+))$/);
      const assignment=(snapshot.rows.operation_journal??[]).find(row=>row.kind==="build-assignment"&&row.idempotency_key===match?.[1]&&evidenceRecord(row,"intent_json")?.ticketId===workId);
      const before=assignment?evidenceRecord(assignment,"intent_json")?.before as Record<string,unknown>|undefined:undefined;
      const after=assignment?evidenceRecord(assignment,"result_json")?.after as Record<string,unknown>|undefined:undefined;
      if(!match||after?.digest!==attempt.source_digest){page.error="invalid_scope";page.availability="missing";page.omissions.push("Diff reference is not bound to this review's source and assigned work");return;}
      const source=match[2]==="before"?before:after;
      const item=match[3]!.startsWith("untracked-")?(source?.untracked as Array<Record<string,unknown>>|undefined)?.[Number(match[4])]:undefined;
      const digest=item?.evidenceDigest??source?.[`${match[3]}DiffDigest`];
      const chunks=item?.evidenceChunks??source?.[`${match[3]}DiffChunks`];
      const ids=Array.isArray(chunks)?chunks:typeof digest==="string"?[digest]:[];
      if(!ids.length||ids.some(id=>typeof id!=="string"||!snapshot.blobs.has(id))){page.availability="missing";page.omissions.push("Retained diff bytes are unavailable; no patch was reconstructed");return;}
      const bytes=Buffer.concat(ids.map(id=>snapshot.blobs.get(String(id))!));
      const artifact=this.artifacts.create({runId:operation.runId,workId,attemptId:operation.attemptId,occurrenceId:operation.occurrenceId},bytes);
      page.redactions.push(...artifact.redactions);page.items=this.artifacts.chunks(artifact.handle);return;
    }
    const candidates = scoped("qa_reports").filter(row => (row.report_occurrence_id ?? row.report_digest) === operation.occurrenceId && row.review_number === attempt?.review_number);
    if (!attempt || candidates.length !== 1) { page.error = "invalid_scope"; page.availability = "missing"; page.omissions.push("Report occurrence is not bound to this run/work/review attempt; passing reviews have verification evidence and no failure report body"); return; }
    const report = candidates[0]!;
    if (attempt.report_digest !== report.report_digest || attempt.source_digest !== report.source_state_digest) { page.availability = "corrupt"; page.omissions.push("Report/attempt digest or source binding conflicts; inspect retained ownership records"); return; }
    const identity = { runId: operation.runId, workId, attemptId: operation.attemptId, occurrenceId: operation.occurrenceId };
    let digest: string | undefined;
    let inline: Buffer | undefined;
    if (operation.kind === "get_qa_report" || operation.evidenceRef.kind === "report") {
      if (operation.kind === "get_qa_evidence" && operation.evidenceRef.id !== operation.occurrenceId) { page.error = "invalid_scope"; page.availability = "missing"; return; }
      digest = String(report.report_digest);
    } else if (operation.evidenceRef.kind === "remediation_request" || operation.evidenceRef.kind === "remediation_response") {
      const remediation = scoped("qa_remediation_attempts").find(row => row.attempt_id === operation.evidenceRef.id && row.review_attempt_id === operation.attemptId);
      if (remediation) digest = String(remediation[operation.evidenceRef.kind === "remediation_request" ? "request_digest" : "response_digest"] ?? "");
    } else if (operation.evidenceRef.kind === "turn_response") {
      const turn = scoped("qa_turns").find(row => row.operation_id === operation.evidenceRef.id && row.review_number === attempt.review_number);
      if (turn) digest = String(evidenceRecord(turn, "receipt_json")?.rawResponseDigest ?? "");
    } else if (operation.evidenceRef.kind === "delivery_receipt") {
      const turn = (snapshot.rows.qa_delivery_turns ?? []).find(row => row.turn_record_id === operation.evidenceRef.id && row.report_occurrence_id === operation.occurrenceId);
      if (turn) inline = Buffer.from(String(turn.record_json));
    } else if (operation.evidenceRef.kind === "verification") {
      const certificate = scoped("qa_pass_certificates").find(row => row.certificate_id === operation.evidenceRef.id && row.source_state_digest === report.source_state_digest && row.review_basis_digest === report.review_basis_digest);
      if (certificate) inline = Buffer.from(String(certificate.certificate_json));
    }
    const bytes = inline ?? (digest ? snapshot.blobs.get(digest) : undefined);
    if (!bytes) { page.availability = digest && snapshot.gaps.some(gap => gap.includes(`content ${digest}: corrupt`)) ? "corrupt" : snapshot.capabilities.includes("qa_reports") ? "missing" : "unsupported_legacy"; page.omissions.push("Scoped reference or retained bytes are unavailable; no report body has been reconstructed"); return; }
    const artifact = this.artifacts.create(identity, bytes);
    page.redactions.push(...artifact.redactions);
    page.items = this.artifacts.chunks(artifact.handle);
    page.omissions.push(`Complete host rendering: /artifact ${artifact.handle}; protected raw export: /qa-export ${artifact.handle}`);
  }
}

export function parseManagerEvidenceRequestV2(text: string): ManagerEvidenceRequestV2 | undefined {
  if (Buffer.byteLength(text) > 8192) return undefined;
  try { const request: unknown = JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, "")); return validateManagerEvidenceRequestV2(request).valid ? request as ManagerEvidenceRequestV2 : undefined; } catch { return undefined; }
}
