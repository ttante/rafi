# Rafi — Refined AI Framework & Implementor

Rafi is a harness-engineering toolkit that turns best-practice guidelines into composable, machine-readable configs for Claude Code and Codex. It is structured as three independently useful layers:

```
special-agents (library)  ←  rafi create / rafi compile (CLI)
        ↑
   ai-foreman (runtime)
```

## Adoption ladder

You can stop at any rung:

1. **A rule** — grab one rule pack from `special-agents/content/rules/` and paste it into your project.
2. **A skill** — copy a skill from `special-agents/content/skills/` into `.claude/skills/`. Works in plain Claude Code today.
3. **An agent** — use a composed `builder`/`qa`/`planner`/`ticket-maker` agent in Claude Code or Codex via `rafi create`.
4. **The runtime** — `ai-foreman` drives those agents through a ticket loop, unattended.

## Packages

| Package | npm | Command | Role |
|---|---|---|---|
| `special-agents` | `npm install special-agents` | — | Library: rules, skills, agents, composition logic |
| `ai-foreman` | `npm install -g ai-foreman` | `ai-foreman` | Runtime: orchestrates agents through ticket queues |
| `@rafi/cli` | `npm install -g @rafi/cli` | `rafi` | CLI: scaffold and compile configs for a target repo |

## Quick start

```sh
# Install the CLI
npm install -g @rafi/cli

# Scaffold a new project (interactive walkthrough)
rafi create /path/to/my-repo

# Or use defaults (byte-equivalent to the built-in defaults)
rafi create /path/to/my-repo --defaults

# Re-compile after editing project.yaml
rafi compile /path/to/my-repo
```

## What `rafi create` writes

```
<project>/
  AGENTS.md                        Codex flat rules doc
  CLAUDE.md                        Claude Code entrypoint
  project.yaml                     your stack config (committed, editable)
  .claude/agents/<role>.md         Claude Code subagent files
  .rafi/compiled/<role>/system.md  role system text (read by ai-foreman)
  docs/                            starter doc templates (flag-gated by stack)
```

## Conditional packs

`rafi create` asks whether your app uses AI (`usesAI`), has a frontend (`hasFrontend`), and runs in the cloud (`runsInCloud`). The answers gate which rule packs are included. The choices are recorded in `project.yaml` and visible in the `# rafi:` header at the top of `AGENTS.md`.

```sh
# Add AI rules after the fact
# Edit project.yaml: flags.usesAI: true
rafi compile /path/to/my-repo
```

## Running the runtime

```sh
npm install -g ai-foreman
ai-foreman start /path/to/my-repo --steps 5
```

`ai-foreman` loads the compiled role bundles from `.rafi/compiled/`, falls back to the `special-agents` library defaults, and falls back further to built-in hardcoded prompts — so it works with or without a compiled project.

## Monorepo structure

```
packages/
  special-agents/   library (content + composition logic)
  rafi/             @rafi/cli
  ai-foreman/       runtime
  spec/             internal schema package (unpublished)
examples/
  dummy-project/    smoke-test target for ai-foreman
```
