# Rafi (Refined AI Framework & Implementor)

Rafi is an interview-led engineering framework for Claude Code and Codex. It helps you introduce an AI engineering team to a repository, decide what should be built, turn that decision into an ordered ticket queue, and drive the work with QA after every ticket.

You do not need to learn a long sequence of setup and planning commands. Rafi is designed around two guided conversations:

1A. Run `rafi create .` when Rafi is new to a project.
1B. Run `rafi tickets plan` when a Rafi project needs more work.
2.  Run `rafi tickets queue` to view tickets when they're ready.
    Run `rafi start . --steps NUMBER_OF_TICKETS` to start building. ex: `rafi start . --steps 5`

Those two interviews cover the normal lifecycle. Rafi asks the questions, explains meaningful choices, remembers the project, and shows you what it intends to do before it changes shared planning state.

## Install

Rafi requires Node.js 20 or later.

```sh
npm install -g @rafi-ai/cli
```

Then open the repository you want to work on and start the appropriate interview.

## Workflow 1: bring Rafi into a project

Use `rafi create` once when adopting a new or existing repository:

```sh
cd my-project
rafi create .
```

This is an interactive setup interview, not a blind scaffolding command. Every question has a useful default, and Rafi handles the mechanical follow-up work for you.

The interview asks about the application and its real engineering environment: its frontend and backend, database, package manager, cloud posture, whether it uses AI, and whether Claude Code, Codex, or both should work on it. It also asks where Rafi-owned documentation should live and whether existing plans or ticket sources should be brought into the initial project setup.

As it proceeds, Rafi:

- writes the project’s choices to `rafi-config.yaml`;
- composes stack-aware rules, skills, and role agents for the selected runtimes;
- creates native Claude Code and/or Codex project files;
- creates role bundles used by the ticket builder and QA loop;
- protects existing `AGENTS.md`, `CLAUDE.md`, skills, agents, and documentation instead of silently replacing them;
- verifies that the selected agent runtime is installed and authenticated;
- offers to continue into an initial planning interview and ticket setup.

For Claude, Rafi uses the exact system `claude` executable that passes its readiness check. It does not use the Claude Agent SDK's bundled executable, and it does not install the SDK into your application repository. Claude sessions inherit the terminal environment and load user, project, local, and organization-managed settings, so enterprise SSO flows such as `/login-okta` and managed proxy/certificate policy remain available.

The optional planning handoff is part of the `create` journey. Describe what the product should do, point Rafi at any existing requirements, and answer the planner’s follow-up questions. Rafi can then establish the project’s initial plan and structured ticket queue. You do not need to memorize a separate planning pipeline before you can get useful work underway.

This workflow is equally appropriate for an empty repository and an established codebase. In an existing repository, answer according to what the project actually uses. Rafi preserves project-owned material and adds its guidance around it.

Once a project has `rafi-config.yaml`, do not rerun `create` merely because you have another feature or milestone. That is the second workflow.

## Workflow 2: plan more work in an existing Rafi project

When a Rafi-managed project needs a feature, milestone, fix, audit, backlog import, or revised direction, run:

```sh
rafi tickets plan
```

You can run it from the project root or from a directory inside the project. Rafi finds the nearest configured project, shows its name and absolute path, and asks before using an ancestor project. Ticket planning requires a fully initialized tracker; an uninitialized or partial project is directed to `rafi create` or `rafi resume` before an agent is launched or shared state is changed.

Rafi also protects the less-visible history behind the tracker. If canonical tickets exist but the ignored local status database is missing, planning stops and explains what needs to be restored. It will not pretend every old ticket is new work and build a proposal on corrupted assumptions.

## A few useful supporting commands

The two interviews are the primary interface. These supporting commands are useful once work is underway:

```sh
rafi compile .       # refresh generated guidance after editing rafi-config.yaml
rafi status          # show the nearest project's latest builder run
rafi doctor .        # check project, runtime, and tracker readiness
rafi tickets queue   # view all tickets in queue
rafi build:resume .  # resumes a build that stopped
```

`rafi doctor .` reports the exact Claude executable, SDK-wrapper availability, setting sources, and the names (not values) of relevant proxy/certificate environment variables. If `claude -p "Return exactly OK"` succeeds but a Rafi Claude run still fails, use `rafi doctor . --live-claude` to exercise the same no-tools SDK execution path. The live check is opt-in, bounded, and uses account quota.

The complete scripting and maintenance command reference—including non-interactive modes and advanced overrides—is generated in [docs/cli.md](./docs/cli.md). It is intentionally separate from this guided workflow introduction.

Long-running commands keep one live terminal line updated with the current phase and elapsed time. Recoverable provider failures print a permanent `retrying` line; after 60 seconds without a provider signal, Rafi says the provider is quiet and continues waiting. CI and redirected output receive timestamped heartbeats every 30 seconds instead of terminal animation.

### One conversation, from rough idea to approved tickets

The interview begins with one open question. You can answer however is natural:

- describe a feature, problem, milestone, or desired outcome;
- ask Rafi to audit the repository and propose work;
- paste requirements or existing tickets;
- name local files, directories, or globs;
- reference saved Linear or Jira sources;
- provide a public web page, Markdown or text document, or PDF.

Rafi combines that answer with what it already knows about the project. It summarizes remembered sources and lets you say which ones matter for this session in plain language. It also surfaces saved future-work ideas and existing “next” tickets so you can include them, leave them for later, dismiss them, retain the current queue, or replace it intentionally.

Public sources are fetched and snapshotted for the session. Local material outside the repository is also copied into an ignored import snapshot rather than recording a machine-specific absolute path. Source provenance stays attached to the resulting tickets, so imported requirements do not disappear into an unexplained backlog.

### An interview at the depth you want

After hearing the initial request, Rafi explains two interview styles:

- **Standard** asks focused questions where an answer is needed to produce a sound proposal.
- **Exhaustive `grill-me`** probes assumptions, edge cases, failure modes, and unresolved product or delivery decisions more aggressively.

You can begin with the standard interview and upgrade to `grill-me` later without losing the proposal already under discussion.

`grill-me` does not promise an arbitrary minimum number of questions. If exhaustive planning reaches a valid candidate without one recognizable answered grill-me question, Rafi runs one fresh, read-only completeness audit before approval. A complete audit may confirm that the brief and repository already resolve every material judgment. If it finds gaps, Rafi asks at most five questions one at a time; the recommendation is shown first, custom answers remain available, and `Stop questions and make the plan now` always ends the fallback early. Rafi never selects a recommendation for you, including under `--yes`.

Questions are conversational. Rafi gives a recommended answer and alternatives, but you can always respond in your own words. Depending on the work, the conversation may cover scope, source interpretation, ticket size, dependencies, estimates, validation expectations, branching, pull requests, merge behavior, and whether several tickets should travel together as one delivery unit. These are decisions made with you, not by the planning agent or its independent auditor.

If only one configured runtime is available, Rafi uses it. If both Claude and Codex are configured, it asks which one should plan the session. It shows the effective model and reasoning defaults and lets you make session-only changes conversationally.

### Nothing changes until you approve the exact result

The planning agent runs read-only. It may inspect the repository and reason about the work, but it cannot edit the tracker or project while interviewing you.

When it believes the plan is ready, Rafi presents the complete human-readable plan and the exact proposed ticket changes. That proposal can include:

- new tickets and edits to existing tickets;
- dependency and ordering changes;
- explicit handling of every imported source item;
- future-work decisions;
- delivery groups, branch strategy, and pull-request behavior;
- the tickets that should be considered “next.”

You can approve the exact set, continue discussing it in natural language, or cancel. Continuing the discussion can be as simple as “split the API work,” “keep the existing next tickets,” “make this one pull request,” or “upgrade to grill-me.” Rafi produces a revised complete proposal and asks for approval again.

After approval, Rafi validates and applies that exact proposal—no second agent gets to reinterpret it. Existing ticket IDs and completion evidence are preserved. Replaced work is linked through supersession history rather than erased. Rafi writes the current ticket plan and a timestamped historical copy, updates the structured tracker and delivery plan, and runs the tracker validations. If configuration or ticket state changed while you were reviewing, Rafi refreshes the proposal and asks for approval again instead of applying stale decisions.

Finally, Rafi summarizes what was created or changed and offers to start the agreed next ticket or delivery group.

## Build the approved work

Once tickets are ready, Rafi can drive the implementation queue:

```sh
rafi start . --steps 3
```

Each step is one ticket. The builder receives the project-specific role guidance, and QA reviews each completed ticket by default. The delivery choices approved during `rafi tickets plan` carry into execution: work can stay on the current branch, use a branch per ticket, or share an isolated branch and pull request across a related group.

The explicit current-branch choice is shown as **Current branch — Rafi works here; you manage Git**. In that mode Rafi may edit, test, run QA, and update tracker/recovery state, but it never creates or switches branches/worktrees, commits, pushes, merges, rebases, or manages reviews. Rafi pauses if the active worktree or ref changes unexpectedly. Isolated-workflow run flags are visible overrides and are captured in the run record.

If a grouped delivery contains more tickets than the current run allows, Rafi completes the requested number of tickets, preserves the group’s branch and session, and waits to open its pull request until the group is complete. Unfinished or blocked groups remain available to resume, while dependency-safe unrelated work can continue.

Every Rafi-created ticket batch also receives an immutable repository-local ID such as `TG-1`. Use `rafi tickets groups list` to see stable membership, missing definitions, status totals, and related recoverable runs. Group reset resolves and fingerprints an exact preview before approval:

```sh
rafi tickets reset --recent-groups 2
rafi tickets reset --group TG-4 --deleted-tickets restore --yes
```

Deleted definitions are restored only from Rafi’s latest validated snapshot and only when explicitly selected. A missing dependency is never stripped or silently restored; interactive runs ask what to do, while automation fails atomically unless the conflict is fully specified.

During active Builder and QA work, the bottom terminal line reports the role, provider, activity, truthful context occupancy, compaction count, and handoff generation. Redirected output receives timestamped snapshots. Session cost display is independent from occupancy and is off by default; when enabled, Rafi shows provider-authoritative cost or trustworthy cumulative tokens, never a bundled price estimate. Builder auto-compaction defaults to 50% with at most 10 successful compactions per provider session. Configure persistent values with `rafi agents`, or override only the initial run threshold with `rafi start --auto-compact-threshold`.

To see the most recent run, use:

```sh
rafi status
```

Like ticket planning, status finds the nearest Rafi project when run from a nested directory and identifies the project before showing its latest run.

If implementation is interrupted, use `rafi build:resume .`. It first shows compact candidates, then a complete selected-run preview with ticket title, failure/checkpoint, completed and remaining work, QA state, preserved worktree changes, session availability, and the exact next action. Expected worktree changes are informational; unexpected base/conflicting changes warn but do not block recovery. Recovery dispatches exactly one selected mode: exact session, fresh with a validated cumulative handoff, explicit compatibility fresh recovery, or interactive guided recovery for a degraded checkpoint. `--ticket` narrows mutation scope without discarding run-wide dependency and QA context.

Builder and QA turns continuously publish bounded cumulative checkpoints. Exact provider sessions are bound to their canonical worktree and durable workspace identity; a raw ID, changed/recreated worktree, or provider-location mismatch cannot authorize resume. Every disposable QA snapshot starts a fresh QA conversation and accepts cumulative state through the durable handoff stream. Automatic fresh transitions validate a versioned handoff before moving the role lease to a genuinely new provider session. Inspect durable history with `rafi handoffs inspect --run <id>`; disposable cache copies can be pruned separately, while durable history is deleted only by an explicit command after the run is no longer active or recoverable.

Use `rafi build:start-over .` when the whole run—not just tracker state—must restart. Local unmerged work is committed to a reported `archive/...` branch before the original branch returns to its recorded baseline. Pushed/open-review work is left untouched and restarts on a collision-safe `-restart-N` branch. Merged work offers current-base restart, a separate reviewable revert branch, manual guidance, or cancel. The command never force-pushes, deletes a remote branch, closes a review, or edits the base branch directly. `rafi tickets reset` only clears active tracker progress and ownership while preserving ticket definitions, dependencies, validation history, and audit events.

## Agent defaults and safe removal

Run `rafi agents .` to configure committed defaults independently for planner, Builder, QA, ticket maker, and the read-only uninstaller interpreter. `rafi start --agent` overrides only Builder for that run; QA remains a separate provider session with its own settings.

Run `rafi uninstall .` for an ordered, preview-first project uninstall. Manifest categories are reviewed separately, and files containing both Rafi and later user edits require an explicit keep, full-preimage restore, or marker-only removal decision (when markers exist). Removed/displaced bytes remain indefinitely in `.rafi-uninstall/<recovery-id>`; use `rafi uninstall:restore <recovery-id>` to recover them and `rafi uninstall:cleanup` for the separate permanent-delete step. Rafi never changes remote branches or pull requests, and `--dry-run` changes no bytes.

## Resume an interrupted interview

Rafi saves compact, local recovery records for its interactive workflows. If a setup or planning conversation is interrupted, return to it with:

```sh
rafi resume .
```

If more than one unfinished interview exists, Rafi lets you choose one. Ticket planning also notices its own unfinished interviews when you next run `rafi tickets plan` and offers to resume, discard, or start a new conversation.

Recovery records keep answers, checkpoints, source references, file fingerprints, and an agent session ID when one is available. They deliberately do not keep a full interview transcript or agent output. This preserves enough context to continue safely without turning a private product conversation into a permanent project artifact.

If the original agent session can be continued, Rafi requests it. Otherwise, it resumes from the saved brief, answers, and checkpoint and explains the limitation. Shared files are fingerprinted so an interrupted interview cannot unknowingly overwrite planning changes made in the meantime.

Completed recovery records are cleaned up after 30 days. You can also discard a saved interview from the interactive picker or with the focused commands documented in the [CLI reference](./docs/cli.md).

## Where `rafi plan` fits

`rafi plan` is the lower-level Markdown planning step used by the initial `rafi create` journey. It can be useful for automation or for producing a standalone planning document, but it is not the normal command for adding work to an active Rafi project.

The distinction is simple:

- `rafi plan` produces a planning document.
- `rafi tickets plan` understands the live ticket system, reconciles existing and imported work, agrees on delivery behavior, reviews an exact proposal with you, and safely applies the approved result.

For ongoing project work, prefer `rafi tickets plan`.

## What Rafi adds to a project

The exact files depend on whether Claude Code, Codex, or both are selected:

```text
my-project/
  rafi-config.yaml                   Project stack, runtime, and Rafi settings
  AGENTS.md                          Codex project guidance, when selected
  CLAUDE.md                          Claude Code project guidance, when selected
  .codex/agents/<role>.toml          Codex role agents
  .agents/skills/<name>/SKILL.md     Codex project skills
  .claude/agents/<role>.md           Claude Code role agents
  .claude/skills/<name>/SKILL.md     Claude Code project skills
  .rafi/compiled/<role>/             Runtime-neutral role bundles
  .rafi/interviews/                  Ignored interview recovery records
  .tickets/tickets.yaml              Canonical ticket definitions
  .tickets/delivery.yaml             Approved delivery groups and behavior
  .tickets/ticket-state.sqlite       Ignored local status and evidence history
  .rafi/source-cache/                Ignored private source snapshots
  .rafi/sources/                     Optional tracked source snapshots
  .tickets/imports/                  Legacy/import compatibility snapshots
  docs/rafi-plan.md                  Initial setup plan, when requested
  docs/rafi-ticket-plan.md           Latest approved ticket-planning result
  docs/rafi-ticket-plans/            Timestamped ticket-plan history
  docs/ticket-progress.md            Rendered view of the live tracker
```

The documentation root is configurable. If an existing project already owns `docs/`, the `create` interview recommends a separate `docs-rafi/` directory so it does not crowd or overwrite the application’s documentation.

After intentionally editing `rafi-config.yaml`, run `rafi compile .` to refresh generated project guidance.

## Existing files stay under your control

When a project already has root instructions such as `AGENTS.md` or `CLAUDE.md`, `rafi create` asks how they should be handled. The recommended choice preserves the existing file and adds a managed Rafi section. You may instead ask an authenticated runtime to merge the guidance or explicitly replace a disposable file.

The same principle applies to existing skills and agents. You can keep the project-owned artifact, let Rafi write its default under a distinct name, or configure Rafi to use the existing artifact. Rafi also refuses to overwrite a sidecar it cannot identify as Rafi-generated.

## Built for serious AI application work

Rafi is useful for general software projects, and it adds deeper guardrails when the application itself uses LLMs. Enabling AI support composes five additional rule packs into planning, building, and QA:

- **Adversarial safety** covers prompt injection, jailbreak defenses, content safety, tool scoping, abuse monitoring, red-team release criteria, and incident response.
- **Confidence and evals** require meaningful quality gates, golden examples, adversarial cases, and acceptance thresholds for model behavior.
- **Replayability** treats prompts as versioned engineering artifacts and records the inputs, model settings, tool calls, outputs, validation, cost, latency, and decisions needed to reproduce important generations.
- **Cost and learning loops** account for tokens, retries, tools, and latency while turning approved corrections into future evaluation or training material.
- **Model and dataset governance** makes model changes, fallbacks, dataset consent, retention, labeling quality, and training eligibility explicit engineering decisions.

General rule packs cover testing and TDD, security, observability, robustness, scalability, data governance, API documentation, release practices, architecture, accessibility, cloud infrastructure, and the technologies named during the setup interview.


## Packages

| Package | Purpose |
| --- | --- |
| `@rafi-ai/cli` | The complete `rafi` experience: setup, interviews, tickets, builder, status, and diagnostics. |
| `special-agents` | Rafi’s rules, skills, role definitions, and composition library. |
| `ai-foreman` | The ticket-loop runtime for users who need it as a standalone package. |
| `rafi-spec` | Shared schemas and TypeScript types used by the public packages. |

Published packages are available from npm.

## Releases and development

Release notes live in [CHANGELOG.md](./CHANGELOG.md), and release mechanics live in [RELEASING.md](./RELEASING.md).

This repository is a pnpm monorepo:

```text
packages/
  rafi/             @rafi-ai/cli
  ai-foreman/       Ticket runtime
  special-agents/   Rules, skills, and role composition
  spec/             Shared schemas and types
examples/
  dummy-project/    Smoke-test target
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
