import test from "node:test";
import assert from "node:assert/strict";
import { candidate, assessment, storeFixture, digest } from "./qaPreparationFixtures.js";
import { assembleContract, validateCandidate } from "../src/qaVerificationContract.js";
import { expectationDigest, persistedEquivalentResolver } from "../src/qaAuthorizedDisposition.js";

test("equivalent verification requires actual answered operator authority for exact expectation, method, revision and runtime", () => {
  const { db, store } = storeFixture(); db.exec("CREATE TABLE human_decisions(decision_id TEXT PRIMARY KEY,run_id TEXT,decision_json TEXT)");
  try {
    const draft = candidate(), check = draft.checks[0]!, method = check.verification[0]!; method.equivalentAuthorityId = "decision";
    const resolver = persistedEquivalentResolver(db); assert.ok(validateCandidate(draft, draft.requirements, resolver).some(issue => issue.includes("authority")));
    const { equivalentAuthorityId: _ref, ...concrete } = method;
    const answer = { version: 1, kind: "qa-equivalent-verification", runId: "run", workId: "T1", admissionDigest: digest, contractId: draft.contractId, revision: 1, checkId: check.id, expectationDigest: expectationDigest(check), method: concrete, reason: "Concrete equivalent proves the identical expiry expectation", validity: { runtime: method.runtime, expiresAt: "2099-01-01T00:00:00Z" } };
    const decision = { status: "answered", selectedChoiceId: "custom", answeredAt: "2026-10-09T00:00:00Z", interruptionId: `qa-equivalent:${draft.contractId}:1:${check.id}`, answer: JSON.stringify(answer) };
    db.prepare("INSERT INTO human_decisions VALUES('decision','run',?)").run(JSON.stringify(decision));
    assert.deepEqual(validateCandidate(draft, draft.requirements, resolver), []);
    assert.doesNotThrow(() => assembleContract(draft, draft.requirements, assessment(draft), "author", undefined, resolver));
    assert.equal(resolver("decision", { ...draft, revision: 2 }, check, method), false);
    assert.equal(resolver("decision", draft, { ...check, expectedBehavior: "Elevated scope" }, method), false);
    assert.equal(resolver("decision", draft, check, { ...method, runtime: "other-runtime" }), false);
    assert.equal(resolver("decision", draft, check, method, undefined, Date.parse("2100-01-01")), false);
    draft.coverage[0]!.dispositionRef = "decision"; assert.ok(validateCandidate(draft, draft.requirements, resolver).some(issue => issue.includes("concrete coverage")));
    assert.equal(store.equivalentResolver()("made-up", draft, check, method), false);
  } finally { db.close(); }
});

test("operational extension preserves consumed budget, original start and uncertain dispatch reservations", () => {
  const { db, store } = storeFixture(); db.exec("CREATE TABLE human_decisions(decision_id TEXT PRIMARY KEY,run_id TEXT,decision_json TEXT)");
  try {
    const budget = store.ensureBudget("run", "T1", digest, 2, 1000); store.reserve(budget, "uncertain", "investigation", {}, 1001);
    assert.throws(() => store.extendBudget(budget, "fake"), /answered scoped/);
    const decision = { status: "answered", answeredAt: "2026-10-09T00:00:00Z", interruptionId: `qa-preparation:${budget.id}`, answer: JSON.stringify({ budgetId: budget.id, reason: "Operator grants additional investigation time", deadlineMs: 2000000, caps: { investigation: 4 } }) };
    db.prepare("INSERT INTO human_decisions VALUES('extension','run',?)").run(JSON.stringify(decision)); store.extendBudget(budget, "extension"); store.extendBudget(budget, "extension");
    const current = store.budget("run", "T1", digest)!; assert.equal(current.startMs, 1000); assert.equal(current.reservations.length, 1); assert.equal(current.extensions.length, 1); assert.equal(current.deadlineMs, 2000000);
    assert.throws(() => store.reserve(budget, "replay", "investigation", {}, 1500000), /Uncertain/);
  } finally { db.close(); }
});
