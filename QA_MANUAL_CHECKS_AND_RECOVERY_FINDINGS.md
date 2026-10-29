# QA manual checks and recovery findings

Found 2026-10-28 while resuming moneyTree build run `25630461-53a6-416b-8a15-92a85299665c` (ticket T001).
Status: **findings only. No rafi changes have been approved yet.**

Terms used throughout:
- **QA rejected the work:** the QA review ran to the end and decided the implementation doesn't meet the ticket.
- **QA broke:** the QA review didn't finish. The agent stopped, was cut off, or gave an unreadable answer, so there's no verdict.

## 1. Tickets with checks only a person can do

### What happened

T001's acceptance includes two things only the operator can do:
1. Approve StarNet's file-write request during a live run.
2. Look at the MONEYSTATION window inside StarNet and see the new file.

QA runs in a locked-down sandbox. It can't approve anything in StarNet, can't see the StarNet window, and can't even run some of StarNet's own tests there. So **QA rejected the work** on every review. The Builder can't do those checks either, so it kept reporting "blocked, needs the operator." Once the 3 automatic Builder fixes were used up, rafi asked its "what next?" question, whose choices are retry Builder, pause, waive QA, or discuss with Planner. None of those fits "a person needs to check this."

The root cause is in planning: the ticket was written with requirements QA can never verify.

### What the user should be able to choose

If a plan contains checks only a person can do, the user should be able to choose, at every turn:
- **A. Manual checks that stop the build:** QA skips them, and the build waits for the user to confirm each one.
- **B. No manual checks:** today's behavior. QA keeps everything, including items it can't verify.
- **C. Manual checks that don't stop the build:** the ticket finishes, and the user reviews the checks whenever they like.

### Risk

A full version of this means a new kind of build pause, plus resume, recovery, saved answers and staleness rules for each choice. That's the same area where the bugs in section 2 were found. Choice C also needs somewhere to track open checks, and a rule for later tickets that build on work nobody has verified. **The full version probably isn't worth it right now.** If it's ever built, it needs a very careful plan first.

### A lighter alternative, for discussion

1. **Planner wording (prompt change only).** Don't write acceptance criteria QA can't verify. Write "provide a live test the operator can run, plus tests that cover it with a fake StarNet," not "the operator sees the file in the panel." Put person-only checks in a plain "operator checklist" note on the ticket. QA and the build ignore the note, and rafi shows it to the user when the ticket finishes. This covers choices B and C, with no change to build state.
2. **A "verified it myself" answer.** Add one choice to the existing "what next?" question: "I verified it manually," with a required note on what was seen. It records the note and waives only those findings. This reuses an existing, tested decision path and needs no new pause type. It covers choice A.

## 2. Bugs found in QA pause and resume

### Timeline

| Step | What happened |
|---|---|
| Oct 27, review 7 | QA rejected the work: the live test produced 0 files. The Builder rewrote the plugin, reported "blocked," and the build paused. |
| Oct 28, resume 1, review 9 | The code had changed, so QA re-reviewed it, which was correct. QA rejected the work again. The fix limit was used up, so rafi asked "what next?" The build was running in the background, so rafi saved the question and exited. Claude answered "retry" without asking the user (see the note at the end). |
| Resume 2 | **Bug 1:** rafi threw the "retry" answer away and asked again. |
| Resumes 3–4, reviews 10–12 | **Bug 2:** instead of sending review 9's problems to the Builder, rafi started new reviews of the same, unchanged code. QA broke on review 10 (cut off), review 11 (cut off) and review 12 (garbled JSON reply). |
| After review 12 | **Bug 3:** rafi stopped and demanded a manual `--guided-recovery` in a terminal. |

### Bug 1: saved answers to "what next?" were thrown away

- **Where:** `WorkflowDb.staleTicketDecisions` and `refreshStaleTicketDecisions` (`packages/ai-foreman/src/workflowDb.ts`).
- **Cause:** an answered decision counted as stale unless its key contained the ticket's raw scope revision. The "what next?" key contains only a hash that includes the scope, so every saved answer was treated as stale and the question was asked again.
- **Fix tried:** only treat keys that embed the raw revision (`builder:`, `ticket-question:`) as stale.

### Bug 2: resume re-reviewed unchanged code instead of using the last rejection

- **Where:** `runIsolatedQa` (`packages/ai-foreman/src/qaReview.ts`) and `createQaNonconvergenceHandler` (`packages/ai-foreman/src/cli/start.ts`).
- **Cause:** resume had a path for "paused right after QA rejected the work," but not for "paused at the what-next question." It fell through to a fresh review. Each new review also changed the question's key, which was a hash of the whole review history, so a saved answer could never match.
- **Correct behavior:** if QA rejected the work and the code hasn't changed since, reuse that rejection. Ask "what next?" once, or use the saved answer, and on "retry" send that report to the Builder.
- **Fix tried:**
  - Restore the rejected review with the existing `failed-review-restored` step, but only when: it's the latest review, no Builder fix was attempted, and the live code is identical.
  - Ask the question at that point instead of pausing.
  - Key the question on the specific rejection (review attempt plus report).

### Bug 3: a garbled QA reply blocked all later QA turns

- **Where:** `structuredReceipt` (`packages/ai-foreman/src/adapters/structured.ts`) and the `answeredInvalid` check in `journalStructuredDispatch` (`packages/ai-foreman/src/structuredOperation.ts`).
- **Cause:** a QA agent that finished its turn with a reply that fails the schema is recorded as "answered, invalid," and QA retries with a fresh review. A reply that isn't valid JSON at all was recorded as "outcome unknown" instead. Rafi refuses to send more work to a role with an unknown turn, so everything stopped.
- **Correct behavior:** when QA breaks, restart the review with the same original evidence.
- **Fix tried:**
  - Check the reply's identity before parsing it, and label JSON parse errors.
  - Treat a parse failure as "answered, invalid."
  - Reclassify existing stuck records on resume, but only when the saved reply text provably fails to parse.

### Status of the fixes

- All three fixes are in the working tree and **not committed**.
- Each has a test that fails without the fix:
  - `test/qaNonconvergenceAnswerSurvivesResume.test.ts`
  - The malformed-JSON test in `test/structuredOperation.test.ts`
  - The operator-menu test at the end of `test/qaRecovery.test.ts`
- The last full suite run had one failure: in `qaDecisions`, an old saved waiver could match a new rejection that had no review ID. That was fixed by falling back to the whole history entry. Only the affected files were rerun after that, not the full suite.
- moneyTree was resumed with a local build of these fixes:
  - The stuck turn was reclassified, and QA restarted with the same evidence.
  - QA rejected the work (review 14), and the answer "retry" went straight to the Builder.
  - The Builder built the approval relay (`scripts/starnet-consent-relay.js`).
- **Decide:** keep, revise or revert these changes.

### Other loose ends

- The Builder's last fix was journaled as `delivery-uncertain`, even though its response and code changes were saved and the hand-off moved to `recheck-required`. This needs a look: `qaFailureDelivery.ts` lines 316 and 463.
- Claude answered rafi's "what next?" decision three times without asking the user. Decisions meant for the user should be relayed to them. Running builds in the background hides those prompts from the user, so whoever runs the build needs to surface them.

## 3. Initiative: simplify QA pause and resume

The QA flow is large:
- `qaProtocolV2.ts` has **14 states** and **22 kinds of state change**.
- `qaRecovery.ts` has a separate set of **10 recovery steps** that sit on top of them.
- Saved decisions, hand-off generations, the dispatch journal and recovery packets all add more resume paths.

All three bugs above were in how these pieces fit together on resume.

Questions to investigate:
- Which states really need to be separate? For example, `turn-intended` vs `turn-uncertain`, `remediation-intended` vs `remediation-uncertain`, `review-failed` vs `operator-menu` vs `recheck-required`.
- Can resume be one rule? Find the last finished outcome, then: if QA rejected the work on unchanged code, go to the Builder or the question; if QA broke, restart the review with the same evidence; if the code changed, review again.
- Should the QA recovery steps and the QA states merge into one model?
- How should keys for saved decisions be built, so an answer stays valid exactly as long as what it answered stays the same?
- Testing: one table of "paused at X, then resumed" cases, covering every state.

Also: the full ai-foreman test suite takes about 8–10 minutes. A few QA test files take most of that because they start real processes and wait on real timers. Possible quick wins: run more files at once (`RAFI_TEST_CONCURRENCY`, default 4), and use a fake clock in the slow QA tests.
