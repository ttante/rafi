# Claude activity `TIME_ELAPSED` investigation — 2026-10-13

## Conclusion

The historical user-facing line:

```text
RAFI working: tool failed — claude — tool_result (TIME_ELAPSED)
```

was a **Rafi activity-projection defect**, not enough evidence of either a
Claude provider failure or a failed tool.  `TIME_ELAPSED` is an ambiguous
`tool_result` placeholder: it does not say that the original tool succeeded,
failed, timed out, or was cancelled.  The old adapter turned every
`is_error: true` result into `failed`, discarded the originating call identity,
and the activity layer faithfully printed that false terminal failure.

The exact `TIME_ELAPSED` path is fixed. The broader live false-failure problem
was not fixed by that narrow change alone, so this checkout now also treats an
`is_error` result with no explicit terminal failure evidence as `unknown`, not
as a failed tool. It emits a bounded, redacted `provider-tool-result` lifecycle
record (tool ID/name, result digest/byte count, `is_error`, classification, a
safe reason category, and
provider turn/session IDs) so enterprise Claude behavior can be diagnosed
without storing raw command output or credentials.

The relevant behavior is:

1. `ClaudeAdapter.handle()` records each assistant `tool_use` by `block.id`.
2. `observeToolResults()` joins a user `tool_result.tool_use_id` back to that
   call, so activity receives `Bash`/`Read` rather than `tool_result`.
3. A content value consisting only of `TIME_ELAPSED`, or an error-marked result
   with no explicit timeout/cancellation/failure evidence, is emitted as
   `status: "unknown"`, `completionKnown: false`, rather than `failed`.
4. The activity projector renders that state as `tool outcome unknown`, without
   treating it as completed work or calling it failed. Duplicate identical
   unknown results are coalesced by call ID and content digest.
5. Actual timeout and cancellation still render distinctly. Explicit tool
   failures render once per tool as `tool reported a failure; agent continuing`,
   avoiding repeated claims that the overall Rafi operation failed.

The relevant source locations are:

- `packages/ai-foreman/src/adapters/claude.ts` — `handle()` tool-call capture
  and `observeToolResults()` classification/correlation.
- `packages/ai-foreman/src/activity.ts` — `reportBuilderEvent()` user-facing
  projection.
- `packages/ai-foreman/test/claudeToolResults.test.ts` — adapter regression
  fixture.
- `packages/ai-foreman/test/activity.test.ts` — activity lifecycle rendering.

## Evidence

### Live Claude validation (2026-10-13)

A disposable online Claude planner run using the freshly rebuilt local CLI
completed successfully (`plan_complete`, session
`9baa8804-ee37-45bb-989f-ec35c3606b06`). Its terminal activity nevertheless
printed six `tool failed` lines for `Bash` and `Read` while the provider kept
working and produced the plan. None used the literal `TIME_ELAPSED` string.

This proved that the narrow placeholder fix was necessary but **not
sufficient**. The implementation now persists the bounded, redacted diagnostic
metadata described above. A final disposable live probe remains required to
determine which enterprise payloads are provisional versus explicit failures.

The final disposable live probe completed planning successfully (session
`ed6883e0-c36e-4db9-a969-f728a0e0fb78`) and wrote only redacted records. It
reported 2 `explicit_error`, 5 `unexplained_error`, and 12 completed results;
the terminal printed one recoverable Bash warning and zero `tool failed` lines.
The precise raw output was intentionally not retained. Future probes can group
by reason category and digest without exposing repository content.

Terminal output is retained only in the disposable evidence log:
`/private/tmp/rafi-live-claude-activity-validation-final-20261013.log`.

Focused offline regression tests passed on 2026-10-13 under Node 20.19.0:

```text
corepack pnpm exec tsx --test \
  packages/ai-foreman/test/claudeToolResults.test.ts \
  packages/ai-foreman/test/activity.test.ts

21 passed, 0 failed
```

`claudeToolResults.test.ts` feeds these provider-shaped results through the
real `ClaudeAdapter` stream, including duplicate messages:

| Tool result | `is_error` | projected status | completion known |
| --- | ---: | --- | ---: |
| `TIME_ELAPSED` | true | `unknown` | no |
| `command timed out` | true | `timed_out` | yes |
| `command exited 1` | true | `failed` | yes |
| `done` | false | `completed` | yes |
| `TIME_ELAPSED: command exited 1` | true | `failed` | yes |

This proves the narrow historical failure string cannot be produced by the
current adapter for the covered event shape.  No new live-provider call was
needed: this is a deterministic SDK-stream projection path and the existing
live Claude planning result already established that the provider can continue
and complete after recoverable tool activity.

## What `TIME_ELAPSED` does and does not establish

The installed Claude SDK type definitions document `tool_progress` separately
as a liveness event with a `tool_use_id`, tool name, and elapsed seconds.  They
do not define `TIME_ELAPSED` as a terminal outcome.  Rafi must therefore not
invent one from the placeholder alone.  It can only become terminal when a
correlated later result supplies an explicit timeout/cancellation/error/success
signal, or the provider turn itself fails.

This means `unknown` is intentional and safer than the old false `failed`.
It should not be silently counted as successful useful progress.

## Remaining hardening work

The current fix is correct for the reported false positive, but these small
follow-up slices would make live diagnosis stronger:

1. **Make unknown activity compact.** Do not emit a separate normal activity
   record for every distinct `TIME_ELAPSED` call in record/non-TTY mode. Keep
   the structured `BuilderEvent` and observability span, but display one
   concise message per provider turn, such as `Claude has tool outcomes still
   pending; continuing`. Reset it when a correlated terminal event arrives.
   This prevents a different form of activity spam while preserving honesty.

2. **Represent provisional results explicitly.** Extend the tool event model
   with a lifecycle/status distinction such as `outcome: "pending" | "unknown"
   | "terminal"` (or a `provisional: true` field). `lifecycle: "completed"`
   plus `completionKnown: false` works today but is semantically awkward and
   encourages future consumers to mistakenly treat it as completion.

3. **Correlate and close pending unknown spans.** Retain a bounded record of
   unknown call IDs and, when a later terminal result arrives, emit/update a
   correlated terminal event and finish the existing observability span. At
   provider-turn end, close unresolved calls with `outcome: "unknown"` and an
   explicit `unresolvedAtTurnEnd` attribute. Never synthesize success.

4. **Capture provider-native context in diagnostics.** Implemented: every
   `tool_result` now emits a redacted lifecycle record with provider session and
   turn IDs, tool-use ID/name, result digest/byte count, `is_error`, observed
   time, and classification. It deliberately excludes result text.

5. **Add projector-specific tests.** Existing tests prove adapter
   classification and generic lifecycle rendering separately. Add a combined
   fixture that sends `tool_use(Bash)` then `tool_result(TIME_ELAPSED)` through
   `BuilderEventQueue` inside `withActivityContext`, asserting the rendered
   text does not contain `tool failed`, does not contain `tool_result`, and
   contains neither a false success nor repeated duplicate lines. Add parallel
   assertions for timeout, cancellation, and a real failure.

6. **One controlled live validation only after the above is implemented.** Run
   a disposable Claude planning fixture with raw event capture enabled; compare
   each redacted tool call/result pair with rendered activity. Acceptance:
   every displayed terminal failure has a matching terminal provider result;
   placeholders are labelled pending/unknown once; a successful final plan
   does not leave a false terminal-failure line. This is provider validation,
   not a release prerequisite for the already-reproduced local projection bug.

## Recommended implementation order and regression commands

1. Add the combined renderer fixture first, preserving current behavior.
2. Add compact per-turn pending presentation and its record/non-TTY tests.
3. Add pending-span closure and structured redacted diagnostic tests.
4. Run:

```text
corepack pnpm exec tsx --test \
  packages/ai-foreman/test/claudeToolResults.test.ts \
  packages/ai-foreman/test/activity.test.ts
pnpm --filter ai-foreman test
pnpm --filter ai-foreman typecheck
```

5. Perform the single disposable live Claude correlation run only after the
   offline suite passes. Compare raw IDs/digests, never raw secrets or user
   repository content.

## Scope and safety

The local Rafi working tree contains the activity-projection implementation and
regression tests described here. The disposable provider fixture was used only
for validation. No external repository, provider account state, package
registry, commit, or push was changed.
