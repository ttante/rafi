# Planning, inspection, and preserved-work recovery

## Recover planning

From the project directory, run:

```sh
rafi plan:doctor
```

Rafi finds unfinished create, plan, ticket-planning, ticket-setup, and ticket-population sessions. One session is selected automatically in a terminal; multiple sessions appear with their workflow, checkpoint, and relative age. Cancellation leaves the session available. Without a terminal, the command lists saved sessions and exact `rafi resume … --id …` commands without starting a provider.

Ticket planning automatically requests up to three corrections when a proposal fails schema or source validation. Required tests, rollback/mitigation notes, and priority values remain mandatory; Rafi asks the planner to supply valid content rather than inventing tests or lowering risk. Failed output and validation errors remain in private local interview state, and errors point to `rafi plan:doctor`. Recovery revalidates current tracker context and requests the saved provider session. User approval is still required before applying a recovered proposal. Ticket population also saves interrupted sessions; its recovery reruns proposal generation against the current approved plan before asking for approval.

## Consult Manager before a build

```sh
rafi manager
rafi manager --ask "Why are my tickets blocked?"
```

Manager can help with installation, planning sessions, ticket validation and queueing, uncommitted work, and recovery without any build history. When builds exist, their diagnostics remain available. Build controls always require a real run and work ID. A Manager conversation uses the configured AI provider; reviewing local state with ticket commands or `plan:doctor` listing does not.

## Inspect tickets while build storage needs recovery

```sh
rafi tickets show --all
rafi tickets validate
rafi tickets queue
```

These commands open ticket state for reading and defer publication recovery and build-storage upgrades. They do not take over an active, remote, or unverifiable build owner. Legacy group metadata is inspected without creating a synthetic group. Mutating commands still require safe ownership and migration. If a saved writer might still be active, inspect `rafi status .` and `rafi doctor .`, then verify and stop the build on its owning host before retrying the mutation. Keep recovery databases and backups intact.

## Continue with uncommitted work

During interactive branch builds, Rafi offers preserved-work choices. For scripted use:

```sh
rafi create . --defaults --no-graph --dirty-work preserve
rafi start . --steps 1 --dirty-work preserve
rafi start . --steps 1 --dirty-work include
```

Create records exact preimages before installation. For builds, `preserve` starts isolated branches from committed code, leaving current application changes in the original checkout. `include` creates a private Git baseline containing the current tracked and non-ignored untracked files, using a separate Git index. It does not commit to or switch the user's branch. Both build choices retain worktrees and disable automatic merge and review creation into/from the dirty checkout. Inspect and integrate results after reviewing them.

Baseline metadata and a working patch are retained under `.foreman/dirty-baselines/`. The chosen baseline and policy are also saved with the build for recovery. Ignored files are not included in the Git snapshot. Resolve conflicts before starting. These choices preserve checkout/index state; Rafi's own ticket and runtime state still advances as work completes.

## Claude activity

Tool completion now uses the originating tool's name and call ID. Genuine errors, timeouts, cancellations, and unknown outcomes are distinct. Duplicate result events are coalesced. `TIME_ELAPSED` is reported as unknown, not assumed successful; its exact Enterprise semantics still need a sanitized live event. Raw event evidence remains available for diagnosis.

## Offline publish testing

The complete `ai-foreman` gate runs every test file in isolated processes with four jobs at a time. The large QA-guidance matrix is partitioned by scripted provider so both halves run without dropping cases. Each job records a TAP log and elapsed time; the summary lists the slowest jobs.

```sh
pnpm --filter ai-foreman test
RAFI_TEST_CONCURRENCY=1 pnpm --filter ai-foreman test
```

The second command is the serial comparison/debugging lane. Live canaries remain separately enabled; ordinary publish tests use local scripted providers. Package-file assertions share one immutable dry-run manifest. `autonomy.runtime_deadlines.heartbeat_ms` can configure the worker watchdog; the production default stays 120,000 ms. The process-level hung-worker fixture uses 5,000 ms plus a bounded shutdown, preserving timeout and child-cleanup coverage without a two-minute wait.

## Audit follow-up guarantees

Dirty include baselines honor staged deletions and renames without changing the user's index. Doctor recovery keeps the selected create/setup interview identity; cancellations remain recoverable. Status reports durable completion only for a matching run. Claude elapsed-only placeholders remain uncertain, but later definitive results can resolve them; other failure evidence is not hidden by elapsed-time text.

