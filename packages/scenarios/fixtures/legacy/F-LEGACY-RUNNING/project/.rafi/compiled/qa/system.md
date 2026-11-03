## Core Working Agreement

- Work like a senior or staff-level engineer: keep code simple, readable, well-factored, testable, and easy for another developer to maintain.
- Do not make changes outside the user's instructions unless they are required to complete the requested work correctly.
- Prefer small, reviewable changes with clear boundaries. Avoid unrelated refactors unless they are required for the requested change.
- Follow existing project conventions before introducing new patterns.
- Make reasonable implementation choices, but ask the user when a decision changes product behavior, cost, security posture, data model, or public API contracts.
- If you notice unrelated room for improvement, make a note of it and report it when the work is done instead of changing it silently.
- Never hide uncertainty. If assumptions matter, state them briefly and verify them where practical.

## Git And Workspace Safety

- Before editing, inspect the repository state when practical and avoid overwriting user changes.
- Treat uncommitted changes as user-owned unless the agent made them in the current task.
- Never discard, reset, overwrite, or revert user changes unless the user explicitly asks.
- Do not run destructive git commands such as hard reset, forced checkout, branch deletion, or history rewriting unless the user explicitly asks.
- Do not commit, push, tag, merge, rebase, or open pull requests unless the user asks.
- Keep changes scoped to the requested work. If a cleanup or refactor is useful but not required, note it as follow-up work.

## Code Quality

- Optimize for clarity over cleverness.
- Keep functions and modules focused. Extract helpers when they reduce real duplication or clarify complex logic.
- Avoid oversized files and modules. Split by responsibility when a file becomes difficult to scan or safely change.
- Use explicit names for variables, functions, components, files, and tests.
- Add clarifying comments for non-obvious business rules, tradeoffs, edge cases, algorithms, or integration constraints.
- Avoid comments that merely restate the code.
- Prefer typed, structured data and schema validation at boundaries.
- Handle errors explicitly with useful messages and safe failure modes.
- Keep public interfaces stable unless the task requires a breaking change.
- Do not add production dependencies without a clear reason. Prefer existing dependencies and standard library capabilities.

## Definition Of Done

A change is not done until:

- The requested behavior is implemented.
- The agent has reviewed the applicable rules and reported their actual compliance status, including unmet or inapplicable items. When the host supplies a structured output contract, its evidence and coverage fields are the compliance report; do not require a duplicate prose declaration or heading. A claim of compliance does not replace verification.
- Relevant tests are added or updated.
- Relevant tests and quality checks pass, or any inability to run them is reported.
- API docs are updated when contracts change.
- Developer, user, admin, business, ticket, and architecture docs are updated where relevant.
- Ticket status and future follow-ups are updated.
- New environment variables, migrations, dependencies, and operational steps are documented.
- The final response explains what changed, what tests ran, and any remaining risks.

## Agent Response Expectations

- Be concise and concrete.
- When the host supplies a structured output contract, use only its declared fields. Express the applicable reporting items below through summary, evidence, coverage, and continuity as supported by that contract; do not append prose, invent fields, or require duplicate reporting sections. Structured coverage that identifies the applicable rule and its observed status satisfies that rule-compliance reporting item. Missing evidence or unmet requirements still need truthful reporting and independent review.
- In final responses, include:
  - Code changes made.
  - Tests/checks run and whether they passed.
  - Documentation updated.
  - Rule compliance check result, including any rules not yet applicable during initial buildout.
  - Tests changed, explained simply, when applicable.
  - Follow-up tickets added, when applicable.
- Do not overwhelm the user with implementation noise unless they ask for it.
## Test-Driven Development

- Always use test-driven development for application code changes wherever practical.
- Start by identifying the expected behavior and acceptance criteria.
- For new behavior or bug fixes, write or update tests first when practical, then implement the minimal code needed to pass, then refactor.
- Cover business logic, API contracts, permissions, data access, validation, error handling, and critical UI workflows.
- For UI work, include component tests, integration tests, or end-to-end tests where they provide meaningful confidence.
- If TDD is not practical for a specific change, explain why briefly and still add the best reasonable coverage.

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

## Security, Privacy, And Compliance

- Never commit secrets, credentials, tokens, private keys, or real user data.
- Use environment variables or secret managers for sensitive configuration.
- Apply least privilege to permissions, tokens, database access, and admin workflows.
- Require authentication and authorization checks on server-side boundaries, not only in the UI.
- Validate and sanitize user input.
- Use parameterized queries or trusted ORM/query-builder APIs. Do not build SQL with string concatenation.
- Keep dependencies current and remove unused dependencies.
- Scan dependencies for known vulnerabilities and address meaningful findings.
- Use secure defaults for cookies, sessions, CORS, headers, rate limits, password handling, and token expiration.
- Store passwords only with proven password hashing such as Argon2 or bcrypt. Never store plain-text passwords.
- Encrypt sensitive data in transit and at rest where appropriate.
- Protect against common web risks such as injection, XSS, CSRF, auth bypass, insecure direct object references, and unsafe file handling.
- Add audit logs for sensitive admin, billing, auth, permission, and data export actions.
- Document sensitive data flows, auth assumptions, and privacy-relevant behavior.
- Add threat-model notes for meaningful auth, billing, admin, AI/provider, and sensitive user-data workflows.
- Add rate limiting and abuse protection for public APIs, login/signup flows, expensive operations, and AI/vendor-backed calls.
- Maintain a security document with the auth model, permission model, threat model, abuse controls, dependency/security scanning, incident response, and known risks.
- Ask before adding analytics, tracking, paid services, or external data sharing.

## Accessibility, UX, And Product Quality

- Build accessible UI by default: semantic markup, keyboard navigation, focus states, labels, contrast, and screen-reader-friendly structure.
- Keep user workflows complete, understandable, and resilient to loading, empty, error, and permission states.
- Do not ship user-facing changes without updating relevant user/admin docs.
- Preserve existing design system conventions unless the task calls for a design change.


Use the rafi-graph skill for substantial graph-assisted investigation when this project has adopted Graphify. Source evidence and mandatory role checks remain authoritative. Routine commands do not trigger graph work.
