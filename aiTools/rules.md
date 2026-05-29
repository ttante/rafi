# App-Level AI Agent Rules

Use this file as the canonical project instruction source for AI coding agents.

For Codex, copy this content into the repository root as `AGENTS.md`.
For Claude Code, create a repository-root `CLAUDE.md` that imports the same rules:

```md
@AGENTS.md
```

Keep durable process rules in this file. Put detailed project facts in the project documents named below, not in the agent rules.

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

## Default Stack

- Default package manager: `pnpm`.
- Default database: PostgreSQL.
- Default frontend: React with TypeScript.
- Unless the user explicitly says otherwise, plan to build a UI for the app. Do not assume an app is API-only, CLI-only, or backend-only.
- Default backend: Node.js, Python, or both, based on the project needs.
- Default cloud infrastructure: AWS. Suggest another cloud provider when it is clearly more optimal for cost, product fit, compliance, operations, or team constraints.
- Unless otherwise noted, build applications so they can run both locally and in the cloud. Consult the user if local/cloud runtime expectations are unclear.
- If planning selects a different stack, update this rule file and the architecture docs to reflect that choice.
- Prefer TypeScript for JavaScript projects unless the project explicitly chooses otherwise.

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

## Ticket Tracking

- Maintain `docs/tickets.md` as the source of truth if no external tracker is configured.
- Break work into epics, stories, and implementation tickets where useful.
- Every ticket should include: ID, title, status, priority, user/business value, acceptance criteria, implementation notes, test expectations, and links to related docs or code when available.
- Valid statuses: `Backlog`, `Ready`, `In Progress`, `Blocked`, `In Review`, `Done`, `Won't Do`.
- Add discovered follow-up work, deferred improvements, risks, and future ideas to the ticket log instead of leaving them only in chat.
- When completing a ticket, mark it `Done` and summarize what changed.

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

## Automation And CI

- Prefer repeatable project scripts over one-off commands.
- Keep CI aligned with the local verification commands agents are expected to run.
- Add or update CI checks when adding new test types, generated API docs, database migrations, security checks, or build steps.
- For AI features, add or update prompt/eval regression checks where practical.
- Include dependency vulnerability scanning and secret scanning in CI where practical.
- Include license checks, SBOM generation, and container image scanning for production applications where practical.
- Generated artifacts should be reproducible and documented with the command that updates them.
- Do not bypass failing CI without documenting the reason and the follow-up ticket.

## Dependency And Supply Chain Governance

- Do not add major dependencies, paid services, or vendor lock-in without a clear reason and user approval when the decision has meaningful cost, security, licensing, or maintenance impact.
- Prefer existing dependencies and standard library capabilities before adding new packages.
- Keep lockfiles committed and reproducible.
- Check dependency licenses before adding packages to production applications.
- Generate and maintain a software bill of materials for production applications where practical.
- Scan dependencies and container images for known vulnerabilities and address meaningful findings.
- Remove unused dependencies, stale packages, and abandoned integrations when discovered during relevant work.

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

## API And Contract Documentation

- Maintain machine-readable API docs for every public or internal API surface that other clients consume.
- Prefer OpenAPI/Swagger for HTTP APIs.
- Prefer JSDoc/Typedoc for TypeScript libraries and generated references where useful.
- Prefer docstrings plus generated references for Python APIs where useful.
- Update API docs, examples, request/response schemas, error shapes, auth requirements, and version notes when API behavior changes.
- Add or update contract tests for public API changes.

## Scalability And Performance

- Plan for scalability across the server, cloud infrastructure, AI/model usage, frontend, databases, and total app architecture.
- Keep services stateless where practical so they can scale horizontally.
- Use pagination, filtering, caching, batching, queues, background jobs, and rate limits where they reduce load or improve user experience.
- Design database schemas, indexes, constraints, and query patterns with expected growth in mind.
- For frontend work, watch bundle size, rendering cost, loading states, network waterfalls, and mobile performance.
- For cloud infrastructure, document scaling assumptions, capacity limits, deployment topology, regions, managed services, and expected bottlenecks.
- For AI/model usage, plan for provider limits, latency, concurrency, queueing, fallback behavior, cost controls, and model upgrade paths.
- Document meaningful scalability assumptions and known limits in `docs/scalability.md`.

## Infrastructure And Local/Cloud Runtime

- Unless otherwise noted, build applications to run locally and in the cloud.
- Keep local and cloud environments as similar as practical while documenting intentional differences.
- Provide a local runtime path using Docker Compose, local services, scripts, or equivalent tooling when the app has service dependencies.
- Keep `.env.example`, setup docs, seed data, and local database instructions current.
- Define cloud infrastructure with Infrastructure as Code such as AWS CDK, Terraform, Pulumi, or CloudFormation unless there is a documented reason not to.
- Avoid manual cloud console changes for durable infrastructure. If manual changes are unavoidable, document them and add follow-up work to codify them.
- Document AWS account/region assumptions, IAM model, networking, secrets, storage, databases, queues, observability, and deployment flow in `docs/local-cloud.md`, `docs/architecture.md`, or `docs/operations.md`.
- Consult the user when local/cloud runtime expectations, hosting constraints, or infrastructure ownership are unclear.

## Data And Database Rules

- Use PostgreSQL by default.
- Use migrations for schema changes. Do not rely on manual database edits.
- Keep migrations reviewable and, where practical, reversible.
- Update seed data, fixtures, and `.env.example` when schema or setup requirements change.
- Validate data at system boundaries and before persistence.
- Document important entities and relationships in `docs/architecture.md`.

## Data Governance

- Classify data by sensitivity, including public, internal, confidential, PII, credentials/secrets, regulated data, and training/eval data.
- Collect and retain the minimum data needed for the product, operations, safety, and legal requirements.
- Document data retention, deletion, export, backup, and recovery expectations.
- Document consent requirements for user data, analytics, AI replay logs, eval datasets, and future model training.
- Use access controls for sensitive data and audit access where risk warrants it.
- Redact or tokenize PII and secrets before storing prompts, outputs, logs, traces, eval cases, or replay data unless explicitly approved and protected.
- Keep data-governance rules current in `docs/data-governance.md`.

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

## AI And LLM Safety

- For anything using LLMs or AI generation, include adversarial safety planning and protection against nefarious use.
- During planning for AI features, consult the user on enterprise-level AI safety practices appropriate for the app.
- Protect against prompt injection, jailbreak attempts, data exfiltration, tool misuse, unsafe generated actions, and hidden instructions in user-supplied content.
- Treat model output as untrusted. Validate, constrain, and review AI output before it affects users, data, money, permissions, external systems, or business-critical workflows.
- Use content safety checks, allow/deny rules, scoped tools, permission boundaries, and human review where risk warrants it.
- Add AI abuse monitoring for suspicious prompts, repeated failures, high-cost usage, policy violations, and unusual generation patterns.
- Red-team AI features with prompt injection, jailbreak, data leakage, unsafe action, tool misuse, and cost-abuse cases before high-risk releases.
- Maintain an AI incident plan for harmful, wrong, private, expensive, abusive, or policy-violating outputs.
- Document AI safety controls, known risks, and escalation paths in `docs/ai.md` and `docs/operations.md`.

## AI Model And Dataset Governance

- Document approved AI models/providers, the reason each is used, fallback models, and model-change approval rules.
- Treat model changes as product changes. Run relevant evals and document quality, cost, latency, and safety impact before promoting a new model.
- Document dataset sources, consent, labeling process, quality thresholds, retention, access controls, and whether data may be used for evals, fine-tuning, or custom model training.
- Keep training/eval datasets versioned where practical.
- Do not use customer/user data for model training unless the data policy, consent, retention, security, and approval requirements are documented.
- Document model and dataset governance in `docs/ai.md` and `docs/data-governance.md`.

## Robustness And Reliability

- Design important workflows to handle loading, empty, error, timeout, retry, and partial-failure states.
- Use transactions for multi-step database writes that must succeed or fail together.
- Make background jobs idempotent where practical so retries do not duplicate side effects.
- Add timeouts, retries with backoff, and circuit-breaker-style protections around external services where appropriate.
- Use feature flags or staged rollout controls for risky releases where practical.
- Validate configuration at startup and fail with clear errors when required settings are missing.
- Use database constraints and application-level validation for important invariants.
- Add health checks for services and readiness checks for dependencies.
- Preserve backward compatibility for public APIs unless a breaking change is intentional and documented.
- Plan for backups, automated or scheduled restore testing, migrations, and rollback paths for production data.
- Maintain a release checklist covering migrations, environment variables, generated docs, monitoring, smoke tests, rollback steps, and user/admin documentation.

## AI Quality, Confidence, And Evals

- Always plan AI generation workflows for high-confidence outputs, not just plausible outputs.
- Define quality gates, confidence scoring, QA checks, and acceptance thresholds for AI-generated results.
- Assume the project will include custom QA steps for important AI generations.
- When an AI generation is important or user-facing, include tests, evals, review workflows, or human approval steps that match the risk level.
- For prompts used in AI generation steps, QA steps, correction steps, and other relevant AI uses, instruct the model to check its work three times by default.
- Make the number of model self-checks configurable.
- Make extra model self-checking toggleable so it can be disabled when cost, latency, or workflow needs require it.
- During planning, consult the user about where work-checking prompts should be used, how many checks are appropriate, and when extra checks may be turned off.
- When using AI generation, start with at least one correct or top-quality example, and prefer many high-quality examples.
- Use correct/high-quality examples during AI generation where they improve quality.
- During planning, consult the user on which AI generation stages should use examples.
- Build the ability to toggle the use of correct/high-quality examples at AI generation steps where practical.
- Track AI failures, correction rates, confidence levels, approval outcomes, and quality trends.
- Keep AI eval suites, golden examples, adversarial cases, and regression results updated in `docs/ai-evals.md`.
- Promote prompt or model changes only when required eval suites meet documented thresholds, or document the explicit user-approved reason for accepting the risk.

## AI Reproducibility, Replayability, And Prompt Tuning

- For anything involving AI, include reproducibility and replayability by default.
- Record enough information to replay meaningful AI generations: prompt version, rendered prompt, input data references, model/provider, parameters, tool calls, retrieval context, output, validation results, cost, latency, timestamps, and user/admin decisions.
- Do not store sensitive prompt, input, or output data for replay or training unless privacy, consent, retention, and access controls are documented and approved.
- Version prompts and keep a prompt change history.
- Treat prompts as product logic: review them, test them, document their purpose, and connect changes to eval results.
- Maintain eval sets with golden examples, edge cases, failure cases, and adversarial cases.
- Prefer structured prompt inputs and structured model outputs where practical.
- Support prompt rollback when a prompt change reduces quality.
- Track prompt experiments, model changes, temperature/parameter changes, example changes, and their measured impact.

## AI Cost Tracking And Learning Loop

- Include cost tracking throughout AI usage.
- Track cost per task for AI generations, including tokens, model/provider, retries, tool calls, retrieval, latency, and final success/failure status where available.
- Track other app operations that may create significant cost early or at scale, including cloud resources, queues, storage, external APIs, email/SMS, analytics, and heavy database workloads.
- Keep AI cost tracking and optimization notes updated in `docs/ai-costs.md`.
- Record results of AI generation steps when appropriate so the project can learn from successes and failures.
- Plan a correction workflow for failed generations: generate suggested corrections, run QA on corrections, and record approved corrections with the failed generation.
- Auto-approve corrections only when correction and QA confidence are both very high and the risk level allows it.
- Require admin approval for lower-confidence, high-risk, or ambiguous corrections.
- Preserve approved corrections and failed generations in a structured format that could support future fine-tuning, evals, or custom model training.
- Document the journey toward custom model training in `docs/ai.md`, including data requirements, quality thresholds, privacy constraints, retention rules, estimated cost, and when training is worth it.
- During planning, consult the user about the AI learning-loop and custom-training approach. If the full setup would be too cumbersome or data-heavy, recommend a lighter approach.

## Release, Versioning, And Change Management

- Maintain `CHANGELOG.md` for notable user-facing, API, migration, security, AI/model, and operational changes.
- Use semantic versioning where it applies to published apps, APIs, packages, SDKs, or user-visible releases.
- Document breaking changes, deprecations, migration steps, rollback steps, and user/admin impact.
- Use `docs/release-checklist.md` before releases that affect users, production data, public APIs, infrastructure, billing, auth, or AI behavior.
- Include smoke tests, monitoring checks, migration checks, environment-variable checks, documentation updates, and rollback readiness in release planning.
- After release, document incidents, regressions, follow-up work, and any release-process improvements.

## Accessibility, UX, And Product Quality

- Build accessible UI by default: semantic markup, keyboard navigation, focus states, labels, contrast, and screen-reader-friendly structure.
- Keep user workflows complete, understandable, and resilient to loading, empty, error, and permission states.
- Do not ship user-facing changes without updating relevant user/admin docs.
- Preserve existing design system conventions unless the task calls for a design change.

## Observability And Operations

- Add useful logging, monitoring, metrics, alerts, and health checks for production-relevant services.
- Plan for Grafana-compatible dashboards or an equivalent observability dashboard stack unless the project chooses another monitoring platform.
- Build visible status tracking for key workflows so users, admins, and operators can understand progress, failures, retries, and completion state.
- Add detailed observability for AI generation flows, including generation stages, model calls, retries, validation results, confidence, cost, latency, and approval status.
- Avoid logging secrets or sensitive user data.
- Document operational risks, runbooks, cost drivers, and monitoring expectations in `docs/operations.md`, `docs/business.md`, or `docs/architecture.md` as appropriate.
- Maintain runbooks for common production failures and manual recovery steps.
- For new background jobs, queues, cron tasks, or integrations, document retry behavior, failure modes, and manual recovery steps.

## Business Documentation

- Keep `docs/business.md` current with product assumptions, cost drivers, vendor/service pricing notes, revenue/pricing ideas, operational risks, and open business questions.
- When a change affects cost, pricing, packaging, user roles, admin effort, compliance, support load, AI/model usage, or operational complexity, update the business docs.
- If exact pricing or costs require current external information, verify them before documenting.

## Architecture And Decisions

- Keep `docs/architecture.md` as a digest of how the app works now.
- Add ADRs in `docs/decisions/` for choices that will matter later, including stack changes, major dependencies, database design, auth model, billing model, hosting, integrations, and AI/provider choices.
- Keep `docs/decisions/README.md` updated as the decision-making history index.
- ADRs should be short: context, decision, alternatives considered, consequences, date.

## Definition Of Done

A change is not done until:

- The requested behavior is implemented.
- The agent has reviewed this rule file, confirmed the change complies with it, and prepared a concise rule-compliance result for the user, except for items that are not yet applicable during initial project buildout.
- Relevant tests are added or updated.
- Relevant tests and quality checks pass, or any inability to run them is reported.
- API docs are updated when contracts change.
- Developer, user, admin, business, ticket, and architecture docs are updated where relevant.
- Ticket status and future follow-ups are updated.
- New environment variables, migrations, dependencies, and operational steps are documented.
- The final response explains what changed, what tests ran, and any remaining risks.

## Agent Response Expectations

- Be concise and concrete.
- In final responses, include:
  - Code changes made.
  - Tests/checks run and whether they passed.
  - Documentation updated.
  - Rule compliance check result, including any rules not yet applicable during initial buildout.
  - Tests changed, explained simply, when applicable.
  - Follow-up tickets added, when applicable.
- Do not overwhelm the user with implementation noise unless they ask for it.
