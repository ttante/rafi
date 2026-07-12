---
name: observability
category: domain
description: "Logging, metrics, dashboards, runbooks, and AI observability."
condition: always
template: true
---
## Observability And Operations

- Add useful logging, monitoring, metrics, alerts, and health checks for production-relevant services.
- Plan for Grafana-compatible dashboards or an equivalent observability dashboard stack unless the project chooses another monitoring platform.
- Build visible status tracking for key workflows so users, admins, and operators can understand progress, failures, retries, and completion state.
- Add detailed observability for AI generation flows, including generation stages, model calls, retries, validation results, confidence, cost, latency, and approval status.
- Avoid logging secrets or sensitive user data.
- Document operational risks, runbooks, cost drivers, and monitoring expectations in `{{docsRoot}}/operations.md`, `{{docsRoot}}/business.md`, or `{{docsRoot}}/architecture.md` as appropriate.
- Maintain runbooks for common production failures and manual recovery steps.
- For new background jobs, queues, cron tasks, or integrations, document retry behavior, failure modes, and manual recovery steps.

