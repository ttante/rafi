# Malformed reply and blocked build: improvements

Status: **proposed, not started.** All items are folded into the ai-foreman rewrite (`AI_FOREMAN_REWRITE.md`, "Work folded into the rewrite"). Items 2 and 12 were planned for 0.10.x too; on 2026-11-01 that was dropped, so they're built in the rewrite only.
Found 2026-10-29 on moneyTree run `1ed6893e-86dd-4d37-bc2e-7393d0d3dd69`, ticket T002.

## What happened

1. The builder finished T002 and reported it done.
2. QA finished its review and rejected the work:
   - Data was saved to a local JSON file, not to PostgreSQL/Drizzle as the ticket requires.
   - There were no tests for unauthorized access.
3. The builder fixed the test gap. It reported the database finding as blocked, because the run had no internet (`grantedNetwork: false`) and nothing could be installed. `package.json` has no dependencies.
4. The builder's reply had one extra `}`, so the JSON closed early at byte 4412 and the `continuity` section fell outside it. Rafi's parse failed: "Structured result is not valid JSON: trailing content at byte 4412".
5. Rafi labeled the reply `delivery-uncertain`, deferred T002, and printed the raw JSON as the reason.

Evidence:
- Turn record `4c4b0454…` in `qa_delivery_turns` (`.rafi/recovery.sqlite3`): `validationErrors: ["Builder completion is missing, duplicated, or uncorrelated"]`, plus the parse error above.
- Raw reply: object `acbb06f0…` (5,641 bytes) in the run's QA recovery folder.
- Codex session log `~/.codex/sessions/2026/10/29/rollout-…01a1888d-2286-…jsonl`: 1 of 5 final replies was invalid JSON.

**The format isn't actually enforced.** Rafi sends a schema (`adapters/codex.ts:262`), but the reply left out a required field and still came back. Rafi can't rely on Codex to enforce the format, so it must handle bad replies itself. This is the second malformed reply this week; the first was fixed in 0.10.2 (`reconcileAnsweredInvalidJsonDispatches`).

## Direction

Across all 18 moneyTree builds, none finished on its own (T001 was eventually waived). Only 1 of the 18 stops was bad JSON:

| Cause | Stops |
|---|---|
| The environment blocked the agent: no internet, no local servers, npm cache access, StarNet not reachable | ~10 |
| Builder didn't name its ticket in the reply, or other strict-format checks | 3 |
| The work needed a person (approvals, live StarNet, a patch decision) | ~3 |
| Timeout | 1 |
| Malformed JSON | 1 |

Rafi's first answer to a problem is to stop and wait for a person. That has to change. In priority order:

1. **Retry before stopping.**
   - Every recoverable error (bad JSON, timeouts, format slips) is retried automatically, with the error sent back to the agent, before anyone is asked.
   - Asking the user is the last resort, never the first response.
2. **Check the environment and permissions before the build starts.** See item 1 below. This would have caught about 10 of the 18 stops.
3. **Simplify the recovery machinery.**
   - Today the recovery machinery means many QA states, recovery files, and fingerprint checks that each stop the run when they don't match.
   - The bugs found live (3 resume bugs, 4 recovery-file bugs, this one) were all in that machinery.
   - Aim for fewer states and fewer checks that stop the run.

Rafi goes through Codex's agent loop, so it doesn't control how the final JSON is generated. Common workarounds:
- Retry with the error.
- Let the builder write its report in plain text, then make one short, strictly formatted call that turns it into JSON. This needs a direct model call (an API key), which rafi doesn't make today.

## When

The rewrite replaces the code most of these items touch, so building them twice would waste effort and cause merge conflicts.

| Item | When | Why |
|---|---|---|
| 1. Permission check for the whole build | Rewrite | New flow before step 1; rewrite principle 5 |
| 2. No quiet substitutes | Rewrite (was "now" on 0.10.x; dropped 2026-11-01) | Builder instruction text only |
| 3. QA runs the full test suite | Rewrite | Sandbox and permission model; part of item 1 |
| 4. Shared malformed-reply handler | Rewrite | Rewrite principle 6 |
| 5. One automatic repair try | Rewrite | Rewrite principles 4 and 6 |
| 6. Correct label | Rewrite | `delivery-uncertain` goes away with the QA recovery machinery |
| 7. Plain-English stops | Rewrite | Rewrite principle 7 |
| 8–11. Smaller replies | Rewrite | Reply formats are redesigned; rewrite principle 6 |
| 12. Remove triple-check lines | Rewrite (was "now" on 0.10.x; dropped 2026-11-01) | Instruction text only; rewrite principle 12 |

## Improvements

### What caused the crash

1. **Check permissions for the whole build, then ask once, before step 1.**
   - Before any building starts, inspect every ticket and step in the requested build (e.g. all 20 steps of `rafi start . --steps 20`) for what it will need: internet, local servers, packages not yet installed, and so on.
   - If anything needed isn't granted, ask the user right away, before step 1, even if only step 20 needs it. Don't wait until the step that needs it, or until QA rejects the work.
   - Choices:
     - **Allow once:** for this build only.
     - **Always allow:** saved for this project.
     - **Don't allow:** the steps that need it are marked blocked, and the reason is shown up front.
   - Covers both the builder and QA.
   - Here, T002 needs pnpm, TypeScript, Fastify, Zod, PostgreSQL and Drizzle, none were installed, and the run had no builder network.
2. **No quiet substitutes.** On its first pass the builder used a JSON file instead of PostgreSQL and reported done. When it can't meet the required stack, the builder should report "blocked" instead of swapping in a substitute.
3. **Let QA run the full test suite.**
   - QA's sandbox blocks local servers (loopback) and temp-file writes. Five StarNet tests failed with EPERM for this reason, and QA couldn't run the workspace persistence tests.
   - QA needs a supported way to run them. That includes being part of the upfront permission check in item 1.

### Malformed JSON

4. **One shared handler for malformed replies**, used by every structured operation. Today each operation handles it separately: the builder-work path has the 0.10.2 fix, but QA remediation (`qaFailureDelivery.ts`) doesn't. Fold the 0.10.2 fix into the shared handler.
5. **One automatic repair try.** Tell the model the reply was invalid at byte X and ask it to resend valid JSON, with no tools and no code changes. Accept the resend only if it matches the readable parts of the original; otherwise stop with a clear message. This replaces the current rule of never asking again (`qaFailureDelivery.ts`: "A second model turn cannot prove content equivalence").
6. **Correct label.** A malformed reply is reported as malformed, never as `delivery-uncertain`. Today the provider error flag fails the completion check in `qaFailureDelivery.ts`, and `classify` then returns `delivery-uncertain`.
7. **Plain-English stops.** When the builder is blocked, show its one-line reason, e.g. "Blocked: needs internet to install PostgreSQL/Drizzle". Never print the raw JSON.

### Smaller replies

The reply was 5.6 KB and 8 levels deep. About 2 KB of it is not repeated anywhere else; the "blocked on the database" fact appears about 8 times.

| Part | Size | What's in it |
|---|---|---|
| Findings | 2.2 KB | the actual content |
| Coverage | 1.2 KB | mostly repeats the test results already inside the findings |
| Continuity | 1.2 KB | notes for the next session, mostly a summary of everything above |
| Summaries and reason | 0.5 KB | three summaries plus a reason, all saying the same thing |
| Echoed IDs | 0.2 KB | IDs rafi gave the builder and already knows |

8. **State each fact once.** Rafi builds coverage and the continuity notes from the findings. Drop the duplicate summary and reason fields.
9. **Stop echoing known IDs.** Don't have the model repeat `handoff_id` or `finding_key`; rafi already has them.
10. **Cite recorded commands.** Rafi already records the builder's commands. The builder cites them (e.g. "test run #3") instead of retyping their output. This is smaller, and more trustworthy because rafi has the real output.
11. **Reduce nesting.** Use flatter shapes, like the flat wire format already used for ticket population (`spec/src/operationContracts.ts`).

### QA instructions

12. **Remove the hard-coded triple-check lines** from QA's instructions:
    - `foreman.ts`, `buildQaInstruction`: "Triple-check your work" and "Triple-check."
    - `qaReview.ts` (QA hand-off text): "Be very thorough… Triple check your work to ensure nothing is left out and all required fields are added and populated correctly."

    Keep "Do not rubber-stamp your own work. Be skeptical." Code already checks the required fields, and wording like "don't leave anything out" pushes models to repeat everything.

## Out of scope

A response auditor agent: code checks plus one repair try cover it.

Correct-JSON example libraries: low value. They add length and wouldn't have prevented this.
