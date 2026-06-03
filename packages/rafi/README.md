# @rafi-ai/cli

Scaffold and compile AI agent configs for your repo.

`rafi create` reads your stack, assembles best-practice rule packs, and writes the files Claude Code and Codex read — AGENTS.md, CLAUDE.md, subagents, and starter docs — all in one command.

## Install

```sh
npm install -g @rafi-ai/cli
```

## Use

Run `rafi` from inside the target repo:

```sh
cd my-repo
rafi create .             # interactive walkthrough
rafi create . --defaults  # skip walkthrough, use built-in defaults
rafi compile .            # re-render after editing project.yaml
```

## Commands

### `rafi create .`

Runs the walkthrough (or `--defaults` to skip it), writes `project.yaml`, and compiles all configs.

```sh
rafi create .
rafi create . --defaults  # built-in defaults; byte-equivalent to the bundled rule set
rafi create . --force     # overwrite existing doc files
```

The walkthrough collects your stack (frontend, backend, database, cloud, package manager) and three boolean flags: `usesAI`, `hasFrontend`, `runsInCloud`. It also asks whether you'll use Claude Code — if yes, the Claude Agent SDK is installed automatically. Answers are saved to `project.yaml`.

### `rafi compile .`

Re-renders all configs from an existing `project.yaml`. Run this after editing the config or upgrading `special-agents`.

```sh
rafi compile .
rafi compile . --force
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
