# Build Plan: Repo-Local Ticket Tracker Re-architecture

## One-sentence goal

Build a local Node/TypeScript ticket tracker/orchestrator that keeps the repository's ticket workflow self-contained, preserves the "next 50 tickets in implementation order" control surface, and replaces fragile manual Markdown state with structured ticket definitions, durable runtime state, deterministic queue generation, and strict validation.

## Note about 150
When the number 150 is used below, it means 'some very large number of tickets'. There is nothing specific about having exactly 150 of anything here.

## Summary of the final design

Use this repository layout:

```txt
.tickets/
  config.yaml                    # project-level ticket tracker config
  tickets.yaml                   # canonical list of all ticket definitions and implementation order
  tracker-rules.md               # stable instructions for humans and builder agents
  ticket-state.sqlite            # mutable local runtime/progress state
  schema/
    tickets.schema.json          # schema all tickets in tickets.yaml must satisfy
    config.schema.json           # schema for config.yaml
  migrations/
    001_init.sql                 # SQLite schema
  backups/                       # automatic backups before migrations/imports

docs/
  ticket-progress.md             # generated agent-facing operational tracker
  ticket-archive.md              # generated or semi-generated archive report
```

Use these source-of-truth rules:

| Concern | Source of truth | Why |
|---|---|---|
| Ticket identity, title, acceptance criteria, required tests, risk, area, dependencies, likely files, and canonical implementation order | `.tickets/tickets.yaml` | One structured, human-readable file is easier than 150 Markdown files and safer than parsing a large tracker table. |
| Mutable progress, current status, blockers, timestamps, attempts, validation snapshots, work-log events, and evidence | `.tickets/ticket-state.sqlite` | SQLite gives atomic updates, transactions, indexed lookup, and reliable local state. |
| Rules for how the tracker must be managed | `.tickets/tracker-rules.md` | Stable instructions should not be mixed with mutable status tables. |
| Next-50 queue and compact operational view | `docs/ticket-progress.md` | This remains the file the builder reads first. It is generated from structured sources after every update. |
| Old completed/canceled work | `docs/ticket-archive.md` plus SQLite events | Keeps the active tracker small while preserving audit history. |

The current Markdown tracker should remain important, but its role changes:

> `docs/ticket-progress.md` is the generated control document. It is not the canonical database.

The current queue invariant remains non-negotiable:

> Every time any ticket status/progress changes, the app must recompute and rewrite the next-50 queue in correct implementation order.

## Explicit requirements to preserve

The new system must preserve every important behavior from the existing tracker template:

1. The builder agent can open one small document and answer: "what are the next X tickets?"
2. The tracker always exposes the next 50 remaining tickets in correct implementation order, or all remaining tickets if fewer than 50 remain.
3. The next-50 list is updated every time any ticket status/progress update occurs.
4. The tracker contains clear management instructions, not just data.
5. Queue rows include enough context to implement without scanning the full backlog first.
6. Blocked tickets are visible and cannot be accidentally implemented.
7. Active status, blocked status, validation evidence, work log, and queue rows stay consistent.
8. Completed/canceled tickets can be archived without losing historical evidence.
9. Marker comments remain stable so scripts and agents can parse the generated Markdown.
10. The system is local-only and does not integrate with Jira, Linear, GitHub Issues, or other external ticket sources.
11. The repository being worked on contains the ticket definitions and generated tracker document.
12. The app/orchestrator is non-LLM-based. It may supervise another process, but ticket tracking itself must be deterministic code.

## Naming note: `LLM_NEXT_QUEUE` vs `NEXT_TICKET_QUEUE`

Your current template uses `LLM_NEXT_QUEUE`. Keep that heading and marker comments during the first build for compatibility:

```md
## LLM_NEXT_QUEUE
<!-- LLM_NEXT_QUEUE_START -->
...
<!-- LLM_NEXT_QUEUE_END -->
```

The app should internally call this concept `nextQueue` or `nextTicketQueue`. Later, you can add a friendlier alias like `NEXT_TICKET_QUEUE`, but do not rename the existing markers until all scripts and docs have been migrated.

## File 1: `.tickets/config.yaml`

Purpose: centralize tracker paths, queue settings, timezone, and rendering options.

Example:

```yaml
app_name: My Local App
queue_limit: 50
timezone: America/Chicago
timestamp_format: iso8601_offset

paths:
  tickets: .tickets/tickets.yaml
  state_db: .tickets/ticket-state.sqlite
  tracker_rules: .tickets/tracker-rules.md
  progress_doc: docs/ticket-progress.md
  archive_doc: docs/ticket-archive.md

rendering:
  preserve_legacy_llm_queue_heading: true
  include_rules_in_progress_doc: true
  max_work_log_rows: 50
  max_validation_snapshot_rows: 20
  max_recent_completed_rows: 20
  generated_doc_warning: true

behavior:
  regenerate_progress_doc_after_every_update: true
  require_validation_evidence_for_done: true
  block_on_unresolved_dependencies: true
  use_atomic_file_writes: true
  backup_before_import_or_migration: true
```

Validation rules:

- `queue_limit` must be a positive integer. Default: `50`.
- `timezone` must be an IANA timezone string.
- All configured paths must be repo-relative.
- External ticket sources must not be configured.

## File 2: `.tickets/tickets.yaml`

Purpose: hold all canonical ticket definitions in one structured file.

For 150 tickets, use one YAML file, not one Markdown file per ticket.

Example:

```yaml
tickets:
  - id: T001
    order: 1000
    title: Add local health endpoint
    area: Platform
    priority: P0
    size: M
    risk: Medium
    depends_on: []
    summary: Add a local health endpoint used by the orchestrator and smoke tests.
    acceptance:
      - Health endpoint returns a stable success response.
      - Error response shape is documented.
      - Existing startup behavior remains unchanged.
    required_tests:
      - Unit test for health response builder.
      - Integration smoke test for health endpoint.
    likely_files:
      - api/*
      - tests/*
    rollback: Remove the route and associated tests.
    notes: null

  - id: T002
    order: 2000
    title: Add UI status indicator
    area: UI
    priority: P1
    size: S
    risk: Low
    depends_on:
      - T001
    summary: Show current health status in the UI.
    acceptance:
      - UI shows healthy state from the health endpoint.
      - UI shows an error state if the health endpoint fails.
    required_tests:
      - Component test for healthy state.
      - Component test for error state.
    likely_files:
      - web/*
      - tests/*
    rollback: Remove the status component and route usage.
    notes: null
```

Required fields per ticket:

| Field | Required | Description |
|---|---:|---|
| `id` | Yes | Stable ticket ID. Must be unique. |
| `order` | Yes | Canonical implementation order. Must be unique. Use gaps, such as `1000`, `2000`, `3000`, to make later inserts easy. |
| `title` | Yes | Short ticket title. |
| `area` | Yes | Product/code area. |
| `priority` | Yes | One of `P0`, `P1`, `P2`, `P3`. |
| `size` | Yes | One of `XS`, `S`, `M`, `L`, `XL`. |
| `risk` | Yes | One of `Low`, `Medium`, `High`. |
| `depends_on` | Yes | Array of ticket IDs. Empty array if no dependencies. |
| `summary` | Yes | Short implementation summary. |
| `acceptance` | Yes | Non-empty array of acceptance criteria. |
| `required_tests` | Yes | Non-empty array, unless explicitly `N/A: <reason>`. |
| `likely_files` | Yes | Array of expected files/globs. Empty only if unknown. |
| `rollback` | Required for Medium/High risk | Rollback or mitigation approach. |
| `notes` | Optional | Extra implementation notes. |

Do not store mutable runtime fields in `tickets.yaml`.

Do not put these fields in `tickets.yaml` except during migration/import:

```txt
status
last_worked_at
completed_at
attempt_count
last_error
evidence
current_step
blocked_by
validation_result
```

Those belong in SQLite.

## File 3: `.tickets/tracker-rules.md`

Purpose: keep the vital instructions from the old tracker in a stable, readable file.

This file should include:

```md
# Tracker Rules

## Purpose
This tracker is the operational build control surface for humans and builder agents.

## First file to read
Read `docs/ticket-progress.md` first. Do not scan the full backlog to choose work unless the queue is empty or the user explicitly asks for broader planning.

## How to choose work
Choose the first row in `LLM_NEXT_QUEUE` where `Status` is `next` and `Blocked By` is `None`.

## Required queue maintenance rule
Every ticket update must regenerate `docs/ticket-progress.md`, including `LLM_NEXT_QUEUE`.

## Blocked work
Do not implement blocked rows unless the blocker itself is the approved next work.

## Done policy
Never mark a ticket `done` without required validation evidence or a documented test exception.

## New work policy
Newly discovered work goes to the Discovered Future Work Inbox unless it has an approved ticket ID and implementation order.

## Generated document policy
Do not manually edit generated sections of `docs/ticket-progress.md`. Use the ticket update commands.
```

The renderer should copy this file into `docs/ticket-progress.md` when `include_rules_in_progress_doc` is true.

## File 4: `.tickets/ticket-state.sqlite`

Purpose: durable local state for ticket progress and operational history.

Use SQLite because updates must be atomic. A ticket status update must not be able to update the status table but forget to update the queue. The update command should perform state changes in one transaction, then render the Markdown document.

### SQLite schema

Create `.tickets/migrations/001_init.sql`:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ticket_state (
  ticket_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'planned',
  owner TEXT,
  current_step TEXT,
  next_action TEXT,
  blocked_by_json TEXT NOT NULL DEFAULT '[]',
  blocker_type TEXT,
  blocker_notes TEXT,
  first_blocked_at TEXT,
  last_checked_at TEXT,
  last_worked_at TEXT,
  completed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  evidence TEXT,
  validation_result TEXT,
  validation_commands TEXT,
  validation_notes TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  CHECK (status IN ('planned', 'next', 'in_progress', 'blocked', 'done', 'canceled')),
  CHECK (validation_result IS NULL OR validation_result IN ('passed', 'failed', 'not_run', 'not_applicable'))
);

CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  actor TEXT,
  ticket_id TEXT,
  event_type TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  summary TEXT NOT NULL,
  validation TEXT,
  evidence TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS validation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  scope TEXT NOT NULL,
  result TEXT NOT NULL,
  commands TEXT,
  evidence TEXT,
  notes TEXT,
  CHECK (result IN ('passed', 'failed', 'not_run', 'not_applicable'))
);

CREATE TABLE IF NOT EXISTS future_work (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discovered_at TEXT NOT NULL,
  source_ticket TEXT,
  proposed_ticket TEXT,
  priority_guess TEXT,
  area TEXT,
  summary TEXT NOT NULL,
  rationale TEXT,
  needs_decision_from TEXT,
  disposition TEXT NOT NULL DEFAULT 'triage',
  CHECK (disposition IN ('triage', 'accepted', 'rejected', 'merged', 'queued'))
);

CREATE TABLE IF NOT EXISTS recent_completed_context (
  ticket_id TEXT PRIMARY KEY,
  why_it_remains_here TEXT NOT NULL,
  pinned_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_index (
  archive_file TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  last_updated TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_ticket_state_status ON ticket_state(status);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_id ON ticket_events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_events_timestamp ON ticket_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_validation_snapshots_timestamp ON validation_snapshots(timestamp);
CREATE INDEX IF NOT EXISTS idx_future_work_disposition ON future_work(disposition);
```

Notes:

- SQLite cannot enforce foreign keys to `tickets.yaml`; the validator must check that all `ticket_state.ticket_id` values exist in `tickets.yaml`.
- Store `blocked_by_json` as a JSON array of ticket IDs or blocker labels.
- Use ISO 8601 timestamps with timezone offset.
- Use atomic transactions for every state update.

## File 5: `docs/ticket-progress.md`

Purpose: generated operational tracker and first-read document for the builder.

The generated document should contain both rules and data:

```md
# Ticket Progress Tracker

> Generated file. Do not manually edit generated sections. Use the ticket update commands.

## Purpose
...

## Tracker Metadata
<!-- TRACKER_METADATA_START -->
...
<!-- TRACKER_METADATA_END -->

## Ground Rules For Builder Agents
...copied or summarized from .tickets/tracker-rules.md...

## How To Pick The Next X Tickets
...

## Required Queue Maintenance Rule
...

## Status Values
...

## Priority Values
...

## Size Values
...

## Risk Values
...

## Last Validation Snapshot
...

## LLM_NEXT_QUEUE
<!-- LLM_NEXT_QUEUE_START -->
...generated table...
<!-- LLM_NEXT_QUEUE_END -->

## Active Ticket Status
<!-- ACTIVE_TICKET_STATUS_START -->
...generated table...
<!-- ACTIVE_TICKET_STATUS_END -->

## Blocked Tickets
<!-- BLOCKED_TICKETS_START -->
...generated table...
<!-- BLOCKED_TICKETS_END -->

## Recently Completed Context
<!-- RECENTLY_COMPLETED_CONTEXT_START -->
...generated table...
<!-- RECENTLY_COMPLETED_CONTEXT_END -->

## Discovered Future Work Inbox
<!-- DISCOVERED_FUTURE_WORK_START -->
...generated table...
<!-- DISCOVERED_FUTURE_WORK_END -->

## Archive Index
<!-- ARCHIVE_INDEX_START -->
...generated table...
<!-- ARCHIVE_INDEX_END -->

## Work Log
<!-- WORK_LOG_START -->
...generated table...
<!-- WORK_LOG_END -->

## Four-Pass Validation Checklist
...
```

The generated document must preserve the current template's important marker strategy. Add missing markers around sections that should be generated, so future tooling can replace only those sections safely.

## File 6: `docs/ticket-archive.md`

Purpose: readable archive of old `done` and `canceled` work.

This file should be generated or semi-generated from SQLite events and ticket definitions.

Recommended format:

```md
# Ticket Archive

## Done Tickets
| Ticket | Title | completed_at | Validation | Evidence | Summary |
|---|---|---|---|---|---|

## Canceled Tickets
| Ticket | Title | canceled_at | Reason | Evidence | Summary |
|---|---|---|---|---|---|
```

Keep the canonical ticket definition in `.tickets/tickets.yaml`. The archive is for lifecycle history and quick human review.

## Core queue algorithm

The next-50 queue is a computed window. It must not be hand-maintained as separate truth.

Inputs:

1. `.tickets/tickets.yaml`
2. `.tickets/ticket-state.sqlite`
3. `.tickets/config.yaml`

Output:

1. `docs/ticket-progress.md`
2. Optionally `docs/ticket-archive.md`

Algorithm:

```ts
function buildNextQueue(ticketDefs, ticketStates, queueLimit = 50) {
  const defsById = indexById(ticketDefs);

  const remaining = ticketDefs
    .filter(ticket => {
      const state = ticketStates[ticket.id];
      return !['done', 'canceled'].includes(state?.status ?? 'planned');
    })
    .sort((a, b) => a.order - b.order);

  const queueWindow = remaining.slice(0, Math.min(queueLimit, remaining.length));

  return queueWindow.map((ticket, index) => {
    const state = ticketStates[ticket.id] ?? defaultState(ticket.id);
    const unresolvedDeps = ticket.depends_on.filter(depId => {
      const depState = ticketStates[depId];
      return depState?.status !== 'done';
    });
    const explicitBlockers = parseBlockedByJson(state.blocked_by_json);
    const blockedBy = unique([...unresolvedDeps, ...explicitBlockers]);

    const displayStatus = computeDisplayStatus(state.status, blockedBy);

    return {
      rank: index + 1,
      ticket: ticket.id,
      title: ticket.title,
      status: displayStatus,
      priority: ticket.priority,
      area: ticket.area,
      dependsOn: ticket.depends_on.length ? ticket.depends_on.join(', ') : 'None',
      blockedBy: blockedBy.length ? blockedBy.join(', ') : 'None',
      size: ticket.size,
      risk: ticket.risk,
      nextAction: state.next_action || defaultNextAction(ticket, displayStatus, blockedBy),
      requiredTests: ticket.required_tests.join('; '),
      evidence: state.evidence || 'N/A until implemented.',
      likelyFiles: ticket.likely_files.join(', ')
    };
  });
}
```

Display status rules:

```txt
If stored status is done       -> exclude from queue
If stored status is canceled   -> exclude from queue
If stored status is in_progress -> display in_progress
If blockedBy is non-empty      -> display blocked
If stored status is blocked    -> display blocked
Otherwise                      -> display next
```

Important: a ticket can be stored as `planned` in SQLite and still display as `next` if it is inside the computed next-50 window and unblocked. This prevents the app from needing to rewrite dozens of status rows every time the queue window shifts.

## Queue invariants

The renderer and validator must enforce these invariants every time `docs/ticket-progress.md` is written:

1. `LLM_NEXT_QUEUE` has exactly `min(50, remaining_ticket_count)` rows.
2. Ranks start at `1` and increase by `1` without gaps.
3. Queue rows are sorted by `tickets.yaml[*].order`.
4. Queue contains no `done` or `canceled` tickets.
5. Every queued ticket exists in `tickets.yaml`.
6. Every queued ticket has an active status row.
7. Every blocked queued ticket appears in `Blocked Tickets`.
8. Every row has `Status`, `Priority`, `Area`, `Depends On`, `Blocked By`, `Size`, `Risk`, `Next Action`, `Required Tests`, `Evidence`, and `Likely Files`.
9. `Blocked By` is `None` only if the ticket has no unresolved dependencies and no explicit blockers.
10. High-risk tickets must include rollback or mitigation notes.
11. `done` tickets must have validation evidence or an explicit test exception.
12. Touched tickets must receive a new `last_worked_at` timestamp.
13. Every update must append a `ticket_events` row, which appears in the generated Work Log.

## Update workflow

Every status/progress update must go through one application command or API call. Do not manually edit generated Markdown tables.

Required update transaction:

```txt
1. Load config.
2. Load and validate tickets.yaml.
3. Open SQLite transaction.
4. Read old ticket state.
5. Apply requested ticket update.
6. Update last_worked_at for touched tickets.
7. Set completed_at only when new status is done.
8. Insert ticket_events row.
9. Insert validation_snapshots row if validation data was supplied.
10. Update future_work, blocked state, or recent_completed_context if applicable.
11. Commit SQLite transaction.
12. Recompute next-50 queue from tickets.yaml + SQLite.
13. Render docs/ticket-progress.md using atomic write.
14. Render docs/ticket-archive.md if archive data changed.
15. Run validator.
16. If validation fails, fail the command and print exact errors.
```

This directly satisfies the existing rule that every ticket update must also update the next-ticket list.

## Required CLI commands

Implement a CLI, even if the orchestrator also calls library functions. Agents and humans need deterministic commands.

Recommended binary name: `ticketctl`.

### `ticketctl init`

Creates the `.tickets/` structure, config, schema, migrations, SQLite DB, and first rendered progress doc.

Example:

```bash
npm run ticketctl -- init --app-name "My App" --timezone America/Chicago
```

### `ticketctl import`

Imports from the existing Markdown tracker/backlog into the new structured format.

Example:

```bash
npm run ticketctl -- import --progress docs/ticket-progress.md --backlog docs/tickets.md
```

Behavior:

- Back up existing files first.
- Extract tracker metadata into `.tickets/config.yaml`.
- Extract ticket definitions into `.tickets/tickets.yaml` where possible.
- Extract active statuses into SQLite.
- Extract blocked rows into SQLite blocker fields.
- Extract work log into `ticket_events`.
- Extract validation snapshots into `validation_snapshots`.
- Extract future work inbox into `future_work`.
- Extract rules into `.tickets/tracker-rules.md`.
- Render a new `docs/ticket-progress.md`.
- Print a migration report listing any fields that required manual review.

### `ticketctl update <ticketId>`

Generic status/progress update command.

Examples:

```bash
npm run ticketctl -- update T001 \
  --status in_progress \
  --actor builder \
  --summary "Started implementation" \
  --next-action "Add failing smoke test first"
```

```bash
npm run ticketctl -- update T001 \
  --status done \
  --actor builder \
  --summary "Implemented health endpoint" \
  --validation-result passed \
  --validation-commands "npm test" \
  --evidence "All tests passed locally"
```

Rules:

- `--status done` requires validation evidence unless `--validation-result not_applicable` and `--validation-notes` explains why.
- Any update must regenerate `docs/ticket-progress.md`.
- The command must fail if the new state creates invalid queue output.

### `ticketctl block <ticketId>`

Marks a ticket blocked.

Example:

```bash
npm run ticketctl -- block T002 \
  --blocked-by T001 \
  --type dependency \
  --summary "Waiting for health endpoint contract" \
  --unblock-criteria "T001 is done and endpoint contract is documented"
```

Rules:

- Adds/updates blocker details.
- Sets status to `blocked` unless the only blockers are dependency-derived and the renderer can compute them automatically.
- Adds a Work Log event.
- Regenerates the next-50 queue.

### `ticketctl unblock <ticketId>`

Removes explicit blockers.

Example:

```bash
npm run ticketctl -- unblock T002 --summary "Dependency resolved"
```

Rules:

- Removes explicit blockers.
- If dependencies are done, the displayed status becomes `next` when the ticket is in the queue window.
- Regenerates the queue.

### `ticketctl complete <ticketId>`

Convenience wrapper around `update --status done`.

Example:

```bash
npm run ticketctl -- complete T001 \
  --summary "Health endpoint complete" \
  --validation-result passed \
  --validation-commands "npm test" \
  --evidence "Tests passed locally"
```

### `ticketctl cancel <ticketId>`

Cancels a ticket.

Example:

```bash
npm run ticketctl -- cancel T099 --summary "No longer needed after architecture change"
```

Rules:

- Requires a reason in `--summary`.
- Excludes the ticket from queue.
- Regenerates progress doc and archive.

### `ticketctl discover`

Adds newly discovered future work to the inbox.

Example:

```bash
npm run ticketctl -- discover \
  --source-ticket T001 \
  --priority-guess P2 \
  --area Platform \
  --summary "Add health endpoint metrics" \
  --rationale "Needed for future monitoring"
```

Rules:

- Does not change implementation order unless explicitly accepted.
- Shows in `Discovered Future Work Inbox`.

### `ticketctl accept-future-work <futureWorkId>`

Moves a future-work item into `.tickets/tickets.yaml` with an approved ticket ID and order.

Example:

```bash
npm run ticketctl -- accept-future-work 12 --ticket-id T151 --order 151000
```

Rules:

- Adds a new ticket definition.
- Marks future-work disposition as `queued` or `accepted`.
- Regenerates progress doc.

### `ticketctl reorder`

Changes canonical implementation order.

Example:

```bash
npm run ticketctl -- reorder T042 --after T020
```

Rules:

- Updates `order` in `tickets.yaml`.
- Preserves unique ordering.
- Regenerates the next-50 queue.
- Adds a Work Log event because implementation order changed.

### `ticketctl render`

Renders `docs/ticket-progress.md` from current structured sources.

Example:

```bash
npm run ticketctl -- render
```

### `ticketctl validate`

Runs all schema, state, queue, and document checks.

Example:

```bash
npm run ticketctl -- validate
```

### `ticketctl queue`

Prints the next queue to stdout.

Example:

```bash
npm run ticketctl -- queue --limit 10
```

### `ticketctl archive`

Updates `docs/ticket-archive.md` and optionally prunes old completed rows from the active generated context.

Example:

```bash
npm run ticketctl -- archive --older-than-days 14
```

## Required library modules

Build the CLI on top of reusable modules so the orchestrator can call the same logic directly.

Recommended TypeScript modules:

```txt
src/tickets/config.ts          # load/validate config
src/tickets/ticketSchema.ts    # ticket YAML schema/types
src/tickets/ticketLoader.ts    # read/write tickets.yaml
src/tickets/stateDb.ts         # SQLite connection, migrations, transactions
src/tickets/events.ts          # event/work-log helpers
src/tickets/queue.ts           # next-50 queue computation
src/tickets/blockers.ts        # dependency and explicit blocker resolution
src/tickets/renderMarkdown.ts  # render docs/ticket-progress.md and archive
src/tickets/validate.ts        # all validation passes
src/tickets/importer.ts        # migration from existing Markdown template
src/tickets/commands.ts        # shared command handlers
src/cli/ticketctl.ts           # CLI entry point
```

Suggested dependencies:

```txt
YAML parser
SQLite client
Schema validator
CLI argument parser
Timezone/date library
Markdown table renderer or small custom table renderer
```

Do not add dependencies on Jira, Linear, GitHub Issues, or any external ticket source.

## Markdown rendering details

The renderer must:

1. Generate tables deterministically.
2. Sort queue by rank.
3. Sort active status by queue rank, then active non-queued exceptions if any.
4. Sort blocked tickets by queue rank.
5. Sort work log newest-first or newest-last consistently. Prefer newest-first in generated report if limited to the latest rows.
6. Escape Markdown table pipes in values.
7. Replace newlines inside table cells with `<br>`.
8. Use `None` for empty dependency/blocker fields.
9. Use `N/A` for evidence not available yet.
10. Preserve stable marker comments.
11. Write files atomically: write to temp file, fsync if practical, then rename.
12. Produce identical output on repeated renders when state has not changed.

## Generated `LLM_NEXT_QUEUE` table columns

Keep these columns:

```txt
Rank
Ticket
Title
Status
Priority
Area
Depends On
Blocked By
Size
Risk
Next Action
Required Tests
Evidence
Likely Files
```

Column source mapping:

| Column | Source |
|---|---|
| `Rank` | Computed queue position. |
| `Ticket` | `tickets.yaml.id`. |
| `Title` | `tickets.yaml.title`. |
| `Status` | Computed display status. |
| `Priority` | `tickets.yaml.priority`. |
| `Area` | `tickets.yaml.area`. |
| `Depends On` | `tickets.yaml.depends_on`. |
| `Blocked By` | unresolved dependencies + explicit SQLite blockers. |
| `Size` | `tickets.yaml.size`. |
| `Risk` | `tickets.yaml.risk`. |
| `Next Action` | SQLite `next_action`, otherwise generated default. |
| `Required Tests` | `tickets.yaml.required_tests`. |
| `Evidence` | SQLite `evidence`, otherwise `N/A until implemented.` |
| `Likely Files` | `tickets.yaml.likely_files`. |

## Generated `Active Ticket Status` table columns

Keep these columns:

```txt
Ticket
Title
Status
Priority
Area
Owner
last_worked_at
completed_at
Depends On
Blockers
Next Action
Acceptance / Test Gate
Evidence
Future Work / Notes
```

Every queued ticket must appear here.

For rows that have never been touched, render `last_worked_at` as `N/A`. For touched rows, render the last update timestamp.

## Generated `Blocked Tickets` table columns

Keep these columns:

```txt
Ticket
Blocked By
Blocker Type
Owner
First Blocked At
Last Checked At
Needed Decision / Action
Unblock Criteria
Notes
```

A row appears here if either:

1. The ticket has unresolved dependencies, or
2. The ticket has explicit blockers in SQLite.

Dependency blockers can be generated even if no explicit SQLite blocker row exists.

## Generated `Work Log`

Populate from `ticket_events`.

Keep the table short in `docs/ticket-progress.md`. Use `max_work_log_rows` from config. The full event history remains in SQLite.

## Generated `Last Validation Snapshot`

Populate from `validation_snapshots`.

If no validation has run, show one row:

```txt
N/A | tracker | not_run | N/A | N/A | No validation snapshots recorded yet.
```

## Validation engine

Implement validation in four passes, matching the current template's concept.

### Pass 1: schema and source validation

Check:

- `config.yaml` exists and matches schema.
- `tickets.yaml` exists and matches schema.
- Ticket IDs are unique.
- Ticket `order` values are unique.
- Dependencies reference existing ticket IDs.
- Dependency graph has no cycles.
- Enum fields are valid.
- Every ticket has required tests or an explicit `N/A: reason` entry.
- High-risk and medium-risk tickets include rollback/mitigation notes.

### Pass 2: state validation

Check:

- SQLite migrations have run.
- Every `ticket_state.ticket_id` exists in `tickets.yaml`.
- Every event with a `ticket_id` references a real ticket.
- `done` tickets have `completed_at`.
- Non-done tickets do not have `completed_at`, unless imported historical data explicitly requires it.
- `done` tickets have validation evidence or a documented test exception.
- Timestamp fields match ISO 8601 with offset.

### Pass 3: queue validation

Check:

- Queue length is `min(queue_limit, remaining_ticket_count)`.
- Queue ranks are contiguous and start at `1`.
- Queue contains no `done` or `canceled` tickets.
- Queue is sorted by canonical `order`.
- Blocked rows have non-empty `Blocked By`.
- Unblocked rows have `Blocked By = None`.
- First implementable row has `Status = next` and `Blocked By = None`.
- Every queue row has required columns populated.

### Pass 4: generated Markdown validation

Check:

- `docs/ticket-progress.md` exists.
- Required sections exist.
- Required marker comments exist.
- Every queued ticket appears in Active Ticket Status.
- Every blocked queued ticket appears in Blocked Tickets.
- Latest update produced a Work Log row.
- Generated doc can be parsed back by the validator.
- No placeholder example rows remain after initialization/migration.

## Migration plan from the current Markdown tracker

The migration command should handle the existing template safely.

### Step 1: backup

Before making changes:

```txt
.tickets/backups/<timestamp>/docs-ticket-progress.md
.tickets/backups/<timestamp>/docs-tickets.md
.tickets/backups/<timestamp>/ticket-state.sqlite, if it exists
```

### Step 2: extract metadata

Read `Tracker Metadata` from the old Markdown tracker.

Map:

```txt
App Name                 -> config.app_name
Queue Limit              -> config.queue_limit
Timezone                 -> config.timezone
Progress Tracker         -> paths.progress_doc
Archive File             -> paths.archive_doc
Canonical Backlog        -> old source only; new canonical source is .tickets/tickets.yaml
```

### Step 3: extract static rules

Move or copy these sections into `.tickets/tracker-rules.md`:

```txt
Purpose
Ground Rules For LLM Builders / Builder Agents
How To Pick The Next X Tickets
Required Queue Maintenance Rule
Ticket Reset And Archive Policy
Timestamp Policy
Status Values
Priority Values
Size Values
Risk Values
Cross-Cutting Review Checklist
Standard Update Workflow
Four-Pass Validation Checklist
Update Checklist For Future Builders
```

Rewrite language from `LLM builder` to `builder agent` where appropriate, but preserve `LLM_NEXT_QUEUE` marker names initially.

### Step 4: extract ticket definitions

Preferred source order:

1. Full canonical backlog, if available.
2. Existing `LLM_NEXT_QUEUE` rows.
3. Existing `Active Ticket Status` rows.
4. Manual review for any missing title/acceptance/test data.

For each ticket, create a `tickets.yaml` entry.

If acceptance criteria are unavailable, set:

```yaml
acceptance:
  - "TODO: fill acceptance criteria during migration review"
```

Then make the validator warn, not fail, until migration is marked complete.

### Step 5: extract ticket state

Map old `Active Ticket Status` rows to `ticket_state`.

Map:

```txt
Status                    -> ticket_state.status
Owner                     -> ticket_state.owner
last_worked_at            -> ticket_state.last_worked_at
completed_at              -> ticket_state.completed_at
Blockers                  -> ticket_state.blocked_by_json / blocker_notes
Next Action               -> ticket_state.next_action
Evidence                  -> ticket_state.evidence
Future Work / Notes       -> ticket_state.blocker_notes or event payload notes
Acceptance / Test Gate    -> ticket definition if missing, otherwise event notes
```

### Step 6: extract blocked tickets

Map old `Blocked Tickets` rows to explicit blockers in SQLite.

### Step 7: extract validation snapshots

Map `Last Validation Snapshot` rows to `validation_snapshots`.

### Step 8: extract work log

Map old `Work Log` rows to `ticket_events`.

### Step 9: extract future work inbox

Map old `Discovered Future Work Inbox` rows to `future_work`.

### Step 10: render and compare

Render the new `docs/ticket-progress.md`.

Compare the first generated queue against the old queue:

- Ticket IDs should match where possible.
- Order should match where possible.
- Status differences should be explained in the migration report.

### Step 11: run validation

Run:

```bash
npm run ticketctl -- validate
```

The migration is complete only when validation passes or all remaining warnings are explicitly marked as accepted migration warnings.

## Orchestrator integration

The app/orchestrator should never edit Markdown tables directly.

Use library calls or CLI commands at these lifecycle points:

| Orchestrator event | Ticket tracker action |
|---|---|
| Builder starts a ticket | `update(ticketId, { status: 'in_progress', ... })` |
| Builder records progress | `update(ticketId, { current_step, next_action, evidence? })` |
| Builder finds blocker | `block(ticketId, { blockedBy, blockerType, ... })` |
| Builder unblocks work | `unblock(ticketId, ...)` |
| Builder finishes code but tests fail | `update(ticketId, { status: 'in_progress', validation_result: 'failed', last_error })` |
| Builder completes ticket | `complete(ticketId, { validation_result: 'passed', evidence, commands })` |
| Builder cancels ticket | `cancel(ticketId, { summary })` |
| Builder discovers future work | `discover(...)` |

After each action, the shared update handler must regenerate `docs/ticket-progress.md`.

## Manual fallback protocol

Normal rule: do not manually edit generated Markdown sections.

If the CLI is unavailable and an agent/human must make an emergency manual update:

1. Edit only the minimum required rows in `docs/ticket-progress.md`.
2. Add a Work Log row explaining that this was a manual emergency update.
3. Do not mark tickets `done` without evidence.
4. As soon as the CLI is available, run an import/reconcile command to sync manual changes back into SQLite.
5. Run validation.

Implement `ticketctl reconcile --from docs/ticket-progress.md` as a future command if manual fallback is expected to happen often.

## Git and persistence policy

Default recommendation for a single local orchestrator:

```txt
Commit:
  .tickets/config.yaml
  .tickets/tickets.yaml
  .tickets/tracker-rules.md
  .tickets/schema/*.json
  .tickets/migrations/*.sql
  docs/ticket-progress.md
  docs/ticket-archive.md

Usually commit or backup separately:
  .tickets/ticket-state.sqlite
```

SQLite is a binary file, so it can be awkward in Git. Choose one of these policies:

### Policy A: commit SQLite

Use when one local actor owns the repo and progress state should travel with the repository.

Pros:

- Simple.
- True local source of truth is inside the repo.
- Easy to resume on the same checkout.

Cons:

- Binary diffs.
- Merge conflicts are not human-friendly.

### Policy B: do not commit SQLite, commit generated Markdown

Use when Git history should stay text-only.

Pros:

- Cleaner Git diffs.
- Human-readable progress remains committed.

Cons:

- SQLite state must be backed up separately.
- Reconstructing full event history from Markdown may be lossy.

### Policy C: add a text event log later

For best Git-friendliness, add `.tickets/state-events.ndjson` as an append-only text source and let SQLite be a cache. This is optional and should not block the first build.

For this build, implement Policy A by default unless the project owner explicitly chooses Policy B.

## Edge cases to handle

1. **Fewer than 50 remaining tickets**: queue contains all remaining tickets.
2. **No remaining tickets**: queue renders an empty table with a clear message.
3. **All top tickets blocked**: queue still shows them, but first implementable ticket is the first row with `Status = next` and `Blocked By = None`.
4. **Dependency cycle**: validation fails.
5. **Missing dependency ID**: validation fails.
6. **Duplicate ticket ID**: validation fails.
7. **Duplicate order**: validation fails.
8. **Ticket marked done without evidence**: update command fails unless explicit test exception is supplied.
9. **New ticket inserted before current queue**: queue is regenerated and may change immediately.
10. **Ticket canceled**: it leaves the queue and archive updates.
11. **Manual edit to generated doc**: next render overwrites it. Validator should optionally detect drift by comparing rendered output to current file.
12. **Timezone missing**: fail config validation.
13. **Markdown table values contain pipes/newlines**: renderer escapes them.
14. **Interrupted write**: atomic write prevents partial progress doc.
15. **Concurrent updates**: SQLite transaction serializes DB changes; use a process-level file lock around render if multiple Node processes can run.

## Test plan

Implement tests at four levels.

### Unit tests

Test:

- Config loading.
- Ticket YAML parsing.
- Schema validation.
- Dependency resolution.
- Cycle detection.
- Queue generation.
- Display status computation.
- Markdown table escaping.
- Timestamp formatting.

### Integration tests

Test full command flows:

1. Initialize project.
2. Add/import tickets.
3. Render first queue.
4. Mark first ticket `in_progress`.
5. Mark first ticket `done` with validation evidence.
6. Confirm ticket leaves queue.
7. Confirm ticket 51 enters queue when 150 tickets exist.
8. Block a ticket.
9. Confirm blocked ticket appears in both queue and Blocked Tickets.
10. Unblock a ticket.
11. Discover future work.
12. Accept future work into `tickets.yaml`.
13. Archive old completed tickets.

### Snapshot tests

Use snapshot tests for generated Markdown.

Rules:

- Same input must produce byte-for-byte same output.
- Snapshot should include `LLM_NEXT_QUEUE`, Active Status, Blocked Tickets, and Work Log.
- Avoid volatile timestamps in snapshots by injecting a fixed clock.

### Migration tests

Use a fixture based on the old template.

Test:

- Metadata extraction.
- Queue extraction.
- Active status extraction.
- Work log extraction.
- Rules extraction.
- Generated output validates.

## Build phases for the implementation agent

### Phase 1: project skeleton

Deliverables:

- Add TypeScript module structure.
- Add CLI entry point.
- Add config loader.
- Add basic tests.

Acceptance criteria:

- `npm run ticketctl -- --help` works.
- `ticketctl init` creates expected files.

### Phase 2: structured ticket definitions

Deliverables:

- Implement `.tickets/tickets.yaml` loader/writer.
- Implement schema validation.
- Implement dependency validation and cycle detection.

Acceptance criteria:

- Invalid IDs, duplicate order, missing deps, and cycles fail validation.

### Phase 3: SQLite state

Deliverables:

- Add migrations.
- Add state DB module.
- Add transaction helper.
- Add event logging.

Acceptance criteria:

- Status updates persist.
- Work Log events persist.
- Invalid status values are rejected.

### Phase 4: queue engine

Deliverables:

- Implement next-50 queue computation.
- Implement blocker resolution.
- Implement display status computation.

Acceptance criteria:

- With 150 planned tickets, queue has first 50 by order.
- Completing T001 removes it and adds T051.
- A ticket depending on incomplete T001 displays `blocked`.

### Phase 5: Markdown renderer

Deliverables:

- Render `docs/ticket-progress.md`.
- Include rules from `.tickets/tracker-rules.md`.
- Render all required tables.
- Use stable marker comments.
- Use atomic writes.

Acceptance criteria:

- Rendered doc passes generated Markdown validation.
- Re-rendering with no state change produces identical output.

### Phase 6: update commands

Deliverables:

- `update`
- `block`
- `unblock`
- `complete`
- `cancel`
- `discover`
- `accept-future-work`
- `reorder`
- `queue`
- `render`
- `validate`

Acceptance criteria:

- Every command that changes state regenerates `docs/ticket-progress.md`.
- Commands fail if validation fails.

### Phase 7: migration from current tracker

Deliverables:

- `import` command.
- Backup creation.
- Migration report.
- Fixture tests.

Acceptance criteria:

- Existing tracker template can be imported.
- New `docs/ticket-progress.md` preserves the next-50 queue behavior.

### Phase 8: orchestrator integration

Deliverables:

- Replace direct tracker Markdown edits with library/CLI calls.
- Ensure orchestrator calls update handler at every ticket lifecycle transition.

Acceptance criteria:

- Running the orchestrator on a ticket updates SQLite, Work Log, and regenerated next-50 queue.

### Phase 9: hardening

Deliverables:

- File locking if multiple processes can update.
- Drift detection.
- Better error messages.
- Optional archive pruning.
- Documentation.

Acceptance criteria:

- Interrupted writes do not corrupt progress doc.
- Manual changes to generated sections are detected or overwritten deterministically.

## Acceptance criteria for the whole build

The implementation is complete only when all of these are true:

1. `.tickets/tickets.yaml` can hold all 150 ticket definitions.
2. One schema validates every ticket.
3. SQLite stores mutable progress state.
4. `docs/ticket-progress.md` is generated, not manually maintained.
5. `docs/ticket-progress.md` still contains management instructions for the builder.
6. The next-50 queue is present and parseable.
7. Completing/canceling/blocking/updating a ticket regenerates the next-50 queue automatically.
8. The queue always contains the next 50 remaining tickets in implementation order, or all remaining if fewer than 50 remain.
9. The first implementable ticket is easy to identify.
10. Blocked tickets are visible in both queue and Blocked Tickets.
11. Work Log is updated on every meaningful change.
12. Done tickets require validation evidence or an explicit test exception.
13. The app has no external ticket-source integrations.
14. The old tracker template can be migrated or manually seeded into the new structure.
15. Validation catches schema, queue, state, dependency, and generated Markdown inconsistencies.
16. All generated files are written atomically.
17. Tests cover the core queue-shift behavior: when T001 is completed, T051 enters a 50-ticket queue.

## What the builder agent should do first

1. Create `.tickets/config.yaml`.
2. Create `.tickets/tickets.yaml` with a small fixture of at least 55 tickets.
3. Create `.tickets/tracker-rules.md` from the current tracker instructions.
4. Create SQLite migration and state DB module.
5. Implement queue generation.
6. Render `docs/ticket-progress.md`.
7. Add the test proving next-50 behavior.
8. Add update commands.
9. Add validation.
10. Add migration/import support.

## Final design decision

Use:

```txt
.tickets/tickets.yaml       # all ticket definitions and canonical order
.tickets/ticket-state.sqlite # mutable progress and event state
docs/ticket-progress.md      # generated builder-facing tracker with next-50 queue and instructions
.tickets/tracker-rules.md    # stable tracker-management instructions
```

Do not use one giant Markdown tracker as the database.

Do not create 150 separate Markdown files unless individual tickets become long prose specs.

Do not manually maintain the next-50 queue. Compute it after every update.
