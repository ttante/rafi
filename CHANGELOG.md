# Changelog

All notable user-facing, API, migration, security, AI/model, and operational changes are documented here.

This project follows semantic versioning for published npm packages where practical. Entries before formal GitHub Releases are reconstructed from git history because the repository has no release tags yet.

## Unreleased

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
