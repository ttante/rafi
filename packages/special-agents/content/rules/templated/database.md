---
name: database
category: templated
description: "Database defaults, migrations, and boundary validation."
condition: always
template: true
---
## Data And Database Rules

- Use {{database}} by default.
- Use migrations for schema changes. Do not rely on manual database edits.
- Keep migrations reviewable and, where practical, reversible.
- Update seed data, fixtures, and `.env.example` when schema or setup requirements change.
- Validate data at system boundaries and before persistence.
- Document important entities and relationships in `{{docsRoot}}/architecture.md`.

