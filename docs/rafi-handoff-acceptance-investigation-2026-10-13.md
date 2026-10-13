# Handoff acknowledgement investigation — 2026-10-13

## Finding

`foreman: handoff acceptance rejected (missing-acknowledgement)` means the
fresh successor returned text before the exact protocol token
`HANDOFF_ACCEPTED`. Rafi deliberately keeps the predecessor lease in that
case: a fresh agent must not be allowed to take over or perform side effects
without acknowledging the durable handoff.

The prior implementation made this unnecessarily common. It placed the small,
strict response contract only after a large handoff document and manifest. A
model can naturally preface its response with prose or a Markdown fence, which
violates the exact first-line requirement. It also validated a cleaned response
instead of the raw provider response, so an adapter that removed the continuity
record could make an otherwise valid acknowledgement look incomplete.

## Implemented resolution

- The acceptance protocol now appears both before and after the large packet.
  It explicitly forbids tools, prefaces, and Markdown fences; requires
  `HANDOFF_ACCEPTED` as the first non-whitespace line; and requires one
  continuity record after it.
- Validation and checkpoint parsing now use the raw provider response when it
  is available, preserving protocol records removed by a wrapper for normal
  downstream handling.
- Strict acknowledgement and lease-retention rules remain unchanged. A malformed
  response gets one correction-only turn; persistent invalid output remains a
  recoverable handoff boundary rather than silently transferring ownership.

## Regression coverage

`packages/ai-foreman/test/unifiedContinuity.test.ts` covers both the bounded
correction turn and a wrapped response whose visible text has already had its
continuity line removed while the raw provider response remains valid.

## Remaining provider verification

This makes the protocol materially clearer and fixes the wrapper-validation
defect, but it does not prove every live model will obey an exact two-record
format. The next disposable Claude/Codex handoff run should record only the
safe rejection category and whether the first response or its correction
succeeded; it must not retain raw user/project content.
