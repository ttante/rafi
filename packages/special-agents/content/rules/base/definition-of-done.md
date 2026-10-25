---
name: definition-of-done
category: base
description: "What must be true before a change is considered complete."
condition: always
template: false
---
## Definition Of Done

A change is not done until:

- The requested behavior is implemented.
- The agent has reviewed the applicable rules and reported their actual compliance status, including unmet or inapplicable items. When the host supplies a structured output contract, its evidence and coverage fields are the compliance report; do not require a duplicate prose declaration or heading. A claim of compliance does not replace verification.
- Relevant tests are added or updated.
- Relevant tests and quality checks pass, or any inability to run them is reported.
- API docs are updated when contracts change.
- Developer, user, admin, business, ticket, and architecture docs are updated where relevant.
- Ticket status and future follow-ups are updated.
- New environment variables, migrations, dependencies, and operational steps are documented.
- The final response explains what changed, what tests ran, and any remaining risks.

