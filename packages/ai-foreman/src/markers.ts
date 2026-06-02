/**
 * STEP_STATUS protocol strings. Extracted from foreman.ts so tests can import
 * them without pulling in @clack/prompts (which requires Node >=20 for styleText).
 */

export const MARKER_SPEC = `End EVERY turn with exactly one marker line as the LAST line, nothing after it:
  STEP_STATUS: done | ticket="T001" summary="what you just did" next="the next ticket or step"
  STEP_STATUS: blocked | ticket="T001" reason="why you cannot proceed"
  STEP_STATUS: plan_complete | ticket="T001" summary="what you just did"
  STEP_STATUS: needs_input | question="your question for the user" choices="Option A|Option B|Option C"
Use "done" after finishing a ticket or step when more remain, "plan_complete" after
the final ticket or step, "blocked" if you cannot proceed without help, and "needs_input"
if you need the user to make a decision before continuing.
Always include ticket="<ticket-id>" in done/blocked/plan_complete markers when working from a ticket queue.
After "done" or "plan_complete", foreman may run a QA pass on your work — expect a
follow-up instruction asking you to triple-check accuracy, tests, and ticket satisfaction.`;

export const QA_MARKER_SPEC = `End EVERY turn with exactly one marker line as the LAST line, nothing after it:
  STEP_STATUS: qa_pass | summary="confirmed everything checks out"
  STEP_STATUS: qa_fail | issues="bullet-list of concrete problems found"
  STEP_STATUS: blocked | reason="why QA itself cannot proceed"
  STEP_STATUS: needs_input | question="..." choices="..."`;
