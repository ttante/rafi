---
name: ai-cost
category: domain
description: "AI cost tracking and the correction/learning loop."
condition: ai
template: false
---
## AI Cost Tracking And Learning Loop

- Include cost tracking throughout AI usage.
- Track cost per task for AI generations, including tokens, model/provider, retries, tool calls, retrieval, latency, and final success/failure status where available.
- Track other app operations that may create significant cost early or at scale, including cloud resources, queues, storage, external APIs, email/SMS, analytics, and heavy database workloads.
- Keep AI cost tracking and optimization notes updated in `docs/ai-costs.md`.
- Record results of AI generation steps when appropriate so the project can learn from successes and failures.
- Plan a correction workflow for failed generations: generate suggested corrections, run QA on corrections, and record approved corrections with the failed generation.
- Auto-approve corrections only when correction and QA confidence are both very high and the risk level allows it.
- Require admin approval for lower-confidence, high-risk, or ambiguous corrections.
- Preserve approved corrections and failed generations in a structured format that could support future fine-tuning, evals, or custom model training.
- Document the journey toward custom model training in `docs/ai.md`, including data requirements, quality thresholds, privacy constraints, retention rules, estimated cost, and when training is worth it.
- During planning, consult the user about the AI learning-loop and custom-training approach. If the full setup would be too cumbersome or data-heavy, recommend a lighter approach.

