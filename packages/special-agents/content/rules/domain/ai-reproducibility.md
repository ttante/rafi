---
name: ai-reproducibility
category: domain
description: "Replayability, prompt versioning, and prompt tuning."
condition: ai
template: false
---
## AI Reproducibility, Replayability, And Prompt Tuning

- For anything involving AI, include reproducibility and replayability by default.
- Record enough information to replay meaningful AI generations: prompt version, rendered prompt, input data references, model/provider, parameters, tool calls, retrieval context, output, validation results, cost, latency, timestamps, and user/admin decisions.
- Do not store sensitive prompt, input, or output data for replay or training unless privacy, consent, retention, and access controls are documented and approved.
- Version prompts and keep a prompt change history.
- Treat prompts as product logic: review them, test them, document their purpose, and connect changes to eval results.
- Maintain eval sets with golden examples, edge cases, failure cases, and adversarial cases.
- Prefer structured prompt inputs and structured model outputs where practical.
- Support prompt rollback when a prompt change reduces quality.
- Track prompt experiments, model changes, temperature/parameter changes, example changes, and their measured impact.

