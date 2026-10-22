import { z } from "zod";
import type { QaContractCoverageV1, QaVerificationContractV1, QaContractCandidateV1 } from "rafi-spec";
import { loadGraphConfig } from "./graph/config.js";
import { contractDigest } from "./qaVerificationContract.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const hostGraphApplicabilityV1Schema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  ticketId: z.string().min(1),
  contractDigest: digest,
  contractRevision: z.number().int().positive(),
  reviewAttemptId: z.string().min(1),
  reviewBasisDigest: digest,
  sourceDigest: digest,
  status: z.enum(["adopted-enabled", "disabled", "unadopted", "unavailable"]),
  reason: z.string().max(2048),
  observedAt: z.string().datetime(),
});

export type HostGraphApplicabilityV1 = z.infer<typeof hostGraphApplicabilityV1Schema>;

function graphText(check: QaVerificationContractV1["checks"][number]): string {
  return [check.expectedBehavior, ...check.expectedEvidence, ...check.applicability.requiredEvidence,
    ...check.verification.flatMap(method => [method.expectedOutcome, ...(method.steps ?? []), ...(method.argv ?? [])])].join(" ");
}

export function isGraphQaCheck(check: QaVerificationContractV1["checks"][number]): boolean {
  return /\bgraphify(?:y)?\b|\brafi[- ]managed graph(?:ify)?\b|\bgraphify adoption\b|\bgraphify[- ](?:receipt|evidence|command)\b/i.test(graphText(check));
}

export function findGraphQaChecks(contract: QaVerificationContractV1): QaVerificationContractV1["checks"] {
  return contract.checks.filter(isGraphQaCheck);
}

export function normalizeGraphQaChecks(candidate: QaContractCandidateV1): QaContractCandidateV1 {
  const copy = structuredClone(candidate);
  for (const check of copy.checks) {
    if (!isGraphQaCheck(check as QaVerificationContractV1["checks"][number])) continue;
    check.origin = "invariant";
    check.obligation = "mandatory";
    check.timing = "postimplementation";
    check.applicability = {
      kind: "conditional",
      predicate: "Rafi-managed Graphify is adopted and enabled for this project",
      decisionOwner: "host",
      requiredEvidence: ["Host-owned Graphify applicability observation"],
    };
  }
  return copy;
}

export function createHostGraphApplicability(input: {
  projectDir: string;
  runId: string;
  ticketId: string;
  contract: QaVerificationContractV1;
  reviewAttemptId: string;
  reviewBasisDigest: string;
  sourceDigest: string;
  store: { artifacts(kind: string): Array<{ digest: string; value: unknown }>; putArtifact(kind: string, value: unknown): string };
}): { result: HostGraphApplicabilityV1; resultDigest: string } {
  let status: HostGraphApplicabilityV1["status"] = "unavailable";
  let reason = "Rafi-managed Graphify applicability could not be observed; Graphify is optional and direct source inspection remains authoritative.";
  try {
    const graph = loadGraphConfig(input.projectDir);
    status = graph.enabled ? "adopted-enabled" : graph.reason === "disabled" ? "disabled" : "unadopted";
    reason = graph.enabled
      ? "Rafi-managed Graphify is explicitly adopted and enabled."
      : `Rafi-managed Graphify is not required: ${graph.reason}.`;
  } catch (error) {
    reason = `Rafi-managed Graphify applicability is unavailable (${error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400)}); direct source inspection remains authoritative.`;
  }
  const result = hostGraphApplicabilityV1Schema.parse({ version: 1, runId: input.runId, ticketId: input.ticketId, contractDigest: input.contract.contentDigest, contractRevision: input.contract.revision, reviewAttemptId: input.reviewAttemptId, reviewBasisDigest: input.reviewBasisDigest, sourceDigest: input.sourceDigest, status, reason, observedAt: new Date().toISOString() });
  const existing = input.store.artifacts("host-graph-applicability").find(item => {
    const parsed = hostGraphApplicabilityV1Schema.safeParse(item.value);
    return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(result);
  });
  return { result, resultDigest: existing?.digest ?? input.store.putArtifact("host-graph-applicability", result) };
}

export function applyHostGraphApplicability(coverage: QaContractCoverageV1, contract: QaVerificationContractV1, result: HostGraphApplicabilityV1, resultDigest: string, projectDir: string): QaContractCoverageV1 {
  const parsed = hostGraphApplicabilityV1Schema.parse(result);
  if (parsed.contractDigest !== contract.contentDigest || parsed.contractRevision !== contract.revision || parsed.runId !== contract.runId || parsed.ticketId !== contract.workId || parsed.sourceDigest !== coverage.sourceDigest || parsed.reviewAttemptId !== coverage.attemptId || parsed.reviewBasisDigest !== coverage.inputBasisDigest) throw new Error("Host Graphify applicability is not bound to the current contract, review, or source");
  const checks = findGraphQaChecks(contract);
  if (!checks.length) return coverage;
  const copy = structuredClone(coverage);
  for (const check of checks) {
    const index = copy.checks.findIndex(row => row.checkId === check.id);
    if (parsed.status !== "adopted-enabled") {
      const row = {
        checkId: check.id,
        applicability: "not-applicable" as const,
        predicateEvidence: [`Host-owned Graphify applicability: ${parsed.status}. ${parsed.reason}`],
        outcome: "passed" as const,
        evidence: [{ procedure: "Rafi host-owned Graphify applicability observation", cwd: projectDir, runtime: "Rafi host", sourceDigest: parsed.sourceDigest, reference: `host-graph-applicability:${resultDigest}` }],
      };
      if (index < 0) copy.checks.push(row); else copy.checks[index] = row;
    } else if (index >= 0) {
      copy.checks[index]!.applicability = "applicable";
      copy.checks[index]!.predicateEvidence = [...new Set([...(copy.checks[index]!.predicateEvidence ?? []), "Host-owned Graphify applicability: adopted-enabled."])];
      copy.checks[index]!.evidence.push({ procedure: "Rafi host-owned Graphify applicability observation", cwd: projectDir, runtime: "Rafi host", sourceDigest: parsed.sourceDigest, reference: `host-graph-applicability:${resultDigest}` });
    }
  }
  return copy;
}

export function hostGraphApplicabilityDigestFromCoverage(coverage: QaContractCoverageV1, checkId: string): string | undefined {
  const reference = coverage.checks.find(row => row.checkId === checkId)?.evidence.find(item => item.reference.startsWith("host-graph-applicability:"))?.reference;
  const value = reference?.slice("host-graph-applicability:".length);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

