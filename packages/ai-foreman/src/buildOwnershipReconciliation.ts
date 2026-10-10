import { evidenceRecord, readQaEvidenceSnapshot, type QaEvidenceSnapshot } from "./qaEvidenceReader.js";
import { qaDigest } from "./qaProtocolV2.js";
import { legacyTrackerWorkHints } from "./buildRuns.js";
import type { BuildRunRecordV2 } from "rafi-spec";

/** Inspection describes conflicts; it never expands saved scope or changes source. */
export function assessBuildOwnership(projectDir: string, runId: string, snapshot = readQaEvidenceSnapshot(projectDir, runId)) {
  const state = snapshot.rows.workflow_runs?.[0] ? evidenceRecord(snapshot.rows.workflow_runs[0], "state_json") : undefined;
  const savedScope = Array.isArray(state?.tickets) ? state.tickets.filter((id): id is string => typeof id === "string") : [];
  const observed = observedBuildWork(snapshot);
  const conflicts: Array<Record<string, unknown>> = [];
  const trackerHints=state?.version!==undefined?legacyTrackerWorkHints(projectDir,state as unknown as BuildRunRecordV2):[];
  if(!savedScope.length&&trackerHints.length)conflicts.push({classification:"ownership_unestablished",reason:"Legacy tracker timestamps suggest work, but do not prove run-bound admission",workIds:trackerHints,resolution:"Inspect and supply approval/assignment provenance or authorize inspected mapped work"});
  for (const row of snapshot.rows.build_ownership_conflicts ?? []) if (row.status === "unresolved") conflicts.push({conflictId:row.conflict_id,workId:row.work_id,revision:row.revision,...evidenceRecord(row)});
  for (const id of observed) if (!savedScope.includes(id)) conflicts.push({ workId: id, reason: "retained QA identity is outside saved membership", classification: "ownership_unestablished", resolution: "Supply run-bound approval and assignment provenance, explicitly authorize reconciled scope for fresh verification, or quarantine preserved work" });
  for (const operation of snapshot.rows.operation_journal ?? []) {
    if (operation.kind !== "build-assignment") continue;
    const result = evidenceRecord(operation, "result_json");
    if (result?.reconciliationId) continue;
    if (!result?.rejection && !result?.sourceError && operation.status !== "in_progress" && operation.status !== "uncertain") continue;
    const intent = evidenceRecord(operation, "intent_json");
    conflicts.push({ workId: intent?.ticketId, operationId: operation.idempotency_key, worktree: intent?.worktree, reason: result?.rejection ?? result?.sourceError ?? "provider dispatch outcome is unconfirmed", classification: "assignment_response_conflict", responseDigest: result?.responseDigest, before: intent?.before, after: result?.after,
      resolution: "Preserve and inspect the assignment/source map; approve separation/restoration or explicitly reconciled scope, then run fresh QA. Merely adding the returned ticket is insufficient." });
  }
  return { runId, revision: ownershipRevision(snapshot), savedScope, legacyTrackerHints:{workIds:trackerHints,authority:false,basis:"timestamp correlation only"}, authoritativeAdmissions: snapshot.rows.build_work_admissions ?? [], conflicts, availability: snapshot.availability, unavailableEvidence: snapshot.gaps, allowedRecoveryChoices: conflicts.length ? ["inspect_preserved_evidence", "supply_authorization_provenance", "authorize_reconciled_scope", "quarantine_for_manual_reconciliation"] : [] };
}

export function ownershipRevision(snapshot:QaEvidenceSnapshot):string {
  // Recovery's own lease acquisition cannot invalidate its inspected decision.
  // Scope, source, instructions, QA and publication events remain in the CAS basis.
  const rows=Object.fromEntries(Object.entries(snapshot.rows).filter(([table])=>table!=="project_lease").sort(([a],[b])=>a.localeCompare(b)).map(([table,records])=>[table,records.filter(row=>table!=="workflow_events"||row.checkpoint!=="lease").map(row=>table==="workflow_runs"?Object.fromEntries(Object.entries(row).filter(([key])=>key!=="lease_generation")):row).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
  return qaDigest("build-ownership-revision",{runId:snapshot.runId,rows});
}

export function observedBuildWork(snapshot: QaEvidenceSnapshot): string[] {
  return [...new Set(Object.entries(snapshot.rows).filter(([table]) => table.startsWith("qa_") || table === "build_work_scope" || table === "build_work_admissions").flatMap(([, rows]) => rows.flatMap(row => typeof row.work_id === "string" ? [row.work_id] : typeof row.ticket_id === "string" ? [row.ticket_id] : [])))].sort();
}
