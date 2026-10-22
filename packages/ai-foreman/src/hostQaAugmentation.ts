import type { QaContractCoverageV1, QaVerificationContractV1 } from "rafi-spec";
import { applyHostQaComparison, type HostQaComparisonV1 } from "./hostQaComparison.js";
import { applyHostGraphApplicability, type HostGraphApplicabilityV1 } from "./hostGraphApplicability.js";

type HostCommandObservation = { spanId?: string; kind?: string; outcome?: string; exitCode?: number };

function commandObservationFor(check: QaVerificationContractV1["checks"][number], observations: HostCommandObservation[]): HostCommandObservation | undefined {
  const command = check.verification.find(method => method.kind === "command");
  const argv = command?.argv ?? [];
  const kind = argv[0] === "npm" && argv[1] === "test" ? "npm-test" : argv[0] === "node" && argv[1] === "--test" ? "node-test" : undefined;
  if (!kind) return undefined;
  return observations.find(observation => observation.kind === kind && observation.outcome === "completed" && observation.exitCode === 0 && typeof observation.spanId === "string");
}

function applyHostCommandObservations(coverage: QaContractCoverageV1, contract: QaVerificationContractV1, observations: unknown[]): QaContractCoverageV1 {
  const parsed = observations.filter((observation): observation is HostCommandObservation => Boolean(observation && typeof observation === "object"));
  const copy = structuredClone(coverage);
  for (const check of contract.checks) {
    const observation = commandObservationFor(check, parsed);
    if (!observation) continue;
    const row = copy.checks.find(item => item.checkId === check.id);
    if (!row || row.outcome === "failed") continue;
    row.outcome = "passed";
    row.evidence = [...(row.evidence ?? []), {
      procedure: "Rafi host-retained command observation",
      cwd: ".",
      runtime: "Rafi host",
      sourceDigest: copy.sourceDigest,
      reference: `host-command-span:${observation.spanId}`,
    }];
  }
  return copy;
}

function applyBaselineAuthorities(coverage: QaContractCoverageV1, contract: QaVerificationContractV1): QaContractCoverageV1 {
  const copy = structuredClone(coverage);
  for (const check of contract.checks) {
    if (check.timing !== "preimplementation") continue;
    const baseline = contract.baseline.find(observation => observation.checkId === check.id && observation.status === "passed");
    const row = copy.checks.find(item => item.checkId === check.id);
    if (!baseline || !row || row.applicability !== "applicable" || row.outcome !== "passed") continue;
    if (row.evidence?.some(evidence => evidence.reference === baseline.evidenceDigest)) continue;
    row.evidence = [...(row.evidence ?? []), {
      procedure: "Rafi host-retained preimplementation baseline authority",
      cwd: ".",
      runtime: "Rafi host",
      sourceDigest: copy.sourceDigest,
      reference: baseline.evidenceDigest,
    }];
  }
  return copy;
}

/** Applies every host-owned coverage decision in one canonical order. */
export function applyHostQaAugmentations(input: {
  coverage: QaContractCoverageV1;
  contract: QaVerificationContractV1;
  projectDir: string;
  hostComparison?: { result: HostQaComparisonV1; resultDigest: string };
  hostGraph?: { result: HostGraphApplicabilityV1; resultDigest: string };
  commandObservations?: unknown[];
}): QaContractCoverageV1 {
  let coverage = input.coverage;
  coverage = applyBaselineAuthorities(coverage, input.contract);
  if (input.commandObservations?.length) coverage = applyHostCommandObservations(coverage, input.contract, input.commandObservations);
  if (input.hostComparison) coverage = applyHostQaComparison(coverage, input.contract, input.hostComparison.result, input.hostComparison.resultDigest, input.projectDir);
  if (input.hostGraph) coverage = applyHostGraphApplicability(coverage, input.contract, input.hostGraph.result, input.hostGraph.resultDigest, input.projectDir);
  return coverage;
}
