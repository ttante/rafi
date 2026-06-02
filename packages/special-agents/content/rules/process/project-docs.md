---
name: project-docs
category: process
description: "The standard set of project documents to create and maintain."
condition: always
template: false
---
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

