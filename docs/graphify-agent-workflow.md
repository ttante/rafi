# Graphify freshness workflow for Codex and Claude

Use Graphify selectively in repositories that already have `graphify-out/graph.json` or `.graphifyignore`. Their presence makes the repo eligible; it does not trigger a scan, graph build, or update. The installed shared policy is `/Users/tyler/.local/share/graphify/agent-workflow.md`. Explicit user instructions take precedence.

## Trigger gate

Evaluate the task and already-known edits before running any Graphify command or detection code. Only these triggers qualify:

1. **Explicit Graphify request:** the user asks to build, refresh, inspect, or query the graph. Honor the requested operation: help/version/status and inspection of Graphify instructions are read-only and do not imply extraction or rebuilding.
2. **Substantial graph-assisted investigation:** an architecture, dependency, impact-analysis, or cross-file data-flow question where the graph materially helps. A simple file lookup, command execution, or general repo question is insufficient. Run at most one freshness scan before the investigation's first query.
3. **Meaningful indexed changes made during this task:** additions/removals/renames of modules or public symbols; changed imports, calls, inheritance, API contracts, domain workflows, or runtime integration topology; substantive changes to architecture/domain documentation; or deliberate changes to graph input exclusions. Batch one update after the complete change is ready. Function-local fixes with no changed graph relationships do not qualify solely because file bytes changed.

A detector reporting changed files is evidence of byte-level staleness, not permission to rebuild. Inspect the change scope using the task context or a focused diff. If only non-trigger changes are found, defer them without updating the manifest. If significance is unclear, use direct source inspection and defer maintenance unless the investigation actually needs a fresh graph. Existing graphs may be used as navigation aids with sources verified directly; do not claim they are current without checking.

## Explicit non-triggers

Do not invoke the Graphify skill, scan the corpus, refresh, or add a graph-status footer solely because of:

- Terminal/tool invocation, shell startup, task start/end, or a completed agent turn.
- `rafi tickets queue`, ticket listing/status changes, Git status/diff/log, `ls`, `rg`, `cat`, or reading a file.
- Test, lint, format, typecheck, build, or diagnostic commands, or their logs/results.
- Whitespace, formatting, comments, spelling, line-number shifts, timestamps, or routine lockfile/version churn without meaningful dependency/topology changes.
- Generated reports, snapshots, caches, logs, graph output, hidden Rafi state, or other excluded artifacts.
- Edits to agent instructions, Graphify setup guides/policy, ticket bookkeeping, or documentation styling alone. These can be included in the next qualifying update.

Do not install per-command, per-tool, or stop/turn hooks to implement this policy. Do not scan just to decide whether a trivial task needs a scan. Do not build a missing graph automatically; initialization requires an explicit build/adoption request.

## Freshness check after a qualifying trigger

Work from the repository root. Use this check only after passing the trigger gate. It detects content changes; it does not decide whether those changes are meaningful. Its scan requirement replaces the upstream immediate-query fast path only for a qualifying investigation.

```bash
/Users/tyler/.local/share/graphify/venv/bin/python - <<'PY'
import json
from pathlib import Path
from graphify.detect import detect_incremental

root = Path.cwd().resolve()
out = root / 'graphify-out'
graph = out / 'graph.json'
if not graph.is_file():
    print(json.dumps({'status': 'missing', 'root': str(root)}))
else:
    # Fail visibly for a corrupt graph instead of calling it current.
    data = json.loads(graph.read_text())
    if not isinstance(data, dict) or not isinstance(data.get('nodes'), list) or not data['nodes']:
        raise ValueError('Graph is invalid or empty; rebuild before relying on it')
    result = detect_incremental(root, manifest_path=str(out / 'manifest.json'))
    changed = result.get('new_files', {})
    deleted = result.get('deleted_files', [])
    excluded = result.get('excluded_files', [])
    stale = any(changed.values()) or bool(deleted) or bool(excluded)
    print(json.dumps({
        'status': 'stale' if stale else 'current',
        'root': str(root), 'changed': changed,
        'deleted': deleted, 'excluded': excluded,
    }, indent=2))
PY
```

`current` means no eligible file changes were detected against the extraction manifest. It is not a guarantee of semantic accuracy. A missing manifest queues the corpus for extraction. The check may refresh local detection caches; it does not call a model or mark files as extracted.

If stale because of meaningful changes, refresh when the qualifying task needs it. If only non-trigger changes exist, defer maintenance and verify sources directly. If missing, use normal source search unless a build was explicitly requested. If a scan fails during a qualifying operation, report the problem; do not claim freshness.

## Refresh through the current assistant

- Codex: execute the installed `~/.codex/skills/graphify/SKILL.md` workflow for `. --update` (user invocation: `$graphify . --update`).
- Claude: execute `~/.claude/skills/graphify/SKILL.md` for `. --update` (user invocation: `/graphify . --update`).
- Generic agents: use `~/.agents/skills/graphify/SKILL.md` with the host's supported extraction mechanism.

These are assistant workflows, not shell commands. Read `references/update.md` beside the chosen skill. For a qualifying update, proceed without asking the user to invoke it. Routine work outside the trigger gate requires no Graphify action. Use the running assistant for semantic extraction of changed docs/media, and local AST extraction for changed code. Do not automatically switch to an external model API just because credentials happen to be present; use a separate backend only when the user authorized it for that repo.

Preserve existing graph coverage, directionality, and unchanged source data. Do not replace a mixed docs/code graph with `--code-only`. Process added, changed, deleted, renamed, and newly excluded files. For Graphify 0.9.82, the update reference's early exit and prune example only mention deleted files: also check `excluded_files`, and prune both deleted and newly excluded sources. Do not stamp changed semantic files as current if extraction failed or produced no verified result.

Preserve a backup of the existing graph before merging. Save the final graph, report, and HTML successfully before advancing the extraction manifest. Check source provenance and endpoint integrity. If a shrink guard fires, verify that lost nodes belong only to deleted, excluded, or successfully re-extracted sources; permit the intentional shrink only after that check. Otherwise preserve the old graph and report the failure.

## Batch updates and verification

Only tasks that made meaningful indexed changes require an end-of-task update. Complete their code, docs, and ticket edits first, then perform at most one incremental refresh and one verification scan. Do not repeat a successful pre-query refresh at the end of a read-only task. No-change or non-trigger-only results need no rebuild. Leave deferred files unstamped so a later qualifying refresh picks them up.

Only the coordinating agent writes the graph after parallel workers finish. If concurrent edits or another graph writer prevent a stable result, keep the last valid graph and report the remaining staleness; do not loop or start extra agents solely to chase freshness.

Mention graph status in the final response only when Graphify was actually used or updated, or when a failure affects the requested answer. Unknown host-session token usage is unknown, not measured zero.

Updates are agent-managed, not background work. Changes made outside a session are considered at the next qualifying investigation or explicitly requested refresh, not the next arbitrary terminal command.
