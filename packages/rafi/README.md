# @rafi-ai/cli

Scaffold and compile AI agent configs for your repo.

`rafi create` reads your stack, assembles best-practice rule packs, and writes the files Claude Code and Codex read — AGENTS.md, CLAUDE.md, subagents, and starter docs — all in one command.

## Install

```sh
npm install -g @rafi-ai/cli
```

## Use

```sh
rafi create ./my-repo             # interactive walkthrough
rafi create ./my-repo --defaults  # skip walkthrough, use built-in defaults
rafi compile ./my-repo            # re-render from an existing project.yaml
```

## Commands

### `rafi create <project>`

Runs the walkthrough (or `--defaults` to skip it), writes `project.yaml`, and compiles all configs.

```sh
rafi create ./my-repo
rafi create ./my-repo --defaults  # built-in defaults; byte-equivalent to the bundled rule set
rafi create ./my-repo --force     # overwrite existing doc files
```

The walkthrough collects your stack (frontend, backend, database, cloud, package manager) and three boolean flags: `usesAI`, `hasFrontend`, `runsInCloud`. These gate which rule packs are included. Answers are saved to `project.yaml`.

### `rafi compile <project>`

Re-renders all configs from an existing `project.yaml`. Run this after editing the config or upgrading `special-agents`.

```sh
rafi compile ./my-repo
rafi compile ./my-repo --force
```

## What gets written

```
<project>/
  AGENTS.md                        Codex flat rules doc
  CLAUDE.md                        Claude Code entrypoint (@AGENTS.md import)
  project.yaml                     stack config (commit this)
  .claude/agents/<role>.md         Claude subagent files (builder, qa, planner, ticket-maker)
  .rafi/compiled/<role>/system.md  role system text — read by ai-foreman at runtime
  .rafi/compiled/<role>/meta.json  skills + model config
  docs/                            starter doc templates (flag-gated by stack)
```

## Part of Rafi

- **`special-agents`** — library (rules + skills + agents + composition)
- **`ai-foreman`** — runtime that drives agents through a ticket loop
- **`@rafi-ai/cli`** — this CLI
