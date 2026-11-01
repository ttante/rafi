# Agent instructions review

Status: **findings; folded into the ai-foreman rewrite** (`AI_FOREMAN_REWRITE.md`, principle 13). Written 2026-10-31.

Covers what rafi tells its agents (builder, QA, planner, manager and the others): the compiled agent files, the rule packs and skills from `packages/special-agents/content/`, the tracker rules, and the per-turn prompts ai-foreman adds. Every number below was measured on 2026-10-31 from moneyTree's compiled files and the Codex session log for the T002 build turn (`~/.codex/sessions/2026/10/29/rollout-2026-10-29T11-45-13-01a1888d-…jsonl`).

## What the model makers say

- **Anthropic** ([prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)):
  - Newer models "are also more responsive to the system prompt than previous models… The fix is to soften any aggressive language. Where you might have said 'CRITICAL: You MUST use this tool when...,' you can use more normal prompting."
  - "Tune anti-laziness prompting: If your prompts previously encouraged the model to be more thorough or use tools more aggressively, reduce that guidance."
  - Explaining "why such behavior is important… can give Claude more information about your goals."
  - It offers a sample instruction: "Never speculate about code you have not opened."
- **OpenAI** ([GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)):
  - "Poorly-constructed prompts containing contradictory or vague instructions can be more damaging to GPT-5 than to other models… it expends reasoning tokens searching for a way to reconcile the contradictions."
  - Cursor found "Be THOROUGH…" prompting "counterproductive with GPT-5" because it "caused the model to overuse tools."
- **Claude Code** ([memory docs](https://code.claude.com/docs/en/memory.md)):
  - "Target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence."
  - "If two instructions contradict each other, Claude may pick one arbitrarily."
  - Task-specific instructions belong in skills, "which only load when you invoke them or when Claude determines they're relevant."

## What to remove or shorten

1. **The same rules are sent up to 7 times in one session.** In the T002 builder session, the rule packs ("Core Working Agreement" through "Accessibility") appear in:
   - the Codex developer instructions (32,629 characters);
   - `AGENTS.md` (33,863);
   - 5 of rafi's per-turn messages (35,542 to 89,469 each).

   Input other than the model's own replies totaled 393,964 characters, roughly 100,000 tokens at about 4 characters per token, before counting the code the agent read.

   Fix: send the rules once, in the agent's standing instructions. Per-turn messages carry only what's new for that turn.
2. **Every ticket gets all the rule packs.** The compiled builder file (`.codex/agents/builder.toml`) is 22,320 characters and 267 lines, above Claude Code's 200-line guideline.
   - moneyTree is marked `ai=on frontend=on`, so all 6 AI packs and the accessibility pack go to every ticket. T002, for example, is workspace persistence, with no AI or UI work.
   - Fix: pick packs per ticket, from the ticket's area and files.
3. **Skills are preloaded in full.** The builder prompt includes the full text of `handoff`, `tdd`, `improve-codebase-architecture` and `rafi-graph`. Codex's skills list (8,238 characters) is also sent.
   - Fix: list skills by name and description, and let the agent load one when it's relevant.
4. **The whole ticket queue is sent for one ticket.** The builder's main build message for T002 included the full `LLM_NEXT_QUEUE` table from `docs/ticket-progress.md` (33 rows, about 48,000 characters). It was sent once, not every turn.
   - Fix: send the assigned ticket, its acceptance criteria, and a one-line status for each ticket it depends on.
5. **The Graphify paragraph is in every agent's preamble** (`content/preamble.md`). Fix: put it in the `rafi-graph` skill only.
6. **The triple-check lines** (already planned, malformed-reply item 12).

## Contradictions to remove

OpenAI and Claude Code both say contradictions hurt. These are in rafi's instructions today:

1. **"Ask the user" in an unattended build.** The builder rules say to "ask the user when a decision changes product behavior, cost, security posture, data model, or public API contracts" (compiled builder line 7), and to "ask the user before rewriting the tests" (line 73). During a build the builder can't ask anyone; it can only report "blocked" or "needs input" in its reply. Fix: say exactly that.
2. **A skill that waits for user picks.** `improve-codebase-architecture` has steps "User picks a candidate" and "User picks an interface", but it's preloaded for the unattended builder. Fix: drop it from the builder, or give it an unattended mode.
3. **The tracker rules disagree with rafi.** From `packages/ai-foreman/src/tickets/renderMarkdown.ts`:
   - "Choose the first row in `LLM_NEXT_QUEUE`" (but rafi assigns the ticket);
   - "Use `foreman tickets complete`" (but the same file says "Rafi… controls completion after independent QA");
   - `foreman` isn't a command. The installed one is `ai-foreman` (`packages/ai-foreman/package.json`), there's no `foreman` on this machine, and I found no alias in rafi's source.
4. **Stale generated files aren't refreshed.** moneyTree's `.tickets/tracker-rules.md` is dated 2026-10-05 and still describes the `STEP_STATUS` protocol, which 0.10.1 removed. Rafi never regenerates it, and it's still sent to the builder.

## What to improve

1. **Validate before telling** (new; requested 2026-10-31). Every rafi agent checks a fact against the source before reporting it. Per role:
   - **Builder:** report only what you ran or saw. Cite rafi's recorded command (for example "test run #3") instead of describing results from memory.
   - **QA:** check each requirement by reading the code or running the test. If you didn't check it, mark it "unable to verify" and say what would confirm it.
   - **Planner and Ticket Maker:** read the code before describing what already exists.
   - **Manager:** cite the record (run, ticket, report) behind every answer.
2. **Say why, in plain language.** Replace "never" and "must" lists with one-line reasons, and remove pressure wording (Anthropic guidance above). The compiled builder file has 24 uses of must, never, always, do not or don't.
3. **One instruction per fact.** Each rule lives in one place: rule pack, skill, or per-turn prompt.
4. **Rafi-owned files carry a version and are regenerated on upgrade** (`tracker-rules.md`, compiled agent files).
5. **Measure, don't guess.** Run the scenario harness with the current instructions and with the trimmed ones. Keep a cut only if the pass rate holds. Track instruction characters per turn in the event log.
6. **Check compiled files for problems.** Claude Code's `/doctor prompt-audit` looks for "instructions written for older models, references to files or commands that don't exist, and files that contradict each other" (memory docs above). Run it on a compiled project during the rewrite.

## Now or in the rewrite

- **Now (0.10.x, track D):** the validate-before-telling lines for each role (improvement 1), and fixing contradictions 1–3 in the text. These are wording changes in `special-agents` and `renderMarkdown.ts`.
- **Rewrite:** everything else, since it changes how prompts are assembled (sending once, per-ticket packs, skills on demand, smaller turns, regenerated files, measurement).
