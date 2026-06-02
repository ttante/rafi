---
name: ai-governance
category: domain
description: "Model/provider and dataset governance."
condition: ai
template: false
---
## AI Model And Dataset Governance

- Document approved AI models/providers, the reason each is used, fallback models, and model-change approval rules.
- Treat model changes as product changes. Run relevant evals and document quality, cost, latency, and safety impact before promoting a new model.
- Document dataset sources, consent, labeling process, quality thresholds, retention, access controls, and whether data may be used for evals, fine-tuning, or custom model training.
- Keep training/eval datasets versioned where practical.
- Do not use customer/user data for model training unless the data policy, consent, retention, security, and approval requirements are documented.
- Document model and dataset governance in `docs/ai.md` and `docs/data-governance.md`.

