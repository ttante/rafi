# AI Eval Log

Use this document to track AI quality gates, eval sets, golden examples, adversarial cases, and prompt/model regression results.

## Eval Strategy

- Primary AI workflows covered:
- Quality goals:
- Minimum passing threshold:
- Human review requirements:
- Regression policy:
- Prompt/model promotion policy:
- Last reviewed:

## Eval Suites

| Eval Suite | Workflow | Purpose | Cases | Passing Threshold | Owner | Status |
|---|---|---|---:|---|---|---|
| `<suite>` | `<workflow>` | `<purpose>` | `<count>` | `<threshold>` | `<owner>` | `<planned/live>` |

## Golden Examples

Golden examples are correct or top-quality examples that represent desired output.

| Example ID | Workflow | Input Summary | Expected Output Summary | Why It Matters | Status |
|---|---|---|---|---|---|
| `<example-id>` | `<workflow>` | `<input>` | `<output>` | `<reason>` | `<active>` |

## Edge And Failure Cases

| Case ID | Workflow | Scenario | Expected Handling | Risk | Status |
|---|---|---|---|---|---|
| `<case-id>` | `<workflow>` | `<scenario>` | `<behavior>` | `<low/medium/high>` | `<active>` |

## Adversarial Cases

| Case ID | Attack Type | Input Summary | Expected Defense | Status |
|---|---|---|---|---|
| `<case-id>` | `<prompt injection/jailbreak/data exfiltration/tool misuse>` | `<input>` | `<defense>` | `<active>` |

## Eval Runs

| Date | Change Tested | Model/Prompt Version | Suite | Score | Result | Notes | Follow-Up Ticket |
|---|---|---|---|---:|---|---|---|
| `<date>` | `<change>` | `<version>` | `<suite>` | `<score>` | `<pass/fail>` | `<notes>` | `<ticket>` |

## Promotion Decisions

| Date | Prompt/Model Change | Eval Result | Decision | Approver | Rollback Plan |
|---|---|---|---|---|---|
| `<date>` | `<change>` | `<result>` | `<promote/hold/rollback>` | `<approver>` | `<plan>` |

## Regression Notes

- `<date>`: `<what regressed, why, and what changed next>`
