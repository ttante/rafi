# Implementation review

Use this checklist after implementation, or when resuming at the audit phase. Review evidence before accepting the implementor's assessment. Report supported defects and requirements gaps; do not invent findings to fill a quota.

## Establish review scope

Read the original request or spec, acceptance criteria, relevant repository instructions, and the task's baseline/change scope. Include all task changes, including new files and changes spread over multiple commits. Inspect callers and unchanged surrounding code when needed to understand behavior. Do not attribute pre-existing work to the implementor; if overlapping changes make attribution uncertain, say so and assess their interaction explicitly.

If supplied material is insufficient, inspect the repository for the missing evidence. Mark remaining limits on coverage. Keep review read-only with respect to source files; use permitted checks in an isolated or otherwise appropriate environment when they have side effects.

## Pass 1: Requirements and scope

- Map each acceptance criterion to the code path that implements it and the evidence that exercises it. Passing tests alone do not establish that all requirements were implemented.
- Look for omitted behavior, partial implementations, changed contracts, and defaults that conflict with the request. Follow important paths from the real entry point; a correct helper that is never called does not satisfy the task.
- Identify unsupported assumptions and unrequested behavior changes. Distinguish mandatory requirements from optional suggestions or preferences.
- Check associated configuration, documentation, migrations, and operational steps only where the change requires them.

## Pass 2: Correctness and test quality

Apply the relevant checks, rather than every category on every task:

- **Behavior and integration:** trace representative inputs through callers, boundary conversions, persistence, and outputs. Check compatibility with existing interfaces and consumers.
- **Failure and lifecycle behavior:** inspect error handling, partial failures, cancellation, cleanup, retries, duplicate execution, and concurrency where applicable. Look for swallowed errors and success reported before work is durable.
- **Trust boundaries:** check authorization, validation, secrets handling, and unsafe interpretation of data where the change touches them.
- **User-visible behavior:** check the actual CLI/API/UI entry point. For UI changes, inspect the rendered result and important interactions when possible, including relevant accessibility behavior.
- **Tests:** determine whether they would detect an incorrect implementation. Watch for tautological assertions, mocks that bypass the changed behavior, missing failure cases, skipped tests, and expectations changed to match a bug. Prefer behavior checks over internal structure assertions.
- **Maintainability:** flag complexity or duplication when it creates a concrete correctness or maintenance problem. Keep stylistic preferences and speculative abstractions separate from defects.

Inspect verification evidence after forming your initial assessment. Check which code state it covers and whether the commands exercise the claims being made. Run a targeted reproduction when needed and permitted; do not claim commands you did not run or treat a partial check as proof of the whole system.

## Finding format

For each actionable finding, provide:

- **Severity and location:** blocking, important, or minor; relevant file and line or symbol.
- **Trigger and impact:** a concrete input, state, or execution sequence and the resulting incorrect behavior.
- **Evidence:** a reproduction, test result, or traceable code path, and the requirement or contract it violates.
- **Correction direction:** the smallest reasonable fix, without prescribing an unrelated redesign.

Define blocking as preventing an acceptance criterion or safe operation; important as a material bug in scope; minor as a supported lower-impact defect. Keep optional improvements separate. Express uncertain issues as hypotheses needing verification, not established bugs. A valid review may find no actionable issues; state coverage and limitations instead of certifying the code as bug-free.

## Re-review after corrections

Confirm that each accepted finding is fixed and that the correction preserves nearby behavior. Recheck affected acceptance criteria and tests. Carry unresolved findings forward explicitly. Broaden the review only if the correction expands scope or changes assumptions that earlier conclusions depended on.
