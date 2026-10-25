/** Generate once for review; CI compares exact identities and resolved source sites. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { structuredCommunicationDispatchSitesV2, structuredCommunicationControlSitesV2 } from "../../packages/spec/src/structuredCommunicationSites.js";
import { canonicalJson, providerWireContracts, structuredCommunicationManifestV2, validateStructuredCommunicationManifestV2 } from "../../packages/spec/src/index.js";
import { assertStructuredCommunicationInventory, collectStructuredCommunicationCallsites, structuredCommunicationSources, SOURCE_ROOTS } from "./structured-communication-inventory.mts";

const ROOT = resolve(import.meta.dirname, "../..");
const baselinePath = resolve(ROOT, "scripts/comms/registry-baseline.v2.json");
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export function generateRegistryBaselineV2() {
  validateStructuredCommunicationManifestV2();
  const inventory = collectStructuredCommunicationCallsites();
  assertStructuredCommunicationInventory(inventory);
  const sites = inventory.map(({ line, column, ...site }) => site);
  const owners = (operation: string) => operation === "qa-verdict" ? ["generic", "qa-review"]
    : operation === "builder-remediation" ? ["generic", "qa-remediation"] : ["generic"];
  const descriptors = providerWireContracts().map(contract => ({ operation: contract.canonical.operation,
    schemaVersion: contract.canonical.schemaVersion, schemaDigest: contract.canonical.schemaDigest,
    provider: contract.provider, profile: contract.profile, variant: contract.variant,
    descriptorDigest: contract.descriptorDigest })).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const generatedSites = Object.fromEntries([...structuredCommunicationManifestV2.operations, ...structuredCommunicationManifestV2.subordinateOperations].map(operation =>
    [operation.operation, [...new Set(sites.filter(site => site.operations?.includes(operation.operation) && !site.file.startsWith("packages/spec/"))
      .map(site => `${site.file}#${site.owner ?? "<module>"}`))].sort()]));
  const generatedControlSites = Object.fromEntries(structuredCommunicationManifestV2.controlOperations.map(control => {
    const key = `${control.provider}/${control.command}`;
    return [key, [...new Set(sites.filter(site => site.control?.provider === control.provider && site.control.command === control.command)
      .map(site => `${site.file}#${site.owner ?? "<module>"}`))].sort()];
  }));
  const operations = [...structuredCommunicationManifestV2.operations, ...structuredCommunicationManifestV2.subordinateOperations]
    .map(operation => ({ operation: operation.operation,
      classification: operation.operation === "ticket-population-page" ? "subordinate" : "top-level",
      owner: operation.operation === "ticket-population-page" ? ["ticket-population"] : owners(operation.operation),
      descriptors: descriptors.filter(descriptor => descriptor.operation === operation.operation),
      sourceSites: sites.filter(site => site.operations?.includes(operation.operation)),
    })).sort((a, b) => a.operation.localeCompare(b.operation));
  const manifest = { ...structuredCommunicationManifestV2,
    controlOperations: structuredCommunicationManifestV2.controlOperations.map(control => ({ ...control, callSites: generatedControlSites[`${control.provider}/${control.command}`] })),
    operations: structuredCommunicationManifestV2.operations.map(operation => ({ ...operation, dispatchSites: generatedSites[operation.operation] })),
    subordinateOperations: structuredCommunicationManifestV2.subordinateOperations.map(operation => ({ ...operation, dispatchSites: generatedSites[operation.operation] })) };
  return { version: 2, generatedFrom: SOURCE_ROOTS, manifestDigest: digest(manifest), generatedSites, generatedControlSites,
    descriptorDigest: digest(descriptors), operations, authoritySites: sites,
    // New/unrecognized authority cannot hide in a file omitted by the resolved-site projection.
    productionSourceDigests: Object.fromEntries(structuredCommunicationSources()
      .filter(file => file !== resolve(ROOT, "packages/spec/src/structuredCommunicationSites.ts"))
      .map(file => [file.slice(ROOT.length + 1), createHash("sha256").update(readFileSync(file)).digest("hex")])),
    authoritySourceDigests: Object.fromEntries([...new Set(sites.flatMap(site => [site.file, ...(site.declaration && /^(packages|scripts)\//.test(site.declaration) ? [site.declaration] : [])]))].sort().map(file =>
      [file, createHash("sha256").update(readFileSync(resolve(ROOT, file))).digest("hex")])) };
}

/** One exact comparison used by CI and adversarial drift fixtures. */
export function assertReviewedRegistryBaseline(actual: unknown, reviewed: unknown): void {
  if (canonicalJson(reviewed) !== canonicalJson(actual)) throw new Error("Structured authority/registry baseline drift; review changed identities, owners and source sites before regenerating");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const baseline = generateRegistryBaselineV2();
  if (process.argv.includes("--write")) {
    writeFileSync(resolve(ROOT, "packages/spec/src/structuredCommunicationSites.ts"),
      "/** Generated by scripts/comms/registry-baseline.mts; compare against compiler inventory in CI. */\n" +
      "export const structuredCommunicationDispatchSitesV2: Readonly<Record<string, readonly string[]>> = Object.freeze(" + JSON.stringify(baseline.generatedSites, null, 2) + ");\n" +
      "export const structuredCommunicationControlSitesV2: Readonly<Record<string, readonly string[]>> = Object.freeze(" + JSON.stringify(baseline.generatedControlSites, null, 2) + ");\n");
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`Generated ${baseline.operations.length} operations for review: ${baselinePath}`);
  } else {
    if (canonicalJson(structuredCommunicationDispatchSitesV2) !== canonicalJson(baseline.generatedSites)) throw new Error("Packaged manifest source-site projection drift");
    if (canonicalJson(structuredCommunicationControlSitesV2) !== canonicalJson(baseline.generatedControlSites)) throw new Error("Provider control source-site projection drift");
    const reviewed = JSON.parse(readFileSync(baselinePath, "utf8"));
    assertReviewedRegistryBaseline(baseline, reviewed);
    console.log(`Structured authority baseline matches: 26/52 + 1/2; ${baseline.authoritySites.length} resolved sites`);
  }
}
