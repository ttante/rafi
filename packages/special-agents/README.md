# special-agents

Rafi library — composable best-practice rules, skills, and agents for Claude Code and Codex.

`special-agents` is the content layer of the [Rafi](https://github.com/ttante/foreman) toolkit. It holds the raw rule packs, skill manifests, agent role definitions, and the composition logic that assembles them into harness-ready configs.

## Install

```sh
npm install special-agents
```

## API

```ts
import { getAgent, getSkill, composeRulesMarkdown, emitCompiledBundles } from "special-agents";

// Get a composed role bundle (system prompt + skills list)
const builder = getAgent("builder");
console.log(builder.system);   // assembled system prompt
console.log(builder.skills);   // ["tdd", "improve-codebase-architecture"]

// Compile configs into a target repo
emitCompiledBundles("/path/to/repo", {
  defaults: { stack: { frontend: "React", backend: "Node.js", ... }, flags: { ... } },
});
```

## Roles

| Role | Description |
|---|---|
| `builder` | Implements one ticket/step per turn |
| `qa` | Reviews and verifies completed work |
| `planner` | Produces the project plan and ticket list |
| `ticket-maker` | Converts requirements into structured tickets |

## Adoption ladder

You can stop at any rung — each is independently useful:

1. **A rule** — grab one rule pack from `content/rules/`.
2. **A skill** — copy a skill from `content/skills/` into `.claude/skills/`.
3. **An agent** — use a composed role in plain Claude Code or Codex.
4. **The runtime** — `ai-foreman` drives agents through a ticket loop.

## Content structure

```
content/
  rules/          rule packs (base, process, domain, templated)
  skills/         SKILL.md units (tdd, grill-me, ...)
  agents/         role manifests (builder, qa, planner, ticket-maker)
  docs/           starter doc templates for new repos
  defaults.yaml   default stack values
```

## Part of Rafi

- **`special-agents`** — this library (rules + skills + agents + composition)
- **`ai-foreman`** — runtime that drives agents through tickets
- **`@rafi/cli`** — CLI for `rafi create` and `rafi compile`
