# Rafi field-test playbook

Prepared 2026-10-12. This is a reusable, agent-executable playbook for testing Rafi against a real repository while preserving the repository under test. Use it for a quick friction sweep, a named bug investigation, a release regression, or a longer build soak.

For the current seven-issue effort, use the companion [reliability investigation and remediation plan](rafi-reliability-investigation-and-remediation-plan.md).

## Copy-paste kickoff

Replace the bracketed values and give this to an agent from a workspace containing the Rafi source checkout and the target repository:

```text
Use rafi/docs/rafi-field-test-playbook.md to test Rafi.

Rafi source: [absolute or workspace-relative path to rafi]
Target repository: [path]
Profile: [quick | standard | full | soak]
Issues to emphasize: [none, or paste symptoms/error text]
Provider policy: [offline-only | ask-before-live | named approved providers]
Maximum live duration/cost: [none, or explicit bound]

Preserve the target exactly. Start with inventory and a disposable copy; never run a
state-changing Rafi command in the original. Exercise the locally built Rafi CLI,
not an accidental global install. Record versions, commands, timing, exit codes,
before/after filesystem state, process ownership, sanitized logs, and minimal
reproductions. Find additional friction beyond the named issues. Add failing Rafi
regression tests before implementing fixes where practical. Ask before original-repo
mutation, paid/live-provider work outside the stated policy, remote Git actions,
publishing, deployment, destructive cleanup, or discarding any data.
```

If no issue list is supplied, treat the assignment as a general usability and reliability sweep. If a symptom is supplied, reproduce it first but still run the profile's adjacent smoke checks.

## Profiles

| Profile | Typical scope | Provider use | Intended result |
| --- | --- | --- | --- |
| `quick` | 10–20 minute inspect/help/doctor/ticket smoke pass | Offline | Find obvious installation, state, messaging, or read-only failures |
| `standard` | Full offline lifecycle with scripted provider and interruption cases | Offline | Reproduce bugs and reach a deterministic one-ticket build |
| `full` | Standard plus clean install, upgrade, dirty-state matrix, real one/multi-ticket canaries | Ask/approved | Release-quality compatibility and end-to-end evidence |
| `soak` | Repeated substantial disposable builds, crash/recovery, timing and flake sampling | Explicitly approved | Find intermittent failures, stalls, leaks, and long-build degradation |

Time ranges are estimates, not deadlines. Stop on data risk, ambiguous ownership, unexpected remote action, or an unbounded paid operation.

## Inputs and defaults

Record these at the top of the run report:

```yaml
run_id: <timestamp-and-short-label>
profile: quick|standard|full|soak
rafi_source: <path>
target_original: <path>
target_fixture: <path assigned after provisioning>
issues: []
provider_policy: offline-only|ask-before-live|approved
approved_providers: []
live_budget: null
remote_git_allowed: false
original_repo_mutation_allowed: false
started_at: <ISO timestamp>
```

Defaults are conservative:

- local Rafi source is the system under test;
- the target original is read-only;
- fake/scripted providers are used first;
- remote Git, publishing, and deployment are disabled;
- live provider runs require approval unless explicitly pre-authorized;
- no credentials or private prompt content enter versioned artifacts; and
- no cleanup removes evidence until the user accepts the report.

## Non-negotiable preservation contract

1. Read applicable `AGENTS.md`, `CLAUDE.md`, and repository instructions before actions.
2. Inspect Git status before editing. Existing modifications and untracked files are user-owned.
3. Never reset, clean, stash, switch away, commit, push, merge, rebase, or delete branches in the original target.
4. Do not assume a Rafi “read” command is non-mutating. Run it in a fresh copy first and compare bytes.
5. Verify active Rafi/Foreman/provider processes before copying SQLite state. Do not claim or migrate state owned by a live or ambiguous writer.
6. Preserve hidden Rafi/ticket directories and SQLite WAL/SHM files for stateful tests. Preserve modes and symlinks.
7. Use a new fixture instance per mutating scenario. Do not hide order dependence by repeatedly repairing one copy.
8. Keep raw logs, event payloads, and database copies outside tracked source. Sanitize secrets, tokens, user data, terminal controls, and private prompts in reports.
9. Do not use Graphify for ordinary field-test commands. Apply the target repository's trigger gate only if a later substantial architecture investigation genuinely benefits from graph evidence.

## Stage 1: inventory

Capture without invoking the target's Rafi state:

- current directory, repository root, branch, revision, status, worktrees, remotes, and whether the repo has any commits;
- tracked/untracked/ignored high-level paths and submodules;
- applicable instruction files;
- package manager, lockfiles, runtime/tool versions, and declared test/build commands;
- presence and high-level manifest of `rafi-config.yaml`, `.rafi/`, `.tickets/`, `.foreman/`, generated agent files, plans, sources, and ticket docs;
- installed `rafi`, `ai-foreman`, Claude, and Codex command paths/versions; and
- likely live owners/leases and matching local processes.

Do not print secrets or whole private config files. Hash sensitive or bulky artifacts and report only fields needed to explain behavior.

### Version trap check

Record both the installed CLI and source-under-test versions. Build the local workspace and define one explicit command for the run:

```sh
corepack pnpm --filter ai-foreman build
corepack pnpm --filter @rafi-ai/cli build
node /absolute/path/to/rafi/packages/rafi/dist/index.js --version
```

Use that absolute `node .../dist/index.js` command in the target fixture. If the globally installed version is also tested, label it as a separate compatibility scenario.

## Stage 2: provision fixtures

Create an evidence directory and disposable repositories under a task-specific temporary root. Record its exact location. Do not use the original as a scratch directory.

Provision only the variants needed by the selected profile:

### A. Stateful replica

Filesystem-preserving copy of the current target including Git and Rafi state. Use this for reported failures, upgrades, resumes, and stale-owner behavior. Record omitted directories and why they are irrelevant. A stored canonical-root mismatch is evidence, not permission to patch the database ad hoc.

### B. Clean committed clone

Local clone of committed source with no working-tree changes. Use for baseline install and clean start. If the source has no commits, build the clean seed inside scratch from copied application files and create an initial scratch-only commit.

### C. Clean-room Rafi seed

Application source and project instructions with Rafi-generated configuration/state removed. Use for first `create` and full onboarding. List every removed Rafi-owned path in the fixture manifest.

### D. Dirty variants

Independent fixtures for staged, unstaged, untracked, ignored, conflicted, submodule, and overlapping application changes. Use known sentinel contents and hashes so preservation can be proven.

### E. Fault fixtures

Small synthetic repositories/databases/provider scripts for malformed model output, ownership states, interrupted writes, timeouts, missing tools, corrupt files, and other named issues.

After provisioning, compare the original's Git status and state manifest with the inventory baseline.

## Stage 3: run profiles

### Quick profile

Use a fresh stateful replica for each command that could write:

1. Local CLI `--version` and relevant `--help` output.
2. `rafi doctor` and project status/inspect commands.
3. Ticket validation, complete ticket show, and queue.
4. Manager with a simple setup/planning question, including a no-build project.
5. Plan/interview recovery listing and obvious stale-session guidance.
6. Before/after filesystem and database manifest comparison.
7. UX review: does every failure explain what happened, what remains safe, and one exact next action?

The quick profile does not dispatch a model or start a build.

### Standard profile

Run the quick profile plus, on clean-room and scripted-provider fixtures:

1. First `create`, cancel, resume, repeat create, and compile.
2. Project `plan`, valid completion, malformed/invalid completion, repair, cancel, and resume.
3. Ticket population/planning, validate, show, queue, edit/recommendation flows, and recovery.
4. Manager questions at create-only, plan-only, ticket-ready, failed-planning, and post-build states.
5. Start preflight and one-ticket build using a deterministic provider through Builder, QA, finalization, and cleanup.
6. Interruption before provider dispatch, after dispatch, during QA, and before final state publication; resume each from a pristine fault fixture.
7. Dirty-worktree continuation and preservation checks.
8. Active/dead/ambiguous build-owner read-only behavior.
9. Targeted Rafi regression tests for every reproduced problem.

### Full profile

Run the standard profile plus:

1. Installed-old → local-new upgrade rehearsal with backups and rollback injection.
2. All applicable dirty-state and delivery-mode combinations.
3. Both configured runtimes through scripted adapters.
4. Explicitly approved real-provider planning and a one-ticket build.
5. A small multi-ticket build with dependencies, independent work, a QA failure/remediation, interruption/resume, and successful finalization.
6. Packaged artifact install and smoke run in a clean temporary consumer.
7. Full relevant package tests, typecheck, build, docs check, and package-content check.
8. Repeat all named original symptoms against the repaired local build.

### Soak profile

Run the full deterministic setup first. Then define a bounded matrix rather than an open-ended loop:

- exact sample count and maximum wall time;
- provider/model/runtime combinations;
- small, medium, and substantial ticket graphs;
- clean and dirty bases;
- injected transient provider errors, tool errors, process termination, and resume;
- cold and warm runs; and
- success, recovery, elapsed/active time, retries, tool outcomes, QA attempts, token/cost, child-process cleanup, and state-growth metrics.

Use at least one stable seed per scenario. Do not call a small sample a tail-latency guarantee. Stop the affected lane on repeated ambiguous ownership, possible duplicate side effects, credential leakage, remote mutation, or budget exhaustion.

## Stage 4: command-by-command evidence

For every command, create a record with:

```yaml
scenario_id: FT-###
fixture_revision: <manifest/hash>
command: <exact sanitized command>
cwd: <fixture path>
interactive: true|false
started_at: <ISO timestamp>
wall_ms: <number>
exit_code: <number|null>
timed_out: false
processes_before: <reference>
processes_after: <reference>
files_before: <reference>
files_after: <reference>
stdout: <sanitized artifact>
stderr: <sanitized artifact>
result: pass|fail|blocked|inconclusive
expected: <user-observable contract>
observed: <concise behavior>
next_action_shown_to_user: <text|null>
```

Also record active time separately from calendar time when Rafi reports it. An output heartbeat is not proof of useful progress, and a timeout is not proof that a remote action stopped.

## Stage 5: friction sweep

In addition to named issues, inspect these transitions:

| Area | Questions |
| --- | --- |
| Installation | Can a user start cleanly, rerun safely, choose a runtime, and understand generated files? |
| Dirty state | Is there always a safe continuation path, and is user work demonstrably preserved? |
| Planning | Are questions bounded, validation errors repaired, sessions resumable, and sources traceable? |
| Tickets | Can users validate/show/queue without a build, hidden migration, or irrelevant owner block? |
| Start/preflight | Are missing tools/auth/config explained before expensive work? Is a preview available? |
| Activity | Are progress, wait, retry, failure, recovery, and unknown completion distinct and non-spammy? |
| Manager | Can it help before, during, and after builds, while separating advice from authorized controls? |
| Recovery | Does every interruption expose one safe next action without replaying uncertain work? |
| QA | Are failures actionable, evidence retained, retries bounded, and successful checks independent? |
| Finalization | Is code location/branch/review state obvious? Are dirty and remote states preserved? |
| Performance | Where is wall time spent? Does repeated setup dominate useful model/build work? |
| Cleanup | Are child processes, worktrees, locks, leases, and temp artifacts accounted for? |

Log confusing wording even when behavior is technically correct. A safety stop without a plain-language reason and recovery path is a usability defect.

## Stage 6: triage and repair workflow

Classify each finding:

- **P0 — data/authority risk:** possible data loss, competing writers, wrong project/session, duplicate side effects, secret exposure, or false successful finalization.
- **P1 — workflow blocker:** normal create/plan/ticket/start/resume path cannot proceed.
- **P2 — serious friction or misleading state:** recovery exists but is hidden, output is false/noisy, or delay is excessive.
- **P3 — polish/efficiency:** unnecessary prompt/flag, inconsistent naming, minor performance or documentation issue.

For each reproducible Rafi defect:

1. Reduce it to the smallest fixture while retaining one positive control.
2. Identify the real production caller and state boundary.
3. Add a regression test that fails for the intended reason.
4. Implement the narrowest fix without weakening ownership, approvals, validation, QA, uncertainty, or user-data preservation.
5. Run targeted and neighboring suites, then rerun the real-repository copy scenario.
6. Update CLI help and user/recovery docs when behavior or commands change.
7. Record disposition: fixed, already fixed, environment issue, expected safety behavior needing better UX, deferred, or not reproduced.

Do not repair target-application code unless the user separately asks. This playbook diagnoses Rafi by exercising the application repository; application defects remain distinct findings.

## Stage 7: performance consultation

When the complaint is slowness, do not jump directly to a faster model or fewer tests.

Break time down into:

- Rafi/package build;
- test discovery and runner startup;
- pure test execution by file;
- Git/SQLite/worktree fixture setup;
- child-process/PTY startup and shutdown;
- real waits versus fakeable timers;
- package packing/installing/native dependencies;
- provider readiness and authentication;
- model queue, first-token, generation, tool, retry, and total turn time;
- QA and remediation; and
- human wait or unknown/unattributed gaps.

Optimize the measured dominant costs. Keep offline publish tests provider-free. For live Rafi work, compare models per role using identical inputs and score validity, quality, downstream correction/QA, latency, tokens, and cost. A faster planner that produces more invalid tickets or a faster Builder that increases QA remediation is not a net improvement.

## Stage 8: completion report

Return a concise summary plus durable evidence containing:

1. environment and exact Rafi build tested;
2. target fixtures and proof the original was preserved;
3. scenario table with pass/fail/blocked/inconclusive counts;
4. named issues reproduced and causes;
5. additional issues found, severity, and minimal reproduction;
6. code/tests/docs changed in Rafi;
7. tests/checks actually run with duration and outcome;
8. before/after performance results;
9. live-provider model/account coverage and limitations;
10. remaining risks, decisions, and exact next commands; and
11. artifact locations and whether cleanup is safe.

Do not claim success merely because one build completed. Success means the tested lifecycle is repeatable from a pristine fixture, failures are understandable and recoverable, safety invariants remain intact, and the original target repository is unchanged.

## Stop and consult conditions

Pause the affected lane and ask the user when:

- the original repository must be mutated to distinguish the cause;
- a supposedly dead owner may still be active or remote;
- a provider call will consume unapproved quota/cost or needs a different account;
- a command may push, create/merge a review, publish, deploy, or affect external systems;
- a storage/API compatibility decision has meaningful migration impact;
- credentials, private data, or protected prompts would need to be retained; or
- recovery would discard, overwrite, replay, or duplicate uncertain work.

Continue independent offline fixtures, source tracing, tests, and documentation while a decision is pending.

## Cleanup

Cleanup is a separate final step, not proof of completion.

- Confirm no owned child/provider process remains.
- Confirm the target original's Git status and Rafi-state manifest match the baseline.
- Keep the run manifest, sanitized logs, minimal fixtures, and failing/passing evidence until accepted.
- Remove only explicitly identified disposable directories; never use a broad path, unresolved variable, or wildcard.
- Do not delete migration backups or recovery bundles without user authorization.
- Report exactly what was removed and what remains recoverable.
