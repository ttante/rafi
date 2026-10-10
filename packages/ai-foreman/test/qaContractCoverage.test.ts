import { test } from "node:test";
import assert from "node:assert/strict";
import { candidate, assessment, coverage, digest } from "./qaPreparationFixtures.js";
import { assembleContract } from "../src/qaVerificationContract.js";
import { parseContractCoverage, validateContractCoverage } from "../src/qaContractCoverage.js";
const binding = { phase: "qa" as const, sourceDigest: digest, inputBasisDigest: digest, attemptId: "review", sessionId: "reviewer" };
test("generic success and incomplete mandatory results never pass contract coverage", () => {
  const draft = candidate(), contract = assembleContract(draft, draft.requirements, assessment(draft), "author");
  assert.throws(() => parseContractCoverage("STEP_STATUS: qa_pass"));
  assert.deepEqual(validateContractCoverage(contract, coverage(contract), binding), []);
  for (const outcome of ["failed", "blocked", "not-run"] as const) { const result = coverage(contract); result.checks[0]!.outcome = outcome; assert.match(validateContractCoverage(contract, result, binding).join(), /incomplete/); }
  const stale = coverage(contract); stale.revision++; assert.match(validateContractCoverage(contract, stale, binding).join(), /binding/);
  const empty = coverage(contract); empty.checks = []; assert.ok(validateContractCoverage(contract, empty, binding).length);
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
