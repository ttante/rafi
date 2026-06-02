---
name: ci
category: process
description: "Repeatable scripts and CI aligned with local verification."
condition: always
template: false
---
## Automation And CI

- Prefer repeatable project scripts over one-off commands.
- Keep CI aligned with the local verification commands agents are expected to run.
- Add or update CI checks when adding new test types, generated API docs, database migrations, security checks, or build steps.
- For AI features, add or update prompt/eval regression checks where practical.
- Include dependency vulnerability scanning and secret scanning in CI where practical.
- Include license checks, SBOM generation, and container image scanning for production applications where practical.
- Generated artifacts should be reproducible and documented with the command that updates them.
- Do not bypass failing CI without documenting the reason and the follow-up ticket.

