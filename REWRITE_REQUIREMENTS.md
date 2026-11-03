# Rewrite requirements

Status: **locked** (guide step 9, 2026-11-02). Reviewed and decided; changes now need the user's approval. Build handoff: `REWRITE_BUILD_HANDOFF.md`.
Related: `AI_FOREMAN_REWRITE.md` (the why and the decisions), `AI_FOREMAN_REWRITE_PLANNING_GUIDE.md` (step 1 asks for this doc), `GUI_PRODUCT_REQUIREMENTS.md`.

This is the contract for the rewrite. It lists every user-visible behavior of rafi today and says whether the new engine keeps it, changes it, or drops it. Section 8 adds the new behavior the rewrite must build. Section 9 lists the open questions.

## 1. How to read this doc

### 1.1 Decisions

Each item is marked:

- **keep**: the new engine behaves the same way.
- **change → …**: the new engine behaves as described after the arrow.
- **drop**: the behavior goes away.

Each mark also says where it comes from:

- **(decided)**: a decision marked "decided" in `AI_FOREMAN_REWRITE.md`. These are final and aren't reopened here.
- **(follows …)**: not stated directly, but follows from a decided item or a design principle named in the brackets.
- **(proposed)**: my recommendation. Every proposed mark is listed in section 9 so you can confirm or change it.

### 1.2 Sources

Every item names its source. Short forms:

| Short form | Means |
|---|---|
| `help: rafi X` | Output of `rafi X --help` from the installed 0.10.2 CLI, captured 2026-11-01 (Node 24.21.0). |
| `help: ai-foreman X` | Output of `node packages/ai-foreman/dist/index.js X --help`, same date. |
| `RW §Name` / `RW:N` | `AI_FOREMAN_REWRITE.md`, by section name or line number. |
| `GUI-…` | A requirement ID in `GUI_PRODUCT_REQUIREMENTS.md`. |
| `cli.md:N` | `docs/cli.md`, line N. |
| `path/file.ts:N` | Source code, relative to `packages/` unless the path says otherwise. |
| `run: …` | Output of a command I ran on 2026-11-01 against a scratch copy of moneyTree (git clone plus copied `.rafi/`, `.tickets/`, `.foreman/` and `rafi-config.yaml`). The real moneyTree checkout wasn't touched. |
| `MALF n` | Item n in `MALFORMED_REPLY_AND_BLOCKED_BUILD_IMPROVEMENTS.md`. |
| `QAMC §n` | Section n in `QA_MANUAL_CHECKS_AND_RECOVERY_FINDINGS.md`. |
| `PUA §n` | Section n in `PLAN_UPDATE_APPROVAL_IMPROVEMENT.md`. |
| `AIR` | `AGENT_INSTRUCTIONS_REVIEW.md`. |
| `old/…` | An archived plan doc, no longer in the repo. |
| `harness/…` | The archived harness plan (`rafi-harness-requirements.md`), no longer in the repo. |

### 1.3 Where the docs and the code disagree

When a doc and the code disagreed, I followed the code and noted the mismatch. The ones I found:

| Doc says | Code does | Source |
|---|---|---|
| `rafi start` requires `--steps` (`cli.md:15`). | An interactive run with neither `--steps` nor `--stacks` asks "Build tickets or complete delivery stacks?". Only non-interactive and `--yes` runs require one of them. | `ai-foreman/src/cli/start.ts:630-639` |
| `rafi plan` writes history to `<docs.root>/rafi-plans/<timestamp>.md` (`cli.md:38`). | History is `<docs.root>/rafi-plans/<plan_id>-r<revision>.md` plus a matching `.json`. | `rafi/src/structuredPlan.ts:384-389`; moneyTree `docs/rafi-plans/` |
| QA fixes before "what next?": "3 automatic Builder fixes" (`QAMC §1`). | 3 is the `balanced` profile (the default). `supervised` allows 2 and `unattended` 5. | `ai-foreman/src/recoveryPolicy.ts:20-31,36` |
| `rafi start --help` lists `--completion` as `pr \| auto-merge \| direct-merge \| none`. | Same. `RW:84` adds `pr-ready` as a new value, because `--pr-ready` merges into `--completion`. | `help: rafi start`; `RW:84,90` |

### 1.4 What "user-visible" covers

Commands, flags and arguments; interactive prompts and their choices; files rafi reads or writes inside a project; the formats of tickets, plans and config; terminal output, machine-readable output and exit codes; environment variables a user can set. Internal database tables, recovery records and agent protocol details are covered only where a user can see or touch them.

## 2. Commands and flags

### 2.1 The command list

Today's top-level commands, from `help: rafi`. The new commands at the end come from `RW §Keep and rewrite` and `RW §Test tools`.

| ID | Command today | What it does (help text) | Decision | Source |
|---|---|---|---|---|
| CMD-1 | `rafi --version`, `-V` | Print the version | **keep** (proposed) | `help: rafi` |
| CMD-2 | `rafi create <project>` | Run the walkthrough, write `rafi-config.yaml`, compile the repo | **keep** (decided). New questions in PRM-1 | `help: rafi create`; `RW:59` |
| CMD-3 | `rafi compile <project>` | Re-render `.claude/`, `.codex/`, `AGENTS.md` and role bundles from `rafi-config.yaml` | **keep** (decided) | `help: rafi compile`; `RW:57,59` |
| CMD-4 | `rafi plan [project]` | Create a ticket-ready implementation plan | **keep** (decided) | `help: rafi plan`; `RW:59` |
| CMD-5 | `rafi plan:doctor [project]` | Recover saved create, plan and ticket-planning sessions | **change → merged into `rafi resume`** (decided) | `help: rafi plan:doctor`; `RW:209` |
| CMD-6 | `rafi tickets …` | Manage the ticket tracker (25 subcommands, section 2.4) | **keep** (decided) | `help: rafi tickets`; `RW:59` |
| CMD-7 | `rafi start <project>` | Enlist a builder and drive it through N steps | **keep** (decided), flags change (section 2.5) | `help: rafi start`; `RW:59,76-93` |
| CMD-8 | `rafi resume [project]` | Pick an unfinished build or saved interview and resume it | **change → also attaches to a running build, resumes a stopped one, and recovers saved planning sessions; no recovery modes** (decided) | `help: rafi resume`; `RW:66,72,209` |
| CMD-9 | `rafi build:attach` | Attach to a supervised build and show its recovery state | **change → folded into `rafi resume`** (decided) | `help: rafi build:attach`; `RW:66` |
| CMD-10 | `rafi build:decide` | Answer a durable supervised-build decision | **change → `rafi answer`, which answers any open question** (decided) | `help: rafi build:decide`; `RW:70` |
| CMD-11 | `rafi build:stop` | Request graceful termination of a supervised build | **change → renamed `rafi stop`** (decided) | `help: rafi build:stop`; `RW:67` |
| CMD-12 | `rafi build:resume` | Resume one interrupted run with an exact recovery mode | **change → folded into `rafi resume`** (decided) | `help: rafi build:resume`; `RW:72` |
| CMD-13 | `rafi build:start-over` | Preserve a run, reconcile tracker state, prepare a fresh restart | **change → merged into `rafi reset`, which asks: this build, or everything?** (decided) | `help: rafi build:start-over`; `RW:71` |
| CMD-14 | `rafi build:reset` | Archive all recovery state, reset tickets to post-population state | **change → merged into `rafi reset`** (decided) | `help: rafi build:reset`; `RW:71` |
| CMD-15 | `rafi handoffs …` | Inspect and manage cumulative hand-offs | **drop** (decided). Hand-offs become internal events in the log | `help: rafi handoffs`; `RW:68` |
| CMD-16 | `rafi agents [project]` | Set per-role runtime, model, reasoning, fast and session defaults | **keep** (decided). Default session strategy changes (FMT-C7) | `help: rafi agents`; `RW:59` |
| CMD-17 | `rafi state …` | Export, inspect, import and rebind portable state bundles | **drop** (decided). Replaced by built-in portability (NEW-PORT-1) | `help: rafi state`; `RW:73` |
| CMD-18 | `rafi manager [project]` | Consult on setup, planning, tickets, builds and QA | **keep** (decided). Reads the event log (section 2.7) | `help: rafi manager`; `RW:59,207` |
| CMD-19 | `rafi audit [project]` | Inspect one retained run with bounded evidence | **change → `rafi stats show`** (decided) | `help: rafi audit`; `RW:69` |
| CMD-20 | `rafi uninstall [project]` | Preview and remove project-local rafi material | **keep** (decided) | `help: rafi uninstall`; `RW:59` |
| CMD-21 | `rafi uninstall:restore <id>` | Restore files from an uninstall recovery bundle | **keep** (follows CMD-20; proposed) | `help: rafi uninstall:restore` |
| CMD-22 | `rafi uninstall:cleanup [id]` | Permanently remove uninstall recovery bundles | **keep** (follows CMD-20; proposed) | `help: rafi uninstall:cleanup` |
| CMD-23 | `rafi status [project]` | Summarize the most recent run | **keep**, output changes (OUT-1) (follows `RW:351`) | `help: rafi status`; `RW:351` |
| CMD-24 | `rafi doctor [project]` | Check Foreman, agent CLIs, config and tracker readiness | **keep** (proposed). Flags in section 2.8 | `help: rafi doctor` |
| CMD-25 | `rafi graph …` | Adopt and inspect scoped local Graphify evidence | **keep** (proposed; Graphify itself is kept, decided `RW:206`) | `help: rafi graph` |
| CMD-26 | `rafi sources …` | Manage the project-wide planning source registry | **keep** (proposed) | `help: rafi sources` |
| CMD-27 | `rafi discover [project]` | Read-only project continuation discovery report | **keep** (proposed) | `help: rafi discover` |
| CMD-28 | `rafi qa-rehearse-rollback` | Test rollback of uncommitted changes in a temporary repo. Meant for agents: the agent permission policy allows exactly `rafi qa-rehearse-rollback` | **keep** (proposed) | `help: rafi qa-rehearse-rollback`; `ai-foreman/src/permissions/policy.ts:96-110` |
| CMD-29 | `rafi help [command]` | Commander help | **keep** | `help: rafi` |
| CMD-30 | *(new)* `rafi answer` | Answer any open question | **new** (decided) | `RW:70,417` |
| CMD-31 | *(new)* `rafi stop` | Stop a build | **new name** (decided) | `RW:67` |
| CMD-32 | *(new)* `rafi reset` | Reset this build or everything | **new** (decided) | `RW:71` |
| CMD-33 | *(new)* `rafi stats show`, `timeline`, `export`, `delete` | Run history | **new** in 1.0 (decided). `compare` and `replay` come after 1.0 (Q-STATS-1) | `RW:69,168-169` |
| CMD-34 | *(new)* `rafi logs export [--run <id>]`, `rafi logs import` | Move build logs between computers | **new** (decided) | `RW:74` |
| CMD-35 | *(new)* `rafi tools add <name>` | Add a test tool to `rafi-config.yaml` | **new** (decided) | `RW:444` |
| CMD-37 | *(new)* `rafi migrate [project]` | One-time, one-way conversion of a 0.10.x project (config, tickets, plans, saved answers) to the 1.0 formats. Previews the changes, backs up what it rewrites, and can be run again safely. Required; the new engine itself reads only 1.0 formats | **new** (decided 2026-11-01, Q-CFG-2) | section 9.0 |
| CMD-36 | standalone `ai-foreman` binary | Same runtime commands as rafi: `tickets`, `graph`, `start`, `status`, `doctor`, `manager`, `state`, `build:attach`, `build:decide`, `build:stop`. No `create` or `compile` | **drop** (proposed). Principle 9 makes ai-foreman a library that `rafi` calls in-process | `help: ai-foreman`; `cli.md:843-845`; `RW:296` |

### 2.2 `rafi create`

| ID | Flag | Today | Decision | Source |
|---|---|---|---|---|
| FLAG-CR-1 | `<project>` | Path to the target repo (required) | **keep** | `help: rafi create` |
| FLAG-CR-2 | `--interview-id <id>` | Recover an exact saved create interview | **keep** (proposed); selected by `rafi resume` instead of `plan:doctor` (follows CMD-5) | `help: rafi create` |
| FLAG-CR-3 | `--defaults` | Accept the disclosed setup defaults, including Graphify | **keep** (proposed). Must also accept defaults for the new questions in PRM-1 | `help: rafi create` |
| FLAG-CR-4 | `--no-graph` | Opt out of Graphify | **keep** (follows `RW:206`) | `help: rafi create` |
| FLAG-CR-5 | `--dirty-work preserve` | Record exact preimages and continue with uncommitted work. Without a terminal and without this flag, create refuses a dirty repo | **keep** (follows `RW:210`) | `help: rafi create`; `rafi/src/index.ts:160-175` |
| FLAG-CR-6 | `--force` | Overwrite existing doc files | **keep** (proposed) | `help: rafi create` |
| FLAG-CR-7 | `--docs-root <dir>` | Repo-relative folder for starter and tracker docs | **keep** (proposed) | `help: rafi create` |
| FLAG-CR-8 | `--runtime both\|claude\|codex` | Sets `harness.targets`. `--defaults` keeps both unless this is given | **keep** (proposed) | `help: rafi create`; `cli.md:30` |
| FLAG-CR-9 | `--root-file-mode append\|overwrite\|update` | Root instruction file handling | **keep** (proposed) | `help: rafi create` |
| FLAG-CR-10 | `--grill-me` / `--no-grill-me` | Exhaustive or standard initial planning (standard is the default) | **keep** (proposed) | `help: rafi create` |

### 2.3 `rafi compile`, `rafi plan`, `rafi plan:doctor`

| ID | Command and flag | Today | Decision | Source |
|---|---|---|---|---|
| FLAG-CO-1 | `compile <project>` | Re-render from `rafi-config.yaml`. Writes only the configured targets; leaves files for unselected targets in place | **keep** (decided) | `help: rafi compile`; `cli.md:31` |
| FLAG-CO-2 | `compile --force` | Overwrite existing doc files | **keep** (proposed) | `help: rafi compile` |
| FLAG-CO-3 | `compile --root-file-mode <mode>` | One-run override of root file handling | **keep** (proposed) | `help: rafi compile` |
| FLAG-CO-4 | `compile` legacy migration | Rewrites the legacy `qa_preparation: { mode: … }` object to booleans | **drop** (decided 2026-11-01, Q-CFG-2: pre-0.10 formats aren't supported; `rafi migrate` converts 0.10.x only) | `cli.md:32` |
| FLAG-PL-1 | `plan --brief <text>`, `--brief-file <path>` | Planning brief | **keep** (decided command) | `help: rafi plan` |
| FLAG-PL-2 | `plan --sources <paths...>` | Source hints to check first | **keep** | `help: rafi plan` |
| FLAG-PL-3 | `plan --source-storage local\|tracked` | Where new source versions are stored | **keep** | `help: rafi plan` |
| FLAG-PL-4 | `plan -a/--agent`, `-m/--model`, `--effort`, `--fast` | Planning agent overrides | **keep** | `help: rafi plan` |
| FLAG-PL-5 | `plan --resume-session <id>`, `--interview-id <id>` | Resume a saved planner session or interview | **keep** (proposed); selected by `rafi resume` (follows CMD-5) | `help: rafi plan` |
| FLAG-PL-6 | `plan --revise [plan-id]` | Revise the latest or named approved plan lineage | **keep** | `help: rafi plan` |
| FLAG-PL-7 | `plan --validate` | Validate the latest Markdown/JSON plan pair without an agent | **keep** | `help: rafi plan` |
| FLAG-PL-8 | `plan --render` | Regenerate Markdown from the validated JSON | **keep** | `help: rafi plan` |
| FLAG-PL-9 | `plan --grill-me` / `--no-grill-me` | Exhaustive or standard planning | **keep** | `help: rafi plan` |
| FLAG-PL-10 | `plan --skip-run-confirmation` | "skip only the duplicate run confirmation (used by interactive create)" | **drop** (proposed; principle 9, no internal flags; create calls plan in-process) | `help: rafi plan`; `RW:296` |
| FLAG-PL-11 | `plan -y/--yes` | Skip the confirmation before running the planner | **change → `--auto-approve` with `-y` kept** (follows `RW:81,88`) | `help: rafi plan` |
| FLAG-PL-12 | `plan` success rule | Only `STEP_STATUS: plan_complete` counts as success; required sections are validated before writing | **change → the plan is accepted when its JSON validates; no status line** (follows `AIR` contradiction 4, which says 0.10.1 removed `STEP_STATUS`) | `cli.md:38`; `AIR` |
| FLAG-PD-1 | `plan:doctor [project]` | No flags. In a terminal, picks one saved session automatically or shows an age-labelled picker; without a terminal, lists sessions and the exact `rafi resume … --id …` commands | **change → `rafi resume` does all of this** (decided) | `help: rafi plan:doctor`; `docs/reliability-workflows.md` "Recover planning" |

### 2.4 `rafi tickets`

The `tickets` command is kept (decided, `RW:59`). Each subcommand below is **keep** unless marked. Flags are listed in full so the scenario suite can cover them.

| ID | Subcommand and flags | Today | Decision | Source |
|---|---|---|---|---|
| FLAG-TK-1 | `setup:init` with `--interview-id`, `-p/--project`, `--defaults`, `-y`, `--app-name`, `--docs-root`, `--runtime`, `--local-source`, `--linear`, `--linear-team-key`, `--linear-filter`, `--jira-site`, `--jira-jql`, `--url-source`, `--population-mode approved_plan\|external_import`, `--agent-preference configured\|claude\|codex`, `--branch-strategy current\|batch\|branch-per-ticket`, `--branch-prefix`, `--completion`, `--provider auto\|github\|gitlab\|local`, `--auto-merge-wait`, `--auto-merge-timeout-minutes`, `--skip-access-check` | Configure population, context and build defaults in `rafi-config.yaml` | **keep**. `--completion` gains `pr-ready` (follows `RW:84`) | `help: rafi tickets setup:init` |
| FLAG-TK-2 | `setup:update` (same flags; source flags replace saved sources) | Update those settings | **keep**, same change | `help: rafi tickets setup:update` |
| FLAG-TK-3 | `init` with `-p`, `--app-name`, `--timezone` (default `UTC`), `--implementation-limit` (default 500), `--view-limit` (default 20000), `--queue-limit` (deprecated alias), `--docs-root`, `-y` | Create the `.tickets/` structure | **keep**; **drop** `--queue-limit` (proposed; principle 8) | `help: rafi tickets init` |
| FLAG-TK-4 | `populate` with `-p`, `-a`, `-m`, `--effort`, `--sources`, `--fast`, `--resume-session`, `--interview-id`, `--proposal-file`, `--authorize-retire <ids...>`, `--waive-risk-notes <ids...>`, `--waiver-reason`, `--waiver-actor` (default `operator`), `-y` | Make tickets from the approved plan or an external import. `-y` still needs exact `--authorize-retire` IDs to retire tickets | **keep**. Must also write tags (NEW-TAG-1) | `help: rafi tickets populate` |
| FLAG-TK-5 | `show [ticketId]` with `-p`, `--all`, `--json`, `--output <file>` | Full canonical ticket(s). `--output` creates parent folders and appends | **keep** | `help: rafi tickets show`; `cli.md:46,56-74` |
| FLAG-TK-6 | `waive-risk-notes` with `--tickets <ids...>`, `--reason`, `-p`, `--actor` | Waiver for missing Medium/High-risk rollback plans | **keep** | `help: rafi tickets waive-risk-notes` |
| FLAG-TK-7 | `repair` with `--risk-notes`, `--apply`, `-p`, `-a`, `-m`, `--effort`, `--fast`, `-y` | Ticket Maker repairs published ticket metadata | **keep** | `help: rafi tickets repair` |
| FLAG-TK-8 | `groups list` with `-p`, `--json`; `groups repair` with `-p`, `-y` | List creation groups; group tickets created outside rafi "after the legacy migration" | **keep** `list` and `repair` (proposed; hand-edited tickets still need a group). Remove the "legacy migration" wording | `help: rafi tickets groups list`, `… repair` |
| FLAG-TK-9 | `reset [ticketId]` with `-p`, `--all`, `--scope all\|completed-and-unfinished\|unfinished`, `--all-groups`, `--recent-groups <n>`, `--group <TG-N>`, `--group-index <n>`, `--deleted-tickets ignore\|restore`, `--actor` (default `user`), `-y` | Tracker-only reset, keeps history | **keep**; help text points to `rafi reset` instead of `build:start-over` (follows CMD-13) | `help: rafi tickets reset`; `cli.md:46` |
| FLAG-TK-10 | `update <ticketId>` with `-p`, `--status planned\|next\|in_progress\|blocked\|done\|canceled`, `--actor`, `--summary`, `--next-action`, `--current-step`, `--owner`, `--validation-result`, `--validation-commands`, `--evidence`, `--last-error` | Update status or progress fields | **keep** | `help: rafi tickets update` |
| FLAG-TK-11 | `complete <ticketId>` with `-p`, `--actor`, `--summary`, `--validation-result passed\|failed\|not_run\|not_applicable` (default `passed`), `--validation-commands`, `--evidence` (required unless `not_applicable`), `--validation-notes` | Mark done with evidence | **keep** | `help: rafi tickets complete`; `cli.md:19` |
| FLAG-TK-12 | `block <ticketId>` with `-p`, `--blocked-by <ids...>`, `--type dependency\|external\|decision\|…`, `--summary`, `--unblock-criteria`, `--actor` | Mark blocked | **keep** | `help: rafi tickets block` |
| FLAG-TK-13 | `unblock <ticketId>` with `-p`, `--summary`, `--actor` | Remove explicit blockers | **keep**. A blocked ticket during a build is answered through the blocked-ticket prompt instead (NEW-BLK-1); `unblock` stays for manual use | `help: rafi tickets unblock`; `docs/guide-restart-legacy-project-build-0.10.md:207-208` |
| FLAG-TK-14 | `cancel <ticketId>` with `-p`, `--summary` (required), `--actor` | Cancel a ticket | **keep** | `help: rafi tickets cancel`; `cli.md:16` |
| FLAG-TK-15 | `discover` with `-p`, `--summary` (required), `--source-ticket`, `--proposed-ticket`, `--priority-guess P0\|P1\|P2\|P3`, `--area`, `--rationale`, `--needs-decision-from`, `--actor` | Add future work to the inbox | **keep** | `help: rafi tickets discover`; `cli.md:17` |
| FLAG-TK-16 | `accept-future-work <id>` with `-p`, `--ticket-id` and `--order` (both required), `--actor` | Promote future work to a ticket | **keep** | `help: rafi tickets accept-future-work`; `cli.md:18` |
| FLAG-TK-17 | `reorder <ticketId>` with `-p`, `--after <ticketId>`, `--order <n>`, `--actor` | Change implementation order | **keep**. During a build, reordering counts as a plan update and you're told (`RW:129`) | `help: rafi tickets reorder` |
| FLAG-TK-18 | `review` with `-p`, `--id`, `--accept`, `--dismiss`, `--defer`, `--accept-all`, `--dismiss-all`, `--defer-all` | Review split/combine/duplicate recommendations | **keep** | `help: rafi tickets review` |
| FLAG-TK-19 | `render` with `-p` | Regenerate the ticket progress doc | **keep** | `help: rafi tickets render` |
| FLAG-TK-20 | `validate` with `-p` | Run all 4 validation passes; exit 1 on error | **keep** | `help: rafi tickets validate`; `run: rafi tickets validate` printed `validation passed — all 4 passes clean`, exit 0 |
| FLAG-TK-21 | `queue` with `-p`, `--limit <n>`, `--refresh` (query GitHub/GitLab) | Print the queue | **keep**, output changes (OUT-2) | `help: rafi tickets queue` |
| FLAG-TK-22 | `archive` with `-p`, `--older-than-days <n>` | Update the archive doc, prune old completed rows | **keep** | `help: rafi tickets archive` |
| FLAG-TK-23 | `import` with `-p`, `--progress <path>` | "(stub) Migrate an existing Markdown tracker" | **drop** (proposed; it's a stub) | `help: rafi tickets import` |
| FLAG-TK-24 | `plan` with `-p`, `--brief`, `-a`, `-m`, `--effort`, `--resume-session`, `--interview-id`, `--source-storage`, `--grill-me`/`--no-grill-me`, `-y` (requires `--brief`) | Guided ticket planning | **keep**; `-y` becomes `--auto-approve` with `-y` kept (follows `RW:81,88`). Must tag new tickets (NEW-TAG-1) | `help: rafi tickets plan` |
| FLAG-TK-25 | `-p/--project` default | Most subcommands default to cwd; `tickets plan` "discover from cwd" | **keep** | `help: rafi tickets *` |

### 2.5 `rafi start`

All 45 of today's flags, from `help: rafi start`. The decisions are all from `RW:76-93` (decided 2026-11-01).

| ID | Flag today | Decision | New form |
|---|---|---|---|
| FLAG-ST-1 | `<project>` | **keep** | |
| FLAG-ST-2 | `-s, --steps <n>` | **keep**. Counts finished tickets; a blocked or skipped ticket doesn't use a step (`RW:396`; today `ai-foreman/src/foreman.ts:807,1039`) | |
| FLAG-ST-3 | `--stacks <n>` | **keep** | |
| FLAG-ST-4 | `-a, --agent <agent>` | **keep** | |
| FLAG-ST-5 | `-m, --model <model>` | **keep** | |
| FLAG-ST-6 | `--effort <level>` | **keep** | |
| FLAG-ST-7 | `--fast` | **keep** | |
| FLAG-ST-8 | `--no-qa` | **keep** | |
| FLAG-ST-9 | `--detach` | **keep**, reimplemented (decided 2026-11-01, D5 in 9.0): it starts one normal rafi process in the background, with no hidden flags and no CLI-on-CLI; `rafi status` and `rafi resume` follow it by reading the event log. Today it launches a detached supervisor with hand-off variables (`ai-foreman/src/supervisedStart.ts:78-89`) | |
| FLAG-ST-10 | `--branch-per-ticket` | **keep** | |
| FLAG-ST-11 | `--no-branch-per-ticket` | **keep** | |
| FLAG-ST-12 | `--completion <mode>` | **keep**, values `pr`, `pr-ready`, `auto-merge`, `direct-merge`, `none` | |
| FLAG-ST-13 | `--base <ref>` | **keep** | |
| FLAG-ST-14 | `--dirty-work preserve\|include` | **keep** (also `RW:210`) | |
| FLAG-ST-15 | `--ticket <id>` | **keep** | |
| FLAG-ST-16 | `--skip-delivery-unit <id>` | **change → renamed** | `--skip` |
| FLAG-ST-17 | `-y, --yes` | **change → merged** | `--auto-approve` (`-y` and `--yes` still work as aliases; decided 2026-11-01) |
| FLAG-ST-18 | `--builder-network` | **change → merged** | `--allow internet,…` |
| FLAG-ST-19 | `--qa-network` | **change → merged** | `--allow` (covers builder and QA) |
| FLAG-ST-20 | `--builder-approvals` | **change → merged** | `--allow` |
| FLAG-ST-21 | `--create-pr` | **change → merged** | `--completion` |
| FLAG-ST-22 | `--no-create-pr` | **change → merged** | `--completion` |
| FLAG-ST-23 | `--pr-ready` | **change → merged** | `--completion pr-ready` |
| FLAG-ST-24 | `-t, --tickets <path>` | **drop** | |
| FLAG-ST-25 | `-r, --resume <sessionId>` | **drop** | |
| FLAG-ST-26 | `--continue` | **drop** | |
| FLAG-ST-27 | `--recover-run <id>` | **drop** | |
| FLAG-ST-28 | `--recovery-mode <mode>` | **drop** | |
| FLAG-ST-29 | `--recovery-decision-digest <digest>` | **drop** | |
| FLAG-ST-30 | `--qa-revision <number>` | **drop** | |
| FLAG-ST-31 | `--accept-handoff <generation>` | **drop** | |
| FLAG-ST-32 | `--accept-handoff-role <role>` | **drop** | |
| FLAG-ST-33 | `--autonomy <profile>` | **drop** (see Q-CFG-3 for the config block) | |
| FLAG-ST-34 | `--no-supervisor` | **drop** | |
| FLAG-ST-35 | `--merge-method <method>` | **change → config only** | `tickets.build.merge_method` |
| FLAG-ST-36 | `--provider <provider>` | **change → config only** | `tickets.build.provider` |
| FLAG-ST-37 | `--auto-merge-wait` | **change → config only** | `tickets.build.auto_merge_wait` |
| FLAG-ST-38 | `--no-auto-merge-wait` | **change → config only** | same |
| FLAG-ST-39 | `--auto-merge-timeout-minutes <n>` | **change → config only** | `tickets.build.auto_merge_timeout_minutes` |
| FLAG-ST-40 | `--branch-prefix <prefix>` | **change → config only** | `tickets.build.branch_prefix` |
| FLAG-ST-41 | `--max-branch-depth <n>` (default 5) | **change → config only** | new config key (Q-CFG-1) |
| FLAG-ST-42 | `--keep-worktrees` | **change → config only** | new config key (Q-CFG-1) |
| FLAG-ST-43 | `--show-session-cost` | **change → config only** | `agent_defaults.roles.*.display_session_cost` |
| FLAG-ST-44 | `--hide-session-cost` | **change → config only** | same |
| FLAG-ST-45 | `--audit-logging off\|summary\|trace` (default `summary`) | **change → config only**; follows the `rafi stats` capture level | capture level (NEW-STATS-2) |
| FLAG-ST-46 | `--auto-compact-threshold <percent>` | **change → config only**; still needed when one agent is reused across tickets | `agent_defaults.roles.builder.auto_compact_threshold_percent` |
| FLAG-ST-47 | *(new)* `--to-ticket <id>` | **new**. Build everything rafi can, in queue order, up to and including that ticket. Can't be combined with `--steps` (`RW:397`) | |
| FLAG-ST-48 | *(new)* `--skip <id>` | **new** (renamed FLAG-ST-16) | |
| FLAG-ST-49 | *(new)* `--auto-approve`, `-y` | **new**. The opt-in auto-approve feature (principle 14) | |
| FLAG-ST-50 | *(new)* `--allow internet,local-servers,…` | **new**. Covers the builder and QA (`RW:82`); full value list is Q-FLAG-2 | |
| FLAG-ST-51 | *(new)* `--set key=value` | **new**. Override any config setting for one build, for example `--set qa.model=…` (`RW:85`) | |

Rules that apply to the kept flags:

| ID | Rule | Decision | Source |
|---|---|---|---|
| FLAG-ST-R1 | Settings you choose once live in `rafi-config.yaml`; flags are one-off overrides. The GUI and Maestro read the same settings, and org policies can lock them | **keep** (decided) | `RW:76`; GUI-CFG-1, GUI-PLT-9, GUI-ENT-3 |
| FLAG-ST-R2 | Explicit flags beat saved `tickets.build` defaults for the current run | **keep** | `cli.md:44` |
| FLAG-ST-R3 | `--steps` and `--to-ticket` both set where the build stops, so only one can be used | **keep** (decided) | `RW:397` |
| FLAG-ST-R4 | With neither `--steps` nor `--stacks` in a terminal, ask "Build tickets or complete delivery stacks?" then "How many tickets?" / "How many complete stacks?". Non-interactive and auto-approve runs must give one | **keep** (proposed). Add `--to-ticket` to the choice (follows FLAG-ST-47) | `ai-foreman/src/cli/start.ts:630-639` |
| FLAG-ST-R5 | When `--agent` is omitted, `start`, `plan` and `tickets populate` use the single `harness.targets` value; with no config or both targets, Claude | **keep** (proposed) | `cli.md:34` |
| FLAG-ST-R6 | Automatic ticket branches are named `feature/<ticket-id>-<title>`. Explicit prefixes and delivery branch names stay exact. The default size policy shares compatible XS/S tickets in one invocation and isolates M/L/XL | **keep** (proposed) | `cli.md:45` |
| FLAG-ST-R7 | `start . --steps 10` reuses the approval of the selected plan and tickets, and only asks about material changes | **keep** (decided) | `RW:201`; `old/docs/build-stall-repair-plan.md:11` |

### 2.6 `rafi resume`, `rafi answer`, `rafi stop`, `rafi reset`

`RW` decides what these commands do but not each flag. The flag marks below follow from those decisions.

| ID | Flag today | Today | Decision | Source |
|---|---|---|---|---|
| FLAG-RS-1 | `resume [project]` (no flags) | Picks unfinished builds and saved interviews in the project, newest first | **keep**; also attaches to a running build (decided `RW:66`) and continues on another computer after a clone (decided `RW:73`) | `help: rafi resume`; `README.md` "Iteration" |
| FLAG-RS-2 | `--run <id>` (or unique prefix) | Pick a build | **keep** (proposed) | `help: rafi resume` |
| FLAG-RS-3 | `--id <id>`, `--discard <id>` | Resume or discard a saved interview | **keep** (follows CMD-5) | `help: rafi resume`; `cli.md:39` |
| FLAG-RS-4 | `--ticket <id>` | Narrow to one ticket | **keep** (proposed) | `help: rafi resume` |
| FLAG-RS-5 | `--builder-network`, `--qa-network`, `--builder-approvals` | Request capabilities for the resumed build | **change → `--allow`** (follows FLAG-ST-18..20) | `help: rafi resume` |
| FLAG-RS-6 | `--qa-revision <number>` | Exact QA protocol revision | **drop** (follows FLAG-ST-30 and `RW:72`) | `help: rafi resume` |
| FLAG-RS-7 | `--inspect` | Show recovery state and planned actions without changing anything | **change → `rafi status`** (proposed; there's no recovery plan to inspect when the step is just redone) | `help: rafi resume` |
| FLAG-RS-8 | `--yes` | Approve the plan, plan updates and flagged capabilities | **change → `--auto-approve`, with `-y` and `--yes` as aliases** (follows FLAG-ST-17) | `help: rafi resume` |
| FLAG-RS-9 | `--no` | Review the plan and later plan updates for this process | **drop** (follows `RW:125`: the plan-update setting is saved per project or per build, not asked per resume) | `help: rafi resume`; `PUA §4` |
| FLAG-RS-10 | `--fresh-with-handoff`, `--fresh-session`, `--guided-recovery` | Recovery modes | **drop** (follows `RW:68,72`) | `help: rafi resume` |
| FLAG-RS-11 | `--agent <runtime>`, `--model <model>` | Provider and model for a fresh session | **keep** as one-off overrides like `start` (proposed) | `help: rafi resume` |
| FLAG-RS-12 | Picking without `--run` | With `--yes` and no `--run`, picks the most recent unfinished build or saved session | **keep** (proposed) | `docs/guide-restart-legacy-project-build-0.10.md:254-259` |
| FLAG-AN-1 | `build:decide --run`, `--decision <id>`, `--choice <id>`, `--answer <text>` | Answer a recorded decision by ID | **change → `rafi answer`**: lists open questions, accepts a choice or free text, and works for any question (decided `RW:70`). Flag shape is Q-CMD-2 | `help: rafi build:decide` |
| FLAG-SP-1 | `build:stop --run <id>` | Graceful stop | **change → `rafi stop`**, same `--run` (proposed) | `help: rafi build:stop` |
| FLAG-RE-1 | `build:start-over --run`, `--action restart-current\|archive-restart\|archive-new-branch\|new-branch\|retain-merged\|revert-branch\|manual\|cancel`, `--tickets <ids>`, `--cleanup stash\|discard\|handled`, `--yes`, `--second-confirm`, `--inspect` | Preview-first restart with git choices | **change → `rafi reset`, "this build"** (decided). Which git actions survive is Q-CMD-3 | `help: rafi build:start-over`; `cli.md:47,50,52` |
| FLAG-RE-2 | `build:reset --yes` | Archive recovery state, reset tickets to post-population, carry the current plan approval forward | **change → `rafi reset`, "everything"** (decided) | `help: rafi build:reset`; `docs/guide-restart-legacy-project-build-0.10.md:53-57,180-189` |
| FLAG-RE-3 | Reset safety | Start-over never force-pushes or deletes/closes remote state; refuses while a build owner is alive | **keep** (proposed; principle 10 keeps checks that protect your code) | `cli.md:47`; guide `:73-76` |

### 2.7 `rafi manager`

| ID | Flag or host command | Today | Decision | Source |
|---|---|---|---|---|
| FLAG-MG-1 | `[project]`, `--run <run-id>`, `--ask <question>`, `--agent`, `--model`, `--effort`, `--fast` | Consult, or ask one question and exit | **keep** (decided command) | `help: rafi manager` |
| FLAG-MG-2 | `--external auto\|on\|off` (default `auto`) | Whether Manager checks PR, CI and dependency state on the remote. `auto` does so when the question mentions PRs, CI, checks, dependencies or waiting | **keep** (proposed) | `help: rafi manager`; `ai-foreman/src/diagnostics.ts:125` |
| FLAG-MG-3 | `/qa-work`, `/qa-attempts`, `/qa-report`, `/qa-timeline`, `/qa-instruction`, `/qa-export`, `/more`, `/artifact` | Read retained QA evidence without a model turn; also through `--ask` | **change → read from the event log** (decided `RW:207`). Same commands; IDs become short references where the user types them (Q-CMD-4) | `help: rafi manager`; `cli.md:76-92` |
| FLAG-MG-4 | `/qa-conflicts`, `/qa-repair-plan`, `/qa-repair <JSON>` | Inspect and repair conflicting QA records | **drop** (proposed; one event log has no conflicting copies, principle 1) | `help: rafi manager`; `cli.md:88` |
| FLAG-MG-5 | `/guide-builder`, `/guide-qa`, `/guide-both <run> <work> <text>` | Queue guidance for the next safe boundary | **keep** (proposed; it's GUI-VIS-6 "steer") | `help: rafi manager`; guide `:204-207` |
| FLAG-MG-6 | `/pause <run> <work>` | Pause at a safe point | **keep** (proposed; GUI-PLT-4) | `help: rafi manager` |
| FLAG-MG-7 | `/withdraw`, `/supersede` | Withdraw or replace queued guidance | **keep** (proposed) | `help: rafi manager` |
| FLAG-MG-8 | `/request-attempt <run> <work> <reason>` | Authorize one more fix after the allowance is used | **keep** (proposed) | `help: rafi manager`; `cli.md:1529` |
| FLAG-MG-9 | `/answer-question <run> <work> <decision> <revision> <text>` | Answer a pending question | **change → answers any open question, same record as `rafi answer`** (follows `RW:417`) | `help: rafi manager` |
| FLAG-MG-10 | Output safety | Default rendering redacts credentials and escapes terminal controls; `/more` cursors expire after 15 minutes | **keep** (proposed) | `cli.md:92` |

### 2.8 Other commands

| ID | Command and flag | Today | Decision | Source |
|---|---|---|---|---|
| FLAG-AG-1 | `agents --agent-type planner\|builder\|qa\|ticket-maker\|uninstaller\|manager\|discovery\|all` | Pick the role(s) | **keep** | `help: rafi agents` |
| FLAG-AG-2 | `agents --agent-make claude\|codex`, `--model`, `--reasoning`, `--fast`/`--no-fast` | Per-role runtime, model, reasoning, fast mode | **keep** (GUI-CFG-1, `RW:93`) | `help: rafi agents` |
| FLAG-AG-3 | `agents --session-strategy compact\|fresh` | Per-role session continuity | **keep**; default for builder and QA **changes → `fresh`** (decided `RW:327`) | `help: rafi agents`; `rafi/src/agents.ts:38-46` |
| FLAG-AG-4 | `agents --show-session-cost`/`--no-show-session-cost` | Show cost or cumulative tokens | **keep** | `help: rafi agents` |
| FLAG-AG-5 | `agents --auto-compact-threshold <1-99>`, `--compact-maximum <n>` | Builder/QA compaction settings | **keep** (decided `RW:92`: still needed for reused agents) | `help: rafi agents` |
| FLAG-AG-6 | Settings for inactive roles | Saved for their next session | **keep** | `cli.md:53` |
| FLAG-DR-1 | `doctor --github` | GitHub PR readiness checks | **keep** (proposed) | `help: rafi doctor` |
| FLAG-DR-2 | `doctor --live-claude` | Bounded no-tools Claude request through the real adapter; uses quota | **keep** (proposed) | `help: rafi doctor`; `cli.md:37` |
| FLAG-DR-3 | `doctor --storage`, `--cleanup-storage` | Report recovery, observability and JSONL storage; prune expired observability detail | **change → report the event log and logs; deleting moves to `rafi stats delete`** (proposed; follows `RW:168` "never deleted automatically") | `help: rafi doctor` |
| FLAG-DR-4 | `doctor` checks | Foreman, agent CLIs, config, tracker; same Node and native-module checks as the launcher | **keep**; add tool prerequisites (`RW:444`) and `alerter` on macOS (`RW:426`) (follows) | `help: rafi doctor`; guide `:236-240` |
| FLAG-AU-1 | `audit --run`, `--ticket`, `--format json\|markdown` (default markdown), `--max-spans` (default 100) | Bounded run report | **change → `rafi stats show`** keeping `--run`, `--ticket` and `--format` (proposed flags; command decided) | `help: rafi audit`; `RW:69` |
| FLAG-GR-1 | `graph status [--json]`, `adopt [--yes] [--config <file>] [--code-only]`, `refresh [--workspace] [--task] [--semantic-request] [--semantic-result]`, `prune`, `disable`, `enable` | Manage the project's Graphify setup | **keep** (proposed) | `help: rafi graph *` |
| FLAG-GR-2 | `graph query\|node\|neighbors\|path\|impact <query> [target]` with `--project`, `--json`, `--direction incoming\|outgoing\|both` | Read the graph | **keep** (proposed). "Reads never install or refresh" | `help: rafi graph *` |
| FLAG-SR-1 | `sources list [-p] [--all] [--json]`, `refresh [ids...] [-p] [--source-storage]`, `remove <id> [-p] [-y]`, `storage [local\|tracked] [-p]` | Manage the source registry | **keep** (proposed) | `help: rafi sources *` |
| FLAG-DI-1 | `discover [project]` with `--online` (repeatable), `--background` (repeatable), `--local` (repeatable), `--rafi-history`, `-a`, `-m`, `--effort`, `--fast`, `--source-storage`, `--json`, `-y` | Read-only continuation discovery | **keep** (proposed) | `help: rafi discover` |
| FLAG-UN-1 | `uninstall [project] [--dry-run]` | Preview, then move selected bytes into `.rafi-uninstall/<id>` | **keep**. Must also cover the new files (event log, progress file, logs, recordings, tool boilerplate) (follows section 4) | `help: rafi uninstall`; `cli.md:54` |
| FLAG-UN-2 | `uninstall:restore <recoveryId> [project] [--path <paths...>] [--yes]` | Restore, backing up collisions | **keep** (proposed) | `help: rafi uninstall:restore` |
| FLAG-UN-3 | `uninstall:cleanup [recoveryId] [project] [--all] [--yes]` | Permanently remove bundles; the only permanent removal | **keep** (proposed) | `help: rafi uninstall:cleanup`; `cli.md:54` |

### 2.9 Environment variables a user can set

| ID | Variable | Today | Decision | Source |
|---|---|---|---|---|
| ENV-1 | `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb` | Color rules in OUT-9 | **keep** (decided: terminal colors kept, `RW:208`) | `cli.md:24` |
| ENV-2 | `RAFI_SKIP_RUNTIME_PREFLIGHT=1` | Bypass the launcher's Node/native-module check | **keep** (proposed) | `run: rafi --version` under Node 18 printed the check and this hint |
| ENV-3 | `RAFI_AUDIT_LOGGING` | Audit logging level | **change → capture level** (follows FLAG-ST-45) | `ai-foreman/src` (one read of `process.env.RAFI_AUDIT_LOGGING`) |
| ENV-4 | `RAFI_ACTIVITY_RENDER_MODE`, `RAFI_PROVIDER_IDLE_TIMEOUT_MS`, `RAFI_QA_COMMAND_OUTPUT_EXCERPTS`, `RAFI_GITHUB_COMMAND_TIMEOUT_MS`, `RAFI_GITLAB_COMMAND_TIMEOUT_MS`, `RAFI_AUTO_MERGE_POLL_MS`, `RAFI_GRAPH_PYTHON` | Tuning knobs read from the environment | **keep or move to config** (proposed: move to `rafi-config.yaml` where they're settings; see Q-CFG-1) | `grep process.env.RAFI_` in `ai-foreman/src`, `rafi/src` |
| ENV-5 | `RAFI_BUILD_WORKER_RUN`, `RAFI_BUILD_WORKER_GENERATION`, `RAFI_DETACHED_SUPERVISOR_RUN`, `RAFI_BUILD_LAUNCH_TOKEN`, `RAFI_PROBE_ENV`, `RAFI_REHEARSAL_*` | Internal hand-off between rafi processes | **drop** (follows principle 9: one process, no hidden hand-offs) | same grep |
| ENV-6 | *(new)* `RAFI_ENGINE=next` | Pick the new engine during the side-by-side period. Without it, the old engine refuses a 1.0-format project with "This project uses 1.0 formats; set RAFI_ENGINE=next." (D6, 9.0) | **new** (`RW:529`, process step 5) | `RW:529-530` |

## 3. Prompts and questions

Prompts today use `@clack/prompts` (select, confirm, text, multiselect). The message text below is quoted from the source.

### 3.1 How questions behave today

| ID | Behavior | Decision | Source |
|---|---|---|---|
| PRM-G1 | Build questions are recorded as durable decisions with an ID, a prompt and stable choice IDs (`durableHumanDecision`), and can be answered later with `build:decide` | **change → every question is a recorded event with type, options, context and time; answerable from the terminal, a notification, `rafi answer`, Manager or the GUI; first answer wins** (decided) | `ai-foreman/src/cli/start.ts:700-728,2707`; `RW:263,414-420` |
| PRM-G2 | A build question is recorded as a durable decision. **In a terminal, 0.10.2 asks it in place and waits** (corrected 2026-11-01, step 5 review; this row first said it exits with code 2 "with or without a terminal"): `durableHumanDecision` throws `HumanDecisionRequired` only when deferred or when stdin or stdout isn't a TTY (`ai-foreman/src/humanDecision.ts:35`), `servicePendingHumanDecisions` does the same for pending questions (`humanDecision.ts:87`), the build loop calls it before stopping (`ai-foreman/src/foreman.ts:801-834,846-847`), the plan question and QA's "what next?" go through it (`ai-foreman/src/cli/start.ts:2706,2986`), and the supervised worker inherits the terminal (`ai-foreman/src/supervisedStart.ts:132`). **Without a terminal**, the question is recorded and the process exits with code 2 (`start.ts:2899`); you answer with `build:decide` and then `rafi resume` | **change → rafi keeps building what it can and waits without exiting; Ctrl+C stops it and the question stays saved for `rafi resume`** (decided `RW:393-395`). Exit code for scripts is Q-OUT-1 | `docs/guide-restart-legacy-project-build-0.10.md:139-142`; `ai-foreman/src/cli/start.ts:2899`; `ai-foreman/src/supervisedStart.ts:264` |
| PRM-G3 | Foreground builds collect pending ticket questions when no independent work remains, and at the step limit. Detached builds return with a durable waiting record | **change → questions are asked up front where possible (NEW-ASK-1); a blocked ticket is asked about at once, pinned in the terminal while other tickets build (NEW-BLK-1)** (decided) | `cli.md:26`; `RW §Ask everything up front`, `§Blocked tickets` |
| PRM-G4 | Recovery collects pending answers before any provider call; answers keep their decision identity | **keep** the rule that saved answers are reused (follows `RW:117`, saved-decision keys) | `cli.md:27` |
| PRM-G5 | `--yes` answers the plan, plan updates and capabilities requested by flag | **change → `--auto-approve` answers every question that has a safe default. What's left is what only you can do (installing software, giving a password)** (decided principle 14). The plan-update setting is separate from it (decided `RW:125`) | `help: rafi start`; `RW:311-314` |
| PRM-G6 | A provider's own question to the user (Claude `AskUserQuestion`) is relayed to the terminal with its options plus "Custom response:". In a non-interactive run it fails with "AskUserQuestion requires interactive input, but this Rafi run is non-interactive." | **change → relayed as an open question like any other, and logged as a scan gap** (follows `RW:350`) | `ai-foreman/src/providerQuestions.ts:58,67,98,192,218`; `ai-foreman/src/foreman.ts:463,478` |
| PRM-G7 | When attention is needed, rafi rings the terminal bell (on by default) and, if `notifications.enabled` is set in `foreman.yaml`, sends a plain desktop notification (macOS `osascript`, Linux `notify-send`, WSL PowerShell toast) | **change → notifications on by default, with answer choices where the platform allows** (decided `RW §Notifications`) | `ai-foreman/src/notify.ts:26-65`; `ai-foreman/src/config.ts:18-23,103`; `ai-foreman/src/foreman.ts:463` |
| PRM-G8 | Prompts never answer on the user's behalf. Claude once answered rafi's "what next?" three times in a background build | **keep** the rule; **change** so decisions always reach the user, including in background builds, and no agent answers them (decided) | `QAMC §2` "Other loose ends"; `RW:114` |
| PRM-G9 | Printed recovery commands must work when copied, even with spaces, quotes or symbols in an answer | **keep** (scenario test) | `RW:190` |

### 3.2 `rafi create` walkthrough

All **keep** (decided command), in today's order, unless marked.

| ID | Prompt | Choices | Decision | Source |
|---|---|---|---|---|
| PRM-1 | "Repository has N uncommitted path(s). How should installation proceed?" | Record exact preimages and continue / Stop so I can commit or stash first | **keep** | `rafi/src/index.ts:168-171` |
| PRM-2 | "Are you starting a new app or adding Rafi to an existing app?" | | **keep** | `rafi/src/createStackInterview.ts:41` |
| PRM-3 | "Run a read-only review of this existing codebase before continuing?" | | **keep** | `createStackInterview.ts:58` |
| PRM-4 | "Is this stack correct, and do you want to accept it?"; Frontend ("No UI" for none), Backend, Database | | **keep** | `createStackInterview.ts:76-108` |
| PRM-5 | "App name:", "Cloud provider" ("Local only" for none), "Package manager:", "Will this app call LLMs / do AI generation?" | | **keep** | `rafi/src/index.ts:232-266` |
| PRM-6 | "Agent runtime targets:" | Both (default) / Claude only / Codex only | **keep** | `index.ts:272-281` |
| PRM-7 | "Prepare QA requirements before Builder work?" | Yes (Recommended) / No — legacy Builder-first flow | **change → the per-ticket requirements file is always written (NEW-REQ-1); this question goes away** (proposed; decided that QA preparation becomes the requirements file, `RW:205`). See Q-REQ-1 | `index.ts:284-291` |
| PRM-8 | "A `docs/` path already exists. Where should Rafi put its starter docs?"; "Custom Rafi docs folder:" | | **keep** | `index.ts:697,709` |
| PRM-9 | "Where should future source snapshots be stored?" | local / tracked | **keep** | `index.ts:304,326` |
| PRM-10 | "Do you have requirements, existing plans, or backlog documents that should inform planning…?"; "Files, folders, URLs, or globs with supporting context:" | | **keep** | `index.ts:313,321` |
| PRM-11 | "Default ticket work mode:" | Current branch / Batch branch / Branch per ticket (default) | **change → asked first as "Who manages git?": "Rafi" (then Batch branch / Branch per ticket, default Branch per ticket, as today) or "Me — Rafi works on the current branch". Picking "Me" skips every branch, PR, merge and CI question (PRM-52, completion, and the CI confirmation in the upfront check)** (decided 2026-11-02, ARCH-6) | `index.ts:336-345`; `rafi/src/workMode.ts:20` |
| PRM-12 | Session strategy defaults ("Use these compact/fresh defaults?", then per role) | | **keep**; defaults shown change to `fresh` for builder and QA (decided `RW:327`) | `rafi/src/agents.ts:68-78` |
| PRM-13 | "Add Rafi files to .gitignore?" (default No); "Which Rafi files should be ignored?" | Local junk (logs, cache, recovery, local ticket DB) / All Rafi | **change → the list follows the new files (section 4); `rafi-config.yaml` and the committed progress file are never ignored** (follows `RW:73`; step 3 review) | `index.ts:354-368` |
| PRM-14 | Graphify: "Accept setup with Graphify enabled under this policy?" (default Yes) after printing the policy | | **keep** (decided `RW:206`) | `index.ts:409-411` |
| PRM-15 | Root file collisions: "N root agent file collision(s) found. How should Rafi handle them?"; skill/subagent collisions; "Use <kind> <name> instead of <name>-rafi?" | | **keep** | `index.ts:531-572` |
| PRM-16 | Runtime failures: "<runtime> failed while updating <file>. What should Rafi do?"; "<runtime> is not ready. What should Rafi do?" | retry / switch to the other runtime / cancel. Switching starts a fresh session and says continuity is lost. Non-interactive and `--yes` runs fail instead of switching | **keep** | `index.ts:589,646`; `cli.md:35` |
| PRM-17 | "What should Rafi do next?" | Run planning (Recommended) / Skip — or, when a plan or tickets exist, Skip planning (Recommended) / Run planning anyway | **keep** | `index.ts:771-775` |
| PRM-18 | "Initial planning depth (exhaustive may take substantially longer):" | Standard (Recommended) / Exhaustive grill-me | **keep** | `index.ts:780-783` |
| PRM-19 | "Both runtimes are configured. Which should plan this session?" | | **keep** | `rafi/src/planningRuntime.ts:31` |
| PRM-20 | "Set up tickets now?" | Set up now (Recommended) / Skip for now | **keep** | `index.ts:837-839` |
| PRM-21 | *(new)* Where build logs go | Kept on this computer (default) / saved in the project so they travel with git | **new** (decided) | `RW:74` |
| PRM-22 | *(new)* Offer Playwright when the project has a frontend, mobile-mcp when it has a mobile app | | **new** (decided) | `RW:438` |
| PRM-23 | *(new)* On macOS, offer to install `alerter` for answer buttons in notifications | | **new** (decided). Where in the flow is Q-NOT-2 | `RW:426` |

### 3.3 Planning prompts (`rafi plan`, `rafi tickets plan`)

All **keep** (decided commands).

| ID | Prompt | Source |
|---|---|---|
| PRM-30 | "Run a read-only planning agent and write Rafi plan docs?" (skipped by `-y`) | `rafi/src/plan.ts:652` |
| PRM-31 | "Planning brief:" | `plan.ts:1223` |
| PRM-32 | "Planning depth (exhaustive may take substantially longer):" | `plan.ts:518` |
| PRM-33 | Planner questions shown as a selectable list with "Custom response:" | `plan.ts:1180`; `rafi/src/ticketPlan.ts:544`; `old/README.md` (new-small-plan row) |
| PRM-34 | "The independent grill-me verification was interrupted. What should Rafi do?" (retry / cancel) | `plan.ts:1188`; `ticketPlan.ts:550` |
| PRM-35 | "Approve this structured plan?"; "What should the Planner revise?" | `plan.ts:922,937` |
| PRM-36 | "Set up tickets now?" after a plan. With `--yes`, must not open interactive setup (O-E2E-006) | `plan.ts:457`; `old/docs/rafi-online-e2e-findings-2026-10-13.md:265-279` |
| PRM-37 | "Where should source snapshots be stored for this project?"; "Keep newly supplied sources for future planning?" | `rafi/src/planningDriver.ts:91,101` |
| PRM-38 | `tickets plan`: "Legacy project.yaml found … Migrate it to rafi-config.yaml before planning?" | **drop** (proposed; principle 8) — `ticketPlan.ts:197` |
| PRM-39 | `tickets plan`: "Use Rafi project <name> at <dir>?"; "Unfinished ticket plan from <time>:"; "Interview depth:"; "Keep defaults, or enter a session override such as `model gpt-5.5, effort high`:" | `ticketPlan.ts:205,562,585,604` |
| PRM-40 | `tickets plan`: "Review this exact plan and ticket set:"; "Start the agreed next ticket or delivery group now?" (default No) | `ticketPlan.ts:521,615` |
| PRM-41 | Ticket planning asks the planner for up to three corrections when a proposal fails schema or source validation, never inventing tests or lowering risk; your approval is still needed | **keep**, folded into the shared repair rule (NEW-MAL-2) — `docs/reliability-workflows.md` "Recover planning" |

### 3.4 Ticket setup and population prompts

All **keep** (decided `tickets` command), except that PRM-52 is skipped when you manage git (ARCH-6).

| ID | Prompt | Source |
|---|---|---|
| PRM-50 | "Initialize the ticket tracker now?"; "Keep both default limits?" | `ai-foreman/src/cli/tickets.ts:545,753` |
| PRM-51 | "Use the recommended population settings?"; "How should saved sources be handled?" (saved / prompt / manual); "When both runtimes are configured, which should populate use?"; "Recommend splitting XL tickets?" | `cli/tickets.ts:770-812` |
| PRM-52 | "Base branch:"; "Branch prefix:"; "Use one global branch strategy or choose by inferred ticket size?"; "Keep the recommended size mapping?"; "PR/MR title standard:"; "Custom title template (use {id} and {title}):" | `cli/tickets.ts:819-914` |
| PRM-53 | "Project-wide checks for QA to verify on every ticket (comma-separated):" and custom review sections | `cli/tickets.ts:998-1039` |
| PRM-54 | Source prompts: local paths, HTTP(S) URL, "External ticket provider:", Linear team and filter, Jira site and JQL; refresh and discard pickers | `cli/tickets.ts:1082-1126` |
| PRM-55 | "Apply this exact ticket and delivery proposal?"; "Mark these removed-slice tickets obsolete: …?"; "Apply this manually edited ticket population proposal?"; "Populate tickets now?" | `cli/tickets.ts:1454,1598,1601,2061` |
| PRM-56 | Risk notes: "Reason for waiving rollback plans for …:"; "Apply rollback-only repairs to …?" | `cli/tickets.ts:433,1650` |
| PRM-57 | Reset: missing group members, per-ticket decisions, dependency on a deleted definition, "Apply this frozen N-member reset selection?", "Reset N ticket(s)? Historical events and validation remain available." | `cli/tickets.ts:1882-1924,2278` |
| PRM-58 | "These tickets belong to interrupted builds. What should Rafi do?" | **change → wording points to `rafi reset`** (follows CMD-13) — `cli/tickets.ts:2261` |
| PRM-59 | "Create one repair group for exactly N ticket(s)?" | `cli/tickets.ts:2202` |

### 3.5 Build prompts (`rafi start`)

| ID | Prompt | Choices | Decision | Source |
|---|---|---|---|---|
| PRM-70 | "Build tickets or complete delivery stacks?" then a count | Tickets (Recommended) / Complete stacks | **keep** (FLAG-ST-R4) | `ai-foreman/src/cli/start.ts:632-636` |
| PRM-71 | "How does this plan look?" (pre-flight plan) | Proceed — start implementing / Give feedback — revise the plan / Cancel; then "Your feedback:" | **keep** for new or materially changed scope; skipped when the approved scope is unchanged (decided `RW:201`); answered by auto-approve (decided principle 14) | `start.ts:2707-2735` |
| PRM-72 | "Allow builder internet for this build?" | Stay offline / Allow builder internet for this build | **change → part of the upfront permission check: Allow once / Always allow / Don't allow, asked before step 1 for every ticket in scope** (decided principle 5) | `start.ts:698-704` |
| PRM-73 | "Allow QA network for this build?" (prompt text says QA keeps a read-only workspace and recovery asks again unless `--yes`) | Keep QA offline / Allow QA network for this build | **change → same upfront check, which covers QA. Tests are run by rafi with the build's grants (NEW-CHK-2); QA needs local servers only for browser checks** (decided principle 5, `MALF 3`) | `start.ts:721-728` |
| PRM-74 | Builder sandbox escalation (`--builder-approvals`): approve once or deny a single operation | | **change → folded into `--allow` and the upfront check** (decided `RW:89`) | `ai-foreman/src/foreman.ts:214-224` |
| PRM-75 | "Uncommitted work found. How should the isolated build start?" | | **keep** (decided `RW:210`) | `start.ts:1904` |
| PRM-76 | "Resume unfinished delivery unit <id> (N remaining)?" | | **keep** (proposed) | `start.ts:784` |
| PRM-77 | "Start eligible dependency <id>: <title> instead?"; "Start <ticket> anyway?" | | **keep** (proposed) | `start.ts:940,954` |
| PRM-78 | "Retry GitHub readiness check?"; "Retry GitLab readiness check?" | | **keep** (proposed) | `start.ts:381,422` |
| PRM-79 | "<runtime> is not ready for <label>. What should Foreman do?"; "<runtime> failed during <label>. What should Rafi do?" | retry / switch / cancel | **keep**; wording says "Rafi", not "Foreman" (proposed) | `ai-foreman/src/cli/runtimeAuthPrompt.ts:211`; `ai-foreman/src/adapters/recovering.ts:178` |
| PRM-80 | "<label> is paused until probe cleanup is verified. Choose a resolution." | | **drop** (proposed; it guards rafi's own readiness-probe bookkeeping, principle 10) | `runtimeAuthPrompt.ts:185`; `rafi/src/runtimeReadiness.ts:122` |
| PRM-81 | "QA did not converge for <ticket>. What next?" (after the fix allowance) | Retry another Builder fix / Pause at this checkpoint / Explicitly waive QA / Discuss with read-only Planner | **change → add "I verified it myself" with a required note on what was seen; it records the note and waives only those findings** (decided `RW:109-111`; kept under D4, 9.0; the answer goes stale when the covered code changes, Q-QAM-3). Circling detection can raise it early (principle 4). Also asked when the checks keep failing (NEW-CHK-3), worded for that: "T1 still doesn't pass after 3 fixes (failing: …). What next?" Never asked for a rafi-owned fix ticket (NEW-CHK-17) | `start.ts:2992-2998`; `QAMC §1` |
| PRM-82 | "QA waiver confirmation: record validation_result=failed and retain unresolved issues?" | No / Waive and continue | **keep** | `start.ts:3001` |
| PRM-83 | "What should the Planner focus on?"; "QA remediation approval <rev>: <JSON proposal>" (Approve / Revise / Cancel); "Planner revision feedback:" | | **change → the Planner's change follows the plan-update rules (NEW-PUA-1), and the proposal is shown in plain English, never raw JSON** (follows principle 7 and `RW:390`) | `start.ts:3021-3061` |
| PRM-84 | "QA report recovery:"; "Specific QA report-recovery instructions:" | | **drop** (follows principle 3; QA recovery machinery goes) | `start.ts:3075,3087` |
| PRM-85 | Builder questions relayed mid-build, with "Custom response:" | | **change → see PRM-G6** | `ai-foreman/src/foreman.ts:463,478` |
| PRM-86 | *(new)* Upfront question list after tickets are made and before each build | | **new** (decided, NEW-ASK-1) | `RW §Ask everything up front` |
| PRM-87 | *(new)* Pinned blocked-ticket prompt with up to 7 options | | **new** (decided, NEW-BLK-1) | `RW:362-398` |

### 3.6 Resume, recovery and reset prompts

| ID | Prompt | Decision | Source |
|---|---|---|---|
| PRM-90 | "What should Rafi resume?" (builds and saved interviews) | **keep** (decided CMD-8) | `rafi/src/resume.ts:70` |
| PRM-91 | "How should Rafi handle implementation-plan updates during this resumed process?" — Ask me to review each plan update (Recommended) / Auto-approve plan updates for this resumed process. Asked on every resume, never saved | **drop** (decided: the setting is saved per project or per build and isn't asked again on resume, `RW:125`; asked once in the upfront scan if not saved, `RW:346`) | `rafi/src/buildResume.ts:745`; `PUA` "Today's behavior" |
| PRM-92 | "Which interrupted build should Rafi recover?"; "How should Rafi continue?" (recovery modes) | **change → only "which build" stays; no recovery mode** (decided `RW:72`) | `buildResume.ts:764,770` |
| PRM-93 | "The saved execution cannot be resumed safely. How should Rafi proceed?" | **drop** (follows principle 3: redo the step) | `buildResume.ts:152` |
| PRM-94 | "Continue from your preserved files with a fresh Builder?" | **drop** (follows principle 3) | `buildResume.ts:389` |
| PRM-95 | "Publish this as the repaired <role> checkpoint for run <id>?" (guided recovery) | **drop** (follows FLAG-RS-10) | `buildResume.ts:856` |
| PRM-96 | "Which ticket should Rafi recover first?" | **drop** (proposed; resume continues in queue order) | `buildResume.ts:929` |
| PRM-97 | "Correct saved start options (JSON array; normal scope approval follows)" | **drop** (follows principle 9: no CLI-on-CLI flags to correct) | `buildResume.ts:938` |
| PRM-98 | "How should Rafi recover the interrupted build?" | **drop** (follows principle 3) | `rafi/src/startRecovery.ts:43` |
| PRM-99 | "How should Rafi recover the rejected successor handoff?"; "Guidance for the next fresh successor:" | **drop** (follows CMD-15) | `ai-foreman/src/handoffs.ts:584,600` |
| PRM-100 | Start-over: "Which build should start over?"; "How should Rafi preserve and restart this run?"; "Which unfinished run tickets should restart from your current files?"; "Apply <action> and reset N selected ticket(s)?"; "Merged code will remain. Resetting tickets can duplicate that work. Continue anyway?"; "How should the working tree be prepared?" | **change → `rafi reset` first asks "this build, or everything?"** (decided). Which of the follow-up choices stay is Q-CMD-3 | `rafi/src/buildStartOver.ts:99-165,445` |
| PRM-101 | State transfer: "Replace existing local Rafi state in <root>?"; "Rebind this copied local build state to the current checkout?" | **drop** (follows CMD-17) | `ai-foreman/src/cli/state.ts:58,99` |

### 3.7 Other prompts

| ID | Prompt | Decision | Source |
|---|---|---|---|
| PRM-110 | `agents`: "Which roles should share these settings?"; "Runtime:"; "Model:" (Runtime default (Recommended) / Validated custom ID); "Custom model ID:"; "Reasoning:" (default, low, medium, high, xhigh); "Enable fast mode when supported?"; "Session continuity:"; compaction threshold and maximum; "Apply to <roles> in <root>?" | **keep** | `rafi/src/agents.ts:94-118,323-383` |
| PRM-111 | `uninstall`: "Remove/Restore <path>?" per path; "Optional special instructions…"; "How should Rafi handle mixed Rafi/user edits in <path>?"; "Move N path(s) into durable recovery and restore N preimage(s) in <root>?" (default No); "Restore these paths?"; "Permanently remove these recovery bundles?" | **keep** | `rafi/src/uninstall.ts:138-329` |
| PRM-112 | `discover`: "Online resources to include:"; "Background information:"; "Local files, folders, globs, areas…"; "Was Rafi used previously?"; "Describe prior Rafi usage:"; "Save N source registry entries and N snapshot(s) for future planning?" | **keep** (proposed, follows CMD-27) | `rafi/src/discovery.ts:496-513,737` |

## 4. Files rafi reads and writes in a project

Paths are relative to the project root. `<docs>` is `docs.root` from `rafi-config.yaml` (default `docs`). "Tracked" means committed in moneyTree today (`git ls-files`); "ignored" means rafi puts it in `.gitignore` or `.git/info/exclude`.

**The new engine reads only 1.0 formats** (decided 2026-11-01, Q-CFG-2). Existing 0.10.x files are converted once by `rafi migrate` (CMD-37); a "keep" mark below means the 1.0 format keeps that behavior. Runs already in progress finish on 0.10.x and aren't migrated (`RW` Process step 7).

### 4.1 Config and agent files

| ID | Path | Today | Decision | Source |
|---|---|---|---|---|
| FILE-1 | `rafi-config.yaml` | Project config written by `create`, `tickets setup:*`, `agents`, `graph`. Tracked, except that the "All Rafi" gitignore choice also ignores a config rafi created (`rafi/src/gitignore.ts:28`) | **keep** format (decided `RW:57`); new keys in FMT-C. **change → always committed, whatever the gitignore choice** (decided 2026-11-01, step 3 review) | `rafi/src/index.ts`; `spec/src/schemas.ts:414-516` |
| FILE-2 | `foreman.yaml` (optional) | ai-foreman settings: `permissions` (bash allow/escalate lists, tool lists), `notifications` (`enabled` default false, `terminal_bell` default true), `qa.enabled`, `observability` | **change → merged into `rafi-config.yaml`** (proposed; follows `RW:76` "settings you choose once live in `rafi-config.yaml`"). See Q-CFG-4 | `ai-foreman/src/config.ts:5-120`; read at `cli/start.ts:967`, `cli/doctor.ts:65,158`, `cli/tickets.ts:1480` |
| FILE-3 | `AGENTS.md`, `CLAUDE.md` (names from `agent_files.codex/claude`) | Root instruction files, with `append`, `update` or `overwrite` mode | **keep** (decided compile output) | `rafi/src/compiler.ts:103-109`; `cli.md:31,33` |
| FILE-4 | `AGENTS-rafi.md`, `CLAUDE-rafi.md` | Sidecar used in append mode when inline guidance would exceed the runtime's root-file limit; the root file gets a short managed reference block | **keep** | `compiler.ts:269-311`; `cli.md:33` |
| FILE-5 | `.codex/agents/<role>.toml`, `.agents/skills/*` | Codex agents and skills (configured target only) | **keep** (decided); content changes per NEW-INS-* | `cli.md:31`; moneyTree `.codex/agents/` (7 roles) |
| FILE-6 | `.claude/agents/*`, `.claude/skills/*` | Claude agents and skills (configured target only) | **keep** (decided) | `cli.md:31` |
| FILE-7 | `.rafi/compiled/<role>/system.md`, `meta.json` | Role bundles for all 7 roles, always written; tracked | **keep** (decided) | `compiler.ts:254`; `cli.md:31`; moneyTree `.rafi/compiled/builder/` |
| FILE-8 | `.rafi/install-manifest.json` | Install ownership and preimages, read by uninstall; tracked | **keep** (proposed) | moneyTree `git ls-files .rafi` |
| FILE-9 | Starter docs under `<docs>/` (architecture, security, ai, api, …) | Written by `create` from `special-agents/content/docs/` | **keep** (decided: agent instructions in `special-agents` kept, `RW:58`) | `docs/guide-restart-legacy-project-build-0.10.md:45-47`; moneyTree `docs/` |
| FILE-10 | `.gitignore` managed block `# rafi:start` … `# rafi:end` | "Local junk" lists `.foreman/`, `.rafi/interviews/`, `.rafi/source-cache/`, `.rafi/staging/`, `.rafi/recovery.sqlite3`, `.rafi/ownership-backups/`, `.tickets/imports/`, `.tickets/backups/`, `.tickets/ticket-state.sqlite*`, `.tickets/.gitignore`; "All Rafi" adds every file rafi created | **keep** the block; **change** its list to the new files. `rafi-config.yaml` (FILE-1), the committed progress file (FILE-40) and, when chosen, project-stored logs (FILE-42) are never ignored, even with "All Rafi" (follows `RW:73,74`; decided 2026-11-01, step 3 review) | `rafi/src/gitignore.ts:8-33` |
| FILE-11 | `.git/info/exclude` | rafi adds its local DB and log paths. If the file is a symlink (from a git template), rafi replaces it with a per-repo copy first, so it never writes to a shared file | **keep** the symlink safety (proposed) | `ai-foreman/src/gitExclude.ts:7-20`; guide `:228-234` |
| FILE-12 | `.graphifyignore`, `graphify-out/` | Graphify corpus rules and local output; output ignored | **keep** (decided Graphify kept) | moneyTree root; `.gitignore` |

### 4.2 Plans, tickets and sources

| ID | Path | Today | Decision | Source |
|---|---|---|---|---|
| FILE-20 | `<docs>/rafi-plan.json`, `<docs>/rafi-plan.md` | Latest approved plan (JSON) and its rendered Markdown; tracked | **keep** (decided `RW:56`) | `rafi/src/structuredPlan.ts:384-389` |
| FILE-21 | `<docs>/rafi-plans/<plan_id>-r<revision>.json` and `.md` | Every approved revision; immutable ("already exists and is immutable"); tracked | **keep**. These are the plan backups: all previous plans are kept (decided `RW:132`) | `structuredPlan.ts:384-396`; moneyTree `docs/rafi-plans/` |
| FILE-22 | `.tickets/tickets.yaml` | Ticket definitions; tracked | **keep** (decided `RW:56`); new fields in FMT-T | `ai-foreman/src/tickets/config.ts:46`; `ticketSchema.ts` |
| FILE-23 | `.tickets/delivery.yaml` | Delivery units: which tickets share a branch, completion mode, dependencies; tracked | **keep** (proposed; part of the ticket format) | moneyTree `.tickets/delivery.yaml`; `ai-foreman/src/tickets/delivery.ts` |
| FILE-24 | `.tickets/config.yaml` | Tracker config: app name, limits, timezone, paths, rendering, behavior; tracked | **keep** (proposed) | moneyTree `.tickets/config.yaml`; `tickets/config.ts:5-60` |
| FILE-25 | `.tickets/schema/tickets.schema.json`, `.tickets/migrations/001_init.sql` | Schema and SQL migration copied into the project; tracked | **keep** the schema (proposed); **drop** the migration file if ticket state leaves SQLite (follows FILE-26) | moneyTree `git ls-files .tickets` |
| FILE-26 | `.tickets/ticket-state.sqlite` (+ `-shm`, `-wal`) | Ticket status, events, validation; ignored | **change → ticket status moves into the committed progress file (FILE-40); history moves into the event log** (decided `RW:73`) | `tickets/stateDb.ts:7,154-173`; `gitignore.ts:20-22` |
| FILE-27 | `.tickets/tracker-rules.md` | Tracker rules for agents; generated once and never refreshed (moneyTree's is from 2026-10-05 and still describes the removed `STEP_STATUS` protocol) | **change → carries a version and is regenerated on upgrade; no contradictions with rafi** (decided principle 13; `AIR` contradictions 3–4) | `AIR`; moneyTree `.tickets/tracker-rules.md` |
| FILE-28 | `docs/ticket-progress.md`, `docs/ticket-archive.md` | Rendered progress doc (with `LLM_NEXT_QUEUE`) and archive; regenerated after every update | **keep** for people (proposed). **change**: agents get only their assigned ticket, not this queue (decided principle 13; `AIR` item 4) | `tickets/config.ts:49-50`; `AIR` |
| FILE-29 | `.tickets/backups/`, `.tickets/imports/` | Backups before import or migration; imports; ignored | **keep** (proposed) | `gitignore.ts:18-19` |
| FILE-30 | `.rafi/sources/` (tracked storage) and `.rafi/source-cache/` (local storage) | Immutable captured source versions for planning | **keep** (proposed, follows CMD-26) | `cli.md:41` |
| FILE-31 | `.rafi/interviews/` | Saved create, plan and ticket-setup answers and checkpoints (no transcripts); ignored. `cli.md:39` says completed records are pruned after 30 days, but `pruneCompletedInterviews` (`ai-foreman/src/interviews.ts:261`) is never called, so nothing is pruned today | **keep**; **change → completed records really are pruned after 30 days** (decided 2026-11-01, step 3 review) | `cli.md:39`; `interviews.ts:224,261` |
| FILE-32 | `.rafi/ticket-population-proposals/` | Saved population proposals (used by `--proposal-file`) | **keep** (proposed) | `grep` of `.rafi/` paths in source |

### 4.3 Build state and logs

| ID | Path | Today | Decision | Source |
|---|---|---|---|---|
| FILE-40 | *(new)* Committed progress file | Doesn't exist | **new**: a small text file committed with the project holding ticket status, open questions and saved answers. "Always allow" permissions aren't in it; they stay on each machine (decided, Q-PORT-2). Clone, run `rafi resume`, and the build continues (decided `RW:73`). It's `.rafi/progress.yaml` (Q-PORT-1); how it relates to the database is Q-PORT-4 | `RW:73` |
| FILE-41 | `.rafi/recovery.sqlite3` (+ WAL) | Workflow DB: 95 tables, 1,346 guard triggers; ignored | **change → one SQLite database with an append-only event log; current state is calculated from it; plain migrations, no guard triggers. Not committed** (decided principles 1, 8; `RW:73`) | `RW:28,32,271,295` |
| FILE-42 | `.foreman/<timestamp>.jsonl`, `.foreman/<timestamp>-rafi-plan.jsonl`, `.foreman/<timestamp>-tickets-populate.jsonl` | Per-run log with `preflight`, `batch-start`, `provider-lifecycle`, `step`, `batch-end` records; ignored | **change → views of the event log. Where they go is chosen in `create`: this computer (default) or the project (decided `RW:74`)** | moneyTree `.foreman/`; guide `:244-245` |
| FILE-43 | `.rafi/observability.sqlite3` | Spans, per-agent current state, rollups; ignored | **change → merged into the event log** (follows principle 1). Its data shapes feed GUI-VIS and GUI-DASH (section 7) | `GUI_PRODUCT_REQUIREMENTS.md` §2 "Observability" |
| FILE-44 | `.foreman/runs/<runId>.json` | Run JSON snapshot | **drop** (decided principle 1) | `RW:28,271` |
| FILE-45 | `.foreman/qa-report-recovery/`, `.foreman/qa-recovery-context/`, `.foreman/delivery-sessions/`, `.foreman/qa-contracts/` | QA recovery folders, delivery sessions, QA contracts | **drop** (decided principle 1) | `RW:28`; source paths grep |
| FILE-46 | `.foreman/provider-streams/` | Raw provider stream captures per session | **change → part of the `detailed` capture level in the event log** (proposed; follows `RW:168`) | moneyTree `.foreman/provider-streams/` |
| FILE-47 | `.rafi/recovery-archive/<timestamp>/`, `.rafi/reset-stage/`, `.rafi/start-over-control/`, `.rafi/communication-quarantine/`, `.rafi/ownership-backups/`, `.rafi/backups/work-admission-v4/`, `.rafi/cache/handoffs/`, `.rafi/staging/`, `.rafi/state-transfer.json`, `.rafi/state-transfer-backups/`, `.rafi/agent-files/` | Recovery, reset, hand-off, quarantine and transfer state | **drop** (decided principle 1; `RW:28` "about 18 other state folders"). What `rafi reset` keeps as an archive is Q-CMD-3 | source paths grep; moneyTree `.rafi/` |
| FILE-48 | `.rafi/logs/supervisor-<runId>.log` | Supervisor process logs | **drop** (follows principle 9: no separate supervisor process) | moneyTree `.rafi/logs/` |
| FILE-49 | `.foreman/worktrees/<runId>/<branch>/` | Isolated worktrees for branch-per-ticket and dirty-work builds; kept with `--keep-worktrees` | **keep** (proposed). State is per run, so a second build per checkout stays possible (GUI-PLT-5) | `ai-foreman/src/branch/git.ts:68` |
| FILE-50 | `.foreman/dirty-baselines/` | Baseline metadata and working patch for `--dirty-work` | **keep** (decided `RW:210`) | `docs/reliability-workflows.md` "Continue with uncommitted work" |
| FILE-51 | `.foreman/pr-bodies/`, `.foreman/mr-bodies/` | Pull/merge request bodies | **keep** (proposed) | source paths grep |
| FILE-52 | `.rafi-uninstall/<id>/` | Uninstall recovery bundles, kept until `uninstall:cleanup` | **keep** | `cli.md:54` |

### 4.4 New files the rewrite adds

| ID | Path | What | Source |
|---|---|---|---|
| FILE-60 | Per-ticket requirements file (Markdown) | Requirement IDs, acceptance criteria, scope, commands with expected results, risks. Rafi stores only its path and fingerprint (NEW-REQ-1). Location is Q-REQ-2 | `RW:145-149`; `old/QA_REQUIREMENT_REVIEW_AND_COST_CONTROL_REQUIREMENTS.md` §1.1 |
| FILE-61 | Project setup script | One script, written and kept current by the builder, that installs dependencies, starts services and runs the tests; every fresh agent runs it first (NEW-SET-1). Name is Q-SET-1 | `RW:315` |
| FILE-62 | Plan-change log | Durable log of every automatic plan change and why (NEW-PUA-2) | `RW:123,130` |
| FILE-63 | Recordings (screenshots, videos, Playwright traces) | Stored with the build logs so `rafi logs export` includes them (NEW-TOOL-5) | `RW:469-474` |
| FILE-64 | Tool boilerplate | Starter Playwright config with the per-build port, `payload.apns` and send scripts, device-check steps; tool setup notes in project docs (NEW-TOOL-4) | `RW:459,490-494` |
| FILE-65 | Log export file | One file written by `rafi logs export` (all runs or `--run <id>`), read by `rafi logs import` | `RW:74` |

## 5. Ticket, plan and config formats

### 5.1 Tickets (`.tickets/tickets.yaml`)

The file is `{ tickets: [ … ] }`. Unknown fields are allowed (`additionalProperties: true`) and `tickets show --json` returns them (`cli.md:46`). The format is **kept** (decided `RW:56`).

| ID | Field | Rule today | Decision | Source |
|---|---|---|---|---|
| FMT-T1 | `id` | Required; `^[A-Za-z][A-Za-z0-9-_]*$` | **keep** | `ai-foreman/src/tickets/ticketSchema.ts:66` |
| FMT-T2 | `order` | Required number ≥ 0; canonical implementation order | **keep** | `ticketSchema.ts:67` |
| FMT-T3 | `title`, `area`, `summary` | Required non-empty strings | **keep** | `ticketSchema.ts:68-69,74` |
| FMT-T4 | `priority` | Required `P0`–`P3` | **keep** | `ticketSchema.ts:70` |
| FMT-T5 | `size` | Required `XS`, `S`, `M`, `L`, `XL` (drives the branch size policy) | **keep** | `ticketSchema.ts:71`; `cli.md:45` |
| FMT-T6 | `risk` | Required `Low`, `Medium`, `High`. Medium/High need a rollback plan or a recorded waiver | **keep** | `ticketSchema.ts:72`; `help: rafi tickets waive-risk-notes` |
| FMT-T7 | `depends_on` | Required list of ticket IDs | **keep** | `ticketSchema.ts:73` |
| FMT-T8 | `acceptance`, `required_tests` | Required, at least one item each | **keep** | `ticketSchema.ts:75-76` |
| FMT-T9 | `likely_files` | Required list | **keep**; also feeds file-pattern tags (NEW-TAG-4) | `ticketSchema.ts:79` |
| FMT-T10 | `verification_version: 2`, `verification_requirements` | Optional structured checks | **keep** (proposed). Agents refer to them by short number, never hash IDs (NEW-REF-1) | `ticketSchema.ts:77-78`; `old/README.md` (LIVE_E2E row: 24-character hash check IDs at `ai-foreman/src/qaVerificationContract.ts:47`) |
| FMT-T11 | `qa_preparation` | Optional planner-chosen preparation depth decision | **change → feeds the requirements file** (decided `RW:205`); whether depth levels survive is Q-REQ-1 | `ticketSchema.ts:64` |
| FMT-T12 | `documentation` | Optional documentation policy | **keep** (proposed) | `ticketSchema.ts:65` |
| FMT-T13 | `rollback`, `notes` | Optional string or null | **keep** | `ticketSchema.ts:80-81` |
| FMT-T14 | `external_refs`, `source_refs` | Provenance (Linear, Jira, source registry `src_…` IDs) | **keep** | `ticketSchema.ts:82-110` |
| FMT-T15 | `supersedes`, `superseded_by` | Ticket replacement links | **keep** | `ticketSchema.ts:111-112` |
| FMT-T16 | `plan_ref` | `{ plan_id, revision ≥ 1, slice_ref }` binding a ticket to a plan slice | **keep** | `ticketSchema.ts:113-122` |
| FMT-T17 | *(new)* `tags` | List from the fixed rafi list plus project tags; unknown tags rejected at planning time; editable by you | **new** (decided `RW:322-324`) | `RW §Agent context: tags` |
| FMT-T18 | *(new)* Locked marks | A mark on a single requirement; a project-wide list lives in config (FMT-C11) | **new** (decided `RW:128`) | `RW:128` |
| FMT-T19 | *(new)* Person-only checks marked on the ticket | The Planner marks the acceptance checks only a person can do; QA verifies the rest, and rafi asks you the marked ones when the build reaches the ticket (D4, 9.0). *Was:* an operator checklist note that QA and the build ignore, shown when the ticket finishes | **new** (decided `RW:109-111`; D4) | `QAMC §1` |
| FMT-T21 | *(new, reserved)* `workflow` on a ticket | Not supported in 1.0 | **new, rejected**: exits 1 with "Custom workflows aren't supported yet." (ARCH-13) | `REWRITE_ARCHITECTURE.md` 4.8 |
| FMT-T20 | *(new)* Manual-checks setting per ticket | B or C as a per-ticket override of the D4 default (D4 replaces choice A, 9.0) | **new** (decided `RW:109`) | `QAMC §1` |

Ticket status (kept outside `tickets.yaml` today):

| ID | Item | Today | Decision | Source |
|---|---|---|---|---|
| FMT-S1 | Status values | `planned`, `next`, `in_progress`, `blocked`, `done`, `canceled`, `obsolete` (obsolete set by population when a slice is removed) | **keep** the values users see in `tickets update`, `queue` and `show` (proposed). The engine's ~6 states (queued, building, reviewing, fixing, done, blocked; principle 2) map onto them; see Q-FMT-1 | `tickets/stateDb.ts:7`; `help: rafi tickets update`; `cli/tickets.ts:1601` |
| FMT-S2 | Where status lives | `.tickets/ticket-state.sqlite`, ignored | **change → committed progress file** (decided `RW:73`) | FILE-26 |
| FMT-S3 | Blockers | Explicit blockers with type, summary, unblock criteria; plus dependency blockers recalculated from `depends_on` | **keep**; a blocked ticket keeps its reason (scenario test, `RW:192`) | `help: rafi tickets block`; `cli.md:46` |
| FMT-S4 | Validation evidence | `done` requires evidence unless `not_applicable` (`require_validation_evidence_for_done: true`) | **keep** | `help: rafi tickets complete`; moneyTree `.tickets/config.yaml` |
| FMT-S5 | Creation groups `TG-N` | Immutable groups of tickets created together; used by `tickets reset --group` | **keep** (proposed) | `help: rafi tickets groups list`, `tickets reset` |
| FMT-S6 | *(new)* Won't-do | "Drop T2 (won't do)" from the blocked-ticket prompt; dependents are flagged | **new** (decided `RW:391`). Maps to `canceled`? See Q-FMT-1 | `RW:378,391` |

### 5.2 Delivery units (`.tickets/delivery.yaml`)

| ID | Field | Today | Decision | Source |
|---|---|---|---|---|
| FMT-D1 | `version`, `plan: { plan_id, revision }` | File version and the plan it came from | **keep** (proposed) | moneyTree `.tickets/delivery.yaml` |
| FMT-D2 | `units[]`: `id`, `tickets`, `branch_mode` (`current`, `per-ticket`, `shared`), `completion`, `provider`, `pr_ready`, `merge_method`, `cleanup`, `depends_on`, `dependency_mode` (`combine`, `wait`, `stack`) | One unit per branch or review; a current-branch unit can't be stacked | **keep** (proposed); `completion` gains `pr-ready` (follows `RW:84`); **`pr_ready` is dropped**, converted by `rafi migrate` (decided, Q-CFG-1) | moneyTree `.tickets/delivery.yaml`; `ai-foreman/src/tickets/delivery.ts:141-145,199` |

### 5.3 Tracker config (`.tickets/config.yaml`)

| ID | Keys | Decision | Source |
|---|---|---|---|
| FMT-K1 | `app_name`, `implementation_limit` (500), `view_limit` (20000), `timezone` (UTC), `timestamp_format`, `paths.{tickets, state_db, tracker_rules, progress_doc, archive_doc}`, `rendering.*`, `behavior.*` (`regenerate_progress_doc_after_every_update`, `require_validation_evidence_for_done`, `block_on_unresolved_dependencies`, `use_atomic_file_writes`, `backup_before_import_or_migration`) | **keep** (proposed); `paths.state_db` changes with FMT-S2 | moneyTree `.tickets/config.yaml`; `tickets/config.ts:40-60` |

### 5.4 Plans (`<docs>/rafi-plan.json` and `.md`)

| ID | Field | Today | Decision | Source |
|---|---|---|---|---|
| FMT-P1 | `version` (1), `plan_id` (`pln_…`), `revision` (starts at 1, +1 per approved revision), `content_digest` | Plan identity | **keep** (decided `RW:56`) | `rafi/src/structuredPlan.ts:232,252`; moneyTree `rafi-plan.json` keys |
| FMT-P2 | `summary`, `assumptions[]`, `implementation_changes[]`, `acceptance_criteria[]`, `test_plan[]` | Plan body | **keep** | `structuredPlan.ts:89,254` |
| FMT-P3 | `slices[]`: `slice_ref`, `title`, `summary`, `acceptance[]`, `required_tests[]`, `likely_files[]`, `depends_on[]` (acyclic), optional `qa_preparation`, `documentation`, `source_refs`, `verification_version`/`verification_requirements` | One slice becomes one ticket | **keep**; slices gain tags and locked marks (follows FMT-T17/18) | `structuredPlan.ts:261-297` |
| FMT-P4 | `delivery_units[]`: `id`, `slice_refs`, `branch_mode`, `completion`, `provider`, `pr_ready`, `merge_method`, `cleanup`, `depends_on`, `dependency_mode` | Same shape as FMT-D2 | **keep**, without `pr_ready` (decided, Q-CFG-1) | `structuredPlan.ts:300-330,370` |
| FMT-P5 | `stacks[]`: `stack_id`, `name`, `units` | Stacked delivery groups | **keep** | `structuredPlan.ts:331-345` |
| FMT-P6 | Markdown pair | Rendered from the JSON, starting with `<!-- rafi-plan plan_id=… revision=… digest=… -->`. `plan --validate` fails if the pair doesn't match | **keep** | `structuredPlan.ts:363-370,407-411` |
| FMT-P7 | Supporting sources never replace plan slices | In approved-plan mode, `--sources` and saved sources only add context; they can't change plan identity, revision or slice mapping | **keep** | `cli.md:42-43`; `README.md` "Fresh Project" |

### 5.5 Project config (`rafi-config.yaml`)

The format and compile output are **kept** (decided `RW:57`). Required keys today: `appName`, `timezone`, `stack`, `flags`, `harness`, `agent_files`, `agents`, `skills` (`spec/src/schemas.ts:418`).

| ID | Key | Today | Decision | Source |
|---|---|---|---|---|
| FMT-C1 | `appName`, `timezone` | Required | **keep** | `schemas.ts:428-429` |
| FMT-C2 | `stack.{frontend, backend, database, cloud, packageManager}` | Required strings | **keep** | `schemas.ts:430` |
| FMT-C3 | `flags.{hasFrontend, usesAI, runsInCloud}` | Required booleans. Today they switch rule packs on for the whole project, so every ticket gets the AI and accessibility packs | **keep** the keys; **change** what they do: packs are chosen per ticket by tags (decided `RW:325`) | `schemas.ts:431`; `AIR` item 2 |
| FMT-C4 | `harness.{targets: [claude, codex], qa: boolean}` | Runtime targets and QA on/off | **keep** | `schemas.ts:432-444` |
| FMT-C5 | `agent_files.{mode: append\|update\|overwrite, codex, claude}`, `agents`, `skills` (path maps with `artifact_source: rafi\|existing`) | Root files and artifact paths | **keep** | `schemas.ts:185-199,445-454,474-475` |
| FMT-C6 | `docs.root`, `planning.sources`, `sources` (registry: `version`, `snapshot_storage`, `pending`, `entries[]` with `src_…` IDs and immutable `versions[]`), `graph` | | **keep** | `schemas.ts:352-375,427,455-470` |
| FMT-C7 | `agent_defaults.{version: 1, revision, roles.<role>.{make, model, reasoning, fast, session_strategy, display_session_cost}}`; builder and QA also `auto_compact_threshold_percent`, `compact_maximum` | Roles: planner, builder, qa, ticket-maker, uninstaller, manager, discovery. Default `session_strategy`: `compact` for builder, QA and ticket-maker; `fresh` for the others | **keep**, with every role including QA configurable (decided `RW:93`); default for builder and QA **changes → `fresh`** (decided `RW:327`). Ticket-maker default is Q-CFG-5 | `schemas.ts:322-350,472`; `rafi/src/agents.ts:38-46` |
| FMT-C8 | `tickets.limits`, `tickets.sources[]` (local, linear, jira, url), `tickets.populate.{mode, source_handling, agent_preference, import_cap, comment_limit, enrichment, recommend_split_for_xl}` | Ticket setup | **keep** | `schemas.ts:201-276` |
| FMT-C9 | `tickets.build.{branch_strategy, completion, provider, pr_ready, merge_method, cleanup, auto_merge_wait, auto_merge_timeout_minutes, base_branch, branch_prefix, branch_policy, review, validation_checklist}` | Saved build defaults | **keep**; these now also hold the "config only" start flags (FLAG-ST-35..46). `completion` gains `pr-ready`; **`pr_ready` is dropped** in favor of `completion: pr-ready`, and `rafi migrate` converts it (decided, Q-CFG-1) | `schemas.ts:277-318`; `RW:92` |
| FMT-C10 | `autonomy.{profile, continue_independent_tickets, runtime_deadlines, rules, supervisor}` | Profile `balanced` by default; continue independent tickets `true`; rules for `qa.nonconvergence`, `runtime.transient`, `plan.material_change`; supervisor restart limits | **change** (follows principles 4, 9, 14; FLAG-ST-33): `supervisor` **drops** (one process); `continue_independent_tickets` is always on (decided `RW:202`); the rest becomes one `retries` setting, default 3 fix attempts per ticket (after QA rejects or a check fails, NEW-CHK-3) and 3 provider-error retries (decided, Q-CFG-3) | `schemas.ts:377-404,473`; `ai-foreman/src/recoveryPolicy.ts:20-40` |
| FMT-C11 | `qa_preparation` (boolean, or a legacy `{mode}` object), `qa_preparation_shadow`, `qa_preparation_wall_time_ms` | QA preparation before building | **change → the per-ticket requirements file** (decided `RW:205`); keys are Q-REQ-1 and Q-CFG-2 | `schemas.ts:420-426`; `cli.md:32` |
| FMT-C12 | *(new)* `tools:` | Each entry: how to start it, a one-line description, roles, tags, permissions, how to stop it, how results are recorded, supported versions, license | **new** (decided `RW:439-451`) | `RW §How tools work` |
| FMT-C13 | *(new)* Tags | Project-specific tags, each with optional file patterns (for example `ui`: `**/*.tsx`, `**/*.css`) | **new** (decided `RW:324,329`) | `RW §Agent context: tags` |
| FMT-C14 | *(new)* Plan-update setting | Change-then-tell (default) or ask first; per project or per build; separate from auto-approve | **new** (decided `RW:123-125`) | `PUA §2, §4` |
| FMT-C15 | *(new)* Project-wide locked requirements list | For example "always use PostgreSQL" | **new** (decided `RW:128`) | `RW:128` |
| FMT-C16 | *(new)* Manual-checks mode | The D4 behavior by default (9.0); B or C per project | **new** (decided `RW:109`) | `QAMC §1` |
| FMT-C17 | *(new)* Notifications | On by default; per-event preferences; reminder timing | **new** (decided `RW:429`) | `RW §Notifications` |
| FMT-C18 | *(new)* Build logs location | This computer (default) or the project | **new** (decided `RW:74`) | `RW:74` |
| FMT-C19 | *(new)* Capture level | `none`, `normal`, `detailed` | **new** (decided for 1.0, `RW:168-169`); replaces `--audit-logging` (FLAG-ST-45) | `old/FULL_RUN_FORENSIC_REPLAY_IMPLEMENTATION_PLAN.md` §1 |
| FMT-C20 | *(new)* Recordings | What's saved (failures only by default, or everything) and how long (5 choices; default last 5 builds) | **new** (decided `RW:469-474`) | `RW §Parallel builds` |
| FMT-C21 | *(new)* Saved permissions ("always allow") | Saved for the project, **on this machine only**; not committed. On a new machine they're shown in the upfront check | **new** (decided principle 5; Q-PORT-2) | `RW:286`; `RW:73` |
| FMT-C22 | *(new)* Approval mode | Manual or auto-approve, per project or per instance | **new** (decided principle 14; GUI-INS-6, GUI-PLN-8) | `RW:311-312` |
| FMT-C23 | *(new)* `checks.ci_tests` (`full`, `light`, `none`; default `full`), `checks.ci_when` (`each-ticket`, `each-pr`, `end-of-build`, `light-each-pr-full-end`; default `end-of-build`), `checks.ci_blocks_merge` (default `false`), `checks.test_runner`, `checks.output_paths` | Rafi's CI step (NEW-CHK-8, NEW-CHK-10) | **new** (decided 2026-11-02, ARCH-5) | `REWRITE_ARCHITECTURE.md` 6.10 |
| FMT-C26 | *(new, reserved)* `workflows:` | Not supported in 1.0 | **new, rejected**: exits 1 with "Custom workflows aren't supported yet." (ARCH-13) | `REWRITE_ARCHITECTURE.md` 4.8 |
| FMT-C25 | *(new)* `git.managed_by` (`rafi`, `me`) | Who manages git (ARCH-6); `me` sets branch strategy `current` and completion `none` | **new** (decided 2026-11-02, ARCH-6) | `REWRITE_ARCHITECTURE.md` 6.10 |
| FMT-C24 | *(new)* `timeouts.check_quiet_minutes` (2), `timeouts.check_minutes` (5), `timeouts.suite_minutes` (20) | Test time limits (NEW-CHK-6) | **new** (decided 2026-11-02, ARCH-5) | `REWRITE_ARCHITECTURE.md` 6.11 |

### 5.6 Compile output

| ID | Item | Today | Decision | Source |
|---|---|---|---|---|
| FMT-O1 | Targets | Codex writes `AGENTS.md`, `.codex/agents/*`, `.agents/skills/*`; Claude writes `CLAUDE.md`, `.claude/agents/*`, `.claude/skills/*`; `.rafi/compiled/<role>/*` always | **keep** (decided `RW:57`) | `cli.md:31` |
| FMT-O2 | Contents | Every rule pack for the project, skills preloaded in full, the Graphify paragraph in every preamble; the compiled builder file is 22,320 characters and 267 lines | **change → a small always-on core; packs, skills and tools picked per ticket by tags; skills listed by name and description; Graphify text only in its skill; files carry a version and are regenerated on upgrade** (decided principle 13, `RW §Agent context: tags`) | `AIR` items 1–5 and "What to improve" 4 |

## 6. Outputs

### 6.1 Terminal output

| ID | Output | Today | Decision | Source |
|---|---|---|---|---|
| OUT-1 | `rafi status` | Lines prefixed `rafi:` and `foreman:`: project and root; latest log file; step and escalation counts; branch-mode counts; `outcome — blocked (0/1)`; "Deferred tickets: T002." followed by **the builder's full raw JSON reply** (about 4 KB) and "Resume with: rafi resume"; unfinished runs with checkpoint; "recover with `rafi build:resume …`"; supervisor state and recovery attempts | **change → one plain-English line per blocked ticket (what, why, what waits on it), the open questions, "Waiting on you since 14:05 (T2)", and the exact command to continue. Never raw JSON. Commands it prints are the new ones** (decided principle 7, `RW:351`) | `run: rafi status .` (exit 0) |
| OUT-2 | `rafi tickets queue` | "Batches: none configured. Queue is flat." then numbered rows `[status] ID: title (priority, blocked: …)` with a `Next:` line. A blocked ticket's `Next:` shows "Resolve blocker:" followed by the raw JSON reply | **keep** the layout; **change** the blocker text to the one-line reason (follows principle 7) | `run: rafi tickets queue` (exit 0) |
| OUT-3 | `tickets queue` scope | Compact summary of unfinished work with view limits; `tickets show --all` for the complete set | **keep** | `cli.md:58` |
| OUT-4 | `rafi tickets show <id>`, `--all` | Complete readable record: definition, state, recalculated blockers, validation history, events, delivery context | **keep** | `cli.md:46,58` |
| OUT-5 | `rafi tickets validate` | "validation passed — all 4 passes clean"; exit 1 on error | **keep** | `run: rafi tickets validate`; `help: rafi tickets validate` |
| OUT-6 | Stops | A stop prints the raw reply, for example "Structured result is not valid JSON: trailing content at byte 4412" and the reply as the reason | **change → every stop says in one line what happened, why, and the exact command to continue** (decided principle 7, `MALF 7`) | `MALF` "What happened" 4–5 |
| OUT-7 | `--steps` admission | "requested --steps 4; admitting 1 ticket(s). The next delivery unit … is not yet eligible, so it will run separately." One `start` built only T001 of a chain | **change → `--steps N` counts finished tickets and keeps pulling the next eligible ticket until N are finished** (decided `RW:396`). `--steps N` must not stop early (O-E2E-005, scenario test `RW:220`) | `docs/guide-restart-legacy-project-build-0.10.md:214-218`; `old/docs/rafi-online-e2e-findings-2026-10-13.md:219-240` |
| OUT-8 | Live activity | Progress rows with timestamps, status coalescing and heartbeat; safe newline-record default on terminals. Claude tool completion uses the tool's name and call ID; errors, timeouts, cancellations and unknown outcomes are distinct; duplicate result events are coalesced; `TIME_ELAPSED` is reported as unknown | **keep** (proposed). Harmless failed reads during exploration must not show as repeated "tool failed" lines (O-E2E-004, scenario test `RW:225`) | `docs/reliability-workflows.md` "Claude activity"; `old/docs/terminal-color-requirements-plan.md` req 6 |
| OUT-9 | Colors | Basic ANSI colors on labels only when the stream is a TTY, decided per stream; ordinary prose stays default. `NO_COLOR` (even empty), `TERM=dumb`, `FORCE_COLOR=0` turn it off; `FORCE_COLOR=1/2/3` turns it on; `NO_COLOR` and `TERM=dumb` win. Machine-readable output is always ANSI-free. Untrusted text (model output, ticket content, paths) is rendered safely before styling | **keep** (decided `RW:208`) | `cli.md:23-25`; `old/docs/terminal-color-requirements-plan.md` reqs 1–10 |
| OUT-10 | Launcher check | Before any command, checks Node 24.x and the native SQLite module, and prints the cause and fix, for example "node 24.x: v18.12.1 … fix: run Rafi with Node 24.x, e.g. `nvm use 24`" and the `RAFI_SKIP_RUNTIME_PREFLIGHT=1` hint | **keep** (proposed) | `run: rafi --version` under Node 18; guide `:236-240` |
| OUT-11 | Prefixes | Messages use `rafi:`, `foreman:`, `ai-foreman:` and `foreman tickets:` | **change → `rafi:` only** (proposed; follows CMD-36 and `AIR` contradiction 3, "`foreman` isn't a command") | `run: rafi status .`; `run: rafi tickets validate`; `ai-foreman/src/cli/start.ts:714` |
| OUT-12 | Session cost | Builder/QA cost or cumulative tokens when `display_session_cost` is on | **keep**; label measured numbers as measured and estimates as estimates (GUI-DASH-3) | `help: rafi agents`; `schemas.ts:341` |
| OUT-13 | Compaction notice | Distinguishes the requested threshold from the verified provider setting; doesn't mean compaction happened | **keep** (proposed). The Claude threshold mismatch is open (Q-ADP-1) | `cli.md:53` |
| OUT-14 | Ctrl+C | Preserves interrupted work and waits for the provider to shut down before releasing the build | **keep**; cancel, pause and crash are recorded as different outcomes (scenario test `RW:192`) | `cli.md:51` |
| OUT-15 | Plan docs | `rafi plan` writes the JSON/Markdown pair and history (FILE-20, FILE-21) | **keep** | `structuredPlan.ts:391-400` |
| OUT-16 | *(new)* Pinned prompt | Blocked-ticket question pinned at the bottom of the terminal while other output scrolls above; several are stacked oldest first | **new** (decided `RW:366,394`) | `RW:362-394` |
| OUT-17 | *(new)* Terminal title and status line | "Waiting on you since 14:05 (T2)" | **new** (decided `RW:351`) | `RW:351` |
| OUT-18 | *(new)* End-of-build summary | Short summary of cost and time; how long rafi waited on you; plan changes made; skipped questions still open; person-only checks still unconfirmed (setting C) and the tickets built on them; from rafi's CI points, tests still failing, already broken or flaky, and fix tickets left unfixed (NEW-CHK-9, NEW-CHK-10) | **new** (decided `RW:164,351,123,388`; `QAMC §1`; D4 in 9.0 replaces "operator checklists for finished tickets") | as listed |
| OUT-19 | *(new)* Tag reasons | Every tag added by a file pattern is shown with its reason | **new** (decided `RW:329`) | `RW:329` |
| OUT-20 | *(new)* Plan change notice | When rafi changes the plan, it says what changed and why at that moment | **new** (decided `RW:123`) | `PUA §2` |

### 6.2 Machine-readable output

All **keep** (proposed), ANSI-free (decided with OUT-9).

| ID | Command | Format | Source |
|---|---|---|---|
| OUT-30 | `tickets show --json` (and `--all --json`) | Versioned JSON envelope with the complete canonical record, including unknown fields. With `--output`, appended as a pretty-printed block | `help: rafi tickets show`; `cli.md:46,74` |
| OUT-31 | `tickets groups list --json` | "versioned stable JSON envelope" | `help: rafi tickets groups list` |
| OUT-32 | `sources list --json`, `discover --json`, `graph status --json`, `graph query/node/neighbors/path/impact --json` | JSON | `help: rafi sources list`, `rafi discover`, `rafi graph *` |
| OUT-33 | `audit --format json\|markdown` | Bounded run report | **change → `rafi stats show --format …`** (decided CMD-19) — `help: rafi audit` |
| OUT-34 | Manager JSON responses and host-command output | JSON contracts stay parseable; mixed JSON/evidence output keeps its format | `cli.md:25`; `old/docs/terminal-color-requirements-plan.md` req 5 |
| OUT-35 | *(new)* `rafi stats export` | Stable JSON event stream and visualization data | `old/FULL_RUN_FORENSIC_REPLAY_IMPLEMENTATION_PLAN.md` §10 |

### 6.3 Exit codes

| ID | Code | When today | Decision | Source |
|---|---|---|---|---|
| OUT-40 | 0 | Success; also user cancel in prompts (`process.exit(0)`) | **keep** (proposed) | `ai-foreman/src/cli/start.ts:635,2721-2724` |
| OUT-41 | 1 | Errors; `tickets validate` on validation errors | **keep** | `help: rafi tickets validate` |
| OUT-42 | 2 | A build stopped waiting for a person (question recorded, or supervised worker waiting). Only without a terminal: in a terminal, 0.10.2 asks in place instead (PRM-G2; `ai-foreman/src/humanDecision.ts:35,87`) | **change → a foreground build no longer exits while waiting** (decided `RW:395`). What a detached or non-terminal build returns is Q-OUT-1 | `start.ts:2323-2899`; `supervisedStart.ts:118,216,264`; guide `:139-142` |

## 7. What `GUI_PRODUCT_REQUIREMENTS.md` requires of the CLI and engine

The GUI is built after the rewrite (`RW §What the GUI needs from the engine`). This section lists the GUI requirements that constrain user-visible CLI behavior or the data the engine must record, so the GUI doesn't need another rewrite. The seven platform needs the rewrite answers directly (GUI-PLT-2, 3, 4, 5, 6, 10, 11) are in section 8.13.

| ID | GUI requirement | What it means for the rewrite | Decision | Source |
|---|---|---|---|---|
| GUI-R1 | GUI-PLAT-3: the CLI stays first-class; CLI commands run while the daemon is active must be safe and show up live | Every action goes through the one engine library the CLI also uses; CLI changes appear in the event log | **keep** (follows principle 9) | GUI-PLAT-3; `RW:260` |
| GUI-R2 | GUI-PAR-1: a parity matrix maps every CLI command and flag group to a GUI surface; `qa-rehearse-rollback` and test scripts are listed as "no GUI surface" | Section 2 of this doc is the command list the matrix starts from. Its "Build control" row (`start`, `build:resume`, `resume`, start-over/reset) becomes `start`, `resume`, `stop`, `reset`, `answer` | **change** the matrix's command names (follows section 2) | GUI-PAR-1 §7.3 table |
| GUI-R3 | GUI-PAR-2: every mutating action states what it will do first, and can show the equivalent CLI command | Each engine action has a plain-language preview and a CLI form | **new** | GUI-PAR-2 |
| GUI-R4 | GUI-RUN-1: start, pause, stop, resume per instance, with defined semantics (pause = finish or checkpoint then hold; stop = cancel, keep evidence; resume = continue from durable state) | Matches step boundaries as safe points (principle 2) and redo-the-step resume (principle 3). **Stop follows `rafi stop`** (Q-CMD-6): "stop requested → stopping at the next safe point"; a second stop or Ctrl+C cancels immediately, keeping evidence | **change** from GUI-RUN-1's immediate stop | GUI-RUN-1 |
| GUI-R5 | GUI-RUN-2: controls report in-between states ("Pausing… waiting for builder to reach a safe point") and never silently ignore a request | Pause and stop requests are events with their own states | **new** | GUI-RUN-2 |
| GUI-R6 | GUI-RUN-4: network and approvals are explicit and scoped, "never implied by 'yes to all'" | `--allow` stays separate from `--auto-approve`. Auto-approve can grant a permission, but internet access, installs and live services always get an explicit warning in the upfront check first, so they're never granted silently (decided, Q-APR-1) | **change**: the warning is the explicit, scoped step GUI-RUN-4 asks for (follows `RW:81-82`; `PUA §4`; Q-APR-1) | GUI-RUN-4 |
| GUI-R7 | GUI-RUN-5: recovery flows show detected state, options and consequences before acting | `rafi reset` previews what it will do (FLAG-RE-1) | **keep** (follows `cli.md:47` preview-first) | GUI-RUN-5 |
| GUI-R8 | GUI-INS-6, GUI-PLN-8: approval mode (manual or auto-approve, visibly flagged and auditable), build mode (don't build / N steps / everything), ticket sourcing, ticket size policy | These are settings the engine accepts per project and per instance | **new** (decided principle 14 for approval mode) | GUI-INS-6, GUI-PLN-8; `RW:312` |
| GUI-R9 | GUI-INS-7: one lifecycle vocabulary (Draft → Planning → Awaiting plan approval → Ticketing → Ready → Building → QA → Awaiting you → Paused → Failed/Recovering → Complete → Archived), mapped to engine states | Engine states must be derivable from the event log and mappable to this list. Every GUI label maps from the ticket, build and project states in NEW-ENG-2; the exact mapping is set in the architecture plan (guide step 7) | **new** (Q-LIFE-1) | GUI-INS-7 |
| GUI-R10 | GUI-INS-8: reset tickets, plan or both, with preview | `rafi reset` covers "this build" and "everything"; plan reset is Q-CMD-3 | **change** (follows CMD-32) | GUI-INS-8 |
| GUI-R11 | GUI-VIS-2: liveness honesty: working, active but quiet, waiting on tool or provider (retry/backoff), waiting on you, stalled | Events record last signal and last real progress per agent, and retries with their backoff | **new** | GUI-VIS-2 |
| GUI-R12 | GUI-VIS-4: agent detail: activity stream, ticket and acceptance criteria, files touched, commands and results, tokens and cost, timing, session ID, runtime, error and retry history | Each of these is in the event log (NEW-MEAS-1) | **new** | GUI-VIS-4 |
| GUI-R13 | GUI-VIS-5, GUI-VIS-7: change model, reasoning and fast mode with a stated scope ("this agent now", "from next turn", "project default") and stated consequences (new session, lost continuity, cost) | Matches today's "fresh provider session, lost continuity" notice on runtime switch | **keep** the notice (`cli.md:35`); **new** scoped changes | GUI-VIS-5, GUI-VIS-7 |
| GUI-R14 | GUI-VIS-6: steer messages shown as pending → delivered → acknowledged; "btw" side questions | Manager `/guide-*` (FLAG-MG-5) is today's steer; their delivery states are events. Side questions depend on the runtime (GUI open question 3) | **keep** steer; **new** states | GUI-VIS-6; `old/docs/manager-qa-and-resume-resolution-brief.md` "Deliver user direction reliably" |
| GUI-R15 | GUI-VIS-10, §12.2: reconnecting clients resync without gaps; event delivery is at-least-once with idempotent handling; a daemon restart recovers runs from durable state | Event log readable from a cursor (NEW-GUI-1) | **new** | GUI-VIS-10; GUI §12.2 |
| GUI-R16 | GUI-PLN-2: planner options rendered as choices with the recommended one highlighted; answers keep their decision identity | Planner questions are recorded events with options and a recommended flag | **keep** (today: PRM-33) | GUI-PLN-2 |
| GUI-R17 | GUI-ATT-1, 2, 6–13: one attention inbox; questions sidebar; question modal; answer anywhere, first answer wins; desktop notifications from the daemon; blocked-ticket choices; reminders oldest first; questions up front; "Waiting on you since" | Same as NEW-ASK, NEW-BLK, NEW-NOT | **new** (decided in `RW`) | GUI-ATT-*; `RW §Notifications` |
| GUI-R18 | GUI-MGR-1, GUI-MGR-4: Manager's structured outputs render as cards; each instance's Manager writes a compact instance report (state, progress, blockers, pending decisions, cost, risks, ETA) | Manager reads the event log (FLAG-MG-3); the report is a view of it | **new** | GUI-MGR-1, GUI-MGR-4 |
| GUI-R19 | GUI-MAE-4, GUI-MAE-6: Maestro does anything the user can, only through the action API with the user's permissions, attributed in the audit log | Every action event records who did it (user, CLI, Maestro, API) | **new** | GUI-MAE-4, GUI-MAE-6 |
| GUI-R20 | GUI-CFG-1, 2, 3: per-role runtime, model, reasoning and fast mode for every role; each setting shows its effective value and where it came from (org policy → project → instance); each says when a change takes effect | Settings resolve in layers with a recorded source; `--set` is the CLI's instance override | **new** (decided `RW:76,93`) | GUI-CFG-1..3 |
| GUI-R21 | GUI-ENT-3: org policies can lock settings (allowed runtimes, mandatory manual plan approval, no auto-approve, no builder network, required QA, limits) | Locked settings can't be overridden by flags, `--set` or Maestro | **new** (decided `RW:76`) | GUI-ENT-3 |
| GUI-R22 | GUI-RTM-1, GUI-RTM-3: model and runtime pickers come from adapter-reported capabilities; a model that can't meet a role's needs is flagged before the build | Same as principle 16 (NEW-CAP-1) | **new** (decided) | GUI-RTM-1, 3; `RW:316` |
| GUI-R23 | GUI-DASH-1, GUI-DASH-3: dashboards for duration, spend, quality, throughput; measured vs estimated cost always distinguished | Event log records measured values and marks estimates | **new** | GUI-DASH-1, 3 |
| GUI-R24 | §12.4: secrets redacted in streamed output and logs; agent output never rendered as trusted HTML | Same rule as today's Manager rendering (FLAG-MG-10) and OUT-9 | **keep** | GUI §12.4 |
| GUI-R25 | GUI-INS-2, GUI-INS-3: instances isolated by worktree/branch; shared-branch policy chosen per project | Design for it (GUI-PLT-5); don't build it yet | **new** (decided `RW:262`) | GUI-INS-2, 3 |
| GUI-R26 | GUI-RUN-7: "CI testing" and "When" dropdowns and "Failing tests block merge" switch, shown only when rafi handles git | The engine exposes `checks.ci_tests`, `checks.ci_when` and `checks.ci_blocks_merge` and whether rafi handles git (NEW-CHK-8, NEW-CHK-12) | **new** (decided 2026-11-02, ARCH-5) | GUI-RUN-7 |

## 8. New behavior

Everything here is new or changed behavior the rewrite must build. It covers every item in `RW §Work folded into the rewrite` and `RW §What the GUI needs from the engine`, with details taken from each source doc. Open questions from those docs are carried into section 9 and referenced by ID.

### 8.1 Engine shape

These design principles add behavior a user will notice. All decided in `RW §Design principles`.

| ID | Requirement | Source |
|---|---|---|
| NEW-ENG-1 | One SQLite database holds an append-only event log of every event, in order. Current state is calculated from it. The committed progress file is a snapshot written from it, not a second source of truth (Q-PORT-4). No JSON run files or recovery folders duplicate it. Anything shown to agents (the requirements file, a review packet) is a view of it, not a second copy | principle 1; `RW:178` |
| NEW-ENG-2 | Three levels of state, each derived from the event log (Q-LIFE-1). **Ticket:** queued, building, reviewing, fixing, done, blocked. **Build:** running, waiting on you, paused, stopping, stopped, finished, failed. **Project:** draft, planning, awaiting approval, ticketing, ready, building, complete, archived. Transitions live in one pure function, `next(state, event)`, tested over every combination | principle 2 |
| NEW-ENG-3 | Every agent turn is keyed by run, ticket and step. After a crash the step is redone, not proven | principle 3 |
| NEW-ENG-4 | Every error is sorted into one of three groups: retry automatically with backoff (bad JSON, timeouts, format slips, transient provider errors; the error is sent back to the agent); permission needed (asked up front); ask the user (last resort, after retries or for a real product decision) | principle 4; `MALF` "Direction" 1 |
| NEW-ENG-5 | Spotting circles (harness F09). Progress means a requirement passes, a check result changes, or a blocker is resolved. Several attempts failing the same way with no progress stop retries for that ticket and ask, even with attempts left. New files read or different fixes tried don't count as circling | principle 4 |
| NEW-ENG-6 | One process: `rafi` calls the engine as a library. No CLI-on-CLI, no hidden flags. Files stay under about 500 lines | principle 9 |
| NEW-ENG-7 | Fingerprint checks only where they protect your code (for example, never overwriting your uncommitted changes), not on rafi's internal hand-offs | principle 10 |
| NEW-ENG-8 | Database changes use ordinary migrations; old code paths are deleted, not kept | principle 8 |
| NEW-ENG-9 | A scripted fake agent plays out whole builds (multi-ticket, QA failures, fixes, malformed replies, a forced crash at every step then resume). The full suite runs in under a minute; real-process tests are a small separate set | principle 11; `RW §Success criteria` |
| NEW-ENG-10 | The new engine runs behind `RAFI_ENGINE=next`; the same `rafi` commands call either engine and the old one stays the default until the switch. At the switch the old engine and `RAFI_ENGINE` are deleted in the same release; no backup engine is kept (ARCH-1). Runs already in progress finish on 0.10.x. The new engine reads only 1.0 formats; a project moves over once with `rafi migrate` (CMD-37). The old engine refuses a 1.0-format project with "This project uses 1.0 formats; set RAFI_ENGINE=next." (D6, 9.0) | `RW §Process` steps 5, 7, 9 |
| NEW-SET-1 | Project setup script (harness H12): one script, written and kept current by the builder, that installs dependencies, starts services and runs the tests. Rafi runs it itself, once per build before the first agent turn and again after a builder turn changes it, and records it like a test (NEW-CHK-5); agents don't run it. Services it starts are stopped at the end of the build, and after a crash by the process that takes over (step 8 review) | principle 15 |
| NEW-CAP-1 | Fallback when a model lacks a feature (harness F11): each adapter reports structured replies, exit codes, session resume and images. When one is missing, rafi uses a known fallback; for example Claude's tool events have no numeric exit code, so rafi relies on its own recorded command result | principle 16 |
| NEW-PORT-1 | Built-in portability: ticket status, open questions and saved answers live in a small committed text file (FILE-40). "Always allow" permissions stay on each machine (Q-PORT-2). The database isn't committed, and it's the truth on each machine; the file is rewritten from it (Q-PORT-4). On another computer: clone, `rafi resume`, and the build continues | decided `RW:73` |
| NEW-LOG-1 | `rafi create` asks where build logs go (this computer by default, or the project). `rafi logs export` writes one file (all runs, or `--run <id>`); `rafi logs import` loads it on another computer for debugging | decided `RW:74` |

### 8.2 From `MALFORMED_REPLY_AND_BLOCKED_BUILD_IMPROVEMENTS.md`

Found on moneyTree T002, 2026-10-29. None of it is patched on 0.10.x (decided `RW:97`).

| ID | Item | Requirement | Source |
|---|---|---|---|
| NEW-MAL-1 | 1 | Permission check for the whole build before step 1. See NEW-PERM-1 | `MALF 1`; principle 5 |
| NEW-MAL-2 | 4–5 | One shared malformed-reply handler for every structured operation (today the builder path has the 0.10.2 fix but QA remediation in `qaFailureDelivery.ts` doesn't). One automatic repair try: tell the model the reply was invalid at byte X and ask it to resend valid JSON, with no tools and no code changes. Accept the resend only if it matches the readable parts of the original; otherwise discard it and redo the turn as a normal retry with the error sent back, with circling detection (NEW-ENG-5), not a stop (D2, 9.0; this row first said "stop with a clear message") | `MALF 4, 5`; principles 4, 6 |
| NEW-MAL-3 | 6 | A malformed reply is reported as malformed, never as `delivery-uncertain`. Same fix for the Builder-fix mislabel in `QAMC §2` | `MALF 6`; `QAMC §2` "Other loose ends" |
| NEW-MAL-4 | 7 | When the builder is blocked, show its one-line reason (for example "Blocked: needs internet to install PostgreSQL/Drizzle"), never raw JSON. See OUT-6 | `MALF 7`; principle 7 |
| NEW-MAL-5 | 2 | No quiet substitutes: when the builder can't meet the required stack, it reports "blocked" instead of swapping in something else (it used a JSON file instead of PostgreSQL) | `MALF 2` |
| NEW-MAL-6 | 3 | Tests never fail because of QA's sandbox. Five StarNet tests failed with EPERM in QA's sandbox. **Changed 2026-11-02 (ARCH-5):** rafi runs every test itself, with the builder's permissions, including local servers (loopback) and temp-file writes (NEW-CHK-1, NEW-CHK-2); QA stays read-only and reads rafi's record. Local servers and internet are part of the upfront permission check | `MALF 3`; principle 5 |
| NEW-MAL-7 | 8–11 | Smaller replies: each fact once (rafi builds coverage and continuity notes from the findings; drop the duplicate summary and reason fields); no echoed IDs (`handoff_id`, `finding_key`); the builder cites rafi's recorded commands ("test run #3") instead of retyping output; flatter shapes like the ticket-population wire format in `spec/src/operationContracts.ts` | `MALF 8–11`; principle 6 |
| NEW-MAL-8 | 12 | Remove the triple-check lines: `foreman.ts` `buildQaInstruction` ("Triple-check your work", "Triple-check.") and the QA hand-off text in `qaReview.ts` ("Be very thorough… Triple check your work…"). Keep "Do not rubber-stamp your own work. Be skeptical." | `MALF 12`; principle 12 |
| NEW-MAL-9 | Direction | Optionally, the builder reports in plain text and one short, strict extraction call turns it into JSON. This needs a direct model call (an API key), which rafi doesn't make today (Q-MAL-2) | `MALF` "Direction"; principle 6 |
| — | Out of scope | A response-auditor agent, and correct-JSON example libraries | `MALF` "Out of scope" |

### 8.3 From `QA_MANUAL_CHECKS_AND_RECOVERY_FINDINGS.md`

Found on moneyTree T001, 2026-10-28. Its three bugs shipped as fixes in 0.10.2; the rest is folded in.

| ID | Requirement | Source |
|---|---|---|
| NEW-QAM-1 | Checks only a person can do (D4, 9.0, decided 2026-11-01; replaces the earlier default, the "lighter alternative", and choice A). (a) Permissions are still asked up front. (b) QA first verifies everything it can itself, with Playwright or a headless browser (mobile-mcp for mobile), including partial checks (for example, that clicking the button does something). (c) Only what truly needs a person is asked, when the build reaches it (pinned terminal prompt and notification), not in the upfront list. (d) That ticket and the tickets that depend on it wait for the answer; everything else keeps building; when you confirm, the ticket is done. (e) "I verified it myself" stays on the "what next?" question, with a required note, waiving only those findings; the answer goes stale when the covered code changes (Q-QAM-3). (f) The Planner still doesn't write acceptance criteria QA can't verify (it writes "provide a live test the operator can run, plus tests that cover it with a fake"), and marks person-only checks on the ticket. Optional per-project or per-ticket settings: **B** (no manual checks; QA keeps everything) and **C** (don't wait; track the checks as open questions; the end-of-build summary lists unverified checks and the tickets built on them). *Earlier text, replaced by D4:* default was the lighter alternative (an operator checklist note that QA and the build ignore, shown when the ticket finishes, plus "I verified it myself"), with A, B and C as settings | `RW:109-111`; `QAMC §1` |
| NEW-QAM-2 | Decisions meant for the user reach the user, including in background builds. No agent answers them on the user's behalf. Uses the pending-decision registry (NEW-GUI-5) | `RW:114`; `QAMC §2` |
| NEW-QAM-3 | Resume is one rule: find the last finished outcome, then act on it. If QA rejected the work and the code hasn't changed, reuse that rejection: ask "what next?" once or use the saved answer, and on "retry" send that report to the builder. If QA broke (stopped, cut off, unreadable answer), restart the review with the same original evidence. If the code changed, review again | `RW:116`; `QAMC §2` bug 2, `§3` |
| NEW-QAM-4 | Saved-decision keys stay valid exactly as long as what they answered stays the same. Today's bugs: a key that embedded a hash of the whole review history never matched again; a key without the raw scope revision was always treated as stale. Key the "what next?" question on the specific rejection | `RW:117`; `QAMC §2` bugs 1–2 |
| NEW-QAM-5 | A "paused at X, then resumed" test table covers every state | `RW:118`; `QAMC §3` |
| NEW-QAM-6 | Fast test suite: fake clock, no real timers | `RW:119`; `QAMC §3` |
| NEW-QAM-7 | Terms kept in user-facing text: "QA rejected the work" (review finished, said no) vs "QA broke" (no verdict) | `QAMC` "Terms used throughout" |

The source doc's §3 questions ("which states really need to be separate?", "should the QA recovery steps and the QA states merge?") are answered by principles 2 and 3: about six ticket states and no separate recovery steps (`RW:115`).

### 8.4 From `PLAN_UPDATE_APPROVAL_IMPROVEMENT.md`

All open questions in the source doc were decided 2026-11-01 (`RW:127-132`).

| ID | Requirement | Source |
|---|---|---|
| NEW-PUA-1 | Locked requirements: marked on a single ticket requirement, on a project-wide list ("always use PostgreSQL"), or both. No automatic plan update can change, drop or weaken one; rafi stops and asks before touching it. The Planner keeps the marks when it rewrites tickets, and rafi checks locked items are unchanged | `RW:122,128`; `PUA §1` |
| NEW-PUA-2 | By default rafi changes the plan, then tells you what changed and why: in the terminal at the moment it happens, in the build summary, and in a durable plan-change log (FILE-62). Asking first is an opt-in setting | `RW:123`; `PUA §2` |
| NEW-PUA-3 | A plan update is anything that changes what gets built or checked: requirements, added or removed tickets, scope. Reordering counts and you're told. Pure rewording doesn't count | `RW:129` |
| NEW-PUA-4 | When you're away: a notification, a line in the end-of-build summary, and the plan-change log | `RW:130` |
| NEW-PUA-5 | Every previous plan is kept as a backup (they're small text files). Switching back keeps the code, re-runs QA against the restored plan, and turns anything that fails into a fix ticket. Code is never deleted automatically | `RW:124,131-132`; `PUA §3` |
| NEW-PUA-6 | The setting (change-then-tell or ask) is saved per project or per build and isn't asked again on resume. It's separate from `--yes`/`--auto-approve`, so approving plan updates doesn't approve network access | `RW:125`; `PUA §4` |
| NEW-PUA-7 | QA always reviews against the plan in force. Saved approvals and QA results go stale exactly when the requirements they covered change | `RW:126`; `PUA` "How this fits with QA" |
| NEW-PUA-8 | The source doc flags this area as risky (plan approval binding, resume, saved decisions) and asks for a full "resume from every state" test table before building. Covered by NEW-QAM-5 | `PUA` "Risk" |

### 8.5 From `old/STRUCTURED_PROVIDER_OUTPUT_MIGRATION_PLAN.md`

Shipped in 0.10.0–0.10.1 except this part.

| ID | Requirement | Source |
|---|---|---|
| NEW-SO-1 | One shared, bounded format-repair policy for every operation (same as NEW-MAL-2). The repair includes the parser's exact error and asks the model to resend the same payload without changing content, inspecting files, running tools or doing work. The source plan excludes repair for: schema or content errors needing new reasoning, binding or identity mismatches, failed provider turns, unverifiable evidence claims, security or scope violations (Q-MAL-1) | `RW:135`; `old/STRUCTURED_PROVIDER_OUTPUT_MIGRATION_PLAN.md` §5 |
| NEW-SO-2 | When parsing or repair fails, keep the raw reply and the validation errors | `RW:136`; same doc "Evidence and persistence requirements" |
| NEW-SO-3 | A repaired reply can't change the content without that being detected | `RW:137`; same doc "Regression safeguards" |
| NEW-SO-4 | Track the malformed-reply rate by provider and operation | `RW:138`; same doc "Performance improvements" |
| NEW-SO-5 | Malformed output never changes tickets, plans, QA results, source files or build state; duplicate or conflicting structured results are rejected; status is parsed separately from the payload, and a payload is never valid just because a status line says done | same doc §6 and "Regression safeguards" |

### 8.6 QA reviews against one requirements file

From `old/QA_REQUIREMENT_REVIEW_AND_COST_CONTROL_REQUIREMENTS.md` and `old/SEVEN_SIMPLIFICATION_PROPOSALS_*.md`. QA preparation becomes this file (decided `RW:205`).

| ID | Requirement | Source |
|---|---|---|
| NEW-REQ-1 | Before building, a Markdown requirements file is written for each ticket: requirement IDs, acceptance criteria, what's in and out of scope, the commands to run with expected results, and known risks. The source doc also lists regression and documentation requirements and the author and creation time | `RW:145`; old doc §1.1 |
| NEW-REQ-2 | Rafi stores only its path and fingerprint, and gives QA the path. It never re-pastes the content into prompts, changes the file, or asks the builder to preserve it. The reference survives turns, hand-offs, restarts and resume | `RW:146`; old doc §1.2 |
| NEW-REQ-3 | QA answers per requirement: satisfied, not satisfied, not applicable (only if the file allows it), or unable to verify, naming what's missing | `RW:147`; old doc §1.3 |
| NEW-REQ-4 | QA doesn't add scope the file doesn't ask for (for example new deletion, branch-history, documentation or absence-test requirements) | `RW:148`; old doc §1.3 |
| NEW-REQ-5 | If the file is missing, unreadable or changed, rafi warns, gives QA the path and the warning, QA marks the affected requirements "unable to verify", and the build carries on. It never stops the build by itself. Rafi doesn't stop because an agent didn't repeat the filename or misspelled the path | `RW:149`; old doc §1.4 |
| NEW-REQ-6 | QA's start records a delivery receipt: path, fingerprint supplied and observed, status (delivered, missing, unreadable, changed), time and QA turn, and whether QA read it | old doc §1.5 (detail; proposed) |
| NEW-REQ-7 | Later QA turns get only what changed (files, requirements, new evidence, prior findings) | `old/SEVEN_SIMPLIFICATION_PROPOSALS_REQUIREMENTS.md` Proposal 2 (proposed) |

### 8.7 Facts recorded once, and short references

| ID | Requirement | Source |
|---|---|---|
| NEW-FACT-1 | Command results, exit codes, changed files, IDs and times are recorded by rafi. If an agent's report disagrees, rafi's record wins and the mismatch is logged; it doesn't trigger a retry | `RW:152`; old QA doc §3 |
| NEW-FACT-2 | No agent turn is spent on facts rafi already knows; agents aren't asked to wrap commands just to report what rafi saw | `RW:153`; old QA doc §3, §5 |
| NEW-FACT-3 | Rafi is a thin coordinator, not a third agent: each job is done once and recorded once | `RW:154`; old QA doc §8 |
| NEW-REF-1 | Agents refer to checks by short numbers ("check 3"), never long hash IDs. A Codex reply once merged two hash IDs (`check-20280fb316ed12820e270cfb-0` vs `check-20280fb316654cbf8350a2e1-0`) into an invalid one. Today agents still copy 24-character IDs | `RW:157`; `old/LIVE_E2E_QA_COVERAGE_FAILURE_RESOLUTION_PLAN.md` §1; `old/README.md` |
| NEW-REF-2 | Rafi never asks for a fact the agent can't observe. Claude's tool events have no numeric exit code, so a requirement must not demand one from Claude; rafi never makes one up, and records "completed" separately from an exit code | `RW:158`; LIVE_E2E plan §2 and invariants 4–5 |
| NEW-REF-3 | Rafi never guesses which ID an agent meant: no nearest match, prefix match or position guess. Missing, duplicate or out-of-range references are errors | `RW:159`; LIVE_E2E plan invariants 1–3 |

### 8.8 Every agent turn is measured

| ID | Requirement | Source |
|---|---|---|
| NEW-MEAS-1 | Each turn records: role, provider, model, start and end, time split between the agent, tools and rafi itself, tokens, and the reason for every retry or hand-off. The source doc adds: first-output time, context size and compaction status, commands with duration and exit code, and the result (pass, hand-off, retry, failure, cancelled, unknown) | `RW:162`; old QA doc §2 |
| NEW-MEAS-2 | Per run and per ticket: duration, number of turns, retries, and agent time versus rafi time | `RW:163`; old QA doc §2.1 |
| NEW-MEAS-3 | A build ends with a short summary of cost and time (OUT-18) | `RW:164`; old QA doc §6 |
| NEW-MEAS-4 | This lives in the event log, and it's what the GUI dashboard reads. Instruction characters per turn are recorded too | `RW:165`; `AIR` "What to improve" 5 |

### 8.9 Run history and replay

From `old/FULL_RUN_FORENSIC_REPLAY_IMPLEMENTATION_PLAN.md` (never built). In 1.0 (decided `RW:169`).

| ID | Requirement | Source |
|---|---|---|
| NEW-STATS-1 | `rafi stats show` replaces `rafi audit`. The event log makes "show me the timeline of this run" a simple read, replacing the manual log-reading routine in `old/CURRENT_SESSION_HANDOFF.md` | `RW:69,169` |
| NEW-STATS-2 | Capture levels `none`, `normal`, `detailed`. `none` keeps only what the build needs to be correct; `normal` keeps timing, counts, fingerprints and bounded metadata; `detailed` keeps exact prompts, replies and tool input/output and marks the run as sensitive. Replaces `--audit-logging off\|summary\|trace` | `RW:168`; replay plan §1, §5 |
| NEW-STATS-3 | Recorded data is never deleted automatically. Running low on space may skip future optional data (recorded as skipped) but never deletes evidence or blocks a build. `rafi stats delete` is the only deletion, explicit and confirmed | `RW:168`; replay plan §1, §10. Conflict with recording retention: Q-STATS-2 |
| NEW-STATS-4 | Proposed subcommands: `show`, `timeline`, `compare` (two runs, without merging), `export` (stable JSON), `replay` (isolated, in a disposable worktree, side effects confirmed, marked as new evidence), `delete` | `RW:168`; replay plan §10, §11. Which ship in 1.0 is Q-STATS-1 |

### 8.10 Copy, fingerprint and retry only when needed

| ID | Requirement | Source |
|---|---|---|
| NEW-COPY-1 | Copy the project for QA, or fingerprint the whole tree, only when the ticket needs it. Record why and how long it took (files, bytes, copy, hash, verify and cleanup times) | `RW:172-173`; old QA doc §4 |
| NEW-COPY-2 | The source doc adds: the rule for when a copy is needed is fixed and inspectable; high-risk or explicitly requested reviews keep full isolation; source drift or an ambiguous workspace is never quietly downgraded to a targeted review; cleanup never removes your work, the builder's work or the requirements file | `old/SEVEN_SIMPLIFICATION_PROPOSALS_REQUIREMENTS.md` Proposal 5 (Q-COPY-1) |
| NEW-RTY-1 | Never resend the same request without a changed input or a set attempt limit | `RW:175`; old QA doc §6 |

### 8.11 Cautions from the earlier audit

From `old/SEVEN_SIMPLIFICATION_PROPOSALS_CODEBASE_AUDIT.md`, which argued against a rewrite. Its warnings apply to the new design (`RW:177-182`).

| ID | Requirement | Source |
|---|---|---|
| NEW-CAU-1 | No second source of truth. Anything shown to agents is a view of the event log | `RW:178`; audit "Failure mode A" |
| NEW-CAU-2 | Measure before optimizing. Provider wait time, not rafi's own work, made up most of the gap between Claude and Codex | `RW:179`; audit "Failure mode B" |
| NEW-CAU-3 | Diagnostics must not become gates. A bookkeeping mismatch never blocks a valid review | `RW:180`; audit "Failure mode C" |
| NEW-CAU-4 | Keep real safety checks, such as protecting files a ticket isn't allowed to touch. Delete only checks that guard rafi's internal hand-offs | `RW:181`; principle 10 |
| NEW-CAU-5 | Don't trust a "low risk" label blindly. Any shortcut for low-risk tickets needs a minimum that rafi enforces | `RW:182`; audit "Failure mode E" |

### 8.12 Past bugs to turn into scenario tests

For guide step 4. Most are fixed in today's engine; the new one must not bring them back.

| ID | Scenario | Source |
|---|---|---|
| SCN-1 | A project with no git commit yet, or with huge ignored folders: capture respects `.gitignore` and stays fast; long work doesn't block heartbeats | `RW:185`; `old/MONEYTREE_RAFI_BUILD_FINDINGS.md` §6 |
| SCN-2 | Untracked folders don't crash start-over or reset | `RW:186`; moneyTree findings §2 |
| SCN-3 | Resuming a batch keeps the whole approved batch (a bug once shrank 34 tickets to 1) | `RW:187` |
| SCN-4 | Finishing some of a batch never marks the whole run done (incident A17/U7: branch-per-ticket partial completion) | `RW:188`; `old/README.md` (rafi-incident row) |
| SCN-5 | A question during a build can be answered in the same terminal, without exiting and resuming | `RW:189`; `old/crash-fix-docs/rafi-stop-investigation.md` |
| SCN-6 | Printed recovery commands work when copied, even with spaces, quotes or symbols in the answer | `RW:190` |
| SCN-7 | Network access stays off unless granted, and the builder explains the restriction instead of failing quietly | `RW:191`; moneyTree findings §8 |
| SCN-8 | A blocked ticket keeps its reason. Cancel, pause and crash are recorded as different outcomes | `RW:192` |
| SCN-9 | `--steps N` doesn't stop early (O-E2E-005: a branch run stopped after the first delivery unit and `tickets queue` said "No remaining tickets"; `status` also called a finished run unfinished). Not confirmed fixed; optional hand check on 0.10.2 (`REWRITE_SCENARIOS.md` section 9; no baseline, D8) | `RW:220`; `old/docs/rafi-online-e2e-findings-2026-10-13.md:219-240` |
| SCN-10 | Ticket states written by the planner are validated before they're applied (O-E2E-001) | `RW:221` |
| SCN-11 | A non-interactive plan never opens interactive prompts (O-E2E-006: `plan --yes` then showed "Set up tickets now?") | `RW:222`; e2e findings `:265-279` |
| SCN-12 | Start-over and QA hand-offs leave no stale session pointers for a later resume to reuse | `RW:223`; `old/docs/build-stall-investigation.md` §4 |
| SCN-13 | A failed planning step can always be recovered, including a failure while applying tickets (O-E2E-002) | `RW:224` |
| SCN-14 | Claude's harmless failed reads and commands during exploration don't show as repeated "tool failed" lines (O-E2E-004). Not confirmed fixed; optional hand check on 0.10.2 (`REWRITE_SCENARIOS.md` section 9; no baseline, D8) | `RW:225` |

Scenario tests listed under the decided sections are in 8.17–8.21 with their sections. The whole-build scenarios from `RW §Process` step 3 (start, QA fail-fix-pass, blocked ticket, permission prompt, crash and resume, multi-ticket batch, plan updates) are the base set.

### 8.13 What the GUI needs from the engine

From `RW §What the GUI needs from the engine` (`GUI_PRODUCT_REQUIREMENTS.md` §11). The GUI comes later; the engine must make these possible without another rewrite.

| ID | GUI need | What the rewrite does | Source |
|---|---|---|---|
| NEW-GUI-1 | GUI-PLT-2: unified event stream, ordered and replayable by cursor (typed, versioned, ordered per instance; covers activity, tool calls, status, questions, approvals, cost, timing) | The event log is the stream. Events are typed and readable from a cursor | `RW:259`; GUI §11 |
| NEW-GUI-2 | GUI-PLT-3: command/action API with idempotency keys, async operations with progress, structured errors, and the same validation as the CLI | One engine library that both the CLI and a future daemon call | `RW:260`; GUI §11 |
| NEW-GUI-3 | GUI-PLT-4: pause and steer at safe points in the builder, QA and Manager loops | Step boundaries in the state machine are the safe points | `RW:261` |
| NEW-GUI-4 | GUI-PLT-5: more than one build per checkout | Keep state per run, not per checkout. Design for it; don't build it yet. No scale targets or limits; tested with 2 builds at once (Q-GUI-1, section 9.0) | `RW:262` |
| NEW-GUI-5 | GUI-PLT-6: pending-decision registry | Every question to the user is a recorded event with type, options, context, urgency and time. It can be answered from any surface (terminal, desktop notification, GUI sidebar or modal, the instance view, `rafi answer`, Manager); the first answer wins and closes the rest | `RW:263`; GUI-ATT-8 |
| NEW-GUI-6 | GUI-PLT-10: permission/policy engine shared by UI, API and Maestro | The upfront permission check is its first version | `RW:264` |
| NEW-GUI-7 | GUI-PLT-11: schema-first contracts in `rafi-spec`, with compatibility testing between daemon, CLI and UI | Event and reply formats are defined in `rafi-spec` | `RW:265` |
| — | Not part of the rewrite, but not blocked by it: GUI-PLT-1 (daemon), GUI-PLT-7 (cost normalization across Claude and Codex, subscription vs API), GUI-PLT-8 (remote runners), GUI-PLT-9 (declarative instance spec, `rafi up spec.yaml`) | | `RW:267` |

### 8.14 Adapter issues

The Codex and Claude adapters are kept (`RW:55`), so these stay adapter issues.

| ID | Issue | Status | Source |
|---|---|---|---|
| NEW-ADP-1 | U1: Claude's context-compaction threshold differs from what rafi sets. Claude reported 967,000/1,000,000 after acknowledging a requested 683,000-token window; a non-persistent launch flag reported the requested window. Not resolved | **open** (Q-ADP-1) | `RW:194`; `old/rafi-incident-2026-10-14/ISSUES-AND-RESOLUTIONS.md:35,41,245` |
| NEW-ADP-2 | Codex context usage was once calculated from the session's total tokens, which triggered needless compactions | **fixed**: occupancy now uses the latest sample (`last.totalTokens`) and the session total is kept separately | `RW:227`; `ai-foreman/src/adapters/codex.ts:809-816`; `old/docs/build-stall-investigation.md` §1 |
| NEW-ADP-3 | `session_strategy: compact` compacted at ordinary boundaries even below the threshold | **changes** with the fresh-per-ticket default; still applies when one agent is reused (Q-ADP-2) | `old/docs/build-stall-investigation.md` §1 (last paragraph); `RW:327-328` |
| NEW-ADP-4 | Claude runs use the absolute system `claude` executable that passed readiness, never the SDK-bundled CLI, and inherit user, project and local settings, so enterprise logins (for example `/login-okta`) and proxies keep working | **keep** (proposed) | `cli.md:36`; GUI-REM-3 |
| NEW-ADP-5 | The Codex schema isn't enforced: a reply missing a required field still came back | **keep handling it ourselves** (NEW-MAL-2) | `MALF` "The format isn't actually enforced" |

### 8.15 Product decisions and current features

| ID | Item | Decision | Source |
|---|---|---|---|
| NEW-KEEP-1 | Start automatically when the approved scope is unchanged; ask only about material changes. A new implementation outline within that scope doesn't need another approval | **keep** (decided) | `RW:201`; `old/docs/build-stall-repair-plan.md:11` |
| NEW-KEEP-2 | Keep going when one ticket is blocked: show the blocker right away, hold back its dependents, keep building the rest. A project-wide problem (permission, integrity) still stops what it affects. Rafi asks right away and, in a terminal, never exits on its own (without a terminal, see NEW-BLK-5) | **keep, refined** (decided 2026-10-31) | `RW:202`; build-stall repair plan `:12` |
| NEW-KEEP-3 | QA preparation | **change → the per-ticket requirements file** (decided) | `RW:205` |
| NEW-KEEP-4 | Graphify for agents: turned on during `rafi create` (visible opt-out), used selectively; a scan or update only on explicit graph requests, substantial cross-file investigations, or meaningful relationship changes, never because bytes changed or a routine command ran | **keep, as a tool given through tags** (decided) | `RW:206,214`; `old/docs/graphify-agent-integration-requirements.md` reqs 4 and intro |
| NEW-KEEP-5 | Manager QA access: show any ticket's QA reports, explain why a ticket keeps cycling (recurring vs new findings, what changed between attempts), send guidance to the builder or QA, and report whether guidance was delivered and whether later QA resolved it | **keep, reading the event log** (decided) | `RW:207,215`; `old/docs/manager-qa-and-resume-resolution-brief.md` "Agreed outcomes", "Requirements" |
| NEW-KEEP-6 | Terminal colors: shared policy, no color codes in non-terminal output (OUT-9) | **keep** (decided) | `RW:208,216` |
| NEW-KEEP-7 | `rafi plan:doctor` | **change → merged into `rafi resume`** (decided) | `RW:209` |
| NEW-KEEP-8 | Building on uncommitted work (`--dirty-work preserve\|include`): `preserve` starts isolated branches from committed code; `include` makes a private git baseline of tracked and non-ignored untracked files with a separate index, without committing or switching your branch. Both keep worktrees and turn off automatic merge and review creation into or from the dirty checkout | **keep** (decided) | `RW:210`; `docs/reliability-workflows.md` "Continue with uncommitted work" |

### 8.16 Harness plan items

From `harness/rafi-harness-requirements.md` (the 2026-10-10 plan, never carried out). Decided 2026-11-01 (`RW:231-251`).

| ID | Item | Decision | Source |
|---|---|---|---|
| NEW-HAR-1 | Part 1 (E01–E18): inventory and traceability, deterministic provider and event simulation, durable-state crash testing, historical-bug suites, packaged CLI tests, a representative work corpus, a hostile-environment corpus, independent completion scoring, QA calibration, browser evals, structured telemetry, timing and cost accounting, prompt overhead measurement, a fair experiment runner, baseline and ablation matrix, live-provider quota control, CI reporting, reuse of existing test infrastructure | **input** to the scenario harness design (guide steps 4–5; the harness is built in milestone 1, guide step 10). E15's 0.10.2 baseline is dropped (D8, 9.0) | `RW:230`; harness requirements headings `:94-208` |
| NEW-HAR-2 | F09 circling detection; H14 rules for outside tools; H12 project setup script; H01 and H02 checking native Codex and Claude features during the architecture step; F11 fallback when a model lacks a feature | **in the rewrite** | `RW:232-237`; NEW-ENG-5, NEW-TOOL-6, NEW-SET-1, NEW-CAP-1 |
| NEW-HAR-3 | F01 measuring experiments, F04 fresh sessions, F10 fewer interruptions, F12 removing what doesn't help, H11 Playwright | **already covered** | `RW:238-243` |
| NEW-HAR-4 | F02, F03, F05, F06, F07, F08, H03–H10, H13 | **after 1.0** | `RW:244-251` |

### 8.17 Agent instructions

From principle 13 and `AGENT_INSTRUCTIONS_REVIEW.md`. All built in the rewrite (decided `AIR` "When").

| ID | Requirement | Source |
|---|---|---|
| NEW-INS-1 | Every agent validates before it reports and says "unable to verify" when it couldn't. Builder: report only what you ran or saw, citing rafi's recorded command. QA: check each requirement by reading code or running the test. Planner and Ticket Maker: read the code before describing what exists. Manager: cite the record behind every answer | principle 13; `AIR` "What to improve" 1 |
| NEW-INS-2 | Rules are sent once, in the agent's standing instructions; per-turn messages carry only what's new. Today the same rule packs reached the T002 builder 7 times (about 394,000 characters of input) | principle 13; `AIR` item 1 |
| NEW-INS-3 | Rule packs, skills and tools are picked per ticket by tags; skills are listed by name and description and loaded when relevant; the Graphify paragraph lives only in its skill | principle 13; `AIR` items 2, 3, 5 |
| NEW-INS-4 | Agents get the assigned ticket, its acceptance criteria and a one-line status for each ticket it depends on, not the whole queue | principle 13; `AIR` item 4 |
| NEW-INS-5 | No contradictions: never "ask the user" in an unattended build (say "report needs-input"); no skill that waits for user picks in an unattended role (`improve-codebase-architecture`); tracker rules don't tell agents to pick from `LLM_NEXT_QUEUE` or run `foreman tickets complete`, and name no command that doesn't exist | principle 13; `AIR` "Contradictions to remove" 1–3 |
| NEW-INS-6 | Plain language with reasons, no pressure wording (the compiled builder file has 24 uses of must, never, always, do not, don't) | principle 13; `AIR` "What to improve" 2 |
| NEW-INS-7 | Rafi-owned files (`tracker-rules.md`, compiled agent files) carry a version and are regenerated on upgrade | principle 13; `AIR` "What to improve" 4 |
| NEW-INS-8 | A cut stays only if the scenario harness pass rate holds. Run Claude Code's `/doctor prompt-audit` on a compiled project during the rewrite | principle 13; `AIR` "What to improve" 5–6 |
| NEW-INS-9 | The builder uses no quiet substitutes (NEW-MAL-5); QA keeps "Do not rubber-stamp your own work. Be skeptical." without triple-check lines (NEW-MAL-8); the Planner marks person-only checks on the ticket and doesn't write criteria QA can't verify (NEW-QAM-1, D4) | `TODO.md` item 4 "Instruction-text fixes" |

### 8.18 Agent context: tags

Decided 2026-11-01 (`RW §Agent context: tags`).

| ID | Requirement | Source |
|---|---|---|
| NEW-TAG-1 | Tickets have tags such as `ui`, `database` or `mobile`. The Planner tags each ticket when it writes it, QA preparation double-checks, and you can edit them | `RW:322-323` |
| NEW-TAG-2 | The tag list is a fixed list owned by rafi plus project tags. An unknown tag is rejected at planning time | `RW:324` |
| NEW-TAG-3 | Rule packs, skills and tools carry tags. Each agent gets a small always-on core plus whatever matches its ticket's tags. QA gets the same tags as the builder | `RW:325-326` |
| NEW-TAG-4 | Each tag can list file patterns. Rafi adds a tag, without an AI, when a ticket's likely files match, and again for QA when the builder's changed files match. Tags are only added, never removed, and each added tag is shown with its reason | `RW:329` |
| NEW-TAG-5 | A fresh agent per ticket, for builder and QA, is the default (`session_strategy` default changes from `compact` to `fresh`). The setup script keeps fresh starts cheap | `RW:327` |
| NEW-TAG-6 | Reusing one agent across tickets is an override. That agent gets the tags of every ticket in scope (`--steps` or `--to-ticket`), re-checked before each ticket because scope can change; tags are added, never removed. The union is recorded on that agent's session, not on each ticket, and isn't a plan update (step 8 review) | `RW:328` |
| NEW-TAG-7 | Scenario tests: a non-AI ticket gets no AI rules; an unknown tag is rejected; a reused agent picks up a new ticket's tags; QA and the builder get the same tags | `RW:330-334` |

### 8.19 Ask everything up front

Decided 2026-11-01 (`RW §Ask everything up front`).

| ID | Requirement | Source |
|---|---|---|
| NEW-ASK-1 | Rafi scans right after tickets are made. Before each build (`rafi start`, `rafi resume`) it asks only questions still unanswered plus new ones from tickets added or changed since | `RW:340` |
| NEW-ASK-2 | It scans every ticket in scope (`--steps`, `--to-ticket`, or all) for: permissions (internet, local servers, installs, live services); credentials or secrets; decisions the Planner flagged as open; the plan-update setting if not saved; the CI confirmation when rafi handles git (NEW-CHK-8); test time limits that recorded durations already exceed (NEW-CHK-6). Checks only a person can do are **not** in the scan: they're asked when the build reaches them (D4, 9.0; NEW-QAM-1), and asking one isn't a scan gap (NEW-ASK-5) | `RW:341-346` |
| NEW-ASK-3 | One list, all at once; each item says which tickets need it. Per item: answer now (including "always" where it fits) or answer later | `RW:347-348` |
| NEW-ASK-4 | Answer later: the question is saved, the tickets that need it wait, the build starts with everything else, rafi reminds you through notifications, and the question stays in the open-questions list | `RW:349` |
| NEW-ASK-5 | Goal: zero questions mid-build. A question that comes up mid-build is recorded as a gap so the scan can learn. A person-only check asked when the build reaches it (D4, 9.0) is expected, not a gap; so is a test time-limit question the first time a limit is hit (NEW-CHK-6) | `RW:350` |
| NEW-ASK-6 | You can always tell when rafi is waiting: terminal title and status line show "Waiting on you since 14:05 (T2)"; so do `rafi status` and the end-of-build summary, which says how long rafi waited | `RW:351` |
| NEW-ASK-7 | Scenario tests: the scan finds every question for a 20-step build before step 1; "answer later" builds everything else; a mid-build question is logged as a gap; "waiting since" shows in the status | `RW:352-356` |

### 8.20 Blocked tickets: keep going and ask

Decided 2026-10-31 (`RW §Blocked tickets: keep going and ask`).

| ID | Requirement | Source |
|---|---|---|
| NEW-BLK-1 | When a ticket is blocked mid-build, rafi records the question, starts the next eligible ticket, sends a desktop notification, and pins a prompt at the bottom of the terminal while other output scrolls above | `RW:364-366` |
| NEW-BLK-2 | The message: one line each for what's blocked, why (the builder's own reason, never raw JSON), which tickets wait on it, and what rafi is doing now | `RW:384` |
| NEW-BLK-3 | Options, shown only when they fit the reason: grant access (this build / always for this project) then retry; I fixed it myself, retry; skip for now (it and its dependents stay blocked, the question stays open, reminder at build end); give the builder instructions, then retry (note sent with the retry); change it with the Planner (uses plan-update approval), then retry; drop it (won't do; dependents flagged for you to decide); stop the build (question saved for `rafi resume`) | `RW:369-392` |
| NEW-BLK-4 | Answer any time by typing a number. A retry starts when the current ticket finishes; it doesn't interrupt it. Several blocked tickets each get their own pinned question, oldest first | `RW:393-394` |
| NEW-BLK-5 | Nothing left to build: rafi keeps waiting with the question showing, sends a reminder, and, in a terminal, never exits on its own. Ctrl+C stops it; the question stays saved for `rafi resume`. A background build (`--detach`) also keeps waiting, so a notification answer continues it (ARCH-8). Only a foreground build without a terminal (a script or CI) exits with code 2 once nothing is left to build, with the question saved (Q-OUT-1) | `RW:395` |
| NEW-BLK-6 | `--steps N` counts finished tickets; a blocked or skipped ticket doesn't use a step. `--to-ticket <id>` builds everything rafi can in queue order up to and including that ticket; if the target depends on a blocked ticket, the prompt says so. Example: with 2 of the first 5 blocked, `--steps 5` goes on through ticket 7, while `--to-ticket T5` stops at T5 with 3 finished | `RW:396-397` |
| NEW-BLK-7 | A build-wide problem (integrity, a project-wide permission) still stops affected work, with the same style of message and options | `RW:398` |
| NEW-BLK-8 | Scenario tests: block, keep building, answer mid-build, retry; skip, then the end reminder; drop with dependents; nothing left while waiting; `--steps` counting; `--to-ticket`; two blocked at once; answering from a notification | `RW:400-408` |

### 8.21 Notifications

Requested 2026-10-31; command-line choice decided 2026-11-01 (`RW §Notifications`).

| ID | Requirement | Source |
|---|---|---|
| NEW-NOT-1 | One question record, many places to answer it: the pinned terminal prompt, a desktop notification, `rafi answer`, Manager, later the GUI. First answer wins; the others close or show "answered in …" | `RW:414-420` |
| NEW-NOT-2 | The notifier lives in the engine, not the terminal or browser, so it works for background builds and the GUI | `RW:421` |
| NEW-NOT-3 | Platforms: macOS `alerter` (action buttons, a dropdown for several choices, or a reply box; prints the chosen action); Linux `notify-send --action` (libnotify 0.8.x); Windows via Electron (untested). `terminal-notifier` no longer supports buttons | `RW:422-425` |
| NEW-NOT-4 | On macOS, `alerter` is offered as an install for answer buttons. If missing or broken, rafi falls back to plain notifications. The GUI app later replaces it | `RW:426` |
| NEW-NOT-5 | When choices can't be shown, the notification says what's needed and opens the terminal or GUI view for that question. Long lists show the most likely choices plus "More…" | `RW:427-428` |
| NEW-NOT-6 | On by default, with per-event preferences and reminder timing. Quiet hours come with the GUI | `RW:429` |
| NEW-NOT-7 | A fake notifier records what was sent and can answer, so the harness can test answering from a notification | `RW:430` |

### 8.22 Permissions and auto-approve

| ID | Requirement | Source |
|---|---|---|
| NEW-PERM-1 | Inspect every ticket and step in the requested build for what it needs (internet, local servers, packages not yet installed, live services) and ask once, right away, even if only step 20 needs it. Covers the builder and QA | principle 5; `MALF 1` |
| NEW-PERM-2 | Choices: allow once (this build); always allow (saved for this project, on this machine only); don't allow (the steps that need it are marked blocked and the reason is shown up front) | principle 5 |
| NEW-PERM-3 | `--allow internet,local-servers,…` grants the same permissions from the command line, for builder and QA | `RW:82` |
| NEW-PERM-4 | Auto-approve is opt-in and off by default; without it rafi asks about approvals much as today. When it's on, a question is allowed only when no setting, saved answer or approval mode could have answered it. A coordinator (Maestro) can turn it on for you. What remains are things only you can do. Auto-approve can grant permissions, but internet access, installs and live services always get a warning in the upfront check (Q-APR-1, section 9.0). It fills in an unsaved plan-update setting with its default (change, then tell), and never answers a product decision the Planner flagged; those stay in the upfront list (D3, 9.0) | principle 14 |

### 8.23 Test tools

Decided 2026-11-01 (`RW §Test tools`).

| ID | Requirement | Source |
|---|---|---|
| NEW-TOOL-1 | Rafi ships Playwright built in and fully supports mobile-mcp. `rafi create` offers Playwright when the project has a frontend and mobile-mcp when it has a mobile app. Other known tools are optional plug-ins | `RW:438` |
| NEW-TOOL-2 | A tool is an MCP server or a command, saved under `tools:` in `rafi-config.yaml` (committed, so tools travel with the project): how to start it, a description, which roles get it, which tags it serves | `RW:439-443` |
| NEW-TOOL-3 | `rafi tools add <name>`, or from a prompt, writes the entry, checks prerequisites and explains anything missing | `RW:444` |
| NEW-TOOL-4 | Where connecting needs boilerplate, rafi writes it: a sample `payload.apns` and a simulator push script; an APNs sandbox or FCM test-push script that reads keys from the environment, never from committed files; a starter Playwright config with the per-build port; device-check steps (for example `adb devices`). Tool setup notes go in the project docs and the ticket points to them | `RW:459,490-494` |
| NEW-TOOL-5 | Recordings: one screenshot per checked requirement as QA's evidence; for a failed check also a video and a Playwright trace. Default is failures only (`retain-on-failure`), with a setting to record everything. Stored with the build logs. Kept for one of five choices (ticket finished, build finished, last N builds, N days, until deleted); default last 5 builds | `RW:468-474` |
| NEW-TOOL-6 | Every tool entry defines its permissions (which feed the upfront check), how rafi stops it, how its results become evidence, supported versions and license. Tool output is untrusted data, never instructions | `RW:446-453` (harness H14) |
| NEW-TOOL-7 | Agents learn about tools: a QA retry after "unable to verify" names the tool and the requirement ("You now have `playwright` (browser). Use it to verify R3: …"); later agents get tools by tag; when a tool is added, rafi re-tags the remaining tickets, and each ticket's instructions list "Tools for this ticket: …" | `RW:457-459` |
| NEW-TOOL-8 | Parallel builds: Playwright tests run headless with isolated contexts; the Playwright MCP server starts with `--isolated` per agent; each build gets its own app port; a physical phone is locked to one build at a time; a "show the browser" option opens a visible window for one build | `RW:463-468` |
| NEW-TOOL-9 | QA needs access to local servers; the upfront permission check covers it | `RW:475` |
| NEW-TOOL-10 | Known tools rafi can set up or explain: Playwright, mobile-mcp, Appium, Maestro (mobile.dev; name clashes with the GUI's Maestro, GUI open question 11), iOS Simulator push (`xcrun simctl push`), real push via APNs sandbox or FCM. The setup check confirms details on your machine | `RW:477-488` |
| NEW-TOOL-11 | Scenario tests: QA "unable to verify", then a tool is connected and QA retries with it; a later ticket gets the tool through its tags; two builds use Playwright at once without collisions; a device locked by one build | `RW:496-500` |

### 8.24 Tests and CI

Decided 2026-11-02 in the architecture review (ARCH-5; `REWRITE_ARCHITECTURE.md` 6.9–6.11). Agents never prove a test passed by saying so; rafi runs and records every test, the way CI does.

| ID | Requirement | Source |
|---|---|---|
| NEW-CHK-1 | Rafi runs every test command itself, through a `run_check` tool it gives each builder and QA session. It records the command, exit code, output, duration and the exact code it tested (git tree). A test an agent runs in its own shell is never proof; only rafi's record counts | ARCH-5 |
| NEW-CHK-2 | Tests run in the builder's worktree with the builder's permissions: project files writable; internet, local servers and installs only if granted. Caches that would go to the home folder are pointed at the ignored `.rafi/cache/`. QA stays read-only. No QA copy is made for tests | ARCH-5; NEW-MAL-6 |
| NEW-CHK-3 | The builder runs its checks through `run_check` and fixes failures before it reports done. Before QA, every requirement's check needs a passing run against the builder's final code; a result is stale only when a file it depends on changed since it ran (the runner's related-files query; without one, any change), and only stale ones rerun. If one fails, the ticket goes straight back to the builder and the QA turn is skipped (counts against `retries.fixes`) | ARCH-5 |
| NEW-CHK-4 | During a ticket only relevant tests run: each requirement's check command, plus the tests related to the ticket's changed files where the test tool supports it (`jest --findRelatedTests`, `vitest related`) | ARCH-5 |
| NEW-CHK-5 | QA can ask for a test that isn't listed through `run_check`; rafi runs and records it the same way. The same record is used by QA's re-check after `rafi plan restore`, browser tests (Playwright test files) and the setup script, so "setup worked" is a record, not the builder's word | ARCH-5 |
| NEW-CHK-6 | Time limits. A run printing nothing for 2 minutes is hung: stopped and counted as a failure. A run still printing at its limit (5 minutes for a ticket's tests, 20 for the full suite) is slow, not broken: stopped, not counted as a failure, and rafi asks once to raise the limit (it suggests double; or 1.5 times the longest recorded run when the upfront check already knows). The answer is saved to `rafi-config.yaml`; auto-approve says yes. Until it's answered only that ticket, or the CI step, waits; the rest keep building | ARCH-5 |
| NEW-CHK-7 | A test run that changes tracked files (for example a formatter run with `--write`) is a failure that names the files; the builder fixes it | ARCH-5 |
| NEW-CHK-8 | Rafi's CI step runs the full suite (`checks.ci_tests: full`, the default), the tests related to every file the build changed (`light`) or nothing (`none`). It exists only when rafi handles git: `git.managed_by: rafi` (ARCH-6) and completion `pr`, `pr-ready`, `auto-merge` or `direct-merge`. With `managed_by: me` or completion `none`, rafi runs no suite. When it runs is `checks.ci_when` (ARCH-7: each ticket, each PR or merge, once at the end of the build by default, or light before each PR plus full at the end). The upfront check confirms it once: "Rafi runs the full test suite before merge. Keep that, or manage full test suite runs yourself?" Auto-approve keeps the default | ARCH-5 |
| NEW-CHK-9 | When the CI step fails: tests that also fail on the build's starting commit were already broken and flaky tests (pass when rerun on the same commit) are reported once and don't block. For the rest, rafi adds a fix ticket at the front of the queue with each failing test as a requirement and a hint of which ticket probably caused it, builds it AFK like any ticket, then runs the CI step again. Done tickets are never reopened | ARCH-5 |
| NEW-CHK-10 | A failing suite never stops the build. If the fix ticket runs out of fixes: with `checks.ci_blocks_merge: false` (the default) rafi merges (or opens the PR) anyway and tells you which tests still fail (terminal, notification, end-of-build summary); with `true` it commits and pushes the branch without merging and tells you. The fix ticket stays open for a later build | ARCH-5 |
| NEW-CHK-11 | Rafi never adds CI workflows, required checks or branch protection to your repo | ARCH-5 |
| NEW-CHK-12 | The GUI shows "CI testing" (Full, Light, None) and "When" dropdowns only when rafi handles git, and, when it's Full or Light, a "Failing tests block merge" switch, off by default (GUI-RUN-7) | ARCH-5 |
| NEW-CHK-13 | Nothing runs twice. At a CI point, rafi skips a test whose last passing run is still fresh (nothing it depends on changed since), using per-test results when the runner reports them; otherwise the whole command reruns. CI run elsewhere (GitHub Actions) isn't rafi's to change | ARCH-7 |
| NEW-CHK-14 | `run_check` accepts only the requirements file's checks, the project's test runner (`checks.test_runner`) with file or test-name arguments, and the setup script; anything else is refused and recorded. Every request goes through the agent permission policy, so it can't run `rafi answer` or `rafi stop`. Runs use an operating-system sandbox matching the build's grants. After a QA request, rafi puts back any tracked file the run changed | step 8 review |
| NEW-CHK-15 | After any failure (checks, QA, CI, a person-only check), the builder gets all of it: each failing run's number and command, the failing tests' names and files, error messages, the top of the stack and an output excerpt, with the full output readable by run number (`check_output`). It's told to fix the code, keep the work it has done and not start over | ARCH-10 |
| NEW-CHK-16 | With QA off (`--no-qa`) there's no requirements file; the check step runs the ticket's `required_tests` and the tests related to its changed files, and a failure goes back to the builder (NEW-CHK-15) | ARCH-10 |
| NEW-CHK-17 | Rafi-owned tickets (CI fix tickets, re-check fix tickets): you're told once (terminal, notification, summary) and never asked; they aren't plan updates, write no plan revision and stay out of the scope fingerprint; they don't count toward `--steps` and aren't limited by `--to-ticket`. One that runs out of fixes is left open with no question | ARCH-11 |
| NEW-CHK-18 | Codex sessions reach `run_check` and `check_output` through a local-only HTTP MCP endpoint the engine serves (127.0.0.1, a per-session token); Claude sessions get them in-process. No second rafi process and no experimental Codex API | ARCH-9 |

### 8.25 Security and Windows

Decided 2026-11-02 (ARCH-12; `REWRITE_ARCHITECTURE.md` 1.2).

| ID | Requirement | Source |
|---|---|---|
| NEW-SEC-1 | Agents can't act outside their ticket or through rafi: no writing rafi's state, no commands outside `run_check`'s allowlist, no network beyond the grants, no code changes from QA's test runs, no calls to rafi's endpoint without the session's token. Untrusted data never becomes instructions, and secrets are redacted everywhere they're stored or shown | ARCH-12 |
| NEW-SEC-2 | Security is built from the start: the architecture has a threat model; every milestone's done checks include security tests for what it adds; one full security review comes before release | ARCH-12 |
| NEW-SEC-3 | Windows-safe code from the start (paths through Node's `path`, commands spawned without shell strings, no bash-only commands inside rafi), and the fast suite also runs on Windows. Windows itself is supported later, with the GUI | ARCH-12 |

### 8.26 Workflows and roles as data

Decided 2026-11-02 (ARCH-13; `REWRITE_ARCHITECTURE.md` 4.8). Groundwork only: 1.0 has no custom workflows.

| ID | Requirement | Source |
|---|---|---|
| NEW-WF-1 | A ticket's steps are a workflow defined as data. 1.0 ships one, `standard` (prepare, build, check, review, fix, deliver). Each step is a maker (may change code), a checker (read-only verdict) or a rafi action, with the same shape: read from the log, run one turn or action, write its outcome. A build records the workflow it uses and keeps it to the end | ARCH-13 |
| NEW-WF-2 | Roles are data: core instructions, reply schema, permissions and default agent. 1.0 ships planner, ticket-maker, builder, qa and manager | ARCH-13 |
| NEW-WF-3 | Loops are per-step limits ("on fail go to step X, up to N times"); `retries.fixes` is the limit on `standard`'s fix loop | ARCH-13 |
| NEW-WF-4 | Load checks: every step reachable, every fail path ends, every loop limited, every role exists, step types match role permissions. They run on the built-in workflow, and the transition tests are built from the workflow data | ARCH-13 |
| NEW-WF-5 | `workflows:` in `rafi-config.yaml` and `workflow` on a ticket are reserved and rejected with "Custom workflows aren't supported yet." | ARCH-13 |

## 9. Open questions

### 9.0 Decided in review (2026-11-01; architecture decisions ARCH-1–13, 2026-11-02)

| ID | Decision |
|---|---|
| Q-APR-1 | Auto-approve **can** grant permissions. Internet access, installs and live services always get a warning in the upfront check, once, before the build starts, so an unattended build never stops for it. Choices: continue (this build); always allow (saved for this project, on this machine only, per Q-PORT-2); stop and deny (the build doesn't start); deny but build the rest (tickets that need it are held back); show which tickets need it and why. |
| Q-PORT-2 | Saved answers are committed in the progress file. "Always allow" permissions stay on each machine and are shown in the upfront check on a new machine. |
| Q-CMD-3 | `rafi reset`: (a) "this build" keeps restart-current and archive-restart, plus the stash/discard/handled cleanup choices; (b) "everything" resets tickets to post-population and carries the plan approval forward; (c) the event log is kept; (d) **resetting the plan is in 1.0** (GUI-INS-8); (e) `tickets reset` stays as the tracker-only reset. |
| Q-CMD-6 | `rafi stop` stops at the next safe point, and says so when you run it: "Stopping after the current step. Run `rafi stop` again or press Ctrl+C to stop now." A second `stop` or Ctrl+C cancels immediately, keeping evidence. Pause stays a Manager control for now. |
| Q-REQ-1 | The requirements file is always written. Preparation depth stays as a planner field with enforced minimums. The create question "Prepare QA requirements before Builder work?" is dropped. |
| Q-REQ-3 | The QA agent writes the requirements file, as QA preparation does today (`ai-foreman/src/qaBuildGate.ts:232`: role `qa`, read-only sandbox). It's a fresh QA session before the builder starts. The checker, not the builder, writes what will be checked. |
| Q-CFG-2 | No backward compatibility in the new engine: it reads only 1.0 formats. A one-time `rafi migrate` (CMD-37) converts a 0.10.x project, and is required, so moneyTree can continue on 1.0 (guide step 11). Pre-0.10 formats and their conversions are dropped: `project.yaml` (PRM-38), the legacy `qa_preparation: { mode }` object (FLAG-CO-4), `--queue-limit` (FLAG-TK-3), and the "legacy migration" wording (FLAG-TK-8). This also answers GUI open question 15. |
| Q-CFG-3 | The `autonomy` profiles (supervised, balanced, unattended) and `--autonomy` are replaced by one `retries` setting: by default 3 builder fix attempts per ticket after QA rejects or a check fails, and 3 retries for provider errors. Circling detection (NEW-ENG-5) can stop sooner. Worker-restart limits go away (one process), and plan changes have their own setting (NEW-PUA-6). |
| Q-CFG-5 | The Ticket Maker isn't per ticket: one agent writes every ticket in a `tickets populate` run, in one proposal (`ai-foreman/src/roles.ts:30`, `ticketPopulation.ts`), so it keeps the whole plan in view. Each new run (for example after a plan revision) starts **fresh**, because the plan file carries the context and an old session would bring assumptions from the previous plan. Default `session_strategy` for ticket-maker changes from `compact` to `fresh`. |
| Q-PORT-4 | (Step 3 review, RWR-09.) **The database is the truth on each machine.** Rafi rewrites `.rafi/progress.yaml` from it at every safe point, like a lockfile. When the database is missing or behind the file (for example after a fresh clone), rafi rebuilds from the file. If git leaves a conflict in the file, rafi takes the newer entry per ticket and tells you what it chose. |
| Q-LIFE-1 | (Step 3 review, RWR-10.) State has three levels, ticket, build and project (NEW-ENG-2), all derived from the event log. Every GUI label (GUI-R9) maps from them; the exact mapping is set in the architecture plan. |
| Step 3 corrections | Completed interviews really are pruned after 30 days (FILE-31). `rafi-config.yaml` and the progress file are always committed, even with the "All Rafi" gitignore choice (FILE-1, FILE-10, PRM-13). |
| Q-GUI-1 | No scale targets and no limits (the earlier 20 per project / 100 per user were dropped 2026-11-01). Testing covers 2 builds at once, through the live Claude and Codex suites running in parallel. GUI questions 3 and 15 can wait (15 is answered by `rafi migrate`). |
| D2 | (Step 5 scenario review, `REWRITE_SCENARIOS.md` 11.2.) A repair resend that doesn't match the readable parts of the original is discarded and the turn is redone as a normal retry, with the error sent back and with circling detection (NEW-ENG-5), not a stop. Updates NEW-MAL-2. |
| D3 | (Step 5 review.) Auto-approve fills in an unsaved plan-update setting with its default, change then tell (NEW-PUA-6). The choice is **saved to `rafi-config.yaml`**, so later auto-approved builds don't ask again. Before the next build starts, rafi prints a one-time notice: "Plan updates are set to 'change, then tell you' (saved by auto-approve on <date>). Change it in `rafi-config.yaml`." It never overrides a setting you saved. It never answers a product decision the Planner flagged: those are asked in the upfront list before the build, like everything else, and can be answered later (NEW-ASK-2, NEW-ASK-4). Refines NEW-PERM-4. |
| D4 | (Step 5 review; replaces the earlier "lighter alternative" default and choice A in NEW-QAM-1, Q-QAM-1 and Q-QAM-2.) Checks only a person can do: permissions are still asked up front. QA first verifies everything it can itself, with Playwright or a headless browser (mobile-mcp for mobile), including partial checks. Only what truly needs a person is asked, when the build reaches it (pinned terminal prompt and notification), not in the upfront list; person-only checks leave NEW-ASK-2's scan. That ticket and the tickets that depend on it wait for the answer; everything else keeps building; when you confirm, it's done. "I verified it myself" stays, and goes stale when the covered code changes (Q-QAM-3). The Planner still avoids criteria QA can't verify and marks person-only checks on the ticket. B (no manual checks) and C (don't wait; track as open questions) stay as optional per-project or per-ticket settings; this behavior is the default. Updates NEW-QAM-1, NEW-ASK-2, NEW-INS-9, FMT-T19, FMT-T20, FMT-C16, OUT-18, PRM-81. |
| D5 | (Step 5 review.) `--detach` starts one normal rafi process in the background: no hidden flags, no CLI-on-CLI (NEW-ENG-6). `rafi status` and `rafi resume` follow it by reading the event log. Updates FLAG-ST-9; Q-OUT-1's "returns 0 after launch" stands. |
| D6 | (Step 5 review.) The old engine refuses a 1.0-format project with "This project uses 1.0 formats; set RAFI_ENGINE=next." Updates ENV-6 and NEW-ENG-10. |
| D8 | (User, 2026-11-01; `REWRITE_SCENARIOS.md` 11.2.) **No baseline against today's rafi (0.10.2).** No backward compatibility is needed, and this doc already records every user-visible behavior from the code. Guide step 6 is dropped. The fake-agent harness is built as the first piece of the new engine (milestone 1), and scenarios are written test-first against the new engine: write the test, see it fail, build, see it pass (NEW-ENG-9). SCN-9 and SCN-14 (O-E2E-005, O-E2E-004) can optionally be checked by hand on 0.10.2. The live suite is new-engine only: one simple ticket, a 3-ticket batch, a blocked permission, kill then resume, per provider, plus a few other live checks, on tiny tickets, run before a release. Updates NEW-HAR-1, SCN-9, SCN-14 and the 9.1 note. |
| Step 5 correction | PRM-G2 and OUT-42 said 0.10.2 exits with code 2 on a build question "with or without a terminal". The code asks in place in a terminal and exits 2 only without one (`ai-foreman/src/humanDecision.ts:35,87`; `ai-foreman/src/foreman.ts:801-834`; `ai-foreman/src/cli/start.ts:2706,2986`; `ai-foreman/src/supervisedStart.ts:132`). Both rows are corrected; the decided change (no exit while waiting, NEW-BLK-5) is unchanged. |
| ARCH-1 | (Architecture review, 2026-11-02.) No old engine is kept after the switch. `RAFI_ENGINE` exists only while the rewrite is built side by side; at the switch the old engine is deleted in the same release (`@rafi-ai/cli` 1.0 / `ai-foreman` 3.0). Anyone who needs the old one installs the previous version (`npm install -g @rafi-ai/cli@0.10.2`). Updates NEW-ENG-10. |
| ARCH-2 | (Architecture review.) Codex's app-server stays for 1.0, behind one transport file, though OpenAI calls it experimental: it's the only Codex mode with approvals, interrupt and usage. |
| ARCH-3 | (Architecture review.) If a fake `claude` executable can't be made to work (D9), the process set tests Claude with the in-process fake plus the live suite; no test-only code goes into the adapter. |
| ARCH-4 | (Architecture review.) Claude login needs no change: rafi runs your installed, unmodified `claude` with your own login, which Anthropic's terms allow. |
| ARCH-5 | (Architecture review.) Tests and CI: section 8.24 (NEW-CHK-1–18, FMT-C23–C25). Updates NEW-MAL-6. |
| ARCH-6 | (User, 2026-11-02.) The interview asks "Who manages git: Rafi or me?" first (PRM-11). Today ticket setup asks base branch, branch prefix, branch strategy and PR title format whatever the work mode (`ai-foreman/src/cli/tickets.ts:817-830`). In 1.0 the answer is saved as `git.managed_by` (FMT-C25), and picking "me" skips every branch, PR, merge and CI question, in `rafi create` and in `rafi tickets setup:*`. |
| ARCH-7 | (Step 8 architecture review, 2026-11-02.) How often rafi's CI runs is a setting, `checks.ci_when`: each ticket, each PR or merge, once at the end of the build (default), or light before each PR plus full at the end. CI never reruns a test whose last passing run is still fresh (NEW-CHK-13). |
| ARCH-8 | (Step 8 review.) A background build (`--detach`) keeps waiting on you instead of exiting with code 2, so notification answers keep working. Exit code 2 stays for foreground builds without a terminal. Updates NEW-BLK-5 and Q-OUT-1. |
| ARCH-9 | (Step 8 review.) Codex reaches rafi's test tools through a local-only HTTP MCP endpoint the engine serves (NEW-CHK-18). |
| ARCH-10 | (Step 8 review.) With QA off, the check step runs the ticket's required and related tests. After any failure the builder gets every detail, by reference where long, and is told to keep its work and not start over (NEW-CHK-15, NEW-CHK-16). |
| ARCH-11 | (Step 8 review.) Rafi-owned fix tickets are told once, never asked, aren't plan updates and don't count toward `--steps` (NEW-CHK-17). |
| ARCH-12 | (User, 2026-11-02.) Security from the start: a threat model in the architecture (1.2), security tests in every milestone's done checks with the main pass in M2, and a full review before release. Code is kept Windows-safe and the fast suite runs on Windows, though Windows is supported later (NEW-SEC-1–3). |
| ARCH-13 | (User, 2026-11-02.) Workflows and roles are data, so custom workflows (for example maker-checker builds: plan, audit the plan, build, review, with any roles) can come later without a rewrite. 1.0 ships one workflow and today's roles; the user-facing feature is after 1.0 (NEW-WF-1–5, FMT-C26, FMT-T21). |

**Every other question in 9.1 is decided as recommended** (accepted 2026-11-01). Where a row in 9.1 and this table differ, this table wins.

### 9.1 Questions for you

Each question names what it affects. Where I have a recommendation, it's given; nothing here reopens a decided item.

**Commands**

| ID | Question | Recommendation | Affects |
|---|---|---|---|
| Q-CMD-1 | `RW` doesn't decide these commands: `doctor`, `graph`, `sources`, `discover`, `qa-rehearse-rollback`, `uninstall:restore`, `uninstall:cleanup`, `--version`. Keep them all? | Keep all | CMD-1, 21–28 |
| Q-CMD-2 | What does `rafi answer` look like? Today `build:decide` needs `--run`, `--decision` and `--choice` IDs. | `rafi answer` with no arguments lists open questions by short number and asks; `rafi answer <n> <choice-number or text>` answers one | FLAG-AN-1, NEW-GUI-5 |
| Q-CMD-3 (**decided**, 9.0) | What does `rafi reset` do in detail? (a) "This build": which of today's start-over actions stay (restart-current, archive-restart, archive-new-branch, new-branch, retain-merged, revert-branch, manual) and the dirty-tree cleanup choices (stash, discard, handled)? (b) "Everything": reset tickets to post-population and carry the plan approval forward, as `build:reset` does today? (c) Is the event log kept, archived or cleared? (d) Is resetting the plan in scope (GUI-INS-8)? (e) `tickets reset` stays as the tracker-only reset? | (a) keep restart-current and archive-restart; (b) yes; (c) kept, since recorded data is never deleted automatically; (e) yes | FLAG-RE-1..3, PRM-100, FILE-47 |
| Q-CMD-4 | Manager host commands take full run, work and attempt IDs. Switch them to short references too? | Yes, accept both | FLAG-MG-3 |
| Q-CMD-5 | Drop the standalone `ai-foreman` binary, since `rafi` calls the engine as a library? | Drop | CMD-36 |
| Q-CMD-6 (**decided**, 9.0) | Is `rafi stop` "finish the current step, then stop" or "cancel now, keep evidence"? Is there a `rafi pause` (GUI-RUN-1 has both)? | `stop` waits for the next safe point; Ctrl+C or a second `stop` cancels. Pause stays a Manager control for now | FLAG-SP-1, GUI-R4 |
| Q-CMD-7 | `resume --inspect` has nothing to inspect once resume just redoes the step. Move it to `rafi status`? | Yes | FLAG-RS-7 |

**Flags and approvals**

| ID | Question | Recommendation | Affects |
|---|---|---|---|
| Q-APR-1 (**decided**, 9.0) | May auto-approve grant a permission? Principle 14 says auto-approve answers every question with a safe default. GUI-RUN-4 says network is "never implied by 'yes to all'", and `PUA §4` wanted plan updates separate from network so one doesn't approve the other. | *Superseded by 9.0:* auto-approve **can** grant permissions; internet access, installs and live services always get a warning in the upfront check | FLAG-ST-49/50, NEW-PERM-4, GUI-R6 |
| Q-FLAG-1 | Which keys can `--set key=value` override? How are unknown keys and org-locked keys handled? | Any `rafi-config.yaml` key; unknown keys are an error; locked keys are refused with the reason | FLAG-ST-51, GUI-R21 |
| Q-FLAG-2 | The full value list for `--allow`. `RW` names `internet` and `local-servers`. Also installs, live services, and the per-operation sandbox escalation that `--builder-approvals` gave? Can a value be granted to the builder only, or QA only? | `internet`, `local-servers`, `installs`, `services`; one grant covers builder and QA as `RW:82` says | FLAG-ST-50, NEW-PERM-3 |
| Q-FLAG-3 | `-y`/`--yes` means two things today: "approve the build/plan flow" (`start`, `resume`, `plan`, `tickets plan`, `tickets populate`, `discover`) and "confirm this one action" (`uninstall:*`, `sources remove`, `tickets reset`, `graph adopt`, `tickets groups repair`). Should only the first group become `--auto-approve`? | Yes. Single-action confirmations keep `--yes` | FLAG-PL-11, FLAG-TK-24, section 2.8 |

**Config**

| ID | Question | Recommendation | Affects |
|---|---|---|---|
| Q-CFG-1 | Names for the new config-only keys: `--max-branch-depth`, `--keep-worktrees` have no config key today. Does `tickets.build.pr_ready` stay alongside `completion: pr-ready`? Should the `RAFI_*` tuning variables (ENV-4) become config keys? | Add `tickets.build.max_branch_depth` and `keep_worktrees`; drop `pr_ready` in favor of `completion: pr-ready`; move tuning variables to config | FLAG-ST-35..46, FMT-C9, ENV-4 |
| Q-CFG-2 (**decided**, 9.0) | Principle 8 drops compatibility code, but process step 7 says the new engine reads existing config unchanged. Which old forms must still be read: the legacy `qa_preparation: { mode }` object, `project.yaml`, `--queue-limit`, groups "after the legacy migration"? | Read anything 0.10.x writes, unchanged. Drop pre-0.10 forms and their migrations | FLAG-CO-4, PRM-38, FLAG-TK-3, FLAG-TK-8 |
| Q-CFG-3 (**decided**, 9.0) | The `autonomy` block today sets per-profile limits (QA fixes per ticket 2/3/5, transient retries 0/3/5, format corrections 1/2/3) and the plan-change policy. With `--autonomy` dropped and principle 4's retry rules, what replaces it: keep the profiles in config, replace them with explicit retry limits, or drop them? What's the default QA fix allowance? | Replace with explicit limits under one `retries` key; default 3 fixes per ticket, with circling detection able to stop sooner | FMT-C10, FLAG-ST-33 |
| Q-CFG-4 | Merge `foreman.yaml` (bash allow/escalate lists, tool lists, notifications, QA on/off, observability) into `rafi-config.yaml`? | Yes; read an existing `foreman.yaml` once and say where its settings went | FILE-2 |
| Q-CFG-5 (**decided**, 9.0) | Ticket Maker's default session strategy is `compact`. Change it to `fresh` with builder and QA? | Yes | FMT-C7 |

**Portability and files**

| ID | Question | Recommendation | Affects |
|---|---|---|---|
| Q-PORT-1 (**decided**: `.rafi/progress.yaml`) | Name, format and location of the committed progress file. How are conflicts handled when two branches change it? | One YAML file under `.rafi/` (for example `.rafi/progress.yaml`), sorted keys and one entry per line so git merges cleanly | FILE-40, NEW-PORT-1 |
| Q-PORT-2 (**decided**, 9.0) | "Always allow" is saved for the project, and `RW:73` puts permissions in the committed file. That means a teammate or CI that clones the project inherits "always allow internet". Is that intended? | Commit saved answers; keep "always allow" permissions local, and show them at the upfront check on a new machine | FMT-C21, FILE-40 |
| Q-PORT-3 | Where does the event-log database live, and what does "logs saved in the project" store, given the database isn't committed? | Database under `.rafi/` (ignored); project-stored logs are the `rafi logs export` text format, written per run | FILE-41, FILE-42, NEW-LOG-1 |

**Requirements file and QA**

| ID | Question | Recommendation | Affects |
|---|---|---|---|
| Q-REQ-1 (**decided**, 9.0) | Does the planner-chosen preparation depth survive? The source spec has five levels (Focused, Standard, Extensive, Critical, Exceptional), host-enforced minimums for risky categories, and an independent challenge at level 5. And does the create question "Prepare QA requirements before Builder work?" go away because the file is always written? | Always write the file; keep depth as a planner field with enforced minimums (it's how NEW-CAU-5 is met); drop the create question | PRM-7, FMT-T11, FMT-C11, NEW-REQ-1 |
| Q-REQ-2 | Where does the requirements file live, and is it committed? | Committed under `<docs>/requirements/<ticket-id>.md`, so it travels with the project | FILE-60 |
| Q-REQ-3 (**decided**, 9.0) | Who writes it: a separate preparation turn, the Planner when it writes the ticket, or the builder before it starts? | A short preparation turn before the builder, as today's QA preparation does | NEW-REQ-1 |
| Q-QAM-1 (**superseded** by D4, 9.0) | Manual-check choice A (checks stop the build) needs a new kind of wait with resume and staleness rules (`QAMC §1` "Risk"). Does it use the blocked-ticket prompt and "answer later", or something separate? | Use the blocked-ticket prompt with a "confirm checks" option | NEW-QAM-1 |
| Q-QAM-2 (**decided** by D4, 9.0: C stays an optional setting with this rule) | Choice C (checks don't stop the build) needs a place to track open checks, and a rule for later tickets that build on work nobody has verified. What's the rule? | Track them as open questions; later tickets proceed; the end-of-build summary lists unverified checks and the tickets built on them | NEW-QAM-1 |
| Q-QAM-3 | When does an "I verified it myself" answer go stale: never, or when the code it covered changes? | When the covered code changes, like other saved answers (NEW-QAM-4) | PRM-81 |
| Q-COPY-1 | The rule for when a ticket needs a QA copy or full fingerprint, and the minimum rafi enforces for low-risk tickets. | Copy when QA could otherwise see the builder's changing files; full fingerprint only for High risk or on request | NEW-COPY-1..2, NEW-CAU-5 |

**Replies and repair**

| ID | Question | Recommendation | Affects |
|---|---|---|---|
| Q-MAL-1 | Repair scope: principle 4 retries bad JSON and format slips; the structured-output plan excludes content errors that need new reasoning from the one repair try; ticket planning today allows up to three corrections. One limit for everything, or separate limits for format errors (one repair) and content errors (a normal retry with the error sent back)? | Separate: one repair for format, normal retries (with circling detection) for content | NEW-MAL-2, NEW-SO-1, PRM-41 |
| Q-MAL-2 | The plain-text report plus extraction call needs a direct model API call with an API key. Allowed, and with which provider and key? | Not for 1.0; revisit if the malformed rate stays high after NEW-MAL-7 | NEW-MAL-9 |

**Plan updates**

| ID | Question | Recommendation | Affects |
|---|---|---|---|
| Q-PUA-1 | `PUA §3` lets you switch back for one ticket, from a chosen change onward, or entirely. `RW` decides what happens to the code but not which of these three ship. All three? | Entirely and per ticket for 1.0 | NEW-PUA-5 |
| Q-PUA-2 | How do you read the plan-change log and switch to a backup: a command, Manager, or just the files? | A `rafi plan` subcommand to list changes and restore a revision; Manager can read the log | NEW-PUA-2, NEW-PUA-5 |

**Run history**

| ID | Question | Recommendation | Affects |
|---|---|---|---|
| Q-STATS-1 | Which `rafi stats` subcommands ship in 1.0, and what's the default capture level? | `show`, `timeline`, `export` and `delete` in 1.0; `compare` and `replay` after. Default `normal` | CMD-33, NEW-STATS-4, FMT-C19 |
| Q-STATS-2 | Recorded data is "never deleted automatically" (`RW:168`), but recordings default to keeping "the last 5 builds" (`RW:474`). Are recordings an exception? | Yes: recordings follow their own retention setting; everything else is kept until `rafi stats delete` | NEW-STATS-3, NEW-TOOL-5 |

**Other**

| ID | Question | Recommendation | Affects |
|---|---|---|---|
| Q-SET-1 | Name and location of the project setup script, and does running it count for the upfront permission check (it installs dependencies)? | `scripts/rafi-setup.sh`, committed; its installs are scanned like any other need | FILE-61, NEW-SET-1 |
| Q-NOT-1 | Default reminder timing, and which events notify by default. | Remind after 30 minutes, then hourly; notify on questions, blocks and build end | NEW-NOT-6 |
| Q-NOT-2 | When does rafi offer to install `alerter`: during `create`, at the first build that needs to ask, or in `doctor`? | In `create` on macOS, and `doctor` reports it | PRM-23, NEW-NOT-4 |
| Q-FMT-1 | How do the engine's ~6 states map onto today's tracker statuses (`planned`, `next`, `in_progress`, `blocked`, `done`, `canceled`, `obsolete`)? Is "won't do" the same as `canceled`? Is "skipped for now" a status or just `blocked` with an open question? | building/reviewing/fixing → `in_progress`; won't do → `canceled`; skipped → `blocked` with its open question | FMT-S1, FMT-S6 |
| Q-FMT-2 | Does `docs/ticket-progress.md` (with its `LLM_NEXT_QUEUE` heading) stay once agents no longer read it? | Keep it for people; rename the heading | FILE-28 |
| Q-OUT-1 | Exit codes for scripts. A non-terminal foreground build with an unanswered question and nothing left to build: wait forever (`RW:395`) or exit with code 2 as today? What does `--detach` return? | Wait in a terminal and in a background build (ARCH-8); in a foreground build without a terminal, exit 2 once nothing is left, keeping the question saved. `--detach` returns 0 after launch | OUT-42, PRM-G2 |
| Q-OUT-2 | Replace the `foreman:` and `ai-foreman:` prefixes with `rafi:`? | Yes | OUT-11 |
| Q-ADP-1 | U1: adopt the non-persistent Claude launch flag for the compaction threshold? It reported the requested window but hasn't been shown to trigger correctly | Test it in the adapter milestone before relying on it | NEW-ADP-1 |
| Q-ADP-2 | When one agent is reused across tickets, should compaction happen only above the threshold, not at every ticket boundary? | Only above the threshold | NEW-ADP-3 |
| Q-GUI-1 (**decided**, 9.0) | GUI open questions that affect the engine design: 3 (what each runtime offers for "btw" side questions), 12 (how many instances to design for), 15 (how existing `.rafi/` projects move to the daemon). | Answer 12 before the architecture plan; 3 and 15 can wait | NEW-GUI-4, GUI-R14 |

Optional, by hand, if wanted (not decisions; guide step 6 and its baseline were dropped, D8 in 9.0): whether O-E2E-005 (`--steps N` stopping early, SCN-9) and O-E2E-004 (noisy Claude "tool failed" lines, SCN-14) still happen on 0.10.2.

### 9.2 Proposed marks to confirm

These marks are mine, not decided in `RW`. The full reasoning is in each row above.

- **Keep (72):** CMD-1, CMD-21, CMD-22, CMD-24, CMD-25, CMD-26, CMD-27, CMD-28, FLAG-CR-2, FLAG-CR-3, FLAG-CR-6, FLAG-CR-7, FLAG-CR-8, FLAG-CR-9, FLAG-CR-10, FLAG-CO-2, FLAG-CO-3, FLAG-PL-5, FLAG-TK-3 (but drop `--queue-limit`), FLAG-TK-8, FLAG-ST-R4, FLAG-ST-R5, FLAG-ST-R6, FLAG-RS-2, FLAG-RS-4, FLAG-RS-11, FLAG-RS-12, FLAG-RE-3, FLAG-MG-2, FLAG-MG-5, FLAG-MG-6, FLAG-MG-7, FLAG-MG-8, FLAG-MG-10, FLAG-DR-1, FLAG-DR-2, FLAG-GR-1, FLAG-GR-2, FLAG-SR-1, FLAG-DI-1, FLAG-UN-2, FLAG-UN-3, ENV-2, ENV-4, PRM-76, PRM-77, PRM-78, PRM-79, PRM-112, FILE-8, FILE-11, FILE-23, FILE-24, FILE-25 (but drop the SQL migration file), FILE-28, FILE-29, FILE-30, FILE-32, FILE-49, FILE-51, FMT-T10, FMT-T12, FMT-S1, FMT-S5, FMT-D1, FMT-D2, FMT-K1, OUT-8, OUT-10, OUT-13, OUT-40, NEW-ADP-4.
- **Change (8):** FLAG-RS-7, FLAG-SP-1, FLAG-DR-3, FLAG-AU-1, PRM-7, FILE-2, FILE-46, OUT-11.
- **Drop (8):** CMD-36, FLAG-CO-4, FLAG-PL-10, FLAG-TK-23, FLAG-MG-4, PRM-38, PRM-80, PRM-96.
- **Detail added from a source doc (2):** NEW-REQ-6, NEW-REQ-7.

Marks labelled "(follows …)" are derived from a decided item; they aren't listed here, but say so if one looks wrong.

### 9.3 What I couldn't check

- I read the prompt text and choices from the source; I didn't click through every interactive flow. A run of each flow in guide step 3 would confirm them.
- I ran `status`, `tickets queue` and `tickets validate` on a scratch copy of moneyTree. I didn't run `doctor`, `manager`, `start` or `resume`, which need a provider or change state.
- Windows and WSL behavior (notifications, colors) comes from the code and docs only.
- The GUI requirements are a draft PRD (0.2). Items marked 🔶 there are its author's assumptions and may still change.
