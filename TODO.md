# Rafi TODO

Work is split into parallel tracks. See "Parallel tracks" in [`AI_FOREMAN_REWRITE_PLANNING_GUIDE.md`](AI_FOREMAN_REWRITE_PLANNING_GUIDE.md). Run no more than 3 at once.

## Track A: ai-foreman rewrite planning (critical path)

1. **ai-foreman rewrite.** See [`AI_FOREMAN_REWRITE.md`](AI_FOREMAN_REWRITE.md) for the why, bad patterns and design principles, and [`AI_FOREMAN_REWRITE_PLANNING_GUIDE.md`](AI_FOREMAN_REWRITE_PLANNING_GUIDE.md) for the step-by-step process with prompts.
2. **Older plan docs: harvested (2026-10-30 and 10-31).** Covers the repo root, `docs/` and `rafi-plan-docs/`. What's still needed is in `AI_FOREMAN_REWRITE.md`, "From the older plan docs" and "From the `docs/` plans and `rafi-plan-docs/`".
3. **Folded into the rewrite.** These are built into the new engine, not patched in the current one. The rewrite doc's "Work folded into the rewrite" section lists what it takes from each.
   - **QA manual checks and recovery fixes.** See [`QA_MANUAL_CHECKS_AND_RECOVERY_FINDINGS.md`](QA_MANUAL_CHECKS_AND_RECOVERY_FINDINGS.md). It covers checks only a person can do, the three QA pause/resume bugs (fixed in 0.10.2), and the initiative to simplify QA pause and resume.
   - **Plan update approval improvement.** See [`PLAN_UPDATE_APPROVAL_IMPROVEMENT.md`](PLAN_UPDATE_APPROVAL_IMPROVEMENT.md). It covers locked requirements, a default of "change the plan and tell the user", a backup plan to switch back to, and a saved setting instead of a question on every resume.
   - **Malformed reply and blocked build improvements.** See [`MALFORMED_REPLY_AND_BLOCKED_BUILD_IMPROVEMENTS.md`](MALFORMED_REPLY_AND_BLOCKED_BUILD_IMPROVEMENTS.md). Found on moneyTree T002: check permissions for the whole build before step 1, no quiet substitutes, let QA run the full test suite, one shared handler and repair try for malformed replies, smaller replies, and removing QA's triple-check lines.
   - **Agent instructions review.** See [`AGENT_INSTRUCTIONS_REVIEW.md`](AGENT_INSTRUCTIONS_REVIEW.md): send rules once, pick packs per ticket, load skills on demand, send only the assigned ticket, validate before telling, and measure the effect.

4. **Agent context: decided 2026-11-01.** See `AI_FOREMAN_REWRITE.md`, "Agent context: tags". Original notes, from [`AGENT_INSTRUCTIONS_REVIEW.md`](AGENT_INSTRUCTIONS_REVIEW.md):
   - Problems found in the T002 build:
     - The same rules reached the builder 7 times: its agent file, `AGENTS.md`, and 5 rafi messages.
     - 4 skills were pasted in full instead of listed.
     - The whole 33-ticket queue was sent for one ticket.
     - AI and UI rule packs are switched on per project, so every ticket gets them.
   - Proposal: tag tickets, and give each agent only the rules matching its ticket's tags. Use a fresh builder per ticket by default (`session_strategy: fresh` already exists); reusing one builder is an override that gets all tags in scope.
   - Tools (`AI_FOREMAN_REWRITE.md`, "Test tools") are picked by the same tags, so the answers apply to them too.
   - Questions to answer:
     - Who tags tickets?
     - Fixed tag list, or project tags too?
     - Does QA get the same tags?
     - Fresh sessions for QA too?
     - Tags now, or start with file-pattern rules and on-demand skills?
   - **Instruction-text fixes, moved from the old track D (decided 2026-11-01: rewrite only, no 0.10.x patch):**
     - Remove the triple-check lines from QA's instructions (malformed doc item 12).
     - No quiet substitutes: the builder reports "blocked" instead of swapping in a different stack (malformed doc item 2).
     - Planner wording for checks only a person can do (QA findings doc, section 1, "A lighter alternative", point 1).
     - A validate-before-telling instruction for each rafi agent, and removing three contradictions: "ask the user" in unattended builds, a skill that waits for user picks, and tracker rules that disagree with rafi ([`AGENT_INSTRUCTIONS_REVIEW.md`](AGENT_INSTRUCTIONS_REVIEW.md), "When").

## Track B: scenario test harness

5. **Harness against today's rafi.** Guide steps 4–6. The harness itself can start early; the scenarios follow once `REWRITE_SCENARIOS.md` is reviewed.

## Track C: moneyTree builds

6. **Keep building moneyTree on rafi 0.10.x**, locally, through Remote Control. Every failure is a candidate scenario for track B.

## Later

7. **Rafi GUI.** See [`GUI_PRODUCT_REQUIREMENTS.md`](GUI_PRODUCT_REQUIREMENTS.md). Product requirements draft 0.2, with open questions in §16 and phasing in §17. It's built after the rewrite, and the rewrite covers its engine needs (§11). Answering the §16 open questions can happen any time.
