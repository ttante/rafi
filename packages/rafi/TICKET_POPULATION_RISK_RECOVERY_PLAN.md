# Ticket Population Risk-Plan Recovery Proposal

## Status

Proposal only. This document describes the intended product and implementation
behavior; it does not make the described changes.

## Objective

Make initial ticket population resilient when generated tickets fail ticket
policy, especially when Medium- or High-risk tickets lack a rollback or
mitigation plan. The flow must retain quality controls while giving the user
clear, safe paths to repair, review, or explicitly accept a narrowly scoped
exception.

The desired outcomes are:

1. Rafi normally fixes repairable generated-ticket defects before surfacing an
   error to the user.
2. A user can repair already-published tickets without rewriting unrelated
   ticket content.
3. A user can explicitly proceed with a temporary, visible, auditable waiver
   when that is their decision.
4. Failed or interrupted population never loses the interview or produces
   silently inconsistent ticket, state, and waiver data.
5. The repeatable online gate proves the actual `create` through `start` path,
   including `tickets populate`.

## Current findings

The authoritative ticket validation currently rejects a ticket when:

```ts
(ticket.risk === "Medium" || ticket.risk === "High") && !ticket.rollback
```

The current diagnostic says that rollback or mitigation *notes* are required,
but the implementation accepts only a non-empty `rollback` field. `notes` may
provide additional context but does not satisfy the rule.

Ticket-maker instructions list `rollback` and `notes` as fields, but do not
state the risk-dependent requirement. Their example permits `rollback: null`
for every risk level. Ticket population validates the generated proposal and
then materializes it immediately; there is no proposal-repair turn before the
failure is surfaced.

The existing reusable online incident journey performs create, plan, ticket
setup, ticket plan, and start, but does not execute `rafi tickets populate`.
Manual provider runs provide useful evidence, but they are not a repeatable
end-to-end proof of the population path.

## Product policy

### Precise rule

Medium- and High-risk tickets require a meaningful rollback or mitigation plan
in `rollback`.

Use an accurate diagnostic such as:

> `T004` is Medium risk and needs a rollback or mitigation plan in `rollback`.
> Describe how to undo the change or limit harm if deployment fails.

Assign it a stable code:

```text
ticket.risk.rollback_required
```

`notes` cannot satisfy this rule. The policy should not add subjective
quality enforcement in its first release: an existing non-empty rollback value
passes unless and until a separately specified quality rule is introduced.

### Structured diagnostics

The validator remains the source of truth. It should expose structured
diagnostics rather than requiring other flows to parse human-readable strings:

```ts
type TicketDiagnostic = {
  code: string;
  severity: "error" | "warning";
  ticketId?: string;
  path: string;
  message: string;
  repairability: "automatic" | "manual" | "not_repairable";
  waiverEligible: boolean;
};
```

This shared representation must be used by ticket planning, population,
imports, recommendations that become tickets, validation, repair, and start
preflight. Structural defects—such as duplicate IDs, invalid dependencies, or
invalid YAML—remain blocking and are not silently waived.

## Generation and correction flow

### Teach the requirement before generation

Before the initial ticket-maker provider call, put the rule directly in the
generation instruction and schema examples:

```text
For every Medium or High risk ticket:
- `rollback` is required.
- Describe a concrete rollback or mitigation action.
- Do not write a generic statement such as "revert changes" unless it names
  what is reverted and how recovery or impact is verified.
```

Show both a valid Low-risk example with `rollback: null` and a valid
Medium-risk example containing a concrete `rollback` plan. Apply this
instruction consistently to both `tickets plan` and `tickets populate`.

### Validate after each generated proposal

There is no proposal to preflight before generation. The correct sequence is:

1. Generate a proposed ticket set.
2. Validate it in memory before materialization or publication.
3. If all failures are designated repairable proposal-quality failures, send
   the failed tickets and exact structured diagnostics to the ticket maker.
4. Revalidate the corrected proposal.
5. Allow two correction turns after the initial generation, then enter recovery
   if it still fails.

The correction request is response-only. It must preserve IDs, source-item
mappings, scope, ownership, dependency structure, acceptance criteria, and
every unaffected field. It may modify only fields required by listed
diagnostics. For example:

```text
Correct only the listed fields for these tickets. Do not change ticket IDs,
source mappings, dependencies, scope, ownership, or acceptance criteria unless
the diagnostic specifically requires it.

T004:
- ticket.risk.rollback_required: Medium-risk tickets require `rollback`.
```

Automatic correction must not rerun ticket decomposition or the planning pass.
If the available context is insufficient to write a credible plan, the ticket
maker should return a manual-review condition rather than inventing certainty.

## Recovery after correction is exhausted

Persist the interview, proposal, diagnostics, and correction history before
presenting recovery. In an interactive terminal, offer:

```text
Ticket population needs attention.

6 tickets were generated; 4 need a rollback or mitigation plan:
  T002, T004, T005, T006

Choose an action:
  1. Repair all affected tickets with Ticket Maker (recommended)
  2. Publish with explicit risk-note waivers
  3. Review/edit manually, then revalidate
  4. Cancel and keep this population session unchanged
```

Option 1 may initiate another explicitly requested targeted repair attempt and
must display a concise ticket-by-ticket diff before applying substantive
changes. It still must not alter mappings, IDs, dependencies, or unrelated
content.

Option 2 requires the user to provide a reason and explicitly confirm
publication. It must never be selected by `--yes`.

Option 3 shows exact ticket IDs, paths, diagnostics, and the saved proposal or
session location.

Option 4 changes nothing.

Outside an interactive terminal, fail safely and print exact next commands. A
noninteractive waiver requires explicit ticket IDs and a non-empty rationale:

```bash
rafi tickets populate --interview-id <id> \
  --waive-risk-notes T001,T004 \
  --waiver-reason "Accepted during initial backlog triage"
```

There must be no global `--ignore-validation` switch and no implicit waiver
through `--yes`.

## Waiver model

A waiver is not a generic validation bypass. It is a durable record associated
with one exact diagnostic on one exact ticket definition:

```yaml
ticket_id: T004
diagnostic_code: ticket.risk.rollback_required
ticket_definition_digest: <hash>
reason: Accepted during initial backlog triage
actor: <local user or configured identity>
created_at: <timestamp>
run_id: <population run>
```

An active matching waiver changes only this diagnostic from error to warning.
It does not suppress other failures. Changing the ticket definition or its risk
level invalidates the digest and invalidates the waiver automatically.

`rafi tickets validate` must report the warning honestly, for example:

```text
[pass 1] [warn] T004: missing rollback/mitigation plan — explicitly waived by tyler on …
```

`tickets queue`, `tickets show`, and `start` must visibly surface active
waivers. Users must be able to list and revoke them.

### Starting implementation with a waiver

An active waiver permits progress, but should not become invisible precisely
when risk becomes operational:

- In an interactive terminal, `rafi start` displays affected ticket IDs and
  waiver reasons and requires an explicit confirmation before starting a waived
  selected ticket.
- In noninteractive mode, `rafi start` requires an explicit
  `--allow-risk-waivers` flag when selected work has active waivers.
- A future project policy may make waived tickets categorically ineligible for
  start, but that is not required for the initial implementation.

## Publication consistency and recovery

Ticket YAML, ticket state, and waiver records may reside in separate storage
systems. Do not claim a single database transaction if the implementation
cannot atomically commit filesystem and database writes together.

Instead, provide a durable publication/recovery protocol:

1. Stage proposed YAML, state updates, and waiver records in recoverable
   temporary artifacts.
2. Write a durable pending-publication record describing the transaction.
3. Promote the staged artifacts in a defined, idempotent order.
4. Mark the transaction committed only after every promotion succeeds.
5. On the next relevant Rafi command, detect a pending transaction and safely
   complete or roll it back.

The user-facing guarantee is atomic publication: no published ticket data
without corresponding state and waiver records, and no orphaned waiver record.
Interrupted repair and population must be recoverable.

## Repair command for existing tickets

Keep `rafi doctor` diagnostic and read-only. Add a focused command instead:

```bash
rafi tickets repair --risk-notes
rafi tickets repair --risk-notes --apply
```

The first form scans and proposes only. It lists affected tickets, calls the
ticket maker only for missing risk-plan fields, and shows a ticket-by-ticket
diff. The apply form requires explicit user approval after the diff.

The repair command may change only the needed `rollback` fields. It must not
rewrite ticket IDs, titles, scope, dependencies, ownership, risk, acceptance
criteria, or unrelated ticket content. A waiver is removed only after the
replacement field passes validation. The repair path uses the same durable
publication/recovery protocol as population.

## Test and release gates

### Unit and CLI coverage

Tests must cover at least:

- Low-risk tickets may omit `rollback`.
- Medium/High tickets without `rollback` emit
  `ticket.risk.rollback_required`.
- `notes` alone does not satisfy the rule.
- A valid non-empty rollback value passes the initial objective policy.
- Ticket-maker instructions contain the requirement and a correct example.
- A missing risk plan is corrected before materialization.
- Correction preserves IDs, mappings, dependencies, and unaffected content.
- Correction exhaustion reaches repair, waiver, manual-review, and cancel
  recovery paths.
- Cancel preserves the saved proposal and session.
- Repair is preview-first, narrowly scoped, and recoverable on interruption.
- Waivers require exact IDs and a rationale.
- A waiver applies only to its exact diagnostic and definition digest.
- Editing a waived ticket invalidates the waiver.
- Users can list and revoke waivers.
- Unwaived and non-waivable defects still block normal publication.
- Interactive start requires confirmation for selected waived tickets.
- Noninteractive start requires `--allow-risk-waivers`.

### Online end-to-end gate

Add a repeatable live journey that executes and asserts:

```text
rafi create
→ rafi plan
→ rafi tickets setup:init
→ rafi tickets populate
→ rafi tickets validate
→ rafi tickets queue
→ rafi start
```

It must request at least one Medium-risk change and verify that the resulting
ticket has a non-empty risk plan and that validation is clean without a waiver
in the ordinary case.

For the recovery branch, use a deterministic fixture or controlled provider
scenario. Do not rely on a live model randomly omitting a field; that would
make the regression gate flaky. The controlled case must verify that correction
or recovery behaves as designed.

Until this exists, do not label a canary that skips `tickets populate` as a
full create-to-start end-to-end test.

## Suggested delivery order

1. Correct the diagnostic text, code, and ticket-maker instructions.
2. Introduce shared structured diagnostics across ticket creation and
   validation paths.
3. Implement in-memory validation and bounded targeted correction before
   materialization.
4. Save recovery state and implement the interactive/noninteractive recovery
   paths.
5. Implement digest-bound waivers, reporting, listing, revocation, and start
   safeguards.
6. Implement the durable cross-store publication/recovery protocol.
7. Add `rafi tickets repair --risk-notes` on that same protocol.
8. Add focused automated coverage and the full online journey.
9. Update CLI documentation with normal, repair, manual-review, waiver, and
   waiver-revocation examples.

## Acceptance standard

Under ordinary conditions, a user never encounters a raw validation dead end:
Rafi teaches the ticket maker the policy, corrects repairable defects before
publication, and gives clear recovery choices when correction cannot finish.

When a user consciously accepts incomplete risk planning, Rafi permits that
specific decision only with explicit, visible, auditable scope. It remains
visible in validation, queue, ticket display, and start; it is invalidated by a
ticket change; and it never suppresses unrelated defects.
