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
rafi resume
rafi tickets plan
rafi build:resume
rafi start . --steps <n>
```

Run `rafi tickets plan` for new work and approve the proposed ticket set before it changes the queue. Run `rafi resume` from the project directory to select an unfinished build, setup, or planning conversation. The newest unfinished attempt appears first. `rafi build:resume` opens the build-only picker. Rafi reads the selected build’s ticket and current QA revision itself; you do not need to copy recovery flags. Explicit `--run`, `--ticket`, and `--qa-revision` remain available for scripts, with stale-state checks. Pass a project path when running from another directory. Discovery stays within that project. Live builds are inspectable; unknown ownership or an unconfirmed child launch is shown for reconciliation before another process starts. Preparation retries retain one successor, so selecting an old run ID follows its history instead of replaying the old attempt. Inspection and cancellation do not migrate recovery data or launch provider probes.

Both resume commands accept the same explicit build recovery options, including `--inspect`, `--fresh-session`, `--fresh-with-handoff`, `--yes`, and `--no`. Build recovery options cannot be used for interviews. Current-branch Builder recovery starts with the interrupted ticket and continues eligible work within the saved scope. Explicit ticket selection and QA-only recovery remain scoped to that ticket. Successful recovery completes the run when all its saved tickets are done; other unfinished tickets remain available through the resume picker.

## Helpful features

If preparation stopped before work began, the picker reconciles a registered launch before retrying its existing successor. Invalid saved start options can be corrected interactively before a retry is reserved; corrections go through normal approval. A live child or unresolved execution remains visible and cannot be bypassed by retrying. Readiness checks in worktrees remain owned by the main project's build, including their cleanup records.

A completed, cancelled, or superseded build can appear as **readiness cleanup only** if it left owned checks behind. Selecting that entry cleans only its readiness processes; it does not reopen the build or replay tickets. Another build's cleanup remains a separate selection. Missing historical ownership evidence stays visible with an explanation instead of being silently discarded.

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
