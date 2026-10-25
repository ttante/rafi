import { canonicalJson, historicProviderWireContract, parseSelectedDispatchTupleV2, structuredDigest,
  validateStructuredCandidate, type OutputContract, type SelectedDispatchTupleV2, type StructuredResponse } from "rafi-spec";

export interface SealedDispatchRecordV2 {
  version: 2;
  tupleJson: string;
  tupleDigest: string;
  descriptorDigest: string;
  renderedInstructionDigest: string;
}

export interface RetainedStructuredReceiptV2 {
  version: 2;
  tupleDigest: string;
  hostTurnId?: string;
  receipt: Omit<Extract<StructuredResponse, { state: "candidate" }>, "value"> | StructuredResponse | null;
  valueDigest?: string;
  rejectedValue?: { representation: "json-text" | "decoded-json"; digest: string; evidenceDigest: string; originalBytes: number; retainedBytes: number };
}

export function hydrateStructuredReceipt(retained: RetainedStructuredReceiptV2,
  readEvidence: (digest: string) => Buffer | undefined): StructuredResponse | undefined {
  if (!retained.receipt) return undefined;
  if (retained.receipt.state !== "candidate") return retained.receipt;
  if (!retained.valueDigest) throw new Error("Retained native receipt has no bounded value reference");
  const bytes = readEvidence(retained.valueDigest);
  if (!bytes) throw new Error("Retained native receipt value is missing");
  const value = retained.receipt.representation === "json-text" ? bytes.toString() : JSON.parse(bytes.toString());
  return { ...retained.receipt, value };
}

export function sealedDispatchRecord(tuple: SelectedDispatchTupleV2): SealedDispatchRecordV2 {
  return Object.freeze({ version: 2, tupleJson: canonicalJson(tuple), tupleDigest: tuple.digest,
    descriptorDigest: tuple.descriptorDigest, renderedInstructionDigest: tuple.instructionDigest });
}

export function persistedDispatchTuple(record: SealedDispatchRecordV2): SelectedDispatchTupleV2 {
  if (!record || record.version !== 2 || typeof record.tupleJson !== "string") throw new Error("Missing persisted sealed owner tuple");
  const tuple = parseSelectedDispatchTupleV2(JSON.parse(record.tupleJson));
  const { digest, ...fields } = tuple;
  if (canonicalJson(tuple) !== record.tupleJson || structuredDigest(fields) !== digest || record.tupleDigest !== digest ||
    record.descriptorDigest !== tuple.descriptorDigest || record.renderedInstructionDigest !== tuple.instructionDigest)
    throw new Error("Persisted owner tuple canonical bytes or identity mismatch");
  return tuple;
}

/** The same verifier is used before confirmation and by persisted domain readers. */
export function verifyPersistedDispatch<T>(contract: OutputContract<T>, record: SealedDispatchRecordV2,
  receipt: StructuredResponse | undefined, receivedTuple?: SelectedDispatchTupleV2): T {
  const tuple = persistedDispatchTuple(record);
  if (receivedTuple && canonicalJson(receivedTuple) !== record.tupleJson) throw new Error("Receipt tuple differs from persisted owner intent");
  const descriptor = historicProviderWireContract(contract, tuple);
  return validateStructuredCandidate(contract, receipt, descriptor, tuple);
}
