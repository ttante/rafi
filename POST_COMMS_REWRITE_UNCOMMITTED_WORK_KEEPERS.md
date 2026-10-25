# Uncommitted Work Worth Keeping After the Communications Rewrite

This document identifies useful work currently present in the uncommitted branch after the provider-communications rewrite. It does not recommend carrying every current implementation unchanged. Some pieces should be refactored behind the new structured-output interfaces.

## Keep as part of the rewritten architecture

### Host-owned QA evidence

Keep the design and most of the behavior in:

- `packages/ai-foreman/src/qaBuilderEvidence.ts`
- `packages/ai-foreman/src/qaBuilderCoverage.ts`
- `packages/ai-foreman/src/qaReview.ts`
- `packages/ai-foreman/src/workflowDb.ts`
- `packages/ai-foreman/src/hostQaAugmentation.ts`
- `packages/ai-foreman/src/qaCoverageAssembly.ts`

The communications rewrite changes how provider payloads arrive. It does not replace host-owned facts about commands, test ordering, source digests, or evidence captured before a crash. Preserve:

- durable host observation records;
- provider turn/tool identity where available;
- ordered test observations;
- source-digest binding;
- red-before-green reconstruction;
- one host-owned final QA assembly path;
- reloading evidence after process restart;
- refusal to treat provider claims as a substitute for missing host evidence.

Refactor these modules to consume the new structured-result abstraction rather than provider-specific response formats.

### Strict transitional payload compatibility

The changes in:

- `packages/ai-foreman/src/ticketPopulation.ts`
- `packages/spec/src/qaFailureReport.ts`

are useful during migration because they accept a complete plain JSON payload followed by a required `STEP_STATUS`, while still supporting the old wrapper format.

Keep this only as a temporary, strict compatibility path. It must not scan prose for JSON, infer fields, or bypass schema and binding validation. Eventually route it through the shared provider-output abstraction and record its transport as legacy fallback.

### Structured-plan normalization

The normalization in `packages/rafi/src/structuredPlan.ts` may be retained if the new output contract explicitly defines it as deterministic normalization of redundant fields. It should remain limited to deriving `minimumReasons` from the same proposal's declared `riskFactors`.

Do not expand this into general provider-response repair or silent semantic correction.

### Regression tests

Keep the tests covering the above behaviors, especially tests for:

- durable Builder observations;
- exact source-digest binding;
- red-before-green ordering;
- final QA assembly;
- strict plain JSON compatibility;
- rejection of missing status markers;
- structured-plan normalization boundaries.

## Useful, but independent of the communications rewrite

These changes are valuable but should remain separate unless the rewritten workflow directly needs them:

- No-commit repository support in `packages/ai-foreman/src/qaSnapshot.ts`.
- Git-ignore-aware untracked source capture in `packages/ai-foreman/src/buildAssignment.ts`.
- Dependency/vendor projection for independent QA snapshots.
- Plan-only Builder retry behavior in `packages/ai-foreman/src/foreman.ts`.
- `packages/rafi/src/buildReset.ts` and the `rafi build:reset` command.
- Related package exports in `packages/ai-foreman/package.json`.
- The workspace-root correction in `scripts/live/build-stalls.ts`.

These solve repository, recovery, or workflow-resilience problems rather than provider transport problems. They should be ported deliberately, not bundled into the communications migration by default.

## Do not preserve as the long-term interface

Do not make any of the following the post-rewrite design:

- marker extraction as the primary provider interface;
- parsing arbitrary prose for authoritative JSON;
- provider-specific extraction logic duplicated across operations;
- repair that changes substantive payload content;
- accepting provider-reported evidence without host verification;
- replacing durable host observations with a repaired provider response.

The long-term boundary should be a validated structured result with raw-response retention, schema/transport metadata, provider identity, validation diagnostics, and bounded legacy fallback.

## Bottom line

The most important reusable work is the host-owned QA evidence and finalization path. The plain-JSON parser changes are useful migration scaffolding. The snapshot, source-capture, reset, and retry changes are worthwhile independent improvements, but they should not be treated as communications-rewrite work.
