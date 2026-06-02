# Ticket Progress Tracker Template

Copy this file to `docs/ticket-progress.md` in a project and replace placeholders before use. Keep the section names and marker comments stable so humans, scripts, and LLM builders can parse the tracker consistently.

## Purpose
This file is the operational build tracker for humans and LLM builders. It records active ticket status, implementation order, timestamps, blockers, validation evidence, and future work. It is optimized so an LLM can answer "what are the next X tickets?" by reading one small queue instead of scanning the full backlog.

## Improvements Added From Tracker Review
This template keeps the original queue-first workflow and adds fields that make the tracker easier to reuse across apps:
- Tracker metadata for app name, backlog path, archive path, queue limit, timezone, and template version.
- `Title`, `Area`, `Owner`, `Risk`, and `Evidence` fields so tickets are understandable without opening the full backlog first.
- A dedicated `Blocked Tickets` table so blockers are easy to scan and resolve.
- A `Discovered Future Work Inbox` so new ideas are captured without immediately disrupting implementation order.
- An `Archive Index` so reset/completed work is findable without bloating the active tracker.
- A four-pass validation checklist so future LLM builders can check queue shape, cross-table consistency, implementation readiness, and tracker hygiene.
- Optional automation gates that can be turned into CI checks when the project is ready.

## Tracker Metadata
<!-- TRACKER_METADATA_START -->
| Field | Value | Notes |
|---|---|---|
| App Name | `<APP_NAME>` | Human-readable app or repository name. |
| Canonical Backlog | `docs/tickets.md` | Source of truth for full stories and ticket definitions. |
| Progress Tracker | `docs/ticket-progress.md` | This operational tracker after the template is copied into a project. |
| Archive File | `docs/ticket-archive.md` | Destination for old `done` and `canceled` tickets after reset. |
| Queue Limit | `50` | Keep `LLM_NEXT_QUEUE` filled with the next 50 remaining tickets, or all remaining if fewer than 50 exist. |
| Timezone | `<IANA_TIMEZONE>` | Example: `America/Chicago`. Use this for every timestamp. |
| Timestamp Format | ISO 8601 with offset | Example: `2026-05-25T13:11:35-05:00`. |
| Template Version | `1.0.0` | Increment when tracker structure changes. |
| Last Structural Review | `<YYYY-MM-DD>` | Date the tracker format was last reviewed. |
<!-- TRACKER_METADATA_END -->

## Ground Rules For LLM Builders
1. Start with `LLM_NEXT_QUEUE`; do not scan the full backlog to choose next work unless the queue is empty or the user explicitly asks for broader planning.
2. Treat `docs/tickets.md` as the canonical backlog and this file as the operational status view.
3. Never mark a ticket `done` without required tests, validation evidence, or a documented reason why tests are not applicable.
4. If a ticket status changes, update `LLM_NEXT_QUEUE`, `Active Ticket Status`, and `Work Log` in the same edit.
5. If a blocker is discovered, update the ticket status to `blocked`, fill `Blocked By`, and add or update the row in `Blocked Tickets`.
6. If new work is discovered, add it to `Discovered Future Work Inbox` first unless it already has an approved ticket ID and implementation order.
7. Preserve all marker comments. Automation and LLM builders rely on them.

## How To Pick The Next X Tickets
1. Read only the `LLM_NEXT_QUEUE` block first.
2. To answer "what are the next X tickets?", return the first `X` rows in rank order and include blocker information when present.
3. To implement work immediately, choose the first rows where `Status` is `next` and `Blocked By` is `None`.
4. Do not implement blocked rows unless the user explicitly approves handling the blocker first.
5. Do not scan archived tickets to choose next work unless the active queue is empty or the user explicitly asks for history.

## Required Queue Maintenance Rule
Every time any ticket status table is updated, the `LLM_NEXT_QUEUE` block must also be reviewed and updated. Keep it filled with the next 50 remaining tickets in correct implementation order. If fewer than 50 tickets remain, include all remaining tickets.

Queue rows must satisfy these invariants:
- Ranks start at `1` and increase by `1` without gaps.
- No `done` or `canceled` tickets appear in `LLM_NEXT_QUEUE`.
- Every ticket in `LLM_NEXT_QUEUE` has a matching row in `Active Ticket Status`.
- Every queue row has `Status`, `Priority`, `Depends On`, `Blocked By`, `Next Action`, `Required Tests`, and `Likely Files`.
- `Blocked By` is `None` only when the ticket is actually eligible for implementation.
- If a ticket is blocked by another ticket, the dependency must be visible in `Depends On`, `Blocked By`, or both.

## Ticket Reset And Archive Policy
Use ticket reset to keep the active table small and useful. When tickets are `done` or `canceled` and no longer need to stay in active context, move them out of `Active Ticket Status` into `docs/ticket-archive.md` or the configured archive file.

Archive by lifecycle state, not by MVP vs post-MVP category.

Current archive state:
- The canonical backlog remains in `docs/tickets.md` for reference.
- This tracker should keep only active, next, in-progress, blocked, and recently completed tickets needed for current planning.
- Completed tickets should stay here only when they provide important immediate context for remaining work.
- Archived tickets should retain ticket ID, title, final status, completion/cancel timestamp, validation evidence, and links to relevant PRs or commits when available.

## Timestamp Policy
- Use the project timezone from `Tracker Metadata`.
- Use ISO 8601 timestamps with UTC offset.
- Update `last_worked_at` whenever a ticket is touched.
- Set `completed_at` only when acceptance criteria and validation are actually done.
- Use `pre-tracker` only for historical work completed before this tracker existed and only when exact time cannot be recovered.

## Status Values
| Status | Meaning | Queue Eligible |
|---|---|---:|
| `next` | Eligible upcoming work in implementation order. | Yes |
| `in_progress` | Currently being implemented. | Yes |
| `blocked` | Cannot proceed without external input, dependency, or decision. | Yes, but not implementable until unblocked |
| `planned` | Accepted future work, not yet in the next execution window. | No, unless fewer than 50 remaining tickets exist |
| `done` | Implemented, validated, and documented. | No |
| `canceled` | Intentionally not doing. | No |

## Priority Values
| Priority | Meaning |
|---|---|
| `P0` | Blocks the product, release, security posture, data integrity, or core developer workflow. |
| `P1` | Required for the current buildout milestone or core reliability. |
| `P2` | Important follow-up, hardening, or usability improvement. |
| `P3` | Nice-to-have or opportunistic work. |

## Size Values
| Size | Expected Effort |
|---|---|
| `XS` | Small doc, config, copy, or narrowly scoped test update. |
| `S` | Focused implementation usually contained to one area. |
| `M` | Multi-file implementation with tests. |
| `L` | Multi-system implementation or migration with broader test coverage. |
| `XL` | Too large for one ticket; split before implementation. |

## Risk Values
| Risk | Meaning |
|---|---|
| `Low` | Localized change with straightforward rollback. |
| `Medium` | Cross-cutting change, schema/API impact, or notable UX behavior. |
| `High` | Security, data loss, migration, billing, privacy, availability, or major architectural impact. |

## Cross-Cutting Review Checklist
Every ticket should be reviewed against these concerns before it is added to `LLM_NEXT_QUEUE`. If a concern does not apply, write `N/A` in the ticket notes or acceptance criteria rather than leaving it ambiguous.

| Concern | Required Question | Where To Record It |
|---|---|---|
| Testability | What failing test proves the ticket is needed, and what validation proves it is done? | `Required Tests`, `Acceptance / Test Gate`, `Last Validation Snapshot` |
| Logging | Does the change add, remove, or alter important execution paths that need structured logs? | `Future Work / Notes`, ticket acceptance criteria |
| Monitoring | Does the change affect health, SLOs, alerts, dashboards, or operational visibility? | `Required Tests`, `Evidence`, ticket acceptance criteria |
| Cost Management | Does the change affect API usage, model usage, storage, compute, queues, or third-party cost? | `Risk`, `Future Work / Notes`, ticket acceptance criteria |
| Performance | Does the change affect latency, throughput, query cost, bundle size, or memory usage? | `Risk`, `Required Tests`, ticket acceptance criteria |
| Security and Privacy | Does the change affect auth, authorization, secrets, user data, retention, audit logs, or abuse paths? | `Risk`, `Blocked Tickets` if review is needed |
| Data and Schema | Does the change require migration, backfill, retention, restore, or compatibility planning? | `Depends On`, `Risk`, `Future Work / Notes` |
| AI and Prompt Governance | Does the change affect prompts, models, evals, prompt versions, model routing, or generated output quality? | `Area`, `Evidence`, ticket acceptance criteria |
| Taxonomy and Contracts | Does the change affect controlled vocabulary, API contracts, event names, schemas, or artifact types? | `Area`, `Required Tests`, ticket acceptance criteria |
| Rollback | How can the change be disabled, reverted, or repaired if it fails? | `Future Work / Notes`, ticket acceptance criteria |
| Docs and Support | Does the change require user docs, runbooks, support playbooks, or release notes? | `Evidence`, `Future Work / Notes` |

## Last Validation Snapshot
Record the most recent validation runs. Keep this table short; detailed logs belong in CI, PRs, or release evidence.

| Timestamp | Scope | Result | Commands | Evidence | Notes |
|---|---|---|---|---|---|
| `<YYYY-MM-DDTHH:MM:SS-OFFSET>` | `<scope>` | `passed/failed/not run` | `<commands or N/A>` | `<PR/commit/log/doc link or N/A>` | `<notes>` |

## LLM_NEXT_QUEUE
<!-- LLM_NEXT_QUEUE_START -->
| Rank | Ticket | Title | Status | Priority | Area | Depends On | Blocked By | Size | Risk | Next Action | Required Tests | Evidence | Likely Files |
|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | T1.1 | Example Foundation Ticket | next | P0 | Platform | None | None | M | Medium | Write failing smoke test, then implement local health endpoint. | Unit: health parser; Integration: service health smoke. | N/A until implemented. | `api/*`, `tests/*` |
| 2 | T1.2 | Example Dependent Ticket | blocked | P1 | UI | T1.1 | T1.1 | S | Low | Wait for T1.1 health contract, then add UI status indicator. | Component test; API proxy test. | N/A until implemented. | `web/*`, `tests/*` |
<!-- LLM_NEXT_QUEUE_END -->

Template usage:
- Replace example rows with real remaining tickets.
- Keep at most 50 queue rows.
- If fewer than 50 remaining tickets exist, include all remaining tickets.
- Keep ticket order aligned with canonical implementation order.

## Active Ticket Status
| Ticket | Title | Status | Priority | Area | Owner | last_worked_at | completed_at | Depends On | Blockers | Next Action | Acceptance / Test Gate | Evidence | Future Work / Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| T1.1 | Example Foundation Ticket | next | P0 | Platform | `<owner or role>` | `<timestamp>` |  | None | None | Write failing smoke test, then implement local health endpoint. | Health smoke passes; regression test added first. | N/A until implemented. | Replace with real ticket data. |
| T1.2 | Example Dependent Ticket | blocked | P1 | UI | `<owner or role>` | `<timestamp>` |  | T1.1 | T1.1 | Wait for T1.1 health contract, then add UI status indicator. | Component and proxy tests pass. | N/A until implemented. | Shows how to represent blocked work. |

## Blocked Tickets
Keep this table focused on active blockers that need attention. Remove rows when unblocked and record the change in `Work Log`.

| Ticket | Blocked By | Blocker Type | Owner | First Blocked At | Last Checked At | Needed Decision / Action | Unblock Criteria | Notes |
|---|---|---|---|---|---|---|---|---|
| T1.2 | T1.1 | dependency | `<owner or role>` | `<timestamp>` | `<timestamp>` | Complete T1.1 health contract. | T1.1 is `done` and health contract is documented. | Example row; replace or remove. |

Blocker types:
- `dependency`: waiting on another ticket.
- `decision`: waiting on product, architecture, security, or technical choice.
- `external`: waiting on vendor, account, credential, environment, or third-party service.
- `investigation`: blocked by unknown root cause.
- `capacity`: intentionally paused due to sequencing or staffing.

## Recently Completed Context
Keep only completed tickets that are useful context for upcoming work. Move older completed work to the archive during ticket reset.

| Ticket | Title | completed_at | Validation | Evidence | Why It Remains Here |
|---|---|---|---|---|---|
| T0.1 | Example Completed Prerequisite | `<timestamp>` | Tests passed; docs updated. | `<PR/commit/doc link or N/A>` | Provides immediate context for T1.1. |

## Discovered Future Work Inbox
Use this for legitimate work discovered during implementation that is not yet inserted into the canonical backlog or queue.

| Discovered At | Source Ticket | Proposed Ticket | Priority Guess | Area | Summary | Rationale | Needs Decision From | Disposition |
|---|---|---|---|---|---|---|---|---|
| `<timestamp>` | `<ticket or N/A>` | `<ticket id or TBD>` | `P0/P1/P2/P3` | `<area>` | `<summary>` | `<why it matters>` | `<owner/role or None>` | `triage/accepted/rejected/merged/queued` |

Disposition values:
- `triage`: needs review.
- `accepted`: should be added to canonical backlog.
- `rejected`: intentionally not doing.
- `merged`: folded into another ticket.
- `queued`: added to `LLM_NEXT_QUEUE` and `Active Ticket Status`.

## Archive Index
Use this section to point to archived lifecycle records without forcing LLM builders to scan old work during normal planning.

| Archive File | Scope | Last Updated | Notes |
|---|---|---|---|
| `docs/ticket-archive.md` | Done and canceled tickets moved out of active context. | `<timestamp or N/A>` | Create this file when the first reset occurs. |

## Work Log
Append one row for each meaningful tracker update. Keep summaries short but specific.

| Timestamp | Ticket | Status Change | Summary | Validation | Evidence |
|---|---|---|---|---|---|
| `<timestamp>` | T1.1 | `planned -> next` | Added ticket to next queue and active status. | Not run; tracker-only update. | N/A |

## Standard Update Workflow
Use this workflow whenever implementation or planning changes the tracker.

1. Identify changed tickets and their new status.
2. Update `Active Ticket Status`.
3. Update `Blocked Tickets` if any ticket is blocked or unblocked.
4. Update `Recently Completed Context` only for completed work that helps upcoming implementation.
5. Move stale `done` or `canceled` tickets to the archive when active context is too large.
6. Rebuild `LLM_NEXT_QUEUE` with the next 50 remaining tickets, or all remaining tickets if fewer than 50 exist.
7. Add a `Work Log` entry.
8. Add or update `Last Validation Snapshot` when validation commands were run.
9. Run the four-pass validation checklist below before final response or commit.

## Four-Pass Validation Checklist
Run these checks every time this file is updated.

Pass 1: Queue shape
- `LLM_NEXT_QUEUE` exists with `LLM_NEXT_QUEUE_START` and `LLM_NEXT_QUEUE_END` markers.
- Queue has 50 rows, or all remaining tickets if fewer than 50 remain.
- Ranks are sequential and start at `1`.
- Queue contains no `done` or `canceled` tickets.

Pass 2: Cross-table consistency
- Every queued ticket appears in `Active Ticket Status`.
- Every `blocked` queued ticket appears in `Blocked Tickets`.
- `Depends On` and `Blocked By` values match the ticket's current state.
- `last_worked_at` changed for every touched ticket.

Pass 3: Implementation readiness
- The first implementable ticket has `Status` = `next` and `Blocked By` = `None`.
- Every queued ticket has a concrete `Next Action`.
- Every queued ticket has `Required Tests`.
- High-risk tickets include risk notes, validation expectations, and rollback or mitigation notes in `Future Work / Notes`.

Pass 4: Hygiene and history
- `Work Log` has an entry for the update.
- `Last Validation Snapshot` reflects the latest validation run or explicitly says `not run`.
- Old `done` and `canceled` tickets have been archived or intentionally kept in `Recently Completed Context`.
- No app-specific placeholder rows remain after project setup, except intentional examples in template files.

## Optional Automation Gates
Projects should add a lightweight parser or CI gate when possible.

Recommended checks:
- Validate `LLM_NEXT_QUEUE` row count is `min(50, remaining_ticket_count)`.
- Validate queue ranks are sequential.
- Validate queued tickets exist in `Active Ticket Status`.
- Validate queue contains no `done` or `canceled` statuses.
- Validate blocked queue rows have corresponding `Blocked Tickets` rows.
- Validate required columns are present.
- Validate timestamps match project format.
- Validate every `done` ticket has validation evidence or an explicit test exception.

## Update Checklist For Future Builders
- Update `Active Ticket Status` before the final response whenever any ticket status changes.
- Update `LLM_NEXT_QUEUE` every time `Active Ticket Status` changes.
- Keep `LLM_NEXT_QUEUE` filled with the next 50 tickets in implementation order, or all remaining tickets if fewer than 50 remain.
- If a ticket is touched but not completed, update `last_worked_at`, status, blocker, and next action.
- If a new future task is discovered, add it to `Discovered Future Work Inbox` or insert it into `LLM_NEXT_QUEUE` and `Active Ticket Status` when accepted.
- Move old `done` or `canceled` tickets out of active status during ticket reset.
- Archive by lifecycle state, not by MVP/post-MVP category.
- Never mark `done` without tests or a documented reason why tests are not applicable.
- Keep marker comments stable.
