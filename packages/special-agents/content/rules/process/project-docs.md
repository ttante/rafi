---
name: project-docs
category: process
description: "The standard set of project documents to create and maintain."
condition: always
template: true
---
## Standard Project Documents

Create and maintain these documents unless the repository has equivalent files:

- `README.md`: developer install, setup, environment variables, run, test, build, and deploy basics.
- `{{docsRoot}}/architecture.md`: architecture digest, major modules, data flow, integrations, infrastructure, and tradeoffs.
- `{{docsRoot}}/features.md`: feature digest, user-facing capabilities, roles, permissions, and important workflows.
- `{{docsRoot}}/api.md` or generated API docs: API overview and links to OpenAPI, Swagger, JSDoc, Typedoc, or equivalent generated references.
- `{{docsRoot}}/users.md`: normal user documentation.
- `{{docsRoot}}/admins.md`: admin/operator documentation.
- `{{docsRoot}}/business.md`: business-level notes, feature rationale, pricing/costs, vendor costs, risk areas, operational concerns, and things to watch.
- `{{docsRoot}}/operations.md`: deployment notes, monitoring, runbooks, incident response, backups, and recovery steps.
- `{{docsRoot}}/security.md`: security model, threat model, auth, permissions, secrets, abuse controls, and incident response.
- `{{docsRoot}}/data-governance.md`: data classification, PII handling, retention, deletion/export, consent, and training-data rules.
- `{{docsRoot}}/local-cloud.md`: local runtime, cloud runtime, parity expectations, environment differences, and deployment notes.
- `{{docsRoot}}/scalability.md`: scaling strategy for server, cloud, AI/model usage, frontend, databases, and overall architecture.
- `{{docsRoot}}/ai.md`: AI workflows, model/provider choices, prompts, evals, safety controls, cost tracking, replayability, and training-data strategy when the app uses AI.
- `{{docsRoot}}/ai-evals.md`: AI eval suites, golden examples, adversarial cases, quality gates, and prompt/model regression results.
- `{{docsRoot}}/ai-costs.md`: AI cost tracking, cost per task, provider/model costs, high-cost workflows, and optimization notes.
- `{{docsRoot}}/tickets.md`: ticket log, roadmap, backlog, status, acceptance criteria, and future ideas.
- `{{docsRoot}}/decisions/`: ADRs and decision history for meaningful architecture, product, data, vendor, AI, or cost decisions.
- `{{docsRoot}}/decisions/README.md`: decision-making history index with links to ADRs and a short status summary.
- `{{docsRoot}}/release-checklist.md`: release readiness, versioning, migrations, rollback, smoke tests, and post-release checks.
- `CHANGELOG.md`: notable user-facing, API, migration, and operational changes.
- `.env.example`: documented environment variables with safe placeholder values.

When app behavior changes, update the affected docs in the same change.

