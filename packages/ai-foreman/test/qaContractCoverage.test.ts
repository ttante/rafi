import { test } from "node:test";
import assert from "node:assert/strict";
import { candidate, assessment, coverage, digest } from "./qaPreparationFixtures.js";
import { assembleContract } from "../src/qaVerificationContract.js";
import { BUILDER_WORK_COVERAGE_INSTRUCTIONS, COVERAGE_INSTRUCTIONS, bindCoverageHostFields, parseContractCoverage, validateContractCoverage } from "../src/qaContractCoverage.js";

test("implementation instructions defer source-bound coverage until the host provides all bindings", () => {
  assert.match(BUILDER_WORK_COVERAGE_INSTRUCTIONS, /Do not emit RAFI_QA_COVERAGE JSON/);
  assert.match(BUILDER_WORK_COVERAGE_INSTRUCTIONS, /separate response-only coverage record/);
  assert.match(BUILDER_WORK_COVERAGE_INSTRUCTIONS, /historical ordering/);
  assert.match(BUILDER_WORK_COVERAGE_INSTRUCTIONS, /later passing test cannot prove an earlier failing step/);
  assert.doesNotMatch(BUILDER_WORK_COVERAGE_INSTRUCTIONS, /Return RAFI_QA_COVERAGE_START/);
});
const binding = { phase: "qa" as const, sourceDigest: digest, inputBasisDigest: digest, attemptId: "review", sessionId: "reviewer" };
test("coverage instructions explain the real schema and flat host binding", () => {
  assert.match(COVERAGE_INSTRUCTIONS, /TOP LEVEL, not inside a binding object/);
  assert.match(COVERAGE_INSTRUCTIONS, /checkId \(not id\)/);
  assert.match(COVERAGE_INSTRUCTIONS, /predicateEvidence as an array/);
  assert.match(COVERAGE_INSTRUCTIONS, /exact host-supplied sourceDigest/);
  assert.match(COVERAGE_INSTRUCTIONS, /reference to that observation's exact evidenceDigest/);
  assert.match(COVERAGE_INSTRUCTIONS, /run every other applicable mandatory check/);
  assert.match(COVERAGE_INSTRUCTIONS, /not leave such a provider-owned check as not-run/);
  assert.match(COVERAGE_INSTRUCTIONS, /host-owned.*Rafi.*not-run/i);
  assert.match(COVERAGE_INSTRUCTIONS, /do not block or fail QA/);
  assert.match(COVERAGE_INSTRUCTIONS, /"required":\["version","phase","runId"/);
});
test("generic success and incomplete mandatory results never pass contract coverage", () => {
  const draft = candidate(), contract = assembleContract(draft, draft.requirements, assessment(draft), "author");
  assert.throws(() => parseContractCoverage("STEP_STATUS: qa_pass"));
  assert.deepEqual(validateContractCoverage(contract, coverage(contract), binding), []);
  for (const outcome of ["failed", "blocked", "not-run"] as const) { const result = coverage(contract); result.checks[0]!.outcome = outcome; assert.match(validateContractCoverage(contract, result, binding).join(), /incomplete/); }
  const stale = coverage(contract); stale.revision++; assert.match(validateContractCoverage(contract, stale, binding).join(), /binding/);
  const empty = coverage(contract); empty.checks = []; assert.ok(validateContractCoverage(contract, empty, binding).length);
});
test("host coverage binding omits null optional limitations without changing evidence claims", () => {
  const draft = candidate(), contract = assembleContract(draft, draft.requirements, assessment(draft), "author"), result = coverage(contract);
  (result.checks[0]!.evidence[0] as unknown as { limitation: unknown }).limitation = null;
  const bound = bindCoverageHostFields(result, contract, binding);
  assert.equal("limitation" in bound.checks[0]!.evidence[0]!, false);
  assert.equal(bound.checks[0]!.outcome, "passed");
  assert.deepEqual(validateContractCoverage(contract, bound, binding), []);
});
test("conditional mandatory checks need predicate evidence; advisory checks stay visible without blocking", () => {
  const draft = candidate(); draft.checks[0]!.applicability = { kind: "conditional", predicate: "Token auth enabled", decisionOwner: "qa", requiredEvidence: ["configuration"] };
  const contract = assembleContract(draft, draft.requirements, assessment(draft), "author");
  const result = coverage(contract); result.checks[0]!.applicability = "not-applicable"; result.checks[0]!.outcome = "not-run";
  assert.match(validateContractCoverage(contract, result, binding).join(), /predicate/);
  result.checks[0]!.predicateEvidence = ["Inspected auth config: disabled"]; assert.deepEqual(validateContractCoverage(contract, result, binding), []);
  result.checks[0]!.applicability = "unresolved"; assert.match(validateContractCoverage(contract, result, binding).join(), /incomplete/);
  result.checks[0]!.applicability = "applicable"; result.checks[0]!.outcome = "passed"; result.checks[0]!.predicateEvidence = [];
  assert.match(validateContractCoverage(contract, result, binding).join(), /predicate/);
  result.checks[0]!.predicateEvidence = ["Inspected auth config: token authentication enabled"];
  assert.deepEqual(validateContractCoverage(contract, result, binding), []);
});
