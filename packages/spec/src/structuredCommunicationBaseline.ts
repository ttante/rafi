/**
 * Reviewed identity baseline generated from the v2 declaration table.  Keep
 * this intentionally small: descriptor digests belong to the descriptor
 * declaration; this file protects the release-critical operation, provider,
 * owner, and source-site set from accidental cardinality-only changes.
 */
export const structuredCommunicationBaselineV2 = Object.freeze({
  version: 1 as const,
  operations: Object.freeze([
    "ticket-population", "structured-plan", "risk-note-repair", "graph-semantic-extraction", "planner-remediation",
    "discovery", "guided-recovery", "branch-dependency-audit", "uninstall-proposal", "ticket-plan", "grill-audit",
    "builder-coverage", "work-report", "build-preflight", "session-initialization", "qa-recovery-acceptance",
    "builder-remediation", "qa-verdict", "qa-contract-acceptance", "qa-contract-segment", "handoff-acceptance", "manager",
    "qa-preparation-draft", "qa-preparation-assessment", "qa-preparation-challenge", "qa-preparation-depth",
  ] as const),
  providers: Object.freeze(["claude", "codex"] as const),
  subordinate: Object.freeze({ operation: "ticket-population-page", owner: "ticket-population", providers: ["claude", "codex"] as const }),
  durableDispatchOwners: Object.freeze(["generic", "qa-review", "qa-remediation"] as const),
  directDispatchSites: Object.freeze([
    "structuredOperation.journalStructuredDispatch",
    "qaReview.dispatchQaTurn",
    "qaFailureDelivery.deliver",
  ] as const),
});
