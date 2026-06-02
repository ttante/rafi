---
name: robustness
category: domain
description: "Resilient workflows, transactions, health checks, backups."
condition: always
template: false
---
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

