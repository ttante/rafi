# @rafi/cli

CLI for the [Rafi](https://github.com/ttante/foreman) toolkit — scaffold and compile AI framework configs for a target repo.

## Install

```sh
npm install -g @rafi/cli
```

## Commands

### `rafi create <project>`

Run the interactive walkthrough, write `project.yaml`, and compile configs into the target repo.

```sh
rafi create /path/to/my-repo
rafi create /path/to/my-repo --defaults   # skip walkthrough, use built-in defaults
rafi create /path/to/my-repo --force      # overwrite existing doc files
```

The walkthrough collects your stack (frontend, backend, database, cloud, package manager), whether the app uses AI, and whether to include QA. Answers are saved to `project.yaml` in the target repo.

### `rafi compile <project>`

Re-render configs from an existing `project.yaml` (for after you hand-edit the config or upgrade `special-agents`).

```sh
rafi compile /path/to/my-repo
rafi compile /path/to/my-repo --force
```

## What gets written

```
<project>/
  AGENTS.md                        Codex flat rules doc
  CLAUDE.md                        Claude Code entrypoint (@AGENTS.md import)
  project.yaml                     your stack config (committed, human-editable)
  .claude/agents/<role>.md         Claude subagent files
  .rafi/compiled/<role>/system.md  role system text (read by ai-foreman at runtime)
  .rafi/compiled/<role>/meta.json  skills + model config
  docs/                            starter doc templates (flag-gated)
```

## Part of Rafi

- **`special-agents`** — library (rules + skills + agents + composition)
- **`ai-foreman`** — runtime that drives agents through tickets
- **`@rafi/cli`** — this CLI
