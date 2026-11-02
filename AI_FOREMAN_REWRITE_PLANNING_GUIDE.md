# ai-foreman rewrite: planning guide

A step-by-step guide to planning and carrying out [`AI_FOREMAN_REWRITE.md`](AI_FOREMAN_REWRITE.md), with a prompt to paste for each step.

## Ground rules

- **Each step is a new session.** Plans live in files, not in chat history.
- **Writing and reviewing are separate sessions.** A review session never sees the writing conversation.
- **Answer questions yourself.** When a session asks you something, you answer; it shouldn't assume.
- **Model and reasoning:**
  - In Claude Code, pick both with `/model`.
  - In Codex, pick them with `/model`, or start with `codex -c model_reasoning_effort="high"`.

| Stage | Model | Reasoning |
|---|---|---|
| Requirements, scenarios, architecture plan | The most capable model available | High, or extra-high for the architecture plan |
| Independent reviews | A different model family (for example Codex/GPT) | High |
| Final architecture review (second reviewer) | The most capable Claude model | Max |
| Milestone implementation | The most capable model | Medium–high |
| Routine work (tests, mechanical changes) | A faster model is fine | Medium |

## Parallel tracks

Up to three tracks can run at the same time, each in its own session and its own branch (worktree). Merge them one at a time.

| Track | What | Where | Notes |
|---|---|---|---|
| A | Rewrite planning: steps 1–9 below | Branch `rewrite/plan` | The critical path, so start it first. The steps within it run in order, never in parallel. |
| B | Scenario test harness against today's rafi | Its own branch | Start the harness itself early (scripted fake agent, running the real `rafi` command in a temporary project). Write the scenarios after step 5 locks them, then finish step 6. |
| C | moneyTree builds on rafi 0.10.x | Locally, on the Mac | Check on them from your phone with Remote Control. Every failure is a candidate scenario for track B. |

Rules:
- **No more than 3 tracks at once.** Every track ends with you reviewing it. With more, the reviews pile up and your answers to each session suffer.
- **Don't fix ai-foreman twice.** Fixes to the current engine go into the rewrite requirements instead. (A track D of small 0.10.x fixes was dropped on 2026-11-01; its items are in the rewrite.)
- **Tracks A and B share files** (`REWRITE_SCENARIOS.md`). Track B only edits it in step 6.

## Planning

### Step 0: Prep (5 minutes)

```
cd /Users/tyler/reps/activeWork/rafi && git checkout -b rewrite/plan
```

Commit `AI_FOREMAN_REWRITE.md`, this guide, and the docs it folds in (`MALFORMED_REPLY_AND_BLOCKED_BUILD_IMPROVEMENTS.md`, `QA_MANUAL_CHECKS_AND_RECOVERY_FINDINGS.md`, `PLAN_UPDATE_APPROVAL_IMPROVEMENT.md`, `GUI_PRODUCT_REQUIREMENTS.md`, `AGENT_INSTRUCTIONS_REVIEW.md`) to that branch.

### Step 1: Requirements doc

Session: the strongest model, high reasoning.

> Read `AI_FOREMAN_REWRITE.md`. Write `REWRITE_REQUIREMENTS.md`: every user-visible behavior of rafi that the rewrite must keep. Cover commands and flags, prompts and questions, files rafi reads and writes in a project, ticket/plan/config formats, and outputs. Source it from `rafi --help` on every command, the docs, and `GUI_PRODUCT_REQUIREMENTS.md`. Mark each item **keep**, **change** (and to what) or **drop**.
>
> Also add a section for new behavior. Cover every item in "Work folded into the rewrite" and "What the GUI needs from the engine" in `AI_FOREMAN_REWRITE.md`. Read each source doc listed there for the details, and carry its open questions into yours.
>
> List open questions for me at the end. Don't design anything yet.

### Step 2: You review the requirements

- Answer its open questions.
- Strike anything you don't use.
- Flag anything missing from how you actually use rafi.

This is the most important step: everything after it builds on this doc.

### Step 3: Independent requirements review

Session: Codex, high reasoning, fresh.

> Review `REWRITE_REQUIREMENTS.md` against the rafi codebase. Find user-visible behaviors that are missing, wrong, or contradictory. Report findings only; don't edit.

Then, in a new Claude session:

> Update `REWRITE_REQUIREMENTS.md` with these findings: [paste]. Ask me about anything that needs a decision.

### Step 4: Scenario test plan

Session: the strongest model, high reasoning.

> Read `REWRITE_REQUIREMENTS.md` and `AI_FOREMAN_REWRITE.md`. Write `REWRITE_SCENARIOS.md`, covering:
> - The whole-build scenarios the new engine must pass, each with setup, steps and expected result. Include: start, QA fail then fix then pass, blocked ticket, upfront permission prompt (once/always/no), malformed reply then repair, timeout then retry, crash at every step then resume, multi-ticket batch, plan update. Also include every case in "Past bugs to turn into scenario tests", and the scenario tests listed under "Ask everything up front", "Blocked tickets: keep going and ask", "Notifications" and "Test tools", in `AI_FOREMAN_REWRITE.md`.
> - The design for a scripted fake-agent harness that runs them through the real `rafi` command, in seconds. Use Part 1 (E01–E18) of `no-longer-relevant-plans/rafi-plan-docs/rafi-harness-requirements.md` as input.
>
> Don't implement yet.

### Step 5: Review the scenarios

Session: Codex, high reasoning, fresh.

> Review `REWRITE_SCENARIOS.md` against `REWRITE_REQUIREMENTS.md`. Which requirements have no scenario? Which scenarios are untestable or vague? Report findings only.

Apply the fixes in a new Claude session, as in step 3.

### Step 6: Build the harness and run it against today's rafi

Session: the strongest model, medium–high reasoning. This is where track B finishes. If the harness was started early, build on it.

> Implement the harness and scenarios in `REWRITE_SCENARIOS.md`. Run them against the current rafi, and record pass/fail per scenario in the doc. Don't fix rafi bugs; just record them.

This is the baseline: the scenarios that fail today are the bugs the rewrite must beat.

### Step 7: Architecture plan

Session: the strongest model, extra-high reasoning.

> Read `AI_FOREMAN_REWRITE.md`, `REWRITE_REQUIREMENTS.md` and `REWRITE_SCENARIOS.md`. Write `REWRITE_ARCHITECTURE.md`. Cover:
> - modules and their size budgets;
> - the event log schema;
> - the full state machine table (state, event, next state);
> - error categories and retry rules;
> - agent reply formats, with example JSON;
> - the upfront permission check;
> - how `rafi` commands call the engine;
> - the engine switch;
> - what's deleted;
> - whether the native Codex and Claude modes (structured output, sessions, event streams) can replace parts of rafi's adapters (harness plan H01–H02 in `no-longer-relevant-plans/rafi-plan-docs/rafi-harness-requirements.md`).
>
> Then list milestones, each mapped to the scenarios it must pass. Follow the design principles in `AI_FOREMAN_REWRITE.md`. List the decisions you need from me.

### Step 8: Architecture reviews

Run these two fresh sessions in parallel.

Codex, high reasoning:

> Review `REWRITE_ARCHITECTURE.md` against `REWRITE_REQUIREMENTS.md` and `REWRITE_SCENARIOS.md`. Look for gaps, states or errors that aren't handled, and anything that recreates the bad patterns listed in `AI_FOREMAN_REWRITE.md`. Report findings only.

The strongest Claude model, max reasoning: the same prompt.

### Step 9: Revise and lock

Session: the strongest model, high reasoning.

> Update `REWRITE_ARCHITECTURE.md` with these review findings: [paste both]. Ask me about anything that needs a decision.

Then you read it. When you're happy, mark `REWRITE_REQUIREMENTS.md`, `REWRITE_SCENARIOS.md` and `REWRITE_ARCHITECTURE.md` as **Status: locked**, and commit them.

## Implementation

### Step 10: Per-milestone loop

Repeat for each milestone in `REWRITE_ARCHITECTURE.md`. Use a fresh session for each part.

1. **Plan.** The strongest model, high reasoning:
   > Write the implementation plan for milestone N in `REWRITE_ARCHITECTURE.md`.
2. **Audit.** A fresh session audits that plan against the codebase and the locked docs. Update the plan with the findings.
3. **Implement.** A fresh session implements it. The milestone's scenarios must pass.
4. **Review.** A fresh session, ideally Codex, reviews the code. Fix the findings.
5. **Merge** to the rewrite branch.

The old engine stays the default the whole time.

### Step 11: Dogfood and switch

1. Convert moneyTree with `rafi migrate` (keep a copy first), then run T002 onward on the new engine (`RAFI_ENGINE=next`). Every failure becomes a new scenario.
2. After several clean builds, make the new engine the default and release it as `@rafi-ai/cli` 1.0 / ai-foreman 3.0.
3. One release later, delete the old engine.

## Rough time

- Steps 1–9: a few days, mostly your review time.
- Each milestone in step 10: about a day.
