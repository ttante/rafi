# @rafi-ai/cli

Scaffold, compile, and drive your AI agent harness — all from one command.

`rafi create` reads your stack, assembles best-practice rule packs, and writes the files Claude Code and Codex read. `rafi start` drives an agent builder through a ticket queue unattended. All `ai-foreman` commands are available under `rafi`.

## Install

```sh
npm install -g @rafi-ai/cli
```

## Commands

### Scaffold & compile

```sh
cd my-repo
rafi create .             # interactive walkthrough
rafi create . --defaults  # skip walkthrough, use built-in defaults
rafi compile .            # re-render after editing project.yaml
```

`rafi create` collects your stack (frontend, backend, database, cloud, package manager) and three boolean flags: `usesAI`, `hasFrontend`, `runsInCloud`. It also asks whether you'll use Claude Code — if yes, the Claude Agent SDK is installed automatically. Answers are saved to `project.yaml`.

### Ticket lifecycle

```sh
rafi tickets init --app-name "My App"   # initialize .tickets/ in the project
rafi tickets populate                    # agent fills tickets from existing docs
rafi tickets queue                       # show the next-N queue
rafi tickets validate                    # run all 4 validation passes
rafi tickets render                      # regenerate docs/ticket-progress.md
```

### Run the builder

```sh
rafi start . --steps 10              # drive a Claude builder through 10 steps
rafi start . --steps 5 --agent codex # use Codex instead
rafi start . --steps 5 --no-qa       # skip per-ticket QA
rafi status .                         # summarize the most recent run
rafi doctor .                         # check env, config, and readiness
```

## What gets written

```
<project>/
  AGENTS.md                        Codex flat rules doc
  CLAUDE.md                        Claude Code entrypoint (@AGENTS.md import)
  project.yaml                     stack config (commit this)
  .claude/agents/<role>.md         Claude subagent files (builder, qa, planner, ticket-maker)
  .rafi/compiled/<role>/system.md  role system text — read at runtime
  .rafi/compiled/<role>/meta.json  skills + model config
  docs/                            starter doc templates (flag-gated by stack)
```

## Part of Rafi

- **`special-agents`** — library (rules + skills + agents + composition)
- **`ai-foreman`** — standalone runtime (same commands, separate install)
- **`@rafi-ai/cli`** — this CLI (includes everything)
