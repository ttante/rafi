# @rafi-ai/cli

Rafi is an interview-led engineering CLI for Claude Code and Codex. It configures a project, turns ideas into tickets, and drives implementation with QA.

Install Node.js 20+ and Rafi:

```sh
npm install -g @rafi-ai/cli
```

## Fresh Project

Create a new project and begin the setup interview:

```sh
mkdir my-project && cd my-project
rafi create .
```

The interview accepts existing plans or sources, improves a rough plan, or starts from an idea. It configures Rafi and can continue to initial planning and ticket setup.

## Adding Rafi To An Existing Project

Adopt Rafi in a repository that already exists:

```sh
cd existing-repo
rafi create .
```

Rafi retains existing project material—including instructions, docs, skills, agents, plans, and tickets—and adds managed guidance without treating the repository as a blank scaffold.

## Iteration

Use these commands as work continues:

```sh
rafi status
rafi tickets queue
rafi resume .
rafi tickets plan
rafi build:resume .
rafi start . --steps <n>
```

Run `rafi tickets plan` for new work and approve the proposed ticket set before it changes the queue. Run `rafi resume .` after an interrupted setup or planning conversation.

## Helpful features

### View Tickets

```sh
rafi tickets queue
rafi tickets show <id>
rafi tickets show --all --json
```

### Change Agent Settings

```sh
rafi agents . --agent-type builder --agent-make codex
rafi agents . --agent-type planner --model <model> --reasoning high
```

### Transfer

```sh
rafi state export . --output rafi-state.rafi.gz
rafi state inspect rafi-state.rafi.gz
rafi state import /path/to/matching-checkout rafi-state.rafi.gz
```

### Uninstall

```sh
rafi uninstall . --dry-run
rafi uninstall .
```

For flags, scripting, and advanced behavior, see the [CLI reference](https://github.com/ttante/rafi/blob/main/docs/cli.md).
