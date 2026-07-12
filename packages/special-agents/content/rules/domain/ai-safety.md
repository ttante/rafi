---
name: ai-safety
category: domain
description: "Adversarial safety and abuse protection for AI features."
condition: ai
template: true
---
## AI And LLM Safety

- For anything using LLMs or AI generation, include adversarial safety planning and protection against nefarious use.
- During planning for AI features, consult the user on enterprise-level AI safety practices appropriate for the app.
- Protect against prompt injection, jailbreak attempts, data exfiltration, tool misuse, unsafe generated actions, and hidden instructions in user-supplied content.
- Treat model output as untrusted. Validate, constrain, and review AI output before it affects users, data, money, permissions, external systems, or business-critical workflows.
- Use content safety checks, allow/deny rules, scoped tools, permission boundaries, and human review where risk warrants it.
- Add AI abuse monitoring for suspicious prompts, repeated failures, high-cost usage, policy violations, and unusual generation patterns.
- Red-team AI features with prompt injection, jailbreak, data leakage, unsafe action, tool misuse, and cost-abuse cases before high-risk releases.
- Maintain an AI incident plan for harmful, wrong, private, expensive, abusive, or policy-violating outputs.
- Document AI safety controls, known risks, and escalation paths in `{{docsRoot}}/ai.md` and `{{docsRoot}}/operations.md`.

