# Rewrite build handoff

For the session that builds the new rafi engine (guide step 10). Planning is finished; this doc says what to read, the rules, and where to start.

Branch: `feature/rewrite`. Node 24, pnpm 10.

## What you're building

A new engine for rafi 1.0, built beside today's one and switched on with `RAFI_ENGINE=next`. Today's engine (`packages/ai-foreman`) stays the default until the switch, and nothing in it changes. There is no backward compatibility: the new engine reads only 1.0 formats, and `rafi migrate` converts old projects.

## Read first, in this order

0. `/Users/tyler/reps/activeWork/rafi-process/RAFI_COMPASS.md`: how the user thinks about rafi. When the docs don't answer something, decide the way it points.
1. `REWRITE_ARCHITECTURE.md`, the build plan. Read all of it once. Then keep these open:
   - 1.2: the security model;
   - 2: packages, modules, size budgets and code rules;
   - 3–4: the event log and state machines, including 4.8, workflows and roles as data;
   - 14: milestones;
   - 15: decisions.
2. `REWRITE_REQUIREMENTS.md`, the contract: every user-visible behavior, marked keep, change or drop. Section 9.0 holds every decision (it wins over older rows). Look things up here; don't read it end to end.
3. `REWRITE_SCENARIOS.md`, the tests:
   - 1–2: how to read a scenario, fixtures and fake-agent scripts;
   - 7: the harness design, which you build in M1;
   - the scenarios your milestone must pass.
4. `AI_FOREMAN_REWRITE.md`: the why, the 11 bad patterns and the design principles. Skim it; every design choice traces back to it.
5. `AI_FOREMAN_REWRITE_PLANNING_GUIDE.md`, step 10: the loop below.

## Rules

- **Validate before you tell.** Before you report anything as fact (what code does, a count, a status, that a test passes), check it in this session against the code, files or command output. If you couldn't check something, say so and say what would confirm it.
- **Test-first.** For each milestone: write its scenarios, see them fail, build, see them pass. No baseline against 0.10.2.
- **One milestone at a time,** in order. Every earlier milestone's scenarios keep passing.
- **The gate is the fast suite:** every active scenario, the transition tests, the log tests and `scripts/check-rules.mjs`, in under 60 seconds on 4 workers.
- **Code rules** (`REWRITE_ARCHITECTURE.md` 2.4, enforced by `scripts/check-rules.mjs`):
  - files under 500 lines, functions under 100 lines, lines under 120 characters;
  - no `Date.now`, timers, `process.*`, `node:fs` or `node:child_process` outside `deps/real/`;
  - no module-level mutable state;
  - no triggers in migrations;
  - `engine` never imports `ai-foreman`;
  - Windows-safe paths and commands.
- **Security in every milestone.** A milestone isn't done until the security tests for what it added pass (architecture 1.2 and each milestone's "Security" line).
- **Don't decide product questions.** If the docs don't answer something the user would care about, ask. Implementation details the docs leave open are yours to choose; record the choice in your milestone plan.
- **Don't change the planning docs on your own.** If something in them is wrong or can't be built, stop and say so with evidence, plus a suggested fix. The user approves changes.
- **The user commits and pushes.** Don't commit unless asked.
- **Report plainly and briefly:** what's done, what's left, what failed and why, anything you couldn't check.

## The loop for each milestone

Use a fresh session for each part.

1. **Plan.** "Write the implementation plan for milestone N in `REWRITE_ARCHITECTURE.md`." The plan says:
   - the files to add, with their size budgets;
   - the scenarios to write first;
   - the order of work;
   - the security tests;
   - each implementation choice the docs leave open.
2. **Audit.** A fresh session checks the plan against the codebase and the planning docs. Update the plan with what it finds.
3. **Implement,** test-first.
4. **Review.** A fresh session, ideally Codex, reviews the code. Fix what it finds.
5. **Merge** to `feature/rewrite`. The user does the commit.

## Where to start: milestone 1

The full list is `REWRITE_ARCHITECTURE.md` section 14, M1.

1. **First, the fake `claude` check** (architecture 11.7, time-boxed to half a day). Build `packages/scenarios/fakes/claude-cli.mjs` and drive it with the installed Agent SDK.
   - **If it works,** it joins the process set.
   - **If it doesn't,** follow decision 3: the in-process fake plus the live suite, and no test-only code in the adapter.
2. **Then build:**
   - `packages/engine` with `deps` and their real versions;
   - `scripts/check-rules.mjs`;
   - the event log: tables, append, cursor reads, lease, blobs, migrations;
   - the three transition functions, the fold, `decide` and the label maps;
   - the built-in workflow (`standard`) and the role registry as data, with their load checks; build the transition tests from the workflow data (architecture 4.8). Don't hard-code the step list anywhere else;
   - `runCli` with every command and its help text (commands not built yet say so and exit 1);
   - dropped commands and flags exiting 1, naming what replaced them;
   - the engine switch and both format refusals;
   - thin adapters over the `deps` transports;
   - `packages/scenarios`: the fixtures, the script engine, the in-process Codex and Claude fakes, the Codex fake executable (from `packages/rafi/test/fixtures/e2e-codex-faults.cjs`), the fake clock, notifier and terminal, crash and pause hooks with the write fence, the invariant checker, the transcript and the coverage ledger.
3. **M1's security tests:**
   - secrets redacted on every write;
   - the write fence holds after a simulated crash;
   - validation on read;
   - imported events never folded;
   - `check-rules` passing;
   - the fast suite also running on Windows.
4. **Done when** S-CLI-1 and S-CLI-2 pass, every (state, event) pair is tested, the log tests and the fake-fidelity tests pass, and the fast suite runs in under a minute.

## Still unverified (check each one when its milestone starts)

| What | Milestone | If it fails |
|---|---|---|
| The Agent SDK can drive a fake `claude` | M1 | Decision 3: in-process fake plus the live suite |
| Codex reaches rafi's local MCP endpoint per session | M2 | Attach it with `-c mcp_servers.rafi.url=…` when the app-server starts |
| Which OS sandbox `run_check` uses (`sandbox-exec`, bubblewrap) | M2 | Switch to a solid replacement without the problem |
| Each sandbox can allow local servers without internet | M2 | The upfront item says local servers need internet there and offers: grant internet, run it yourself and resume, or skip |
| `alerter`'s current flags and output | M7 | A plain notification without buttons |

## Where things are

| What | Where |
|---|---|
| Today's engine (frozen) | `packages/ai-foreman` |
| Today's CLI layer (frozen); the new one goes in `src/next/` | `packages/rafi` |
| Schemas (new 1.0 ones go beside the old) | `packages/spec` |
| Rule packs, skills, role text (now tagged) | `packages/special-agents` |
| New: the engine | `packages/engine` |
| New: harness, fakes, scenarios, ledger | `packages/scenarios` |
| The Codex fake to start from | `packages/rafi/test/fixtures/e2e-codex-faults.cjs` |

Code citations in the architecture doc are relative to `packages/` unless they say otherwise.
