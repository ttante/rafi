---
name: response-expectations
category: base
description: "What every final response should include."
condition: always
template: false
---
## Agent Response Expectations

- Be concise and concrete.
- When the host supplies a structured output contract, use only its declared fields. Express the applicable reporting items below through summary, evidence, coverage, and continuity as supported by that contract; do not append prose, invent fields, or require duplicate reporting sections. Structured coverage that identifies the applicable rule and its observed status satisfies that rule-compliance reporting item. Missing evidence or unmet requirements still need truthful reporting and independent review.
- In final responses, include:
  - Code changes made.
  - Tests/checks run and whether they passed.
  - Documentation updated.
  - Rule compliance check result, including any rules not yet applicable during initial buildout.
  - Tests changed, explained simply, when applicable.
  - Follow-up tickets added, when applicable.
- Do not overwhelm the user with implementation noise unless they ask for it.
