# Todo app feature decisions

Implement these three independent, decision-complete features. Do not ask for
product clarification; use the existing React/FastAPI/PostgreSQL patterns.

## F-LABELS

Users can create, rename, assign, and remove colorless text labels. A task can
have zero or more labels. Labels are unique case-insensitively. The list and
detail responses expose labels, and label filtering matches any selected label.

## F-DUE-DATES

Tasks have an optional due date (date, no time zone). It is editable from the
task form and rendered in the list. Overdue incomplete tasks are visibly
flagged. Clearing a due date is supported.

## F-COMPLETION-FILTERS

The list supports all, active, and completed filters. Filters compose with
label filtering and preserve the existing sort order. Completion remains
idempotent and is covered by API and frontend tests.
