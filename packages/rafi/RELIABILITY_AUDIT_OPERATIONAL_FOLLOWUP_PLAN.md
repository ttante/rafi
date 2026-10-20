# Reliability audit operational follow-up plan

## Purpose

This plan covers only work not already specified in
`FULL_SYSTEM_RELIABILITY_AUDIT_IMPLEMENTATION_PLAN.md`.

That plan already covers the core instrumentation and records: lifecycle
timing, durable RED/GREEN evidence, contract traceability, snapshot costs,
QA-cycle causality, failure classification, provider comparison, logging
modes, retention limits, and adjacent-system audits. This document must not
create a second implementation of those features.

## Remaining gaps

The existing plan does not fully specify how operators will use the resulting
records, how older runs will be handled, or how the audit layer will be
validated and rolled out without changing build behavior.

The follow-up implementation must provide:

1. A stable inspection/export surface for audit records.
2. Explicit compatibility behavior for runs created before the audit schema.
3. Audit-health checks that expose incomplete evidence without blocking normal
   builds unnecessarily.
4. A staged rollout and rollback procedure.
5. Operator documentation explaining what each result means and what action is
   safe.

This work begins only after the main plan has established the canonical event,
run, evidence, snapshot, and report schemas. Until then, implement interfaces
and fixtures against explicit test doubles rather than inventing parallel
storage models.

## 1. Audit inspection and export surface

### Design

Add a read-only CLI/API surface over the canonical audit records and reports.
It must accept a project and run selection without requiring users to know
internal database IDs.

Minimum operations:

- show a run summary and final outcome;
- show the lifecycle timeline with phase durations;
- show QA cycles and their causal chains;
- show evidence gaps and their impact;
- show requirement traceability;
- show snapshot and provider timing summaries;
- export a bounded JSON or Markdown report for one run;
- identify whether the report is complete, partial, or unavailable.

### Safety requirements

- Read-only by default; inspection cannot mutate tickets, runs, or evidence.
- Apply the same redaction, authorization, and bounded-disclosure rules as the
  storage layer.
- Never print raw provider transcripts by default.
- Never treat a missing diagnostic record as a successful result.
- Make the selected run and logging mode visible in the output.
- Avoid requiring a raw `run_id` when an unambiguous project/run selector is
  available; allow the ID as an advanced option.

### Tests

- select the latest, a named, and an explicitly identified run;
- distinguish no run, ambiguous selection, and unavailable evidence;
- verify read-only behavior;
- verify output limits and redaction;
- verify Markdown and JSON contain the same facts;
- verify concurrent runs cannot leak records into one another.

## 2. Pre-audit run compatibility

### Design

Define behavior for databases and runs created before the new audit schema:

- existing correctness-critical records remain readable;
- missing audit fields are represented as `unknown` or `unavailable`, never as
  fabricated values;
- old runs may receive a migration/schema version but are not retroactively
  claimed to have evidence that was never captured;
- new runs always use the current schema and logging-mode record;
- reports identify the audit coverage level of the run.

Do not backfill provider timing, RED/GREEN evidence, snapshot identity, or
causal links from guesses or conversation text.

Migrations must be additive and transactional. Before changing a project
database, create the existing recoverable backup/rollback point used by the
project; never reset tickets, runs, or evidence as part of migration. If a
migration cannot preserve existing recovery records, leave the database
unchanged and report the incompatibility clearly.

### Tests

- open a pre-audit database and inspect old run/ticket state;
- migrate it without losing recovery or correctness records;
- generate a partial-coverage report;
- resume an old run and verify new events use the current schema;
- reject incompatible future schema versions clearly.

## 3. Audit-health and completeness checks

### Design

Add a host-side audit-health calculation separate from build correctness. It
should report:

- missing required evidence;
- incomplete diagnostic spans;
- dropped trace events or exhausted budgets;
- failed cleanup or retention actions;
- broken parent/child event links;
- records with unknown timing or exit status;
- evidence that is present but no longer accessible.

Classify each result as:

- `complete` — required audit facts are present;
- `partial` — the build result is valid but diagnostics are incomplete;
- `blocked` — a correctness-critical QA or recovery decision lacks required
  host evidence;
- `corrupt` — records violate an invariant and require investigation.

This check must not turn optional diagnostic gaps into build failures. It may
block only the specific QA/recovery decision that the missing evidence makes
unsafe, matching the failure semantics in the main plan.

### Tests

- healthy complete run;
- optional trace loss in `summary` mode;
- missing required RED/GREEN evidence;
- failed handoff acceptance record;
- broken causal link;
- failed cleanup;
- audit-health output remains distinct from the build outcome.

## 4. Staged rollout and rollback

### Rollout stages

1. Land schema and read-only readers behind internal interfaces.
2. Run fake-provider and migration tests with logging `off`, `summary`, and
   `trace`.
3. Enable `summary` for disposable live runs and compare report completeness
   and overhead.
4. Enable `trace` only for explicitly selected diagnostic runs.
5. Run parallel disposable Claude/Codex journeys and verify isolation.
6. Publish only after correctness, boundedness, and package-install checks
   pass.

### Rollback

- Changing the logging mode to `off` must preserve correctness-critical state.
- A disabled report reader must not affect build execution.
- A failed migration must leave the original database recoverable.
- New audit records must be ignorable by older readers where practical, or
  the package must fail with a clear compatibility message.
- Rollback must not delete evidence or reset tickets/runs.

## 5. Operator documentation and decision guidance

Document concise answers to:

- what `complete`, `partial`, `blocked`, and `corrupt` mean;
- when a user should resume, rerun with trace logging, amend a contract, or
  stop and investigate;
- which evidence is host-owned and trustworthy;
- which bounded excerpts may be disclosed;
- how long diagnostic records remain available;
- how to compare Claude and Codex without treating one run as proof;
- how to report a suspected timing or state-attribution bug.

Documentation must not introduce a new build requirement, documentation
contract, or mandatory user step.

## 6. Verification matrix

Before declaring this follow-up complete, verify:

- the main audit plan’s schemas and instrumentation are the only source of
  truth;
- the inspection surface is read-only and bounded;
- old databases remain usable with honest coverage labels;
- audit-health results do not masquerade as build results;
- logging-off behavior preserves QA, recovery, and completion semantics;
- concurrent Claude/Codex reports remain isolated;
- migration, package build, targeted tests, and publish-time tests pass;
- a fresh live run can produce and export a useful report without exposing
  unrestricted provider output.

## Implementation order

1. Wait for the canonical records from the main plan, then define report/query
   interfaces against those records.
2. Implement run selection and bounded read-only export.
3. Implement pre-audit coverage labels and migration compatibility.
4. Implement audit-health checks.
5. Add rollout/rollback tests and package compatibility checks.
6. Write operator documentation and run the verification matrix.

## Non-goals

This plan does not duplicate or expand:

- lifecycle span instrumentation;
- RED/GREEN capture;
- QA-cycle ledger construction;
- snapshot timing;
- provider performance measurement;
- retention policy design;
- independent QA or contract semantics.

Those remain governed by
`FULL_SYSTEM_RELIABILITY_AUDIT_IMPLEMENTATION_PLAN.md`.
