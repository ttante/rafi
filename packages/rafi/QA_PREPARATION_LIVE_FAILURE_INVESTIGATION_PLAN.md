# QA preparation live failures: investigation and resolution plan

## Goal and status

Make the default, QA-enabled Rafi journey reliable from `rafi create` through planning, ticket population, validation, queue selection, and a completed `rafi start` build with both real Claude and real Codex.

This is an investigation and implementation plan, not a claim that the problems are fixed. The latest live tests failed before the requested ticket was implemented. Do not label either provider end-to-end successful until a new real-provider run completes and its results are independently verified.

## What the live runs actually showed

On the latest disposable arithmetic-library fixtures, **both providers** completed project creation, planning, `tickets populate`, ticket validation, and queue inspection. Each populated a Medium-risk ticket containing a concrete rollback plan; each queue showed an eligible T001. Both entered `start`, paused for plan approval, were approved, and then failed in QA preparation before the requested ticket was built. These two single runs demonstrate those successes for those fixtures only; they do not establish general reliability or prove the rollback correction loop was exercised.

Evidence is retained locally under `/private/tmp/rafi-live-populate-EYqvFD/`:

- `results.json`: phase outcomes and log paths.
- `claude-resume.log` and `codex-resume.log`: reported failures.
- `claude/.rafi/recovery.sqlite3` and `codex/.rafi/recovery.sqlite3`: retained preparation requests, provider results, and run state. Treat them as diagnostic artifacts; do not modify or blindly replay them.
- The corresponding `*-populate.log`, `*-validate.log`, and `*-queue.log` document the passing ticket stages. These temporary artifacts may be cleaned up by the operating system; preserve sanitized, minimal regression fixtures in the repository before relying on them long term.

### Claude: required metadata the model could not produce

The retained QA-preparation response says Claude inspected source with its available read tool but declined to emit a candidate because it believed it needed SHA-256 hashes and could not run a shell command to calculate them. Rafi attempted two format-only repairs of that blocked response; neither could manufacture the missing candidate. The final user-facing error was a JSON parsing error, which concealed the actual blocker.

The exact causal chain is not fully established: investigate the provider's actual permissions, hook denial, prompt/schema, and the host's existing hash generation. Do not assume a provider defect or grant shell access just because the provider requested it. In `qaBuildGate.ts`, the host already replaces several evidence fields and calculates referenced file digests after a draft is returned. The response schema still asks the model to provide digest-shaped fields before that point, and the prompt does not adequately explain which values are host-owned.

### Codex: host-owned data had to be reproduced exactly

The retained draft changed its creation timestamp and supplied a placeholder predecessor digest; the recent fix restores those two fields. The run still stopped because other protected fields differed:

- The approved-plan reference was relative in Codex's copy and absolute in the host's original.
- Several depth-decision descriptions lost Markdown backticks around identifiers and commands. The level and risk categories were not the observed differences.

`qaPreparation.ts` currently compares the complete returned `depthDecision` and `inputs` against host-owned values and stops on any difference. The error identifies neither the field nor why the host needs it. This is evidence of exact-copy fragility, **not proof that all changes to these fields are harmless**. A materially changed level, risk assessment, input digest, plan identity, or approved scope must never be silently accepted as the provider's new authority.

## Investigation questions

1. Trace the exact QA candidate lifecycle: initial host candidate, provider prompt and schema, response parsing, normalization, validation, independent assessment, persistence, delivery to Builder, and final QA. Identify which component owns every field and when it becomes authoritative.
2. For Claude, recover the denial and provider response from the retained records. Identify the actual denied operation, its policy and phase, what information the provider had, which required schema fields prompted its refusal, and which hashes the host computes today. Confirm whether an ordinary read-only investigation can supply all useful evidence without additional shell privileges.
3. For Codex, compare the exact response to the frozen candidate, field by field. Separate bookkeeping, authoritative scope/depth/inputs, and provider-authored checks and evidence. Determine whether any additional differences or candidate-validation failures appear once the first error is addressed; do not infer that fixing the first error makes the run pass.
4. Examine the existing bounded correction loop, operation reservations, stored receipts, deadline, retries, crash recovery, and snapshot cleanup. Confirm how repaired responses retain their own operation/session provenance and how working-directory mappings survive a repair turn and disposable-snapshot removal.
5. Inspect whether rule documents and skills are represented as giant mandatory requirements, how this affects prompt size and coverage, and whether their treatment introduces additional blocking failures. Any redesign of requirement granularity must preserve the approved requirements and their enforceable meaning; it is not permission to silently drop rules.
6. Check all entry points that invoke the preparation gate, including normal tickets, branches, synthetic work, remediation, and resumed/amended contracts. Establish whether old stored drafts and existing contracts remain compatible.

## Proposed resolution A: host-owned metadata and evidence

**Preferred direction:** make the host responsible for host-owned values instead of requiring the provider to calculate or reproduce them.

1. Define a provider-facing draft schema that requests substantive work only: inspected relative paths and locations, analysis, proposed checks, coverage, and any substantive risk escalation. It should not require invented hashes, timestamps, host identities, input digests, evidence IDs, operation IDs, or predecessor information. Consider versioning the provider-facing schema separately from the durable contract rather than weakening the existing contract schema.
2. Have Rafi construct the full durable candidate from its frozen authoritative candidate and the provider's permitted draft fields. Resolve and hash cited files itself, bind evidence to the actual provider operation/session and frozen source snapshot, and generate its own receipt IDs. Retain the raw provider response and normalization provenance for audit.
3. Ensure a cited path resolves inside the correct frozen snapshot/workspace; reject missing, inaccessible, directory, escaping, or symlink-escape references. Define handling of changed files, paths that disappear, and snapshot aliases such as `/var` versus `/private/var`. Do not treat a host-generated digest as proof that the model actually inspected a file; inspection claims and independent assessment remain separate evidence.
4. When a provider cannot produce a draft, distinguish an explicit blocker from malformed JSON. A blocker such as missing tool access should produce an actionable message and retain the provider explanation. Only use format-only repair for an actual recoverable formatting problem; never ask an agent to convert a refusal into fabricated evidence. Bound retries and preserve uncertain-dispatch rules.
5. As an interim compatibility measure, if a legacy response schema still requires placeholders, explicitly tell the provider which exact placeholder values are allowed and which fields Rafi will replace. Test that no placeholder can survive into published evidence. Prefer eliminating those fields from the provider-facing schema rather than relying on placeholders indefinitely.

**Decision to confirm during investigation:** whether a controlled host preflight can provide the exact evidence needed without changing tool permissions. If it cannot, document the minimum additional capability and its risks before asking for authorization. Do not broaden shell/network/write access as a default workaround.

## Proposed resolution B: stop round-tripping authoritative data

**Preferred direction:** maintain a strict authority boundary without asking the provider to retype the boundary.

1. Rafi owns run/work/contract identity, timestamps, predecessor lineage, approved inputs, original requirement text, and the selected depth decision. The provider sees these for context, but its draft does not control them. The host reconstructs these fields from the frozen authoritative source, not from the model's copy or a heuristic comparison of prose.
2. Keep provider-authored requirements, checks, links, applicability, risk escalations, and evidence as explicit proposals subject to validation. Verify every required item remains covered; proposed scope cannot become approved scope merely through reconstruction. Reject duplicate/unknown identities, invented inputs, missing or invalid coverage, unsupported dispositions, and unresolved material concerns.
3. Do **not** solve this by globally ignoring changed input/depth fields, treating arbitrary paraphrases as equivalent, or silently normalizing semantic changes. Where a legacy candidate includes host-owned fields, explicitly define whether to ignore those copies as non-authoritative or reject inconsistencies, and log the choice. A changed depth level, risk category, digest, approved source, or scope must not alter what is published. Material contradictions or evidence that the draft targets different work should trigger a bounded correction or a clear failure rather than silently laundering it into the original work.
4. Preserve the existing escalation route: a discovered consequential risk must be submitted with evidence for host/planner review, not written into the approved depth by the QA author. Revalidate predecessor identity and minimum depth during legitimate amendments.
5. Retain compatibility for existing frozen plans, active sessions, published contract digests, and prior provider responses. Any schema migration must be explicit, restart-safe, and not rewrite historical evidence or make an old assessment appear to approve a different candidate.

## Correction, recovery, and user experience

- Report the stage, specific reason, and next safe action. For example, distinguish “QA could not produce a draft because it requested unavailable file hashes” from “the draft references an unknown requirement” and “the approved input changed.” Do not expose large rule files or raw provider transcripts by default.
- For an incomplete but repairable draft, give the provider concrete, bounded validation feedback. Keep the original admitted scope and evidence; count every dispatch against the existing persistent time and operation budget. Test exhaustion, restart, and uncertain dispatches so a retry cannot accidentally duplicate work or reset safety limits.
- Preserve the distinction between a format repair and a new investigation. Ensure provenance and snapshot mappings are bound to the operation that actually supplied the accepted content.
- Do not silently bypass QA, lower depth, fabricate evidence, auto-waive requirements, or start a builder after an unvalidated preparation failure. If an operator override is proposed, treat its design, auditability, and user consent as a separate explicit decision; do not assume this plan authorizes one.
- Make failed live runs diagnosable and resumable where existing recovery semantics safely allow it. Do not automatically resume an uncertain operation or mutate retained failed-run databases during investigation.

## Verification plan

### Deterministic regression tests

Use sanitized reproductions of the actual Claude and Codex responses, preserving the relevant differences and rejection reasons. Cover:

1. Claude-style refusal to supply hashes: host-owned evidence is generated and bound to the right source and operation; no model-computed hashes or invented placeholders are required. A missing or out-of-snapshot reference remains blocked.
2. A genuine provider refusal is reported as a blocker rather than repeatedly repackaged as JSON; malformed-but-repairable envelopes get only bounded format correction.
3. Codex-style relative/absolute input reference and Markdown formatting differences cannot change host-owned inputs, depth, or scope. The expected host values survive through publication and delivery, with independent assessment bound to the resulting exact draft.
4. Malicious or accidental changed depth level, risk factors, approved input digest, ticket identity, requirement content, or source must not be accepted as new authority. Cover conflicting drafts, omitted requirements, duplicate IDs, invalid mappings, provider-supplied waivers, and changed source after inspection.
5. Real snapshot paths, nested directories, platform aliases, missing paths, symlink escape, and snapshot teardown; ensure failed mapping never becomes an unvalidated executable path.
6. Bounded correction success and exhaustion, independently authored assessment, higher-depth escalation, crash/retry, stale retained drafts, amendment/predecessor handling, uncertainty, and budget accounting. Run existing QA preparation, contract, delivery, freshness, and recovery suites.
7. Exercise the actual `start` admission/gate and builder delivery with QA preparation enabled, not only a helper or a fake workflow with QA disabled. Include a regression that reaches the builder with a legitimate completed contract and negative cases that do not.

### Real-provider acceptance

After deterministic tests and build/type checks pass, run one fresh, disposable, sequential live journey for each provider with QA preparation **enabled** and no fake provider:

`create → plan → tickets setup → tickets populate → tickets validate → tickets queue → start → completed builder work → independent project test`

Use bounded execution, no remote Git/publishing/deployment/dependency installation, and retain logs and durable receipts. Assert that the generated ticket has a usable risk plan when it is Medium or High risk, the queue has an eligible ticket, the contract was actually prepared and independently assessed, the selected ticket reached Builder, the run durably completed, and the fixture's expected code and tests pass independently. Handle any actual plan-approval pause explicitly; do not count a pause, a provider session, or a successful `start` command alone as completion.

Record provider/model versions, configuration, fixture, timestamps, outcomes, and failure details. If a provider fails, retain evidence, report the stage and cause, and do not describe the overall journey as passing. If the failure has an obvious in-scope fix, add a reproduction and fix before rerunning; consult the user on product/safety decisions or ambiguous authority changes.

## Implementation order and acceptance criteria

1. Preserve minimal sanitized reproductions and document the exact host/provider ownership matrix.
2. Add failing tests for the observed Claude blocker and Codex authority-copy mismatch, plus negative safety cases.
3. Implement the provider-draft/host-assembly boundary and clear error classification; retain version and provenance compatibility.
4. Verify safe path/evidence handling, bounded correction, assessment, recovery, and all relevant existing entry points.
5. Run the QA-enabled scripted start integration, then both approved live journeys. Fix further obvious defects with tests or explicitly report remaining blockers.

The work is complete only when both fresh real-provider journeys satisfy the acceptance assertions above, the relevant regression suites and type/build checks pass, and any remaining limitations are stated. These two live samples provide targeted evidence, not a statistical reliability guarantee.
