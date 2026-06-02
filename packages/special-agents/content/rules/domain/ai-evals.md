---
name: ai-evals
category: domain
description: "Quality gates, confidence, evals, and examples for AI."
condition: ai
template: false
---
## AI Quality, Confidence, And Evals

- Always plan AI generation workflows for high-confidence outputs, not just plausible outputs.
- Define quality gates, confidence scoring, QA checks, and acceptance thresholds for AI-generated results.
- Assume the project will include custom QA steps for important AI generations.
- When an AI generation is important or user-facing, include tests, evals, review workflows, or human approval steps that match the risk level.
- For prompts used in AI generation steps, QA steps, correction steps, and other relevant AI uses, instruct the model to check its work three times by default.
- Make the number of model self-checks configurable.
- Make extra model self-checking toggleable so it can be disabled when cost, latency, or workflow needs require it.
- During planning, consult the user about where work-checking prompts should be used, how many checks are appropriate, and when extra checks may be turned off.
- When using AI generation, start with at least one correct or top-quality example, and prefer many high-quality examples.
- Use correct/high-quality examples during AI generation where they improve quality.
- During planning, consult the user on which AI generation stages should use examples.
- Build the ability to toggle the use of correct/high-quality examples at AI generation steps where practical.
- Track AI failures, correction rates, confidence levels, approval outcomes, and quality trends.
- Keep AI eval suites, golden examples, adversarial cases, and regression results updated in `docs/ai-evals.md`.
- Promote prompt or model changes only when required eval suites meet documented thresholds, or document the explicit user-approved reason for accepting the risk.

