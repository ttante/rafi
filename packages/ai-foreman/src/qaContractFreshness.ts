import type { ContractInputRef, QaVerificationContractV1 } from "rafi-spec";
import { contractDigest } from "./qaVerificationContract.js";

/** Source implementing the contract is not a semantic freshness input. */
export function compareContractInputs(contract: QaVerificationContractV1, current: ContractInputRef[]): { changed: string[]; unavailable: string[]; targetedBaseline: string[] } {
  const changed: string[] = [], unavailable: string[] = [], targetedBaseline: string[] = [];
  for (const input of contract.inputs) {
    const next = current.find(ref => ref.id === input.id);
    if (!next || next.availability !== "available") { unavailable.push(input.id); continue; }
    if (next.digest !== input.digest || next.authority !== input.authority || next.revision !== input.revision) (input.kind === "baseline" ? targetedBaseline : changed).push(input.id);
  }
  for (const input of current) if (!contract.inputs.some(ref => ref.id === input.id) && input.kind !== "baseline") changed.push(input.id);
  return { changed, unavailable, targetedBaseline };
}
export function reconcileContractChecks(before: QaVerificationContractV1, after: QaVerificationContractV1) {
  if (before.runId !== after.runId || before.workId !== after.workId || after.predecessorDigest !== before.contentDigest || after.revision !== before.revision + 1) throw new Error("Amendment must identify its exact predecessor/work");
  const unchanged: string[] = [], changed: string[] = [], added: string[] = [], removed: string[] = [];
  for (const check of after.checks) {
    const prior = before.checks.find(row => row.id === check.id);
    if (!prior) added.push(check.id);
    else if (contractDigest("check-meaning", prior) === contractDigest("check-meaning", check)) unchanged.push(check.id);
    else throw new Error(`Changed meaning cannot reuse stable check ID ${check.id}; allocate an explicit successor`);
  }
  for (const prior of before.checks) if (!after.checks.some(check => check.id === prior.id)) removed.push(prior.id);
  return { unchanged, changed, added, removed, rerun: [...changed, ...added], carryForwardCandidates: unchanged };
}
