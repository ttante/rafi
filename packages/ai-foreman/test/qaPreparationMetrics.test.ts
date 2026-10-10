import { test } from "node:test";
import assert from "node:assert/strict";
import { measureQaPreparation, relativeOmissionReduction, validateFindingClassification, type QaMetricEvent } from "../src/qaPreparationMetrics.js";
function event(id: string, kind: QaMetricEvent["kind"], extra: Partial<QaMetricEvent> = {}): QaMetricEvent { return { version: 1, eventId: id, kind, workKey: "work/admission", admissionDigest: "a".repeat(64), at: `2026-10-09T00:00:${id.padStart(2, "0")}Z`, mode: "enforce", cohort: "standard-current-node20-policy1", ...extra }; }
test("first review is stable across amendments/format repairs/replay; blocked reviews remain denominator", () => {
  const events = [event("01", "approved"), event("02", "implementation-started"), event("03", "substantive-review", { status: "blocked" }), event("04", "format-repair"), event("05", "amendment"), event("06", "substantive-review", { status: "passed" }), event("07", "completed")];
  const metrics = measureQaPreparation([...events, ...events]); assert.equal(metrics.started, 1); assert.equal(metrics.firstReviews, 1); assert.equal(metrics.firstReviewPasses, 0); assert.equal(metrics.formatRepairs, 1); assert.equal(metrics.quality.day7.unknown, 1);
});
test("omissions require retained independent assessment; unknown costs and causes remain explicit", () => {
  const classification = event("04", "finding-classification", { findingId: "finding", classifier: "assessor", cause: "preparation-omission", confidence: "supported", evidenceRefs: ["input", "contract", "delivery", "review"], assessmentRef: "assessment" });
  assert.throws(() => validateFindingClassification({ ...classification, assessmentRef: undefined }, () => true), /independent/);
  validateFindingClassification(classification, () => true);
  const metrics = measureQaPreparation([event("01", "approved"), event("02", "implementation-started"), event("03", "substantive-review", { status: "failed", phase: "review", costUsd: null }), classification, event("05", "remediation", { findingIds: ["finding"] }), event("06", "substantive-review", { status: "passed" })]);
  assert.equal(metrics.omissionIncidence, 1); assert.equal(metrics.omissionRounds, 1); assert.equal(metrics.phaseCosts.review!.unknownSamples, 1);
  assert.equal(relativeOmissionReduction({ incidence: 0, cohort: "a" }, { incidence: 1, cohort: "a" }), null);
  assert.equal(relativeOmissionReduction({ incidence: .5, cohort: "a" }, { incidence: .4, cohort: "b" }), null);
});

test("omission remediation needs a linked completed correction and substantive recheck, with late observations explicit", () => {
  const classification = event("03", "finding-classification", { findingId: "finding", cause: "preparation-omission", confidence: "supported", assessmentRef: "independent-assessment" });
  const initial = [event("01", "approved"), event("02", "implementation-started"), classification];
  assert.equal(measureQaPreparation(initial).omissionIncidence, 0);
  const correction = event("04", "remediation", { findingIds: ["finding"] });
  assert.equal(measureQaPreparation([...initial, correction]).omissionIncidence, 0);
  const events = [...initial, correction, event("05", "substantive-review", { status: "passed" }), event("06", "completed")];
  assert.equal(measureQaPreparation(events).omissionRounds, 1);
  assert.equal(measureQaPreparation([...events, event("07", "quality-observation", { observationDay: 7, reopened: false, escapedDefect: false })]).quality.day7.unknown, 1);
  const observation = event("08", "quality-observation", { at: "2026-10-16T00:00:06Z", observationDay: 7, reopened: true, escapedDefect: false });
  const metrics = measureQaPreparation([...events, observation, observation]);
  assert.deepEqual(metrics.quality.day7, { observed: 1, reopened: 1, escaped: 0, unknown: 0 });
  assert.equal(metrics.quality.day30.unknown, 1);
});

test("legacy and shadow generic passes cannot inflate contract-aware first review success", () => {
  const events = [event("01", "approved", { mode: "legacy" }), event("02", "implementation-started", { mode: "legacy" }), event("03", "substantive-review", { mode: "legacy", status: "passed" }), event("04", "completed", { mode: "legacy" })];
  const metrics = measureQaPreparation(events);
  assert.equal(metrics.started, 1); assert.equal(metrics.comparableStarted, 0);
  assert.equal(metrics.excludedNonEquivalentReviews, 1); assert.equal(metrics.firstReviewPassRate, null); assert.equal(metrics.endToEndRate, null);
  const equivalent = measureQaPreparation(events.map(row => ({ ...row, equivalentReviewData: true })));
  assert.equal(equivalent.firstReviewPassRate, 1); assert.equal(equivalent.endToEndRate, 1);
});
