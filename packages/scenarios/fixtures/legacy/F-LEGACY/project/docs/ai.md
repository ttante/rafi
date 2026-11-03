# AI System Plan

Use this document for apps that include LLMs, AI generation, model calls, AI-assisted decisions, or future model-training plans.

## Current Status

- AI enabled: `<yes/no>`
- Primary AI use cases: `<summary>`
- Current model/provider stack: `<models/providers>`
- Current risk level: `<low/medium/high>`
- Last reviewed: `<date>`

## AI Workflows

| Workflow | User/admin value | Trigger | Inputs | Outputs | Human review? | Status |
|---|---|---|---|---|---|---|
| `<workflow>` | `<value>` | `<event>` | `<data>` | `<result>` | `<yes/no>` | `<planned/live>` |

## Model And Provider Choices

| Use case | Provider | Model | Why this model | Alternatives considered | Fallback | Owner |
|---|---|---|---|---|---|---|
| `<use case>` | `<provider>` | `<model>` | `<reason>` | `<options>` | `<fallback>` | `<owner>` |

## Model Governance

- Approved providers/models:
- Model-change approval rules:
- Fallback model rules:
- Required evals before promotion:
- Cost/latency thresholds:
- Safety thresholds:
- Rollback process:

## Prompt Inventory

| Prompt ID | Version | Purpose | Owner | Eval coverage | Last changed | Rollback version |
|---|---|---|---|---|---|---|
| `<prompt-id>` | `<v1>` | `<purpose>` | `<owner>` | `<eval link>` | `<date>` | `<version>` |

## Safety Controls

Document how the app prevents unsafe or abusive AI behavior.

- Prompt injection protection:
- Jailbreak protection:
- Data exfiltration protection:
- Tool-use boundaries:
- Human review requirements:
- Content safety checks:
- Abuse monitoring:
- Escalation path:

## Red-Team Testing

| Scenario | Attack Type | Expected Defense | Eval/Test Link | Status |
|---|---|---|---|---|
| `<scenario>` | `<prompt injection/jailbreak/data leakage/tool misuse/cost abuse>` | `<defense>` | `<link>` | `<status>` |

## AI Incident Response

- Harmful output response:
- Wrong/low-quality output response:
- Private data exposure response:
- High-cost/abusive usage response:
- Policy-violating output response:
- Owner/escalation path:

## Quality And Confidence

- Definition of high-quality output:
- Required confidence signals:
- Model self-checking default: `3 checks`
- Model self-checking configurable count:
- Model self-checking toggle:
- AI steps that use self-checking:
- AI steps where self-checking is disabled and why:
- QA checks:
- Auto-approval threshold:
- Admin approval threshold:
- Rejection criteria:
- Known weak spots:

## Reproducibility And Replayability

Record enough information to replay important generations without storing sensitive data unnecessarily.

- Prompt version:
- Rendered prompt storage policy:
- Input data reference policy:
- Model/provider and parameters:
- Retrieval context:
- Tool calls:
- Output:
- Validation results:
- Cost:
- Latency:
- User/admin decision:
- Retention policy:

## Learning Loop

Use this section to describe how failed generations become future improvements.

- Failed-generation capture:
- Correction generation:
- QA review:
- Auto-approval rules:
- Admin approval rules:
- Approved correction storage:
- Eval updates:
- Prompt updates:
- Product changes:

## Dataset Governance

- Dataset sources:
- Consent requirements:
- Labeling process:
- Quality thresholds:
- Access controls:
- Retention rules:
- PII redaction/tokenization:
- Allowed use for evals:
- Allowed use for fine-tuning/custom training:
- Versioning strategy:

## Future Custom Model Training

- Why custom training may be useful:
- Data needed:
- Data quality threshold:
- Privacy and consent constraints:
- Retention rules:
- Estimated cost:
- When training is worth it:
- Lighter alternative if full training is too heavy:

## Open Questions

- `<question>`
