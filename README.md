# Rafi (Refined AI Framework & Implementor)

A lightweight + powerful harness engineering framework. Your best bet for everything from one-shot builds to small feature implementation. Especially helpful for building enterprise level AI features.

## Features
- Composes best-practice rules into skills into agents (builder, QA, planner, ticket-maker)
- In-stack rules for AI | frontend | cloud | backend
- `ai-foreman` (robust ticketing/tracking solution):
- Sets up + populates tickets via specialized-agent
- Drives agents through tickets with built-in QA cycling per step

## How
- enforces strict test driven development (TDD)
- enterprise level stability & security features from square one
- rock solid task tracking
- future work identified + documented
- QA-coupled builder ensure: code quality | testing | regression protection

## AI App Superbuilder

Rafi shines even brighter when building apps that leverage LLMs. Enable `usesAI` and your agents get five additional rule packs that enforce enterprise-grade AI engineering from the first line of code:

- **Adversarial safety** — agents plan prompt injection defense, jailbreak protection, content safety checks, tool scoping, and abuse monitoring before writing any AI feature. Red-teaming is built into release criteria. An incident plan for harmful, wrong, expensive, or policy-violating outputs is required.
- **Confidence & evals** — every AI generation step gets quality gates, confidence scoring, and acceptance thresholds. Models check their own work three times by default (configurable). Eval suites with golden examples and adversarial cases are required before promoting any prompt change.
- **Full replayability** — every meaningful AI generation is recorded with prompt version, rendered prompt, input references, model/provider, parameters, tool calls, output, validation results, cost, latency, and decisions. Prompts are versioned, reviewed, tested, and rollback-capable.
- **Cost tracking & learning loop** — cost per task is tracked across tokens, retries, tool calls, and latency. Failed generations feed a structured correction workflow; approved corrections are preserved in a format suitable for future evals, fine-tuning, or custom model training — all planned from day one.
- **Model & dataset governance** — approved models, fallbacks, and change rules are documented. Model changes require evals. Dataset consent, labeling quality, retention, and training eligibility are defined before data is collected.

## Install

```sh
npm install -g @rafi-ai/cli
```

## Use

Run `rafi` from inside the target repo:

- Answer 9 questions about your stack (or skip with `--defaults`)
- Get `AGENTS.md`, `CLAUDE.md`, subagents, and starter docs written to your repo
- If you say yes to Claude Code, the Claude Agent SDK is installed automatically
- Re-run `rafi compile` whenever you update `project.yaml`

```sh
cd my-repo
rafi create .             # interactive walkthrough
rafi create . --defaults  # skip walkthrough, use built-in defaults
rafi compile .            # re-render after editing project.yaml
```

## Defaults

`--defaults` (and the starting point for the walkthrough) uses these values:

| Setting | Default |
|---|---|
| Frontend | React with TypeScript |
| Backend | Node.js, Python, or both |
| Database | PostgreSQL |
| Cloud | AWS |
| Package manager | pnpm |
| Has frontend | ✓ |
| Uses AI | ✗ (opt-in — enables the AI App Superbuilder packs) |
| Runs in cloud | ✓ |

Edit `project.yaml` and run `rafi compile` to change anything.

## What gets written

```
my-repo/
  AGENTS.md                        Codex rules doc (your stack + best practices, flat)
  CLAUDE.md                        Claude Code entrypoint
  project.yaml                     your stack config — commit this, edit to update
  .claude/agents/builder.md        Claude subagent — implements tickets
  .claude/agents/qa.md             Claude subagent — reviews completed work
  .claude/agents/planner.md        Claude subagent — plans and writes tickets
  .rafi/compiled/<role>/           role bundles read by ai-foreman at runtime
  docs/                            starter docs (architecture, API, ops, etc.)
```

## Suggested Use

### New Projects

- Create an empty repo and run rafi from inside it
  ```sh
  mkdir my-repo && cd my-repo
  rafi create .
  ```
- Open Claude Code and use the `planner` subagent — it will grill you on goals, users, and requirements before writing a full PRD (more detail than your average planner)
  ```sh
  claude .
  ```
- Use the ticket-maker agent to convert the plan into a structured, ordered ticket queue
  ```sh
  rafi tickets init --app-name "My App"
  rafi tickets populate
  ```
- Run the builder to implement tickets one by one, with QA after each step
  ```sh
  rafi start . --steps 10
  ```

### Existing Projects

- Navigate into the repo and run rafi — answer questions about your current stack, or use `--defaults` and edit `project.yaml` to match reality
  ```sh
  cd my-repo
  rafi create .
  ```
- Enable the flags that match your stack (`usesAI`, `hasFrontend`, `runsInCloud`) and re-compile to get the right rule packs
  ```sh
  # edit project.yaml, then:
  rafi compile .
  ```
- Import your existing backlog — populate from planning docs, a ticket file, or a markdown roadmap
  ```sh
  rafi tickets init --app-name "My App"
  rafi tickets populate
  ```
- Run the builder against your backlog; QA cycles and future-work tracking keep the queue clean as work completes
  ```sh
  rafi start . --steps 10
  ```

## Rule packs

All 29 packs are assembled from your stack config. Most are always included; three groups are conditional:

- **Always** — code quality, git safety, testing, TDD, CI, security, observability, robustness, scalability, data governance, API docs, release, architecture, and templated stack rules (frontend framework, backend, database, package manager substituted from your answers)
- **`usesAI`** — AI safety, evals, cost tracking, reproducibility, and AI governance rules
- **`hasFrontend`** — accessibility and UX rules
- **`runsInCloud`** — cloud infra and IaC rules

Choices are saved in `project.yaml`. The top of `AGENTS.md` shows a `# rafi: ai=off frontend=on cloud=on` header so the active set is always visible.

## Unattended ticket loop

`rafi` drives your agents through a ticket queue — no human needed between steps:

```sh
rafi tickets init --project ./my-repo --app-name "My App"
rafi start ./my-repo --steps 5
```

- Reads compiled role bundles from `.rafi/compiled/` so each turn gets the right guidance.
- Builder, QA, planner, and ticket-maker roles are each composed from the relevant rule packs.
- Falls back to library defaults if no compiled bundle is present.

## Packages

| Package | Install | Description |
|---|---|---|
| `@rafi-ai/cli` | `npm install -g @rafi-ai/cli` | All commands — scaffold, compile, tickets, start, status, doctor |
| `special-agents` | `npm install special-agents` | Rules, skills, and agent library |
| `ai-foreman` | `npm install -g ai-foreman` | Ticket-loop runtime (standalone alternative) |

## Monorepo

```
packages/
  special-agents/   library (content + composition logic)
  rafi/             @rafi-ai/cli
  ai-foreman/       runtime
  spec/             internal schema (unpublished)
examples/
  dummy-project/    smoke-test target
```
