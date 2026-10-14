# Rafi reliability follow-up validation — 2026-10-13

## Scope and safety

This follow-up used only temporary local Git fixtures. The live checks used the
locally built Rafi CLI with authenticated Claude Code 2.1.296 and Codex CLI
0.162.1, one provider at a time. No MoneyTree/MoneyFarm original, remote Git
repository, package registry, deployment target, commit, or push was changed.

## Provider/build results

| Scenario | Result | Evidence |
| --- | --- | --- |
| Claude current-branch one-ticket build | Pass | completed durable run; independent test verification; 28.863s total; first source change at 21.566s |
| Codex current-branch one-ticket build | Pass | completed durable run; independent test verification; 33.284s total; first source change at 21.454s |
| Claude branch + independent QA | Pass | completed branch record and `rafi status`; Builder and isolated QA sessions both reached terminal completion |

The first Claude canary did not expose a connection or timeout problem. Claude
changed the fixture, then stopped because it had changed the required test
command into `node --test ... 2>&1 | tail ...`; policy correctly denied the
wrapped command. The prior prompt said never to retry a denied action, so the
agent did not retry the exact safe required command. Rafi now explicitly tells
Builder and QA to retry the exact required-test command only when the denial
was caused by an added pipe, redirection, substitution, or wrapper. Other
denied actions remain non-retriable. The rerun completed.

The live canary harness now accepts an explicit sequential provider list and
stops a provider after the first failed sample. It also records a shutdown
signal and terminates its owned disposable child before exit. This prevents
parallel local load from being mistaken for a provider stall and avoids leaving
a fixture build running when the monitor is interrupted.

The observed Claude QA run did have one denied wrapped inspection command, but
it recovered through other allowed inspections and completed. QA has the same
exact-required-test retry instruction now.

## Ticket planning and recovery

The contextual ticket validation/recovery suite passed 23 tests. It confirms:

- unsupported state statuses and invalid/nonexistent future-work IDs are
  rejected before YAML/SQLite publication;
- invalid priority, missing required tests, and missing rollback notes get
  bounded correction attempts;
- a retained failed ticket-planning interview is selectable through
  `rafi plan:doctor` and can complete after correction;
- an unattended planner question is converted into a bounded correction
  request rather than blocking automation;
- read-only ticket inspection remains read-only; and
- status reads durable completed branch state without borrowing completion from
  unrelated retained runs.

This resolves the reported `future work item undefined does not exist` path
for newly generated proposals. A historical record created before this
contextual validation may still require a fresh corrected proposal; doctor
retains the session rather than blindly applying its stale proposal.

## Handoff acceptance and recovery tests

The strict acceptance protocol initially uncovered stale test fixtures, not a
production ownership regression. One scripted Codex fixture only recognized an
old exact prompt phrase; it now recognizes the protocol token and emits
`HANDOFF_ACCEPTED` first. The crash fixture incorrectly classified the newly
prefixed acceptance prompt as ordinary implementation work; it now identifies
the stable acceptance sentence anywhere in the prompt.

The handoff crash suite passes all 6 crash boundaries after those fixture
updates. The build-admission recovery suite was also rerun with the updated
scripted successor and completed its supervised/direct recovery paths. These
are local scripted-provider tests; the live Claude branch/QA pass exercises
fresh Builder/QA sessions but did not force a compaction/recovery handoff.

## Publish-gate timing

One isolated `ai-foreman prepublishOnly` baseline completed in **468.29s**
(461.59s offline test wall). That is consistent with the earlier 465.90s
post-optimization baseline and materially below the historical 1,373.13s
gate. The initial full run had two failing files caused by the stale handoff
fixtures described above; all other 1,095 tests passed (12 skipped). After the
fixture corrections, the complete rerun passed: **1,115 tests run, 1,103
passed, 12 skipped, zero failed files, 467.71s wall time**.

The slowest measured files were still QA-heavy scripted fixtures:

| File/partition | Time |
| --- | ---: |
| `qaGuidanceDelivery.test.ts:codex` | 266.3s |
| `qaGuidanceDelivery.test.ts:claude` | 262.9s |
| `qaRecovery.test.ts` | 261.3s |
| `qaPrebuildCallers.test.ts` | 136.8s |

Process evidence showed these jobs actively creating isolated Git/QA fixtures,
not waiting on a live provider. The gate runs the two provider-shaped guidance
partitions separately and uses four concurrent jobs; per-file elapsed time is
therefore not additive wall time. The remaining performance work is to profile
and reuse immutable fixture/Graph preparation where the test contract permits;
do not reduce the two provider partitions or the independent QA checks merely
to improve timing.

## Remaining limits

- The live sample is deliberately small: one current-branch build per provider
  and one Claude branch/QA build. It demonstrates these account/runtime
  versions can complete, not a statistical guarantee of provider reliability.
- No live forced compaction/recovery handoff was run in this pass. The strict
  protocol has local crash/recovery coverage and must still be sampled in a
  bounded disposable live recovery scenario.
- The full publish gate, focused handoff crash/build-admission, planning/doctor,
  read-only ticket, status, typecheck, documentation, and diff checks now pass
  on this checkout.
# 2026-10-14 follow-up: interruption recovery and full live matrix

`rafi resume` previously stopped at a raw assignment/source reconciliation JSON document after a machine sleep interrupted a build. The underlying safe repair mechanism already existed, but the user-facing resume path did not invoke it.

- Resume now automatically reconciles only an interrupted assignment response for work already in that build's saved approved scope.
- It retains the original response and source, never replays a Builder turn, and requires fresh QA.
- Any foreign, missing, or otherwise ambiguous work remains blocked with the Manager inspection/repair path; resume does not silently adopt it.

Live disposable canary matrix (all four completed, independently verified, with no timeout):

| Provider | Scenario | Elapsed |
| --- | --- | ---: |
| Claude | current/no-QA | 23.493 s |
| Claude | branch + independent QA | 51.823 s |
| Codex | current/no-QA | 148.055 s |
| Codex | branch + independent QA | 154.141 s |

Evidence: `/private/tmp/rafi-live-confidence-final-20261014.log` and `/var/folders/g1/wq3b58m917qdvtbjzqxr0n740000gn/T/rafi-live-build-stalls-e5xZH4/results.json`. Codex was slower but retained normal structured progress throughout; no stalled provider, timeout, or misleading elapsed-time failure was observed.

