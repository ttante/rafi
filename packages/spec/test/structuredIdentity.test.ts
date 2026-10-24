import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderWireContract, persistedProviderWireContract, parseSelectedDispatchTupleV2, historicProviderWireContract, jsonOutputContract, providerWireContract, selectedDispatchTupleV2, validateStructuredCandidate } from "../src/structuredOutput.js";
import { historicProviderWireContractsV2 } from "../src/providerWireRegistry.js";

test("selected contract snapshots caller schema and prevents mutation of provider projections", () => {
  const input = { type: "object", additionalProperties: false, required: ["status"], properties: { status: { enum: ["done"] } } };
  const contract = jsonOutputContract("identity-test", input);
  const descriptor = createProviderWireContract({
    canonical: contract, provider: "claude", profile: "claude-identity-test-v2", variant: "default", wireVersion: 2,
    wireSchema: contract.jsonSchema, maximumSchemaBytes: 10_000, maximumResponseBytes: 10_000,
    normalizerId: "identity", normalizerVersion: 1, normalize: value => value,
    guidanceId: "claude-identity-test-v2", guidance: "Return the selected native JSON value only.",
  });
  const original = contract.schemaDigest;
  input.properties.status.enum.push("unverified");
  assert.equal(contract.schemaDigest, original);
  assert.equal(contract.schema.safeParse({ status: "unverified" }).success, false);
  assert.throws(() => ((descriptor.wireSchema.properties as any).status.enum as string[]).push("unverified"), TypeError);
  assert.throws(() => { contract.schemaDigest = "different"; }, TypeError);
});

test("native JSON contract diagnostics identify misplaced fields without suggesting another union branch", async () => {
  const { workReportOutput } = await import("../src/qaOutputContracts.js");
  const value = { version: 1, operation: "work-report", result: { kind: "completed", summary: "Done", payload: { disposition: "modified", evidence: ["Observed"], coverage: null, graphMaintenance: null }, continuity: null } };
  const invalid = workReportOutput.schema.safeParse(value);
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    assert.ok(invalid.error.issues.some(issue => issue.path.length === 0 && issue.message.includes("'continuity'")));
    assert.ok(invalid.error.issues.some(issue => issue.path.join(".") === "result" && issue.message.includes('"continuity"')));
    assert.doesNotMatch(invalid.error.message, /required property '(question|reason|request)'/);
    assert.ok(invalid.error.issues.length <= 10);
  }
  const { continuity, ...result } = value.result;
  assert.equal(workReportOutput.schema.safeParse({ ...value, result, continuity }).success, true);
  assert.equal(value.result.continuity, null, "validation must not repair the provider object");
});

test("static registry rejects synthetic descriptors while direct validation preserves immutable identity", () => {
  const contract = jsonOutputContract("descriptor-test", { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } });
  const descriptor = createProviderWireContract({
    canonical: contract, provider: "claude", profile: "claude-descriptor-test-v1", variant: "default", wireVersion: 1,
    wireSchema: contract.jsonSchema, maximumSchemaBytes: 10_000, maximumResponseBytes: 64,
    normalizerId: "identity", normalizerVersion: 1, normalize: value => value,
    guidanceId: "descriptor-test-guidance", guidance: () => "Return value only.",
  });
  assert.throws(() => providerWireContract(contract, "claude"), /registry is unavailable|No selected/);
  const tuple = selectedDispatchTupleV2({
    operation: contract.operation, schemaVersion: contract.schemaVersion, schemaDigest: contract.schemaDigest,
    provider: "claude", profile: descriptor.profile, variant: descriptor.variant, descriptorDigest: descriptor.descriptorDigest,
    wireSchemaDigest: descriptor.wireSchemaDigest, guidanceDigest: descriptor.guidanceDigest,
    normalizerId: descriptor.normalizerId, normalizerVersion: descriptor.normalizerVersion,
    maximumSchemaBytes: descriptor.maximumSchemaBytes, maximumResponseBytes: descriptor.maximumResponseBytes,
    maximumPageBytes: null, instructionDigest: "a".repeat(64), actionId: "action", dispatchId: "dispatch", sessionId: "session", generation: 0,
  });
  assert.deepEqual(validateStructuredCandidate(contract, {
    state: "candidate", protocolVersion: 2, operation: contract.operation, schemaVersion: contract.schemaVersion,
    schemaDigest: contract.schemaDigest, wireSchemaDigest: descriptor.wireSchemaDigest, profile: descriptor.profile,
    wireContractDigest: descriptor.descriptorDigest, wireVariant: descriptor.variant, selectedDispatchDigest: tuple.digest,
    dispatchId: "dispatch", sessionId: "session", nativeTurnId: "turn", terminal: "completed",
    representation: "decoded-json", value: { value: "ok" },
  }, descriptor, tuple), { value: "ok" });
  assert.throws(() => createProviderWireContract({
    ...descriptor, wireSchema: { type: "object", properties: { huge: { type: "string", description: "x".repeat(20) } } }, maximumSchemaBytes: 10,
  }), /exceeds descriptor byte limit/);
});

test("v2 selection fails closed and guidance bytes are part of immutable dispatch provenance", () => {
  const contract = jsonOutputContract("fail-closed-test", { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } });
  assert.throws(() => providerWireContract(contract, "claude"), /registry is unavailable|No selected/);
  const one = createProviderWireContract({ canonical: contract, provider: "claude", profile: "claude-fail-closed-test-v2", variant: "default", wireVersion: 2,
    wireSchema: contract.jsonSchema, maximumSchemaBytes: 10_000, maximumResponseBytes: 10_000, normalizerId: "identity", normalizerVersion: 1,
    normalize: value => value, guidanceId: "fail-closed-test-claude-v2", guidance: "Return one result." });
  const two = createProviderWireContract({ ...one, guidance: "Return exactly one result." });
  assert.notEqual(one.guidanceDigest, two.guidanceDigest);
  assert.notEqual(one.descriptorDigest, two.descriptorDigest);
  const tuple = selectedDispatchTupleV2({ operation: contract.operation, schemaVersion: contract.schemaVersion, schemaDigest: contract.schemaDigest,
    provider: "claude", profile: one.profile, variant: one.variant, descriptorDigest: one.descriptorDigest, wireSchemaDigest: one.wireSchemaDigest,
    guidanceDigest: one.guidanceDigest, normalizerId: one.normalizerId, normalizerVersion: one.normalizerVersion,
    maximumSchemaBytes: one.maximumSchemaBytes, maximumResponseBytes: one.maximumResponseBytes, maximumPageBytes: null,
    instructionDigest: "a".repeat(64), actionId: "action", dispatchId: "dispatch", sessionId: "session", generation: 0 });
  assert.equal(tuple.protocolVersion, 2);
  assert.throws(() => { (tuple as any).dispatchId = "other"; }, TypeError);
});

test("historic replay resolves the recorded shipped descriptor while new work selects only active", async () => {
  const { ticketPopulationOutput } = await import("../src/operationContracts.js");
  const retired = historicProviderWireContractsV2.find(contract => contract.canonical.operation === "ticket-population" && contract.provider === "claude" && contract.profile.endsWith("-retired"));
  assert.ok(retired);
  const active = providerWireContract(ticketPopulationOutput, "claude");
  assert.notEqual(active.descriptorDigest, retired.descriptorDigest);
  assert.equal(historicProviderWireContract(ticketPopulationOutput, { provider: "claude", variant: "default", descriptorDigest: retired.descriptorDigest }).descriptorDigest, retired.descriptorDigest);
  assert.equal(providerWireContract(ticketPopulationOutput, "claude").descriptorDigest, active.descriptorDigest);
});

test("work completion has one outcome authority and rejects the retired duplicate status field", async () => {
  const { workReportOutput } = await import("../src/qaOutputContracts.js");
  const payload = { disposition: "modified", evidence: ["Observed test results"], coverage: null, graphMaintenance: null };
  const value = { version: 1, operation: "work-report", result: { kind: "completed", summary: "Work implemented", payload }, continuity: null };
  assert.equal(workReportOutput.schema.safeParse(value).success, true);
  assert.equal(workReportOutput.schema.safeParse({ ...value, result: { ...value.result, payload: { ...payload, status: "done" } } }).success, false);
  assert.equal(workReportOutput.schema.safeParse({ ...value, result: { ...value.result, kind: "unverified" } }).success, false);
});


test("pre-streaming page descriptor bytes remain available for exact historic replay", async () => {
  const { readFileSync } = await import("node:fs");
  const baseline = JSON.parse(readFileSync(new URL("../../../scripts/comms/registry-before-state.v2.json", import.meta.url), "utf8"));
  for (const before of baseline.descriptors.filter((entry: { operation: string }) => entry.operation === "ticket-population-page")) {
    const retired = historicProviderWireContractsV2.find(entry => entry.descriptorDigest === before.descriptorDigest);
    assert.ok(retired, `Missing historic ${before.provider} page descriptor ${before.descriptorDigest}`);
    const tuple = selectedDispatchTupleV2({ operation: retired.canonical.operation, schemaVersion: retired.canonical.schemaVersion,
      schemaDigest: retired.canonical.schemaDigest, provider: retired.provider, profile: retired.profile, variant: retired.variant,
      descriptorDigest: retired.descriptorDigest, wireSchemaDigest: retired.wireSchemaDigest, guidanceDigest: retired.guidanceDigest,
      normalizerId: retired.normalizerId, normalizerVersion: retired.normalizerVersion, maximumSchemaBytes: retired.maximumSchemaBytes,
      maximumResponseBytes: retired.maximumResponseBytes, maximumPageBytes: retired.maximumPageBytes ?? null,
      instructionDigest: "a".repeat(64), actionId: "historic", dispatchId: "historic", sessionId: "recorded", generation: 0 });
    assert.equal(persistedProviderWireContract(tuple), retired);
    assert.throws(() => parseSelectedDispatchTupleV2({ ...tuple, maximumResponseBytes: 0 }), /invalid fields/);
    assert.throws(() => parseSelectedDispatchTupleV2({ ...tuple, normalizerId: "" }), /invalid fields/);
  }
});
