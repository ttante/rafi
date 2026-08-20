# Changelog

All notable user-facing, API, migration, security, AI/model, and operational changes are documented here.

This project follows semantic versioning for published npm packages where practical. Entries before formal GitHub Releases are reconstructed from git history because the repository has no release tags yet.

## @rafi-ai/cli 0.8.3 / ai-foreman 1.6.2 - 2026-08-20

### Fixed

- Independent QA no longer reports Foreman's own `.foreman` runtime logs or `.rafi/cache` state as protected project-file changes, preventing false `needs-human` outcomes after otherwise successful work.
- Interrupted Rafi runs now print the single canonical recovery command, `rafi build:resume <project>`, instead of an incomplete or confusing low-level `start --resume` hint. Standalone Foreman prints its complete `ai-foreman start <project> --steps <remaining> --resume <sessionId>` command when a provider session is available, and successful runs no longer print unnecessary resume guidance.

### Packages

- Bumped `@rafi-ai/cli` to `0.8.3` and `ai-foreman` to `1.6.2`. `special-agents` and `rafi-spec` remain at `0.7.0`.

## @rafi-ai/cli 0.8.2 / ai-foreman 1.6.1 - 2026-08-20

### Fixed

- Claude runs now use the exact system `claude` executable that passed Rafi's readiness probe instead of the Claude Agent SDK's bundled executable. This preserves enterprise Claude Code authentication, including organization-managed SSO flows such as `/login-okta`.
- Claude SDK sessions now load user, project, and local settings in addition to always-applied managed policy, so organization proxy, certificate, and policy configuration is not accidentally excluded when Rafi enables skills.
- `rafi create` no longer installs `@anthropic-ai/claude-agent-sdk` into the target application. The SDK wrapper is owned and resolved by `ai-foreman`, where it is declared as an optional dependency.
- Claude failures now retain structured authentication, authorization, network, rate-limit, configuration, and agent-stream diagnostics instead of collapsing distinct failures into an unhelpful `API Error` or generic login claim.
- Interactive structured turn failures offer retry, a verified fresh-session provider switch, or cancellation while preserving project state; resume flows never switch providers because session IDs are provider-specific.
- Start preflight and preflight-feedback errors now stop with the complete diagnostic rather than displaying an error result as a proposed implementation plan.

### Added

- `rafi doctor --live-claude` / `ai-foreman doctor --live-claude` runs an explicit, bounded, no-tools SDK-path smoke test and reports the exact executable, setting sources, and relevant environment-variable names. The live check uses account quota and remains opt-in.

### Packages

- Bumped `@rafi-ai/cli` to `0.8.2` and `ai-foreman` to `1.6.1`. `special-agents` and `rafi-spec` remain at `0.7.0`.

## @rafi-ai/cli 0.8.1 / ai-foreman 1.6.0 / special-agents 0.7.0 / rafi-spec 0.7.0 - 2026-08-19

### Added

- Added a checkpointed, in-process create journey with explicit standard/exhaustive planning, lifecycle gates, V2 interview state, drift-aware recovery, and clear paused outcomes.
- Added shared bounded runtime probing and sanitized failure classification, persistent per-role agent defaults, an authoritative five-role registry, and independent run-wide QA sessions.
- Added durable build-run records, leases, session checkpoints, idempotent operation receipts, `rafi build:resume`, and recoverable-run status reporting.
- Added ownership provenance and the preview-first, transaction-journaled `rafi uninstall` interview, including a constrained read-only uninstaller role for nonblank special instructions.
- Added deterministic Commander-to-`docs/cli.md` generation and drift checking.

### Changed

- `rafi plan` is initialization-only and defaults to standard planning; `rafi tickets plan` is the fully initialized later-work workflow.
- Runtime/provider switches during recovery are explicit fresh sessions and report lost conversational continuity.
- Builder and QA settings/session IDs are resolved and persisted independently.

### Packages

- Bumped `@rafi-ai/cli` to `0.8.1`, `ai-foreman` to `1.6.0`, `special-agents` to `0.7.0`, and `rafi-spec` to `0.7.0`.

## @rafi-ai/cli 0.8.0 / ai-foreman 1.5.0 / special-agents 0.6.0 / rafi-spec 0.6.0 - 2026-08-06

### Added

- Added durable local interview records and `rafi resume [project]` for interactive create, plan, and ticket-setup journeys. Records preserve saved answers, checkpoints, redacted failure context, runtime/session metadata, and output fingerprints under ignored `.rafi/interviews/` state.
- Added `planning.sources` to `rafi-config.yaml`. Create persists planning hints, plan consumes them unless `--sources` is explicit, and ticket setup uses them only as a local-source prefill.
- Added planner runtime/session metadata to agent-run logs and output-drift detection before resumable plan writes.
- Added a documented, explicit `test:live-interview` release-candidate acceptance script and React/FastAPI/PostgreSQL fixture.

### Changed

- Refreshed the published CLI README and npm description around the interview-led workflow, AI-application guidance, resume behavior, and the complete manual command reference.

### Packages

- Bumped `@rafi-ai/cli` to `0.8.0`.
- Bumped `ai-foreman` to `1.5.0`.
- Bumped `special-agents` to `0.6.0` for its updated `rafi-spec` dependency.
- Bumped `rafi-spec` to `0.6.0`.

## @rafi-ai/cli 0.7.0 / ai-foreman 1.4.0 / special-agents 0.5.0 / rafi-spec 0.5.0 - 2026-07-24

### Added

- Added `tickets setup:init`, `tickets setup:update`, and `tickets review` under both `rafi` and `ai-foreman`.
- Added optional top-level `tickets:` setup preferences in `rafi-config.yaml` for ordered sources, populate defaults, and branch/build completion defaults.
- Added native Linear and Jira Cloud ticket imports with ignored `.tickets/imports/` snapshots and `external_refs` on imported tickets.
- Added SQLite-backed review recommendations rendered into the ticket progress doc and accepted through deterministic ticket patches.
- Added `start --completion pr|auto-merge|direct-merge|none`, `--provider auto|github|gitlab`, `--no-branch-per-ticket`, `--no-create-pr`, and auto-merge dependency wait overrides.

### Changed

- `tickets populate` now uses explicit `--sources`, then saved setup sources, then the configured Rafi plan; no-source non-interactive runs print next-step options instead of silently scanning.
- `rafi create` now hands off to `rafi plan` and `rafi tickets setup:init` interactively, while defaults/non-interactive runs print next-step commands.
- `rafi plan` includes saved ticket setup preferences in planner instructions when present.

### Packages

- Bumped `@rafi-ai/cli` to `0.7.0`.
- Bumped `ai-foreman` to `1.4.0`.
- Bumped `special-agents` to `0.5.0`.
- Bumped `rafi-spec` to `0.5.0`.

## @rafi-ai/cli 0.6.2 / ai-foreman 1.3.1 - 2026-07-23

### Changed

- Split ticket queue sizing into `implementation_limit` for generated progress docs and Foreman ticket selection, and `view_limit` for the display queue command.
- Added `--implementation-limit` and `--view-limit` to `tickets init`; kept `--queue-limit` as a deprecated alias for the implementation limit.
- Existing tracker configs with `queue_limit` continue to load as the implementation limit, with the old default value `50` upgraded to the new default `500`.

### Packages

- Bumped `ai-foreman` to `1.3.1`.
- Bumped `@rafi-ai/cli` to `0.6.2`.
- Kept `special-agents` at `0.4.0`.
- Kept `rafi-spec` at `0.4.0`.

## @rafi-ai/cli 0.6.1 - 2026-07-21

### Changed

- Updated the README quick-start planning examples to lead with the interactive `rafi plan .` interview, with `--brief` and `--brief-file` documented as optional non-interactive alternatives.

### Packages

- Bumped `@rafi-ai/cli` to `0.6.1`.
- Kept `ai-foreman` at `1.3.0`.
- Kept `special-agents` at `0.4.0`.
- Kept `rafi-spec` at `0.4.0`.

## @rafi-ai/cli 0.6.0 / ai-foreman 1.3.0 - 2026-07-21

### Added

- Added `rafi plan [project]` to run a read-only planning agent from a brief plus repo inspection, using the `planner` role with the `grill-me` skill and writing managed plan history under `<docs.root>/rafi-plans/`.
- Added automated help snapshot coverage for the changed `rafi`, `rafi plan`, and `rafi tickets populate` command surfaces.

### Changed

- `rafi plan` refreshes `<docs.root>/rafi-plan.md` as the latest plan for ticket population.
- `tickets populate` now prefers the configured Rafi `<docs.root>/rafi-plan.md` when no `--sources` are provided, then legacy `project.yaml`, then the ticket progress-doc directory, then `docs/rafi-plan.md`, and runs with the `ticket-maker` role bundle.
- `rafi plan` now treats only `STEP_STATUS: plan_complete` as success and validates required plan sections before writing plan artifacts.
- Read-only planning permissions now allow only fixed inspection-oriented Git commands and escalate write-capable flags such as `--output`, `-o`, `--exec`, and `--format`.
- Codex role runs now flatten requested skill content into the prompt, and planning runs use Codex's read-only sandbox.

### Packages

- Bumped `@rafi-ai/cli` to `0.6.0`.
- Bumped `ai-foreman` to `1.3.0`.
- Kept `special-agents` at `0.4.0`.
- Kept `rafi-spec` at `0.4.0`.

## @rafi-ai/cli 0.5.0 / ai-foreman 1.2.0 - 2026-07-14

### Added

- Added `rafi create --runtime <both|claude|codex>` and an interactive runtime target prompt.
- Added config-derived default runtime selection for `rafi start`, `ai-foreman start`, and `tickets populate` when `--agent` is omitted. A single `harness.targets` value is used; missing config or both targets still default to Claude.
- Added interactive retry-or-switch recovery for Claude/Codex readiness failures, including verified fallback readiness checks and Claude Agent SDK import checks when switching to Claude.

### Changed

- `harness.targets` now controls which native artifacts `rafi compile` emits. Codex targets write `AGENTS.md`, `.codex/agents/*`, and `.agents/skills/*`; Claude targets write `CLAUDE.md`, `.claude/agents/*`, and `.claude/skills/*`; `.rafi/compiled/<role>/*` is always emitted.
- `agent_files.mode: append` now keeps oversized root instruction files within runtime startup guards by moving Rafi-generated guidance into target-specific sidecars (`AGENTS-rafi.md` or `CLAUDE-rafi.md`) and inserting a compact reference block near the top of the root file.
- `rafi create --defaults` keeps both runtime targets unless `--runtime` is supplied.
- Claude Agent SDK installation now runs only when the final create target set includes Claude.
- Runtime cancel prompts now explicitly state that generated files and installed packages are kept in place.
- Runtime fallback during `start` and `tickets populate` is current-run only. Create-time fallback persists the singleton `harness.targets` value to `rafi-config.yaml` and recompiles.

### Fixed

- Existing-artifact validation and collision handling now only consider selected runtime targets.
- Files for unselected runtime targets are preserved instead of being refreshed or deleted.
- Resume/continue flows no longer offer runtime switching because saved session IDs are runtime-specific.
- Provider-specific `--model` overrides are dropped and reported when an interactive command falls back across Claude/Codex providers. `--effort` and `--fast` are preserved.

### Packages

- Bumped `@rafi-ai/cli` to `0.5.0`.
- Bumped `ai-foreman` to `1.2.0`.
- Kept `special-agents` at `0.4.0`.
- Kept `rafi-spec` at `0.4.0`.

## @rafi-ai/cli 0.4.1 - 2026-07-14

### Fixed

- Fixed `rafi create` Claude Agent SDK installation for Yarn modern/Berry workspace roots by omitting Yarn Classic's `-W` flag on Yarn 2+ while preserving the Yarn 1 workspace-root install command.
- Kept Claude Agent SDK install command generation aligned with the selected package manager for npm, pnpm, Yarn Classic, Yarn modern/Berry, and Bun, including versioned package manager strings such as `yarn@4.5.0` and `pnpm@10.2.1`.

### Changed

- Unknown package manager answers still fall back to npm, but the install message now says the fallback is happening.

### Packages

- Bumped `@rafi-ai/cli` to `0.4.1`.
- Kept `ai-foreman` at `1.1.0`.
- Kept `special-agents` at `0.4.0`.
- Kept `rafi-spec` at `0.4.0`.

## @rafi-ai/cli 0.4.0 / ai-foreman 1.1.0 / special-agents 0.4.0 / rafi-spec 0.4.0 - 2026-07-12

### Added

- Added `docs.root` to `rafi-config.yaml` so Rafi starter docs and generated ticket tracker docs can live outside `docs/`.
- Added `rafi create --docs-root <dir>` and `rafi tickets init --docs-root <dir>`.

### Changed

- `rafi create` now keeps existing app-owned `docs/` folders untouched by default, choosing a safe `docs-rafi/` variant when needed.
- Ticket initialization now writes `ticket-progress.md` and `ticket-archive.md` under the configured docs root and refuses to overwrite a pre-existing selected progress doc.
- Rule packs, starter docs, generated root instruction headers, and ticket runtime guidance now render configured docs paths instead of assuming `docs/`.

## @rafi-ai/cli 0.3.11 / ai-foreman 1.0.12 - 2026-07-12

### Added

- Added a root README **All Commands** reference covering every current `rafi` command, ticket subcommand, runtime command, option, default, and standalone `ai-foreman` runtime equivalent.
- Added `docs/cli.md` as a generated Commander help snapshot for `rafi` and standalone `ai-foreman`.
- Documented GitHub PR failure recovery behavior in the standalone `ai-foreman` README.

### Changed

- Expanded the `@rafi-ai/cli` package README with clearer command, ticket lifecycle, root file handling, and runtime option references.
- Updated default runtime permissions to allow `ai-foreman tickets` while keeping the legacy-compatible `foreman tickets` prefix.
- Updated historical/root docs to use the current `ai-foreman` package naming.

### Packages

- Bumped `ai-foreman` to `1.0.12`.
- Bumped `@rafi-ai/cli` to `0.3.11`.
- Kept `special-agents` at `0.3.7`.
- Kept `rafi-spec` at `0.3.7`.

## @rafi-ai/cli 0.3.10 / ai-foreman 1.0.11 - 2026-07-09

### Added

- Added branch-per-ticket GitHub PR failure handling that preserves repair commands, command output, and retry guidance through `ai-foreman status`.

### Fixed

- Classified GitHub CLI repository resolution failures separately from DNS and network failures.
- Improved GitHub Enterprise repair guidance with hostname-specific `gh auth` and `gh repo view` commands.
- Converted PR body write failures into structured `pr_create_failed` results so tickets are blocked cleanly and worktrees are retained for retry.

### Packages

- Bumped `ai-foreman` to `1.0.11`.
- Bumped `@rafi-ai/cli` to `0.3.10`.
- Kept `special-agents` at `0.3.7`.
- Kept `rafi-spec` at `0.3.7`.

## @rafi-ai/cli 0.3.9 / ai-foreman 1.0.10 - 2026-07-09

### Added

- Added `--root-file-mode append|overwrite|update` to `rafi create` and `rafi compile` for root instruction file handling.

### Fixed

- Made root file `update` mode fail with actionable Claude/Codex authentication guidance, and let interactive `rafi create` retry or fall back to append/overwrite.
- Added create-time Claude/Codex readiness checks so selected runtimes are authenticated before the walkthrough finishes.
- Added Claude/Codex readiness checks before `rafi start` and `rafi tickets populate`, plus late 401 normalization inside the Claude and Codex adapters.

### Packages

- Bumped `ai-foreman` to `1.0.10`.
- Bumped `@rafi-ai/cli` to `0.3.9`.
- Kept `special-agents` at `0.3.7`.
- Kept `rafi-spec` at `0.3.7`.

## @rafi-ai/cli 0.3.8 / ai-foreman 1.0.9 - 2026-07-08

### Added

- Added `tickets populate --sources <paths...>` source hints for files, folders, and globs. The populate agent still scans relevant planning docs automatically when no hints are provided.

### Changed

- Updated the `rafi create` interview to ask for planning/ticket source files, folders, or globs, and to explain that any reasonable format is OK because an agent interprets the material.
- Updated `rafi create` follow-up instructions to use `rafi tickets populate` or `rafi tickets populate --sources ...` instead of the invalid `--tickets` populate option.

### Fixed

- Fixed `rafi create` Claude Agent SDK installation in pnpm workspace roots by respecting the selected package manager and using workspace-root install flags where needed.

### Packages

- Bumped `ai-foreman` to `1.0.9`.
- Bumped `@rafi-ai/cli` to `0.3.8`.
- Kept `special-agents` at `0.3.7`.
- Kept `rafi-spec` at `0.3.7`.

## @rafi-ai/cli 0.3.7 / special-agents 0.3.7 / ai-foreman 1.0.8 / rafi-spec 0.3.7 - 2026-07-07

### Documentation

- Added Apache-2.0 license files for the repository and publishable packages.
- Added package metadata that points npm users back to `ttante/rafi`.
- Added release and changelog documentation for public release transparency.

### Changed

- Made `rafi-spec` a published dependency package instead of bundling it through pnpm workspace symlinks.

### Packages

- Bumped `rafi-spec` to `0.3.7`.
- Bumped `@rafi-ai/cli` to `0.3.7`.
- Bumped `special-agents` to `0.3.7`.
- Bumped `ai-foreman` to `1.0.8`.

## @rafi-ai/cli 0.3.6 / special-agents 0.3.6 / ai-foreman 1.0.7 - 2026-07-07

### Changed

- Added collision handling and safer overwrite behavior when generated files already exist.
- Added support for user-provided custom skills and subagents through `artifact_source: existing`.
- Added schema, project parsing, compiler, and README coverage for custom skills and subagents.

### Packages

- Bumped `@rafi-ai/cli` to `0.3.6`.
- Bumped `special-agents` to `0.3.6`.
- Kept `ai-foreman` at `1.0.7`.

## @rafi-ai/cli 0.3.5 / special-agents 0.3.5 / ai-foreman 1.0.7 - 2026-06-07

### Changed

- Updated `rafi create` questions to show default values more clearly.

### Packages

- Bumped `@rafi-ai/cli` to `0.3.5`.
- Bumped `special-agents` to `0.3.5`.
- Bumped `ai-foreman` to `1.0.7`.

## @rafi-ai/cli 0.3.4 / special-agents 0.3.4 / ai-foreman 1.0.6 - 2026-06-07

### Changed

- Updated the `rafi create` walkthrough questions and defaults.
- Refined default stack and rule-pack generation behavior.

### Packages

- Bumped `@rafi-ai/cli` to `0.3.4`.
- Bumped `special-agents` to `0.3.4`.
- Bumped `ai-foreman` to `1.0.6`.

## @rafi-ai/cli 0.3.3 / special-agents 0.3.3 / ai-foreman 1.0.5 - 2026-06-07

### Fixed

- Added publish-time coverage to prevent `rafi create` package resolution errors.

### Packages

- Bumped `@rafi-ai/cli` to `0.3.3`.
- Bumped `special-agents` to `0.3.3`.
- Bumped `ai-foreman` to `1.0.5`.

## @rafi-ai/cli 0.3.2 / special-agents 0.3.2 / ai-foreman 1.0.4 - 2026-06-06

### Changed

- Made AI rule packs enabled by default unless users opt out.

### Packages

- Bumped `@rafi-ai/cli` to `0.3.2`.
- Bumped `special-agents` to `0.3.2`.
- Bumped `ai-foreman` to `1.0.4`.

## @rafi-ai/cli 0.3.1 / special-agents 0.3.1 / ai-foreman 1.0.3 - 2026-06-06

### Added

- Added AI batch testing guidance and generated AI documentation templates.
- Added the AI batch testing rule pack and included it in builder composition.

### Packages

- Bumped `@rafi-ai/cli` to `0.3.1`.
- Bumped `special-agents` to `0.3.1`.
- Bumped `ai-foreman` to `1.0.3`.

## @rafi-ai/cli 0.3.0 / special-agents 0.3.0 / ai-foreman 1.0.2 - 2026-06-06

### Packages

- Bumped `@rafi-ai/cli` to `0.3.0`.
- Bumped `special-agents` to `0.3.0`.
- Bumped `ai-foreman` to `1.0.2`.

## @rafi-ai/cli 0.2.0 / special-agents 0.2.0 / ai-foreman 1.0.1 - 2026-06-03

### Added

- Added dynamic Claude Agent SDK loading so Claude support is optional at runtime.
- Added standalone `ai-foreman` subcommand modules for `start`, `status`, and `doctor`.
- Exposed `ai-foreman` commands through the `rafi` CLI package.
- Added `.npmrc` configuration for the workspace node linker.

### Changed

- Normalized project configuration around `rafi-config.yaml`, with migration support for legacy `project.yaml`.
- Updated root and package READMEs for the `rafi` command surface.

### Packages

- Bumped `@rafi-ai/cli` to `0.2.0`.
- Bumped `special-agents` to `0.2.0`.
- Bumped `ai-foreman` to `1.0.1`.

## @rafi-ai/cli 0.1.0 / special-agents 0.1.0 / ai-foreman 1.0.0 - 2026-06-03

### Added

- Added the Rafi monorepo with `@rafi-ai/cli`, `special-agents`, `ai-foreman`, and `rafi-spec`.
- Added `rafi create` and `rafi compile` for generating agent harness files from stack answers.
- Added Codex and Claude project artifacts, role bundles, rule packs, and starter documentation templates.
- Added the unattended ticket loop through `rafi start` and `ai-foreman`.

### Packages

- Published initial package versions: `@rafi-ai/cli@0.1.0`, `special-agents@0.1.0`, and `ai-foreman@1.0.0`.
