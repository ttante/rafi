import { test } from "node:test";
import assert from "node:assert/strict";
import { candidate, assessment, storeFixture, digest } from "./qaPreparationFixtures.js";
import { prepareVerificationContract } from "../src/qaPreparation.js";
import { draftDigest, inventoryDigest } from "../src/qaVerificationContract.js";
import type { QaContractCandidateV1 } from "rafi-spec";
function envelope(tag: string, value: unknown) { return `${tag}_START\n${JSON.stringify(value)}\n${tag}_END`; }
test("shared orchestration persists ready contract after independent assessment and reuses it without provider replay", async () => {
  const { db, store } = storeFixture(); let calls = 0; let prepared: QaContractCandidateV1;
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  try {
    const deps = { store, now: () => 1000, inputsCurrent: () => true, dispatch: async (phase: string, instruction: string, operationId: string) => {
      calls++;
      if (phase === "prepare") { prepared = candidate(); for (const item of prepared.preparationEvidence) { item.operationId = operationId; item.sessionId = "author"; } return { text: envelope("RAFI_QA_CANDIDATE", prepared), sessionId: "author" }; }
      assert.equal(phase, "assess"); assert.ok(instruction.includes(draftDigest(prepared!)));
      const result = assessment(prepared!); result.operationId = operationId; result.draftPayloadDigest = draftDigest(prepared!); result.inventoryDigest = inventoryDigest(prepared!.requirements);
      return { text: envelope("RAFI_QA_ASSESSMENT", result), sessionId: "assessor" };
    } };
    const result = await prepareVerificationContract(initial, initial.requirements, deps); assert.equal(result.status, "ready"); assert.equal(calls, 2);
    const again = await prepareVerificationContract(initial, initial.requirements, deps); assert.equal(again.status, "ready"); assert.equal(calls, 2);
    assert.equal(store.head("run", "T1", digest).state, "ready");
  } finally { db.close(); }
});
test("unknown dispatch remains uncertain, survives restart and is not automatically repeated", async () => {
  const { db, store } = storeFixture(); let calls = 0;
  const deps = { store, now: () => 1000, inputsCurrent: () => true, dispatch: async () => { calls++; throw new Error("provider disconnected after send"); } };
  try {
    const initial = candidate(); assert.equal((await prepareVerificationContract(initial, initial.requirements, deps)).status, "uncertain");
    assert.equal((await prepareVerificationContract(initial, initial.requirements, deps)).status, "uncertain"); assert.equal(calls, 1);
  } finally { db.close(); }
});
test("semantic assessor concerns block publication even when structural coverage passes", async () => {
  const { db, store } = storeFixture(); let prepared: QaContractCandidateV1;
  try {
    const initial = candidate();
    const result = await prepareVerificationContract(initial, initial.requirements, { store, now: () => 1000, inputsCurrent: () => true, dispatch: async (phase, _instruction, operationId) => {
      if (phase === "prepare") { prepared = candidate(); for (const item of prepared.preparationEvidence) item.operationId = operationId; return { text: envelope("RAFI_QA_CANDIDATE", prepared), sessionId: "author" }; }
      const review = assessment(prepared!); review.concerns = [{ reason: "Missing clock-boundary test", requirementIds: ["req"], checkIds: ["check"], material: true, owner: "qa", nextAction: "Add explicit boundary expectation" }]; return { text: envelope("RAFI_QA_ASSESSMENT", review), sessionId: "assessor" };
    } });
    assert.equal(result.status, "incomplete"); assert.equal(store.head("run", "T1", digest).digest, undefined);
  } finally { db.close(); }
});

test("discovered interacting architecture risk escalates through planner ownership and a fresh Exceptional challenge", async () => {
  const { db, store } = storeFixture(); let draft = candidate(), calls = 0, challenges = 0;
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, { store, now: () => 1000, inputsCurrent: () => true, dispatch: async (phase, instruction, operationId) => {
      calls++;
      if (phase === "prepare") {
        const incoming = JSON.parse(instruction.split("Authoritative candidate/input inventory:\n")[1]!) as QaContractCandidateV1;
        draft = candidate(incoming.depthDecision.level); draft.depthDecision = incoming.depthDecision; for (const row of draft.preparationEvidence) { row.operationId = operationId; row.sessionId = "author"; }
        const risk = { category: "architecture-uncertainty", rationale: "An interacting failure boundary remains unknown", references: ["src/token.ts:verifyToken"] };
        return { text: envelope("RAFI_QA_CANDIDATE", draft) + (draft.depthDecision.level === 2 ? "\n" + envelope("RAFI_QA_ESCALATION", { rationale: "Architectural failure boundary discovered", riskFactors: [risk] }) : ""), sessionId: "author" };
      }
      if (phase === "planner") {
        const decision = candidate(5).depthDecision; decision.riskFactors = [{ category: "architecture-uncertainty", rationale: "Architecture boundary requires independent challenge", references: ["src/token.ts:verifyToken"] }]; decision.minimumLevel = 5; decision.minimumReasons = ["architecture-uncertainty"]; decision.predecessorDecisionId = initial.depthDecision.decisionId;
        return { text: envelope("RAFI_QA_DEPTH", decision), sessionId: "fresh-planner" };
      }
      const review = assessment(draft); review.operationId = operationId;
      if (phase === "challenge") { challenges++; return { text: envelope("RAFI_QA_CHALLENGE", { ...review, approach: "Retain expiry boundary and rejection invariant before coordinated caller verification", concernCategories: ["scope", "invariants", "failure-boundaries", "verification"], approachConcerns: [] }), sessionId: "fresh-challenger" }; }
      assert.equal(phase, "assess"); return { text: envelope("RAFI_QA_ASSESSMENT", review), sessionId: "fresh-assessor" };
    } });
    assert.equal(result.status, "ready"); assert.equal(calls, 5); assert.equal(challenges, 1); assert.equal(store.budget("run", "T1", digest)!.level, 5); assert.equal(store.budget("run", "T1", digest)!.startMs, 1000);
  } finally { db.close(); }
});

test("retained structurally valid draft and assessment recover after publication crash without new dispatch or budget", async () => {
  const { db, store } = storeFixture(); let calls = 0;
  try {
    const draft = candidate(), budget = store.ensureBudget("run", "T1", digest, 2, 1000); store.retainProgress(budget, "inventory", draft.requirements); store.retainProgress(budget, "draft", { candidate: draft, authorSessionId: "author" }); store.retainProgress(budget, "assessment", assessment(draft));
    const result = await prepareVerificationContract(draft, draft.requirements, { store, now: () => 1001, inputsCurrent: () => true, dispatch: async () => { calls++; throw new Error("Unexpected replay"); } });
    assert.equal(result.status, "ready"); assert.equal(calls, 0); assert.equal(store.budget("run", "T1", digest)!.startMs, 1000);
  } finally { db.close(); }
});

test("a retained independent approach concern reaches a bounded targeted follow-up and fresh challenge", async () => {
  const { db, store } = storeFixture(); let calls = 0, investigations = 0, challenges = 0, draft = candidate(5);
  const initial = candidate(5); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  try {
    const deps = { store, now: () => 1000, inputsCurrent: () => true, dispatch: async (phase: string, instruction: string, operationId: string) => {
      calls++;
      if (phase === "prepare") {
        investigations++; if (investigations === 2) assert.ok(instruction.includes("clock-boundary concern"));
        draft = candidate(5); if (investigations === 2) draft.checks[0]!.expectedBehavior += " including the exact clock boundary";
        for (const evidence of draft.preparationEvidence) evidence.operationId = operationId;
        return { text: envelope("RAFI_QA_CANDIDATE", draft), sessionId: "author" };
      }
      const review = assessment(draft); review.operationId = operationId;
      if (phase === "challenge") {
        challenges++;
        return { text: envelope("RAFI_QA_CHALLENGE", { ...review, approach: "Inspect and preserve the token expiry boundary", concernCategories: ["scope", "invariants", "failure-boundaries", "verification"], approachConcerns: challenges === 1 ? [{ reason: "clock-boundary concern", requirementIds: ["req"], checkIds: ["check"], material: true, owner: "qa", nextAction: "Inspect the exact clock boundary before implementation" }] : [] }), sessionId: `challenger-${challenges}` };
      }
      assert.equal(phase, "assess"); return { text: envelope("RAFI_QA_ASSESSMENT", review), sessionId: `assessor-${investigations}` };
    } };
    assert.equal((await prepareVerificationContract(initial, initial.requirements, deps)).status, "incomplete");
    const resumed = await prepareVerificationContract(initial, initial.requirements, deps);
    assert.equal(resumed.status, "ready", JSON.stringify(resumed)); assert.equal(calls, 6); assert.equal(investigations, 2); assert.equal(challenges, 2);
    assert.equal(store.budget("run", "T1", digest)!.startMs, 1000);
    assert.equal(store.budget("run", "T1", digest)!.reservations.filter(item => item.kind === "challenge").length, 2);
  } finally { db.close(); }
});
