import assert from "node:assert/strict";
import test from "node:test";
import { validateDepthDecision } from "../src/qaPreparationPolicy.js";

const lowRiskDecision = {
  version: 1,
  decisionId: "depth-1",
  level: 1,
  rationale: "A narrow, isolated change",
  riskFactors: [],
  lowRisk: {
    narrowBehavior: "One pure function",
    understoodDependencies: "No external dependencies",
    adequateVerification: "Focused regression tests",
  },
  policyVersion: "qa-preparation-v1",
  plannerOperationId: "planner-op",
  plannerIdentity: "planner-session",
  timestamp: "2026-10-16T00:00:00Z",
  minimumLevel: 1,
  minimumReasons: [],
};

test("level 1 is accepted for documented low-risk work", () => {
  assert.deepEqual(validateDepthDecision(lowRiskDecision), []);
});

test("extra preparation can be selected without changing the level-1 minimum", () => {
  assert.deepEqual(validateDepthDecision({ ...lowRiskDecision, level: 2 }), []);
  assert.deepEqual(validateDepthDecision({ ...lowRiskDecision, level: 2, minimumLevel: 2 }), []);
});

test("risk-based minimums still apply to low-risk claims", () => {
  const decision = {
    ...lowRiskDecision,
    riskFactors: [{ category: "security", rationale: "Authorization changes", references: ["auth.ts"] }],
    minimumReasons: ["security"],
  };
  assert.match(validateDepthDecision(decision).join("; "), /minimum 4/);
});
