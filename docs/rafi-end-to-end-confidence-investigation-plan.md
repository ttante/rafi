# Rafi end-to-end confidence investigation

Prepared 2026-10-13. This is an execution assignment for an agent, not a proposal to write another plan. Exercise Rafi as a user would, observe its real process/state boundaries, diagnose every unexpected result, and establish precisely which lifecycle and provider combinations are reliable.

## Copy-paste kickoff

```text
Execute /Users/tyler/reps/activeWork/rafi/docs/rafi-end-to-end-confidence-investigation-plan.md.

Rafi source: /Users/tyler/reps/activeWork/rafi
Targets: locate MoneyTree and MoneyFarm within /Users/tyler/reps/activeWork;
verify their exact paths before using them. Originals are read-only.
Scope: comprehensive selected-mode lifecycle, failure/recovery, agent-connection,
dirty-worktree, planning, build, QA, packaging, and performance investigation.
Execution profile: [offline-only | online-only | both] (default: offline-only).
Provider selection: [Claude-only | Codex-only | both] (default: both).
For any online selection, explicitly authorize the exact provider/account/model,
maximum calls/time/cost or quota, and permitted operations below.
Remote actions, package publishing, deployment, source commits/pushes,
original-target mutation, and destructive cleanup are not authorized.

Begin with inventory and disposable fixtures. Actually run the locally built
Rafi CLI through create → plan → tickets → build → QA → completion. For each
selected provider, use the selected execution mode's adapter(s): scripted
offline adapter, authorized online provider, or both. Do not substitute unit
tests for lifecycle evidence.
At every unexpected result, pause that scenario, preserve evidence, reproduce,
trace the exact cause, and document the narrowest safe resolution. Continue
independent scenarios while genuinely blocked. Do not declare unexplained
timeouts to be host/provider issues or waive them because a rerun passed.

This kickoff authorizes investigation, diagnostic harnesses, and reproduction
tests in Rafi, not production fixes. For each confirmed defect, identify the
fix and regression test; request approval before implementing production fixes.
If I explicitly authorize fixes later, use the repair protocol in the plan.

Maintain a resumable evidence manifest and scenario ledger. Report progress
and blockers concisely. Finish with tested/not-tested coverage, exact causes,
recommended fixes, measured timing, preservation proof, and remaining risks.
```

Optional additions to the kickoff:

```text
Execution profile: [offline-only | online-only | both].
Provider selection: [Claude-only | Codex-only | both].
Production fixes: authorized for reproduced Rafi defects, with regression tests.
Online providers: [for each selected online provider: exact account class,
account identifier or safe label, model/version if selectable, and approved operations].
Online limits: [maximum wall time, calls, token/cost/quota bounds, stop conditions].
Online concurrency: one run unless explicitly approved otherwise.
```

`offline-only` uses no live calls. `online-only` runs real-provider scenarios
for only the selected provider(s), while still performing local safety and
state inspection; it does not silently run the unselected offline matrix.
`both` runs the selected providers in scripted and online modes, keeping their
evidence and conclusions separate. Omitted online approval means no online
calls, even when credentials are installed. Subscription/Enterprise access is
still online-provider use. Never infer permission from installed credentials.

## 0. Execution profile and provider matrix

Resolve the requested profile before executing provider-backed scenarios and
record it in `run-manifest.md`, `coverage.md`, every scenario record, and the
final report. “Online” means a real Claude or Codex account/transport may be
contacted; “offline” means a fail-closed scripted adapter with no network or
credential fallback.

| Requested execution profile | Claude-only | Codex-only | Both providers |
| --- | --- | --- | --- |
| **offline-only** | Scripted Claude matrix only | Scripted Codex matrix only | Scripted Claude and Codex matrices |
| **online-only** | Authorized live Claude matrix only | Authorized live Codex matrix only | Separate authorized live matrices for Claude and Codex |
| **both** | Scripted + authorized live Claude matrices | Scripted + authorized live Codex matrices | Scripted + authorized live matrices for each provider |

Do not treat results from Claude as evidence for Codex, or vice versa. Do not
combine offline and online pass counts. Provider-independent checks (state,
ownership, dirty worktree, docs, deterministic package tests) always remain in
scope unless explicitly excluded, but label them `provider-independent`.

For an online-only investigation, run a small local harness smoke check first:
verify exact CLI version, selected executable/transport, account authorization
boundary, evidence redaction, timeout monitor, and that no publish/deploy/remote
Git action is reachable. This is not an offline lifecycle substitute; mark
offline coverage `not run by requested profile`.

Before each online scenario, verify the selected provider and account match the
approved matrix, then record the model/version when exposed. If authorization,
identity, model, quota, or permitted operation cannot be verified, block that
provider scenario rather than falling back to another provider or account.

## 1. Objective and truth standard

Establish that a fresh user can onboard, plan, generate valid actionable tickets, start a build, pass independent QA, and obtain correctly reported completion without unexplained failures. Establish that interruptions and invalid output are safely recoverable, dirty work has an explicit continuation path, and provider activity reflects reality.

Confidence must be based on repeatable CLI journeys and inspectable artifacts, not the number of passing unit tests. Each phase transition must be evidenced. Every discovered issue must have a confirmed cause and resolution, or an explicit unresolved status with the missing evidence and next experiment. Do not promise to identify every possible bug or prove zero failures from a finite sample.

Use these result classes:

- **Pass:** all assertions and preservation checks succeeded.
- **Fail:** a contract was violated, even if later recovery succeeded.
- **Blocked:** a prerequisite or authorization is missing; record exactly which.
- **Inconclusive:** execution or observation cannot distinguish competing explanations.
- **Not applicable:** justified by the supported workflow, never a substitute for a difficult test.

A recovered build is a recovery success, not a first-attempt success. A heartbeat is liveness evidence, not proof of useful work. Exit zero alone does not prove approval, ticket publication, QA success, delivery, or durable completion.

## 2. Read first and reconcile current state

Read applicable ancestor and nested `AGENTS.md` and other repository instructions. Then read:

1. `docs/rafi-reliability-phase-0-2-findings.md`.
2. `docs/rafi-reliability-investigation-and-remediation-plan.md`.
3. `docs/rafi-field-test-playbook.md`.
4. `docs/rafi-reliability-implementation-results.md`.
5. `docs/reliability-workflows.md` and relevant `docs/cli.md` sections.
6. Existing stall, QA handback, and stop-investigation reports when the observed failure touches those boundaries.

Historical evidence, if still present:

- `/private/tmp/rafi-reliability-20261012.D7pNTp/run-manifest.md`.
- `/private/tmp/rafi-reliability-fixes.JK1o7b`.
- `/private/tmp/rafi-audit-fixes-targeted.log`.
- `/private/tmp/rafi-audit-fixes-cli.log` and `rafi-audit-fixes-cli-delta.log`.
- `/private/tmp/rafi-audit-fixes-cli-final.log`.
- `/private/tmp/rafi-audit-fixes-publish-final.log`.
- Prior failing TAP directory `rafi-offline-tests-dPK2cA` under the platform temporary root, if retained.

Missing historical artifacts are a limitation, not a reason to invent results. Record current revision, worktree changes, and implementation differences; previous reports may describe a different revision.

### Known unresolved evidence to prioritize

The earlier complete offline publish gate improved from 1,373.13 s to 465.90 s. The later audit gate failed: 1,107 tests, 1,081 passed, 12 skipped, six failed files, and 15,053.72 s wall time. A later CLI suite also stalled and was stopped. These are not a clean current release gate.

Affected Foreman files included `qaGuidanceDelivery.test.ts` in both provider partitions, `buildAdmission.test.ts`, `graphAccessBoundaries.test.ts`, `runtimeReadiness081.test.ts`, and `supervisedStart.test.ts`. CLI symptoms included packaged readiness/resume and partial-install Manager fixtures. Some nominally short tests reported 17–55 minute durations. Host suspension, contention, blocked process/IPC fixtures, clock behavior, and production defects were not distinguished. There is no established “server stall” explanation, and these tests used local scripted providers rather than a live AI server.

## 3. Safety and authority contract

- Preserve existing Rafi source changes and untracked files. Inspect status first; do not reset or clean.
- Never run state-changing commands in original MoneyTree/MoneyFarm. Even supposedly read-only commands must first be verified in a disposable copy.
- No online AI, external Git, review creation, publishing, deployment, or credential changes without explicit permission.
- Build/test commands named `prepublishOnly` may be run after inspecting their contents; do not run `publish` or release automation.
- Fixture scripts must not fall through to real providers. Isolate PATH, use explicit fake binaries/adapters, reject unexpected invocation, and prove which executable ran.
- Use local temporary repos with no remote, disabled application network integrations, and inert deployment/publish scripts. Inspect copied hooks, automation, and application test commands before executing them.
- Never copy active SQLite files blindly. Inspect owners first; use supported coherent snapshot methods or obtain permission to stop the writer. An unverifiable owner is not dead merely because its heartbeat is old.
- Never change canonical project IDs or owner rows ad hoc to make copied state pass. Investigate supported transfer/recovery paths; retain unchanged copies as controls.
- Snapshot modes, symlink targets, index, HEAD, staged/unstaged differences, untracked bytes, relevant ignored inputs, and durable Rafi state. SQLite reader sidecars need separate interpretation from durable state.
- Terminate only verified descendants belonging to the current scenario, with graceful shutdown first. Inspect PID start identity before escalation; preserve unrelated processes.
- Keep evidence until accepted. Cleanup requires explicit targets and authorization; never broad recursive deletion.
- Apply the Graphify trigger gate only when a qualifying investigation actually needs graph assistance. Ordinary test execution requires no scan.

## 4. Execution order and checkpoints

1. Inventory and pin the source CLI, runtime, fixtures, and safety boundaries.
2. Diagnose the previous local stalls before another broad concurrent gate.
3. Complete one pristine lifecycle with the first adapter selected by the execution profile.
4. Complete the same lifecycle for each remaining selected provider/mode and with the packaged CLI.
5. Expand planning/recovery, dirty state, owner admission, Manager, and fault matrices.
6. Run realistic MoneyTree/MoneyFarm copies and multi-ticket builds.
7. Repeat passing scenarios; run controlled performance/concurrency experiments.
8. Run or request bounded online-provider verification according to the selected execution profile.
9. Run final package suites/builds/docs/publish gates and report remaining limits.

After each checkpoint update the manifest, scenario ledger, finding ledger, coverage map, and exact next command. Resume from those artifacts rather than starting over. Do not repeatedly rerun an unexplained failure hoping for green.

## 5. Harness and evidence requirements

Create a task-specific evidence directory with `mktemp -d`. Record its absolute path in a Markdown run manifest. Keep raw private artifacts outside tracked source; sanitize shared reports.

Minimum artifacts:

```text
run-manifest.md          # revision, authority, environment, fixtures, checkpoints
scenarios.jsonl          # exact command/result/assertion records
findings.md              # severity, cause, reproduction, fix, regression
coverage.md              # lifecycle/provider/fixture matrix, untested cells
timings.csv              # wall, monotonic, CPU, phase, concurrency, outcome
processes/              # parent/child inventory and shutdown evidence
logs/                   # timestamped stdout/stderr and sanitized event streams
snapshots/              # pre/post manifests and coherent state snapshots
reproductions/          # minimal fixtures and scripted provider behavior
```

Record per command: scenario ID; fixture identity; CLI path/hash; cwd; exact sanitized arguments; interactive/noninteractive mode; start/end UTC; monotonic elapsed; exit code/signal; deadline; process tree; provider executable/account class; observed lifecycle transitions; before/after state; expected versus actual; recovery guidance; evidence paths.

Implement a bounded command monitor, not just a shell timeout:

- Timestamp output, retaining stderr separately; protect credentials and prompt contents.
- Sample owned process tree, CPU/memory, current phase, latest useful event, and heartbeat at a modest interval (e.g. 5–10 s).
- Record wall clock alongside monotonic time and available host uptime/sleep evidence. A monitoring gap must remain visible.
- Set per-phase deadlines before execution from existing contracts/baselines. Record the distinction between overall, no-progress, readiness, tool, and cleanup deadlines.
- On a soft deadline, capture diagnostic evidence before stopping. On a hard deadline, gracefully stop owned processes, verify cleanup, and mark incomplete/uncertain remote work accurately.
- Keep the outer monitor outside Rafi's child group so fixture failure cannot destroy its observer. Never indiscriminately kill every Node/Claude/Codex process.
- Test the monitor itself against a fast success, hung child, silent child, noisy heartbeat with no progress, child ignoring shutdown, and clock-gap case.

Capture child invocation and structured events at the actual adapter boundary. Do not treat a direct call to a mocked internal function as an end-to-end provider test.

### Pin the command under test

Inspect declared runtime requirements; the previous checks used Node 20.19.0. Record the actual Node and pnpm paths/versions rather than relying on ambient PATH.

```sh
pnpm -r build
node /Users/tyler/reps/activeWork/rafi/packages/rafi/dist/index.js --version
node /Users/tyler/reps/activeWork/rafi/packages/rafi/dist/index.js --help
```

Use this absolute built CLI from fixture cwd. Discover exact supported commands/flags through help; do not invent recovery commands or silently substitute internal Foreman commands for user-facing Rafi. Rebuild after source changes. Test global installed versions separately and label them; never confuse them with the local build.

## 6. Fixture inventory

Provision independent instances from immutable seeds, not a single increasingly repaired repo:

| Seed | Purpose |
| --- | --- |
| Tiny clean app with deterministic tests | Complete onboarding and one-ticket lifecycle with inspectable changes |
| Same app with no commits | Unborn Git and onboarding/baseline edge cases |
| Fresh MoneyTree application copy | Realistic clean onboarding and planning |
| Stateful MoneyTree replica | Legacy read-only owner error and legitimate subsequent admission |
| Fresh MoneyFarm application copy | Clean planning and dependency/build behavior |
| Stateful MoneyFarm replica | Existing tickets, canonical-root transfer, start/recovery |
| Dirty sentinels | Staged/unstaged/untracked/deleted/renamed files and overlap preservation |
| Synthetic old/corrupt state | Owner/migration/publication/recovery boundaries |
| Installed package consumer | Packaged CLI, adapter/assets/dependencies, launch/resume compatibility |

Retain copied Rafi state in stateful fixtures. Remove only enumerated Rafi-generated artifacts in clean-room fixtures, preserving application source/instructions. Preserve symlinks and Git metadata as required. Document every exclusion, including dependencies and secrets. Do not blindly reuse absolute configuration paths pointing back at originals.

Use scratch-only Git commits if fixtures require history; record them and never commit the original or source checkout. Verify originals' manifests after provisioning and at completion.

## 7. First investigation: unexplained stalls and cleanup failures

Before a full gate:

1. Extract historical failing test names, phase, stack, timeout/deadline, child PID, and timing. Build an event timeline, including output gaps.
2. Read the runner and affected fixture readiness/shutdown logic. Identify every real wait, retry, subprocess, pipe, PTY, process-group scan, and lock.
3. Run a known short fixture and each failing case individually under the monitor, one lane initially. Include a positive control with the same launch/cleanup path.
4. If isolated tests pass, repeat fixed-count runs and increase to two then four lanes. Change one variable at a time; record CPU/RSS, process counts, readiness latency, and cleanup latency.
5. Compare a stable awake host run with observed clock/monitor gaps. Inspect available local sleep/wake/resource evidence read-only; ask if access is unavailable. Do not deliberately alter power settings without approval.
6. Inspect inherited pipes and grandchildren, blocked IPC, adapter readiness/auth probes, async handles, stale leases, SQLite contention, retry loops, and orphan process inventory.
7. Separate actual useful execution time from suspension/gaps, CPU contention, intentional waits, and unexplained time. Report uncertainty if historical evidence is insufficient.
8. Reduce every reproducible hang to a bounded fixture. Ensure the outer watchdog captures the waiting phase and process tree and exits reliably.

Acceptance: a causal explanation supported by measurements or a reproducible failing fixture with an explicitly unresolved cause. An isolated green rerun does not close the original finding. Do not extend production timeouts, remove assertions, increase skips, or lower concurrency and claim root cause without evidence.

## 8. Golden journey: fresh create → plan → tickets → build

Run the entire sequence from the same pristine fixture, without manually injecting valid intermediate files. Start with one small, concrete change and deterministic application tests. Use real scripted-adapter CLI invocations for planning, Builder, and QA.

At every boundary inspect the resulting durable state and public status:

1. **Create:** begin at the actual public command `rafi create .`; exercise interactive choices and noninteractive defaults; chosen runtime; generated files/config; no hidden dependency on a build; safe repeat invocation.
2. **Plan:** clarifications and saved answers; valid final plan; stable session identity; source provenance; cancellation and explicit approval semantics.
3. **Tickets:** actual ticket planning from that plan; required tests, priorities, risks, rollback notes, dependency graph, source references; validate/show/queue agree; approval publishes exactly once.
4. **Manager:** consult before build; ask about plan validity and queue readiness; no fabricated build or inappropriate build controls.
5. **Start:** after the same fresh `create . → plan → tickets` journey, run a multi-ticket public start as `rafi start . --steps 2` (using only supported needed noninteractive/approval inputs). Preflight verifies prerequisites before expensive dispatch; records baseline, owner, run and work identities; clean start reaches first real Builder action and both selected steps have correct durable state.
6. **Builder:** scripted provider makes the intended application change through supported tools; logs identify the actual provider call and branch/worktree.
7. **QA:** independent evidence checks intended behavior and tests; one deliberate failed QA/remediation journey and one clean journey; passing output alone cannot bypass failed checks.
8. **Completion:** ticket/work/run states agree; completed build is not still running; delivery location is clear; no automatic remote action; owned child cleanup verified.
9. **Reopen:** new CLI process reads durable completion correctly, queue/status/Manager remain consistent, and a later run does not inherit unrelated completion.

Run each adapter/provider mode selected in the execution profile, TTY and non-TTY critical interactions, then packaged CLI. Save transcript and artifact lineage connecting create session → plan → tickets → run → QA → completion. A flag such as `--steps 1` may stop early; never label such a run complete unless durable completion actually occurred.

Repeat each selected provider journey at least three times from fresh seeds, subject to the approved online quota. Diagnose any flake before increasing breadth.

## 9. Planning validation and doctor matrix

Generate responses through scripted providers, not only direct validator calls:

| Case | Required behavior |
| --- | --- |
| Valid first response | One successful proposal, no unnecessary repair |
| Empty `required_tests` | Bounded correction before final validation; meaningful tests retained |
| Missing medium/high-risk mitigation | Correction supplies substantive notes; risk not silently downgraded |
| Unsupported priority | Correction uses allowed value without silently losing intent |
| All three defects together | Combined issues reach correction and successful validation |
| Broken JSON/markers/schema | Actionable bounded correction, original response retained |
| Repeated invalid output | Stops with saved recoverable session and public doctor guidance |
| Undefined/nonexistent future-work disposition | Reject before any publication, preserve the ticket-planning session and exact proposal/error, identify whether the fault belongs to proposal validation, ticket application, or recovery, and offer a usable recovery path |
| Provider exits/timeouts mid-response | No partial publication; uncertainty and recovery recorded |
| User cancels correction/review | Original unfinished session remains recoverable; no false completion |
| Conflicting IDs/dependencies/source refs | Reject or correct safely; do not weaken provenance or graph checks |
| Stale sources while resuming | Explain mismatch and supported revalidation/regeneration |

Exercise flagless `rafi plan:doctor` with zero, one, and multiple failed sessions; age/context labels; exact selection; cancellation; non-TTY listing; interrupted repair; repeated recovery; create/setup/plan/ticket workflows where supported. For a failure at ticket application (including a future-work reference that is undefined or no longer exists), prove whether `plan:doctor` can actually resume it. If its scope is insufficient, evaluate a flagless `rafi tickets:doctor` / `rafi tickets doctor` recovery surface: it must discover retained ticket-population sessions, explain the failed application in plain language, revalidate against current state, and avoid duplicate publication. Preserve compatibility by retaining `plan:doctor` or making a documented alias; do not add a second command merely to hide an unrepairable state.

Assert exact original interview identity is reused, saved answers preserved, successful completion recorded by the workflow rather than parent exit code, and completed sessions are not offered as unfinished. Verify no duplicate tickets, overwrites of approved work, or orphaned session chain.

For an impossible proposal, preserving it and explaining recovery is success; inventing tests/mitigation that do not satisfy the actual plan is not. Evaluate ticket quality as well as schema validity.

## 10. Agent connection and activity matrix

Test each selected Claude and/or Codex transport in its selected offline and/or online mode, with explicit command identity and event evidence. Separate launch/auth readiness, dispatch acknowledgement, token/tool progress, final response, shutdown, and durable state publication.

Inject:

- Missing executable, bad executable permissions, bad version, failed auth probe, and incompatible readiness output.
- Slow startup, silence, truncated output, invalid event JSON, unexpected event types, and oversized/repeated output.
- Provider process crash before/after dispatch and after side effects but before final acknowledgement.
- Tool success, genuine failure, timeout, cancellation, recovery, and unknown completion.
- Claude call IDs/names/inputs, interleaved calls, duplicate results, bare `TIME_ELAPSED`, elapsed text plus definitive failure, and unknown followed by a definitive result.
- Provider disconnect/reconnect and retry only where the transport supports it; otherwise test process failure/relaunch semantics honestly.
- Interrupt during planning, Builder tools, QA, and finalization; ensure uncertain work is reconciled, not blindly replayed.

Assertions: call identity preserved; wrong call never receives another result; unknown is not mislabeled success/failure; later definitive evidence resolves uncertainty; repeated placeholders are non-spammy; raw evidence remains available; retries bounded; no duplicate side effects; provider children are accounted for; user receives one understandable next action.

If online Claude testing is selected and approved, obtain sanitized samples from the actual Claude Enterprise symptom. Compare personal Claude only if separately authorized; record runtime/account/model/version and avoid attributing differences to account type from a single sample. Do not fabricate a 429/network test if that transport does not expose it.

## 11. Uncommitted-work continuation matrix

Run create, plan, ticket planning, start, resume, and completion on independent dirty fixtures. Exercise both explicit preservation and inclusion policies plus interactive stop/cancel.

Include staged-only, unstaged-only, partially staged, untracked, staged deletion, staged rename, executable-mode changes, symlinks, ignored required inputs, conflicting changes, dirty submodules, unborn repositories, and changes overlapping the intended ticket.

For each case define expected input semantics before running:

- **Preserve:** original work remains untouched; isolated build input and retained work location are clear.
- **Include:** current supported application changes become explicit build input, including correct deletion/rename semantics; user index/HEAD remain unchanged.
- **Unsupported/unsafe:** explain why, offer an isolation alternative where possible, and stop without loss.

Ignored files, conflicts, and submodules may have documented limitations. Test them rather than promising blanket support. If required ignored input is omitted, identify that limitation and a safe remedy.

Compare original fixture index bytes, HEAD/refs, sentinel contents, modes, symlink targets, staged/unstaged diffs, and untracked files after success, failure, cancellation, and resume. Verify no automatic stash/reset/clean/commit and no unsafe merge into the user checkout. Dirty work must have a clear safe continuation path, not a blind bypass of preservation checks.

## 12. Ticket reads, ownership, migration, and Manager

### Owner/read matrix

Test ticket validate/show/queue and status with no owner, current active owner, verified dead owner, remote/unverifiable owner, PID reuse, missing identity, corrupt owner, legacy schema, and partial installation. Compare durable DB bytes/schema/publication history before/after reads; explain legitimate SQLite sidecar effects separately.

Read-only operations must remain available without taking ownership or triggering writer migration. Writer start/upgrade must still prevent competing builds. Race two starts in a disposable fixture and verify exactly one admitted writer; no abandoned half-upgrade or conflicting work.

For copied-state canonical-root mismatch and MoneyTree's legacy blocked ticket, identify legitimate state-transfer/prerequisite resolution. Do not erase locks or edit rows until it works. Confirm the public guidance is actionable, plain language, and uses supported commands.

### Manager matrix

Consult at first-create/partial install, configured/no-plan, plan-only, failed ticket planning, ready queue, dirty preflight, active build, failed QA, interrupted run, and completed build. Use questions tied to actual fixture evidence.

Manager must distinguish known evidence from suggestions, diagnose setup/planning/tickets without creating a run, offer the right recovery path, and require valid run/work authority for mutating build controls. Confirm advice does not imply it already changed state. Check prompt/evidence boundaries and secret redaction.

## 13. Realistic builds, recovery, and completion

Use MoneyFarm and MoneyTree copies plus a synthetic 6–10 ticket graph containing a dependency chain, independent tickets, disjoint and overlapping files, and one deliberate QA failure. Then use a bounded 20–30 ticket deterministic graph to probe long-run accumulation after smaller runs pass.

Measure queue readiness, admission, dispatch, branch/worktree creation, tool results, QA, remediation, prerequisite release, completion, and cleanup. Check dependency correctness and exactly-once state transitions.

Inject interruption immediately before dispatch, after dispatch, during tool side effects, during QA, before ticket publication, during migration, and before run completion. Test supported direct/detached launch and public resume paths separately. Capture the real boundary before injecting a fault; time-based guessing alone is insufficient.

Verify persisted input/baseline decisions, correct work identity, no duplicate side effects or ticket publication, no lost application work, and consistency across public status, queue, Manager, and DB. Uncertain work may require reconciliation; do not force it to “done.”

Completion tests must include missing batch-end but durable completion, audit events after completion, a newer unknown run in a shared log, repeated CLI reads, and subsequent build start. Never borrow success from another retained run.

## 14. Performance and publish gate

Run on an observed stable host after hang diagnosis, with no overlapping expensive test/build jobs unless concurrency is the experiment. Record cold/warm cache and setup differences.

1. Instrument per-file/partition setup, execution, readiness, waits, and cleanup.
2. Compare one, two, and four lanes on identical revision/coverage, with at least three measurements where feasible.
3. Verify both QA provider partitions run exactly once, immutable artifacts are truly immutable, and sharding neither drops nor duplicates required coverage.
4. Verify shortened test-only watchdog settings retain the actual timeout/cleanup behavior while production defaults remain unchanged.
5. Record test totals, skip reasons, failures, median/range, CPU/resource pressure, and unexplained gaps; do not compare mismatched revisions as a controlled benchmark.
6. Run complete `ai-foreman prepublishOnly`, CLI/spec/agent suites, workspace typechecks/builds, docs check, and whitespace check, inspecting scripts before invoking them.

Relevant commands, subject to current package scripts:

```sh
pnpm --filter ai-foreman prepublishOnly
pnpm --filter @rafi-ai/cli test
pnpm --filter @rafi-ai/spec test
pnpm --filter @rafi-ai/special-agents test
pnpm -r typecheck
pnpm -r build
pnpm docs:check
git diff --check
```

Verify actual package names from manifests; adjust labels, not coverage. Offline publish tests must remain provider-free. Faster models are a separate online-runtime experiment, not a solution to local scripted-fixture hangs. Preserve meaningful behavior coverage; do not approve a release with an unexplained red gate.

## 15. Online-provider approval and execution gate

For `offline-only`, mark this section not applicable and do not contact a provider. For `online-only` or `both`, present or confirm a short selected-provider matrix: exact commands, account/model/version, expected artifacts, maximum calls/time/cost or quota, interruption policy, and external side-effect controls. Obtain explicit provider/account approval before contacting any service. In `both` mode, continue offline work while waiting; in `online-only`, continue only provider-independent work while waiting.

After approval, begin with one complete small lifecycle per authorized selected provider/account, then a small multi-ticket build with QA remediation and recovery. Observe first-response, tool, generation, dispatch, and cleanup timing independently. Bound every run and stop before exceeding authorization. Keep Claude and Codex runs independent; never send a scenario intended for one through the other as a fallback.

A passing scripted-provider run proves orchestration under that script, not real provider/auth/network compatibility. If online approval is absent, finish with an explicit online-unverified result rather than declaring rock-solid connections.

## 16. Mandatory stop-and-diagnose protocol

For **every** unexpected failure, timeout, misleading status, unexplained wait, or preservation discrepancy:

1. Stop advancing the affected scenario. On suspected data/authority risk, stop all related writers safely.
2. Preserve command, inputs, output/events, snapshots, process identities, phase, deadlines, and exact revision before retrying.
3. Write expected versus observed behavior and user impact. Distinguish application test failure, Rafi orchestration bug, provider outcome, harness bug, and environment hypothesis.
4. Reproduce from the unchanged seed with one variable altered at a time and a positive control. Record intermittency, not just the last run.
5. Trace the actual CLI caller through adapter/state/storage/process boundaries. Identify where the contract first diverged, with source locations and triggering state.
6. State the causal chain and counterfactual: what evidence predicts failure, and what narrow change makes it pass? Correlation alone is not root cause.
7. Create a bounded minimal regression/reproduction test that fails for the intended reason. Prefer real process/state boundaries for integration defects.
8. Propose the smallest safe resolution, alternatives, compatibility risks, and recovery for existing affected sessions.
9. If fixes are authorized, patch Rafi incrementally; rerun regression, neighboring tests, the original scenario, and the complete affected lifecycle from a fresh seed. Update help/docs for workflow changes.
10. Close only with causal evidence and verified resolution. Otherwise mark unresolved/blocked with the exact next experiment; do not bury it under overall pass counts.

For a defect that prevents `rafi create . → plan → tickets → rafi start . --steps 2`, first determine and document the exact causal boundary. Attempt the narrow safe resolution only when production fixes are authorized. Otherwise write implementation-ready instructions: affected public command and source boundary, durable-state compatibility/migration needs, exact validation and recovery behavior, regression tests, documentation/help updates, and full fresh-lifecycle retest. If competing safe resolutions remain materially uncertain, stop and consult the user rather than guessing.

Do not “fix” a failure by dropping validation, owner safety, QA independence, approval, source provenance, uncertainty handling, preservation assertions, or protected tests. Do not fabricate repair notes/tests merely to satisfy schema. Do not implement unrelated target-app fixes under Rafi authority.

## 17. Completion criteria and handoff

The agent's final report must include:

- Exact source/package/runtime revision tested and installed-versus-local distinction.
- Scenario matrix with pass/fail/blocked/inconclusive and untested cells.
- Artifact-linked complete create → plan → tickets → build → QA → completion journeys for every selected provider/mode and packaged CLI.
- Planning-invalid-output and doctor recovery results, session identity, quality checks, and publication safety.
- Dirty-state continuation results and original/fixture preservation proof.
- Ownership/read-only/concurrent-writer and pre-build Manager outcomes.
- Provider call correlation, timeout/recovery/unknown-state, process cleanup, and real-account coverage limits.
- Every discovered issue: severity, exact cause or unresolved hypothesis, minimal reproduction, safe resolution, regression coverage, and disposition.
- Stall diagnosis, measured performance distributions, complete gate results, and any coverage changes.
- Confirmation of selected/authorized/used online providers, external repo mutation, publishing, commits, pushes, deployment, and cleanup.
- Remaining risks and exact next commands. Keep reusable harness/reproductions and evidence paths for another agent.

Minimum confidence gate for every selected mode: repeatable full journeys, valid/repairable/recoverable ticket planning, safe dirty continuation, preserved writer safety, truthful status/activity, bounded diagnosable failures, and a clean current full test gate. Offline confidence is limited to scripted orchestration. Online confidence is a separate gate and must be qualified by the selected tested account/model/version, transport, sample size, and quota-limited coverage.

Do not claim everything works smoothly while a normal lifecycle, unexplained stall, or broad gate remains red or untested. The desired outcome is evidence-backed confidence and a complete actionable defect inventory, not a reassuring summary.
