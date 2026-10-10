export type FindingCause = "disclosed-builder-miss" | "preparation-omission" | "implementation-defect" | "new-authorized-scope" | "outside-contract" | "unknown";
export interface FindingAssessmentV1 {
  version: 1; findingId: string; contractDigest: string; reviewDigest: string;
  assessor: string; independent: boolean; cause: FindingCause; explanation: string;
  knowableBeforeImplementation: boolean | null; actionableBeforeImplementation: boolean | null;
  expectedCheckIds: string[]; originalInputEvidence: string[]; builderEvidence: string[];
  scopeAuthorityEvidence: string[];
}
export function validateFindingAssessment(assessment: FindingAssessmentV1): void {
  if (assessment.version !== 1 || !assessment.findingId || !assessment.assessor || !assessment.explanation?.trim() || !assessment.contractDigest || !assessment.reviewDigest) throw new Error("Finding assessment lacks retained scope, identity or explanation");
  if (assessment.cause === "preparation-omission" && (!assessment.independent || assessment.knowableBeforeImplementation !== true || assessment.actionableBeforeImplementation !== true || !assessment.originalInputEvidence.length)) throw new Error("An omission requires independent evidence that the check was knowable and actionable before implementation");
  if (assessment.cause === "disclosed-builder-miss" && (!assessment.expectedCheckIds.length || !assessment.builderEvidence.length)) throw new Error("Disclosed Builder miss requires the delivered check and Builder evidence");
  if (assessment.cause === "new-authorized-scope" && !assessment.scopeAuthorityEvidence.length) throw new Error("New scope requires retained authorization evidence");
}
export interface QaMetricEvent {
  version: 1; eventId: string; workKey: string; admissionDigest: string; at: string;
  mode: "legacy" | "shadow" | "enforce"; level?: number; cohort: string;
  kind: "approved" | "implementation-started" | "preparation-failure" | "substantive-review" | "format-repair" | "provider-retry" | "remediation" | "amendment" | "completed" | "waived" | "cancelled" | "abandoned" | "finding-classification" | "quality-observation" | "sample" | "phase-observation";
  status?: "passed" | "failed" | "blocked" | "not-run" | "disabled" | "advisory-only";
  equivalentReviewData?: boolean;
  phase?: "preparation" | "planning" | "challenge" | "builder" | "review" | "repair" | "remediation";
  durationMs?: number; costUsd?: number | null; inputTokens?: number | null; outputTokens?: number | null;
  findingId?: string; findingIds?: string[]; cause?: FindingCause; outsideContract?: boolean; classifier?: string;
  evidenceRefs?: string[]; assessmentRef?: string; confidence?: "supported" | "unknown"; corrects?: string;
  observationDay?: 7 | 30; reopened?: boolean; escapedDefect?: boolean;
  sample?: { contractDigest: string; reviewDigest: string; assessor: string; checkUsefulness: Array<{ checkId: string; result: string; duplicate?: boolean; irrelevant?: boolean; observation: string }>; excessiveInvestigation?: string; coverageAdequate: boolean };
}
export function validateFindingClassification(event: QaMetricEvent, resolveEvidence: (reference: string) => boolean): void {
  if (event.kind !== "finding-classification" || !event.findingId || !event.classifier || !event.cause) throw new Error("Classification requires stable finding and classifier identities");
  if (!event.evidenceRefs?.length || event.evidenceRefs.some(reference => !resolveEvidence(reference))) throw new Error("Classification requires retained evidence");
  if (event.cause !== "unknown" && event.confidence !== "supported") throw new Error("Unsupported classification must remain unknown");
  if (event.cause === "preparation-omission" && (!event.assessmentRef || !resolveEvidence(event.assessmentRef))) throw new Error("Knowability/actionability omission requires independent assessment");
}
/** Stable identities deduplicate replays; amendments do not reset work's first review. */
export function measureQaPreparation(events: QaMetricEvent[]) {
  const unique = new Map<string, QaMetricEvent>();
  for (const event of events) {
    if (event.version !== 1 || !event.eventId || !event.workKey || !Number.isFinite(Date.parse(event.at))) throw new Error("Invalid metric event");
    const existing = unique.get(event.eventId); if (existing && JSON.stringify(existing) !== JSON.stringify(event)) throw new Error("Conflicting metric replay"); unique.set(event.eventId, event);
  }
  const ordered = [...unique.values()].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const works = new Map<string, QaMetricEvent[]>();
  for (const event of ordered) { const group = works.get(event.workKey) ?? []; group.push(event); works.set(event.workKey, group); }
  let approved = 0, started = 0, comparableStarted = 0, excludedNonEquivalentReviews = 0, approvedNeverStarted = 0, preparationFailures = 0, firstReviews = 0, firstReviewPasses = 0, endToEndFirstAttempt = 0, omissionWorks = 0, omissionRounds = 0;
  const statuses: Record<string, number> = {}, causes: Record<FindingCause, number> = { "disclosed-builder-miss": 0, "preparation-omission": 0, "implementation-defect": 0, "new-authorized-scope": 0, "outside-contract": 0, unknown: 0 };
  const quality = { day7: { observed: 0, reopened: 0, escaped: 0, unknown: 0 }, day30: { observed: 0, reopened: 0, escaped: 0, unknown: 0 } };
  const phaseCosts: Record<string, { knownUsd: number; knownSamples: number; unknownSamples: number; durationMs: number }> = {};
  for (const group of works.values()) {
    const hasApproved = group.some(event => event.kind === "approved"), hasStarted = group.some(event => event.kind === "implementation-started");
    if (hasApproved) approved++; if (hasStarted) started++; if (hasApproved && !hasStarted) approvedNeverStarted++;
    const comparable = group.some(event => event.mode === "enforce" || event.equivalentReviewData === true);
    if (hasStarted && comparable) comparableStarted++;
    if (group.some(event => event.kind === "preparation-failure")) preparationFailures++;
    const firstObserved = group.find(event => event.kind === "substantive-review" && event.status !== "disabled" && event.status !== "advisory-only");
    if (firstObserved && firstObserved.mode !== "enforce" && firstObserved.equivalentReviewData !== true) excludedNonEquivalentReviews++;
    const first = firstObserved && (firstObserved.mode === "enforce" || firstObserved.equivalentReviewData === true) ? firstObserved : undefined;
    if (first) { firstReviews++; statuses[first.status ?? "unknown"] = (statuses[first.status ?? "unknown"] ?? 0) + 1; if (first.status === "passed") { firstReviewPasses++; if (hasStarted && group.some(event => event.kind === "completed")) endToEndFirstAttempt++; } }
    const classifications = new Map<string, QaMetricEvent>();
    for (const event of group) if (event.kind === "finding-classification" && event.findingId) classifications.set(event.findingId, event);
    for (const event of classifications.values()) causes[event.cause ?? "unknown"]++;
    const omissionFindings = new Set([...classifications].filter(([, event]) => event.cause === "preparation-omission" && event.confidence === "supported" && event.assessmentRef).map(([id]) => id));
    const omissionCorrections = group.filter(event => event.kind === "remediation" && group.some(review => review.kind === "substantive-review" && Date.parse(review.at) > Date.parse(event.at) && review.status !== "disabled" && review.status !== "advisory-only") && [event.findingId, ...(event.findingIds ?? [])].some(id => id && omissionFindings.has(id)));
    if (hasStarted && comparable && omissionCorrections.length) { omissionWorks++; omissionRounds += omissionCorrections.length; }
    const completion = group.find(event => event.kind === "completed");
    if (completion) for (const [day, field] of [[7, "day7"], [30, "day30"]] as const) {
      const observation = group.find(event => event.kind === "quality-observation" && event.observationDay === day && Date.parse(event.at) >= Date.parse(completion.at) + day * 86400000 && typeof event.reopened === "boolean" && typeof event.escapedDefect === "boolean");
      if (!observation) quality[field].unknown++; else { quality[field].observed++; if (observation.reopened) quality[field].reopened++; if (observation.escapedDefect) quality[field].escaped++; }
    }
    for (const event of group) {
      if (["waived", "cancelled", "abandoned"].includes(event.kind)) statuses[event.kind] = (statuses[event.kind] ?? 0) + 1;
      if (event.phase) { const cost = phaseCosts[event.phase] ??= { knownUsd: 0, knownSamples: 0, unknownSamples: 0, durationMs: 0 }; cost.durationMs += event.durationMs ?? 0; if (typeof event.costUsd === "number") { cost.knownUsd += event.costUsd; cost.knownSamples++; } else cost.unknownSamples++; }
    }
  }
  const fraction = (n: number, d: number) => d ? n / d : null;
  return { approved, started, comparableStarted, excludedNonEquivalentReviews, approvedNeverStarted, preparationFailures, firstReviews, firstReviewPasses, firstReviewPassRate: fraction(firstReviewPasses, firstReviews), endToEndFirstAttempt, endToEndRate: fraction(endToEndFirstAttempt, comparableStarted), omissionWorks, omissionRounds, omissionIncidence: fraction(omissionWorks, comparableStarted), omissionRoundsPerStarted: fraction(omissionRounds, comparableStarted), causes, statuses, quality, phaseCosts,
    outsideContractEvents: [...unique.values()].filter(event => event.kind === "finding-classification" && event.outsideContract).length,
    formatRepairs: ordered.filter(event => event.kind === "format-repair").length, providerRetries: ordered.filter(event => event.kind === "provider-retry").length,
    byMode: Object.fromEntries((["legacy", "shadow", "enforce"] as const).map(mode => [mode, { works: new Set(ordered.filter(event => event.mode === mode).map(event => event.workKey)).size, started: new Set(ordered.filter(event => event.mode === mode && event.kind === "implementation-started").map(event => event.workKey)).size }])), samples: ordered.filter(event => event.kind === "sample").map(event => ({ ...event.sample, eventId: event.eventId, workKey: event.workKey, mode: event.mode, level: event.level, cohort: event.cohort, at: event.at, costUsd: event.costUsd ?? null, durationMs: event.durationMs ?? null, evidenceRefs: event.evidenceRefs ?? [] })), cohortSizes: Object.fromEntries([...new Set(ordered.map(event => event.cohort))].map(cohort => [cohort, new Set(ordered.filter(event => event.cohort === cohort).map(event => event.workKey)).size])) };
}
export function relativeOmissionReduction(baseline: { incidence: number | null; cohort: string }, current: { incidence: number | null; cohort: string }): number | null {
  if (baseline.cohort !== current.cohort || baseline.incidence === null || baseline.incidence === 0 || current.incidence === null) return null;
  return (baseline.incidence - current.incidence) / baseline.incidence;
}
