# Rafi end-to-end confidence findings

Completed offline investigation pass — 2026-10-13. This report records the execution of
rafi-end-to-end-confidence-investigation-plan.md. It distinguishes verified
behavior, defects, fixture limitations, environment limits, and untested
live-provider behavior.

## Scope and safety

- Source under test: 86bc71c plus existing user work; local packages rebuilt
  with Node 20.19.0.
- Evidence root: /private/tmp/rafi-e2e-confidence.UzfbRC.
- All state-changing commands used disposable repositories below that root.
  MoneyTree and MoneyFarm originals were only read to create copies. No live
  provider, remote, publish, deployment, source commit, or push was used.
- The scripted Codex app-server fixture is
  reproductions/fake-codex.cjs under the evidence root. It cannot make a real
  provider or network call. Two fixture protocol mistakes were corrected
  during the run; those observations are not attributed to Rafi.

## Current confidence statement

One complete offline, scripted-Codex, current-checkout journey is verified:

    create → plan → tickets setup → tickets plan → start
          → explicit build:decide proceed → resume --yes
          → ticket completed → status all-done → application test passed

Final run: 47192dbf-d48b-472e-a983-060e30d4c373 in
fixtures/golden-codex-current-complete. Evidence is in
logs/current-complete-resume.log and logs/current-complete-status.log.

This is orchestration evidence, not a declaration that the normal user flow is
smooth: two P1 build-flow defects below block ordinary sequential/dirty
workflows. QA-enabled end-to-end and real-provider coverage remain open. The
complete offline ai-foreman gate passed after this journey (details below);
that proves the regression suite under controlled concurrency, not QA behavior
in an actual provider-backed build.

## Findings

| ID | Severity | Status | Finding |
| --- | --- | --- | --- |
| E2E-001 | P1 | Confirmed | A normal fresh create → plan → ticket setup → tickets plan → start journey stops because Rafi-generated files are uncommitted. |
| E2E-002 | P1 | Confirmed | Dirty isolated branch build can remain verified-live after it asks for a decision, blocking the advertised resume. |
| E2E-003 | P1 | Confirmed | A clean current-mode CLI override can resume as branch mode and fail because no branch session exists. |
| E2E-004 | P2 | Environment | Rafi safely refuses readiness when process inventory is unavailable; sandboxed invocation therefore cannot progress without visibility. |
| E2E-005 | P2 | Confirmed | --yes does not waive the Builder plan-review decision. This may be intentional, but the noninteractive path needs clearer up-front disclosure or a deliberate automation policy. |
| E2E-006 | P2 | Not reproduced; performance risk | Historic multi-hour stalls did not reproduce in controlled one- and two-lane runs. The full gate passed, but several QA suites remain unusually slow. Cause of the historic stalls remains unresolved. |
| E2E-007 | P3 | Confirmed | MoneyTree/MoneyFarm ticket reads no longer fail on build-owner admission; remaining validation failures are blocked-ticket data. |

### E2E-001 — generated setup blocks ordinary start

Reproduction: From a clean app, run create with defaults, plan, ticket setup,
and tickets plan. Immediately run the next command Rafi prints: start with one
step.

Observed: start exits 1 and lists Rafi-generated uncommitted files (.agents,
.codex, .rafi, .tickets, docs, and config), then suggests dirty-work preserve
or include.

Impact: the normal sequential onboarding path cannot start without committing
or making another dirty-work decision. The generated next command is not
directly runnable.

Resolution direction: carry an explicit Rafi-generated setup-preimage receipt
from create/plan/ticket publication into start, offer preservation at the
handoff, or print an exact next command with the needed safe policy. Never
silently treat arbitrary user files as Rafi-owned.

Evidence: logs/golden-codex-start.log.

### E2E-002 — dirty branch decision leaves a live owner

Reproduction: use the E2E-001 fixture and run start with dirty-work preserve
and yes. Rafi forces branch-per-ticket, asks Proceed, and prints build:decide
plus resume. Record proceed, then invoke resume.

Observed: resume says the original process is verified live and must be
returned to or stopped. The noninteractive original remains alive and does not
consume the recorded decision. The disposable process had to be gracefully
terminated for cleanup.

Impact: a safe dirty-work workflow deadlocks at the first branch decision.

Resolution direction: the waiting noninteractive process must exit after a
durable pause, poll and consume the recorded decision, or have a separate,
explicit automation policy. Preserve the competing-writer invariant.

Evidence: logs/golden-preserve-start.log, golden-preserve-decide.log,
golden-preserve-resume.log, and
processes/golden-preserve-owner-deadlock.txt.

### E2E-003 — current-mode override is lost at resume

Reproduction: with saved branch-per-ticket defaults, run start with
--no-branch-per-ticket and no dirty-work mode. Approve the Builder plan, then
resume with yes.

Observed: initial start used current mode, but recovery invoked branch mode
continue and failed because no resumable branch ticket session existed.

Scope: dirty-work preserve/include deliberately force isolated branches. This
finding concerns a clean CLI current-mode override being recomputed from
project defaults during recovery.

Resolution direction: freeze and restore resolved per-run work mode from the
build receipt, rather than recomputing it from project defaults on resume.
Add an integration regression covering saved branch default, current override,
plan-review pause, and resume.

Evidence: logs/current-clean-build-start.log, current-clean-build-resume.log,
and current-clean-build-resume-yes.log.

### E2E-004 — process-visibility safety stop

Under the restricted sandbox, ps returns EPERM. Create paused before provider
work with: Standalone probe cleanup is unverified; restore process visibility
and retry. It supplied platform-specific recovery guidance.

Assessment: correct fail-closed safety behavior, not a product defect. Tests
that require process lifecycle evidence must run where process inspection is
permitted.

Evidence: logs/golden-codex-create.log.

### E2E-005 — noninteractive yes still requires plan approval

Start with yes creates a durable waiting-for-human decision and exits 2. After
build:decide proceed, recovery asks for resume --yes. The clean current-mode
sequence completes after that decision/resume, so the state machine is sound.
The experience is still surprising because the command help says yes skips
preflight confirmation. The generated next step should disclose the full
approval/resume sequence earlier, or expose a distinct explicit flag.

### E2E-006 — historic stalls and current duration profile

Historic logs showed 30-second test deadlines with elapsed wall time from
17 to 55 minutes. Controlled one-lane reruns passed:

- supervisedStart.test.ts: 18/18 in 60.47 seconds.
- runtimeReadiness081.test.ts plus buildAdmission.test.ts: 49 passed, one
  platform skip, in 80.41 seconds.

They exercised detached starts, crash/cancel, competing owners, hung workers,
inherited/redirected descendants, process tagging, legacy owners, and actual
supervised/direct/detached recovery. No unexplained stall appeared under this
load.

The complete ai-foreman offline gate passed at controlled concurrency two:
1,095 passed, 12 skipped, zero failed files, wall time 717.93 seconds. The
slowest independent files were qaRecovery (218.24 seconds), QA guidance for
Codex (212.94 seconds), QA guidance for Claude (210.29 seconds),
qaPrebuildCallers (108.66 seconds), and foreman (79.37 seconds).

The exact `prepublishOnly` wrapper then passed at its default controlled
concurrency four: the same 1,095 passed and 12 skipped, zero failed files,
and 443.09 seconds wall time. Four lanes improved total wall time by 274.84
seconds (38.3%), but made the three heaviest QA files slower individually:
Codex guidance 254.49 seconds, Claude guidance 250.54 seconds, and recovery
250.54 seconds. This demonstrates useful parallelism plus measurable resource
contention, not a remedy for the slow files themselves. The observed workers
remained CPU-active and advanced through their local Git/worktree fixtures;
there was no no-progress timeout or orphan cleanup failure.

These are real test-duration costs, not a failure, and explain much of the
publish-gate latency even though they are far below the historic 17–55 minute
overruns.

This does not establish the prior cause. Controlled repeated lane-count runs
with CPU, memory, process, and host-sleep evidence are still required before
attributing those earlier multi-hour timeouts to Rafi or declaring the stall
problem fixed.

Evidence: logs/ai-foreman-full-concurrency2.log and
logs/ai-foreman-prepublishOnly.log.

### E2E-007 — MoneyTree and MoneyFarm readers

Full filesystem copies of both targets were used. Tickets queue exited zero
for each and the durable ticket-state SQLite SHA-256 was unchanged before and
after reads. The prior build-owner admission error no longer blocks queue
inspection.

Show without a ticket ID intentionally returned usage. `tickets show --all`
then completed against both copies without altering their ticket SQLite
hashes. Validate correctly exited nonzero because T001 is blocked without a
saved blocker/reason in each copy. Output now gives public
status/resume/block guidance. This is target data, not an owner/migration
issue.

Evidence: logs/moneyTree-* and logs/moneyFarm-*; matching SQLite hashes are
under snapshots.

## Verified planning, recovery, and Manager behavior

- Actual CLI ticket planning repaired one response containing all three
  reported defects: unsupported priority, empty required_tests, and missing
  Medium-risk rollback. It performed one response-only correction and
  published valid tickets. Evidence: logs/ticket-repair-actual-cli.log.
- Repeated invalid output stopped after three corrections, retained its exact
  session, explained plan:doctor, and flagless doctor listed the session with
  age, cause, and recovery command. Evidence:
  logs/ticket-doctor-failure.log and ticket-doctor-list.log.
- Targeted regression suite: 37 passed, 0 failed. It covers structured-plan
  repair/exhaustion, all three ticket defects and combined case, doctor
  recovery, pre-build Manager, Claude activity classification, and dirty
  baseline semantics. Evidence: logs/planning-manager-dirty-targeted.tap.
- Actual project-level Manager worked before a build and reported zero retained
  runs. The scripted response proves plumbing/project-evidence access, not
  advice quality. Evidence: logs/golden-codex-manager-prebuild.log.

## Regression and publication-oriented checks

- Source build: all four packages passed with Node 20.19.0 in 5.7 seconds.
- Targeted planner/Manager/dirty/Claude tests: 37 passed, zero failed.
- Targeted QA tests: 19 passed, zero failed, 15.3 seconds.
- Supervised-start isolation: 18 passed, zero failed, 60.47 seconds.
- Readiness/admission isolation: 49 passed, one platform skip, 80.41 seconds.
- Full `ai-foreman` offline gate: 1,095 passed, 12 skipped, zero failed
  files, 717.93 seconds at `RAFI_TEST_CONCURRENCY=2`.
- Exact `ai-foreman prepublishOnly`: passed with the same test totals, plus
  production build/typecheck, in 443.09 seconds at its default four lanes.
- Full CLI suite: 35 passed, zero failed. Evidence: logs/rafi-cli-full.tap.
- `rafi-spec`: 48 passed, zero failed. Evidence: logs/spec-full.tap.
- `special-agents`: 92 passed, zero failed.
- Recursive TypeScript typecheck and generated-document check both passed.

No publish action was attempted; `prepublishOnly` only performed its local
build, test, and typecheck steps.

## Open verification

1. Implement and regress E2E-001 through E2E-003 before calling build flow
   reliable.
2. Run a QA-enabled offline full lifecycle with meaningful QA protocol output.
3. Diagnose historic stalls with bounded repeated one/two/four-lane runs and
   host sleep/resource evidence; do not rely on earlier green reruns.
4. With explicit authorization, run bounded real Claude and Codex canaries,
   including the Enterprise TIME_ELAPSED symptom. No live provider was called.

## Coverage limits of this investigation pass

The following plan lanes were deliberately not represented as completed. They
are not evidence of success and should be carried into the next pass:

- The successful full journey used the scripted Codex adapter only. The second
  adapter and an installed-package consumer were not run end to end.
- QA behavior passed targeted and full-suite tests, but the fake Builder did
  not produce a meaningful QA-protocol handoff for a complete QA-enabled
  lifecycle.
- MoneyTree and MoneyFarm were exercised only as copied stateful ticket
  readers, not fresh applications or full multi-ticket builds. Their originals
  were not mutated.
- The synthetic six-to-ten and twenty-to-thirty ticket graphs, deliberate QA
  failure/remediation, concurrent start race, and full dirty-state matrix were
  not run in this pass.
- The performance comparison contains one controlled two-lane and one
  controlled four-lane sample after isolated one-lane files; it is not the
  three-repeat one/two/four-lane distribution requested by the plan.
- No real account, Enterprise Claude, actual network provider, or live tool
  execution was used. The TIME_ELAPSED activity-reporting fix has regression
  coverage and scripted evidence only.

The evidence harness, copied fixtures, precise run IDs, logs, and snapshots
are retained under the evidence root so the next investigator can extend these
lanes without reusing or changing the original external repositories.
