---
name: tdd
category: process
description: "Test-driven development discipline: identify behavior, write tests first, then minimal code."
condition: always
template: false
---
## Test-Driven Development

- Always use test-driven development for application code changes wherever practical.
- Start by identifying the expected behavior and acceptance criteria.
- For new behavior or bug fixes, write or update tests first when practical, then implement the minimal code needed to pass, then refactor.
- Cover business logic, API contracts, permissions, data access, validation, error handling, and critical UI workflows.
- For UI work, include component tests, integration tests, or end-to-end tests where they provide meaningful confidence.
- If TDD is not practical for a specific change, explain why briefly and still add the best reasonable coverage.

