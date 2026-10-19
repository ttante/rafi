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
/** Resolve public boolean configuration while temporarily accepting old mode objects. */
export function resolveQaPreparationConfig(value: unknown, shadow = false, wallTimeMs?: unknown): QaPreparationConfigV1 {
  // Preparation may require several fresh provider conversations (draft,
  // independent assessment, challenge, and bounded repairs). Keep this
  // ceiling separate from provider turn deadlines and give the logical
  // workflow enough time to reconcile retained work without replaying an
  // uncertain dispatch.
  const defaults: QaPreparationConfigV1 = { mode: "legacy", policyVersion: QA_PREPARATION_POLICY_VERSION, wallTimeMs: [600_000, 1_200_000, 2_400_000, 3_600_000, 5_400_000] };
  const resolveWallTime = (candidate: unknown): QaPreparationConfigV1["wallTimeMs"] | undefined => {
    if (candidate === undefined) return undefined;
    if (!Array.isArray(candidate) || candidate.length !== 5 || candidate.some((v, i) => !Number.isSafeInteger(v) || v < defaults.wallTimeMs[i]!)) throw new Error("QA preparation ceilings must specify five integer limits at least as large as policy defaults");
    return candidate as QaPreparationConfigV1["wallTimeMs"];
  };
  const publicWallTime = resolveWallTime(wallTimeMs);
  if (value === undefined) {
    if (shadow) throw new Error("qa_preparation_shadow requires qa_preparation: true");
    return { ...defaults, ...(publicWallTime ? { wallTimeMs: publicWallTime } : {}) };
  }
  if (typeof value === "boolean") {
    if (shadow && !value) throw new Error("qa_preparation_shadow requires qa_preparation: true");
    return { ...defaults, ...(publicWallTime ? { wallTimeMs: publicWallTime } : {}), mode: !value ? "legacy" : shadow ? "shadow" : "enforce" };
  }
  if (shadow) throw new Error("qa_preparation_shadow cannot be combined with legacy qa_preparation object configuration");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("qa_preparation must be an object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["mode", "policyVersion", "wallTimeMs"].includes(key))) throw new Error("Unknown QA preparation policy option");
  if (!["legacy", "shadow", "enforce"].includes(String(raw.mode))) throw new Error("qa_preparation.mode must be legacy, shadow, or enforce");
  if (raw.policyVersion !== undefined && raw.policyVersion !== defaults.policyVersion) throw new Error("Unsupported QA preparation policy version");
  if (wallTimeMs !== undefined) throw new Error("qa_preparation_wall_time_ms cannot be combined with legacy qa_preparation object configuration");
  const legacyWallTime = resolveWallTime(raw.wallTimeMs);
  return { ...defaults, mode: raw.mode as QaPreparationConfigV1["mode"], ...(legacyWallTime ? { wallTimeMs: legacyWallTime } : {}) };
}
export function validateDepthDecision(value: unknown, predecessor?: QaPreparationDepthDecisionV1): string[] {
  if (!validateDecision(value)) return (validateDecision.errors ?? []).map(error => `${error.instancePath} ${error.message}`);
  const decision = value as QaPreparationDepthDecisionV1;
  const issues: string[] = [];
  const minimum = Math.max(2, ...decision.riskFactors.map(risk => QA_RISK_MINIMUMS[risk.category]));
  if (!Number.isFinite(Date.parse(decision.timestamp))) issues.push("Invalid planner timestamp");
  if (decision.level === 1 && (!decision.lowRisk || decision.riskFactors.length)) issues.push("Focused requires explicit low-risk assessment and no consequential risks");
  // The minimum describes the risk floor, not the level the planner selected.
  // A planner may choose extra preparation while recognizing that Focused is sufficient.
  const effectiveMinimum = decision.lowRisk && !decision.riskFactors.length ? 1 : minimum;
  // Older plans described Standard as the minimum when selecting it, even with
  // low-risk evidence. Continue accepting those conservative recorded plans.
  const legacyStandardMinimum = effectiveMinimum === 1 && decision.level >= 2 && decision.minimumLevel === 2;
  if ((!legacyStandardMinimum && decision.minimumLevel !== effectiveMinimum) || decision.level < effectiveMinimum) issues.push(`Planner decision is below or misstates host minimum ${effectiveMinimum}`);
  if (decision.riskFactors.some(risk => !decision.minimumReasons.includes(risk.category))) issues.push("Minimum reasons must enumerate evidenced risk categories");
  if (predecessor) {
    if (decision.predecessorDecisionId !== predecessor.decisionId || decision.decisionId === predecessor.decisionId) issues.push("Depth revision must retain its predecessor identity");
    if (decision.level < predecessor.level && /(?:budget|cost|expens|provider.*fail|timeout|exhaust)/i.test(decision.rationale)) issues.push("Cost or provider failure cannot justify a downgrade");
  }
  return issues;
}
