# Rafi reliability investigation and remediation plan

Prepared 2026-10-12. Status: offline implementation and verification complete across all eight slices. See [implementation results](rafi-reliability-implementation-results.md) and the historical [Phase 0–2 findings](rafi-reliability-phase-0-2-findings.md). Live-account verification and release actions remain separately authorized later lanes.

## Outcome

Make Rafi easy to start, diagnose, recover, and run through substantial builds. A normal user should not need to understand Rafi's internal databases, process leases, planner schema, or provider event protocol. Safety checks should prevent data loss and concurrent writers without preventing read-only inspection or leaving the user without a clear next action.

This plan covers the seven reported problem areas and a broader field-test pass using MoneyTree and MoneyFarm. It deliberately separates:

1. deterministic reproduction and contract tests;
2. preserved-state reproduction from disposable copies of the two application repositories;
3. clean-install and upgrade journeys in fresh scratch repositories;
4. bounded live-provider and real-build canaries; and
5. implementation, regression, performance, and release verification.

The companion [Rafi field-test playbook](rafi-field-test-playbook.md) is the reusable procedure for later casual, targeted, and full Rafi exercises.

## Quick kickoff

From a coding session rooted at the parent directory containing `rafi/`, `moneyTree/`, and `moneyFarm/`, give the agent this instruction:

```text
Execute docs/rafi-reliability-investigation-and-remediation-plan.md in the rafi repository.
Begin with Phase 0 and the offline fixture lane. Preserve all existing changes in
rafi, moneyTree, and moneyFarm. Do not run state-changing Rafi commands in either
original application repository. Make disposable stateful and clean-room copies,
use the locally built Rafi CLI as the system under test, and record command,
version, duration, exit status, filesystem diff, process state, and sanitized logs
for every scenario. Add failing regression tests before repairs where practical.
Ask before any paid/live-provider run, original-repository mutation, publish,
commit, push, or destructive cleanup. Continue safe offline work while a live-run
decision is pending.
```

The first review point is the end of Phase 2, when the agent should present the reproducibility table, unexpected additional defects, timing baseline, and proposed implementation slices. Ordinary offline fixture work and scratch-copy creation do not require another design discussion.

## Safety and evidence rules

- Treat all existing changes in all three repositories as user-owned. Do not stash, reset, clean, overwrite, commit, or remove them.
- Do not use the globally installed `rafi` accidentally. Record `command -v -a rafi`, global version, local source revision, package versions, Node version, package-manager version, OS, provider CLI paths, and provider CLI versions. Exercise the local build through an explicit absolute command.
- Assume even a command described as read-only may migrate local state until proven otherwise. Snapshot first and compare filesystem hashes before and after.
- Never copy credentials, provider settings, secrets, sockets, or unrelated user data into a fixture. Keep provider authentication external to the copied repository.
- Preserve `.rafi/`, `.tickets/`, SQLite sidecars, install manifests, Git metadata, file modes, symlinks, and timestamps in stateful reproductions. Record omitted regenerable directories.
- Use a new disposable copy for each state-mutating scenario. Never make later results depend on an earlier scenario's accidental migration.
- Before copying a state database, verify whether a Rafi/Foreman writer is active. If a writer is active or ambiguous, do not copy a potentially inconsistent database; collect process metadata and consult the user.
- Capture raw provider events only in protected, ignored artifacts. Store sanitized event shapes and conclusions in versioned evidence. Do not retain private prompts or source from the unavailable repositories.
- Do not use Graphify for routine inventory, CLI execution, tests, or ticket bookkeeping. If a later implementation becomes a substantial graph-assisted cross-file investigation, apply the repository's Graphify trigger gate first and perform at most one justified update after the editing batch.
- No live model call, remote push, pull request, publish, or deployment occurs without explicit authorization. A local scripted provider or fake adapter is the default.

## Preliminary source observations to verify

These observations make the plan concrete, but they are not a substitute for reproduction:

- `packages/ai-foreman/src/ticketPlanning.ts` validates the completed planner proposal and throws `invalid planner proposal` when any generated ticket violates the ticket schema. The current path does not perform a bounded correction turn with the validation errors.
- `packages/ai-foreman/src/tickets/ticketLoader.ts` requires non-empty `required_tests` and rollback/mitigation notes for non-low-risk tickets. The ticket schema also restricts `priority` to an enum. All three reported failures can therefore be produced by model output that reaches final validation without satisfying the contract.
- `packages/ai-foreman/src/projectDiagnostics.ts` explicitly throws when no build runs exist, which prevents Manager from operating as a project/setup/planning consultant.
- `packages/ai-foreman/src/buildWorkMigration.ts` contains the exact `Work admission upgrade requires a stopped, verified build owner` message. The writer-exclusion rule protects real builds, but its appearance during `tickets queue` indicates that a read-only user journey is coupled to a write/migration path or to eager initialization that must be isolated.
- `packages/ai-foreman/src/activity.ts` labels a completed tool event failed when its normalized status is `failed`/`error` or it has a non-zero exit code. `packages/ai-foreman/src/adapters/claude.ts` converts Claude `tool_result.is_error` into that status. Enterprise event payloads containing `TIME_ELAPSED` need to be captured and classified rather than guessed at.
- `rafi create` already offers an interactive exact-preimage snapshot path for a dirty repository, while non-interactive create rejects dirtiness. Build worktree checks reject other dirty states. The investigation must distinguish create/install ownership from build isolation instead of adding one unsafe global bypass.
- `ai-foreman` currently runs all test files with `--test-concurrency=1`. Its ordinary test command should not make live provider calls, so changing the default model cannot improve the normal publish gate unless live tests have been unintentionally included. Measure the process, fixture, build, pack, and timer costs before changing coverage.

## Test environments

### Local Rafi under test

Build the existing workspace once, then invoke the CLI explicitly, for example:

```sh
corepack pnpm --filter ai-foreman build
corepack pnpm --filter @rafi-ai/cli build
node /absolute/path/to/rafi/packages/rafi/dist/index.js --version
```

Record the exact command in every result. Rebuild affected packages before integration tests so `dist/` cannot silently lag source. Compare the locally built CLI with the installed CLI only as an explicit compatibility scenario.

### MoneyTree copies

MoneyTree currently has no commits and its useful contents are untracked, so a normal Git clone is not a valid reproduction. Create two kinds of scratch copy without modifying the original:

- **Stateful copy:** filesystem-preserving snapshot with Git metadata, `.rafi/`, `.tickets/`, SQLite databases and sidecars, install manifest, Rafi config, and application files. Omit only recorded regenerable bulk such as dependency caches after confirming it is irrelevant.
- **Clean-room seed:** copy application source and intended project instructions while deliberately excluding Rafi-generated/state directories. Initialize and commit only inside the disposable directory so dirty-worktree and first-install scenarios have a stable baseline.

Because stored project identity may intentionally reject a different canonical path, first record whether the copied state fails for identity reasons. Do not “fix” that failure before preserving evidence. Test the supported state-transfer/rebind path separately from exact error reproduction.

### MoneyFarm copies

Create:

- a clean local clone of committed source for first-time setup;
- a stateful filesystem snapshot including its modified install manifest and untracked Rafi planning/reference material;
- a clean clone with the same ticket definitions but no runtime/recovery database; and
- a deliberately dirty clone with independent staged, unstaged, and untracked application changes.

Do not assume a Git clone captures the current reported state. Produce a manifest showing which tracked and untracked paths each fixture contains.

### Synthetic repositories

Keep small deterministic fixtures for failures that cannot be sourced from the private repository:

- planner proposals with empty `required_tests`;
- Medium/High/Critical-risk tickets without rollback notes;
- tickets with invalid priority values;
- multiple simultaneous validation failures;
- malformed JSON and missing proposal delimiters;
- a legacy recovery database with a live, dead, stale, PID-reused, remote-host, and unverifiable owner;
- a repository with no build run but with create, plan, ticket, and failed-interview state;
- Claude tool-result streams containing genuine errors, success, progress, timeout-like metadata, and the observed `TIME_ELAPSED` shape once captured;
- clean, staged, unstaged, untracked, ignored, conflicted, and overlapping dirty paths.

## Scenario matrix

Every scenario gets a stable ID, pristine fixture, command transcript, wall/active time, exit code, before/after manifest, process inventory, durable-state diff, sanitized logs, user-facing assessment, and linked defect/test.

| Lane | Purpose | Providers | May mutate original repos? |
| --- | --- | --- | --- |
| F: fixtures | Schema, migration, event, CLI, and recovery contracts | Scripted/fake only | No |
| S: stateful copies | Reproduce MoneyTree/MoneyFarm installed and upgrade behavior | None first; live only by approval | No |
| C: clean room | First create → plan → tickets → start journey | Scripted first | No |
| D: dirty worktree | Preserve/continue choices across commands and delivery modes | Scripted | No |
| P: performance | Per-file and per-phase test/publish timing | None | No |
| L: live canary | Real Claude/Codex planning and small build behavior | Explicitly approved | No |
| O: original checkout | Confirm a copy-specific result against real state | Normally none | Only with explicit approval and backup |

Run each applicable scenario in interactive PTY and non-interactive modes. Test success, failure, retry, cancel, interruption, and restart where they have distinct state transitions.

## Phase 0: inventory and immutable baselines

1. Record Git roots, branches, statuses, revisions, applicable agent rules, package scripts, dependency lock state, CLI resolution, runtime versions, provider availability, and existing Rafi state for all three repositories.
2. Hash or manifest the Rafi-related state in MoneyTree and MoneyFarm without opening it through Rafi. Identify active PIDs/leases using read-only process checks.
3. Build the local Rafi packages and run only narrow existing tests for the seven implicated surfaces. Record pre-existing failures without fixing them yet.
4. Create an ignored evidence root outside the application repositories. Assign one directory per scenario and write a run manifest before execution.
5. Provision the stateful, clean-room, and synthetic fixtures. Validate that the originals remain byte-for-byte/Git-status unchanged.

Deliverable: baseline report with reproducible environment commands and a fixture manifest.

## Phase 1: deterministic reproduction

Reproduce each reported symptom without a paid provider:

1. Feed scripted invalid planner proposals through the real proposal extraction, CLI planning driver, interview persistence, and apply boundary. Confirm invalid data is never applied and document what recovery state survives.
2. Invoke Manager against fixtures representing create-only, plan-only, ticket-only, failed-planning, and no-Rafi state. Confirm the exact point at which it demands a build.
3. Exercise `tickets queue` against every legacy-owner fixture. Prove whether queue itself opens the workflow database or whether eager CLI/project initialization does it. Verify whether a failed read changes database bytes, schema version, WAL files, or backups.
4. Replay normalized Claude SDK messages through the actual adapter and activity reporter. Do not hard-code a `TIME_ELAPSED` exception until the exact enterprise payload and semantics are known.
5. Exercise every command that performs a cleanliness check. Record the command, delivery mode, dirty-path category, current choices, whether files are touched, and whether safe isolation was possible.
6. Measure the complete `ai-foreman` test command by test file and major setup phase. Run enough repeated samples to separate consistent cost from one-time build/cache/native-module cost.

Deliverable: one row per symptom with `reproduced`, `not reproduced`, or `environment-dependent`; exact cause path; minimal fixture; and failing regression-test location.

## Phase 2: application-repository field tests

### MoneyTree

Run against a fresh stateful copy first:

1. `--version`, help, doctor/status, and filesystem-diff probe.
2. `tickets validate`, `tickets show --all --json`, and `tickets queue`, each from a pristine reset of the copy.
3. Process/owner classification and the supported stop/attach/recovery commands in inspect-only mode.
4. Manager questions about setup, tickets, planning, owner state, and recovery.
5. Upgrade rehearsal after making an immutable backup and proving the copied owner is not active.
6. Clean-room `create` → `plan` → ticket population/planning → queue → one-ticket start with scripted providers.
7. Approved live canary only after the deterministic path passes.

The copied canonical-root mismatch, if any, is a separate portability finding and must not be conflated with the original build-owner message.

### MoneyFarm

Run against separate pristine copies:

1. Inspect/validate/show/queue/Manager against the current ticket-ready state.
2. Preview start selection, build policy, branch plan, required tools, repository cleanliness, provider readiness, and recovery state without dispatching implementation.
3. Run a scripted one-ticket build through Builder, QA, finalization, and cleanup; inject interruption before dispatch, after dispatch, during QA, and before final projection.
4. Run the same path with independent dirty changes and prove they remain untouched.
5. Run a clean-room first install and full planning/ticket setup path.
6. After offline success and approval, run one bounded live ticket, then a multi-ticket canary. Stop on any ambiguous ownership, unexpected remote action, paid-service requirement, or evidence of original-repository mutation.

### Broad friction sweep

In both repos, also log issues not named in this prompt: confusing prompts, missing default choices, unnecessary flags, inconsistent command names, silent state writes, repeated auth/readiness work, stale generated docs, weak cancellation, lost session recovery, misleading success, inability to resume, excessive output, and time spent without useful progress. Each candidate defect needs a minimal reproduction before entering the implementation backlog.

Deliverable: field-test report and prioritized additional-defect backlog.

## Workstream A: planner correctness and automatic correction

### Required behavior

- Supply the planner a single versioned schema/contract derived from the production validator, including allowed priority/risk values and conditional rollback requirements.
- Validate proposed output before presenting it as complete.
- When validation fails, send the complete normalized issue list back to the same bound planning session for a response-only correction. Permit a small bounded number of correction attempts; do not rerun repository discovery or apply partial tickets.
- Preserve the original output, validation issues, corrected output, model/provider/session identity, and final disposition in a compact redacted recovery record.
- If correction still fails, show a plain-language summary and the exact flagless recovery command.
- Never weaken the final apply-time validator. A formatting repair cannot silently invent substantive acceptance criteria or tests; the repaired proposal remains reviewable before application.

### Tests

- Each of the three reported validation failures alone and in combination.
- An existing-ticket edit that becomes invalid only after merge.
- Invalid enum casing/aliases, empty strings, missing arrays, risk transitions, malformed JSON, and repeated bad repair.
- Session interruption before and after correction, source drift, cancel, resume, and apply rollback.
- Positive control proving a valid proposal incurs no extra model turn.

## Workstream B: flagless planning doctor

Implement a canonical `rafi plan:doctor [project]` experience. No flags are required for normal use.

1. Discover incomplete/failed create, plan, and ticket-planning sessions plus invalid current plan/ticket artifacts.
2. If one relevant session exists, summarize and offer repair immediately. If several exist, show an interactive list with workflow type, state, provider, short ID, and human relative age such as “12 minutes ago.”
3. In non-interactive use, print the candidates and an exact resumable command rather than guessing.
4. Revalidate current source fingerprints before repair. Explain when the old session cannot safely continue and offer a fresh plan while preserving evidence.
5. Run deterministic local repairs first. Use the original provider session only when semantic correction is needed and available. Never require users to hand-edit hidden state.
6. Surface this command directly in planner validation errors, relevant `doctor` output, and Manager advice.

Before implementation, verify whether `plan:doctor` should be the only public name or whether `tickets doctor` should be an alias. Default recommendation: one documented top-level `plan:doctor` command covering all pre-build planning stages, with internal workflow labels rather than several similar commands.

## Workstream C: Manager before the first build

Replace the “build runs only” assumption with a project-level Manager packet that can exist without a run ID.

Manager should become available after Rafi has created any recognizable project footprint and should understand:

- create/install manifest and compilation state;
- selected runtimes, configured models, readiness, and applicable project instructions;
- current plan, plan history, structured plan validation, sources, and saved interviews;
- ticket configuration, schema/validation, queue, delivery setup, and planning failures;
- build/recovery/QA evidence when runs exist; and
- the limits of unavailable or protected evidence.

The no-build packet must not fabricate a run ID or write observability/workflow databases just to start Manager. Host actions that require a run remain unavailable with a specific explanation; project diagnosis and planning consultation remain usable. Add scenarios for empty project, create-only, failed create, plan-only, ticket-ready, corrupt state, first build, and historical builds.

## Workstream D: ai-foreman publish-test performance

### Measure first

1. Record cold and warm wall time, CPU time, peak memory, child-process count, test-file duration, setup/build time, pack time, native-module time, and idle/wait time.
2. Identify tests that spawn real CLIs/processes, repeatedly initialize Git/SQLite/packages, use wall-clock sleeps, rebuild artifacts, or serialize only because they share global environment/state.
3. Confirm live-provider tests are excluded unless an explicit environment switch is set. If they are entering `prepublishOnly`, treat that as a defect.
4. Compare the package test command, prepublish command, root recursive test command, and the command actually used during the reported publish attempt.

### Optimize without weakening the gate

- Split fast hermetic unit/contract tests from process, packaged-artifact, migration, crash, and opt-in live lanes.
- Make test files isolated enough for safe file-level parallelism; retain serial subgroups only where measured shared-state constraints require it.
- Replace real waits with fake clocks or event barriers where time itself is not the subject under test.
- Build/package once per suite where the tested artifact is identical; reuse immutable fixtures without reusing mutable databases or worktrees.
- Make subprocess tests more atomic and share setup helpers without combining distinct assertions into opaque mega-tests.
- Add slow-test reporting and fail or warn on large regressions using a baseline with tolerance, not a brittle absolute time on every machine.
- Keep a fast developer gate, a complete offline publish gate, and explicit live canaries. The publish gate must still select and report all safety-critical crash, ownership, recovery, QA, migration, and packaged-artifact tests.

Model selection is a separate live-workflow experiment. Normal offline tests should make no model calls. For approved live canaries, compare current and faster models on the same fixture for validity rate, repair turns, elapsed time, tokens/cost, and downstream QA outcomes. Promote a faster default only if quality and safety thresholds hold; allow role-specific defaults because planning, Manager diagnosis, Builder work, and QA have different requirements.

Set a performance target after the baseline. Report both absolute time and percentage improvement, with zero loss of selected tests or protected assertions.

## Workstream E: truthful Claude tool status

1. Obtain the sanitized enterprise Claude event shape that produced `tool_result (TIME_ELAPSED)`, either from retained local evidence or a bounded approved reproduction.
2. Correlate `tool_use_id`, original tool name, progress messages, result payload, `is_error`, exit status, provider turn outcome, and whether useful work continued.
3. Define normalized outcomes such as `running`, `completed`, `failed`, `timed_out`, `cancelled`, and `completion_unknown`. Do not map provider-specific metadata strings directly to failure without documented semantics.
4. Display the original tool name when correlation exists; `tool_result` is an event type, not useful user-facing tool identity.
5. Coalesce transient progress and repeated identical results. Persistent warnings should represent actionable failure, while diagnostics retain the underlying event and uncertainty.
6. Test enterprise-style payloads, personal-account payloads if voluntarily available, missing IDs, out-of-order events, truncation, genuine tool errors, true timeouts, provider retry, and successful turns after an error-like event.

The implementation must not hide real failures merely because the overall turn later succeeds. It should distinguish a recovered tool failure from a false failure and summarize it once.

## Workstream F: work-admission upgrade and read-only commands

Keep the concurrency invariant: two active build writers must never own the same project. Remove the guard from places that do not need writer authority.

1. Trace why `tickets queue` reaches workflow migration in MoneyTree and build the smallest legacy database that reproduces it.
2. Split read-only ticket/project access from workflow writer initialization and schema migration. `tickets queue`, ticket show/validate, basic status, and project-level Manager inspection must remain usable while an old or active build owner exists.
3. Move upgrade to an explicit mutating/build preparation boundary with a coherent backup and integrity check.
4. Classify the owner as verified active, verified dead, stale-but-unresolved, remote/unverifiable, or corrupt. Do not equate old heartbeat with dead process and do not steal an ambiguous lease.
5. For an active owner, explain in plain language that another Rafi build appears to be running, identify the run/process/time when safe, keep read-only commands available, and offer attach/status/graceful-stop choices.
6. For a dead owner, reconcile and upgrade automatically when safe after backup. For ambiguous ownership, provide a flagless interactive doctor/recovery route with inspect-first output.
7. Ensure failed inspection or migration does not partially update schema, create misleading ownership, or make the old state unreadable.

Acceptance includes the exact MoneyTree-copy scenario plus live owner, dead owner, PID reuse, different host, missing process-start identity, corrupted record, concurrent migration, interruption, rollback, and successful later build.

## Workstream G: continue safely with uncommitted work

Inventory every cleanliness gate and give each a reasoned policy. The default interactive experience should always include:

1. **Preserve my changes and continue in isolation** (recommended): create a Rafi-owned worktree/snapshot from a recorded baseline while leaving the user's current index and working tree untouched.
2. **Continue in this checkout with my changes**: treat current tracked/untracked state as explicit build input, record its digest and overlap risks, and preserve it through planning/build/finalization.
3. **Stop so I can commit or stash**.

Do not call option 1 or 2 a blind ignore internally. Both need explicit preservation semantics. Rafi must never auto-stash, reset, clean, overwrite, commit, or silently omit user changes. If a delivery mode cannot safely support option 2, keep option 1 available and explain the constraint in user terms.

Add a non-interactive equivalent with an explicit persisted/default policy, but do not require flags in the normal interactive flow. Test create, compile, plan, ticket plan, current-branch start, branch-per-ticket start, direct merge, resume, start-over, and uninstall across staged/unstaged/untracked/ignored/submodule/conflicted/generated-state changes and overlapping ticket files. After every path, compare index, worktree, untracked bytes, modes, branches, commits, and Rafi manifests with the expected state.

## Phase 3: implementation order

Implement small test-first slices in this order unless Phase 2 evidence changes a dependency:

1. Read-only initialization boundary so inspection cannot trigger the work-admission migration.
2. Planner error fixtures and bounded same-session correction.
3. Durable failed-planning records and `plan:doctor` discovery/selection.
4. Project-level Manager packet with no build run.
5. Claude event normalization and activity presentation.
6. Dirty-worktree policy and isolated continuation.
7. Test-suite timing instrumentation, isolation, and parallelization.
8. Cross-feature integration: Manager explains planner/owner/dirty failures and links to the correct recovery command.

Each slice must preserve existing ownership, source-fingerprint, approval, ticket provenance, QA independence, uncertainty, and finalization protections. Do not “fix” friction by weakening a validator, deleting a migration guard, treating an owner as dead without proof, or hiding failures.

## Phase 4: verification

For each slice:

1. Run the new failing-then-passing targeted test.
2. Run protected neighboring suites and both provider adapter fixtures.
3. Run typecheck and rebuild the packages consumed through `dist/`.
4. Run the complete practical offline package suites with selected/skipped counts and timing.
5. Re-run the stateful MoneyTree/MoneyFarm copies from pristine snapshots.
6. Run clean-room create-to-one-ticket scripted journeys.
7. With approval, run bounded Claude Enterprise and Codex canaries, followed by a small multi-ticket MoneyFarm-copy build.
8. Verify help/docs/error messages, install/upgrade compatibility, and package contents.
9. Compare originals' Git status and state manifests with Phase 0 to prove they were not changed.

Before release, run a longer disposable build that includes planner correction, a dirty base, interruption/resume, Builder/QA handoff, and finalization. A successful happy path alone is insufficient.

## Completion criteria

- The three known planner schema failures are prevented where possible, corrected automatically when produced, and recoverable through a documented flagless command.
- `rafi plan:doctor` discovers and explains relevant failed sessions with human-readable ages and can safely repair or restart them.
- Manager answers useful setup/planning/ticket questions without any build history and gains build/QA controls only when a valid run exists.
- The ordinary ai-foreman publish gate has a measured, substantial improvement without dropping or skipping protected coverage; live model work is separately gated and measured.
- Claude tool output distinguishes progress, real failure, timeout, recovery, and unknown completion without false repetitive failure lines.
- `tickets queue` and other read-only views work despite an active/legacy build owner and do not mutate/migrate workflow state.
- Writer admission still prevents competing builds and now explains active, dead, and ambiguous owner recovery in normal language.
- Dirty repositories always have a safe continuation option; user work remains byte-for-byte and index-for-index preserved according to the chosen mode.
- MoneyTree and MoneyFarm copy-based journeys reach a scripted build and approved live canary, or every remaining blocker has a minimal reproduction, owner, recovery action, and regression test.
- Newly discovered friction is triaged and either fixed, explicitly deferred with rationale, or rejected as non-defect with evidence.
- Documentation, CLI help, tests, changelog/release notes, and any migration notes agree with actual behavior.

## Decisions to confirm only when reached

The default plan can begin without answers. Ask the user at the relevant gate for:

1. authorization and time/cost limits for Claude Enterprise, personal Claude, and Codex live canaries;
2. whether `rafi plan:doctor` should have a `rafi tickets doctor` alias after the no-flag experience is demonstrated;
3. acceptable compatibility policy if a schema/storage change is required; and
4. release actions after all local and disposable-repo evidence passes.

Do not block offline fixture, source, test, documentation, or performance-baseline work while these decisions are pending.
