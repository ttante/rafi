# Foreman

Loop Claude Code or Codex through tickets.

- No more typing `"next step"` all day.
- QA cycle included (disable with `--no-qa`)
- Uses its own smart local ticket tracking system (support for other systems possible later)
- Project plans still work when you do not want a tracker.
- One-off task files still work too.

## Install

Global install:

```bash
npm install -g foreman-cli
```

Helpful when:

- You want `foreman` available from any repo.
- You use Foreman across multiple projects.
- You do not need each repo to pin its own Foreman version.

Per-project install:

```bash
npm install --save-dev foreman-cli
npx foreman doctor .
```

Helpful when:

- You prefer `npx foreman` over a global CLI.
- You want Foreman tracked in `package.json`.
- You want teammates or CI to use the repo's installed version.

Requires:

- Node.js 20 or newer.

## Use

- Check the target project.
- Initialize Foreman's local ticket tracker.
- Ask agent to convert existing tickets or populate them
- Run foreman for 5 tickets (and QA each one when done)

```bash
foreman doctor ./my-project
foreman tickets init --project ./my-project --app-name "My App"
foreman tickets populate --project ./my-project --agent codex --model gpt-5.5 --effort xhigh
foreman start ./my-project --agent codex --model gpt-5.5 --effort xhigh --steps 5
```

What each part does:

- `./my-project`: the repo Foreman will work on.
- `tickets init`: creates the local `.tickets/` tracker.
- `tickets populate`: asks Codex to convert project planning material.
- Converted output uses Foreman's schema.
- `start`: drives Codex through the next tickets one step at a time.

`tickets populate` can convert:

- plans
- TODOs
- roadmap docs
- ticket files

## Primary Options

### `foreman start`

| Option | Common values | Default | Notes |
| --- | --- | --- | --- |
| `<project>` | `./my-project` / `../repo` | required | Target repo the agent works in. |
| `-s, --steps <n>` | `1` / `5` / `10` | required | Max tickets or implementation steps to drive. |
| `-a, --agent <agent>` | `claude` / `codex` | `claude` | Builder agent. |
| `-m, --model <model>` | `gpt-5.5` / any supported agent model | agent default | Overrides the builder model. |
| `--effort <level>` | Claude Code: `low` / `medium` / `high` / `xhigh`<br>Codex: `low` / `medium` / `high` / `xhigh` | agent default | Reasoning level. |
| `--fast` | flag | off | Lower latency. For Codex, maps to `effort=low` when `--effort` is not set. |
| `-t, --tickets <path>` | `.md` / `.txt` / `.yaml` | auto-detects standard tracker files | Sends a task file to the builder during preflight planning. |
| `-y, --yes` | flag | off | Skips preflight confirmation. |
| `--no-qa` | flag | QA on | Disables per-ticket QA review. |
| `--continue` | flag | off | Resumes the most recent logged session. |
| `-r, --resume <sessionId>` | session ID from `.foreman/` logs | none | Resumes a specific Claude/Codex session. |

Auto-detected tracker files:

- `docs/ticket-progress.md`
- `ticket-progress.md`

Resume rule:

- Use either `--continue` or `--resume`.
- Do not use both in the same command.

### `foreman tickets populate`

| Option | Common values | Default | Notes |
| --- | --- | --- | --- |
| `-p, --project <dir>` | `./my-project` / `../repo` | current directory | Target repo with `.tickets/`. |
| `-a, --agent <agent>` | `claude` / `codex` | `claude` | Builder agent. |
| `-m, --model <model>` | `gpt-5.5` / any supported agent model | agent default | Overrides the builder model. |
| `--effort <level>` | Claude Code: `low` / `medium` / `high` / `xhigh`<br>Codex: `low` / `medium` / `high` / `xhigh` | agent default | Reasoning level. |
| `--fast` | flag | off | Lower latency. |
| `-y, --yes` | flag | off | Skips confirmation before builder edits ticket files. |

## What Foreman Does

During a run, Foreman:

- asks the builder for a short plan
- sends one ticket or implementation step at a time
- requires a final `STEP_STATUS` marker
- runs QA after each completed step by default
- writes a JSONL log under `.foreman/`

When `.tickets/config.yaml` exists, Foreman also:

- uses the local ticket tracker automatically
- marks the first eligible queue row `in_progress`
- marks the ticket `done` only after QA passes

Without tickets, Foreman still works with:

- a one-off task file
- a plain project directory

## Agents And Task Files

Claude Code:

- Default agent.
- Uses your existing Claude Code credentials.
- Runs through the Claude Agent SDK.

Codex:

- Use `--agent codex`.
- Shells out to `codex exec`.
- Requires the `codex` CLI on your `PATH`.

Task file:

```bash
foreman start ./my-project --steps 5 --tickets ./my-project/TICKETS.md
```

With `--tickets`:

- Point at any file.
- Foreman sends that file to the builder during preflight planning.

Common formats include:

- Markdown
- text
- YAML

## Ticket Setup

Tickets are optional.

Use them when you want the repo itself to contain:

- the canonical implementation order
- the generated agent-facing progress document
- the shared queue
- the shared status

### 1. Initialize Tickets

From anywhere:

```bash
foreman tickets init --project ./my-project --app-name "My App"
```

From inside the project:

```bash
foreman tickets init --app-name "My App"
```

Init options:

| Option | Common values | Default | Notes |
| --- | --- | --- | --- |
| `-p, --project <dir>` | `./my-project` / `../repo` | current directory | Project to initialize. |
| `--app-name <name>` | `"My App"` | none | Application name stored in tracker config. |
| `--timezone <tz>` | `America/Chicago` / `UTC` | `UTC` | IANA timezone. |
| `--queue-limit <n>` | `25` / `50` / `100` | `50` | Next-queue window size. |

This creates:

```txt
.tickets/
  config.yaml
  tickets.yaml
  tracker-rules.md
  ticket-state.sqlite
  schema/
  migrations/
  backups/
docs/
  ticket-progress.md
```

### 2. Add Tickets

If the project already has planning material:

- Ask a builder to convert it into Foreman's ticket format.

Supported source material can include:

- tickets
- plans
- TODOs
- roadmap docs
- Markdown trackers

```bash
# Claude Code
foreman tickets populate --project ./my-project

# Codex
foreman tickets populate --project ./my-project --agent codex
foreman tickets populate --project ./my-project --agent codex --model gpt-5.5 --effort xhigh
```

`populate` tells the builder to:

- read `.tickets/*`
- read `docs/ticket-progress.md`
- read existing planning files
- fill `.tickets/tickets.yaml`
- render the progress doc
- validate the result

If the existing content does not map cleanly:

- The builder should ask you for guidance.

You can also edit `.tickets/tickets.yaml` manually.

Storage model:

- Ticket definitions live in YAML.
- Mutable status lives in SQLite.
- Status changes should use `foreman tickets` commands.

Minimal valid example:

```yaml
tickets:
  - id: T001
    order: 1000
    title: Add health check command
    area: CLI
    priority: P1
    size: S
    risk: Low
    depends_on: []
    summary: Add a command that reports whether Foreman is configured correctly.
    acceptance:
      - The command exits 0 when required local checks pass.
      - The command prints actionable warnings for optional missing tools.
    required_tests:
      - Unit test for success output
      - Unit test for missing optional tools
    likely_files:
      - src/index.ts
      - test/*.test.ts
    rollback: null
    notes: null

  - id: T002
    order: 2000
    title: Document health check command
    area: Docs
    priority: P2
    size: XS
    risk: Low
    depends_on:
      - T001
    summary: Add README examples for the health check command.
    acceptance:
      - README shows the command in the quick start.
    required_tests:
      - Documentation review
    likely_files:
      - README.md
    rollback: Revert the README section.
    notes: null
```

Ticket fields Foreman expects:

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Stable ticket ID, unique within the file. |
| `order` | yes | Unique implementation order. Use gaps like `1000`, `2000`. |
| `title` | yes | Short human-readable title. |
| `area` | yes | Product or code area. |
| `priority` | yes | Allowed: `P0` / `P1` / `P2` / `P3`. |
| `size` | yes | Allowed: `XS` / `S` / `M` / `L` / `XL`. |
| `risk` | yes | Allowed: `Low` / `Medium` / `High`. |
| `depends_on` | yes | Array of ticket IDs. Empty array is fine. |
| `summary` | yes | Short implementation summary. |
| `acceptance` | yes | Non-empty list of completion criteria. |
| `required_tests` | yes | Non-empty list of expected validation. |
| `likely_files` | yes | Expected files or globs. Empty only when unknown. |
| `rollback` | required for Medium/High risk | Rollback or mitigation notes. |
| `notes` | optional | Extra context. |

Do not put status fields in `.tickets/tickets.yaml`.

These belong in `.tickets/ticket-state.sqlite`:

```txt
status
last_worked_at
completed_at
attempt_count
last_error
evidence
current_step
blocked_by
validation_result
```

### 3. Validate And Render

```bash
foreman tickets validate --project ./my-project
foreman tickets render --project ./my-project
foreman tickets queue --project ./my-project
```

Generated output:

- `docs/ticket-progress.md` is generated from `.tickets/tickets.yaml`.
- It also includes state from `.tickets/ticket-state.sqlite`.
- Builders should read it.
- You should not manually edit generated sections.

### 4. Run Foreman

Claude Code:

```bash
foreman start ./my-project --steps 10
```

Codex:

```bash
foreman start ./my-project --agent codex --model gpt-5.5 --effort xhigh --steps 10
```

## Common Commands

```bash
# Check environment and config
foreman doctor ./my-project

# Disable per-step QA
foreman start ./my-project --steps 5 --no-qa

# Resume the latest session
foreman start ./my-project --steps 5 --continue

# Resume a specific session
foreman start ./my-project --steps 5 --resume <session-id>

# Show the latest run summary
foreman status ./my-project

# Show the next ticket queue
foreman tickets queue --project ./my-project
```

## Ticket Commands

```bash
# Initialize the project ticket tracker
foreman tickets init --project ./my-project --app-name "My App"

# Ask Claude/Codex to populate .tickets/tickets.yaml from existing project docs
foreman tickets populate --project ./my-project
foreman tickets populate --project ./my-project --agent codex
foreman tickets populate --project ./my-project --agent codex --model gpt-5.5 --effort xhigh

# Validate ticket files and generated output
foreman tickets validate --project ./my-project

# Regenerate docs/ticket-progress.md
foreman tickets render --project ./my-project

# Print the current queue
foreman tickets queue --project ./my-project
foreman tickets queue --project ./my-project --limit 10

# Update a ticket note or status
foreman tickets update T001 --project ./my-project --next-action "Add tests"

# Mark a ticket complete manually
foreman tickets complete T001 --project ./my-project --evidence "pnpm test passed"

# Block or unblock work
foreman tickets block T001 --project ./my-project --blocked-by external-api --summary "Waiting on API key"
foreman tickets unblock T001 --project ./my-project --summary "API key received"

# Capture future work discovered during implementation
foreman tickets discover --project ./my-project --summary "Add retry metrics" --rationale "Needed for operations"

# Cancel a ticket
foreman tickets cancel T001 --project ./my-project --summary "Superseded by T002"

# Promote discovered future work into tickets.yaml
foreman tickets accept-future-work 1 --project ./my-project --ticket-id T051 --order 51000

# Reorder a ticket
foreman tickets reorder T051 --project ./my-project --after T050
foreman tickets reorder T051 --project ./my-project --order 51000

# Archive old completed tickets
foreman tickets archive --project ./my-project --older-than-days 30

# Import is a placeholder
foreman tickets import --project ./my-project --progress docs/ticket-progress.md
```

## How The Loop Works

Before implementation starts:

- Foreman asks the builder to list the next `N` steps.
- You confirm or revise that list.
- Passing `--yes` skips confirmation.

Every implementation turn must end with exactly one marker.

Marker rules:

- Put the marker on the final non-empty line.
- Use one of these forms:

```txt
STEP_STATUS: done | ticket="T001" summary="implemented health check" next="document command"
STEP_STATUS: blocked | ticket="T001" reason="missing DATABASE_URL"
STEP_STATUS: plan_complete | ticket="T001" summary="all requested work is complete"
STEP_STATUS: needs_input | question="Which storage backend?" choices="SQLite|Postgres"
```

When QA is enabled, Foreman asks the builder to review its own work:

```txt
STEP_STATUS: qa_pass | summary="tests pass and acceptance criteria are met"
STEP_STATUS: qa_fail | issues="missing test for empty config"
```

If QA fails:

- Foreman sends a fix instruction.
- Foreman reruns QA.
- QA turns do not count against `--steps`.

## Permissions

Foreman's permission policy is deterministic.

- The policy does not use LLM judgment.

For Claude:

- The SDK surfaces tool requests to Foreman.
- Foreman classifies them with the project's `foreman.yaml`.
- Tools in `permissions.escalateTools` are denied.
- File write tools are allowed only when their target stays inside the project.
- The inside-project check depends on the SDK surfacing the path to Foreman.
- Bash is denied if it contains an always-escalate substring.
- Bash is otherwise allowed only for configured prefixes.
- Every chained segment must start with an `allowBash` prefix.
- Unknown tools are denied.
- Unknown Bash commands are denied.

For Codex:

- Codex tool calls are not currently intercepted by Foreman.
- Codex runs under `codex exec --sandbox workspace-write`.
- Codex safety depends on Codex's own sandboxing.

Default config:

- The default config lives in [foreman.yaml](./foreman.yaml).
- Copy it into a project when you need project-specific policy.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build

pnpm dev -- start ./dummy-project --steps 2
```

Package output:

- The package publishes a `foreman` binary from `dist/index.js`.

## Current Limitations

- One builder at a time.
- No daemon or dashboard.
- Codex tool calls are not intercepted by Foreman's permission policy.
- `foreman tickets import` is currently a stub.
- Escalated actions are denied and stop the batch.
- There is no approve/deny queue yet.





