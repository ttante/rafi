# Rafi (Refined AI Framework & Implementor)

A lightweight + powerful harness engineering framework. Your best bet for everything from one-shot builds to small feature implementation. Especially helpful for building enterprise level AI features.

## Features
- Composes best-practice rules into skills into agents (builder, QA, planner, ticket-maker)
- In-stack rules for AI | frontend | cloud | backend
- Turns a user brief plus repo inspection into a ticket-maker-ready plan with `rafi plan`
- `ai-foreman` (robust ticketing/tracking solution):
- Sets up + populates tickets via specialized-agent
- Drives agents through tickets with built-in QA cycling per step

## How
- enforces strict test driven development (TDD)
- enterprise level stability & security features from square one
- rock solid task tracking
- future work identified + documented
- QA-coupled builder ensures code quality + testing + regression protection

## AI App Superbuilder

Rafi shines brightest in apps that leverage LLMs. Enable `usesAI` and your agents get five additional rule packs that enforce enterprise-grade AI engineering from the first line of code:

- **Adversarial safety** — agents plan prompt injection defense, jailbreak protection, content safety checks, tool scoping, and abuse monitoring before writing any AI feature. Red-teaming is built into release criteria. An incident plan for harmful, wrong, expensive, or policy-violating outputs is required.
- **Confidence & evals** — every AI generation step gets quality gates, confidence scoring, and acceptance thresholds. Models check their own work three times by default (configurable). Eval suites with golden examples and adversarial cases are required before promoting any prompt change.
- **Full replayability** — every meaningful AI generation is recorded with prompt version, rendered prompt, input references, model/provider, parameters, tool calls, output, validation results, cost, latency, and decisions. Prompts are versioned, reviewed, tested, and rollback-capable.
- **Cost tracking & learning loop** — cost per task is tracked across tokens, retries, tool calls, and latency. Failed generations feed a structured correction workflow; approved corrections are preserved in a format suitable for future evals, fine-tuning, or custom model training — all planned from day one.
- **Model & dataset governance** — approved models, fallbacks, and change rules are documented. Model changes require evals. Dataset consent, labeling quality, retention, and training eligibility are defined before data is collected.

## Install

```sh
npm install -g @rafi-ai/cli
```

## Use

Run `rafi` from inside the target repo:

- Answer the walkthrough questions about your stack (or skip with `--defaults`)
- Choose runtime targets: both Claude and Codex, Claude only, or Codex only
- Get target-specific agent files, role bundles, and starter docs written to your repo
- If the final target set includes Claude Code, the Claude Agent SDK is installed automatically with your selected package manager (`npm`, `pnpm`, Yarn Classic/modern, or Bun)
- Selected agent runtimes are checked before `create`, `plan`, `start`, and `tickets populate` continue, with retry/switch/cancel recovery prompts if auth is missing
- Re-run `rafi compile` whenever you update `rafi-config.yaml`

```sh
cd my-repo
rafi create .             # interactive walkthrough
rafi create . --defaults  # skip walkthrough, use built-in defaults
rafi create . --runtime codex  # Codex-only native artifacts
rafi create . --docs-root docs-rafi  # choose where Rafi writes starter/tracker docs
rafi compile .            # re-render after editing rafi-config.yaml
rafi plan .                 # start an interactive planning interview
```

## What gets written

```
my-repo/
  AGENTS.md                        Codex rules doc, when Codex is targeted
  AGENTS-rafi.md                   Append-mode overflow sidecar, when needed
  CLAUDE.md                        Claude Code entrypoint or standalone rules, when Claude is targeted
  CLAUDE-rafi.md                   Append-mode overflow sidecar, when needed
  rafi-config.yaml                 your stack config - commit this, edit to update
  .claude/agents/<role>.md         Claude subagents, when Claude is targeted
  .claude/skills/<name>/SKILL.md   Claude project skills, when Claude is targeted
  .codex/agents/<role>.toml        Codex project subagents, when Codex is targeted
  .agents/skills/<name>/SKILL.md   Codex project skills, when Codex is targeted
  .rafi/compiled/<role>/           role bundles always emitted for ai-foreman
  docs/                            starter docs (or docs-rafi/ when docs/ already exists)
  docs/rafi-plan.md                latest managed plan from rafi plan
  docs/rafi-plans/<timestamp>.md   preserved plan history
```

`harness.targets` in `rafi-config.yaml` controls which native files are refreshed. Files for unselected targets are preserved, not deleted.

## Defaults

`--defaults` (and the starting point for the walkthrough) uses these values:

| Setting | Default |
|---|---|
| Frontend | React with TypeScript |
| Backend | Node.js, Python, or both |
| Database | PostgreSQL |
| Cloud | AWS |
| Package manager | pnpm |
| Has frontend | ✓ |
| Uses AI | ✓ (opt-out — disable to exclude AI rule packs) |
| Runs in cloud | ✓ |

Edit `rafi-config.yaml` and run `rafi compile` to change anything. Older legacy config files are migrated automatically.

## Existing Files And Custom Artifacts

Rafi includes protections against overwriting existing `AGENTS.md`, `CLAUDE.md`, skills, and subagents. During `rafi create`, if Rafi finds an existing root instruction file, it asks how to handle it.

| Choice | Existing `AGENTS.md` / `CLAUDE.md` behavior | Use when |
|---|---|---|
| `append` | Preserves existing text and writes or refreshes a dated Rafi block. If inline append would exceed the runtime startup guard, Rafi writes generated guidance to `AGENTS-rafi.md` or `CLAUDE-rafi.md` and inserts a compact reference block near the top of the root file. | You want the safest non-destructive default. |
| `update` | Asks an installed agent runtime to merge existing guidance with Rafi guidance. | You want one coherent file and have authenticated Claude Code or Codex. |
| `overwrite` | Replaces the file with Rafi's generated version. | The existing file is disposable or already generated. |

For non-interactive runs, the same root-file behavior can be set with `--root-file-mode append|update|overwrite` on `rafi create` or `rafi compile`, or with `agent_files.mode` in `rafi-config.yaml`.

Append overflow sidecars are target-aware: Codex writes `AGENTS-rafi.md` only when `AGENTS.md` would exceed Codex's root file guard, and Claude writes `CLAUDE-rafi.md` only when `CLAUDE.md` would exceed Claude's guard. Rafi refuses to overwrite a pre-existing sidecar unless it is clearly Rafi-generated. Claude `@file` imports still load imported content into Claude's context according to Claude Code behavior; this sidecar keeps the root file short and visible to startup readers, but it is not a Claude context-reduction mechanism.

Existing project skills and subagents can either stay project-owned or be replaced by Rafi. If a generated skill or subagent path collides, `rafi create` asks whether Rafi should overwrite it. If not, Rafi writes its defaults under `*-rafi` paths, and you can reference your existing artifact by setting `artifact_source: existing` in `rafi-config.yaml`.

If a target repo already has a `docs/` path, `rafi create` keeps those app docs untouched by default and writes Rafi starter docs under the first safe `docs-rafi/` variant. The selected root is saved as `docs.root` in `rafi-config.yaml`; legacy configs without it continue to use `docs/`.

## Suggested Use

### New Projects

- Create an empty repo and run rafi from inside it
  ```sh
  mkdir my-repo && cd my-repo
  rafi create .
  ```
- Ask Rafi to run the `planner` role with `grill-me`, interview you for the brief, and write a ticket-maker-ready plan
  ```sh
  rafi plan .
  ```
- Use the ticket-maker agent to convert the plan into a structured, ordered ticket queue
  ```sh
  rafi tickets init --app-name "My App"
  rafi tickets populate --sources docs/rafi-plan.md
  ```
- `rafi tickets init` reads `docs.root` from `rafi-config.yaml`; pass `--docs-root <dir>` to override it for standalone ticket setup.
- `rafi tickets populate` prefers `<docs.root>/rafi-plan.md` from `rafi-config.yaml` when it exists, and otherwise checks the ticket docs root, `docs/rafi-plan.md`, then scans relevant planning docs automatically; pass `--sources docs/tickets.md docs/plans/**` when you want the agent to check specific files, folders, or globs first.
- Run the builder to implement tickets one by one, with QA after each step
  ```sh
  rafi start . --steps 10
  ```

### Existing Projects

- Navigate into the repo and run rafi — answer questions about your current stack, or use `--defaults` and edit `rafi-config.yaml` to match reality
  ```sh
  cd my-repo
  rafi create .
  ```
- Enable the flags that match your stack (`usesAI`, `hasFrontend`, `runsInCloud`) and re-compile to get the right rule packs
  ```sh
  # edit rafi-config.yaml, then:
  rafi compile .
  ```
- Turn your current repo into a managed plan through Rafi's interactive planning interview, or import your existing backlog from planning docs, ticket files, folders of notes, or markdown roadmaps. Any reasonable format is OK because an agent interprets the sources.
  ```sh
  rafi tickets init --app-name "My App"
  rafi plan . --sources docs/roadmap.md
  rafi tickets populate
  # or: rafi tickets populate --sources docs/tickets.md docs/plans/**
  ```
- Run the builder against your backlog; QA cycles and future-work tracking keep the queue clean as work completes
  ```sh
  rafi start . --steps 10
  ```

## Rule packs

All 30 packs are assembled from your stack config. Most are always included; three groups are conditional:

- **Always** — code quality, git safety, testing, TDD, CI, security, observability, robustness, scalability, data governance, API docs, release, architecture, and templated stack rules (frontend framework, backend, database, package manager substituted from your answers)
- **`usesAI`** — AI safety, evals, cost tracking, reproducibility, and AI governance rules
- **`hasFrontend`** — accessibility and UX rules
- **`runsInCloud`** — cloud infra and IaC rules

Choices are saved in `rafi-config.yaml`. The top of `AGENTS.md` shows a `# rafi: ai=off frontend=on cloud=on docs=docs` header so the active set and docs root are always visible.

## Unattended ticket loop

`rafi` drives your agents through a ticket queue — no human needed between steps:

```sh
rafi tickets init --project ./my-repo --app-name "My App"
rafi start ./my-repo --steps 5
```

- Reads compiled role bundles from `.rafi/compiled/` so each turn gets the right guidance.
- Builder, QA, planner, and ticket-maker roles are each composed from the relevant rule packs.
- Falls back to library defaults if no compiled bundle is present.

## Packages

| Package | Install | Description |
|---|---|---|
| `@rafi-ai/cli` | `npm install -g @rafi-ai/cli` | All commands — scaffold, compile, plan, tickets, start, status, doctor |
| `special-agents` | `npm install special-agents` | Rules, skills, and agent library |
| `ai-foreman` | `npm install -g ai-foreman` | Ticket-loop runtime (standalone alternative) |
| `rafi-spec` | dependency package | Shared schemas and TypeScript types used by the public packages |

Published artifacts are on npm, not GitHub Packages. That means the GitHub repository homepage can show an empty "Packages" panel even when the npm packages above are available.

## Releases and changelog

Current package versions:

| Package | Version |
|---|---|
| `@rafi-ai/cli` | `0.6.1` |
| `ai-foreman` | `1.3.0` |
| `special-agents` | `0.4.0` |
| `rafi-spec` | `0.4.0` |

- Release notes live in [CHANGELOG.md](./CHANGELOG.md).
- Release mechanics and required checks live in [RELEASING.md](./RELEASING.md).
- GitHub Releases should be created from version tags for user-visible releases. If the GitHub "Releases" panel is empty, no release tags have been published for this repository yet.

## Monorepo

```
packages/
  special-agents/   library (content + composition logic)
  rafi/             @rafi-ai/cli
  ai-foreman/       runtime
  spec/             rafi-spec schema/types package
examples/
  dummy-project/    smoke-test target
```

## License

Apache-2.0. See [LICENSE](./LICENSE).

## All Commands

`rafi` includes the ticket-loop runtime commands from `ai-foreman`. Standalone `ai-foreman` exposes the same runtime commands: `tickets`, `start`, `status`, and `doctor`. Built-in help is available with `rafi --help`, `rafi help <command>`, and each command's `--help`.

A generated help snapshot is available in [docs/cli.md](./docs/cli.md).

### Global Help

| Command | Description |
|---|---|
| `rafi --help` | Show top-level `rafi` help. |
| `rafi --version` | Print the `rafi` package version. |
| `rafi help [command]` | Show help for a command or nested command. |
| `rafi <command> -h, --help` | Show help for a specific command. |
| `ai-foreman --help` | Show top-level standalone runtime help. |
| `ai-foreman --version` | Print the standalone `ai-foreman` package version. |
| `ai-foreman help [command]` | Show help for a standalone runtime command or nested command. |

### Scaffold Commands

#### `rafi create <project>`

Runs the walkthrough, writes `rafi-config.yaml`, and compiles the target repo.

| Option | Description |
|---|---|
| `--defaults` | Skip the walkthrough and use built-in defaults. |
| `--force` | Overwrite existing doc files. |
| `--docs-root <dir>` | Use a safe repo-relative directory for Rafi starter and tracker docs. |
| `--runtime <both\|claude\|codex>` | Select which native runtime artifacts to emit. `--defaults` keeps both unless this is supplied. |
| `--root-file-mode <mode>` | Override root instruction file handling. Valid modes: `append`, `update`, `overwrite`. |

#### `rafi compile <project>`

Re-renders the native artifacts selected by `harness.targets` and always refreshes `.rafi/compiled/<role>/*` role bundles from an existing `rafi-config.yaml`.

| Option | Description |
|---|---|
| `--force` | Overwrite existing doc files. |
| `--root-file-mode <mode>` | Override root instruction file handling for this run. Valid modes: `append`, `update`, `overwrite`. |

### Planning Commands

#### `rafi plan [project]`

Runs a read-only planning agent, loads the `planner` role plus `grill-me`, and writes a ticket-maker-ready Markdown plan. Run `rafi plan .` to start the interactive planning interview; Rafi prompts for the initial brief, then the planner inspects the repo, stress-tests the plan with `grill-me`, and asks a focused follow-up question only when it is genuinely blocked.

| Option | Description |
|---|---|
| `--brief <text>` | Optional non-interactive planning brief for scripts or one-line runs. |
| `--brief-file <path>` | Optional file containing the planning brief. Use either this or `--brief`. |
| `--sources <paths...>` | Source hint files, folders, or globs to check first. |
| `-a, --agent <agent>` | Planning agent. Valid values: `claude`, `codex`. If omitted, a single `harness.targets` value in `rafi-config.yaml` is used; missing config or both targets default to Claude. |
| `-m, --model <model>` | Override the planning agent's model. |
| `--effort <level>` | Reasoning effort level. Valid values: `low`, `medium`, `high`, `xhigh`. |
| `--fast` | Fast mode with lower latency. |
| `-y, --yes` | Skip the confirmation prompt before running the planning agent. |

`rafi plan` writes every run to `<docs.root>/rafi-plans/<timestamp>.md` and refreshes `<docs.root>/rafi-plan.md`. The next step is usually:

```sh
rafi tickets populate --sources docs/rafi-plan.md
```

### Ticket Commands

Use `rafi tickets --help` for the ticket command list. The same ticket commands are available in standalone runtime form as `ai-foreman tickets ...`.

#### `rafi tickets init`

Initializes the `.tickets/` structure in a project directory.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `--app-name <name>` | Application name. |
| `--timezone <tz>` | IANA timezone. Default: `UTC`. |
| `--queue-limit <n>` | Next-queue window size. Default: `50`. |
| `--docs-root <dir>` | Override the generated ticket docs root. |

#### `rafi tickets populate`

Asks the `ticket-maker` role to populate `.tickets/tickets.yaml` from existing project ticket or backlog docs.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `-a, --agent <agent>` | Builder agent. Valid values: `claude`, `codex`. If omitted, a single `harness.targets` value in `rafi-config.yaml` is used; missing config or both targets default to Claude. |
| `-m, --model <model>` | Override the builder's model. |
| `--effort <level>` | Reasoning effort level. Valid values: `low`, `medium`, `high`, `xhigh`. |
| `--sources <paths...>` | Source hint files, folders, or globs to check first. When omitted, `tickets populate` prefers the configured Rafi `<docs.root>/rafi-plan.md`, then the ticket docs root, then `docs/rafi-plan.md`, if they exist. |
| `--fast` | Fast mode with lower latency. |
| `-y, --yes` | Skip the confirmation prompt before letting the builder edit tickets. |

#### `rafi tickets update <ticketId>`

Updates ticket status or progress fields.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `--status <status>` | New status. Valid values: `planned`, `next`, `in_progress`, `blocked`, `done`, `canceled`. |
| `--actor <actor>` | Actor making the update. |
| `--summary <text>` | Short description of the update. |
| `--next-action <text>` | What comes next for this ticket. |
| `--current-step <text>` | Current implementation step. |
| `--owner <name>` | Ticket owner. |
| `--validation-result <result>` | Validation result. Valid values: `passed`, `failed`, `not_run`, `not_applicable`. |
| `--validation-commands <cmds>` | Commands used to validate. |
| `--evidence <text>` | Evidence of correctness. |
| `--last-error <text>` | Last error message if tests failed. |

#### `rafi tickets complete <ticketId>`

Marks a ticket done with validation evidence.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `--actor <actor>` | Actor who completed this ticket. |
| `--summary <text>` | Completion summary. |
| `--validation-result <result>` | Validation result. Valid values: `passed`, `failed`, `not_run`, `not_applicable`. Default: `passed`. |
| `--validation-commands <cmds>` | Commands used to validate. |
| `--evidence <text>` | Evidence of correctness. Required unless validation is `not_applicable`. |
| `--validation-notes <text>` | Extra notes about validation. |

#### `rafi tickets block <ticketId>`

Marks a ticket as blocked.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `--blocked-by <ids...>` | Ticket IDs or labels that are blocking. |
| `--type <type>` | Blocker type, such as `dependency`, `external`, or `decision`. |
| `--summary <text>` | Description of the blocker. |
| `--unblock-criteria <text>` | What needs to happen to unblock. |
| `--actor <actor>` | Actor recording this blocker. |

#### `rafi tickets unblock <ticketId>`

Removes explicit blockers from a ticket.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `--summary <text>` | Description of how it was unblocked. |
| `--actor <actor>` | Actor who resolved the blocker. |

#### `rafi tickets cancel <ticketId>`

Cancels a ticket.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `--summary <text>` | Required. Reason for cancellation. |
| `--actor <actor>` | Actor who canceled this ticket. |

#### `rafi tickets discover`

Adds newly discovered future work to the inbox.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `--summary <text>` | Required. Short description of the discovered work. |
| `--source-ticket <id>` | Ticket that led to this discovery. |
| `--proposed-ticket <id>` | Proposed ticket ID. |
| `--priority-guess <p>` | Priority guess, such as `P0`, `P1`, `P2`, or `P3`. |
| `--area <area>` | Product or code area. |
| `--rationale <text>` | Why this work is needed. |
| `--needs-decision-from <who>` | Who needs to decide. |
| `--actor <actor>` | Actor who discovered this. |

#### `rafi tickets accept-future-work <futureWorkId>`

Promotes a future-work item into `tickets.yaml` as a new ticket.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `--ticket-id <id>` | Required. New ticket ID. |
| `--order <n>` | Required. Canonical implementation order. |
| `--actor <actor>` | Actor who accepted this item. |

#### `rafi tickets reorder <ticketId>`

Changes the canonical implementation order of a ticket.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `--after <ticketId>` | Place this ticket immediately after another. |
| `--order <n>` | Set an explicit order value. |
| `--actor <actor>` | Actor who reordered this. |

#### `rafi tickets render`

Regenerates the configured ticket progress doc from current structured sources.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |

#### `rafi tickets validate`

Runs all four validation passes and exits with status `1` on error.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |

#### `rafi tickets queue`

Prints the next-N queue to stdout.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `--limit <n>` | Override the queue limit. |

#### `rafi tickets archive`

Updates the configured ticket archive doc and prunes old completed rows.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `--older-than-days <n>` | Only archive tickets completed more than N days ago. |

#### `rafi tickets import`

Currently a stub for migrating an existing Markdown tracker.

| Option | Description |
|---|---|
| `-p, --project <dir>` | Project directory. Defaults to the current working directory. |
| `--progress <path>` | Path to an existing ticket progress Markdown file. |

### Builder And Runtime Commands

#### `rafi start <project>`

Enlists a builder and drives it through a batch of N steps.

| Option | Description |
|---|---|
| `-s, --steps <n>` | Required. Number of steps to drive. |
| `-a, --agent <agent>` | Builder agent. Valid values: `claude`, `codex`. If omitted, a single `harness.targets` value in `rafi-config.yaml` is used; missing config or both targets default to Claude. |
| `-m, --model <model>` | Override the builder's model. |
| `-r, --resume <sessionId>` | Resume a prior builder session. |
| `--continue` | Resume the most recent logged session for this project. |
| `-t, --tickets <path>` | Path to ticket file passed to the builder as context. |
| `-y, --yes` | Skip the pre-flight confirmation prompt. |
| `--effort <level>` | Reasoning effort level. Valid values: `low`, `medium`, `high`, `xhigh`. |
| `--fast` | Fast mode with lower latency. For Codex, maps to low effort. |
| `--no-qa` | Disable per-ticket QA review. QA is enabled by default. |
| `--branch-per-ticket` | Run each selected structured ticket in an isolated git worktree and branch. |
| `--create-pr` | Push each successful ticket branch and create a GitHub PR. Implies `--branch-per-ticket`. |
| `--base <ref>` | Base ref for root ticket branches. Default: current branch or `HEAD`. |
| `--branch-prefix <prefix>` | Branch name prefix for ticket branches. Default: `rafi`. |
| `--max-branch-depth <n>` | Maximum selected branch stack depth. Default: `2`. |
| `--pr-ready` | Create ready-for-review PRs instead of draft PRs. |
| `--keep-worktrees` | Keep successful ticket worktrees for inspection. |
| `--ticket <id>` | Ticket ID to continue in branch mode. Repeat for multiple tickets. |

#### `rafi status <project>`

Summarizes the most recent foreman run for a project. It has no command-specific options beyond `-h, --help`.

#### `rafi doctor [project]`

Checks Foreman, agent CLIs, config, and optional ticket tracker readiness. The project argument defaults to the current directory.

| Option | Description |
|---|---|
| `--github` | Run GitHub PR readiness checks. |

### Standalone `ai-foreman` Runtime

Replace `rafi` with `ai-foreman` for runtime commands only:

- `ai-foreman tickets ...`
- `ai-foreman start ...`
- `ai-foreman status ...`
- `ai-foreman doctor ...`

`ai-foreman create` and `ai-foreman compile` do not exist; those scaffold commands are only provided by `rafi`.
