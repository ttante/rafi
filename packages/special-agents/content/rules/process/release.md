---
name: release
category: process
description: "Changelog, semver, release checklist, and post-release notes."
condition: always
template: true
---
## Release, Versioning, And Change Management

- Maintain `CHANGELOG.md` for notable user-facing, API, migration, security, AI/model, and operational changes.
- Use semantic versioning where it applies to published apps, APIs, packages, SDKs, or user-visible releases.
- Document breaking changes, deprecations, migration steps, rollback steps, and user/admin impact.
- Use `{{docsRoot}}/release-checklist.md` before releases that affect users, production data, public APIs, infrastructure, billing, auth, or AI behavior.
- Include smoke tests, monitoring checks, migration checks, environment-variable checks, documentation updates, and rollback readiness in release planning.
- After release, document incidents, regressions, follow-up work, and any release-process improvements.

