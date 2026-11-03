# Rewrite architecture

Status: **locked** (guide step 9, 2026-11-02). Reviewed and decided; changes now need the user's approval. Build handoff: `REWRITE_BUILD_HANDOFF.md`.
Inputs: `AI_FOREMAN_REWRITE.md` (RW), `REWRITE_REQUIREMENTS.md` (REQ; section 9.0 wins over older rows), `REWRITE_SCENARIOS.md` (SCN; section 11 decisions are final), Part 3 of `../rafi-2/rafi-plan-docs/rafi-harness-requirements.md` (H01–H02), and today's code on `feature/rewrite` (ai-foreman 2.0.2, `@rafi-ai/cli` 0.10.2).

This doc says how the new engine is built: its modules and size budgets, the event log, the three state machines, errors and retries, agent replies, the upfront check and the question record, how `rafi` calls the engine, the engine switch and `rafi migrate`, tags, tools and notifications, what native Codex and Claude features replace, and what's deleted. It ends with the milestones, each mapped to the scenarios it must pass, and the few decisions I need from you.

Nothing here reopens a decided item. Where REQ or SCN left a detail to this plan ("set in the architecture plan"), section 13 lists what I set.

## 0. How to read this doc

- Code citations are `path:line`, relative to `packages/` unless the path says otherwise; `node_modules/…` paths are relative to the repo root. I checked each one on 2026-11-01 against `feature/rewrite`.
- **Unverified** marks something I couldn't check, with what would confirm it.
- Requirement IDs (CMD-…, FLAG-…, NEW-…, FMT-…) are from REQ. Scenario IDs (S-…), D1–D9 and OQ-1–6 are from SCN. Q-… decisions are REQ 9.0 and 9.1 (9.1 rows are decided as recommended unless 9.0 says otherwise).
- "Line" budgets count lines of TypeScript, comments included, as `wc -l` does.

| Section | Contents |
|---|---|
| 1 | The shape in one page; how it avoids the bad patterns; the security model |
| 2 | Packages, modules and size budgets |
| 3 | The event log: tables, event types, versioning, derived state, the progress file |
| 4 | State machines: ticket, build, project; what the loop does next; safe points; workflows and roles as data |
| 5 | Errors and retries |
| 6 | Agent reply formats |
| 7 | Ask everything up front; the question record; blocked tickets; grants |
| 8 | How `rafi` calls the engine: `runCli(argv, deps)`, the seams, the engine API, the terminal, resume and stop, settings, `--detach`, exit codes, `rafi reset`, `rafi status` |
| 9 | The engine switch and `rafi migrate` |
| 10 | Tags, instruction assembly, tools, notifications |
| 11 | Native Codex and Claude modes (H01–H02); the fake `claude` executable (D9) |
| 12 | What's deleted, and what's kept |
| 13 | Details the requirements left to this plan |
| 14 | Milestones, mapped to scenarios |
| 15 | Decisions (all decided) |

## 1. The shape in one page

- **One engine library, called in-process.** A new package, `packages/engine`, holds the engine. The `rafi` command calls it through `runCli(argv, deps)`. No child `rafi` or `ai-foreman` process, no hidden flags, no hand-off environment variables (principle 9).
- **One event log.** One SQLite file per checkout, `.rafi/state.sqlite3`, holds an append-only event log. All state is a fold of that log through three pure functions: `nextTicket`, `nextBuild` and `nextProject`. A fourth pure function, `decide`, says what the build loop does next. Besides the log there's a lease row (who is running a build right now) and a blob table for large, bounded payloads. That's all (principle 1; today: 95 tables, RW:28).
- **A loop that redoes steps.** The build loop is: fold the log, decide, run one step, record its outcome, repeat. A step is the unit of redo. After a crash or a stop, `rafi resume` folds the log and runs the interrupted step again. Nothing is proven (principles 2 and 3).
- **One turn runner for every agent turn.** Two slim adapters reach Codex (app-server) and Claude (Agent SDK); their transports come from `deps`. The turn runner sends a turn, validates the reply, makes one repair try for broken JSON, retries everything else with backoff, and spots circling (principles 4 and 6).
- **Questions are records.** Every question to you is an event. Any surface answers it (terminal, notification, `rafi answer`, Manager, later the GUI); the first answer wins. The engine owns notifications; the terminal UI is a view (NEW-GUI-5, NEW-NOT-1, NEW-NOT-2).
- **A committed snapshot.** `.rafi/progress.yaml` holds ticket status, open questions and saved answers. It's rewritten from the log at every safe point. A fresh clone rebuilds its database from it (Q-PORT-4).

```
rafi (one Node process)
 ├─ CLI layer  packages/rafi/src/next   argv → engine actions; terminal UI: activity rows, pinned prompts, title
 └─ engine     packages/engine          actions · build loop · turn runner · questions · notifier · progress file
      ├─ .rafi/state.sqlite3            the event log (WAL)
      ├─ codex app-server               child process, JSON-RPC on stdio
      ├─ claude                         child process, started by the Agent SDK (stream-json on stdio)
      ├─ git, gh, glab                  short-lived children, through deps
      └─ alerter / notify-send          notification children, through deps
```

### 1.1 How this design avoids the bad patterns

Each row is one of the 11 patterns in RW "The bad patterns".

| # | Pattern | How this design avoids it |
|---|---|---|
| 1 | Stopping is the default | Errors retry by default (section 5). A blocked ticket never stops other tickets (section 7). A build ends only when you stop it, when a build-wide problem blocks everything left, or when nothing is left. |
| 2 | Proof instead of recovery | Resume redoes the interrupted step (4.5). No digest comparison guards rafi's own hand-offs; the few fingerprints left protect your code or decide whether a saved answer still applies (4.7), and none stops a build by itself. |
| 3 | State in too many places | One log. The progress file and every Markdown file rafi writes are views, rewritten from the log (3.8). No run JSON, recovery folders or second database. |
| 4 | Version guards pile up | Events carry a version; old data is upgraded by an ordinary migration, never guarded. A static check fails on any `CREATE TRIGGER` (2.4). |
| 5 | Backward compatibility before 1.0 | The new engine reads only 1.0 formats. `rafi migrate` converts a 0.10.x project once (section 9). No legacy branches in the engine. |
| 6 | Giant files and functions | Budgets per module (section 2). A check fails on files over 500 lines, functions over 100 lines and lines over 120 characters (2.4). |
| 7 | Too many states | Ticket: 7 states. Build: 7. Project: 8. One table each, one pure function each, tested over every combination (section 4). |
| 8 | Bloated agent replies | Replies of 2–6 top-level fields, at most one level of nesting, no IDs rafi already has (section 6). |
| 9 | CLI launching CLI | `runCli(argv, deps)` in one process. `--detach` starts one ordinary `rafi` with your own arguments (8.7). |
| 10 | Tests check pieces | Scenarios drive the real command in-process with fakes at the edges, including a crash at every boundary (section 14, SCN section 7). |
| 11 | Fixes cluster in the same files | The loop is one ~400-line file; each step, the turn runner, questions and the log are separate modules with one job each. |

### 1.2 Security model (decided 2026-11-02, REQ ARCH-12)

Security is built in from M1, not added at the end. Every milestone's done checks include security tests for what it adds (14.1), and one full review comes before release (M10).

**What's protected:** your code (files outside a ticket, uncommitted work), your secrets (environment variables, tokens, credentials), your machine (network, files outside the project, other processes), and rafi's own records (the event log, questions and answers, grants).

| Threat | Example | How it's blocked |
|---|---|---|
| An agent acts outside its ticket | Edits a protected file; runs `rafi answer` to approve its own work | The agent permission policy refuses it (7.6, 11.3); agents never write rafi's state |
| An agent runs commands through rafi | Passes `curl …` or `rm -rf` to `run_check` | `run_check`'s allowlist, the permission policy, and an OS sandbox matching the build's grants (6.9) |
| QA changes code | A QA test run edits a tracked file | Tracked files are put back after QA's runs (6.9); QA's session is read-only |
| Network beyond what you granted | A test or agent reaches the internet when only local servers were allowed | Grants mapped onto each runtime's sandbox and rafi's own (7.11); a runtime that can't separate them says so up front |
| Another program calls rafi's endpoint | A local process sends `run_check` requests | 127.0.0.1 only, a random port, a per-session token, closed when the session ends (6.9) |
| Instructions hidden in data | Tool output, repo files or test output saying "ignore previous instructions" | Untrusted data reaches agents only as quoted content and can't change rafi's records (10.3, S-ENG-7) |
| Secrets leak | A token in activity, a log, an export or a notification | One `redact()` on write (3.3); credentials are named, never stored (7.2); detailed capture is marked sensitive (3.4 H) |
| Damaged or hostile files | A broken `tickets.yaml`, a corrupt progress file, an imported log | Validated on read; imported events are never folded (3.6); a damaged progress file is rewritten from the database (3.7) |
| Supply chain | A tool or MCP server changes under you | Tool entries pin the versions rafi tested (10.3); `rafi doctor` checks provider versions (11.4) |

## 2. Packages, modules and size budgets

### 2.1 Packages

| Package | What it holds | During side-by-side |
|---|---|---|
| `packages/engine` (new) | The engine library: log, state machines, build loop, turn runner, adapters, questions, notifier, plans, tools, stats, plus the kept ticket, git, Graphify and source code copied in from ai-foreman | Private; published as `ai-foreman@3.0.0` at the switch (guide step 11; decision 1 in section 15) |
| `packages/rafi` (`@rafi-ai/cli`) | The CLI. The new command layer lives in `src/next/`; today's 0.10.x layer (`src/*.ts`) stays untouched | Both layers ship in one CLI; `RAFI_ENGINE` picks one (section 9) |
| `packages/spec` (`rafi-spec`) | Schemas: 1.0 config, tickets, plans, progress file, events, agent replies, tool entries (NEW-GUI-7) | New 1.0 schemas sit beside the 0.10.x ones until the old engine is deleted |
| `packages/special-agents` | Rule packs, skills and role text, now tagged (section 10) | Content changes only |
| `packages/scenarios` (new) | Harness, fixtures, fakes, scenarios, coverage ledger (SCN 7.9) | Private, never published |
| `packages/ai-foreman` | Today's engine, 2.0.x | Frozen; still the default; deleted at the switch (decision 1) |

Two rules hold the boundaries:

- `engine` never imports `ai-foreman`. Kept code is copied in and slimmed, because the old package is deleted later (RW "Process" step 9).
- `engine` has no terminal code: no `@clack/prompts`, no stdout. It emits events and accepts actions. Prompts and rendering belong to the CLI layer, so a future daemon or GUI calls the same engine (GUI-PLT-3).

### 2.2 Engine modules

"Core" is what RW calls the rewrite: the orchestrator, state, recovery, the QA loop and the database (RW "Keep and rewrite"). Its total budget is 8,000 lines, against the success criterion of under 10,000 (RW "Success criteria"). Every file stays under 500 lines; most are under 300.

**Core (rewritten; 8,000 lines):**

| Module | Files | Owns | Budget |
|---|---|---|---|
| `log/` | `db.ts`, `append.ts`, `read.ts`, `lease.ts`, `blobs.ts`, `migrations/NNN-*.ts` | Opening the database (WAL, migrations, busy retry on the clock), appending in transactions, reading by cursor, the build lease, bounded blobs | 900 |
| `state/` | `ticket.ts`, `build.ts`, `project.ts`, `fold.ts`, `decide.ts`, `labels.ts` | The three pure transition functions, the fold, `decide`, tracker and GUI label mapping | 1,300 |
| `workflow/` | `standard.ts`, `roles.ts`, `load.ts`, `checks.ts` | The built-in workflow and role registry as data, loading and the load checks (4.8) | 400 |
| `build/` | `loop.ts`, `scope.ts`, `safepoint.ts`, `resume.ts`, `steps/prepare.ts`, `steps/work.ts`, `steps/review.ts`, `steps/deliver.ts`, `checks.ts` | The build loop, scope (`--steps`, `--to-ticket`, `--stacks`, `--ticket`, `--skip`), safe points, takeover and redo, one file per step; `checks.ts` runs and records tests (6.9) | 2,000 |
| `turns/` | `runner.ts`, `classify.ts`, `repair.ts`, `circling.ts`, `backoff.ts` | Every agent turn: intent, send, validate, repair, retry, circling | 900 |
| `facts/` | `runs.ts`, `snapshot.ts` | Command records with short numbers; git-tree snapshots after builder turns, changed files, drift | 450 |
| `ask/` | `scan.ts`, `upfront.ts`, `grants.ts`, `questions.ts`, `blocked.ts`, `keys.ts` | The upfront scan and list, permission grants, the question record (first answer wins), blocked-ticket options, saved-answer keys | 1,300 |
| `progress/` | `write.ts`, `read.ts` | The committed progress file: write, read, conflict merge, rebuild | 400 |
| `plan/` | `approval.ts`, `updates.ts`, `locked.ts`, `restore.ts` | Scope approval, plan updates (change-then-tell or ask), locked requirements, switching back | 750 |

**Around the core (rewritten; 5,600 lines):**

| Module | Files | Owns | Budget |
|---|---|---|---|
| `api/` | `engine.ts`, `actions.ts`, `preview.ts` | `openEngine()`, every action with its validation and idempotency key, plain-language previews with the CLI form (GUI-R3) | 600 |
| `deps/` | `types.ts`, `real/clock.ts`, `real/fs.ts`, `real/exec.ts`, `real/db.ts`, `real/processes.ts` | The seams (section 8.2) and their real implementations; the only engine code allowed to touch timers, files, processes and SQLite | 650 |
| `instructions/` | `assemble.ts`, `tags.ts`, `packs.ts`, `messages/*.ts` | Standing instructions per session, per-turn messages, tags and file patterns | 1,000 |
| `notify/` | `notifier.ts`, `reminders.ts`, `platforms/{alerter,notifySend,osascript,wsl}.ts` | Engine-owned notifications and reminders | 650 |
| `tools/` | `registry.ts`, `add.ts`, `session.ts`, `locks.ts`, `recordings.ts`, `boilerplate/*.ts` | `tools:` entries, `rafi tools add`, tools in sessions, ports and device locks, recordings and retention | 1,100 |
| `stats/` | `show.ts`, `timeline.ts`, `export.ts`, `logs.ts`, `delete.ts` | Run history views, `rafi logs export/import`, the only deletion | 700 |
| `manager/` | `host.ts`, `ask.ts`, `report.ts` | Manager host commands (no model turn), Manager questions, the instance report | 500 |
| `config/` | `load.ts`, `set.ts`, `policy.ts` | Settings in layers with their source, `--set`, org-locked settings | 400 |

**Adapters (kept, slimmed; 1,900 lines, from 3,297 in `ai-foreman/src/adapters/` today):**

| Module | Files | Budget |
|---|---|---|
| `agents/` | `types.ts` (the interface, 11.6), `capabilities.ts`, `permissions.ts` + `shellForms.ts` (today's `permissions/policy.ts`, `permissions/shellForms.ts`, 324 lines), `readiness.ts` | 700 |
| `agents/codex/` | `transport.ts` (app-server JSON-RPC over a stream), `adapter.ts`, `events.ts` | 600 |
| `agents/claude/` | `options.ts` (query options), `adapter.ts`, `events.ts` | 600 |

**Ported (kept behavior, copied in and split under 500 lines):**

| Module | From today | Today | Budget |
|---|---|---|---|
| `tickets/` | `ai-foreman/src/tickets/*` except `stateDb.ts` and `events.ts` (ticket status moves to the log, FMT-S2) | 5,086 | 4,200 |
| `git/` | `ai-foreman/src/branch/*` except `resume.ts`; `runner.ts` (1,181) becomes `build/steps/deliver.ts` plus helpers | 3,023 | 2,400 |
| `graph/` | `ai-foreman/src/graph/*`, `hostGraphApplicability.ts` (Graphify kept, RW:212) | 2,342 | 2,200 |
| `sources/` | `ai-foreman/src/sources/sourceRegistry.ts` | 507 | 500 |
| `planning/` | `rafi/src/plan.ts`, `structuredPlan.ts`, `ticketPlan.ts`, `planningDriver.ts`, `planningRuntime.ts`, `grillAudit.ts`; `ai-foreman/src/ticketPopulation.ts`, `ticketPlanning.ts`, `ticketPopulationPaging.ts` | 3,779 | 2,800 |
| `setup/` | `ai-foreman/src/interviews.ts`, `installOwnership.ts`, `gitExclude.ts`, `qaRollbackRehearsal.ts`, `runtimePreflight.ts`, `processIdentity.ts`, `roles.ts`, `util/asyncQueue.ts` | 1,193 | 1,100 |
| `migrate/` | New: one-time 0.10.x conversion (section 9) | — | 900 |

### 2.3 CLI layer (`packages/rafi/src/next/`, 5,500 lines)

| Part | Files | Budget |
|---|---|---|
| Entry | `cli.ts` (`runCli`), `deps.ts` (`realDeps()`) | 250 |
| Commands | `commands/<name>.ts`, one per command, about 30 files; `create` split into `commands/create/*.ts` (today `rafi/src/index.ts` is 1,209 lines) | 3,800 |
| Terminal UI | `ui/screen.ts` (scroll region, pinned prompts, title and status line), `ui/activity.ts` (progress rows, OUT-8), `ui/prompts.ts` (clack through `deps.terminal`), `ui/lines.ts` (plain-English stop and block lines, principle 7), `ui/colors.ts` (today's `ai-foreman/src/terminalStyle.ts`, OUT-9) | 1,450 |

Kept command code from `packages/rafi/src/` moves here or into `engine/`: `agents.ts`, `compiler.ts`, `createStackInterview.ts`, `discovery.ts`, `docs.ts`, `gitignore.ts`, `graphSetup.ts`, `project.ts`, `sources.ts`, `uninstall.ts`, `workMode.ts`, `lifecycle.ts`. Files over 500 lines (`compiler.ts` 621, `discovery.ts` 774) are split when moved.

### 2.4 Rules that keep it small (checked in the fast suite)

One script, `scripts/check-rules.mjs`, uses the TypeScript compiler API and fails the fast suite when:

- a file in `engine/src`, `rafi/src/next` or `scenarios/` is over 500 lines, a function is over 100 lines, or a line is over 120 characters;
- engine code outside `deps/real/` uses `Date.now`, `new Date()` with no argument, `setTimeout`, `setInterval`, `process.env`, `process.exit`, `process.argv`, `process.stdin`/`stdout`/`stderr`, `node:fs`, `node:child_process`, or opens a database (SCN 7.2, NEW-QAM-6);
- engine code has module-level mutable state (`let` or a mutable object at module scope), so nothing leaks between `runCli` calls in one process (SCN 7.2);
- a migration contains `CREATE TRIGGER` (NEW-ENG-8);
- `engine` imports `ai-foreman`, or `state/` imports anything but types (the state functions stay pure);
- **Windows-safe** (for later Windows support): paths built with Node's `path`, never joined with `/` by hand; no shell strings (commands are spawned with argument arrays); no bash-only commands inside rafi itself (the project's `scripts/rafi-setup.sh` is the one exception).

Dependencies point one way: CLI → `api/` → `build/`, `ask/`, `plan/`, `tools/`, `stats/`, `manager/` → `turns/`, `facts/`, `instructions/`, `agents/` → `state/`, `log/` → `deps/`.

## 3. The event log

### 3.1 Where it lives

- `.rafi/state.sqlite3` (with `-wal` and `-shm`), in the checkout. Ignored by git through `.git/info/exclude` and the managed `.gitignore` block; never committed (RW:74, Q-PORT-3). The new name keeps it apart from 0.10.x's `.rafi/recovery.sqlite3` during migration.
- One database per checkout. Each build is a run inside it and state is kept per run, so a second build per checkout stays possible later (GUI-PLT-5). 1.0 allows one live build per checkout; a second `rafi start` offers to attach instead (8.5).
- WAL mode. Writers use `BEGIN IMMEDIATE`. A busy database (`SQLITE_BUSY`) is retried with backoff on `deps.clock` for up to 30 seconds, not with SQLite's own busy timeout, which runs on real time and would break the fake clock (S-CRASH-2).
- Every open goes through `deps.db.open(path)`, so the harness can fence a crashed instance and inject storage faults (SCN 7.7).
- better-sqlite3 stays the driver (today `^13.0.3`, `ai-foreman/package.json:324`), so the launcher's native-module check is unchanged (OUT-10).

### 3.2 Tables

```sql
-- The log. Append-only.
CREATE TABLE events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT, -- global order; this is the cursor (GUI-PLT-2)
  id        TEXT NOT NULL UNIQUE,              -- event id; survives logs export and import
  run_id    TEXT,                              -- null for project-level events
  ticket_id TEXT,
  type      TEXT NOT NULL,                     -- for example 'verdict.recorded'
  v         INTEGER NOT NULL,                  -- payload version for this type
  class     TEXT NOT NULL CHECK (class IN ('state', 'detail')),
  at        TEXT NOT NULL,                     -- ISO time from deps.clock
  actor     TEXT NOT NULL,                     -- user | engine | agent:<role> | manager | maestro | api
  source    TEXT,                              -- terminal | notification | rafi-answer | manager | gui | auto-approve | flag | saved | progress-file
  origin    TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'imported')), -- imported by `rafi logs import`; never folded
  idem_key  TEXT,                              -- idempotency key of the action that wrote it (GUI-PLT-3)
  data      TEXT NOT NULL                      -- JSON, validated against rafi-spec before writing; at most 64 KB
);
CREATE INDEX events_run    ON events (run_id, seq);
CREATE INDEX events_ticket ON events (ticket_id, seq);
CREATE INDEX events_type   ON events (type, seq);
CREATE INDEX events_idem   ON events (idem_key) WHERE idem_key IS NOT NULL;

-- Large payloads, by content: raw replies, prompts and provider streams at the detailed capture level,
-- activity beyond an event's 64 KB.
CREATE TABLE blobs (
  digest    TEXT PRIMARY KEY,
  bytes     INTEGER NOT NULL,
  sensitive INTEGER NOT NULL,                  -- 1 for detailed-capture content (NEW-STATS-2)
  data      BLOB NOT NULL
);

-- Who is running a build right now. Coordination only: no state is read from it.
CREATE TABLE lease (
  run_id       TEXT PRIMARY KEY,
  instance     TEXT NOT NULL,                  -- random per engine instance
  host         TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  started_at   TEXT NOT NULL,                  -- process start time when the OS gives it (PID reuse)
  heartbeat_at TEXT NOT NULL                   -- updated every 10 s by the owner
);
-- Schema version: PRAGMA user_version.
```

Why the lease isn't in the log: a heartbeat every 10 seconds would fill it. Taking and releasing the lease are logged (`build.owner_acquired`, `build.owner_released`); the row only answers "is someone running this now?" (4.3).

### 3.3 Rules for every event

- **Append-only.** Nothing updates or deletes an event, with three exceptions, all explicit: `rafi stats delete` (confirmed by you) removes the `detail` events and blobs of the runs you name; recording retention removes recording files (not their events); and a schema migration may rewrite old rows to a new version (3.5). The first two append a `state` event saying what went and why (`history.deleted`, `recording.removed`), so a removed recording is still listed (S-TOOL-6, NEW-STATS-3).
- **Two classes.** `state` events drive the folds and are never deleted. `detail` events (turn intents and replies, activity, tool calls, prompts, notifications, measurements) are history; the capture level decides which are kept (3.4, group H).
- **Validated on write.** Every event is checked against its rafi-spec schema before it's written. An invalid event is a bug: it throws and is never written.
- **One transaction per outcome.** A step's outcome, the facts it implies and the state change it causes are written together, so a crash leaves either all of them or none (S-CRASH-1).
- **Time and ids from deps.** `at` from `deps.clock`, ids from `deps.random`, so the fast suite is exact.
- **Redacted on write.** Activity, tool output, replies and notes pass through one `redact()` before they're stored or shown, and terminal control characters are escaped when rendered (FLAG-MG-10, GUI-R24, S-CLI-12). Today there are at least four separate copies of this rule (`ai-foreman/src/continuity.ts:471`, `workflowDb.ts:3778`, `qaReview.ts:1162`, `observability.ts:879`).
- **Who did it.** Every event records `actor` and, for answers and actions, `source` (GUI-R19, S-ENG-2).
- **Idempotent actions.** An action called with an idempotency key that's already in the log returns its earlier result and writes nothing (S-ENG-2, GUI-PLT-3).

### 3.4 Event types

Field lists are the `data` payload; every event also has the envelope columns above. `run_id` and `ticket_id` are set where they apply. All are version 1 at 1.0.

**A. Project, plan and tickets** (usually `run_id` null)

| Type | Class | Written when | Fields |
|---|---|---|---|
| `project.created` | state | `rafi create` writes the config | `app_name`, `rafi_version` |
| `project.migrated` | state | `rafi migrate` finishes | `from: "0.10.x"`, `files`, `kept`, `dropped` |
| `plan.started` | state | the Planner starts | `mode: new \| revise`, `interview_id` |
| `plan.proposed` | state | a plan validates | `plan_id`, `revision`, `digest`, `path` |
| `plan.approved` | state | you approve, auto-approve approves, or an approval is carried forward | `plan_id`, `revision`, `digest`, `by: user \| auto-approve \| carried` |
| `plan.rejected` | state | "Give feedback" | `feedback` |
| `plan.failed` | state | planning gives up | `reason` |
| `plan.changed` | state | a plan update is applied or proposed; these events are the plan-change log (FILE-62) | `from_rev`, `to_rev`, `kind: update \| restore`, `by: planner \| user`, `why`, `items: [{ticket, field, change}]`, `applied`, `told: [terminal, notification, summary]` |
| `plan.reset` | state | `rafi reset`, plan | `to_rev`, `tickets` |
| `scope.approved` | state | the selected scope is approved (PRM-71) | `fp` (fingerprint of plan revision and material ticket fields), `by` |
| `tickets.populated` | state | the Ticket Maker's proposal is applied | `plan_rev`, `added`, `retired`, `group` |
| `tickets.changed` | state | a safe point or a `tickets` command sees edited definitions | `by: user \| planner`, `items: [{ticket, field}]`, `material` |
| `ticket.added` | state | rafi adds one of its own fix tickets (6.10, 7.10) | `ticket`, `source: ci \| recheck`, `requirements`, `hint` (which ticket probably caused it) |
| `ticket.status_set` | state | `rafi tickets update`, `complete`, `block`, `unblock` (`tickets cancel` writes `ticket.dropped`) | `status`, `summary`, `validation`, `evidence`, `by` |
| `ticket.tags_added` | state | the Planner, QA preparation, a file pattern, you, or a scope change adds tags | `tags: [{tag, reason}]` (OUT-19) |
| `ticket.group_created`, `ticket.risk_waiver_recorded`, `future_work.added`, `future_work.accepted`, `recommendation.recorded`, `recommendation.resolved` | state | the tracker commands that write these today | as today's tracker records (`ai-foreman/src/tickets/stateDb.ts:152-285` has 13 tables; these events replace them) |

**B. Builds**

| Type | Class | Written when | Fields |
|---|---|---|---|
| `build.started` | state | `rafi start` begins | `workflow: {id, version, digest}` (4.8; a build keeps the workflow it started with), `scope: {steps \| to_ticket \| stacks \| ticket \| all, skip}`, `tickets`, `settings: {key: {value, source}}` (GUI-R20), `engine_version`, `argv` |
| `build.owner_acquired` / `build.owner_released` | state | a process takes or gives up the lease | `instance`, `host`, `pid` / `reason: finished \| stopped \| waiting \| failed` |
| `build.owner_lost` | state | `rafi resume` takes over from an owner that died | `last_heartbeat_at` |
| `build.resumed` | state | `rafi resume` continues the build | `from_state` |
| `build.waiting` / `build.unwaiting` | state | nothing is eligible and a question blocks the rest / an answer makes work eligible | `questions` |
| `build.pause_requested`, `build.paused`, `build.unpause_requested`, `build.unpaused` | state | Manager `/pause`, a safe point, `rafi resume` | `source`, `boundary` |
| `build.stop_requested` | state | `rafi stop`, Ctrl+C | `mode: graceful \| now`, `source: rafi-stop \| ctrl-c \| gui \| manager` |
| `build.stopped` | state | the stop takes effect | `cause: stop \| cancel \| ctrl-c` |
| `build.finished` | state | `decide` finds the scope reached or nothing left | `complete`, `done`, `left` |
| `build.failed` | state | an internal error the loop can't continue past | `error`, `message` |

**C. Steps and turns**

| Type | Class | Written when | Fields |
|---|---|---|---|
| `ticket.started` | state | the loop picks a ticket | `resume_step` |
| `step.started` | state | a step begins | `step` (the step's name in the workflow; `standard` has `prepare`, `build`, `check`, `review`, `fix`, `deliver`), `attempt` |
| `step.failed` | state | a step's turn budget runs out, or circling stops it | `category`, `reason` (one line), `circling` |
| `turn.retry` | state | a turn is scheduled again | `key`, `category`, `attempt`, `delay_ms`, `reason` |
| `turn.intent` | detail | before a turn is sent (crash boundary 1 follows) | `key`, `role`, `runtime`, `model`, `effort`, `fast`, `session: new \| reused`, `schema`, `instruction_chars` (NEW-MEAS-4), `instruction_digest`, `tools`, `grants`, `redo` |
| `turn.sent` | detail | the adapter accepted the turn (boundary 2 follows) | `key`, `native_session`, `native_turn` |
| `turn.reply` | detail | the reply arrived and was classified (boundaries 3–4 around it) | `key`, `outcome: ok \| format \| content \| provider \| timeout \| cancelled \| quota \| auth`, `errors`, `raw` (blob ref), `usage: {input, output, cost, measured}`, `timing: {first_output_ms, agent_ms, tools_ms, rafi_ms}` (NEW-MEAS-1) |
| `turn.repair` | detail | the one repair try ends | `key`, `error`, `at_byte`, `accepted`, `why` |
| `turn.cancelled` | detail | a turn is cancelled (stop now, Ctrl+C, timeout) | `key`, `cause`, `confirmed` |
| `turn.activity` | detail | coalesced activity (text, status, provider retries, compaction) | `key`, `kind`, `text` (bounded; at most 10 MB per turn, then a cut marker, S-ENG-7) |
| `turn.tool` | detail | a tool call completes | `key`, `run` (short number), `tool`, `command`, `outcome: completed \| failed \| timed-out \| cancelled \| unknown`, `exit_code` (null when the runtime gives none, NEW-REF-2), `duration_ms`, `output_digest`, `harmless` (SCN-14) |
| `turn.prompt` | detail | detailed capture only | `key`, `blob` |

**D. Results of steps**

| Type | Class | Written when | Fields |
|---|---|---|---|
| `requirements.written` | state | the prepare step writes the requirements file | `path`, `fp`, `depth`, `depth_raised_from` (S-QA-5), `count`, `person_only: [n]` |
| `requirements.receipt` | detail | a QA review turn starts and ends | `key`, `path`, `fp_supplied`, `fp_observed`, `status: delivered \| missing \| unreadable \| changed`, `read` (NEW-REQ-6) |
| `builder.reported` | state | a builder reply validates | `kind: done \| blocked \| needs-input`, `summary`, `runs`, `block`, `question` (6.2) |
| `check.run` | state | rafi finishes running a test command (6.9) | `run` (short number), `ticket`, `command`, `asked_by: builder \| qa \| rafi`, `tree` (git tree id it ran against), `exit_code`, `outcome: passed \| failed \| timed-out \| too-slow \| changed-code \| refused`, `tests: [{name, file, outcome}]` (when the runner reports per-test results), `duration_ms`, `output` (blob), `changed_tracked` (files a check changed, when any), `restored` (QA's runs: tracked files put back) |
| `checks.passed` / `checks.failed` | state | the check step ends (6.9) | `runs`, `reused` (runs not rerun) / `failing: [{req, run}]`, `signature` |
| `attempt.summary` | state | a builder turn ends | `attempt`, `tree`, `files_read`, `runs` (what circling and reference checks need, kept at every capture level; 5.5) |
| `facts.snapshot` | state | after each builder turn | `key`, `tree` (git tree id), `base`, `files` (changed files, computed by rafi) |
| `facts.mismatch` | detail | an agent's claim disagrees with rafi's record | `key`, `claim`, `record` (NEW-FACT-1) |
| `verdict.recorded` | state | a QA verdict validates | `attempt`, `results: [{req, status, runs, needs, note}]`, `rejected`, `unverified`, `signature`, `circling` |
| `qa.isolation` | detail | a review starts | `mode: in-place \| copy`, `why`, `files`, `bytes`, `ms: {copy, hash, verify, cleanup}` (NEW-COPY-1) |
| `fix.granted` | state | "Retry another Builder fix" or Manager `/request-attempt` | `by`, `reason` |
| `waiver.recorded` | state | "I verified it myself" or "Explicitly waive QA" | `kind`, `note`, `findings`, `fp` (what the waiver covered) |
| `recheck.requested` / `recheck.recorded` | state | `rafi plan restore`, or a plan update that changes a done ticket's criteria, queues a QA re-check of that ticket / the re-check ends | `ticket`, `revision` / `passed`, `fix_ticket` (NEW-PUA-5) |
| `suite.run` | state | rafi's CI step finishes one suite run (6.10) | `unit`, `commit`, `tests: full \| light`, `outcome: passed \| failed \| too-slow`, `failing`, `preexisting`, `flaky`, `reused`, `duration_ms` |
| `ci.result` | state | a CI point ends (6.10) | `unit`, `outcome: passed \| fixed \| unfixed-merged \| unfixed-pushed`, `fix_ticket`, `still_failing` |

**E. Tickets in a build**

| Type | Class | Written when | Fields |
|---|---|---|---|
| `ticket.blocked` | state | a ticket can't go on | `kind` (4.2), `reason` (one line, the builder's own words when it gave them), `question`, `waits` |
| `ticket.unblocked` | state | an answer clears the block | `resume_step`, `by` |
| `ticket.done` | state | delivery finishes | `validation: {result, runs, unverified}` |
| `ticket.dropped` | state | won't do, obsolete or `tickets cancel` | `why` |
| `ticket.reopened` | state | a stale "I verified it myself" puts a done ticket back in review (S-QA-2 step 3) | `why` |
| `git.committed`, `git.branch_created`, `git.pushed`, `pr.created`, `pr.merged`, `delivery.done` | state | the deliver step | `sha`, `branch`, `url`, `unit` |
| `unit.ready`, `unit.merge_waiting`, `unit.delivered`, `unit.failed` | state | a delivery unit's tickets are all done / rafi waits for a PR to auto-merge / the unit is merged, pushed or its PR opened / a git or gh/glab step fails (4.3.2) | `unit`, `until` / `how` / `category: transient \| conflict \| auth \| rejected`, `message` |
| `scan.gap` | state | a question comes up mid-build that the scan should have found (NEW-ASK-5) | `question`, `kind` |

**F. Questions, answers and grants**

| Type | Class | Written when | Fields |
|---|---|---|---|
| `question.opened` | state | any question to you | `id`, `no` (short number), `kind`, `tickets`, `text`, `options: [{id, label}]`, `recommended`, `context`, `urgency`, `key` (7.6) |
| `question.answered` | state | the first answer arrives | `id`, `choice`, `text`, `note`, `save: none \| build \| project \| machine` |
| `question.deferred` | state | "answer later" or "skip for now" | `id` |
| `question.closed` | state | the question no longer applies | `id`, `why: superseded \| stale \| ticket-dropped \| scope-changed` |
| `grant.recorded` | state | a permission is granted or denied | `need`, `scope: build \| machine`, `allowed`, `tickets` |
| `guidance.queued`, `guidance.delivered`, `guidance.acknowledged`, `guidance.withdrawn`, `guidance.superseded` | state | Manager `/guide-builder`, `/guide-qa`, `/guide-both`, `/withdraw`, `/supersede`; delivered when a turn's message carries it, acknowledged when that turn ends with a valid reply (GUI-R14, NEW-KEEP-5) | `id`, `role`, `ticket`, `text`, `turn` |

**G. Tools, recordings, history and imports**

| Type | Class | Written when | Fields |
|---|---|---|---|
| `tool.added` | state | `rafi tools add` or a prompt adds a tool | `name`, `entry_digest` |
| `recording.saved` / `recording.removed` | state | QA evidence files are written / retention or `stats delete` removes them | `ticket`, `req`, `kind: screenshot \| video \| trace`, `path`, `bytes` / `why` |
| `history.deleted` | state | `rafi stats delete` | `runs`, `counts` |
| `logs.imported` | state | `rafi logs import` | `file`, `runs` |
| `progress.imported` | state | a clone or a newer progress file is read | `entry`, `chose: ours \| theirs` (S-PORT-2) |
| `notify.sent`, `notify.reminder` | detail | a notification goes out | `question`, `event`, `channel`, `shown`, `more`, `outcome` |

**H. Capture levels** (NEW-STATS-2, FMT-C19; default `normal`, Q-STATS-1)

| Level | Keeps |
|---|---|
| `none` | `state` events only: what the build needs to be correct. A failed parse keeps its error text but not the raw reply. |
| `normal` | Plus the `detail` events above except `turn.prompt`, with raw replies kept only when parsing or repair failed (NEW-SO-2). |
| `detailed` | Plus exact prompts, every raw reply and the provider streams, as `sensitive` blobs; the run is marked sensitive. Replaces `.foreman/provider-streams/` (FILE-46). |

### 3.5 Versioning

- Every event type has a version, `v`. The fold reads only the current version of each type.
- When a type changes in a way old readers can't follow, an ordinary migration rewrites the old rows to the new version, in one transaction. The data is upgraded, not guarded (RW bad pattern 4). `rafi logs import` runs the same upgrade on imported events.
- Migrations are numbered TypeScript files, `log/migrations/NNN-name.ts`, each with an `up(db)`. `PRAGMA user_version` holds the last one applied. They run in order, at open, in one transaction. There are no down-migrations and no triggers.
- Before 1.0 nobody uses the new log, so a breaking change during the rewrite just bumps `v`; a development database is recreated, and the progress file rebuilds what matters (3.7).
- `rafi stats export` writes `{ "format": "rafi-events", "schema": <user_version>, "events": [ … ] }`: stable JSON, identical for identical input (S-CLI-17, OUT-35).

### 3.6 How current state is derived

- `fold(events)` returns `{ project, builds, tickets, questions, answers, grants }`. It applies `nextProject`, `nextBuild` and `nextTicket` (section 4) to each `state` event in `seq` order. `detail` events are skipped.
- A ticket's state belongs to the project and carries across runs; a build's state belongs to its run.
- Reads fold on demand. Folding a few thousand small rows takes milliseconds; a cache of the folded state may be added only after measuring that it's needed (NEW-CAU-2), and it would be rebuildable and never a source of truth.
- `rafi status`, `rafi stats`, `rafi tickets show`/`queue`, Manager, the progress file and `docs/ticket-progress.md` are all views of the fold (status also reads the lease, for liveness).
- **Readers never write.** `rafi status` on a crashed build appends nothing and changes no file (S-CRASH-4 step 5). When the progress file is newer than the database (a fresh clone), a reader folds it in memory and says the view comes from `.rafi/progress.yaml`; only commands that write import it (3.7).
- **Imported runs aren't folded.** Events with `origin: imported` (`rafi logs import`) are read only by the `stats` views, so another machine's run never changes local state.

### 3.7 The progress file snapshot (Q-PORT-1, Q-PORT-2, Q-PORT-4)

`.rafi/progress.yaml`, committed, rewritten at every safe point (4.6) and by every command that changes state outside a build (`rafi answer`, `tickets` commands, `reset`, `populate`, `migrate`), with an atomic write (temp file, then rename, through `deps.fs`):

```yaml
# Written by rafi from its database at every safe point. Commit it; don't edit it.
version: 1
tickets:
  T1: { status: done, at: "2026-11-01T14:10:02Z" }
  T2: { status: blocked, at: "2026-11-01T14:05:12Z", reason: "Internet needed to install PostgreSQL", question: 7 }
  T3: { status: in_progress, at: "2026-11-01T14:31:40Z", step: review, fixes: 1 }
  T5: { status: planned, at: "2026-11-01T13:58:00Z" }
questions:
  7: { at: "2026-11-01T14:05:12Z", kind: blocked, tickets: [T2, T5], text: "Ticket T2 is blocked: Internet needed to install PostgreSQL", options: [grant, fixed, skip, instruct, planner, drop, stop] }
answers:
  "decision|T15|3f9a1c": { at: "2026-11-01T13:59:30Z", choice: "EUR", source: terminal }
```

- Sorted keys, one entry per line, so git merges cleanly and a conflict is always whole entries (Q-PORT-1).
- Holds ticket status (the tracker values, 4.2), open questions and saved answers. In-progress tickets also carry `step` and `fixes`, so fix budgets survive a move to another computer. Never holds permissions: "always allow" stays on each machine (Q-PORT-2), and neither does run history (that travels by `rafi logs export`).
- **Who commits it.** When rafi manages git, it goes into rafi's next commit on the build's branch. When you manage git, it stays in your working tree for you to commit. Either way it's on rafi's dirty-work skip list, with rafi's own writes to `rafi-config.yaml`, so it never counts as your uncommitted work.
- **Reading it.** When a command that writes opens the engine and the database is missing (a fresh clone) or a file entry is newer than the database's latest state for that entry, rafi imports the entry as `progress.imported` and prints one line: "Rebuilt build state from .rafi/progress.yaml." (S-PORT-1, S-PORT-2 step 4).
- **Git conflicts.** If the file contains conflict markers, rafi reads both sides, takes the newer `at` per entry, writes a clean file, and prints which side it chose for each conflicting ticket (Q-PORT-4, S-PORT-2).
- **Damaged file, healthy database.** Rafi rewrites the file from the database and says so in one line; the build runs (S-ENG-7, S-CRASH-2).
- The database is the truth on each machine. The file never overrides a newer database entry.

### 3.8 Files rafi writes, and why none is a second source of truth

| File | Committed | What it is | Written |
|---|---|---|---|
| `.rafi/state.sqlite3` | no | The truth on this machine | Always |
| `.rafi/progress.yaml` | yes, even with "All Rafi" ignored (FILE-10) | Snapshot of the fold | Every safe point and every state-changing command (3.7) |
| `docs/ticket-progress.md`, `docs/ticket-archive.md` | as today | Views for people; the `LLM_NEXT_QUEUE` heading becomes `Next up` (Q-FMT-2) | After ticket changes |
| `<docs>/requirements/<ticket>.md` | yes (Q-REQ-2), in the same commit as the ticket's work (S-QA-5) | The requirements file: QA's content, rendered by rafi; rafi stores only its path and fingerprint (NEW-REQ-2) | Prepare step |
| `<docs>/rafi-plan.json`, `.md`, `<docs>/rafi-plans/*` | yes | The plan (kept format, FMT-P) | Approval, plan changes |
| `.tickets/tickets.yaml`, `delivery.yaml`, `config.yaml` | yes | Definitions you and the Planner write | Populate, `tickets` commands, plan changes |
| `rafi-config.yaml` | yes, always (FILE-1) | Settings | `create`, `agents`, `tools add`, auto-approve's plan-update default (D3), your answers to the CI confirmation and the time-limit question (6.10, 6.11) |
| `.rafi/logs/<run>.jsonl` | yes, only when you chose "save logs in the project" | The `rafi logs export` format for that run (Q-PORT-3) | Build end and each stop |
| `.rafi/recordings/<run>/…` | no (moves under `.rafi/logs/<run>/` when logs are in the project) | QA evidence files (FILE-63) | QA turns |
| `scripts/rafi-setup.sh` | yes (Q-SET-1) | The project setup script, written by the builder | Builder turns |
| `.rafi/cache/` | no | Caches tests would otherwise write to your home folder (6.9) | Test runs |
| `.rafi/background.log` | no | A `--detach` build's output (8.7) | Background builds |
| `.rafi/migrate-backup/<time>/` | no | Byte-for-byte copies from `rafi migrate`, plus the 0.10.x files it retired (9.3) | `rafi migrate` |
| `.foreman/worktrees/`, `.foreman/dirty-baselines/`, `.foreman/pr-bodies/` | no | Working files (FILE-49–51) | Delivery, dirty work |
| `~/.rafi/grants.yaml`, `~/.rafi/policy.yaml`, `~/.rafi/locks/` | n/a (machine) | "Always allow" grants, org-locked settings, device locks | Upfront check, your org, tool runs |

The Markdown files are views: rafi rewrites them from the fold and never reads them back as state. The plan-change log is a view too: `rafi plan changes` lists `plan.changed` events (Q-PUA-2). Plan revisions themselves are committed files, so the history of what the plan said travels with the project even when logs don't.

## 4. State machines

### 4.1 The four pure functions

```ts
// engine/src/state/ — no deps, no I/O, no clock.
nextTicket(ticket: TicketState, event: StateEvent, ctx: TicketRules): TicketState
nextBuild(build: BuildState, event: StateEvent): BuildState
nextProject(project: ProjectState, event: StateEvent): ProjectState
decide(view: Folded, live: Liveness): Action        // what the build loop does next (4.5)
answerEffects(q: Question, choice: Choice, view: Folded): StateEvent[]   // what an answer writes (7.7)

interface TicketRules { qa: boolean; fixes: number; manualChecks: "wait" | "none" | "track"; rafiOwned: boolean }
```

- `TicketRules` come from the settings recorded in `build.started`, so a fold gives the same answer after a restart.
- **Tested over every combination** (NEW-ENG-2). The tables below are also data in `state/transitions.test.ts`; the test builds every (state, event) pair, including the "no change" ones, and checks each against the table. The scenarios check only the states users see (SCN 10, NEW-ENG-2 note).
- **Answers too.** `answerEffects` turns every blocked kind's options (7.7) into the events they write; the 7.7 tables are its test data, and the test covers every (kind, option) pair.
- **Invalid pairs.** Before appending, the engine checks the transition; an invalid one is a bug and isn't written. A fold that meets an invalid pair (a damaged or imported log) keeps the state unchanged and reports a violation, which `rafi doctor` shows. The fold never throws, so `rafi status` always works.

### 4.2 Ticket

The tables in this section are the built-in workflow, `standard` (4.8): the steps and their pass and fail rules are data in `workflow/standard.ts`, and `nextTicket` reads them.

Seven states (principle 2's six, plus `dropped` for won't-do and obsolete tickets, which leave the build). Three states have steps; the step is the unit of redo.

| State | Steps | Meaning |
|---|---|---|
| `queued` | — | Not started, or waiting to restart after a block (`resume_step` remembers where) |
| `building` | `prepare`, `build`, `check`, `deliver` | QA writes the requirements file; the builder works; rafi runs the checks (6.9); rafi commits (and, at the unit's end, merges or opens the PR, 4.3.2) |
| `reviewing` | `review` | QA reviews against the requirements file |
| `fixing` | `fix`, `check` | The builder fixes QA's findings or failing checks; rafi runs the checks again |
| `blocked` | — | Waits for an answer; carries `kind`, `reason`, `question`, `resume_step` |
| `done` | — | Delivered, with its validation record |
| `dropped` | — | Won't do (`canceled`) or obsolete |

Blocked kinds: `permission`, `install`, `service`, `credential`, `decision`, `other` (the builder's own report, SCN 2.2; `other` also covers a turn budget used up); `held` (held before step 1 by the upfront check); `what-next` (QA didn't converge, or circling); `unverified` (QA couldn't verify something a known tool would let it verify); `confirm` (a person-only check, D4); `build-wide` (NEW-BLK-7); `manual` (`rafi tickets block`); `limit` (a test hit its time limit while still running; waits for the limit answer, 6.11); `unfixed` (one of rafi's own fix tickets ran out of fixes: no question is asked and nothing waits on it, 6.10). Section 7.7 gives each kind's options.

| From (state·step) | Event | To | Notes |
|---|---|---|---|
| `queued` | `ticket.started` | `building·prepare` if QA is on and the ticket has no requirements file for its current definition; else `building·build`; or `resume_step` when set | `decide` starts only eligible tickets |
| `queued` | `ticket.blocked` | `blocked` | `held` up front, or `build-wide` |
| any, except the ticket a live build is working on | `ticket.status_set` | the state its status maps to (below the table) | `rafi tickets update`, `complete` (evidence required, FMT-S4), `block` (`manual`), `unblock` (FLAG-TK-10–13) |
| `queued`, `blocked` | `ticket.dropped` | `dropped` | dependents get a question (S-BLK-3) |
| `building·prepare` | `requirements.written` | `building·build` | |
| `building·build` | `builder.reported` done | `building·check` | |
| `building·check`, `fixing·check` | `checks.passed` | `reviewing·review`; with QA off, `building·deliver` | stale results rerun, fresh ones reused (6.9) |
| `building·check`, `fixing·check` | `checks.failed`, fixes left, not circling | `fixing·fix` | attempt + 1; the QA turn is skipped (NEW-CHK-3) |
| `building·check`, `fixing·check` | `checks.failed`, no fixes left or circling | `blocked(what-next)`; `blocked(unfixed)` for a rafi-owned ticket | `resume_step` = fix |
| `building·check`, `fixing·check` | `ticket.blocked` (`limit`) | `blocked(limit)` | `resume_step` = check (6.11) |
| `building·build`, `fixing·fix` | `builder.reported` blocked | `blocked` (kind from the reply) | `resume_step` = same step |
| `building·build`, `fixing·fix` | `builder.reported` needs-input | `blocked(decision)` | your answer goes to the builder with the retry |
| `building·*`, `reviewing·review`, `fixing·fix` | `step.failed` | `blocked(other)`; `blocked(what-next)` when circling stopped a fix loop | `resume_step` = same step; one-line reason such as "malformed reply 4 times", never "delivery uncertain" (NEW-MAL-3) |
| `building·*`, `reviewing·review`, `fixing·fix` | `tickets.changed` (material, this ticket) | `building·prepare` | QA reviews against the plan in force (NEW-PUA-7); attempt counts kept |
| `reviewing·review` | `verdict.recorded`, nothing not-satisfied, no person-only check | `building·deliver` | requirements QA couldn't verify are listed as unverified |
| `reviewing·review` | same, with person-only checks, `manual_checks: wait` | `blocked(confirm)` | `resume_step` = deliver (D4) |
| `reviewing·review` | same, `manual_checks: track` | `building·deliver` | the check stays an open question; dependents go on (setting C) |
| `reviewing·review` | `verdict.recorded` rejected, fixes left, not circling | `fixing·fix` | attempt + 1 |
| `reviewing·review` | `verdict.recorded` rejected, no fixes left or circling | `blocked(what-next)`; `blocked(unfixed)` for a rafi-owned ticket | `resume_step` = fix |
| `reviewing·review` | `verdict.recorded` with an "unable" that a known tool would fix | `blocked(unverified)` | `resume_step` = review (S-TOOL-1) |
| `fixing·fix` | `builder.reported` done | `fixing·check` | |
| `blocked(confirm)` | `ticket.unblocked` with "It doesn't" | `fixing·fix` | your note is a finding; counts against `retries.fixes` (7.7) |
| `building·deliver` | `delivery.done` | `done` | |
| `blocked` | `ticket.unblocked` | `queued` | keeps `resume_step`; restarts when the current ticket finishes (NEW-BLK-4) |
| `done` | `ticket.reopened` | `reviewing·review` | only a stale "I verified it myself" when the ticket is put back in scope (S-QA-2 step 3) |
| `done` | `recheck.requested`, `recheck.recorded` | no change | the ticket stays done; a failed re-check adds a rafi-owned fix ticket (`ticket.added`, 7.10) |
| — | `ticket.added` | `queued`, rafi-owned | first in the queue (6.10) |
| any | `progress.imported` | the imported status (table below) | rebuild on a clone |
| any | `ticket.tags_added`, `fix.granted`, `waiver.recorded`, `facts.snapshot`, `check.run`, `attempt.summary` | no change | kept in the ticket's context |
| `done`, `dropped` | anything else | no change | |

An interrupted step has no event of its own: the ticket stays in its state and step, and the loop redoes the step (4.5). A queued ticket whose dependency isn't done is simply not eligible; `decide` reports it as "waiting on T2".

**Tracker status** (what `tickets show`, `queue`, the progress file and the GUI show; FMT-S1, Q-FMT-1):

| Engine state | Tracker status |
|---|---|
| `queued` | `planned`; `next` for the first eligible ticket in queue order |
| `queued`, with a dependency that's blocked | `blocked` (a dependency blocker, recalculated as today, FMT-S3) |
| `building`, `reviewing`, `fixing` | `in_progress` |
| `blocked` | `blocked`; skipped for now stays `blocked` with its open question |
| `done` | `done` |
| `dropped` | `canceled` (won't do, `tickets cancel`) or `obsolete` (population) |

`rafi tickets update --status` writes `ticket.status_set`; `planned`, `next` and `in_progress` map to `queued` (an engine state can't be "building" without a build), `blocked` to `blocked(manual)`, `done` to `done`, `canceled` and `obsolete` to `dropped`.

### 4.3 Build

Seven states (Q-LIFE-1).

| From | Event | To | Notes |
|---|---|---|---|
| — | `build.started` | `running` | |
| `running` | `build.waiting` | `waiting` | nothing eligible, and an open, not deferred, question blocks the rest of the scope |
| `waiting` | `build.unwaiting` | `running` | an answer made a ticket eligible |
| `running`, `waiting` | `build.pause_requested` | same, with `pausing` set | the in-between state GUI-R5 asks for |
| `running` (pausing), `waiting` (pausing) | `build.paused` | `paused` | at the next safe point; a waiting build pauses at once |
| `paused` | `build.unpause_requested` | `paused`, with `unpausing` set | `rafi resume` on a paused build (8.5) |
| `paused` | `build.unpaused` | `running` | written by the owner |
| `running`, `waiting`, `paused` | `build.stop_requested` | `stopping` | graceful: the current step finishes; now: the current turn is cancelled |
| `stopping` | `build.stop_requested` (now) | `stopping`, now | the second `rafi stop` (Q-CMD-6) |
| `stopping` | `build.stopped` | `stopped` | `cause: stop \| cancel \| ctrl-c` |
| `waiting`, `paused`, with no live owner | `build.stop_requested` then `build.stopped` | `stopped` | `rafi stop` writes both itself when no process owns the build (AR-22) |
| `running`, `waiting` | `build.finished` | `finished` | `complete` is false when skipped or deferred questions leave work |
| `running`, `waiting`, `stopping` | `build.failed` | `failed` | an internal error (5.1) |
| `running`, `waiting`, `paused` | `build.owner_lost` | `stopped`, cause `crash` | written by the process that takes over |
| `stopping` | `build.owner_lost` | `stopped`, the requested cause | the process died while stopping, for example on a second Ctrl+C |
| `stopped`, `failed`, `waiting` | `build.resumed` | `running` | `waiting` only when its owner released or was lost |
| `finished`, not complete | `build.resumed` | `running` | retries skipped tickets |
| `finished`, complete | `build.resumed` | no change | `rafi resume` says "Nothing to resume." |
| any | `build.owner_acquired`, `build.owner_released` | no change | liveness only |

**Is a "crashed" state needed?** No (SCN flagged this at S-CRASH-3 run 4). A process that crashes can't write its own state, so a stored `crashed` state could only be written later by another process, and that's exactly what `build.owner_lost` is, just before `build.resumed`. Instead, "crashed" is derived: a build whose stored state is `running`, `waiting` (with an owner), `paused` or `stopping`, and whose lease owner isn't alive (4.3.1), is shown as **crashed** by `rafi status`, the GUI and `stats show`. The takeover then records `build.owner_lost` with the last heartbeat time, so the history keeps the crash as its own outcome (SCN-8).

| Outcome shown (S-CRASH-3) | Stored state |
|---|---|
| stopped | `stopped`, cause `stop` |
| cancelled | `stopped`, cause `cancel` |
| cancelled by Ctrl+C | `stopped`, cause `ctrl-c` |
| crashed | non-terminal state with no live owner, before takeover; `stopped`, cause `crash`, after |
| paused | `paused` |
| waiting on you since 14:05 | `waiting` |

**4.3.1 Liveness.** The owner refreshes `lease.heartbeat_at` every 10 seconds. An owner is alive when `deps.processes.isAlive(owner)` says so: the real check is the same host, the pid running, and its start time matching (today's `ai-foreman/src/processIdentity.ts` reads it from `/proc` on Linux, `:50`, and with `ps -o lstart=` on macOS, `:58`), so a reused pid doesn't count. In-process, the harness marks a fenced instance dead. A live owner whose heartbeat is over 60 seconds old is shown as "not responding since …" (GUI-R11) and can't be taken over until it's gone.

**A build waiting without a terminal.** A foreground build with no terminal (a script or CI) records `build.waiting`, releases its lease (`build.owner_released`, reason `waiting`) and exits with code 2 once nothing is left to build (NEW-BLK-5, Q-OUT-1). It stays `waiting`; `rafi status` says "Waiting on you since 14:05 (T2). Answer with `rafi answer`, then run `rafi resume`." **A background build (`--detach`) doesn't exit**: like a terminal build it keeps the lease, keeps waiting and sends reminders, so an answer from a notification continues it (decision 8).

**4.3.2 Delivery units** (FMT-D2, FLAG-ST-37–39, S-BATCH-2). A unit's state is folded from its tickets and the `unit.*` events:

| Unit state | Means | Next |
|---|---|---|
| building | some of its tickets aren't done | — |
| ready | every ticket done (`unit.ready`) | a CI point if `checks.ci_when` puts one here (6.10), then deliver |
| delivering | rafi merges, pushes or opens the PR | `unit.delivered`, or `unit.merge_waiting` for `auto-merge` |
| merge-waiting | waits up to `auto_merge_timeout_minutes` on the clock; later units with `dependency_mode: wait` or `stack` wait too | merged: `unit.delivered`; timeout: a unit question, "Keep waiting / Merge it myself, then continue / Skip the units that wait on it" |
| delivered | done | dependent units become eligible |
| failed | a git or gh/glab step failed (`unit.failed`) | by category (5.1): `transient` retries with backoff; `conflict` asks "Builder resolves the conflict / Skip this merge (the branch stays pushed) / Stop the build"; `auth` and `rejected` are build-wide questions (PRM-79's shape) |

Only the unit and the units waiting on it wait; other units keep building (NEW-KEEP-2).

### 4.4 Project

Eight states (Q-LIFE-1).

| From | Event | To | Notes |
|---|---|---|---|
| — | `project.created` | `draft` | |
| — | `project.migrated` | `ready` (approved plan and tickets), `ticketing` (approved plan, no tickets) or `draft` | |
| `draft`, `ready`, `complete` | `plan.started` | `planning` | a new plan or `--revise`; the state before is remembered |
| `planning` | `plan.proposed` | `awaiting-approval` | |
| `planning` | `plan.failed` | the remembered state | the saved interview stays for `rafi resume` (S-SCN-13) |
| `awaiting-approval` | `plan.rejected` | `planning` | "Give feedback" |
| `awaiting-approval` | `plan.approved` | `ticketing`; `ready` when the tickets already match (approval carried forward) | |
| `ticketing` | `tickets.populated` | `ready` | |
| `draft` | `tickets.populated`, or a ticket added by hand or by `accept-future-work` | `ready` | tickets from Linear, Jira, a URL or `tickets.yaml` with no rafi plan |
| `ready`, `complete` | `build.started` | `building` | |
| `building` | `build.finished`, complete, and every ticket `done` or `dropped` | `complete` | |
| `building` | any other build end (`finished` with work left, `stopped`, `failed`, `waiting` with its owner released) | `ready` | a crash keeps `building` until the takeover |
| any but `archived` | `plan.reset` | `ticketing` | `rafi reset`, plan (Q-CMD-3 d) |
| `complete` | `tickets.changed` adding a ticket, or `plan.changed` | `ready` | |
| any | `project.archived` | `archived` | GUI only; no 1.0 command writes it |
| `archived` | `project.unarchived` | `ready` | GUI only |

**GUI lifecycle labels** (GUI-INS-7, GUI-R9, Q-LIFE-1). Every label maps from the three levels:

| GUI label | Derived from |
|---|---|
| Draft | project `draft` |
| Planning | project `planning` |
| Awaiting plan approval | project `awaiting-approval` |
| Ticketing | project `ticketing` |
| Ready | project `ready`, no live build |
| Building | build `running`; the current ticket is `building` or `fixing` |
| QA | build `running`; the current ticket is `reviewing` |
| Awaiting you | build `waiting`; or `running` with an open question that blocks a ticket in scope (a badge) |
| Paused | build `paused` ("Pausing…" while `pausing`) |
| Failed / Recovering | build `failed`, or crashed (derived, 4.3) → Failed; between `build.owner_lost` and the end of the first redone step → Recovering |
| Complete | project `complete` |
| Archived | project `archived` |

### 4.5 `decide`: what the build loop does next

The loop is `while (true) { view = fold(log); action = decide(view, live); if (action is end) break; run(action) }`. `decide` applies these rules in order (NEW-QAM-3's "find the last finished outcome, then act on it"):

1. A stop was requested: if a step is running, let it finish (graceful) or cancel it (now); then write `build.stopped`.
2. A pause was requested and this is a safe point: write `build.paused` and hold.
3. A ticket is `building`, `reviewing` or `fixing` and its current step has no recorded outcome after its last `step.started`: **redo that step.** This is the whole resume rule; it's the same after a crash, a stop-now, a timeout or a power cut.
4. A delivery unit is `ready` or `failed` with a retry due, or a CI point is due (6.10): run it. Rafi-owned fix tickets come next, before new tickets; they don't count toward `--steps` and aren't limited by `--to-ticket` (decision 10).
5. The scope is reached (`--steps N` tickets done, `--to-ticket` target done, the stacks done) and no CI point or rafi-owned ticket is pending: write `build.finished`.
6. Run any pending re-check (a QA review of a done ticket after a plan restore or a plan update, 7.10), then start the first eligible ticket in queue order: `queued`, every dependency `done`, not held, not excluded by `--skip`, at its `resume_step` if it has one. A ticket unblocked by an answer is eligible again, so its retry starts as soon as the current ticket finishes (NEW-BLK-4).
7. Nothing eligible and an open, not deferred, question blocks a ticket in scope: write `build.waiting`. In a terminal or a background build, hold and remind; in a foreground build without a terminal, release the lease and exit 2 (4.3).
8. Nothing eligible and only deferred questions, held tickets or `unfixed` tickets are left: `build.finished` with `complete: false`, listing them; the summary and a notification remind you (S-BLK-2, SCN-4).
9. Every ticket in scope is `done` or `dropped`: `build.finished` with `complete: true`.

Inside a ticket, the step to run follows from its state: `building·prepare` → prepare (`build/steps/prepare.ts`); `building·build` and `fixing·fix` → a builder turn (`steps/work.ts`); `building·check` and `fixing·check` → rafi runs the checks, no agent (`build/checks.ts`); `reviewing·review` → a QA turn (`steps/review.ts`); `building·deliver` → deliver (`steps/deliver.ts`); a CI point → `build/ci.ts`. `--steps N` counts `done` tickets, so blocked and skipped tickets don't use a step (NEW-BLK-6, OUT-7).

### 4.6 Safe points

A safe point is the moment after a step's outcome is recorded and before the next step starts, and any moment while the build is waiting or paused. At each one the loop:

1. rewrites the progress file (3.7);
2. acts on stop and pause requests;
3. re-reads `.tickets/tickets.yaml`, `delivery.yaml`, `rafi-config.yaml` and the plan, and records changes: material ones follow the plan-update rules (REQ 8.4; 7.10 here), an invalid file becomes a build-wide question (NEW-BLK-7, S-BLK-10);
4. re-checks a reused agent's tag union (NEW-TAG-6, 10.1);
5. scans tickets newly in scope and asks only their new questions (NEW-ASK-1).

**Crash boundaries** (SCN 7.7). The engine calls `deps.hooks.crash(name)` and `deps.hooks.pause(name)` at each:

| # | Boundary | Where |
|---|---|---|
| 1 | after `turn.intent`, before sending | `turns/runner.ts` |
| 2 | after sending, before any reply | `turns/runner.ts` |
| 3 | after the reply arrives, before it's recorded | `turns/runner.ts` |
| 4 | after the outcome is recorded, before the progress file is rewritten | `build/safepoint.ts` |
| 5 | during the progress-file write | `progress/write.ts` |
| 6 | before and after each git operation (commit, branch, merge, push, PR) | `build/steps/deliver.ts`, `git/*` |
| 7 | during other writes: requirements file, `tickets.yaml`, plan files, `rafi-config.yaml` | the writer |
| 8 | inside `rafi migrate` and `rafi tickets populate`, between files | `migrate/apply.ts`, `planning/populate.ts` |
| 9 | after a question is recorded, before it's shown or notified | `ask/questions.ts` |
| 10 | before and after each test run, and between a CI point's suite run and its outcome | `build/checks.ts`, `build/ci.ts` |

Each boundary is named with its occurrence ("4: recorded, before progress write (T2, review, 2nd)"), so a failing crash run names the exact point (SCN 7.7).

Redoing is safe at every boundary because each step is written to be redone: the builder is told on a redo that "an earlier attempt may have left changes in the working tree; check `git status` first"; QA is read-only; prepare overwrites the requirements file from scratch (a half-written one is rewritten, S-CRASH-2); `tickets populate` validates the whole proposal before writing and replaces `tickets.yaml` with one atomic rename, so it holds none or all of the new tickets (S-SCN-10, S-SCN-13); deliver looks before it acts (the commit carries a `Rafi-Ticket: T2` trailer and is found before committing again; a PR is looked up by branch before one is created; a merged PR isn't merged again). Rafi can't take back what an agent with internet access already did outside the project; it doesn't promise exactly-once effects there (harness plan constraint 12).

### 4.7 The fingerprints that remain (principle 10)

| Fingerprint | Protects | If it doesn't match |
|---|---|---|
| `--dirty-work` baselines (FILE-50) | Your uncommitted work | Never overwritten; kept as today (NEW-KEEP-8) |
| Files a ticket may touch (agent permission policy) | Your code outside the ticket | The edit is refused with the file named (S-MAL-4) |
| Requirements file path and fingerprint | QA reviewing what was written | A warning; affected requirements are "unable to verify"; the build goes on (NEW-REQ-5) |
| Worktree snapshot after each builder turn (a git tree id from a temporary index seeded from the real one, so only changed files are hashed and `.gitignore` is respected) | The record of what the builder produced; drift during a review | Changed files are computed from it; drift during a review is reported and the review is redone on a copy of the snapshot (Q-COPY-1, S-QA-7) |
| A check result's tree and the files related to it (6.9) | Reusing a test result only for the code it ran on | The check is rerun, only that one (NEW-CHK-3, NEW-CHK-13) |
| Saved-answer keys | An answer applying only to what it answered (NEW-QAM-4) | The answer goes stale; the question is asked again (7.6) |
| Approved scope | Starting without asking while scope is unchanged (NEW-KEEP-1) | "How does this plan look?" (PRM-71) |
| Locked requirements | Requirements no update may change (NEW-PUA-1) | Rafi asks before touching them |

None guards a hand-off between rafi's own steps, and none stops a build on its own; only a locked-requirement change asks, because that's what locking means.

### 4.8 Workflows and roles as data (decided 2026-11-02, REQ ARCH-13)

1.0 ships exactly one workflow and today's five roles, but both are data, so custom workflows (for example plan, then audit the plan, then build) can be added later without rewriting the state machine. Nothing here is user-facing in 1.0.

- **A workflow** is an ordered list of steps. Each step has a name, a type, a role (for agent steps), and its next step on pass and on fail. `standard` is prepare → build → check → review → deliver, with fix looping back through check and review.
- **Step types.** `maker`: an agent turn that may change code (build, fix). `checker`: a read-only agent turn that gives a verdict per requirement (prepare writes requirements; review gives the verdict). `rafi`: no agent (check, deliver, a CI point). A new step reuses one of these types instead of needing new code.
- **Every step has the same shape.** It reads what it needs from the fold, runs one agent turn or one rafi action, and writes its outcome as events. Steps are registered modules (`build/steps/*`), looked up by type.
- **Loops are per-step limits.** "On fail, go to step X, up to N times." `standard`'s fix loop is that rule, with `retries.fixes` as its limit, and circling detection still applies.
- **Roles are data** (`workflow/roles.ts`): each role's core instructions, reply schema, permissions (read-only or write) and default agent. `agent_defaults.roles` overrides the agent, as today. 1.0's roles: planner, ticket-maker, builder, qa, manager.
- **Load checks** (`workflow/checks.ts`): every step is reachable, every fail path ends (in a pass, `blocked` or `unfixed`), every loop has a limit, every role exists, and each step's type matches its role's permissions (a `checker` role can't write). They run on `standard` in the fast suite and when the engine opens; later the same checks validate users' workflows.
- **Tested from the data.** The every-combination transition test (4.1) builds its pairs from the workflow, so any workflow gets the same coverage.
- **Pinned per build.** `build.started` records the workflow's id, version and digest; a build keeps it to the end, so resume never mixes two workflows.
- **Reserved, rejected in 1.0.** A `workflows:` key in `rafi-config.yaml` and a `workflow` field on a ticket exit 1 with "Custom workflows aren't supported yet." (FMT-C26, FMT-T21), so no config written now breaks later.

## 5. Errors and retries

### 5.1 Categories

Every failure is sorted into one category by one function, `turns/classify.ts` (NEW-ENG-4). The first three groups are principle 4's. "Recorded, not an error" holds what today's engine stops on but shouldn't; "internal" holds the few problems no retry can fix.

**Retry automatically**

| Category | Examples | What rafi does | Budget |
|---|---|---|---|
| `format` | The reply text isn't JSON: trailing content ("at byte 4412"), cut off, prose; Claude ends `success` with no `structured_output` | One repair try in the same session (5.3). If the resend is accepted, use it; if not, redo the turn as a `content` retry with the error sent back (D2) | One repair per attempt; the redo counts toward `retries.turn` |
| `content` | Parses but fails the schema or rafi's checks: missing field, wrong type, an unknown, duplicate or hash-like reference, `not-applicable` the requirements file doesn't allow, two final replies, "done" with an invalid payload, a field naming another ticket or session, Claude's `error_max_structured_output_retries` | Redo the turn with the validation errors in plain words (Q-MAL-1) | `retries.turn` |
| `provider` | Transient provider error, overload, a network blip, the provider process exiting mid-turn, an unknown provider error | Retry with backoff: 10 s, 30 s, 90 s, each ±20% (jitter from `deps.random`); same session if it's still alive, otherwise a fresh one | `retries.turn` |
| `timeout` | No provider message for `timeouts.idle_minutes` (default 30, today's default in `adapters/claude.ts:61` and `adapters/codex.ts:42`) | Cancel the turn, wait up to 30 s for the provider to confirm, then end the provider process; retry with backoff, telling the agent the earlier attempt timed out and may have left changes. Long work with activity is never timed out (S-TIME-1) | `retries.turn` |
| `quota` | A usage limit or rate limit | No tight loop. If the provider reports when it resets and that's within `retries.quota_wait_hours` (default 6), wait until then and retry once, saying so in one line ("Codex usage limit reached; retrying at 19:00. `rafi stop` to stop."). Otherwise a build-wide question: retry now, switch runtime for this build, or stop (S-TIME-2) | One wait per limit |
| `crash` | Rafi itself died | On `rafi resume`, redo the interrupted step (4.5) | None (not the agent's fault) |
| `git-transient` | A push or gh/glab call fails on the network or a rate limit | Retry with backoff, as `provider` (4.3.2) | `retries.turn` |

**Permission needed**

| Category | Examples | What rafi does |
|---|---|---|
| `permission` | The builder reports `blocked(permission)`; a sandbox denies a need nobody granted | If the upfront check found the need and you said no, the ticket was held before step 1 and this can't happen. Otherwise it's a scan gap (`scan.gap`) and a blocked-ticket question with "Grant access" (7.7) |

**Ask the user** (only after retries, or for a real decision)

| Category | Examples | Question |
|---|---|---|
| `auth` | Not logged in, expired, not authorized | Build-wide: "<runtime> is not ready for <label>. What should Rafi do?" retry / switch / cancel (PRM-79, kept); switching states its scope and that continuity is lost (GUI-R13) |
| `fixes-exhausted` | QA rejected, or the checks failed, after `retries.fixes` builder fixes | "T1 still doesn't pass after 3 fixes (failing: R2's test; QA: R3). What next?" (PRM-81, with "I verified it myself"). For a rafi-owned fix ticket nothing is asked: it's `unfixed` (6.10) |
| `circling` | The same failure with no progress (5.5) | The same question, early, saying what repeated |
| `turn-exhausted` | A turn failed `retries.turn` + 1 times | The ticket is blocked (`other`) with the last error in one line; other tickets go on |
| builder blocks | `install`, `service`, `credential`, `decision`, `other` | The blocked-ticket question with the options for that kind (7.7) |
| `person-check` | A person-only check is reached (D4) | Confirm the check (7.8) |
| `provider-question` | Claude's `AskUserQuestion`, or a builder `needs-input` reply | The adapter answers `AskUserQuestion` at once with "The user isn't available in this turn. Reply needs-input with this question." The turn ends as `needs-input`, the ticket is `blocked(decision)` and the question is open like any other, so other tickets keep building; your answer goes to the builder's retry. Recorded as a scan gap (PRM-G6, NEW-ASK-5, S-ASK-3) |
| `delivery` | A merge conflict; a push or PR refused for auth or by the remote | The unit question or build-wide question in 4.3.2 |
| `limit` | A test still running at its time limit | The time-limit question (6.11) |
| `integrity` | `tickets.yaml` became invalid mid-build; a plan file is broken | A build-wide question; affected work waits, the rest goes on (NEW-BLK-7) |

**Recorded, not an error**

| What | What rafi does |
|---|---|
| An agent's claim disagrees with rafi's record ("tests passed" when rafi recorded exit 1) | Rafi's record wins; `facts.mismatch` is logged; no retry (NEW-FACT-1) |
| The requirements file is missing, unreadable or changed | One warning; affected requirements are "unable to verify"; the build goes on (NEW-REQ-5) |
| An agent misspells the requirements path, or doesn't repeat it | Nothing; rafi uses its own stored path (S-QA-5 step 4) |

**Internal**

| Category | Examples | What rafi does |
|---|---|---|
| `environment` | Provider CLI missing; the repo has no commit yet; Node or native-module mismatch | Refuse before any agent turn, one line with the fix (S-ENG-7, S-SCN-1, OUT-10) |
| `storage` | Disk full or `.rafi/` unwritable when appending to the log | One-line stop naming the disk or folder and the command to continue; nothing recorded is deleted. Optional data that doesn't fit is skipped and recorded as skipped (NEW-STATS-3, S-CRASH-2) |
| `bug` | An invariant broke or an exception escaped | `build.failed` with the message and `rafi resume`; resume redoes the step |

### 5.2 Classification inputs

Adapters don't decide anything; they normalize what happened into one of: a reply (text and, for Claude, `structured_output`), a provider error with a code (`transient`, `quota` with its reset time when known, `auth`, `configuration`, `session-gone`, `unknown`), a process exit, an idle timeout, or a cancellation. `classify` maps those to the categories above. Today's probe categories (`spec/src/types.ts:419-422`) are the starting map: `rate-limit` → quota; `network`, `agent-stream`, `malformed-protocol` → provider; `timeout` → timeout; `authentication`, `authorization` → auth; `missing-executable`, `sdk-load`, `configuration` → environment; `session-unavailable` → a fresh session, not an error. An unknown provider error is `provider` (retry), never a stop.

### 5.3 The one repair try (NEW-MAL-2, NEW-SO-1..5, D2)

- **When.** Only for `format` errors whose text has a readable JSON part. A reply with no readable JSON at all is redone as a `content` retry: there's nothing a resend could be compared with.
- **The request.** One template for every role and operation: "Your last reply wasn't valid JSON: {parser error} at byte {n}. Send the same reply again as valid JSON in the same format. Don't run tools, read files or change anything." It goes to the same session with the same schema. The adapter refuses every tool request during a repair turn, and a tool attempt fails the repair (S-MAL-1).
- **Readable parts.** For trailing content at byte n, the value parsed from bytes 0 to n. For a cut-off reply, every complete key and value a tolerant reader recovers before the cut.
- **Accept** only if the resend parses, validates, and has the same value at every recovered path; it may fill in only what the original lost to the cut. Recorded as `turn.repair`, accepted.
- **Reject** otherwise: `turn.repair`, rejected, with why; the original and the resend are kept as blobs (NEW-SO-2); nothing from either changes tickets, plans, QA results, files or build state (NEW-SO-5); the turn is redone as a `content` retry with the error sent back, under circling detection (D2, S-MAL-2).
- **Never repaired.** Content errors, binding mismatches, failed provider turns, claims of evidence rafi never recorded, and scope or security violations each go to their own handling (S-MAL-4; NEW-SO-1's exclusions).
- **Measured.** `rafi stats show` counts `format` outcomes by runtime and role: the malformed-reply rate (NEW-SO-4).

### 5.4 Every retry changes its input (NEW-RTY-1)

A retry never resends the same request. It carries the validation errors, the timeout notice, or an attempt note ("Retry 2 of 3 after a provider error."). S-QA-3 checks that no two consecutive builder requests are identical.

### 5.5 Going in circles (NEW-ENG-5, F09)

- **Failure signature** of an attempt: for a QA rejection, the sorted not-satisfied requirement numbers with the outcome of the runs each one cited; for a check failure, the failing requirement numbers and test names; for a block, its kind and reason; for a `format` or `content` failure, the error class and the field.
- **No progress**: the signature equals the previous attempt's, the builder's fix produced no new snapshot (its tree id was already seen on this ticket), and it read no file it hadn't read in an earlier attempt on this ticket (from `attempt.summary`, a `state` event, so this works at every capture level). New files read or a different fix (a new tree) is healthy exploration, not circling.
- **Circling**: `retries.circling_repeats` (default 2) no-progress attempts in a row. It stops retries before the budget runs out and raises the same question the budget would, saying what repeated ("QA found the same problem with R2 three times, and the last two fixes changed nothing").
- Worked through: in S-QA-3 script A, QA rejects R2 on attempts 1, 2 and 3 with no file change between them, so rafi asks after 2 fixes, before the 3-fix allowance is used. In S-MAL-2's third variant, the same changed resend repeats and the retries stop before `retries.turn`.

### 5.6 Settings

```yaml
retries:
  fixes: 3              # builder fix attempts per ticket after QA rejects or a check fails (Q-CFG-3); the limit on standard's fix loop (4.8)
  turn: 3               # retries of one agent turn: Q-CFG-3's 3 provider-error retries, applied to every
                        # reason a turn is redone (provider errors, timeouts, replies still invalid after repair)
  circling_repeats: 2   # no-progress attempts in a row that count as going in circles
  quota_wait_hours: 6   # longest automatic wait for a usage limit to reset
timeouts:
  idle_minutes: 30      # was RAFI_PROVIDER_IDLE_TIMEOUT_MS (ENV-4, Q-CFG-1)
  check_quiet_minutes: 2   # a test run printing nothing this long is hung (6.9)
  check_minutes: 5         # one ticket's targeted test run (6.9)
  suite_minutes: 20        # one full-suite run (6.10)
checks:
  ci_tests: full            # full | light | none (6.10)
  ci_when: end-of-build     # each-ticket | each-pr | end-of-build | light-each-pr-full-end (decision 6)
  ci_blocks_merge: false    # a suite still failing after the fix ticket doesn't stop the merge
  test_runner: "npx jest"   # found by rafi create from package.json; run_check accepts it with file or test-name arguments
  output_paths: [coverage/, test-results/]   # test output that doesn't make results stale (6.9)
git:
  managed_by: rafi          # rafi | me (ARCH-6); "me" means branch strategy current and completion none
```

- These replace the `autonomy` profiles (`ai-foreman/src/recoveryPolicy.ts:20-33`: fixes 2/3/5, transient retries 0/3/5, format corrections 1/2/3) and `--autonomy` (FLAG-ST-33). `rafi migrate` writes the same limits a project had (S-MIG-1).
- "Retry another Builder fix" and Manager `/request-attempt` each grant exactly one more fix (`fix.granted`), then ask again (S-QA-2 step 6).
- Budgets are folded from `state` events, so they survive restarts, `rafi resume` and a move to another computer (the progress file carries `fixes` for in-progress tickets).

## 6. Agent reply formats

### 6.1 Rules (principle 6, NEW-MAL-7, NEW-REF-1..3)

- **One schema per role and step**, defined once in `rafi-spec` as zod. It's emitted as JSON Schema draft-07 for Claude (the Agent SDK validates against draft-07; checked in the SDK docs on 2026-11-01) and as Codex's strict projection, in which every property is required and an absent value is `null` (today's `projectCodexSchema`, `spec/src/structuredOutput.ts`; the reason is in the comment at `spec/src/operationContracts.ts:67-71`).
- **Flat**, for the builder and QA replies: a top-level `kind` only where a reply has more than one shape; at most one level of nested objects; no unions below the top level. The Planner and Ticket Maker keep today's deeper formats (6.5); they're the replies most likely to come back malformed, so their repair and retry rules matter most.
- **Each fact once**, and **no IDs rafi already has**: no ticket, run, session, hand-off or finding IDs, no continuity section. A reply that adds a field (for example a ticket ID) fails the schema, which is how a binding mismatch is caught (S-MAL-4).
- **Small numbers for references.** Requirement numbers (`R3` in text, `3` in JSON) and run numbers (`run 4`) are assigned by rafi, per ticket, and checked exactly: a missing, duplicate or out-of-range number, or anything hash-like, is a `content` error. No nearest match (NEW-REF-3).
- **Nothing rafi records itself**: changed files, command output, exit codes, durations, times.
- **The format is described once**, in the agent's standing instructions; per-turn messages don't repeat it (NEW-INS-2).
- Every example below is complete: these are the whole replies.

### 6.2 Builder (build and fix turns)

```json
{ "kind": "done", "summary": "Added the empty-state message to the panel and a test for it.", "runs": [4], "block": null, "question": null }
```

```json
{ "kind": "blocked", "summary": null, "runs": [], "block": { "type": "permission", "need": "internet", "reason": "Internet needed to install PostgreSQL" }, "question": null }
```

```json
{ "kind": "needs-input", "summary": null, "runs": [], "block": null, "question": { "text": "Which currency should prices use?", "choices": ["USD", "EUR"] } }
```

| Field | Values |
|---|---|
| `kind` | `done`, `blocked`, `needs-input` |
| `summary` | One or two sentences, for people; `null` unless done |
| `runs` | Rafi's run numbers the builder relies on: it cites recorded commands instead of retyping their output (NEW-MAL-7). Test results count only as `check.run` records (6.9) |
| `block.type` | `permission`, `install`, `service`, `credential`, `decision`, `other` (the six kinds of SCN 2.2) |
| `block.need` | For `permission`: `internet`, `local-servers`, `installs` or `services` (Q-FLAG-2). For `credential`: the environment variable's name. Otherwise `null` |
| `block.reason` | One line in the builder's words; shown as is, never as JSON (NEW-MAL-4) |
| `question` | For `needs-input`: the question and its choices (an empty list allows free text) |

The instructions say "report `blocked` rather than swap in a different stack or tool than the ticket names" (NEW-MAL-5) and "report needs-input; don't ask the user" (NEW-INS-5).

### 6.3 QA: writing the requirements file (prepare turn)

```json
{
  "requirements": [
    { "from": 1, "text": "Clicking \"Send test push\" shows \"Sent\".", "check": "npm test -- push.test.ts", "expect": "passes" },
    { "from": 2, "text": "The push arrives on a real phone and opens the app.", "check": null, "expect": null }
  ],
  "in_scope": ["The Send test push button", "Delivering a test push"],
  "out_of_scope": ["Scheduling pushes"],
  "risks": ["The push provider's sandbox can be slow"],
  "add_tags": ["ui"]
}
```

- `add_tags` is QA preparation's double-check of the ticket's tags (NEW-TAG-1): tags it thinks are missing, from the fixed and project lists only. Rafi adds them with the reason "QA preparation"; tags are never removed.
- `from` is the ticket's acceptance-criterion number the requirement comes from (one criterion may give several requirements).
- QA writes content; rafi does the rest (Q-REQ-3: QA's session is read-only, so rafi writes the file): it numbers the requirements `R1…Rn`, copies the Planner's person-only and locked marks from the ticket's criteria (FMT-T18, FMT-T19), sets the depth (the Planner's choice raised to the enforced minimum for the ticket's risk, recorded once, S-QA-5, Q-REQ-1), and renders the Markdown:

```markdown
<!-- rafi requirements v1 ticket=T2 depth=standard -->
# T2: Send a test push

## Requirements
- **R1** Clicking "Send test push" shows "Sent". Check: `npm test -- push.test.ts`, expect it to pass. *(acceptance 1)*
- **R2** The push arrives on a real phone and opens the app. *(acceptance 2; person-only)*

## In scope
- The Send test push button
- Delivering a test push

## Out of scope
- Scheduling pushes

## Risks
- The push provider's sandbox can be slow
```

### 6.4 QA: the verdict (review turn)

```json
{
  "results": [
    { "req": 1, "status": "satisfied", "runs": [6], "needs": null, "note": null },
    { "req": 2, "status": "not-satisfied", "runs": [7], "needs": null, "note": "With an empty list the panel renders nothing." },
    { "req": 3, "status": "unable", "runs": [], "needs": "browser", "note": "The panel only renders in a browser." }
  ],
  "summary": "R2 fails; R3 needs a browser."
}
```

| Field | Values |
|---|---|
| `status` | `satisfied`, `not-satisfied`, `not-applicable` (a `content` error unless the requirements file allows it for that requirement), `unable` (NEW-REQ-3) |
| `needs` | With `unable` only: `browser`, `device`, `person`, `service`, `file`, `other`. It lets rafi offer the right tool (S-TOOL-1) without guessing from prose |
| `runs` | Run numbers QA's verdict rests on: QA's own runs in this turn, or the builder's |

Rafi derives the outcome: any `not-satisfied` is a rejection; otherwise a pass, with every `unable` listed as unverified. An `unable` whose `needs` a known, unconfigured tool would meet asks you (`blocked(unverified)`, 4.2); any other `unable` (including those caused by a missing or changed requirements file, NEW-REQ-5) is recorded and the ticket goes on. Every non-person-only requirement must have a result; person-only ones are optional (QA may report a partial check, D4). QA reviews against the requirements file only and adds no scope it doesn't ask for (NEW-REQ-4).

### 6.5 Planner and Ticket Maker

The payloads keep today's formats: the structured plan (FMT-P1–P7) and the flat ticket-population wire (`kind`, `summary`, `payload` at the top level, `spec/src/operationContracts.ts:72-79`). The changes:

- **Added** per slice or ticket: `tags`, `needs` (what the upfront scan reads, 7.2), `open_decisions`, and acceptance-criterion numbers for `person_only` and `locked`.
- **Removed**: the generic envelope's `continuity` section and nested `result` union (`operationContract`, `spec/src/operationContracts.ts:21-30`), and the `STEP_STATUS` success line (FLAG-PL-12: the plan is accepted when its JSON validates).

One ticket in a population reply:

```json
{ "id": "T2", "order": 2, "title": "Store prices in PostgreSQL", "area": "data", "summary": "Move prices from the JSON file to a prices table.",
  "priority": "P1", "size": "M", "risk": "Medium", "depends_on": ["T1"],
  "acceptance": ["Prices are read from PostgreSQL.", "A migration creates the prices table."], "required_tests": ["npm test -- prices"],
  "likely_files": ["src/db/prices.ts"], "rollback": "Revert the migration.", "tags": ["database"],
  "needs": { "internet": "Install PostgreSQL 16", "local_servers": "Tests start PostgreSQL on a local port", "installs": ["postgresql@16"], "services": [], "credentials": [] },
  "open_decisions": [], "person_only": [], "locked": [1] }
```

### 6.6 Planner change (a plan update during a build)

Used by "Change T2 with the Planner" (NEW-BLK-3) and "Discuss with read-only Planner" (PRM-83):

```json
{ "kind": "change", "summary": "Use an embedded PostgreSQL for T2's tests; the host has no database.",
  "tickets": [ { "id": "T2", "acceptance": ["Prices are read from PostgreSQL.", "Tests use an embedded PostgreSQL."], "required_tests": ["npm test -- prices"], "likely_files": ["src/db/prices.ts", "test/pg.ts"] } ],
  "add": [], "drop": [], "question": null }
```

`kind` is `change`, `no-change` (with `summary` saying why) or `needs-input`. Each changed ticket lists only the fields it changes. Rafi shows it in plain English, never as JSON (PRM-83), and applies it under the plan-update rules (7.10).

### 6.7 Manager

Manager answers in plain text; it has no reply schema. Its host commands (`/qa-report`, `/pause`, `/report`, …) run without a model turn and print views of the event log (8.3, FLAG-MG-3). The instance report (GUI-R18) is built by rafi from the log, not written by the model, so it always matches `rafi status` (S-CLI-18).

### 6.8 What's gone from today's replies

| Today | Where | 1.0 |
|---|---|---|
| A generic envelope `{version, operation, result: {kind, summary, payload}, continuity}` | `spec/src/operationContracts.ts:21-30` | `kind` at the top, where needed |
| The continuity object every operation reply carries | `operationContracts.ts:28`; `ai-foreman/src/continuity.ts:50,171` | Gone: fresh sessions per ticket, and the log holds what happened |
| Coverage claims with evidence objects, `verifiedInstructionIds` | `spec/src/qaOutputContracts.ts:15-20,44-52` | Requirement results that cite run numbers |
| `handoff_id`, `finding_key`, duplicate summary and reason fields | `spec/src/schemas.ts:56-65`; malformed-reply doc items 8–11 | Gone (NEW-MAL-7) |
| 14 QA-related operations (`builder-coverage`, `work-report`, `build-preflight`, `session-initialization`, `qa-recovery-acceptance`, `builder-remediation`, `qa-verdict`, `qa-contract-acceptance`, `qa-contract-segment`, `handoff-acceptance` and 4 preparation steps) | `spec/src/qaOutputContracts.ts:59-64` | 3: builder (6.2), requirements (6.3), verdict (6.4) |
| The 24-character hash check IDs agents copy | `ai-foreman/src/qaVerificationContract.ts:47` | Small numbers (NEW-REF-1) |

### 6.9 Test runs: rafi runs them and records the results (decision 5)

Agents never prove a test passed by saying so. Rafi runs every test command itself and records the result, the way CI does.

- **Two tools.** Each builder and QA session gets rafi's `run_check(command)` and `check_output(run)`. `run_check` runs a test and returns the run number, exit code, the failing tests and a short excerpt; `check_output` returns a run's full output. A test an agent runs in its own shell is never proof; only `check.run` records count.
- **How agents reach them** (decision 7). Claude gets them in-process (the SDK's `createSdkMcpServer`, `sdk.d.ts:466`). Codex can add an MCP server only as a command it launches or a URL (`codex mcp add --help`, codex-cli 0.164.0); client-side tools exist only in app-server's experimental schema. So the engine serves both tools on a local-only HTTP MCP endpoint (127.0.0.1, a random port, a per-session token), given to the Codex thread as `mcp_servers.rafi.url`. One process, no IPC, stable surface only. M2 checks this first, exactly as it will ship.
- **What `run_check` accepts.** Only: the requirements file's check commands; the project's test runner (`checks.test_runner`) with file or test-name arguments; and the setup script. Anything else is refused and recorded (`outcome: refused`) with the reason, so it can't be used to run `rafi answer`, `rafi stop` or any other command. Every request also goes through the agent permission policy (7.6, 11.3).
- **Where and with what access.** Rafi runs the command in the builder's worktree under an operating-system sandbox that matches the build's grants (macOS `sandbox-exec`, Linux bubblewrap; which tool, and whether loopback can be allowed without internet, is checked in M2, **unverified**; if one conflicts badly with what tests need and a solid replacement without that problem exists, M2 switches to it): project files writable, internet, local servers and installs only if granted (7.2). Test output is written as usual. Caches that would go to your home folder are pointed at the ignored `.rafi/cache/` (for example `npm_config_cache`). No QA copy is made for tests (NEW-MAL-6).
- **QA's requests.** QA stays read-only. When it asks for a test, rafi runs it the same way, then puts back any tracked file the run changed (from the snapshot) and records `restored`, so QA can't change the code through a test.
- **The seam** is `deps.checks.run` (8.2): the real one streams a child process's output; the harness's is scripted on the fake clock, so hung and slow tests take no real time (S-CHK-4).
- **Builder.** It runs the requirements file's checks through `run_check` and fixes failures before it reports `done`.
- **The check step** (4.2), after every builder turn that reports `done`: every requirement's check needs a passing run that's still fresh. A result is stale when a file it depends on changed since it ran: the files changed since that run's tree (tracked and non-ignored files, minus `checks.output_paths`), matched to tests with the runner's related-files query (`jest --findRelatedTests`, `vitest related`). Without that query, any change makes it stale. Only stale checks rerun. If one fails, the ticket goes straight back to the builder and the QA turn is skipped (`fixing·fix`, counted against `retries.fixes`).
- **What the builder gets back after a failure** (decision 9). For every failing run: its run number, the command, each failing test's name and file, the error message and the top of the stack, an excerpt of the output, and how to read the rest (`check_output(4)`). The instruction: "Fix the code so these tests pass. Keep the work you've done; don't start over. Rerun them with `run_check`." The same applies to fix turns after QA findings, CI fix tickets and person-only checks that failed.
- **With QA off** (`--no-qa`; decision 9). There's no requirements file, so the check step runs the ticket's `required_tests` and the tests related to its changed files. A failure goes back to the builder as above.
- **Only relevant tests.** During a ticket, only the requirements' checks and the related tests run. The full suite runs only at rafi's CI points (6.10).
- **Time limits** (6.11): a run that prints nothing for `timeouts.check_quiet_minutes` (2) is hung: stopped and recorded `timed-out`, a failure. A run still printing when it reaches `timeouts.check_minutes` (5) is slow, not broken: stopped, recorded `too-slow`, and not counted as a failure.
- **A check that edits code files.** Rafi compares the tree before and after each run. If tracked files changed (for example a formatter run with `--write`), the run is recorded as `changed-code` with the files named, which counts as a failure, and the builder fixes it.
- **Also used by:** QA's re-check of a done ticket (7.10) reads `check.run` records the same way; browser checks (Playwright test files) run through `run_check`; the setup script is run by rafi (10.2) and recorded, so "setup worked" is a record, not the builder's word.

### 6.10 The full test suite: rafi's CI points (decisions 5, 6 and 10)

The full suite runs at rafi's CI points, never as part of a ticket's own checks. Done tickets are never reopened; problems are fixed forward.

- **Per ticket, before it counts as done**: its requirements' checks plus the tests related to its changed files (6.9). Most breakage is caught at the ticket that caused it, while it's still open.
- **Who manages git** (ARCH-6). `git.managed_by: rafi | me`, asked first in `rafi create` and `rafi tickets setup:*`: "Who manages git: Rafi or me?" "Me" sets branch strategy `current` and completion `none` and skips every branch, PR, merge and CI question. **Rafi handles git** when `managed_by` is `rafi` and completion is `pr`, `pr-ready`, `auto-merge` or `direct-merge`; only then are there CI points. With `managed_by: me`, or completion `none`, rafi runs no suite (in "Current branch — Rafi works here; you manage Git", rafi makes no branches, commits, pushes or merges, `rafi/src/workMode.ts:3,12`).
- **The settings** (5.6). `checks.ci_tests: full | light | none` (default `full`); `light` runs the tests related to every file the build changed. `checks.ci_when` (decision 6):

| `ci_when` | CI points |
|---|---|
| `each-ticket` | after each ticket's checks and review, before it's delivered |
| `each-pr` | when a delivery unit is ready, before its merge or PR |
| `end-of-build` (default) | once, after every ticket in scope is done |
| `light-each-pr-full-end` | `light` before each unit's merge or PR, plus `full` once at the end |

  `checks.ci_blocks_merge` (default `false`) decides what a suite still failing after the fix ticket does. With it on, merges wait for their CI point, so `end-of-build` holds the build's merges until the end.
- **Asked once.** The upfront check (7.2) confirms it: "Rafi runs the full test suite before merge. Keep that, or manage full test suite runs yourself?" Auto-approve keeps the default. The GUI shows "CI testing" (Full, Light, None) and "When" dropdowns only when rafi handles git, and, when testing is Full or Light, a "Failing tests block merge" switch, off by default.
- **What `end-of-build` tests.** The combined result: the base branch after rafi's merges, or, for PR completions, a temporary merge of the build's branches in a throwaway git worktree.
- **Nothing runs twice** (decision 6). Rafi skips a test whose last passing run is still fresh by 6.9's rule (nothing it depends on changed since), using per-test results when the runner reports them (`jest --json`, `vitest --reporter=json`; otherwise the whole command reruns). Skipped tests are listed as reused in `suite.run`. CI that you run elsewhere, such as GitHub Actions, isn't rafi's to change.
- **Nothing added to your repo.** Rafi never writes CI workflows, required checks or branch protection.
- **If it fails:**
  1. Failing tests that also fail on the build's starting commit were already broken; a failing test that passes when rerun on the same commit is flaky. Both are reported once and don't block. These reruns, and the ones that find which ticket probably caused a failure, run in a throwaway git worktree at that commit, removed afterwards; the builder's worktree isn't touched.
  2. For the rest, rafi adds a fix ticket at the front of the queue (`ticket.added`, "Fix 3 failing tests"), with each failing test as a requirement, the failing runs' details (6.9), and a hint of which ticket probably caused it. It's built AFK like any ticket. Then the CI point runs again, and on a pass rafi delivers.
  3. If the fix ticket runs out of `retries.fixes`, or circles, it becomes `blocked(unfixed)`: no question, and the build isn't stopped. With `ci_blocks_merge: false` rafi merges (or opens the PR) anyway and tells you which tests still fail (terminal, notification, end-of-build summary). With `true`, rafi commits and pushes the branch without merging and tells you. The fix ticket stays open for a later build.
- **Rafi-owned tickets** (decision 10): CI fix tickets and re-check fix tickets (7.10). You're told once (terminal line, notification, summary) and never asked; they aren't plan updates, write no plan revision, and stay out of the scope fingerprint; they don't count toward `--steps` and aren't limited by `--to-ticket`.

Events (3.4): `suite.run`, `ci.result`, `ticket.added`. A CI point is a step: a crash during it redoes it (boundary 10), reusing every result already recorded.

### 6.11 Slow test suites (decision 5)

- **Spotting one.** Every `check.run` and `suite.run` records its duration. A run still printing output when it reaches its limit is slow, not hung (6.9).
- **Asking.** Rafi asks once (question kind `limit`): "Tests here take longer than 5 minutes. Raise the limit to 10?" It suggests double the limit; you can type another number, or keep the limit (the test is then recorded as failing). The answer is saved to `rafi-config.yaml`. Until you answer, only that ticket (`blocked(limit)`) or that CI point waits; the rest keep building. A limit question asked mid-build is expected, not a scan gap.
- **Auto-approve** answers yes and saves the new limit, like its other answers (7.4).
- **Next build.** When saved durations already exceed a limit, the upfront check asks there instead (7.2), suggesting 1.5 times the longest recorded run.

## 7. Ask everything up front, and the question record

### 7.1 When the scan runs (NEW-ASK-1)

- **Right after tickets are made** (`rafi tickets populate`, and `rafi tickets plan` when it writes tickets), over every ticket. You answer once, there.
- **Before each build** (`rafi start`, `rafi resume`), over the tickets in scope: only questions still unanswered, plus new ones from tickets added or changed since (S-ASK-5).
- **At safe points**, for tickets that newly enter scope (a reorder, an added ticket).

### 7.2 What it looks for (NEW-ASK-2, NEW-PERM-1)

| Need | Where rafi finds it | Asked as |
|---|---|---|
| Internet, local servers, installs, live services | Each ticket's `needs` (written by the Planner and Ticket Maker, 6.5); the `permissions` of each tool a ticket gets through its tags (NEW-TOOL-6); install commands in `scripts/rafi-setup.sh`, found by a fixed list (`npm`/`pnpm`/`yarn`/`bun` install or add, `pip install`, `brew install`, `apt-get install`, `cargo install`, `go install`, `gem install`), which add one `installs` and `internet` need for the whole build, because rafi runs the script once per build (10.2, Q-SET-1, S-ENG-3); what the CI points' suite needs (local servers, for example) | Allow once / Always allow (this machine) / Don't allow / Answer later |
| Credentials | `needs.credentials`: environment variable names. Rafi checks that each is set in `deps.env`, never its value | "I've set it (check again)" / Answer later. Never "type the secret here" (S-BLK-9) |
| Product decisions | `open_decisions` on a ticket | The Planner's options / Answer later. Auto-approve never answers these (D3) |
| The plan-update setting | `plan_updates` missing from `rafi-config.yaml` | Change, then tell me / Ask me first; for this project or this build (NEW-PUA-6) |
| The CI confirmation | Rafi handles git (6.10) and `checks.ci_tests` isn't saved | Keep (full suite, end of build) / Manage full test suite runs myself (6.10) |
| Known slow tests | Recorded durations from earlier builds already over a limit | Raise to <1.5 times the longest run> / Keep the limit / Answer later (6.11) |

Skipped because already answered: `--allow` grants, "always allow" grants on this machine, saved answers whose keys still match (7.6), settings in the config. **Not scanned**: checks only a person can do; they're asked when the build reaches them (D4, 7.8). A time limit first hit mid-build is asked then (6.11). With `git.managed_by: me` there's no CI confirmation.

### 7.3 The one list (NEW-ASK-3)

```
rafi: Before the build starts, 6 things need you (20 tickets in scope).
  1. Internet access, for T2: install PostgreSQL 16
     › Allow once   Always allow (this machine)   Don't allow   Answer later
  2. Local servers, for T4: tests start a server on a local port
  3. Installs, for T6: adds the sharp package
  4. Live service, for T20: calls the Stripe test API
  5. API key, for T11: STRIPE_KEY isn't set in your environment
     › I've set it (check again)   Answer later
  6. Decision, for T15: "Which currency should prices use?"
     › USD   EUR   Answer later
```

- Each item names the tickets that need it. "Don't allow" holds those tickets before step 1, with the reason shown, and the rest build (NEW-PERM-2, S-PERM-1).
- "Answer later" saves the question; its tickets wait; the build starts with everything else; reminders follow (NEW-ASK-4, 10.4).

### 7.4 Auto-approve (principle 14, Q-APR-1, D3)

- On with `--auto-approve` (`-y` and `--yes` still work, FLAG-ST-17) or `approvals.mode: auto` in the config (FMT-C22). A coordinator can set the mode (GUI-MAE-4).
- **Granted without asking:** local servers, and every question with a safe default (the plan question PRM-71, scope approval), each recorded with `by: auto-approve`.
- **One warning, once, in the upfront list**, for internet, installs and live services, with five choices: continue (this build); always allow (this machine, Q-PORT-2); stop and deny (the build doesn't start, exit 0); deny but build the rest (those tickets are held); show which tickets need it and why (then ask again).
- **The plan-update setting**, when it isn't saved, is filled with "change, then tell", saved to `rafi-config.yaml`, and recorded as chosen by auto-approve. Before the next build rafi prints once: "Plan updates are set to 'change, then tell you' (saved by auto-approve on <date>). Change it in `rafi-config.yaml`." It never overrides a saved setting (D3, S-PLAN-3).
- **Never answered:** product decisions and credentials. They stay in the list with "answer later".

### 7.5 Without a terminal (OQ-5)

No prompt is shown. Every remaining item, including auto-approve's warned items, becomes an open question with a notification and an entry in `rafi answer`. The tickets that need one are held (`blocked(held)`); everything else builds; a foreground run exits with code 2 once only held tickets remain (Q-OUT-1, S-PERM-2 step 4); a background run keeps waiting (4.3, decision 8). `--allow` or a saved "always allow" answers warned items ahead of time.

### 7.6 The question record (NEW-GUI-5, NEW-NOT-1, PRM-G1)

- **Fields** (`question.opened`): id, short number, kind, tickets, text, options (id and label), recommended option, context, urgency, time, and a saved-answer key.
- **Short numbers** count up per project and are never reused; `rafi answer` lists them (Q-CMD-2): `rafi answer` lists and asks; `rafi answer <n> <choice number or text>` answers one; an unknown number exits 1 (S-CLI-16).
- **Kinds:** upfront items (permission, credential, decision, plan-update setting), blocked, what-next, unverified, confirm, plan (scope approval, an ask-first plan update, a locked-requirement change), provider question, runtime (login, usage limit), build-wide, dependent (a dependency was dropped), limit (a test's time limit, 6.11), CI (the upfront confirmation), delivery (a merge conflict or merge wait, 4.3.2).
- **First answer wins.** Every surface calls one engine action, `answer(question, answer, source)`. In one `BEGIN IMMEDIATE` transaction it folds the question's state. If it's open, it appends `question.answered` and whatever the answer causes (`ticket.unblocked`, `grant.recorded`, `fix.granted`, …). If it's already answered, it writes nothing and returns who answered and when. SQLite serializes writers, so the first answer wins even across processes (S-NOT-2, S-BLK-8).
- **Surfaces:** the pinned prompt (in the build's terminal and in any attached `rafi resume`), a desktop notification, `rafi answer`, Manager `/answer-question`, later the GUI. Each watches the log (8.4); when a question closes it updates to "answered in notification" (or wherever it was answered) or closes.
- **Free text** is stored exactly as typed. Every command rafi prints quotes its arguments with one shell-quoting function, so it works when copied (PRM-G9, S-SCN-6).
- **No agent answers a question.** The agent permission policy refuses any agent tool request that would run `rafi answer`, `rafi stop` or anything else that writes rafi's state (PRM-G8, S-NOT-1).
- **Gaps.** A question that comes up mid-build and that the scan should have found is recorded as `scan.gap` (NEW-ASK-5). A person-only check and a time-limit question are expected, not gaps.

**Saved-answer keys** (NEW-QAM-4, Q-QAM-3). A key names exactly what an answer answered, and the answer applies only while that's unchanged:

| Answer | Key | Stale when |
|---|---|---|
| "What next?" | `what-next \| T1 \| <verdict event id> \| <tree of the files its findings cite>` | QA's rejection is replaced, or those files change (S-QA-4 c) |
| "I verified it myself" | `waiver \| T1 \| <waived findings> \| <tree of the files they cover>` | Those files change (S-QA-2 step 3); a README-only edit doesn't count |
| Person-only confirmation | `confirm \| T2 \| <check text digest> \| <tree of the ticket's files>` | The check's text or the ticket's code changes |
| Product decision | `decision \| T15 \| <decision text digest>` | The decision's text changes |
| Grant | `grant \| internet \| build:<run>` or `grant \| internet \| machine:<project path>` | The build ends (once), or you revoke it |
| Scope approval | `scope \| <plan revision> \| <digest of material ticket fields in scope>` | A material change (PRM-71) |

Saved answers are committed in the progress file; grants aren't (Q-PORT-2).

### 7.7 Blocked tickets: the pinned prompt and its options (NEW-BLK-1..8)

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

- One line each for what's blocked, why (the builder's own words, never JSON), what waits on it and what rafi is doing now (NEW-BLK-2).
- Options fit the reason. For the builder's six kinds this plan keeps SCN's table (S-BLK-9) with one change: a `permission` block also offers "I fixed it myself", as RW's decided example does (the reason may be something you can fix outside rafi, such as installing PostgreSQL yourself). SCN says the scenario follows the plan here.

| Kind | Grant access | I fixed it myself | Skip for now | Give the builder instructions | Change it with the Planner | Drop it | Stop the build |
|---|---|---|---|---|---|---|---|
| `permission` | yes | yes | yes | yes | yes | yes | yes |
| `install` | no | yes | yes | yes | yes | yes | yes |
| `service` | no | yes | yes | yes | yes | yes | yes |
| `credential` | no | yes | yes | no | no | yes | yes |
| `decision` | no | no | yes | yes | yes | yes | yes |
| `other` | no | yes | yes | yes | yes | yes | yes |

- Rafi's own kinds:

| Kind | Options |
|---|---|
| `what-next` | Retry another Builder fix / I verified it myself (a note is required) / Explicitly waive QA (then PRM-82's confirmation) / Discuss with read-only Planner / Pause at this checkpoint (PRM-81) |
| `unverified` | Connect `<tool>`, then retry QA / I verified it myself / Continue with R3 unverified / Skip for now |
| `confirm` | It works (confirm) / It doesn't (your note becomes a finding and the builder fixes it; counts against `retries.fixes`) / Skip for now / Drop it |
| `limit` | Raise the limit to <suggested> (or type one) / Keep the limit (the test counts as failing) / Answer later (6.11) |
| `delivery` | A conflict: Builder resolves the conflict / Skip this merge (the branch stays pushed) / Stop the build. A merge wait timed out: Keep waiting / Merge it myself, then continue / Skip the units that wait on it (4.3.2) |
| `unfixed` | None: nothing is asked; the ticket is listed in the summary for a later build (6.10) |
| `held` | The upfront item's own choices (7.3) |
| `build-wide` | Fixed it, retry / Stop the build; plus "Grant access" for a project-wide permission |
| `dependent` | Drop T5 too / Build T5 anyway / Change T5 with the Planner / Skip for now (S-BLK-3) |

- Answer any time by typing a number; a retry starts when the current ticket finishes (NEW-BLK-4). Several blocked tickets each get their own pinned question, oldest first (S-BLK-7). With nothing left to build, rafi keeps waiting with the question showing, reminds you, and in a terminal never exits on its own; Ctrl+C stops it and the question stays for `rafi resume` (NEW-BLK-5).

### 7.8 Checks only a person can do (D4)

1. The Planner marks person-only acceptance criteria on the ticket (`person_only`, FMT-T19); the requirements file marks them too (6.3).
2. QA verifies everything it can, with Playwright or a headless browser (mobile-mcp for mobile), including partial checks such as "clicking Send test push shows Sent".
3. Once QA's verdict passes, rafi asks each person-only check: a pinned prompt and a notification naming the ticket and quoting the check. The ticket and its dependents wait (`blocked(confirm)`); everything else builds.
4. Confirming delivers the ticket and marks it done, with the confirmation in its validation record. "It doesn't" sends your note to the builder as a finding.

Settings, per project in `rafi-config.yaml` or per ticket (FMT-C16, FMT-T20): `manual_checks: wait` (the default above), `none` (setting B: the criterion is an ordinary requirement; QA marks it "unable to verify"; nothing is asked) or `track` (setting C: don't wait; the check stays an open question; the end-of-build summary lists it and the tickets built on it).

### 7.9 "Waiting on you since …" (NEW-ASK-6)

- The terminal title and the status line show "Waiting on you since 14:05 (T2)": the oldest open, not deferred, question that blocks work in scope. It clears when that's answered (S-ASK-4).
- `rafi status` shows the same line; the end-of-build summary says how long rafi waited on you (the time a blocking question was open).

### 7.10 Plan updates and scope approval (NEW-PUA-1..8, NEW-KEEP-1)

- **Scope approval at start.** Rafi keeps the key of the last approved scope (7.6). Unchanged: the build starts with no plan question. A material change: "How does this plan look?" (Proceed / Give feedback / Cancel, PRM-71); feedback goes to the Planner and rafi asks again (S-START-3).
- **What counts** (OQ-6, NEW-PUA-3). Only edits by you or the Planner. Tags rafi adds itself (QA preparation, file patterns) and rafi-owned fix tickets aren't plan updates and stay out of the scope fingerprint (decision 10). Changes only to `title` or `summary` are rewording. A plan update is any change to acceptance criteria (with their person-only and locked marks), required tests, dependencies, likely files, tags or order, or adding or removing a ticket. The Planner rewording acceptance text counts, because it changes what QA checks. A change to `needs` or `open_decisions` isn't a plan update; it re-runs the scan for that ticket (7.1).
- **Where updates come from.** The Planner (the blocked prompt's "Change it with the Planner", "Discuss with read-only Planner"); your edits to `tickets.yaml` or `rafi tickets reorder` and similar during a build, found at the next safe point; `rafi tickets accept-future-work` adding a ticket.
- **Locked requirements** (NEW-PUA-1). For ticket-level locks, rafi checks deterministically that every locked criterion's text and mark are unchanged. For the project-wide list (`locked_requirements`), a short independent check turn by the QA role (read-only) returns which locked items a proposed change would change, drop or weaken, by number: `{ "touches": [1], "why": "Replaces PostgreSQL with a JSON file." }`. If anything is touched, rafi doesn't apply the change; it asks, naming exactly which locked item would change (S-PLAN-2). The Planner is given the locked list in its standing instructions.
- **Change, then tell** (the default) or **ask first** (`plan_updates` in the config, or for one build). Applying a change writes a new plan revision under `<docs>/rafi-plans/` (earlier ones are kept, FILE-21), updates `tickets.yaml`, and appends `plan.changed`. Affected tickets get a new requirements file on their next start, and their saved QA results and approvals go stale; unchanged tickets keep theirs (NEW-PUA-7, S-PLAN-1). A done ticket whose criteria changed gets a re-check, as after a restore.
- **You're told** at the moment it happens (one terminal line with what changed and why), in the end-of-build summary, and in the plan-change log, `rafi plan changes`. When you're away (no terminal, or no key pressed in the build's terminal for 10 minutes) a notification goes out too (NEW-PUA-4).
- **Switching back** (Q-PUA-1, Q-PUA-2): `rafi plan restore <revision>` for the whole plan, or `--ticket <id>` for one ticket. Code is never deleted or reverted. Rafi records `plan.changed` (kind `restore`) and queues a re-check of each affected done ticket: a QA review against the restored requirements that leaves the ticket done; a failure becomes a rafi-owned fix ticket (`ticket.added`, NEW-PUA-5, S-PLAN-5). `decide` runs pending re-checks before starting new tickets (rule 6 in 4.5), recorded as `recheck.requested` and `recheck.recorded`.
- Approving a plan update never grants a permission (S-PLAN-3).

### 7.11 Grants and how they reach agents (NEW-PERM-1..4, NEW-MAL-6)

- **Needs:** `internet`, `local-servers`, `installs`, `services` (Q-FLAG-2). One grant covers the builder and QA (RW:82). An install fetches packages, so `installs` implies internet for the turn that installs, and the upfront item says so.
- **Scopes:** once (this build, `grant.recorded` with `scope: build`), always (this machine: `~/.rafi/grants.yaml`, keyed by the project's path, plus a `grant.recorded` for history), don't allow (tickets held).
- **`--allow internet,local-servers,…`** grants once for this build, for builder and QA, on `start` and `resume` (FLAG-ST-50, FLAG-RS-5). An unknown value exits 1 naming the valid ones (S-PERM-3).
- **Mapping onto each runtime** (each adapter's `capabilities()` says which grants it can enforce):
  - Codex: `thread/start`'s `sandbox` and `config.sandbox_workspace_write.network_access`, and each turn's `sandboxPolicy` (`adapters/codex.ts:610-617`, `:270-272`). Builder: `workspaceWrite` on its worktree, network on when internet is granted. QA: `readOnly`, network on when local servers or internet are granted (today's QA grant, `adapters/codex.ts:957`).
  - Claude: `sandbox.network.allowedDomains` and `sandbox.filesystem.allowWrite` (`adapters/claude.ts:90-103`); QA gets a private scratch `TMPDIR` for temp files (`adapters/claude.ts:118-121`).
  - **Unverified:** whether each runtime's sandbox can allow local servers (loopback) without full internet. MALF 3 saw EPERM in QA's sandbox. The M2 live adapter check and S-PERM-3 decide it. If a runtime can't separate them, its capability says so and the upfront item says "Local servers need internet access on Codex" rather than granting more than you chose, with the choices: Grant internet access (this build / always on this machine) / I'll run it myself, then resume / Skip for now.
- **`run_check` runs** under rafi's own sandbox with the same grants (6.9), not the runtime's.
- **No approvals mid-build.** Today's per-operation sandbox escalation (`--builder-approvals`, PRM-74) folds into the upfront check. A runtime's approval request (Codex `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`, `adapters/codex.ts:975-976`; Claude's `canUseTool`, `adapters/claude.ts:470`) is answered by the agent permission policy from the grants: allowed when its need was granted, otherwise denied with a message telling the agent to report `blocked(permission)`, so it explains the restriction instead of failing quietly (SCN-7).

## 8. How `rafi` calls the engine

### 8.1 `runCli(argv, deps)` (principle 9, OQ-2)

```ts
// packages/rafi/src/next/cli.ts
export async function runCli(argv: string[], deps: Deps): Promise<number>   // returns the exit code
```

- It builds a fresh Commander program on every call. Today the program is a module-level singleton (`rafi/src/index.ts:98`) and the module sets `process.env.RAFI_REHEARSAL_*` when it's imported (`rafi/src/index.ts:94-95`); the new layer has no global state, so the harness can call `runCli` many times in one process (SCN 7.2).
- It parses and validates arguments (a dropped or merged flag exits 1 naming what replaced it, S-CLI-2), finds the project, checks its format (9.2), opens the engine with `deps`, runs one command and returns its exit code. It never calls `process.exit`.
- `bin/rafi` (the launcher, `rafi/src/launcher.ts`) keeps today's Node and native-module check (`rafi/src/launcher.ts:9-14`, OUT-10), picks the engine (9.1), and for the new one sets `process.exitCode = await runCli(process.argv.slice(2), realDeps())`.
- Today's CLI-on-CLI paths go away: `rafi resume` spawning a child `rafi start` (`rafi/src/resumeLauncher.ts:27`), self-spawns for resumed interviews and create's ticket setup (`rafi/src/index.ts:891,943`), and the detached supervisor and its workers with hand-off variables (`ai-foreman/src/supervisedStart.ts:89,131`). A command that needs another command's work calls the engine action directly.

### 8.2 The seams (`deps`)

```ts
interface Deps {
  agents: {                                      // transports beneath the real adapters (11.6)
    codex(o: { cwd: string; executable: string; args: string[]; env: Env }): JsonRpcStream;  // real: spawn `codex app-server`
    claudeQuery: ClaudeQuery;                    // real: the Agent SDK's query()
  };
  clock: {
    now(): Date;
    timer(ms: number, fn: () => void, kind: "timeout" | "backoff" | "agent" | "reminder" | "heartbeat" | "poll"): Cancel;
    sleep(ms: number, kind: TimerKind, signal?: AbortSignal): Promise<void>;
  };
  notifier: Notifier;                            // send, update, close, onAnswer (10.4)
  terminal: Terminal;                            // input, output, error; isTTY; columns, rows; setTitle; onInterrupt; onResize
  fs: Fs;                                        // read, writeAtomic, append, rename, remove, mkdir, stat, list (async)
  git(args: string[], o: { cwd: string; env?: Env; input?: string }): Promise<ExecResult>;
  exec(cmd: string, args: string[], o: ExecOptions): Promise<ExecResult>;   // gh, glab, readiness, prerequisites, notifiers
  checks: { run(cmd: string, args: string[], o: { cwd: string; env: Env; sandbox: Grants; onOutput(chunk: string): void; signal: AbortSignal }): Promise<CheckResult> };   // test runs (6.9)
  serve(o: { host: "127.0.0.1"; handler: McpHandler }): Promise<{ url: string; close(): Promise<void> }>;   // rafi's local MCP endpoint (6.9)
  spawnBackground(argv: string[], o: { cwd: string; log: string }): { pid: number };   // --detach only (8.7)
  db: { open(path: string): Db };
  processes: { self(): Owner; isAlive(owner: Owner): Promise<boolean> };
  hooks: { crash(boundary: string): void; pause(boundary: string): void };   // no-ops in production
  machine: { stateDir: string; host: string; platform: NodeJS.Platform };   // stateDir defaults to ~/.rafi
  env: Readonly<Record<string, string | undefined>>;                        // a snapshot; the engine never reads process.env
  random: { id(): string; jitter(): number };
  logChanged(dbPath: string, onChange: () => void): Cancel;                 // another process wrote the log
}
```

| Seam | Real | Harness (SCN 7) |
|---|---|---|
| `agents.codex` | Spawns `codex app-server --listen stdio://` (today: `adapters/codex.ts:164,692`) | An in-memory JSON-RPC stream driven by the scenario script, beneath the real Codex adapter |
| `agents.claudeQuery` | The Agent SDK's `query`, which starts the absolute `claude` path that passed readiness (NEW-ADP-4) | An injected `query` driven by the script, beneath the real Claude adapter (as `ai-foreman/test/qaGuidanceDelivery.test.ts:90-101` already does) |
| `clock` | Real timers | Starts at 2026-11-01 14:00 UTC. It jumps to the next `timeout`, `backoff` or `agent` timer only when nothing else can run; it never jumps to a `reminder` on its own, so a waiting build stays put until a step calls `clock.advance` (SCN 7.4) |
| `notifier` | Platform backends (10.4) | Records each notification; can answer one; modes for buttons, none, `alerter` missing or broken (SCN 7.5) |
| `terminal` | `process.stdin`/`stdout`/`stderr`, SIGINT | A 120×24 screen model with title and pinned lines, or plain pipes (SCN 7.6) |
| `fs`, `git`, `exec`, `db` | Node and better-sqlite3 | Wrapped by the write fence: after a `HarnessCrash`, every write, git command and database write from that instance throws; storage faults are injected here (SCN 7.7) |
| `checks.run` | A sandboxed child process, output streamed | Scripted per test on the fake clock: pass, fail, hang, slow, flaky, writes, edits (F-TESTS) |
| `serve` | A local HTTP server on a random port | An in-memory endpoint the fake Codex calls |
| `processes` | pid + start time on this host (4.3.1) | A fenced instance is dead |
| `hooks` | No-ops | `crash.at(k)`, `pause.at(k)` (SCN 7.7) |
| `machine.stateDir` | `~/.rafi` | A temp directory per "computer" (S-PORT-1) |
| `logChanged` | Polls `PRAGMA data_version` every 250 ms (`poll` timer) | Called after every commit by any instance, so a waiting build sees `rafi answer` from a "second shell" without time passing |

The real implementations live in `engine/src/deps/real/`, so a future daemon reuses them; `realDeps()` in the CLI only wires them together.

### 8.3 The engine API

```ts
const engine = await openEngine({ projectDir, deps });
engine.start(options): Build                       // runs the loop in this process; Build has events() and done
engine.resume(options): Build | Attached           // takeover or attach (8.5)
engine.stop(run, { now }): StopNotice
engine.pause(run), engine.unpause(run)
engine.answer(question, answer, source): Applied | AlreadyAnswered      // 7.6
engine.defer(question)
engine.status(): StatusView                        // never writes (3.6)
engine.events({ from, run }): AsyncIterable<Event> // ordered, replayable by cursor (GUI-PLT-2)
engine.preview(action): { summary: string; cli: string }   // what an action will do, and its CLI form (GUI-R3)
engine.tickets.*, engine.plan.*, engine.tools.*, engine.stats.*, engine.manager.*, engine.reset(…), engine.migrate(…)
```

- Every action validates its input with the rafi-spec schemas the CLI uses, takes an optional idempotency key, and records who called it (GUI-PLT-3, GUI-R19).
- CLI commands are thin: parse, call one action, render the result. For example `rafi stop` calls `engine.stop` and prints its notice; `rafi answer 2 3` calls `engine.answer`; `rafi tickets complete` calls `engine.tickets.complete`.
- Manager host commands (`/qa-report`, `/qa-attempts`, `/qa-timeline`, `/qa-export`, `/more`, `/artifact`, `/pause`, `/guide-builder`, `/guide-qa`, `/guide-both`, `/withdraw`, `/supersede`, `/request-attempt`, `/answer-question`, `/report`) call `engine.manager.host` and need no model turn; they accept short references and full IDs (Q-CMD-4). `rafi manager --ask` runs a Manager turn whose context comes from the log.

### 8.4 The terminal

- `ui/screen.ts` keeps a scroll region for activity rows and pins open questions at the bottom, oldest first (OUT-16). It sets the terminal title with OSC 0/2 and keeps a status line ("T3 building · T2 waiting on you since 14:05"). On a pipe it prints plain lines with no ANSI codes (OUT-9).
- The owning process renders engine events as they happen; an attached `rafi resume` renders the same events by tailing the log. One renderer serves both.
- Prompts use `@clack/prompts` through `deps.terminal`: the installed 1.5.0 accepts `input`, `output` and `signal` (`node_modules/@clack/prompts/dist/index.d.mts:37-39`). The `signal` closes a prompt when its question is answered elsewhere.
- **Plain-English lines** (principle 7). `ui/lines.ts` builds every stop and block message from typed data: what happened, why, what waits, what rafi is doing now, and the exact command to continue. Nothing prints raw JSON.
- **Activity** (OUT-8, SCN-14). Failed exploratory reads (Claude `Read`, `Glob`, `Grep`, `LS` not finding a path) fold into one quiet line per turn; a real failure still shows. Errors, timeouts, cancellations and unknown outcomes have distinct labels; duplicate result events show once; `TIME_ELAPSED` shows as an unknown duration.
- **Cost and compaction** (OUT-12, OUT-13). Session cost is labelled measured or estimated. The compaction notice shows the requested threshold and the setting rafi verified with the provider as separate values, and says compaction happened only when the provider reported it.
- **End-of-build summary** (OUT-18, NEW-MEAS-3): tickets done and left, cost and time, how long rafi waited on you, plan changes, skipped questions still open, person-only checks still unconfirmed under setting C with the tickets built on them, and from the CI points: tests still failing, already broken or flaky, and `unfixed` fix tickets.

### 8.5 Attach, resume, stop, Ctrl+C and pause

- **`rafi resume` with a live owner** attaches: it shows live progress and the open questions, can answer them, and doesn't start a second build (S-CRASH-4 step 1). On a paused build it asks "Continue the paused build?" (auto-approve continues) and writes `build.unpause_requested`.
- **`rafi resume` with no live owner** takes over: it claims the lease (atomically, only if the old owner is dead), writes `build.owner_lost` if the old owner never released, then `build.resumed`, asks only unanswered and new upfront questions, and continues the loop, which redoes the interrupted step (4.5). It never asks for a recovery mode (S-CRASH-1).
- **Picking.** With no `--run`, `rafi resume` lists unfinished builds and saved interviews, newest first, and asks only which one (PRM-90, PRM-92); with auto-approve and no terminal it takes the most recent (FLAG-RS-12). `--run <prefix>`, `--ticket <id>` and one-off `--agent`/`--model` are kept (FLAG-RS-2, -4, -11); `--id`/`--discard` resume or discard an interview (FLAG-RS-3). Planning sessions that `rafi plan:doctor` found today are in the same list (CMD-5).
- **`rafi stop`**, from any shell, writes `build.stop_requested` (graceful) and prints "Stopping after the current step. Run `rafi stop` again or press Ctrl+C to stop now." A second one writes `now` (Q-CMD-6). The owner sees it through `deps.logChanged`. When no process owns the build (a foreground run that exited with code 2), `rafi stop` writes `build.stopped` itself.
- **Ctrl+C** in the build's terminal writes `build.stop_requested` (now, `ctrl-c`): rafi cancels the current turn, waits for the provider to take the cancel and exit (OUT-14), records `turn.cancelled` with the evidence so far, writes `build.stopped` and exits 130. A second Ctrl+C exits at once and ends the provider processes.
- **Pause** is a Manager control for now (Q-CMD-6): `/pause <run> <ticket>` writes `build.pause_requested`; the build shows "Pausing…" and holds at the next safe point (GUI-R5).
- **One live build per checkout.** `rafi start` while a build is live offers to attach instead; `rafi reset` refuses (FLAG-RE-3).

### 8.6 Settings in layers, `--set`, locked settings (FLAG-ST-R1, GUI-R20, GUI-R21)

- Layers, lowest first: built-in defaults (rafi-spec), the org policy file (`~/.rafi/policy.yaml`, whose `locked:` keys can't be overridden), the project's `rafi-config.yaml`, then this build's flags and `--set`. Each effective value carries its source; `build.started` records them all, and `rafi doctor` prints them with their sources (S-CLI-19, S-START-4).
- `--set key=value` takes any `rafi-config.yaml` key by dot path, for this build only; the config file is unchanged. An unknown key exits 1 naming it; a locked key is refused with the reason (Q-FLAG-1, S-CLI-3).
- The 12 config-only start flags (FLAG-ST-35–46) are keys under `tickets.build` and `agent_defaults.roles`; passed as flags they exit 1 naming the key (S-CLI-2). The ENV-4 tuning variables become keys and the old variables are ignored (Q-CFG-1). `foreman.yaml` is folded into `rafi-config.yaml` by `rafi migrate`; a 1.0 project has none (Q-CFG-4).

### 8.7 `--detach` (D5)

1. In a terminal, the parent runs the upfront check first, so you answer now.
2. It writes `build.started` and the run's grants and answers, then calls `deps.spawnBackground` with the ordinary command `rafi resume --run <id>`, in a new session so closing the terminal doesn't stop it, with stdin closed and output to `.rafi/background.log` (ignored by git).
3. It waits up to 15 seconds for the child's `build.owner_acquired` to appear in the log, prints "rafi: build r7 started in the background. Follow it with `rafi status` or `rafi resume`." and returns 0 (Q-OUT-1). If the child exits first, it prints the child's first error line and returns 1.

No hidden flags, no hand-off variables (ENV-5), no IPC: "Allow once" grants belong to the run the parent created, so the child sees them. The child is an ordinary build without a terminal: its questions become open questions with notifications (7.5), it keeps waiting instead of exiting (decision 8), and `rafi status` and `rafi resume` follow it by reading the log (S-START-5 step 4, S-NOT-1 step 3).

### 8.8 Exit codes (OUT-40–42, Q-OUT-1)

| Code | When |
|---|---|
| 0 | Success; a cancelled prompt; "stop and deny" in the auto-approve warning; `rafi stop` (the request); `--detach` after launch |
| 1 | Errors, including unknown commands, options and setting keys |
| 2 | A foreground build without a terminal left waiting on you, with nothing else to build (a background build keeps waiting) |
| 130 | A build stopped with Ctrl+C (the code today's resume launcher gives a child ended by SIGINT, `rafi/src/resumeLauncher.ts:50`) |

A foreground build in a terminal never exits while it waits (NEW-BLK-5).

### 8.9 `rafi reset` (Q-CMD-3, FLAG-RE-1..3)

- `rafi reset` asks: this build, everything, or the plan? Each choice previews what it will do, with its CLI form, before doing it (GUI-R7).
- **This build:** restart-current (keep the branch and redo the build's unfinished tickets from your current files) or archive-restart (move the unfinished work to an archive branch and restart from the base), then the working-tree cleanup: stash, discard, or handled (you've dealt with it). Untracked folders are left alone (S-SCN-2).
- **Everything:** tickets go back to their post-population state and the plan approval is carried forward (FLAG-RE-2).
- **The plan:** a chosen revision becomes current again and tickets are repopulated from it (`plan.reset`; GUI-INS-8).
- The event log is kept in every case: reset appends events, and the old run stays in `rafi stats` (Q-CMD-3 c). Afterwards every role starts a new session; no session pointer survives, because none is stored (SCN-12).
- Never force-pushes or closes or deletes remote state; refuses while a build has a live owner (FLAG-RE-3). `rafi tickets reset` stays the tracker-only reset (Q-CMD-3 e).

### 8.10 `rafi status` (OUT-1, NEW-ASK-6, GUI-R11)

A read-only view of the fold and the lease (it never writes, 3.6). It shows:

- the build: its run, its state as shown in 4.3 (running; waiting on you since 14:05; paused; stopping; stopped, cancelled or crashed; not responding; finished, with any work left), its scope and its progress ("3 of 5 done");
- one plain line per blocked ticket: what's blocked, why, and what waits on it; then the open questions with their numbers (S-CLI-15);
- the current agent turn's liveness (GUI-R11): working (activity in the last 2 minutes); active but quiet (no activity for 2 minutes or more, provider alive); waiting on the provider (a retry or a usage-limit wait, with the attempt number and when the next try starts, S-TIME-1); waiting on you; stalled (no provider message for half the idle timeout);
- for a stopped or crashed build, the last step that finished, the step `rafi resume` will redo, and the exact command (S-CRASH-4 step 5);
- the exact command to continue, using only 1.0 command names. Never JSON.

## 9. The engine switch and `rafi migrate`

### 9.1 Side by side (NEW-ENG-10, RW "Process" steps 5 and 9)

- The launcher reads `RAFI_ENGINE` once. Until the switch: `next` runs the new CLI layer and engine; anything else runs today's 0.10.x layer, unchanged. At the switch the old engine is deleted and `RAFI_ENGINE` goes away; no backup engine ships (decision 1). Anyone who needs the old one installs the previous version (`npm install -g @rafi-ai/cli@0.10.2`).
- The old engine stays the default the whole time the rewrite is built (guide step 10). Builds already in progress finish on 0.10.x and are never migrated (RW "Process" step 7).

### 9.2 Which engine reads which project

- **The 1.0 marker** is a new top-level key in `rafi-config.yaml`: `format_version: 1`. `rafi create` (new engine) and `rafi migrate` write it.
- **The old engine refuses a 1.0 project** (D6). Today's config schema rejects unknown keys (`additionalProperties: false`, `spec/src/schemas.ts:414-418`), so the old engine would fail with a schema error instead of the decided message. The check therefore runs in the launcher before the old layer loads: if the project (the command's project argument or `-p`, else the nearest `rafi-config.yaml` from the current folder) has `format_version: 1`, it prints "This project uses 1.0 formats; set RAFI_ENGINE=next." and exits 1, writing nothing (S-ENG-5 step 2). The old engine's own code isn't touched.
- **The new engine refuses a 0.10.x project** (no `format_version: 1` marker; the marker alone decides): one line, "This project uses 0.10.x formats. Run `rafi migrate` first.", exit 1, nothing written (S-MIG-2 step 1). If the 0.10.x project also has an unfinished build, the line names the run and gives the 0.10.x commands, run without `RAFI_ENGINE`, to finish it (`rafi resume`) or drop it (`rafi build:reset`) (S-ENG-5 step 4, OQ-1). `rafi migrate`, `--help`, `--version` and `doctor` work on either.
- **Pre-0.10 forms** (`project.yaml`, the `qa_preparation: { mode }` object) aren't supported: `rafi migrate` names them as unsupported and changes nothing (Q-CFG-2, S-MIG-2 step 2).

### 9.3 `rafi migrate` (CMD-37, Q-CFG-2)

- **Refuses** while any 0.10.x build is unfinished, read from `.rafi/recovery.sqlite3`, naming the run and the 0.10.x commands to finish or drop it (OQ-1, S-MIG-2 step 3).
- **Previews** every file it will rewrite and where the backup goes, then asks (with `--yes`, doesn't ask). The backup is `.rafi/migrate-backup/<time>/`, byte-for-byte copies (S-MIG-1 step 4).
- **Converts**, keeping every setting you set and changing only defaults:

| From (0.10.x) | To (1.0) |
|---|---|
| `tickets.build.pr_ready: true`, `delivery_units[].pr_ready` (config, `.tickets/delivery.yaml`, every plan revision) | `completion: pr-ready` (Q-CFG-1) |
| The `autonomy` block: `profile` and `rules` (`recoveryPolicy.ts:20-44`) | `retries` with the same effective limits: the QA fix allowance (`qa.nonconvergence`, or the profile's) becomes `fixes`, `turn` becomes the larger of the transient retries (`runtime.transient`, or the profile's) and the format corrections (`protocolCorrections`), so a `supervised` project (0 transient retries) still retries a malformed reply, and the preview shows it; `supervisor` and `continue_independent_tickets` (now always on, RW:208) are dropped (Q-CFG-3) |
| `foreman.yaml`: `permissions`, `notifications`, `qa.enabled`, `observability` | `agent_permissions`, `notifications`, `harness.qa`, `logs.capture`; rafi says where each went (Q-CFG-4) |
| `qa_preparation`, `qa_preparation_shadow`, `qa_preparation_wall_time_ms` | Removed: the requirements file is always written (Q-REQ-1) |
| `agent_defaults` session strategies equal to 0.10.x's default (`compact` for builder, QA, ticket-maker) | Shown in the preview as moving to the 1.0 default, `fresh`, with an option to keep `compact` (FMT-C7, Q-CFG-5) |
| Ticket status, block reasons and validation in `.tickets/ticket-state.sqlite` | `.rafi/progress.yaml`, and `progress.imported` events in a new `.rafi/state.sqlite3` (FMT-S2) |
| The approved plan and scope | A carried-forward `plan.approved` and `scope.approved`, so an unchanged scope starts without asking (NEW-KEEP-1) |
| Answered durable decisions in `.rafi/recovery.sqlite3` whose ticket still exists | Saved answers with 1.0 keys (7.6); any it can't map are listed as dropped in the preview |
| `.tickets/tracker-rules.md` | Regenerated with a version (NEW-INS-7) |
| Plan revisions (`<docs>/rafi-plans/*`) | Converted in place, once, so the engine reads only 1.0 formats; the originals are in the backup. This is the only time rafi rewrites a revision (FILE-21) |

- **Crash-safe and re-runnable.** It writes the backup first, then each converted file atomically, and writes `format_version: 1` into `rafi-config.yaml` last. A crash before that last write leaves a project the new engine still calls 0.10.x; running `rafi migrate` again redoes the conversion from the backup's originals. A second run on a migrated project reports nothing to change and exits 0 (S-MIG-1 step 2).
- **Retires** `.tickets/ticket-state.sqlite` and `foreman.yaml` into the backup once converted.
- **Leaves alone** 0.10.x's other local files (`.rafi/recovery.sqlite3`, `.foreman/runs`, the recovery folders): they're ignored by git and no longer read; the preview says so, and `rafi uninstall` can remove them.

### 9.4 The switch and the deletion

Guide step 11: `rafi migrate` moneyTree (keep a copy), build T002 onward with `RAFI_ENGINE=next`, turn every failure into a scenario; after several clean builds release `@rafi-ai/cli` 1.0 with the engine as `ai-foreman` 3.0, deleting the old layer and `packages/ai-foreman` in the same release (section 12, decision 1).

## 10. Tags, instruction assembly, tools and notifications

### 10.1 Tags (RW "Agent context: tags", NEW-TAG-1..7)

- **The tag list** is rafi's fixed list, in `special-agents/content/tags.yaml` (name, description, default file patterns), plus project tags under `tags:` in `rafi-config.yaml`, each with optional file patterns (FMT-C13). The starting fixed list: `ui`, `backend`, `api`, `database`, `ai`, `mobile`, `push`, `auth`, `security`, `infra`, `docs`, `testing`. Default patterns, for example `ui: ["**/*.tsx", "**/*.jsx", "**/*.css", "**/*.vue"]`.
- **Validated at planning time.** `tickets populate` and `tickets plan` reject an unknown tag, naming it and the allowed list; `rafi tickets validate` exits 1 on a hand-edited unknown tag (S-TAG-2).
- **Where a ticket's tags come from.** Tags are only added, never removed, and each addition is recorded and shown with its reason (`ticket.tags_added`, OUT-19):

| Source | When | Reason shown |
|---|---|---|
| The Planner or Ticket Maker | Writing the ticket | "set by the Planner" |
| QA preparation's `add_tags` (6.3) | The prepare step | "added by QA preparation" |
| A file pattern on the ticket's `likely_files` | Before the builder starts, with no AI call | "src/App.tsx matches **/*.tsx" |
| A file pattern on the builder's changed files | Before QA reviews | "builder changed src/Panel.tsx (matches **/*.tsx)" (S-TAG-4) |
| You | Editing `tickets.yaml` | "set by you" |

- **What tags pick.** Every rule pack, skill and tool entry carries `tags:` (`always` for the small core). Today packs switch on for the whole project from `condition: always | cloud | frontend | ai` (`special-agents/content/rules/packs.index.yaml`) and the role manifests' `conditionalPacks` keyed by `ai` and `frontend` (`special-agents/content/agents/builder.yaml`), so every ticket gets the AI and accessibility packs (AIR item 2). In 1.0 a pack reaches a ticket's agents only when one of its tags matches. `flags.*` stay as keys (FMT-C3) and still drive `create`'s offers and the stack template; they no longer switch packs on.
- **QA gets the builder's tags**, plus any added from the builder's changed files (NEW-TAG-3).
- **A reused agent** (the override) gets the union of the tags of every ticket in its scope, recorded on its session, not as `ticket.tags_added` on each ticket (NEW-TAG-6).
- Tags rafi adds aren't plan updates (7.10).

### 10.2 Instruction assembly per ticket (principle 13, NEW-INS-1..9)

**Standing instructions**, sent once per session (and a session is fresh per ticket by default, NEW-TAG-5):

1. The role's small core, from `.rafi/compiled/<role>/system.md` (FILE-7).
2. The rule packs whose tags match the ticket's tags.
3. Skills, by name and description only; the agent opens one when it needs it (NEW-INS-3). Claude gets them through the SDK's `skills` option (today `adapters/claude.ts:112-114`); Codex gets names, descriptions and file paths; today the Codex adapter prepends the role text and the full skill text to every turn (`adapters/codex.ts:155-159,1030`, called for each turn at `:237`), so the same rules go out again on every turn (NEW-INS-2).
4. The ticket's tools: "Tools for this ticket: playwright, for checking web UI. Setup notes: docs/tools/playwright.md" (NEW-TOOL-7).
5. The runtime contract: network on or off, what's writable, and "if something you need is missing, report `blocked`; don't swap in a different stack or tool" (NEW-MAL-5, SCN-7).
6. The reply format (section 6).

**The setup script** (NEW-SET-1, Q-SET-1). Rafi runs `scripts/rafi-setup.sh` itself through `deps.checks.run`, once per build before the first agent turn and again after a builder turn changes it; agents don't run it. Services it starts run detached with their process ID and port recorded; rafi stops them at the end of the build, and a takeover after a crash stops the dead owner's.

Runtimes load root files themselves: Claude loads `CLAUDE.md` when `settingSources` includes `project` (the builder's sessions do, `adapters/claude.ts:88`), and Codex loads `AGENTS.md`. `rafi compile` writes only the small core into those files (FMT-O2), and rafi doesn't append the core again where the runtime already loads it; QA's Claude sessions load only user settings, so rafi gives QA the core itself. Each pack reaches a session once (NEW-INS-2, S-CTX-1).

**Per-turn messages** carry only what's new:

| Turn | Carries |
|---|---|
| Prepare (QA) | The ticket: title, summary, numbered acceptance criteria and their person-only and locked marks; the depth |
| Build | The ticket and its numbered criteria; the requirements file's path, never its text (NEW-REQ-2); a one-line status of each dependency, never the queue (NEW-INS-4); answers you gave for this ticket and any note from "Give the builder instructions"; that rafi ran `scripts/rafi-setup.sh` and its run number (NEW-SET-1); on a redo, that an earlier attempt may have left changes |
| Review (QA) | The requirements file's path and fingerprint, and a warning if it changed or is missing (NEW-REQ-5); the changed files from rafi's snapshot; rafi's recorded runs (number, command, outcome, exit code or "no exit code", duration); on a re-review, only what changed since: files, new runs, prior findings (NEW-REQ-7) |
| Fix | What failed: QA's not-satisfied requirements with its notes and run numbers, or the failing check runs with their failing tests, errors and output excerpts (6.9); "Keep the work you've done; don't start over" |
| Any of the above | Guidance you queued through Manager (`/guide-builder`, `/guide-qa`, `/guide-both`), delivered at the next turn of that role (FLAG-MG-5) |
| Repair | The parser's error and the byte (5.3) |

No agent gets `docs/ticket-progress.md` or the queue. Wording follows principle 13: check facts and say "unable to verify" when you couldn't; "report needs-input" instead of "ask the user"; no pressure words; QA keeps "Do not rubber-stamp your own work. Be skeptical." and loses the triple-check lines (`ai-foreman/src/foreman.ts:146,153`, `ai-foreman/src/qaReview.ts:1023`; NEW-MAL-8); no command that doesn't exist (S-CTX-1 runs every `rafi …` command named in any instruction with `--help`). Instruction characters per turn are recorded (`turn.intent`, NEW-MEAS-4). Rafi-owned files (compiled agent files, `.tickets/tracker-rules.md`) carry a version line and are regenerated on upgrade and by `rafi compile` (NEW-INS-7).

### 10.3 Tools (RW "Test tools", NEW-TOOL-1..11)

A tool is an MCP server or a command, saved under `tools:` in `rafi-config.yaml`, so it travels with the project (FMT-C12):

```yaml
tools:
  playwright:
    kind: mcp
    start: { command: npx, args: ["@playwright/mcp@<version>", "--isolated", "--headless"] }
    description: Drive a browser to check web UI
    roles: [qa, builder]
    tags: [ui]
    permissions: [local-servers]
    stop: end-process
    evidence: { screenshots: per-requirement, video: on-failure, trace: on-failure }
    versions: "<the range rafi tested>"
    license: Apache-2.0              # confirmed by the setup check on your machine
    setup_notes: docs/tools/playwright.md
```

- **Built in:** Playwright. **Fully supported:** mobile-mcp. `rafi create` offers Playwright for a frontend and mobile-mcp for a mobile app (PRM-22). `rafi tools add <name>` knows `playwright`, `mobile-mcp`, `appium`, `maestro`, `ios-sim-push`, `apns-push` and `fcm-push` (NEW-TOOL-10, S-TOOL-5).
- **`rafi tools add`** writes the entry, runs the tool's prerequisite checks through `deps.exec` (for example Xcode command line tools, Android platform tools, Node 20+, Java 17+), explains anything missing, writes the boilerplate (a starter Playwright config using the per-build port; `payload.apns` with a simulator send script; APNs sandbox and FCM send scripts that read keys from the environment, never from committed files; device-check steps in the setup notes, NEW-TOOL-4), records `tool.added`, and re-tags the remaining tickets (NEW-TOOL-7).
- **In sessions.** MCP tools go into each session's configuration: Claude's `mcpServers` query option, and for Codex the session's MCP configuration. **Unverified:** whether app-server accepts MCP servers per thread rather than only from Codex's own config; M2 checks it first, because `run_check` needs it (6.9, decision 7), and the fallback is a `-c mcp_servers.<name>.url=…` override when the app-server starts, as today's `-c` overrides do (`adapters/codex.ts:164-169`). The Playwright MCP server starts with `--isolated` for each agent, so no profile is shared (NEW-TOOL-8).
- **Telling agents.** A QA retry after "unable to verify" names the tool and the requirement: "You now have `playwright` (browser). Use it to verify R3: the file appears in the panel." Later tickets get the tool through their tags (NEW-TOOL-7, S-TOOL-1, S-TOOL-2).
- **Parallel builds.** Each build gets its own app port from a machine-wide registry (`~/.rafi/locks/ports/`), given to agents as `RAFI_APP_PORT` and used by the starter Playwright config (S-TOOL-3). A physical phone is locked to one build at a time (`~/.rafi/locks/devices/<serial>`, owned by the build's lease, freed when its ticket finishes or its owner is gone; S-TOOL-4). "Show the browser" is a per-build setting, `--set tools.playwright.show_browser=true`, which starts that build's Playwright headed.
- **Recordings** (NEW-TOOL-5, FMT-C20): one screenshot per checked requirement; for a failed check also a video and a Playwright trace (`retain-on-failure`). `recordings.save: failures | all`; `recordings.keep` is `ticket`, `build`, `{ builds: N }` (default 5), `{ days: N }` or `forever`. Files go to `.rafi/recordings/<run>/<ticket>/R<n>-<kind>.<ext>` (or under the project logs) and are listed as `recording.saved`; retention removes the files and records `recording.removed`, so they stay listed (S-TOOL-6). Recordings are the one exception to "never deleted automatically" (Q-STATS-2).
- **Tool output is untrusted data.** It reaches agents only as quoted content, never as instructions, and nothing in it can change rafi's records (S-TOOL-5 step 3, S-ENG-7).

### 10.4 Notifications (RW "Notifications", NEW-NOT-1..7)

- **Owned by the engine** (NEW-NOT-2). `notify/notifier.ts` follows the engine's own events: `question.opened` sends; `question.answered` and `question.closed` update the notification to "answered in …" or close it; `ticket.blocked` and `build.finished` send as your preferences say. The same code serves a foreground build, a detached one and, later, the daemon.
- **Defaults** (Q-NOT-1, FMT-C17): on; notify on questions, blocks and build end; remind about open questions after 30 minutes, then hourly, and stop once answered (S-NOT-4); the terminal bell stays on (PRM-G7); preferences per event under `notifications:` in the config. Quiet hours come with the GUI.
- **Platforms** (NEW-NOT-3, NEW-NOT-4): on macOS, `alerter` when it's installed (buttons, or a dropdown for several choices; it prints the chosen action, so rafi runs one `alerter` child per notification, reads its output, and ends the child to close it), offered in `rafi create` and reported by `rafi doctor` (Q-NOT-2); a plain `osascript` notification when `alerter` is missing or fails (today's only macOS path, `ai-foreman/src/notify.ts:35-40`). On Linux, `notify-send --action` (libnotify 0.8+), which prints the chosen action, else plain `notify-send`. On WSL, today's PowerShell toast without buttons (`notify.ts:41-46`). Native Windows waits for the GUI. **Unverified:** `alerter`'s current flags and output; `rafi doctor` and the M7 process-set shim check them.
- **Choices.** At most three, the recommended one first, then NEW-BLK-3's order, plus "More…", which opens the terminal view or `rafi answer` for that question. Without buttons, the notification says what's needed and the command to answer (NEW-NOT-5, S-NOT-3).
- **Answers** from a notification call `engine.answer` with `source: notification`; the first answer wins (7.6).
- The harness's fake notifier records and answers (SCN 7.5, NEW-NOT-7).

## 11. Native Codex and Claude modes (H01–H02), and the fake `claude` executable (D9)

### 11.1 Today's adapters already run on the native modes

| Feature | Codex today | Claude today |
|---|---|---|
| Transport | `codex app-server --listen stdio://`, JSON-RPC (`adapters/codex.ts:164,692`) | The Agent SDK's `query()` in streaming-input mode (`adapters/claude.ts:238-242,437`), starting the absolute system `claude` (`pathToClaudeCodeExecutable`, `:76`; resolved at `:363`) |
| Structured output | `outputSchema` on `turn/start` (`codex.ts:262`) | `outputFormat: { type: "json_schema" }` (`claude.ts:443`); `structured_output` on the result (`claude.ts:776`) |
| Sessions | `thread/start` or `thread/resume` (`codex.ts:610`) | `resume` (`claude.ts:79,442`) |
| Event stream | `item/started`, `item/completed`, `item/agentMessage/delta`, `thread/tokenUsage/updated` (`codex.ts:737-816`) | SDK messages: `system` (status, `api_retry`, tasks), `assistant` tool calls, `user` tool results, `result` (`claude.ts:618-776,889-901`) |
| Approvals | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` (`codex.ts:975-976`) | `canUseTool` and a `PreToolUse` hook (`claude.ts:445-485`) |
| Cancel | `turn/interrupt` (`codex.ts:904`) | The abort controller (`claude.ts:444`) |
| Compaction | `model_auto_compact_token_limit` (`codex.ts:164-169`), `thread/compact/start` (`codex.ts:417-418`) | The `PreCompact` hook (`claude.ts:459`) and the CLI's own auto-compaction |
| Sandbox and network | Per-turn `sandboxPolicy` (`codex.ts:270-272`) | `sandbox` options (`claude.ts:90-103`) |

So the native modes are already the transport. The adapters are 3,297 lines because of what rafi layers on top: sealed dispatch tuples and capabilities (`adapters/types.ts:345-375`, `structuredDispatchAuthority.ts`), receipt identity checks (`adapters/structured.ts:6-32`), phase barriers and contract enforcement (`types.ts:273-278`, `claude.ts:302-306`), session identity probes (`claude.ts:123-236`, `sessionIdentity.ts`), continuity validation, an interactive recovery wrapper (`adapters/recovering.ts`) and live-canary spend budgets (`claude.ts:420-436`).

### 11.2 What native features replace

| Today's rafi machinery | Replaced by | In 1.0 |
|---|---|---|
| Format retries for Claude | The SDK validates `structured_output` against the schema and re-prompts inside the turn (its `StructuredOutput` tool gets an error result and is called again); when it gives up the result is `error_max_structured_output_retries` (SDK docs, `sdk.d.ts:3459`) | Rafi's repair try is needed on Claude only for `success` with no `structured_output` (a `format` error); `error_max_structured_output_retries` is a `content` error (5.1). Rafi still checks its own rules: reference numbers, `not-applicable` |
| Session identity and continuity proofs (`sessionIdentity.ts`, `sessionAvailability.ts`, `continuity.ts`, `continuityOrigin.ts`, `handoffs.ts`) | Native sessions plus a fresh session per ticket | 1.0 never resumes a session across rafi processes. The same session is used only for the repair turn, a ticket's own fix and review rounds, and the reuse override, all inside one process. Native resume is used only by `rafi plan --resume-session` (FLAG-PL-5). A session that's gone just means a fresh one |
| Observability spans (`observability.ts`, 916 lines) | The native event streams | Mapped straight into `turn.activity`, `turn.tool` and `turn.reply` |
| Compaction lifecycle (`sessionLifecycle.ts`, 805 lines; the adapters' compaction code) | Native auto-compaction | Needed only for the reuse override: the adapter sets the threshold and reports a compaction when the provider reports one (Q-ADP-1 is checked live in M2; Q-ADP-2: compact only above the threshold). Codex occupancy is read from the latest usage sample, not the session total, as today (`codex.ts:804-816`, NEW-ADP-2) |
| The interactive recovery wrapper (`adapters/recovering.ts`) | The engine's classification (5.2) and PRM-79's question | Adapters never retry, prompt or decide |
| Exit codes | Codex's `commandExecution` items carry `exitCode` (`codex.ts:765`) | Recorded as rafi's run record. Claude's tool results carry only `is_error` (`claude.ts:889-901`), so its runs record `exit_code: null` and an outcome (NEW-CAP-1, NEW-REF-2) |

### 11.3 What they don't replace

- **Rafi's own validation.** Codex doesn't enforce `outputSchema` (MALF "The format isn't actually enforced", NEW-ADP-5), and the schema can't check rafi's rules (references, scope, `not-applicable`).
- **The agent permission policy**, which protects files a ticket may not touch and refuses agents that try to answer your questions (kept, NEW-CAU-4).
- **The loop, the questions and the log**, and **QA as an independent session** whose per-requirement verdicts rafi records: the builder can't approve its own work (harness plan constraint 11).
- **Claude's dynamic workflows** (H02: native orchestration of subagents for isolated review or fan-out) aren't used in 1.0. Bigger chunks, less frequent review and parallel tickets are after 1.0 (F02, F03, F06).

### 11.4 Codex: app-server, or `codex exec --json` and the Codex SDK (H01)

Checked in OpenAI's docs on 2026-11-01:

- **app-server** is "the interface Codex uses to power rich clients (for example, the Codex VS Code extension)": JSON-RPC over stdio; threads; turns with per-turn `outputSchema`, `sandboxPolicy` and `approvalPolicy`; `turn/interrupt`; approval requests sent back to the client; `thread/tokenUsage/updated`; `thread/compact/start`. The same page says "The app-server command and WebSocket transport are experimental and aren't supported for production workloads", and some methods need `capabilities.experimentalApi`. OpenAI's Python SDK drives app-server.
- **`codex exec --json`** prints JSONL events (`thread.started`, `turn.started`, `turn.completed` with usage, `turn.failed`, `item.*`, `error`) and supports `--output-schema`, `codex exec resume <id>` and `--sandbox`. The page describes no channel for approval requests back to the caller, no way to interrupt a turn other than ending the process, and no compaction control. The TypeScript SDK "spawns the CLI and exchanges JSONL events over stdin/stdout", with `startThread`, `resumeThread`, `run`/`runStreamed` and `outputSchema`.
- Neither page says the schema is enforced, and the malformed-reply doc saw a missing required field come back.

**For 1.0, keep app-server** (H01: "Retaining app-server is valid"). It's the only Codex surface with everything H01's conformance list asks for: identity, cancellation, approval, uncertainty, context, resume and usage. Against the "experimental" label: use only the stable surface (never set `experimentalApi`); keep the protocol behind `agents/codex/transport.ts`, so `codex exec --json` could replace it with approvals answered by the upfront grants alone; and have `rafi doctor` and the live suite check the Codex version against the range the adapter was tested with. This is decision 2.

### 11.5 Claude: the Agent SDK (H02)

- Checked in the installed SDK (0.3.159) and its docs on 2026-11-01: the SDK runs the Claude Code binary; `pathToClaudeCodeExecutable` picks which (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1623`); `spawnClaudeCodeProcess` lets the caller start it (`sdk.d.ts:1945`); `outputFormat` is validated and re-prompted (docs: "the SDK validates the output against it, re-prompting on mismatch"; it validates with JSON Schema draft-07); sessions can be resumed and forked (`sdk.d.ts:1429`); hooks; `canUseTool`.
- **Keep the SDK adapter**, using the system `claude` that passed readiness and your user, project and local settings, so enterprise logins and proxies keep working (NEW-ADP-4).
- **Authentication** (H02's acceptance; decision 4, decided). Rafi runs your installed, unmodified `claude` with your own login and never asks for, stores or passes along credentials (`adapters/claude.ts:76,365`). Anthropic's legal and compliance page (checked 2026-11-02) bans products that offer their own Claude.ai login or route requests through users' plan credentials, and says the rules do not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription." Rafi fits that case; nothing to change.

### 11.6 The new adapter interface

```ts
interface Agent {                                  // one session
  readonly runtime: "codex" | "claude";
  capabilities(): Capabilities;                    // structured replies, exit codes, resume, images, enforceable grants, compaction
  turn(request: TurnRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;   // ends with exactly one terminal event
  close(): Promise<void>;
}
interface TurnRequest {
  meta: { key: string; role: Role; ticket?: string; step?: Step; attempt?: number };   // identity; never sent to the provider
  instructions?: string;                           // standing instructions, first turn of a session only
  message: string;                                 // the per-turn message
  schema: ReplySchema;                             // the adapter sends the draft-07 or the Codex-strict form
  grants: Grant[];                                 // mapped to sandbox and network settings (7.11)
  tools: ToolEntry[];                              // MCP servers and command tools for this ticket (10.3)
  repair?: true;                                   // every tool request is refused
}
type AgentEvent =
  | { kind: "activity"; text: string }
  | { kind: "tool"; run: ToolRun }                 // exit_code is null when the runtime gives none
  | { kind: "usage"; input: number; output: number; cost?: number; measured: boolean }
  | { kind: "permission"; request: PermissionRequest; decide(d: Decision): void }   // goes to the agent permission policy
  | { kind: "question"; text: string; choices: string[] }   // AskUserQuestion: answered at once with "reply needs-input" (5.1)
  // terminal events:
  | { kind: "reply"; text: string; structured?: unknown }
  | { kind: "error"; code: "transient" | "quota" | "auth" | "configuration" | "session-gone" | "unknown"; resetAt?: string; message: string }
  | { kind: "exit"; code: number | null } | { kind: "idle-timeout" } | { kind: "cancelled"; confirmed: boolean }
```

- Adapters map and report; they never retry, prompt or decide.
- Before a build, rafi checks each role's model against what the role needs (structured replies, for example) using `capabilities()`, and flags a model that can't meet them in the upfront list instead of failing mid-build (GUI-R22, S-ENG-4). A missing feature uses its known fallback (NEW-CAP-1).
- `meta` travels next to each wire message through the transport seam: the real transport drops it before writing to the provider; the in-process fake reads it. That's how the fake matches a turn by role, ticket, step and attempt without parsing prompt text (SCN 7.3).
- Transports come from `deps.agents` (8.2). There's no `Reflect.construct` or method patching, as today's tests need (`ai-foreman/test/qaGuidanceDelivery.test.ts:101,104-107`).

### 11.7 D9: the fake `claude` executable, checked first in M1

**Evidence it can work** (not yet verified by running it). The installed SDK starts the executable with `--output-format stream-json --verbose --input-format stream-json` and talks JSON lines on stdio: it sends an `initialize` control request and waits for the response; the CLI side sends `can_use_tool` and `hook_callback` control requests that the SDK answers (strings found in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, 0.3.159). A search of `sdk.mjs` found no checksum or version check on a caller-supplied executable; the checksums in the SDK's `manifest.json` describe its own bundled binary. Rafi passes the readiness-checked path (`adapters/claude.ts:76`) found on `PATH` (`:363`), so a fake first on `PATH` is used like the real one.

**The check, M1's first task, time-boxed to half a day:**

1. Write `packages/scenarios/fakes/claude-cli.mjs`: answer `initialize`; on each user message emit `system/init` with a session id, a `hook_callback` for `SessionStart` when one is registered, and a `can_use_tool` request for one scripted Bash call; then an `assistant` message calling `StructuredOutput` with the scripted object, its `tool_result`, and a `result` with `structured_output`, usage and cost; honor `--resume <id>`; answer `--version`; exit when stdin closes.
2. Drive it with the installed SDK's `query()`, `pathToClaudeCodeExecutable` set to the fake, using streaming input, `outputFormat`, `canUseTool`, a `SessionStart` hook, an interrupt and an abort.
3. **Pass** when `structured_output` arrives, the hook and `canUseTool` fire, and interrupt and abort end the fake without an SDK error. The fake then joins the process set as D9 decided, scripted from the same scenario files as the in-process fake.
4. If the SDK refuses the fake when starting it, start it through `spawnClaudeCodeProcess` with the executable path taken from config, as SCN 7.3 says (never a hidden test flag), and repeat step 2.
5. If the protocol itself can't be faked: decision 3. The process set's Claude rows use the in-process fake plus the live suite, D9 is amended, and no test-only code goes into the adapter.

## 12. What's deleted, and what's kept

Everything in today's engine is deleted in the end: `packages/ai-foreman` and the 0.10.x CLI layer go at the switch (decision 1). The question is what the new engine carries over. Counts are from `wc -l` on 2026-11-01.

### 12.1 `ai-foreman/src`: not carried over (105 files, 27,981 lines)

| Group | Files | Lines | Why it goes |
|---|---|---|---|
| State and database | `workflowDb.ts`, `workflowReader.ts`, `observability.ts`, `stateTransfer.ts`, `cli/state.ts`, `tickets/stateDb.ts`, `tickets/events.ts`, `ticketHistoryReader.ts`, `buildRuns.ts`, `log.ts` | 7,603 | One event log replaces the 95-table database, the observability database, the ticket-state database, run JSON and JSONL logs (principle 1); built-in portability replaces `rafi state` (CMD-17) |
| Orchestrator | `foreman.ts`, `cli/start.ts`, `agentRun.ts`, `cli/events.ts`, `outcomes.ts`, `markers.ts`, `index.ts`, `util/deadline.ts` | 4,947 | The loop, `decide` and the steps replace them (`cli/start.ts` is 3,177 lines); `index.ts` is the standalone `ai-foreman` binary (CMD-36, Q-CMD-5); deadlines run on the clock |
| Supervision and launch | `supervisedStart.ts`, `supervisor.ts`, `buildLaunchGate.ts`, `probeIpc.ts`, `linuxProbeInventory.ts`, `windowsProbeJob.ts`, `readinessCleanup.ts`, `readinessGate.ts` | 958 | One process (principle 9); `--detach` is one ordinary process (D5); probe-cleanup bookkeeping goes with PRM-80 |
| Build admission and ownership | `buildAdmission.ts`, `buildApproval.ts`, `buildAssignment.ts`, `buildInterventions.ts`, `buildOwnershipReconciliation.ts`, `buildOwnershipRepair.ts`, `buildSyntheticWork.ts`, `buildWorkAdmission.ts`, `buildWorkAuthorization.ts`, `buildWorkContext.ts`, `buildWorkMigration.ts`, `buildWorkReconciliation.ts`, `builderGuidanceFollowup.ts` | 1,713 | The lease and the fold replace admission tokens and reconciliation (4.3, 4.5) |
| Recovery | `recoveryGuidance.ts`, `recoveryOwners.ts`, `recoveryPolicy.ts`, `operationRecovery.ts`, `dispatchNotSent.ts`, `cli/recovery.ts`, `branch/resume.ts`, `readOnlyProposal.ts` | 692 | Resume redoes the step (principle 3); the autonomy profiles become `retries` (Q-CFG-3); `build:attach`/`decide`/`stop` become `resume`, `answer`, `stop` |
| Sessions, continuity, hand-offs | `sessionLifecycle.ts`, `sessionIdentity.ts`, `sessionAvailability.ts`, `continuity.ts`, `continuityOrigin.ts`, `handoffs.ts`, `handoffProtocol.ts`, `cli/handoffs.ts`, `adapters/recovering.ts`, `adapters/sessionFailure.ts` | 2,616 | Fresh sessions per ticket and native sessions (11.2); hand-offs are dropped (CMD-15) |
| Structured-dispatch proof | `structuredCutover.ts`, `structuredCutoverFiles.ts`, `structuredDispatchAuthority.ts`, `structuredDispatchRecord.ts`, `structuredLiveBudget.ts`, `structuredOperation.ts`, `boundedTurnEvidence.ts`, `providerPhase.ts` | 1,027 | Sealed tuples, receipts and phase barriers guard rafi's own hand-offs (principle 10); the turn runner replaces them (5.1–5.3) |
| Questions, plan changes, population paging authority | `humanDecision.ts`, `questionTrace.ts`, `planChanges.ts`, `ticketPopulationPageAuthority.ts` | 302 | The question record (7.6) and the plan-update rule (7.10) replace the first three; the paging authority guards rafi's own hand-off between population pages (principle 10), while the paging itself is carried over |
| The QA loop and its recovery | `qaAuthorizedDisposition.ts`, `qaBuildGate.ts`, `qaBuilderActivation.ts`, `qaBuilderCoverage.ts`, `qaBuilderEvidence.ts`, `qaContractCoverage.ts`, `qaContractDelivery.ts`, `qaContractFreshness.ts`, `qaCoverageAssembly.ts`, `qaDeliveryJournal.ts`, `qaEffectiveConfig.ts`, `qaEvidenceReader.ts`, `qaFailureDelivery.ts`, `qaHandbackHistory.ts`, `qaHandbackMigration.ts`, `qaHostFacts.ts`, `qaHostTransformation.ts`, `qaPreparation.ts`, `qaPreparationInputs.ts`, `qaPreparationMetrics.ts`, `qaPreparationPolicy.ts`, `qaPreparationStore.ts`, `qaPrerequisites.ts`, `qaProtocolV2.ts`, `qaRecovery.ts`, `qaReview.ts`, `qaReviewEvidence.ts`, `qaRuntime.ts`, `qaSnapshot.ts`, `qaStructuredResponse.ts`, `qaTimeline.ts`, `qaToolRecovery.ts`, `qaVerificationContract.ts`, `hostQaAugmentation.ts`, `hostQaComparison.ts`, `hostSourcePreservation.ts` | 8,123 | Three steps (prepare, review, fix), one requirements file, one verdict format and the ticket state machine replace QA's 14 states, 22 kinds of change and 10 recovery actions (RW bad pattern 7) |

### 12.2 `ai-foreman/src`: carried over (90 files, 23,193 lines today)

| Into | From | How |
|---|---|---|
| `engine/agents/` | `adapters/claude.ts`, `codex.ts`, `types.ts`, `structured.ts` (the bounded stream collector and runaway-whitespace guard), `fastMode.ts`; `permissions/policy.ts`, `shellForms.ts`; `runtimeReadiness.ts`, `runtimeAuth.ts`; `providerQuestions.ts` (the `AskUserQuestion` mapping) | Rewritten slim around the interface in 11.6 (budget 1,900 lines) |
| `engine/tickets/` | `tickets/*` except `stateDb.ts` and `events.ts`; `importer.ts` without the `importFromMarkdown` stub (FLAG-TK-23) | Ported: formats and validation unchanged; status reads and writes go to the log |
| `engine/git/`, `build/steps/deliver.ts` | `branch/*` except `resume.ts` | Ported; `runner.ts` (1,181 lines) is rewritten as the deliver step |
| `engine/graph/`, `engine/sources/` | `graph/*`, `hostGraphApplicability.ts`, `sources/sourceRegistry.ts` | Ported as they are |
| `engine/planning/` | `ticketPopulation.ts`, `ticketPlanning.ts`, `ticketPopulationPaging.ts` | Ported onto the turn runner |
| `engine/setup/` | `interviews.ts` (now pruning after 30 days, FILE-31), `installOwnership.ts`, `gitExclude.ts`, `qaRollbackRehearsal.ts`, `runtimePreflight.ts`, `processIdentity.ts`, `roles.ts`, `util/asyncQueue.ts` | Ported |
| `engine/manager/`, `engine/stats/` | `managerEvidence.ts`, `managerEvidenceArtifacts.ts`, `managerPacket.ts`, `cli/manager.ts`, `statusReporter.ts`, `cli/status.ts`, `diagnostics.ts` (Manager's `--external` checks), `projectDiagnostics.ts` | Rewritten over the log; output safety kept: redaction, escaping, `/more` cursors expiring after 15 minutes (FLAG-MG-10) |
| `engine/notify/` | `notify.ts` | Replaced; its platform calls are reused as fallbacks |
| `engine/migrate/` | `config.ts` | Read only by `rafi migrate`, to fold `foreman.yaml` in (Q-CFG-4) |
| CLI `ui/`, `commands/` | `activity.ts`, `terminalStyle.ts`, `cli/tickets.ts` (2,672 lines, split per subcommand), `cli/doctor.ts`, `cli/graph.ts`, `cli/runtimeAuthPrompt.ts`, `cli/runtimeSelection.ts` | Ported |

### 12.3 `rafi/src`

- **Not carried over** (14 files, 3,563 lines): `audit.ts` (→ `rafi stats show`, CMD-19), `buildRecoveryOptions.ts`, `buildReset.ts` and `buildStartOver.ts` (→ `rafi reset`, rewritten; FLAG-RE-3's git safety rules kept), `buildResume.ts`, `resume.ts`, `resumeLauncher.ts`, `resumeLaunchGate.ts`, `startRecovery.ts`, `createRecovery.ts` and `planDoctor.ts` (→ `rafi resume`), `ownership.ts` (a re-export), `runtimeReadiness.ts` (its probe-cleanup prompt, PRM-80, is dropped; readiness moves to `engine/agents/readiness.ts`), and `index.ts` (1,209 lines: the command table and create walkthrough are rewritten as `commands/*`, with the create prompts kept word for word, PRM-1–23).
- **Carried over**: `agents.ts`, `compiler.ts`, `createStackInterview.ts`, `discovery.ts`, `docs.ts`, `gitignore.ts` (with the new file list, FILE-10), `graphSetup.ts`, `grillAudit.ts`, `launcher.ts` (plus the engine switch), `lifecycle.ts`, `plan.ts`, `planningDriver.ts`, `planningRuntime.ts`, `project.ts`, `sources.ts`, `structuredPlan.ts`, `ticketPlan.ts`, `uninstall.ts` (covering the new files, FLAG-UN-1), `workMode.ts`.

### 12.4 `spec/src`

- **Not carried over** (13 files, 1,034 lines): `hostIpc.ts`, `stopCause.ts`, `structuredCommunicationBaseline.ts`, `structuredCommunicationManifest.ts`, `structuredCommunicationPolicy.ts`, `structuredCommunicationSites.ts`, `structuredLiveBudget.ts`, `providerWireRegistry.ts`, `qaFailureReport.ts`, `qaOutputContracts.ts`, `qaPreparation.ts`, `qaPreparationOutputContracts.ts`, `qaPreparationSchemas.ts`.
- **Reworked** for 1.0: `schemas.ts` (config, plan, tickets with the new keys and fields), `operationContracts.ts` and `providerContracts.ts` (plan and population proposals without the envelope and continuity), `structuredOutput.ts` (the Codex strict projection), `types.ts` (1,592 lines, split), `managerOutputContract.ts`, `graph.ts`, `validate.ts`. New: `events.ts`, `replies.ts`, `progress.ts`, `tools.ts`. During side-by-side the 1.0 schemas sit in `spec/src/v1/` next to the old ones, which go with the old engine.

### 12.5 `special-agents`

- Each rule pack in `content/rules/packs.index.yaml` gets `tags:` in place of `condition:`; the role manifests drop `conditionalPacks` (10.1).
- The `handoff` skill (`content/skills/handoff/`) is deleted with hand-offs (CMD-15) and removed from `content/agents/builder.yaml`. `improve-codebase-architecture` is removed from unattended roles, because it waits for a person's picks (NEW-INS-5).
- The tracker rules written into `.tickets/tracker-rules.md` come from `ai-foreman/src/tickets/renderMarkdown.ts:39,56-60`, which names `foreman tickets …` commands and tells agents to pick from `LLM_NEXT_QUEUE`. The ported renderer names only 1.0 commands and the `Next up` heading, carries a version line and is regenerated on upgrade (NEW-INS-5, NEW-INS-7, FILE-27). `rafi tickets validate`'s fourth pass checks for the old heading and its markers (`tickets/validate.ts:100-111`) and changes with the rename.
- Role text is rewritten to principle 13 (NEW-INS-1..9); the result is measured with the harness's pass rate (NEW-INS-8).

### 12.6 Scripts and tests

- `scripts/comms/` (the structured-communication inventory and baseline) and the root `package.json` scripts that run it (`test:comms-preflight`, `baseline:comms`, `check:comms-inventory`) go with the old engine.
- In `scripts/live/`, the canaries for recovery machinery (`recovery-boundaries.ts`, `structured-handoffs.ts`, `multiticket-recovery.mjs`, `branch-scope-recovery.ts`, `build-stalls.ts`, `incident-journeys.mjs`, `structured-adapters.ts`, `structured-capacity-*`) go with it. The authorization and deadline gates (`scripts/live/README.md`) and `claude-compaction.ts` (NEW-ADP-1) are reused by the new live suite (SCN 7.10).
- Today's tests (128 test files under `ai-foreman/test`, 41 under `rafi/test`) stay with the old engine and are deleted with it. Pieces reused by the harness are listed in SCN 7.11 (the Codex fakes, the PTY driver, the wire encoder, the parallel runner).

### 12.7 Project files the new engine never writes

`.foreman/runs/`, `.foreman/qa-report-recovery/`, `.foreman/qa-recovery-context/`, `.foreman/delivery-sessions/`, `.foreman/qa-contracts/`, `.foreman/<timestamp>.jsonl`, `.foreman/provider-streams/`, `.rafi/recovery.sqlite3`, `.rafi/observability.sqlite3`, `.rafi/recovery-archive/`, `.rafi/reset-stage/`, `.rafi/start-over-control/`, `.rafi/communication-quarantine/`, `.rafi/ownership-backups/`, `.rafi/backups/work-admission-v4/`, `.rafi/cache/handoffs/`, `.rafi/staging/`, `.rafi/state-transfer.json`, `.rafi/state-transfer-backups/`, `.rafi/agent-files/`, `.rafi/logs/supervisor-*.log`, `.tickets/ticket-state.sqlite`, `.tickets/migrations/001_init.sql`, `foreman.yaml` (FILE-25, FILE-26, FILE-41–48). S-CLI-2 step 4 checks after every scenario that none of them appears.

## 13. Details the requirements left to this plan

REQ and SCN left these to the architecture plan. This is what I set; each is easy to change in review.

| Detail | Set to | Section |
|---|---|---|
| Ticket, build and project states, and the GUI label mapping (Q-LIFE-1, GUI-R9) | 7 ticket states, 7 build states, 8 project states; the label table | 4.2–4.4 |
| A stored "crashed" build state (S-CRASH-3) | Not needed: derived from a live-state build with no live owner; the takeover records `build.owner_lost` | 4.3 |
| The renamed `LLM_NEXT_QUEUE` heading in `docs/ticket-progress.md` (Q-FMT-2, S-BATCH-1) | `Next up` | 3.8 |
| The `rafi plan` subcommands for the plan-change log and switching back (Q-PUA-2, S-PLAN-5) | `rafi plan changes` and `rafi plan restore <revision> [--ticket <id>]`. A project folder literally named `changes` or `restore` is passed as `./changes` | 7.10 |
| `rafi reset` arguments (Q-CMD-3, S-CLI-14) | `rafi reset [project]` asks "this build, everything, or the plan?"; flags `--build`, `--everything`, `--plan <revision>`, `--run <id>`, `--action restart-current\|archive-restart`, `--cleanup stash\|discard\|handled`, `--yes`. Other start-over actions exit 1 as unknown | 8.9 |
| Tool names for `rafi tools add` (S-TOOL-5) | `playwright`, `mobile-mcp`, `appium`, `maestro`, `ios-sim-push`, `apns-push`, `fcm-push` | 10.3 |
| The org-policy mechanism for locked settings (S-CLI-3, GUI-R21) | `~/.rafi/policy.yaml` with a `locked:` map; the harness gives each "computer" its own state folder | 8.6 |
| The Manager instance report's command (GUI-R18, S-CLI-18) | The host command `/report`, built from the log with no model turn | 6.7 |
| Hostile-environment limits (S-ENG-7) | SCN's starting values: resident memory under 500 MB, at most 10 MB of activity stored per turn with a cut marker, `rafi status` answering within 2 seconds during a flood | 3.4 |
| How the fake matches turns without reading prompts (SCN 7.3) | `TurnRequest.meta` travels next to the wire message through the transport seam | 11.6 |
| The 1.0 format marker | `format_version: 1` in `rafi-config.yaml` | 9.2 |
| New `rafi-config.yaml` keys (FMT-C12–C25, Q-CFG-1, Q-CFG-4) | `format_version`, `retries`, `timeouts`, `checks` (`ci_tests`, `ci_when`, `ci_blocks_merge`, `test_runner`, `output_paths`), `git.managed_by`, `approvals.mode` (`manual` or `auto`), `plan_updates` (`change-then-tell` or `ask-first`), `manual_checks` (`wait`, `none`, `track`), `locked_requirements`, `tags`, `tools`, `notifications`, `logs.location` (`machine` or `project`), `logs.capture` (`none`, `normal`, `detailed`), `recordings.save`, `recordings.keep`, `agent_permissions` (from `foreman.yaml`), `tickets.build.max_branch_depth`, `tickets.build.keep_worktrees`; `tickets.build.pr_ready` is removed | 5.6, 7, 8.6, 10 |
| New ticket fields (FMT-T17–T20, NEW-ASK-2) | `tags`, `needs` (`internet`, `local_servers`, `installs`, `services`, `credentials`), `open_decisions`, `person_only` and `locked` (acceptance-criterion numbers), `manual_checks`. Acceptance criteria stay a list of strings (`ai-foreman/src/tickets/ticketSchema.ts:75`) | 6.5, 7.2 |
| Database, background-log and machine-state locations | `.rafi/state.sqlite3`, `.rafi/background.log`, `~/.rafi/` | 3.1, 8.7, 8.2 |
| The turn-retry setting's name and scope (Q-CFG-3, Q-MAL-1) | `retries.turn: 3`, covering provider errors, timeouts and replies still invalid after the repair try | 5.6 |
| Circling threshold (NEW-ENG-5) | `retries.circling_repeats: 2` | 5.5 |
| Usage limits (S-TIME-2) | Wait for a reported reset up to `retries.quota_wait_hours: 6`, otherwise a build-wide question | 5.1 |
| Exit code after Ctrl+C | 130 | 8.8 |
| Agent liveness thresholds (GUI-R11) | "Active but quiet" after 2 minutes without activity; "stalled" after half the idle timeout; "not responding" when the owner's heartbeat is over 60 seconds old | 8.10, 4.3.1 |
| "Away" for plan-change notifications (NEW-PUA-4) | No terminal, or no key pressed in the build's terminal for 10 minutes | 7.10 |
| Blocked-ticket options per kind (S-BLK-9) | SCN's table, except that a `permission` block also offers "I fixed it myself" (RW's example), plus rafi's own kinds | 7.7 |
| Where tests run (NEW-MAL-6, decision 5) | Rafi runs them through `run_check` with the builder's permissions and records each run; QA stays read-only | 6.9 |
| The full suite and slow suites (decisions 5, 6) | At rafi's CI points, only when rafi handles git (`git.managed_by`, `checks.ci_tests`, `checks.ci_when`, default once at the end of the build); fresh results reused; a failure adds a rafi-owned fix ticket, done tickets are never reopened, and if the fix fails rafi merges anyway and tells you unless `checks.ci_blocks_merge` is on; limits of 2 minutes quiet, 5 minutes per ticket run, 20 per suite run, raised by asking | 6.10, 6.11 |
| Unverifiable requirements | Ask only when a known, unconfigured tool would let QA verify; otherwise record them as unverified and go on | 6.4 |
| Who checks project-wide locked requirements | A short, read-only QA check turn; ticket-level locks are checked by text | 7.10 |
| Code limits ("files under about 500 lines, lines short") | 500 lines per file, 100 per function, 120 characters per line, enforced by `scripts/check-rules.mjs` | 2.4 |
| A screen model or a headless terminal emulator for the fake terminal (SCN 7.6) | Left to M1's implementation plan, as SCN says | 14 |

## 14. Milestones

### 14.1 Rules for every milestone

- **Test-first** (D8, guide step 10). Write the milestone's scenarios, see them fail, build, see them pass. There's no baseline against 0.10.2.
- **The gate** is the fast suite: every scenario active so far, the transition tests, the log tests and `scripts/check-rules.mjs`, in under 60 seconds on 4 workers (SCN 7.10). Every earlier milestone's scenarios keep passing.
- **The ledger** (SCN 7.9). From M1, all 121 scenarios are registered with their `covers` lists and their milestone. One not yet active reports "not run (pending Mn)". The ledger fails if a requirement ID is in no registered scenario and isn't on SCN's not-testable list.
- **Partial scenarios.** A scenario may declare steps that need a later milestone; those steps report "not run (pending Mn)". Each scenario passes in full at exactly one milestone, listed under "Must pass".
- **Crashes.** From M4, crash-at-every-boundary and pause-at-every-safe-point run on S-CRASH-1's fixture, and each later milestone's new boundaries (git in M5, questions in M6, migrate and populate in M9) join the enumeration as they land. S-CLI-2 step 4 runs after every scenario from M1 on.
- **Security** (1.2). Each milestone's done checks include security tests for the threats its new code touches. A milestone isn't done until they pass.
- **Windows, unofficially.** The fast suite also runs on Windows from M1, so Windows problems show up early; Windows isn't supported until the GUI.
- **The old engine stays the default** throughout.

RW's seven milestones map onto these ten: RW 1 is M1; RW 2 and 3 are M2; RW 4 is M3; RW 6 (crash and resume) moves up to M4, so every later step is built redo-safe and enumerated from the start; RW 5 is M6 and M7; RW 7 is M5, M8 and M9; M10 covers what RW's list leaves out (instructions, tools, setup commands, release gates).

### M1. Foundations and the harness

- **First:** the D9 check (11.7), half a day.
- **Builds:** `packages/engine` with `deps` and its real implementations; `scripts/check-rules.mjs`; the log (tables, append, cursor reads, lease, blobs, migrations); the three transition functions, the fold, `decide` and the label maps; `runCli` with the whole command surface and help text (commands not built yet say so and exit 1); dropped and merged commands and flags exiting 1 with their replacement; the engine switch, D6's refusal and format detection both ways (9.2); a thin pair of adapters over `deps` transports (session, one turn with a schema, events, cancel), completed in M2; `packages/scenarios` with the F-ONE and F-CHAIN builders, the script engine with in-process Codex and Claude fakes, the Codex fake executable (from `rafi/test/fixtures/e2e-codex-faults.cjs`), the fake `claude` if the check passes, the fake clock, notifier and terminal, the crash and pause hooks for the named boundaries (4.6) with the write fence, the invariant checker, the transcript and the coverage ledger. The built-in workflow and role registry as data, the load checks, and transition tests built from the workflow (4.8); the reserved `workflows:` key and ticket `workflow` field rejected.
- **Security:** secret redaction on every write; the write fence; validation on read; imported events never folded; `scripts/check-rules.mjs` and the fast suite on Windows.
- **Must pass:** S-CLI-1, S-CLI-2.
- **Partial:** S-ENG-5 (steps 1, 2 and 4, process set), S-MIG-2 (step 1).
- **Also:** every (state, event) pair in the transition tests; log tests (append-only, replay from a cursor, idempotency keys, busy retry on the fake clock, the fence); fidelity tests in which each fake's wire output is parsed by the real adapters.

### M2. Agents, replies and one-ticket builds

- **Builds:** first, the check that a Codex thread reaches rafi's local MCP endpoint (decision 7) and which OS sandbox `run_check` uses (6.9); `run_check` and `check.run` records, rerunning only stale checks, the time limits (6.11); complete adapters (capabilities, grant mapping, usage, permission requests, `AskUserQuestion` pass-through, the compaction setting); the reply schemas (6.2–6.4) in rafi-spec; the turn runner (classification, the repair try, retries with backoff, idle timeout, cancel); facts (run records, snapshots, changed files, mismatches); the loop for tickets in sequence with `--steps N` (prepare, build, review that passes, deliver on the current branch with completion `none`); the progress-file write; first versions of `rafi status`, `rafi stats show`, `rafi stats export` and `rafi tickets show`; activity rows and plain-English lines; `--agent`, `--model`, `--effort`, `--fast`; a fresh session per ticket; settings with their sources. The check step, `run_check`'s allowlist and QA restore, `check_output` and the failure details sent to the builder, `--no-qa`'s tests (6.9); `AskUserQuestion` answered at once (5.1).
- **Security** (the main pass, because M2 is where agents first act): a threat-model review of `run_check`, `check_output` and the local endpoint, with tests that `run_check` refuses everything outside its allowlist (`rafi answer`, `curl`, a shell string), the sandbox blocks the network when it isn't granted, QA's runs can't change tracked files, and the endpoint refuses a request without the session's token or from another address; plus the agent permission policy for both runtimes.
- **Must pass:** S-START-1, S-START-4, S-MAL-1, S-MAL-5, S-TIME-1, S-TIME-2, S-SCN-1, S-SCN-14, S-ENG-4, S-ENG-5, S-CHK-1, S-CHK-9, S-CHK-10.
- **Partial:** S-MAL-2 (variant 1), S-MAL-4 (the builder runs), S-CLI-12 (prefixes, colors and exit codes of builds).
- **Also:** an opt-in live adapter check, by hand, on real Codex and Claude, for H01's conformance list: one small structured turn each, a cancel, a resumed session, usage, a refused tool request, Claude's compaction setting (Q-ADP-1), and local servers without internet (7.11).

### M3. The QA loop

- **Builds:** reject, fix and re-review with only what changed; `retries.fixes`; "What next?" with its options and the minimal question record in the same terminal; `fix.granted`; circling; the requirements-file rules (the depth minimum, receipts, missing or changed files making requirements "unable to verify"); unverified requirements; QA isolation (in place or on a copy, light or full fingerprint, drift; Q-COPY-1); skipping QA when a check fails and the related tests per ticket (6.9, 6.10); "I verified it myself" and "Explicitly waive QA".
- **Must pass:** S-QA-1, S-QA-3, S-QA-5, S-QA-7, S-CHK-2.
- **Partial:** S-QA-2 (steps 1–4), S-MAL-2 (variant 3), S-MAL-3 (QA's requirements file, QA's verdict, the builder's fix), S-CHK-3 (step 1).

### M4. Stop, crash and resume

- **Builds:** the lease and liveness, the derived "crashed" status, takeover and redo, attach; `rafi stop` (graceful and now) and Ctrl+C; pause and unpause, with Manager's thin host commands `/pause`, `/request-attempt` and `/answer-question`; the `rafi resume` picker (builds and saved interviews) and interview pruning; `rafi reset` (this build, everything); torn progress-file writes and storage faults; `--detach`; the crash and pause enumerations.
- **Must pass:** S-QA-4, S-CRASH-1, S-CRASH-3, S-CRASH-4, S-SCN-3, S-SCN-12, S-CLI-13.
- **Partial:** S-CRASH-5 (every safe point without a plan update or a question), S-START-5 (step 4, process set), S-ENG-7 (start, Ctrl+C and resume cycles; file handles; process set), S-CRASH-2 (all but the git faults).
- **Also:** a sample of S-CRASH-1 with a real SIGKILL in the process set, on both fake executables (D9).

### M5. Batches, delivery, tags and agent settings

- **Builds:** the scope flags (`--to-ticket`, `--ticket`, `--skip`, `--stacks`) and the interactive "Build tickets or complete delivery stacks?" with its up-to-a-ticket choice; scope approval (unchanged scope starts; a material change asks; "Give feedback" arrives in M8); delivery units (branch modes, completion modes, stacks, PRs through the fake `gh` and `glab`); dirty work; the dependency and readiness prompts (PRM-76–78); `docs/ticket-progress.md` with its `Next up` heading; the `rafi tickets` subcommands on the log, except `populate` and `plan`; tags (the fixed list, file patterns, reasons, QA's tags); packs, skills and tools chosen by tags, with tools passed into sessions; the reused-agent override and its compaction threshold; `rafi agents`; `--set`; org-locked settings; the config-only start flags; reading the progress file on a clone, rebuilding from it and merging its git conflicts. Rafi's CI step (6.10): `checks.ci_tests`, flaky and already-broken tests, the fix ticket, `checks.ci_blocks_merge`, and never adding CI files. Delivery units and their states, merge waits, the git error categories and the delivery question (4.3.2); `git.managed_by` (ARCH-6); `checks.ci_when` and reusing fresh results (6.10); rafi-owned tickets (decision 10).
- **Must pass:** S-START-2, S-BATCH-1, S-BATCH-2, S-BATCH-3, S-SCN-2, S-SCN-9, S-PORT-2, S-TAG-1, S-TAG-3, S-TAG-4, S-TAG-5, S-CLI-8, S-CHK-6, S-CRASH-2.
- **Partial:** S-START-3 (steps 1, 2 and 4), S-CLI-3 (all but the `uninstall:cleanup` check), S-CLI-4 (every subcommand except `populate`), S-CLI-14 (this build and everything), S-CLI-19 (the config keys in builds), S-CHK-8 (no suite runs), S-START-5 (all but step 5).

### M6. Questions and blocked tickets

- **Builds:** the full question record (open, answer, defer, close; short numbers; first answer wins across processes; every surface watching the log); `rafi answer`; pinned prompts, oldest first; the terminal title and status line; the blocked-ticket prompt with each kind's options and effects, including grants from the prompt; waiting, and exit 2 without a terminal; the engine notifier with sends, updates, closes and reminders (platform backends come in M7); checks only a person can do (D4); `AskUserQuestion` and scan gaps; build-wide problems; questions about the dependents of a dropped ticket. `answerEffects` and its test (4.1); the `limit` question and `blocked(limit)` (6.11); background builds keep waiting (decision 8).
- **Must pass:** S-BLK-1, S-BLK-2, S-BLK-3, S-BLK-4, S-BLK-5, S-BLK-6, S-BLK-7, S-BLK-8, S-BLK-10, S-MAL-2, S-ASK-3, S-ASK-4, S-SCN-4, S-SCN-5, S-SCN-6, S-SCN-8, S-CLI-15, S-NOT-2.
- **Partial:** S-QA-6 (steps 1, 2, 4 and 5), S-BLK-9 (every option except "Change it with the Planner").

### M7. Upfront check, permissions and notifications

- **Builds:** the scan (ticket needs, tools' permissions, the setup script's installs, credentials, decisions, the plan-update setting); the one list with "answer later"; grants (once, always on this machine, don't allow); `--allow`; auto-approve's warning and D3; the no-terminal behavior (OQ-5); each runtime's mapping of local servers and internet, checked live (7.11); notifier platforms (`alerter`, `osascript`, `notify-send --action`, WSL), choices with "More…", preferences and reminder timing; the project setup script, written by the builder, run first by every fresh agent, and recorded. The CI confirmation and the slow-test question, up front and mid-build (6.10, 6.11).
- **Security:** grants are scoped (once, always on this machine, never committed); no grant is implied by an answer that isn't a grant; notifications carry no secrets.
- **Must pass:** S-PERM-1, S-PERM-2, S-PERM-3, S-ASK-2, S-SCN-7, S-NOT-1, S-NOT-3, S-NOT-4, S-ENG-3, S-CLI-16, S-CHK-4, S-CHK-5, S-CHK-7, S-START-5.

### M8. Plan updates

- **Builds:** what counts as a plan update (OQ-6); change-then-tell and ask-first; locked requirements (the text check and QA's lock check); new plan revisions; rewriting and staleness for affected tickets only; telling you (terminal, notification when away, summary); `rafi plan changes` and `rafi plan restore` with re-checks; the Planner's change turn (from the blocked prompt and from "Discuss with read-only Planner"); "Give feedback" on the scope question; plan reset in `rafi reset`; pause at plan-update safe points. Re-checks after a plan update that changes a done ticket (7.10).
- **Must pass:** S-START-3, S-QA-2, S-CRASH-5, S-PLAN-1, S-PLAN-2, S-PLAN-3, S-PLAN-4, S-PLAN-5, S-BLK-9, S-CLI-14, S-CHK-3.

### M9. Planning commands, migrate, portability, history and Manager

- **Builds:** `rafi plan` with every flag, `rafi tickets plan`, and `rafi tickets populate` (validated before applying, all or nothing, with tags, needs and decisions; crash-safe between files), each followed by the upfront scan; `rafi migrate`; clone-and-resume with grants that stay on each machine; capture levels; `rafi stats` (`show`, `timeline`, `export`, `delete`); `rafi logs export` and `import`; Manager (its turn with log context, every host command, guidance delivery states, `/report`); the complete end-of-build summary and measurements.
- **Must pass:** S-QA-6, S-MAL-3, S-MAL-4, S-SCN-10, S-SCN-11, S-SCN-13, S-TAG-2, S-ASK-1, S-ASK-5, S-CLI-4, S-CLI-5, S-MIG-1, S-MIG-2, S-PORT-1, S-CLI-17, S-CLI-18, S-ENG-1.

### M10. Instructions, tools, setup commands and release gates

- **Builds:** role text rewritten to principle 13 and tagged content (NEW-INS-*); `rafi compile` writing the small core with version lines; `rafi tools add` with prerequisite checks and boilerplate; per-build ports, device locks, recordings and retention; the Codex per-thread MCP check (10.3); `rafi create` (every prompt, including log location, the Playwright and mobile-mcp offers and `alerter`), `compile`, `doctor`, `uninstall`, `uninstall:restore`, `uninstall:cleanup`, `graph`, `sources`, `discover`, `qa-rehearse-rollback`; output conventions and the launcher under Node 18; the hostile-environment set; the event-stream checks; the live suite (D7) and the two-builds-at-once load check.
- **Security:** one full review of the whole design and code against 1.2, plus untrusted tool output (S-TOOL-5) and the hostile environment (S-ENG-7), before release.
- **Must pass:** S-CTX-1, S-TOOL-1, S-TOOL-2, S-TOOL-3, S-TOOL-4, S-TOOL-5, S-TOOL-6, S-PORT-3, S-CLI-3, S-CLI-6, S-CLI-7, S-CLI-9, S-CLI-10, S-CLI-11, S-CLI-12, S-CLI-19, S-ENG-2, S-ENG-6, S-ENG-7, S-CHK-8.
- **Done when** all 121 scenarios pass in their modes; the fast suite runs in under a minute, the process set in minutes and the live suite in under an hour per provider (RW "Success criteria"); the core is under 10,000 lines; then dogfooding starts (guide step 11).

### 14.2 Count

| Milestone | Scenarios that pass in full | Running total |
|---|---|---|
| M1 | 2 | 2 |
| M2 | 13 | 15 |
| M3 | 5 | 20 |
| M4 | 7 | 27 |
| M5 | 14 | 41 |
| M6 | 18 | 59 |
| M7 | 14 | 73 |
| M8 | 11 | 84 |
| M9 | 17 | 101 |
| M10 | 20 | 121 |

## 15. Decisions (all decided 2026-11-02)

1. **Package name.** The new engine ships as `ai-foreman@3.0.0`. No old engine is kept: at the switch the old engine and `RAFI_ENGINE` are deleted. Anyone who needs it installs the previous version (9.1, 9.4).
2. **Codex app-server.** Kept for 1.0, behind one transport file, using only its stable surface; `rafi doctor` and the live suite check the Codex version (11.4).
3. **If M1 finds the SDK can't drive a fake `claude`.** The process set's Claude rows use the in-process fake plus the live suite; D9 is amended; no test-only code goes into the adapter.
4. **Claude authentication.** Fine as is: rafi runs your installed, unmodified `claude` with your own login, which Anthropic's terms allow (11.5).
5. **Tests.** Rafi runs and records every test through `run_check`; QA stays read-only; only targeted tests run per ticket; each ticket also runs the tests related to its changes; the full suite runs at rafi's CI points (`checks.ci_when`, decision 6), only when rafi handles git, and a failure adds a fix ticket instead of reopening done ones; if the fix fails, rafi merges anyway and tells you, unless `checks.ci_blocks_merge` is on (default off); slow suites raise their limit by asking (6.9–6.11).

Decided in the step 8 review (2026-11-02):

6. **How often CI runs** (REQ ARCH-7) is a setting, `checks.ci_when`: each ticket, each PR or merge, once at the end of the build (the default), or light before each PR plus full at the end. CI never reruns a test whose last passing run is still fresh (6.9, 6.10).
7. **How Codex reaches `run_check`** (REQ ARCH-9): the engine serves it on a local-only HTTP MCP endpoint with a per-session token; Claude gets it in-process. No IPC and no experimental Codex API (6.9).
8. **Background builds keep waiting** (REQ ARCH-8) instead of exiting with code 2, so notification answers keep working. Exit code 2 stays for foreground builds without a terminal (4.3).
9. **With QA off** (REQ ARCH-10), the check step runs the ticket's required tests and related tests. Every failure, there or anywhere, goes back to the builder with all its details (failing tests, errors, output excerpts, the full output by run number) and "keep your work; don't start over" (6.9).
10. **Rafi-owned fix tickets** (REQ ARCH-11; from CI or a re-check): you're told once and never asked; they aren't plan updates and don't count toward `--steps` (6.10).
11. **Workflows and roles as data** (REQ ARCH-13). 1.0 ships one workflow, `standard`, and today's five roles, defined as data with load checks, so custom workflows (maker-checker builds with any roles) can come later without a rewrite. `workflows:` and a ticket `workflow` field are reserved and rejected (4.8).
