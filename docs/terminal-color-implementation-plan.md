# Terminal Color Implementation Plan

This plan turns the requirements in [terminal-color-requirements-plan.md](terminal-color-requirements-plan.md) into an ordered implementation with named code areas, test boundaries, and completion criteria. The implementation status and validation record below reflect the current rollout.

## Implementation status

Implemented the shared policy and applied selective styling to build activity, Manager, Rafi compile/create summaries, Foreman build summaries, status/doctor, ticket outcomes, and recovery status. Added terminal-control sanitization at activity and Manager display boundaries and for dynamic values in changed summary paths. Machine-readable Manager host-command paths remain unstyled, including mixed JSON/text responses. Clack interview rendering remains untouched.

Validation completed: ai-foreman and Rafi builds and typechecks pass; focused terminal-style and activity tests pass (26 tests); generated CLI documentation check passes. The packaged Manager regression tests could not run in this workspace because the installed `better-sqlite3` binary targets Node ABI 115 while the active Node 24 runtime requires ABI 137. Real light/dark theme and cross-platform terminal inspection remains a manual release check.

## Objective

Add a restrained, consistent color system to normal Rafi and ai-foreman output, including build activity and Manager, while keeping redirected output plain by default and machine-readable responses plain in every mode. Keep ordinary prose at the terminal default color. Color selected labels, statuses, identifiers, and symbols so users can scan output more easily without losing meaning when color is unavailable. `FORCE_COLOR` is an explicit opt-in for colored human-readable redirected output.

## Recommended implementation decisions

These decisions make the requirements implementable and should be treated as the proposed defaults unless implementation evidence reveals a compatibility issue.

1. **Put the shared API in ai-foreman.** Rafi already imports `ai-foreman/activity.js`, and ai-foreman owns the common activity renderer and Manager. Add a small `terminalStyle` module in `packages/ai-foreman/src/` and expose it through `packages/ai-foreman/package.json` for Rafi to import. Avoid a second implementation in Rafi.
2. **Use a small local ANSI implementation.** The palette needs only a few basic foreground and reset codes, so keep the implementation in the shared helper rather than adding a runtime dependency. Avoid OS-specific detection. If implementation evidence makes a library necessary, add it as a direct dependency and keep policy resolution explicit.
3. **Resolve color separately for stdout and stderr, with explicit precedence.** Use this order for human-readable output: (1) explicit machine-readable output is always plain; (2) `NO_COLOR` being present, even empty, disables color; (3) `TERM=dumb` disables color; (4) `FORCE_COLOR=0` disables color; (5) `FORCE_COLOR=1`, `2`, or `3` enables color even when redirected; (6) otherwise color only when the destination stream is a TTY. Empty or other invalid `FORCE_COLOR` values fall through to the TTY rule. `NO_COLOR` and `TERM=dumb` take precedence over `FORCE_COLOR`. Do not add a CLI override in the first implementation; if one is later added, document its precedence and keep machine-readable modes plain. This makes forced color meaningful for human-readable redirected output while keeping JSON and other declared data modes escape-free.
4. **Start with a small semantic palette.** Use basic ANSI foreground colors only, with no dependency on truecolor, bold, or color alone for meaning. Proposed roles: cyan for product/section labels, green for success, yellow for warning, red for error, and blue for informational labels. Keep the words and existing symbols that convey each state. Inspect each role against light and dark terminal themes before finalizing.
5. **Sanitize untrusted display text at the terminal boundary.** Strip or visibly neutralize terminal control sequences from model answers and event-derived strings before writing them to the terminal. Cover all terminal write paths, including `ActivityReporter.note`, `ActivityReporter.writePersistent`, activity phase/detail/provider/model fields, Manager model answers, and human-readable command interpolations. Preserve intended newlines where the output format needs them while neutralizing other control characters. Apply styles only to host-owned presentation labels and fixed status tokens. Do not alter the persisted value, evidence bytes, offsets, JSON value, or stored transcript while sanitizing display output.

## Code ownership and expected touchpoints

| Area | Expected files | Responsibility |
|---|---|---|
| Shared color policy and formatters | `packages/ai-foreman/src/terminalStyle.ts` (new), `packages/ai-foreman/package.json` | Resolve color policy per stream; expose named semantic styling and safe terminal display helpers. |
| Shared activity | `packages/ai-foreman/src/activity.ts` | Style host-owned activity labels and status markers; sanitize all terminal-bound activity text, including `note` and `writePersistent`, without changing record shape, lifecycle, timing, cursor behavior, or coalescing. |
| Manager | `packages/ai-foreman/src/cli/manager.ts` | Style headings, guidance labels, and status tokens on human-readable paths; safely render model text; preserve explicitly JSON responses and established mixed host-command formats. |
| Normal Rafi output | `packages/rafi/src/index.ts` and selected human-readable command modules under `packages/rafi/src/` and `packages/ai-foreman/src/cli/` | Apply styles selectively to summaries, success/warning/error labels, and scan-friendly identifiers. Leave data output and interview UI alone. |
| User documentation | `docs/cli.md` and/or the existing Rafi and ai-foreman README CLI sections | Explain palette roles, environment behavior, machine-readable guarantees, and plain-text fallback. Keep generated CLI docs in sync if the source docs are generated. |
| Tests | New `packages/ai-foreman/test/terminalStyle.test.ts`, `packages/ai-foreman/test/activity.test.ts`, `packages/ai-foreman/test/managerEvidence.test.ts`, `packages/rafi/test/managerPackaged.test.mjs`, and selected CLI tests | Lock down color policy, safe rendering, JSON cleanliness, activity compatibility, package export behavior, and visible text stability. |

The file list is a starting scope, not a mandate to recolor every `console.log`. During implementation, identify high-value human-readable output paths and update this plan if the CLI has additional output owners that materially affect coverage.

## Implementation sequence

### Phase 1: Inventory contracts and define the API

1. Record the current user-visible output for representative cases: build activity, successful and failed Rafi commands, Manager interactive output, Manager one-shot output, and selected human-readable ai-foreman commands.
2. Identify every Manager branch that promises a JSON document. Add a table to the implementation change or tests naming those exact branches. Treat host commands that intentionally emit JSON plus prose/evidence as existing mixed-format contracts; do not silently reclassify them.
3. Define a stream-aware API with narrow semantic methods, for example `accent`, `success`, `warning`, `error`, and `info`. The API should accept a destination stream or an explicit resolved style context so test streams do not accidentally consult global `process.stdout`.
4. Define safe display helpers separately from styling. Sanitization must happen before styling, and should not mutate source strings used for storage, evidence, JSON, or control flow.
5. Add unit tests for policy resolution before applying styles elsewhere.

**Exit criteria:** The color policy is deterministic for each stream and environment; all semantic style methods return unchanged text when disabled; arbitrary text is not treated as trusted style markup.

### Phase 2: Implement the shared terminal-style module

1. Add `packages/ai-foreman/src/terminalStyle.ts` with the shared policy and semantic style functions.
2. Add the module export to `packages/ai-foreman/package.json` so Rafi can import the built module consistently, matching the package's existing subpath export pattern.
3. If a library is selected, add it as a direct runtime dependency and update the pnpm lockfile. Verify the dependency's behavior does not auto-color `NO_COLOR`, `TERM=dumb`, non-TTY streams, or machine-readable output contrary to the chosen policy.
4. Implement environment resolution explicitly rather than allowing an implicit library default to determine precedence. Apply the stated order exactly. Cover `NO_COLOR` presence (including empty), `FORCE_COLOR=0|1|2|3`, empty and invalid `FORCE_COLOR`, `TERM=dumb`, declared machine-readable output, and TTY state.
5. Ensure calls for stdout and stderr independently inspect the destination. A TTY stderr must not cause stdout styling when stdout is redirected.

**Tests:** New focused tests should cover TTY/non-TTY × stdout/stderr context, the full precedence order, `NO_COLOR`, `FORCE_COLOR` values, `TERM=dumb`, machine-readable override, and style resets. Include assertions that plain mode contains no ESC characters and enabled mode contains only expected style/reset codes. Build the helper around an explicit stream/policy context so tests do not mutate process-global streams or environment concurrently.

### Phase 3: Apply color to shared build activity

1. Integrate semantic styling in `packages/ai-foreman/src/activity.ts` at the point where host-owned activity fields are assembled for display.
2. Style only selected presentation elements: Rafi/Foreman label, phase/status marker, provider label where useful, and warning or completion indicator. Keep detail text and model/provider supplied content in the default color and pass it through the safe display boundary.
3. Keep ANSI styling outside semantic identity keys and state transitions. Do not include escape codes in `lastSemanticKey`, timestamps, transcript/event records, or stored phase values.
4. Keep the default `records` TTY mode and non-TTY newline records unchanged in structure and lifecycle. If the current renderer clears/replaces a line in another mode, keep cleanup sequences and style reset sequences well-formed and independent. Color only host-owned labels in record output; preserve the record framing and text content after terminal-control sanitization.
5. Preserve heartbeat cadence, coalescing, prompt pause/resume, and final cleanup behavior.

**Regression checks:** Extend `activity.test.ts` to check styled TTY rendering and plain output under disabled-color policy; keep existing append-only and non-TTY no-ANSI expectations. Include hostile control sequences in phase labels, details, provider/model fields, `note`, and `writePersistent` content, and verify they cannot escape styling or create terminal control behavior. Add an explicit forced-color redirected human-output case and a machine-output no-color case.

### Phase 4: Apply color to Manager

1. In `packages/ai-foreman/src/cli/manager.ts`, identify human-only rendering paths separately from JSON serialization paths.
2. Add selective color to the initial summary, prompt label, fixed command/help guidance, status cues, and host-owned labels. Keep body prose, evidence bodies, and model answer text at the terminal default color.
3. Sanitize model response text and other untrusted terminal-bound values before output. Preserve evidence redaction and existing terminal-control escaping; do not alter raw artifact export bytes or metadata. Ensure sanitizer output is used only for terminal rendering and never fed back into model prompts, JSON serialization, or evidence storage.
4. Leave explicit JSON serialization unstyled. For mixed JSON-plus-text host responses, preserve the current bytes and order except for color on clearly host-owned text only if the existing contract permits it. Prefer keeping the whole mixed response plain in the first release to avoid breaking consumers that parse or compare it.
5. Verify that one-shot `--ask` human/model answer output receives color only when its destination stream policy allows it; verify evidence JSON remains valid and escape-free.

**Regression checks:** Expand `managerEvidence.test.ts` and `managerPackaged.test.mjs` or add manager CLI tests to cover hostile controls in model answers and evidence display, existing redaction, JSON parseability for each named JSON branch, and ANSI-free output with normal non-TTY defaults. Preserve the established mixed-output tests or add characterization coverage before styling those paths. Test a forced-color one-shot human answer separately from the enumerated JSON host commands.

### Phase 5: Extend to ordinary Rafi and ai-foreman interactions

1. Start with stable human-readable output in `packages/rafi/src/index.ts`: compile/create completion and next-step summaries, command-family success/warning/error prefixes, and build/recovery handoff summaries.
2. Continue into selected command modules where color improves scanning: `packages/ai-foreman/src/cli/status.ts` summary/status labels, `doctor.ts` check markers, ticket workflow progress in `tickets.ts`, and recovery guidance in `start.ts`/`recovery.ts`. Record the exact command paths included in the first rollout before editing so coverage is reviewable.
3. Keep ordinary prose, user-provided values, paths, generated content, JSON, YAML, stdout data streams, and file writes unstyled. Sanitize untrusted terminal-bound interpolations using the shared helper.
4. Do not wrap Clack calls or override its styles. Run representative interview flows to confirm prompt lifecycle and appearance remain owned by `@clack/prompts`.
5. Keep scope selective. For each command changed, document whether output is human-readable or has a machine-readable contract and test the latter for no ANSI.

**Regression checks:** Update exact-output tests only for intentional human-facing changes. Keep command exit codes, text labels, ordering, and data formats stable. Include representative compile, status/doctor, ticket, and recovery output checks as the touched modules warrant.

### Phase 6: Documentation and terminal review

1. Document the final palette and semantic roles, default TTY policy, `NO_COLOR` / `FORCE_COLOR` / `TERM=dumb` precedence, per-stream behavior, and machine-readable output guarantee.
2. Review generated CLI documentation with its source of truth; run the repository's docs check if generated help/docs were affected.
3. Inspect real output under a light theme and a dark theme. Check basic ANSI behavior in macOS Terminal or iTerm, Linux terminal, WSL, and Windows Terminal. Confirm older Windows console environments receive readable plain text when ANSI support cannot be established.
4. Review color at basic ANSI depth and with color disabled. Every success, warning, and error must remain clear from words/symbols alone.
5. Capture any unsupported terminal limitation in user-facing documentation rather than adding platform-specific detection without evidence.

## Test matrix and release gates

| Scenario | Expected result |
|---|---|
| stdout TTY, stderr TTY, normal environment | Human-facing labels use semantic color; ordinary prose remains default color. |
| stdout redirected, stderr TTY | stdout stays plain; stderr may use color according to its own stream policy. |
| stdout TTY, stderr redirected | stderr stays plain; stdout may use color according to its own stream policy. |
| Both output streams non-TTY | No ANSI by default; text and record shape remain readable and stable. |
| `NO_COLOR` set, including empty | No color on either stream. |
| `FORCE_COLOR=1|2|3`, with `NO_COLOR` absent and `TERM` not dumb | Human-readable output may contain color even when redirected; declared machine-readable modes stay plain. |
| `FORCE_COLOR=0` | Plain output, including on TTYs. |
| `FORCE_COLOR` empty or invalid | Falls through to TTY detection; no effect for non-TTY output. |
| `TERM=dumb` | Plain text. |
| `NO_COLOR` plus any `FORCE_COLOR` | Plain text. |
| Explicit JSON Manager response | Parses as one JSON document and contains no ANSI. |
| Manager mixed JSON/prose/evidence response | Existing format and byte order remain intact; no ANSI in initial implementation. |
| Hostile ESC/CSI/OSC/C0/C1 control text in model, event, path, note, persistent, or evidence content | Cannot alter terminal state or escape host-owned styling; intended line breaks remain where required; protected evidence bytes and offsets remain unchanged. |
| Activity TTY record mode and non-TTY mode | No semantic/coalescing/lifecycle regression; existing newline-record contract stays stable. |
| Interviews | Clack prompts, cancellation, selection, and prompt rendering continue to work. |
| Windows Terminal, WSL, macOS, Linux | Standard ANSI styling is readable; plain fallback remains clear. |
| Legacy Windows console without ANSI support | Confirm support detection or explicitly document it as unsupported/plain-only; do not assume `isTTY` alone proves ANSI support. |

Release gates:

- Existing targeted tests pass, including activity and Manager evidence coverage.
- Focused tests cover policy precedence, stream independence, sanitization, and ANSI-free output.
- Explicit JSON branches parse successfully and contain no escape sequences.
- Typecheck and package builds pass for ai-foreman and Rafi; package subpath resolution works in the built CLI.
- No Clack interview regression is observed.
- The final docs describe the behavior users will see.

## Main regression risks and controls

| Risk | Control |
|---|---|
| ANSI codes invalidate JSON or scripts | Keep serialization on plain paths; explicitly enumerate JSON contracts; test parseability and absence of ESC. |
| Styling changes activity coalescing or cursor cleanup | Apply color at final rendering only; keep comparison keys and state plain; run existing activity tests plus colored TTY coverage. |
| Untrusted content injects terminal controls | Sanitize at terminal display boundaries before applying host-owned styles; test ESC, OSC, and newline inputs; preserve source/evidence data. |
| TTY detection leaks color into a pipe | Resolve capability per stream and test mixed TTY/redirected cases. |
| Environment override ambiguity | Implement and test documented precedence directly; do not delegate policy to an implicit default. |
| Poor theme contrast or color-depth assumptions | Use basic ANSI roles, retain textual markers, inspect light/dark themes, and avoid truecolor-only values. |
| Clack prompt appearance or lifecycle changes | Do not decorate Clack-owned output; test representative interactive interviews. |
| Dependency or package export breaks | Declare a direct dependency if used; update lockfile; verify ai-foreman built export and Rafi package consumption. |
| Broad recoloring creates noisy diffs or unexpected output changes | Roll out in the listed phases and change only stable host-owned labels and markers. |

## Completion checklist

- [x] Shared terminal-style API exists in ai-foreman and is consumable from Rafi.
- [x] Color policy is stream-aware and precedence is documented and tested.
- [x] Forced-color behavior for redirected human output and the no-color guarantee for machine output have focused tests; packaged Manager execution remains blocked by the local SQLite ABI mismatch noted above.
- [x] Activity styles only host-owned presentation fields and preserves record behavior in focused tests.
- [x] Manager styles human-readable labels; JSON and mixed response paths remain unstyled by implementation, with a forced-color packaged regression test added but not runnable in this workspace.
- [x] Untrusted activity and Manager display content is sanitized without changing stored or exported content.
- [x] Selected ordinary Rafi/ai-foreman summaries use the palette consistently.
- [x] Interviews continue to use Clack styling unchanged in code; interactive terminal review remains outstanding.
- [ ] Terminal compatibility and light/dark contrast have been reviewed on the target terminal matrix.
- [x] Documentation and focused tests reflect the implemented behavior.

## Audit findings

- The initial plan mentioned `FORCE_COLOR` but limited it to TTY streams. Since normal TTY output is already color-enabled, that made the override ineffective. The plan now specifies `FORCE_COLOR=1|2|3` for human-readable output, including redirected output, while declared machine-readable modes remain plain.
- The initial precedence description did not settle empty/invalid `FORCE_COLOR`, `FORCE_COLOR=0`, or collisions with `NO_COLOR` and `TERM=dumb`. The plan now gives a complete ordered policy, with `NO_COLOR` and `TERM=dumb` taking precedence.
- Activity sanitization initially focused on phase/detail fields. The reporter also has `note` and `writePersistent` terminal-write paths, which can receive event or model text. These are now explicit implementation and test targets.
- Existing packaged Manager tests already characterize some `--ask` contracts: `/qa-attempts` and `/qa-timeline` output is parsed as JSON, control commands emit a JSON receipt followed by text, and report/export paths protect sensitive content. The implementation must inventory the remaining branches before changing output; this document now names the packaged test as a key regression boundary.
- The first ordinary-output rollout was broad enough to invite scope drift. The revised sequence names likely stable summary paths and requires an exact first-rollout command list before implementation.
- The legacy Windows console fallback remains a decision to validate. Node TTY state alone does not establish ANSI support; the implementation must confirm a reliable support signal or document legacy consoles as plain-only/unsupported.
