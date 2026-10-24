# Communication migration preflight

Historical preimplementation baseline and current regression entry point for [the migration plan](../../STRUCTURED_PROVIDER_OUTPUT_MIGRATION_PLAN.md), not production communication adapters. The five steps are baseline, provider experiments, representative contracts, regression fixtures, and cleanup inventory. Production implementation dispositions are now recorded in [the cleanup inventory](CLEANUP_INVENTORY.md); the migration plan holds the current release-gate status. The dated baseline numbers below describe earlier code, not the current candidate.

## 1. Reproducible baseline

Use Node 24 (`nvm use`) and pnpm 10.2.1. Node 24 is required in the three-OS CI matrix. TypeScript packages use Node 24 types, and the lockfile resolves `better-sqlite3` 13.0.3. Workspace linking is explicit in `.npmrc`; do not test against published copies of local packages.

```sh
pnpm install --frozen-lockfile
pnpm check:native
pnpm baseline:comms
pnpm test:comms-preflight
```

The baseline runner creates a temporary evidence directory outside the repo, recording HEAD, individual file hashes, a source digest, command arguments, durations, and logs. It stops at the first failed prerequisite so later tests cannot report success against stale build artifacts. On Windows, invoke it through `pnpm baseline:comms` so the pnpm JavaScript entry runs directly without a command shell. The working tree contains pre-existing changes; HEAD alone is not its identity. Build/typecheck and the focused planning, population, assignment, QA preparation/delivery/handback, and continuity fixtures use the actual source and local workspace builds. These are offline journeys, not complete live CLI builds.

Runtime findings from 2026-10-23 UTC:

- The original SQLite binary had Node 20 ABI 115; Node 24.21.0 requires ABI 137. Package-manager rebuild commands did not replace it because install-script execution was suppressed. A direct build with cached Node 24 headers fixed loading.
- SQLite 12.10.0 then passed a small query but crashed four test files in `RemoveEnvironmentCleanupHook` during native garbage collection. This is consistent with the [Node upstream cleanup-hook issue](https://github.com/nodejs/node/issues/65446); the local crash logs are the evidence for this checkout.
- [SQLite 13.0.3](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/package.json) uses Node-API and bundled prebuilds. It loaded without rebuilding, removed the deprecated `prebuild-install` dependency, and passed all 191 focused baseline tests. Build and typecheck passed. No database schema version changed.
- During dependency resolution, pnpm selected registry packages instead of the existing workspace links. That intermediate test run was stopped and is not acceptance evidence. Explicit `link-workspace-packages=true` restores and preserves the intended local links.

Local evidence roots: `/tmp/rafi-comms-preflight/before.json` (pre-edit inventory), `baseline/` (SQLite 12 crash), `baseline-sqlite13/` (invalid registry-resolution attempt), and `baseline-final/` (191 passing tests). The latter run used source HEAD `13607d61603d7376c8a3bb43008b656fd9343454` plus the recorded dirty-tree hashes. No published package or user database was modified. Cross-platform CI and release-install certification are not inferred from a macOS run.

### Historical broad validation and baseline gate

At this historical preimplementation checkpoint, the baseline was reproducible but the complete existing suite was not green. The later migration resolved these failures; use the current implementation gate in the migration plan, not this historical table. Results below are from macOS with Node 24.21.0; temporary raw logs may expire, so preserve them with the release evidence before cleanup.

| Check | Result and evidence under `/tmp/rafi-comms-preflight/` |
| --- | --- |
| Native SQLite smoke, workspace build/typecheck, generated CLI docs, frozen lockfile consistency | Passed; build/typecheck logs in `baseline-final/` |
| Focused communication journeys | 191 passed, zero failed/skipped; `baseline-final/journeys.log` |
| Representative contracts and legacy reproductions | Initial 43 passed; `contracts-and-regressions.log`. Audit expanded this to 60 passing cases, including harness failures; see audit evidence below. |
| Full workspace test command | Spec 56 passed; special-agents 92 passed; Foreman 1,347 passed, 27 failed, 12 skipped (1,386 total); `workspace-tests.log`. Command stopped before CLI. |
| Foreman failed cases after diagnosis | All 24 crash-recovery assertions passed after explicitly selecting TAP in their nested test subprocess. Node 24's default pretty reporter omitted the asserted `SIGKILL` detail; recovery logic/assertions were preserved. Logs: `guidance-claude-rerun.log`, `guidance-codex-rerun.log`. |
| Foreman startup timing failures | Three supervisor tests exceeded their existing startup deadline under the broad run; all three passed unchanged in isolation. Timing sensitivity remains; `supervised-rerun.log`. |
| CLI suite run separately | 313 passed, 20 failed, 3 skipped (336 total); `cli-tests.log`. All failures hit the same existing plan-approval binding guard described below. |
| Local package installation smoke | Packed all four packages, installed them together in a disposable project, and passed CLI version, ticket initialization and queue commands. Preflight scripts are absent from production tarballs. Artifacts in `packs/`, `installed/`, `installed-project/`. Global installation and the other OS/Node matrix entries remain unverified. |

The 20 CLI failures are 16 cases in [interruptedPackaged.test.mjs](../../packages/rafi/test/interruptedPackaged.test.mjs) and four in [syntheticPackaged.test.mjs](../../packages/rafi/test/syntheticPackaged.test.mjs). They fail before provider dispatch with `saved --yes approval has no exact plan binding`. Source inspection traces the mismatch to:

1. [buildResume.ts](../../packages/rafi/src/buildResume.ts), `planApprovalBindingOrUndefined`, swallows binding errors and can save auto-approval without a binding.
2. [cli/start.ts](../../packages/ai-foreman/src/cli/start.ts) rejects that decision for any nonempty recovery scope.
3. [buildApproval.ts](../../packages/ai-foreman/src/buildApproval.ts), `planApprovalBinding`, requires real tracker ticket definitions and a completed structured-plan approval. The interrupted fixtures supply no approved plan; the synthetic fixtures use frozen synthetic work definitions instead of tracker tickets.

All three source files and both fixtures match their preflight inventory hashes. This establishes an existing source/fixture incompatibility, not a Node 24 or new contract validation regression. It does **not** establish that every failure is merely a stale fixture: synthetic/legacy recovery needs an explicit authority contract. Do not bypass the guard or add fake approvals just to make the baseline pass.

Before declaring the migration baseline/release gate clean, resolve that contract separately: use exact completed plan receipts for planned ticket recovery; define host-bound authorization over frozen synthetic work and its consequences; reject unavailable legacy authority before launching with an actionable recovery path. Keep paired rejection tests for absent, stale and changed approvals, and rerun both packaged suites. A fresh `--yes` must not send users back into the same rejection loop. This preflight records the blocker and leaves production approval semantics unchanged.

## 2. Provider interface experiments

The [live harness](../live/structured-output.mjs) uses disposable workspaces, serial providers, an absolute deadline, 90-second turn limits, at most nine host dispatches in the interface profile, and Claude's $0.50 query limit plus four-turn SDK limit. Codex has no dollar cap in this harness: its bound is five tiny-response dispatches and deadlines. Actual SDK/model work may exceed one model turn per host dispatch. Set a future deadline explicitly:

```sh
export RAFI_LIVE_STRUCTURED=1
export RAFI_LIVE_DEADLINE="<future ISO UTC timestamp>"
pnpm canary:structured-output
RAFI_LIVE_STRUCTURED_PROFILE=contracts pnpm canary:structured-output
```

`RAFI_LIVE_PROVIDERS=claude` or `codex` narrows a rerun and requires only that provider's CLI. Duplicate provider entries are rejected before any dispatch; reported dispatch bounds reflect the selected profile/providers. Optional model selectors are `RAFI_LIVE_CLAUDE_MODEL` and `RAFI_LIVE_CODEX_MODEL`; otherwise the probe requests Claude `sonnet` and the installed Codex default. Record the actual resolved model, not merely an alias. Prompts contain only synthetic values. Domain tools are forbidden by the request, denied through available callbacks, and checked in observed events. This experiment does not prove production tool-policy enforcement. Raw events, terminal results, sessions, versions, durations, and available cost are retained outside the workspace.

Observed interface results:

| Provider/runtime/model | Result | Architectural implication |
| --- | --- | --- |
| Claude Code 2.1.302, SDK 0.3.159, resolved `claude-sonnet-5-5` | Text, structured result, changed schema after exact-session resume, and abort without acceptance passed | Closing and resuming a query can preserve session ID and remembered context while changing schema. This does not establish a per-message setter or prove the production streaming/compaction lifecycle. |
| Codex CLI 0.162.1, resolved `gpt-6-astra` | Text, structured result, changed schema on one thread, interrupted terminal, and exact-thread resume after interruption passed | Use per-turn `outputSchema`; correlate native thread/turn/item events and require successful terminal completion. |
| Codex queued-turn timing | First interruption attempt returned `no active turn to interrupt` after the start RPC acknowledgement | Start acknowledgement and active execution are separate states. The corrected probe waits for the correlated `turn/started` event; the rerun passed. Production cancellation must reconcile queued/start/completed races, not retry work. |

Claude evidence: `/tmp/rf-e-N8QVSt`; successful Codex rerun: `/tmp/rf-e-m7vKo2`. The initial sandbox attempt `/tmp/rf-e-wwiEYg` could not access provider auth/state and is environment-failure evidence, not model performance. Successful probes used the existing authenticated runtimes with the necessary sandbox exception. A few synthetic calls are capability evidence, not a reliability percentage or whole-application benchmark.

## 3. Representative versioned contracts

[contracts.mjs](contracts.mjs) contains executable draft-07 wire schemas, a host request schema, and a pure acceptance-policy rehearsal. It is not imported by production or exported in any npm package. Use it to settle operation meaning before moving the final design into the shared spec package.

| Operation | Agent-owned response | Host acceptance and next step |
| --- | --- | --- |
| `work-report` v1 | Completed with modified/already-satisfied distinction and evidence references, or blocked with a concrete next action; bounded continuity | Current authorized dispatch and retained verification evidence. A completed report proceeds to independent QA; it does not certify the ticket. Already-satisfied work need not manufacture a source diff. |
| `qa-verdict` v1 | Passed, failed with requirement-linked findings, or blocked; evidence references and bounded continuity | Pass requires current checks/evidence, independent review and no unresolved blockers. Failed findings remain failure evidence. Eligibility still needs atomic certification in production. |
| `handoff` v1 | Request with remaining work, or resource receipt with explicit uncertainty, or blocked | A request stages a handoff. Receipt eligibility requires exact resources, host validation and current successor eligibility. Only the existing durable transaction may transfer the lease. |

The request chooses operation/version, permitted outcomes and evidence references before dispatch. Action/dispatch/session IDs, generations, source/contract digests, required checks, requirements and resource manifests are host-owned; the agent does not calculate or echo them. The host observation binds native results to the request and supplies retained execution results, permission state, prior accepted dispatch IDs and lease readiness.

Field semantics:

- `version`/`operation` select the declared response contract; unknown versions or extra authority fields fail validation.
- `result.kind` selects an exclusive outcome. Blocked is a valid record, not successful completion. Findings belong only to failed QA, so a pass cannot also carry blocking findings.
- `evidenceIds` reference available, current evidence admitted by the host; a string claiming tests passed is insufficient. A passing test still does not prove every product requirement.
- `continuity.summary` and `uncertainties` preserve context. They do not grant authority, waive findings or trigger hidden repairs.
- Handoff `resourceIds` acknowledge the exact host manifest; `remainingWork` describes unfinished work. A model acknowledgement alone cannot transfer ownership.

The reference `decide` function performs no I/O or durable transitions. Its observations are host-owned fixture inputs representing future host-verified facts, not fields a model may provide. Host ownership does not make missing/malformed data safe: the rehearsal validates observation types, rejects duplicate check/evidence IDs and requires an explicit nonnegative blocker count and boolean authority facts. Production must acquire and recheck those facts under the existing revision/transaction rules, use the complete evidence/coverage policies, enforce raw decoding limits and duplicate-key rules, and retain accepted receipts. The reference does not replace that infrastructure. Its returns deliberately say *eligible* for certification/transfer.

The contracts profile exercises these nested operation/outcome shapes on each provider with synthetic completed work, failed QA and handoff request objects. It tests serialization, not actual coding, QA or lease transfer. Large contracts, refusals, streaming query changes, compaction, every union branch and the full CLI workflow remain migration release tests.

The representative live experiment found a real incompatibility before production implementation: Claude accepted Zod's nested `oneOf`, while Codex rejected it as an invalid strict schema. `projectCodexSchema` now converts only provably disjoint required literal-`kind` alternatives to `anyOf`, rejecting overlapping alternatives. Paired JSON Schema validation fixtures preserve valid and invalid behavior; all three live Codex contracts then passed. Evidence: `/tmp/rf-e-u8ayIK` (Claude success and original Codex rejection), `/tmp/rf-e-8NJtYK` (corrected Codex success). Future harness runs also record harness/contract source hashes; these first experiment ledgers predate that metadata addition.

## 4. Regression corpus

`pnpm test:comms-preflight` runs paired valid/invalid acceptance fixtures and three production-code reproductions. Cases include fabricated success, unavailable/stale evidence, wrong source/session/generation, missing terminal completion, duplicate dispatch, unknown authority fields, already-satisfied work, legitimate blocked work, supported QA failures and handoff readiness.

[legacy-regressions.test.ts](legacy-regressions.test.ts) now asserts the replacements: one composed result retains its payload, invalid assessment shape causes no formatting dispatch, and a substantive concern cannot be silently waived based on prose. Bounded substantive corrections remain allowed and are counted.

The baseline also runs existing production QA handback safety tests for duplicate/foreign terminal events, stale generations and uncertain dispatch without replay. Those complement the pure reference policy; they do not prove the new coordinator has been implemented. See the [cleanup inventory](CLEANUP_INVENTORY.md) for exact retirement gates.

## 5. Implementation entry and release boundaries

Use the [cleanup inventory](CLEANUP_INVENTORY.md) and existing migration phases to implement the shared contracts, native adapters and coordinator. Each item identifies active callers, replacement, preserved invariant and proof needed to retire the old behavior. The original preflight did not remove production paths. Subsequent implementation removals and retained compatibility readers are listed in the cleanup inventory.

Do not release the new communication pipeline until all operations, wrappers, packaged prompts and IPC paths are migrated together and the actual built CLI passes the integrated live test/fix/rerun gate. Provider interface probes and reference-policy tests are necessary preparation, not substitutes for that gate.

## Audit of the preparation implementation — 2026-10-23 UTC

Scope: runtime metadata/lockfile/CI, native smoke, baseline runner, representative contracts, live harness, regressions and retirement documentation. Existing unrelated production edits were preserved. Findings fixed during review:

| Priority | Finding | Fix and regression evidence |
| --- | --- | --- |
| P1 | The acceptance prototype could certify QA with a missing/negative blocker count; truthy non-booleans could satisfy resource/evidence gates, and duplicate host IDs made lookups ambiguous. | Validate host observations before policy decisions, require explicit boolean facts and zero blockers, reject ambiguous IDs and malformed requests. Ten additional contract tests exercise the invalid boundaries. This was isolated prototype code, not a production certification bypass. |
| P2 | The live harness allowed repeated provider entries beyond its reported bound, required both CLI versions even for a single-provider run, and started the turn timeout after the start acknowledgement. Failed spawn could leave shutdown waiting for an `exit` event that never occurs. | Reject duplicates, calculate selected dispatch bounds, probe selected versions only, start the deadline before dispatch, and await child `close` on both normal and failed startup. Offline child-process fixtures cover these cases and early correlated notifications. Claude tool observations are now checked on deliberate abort too. |
| P2 | The baseline continued after a failed build/typecheck, allowing later tests to consume stale outputs. Direct `pnpm` spawn also did not support the usual Windows command shim. | Stop on the first failure; invoke pnpm's JavaScript entry through the current Node runtime when run as a pnpm script. Real child failure fixture proves later tests do not run. Windows command construction is tested offline; native Windows execution remains a CI gate. |
| P2 | The release checklist omitted the new preflight suite. | Add `pnpm test:comms-preflight` to required release checks; the suite is also in the existing recovery CI matrix. |

Post-fix evidence: `/tmp/rafi-comms-audit/preflight-tests.log` has **60 passed, zero failed/skipped**; `/tmp/rafi-comms-audit/baseline/` records native smoke, workspace build/typecheck and **191 passed, zero failed/skipped**. Generated CLI docs and `git diff --check` passed. Both live profiles were rerun against the corrected harness: `/tmp/rf-e-8JtKU1` has all nine interface scenarios passing; `/tmp/rf-e-8Q9H2x` has all six representative contract scenarios passing. These runs include harness/support/contract hashes and actual provider versions in their ledgers.

Remaining gates at that historical audit: the 20 existing packaged resume failures above, unchanged supervisor startup timing sensitivity, the historical Node 22/24 cross-platform matrix (superseded by Node 24-only policy), and the production communication migration with integrated live release testing. This audit did not rerun the entire broad suite or claim those gates passed. The live probes remain small capability tests, not a reliability estimate.

## Current v2 authority and live gate

`pnpm check:comms-inventory` checks Node 24, script types, the reviewed compiler
inventory/descriptor baseline, and source versus packaged manifest parity.
Run it after the workspace build. Regenerate `registry-baseline.v2.json` with
`node --import tsx scripts/comms/registry-baseline.mts --write` only after reviewing
changed descriptor identities, authority owners, and source sites. Preserve
`registry-before-state.v2.json` as historical evidence.

All live entry points now require `RAFI_LIVE_STRUCTURED=1`, an explicit
`RAFI_LIVE_CREDENTIAL_SCOPE`, `RAFI_LIVE_RETAINED_LOG_DIRECTORY`, and a future
`RAFI_LIVE_DEADLINE` at most 30 minutes away. Select `RAFI_LIVE_PROVIDERS=claude`:
Codex fails before provider launch because no authoritative dollar meter is
available. Runners sharing the scope, deadline, and retained root share one $5
reservation ledger; CLI children inherit that ledger and deadline. Unknown
terminal spend blocks further queries. Keep the ledger and per-run reports with
the acceptance evidence; do not delete them to recover budget.

The capacity journey forces two native pages by default. Optional
`RAFI_LIVE_CAPACITY_FIXTURE` supplies a page or page array;
`RAFI_LIVE_CAPACITY_MAX_TICKETS` declares its aggregate ticket count. Each page
remains limited to 150 tickets/750 KiB, with 60 pages/6 MiB in total. Offline
fixture validation does not count as a live capacity result.
