import { Ajv } from "ajv";
import { QA_PREPARATION_POLICY_VERSION, QA_RISK_MINIMUMS, qaPreparationDepthDecisionV1Schema, type QaPreparationConfigV1, type QaPreparationDepthDecisionV1, type QaPreparationLevel } from "rafi-spec";

const validateDecision = new Ajv({ allErrors: true }).compile(qaPreparationDepthDecisionV1Schema);
export const DEPTH_OBLIGATIONS = [
  ["behavior-mapping", "prerequisites", "scope-boundaries"],
  ["implementation-inspection", "test-inspection", "edge-cases", "verification-sequence"],
  ["dependency-map", "failure-cases", "state-transitions", "regression-compatibility"],
  ["consequential-invariants", "adversarial-cases", "concurrency-retry", "rollback-recovery"],
  ["approach-proposal", "independent-challenge", "coordinated-verification"],
] as const;
export function depthObligations(level: QaPreparationLevel): string[] { return DEPTH_OBLIGATIONS.slice(0, level).flat(); }
export function resolveQaPreparationConfig(value: unknown): QaPreparationConfigV1 {
  const defaults: QaPreparationConfigV1 = { mode: "legacy", policyVersion: QA_PREPARATION_POLICY_VERSION, wallTimeMs: [300_000, 600_000, 1_200_000, 1_800_000, 2_700_000] };
  if (value === undefined) return defaults;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("qa_preparation must be an object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["mode", "policyVersion", "wallTimeMs"].includes(key))) throw new Error("Unknown QA preparation policy option");
  if (!["legacy", "shadow", "enforce"].includes(String(raw.mode))) throw new Error("qa_preparation.mode must be legacy, shadow, or enforce");
  if (raw.policyVersion !== undefined && raw.policyVersion !== defaults.policyVersion) throw new Error("Unsupported QA preparation policy version");
  if (raw.wallTimeMs !== undefined && (!Array.isArray(raw.wallTimeMs) || raw.wallTimeMs.length !== 5 || raw.wallTimeMs.some((v, i) => !Number.isSafeInteger(v) || v < defaults.wallTimeMs[i]!))) throw new Error("QA preparation ceilings must specify five integer limits at least as large as policy defaults");
  return { ...defaults, mode: raw.mode as QaPreparationConfigV1["mode"], ...(raw.wallTimeMs ? { wallTimeMs: raw.wallTimeMs as QaPreparationConfigV1["wallTimeMs"] } : {}) };
}
export function validateDepthDecision(value: unknown, predecessor?: QaPreparationDepthDecisionV1): string[] {
  if (!validateDecision(value)) return (validateDecision.errors ?? []).map(error => `${error.instancePath} ${error.message}`);
  const decision = value as QaPreparationDepthDecisionV1;
  const issues: string[] = [];
  const minimum = Math.max(2, ...decision.riskFactors.map(risk => QA_RISK_MINIMUMS[risk.category]));
  if (!Number.isFinite(Date.parse(decision.timestamp))) issues.push("Invalid planner timestamp");
  if (decision.level === 1 && (!decision.lowRisk || decision.riskFactors.length)) issues.push("Focused requires explicit low-risk assessment and no consequential risks");
  const effectiveMinimum = decision.level === 1 && decision.lowRisk && !decision.riskFactors.length ? 1 : minimum;
  if (decision.minimumLevel !== effectiveMinimum || decision.level < effectiveMinimum) issues.push(`Planner decision is below or misstates host minimum ${effectiveMinimum}`);
  if (decision.riskFactors.some(risk => !decision.minimumReasons.includes(risk.category))) issues.push("Minimum reasons must enumerate evidenced risk categories");
  if (predecessor) {
    if (decision.predecessorDecisionId !== predecessor.decisionId || decision.decisionId === predecessor.decisionId) issues.push("Depth revision must retain its predecessor identity");
    if (decision.level < predecessor.level && /(?:budget|cost|expens|provider.*fail|timeout|exhaust)/i.test(decision.rationale)) issues.push("Cost or provider failure cannot justify a downgrade");
  }
  return issues;
}
