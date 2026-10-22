# Supervisor/Worker Recovery Live E2E Identity Repair

## Objective

Resolve the provider-independent live recovery failure:

```text
QA preparation incomplete: Planner depth identity belongs to another admitted work
```

Also prevent live E2E runs from silently executing stale generated `dist` files.

## 1. Scope QA depth decisions by admitted work

Primary files:

- `packages/ai-foreman/src/qaPreparationStore.ts`
- QA preparation migration code
- `packages/ai-foreman/test/qaPreparation.test.ts` or a new store test

Implement:

- Add `admission_digest` to `qa_depth_decisions`.
- Scope identity by:

  `decision_id + run_id + work_id + admission_digest`

- Preserve the provider’s original `decisionId` in the stored decision.
- Only reject conflicting content within the same admitted work scope.
- Allow the same provider decision ID in a different run or admission.
- Keep same-run predecessor validation unchanged.

Do not change the public QA decision schema unless implementation proves it necessary. The provider-facing `decisionId` and `predecessorDecisionId` protocol already participates in preparation validation; the initial fix should remain inside persistence and scope handling.

## 2. Add a safe SQLite migration

Implement an atomic migration that:

- Creates a replacement table with the scoped identity.
- Copies all existing rows.
- Preserves historical run/work associations and JSON evidence.
- Replaces the old table safely.
- Supports existing databases created before this change.
- Does not delete or rewrite historical decisions.

The current table uses a global `decision_id` primary key. SQLite does not support simply changing that primary key in place, so the migration must explicitly create, copy, and replace the table or introduce an equivalent scoped storage key without losing historical records.

Add migration tests using an existing legacy database.

## 3. Preserve recovery semantics

Clarify and preserve the lifecycle boundaries:

- Exact-session recovery reuses the same run and preparation state.
- `build:start-over` supersedes the old run and preserves its history.
- The subsequent `start` command creates the new run and admission.
- The new run receives a new preparation scope.
- Provider session reuse remains allowed where explicitly authorized; it must not determine database identity.

Relevant files:

- `packages/rafi/src/buildStartOver.ts`
- `packages/rafi/src/buildResume.ts`
- `packages/ai-foreman/src/cli/start.ts`

Do not broadly prohibit exact-session provider reuse. The required distinction is between same-run recovery, which may reuse preparation state, and a successor run after start-over, which must use its own admitted-work scope.

## 4. Add regression coverage

Cover all of the following:

- The same provider decision ID across two runs succeeds.
- The same provider decision ID across two admissions succeeds.
- A same-run retry with identical content succeeds.
- Same-run conflicting content fails.
- Depth escalation requires the correct predecessor decision.
- Start-over followed by a new build creates an independent preparation scope.
- Historical preparation rows remain readable after migration.
- Exact-session recovery continues using the original preparation record.

Tests may extend the existing preparation integration suite or introduce a dedicated `qaPreparationStore.test.ts`; there is no requirement to force a new test file if the existing seams provide better coverage.

## 5. Fix live-test artifact freshness

The live harness imports generated `packages/*/dist` files. The first live attempt exposed that generated output can be older than the current TypeScript source.

Update:

- `scripts/live/incident-journeys.mjs`
- `scripts/live/README.md`
- package scripts if needed

Require or verify the build before live execution:

```bash
npm run build
```

Record the build/source revision in the evidence ledger and fail clearly when generated output is stale. An automatic build inside the live harness is optional; an explicit build preflight plus freshness validation is preferred because it keeps provider canaries bounded and makes generated-file writes deliberate.

## 6. Validation sequence

Run:

- Spec, AI Foreman, and CLI typechecks.
- `git diff --check`.
- Focused QA preparation, store, and migration tests.
- Start-over and recovery tests.
- Affected package test suites.
- Rebuild all packages.
- Parallel Claude and Codex live E2E runs on separate disposable projects.

The live journeys must exercise:

- plan and ticket population;
- approval;
- controlled interruption;
- start-over;
- fresh successor build;
- QA preparation;
- final implementation and tests;
- durable completion with no unresolved operations.

## Acceptance criteria

- No `Planner depth identity belongs to another admitted work` error occurs during start-over recovery.
- Same-run identity conflicts remain rejected.
- Historical preparation evidence is preserved.
- Exact-session recovery retains its existing preparation behavior.
- A successor run after start-over receives an independent preparation scope.
- The live harness cannot silently execute stale generated code.
- Both Claude and Codex complete the live recovery journey on separate disposable projects.
- Final ledgers show durable completion and no `in_progress` or `uncertain` provider operations.

## Implementation boundary

The primary implementation is narrowly defined: fix the database key scope, preserve run-specific recovery semantics, and make the live harness prove it is executing current generated code. Avoid changing the public provider protocol or broadly disabling provider-session reuse unless testing demonstrates that the scoped persistence fix is insufficient.
