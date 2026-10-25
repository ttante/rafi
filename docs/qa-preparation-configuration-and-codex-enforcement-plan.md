# QA preparation configuration and Codex enforcement plan

## Objective

Make QA preparation the normal, simple Rafi behavior:

```yaml
qa_preparation: true
qa_preparation_shadow: false
```

`qa_preparation: true` means a fresh QA agent creates and independently
assesses a durable verification contract before the Builder can implement a
ticket. `qa_preparation_shadow: true` is an internal rollout/measurement mode:
when *both* values are true, Rafi performs the work but does not block the
Builder. It exists only to evaluate a new preparation implementation safely on
real work.

New projects must ask about this during `rafi create`, default and recommend
**Yes**, and write `qa_preparation: true`. `rafi create --defaults` must also
enable it. The feature must work for Claude and Codex without weakening the
requirement that the Builder has the current contract before implementation.

## Non-negotiable behavior

1. A preparation-enabled run freezes its resolved policy at run creation.
   Editing configuration later never changes an active run.
2. Normal enabled mode blocks every new Builder implementation dispatch until:
   - the admitted ticket has a valid depth decision (or the existing bounded
     planner fallback creates one);
   - QA preparation and independent assessment publish a ready contract;
   - the actual scoped Builder session receives that exact contract; and
   - the contract remains valid for that session/worktree/compaction state.
3. A shadow run performs the same preparation and records the same diagnostics,
   but never fabricates a delivery receipt or blocks an otherwise authorized
   Builder dispatch.
4. Existing projects/runs retain understandable compatibility. No old config
   can accidentally change from non-blocking to blocking without an explicit
   migration or `rafi config` action.
5. Codex and Claude both support enabled QA preparation. Codex compaction is a
   continuity event, not a reason to block QA handoff, stop a Builder, or make
   the user choose a recovery action.

## Phase 1 — replace the public configuration model

### 1. Define the public schema

Replace the public object/enum configuration with two booleans in
`packages/spec/src/types.ts` and `packages/spec/src/schemas.ts`:

```ts
qa_preparation?: boolean;
qa_preparation_shadow?: boolean;
```

Normalization rules for newly authored config:

| `qa_preparation` | `qa_preparation_shadow` | resolved behavior |
|---|---|---|
| absent | absent | legacy/off for pre-existing configs only |
| `false` | absent/`false` | legacy/off |
| `true` | absent/`false` | enforcing preparation |
| `true` | `true` | shadow preparation |
| `false` | `true` | validation error: shadow requires QA preparation |

Do not expose a mode enum in generated configuration, command help, normal
status text, or `rafi create` prompts.

### 2. Preserve deliberate backward compatibility

For one supported migration release, accept the former object form only while
loading existing `rafi-config.yaml` files and map it exactly:

| old value | migrated booleans |
|---|---|
| `{ mode: legacy }` | `false`, `false` |
| `{ mode: shadow }` | `true`, `true` |
| `{ mode: enforce }` | `true`, `false` |

Emit a single concise migration warning that names the replacement YAML. Do
not rewrite a user file during a build. Provide an explicit `rafi config
migrate` (or existing equivalent configuration-migration command) that makes
the rewrite only after showing the exact diff. Remove enum acceptance only in a
later documented breaking release.

Internally, retain `legacy`/`shadow`/`enforce` as an implementation-only
resolved policy if that minimizes migration risk. Rename the public-facing
types, validation errors, help, and documentation so users never need to know
those names.

### 3. Update config resolution and run freezing

Update:

- `packages/rafi/src/project.ts`
- `packages/ai-foreman/src/qaPreparationPolicy.ts`
- `packages/ai-foreman/src/qaEffectiveConfig.ts`
- `packages/ai-foreman/src/buildRuns.ts`
- plan/ticket policy propagation in `packages/rafi/src/plan.ts`,
  `structuredPlan.ts`, and ticket population

The resolver should take the booleans and return an internal immutable policy.
The run record should additionally retain the user-facing source values and
policy version so status and recovery can explain why a run is blocked or in
shadow mode. Preserve the old-run rule: a run that began before this feature
remains off unless it already froze an explicit preparation policy.

### 4. Regression coverage

Add tests for schema validation, normalization, old-config mapping, invalid
shadow-only config, policy freeze/restart, planner depth propagation, status,
and migration output. Test `false`, `true`, `true + shadow`, absent legacy
config, each old enum mode, and a partially written/invalid config.

## Phase 2 — make creation default-on and understandable

### 1. Extend create answers

Add `qaPreparation: boolean` and `qaPreparationShadow?: boolean` to
`WalkthroughAnswers` in `packages/rafi/src/project.ts`. `defaultAnswers()`
must set `qaPreparation: true` and `qaPreparationShadow: false`.

`buildProjectConfig()` writes:

```yaml
qa_preparation: true
```

It writes `qa_preparation_shadow: true` only when selected. Avoid writing a
false shadow field unless the repository's configuration style requires
explicit defaults.

### 2. Add the create interview decision

In `packages/rafi/src/index.ts`, after runtime selection and before compile,
add an interactive select prompt with a recommended default:

- **Yes — prepare QA requirements before each Builder ticket (Recommended)**
- No — use legacy Builder-first flow

Default to Yes. If Yes is selected, ask the advanced shadow question only when
the user explicitly chooses an advanced/rollout path; do not present shadow in
the ordinary create path. Store each answer in the resumable interview record
and preserve it through resume/recovery.

The same enabled configuration must work for Claude-only, Codex-only, and
mixed-runtime projects. Do not show a provider warning or substitute a
provider-specific default during `rafi create`.

### 3. Test creation paths

Cover interactive Yes/default, No, noninteractive `--defaults`, interview
resume, both-runtime projects, Claude-only projects, Codex-only projects,
compiled config validation, and generated docs/help. Verify a newly generated
config begins an enforcing run without hand-editing YAML.

## Phase 3 — make Codex enforcement real

### Why this needs a dedicated design

The current Codex adapter already observes `contextCompaction` notifications
and has manual compaction support. It reports
`nativeCompactionBarrier: false`, though, because it does not have Claude's
combination of a pre-compaction hook and a pre-tool hook. A compaction can
occur inside a Codex implementation turn; observing it only afterwards cannot
prove the next write tool saw the complete current QA contract.

The target is not to duplicate Claude's implementation. Codex compaction does
not invalidate earlier work, interrupt QA handoff, stop the Builder, or require
a new Builder session. Instead, at Rafi's first normal interaction with that
same Builder after it observes a compaction, Rafi sends a Codex-only
continuation reminder with the current durable contract attached.

The reminder tells the Builder that its context compacted while working on the
ticket, that it must re-read and meet the attached QA requirements exactly,
that it must review remaining work and relevant earlier changes against those
requirements, and that QA validation will fail noncompliant work. Rafi records
the contract digest, compaction identity, and redelivery event, then continues
normally. It does not require an acknowledgement, user decision, pause, or
special Builder handoff.

### 1. Capability investigation spike (required before changing the flag)

Build an isolated app-server protocol fixture using a disposable git repo and
a scripted/local Codex transport. It must determine, with captured RPC
transcripts:

1. how `contextCompaction` identifies the Builder session and orders relative
   to future Rafi-controlled turns;
2. that Rafi can reliably detect a compaction once and select the first
   subsequent Builder interaction for the reminder;
3. how a resumed/native session receives an injected continuation prompt and
   the attached durable contract; and
4. how duplicated, delayed, missing, or foreign compaction events are handled
   without duplicate reminders or cross-ticket contract delivery.

Run an opt-in live canary only after scripted coverage passes. Use a disposable
repository, a benign write fixture, a bounded budget/deadline, and retained
protocol evidence. Never use a production project or rely on model prose as
evidence. Record Codex app-server version, operating system, exact RPC events,
and the result under `scripts/live/` and `docs/`.

### 2. Codex design: post-compaction requirement reminder

Implement a durable, idempotent `CodexContractReminder` flow:

1. When the adapter observes `contextCompaction`, append a
   `compaction-observed` event containing the run, assignment, native session,
   ticket, contract digest/generation, and provider event sequence. Mark the
   contract reminder as pending for that session and contract generation.
2. Do not interrupt the current Builder turn, discard changes, alter QA
   handoff, or block work. A few actions after a compaction are acceptable.
3. Immediately before the first subsequent Rafi-controlled interaction with
   that same Builder session, atomically claim the pending reminder and prepend
   a dedicated Codex-only continuation message. Attach or materialize the full
   immutable contract, not a summary, and include its digest/path.
4. The message must plainly say: context compacted; re-read the attached QA
   requirements now; check remaining work and relevant existing changes against
   them; meet every requirement exactly; and QA validation will fail work that
   does not satisfy the contract. It must tell the Builder to continue the
   assigned task, not start planning or wait for an answer.
5. Persist `contract-reminder-delivered` only after the provider accepts that
   interaction. The record carries original compaction event, contract digest,
   session/turn ID, assignment, and prompt-template version.
6. Clear only the matching pending record. Repeated compactions before another
   interaction coalesce to one reminder containing the newest contract;
   compactions after a reminder schedule a new one. A restarted Rafi process
   resumes the pending reminder before its next interaction.

Make this a small provider-specific continuation layer in the Codex adapter,
fed by the shared contract store and assignment identity. Do not weaken
Claude's existing delivery protection or force Claude to use this prompt.
Do not treat a prose response as an acknowledgement.

### 3. Safe degradation and observability

If a session cannot be matched to its ticket/contract, preserve the event and
send no contract to an ambiguous session. At the next safe Rafi boundary, emit
a precise diagnostic and use the existing session-reconciliation path; never
send a foreign contract or silently clear the event. If a provider interaction
cannot accept the reminder, keep it pending and retry at the next interaction.

Expose compact status in structured diagnostics only: the number of reminders
delivered/pending and the latest contract digest. Normal build output should
remain quiet unless a reminder cannot be delivered.

### 4. Codex test matrix

Add deterministic adapter and integration tests for:

- preparation → contract delivery → Builder write;
- compaction during a Builder turn followed by normal completion; no stop,
  rollback, or QA-handoff interruption occurs;
- first subsequent Rafi interaction receives exactly one Codex-only reminder
  with the full current contract, digest, and required wording;
- compaction immediately before/after a tool mutation; existing work remains
  intact and the next interaction still gets the reminder;
- duplicate, delayed, missing, foreign-session, stale-contract, and
  cross-ticket events;
- multiple compactions before one interaction (coalesced) and another after a
  delivered reminder (new reminder);
- provider disconnect, native-session resume, and Rafi restart with the
  reminder still pending;
- branch, ordinary, synthetic, remediation, Manager follow-up, and resume
  paths;
- adapter/wrapper replacement and native session resume;
- an assertion that no user prompt, Builder acknowledgement, new Builder
  session, or QA-handoff gate is created by a normal Codex compaction.

Run these against fakes first, then a guarded live Codex canary. Repeat the
same matrix for Claude to prove the common abstraction did not regress its
existing hook-based protection.

## Phase 4 — user workflows, migration, and documentation

1. Update `rafi create`, `rafi config`, `rafi status`, `rafi manager`, `rafi
   plan`, ticket help, `docs/cli.md`, and README examples to use the two
   booleans and plain language: “QA preparation before Builder work.”
2. Add a Manager diagnosis that states whether the active run is enabled,
   shadow, or legacy; whether a contract exists; the preparation state; and the
   exact safe next action. Never expose internal `mode: enforce` language to
   normal users.
3. Teach failed preparation/recovery messages to say whether they block work,
   how to inspect retained evidence, and how to resume. Preserve `plan:doctor`
   and ticket repair guidance separately from build-time QA preparation.
4. Add a short provider support table. It must state that QA preparation is
   enabled by default for Claude and Codex, and explain Codex's automatic
   post-compaction requirement reminder in plain language.
5. Include config migration examples and an explicit note that new policy takes
   effect on the next build run, not in the middle of an existing run.

## Implementation order and review checkpoints

1. Add public booleans, compatibility resolver, and regression tests. Keep
   runtime behavior unchanged until tests prove exact old-mode mapping.
2. Update `rafi create`, config/docs/help/status, and creation tests. Verify
   `--defaults` writes enabled config.
3. Preserve Claude's current delivery protection while extracting only the
   shared contract/session identity needed by the Codex continuation layer;
   run all current QA-prebuild and resume suites.
4. Complete the Codex capability spike. Prove event/session ordering and a
   reliable next-interaction injection point for the reminder.
5. Implement and test the Codex post-compaction reminder, then run its
   fake/integration/live-canary evidence. Keep it default-on for Codex once
   the capability tests pass.
6. Run package tests, builds, docs checks, a generated-project create → plan →
   tickets → two-step build fixture for Claude and Codex, and the complete
   publish gate. Record durations and provider/runtime versions.

Every slice requires regression tests before or with the implementation. Do not
alter existing user configuration, invoke live providers, publish, commit, or
push without explicit authorization.

## Definition of done

- New projects default to and visibly recommend `qa_preparation: true`.
- `qa_preparation_shadow: true` has effect only alongside `qa_preparation:
  true`; it is not part of the normal create experience.
- Old enum configs migrate predictably without surprise behavior changes.
- Every normal builder path is gated when preparation is enabled.
- Codex has a tested, evidence-backed post-compaction requirement reminder,
  successful end-to-end canary coverage, and no normal compaction path that
  blocks QA handoff or requires user/Builder acknowledgement.
- Claude safety behavior remains intact.
- Documentation, Manager/status output, tests, builds, and publish checks pass.
