# Online end-to-end investigation findings — 2026-10-13

## Scope and safety

Requested profile: **online-only, Claude first, then Codex**. Real authenticated
provider CLIs were used only against disposable local Git fixtures under
`/private/tmp/rafi-online-e2e-20261013`. No original MoneyTree/MoneyFarm
repository, source checkout, remote Git repository, package registry, or
deployment was mutated. No package was published.

The required public journey was attempted in each fixture:

```text
rafi create . → rafi plan . → rafi tickets setup:init → rafi tickets plan → rafi start . --steps 2
```

The interactive literal `rafi create .` was attempted first. This execution
environment cannot keep a usable terminal-attached pseudo-TTY: macOS `script`
rejects the tool's socket-backed stdio, while the direct interactive process was
left waiting at the first prompt. Its saved create interview was preserved and
the owned process was gracefully stopped. The equivalent public setup command
was then completed on fresh fixtures with explicit disclosed defaults:

```text
rafi create . --defaults --no-graph --runtime <claude|codex>
```

This is an environment/harness limitation, not evidence that Rafi interactive
create is broken. Docker Compose is also absent, so the repository's Linux-only
live harness was not usable. The direct local-CLI online runs below are valid
provider integration evidence, but not a Docker/QA acceptance run.

## Results

| Provider | Create | Plan | Ticket planning | `start . --steps 2` |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.296 | Pass | Pass | **Fail** | Blocked: no tickets published |
| Codex CLI 0.162.1 | Pass | Pass | **Fail** | Blocked: no tickets published |

### O-E2E-001 — P1: ticket state enum is not validated before apply

**Observed with online Claude.** The planner returned a proposal with
`state_changes: [{ id: "T-001", status: "Ready", ... }]`. Rafi accepted it
through proposal validation, then failed during SQLite application:

```text
CHECK constraint failed: status IN
('planned','next','in_progress','blocked','done','canceled','obsolete')
```

No tickets were published; rollback worked and the saved `tickets-plan`
interview was retained. `rafi plan:doctor .` listed the session and its age,
but recovery repeated the same failure. The recovery prompt did not include the
apply-time constraint failure as a structured correction issue, so the provider
had no reliable reason to change `Ready`.

**Causal boundary.** `validateTicketPlanProposal` in
`packages/ai-foreman/src/ticketPlanning.ts` checks only that a state change
references a known ID and has a reason (around line 134). It does not check its
status against `TicketStatus`. `applyApprovedTicketPlan` then calls
`db.upsertState` (around line 234), where SQLite rejects it. The reported
`future work item undefined does not exist` follows the same apply-time gap:
future-work IDs are only checked at application around line 238, not against
the planning context during validation.

**Implementation instructions.**

1. Make proposal validation context-aware: pass current `TicketStatus` values
   and current future-work IDs from `readTicketPlanningContext` / the apply
   preimage into `validateTicketPlanProposal` (or a new pure contextual
   validator invoked by both extraction and pre-approval validation).
2. Reject invalid `state_changes.status` values with the allowed values in the
   error. Reject non-integer, absent, or nonexistent `future_work[].id` values
   before approval/application; validate disposition values too.
3. Run that validation in the existing bounded correction loop before host
   approval, preserving proposal text and normalized issues in the interview.
4. If apply can still fail due to a race or storage condition, persist an
   `apply-failed` checkpoint plus the normalized apply issue. Recovery must
   send that issue to the provider, re-read current tracker state, revalidate,
   and only then offer approval. Do not merely replay a saved proposal.
5. Add regression coverage for invalid state status, a nonexistent future-work
   ID, `undefined`/non-numeric future-work IDs, a stale ID disappearing between
   proposal and apply, rollback/no-publication, and successful `plan:doctor`
   recovery. Include actual CLI recovery with a scripted provider.

### O-E2E-002 — P1: `plan:doctor` cannot repair an apply-time ticket failure

The flagless command provides useful listing output, but its public
non-interactive recommendation is `rafi resume ... --id`, not a direct
repair command. Re-entering the saved ticket interview with Claude again failed
at the same constraint. The record retained only the generic failure summary;
its saved `validationIssues` was empty after proposal parsing passed.

**Resolution direction.** Implement the O-E2E-001 contextual validation first.
Then make recovery workflow-aware: `plan:doctor` can remain the primary
flagless entry point, but it must select ticket-plan sessions and invoke a
ticket-plan recovery path that carries the failed-apply diagnostic and current
state. Add `rafi tickets:doctor` (and/or `rafi tickets doctor`) only as a
documented compatibility alias if user research wants ticket-specific
discoverability; it must not fork recovery semantics. The ticket-oriented
surface must list age, failed operation, affected ticket/future-work reference,
whether any publication occurred, and the exact next action.

### O-E2E-003 — P1: noninteractive standard ticket planning can be derailed by
an unexpected provider question

**Observed with online Codex.** The first proposal had normal repairable
validation defects (source provenance and delivery unit field mismatch).
Rafi correctly retained the session and began a bounded correction. The
correction then returned:

```text
planner needs input: Grill-me: Approve this refreshed single-ticket proposal
```

despite `--no-grill-me --yes`. Rafi retained the session but no tickets were
published. This is safe, but it blocks automation and the public doctor flow
cannot resolve it noninteractively.

**Implementation instructions.** In the ticket-plan response state machine,
reject a `needs_input`/Grill-me marker that is incompatible with standard
noninteractive mode as a normalized correction issue. Send a response-only
retry instruction requiring a complete proposal and prohibiting questions;
consume one bounded correction attempt. If it still asks, fail with a durable,
plain-language `provider returned a question where noninteractive approval was
required` diagnostic, plus recoverable session. Regression-test the exact
marker under `--yes --no-grill-me` for Claude and Codex adapters.

### O-E2E-004 — P2: online Claude activity output is noisy and misleading

The Claude plan succeeded, but emitted repeated user-facing lines such as:

```text
rafi working: tool failed — claude — Bash
rafi working: tool failed — claude — Read
```

Some refer to absent exploratory paths; others are Bash sandbox initialization
failures. The planner recovered using other reads and completed. The output
does not classify the error, provide a reason, or distinguish an expected
absent probe from an execution failure; it looks like a failed Rafi run.

**Implementation instructions.** Preserve raw tool results and call identity,
but project only actionable errors to the normal activity line. Classify missing
read targets / expected exploratory misses as a compact `not found` or suppress
them when a later successful alternative read occurs. Classify sandbox launch
failure separately from a tool command failure, show a concise reason once,
and collapse repeated equivalent events. Keep terminal states and actual
provider failure visible; do not suppress genuine failed side effects. Add
online-shaped event fixtures plus a regression assertion that a successful plan
does not print repeated unqualified `tool failed` lines for recoverable probes.

## Consequence for the requested build test

`rafi start . --steps 2` was **not run**. Both real-provider journeys failed
before ticket publication, and hand-creating tickets would bypass the exact
create/plan/tickets chain under investigation. This is a legitimate P1 stop
condition, not a skipped test. After O-E2E-001 through O-E2E-003 are fixed,
rerun each provider from a fresh fixture with at least two independent tickets,
then run `rafi start . --steps 2`, including one QA-enabled and one controlled
QA-failure/remediation journey.

## Follow-up implementation — 2026-10-13

The first two P1 blockers have now been fixed and regression tested:

- Proposal validation now rejects unsupported `state_changes.status` values,
  malformed/non-integer future-work IDs, unsupported future-work dispositions,
  and future-work IDs absent from the current tracker. The same contextual
  checks run before approval and before publication, so no YAML/SQLite write is
  attempted for these planner defects.
- An unattended `tickets plan --yes --no-grill-me` run now treats an unexpected
  `needs_input` question as a bounded correction issue. It tells the provider
  to make the safest reasonable choice and return a complete proposal instead
  of attempting terminal input. The issue is retained in the saved interview
  if correction is exhausted.

Focused regression coverage passed: 14 tests in
`packages/ai-foreman/test/planning.test.ts` and
`packages/rafi/test/ticketPlanRecovery.test.ts`; both modified packages also
passed TypeScript checking. A fresh Claude retest fixture was created and
`rafi create . --defaults --no-graph --runtime claude` passed. The provider
plan call was interrupted by the external terminal harness before it produced a
Rafi terminal result, leaving its interview at `agent-run`; it is not counted
as a Rafi product failure. Continue the requested online retest from a fresh
terminal-attached run before updating the provider-result table.

## Evidence

Private raw evidence and disposable fixtures: `/private/tmp/rafi-online-e2e-20261013`.

- Claude plan session: `5efd881b-9eeb-4598-a869-130c08013b2c`.
- Claude failed ticket interview: `33d34e61-953a-4252-a1d7-687bc19d6c20`.
- Codex plan session: `01a136f4-0a05-79a3-9e07-bf9f374e85c6`.
- Codex failed ticket interview: `62a56bf6-a3b2-4507-b606-58c270c37326`.

The follow-up P1 changes above are working-tree implementation changes; they
have not been committed, published, or applied to external repositories.

## Live retest after P1 planner changes — 2026-10-13

This retest used fresh disposable Git fixtures and the locally rebuilt Rafi CLI
under Node 20.19.0. Both providers were authenticated real accounts, run in
sequence (Claude, then Codex). The source checkout, MoneyTree/MoneyFarm,
remote Git, package registries, and deployment targets were not mutated.

| Provider | Create | Plan | Ticket setup/population | Ticket validation | Build + QA |
| --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.296 | Pass | Pass | Pass, one valid ticket | Pass | Pass for its one available ticket |
| Codex CLI 0.162.1 | Pass | Pass | Pass, two valid tickets | Pass | Pass in two separate one-ticket runs; the requested `--steps 2` did not admit both together |

The planner-specific P1 failures were not reproduced. Claude ticket creation
produced a valid P2/Low ticket with tests and rollback; Codex produced two
valid P1/Medium tickets, each with required tests and rollback. `tickets
validate` passed in both fixtures. This is live evidence that the contextual
proposal validation and unattended correction work did not prevent a normal
provider path from completing planning and publishing tickets.

### O-E2E-005 — P1: `--steps N` silently caps a branch run at the first delivery unit

**Observed with live Codex.** The two-ticket fixture had independent `T001`
and `T002`, no dependencies, and this delivery file structure:

```text
farewell-unit -> [T001]
shout-unit    -> [T002]
```

`rafi start . --steps 2 --yes --dirty-work include` announced one branch for
one ticket, completed and QA-reviewed T001, and exited zero. `T002` remained
`next`. `rafi status .` then stated that the latest run was “still in progress
or did not finish,” despite the completed branch summary. The documented/help
meaning of `--steps` is “number of tickets to drive,” so neither message
explains that selecting separate delivery units silently caps the request.

A second authorized live Codex invocation with `--steps 1` completed and
QA-reviewed T002. `tickets queue` then said `No remaining tickets`, but
`rafi status .` still reported its latest completed one-ticket run as “still
in progress or did not finish.” This independently confirms the status
projection portion of the defect.

**Cause.** `packages/ai-foreman/src/cli/start.ts` calls
`selectDeliveryUnitForRun(...)` whenever delivery configuration exists (around
lines 610–626) and then supplies only
`deliveryRun.remaining.slice(0, steps)` to `buildBranchPlan` (around line
1766). A two-ticket request therefore cannot cross from the first eligible
unit to another, even in `per-ticket` mode. The run/status projection does not
distinguish “selected delivery unit completed” from “requested ticket count
was not admitted.”

**Resolution.** Decide and document one contract, then enforce it explicitly:

1. Prefer selecting eligible delivery units/tickets in order until `steps` is
   satisfied for independent `per-ticket` units, preserving dependency and
   ownership checks; or reject early with a plain-language message that names
   the one-unit policy and suggests `--stacks`/a delivery-unit option.
2. Never exit a `--steps 2` request with one selected ticket without a visible
   “1 of 2 admitted” result and the reason.
3. Project a completed selected batch as complete while separately reporting
   remaining queued work; do not call a successfully completed one-ticket run
   “still in progress.”
4. Add CLI regression coverage for two independent single-ticket units,
   `--steps 2`, durable work/run status, and status output after each outcome.

### O-E2E-006 — P2: an apparently noninteractive plan still opens ticket-setup prompts

Both providers accepted `rafi plan ... --no-grill-me --yes`, wrote the plan,
then displayed “Set up tickets now?” and entered an interactive
`tickets setup:update` menu. Continuing manually works, but `--yes` does not
mean end-to-end unattended from plan through ticket initialization. The
default create-generated setup causes the update path rather than a direct
noninteractive initialization.

**Resolution.** Preserve the interactive journey for normal terminals, but
when `--yes` is explicit either (a) initialize/populate with the existing
approved-plan defaults, clearly printing the selected values, or (b) finish
the plan command without prompting and print the exact noninteractive
`tickets setup:init` command. Add a TTY and redirected-stdio regression.

### Other verified observations

- Plain `start` correctly stopped on generated but uncommitted Rafi files and
  clearly offered `--dirty-work preserve` and `--dirty-work include`.
  Both successful build attempts used the explicit `include` choice; each
  retained the base checkout and put results in isolated branches.
- In this sandbox, Rafi correctly refused provider probing until `ps` process
  visibility was available. The subsequent elevated fixture-only runs passed;
  this is a harness prerequisite, not a Rafi defect.
- Claude still prints repetitive unqualified `tool failed` activity for
  recoverable failed exploratory reads/Bash invocations during otherwise
  successful planning and QA. O-E2E-004 remains open.
- Claude runtime-auth probing took roughly 1m48 on create and nearly four
  minutes elapsed by ticket population; Codex create probe completed in about
  one second. This is a measured provider-path performance difference, not a
  server-timeout diagnosis.
