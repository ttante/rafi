import type Database from "better-sqlite3";
import type { QaContractCandidateV1, VerificationCheckV1, VerificationMethod } from "rafi-spec";
import { canonicalJson } from "./qaProtocolV2.js";
import { contractDigest } from "./qaVerificationContract.js";

export interface AuthorizedEquivalentV1 {
  version: 1; kind: "qa-equivalent-verification"; runId: string; workId: string; admissionDigest: string;
  contractId: string; revision: number; checkId: string; expectationDigest: string;
  method: Omit<VerificationMethod, "equivalentAuthorityId">; reason: string;
  validity: { runtime: string; expiresAt: string; sourceDigest?: string };
}
export type EquivalentAuthorityResolver = (reference: string, candidate: QaContractCandidateV1, check: VerificationCheckV1, method: VerificationMethod, sourceDigest?: string, nowMs?: number) => boolean;
export function expectationDigest(check: VerificationCheckV1): string {
  const { verification: _methods, dispositionRef: _disposition, ...expectation } = check;
  return contractDigest("equivalent-expectation", expectation);
}
/** Only a human answer to an exactly scoped host decision supplies approval. Agent strings never do. */
export function persistedEquivalentResolver(db: Database.Database): EquivalentAuthorityResolver {
  return (reference, candidate, check, method, sourceDigest, nowMs = Date.now()) => {
    const row = db.prepare("SELECT decision_json FROM human_decisions WHERE decision_id=? AND run_id=?").get(reference, candidate.runId) as { decision_json: string } | undefined;
    if (!row) return false;
    const decision = JSON.parse(row.decision_json) as import("rafi-spec").PendingHumanDecision;
    if (decision.status !== "answered" || decision.selectedChoiceId !== "custom" || !decision.answeredAt || decision.interruptionId !== `qa-equivalent:${candidate.contractId}:${candidate.revision}:${check.id}` || !decision.answer) return false;
    let authority: AuthorizedEquivalentV1; try { authority = JSON.parse(decision.answer); } catch { return false; }
    const { equivalentAuthorityId: _reference, ...concreteMethod } = method;
    return authority.version === 1 && authority.kind === "qa-equivalent-verification" && authority.runId === candidate.runId && authority.workId === candidate.workId && authority.admissionDigest === candidate.admissionDigest && authority.contractId === candidate.contractId && authority.revision === candidate.revision && authority.checkId === check.id && authority.expectationDigest === expectationDigest(check) && Boolean(authority.reason?.trim()) && canonicalJson(authority.method) === canonicalJson(concreteMethod) && authority.validity?.runtime === method.runtime && Date.parse(authority.validity.expiresAt) > nowMs && (!authority.validity.sourceDigest || authority.validity.sourceDigest === sourceDigest);
  };
}
