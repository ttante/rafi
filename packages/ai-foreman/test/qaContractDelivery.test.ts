import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidate, assessment, storeFixture, digest } from "./qaPreparationFixtures.js";
import { assembleContract, contractDigest } from "../src/qaVerificationContract.js";
import { deliverVerificationContract, actualContractSession, assertContractReceipt, materializeContract, finalReviewContractContext } from "../src/qaContractDelivery.js";
import type { BuilderAdapter } from "../src/adapters/types.js";
import { createProviderSessionRef } from "../src/sessionIdentity.js";

test("delivery acknowledges exact version on actual scoped session and renews after native compaction", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qa-delivery-"))), { db, store } = storeFixture();
  const draft = candidate(), review = assessment(draft), contract = assembleContract(draft, draft.requirements, review, "author"); store.ensureBudget("run", "T1", digest, 2, Date.now()); store.putArtifact("semantic-assessment", review); store.retainProgress(store.budget("run", "T1", digest)!, "inventory", draft.requirements); store.publish(contract, 0, Date.now());
  let sequence = 0, accepted = -1, sessionId = "builder", ackDigest = contract.contentDigest;
  const adapter: BuilderAdapter = { agent: "claude", sessionId: () => sessionId, sessionRef: () => createProviderSessionRef({ provider: "claude", sessionId, role: "builder", stream: "builder", generation: 1, cwd: root, configRoot: root, source: "observed" }),
    contractCapabilities: () => ({ sameSessionAcceptance: true, nativeCompactionBarrier: true }), enableContractEnforcement: () => {}, contractCompactionSequence: () => sequence, acceptContractDelivery: value => { accepted = value; },
    sendTurn: async (instruction, policy) => { assert.equal(policy?.purpose, "contract-acceptance"); assert.equal(policy?.responseOnly, true); assert.ok(instruction.includes("Expired tokens return unauthorized")); return { text: `RAFI_QA_ACCEPTANCE_START\n${JSON.stringify({ workId: "T1", revision: 1, digest: ackDigest, missingSections: [] })}\nRAFI_QA_ACCEPTANCE_END`, isError: false, numTurns: 1, costUsd: 0 }; }, events: async function* () {}, close: async () => {} };
  try {
    assert.throws(() => actualContractSession({ ...adapter, sessionId: () => "foreign-native-session" }, root, root), /actual scoped Builder/);
    assert.throws(() => actualContractSession({ ...adapter, sessionRef: () => ({ ...adapter.sessionRef!()!, role: "qa" }) }, root, root), /actual scoped Builder/);
    const receipt = await deliverVerificationContract(contract, store, adapter, root, root, "Full ticket"); assert.equal(receipt.sessionId, "builder"); assert.equal(accepted, 0);
    assert.equal(assertContractReceipt(store, "run", "T1", digest, actualContractSession(adapter, root, root), adapter).contentDigest, contract.contentDigest);
    const freshAdapter = { ...adapter };
    assert.throws(() => assertContractReceipt(store, "run", "T1", digest, actualContractSession(freshAdapter, root, root), freshAdapter), /current adapter/);
    assert.equal(assertContractReceipt(store, "run", "T1", digest, actualContractSession(adapter, root, root)).contentDigest, contract.contentDigest);
    sequence++; assert.throws(() => assertContractReceipt(store, "run", "T1", digest, actualContractSession(adapter, root, root)), /actual-session/);
    await deliverVerificationContract(contract, store, adapter, root, root, "Full ticket"); assert.equal(accepted, 1);
    sessionId = "replacement"; assert.throws(() => assertContractReceipt(store, "run", "T1", digest, actualContractSession(adapter, root, root)), /actual-session/);
    ackDigest = "b".repeat(64); await assert.rejects(() => deliverVerificationContract(contract, store, adapter, root, root, "Full ticket"), /stale/);
    sessionId = "builder";
    assert.throws(() => assertContractReceipt(store, "run", "T1", digest, actualContractSession(adapter, root, root), adapter), /current adapter/);
    const artifacts = materializeContract(contract, root); assert.equal(JSON.parse(readFileSync(artifacts.json, "utf8")).contentDigest, contract.contentDigest);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("large transport is lossless, byte bounded and cannot acknowledge a missing segment", async () => {
  const { segmentContractTransport } = await import("../src/qaContractDelivery.js");
  const text = "😀漢字".repeat(50000), sections = segmentContractTransport(text, 4096);
  assert.equal(sections.join(""), text); assert.ok(sections.every(section => Buffer.byteLength(section) <= 4096));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qa-segments-"))), { db, store } = storeFixture();
  const draft = candidate(), review = assessment(draft), contract = assembleContract(draft, draft.requirements, review, "author"), budget = store.ensureBudget("run", "T1", digest, 2, Date.now()); store.putArtifact("semantic-assessment", review); store.retainProgress(budget, "inventory", draft.requirements); store.publish(contract, 0, Date.now());
  let segments = 0, omit = false;
  const adapter: BuilderAdapter = { agent: "claude", sessionId: () => "builder", sessionRef: () => createProviderSessionRef({ provider: "claude", sessionId: "builder", role: "builder", stream: "builder", generation: 1, cwd: root, configRoot: root, source: "observed" }), contractCapabilities: () => ({ sameSessionAcceptance: true, nativeCompactionBarrier: true }), enableContractEnforcement: () => {}, acceptContractDelivery: () => {}, events: async function* () {}, close: async () => {}, sendTurn: async (instruction, policy) => {
    assert.equal(policy?.responseOnly, true); assert.ok(Buffer.byteLength(instruction) < 256 * 1024);
    const segment = instruction.match(/Return RAFI_QA_SEGMENT_START\/END containing (\{.*\})\./);
    if (segment) { segments++; const value = JSON.parse(segment[1]!); if (omit) value.missingSections = [String(value.index)]; return { text: `RAFI_QA_SEGMENT_START\n${JSON.stringify(value)}\nRAFI_QA_SEGMENT_END`, isError: false, numTurns: 1, costUsd: 0 }; }
    return { text: `RAFI_QA_ACCEPTANCE_START\n${JSON.stringify({ workId: "T1", revision: 1, digest: contract.contentDigest, missingSections: [] })}\nRAFI_QA_ACCEPTANCE_END`, isError: false, numTurns: 1, costUsd: 0 };
  } };
  try { await deliverVerificationContract(contract, store, adapter, root, root, text); assert.ok(segments > 1); omit = true; await assert.rejects(() => deliverVerificationContract(contract, store, adapter, root, root, text), /incomplete/); assert.equal(store.receipts(contract.contentDigest).length, 1); }
  finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("large final-review context retains full baseline/provider evidence in a confined read-only resource", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qa-review-context-"))), { db, store } = storeFixture();
  try {
    const draft = candidate();
    const providerReceipt = store.putArtifact("investigation-evidence", { text: "baseline-output:" + "😀".repeat(40000), sessionId: "preparer" });
    const evidenceDigest = store.putArtifact("baseline-observation", { procedure: "Inspect baseline", providerReceipt });
    draft.baseline = [{ id: "baseline", checkId: "check", applicability: "applicable", sourceDigest: digest, phase: "preimplementation-investigation", runtime: "node20", procedure: "Inspect baseline", observedAt: draft.createdAt, status: "passed", evidenceDigest, relevance: "preservation", expectedTransition: "Preserved" }];
    const contract = assembleContract(draft, draft.requirements, assessment(draft), "author");
    const claims = [{ outcome: "not-run", evidence: [] }];
    const instruction = finalReviewContractContext(contract, store, root, claims);
    assert.ok(Buffer.byteLength(instruction) < 4096); assert.ok(!instruction.includes("Full structured review context:"));
    const path = instruction.match(/Complete retained QA context: (.*)\n/)![1]!;
    const context = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(context.contract, contract); assert.deepEqual(context.builderClaims, claims);
    assert.equal(context.baselineEvidence[0].digest, evidenceDigest);
    assert.deepEqual(context.baselineEvidence[0].providerEvidence, store.artifact(providerReceipt, "investigation-evidence"));
    assert.ok(instruction.includes(contractDigest("final-review-context", context)));
    assert.equal(statSync(path).mode & 0o222, 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
