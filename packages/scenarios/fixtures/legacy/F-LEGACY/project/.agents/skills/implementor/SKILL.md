---
name: implementor
description: Implement a scoped feature, bug fix, or existing plan through incremental changes, verification, a durable checkpoint, and an evidence-based review/fix loop. Use for implement-then-audit workflows, including resuming after compaction. Not for planning-only requests or standalone reviews of unrelated work.
---

# Implementor

Carry the requested change through implementation, verification, review, and correction. Preserve enough factual state to resume after compaction without repeating completed work or mistaking assumptions for evidence.

Default flow: **establish criteria → implement and verify → checkpoint → review → fix and reverify → report**. Scale the process to the change: a small edit needs a short check, not a new planning exercise. Continue authorized work without asking for approval between phases.

## Establish the task and baseline

- Read the original request, any supplied plan, relevant repository instructions, and the code and callers affected by the change. Reuse the existing plan; create only the missing detail needed to act.
- Identify observable acceptance criteria, scope exclusions, and relevant verification commands. Separate requirements from implementation suggestions. Resolve routine choices using repository conventions; clarify only uncertainties that materially change behavior, scope, or authorization, while continuing independent work.
- Record the starting revision and working-tree state before editing. Distinguish pre-existing staged, unstaged, and untracked work from this task's changes. When changes overlap, preserve a baseline diff or equivalent record so later review can identify your contribution. In a repository without Git, track the initial state of affected files instead.
- Use existing verification results or run a relevant baseline check when it helps distinguish an existing failure from a regression. Avoid rerunning unrelated suites solely to establish a baseline.

## Implement in verifiable steps

- Work in small behavior-focused steps that keep the change reviewable. For application behavior and bug fixes, prefer a test or reproduction that fails for the expected reason before the fix and passes afterward. Follow the project's testing conventions; test observable behavior rather than mirroring implementation details. If test-first work is impractical, use the best available check and record its limits.
- Run targeted checks as each meaningful step lands. Use the repository's required quality checks before declaring completion. Inspect exit status and results; a passing lint run is not evidence that the build or behavior works.
- When a check fails unexpectedly, reproduce it, trace the cause, and test a specific hypothesis before adding more changes. Do not weaken assertions, suppress errors, or revise acceptance criteria merely to obtain a pass.
- Keep refactoring proportional to the task. Update affected contracts, documentation, configuration, and operational instructions when the behavior requires it.
- Verification applies to the state that was checked. After a relevant edit, rerun affected checks; do not rerun unchanged checks merely to produce a newer timestamp.

## Checkpoint and compaction

Maintain a factual checkpoint for work spanning multiple steps or sessions, and always before a deliberate compaction or transfer. Update the task's existing work log if suitable; otherwise use a task-specific file such as `.implementor/<task-id>/checkpoint.md`. Choose a unique task ID, preserve other tasks' notes, and report the checkpoint path so a successor can find it. Tiny changes that stay in one context do not require a separate file.

Keep the checkpoint concise and cumulative. Preserve unresolved decisions and failed approaches that affect the next action; reference large artifacts instead of copying transcripts or logs. Record:

```text
Task: original request or stable source, acceptance criteria, scope exclusions
Phase: implementing | ready for review | fixing findings | complete | blocked
Baseline: starting revision, pre-existing changes, baseline-record location
Changes: completed steps, touched/new files, task commits if any
Verification: commands, outcomes, checked revision/state, unrun checks and reasons
Decisions: relevant constraints, assumptions, deviations and their reasons
Review: independent or self-review, reviewed state, findings and dispositions
Remaining: unfinished criteria, unresolved findings, known failures
Next action: exact next step and files to read
```

Honor a requested compact-before-audit boundary after implementation and initial verification. Use an actual runtime compaction facility when available; writing a summary does not compact a session. If the user requires compaction before review and only the user can trigger it, save the checkpoint and report the required runtime action and how to resume at review. Otherwise, unavailable compaction should not prevent review. Never claim a context reset that did not occur.

On resumption, read the checkpoint and original requirements, then inspect current files, diffs, and relevant history. Reconcile changes made since the checkpoint; do not replay completed steps or rely on remembered file contents. Treat recorded test results as historical evidence for the recorded state.

## Audit the result

Read [references/review.md](references/review.md) at the review phase. Review the whole task change, including committed, staged, unstaged, and new files attributable to the task, and inspect surrounding code where needed. A last-commit diff alone may omit most of the implementation.

Prefer one independent final reviewer in a fresh context when delegation is available and permitted. Give it the original requirements, relevant repository constraints, exact change scope/baseline, and the review checklist. Have it inspect the code and form an assessment before reading the implementor's conclusions. Avoid passing the implementation conversation or a persuasive completion narrative. The reviewer should report findings without editing files; the implementor owns corrections.

If a host already schedules QA, use that review boundary and its required output protocol instead of launching a duplicate reviewer. In Rafi, stay within the assigned ticket/step and let the host own QA, session transfers, and task-state transitions. An ordinary checkpoint does not replace Rafi's structured `handoff` protocol.

If independent review is unavailable or disallowed, perform the same checklist yourself and label it **self-review**. Compaction alone does not make a review independent. Use additional reviews during implementation only when the size or risk justifies them, or the user requests them.

## Resolve findings and finish

- Check each finding against the requirements and actual code. Reproduce the failure or establish a concrete failing path before fixing it. Record each as fixed, rejected with evidence, or unresolved with its impact; distinguish optional improvements from completion blockers.
- Fix supported, in-scope defects, adding a regression check when it meaningfully protects the behavior. Rerun affected checks and review the correction and nearby interactions. Reopen broader review only when the correction changes the design or exposes a wider concern.
- If two successive correction cycles revisit the same issue without new evidence, stop guessing: investigate the root cause or missing requirement. If progress requires an external decision or unavailable resource, report the specific blocker and continue independent work. Never silently waive a requirement to end the loop.
- Finish when the acceptance criteria are supported by evidence, required checks have passed, and confirmed in-scope defects are resolved. Otherwise report the work as incomplete or verification-limited, with the exact gap. Defer a known defect only when the user's scope or decision permits it, and disclose the deferral.

The final report should state the resulting behavior, checks run and their outcomes, review mode and resolved findings, and any remaining gaps. Include the checkpoint path when one exists. Do not equate unrun checks with passes or a review with a guarantee of correctness. Committing, publishing, deployment, and unrelated cleanup follow the user's requested scope; they are not automatic completion steps.

When substantial cross-file investigation warrants adopted graph evidence, follow the packaged `rafi-graph` skill. Reuse hosted packets when supplied; routine tests, bookkeeping, and handoff do not trigger refresh. Verify graph claims in source.
