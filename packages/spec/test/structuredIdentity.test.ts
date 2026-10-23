import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderWireContract, jsonOutputContract, providerOutputSchema, providerWireContract, registerProviderWireContract, validateStructuredCandidate } from "../src/structuredOutput.js";

test("selected contract snapshots caller schema and prevents mutation of provider projections", () => {
  const input = { type: "object", additionalProperties: false, required: ["status"], properties: { status: { enum: ["done"] } } };
  const contract = jsonOutputContract("identity-test", input);
  const original = contract.schemaDigest;
  input.properties.status.enum.push("unverified");
  assert.equal(contract.schemaDigest, original);
  assert.equal(contract.schema.safeParse({ status: "unverified" }).success, false);
  for (const provider of ["claude", "codex"] as const) {
    const projected = providerOutputSchema(contract, provider);
    assert.throws(() => ((projected.schema.properties as any).status.enum as string[]).push("unverified"), TypeError);
    assert.equal(providerOutputSchema(contract, provider).digest, projected.digest);
  }
  assert.throws(() => { contract.schemaDigest = "different"; }, TypeError);
  assert.throws(() => providerOutputSchema({ ...contract, jsonSchema: input }, "claude"), /changed after selection/);
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

test("registered wire descriptors are immutable, selected by provider, and enforce schema limits", () => {
  const contract = jsonOutputContract("descriptor-test", { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } });
  const descriptor = registerProviderWireContract(createProviderWireContract({
    canonical: contract, provider: "claude", profile: "claude-descriptor-test-v1", variant: "default", wireVersion: 1,
    wireSchema: contract.jsonSchema, maximumSchemaBytes: 10_000, maximumResponseBytes: 64,
    normalizerId: "identity", normalizerVersion: 1, normalize: value => value,
    guidanceId: "descriptor-test-guidance", guidance: () => "Return value only.",
  }));
  assert.equal(providerWireContract(contract, "claude").descriptorDigest, descriptor.descriptorDigest);
  assert.deepEqual(validateStructuredCandidate(contract, {
    state: "candidate", protocolVersion: 1, operation: contract.operation, schemaVersion: contract.schemaVersion,
    schemaDigest: contract.schemaDigest, wireSchemaDigest: descriptor.wireSchemaDigest, profile: descriptor.profile,
    wireContractDigest: descriptor.descriptorDigest, wireVariant: descriptor.variant,
    dispatchId: "dispatch", sessionId: "session", nativeTurnId: "turn", terminal: "completed",
    representation: "decoded-json", value: { value: "ok" },
  }), { value: "ok" });
  assert.throws(() => createProviderWireContract({
    ...descriptor, wireSchema: { type: "object", properties: { huge: { type: "string", description: "x".repeat(20) } } }, maximumSchemaBytes: 10,
  }), /exceeds descriptor byte limit/);
});

test("work completion has one outcome authority and rejects the retired duplicate status field", async () => {
  const { workReportOutput } = await import("../src/qaOutputContracts.js");
  const payload = { disposition: "modified", evidence: ["Observed test results"], coverage: null, graphMaintenance: null };
  const value = { version: 1, operation: "work-report", result: { kind: "completed", summary: "Work implemented", payload }, continuity: null };
  assert.equal(workReportOutput.schema.safeParse(value).success, true);
  assert.equal(workReportOutput.schema.safeParse({ ...value, result: { ...value.result, payload: { ...payload, status: "done" } } }).success, false);
  assert.equal(workReportOutput.schema.safeParse({ ...value, result: { ...value.result, kind: "unverified" } }).success, false);
});
