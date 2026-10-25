/** Production regressions for the legacy defects replaced by native contracts. */
import assert from "node:assert/strict";
import test from "node:test";
import { Foreman } from "../../packages/ai-foreman/src/foreman.js";
import { Log } from "../../packages/ai-foreman/src/log.js";
import type { BuilderAdapter, TurnResult } from "../../packages/ai-foreman/src/adapters/types.js";
import { prepareVerificationContract } from "../../packages/ai-foreman/src/qaPreparation.js";
import { nativeFixtureTurn } from "../../packages/ai-foreman/test/helpers/nativeOutput.js";
import { nativePolicy, operationPayload } from "../../packages/ai-foreman/src/structuredOperation.js";
import { workReportOutput } from "../../packages/spec/src/qaOutputContracts.js";
import { candidate, assessment, storeFixture } from "../../packages/ai-foreman/test/qaPreparationFixtures.js";

const payload = { disposition: "already-satisfied", evidence: ["Complete original work evidence"], coverage: null, graphMaintenance: null };
test("one composed work result retains its payload without a generic status correction", async () => {
  let calls = 0;
  const adapter: BuilderAdapter = { agent: "codex", sessionId: () => "fixture-session", close: async () => {}, async *events() {},
    sendTurn: async (_instruction, policy) => { calls++; return nativeFixtureTurn(policy, "fixture-session", payload, "codex"); } };
  const foreman = new Foreman(adapter, new Log(), false, false);
  const turn = await foreman.runBuilderWork("Report the authorized work.");
  assert.equal(calls, 1);
  assert.deepEqual(operationPayload(turn.result, workReportOutput), payload);
});

for (const scenario of ["invalid-assessment-shape", "material-future-concern"] as const) test(`preparation retains ${scenario} without format repair or prose-based waiver`, async () => {
  const { db, store } = storeFixture(); const initial = candidate(); const prompts: string[] = [];
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true,
      normalizeDraft: (draft, response) => { for (const evidence of draft.preparationEvidence) { evidence.operationId = response.operationId!; evidence.sessionId = response.sessionId; evidence.evidenceDigest = "a".repeat(64); for (const ref of evidence.references) ref.digest = "a".repeat(64); } return draft; },
      dispatch: async (phase, instruction, operationId, _remaining, output) => {
        prompts.push(instruction);
        const c = candidate(); let proposed: unknown;
        if (phase === "prepare") proposed = { kind: "draft", checks: c.checks, coverage: c.coverage, baseline: [], unresolved: [], preparationEvidence: c.preparationEvidence.map(({ obligation, references, analysis }) => ({ obligation, analysis, references: references.map(({ path, locator }) => ({ path, locator })) })) };
        else {
          assert.equal(phase, "assess");
          const { draftPayloadDigest, inventoryDigest, policyVersion, operationId: _id, sessionId, authorSessionId, ...review } = assessment(c);
          proposed = scenario === "invalid-assessment-shape" ? { ...review, preparationEvidence: c.preparationEvidence }
            : { ...review, concerns: [{ category: "contract-gap", timing: "postimplementation", reason: "Required behavior is missing before Builder", requirementIds: ["req"], checkIds: ["check"], material: true, owner: "qa", nextAction: "Builder should implement it" }] };
        }
        const sessionId = phase === "prepare" ? "author" : "assessor";
        return { ...nativeFixtureTurn(nativePolicy(output, { dispatchId: operationId }), sessionId, proposed), sessionId };
      },
    });
    assert.equal(result.status, scenario === "material-future-concern" ? "blocked" : "incomplete", JSON.stringify(result));
    assert.equal(prompts.length, 2, "a material concern must stop instead of consuming assessment-repair dispatches");
    assert.doesNotMatch(prompts[1]!, /five-field draft/);
    assert.notEqual(store.head(initial.runId, initial.workId, initial.admissionDigest).state, "ready");
    if (scenario === "material-future-concern" && result.status === "blocked") {
      assert.match(result.detail, /host-owned routing/);
      assert.match(result.nextAction, /Revise and approve the affected plan or ticket verification intent/);
      assert.equal(store.budget(initial.runId, initial.workId, initial.admissionDigest)!.reservations.length, 2);
    }
  } finally { db.close(); }
});

test("legacy QA and remediation text cannot enter native authority consumers", async () => {
  const { qaStructuredResponse, remediationStructuredResponse } = await import("../../packages/ai-foreman/src/qaStructuredResponse.js");
  for (const text of [
    "STEP_STATUS: qa_pass",
    'STEP_STATUS: blocked | reason="dependency"',
    "RAFI_QA_FAILURE_REPORT_START\n{}\nRAFI_QA_FAILURE_REPORT_END\nSTEP_STATUS: qa_fail",
    "RAFI_BUILDER_QA_REMEDIATION_START\n{}\nRAFI_BUILDER_QA_REMEDIATION_END\nSTEP_STATUS: done",
    '```json\n{"version":3,"findings":[]}\n```',
  ]) {
    const turn: TurnResult = { text, rawResponse: text, isError: false, numTurns: 1, costUsd: 0 };
    assert.equal(qaStructuredResponse(turn).valid, false, text);
    assert.equal(remediationStructuredResponse(turn, {}).valid, false, text);
  }
});

test("native remediation preserves blocker and outcome consistency checks", async () => {
  const { remediationOutput } = await import("../../packages/spec/src/qaOutputContracts.js");
  const { remediationStructuredResponse } = await import("../../packages/ai-foreman/src/qaStructuredResponse.js");
  const { canonicalFixtureTurn } = await import("../../packages/ai-foreman/test/helpers/nativeOutput.js");
  const finding = { finding_key: "key", raw_id: "QA-1", disposition: "blocked", changes: ["Partial progress retained"], evidence: "Registry unavailable", verification: [{ check: "install", outcome: "not_run", evidence: "Registry unavailable" }], blocker: { category: "environment", reason: "Registry unavailable", recovery: "Restore registry access", capability: "registry", evidence: "ENOTFOUND" } };
  const report = { version: 3, handoff_id: "handoff", summary: "Partial result", findings: [finding], observations: [] };
  const policy = nativePolicy(remediationOutput);
  const turn = (payload: unknown) => canonicalFixtureTurn(policy, "session", payload);
  const payload = { status: "blocked", reason: "Registry unavailable", report, coverage: null };
  assert.equal(remediationStructuredResponse(turn(payload), {}).valid, true);
  assert.equal(remediationStructuredResponse(turn({ ...payload, status: "done", reason: null }), {}).valid, false);
  const { blocker: _blocker, ...withoutBlocker } = finding;
  assert.equal(remediationStructuredResponse(turn({ ...payload, report: { ...report, findings: [withoutBlocker] } }), {}).valid, false);
});
