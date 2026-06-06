---
name: ai-evals
category: domain
description: "Quality gates, confidence, evals, and examples for AI."
condition: ai
template: false
---
## AI Quality, Confidence, And Evals

- Always plan AI generation workflows for high-confidence outputs, not just plausible outputs.
- Define quality gates, confidence scoring, QA checks, and acceptance thresholds for every AI-driven step before implementing it.
- Assume the project will include custom QA steps for important AI generations.
- When an AI step is important or user-facing, include tests, evals, review workflows, or human approval steps that match the risk level.
- For prompts used in AI generation, QA, and correction steps, instruct the model to check its work three times by default. Make the number of self-checks configurable and toggleable so it can be disabled when cost, latency, or workflow requires it.
- During planning, consult the user about where self-checking prompts should be used, how many checks are appropriate, and when extra checks may be turned off.

### Correct-Example Libraries

- For every AI step, build and maintain a library of correct, high-quality examples that demonstrate what a good output looks like. This library serves two purposes: it is injected into prompts as few-shot context to guide the model, and it anchors the eval suite.
- Seed the example library with at least one correct example before writing any AI step. Prefer many high-quality, diverse examples that cover common cases, edge cases, and tricky inputs.
- Examples should show the full input-to-output mapping for the step — not just an answer, but the reasoning or format the model is expected to follow.
- Include negative examples (clearly wrong outputs with an explanation of why they are wrong) where they meaningfully help the model avoid common failure modes.
- Version the example library alongside prompts. A prompt change and its associated example changes should be reviewed together.
- During planning, identify which AI steps will use injected examples, how many to inject at runtime, and whether the selection should be static, retrieved by similarity, or chosen by another model.
- Build the ability to toggle example injection per step so it can be disabled when cost or latency requires it.
- Track which examples were injected for each production generation as part of the replay record so failures can be traced back to example quality.
- Review and prune the example library over time: retire examples that no longer represent correct behavior and add examples from corrected production failures.

### Eval Suites

- Keep AI eval suites, golden examples, adversarial cases, and regression results updated in `docs/ai-evals.md`.
- Maintain eval sets that cover: correct common cases, edge cases, known failure modes, adversarial inputs, and cases drawn from corrected production failures.
- Track AI failures, correction rates, confidence levels, approval outcomes, and quality trends.
- Promote prompt, parameter, or model changes only when required eval suites meet documented thresholds, or document the explicit user-approved reason for accepting the risk.

