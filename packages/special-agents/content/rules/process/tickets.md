---
name: tickets
category: process
description: "Ticket log expectations when no external tracker is configured."
condition: always
template: false
supersededByForeman: true
---
## Ticket Tracking

- Maintain `docs/tickets.md` as the source of truth if no external tracker is configured.
- Break work into epics, stories, and implementation tickets where useful.
- Every ticket should include: ID, title, status, priority, user/business value, acceptance criteria, implementation notes, test expectations, and links to related docs or code when available.
- Valid statuses: `Backlog`, `Ready`, `In Progress`, `Blocked`, `In Review`, `Done`, `Won't Do`.
- Add discovered follow-up work, deferred improvements, risks, and future ideas to the ticket log instead of leaving them only in chat.
- When completing a ticket, mark it `Done` and summarize what changed.

