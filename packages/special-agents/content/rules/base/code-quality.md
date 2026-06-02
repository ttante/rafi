---
name: code-quality
category: base
description: "Clarity, focused modules, explicit errors, stable interfaces."
condition: always
template: false
---
## Code Quality

- Optimize for clarity over cleverness.
- Keep functions and modules focused. Extract helpers when they reduce real duplication or clarify complex logic.
- Avoid oversized files and modules. Split by responsibility when a file becomes difficult to scan or safely change.
- Use explicit names for variables, functions, components, files, and tests.
- Add clarifying comments for non-obvious business rules, tradeoffs, edge cases, algorithms, or integration constraints.
- Avoid comments that merely restate the code.
- Prefer typed, structured data and schema validation at boundaries.
- Handle errors explicitly with useful messages and safe failure modes.
- Keep public interfaces stable unless the task requires a breaking change.
- Do not add production dependencies without a clear reason. Prefer existing dependencies and standard library capabilities.

