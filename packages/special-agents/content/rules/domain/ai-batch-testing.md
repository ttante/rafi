---
name: ai-batch-testing
category: domain
description: "Batch execution and model comparison for any AI step."
condition: ai
template: false
---
## AI Batch Execution And Model Comparison

- Design every AI step — generation, classification, extraction, routing, validation, summarization, or any other model-driven operation — so it can be run in batch mode without code changes.
- Batch mode means: given a set of inputs, run all of them through the same step and collect results, scores, costs, and latency for each.
- Build batch execution as a first-class capability, not an afterthought. The ability to run a step over many examples should be available from day one.
- Support running a batch across multiple models simultaneously so outputs can be compared side-by-side for the same inputs.
- For each batch run, record: input, model/provider, parameters, output, scoring result, cost, latency, total step duration, and timestamp. Store results in a format that supports filtering, sorting, and aggregation.
- Record step timing at every level: time-to-first-token, total generation time, and end-to-end step duration including pre/post-processing. This allows latency regressions to be caught the same way correctness regressions are.
- Track step timing trends over time — not just per run, but across runs — so gradual latency drift is visible before it becomes a user-facing problem.
- Define a scoring function for each AI step before implementing it. Scoring may be rule-based, model-judged, human-reviewed, or a combination — but it must be explicit and repeatable.
- Use batch comparison results as the primary evidence for model selection decisions at each step. Document the winning model, the runner-up, and the margin by which the winner was chosen.
- Allow batch runs to use golden examples, synthetic inputs, real sampled inputs, adversarial cases, or any combination.
- Make it easy to add new inputs to the batch suite for a step — especially real-world cases that caused problems in production.
- Track batch suite coverage: the suite should include common cases, edge cases, known failure modes, and adversarial inputs for each step.
- Support partial batches and incremental runs so new models or parameter changes can be tested against a subset of the suite before a full run.
- Automate batch runs in CI when prompts, models, parameters, or scoring functions change.
- Produce a diff-friendly summary report for each batch run: pass/fail per example, score distributions, cost and latency comparisons, and a clear recommendation.
- When batch results show a regression, block the change and require explicit sign-off with a documented rationale before merging.
- Keep batch suite inputs, expected outputs (or scoring criteria), and historical results versioned in the repository alongside the prompts they test.

