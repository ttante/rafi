import { Ajv } from "ajv";
import { qaContractCoverageV1Schema } from "rafi-spec";
const coverageSchema = new Ajv({ allErrors: true }).compile(qaContractCoverageV1Schema);
import type { QaContractCoverageV1, QaVerificationContractV1 } from "rafi-spec";
import { parsePreparationArtifact } from "./qaVerificationContract.js";

export const COVERAGE_INSTRUCTIONS = `Return RAFI_QA_COVERAGE_START, one QaContractCoverageV1 JSON object, RAFI_QA_COVERAGE_END before the final status marker. Include every check ID with independently evaluated applicability, predicate evidence, outcome (passed/failed/blocked/not-run), and concrete procedure/cwd/runtime/sourceDigest/reference evidence. Missing, blocked, not-run, unresolved applicability, or failed mandatory coverage cannot authorize normal completion. Builder coverage is a claim; final QA independently verifies it.`;
export function parseContractCoverage(text: string): QaContractCoverageV1 { return parsePreparationArtifact(text, "RAFI_QA_COVERAGE"); }
export function validateContractCoverage(contract: QaVerificationContractV1, coverage: QaContractCoverageV1, binding: { phase: "builder" | "qa"; sourceDigest: string; inputBasisDigest: string; attemptId: string; sessionId: string }, requirePass = true): string[] {
  if (!coverageSchema(coverage)) return (coverageSchema.errors ?? []).map(error => `${error.instancePath} ${error.message}`);
  const issues: string[] = [];
  if (coverage.version !== 1 || coverage.runId !== contract.runId || coverage.workId !== contract.workId || coverage.revision !== contract.revision || coverage.contractDigest !== contract.contentDigest) issues.push("Coverage contract/work binding mismatch");
  for (const key of ["phase", "sourceDigest", "inputBasisDigest", "attemptId", "sessionId"] as const) if (coverage[key] !== binding[key]) issues.push(`Coverage ${key} mismatch`);
  if (!Array.isArray(coverage.checks)) return [...issues, "Missing check coverage"];
  const seen = new Set<string>();
  for (const row of coverage.checks) {
    const check = contract.checks.find(check => check.id === row.checkId);
    if (!check || seen.has(row.checkId)) { issues.push(`Unknown/duplicate coverage ${row.checkId}`); continue; } seen.add(row.checkId);
    if (!["applicable", "not-applicable", "unresolved"].includes(row.applicability) || !["passed", "failed", "blocked", "not-run"].includes(row.outcome)) issues.push(`Illegal coverage state ${row.checkId}`);
    if (check.applicability.kind === "unconditional" && row.applicability !== "applicable") issues.push(`Unconditional applicability cannot be waived ${row.checkId}`);
    if (row.applicability === "not-applicable" && !row.predicateEvidence?.length) issues.push(`Not-applicable requires predicate evidence ${row.checkId}`);
    if (check.applicability.kind === "conditional" && row.applicability === "applicable" && !row.predicateEvidence?.length) issues.push(`Conditional applicability requires predicate evidence ${row.checkId}`);
    if (requirePass && check.obligation === "mandatory" && (row.applicability === "unresolved" || row.applicability === "applicable" && row.outcome !== "passed")) issues.push(`Mandatory check incomplete ${row.checkId}`);
    if (!Array.isArray(row.evidence)) issues.push(`Missing evidence array ${row.checkId}`);
    if (row.outcome === "passed" && row.applicability === "applicable") {
      if (binding.phase === "qa" && check.timing === "preimplementation") {
        const baseline = contract.baseline.find(observation => observation.checkId === check.id && observation.status === "passed");
        if (!baseline || !row.evidence?.some(evidence => evidence.reference === baseline.evidenceDigest)) issues.push(`Preimplementation coverage lacks retained baseline authority ${row.checkId}`);
      }
      if (!row.evidence?.length) issues.push(`Passing check requires independent evidence ${row.checkId}`);
      for (const evidence of row.evidence ?? []) if (!evidence.reference?.trim() || !evidence.procedure?.trim() || !evidence.cwd?.trim() || !evidence.runtime?.trim() || check.timing !== "preimplementation" && evidence.sourceDigest !== binding.sourceDigest) issues.push(`Missing/stale source evidence ${row.checkId}`);
    }
  }
  for (const check of contract.checks) if (!seen.has(check.id)) issues.push(`Missing check ${check.id}`);
  return issues;
}
