# Changelog

All notable user-facing, API, migration, security, AI/model, and operational changes are documented here.

This project follows semantic versioning for published npm packages where practical. Entries before formal GitHub Releases are reconstructed from git history because the repository has no release tags yet.

## Unreleased

No unreleased changes.

## @rafi-ai/cli 0.3.7 / special-agents 0.3.7 / ai-foreman 1.0.8 - 2026-07-07

### Documentation

- Added Apache-2.0 license files for the repository and publishable packages.
- Added package metadata that points npm users back to `ttante/rafi`.
- Added release and changelog documentation for public release transparency.

### Packages

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
