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
rafi create . --docs-root docs-rafi  # choose the Rafi docs root explicitly
rafi compile .            # re-render after editing rafi-config.yaml
rafi compile . --root-file-mode append  # one-run override for AGENTS.md/CLAUDE.md handling
```

`rafi create` collects your stack (frontend, backend, database, cloud, package manager) and three boolean flags: `usesAI`, `hasFrontend`, `runsInCloud`. It also asks whether you'll use Claude Code — if yes, the Claude Agent SDK is installed automatically with your selected package manager (`npm`, `pnpm`, Yarn Classic/modern, or Bun). Before `create`, `start`, or `tickets populate` continue into agent work, Rafi checks the selected runtime and prompts you to repair missing authentication. If you have existing planning material, you can enter files, folders, or globs as source hints for `rafi tickets populate`; any reasonable format is OK because an agent interprets it. Stack answers and the selected docs root are saved to `rafi-config.yaml`.

| Command / option | Notes |
| --- | --- |
| `rafi create <project>` | Runs the walkthrough, writes `rafi-config.yaml`, then compiles generated files. |
| `rafi create <project> --defaults` | Uses built-in defaults without prompts. |
| `rafi compile <project>` | Re-renders generated files after editing `rafi-config.yaml`. |
| `--force` | Overwrites generated starter doc files when Rafi would otherwise preserve them. |
| `--docs-root <dir>` | Uses a safe repo-relative directory for Rafi starter and tracker docs. |
| `--root-file-mode <mode>` | One-run override for existing root instruction files: `append`, `update`, or `overwrite`. |

Existing root `AGENTS.md` and `CLAUDE.md` files are handled by `--root-file-mode` or `agent_files.mode`:

| Mode | Behavior |
| --- | --- |
| `append` | Preserve existing text and add or refresh a dated Rafi block at the end. |
| `update` | Ask an authenticated Claude Code or Codex runtime to merge existing guidance with Rafi guidance. |
| `overwrite` | Replace the file with Rafi's generated version. |

Existing skill and subagent path collisions are handled separately. Rafi can overwrite the colliding file, write its default artifact under a `*-rafi` name, or use the existing project artifact by setting `artifact_source: existing` and editing the artifact paths in `rafi-config.yaml`.

If `docs/` already exists, `rafi create` defaults to a separate `docs-rafi/` variant and persists that as `docs.root`. Legacy configs without `docs.root` still render to `docs/`.

### Ticket lifecycle

```sh
rafi tickets init --app-name "My App"   # initialize .tickets/ in the project
rafi tickets init --docs-root docs-rafi  # override tracker docs root
rafi tickets populate                    # agent fills tickets from existing docs
rafi tickets populate --sources docs/tickets.md docs/plans/**
rafi tickets queue                       # show the next-N queue
rafi tickets validate                    # run all 4 validation passes
rafi tickets render                      # regenerate the configured progress doc
```

`tickets populate` options:

| Option | Notes |
| --- | --- |
| `--sources <paths...>` | Files, folders, or globs the agent should check first. Keep using this for populate source hints. |
| `--agent <agent>` | Selects Claude or Codex. Defaults to Claude. |
| `--model <model>` / `--effort <level>` | Override the selected runtime's model and reasoning effort. |
| `--fast` | Lower-latency mode. |
| `-y, --yes` | Skip the confirmation before the agent edits ticket files. |

`--tickets` is for `rafi start`, not `rafi tickets populate`. Use `--sources` when populate should read specific planning files.

`rafi tickets init` reads `docs.root` from `rafi-config.yaml` when present and writes `ticket-progress.md` / `ticket-archive.md` under that root. If the selected progress doc already exists, init stops and asks you to choose another root.

### Run the builder

```sh
rafi start . --steps 10              # drive a Claude builder through 10 steps
rafi start . --steps 5 --agent codex # use Codex instead
rafi start . --steps 5 --no-qa       # skip per-ticket QA
rafi status .                         # summarize the most recent run
rafi doctor .                         # check env, config, and readiness
```

| Command / option | Notes |
| --- | --- |
| `rafi start <project> --steps <n>` | Runs the builder through up to `n` tickets or steps. |
| `--agent <agent>` | Selects the Claude or Codex builder runtime. |
| `--tickets <path>` | Sends a one-off task file to the builder during start preflight. |
| `--no-qa` | Skips the per-ticket QA review. |
| `--continue` / `--resume <id>` | Resume the latest or a specific logged session. |
| `rafi status <project>` | Summarizes the latest run, including branch/PR failures when present. |
| `rafi doctor <project>` | Checks environment, config, ticket tracker, and readiness. |

## What gets written

```
<project>/
  AGENTS.md                        Codex flat rules doc
  CLAUDE.md                        Claude Code entrypoint (@AGENTS.md import)
  rafi-config.yaml                 stack config and agent/skill paths (commit this)
  .claude/agents/<role>.md         Claude subagent files (builder, qa, planner, ticket-maker)
  .claude/skills/<name>/SKILL.md   Claude project skill files
  .codex/agents/<role>.toml        Codex project subagent files
  .agents/skills/<name>/SKILL.md   Codex project skill files
  .rafi/compiled/<role>/system.md  role system text — read at runtime
  .rafi/compiled/<role>/meta.json  skills + model config
  docs/                            starter doc templates, or configured docs.root
```

## Part of Rafi

- **`special-agents`** — library (rules + skills + agents + composition)
- **`ai-foreman`** — standalone runtime (same commands, separate install)
- **`@rafi-ai/cli`** — this CLI (includes everything)
