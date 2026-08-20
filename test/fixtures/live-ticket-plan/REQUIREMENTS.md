# Guided ticket-plan acceptance requirements

Use the source name `live-ticket-plan` and preserve every requirement ID below
in ticket `source_refs`. Do not create tickets beyond the three stable IDs named
here and in the existing tracker.

## REQ-EXPORT-FILTERED

Edit the existing `LIVE-CSV-EXPORT` ticket without replacing it. CSV export
must use the currently filtered task view and include labels and due dates.

## REQ-SAVED-VIEWS

Fold the existing future-work idea about named task views into a new ticket
with the exact ID `LIVE-SAVED-VIEWS`. Users can create, rename, apply, and
delete named views containing the current completion, label, and due-date
filters.

## REQ-SHARED-VIEWS

Create a second ticket with the exact ID `LIVE-SHARED-VIEWS`, depending on
`LIVE-SAVED-VIEWS`. Owners can generate read-only links for saved views. The
audience/access policy is intentionally unresolved and must be settled in the
standard interview. Link expiration is not part of this initial requirement.

## Agreed delivery and queue decisions

- Retain `LIVE-CSV-EXPORT` as existing next work and add both new tickets as
  next work.
- Mark the future-work inbox item as merged into `LIVE-SAVED-VIEWS`.
- Put the two new tickets in one delivery unit named `live-saved-views` using a
  shared branch, GitHub draft PR completion, squash merge, and cleanup.
- Keep repository build defaults unchanged and do not add supersessions.
