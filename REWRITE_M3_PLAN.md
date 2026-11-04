# M3 implementation plan: the QA loop

Status: **implemented** (part 4; results in section 10). Before that: plan, audited (parts 1 and 2). The audit (`.rafi-build/M3-audit.md`) is applied below; where a finding wasn't applied as written, the plan says why (section 11). Next: implement (part 3), once you've answered the two questions at the end.
Milestone: `REWRITE_ARCHITECTURE.md` (ARCH) section 14, M3 (`REWRITE_ARCHITECTURE.md:1698-1702`). Rules: `REWRITE_BUILD_HANDOFF.md` (its item "0." is ignored, as the user decided).
Written 2026-11-03 against `feature/rewrite` at `f5ef059` (M2 committed), from the code M1 and M2 shipped, not only from `REWRITE_M1_PLAN.md` and `REWRITE_M2_PLAN.md`. No code was written for this plan. Paths are relative to `packages/` unless they say otherwise.

## 0. What M3 delivers

From ARCH 14 M3:

- **Builds:** reject, fix and re-review with only what changed; `retries.fixes`; "What next?" with its options and the minimal question record in the same terminal; `fix.granted`; circling; the requirements-file rules (the depth minimum, receipts, missing or changed files making requirements "unable to verify"); unverified requirements; QA isolation (in place or on a copy, light or full fingerprint, drift; Q-COPY-1); "I verified it myself" and "Explicitly waive QA".
- **Must pass (5 as ARCH reads today; 4 once P21 is approved):** S-QA-1, S-QA-3, S-QA-5, S-QA-7, S-CHK-2. S-QA-5 can't pass in full until M5 (P21). Once P21 is approved, the implementer moves S-QA-5's registry milestone from M3 to M5 (`scenarios/checks/registry.ts:31`) and its M3 steps run as a partial.
- **Partial:** S-QA-2 (steps 1–4), S-MAL-2 (variant 3), S-MAL-3 (QA's requirements file, QA's verdict, the builder's fix), S-CHK-3 (step 1 on F-TESTS-LOCAL, without the setup script's run, which needs M7; P22). With P21, also S-QA-5 (all but the F-BRANCH commit).
- **Security:** ARCH 14 has no M3 line (P28). Section 4 derives M3's tests from ARCH 1.2 and 14.1 (`:1675`), plus a threat-model review, as M2 had.
- **Done when:** the five pass in full (S-QA-5 minus its F-BRANCH clause until P21 is decided), the partials' M3 steps pass, every M1 and M2 scenario and test still passes, section 4's tests pass, the threat-model review is written and its new holes are fixed test-first, the fast suite runs under 60 s on 4 workers (section 6), `check-rules` is clean, `tsc` shows 0 errors in engine, scenarios, spec and rafi, the process set stays green, and every red-run and mutation log is on file (section 5).

**Not in M3:** pinned prompts while other tickets build, `rafi answer`, notifications, defer and "answer later", exit 2 without a terminal, the other blocked kinds' options, `answerEffects` beyond what-next (M6); "Pause at this checkpoint", Manager `/request-attempt`, resume and reuse of a saved what-next answer (M4, S-QA-4); "Discuss with read-only Planner" (M8); git delivery and F-BRANCH (M5); the setup script's run (M7); known tools that would let QA verify an `unable` (M10, so `unverified[].tool` stays null).

### 0.1 Facts checked in this session

| Fact | Evidence |
|---|---|
| Baseline fast suite: 46 jobs, 349 passed, 0 failed, 30 skipped; 47.3 s, 44.1 s, 39.6 s wall on 4 workers in three runs | `/private/tmp/m3plan-fast.log`, `m3plan-fast2.log`, `m3plan-fast3.log` |
| Same suite with jobs run longest first (last run's times): 32.6 s and 32.0 s | `/private/tmp/m3plan-fast-lpt.log`, `m3plan-fast-lpt2.log` (a scratch copy of `scenarios/harness/fast.mjs` with one sort added) |
| Today `fast.mjs` runs jobs in file-name order; the slowest job is `scenarios/test/security-m2.test.ts` (19.9 s under load, 11.6 s alone) | `scenarios/harness/fast.mjs:61-65`; `/private/tmp/m3plan-security-m2.test.ts.tap` |
| One in-process one-ticket build takes 380–440 ms and makes 29 child calls (git); a fixture takes about 90 ms | scratch profile over `scenarios/harness/rafi.ts` and `fixtures/f-one.ts`, 3 runs |
| `check-rules`: 165 files, 0 problems. Module totals: build 1155/2000, state 889/1300, turns 379/900, facts 113/450, instructions 151/1000, api 372/600, stats 67/700, progress 44/400, tools 212/1100, deps 636/650; no `ask/` yet (budget 1300) | `node scripts/check-rules.mjs` (`/private/tmp/m3plan-rules.log`) |
| The ticket machine already has the QA rejection loop with `retries.fixes`, `blocked(what-next)` / `blocked(unfixed)`, `fix.granted` counting and `ticket.reopened` | `engine/src/state/ticket.ts:45-57,91-100,131-134,197` |
| A retry from `blocked(what-next)` re-enters `fix` with the same attempt and fix count | `state/ticket.ts:102-109` (only `confirm` counts), `:73-79` |
| The review step always writes `circling: false`, `unverified[].tool: null`, no receipt and no isolation record; it lists every changed file against HEAD and every run | `engine/src/build/steps/review.ts:29-40`; `instructions/messages.ts:47-59` |
| `checks.failed` and `step.failed` always write `circling: false`; `attempt.summary.files_read` is always `[]` | `build/steps/check.ts:35`; `build/steps/common.ts:9`; `build/steps/work.ts:69` |
| The fix message handles only failed check runs: no QA findings, no requirements path, no attempt note | `instructions/messages.ts:71-92`; `build/steps/work.ts:57-58` |
| Prepare hard-codes depth `standard` and renders a section only when its list is non-empty | `build/steps/prepare.ts:11,19-22,49`; `instructions/messages.ts:28` |
| With QA on, the check step runs only the requirements' checks, no related tests | `build/steps/check.ts:20-22` |
| On `wait` the loop releases the lease, prints a line and returns 1 | `build/loop.ts:59-61` |
| The runtime question (C46) already opens and answers a question record in the terminal | `build/context.ts:139-155`; `rafi/src/next/ui/prompts.ts:33-44` |
| The schemas for `question.*`, `waiver.recorded`, `fix.granted`, `qa.isolation` and `requirements.receipt` exist | `spec/src/v1/events/questions.ts`; `spec/src/v1/events/results.ts:16-19,56-63` |
| The 1.0 ticket schema has no `qa_preparation`; today's is a five-level object with minimums by risk category | `spec/src/v1/tickets.ts:21-43`; `spec/src/qaPreparation.ts:2-11,104-108`; `ai-foreman/src/qaPreparationPolicy.ts:49-58` |
| The progress file always writes `answers: {}` | `engine/src/progress/write.ts:41` |
| Claude's `Read` tool event carries its `file_path` as `command` | `engine/src/agents/claude/events.ts:77-79` |
| The fakes have no verdict behaviors beyond `verdictRuns`, and no step for an edit by the user during a turn | `scenarios/fakes/script/behaviors.ts:22-69`; `fakes/script/engine.ts:7-31` |
| Registry milestones: S-QA-2 M8, S-MAL-2 M6, S-MAL-3 M9, S-CHK-3 M8; S-MAL-2 variant 3 is `pending("M3")` | `scenarios/checks/registry.ts:25,49,51,198`; `scenarios/scenarios/malformed.scenario.ts:138` |
| *Added by the audit (part 2), each checked in that session:* | |
| Sessions are cached by `ticket\|role\|reply` and always rooted at `ctx.project`: the agent's `cwd`, `run_check`'s rules root, the check environment's `project` (so the test's `cwd`, sandbox worktree, cache and restore), the permission root and the standing instructions all come from it | `engine/src/build/context.ts:75-86,93-115,195`; `build/session.ts:19,55,61`; `build/checks.ts:51-52,103,106,143-158` |
| `closeSessions(ctx, ticket)` closes every session of a ticket; nothing closes one session alone | `build/context.ts:206-212` |
| A turn records `session: new` only on a session's first turn (`turn.intent.session`) | `build/context.ts:189` (in `oneTurn`); `spec/src/v1/events/turns.ts:16-18` |
| `readRequirements` reads the file on disk every time and compares it with nothing; the check step, the builder's and QA's `run_check` allowlists all take their requirement checks from it | `build/steps/common.ts:36-42`; `build/steps/check.ts:18-21`; `build/steps/work.ts:60`; `build/steps/review.ts:32` |
| Every event type is version 1 and events are strict: `def()` hard-codes `v: 1`, and a read rejects a row whose `v` isn't the registered one, or whose payload lacks a required field | `spec/src/v1/events/envelope.ts:44-46`; `spec/src/v1/events/registry.ts:44-55`; `engine/src/log/read.ts:40-54` |
| There is one log migration | `engine/src/log/migrations/index.ts:10-12` |
| ARCH 3.5: before 1.0 a breaking event change "just bumps `v`; a development database is recreated" | `REWRITE_ARCHITECTURE.md:379` |
| The 1.0 ticket schema accepts any string as `risk`; REQ's FMT-T6 (keep) says `risk` is required and one of `Low`, `Medium`, `High`, as today's schema enforces | `spec/src/v1/tickets.ts:29`; `REWRITE_REQUIREMENTS.md:533`; `ai-foreman/src/tickets/ticketSchema.ts:72` |
| Today's depth minimum is Standard (level 2) unless the plan gives explicit low-risk evidence (then Focused); risk categories raise it to 3, 4 or 5 | `ai-foreman/src/qaPreparationPolicy.ts:49-54`; `spec/src/qaPreparation.ts:104-108` |
| SCN's fixture table already lists S-CHK-3 under F-TESTS-LOCAL ("Tests without delivery (S-CHK-1–4, 9, 10)"), while S-CHK-3's own setup says F-TESTS | `REWRITE_SCENARIOS.md:67`, `:1043` |
| F-CHAIN has no test runner (`projectFiles(CHAIN)` with no config); F-TESTS-LOCAL sets `checks.test_runner: fake-test` | `scenarios/fixtures/f-chain.ts:9-11`; `fixtures/f-tests.ts:14-16` |
| The scripted checks runner's log has no `cwd` | `scenarios/fakes/checks.ts:39-45` |

## 1. Step 0: the scheduler, before any M3 code

M3 adds about eight test jobs. The sort in 0.1 cut the suite by about 10 s, so it lands first, test-first (slice 0), and its before and after times go into section 10. No probe or live turn is needed before M3's code. One free check is optional (section 9, item 3).

## 2. Files to add or change, with budgets

Lines as `wc -l` counts them; files under 500, functions under 100, lines under 120 (ARCH 2.4).

### 2.1 `packages/spec/src/v1`

| File | Change | Budget |
|---|---|---|
| `tickets.ts` | `qa_preparation: { depth: focused \| standard \| extensive \| critical \| exceptional }`, optional, strict (C113, P23). `risk` becomes the enum `Low \| Medium \| High`, required, if you answer P23(b) yes (FMT-T6). `qa_isolation: full`, optional, only if you pick P25 option B | +12 (+4 with P25 B) |
| `events/envelope.ts` | `def()` takes an optional version (default 1), so one type can move to `v: 2` (C129) | +3 |
| `events/results.ts` | `requirements.written` becomes `v: 2` and gains `req_fps` (one digest per rendered requirement line, C114, C129, P24); `depth` becomes the five-name enum | +4 |
| `test/v1/v1.test.ts` | Accept and reject cases for each field; a `requirements.written` at `v: 1`, or at `v: 2` without `req_fps`, is rejected with "unknown version" or the field named; with P23(b) yes, `risk: high`, `risk: Critical` and a missing `risk` are rejected naming the ticket and field | +40 |

### 2.2 `packages/engine/src`

| Module (budget, today) | Files | Holds | Budget |
|---|---|---|---|
| `ask/` (1300, 0) | `questions.ts` | Open a question (short number per project, never reused); `answer()` with first-answer-wins through an idempotency key (C101); open questions oldest first | 150 |
| | `keys.ts` | What-next and waiver keys (ARCH 7.6); the covered-files digest (C106) | 90 |
| | `blocked.ts` | The what-next question: text for QA, checks and circling; its five options (C102); applying a choice; the stale-waiver check (C107) | 200 |
| `state/` (1300, 889) | `answers.ts` | Pure `whatNextEffects(question, choice, view)`: the what-next rows of M6's `answerEffects` (C103) | 90 |
| | `ticket.ts` (changes) | A retry from `blocked(what-next)` counts the attempt and uses the grant (C104) | +15 |
| `turns/` (900, 379) | `circling.ts` | Failure signatures, "no progress", circling for attempts and for turn retries (ARCH 5.5; C111, C112) | 120 |
| | `runner.ts` (changes) | Turn-level circling; returns the turn's tool runs | +40 |
| `facts/` (450, 113) | `fingerprint.ts` | Light (snapshot tree) and full (content of every non-ignored file) fingerprints, symlinks never followed (C118) | 120 |
| | `receipt.ts` | Fingerprint observed, status and "read" for one review turn (C115) | 70 |
| `build/` (2000, 1155) | `isolation.ts` | The isolation rule, drift, the copy as a git worktree and its cleanup, `qa.isolation` (C118, C119) | 170 |
| | `depth.ts` | The depth minimum by risk and the raise (C113) | 50 |
| | `steps/review.ts` (grows) | Receipt, warning and unable override, delta message, isolation, circling, unverified, terminal lines (C108, C110, C115) | 41 → 190 |
| | `steps/work.ts`, `steps/prepare.ts`, `steps/check.ts`, `steps/deliver.ts`, `loop.ts` (grow) | `files_read`; the fix message after QA; depth, `req_fps`, every section; related tests with QA on and the trusted-checks rule (C116); waiver validation; questions at the safe point and asking on `wait` | about +200 |
| | `steps/common.ts` (grows) | `trustedChecks(reqs, written)`: the requirement checks whose rendered line still matches its `req_fps` digest; the only source of requirement checks for the check step and for every `run_check` allowlist (C116) | +25 |
| | `context.ts` (grows) | `BuildUI.question`. **Session roots (C128):** `AgentStep.root` (default `ctx.project`); `session()` keys by `ticket\|role\|reply\|root` and passes the root to `openSession` (`project`), `rulesFor`, `checkEnvFor` (`project`, so the test's `cwd`, sandbox worktree, cache and restore are the copy's), `decidePermission` and `standingInstructions`; `closeSession(ctx, key)` closes one session | +45 |
| | `session.ts` | No change expected: it already roots the agent at `spec.project` (`build/session.ts:19,55,61`). The implementer reports it if the copy needs more | 0 |
| `instructions/` (1000, 151) | `messages/review.ts`, `messages/fix.ts` (split out of `messages.ts`, as ARCH 2.2 names `messages/*.ts`) | The full and delta review messages; the fix message after a failed check or a QA rejection (C108, C109) | 110, 130 |
| `api/` (600, 372) | `views.ts`, `start.ts` (grow) | `depth` and `validation.waiver` in `tickets show`; the stale-waiver check after `build.started`; the question UI passed through | +45 |
| `stats/` (700, 67) | `show.ts` (grows) | Receipts per review turn (NEW-REQ-6) | +30 |
| `progress/` (400, 44) | `write.ts` (grows) | Saved what-next answers by key (C121) | +15 |

Totals after M3, estimated: build about 1,640/2,000 (fingerprints and receipts go in `facts/` to keep `build/` clear for M4–M5); ask 440/1300; state 995/1300; turns 540/900; facts 300/450; instructions 390/1000. The implementer reports any module over budget rather than squeezing.

### 2.3 `packages/rafi/src/next`

| File | Change | Budget |
|---|---|---|
| `commands/start.ts` | `ui.question` in a terminal only: the numbered options, the required note, PRM-82's confirmation; a not-built option says so and asks again | +50 |
| `ui/prompts.ts` | `askText(deps, prompt, { required })`: one typed line, re-asks on empty when required | +25 |

### 2.4 `packages/scenarios`

| File | Change | Budget |
|---|---|---|
| `fakes/script/behaviors.ts` | `B.requirements(list)`, `B.reject({n: note})`, `B.pass()`, `B.unable(n, needs)`, `B.sameReject()`, `B.malformedOf(reply, at)`, `B.read(path)`, `B.outside(edit \| remove)` (C123) | +70 |
| `fakes/script/engine.ts`, `fakes/claude-cli.mjs`, `fakes/codex/protocol.mjs` | The `outside` step (written straight to disk, no tool event: the user, not the agent); Codex `read` as a `cat <path>` command; the transcript records `cwd` | +15, +20, +25 |
| `fixtures/common.ts`, `fixtures/f-chain.ts`, `fixtures/f-tests.ts` | Per-ticket overrides (risk, acceptance list, `qa_preparation`); F-TESTS-LOCAL with extra test files and `related` maps | +25 total |
| `fakes/checks.ts` | `CheckLogEntry` gains `cwd`, so a test can see where a run ran (C128) | +3 |
| `harness/scenario.ts` | `copyProject(dir)`: a byte copy of a checkout on the same computer (C127) | +15 |
| `harness/fast.mjs`, `harness/fast-order.mjs` (new) | Longest first, from the last run's times (C124) | +15, 40 |
| `checks/transcript.ts` | Helpers: messages by role and step, consecutive builder requests | +25 |
| `scenarios/qa.scenario.ts` | S-QA-1, S-QA-3 | ≤ 300 |
| `scenarios/qa-next.scenario.ts` | S-QA-2 steps 1–4 (5 pending M8, 6 pending M4) | ≤ 350 |
| `scenarios/requirements.scenario.ts` | S-QA-5 | ≤ 300 |
| `scenarios/isolation.scenario.ts` | S-QA-7 | ≤ 220 |
| `scenarios/checks-m3.scenario.ts` | S-CHK-2; S-CHK-3 step 1 | ≤ 220 |
| `scenarios/malformed-qa.scenario.ts` | S-MAL-3's three QA runs (Planner and Ticket Maker pending M9) | ≤ 150 |
| `scenarios/malformed.scenario.ts` | S-MAL-2 variant 3 replaces its `pending("M3")` | +40 |
| `test/harness-m3.test.ts`, `test/qa-m3.test.ts`, `test/security-m3-qa.test.ts`, `test/security-m3-copy.test.ts`, `test/fast-order.test.ts` | Section 3.2 and section 4 | ≤ 300 each |

## 3. Scenarios and tests to write first

Each is written and run **before** its code, and seen failing on its own assertion (section 5's rule). "Mutation" lists what to break if the test passes on its first run.

### 3.1 Scenarios (fast suite, mode `next`)

1. **S-QA-1** (`scenarios/qa.scenario.ts`, F-ONE; slice 3; red `3-S-QA-1.log`). Script: prepare gives R1 and R2 (`B.requirements`); `qa T1#1: reject(R2: "empty state missing")`; `builder T1#2: edit(src/T1.txt)`; `qa T1#2: pass`. Asserts: exit 0, `T1` done, no `question.opened`; one terminal line with "QA rejected the work" and "R2: empty state missing"; builder turn 2's message carries R2 and QA's note inside the quoted block; QA turn 2's message has the files changed since review 1 (only `src/T1.txt`), the R2 finding, only the runs recorded after review 1, and the requirements path, with no rendered requirement line; every result in `verdict.recorded` has one of the four statuses. First expected failure: builder turn 2 lacks R2.
2. **S-QA-2 steps 1–4** (`scenarios/qa-next.scenario.ts`, F-ONE; slices 4 and 6; red `4-S-QA-2.log`, `6-S-QA-2-step3.log`). Script: prepare gives R1–R4; QA rejects attempts 1–4 on R1, R2, R3 and R4 in turn, and each fix writes new content (progress, not circling).
   - Step 1, in a terminal, input `2`, an empty line, then "Checked the empty state on a phone": "What next?" appears after exactly 3 `builder@fix` turns, with the five options.
   - Step 2: the empty note is refused with one line, then the note is recorded in `question.answered`; `waiver.recorded` has `kind: verified-myself` and `findings: ["R4"]` (only the ones still open); `T1` is done; `tickets show T1 --json` has `validation.result: user-verified` and the note.
   - Step 3 (slice 6): first copy the checkout with `copyProject` (C127). Edit `src/T1.txt`, commit, run `start . --ticket T1 --steps 1` with no terminal. Expected: `ticket.reopened`, then a QA review that rejects R4 again; a new what-next `question.opened` (new number, new key) and no new waiver. On the copy, edit only `README.md`, commit and run the same command: exit 0, no agent turn, `T1` still done.
   - Step 4, a fresh fixture, input `3` then `2`: PRM-82's confirmation; `waiver.recorded` has `kind: waive-qa` and `findings: ["R4"]`; `validation.result` is `failed`.
   - Steps 5 and 6 are `pending("M8")` and `pending("M4")`.
   - First expected failure: no "What next?" (today the build ends with "the build is waiting").
3. **S-QA-3** (`scenarios/qa.scenario.ts`, F-ONE; slice 5; red `5-S-QA-3.log`). Script A: `qa T1#1..#4: same-reject(R2)`, and the builder's fixes write the same content. Run in a terminal with no input. Asserts: 2 `builder@fix` turns (fewer than 3); the attempt-3 verdict has `circling: true`; the what-next text says the same failure repeated with no progress. Script B: the same rejections, but each fix reads a file it hadn't read before (`B.read` of README.md, package.json, rafi-config.yaml). Asserts: 3 fixes, and the question says "after 3 fixes". In both runs no two consecutive builder requests are identical. First expected failure: script A runs 3 fixes.
4. **S-MAL-2 variant 3** (`scenarios/malformed.scenario.ts`, F-ONE; slice 5; red `5-S-MAL-2.log`). Every builder `T1` turn is `malformed(trailing@200)`, then `repair-changed(summary)`. Asserts: 3 build turns (not 4), 2 `turn.retry`, `step.failed.circling: true`, `T1` blocked with one line containing "malformed reply" (never "delivery uncertain") and a command to continue; exit 1. First expected failure: 4 turns.
5. **S-QA-5** (`scenarios/requirements.scenario.ts`, F-CHAIN with `T1` risk High and `qa_preparation.depth: focused`; slice 7; red `7-S-QA-5.log`). Every step also asserts exit 0 (no mismatch stops the build).
   - Step 1, `--steps 2`: for `T1` and `T2`, a new QA prepare session writes the file before the ticket's first builder turn. The file has requirement IDs, an "Acceptance criteria" section, in-scope and out-of-scope sections, a check with its expected result, and a risks section (every section always rendered, C126). `T1`'s depth is the High minimum from C113's map (`extensive` under P23 (i) and (ii), `critical` under (iii)) in the header and in `tickets show T1 --json`; the export has exactly one raise, `depth_raised_from: focused`. Every prepare, build, fix and review message has the path; review messages also have the fingerprint; no message contains a rendered requirement line. `stats show --run <id>` lists one receipt per review turn with path, fingerprint supplied and observed, `delivered`, time, turn and `read: yes` (the fake QA reads the file).
   - Step 2: an `outside` edit of R1's line during builder `T1`'s turn. Asserts: exactly one warning line naming the file and saying it changed; the review message has the path and the warning; R1 is `unable` and the others get normal verdicts; the receipt is `changed`; `T2` starts with no question.
   - Step 3: an `outside` delete of `docs/requirements/T2.md` during builder `T2`'s turn. Asserts: `missing`, and every `T2` requirement `unable`.
   - Step 4: the builder's summary misspells the path. Asserts: no warning, no `unable`, `delivered`.
   - The F-BRANCH commit clause is `pending("M5")` (P21).
   - First expected failure: depth `standard`.
   - Mutation (step 4 will pass first): make the review use a path taken from the builder's reply.
6. **S-QA-7** (`scenarios/isolation.scenario.ts`, F-CHAIN with `T1` Low and `T2` High; slice 8; red `8-S-QA-7.log`).
   - Step 1, `--steps 2`: `T1`'s `qa.isolation` is `in-place`, with a `why` that names the light fingerprint and why there's no copy. `T2`'s is `in-place` with a full fingerprint: files > 0, bytes > 0, and `ms.copy`, `ms.hash`, `ms.verify` and `ms.cleanup` as numbers.
   - Step 2: an `outside` edit of `src/T1.txt` during QA's review of `T1`. Asserts: one drift line naming the file; a `qa.isolation` with `mode: copy` and `why: source drift…`; a second, full (not delta) QA review turn whose `turn.intent.session` is `new` and whose transcript `cwd` is under `.rafi/cache/qa-copy/`; no later turn goes to the in-place review session (its close is tested directly in item 20, since the transcript doesn't record closes today); exactly one `verdict.recorded` for `T1`; afterwards `git worktree list` has one entry and no copy folder is left; `src/T1.txt` holds your edit; the requirements file matches its recorded fingerprint; every other file in the builder's snapshot is unchanged; HEAD and the refs are unchanged.
   - The copy-rooted `run_check` is asserted in `security-m3-copy.test.ts` (section 4), not here: F-CHAIN has no test runner (0.1), so QA has no check it could run, and giving F-CHAIN one would change the fixture SCN declares.
   - First expected failure: no `qa.isolation`.
7. **S-CHK-2** (`scenarios/checks-m3.scenario.ts`, F-TESTS-LOCAL with `T1` checks `fake-test r1.test` and `fake-test r2.test`, with `r1.test` related to `src/r1.js` and `r2.test` related to `src/r2.js`; slice 9; red `9-S-CHK-2.log`). Script: `builder T1#1: run_check(R1), run_check(R2), edit(src/r2.js)`, done. Variant A: only `r2.test` reruns (`asked_by: rafi`); R1's run is in `checks.passed.reused`; the review message lists both runs. Variant B: the rerun fails; the next turn is `builder@fix` with no review before it; `tickets show` has `fixes: 1`.
   - This is M2's code, so it may pass first. Mutations: `fresh()` always false (R1 reruns); `fresh()` always true (B goes to review); `checks.failed` going to review instead of fix.
8. **S-CHK-3 step 1** (`scenarios/checks-m3.scenario.ts`, F-TESTS-LOCAL as P22 proposes and SCN's fixture table already lists (`REWRITE_SCENARIOS.md:67`), with ten test files, `a1.test` and `a2.test` related to `src/a.js`; slice 9; red `9-S-CHK-3.log`). Script: `builder T1#1` edits `src/a.js`; `qa T1#1: run_check("fake-test e2e/a.spec")`. Asserts: the runs are `t1.test`, `a1.test`, `a2.test` and QA's `e2e/a.spec` (`asked_by: qa`); the other seven test files never run. The setup-script line is `pending("M7")` (P22); step 2 is `pending("M8")`. First expected failure: the related tests don't run with QA on (C117).
9. **S-MAL-3, QA's parts** (`scenarios/malformed-qa.scenario.ts`, F-ONE; slice 10; red or mutation `10-S-MAL-3.log`). Three runs: a malformed prepare reply (`B.malformedOf(requirements)`), a malformed verdict, and a malformed fix after a rejection, each then `repair-ok`. Asserts: exactly one repair request with S-MAL-1's wording, accepted, exit 0. The Planner and Ticket Maker runs are `pending("M9")`. Mutations: a non-builder `format` reply treated as `content`; the repair accepted with a changed value.

### 3.2 Engine and harness tests (each before its module)

10. `engine/test/turns/circling.test.ts` (slice 2): signatures per ARCH 5.5 (QA: sorted not-satisfied numbers with their cited runs' outcomes; checks: requirement numbers and test names; blocks; format and content: class and field). "No progress" needs all three conditions. Circling needs `circling_repeats` in a row. A new tree or a new read resets it. The turn-level rule (C112).
11. `engine/test/state/answers.test.ts` (slice 2): every what-next option's events (C103), with the note and confirmation rules.
12. `engine/test/state/ticketTable.ts` and `transitions.test.ts` (slice 2): new rows for C104 (a retry from `blocked(what-next)`: attempt + 1, the grant used) and a check that `blocked(other)` → `fix` doesn't count. Every pair is still tested.
13. `engine/test/build/depth.test.ts` (slice 2): the minimum per risk and the raise (C113), table-driven from the one minimums map, so P23's answer changes only that map and this table; an absent depth is `standard`. With P23(b) no, also: an unknown or absent `risk` gets the High minimum (C113).
14. `engine/test/instructions/messages.test.ts` (slice 3): the delta review message (C108); the fix message after QA with notes quoted, the path and "Fix n of N" (C109); a QA note that closes the fence stays inside a longer one.
15. `engine/test/ask/questions.test.ts`, `keys.test.ts` (slice 4, real git in a temp repo): short numbers; first answer wins (a second `answer()` returns who answered and when, and writes nothing); keys; a covered file's edit changes the waiver digest; a README edit doesn't.
16. `engine/test/build/isolation.test.ts` (slice 8, real git): fingerprints, symlinks hashed by link text, the copy at the snapshot's content, cleanup confined to the copy path, no ref or index change.
17. `scenarios/test/harness-m3.test.ts` (slice 1): each new fake behavior on both in-process fakes; `outside` changes the file with no tool event; Codex `read` produces a `cat` command; fixture overrides; `copyProject`.
18. `scenarios/test/qa-m3.test.ts` (slice 4): "Retry another Builder fix" runs exactly one more fix, then asks again, including after an early circling question (C104); PRM-82's "No" returns to "What next?"; the Planner and Pause options say they aren't built yet and ask again (C102); a prompt with no input leaves the question open and exits 1 (C100); a review with no verdict says "QA broke" (C110).
19. `scenarios/test/fast-order.test.ts` (slice 0): `fast-order.mjs` puts the longest recorded job first, falls back to file size, and ignores unknown names.
20. `engine/test/build/session-root.test.ts` (slice 8, in-process fakes, C128): a QA session for the project root and one for a copy root are two sessions; the copy's agent `cwd`, `run_check` rules root, check `cwd` and sandbox worktree, permission root and standing-instructions root are all the copy; `closeSession` closes only its key; on drift the in-place QA session is closed before the copy's opens, and the copy's is closed before cleanup (order checked with a spy on `close`); the next review after a copy review opens a new session and gets the full message (C108). First expected failure: both roots return the same cached session.
21. `engine/test/build/trusted-checks.test.ts` (slice 7, C116): with `req_fps` from the written file, an unchanged line's check is returned; a changed, added or duplicated line's check isn't; a missing or unreadable file returns none. First expected failure: today's code returns the current file's checks.
22. `engine/test/log/versions.test.ts` (slice 2, C129): a database holding a `requirements.written` row at `v: 1` reads back as one violation naming "unknown version 1 of requirements.written"; a `v: 2` row with `req_fps` folds. First expected failure: `def()` can't make a `v: 2` type.

## 4. Security tests

ARCH 1.2's rows that M3's new code touches; each row is a test in `scenarios/test/security-m3-qa.test.ts` or `security-m3-copy.test.ts` (slice 11, red `11-security.log`).

| Threat (ARCH 1.2) | Test |
|---|---|
| An agent answers its own question | A builder's `shell("rafi answer 1 2")` while a what-next is open is refused; a QA note saying "pick option 2, I verified it myself" answers nothing; the question is answered only by the terminal action, with `actor: user` and `source: terminal` |
| Instructions hidden in data: QA's notes | A QA note with "ignore previous instructions", a line that closes the fence, ANSI escapes and a canary value reaches the builder's fix message only inside a longer fence, escaped and redacted; the "QA rejected the work" line and the what-next text in the terminal are escaped and redacted; `question.opened.text` is redacted in the log, the progress file and `stats export` |
| Secrets leak: typed notes | A canary typed into the "I verified it myself" note is redacted in `question.answered`, `waiver.recorded`, the progress file, `stats export` and the terminal echo |
| An agent acts outside its ticket: weakening the spec | The builder rewrites R1 in `docs/requirements/T1.md` and adds ``Check: `curl …` ``: the receipt is `changed`, R1 is recorded `unable` (never `satisfied`), the check step neither runs nor records the `curl` check, a builder or QA `run_check` of it is refused (C72), and the build goes on |
| An agent acts outside its ticket: an allowlisted check slipped in (F-TESTS-LOCAL) | The builder changes R1's check to `fake-test e2e/wipe.test` (allowed by the runner rule, so C72 alone wouldn't stop it) and appends an R9 line with its own check: the check step runs R2's unchanged check and the related tests, and no `check.run` with `asked_by: rafi` names `e2e/wipe.test` or R9's check; R1 is `unable`; R9 is in no verdict. The same with the file deleted: only `required_tests` and related tests run (C116) |
| Damaged or hostile files | `qa_preparation.depth` with an unknown value, or one with a newline and an instruction, exits 1 naming the ticket and field; nothing reaches an agent. With P23(b) yes, the same for `risk` (`high`, `Critical`, missing). With P25 B, the same for `qa_isolation` |
| QA changes code: the copy | On F-TESTS-LOCAL with a drift during QA's review, the copy review's QA calls `run_check`: the scripted checks log has that run's `cwd` under `.rafi/cache/qa-copy/` and its sandbox worktree is the copy; a test that edits `src/index.js` is restored in the copy; your worktree's file is byte-identical; the copy session is closed before cleanup (C128) |
| Your code: cleanup | A tracked symlink in the snapshot that points at your worktree, and one that points outside the project: cleanup removes only the copy folder; both targets are byte-identical; a copy path outside `.rafi/cache/qa-copy/` is refused before any removal |
| Your code: git state | After a copy review: HEAD, every ref, the real index and `git status` are unchanged, and `git worktree list` is back to one entry |
| Your machine: fingerprints | The full fingerprint never reads through a symlink (it hashes the link text), counts only non-ignored files, and stays bounded on F-HUGE's ignored folder |
| Requirement content stays out of records | `requirements.written` and `requirements.receipt` hold digests only: no requirement text in any event, blob or `stats show` line |

**Threat-model review** (as M2's 10.7):

- **Before slice 4 and before slice 8,** the implementer writes a short threat note for the questions and waivers, and for the copy and fingerprints, into section 10.
- **After slice 11,** a review of the code as built against ARCH 1.2's rows. Each row gets the code path and the test that covers it.
- **New holes** are fixed test-first, with logs `.rafi-build/M3-red/threat-<n>.log`.
- **Defenses that have no test** get one, plus a mutation that removes the defense and makes the test fail (`threat-<n>-mutation.log`).

## 5. Order of work

**The red-run rule** (as M2's, made stricter). For each slice:

1. Write its tests and scenarios.
2. Run them and save the run to `.rafi-build/M3-red/<slice>-<name>.log`.
3. Check that each new test fails **on the assertion the slice is about**. "Isn't in the new engine yet" doesn't count; `start` exists, so scenarios can reach their assertions.
4. Only then write the slice's production code.
5. Run green, then keep the fast suite and `check-rules` green.

A scenario or step that passes on its first run is never counted as test-first. For each of its expectation bullets, run at least one mutation that removes the behavior (section 3.1 lists them) and save it as `.rafi-build/M3-red/mutation-<scenario>.log`. A mutation that doesn't fail the step means the test is vacuous: harden the test and show the mutation failing. Large output goes under `/private/tmp` and is searched, not printed.

| # | Slice | Tests first | Then build |
|---|---|---|---|
| 0 | Scheduler | Item 19 | `fast-order.mjs`, `fast.mjs`; record 3 runs before and after |
| 1 | Harness and fakes | Item 17 | Section 2.4's fake, fixture and transcript changes |
| 2 | Pure rules | Items 10–13 and 22; spec tests | `turns/circling.ts`, `state/answers.ts`, `state/ticket.ts`, `build/depth.ts`, spec changes, `def()`'s version |
| 3 | Reject, fix, re-review | S-QA-1; item 14 | `messages/review.ts`, `messages/fix.ts`, the review step's findings and delta, the work step's fix message, terminal lines |
| 4 | What next? | Threat note; S-QA-2 steps 1, 2 and 4; items 15 and 18 | `ask/*`, questions at the safe point (C99), asking on `wait` (C100), the CLI prompts, waivers, deliver's validation, views, progress answers |
| 5 | Circling | S-QA-3, S-MAL-2 variant 3 | `files_read`, verdict and check circling, turn-level circling, the fix attempt note |
| 6 | Stale waiver | S-QA-2 step 3 | C107 |
| 7 | Requirements-file rules | S-QA-5; item 21 | Depth wiring, `req_fps`, sections, receipts, warnings, the unable override, `trustedChecks` and the missing-file fallback (C116), `stats show`, `tickets show` |
| 8 | QA isolation | Threat note; S-QA-7; items 16 and 20 | `facts/fingerprint.ts`, `build/isolation.ts`, session roots and `closeSession` (C128), the review on a copy |
| 9 | Checks | S-CHK-2, S-CHK-3 step 1 | C117 |
| 10 | Malformed QA replies | S-MAL-3's QA parts | Whatever they find |
| 11 | Security | Section 4; then the threat-model review | Fixes they find |
| 12 | Gate | — | Section 6's three runs; `check-rules`; the process set (19/19); `tsc` in 4 packages; every M1 and M2 scenario; section 10 written; report |

Changed M1 and M2 tests are listed in section 10 with the reason. The ones expected to change are:

- the transition table (C104);
- S-MAL-2's `pending("M3")` line;
- any M2 test that pinned the review or fix message text (C108, C109);
- any test that pinned rendered sections (C126);
- any test that pinned the checks log while QA was on (C117).

## 6. Keeping the fast suite under 60 seconds

- **Where it stands.** 39.6–47.3 s in file order. The work is about 156 s of job time on 4 workers, so the floor is about 39 s. The tail comes from long jobs starting late.
- **What M3 adds.** About 20 builds in scenarios (about 18 s alone, about 30 s under load), plus about 3 s of unit tests. The audit adds three unit tests (items 20–22, no build) and two one-ticket builds in `security-m3-qa.test.ts` (the allowlisted-check rows, about 1 s), and moves the copy-rooted `run_check` into `security-m3-copy.test.ts`'s existing copy build. Every new check is offline: no paid model turn.
- **How it stays under:**
  1. **Longest first (C124).** This measured 32.6 s and 32.0 s today, against 39.6–47.3 s, with the same jobs. With M3 added, that projects to about 40 s.
  2. **Six new files, none over 8 s alone.** Measure each with `node packages/scenarios/harness/fast.mjs <file>`. A file over 8 s is split before the slice ends. The long M2 files don't grow: `checks.scenario.ts` and `malformed.scenario.ts` gain only S-MAL-2 variant 3.
  3. **One build per scenario where the steps allow.** S-QA-2 steps 1→2→3 continue on one checkout, and step 3's README branch uses `copyProject` (a byte copy) instead of rebuilding to step 2. S-QA-7's step 1 covers both tickets in one build.
  4. **Logic goes in unit tests,** not extra builds: circling, effects, keys, depth, messages and fingerprints.
- **Checkpoints.** The suite is measured at the end of slices 4, 8 and 12, three runs each, and the slowest is reported.
- **If it goes over 50 s at a checkpoint,** cut git spawns before going on. Each snapshot spawns 5 git processes, a build has about 29 child calls, and M3 adds snapshots around each review. Two cuts:
  - cache `rev-parse --git-path index` per build;
  - reuse the check step's snapshot as the review's "before" fingerprint when nothing ran in between.
- **If it's still over 55 s,** stop and report before adding more.

## 7. Implementation choices the docs leave open

Numbered after M2's C1–C98.

| # | Choice | Why |
|---|---|---|
| C99 | A what-next question is opened at the safe point after the outcome that blocked the ticket (boundary 4 → the question → boundary 9), not in the outcome's own transaction. Its key can then name the `verdict.recorded` or `checks.failed` event id. A blocked(what-next) ticket with no open question gets one at the next safe point, so a crash in between (M4) is redone | ARCH 7.6's key needs the verdict event's id; 4.6's boundary 9 |
| C100 | Asked in the terminal when the loop would otherwise wait (`decide` returns `wait`): write `build.waiting`, ask the open questions oldest first, apply each answer, write `build.unwaiting`, go on. Other tickets build first, so a blocked ticket never stops them. Without a terminal, or with no input at the prompt, M2's path is kept: the question stays open, the lease is released with `waiting`, and the build exits 1. M6 adds pinned prompts while building, and exit 2 | ARCH 14 M3 "minimal question record in the same terminal"; 7.7 (NEW-BLK-4); `build/loop.ts:59-61` |
| C101 | First answer wins through the idempotency key `answer\|<question id>` on the answer's one append. A second answer replays the first's events and returns who answered and when; it works across processes too, because the key check is inside the same `BEGIN IMMEDIATE` transaction | ARCH 7.6, 3.3 (idempotent actions); `log/append.ts:74-78` |
| C102 | The five options of ARCH 7.7 are shown. "Discuss with read-only Planner" (M8) and "Pause at this checkpoint" (M4) print "isn't in the new engine yet (milestone Mn)" and ask again. Option ids: `retry`, `verified`, `waive`, `planner`, `pause`; `recommended: retry`; `urgency: high`; `save: project` | ARCH 7.7; M1's not-built pattern |
| C103 | `whatNextEffects`: **Retry** → `fix.granted {by: user, reason}` + `ticket.unblocked {resume_step: fix}`. **I verified it myself** (a note that isn't empty after trimming) → `waiver.recorded {kind: verified-myself, note, findings, fp}` + `ticket.unblocked {resume_step: deliver}`. **Explicitly waive QA** → PRM-82's question ("Record validation_result=failed and retain unresolved issues?" No / Waive and continue). "Waive and continue" → `waiver.recorded {kind: waive-qa, note: "", …}` + `ticket.unblocked {resume_step: deliver}`; "No" asks "What next?" again. `findings` are the last verdict's not-satisfied requirements (`R4`), or the failing checks' requirements | ARCH 4.2 rows, 5.6, 7.7; REQ PRM-81, PRM-82 |
| C104 | A retry from `blocked(what-next)` into the fix node is the next attempt, and it uses the grant: attempt + 1, and `fixesUsed` = `fixes` + `fixesGranted`. So exactly one more fix runs before rafi asks again, even when circling raised the question early | ARCH 5.6 (`:800`), S-QA-2 step 6 (`REWRITE_SCENARIOS.md:230`); P26 |
| C105 | Deliver's validation: a waiver after the last verdict sets `result: user-verified` (verified-myself) or `failed` (waive-qa). `tickets show --json` adds `validation.waiver: {kind, note, findings}`, read from `waiver.recorded`; the `delivery.done` schema is unchanged | S-QA-2 steps 2 and 4; ARCH 3.4 `:340` |
| C106 | "The files its findings cite" (what-next key) and "the files they cover" (waiver key): verdicts cite requirements and runs, never files. So these are the ticket's changed files in its latest builder snapshot. The digest is sha256 of `git ls-tree <current snapshot tree> -- <files>` (blob ids), so a README-only edit leaves it as it was | ARCH 7.6 (`:1069-1070`); S-QA-2 step 3 |
| C107 | The stale-waiver check runs right after `build.started`, for done tickets put back in scope by name: `--ticket` now, `--to-ticket` from M5. A stale waiver → `ticket.reopened {why}` and one line naming the changed file; a fresh one → nothing, and the ticket stays done with no turn | ARCH 4.2 `:504` ("when the ticket is put back in scope"); S-QA-2 step 3 |
| C108 | The re-review (NEW-REQ-7) reuses QA's review session (C35). Its message carries: the files changed since the previous review's builder snapshot; the runs recorded since then; the previous verdict's not-satisfied requirements with QA's notes, quoted; and the requirements path and fingerprint. A new session (after resume, or a copy review) gets the full message. After a drift, the in-place review session is closed before the copy review, and the copy's session is closed before cleanup, so the next review is a new session with the full message (C128) | ARCH 10.2 Review row; S-QA-1; S-QA-7 |
| C109 | The fix message after a QA rejection carries QA's not-satisfied requirements with their notes (quoted, escaped, redacted) and cited runs, the requirements path, "Fix n of N" (NEW-RTY-1), and "Keep the work you've done; don't start over". After a failed check: today's message plus the path and "Fix n of N" | ARCH 10.2 Fix row, 5.4; S-QA-3; S-QA-5 ("every builder instruction") |
| C110 | Terminal lines (NEW-QAM-7). One line per rejection: "T1: QA rejected the work: R2: <note>", with "and n more" when there are several. A review step that ends without a verdict says "T1: QA broke (no verdict): <reason>" | REQ NEW-QAM-7; S-QA-1 |
| C111 | `files_read` comes from the builder turn's tool events, collected in memory, so it works at every capture level: Claude's `Read`, `Grep`, `Glob` and `LS` paths, and Codex command arguments that name an existing worktree file. It's worktree-relative and sorted, in `attempt.summary` | ARCH 5.5; `agents/claude/events.ts:77-79` |
| C112 | Turn-level circling (S-MAL-2 variant 3). Inside one `runTurn`, a failed attempt counts as no progress when its signature equals the previous one and its tools changed or read nothing new. The signature is the category plus the first error's field, or "repair rejected: <field>". `circling_repeats` of those in a row stops the retries. The reason is "malformed reply N times (the same change repeated)" when the failures came from format errors, and `step.failed.circling` is true | ARCH 5.5 (`:773`); 4.2 `:492` |
| C113 | Depth names are today's five levels: `focused`, `standard`, `extensive`, `critical`, `exceptional`. The field is `qa_preparation: { depth }`; absent means `standard`. The minimums by ticket risk live in one frozen map in `build/depth.ts`; until you answer P23(a) it holds option (i): Low `standard`, Medium `standard`, High `extensive`. A raise is recorded once, in `requirements.written` (`depth`, `depth_raised_from`), and shown in the prepare message, the file header and `tickets show` (`depth`). **P23(b):** yes → `risk` is the required enum and an invalid one exits 1 before any turn; no → `risk` stays a string, and anything other than exactly `Low` or `Medium` (unknown, misspelt, absent) gets the High minimum, so a typo never lowers QA's depth | REQ Q-REQ-1, FMT-T6, FMT-T11, NEW-CAU-5; `spec/src/qaPreparation.ts:2,104-108`; P23 |
| C114 | `requirements.written.req_fps` holds one sha256 per rendered requirement line, in requirement order, so rafi knows which requirements changed without storing their text. The check is on the requirement's line (ARCH 6.3's rendering, `REWRITE_ARCHITECTURE.md:865`), so the digest covers it | S-QA-5 step 2; P24 |
| C115 | One `requirements.receipt` per review step's turn, written when the turn ends: `fp_supplied` from `requirements.written`; `fp_observed` and `status` (`delivered`, `changed`, `missing`, `unreadable`) at the turn's start; `read` when a tool event in the turn named the path. On `changed` or `missing`, rafi prints one warning line, tells QA which requirements are affected, and records them `unable` (`needs: file`) whatever QA said, so a diagnostic never gates a review | REQ NEW-REQ-5, NEW-REQ-6, NEW-CAU-3; ARCH 5.1 `:739`, 6.4 `:898` |
| C116 | **Trusted checks.** Requirement checks come only from `trustedChecks`: a check counts only when its rendered line's digest is the one `req_fps` recorded for that requirement, so the line is byte-for-byte what rafi validated when it wrote the file. This feeds the check step and every builder and QA `run_check` allowlist. A changed, added or removed line contributes no check (its requirement is `unable` anyway, C115). The check step then runs the trusted checks plus the ticket's `required_tests` and the related tests (C117), deduplicated. With the file missing or unreadable there are no trusted checks, so it runs `required_tests` and related tests, as with QA off | ARCH 6.9 "checked when rafi wrote the file" (`REWRITE_ARCHITECTURE.md:951-952`); REQ NEW-REQ-5 ("the build carries on"); `build/steps/common.ts:36-42`; audit |
| C117 | With QA on, the check step also runs the runner's related tests for the ticket's changed files, after the requirements' checks, deduplicated by test file | ARCH 6.9 "Only relevant tests" (`:962`), 6.10 "Per ticket" (`:971`); S-CHK-3 |
| C118 | Isolation (Q-COPY-1). **Light fingerprint:** rafi's snapshot tree before and after the review turn. **Full fingerprint** (High risk): sha256 of every non-ignored file's bytes (`git ls-files -co --exclude-standard -z`), with symlinks hashed by their link text and never followed, counting files and bytes, and checked again after the review. No copy at the start, because in 1.0 the builder never runs during a review. **Drift** (either fingerprint changed): one line, a `qa.isolation` with `mode: copy` and `why: source drift: <files>`, and the review is redone in a copy. The in-place verdict is discarded and never recorded | ARCH 4.7 `:673`; REQ Q-COPY-1, NEW-COPY-1/2 |
| C119 | **The copy** is a detached `git worktree` at `.rafi/cache/qa-copy/<ticket>-<attempt>`. It's made from a commit `git -c user.name=rafi -c user.email=rafi@invalid commit-tree <snapshot tree> -p HEAD` creates; no ref moves and the index isn't touched. Because it's a real worktree, QA's `git diff` sees the snapshot, not your folder. QA's session and its `run_check` run in it: the copy is their root, and the QA restore happens there. Cleanup is `git worktree remove --force <copy>` then `git worktree prune`, refused for any path outside `.rafi/cache/qa-copy/`. `ms.copy`, `ms.cleanup` are timed on `deps.clock` | NEW-COPY-2 ("cleanup never removes your work"); ARCH 2.4 (argument arrays, Windows-safe) |
| C120 | Full isolation "on request" depends on P25. **Option A** (drop it, recommended): nothing more is built; the full fingerprint is for High risk only. **Option B** (a ticket field): `qa_isolation: full` (optional; `full` is the only value), validated with the ticket file; `build/isolation.ts` uses the full fingerprint when risk is High or the field is `full`, and `qa.isolation.why` names which; `isolation.test.ts` covers a Low ticket with the field (no new scenario build). Until you answer, A | P25 |
| C121 | The progress file's `answers:` lists answered what-next questions by key, with `at`, `choice` and `source`; a note stays out of it | ARCH 3.7, 7.6 ("saved answers are committed") |
| C122 | Red-run logs in `.rafi-build/M3-red/<slice>-<name>.log`; mutation logs `mutation-<scenario>.log`; threat logs `threat-<n>.log` | Evidence for review without commits (C57) |
| C123 | The new fake behaviors (section 2.4). `outside` is the user acting, not the agent: the fake writes the file directly, mid-turn, with no tool event and no permission request. `sameReject` repeats the previous verdict's not-satisfied set | SCN 2.2 (`same-reject`); SCN S-QA-5 steps 2–3, S-QA-7 step 2 |
| C124 | `fast.mjs` runs jobs longest first, using the last run's times from an ignored file (`node_modules/.cache/rafi-fast/times.json`), and falls back to file size when there are none (CI). `--times` prints every job's time | Section 0.1's measurement |
| C125 | Person-only requirements may have no result in a verdict; every other requirement needs one | ARCH 6.4 (`:898`) |
| C126 | The requirements file always renders every section, with "- None listed." for an empty one. It adds an "Acceptance criteria" section (`- Acceptance 1: …`, a form no message uses, so it's distinct from what the build message carries) | REQ NEW-REQ-1; S-QA-5 step 1 |
| C127 | `copyProject(dir)` in the harness: a byte copy of a checkout, including `.rafi/state.sqlite3`, on the same "computer". It stands in for "separately, from the end of step 2" without a second build | S-QA-2 step 3; section 6 |
| C128 | **Session roots** (audit). An agent step has a `root`, `ctx.project` unless it's a copy review. The session cache key includes the root, and the root is the agent's `cwd`, `run_check`'s rules root, the check environment's `project` (test `cwd`, sandbox worktree, `.rafi/cache`, restore) and the permission and instructions root. On drift: close the in-place QA review session (`closeSession`), run the full review in a new session rooted at the copy, close that session, then clean up the copy. QA's runs in the copy write their cache inside the copy, which cleanup removes | `build/context.ts:75-115,206-212`; ARCH 4.7 `:673`; C119 |
| C129 | **`requirements.written` moves to `v: 2`** for `req_fps`, with no log migration. ARCH 3.5 says a breaking change before 1.0 "just bumps `v`; a development database is recreated" (`REWRITE_ARCHITECTURE.md:379`). A database with a `v: 1` row reads it as a violation that names the version (`spec/src/v1/events/registry.ts:47`); nobody but this rewrite has such a database. No fallback for pre-M3 rows is built | ARCH 3.5 `:376-379`; `envelope.ts:44-46`; audit |

## 8. Problems found in the locked docs

None blocks starting M3. Each needs your approval; until then the plan does what "Meanwhile" says. Section 8.1 gives each fix as an exact text change with `file:line`, checked against the docs in the audit session (part 2). Line numbers are as the docs stand now; once one proposal inserts a row, later line numbers in that file shift.

| # | Problem | Evidence | Fix (exact text in 8.1) | Meanwhile |
|---|---|---|---|---|
| P21 | S-QA-5 is an M3 must-pass, but one expectation needs M5's git delivery, and 14.1 says a scenario passes in full at exactly one milestone | `REWRITE_SCENARIOS.md:262` ("on F-BRANCH (rafi manages git) it's in the same commit as the ticket's work"); `REWRITE_ARCHITECTURE.md:1701` (M3 must-pass), `:1713` (M5 builds delivery units and completion modes), `:1673` (14.1) | S-QA-5 becomes an M3 partial ("all but the F-BRANCH commit") and an M5 must-pass. 14.2: M3 5 → 4 (running total 22 → 21), M4's running total 29 → 28, M5 14 → 15 (running total stays 43). M6–M10 and the total of 126 don't change | The F-BRANCH clause is `pending("M5")`; S-QA-5 stays registered at M3 |
| P22 | S-CHK-3 step 1 (an M3 partial) needs the setup script's run, which M7 builds, and its setup names F-TESTS, whose `direct-merge` delivery is M5's. SCN's own fixture table already says S-CHK-3 uses F-TESTS-LOCAL | `REWRITE_SCENARIOS.md:1043` (F-TESTS; the script's `builder T1#1: setup-script`), `:1049` ("the setup script's run is recorded like a test"), `:66` (F-TESTS: `direct-merge`), `:67` (F-TESTS-LOCAL: "Tests without delivery (S-CHK-1–4, 9, 10)"); `REWRITE_ARCHITECTURE.md:1702`, `:1725` (M7: the setup script "run first by every fresh agent, and recorded"), `:1713`; `REWRITE_M2_PLAN.md:395` | S-CHK-3's setup names F-TESTS-LOCAL (matching `:67`); ARCH's M3 partial says "step 1, without the setup script's run, which M7 builds". S-CHK-3 passes in full at M8, after M7, so nothing else changes | Step 1 runs on F-TESTS-LOCAL; the setup-script line is `pending("M7")` |
| P23 | **Your decision (questions at the end).** (a) The docs keep a planner depth "with enforced minimums" but never give the 1.0 field's shape, the names or the minimum per risk; SCN says "the configured minimum", but no setting exists. (b) The 1.0 schema accepts any `risk` string, so a minimum per risk can't be enforced safely, though FMT-T6 (keep) says `risk` is required and one of three values | `REWRITE_REQUIREMENTS.md:533` (FMT-T6), `:538` (FMT-T11), `:1105`, `:1185` (Q-REQ-1); `REWRITE_SCENARIOS.md:255,263`; `REWRITE_ARCHITECTURE.md:858`, `:1650` (no field); `spec/src/v1/tickets.ts:29`; `ai-foreman/src/tickets/ticketSchema.ts:72`; `ai-foreman/src/qaPreparationPolicy.ts:49-54` | (a) An ARCH 13 row with the field and the minimums you pick; 6.3 and SCN say "rafi's minimum". (b) Yes: no doc change. No: FMT-T6 changes | (a) option (i), C113. (b) the string stays; anything but exactly `Low` or `Medium` gets the High minimum (C113) |
| P24 | S-QA-5 step 2 needs rafi to know which requirements' text changed, but rafi stores only the file's path and one fingerprint. Who marks them "unable" also differs: REQ says QA, ARCH says rafi | `REWRITE_SCENARIOS.md:266`; `REWRITE_REQUIREMENTS.md:513` (FILE-60), `:807` (NEW-REQ-2), `:810` (NEW-REQ-5); `REWRITE_ARCHITECTURE.md:315`, `:424`, `:739` (5.1: rafi), `:898` (6.4) | `req_fps` in `requirements.written` and in every "stores only its path and fingerprint" (three places); rafi records the affected requirements "unable". The event's version needs no doc change: ARCH 3.5 already says a breaking change before 1.0 bumps `v` (`:379`; C129) | C114, C115, C129 |
| P25 | **Your decision (questions at the end).** "High-risk or explicitly requested reviews keep full isolation", but no setting or ticket field lets you request it | `REWRITE_REQUIREMENTS.md:850` (NEW-COPY-2), `:1191` (Q-COPY-1, "or on request"); `REWRITE_ARCHITECTURE.md:1649-1650` (key and field lists) | A: drop "or explicitly requested" / "or on request". B: add a `qa_isolation: full` ticket field to ARCH 13 | A (C120) |
| P26 | ARCH 4.2's row "`blocked` → `ticket.unblocked` → `queued`, keeps `resume_step`" doesn't say a "Retry another Builder fix" is the next attempt and uses the grant. Without that, the fix reruns with the old attempt number (today's code does: `engine/src/state/ticket.ts:102-109`), and after a circling question a grant would allow more than one fix | `REWRITE_ARCHITECTURE.md:503` (row), `:800` (5.6: "exactly one more fix … then ask again"); `REWRITE_SCENARIOS.md:230` (`T1#5`) | A more specific row before `:503` | C104; items 12 and 18 stay as its tests (attempt + 1; exactly one fix then ask again, also after a circling question) |
| P27 | The QA copy has no place in 3.8's table of files rafi writes | `REWRITE_ARCHITECTURE.md:431` (`.rafi/cache/` is "caches tests would otherwise write"), `:673` (4.7: "redone on a copy of the snapshot") | A row after `:431`: never committed, removed when the review ends | C119 |
| P28 | M3 has no "Security" line, though 14.1 says every milestone's done checks include security tests for what it adds | `REWRITE_ARCHITECTURE.md:1675` (14.1), `:1698-1702` (M3); M1's and M2's Security lines sit before Must pass (`:1685`, `:1693`) | A Security line after `:1700` | Section 4 |
| P29 | (From the audit.) ARCH 6.9 says requirement checks are validated when rafi writes the file, but not what happens when the file changes or disappears afterwards; today's code then runs whatever the current file says (0.1), so an agent can slip in a check the runner rule allows | `REWRITE_ARCHITECTURE.md:951-952`, `:959`, `:961`; `build/steps/common.ts:36-42`; `build/steps/check.ts:18-21` | 6.9 says checks come only from requirement lines unchanged since rafi wrote the file | C116 |

### 8.1 Exact text changes

**P21** (`REWRITE_ARCHITECTURE.md`). The ten must-pass lines (`:1686`–`:1743`) name 2, 15, 5, 7, 14, 18, 17, 11, 17 and 20 scenarios, 126 in all (counted in part 2).

- `:1701`, replace the line with:
  ```
  - **Must pass:** S-QA-1, S-QA-3, S-QA-7, S-CHK-2.
  ```
- `:1702`: the line under P22 (with P21 it adds `S-QA-5 (all but the F-BRANCH commit, which needs M5's delivery), `).
- `:1714`, replace `S-CHK-6, S-CRASH-2.` with `S-CHK-6, S-CRASH-2, S-QA-5.` (15 names).
- 14.2, replace three rows:
  ```
  :1752  | M3 | 5 | 22 |   →   | M3 | 4 | 21 |
  :1753  | M4 | 7 | 29 |   →   | M4 | 7 | 28 |
  :1754  | M5 | 14 | 43 |  →   | M5 | 15 | 43 |
  ```

**P22**

- `REWRITE_SCENARIOS.md:1043`, replace `- **Setup:** F-TESTS with ten test files.` with `- **Setup:** F-TESTS-LOCAL with ten test files.`
- `REWRITE_ARCHITECTURE.md:1702`, replace the line with (drop the S-QA-5 clause if P21 isn't approved):
  ```
  - **Partial:** S-QA-2 (steps 1–4), S-QA-5 (all but the F-BRANCH commit, which needs M5's delivery), S-MAL-2 (variant 3), S-MAL-3 (QA's requirements file, QA's verdict, the builder's fix), S-CHK-3 (step 1, without the setup script's run, which M7 builds).
  ```

**P23** (L, M and H are the minimums you pick in question 1a)

- (a) Insert after `REWRITE_ARCHITECTURE.md:1650`:
  ```
  | The ticket's QA preparation depth (FMT-T11, Q-REQ-1) | `qa_preparation: { depth: focused \| standard \| extensive \| critical \| exceptional }`, optional, default `standard`. Rafi's minimum by `risk`: Low L, Medium M, High H | 6.3 |
  ```
- (a) `REWRITE_ARCHITECTURE.md:858`, replace `raised to the enforced minimum for the ticket's risk` with `raised to rafi's minimum for the ticket's risk (13)`.
- (a) `REWRITE_SCENARIOS.md:263`, replace `equals the configured minimum for High risk` with `equals rafi's minimum for High risk (ARCH 13)`.
- (b) Yes: no doc change; `REWRITE_REQUIREMENTS.md:533` (FMT-T6) already says "Required `Low`, `Medium`, `High`".
- (b) No: `REWRITE_REQUIREMENTS.md:533`, replace ``Required `Low`, `Medium`, `High`.`` with ``Optional; `Low`, `Medium` or `High`, and any other value gets the High QA minimum.``

**P24**

- `REWRITE_REQUIREMENTS.md:807` (NEW-REQ-2), replace `Rafi stores only its path and fingerprint, and gives QA the path.` with `Rafi stores only its path, its fingerprint and one fingerprint per requirement (never the text), and gives QA the path.`
- `REWRITE_REQUIREMENTS.md:513` (FILE-60), replace `Rafi stores only its path and fingerprint (NEW-REQ-1).` with `Rafi stores only its path, its fingerprint and one fingerprint per requirement (NEW-REQ-1).`
- `REWRITE_REQUIREMENTS.md:810` (NEW-REQ-5), replace `QA marks the affected requirements "unable to verify"` with `rafi tells QA which requirements are affected and records them "unable to verify"`.
- `REWRITE_ARCHITECTURE.md:315`, replace ``` `depth_raised_from` (S-QA-5), `count` ``` with ``` `depth_raised_from` (S-QA-5), `req_fps` (one fingerprint per rendered requirement line, never the text; S-QA-5 step 2), `count` ```.
- `REWRITE_ARCHITECTURE.md:424`, replace `rafi stores only its path and fingerprint (NEW-REQ-2)` with `rafi stores only its path, its fingerprint and one fingerprint per requirement (NEW-REQ-2)`.
- `REWRITE_ARCHITECTURE.md:898`, replace `(including those caused by a missing or changed requirements file, NEW-REQ-5)` with `(including those rafi records itself, whatever QA said, for the requirements a missing or changed requirements file affects, NEW-REQ-5)`.

**P25** (one of the two)

- A, drop it for 1.0: `REWRITE_REQUIREMENTS.md:850`, replace `high-risk or explicitly requested reviews keep full isolation` with `high-risk reviews keep full isolation`; `REWRITE_REQUIREMENTS.md:1191`, replace `full fingerprint only for High risk or on request` with `full fingerprint only for High risk`.
- B, a ticket field: `REWRITE_ARCHITECTURE.md:1650`, replace ``` `manual_checks`. Acceptance ``` with ``` `manual_checks`, `qa_isolation` (`full`: QA's review uses the full fingerprint whatever the ticket's risk; Q-COPY-1). Acceptance ```. REQ unchanged.

**P26**: insert before `REWRITE_ARCHITECTURE.md:503`:
```
| `blocked(what-next)` | `ticket.unblocked` with "Retry another Builder fix" (after `fix.granted`) | `queued` | `resume_step` = fix; the next attempt (attempt + 1), and the grant is used, so exactly one more fix runs before rafi asks again (5.6, S-QA-2 step 6) |
```

**P27**: insert after `REWRITE_ARCHITECTURE.md:431`:
```
| `.rafi/cache/qa-copy/<ticket>-<attempt>/` | no, never committed | A git worktree of the builder's snapshot, for QA's review after source drift (4.7, Q-COPY-1); removed with `git worktree remove` as soon as that review ends; it never holds your work | QA reviews after drift |
```

**P28**: insert after `REWRITE_ARCHITECTURE.md:1700`:
```
- **Security:** QA's notes reach the builder only as quoted data; typed notes are redacted; only you answer "What next?"; a requirements file changed by an agent never makes a requirement pass and never adds a check rafi runs; the QA copy and its cleanup never touch your work or git state; fingerprints never follow symlinks.
```

**P29** (`REWRITE_ARCHITECTURE.md`)

- `:951`, replace `the requirements file's check commands, each checked when rafi wrote the file (next item);` with ``the requirements file's check commands, each checked when rafi wrote the file (next item) and taken only from requirement lines unchanged since (`req_fps`);``
- `:959`, append to the end of the bullet:
  ```
   A requirement line that changed, was added or was removed since rafi wrote the file gives no check (its requirement is "unable to verify", 5.1); with the file missing or unreadable, the step runs the ticket's `required_tests` and related tests, as with QA off.
  ```

## 9. Risks, and what can only be checked live

No paid model turn is planned. These stay **unverified** until an authorized live run, or CI:

1. **Receipts' `read` on real runtimes.** A real QA reading the file shows up as Claude's `Read` with `file_path`, or as a Codex shell command (`cat`, `sed`, `rg`) naming it. If a runtime reads another way, `read` says no. Rafi doesn't act on `read`; it's a diagnostic.
2. **`files_read` on a real Codex builder** comes only from command arguments (C111). A Codex builder that explores some other way could look like it read nothing new, and circling could ask early. That still needs the same failure and the same tree.
3. **Real QA sessions in a nested git worktree under `.rafi/cache/qa-copy/`:** Codex's read-only sandbox there, its project-root and `AGENTS.md` discovery, and Claude's settings and `CLAUDE.md` loading from a subfolder. A free check (no model turn) is possible for Codex's sandbox (`codex sandbox` read-only, writing in the copy and in the parent worktree). The rest needs a live turn.
4. **Linux and Windows** (CI after the user pushes): `git worktree` under `.rafi/cache`, `commit-tree` with `-c` identity, symlink hashing.
5. **The `build/` budget:** about 1,640 of 2,000 after M3, with M4 (resume, safe points) and M5 (deliver) still to come. Fingerprints and receipts go in `facts/` for that reason.
6. **M2 tests that pin text or call lists** may need updates from C108, C109, C117 and C126. Each change is listed in section 10 with the ARCH line that drives it.
7. **The fast suite:** section 6's projection (about 40 s) depends on the longest-first gain holding with M3's files added. It's measured at three checkpoints.
8. **Development databases from M2** hold `requirements.written` at `v: 1`, which M3's reader reports as a violation (C129). Per ARCH 3.5 (`REWRITE_ARCHITECTURE.md:379`) such a database is recreated, not migrated. Scenario fixtures are made fresh each run, so the suite isn't affected.

## 10. Implementation: results and choices made while building

Written by the implementing session (part 4), as it went. Logs are under `.rafi-build/M3-red/` unless a path says otherwise.

### 10.1 Locked-doc edits (user-approved P21–P29; P23(a) option i; P23(b) yes; P25 option B)

Applied with exact string replacement after re-checking each line; line numbers are after all edits.

- `REWRITE_ARCHITECTURE.md`: `:315` (`req_fps`, P24), `:424` (P24), `:432` new row (P27), `:504` new row (P26), `:860` (P23a), `:900` (P24), `:953` (P29), `:961` (P29), `:1652` (`qa_isolation`, P25 B), `:1653` new row (P23a, minimums Low `standard`, Medium `standard`, High `extensive`), `:1704` new Security line (P28), `:1705` Must pass (P21), `:1706` Partial (P21, P22), `:1718` M5 adds S-QA-5 (P21), `:1756–1758` 14.2 rows M3 4/21, M4 7/28, M5 15/43 (P21).
- `REWRITE_REQUIREMENTS.md`: `:513` (FILE-60), `:807` (NEW-REQ-2), `:810` (NEW-REQ-5) (P24).
- `REWRITE_SCENARIOS.md`: `:263` (P23a), `:1043` (F-TESTS-LOCAL, P22).
- `scenarios/checks/registry.ts` regenerated with `checks/import-docs.mjs`: S-QA-5 moves M3 → M5; `ledger.test.ts` passes (3/3, `/private/tmp/m3-ledger.log`). No other registry change was needed.

### 10.2 Slice 0: the scheduler

- Red: `0-fast-order.log` (first the module missing, then a stub that keeps file order: 4 of 4 fail on their assertions).
- Before (file order), three runs: 40.9 s, 40.7 s, 45.0 s (`/private/tmp/m3-s0-before-{1,2,3}.log`, 46 jobs, 349 passed).
- After (longest first): 35.7 s (first run, no times yet: by size), 32.9 s, 32.1 s (`/private/tmp/m3-s0-after-{1,2,3}.log`, 47 jobs, 353 passed).

## 11. Audit (part 2): findings and what changed

The audit is `.rafi-build/M3-audit.md`. Each finding, and where it went:

| Finding | Applied? | Where |
|---|---|---|
| P21: needed; counts M3 4, M5 15 | Yes, with M4's running total too (29 → 28), which the plan had missed. Exact lines in 8.1 | 0, 8, 8.1 |
| P22: the fix must also make S-CHK-3's setup say F-TESTS-LOCAL, and push the setup script to M7 | Yes. SCN's fixture table (`REWRITE_SCENARIOS.md:67`) already lists S-CHK-3 under F-TESTS-LOCAL, so only the setup line changes | 0, 3.1 item 8, 8.1 |
| P23: the minimums are a product decision; `risk` accepts any string | Yes: options, a recommendation and what's built under each; it's a question for you. `risk` as an enum is option (b) yes; FMT-T6 already says it. The fallback under (b) no gives the High minimum, so a bad value never lowers QA's depth | 2.1, 3.2 item 13, 4, C113, 8, 8.1, questions |
| P24: also decide the event version and migration | Yes: `v: 2` with no migration, as ARCH 3.5 already decides for pre-1.0 changes (`REWRITE_ARCHITECTURE.md:379`), plus a read test for an old row. The text change now covers all three "stores only its path and fingerprint" lines (`REWRITE_REQUIREMENTS.md:513,807`, `REWRITE_ARCHITECTURE.md:424`) and 6.4 (`:898`) | 2.1, 3.2 item 22, C129, 8.1, 9 item 8 |
| P25: user decision | Yes: options, a recommendation and what's built under each | 2.1, 4, C120, 8, 8.1, questions |
| P26: add the row; keep C104's tests | Yes; items 12 and 18 unchanged | 8, 8.1 |
| P27: add the row, saying it's uncommitted and removed after the review | Yes | 8.1 |
| P28: add the Security line | Yes, and it now also says an agent-changed file never adds a check rafi runs (P29) | 8.1 |
| Copy review needs session and root plumbing | Yes: C128, the `context.ts` row, `closeSession`, item 20, and S-QA-7 asserts `session: new`, the copy `cwd` and the in-place session closed. **Not as written:** the copy-rooted `run_check` is asserted in `security-m3-copy.test.ts` on F-TESTS-LOCAL, not in S-QA-7, because F-CHAIN has no test runner (`scenarios/fixtures/f-chain.ts:9-11`) and giving it one would change the fixture SCN declares. `session.ts` needs no change (`build/session.ts:19,55,61`) | 0.1, 2.2, 2.4, 3.1 item 6, 3.2 item 20, 4, C108, C128 |
| C116 runs checks from a changed file | Partly as written. For a changed file, the plan doesn't drop every requirement check, as proposed; it keeps the checks of lines whose digest still matches `req_fps`, so unchanged requirements keep their check-step gate (S-QA-5 step 2: "the others get normal verdicts") while nothing from a changed, added or removed line runs. With the file missing or unreadable: only `required_tests` and related tests, as proposed. Added the allowlisted-check security test and P29 | 2.2, 3.2 item 21, 4, C116, 8, 8.1 |
| `req_fps` with no migration or compatibility test | Yes: C129 and item 22 (see P24) | 2.1, 3.2 item 22, C129 |

## Questions for the user

P21–P29 need your approval because they change the locked docs (exact text in 8.1). Two of them are product choices:

**1. How deep must QA prepare, by ticket risk? (P23)**

(a) The minimum depth for each risk:
- (i) Low **standard**, Medium **standard**, High **extensive**.
- (ii) Low **focused**, Medium **standard**, High **extensive**.
- (iii) Low **standard**, Medium **extensive**, High **critical**.

**Recommendation: (i).** Standard is today's floor for every ticket without written low-risk evidence (`ai-foreman/src/qaPreparationPolicy.ts:49-54`). Extensive is today's minimum for the common risk kinds (`spec/src/qaPreparation.ts:104-106`). (ii) would prepare less than today for every Low ticket. (iii) costs more QA turns on every Medium ticket, and no scenario asks for that. A planner can always choose more.
What gets built: one map in `build/depth.ts` with your three values, and its table test. Nothing else changes. With (iii), S-QA-5 expects `critical`.

(b) Should `risk` have to be `Low`, `Medium` or `High`?
- **Yes (recommended).** FMT-T6 already says so (`REWRITE_REQUIREMENTS.md:533`), today's schema enforces it, so migrated projects already comply, and a typo can't quietly pick the wrong minimum. Built: the enum in the ticket schema. A bad or missing `risk` exits 1, naming the ticket and the field, before any agent turn.
- **No.** `risk` stays free text. Anything other than exactly `Low` or `Medium` gets the High minimum. FMT-T6 changes (8.1).

**2. Can you ask for full QA isolation on a ticket that isn't High risk? (P25)**
- **A. No, not in 1.0 (recommended).** Drop "or explicitly requested" from REQ. Built: nothing more. To get full isolation, mark the ticket High. No scenario needs B, and B can be added later without breaking anything.
- **B. Yes, with a ticket field `qa_isolation: full`.** Built: the field and its validation. The isolation rule becomes "High risk or `qa_isolation: full`", and `qa.isolation.why` says which one applied. One unit test, no new scenario build. ARCH 13 changes.

Until you answer, the implementer builds (i), "No" for (b) (unknown risk gets the High minimum), and A. Changing to (b) "Yes" later adds the enum and its tests and touches nothing else.

### 10.3 Slices 1–3

- **Slice 1** (harness and fakes). Red `1-harness.log`: first a load error (no `addFiles`), then, with interface stubs, 7 of 7 tests fail on their assertions. Green: 7/7. Built: `B.also`, `B.read`, `B.outside`, `B.requirements`, `B.reject`, `B.sameReject(n)`, `B.pass`, `B.unable`, `B.malformedOf`, `B.repairOf`; the `outside` step in both fakes (`fakes/script/roles.mjs` `outsideEdit`, no tool event); Codex `read` as `cat <path>`; `cwd` in the transcript and in `CheckLogEntry`; `addFiles`, `setTickets` (fixtures/common.ts); `copyProject` (harness/scenario.ts). `B.also`, `B.read` and `B.outside` add their steps after the role's happy path (`B.edit`, from M2, adds its edit before it).
- **Slice 2** (pure rules). Red `2-pure-rules.log`: the new modules first missing, then stubbed (circling 6/6, answers 4/5, depth 10/12 fail on assertions); transitions 2/5, versions 3/3, spec v1 5/8 fail on assertions. Green: all. Built: `turns/circling.ts`, `state/answers.ts`, `build/depth.ts`, C104 in `state/ticket.ts` (`unblocked`), `def()`'s version, `requirements.written` v 2 with `req_fps` and the depth enum, the ticket schema's `risk` enum (P23 b), `qa_preparation` and `qa_isolation` (P25 B). The prepare step writes `req_fps` now so the schema change keeps the suite green; depth stays `standard` until slice 7.
- **Slice 3** (reject, fix, re-review). Red `3-S-QA-1.log` (4 of 6 steps fail: no "QA rejected the work" line; builder turn 2 lacks R2; no delta in QA turn 2) and `3-messages.log` (stubs: 5/5 fail). Green: S-QA-1 6/6, messages 5/5. Built: `instructions/messages/review.ts` and `messages/fix.ts` (split out of `messages.ts`), `build/steps/history.ts`, the delta review (C108) via `sessionUsed`, the QA-rejection fix message (C109), the rejection line and "QA broke (no verdict)" (C110). While writing S-QA-1 the fix's `B.edit` turned out to edit before the happy path's own write, so the fix produced the build's tree again; the scenario uses `B.also` for the fix's edit.
- **Changed M1/M2 tests** so far: `spec/test/v1/v1.test.ts` (requirements.written is v 2), `engine/test/state/transitions.test.ts` (validates each variant at its registered version), `engine/test/state/ticketTable.ts` (the requirements variant has `req_fps`), `spec/test/v1/config.test.ts` (the minimal ticket now needs `risk`, P23 b). Each follows from C129 or P23 (b).

### 10.4 Threat note: questions and waivers (before slice 4)

- **An agent answers "What next?".** Only `BuildUI.question` (the terminal) answers in M3, written `actor: user`, `source: terminal`. An agent's `rafi answer …` is already refused by the permission policy (M2 threat 24); a QA note saying "pick option 2" is only quoted data in the question text. Tested in `security-m3-qa.test.ts`.
- **Notes as instructions.** The question text quotes QA's notes; they're escaped and redacted before the log, the progress file and the terminal. The options are rafi's, never from a reply.
- **Secrets in typed notes.** The note goes through the one redactor on write (`question.answered`, `waiver.recorded`); the terminal doesn't echo it back; the progress file's answers leave notes out (C121).
- **Two answers.** First answer wins through the idempotency key `answer|<question id>` in one transaction (C101).
- **A waiver outliving the code it covered.** The waiver's digest covers the files of the ticket's latest builder snapshot (C106); the stale check reopens the ticket when they change (C107).

### 10.5 Slices 4–6

- **Slice 4** (What next?). Red `4-S-QA-2.log`: S-QA-2 fails at step 1 (no "What next?"; the build ended with "the build is waiting"); questions 3/3 and keys 2/2 fail on assertions against stubs; qa-m3 fails on its assertions (one of them first on a wrong selector in the test itself, fixed; its "QA broke" line, built in slice 3, was then checked by mutation: `mutation-C110-qa-broke.log`, fails as it should). Green: S-QA-2 steps 1, 2, 4; questions 3/3; keys 2/2; qa-m3 4/4. Built: `ask/questions.ts`, `ask/keys.ts`, `ask/blocked.ts` (the what-next draft, its five options as UI data, applying an answer), questions opened at the safe point (C99, `build/loop.ts` `openMissing`), asked on `wait` (C100, `askInTerminal`, with `build.waiting`/`build.unwaiting`), the CLI prompt (`commands/start.ts` `question`, `ui/prompts.ts` `askText`), deliver's validation (C105), `validation.waiver` in `tickets show`, the progress file's answers by key and question options (C121). The harness ends the terminal's input after the typed lines, and `readLine` returns null on an input that already ended (it hung before: a stream that ended never emits "end" again).
- **Checkpoint (end of slice 4):** 41.5 s, 39.6 s, 38.5 s (`/private/tmp/m3-cp4-{1,2,3}.log`, 58 jobs, 415 passed, the 2 failures were S-QA-2 step 3, not built yet). Slowest: 41.5 s, under 50 s.
- **Slice 6** (stale waiver; done before slice 5). Red `6-S-QA-2-step3.log`: step 3 fails (exit 0, no `ticket.reopened`). Green: S-QA-2 4/4 runnable steps. Built: `staleWaiver` (ask/blocked.ts), called after `build.started` for `--ticket`. The README-only branch passed with the stale branch, so it was checked by mutation (every waiver stale): `mutation-S-QA-2-step3.log`, step 3 fails.
- **Slice 5** (circling). Red `5-S-QA-3.log` (script A runs 3 fixes, not 2; script B has no `files_read`) and `5-S-MAL-2.log` (variant 3: 4 build turns, not 3). Green: S-QA-3 2/2, S-MAL-2 variant 3. Built: `files_read` (C111, `work.ts` `filesRead`, from the turn's tool events, returned by `agentTurn` as `tools`), verdict and check signatures and circling (`history.ts` `attemptHistory`/`circlingNow`), turn-level circling in the runner (C112: `tries`, `circlingRepeats`, the reason "malformed reply N times (the same change repeated)", `step.failed.circling`). The qa-m3 test "after an early circling question, Retry still runs exactly one more fix" passed first (C104 was built in slice 2); mutation `mutation-C104-retry-after-circling.log` (the grant not used) fails it with 5 fixes.
- Fast suite after slice 6: 58 jobs, 422 passed, 0 failed, 39.4 s (`/private/tmp/m3-s56-fast.log`).
- **Slice 7** (requirements-file rules). Red `7-S-QA-5.log` (all 7 runnable steps fail: no "Acceptance criteria" section, depth `standard`, the prepare message has no path, no receipts) and `7-trusted-checks.log` (stubs: 4/4 fail). Green: S-QA-5 7/7 runnable steps, trusted-checks 4/4. Built: the depth minimum and its one raise (`build/depth.ts` into prepare), every section always rendered with an "Acceptance criteria" section (C126), the prepare message's depth and path, `Requirements` with status (`delivered`, `changed`, `missing`, `unreadable`) against `requirements.written`, `trustedChecks`/`affectedRequirements`/`trustedOf` (C116, C115), the receipt per review turn, the warning line and the review message's warning, the unable override (`needs: file`), affected and person-only requirements optional in a verdict (C125), the check step's trusted checks with the missing-file fallback, `depth` in `tickets show`, receipts in `stats show`. Step 4 failed only for want of receipts, so it was checked by mutation (the review takes its path from the builder's reply): `mutation-S-QA-5.log`, step 4 fails.
- **Changed M2 test:** `security-m2.test.ts` "review 1: a requirements file edited after rafi wrote it can't make the check step run curl" asserted the curl check is recorded `refused` and the ticket isn't delivered. Under C116 (P29, approved) a changed line gives no check at all, so nothing is recorded for it, R1 is "unable to verify" and the build goes on; the test now asserts that (curl still never reaches `checks.run`).

### 10.6 Threat note: the QA copy and fingerprints (before slice 8)

- **Cleanup removes your work.** The copy is only ever `.rafi/cache/qa-copy/<ticket>-<attempt>`; removal is `git worktree remove --force` on that path, refused for any other path before anything runs. A symlink in the snapshot that points at your worktree or outside the project is a link in the copy; `worktree remove` deletes the link, not its target.
- **The copy changes git state.** It's made from `commit-tree` (an unreferenced commit) and `worktree add --detach`: no ref moves, the real index isn't touched; `worktree prune` removes its admin folder.
- **QA works in your folder while the copy exists.** After drift the in-place QA session is closed before the copy's opens, and every root (agent cwd, run_check rules and checks, sandbox worktree, permissions, instructions) is the copy (C128).
- **Fingerprints follow symlinks.** The full fingerprint is a fresh temporary index (`git add -A`, no stat cache) and its tree, so links are hashed by their text and never followed (`git hash-object` does follow them, checked in this session); ignored folders aren't read.
- **A drifted verdict is kept.** The in-place reply after drift is discarded; only the copy review's verdict is recorded.

### 10.7 Slice 8: QA isolation

- Red `8-S-QA-7.log`: S-QA-7 both steps fail (no `qa.isolation`; no drift line), session-root fails (one review, no copy), isolation.test first missing its modules, then with stubs 4/4 fail on assertions. Green: S-QA-7 2/2, isolation 4/4, session-root 1/1.
- Built: `facts/fingerprint.ts` (the full fingerprint is a fresh temporary index's tree: `git add -A`, no stat cache; links stored as their text; files and bytes from `ls-tree -r -l`), `build/isolation.ts` (`isolationFor` with P25 B's `qa_isolation: full`, `makeCopy` via `commit-tree` and `worktree add --detach`, `removeCopy` confined to `.rafi/cache/qa-copy/<name>`, and `isolated`, which runs the in-place review, checks the light or full fingerprint after it and, on drift, closes the in-place session, redoes the review in a new session rooted at the copy, closes that session, then removes the copy), session roots in `build/context.ts` (key `ticket|role|reply|root`; root passed to `openSession`, `rulesFor`, `checkEnvFor`, the permission policy; `closeSession`), `reviewTurn` in `steps/review.ts`. The harness records Claude session opens and closes (`computer.script.sessions`) for the ordering checks.
- **C130 (new choice):** the standing instructions stay rooted at the project, not the copy. The compiled core is rafi's own file under the project's `.rafi/compiled/`, which a copy (made from the snapshot, which leaves `.rafi/` out) doesn't have; rooting them at the copy would silently drop it. Every other root in C128 is the copy.
- **Item 20 is in `scenarios/test/session-root.test.ts`,** not `engine/test/build/`: it needs the harness's in-process fakes and their session record. It checks two sessions for one ticket and two roots, the copy's agent cwd, check cwd and sandbox worktree, the close order, and the full message for the next review; the permission root isn't observed separately (the copy session is read-only QA and asks no permission in the fakes).
- **Checkpoint (end of slice 8):** 45.4 s, 45.5 s, 45.2 s (`/private/tmp/m3-cp8-{1,2,3}.log`, 63 jobs, 442 passed, 0 failed). Under 50 s. `qa-m3.test.ts` took 9.8 s alone, over the 8 s rule, so it was split into `qa-m3.test.ts` (4.9 s) and `qa-m3-prompts.test.ts` (4.8 s). The other new files alone: qa 5.2 s, qa-next 5.0 s, requirements 5.5 s, isolation 2.2 s, session-root 1.6 s, harness-m3 4.7 s.
- `tsc`: 0 errors in engine, spec, rafi; scenarios had 4 (the export type lacked `actor`/`source`, an unused `@ts-expect-error`), fixed, now 0.

### 10.8 Slices 9–11

- **Slice 9** (checks). Red `9-checks.log`: S-CHK-3 step 1 fails on its assertion (the related tests `a1.test` and `a2.test` don't run with QA on); S-CHK-2 passes first (M2's freshness code). Green: both. Built: C117 in `steps/check.ts` (`ownChecks`, `dedupe`: the trusted checks, then `required_tests` and related tests, one run per test file; extras numbered after the requirements). S-CHK-2's three mutations (`mutation-S-CHK-2.log`): `fresh()` always false fails A; `fresh()` always true fails A and B; `checks.failed` going to review fails B.
- **Slice 10** (malformed QA replies). `10-S-MAL-3.log`: the verdict run first failed because the test's fake resent a reply rebuilt from the repair message (different runs); fixed in the script (the resend repeats the first reply), not in rafi. Then all three runs pass; rafi's code was M2's, so: `mutation-S-MAL-3.log`: a non-builder format reply treated as content fails the prepare and verdict runs; a fix turn's format reply treated as content fails the fix run; a repair accepted with a changed value doesn't fail S-MAL-3 (it only checks accepted repairs) but fails S-MAL-2 variants 1 and 3.
- **Slice 11** (security). `11-security.log`: section 4's tests in `security-m3-qa.test.ts` (6) and `security-m3-copy.test.ts` (2); the first failed only on its own exit-code expectation (`--steps 2` is met by T2 and T3, so the build exits 0 with T1's question open), fixed in the test. Every defense was already built, so each was checked by mutation (`mutation-security-m3.log`): notes outside the fence, the answer and waiver not redacted on write, `trustedChecks` ignoring `req_fps`, no unable override, any string as a depth, the rendered file kept as a blob, checks ignoring the copy root, the full fingerprint adding ignored files: all killed. "The what-next text isn't escaped or redacted" first survived (the no-terminal run never prints the question, and the log redacts the canary on write anyway); the typed-note test now runs a hostile QA note in a terminal and checks the raw output and the title for its OSC escape, and the mutation is killed.

### 10.9 Threat-model review (after slice 11)

ARCH 1.2's rows that M3's code touches, the code path, and the test.

| Row | M3 code path | Test |
|---|---|---|
| An agent acts outside its ticket: `rafi answer` | Only `BuildUI.question` answers (`ask/blocked.ts` `askWhatNext` → `ask/questions.ts` `answerQuestion`, `actor: user`, `source: terminal`); the permission policy refuses the builder's `rafi answer` (M2) | security-m3-qa "only you answer" |
| An agent acts outside its ticket: weakening the spec | `steps/common.ts` `trustedChecks`/`affectedRequirements`/`trustedOf`; `steps/review.ts` `fileWarning`/`overridden`; `steps/check.ts`; every `run_check` allowlist from `trustedOf` | security-m3-qa "weakening the spec", "an allowlisted check slipped in"; trusted-checks.test; S-QA-5 steps 2–3 |
| An agent runs commands through rafi | The copy's `run_check` goes through the same executor with the copy as its root (`context.ts` `checkEnvFor`/`rulesFor` with `root`) | security-m3-copy "a copy review's run_check"; session-root.test |
| QA changes code | QA's runs in a copy are restored in the copy; the copy is removed after (`build/isolation.ts` `isolated`, `removeCopy`) | security-m3-copy; S-QA-7 step 2; isolation.test |
| Instructions hidden in data: QA's notes | `messages/fix.ts` `qaFixMessage` and `messages/review.ts` (quoted, escaped, redacted); `ask/blocked.ts` `clean`; `review.ts` `rejectedLine` | security-m3-qa "only you answer", "a canary typed …; the question is escaped"; messages.test |
| Secrets leak: typed notes | Redaction on write (`log/append.ts`) covers `question.answered` and `waiver.recorded`; the progress file leaves notes out (`progress/write.ts`); the CLI doesn't echo the note | security-m3-qa "a canary typed" |
| Damaged or hostile files | `spec/src/v1/tickets.ts`: `risk` enum, `qa_preparation` strict enum, `qa_isolation` literal; zod's messages name the field without echoing the value | security-m3-qa "a damaged …"; spec v1.test |
| Your code: cleanup and git state | `build/isolation.ts` `checkedCopy` (only a direct child of `.rafi/cache/qa-copy/`), `commit-tree` plus `worktree add --detach`, `worktree remove --force` plus `prune` | isolation.test (symlinks in and out, path refusals, refs, HEAD, index); S-QA-7 step 2; security-m3-copy |
| Your machine: fingerprints | `facts/fingerprint.ts` (a fresh index's tree: links as text, ignored folders unread) | isolation.test; security-m3-copy "bounded on F-HUGE" |
| Requirement content stays out of records | `requirements.written` and `requirements.receipt` hold digests only | security-m3-qa "requirement text stays out" (events, `stats show`, the database file's bytes) |

**New holes found and fixed test-first:**

1. **A copy a crash left behind** at `.rafi/cache/qa-copy/<ticket>-<attempt>` made the next review's `git worktree add` fail, stopping the build, and left a second worktree registered. Red `threat-1.log` ("already exists"). Fixed in `makeCopy`: a leftover copy at that path is removed first (`worktree remove --force`, then the folder) and `worktree prune` runs; never reused.
2. **The waiver's covered files** left out every path under `docs/requirements/`, so with another `docs.root` your own files there wouldn't make a waiver stale. Red `threat-2.log`. Fixed in `coveredFiles`: it leaves out exactly the path `requirements.written` recorded.

**Checked and left as they are:** QA's allowlist is fixed when its session opens, so a reused session keeps only checks rafi validated (a changed line's new check is still refused, a dropped one stays allowed, which is harmless); `filesRead` only stats agent-named paths inside the worktree, never reads them; the full fingerprint's `git add` runs no filter or hook that the M2 snapshot doesn't already (agents can't write `.git/config`, M2 threat 9); question numbers are computed outside the append's transaction, which is safe while one build holds the lease (M4's `rafi answer` from a second process should take the number inside the transaction).

### 10.10 Slice 12: the gate

- **First gate run over 55 s:** 57.4 s, 56.0 s, 55.4 s (68 jobs, 461 passed, 0 failed). The suite is bound by total work (221 s of job time on 4 workers), and one one-ticket build had grown to about 530 ms and 39 child calls. Section 6's first cut was applied: the snapshot finds the real index from `.git` (a folder, or a worktree's `gitdir:` file) without `git rev-parse --git-path index`, and callers that only compare trees (the check executor's before/after/restored and step snapshots, the review's after-snapshot) skip the HEAD lookup and the diff (`snapshot(…, { files: false })`). A one-ticket build is now about 340 ms and 24 child calls (`GIT_TRACE`, this session).
- **Gate, after the cut:** fast suite 43.6 s, 44.9 s, 41.2 s (`/private/tmp/m3-gate-{1,2,3}.log`): 68 jobs, 461 passed, 0 failed, 36 skipped (each a `pending` step of a later milestone). Every new file alone is under 8 s (security-m3-qa 7.7 s, the rest under 6 s). `check-rules`: 191 files, 0 problems (build 1695/2000, ask 249/1300, state 939/1300, turns 464/900, facts 173/450, instructions 241/1000; deps unchanged at 636/650). `pnpm test:process`: 19/19 (`/private/tmp/m3-process.log`). `tsc --noEmit`: 0 errors in engine, scenarios, spec and rafi.
- **Scenarios, by name.** Must pass, in full: S-QA-1, S-QA-3, S-QA-7, S-CHK-2. Partial, their M3 steps pass: S-QA-2 steps 1–4 (5 pending M8, 6 pending M4), S-QA-5 all but the F-BRANCH clause (pending M5), S-MAL-2 variant 3 (variant 2 pending M6), S-MAL-3's three QA runs (Planner and Ticket Maker pending M9), S-CHK-3 step 1 (the setup-script line pending M7, step 2 pending M8). Every M1 and M2 scenario and test still passes.
- **Changed M1 and M2 tests (all):** `spec/test/v1/v1.test.ts`, `engine/test/state/transitions.test.ts`, `engine/test/state/ticketTable.ts` (C129); `spec/test/v1/config.test.ts` (P23 b); `scenarios/test/security-m2.test.ts` "a requirements file edited after rafi wrote it" (C116, P29); `scenarios/scenarios/malformed.scenario.ts` (S-MAL-2 variant 3 replaces its `pending("M3")`). Item 12's C104 checks are context tests in `transitions.test.ts`; the table's existing row already covers `blocked` + "unblocked resume fix" → `queued`.
- **Where the plan's files moved:** the transcript helpers are in `scenarios/scenarios/m3-helpers.ts`, not `checks/transcript.ts`; item 18 is two files (`qa-m3.test.ts`, `qa-m3-prompts.test.ts`); item 20 is `scenarios/test/session-root.test.ts` (10.7).
- **Left for later milestones, found while building:** S-MAL-2 variant 2 (M6, "every reply malformed … after the retry limit") may now stop early under C112 when the repeated failures have the same signature; M6 should check whether its "after the retry limit" still holds or the variant should expect circling. With `--steps N` met by other tickets, a build exits 0 while a what-next question stays open (rule 5 of 4.5 as built in M2); M6's exit 2 is the place to revisit it.
- **Unverified here (no paid turn, no CI):** section 9's items 1–4 (real QA reading the file, a real Codex builder's `files_read`, real sessions inside `.rafi/cache/qa-copy/`, Linux and Windows `git worktree` and symlinks).

### 10.11 Review (part 4): `.rafi-build/M3-review.md`

1. **Fixed: QA-copy cleanup could escape through a symlinked copy-root parent.** `checkedCopy` checked the path only lexically, so a `.rafi`, `.rafi/cache` or `.rafi/cache/qa-copy` that was a symlink let `makeCopy` add the worktree, and `removeCopy` force-remove it, outside the project. Test first: `engine/test/build/isolation.test.ts` "review fix 1" (each of the three folders as a link: `makeCopy` refuses, nothing is made at the link's target, one worktree; a copy whose root is swapped for a link after it was made: `removeCopy` refuses and the target is untouched). Red `.rafi-build/M3-red/fix-1.log` ("Missing expected rejection: .rafi"). Fix: `checkedCopy` is now async and resolves each existing part (`.rafi`, `cache`, `qa-copy`, the copy) with a new `Fs.realpath` seam (null when missing; added to `deps/types.ts`, `deps/real/fs.ts`, the harness fence and tracked deps); each must resolve to the same place under the project's own resolved path, or the call is refused naming the link. Comparing against the project's resolved path keeps a symlinked project folder (macOS `/var` → `/private/var`) working. Mutation `.rafi-build/M3-red/mutation-fix-1.log`: with the comparison disabled the new test fails; with `removeCopy` skipping the check, it and the older "cleanup refuses" test fail. A link swapped in between the check and git's call is not covered (a local attacker racing rafi's own folder); recorded, not built.
2. **Not changed: builder/QA `run_check` of a command from a changed requirement line.** The docs make the runner rule its own boundary, separate from the requirement checks: ARCH 6.9 (`REWRITE_ARCHITECTURE.md:953`) lists three accepted kinds, of which only the first, "the requirements file's check commands", is limited to lines "unchanged since (`req_fps`)"; the second, "the project's test runner (`checks.test_runner`) with file or test-name arguments", has no such limit. S-CHK-3 (`REWRITE_SCENARIOS.md:1043`, `:1049`) has QA run `fake-test e2e/a.spec`, "a browser test not in the requirements file", and expects it recorded `asked_by: qa`, not refused. P29's edit (`:959`) and the M3 Security line (`:1704`, "never adds a check rafi runs") are about the check step's own checks, and plan section 4's row (line 188) asks only that no `asked_by: rafi` run names `e2e/wipe.test`; the refusal row (line 187) is for `curl`, which is outside the allowlist and is refused. ARCH 1.2 (`:82`) blocks commands through `run_check` by the allowlist, the permission policy and the sandbox. An agent could run `fake-test e2e/wipe.test` without touching the file, so refusing it only when it came from a changed line would add nothing; a builder's or QA's own run of it never makes R1 pass (R1 stays `unable`, checked by `security-m3-qa.test.ts:109`).
3. **Gate after the fixes:** fast suite 42.3 s on 4 workers (68 jobs, 462 passed, 0 failed, 36 skipped; `/private/tmp/m3-fix-gate-1.log`); `check-rules` 191 files, 0 problems (`deps` 646/650 lines); `pnpm test:process` 19 passed; tsc clean in engine, scenarios, spec and rafi.
