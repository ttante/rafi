# QA recovery file revision fix: implementation plan

Status: **implemented 2026-10-28, uncommitted.** All four fixes are in, with tests. Full suite: 1578 tests, 2 timing-sensitive failures under 8-way concurrency that pass when run alone.
Found 2026-10-28 on moneyTree run `25630461-53a6-416b-8a15-92a85299665c`. Related: `QA_MANUAL_CHECKS_AND_RECOVERY_FINDINGS.md`.

## The problem

Each QA recovery file (`.foreman/qa-report-recovery/.../manifest.json` plus `manifests/revision-NNNNNNNN.json`) keeps a summary section called the canonical recovery bundle, saved as `canonical-recovery-bundle/r<revision>.json`. Each time the file is loaded for a resume, `canonicalizeQaRecoveryRequirements` checks whether that summary needs rewriting.

The bug, in order:
1. **Wrong "latest" summary.** The previous summary is found with `.filter(...canonical-recovery-bundle/...).at(-1)` (`qaRecovery.ts:137`). Resources are sorted by path name (`resourceOrder`, `qaRecovery.ts:906`). Once the revision passes 100, `r92.json` sorts after `r125.json`, so the old `r92` is picked as "latest".
2. **A write on every read.** Compared with the wrong summary, the current one always looks changed, so every load publishes a new revision.
3. **Mismatched versions.** One resume loads the file up to three times through `pendingQaRecoveryPacket` (`cli/start.ts`). The QA hand-off receipt is built from one load (`cli/start.ts:1687`, inside `createQa`). QA's run is given another (`cli/start.ts:2448`, passed in as `resumedRecovery`). They differ, so `validateBoundaryReceipt` (`qaReview.ts:1305`) fails on `receipt.packetDigest !== packet.manifest.packetDigest`.
4. **A misleading message.** The rejection is recorded through `retainInvalidResumedResponse` as an empty QA response. The user sees "Resumed QA response failed validation … incomplete or mismatched acceptance receipt", even though QA never ran.

Observed in moneyTree's recovery file: the last resume wrote r125, r126 and r127 (bundle only, about 20 seconds apart). The receipt bound r127; QA was handed r126. The file is now at revision 139.

## Fixes

### Fix 1: choose the previous summary by revision number

- **File:** `packages/ai-foreman/src/qaRecovery.ts`, in `canonicalizeQaRecoveryRequirements`.
- **Change:** replace `.at(-1)` on the name-sorted list with a pick of the bundle whose `r<N>` number is highest.
  - Parse `N` from `canonical-recovery-bundle/r(\d+)\.json`.
  - If a bundle path doesn't match that pattern, treat the file as having no prior bundle, so a fresh summary gets written. Don't guess.
- **Don't change `resourceOrder`.** The name sort is part of how file digests are computed (`qaRecovery.ts:303`, `801`, `825`). Changing it would invalidate every existing recovery file's digest.
- **Same pick in `currentReviewedStatePrefix`** (`qaRecovery.ts:234`, found in the audit): it also uses `.at(-1)` over name-sorted `reviewed-state/current-r<N>` folders. Use the same highest-number helper there, so the chosen folder doesn't change once N passes 100. If no folder name matches the pattern, keep the current fallback.
- Put the "highest `r<N>`" logic in one small helper used by both places, and by the test at `qaRecovery.test.ts:658`.

### Fix 2: a read with nothing to update writes nothing

- With Fix 1, the existing "unchanged" check (`priorBundle.digest === hash(bundleBytes)` plus the `requiredForRecovery` check) works as intended. A load with no real change returns the loaded file without publishing.
- **Add a guard test:** canonicalizing twice in a row must leave the revision unchanged.
- No other code change is expected, provided the summary content is built deterministically. The summary uses `encodeValue(..., false)`, which is `stableJson`, over resources taken in name order. The double-canonicalize test proves this. If it fails, fix whatever is non-deterministic rather than weakening the check.

### Fix 3: build the receipt and QA's input from the same copy

- **File:** `packages/ai-foreman/src/cli/start.ts`.
- **Change:**
  - Keep the recovery file loaded for the run (`qaResumedRecovery`, line 2448, and its twin at 2154) in one variable, scoped to that run.
  - In `createQa`'s recovery hand-off branch (line 1687), use that variable instead of calling `pendingQaRecoveryPacket` again.
  - Fall back to loading only when no copy exists yet.
- **Also, from the audit:** the existence checks at lines 2124 and 2437 (`qaOnlyRecovery`) only need to know whether a recovery file exists, but they currently canonicalize, and so rewrite the file. That's why one resume made three writes. Give them a read-only check (`hasPendingQaRecoveryPacket`: same head selection as `pendingQaRecoveryPacket`, no canonicalize, no load).
- **Check during implementation:** the two load sites (2154 and 2448) are separate code paths, and only one runs per invocation. Confirm which closure `createQa` sees for each, and keep the shared copy scoped to that path.
- **Why, if Fix 1 is enough on its own:** it keeps "the receipt and QA see the same version" true even if something else updates the file between loads in the future.

### Fix 4: say what actually failed

- **File:** `packages/ai-foreman/src/qaReview.ts`, in the `catch` blocks after `validateBoundaryReceipt` (about line 817) and after `compareQaRecoveryReviewedState` (about line 826).
- **Change:** don't record these through `retainInvalidResumedResponse` with a fake empty QA turn. Instead:
  - Record a single host evidence file, such as `validation/host-rejected-<attemptId>.json` with `{ stage, reason, qaRan: false }`.
  - Pause with the message: `Rafi rejected its own QA hand-off before QA ran: <reason>. QA was not run; this is a rafi problem, not a QA answer.`
- Keep the existing "Resumed QA response failed validation" wording for real QA replies. About ten tests rely on it (`qaRecovery.test.ts` lines 200, 341, 801, 823, 859, 889, 971, 1001).

## Tests

1. **Revision over 100** (`qaRecovery.test.ts`): build a file, append resources until revision > 100, and canonicalize it so bundles below and above 100 both exist. Then:
   - The chosen previous summary is the highest-numbered one.
   - Two more canonicalize calls leave the revision unchanged.
   - Three `pendingQaRecoveryPacket`-style loads leave the revision unchanged.
2. **Mixed bundle names:** a file containing `r18`, `r92` and `r104`–`r127`, matching moneyTree's real state, picks `r127`.
3. **Receipt match on resume:** using the `qaHandleForPacket` / `acceptedBoundary` helpers, a resume whose file is past revision 100 gets past `validateBoundaryReceipt` and dispatches QA.
4. **Host rejection message:** a receipt with a wrong packet digest pauses with the new message. It records `qaRan: false` and records no QA response files.
5. **Existing tests:**
   - Keep the bundle test at `qaRecovery.test.ts:639` passing. It also uses `.at(-1)`, which is fine below revision 100; update it to use the same helper.
   - Run the full ai-foreman suite.

## Existing stuck runs

No manual cleanup is needed. After Fix 1, the first load of moneyTree's file writes one correct summary (r140), and later loads write nothing. The receipt and QA then see the same version.

## Audit against the codebase (2026-10-28)

Checked each claim above against the source:

- **Confirmed:** the previous summary is picked by name order. `qaRecovery.ts:137` uses `.at(-1)`, and `resourceOrder` is `a.path.localeCompare(b.path)` (`qaRecovery.ts:906`). In moneyTree's revision 126, the bundle order was `r104 … r125, r126, r18, r39, r53, r69, r92`.
- **Confirmed:** `.at(-1)` on bundles exists only at `qaRecovery.ts:137`. The test at `qaRecovery.test.ts:658` uses the same pattern but stays below revision 100.
- **Confirmed:** `canonicalizeQaRecoveryRequirements` has one caller, `pendingQaRecoveryPacket` (`cli/start.ts:101`). That has five callers: lines 1687, 2124, 2154, 2437 and 2448. Two of them, 2124 and 2437, only test whether a file exists, but still canonicalize, which is why one resume makes up to three writes.
- **Confirmed:** a rewrite also updates the database record of the file (`revise` calls `publish`, which updates `putQaRecoveryHead`), so `pendingQaRecoveryPacket`'s file-versus-database check (`cli/start.ts:102`) stays consistent. Repeated writes don't break that check; they only cause the receipt mismatch.
- **Confirmed:** the receipt takes its packet from the load at line 1687 (`qaV2HandoffReceipt(..., { packetDigest: packet.manifest.packetDigest ... })`). Validation compares against `opts.resumedRecovery`, the load at 2448.
- **Confirmed:** `beginV2Review` (`qaReview.ts:1497`–`1520`) also revises the file before validation: it changes the stage, records the review transition and records the review identity. It works on its own copy (`resumedPacket = v2Binding.recoveryPacket`), not on `opts.resumedRecovery`, so it doesn't cause this mismatch.
- **Correction to the earlier explanation:** the 11 updates in the failing resume were 3 setup steps (`beginV2Review`) plus 8 failure records written *after* the rejection. They were not what caused the mismatch. The cause was the extra bundle-only writes from repeated loads.
- **Same pattern, low risk:** `currentReviewedStatePrefix` (`qaRecovery.ts:234`) also uses `.at(-1)` over name-sorted `reviewed-state/current-r<N>` folders. It only picks among folders with the *same* digest, so the content is identical, but the chosen path can change once N passes 100. Fix it with the same highest-number pick for consistency. It's not causing the current failure.
- **Not checked yet:**
  - Whether summary content is fully deterministic. Fix 2 depends on it; the first test confirms it.
  - Whether a rejected hand-off should retry automatically instead of pausing. That's out of scope here; see the QA pause/resume initiative in the findings doc.
