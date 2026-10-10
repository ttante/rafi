# App-Level AI Agent Rules

Use this file as the canonical project instruction source for AI coding agents.

For Codex, copy this content into the repository root as `AGENTS.md`.
For Claude Code, create a repository-root `CLAUDE.md` that imports the same rules:

```md
@AGENTS.md
```

Keep durable process rules in this file. Put detailed project facts in the project documents named below, not in the agent rules.

Custom Rafi skills or agents can replace the defaults by setting `artifact_source: existing` and editing their paths in `rafi-config.yaml`.

For adopted Graphify projects, use the packaged `rafi-graph` skill for explicit graph requests or substantial architecture, dependency, impact, and cross-file investigations. Native sessions use scoped `rafi graph` reads under their existing permissions. Routine terminal commands, tests, formatting, bookkeeping, and handoff alone require no graph scan or update. Missing capability falls back to source inspection.
