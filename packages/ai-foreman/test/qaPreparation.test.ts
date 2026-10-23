import { test } from "node:test";
import assert from "node:assert/strict";
import { candidate, assessment, storeFixture, digest } from "./qaPreparationFixtures.js";
import { prepareVerificationContract, draftOutput } from "../src/qaPreparation.js";
import { draftDigest, inventoryDigest } from "../src/qaVerificationContract.js";
import type { QaContractCandidateV1, OutputContract } from "rafi-spec";
import { structuredReceipt } from "../src/adapters/structured.js";
import { validateStructuredCandidate } from "rafi-spec";
import type { PreparationDependencies } from "../src/qaPreparation.js";
function nativePreparation(output: OutputContract, value: any, sessionId: string, operationId: string, escalation?: unknown) {
  const payload = structuredClone(value);
  if (output.operation === "qa-preparation-draft") {
    for (const key of Object.keys(payload)) if (!["checks", "coverage", "baseline", "preparationEvidence", "unresolved"].includes(key)) delete payload[key];
    for (const evidence of payload.preparationEvidence) {
      delete evidence.operationId; delete evidence.sessionId; delete evidence.evidenceDigest;
      for (const reference of evidence.references) delete reference.digest;
    }
    if (escalation) {
      const valueOnWire = { version: 1, operation: output.operation, result: { kind: "completed", summary: "fixture", payload: { kind: "escalation", escalation } }, continuity: null };
      return { text: "Presentation has no authoritative payload", sessionId, structured: structuredReceipt(output, "claude", valueOnWire, { dispatchId: operationId, sessionId, nativeTurnId: operationId, nativeItemId: `item-${operationId}` }, "decoded-json"), output };
    }
    Object.assign(payload, { kind: "draft" });
  } else if (output.operation === "qa-preparation-depth") {
    delete payload.plannerOperationId; delete payload.plannerIdentity;
  } else {
    for (const field of ["draftPayloadDigest", "inventoryDigest", "policyVersion", "operationId", "sessionId", "authorSessionId"]) delete payload[field];
  }
  const valueOnWire = { version: 1, operation: output.operation, result: { kind: "completed", summary: "fixture", payload }, continuity: null };
  const structured = structuredReceipt(output, "claude", valueOnWire, { dispatchId: operationId, sessionId, nativeTurnId: operationId, nativeItemId: `item-${operationId}` }, "decoded-json");
  return { text: "Presentation has no authoritative payload", sessionId, structured, output };
}

test("native draft payload separates an escalation from the operation result envelope", () => {
  const draft = candidate();
  const normal = nativePreparation(draftOutput, draft, "author", "draft");
  const response = validateStructuredCandidate(draftOutput, normal.structured);
  assert.equal(response.result.kind, "completed");
  if (response.result.kind === "completed") assert.equal(response.result.payload.kind, "draft");
  const malformed = {
    version: 1,
    operation: draftOutput.operation,
    result: { kind: "completed", summary: "fixture", payload: { kind: "draft", checks: [], coverage: [], baseline: [], preparationEvidence: [], unresolved: [] }, escalation: null },
    continuity: null,
  };
  assert.equal(draftOutput.schema.safeParse(malformed).success, false, "result.escalation is not a permissive fallback");
});
const normalizeDraft: NonNullable<PreparationDependencies["normalizeDraft"]> = (draft, response) => {
  for (const evidence of draft.preparationEvidence) {
    evidence.operationId = response.operationId!; evidence.sessionId = response.sessionId; evidence.evidenceDigest = digest;
    for (const reference of evidence.references) reference.digest = digest;
  }
  return draft;
};
test("shared orchestration persists ready contract after independent assessment and reuses it without provider replay", async () => {
  const { db, store } = storeFixture(); let calls = 0; let prepared: QaContractCandidateV1;
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  try {
    const deps = { store, normalizeDraft, now: () => 1000, inputsCurrent: () => true, dispatch: async (phase: string, instruction: string, operationId: string, _remainingMs: number, output: OutputContract) => {
      calls++;
      if (phase === "prepare") { prepared = candidate(); for (const item of prepared.preparationEvidence) { item.operationId = operationId; item.sessionId = "author"; } return nativePreparation(output, prepared, "author", operationId); }
      assert.equal(phase, "assess"); assert.ok(instruction.includes(prepared!.requirements[0]!.statement));
      const result = assessment(prepared!); result.operationId = operationId; result.draftPayloadDigest = draftDigest(prepared!); result.inventoryDigest = inventoryDigest(prepared!.requirements);
      // Provider JSON may omit host-owned dispatch metadata. The adapter
      // receipt must supply it before strict contract validation.
      delete (result as Partial<typeof result>).sessionId;
      delete (result as Partial<typeof result>).operationId;
      return nativePreparation(output, result, "assessor", operationId);
    } };
    const result = await prepareVerificationContract(initial, initial.requirements, deps); assert.equal(result.status, "ready", JSON.stringify(result)); assert.equal(calls, 2);
    const again = await prepareVerificationContract(initial, initial.requirements, deps); assert.equal(again.status, "ready"); assert.equal(calls, 2);
    assert.equal(store.head("run", "T1", digest).state, "ready");
  } finally { db.close(); }
});
test("unknown dispatch remains uncertain, survives restart and is not automatically repeated", async () => {
  const { db, store } = storeFixture(); let calls = 0;
  const deps = { store, normalizeDraft, now: () => 1000, inputsCurrent: () => true, dispatch: async () => { calls++; throw new Error("provider disconnected after send"); } };
  try {
    const initial = candidate(); assert.equal((await prepareVerificationContract(initial, initial.requirements, deps)).status, "uncertain");
    assert.equal((await prepareVerificationContract(initial, initial.requirements, deps)).status, "uncertain"); assert.equal(calls, 1);
  } finally { db.close(); }
});
test("semantic assessor concerns block publication even when structural coverage passes", async () => {
  const { db, store } = storeFixture(); let prepared: QaContractCandidateV1;
  try {
    const initial = candidate();
    const result = await prepareVerificationContract(initial, initial.requirements, { store, normalizeDraft, now: () => 1000, inputsCurrent: () => true, dispatch: async (phase, _instruction, operationId, _remainingMs, output) => {
      if (phase === "prepare") { prepared = candidate(); for (const item of prepared.preparationEvidence) item.operationId = operationId; return nativePreparation(output, prepared, "author", operationId); }
      const review = assessment(prepared!); review.concerns = [{ category: "verification-gap", timing: "postimplementation", reason: "Missing clock-boundary test", requirementIds: ["req"], checkIds: ["check"], material: true, owner: "qa", nextAction: "Add explicit boundary expectation" }]; return nativePreparation(output, review, "assessor", operationId);
    } });
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.ok("nextAction" in result && result.nextAction.includes("Revise and approve"));
    assert.equal(store.head("run", "T1", digest).digest, undefined);
  } finally { db.close(); }
});

test("discovered interacting architecture risk escalates through planner ownership and a fresh Exceptional challenge", async () => {
  const { db, store } = storeFixture(); let draft = candidate(), calls = 0, challenges = 0;
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, { store, normalizeDraft, now: () => 1000, inputsCurrent: () => true, dispatch: async (phase, instruction, operationId, _remainingMs, output) => {
      calls++;
      if (phase === "prepare") {
        const incoming = JSON.parse(instruction.split("Authoritative candidate/input inventory:\n")[1]!) as QaContractCandidateV1;
        draft = candidate(incoming.depthDecision.level); draft.depthDecision = incoming.depthDecision; for (const row of draft.preparationEvidence) { row.operationId = operationId; row.sessionId = "author"; }
        const risk = { category: "architecture-uncertainty", rationale: "An interacting failure boundary remains unknown", references: ["src/token.ts:verifyToken"] };
        return nativePreparation(output, draft, "author", operationId, draft.depthDecision.level === 2 ? { version: 1, rationale: "Architectural failure boundary discovered", riskFactors: [risk] } : undefined);
      }
      if (phase === "planner") {
        const decision = candidate(5).depthDecision; decision.riskFactors = [{ category: "architecture-uncertainty", rationale: "Architecture boundary requires independent challenge", references: ["src/token.ts:verifyToken"] }]; decision.minimumLevel = 5; decision.minimumReasons = ["architecture-uncertainty"]; decision.predecessorDecisionId = initial.depthDecision.decisionId;
        return nativePreparation(output, decision, "fresh-planner", operationId);
      }
      const review = assessment(draft); review.operationId = operationId;
        if (phase === "challenge") {
          challenges++;
          const receipt = { ...review, approach: "Retain expiry boundary and rejection invariant before coordinated caller verification", concernCategories: ["scope", "invariants", "failure-boundaries", "verification"], approachConcerns: [] };
          delete (receipt as Partial<typeof receipt>).sessionId;
          delete (receipt as Partial<typeof receipt>).operationId;
          return nativePreparation(output, receipt, "fresh-challenger", operationId);
        }
      assert.equal(phase, "assess"); return nativePreparation(output, review, "fresh-assessor", operationId);
    } });
    assert.equal(result.status, "ready", JSON.stringify(result)); assert.equal(calls, 5); assert.equal(challenges, 1); assert.equal(store.budget("run", "T1", digest)!.level, 5); assert.equal(store.budget("run", "T1", digest)!.startMs, 1000);
  } finally { db.close(); }
});

test("retained structurally valid draft and assessment recover after publication crash without new dispatch or budget", async () => {
  const { db, store } = storeFixture(); let calls = 0;
  try {
    const draft = candidate(), budget = store.ensureBudget("run", "T1", digest, 2, 1000); store.retainProgress(budget, "inventory", draft.requirements); store.retainProgress(budget, "draft", { candidate: draft, authorSessionId: "author" }); store.retainProgress(budget, "assessment", assessment(draft));
    const result = await prepareVerificationContract(draft, draft.requirements, { store, normalizeDraft, now: () => 1001, inputsCurrent: () => true, dispatch: async () => { calls++; throw new Error("Unexpected replay"); } });
    assert.equal(result.status, "ready"); assert.equal(calls, 0); assert.equal(store.budget("run", "T1", digest)!.startMs, 1000);
  } finally { db.close(); }
});

test("a retained independent approach concern reaches a bounded targeted follow-up and fresh challenge", async () => {
  const { db, store } = storeFixture(); let calls = 0, investigations = 0, challenges = 0, draft = candidate(5);
  const initial = candidate(5); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  try {
    const deps = { store, normalizeDraft, now: () => 1000, inputsCurrent: () => true, dispatch: async (phase: string, instruction: string, operationId: string, _remainingMs: number, output: OutputContract) => {
      calls++;
      if (phase === "prepare") {
        investigations++; if (investigations === 2) assert.ok(instruction.includes("clock-boundary concern"));
        draft = candidate(5); if (investigations === 2) draft.checks[0]!.expectedBehavior += " including the exact clock boundary";
        for (const evidence of draft.preparationEvidence) evidence.operationId = operationId;
        return nativePreparation(output, draft, "author", operationId);
      }
      const review = assessment(draft); review.operationId = operationId;
      if (phase === "challenge") {
        challenges++;
        return nativePreparation(output, { ...review, approach: "Inspect and preserve the token expiry boundary", concernCategories: ["scope", "invariants", "failure-boundaries", "verification"], approachConcerns: challenges === 1 ? [{ category: "verification-gap", timing: "postimplementation", reason: "clock-boundary concern", requirementIds: ["req"], checkIds: ["check"], material: true, owner: "qa", nextAction: "Inspect the exact clock boundary before implementation" }] : [] }, `challenger-${challenges}`, operationId);
      }
      assert.equal(phase, "assess"); return nativePreparation(output, review, `assessor-${investigations}`, operationId);
    } };
    assert.equal((await prepareVerificationContract(initial, initial.requirements, deps)).status, "incomplete");
    const resumed = await prepareVerificationContract(initial, initial.requirements, deps);
    assert.equal(resumed.status, "ready", JSON.stringify(resumed)); assert.equal(calls, 6); assert.equal(investigations, 2); assert.equal(challenges, 2);
    assert.equal(store.budget("run", "T1", digest)!.startMs, 1000);
    assert.equal(store.budget("run", "T1", digest)!.reservations.filter(item => item.kind === "challenge").length, 2);
  } finally { db.close(); }
});

for (const reason of [
  "The required export is missing before implementation.",
  "Aggregate check cites an unknown ID; the acceptance item is already covered.",
  "A sibling export may already be present on this branch.",
]) test(`material concern is never downgraded by prose: ${reason}`, async () => {
  const { db, store } = storeFixture();
  const draft = candidate();
  try {
    const result = await prepareVerificationContract(draft, draft.requirements, { store, normalizeDraft, now: () => 1000, inputsCurrent: () => true,
      dispatch: async (_phase, _instruction, operationId, _remaining, output) => {
        if (output.operation === "qa-preparation-draft") return nativePreparation(output, draft, "author", operationId);
        const review = assessment(draft);
        review.concerns = [{ reason, requirementIds: ["req"], checkIds: ["check"], material: true, owner: "qa", nextAction: "Implement or revise the check", category: "contract-gap", timing: "postimplementation" }];
        return nativePreparation(output, review, "assessor", operationId);
      } });
    assert.equal(result.status, "blocked");
    assert.ok("detail" in result && result.detail.includes(reason), JSON.stringify(result));
    assert.ok("nextAction" in result && result.nextAction.includes("Revise and approve"), JSON.stringify(result));
    const retained = store.artifacts("provider-result");
    assert.ok(retained.some(item => JSON.stringify(item.value).includes(reason)));

  } finally { db.close(); }
});

test("native preparation rejects a malformed payload once without format repair", async () => {
  const { db, store } = storeFixture(); let calls = 0;
  const draft = candidate();
  try {
    const result = await prepareVerificationContract(draft, draft.requirements, { store, normalizeDraft, now: () => 1000, inputsCurrent: () => true,
      dispatch: async (_phase, _instruction, operationId, _remaining, output) => {
        calls++;
        const bad = candidate(); bad.checks[0]!.hostKind = "source-scope";
        return nativePreparation(output, bad, "author", operationId);
      } });
    assert.equal(result.status, "incomplete"); assert.equal(calls, 1);
    assert.equal(store.head("run", "T1", digest).digest, undefined);
  } finally { db.close(); }
});
