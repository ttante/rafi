---
name: stack
category: templated
description: "Default stack choices (package manager, frontend, backend, database, cloud)."
condition: always
template: true
---
## Default Stack

- Default package manager: `{{packageManager}}`.
- Default database: {{database}}.
- Default frontend: {{frontend}}.
- Unless the user explicitly says otherwise, plan to build a UI for the app. Do not assume an app is API-only, CLI-only, or backend-only.
- Default backend: {{backend}}.
- Default cloud infrastructure: {{cloud}}. Suggest another cloud provider when it is clearly more optimal for cost, product fit, compliance, operations, or team constraints.
- Unless otherwise noted, build applications so they can run both locally and in the cloud. Consult the user if local/cloud runtime expectations are unclear.
- If planning selects a different stack, update this rule file and the architecture docs to reflect that choice.
- Prefer TypeScript for JavaScript projects unless the project explicitly chooses otherwise.

