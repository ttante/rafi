# Rafi end-to-end reliability handoff

This is the companion handoff for the non-Zod work. The goal is not merely to
make unit tests pass; it is reliable real-provider operation from:

`rafi create -> plan -> tickets setup/populate -> validate -> queue -> start -> Builder -> independent QA -> completed build`

Both real Claude and real Codex must be tested in disposable projects. Do not
claim end-to-end success unless Builder work and independent QA actually
complete and the fixture's tests pass independently.

## Read first

- `QA_PREPARATION_LIVE_FAILURE_INVESTIGATION_PLAN.md`
- `QA_PREPARATION_FIELD_OWNERSHIP.md`
- `TICKET_POPULATION_RISK_RECOVERY_PLAN.md`
- applicable `AGENTS.md`
- `ZOD_GENERATION_CONTRACT_AUDIT.md`
- `ZOD_IMPLEMENTATION_HANDOFF.md`

## Current known state

- The main ai-foreman suite previously passed: 1,301 passed, 12 skipped.
- Focused and fake-provider integration tests passed.
- One earlier Claude journey completed independent QA, but a later Claude run
  blocked during QA. Claude is not proven reliable; do not report it as passing.
- The latest Codex journey reached Builder and independent QA. QA accepted the
  implementation/tests but rejected rollback evidence because retained command
  output was truncated.
- The rehearsal helper was changed to place verified exit statuses and baseline
  comparison first. A manual rehearsal passed, but it was not a Builder
  observation and was not independently reviewed by QA.
- A Rafi retry then failed with `recovery handoff generation 9 for qa was not
  accepted`. Investigate the staged handoff and acceptance callback path. Do
  not weaken handoff validation to hide this.
- Existing disposable Codex evidence is under
  `/private/tmp/rafi-live-codex-evidence-KxuszS/`; run ID
  `eb564171-8ce7-45a3-b76a-da361ef3cde1`.

## Workstreams

### 1. QA preparation and handoff acceptance

Trace the complete lifecycle: host candidate, provider prompt, response
parsing, normalization, semantic validation, independent assessment,
persistence, delivery to Builder, acceptance callback, recovery packet, and
final QA. Identify the owner and authoritative value of every field.

The immediate investigation target is why the QA recovery handoff was staged
but its acceptance callback was not reached. Inspect durable run/QA state,
generation numbers, session identity, digests, callbacks, and restart behavior.
Add regression tests for stale generation, duplicate acceptance, uncertain
dispatch, crash/retry, and successful acceptance. Keep the acceptance gate
strict and make failures name the exact stage, reason, and next action.

### 2. Claude-specific failure

The retained Claude response declined to produce a QA candidate because it
believed SHA-256 hashes required an unavailable shell command. Determine which
hashes are host-owned, compute/bind them in Rafi where possible, and ensure the
provider is asked only for evidence it can legitimately produce. Missing or
out-of-snapshot references must remain blocked. Do not grant broad shell access
or fabricate hashes.

### 3. Codex authority-copy failure

Compare Codex's response with the frozen host candidate field by field. Relative
versus absolute paths, scope, depth, digests, and formatting must not change
host-owned values. Preserve exact authoritative inputs through publication and
delivery, then independently assess the resulting draft. Fix obvious binding or
normalization defects with tests; do not assume the first mismatch is the only
one.

### 4. Rollback evidence and QA preparation

The approved current-ticket permission allows bounded existing command-output
excerpts to be sent to QA. It does **not** authorize global retention or adding
extra npm output to every rehearsal. An automated safety review rejected that
expansion; do not bypass it indirectly. Ask before expanding disclosure or
retention.

QA must not accept truncated rollback evidence as complete. Make the retained
evidence sufficient for the current approved scope, with verified exit status
and baseline comparison visible, while keeping sensitive output bounded.

### 5. Ticket population and risk plans

Medium- and High-risk tickets require a meaningful rollback/mitigation plan in
`rollback`; notes do not substitute for it. Ticket-maker instructions must say
this explicitly and show valid Low-risk and Medium-risk examples.

Population should validate proposals before materialization, perform a bounded
provider correction loop for missing plans, then offer recovery rather than
hard-stop: repair all, explicitly waive exact ticket IDs with a rationale,
review manually, or cancel and retain the session. Existing repair must be
narrow and atomic; it must not rewrite IDs, dependencies, acceptance, or
unrelated content. Warnings from explicit current waivers should be visible in
validate, queue, show, and start.

### 6. Start selection and waiver behavior

Default `rafi start` must select the first eligible, unblocked, non-terminal
ticket using the existing eligibility logic—not merely the first ticket by
order. A current explicit risk-plan waiver prints a clear warning and does not
itself block start. Stop only for no eligible ticket or an unwaived validation
error. Do not add unnecessary second confirmation flags for already explicit
waivers unless the user makes that a deliberate safety decision.

### 7. Online gate

Run deterministic tests first, then fresh disposable real-provider journeys for
both Claude and Codex with QA preparation enabled and no fake provider:

`create -> plan -> setup -> populate -> validate -> queue -> start -> completed Builder work -> independent project test`

Assert generated risk plans, eligible queue selection, prepared and
independently assessed QA contract, Builder admission, durable completion, and
independent fixture tests. A successful command, pause for approval, populated
ticket, or manual rehearsal alone is not a pass.

## Constraints

- Preserve the dirty worktree. Never reset or clean unrelated changes.
- Do not silently bypass QA, lower depth, fabricate evidence, auto-waive
  requirements, or weaken handoff validation.
- Do not mutate retained failed-run databases during investigation unless the
  existing recovery semantics explicitly authorize it.
- File-scope conflicts between plan and ticket are already decided: they do not
  block the build; file changes are indeterminate.
- Use Node `/Users/tyler/.nvm/versions/node/v20.19.0/bin/node` where required.
- Apply the Graphify trigger gate in `AGENTS.md`; do not build/update a stale
  graph merely as routine housekeeping.

## Reporting format

For each run, report the provider, disposable project path, run ID, exact stage
reached, durable evidence location, and whether Builder plus independent QA
completed. Separate code defects from provider/environment failures. If an
issue has an obvious safe fix, implement it with regression coverage. Consult
the user for permission, disclosure/retention expansion, or incompatible safety
semantics.
