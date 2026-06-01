# Rafi — Refined AI Framework & Implementor

> Status: PLAN ONLY. No code changes yet. This document is the agreed design before any work starts.

## 0. Vision & Naming

**Rafi** (Refined AI Framework & Implementor) is a **harness-engineering toolkit**. Its core is a standalone **library** of composable best-practice content; everything else consumes that library. It is intentionally a combination (like Next.js = library + runtime + `create-next-app`):

- **Library** = `special-agents` (NEW, published). Holds the raw **rules**, the **skills** that pin them, the **agent** manifests that compose skills+rules into roles, and the composition logic itself. Ships **both source and prebuilt-default artifacts** (`.claude/` + `AGENTS.md`) so it can be used with zero build step. Depends on nothing in the toolkit except `spec`.
- **Runtime** = `foreman` (existing). Drives agents through tickets with QA. Now *imports `special-agents`* to get composed role agents. Behavior unchanged; gains role-bundle loading. **Renamed on npm `foreman-cli` → `ai-foreman`** (command `ai-foreman`); old `foreman-cli` gets a deprecation pointer.
- **CLI** = `@rafi/cli` (NEW, published; command `rafi`). Thin front-end over `special-agents`: `rafi create` (scaffold walkthrough → `project.yaml` → first compile + doc copy) and `rafi compile` (re-render configs for a target repo). Scoped because the bare `rafi` package name is already taken on npm.

### Adoption ladder (why the library is standalone)
A consumer can stop at any rung — each is independently useful, no foreman required until the top:
1. **A rule** — grab one rule pack.
2. **A skill** — drop a composed skill into `.claude/skills/` (works in plain Claude Code today).
3. **An agent** — use a composed `builder`/`qa`/`ticket-maker` agent in plain Claude Code or Codex.
4. **The runtime** — `foreman` drives those agents through a ticket loop.

Dependency direction is strictly one-way: **`special-agents` ← `rafi` / `foreman`**. The library never depends on the runtime.

**Package naming:**
- `special-agents` — the published library (rules + skills + agents + composition). npm: **free** ✓.
- `ai-foreman` — the runtime, renamed from `foreman-cli`; command `ai-foreman`. npm: **free** ✓.
- `@rafi/cli` — the CLI; command `rafi`. The one scoped package (bare `rafi` is taken). Needs the `rafi` npm org registered before publish.
- `spec` — **internal**, unpublished; bundled into `special-agents` at build. Invisible plumbing.
- Names on npm: `special-agents`, `ai-foreman`, `@rafi/cli`.

### The one-line mental model
```
                       ┌─────────────────── special-agents (library) ───────────────────┐
rules.md (monolith) ─shard─> rule packs ──pinned by──> skills ──┐
                              (static/templated/conditional)     ├─composed into─> AGENTS
project.yaml (stack answers) ─substituted into─ templated packs ┘    (builder/qa/planner/ticket-maker)
                       └────────────────────────────────┬───────────────────────────────┘
                                                  ── compile ──>  .claude/   (lean, lazy-loaded)
                                                                  AGENTS.md  (Codex, flattened/inlined)
                                                         │
                                          ── run ──>  foreman loads a role bundle per turn-type
```

---

## 1. Target Repository Layout (pnpm monorepo)

```
ultimateAI/                         # repo root (rename later if desired)
  pnpm-workspace.yaml               # NEW: declares packages/* + content paths
  package.json                      # NEW: root, private:true, workspace scripts
  .gitignore                        # cleaned: ignore node_modules, dist, .rafi/compiled
  PLAN.md                           # this file
  README.md                         # top-level: what the toolkit is

  packages/
    special-agents/                 # NEW published library — the single source of truth
      content/                      #   authoring inputs (data, harness-agnostic)
        rules/                      #     rules.md sharded into packs (see §3)
          base/                     #       always loaded by every role
          process/                  #       engineering process
          domain/                   #       specialized (security, ai-*, observability, ...)
          templated/                #       stack-variable packs ({{placeholders}})
          packs.index.yaml          #       registry: name, category, condition, template flag
        skills/                     #     MOVED from ./skills (SKILL.md units, unchanged format)
        agents/                     #     role manifests (builder/qa/planner/ticket-maker .yaml)
        docs/                       #     MOVED from aiTools/docs (19 starter doc templates)
        defaults.yaml               #     default stack values == today's hardcoded values
      src/                          #   composition logic (resolve pins, render, emit) + JS API
      dist/                         #   build output: JS API + prebuilt-default .claude/ & AGENTS.md
    spec/                           # NEW internal pkg `spec` — schemas + shared TS types (unpublished)
    rafi/                           # NEW published CLI `@rafi/cli` (command `rafi`) — subcommands: create, compile
    foreman/                        # MOVED from ./foreman — published as `ai-foreman`
                                    #   behavior unchanged; imports special-agents for role bundles

  examples/
    dummy-project/                  # MOVED from foreman/dummy-project (compile/run target)
```

`special-agents` is **both data and code**: `content/` is the harness-agnostic source of truth; `src/` is the composition logic (formerly the standalone "compiler"); `dist/` carries a JS API (`getAgent`, `getSkill`, `compile`) plus prebuilt default artifacts for zero-config copy-in. `rafi` and `foreman` are thin consumers of it.

### What gets retired / absorbed
(all `content/*` paths below live under `packages/special-agents/content/`)
- `aiTools/rules.md` → sharded into `content/rules/**` (§3). Original kept until parity verified, then deleted.
- `aiTools/agent-files/AGENTS.md` (+ CLAUDE/GEMINI/copilot) → become **prebuilt output** of `special-agents` (its `dist/`), not hand-maintained source. Delete from source after the build reproduces them.
- `aiTools/scripts/bootstrap-project.sh` → replaced by `rafi compile` + `rafi create`. Keep as reference until parity, then delete.
- `aiTools/docs/` → `content/docs/`.
- `aiTools/skillsPlan.md`, `nextAdditions.md` → fold actionable items into this plan + `content/agents` backlog, then delete.
- `ralph/` (already deleted in working tree) → confirm removal.
- Root `.agents/skills/grill-me` (stray duplicate) → delete; canonical lives in `content/skills`.

### Monorepo move risk checklist (foreman)
- `foreman` uses pnpm + native `better-sqlite3` with `pnpm.onlyBuiltDependencies`. Move that `pnpm` block to **root** `package.json` (workspace-level build allowlist).
- `foreman/pnpm-lock.yaml` → removed; single root lockfile after `pnpm install`.
- Confirm `foreman/node_modules` and `foreman/dist` are **not** git-tracked (the "normally tracked files" commit may have added them). If tracked, `git rm -r --cached` and gitignore. **Verify before moving.**
- In `packages/ai-foreman/package.json`: rename `name` `foreman-cli` → `ai-foreman`, set `bin` to `{ "ai-foreman": "./dist/index.js" }`, bump `version`, keep `files`. After first `ai-foreman` publish, run `npm deprecate foreman-cli "renamed to ai-foreman"`. Internal source identifiers (`Foreman` class, `foreman.ts`, `foreman.yaml`) may stay as-is (cosmetic) or be renamed in a follow-up.
- foreman gains a normal published dependency on `special-agents` (which bundles `spec`), so global `npm i -g ai-foreman` pulls the library automatically and stays self-contained — see §7.5.

---

## 2. Neutral Schema (`packages/spec`)

Single source of truth for shapes that `special-agents` and `foreman` must agree on. Lives in the internal `spec` package, bundled into `special-agents` at build. Ship as TS types + JSON Schema (foreman already bundles `ajv`, reuse it for validation).

### 2.1 Rule Pack (front-matter markdown)
```markdown
---
name: security                       # unique, kebab-case
category: domain                     # base | process | domain | templated
description: Security, privacy, and compliance rules.   # one line, for indexes
condition: always                    # always | frontend | ai | cloud | backend
template: false                      # true if body contains {{placeholders}}
supersededByForeman: false           # true => omitted when foreman tracker is active (e.g. tickets pack)
---
- Never commit secrets...
(body = the rule bullets, lifted verbatim from rules.md)
```

### 2.2 `packs.index.yaml` (registry)
Generated/maintained list of every pack with its metadata, so the compiler does not have to glob+parse to plan. Source of truth = front-matter; index is validated against it in CI.

### 2.3 Skill manifest
Keep the **existing** Anthropic `SKILL.md` format (`name`, `description` front-matter + body + optional reference files). Add **one optional field** for our composition layer:
```yaml
pins: [code-quality, testing]   # rule packs this skill wants loaded alongside it (optional)
```
If a harness can't read custom front-matter fields, they're ignored — safe.

### 2.4 Agent (role) manifest — `content/agents/<role>.yaml`
```yaml
name: builder
description: Implements one ticket/step per turn.
role: builder                 # builder | qa | planner | ticket-maker  (maps to a foreman turn-type/command)
packs:                        # explicit pack pins (order preserved in render)
  - base/*                    # globs allowed; expands via packs.index
  - process/testing
  - process/api-docs
  - domain/security
  - domain/robustness
  - templated/*
skills: [tdd, improve-codebase-architecture]
conditionalPacks:             # added only when project flag is on
  ai: [domain/ai-safety, domain/ai-evals, domain/ai-cost, domain/ai-reproducibility, domain/ai-governance]
  frontend: [domain/accessibility]
model: null                   # null => inherit foreman --model
effort: null                  # null => inherit foreman --effort
```

### 2.5 Project settings — `project.yaml` (lives in the *target* repo)
```yaml
appName: "My App"
timezone: "UTC"
stack:
  frontend: "React with TypeScript"   # default
  backend:  "Node.js"                 # default
  database: "PostgreSQL"              # default
  cloud:    "AWS"                     # default
  packageManager: "pnpm"             # default
flags:
  hasFrontend: true                   # gates `frontend` packs + UI docs
  usesAI: false                       # gates `ai` packs + ai docs
  runsInCloud: true                   # gates `cloud` packs
harness:
  targets: [claude, codex]            # which native configs to emit
  qa: true                            # default QA on (matches foreman default)
```
- **Skipping the walkthrough = `defaults.yaml` verbatim = today's hardcoded behavior.** Zero regression is the acceptance bar.
- A future "stack pack" is just a named preset that pre-fills `stack` + `flags`. Same machinery.

---

## 3. Rule Pack Decomposition (the `rules.md` shard)

Two substeps:
- **3a (mechanical, safe):** cut each `##` section of `rules.md` into its own pack file, body verbatim. 29 sections + intro.
- **3b (judgment):** assign category + condition + template flag, and pin packs to roles (§2.4).

### Full mapping of all 29 sections
| `rules.md` section | Pack file | category | condition | template | notes |
|---|---|---|---|---|---|
| Core Working Agreement | `base/core` | base | always | no | every role |
| Git And Workspace Safety | `base/git-safety` | base | always | no | every role |
| Code Quality | `base/code-quality` | base | always | no | every role |
| Definition Of Done | `base/definition-of-done` | base | always | no | every role |
| Agent Response Expectations | `base/response-expectations` | base | always | no | every role |
| **Default Stack** | `templated/stack` | templated | always | **yes** | `{{frontend}}/{{backend}}/{{database}}/{{cloud}}/{{packageManager}}` + UI line gated by `hasFrontend` |
| **Infrastructure And Local/Cloud Runtime** | `templated/infra` | templated | cloud | **yes** | `{{cloud}}`, IaC defaults |
| **Data And Database Rules** | `templated/database` | templated | always | **yes** | `{{database}}` |
| Standard Project Documents | `process/project-docs` | process | always | no | doc list (AI docs lines gated by `usesAI`) |
| Ticket Tracking | `process/tickets` | process | always | no | `supersededByForeman: true` (foreman owns tracker when active) |
| Testing And Verification | `process/testing` | process | always | no | |
| Automation And CI | `process/ci` | process | always | no | |
| Dependency And Supply Chain Governance | `process/dependencies` | process | always | no | |
| API And Contract Documentation | `process/api-docs` | process | always | no | |
| Release, Versioning, And Change Management | `process/release` | process | always | no | |
| Business Documentation | `process/business-docs` | process | always | no | |
| Architecture And Decisions | `process/architecture` | process | always | no | |
| Scalability And Performance | `domain/scalability` | domain | always | no | mostly static |
| Data Governance | `domain/data-governance` | domain | always | no | |
| Security, Privacy, And Compliance | `domain/security` | domain | always | no | |
| Robustness And Reliability | `domain/robustness` | domain | always | no | |
| Observability And Operations | `domain/observability` | domain | always | no | |
| Accessibility, UX, And Product Quality | `domain/accessibility` | domain | **frontend** | no | |
| AI And LLM Safety | `domain/ai-safety` | domain | **ai** | no | |
| AI Model And Dataset Governance | `domain/ai-governance` | domain | **ai** | no | |
| AI Quality, Confidence, And Evals | `domain/ai-evals` | domain | **ai** | no | |
| AI Reproducibility, Replayability, And Prompt Tuning | `domain/ai-reproducibility` | domain | **ai** | no | |
| AI Cost Tracking And Learning Loop | `domain/ai-cost` | domain | **ai** | no | |
| Test-Driven Development | — | — | — | — | **becomes a pin to existing `skills/tdd`**, not a standalone pack (avoid duplication). A 2-line `process/tdd` stub may point at the skill for Codex flattening. |

Total: 5 base + 9 process + 11 domain + 3 templated = **28 packs** (+ TDD handled via the existing skill) = all 29 `rules.md` sections accounted for.

### Templating mechanism
- Placeholders use `{{key}}` against `stack.*`.
- Conditional *lines within a pack* (e.g. UI/AI doc lines) use a minimal directive the compiler strips:
  ```
  {{#if hasFrontend}}- Plan to build a UI...{{/if}}
  ```
  Keep the templating engine dead-simple (handlebars-subset or a 30-line custom regex pass). No logic beyond `{{var}}` and `{{#if flag}}...{{/if}}`.
- `content/defaults.yaml` holds the default strings; they are **literally the current `rules.md` values**, so an un-answered project renders byte-equivalent guidance.

---

## 4. Agents / Roles → Foreman Turn-Types

| Role | Foreman turn-type / command | Packs (beyond `base/*`) | Skills |
|---|---|---|---|
| `planner` | `buildPlanningTurn` (pre-flight planning) | process/architecture, process/tickets, process/project-docs | write-a-prd, prd-to-issues |
| `ticket-maker` | `tickets populate` command (see §8) | process/tickets, process/project-docs, process/architecture | (uses ticket-format know-how; no standalone skill) |
| `builder` | `buildPrimer`, `buildNextStepInstruction`, `buildQaFixInstruction` | process/testing, process/api-docs, domain/security, domain/robustness, templated/* | tdd, improve-codebase-architecture |
| `qa` | `buildQaInstruction` | process/testing, domain/security, domain/accessibility (if frontend) | grill-me, tdd (pins code-quality) |

`conditionalPacks.ai` adds the five `ai-*` packs to builder + qa when `flags.usesAI` (resolved decision #1). `ticket-maker` is a distinct role so the `ai-foreman tickets populate` command runs with ticket-writing guidance instead of the generic builder prompt.

**Key separation:** the **STEP_STATUS protocol + loop control stays in foreman** (it's runtime contract). Only the *role guidance content* (the prose inside `buildQaInstruction` etc.) moves into the composed role bundle. The marker spec strings (`MARKER_SPEC`, `QA_MARKER_SPEC`) stay in foreman.

---

## 5. The Compiler (composition logic in `special-agents/src`, run via `rafi compile`)

Plain description: **a build step that assembles each harness's config files from the building blocks.** It is the grown-up replacement for `bootstrap-project.sh`'s `cp` calls. It lives inside `special-agents` (so the library can compose itself and expose a `compile`/`getAgent` JS API); the `rafi` CLI and `foreman` call it. Two run modes:
- **library build time** — render prebuilt-default artifacts that ship in `special-agents/dist`.
- **target-repo time** — `rafi compile` (or foreman on the fly) renders against that repo's `project.yaml`.

### Inputs
1. `content/rules/**` (+ `packs.index.yaml`)
2. `content/skills/**`
3. `content/agents/*.yaml`
4. target repo's `project.yaml` (or `defaults.yaml` if absent)

### Pipeline
```
load+validate (ajv)  ->  resolve project flags/stack
  ->  render templated packs (substitute {{vars}}, strip {{#if}})
  ->  for each role: expand pack globs + conditionalPacks -> ordered pack list -> concat -> role system text
  ->  emit per-target outputs
```

### Outputs — Claude target (`harness.targets` includes `claude`)
```
<repo>/.claude/skills/<skill>/...        # copied from content/skills (lazy-loaded by SDK)
<repo>/.claude/agents/<role>.md          # subagent file (front-matter: name, description, tools)
<repo>/CLAUDE.md                         # `@AGENTS.md` import (or always-on base packs)
<repo>/.rafi/compiled/<role>/system.md# rendered role system text (foreman reads this at runtime, §8)
<repo>/.rafi/compiled/<role>/meta.json# { skills:[...], model, effort } for foreman
```
Claude output stays **lean**: base packs go in always-on `CLAUDE.md`/system; specialized packs ride along with their skills via progressive disclosure where possible.

### Outputs — Codex target (`harness.targets` includes `codex`)
```
<repo>/AGENTS.md                         # FLATTENED: base + all applicable packs inlined verbatim
<repo>/.rafi/compiled/<role>/system.md# same role text (foreman injects into the turn prompt for codex)
```
Codex reads everything up front (no lazy-load) → compiler **inlines** pack bodies. Per-skill `pins` and role specialization are flattened into the single `AGENTS.md` plus per-turn prompt injection. This asymmetry is expected and documented.

### Determinism & idempotency
- Output is fully derived from inputs; re-running produces identical bytes (stable ordering, no timestamps in body).
- `--check` mode: compile to memory, diff against on-disk outputs, non-zero exit on drift (for CI).
- `.rafi/compiled/` is git-ignored in consuming repos; `.claude/` + `AGENTS.md` are committed (they're the visible contract).

### Doc scaffolding (folded in from bootstrap script)
- Copy `content/docs/<doc>` into target `docs/` based on flags: AI docs (`ai.md`, `ai-evals.md`, `ai-costs.md`) only when `usesAI`; UI-related guidance only when `hasFrontend`.
- Default: skip existing files (never clobber user work); `--force` to overwrite. Preserves current bootstrap behavior.

---

## 6. Scaffold / Init Walkthrough (`rafi create`)

Small CLI that produces `project.yaml`, then calls the compiler.

### Walkthrough questions (each defaulted, all skippable with `--yes`/`--defaults`)
1. App name, timezone.
2. Frontend string (default "React with TypeScript"). "No UI" sets `hasFrontend:false`.
3. Backend string (default "Node.js").
4. Database string (default "PostgreSQL").
5. Cloud string (default "AWS"). "Local only" sets `runsInCloud:false`.
6. Package manager (default "pnpm").
7. **Uses AI? (default no) → sets `usesAI`** — this is the toggle that includes/excludes the five `ai-*` packs and the AI docs (resolved decision #1). Phrased in the walkthrough as "Will this app call LLMs / do AI generation?".
8. Harness targets (default both claude+codex).
9. QA on? (default yes).

- `--defaults` / pressing through = byte-equivalent to today's hardcoded `rules.md`.
- Writes `project.yaml` (committed, human-editable, re-compilable). Re-running the compiler after hand-editing is the supported update path.
- Future `--pack <name>` selects a preset that pre-fills answers.

### Documenting which packs were included (resolved decision #1)
So the AI-pack choice is never invisible:
- `project.yaml` records `flags.usesAI` (and `hasFrontend`, `runsInCloud`) explicitly — the choice lives in the repo.
- The compiler writes a generated header comment at the top of `AGENTS.md` / `CLAUDE.md` listing which conditional pack groups are ON/OFF (e.g. `# rafi: ai=off frontend=on cloud=on`).
- `rafi create` prints a summary after compile ("AI rules: excluded — re-run `rafi compile` after setting `usesAI: true` to add them").
- The toolkit README documents the `usesAI` flag and what it gates.

---

## 7. Foreman Integration (`packages/ai-foreman`)

### 7.1 New adapter options (`adapters/types.ts`)
```ts
interface BuilderAdapterOptions {
  // ...existing...
  systemPromptAppend?: string;   // role system text from .rafi/compiled/<role>/system.md
  skills?: string[];             // role skill names
}
```

### 7.2 Claude adapter (`adapters/claude.ts`)
Map new options onto the SDK `query` options (all **confirmed present** in installed SDK `0.3.148`):
```ts
options: {
  // ...existing...
  systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.systemPromptAppend },
  skills: opts.skills ?? [],          // SDK supports string[] | 'all'
  settingSources: ['project'],         // so compiled .claude/skills are discoverable
}
```
(`additionalDirectories` available if foreman needs to expose the framework dir.)

### 7.3 Codex adapter (`adapters/codex.ts`)
Codex `exec` only reads `AGENTS.md` from cwd → role specialization injected by **prepending the role system text to the turn instruction** (foreman already controls turn text). Builder uses the flattened `AGENTS.md`; QA/planner get their `system.md` prepended per turn. Document the degraded composition.

### 7.4 Loading role bundles in `foreman.ts`
- New module `roles.ts`: given a repo + role name, load `.rafi/compiled/<role>/{system.md,meta.json}` (compile on the fly if missing and content/ is reachable, else fall back to today's hardcoded strings → **backward compatible** with repos that never compiled).
- `buildQaInstruction` etc. become **thin**: keep the marker spec + the STEP_STATUS contract; move the verification prose into `content/agents/qa.yaml`'s pinned packs / a `qa` skill. The hardcoded prose stays as the *fallback default* when no compiled bundle exists.
- Builder turns load the `builder` bundle; QA turns load the `qa` bundle; planning/populate load the `planner` bundle.

### 7.5 Standalone publishing constraint
`ai-foreman` must `npm install -g` and work with **no** monorepo present. Therefore:
- foreman declares a normal published dependency on `special-agents` (which bundles `spec`). So `npm i -g ai-foreman` pulls the library and its composed-default agents automatically — no monorepo needed.
- The library always gives foreman the **default** composed role agents. foreman additionally layers the **target repo's** compiled bundle when present, and falls back to its current hardcoded prompt strings if `special-agents` is somehow unavailable — so it degrades gracefully at every level.

---

## 8. Skills Inventory & Gaps

Existing (`content/skills/`): `tdd`, `grill-me`, `improve-codebase-architecture`, `prd-to-issues`, `write-a-prd`, `better-sqlite3-rebuild`.

From `skillsPlan.md`, reconcile (note: "builder"/"qa" are **roles/agents**, not skills):
- "planning skill" → already covered by `write-a-prd` + `prd-to-issues`.
- "convert to deep modules" → already `improve-codebase-architecture` (+ `tdd/deep-modules.md`).
- "grill" → already `grill-me`.
- "make tickets (multi-format, ask style)" → **resolved (decision #3): a foreman command, not a skill.** It stays `ai-foreman tickets populate`, and that command runs under the dedicated **`ticket-maker` role** (§4) so the agent gets ticket-writing guidance (multi-format, ask-the-user-for-style) instead of the generic builder prompt. No standalone skill.
- "ticket-updating skill" → belongs to foreman tracker commands (`tickets update/complete/...`), not a skill. The `ticket-maker` role covers the agent-facing side.
- "QA skill" with security+style → realized as the `qa` **role** pinning `domain/security` + `base/code-quality` + `grill-me`. Optionally a small `qa-checklist` skill.

---

## 9. Phased Sequencing (with verification gates)

Each phase is independently shippable and reversible. **Gate = must pass before next phase.**

### Phase 0 — Monorepo skeleton (no behavior change)
- Add `pnpm-workspace.yaml`, root `package.json`, move `pnpm.onlyBuiltDependencies` to root.
- Move `foreman/` → `packages/ai-foreman/`; move `dummy-project` → `examples/`.
- Fix `.gitignore`; untrack `node_modules`/`dist` if tracked.
- **Gate:** `pnpm install` clean; `cd packages/ai-foreman && pnpm build && pnpm test && pnpm typecheck` all green (parity with pre-move).

### Phase 1 — `spec` package (internal)
- Define TS types + JSON Schemas for RulePack, SkillManifest(+pins), AgentManifest, project.yaml.
- Set it up to be bundled into `special-agents` at build (no separate publish).
- **Gate:** schemas validate a hand-written sample of each; `pnpm typecheck` green.

### Phase 2 — Create `special-agents` skeleton + shard rules (3a then 3b)
- Scaffold `packages/special-agents` (`content/`, `src/`, build to `dist/`).
- Mechanically split `rules.md` → `content/rules/**` (verbatim bodies). Build `packs.index.yaml`.
- Assign category/condition/template; add `{{vars}}` to the 3 templated packs; write `defaults.yaml`.
- **Gate:** a script concatenates all packs (defaults applied, all flags on) and **diffs against original `rules.md`** — differences must be only the intended placeholder substitutions and structure. Manual review of the diff.

### Phase 3 — Composition logic (`special-agents/src`)
- Implement load/validate → render → emit for **Claude first** (dogfood in *this* repo), then Codex.
- Expose the JS API (`getAgent`, `getSkill`, `compile`) and produce prebuilt-default artifacts into `special-agents/dist` (the source+prebuilt ship-both decision).
- Reproduce the existing `agent-files/AGENTS.md` from packs as a golden test.
- **Gate:** prebuilt-default `AGENTS.md` reproduces the golden byte-for-byte (modulo intended templating); `getAgent('builder')` returns the composed bundle; prebuilt `.claude/` loads in a real Claude Code session.

### Phase 4 — Agents/roles + skills move
- Move `skills/` → `special-agents/content/skills/`; delete stray root `.agents` duplicate.
- Author `content/agents/{builder,qa,planner,ticket-maker}.yaml` reproducing today's foreman prose via pinned packs.
- Wire `ai-foreman tickets populate` to load the `ticket-maker` role bundle.
- **Gate:** the API/compile emits `.rafi/compiled/<role>/system.md` for all four roles; manual review confirms each role's content ⊇ the corresponding hardcoded foreman prose.

### Phase 5 — Foreman consumes the library
- Add `special-agents` as a foreman dependency; add adapter options + `roles.ts` loader (library defaults → target-repo bundle → hardcoded fallback) + SDK wiring.
- **Gate:** run `ai-foreman start examples/dummy-project --steps 2` three ways — with a compiled target bundle, with only the library defaults, and with the library forcibly absent (hardcoded fallback) — all complete; the composed run shows role system text in the session/log.

### Phase 6 — `rafi` CLI + docs
- `rafi create` walkthrough → `project.yaml` → compile + doc copy (flag-gated); `rafi compile` for re-renders.
- **Gate:** `rafi create` on a fresh temp repo with `--defaults` yields guidance byte-equivalent to current `rules.md`; with custom answers, stack strings appear substituted.

### Phase 7 — Cleanup & publish prep
- Delete `aiTools/rules.md`, `agent-files/`, `bootstrap-project.sh`, `skillsPlan.md`, `nextAdditions.md` once parity proven.
- Top-level `README.md` documenting library / CLI / runtime + the adoption ladder.
- Verify `special-agents`, `ai-foreman`, `@rafi/cli` `files`/exports are publish-ready; foreman's dep on `special-agents` resolves from the registry (not just workspace).
- **Register the `rafi` npm org** (needed for the `@rafi/cli` scope) before first CLI publish — confirm it's available/owned.
- After first `ai-foreman` publish, `npm deprecate foreman-cli "renamed to ai-foreman"`.
- **Gate:** repo grep finds no references to deleted files; full workspace `pnpm -r build && pnpm -r test` green; `npm pack` dry-run of all three published packages (`special-agents`, `ai-foreman`, `@rafi/cli`) succeeds.

---

## 10. Decisions
**Resolved:**
- **Project name / package naming:** **Rafi** — Refined AI Framework & Implementor. Published: `special-agents` (library, free ✓), `ai-foreman` (runtime, renamed from `foreman-cli`, free ✓; command `ai-foreman`), `@rafi/cli` (CLI, command `rafi` — scoped because bare `rafi` is taken). `spec` is internal/unpublished (bundled into `special-agents`); composition logic lives inside `special-agents`, not a separate package.
- **Library/runtime split:** the content (rules + skills + agents + composition) is a standalone published library, `special-agents`. Runtime (`foreman`) and CLI (`rafi`) consume it; it never depends on them. Enables the adoption ladder (§0).
- **Ship both source + prebuilt:** `special-agents` ships its `content/` source **and** prebuilt-default `.claude/` + `AGENTS.md` in `dist`, so agents/skills can be copied in with zero build step.
- **AI packs:** conditional, gated by the `usesAI` walkthrough question, recorded in `project.yaml`, surfaced in the generated `AGENTS.md` header + post-compile summary.
- **`make-tickets`:** a foreman command (`tickets populate`) running under a dedicated `ticket-maker` role — not a skill.

**Open (defaults chosen, revisit if needed):**
1. **Templating engine:** tiny custom `{{var}}`/`{{#if}}` pass (chosen) vs. pull in handlebars.
2. **Gemini/Copilot targets:** defer to post-v1 (composition designed to add targets, not built now).
3. **Codex per-role specialization depth:** v1 = prepend role text to turn prompt (chosen) vs. temp per-role AGENTS dir.
4. **Fold foreman into the `rafi` CLI as `rafi run`?** Default: no — keep `ai-foreman` as its own published command. Revisit only if we later want a single `rafi` entrypoint and accept a package migration.

## 11. Risks & Mitigations
- **Claude/Codex capability asymmetry** (biggest): mitigate via lowest-common-denominator authoring + per-target rendering (lean Claude, flattened Codex). Mark per-skill inline-vs-reference priority so Codex flattening is principled.
- **foreman standalone install breaks** if it hard-depends on monorepo: mitigate via a normal published dep on `special-agents` (auto-installed) + graceful fallback to hardcoded prompts if the library is absent.
- **rules.md drift during shard:** mitigate via the concatenation diff gate (Phase 2).
- **Native better-sqlite3 build in workspace:** mitigate via root `onlyBuiltDependencies` + Phase 0 gate.
- **Committed node_modules/dist** from prior commit: verify + untrack in Phase 0.

## 12. What explicitly does NOT change
- The STEP_STATUS protocol, marker grammar, QA cycling, permission policy, ticket SQLite/YAML model, and the runtime's subcommands + flags (only the binary's *name* changes — see below).
- The `SKILL.md` authoring format (only an optional `pins` field added).

**What DOES change:** the runtime's npm package (`foreman-cli` → `ai-foreman`) and command name (`foreman …` → `ai-foreman …`). Subcommands, flags, and all behavior are unaffected by the rename.
```
