/**
 * The sole declaration point for production provider-wire descriptors.
 * Contract modules may describe schemas, but they cannot mutate this table.
 */
import { managerProviderWireContracts } from "./managerOutputContract.js";
import { operationProviderWireContracts, retiredTicketPopulationPageProviderWireContracts, ticketPopulationPageProviderWireContracts } from "./operationContracts.js";
import { qaProviderWireContracts } from "./qaOutputContracts.js";
import { createProviderWireContract, installStaticProviderWireContracts, type ProviderWireContract } from "./structuredOutput.js";

export const activeProviderWireContractsV2: readonly ProviderWireContract[] = Object.freeze([
  ...operationProviderWireContracts(),
  ...qaProviderWireContracts(),
  ...managerProviderWireContracts(),
  ...ticketPopulationPageProviderWireContracts(),
]);

/**
 * Retained shipped descriptors are deliberately declared next to active ones.
 * They are replay-only: active selection never consults this list.  Keeping a
 * concrete retired pair in the registry exercises the real historic path and
 * prevents a future refactor from assuming one descriptor per active key.
 */
const retiredTicketPopulationDescriptors = activeProviderWireContractsV2
  .filter(contract => contract.canonical.operation === "ticket-population")
  .map(contract => createProviderWireContract({
    canonical: contract.canonical,
    provider: contract.provider,
    profile: `${contract.provider}-ticket-population-v1-retired`,
    variant: contract.variant,
    wireVersion: 1,
    wireSchema: contract.wireSchema,
    maximumSchemaBytes: contract.maximumSchemaBytes,
    maximumResponseBytes: contract.maximumResponseBytes,
    ...(contract.maximumPageBytes === undefined ? {} : { maximumPageBytes: contract.maximumPageBytes }),
    normalizerId: contract.normalizerId,
    normalizerVersion: contract.normalizerVersion,
    normalize: contract.normalize,
    guidanceId: `${contract.provider}-ticket-population-v1-retired`,
    guidance: "Return the selected native JSON value only.",
  }));

export const historicProviderWireContractsV2: readonly ProviderWireContract[] = Object.freeze([
  ...activeProviderWireContractsV2,
  ...retiredTicketPopulationDescriptors,
  ...retiredTicketPopulationPageProviderWireContracts(),
]);

installStaticProviderWireContracts({ active: activeProviderWireContractsV2, historic: historicProviderWireContractsV2 });
