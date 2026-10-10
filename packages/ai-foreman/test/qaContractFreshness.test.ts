import test from "node:test";
import assert from "node:assert/strict";
import { candidate, assessment, storeFixture, digest } from "./qaPreparationFixtures.js";
import { assembleContract, allocateStableCheckIds } from "../src/qaVerificationContract.js";
import { compareContractInputs } from "../src/qaContractFreshness.js";

test("product implementation does not stale authoritative inputs; exact rule changes require an immutable successor", () => {
  const { db, store } = storeFixture();
  try {
    const draft = candidate(), contract = assembleContract(draft, draft.requirements, assessment(draft), "author"), budget = store.ensureBudget("run", "T1", digest, 2, 0); store.retainProgress(budget, "inventory", draft.requirements); store.putArtifact("semantic-assessment", assessment(draft)); store.publish(contract, 0, 1);
    assert.deepEqual(compareContractInputs(contract, draft.inputs).changed, []);
    const changedInputs = draft.inputs.map(input => ({ ...input, digest: "b".repeat(64) })); assert.equal(compareContractInputs(contract, changedInputs).changed.length, 1);
    store.beginAmendment(budget, draft.requirements, { reason: "Authorized input clarification", inputDigest: "b".repeat(64), predecessorDigest: contract.contentDigest });
    const revised = { ...draft, inputs: changedInputs, revision: 2, predecessorDigest: contract.contentDigest }; const review = assessment(revised); store.putArtifact("semantic-assessment", review);
    const successor = assembleContract(revised, revised.requirements, review, "author"); store.publish(successor, store.head("run", "T1", digest).generation, 2);
    assert.equal(store.contract(contract.contentDigest).revision, 1); assert.equal(store.head("run", "T1", digest).digest, successor.contentDigest); assert.equal(store.receipts(successor.contentDigest).length, 0);
    assert.throws(() => db.prepare("UPDATE qa_verification_contracts SET record_json='{}'").run(), /immutable/);
  } finally { db.close(); }
});

test("stable host IDs ignore proposed names but include check meaning and dependency meaning", () => {
  const first = candidate(); const next = structuredClone(first); next.checks[0]!.id = "renamed"; next.coverage[0]!.checkIds = ["renamed"];
  assert.equal(allocateStableCheckIds(first).checks[0]!.id, allocateStableCheckIds(next).checks[0]!.id);
  const dependent = { ...structuredClone(first.checks[0]!), id: "dependent", dependsOnChecks: ["check"], expectedBehavior: "Caller rejects expired tokens" }; first.checks.push(dependent); first.coverage[0]!.checkIds.push("dependent");
  const changed = structuredClone(first); changed.checks[0]!.expectedBehavior = "Reject exact boundary too";
  assert.notEqual(allocateStableCheckIds(first).checks[1]!.id, allocateStableCheckIds(changed).checks[1]!.id);
  changed.checks[0]!.dependsOnChecks = ["dependent"]; assert.throws(() => allocateStableCheckIds(changed), /cycle/);
});
