---
name: git-safety
category: base
description: "Protect user changes and avoid destructive git operations."
condition: always
template: false
---
## Git And Workspace Safety

- Before editing, inspect the repository state when practical and avoid overwriting user changes.
- Treat uncommitted changes as user-owned unless the agent made them in the current task.
- Never discard, reset, overwrite, or revert user changes unless the user explicitly asks.
- Do not run destructive git commands such as hard reset, forced checkout, branch deletion, or history rewriting unless the user explicitly asks.
- Do not commit, push, tag, merge, rebase, or open pull requests unless the user asks.
- Keep changes scoped to the requested work. If a cleanup or refactor is useful but not required, note it as follow-up work.

