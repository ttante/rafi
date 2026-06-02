---
name: response-expectations
category: base
description: "What every final response should include."
condition: always
template: false
---
## Agent Response Expectations

- Be concise and concrete.
- In final responses, include:
  - Code changes made.
  - Tests/checks run and whether they passed.
  - Documentation updated.
  - Rule compliance check result, including any rules not yet applicable during initial buildout.
  - Tests changed, explained simply, when applicable.
  - Follow-up tickets added, when applicable.
- Do not overwhelm the user with implementation noise unless they ask for it.
