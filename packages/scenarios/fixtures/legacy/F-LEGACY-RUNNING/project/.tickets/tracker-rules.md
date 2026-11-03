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
