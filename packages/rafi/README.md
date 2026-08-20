# @rafi-ai/cli

Rafi is an interview-led AI application engineering CLI. It interviews you about the project, writes project-specific guidance for Claude Code and Codex, turns a brief into a ticket-maker-ready implementation plan, sets up a structured ticket queue, and can drive a builder through that queue with QA after each ticket.

It is especially useful for products that use LLMs: Rafi composes stack-aware engineering rules, skills, and role agents (`builder`, independent `qa`, `planner`, `ticket-maker`, and read-only `uninstaller`) so AI safety, evaluation, reproducibility, cost, and governance are considered from the first implementation plan.

## Install

Rafi is a command-line tool; install it globally:

```sh
npm install -g @rafi-ai/cli
```

Then run `rafi` inside the repository you want to configure. Node.js 20 or later is required.

## Guided interviews: the usual workflow

```sh
mkdir my-app && cd my-app
rafi create .              # complete setup, initial planning, and tracker journey
rafi tickets plan          # guided proposal, review, and exact ticket creation
rafi start . --steps 10    # builder works through the queue with QA
```

Start with `rafi create .`. It asks about the stack and target runtimes, writes `rafi-config.yaml`, emits the selected Claude/Codex artifacts, verifies runtime readiness, offers standard or exhaustive initial planning, and continues into ticket setup/population in the same process. `rafi plan` is the initialization-only planning stage normally run by create.

Use `rafi resume .` if an interactive interview is interrupted. For scripts or a no-prompt setup, use `rafi create . --defaults`; the complete manual-command and option reference is at [docs/cli.md](https://github.com/ttante/rafi/blob/main/docs/cli.md).

## What Rafi adds for AI applications

When `usesAI` is enabled (it is enabled by the built-in defaults), Rafi adds five AI-focused rule packs in addition to its general engineering guidance:

- **AI safety**: prompt-injection and jailbreak defenses, content-safety checks, scoped tools, abuse monitoring, red-team release criteria, and incident planning.
- **AI evals**: acceptance thresholds, quality gates, golden examples, adversarial cases, and explicit evaluation before prompt/model changes are promoted.
- **AI reproducibility**: versioned prompts plus recorded inputs, model/provider settings, tool calls, outputs, validation results, cost, latency, and decisions for meaningful generation work.
- **AI cost**: planned token/retry/tool/latency cost tracking and a correction loop for failed generations.
- **AI governance**: approved-model and fallback policies, model-change evaluation requirements, and dataset consent/retention/eligibility decisions.

Set `usesAI: false` in `rafi-config.yaml` and run `rafi compile .` to omit these AI-specific packs.

## Scaffold and compile

```sh
cd my-repo
rafi create .
rafi compile .
```

`create` saves stack answers, runtime targets, the selected documentation root, and planning-source hints in `rafi-config.yaml`. `compile` refreshes the generated guidance after you edit that config. See the [manual command reference](https://github.com/ttante/rafi/blob/main/docs/cli.md) for non-interactive defaults, runtime selection, custom docs roots, and one-run root-file-mode overrides.

Before `create`, `plan`, `start`, or `tickets populate` enters agent work, Rafi checks the selected runtime. Interactive runs offer repair/retry or a verified switch when authentication is unavailable, including a structured Claude failure that occurs after the initial probe. Provider switches start a fresh session and say that conversational continuity was not transferred. Non-interactive and `--yes` runs fail clearly rather than switching automatically. Cancelling keeps project files, configuration, and installed packages in place. Resume flows never switch providers because session IDs are provider-specific.

Claude execution is pinned to the exact system `claude` executable that passed that check; Rafi never silently falls back to the SDK-bundled CLI. The SDK wrapper belongs to Rafi's `ai-foreman` dependency and is never installed into the target application. Claude runs inherit the current environment and load user, project, local, and organization-managed settings, preserving enterprise login methods such as `/login-okta` and managed proxy/certificate configuration.

### Existing files and custom artifacts

Rafi does not silently replace existing root instructions, skills, or agents. For pre-existing `AGENTS.md` or `CLAUDE.md`, choose one of these modes during `create`, in `rafi-config.yaml`, or for one invocation with `--root-file-mode`:

| Mode | Behavior |
| --- | --- |
| `append` | Preserves existing text and adds or refreshes Rafi guidance. If the root-file guard would be exceeded, Rafi writes target-specific guidance to `AGENTS-rafi.md` or `CLAUDE-rafi.md` and places a compact reference in the root file. |
| `update` | Uses an authenticated Claude Code or Codex runtime to merge existing guidance with Rafi guidance. |
| `overwrite` | Replaces the root instruction file with the generated version. |

Rafi refuses to overwrite a non-Rafi sidecar. It also handles skill/subagent collisions independently: keep the existing artifact, write the Rafi default under a `*-rafi` path, or configure an existing artifact with `artifact_source: existing` in `rafi-config.yaml`.

If `docs/` already exists, Rafi chooses a safe `docs-rafi/` variant by default and stores it as `docs.root`. Legacy configs without `docs.root` still use `docs/`.

## Resumable interviews

Interactive `create`, `plan`, `tickets setup:init`, and `tickets setup:update` runs save compact local recovery records under `.rafi/interviews/`; Rafi adds that directory to `.gitignore`. Records contain the saved answers, checkpoint, runtime/session metadata, output fingerprints, timestamps, and redacted/truncated failure context. They do not contain raw transcripts or command output. Default-mode and non-interactive commands do not create interview records.

```sh
rafi resume .
rafi resume . --id 1234abcd
rafi resume . --discard 1234abcd
```

With no ID, `rafi resume` offers an interactive picker. Completed records are retained for 30 days; incompatible records remain until explicitly discarded. When an agent session ID is available, Rafi requests continuation with that runtime; otherwise it explains that exact continuity is unavailable and resumes from the preserved brief, answers, and checkpoint. Before writing a shared artifact, Rafi fingerprints it and stops for review if another interview changed it.

## Plan a feature

```sh
rafi plan .
```

`rafi plan` runs the read-only `planner` role in standard mode by default. `--grill-me` selects an exhaustive, one-question-at-a-time interview; `--no-grill-me` selects standard mode explicitly. It turns a brief and repository inspection into a validated Markdown plan with scope, decisions, risks, rollback notes, assessment, and ticket-maker guidance.

| Path | Purpose |
| --- | --- |
| `<docs.root>/rafi-plans/<timestamp>.md` | Versioned plan history. |
| `<docs.root>/rafi-plan.md` | Latest plan used by ticket population. |

`plan` uses the `planning.sources` captured during `rafi create`; this is separate from completed ticket setup sources. For scripted briefs, custom sources, runtime/model selection, effort, or fast mode, use the [plan command reference](https://github.com/ttante/rafi/blob/main/docs/cli.md#rafi-plan---help).

## Ticket lifecycle

```sh
rafi tickets setup:init
rafi tickets plan
rafi tickets validate
```

`tickets plan` runs a read-only guided planning conversation and applies only the exact validated proposal you approve. `tickets setup:init` / `setup:update` saves local, public URL, Linear, or Jira Cloud sources and populate/build defaults in `rafi-config.yaml`. URL snapshots are stored under ignored `.tickets/imports/`; Linear uses `LINEAR_API_KEY`, and Jira Cloud uses `JIRA_EMAIL` and `JIRA_API_TOKEN`.

`tickets populate` uses explicit sources first, then saved ticket sources, then the latest Rafi plan when available. It runs the `ticket-maker` role, writes canonical tickets to `.tickets/tickets.yaml`, renders tracker docs, and validates the tracker. Source overrides, external-import setup, agent/model controls, review, queue, render, archive, and manual ticket maintenance are in the [ticket command reference](https://github.com/ttante/rafi/blob/main/docs/cli.md#rafi-tickets---help).

Use `rafi tickets init --app-name "My App"` for standalone tracker initialization. It writes the ticket docs under `docs.root` when configured. `--implementation-limit` controls the selection/generated-doc window; `--view-limit` controls the default queue display; `--queue-limit` remains a deprecated alias for the former.

## Run the builder

```sh
rafi start . --steps 10
rafi status
rafi build:resume .
rafi agents .
rafi uninstall . --dry-run
rafi doctor .
```

`rafi doctor .` shows the resolved Claude executable, SDK-wrapper availability, setting sources, and relevant environment-variable names without printing their values. `rafi doctor . --live-claude` adds a bounded no-tools request through the same SDK path used by Rafi; it is opt-in and uses account quota. This is the decisive diagnostic when the direct `claude -p "Return exactly OK"` probe works but agent execution does not.

`rafi start` reads the compiled role bundles and drives a builder through the requested work, with QA after each ticket by default. Branch strategy, completion settings, agent selection, QA overrides, and builder-session continuation are documented in the [start command reference](https://github.com/ttante/rafi/blob/main/docs/cli.md#rafi-start---help).

QA is an independent, run-wide session and cannot edit protected project files. Interrupted implementation uses durable `.foreman/runs/*.json` checkpoints and resumes with `rafi build:resume`; setup/planning interviews continue with `rafi resume`. `rafi agents` stores per-role runtime/model/reasoning/fast intent, and `rafi uninstall` provides a category-by-category preview with drift checks and local rollback journaling.

## What gets written

```text
<project>/
  AGENTS.md                        Codex root rules, when Codex is targeted
  AGENTS-rafi.md                   Append-mode overflow sidecar, when needed
  CLAUDE.md                        Claude Code root entrypoint/rules, when Claude is targeted
  CLAUDE-rafi.md                   Append-mode overflow sidecar, when needed
  rafi-config.yaml                 Stack, runtime, planning, and artifact configuration
  .claude/agents/<role>.md         Claude subagents, when Claude is targeted
  .claude/skills/<name>/SKILL.md   Claude skills, when Claude is targeted
  .codex/agents/<role>.toml        Codex subagents, when Codex is targeted
  .agents/skills/<name>/SKILL.md   Codex skills, when Codex is targeted
  .rafi/compiled/<role>/           Runtime role bundles
  .rafi/interviews/                Ignored local interactive recovery records
  <docs.root>/                     Starter and ticket-tracker docs
  <docs.root>/rafi-plan.md         Latest Rafi plan
  <docs.root>/rafi-plans/*.md      Versioned Rafi plans
  .tickets/                        Structured ticket tracker, after ticket initialization
```

`harness.targets` controls which native Claude/Codex files are refreshed. Rafi preserves files for unselected targets rather than deleting them.

## Advanced and manual command reference

The guided interviews above are the recommended path. For every flag, non-interactive/scripted invocation, standalone ticket command, integration setting, and `ai-foreman` equivalent, use the generated [complete CLI reference](https://github.com/ttante/rafi/blob/main/docs/cli.md). You can also run `rafi --help`, `rafi help <command>`, or any command with `--help` locally.

## Part of Rafi

- [`@rafi-ai/cli`](https://www.npmjs.com/package/@rafi-ai/cli) — this all-in-one CLI.
- [`ai-foreman`](https://www.npmjs.com/package/ai-foreman) — standalone ticket-loop runtime.
- [`special-agents`](https://www.npmjs.com/package/special-agents) — rules, skills, agents, and composition library.
- [`rafi-spec`](https://www.npmjs.com/package/rafi-spec) — shared schemas and TypeScript types.

Source, issues, release notes, and the Apache-2.0 license are in the [Rafi repository](https://github.com/ttante/rafi).
