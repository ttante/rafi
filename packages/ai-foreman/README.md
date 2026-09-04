# ai-foreman

Loop Claude Code or Codex through tickets.

- No more typing `"next step"` all day.
- QA cycle included (disable with `--no-qa`)
- Uses its own smart local ticket tracking system (support for other systems possible later)
- Project plans still work when you do not want a tracker.
- One-off task files still work too.

## Why

- **Enforces TDD** — the builder role is compiled from rule packs that require tests before implementation, red-green-refactor discipline, and test coverage gates on every ticket.
- **Enterprise stability from day one** — security, observability, robustness, and scalability rules are baked into every builder turn, not bolted on later.
- **Rich ticket system** — tickets carry acceptance criteria, required tests, dependencies, priority, size, and risk level. The agent reads the full context before starting each step.
- **Future work tracking** — when the builder discovers out-of-scope work during a run, `ai-foreman tickets discover` captures it without derailing the current ticket. Discovered items live in a separate inbox until you promote them.
- **QA that actually gates** — QA runs after every completed ticket and checks code quality, test passing, and regression protection. The ticket only closes after QA passes. QA turns do not count against `--steps`.
- **Visible long-running work** — semantic activity rows identify provider, phase, tools, retries, and quiet periods; cursor-capable terminals update changing counters in place, while record-oriented terminals coalesce them.

Provider-managed retries are reported immediately as durable lines. A quiet-provider warning appears after 60 seconds without a signal, but Foreman does not add retries, abort the provider, or change provider retry limits. Non-TTY output receives a heartbeat every 30 seconds while work remains pending. TTY rendering defaults to automatic detection: Codex, CI, and `TERM=dumb` use newline records and suppress spinner- or number-only repeats; other terminals redraw those changes in place and retain a row when the textual status changes. Use `RAFI_ACTIVITY_RENDER_MODE=auto|cursor|records` to override detection.

## Install

Global install:

```bash
npm install -g ai-foreman
```

Helpful when:

- You want `ai-foreman` available from any repo.
- You use Foreman across multiple projects.
- You do not need each repo to pin its own Foreman version.

Per-project install:

```bash
npm install --save-dev ai-foreman
npx ai-foreman doctor .
```

Helpful when:

- You prefer `npx ai-foreman` over a global CLI.
- You want Foreman tracked in `package.json`.
- You want teammates or CI to use the repo's installed version.

Requires:

- Node.js 20 or newer.

### Claude runtime and enterprise authentication

Foreman first resolves and probes the system `claude` command, then passes that exact absolute executable path to the Claude Agent SDK. It does not use the SDK's bundled Claude executable. SDK sessions inherit the current environment and load Claude's user, project, and local settings; organization-managed policy remains applied by Claude Code. This preserves enterprise SSO such as `/login-okta`, managed settings, and proxy/certificate configuration.

The SDK package is an optional dependency of `ai-foreman`. Do not install `@anthropic-ai/claude-agent-sdk` into the application being built unless that application independently uses it.

Run `ai-foreman doctor .` to see the selected executable, SDK-wrapper status, settings sources, and relevant environment-variable names. Add `--live-claude` for a bounded, no-tools request through the real adapter path. That opt-in check uses account quota.

## Use

- Check the target project.
- Initialize Foreman's local ticket tracker.
- Ask the ticket-maker role to convert existing tickets or populate them
- Run foreman for 5 tickets (and QA each one when done)

```bash
ai-foreman doctor ./my-project
ai-foreman tickets init --project ./my-project --app-name "My App"
ai-foreman tickets populate --project ./my-project --agent codex --model gpt-5.5 --effort xhigh
ai-foreman start ./my-project --agent codex --model gpt-5.5 --effort xhigh --steps 5
```

What each part does:

- `./my-project`: the repo Foreman will work on.
- `tickets init`: creates the local `.tickets/` tracker.
- `tickets populate`: asks the ticket-maker role to convert project planning material.
- Converted output uses Foreman's schema.
- `start`: drives Codex through the next tickets one step at a time.

`tickets populate` can convert:

- a managed Rafi plan at `<docs.root>/rafi-plan.md`
- plans
- TODOs
- roadmap docs
- ticket files
- folders or globs containing planning notes

## Primary Options

### `ai-foreman start`

| Option | Common values | Default | Notes |
| --- | --- | --- | --- |
| `<project>` | `./my-project` / `../repo` | required | Target repo the agent works in. |
| `-s, --steps <n>` | `1` / `5` / `10` | required | Max tickets or implementation steps to drive. |
| `-a, --agent <agent>` | `claude` / `codex` | single `rafi-config.yaml` target, otherwise `claude` | Builder agent. Explicit `--agent` always wins. |
| `-m, --model <model>` | `gpt-5.5` / any supported agent model | agent default | Overrides the builder model. |
| `--effort <level>` | Claude Code: `low` / `medium` / `high` / `xhigh`<br>Codex: `low` / `medium` / `high` / `xhigh` | agent default | Reasoning level. |
| `--fast` | flag | off | Lower latency. For Codex, maps to `effort=low` when `--effort` is not set. |
| `-t, --tickets <path>` | `.md` / `.txt` / `.yaml` | auto-detects standard tracker files | Sends a task file to the builder during preflight planning. |
| `-y, --yes` | flag | off | Skips preflight confirmation. |
| `--no-qa` | flag | QA on | Disables per-ticket QA review. |
| `--continue` | flag | off | Resumes the most recent logged session. |
| `-r, --resume <sessionId>` | session ID with a stored scoped binding | none | Resumes only after provider, canonical worktree, and workspace identity validation. |
| `--branch-per-ticket` | flag | off | Runs each selected structured ticket in its own git worktree and branch. Requires initialized `.tickets/`. |
| `--create-pr` | flag | off | Pushes each successful ticket branch and creates a GitHub PR. Implies `--branch-per-ticket`. |
| `--pr-ready` | flag | draft PRs | Creates ready-for-review PRs instead of draft PRs when used with `--create-pr`. |
| `--keep-worktrees` | flag | remove successful worktrees | Keeps successful ticket worktrees for inspection. Blocked worktrees are kept automatically. |
| `--ticket <id>` | `T001` | none | Selects a branch-mode ticket to continue. Repeatable with `--continue`. |
| `--base <ref>` | `main` / `origin/main` / `HEAD` | current branch or `HEAD` | Base ref for root ticket branches. |
| `--branch-prefix <prefix>` | `feature` / `rafi` / another valid Git prefix | `feature` | Prefix for generated ticket branches. Explicit prefixes are preserved verbatim. |
| `--max-branch-depth <n>` | positive integer | `5` | Maximum selected branch/PR stack depth (root PR is depth 1). |
| `--show-session-cost` / `--hide-session-cost` | flags | saved role preferences | Show authoritative provider cost or trustworthy cumulative tokens for Builder and QA; does not change context occupancy display. |
| `--auto-compact-threshold <percent>` | integer `1`–`99` | saved Builder value, then `50` | Initial run threshold override. A newer persistent settings revision wins at the next safe boundary. |

Auto-detected tracker files:

- configured `paths.progress_doc` from `.tickets/config.yaml`
- `docs/ticket-progress.md`
- `ticket-progress.md`

Resume rule:

- Use either `--continue` or `--resume`.
- Exact resume requires the original canonical worktree and its recorded identity. A deleted, recreated, cross-worktree, ambiguous, or unverifiable session is rejected with fresh/handoff recovery guidance.
- Do not use both in the same command.
- In branch mode, use `--continue --ticket <id>` to continue a ticket with its saved builder session.
- For multiple branch tickets, repeat `--ticket` with `--continue`; do not reuse one explicit `--resume <sessionId>` across multiple tickets.
- When a branch run ends blocked, Foreman prints paste-ready continue commands for resumable tickets.

Branch-mode examples:

```bash
ai-foreman start ./my-project --steps 3 --branch-per-ticket --agent codex
ai-foreman start ./my-project --steps 3 --create-pr --pr-ready --agent codex
ai-foreman start ./my-project --steps 3 --completion auto-merge --provider gitlab
ai-foreman start ./my-project --steps 3 --completion direct-merge
ai-foreman start ./my-project --steps 1 --branch-per-ticket --continue --ticket T001
```

Saved `tickets.build` defaults in `rafi-config.yaml` can enable branch-per-ticket and completion behavior automatically. Use `--completion pr|auto-merge|direct-merge|none`, `--no-branch-per-ticket`, `--no-create-pr`, or `--auto-merge-wait` / `--no-auto-merge-wait` to override saved defaults for one run.

With the saved `current` strategy, Foreman works in the active branch while the user owns Git. It may edit, test, run QA, and update tracker/recovery state, but all branch/worktree, commit, push, merge, rebase, and review lifecycle commands are fenced. An unexpected active ref or worktree change pauses the run. Explicit isolated flags are reported as run overrides.

The current terminal status includes the role/provider, activity, truthful context state, successful compaction count, and handoff generation. At the Builder threshold, Foreman settles the in-flight action, verifies native compaction plus a fresh provider usage sample, and resumes the frozen action. The configured maximum defaults to ten successful compactions per location-scoped provider session; the next crossing uses a validated fresh handoff instead of exceeding it. Disposable QA snapshots never reuse a prior QA conversation in a new `/tmp/rafi-qa-*` worktree; they transfer cumulative state through an accepted handoff.

Failed QA reviews use the versioned `RAFI_QA_FAILURE_REPORT_START` / `RAFI_QA_FAILURE_REPORT_END` JSON contract. Foreman validates the report before Builder remediation and preserves reports by digest. A malformed failing report receives two correction-only turns, a compacted pair, then five turns in a validated fresh successor. Recovery packets are owner-only, locally Git-excluded, and stored under `.foreman/qa-report-recovery/`; the successor must acknowledge the copied packet and reviewed-state digests before reporting.

### `ai-foreman manager`

Manager is a project-wide, read-only diagnostic conversation over every retained build run. It starts with a verified live run when one exists, otherwise the most recently updated run; `--run <id>` changes only that initial focus. Each question refreshes the catalog, active state, deterministic aggregates, and relevant run details.

Permanent sanitized run summaries keep timing, counts, provider/model configuration, usage coverage, failure category, and terminal Git facts useful after detailed spans expire. Detailed spans retain the configured 30-day policy. Missing historical facts are reported as partial rather than reconstructed or treated as zero.

When the initial bounded packet omits evidence needed for a question, Manager can request catalog rows, aggregates, comparisons, or details through a host-validated read-only lookup. Each question is limited to two rounds, six operations per round, five detailed runs per operation, and fifty catalog rows per list operation. Questions, answers, and lookup envelopes are not stored as project evidence.

```bash
ai-foreman manager ./my-project
ai-foreman manager ./my-project --run <run-id> --ask "Compare this run with the last five successful runs"
```

### GitHub PR Failure Recovery

When `--create-pr` cannot prepare GitHub, push a branch, or create a PR, Foreman records a structured failure and blocks the affected ticket cleanly. Blocked worktrees are retained automatically so you can repair the environment and retry without losing the ticket session.

`ai-foreman status ./my-project` shows the latest GitHub failure code, repair commands, last command output, and a retry command when a resumable ticket session exists.

Common failure codes:

| Code | Meaning |
| --- | --- |
| `gh_missing` | GitHub CLI is not installed or not on `PATH`. |
| `gh_not_authenticated` | `gh` is installed but not authenticated for the remote host. |
| `repo_unreachable` | `gh repo view` cannot access the target repository. |
| `git_remote_unreachable` | `git ls-remote` cannot access the configured remote. |
| `network_or_timeout` | A GitHub or git command timed out or hit a network error. |
| `push_failed` | The ticket branch could not be pushed. |
| `pr_create_failed` | The branch pushed, but PR creation or PR body writing failed. |

For GitHub Enterprise remotes, repair commands include the remote host:

```bash
gh auth login --hostname <host>
gh auth status --hostname <host>
gh repo view <host>/<owner>/<repo>
```

### `ai-foreman tickets populate`

| Option | Common values | Default | Notes |
| --- | --- | --- | --- |
| `-p, --project <dir>` | `./my-project` / `../repo` | current directory | Target repo with `.tickets/`. |
| `-a, --agent <agent>` | `claude` / `codex` | single `rafi-config.yaml` target, otherwise `claude` | Builder agent. Explicit `--agent` always wins. |
| `-m, --model <model>` | `gpt-5.5` / any supported agent model | agent default | Overrides the builder model. |
| `--effort <level>` | Claude Code: `low` / `medium` / `high` / `xhigh`<br>Codex: `low` / `medium` / `high` / `xhigh` | agent default | Reasoning level. |
| `--sources <paths...>` | `docs/tickets.md docs/plans/**` | Configured Rafi `<docs.root>/rafi-plan.md`, then ticket docs root, then `docs/rafi-plan.md`, otherwise scans | Optional files, folders, or globs for the agent to check first. Any reasonable planning format is OK. |
| `--fast` | flag | off | Lower latency. |
| `-y, --yes` | flag | off | Skips confirmation before builder edits ticket files. |

Use `ai-foreman tickets setup:init` or `setup:update` to append local, Linear, or Jira Cloud sources to the project-wide registry in `rafi-config.yaml`. Linear imports use `LINEAR_API_KEY`; Jira Cloud imports use `JIRA_EMAIL` and `JIRA_API_TOKEN`. Credentials are never persisted, and mirrored tickets retain source provenance.

Use `ai-foreman tickets review` to accept, defer, or dismiss pending split/combine/duplicate recommendations rendered in the progress doc.

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

- Default agent when no single runtime target is configured.
- Uses your existing Claude Code credentials.
- Runs through the Claude Agent SDK.
- `start` and `tickets populate` check Claude auth before launching the builder and prompt you to repair it, switch to Codex for the current run, or cancel when interactive.

Codex:

- Use `--agent codex`, or set `harness.targets: ["codex"]` in `rafi-config.yaml` and omit `--agent`.
- Shells out to `codex exec`.
- Requires the `codex` CLI on your `PATH`.
- `start` and `tickets populate --agent codex` check Codex auth before launching the builder and prompt you to repair it, switch to Claude for the current run, or cancel when interactive.

Runtime defaults and recovery:

- If `--agent` is omitted, Foreman reads `rafi-config.yaml`. A single `harness.targets` value selects that runtime; missing config or both targets default to Claude.
- Non-interactive and `--yes` runs fail clearly instead of switching runtimes automatically.
- Resume and continue flows do not offer runtime switching because session IDs are runtime-specific.
- If an interactive command switches providers, a provider-specific `--model` override is ignored for that run. `--effort` and `--fast` remain in effect.
- Cancel stops the command and keeps project files, generated files, and installed packages in place.

Task file:

```bash
ai-foreman start ./my-project --steps 5 --tickets ./my-project/TICKETS.md
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
ai-foreman tickets init --project ./my-project --app-name "My App"
```

From inside the project:

```bash
ai-foreman tickets init --app-name "My App"
```

Init options:

| Option | Common values | Default | Notes |
| --- | --- | --- | --- |
| `-p, --project <dir>` | `./my-project` / `../repo` | current directory | Project to initialize. |
| `--app-name <name>` | `"My App"` | none | Application name stored in tracker config. |
| `--timezone <tz>` | `America/Chicago` / `UTC` | `UTC` | IANA timezone. |
| `--implementation-limit <n>` | `250` / `500` / `1000` | `500` | Implementation queue window for generated docs and Foreman selection. |
| `--view-limit <n>` | `1000` / `20000` | `20000` | Default row limit for the display queue command. |
| `--queue-limit <n>` | `250` / `500` / `1000` | none | Deprecated alias for `--implementation-limit`. |
| `--docs-root <dir>` | `docs` / `docs-rafi` | `rafi-config.yaml` docs.root, then `docs` | Root for generated progress/archive docs. |

`tickets init` reads `docs.root` from `rafi-config.yaml` when present. `--docs-root` overrides that value. The selected root must be a safe repo-relative directory, and init refuses to overwrite an existing selected `ticket-progress.md`.

Init writes `implementation_limit` and `view_limit` to `.tickets/config.yaml`. Existing configs with `queue_limit` still load as an implementation limit, with the old default value `50` upgraded to `500`.

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

With `--docs-root docs-rafi`, the generated tracker docs are written under `docs-rafi/` instead.

### 2. Add Tickets

If the project already has planning material:

- Ask the ticket-maker role to convert it into Foreman's ticket format.

Supported source material can include:

- tickets
- plans
- TODOs
- roadmap docs
- Markdown trackers
- folders or globs containing planning notes

```bash
# Claude Code
ai-foreman tickets populate --project ./my-project
ai-foreman tickets populate --project ./my-project --sources docs/rafi-plan.md
ai-foreman tickets populate --project ./my-project --sources docs/tickets.md docs/plans/**

# Codex
ai-foreman tickets populate --project ./my-project --agent codex
ai-foreman tickets populate --project ./my-project --agent codex --model gpt-5.5 --effort xhigh
```

`populate` tells the builder to:

- read `.tickets/*`
- read the configured progress doc
- prefer the configured Rafi `<docs.root>/rafi-plan.md`, then the ticket docs root, then `docs/rafi-plan.md` when no `--sources` are provided
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
- Status changes should use `ai-foreman tickets` commands.

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
ai-foreman tickets validate --project ./my-project
ai-foreman tickets render --project ./my-project
ai-foreman tickets queue --project ./my-project
```

Generated output:

- The configured progress doc is generated from `.tickets/tickets.yaml`.
- It also includes state from `.tickets/ticket-state.sqlite`.
- Builders should read it.
- You should not manually edit generated sections.

### 4. Run Foreman

Claude Code:

```bash
ai-foreman start ./my-project --steps 10
```

Codex:

```bash
ai-foreman start ./my-project --agent codex --model gpt-5.5 --effort xhigh --steps 10
```

## Common Commands

```bash
# Check environment and config
ai-foreman doctor ./my-project

# Show the latest run summary
ai-foreman status ./my-project

# Disable per-step QA
ai-foreman start ./my-project --steps 5 --no-qa

# Resume the latest session / a specific session
ai-foreman start ./my-project --steps 5 --continue
ai-foreman start ./my-project --steps 5 --resume <session-id>
```

## Ticket Lifecycle Commands

After `init`, `populate`, `validate`, and `render` (covered in Ticket Setup above), these commands manage tickets day-to-day:

```bash
# Update a ticket's next action
ai-foreman tickets update T001 --project ./my-project --next-action "Add tests"

# Mark a ticket complete manually
ai-foreman tickets complete T001 --project ./my-project --evidence "pnpm test passed"

# Block / unblock
ai-foreman tickets block T001 --project ./my-project --blocked-by external-api --summary "Waiting on API key"
ai-foreman tickets unblock T001 --project ./my-project --summary "API key received"

# Capture future work discovered during a run
ai-foreman tickets discover --project ./my-project --summary "Add retry metrics" --rationale "Needed for operations"

# Promote discovered work into tickets.yaml
ai-foreman tickets accept-future-work 1 --project ./my-project --ticket-id T051 --order 51000

# Cancel / reorder / archive
ai-foreman tickets cancel T001 --project ./my-project --summary "Superseded by T002"
ai-foreman tickets reorder T051 --project ./my-project --after T050
ai-foreman tickets archive --project ./my-project --older-than-days 30

# Inspect immutable creation groups and reset an exact approved group
ai-foreman tickets groups list --project ./my-project
ai-foreman tickets reset --group TG-3 --project ./my-project
```

Ticket creation groups use stable repository-local IDs (`TG-1`, `TG-2`, …); newest-first list position is separate and may change. Missing definitions remain immutable members with a validated recovery snapshot. Non-interactive group restoration requires an explicit deleted-ticket policy, and missing dependency definitions stop the reset atomically.

## How The Loop Works

Before implementation starts:

- Foreman asks the builder to list the next `N` steps.
- You confirm or revise that list.
- Passing `--yes` skips confirmation.

Every implementation turn must end with exactly one marker.

Builder and QA turns also publish a bounded cumulative continuity delta. Automatic fresh transitions stage a versioned JSON/Markdown handoff, require `HANDOFF_ACCEPTED` plus a valid successor checkpoint, and only then move the role lease. The all-in-one `rafi` CLI exposes durable handoff inspection and cache/history maintenance commands.

Marker rules:

- Put the marker on the final non-empty line.
- Use one of these forms:

```txt
STEP_STATUS: done | ticket="T001" summary="implemented health check" next="document command"
STEP_STATUS: blocked | ticket="T001" reason="missing DATABASE_URL"
STEP_STATUS: plan_complete | ticket="T001" summary="all requested work is complete"
STEP_STATUS: needs_input | question="Which storage backend?" choices="SQLite|Postgres"
```

Provider-native `AskUserQuestion` prompts preserve their existing input/output behavior. Hosts may also observe a question only after the user successfully supplies a non-empty answer; cancelled, denied, malformed, and empty prompts do not emit answered-question telemetry. Rafi uses this boundary to recognize machine-shaped exhaustive-planning exchanges without treating generic questions as grill-me coverage.

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
- Runtime implementation and ticket population runs use `codex exec --sandbox workspace-write`.
- Read-only callers such as `rafi plan` can request `codex exec --sandbox read-only`.
- Codex safety depends on Codex's own sandboxing.

Default config:

- The default config lives in [foreman.yaml](./foreman.yaml).
- Copy it into a project when you need project-specific policy.

## Development

From the monorepo root:

```bash
pnpm install
pnpm -r build
pnpm -r test
```

From this package:

```bash
pnpm test
pnpm typecheck
pnpm build

pnpm dev -- start ../../examples/dummy-project --steps 2
```

Package output:

- The package publishes an `ai-foreman` binary from `dist/index.js`.

## Current Limitations

- One builder at a time.
- No daemon or dashboard.
- Codex tool calls are not intercepted by Foreman's permission policy.
- `ai-foreman tickets import` is currently a stub.
- Escalated actions are denied and stop the batch.
- There is no approve/deny queue yet.

## Part of Rafi

- **`special-agents`** — library (rules + skills + agents + composition)
- **`ai-foreman`** — this runtime
- **`@rafi-ai/cli`** — CLI for `rafi create` and `rafi compile`
