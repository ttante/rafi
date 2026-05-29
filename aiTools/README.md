# AI Tools Shared Rules

This repository stores reusable app-level AI agent rules for new software projects.

The canonical rule source is [`rules.md`](./rules.md). For each new repo, copy it into the repo root as `AGENTS.md`, then add thin tool-specific wrappers only when a tool requires a different filename.

The [`agent-files/`](./agent-files/) directory contains copy-ready AI agent instruction files for Codex, Claude Code, Gemini CLI, and GitHub Copilot.

The [`docs/`](./docs/) directory contains starter documentation templates for architecture, features, APIs, users, admins, business notes, operations, security, data governance, local/cloud runtime, releases, tickets, AI planning, AI evals, AI cost tracking, scalability, decision history, and ADRs.

## Quick Start

From any new or existing project repo, run:

```sh
/path/to/aiToolsShared/scripts/bootstrap-project.sh .
```

The script installs:

- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- `.github/copilot-instructions.md`
- starter `docs/` templates
- `CHANGELOG.md`
- `.env.example`

By default, existing files are skipped so local work is not overwritten. Use `--force` only when you intentionally want to replace existing files:

```sh
/path/to/aiToolsShared/scripts/bootstrap-project.sh . --force
```

Agent files only:

```sh
/path/to/aiToolsShared/scripts/bootstrap-project.sh . --no-docs
```

## Rules

The rules define how AI coding agents should build and maintain projects, including:

- test-driven development
- required test and quality checks
- senior-level code quality expectations
- API, user, admin, business, architecture, and operations documentation
- ticket tracking and future-work logging
- security, privacy, robustness, observability, and release requirements
- post-update rule-compliance reporting

Keep `rules.md` as the source of truth. Avoid maintaining separate hand-edited copies for each AI tool unless a tool cannot read or import the shared file.

## Recommended Setup For New Repos

Create this baseline in every new repo:

```text
AGENTS.md
CLAUDE.md
GEMINI.md
.github/copilot-instructions.md
README.md
docs/
```

Use `AGENTS.md` as the shared agent instruction file. The copy-ready version is in `agent-files/AGENTS.md` and contains the full rule set from `rules.md`.

```sh
cp /path/to/aiToolsShared/agent-files/AGENTS.md AGENTS.md
```

Then copy the tool wrappers:

```sh
cp /path/to/aiToolsShared/agent-files/CLAUDE.md CLAUDE.md
cp /path/to/aiToolsShared/agent-files/GEMINI.md GEMINI.md
mkdir -p .github
cp /path/to/aiToolsShared/agent-files/.github/copilot-instructions.md .github/copilot-instructions.md
```

Copy any relevant starter docs from this repository's `docs/` directory into the new repo, then replace placeholders with project-specific details.

The bootstrap script does this setup automatically. Manual copying is mainly useful when you want only a few specific files.

For most new app repos, copy this starter set:

```text
docs/architecture.md
docs/features.md
docs/api.md
docs/users.md
docs/admins.md
docs/business.md
docs/operations.md
docs/security.md
docs/data-governance.md
docs/local-cloud.md
docs/scalability.md
docs/tickets.md
docs/release-checklist.md
docs/decisions/
CHANGELOG.md
.env.example
```

For AI-heavy apps, also copy:

```text
docs/ai.md
docs/ai-evals.md
docs/ai-costs.md
```

## Tool Setup

| Tool | Recommended file setup | Notes |
|---|---|---|
| Codex CLI | `AGENTS.md` | Codex reads `AGENTS.md` before work starts. |
| Claude Code | `CLAUDE.md` containing `@AGENTS.md` | Claude Code reads `CLAUDE.md`, not `AGENTS.md`, but supports importing `AGENTS.md`. |
| Cursor | `AGENTS.md` | Cursor supports root-level `AGENTS.md` as a simple alternative to `.cursor/rules`. |
| GitHub Copilot | `AGENTS.md`; optionally `.github/copilot-instructions.md` | Copilot supports `AGENTS.md` for agent instructions. Add `.github/copilot-instructions.md` if you want repository-wide Copilot instructions outside agent-specific flows. |
| Gemini CLI | `GEMINI.md` containing `@AGENTS.md`, or configure Gemini to read `AGENTS.md` | Gemini CLI defaults to `GEMINI.md`, supports imports, and can be configured to include `AGENTS.md` as a context filename. |
| Windsurf / Cascade | `AGENTS.md`; optionally `.windsurf/rules/*.md` | Windsurf can infer rules from `AGENTS.md`. Use `.windsurf/rules` for scoped or activation-mode-specific rules. |
| Cline | `AGENTS.md`; optionally `.clinerules/*.md` | Cline recognizes `AGENTS.md` and its own `.clinerules/` directory. |

## Example Files

The copy-ready versions live in [`agent-files/`](./agent-files/).

### `CLAUDE.md`

```md
@AGENTS.md
```

### `GEMINI.md`

```md
@AGENTS.md
```

### `.github/copilot-instructions.md`

Use this only if you want Copilot repository-wide instructions in addition to `AGENTS.md`.

```md
Follow the repository agent rules in AGENTS.md.

Key expectations:
- use test-driven development where practical
- run relevant tests and quality checks after updates
- keep docs, tickets, API docs, and architecture notes current
- report rule-compliance results after every update
```

Do not rely on every tool to resolve links or imports inside every instruction format. If a tool does not import `AGENTS.md`, duplicate only the short summary needed for that tool and keep `AGENTS.md` as the full source of truth.

## Maintenance Guidance

- Update `rules.md` first.
- Keep `agent-files/AGENTS.md` synchronized with `rules.md`.
- When starting a new project, copy the latest files from `agent-files/` into that project.
- Keep wrapper files short so they do not drift.
- If a project intentionally changes the stack, testing approach, docs structure, or ticketing process, update that project's `AGENTS.md` and architecture docs.
- Periodically ask the agent to summarize the active instruction files so you can confirm the tool is loading the expected rules.

## Reference Links

- Codex custom instructions with `AGENTS.md`: https://developers.openai.com/codex/guides/agents-md
- Claude Code memory and `CLAUDE.md`: https://code.claude.com/docs/en/memory
- Cursor rules and `AGENTS.md`: https://docs.cursor.com/context/rules-for-ai
- GitHub Copilot repository custom instructions: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions
- Gemini CLI `GEMINI.md` context files: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md
- Windsurf Cascade memories and rules: https://docs.windsurf.com/windsurf/cascade/memories
- Cline rules: https://docs.cline.bot/customization/cline-rules
