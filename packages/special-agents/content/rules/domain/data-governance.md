---
name: data-governance
category: domain
description: "Data classification, retention, consent, and PII handling."
condition: always
template: true
---
## Data Governance

- Classify data by sensitivity, including public, internal, confidential, PII, credentials/secrets, regulated data, and training/eval data.
- Collect and retain the minimum data needed for the product, operations, safety, and legal requirements.
- Document data retention, deletion, export, backup, and recovery expectations.
- Document consent requirements for user data, analytics, AI replay logs, eval datasets, and future model training.
- Use access controls for sensitive data and audit access where risk warrants it.
- Redact or tokenize PII and secrets before storing prompts, outputs, logs, traces, eval cases, or replay data unless explicitly approved and protected.
- Keep data-governance rules current in `{{docsRoot}}/data-governance.md`.

