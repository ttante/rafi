import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { candidate, assessment, storeFixture, digest } from "./qaPreparationFixtures.js";
import { assembleContract } from "../src/qaVerificationContract.js";
import { QaPreparationStore, migrateQaPreparation } from "../src/qaPreparationStore.js";
import { resolveQaPreparationConfig } from "../src/qaPreparationPolicy.js";

test("logical budgets survive retry, generation change and downtime without resetting reservations", () => {
  const { db, store } = storeFixture();
  try {
    const budget = store.ensureBudget("run", "T1", digest, 2, 1000); store.reserve(budget, "op1", "investigation", { generation: 1 }, 1001);
    assert.equal(store.ensureBudget("run", "T1", digest, 5, 999999).deadlineMs, budget.deadlineMs);
    assert.throws(() => store.reserve(budget, "op2", "investigation", { generation: 2 }, 1002), /Uncertain/);
    store.retainResult(budget, "op1", { text: "partial" });
    assert.throws(() => store.reserve(budget, "op2", "investigation", {}, budget.deadlineMs), /exhausted/);
    assert.equal(store.budget("run", "T1", digest)!.reservations.length, 1);
    assert.equal(store.budget("run", "T1", digest)!.usage.costUsd, null);
  } finally { db.close(); }
});
test("publication CAS rejects a stale owner, expired budget and conflicting revision; migration is repeatable", () => {
  const { db, store } = storeFixture();
  try {
    migrateQaPreparation(db); const draft = candidate(); const contract = assembleContract(draft, draft.requirements, assessment(draft), "author"); store.ensureBudget("run", "T1", digest, 2, 0); store.putArtifact("semantic-assessment", assessment(draft)); store.retainProgress(store.budget("run", "T1", digest)!, "inventory", draft.requirements);
    assert.throws(() => store.publish(contract, 1, 1), /Stale/);
    assert.throws(() => store.publish(contract, 0, 1200000), /Expired/);
    store.publish(contract, 0, 1); assert.equal(store.head("run", "T1", digest).digest, contract.contentDigest);
    assert.throws(() => store.publish(contract, 0, 2), /Stale/);
    assert.deepEqual(store.contract(contract.contentDigest), contract);
  } finally { db.close(); }
});
test("escalation raises the ceiling from original start and does not allocate a fresh logical budget", () => {
  const { db, store } = storeFixture();
  try {
    const budget = store.ensureBudget("run", "T1", digest, 2, 1000);
    store.reviseDepth(budget, candidate(5).depthDecision);
    assert.equal(store.budget("run", "T1", digest)!.deadlineMs, 5401000);
    assert.equal(store.budget("run", "T1", digest)!.startMs, 1000);
  } finally { db.close(); }
});

test("provider depth ids are scoped to the admitted run and admission", () => {
  const db = new Database(":memory:"); db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE workflow_runs(run_id TEXT PRIMARY KEY); INSERT INTO workflow_runs VALUES('run'),('successor');");
  migrateQaPreparation(db);
  const policy = resolveQaPreparationConfig({ mode: "enforce" });
  const makeStore = (runId: string) => {
    const store = new QaPreparationStore(db, owner => { if (owner !== runId) throw new Error("Foreign owner"); });
    store.freezePolicy(runId, policy); return store;
  };
  try {
    const first = makeStore("run"), second = makeStore("successor");
    const firstBudget = first.ensureBudget("run", "T1", digest, 2, 1000);
    const reused = candidate(2).depthDecision;
    first.reviseDepth(firstBudget, reused);
    const secondAdmission = "b".repeat(64);
    const secondAdmissionBudget = first.ensureBudget("run", "T1", secondAdmission, 2, 1000);
    assert.doesNotThrow(() => first.reviseDepth(secondAdmissionBudget, reused));
    const secondBudget = second.ensureBudget("successor", "T1", digest, 2, 1000);
    assert.doesNotThrow(() => second.reviseDepth(secondBudget, reused));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM qa_depth_decisions WHERE decision_id=?").get(reused.decisionId) as { count: number }).count, 3);
    const conflicting = { ...reused, rationale: "Different admitted work content" };
    assert.throws(() => second.reviseDepth(secondBudget, conflicting), /Conflicting planner depth identity/);
    assert.doesNotThrow(() => first.reviseDepth(firstBudget, reused));
  } finally { db.close(); }
});

test("legacy global depth decision table migrates without losing evidence", () => {
  const db = new Database(":memory:"); db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE workflow_runs(run_id TEXT PRIMARY KEY); INSERT INTO workflow_runs VALUES('run'); CREATE TABLE qa_depth_decisions(decision_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,work_id TEXT NOT NULL,record_json TEXT NOT NULL)");
  const stored = candidate(2).depthDecision;
  db.prepare("INSERT INTO qa_depth_decisions VALUES(?,?,?,?)").run(stored.decisionId, "run", "T1", JSON.stringify(stored));
  try {
    migrateQaPreparation(db);
    assert.doesNotThrow(() => migrateQaPreparation(db));
    const columns = db.prepare("PRAGMA table_info(qa_depth_decisions)").all() as Array<{ name: string }>;
    assert.ok(columns.some(column => column.name === "admission_digest"));
    const row = db.prepare("SELECT decision_id,run_id,work_id,admission_digest,record_json FROM qa_depth_decisions").get() as { decision_id: string; run_id: string; work_id: string; admission_digest: string; record_json: string };
    assert.deepEqual(row, { decision_id: stored.decisionId, run_id: "run", work_id: "T1", admission_digest: "legacy:run:T1", record_json: JSON.stringify(stored) });
  } finally { db.close(); }
});

test("resume preserves the frozen mode and immutable policy instead of adopting new global settings", () => {
  const { db, store } = storeFixture();
  try {
    const frozen = store.policy("run")!;
    for (const mode of ["legacy", "shadow", "enforce"] as const) assert.deepEqual(store.freezePolicy("run", resolveQaPreparationConfig({ mode })), frozen);
    assert.equal(store.policy("run")!.mode, "enforce");
    assert.throws(() => db.prepare("UPDATE qa_preparation_policy SET record_json='{}' WHERE run_id='run'").run(), /immutable/);
  } finally { db.close(); }
});

test("input-only amendments clear obsolete drafts and preserve budget and uncertain dispatch authority", () => {
  const { db, store } = storeFixture();
  try {
    const draft = candidate(), review = assessment(draft), contract = assembleContract(draft, draft.requirements, review, "author");
    const budget = store.ensureBudget("run", "T1", digest, 2, 1000);
    store.putArtifact("semantic-assessment", review); store.retainProgress(budget, "inventory", draft.requirements); store.publish(contract, 0, 1001);
    store.retainProgress(budget, "draft", { candidate: draft, authorSessionId: "author" });
    store.beginAmendment(budget, draft.requirements, { reason: "Same rules, new provenance", inputDigest: "b".repeat(64), predecessorDigest: contract.contentDigest });
    assert.equal(store.progress(budget, "draft"), undefined); assert.deepEqual(store.progress(budget, "inventory"), draft.requirements);
    assert.equal(store.budget("run", "T1", digest)!.startMs, 1000); assert.equal(store.budget("run", "T1", digest)!.deadlineMs, budget.deadlineMs);
    store.retainProgress(budget, "draft", { candidate: draft, authorSessionId: "second-author" });
    store.beginAmendment(budget, draft.requirements, { reason: "Inputs changed during reconciliation", inputDigest: "c".repeat(64), predecessorDigest: contract.contentDigest });
    assert.equal(store.progress(budget, "draft"), undefined);
    assert.equal(store.progress<{ inputDigest: string }>(budget, "amendment-inputs")!.inputDigest, "c".repeat(64));
    store.reserve(budget, "uncertain-amendment", "investigation", {}, 1002);
    store.retainProgress(budget, "draft", { retained: "do not erase uncertain evidence" });
    assert.throws(() => store.beginAmendment(budget, draft.requirements, { reason: "Another change", inputDigest: "d".repeat(64), predecessorDigest: contract.contentDigest }), /Uncertain preparation dispatch/);
    assert.deepEqual(store.progress(budget, "draft"), { retained: "do not erase uncertain evidence" });
    assert.equal(store.budget("run", "T1", digest)!.reservations.length, 1);
  } finally { db.close(); }
});
