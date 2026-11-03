# M1 implementation plan: foundations and the harness

Status: **audited** (parts 1–2, plan and audit). Next: implement (part 3).
Milestone: `REWRITE_ARCHITECTURE.md` (ARCH) section 14, M1. Rules: `REWRITE_BUILD_HANDOFF.md`.
Written 2026-11-02 against `feature/rewrite` at `d14b3ce`. Updated 2026-11-02 with the audit (`.rafi-build/M1-audit.md`; section 10) and the user's approval of P1–P7, which are now in the locked docs (section 8). No code was written for this plan.

## 0. What M1 delivers

From ARCH 14 M1 (`REWRITE_ARCHITECTURE.md:1631-1638`) and the handoff (`REWRITE_BUILD_HANDOFF.md:61-86`):

- **First:** the fake `claude` check (D9, ARCH 11.7), time-boxed to half a day.
- **Builds:** `packages/engine` with `deps` and their real versions; `scripts/check-rules.mjs`; the event log (tables, append, cursor reads, lease, blobs, migrations); `nextTicket`, `nextBuild`, `nextProject`, the fold, `decide` and the label maps; the `standard` workflow and the role registry as data, with load checks, and transition tests built from that data; `runCli` with every command and its help text (unbuilt commands say so and exit 1); dropped and merged commands and flags exiting 1 and naming what replaced them; the engine switch and both format refusals; thin adapters over the `deps` transports; `packages/scenarios` (fixtures, script engine, in-process Codex and Claude fakes, the Codex fake executable, the fake `claude` if D9 passes, fake clock, notifier and terminal, crash and pause hooks with the write fence, invariant checker, transcript, coverage ledger).
- **Must pass:** S-CLI-1, S-CLI-2.
- **Partial:** S-ENG-5 steps 1, 2 and 4 (process set); S-MIG-2 step 1.
- **Done when:** S-CLI-1 and S-CLI-2 pass; every (state, event) pair is tested for ticket, build and project; the log tests and fake-fidelity tests pass; the M1 security tests pass; the fast suite runs in under 60 s on 4 workers.

Not in M1: the turn runner, reply schemas (6.2–6.4), `run_check`, the build loop, the progress file, real notifications, readiness. Each is listed against its milestone in ARCH 14.

### 0.1 Facts checked in this session

| Fact | Evidence |
|---|---|
| Node 24.21.0, pnpm 10.2.1; workspace is `packages/*` | `node --version`, `pnpm --version`, `pnpm-workspace.yaml` |
| Packages today: `ai-foreman`, `rafi`, `spec`, `special-agents`; no `engine` or `scenarios` | `ls packages` |
| The name `ai-foreman` is taken in the workspace by today's engine (2.0.2) | `packages/ai-foreman/package.json` |
| Installed: Agent SDK 0.3.159 (optional dependency of ai-foreman, `^0.3.148`), better-sqlite3 13.0.3, zod 4.4.3, yaml 2.9.0, commander 12.1.0, `@clack/prompts` 1.5.0, tsx 4.22.4, typescript 5.9.3 | `node_modules/*/package.json`; `packages/ai-foreman/package.json:317-318` |
| `rafi-spec` exports only `.` and resolves to `dist/` | `packages/spec/package.json` `exports` |
| The launcher imports `ai-foreman/runtime-preflight.js`, then `./index.js` | `packages/rafi/src/launcher.ts:7,15-16` |
| `rafi`'s tsconfig includes `src/**/*.ts`, so `src/next/` is compiled with the CLI | `packages/rafi/tsconfig.json` |
| A Windows/macOS/Linux GitHub Actions matrix exists, on tags and manual dispatch only | `.github/workflows/build-recovery.yml:1-16` |
| The Codex fake to start from answers `thread/start`, `thread/resume`, `turn/start`, sends usage, the final message and `turn/completed`, and fires one-shot faults by marker files | `packages/rafi/test/fixtures/e2e-codex-faults.cjs:161-205` |
| 0.10.x's unfinished builds are `workflow_runs` rows with `kind='build'` and a status other than `completed`, `cancelled`, `superseded`, in `.rafi/recovery.sqlite3` | `ai-foreman/src/workflowReader.ts:76`; `buildRuns.ts:473`; `workflowDb.ts:88` |
| 0.10.x records the project path in its recovery state and refuses a moved copy | `ai-foreman/src/buildWorkMigration.ts:20` |
| 121 scenarios in SCN; each is in exactly one milestone's "Must pass" list | `grep '^#### S-'` gives 121; the Must-pass lists in ARCH 14 give 121 unique IDs and no duplicates |
| 638 requirement IDs in REQ sections 2–8, and the same 638 in SCN section 10 | first-column IDs extracted from both docs; `comm` shows no difference |

## 1. Step 0: the fake `claude` check (D9)

**Status: not run.** This plan writes no code, so the check's result isn't known. It's the implementer's first task.

**What I could check without running it** (SDK 0.3.159, minified `sdk.mjs`, located by search string because the file has no useful line numbers):

- The SDK picks how to start the executable by its extension. A path ending `.js`, `.mjs`, `.ts`, `.tsx` or `.jsx` is run as `node <path> …` (`getDefaultExecutable()` returns `node`, or `bun` under Bun); any other path is spawned directly (`function fx`). So `pathToClaudeCodeExecutable` can point straight at `claude-cli.mjs`, while a `claude` shim found on `PATH` (how rafi finds it) needs a shebang and the execute bit, and a `claude.cmd` on Windows.
- The SDK deletes `NODE_OPTIONS` from the child's environment, so the fake must be plain JavaScript with no loader such as tsx.
- It passes `--output-format stream-json`, `--input-format`, `--verbose`; `initialize`, `can_use_tool` and `hook_callback` appear in `sdk.mjs` (the strings ARCH 11.7 cites).
- `pathToClaudeCodeExecutable` is at `sdk.d.ts:1623`, `spawnClaudeCodeProcess` at `sdk.d.ts:1945`, `query` at `sdk.d.ts:2391`.

**The check** (ARCH 11.7 steps 1–5):

1. Write `packages/scenarios/fakes/claude-cli.mjs` (plain ESM, under 300 lines): answers `--version`; reads stream-json lines on stdin; answers the `initialize` control request; on each user message emits `system/init` with a session id, a `hook_callback` for `SessionStart` when one is registered, one `can_use_tool` request for a scripted Bash call, an `assistant` message calling `StructuredOutput` with the scripted object, its `tool_result`, and a `result` with `structured_output`, usage and cost; honors `--resume <id>`; handles interrupt; exits when stdin closes. The script path is baked into a per-test shim (choice C12), never an option rafi passes.
2. `packages/scenarios/test/d9-claude-cli.test.ts`: drive it with the installed SDK's `query()`, `pathToClaudeCodeExecutable` set to the fake, streaming input, `outputFormat`, `canUseTool`, a `SessionStart` hook, then an interrupt in one run and an abort in another.
3. **Pass:** `structured_output` arrives, the hook and `canUseTool` fire, and interrupt and abort end the fake with no SDK error. Then the fake joins the process set, scripted from the same rules as the in-process fake.
4. If the SDK refuses to start it: start it through `spawnClaudeCodeProcess` with the path from config (SCN 7.3), and repeat step 2.
5. **If the protocol can't be faked:** decision 3 (ARCH:1715). The process set's Claude rows use the in-process fake plus the live suite, and no test-only code goes into the adapter. D9 then needs amending in the locked docs, which the user approves: the implementer **stops and reports** with the evidence (the SDK error and the message exchange) instead of editing SCN or ARCH.

Either way the implementer records the outcome in the milestone report and keeps the test: as a passing fidelity test, or as a skipped test that names the failure.

## 2. Files to add or change, with budgets

Budgets are lines as `wc -l` counts them. Every file stays under 500 lines, functions under 100, lines under 120 characters (ARCH 2.4). Module totals are ARCH 2.2's; M1 uses part of some.

### 2.1 `packages/engine` (new, private; name `@rafi-ai/engine`, choice C1)

| File | Holds | Budget |
|---|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.build.json` | ESM, Node 24; deps `better-sqlite3`, `rafi-spec`, `yaml`, `zod`; optional `@anthropic-ai/claude-agent-sdk`; devDeps `@types/better-sqlite3` (`^7.6.13`, as `ai-foreman/package.json:336`), `@types/node`, `typescript`, `tsx`; no `bin`. Exports `.`, `./deps/real`, `./agents`, each with `source`, `types`, `default` conditions (choice C26) | — |
| `src/index.ts` | Public exports: `openEngine`, types, `Deps` | 40 |
| `src/agents/index.ts` | The `./agents` export: the real Codex and Claude adapter factories and the Codex transport, for the fidelity tests | 20 |
| **`deps/`** (module budget 650) | | |
| `src/deps/types.ts` | The whole `Deps` interface of ARCH 8.2, plus `Db`, `JsonRpcStream`, `ClaudeQuery`, `Terminal`, `Notifier`, `Fs`, `ExecResult`, `Owner`, `TimerKind`, `Cancel` | 220 |
| `src/deps/real/clock.ts` | `now`, `timer`, `sleep` on real timers | 50 |
| `src/deps/real/fs.ts` | Async `read`, `writeAtomic` (temp + rename), `append`, `rename`, `remove`, `mkdir`, `stat`, `list` | 90 |
| `src/deps/real/exec.ts` | `git` and `exec` with argument arrays, never `shell: true` | 80 |
| `src/deps/real/db.ts` | `open(path, { readonly? })` over better-sqlite3; `busy_timeout` 0 (retry is on the clock) | 60 |
| `src/deps/real/processes.ts` | `self()` and `isAlive()`: same host, pid running, start time matching (from `/proc` on Linux and `ps -o lstart=` on macOS, as `ai-foreman/src/processIdentity.ts:50,58` do; Windows returns "start time unknown" and compares pid and host only) | 90 |
| `src/deps/real/agents.ts` | `codex()`: spawns `<executable> app-server --listen stdio://` as a `JsonRpcStream`; `claudeQuery`: the SDK's `query`, loaded on first use | 70 |
| `src/deps/real/terminal.ts` | `process.stdin`/`stdout`/`stderr`, `isTTY`, size, title, SIGINT, resize | 60 |
| `src/deps/real/index.ts` | Builds the M1 set; `checks`, `serve`, `spawnBackground`, `logChanged` and the real notifier throw "not available until M<n>" (nothing in M1 calls them) | 40 |
| **`log/`** (900) | | |
| `src/log/db.ts` | Open through `deps.db`, WAL, `PRAGMA user_version`, run migrations in one transaction, `BEGIN IMMEDIATE` writes, `SQLITE_BUSY` retry with backoff on `deps.clock` up to 30 s, then a `storage` error | 160 |
| `src/log/migrations/001-initial.ts`, `migrations/index.ts` | The three tables and four indexes of ARCH 3.2, verbatim; the ordered list | 60 |
| `src/log/append.ts` | `append(events, { idemKey })`: validate each against rafi-spec, redact, check 64 KB, check the transition (an invalid one throws, nothing written), idempotency replay, one transaction per outcome | 190 |
| `src/log/read.ts` | Read by cursor (`seq > n`), by run, by ticket; validate on read (choice C9); `origin` filter | 120 |
| `src/log/lease.ts` | Acquire (only when there's no row or the owner isn't alive), heartbeat, release; compare-and-swap (choice C15) | 120 |
| `src/log/blobs.ts` | Put by SHA-256 digest, bounded (choice C16), `sensitive` flag; get | 80 |
| `src/log/redact.ts` | The one `redact()` (choice C8) and `escapeControl()` for rendering | 90 |
| **`state/`** (1,300) | | |
| `src/state/types.ts` | `TicketState`, `BuildState`, `ProjectState`, `Folded`, `Liveness`, `Action`, `Violation`, `TicketRules` | 150 |
| `src/state/ticket.ts` | `nextTicket`, reading the pinned workflow from `TicketRules.workflow` (ARCH 4.1; choice C4) | 300 |
| `src/state/build.ts` | `nextBuild` (ARCH 4.3, including `pausing`, `unpausing` and stop-now flags) | 150 |
| `src/state/project.ts` | `nextProject` (ARCH 4.4) | 120 |
| `src/state/fold.ts` | `fold(events, ctx)` → `{ project, builds, tickets, questions, answers, grants, units, violations }`; skips `detail` and `imported`; never throws | 200 |
| `src/state/decide.ts` | `decide(view, live)`, rules 1–9 of ARCH 4.5 | 260 |
| `src/state/labels.ts` | Engine state → tracker status (ARCH 4.2) and the GUI lifecycle labels (ARCH 4.4) | 120 |
| **`workflow/`** (400) | | |
| `src/workflow/standard.ts` | `standard` as frozen data (choice C5) | 90 |
| `src/workflow/roles.ts` | planner, ticket-maker, builder, qa, manager: core-instruction ref, reply-schema ref, permissions, default agent | 90 |
| `src/workflow/load.ts` | Look up a workflow by id and version, compute its digest | 60 |
| `src/workflow/checks.ts` | The five load checks of ARCH 4.8 | 150 |
| **`agents/`** (thin; module budgets 700 / 600 / 600, completed in M2) | | |
| `src/agents/types.ts` | The `Agent`, `TurnRequest`, `AgentEvent` interface of ARCH 11.6 | 120 |
| `src/agents/codex/transport.ts` | JSON-RPC over a `JsonRpcStream`: request ids, responses, notifications; `meta` passed beside each message (choice C11) | 150 |
| `src/agents/codex/adapter.ts`, `codex/events.ts` | `thread/start` or `thread/resume`, `turn/start` with `outputSchema`, `turn/interrupt`; map `item/*`, `thread/tokenUsage/updated`, `turn/completed` to `AgentEvent`s | 200, 120 |
| `src/agents/claude/options.ts`, `claude/adapter.ts`, `claude/events.ts` | Streaming-input `query` with `outputFormat`, `canUseTool` routed to a `permission` event, abort and interrupt; map `system`, `assistant`, `user`, `result` messages | 80, 200, 120 |
| **Others started in M1** | | |
| `src/api/engine.ts` | `openEngine({ projectDir, deps })`: opens the log, runs the workflow load checks, exposes `events({ from, run })` and a read-only `fold()`; the rest of ARCH 8.3 comes with its milestone | 150 |
| `src/config/load.ts` | Reads `rafi-config.yaml` through `deps.fs`, validates the 1.0 subset (choice C17) | 140 |
| `src/migrate/legacyRuns.ts` | Read-only lookup of an unfinished 0.10.x build in `.rafi/recovery.sqlite3` (fact table, row 9), for the refusal line | 60 |
| `test/**` | Unit tests (section 3.2), mirroring `src/` paths (choice C6) | — |

M1 engine source total: about 4,900 lines, against ARCH 2.2's module budgets.

### 2.2 `packages/spec` (changed)

| File | Holds | Budget |
|---|---|---|
| `package.json` | Add a `./v1` export with a `source` condition pointing at `src/v1/index.ts` (choice C2) | — |
| `src/v1/index.ts` | Re-exports | 30 |
| `src/v1/events/envelope.ts` | The envelope columns of ARCH 3.2 (`id`, `run_id`, `ticket_id`, `type`, `v`, `class`, `at`, `actor`, `source`, `origin`, `idem_key`) | 80 |
| `src/v1/events/{project,build,turns,results,tickets,questions,history}.ts` | A zod schema for every event type in ARCH 3.4, groups A–G, all at `v: 1`, including `project.archived`/`project.unarchived` (empty payload) and `checks.failed`'s `circling` field, which 3.4 now lists (P1, P5 applied) | 7 files, 120–300 each |
| `src/v1/events/registry.ts` | `type → { class, schema }`, used by append, read and the transition tests | 80 |
| `src/v1/config.ts` | The 1.0 config subset (choice C17): `format_version: 1`, the reserved `workflows:` key rejected with "Custom workflows aren't supported yet." | 120 |
| `src/v1/tickets.ts` | M1 part only: the reserved ticket `workflow` field, rejected with the same message (the rest of the 1.0 ticket schema comes with the ticket port in M2) | 40 |
| `test/v1/*.test.ts` | Schema tests | — |

The old schemas in `spec/src/*.ts` don't change.

### 2.3 `packages/rafi` (changed; old layer untouched)

| File | Holds | Budget |
|---|---|---|
| `package.json` | Add `"@rafi-ai/engine": "workspace:*"` (choice C1); add a `./next` export (`source` → `src/next/cli.ts`, `types` → `dist/next/cli.d.ts`, `default` → `dist/next/cli.js`) beside the existing `.` (choice C26) | — |
| `src/launcher.ts` | Keeps the preflight (lines 7–14); adds the engine switch: reads `RAFI_ENGINE` once; `next` → `process.exitCode = await runCli(process.argv.slice(2), realDeps())`; otherwise, unless argv is a version or help form (choice C14), D6's refusal check, then today's `startRafiCli()` | +25 |
| `src/next/cli.ts` | `runCli(argv, deps)`: a fresh Commander program per call, `exitOverride`, output through `deps.terminal`; order: dropped/merged check → parse (version and every help form answered here, and return) → find project → format check → command (choice C13) | 180 |
| `src/next/deps.ts` | `realDeps()`: wires `engine/src/deps/real` | 60 |
| `src/next/format.ts` | Finds the project from argv (project argument, `-p`/`--project`, else the nearest `rafi-config.yaml` upward) and reads the `format_version: 1` marker, through an `Fs`-shaped argument, so the launcher (with `node:fs`) and `runCli` (with `deps.fs`) share it. Imports only `yaml` and `node:path` (choice C14) | 120 |
| `src/next/commands/common.ts` | Shared option builders (`-p`, `--auto-approve` with `-y`/`--yes`, agent overrides), `notBuilt(milestone)` | 120 |
| `src/next/commands/dropped.ts` | The dropped and merged commands, flags and Manager host commands, with what replaced each (section 5.2) | 200 |
| `src/next/commands/<name>.ts` | One file per top-level command: `create`, `compile`, `plan` (with `changes`, `restore`), `start`, `resume`, `answer`, `stop`, `reset`, `agents`, `manager`, `status`, `doctor`, `graph`, `sources`, `discover`, `uninstall`, `uninstall-restore`, `uninstall-cleanup`, `qa-rehearse-rollback`, `stats`, `logs`, `tools`, `migrate`. Each defines its arguments, options and help text, and runs `notBuilt(Mn)` in M1 | ~23 files, 30–150 each |
| `src/next/commands/tickets/*.ts` | The 24 kept `tickets` subcommands (REQ 2.4, without `import`), split by group so no file passes 500 lines: `setup.ts`, `define.ts` (init, populate, plan, repair, groups, review), `status.ts` (update, complete, block, unblock, cancel, reset), `read.ts` (show, queue, validate, render, archive), `future.ts` (discover, accept-future-work, reorder, waive-risk-notes) | 5 files, ≤ 350 each |
| `src/next/ui/lines.ts` | M1 part: the one-line error and refusal formats, `rafi:` prefix (Q-OUT-2) | 60 |

M1 CLI total: about 2,800 of ARCH 2.3's 5,500.

### 2.4 `packages/scenarios` (new, private; name `@rafi-ai/scenarios`)

| File | Holds | Budget |
|---|---|---|
| `package.json`, `tsconfig.json` | Private; devDeps on engine, cli, spec (`workspace:*`), `@anthropic-ai/claude-agent-sdk` (`^0.3.148`, as `ai-foreman/package.json:318`; the D9 and fidelity tests call its `query` directly), `tsx`, `@types/node`. `tsconfig.json` sets `customConditions: ["source"]` (choice C26) | — |
| `harness/scenario.ts` | The `scenario({ id, covers, modes, fixture, agent, steps, run })` API of SCN 7.9; per-step `pending("M4")`; results `pass`, `fail`, `not run (pending Mn)`, `n/a` | 200 |
| `harness/rafi.ts` | In-process `rafi(argvString, { tty, env })`: fresh harness deps per call, `runCli`; returns exit code, raw and ANSI-stripped output, screen | 160 |
| `harness/deps.ts` | Harness `Deps`: real `fs`/`git`/`exec`/`db` wrapped by the fence, fake clock, notifier, terminal, hooks, seeded `random`, per-"computer" `machine.stateDir`, `env` snapshot | 200 |
| `harness/fence.ts` | `HarnessCrash`; after it, every write, rename, remove, database write and git command from that instance throws; open transactions are rolled back; its timers are dropped | 140 |
| `harness/hooks.ts` | `crash.at(k)`, `pause.at(k)`; the boundary recorder naming each occurrence ("4: recorded, before progress write (T2, review, 2nd)"); the boundary names of ARCH 4.6 as data | 140 |
| `harness/process.ts` | Process mode: spawns the built launcher, `node packages/rafi/dist/launcher.js` (SCN 7.2), with fakes first on `PATH` and `RAFI_ENGINE` as the step says; refuses to run if `dist/launcher.js` is older than `src/launcher.ts` or `src/next/`; records each child's environment (choice C25) | 160 |
| `harness/after-each.ts` | S-CLI-2 step 4's checks, run after every scenario (section 5.2) | 120 |
| `harness/fast.mjs` | The fast-suite runner, from `ai-foreman/scripts/test-offline.mjs`: isolated jobs, `RAFI_TEST_CONCURRENCY` (default 4), totals, slowest files; fails over 60 s wall time | 120 |
| `fakes/script/parse.ts`, `script/engine.ts` | Rule grammar of SCN 2.2 (`builder T2#1: blocked(…)`); matching by role, ticket, step, attempt from `meta`; behaviors; happy paths registered per role (choice C10) | 200, 300 |
| `fakes/codex/stream.ts`, `codex/wire.ts` | In-memory `JsonRpcStream` driven by the script engine; the wire encoder, ported from `ai-foreman/test/helpers/nativeOutput.ts:6` | 200, 120 |
| `fakes/codex-cli.mjs` | Fake `codex app-server` executable for the process set, rewritten from `rafi/test/fixtures/e2e-codex-faults.cjs`: reads a script file instead of `RAFI_E2E_FAULT`, same operation log and one-shot faults | 300 |
| `fakes/claude/query.ts` | In-process `ClaudeQuery` driven by the script engine (model: `ai-foreman/test/qaGuidanceDelivery.test.ts:90-101`) | 220 |
| `fakes/claude-cli.mjs` | Fake `claude` executable (section 1), if D9 passes | 300 |
| `fakes/clock.ts` | Fake clock (SCN 7.4): starts 2026-11-01T14:00:00Z; auto-advances to the next `timeout`, `backoff` or `agent` timer only when idle (choice C18); never to `reminder` on its own; `advance(d)` | 160 |
| `fakes/notifier.ts` | Records sends, updates, closes; `answer()`; the five modes of SCN 7.5 | 120 |
| `fakes/terminal.ts` | 120×24 screen model (choice C7): pinned bottom lines, title from OSC 0/2, raw and stripped output; pipe mode | 260 |
| `fakes/shims.ts` | Writes per-scenario `PATH` shims (`codex`, `claude`, `claude.cmd` on Windows) with the script path baked in | 80 |
| `fixtures/common.ts` | Temp git repo, one commit, fixed author, `TZ=UTC`, 1.0 file writers | 160 |
| `fixtures/f-one.ts`, `fixtures/f-chain.ts` | F-ONE and F-CHAIN (SCN 2.1) | 80, 100 |
| `fixtures/legacy/generate.mjs` | One-time generator: runs 0.10.2 (`packages/rafi/src/index.ts` under tsx) against the Codex fake to make F-LEGACY and its unfinished-build variant (choice C19) | 250 |
| `fixtures/legacy/F-LEGACY/…`, `F-LEGACY-RUNNING/…`, `manifest.json` | The frozen files, plus which paths git tracks | data |
| `checks/invariants.ts` | S-CRASH-1's invariants over a `rafi-events` export (choice C20) | 200 |
| `checks/transcript.ts` | JSONL transcript per scenario and its helpers (SCN 2.2, 7.3) | 160 |
| `checks/ledger.ts`, `checks/registry.ts` | The coverage ledger; the 121 registrations with `covers` and milestone (choice C21) | 250, 450 |
| `checks/import-docs.mjs` | Generates `registry.ts` from SCN and ARCH 14 once; rerun when the docs change | 150 |
| `scenarios/cli.scenario.ts` | S-CLI-1, S-CLI-2 | 400 |
| `scenarios/engine.scenario.ts` | S-ENG-5 (steps 1, 2, 4 now; 3 pending M2) | 200 |
| `scenarios/migrate.scenario.ts` | S-MIG-2 (step 1 now; 2, 3 pending M9) | 120 |
| `test/*.test.ts` | Fidelity tests, the D9 test, fence, clock, terminal, script-engine tests | — |

### 2.5 Repo root

| File | Holds | Budget |
|---|---|---|
| `scripts/check-rules.mjs` | ARCH 2.4's rules with the TypeScript compiler API (section 6.1) | 400 |
| `scripts/check-rules.test.mjs` | One planted violation per rule, and a clean file that passes | 250 |
| `package.json` | Scripts `test:fast` (`node packages/scenarios/harness/fast.mjs`), `test:process` (first `pnpm -r --filter "@rafi-ai/cli..." build`, which builds the CLI and every workspace package it depends on, including today's `ai-foreman` for S-ENG-5 step 1, then the process-set tests; choice C25), `check:rules`; `typescript` as a root devDependency so the script doesn't rely on hoisting | — |
| `.github/workflows/rewrite-fast.yml` | The fast suite on `windows-latest`, `macos-latest`, `ubuntu-latest`, Node 24, pnpm 10.2.1, on pushes to `feature/rewrite` and manual dispatch | 40 |

## 3. Tests to write first

Test-first, in this order. Each is written, run and seen to fail before the code it checks exists.

### 3.1 Scenarios

1. **The ledger registry**: all 121 scenarios registered with their `covers` lists and milestone; the 117 not active in M1 report "not run (pending Mn)". The ledger test (choice C21) fails until every REQ ID is covered or on SCN 10's not-testable list.
2. **S-CLI-1**, the command list: `rafi --version`, `rafi -V`, `rafi --help`, then `rafi help <command>` and `rafi <command> --help` for every command and subcommand, run in a temp directory with no `rafi-config.yaml` above it, so none of them needs a project (choice C13). Asserts: the version prints; help lists every kept command plus `answer`, `stop`, `reset`, `stats`, `logs`, `tools`, `migrate`; each has its own help; `rafi stats --help` lists `show`, `timeline`, `export`, `delete` and neither `compare` nor `replay`; exit 0; nothing written.
3. **S-CLI-2**, dropped and merged items (section 5.2 for the full lists):
   - Step 1: each dropped or merged command and each dropped flag exits 1 as unknown, names its replacement where it has one, and writes nothing (`git status` clean, no new files).
   - Step 2: `rafi start . --steps 1` with each of the 18 old forms, then the three old `resume` flags: exit 1 before any agent turn, nothing written, and the message names `--allow`, `--completion` or the config key. `rafi resume --yes` is no longer in step 2's list (P3 applied). The step's last expected line, "`-y` and `--yes` still work as aliases", is checked by running `rafi start . --steps 1 -y`, `--yes` and `rafi resume --yes`: none is refused as an unknown option; in M1 each ends with the "not built yet" line.
   - Step 3: neither `@rafi-ai/cli` nor `@rafi-ai/engine` declares an `ai-foreman` bin, and the CLI's `bin` holds only `rafi`.
   - Step 4: `after-each.ts`, run after every scenario.
4. **S-MIG-2 step 1**: `RAFI_ENGINE=next rafi start . --steps 1` on F-LEGACY exits 1 with one line saying the project uses 0.10.x formats and to run `rafi migrate`; nothing written. Steps 2–3 pending M9.
5. **S-ENG-5 steps 1, 2 and 4** (process set):
   - Step 1: on a 0.10.x F-ONE, without `RAFI_ENGINE`, the old engine builds `T1` against today's Codex fake.
   - Step 2: on 1.0 F-ONE, without `RAFI_ENGINE`, exit 1, exactly "This project uses 1.0 formats; set RAFI_ENGINE=next.", `git status` clean, no `.tickets/ticket-state.sqlite` or `.foreman/`.
   - Step 4: `RAFI_ENGINE=next rafi resume` on F-LEGACY-RUNNING exits 1; the line names the unfinished run and gives `rafi resume` and `rafi build:reset`, run without `RAFI_ENGINE`.
   - Step 3 (one-process tree during a build) is pending M2. Steps 2 and 4 also run in-process, where they're cheap, through the launcher's shared `format.ts` and `runCli`.

### 3.2 Engine and harness tests

6. **Transition tests**, `engine/test/state/transitions.test.ts` (choice C5): every (state·step, event variant) pair for the ticket, built by walking `standard`'s nodes and every ticket-scoped state event from the registry, checked against ARCH 4.2's table as data, including every "no change" pair. Build: every (state and flags, event) pair against ARCH 4.3. Project: every (state, event) pair against ARCH 4.4. An invalid pair: `append` refuses it, and `fold` keeps the state and reports a violation without throwing.
7. **Workflow load-check tests**: `standard` passes; planted broken workflows fail each of the five checks (an unreachable step, a fail path that doesn't end, a loop without a limit, an unknown role, a `checker` step with a write role).
8. **Fold, `decide` and label tests**: `decide` rule by rule (1–9), with a table of folded views and expected actions; tracker status and GUI labels for every state.
9. **Log tests** (ARCH 14 M1 "Also"): append-only (no API updates or deletes; rows unchanged after later appends); replay from a cursor (exact order, resumes from any `seq`); idempotency keys (a second append with the same key writes nothing and returns the first result); busy retry on the fake clock (busy injected for 5 s retries with backoff and succeeds; for 31 s it gives a `storage` error, on fake time only); the fence (section 4); migrations (a fresh database reaches the latest `user_version`; reopening runs none; migrations hold no `CREATE TRIGGER`); the 64 KB limit; blobs by digest; the lease (acquire, refuse while the owner is alive, take over when it's dead, compare-and-swap under a race between two instances).
10. **Fidelity tests**: each fake's wire output is parsed by the real adapters. The in-process Codex stream and the Codex executable (through the real `deps.agents.codex` transport) under the real Codex adapter; the in-process Claude `query` and, if D9 passes, the `claude` executable (through the real SDK `query`) under the real Claude adapter. Each covers one turn with a schema, activity, a tool event, usage, a permission request, and cancel; each asserts the same `AgentEvent` sequence from both fakes of a runtime, and that `meta` never reaches the wire.
11. **Harness unit tests**: the fake clock (auto-advance only when idle, never to a reminder), the screen model (pinned lines, title, scroll region, clack's cursor sequences), the script-engine grammar, crash naming, and the after-each checks catching a planted forbidden folder.

## 4. Security tests

ARCH 1.2 and M1's "Security" line (`REWRITE_ARCHITECTURE.md:1635`). M1 isn't done until all pass.

| Threat (1.2) | Test |
|---|---|
| Secrets leak | `redact()` on every write: a secret in a string field of every event group, in nested objects and arrays, and in a blob is stored redacted. Covered: token prefixes (`sk-`, `ghp_`, `glpat-`, `xox?-`, `AKIA…`), `key=value` forms (`api_key`, `token`, `password`, `secret`, `authorization`, `Bearer …`), credentials in URLs, PEM private-key blocks, and the exact values of `deps.env` variables with secret-looking names. A stats-style read returns no secret. `escapeControl()` escapes terminal control characters. |
| Rafi's records after a crash | The write fence: after `HarnessCrash` thrown inside an append transaction, the transaction isn't committed; a `finally` block that writes a file, renames, removes, appends an event or runs git throws and changes nothing; the dead instance's timers never fire; a fresh instance on the same directories reads the log as it was. |
| Damaged or hostile files | Validated on read. The log: a row with bad JSON, an unknown type, an unknown `v`, data failing its schema, or data over 64 KB is reported as a violation and not folded, and `fold` doesn't throw. Config: invalid YAML, `format_version: "1"` (a string) or `2`, a `workflows:` key: exit 1 with one line, nothing written. Tickets: the `workflow` field rejected. |
| Imported runs | Events with `origin: 'imported'` are never folded: `fold` and `decide` give the same result with or without them, and only the stats reader returns them. |
| Hand-offs between processes | ENV-5: no process rafi starts (fakes record their environment) has `RAFI_BUILD_WORKER_RUN`, `RAFI_BUILD_WORKER_GENERATION`, `RAFI_DETACHED_SUPERVISOR_RUN`, `RAFI_BUILD_LAUNCH_TOKEN`, `RAFI_PROBE_ENV` or any `RAFI_REHEARSAL_*` (S-CLI-2 step 4). |
| Refusals write nothing | Both format refusals and every exit-1 path in S-CLI-2 leave `git status` clean and create no file, in the project or in `machine.stateDir`. |
| Code rules | `check-rules.mjs` passes on the tree, and its own tests show each rule catching a planted violation. |
| Windows | The fast suite runs on `windows-latest` (the new workflow). It can't run until the user pushes (section 9). |

## 5. Details for S-CLI-1 and S-CLI-2

### 5.1 The command surface

The authority is REQ section 2 (`REWRITE_REQUIREMENTS.md:59-315`) as amended by 9.0, plus ARCH 13's `rafi plan changes`, `rafi plan restore <revision> [--ticket <id>]` and `rafi reset` flags. Help text for kept commands starts from today's, as generated in `docs/cli.md` (1,829 lines, from today's Commander tree), with REQ's changes applied. Every option in REQ's keep and change rows is declared in M1, so S-CLI-2's "unknown option" checks and later milestones' parsing agree. Each unbuilt command prints one line, for example "rafi: `rafi start` isn't in the new engine yet (milestone M2).", and exits 1.

### 5.2 Dropped and merged items, and what each message names

| Item | Exit 1 and names |
|---|---|
| `plan:doctor`, `build:attach`, `build:resume` | `rafi resume` |
| `build:decide` | `rafi answer` |
| `build:stop` | `rafi stop` |
| `build:start-over`, `build:reset` | `rafi reset` |
| `audit` | `rafi stats show` |
| `state` | "moving a project to another computer is built in" (NEW-PORT-1) |
| `handoffs`, `tickets import` | unknown command, nothing else |
| start `--builder-network`, `--qa-network`, `--builder-approvals`; resume's three | `--allow` |
| start `--create-pr`, `--no-create-pr`, `--pr-ready` | `--completion` (`pr-ready` for the last) |
| start `--merge-method`, `--provider`, `--auto-merge-wait`, `--no-auto-merge-wait`, `--auto-merge-timeout-minutes`, `--branch-prefix`, `--max-branch-depth`, `--keep-worktrees`, `--show-session-cost`, `--hide-session-cost`, `--audit-logging`, `--auto-compact-threshold` | their `rafi-config.yaml` keys (REQ:214-225; `logs.capture` for `--audit-logging`) |
| start `-t`, `-r`, `--continue`, `--recover-run`, `--recovery-mode`, `--recovery-decision-digest`, `--qa-revision`, `--accept-handoff`, `--accept-handoff-role`, `--autonomy` (names `retries`), `--no-supervisor`; resume `--qa-revision`, `--no`, `--fresh-with-handoff`, `--fresh-session`, `--guided-recovery`; plan `--skip-run-confirmation`; tickets init `--queue-limit` | unknown option |
| resume `--inspect` | `rafi status` |
| Manager `/qa-conflicts`, `/qa-repair-plan`, `/qa-repair` (in `--ask`) | unknown Manager command (choice C13) |

**After every scenario** (`after-each.ts`): none of ARCH 12.7's paths exists in the project (`REWRITE_ARCHITECTURE.md:1580`); none of the dropped prompts' text (PRM-80, PRM-84, PRM-93–99, PRM-101, taken from REQ 3.5–3.6, `REWRITE_REQUIREMENTS.md:415-439`) appears in any output; no ENV-5 variable is set on any child process.

## 6. Order of work

Each step ends with the fast suite green, except for tests written ahead of their code.

1. **D9 check** (section 1). Half a day at most. Record the result.
2. **Skeletons and the rules.** Create `packages/engine` and `packages/scenarios` with their dependencies and exports (choice C26); add `rafi-spec`'s `./v1` export and `@rafi-ai/cli`'s `./next` export; write `check-rules.test.mjs`, then `check-rules.mjs`, so the rules apply from the first engine file.
3. **Harness core first, so scenarios can be written before the CLI:** fixtures (F-ONE, F-CHAIN), fake clock, terminal, notifier, hooks, fence, harness deps, `rafi()` runner, `scenario()` API, `after-each.ts`, `fast.mjs`. Then `import-docs.mjs`, the registry and the ledger.
4. **Write S-CLI-1, S-CLI-2, S-MIG-2 step 1 and S-ENG-5's in-process parts. See them fail.**
5. **Spec v1:** event schemas and registry, config subset, ticket reservation, with their tests.
6. **`deps`:** types and real implementations.
7. **Log:** write the log tests, then `log/*`.
8. **Workflow and state:** write the load-check, transition, fold, `decide` and label tests, then `workflow/*` and `state/*`.
9. **CLI:** `format.ts`, `cli.ts`, `commands/*`, `dropped.ts`, `ui/lines.ts`, `realDeps()`, the launcher switch, `config/load.ts`, `migrate/legacyRuns.ts`, `api/engine.ts`. S-CLI-1, S-CLI-2 and S-MIG-2 step 1 pass.
10. **F-LEGACY:** run `generate.mjs` once and freeze F-LEGACY and F-LEGACY-RUNNING; write `harness/process.ts`; build the workspace (`test:process` does it) and see S-ENG-5 steps 1, 2, 4 pass in the process set against `packages/rafi/dist/launcher.js`.
11. **Adapters and fakes:** write the fidelity tests, then the thin adapters, the script engine, the in-process Codex stream and Claude `query`, `codex-cli.mjs`, and the fake `claude` (if D9 passed) with its shims. Transcript.
12. **Invariant checker** with its tests on synthetic exports.
13. **Security tests** (section 4), plus the Windows workflow.
14. **Gate:** fast suite under 60 s on 4 workers; `check-rules` clean; report.

## 7. Implementation choices the docs leave open

| # | Choice | Why |
|---|---|---|
| C1 | The engine package is `@rafi-ai/engine` (private) until the switch, when it's published as `ai-foreman@3.0.0` (decision 1). `@rafi-ai/cli` depends on it as `workspace:*`, so **`@rafi-ai/cli` can't be published from `feature/rewrite` before the switch**; the launcher loads the new layer with a dynamic import only when `RAFI_ENGINE=next`. | `ai-foreman` is taken in the workspace (fact table). |
| C2 | `rafi-spec` gets a `./v1` subpath export whose `source` condition points at `src/v1/index.ts`; the fast suite runs with `--conditions=source`, so it needs no build step. | Its `exports` resolve to `dist/` today. |
| C3 | ARCH 2.4's bans on `Date`, timers, `process.*`, `node:fs`, `node:child_process` and database opens apply to `rafi/src/next` as well as `engine/src`, except `rafi/src/next/deps.ts`; `rafi/src/next` also may not import `ai-foreman`. `scenarios/` gets only the size rules. The launcher (`rafi/src/launcher.ts`) is outside `src/next`, so these bans don't cover it. | Keeps `runCli` free of globals (SCN 7.2); the old package is deleted later. |
| C4 | The pinned workflow reaches `nextTicket` as `TicketRules.workflow` (ARCH 4.1, as amended). `fold(events, { workflows })` resolves `build.started`'s `{id, version, digest}`, so `state/` still imports only types (the `Workflow` type from `workflow/`). | P2, approved and applied. |
| C5 | Workflow nodes have a unique `id`, the `step` name written in events, the ticket `state` it runs in, `type`, `role`, `onPass`, `onFail` and an optional `limit` (`retries.fixes`). `standard`'s check step appears as two nodes (`build-check` in `building`, `fix-check` in `fixing`), both with step name `check`. Module-scope data is wrapped in a deep `Object.freeze`. Tests live in `engine/test/` mirroring `src/`, so `transitions.test.ts` is `engine/test/state/transitions.test.ts`. | ARCH 4.2 has `check` in two states; 4.8 says steps have one next on pass and fail. |
| C6 | `requirements.written` counts as current for a ticket's definition until a material `tickets.changed` names that ticket; `ticket.started` reads that from the fold. | ARCH 4.2's first row needs it, and no event carries the definition's fingerprint. |
| C7 | The fake terminal is a small screen model written for rafi's own output (CSI cursor moves, erase, DECSTBM scroll region, OSC 0/2 title, SGR stripped, the cursor and erase sequences clack 1.5.0 emits), not a terminal-emulator library. | ARCH 13 leaves it to this plan; no new dependency. |
| C8 | `redact()` runs on every string in every event's `data` and every blob at append, except identity fields (ids, digests, tree ids, paths), and replaces with `[REDACTED]` or `[REDACTED:<ENV_NAME>]`. It unions today's patterns (`ai-foreman/src/continuity.ts:471`, `observability.ts:879`) and doesn't copy `observability.ts`'s replacement `"$1=[REDACTED]"`, which refers to a non-capturing group and inserts a literal `$1`. Redaction applies to typed answers too, so a secret typed as an answer isn't stored (ARCH 7.6, as amended). | Security first; P7, approved and applied. |
| C9 | Validation on read: `read.ts` parses each row against its registry schema; a failing row becomes a `Violation` (seq, type, reason) and is skipped by the fold. | ARCH 1.2 "validated on read", 4.1 "the fold never throws". |
| C10 | The M1 script engine covers matching and the provider-level behaviors that don't need reply schemas (reply with a given object, the three malformed forms, `hang`, `slow`, `error(…)`, `crash`, `killhost`, activity, tool events, `shell(cmd)`, `ask`). Role happy paths and verdict behaviors register in M2 and M3, when the reply schemas exist. | Reply schemas are M2 (ARCH 14 M2). |
| C11 | `meta` beside the wire: the Codex `JsonRpcStream.write(message, meta)` takes it as a separate argument, which the real stream ignores; for Claude, the adapter puts it under a `Symbol` key on each user message, which the real SDK can't serialize. A fidelity test asserts neither reaches the wire. | ARCH 11.6 says meta travels beside the message and the real transport drops it. |
| C12 | Executable fakes find their script through a per-scenario shim with the script path baked in, not through an environment variable rafi would pass along. | Keeps rafi's environment clean for the ENV-5 check. |
| C13 | `runCli` order: dropped/merged check on raw argv → Commander parse → find project → format check → command. Version and every help form (`--version`, `-V`, `--help`, `-h`, `help [command]`, `<command> [subcommand] --help`) are answered during the parse and return 0 before project discovery and the format check, so they work outside any project; the launcher's old-engine path skips discovery for the same forms, through one `isVersionOrHelp(argv)` in `format.ts`. A dropped command with `--help` still fails at the dropped check. So a dropped flag fails before anything is read, and the format refusal comes before "not built yet" (S-ENG-5 step 4 and S-MIG-2 step 1 pass while `resume` and `start` are unbuilt). `--ask` values starting with `/` are checked against Manager's host-command table in M1. | ARCH 8.1 gives the order; S-CLI-2 needs Manager drops before Manager exists. |
| C14 | One `format.ts` serves the launcher and `runCli`. Version and help forms (C13) skip project discovery and the format check under both engines; under the new one so do `migrate` and `doctor` (ARCH 9.2). `format_version` must be the integer `1`. The marker alone decides. | ARCH 9.2 names the new engine's exceptions only. |
| C15 | Lease takeover: read the row, `await processes.isAlive(owner)`, then in one `BEGIN IMMEDIATE` replace the row only if `instance` and `heartbeat_at` are unchanged. | better-sqlite3 transactions are synchronous; `isAlive` is async. |
| C16 | Blobs are capped at 16 MB each; anything larger is cut with a marker, and the cut is recorded. | ARCH 3.2 says "bounded" without a number; 10 MB per turn's activity (S-ENG-7) fits under it. |
| C17 | M1's config schema checks `format_version`, the reserved `workflows:` key, and that the file is valid YAML. Every other key passes unchecked until its milestone (unknown-key errors are M5's `--set` work). | M1 needs format detection and the reservation, not the full 1.0 config. |
| C18 | The fake clock counts in-flight `deps` calls; it treats the engine as idle when that count is zero and two `setImmediate` turns pass with no new work. | SCN 7.4 says the clock advances "only when nothing else can run". |
| C19 | F-LEGACY and F-LEGACY-RUNNING are generated once by running 0.10.2 against the Codex fake (the flow in `rafi/test/e2eWorkflow.test.ts:16-57`; the running variant uses the `hang` fault), then frozen with a manifest of git-tracked paths. S-ENG-5 step 1's 0.10.x F-ONE is generated at test time the same way, because 0.10.x refuses a moved copy of its recovery state (fact table). If the blocked ticket and saved answer that S-MIG-1 (M9) needs take long to produce, they can be finished in M9; M1 needs only an unmigrated project and an unfinished run. | SCN 2.1; ARCH 14 M1 now lists both (P6, approved and applied). |
| C20 | The invariant checker reads the `rafi-events` export (ARCH 3.5), never the database. In M1 it's tested on synthetic exports; `rafi stats export` feeds it from M2. | SCN 1.2 forbids reading engine tables. |
| C21 | The ledger generates the coverage table to a temp file and **fails if it differs from SCN section 10**. It never rewrites the locked doc. `registry.ts` is generated from SCN headings and Covers lines and ARCH 14's Must-pass lists by `import-docs.mjs`, and checked in. | SCN 7.9 now says this (P4, approved and applied). |
| C22 | `check-rules.mjs` heuristics: module-level `let`, or a module-scope array, object, `Map` or `Set` not wrapped in `Object.freeze`, is mutable state. Hand-joined paths are template literals or `+` joins with a `/` next to an expression named like `dir`, `path`, `root`, `cwd` or `file`. A shell string is `shell: true` or `bash`, `sh` or `zsh` as a spawned command. A `// rules-allow: <reason>` comment exempts one line, and the script lists every exemption. It also reports module line totals against ARCH 2.2's budgets, without failing. | ARCH 2.4 states the rules, not how to detect them. |
| C23 | `deps.db.open(path, { readonly })`: the read-only option is used for 0.10.x's `.rafi/recovery.sqlite3`, so the refusal can't write. | ARCH 9.2 requires "nothing written". |
| C24 | Ids from `deps.random.id()`: the harness's are a seeded counter (`id-000001`), so exports are byte-stable. | ARCH 3.3 "the fast suite is exact". |
| C25 | The process set runs the built launcher, `packages/rafi/dist/launcher.js`, after `test:process` builds `@rafi-ai/cli` and its workspace dependencies. Running the source launcher through tsx, as today's e2e tests do (`rafi/test/e2eWorkflow.test.ts:17`), is allowed only as an extra developer shortcut, never as the process set. | SCN 7.2 says "spawns the built launcher"; S-CLI-12 runs the launcher under Node 18 (SCN 7.10), which needs compiled JavaScript. The process set takes minutes (SCN 7.10) and isn't in the 60-second gate, so the build doesn't cost the gate. Audit finding 11. |
| C26 | Package boundaries: every workspace package the harness or CLI imports has an explicit export, with conditions in this order: `source` (the `.ts` file), `types` (`dist/*.d.ts`), `default` (`dist/*.js`). `@rafi-ai/engine` exports `.`, `./deps/real` (used by `rafi/src/next/deps.ts` and the harness's wrapped real deps) and `./agents` (the fidelity tests); `@rafi-ai/cli` adds `./next`; `rafi-spec` adds `./v1` (C2). The fast suite runs with `--conditions=source` and `scenarios/tsconfig.json` sets `customConditions: ["source"]`, so it needs no build. The build tsconfigs don't set that condition, so `tsc -p tsconfig.build.json` resolves the other packages to their `dist/` and stays inside `rootDir: src`; packages build in dependency order (spec, engine, cli). The harness imports only these exports, never a deep `src/` path. | Audit finding 9: today `@rafi-ai/cli` exports only `.` → `dist/index.js` (`packages/rafi/package.json:19-24`), and `rafi/tsconfig.build.json` has `rootDir: src`. |

## 8. Problems found in the locked docs

None blocks starting M1. **The user approved P1–P7, and they were applied to the locked docs on 2026-11-02**, each as a small edit doing exactly its suggested fix: P1 `REWRITE_ARCHITECTURE.md:317`; P2 `:449` and `:181`; P3 `REWRITE_SCENARIOS.md:1150`; P4 `REWRITE_SCENARIOS.md:1504`; P5 `REWRITE_ARCHITECTURE.md:261`; P6 `:1635`; P7 `:1053`. **P8 is deferred until before M4.** Evidence line numbers in the table below are from before the edits (ARCH lines after `:260` moved down by one).

| # | Problem | Evidence | Suggested fix |
|---|---|---|---|
| P1 | `checks.failed` has no `circling` field, but its transitions branch on "not circling", and `nextTicket` can't compute it: `TicketRules` has no `circling_repeats`. `verdict.recorded` and `step.failed` do carry `circling`. | `REWRITE_ARCHITECTURE.md:316` (fields), `:483-484` (transitions), `:448` (`TicketRules`), `:297`, `:320` | Add `circling` to `checks.failed`'s fields. The plan's v1 schema includes it. |
| P2 | `state/` may import only types and `nextTicket` takes no workflow, yet the ticket tables "are the built-in workflow … `nextTicket` reads them", and `workflow/` isn't in the dependency chain. | `:178`, `:442`, `:448`, `:458`, `:181` | Pass the pinned workflow in `TicketRules` (choice C4), and add `workflow/` beside `state/` in the dependency line. |
| P3 | S-CLI-2 step 2 lists `rafi resume --yes` among the forms whose expected result is "each exits 1 as an unknown option", while the same bullet, S-CLI-3 and FLAG-RS-8 keep `--yes`. | `REWRITE_SCENARIOS.md:1150`, `:1155`; `REWRITE_REQUIREMENTS.md:257` | Treat `rafi resume --yes` as the check that aliases still work: remove it from the exit-1 list, or add "except `--yes`". The plan asserts `--yes` is accepted. |
| P4 | The coverage ledger "regenerates the coverage table, so this doc and the code can't drift apart", which would mean a test rewriting a locked doc. | `REWRITE_SCENARIOS.md:1504` | Read it as "checks the table against section 10 and fails on drift" (choice C21). |
| P5 | `project.archived` and `project.unarchived` are used in the project table but aren't in the event list, so they have no schema and can't be in the every-pair test. | `REWRITE_ARCHITECTURE.md:596-597`; absent from 3.4 (`:255-361`) | Add both to 3.4 group A (state, empty payload, "GUI only"). The plan's v1 schema includes them. |
| P6 | M1's partial scenarios need F-LEGACY (S-MIG-2 step 1 and S-ENG-5 step 4 run on it), but M1's build list names only the F-ONE and F-CHAIN builders. | `REWRITE_SCENARIOS.md:609`, `:1346`; `REWRITE_ARCHITECTURE.md:1634` | Add F-LEGACY (and its unfinished-build variant) to M1's list. The plan builds them (choice C19). |
| P7 | "Free text is stored exactly as typed" conflicts with "redacted on write" when a typed answer looks like a secret. | `REWRITE_ARCHITECTURE.md:1052`, `:247` | Say that redaction applies to typed answers too (choice C8). |
| P8 (affects M4, not M1) | Process-mode fakes can't match a turn by ticket. The real transport drops `meta`, and SCN forbids reading prompt text, but the process fakes use the real transport. | `REWRITE_ARCHITECTURE.md:1507`; `REWRITE_SCENARIOS.md:1409`, `:1412` | Let process-mode scripts match on role and step from the reply schema's title, plus each role's turn order, and keep process-set scripts unambiguous; or allow one fixed, machine-readable header line in each per-turn message. Decide before M4's process-set crash samples. **Deferred by the user until before M4.** It doesn't block M1, where no process-mode step needs a per-ticket match: S-ENG-5 step 1 runs the old engine against today's Codex fake, steps 2 and 4 exit before any turn, and the fidelity tests drive one turn each. Until it's decided, `codex-cli.mjs` and `claude-cli.mjs` apply their script's rules in order and ignore role, ticket and attempt selectors, and say so in an error if a script uses one. |

## 9. Risks and what I couldn't check

- **D9 is unverified** until step 1 runs. If it fails, the process set's Claude rows wait on the user's approval of the D9 amendment (decision 3 is already decided; only the doc text changes).
- **The fast suite on Windows** can't be checked locally (macOS here). It runs once the user pushes `feature/rewrite` with the new workflow; until then it's unverified, and the milestone report says so.
- **The 60-second budget**: about 25–35 isolated jobs at about 0.5 s of tsx start-up each, on 4 workers, should fit. The transition tests are many small cases in one file. Measured only once built.
- **F-LEGACY generation** relies on today's Codex fake driving 0.10.2 through create, plan, populate and start, which `rafi/test/e2eWorkflow.test.ts` already does. A blocked ticket and a saved answer in that fixture are untested with the fake (choice C19 defers them if needed).
- **The `state/` budget** (1,300 lines) is tight once `decide` folds delivery units and CI points; if it's exceeded, the implementer reports it rather than squeezing code past the rules.
- **Module-level mutable state detection** (choice C22) is heuristic; the review checks for gaps.
- **The process set needs a fresh build** (choice C25). `harness/process.ts` refuses a `dist/` older than its source, but that check is by file time and can miss a stale dependency's `dist/`; `test:process` always rebuilds first.

## 10. Audit (part 2): findings and how each was handled

Source: `.rafi-build/M1-audit.md`, 12 findings, each checked against the files it cites in this session.

| # | Finding | Handled |
|---|---|---|
| 1 | `checks.failed.circling` is an unapproved schema change | **Resolved:** P1 approved and applied (ARCH:317). |
| 2 | Passing the workflow in `TicketRules` changes the locked pure-state boundary | **Resolved:** P2 approved and applied (ARCH:449, :181); C4 updated. |
| 3 | `rafi resume --yes` is both rejected and kept in S-CLI-2 | **Resolved:** P3 approved and applied (SCN:1150); section 3.1 item 3 updated. |
| 4 | The ledger plan silently changes SCN's "regenerates the coverage table" | **Resolved:** P4 approved and applied (SCN:1504); C21 updated. |
| 5 | `project.archived` / `project.unarchived` have no schema | **Resolved:** P5 approved and applied (ARCH:261). |
| 6 | M1's legacy scenarios need F-LEGACY, which ARCH's M1 list omits | **Resolved:** P6 approved and applied (ARCH:1635); C19 updated. |
| 7 | The plan redacts typed answers without approval | **Resolved:** P7 approved and applied (ARCH:1053); C8 updated. |
| 8 | Process-mode fakes can't receive the `meta` their matcher needs | Same as P8. **Deferred by the user until before M4**; section 8 says what M1's process fakes do meanwhile. |
| 9 | No planned export boundary for the harness | **Applied:** choice C26; `./next` export on `@rafi-ai/cli` (2.3); `.`, `./deps/real`, `./agents` on the engine, and `src/agents/index.ts` (2.1); `customConditions` in scenarios (2.4); order of work step 2. Checked: `packages/rafi/package.json:19-24` exports only `.`. |
| 10 | Missing direct dependencies | **Applied:** the Agent SDK as a scenarios devDependency, `@types/better-sqlite3` as an engine devDependency (2.1, 2.4). Checked: `ai-foreman/package.json:318` (SDK), `:336` (`@types/better-sqlite3`); `packages/rafi/package.json` has neither. |
| 11 | The process set ran the source launcher, but SCN 7.2 says built | **Applied:** C25 rewritten; `harness/process.ts` (2.4), root `test:process` (2.5) and order of work step 10 updated. Source-mode runs are kept only as a developer shortcut, as suggested. |
| 12 | Help and version ran after project discovery | **Applied:** C13, C14, the `cli.ts` and launcher rows (2.3); S-CLI-1 now runs outside any project (3.1 item 2). |

## Questions for the user

None. Every product behavior M1 touches is decided in the locked docs. P1–P7 are approved and applied; P8 is deferred until before M4 (section 8).

## 11. Implementation (part 4): choices made while building, and differences from this plan

Recorded by the implementer, 2026-11-02. Locked-doc problems found are P9–P12 (milestone report); none was edited.

| # | Choice or difference | Why |
|---|---|---|
| C27 | `verdict.recorded.unverified` items are `{ req, tool }`; a non-null `tool` names a known, unconfigured tool that would let QA verify, and sends the ticket to `blocked(unverified)` | ARCH 4.2's "an unable that a known tool would fix" must be decidable by `nextTicket` from the event alone; 3.4 doesn't fix `unverified`'s shape |
| C28 | `nextProject(project, event, ctx)` takes `{ allTicketsClosed }` from the fold | "complete, and every ticket done or dropped" (4.4) needs ticket state the project event doesn't carry |
| C29 | `Deps` has `cwd` | `runCli` can't read `process.cwd()` (2.4) but must find the nearest `rafi-config.yaml` |
| C30 | `nextTicket` keeps its signature and throws `InvalidTransition` for an invalid pair; the fold turns it into a violation | 4.1: invalid pairs are refused on append and reported, never thrown, by the fold |
| C31 | `resume_step` values are workflow node ids (`build-check`, `fix-check`, …), not step names | `check` names two nodes (C5) |
| C32 | Module-state rule (C22): a module-scope value typed `Readonly…`/`readonly …[]` or `as const` also counts as immutable | `Object.freeze` doesn't freeze a `Set` or `Map` |
| D1 | Command definitions are data (`commands/spec.ts`, `table.ts`, `tickets.ts`, `dropped.ts`) instead of one file per command | In M1 a command is only arguments, options and help; each milestone adds `commands/<name>.ts` for the action |
| D2 | `@rafi-ai/cli` also exports `./next/format` | S-ENG-5 step 2 in-process checks the launcher's own format code |
| D3 | `packages/rafi/tsconfig.json` sets `customConditions: ["source"]`; `tsconfig.build.json` resets it to `[]` | Typecheck without a build; the build stays inside `rootDir: src` (C26) |
| D4 | F-LEGACY-RUNNING is made with the fake's `hang` fault and a SIGKILL of the whole process group, not `killhost` | 0.10.2's supervisor relaunched the worker `killhost` killed and finished the build |
| D5 | The Codex executable fidelity test is skipped on Windows | A shebang shim can't be spawned without a shell there |
| D6 | The ledger test pins the three drift items P10–P12 exactly | It still fails on any new drift, and once a doc fix lands the entry must be removed |
| D7 | Not fully test-first: `check-rules` was seen failing on a stub before it was written, but the engine units and S-CLI-1/S-CLI-2 were written after their code's first draft, so they weren't seen failing first. The ticket transition test was checked by planting wrong expectations (it caught them) | Honest record for the review |
