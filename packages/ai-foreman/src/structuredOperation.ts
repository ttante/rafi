import { sealTicketPopulationPage } from "./ticketPopulationPageAuthority.js";
import { boundedUtf8 } from "./boundedTurnEvidence.js";
import { randomUUID } from "node:crypto";
import { assertIntermediateResultV2, historicProviderWireContract, providerWireContract, renderProviderWireInstruction, selectedDispatchTupleV2, structuredDigest, validateStructuredCandidate, type OperationResponse, type OutputContract } from "rafi-spec";
import { WorkflowDb } from "./workflowDb.js";
import type { BuilderAdapter, TurnRequest, TurnResult } from "./adapters/types.js";
import type { StepStatus } from "./foreman.js";
import { withSealedDispatch, currentFreshRecoveryValidation } from "./structuredDispatchAuthority.js";
import { sealedDispatchRecord, verifyPersistedDispatch, type RetainedStructuredReceiptV2 } from "./structuredDispatchRecord.js";

export function operationInstruction(contract: OutputContract): string {
  return `Rafi operation ${contract.operation}, protocol 2, schema ${contract.schemaVersion}. Submit only the native JSON selected by the provider wire contract appended by Rafi. Do not emit prose delimiters, status lines, host identifiers, host defaults, or fields outside that selected schema. Keep provider-authored summaries and evidence concise. Human progress is presentation only.`;
}

export function operationResponse<T = unknown>(turn: TurnResult, contract: OutputContract): OperationResponse<T> {
  if (turn.isError || turn.failure) throw new Error(turn.structured?.state === "rejected" ? turn.structured.detail : turn.text || "Provider execution did not complete");
  if (!turn.selectedDispatch) throw new Error("Structured provider turn has no sealed selected dispatch tuple");
  const descriptor = historicProviderWireContract(contract, turn.selectedDispatch);
  const response = validateStructuredCandidate(contract, turn.structured, descriptor, turn.selectedDispatch) as OperationResponse<T>;
  if (response.result.kind.endsWith("-request")) assertIntermediateResultV2(response.result);
  return response;
}

export function operationStatus(turn: TurnResult, contract: OutputContract, ticket?: string): StepStatus {
  try {
    const { result } = operationResponse(turn, contract);
    if (result.kind === "completed") {
      return { kind: "done", summary: result.summary, ticket };
    }
    if (result.kind === "blocked") return { kind: "blocked", reason: result.reason, next: result.nextAction, ticket, ...(result.branchDependency ? { branchDependency: result.branchDependency } : {}) };
    if (result.kind === "needs-input") return { kind: "needs_input", question: result.question, choices: result.choices, ticket };
    if (result.kind === "source-request") return { kind: "needs_input", question: "Additional source material is required. Supply or authorize the requested source content.", choices: [], ticket };
    return { kind: "unknown", error: `Unconsumed intermediate result: ${result.kind}` };
  } catch (error) { return { kind: "unknown", error: boundedUtf8(String(error), 4000).toString() }; }
}

export function operationPayload<T>(turn: TurnResult, contract: OutputContract): T {
  const response = operationResponse<T>(turn, contract);
  if (response.result.kind !== "completed") throw new Error(`Operation ${contract.operation} returned ${response.result.kind}`);
  return response.result.payload;
}

export function nativePolicy(output: OutputContract, policy: TurnRequest = {}): TurnRequest {
  return { ...policy, output, logicalActionId: policy.logicalActionId ?? randomUUID(), dispatchId: policy.dispatchId ?? randomUUID() };
}

/** Reuses the workflow journal. A receipt is retained before domain interpretation. */
export async function journalStructuredDispatch(root: string, adapter: BuilderAdapter, instruction: string, policy: TurnRequest,
  dispatch: (text: string, policy: TurnRequest) => Promise<TurnResult>): Promise<TurnResult> {
  if (!policy.output) return dispatch(instruction, policy);
  if (!adapter.prepareSession) throw new Error("Structured dispatch requires an adapter that prepares a scoped provider session");
  const selected = nativePolicy(policy.output, policy);
  const key = selected.dispatchId!;
  const runId = selected.journalRunId ?? `operation:${selected.logicalActionId}`;
  const db = new WorkflowDb(root);
  try {
    db.enableStructuredCommunication();
    db.ensureRun(runId);
    if (adapter.postConfirmedDispatch) for (const pendingId of db.pendingStructuredPostprocessing(runId)) {
      if (pendingId === selected.parentDispatchId) continue;
      const pending = db.operation(pendingId);
      if (pending?.status !== "confirmed") throw new Error("Postprocessing origin is not confirmed");
      const tuple = db.structuredOwnerDispatch(pendingId);
      // Rehydrate and publish locally; this path never calls raw transport.
      await adapter.postConfirmedDispatch({dispatchId:pendingId,runId,tupleDigest:tuple.tupleDigest});
      db.completeStructuredPostprocessing(pendingId);
      db.finishStructuredContinuation(pendingId);
    }
    db.assertStructuredDispatchAdmission(runId, key, selected.parentDispatchId, policy.output.operation);
    const prior = db.planOperation({ runId, idempotencyKey: key, kind: "provider-dispatch", intent: {
      protocolVersion: 2, state: "preparing", logicalActionId: selected.logicalActionId,
      operation: policy.output.operation, schemaVersion: policy.output.schemaVersion, schemaDigest: policy.output.schemaDigest,
      instructionDigest: structuredDigest(instruction), purpose: selected.purpose ?? "implementation",
    } });
    if (prior.status !== "planned") throw new Error("Existing structured dispatch requires reconciliation; it cannot be replayed");
    // Session bootstrap can itself contact the provider.  The non-authoritative
    // preparation record above is durable before that boundary is crossed.
    const prepared = await adapter.prepareSession();
  if (!prepared.sessionId || !Number.isSafeInteger(prepared.generation) || prepared.generation < 0) throw new Error("Adapter did not prepare a valid provider session for structured dispatch");
  const wireContract = providerWireContract(policy.output, adapter.agent, "default", { requireRegistered: true });
  if (policy.wireContract && policy.wireContract.descriptorDigest !== wireContract.descriptorDigest) throw new Error("New dispatch may select only the static active descriptor");
  if (wireContract.provider !== adapter.agent || wireContract.canonical.schemaDigest !== policy.output.schemaDigest) throw new Error("Structured dispatch wire contract does not match its adapter/output contract");
  if (policy.renderedWireContractDigest && policy.renderedWireContractDigest !== wireContract.descriptorDigest) throw new Error("Structured dispatch guidance does not match its selected wire contract");
  const renderedInstruction = renderProviderWireInstruction(instruction, wireContract);
  const sealedSelection = nativePolicy(policy.output, { ...selected, wireContract, renderedWireContractDigest: wireContract.descriptorDigest });
  const before = adapter.sessionRef?.();
  if (!before || before.sessionId !== prepared.sessionId || before.generation !== prepared.generation) throw new Error("Prepared provider session is not the adapter's active scoped session");
  const tuple = selectedDispatchTupleV2({
    operation: policy.output.operation, schemaVersion: policy.output.schemaVersion, schemaDigest: policy.output.schemaDigest,
    provider: adapter.agent, profile: wireContract.profile, variant: wireContract.variant, descriptorDigest: wireContract.descriptorDigest,
    wireSchemaDigest: wireContract.wireSchemaDigest, guidanceDigest: wireContract.guidanceDigest,
    normalizerId: wireContract.normalizerId, normalizerVersion: wireContract.normalizerVersion,
    maximumSchemaBytes: wireContract.maximumSchemaBytes, maximumResponseBytes: wireContract.maximumResponseBytes,
    maximumPageBytes: wireContract.maximumPageBytes ?? null, instructionDigest: structuredDigest(renderedInstruction),
    actionId: sealedSelection.logicalActionId!, dispatchId: sealedSelection.dispatchId!, sessionId: before.sessionId, generation: before.generation,
  });
  const sealedPolicy: TurnRequest = Object.freeze({ ...sealedSelection, selectedDispatch: tuple });
  const compactionBefore = adapter.contractCompactionSequence?.() ?? 0;
  const intent = { protocolVersion: 2, tuple, sealedDispatch: sealedDispatchRecord(tuple), logicalActionId: selected.logicalActionId, parentDispatchId: selected.parentDispatchId ?? null,
    // The durable role is derived from the scoped provider session, never a
    // caller-controlled string on TurnRequest.
    role: before.role, sessionRef: before, operation: policy.output.operation,
    schemaVersion: policy.output.schemaVersion, schemaDigest: policy.output.schemaDigest, instructionDigest: structuredDigest(renderedInstruction),
    purpose: selected.purpose ?? "implementation", responseOnly: selected.responseOnly === true,
    freshRecoveryValidation: currentFreshRecoveryValidation(root, runId),
    wire: { profile: wireContract.profile, variant: wireContract.variant, wireVersion: wireContract.wireVersion,
      descriptorDigest: wireContract.descriptorDigest, wireSchemaDigest: wireContract.wireSchemaDigest,
      maximumSchemaBytes: wireContract.maximumSchemaBytes, maximumResponseBytes: wireContract.maximumResponseBytes,
      maximumPageBytes: wireContract.maximumPageBytes ?? null, normalizerId: wireContract.normalizerId,
      normalizerVersion: wireContract.normalizerVersion, guidanceId: wireContract.guidanceId } };
    const priorRecord = db.operation(key)!;
    if (priorRecord.status !== "planned") throw new Error("Existing structured dispatch requires reconciliation; it cannot be replayed");
    db.atomic(() => {
      db.linkStructuredHandoffDispatch(key, selected.parentDispatchId, policy.output!.operation);
      db.sealPlannedOperationIntent(key, intent);
      db.sealStructuredOwnerDispatch(key, tuple, renderedInstruction);
      sealTicketPopulationPage(db, root, tuple);
      db.updateOperation(key, "in_progress");
    });
    let turn: TurnResult;
    try { turn = await withSealedDispatch(root, tuple, dispatchCapability => dispatch(renderedInstruction, { ...sealedPolicy, journalRunId: runId, dispatchCapability }), before); }
    catch (error) { if (db.operation(key)?.status === "in_progress") db.updateOperation(key, "uncertain", { error: boundedUtf8(String(error), 4000).toString() }); throw error; }
    const after = adapter.sessionRef?.();
    const sameScope = before && after && before.provider === after.provider && before.role === after.role &&
      before.stream === after.stream && before.cwd === after.cwd && before.configRoot === after.configRoot &&
      before.workspaceIdentity === after.workspaceIdentity && before.ticketId === after.ticketId && before.deliveryUnitId === after.deliveryUnitId;
    const observedCompaction = sameScope && (adapter.contractCompactionSequence?.() ?? 0) > compactionBefore && after!.generation >= before!.generation;
    if (turn.structured?.state === "candidate" && (turn.structured.profile !== wireContract.profile || turn.structured.wireContractDigest !== wireContract.descriptorDigest ||
      turn.structured.wireSchemaDigest !== wireContract.wireSchemaDigest || turn.structured.wireVariant !== wireContract.variant || turn.structured.dispatchId !== key || turn.structured.sessionId !== adapter.sessionId() ||
      before && (!sameScope || !observedCompaction && (before.sessionId !== after!.sessionId || before.generation !== after!.generation)))) {
      turn = { ...turn, selectedDispatch: tuple, isError: true, structured: { state: "rejected", reason: "invalid-contract", detail: "Dispatch/session/generation receipt mismatch", dispatchId: key } };
    }
    // Exact raw provider material is retained once in the evidence store. The
    // journal only carries the digest/reference and validation fact, so it
    // cannot become a second, differently-redacted copy of the provider turn.
    turn = { ...turn, selectedDispatch: tuple };
    let receiptValidated = false;
    if (turn.structured?.state === "rejected") turn = { ...turn, isError: true };
    else if (!turn.isError && !turn.failure) {
      try {
        verifyPersistedDispatch(policy.output, db.structuredOwnerDispatch(key), turn.structured, tuple);
        receiptValidated = true;
      } catch (error) {
        turn = { ...turn, selectedDispatch: tuple, isError: true, structured: { state: "rejected", reason: "invalid-contract", detail: boundedUtf8(String(error), 4000).toString(), dispatchId: key } };
      }
    }
    const retained: RetainedStructuredReceiptV2 = { version: 2, tupleDigest: tuple.digest, hostTurnId: turn.turnId, receipt: turn.structured ?? null };
    if (turn.structured?.state === "candidate") {
      const { value, ...receipt } = turn.structured;
      const bytes = Buffer.from(receipt.representation === "json-text" ? value as string : JSON.stringify(value));
      if (bytes.length > wireContract.maximumResponseBytes) throw new Error("Native receipt exceeds selected evidence budget");
      retained.valueDigest = db.putEvidence("handoff", bytes);
      retained.receipt = receipt;
    }
    if (turn.structured?.state === "rejected") {
      const { observedValue, ...receipt } = turn.structured;
      retained.receipt = { ...receipt, detail: boundedUtf8(receipt.detail, 4000).toString() };
      if (observedValue) {
        const bytes = Buffer.from(observedValue.representation === "json-text" ? String(observedValue.value) : JSON.stringify(observedValue.value));
        const bounded = boundedUtf8(bytes.toString(), wireContract.maximumResponseBytes);
        retained.rejectedValue = { representation: observedValue.representation, digest: observedValue.digest,
          evidenceDigest: db.putEvidence("handoff", bounded), originalBytes: bytes.length, retainedBytes: bounded.length };
      }
    }
    const raw = Buffer.from(turn.rawResponse ?? turn.text);
    const retainedRaw = boundedUtf8(turn.rawResponse ?? turn.text, wireContract.maximumResponseBytes);
    const rawDigest = db.putEvidence("handoff", retainedRaw);
    const responseDigest = db.putEvidence("handoff", Buffer.from(JSON.stringify(retained)));
    db.recordCommunicationEvidenceRefs(key, [responseDigest, rawDigest, ...(retained.valueDigest ? [retained.valueDigest] : []), ...(retained.rejectedValue ? [retained.rejectedValue.evidenceDigest] : [])]);
    const status = turn.failure?.dispatchState === "not-sent" ? "failed" : turn.failure?.dispatchState === "unknown" || !receiptValidated ? "uncertain" : "confirmed";
    turn = { ...turn, transportEvidence: { rawDigest, responseDigest, rawBytes: raw.length, retainedRawBytes: retainedRaw.length,
      valueDigest: retained.valueDigest, rejectedValueDigest: retained.rejectedValue?.evidenceDigest } };
    db.atomic(() => {
    if (status === "confirmed" && adapter.postConfirmedDispatch) db.requireStructuredPostprocessing(key, { instruction, policy: continuationPolicy(selected, key) });
    db.updateOperation(key, status, { result: { responseDigest, rawDigest, rawBytes: raw.length, retainedRawBytes: retainedRaw.length, validation: receiptValidated ? "accepted" : turn.structured?.state ?? "missing-receipt", wireContractDigest: wireContract.descriptorDigest } });
    });
    if (status === "confirmed" && adapter.postConfirmedDispatch) {
      try {
        const processed = await adapter.postConfirmedDispatch({ dispatchId: key, runId, tupleDigest: tuple.digest });
        db.completeStructuredPostprocessing(key);
        db.finishStructuredContinuation(key);
        if (processed) return processed.selectedDispatch?.dispatchId === key
          ? { ...turn, continuity: processed.continuity, continuityErrors: processed.continuityErrors, hostInstruction: processed.hostInstruction, isError: processed.isError }
          : processed;
      } catch (error) {
        db.failStructuredPostprocessing(key, boundedUtf8(String(error), 4000).toString());
        return { ...turn, isError: true, continuityErrors: [boundedUtf8(String(error), 4000).toString()] };
      }
    }
    if (status === "confirmed") db.finishStructuredContinuation(key);
    return turn;
  } catch (error) {
    // A failed bootstrap stays an explicit, non-resumable preparation record.
    const planned = db.operation(key);
    if (planned?.status === "planned") db.updateOperation(key, "failed", { error: boundedUtf8(String(error), 4000).toString() });
    else if (planned?.status === "in_progress") db.updateOperation(key, "uncertain", { error: boundedUtf8(String(error), 4000).toString() });
    throw error;
  } finally { db.close(); }
}

/** Only unsealed host request fields survive a handoff or a restart. */
export function continuationPolicy(policy: TurnRequest, parentDispatchId: string): TurnRequest {
  return { logicalActionId: policy.logicalActionId, journalRunId: policy.journalRunId, purpose: policy.purpose,
    responseOnly: policy.responseOnly, handback: policy.handback, parentDispatchId };
}
