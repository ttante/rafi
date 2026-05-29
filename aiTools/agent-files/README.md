# Agent File Templates

Copy these files into a new project repository root when bootstrapping AI agent instructions.

## Files

- `AGENTS.md`: full shared rule set for Codex, Cursor, Copilot agent flows, and other tools that read `AGENTS.md`.
- `CLAUDE.md`: Claude Code wrapper that imports `AGENTS.md`.
- `GEMINI.md`: Gemini CLI wrapper that imports `AGENTS.md`.
- `.github/copilot-instructions.md`: short GitHub Copilot repository instruction summary.

## Usage

Recommended:

```sh
/path/to/aiToolsShared/scripts/bootstrap-project.sh /path/to/new-repo --no-docs
```

Manual copy:

```sh
cp agent-files/AGENTS.md /path/to/new-repo/AGENTS.md
cp agent-files/CLAUDE.md /path/to/new-repo/CLAUDE.md
cp agent-files/GEMINI.md /path/to/new-repo/GEMINI.md
mkdir -p /path/to/new-repo/.github
cp agent-files/.github/copilot-instructions.md /path/to/new-repo/.github/copilot-instructions.md
```

Keep `agent-files/AGENTS.md` synchronized with `rules.md`.
