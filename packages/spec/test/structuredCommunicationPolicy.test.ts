import assert from "node:assert/strict";
import { test } from "node:test";
import { structuredCommunicationManifestV2, validateStructuredCommunicationManifestV2 } from "../src/structuredCommunicationManifest.js";
import { assertIntermediateResultV2, assertLiveStructuredValidationConfigured, assertStructuredIntermediateRequestAllowed, providerControlOperationV2, providerControlOperationsV2, resolveLiveStructuredValidationConfigurationV2, structuredCommunicationPolicyV2, validateTicketPagingLimitsV2 } from "../src/structuredCommunicationPolicy.js";

test("structured communication v2 locks paging and intermediate-request decisions", () => {
  assert.deepEqual(structuredCommunicationPolicyV2.ticketPaging, {
    maximumPagesPerArtifact: 60,
    maximumTicketsPerPage: 150,
    maximumCanonicalPageBytes: 750 * 1024,
    maximumCanonicalAggregateBytes: 6 * 1024 * 1024,
  });
  assert.deepEqual(structuredCommunicationPolicyV2.intermediateRequestExceptions, [
    "graph-request", "source-request", "evidence-request", "handoff-request",
  ]);
  assert.equal(structuredCommunicationPolicyV2.liveValidation.maximumSpendUsd, null);
  assert.equal(structuredCommunicationPolicyV2.liveValidation.requireAuthoritativeCost, false);
  assert.equal(structuredCommunicationPolicyV2.liveValidation.strictMaximumSpendUsd, 5);
  assert.equal(structuredCommunicationPolicyV2.liveValidation.maximumElapsedMs, 30 * 60 * 1000);
  assert.equal(structuredCommunicationManifestV2.intermediateRequestExceptions, structuredCommunicationPolicyV2.intermediateRequestExceptions);
});

test("live structured validation fails closed until credentials and log retention are configured", () => {
  assert.throws(() => assertLiveStructuredValidationConfigured(), /not configured/);
  assert.doesNotThrow(() => assertLiveStructuredValidationConfigured({
    ...structuredCommunicationPolicyV2,
    liveValidation: { ...structuredCommunicationPolicyV2.liveValidation, credentialScope: "release-provider-credentials", retainedLogDirectory: "release-evidence/structured-comms-v2" },
  }));
  assert.deepEqual(resolveLiveStructuredValidationConfigurationV2({ credentialScope: " release-provider-credentials ", retainedLogDirectory: " release-evidence/structured-comms-v2 " }), {
    credentialScope: "release-provider-credentials", retainedLogDirectory: "release-evidence/structured-comms-v2",
  });
  assert.throws(() => resolveLiveStructuredValidationConfigurationV2({ credentialScope: "", retainedLogDirectory: "evidence" }), /requires an explicit/);
});

test("ticket limits and intermediate requests have no implicit extension path", () => {
  assert.deepEqual(validateTicketPagingLimitsV2(structuredCommunicationPolicyV2.ticketPaging), structuredCommunicationPolicyV2.ticketPaging);
  assert.throws(() => validateTicketPagingLimitsV2({ ...structuredCommunicationPolicyV2.ticketPaging, maximumCanonicalAggregateBytes: 1 }), /aggregate/);
  for (const kind of structuredCommunicationPolicyV2.intermediateRequestExceptions) assert.doesNotThrow(() => assertStructuredIntermediateRequestAllowed(kind));
  assert.throws(() => assertStructuredIntermediateRequestAllowed("unreviewed-request"), /Unapproved/);
  assert.doesNotThrow(() => assertStructuredIntermediateRequestAllowed("completed"));
});

test("intermediate results use the closed v2 kind set and typed evidence requests", () => {
  for (const value of [
    { kind: "graph-request" }, { kind: "source-request" }, { kind: "handoff-request" },
    { kind: "evidence-request", evidenceType: "run" }, { kind: "evidence-request", evidenceType: "qa" },
    { kind: "evidence-request", evidenceType: "graph" },
  ]) assert.doesNotThrow(() => assertIntermediateResultV2(value));
  assert.throws(() => assertIntermediateResultV2({ kind: "evidence-request" }), /evidenceType/);
  assert.throws(() => assertIntermediateResultV2({ kind: "qa-evidence-request" }), /Unapproved/);
  assert.throws(() => assertIntermediateResultV2({ kind: "graph-request", result: { kind: "completed" } }), /terminal envelope/);
});

test("provider controls are an allowlisted non-authoritative surface", () => {
  const context = providerControlOperationV2("claude", "/context");
  assert.equal(context.workflowAuthority, false);
  assert.equal(context.completion, "zero-model-turn");
  assert.equal(providerControlOperationsV2().every(control => control.workflowAuthority === false), true);
  assert.throws(() => providerControlOperationV2("claude", "/arbitrary"), /Unregistered/);
});

test("CLI planning and grill operations are owned by the spec inventory", () => {
  for (const operation of ["ticket-plan", "grill-audit"]) {
    const entry = structuredCommunicationManifestV2.operations.find(candidate => candidate.operation === operation);
    assert.ok(entry, `${operation} must be present in the static manifest`);
    assert.deepEqual(entry.providers.map(provider => provider.provider).sort(), ["claude", "codex"]);
  }
});

test("the spec inventory has the locked 26 operations, 52 top-level descriptors, and page operation", () => {
  assert.equal(structuredCommunicationManifestV2.operations.length, 26);
  assert.equal(structuredCommunicationManifestV2.operations.reduce((count, operation) => count + operation.providers.length, 0), 52);
  assert.deepEqual(structuredCommunicationManifestV2.subordinateOperations.map(operation => operation.operation), ["ticket-population-page"]);
  assert.equal(structuredCommunicationManifestV2.subordinateOperations[0]?.providers.length, 2);
  for (const operation of ["qa-preparation-draft", "qa-preparation-assessment", "qa-preparation-challenge", "qa-preparation-depth"]) {
    assert.equal(structuredCommunicationManifestV2.operations.some(entry => entry.operation === operation), true);
  }
  assert.doesNotThrow(validateStructuredCommunicationManifestV2);
});

test("manager evidence requests use the canonical kind and reject aliases", async () => {
  const { managerOutput } = await import("../src/managerOutputContract.js");
  const value = { version: 1, operation: "manager", continuity: null, result: {
    kind: "evidence-request", evidenceType: "run", request: { version: 1, requestId: "request", operations: [{ kind: "list_runs" }] },
  } };
  assert.equal(managerOutput.schema.safeParse(value).success, true);
  assert.equal(managerOutput.schema.safeParse({ ...value, result: { ...value.result, kind: "run-evidence-request" } }).success, false);
  assert.equal(managerOutput.schema.safeParse({ ...value, result: { ...value.result, evidenceType: "qa" } }).success, false);
});
