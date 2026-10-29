# Rafi GUI — Product Requirements Document (PRD)

| | |
|---|---|
| **Status** | Draft 0.1 — for review |
| **Date** | 2026-10-28 |
| **Owner** | Tyler |
| **Document type** | PRD (what and why). The follow-on RFC / design doc covers how: protocol, data model, framework choices. |
| **Audience** | Product owner, planning agents, implementing agents |

> **How to read this.** Requirements carry stable IDs (`GUI-…`) so that tickets, the RFC and tests can trace to them. **MUST** = required for the phase in which it is listed. **SHOULD** = expected unless justified. **MAY** = optional. Items marked 🔶 are my embellishments or assumptions beyond the original brief; please confirm or strike them. §16 collects open questions. §17 gives the recommended phasing.

---

## 1. Summary

Rafi today is a terminal-first framework. A user runs `rafi create`, plans with interviews, generates tickets, and runs builds that coordinate builder / QA / manager / planner agents on Claude Code or Codex. All visibility and control happen through CLI output and commands.

This PRD defines a **web GUI for Rafi**, together with the platform features it needs. The GUI must let a user do everything Rafi can do (create → plan → tickets → build → QA → recovery) and see in real time what every agent is doing. It must also run **many parallel Rafi sessions on one project**, optionally driven by a natural-language **Maestro** (orchestrator) agent. It adds a planning workspace with a code/diff viewer, a metrics dashboard and an enterprise tier, in a professional UI designed to maximize throughput and quality while minimizing confusion, distraction and frustration.

The GUI is delivered as a **web app with a local mode and a remote/hosted mode**, on top of a new **Rafi daemon + API**. The CLI stays a first-class client of that same API.

## 2. Background and current-state grounding

Relevant facts from the codebase as of this writing (verify before relying on them in the RFC):

| Area | Today | Implication for the GUI |
|---|---|---|
| Packages | `@rafi-ai/cli` (`packages/rafi`), `ai-foreman` (runtime: builds, QA, recovery, manager), `special-agents` (agent/skill compile), `rafi-spec` (shared schemas/contracts) | The API contract should be built on `rafi-spec` types so CLI, daemon and UI cannot drift. |
| Observability | `.rafi/observability.sqlite3` already records spans (`RunSpanV1`), per-agent `RunCurrentStateV1` (role, stream, ticket, phase, last-signal / last-progress timestamps) and `RunRollupV1` (status, timing buckets, QA/retry counts, cohort percentiles) | The live "who is doing what and for how long" view and the dashboard can largely be driven from existing data. This is a strong foundation. |
| Activity | `ActivityReporter` renders live terminal progress; `BuilderEvent` is an event stream (text, tool lifecycle) from the `claude` / `codex` adapters | These events need to be fanned out to subscribers (UI), not only printed. |
| Providers | Adapters for Claude Code and Codex; fast-mode, session-identity and runtime-auth modules; Claude runs use the system `claude` executable and honor enterprise login | Remote runners must preserve per-user provider auth. Model toggling must go through the adapter layer. |
| Git | `branch/` has git, GitHub and GitLab modules, branch planning, finalization, dirty-baseline handling | Branch selection/creation and the GitHub/GitLab project picker extend existing code. |
| State | Per-project local state in `.rafi/`, `tickets.yaml`, `rafi-plan.json`, SQLite workflow DB; `rafi state export/import` | Parallel instances and remote runners need a stronger concurrency/locking model than "one build per checkout". |
| Control surface | Large CLI: `create`, `plan`, `tickets *`, `start`, `build:resume`, `resume`, `manager`, `plan:doctor`, `agents`, `status`, `state *`, `compile`, `uninstall`, graph, doctor, etc. | A feature-parity matrix (§7.3) is required so nothing is silently missing from the GUI. |
| Human decisions | Pending ticket questions, plan approvals, QA recovery decisions, builder approvals/network requests, durable "waiting" records | These are the GUI's most important interaction type: an **attention inbox** (§8.6). |

## 3. Problem statement

1. **Visibility.** Long-running builds are opaque in a terminal. Users cannot tell at a glance which agent is working, on what, for how long, or whether it is stuck.
2. **Control.** Pausing, steering, switching models, answering questions and recovering from failures require remembering commands and sometimes digging through state files.
3. **Throughput.** Users want to run several plans/builds at once but have no way to launch, supervise or compare them.
4. **Planning.** Interview and grill-me sessions are chat-in-a-terminal. Evaluating the code or diffs an agent references means context-switching to an editor.
5. **Insight.** There is no consolidated view of cost, speed, quality and history across runs.
6. **Adoption.** The terminal limits who can use Rafi and how teams can share and govern its use.

## 4. Goals, non-goals and success metrics

### 4.1 Goals
- **G1** Complete real-time situational awareness of any Rafi instance at a glance.
- **G2** Full lifecycle capability in the GUI (create → plan → tickets → build → QA → recovery) with feature parity with the CLI wherever it makes sense.
- **G3** First-class parallelism: many Rafi instances per project, viewed and controlled side by side.
- **G4** A Maestro agent that can set up and operate instances from natural language, with every action also available manually.
- **G5** A planning workspace that makes plan review and grill-me fast and well-informed, with excellent code/diff viewing.
- **G6** Metrics for usage, speed, spend and quality, extendable to an enterprise tier.
- **G7** A professional, calm, dense-but-legible interface that reduces user cognitive load and error.

### 4.2 Non-goals (v1)
- Replacing the CLI. The CLI stays supported and is a peer client.
- A full IDE or in-browser code editing. The viewer is read-only plus diff, with "open in editor" hand-offs. 🔶
- Supporting agent runtimes beyond Claude Code and Codex.
- A native mobile app. Responsive web for monitoring and approvals is in scope (§12.5). 🔶
- Building a new git hosting or code-review product. We integrate with GitHub/GitLab.

### 4.3 Success metrics 🔶
Targets are proposals to be calibrated during beta.

| Metric | Target |
|---|---|
| Time from "open GUI" to "know what every running agent is doing" | ≤ 3 seconds, no clicks |
| Event-to-screen latency for agent activity (local mode) | p95 ≤ 500 ms |
| Median time to answer a pending question/approval after it arises | Lower than the CLI baseline (measure first) |
| New-user time from first launch to a running build | ≤ 15 min, interview included |
| % of CLI feature set reachable from the GUI | 100% of the in-scope matrix (§7.3) |
| Parallel instances supervised by one user without degraded UI | ≥ 8 live instances (≥ 4 visible panes) |
| Task-level user satisfaction (survey) | ≥ 4.3/5 |
| Misclick-destructive-action incidents | 0 unrecoverable (all destructive actions confirm or undo) |

## 5. Users and personas

| Persona | Description | Primary needs |
|---|---|---|
| **Solo builder** | Individual dev using Rafi on personal or work repos | Fast setup, clear status, low-friction approvals, cost awareness |
| **Power operator** | Runs many plans/branches concurrently | Multi-pane, shortcuts, Maestro, comparison reports |
| **Tech lead / reviewer** | Reviews plans, tickets and results; may not drive builds | Great plan/diff review, history, audit trail |
| **Team admin / enterprise** | Governs usage across a team or org | SSO, roles, budgets, central metrics, audit, retention |
| **Newcomer** | New to Rafi's concepts (tickets, QA prep, manager) | Guided flow, plain language, safe defaults |

## 6. Glossary 🔶

- **Project**: a repository (local path, GitHub or GitLab) configured for Rafi.
- **Instance** (a.k.a. **Rafi session**): one independent Rafi workflow on a project, with its own plan, tickets, branch/worktree and build runs. The unit that panes display.
- **Agent**: a running role within an instance (planner, builder, QA, manager, host…), backed by a Claude Code or Codex session.
- **Maestro**: the optional orchestrator agent that operates instances for the user.
- **Daemon**: the long-running Rafi service that owns instances and exposes the API.
- **Runner**: the process/host where agent work actually executes (local machine, or remote machine/container in hosted mode).
- **Control plane**: in hosted mode, the service that handles auth, tenancy, projects, aggregation and routing to runners.
- **Attention item**: anything requiring a human decision or notice (question, approval, failure, stall).

## 7. Scope and architecture-level requirements

### 7.1 Platform shape (decided)
- **GUI-PLAT-1 (MUST)** The GUI is a web application served in two modes: **local mode** (a Rafi daemon on the user's machine serving UI and API on loopback) and **remote/hosted mode** (control plane plus runners; the browser connects over the network).
- **GUI-PLAT-2 (MUST)** A **Rafi daemon + API** owns instances and runs. Runs must outlive terminals and browser tabs. The CLI and GUI are both clients of the same API.
- **GUI-PLAT-3 (MUST)** *CLI stays first-class.* Any capability delivered through the GUI must be reachable through the CLI or API. Running CLI commands against a project while the daemon is active must be safe and reflected live in the GUI.
- **GUI-PLAT-4 (MUST)** The API contract is defined using shared schemas (extending `rafi-spec`), versioned, and used to generate or type-check both server and client. 🔶
- **GUI-PLAT-5 (MUST)** Real-time updates use a push channel (WebSocket or SSE) with resumable cursors so a reconnecting client replays missed events without gaps or duplicates. 🔶
- **GUI-PLAT-6 (SHOULD)** The local daemon may be wrapped in a desktop shell later without changing the web app. 🔶

### 7.2 Hosted / remote requirements
- **GUI-REM-1 (MUST)** A runner can be a user's own machine (agent connects outbound to the control plane, no inbound ports) or a managed remote host/container. 🔶
- **GUI-REM-2 (MUST)** Source code and agent transcripts stay on the runner unless the user/org explicitly enables central storage. The control plane stores only metadata and aggregates by default. 🔶 *(RFC must define exactly what flows where.)*
- **GUI-REM-3 (MUST)** Provider credentials (Claude / Codex auth, git tokens) are never exposed to the browser. Runners use the owning user's provider auth; enterprise login flows (e.g. org SSO for Claude Code) must keep working. 🔶
- **GUI-REM-4 (MUST)** All remote transport is TLS and authenticated. Runner ↔ control-plane trust uses revocable, scoped credentials. 🔶
- **GUI-REM-5 (SHOULD)** Local mode and hosted mode share the same UI code and API, differing only in auth, project discovery and runner management.
- **GUI-REM-6 (MUST)** Local mode binds to loopback only by default and protects against drive-by access from other web origins (CSRF / DNS-rebinding defenses, per-launch token). 🔶

### 7.3 Feature parity
- **GUI-PAR-1 (MUST)** Produce and maintain a **parity matrix** mapping every CLI command/flag group to a GUI surface (or an explicit justification for exclusion, per the brief's "unless it doesn't make sense or isn't helpful"). Initial classification, to be completed in the RFC:

| Capability | CLI today | GUI treatment |
|---|---|---|
| Project setup / interview | `rafi create`, `setup:*`, `init` | Guided wizard + planner view (§8.5) |
| Planning, plan approval, doctor | `rafi plan`, `plan:doctor`, `tickets plan` | Planner view, with recovery picker |
| Ticket CRUD and lifecycle | `tickets list/show/update/complete/block/unblock/cancel/reset/reorder/discover/accept-future-work/review/render/validate/queue/archive/import/populate/repair` | Ticket board/table with detail drawer and bulk actions |
| Build control | `start`, `build:resume`, `resume`, start-over / reset | Instance controls (§8.4) |
| Manager | `rafi manager` | Persistent talk-to-manager surface (§8.3) |
| Agent configuration | `rafi agents`, `compile` | Agent settings panel, per-agent model toggle |
| State transfer | `state export/inspect/import/rebind` | Project settings → State |
| Status / diagnostics | `status`, `doctor`, graph | Instance health + diagnostics views |
| Uninstall | `uninstall` | Project settings, with dry-run preview, danger zone |
| **No GUI surface (justify)** | e.g. test/canary/live scripts, `qa-rehearse-rollback` | Developer tooling; excluded unless needed |

- **GUI-PAR-2 (MUST)** Every GUI action that mutates state states what it will do in plain language beforehand (and, where helpful, shows the equivalent CLI command; 🔶 *"copy as CLI"* aids learning and scripting).
- **GUI-PAR-3 (SHOULD)** New CLI features ship with their GUI counterpart or an explicit "GUI deferred" note in the parity matrix, enforced in review. 🔶

## 8. Functional requirements

### 8.1 Projects

- **GUI-PRJ-1 (MUST)** The user can connect and switch between projects from: (a) local repos (path picker / recent / auto-discovery in configured roots), (b) GitHub repos, (c) GitLab repos (including self-hosted GitLab 🔶).
- **GUI-PRJ-2 (MUST)** Connecting a remote repo (GitHub/GitLab) clones or attaches it on a chosen runner and associates it with the project. Authentication uses OAuth / GitHub App / personal or project tokens, as the RFC decides; tokens are stored securely and scoped minimally.
- **GUI-PRJ-3 (MUST)** A project list/switcher shows for each project: name, source, runner, number of instances, aggregate status (running / waiting-on-you / failed / idle), and last activity.
- **GUI-PRJ-4 (MUST)** Opening a project that is not yet Rafi-configured offers **"Set up Rafi"** (the `rafi create` flow). Opening a legacy or partially-configured project surfaces the relevant migration/doctor guidance. 🔶
- **GUI-PRJ-5 (SHOULD)** Attention counts for all projects are visible from the switcher so the user never has to open a project to learn it needs them.
- **GUI-PRJ-6 (SHOULD)** Project-level settings: default agent runtime (Claude/Codex), default models and reasoning levels, default ticket size policy, QA settings, observability settings, branch conventions.

### 8.2 Instances (parallel Rafi sessions)

- **GUI-INS-1 (MUST)** A project can have **multiple concurrent instances**. Each instance has: a user-editable name/color, the source document(s) or goal, its own plan, tickets, git branch or worktree, configuration overrides, and run history.
- **GUI-INS-2 (MUST)** *Isolation.* Instances must not interfere with each other. Each instance runs in its **own git worktree and/or branch** (per decision). The RFC defines the mechanism, including state/lock separation for `.rafi/` data, ticket stores and the workflow DB, so two instances can never corrupt each other's tickets, plan or build records.
- **GUI-INS-3 (MUST)** *Shared-branch scenario.* The brief's example has several instances contributing to **a single branch**. The RFC must define a safe policy (e.g. serialized ticket execution with a shared branch lock, per-instance worktrees with automatic rebase/merge into the shared branch at ticket boundaries, or a merge-queue approach) and how conflicts surface to the user. Until resolved, the UI must warn when instances are configured to share a branch. 🔶
- **GUI-INS-4 (MUST)** *Branch strategy per instance*, selectable at creation and changeable before the first build:
  - **Single branch** for all work;
  - **Stacked PRs** (one branch/PR per ticket or delivery unit, stacked);
  - **Branch per ticket** (independent) 🔶;
  - Existing-branch attach or new-branch create, with base-branch selection and naming prefix (extends `branch/` modules: `planner`, `prefix`, `finalization`).
- **GUI-INS-5 (MUST)** Branch picker: list local/remote branches, show ahead/behind and dirty state, create new branches from a chosen base, and warn about uncommitted work (matching the existing `--dirty-work preserve` behavior).
- **GUI-INS-6 (MUST)** Instance creation inputs include: source documents (plan files, URLs, text), starting point (idea / rough plan / complete plan / existing tickets), planning mode (e.g. **grill-me** / interview / use plan as-is), **approval mode** (manual / auto-approve plan), **build mode** (do not build / build N steps / build everything in one run), **ticket sourcing** (use tickets linked in the document / have Rafi generate tickets / existing tickets), **ticket size policy** (e.g. all medium, or varied), agent/model overrides, and branch strategy. These are the same options Maestro can set from natural language (§8.7).
- **GUI-INS-7 (MUST)** *Lifecycle states*, visible in one consistent vocabulary: Draft → Planning → Awaiting plan approval → Ticketing → Ready → Building → QA → Awaiting you → Paused → Failed / Recovering → Complete → Archived. The RFC maps these to underlying Rafi states.
- **GUI-INS-8 (MUST)** Instance actions: create, duplicate (clone config), rename, start, pause, resume, stop, restart/reset (tickets, plan, or both, with preview), archive, delete (with confirm and what-will-be-removed list).
- **GUI-INS-9 (SHOULD)** Instance templates / saved launch recipes (e.g. "Plan → auto-approve → build all"). 🔶
- **GUI-INS-10 (SHOULD)** A configurable cap on concurrent instances and concurrent agent sessions per project and per user/org, to respect provider rate limits and budgets, with queueing when exceeded. 🔶

### 8.3 Live visualization and agents

- **GUI-VIS-1 (MUST)** *Always-visible agent status.* For each visible instance, show **every agent currently running** with: role, runtime and model, the human-readable current activity (e.g. "Running tests for T-014", "Reviewing diff"), ticket/delivery-unit, phase, **elapsed time** in the current activity and total working time, and a liveness indicator.
- **GUI-VIS-2 (MUST)** *Liveness honesty.* Distinguish clearly between **working** (recent semantic progress), **active but quiet** (signals, no useful progress, using `lastSignalAt` / `lastSemanticProgressAt`), **waiting on tool / waiting on provider (retry/backoff)**, **waiting on you**, and **stalled / suspected hung**. The UI must never show a spinner that implies progress it cannot verify. This mirrors existing stall and quiet-warning concepts in `ActivityReporter`.
- **GUI-VIS-3 (MUST)** *Pipeline view.* A visual of the instance workflow (plan → tickets → build → QA → done) with the current position highlighted, per-ticket status and progress, retries / QA failures / fix loops, and what is blocking.
- **GUI-VIS-4 (MUST)** *Agent detail on hover or click.* Hover shows a rich preview card; click opens a detail panel with: live activity stream (text and tool calls, collapsible), current ticket and its acceptance criteria, files touched, commands run and their results, token/cost so far, timing breakdown (from spans), session id and runtime, error/retry history.
- **GUI-VIS-5 (MUST)** *Agent actions* (in the detail panel and a context menu): view and **toggle model** (and reasoning level / fast mode where supported) with clear scope ("this agent now", "this instance from next turn", "project default"); pause/stop/restart the agent's current operation where safe; **message the agent**; open its transcript; copy session id; jump to its ticket.
- **GUI-VIS-6 (MUST)** *Talking to an agent.* Two modes: 
  1. **Steer**: queue a message delivered at the next safe point (analogous to operator notes today), clearly shown as pending → delivered → acknowledged.
  2. **Side question ("btw")**: ask the agent a question *without interrupting or polluting its main task*, using Claude Code's `/btw`-style side-question mechanism or an equivalent (e.g. a forked read-only session with the agent's context) when the runtime supports it. If the runtime lacks it, fall back gracefully and say which mode is in effect. The RFC must investigate what each runtime exposes. 🔶 
  The UI must make it obvious which mode a message will use and what it will do to the agent's work.
- **GUI-VIS-7 (MUST)** *Model toggling safety.* Changing a model mid-run states its consequences (new session? lost continuity? cost change?) before applying, consistent with the existing "fresh provider session, lost continuity" semantics for runtime switches.
- **GUI-VIS-8 (SHOULD)** *Timeline / Gantt* of spans for an instance (builder, QA, manager, waits, retries) with zoom, to find where time went. Backed by `RunSpanV1` timing buckets. 🔶
- **GUI-VIS-9 (SHOULD)** Live cost and token meter per agent / instance / project, with budget thresholds.
- **GUI-VIS-10 (MUST)** *Resilience.* If the browser disconnects, daemon restarts or a runner drops, the UI shows connection state honestly, retains last-known state marked stale, and resyncs on reconnect without a full reload.

### 8.4 Run control

- **GUI-RUN-1 (MUST)** Per instance: **start, pause, stop, resume**. Semantics must be defined precisely in the RFC, including: *pause* (finish or checkpoint the current operation, then hold), *stop* (cancel, preserving evidence), *resume* (continue from durable state; reuses the existing resume / recovery machinery), and *start* (new run with step count or "all").
- **GUI-RUN-2 (MUST)** Controls report outcome and in-between states ("Pausing… waiting for builder to reach a safe point"), never silently ignoring a request. Uncertain dispatch states require reconciliation, as today, and the UI guides the user through them.
- **GUI-RUN-3 (MUST)** Bulk actions across instances (pause all, resume all, stop selected), with confirmation scaled to impact.
- **GUI-RUN-4 (MUST)** Build options exposed with sensible defaults and plain-language help: steps / run-everything, QA on/off, `--builder-network` and approvals (explicit, scoped, never implied by "yes to all"), dirty-work policy, agent choices.
- **GUI-RUN-5 (MUST)** Recovery flows (resume after crash, QA recovery, start-over, reset, doctor) are guided: the UI shows detected state, available options, and the consequence of each before acting.
- **GUI-RUN-6 (SHOULD)** Scheduled or deferred starts ("start when instance 1 finishes", "start at 22:00"). 🔶

### 8.5 Planner view (per instance)

- **GUI-PLN-1 (MUST)** Each instance has a dedicated, **collapsible Planner view** covering planning sessions: interview, plan-doc improvement, **grill-me**, ticket planning (`tickets plan`), plan updates, and plan doctor recovery.
- **GUI-PLN-2 (MUST)** Conversation UI: the planning agent's messages, **structured options rendered as selectable choices** (with recommended option highlighted), free-text answers, ability to chat freely, and clear indication of what the agent is waiting on. Answers preserve decision identity as the underlying system requires.
- **GUI-PLN-3 (MUST)** A live **plan document panel** beside the conversation: the current `rafi-plan.json` rendered readably with change highlighting between revisions, section navigation and approval controls (approve / request changes / reject, with notes).
- **GUI-PLN-4 (MUST)** *Code and reference viewing.* When the agent references files, symbols, lines or diffs, those mentions are links that open a **built-in code viewer** (read-only, syntax highlighted, line-anchored, **diff view** for proposed/actual changes, side-by-side and inline). Each also offers "open in…" hand-offs: **VS Code**, **Codex**, and other configured editors via deep links / CLI. 🔶 (JetBrains, Cursor, Zed as optional configured targets.)
- **GUI-PLN-5 (MUST)** Use a mature open-source library for the viewer/diff. The RFC evaluates candidates (§13.3); selection criteria: syntax highlighting breadth, large-file performance, inline/side-by-side diffs, line decorations/comments, theming, license, maintenance.
- **GUI-PLN-6 (SHOULD)** Inline annotations: the user can select code or a plan passage and send it as context in the next message ("ask about this"). 🔶
- **GUI-PLN-7 (SHOULD)** Planning history: previous sessions, prior plan revisions and the questions/answers that shaped them, resumable via the existing picker concepts.
- **GUI-PLN-8 (MUST)** *Approval modes.* Manual approval (default) and auto-approve (opt-in per instance, visibly flagged on the instance, auditable). A plan awaiting approval raises an attention item.
- **GUI-PLN-9 (SHOULD)** Ticket preview: after ticket planning, show the proposed ticket set (sizes, dependencies, QA depth) for review/edit before approval.

### 8.6 Attention, notifications and the "waiting on you" inbox 🔶

This is the highest-leverage UX element for throughput.

- **GUI-ATT-1 (MUST)** A global **Attention inbox** aggregates everything requiring the user: pending ticket questions, plan approvals, QA recovery decisions, builder approval/network requests, Maestro questions, failures, stalls, budget alerts, completions.
- **GUI-ATT-2 (MUST)** Each item shows: instance, urgency, what's blocked, how long it has been waiting, and an **inline way to resolve it** without leaving the current context (answer, approve, choose option), plus a "go to context" link.
- **GUI-ATT-3 (MUST)** Visual cues (badges on panes, tabs, project switcher, browser tab title/favicon) and optional browser/OS/email/Slack notifications, with per-event preferences and quiet hours.
- **GUI-ATT-4 (SHOULD)** "Next needs me" shortcut that jumps to the oldest/highest-urgency attention item.
- **GUI-ATT-5 (SHOULD)** Digest summaries of what happened while the user was away.

### 8.7 Manager and other Rafi roles

- **GUI-MGR-1 (MUST)** The **Manager** (today `rafi manager`) is visualized and reachable per instance: its current evidence, findings, QA/build status explanation and recommendations, with a chat surface to talk to it. Structured manager outputs render as cards, not raw JSON.
- **GUI-MGR-2 (MUST)** Other Rafi capabilities that are agents or advisors (planner, QA, builder, graph/diagnostics where applicable) are each visible in the instance with the §8.3 detail/actions pattern, and are talk-to-able where meaningful.
- **GUI-MGR-3 (SHOULD)** Manager recommendations that map to actions (e.g. "reset ticket T-12", "resume build") render as one-click buttons that run the same audited action path as manual use.

### 8.8 Maestro (orchestrator)

- **GUI-MAE-1 (MUST)** An **optional** Maestro agent is presented as a panel at the **top of the interface**, with two independent toggles: **on/off** and **expanded/collapsed**. When off, it consumes no resources and no UI beyond its toggle. State persists per user (and per project). Candidate implementation: the Manager role or a dedicated Maestro role/instance; the RFC decides. Name is provisional ("Maestro"); 🔶 alternatives: Conductor, Orchestrator, Coordinator.
- **GUI-MAE-2 (MUST)** *Creation from natural language.* Given a project and instructions, Maestro creates and configures instances, as in the reference example:
  > "I have these 4 plan documents. For plan 1, use the tickets linked in the document and have me review the plan before implementation. For plan 2, have Rafi make tickets from the plan, auto-approve the plan and immediately build everything in one run. For plans 3 and 4, run grill-me from the document; I'll approve the plan manually, and don't start building yet. Plans 1 and 2 use all medium tickets on a single branch. Plans 3 and 4 use stacked PRs with varying ticket sizes."
  → four instances with the corresponding source, ticket sourcing, approval mode, build mode, ticket size policy and branch strategy.
- **GUI-MAE-3 (MUST)** *Plan-then-confirm.* Before executing a multi-instance setup, Maestro presents a structured **launch plan** (a table of instances × settings, flagged risks such as shared-branch conflicts, estimated parallelism and cost) that the user can edit and confirm. Autonomy level is a setting: *always confirm*, *confirm destructive/expensive only*, *act freely within budget*. Default: always confirm for creation, confirm destructive operations. 🔶
- **GUI-MAE-4 (MUST)** *Operate running instances.* Maestro can do anything the user can do through the API/GUI, for example "auto-approve instance 1", "stop instance 3", "reset all tickets and plans on instance 4", "switch instance 2's builder to Codex", "answer that question with option B". It resolves references (names, numbers, "the grill-me ones") and states ambiguity back to the user instead of guessing on destructive actions.
- **GUI-MAE-5 (MUST)** *Reporting and comparison.* Maestro reports across instances: status, progress, ETA, cost/tokens, QA pass/fail and retry rates, blockers, time waiting on the user, differences in outcomes, and recommends actions. Reports can be rendered as tables/charts in the panel.
- **GUI-MAE-6 (MUST)** *Same API, same permissions.* Maestro acts only through the public action API with the user's (or a scoped delegated) permissions. Every Maestro action is attributed to Maestro in the audit log, visible in the UI, and reversible where the underlying action is.
- **GUI-MAE-7 (MUST)** *Manual parity.* Everything Maestro can do must be doable manually. Manual actions on instances Maestro controls are respected: Maestro is informed of them and must not silently fight them (e.g. user pauses instance 3 → Maestro does not resume it without being asked). 🔶 Include an explicit **"take over / hand back"** control per instance.
- **GUI-MAE-8 (SHOULD)** *Standing instructions / policies*: "whenever an instance finishes planning, notify me", "auto-answer low-risk questions in instances 1 and 2", "stop anything over $X". Policies are visible, editable and revocable. 🔶
- **GUI-MAE-9 (MUST)** *Guardrails.* Budget ceilings, an allowlist of actions, rate limits on actions, and a kill switch that halts Maestro and optionally all instances. Maestro's own cost is metered and shown.
- **GUI-MAE-10 (SHOULD)** Maestro can also be driven from the CLI/API for headless use. 🔶

### 8.9 Layout, panes and navigation

- **GUI-LAY-1 (MUST)** *Split workspace.* The main visualization area can be split **vertically and horizontally** into resizable panes, each showing a Rafi instance (or another view: planner, tickets, dashboard, agent detail, code). Multiple instances of the same project appear side by side.
- **GUI-LAY-2 (MUST)** Pane operations: split right/down, close, maximize/restore (zoom), swap, drag to rearrange, resize, and per-pane collapse. Layouts are **saved and restorable** (per project; named layouts such as "Monitor all", "Focus on instance 2 + planner"). 🔶
- **GUI-LAY-3 (MUST)** *Density levels* per pane: **glance** (status chip + current activity + timer), **standard**, and **detail**. Narrow panes degrade gracefully (collapse to glance) rather than clip.
- **GUI-LAY-4 (MUST)** *Persistent chrome:* top: Maestro panel (collapsible) and project switcher; side or edge rail: instance list with status and attention badges; global search/command palette; connection status.
- **GUI-LAY-5 (MUST)** Planner view is a collapsible section of each instance pane (and can be popped into its own pane).
- **GUI-LAY-6 (SHOULD)** Auto-layout suggestions: e.g. when 4 instances exist offer a 2×2 grid; when something needs the user, offer to focus it.

### 8.10 Keyboard shortcuts and focus

- **GUI-KEY-1 (MUST)** Keyboard shortcuts move focus to **instances and agents**; shortcuts are **labeled on the page** (visible key hints on panes/agents, toggled by a modifier or always-on setting) and listed in a searchable cheat sheet (`?`).
- **GUI-KEY-2 (MUST)** Scheme (proposal 🔶): `⌘/Ctrl+1…9` focus pane N (or instance N); `Alt+1…9` focus agent N within the focused instance; `⌘/Ctrl+K` command palette; `⌘/Ctrl+\` and `⌘/Ctrl+Shift+\` split; `G` then letter chords for go-to (Vim/Linear style); `.` or Enter opens details; `Esc` closes. Defaults must avoid browser-reserved combos and offer user remapping. The RFC finalizes bindings.
- **GUI-KEY-3 (MUST)** Every mouse-reachable action is keyboard-reachable; the command palette exposes **all** actions (including Maestro-style meta-commands, §8.11).
- **GUI-KEY-4 (MUST)** Focus is always visible, never trapped, and screen-reader-announced (§12.3).

### 8.11 Meta-commands, workflows and enablement

The brief asks for "combos of Rafi steps" and possibly new Rafi features for UI enablement.

- **GUI-META-1 (MUST)** *Compound actions* ("recipes") as buttons and palette commands that execute sequences of Rafi steps with one confirmation, e.g.:
  - *Plan → approve → ticket → build (guided)*
  - *Grill-me → manual approve → tickets, don't build*
  - *Fix and continue* (diagnose, reset failed ticket, resume build)
  - *Pause everything and summarize*
  - *Re-plan from changed document* (`plan update` + ticket reconciliation)
  Each recipe shows its steps, which are skippable/editable, and reports progress as one task with expandable substeps.
- **GUI-META-2 (SHOULD)** User-defined recipes, shareable at project / org level. 🔶
- **GUI-META-3 (MUST)** *New Rafi runtime features expected to support the GUI* (to be ticketed separately; listed here as requirements discovery):
  - a daemon with an action/event API (§7.1);
  - pause/steer/safe-point semantics for agents (§8.3, §8.4);
  - side-question channel to agents (§8.3);
  - multi-instance isolation + locking (§8.2);
  - structured, machine-readable "what are you waiting for" decisions for every human-input point (§8.6);
  - stable instance/agent identifiers and an event schema (§13.1);
  - a project-launch API accepting declarative instance specs (also used by Maestro) (§8.8);
  - cost/token capture normalized across Claude and Codex (§8.12).
- **GUI-META-4 (SHOULD)** *Best-practice guidance in context.* Contextual tips and defaults reflecting Rafi best practices (e.g. suggest QA preparation depth, warn when a plan is vague, suggest splitting an oversized ticket, flag risky combos like auto-approve + build-all + network enabled). Tips are dismissible, non-modal and never block work.
- **GUI-META-5 (SHOULD)** Guided first-run and "what do I do next?" prompt that always shows the single recommended next action for an instance (derived from state). 🔶

### 8.12 Data dashboard (usage, performance, spend, history)

- **GUI-DASH-1 (MUST)** A dashboard at instance, project and (hosted) org level showing: runs and tickets over time, **duration / speed** (cycle time per ticket, queue vs active vs waiting, time on the user), **spend** (tokens and cost by agent role, model, runtime, ticket, instance), **quality** (QA first-pass rate, remediation cycles, retries, failures, recovery events), and **throughput** (tickets completed per day, parallelism achieved).
- **GUI-DASH-2 (MUST)** Historical views with date ranges, comparison between instances/runs/periods, drill-down from aggregate to run to span, and cohort baselines (building on `RunRollupV1.comparisons` percentiles).
- **GUI-DASH-3 (MUST)** Cost accuracy rules: distinguish measured vs estimated numbers; show currency, pricing source and model; never present estimated cost as billed cost. Subscription-based usage (no per-token charge) is shown as usage, with optional equivalent-cost estimates. 🔶
- **GUI-DASH-4 (SHOULD)** Budgets and alerts (per instance, project, user, org), forecast to completion, anomaly highlights ("this ticket used 6× the median").
- **GUI-DASH-5 (SHOULD)** Export (CSV / JSON) and an API for external BI.
- **GUI-DASH-6 (MUST)** Visualization follows a consistent, accessible design system (see `dataviz` guidance: colorblind-safe palette, direct labeling, light/dark parity).
- **GUI-DASH-7 (MAY)** Insights engine: "your slowest step is QA retries on migrations tickets; try Extensive prep". 🔶

### 8.13 Enterprise tier

Fully specified now, phased later (§17). Requirements below are the baseline; the RFC may refine.

- **GUI-ENT-1 (MUST)** *Identity:* SSO via SAML/OIDC, SCIM user provisioning 🔶, MFA enforcement through the IdP, domain verification.
- **GUI-ENT-2 (MUST)** *Authorization:* organizations → teams → projects, with roles (e.g. Owner, Admin, Operator, Reviewer, Viewer) and fine-grained permissions for dangerous actions (start builds, enable network, auto-approve, delete, change budgets, manage runners). Per-project and per-instance overrides.
- **GUI-ENT-3 (MUST)** *Governance policies:* org-enforced settings such as allowed runtimes/models, mandatory manual plan approval, disable auto-approve, disable builder network, required QA, max concurrency, max spend, allowed repos/hosts. Policies show who set them and cannot be bypassed by Maestro.
- **GUI-ENT-4 (MUST)** *Audit log:* immutable, searchable, exportable record of who/what (user, Maestro, CLI, API token) did what, when, to which instance, with before/after where applicable; streaming to SIEM.
- **GUI-ENT-5 (MUST)** *Central aggregation:* org-wide dashboards (§8.12), cross-project reporting, chargeback tags (team / cost center). Raw code and transcripts remain on runners unless the org opts in (GUI-REM-2).
- **GUI-ENT-6 (MUST)** *Runner management:* register, group, drain and revoke runners; health, version, capacity; runner pools with labels; self-hosted (customer VPC) and managed options.
- **GUI-ENT-7 (SHOULD)** Data retention and residency controls, secrets integration (Vault, cloud KMS), private networking, and org-level API tokens/service accounts. 🔶
- **GUI-ENT-8 (SHOULD)** Compliance posture: data-flow documentation and controls that support SOC 2 style reviews. 🔶

### 8.14 Collaboration (hosted) 🔶

- **GUI-COL-1 (SHOULD)** Multiple users may watch the same instance live with presence indicators; exactly one "driver" at a time may send steer messages or control actions by default, with clear takeover.
- **GUI-COL-2 (SHOULD)** Shareable deep links to an instance, ticket, plan revision, or code location (subject to permissions). Comments on plan sections and tickets for reviewers.

## 9. Information architecture and layout (starting proposal 🔶)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ [Project ▾]  ⌘K Search/commands    ⚑ Attention (3)    $ today   ● connected  👤 │
├───────────────────────────────────────────────────────────────────────────────┤
│ ▼ MAESTRO   [on ◉] [open ▾]   "stop instance 3" ……………………………   (collapsible)  │
├────────┬──────────────────────────────────────────────────────────────────────┤
│Instances│ ┌────────────── Instance 1 ───────────┐ ┌──────── Instance 2 ───────┐ │
│ ● 1 Auth│ │ Pipeline: plan▸tickets▸[build]▸QA   │ │ Planner (grill-me)  ▾     │ │
│ ● 2 API │ │ Agents:                              │ │ Q: Which auth flow…?      │ │
│ ◐ 3 UI ⚑│ │  Builder  codex  "T-14 tests" 04:12 │ │  ( ) A  (●) B  ( ) C      │ │
│ ○ 4 Docs│ │  QA       claude idle                │ │  [type reply…]            │ │
│         │ │ Tickets: ▓▓▓▓▓░░ 9/14   $3.20       │ │ Plan doc │ Code │ Diff    │ │
│ + New   │ └─────────────────────────────────────┘ └───────────────────────────┘ │
│ Layouts │ ┌──────── Instance 3 ─────────────────┐ ┌─ Dashboard / Agent detail ─┐ │
│ Dash    │ │ ⚑ Awaiting plan approval (12m)      │ │ …                          │ │
└────────┴──────────────────────────────────────────────────────────────────────┘
```

Layout principles:
1. **Glanceable first, detail on demand.** The default pane answers "is it OK, what is it doing, does it need me?" in one look.
2. **Attention over decoration.** Color and motion are reserved for state changes and things needing the user. Idle things are quiet.
3. **One place for each thing.** Each concept (agent, ticket, plan, question) has one canonical detail view, reachable from anywhere.
4. **Never lose context.** Resolve questions inline; open details in side panels/drawers rather than navigating away.
5. **Reversible and previewed.** Destructive or expensive actions state their effects, can be undone or cancelled where possible.
6. **Progressive disclosure for newcomers.** A simple default view with guided flow; power features (splits, Maestro, recipes) discoverable but not required.
7. **Information scent for time.** Always-visible elapsed times, ETAs where defensible, "waiting on you for N min".

## 10. Key user journeys (acceptance scenarios)

1. **First run (local).** User runs `rafi ui` → browser opens, token-authenticated → picks a local repo → "Set up Rafi" wizard → planner view with interview → approves plan → tickets generated and previewed → clicks **Build** → sees agents, timers, and tickets completing.
2. **Remote repo.** User connects GitHub, picks a repo, chooses a runner; repo is cloned; creates instance on new branch `rafi/feature-x`; plans; builds; opens a PR at finalization.
3. **Four-plan Maestro scenario (reference).** Maestro on; user selects repo; enters the instruction in §8.8; Maestro proposes a launch table; user adjusts one setting and confirms; four instances appear (2 building, 2 in grill-me awaiting answers); attention inbox shows 2 questions; the user answers them inline; says "approve plan on 3 and start building 3"; later "give me a comparison"; gets a table/chart.
4. **Mid-build steering.** The builder on instance 2 is going down the wrong path. User hovers the agent, sees what it is doing, sends a steer message, then asks a side question with btw; toggles QA's model to a cheaper one from next turn.
5. **Failure and recovery.** A build stalls; stall banner appears with cause and options; user clicks the recommended recovery; sees the preview ("will reset T-9, keep evidence, resume") and confirms.
6. **Plan review with code.** The planner references `src/auth/session.ts:40-88`; user clicks, sees syntax-highlighted code with a diff against the proposed change, opens the file in VS Code, returns, selects option B.
7. **Pause the world.** Cost alarm fires; user (or Maestro) pauses all instances; reviews dashboard; resumes selectively.
8. **Reviewer, hosted.** A tech lead with Reviewer role opens a shared link to a plan, reads the diff, comments, and cannot start builds.

## 11. Rafi platform requirements implied (feeds the RFC)

| ID | Requirement | Notes |
|---|---|---|
| GUI-PLT-1 | **Daemon** that owns instances/runs, survives terminal/browser exit, supports multi-client | Foundation for everything |
| GUI-PLT-2 | **Unified event stream**: typed, versioned, ordered per instance, replayable by cursor; covers agent activity, tool calls, status, questions, approvals, cost, timing | Extends `BuilderEvent`, observability spans |
| GUI-PLT-3 | **Command/action API** with idempotency keys, async operations with progress, structured errors, and the same validation as the CLI | Also Maestro's tool surface |
| GUI-PLT-4 | **Safe-point pause/steer** semantics in the builder/QA/manager loops | Needs investigation in `ai-foreman` |
| GUI-PLT-5 | **Instance abstraction** with isolated state and worktree/branch management | Today's model is one build per checkout |
| GUI-PLT-6 | **Pending-decision registry**: every human-input point is a first-class record with type, options, context, urgency, timestamps | Builds on durable waiting records |
| GUI-PLT-7 | **Cost/usage normalization** for Claude and Codex, including subscription vs API billing | |
| GUI-PLT-8 | **Runner protocol** for remote execution, workspace provisioning, heartbeat, upgrade | |
| GUI-PLT-9 | **Declarative instance spec** used by UI, API, CLI and Maestro | `rafi up spec.yaml` becomes natural |
| GUI-PLT-10 | **Permission/policy engine** shared by UI, API and Maestro | Hosted/enterprise |
| GUI-PLT-11 | **Schema-first contracts** in `rafi-spec` with compatibility testing between daemon, CLI and UI versions | |

## 12. Non-functional requirements

### 12.1 Performance
- **GUI-NFR-1** First meaningful render ≤ 2 s on a typical laptop (local mode). Live updates for ≥ 8 instances at p95 ≤ 500 ms event-to-screen (local) / ≤ 1.5 s (hosted).
- **GUI-NFR-2** Activity streams are virtualized and bounded: long transcripts, thousands of events and large diffs must not degrade UI responsiveness. Backpressure and coalescing are required (e.g. collapse repetitive progress events).
- **GUI-NFR-3** Idle cost: the GUI with a quiescent daemon must not busy-poll; background tabs throttle updates.

### 12.2 Reliability
- Daemon crash/restart recovers instances from durable state using the existing recovery machinery; no run silently lost; UI reflects "recovering" explicitly.
- Event delivery is at-least-once with idempotent client handling.

### 12.3 Accessibility
- WCAG 2.2 AA target: full keyboard operation, visible focus, ARIA landmarks/live regions for status changes (politely announced), no color-only status (icon + text + color), reduced-motion support, sufficient contrast in light and dark, zoom to 200%.

### 12.4 Security and privacy
- Threat model required in the RFC, covering: remote code execution via agents, prompt injection from repo content/tickets reaching Maestro (**Maestro must treat repo/document content as untrusted data, never as instructions to take privileged actions**), token leakage, cross-tenant leakage, malicious runners, CSRF/DNS-rebinding on the local server, XSS from agent-produced markdown/HTML (strict sanitization; never render agent output as trusted HTML), and path traversal in the file viewer.
- Secrets are redacted in streamed output and logs where detectable; secrets never rendered in the UI.
- Dangerous capabilities (network access for builders, auto-approve, build-all) require explicit, scoped, visible opt-in and are audited.
- Principle of least privilege for git tokens and runner credentials.

### 12.5 Responsive and cross-device
- Desktop-first (≥ 1280 px). Tablet and phone layouts provide: attention inbox, approve/answer, status glance, pause/stop. Complex split layouts collapse to a single-pane stack on narrow screens. 🔶

### 12.6 Compatibility and rollout
- Evergreen browsers (Chromium, Firefox, Safari latest two versions). Node 24 for daemon (matches repo `engines`). macOS, Linux, Windows/WSL for local mode.
- Feature flags and a versioned API allow staged rollout; CLI/daemon/UI version skew is detected and explained.
- Internationalization-ready strings (English first). 🔶

### 12.7 Observability of the GUI itself
- Client and server errors are captured (opt-in telemetry in local mode, with a clear privacy statement); a built-in "diagnostics bundle" for support, consistent with the project's existing diagnostics modules.

## 13. Technical considerations (for the RFC; not decisions)

### 13.1 Event and data model
Define canonical entities: Project, Instance, Run, Agent (role stream), Ticket, DeliveryUnit, Plan, PlanRevision, Decision (pending question/approval), Message (steer / side-question / chat), Span, Usage, Policy, AuditEvent, Runner. Reuse `rafi-spec` types where they exist (`RunCurrentStateV1`, `RunSpanV1`, `RunRollupV1`). Decide per entity: source of truth (workflow DB, `tickets.yaml`, observability DB, or new daemon store) and how external edits (CLI, git, hand-edited `tickets.yaml`) are detected and reconciled.

### 13.2 Transport and API
REST/JSON (or RPC) for commands/queries; SSE or WebSocket for events; OpenAPI or schema-derived types; auth tokens for local mode; OIDC for hosted. Consider exposing an **MCP server** surface so Maestro and external agents can use the same tools. 🔶

### 13.3 Frontend candidates (to be validated; check current maintenance and licenses before choosing)
| Need | Candidates |
|---|---|
| App framework | React + TypeScript with Vite; or Next.js if SSR is needed for hosted mode |
| Dockable / splittable panes | dockview, FlexLayout, react-mosaic, allotment (simple splits); golden-layout |
| Code viewer / diff | Monaco Editor (incl. diff editor), CodeMirror 6 (+ merge extension), `react-diff-view`, `@git-diff-view/react`, `diff2html`; Shiki for highlighting |
| State and data | TanStack Query + a small store (Zustand); event reducer pattern for streams |
| UI primitives | Radix UI / shadcn-ui or React Aria for accessible primitives; cmdk for the palette |
| Charts | Observable Plot, visx, ECharts or Recharts, subject to the `dataviz` design rules |
| Virtualization | TanStack Virtual / react-virtuoso |
| Terminal-like output | xterm.js for raw command output panes |
| Testing | Playwright for e2e and visual regression; Storybook for components; axe for a11y |

### 13.4 Agent control
Investigate per runtime what is possible: Claude Agent SDK (streaming input, interrupts, `/btw`-style side questions, model switching, session fork/resume), Codex equivalents (app-server / exec resume, model flags). Document capability differences and how the UI reflects them (feature-detected controls, disabled with explanation, never silently ignored).

## 14. Design direction and inspiration research

The brief asks for help researching what to take design inspiration from. Below is a starting map. 🔶 The next step is a dedicated research pass (screenshots, teardown notes, and a moodboard) before visual design begins.

| Reference | What to study |
|---|---|
| **Linear** | Density with calm; keyboard-first; command palette; status vocabulary; inbox; motion restraint |
| **Vercel dashboard / Deployments** | Build status, logs, instant feedback, clean typography, project switcher |
| **GitHub Actions run view** | Pipeline/job graph, step logs with collapsible sections, re-run controls |
| **Buildkite, CircleCI, Temporal UI** | Live pipelines/workflows, timelines, retries, event histories, "what is it waiting on" |
| **Cursor, Zed, VS Code, Warp** | Agent panes, diff review, chat + code, command palette, split layouts, multi-agent UIs (e.g. Cursor background agents, Claude Code on the web, Codex cloud tasks, Devin, Conductor-style parallel agent managers) |
| **Datadog / Grafana / Honeycomb** | Dashboards, trace/span waterfalls, time-range controls, drill-down |
| **Raycast / Superhuman** | Palette UX, shortcut hints, speed as a feature |
| **Figma / Notion / Arc** | Presence, split views, side-by-side focus, progressive disclosure |
| **tmux / i3 / iTerm** | Pane management mental models and shortcuts power users already know |
| **Stripe dashboard / Plaid** | Professional enterprise polish; data tables; permissions UX |
| **Atlassian/Radix/Primer/Polaris design systems** | Component and accessibility conventions, status/feedback patterns |

Design deliverables to commission: moodboard and principles; design tokens (color, type, spacing, elevation, motion); status color/icon system (colorblind-safe); component library; key-screen mockups for §10 journeys 1, 3, 4 and 6; dark and light themes (dark default likely preferred by this audience 🔶); a "calm monitoring" mode for long runs.

## 15. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Multi-instance on one repo causes state or git corruption | Data loss, trust loss | Worktree/branch isolation, locks, strict invariants, chaos tests (GUI-INS-2/3) |
| Shared-branch scenario produces conflicts or interleaved commits | Failed builds | Defined policy, warnings, serialized merge points |
| Daemon refactor is large and risks regressing reliability work (recent QA/recovery investments) | Delays, regressions | Incremental extraction; contract tests (`test:comms-preflight` style); CLI parity tests |
| Provider limits (rate, cost) hit by parallelism | Stalls, bills | Concurrency caps, queueing, budgets, visible cost |
| Runtime capability gaps (btw, mid-run model switch, safe-point pause) | Promised features can't be delivered uniformly | Early spike (§17 Phase 0); graceful degradation with honest UI |
| Maestro takes harmful or mistaken actions, or is prompt-injected | Destructive outcomes | Confirm plans, guardrails, least privilege, treat content as data, audit, kill switch |
| Remote execution security | Severe | Threat model, isolation, scoped credentials, outbound-only runners |
| Scope too large for a single release | Slips | Phasing (§17) |
| UI misleads about liveness | Eroded trust | GUI-VIS-2 honesty rules; stale marking |
| Enterprise needs distract early product | Focus loss | Specify now, build late; architect tenancy/policy seams early |

## 16. Open questions

1. **Shared-branch policy** (GUI-INS-3): serialize, per-instance worktree + rebase, or merge queue? Does the user expect truly concurrent building on one branch?
2. **Maestro implementation:** is it the existing Manager extended, a new role, or a user-selectable instance? Which model/runtime should it run on by default, and who pays for it?
3. **Side-question ("btw") reality check:** what does each runtime expose today? Is a forked read-only session acceptable as a fallback?
4. **Hosted architecture:** managed runners (who operates them?), or only customer-owned runners at first? Is a SaaS control plane planned, or self-hosted enterprise only?
5. **Pricing/packaging:** which features are Free / Pro / Enterprise? Is the dashboard basic tier free?
6. **Provider auth in hosted mode:** per-user subscription logins on runners vs org API keys; implications for ToS and billing.
7. **Authoring of source documents in the GUI:** is an in-app Markdown editor for plan docs in scope, or only import?
8. **Ticket editing depth:** full ticket editing in the GUI, or view + action only?
9. **Bring-your-own editor links:** which editors must be first-class beyond VS Code and Codex?
10. **Offline/local-only guarantee:** must local mode work with no network beyond the providers?
11. **Naming:** "Maestro" vs "Conductor" vs "Orchestrator"; and product name for the GUI.
12. **Target scale:** realistic max instances per project/user/org to design against.
13. **Telemetry:** acceptable defaults for product analytics.
14. **Mobile:** is a monitor-and-approve phone experience a v1 or v2 need?
15. **Migration:** how do existing `.rafi/` projects and in-flight builds migrate into the daemon model?

## 17. Recommended phasing 🔶

| Phase | Theme | Contents |
|---|---|---|
| **0 — Discovery** | De-risk | Runtime capability spikes (pause/steer/btw/model switch); worktree-isolation prototype; event-stream prototype from existing observability data; design research + moodboard; threat model draft; RFC |
| **1 — Foundation + Observe** | Local daemon + read-only live view | Daemon/API/event stream; `rafi ui` local mode; project open/switch; single-instance live visualization (agents, timers, pipeline, tickets); attention inbox (read + answer); basic run control (start/pause/stop/resume); design system |
| **2 — Operate** | Full lifecycle | Create → plan → ticket → build in GUI; planner view with options, plan panel, code/diff viewer; manager chat; model toggle, steer messages; branch selection/creation; recovery flows; parity matrix complete for in-scope commands |
| **3 — Parallel** | Multi-instance | Instance isolation; split panes + saved layouts; shortcuts and labels; command palette; recipes; bulk controls; GitHub/GitLab project connect |
| **4 — Maestro** | Orchestration | Maestro panel, launch-plan confirm flow, operate/report/compare, guardrails, policies, take-over/hand-back |
| **5 — Insight** | Dashboard | Usage/speed/spend/quality dashboards, history, budgets, export |
| **6 — Hosted & Enterprise** | Remote + governance | Control plane, runners, SSO, RBAC, policies, audit, org dashboards, collaboration |

Rationale: Phase 1 delivers the largest user value (seeing what is happening) on top of data that mostly exists; Phases 3–4 are the differentiators; Phase 6 needs seams (identity, tenancy, policy) designed in from Phase 0 even though built last. Remote mode is the user's stated target platform, so the Phase 0 RFC must design the runner/control-plane split now, even if local mode ships first. If hosted must come earlier, Phase 6 can be partially pulled forward in parallel with Phases 3–5.

## 18. Out of scope for this document
Detailed API schemas; database design; visual mockups; exact keyboard map; pricing; implementation tickets. These follow from the RFC and design phases.

## 19. Next steps
1. Review this PRD; resolve or assign §16 open questions (especially 1, 2, 3, 4).
2. Run Phase 0 spikes and the design-inspiration research pass.
3. Write the **RFC / technical design** (daemon, event model, instance isolation, runner protocol, security) referencing these requirement IDs.
4. Convert accepted requirements into Rafi tickets per phase (`rafi tickets plan`).
5. Complete the parity matrix (§7.3) against the full CLI command tree.

## Appendix A — Requirement index by area
Platform `GUI-PLAT`, Remote `GUI-REM`, Parity `GUI-PAR`, Projects `GUI-PRJ`, Instances `GUI-INS`, Visualization `GUI-VIS`, Run control `GUI-RUN`, Planner `GUI-PLN`, Attention `GUI-ATT`, Manager `GUI-MGR`, Maestro `GUI-MAE`, Layout `GUI-LAY`, Keyboard `GUI-KEY`, Meta/enablement `GUI-META`, Dashboard `GUI-DASH`, Enterprise `GUI-ENT`, Collaboration `GUI-COL`, Platform implications `GUI-PLT`, Non-functional `GUI-NFR`.

## Appendix B — Reference scenario as a declarative spec 🔶
Illustrative shape of the instance spec Maestro (or `rafi up`) would consume for the four-plan example:

```yaml
project: github:acme/webapp
instances:
  - name: plan-1
    source: docs/plan-1.md
    tickets: from-document        # use tickets linked in the document
    plan_approval: manual         # user reviews before implementation
    build: after-approval
    ticket_size: medium
    branch: { strategy: single, name: rafi/plans-1-2 }
  - name: plan-2
    source: docs/plan-2.md
    tickets: generate
    plan_approval: auto
    build: all-in-one-run
    ticket_size: medium
    branch: { strategy: single, name: rafi/plans-1-2 }   # shared with plan-1 → GUI-INS-3 warning
  - name: plan-3
    source: docs/plan-3.md
    planning: grill-me
    plan_approval: manual
    build: none
    ticket_size: varied
    branch: { strategy: stacked-prs }
  - name: plan-4
    source: docs/plan-4.md
    planning: grill-me
    plan_approval: manual
    build: none
    ticket_size: varied
    branch: { strategy: stacked-prs }
```
