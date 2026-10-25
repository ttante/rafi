import type { QaContractCoverageV1, QaVerificationContractV1 } from "rafi-spec";
import { applyHostQaAugmentations } from "./hostQaAugmentation.js";
import type { HostQaComparisonV1 } from "./hostQaComparison.js";
import type { HostGraphApplicabilityV1 } from "./hostGraphApplicability.js";

/**
 * Assemble the durable final QA coverage in one order for both finalization
 * and certificate validation. The provider-owned rows remain the input; all
 * host-owned authority is applied here and is never reconstructed implicitly.
 */
export function assembleFinalQaCoverage(input: {
  providerCoverage: QaContractCoverageV1;
  contract: QaVerificationContractV1;
  projectDir: string;
  commandObservations?: unknown[];
  hostComparison?: { result: HostQaComparisonV1; resultDigest: string };
  hostGraph?: { result: HostGraphApplicabilityV1; resultDigest: string };
}): QaContractCoverageV1 {
  return applyHostQaAugmentations({
    coverage: input.providerCoverage,
    contract: input.contract,
    projectDir: input.projectDir,
    commandObservations: input.commandObservations,
    hostComparison: input.hostComparison,
    hostGraph: input.hostGraph,
  });
}
