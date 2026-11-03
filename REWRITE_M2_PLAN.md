# M2 implementation plan: agents, replies and one-ticket builds

Status: **plan, audited** (parts 1–2); implemented (part 3), not committed; see section 10. Next: review (part 4).
Audit: `.rafi-build/M2-audit.md`, applied 2026-11-02 (section 9). P13–P18 approved by the user and applied to the locked docs (section 7). The no-sandbox details were decided on 2026-11-02 (section 1.2, C60).
Milestone: `REWRITE_ARCHITECTURE.md` (ARCH) section 14, M2. Rules: `REWRITE_BUILD_HANDOFF.md` (its item "0." is ignored, as the user decided).
Written 2026-11-02 against `feature/rewrite` at `1998ab0` (M1 committed), from the code M1 shipped, not only from `REWRITE_M1_PLAN.md`. No code was written for this plan.

## 0. What M2 delivers

From ARCH 14 M2 (`REWRITE_ARCHITECTURE.md:1644-1650`, with P14 applied):

- **First:** three checks the handoff lists as unverified for M2 (section 1).
- **Builds:** `run_check` and `check_output`, `check.run` records, rerunning only stale checks, the run time limits (`timed-out` and `too-slow`; the `limit` question is M6, P16); complete Codex and Claude adapters; the builder, requirements and verdict reply schemas; the turn runner (classify, one repair try, retries with backoff, idle timeout, cancel); facts (run records, snapshots, changed files, mismatches); the loop for tickets in sequence with `--steps N` (prepare, build, check, fix after a failed check, review that passes, deliver with completion `none`); the progress-file write; first versions of `rafi status`, `rafi stats show`, `rafi stats export`, `rafi tickets show`; activity rows and plain-English lines; `--agent`, `--model`, `--effort`, `--fast`; a fresh session per ticket; settings with their sources (default, project, flag); `--no-qa`'s tests; the fix step after a failed check, counted against `retries.fixes`, and the related tests per ticket (moved from M3 by P14); `AskUserQuestion` answered at once; the no-sandbox warning as a separate prompt at start (6.9, NEW-SEC-4, C60).
- **Must pass (14):** S-START-1, S-START-4, S-MAL-1, S-MAL-5, S-TIME-1, S-TIME-2, S-SCN-1, S-SCN-14, S-ENG-4, S-ENG-5, S-CHK-1, S-CHK-9, S-CHK-10, S-CHK-11.
- **Partial:** S-MAL-2 (variant 1), S-MAL-4 (the builder runs), S-CLI-12 (prefixes, colors and exit codes of builds).
- **Also:** the opt-in live adapter check by hand (section 1.4).
- **Done when:** the 14 pass in full (S-ENG-5 step 3 and S-START-1 also in the process set), the partials' M2 steps pass, every M1 scenario and test still passes, the M2 security tests pass (section 4), the fast suite runs under 60 s on 4 workers, `check-rules` is clean, and each slice's red run is on file (section 5).

Not in M2: QA rejection and its fix loop, circling, "What next?" (M3); the lease heartbeat, liveness, resume, stop, Ctrl+C (M4; the activity heartbeat rows are M2, C58); delivery with git, tags, `--set`, org policy, the rest of `rafi tickets` (M5); the question record beyond the runtime prompt, `rafi answer`, notifications, the `limit` question and leaving `blocked(limit)` (M6, ARCH:1673); the upfront check (including its limit item, 6.11 "Next build", and the no-sandbox item, which replaces M2's separate prompt), grants, `--allow`, S-CHK-4's hung and slow tests (M7).

### 0.1 Facts checked in this session

| Fact | Evidence |
|---|---|
| Baseline: fast suite 18 jobs, 99 passed, 0 failed, 4 skipped, 2.6 s wall on 4 workers; `check-rules` 93 files, 0 problems | `pnpm -s test:fast`, `node scripts/check-rules.mjs` (logs `/private/tmp/m2plan-fast.log`, `/private/tmp/m2plan-rules.log`) |
| Module totals today: deps 424/650, log 516/900, state 889/1300, workflow 229/400, agents 118/700, agents/codex 253/600, agents/claude 167/600, api 63/600, config 37/400 | `check-rules` budget report |
| Every built command still prints "not built": the action only runs the format check, then `notBuiltLine` | `rafi/src/next/cli.ts:68-77` |
| `start`, `status`, `stats show`, `stats export` are tagged M2; `tickets show` is tagged M5 | `rafi/src/next/commands/table.ts:27,44,49,137`; `commands/tickets.ts:22-23,39` |
| `checks.run` and `serve` throw in the real deps and the harness deps | `engine/src/deps/real/index.ts:31-32`; `scenarios/harness/deps.ts:98-99` |
| `CheckRun.sandbox` is `readonly string[]` and `checks.run` returns `ExecResult`; ARCH 8.2 has `Grants` and `CheckResult` | `engine/src/deps/types.ts:133-149`; ARCH:1184 |
| The Claude adapter fixes `outputFormat` from the session's first turn, so one Claude session has one reply schema | `engine/src/agents/claude/options.ts:19`; `claude/adapter.ts:35-36,67` |
| The Codex adapter maps usage from `tokenUsage.total` only; NEW-ADP-2 needs the latest sample for occupancy | `engine/src/agents/codex/events.ts:41-44`; REQ NEW-ADP-2 |
| The Codex adapter sends no grants, effort, fast tier or MCP config; approvals become `permission` events | `engine/src/agents/codex/adapter.ts:27-34,52-59,77-79` |
| The role registry gives the builder `codex` as default agent; FLAG-ST-R5 says Claude when no single target is set | `engine/src/workflow/roles.ts:10-11`; `REWRITE_REQUIREMENTS.md:240` |
| The ticket machine already has the check → fix loop, `--no-qa` skips and `blocked(limit)` | `engine/src/state/ticket.ts:32-57,159-164`; `workflow/standard.ts:20-34` |
| S-CLI-2's alias check expects `start … -y` to print "isn't in the new engine yet (milestone M2)"; it must change when `start` is built | `scenarios/scenarios/cli.scenario.ts:132-137` |
| The fake clock's auto-advance fires only the next auto timer; earlier `heartbeat` or `poll` timers stay unfired until `advance()` | `scenarios/fakes/clock.ts:96-110` |
| codex-cli 0.164.0; `thread/start` takes a free-form `config` object; `mcpServerStatus/list` takes a `threadId`; `codex mcp add` takes `--url` and `--bearer-token-env-var`; `codex sandbox -- <cmd>` runs a command under seatbelt | `codex --version`; `codex app-server generate-json-schema` (`v2/ThreadStartParams.json`, `v2/ListMcpServerStatusParams.json`, under `/private/tmp/m2plan-codex-schema/`); `codex mcp add --help`; `codex sandbox --help` |
| Codex `model/list` and the SDK's `ModelInfo` report effort and fast mode, not structured-output support | generated `v2/ModelListResponse.json`; `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1183-1211` |
| SDK 0.3.159: `createSdkMcpServer` at `sdk.d.ts:466`; the sandbox network settings have `allowLocalBinding` | `sdk.d.ts:466,2523-2540` |
| `@modelcontextprotocol/sdk` 1.29.0 is in `node_modules` | its `package.json` |
| This machine: macOS 26.3.1, `/usr/bin/sandbox-exec` present, `bwrap` absent, `claude` 2.1.316 | `sw_vers`, `command -v`, `claude --version` |
| Live provider scripts need explicit authorization and a deadline | `scripts/live/README.md:7,12,23` |

## 1. Step 0: the unverified items, checked first

The handoff's table (`REWRITE_BUILD_HANDOFF.md:89-97`) lists three M2 items. Each is checked before the code that depends on it, time-boxed as M1's fake `claude` check was, and its result recorded in the build log and in a new section 10 of this plan ("Implementation: results and choices made while building", added by the implementer before the questions). A failure follows the table's fallback; none needs a locked-doc change, because each fallback is already in ARCH.

The probes run against the code that will ship, so slice 0 first builds, test-first, the minimal production seams they need (audit finding 1; today `checks.run` and `serve` throw in both deps, `engine/src/deps/real/index.ts:31-32`, `scenarios/harness/deps.ts:98-99`):

- **Tests first** (red log `.rafi-build/M2-red/0.log`): item 25's handshake, `tools/list`, token, `Host` and `Origin` tests against `tools/mcp.ts` and `deps/real/serve.ts`; the 1.2 probe test against `build/sandbox.ts` and `deps/real/checks.ts`.
- **Then build:** the `deps/types.ts` changes (`Grants`, `CheckResult`, `McpHandler`); `tools/mcp.ts` (C37) with the `run_check` and `check_output` tool definitions and a `tools/call` that answers "not built yet"; `deps/real/serve.ts`; `build/sandbox.ts` (C40) and `deps/real/checks.ts`. These are the shipped files at their final paths, not throwaway copies.
- **Then the probes** (1.1 Part A, 1.2 on macOS, 1.3 for rafi's and Codex's sandboxes). Slice 6 adds the rest: `run_check`'s rules and executor, `check_output`, `tools/session.ts`, `build/checks.ts` and the remaining security rows.

### 1.1 Codex reaches rafi's local MCP endpoint per session (half a day, before any adapter work)

Checked exactly as it will ship (ARCH:946): a throwaway script, `scripts/live/rewrite-codex-mcp.mjs`, kept afterwards as a live check.

- **Part A, no model turn, no paid activity.** Start a minimal MCP endpoint on 127.0.0.1, a random port, with a per-session token (the same `tools/mcp.ts` handler the engine will use, choice C37, built in slice 0 as above). Start `codex app-server --listen stdio://`; send `initialize`, then `thread/start` with `sandbox: "workspace-write"`, network off, and `config: { mcp_servers: { rafi: { url, …token… } } }`; then `mcpServerStatus/list { threadId }`. **Pass:** the endpoint logs `initialize` and `tools/list` with the right token, and the status lists `rafi` with `run_check` and `check_output`. Then repeat with a second thread and a different token, to show the server really is per thread. How the token travels is part of the check: an HTTP header in the per-thread config if Codex accepts one, else the token in the URL path (the config goes over stdio, so it never shows in `ps`).
- **Part B, one tiny model turn** (needs the user's authorization, `RAFI_LIVE_*` and a deadline, per `scripts/live/README.md:7`). Same thread; a turn asking the agent to call `run_check` with a harmless allowed command. **Pass:** the endpoint gets `tools/call` and the turn's items show the MCP call. If authorization isn't given, Part B moves into the live adapter check (1.4) and M2 proceeds on Part A.
- **If it fails** (the per-thread config is ignored, or the server isn't started per thread): the handoff's fallback. The adapter starts each session's app-server with `-c mcp_servers.rafi.url=http://127.0.0.1:<port>/mcp` and `-c mcp_servers.rafi.bearer_token_env_var=RAFI_MCP_TOKEN`, with the token in that variable in the app-server's own environment, never in argv (argv is visible to every local user in `ps`). One app-server per session already exists (`codex/adapter.ts:22-24`), so the fallback costs nothing extra. Part A is rerun with the fallback; if it also fails, stop and report to the user with the exchange logged: decision 7 would need revisiting, and that's theirs to decide.
- If Codex's MCP client needs more of the protocol than C37's minimal handler gives (an SSE stream, a session header), the endpoint switches to `@modelcontextprotocol/sdk`'s HTTP server transport as a direct engine dependency; Part A is rerun.

### 1.2 Which OS sandbox `run_check` uses (half a day on macOS; Linux on the first CI run)

A probe test, `engine/test/deps/sandbox.real.test.ts`, drives the real `deps.checks.run` (choice C40, built in slice 0 as above) with probe commands. It runs in the process set and in a new step of `.github/workflows/rewrite-fast.yml` on `macos-latest` and `ubuntu-latest` (the latter installs `bubblewrap`). macOS is checked in the session; Linux is checked when the user pushes, and until then it's reported as unverified.

| Probe | Expected with no grants |
|---|---|
| Write a file in the worktree, in `coverage/`, and under `.rafi/cache/` | allowed |
| `npm_config_cache` and `TMPDIR` point under `.rafi/cache/`; `npm test` on F-ONE | passes, no EPERM, nothing written under `$HOME` |
| Write `$HOME/.rafi-sandbox-probe`, and a file outside the project | denied |
| A child process, a worker thread, reading files anywhere | allowed |
| TCP connect to a public address | denied by the sandbox (an error code, not a timeout) |
| A test that listens on 127.0.0.1 and connects to itself | the 1.3 check |
| A Jest-shaped run (fake-test with `--json`) | per-test results parsed |

- **Pass:** every row as expected on both platforms. `sandbox-exec` (macOS) and `bwrap` (Linux) are the choice, as ARCH 6.9 says.
- **If one conflicts badly** with what tests need (the probe list), the handoff's fallback: switch to a solid replacement without the problem. Known risk: Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor, which can stop `bwrap`. The candidate replacement there is Landlock (filesystem rules without namespaces; TCP rules on newer kernels), evaluated by the same probes. If no replacement passes, stop and report with the probe output (machines without one still build, by the next item).
- **No usable sandbox on a machine** (Linux without bubblewrap, a kernel that blocks it, native Windows): **decided by the user 2026-11-02**: rafi runs the tests without a sandbox after the warning is accepted; it doesn't refuse. The details, also decided 2026-11-02: (1) unattended (no terminal), `checks.run_without_sandbox: true` in `rafi-config.yaml` accepts it in advance; without it the build stops before any agent turn with one line naming the setting; (2) `--auto-approve`/`-y` accepts it; (3) an acceptance is remembered for the project on this machine in `~/.rafi/grants.yaml`, like an "always" grant (ARCH 7.11), and revoked the same way; (4) the warning says plainly that tests can reach the internet and write outside the project; nothing else changes and no internet or local-servers grant is recorded; (5) a separate prompt at start in M2, an upfront item once M7 builds that check. Choice C60 builds it; the locked docs now say so (P17, P18 applied: ARCH 6.9 `:950`, REQ NEW-SEC-4, SCN S-CHK-11).

### 1.3 Local servers without internet, per sandbox

Three sandboxes are involved: rafi's own (`run_check`), Codex's and Claude's (ARCH 7.11, `:1148`).

- **rafi's own**, in the 1.2 probe, with the `local-servers` grant: a loopback listen and connect succeeds while a public connect is still denied. On Linux, `bwrap --unshare-net` gives the test its own loopback, so a server the test starts is reachable but one already running on the host isn't; the probe records which.
- **Codex's**, at the start of M2 with no model turn: `codex sandbox` with workspace-write and network access off, running the same loopback probe. The live adapter check (1.4) confirms it under app-server's per-turn `sandboxPolicy`.
- **Claude's**, in the live adapter check only (it needs a model turn and authorization), with `sandbox.network.allowLocalBinding` on and no allowed domains (`sdk.d.ts:2523-2540`).
- **Result is recorded as data:** each adapter's `capabilities()` gets `localServersWithoutInternet: boolean`, and rafi's sandbox has the same flag. M2 itself grants nothing (grants come in M7), so a `false` changes no M2 behavior. **If it fails** for a runtime, the flag is `false` and M7's upfront item says "Local servers need internet access on <runtime>" with the three choices in the handoff's fallback; M2 adds a unit test that the flag is read, so M7 can't miss it.

### 1.4 The live adapter check (by hand, end of M2, with the user's authorization)

`scripts/live/rewrite-adapters.mjs`, behind `RAFI_LIVE_ADAPTERS=1` and `RAFI_LIVE_DEADLINE`, on real Codex and Claude, for H01's list (ARCH:1650): one small structured turn each; a cancel; a resumed session; usage; a refused tool request; Claude's compaction setting (Q-ADP-1); loopback without internet (1.3); Part B of 1.1 if not yet run. A row that misses its deadline or hits quota is "not run (deadline)" or "not run (quota)", never "fail" (SCN 7.10). Not part of the gate.

## 2. Files to add or change, with budgets

Lines as `wc -l` counts them; files under 500, functions under 100, lines under 120 (ARCH 2.4). Module budgets are ARCH 2.2's.

### 2.1 `packages/spec/src/v1`

| File | Holds | Budget |
|---|---|---|
| `replies.ts` | Builder (6.2), requirements (6.3) and verdict (6.4) as zod; their draft-07 JSON Schema for Claude and the Codex strict projection (port of `projectCodexSchema`, `spec/src/structuredOutput.ts`) | 250 |
| `config.ts` (grows) | M2's keys with defaults: `harness.targets`, `harness.qa`, `agent_defaults.roles.<role>.{make, model, reasoning, fast, session_strategy}`, `retries.*`, `timeouts.*`, `checks.test_runner`, `checks.output_paths`, `checks.run_without_sandbox` (boolean, default `false`, C60), `docs.root` (default `docs`), `logs.capture`, `tickets.build.{branch_strategy, completion}`, `git.managed_by`. Other keys still pass (unknown-key errors are M5, C17) | +170 |
| `tickets.ts` (grows), `delivery.ts` | The 1.0 ticket fields read by M2 (6.5, ARCH 13: `tags`, `needs`, `open_decisions`, `person_only`, `locked`, `manual_checks`, `required_tests`, `likely_files`) and the delivery-unit shape | +140, 60 |
| `progress.ts` | The progress file (ARCH 3.7) | 80 |
| `test/v1/replies.test.ts`, `config.test.ts` | Accept and reject cases; projection snapshot | — |

### 2.2 `packages/engine/src`

| Module (budget) | Files | Holds | Budget |
|---|---|---|---|
| `deps/` (650) | `types.ts` (changes) | `Grants`, `CheckResult` (code, signal, timed-out flag, duration, output), `McpHandler`, `agents.claudeTools` (C38), `random.secret()` (C39) | +45 |
| | `real/checks.ts`, `real/serve.ts` | Spawn a check with the sandbox prefix (C40), stream output, abort; a `node:http` server on 127.0.0.1:0 around `McpHandler` | 110, 80 |
| `agents/` (700) | `capabilities.ts`, `permissions.ts`, `shellForms.ts`, `readiness.ts` | Capabilities per runtime and model (C52); the permission policy, ported from `ai-foreman/src/permissions/policy.ts` and `shellForms.ts` (324 lines); finding the absolute `codex` and `claude` on `PATH` through `deps.fs` (NEW-ADP-4) | 90, 220, 110, 100 |
| `agents/codex/` (600) | `adapter.ts`, `events.ts`, `transport.ts` (grow) | Grants → thread `sandbox` and per-turn `sandboxPolicy` (ARCH 7.11); model, effort, `serviceTier` for fast; the MCP config (C36); the compaction `-c` (ARCH 11.2); usage with latest sample and total (NEW-ADP-2); error codes incl. quota with reset time, auth, session-gone; two final messages reported as such | ~550 total |
| `agents/claude/` (600) | `options.ts`, `adapter.ts`, `events.ts` (grow) | `settingSources`, `sandbox` from grants, QA's private `TMPDIR`, `mcpServers.rafi` from `claudeTools`, model, effort, fast; `AskUserQuestion` answered at once (ARCH 5.1); tool events with name and call id, `is_error`, duplicate results coalesced, `TIME_ELAPSED` as unknown; `api_retry`; result subtypes incl. `error_max_structured_output_retries` | ~550 total |
| `turns/` (900) | `runner.ts`, `classify.ts`, `repair.ts`, `backoff.ts` | Intent → send → validate → repair → retry; boundaries 1–3 (ARCH 4.6); classification (5.1–5.2); the repair template and accept rule (5.3); 10/30/90 s ±20% on `deps.clock`; idle timeout and cancel. `circling.ts` is M3 | 300, 160, 200, 60 |
| `facts/` (450) | `runs.ts`, `snapshot.ts` | Run numbers per ticket, `check.run` writes, mismatches; tree ids from a temporary index under `.rafi/cache/` seeded from the real one, changed files, "no commit yet" | 150, 200 |
| `build/` (2,000) | `loop.ts`, `scope.ts`, `safepoint.ts`, `steps/prepare.ts`, `steps/work.ts`, `steps/review.ts`, `steps/deliver.ts`, `checks.ts`, `sandbox.ts` | The loop (`fold` → `decide` → step); `--steps` only; progress write at safe points (boundary 4); the steps; the check step, staleness, `run_check`'s executor, QA restore, time limits (6.9, 6.11); grants → sandbox prefix, pure (C40); sandbox availability and the no-sandbox acceptance decision (C60) | 280, 60, 80, 200, 220, 200, 90, 320, 220 |
| `tools/` (1,100) | `mcp.ts`, `session.ts` | The minimal MCP handler (C37); `run_check` and `check_output` for one session, routed through the permission policy | 180, 180 |
| `instructions/` (1,000) | `assemble.ts`, `messages/{prepare,build,review,fix,repair}.ts` | Standing instructions and per-turn messages (ARCH 10.2; C53); untrusted text fenced as quoted data | 150, 5 × 60 |
| `progress/` (400) | `write.ts` | Rewrite `.rafi/progress.yaml` from the fold, atomic, sorted keys | 150 |
| `tickets/` (4,200) | `load.ts` | Read and validate `.tickets/tickets.yaml` and `delivery.yaml` (read side of `ai-foreman/src/tickets/ticketSchema.ts`, `ticketLoader.ts`, `delivery.ts`; C54) | 220 |
| `stats/` (700) | `show.ts`, `export.ts` | `stats show` (turns, retries, malformed-reply count by runtime and role, raw replies kept on failure); `stats export` (ARCH 3.5, stable JSON) | 180, 80 |
| `config/` (400) | `load.ts` (grows) | Layers default → project → flag, each value with its source (ARCH 8.6 minus org policy and `--set`) | +140 |
| `api/` (600) | `engine.ts`, `actions.ts` (grow) | `start(options)`, `status()`, `stats`, `tickets.show`; input validation | +200 |
| `workflow/` (400) | `roles.ts` (changes) | `replySchemas` keyed by step (C33); default agent per FLAG-ST-R5 (C34) | +10 |
| `state/` (1,300) | `fold.ts`, `labels.ts` (small changes) | Run numbers and requirements path in the fold; tracker status for `show` | +60 |

Engine total after M2: about 9,000 lines, inside ARCH 2.2's module budgets. `deps/` will land near its 650; if it goes over, the implementer reports it rather than squeezing (M1 plan, section 9).

### 2.3 `packages/rafi/src/next`

| File | Holds | Budget |
|---|---|---|
| `cli.ts` (changes) | Dispatch to a command's action when one is registered; "not built" otherwise | +30 |
| `commands/start.ts`, `status.ts`, `stats.ts`, `tickets/show.ts`; `commands/tickets.ts` (tag `show` M2) | Thin: parse, one engine action, render | 180, 150, 120, 120 |
| `ui/activity.ts` | Rows with timestamps, coalescing, heartbeat rows, harmless failed reads folded (OUT-8, SCN-14) | 220 |
| `ui/lines.ts` (grows), `ui/colors.ts`, `ui/prompts.ts` | Stop and block lines from typed data; colors from `ai-foreman/src/terminalStyle.ts` with `NO_COLOR`, `TERM=dumb`, `FORCE_COLOR` (OUT-9); the runtime prompt for login and quota (C46) | +120, 90, 120 |

### 2.4 `packages/scenarios`

| File | Holds | Budget |
|---|---|---|
| `fixtures/f-tests.ts` | F-TESTS-LOCAL (SCN 2.1): `T1`–`T3`, `checks.test_runner: fake-test`, git left to you | 120 |
| `fixtures/f-huge.ts` | F-HUGE: no-commit repo; one commit plus an ignored folder of 20,000 small files | 60 |
| `fakes/checks.ts` | Scripted `deps.checks.run` on the fake clock: `fake-test` with `pass`, `fail(n)`, `hang`, `slow(8m)`, `writes(coverage/)`, `writes-home-cache` (honors `npm_config_cache`), `edits(file)`, network denied unless the grants allow it, `--listTests --findRelatedTests`, `--json` | 250 |
| `fakes/serve.ts` | The in-memory `deps.serve` the in-process Codex fake calls with its token | 80 |
| `fakes/script/engine.ts`, `parse.ts` (grow); `fakes/script/roles.ts` | SCN 2.2's role happy paths and M2's behaviors: `repair-ok`, `repair-changed(field)`, `missing-field`, `wrong-type`, `two-finals`, `ref(…)`, `claim(cmd, exit)`, `toolfail(n, harmless)`, `run_check(cmd)`, `shell-test(cmd, claim)`, `edit(path)`, `ask(…)`, `slow(…)` with activity, `error(transient\|quota\|auth)` | +150, +40, 160 |
| `fakes/codex/protocol.mjs`, `fakes/claude-cli.mjs`, `fakes/claude/query.ts` (grow) | MCP tool calls; repair turns with tools refused; usage `last`; quota with reset time; the tool-event shapes S-SCN-14 needs; the transcript records model, effort, fast, sandbox, session new or reused | +120 each |
| `fakes/clock.ts` (fix) | Auto-advance fires every timer due up to the target, in order (fact table); `whenTimer(kind, fn)` (C49) | +30 |
| `harness/rafi.ts` (grows) | `rafi.start(line)`: a background handle with `done()`; a second instance in the same "computer" while it runs | +50 |
| `checks/transcript.ts` (grows) | Helpers: turns by role and step, sessions, settings, repair requests | +80 |
| `scenarios/start.scenario.ts`, `malformed.scenario.ts`, `time.scenario.ts`, `checks.scenario.ts`, `pastbugs.scenario.ts`; `engine.scenario.ts`, `cli.scenario.ts` (grow) | The M2 scenarios (section 3) | ≤ 400 each |
| `process/start.process.ts`, `process/engine-switch.process.ts` (grows) | S-START-1 on both fake executables; S-ENG-5 step 3 | 120, +60 |

### 2.5 Scripts, real-deps tests and CI (audit finding 7)

| File | Slice | Holds | Budget |
|---|---|---|---|
| `scripts/live/rewrite-codex-mcp.mjs` | 0 | 1.1's check: Part A (no model turn) by default; Part B only with `RAFI_LIVE_*` and a deadline (`scripts/live/README.md:7`). Kept afterwards as a live check | 200 |
| `scripts/live/rewrite-adapters.mjs` | 15 | 1.4's live adapter check behind `RAFI_LIVE_ADAPTERS=1` and `RAFI_LIVE_DEADLINE`; "not run (deadline)" and "not run (quota)" rows | 300 |
| `packages/engine/test/deps/sandbox.real.test.ts` (new folder `test/deps/`) | 0 | 1.2's probe table and 1.3's loopback rows on the real `deps.checks.run`; process set only, skipped where no sandbox exists, with the reason printed | 250 |
| `.github/workflows/rewrite-fast.yml` (changes; 32 lines today, matrix Windows, macOS, Ubuntu) | 0 | A step that installs `bubblewrap` on Ubuntu and runs the sandbox probe test on macOS and Ubuntu | +15 |

## 3. Scenarios and tests to write first

Each item is written and run **before** its code, and seen failing on its own assertion (section 5's red-run rule), not just on "isn't in the new engine yet". Order follows section 5's slices.

### 3.1 Scenarios (fast suite, mode `next`)

1. **S-START-1** (slice 7): exit 0; transcript order prepare (QA), builder, review (QA); `T1` done in `tickets show --all --json` with validation citing rafi's run; activity rows with timestamps; `stats export` has `build.started` with `standard`, version and digest, and every `step.started` names a workflow step; `.rafi/progress.yaml` lists `T1` done; `git status` shows only `src/T1.txt`, the requirements file and the progress file; the invariant checker passes on the export.
2. **S-START-4** (slice 8): codex-only copy uses Codex, both-targets copy uses Claude; `--agent codex --model m-test --effort high --fast` reaches the transcript for this build only, config unchanged; `T2`'s builder and QA are new sessions; `build.started.settings` carries each value with `flag`, `project` or `default`; builder sessions writable, QA read-only.
3. **S-MAL-1** (slice 9): one repair request naming byte 4412, tools refused on it; accepted; `stats show` counts one malformed builder reply on that runtime.
4. **S-MAL-5** (slice 9): instructions name runs by short number, no hash ids; `check 3` accepted; `99`, a duplicate and a hash-like id sent back for a retry; the false claim logged as `facts.mismatch`, rafi's exit 1 is what QA sees, and the mismatch alone causes no retry.
5. **S-MAL-2 variant 1** (slice 9): the changed resend is rejected; nothing from it is applied; raw replies and errors kept in `stats show --run`; a `content` retry with the error sent back; `T1` finishes. Variants 2 and 3 marked `pending("M3")` (circling) and, for variant 2's blocked-ticket line, `pending("M6")`.
6. **S-MAL-4, the builder runs** (slice 9): missing field, wrong type, two finals, done with an invalid payload, a reply naming `T9` and another session, a transient failure, evidence for an unrecorded command, an edit outside the ticket's files. No format repair for any; each handled as SCN:392-396 says. The planner runs are `pending("M9")`.
7. **S-TIME-1** (slice 10): `hang` is cancelled after `timeouts.idle_minutes`, retried with backoff, `T1` finishes, exit 0, under a second of real time; during the backoff (`whenTimer("backoff")`) a second instance's `rafi status` says waiting on the provider with the retry number and next-try time; `slow(45m)` with activity isn't timed out.
8. **S-TIME-2** (slice 10): two transients then ok; four transients: after 3 retries `T1` stops with one line (what, why, a 1.0 command to continue); quota: no tight loop, one line naming the quota; login in a terminal: "<runtime> is not ready for … What should Rafi do?" with retry, switch, cancel, saying "Rafi"; switching states its scope and consequences; config unchanged.
9. **S-CHK-1** (slice 11): script A's claimed pass is ignored, rafi's failing run is recorded (command, exit, output, duration, tree), the ticket goes to `fixing`, no QA turn; script B's run has `asked_by: builder` and the turn gets run number, exit and output; `coverage/` written; the cache write lands in `.rafi/cache/`; QA's session is read-only, no QA copy.
10. **S-CHK-9** (slice 11), once per fake runtime: `rafi answer 1 1` and `curl …` refused and recorded with the reason given; `npx jest t1.test` runs; a network-trying test is denied by the (scripted) sandbox because no internet grant reaches `checks.run`; QA's run restores `src/index.js` (`restored`) and the review sees the builder's code; Codex reaches the tools through the endpoint, Claude in-process.
11. **S-CHK-10** (slice 11): no requirements file, no QA turn; required test plus related tests run; the fix message names both failing tests with file, error, excerpt, run number and `check_output`, and says keep the work; the fix passes; delivered.
11a. **S-CHK-11** (slice 11): with the scripted `checks.run` reporting the sandbox missing: the warning before any agent turn names what's missing and says tests can reach the internet and write outside the project; cancel exits 0 with no turn and no run; accepting runs with `sandbox: none` on every `check.run`, `curl` still refused, no internet or local-servers grant, the acceptance in the harness's `~/.rafi/grants.yaml` and in no tracked file; the next build doesn't ask; after revoking, a build without a terminal exits 1 before any turn with one line naming `checks.run_without_sandbox`; the setting accepts it unattended; `-y` accepts it with and without a terminal; with the sandbox available, no warning and `sandbox: os`.
12. **S-SCN-1** (slice 12): the no-commit repo stops with one line naming the first commit and the command; the ignored folder isn't read and rafi's snapshot work is under 2 s real time; heartbeat rows keep appearing during `slow(20m)` with 10 quiet minutes (the activity heartbeat, C58, not the lease's).
13. **S-SCN-14** (slice 12): six harmless reads fold to at most one quiet line; the real failure shows; error, timeout, cancellation and unknown have distinct labels; the duplicate result shows once; `TIME_ELAPSED` shows as unknown; each completion line names tool and call id.
14. **S-ENG-4** (slice 12): the incapable builder model is flagged before the first turn; no instruction asks Claude for an exit code; runs record "completed" apart from exit code; the structured-reply fallback is used and recorded (C52; setup as amended by P13: a builder model the provider doesn't list). The live-set step stays `pending("live")`.
15. **S-CLI-12, builds only** (slice 12): a short build and `rafi status` with and without a terminal under each color variable; color on labels only, on a terminal only; `rafi:` prefixes; a secret-looking token and control characters in a fake reply are redacted and escaped in the terminal and in `stats export`; exit 0 and 1. The rest (exit 2, Node 18, the skip variable) stays pending (M6, M10).
16. **S-CLI-2 step 2** (slice 7, an M1 test changed): the `-y`/`--yes` forms of `start` now run a build with the happy-path fakes and must not be refused as unknown options; `resume --yes` keeps the "not built (M4)" assertion.

### 3.2 Process set

17. **S-START-1** on the built launcher (slice 14), twice: `harness.targets: [codex]` with `codex-cli.mjs`, and the default with `claude-cli.mjs`. The fakes apply ordered rules (P8 is still deferred; one ticket needs no per-ticket match, C50). In the Codex run, the fake builder calls `run_check` over the real HTTP endpoint with the token from its thread config; the real `deps.checks.run` runs `npm test` under the real sandbox.
18. **S-ENG-5 step 3** (slice 14): during the build, the fake provider records a `ps` snapshot of its ancestry; the tree has one `rafi` process plus provider and check processes, and no child `rafi` or `ai-foreman`. Skipped on Windows, as D5 does.

### 3.3 Engine, spec and harness tests (each before its module)

19. Reply schemas: every example in ARCH 6.2–6.4 validates; each field rule rejects (extra field such as a ticket id, wrong type, nested union); the Codex projection makes every property required and nullable.
20. `classify` table: every `AgentEvent` terminal kind and provider code to its category (5.1–5.2), unknown → `provider`.
21. Repair: the template text; accept only when the resend parses, validates and keeps every recovered path; cut-off replies may only fill what was lost; no readable JSON → `content`; tools refused during repair on both adapters.
22. Runner: backoff delays and jitter on the fake clock; every retry's message differs from the last (NEW-RTY-1); idle timeout cancels, waits up to 30 s for confirmation, then ends the provider; boundaries 1–3 called with their names.
23. Facts: tree id equals `git write-tree` of the same content; changed files; ignored folders skipped; temp index never touches the real one.
24. Check step: staleness by related files; reuse of fresh runs; `timed-out` after 2 quiet minutes is a failure; `too-slow` at 5 minutes isn't and blocks only that ticket (`blocked(limit)` through M1's transition; the question and leaving it are M6; C59, P16); `changed-code` names files; QA restore.
25. Endpoint and tools: the MCP handshake, `tools/list`, `tools/call`; token, Host and Origin checks; closed at session end.
26. Adapter fidelity (extends M1's): grants mapping per role, effort and fast, MCP attachment, usage latest and total, permission routing, `AskUserQuestion`, the S-SCN-14 tool shapes; the same `AgentEvent` sequence from the in-process and executable fakes of each runtime.
27. Harness: the clock fix (heartbeat timers fire on the way to an agent timer), `whenTimer`, `rafi.start`, the scripted checks runner, role happy paths.
28. No sandbox (C60): `build/sandbox.ts` reports `missing` with the reason for each case (no `bwrap`, namespaces blocked, `win32`); `build/sandbox.ts`'s acceptance decision (saved acceptance, config setting, auto-approve, terminal prompt, stop) for every combination of terminal, `-y`, setting and saved entry; the prompt, its two choices and their records; reading, writing and removing the `~/.rafi/grants.yaml` entry through `deps`; the security rows in section 4. Slice 6; the scripted `checks.run` gains a `sandbox: missing(reason)` setting.

## 4. Security tests

ARCH 1.2 and M2's security line (`REWRITE_ARCHITECTURE.md:1647`). M2 is the main pass, because agents first act here. The implementer writes a one-page threat-model note for `run_check`, `check_output` and the endpoint into this plan's section 10 before building them, and each row below is a test.

| Threat | Test |
|---|---|
| Commands through `run_check` | Refused and recorded `refused` with a reason: `rafi answer 1 1`, `rafi stop`, `curl https://example.com`, `sh -c "npm test"`, `npm test; rm -rf /`, `npx jest a.test && curl x`, `npx jest $(curl x)`, backticks, a path outside the worktree (`../../x`, `/etc/passwd`), a runner option not on the file-or-test-name list. Commands are split into argv and spawned without a shell. |
| Agent-written checks | The requirements file's `check` commands pass the same rules when the prepare step writes them (ARCH 6.9, `REWRITE_ARCHITECTURE.md:948`, added by P15; choice C43): a prepare reply with `curl …`, `sh -c …`, `npm test; rm -rf /` or an unknown program as a `check` is a `content` error, the prepare turn is retried, and no file is written. |
| Network beyond grants | Real sandbox (1.2 probes): public connect denied with no grant; loopback only with `local-servers`. Scripted: no internet grant ever reaches `checks.run` in M2. |
| Writes outside the project | Real sandbox: `$HOME` and paths outside the project denied; caches and `TMPDIR` under `.rafi/cache/`. |
| No sandbox on this machine (C60, S-CHK-11) | With the scripted `checks.run` reporting `missing`: the warning appears before any agent turn, names what's missing and says tests can reach the internet and write outside the project; "Cancel" exits 0 and no agent turn or check runs; accepting runs the checks with no sandbox prefix, still refuses `curl …` and shell strings through `run_check`, keeps the permission policy, cache variables and QA restore, and records `sandbox: none` on every `check.run`. The warning never appears when the sandbox is available, and then every run records `sandbox: os`. |
| Accepting without a person (C60, S-CHK-11) | Without a terminal and with no saved acceptance, no `checks.run_without_sandbox` and no auto-approve: exit 1 before any agent turn or `run_check`, one line naming the setting, no open question. `checks.run_without_sandbox: true`, `-y` and `approvals.mode: auto` each accept it; a non-boolean value for the setting exits 1 naming the key. |
| The remembered acceptance (C60, S-CHK-11) | Saved in `~/.rafi/grants.yaml` under this project's path only: another project on the same machine is still warned; nothing about it is written to `.rafi/progress.yaml` or any tracked file (`git grep` finds nothing); no `grant.recorded` for `internet` or `local-servers`; removing the entry makes the next build warn again (or stop, unattended). An unreadable or malformed `grants.yaml` counts as "not accepted": the warning is asked (or the build stops, unattended), never skipped. |
| QA changes code | A QA `run_check` that edits a tracked file: the file is restored from the snapshot and `restored` recorded; QA's agent session is `readOnly` on Codex and has no write tools on Claude. |
| Another program calls the endpoint | Bound to 127.0.0.1 (checked from the server's address); no token, a wrong token, another session's token, a `Host` other than `127.0.0.1:<port>`, or any `Origin` header (a browser, DNS rebinding) → 401/403 and nothing runs; the port refuses connections after the session closes; tokens compared in constant time. |
| The token leaks | The token never appears in an event, a blob, the terminal, a child's argv or `stats export` (the redactor knows it, C39); with the 1.1 fallback it's only in the app-server's environment. |
| An agent writes rafi's state | The permission policy refuses edits under `.rafi/` and `.tickets/`, `rafi answer`/`stop` in shell requests, and every tool in a repair turn, on both runtimes, through the same code path. |
| Edits outside the ticket | An edit to a file outside the ticket's allowed files is refused with the file named (S-MAL-4). |
| Instructions hidden in data | Test output with "ignore previous instructions", a fake `rafi` command and ANSI escapes reaches the builder's fix message only inside a fenced, quoted block, escaped and redacted; `check_output` returns redacted text. |
| Secrets | A token in a reply, in activity and in test output is stored redacted (M1's `redact()` now also sees check output and replies). |

## 5. Order of work

**The red-run rule (test-first).** M1 wasn't fully test-first (`REWRITE_M1_PLAN.md` D7). In M2, for each slice: write its tests and scenarios; run them; save the run to `.rafi-build/M2-red/<slice>.log` (ignored by git); check that each new test fails **on the assertion the slice is about** (a scenario that only fails with "isn't in the new engine yet" doesn't count, so write each scenario after the previous slice, when it can get that far); only then add the slice's production code; then run green and keep the fast suite and `check-rules` green. The milestone report lists each slice with its red log and first failing assertion. Large output goes under `/private/tmp` and is searched, not printed (AGENTS.md).

| # | Slice | Tests first | Then build |
|---|---|---|---|
| 0 | Unverified items | Item 25's handshake, token, `Host` and `Origin` tests; the 1.2 probe test (section 1's preflight) | The minimal seams (`deps/types.ts` changes, `tools/mcp.ts` with tool definitions only, `deps/real/serve.ts`, `build/sandbox.ts`, `deps/real/checks.ts`), the CI step and `scripts/live/rewrite-codex-mcp.mjs` (2.5); then section 1.1 Part A, 1.2 (macOS), 1.3 (rafi's and Codex's). Record results. Ask the user for live authorization (1.1 Part B, 1.4) |
| 1 | Spec | 3.3 item 19; config and ticket schema tests | `spec/src/v1/replies.ts`, `config.ts`, `tickets.ts`, `delivery.ts`, `progress.ts` |
| 2 | Harness | Item 27 | Clock fix, `whenTimer`, `rafi.start`, fixtures F-TESTS-LOCAL and F-HUGE, scripted checks, in-memory endpoint, script behaviors and role happy paths |
| 3 | Adapters | Item 26 | `agents/*` complete, `capabilities.ts`, `permissions.ts`, `shellForms.ts`, `readiness.ts` |
| 4 | Turn runner | Items 20–22 | `turns/*` |
| 5 | Facts | Item 23 | `facts/*` |
| 6 | Checks and tools | Item 24; item 25's `tools/call` and session-close tests; item 28; section 4's `run_check`, endpoint, sandbox and no-sandbox rows | `build/checks.ts`, `run_check`'s rules and executor, `check_output`, `tools/session.ts`; the rest of `tools/mcp.ts`, `deps/real/checks.ts` (streaming, abort) and `deps/real/serve.ts` |
| 7 | One-ticket build | S-START-1; S-CLI-2 step 2 change | `build/loop.ts`, `steps/*`, `instructions/*`, `progress/write.ts`, `tickets/load.ts`, `stats/export.ts`, `api` start, `commands/start.ts`, `tickets/show.ts`, `ui/activity.ts` |
| 8 | Agents and settings | S-START-4 | Config layers and sources, agent resolution (C34), sessions (C35) |
| 9 | Malformed and references | S-MAL-1, S-MAL-5, S-MAL-2 v1, S-MAL-4 builder | Wire `repair.ts` and `facts.mismatch`; `stats/show.ts` |
| 10 | Timeouts and provider errors | S-TIME-1, S-TIME-2 | `commands/status.ts`, `ui/prompts.ts`, quota and auth handling (C46) |
| 11 | Checks end to end | S-CHK-1, S-CHK-9, S-CHK-10, S-CHK-11 | Fix after a failed check, `--no-qa`, failure details |
| 12 | Edges and output | S-SCN-1, S-SCN-14, S-ENG-4, S-CLI-12 partial | `ui/colors.ts`, `ui/lines.ts`, capability flags |
| 13 | Security | Remaining section 4 rows | Fixes they find |
| 14 | Process set | 3.2 items 17–18 | Process fakes' ordered happy path, `ps` snapshot |
| 15 | Gate | — | Fast suite < 60 s on 4 workers; `check-rules` clean; process set green; Linux sandbox result from CI (after the user pushes); `scripts/live/rewrite-adapters.mjs` and the live check (1.4) if authorized; report |

## 6. Implementation choices the docs leave open

Numbered after M1's C1–C32.

| # | Choice | Why |
|---|---|---|
| C33 | A role's reply schema is a map keyed by step (`qa: { prepare: "requirements", review: "verdict" }`); `standard` is unchanged | ARCH 6.1 "one schema per role and step"; QA has two |
| C34 | Agent per role: `--agent` (this build) → `agent_defaults.roles.<role>.make` → the single `harness.targets` value → `claude`. `roles.ts`'s builder default `codex` is corrected | FLAG-ST-R5 (`REWRITE_REQUIREMENTS.md:240`); S-START-4 step 2 |
| C35 | One session per ticket, role and reply schema: prepare has its own QA session; the builder's session carries build, fix and repair turns; QA's review session carries review rounds and repairs | ARCH 11.2 allows reuse only within a ticket; Claude's `outputFormat` is fixed per session (fact table) |
| C36 | Codex gets the endpoint through `thread/start`'s `config.mcp_servers.rafi`; if 1.1 fails, the `-c` fallback with the token in `bearer_token_env_var`, never in argv | Handoff table; `ps` shows argv to every local user |
| C37 | The endpoint speaks a minimal MCP over HTTP POST with JSON responses (`initialize`, `tools/list`, `tools/call`), in one handler shared by the real server and the harness; switches to `@modelcontextprotocol/sdk` if 1.1 shows Codex needs more | No new dependency unless needed; one handler for both modes |
| C38 | New seam `deps.agents.claudeTools(name, tools)`: real → the SDK's `createSdkMcpServer`; harness → a plain object the fake calls | The engine doesn't import the SDK statically (it's optional, loaded in `deps/real/agents.ts`) |
| C39 | `deps.random.secret()` gives 32 random bytes (real: `node:crypto`; harness: seeded); the redactor registers each session token | Tokens must not be guessable or leak (1.2) |
| C40 | `build/sandbox.ts` turns grants into a pure argv prefix; `deps/real/checks.ts` only spawns it. macOS: a `sandbox-exec` profile (allow by default; deny file writes except the worktree, `.rafi/cache/` and `/dev`; deny network except loopback with `local-servers`, all with `internet`). Linux: `bwrap` (read-only root, the worktree and cache bound writable, private `/tmp`, `--unshare-net` without internet, `--die-with-parent`) | ARCH 6.9; keeps `deps/` near its budget |
| C41 | Test environment: `npm_config_cache`, `YARN_CACHE_FOLDER`, `XDG_CACHE_HOME`, `TMPDIR` under `.rafi/cache/` | ARCH 6.9 "caches … at `.rafi/cache/`" |
| C42 | `checks.test_runner`, when unset, comes from `package.json` (`<package manager> test --`, the manager from the lockfile), recorded with source `default` | ARCH 5.6 says `rafi create` finds it; `create` is M10 and F-ONE has none |
| C43 | The prepare step checks each requirement's `check` against `run_check`'s rules (one command, no shell syntax, program the test runner, a `package.json` test script or the setup script); a failure is a `content` error, retried | ARCH 6.9 (`REWRITE_ARCHITECTURE.md:947-948`), as amended by P15 (approved and applied); section 4's "Agent-written checks" test is required |
| C44 | Related tests: Jest-style `--listTests --findRelatedTests <files>` for `jest` and `fake-test`; any other runner has no related query, so any change makes its results stale | ARCH 6.9's own fallback; `vitest related` is unverified until implemented |
| C45 | Deliver with completion `none` on the current branch writes no git state; it records `delivery.done` with the validation summary | S-START-1 "F-ONE leaves git to you"; commits are M5 |
| C46 | Login and an unknown-reset quota in M2: a terminal prompt (retry, switch, cancel) recorded as `question.opened` and `question.answered` (kind `runtime`, source `terminal`); without a terminal, exit 1 with one line, as PRM-16 says non-interactive runs fail instead of switching. A known reset within `retries.quota_wait_hours` waits on the clock and retries once | ARCH 5.1; the full question record is M6 |
| C47 | M2 takes and releases the lease (`build.owner_acquired`/`released`) without refreshing `lease.heartbeat_at`; the lease heartbeat and liveness views are M4. This is not the activity heartbeat of the terminal rows (C58), which M2 builds | `log/lease.ts` exists, `heartbeat()` at `:53` has no caller; M4 builds "the lease and liveness" (ARCH:1659) |
| C48 | `rafi status` in M2 derives "waiting on the provider" (retry n, next try) from `turn.retry`'s `at` and `delay_ms`, and "working / quiet / stalled" from the last activity time | ARCH 8.10; no lease heartbeat yet |
| C49 | Fake clock `whenTimer(kind, fn)` runs a scenario step when a timer of that kind is armed, before the clock moves to it | S-TIME-1's "while waiting" without racing |
| C50 | Process-mode fakes answer in rule order per executable; S-START-1 runs codex-only and claude-only, so no per-ticket matching is needed. P8 stays deferred until before M4 | P8 (`REWRITE_M1_PLAN.md` section 8) |
| C51 | The process-tree check is a `ps` snapshot the fake provider records while its turn runs | No harness polling race |
| C52 | Capabilities per model: from the provider's model list where it reports the feature (effort, fast); otherwise from a small per-runtime table in `agents/capabilities.ts`; a model the provider doesn't list is flagged before the build with conservative capabilities (no structured replies) and uses the text-JSON fallback, recorded in `turn.intent.schema` as `<schema>+text` | P13 |
| C53 | M2's standing instructions: the role core from `.rafi/compiled/<role>/system.md` when present, else `special-agents`' role text; then the runtime contract and the reply format. The rewrite of role text is M10 | ARCH 10.2; M10 |
| C54 | `tickets/load.ts` ports only the read and validation side of today's ticket files; the commands are M5 | ARCH 14 M5 |
| C55 | Requirements files at `<docs.root>/requirements/<ticket>.md`, `docs.root` default `docs` | Q-REQ-2; today's `DEFAULT_DOCS_ROOT` (`ai-foreman/src/tickets/config.ts:69`) |
| C56 | Harmless failed reads: Claude `Read`, `Glob`, `Grep`, `LS` results that are errors and say a path wasn't found; folded to one quiet line per turn | ARCH 8.4 |
| C57 | Red-run logs in `.rafi-build/M2-red/` | Evidence for the review without commits |
| C58 | Activity heartbeat rows (OUT-8): while a turn runs, `ui/activity.ts` arms `deps.clock.timer(30_000, …, "heartbeat")` and, each time it fires with no new activity since the last row, prints a timestamped heartbeat row naming the role, ticket and how long it's been quiet (wording ported from today's activity module). Terminal only; nothing is written to the log. S-SCN-1's `slow(20m)` with 10 quiet minutes shows a row every 30 s of fake time (the clock fix fires heartbeat timers on the way to the agent timer) | OUT-8 "heartbeat" is keep (`REWRITE_REQUIREMENTS.md:638`); M2 builds "activity rows" (ARCH:1646); today's default `heartbeatMs` is 30 s (`ai-foreman/src/activity.ts:70`). Audit finding 6 |
| C60 | No sandbox on this machine (the user's decisions 1–5, 2026-11-02; section 1.2). Before the first agent turn, `build/sandbox.ts` reports `available` or `missing` with what's missing (no `bwrap`, user namespaces blocked, native Windows), then decides, in this order: (a) a saved acceptance for this project in `~/.rafi/grants.yaml` (read and written through `deps.fs` under `deps.machine.stateDir`, entry `run_without_sandbox` with the date, keyed by the project's path like an "always" grant) accepts it; (b) `checks.run_without_sandbox: true` in `rafi-config.yaml` accepts it (the key name fits the `checks.*` group of ARCH 15, `:1602`; boolean like `checks.ci_blocks_merge`, default `false`; source `project`); (c) auto-approve (`--auto-approve`, `-y`, `--yes`, or `approvals.mode: auto`, ARCH 7.4) accepts it, terminal or not; (d) in a terminal, a prompt (the C46 mechanism, recorded as `question.opened`/`question.answered`, kind `runtime`) says what's missing and that tests can then reach the internet and write outside the project, with "Run tests without a sandbox" and "Cancel"; Cancel exits 0, a cancelled prompt (ARCH 8.8, OUT-40); (e) otherwise the build stops before any agent turn, exit 1, with one line: "rafi: this machine has no sandbox for tests (<what's missing>); set checks.run_without_sandbox: true in rafi-config.yaml to run them without one". No open question is left. An acceptance by (c) or (d) is saved as in (a) and printed as one line; (b) isn't copied to `grants.yaml`. Revoking is removing that entry from `~/.rafi/grants.yaml`, the same as an "always" grant; there is no revoke command (decided 2026-11-02). Because `rafi-config.yaml` is committed, (b) accepts the warning project-wide, for every machine that clones the project, unlike a saved acceptance, which stays on one machine (decided 2026-11-02). Accepted runs spawn with no prefix; the allowlist, the permission policy, the cache and `TMPDIR` variables (C41), QA restore and `changed-code` still apply; each `check.run` records `sandbox: none` (`os` otherwise), and `build.started.settings` records `sandbox: none` with source `saved`, `project`, `auto-approve` or `terminal`. No `grant.recorded` and no internet or local-servers grant. In M7 the same decision becomes the upfront check's no-sandbox item (ARCH:1679), keeping (b), (c) and (e) ahead of 7.5's open-question rule | User decisions 2026-11-02; ARCH 6.9 (`:950`), 7.4, 7.11, 8.8; REQ NEW-SEC-4; SCN S-CHK-11; P17, P18 |
| C59 | A `too-slow` check run in M2 is recorded, isn't a failure, and moves only that ticket to `blocked(limit)` through M1's existing transition (`state/ticket.ts:163-164`), with one block line naming the limit and the run's duration; the `limit` question and answering it are M6, the upfront limit item is M7. No M2 must-pass scenario reaches it (S-CHK-4 is M7, ARCH:1681); item 24 tests it | ARCH 6.9 (`:958`) and 6.11; the M2/M6 wording is P16 |

## 7. Problems found in the locked docs

P13–P18 were **approved by the user and applied on 2026-11-02**, as small edits that do exactly what each suggested fix said (P17 and P18 filled in with the user's no-sandbox decisions 1–5, section 1.2); nothing else in the locked docs changed. Applying P18 also changed the ledger test's totals (`scenarios/test/ledger.test.ts`: 122 scenarios, 120 outside M1, 639 requirement IDs) and regenerated `scenarios/checks/registry.ts`.

| # | Problem | Evidence | Suggested fix | Status |
|---|---|---|---|---|
| P13 | S-ENG-4 expected the fake's "model reports no structured replies", but neither provider reports structured-output support per model, so there was no real source for that capability | SDK `ModelInfo` has effort, adaptive thinking and fast mode only (`sdk.d.ts:1183-1211`); Codex 0.164 `model/list` `Model` has no such field | ARCH 11.6: capabilities come from the provider's model list where it reports a feature, otherwise from rafi's per-runtime table, and an unlisted model is flagged. SCN S-ENG-4 setup: "a builder model the provider doesn't list". Choice C52 implements this | **Applied:** `REWRITE_ARCHITECTURE.md:1509` (new bullet "Where capabilities come from"); `REWRITE_SCENARIOS.md:1334` |
| P14 | M2's loop said "review that passes" and M3 built "skipping QA when a check fails and the related tests per ticket", but M2's must-pass S-CHK-1 and S-CHK-10 need the fix after a failed check and the related tests | `REWRITE_SCENARIOS.md:1027,1131-1133` | Move that M3 item into M2's build list; M3 keeps the QA-rejection loop | **Applied:** `REWRITE_ARCHITECTURE.md:1645` (M2 gains "the fix step after a failed check, counted against `retries.fixes`, and the related tests per ticket (6.9, 6.10)"); `:1653` (M3's item removed; "reject, fix and re-review" and `retries.fixes` stay) |
| P15 | `run_check` accepted "the requirements file's check commands" as written, and QA (an agent) writes them, so an agent could put `curl …` in the file | `REWRITE_ARCHITECTURE.md:842` (example check), `:82` (threat row), `:1646` (security line) | Add to 6.9 the check of each `check` when rafi writes the file; make `run_check`'s acceptance rule consistent. Choice C43 | **Applied:** `REWRITE_ARCHITECTURE.md:947` (acceptance rule now says each check was checked when rafi wrote the file) and `:948` (new bullet "Checks in the requirements file") |
| P16 | The test time limits are split inconsistently. M2 builds "the time limits (6.11)", but 6.11 is mostly the `limit` question, and M6 builds "the `limit` question and `blocked(limit)` (6.11)". M2's own time limits are 6.9's (`timed-out`, `too-slow`); and S-CHK-4, the slow-test scenario, is M7 | `REWRITE_ARCHITECTURE.md:1645` (M2), `:1672` (M6), `:957` (6.9's limits), `:989-994` (6.11), `:1680` (S-CHK-4 in M7) | M2: "the time limits (6.9: `timed-out`, `too-slow`, and a too-slow ticket going to `blocked(limit)`)"; M6: "the `limit` question and leaving `blocked(limit)` (6.11)". Choice C59 builds M2's part either way | **Applied:** `REWRITE_ARCHITECTURE.md:1646` (M2: "the time limits (6.9: `timed-out`, `too-slow`, and a too-slow ticket going to `blocked(limit)`)"); `:1673` (M6: "the `limit` question and leaving `blocked(limit)` (6.11)"). 6.9's time-limit bullet (now `:958`) unchanged; the fix didn't touch it |
| P17 | The user's decision (tests run without a sandbox after a warning, on machines that have none) contradicts locked text that says test runs are always sandboxed and grants are always enforced | ARCH 1.2: "What's protected … your machine (network, files outside the project)" (`REWRITE_ARCHITECTURE.md:77`); threat rows "An agent runs commands through rafi … an OS sandbox matching the build's grants" (`:82`) and "Network beyond what you granted … rafi's own [sandbox]" (`:84`); 6.9 "Rafi runs the command … under an operating-system sandbox that matches the build's grants" (`:949`); 7.11 "`run_check` runs under rafi's own sandbox with the same grants" (`:1150`); REQ NEW-CHK-14 "Runs use an operating-system sandbox matching the build's grants" (`REWRITE_REQUIREMENTS.md:1049`); NEW-SEC-1 "no network beyond the grants" (`:1061`); `check.run` has no field saying a run was unsandboxed (`REWRITE_ARCHITECTURE.md:316`) | Add to 6.9: "If rafi can't start a sandbox on this machine (no bubblewrap, a kernel that blocks it, native Windows), it warns before the first agent turn, naming what's missing and that tests can then reach the internet and write outside the project. After you accept, `run_check` runs without the OS sandbox; the allowlist, the permission policy, the cache variables and QA's restore still apply." Qualify 1.2's two rows, 7.11, NEW-CHK-14 and NEW-SEC-1 with "where the machine has a sandbox (6.9)". Add `sandbox: os \| none` to `check.run`. The answers to questions 1–4 fill in the warning's details | **Applied:** `REWRITE_ARCHITECTURE.md:950` (new 6.9 bullet "No sandbox on this machine", with decisions 1–5 and the key `checks.run_without_sandbox`); qualified with "where the machine has a sandbox": `:77`, `:82`, `:84`, `:949`, `:1151`; `:316` (`check.run` gains `sandbox: os \| none`); `REWRITE_REQUIREMENTS.md:1049` (NEW-CHK-14), `:1061` (NEW-SEC-1) |
| P18 | The no-sandbox path has no requirement, no scenario and no milestone. Nothing in SCN expects a refusal (no scenario covers a machine without a sandbox at all), but S-CHK-9 says "A test that tries the network is denied by the sandbox" with no machine condition, and M2's security line says the sandbox blocks the network when it isn't granted | `REWRITE_SCENARIOS.md:1122` (S-CHK-9); `REWRITE_ARCHITECTURE.md:1646` (M2 security line), `:1645` (M2 builds "which OS sandbox `run_check` uses"); `REWRITE_REQUIREMENTS.md` 8.25 (no row); no `S-*` scenario mentions a missing sandbox (searched SCN for "sandbox") | Add a requirement row in REQ 8.25 for the warning and its effects; add a scenario (for example S-CHK-11, "No sandbox on this machine": the warning before any turn, cancel exits 1 with nothing run, accept runs tests unsandboxed and records it, the allowlist still refuses `curl`, plus the no-terminal and auto-approve cases once questions 1–2 are answered) to M2's must-pass list; qualify S-CHK-9's network line and M2's security line with "where the machine has a sandbox". If the warning should live in the upfront check, M7 also gets "the no-sandbox item" | **Applied:** `REWRITE_REQUIREMENTS.md:1064` (new NEW-SEC-4); `REWRITE_SCENARIOS.md:1135-1153` (new S-CHK-11), `:1122` (S-CHK-9 qualified), `:2273` (coverage row), totals `:9`, `:1589`, `:1591` (122 scenarios, 41 from the decided sections, 623 of 639 IDs; 16 not testable, unchanged); `REWRITE_ARCHITECTURE.md:1647` (M2 security line qualified), `:1648` (S-CHK-11 in M2's must-pass list), `:1679` (M7 gets "the no-sandbox item (6.9)", decision 5) |

P8 (process fakes and `meta`) stays deferred until before M4; M2 doesn't need it (C50).

## 8. Risks and what I couldn't check

- **None of section 1 has run.** This plan wrote no code and ran no probe; 1.1–1.3's results are unknown until slice 0.
- **Linux sandbox:** `bwrap` isn't on this machine, and Ubuntu 24.04's user-namespace restriction may stop it in CI. Unverified until the user pushes and the workflow runs.
- **Codex's MCP client details** (header support, SSE): unverified until 1.1 Part A.
- **Claude's loopback** (`allowLocalBinding`) needs a paid live turn; until the user authorizes 1.4 it's unverified, and the capability defaults to `false`.
- **Fast-suite time:** writing F-HUGE's 20,000 files per run may take about a second; if the suite nears 60 s, build it once per suite run in a shared temp folder and clone with `git worktree` or hard links.
- **`deps/` budget** (650) is tight (C40 keeps the sandbox logic out of it).
- **`vitest related`:** not checked; C44 falls back to "any change is stale".
- **Commands printed to continue** (S-TIME-2) name `rafi resume`, which is built in M4; the scenario checks the line by content (SCN 1.1).

## 9. Audit (part 2): findings and what changed

From `.rafi-build/M2-audit.md`. Section 10 ("Implementation: results and choices made while building") is the implementer's.

| # | Finding | What changed |
|---|---|---|
| 1 | High: slice 0's "ship-exact" probes need `tools/mcp.ts`, `deps/real/serve.ts` and the real `deps.checks.run`, which were scheduled in slice 6; both deps still throw | **Applied.** Slice 0 now builds those seams test-first at their final paths, then runs the probes (section 1 preamble, 1.1, 1.2; section 5 rows 0 and 6). Probes stay first, as ARCH:1645 and the handoff ask |
| 2 | High: QA-written checks could authorize `curl` through `run_check` while P15 was unapproved | **Resolved by P15** (approved and applied, `REWRITE_ARCHITECTURE.md:947-948`). C43 is unconditional and section 4's "Agent-written checks" test is required |
| 3 | High: the check-failure fix loop and related tests were M3's in the locked plan, though M2's scenarios need them | **Resolved by P14** (`REWRITE_ARCHITECTURE.md:1645,1653`); section 0 updated |
| 4 | Medium: S-ENG-4's capability setup had no provider-backed source | **Resolved by P13** (`REWRITE_ARCHITECTURE.md:1509`, `REWRITE_SCENARIOS.md:1334`); C52 and section 3.1 item 14 cite the amended setup |
| 5 | Medium: the `limit` question was called M7 in one place and M6 in another; the locked docs split 6.11 between M2 and M6 | **Applied to the plan:** section 0 now says M6 (ARCH:1672), with the upfront limit item and S-CHK-4 in M7; C59 scopes M2 to recording `timed-out` and `too-slow` and moving a too-slow ticket to `blocked(limit)`. **Locked-doc wording:** P16 |
| 6 | Medium: S-SCN-1's heartbeat rows had no M2 producer; C47 deferred "heartbeat" to M4 | **Applied to the plan, no locked-doc change:** the rows are OUT-8's activity heartbeat, which M2 builds with "activity rows" (ARCH:1645; `REWRITE_REQUIREMENTS.md:638`); only the lease heartbeat is M4 (ARCH:1659). New C58 (a 30 s `heartbeat` timer in `ui/activity.ts`, today's default at `ai-foreman/src/activity.ts:70`); C47, C48 and section 3.1 item 12 now say which heartbeat |
| 7 | Low: section 2 omitted the live scripts, the real sandbox test and the CI change | **Applied:** section 2.5 lists all four with slice and budget |

## 10. Implementation: results and choices made while building

Written by the implementing session, 2026-11-02. Not committed. Logs: red runs in `.rafi-build/M2-red/<slice>.log`; final runs `/private/tmp/m2-final-fast.log`, `/private/tmp/m2-final-rules.log`, `/private/tmp/m2-process.log`.

### 10.1 Section 1 results

| Check | Result | Fallback |
|---|---|---|
| 1.1 Part A (no model turn) | **Works.** `thread/start` with `config.mcp_servers.rafi = {url, http_headers: {Authorization: "Bearer <token>"}}`; two ephemeral threads each reached their own endpoint with their own token (`initialize`, `notifications/initialized`, `tools/list`, `resources/list`, `resources/templates/list`); status `connected`, tools `run_check`, `check_output`, `authStatus: bearerToken`. C37's minimal JSON-over-POST handler is enough (no SSE, no session header). `/private/tmp/m2-codex-mcp-A.log` | None needed (not the `-c` fallback) |
| 1.1 Part B (one model turn) | **Works** (2026-11-03, after fixing the missing `initialize`, 10.8 L1): one real gpt-5.6-luna turn called `run_check` through the endpoint with the session token on every request. 10.8 row a | — |
| 1.2 macOS | **Works:** `sandbox-exec`. Worktree, `coverage/`, `.rafi/cache/` writable; `npm test` passes with the cache vars, no EPERM; `$HOME` and outside the project denied; child process, worker, reads allowed; public TCP connect → `EPERM` at once | — |
| 1.2 Jest-shaped row | **Not checked on the real sandbox** (needs a Jest-shaped executable); per-test parsing is tested on the scripted runner | — |
| 1.2 Linux (bwrap) | **Unverified:** no `bwrap` here; CI step added to `.github/workflows/rewrite-fast.yml`, runs when the user pushes | — |
| 1.3 rafi's sandbox | **Works on macOS**, after a fix the probe found: `(allow network* (local ip "localhost:*"))` let public connects through. Now `network-bind`/`network-inbound` on local `localhost` plus `network-outbound` to remote `localhost`: loopback works, public denied. No grants: loopback listen `EPERM` | — |
| 1.3 Codex's sandbox | **Can't separate them** (`codex sandbox`, 0.164.0): network off denies loopback listen; on allows public. `-c network.allow_local_binding`, `sandbox_workspace_write.allow_local_binding`, `features.network_proxy` changed nothing | `capabilities().localServersWithoutInternet: false` for Codex (M7's upfront item will say so) |
| 1.3 Claude's sandbox | **Works** (2026-11-03, Claude Code 2.1.317, macOS): `allowLocalBinding` with no allowed domains allows loopback listen and connect, and a public connect still gets EPERM. Without it, loopback listen gets EPERM. 10.8 row b | `claudeCapabilities().localServersWithoutInternet` is now `true` |
| 1.4 live adapter check | **Run** (2026-11-03, authorized, 12 real turns): `scripts/live/rewrite-adapters.mjs`. Results in 10.8 | — |

### 10.2 Red runs (test-first) per slice

| Slice | Red log | First failing assertion | Notes |
|---|---|---|---|
| 0 | `0.log` | MCP: status 501 vs 200; sandbox prefix `no -p`; real probes failing | One real-probe row passed vacuously on the stub |
| 1 | `1.log` | `checkReply` ok false; `SETTING_DEFAULTS` empty | Two reject tests passed vacuously on an always-reject stub |
| 2 | `2.log` | all 9 harness tests | — |
| 3 | `3.log` | all 10 fidelity tests | — |
| 4 | `4.log` | all 11 runner tests | — |
| 5 | `5.log` | 3 of 4 | The real-index test passed vacuously on the stub |
| 6 | `6.log` | all 15 (session, no-sandbox, checks) | — |
| 7 | `7.log` | S-START-1: transcript empty (after the CLI dispatch and an empty `start`) | S-CLI-2's changed step had no meaningful red: the stub already exited 0 |
| 8 | `8.log` | **None:** S-START-4 passed first run | Written after slice 7 built what it tests |
| 9 | `9.log` | `stats show` not built; check 99; claim; two finals (Claude); unknown evidence; refused-edit line | S-MAL-1's repair steps and 5 of 6 S-MAL-4 runs passed first run (the runner was built test-first in slice 4) |
| 10 | `10.log` | `rafi status` liveness; the login switch | Re-run after fixing a deadlock in my test (a step nested in a step). Hang/backoff, transient, four-retries and quota steps passed first run |
| 11 | `11.log` | Codex S-CHK-9 (401: the harness endpoint didn't lowercase headers); S-CHK-11 step 2 (test bug) | S-CHK-1, S-CHK-10, most of S-CHK-11 and Claude S-CHK-9 passed first run (built in slices 6–7) |
| 12 | `12.log` | S-ENG-4 flag; S-CLI-12 colors | S-SCN-1 and S-SCN-14 passed first run |
| 13 | `13.log` | the token reached the terminal unredacted; test errors unfenced in the fix message | Real fixes (below). The agent-written-checks test passed first run |
| 14 | `14.log` | build failed (type errors), then the MCP log and ps-snapshot assertions | — |

Where test-first wasn't followed: scenarios S-START-4, S-SCN-1, S-SCN-14 and many steps of slices 9–11 were written after the code that satisfies them (it came from earlier slices' unit-level work), so they were never seen failing. Every new module had a unit test seen failing first.

### 10.3 Choices made while building

| # | Choice | Why |
|---|---|---|
| C61 | "A file outside the ticket's allowed files" (S-MAL-4) = outside the worktree or in rafi's own folders (`.rafi/`, `.tickets/`, `.git/`); `likely_files` is not enforced | `likely_files` are likely, not exhaustive; enforcing them would refuse test files |
| C62 | A 1.0 project whose log has no project yet: `start` records `project.created` and `tickets.changed` (each ticket `added`), which ARCH 4.4 maps draft → ready | See 10.4, P19 |
| C63 | `.rafi/.gitignore` = `*` and `!progress.yaml`: only the progress file shows in `git status` | S-START-1's git expectation |
| C64 | A build that finishes with work left (a blocked ticket) exits 1 | ARCH 8.8 lists 0 only for success |
| C65 | `deps.checks.sandbox()` returns raw facts; `build/sandbox.ts` decides (`sandboxInfo`); `CheckRun` carries both the grants and C40's prefix | Keeps `deps/` at the bottom of the dependency graph |
| C66 | `check.run` gains `refused` (the reason) and `sandbox: os \| none` (ARCH:316) in rafi-spec | The record needs the reason given to the agent |
| C67 | The builder citing a run rafi never recorded is a `facts.mismatch`, not a retry; QA's unknown, duplicate or non-integer references are content errors | S-MAL-4 vs S-MAL-5's wording |
| C68 | The fake clock fires every timer on the way to an auto timer **except reminders** | Keeps M1's "never to a reminder" test unchanged (plan item 27 said every timer) |
| C69 | Process-mode fakes share a rule cursor file across provider processes (one per session) | C50's ordered rules with a fresh session per role and step |
| C70 | Standing instructions use a short built-in core per role when `.rafi/compiled/<role>/system.md` is absent (not `special-agents` text) | C53's rewrite of role text is M10 |
| C71 | `start` with no tickets on disk prints "There are no tickets in .tickets/tickets.yaml to build." and exits 1, recording nothing | P19's row needs tickets on disk; before, adoption recorded a project with no tickets and `build.started` then failed its transition (review finding 5) |
| C72 | The check step passes every command (a ticket's `required_tests`, the requirements file's checks, related tests) through C43's rules before running it; one that fails them is recorded `refused` with the reason, counts as a failing check (so the step can't pass), and the fix message quotes it and says to report blocked if the ticket needs it. A requirements-file check widens `run_check` only if it still passes C43 | ARCH 6.9's allowlist; the file can be edited after rafi wrote it (review finding 1) |
| C73 | Untrusted text reaches agents only inside one quoted block, control characters escaped, secrets redacted: ticket fields (title, summary, criteria, required tests) in every message, `run_check`'s failing tests and excerpt, `check_output`. A refused command is never repeated outside the block. The fence is longer than any backtick run in the text | ARCH 1.2 "Instructions hidden in data", 10.3 (review findings 3, 4) |
| C74 | Codex compaction: `codexAgent({ compaction: { thresholdPercent, contextWindow } })` adds `-c model_auto_compact_token_limit=<floor(window × percent / 100)>` and `-c model_auto_compact_token_limit_scope="total"` when the app-server starts (0.10.x's form); usage reports `window` from `modelContextWindow`; a `contextCompaction` item is an activity event marked `compaction`, recorded as `turn.activity` kind `compaction`. No M2 caller sets it: sessions are fresh per ticket and the reuse override isn't M2 | ARCH 11.2 (review finding 6); real Codex 0.164 accepts the setting (`config/read` returns it, `/private/tmp/m2-codex-compaction-probe.log`); that it triggers compaction needs a paid long turn |

### 10.4 Locked-doc problems

| # | Problem | Evidence | Suggested fix | Status |
|---|---|---|---|---|
| P19 | No path from an empty log to a buildable project. `build.started` needs project `ready` or `complete`; a 1.0 project made by hand, by the harness (SCN 2.1 writes files straight into the repo) or a fresh clone has no `project.created` | `REWRITE_ARCHITECTURE.md:583-593` (4.4 table), `:591` (`ready`, `complete` → `build.started`); `REWRITE_SCENARIOS.md:48` | Add a 4.4 row: "— (no project yet; a 1.0 config and tickets on disk) → `ready`, recorded by the first command that writes, as `project.created` plus `tickets.changed` (added)". C62 does this now | **Approved by the user and applied (2026-11-03):** `REWRITE_ARCHITECTURE.md:585` (the new 4.4 row); nothing else in the locked docs changed. C62 (`adoptProject`, `engine/src/api/start.ts`) matches it: it adopts only with no project in the log and at least one ticket on disk; with none, `start` exits 1 and records nothing (C71). Tests: `engine/test/state/buildProject.test.ts` (the row's two events from no project → `ready`), `scenarios/test/harness-m2.test.ts` (P19 tests) |

### 10.5 Not done, and changed M1 tests

- Not built: the setup script run; question records beyond the runtime prompt (M6, as planned).
- M1 tests changed: `scenarios/test/format.test.ts:55` uses `resume` instead of `start` as the not-built example; `engine/test/state/ticketTable.ts` `checkRun()` gained `refused` and `sandbox` (schema change); S-CLI-2 step 2 (plan item 16; the `start -y` forms run on fresh F-ONE copies).
- `deps/` is 636 of its 650 lines.

### 10.6 Review fixes (`.rafi-build/M2-review.md`, 2026-11-03)

Red runs in `.rafi-build/M2-red/fix-<n>.log`, each failing on its own assertion before the fix: 1 (curl reached `checks.run` from a ticket's `required_tests` and from an edited requirements file; `run_check` accepted an edited file's `curl`), 2 (the related-tests query ran with no sandbox prefix; a hung query was never stopped), 3 (an env secret reached the agent raw through `run_check`), 4 (ticket text outside any quoted block in the prepare message), 5 (a config with no tickets was adopted; the adoption test with tickets passed first, as C62 already did it), 6 (no compaction `-c` at spawn; the no-threshold control passed first). Choices C71–C74.

Mutation checks for the scenarios never seen failing (10.2), `.rafi-build/M2-red/mutation-<scenario>.log`: 35 mutations over S-START-4, S-SCN-1, S-SCN-14, S-MAL-1, S-MAL-4, S-TIME-1, S-TIME-2, S-CHK-1, S-CHK-9, S-CHK-10, S-CHK-11; each made its step fail. Two steps needed hardening first: S-MAL-1's "the repaired reply is accepted and recorded" passed with the repair never used (it read only `turn.repair.accepted`; it now also requires no retry and one report), and S-CHK-11 step 3 hung instead of failing when the saved acceptance was lost (it now answers "Cancel" if asked).

### 10.7 Threat-model review

Written 2026-11-03 for M2's security line (`REWRITE_ARCHITECTURE.md:1647`), from ARCH 1.2's rows (`:79-89`), 6.9 and 7.11 and from the code as built, not from section 4. Paths are relative to `packages/`; `E` is `engine/src`, `ET` `engine/test`, `ST` `scenarios/test`, `SS` `scenarios/scenarios`. Tests are named by file and test title. "New" rows were found by this review: each test was seen failing first (`.rafi-build/M2-red/threat-<n>.log`), then fixed. "Untested" rows had a defense but no test: the test passed on its first run (log saved), and a mutation that removes the defense made it fail (`threat-<n>-mutation.log`) where noted.

**Who attacks:** the agent (a prompt-injected builder or QA: it writes code, tests, `package.json` and `docs/`), repository files (`tickets.yaml`, the requirements file, `.claude/settings.json`), test output, and another local process or a web page reaching the endpoint.

| # | Threat | How the code stops it | Test |
|---|---|---|---|
| **`run_check`** | | | |
| 1 | A non-test program (`rafi answer`, `curl`, `rm`, `node -e`) | `E/tools/session.ts:49-58` accepts only the runner, setup script or a checked requirement; refusals recorded `refused` with the reason (`E/build/checks.ts:149-157`) | `ET/tools/session.test.ts` "run_check refuses everything outside its allowlist, with a reason"; `SS/checks.scenario.ts` S-CHK-9 "rafi answer and curl are refused and recorded with the reason; no question is answered" |
| 2 | Shell syntax: `;`, `&&`, `$( )`, backticks, redirects, `sh -c` | `E/agents/shellForms.ts:4-39` refuses every operator and expansion; spawned with `shell: false` (`E/deps/real/checks.ts:42`) | `ET/tools/session.test.ts` "splitCommand splits into argv without a shell and refuses shell syntax" and the allowlist test |
| 3 | Paths outside the worktree, runner options (`--config=/tmp/evil.js`) | `E/tools/session.ts:29-41` | the allowlist test (`../../x`, `/etc/passwd`, `--config`) |
| 4 | Agent-written requirement checks (P15, C43), or the file edited later | Prepare checks each `check` (`E/build/steps/prepare.ts:36`); `run_check` re-checks it on every call (`E/tools/session.ts:64-67,73-79`) | `ST/security-m2.test.ts` "a requirements check that isn't a test command is a content error; the prepare turn is retried"; `ET/tools/session.test.ts` "C43: …" and "a requirements-file check that isn't a test command doesn't widen run_check (an edited file, review 1)" |
| 5 | Review finding 1: the check step runs `required_tests` or an edited requirements file's checks as written | `checkStep` passes each through C43 first; a refused one fails the step (`E/build/checks.ts:212-220`) | `ST/security-m2.test.ts` "review 1: the check step refuses a ticket's required test that isn't a test command; the step can't pass"; "review 1: a requirements file edited after rafi wrote it can't make the check step run curl" |
| 6 | Review finding 2: the related-tests query (runner config can run code) unsandboxed and unlimited | It goes through the same `spawn` (sandbox prefix, cache env, quiet and total limits) (`E/build/checks.ts:64-85,164-169`) | `ST/security-m2.test.ts` "review 2: the related-tests query runs under the sandbox with the test environment"; "review 2: a related-tests query that hangs is stopped by the quiet limit; the build goes on" |
| 7 | Network beyond the grants | sandbox-exec `(deny network*)`, loopback only with `local-servers` (`E/build/sandbox.ts:22-29`); bwrap `--unshare-net` (`:46`) | `ET/build/sandbox.test.ts` macOS and Linux tests; `ET/deps/sandbox.real.test.ts` "a TCP connect to a public address is denied with an error, not a timeout", "1.3: with local-servers, …"; S-CHK-9 "npx jest t1.test runs; a test trying the network is denied by the sandbox" |
| 8 | Writes outside the project; caches in `$HOME` | Writes only to the worktree, cache and `/dev` (`E/build/sandbox.ts:17-18`; bwrap `:42-45`); cache and `TMPDIR` under `.rafi/cache/` (`:70-74`) | `ET/deps/sandbox.real.test.ts` "writes to $HOME and outside the project are denied", "npm test passes with npm_config_cache and TMPDIR under .rafi/cache/, no EPERM"; `ET/build/sandbox.test.ts` "C41: …" |
| 9 | **New.** A test writes `.git/config` (`core.fsmonitor` runs at rafi's next snapshot `git add -A`, outside the sandbox: checked by hand with git), hooks, or rafi's records (`.rafi/`, `.tickets/`) | **Fixed:** those three stay read-only inside the worktree, the cache writable again (`E/build/sandbox.ts:9-30,33-45`) | `ET/build/sandbox.test.ts` "threat 9: rafi's records and git's folder in the worktree stay read-only; the cache stays writable"; `ET/deps/sandbox.real.test.ts` "threat 9: a test can't write .git/ …" (red: `.git/config` was writable). bwrap side unverified until CI |
| 10 | A hung or endless test | Quiet and total timers on `deps.clock` (`E/build/checks.ts:71-79`); the real run kills its process group (`E/deps/real/checks.ts:53-60`) | `ST/checks-m2.test.ts` "a run quiet for 2 minutes is timed-out (a failure); one still printing at 5 minutes is too-slow"; `ET/deps/sandbox.real.test.ts` "an aborted run is ended and reported as aborted" |
| 11 | **Untested.** Output flood (memory) | 4 MB cap (`E/deps/real/checks.ts:8,48`) | `ET/deps/sandbox.real.test.ts` "threat 11: a run that prints more than 4 MB keeps only about the first 4 MB" (process set) |
| 12 | QA changes code through a run. **New:** a run that also added a file made the single `git restore` fail as a whole; nothing was put back, yet `restored` said it was | **Fixed:** added files removed, the rest restored, then re-snapshotted; a mismatch stops the build (`E/facts/snapshot.ts:51-64`, `E/build/checks.ts:126-134`) | `ST/checks-m2.test.ts` "a builder run that edits a tracked file is changed-code naming it; QA's is put back and recorded", "threat 12: a QA run that edits a tracked file and adds a new one: both put back, the restore checked" (red: the edit stayed); S-CHK-9 "QA's run is recorded, src/index.js put back (restored), …". Not covered: git-ignored files (`node_modules/`, `dist/`) a QA run writes |
| 13 | No sandbox on this machine | C60 decision (`E/build/sandbox.ts:81-87`, `E/api/start.ts:110`); allowlist and restore unchanged | `ET/build/nosandbox.test.ts` (4 tests); S-CHK-11 steps 1–5; `ST/checks-m2.test.ts` "with the no-sandbox warning accepted, runs spawn with no prefix and record sandbox: none" |
| 14 | **Fixed (11.10).** Secrets in the test environment | Every test run gets the test allowlist (base set, cache variables, `checks.env`; `E/build/env.ts`, used by `E/build/checks.ts` `environment()`), `check.run` records `env_missing`; agents get the agent allowlist (`agentEnv`, `E/build/context.ts`, `E/api/start.ts` model check); Codex's shells drop `OPENAI_*`; redaction learns encodings and secret-looking declared names (`E/log/redact.ts`); rafi's per-test JSON report is rewritten redacted (`E/build/checks.ts` `perTest`) | `ST/security-sec.test.ts` A1/A2, A3/A4, A5/A6; `SS/security.scenario.ts` S-SEC-2, S-SEC-1 step 1; `ET/build/env.test.ts`, `ET/log/redact.test.ts` |
| **`check_output` and quoted data** | | | |
| 15 | **Untested.** Reading another ticket's runs or arbitrary blobs | Only this ticket's recorded runs, by positive integer (`E/build/context.ts:101-105`, `E/tools/session.ts:92-93`) | `ST/security-m2.test.ts` "threat 15 and 21: check_output reads only this ticket's runs; every session's endpoint is closed after" (mutation failed it) |
| 16 | Review finding 3: test output as instructions or a secret channel | Redacted, control characters escaped, one quoted block (`E/build/checks.ts:91-107`, `E/build/context.ts:104-105`) | `ST/security-m2.test.ts` "review 3: run_check and check_output give the agent test output redacted, escaped and quoted"; "instructions hidden in test output reach the builder's fix message only fenced, escaped and redacted" |
| 17 | Review finding 4: ticket text as instructions, including a line that closes the fence | Quoted (`E/instructions/messages.ts:22`); the fence is longer than any backtick run inside (`E/instructions/assemble.ts:52-57`) | `ST/security-m2.test.ts` "review 4: ticket text from tickets.yaml reaches every agent message only as quoted data" (its summary holds a ```` ``` ```` line) |
| **The endpoint** | | | |
| 18 | Another local process: no token, a wrong one, another session's | Bearer token per session, compared with `timingSafeEqual` (`E/tools/mcp.ts:40-44,52-53`) | `ET/tools/mcp.test.ts` "no token, a wrong token or another session's token is 401 and nothing runs"; `ST/harness-m2.test.ts` "the in-memory endpoint serves one handler per session and checks the token". Constant time is by construction, not timed by a test |
| 19 | A web page (any `Origin`), DNS rebinding (`Host`), a remote peer | `E/tools/mcp.ts:49-51`; bound to 127.0.0.1, random port (`E/deps/real/serve.ts:42`) | `ET/tools/mcp.test.ts` "a Host other than 127.0.0.1:<port>, any Origin, or a non-loopback peer is 403"; "the real server binds 127.0.0.1 on a random port, enforces Host, and refuses after close" |
| 20 | **Untested.** A guessable token | 32 random bytes (`E/deps/real/index.ts:22`) | `ET/tools/mcp.test.ts` "threat 20: the real session token is 32 random bytes, fresh each time" |
| 21 | **Untested in a build.** The endpoint left open after its session | Closed with the session (`E/build/session.ts:51,63-66`), sessions closed per ticket and at the end (`E/build/loop.ts:35,64`) | `ST/security-m2.test.ts` "threat 15 and 21: …"; the real-server test above |
| 22 | The token leaks; **untested:** argv and env | Registered with the redactor (`E/build/session.ts:48`); sent only in `thread/start`'s config over stdio (`E/agents/codex/adapter.ts:61`) | `ST/security-m2.test.ts` "the session token never appears in an event, a blob, the terminal or stats export"; `ST/fidelity-m2.test.ts` "threat 22: the session token reaches Codex only in the thread config over stdio, never argv or env" |
| 23 | **Untested.** A huge request body (read before the token check) | 1 MB cap, then the connection is dropped (`E/deps/real/serve.ts:8,16`) | `ET/tools/mcp.test.ts` "threat 23: a request body over 1 MB is refused before the handler; nothing runs" (mutation failed it) |
| **The agent permission policy** | | | |
| 24 | An agent runs rafi in its shell. **New:** `/usr/local/bin/rafi answer`, `"rafi" stop`, `npx rafi …`, `bash -c 'rafi …'`, `node …/rafi/…/cli.js` passed; `grep -rn rafi src` was refused | **Fixed:** finds each simple command's program past assignments, launchers and flags (`E/agents/permissions.ts:36-60`). A variable or an escape inside the name still passes; rows 28 and 30 | `ET/tools/session.test.ts` "the permission policy: rafi's state, rafi commands, outside the worktree, QA writes, repair turns"; "threat 24: rafi run through a path, quotes or a wrapper is still a rafi command; words about rafi aren't" (red) |
| 25 | Edits to rafi's state or outside the worktree | `E/agents/permissions.ts:20-34` | the permission-policy test; S-MAL-4 "an edit outside the ticket's files is refused with a one-line reason naming the file" |
| 26 | QA writes | Policy (`E/agents/permissions.ts:25`); Codex QA read-only thread and turn (`E/agents/codex/adapter.ts:49-51`, `E/build/session.ts:53`); Claude QA user settings only, worktree write-denied (`E/agents/claude/options.ts:36,54`) | the permission-policy test; `ST/fidelity-m2.test.ts` "Codex QA: read-only thread and turn; …", "Claude builder and QA: setting sources, sandbox, QA's private TMPDIR, …" |
| 27 | Tools in a repair turn | `E/agents/permissions.ts:68`; Claude's gate also denies (`E/agents/claude/adapter.ts:43-55`) | the permission-policy test; `ST/fidelity-m2.test.ts` "threat 29: …" (a Read in a repair turn) |
| 28 | **New.** Claude: sandboxed Bash never reached the policy (Claude Code's `autoAllowBashIfSandboxed` defaults to true), and `dangerouslyDisableSandbox` ran commands outside the sandbox (`allowUnsandboxedCommands` defaults to true; both read from the `claude` 2.1.316 binary); the builder's Bash could write `.git/`, `.rafi/`, `.tickets/` | **Fixed:** both off, `failIfUnavailable` on, those folders write-denied for the builder (`E/agents/claude/options.ts:27-40`), as Codex already does for `.git/` | `ST/fidelity-m2.test.ts` "threat 28: Claude's sandboxed Bash still asks rafi's policy, stays in the sandbox, can't write rafi's folders" (red) |
| 29 | **New.** Claude: tools allowed by repository settings (the builder loads `.claude/settings.json`) or allowed by Claude itself (reads) skipped canUseTool, so the policy never saw them | **Fixed:** a `PreToolUse` hook (ARCH 11.6's table names it, `REWRITE_ARCHITECTURE.md:1438`) sends every tool use through the same gate; the reply tool is exempt (`E/agents/claude/adapter.ts:38-65,70`). The fakes now model this (`scenarios/fakes/claude-cli.mjs` `permission()`, `scenarios/fakes/claude/query.ts` `autoAllowed`) | `ST/fidelity-m2.test.ts` "threat 29: tools the project's settings allow, and reads Claude allows itself, still meet rafi's policy" (red). The hook's real behavior needs the live check (1.4) |
| 30 | **Fixed (11.10).** Codex: commands inside its sandbox never reach the policy | The builder runs under rafi's permission profile (`E/agents/codex/profile.ts`), selected on `thread/start`, `thread/resume` and every `turn/start`, no legacy sandbox; `.rafi/`, `.tickets/`, `.git/` read-only, `.rafi/cache/` writable; `approvalsReviewer: user`; every Codex approval is an escalation the policy denies (`E/agents/permissions.ts` `ESCALATION`); a permissions request gets `{ permissions: {} }`. macOS free probes only; Linux in CI | `ST/security-t30.test.ts` A7–A10; `ET/deps/codex-profile.real.test.ts` A11 (process set); `ST/fidelity-codex-profile.test.ts` (the fake) |
| 31 | Network tools without a grant | `E/agents/permissions.ts:71-73` | the permission-policy test (`WebFetch`) |

**Needs a decision (decided 2026-11-03, built in 11.10):**

- **Threat 14, secrets in the test environment.** Evidence: `E/build/checks.ts:77` passes `{ ...deps.env }`; `E/log/redact.ts:12,29-35`. Suggested fix: run checks with an allowlisted environment (`PATH`, `HOME`, locale, `CI`, proxy and certificate variables, the cache variables) plus `checks.env: [NAMES]` in `rafi-config.yaml` for what a project's tests need. It's a new setting and can break tests that read other variables, so it's yours to decide.
- **Threat 30, Codex shell commands.** On Codex an agent can rewrite `.rafi/` (the event log) or `.tickets/`, and once M6 builds `rafi answer`, run it. That breaks ARCH 1.2's first row (`:81`, "the agent permission policy refuses it; agents never write rafi's state") for Codex. Options: (a) approval policy `untrusted`, so each command Codex doesn't trust is an approval request the policy answers (more round trips per turn; how many commands Codex trusts by default isn't verified); (b) a Codex setting that makes paths inside a writable root read-only, if one exists (none found in 0.164.0; unverified); (c) keep rafi's writable state out of the worktree, which changes ARCH 3 (a locked-doc change). Suggested: (a) now, checked in the live adapter check (1.4).

Also noted, not threats: QA's Claude scratch folder sits under `.rafi/cache/`, inside the worktree QA's sandbox write-denies; whether `allowWrite` beats `denyWrite` there is unverified (a broken `TMPDIR`, not a hole), and needs the live check.

### 10.8 Live check results (2026-11-03)

Plan 1.4, authorized by the user for at most 12 real model turns. **Used 12:** Claude 5 (haiku → `claude-haiku-5-5`, Claude Code 2.1.317, SDK 0.3.159) and Codex 7 (`gpt-5.6-luna`, effort `low`, codex-cli 0.164.0), on the user's existing logins with no settings changed. The script is `scripts/live/rewrite-adapters.mjs`. It imports the built `packages/engine/dist`, answers permissions with the engine's own `decidePermission`, logs every wire message with the token redacted, and skips a provider that isn't logged in. It is 403 lines against the 300 budgeted in 2.5: the threat-30 profile row and the inline probe scripts added the excess. It wasn't trimmed, because it can't be re-run within this budget. Logs are under `/private/tmp/m2-live/`, one `<row>.log` per row. `run-<n>-*.out` holds each run's summary.

| Check | Result | Evidence log | Follow-up |
|---|---|---|---|
| **L1 (found first).** The built Codex adapter never sent `initialize` | **Bug, fixed.** Real 0.164 answers `thread/start` with `-32600 "Not initialized"` before any turn (0 turns spent). The adapter now sends `initialize` (`clientInfo` `rafi`, `capabilities.experimentalApi: true`, as 0.10.x does) and then the `initialized` notification, once, before `thread/start`, `thread/resume` and `model/list` (`E/agents/codex/adapter.ts`, `transport.notify`). The fake now refuses requests before `initialize`, as the real one does (`scenarios/fakes/codex/protocol.mjs`) | `codex-mcp-preinit.log`; red `.rafi-build/M2-red/live-1.log` | Test `ST/fidelity-m2.test.ts` "live 1: …" |
| **L2.** Claude's standing instructions never reached the model | **Bug, fixed.** The adapter passed `appendSystemPrompt`, which SDK 0.3.159's `query()` doesn't read (it reads only `systemPrompt`: `sdk.mjs` destructures `systemPrompt`, and `appendSystemPrompt` exists only on the control request). Live: an instruction to put PAPAYA in `note` was ignored. Now `systemPrompt: {type: "preset", preset: "claude_code", append}`, as 0.10.x does (`ai-foreman/src/adapters/claude.ts:110`). Live after the fix: MANGO arrived. The in-process fake now throws on `appendSystemPrompt`, and the harness transcript reads `systemPrompt.append`. This also means C52's text fallback ("Reply with only the JSON") had never reached real Claude | `claude-builder-prefix.log` (options show `appendSystemPrompt`, no `systemPrompt`; note lacks PAPAYA); `claude-qa.log` (MANGO); red `live-2.log` | Test "live 2: …" |
| a. 1.1 Part B: a real Codex turn calls `run_check` with the per-session token | **Works.** The endpoint got `initialize`, `notifications/initialized`, `tools/list` and `tools/call {run_check, npm test}`, each with the right bearer token. The turn recorded `mcp:rafi/run_check` completed, gave a structured reply, and reported usage (input 47,427, output 211, window 258,400). No approval or elicitation was asked for the MCP call. Turn took 10.8 s | `codex-mcp.log` | — |
| b. Claude: local servers without internet | **Works.** Builder with the `local-servers` grant (`allowLocalBinding`, no allowed domains, `*` denied): listening on 127.0.0.1 and connecting to itself works, and `1.1.1.1:443` gets EPERM. Control, QA with no grant: the loopback listen gets EPERM, and so does the public connect | `claude-builder.log` (`probe-net.json`); `claude-qa.log` | `claudeCapabilities().localServersWithoutInternet = true` (`E/agents/capabilities.ts`); test "live 3: …" pins it and the grant's network settings (red `live-3.log`) |
| c. Codex compaction via `-c model_auto_compact_token_limit` | **Works.** Turn 1 (fresh app-server, about 15k tokens of filler) gave a context (`last.total`) of 37,720. Turn 2 resumed the thread on a new app-server started by the adapter's `compaction` option with `model_auto_compact_token_limit=26404` (70%) and `_scope="total"`. Codex emitted one `contextCompaction` item, and the adapter reported it as `activity` with `compaction: true`. Codex kept the user message, so the context after was 37,873 and still above the limit, but it compacted only once. The secret word survived. The lowest triggering limit wasn't searched: one setting, as the budget allowed | `codex-compaction.log` | C74's "needs a paid long turn" is now checked. Pick the threshold for the reuse override knowing that Codex keeps recent user messages through a compaction |
| d. Threats 28 and 29 on real Claude Code | **Works.** The project's `.claude/settings.json` allowed `Bash(*)`, `Write`, `Edit` and `Read` with `acceptEdits`, and every tool use still reached rafi's policy. Bash `rafi answer q1 yes` was refused (a fake `rafi` on `PATH` never ran). Write `.rafi/forged.txt` was refused, and the file is absent. Read `README.md` reached the policy (the hook). `node write-guarded.mjs`, which the policy allows, got EPERM from the sandbox for `.rafi/`, `.git/` and `.tickets/`, while `src/` was writable | `claude-builder.log` | 10.7 rows 28 and 29: "the hook's real behavior needs the live check" is now checked |
| e. Threat 30 measurement: one builder turn (read, edit, `npm test`) | **Measured, default unchanged.** `on-request` (shipped): **0** approval requests, **7.33 s**. Run without asking: the `sed` read of `src/add.js` and `package.json`, the edit, `npm test`. `untrusted` (rewritten on the wire by the script): **2** approval requests (the `sed` read command and the `src/add.js` edit, both allowed by the policy), **8.77 s**. `npm test` ran without asking because the user's `~/.codex/rules/default.rules:2` has `prefix_rule(["npm","test"], allow)`, so user exec-policy rules bypass rafi's policy even under `untrusted`. The test passed in both turns. One run each, so the timings are indicative only. **`auto_review`:** both threads got `approvalsReviewer: "auto_review"` (inherited from `~/.codex/config.toml:4`), but both approvals still came to rafi, and there were no `item/guardian…` events. These turns weren't affected | `codex-approvals-on-request.log`, `codex-approvals-untrusted.log` | For the threat-30 decision: under option (a), the user's own rules can let commands skip rafi's policy |
| e+. Threat 30 option 3 (`.rafi-build/threat30-options.md`), measured at the coordinator's request, rewritten on the wire | **Partly works, and found a hole.** The thread got `activePermissionProfile: rafi_builder` and reviewer `user`, with no `sandboxPolicy`, and the turn asked for no approvals. `.rafi/` and `.tickets/` got EPERM, and `.rafi/cache/` and `src/` were writable. **But `.git/` became writable:** a new `.git/bash-probe.txt` was written in the turn, and a free `codex sandbox -P` probe shows `.git/config` writable under the report's profile but denied under `:workspace`. Adding `".git" = "read"` to the profile denies both again (free probe) | `codex-profile.log`; `free-git-probe.txt` | If option 3 is chosen, the profile must also have `".git" = "read"`. This corrects the report's claim that `.git/config` stays denied |
| f. Claude QA scratch: `allowWrite` on `.rafi/cache/<…>` under `denyWrite` on the worktree | **Doesn't work.** A direct write to `.rafi/cache/qa-scratch/` from QA's sandboxed Bash gets EPERM, so the deny wins. Separately, Claude Code sets `TMPDIR=/tmp/claude-501` in sandboxed Bash, overriding the `TMPDIR` rafi passes, and that folder is writable. So QA has a working temp folder, but it isn't rafi's private scratch | `claude-cancel.log` (`scratch: EPERM`); `claude-qa.log` (`tmpdir: /tmp/claude-501`, written) | Contradicts ARCH 7.11 (`REWRITE_ARCHITECTURE.md:1150`, "QA gets a private scratch `TMPDIR`"). Not changed; see the locked-doc note below |
| Also from H01's list | Claude: structured reply and usage (builder); resume works (a new agent with `resume`, same session id, answered KIWI from turn 1, 1.3 s); cancel works (aborted during a foreground `node wait.mjs`, `cancelled` confirmed 35 ms after the abort). A first cancel try with `sleep 60` didn't test anything: Claude Code refuses a bare foreground `sleep`, and the model backgrounded it and replied in 6.9 s. Codex: resume works (c's turn 2 is `thread/resume` on a new app-server); cancel works (`cancelled` confirmed at 10.0 s). **Not run (budget):** Claude's compaction setting (Q-ADP-1), and a Codex refused tool request (no decline happened in these turns) | `claude-resume.log`, `claude-cancel.log`, `claude-cancel-sleep.log`, `codex-cancel.log` | Q-ADP-1 and a Codex decline at the next live check |

**Locked-doc problem (not edited):** ARCH 7.11 (`REWRITE_ARCHITECTURE.md:1150`) says Claude's QA "gets a private scratch `TMPDIR` for temp files". On Claude Code 2.1.317, sandboxed Bash gets Claude's own `TMPDIR` (`/tmp/claude-501`), and rafi's scratch (`E/build/context.ts:109`, `.rafi/cache/qa-tmp-<ticket>`) can't be written under the worktree's `denyWrite` (row f). Suggested fix: say that QA's temp files go to Claude's own sandbox temp folder. Then drop the scratch's `allowWrite` and `TMPDIR` from `E/agents/claude/options.ts`. Or, if a private folder is still wanted, put it outside the worktree, knowing `TMPDIR` won't point at it.

Gates after the fixes: fast suite 35 jobs, 295 passed, 0 failed, 10 skipped, 18.6 s wall on 4 workers (`/private/tmp/m2-live/final-fast.log`); `check-rules` 151 files, 0 problems (`final-rules.log`); process set 18 passed, 0 failed, 17.8 s (`final-process.log`).

## 11. Addendum: post-review security work (2026-11-03)

A mini plan for the session that implements what the user approved on 2026-11-03 after the threat-model review (10.7) and the live check (10.8). Nothing here is built yet. Paths are relative to `packages/` unless they say otherwise; `E` is `engine/src`, `ET` `engine/test`, `ST` `scenarios/test`, `SS` `scenarios/scenarios`. Evidence from this session's free probes (no model turns) is in `/private/tmp/m2-addendum/`.

### 11.1 What was approved, and where the locked docs now say it

| Item | Decision | Locked docs (applied 2026-11-03) |
|---|---|---|
| A. Secrets (threat 14) | `REWRITE_SECRETS_PROPOSAL.md`, all six questions answered "yes". M2 builds only the floor: the test allowlist with `checks.env`, secret-free agent environments with `agents.env`, encoding-aware redaction, `env_missing`, canary tests. The store, presets and home levels are M7; the preset question and the release-gate canary grep are M10 | ARCH 1.2 (`:81`, `:87-89`), 3.4 (`:318`), 3.8 (`:436`), 6.9 (`:954`), 7.2–7.4 (`:1015`, `:1032`, `:1047`), 7.11 (`:1159-1160`), new 7.12 (`:1163-1196`), 8.2, 8.6, 10.2, 11.5, 13, 14, 15 decision 12; REQ CMD-38, FMT-C27–C34, NEW-SEC-4 (amended), NEW-SEC-5–12, ARCH-14; SCN S-SEC-1–4 (5.7), S-CLI-1, section 10 |
| B. Threat 30 | A rafi Codex permission profile (`extends = ":workspace"`; `.rafi`, `.tickets`, `.git` read; `.rafi/cache` write), selected per thread and turn; no per-turn `sandboxPolicy` for the builder; Codex escalation approvals declined; `approvalsReviewer: "user"` (`initialize` is already fixed, 10.8 L1). Linux and Windows unverified until CI | ARCH 1.2 `:81`, 7.11 `:1154` and `:1161`, 11.1 table `:1486`, M2 Builds and Security (`:1692-1693`) |
| C. P20 | Claude QA uses Claude Code's own sandbox temp folder; rafi passes no scratch or `TMPDIR` to QA. Codex QA (`readOnly`) has no writable temp folder; the builder's profile can write `$TMPDIR` and `/tmp` | ARCH 7.11 `:1155-1156` |

So 10.7 rows 14 and 30, and the 10.8 "Locked-doc problem" (P20), are decided; their fixes are below. Counts after the doc change: 126 scenarios (M2 must-pass 15, running total 17), 656 requirement IDs (640 covered, 16 not testable); `ST/ledger.test.ts` and `scenarios/checks/registry.ts` are already updated and green.

### 11.2 Free probes first (slice S0, no model turns)

| # | Probe | Status | Decides |
|---|---|---|---|
| S0.1 | `codex sandbox -P :workspace -c 'shell_environment_policy.include_only=[…]'` and `…exclude=["RAFI_*"]` with a canary in the environment | **Done here:** both honored (`codex-shell-env-probe.txt`) | — |
| S0.2 | The same through the app-server: `thread/start` with `config.shell_environment_policy` (and a project `.codex/config.toml` that tries to widen it), then `command/exec` printing `env` | To do (free; same pattern as 10.8's `settings-probe`) | If honored, M2 sets Codex's shell policy (11.5 C79); if not, that part moves to M7 (ARCH M2 Builds) |
| S0.3 | `codex sandbox -P :read-only`: `$TMPDIR` and `/tmp` writes | **Done here:** both denied; under `:workspace` both writable (`codex-qa-tmp-probe.txt`) | The ARCH 7.11 wording for C |
| S0.4 | `command/exec` under the generated profile (from `profile.ts`, not hand-written): `.rafi/state.sqlite3`, `.tickets/t.yaml`, `.git/config` denied; `src/a.js`, `.rafi/cache/x` writable | To do after `profile.ts` exists; 10.8 e+'s free `.git` probe already shows the `.git = "read"` entry is needed | Becomes the process-set real test (11.4's A11) |
| S0.5 | Claude's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | Needs a paid turn (sandboxed Bash only runs in a turn) | Not set in M2 unless the user authorizes one turn; otherwise M7 (ARCH 7.12 table) |

### 11.3 Files to add or change, with budgets

`deps/` is 625 of 650 lines (measured now: `types.ts` 226, `real/` 399), so **no new code goes in `deps/`**: the allowlists are pure data and functions in `build/`, and the profile in `agents/codex/`. `deps/` doesn't change; `deps.env` stays the whole-shell snapshot that only rafi itself reads.

| File | Change | Lines | Module after / budget |
|---|---|---|---|
| `E/build/env.ts` (new) | The base set (ARCH 7.12, incl. Windows names, `LC_*` prefix), proxy and certificate names, the runtime login tables (Claude; Codex), `testEnv(env, {checksEnv, cache, secrets})` → `{env, missing}`, `agentEnv(env, runtime, agentsEnv)`, `codexShellPolicy()` | ~130 | `build/` 999 → ~1,120 / 2,000 |
| `E/build/checks.ts` | `spawn()` (`:77`) uses `testEnv` instead of `{ ...deps.env }`; `check.run` gets `env_missing` | +10 | |
| `E/build/sandbox.ts` | The cache variables (C41) move into `testEnv` so there's one place that builds a test environment | −6 | |
| `E/build/session.ts` | Both adapters get `agentEnv(...)`; Codex gets the profile option; drop QA's scratch `mkdir` (C) | +4 | |
| `E/build/context.ts` | Drop `scratch` (`:109`) (C) | −2 | |
| `E/log/redact.ts` | `looksSecret(name)` (exported; the `SECRET_NAME` test plus `DSN`, `COOKIE`, `SESSION`); `add()` also registers encodings (C80); `redactor(env, declared)` registers secret-looking `checks.env`/`agents.env` values | +25 → ~100 | `log/` 512 → ~540 / 900 |
| `E/agents/codex/profile.ts` (new) | Profile ids and tables (C83) | ~45 | `agents/codex/` 371 → ~450 / 600 |
| `E/agents/codex/adapter.ts` (149) | Builder: `config.permissions` + `permissions` on `thread/start`, `thread/resume` and `turn/start`; no `sandbox`, no `sandboxPolicy`; `approvalsReviewer: "user"`; `shell_environment_policy` if S0.2 passes; approvals marked as escalations; `item/permissions/requestApproval` answered `{ permissions: {} }` after the policy denies. QA unchanged (C84) | +30 → ~180 | |
| `E/agents/types.ts`, `E/agents/permissions.ts` | `PermissionRequest.escalation?: true`; the policy denies every escalation with the blocked(permission) message (C85) | +12 | `agents/` 295 → ~310 / 700 |
| `E/agents/claude/options.ts` | Drop `scratch` and the QA `TMPDIR`; QA's `allowWrite: []` (C87) | −6 | `agents/claude/` ~295 / 600 |
| `spec/src/v1/config.ts` | `checks.env`, `agents.env`: arrays of environment-variable names, default `[]` (C92) | +6 | |
| `spec/src/v1/events/results.ts` | `check.run`: optional `env_missing: string[]`, `secrets: string[]` (M2 never writes `secrets`) | +3 | |
| `rafi/src/next/commands/table.ts` (or `spec.ts`) | `secrets` listed, "not built yet (M7)", exit 1 (C88) | +3 | |
| `scenarios/fakes/codex/protocol.mjs` (185) | Model `on-request` with a profile: in-root edits and commands run without asking; writes to the profile's `read` paths fail (`failed`, EPERM text); a write outside the root, any write under `read-only`, and a new `escalate` step send an approval request; `sandbox` with `permissions` refused; a `sandboxPolicy` after a profile clears it (recorded, so tests can assert it never happens); `item/permissions/requestApproval` step; the app-server spawn env recorded | +50 → ~235 | |
| `scenarios/fakes/script/engine.ts`, `scenarios/fakes/checks.ts` | `Step.escalate`, `Step.printEnv`; a test behavior `prints(env NAME, encodings)` | +15 | |
| `scenarios/harness/deps.ts`, `harness/after-each.ts` | Child environments tagged by kind (`codex`, `claude`, `check`); canaries on the computer; after-each greps for every canary and its encodings when a computer has them (C89) | +20 | |
| `SS/security.scenario.ts` (new) | S-SEC-2 in full; S-SEC-1's M2 steps, the rest `pending("…", "M7")`; S-SEC-3 and S-SEC-4 registered as pending M7 | ~170 | |
| `SS/cli.scenario.ts` | S-CLI-1's command list gains `secrets` (not built yet, exit 1) | +3 | |
| `ST/security-sec.test.ts` (new) | 11.4's A1–A10 and A12 (kept out of `security-m2.test.ts`, 252, and `fidelity-m2.test.ts`, 307) | ~220 | |
| `ET/build/env.test.ts`, `ET/log/redact.test.ts` | Tables, `testEnv`/`agentEnv`, encodings | ~80, +30 | |
| `ET/deps/codex-profile.real.test.ts` (new, process set) | S0.4 as a test, skipped without `codex` | ~60 | |
| `.github/workflows/rewrite-fast.yml` | Install the pinned codex-cli 0.164.0 on the Linux job and run the profile real test there (and on Windows when that job runs the process set) | +6 | |
| `scripts/live/rewrite-adapters.mjs` | Split (11.6) | 404 → 4 files ≤ 300 | |

### 11.4 Tests and scenarios to write first, in order

Each attack test is run red before its fix, with the log in `.rafi-build/M2-red/sec-<n>.log`; one that passes on its first run is reported as such and gets a mutation run (as 10.6 did).

1. **Ledger and registry** (done in this session): S-SEC-1–4 registered, S-SEC-2 in M2; `ST/ledger.test.ts` green.
2. **Scenarios red:** `SS/security.scenario.ts` S-SEC-2 (red: the undeclared canary reaches tests; no `env_missing`; the base64 and hex forms reach the terminal and blobs) and S-SEC-1's step 1 (red: canaries in Claude's `env` and the Codex app-server env); S-CLI-1 with `secrets` (red: unknown command).
3. **Attack tests, environment** (`ST/security-sec.test.ts`):
   - A1: a canary outside the allowlist reaches `deps.checks.run`'s `env` from `run_check`, the check step and the related-tests query (red today: `E/build/checks.ts:77`);
   - A2: a `checks.env` name reaches tests, and an unset one is `env_missing` (red: not built);
   - A3: a canary reaches Claude's `env` option and the Codex spawn `env` (red today: `E/build/session.ts`);
   - A4: Codex's thread config sets `shell_environment_policy` excluding `OPENAI_*` (red; only if S0.2 passes).
4. **Attack tests, redaction:**
   - A5: a secret-named value printed as base64, base64url, hex and URL-encoded reaches a blob, the terminal, `run_check`'s reply and `stats export` (red today: `E/log/redact.ts` matches raw values only);
   - A6: a secret-looking `checks.env` value is learned (red).
5. **Attack tests, threat 30** (`ST/security-sec.test.ts` against the changed fake, after its fidelity rows in step 6):
   - A7: the builder's `thread/start` carries `sandbox` and each `turn/start` a `sandboxPolicy` (red today: `E/agents/codex/adapter.ts:89`); the fix sends the profile and `permissions` on thread and turn, and the fake reports `activePermissionProfile: rafi_builder` after every turn;
   - A8: `approvalsReviewer` is `user` on `thread/start` and `thread/resume` (red);
   - A9: a Codex escalation (`escalate("X=ra; ${X}fi answer 1 1")` with `additionalPermissions`) is accepted today, because `E/agents/permissions.ts:64` allows shell commands (red); after the fix it's declined with the blocked(permission) message and recorded;
   - A10: `item/permissions/requestApproval` is answered `{decision:"decline"}` (red: wrong shape); the fix answers `{ permissions: {} }`;
   - A11 (**process set**): `ET/deps/codex-profile.real.test.ts` runs `codex sandbox` with the config the adapter actually sends (captured from the fake): `.rafi/state.sqlite3`, `.tickets/t.yaml` and `.git/config` denied, `src/` and `.rafi/cache/` writable (red today: the thread config has no profile, so `.rafi` is writable under `:workspace`);
   - A12: Codex QA is unchanged, read-only on thread and turn (the existing `fidelity-m2` QA test stays green; a control, not a red).
6. **Fake fidelity first, before item 5's fixes:** the fake's `on-request` model (no approval inside the root; denials for read paths; approval only for escalations). Existing scenarios that edit through the Codex fake (the role happy paths) must stay green; S-MAL-4's "edit outside the ticket's files is refused" still gets a request, now an escalation, and its line stays the same.
7. **C (P20):** change `ST/fidelity-m2.test.ts` "Claude builder and QA: setting sources, sandbox, QA's private TMPDIR, …" to expect no `TMPDIR` and no scratch `allowWrite` for QA (red until `options.ts` changes). Not an attack test.

Then implement in the order of 11.3's table, run the fast suite, `scripts/check-rules.mjs` and the process set, and update 10.7: rows 14 and 30 become **Fixed** with the tests above.

### 11.5 Implementation choices the docs leave open (C75+)

| # | Choice | Why |
|---|---|---|
| C75 | The allowlists live in `E/build/env.ts`; `looksSecret` lives in `E/log/redact.ts` and `env.ts` imports it | `deps/` has 25 lines left; `log/` is lower in the graph than `build/` |
| C76 | Proxy names: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, each in both cases. Certificate names: `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`. On Windows, names match case-insensitively (`Path`) | ARCH 7.12 says "proxy and certificate variables" without a list |
| C77 | Agents also get `TMPDIR` (it names a folder, not a secret; Codex's `:workspace` grants write to `$TMPDIR`, and Claude sets its own). `SSH_AUTH_SOCK` is withheld from tests and agents (it lets a process use your SSH keys); a project that needs it lists it in `checks.env` or `agents.env` | ARCH 7.12's runtime config variables; the guarded-home intent |
| C78 | Runtime login tables, each runtime getting only its own: Claude `ANTHROPIC_*`, `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`, plus `AWS_*` when `CLAUDE_CODE_USE_BEDROCK` is set and `GOOGLE_*`, `GCLOUD_*`, `CLOUD_ML_REGION` when `CLAUDE_CODE_USE_VERTEX` is set; Codex `OPENAI_*`, `CODEX_HOME` | ARCH 7.12, 11.5 |
| C79 | Codex shells: `shell_environment_policy = { inherit = "all", exclude = ["OPENAI_*"] }` in the thread config, over the already-allowlisted app-server environment, only if S0.2 shows the app-server honors it | ARCH 7.12 "minus the runtime's own API key" |
| C80 | Each learned value (≥ 6 characters) is registered raw and as standard base64 (with and without padding), base64url, lower- and upper-case hex, and `encodeURIComponent` when that differs; for values ≥ 12 characters also the three base64 offset cores, so a secret encoded inside a longer string is caught; longest first; the label stays `[REDACTED:NAME]` | ARCH 7.12 "casual encodings"; the offset cores cost three more patterns per value |
| C81 | Values learned in M2: secret-named shell variables (as today) and secret-looking `checks.env` and `agents.env` names; URLs with credentials stay covered by the existing pattern. In M7 every store value is learned whatever its name | ARCH 7.12, NEW-SEC-8 |
| C82 | `env_missing` lists declared `checks.env` names not set in `deps.env`, on every `check.run`; `secrets` isn't written until M7 | ARCH 3.4; no store in M2 |
| C83 | Profile ids `rafi_builder` and `rafi_builder_internet`, both defined in `thread/start`'s (and `thread/resume`'s) `config.permissions`, with `":project_roots"` entries `"." = write`, `".rafi" = read`, `".rafi/cache" = write`, `".tickets" = read`, `".git" = read`; the internet one adds `network = { enabled = true }`. `permissions` on `thread/start`, `thread/resume` and every `turn/start`. Worktree builds (M5, where `.git` is a file) recheck the `.git` entry then | ARCH 7.11; 10.8 e+ |
| C84 | Codex QA keeps the legacy `sandbox: "read-only"` and per-turn `sandboxPolicy` (`readOnly`, network from the grants): it has no profile to clear, and ARCH 7.11's QA sentence is unchanged | Only the builder's profile is cleared by a later `sandboxPolicy` |
| C85 | The adapter doesn't decide (ARCH 11.6): it marks Codex command and file-change approvals, and permissions requests, `escalation: true`; `permissions.ts` denies every escalation, giving its own reason when it would deny anyway (for example "outside the ticket's worktree") and otherwise "asks to run outside Codex's sandbox, which no grant covers"; the adapter maps the deny to `decline` or `{ permissions: {} }` (`PermissionsRequestApprovalResponse`: `permissions` required, `scope` default `turn`) | ARCH 7.11 `:1161`; S-MAL-4's line stays |
| C86 | `approvalsReviewer: "user"` on `thread/start` and `thread/resume` | ARCH 7.11 |
| C87 | Claude QA: `ClaudeOptions.scratch` and `SessionSpec.scratch` removed; QA's sandbox is `allowWrite: []`, `denyWrite: [worktree]`; no `TMPDIR` in its `env`. That `allowWrite: []` keeps Claude's own temp folder writable is checked at the next authorized live check | ARCH 7.11 `:1155`; 10.8 f |
| C88 | `rafi secrets` exists in M2 only as a "not built yet (M7)" command, exit 1 | SCN S-CLI-1 |
| C89 | Harness canaries are `canary-<24 hex>` values from the seeded random source, put in `computer.env` (and, from M7, the in-memory store); the after-each check greps outputs, files, transcripts and agent environments for each canary and its encodings only when the computer has canaries | ARCH 8.2's harness row; keeps other scenarios unchanged |
| C90 | The profile real test feeds the adapter's own config to `codex sandbox -c … -P rafi_builder`, skipped without `codex`; CI installs codex-cli 0.164.0 on Linux. A Linux failure stops the work and is reported with a suggested fix (the report's fallback, `untrusted` on that platform, needs the user's approval) | ARCH 7.11 "unverified until CI" |
| C91 | The live script split (11.6); its threat-30 rows stop rewriting the wire and use the shipped adapter | 10.8 |
| C92 | `checks.env` and `agents.env` take exact names (`^[A-Za-z_][A-Za-z0-9_]*$`), no patterns; an invalid one is a config error naming it | FMT-C28, FMT-C30 |

### 11.6 Splitting `scripts/live/rewrite-adapters.mjs`

It's 404 lines against 2.5's budget of 300 (measured now; 10.8 says 403). Today: helpers and probe sources `:1-162`, `ROWS` `:163-382` (Claude rows `:165-249`, Codex rows `:250-382`), the runner `:383-404`. Split, each under 300:

| File | Holds | Lines |
|---|---|---|
| `scripts/live/rewrite-adapters.mjs` | Arguments, logins, the row loop and summary | ~60 |
| `scripts/live/rewrite-adapters/harness.mjs` | `logger`, `liveDeps`, `runTurn`, `project`, `request`, `readJson`, `threadStarted`, `connect` | ~140 |
| `scripts/live/rewrite-adapters/claude-rows.mjs` | `claude-builder`, `claude-qa`, `claude-resume`, `claude-cancel` | ~95 |
| `scripts/live/rewrite-adapters/codex-rows.mjs` | `codex-mcp`, `codex-compaction`, `codex-cancel`, `codex-profile` (now the shipped adapter, no wire rewrite); `codex-approvals` drops its `untrusted` half (measured in 10.8 e) | ~120 |
| `scripts/live/rewrite-adapters/probes/*.mjs` | The inline probe sources (`PROBE_NET`, `write-guarded`, …) as real files copied into the probe project | ~40 |

Add rows for the next authorized live check: a Codex escalation declined in a real turn; one builder shell write to `.rafi/` denied under the shipped profile; Claude QA writing a temp file with no rafi `TMPDIR`; and, if wanted, S0.5. The split is behavior-preserving: `--rows=` names stay the same.

### 11.7 Security tests (the M2 security line, as amended)

In the fast suite: A1–A10 and A12, S-SEC-2, and S-SEC-1 step 1. In the process set: A11 (macOS here, Linux in CI). Re-run 10.7's existing tests unchanged. Windows: `env.ts`'s Windows names are unit-tested on all platforms; real enforcement there is unverified, like the profile.

### 11.8 Risks and what I couldn't check

- **Linux and Windows profile enforcement:** unverified until CI (C90).
- **The app-server honoring `shell_environment_policy`:** checked only through `codex sandbox` (S0.1); S0.2 decides M2 vs M7.
- **Claude's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`:** unverified without a paid turn (S0.5).
- **A real Codex escalation request in a turn** hasn't been seen (10.8: no decline happened); the decline path is tested against the fake only until the next live check.
- **User exec-policy rules** (`~/.codex/rules/default.rules`, 10.8 e) let commands run without asking; whether such a command can also leave the sandbox is unverified. With no `untrusted` policy this doesn't add approvals, but the next live check should run one rule-allowed command that writes `.rafi/`.
- **The legacy `readOnly` sandbox and the `:read-only` profile** are assumed to be the same for S0.3's temp-folder result; a `command/exec` under `sandboxPolicy: readOnly` would confirm it (free).
- **Tests that read undeclared variables fail** once the allowlist lands (accepted by the user, question 1); F-* fixtures set nothing extra, so no scenario should change, but real projects need `checks.env`.

### 11.9 Questions for the user

None.

### 11.10 Implementation results (2026-11-03)

Not committed. Red runs in `.rafi-build/M2-red/add-*.log`; probes in `/private/tmp/m2-addendum/`; final gates `/private/tmp/add-final-fast.log`, `add-final-rules.log`, `add-process.log`.

- **S0.2 passed** (`s02-shell-env-appserver.txt`, free `thread/shellCommand`, no model activity): the thread config's `shell_environment_policy` is honored; a project `.codex/config.toml` couldn't widen `exclude` (it can `set` literal values). So C79 is built in M2.
- **S0.4** (`s04-profile-appserver.txt`): real 0.164 accepts the adapter's exact `thread/start` (active profile `rafi_builder`, reviewer `user`, shell without `OPENAI_*`). `command/exec` can't use a thread-defined profile (it reads the server config), so A11's `codex sandbox -P` is the file check.
- **Red runs:** `add-unit` (11 of 12; the short-value control passed), `add-config`, `add-env` (A1–A6), `add-5-encodings` (A5 with the redactor learning raw values only: encoded forms in tool replies, the fix message, blobs), `add-scenarios` (S-SEC-1, S-SEC-2, S-CLI-1), `add-fake` (3 of 4; "outside the root / read-only asks" passed, as the old fake asked for everything), `add-t30` (A7–A10), `add-p20`, `add-11` (A11 written after the adapter fix; red shown by putting the legacy builder sandbox back: `.rafi`, `.tickets` writable).
- **New finding (fixed):** rafi's per-test JSON report (`.rafi/cache/run-<ticket>-<n>.json`, inside the worktree agents read) held raw failure messages with a declared secret; the canary grep found it. It's now rewritten redacted once read (the fix step reads it again). Also the C52 model check started Codex with `deps.env` and Claude with the SDK's default (whole shell); both now get the agent allowlist.

| # | Choice | Why |
|---|---|---|
| C93 | Every Codex approval is an escalation; a permissions request is answered `{ permissions: {} }` whatever the decision | ARCH 7.11 "answered with no added permissions" |
| C94 | The fake's top-level `bash` is an escalation (asks); `steps.shell` runs in the sandbox unasked; `steps.escalate`, `steps.permissionsRequest` added | Keeps M1's fidelity test unchanged |
| C95 | Declared secret-looking names are registered by `start` through `engine.secret(value, name)` (the engine opens before the config is read), not `redactor(env, declared)` | Same effect, no new engine API |
| C96 | Encodings add url-safe variants of the three base64 cores | Catches base64url inside a longer string |
| C97 | `rafi secrets` and its subcommands are `noProject` until M7 | S-CLI-1 runs outside a project |
| C98 | A1/A2 and A5/A6 share a build each; threat 30's tests are in `ST/security-t30.test.ts` | Fast-suite wall time |

Changed existing tests: `fidelity-m2` (the builder test now expects the profile; the QA test's internet half uses QA; the declined-edit test edits outside the root; Claude QA expects no rafi `TMPDIR`; one pre-existing `models` type error), `checks-m2` (`checksEnv`), `sandbox.test`/`sandbox.real.test` (`testEnv` replaces `checkEnv`). `deps/` unchanged (636/650).

**Unverified, added to the live script's rows** (`scripts/live/rewrite-adapters.mjs --list`): that both runtimes log in with the allowlisted environment (every row); Codex escalation declined in a real turn (`codex-escalation`); a shell write to `.rafi/` under the shipped profile (`codex-profile`); a rule-allowed `npm test` writing `.rafi/` and the shell env in a real turn (`codex-rule-env`); Claude QA's temp file with no rafi `TMPDIR` (`claude-qa`); the canary out of Claude's Bash and S0.5's scrub (`claude-env`). Linux/Windows profile enforcement: CI (`.github/workflows/rewrite-fast.yml`, Linux and macOS).

**Review 2 fixes** (`.rafi-build/M2-review2.md`; red runs `.rafi-build/M2-red/r2-<n>*.log`, each failing on its own assertion first):

- **1. Fixed (decided by the user, 2026-11-03).** The decision: redaction learns every declared value, every value rafi hands a child from `checks.env`, `agents.env` or the secrets store, whatever its name, if it's at least 8 characters, with its base64, base64url, hex and URL-encoded forms; the base set and the cache variables are never learned; a redacted value is labeled with its variable name; secret-named variables are learned as before. NEW-SEC-8 (`REWRITE_REQUIREMENTS.md:1077`), ARCH M2 Builds (`:1692`) and ARCH 7.12 (`:1175`, `:1176`) now say so. Built: `declaredValues` in `E/build/env.ts` replaces `declaredSecrets` (`start` registers each through `engine.secret`); the names never learned are `BASE` plus `cacheVars`'s names (`TMPDIR` among them), matched case-insensitively on Windows; a secret-looking declared name (`looksSecret`) keeps the redactor's 6-character floor, a plain one needs 8 (`MIN_DECLARED`). The secrets store doesn't exist in M2 (no `deps.secrets` yet), so only `checks.env` and `agents.env` are learned now. Two more places the test found: rafi's per-test JSON report is now rewritten with every string redacted (test and file names, not only failure messages: the fake runner took `-t <value>` as a file name), and `run_check`'s reply redacts the echoed command. Ordinary words of 8 or more characters declared as values (`production`) are now redacted everywhere, as decided. Test: `ST/security-sec.test.ts` "review 2, finding 1" (a `checks.env` `DB_URL` printed raw and base64 by a failing test; an `agents.env` `DEPLOY_REGION` in the builder's `run_check` command and reply; checked in every agent message, tool reply, project file, the terminal and `stats export`, and the `[REDACTED:<name>]` label in the fix and review messages and the export). Red: `r2-1.log` (raw in tool replies, the fix and review messages, `.rafi/cache/run-T1-*.json`, `state.sqlite3`, the terminal and the export). Unit: `ET/build/env.test.ts` (every declared value; the 8-character minimum; the base set and cache variables never learned, Windows casing included; encoded forms and the label), written after the code and shown red by reverting one rule each (`r2-1-base.log`, `r2-1-min.log`).
- **2. Fixed.** On Windows a declared name now finds the shell's differently cased one for `env_missing` and redaction (`lookup` in `E/build/env.ts`; `declaredSecrets` takes the platform). Test: `ST/security-sec.test.ts` "review 2, finding 2", with Windows simulated through `deps.machine.platform` (new optional `Computer.platform` in the harness). Red: `r2-2.log` (env_missing), `r2-2-redaction.log` (the value unredacted). Unit: `ET/build/env.test.ts` "Windows: …".
- **3. Fixed (P20).** Checked first: `agentEnv` always kept `TMPDIR`, and the QA session got it. `agentEnv` now takes the role and drops `TMPDIR` for Claude QA, even a declared one (ARCH 7.11 `:1155`). Codex QA and both builders keep the shell's `TMPDIR`, because 7.11 sets nothing for Codex QA (C77). Test: "review 2, finding 3" (red `r2-3.log`, run with the drop disabled because the role parameter was already in place). The fidelity test now checks only that the adapter adds nothing of its own.
- **4. Fixed.** Untrusted text outside a quoted block, in every message kind: the review message (changed files, run commands), the fix message's header (the run's command), the repair message (V8's parse error quotes the reply's text: `Unexpected token 'I', …"IGNORE PRE"…`) and the retry note (validation errors quote the reply: a requirement's text, a check). Each is now quoted and escaped. Prepare and build had nothing outside quotes. Test: `ST/security-m2.test.ts` "review 2, finding 4", which checks every message and that each hostile value reached its kind. Red runs, one kind at a time: `r2-4.log` (retry), `r2-4-repair.log`, `r2-4-review.log`, `r2-4-fix.log`. Left as it was: `run_check`'s reply echoes the calling agent's own command.
- Changed tests: `ET/build/env.test.ts` (`declaredSecrets` → `declaredValues`), `ET/turns/turns.test.ts` (repair text), `SS/checks.scenario.ts` S-CHK-10 (the command is now inside the quoted details), `ST/fidelity-m2.test.ts` (Claude QA env).

## Questions for the user

None. All were answered on 2026-11-02 (see 1.2 and C60).
