# Starter Documentation Templates

Copy these files into new app repos when bootstrapping AI-agent-friendly project documentation.

## Baseline Templates

Use these for most application repos:

- `architecture.md`: system overview, modules, integrations, tradeoffs, and architecture digest.
- `features.md`: user-facing capabilities, roles, permissions, and workflows.
- `api.md`: API documentation index and contract notes.
- `users.md`: normal user documentation.
- `admins.md`: admin/operator documentation.
- `business.md`: costs, pricing, product assumptions, risks, and business notes.
- `operations.md`: deployment, monitoring, incidents, backups, and runbooks.
- `security.md`: auth, permissions, threat model, secrets, abuse controls, and incident response.
- `data-governance.md`: PII, consent, retention, exports, deletion, and training/eval data rules.
- `local-cloud.md`: local and cloud runtime paths, parity, and environment differences.
- `scalability.md`: scaling plan for server, cloud, frontend, databases, AI/model usage, and architecture.
- `tickets.md`: ticket log, roadmap, backlog, status, acceptance criteria, and future ideas.
- `release-checklist.md`: release readiness, smoke tests, migrations, rollback, and post-release checks.
- `decisions/README.md`: ADR index and decision history.
- `decisions/0000-template.md`: reusable ADR template.

## AI Templates

Use these when the app includes LLMs, AI generation, model calls, AI-assisted decisions, or future model-training plans:

- `ai.md`: AI workflows, models, prompts, safety controls, replayability, and training-data strategy.
- `ai-evals.md`: eval suites, golden examples, adversarial cases, quality gates, and regression results.
- `ai-costs.md`: AI cost per task, provider/model spend, high-cost workflows, and optimization notes.

## Usage

The easiest path is the bootstrap script:

```sh
/path/to/aiToolsShared/scripts/bootstrap-project.sh /path/to/new-repo
```

By default, the script skips files that already exist. Use `--force` only when you intentionally want to overwrite existing target files.

