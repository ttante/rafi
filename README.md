# Rafi (Refined AI Framework & Implementor)

Rafi is an interview-led engineering framework for Claude Code and Codex. It helps a project decide what to build, turn that work into tickets, and implement them with QA.

Install Node.js 20+ and Rafi:

```sh
npm install -g @rafi-ai/cli
```

## Fresh Project

Create a new project, then start Rafi's setup interview:

```sh
mkdir my-project && cd my-project
rafi create .
```

The interview accepts existing plans or sources, improves a rough plan, or starts from an idea. It configures the project, writes Rafi guidance, and can hand off to initial planning and ticket setup.

The normal ticket flow is: add supporting requirements/context, approve `rafi-plan.json`, initialize ticket setup, then generate tickets from that approved plan. Supporting documents and URLs can enrich ticket details, but they never replace the plan's slices. Importing existing Linear or Jira tickets is a separate explicit setup mode.

## Adding Rafi To An Existing Project

Run the same guided setup from an existing codebase:

```sh
cd existing-repo
rafi create .
```

Answer for the stack the project already uses. Rafi retains existing project material—such as instructions, documentation, skills, agents, plans, and tickets—and adds its managed guidance around it.

## Iteration

Return to a configured project with these everyday commands:

```sh
rafi status
rafi tickets queue
rafi resume .
rafi tickets plan
rafi build:resume .
rafi start . --steps <n>
```

Use `rafi tickets plan` for a new feature, milestone, audit, or backlog update. It gathers context and produces the exact ticket set you approve. `rafi resume .` continues an interrupted setup or planning interview.

## Helpful features

### View Tickets

```sh
rafi tickets queue
rafi tickets show <id>
rafi tickets show --all --json
```

### Change Agent Settings

Set persistent role defaults for the current project:

```sh
rafi agents . --agent-type builder --agent-make codex
rafi agents . --agent-type planner --model <model> --reasoning high
```

### Transfer

Move Rafi's local state to a matching checkout:

```sh
rafi state export . --output rafi-state.rafi.gz
rafi state inspect rafi-state.rafi.gz
rafi state import /path/to/matching-checkout rafi-state.rafi.gz
```

### Uninstall

Preview removal first, then remove Rafi-managed project material:

```sh
rafi uninstall . --dry-run
rafi uninstall .
```

For flags, scripting, and advanced behavior, see the [CLI reference](./docs/cli.md).
