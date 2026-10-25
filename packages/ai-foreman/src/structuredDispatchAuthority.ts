import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJson, structuredDigest, initializationOutput, historicProviderWireContract, type OutputContract, type ProviderSessionRefV1, type SelectedDispatchTupleV2 } from "rafi-spec";
import type { TurnResult } from "./adapters/types.js";

declare const authorityBrand: unique symbol;
/** An in-process capability; JSON or a caller-created owner label cannot mint it. */
export interface StructuredDispatchCapability { readonly [authorityBrand]: true }
const capabilities = new WeakMap<StructuredDispatchCapability, { root: string; tuple: SelectedDispatchTupleV2; submitted: boolean; session?: ProviderSessionRefV1; consume?: () => void }>();
const active = new AsyncLocalStorage<StructuredDispatchCapability>();
const freshRecovery = new AsyncLocalStorage<{ root: string; runId: string; authorization: import("./workflowDb.js").FreshRecoveryValidation }>();

/** Only the host's explicit, durable fresh-recovery decision grants this scope. */
export async function withFreshRecoveryValidation<T>(root: string, runId: string, role: "builder" | "qa",
  send: (authorization: import("./workflowDb.js").FreshRecoveryValidation) => Promise<T>): Promise<T> {
  const { WorkflowDb } = await import("./workflowDb.js");
  const db = new WorkflowDb(root);
  let authorization;
  try { authorization = db.freshRecoveryValidation(runId, role); } finally { db.close(); }
  return freshRecovery.run({ root, runId, authorization }, () => send(authorization));
}

export function currentFreshRecoveryValidation(root: string, runId: string): import("./workflowDb.js").FreshRecoveryValidation | undefined {
  const scope = freshRecovery.getStore();
  return scope?.root === root && scope.runId === runId ? scope.authorization : undefined;
}

function withCapability<T>(root: string, tuple: SelectedDispatchTupleV2,
  send: (capability: StructuredDispatchCapability) => Promise<T>, session?: ProviderSessionRefV1, consume?: () => void): Promise<T> {
  const capability = Object.freeze({}) as StructuredDispatchCapability;
  capabilities.set(capability, { root, tuple, submitted: false, consume, session: session && Object.freeze({ ...session }) });
  return active.run(capability, () => send(capability));
}

export async function withSealedDispatch<T>(root: string, tuple: SelectedDispatchTupleV2,
  send: (capability: StructuredDispatchCapability) => Promise<T>, session?: ProviderSessionRefV1): Promise<T> {
  const { WorkflowDb } = await import("./workflowDb.js");
  const db = new WorkflowDb(root);
  try {
    const claimId = db.claimStructuredSubmission(tuple, session);
    return await withCapability(root, tuple, send, session, () => db.consumeStructuredSubmission(tuple, claimId, session));
  } finally { db.close(); }
}

/** Provider initialization is discarded and cannot use an authoritative operation contract. */
export function withEphemeralInitializationDispatch<T>(root: string, tuple: SelectedDispatchTupleV2,
  send: (capability: StructuredDispatchCapability) => Promise<T>, session: ProviderSessionRefV1): Promise<T> {
  historicProviderWireContract(initializationOutput, tuple);
  if (tuple.operation !== initializationOutput.operation || tuple.sessionId !== session.sessionId || tuple.generation !== session.generation)
    throw new Error("Ephemeral initialization cannot authorize workflow content");
  return withCapability(root, tuple, send, session);
}

export function assertSealedDispatch(root: string, capability: StructuredDispatchCapability,
  tuple: SelectedDispatchTupleV2 | undefined, instruction?: string): void {
  const sealed = capabilities.get(capability);
  if (active.getStore() !== capability || !sealed || sealed.root !== root || sealed.tuple !== tuple ||
    instruction !== undefined && structuredDigest(instruction) !== sealed.tuple.instructionDigest)
    throw new Error("Structured dispatch requires the active committed sealing capability");
}

export function assertActiveProviderDispatch(policy: import("./adapters/types.js").TurnRequest, instruction: string, provider?: "claude" | "codex", session?: ProviderSessionRefV1): asserts policy is import("./adapters/types.js").SealedTurnPolicy {
  if (!policy.output) throw new Error("Sealed provider policy requires an output contract");
  const capability = policy.dispatchCapability;
  const sealed = capability && capabilities.get(capability);
  if (!capability || !sealed) throw new Error("Structured provider send requires a committed sealing capability");
  assertSealedDispatch(sealed.root, capability, policy.selectedDispatch, instruction);
  if (policy.output.operation !== sealed.tuple.operation || policy.output.schemaDigest !== sealed.tuple.schemaDigest || policy.output.schemaVersion !== sealed.tuple.schemaVersion)
    throw new Error("Structured output contract differs from its sealed owner tuple");
  if (provider && sealed.tuple.provider !== provider) throw new Error("Sealed dispatch belongs to another provider");
  if (sealed.session && (!session || (["provider", "sessionId", "role", "stream", "generation", "cwd", "configRoot", "workspaceIdentity", "ticketId", "deliveryUnitId"] as const)
    .some(field => session[field] !== sealed.session![field]))) throw new Error("Provider session scope changed after dispatch sealing");
  if (!policy.wireContract || policy.renderedWireContractDigest !== policy.wireContract.descriptorDigest ||
    policy.wireContract.descriptorDigest !== sealed.tuple.descriptorDigest || policy.dispatchId !== sealed.tuple.dispatchId)
    throw new Error("Structured provider policy differs from its sealed descriptor");
  if (sealed.submitted) throw new Error("Sealed structured dispatch was already submitted; reconcile before a new dispatch");
  sealed.consume?.();
  sealed.submitted = true;
}

const ownerDispatches = new WeakSet<Function>();
/** Domain callbacks create their durable turn before entering the sealing gateway. */
export function durableOwnerDispatch<T extends (...args: any[]) => Promise<TurnResult>>(root: string, output: OutputContract, owner: { runId: string; actionId: string }, dispatch: T): T {
  const owned = async (...args: Parameters<T>): Promise<TurnResult> => {
    const { WorkflowDb } = await import("./workflowDb.js");
    const preparation = new WorkflowDb(root);
    try {
      const record = output.operation === "qa-verdict" ? preparation.qaReviewAttempt(owner.actionId)
        : output.operation === "builder-remediation" ? preparation.qaRemediationAttempt(owner.actionId) : undefined;
      if (!record || record.runId !== owner.runId || record.status !== "started") throw new Error("Domain dispatch requires its active persisted owner attempt");
    } finally { preparation.close(); }
    const result = await dispatch(...args);
    if (!result.isError && !result.failure) {
      if (!result.selectedDispatch) throw new Error("Durable owner returned an unsealed provider turn");
      const db = new WorkflowDb(root);
      try {
        if (result.selectedDispatch.actionId !== owner.actionId || db.operation(result.selectedDispatch.dispatchId)?.runId !== owner.runId ||
          db.structuredOwnerDispatch(result.selectedDispatch.dispatchId).tupleDigest !== result.selectedDispatch.digest)
          throw new Error("Domain callback returned a receipt for another owner");
        db.replayStructuredDispatch(result.selectedDispatch.dispatchId, output);
      }
      finally { db.close(); }
    }
    return result;
  };
  ownerDispatches.add(owned);
  return owned as T;
}
export function isDurableOwnerDispatch(dispatch: Function): boolean { return ownerDispatches.has(dispatch); }
