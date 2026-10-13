# Rafi reliability implementation results

## October 13 audit follow-up

The subsequent audit identified four gaps in the original completion assessment. They are now addressed with additional regression coverage:

- Private dirty baselines include HEAD paths as well as current index/untracked paths, preserving staged deletion and rename semantics without modifying the user index.
- Create and ticket setup accept exact interview IDs from doctor recovery, reuse the original record, and complete it only through the workflow's successful completion path. Cancellation does not manufacture completion. Saved create answers remain available when re-entering its walkthrough.
- Status cannot borrow completion from an unrelated retained run, including a newer unmatched build entry in a shared log.
- Claude elapsed-only placeholders remain uncertain, duplicate placeholders are coalesced, and later definitive results retain call identity and resolve uncertainty. Other failure evidence takes precedence over elapsed-time text.

Focused checks cover all four gaps, plus actual setup:init/setup:update and create CLI recovery. Verification logs are retained at `/private/tmp/rafi-audit-fixes-{targeted,cli,cli-delta,publish-final,typecheck}.log`. The first broad CLI run encountered a process-cleanup timeout under concurrent fixture load; its isolated CLI rerun passed. This is recorded rather than treating the first run as clean.

Follow-up verification: 19 focused tests passed; the isolated CLI file passed all 6 tests, including exact create recovery. Workspace typechecks, package builds, generated docs, and whitespace checks passed. The broad Foreman rerun was **not green**: 1,107 tests, 1,081 passed, 12 skipped, six failed files, with severe multi-hour timing stalls (15,053.72 seconds overall). The bounded-concurrency CLI rerun also suffered prolonged provider-fixture stalls and was stopped rather than left running indefinitely. These broad results do not supersede the earlier successful gate, nor establish a new clean release gate. A stable-environment full gate rerun remains required; no behavioral coverage or production deadlines were weakened to hide the failures.

Completed offline implementation and verification on 2026-10-12, using Node 20.19.0. This follows the [Phase 0–2 findings](rafi-reliability-phase-0-2-findings.md).

## Issue-to-fix mapping

| Area | Implemented behavior | Verification |
| --- | --- | --- |
| Ticket reads blocked by legacy owner | Show, validate, and queue bypass publication-recovery writers and open non-migrating, query-only ticket state. Stack queue reads are also read-only; explicit remote refresh remains a mutation. Missing history is reported, never recreated by validation. | Legacy V3 remote-owner regression, unchanged durable database bytes, MoneyTree/MoneyFarm copy queues |
| Invalid ticket proposals | Catch extraction/schema/marker errors before terminating; request at most three response-only corrections. Required tests, rollback notes, priorities, and source references remain enforced. | Separate and combined invalid-field cases, valid one-turn control, exhausted correction, resumed correction |
| No planning recovery | Standard planning now retains durable sessions. `rafi plan:doctor` discovers the current project, lists sessions with ages, selects exact interviews, and resumes/revalidates before approval. Population records and recovery are retained too. | Doctor selection through actual scripted ticket correction and publication; exact interview IDs; noninteractive listing; CLI help |
| Manager requires build history | Project evidence includes setup presence, saved planning sessions, ticket queue/validation, and dirty paths. Partial installations can be discovered without a config file. Build controls still require real run/work identities. | Scripted CLI consultations for configured and partial projects with zero builds; project packet regressions |
| Claude failure spam | Correlate call IDs with original names and inputs; classify failure, timeout, cancellation, completion, and unknown outcomes; coalesce duplicate results. Ambiguous `TIME_ELAPSED` remains unknown. | Scripted SDK tool-use/result stream and activity suite |
| Dirty-work blocking | Interactive isolated-build choices and `--dirty-work preserve/include`; private Git index and baseline objects; preserved application files, index, and HEAD; retained worktrees; no automatic merge/review. Create supports explicit preimage capture. | Real supervised scripted builds for both modes, staged/unstaged/untracked sentinels, unborn repository capture, digest/index checks |
| Slow publish tests | Four isolated jobs, measured slow-job ordering, both QA-guidance provider shards, shared immutable package manifest, and a configurable watchdog deadline for the hung-worker fixture. No protected cases removed. | Complete `ai-foreman prepublishOnly` gate, all package suites, final process inventory |
| Misleading completed status / recovery commands | Read durable completion even without batch-end, select retained build IDs rather than audit IDs, use public `rafi start` branch recovery, and omit irrelevant review providers for completion-none. | Exact previously completed fixture, status regression, branch command tests |

Ownership is still enforced for writer admission and storage upgrades. Messages identify the saved writer/host and point to status, doctor, and stopping the owning build before retrying. Corrupt owner records remain blocked with preservation guidance.

Planning ownership/preimage capture now occurs at approved publication, preserving uninstall safety while avoiding install-manifest writes for failed proposals. A cancelled review is not treated as completed merely because its child process exits zero.

## Performance evidence

| Run | Tests | Passed | Existing skips | Failures | Test-gate wall time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Phase 0–2 serial baseline | 1,091 | 1,079 | 12 | 0 | 1,373.13 s — 22m53s |
| First four-lane run, before matrix partitioning | 1,098 | 1,086 | 12 | 0 | 663.95 s — 11m04s |
| Final four-lane, partitioned/scheduled gate | 1,099 | 1,087 | 12 | 0 | 465.90 s — 7m46s |

The final gate is approximately 66% shorter, or 2.95× faster, despite added regression cases. The complete prepublish command exited zero after its build, test, and typecheck stages. These timings describe measured local runs, not controlled cold/warm distributions or a tail-latency guarantee; some short development checks overlapped the final run.

The hung-worker case fell from 130.781 s to 6.755 s. It still launches the actual supervised CLI, stops the worker, verifies heartbeat-timeout termination, checks unresolved dispatch evidence, and verifies child cleanup. The production heartbeat timeout stays 120 seconds; the fixture explicitly configures five seconds and a one-second shutdown bound.

The formerly 520.4-second QA-guidance file ran as two complete scripted-provider partitions (261.9 s Claude and 266.6 s Codex). The runner always schedules both partitions. The 12 existing skips did not increase; no pattern-based artificial skips were introduced. Ordinary publish tests do not use AI models, so no model-default change was needed for this speedup.

## Checks and end-to-end evidence

- Final complete Foreman prepublish gate: 1,099 tests, 1,087 passed, 12 existing skips, zero failures; exit zero.
- Full Rafi CLI package suite: 283 tests, 280 passed, three existing skips, zero failures. Subsequent publication/help regressions: 12 passed; final planning/resume regressions: 39 passed, with later doctor checks also passing.
- Spec package: 48 passed. Special-agents package: 92 passed.
- All workspace package typechecks passed. Spec, agent, Foreman, and Rafi builds passed. Generated CLI documentation check and `git diff --check` passed.
- Dirty preserved/include supervised builds completed and left sentinel application contents and the original Git index unchanged.
- Both configured-project and partial-install Manager consultations completed through the CLI using a scripted Codex executable, with no fabricated build record.
- A fresh copy of the original completed-build fixture now reports durable completion instead of “still in progress.”
- MoneyTree and MoneyFarm copied-state queues now succeed. MoneyTree validation reaches its real legacy data issue: T001 is blocked with no saved prerequisite/reason. The error and queue now offer status/resume/prerequisite guidance rather than an owner-upgrade error.
- Copy comparison found durable application and Rafi files unchanged by ticket inspection. SQLite reader coordination changed one ticket SHM timestamp; this is not claimed as a byte-for-byte sidecar-preservation guarantee.
- Final process inventory found no new retained supervised/provider fixture processes. The pre-existing Oct 8 orphan, PID 88461, was preserved.

## Changed files and commands

Public workflow changes are documented in [reliability workflows](reliability-workflows.md), [CLI help](cli.md), the root README, and the unreleased changelog.

Key implementation files:

- Rafi: `src/planDoctor.ts`, `src/ticketPlan.ts`, `src/plan.ts`, and `src/index.ts`.
- Foreman inspection/storage: `src/cli/tickets.ts`, `src/tickets/{stateDb,commands,details,queue,validate}.ts`, `src/buildWorkMigration.ts`, and `src/interviews.ts`.
- Manager: `src/projectDiagnostics.ts`, `src/managerPacket.ts`, and `src/cli/manager.ts`.
- Provider/status: `src/adapters/claude.ts`, `src/activity.ts`, `src/cli/status.ts`, `src/cli/doctor.ts`, and `src/branch/resume.ts`.
- Preserved input: `src/branch/dirtyBaseline.ts` and `src/cli/start.ts`.
- Performance: `scripts/test-offline.mjs`, package test script, `src/supervisedStart.ts`, `src/recoveryPolicy.ts`, QA-guidance shards, and package-manifest reuse.
- Shared contracts: `packages/spec/src/{types,schemas}.ts` for optional project evidence, dirty baseline decisions, and heartbeat deadline configuration.
- New regression files: `ticketReadOnly.test.ts`, `claudeToolResults.test.ts`, `dirtyBaseline.test.ts`, `ticketPlanRecovery.test.ts`, and `prebuildManager.test.ts`, plus updated neighboring suites.

New or extended commands:

```sh
rafi plan:doctor
rafi manager
rafi create . --defaults --no-graph --dirty-work preserve
rafi start . --steps 1 --dirty-work preserve
rafi start . --steps 1 --dirty-work include
RAFI_TEST_CONCURRENCY=1 pnpm --filter ai-foreman test
```

Exact interview/session flags support recovery internally; users can use the flagless doctor. Existing commands remain available.

## Boundaries and remaining verification

- The exact Claude Enterprise `TIME_ELAPSED` payload still needs a sanitized live sample before assigning stronger semantics. Current reporting preserves uncertainty rather than declaring it harmless or successful.
- No live-account planning/build canary was run. Provider transport/account behavior remains an explicit later verification lane.
- Existing blocked tickets and MoneyFarm's canonical project identity still require legitimate recovery or prerequisite decisions before a new build. Reader access does not steal ownership or bypass state-transfer identity checks.
- Ignored files are not part of the private Git input snapshot. Dirty submodules and conflicts require explicit resolution; unborn repositories can use include mode without creating a user-branch commit. Recovery retains saved baseline decisions and preserved worktrees.
- The locally built source is updated. The global Rafi installation and package versions were not changed or published. To exercise this build explicitly, use Node 20 with `node /Users/tyler/reps/activeWork/rafi/packages/rafi/dist/index.js ...` from a disposable project or the intended project after review.

No original MoneyTree/MoneyFarm mutation, paid/live-provider invocation, package publishing, deployment, source commit, or push occurred during this implementation. Existing unrelated user changes were retained. Scratch-only Git commits and private baseline objects were used by the authorized tests.

## Retained evidence

Evidence root: `/private/tmp/rafi-reliability-fixes.JK1o7b`.

Final per-job TAP directory: `/var/folders/g1/wq3b58m917qdvtbjzqxr0n740000gn/T/rafi-offline-tests-rpnAnn`.

Baseline evidence remains at `/private/tmp/rafi-reliability-20261012.D7pNTp`. Implementation logs are copied into the evidence root. No material evidence cleanup was performed.
