import { persistedProviderWireContract } from "rafi-spec";
import { qaDigest } from "./qaProtocolV2.js";
import { verifyCheckpointOrigin } from "./continuityOrigin.js";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalJson, providerWireContracts, qaVerdictOutput, type OutputContract, type OperationResponse } from "rafi-spec";
import { persistedDispatchTuple, verifyPersistedDispatch, type SealedDispatchRecordV2 } from "./structuredDispatchRecord.js";

export const STRUCTURED_CUTOVER = "003_structured_communication_v2_cutover";
export const STRUCTURED_AUDIT_CLOSURE = "004_structured_communication_audit_closure";
export const STRUCTURED_CUTOVER_MATRIX_VERSION = 3;
export const STRUCTURED_CUTOVER_REASON = "structured-communication-v2-cutover";

/** User definitions, answers, settings and history are retained, never executable after fencing. */
const retained = new Set(["workflow_runs", "human_decisions", "build_work_scope", "build_instructions", "build_instruction_events",
  "role_settings", "run_autonomy_policy", "workflow_events", "workflow_telemetry", "workflow_issues", "legacy_imports",
  "build_owned_processes", "build_runtime_runs", "build_child_runs", "build_retry_lineage", "build_work_events", "structured_cutover_quarantine"]);
/** Reviewed authority tables; descendants without run_id are selected through their declared FK. */
const authority = new Set(["structured_handoff_lineage", "continuity_checkpoint_origins", "structured_dispatch_processing", "structured_submission_claims", "operation_journal", "continuity_events", "continuity_checkpoints", "continuity_heads", "handoffs", "role_mutation_leases",
  "provider_sessions", "provider_session_bindings", "context_samples", "session_usage_samples", "compaction_attempts", "live_settings_acknowledgments",
  "recovery_interruptions", "recovery_attempts", "recovery_decisions", "supervisor_leases", "branch_resume_sessions", "publication_transactions",
  "qa_turns", "qa_turn_events", "qa_sessions", "qa_retry_slots", "qa_source_states", "qa_review_bases", "qa_ticket_heads", "qa_transitions",
  "qa_reports", "qa_findings", "qa_report_chains", "qa_report_dispositions", "qa_review_attempts", "qa_remediation_attempts", "qa_remediation_receipts",
  "qa_failure_handoffs", "qa_delivery_turns", "qa_handoffs", "qa_operation_journal", "qa_pass_certificates", "qa_finalization_steps",
  "qa_packet_projections", "qa_recovery_heads", "qa_remediation_stops", "qa_remediation_authorizations", "qa_delivery_invocations",
  "qa_preparation_policy", "qa_preparation_budgets", "qa_preparation_attempts", "qa_preparation_progress", "qa_preparation_events",
  "qa_depth_decisions", "qa_verification_contracts", "qa_contract_heads", "qa_contract_receipts", "qa_contract_check_history",
  "build_assignments", "build_work_admissions", "build_ownership_conflicts", "build_reconciliations", "build_instruction_deliveries", "build_instruction_streams",
  "build_admission", "build_launches", "page_ledgers", "page_ledger_pages"]);
export const STRUCTURED_AUTHORITY_TABLES = Object.freeze([...authority, "qa_contract_artifacts", "communication_evidence_refs", "structured_communication_cutover", "structured_cutover_quarantine", "content_refs"]);

type Row = Record<string, any>;
type ForeignKey = { id: number; seq: number; table: string; from: string; to: string };
export interface CutoverOwnershipEntry {
  table: string; disposition: "retain" | "purge-owned"; columns: string[]; foreignKeys: ForeignKey[];
  jsonColumns: string[];
  owner: "retained-artifact" | "run-id" | "foreign-key" | "session-key" | "contract-id" | "json-run-id";
  evidenceReferenceExtractor: "normalized-refs-with-conservative-unknown-retention";
  deletionOrder: number | null;
}
const quote = (name: string): string => { if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw new Error("Unclassified cutover SQL identity"); return `"${name}"`; };

export function cutoverOwnershipMatrix(db: Database.Database): CutoverOwnershipEntry[] {
  const entries: CutoverOwnershipEntry[] = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>) {
    const columns = (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map(column => column.name);
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as ForeignKey[];
    if (!authority.has(name) && !retained.has(name) && name !== "project_lease"
      && (columns.includes("run_id") || foreignKeys.some(key => authority.has(key.table) || key.table === "workflow_runs")))
      throw new Error(`Cutover ownership matrix does not classify ${name}`);
    if (authority.has(name) || retained.has(name)) {
      const owner = retained.has(name) ? "retained-artifact" : columns.includes("run_id") ? "run-id"
        : name === "provider_session_bindings" ? "session-key" : name === "qa_contract_check_history" ? "contract-id" : !foreignKeys.length && columns.includes("record_json") ? "json-run-id" : "foreign-key";
      if (owner === "foreign-key" && !foreignKeys.length) throw new Error(`Cutover ownership matrix has no owner for ${name}`);
      entries.push({ table: name, disposition: retained.has(name) ? "retain" : "purge-owned", columns, foreignKeys,
        jsonColumns: columns.filter(column => column.endsWith("_json")), owner,
        evidenceReferenceExtractor: "normalized-refs-with-conservative-unknown-retention", deletionOrder: null });
    }
  }
  const pending = entries.filter(entry => entry.disposition === "purge-owned");
  for (let ordinal = 0; pending.length; ordinal++) {
    const index = pending.findIndex(parent => !pending.some(child => child.table !== parent.table && child.foreignKeys.some(key => key.table === parent.table)));
    if (index < 0) throw new Error("Cutover ownership matrix has an unresolved foreign-key cycle");
    pending.splice(index, 1)[0]!.deletionOrder = ordinal;
  }
  return entries;
}

export function assertStructuredCutoverComplete(db: Database.Database): void {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='structured_communication_cutover'").get()) throw new Error("Missing completion table");
    const row = db.prepare("SELECT details_json FROM structured_communication_cutover WHERE migration=?").get(STRUCTURED_AUDIT_CLOSURE) as { details_json: string } | undefined;
    if (!db.prepare("SELECT 1 FROM structured_communication_cutover WHERE migration=?").get(STRUCTURED_CUTOVER) || !row ||
      JSON.parse(row.details_json)?.ownershipMatrixVersion !== STRUCTURED_CUTOVER_MATRIX_VERSION) throw new Error("Incomplete completion record");
  } catch {
    throw new Error("v2-cutover-pending: open with the current writer to complete structured communication cutover");
  }
}

/** Classification is structural; JSON spelling or merely containing a tuple key is never proof. */
export function invalidStructuredRun(db: Database.Database, run: Row, projectDir = ""): boolean {
  try { return classifyStructuredRun(db,run,projectDir); }
  catch { return true; } // Malformed owned records are quarantined independently.
}
function classifyStructuredRun(db: Database.Database, run: Row, projectDir: string): boolean {
  if (run.legacy || run.checkpoint === STRUCTURED_CUTOVER_REASON) return true;
  let state: Row;
  try { state = JSON.parse(run.state_json); } catch { return true; }
  if (!state || typeof state !== "object" || Array.isArray(state)) return true;
  const operations = db.prepare("SELECT * FROM operation_journal WHERE run_id=? AND kind='provider-dispatch'").all(run.run_id) as Row[];
  for (const operation of operations) {
    try {
      if (operation.status !== "confirmed") return true;
      const intent = JSON.parse(operation.intent_json);
      const tuple = persistedDispatchTuple(intent.sealedDispatch);
      if (canonicalJson(intent.tuple) !== intent.sealedDispatch.tupleJson || tuple.dispatchId !== operation.idempotency_key) return true;
      const descriptor = persistedProviderWireContract(tuple);
      if (!descriptor) return true;
      if (operation.status === "confirmed") {
        const result = JSON.parse(operation.result_json);
        const evidence = db.prepare("SELECT content FROM content_refs WHERE digest=?").get(result.responseDigest) as { content: Buffer } | undefined;
        if (!evidence || createHash("sha256").update(evidence.content).digest("hex") !== result.responseDigest) return true;
        const retained = JSON.parse(evidence.content.toString());
        if (retained.version !== 2 || retained.tupleDigest !== tuple.digest) return true;
        let receipt = retained.receipt;
        if (receipt?.state === "candidate") {
          const value = db.prepare("SELECT content FROM content_refs WHERE digest=?").get(retained.valueDigest) as { content: Buffer } | undefined;
          if (!value || createHash("sha256").update(value.content).digest("hex") !== retained.valueDigest) return true;
          receipt = { ...receipt, value: receipt.representation === "json-text" ? value.content.toString() : JSON.parse(value.content.toString()) };
        }
        verifyPersistedDispatch(descriptor.canonical as OutputContract, intent.sealedDispatch, receipt);
      }
    } catch { return true; }
  }
  for (const row of db.prepare("SELECT intent_json,receipt_json,status FROM qa_turns WHERE run_id=?").all(run.run_id) as Row[]) {
    try {
      const intent = JSON.parse(row.intent_json), receipt = JSON.parse(row.receipt_json);
      persistedDispatchTuple(intent.sealedDispatch);
      const generic = operations.find(operation => operation.idempotency_key === intent.operationId);
      if (!generic || row.status !== "completed" || receipt.dispatch !== "completed" || !receipt.terminalEventObserved || receipt.operationId !== intent.operationId || canonicalJson(intent.sealedDispatch) !== canonicalJson(receipt.sealedDispatch) ||
        canonicalJson(intent.sealedDispatch) !== canonicalJson(JSON.parse(generic.intent_json).sealedDispatch)) return true;
    }
    catch { return true; }
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='qa_delivery_turns'").get()) for (const row of db.prepare("SELECT d.record_json,d.status FROM qa_delivery_turns d JOIN qa_reports r ON r.report_occurrence_id=d.report_occurrence_id WHERE r.run_id=?").all(run.run_id) as Row[]) {
    try {
      const record = JSON.parse(row.record_json), generic = operations.find(operation => operation.idempotency_key === record.turnRecordId);
      persistedDispatchTuple(record.sealedDispatch);
      if (!generic || row.status !== "completed" || canonicalJson(record.sealedDispatch) !== canonicalJson(JSON.parse(generic.intent_json).sealedDispatch)) return true;
    } catch { return true; }
  }
  const rows = (table: string): Row[] => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
    ? db.prepare(`SELECT * FROM ${quote(table)} WHERE run_id=?`).all(run.run_id) as Row[] : [];
  const nativeTurns = db.prepare("SELECT * FROM qa_turns WHERE run_id=?").all(run.run_id) as Row[];
  for (const certificate of rows("qa_pass_certificates")) {
    try {
      const value = JSON.parse(certificate.certificate_json);
      if (value.certificateId !== certificate.certificate_id || value.runId !== run.run_id || value.ticketId !== certificate.ticket_id || value.qaRevision !== certificate.qa_revision ||
        value.sourceStateDigest !== certificate.source_state_digest || value.reviewBasisDigest !== certificate.review_basis_digest || value.turnReceiptDigest !== certificate.turn_receipt_digest) return true;
      const turn = nativeTurns.find(turn => turn.ticket_id === value.ticketId && turn.source_state_digest === value.sourceStateDigest && turn.review_basis_digest === value.reviewBasisDigest &&
        turn.status === "completed" && qaDigest("turn-receipt", JSON.parse(turn.receipt_json)) === value.turnReceiptDigest);
      if (!turn) return true;
      const receipt = JSON.parse(turn.receipt_json), intent = JSON.parse(turn.intent_json);
      const operation = operations.find(operation => operation.idempotency_key === receipt.operationId);
      if (!operation || !receipt.terminalEventObserved || receipt.dispatch !== "completed" || canonicalJson(receipt.sealedDispatch) !== canonicalJson(intent.sealedDispatch)) return true;
      const result = JSON.parse(operation.result_json);
      const read = (digest: string): Buffer => {
        const bytes = (db.prepare("SELECT content FROM content_refs WHERE digest=?").get(digest) as {content:Buffer}|undefined)?.content;
        if (!bytes || createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("Invalid certificate evidence");
        return bytes;
      };
      const retained = JSON.parse(read(result.responseDigest).toString());
      if (retained.hostTurnId !== receipt.providerTurnId) return true;
      const native = { ...retained.receipt, value: retained.receipt.representation === "json-text" ? read(retained.valueDigest).toString() : JSON.parse(read(retained.valueDigest).toString()) };
      const verdict = verifyPersistedDispatch(qaVerdictOutput, intent.sealedDispatch, native) as OperationResponse<{kind:string}>;
      if (verdict.result.kind !== "completed" || verdict.result.payload.kind !== "passed") return true;
    } catch { return true; }
  }
  for (const review of rows("qa_review_attempts")) {
    if (!nativeTurns.some(turn => turn.ticket_id === review.ticket_id && turn.review_number === review.review_number && turn.source_state_digest === review.source_digest)) return true;
  }
  for (const report of rows("qa_reports")) {
    try {
      const turn = nativeTurns.find(turn => turn.ticket_id === report.ticket_id && turn.review_number === report.review_number && turn.source_state_digest === report.source_state_digest && turn.review_basis_digest === report.review_basis_digest);
      if (!turn) return true;
      const receipt = JSON.parse(turn.receipt_json), intent = JSON.parse(turn.intent_json);
      const operation = operations.find(operation => operation.idempotency_key === receipt.operationId);
      if (!operation) return true;
      const retained = JSON.parse((db.prepare("SELECT content FROM content_refs WHERE digest=?").get(JSON.parse(operation.result_json).responseDigest) as {content:Buffer}).content.toString());
      const value = (db.prepare("SELECT content FROM content_refs WHERE digest=?").get(retained.valueDigest) as {content:Buffer}).content.toString();
      const response = verifyPersistedDispatch(qaVerdictOutput, intent.sealedDispatch, {...retained.receipt,value:retained.receipt.representation === "json-text" ? value : JSON.parse(value)}) as OperationResponse<{kind:string;report?:unknown}>;
      if (response.result.kind !== "completed" || response.result.payload.kind !== "failed" || canonicalJson(response.result.payload.report) !== canonicalJson(JSON.parse(report.report_json))) return true;
    } catch { return true; }
  }
  for (const attempt of rows("qa_remediation_attempts")) {
    try {
      const record = JSON.parse(attempt.record_json);
      const dispatches = operations.filter(operation => JSON.parse(operation.intent_json).tuple?.actionId === attempt.attempt_id);
      if (!dispatches.length || record.status !== "succeeded" || !rows("qa_remediation_receipts").some(receipt => receipt.operation_id === attempt.attempt_id)) return true;
    } catch { return true; }
  }
  for (const receipt of rows("qa_remediation_receipts")) {
    try {
      const value = JSON.parse(receipt.receipt_json);
      if (value.version !== 3 || value.runId !== run.run_id || value.ticketId !== receipt.ticket_id || !operations.some(operation => operation.idempotency_key === value.turnRecordId)) return true;
    } catch { return true; }
  }
  for (const step of rows("qa_finalization_steps")) {
    const certificate = rows("qa_pass_certificates").find(row => row.certificate_id === step.certificate_id);
    if (!certificate || certificate.ticket_id !== step.ticket_id || !certificate.consumed_at || certificate.consumed_by !== step.kind) return true;
  }
  for (const row of rows("qa_ticket_heads")) {
    const head = JSON.parse(row.state_json);
    if (head.runId !== run.run_id || head.ticketId !== row.ticket_id || head.revision !== row.revision || head.state !== row.state) return true;
    if (["passed","finalizing","completed"].includes(head.state) && !rows("qa_pass_certificates").some(certificate =>
      certificate.certificate_id === head.passCertificateId && certificate.ticket_id === row.ticket_id
      && certificate.source_state_digest === head.sourceStateDigest && certificate.review_basis_digest === head.reviewBasisDigest)) return true;
    if ((head.openReportDigests ?? []).some((digest: string) => !rows("qa_reports").some(report => report.report_digest === digest && report.ticket_id === row.ticket_id))) return true;
  }
  for (const checkpoint of rows("continuity_checkpoints")) {
    try { verifyCheckpointOrigin(db, projectDir, checkpoint.checkpoint_id); } catch { return true; }
  }
  const hasSession = (session: Row): boolean => operations.some(operation => {
    const intent = JSON.parse(operation.intent_json), ref = intent.sessionRef;
    return ref && session && ["sessionId","provider","role","stream","generation","cwd","configRoot","workspaceIdentity","ticketId","deliveryUnitId"].every(key => ref[key] === session[key]);
  });
  // V2 QA session records intentionally omit V1's optional workspace labels.
  // Bind them to their own native QA owner and ticket instead of inferring
  // missing fields or comparing them to an unrelated generic session.
  const hasQaSession = (session: Row, ticketId: string): boolean => nativeTurns.some(turn => {
    const intent = JSON.parse(turn.intent_json);
    return intent.ticketId === ticketId && session && ["provider","sessionId","role","stream","generation","cwd","configRoot"].every(key => intent.providerSession[key] === session[key]);
  });
  for (const row of rows("qa_failure_handoffs")) {
    if (!rows("qa_reports").some(report => report.report_digest === row.report_digest && report.ticket_id === row.ticket_id)
      || row.builder_session_json && !hasSession(JSON.parse(row.builder_session_json))) return true;
    if (["remediation-reported","completed"].includes(row.state) && !operations.some(operation => {
      const intent = JSON.parse(operation.intent_json);
      return intent.tuple?.actionId === row.operation_id && intent.tuple?.operation === "builder-remediation";
    })) return true;
  }
  for (const row of rows("qa_handoffs")) {
    const receipt = JSON.parse(row.receipt_json);
    const checkpoint = rows("continuity_checkpoints").find(checkpoint => checkpoint.digest === receipt.acceptanceCheckpointDigest && checkpoint.role === "qa");
    if (row.status !== "accepted" || receipt.runId !== run.run_id || !checkpoint || !hasQaSession(receipt.successor, row.ticket_id)) return true;
    verifyCheckpointOrigin(db, projectDir, checkpoint.checkpoint_id);
  }
  for (const lease of rows("role_mutation_leases")) {
    try { if (!lease.provider_session_ref_json || !hasSession(JSON.parse(lease.provider_session_ref_json))) return true; } catch { return true; }
  }
  for (const contract of rows("qa_verification_contracts")) {
    try {
      const value = JSON.parse(contract.record_json);
      const evidence = value.preparationEvidence;
      if (!Array.isArray(evidence) || !evidence.length || evidence.some(entry => !entry || !operations.some(operation => operation.idempotency_key === entry.operationId && JSON.parse(operation.intent_json).tuple.sessionId === entry.sessionId)
        || !db.prepare("SELECT 1 FROM content_refs WHERE digest=?").get(entry.evidenceDigest))) return true;
    } catch { return true; }
  }
  for (const head of rows("qa_recovery_heads")) {
    const projection = rows("qa_packet_projections").find(projection => projection.packet_digest === head.packet_digest && projection.ticket_id === head.ticket_id);
    if (!projection || !projection.manifest_json) return true;
    const manifest = JSON.parse(projection.manifest_json);
    if (manifest.runId !== run.run_id || manifest.ticketId !== head.ticket_id || manifest.revision !== head.revision
      || !nativeTurns.some(turn => turn.ticket_id === head.ticket_id && turn.review_number === manifest.reviewAttempt)) return true;
  }
  for (const session of rows("provider_sessions")) {
    try {
      if (!session.session_ref_json || !hasSession(JSON.parse(session.session_ref_json))) return true;
      if (session.session_key) {
        const binding = db.prepare("SELECT session_ref_json FROM provider_session_bindings WHERE session_key=?").get(session.session_key) as {session_ref_json:string}|undefined;
        if (!binding || canonicalJson(JSON.parse(binding.session_ref_json)) !== canonicalJson(JSON.parse(session.session_ref_json))) return true;
      }
    } catch { return true; }
  }
  for (const session of rows("qa_sessions")) {
    try { if (!hasQaSession(JSON.parse(session.session_json).session, session.ticket_id)) return true; } catch { return true; }
  }
  for (const session of rows("branch_resume_sessions")) {
    try { const value = JSON.parse(session.session_json); if (!value.sessionRef || !hasSession(value.sessionRef)) return true; } catch { return true; }
  }
  for (const handoff of rows("handoffs")) {
    if (handoff.state !== "accepted" || !handoff.acceptance_receipt_digest || !rows("continuity_checkpoint_origins").some(row => JSON.parse(row.origin_json).publicationKind === "handoff_acceptance")) return true;
  }
  for (const head of rows("continuity_heads")) {
    if (head.role !== "run" && !rows("continuity_checkpoints").some(row => row.digest === head.digest && row.role === head.role)) return true;
  }
  // Embedded executable projections require their own concrete owner references.
  for (const [key, value] of Object.entries(state)) {
    if (["builder", "qa", "sessionBindings"].includes(key) && value) {
      const invalidSession = (candidate: unknown): boolean => {
        if (!candidate || typeof candidate !== "object") return false;
        if (Array.isArray(candidate)) return candidate.some(invalidSession);
        const object = candidate as Row;
        if ("sessionId" in object && !hasSession(object.sessionRef ?? object)) return true;
        if (object.sessionRef && !hasSession(object.sessionRef)) return true;
        return Object.values(object).some(invalidSession);
      };
      if (invalidSession(value)) return true;
    }
    if (key === "receipts" && value && Object.values(value).some(receipt => !receipt || typeof receipt !== "object" || !operations.some(operation => operation.idempotency_key === (receipt as Row).dispatchId))) return true;
  }
  for (const ticket of state.progress?.completedTickets ?? []) {
    const completion = db.prepare("SELECT intent_json FROM operation_journal WHERE run_id=? AND kind IN ('ticket-complete','synthetic-completion') AND status='confirmed'").all(run.run_id) as Row[];
    if (!completion.some(row => {
      const intent = JSON.parse(row.intent_json);
      return [intent.ticket,intent.ticketId,intent.workId].includes(ticket) && typeof intent.dispatchId === "string" && operations.some(operation => operation.idempotency_key === intent.dispatchId);
    })) return true;
  }
  if (!operations.length && (state.version !== undefined || state.progress?.completedTickets?.length || rows("qa_recovery_heads").length || rows("qa_verification_contracts").length)) return true;

  return false;
}

/** Archive then delete only selected rows. Foreign-key closure computes child ownership and deletion order. */
export function purgeStructuredRun(db: Database.Database, runId: string, matrix: CutoverOwnershipEntry[], fileReferences: ReadonlySet<string> = new Set()): number {
  const selected = new Map<string, Map<number, Row>>();
  for (const entry of matrix) {
    const rows = entry.columns.includes("run_id") ? db.prepare(`SELECT rowid AS _cutover_rowid,* FROM ${quote(entry.table)} WHERE run_id=?`).all(runId) as Row[]
      : entry.disposition === "purge-owned" && entry.columns.includes("record_json")
        ? db.prepare(`SELECT rowid AS _cutover_rowid,* FROM ${quote(entry.table)} WHERE json_valid(record_json) AND json_extract(record_json,'$.runId')=?`).all(runId) as Row[] : [];
    selected.set(entry.table, new Map(rows.map(row => [row._cutover_rowid, row])));
  }
  const sessionRows = selected.get("provider_sessions");
  const bindingRows = selected.get("provider_session_bindings");
  if (sessionRows && bindingRows) for (const session of sessionRows.values()) {
    if (!session.session_key) continue;
    const shared = db.prepare("SELECT 1 FROM provider_sessions WHERE session_key=? AND run_id<>? LIMIT 1").get(session.session_key, runId);
    if (shared) continue;
    const binding = db.prepare("SELECT rowid AS _cutover_rowid,* FROM provider_session_bindings WHERE session_key=?").get(session.session_key) as Row | undefined;
    if (binding) bindingRows.set(binding._cutover_rowid, binding);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of matrix.filter(entry => entry.disposition === "purge-owned")) {
      const groups = new Map<number, ForeignKey[]>();
      for (const fk of entry.foreignKeys) groups.set(fk.id, [...groups.get(fk.id) ?? [], fk]);
      for (const keys of groups.values()) {
        const parents = selected.get(keys[0]!.table);
        if (!parents?.size) continue;
        for (const row of db.prepare(`SELECT rowid AS _cutover_rowid,* FROM ${quote(entry.table)}`).all() as Row[]) {
          if (selected.get(entry.table)!.has(row._cutover_rowid)) continue;
          if ([...parents.values()].some(parent => keys.every(key => row[key.from] !== null && row[key.from] === parent[key.to]))) {
            selected.get(entry.table)!.set(row._cutover_rowid, row); changed = true;
          }
        }
      }
    }
    // Check history predates the FK-owned contract tables. Its ownership key
    // is the stable contractId in the persisted contract, not its digest.
    const contracts = selected.get("qa_verification_contracts");
    const history = selected.get("qa_contract_check_history");
    if (contracts?.size && history) {
      const ids = new Set([...contracts.values()].flatMap(row => {
        try { const value = JSON.parse(row.record_json); return typeof value.contractId === "string" ? [value.contractId] : []; }
        catch { return []; }
      }));
      const survivors = db.prepare("SELECT rowid AS id,record_json FROM qa_verification_contracts").all() as Row[];
      for (const row of survivors) if (!contracts.has(row.id)) {
        try { ids.delete(JSON.parse(row.record_json).contractId); } catch { ids.clear(); }
      }
      for (const row of db.prepare("SELECT rowid AS _cutover_rowid,* FROM qa_contract_check_history").all() as Row[]) {
        if (ids.has(row.contract_id) && !history.has(row._cutover_rowid)) { history.set(row._cutover_rowid, row); changed = true; }
      }
    }
  }
  const pending = matrix.filter(entry => entry.disposition === "purge-owned");
  const order: CutoverOwnershipEntry[] = [];
  while (pending.length) {
    const index = pending.findIndex(parent => !pending.some(child => child.table !== parent.table && child.foreignKeys.some(fk => fk.table === parent.table)));
    if (index < 0) throw new Error("Cutover ownership matrix has an unresolved foreign-key cycle");
    order.push(pending.splice(index, 1)[0]!);
  }
  let count = 0;
  const communicationOwners = [...selected.get("operation_journal")?.values() ?? []].map(row => row.idempotency_key as string);
  const evidenceCandidates = new Set<string>();
  for (const owner of communicationOwners) {
    for (const row of db.prepare("SELECT evidence_digest FROM communication_evidence_refs WHERE owner_kind='provider-dispatch' AND owner_id=?").all(owner) as Array<{ evidence_digest: string }>) evidenceCandidates.add(row.evidence_digest);
    db.prepare("DELETE FROM communication_evidence_refs WHERE owner_kind='provider-dispatch' AND owner_id=?").run(owner);
  }
  for (const entry of order) for (const [id, row] of selected.get(entry.table)!) {
    db.prepare("INSERT INTO structured_cutover_quarantine(run_id,table_name,row_json) VALUES(?,?,?)").run(runId, entry.table, JSON.stringify(row));
    db.prepare(`DELETE FROM ${quote(entry.table)} WHERE rowid=?`).run(id); count++;
  }
  // Only normalized references prove ownership. Legacy blobs without such a
  // reference are ambiguous and are deliberately retained. Any surviving DB
  // reference, including unknown JSON fields and historical user answers,
  // keeps shared bytes alive.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  for (const digest of evidenceCandidates) {
    if (fileReferences.has("*") || fileReferences.has(digest)) continue;
    if (db.prepare("SELECT 1 FROM communication_evidence_refs WHERE evidence_digest=?").get(digest)) continue;
    let shared = false;
    for (const { name } of tables) {
      if (name === "structured_cutover_quarantine" || name === "structured_communication_cutover") continue;
      for (const row of db.prepare(`SELECT * FROM ${quote(name)}`).all() as Row[]) {
        if (name === "content_refs" && evidenceCandidates.has(row.digest)) continue;
        if (Object.values(row).some(value => typeof value === "string" && value.includes(digest) || Buffer.isBuffer(value) && value.includes(Buffer.from(digest)))) { shared = true; break; }
      }
      if (shared) break;
    }
    if (!shared) db.prepare("DELETE FROM content_refs WHERE digest=?").run(digest);
  }
  return count;
}
