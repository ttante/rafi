import { randomUUID } from "node:crypto";
import { providerWireContract, renderProviderWireInstruction, structuredDigest, validateStructuredCandidate, type OperationResponse, type OutputContract } from "rafi-spec";
import { WorkflowDb } from "./workflowDb.js";
import type { BuilderAdapter, TurnPolicy, TurnResult } from "./adapters/types.js";
import type { StepStatus } from "./foreman.js";

export function operationInstruction(contract: OutputContract): string {
  return `Rafi operation ${contract.operation}, protocol 1, schema ${contract.schemaVersion}. Submit only the native JSON selected by the provider wire contract appended by Rafi. Do not emit prose delimiters, status lines, host identifiers, host defaults, or fields outside that selected schema. Keep provider-authored summaries and evidence concise. Human progress is presentation only.`;
}

export function operationResponse<T = unknown>(turn: TurnResult, contract: OutputContract): OperationResponse<T> {
  if (turn.isError || turn.failure) throw new Error(turn.structured?.state === "rejected" ? turn.structured.detail : turn.text || "Provider execution did not complete");
  return validateStructuredCandidate(contract, turn.structured) as OperationResponse<T>;
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
  } catch (error) { return { kind: "unknown", error: String(error) }; }
}

export function operationPayload<T>(turn: TurnResult, contract: OutputContract): T {
  const response = operationResponse<T>(turn, contract);
  if (response.result.kind !== "completed") throw new Error(`Operation ${contract.operation} returned ${response.result.kind}`);
  return response.result.payload;
}

export function nativePolicy(output: OutputContract, policy: TurnPolicy = {}): TurnPolicy {
  return { ...policy, output, logicalActionId: policy.logicalActionId ?? randomUUID(), dispatchId: policy.dispatchId ?? randomUUID() };
}

/** Reuses the workflow journal. A receipt is retained before domain interpretation. */
export async function journalStructuredDispatch(root: string, adapter: BuilderAdapter, instruction: string, policy: TurnPolicy,
  dispatch: (text: string, policy: TurnPolicy) => Promise<TurnResult>): Promise<TurnResult> {
  if (!policy.output || policy.journaled) return dispatch(instruction, policy);
  const wireContract = policy.wireContract ?? providerWireContract(policy.output, adapter.agent, "default", { requireRegistered: true });
  if (wireContract.provider !== adapter.agent || wireContract.canonical.schemaDigest !== policy.output.schemaDigest) throw new Error("Structured dispatch wire contract does not match its adapter/output contract");
  if (policy.renderedWireContractDigest && policy.renderedWireContractDigest !== wireContract.descriptorDigest) throw new Error("Structured dispatch guidance does not match its selected wire contract");
  const renderedInstruction = renderProviderWireInstruction(instruction, wireContract);
  const selected = nativePolicy(policy.output, { ...policy, wireContract, renderedWireContractDigest: wireContract.descriptorDigest });
  const key = selected.dispatchId!;
  const runId = selected.journalRunId ?? `operation:${selected.logicalActionId}`;
  const before = adapter.sessionRef?.();
  const compactionBefore = adapter.contractCompactionSequence?.() ?? 0;
  const db = new WorkflowDb(root);
  const intent = { protocolVersion: 1, logicalActionId: selected.logicalActionId, parentDispatchId: selected.parentDispatchId ?? null,
    role: before?.role ?? selected.journalRole ?? adapter.agent, sessionRef: before ?? null, operation: policy.output.operation,
    schemaVersion: policy.output.schemaVersion, schemaDigest: policy.output.schemaDigest, instructionDigest: structuredDigest(renderedInstruction),
    purpose: selected.purpose ?? "implementation", responseOnly: selected.responseOnly === true,
    wire: { profile: wireContract.profile, variant: wireContract.variant, wireVersion: wireContract.wireVersion,
      descriptorDigest: wireContract.descriptorDigest, wireSchemaDigest: wireContract.wireSchemaDigest,
      maximumSchemaBytes: wireContract.maximumSchemaBytes, maximumResponseBytes: wireContract.maximumResponseBytes,
      maximumPageBytes: wireContract.maximumPageBytes ?? null, normalizerId: wireContract.normalizerId,
      normalizerVersion: wireContract.normalizerVersion, guidanceId: wireContract.guidanceId } };
  try {
    db.enableStructuredCommunication();
    db.ensureRun(runId);
    const prior = db.operation(key);
    if (prior?.intent && typeof prior.intent === "object" && "sessionRef" in prior.intent) {
      const pinned = prior.intent as typeof intent;
      // A first dispatch may create its session. Replaying its retained receipt
      // does not constitute a new dispatch or a new session binding.
      intent.sessionRef = pinned.sessionRef;
      intent.role = pinned.role;
    }
    const record = db.planOperation({ runId, idempotencyKey: key, kind: "provider-dispatch", intent });
    if (prior) {
      if (record.status === "confirmed" && record.result && typeof record.result === "object") {
        const result = record.result as { responseDigest?: string; turn?: TurnResult };
        if (result.responseDigest) {
          const evidence = db.getEvidence(result.responseDigest);
          if (!evidence) throw new Error("Confirmed structured dispatch is missing retained evidence; it cannot advance");
          const retained = JSON.parse(evidence.toString()) as { version: number; turn: TurnResult };
          if (retained.version !== 1 || !retained.turn) throw new Error("Confirmed structured dispatch has malformed retained evidence");
          return retained.turn;
        }
        // Read-only support for records written before the evidence-only
        // journal format. Do not use this branch for a new writer.
        if (result.turn) return result.turn;
      }
      throw new Error("Existing structured dispatch requires reconciliation; it cannot be replayed");
    }
    db.updateOperation(key, "in_progress");
    let turn: TurnResult;
    try { turn = await dispatch(renderedInstruction, { ...selected, journaled: true, journalRunId: runId }); }
    catch (error) { db.updateOperation(key, "uncertain", { error: String(error) }); throw error; }
    const after = adapter.sessionRef?.();
    const sameScope = before && after && before.provider === after.provider && before.role === after.role &&
      before.stream === after.stream && before.cwd === after.cwd && before.configRoot === after.configRoot &&
      before.workspaceIdentity === after.workspaceIdentity && before.ticketId === after.ticketId && before.deliveryUnitId === after.deliveryUnitId;
    const observedCompaction = sameScope && (adapter.contractCompactionSequence?.() ?? 0) > compactionBefore && after!.generation >= before!.generation;
    if (turn.structured?.state === "candidate" && (turn.structured.profile !== wireContract.profile || turn.structured.wireContractDigest !== wireContract.descriptorDigest ||
      turn.structured.wireSchemaDigest !== wireContract.wireSchemaDigest || turn.structured.wireVariant !== wireContract.variant || turn.structured.dispatchId !== key || turn.structured.sessionId !== adapter.sessionId() ||
      before && (!sameScope || !observedCompaction && (before.sessionId !== after!.sessionId || before.generation !== after!.generation)))) {
      turn = { ...turn, isError: true, structured: { state: "rejected", reason: "invalid-contract", detail: "Dispatch/session/generation receipt mismatch", dispatchId: key } };
    }
    // Exact raw provider material is retained once in the evidence store. The
    // journal only carries the digest/reference and validation fact, so it
    // cannot become a second, differently-redacted copy of the provider turn.
    const responseDigest = db.putEvidence("handoff", Buffer.from(JSON.stringify({ version: 1, turn })));
    const status = turn.failure?.dispatchState === "not-sent" ? "failed" : turn.failure?.dispatchState === "unknown" || !turn.structured ? "uncertain" : "confirmed";
    db.updateOperation(key, status, { result: { responseDigest, validation: turn.structured?.state ?? "missing-receipt", wireContractDigest: wireContract.descriptorDigest } });
    return turn;
  } finally { db.close(); }
}
