# special-agents

29 composable best-practice rule packs, 6 skills, and 4 agent roles for Claude Code and Codex.

The content layer of [Rafi](https://github.com/ttante/foreman). Ships both the authoring source (`content/`) and prebuilt composition logic so it can be used as a library, consumed by `rafi compile`, or extended directly.

## Install

```sh
npm install special-agents
```

## Usage

```ts
import { getAgent, getSkill, emitCompiledBundles } from "special-agents";

// Get a composed role bundle (system prompt + skills list)
const { system, skills } = getAgent("builder");
// system → assembled prompt with all applicable rule packs rendered
// skills → ["tdd", "improve-codebase-architecture"]

// Write compiled role bundles + AGENTS.md + CLAUDE.md to a target repo
emitCompiledBundles("./my-repo", {
  defaults: {
    stack: { frontend: "React", backend: "Node.js", database: "PostgreSQL", cloud: "AWS", packageManager: "pnpm" },
    flags:  { usesAI: false, hasFrontend: true, runsInCloud: true },
  },
});
```

## Roles

| Role | Description |
|---|---|
| `builder` | Implements one ticket/step per turn |
| `qa` | Reviews and verifies completed work |
| `planner` | Produces the project plan and ticket list |
| `ticket-maker` | Converts requirements into structured tickets |

## Rule packs

29 packs across four categories. Conditional packs are only included when the matching flag is on.

| Category | Packs | Condition |
|---|---|---|
| base | core, git-safety, code-quality, definition-of-done, response-expectations | always |
| process | testing, tdd, ci, tickets, api-docs, release, dependencies, architecture, project-docs, business-docs | always |
| domain | security, robustness, scalability, observability, data-governance | always |
| domain | accessibility | `hasFrontend` |
| domain | ai-safety, ai-governance, ai-evals, ai-reproducibility, ai-cost | `usesAI` |
| templated | stack, database, infra | always / `runsInCloud` |

## Content structure

```
content/
  rules/         rule packs (base/, process/, domain/, templated/)
  skills/        SKILL.md units (tdd, grill-me, improve-codebase-architecture, ...)
  agents/        role manifests (builder, qa, planner, ticket-maker .yaml)
  docs/          starter doc templates for new repos
  defaults.yaml  default stack values
```

## Part of Rafi

- **`special-agents`** — this library
- **`ai-foreman`** — runtime that drives agents through a ticket loop
- **`@rafi/cli`** — CLI for `rafi create` and `rafi compile`
