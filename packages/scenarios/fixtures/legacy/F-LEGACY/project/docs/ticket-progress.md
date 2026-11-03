# Ticket Progress Tracker

> Generated file. Do not manually edit generated sections. Use `foreman tickets` commands.

## Tracker Metadata
<!-- TRACKER_METADATA_START -->
| Field | Value |
|---|---|
| App | legacy-fixture |
| Implementation Limit | 500 |
| View Limit | 20000 |
| Timezone | UTC |
| Generated At | 2026-11-03T02:10:21.565Z |
| Remaining Tickets | 0 |
<!-- TRACKER_METADATA_END -->

## Delivery Units
<!-- DELIVERY_UNITS_START -->
- feature: 1/1 complete; 0 remaining; per-ticket; none; complete
<!-- DELIVERY_UNITS_END -->

# Tracker Rules

## Purpose
This tracker is the operational build control surface for humans and builder agents.

## First file to read
Read `docs/ticket-progress.md` first. Do not scan the full backlog to choose work
unless the queue is empty or the user explicitly asks for broader planning.

## How to choose work
Choose the first row in `LLM_NEXT_QUEUE` where `Status` is `next` and `Blocked By` is `None`.

## Required queue maintenance rule
Every ticket update must regenerate `docs/ticket-progress.md`, including `LLM_NEXT_QUEUE`.
Use `foreman tickets update <id>` — never manually edit generated sections.

## Blocked work
Do not implement blocked rows unless the blocker itself is the approved next work.

## Done policy
Never mark a ticket `done` without required validation evidence or a documented test exception.
Use `foreman tickets complete <id> --validation-result passed --evidence "..."`.

## New work policy
Newly discovered work belongs in the Discovered Future Work Inbox.
Use `foreman tickets discover --summary "..." --rationale "..."`.

## Generated document policy
Do not manually edit generated sections of `docs/ticket-progress.md`.
Use the `foreman tickets` commands instead.

<!-- rafi:tracker-rules:start -->
## Native result protocol
When Rafi is running this project, submit the host-selected structured JSON result.
Use its declared summary, evidence, coverage, and continuity fields; do not append separate status markers.
Rafi binds the assigned ticket identity and controls completion after independent QA.
Use `foreman tickets discover` for newly discovered work during a build run.
<!-- rafi:tracker-rules:end -->

## LLM_NEXT_QUEUE
<!-- LLM_NEXT_QUEUE_START -->
_No remaining tickets. All work is complete or no tickets have been defined._
<!-- LLM_NEXT_QUEUE_END -->

## Active Ticket Status
<!-- ACTIVE_TICKET_STATUS_START -->
_No active tickets._
<!-- ACTIVE_TICKET_STATUS_END -->

## Blocked Tickets
<!-- BLOCKED_TICKETS_START -->
_No blocked tickets._
<!-- BLOCKED_TICKETS_END -->

## Recently Completed Context
<!-- RECENTLY_COMPLETED_CONTEXT_START -->
_No recently completed tickets pinned for context._
<!-- RECENTLY_COMPLETED_CONTEXT_END -->

## Discovered Future Work Inbox
<!-- DISCOVERED_FUTURE_WORK_START -->
_No discovered future work items._
<!-- DISCOVERED_FUTURE_WORK_END -->

## Review Recommendations
<!-- REVIEW_RECOMMENDATIONS_START -->
_No pending review recommendations._
<!-- REVIEW_RECOMMENDATIONS_END -->

## Archive Index
<!-- ARCHIVE_INDEX_START -->
_No archived tickets yet._
<!-- ARCHIVE_INDEX_END -->

## Last Validation Snapshot
| Timestamp | Scope | Result | Commands | Evidence | Notes |
|---|---|---|---|---|---|
| N/A | tracker | not_run | N/A | N/A | No validation snapshots recorded yet. |

## Work Log
<!-- WORK_LOG_START -->
| Timestamp | Actor | Ticket | Event | Old Status | New Status | Summary |
|---|---|---|---|---|---|---|
| 2026-11-03T02:10:21.565Z | foreman | T001 | complete | in_progress | done | Scripted fixture completed |
| 2026-11-03T02:10:19.738Z | foreman | T001 | update | planned | in_progress | Starting branch feature/t001-add-feature |
<!-- WORK_LOG_END -->

## Four-Pass Validation Checklist

Run `foreman tickets validate` to execute all passes.

1. **Schema & source** — config.yaml, tickets.yaml schema, unique IDs/orders, valid deps, no cycles.
2. **State** — SQLite migrations applied, all state ticket_ids exist in tickets.yaml, done tickets have evidence.
3. **Queue** — correct length, contiguous ranks, no done/canceled, sorted by order, blocked rows marked.
4. **Generated doc** — required sections and marker comments present, every queued ticket in Active Status.
