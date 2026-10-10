# Graphify guide for agents on this machine

Graphify is installed once for macOS user `tyler` and can be used from any repository. Each checkout has its own exclusions and generated graph. Read the destination repo's `AGENTS.md`, preserve existing changes, and run commands from that repo's root.

## Installed tools

Verified on 2026-10-09:

| Item | Location or value |
|---|---|
| Official package | `graphifyy==0.9.82` (double `y`) |
| Shell command | `/Users/tyler/.local/bin/graphify` |
| Isolated Python | `/Users/tyler/.local/share/graphify/venv/bin/python` |
| Codex skill | `/Users/tyler/.codex/skills/graphify/SKILL.md` |
| Generic Agent Skills | `/Users/tyler/.agents/skills/graphify/SKILL.md` |
| Claude skill | `/Users/tyler/.claude/skills/graphify/SKILL.md` |

The executable is a symlink into the isolated environment. `~/.local/bin` is already on this machine's shell PATH. No system Python packages or app dependencies were changed. Global instructions in `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md` require the shared freshness workflow for adopted repos. No Git hooks, background watchers, MCP servers, hosted service, or separate model API backend were configured.

## Automatic updates during agent tasks

Both Codex and Claude apply the [shared trigger gate](graphify-agent-workflow.md), installed at `/Users/tyler/.local/share/graphify/agent-workflow.md`. Graphify runs for explicit graph requests, substantial architecture/cross-file investigations that benefit from it, and meaningful changes to indexed code relationships or documented domain behavior. A qualifying investigation may scan once before querying; a qualifying editing task batches one final incremental update and verifies it once.

Routine terminal commands (including `rafi tickets queue`), status inspection, tests, formatting, logs, ticket bookkeeping, and agent/Graphify-policy edits do not trigger scans or updates. Changed bytes alone do not justify rebuilding. Missing graphs are built only on explicit build/adoption requests. Deferred incidental edits remain unstamped until the next qualifying refresh.

The same policy is in global Codex and Claude instructions and all three installed Graphify skills. This repo's `CLAUDE.md` imports `AGENTS.md`. No per-command hooks or idle background process are installed. Restart existing agent sessions to load the revised global instructions. Semantic updates use the active assistant's model usage.

This is the [official Graphify repository](https://github.com/Graphify-Labs/graphify), whose [package metadata](https://github.com/Graphify-Labs/graphify/blob/5b74d7d74911cf435c8f1636b6f96ea202cc6246/pyproject.toml) identifies [graphifyy on PyPI](https://pypi.org/project/graphifyy/0.9.82/). Do not install similarly named packages.

## Adopt in another repository

1. Run `git status --short` and read local agent instructions. The machine installation does not need to be repeated.
2. Verify `graphify --version`. If the agent's shell lacks PATH configuration, use `/Users/tyler/.local/bin/graphify` directly.
3. Inspect the directory layout, then merge appropriate exclusions into `.graphifyignore`. Do not replace existing ignore rules.
4. Add `graphify-out/` to `.gitignore` unless that repo deliberately versions graph artifacts. Graph outputs can contain source excerpts, paths, and documentation content.
5. Read the installed skill and build the graph using one of the workflows below. Restart the agent session if newly installed global skills are not listed.
6. Verify the detected corpus, graph integrity, and one query. Add a pointer to the shared freshness workflow in that repo's agent instructions. For Claude, preserve existing `CLAUDE.md` content and import `AGENTS.md` if it is the canonical rule file. Global freshness instructions already apply to adopted repos on this machine.

Suggested `.graphifyignore` baseline, used in moneyTree:

```gitignore
# Hidden directories at any depth
.*/
graphify-out/
node_modules/
dist/
build/
coverage/
.env
.env.*
!.env.example
.DS_Store
*.pem
*.key
```

Graphify also reads `.gitignore`. `.*/` excludes directories with names beginning with a dot, including nested ones; it does not exclude every dotfile. Before copying this policy elsewhere, check whether hidden folders hold meaningful project inputs such as `.github/workflows`, `.storybook`, or `.devcontainer`. If those need indexing, replace the blanket rule with specific tooling-directory exclusions. Sensitive files should remain excluded.

In moneyTree, `.git`, `.foreman`, `.rafi`, `.tickets`, `.agents`, and `.codex` hold version control, builder state/history, ticket storage, and agent tooling. They are intentionally excluded from the project knowledge graph. They remain available for normal agent instructions and Rafi operations. Visible plans in `overview-plan.md` and `docs/` remain included.

## Inspect the corpus before building

Run this from the destination repo root:

```bash
/Users/tyler/.local/share/graphify/venv/bin/python - <<'PY'
from pathlib import Path
from graphify.detect import detect

root = Path.cwd().resolve()
result = detect(root)
for category, files in result['files'].items():
    print(f'{category}: {len(files)}')
    for filename in files:
        print(' ', Path(filename).relative_to(root))
print('Potentially sensitive files skipped:', len(result.get('skipped_sensitive', [])))
PY
```

Review unexpected files before extraction. Graphify supports some configuration files and treats JSON as code; a nonzero code-file count does not necessarily mean the repo contains implemented application code.

## Build and refresh

For deterministic local code parsing, with no model calls:

```bash
graphify extract . --code-only
graphify cluster-only .
graphify export html
```

This skips semantic extraction of docs and media. The clustering command generates the report; extraction alone writes the graph data. For a repo consisting only of plans, use the assistant skill to obtain a useful semantic graph. In Codex, invoke `$graphify .`; in Claude, invoke `/graphify .`. These are assistant commands, not shell commands. An agent can also read the installed `SKILL.md` and execute its workflow directly.

The machine freshness policy uses the host assistant for semantic extraction; this consumes the current assistant's model usage. Its workflow can use parallel extraction agents when supported. Follow local agent permissions and the shared policy. The upstream skill can route through Gemini when a key is present, but the machine policy requires repo-specific authorization before using a separate backend. Do not configure one just to make extraction work.

Refresh a semantic graph through the assistant with `$graphify . --update` (Codex) or `/graphify . --update` (Claude). For a graph intentionally limited to code, rerun `graphify extract . --code-only`. Do not use a code-only rebuild to refresh a mixed docs/code graph: it cannot refresh the semantic content.

Keep the working directory at the repo root so output is written to its own `graphify-out/`. Outputs include `graph.json`, `GRAPH_REPORT.md`, and, after HTML export, `graph.html`. Open the visualization with `open graphify-out/graph.html` on this Mac.

## Use the graph

```bash
graphify query "How does authentication connect to storage?" --budget 1500
graphify explain "Exact label from this graph"
graphify path "First label" "Second label"
```

Choose terms that actually exist in the repo. Query the graph to locate relevant files, then read the cited sources before editing or making a precise claim. An absent node is not proof that a feature is absent; exclusions, stale graphs, and extraction coverage affect results. Distinguish `EXTRACTED`, `INFERRED`, and `AMBIGUOUS` relationships. Planning documents describe intended behavior, not necessarily implemented behavior.

## Maintenance and troubleshooting

Use the isolated interpreter for imports and package checks:

```bash
/Users/tyler/.local/share/graphify/venv/bin/python -m pip check
/Users/tyler/.local/share/graphify/venv/bin/python -m pip show graphifyy
```

If `python3` cannot import Graphify, use the interpreter above. Do not install into system Python or use `--break-system-packages`. The skill's `graphify-out/.graphify_python` should point to the isolated interpreter. If Homebrew removes the Python installation underlying this environment, recreate the environment and symlink, then reinstall the skills.

For an intentional upgrade, first review the target release, install that explicit version in this same environment, and refresh the skill copies:

```bash
/Users/tyler/.local/share/graphify/venv/bin/python -m pip install 'graphifyy==<reviewed-version>'
graphify install --platform codex
graphify install --platform agents
graphify install --platform claude
```

Then restore the selective skill description, machine trigger-policy section, and gated existing-graph fast path in all three installed skill copies; skill reinstallation overwrites these customizations. Keep the global instruction blocks and `/Users/tyler/.local/share/graphify/agent-workflow.md`. Validate the package and policy; rebuild per-repo graphs only when the reviewed upgrade requires it. Preserve user changes to skill files before refreshing them.

## Prompt to give another agent

> Use the existing Graphify installation on this machine. Read `/Users/tyler/reps/moneyTree/docs/graphify-agent-guide.md` and your repo's agent rules. Configure appropriate per-repo exclusions, keeping hidden tooling folders out unless they contain relevant source or configuration. Build and verify this repo's graph using the installed skill. Follow `/Users/tyler/.local/share/graphify/agent-workflow.md` in both Codex and Claude: apply the explicit trigger gate before scans or updates, batch meaningful changes, and skip routine commands and bookkeeping. Preserve existing changes. Do not add a separate model backend or paid service without authorization.

## Initial moneyTree verification

The automatic freshness check has a repeatable local fixture test:

```bash
/Users/tyler/.local/share/graphify/venv/bin/python scripts/check-graphify-freshness.py
```

It covers missing graphs/manifests, unchanged inputs, code/doc edits, additions, renames/deletions, exclusion changes, hidden folders, corrupt/empty graphs, and preservation of the extraction manifest during checks. Both agents' installed policy blocks and all three skill frontmatters were validated. The skill-creator Python validator requires unavailable PyYAML; Ruby's YAML parser was used to check the unchanged frontmatter instead.

The initial graph covers all 26 eligible documents. Two JSON plan files were detected as code but produced no AST nodes; their Markdown counterparts are indexed. The graph contains 152 nodes and 386 edges. Integrity checks found no dangling endpoints, self-loops, or collapsed edges. Local code extraction, clustering/report generation, HTML export, query, explain, and path commands passed smoke tests. Root and nested hidden-folder exclusions, generated/dependency exclusions, and `.env` exclusion passed fixture checks; package requirements passed `pip check`.

The repository currently contains plans and documentation rather than application code, so there is no app test, lint, typecheck, or build command to run. Graph results remain model-generated navigation aids. Semantic token usage is unavailable through this host's tool transport; the initial report records that limitation rather than claiming zero usage. Generated artifacts remain untracked under `graphify-out/`.
