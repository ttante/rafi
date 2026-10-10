# Graphify evaluation harness and observations

Status: implementation validation in progress. Billed graph-on/off agent runs are deferred at the user's direction. No agent-quality improvement, total-cost reduction, or release certification is claimed.

## Reproduction

Use Node 20 and build `rafi-spec` and `ai-foreman` first. The bridge benchmark needs an existing compatible Graphify installation; it does not install packages, contact a model, or scan this repository.

```sh
RAFI_GRAPH_PYTHON=/path/to/graphify/venv/bin/python node packages/ai-foreman/scripts/graph-benchmark.mjs
node packages/ai-foreman/scripts/graph-evaluation.mjs prepare /tmp/new-graph-evaluation-directory
node packages/ai-foreman/scripts/graph-evaluation.mjs report
node packages/ai-foreman/scripts/graph-evaluation.mjs report /path/to/recorded-results.json
```

`prepare` writes 20 synthetic work items across missed callers, undeclared dependencies, cross-layer regressions, existing invariants, and captured requirements. Each includes source files, expected relevant paths, known source facts, deliberately ambiguous dynamic dispatch, mandatory QA checks and counterbalanced run order. A comment-only negative control requires zero maintenance. These are engineering fixtures, not a representative production cohort; vary real work difficulty and source baselines before drawing usefulness conclusions.

The harness never starts agents. Future runs must use isolated sessions/workspaces, the same source baseline, approved scope, QA standards, depth and provider/model settings for each pair. Record cold/warm conditions separately. Keep cancelled, blocked, failed, degraded and retried outcomes. Source inspection after an unavailable graph does not count as successful retrieval.

The report validator rejects duplicate observations, reused sessions, baseline or QA mismatches, missing outcome classifications and mismatched paired settings. Missing measurements must be explicit `null`; they are not converted into zero. It retains incomplete pairs and all outcome statuses. Its unit test covers these controls.

Each result is an object in a JSON array with:

- Identity: `caseId`, `arm` (`on`/`off`), `cache` (`cold`/`warm`), unique `sessionId`, `baselineDigest` from the manifest and `qaDigest` (SHA-256 of `JSON.stringify(case.mandatoryQa)`).
- Controls: `provider`, `model`, `depth`, `executionMode`, `semanticMode`, `difficulty`.
- Outcome: `status` (`completed`, `blocked`, `cancelled`, `degraded`, `failed`), nonnegative integer `retries`, boolean `sourceVerified` and `coverageVerified`.
- Measurements, each a nonnegative number or `null`: `usefulFindings`, `missedPaths`, `falseSuggestions`, `omissionRemediations`, `escapedDefects`, `repeatedExploration`, `preparationMs`, `buildMs`, `reviewMs`, `graphMs`, `extractionCostUsd`, `providerCostUsd`, `inputTokens`, `outputTokens`.

Costs must include retries and repairs. Avoid counting preparation's provider usage a second time in graph accounting. The report exposes paired differences without automatically claiming the plan's 20% improvement target. Human source verification and sampled equal QA coverage remain necessary.

## Local bridge observations

Measured 2026-10-10 UTC, macOS Darwin 25.3.0, Apple M1, Node 20.19.0, installed `graphifyy==0.9.82`. Five samples per size; directed synthetic chains, outgoing depth-two neighborhood. Every result contained the correct three nodes and excluded the incoming neighbor.

| Nodes | Edges | Cold median | Largest observed sample |
| --- | --- | --- | --- |
| 10,000 | 9,999 | 271 ms | 290 ms |
| 100,000 | 99,999 | 1,225 ms | 1,266 ms |

These follow-up observations were measured at 05:02 UTC. The bridge requests a 512 MiB address-space ceiling, but a subsequent explicit probe confirmed macOS rejected that control: `addressSpaceBytes: null`, `memoryEnforcement: collection-admission-only`, `cpuSeconds: 300`. Do not interpret these observations as proof of hard RSS enforcement. The bridge now reports resource controls and read limitations explicitly.

Measurements include host serialization, subprocess startup, graph loading and query execution. They were collected while regression tests were running. Five samples do not establish a production p95. A persistent warm worker is not implemented. Peak RSS, large mixed-corpus extraction, Windows/Linux process enforcement, semantic-provider cost and real agent outcomes remain unmeasured. The 100,000-node result supports only this synthetic query observation, not a general workload tier.

## Follow-up validation

- 108 targeted graph/evaluation/source-registry/QA-delivery/continuity/Manager/transfer tests passed after source-selection and resource-control reporting changes; zero failures or skips.
- 120 tests passed in the earlier branch-inclusive targeted run; 35 final setup/create/project tests and 48 spec tests passed.
- Foreman typecheck and spec/Foreman/CLI production builds passed.
- The dedicated gap suite includes 16 behavioral tests. It verifies exported SQLite contains no protected fixture text while live evidence remains unchanged, and that later provider turns retain source-policy restrictions.
- Final CLI/Foreman typechecks and production builds passed. Package dry-run verified the Python bridge, CLI, session/source helpers and evaluation/benchmark scripts. The setup tests verify AST-only setup starts no provider, mixed setup uses its configured host, and interrupted initialization is not blindly replayed. No live provider was invoked.

## Preparation handoff validation

- Broad runtime suite: **1,056 passed, 12 skipped, zero failures (1,068 total)**. Process inspection was enabled for process-ownership and recovery fixtures. No live-provider evaluation flag was enabled.

- Actual Foreman/branch caller suite: **17 passed**, covering Graphify enabled/disabled at all five depths, fresh Exceptional challenge, contract receipt provenance, amendment, same-session renewal, legacy and shadow behavior. Providers are controlled fixtures; graph-on cases here deliberately exercise missing-graph fallback.
- Focused graph/preparation/final-QA suite: **39 passed**, including a real populated Graphify generation reused by an equivalent snapshot, drift fallback without extraction, terminal deadlines and independent final-review certificate/recovery paths.
- Final storage/provenance/transfer/metrics checks: **42 passed**, including revoked preparation event projections and staged SQLite withholding. These counts overlap with the focused suite and must not be summed as unique cases.
- Spec and special-agent suites: **140 passed**, using a writable temporary npm cache for packaging checks.
- Workspace production builds/typechecks and required package-asset checks passed. Broad CLI run: 269 passed, three skipped, one readiness-fixture failure; the corrected fixture passed its focused rerun. The broad runtime result and remaining certification gaps are recorded in the implementation status checkpoint.
- The readiness-only fake Claude CLI in the SDK-installation test cannot speak the semantic-extraction protocol; that unrelated test now uses `--no-graph`. Its focused rerun passed. Graphify setup has separate AST/mixed-host/checkpoint tests.

## Earlier validation history

- Spec, Foreman and CLI production builds passed.
- Focused graph, QA-delivery and evaluation suite: 22 passed, zero skipped, including real Graphify extraction, mixed semantic reuse, immutable publication, frozen-workspace reuse, exclusion revocation, transferred authority stripping and separate QA graph continuations.
- Offline evaluation reporting test passed: mismatched pairs are rejected and cancelled/unknown observations retained.
- Spec suite: 48 passed. Special-agent/compiler suite: 92 passed.
- Full Foreman run: 949 passed, 20 failed, 12 skipped (981 total). Failures include preparation owner SQL-function arity, preparation event serialization containing `undefined`, and missing preparation event work IDs. This run overlapped the separate preparation implementation; it is not a stable final certification.
- Targeted packaged CLI/runtime/planning rerun: 31 passed, 4 failed (35 total). The four failures are explicit-blocked/deferred-first recovery variants that reached malformed preparation event JSON. Earlier skill-receipt and missing-built-export failures did not recur in this rerun.
- The Python skill validator could not start because PyYAML is absent in both available Python environments. Equivalent frontmatter/name/description/placeholder checks passed with the installed JavaScript YAML parser; compiler/skill package tests also passed.
- Broader checks must be repeated after preparation stabilizes; this document is not a release handoff.

The preparation implementation has been handed off and its shared planner/investigation/assessment/challenge gate is now integrated. Full D01–D25/T01–T35 certification and the final implementation handoff must state any remaining gaps explicitly.
