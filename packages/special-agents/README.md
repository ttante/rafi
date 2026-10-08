# special-agents

Composable best-practice rule packs, skills, and agent roles for Claude Code and Codex.

The content layer of [Rafi](https://github.com/ttante/rafi). Ships both the authoring source (`content/`) and prebuilt composition logic so it can be used as a library, consumed by `rafi compile`, or extended directly.

## Install

```sh
npm install special-agents
```

## Usage

```ts
import { getAgent, loadSkill, emitCompiledBundles } from "special-agents";

// Get a composed role bundle (system prompt + skills list)
const { system, skills } = getAgent("builder");
// system → assembled prompt with all applicable rule packs rendered
// skills → ["handoff", "tdd", "improve-codebase-architecture"]

// Read a standalone implementation workflow
const implementor = loadSkill("implementor");

// Write compiled role bundles to a target repo
emitCompiledBundles("./my-repo", {
  defaults: {
    stack: { frontend: "React", backend: "Node.js", database: "PostgreSQL", cloud: "AWS", packageManager: "pnpm" },
    flags:  { usesAI: false, hasFrontend: true, runsInCloud: true },
  },
});
```

## Implementor skill

[`implementor`](content/skills/implementor/SKILL.md) carries a scoped feature, bug fix, or plan through implementation, verification, a durable checkpoint, review, and corrections. It supports compact-then-audit workflows, prefers an independent final review when available and permitted, and labels the fallback as self-review. Its [review checklist](content/skills/implementor/references/review.md) checks requirements separately from code quality and asks for evidence behind findings.

New Rafi projects include it in their default skill configuration. For an existing project with an explicit `skills` map, merge this entry under `skills` in `rafi-config.yaml`, then run `rafi compile .` using a CLI build containing this skill:

```yaml
skills:
  implementor:
    artifact_source: rafi
    claude: ./.claude/skills/implementor/SKILL.md
    codex: ./.agents/skills/implementor/SKILL.md
```

Compilation copies the skill and its review reference into the selected runtimes' skill directories. In an agent session, request it by name, for example: "Use the implementor skill to implement the plan in docs/plan.md, then audit and fix the result."

The skill provides workflow instructions; actual compaction and independent review depend on the host's capabilities and permissions. When used within Rafi's Builder/QA loop, it respects the assigned step and host-owned review and handoff protocols.

## Roles

| Role | Description |
|---|---|
| `builder` | Implements one ticket/step per turn |
| `qa` | Reviews and verifies completed work |
| `planner` | Produces the project plan and ticket list |
| `ticket-maker` | Converts requirements into structured tickets |

## Rule packs

30 packs across four categories. Conditional packs are only included when the matching flag is on.

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
- **`@rafi-ai/cli`** — CLI for `rafi create` and `rafi compile`
