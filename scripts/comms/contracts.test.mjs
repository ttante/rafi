import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { contracts, decide, wireSchema, projectCodexSchema } from "./contracts.mjs";

const examples = {
  "work-report": { kind: "completed", summary: "Expiry check implemented", change: "modified", evidenceIds: ["test-output"] },
  "qa-verdict": { kind: "passed", summary: "Expiry behavior verified", evidenceIds: ["test-output"] },
  handoff: { kind: "received", resourceIds: ["checkpoint"], uncertainties: [] },
};
function fixture(operation = "work-report") {
  const request = { operation, schemaVersion: 1, actionId: "action", dispatchId: "dispatch", sessionId: "session",
    generation: 2, sourceDigest: "source", contractDigest: "contract", allowedOutcomes: Object.keys({
      completed: 1, passed: 1, failed: 1, blocked: 1, requested: 1, received: 1 }),
    allowedEvidenceIds: ["test-output"], requiredCheckIds: ["expiry"], requirementIds: ["reject-expired"], requiredResourceIds: ["checkpoint"] };
  const observation = { ...request, terminal: "completed", authorized: true, acceptedDispatchIds: [],
    evidence: [{ id: "test-output", sourceDigest: "source", available: true }],
    checks: [{ id: "expiry", outcome: "passed", sourceDigest: "source", contractDigest: "contract", evidenceIds: ["test-output"] }],
    independentReview: true, unresolvedBlockingFindings: 0, handoffResourcesValidated: true, successorLeaseEligible: true };
  const candidate = { version: 1, operation, result: structuredClone(examples[operation]), continuity: { summary: "Current work retained", uncertainties: [] } };
  return { request, observation, candidate };
}
function decision(f) { return decide(f.request, f.observation, f.candidate); }

for (const operation of Object.keys(contracts)) test(`${operation}: valid wire shape and host eligibility`, () => {
  const f = fixture(operation);
  const validate = new Ajv({ strict: false }).compile(wireSchema(operation));
  assert.equal(validate(f.candidate), true, JSON.stringify(validate.errors));
  assert.equal(decision(f).accepted, true);
  assert.equal(decision(f).next, { "work-report": "independent-qa", "qa-verdict": "eligible-for-atomic-certification", handoff: "eligible-for-atomic-lease-transfer" }[operation]);
});
for (const operation of Object.keys(contracts)) test(`${operation}: provider projection preserves positive and negative shapes`, () => {
  const ajv = new Ajv({ strict: false });
  const claude = ajv.compile(wireSchema(operation, "claude"));
  const codex = ajv.compile(wireSchema(operation, "codex"));
  const f = fixture(operation);
  const blocked = { ...f.candidate, result: { kind: "blocked", reason: "Missing fixture", nextAction: "Restore fixture", evidenceIds: [] } };
  for (const candidate of [f.candidate, blocked, { ...f.candidate, version: 2 }, { ...f.candidate, result: { ...f.candidate.result, kind: "invented" } },
    { ...blocked, result: { ...blocked.result, summary: "extra field" } }, { ...f.candidate, result: {} }]) {
    assert.equal(codex(candidate), claude(candidate), JSON.stringify(candidate));
  }
  assert.ok(!JSON.stringify(wireSchema(operation, "codex")).includes('"oneOf"'));
});
test("projection refuses overlapping alternatives instead of weakening their meaning", () => {
  const branch = { type: "object", properties: { kind: { const: "same" } }, required: ["kind"], additionalProperties: false };
  assert.throws(() => projectCodexSchema({ oneOf: [branch, branch] }), /Cannot project/);
});
for (const operation of Object.keys(contracts)) test(`${operation}: a valid blocker is recorded without completion`, () => {
  const f = fixture(operation); f.candidate.result = { kind: "blocked", reason: "Evidence unavailable", nextAction: "Restore fixture", evidenceIds: [] };
  f.observation.checks = [];
  assert.deepEqual(decision(f), { accepted: true, reason: "blocked", next: "record-blocker" });
});
test("already-satisfied work with current verification still proceeds to independent QA", () => {
  const f = fixture(); f.candidate.result.change = "already-satisfied";
  assert.equal(decision(f).next, "independent-qa");
});
test("QA rejection retains supported findings without asking for a format repair", () => {
  const f = fixture("qa-verdict"); f.candidate.result = { kind: "failed", summary: "Expired tokens accepted", evidenceIds: ["test-output"],
    findings: [{ requirementId: "reject-expired", problem: "Expired token returned 200", evidenceIds: ["test-output"], verification: "Expect 401 for expired token" }] };
  f.observation.checks[0].outcome = "failed";
  assert.equal(decision(f).next, "record-findings");
  f.candidate.result.findings[0].requirementId = "invented";
  assert.equal(decision(f).reason, "unsupported-finding");
});
test("handoff request stages work without transferring ownership", () => {
  const f = fixture("handoff"); f.candidate.result = { kind: "requested", reason: "Context limit", remainingWork: ["Verify expiry"], evidenceIds: [] };
  f.observation.successorLeaseEligible = false;
  assert.equal(decision(f).next, "stage-handoff");
});
const defects = [
  ["stale source", f => f.observation.sourceDigest = "old", "mismatched-sourceDigest"],
  ["foreign dispatch", f => f.observation.dispatchId = "other", "mismatched-dispatchId"],
  ["foreign session", f => f.observation.sessionId = "other", "mismatched-sessionId"],
  ["stale generation", f => f.observation.generation = 1, "mismatched-generation"],
  ["changed contract", f => f.observation.contractDigest = "old", "mismatched-contractDigest"],
  ["interrupted valid JSON", f => f.observation.terminal = "interrupted", "execution-not-completed"],
  ["missing terminal", f => delete f.observation.terminal, "execution-not-completed"],
  ["missing authorization", f => f.observation.authorized = false, "unauthorized"],
  ["unsupported version", f => f.request.schemaVersion = 2, "unsupported-version"],
  ["missing host identity", f => { delete f.request.actionId; delete f.observation.actionId; }, "invalid-host-request"],
  ["host field injection", f => f.candidate.sourceDigest = "source", "invalid-contract"],
  ["invented evidence", f => f.candidate.result.evidenceIds = ["invented"], "unknown-evidence"],
  ["stale evidence", f => f.observation.evidence[0].sourceDigest = "old", "unavailable-or-stale-evidence"],
  ["missing retained evidence", f => f.observation.evidence = [], "unavailable-or-stale-evidence"],
  ["fabricated test success", f => f.observation.checks[0].outcome = "failed", "verification-incomplete"],
  ["no execution evidence", f => f.observation.checks = [], "verification-incomplete"],
  ["stale verification", f => f.observation.checks[0].sourceDigest = "old", "verification-incomplete"],
  ["undeclared outcome", f => f.request.allowedOutcomes = ["blocked"], "outcome-not-allowed"],
];
for (const [name, mutate, reason] of defects) test(`reject ${name}; accept the paired valid case`, () => {
  const f = fixture(); assert.equal(decision(f).accepted, true); mutate(f);
  assert.deepEqual(decision(f), { accepted: false, reason, next: "reconcile" });
});
test("duplicate dispatch returns retained decision without a new transition", () => {
  const f = fixture(); f.observation.acceptedDispatchIds = ["dispatch"];
  assert.equal(decision(f).next, "return-retained-decision");
});
for (const defect of ["self-review", "open-findings", "uncertainty"]) test(`QA pass cannot override ${defect}`, () => {
  const f = fixture("qa-verdict");
  if (defect === "self-review") f.observation.independentReview = false;
  if (defect === "open-findings") f.observation.unresolvedBlockingFindings = 1;
  if (defect === "uncertainty") f.candidate.continuity.uncertainties = ["Expiry test not conclusive"];
  assert.equal(decision(f).reason, "qa-not-ready");
});
for (const defect of ["missing-resource", "duplicate-resource", "lease", "unvalidated-resource", "uncertainty"]) test(`handoff cannot transfer with ${defect}`, () => {
  const f = fixture("handoff");
  if (defect === "missing-resource") f.candidate.result.resourceIds = [];
  if (defect === "duplicate-resource") f.candidate.result.resourceIds.push("checkpoint");
  if (defect === "lease") f.observation.successorLeaseEligible = false;
  if (defect === "unvalidated-resource") f.observation.handoffResourcesValidated = false;
  if (defect === "uncertainty") f.candidate.result.uncertainties = ["Unread checkpoint"];
  assert.equal(decision(f).accepted, false);
});

for (const [name, mutate] of [
  ["missing blocker count", f => delete f.observation.unresolvedBlockingFindings],
  ["negative blocker count", f => f.observation.unresolvedBlockingFindings = -1],
  ["NaN blocker count", f => f.observation.unresolvedBlockingFindings = NaN],
  ["string blocker count", f => f.observation.unresolvedBlockingFindings = "0"],
  ["truthy evidence availability", f => f.observation.evidence[0].available = "false"],
  ["ambiguous check IDs", f => f.observation.checks.push({ ...f.observation.checks[0], outcome: "failed" })],
  ["ambiguous evidence IDs", f => f.observation.evidence.push({ ...f.observation.evidence[0], available: false })],
  ["missing retained decisions", f => delete f.observation.acceptedDispatchIds],
]) test(`QA rejects malformed host facts: ${name}`, () => {
  const f = fixture("qa-verdict"); assert.equal(decision(f).accepted, true); mutate(f);
  assert.equal(decision(f).reason, "invalid-host-observation");
});
test("handoff rejects string booleans from a malformed host boundary", () => {
  const f = fixture("handoff"); f.observation.successorLeaseEligible = "false";
  assert.equal(decision(f).reason, "invalid-host-observation");
});
test("missing and prototype-named requests fail closed without throwing", () => {
  const f = fixture();
  for (const request of [null, undefined, { ...f.request, operation: "toString" }]) {
    assert.equal(decide(request, f.observation, f.candidate).accepted, false);
  }
});
