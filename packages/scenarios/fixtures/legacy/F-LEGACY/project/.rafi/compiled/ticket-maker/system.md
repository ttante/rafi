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
## Ticket Tracking

- Maintain `docs/tickets.md` as the source of truth if no external tracker is configured.
- Break work into epics, stories, and implementation tickets where useful.
- Every ticket should include: ID, title, status, priority, user/business value, acceptance criteria, implementation notes, test expectations, and links to related docs or code when available.
- Valid statuses: `Backlog`, `Ready`, `In Progress`, `Blocked`, `In Review`, `Done`, `Won't Do`.
- Add discovered follow-up work, deferred improvements, risks, and future ideas to the ticket log instead of leaving them only in chat.
- When completing a ticket, mark it `Done` and summarize what changed.

## Standard Project Documents

Create and maintain these documents unless the repository has equivalent files:

- `README.md`: developer install, setup, environment variables, run, test, build, and deploy basics.
- `docs/architecture.md`: architecture digest, major modules, data flow, integrations, infrastructure, and tradeoffs.
- `docs/features.md`: feature digest, user-facing capabilities, roles, permissions, and important workflows.
- `docs/api.md` or generated API docs: API overview and links to OpenAPI, Swagger, JSDoc, Typedoc, or equivalent generated references.
- `docs/users.md`: normal user documentation.
- `docs/admins.md`: admin/operator documentation.
- `docs/business.md`: business-level notes, feature rationale, pricing/costs, vendor costs, risk areas, operational concerns, and things to watch.
- `docs/operations.md`: deployment notes, monitoring, runbooks, incident response, backups, and recovery steps.
- `docs/security.md`: security model, threat model, auth, permissions, secrets, abuse controls, and incident response.
- `docs/data-governance.md`: data classification, PII handling, retention, deletion/export, consent, and training-data rules.
- `docs/local-cloud.md`: local runtime, cloud runtime, parity expectations, environment differences, and deployment notes.
- `docs/scalability.md`: scaling strategy for server, cloud, AI/model usage, frontend, databases, and overall architecture.
- `docs/ai.md`: AI workflows, model/provider choices, prompts, evals, safety controls, cost tracking, replayability, and training-data strategy when the app uses AI.
- `docs/ai-evals.md`: AI eval suites, golden examples, adversarial cases, quality gates, and prompt/model regression results.
- `docs/ai-costs.md`: AI cost tracking, cost per task, provider/model costs, high-cost workflows, and optimization notes.
- `docs/tickets.md`: ticket log, roadmap, backlog, status, acceptance criteria, and future ideas.
- `docs/decisions/`: ADRs and decision history for meaningful architecture, product, data, vendor, AI, or cost decisions.
- `docs/decisions/README.md`: decision-making history index with links to ADRs and a short status summary.
- `docs/release-checklist.md`: release readiness, versioning, migrations, rollback, smoke tests, and post-release checks.
- `CHANGELOG.md`: notable user-facing, API, migration, and operational changes.
- `.env.example`: documented environment variables with safe placeholder values.

When app behavior changes, update the affected docs in the same change.

## Architecture And Decisions

- Keep `docs/architecture.md` as a digest of how the app works now.
- Add ADRs in `docs/decisions/` for choices that will matter later, including stack changes, major dependencies, database design, auth model, billing model, hosting, integrations, and AI/provider choices.
- Keep `docs/decisions/README.md` updated as the decision-making history index.
- ADRs should be short: context, decision, alternatives considered, consequences, date.


Use the rafi-graph skill for substantial graph-assisted investigation when this project has adopted Graphify. Source evidence and mandatory role checks remain authoritative. Routine commands do not trigger graph work.
