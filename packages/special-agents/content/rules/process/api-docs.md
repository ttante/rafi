---
name: api-docs
category: process
description: "Machine-readable API docs and contract tests."
condition: always
template: false
---
## API And Contract Documentation

- Maintain machine-readable API docs for every public or internal API surface that other clients consume.
- Prefer OpenAPI/Swagger for HTTP APIs.
- Prefer JSDoc/Typedoc for TypeScript libraries and generated references where useful.
- Prefer docstrings plus generated references for Python APIs where useful.
- Update API docs, examples, request/response schemas, error shapes, auth requirements, and version notes when API behavior changes.
- Add or update contract tests for public API changes.

