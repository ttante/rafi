---
name: testing
category: process
description: "Discover and run the repo's quality commands; verification order."
condition: always
template: false
---
## Testing And Verification

- Always discover and use the repository's existing test, lint, typecheck, build, migration, and formatting commands.
- If standard quality commands do not exist yet, add or propose them before the project grows around inconsistent tooling.
- Run relevant tests during development, then run the full practical verification suite before considering work complete.
- If tests fail, fix the code so they pass unless the test expectations are clearly obsolete.
- If test requirements may have changed and the correct behavior is unclear, ask the user before rewriting the tests.
- When tests are updated, explain what changed and why in simple, concise language.
- Do not claim tests passed unless they were actually run and passed.
- If a command cannot be run, report the command, the reason, and the remaining risk.

Preferred verification order when available:

1. Targeted tests for the changed behavior.
2. Typecheck/static analysis.
3. Lint/format checks.
4. Full test suite.
5. Build.
6. Database migration validation.
7. End-to-end or smoke tests for user-facing changes.

