import { branchAuditOutput, discoveryOutput, grillAuditOutput, guidedRecoveryOutput, plannerRemediationOutput, riskNoteRepairOutput, semanticExtractionOutput, structuredPlanOutput, ticketPlanOutput, ticketPopulationOutput, ticketPopulationPageOutput, uninstallProposalOutput } from "./operationContracts.js";
import { builderCoverageOutput, contractAcceptanceOutput, contractSegmentOutput, handoffAcceptanceOutput, initializationOutput, preflightOutput, qaRecoveryOutput, qaVerdictOutput, remediationOutput, workReportOutput } from "./qaOutputContracts.js";
import { managerOutput } from "./managerOutputContract.js";
import { assessmentOutput, challengeOutput, depthOutput, draftOutput } from "./qaPreparationOutputContracts.js";
import { providerControlOperationsV2, structuredCommunicationPolicyV2 } from "./structuredCommunicationPolicy.js";
import { structuredCommunicationBaselineV2 } from "./structuredCommunicationBaseline.js";
import { providerWireContract, providerWireContracts, type OutputContract } from "./structuredOutput.js";
import "./providerWireRegistry.js";
import { structuredCommunicationDispatchSitesV2 } from "./structuredCommunicationSites.js";

const contracts = [
  ticketPopulationOutput, structuredPlanOutput, riskNoteRepairOutput, semanticExtractionOutput, plannerRemediationOutput,
  discoveryOutput, guidedRecoveryOutput, branchAuditOutput, uninstallProposalOutput,
  ticketPlanOutput, grillAuditOutput,
  builderCoverageOutput, workReportOutput, preflightOutput, initializationOutput, qaRecoveryOutput, remediationOutput,
  qaVerdictOutput, contractAcceptanceOutput, contractSegmentOutput, handoffAcceptanceOutput, managerOutput,
  draftOutput, assessmentOutput, challengeOutput, depthOutput,
] as readonly OutputContract<any>[];

/**
 * Machine-readable inventory for CI.  Control commands are deliberately
 * listed separately: they are adapter controls, never unregistered structured
 * provider operations.
 */
export const structuredCommunicationManifestV2 = Object.freeze({
  protocolVersion: 2,
  operations: contracts.map(contract => Object.freeze({
    operation: contract.operation, schemaVersion: contract.schemaVersion, schemaDigest: contract.schemaDigest,
    owners: contract.operation === "qa-verdict" ? ["generic", "qa-review"] : contract.operation === "builder-remediation" ? ["generic", "qa-remediation"] : ["generic"],
    dispatchSites: structuredCommunicationDispatchSitesV2[contract.operation] ?? [],
    intermediateKinds: structuredCommunicationPolicyV2.intermediateRequestExceptions,
    parserState: "native-only" as const,
    providers: (["claude", "codex"] as const).map(provider => {
      const descriptor = providerWireContract(contract, provider);
      return Object.freeze({ provider, profile: descriptor.profile, variant: descriptor.variant, descriptorDigest: descriptor.descriptorDigest,
        guidanceDigest: descriptor.guidanceDigest, guidanceId: descriptor.guidanceId, rendererIdentity: "renderProviderWireInstruction-v2",
        wireSchemaDigest: descriptor.wireSchemaDigest, normalizerId: descriptor.normalizerId, normalizerVersion: descriptor.normalizerVersion,
        maximumSchemaBytes: descriptor.maximumSchemaBytes,
        maximumResponseBytes: descriptor.maximumResponseBytes, maximumPageBytes: descriptor.maximumPageBytes ?? null });
    }),
  })),
  subordinateOperations: [ticketPopulationPageOutput].map(contract => Object.freeze({
    operation: contract.operation, owner: "ticket-population", dispatchSites: structuredCommunicationDispatchSitesV2[contract.operation] ?? [], schemaVersion: contract.schemaVersion, schemaDigest: contract.schemaDigest,
    providers: (["claude", "codex"] as const).map(provider => {
      const descriptor = providerWireContract(contract, provider);
      return Object.freeze({ provider, profile: descriptor.profile, variant: descriptor.variant, descriptorDigest: descriptor.descriptorDigest,
        guidanceDigest: descriptor.guidanceDigest, guidanceId: descriptor.guidanceId, rendererIdentity: "renderProviderWireInstruction-v2",
        wireSchemaDigest: descriptor.wireSchemaDigest, normalizerId: descriptor.normalizerId, normalizerVersion: descriptor.normalizerVersion,
        maximumSchemaBytes: descriptor.maximumSchemaBytes, maximumResponseBytes: descriptor.maximumResponseBytes, maximumPageBytes: descriptor.maximumPageBytes ?? null });
    }),
  })),
  durableDispatchOwners: ["generic", "qa-review", "qa-remediation"],
  directDispatchSites: ["structuredOperation.journalStructuredDispatch", "qaReview.dispatchQaTurn", "qaFailureDelivery.deliver"],
  controlOperations: providerControlOperationsV2(),
  intermediateRequestExceptions: structuredCommunicationPolicyV2.intermediateRequestExceptions,
  parserStatus: "legacy-provider-text-rejected",
  ipcFamilies: ["provider-receipt", "qa-turn", "ticket-population-page"],
});

export function validateStructuredCommunicationManifestV2(): void {
  const operations = new Set<string>();
  for (const entry of structuredCommunicationManifestV2.operations) {
    if (operations.has(entry.operation)) throw new Error(`Duplicate structured operation in manifest: ${entry.operation}`);
    operations.add(entry.operation);
    if (entry.providers.length !== 2 || new Set(entry.providers.map(provider => provider.provider)).size !== 2) throw new Error(`Missing provider descriptor for ${entry.operation}`);
    for (const provider of entry.providers) {
      if (provider.profile.includes("compat") || provider.guidanceDigest.length !== 64 || provider.maximumResponseBytes < 1) throw new Error(`Invalid v2 descriptor manifest entry for ${entry.operation}/${provider.provider}`);
    }
  }
  const baselineOperations = new Set<string>(structuredCommunicationBaselineV2.operations);
  if (operations.size !== 26 || operations.size !== baselineOperations.size || [...operations].some(operation => !baselineOperations.has(operation))) {
    throw new Error(`Structured communication v2 operation identity baseline mismatch: ${[...operations].sort().join(",")}`);
  }
  if (structuredCommunicationManifestV2.subordinateOperations.length !== 1 || structuredCommunicationManifestV2.subordinateOperations[0]?.operation !== "ticket-population-page" || structuredCommunicationManifestV2.subordinateOperations[0]?.providers.length !== 2) {
    throw new Error("Ticket population page descriptor manifest is invalid");
  }
  const subordinate = structuredCommunicationManifestV2.subordinateOperations[0]!;
  if (subordinate.operation !== structuredCommunicationBaselineV2.subordinate.operation || subordinate.owner !== structuredCommunicationBaselineV2.subordinate.owner ||
    subordinate.providers.some(provider => !structuredCommunicationBaselineV2.subordinate.providers.includes(provider.provider))) {
    throw new Error("Ticket population page identity baseline mismatch");
  }
  if (structuredCommunicationManifestV2.durableDispatchOwners.join(",") !== structuredCommunicationBaselineV2.durableDispatchOwners.join(",") ||
    structuredCommunicationManifestV2.directDispatchSites.join(",") !== structuredCommunicationBaselineV2.directDispatchSites.join(",")) {
    throw new Error("Structured communication ownership/site baseline mismatch");
  }
  if (providerWireContracts().length !== 54 || providerWireContracts().length !== operations.size * 2 + 2) throw new Error("Provider descriptor registry and manifest disagree");
}
