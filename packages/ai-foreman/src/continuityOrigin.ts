import { persistedProviderWireContract } from "rafi-spec";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalJson, providerWireContracts, type OperationResponse } from "rafi-spec";
import { graphDerivedAllowed } from "./graph/derived.js";
import { hydrateStructuredReceipt, persistedDispatchTuple, verifyPersistedDispatch } from "./structuredDispatchRecord.js";

export type CheckpointOrigin =
  | { kind: "provider"; dispatchId: string; publicationKind: string }
  | { kind: "host"; eventSequence: number; inputCheckpointDigests: string[] };

/** Read-only replay: never opens a writer or migrates storage. */
export function verifyCheckpointOrigin(db: Database.Database, projectDir: string, checkpointId: number, visited = new Set<number>()): void {
  if (visited.has(checkpointId)) throw new Error("Cyclic checkpoint provenance");
  visited.add(checkpointId);
  const checkpoint = db.prepare("SELECT * FROM continuity_checkpoints WHERE checkpoint_id=?").get(checkpointId) as Record<string, any> | undefined;
  const row = db.prepare("SELECT origin_json,delta_digest FROM continuity_checkpoint_origins WHERE checkpoint_id=?").get(checkpointId) as { origin_json: string; delta_digest: string } | undefined;
  if (!checkpoint || !row || hash(checkpoint.delta_json) !== row.delta_digest) throw new Error("Checkpoint has no verified provenance");
  const origin = JSON.parse(row.origin_json) as CheckpointOrigin;
  if (origin.kind === "provider") {
    const operation = db.prepare("SELECT * FROM operation_journal WHERE idempotency_key=?").get(origin.dispatchId) as Record<string, any> | undefined;
    if (!operation || operation.run_id !== checkpoint.run_id || operation.status !== "confirmed") throw new Error("Checkpoint origin is not a confirmed dispatch in this run");
    const intent = JSON.parse(operation.intent_json), result = JSON.parse(operation.result_json);
    const tuple = persistedDispatchTuple(intent.sealedDispatch);
    if (canonicalJson(intent.tuple) !== intent.sealedDispatch.tupleJson || tuple.dispatchId !== origin.dispatchId || intent.sessionRef?.role !== checkpoint.role)
      throw new Error("Checkpoint origin tuple/role mismatch");
    const frozen = intent.sessionRef;
    if (!frozen || frozen.sessionId !== tuple.sessionId || frozen.provider !== tuple.provider || frozen.generation !== tuple.generation)
      throw new Error("Checkpoint origin frozen session mismatch");
    const review = db.prepare("SELECT intent_json FROM qa_turns WHERE operation_id=?").get(origin.dispatchId) as {intent_json:string}|undefined;
    if (review && canonicalJson(JSON.parse(review.intent_json).sealedDispatch) !== canonicalJson(intent.sealedDispatch)) throw new Error("Checkpoint QA owner differs from transport intent");
    const delivery = db.prepare("SELECT record_json FROM qa_delivery_turns WHERE turn_record_id=?").get(origin.dispatchId) as {record_json:string}|undefined;
    if (delivery && canonicalJson(JSON.parse(delivery.record_json).sealedDispatch) !== canonicalJson(intent.sealedDispatch)) throw new Error("Checkpoint remediation owner differs from transport intent");
    const descriptor = persistedProviderWireContract(tuple);
    if (!descriptor || result.validation !== "accepted") throw new Error("Checkpoint origin descriptor/validation mismatch");
    const read = (digest: string): Buffer => {
      const bytes = (db.prepare("SELECT content FROM content_refs WHERE digest=?").get(digest) as { content: Buffer } | undefined)?.content;
      if (!bytes || hash(bytes) !== digest || !graphDerivedAllowed(db, projectDir, digest)) throw new Error("Checkpoint origin evidence missing, altered or revoked");
      return bytes;
    };
    const retained = JSON.parse(read(result.responseDigest).toString());
    if (retained.tupleDigest !== tuple.digest) throw new Error("Checkpoint origin receipt tuple mismatch");
    const response = verifyPersistedDispatch(descriptor.canonical, intent.sealedDispatch, hydrateStructuredReceipt(retained, read)) as OperationResponse;
    if (canonicalJson(response.continuity) !== canonicalJson(JSON.parse(checkpoint.delta_json))) throw new Error("Checkpoint delta differs from its native origin");
    if (checkpoint.session_ref_json) {
      const session = JSON.parse(checkpoint.session_ref_json);
      if ((["provider","role","stream","cwd","configRoot","workspaceIdentity","ticketId","deliveryUnitId"] as const).some(field => session[field] !== frozen[field])) throw new Error("Checkpoint scoped session differs from transport");
      if (session.sessionId !== tuple.sessionId || session.generation !== tuple.generation) {
        // Generation promotion is permitted only by the recorded accepted handoff.
        const acceptance = db.prepare("SELECT acceptance_receipt_digest FROM handoffs WHERE run_id=? AND successor_session_id=? AND generation=? AND state='accepted'").get(checkpoint.run_id, session.sessionId, session.generation) as {acceptance_receipt_digest:string}|undefined;
        if (!acceptance) throw new Error("Checkpoint session differs from its dispatch");
        const receipt = JSON.parse(read(acceptance.acceptance_receipt_digest).toString());
        if (receipt.runId !== checkpoint.run_id || receipt.role !== checkpoint.role || receipt.acceptanceCheckpointDigest !== checkpoint.digest
          || canonicalJson(receipt.successorSessionRef) !== canonicalJson(session) || session.sessionId !== tuple.sessionId)
          throw new Error("Checkpoint generation promotion lacks its exact accepted handoff lineage");
      }
    }
  } else if (origin.kind === "host") {
    const event = db.prepare("SELECT run_id,role,payload_json FROM continuity_events WHERE sequence=?").get(origin.eventSequence) as Record<string, any> | undefined;
    if (!event || event.run_id !== checkpoint.run_id || event.role !== "host" || JSON.parse(event.payload_json).checkpointDeltaDigest !== row.delta_digest)
      throw new Error("Host checkpoint event provenance mismatch");
    for (const digest of origin.inputCheckpointDigests) {
      const input = db.prepare("SELECT checkpoint_id FROM continuity_checkpoints WHERE run_id=? AND digest=?").get(checkpoint.run_id, digest) as {checkpoint_id:number}|undefined;
      if (!input || input.checkpoint_id >= checkpointId) throw new Error("Host checkpoint input is unavailable or not a predecessor");
      verifyCheckpointOrigin(db, projectDir, input.checkpoint_id, new Set(visited));
    }
  } else throw new Error("Unknown checkpoint provenance");
}
function hash(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export function verifyContinuityHeads(db: Database.Database, projectDir: string, runId: string): void {
  const heads = db.prepare("SELECT * FROM continuity_heads WHERE run_id=? ORDER BY role").all(runId) as Array<Record<string, any>>;
  const roles = heads.filter(head => head.role !== "run");
  for (const head of roles) {
    const checkpoint = db.prepare("SELECT checkpoint_id,event_sequence FROM continuity_checkpoints WHERE run_id=? AND role=? AND digest=?").get(runId, head.role, head.digest) as {checkpoint_id:number;event_sequence:number}|undefined;
    if (!checkpoint || checkpoint.event_sequence !== head.event_sequence) throw new Error("Continuity head has no matching checkpoint");
    verifyCheckpointOrigin(db, projectDir, checkpoint.checkpoint_id);
  }
  const run = heads.find(head => head.role === "run");
  if (run && (run.digest !== hash(canonicalJson(roles.map(row => ({role:row.role,digest:row.digest})))) || run.event_sequence !== Math.max(...roles.map(row => row.event_sequence))))
    throw new Error("Run continuity head differs from its verified role heads");
}
