import { Ajv } from "ajv";
import { qaContractCoverageV1Schema } from "rafi-spec";
const coverageSchema = new Ajv({ allErrors: true }).compile(qaContractCoverageV1Schema);
import type { QaContractCoverageV1, QaVerificationContractV1 } from "rafi-spec";
import { parsePreparationArtifact } from "./qaVerificationContract.js";

export const COVERAGE_INSTRUCTIONS = `Return RAFI_QA_COVERAGE_START, one QaContractCoverageV1 JSON object, RAFI_QA_COVERAGE_END before the final status marker. The exact schema is ${JSON.stringify(qaContractCoverageV1Schema)}. Put every binding field at the TOP LEVEL, not inside a binding object, and copy the host-supplied binding values exactly. For each check use checkId (not id), applicability as applicable/not-applicable/unresolved, predicateEvidence as an array of strings, outcome as passed/failed/blocked/not-run, and evidence as an array of objects with procedure, cwd, runtime, sourceDigest and reference. For postimplementation evidence sourceDigest is the exact host-supplied sourceDigest, not an individual file hash. Unconditional checks cannot be marked not-applicable or unresolved; for an absence or non-impact check, mark it applicable and provide bounded inspection evidence showing that the absent change or impact was assessed. For independent QA coverage of an applicable passed preimplementation-only check, inspect its matching passed contract.baseline observation and set at least one evidence reference to that observation's exact evidenceDigest; the historical observation is bound to its original source, not the current source. Assess its relevance rather than inventing or claiming a new baseline. Host-owned checks whose applicability decisionOwner is host are the exception to provider execution: include the check truthfully as applicable/not-run with evidence that the host-owned comparison is pending, and do not block or fail QA over it; Rafi will execute the comparison and replace that row before accepting the pass. Before emitting qa_pass, run every other applicable mandatory check that is not backed by a passed retained baseline; do not leave such a provider-owned check as not-run merely because an earlier turn omitted it. If an exact required command is blocked by the provider shell policy, use a semantically equivalent permitted read-only procedure, record the substitution and limitation truthfully, and assess the same predicate; do not mark the check blocked merely because the literal command syntax was denied. If a required command is permitted and read-only, run it now and retain its bounded result. Do not add unsupported fields. Include every check with truthful applicability and concrete evidence. Missing, blocked, not-run, unresolved applicability, or failed provider-owned mandatory coverage cannot authorize normal completion. Builder coverage is a claim; final QA independently verifies it.`;

// The source and attempt binding do not exist until the implementation turn has finished.
export const BUILDER_WORK_COVERAGE_INSTRUCTIONS = `Carry out the applicable contract checks and report your work and evidence honestly in your normal final response. When a check requires historical ordering, retain bounded output for each required step and an explicit ordering record while performing it; a later passing test cannot prove an earlier failing step. Do not emit RAFI_QA_COVERAGE JSON during this implementation turn or stop for coverage binding values. After the implementation turn, Rafi will capture the completed source and request a separate response-only coverage record with the exact host-owned bindings.`;
export function parseContractCoverage(text: string): QaContractCoverageV1 { return parsePreparationArtifact(text, "RAFI_QA_COVERAGE"); }
/** Source identity is host-owned; providers may copy a stale Builder digest. */
export function bindCoverageSourceDigest(coverage: QaContractCoverageV1, sourceDigest: string): QaContractCoverageV1 {
  const copy = structuredClone(coverage);
  for (const check of copy.checks ?? []) for (const evidence of check.evidence ?? []) evidence.sourceDigest = sourceDigest;
  return copy;
}
/** All coverage identity fields are host-owned; provider output supplies only claims and evidence text. */
export function bindCoverageHostFields(coverage: QaContractCoverageV1, contract: QaVerificationContractV1, binding: { phase: "builder" | "qa"; sourceDigest: string; inputBasisDigest: string; attemptId: string; sessionId: string }): QaContractCoverageV1 {
  const copy = bindCoverageSourceDigest(coverage, binding.sourceDigest);
  // Optional schema fields may be emitted as JSON null by providers. Null is
  // not a meaningful limitation, so omit only that representation variant;
  // non-string values elsewhere remain validation errors.
  for (const check of copy.checks ?? []) for (const evidence of check.evidence ?? []) if ((evidence as unknown as { limitation?: unknown }).limitation === null) delete (evidence as unknown as { limitation?: unknown }).limitation;
  copy.version = 1; copy.runId = contract.runId; copy.workId = contract.workId; copy.revision = contract.revision;
  copy.contractDigest = contract.contentDigest; copy.phase = binding.phase; copy.sourceDigest = binding.sourceDigest;
  copy.inputBasisDigest = binding.inputBasisDigest; copy.attemptId = binding.attemptId; copy.sessionId = binding.sessionId;
  return copy;
}
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
    if (requirePass && check.obligation === "mandatory" && (row.applicability === "unresolved" || row.applicability === "applicable" && row.outcome !== "passed")) issues.push(`Mandatory check incomplete ${row.checkId}: run its permitted verification now and resubmit passed evidence, or report a truthful blocked result for host recovery`);
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
