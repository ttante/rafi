# Release Checklist

Use this checklist before releases that affect users, production data, public APIs, infrastructure, billing, auth, or AI behavior.

## Release Summary

- Release name/version:
- Release owner:
- Target date:
- Risk level:
- Rollback owner:

## Pre-Release

- [ ] Requested behavior is complete.
- [ ] Relevant tickets are updated.
- [ ] Relevant tests pass.
- [ ] Typecheck/static analysis passes.
- [ ] Lint/format checks pass.
- [ ] Build passes.
- [ ] Database migrations are reviewed and tested.
- [ ] API docs are updated.
- [ ] User/admin docs are updated.
- [ ] Architecture/business/operations docs are updated where relevant.
- [ ] Security, data-governance, and privacy impacts are reviewed.
- [ ] AI evals pass where relevant.
- [ ] AI/model cost impact is reviewed where relevant.
- [ ] Environment variables and secrets are documented.
- [ ] Monitoring dashboards and alerts are ready.
- [ ] Rollback path is documented and practical.

## Deployment

- [ ] Deployment started:
- [ ] Migration completed:
- [ ] Smoke tests completed:
- [ ] Monitoring checked:
- [ ] Error logs checked:
- [ ] User/admin impact confirmed:

## Post-Release

- [ ] Changelog updated.
- [ ] Tickets marked complete.
- [ ] Follow-up work logged.
- [ ] Incidents/regressions documented.
- [ ] Release process improvements logged.

## Rollback Plan

- Trigger:
- Steps:
- Data considerations:
- Communication:
- Verification:

