# ai-foreman rewrite

Status: **proposed.** Written 2026-10-29 after moneyTree's 18th stopped build.
Related: `MALFORMED_REPLY_AND_BLOCKED_BUILD_IMPROVEMENTS.md`, `QA_MANUAL_CHECKS_AND_RECOVERY_FINDINGS.md`, `PLAN_UPDATE_APPROVAL_IMPROVEMENT.md`, `GUI_PRODUCT_REQUIREMENTS.md`, `old-implemented-plans/STRUCTURED_PROVIDER_OUTPUT_MIGRATION_PLAN.md`, `AGENT_INSTRUCTIONS_REVIEW.md`. The work these docs describe is folded into the rewrite; see "Work folded into the rewrite" below.

## Why

Rafi's core job is small: for each ticket, the builder builds, QA reviews, and the builder fixes, repeating until the ticket is done. Most of ai-foreman's 51,000 lines are built around that loop to prove that every step happened exactly right, and any doubt stops the run.

The result: across 18 moneyTree builds, none finished on its own (T001 was eventually waived). Every bug fixed in the week of 2026-10-26 came from the recovery and proof machinery, not from building:
- 3 resume bugs;
- 4 recovery-file revision bugs;
- the malformed-reply mislabel.

Patching one bug creates the next.

## The bad patterns

Measured on 2026-10-29: ai-foreman 2.0.2, `@rafi-ai/cli` 0.10.2.

1. **Stopping is the default.**
   - 19 code paths end a build as `needs-human` or `blocked`; only 9 retry.
   - All 18 moneyTree builds stopped: about 10 on the environment (network, loopback, npm cache, StarNet), 3 on strict-format checks, about 3 that needed a person, 1 timeout, and 1 malformed reply.
2. **Proof instead of recovery.**
   - After a crash, rafi tries to prove exactly what happened instead of redoing the step.
   - There are 264 fingerprint (digest) comparisons; any mismatch stops the run.
3. **State in too many places.**
   - The SQLite database has 95 tables. On top of it there are run JSON files (`.foreman/runs`), QA recovery folders (`.foreman/qa-report-recovery`), and about 18 other state folders.
   - The code writes files in 176 places (`writeFileSync`/`renameSync`) and opens its own database connection in 255 places (`new WorkflowDb(`).
   - Copies drift apart. The 0.10.2 bug was two copies of the same recovery file.
4. **Version guards pile up instead of being replaced.**
   - The database has 1,346 triggers that block writes. Each table is guarded by up to 8 version checks (`structured_comms_v2`, `structured_authority_v3`, `protocol_v3`, `work_v4_*`, `handback_v3`, `graph_delivery_v4`, and so on).
   - Each new protocol version adds another layer instead of upgrading the data.
5. **Backward compatibility before 1.0.** There are 477 mentions of legacy, retired or compatibility code, and 118 versioned identifiers. Old behavior is kept alive in a tool with no outside users to protect.
6. **Giant files and functions.**
   - The `start` action (`cli/start.ts`) is one function about 2,300 lines long, with 77 mutable variables and 22 nested functions.
   - `workflowDb.ts` is 3,800 lines (316 KB).
   - 558 lines are over 300 characters long; the longest is 4,207 (`qaPreparation.ts`).
   - These are too big to read or review safely.
7. **Too many states.** QA has 14 states and 22 kinds of state change (`qaProtocolV2.ts`), and recovery adds 10 pending actions (`qaRecovery.ts`). Every combination is a possible bug.
8. **Bloated agent replies.**
   - One remediation reply was 5.6 KB, 8 levels deep, and stated the same fact about 8 times.
   - Codex doesn't enforce the schema, so the bigger the reply, the more chances to break it.
   - Details are in the malformed-reply doc.
9. **A command-line tool launching another command-line tool.** The `rafi` command starts ai-foreman as a separate process, assembling up to 17 flags (`buildResume.ts`) and 5 hidden internal ones. State is handed over through those flags and through files on disk.
10. **Tests check the pieces, not the whole run.**
    - There are 1,578 tests and the suite takes about 15 minutes.
    - 44 test files start real processes, and 52 places in the tests wait on timers, which makes them slow and occasionally flaky.
    - Only 3 fake-agent test helpers exist, so few tests can play out a whole build, while the bugs found live all happened across several steps.
11. **Fixes cluster in the same files.** Since 2026-09-01, 27 of 65 commits were fixes. `start.ts` changed in 22 of them, and `workflowDb.ts` and `qaReview.ts` in 17–18 each.

## Keep and rewrite

**Keep, slimmed down where useful:**
- The Codex and Claude connections (`adapters/`).
- The ticket and plan formats (`.tickets/tickets.yaml`, plan JSON).
- The `rafi-config.yaml` format and compile output.
- The agent instructions in `special-agents`.
- The user-facing commands people use day to day: `create`, `plan`, `tickets`, `start`, `resume`, `agents`, `manager`, `compile`, `uninstall`.

**Rewrite:** the rest of ai-foreman: the orchestrator, state, recovery, the QA loop, and the database. A solid version of this core is plausibly 5,000–10,000 lines.

**Decide during planning:** the commands that mainly exist to manage today's recovery machinery may merge into `resume` or disappear: `build:attach`, `build:decide`, `build:stop`, `build:resume`, `build:start-over`, `build:reset`, `handoffs`, `state`, `audit`.

**Decided 2026-11-01:**
- `build:attach` → folded into `rafi resume`, which attaches to a running build or resumes a stopped one.
- `build:stop` → kept, renamed `rafi stop`.
- `handoffs` → dropped. Hand-offs between agents become internal events in the log.
- `audit` → replaced by `rafi stats show`, because run history ships in 1.0 (decided 2026-11-01).
- `build:decide` → replaced by `rafi answer`, which answers any open question.
- `build:start-over` and `build:reset` → merged into one `rafi reset` that asks: this build, or everything?
- `build:resume` → folded into `rafi resume`, which needs no recovery mode because the interrupted step is redone (principle 3).
- `state` → replaced by built-in portability. Rafi's build progress (ticket status, open questions, saved answers and permissions) lives in a small text file committed with the project; a database file isn't committed, because it's binary and conflicts between branches. On another computer you clone, run `rafi resume`, and the build continues.
- **Logs can be exported.** `rafi create` asks where build logs go: kept on this computer (the default), or saved in the project so they travel with git. A separate `rafi logs export` writes one file (all runs, or one with `--run <id>`), and `rafi logs import` loads it on another computer for debugging.

**`rafi start` flags, decided 2026-11-01** (45 today, counted from `docs/cli.md`). Settings you choose once live in `rafi-config.yaml`, and flags are one-off overrides. The GUI and Maestro read the same settings (GUI-CFG-1, GUI-PLT-9), and org policies can lock them (GUI-ENT-3).

- **Kept: 19 flags,** 14 of today's plus 5 new ones (`--to-ticket`, `--skip`, `--auto-approve`, `--allow`, `--set`):
  - what to build: `--steps`, `--to-ticket` (new; use it or `--steps`, not both), `--stacks`, `--ticket`, and `--skip` (renamed from `--skip-delivery-unit`);
  - agents: `--agent`, `--model`, `--effort`, `--fast`;
  - approvals: `--auto-approve` (`-y` still works; the opt-in auto-approve feature) and `--allow internet,local-servers,…` (covers the builder and QA);
  - QA: `--no-qa`;
  - running: `--detach`;
  - git: `--branch-per-ticket` / `--no-branch-per-ticket`, `--completion` (`pr`, `pr-ready`, `auto-merge`, `direct-merge`, `none`), `--base`, `--dirty-work`;
  - `--set key=value` (new): override any config setting for one build, for example `--set qa.model=…`.
- **Dropped (11):** `--tickets <path>`, `--resume`, `--continue`, `--recover-run`, `--recovery-mode`, `--recovery-decision-digest`, `--qa-revision`, `--accept-handoff`, `--accept-handoff-role`, `--autonomy`, `--no-supervisor`.
- **Merged into the new flags (8):**
  - `--yes` → `--auto-approve`;
  - `--builder-network`, `--qa-network`, `--builder-approvals` → `--allow`;
  - `--create-pr`, `--no-create-pr`, `--pr-ready` → `--completion`;
  - `--skip-delivery-unit` → `--skip`.
- **Config only (12):** `--merge-method`, `--provider`, `--auto-merge-wait`, `--no-auto-merge-wait`, `--auto-merge-timeout-minutes`, `--branch-prefix`, `--max-branch-depth`, `--keep-worktrees`, `--show-session-cost`, `--hide-session-cost`, `--audit-logging` (it follows the `rafi stats` capture level), and `--auto-compact-threshold` (still needed when one agent is reused across tickets).
- **Per-role settings in config** (runtime, model, reasoning level and fast mode, for every role including QA), as the GUI requires (GUI-CFG-1).

## Work folded into the rewrite

These docs describe fixes to ai-foreman. The rewrite replaces that code, so they're built into the new engine instead of patched in the old one. Items marked **now** are small enough to also do on 0.10.x (track D in the planning guide). The requirements doc (guide step 1) must cover every item below, and carry each doc's open questions into its own open questions.

**From `MALFORMED_REPLY_AND_BLOCKED_BUILD_IMPROVEMENTS.md`** (moneyTree T002, 2026-10-29):
- 1: permission check for the whole build, before step 1 (principle 5).
- 2: no quiet substitutes; the builder reports "blocked" instead of swapping in a different stack. **Now.**
- 3: QA can run the full test suite, including local servers and temp files (principle 5).
- 4–6: one shared malformed-reply handler, one repair try, and the correct label (principles 4 and 6).
- 7: plain-English stops (principle 7).
- 8–11: smaller replies: each fact once, no echoed IDs, cite recorded commands, less nesting (principle 6).
- 12: remove the triple-check lines (principle 12). **Now.**

**From `QA_MANUAL_CHECKS_AND_RECOVERY_FINDINGS.md`** (moneyTree T001, 2026-10-28; its three bugs shipped in 0.10.2):
- Section 1, checks only a person can do. **Decided 2026-11-01: both.** The lighter alternative is the default; the full choices A, B and C stay available as a per-project or per-ticket setting. The options were:
  - the full choices: A (manual checks stop the build), B (no manual checks), and C (manual checks that don't stop the build);
  - the lighter alternative: Planner wording plus an operator checklist note (**now**, prompt change only), and an "I verified it myself" answer to "what next?".
- Section 2, loose ends:
  - The Builder fix mislabeled `delivery-uncertain` (same as malformed item 6).
  - Decisions meant for the user must reach the user, including in background builds. No agent answers them on the user's behalf. See the pending-decision registry below.
- Section 3, simplify QA pause and resume. Principles 2, 3 and 11 answer most of its questions. The requirements must also cover:
  - resume as one rule: find the last finished outcome, then act on it;
  - saved-decision keys that stay valid exactly as long as what they answered stays the same;
  - a "paused at X, then resumed" test table covering every state;
  - a fast test suite (fake clock, no real timers).

**From `PLAN_UPDATE_APPROVAL_IMPROVEMENT.md`** (2026-10-28):
- Locked requirements that no automatic plan update can change, drop or weaken.
- By default, change the plan and then tell the user: in the terminal, in the build summary, and in a durable plan-change log. Asking first is an opt-in setting.
- Keep the previous plan as a backup the user can switch back to.
- The setting is saved per project or per build, and is separate from `--yes`.
- QA always reviews against the plan in force. Saved approvals and QA results go stale exactly when the requirements they covered change.
- **Open questions, decided 2026-11-01:**
  - **Locked requirements:** marked on a single ticket requirement, or on a project-wide list (for example "always use PostgreSQL"), or both. The Planner keeps the marks when it rewrites tickets, and rafi checks that locked items are unchanged.
  - **What counts as a plan update:** anything that changes what gets built or checked (requirements, added or removed tickets, scope). Reordering tickets counts, and you're told. Pure rewording doesn't count.
  - **How you're told when away:** a notification, a line in the end-of-build summary, and a plan-change log you can open later.
  - **Switching back to a backup plan:** keep the code, re-run QA against the restored plan, and turn anything that fails into a fix ticket. Code is never deleted automatically.
  - **Backups:** all previous plans are kept; they're small text files.

**From `old-implemented-plans/STRUCTURED_PROVIDER_OUTPUT_MIGRATION_PLAN.md`** (shipped in 0.10.0–0.10.1, except this part):
- One shared, bounded format-repair policy for every operation (same as malformed items 4–5).
- Keep the raw reply and validation errors when parsing or repair fails.
- A repaired reply can't change the content without that being detected.
- Track the malformed-reply rate by provider and operation.

### From the older plan docs (2026-10-07 to 10-22)

Harvested 2026-10-30. The docs are now in `old-implemented-plans/`; `old-implemented-plans/README.md` says what happened to each one. Only what's still needed is listed here.

**QA reviews against one requirements file** (`QA_REQUIREMENT_REVIEW_AND_COST_CONTROL_REQUIREMENTS.md`, `SEVEN_SIMPLIFICATION_PROPOSALS_*.md`):
- Before building, a Markdown requirements file is written for each ticket: requirement IDs, acceptance criteria, what's in and out of scope, the commands to run with expected results, and known risks.
- Rafi stores only its path and fingerprint, and gives QA the path. It never re-pastes the content into prompts.
- QA answers per requirement: satisfied, not satisfied, not applicable (only if the file allows it), or unable to verify, naming what's missing.
- QA doesn't add scope the file doesn't ask for.
- If the file is missing or changed, rafi warns, QA marks the affected requirements "unable to verify", and the build carries on. It never stops the build by itself.

**Rafi records facts once and never asks an agent to repeat them** (same sources):
- Command results, exit codes, changed files, IDs and times are recorded by rafi. If an agent's report disagrees, rafi's record wins and the mismatch is logged. It doesn't trigger a retry.
- No agent turn is spent on facts rafi already knows.
- Rafi is a thin coordinator around the agents, not a third agent: each job is done once and recorded once.

**Short references, and only facts the agent can see** (`LIVE_E2E_QA_COVERAGE_FAILURE_RESOLUTION_PLAN.md`):
- Agents refer to checks by short numbers ("check 3"), never long hash IDs. A Codex reply once merged two hash IDs into an invalid one. This extends malformed-reply item 9.
- Rafi never asks for a fact the agent can't observe. For example, Claude's tool events have no numeric exit code, so a requirement must not demand one from Claude.
- Rafi never guesses which ID an agent meant (no nearest match).

**Every agent turn is measured** (`QA_REQUIREMENT_REVIEW_AND_COST_CONTROL_REQUIREMENTS.md` §2):
- Each turn records: role, provider, model, start and end, and time split between the agent, tools and rafi itself. It also records tokens, and the reason for every retry or hand-off.
- Per run and per ticket: duration, number of turns, retries, and agent time versus rafi time.
- A build ends with a short summary of cost and time.
- This lives in the event log (principle 1), and it's what the GUI dashboard reads.

**Run history and replay** (`FULL_RUN_FORENSIC_REPLAY_IMPLEMENTATION_PLAN.md`; never built):
- Proposed: capture levels `none`, `normal` and `detailed`, and a `rafi stats` command group: `show`, `timeline`, `compare`, `export`, `replay` and `delete`. Recorded data is never deleted automatically.
- **Decided 2026-11-01: in 1.0.** `rafi stats show` replaces `rafi audit`. The event log must make "show me the timeline of this run" a simple read. That replaces the manual log-reading routine in `CURRENT_SESSION_HANDOFF.md`.

**Copy and fingerprint only when needed** (`QA_REQUIREMENT_REVIEW_AND_COST_CONTROL_REQUIREMENTS.md` §4):
- Copy the project for QA, or fingerprint the whole tree, only when the ticket needs it.
- Record why it was needed and how long it took.

**Retry limits** (same doc, §6): never resend the same request without a changed input or a set attempt limit. This matches principle 4.

**Cautions from the earlier audit** (`SEVEN_SIMPLIFICATION_PROPOSALS_CODEBASE_AUDIT.md`). That audit argued against a rewrite. Its warnings still apply to the new design:
- **No second source of truth.** Anything shown to agents (the Markdown file, a review packet) is a view of the event log, not a separate copy.
- **Measure before optimizing.** Provider wait time, not rafi's own work, made up most of the gap between Claude and Codex.
- **Diagnostics must not become gates.** A bookkeeping mismatch must never block a valid review.
- **Keep real safety checks.** For example, protecting files a ticket isn't allowed to touch. Delete only checks that guard rafi's internal hand-offs (principle 10).
- **Don't trust a "low risk" label blindly.** Any shortcut for low-risk tickets needs a minimum that rafi enforces.

**Past bugs to turn into scenario tests** (for guide step 4; from `MONEYTREE_RAFI_BUILD_FINDINGS.md`, `crash-fix-docs/` and `rafi-incident-2026-10-14/`, all fixed in the current engine):
- A project with no git commit yet, or with huge ignored folders: capture must respect `.gitignore` and stay fast. Long work must not block heartbeats.
- Untracked folders don't crash start-over or reset.
- Resuming a batch keeps the whole approved batch. A bug once shrank 34 tickets to 1.
- Finishing some of a batch never marks the whole run done.
- A question during a build can be answered in the same terminal, without exiting and resuming.
- Printed recovery commands work when copied, even with spaces, quotes or symbols in the answer.
- Network access stays off unless granted, and the builder explains the restriction instead of failing quietly.
- A blocked ticket keeps its reason. Cancel, pause and crash are recorded as different outcomes.

**Still open from the incident** (`rafi-incident-2026-10-14/`): U1. Claude's context-compaction threshold differs from what rafi sets. The adapters are kept, so the requirements should note it as an adapter issue.

### From the `docs/` plans and `rafi-plan-docs/` (2026-10-07 to 10-25)

Harvested 2026-10-31. The implemented ones are in `old-implemented-plans/docs/`; the harness plan is in `no-longer-relevant-plans/rafi-plan-docs/`. Both folders have a `README.md` that says what happened to each doc.

**Product decisions you already made** (`build-stall-repair-plan.md`); the new engine must keep them:
- **Start automatically when the approved scope is unchanged.** `rafi start . --steps 10` reuses the approval of the selected plan and tickets, and only asks about material changes.
- **Keep going when one ticket is blocked.** Show the blocker right away, hold back the tickets that depend on it, and keep building the ones that don't. A project-wide problem (permission, integrity) still stops everything it affects. Refined on 2026-10-31: rafi asks the user right away instead of waiting until nothing is left, and never exits on its own. See "Blocked tickets: keep going and ask".

**Current features: decided 2026-11-01.**
- **QA preparation** → changed: it becomes the per-ticket requirements file ("QA reviews against one requirements file").
- **Graphify** → kept, as a tool given to agents through tags ("Test tools").
- **Manager QA access** → kept, reading the event log.
- **Terminal colors** → kept.
- **`rafi plan:doctor`** → merged into `rafi resume`.
- **Building on uncommitted work** (`--dirty-work`) → kept.

The archived specs for these features:
- **QA preparation before building** (`qa-prebuild-requirements.md`, `qa-preparation-configuration-and-codex-enforcement-plan.md`): `qa_preparation: true` in `rafi-config.yaml`, with the planner choosing a preparation depth per ticket. This is the natural source of the requirements file above.
- **Graphify for agents** (`graphify-agent-integration-requirements.md`): turned on during `rafi create`, then used selectively by the agents.
- **Manager QA access** (`manager-qa-and-resume-resolution-brief.md`): ask Manager for any ticket's QA reports, why a ticket keeps cycling, and send guidance to the Builder or QA.
- **Terminal colors** (`terminal-color-requirements-plan.md`): a shared color policy, with no color codes in non-terminal output.
- **Recovery commands:** `rafi plan:doctor`, `build:reset`, and building on top of uncommitted work (`rafi-reliability-implementation-results.md`, `docs/reliability-workflows.md`).

**More past bugs to turn into scenario tests** (for guide step 4). Most are fixed in the current engine. O-E2E-005 and O-E2E-004 aren't confirmed fixed, so check them against today's rafi in guide step 6:
- `--steps N` must not stop early. A branch run once stopped after the first delivery unit, and `tickets queue` then said "No remaining tickets" (`rafi-online-e2e-findings-2026-10-13.md`, O-E2E-005).
- Ticket states written by the planner are validated before they're applied (O-E2E-001).
- A non-interactive plan never opens interactive prompts (O-E2E-006).
- Start-over and QA hand-offs leave no stale session pointers for a later resume to reuse (`build-stall-investigation.md`).
- A failed planning step can always be recovered, including a failure while applying tickets (O-E2E-002).
- Claude's harmless failed reads and commands during exploration don't show up as repeated "tool failed" lines (O-E2E-004).

**Adapter issue to note:** Codex context usage was once calculated from total tokens used across the session, which triggered compactions that weren't needed (`build-stall-investigation.md`). The adapters are kept, so the requirements should confirm this is fixed.

**The harness improvement plan** (`rafi-plan-docs/`, 2026-10-10; never carried out). It was a 47-step program to harden the current engine, so the rewrite supersedes it as a plan. Two parts are still useful input:
- **Part 1, tests and measurement (E01–E18):** a fake provider and event simulator, crash testing of saved state, a suite per historical bug, a corpus of representative work, and a fair experiment runner. Use it when designing the scenario harness (guide steps 4–6).
- **Parts 3 and 4, outside practices and ideas (H01–H14, F01–F12). Decided 2026-11-01:**
  - **In the rewrite:**
    - F09, spotting an agent going in circles (principle 4);
    - H14, rules for outside tools ("Test tools");
    - H12, a project setup script so fresh agents are cheap (principle 15);
    - H01 and H02, checking the native Codex and Claude features during the architecture step (guide step 7);
    - F11, a fallback when a model lacks a feature (principle 16).
  - **Already covered:**
    - F01, measuring experiments (principle 13);
    - F04, fresh sessions (TODO item 4);
    - F10, fewer interruptions ("Ask everything up front");
    - F12, removing what doesn't help (this rewrite);
    - H11, Playwright ("Test tools").
  - **Later, after 1.0:**
    - F02, bigger chunks per agent;
    - F03, reviewing less often;
    - F05, choosing a model per job;
    - F06, parallel tickets in one build;
    - F07, reusing checks;
    - F08, examples and self-check policies;
    - H03–H10 and H13, other frameworks and runtimes.

## What the GUI needs from the engine

`GUI_PRODUCT_REQUIREMENTS.md` §11 lists platform needs. The GUI is built after the rewrite, but the new engine must make these possible without another rewrite:

| GUI need | What the rewrite does |
|---|---|
| GUI-PLT-2: unified event stream, ordered and replayable by cursor | The event log (principle 1) is the stream. Events are typed, and readable from a cursor. |
| GUI-PLT-3: command/action API with the same validation as the CLI | One engine library (principle 9) that both the CLI and a future daemon call. |
| GUI-PLT-4: pause and steer at safe points | Step boundaries in the state machine (principle 2) are the safe points. |
| GUI-PLT-5: more than one build per checkout | Keep state per run, not per checkout. Design for it; don't build it yet. |
| GUI-PLT-6: pending-decision registry | Every question to the user is a recorded event with type, options, context and time. It can be answered from any surface (terminal, desktop notification, GUI sidebar or modal, the instance view); the first answer wins and closes the rest. See "Notifications". |
| GUI-PLT-10: permission/policy engine | The upfront permission check (principle 5) is its first version. |
| GUI-PLT-11: schema-first contracts in `rafi-spec` | Event and reply formats are defined in `rafi-spec`. |

Not part of the rewrite, but not blocked by it: GUI-PLT-1 (daemon), 7 (cost normalization), 8 (remote runners) and 9 (declarative instance spec).

## Design principles

1. **One source of truth.** A single SQLite database holds an append-only event log, recording every event in order. Current state is calculated from it. There are no JSON run files or recovery folders duplicating it.
2. **A small state machine.**
   - Each ticket is in one of about six states: queued, building, reviewing, fixing, done, blocked.
   - Transitions live in one pure function, `next(state, event)`, which is tested over every combination.
3. **Every step can be safely redone.** Each agent turn is keyed by run, ticket and step. After a crash, rerun the step instead of proving what happened. Redoing one agent turn is cheap; stopping the build is expensive.
4. **Retry by default.** Every error is sorted into one of three groups:
   - **Retry automatically, with backoff:** bad JSON, timeouts, format slips, transient provider errors. The error is sent back to the agent.
   - **Permission needed:** asked upfront for the whole build, before step 1 (below).
   - **Ask the user:** the last resort, only after retries are used up or when it's a real product decision.
   - **Spot going in circles** (harness plan F09). Progress means a requirement passes, a check result changes, or a blocker is resolved. If several attempts fail the same way with no progress, rafi stops retrying that ticket and asks, even when attempts are left. Healthy exploration (new files read, different fixes tried) doesn't count as circling.
5. **Ask everything up front** (see "Ask everything up front" below).
   - Inspect every ticket and step in the requested build for what it needs: internet, local servers, packages not yet installed, live services.
   - Ask once, right away, even if only step 20 needs it.
   - Choices:
     - **Allow once:** this build only.
     - **Always allow:** saved for the project.
     - **Don't allow:** the steps that need it are marked blocked, and the reason is shown up front.
   - Covers the builder and QA.
6. **Simple agent replies.**
   - Small, flat JSON: each fact once, and no echoing IDs rafi already has.
   - The builder cites commands rafi already recorded instead of retyping their output.
   - One shared handler for malformed replies, with one repair try.
   - Optionally, the builder reports in plain text and one short, strict extraction call turns it into JSON (this needs a direct model call).
7. **Plain-English stops.** Every stop says, in one line, what happened, why, and the exact command to continue. Never raw JSON.
8. **No compatibility layers before 1.0.** Database changes are made with ordinary migrations, not version-guard triggers. Old code paths are deleted, not kept.
9. **One process, small modules.** The `rafi` command calls ai-foreman as a library, in the same process: no CLI-on-CLI, no hidden flags. Files stay under about 500 lines, and lines stay short.
10. **Fingerprint checks only where they protect your code**, for example never overwriting your own uncommitted changes. Not on rafi's internal hand-offs.
11. **Tests that play out whole builds.**
    - A scripted fake agent runs complete builds: multiple tickets, QA failures, fixes, and malformed replies, with a forced crash at every step followed by a resume.
    - The suite runs in seconds. Real-process tests are a small separate set.
12. **QA instructions.** Remove the hard-coded triple-check lines (`foreman.ts` `buildQaInstruction`, and the QA hand-off text in `qaReview.ts`). Keep "Do not rubber-stamp your own work. Be skeptical."
13. **Short, consistent agent instructions that require validation.** See `AGENT_INSTRUCTIONS_REVIEW.md` for the measurements and sources.
    - **Every agent validates before it reports.** It checks a fact against the code, files, logs or command output, and says "unable to verify" when it couldn't.
    - **Send the rules once,** in the agent's standing instructions. Per-turn messages carry only what's new: today the same rules go out up to 7 times in one session.
    - **Pick rule packs per ticket.** Load skills when relevant, not preloaded. Send the assigned ticket, not the whole queue.
    - **No contradictions.** Never "ask the user" in an unattended build; say "report needs-input" instead. Nothing describes a command or protocol that doesn't exist.
    - **Plain language with reasons,** no pressure wording.
    - **Rafi-owned files carry a version and are regenerated on upgrade.**
    - **Measure.** A cut stays only if the scenario harness pass rate holds.

14. **Auto-approve almost everything, as an opt-in feature.** It's off by default; without it, rafi asks about approvals much as it does today. When it's on, a question is allowed only when no setting, saved answer or approval mode could have answered it.
    - Approval modes from the GUI doc (GUI-INS-6, GUI-PLN-8): manual, or auto-approve, per project or per instance.
    - A coordinator can set them for you, for example Maestro told "build this plan automatically, approve everything" (GUI-MAE-4).
    - `--yes` and auto-approve answer every question that has a safe default. What's left are things only you can do, such as installing software or giving a password.
15. **A project setup script** (harness plan H12). The project keeps one setup script, written and kept current by the builder, that installs dependencies, starts the needed services and runs the tests. Every fresh agent runs it first instead of rediscovering the project. Anthropic's prompting guide recommends this for work across fresh context windows (an `init.sh`).
16. **A fallback when a model lacks a feature** (harness plan F11). Each adapter reports what its model can do: structured replies, exit codes, session resume, images. When a feature is missing, rafi uses a known fallback instead of failing or asking for something the agent can't see. For example, Claude's tool events have no numeric exit code, so rafi relies on its own recorded command result.

## Agent context: tags

Decided 2026-11-01. Rafi gives each agent only what its ticket needs. Today every agent gets everything, repeatedly: in T002 the builder received the same rules 7 times, 4 full skills, the whole ticket queue, and the AI rules on a ticket with no AI work (`AGENT_INSTRUCTIONS_REVIEW.md`).

- **Tickets have tags,** such as `ui`, `database` or `mobile`.
  - **The Planner tags each ticket** when it writes it, and QA preparation double-checks. You can edit the tags.
  - **The tag list** is a fixed list owned by rafi, plus project-specific tags. An unknown tag is rejected at planning time.
- **Rule packs, skills and tools carry tags too.** Each agent gets a small always-on core, plus whatever matches its ticket's tags. Skills are listed by name and description and opened when needed.
- **QA gets the same tags as the builder,** so it reviews against the same rules.
- **A fresh agent per ticket, for the builder and QA, is the default.** This changes today's `session_strategy` default, `compact`, to `fresh`. The project setup script (principle 15) keeps each fresh start cheap.
- **Reusing one agent across tickets is an override.** That agent gets the tags of every ticket in scope (`--steps` or `--to-ticket`). They're re-checked before each ticket, because the scope can change mid-build; tags are added, never removed.
- **Not decided yet:** whether each ticket's likely files also add tags automatically, as a safety net.
- **Scenario tests:**
  - a non-AI ticket gets no AI rules;
  - an unknown tag is rejected;
  - a reused agent picks up a new ticket's tags;
  - QA and the builder get the same tags.

## Ask everything up front

Decided 2026-11-01. Rafi is built for AFK builds, so a question in the middle of a build may sit unanswered for hours while you think rafi is still building. Rafi therefore moves every question it can to before the build starts.

- **When it scans:** right after tickets are made. You answer once, there, and that's it. Before each build (`rafi start`, `rafi resume`), rafi asks only questions still unanswered, plus any new ones from tickets added or changed since.
- **What it scans:** every ticket in scope (`--steps`, `--to-ticket`, or all) for anything that will need you:
  - permissions: internet, local servers, installs, live services;
  - credentials or secrets the ticket needs;
  - checks only a person can do;
  - decisions the Planner flagged as open;
  - the plan-update setting, if it isn't saved yet.
- **How it asks:** one list, all at once. Each item says which tickets need it.
- **Choices per item:** answer now, including "always" where it fits, or **answer later**.
- **Answer later:** the question is saved, the tickets that need it wait, and the build starts with everything else. Rafi reminds you through notifications, and the question stays in the open-questions list.
- **The goal is zero questions mid-build.** Any question that does come up mid-build is recorded as a gap, so the scan can learn to catch it next time.
- **You can always tell when rafi is waiting on you.** The terminal title and status line show "Waiting on you since 14:05 (T2)". So do `rafi status` and the end-of-build summary, which reports how long rafi waited.
- **Scenario tests:**
  - the scan finds every question for a 20-step build before step 1;
  - "answer later" builds everything else;
  - a mid-build question is logged as a scan gap;
  - "waiting since" shows in the status.

## Blocked tickets: keep going and ask

Decided 2026-10-31. When a ticket is blocked mid-build, rafi tells the user at once, keeps building what it can, and waits for an answer without exiting. The upfront scan ("Ask everything up front") should catch most blocks before the build starts; this covers the rest.

**Example.** `rafi start . --steps 5`. T1 finishes. T2 is blocked because it needs internet to install PostgreSQL. T5 depends on T2.

1. Rafi records the question and starts T3 straight away.
2. A desktop notification goes out (see "Notifications").
3. A prompt is pinned at the bottom of the terminal while the T3 output scrolls above it:

```
⚠ Ticket T2 is blocked.
  Reason: Internet needed to install PostgreSQL.
  Also waiting: T5 (needs T2).
  Starting ticket T3.
  1. Grant internet access (this build / always for this project), then retry T2
  2. I fixed it myself (for example, installed PostgreSQL), retry T2
  3. Skip T2 for now
  4. Give the builder instructions, then retry T2
  5. Change T2 with the Planner, then retry T2
  6. Drop T2 (won't do)
  7. Stop the build
> _
```

**Rules:**
- **The message:** one line each for what's blocked, why, which tickets wait on it, and what rafi is doing now. It shows the builder's own reason, never raw JSON (principle 7).
- **Options:** only the ones that fit the reason are shown. For example, "Grant access" appears only when the reason is a permission.
  - **Grant access:** the same choices as the upfront check, for this build or always for this project.
  - **Fixed it myself:** rafi retries the ticket.
  - **Skip for now:** the ticket and its dependents stay blocked. The question stays in the open-questions list, and rafi reminds you when the build ends.
  - **Instructions:** your note is sent to the builder with the retry.
  - **Planner:** uses plan update approval, then retries the changed ticket.
  - **Drop:** the ticket is marked won't-do. Tickets that depend on it are flagged so you can decide about them.
  - **Stop:** ends the build. The question stays saved for `rafi resume`.
- **Answer any time.** The prompt stays pinned while other tickets build. You answer by typing a number. A retry starts as soon as the current ticket finishes; it doesn't interrupt the ticket in progress.
- **Several blocked tickets:** each gets its own pinned question, oldest first.
- **Nothing left to build:** rafi keeps waiting, with the question showing, and sends a reminder notification. It never exits on its own. Ctrl+C stops it, and the question stays saved for `rafi resume`.
- **`--steps N` counts finished tickets.** A blocked or skipped ticket doesn't use a step, so rafi pulls the next eligible ticket to reach N. Today's engine already counts this way (`foreman.ts:1039`).
- **New flag `--to-ticket <id>`:** build everything rafi can, in queue order, up to and including that ticket. With `--to-ticket T4`, rafi builds T1, T3 and T4, and asks about T2 as above. If the target itself depends on a blocked ticket, the prompt says so. `--steps` and `--to-ticket` both set where the build stops, so only one can be used (decided 2026-11-01). For example, with 2 of the first 5 tickets blocked, `--steps 5` goes on through ticket 7 to finish 5, while `--to-ticket T5` stops at T5 with 3 finished.
- **A build-wide problem** (integrity, a project-wide permission) still stops affected work, with the same style of message and options.

**Scenario tests** (add to guide step 4):
- block, keep building, answer mid-build, retry;
- skip, then the reminder at the end;
- drop with dependents;
- nothing left while waiting;
- `--steps` counting finished tickets;
- `--to-ticket`;
- two blocked tickets at once;
- answering from a notification instead of the terminal.

## Notifications

Requested 2026-10-31. When rafi needs the user, it sends a desktop notification. Where the platform allows, the user can pick an answer right in the notification.

- **One question record, many places to answer it.** Each question is a recorded event (GUI-PLT-6). It can be answered from:
  - the pinned terminal prompt;
  - a desktop notification;
  - `rafi answer`, or Manager;
  - later, the GUI.

  The first answer wins. The other places close, or update to show "answered in …".
- **The notifier lives in the engine,** not the terminal or browser, so notifications work for background builds and for the GUI.
- **Platforms** (checked 2026-10-31):
  - **macOS:** `alerter` (github.com/vjeantet/alerter) shows action buttons, with several choices as a dropdown, or a reply box, and prints the chosen action. `terminal-notifier` no longer supports action buttons. A code-signed desktop app (for example Electron) supports actions and inline replies. Electron's docs say notifications need a code-signed app on macOS.
  - **Linux:** `notify-send --action` (libnotify 0.8.x) shows buttons and prints the chosen action.
  - **Windows:** Electron notifications support actions (`selectionIndex` is Windows-only). Not tested.
- **Command line on macOS (decided 2026-11-01):** `alerter` is an option rafi offers to install, for answer buttons. If it's missing or broken, rafi falls back to plain notifications. The GUI app replaces it with its own notifications.
- **Fallback:** when choices can't be shown, the notification says what's needed and opens the terminal or GUI view for that question.
- **Long option lists:** a notification shows the most likely choices, plus "More…", which opens the full list.
- **Settings:** on by default, with per-event preferences and reminder timing. Quiet hours come with the GUI (GUI-ATT-3).
- **Scenario tests:** a fake notifier records what was sent and can answer, so the harness can test answering from a notification.

## Test tools

Decided 2026-11-01. Agents can use tools such as a browser or a phone when a check needs them, without bloating rafi.

### How tools work

- **Rafi ships one built-in tool, Playwright, and fully supports mobile-mcp.** `rafi create` offers Playwright when the project has a frontend, and mobile-mcp when it has a mobile app. The other known tools are optional plug-ins.
- **A tool is an MCP server or a command,** saved in `rafi-config.yaml` under `tools:`. That file is committed, so the tools travel with the project. Each entry says:
  - how to start the tool;
  - a one-line description;
  - which roles get it (builder, QA);
  - the tags it serves (for example `ui`, `mobile`, `push`).
- **Adding a tool:** `rafi tools add <name>`, or from a prompt. It writes the config entry, checks the prerequisites and explains anything missing. Where connecting needs boilerplate, rafi writes it into the project (see "Known tools").
- **Today rafi has no tool setup.** It only displays MCP tool calls in activity output (`adapters/codex.ts:1070`).
- **Rules for every tool** (harness plan H14). Each tool entry defines:
  - its permissions (they go into the upfront permission check);
  - how rafi cancels or stops it;
  - how its results are recorded as evidence;
  - which versions are supported;
  - its license.

  Tool output is untrusted data, never instructions.

### How agents know to use a tool

- **QA retry:** when QA reports "unable to verify" and you connect a tool from the prompt, the retry message names the tool and the requirement. For example: "You now have `playwright` (browser). Use it to verify R3: the file appears in the panel." Rafi tells the agent; it doesn't rely on the agent remembering.
- **Later tickets and runs:** every agent rafi starts gets the tools matching its ticket's tags, in the same way as rules and skills (TODO item 4). A fresh agent therefore gets the tool every time, without being told twice.
- **The builder:** when a tool is added, rafi re-tags the remaining tickets (the Planner or the up-front scan), so upcoming tickets that need it get it. Each ticket's instructions list "Tools for this ticket: playwright, for …". If the builder must write code that uses the connection (tests that drive a device, for example), the tool's setup notes are saved in the project docs, and the ticket points to them.

### Parallel builds

- **Isolated browsers:**
  - Playwright tests run headless by default, and each test gets an isolated, incognito-like browser context.
  - The Playwright MCP server shares one saved profile by default ("a persistent profile can only be used by one browser instance at a time"), so rafi starts it with `--isolated` for each agent.
- **Own port per build:** rafi gives each build its own app port, so two builds don't both start the app on `localhost:3000`.
- **Devices:** a physical phone is locked to one build at a time. Other builds wait or use a simulator or emulator.
- **Headless with recordings:** Chrome's headless mode runs the same code as normal Chrome. A "show the browser" option opens a visible window for one build.
  - **What's saved:** one screenshot per checked requirement, as QA's evidence. For a failed check, also a video and a Playwright trace.
  - **Default is failures only.** Playwright calls tracing every test "performance heavy", so rafi uses its `retain-on-failure` mode by default. There's a setting to record everything.
  - **What a trace is:** a zip of every action, before-and-after page snapshots, network requests, console logs and the matching test code. Open it with `npx playwright show-trace` or trace.playwright.dev.
  - **Why:** so you or QA can see exactly what failed without re-running it, and so QA's "passed" cites a screenshot rather than a claim (principle 13).
  - **Where:** with the build logs, so `rafi logs export` includes them.
  - **How long:** a setting with five choices: until the ticket is finished, until the build is finished, the last N builds, N days, or until you delete them. **The default is the last 5 builds.**
- **Permission:** QA needs access to local servers. The upfront permission check covers it (malformed-reply item 3).

### Known tools

Rafi knows these tools and can set them up. Details were checked 2026-11-01; they change, so the setup check confirms them on your machine.

| Tool | What it's for | Setup rafi handles or explains |
|---|---|---|
| **Playwright** (built-in) | Web UI tests (test runner), and an agent clicking around (MCP server) | Install, `--isolated`, per-build port, recordings |
| **mobile-mcp** ([mobile-next](https://github.com/mobile-next/mobile-mcp), Apache-2.0) | An agent driving iOS and Android apps on simulators, emulators and real devices | Needs Xcode command line tools, Android Platform Tools and Node 20+. iOS device: connected by USB and trusted. Android device: `adb` with USB debugging on and authorized. Added with `claude mcp add` or `codex mcp add` |
| **Appium** (XCUITest, UiAutomator2) | Scripted device tests | Real iOS devices need Xcode and an Apple developer team to sign WebDriverAgent. Android needs the Android SDK, a JDK and USB debugging |
| **Maestro** (mobile.dev) | Readable YAML flows for mobile UI tests | Needs Java 17+. The name clashes with the GUI's Maestro coordinator (GUI open question 11) |
| **iOS Simulator push** | Testing notifications without a phone | `xcrun simctl push <device> <bundle-id> payload.apns`. The simulator can't receive real server pushes |
| **Real push to a device** | Testing real notifications | APNs: development builds use `api.sandbox.push.apple.com`. FCM: the HTTP v1 `messages:send` API or the Firebase console's test message |

**Boilerplate rafi provides when you add a tool:**
- a sample `payload.apns` plus a send script for simulator pushes;
- a send script for APNs sandbox or FCM test pushes, reading keys from your environment and never from committed files;
- a starter Playwright config with the per-build port;
- the device-check steps (for example, `adb devices` lists the phone).

**Scenario tests:**
- QA "unable to verify", then a tool is connected and QA retries with it;
- a later ticket gets the tool through its tags;
- two builds use Playwright at once without collisions;
- a device locked by one build.

## Process

The goal is a smooth rewrite **and** a rafi that works the same for the user afterwards.

For a step-by-step version with a prompt for each step, see [`AI_FOREMAN_REWRITE_PLANNING_GUIDE.md`](AI_FOREMAN_REWRITE_PLANNING_GUIDE.md).

1. **Freeze the current version.** Keep 0.10.x as the stable release, with bug fixes only. All rewrite work happens on a branch.
2. **Write down what must not change.**
   - A requirements doc of user-visible behavior: commands, flags, prompts, files rafi reads and writes in a project, and ticket and plan formats.
   - Source it from the CLI help, the docs and `GUI_PRODUCT_REQUIREMENTS.md`.
   - Include every item in "Work folded into the rewrite" and "What the GUI needs from the engine".
   - This is the contract for the rewrite.
3. **Build the behavior test suite against the current rafi first.**
   - Black-box scenario tests that drive the `rafi` command with a scripted fake agent:
     - start a build;
     - QA fail, fix, pass;
     - blocked ticket;
     - permission prompt;
     - crash and resume;
     - multi-ticket batch;
     - plan updates.
   - Record which scenarios work today; the failures are the bugs to beat.
   - The new core must pass every scenario before it replaces the old one.
4. **Plan the architecture.**
   - Write a plan from this doc and the requirements doc: modules, event log schema, state machine, error categories, agent reply formats, and a milestone list.
   - Then get an independent review in a fresh session, ideally with a different model (see "Models" below), and revise.
5. **Build the new core side by side.**
   - A new engine behind a switch (for example `RAFI_ENGINE=next`), not edited in place.
   - The same `rafi` commands call either engine, and the old engine stays the default.
6. **Milestones**, each passing its slice of the scenario suite before the next starts:
   1. Event log, state machine, and the fake-agent test harness.
   2. Agent connections and simple reply formats, including the repair try.
   3. The build loop: one ticket, builder only.
   4. The QA loop: review, fix, re-review, retry limits.
   5. The upfront permission check, plain-English stops, blocked-ticket prompts and notifications.
   6. Crash and resume: redo the step.
   7. Multi-ticket batches, plan updates, `tickets` and `manager` integration.
7. **In-progress builds.** Don't migrate runs that are already in progress: they finish on the old engine (0.10.x). The new engine starts fresh runs and reads the existing tickets, plans and config unchanged.
8. **Dogfood.** Build moneyTree T002 onwards on the new engine, with the old engine still available as a fallback. Fix what breaks, and add each failure as a scenario test.
9. **Switch the default.**
   - After a run of clean builds, make the new engine the default.
   - Keep the old one for one release, then delete it along with its database, triggers and state folders.
   - Release as `@rafi-ai/cli` 1.0 / ai-foreman 3.0.

## Models

| Stage | Model | Reasoning |
|---|---|---|
| Requirements doc, architecture plan, final reviews | The most capable model available | High or extra-high; max only for the final architecture review |
| Independent plan review | A different model family (for example Codex/GPT) | High |
| Milestone implementation | The most capable model | Medium–high |
| Routine work (scenario tests, mechanical changes) | A faster model is fine | Medium |

Always review in a fresh session that hasn't seen the implementation conversation.

## Success criteria

- A multi-ticket moneyTree build finishes without a person, except for upfront permission prompts and real product decisions.
- No stop happens because of a malformed reply, a timeout, or a crash.
- Every stop says, in one line, why, and how to continue.
- The full test suite runs in under 1 minute, including crash-at-every-step scenarios.
- The core is under 10,000 lines, files are under about 500 lines, and there's one source of truth.
