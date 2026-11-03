# Secrets and security presets: proposal

Status: **proposal, for your review** (2026-11-03). Nothing here changes the locked docs or code until you approve it. It answers threat 14 in `REWRITE_M2_PLAN.md` 10.7 and the direction you gave: flexible, enterprise-level options from greenfield + auto-approve to sensitive repos with every approval manual; secure variables agents can't see; a user-level secrets profile; room for the GUI and hosted rafi; and building in a workspace that can't reach your home folder.

Paths are relative to `packages/` unless they say otherwise. **Unverified** marks something I couldn't check, with what would confirm it.

## 0. The problem, checked in the code

- **Tests get everything.** `engine/src/build/checks.ts:77` passes `{ ...deps.env }`, a copy of all of `process.env` (`engine/src/deps/real/index.ts:41`). The related-tests query and, from M7, the setup script use the same `spawn`.
- **So do agents.** `engine/src/build/session.ts:52,58` gives both adapters `deps.env` (Codex: `engine/src/deps/real/agents.ts:7`; Claude: `engine/src/agents/claude/options.ts:44,56`). The SDK's `env` *replaces* the child's environment (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1369-1373`), so allowlists are possible on both sides.
- **Redaction is a net, not a wall.** It learns only values of secret-*named* variables plus fixed token shapes (`engine/src/log/redact.ts:12,17-35`). A base64 copy, a split value or an oddly named variable gets through.
- **Files leak too.** The test sandbox allows reads anywhere (`engine/src/build/sandbox.ts:17`, "allow default"), so `~/.aws/credentials`, `~/.ssh/` and `~/.npmrc` are as exposed as any variable.
- **M7 makes it real.** M2 grants nothing, so tests have no internet (M2 plan 1.3). Grants arrive in M7, so the floor must land first.

## 1. The model: who sees what

Secrets stay out of anything an agent can read. That's enforced by never putting them there, not by redacting them afterwards.

| Who | Environment | Files it can read | Secrets |
|---|---|---|---|
| **rafi itself** | Your whole shell environment (`deps.env`), as today | Everything you can | Reads the secrets store. Never writes a value to the event log, a blob, the progress file, a notification, an export or argv. Hands values only to the child processes that declared them. |
| **Agents** (Claude, Codex) | An **agent allowlist**: the base set (below), plus the runtime's own login and config variables, plus `agents.env: [NAMES]` from `rafi-config.yaml` | The worktree, and the home folder minus credential paths (presets, section 2) | **None, ever.** No store secret, and no shell variable outside the allowlist. |
| **Agents' shells** | The agent allowlist minus the runtime's own API key, where the runtime lets rafi set that: Codex's `shell_environment_policy` (`inherit`, `include_only`, `exclude` and `set` are in the codex-cli 0.164.0 binary); Claude's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` (the string is in the `claude` 2.1.317 binary). **Unverified:** what each one does. M2's live adapter check confirms it. | as above | None |
| **Test runs** (`run_check`, the check step, the related-tests query, CI points) | A **test allowlist**: the base set, cache variables, `checks.env: [NAMES]` passed through from your shell, and the secrets this run declared | The worktree; home minus credential paths | Only the names declared: `checks.secrets` for every run, plus the ticket's `needs.credentials` for that ticket's runs |
| **The setup script** (`scripts/rafi-setup.sh`, M7) | The same as test runs: it goes through the same `deps.checks.run` | as tests | as tests |

**The base set** (one table in the code): `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TZ`, `TERM`, `CI`, proxy and certificate variables, and Windows' `SystemRoot`, `ComSpec`, `PATHEXT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP` (NEW-SEC-3). **Runtime login variables** (agents only): `ANTHROPIC_*`, `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR` (plus Bedrock or Vertex variables when those are on), `OPENAI_*`, `CODEX_HOME`. They're your own login, passed through and never stored (decision 4).

**Why tests may hold secrets but agents may not.** Tests and the setup script are code the agent wrote. A test holding a secret can print, encode or send it. So the guarantee is "agents never *see* a secret," and four things bound the rest:

1. **Least privilege.** A run gets only the names it declared; a ticket's credentials reach only its runs.
2. **Redaction learns every value handed out**, whatever its name, plus its base64, base64url, hex and URL-encoded forms. This catches casual encodings, not deliberate ones.
3. **No secret plus internet without you**, as the preset says (section 2).
4. **In `sensitive`, secrets go only to rafi's own runs.** These are the check step's runs, after the agent's session has ended. An agent's own `run_check` calls run without secrets and are told so. That matters because a live agent process running as the same OS user may read a running test's environment from the process table: Linux allows that by default (`/proc/<pid>/environ`). **Unverified** on macOS: a `ps eww` probe here showed nothing, but this session runs in a sandbox. Only a separate user or container (section 4) closes this fully.

## 2. Presets

Three named presets. Each one is only a bundle of default values for ordinary keys, so a project can override any piece.

| | `greenfield` | `standard` (default) | `sensitive` |
|---|---|---|---|
| **For** | A new repo, nothing to protect, speed first | Everyday work on your own projects | Client or production code, regulated repos, real credentials nearby |
| `approvals.mode` | `auto` | `manual` | `manual`; `--auto-approve` refused for this project |
| `plan_updates` | `change-then-tell` | `change-then-tell` | `ask-first` |
| Internet, installs, services | Auto-approve's one warning (Q-APR-1, unchanged) | Asked up front, as today | Asked up front. `grants.remember: false`: "Allow once" only, no "Always allow" (`--allow` still works per build) |
| No sandbox on this machine (`checks.sandbox`) | `preferred`: warning, auto-approve accepts (as today) | `preferred`: warning, you accept (as today) | `required`: the build doesn't start, and the "run without a sandbox" choice isn't offered |
| Test environment | Test allowlist + `checks.env` | same | same |
| Store secrets for tests | Declared names: store first, then your shell | same | Declared names, **store only** (a stray shell variable never flows), and only to rafi's own runs |
| A secret and internet in one run (`checks.secrets_with_internet`) | `allow` | `warn`: one line in the upfront list ("T20's tests get STRIPE_KEY and internet") | `ask`: an upfront item per secret and ticket, "Allow once" only |
| Home folder (`isolation.home`) | `guarded`: credential paths can't be read | `guarded` | `empty`: tests and agents get an empty per-project `HOME`; the real home is unreadable except the runtimes' login folders |
| Workspace (`isolation.workspace`, later) | `in-place` | `in-place` | `separate` once it's built (section 4); until then `in-place` with `empty` home |

The floor is the same in every preset: agents never get secrets, tests get the allowlist, and redaction learns every value handed out. Presets change approvals and access, never the floor.

**`guarded` paths**, denied for reading in rafi's sandbox and in Claude's `sandbox.filesystem.denyRead` (`sdk.d.ts:2513`): `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.azure`, `~/.kube`, `~/.docker/config.json`, `~/.npmrc`, `~/.pypirc`, `~/.netrc`, `~/.gnupg`, `~/.config/gh`, `~/.git-credentials`, `~/.rafi`, plus `isolation.deny_read`. **Unverified:** whether Codex's sandbox can deny reads (none found in 0.164.0). Until then, `guarded` on Codex covers only rafi's test runs, and the upfront list says so.

**Choosing a preset:**

- **Saved:** `security.preset` in `rafi-config.yaml`, which is committed, so the team shares it. `rafi create` asks: "What kind of project is this? New and disposable / Everyday / Sensitive".
- **Missing:** one upfront item, like `plan_updates`. Auto-approve fills in `standard` and never loosens a saved preset (as D3).
- **Per build:** `--set security.preset=…`. A looser one shows in the upfront list: "Security: greenfield for this build (--set); the project says standard."
- **Org:** `~/.rafi/policy.yaml` `locked:` can lock the preset or any of its keys (ARCH 8.6).

**Overriding part of one.** The project sets that key itself (for example, `sensitive` with `plan_updates: change-then-tell`). Layers, lowest first: defaults, the preset, the org policy (locked keys win), `rafi-config.yaml`, then flags and `--set`. Each key keeps its source (`preset:sensitive`); `build.started` records them and `rafi doctor` prints them (S-CLI-19).

## 3. Where secrets live

- **Values** live only in the OS secret store: macOS Keychain, libsecret on Linux, and Windows Credential Manager once Windows is supported (with the GUI). Each is an item under the service `rafi`, account `<profile>/<NAME>`.
- **Names and bindings** live in `~/.rafi/secrets.yaml`, with no values:

  ```yaml
  profiles:
    default:   [STRIPE_TEST_KEY, SENTRY_DSN]
    acme:      [ACME_DB_URL, ACME_S3_KEY]
  projects:
    /Users/tyler/reps/acme: acme        # every other project uses default
  ```

- **Never** in the repo, the event log, blobs, the progress file, exports, notifications, argv or the GUI. The project commits only *names*: `checks.secrets: [STRIPE_TEST_KEY]` and tickets' `needs.credentials`.
- **`rafi secrets`** (new, CMD-38):
  - `set NAME [--profile p]`: hidden input, `--stdin` or `--from-env NAME`; never a value on argv, which shows in `ps` and shell history.
  - `list`: names, where used, when set; never values.
  - `check`: whether each declared name is found, and where.
  - `remove NAME`, and `use <profile>` to bind this project.
  - Later: `import .env`, which moves a dotenv file into the store.
- **Provider logins are refused.** `rafi secrets set ANTHROPIC_API_KEY` exits 1: "Log in with `claude`; rafi doesn't store provider credentials" (decision 4).
- **`needs.credentials`.** The upfront check (ARCH 7.2) resolves each name from the bound profile, then (except in `sensitive`) from your shell; never its value. A missing name becomes: "API key, for T11: STRIPE_KEY isn't set. Add it with `rafi secrets set STRIPE_KEY`" › "I've added it (check again)" / Answer later. The question never takes the value (S-BLK-9 holds). A found name reaches that ticket's runs only.
- **Records.** `check.run` records `secrets: [names]` and `env_missing: [names]`, never values or digests (a short secret's digest can be guessed).
- **No OS store** (headless Linux, CI): declared names come from the shell, which is CI's own secret mechanism. There's no rafi-encrypted file in 1.0, because its key would need a home too.
- **A hint, to you only.** When a failing run's output names a variable rafi withheld: "T3's tests may need DATABASE_URL; add it to `checks.env`."
- **Unverified:** how to reach the store (a native keyring module, or `secret-tool` reading stdin; never `security … -w <value>` on argv), and whether Keychain asks again after a Node upgrade. The M7 plan decides, with a probe.

## 4. Isolation: building somewhere that can't reach your home

Your idea, building "in a different repo that doesn't have access to root stuff," is a different tool from the sandbox:

- The **sandbox** limits what a process may touch. It's a deny list, so it must name every secret path, and Codex's reads aren't covered.
- **Isolation** changes what exists to be touched. It's an allowlist by construction.

| Level | What it is | What it buys | What it costs |
|---|---|---|---|
| `guarded` home (1.0) | Read-deny of credential paths | Stops common file leaks for tests and Claude | A deny list can miss paths; not enforced on Codex |
| `empty` home (1.0) | Children get `HOME=.rafi/home/`; the real home is unreadable except the runtimes' login folders | No dotfiles to find: no `~/.npmrc` token, no git credentials | Tests or setup that rely on dotfiles break until you set `checks.env` or a secret. Keychain logins should still work (**unverified**; live check) |
| `separate` workspace (after 1.0) | rafi clones the project to `~/.rafi/workspaces/<id>/`; agents and tests work only there; rafi, outside, keeps its state, git credentials and the store, and delivers by pushing | Agents can't reach your checkout, its `.rafi/` and `.tickets/`, other repos or uncommitted work. **This is threat 30's option (c)** | Disk space and a cold first install. You see the work through the branch or PR, not live in your editor, so it pairs with `git.managed_by: rafi`. Git run there with hooks and `core.fsmonitor` off (threat 9). Changes ARCH 3.1 |
| `container` (hosted) | The workspace in a container or VM, under another user | A separate user, process table and network; closes section 1's process-table gap; the hosted default | Docker or a VM, with `claude` and `codex` logged in inside (GUI open question 6); no Xcode or simulators |

**Threat 30.** `.rafi-build/threat30-options.md` didn't exist when I wrote this, so I haven't read it. I suggest fixing threat 30 now with option (a) (Codex approval policy `untrusted`) for every preset, since `greenfield` and `standard` build in place. Once `separate` exists, make it the `sensitive` default; it brings option (c) for those builds.

## 5. The GUI and hosted rafi

What the design needs now so neither one forces a rewrite:

- **A seam, `deps.secrets: SecretStore`** (`list`, `get`, `set`, `remove`, `bindings`). Backends: `keychain`, `libsecret`, `wincred`, `env` (read-only, your shell); later `vault` (HashiCorp, AWS, GCP, Azure; GUI-ENT-7) and a hosted per-tenant store. The harness gets an in-memory store with **canary values**, so tests can grep every output for them.
- **Engine actions `engine.secrets.*`**, for the CLI and the GUI. Values are **write-only** (replace, never reveal). The action record keeps the name, the profile and who did it; the value never enters the event, the idempotency key or `engine.preview()`.
- **GUI:** a Secrets page per project (names, set or missing, which tickets need each, a masked Add form that writes straight to the store). The upfront credential item links to it; the question modal never takes a value. Presets are one "Security" picker, with each overridden key and its source (GUI-R20).
- **Hosted:**
  - The control plane holds names and access rules only.
  - A managed runner fetches values for one run with a short-lived, run-scoped token and keeps them in memory, in the child's environment only.
  - A customer-owned runner reads the customer's own vault, so values stay in their network (GUI-REM-2).
  - The browser never gets a value (GUI-REM-3).
  - Per tenant: its own store namespace and key, its own runner pool, a fresh container per build, no shared caches.
- **No secret in any log or export.** `rafi logs export`, `rafi stats export`, `detailed` capture and the diagnostics bundle (GUI-IDEA-05) carry names only. A release-gate test greps every artifact for each canary and its encodings.

## 6. What goes in which milestone

**M2 (now): the minimal, safe piece.** Small, no new command, no store.

1. **Test allowlist** for every `spawn` in `build/checks.ts`: the base set, cache variables, and `checks.env: [NAMES]` from your shell. One new pure module (about 120 lines) holds the base set and the runtime tables.
2. **Secret-free agent environments:** Claude's `env` and Codex's app-server `env` become the agent allowlist plus `agents.env`. Codex's `shell_environment_policy` is set in the thread config so its shells match, if the live check confirms what it does; otherwise that part moves to M7.
3. **Redaction learns more, and in encoded forms.** It registers the values of secret-named shell variables (as now) and of any `checks.env` or `agents.env` name that looks secret, each with its four encodings.
4. **Records:** `check.run` gains `env_missing: [names]`; `rafi doctor` lists `checks.env` names that aren't set.
5. **Tests:**
   - a canary variable outside the allowlist never reaches a test, an agent's environment or the Codex thread;
   - a `checks.env` name does reach tests;
   - a canary printed as base64 is redacted;
   - no canary in any event, blob, the terminal or `stats export`.

   This closes threat 14's environment half before grants exist.

**M5:** org-locked preset keys come free with org-locked settings.

**M7** (grants arrive here, so the rest must land with them):
- the store, `rafi secrets` and `~/.rafi/secrets.yaml`;
- `checks.secrets` and `needs.credentials` resolved from the store;
- the three presets and their keys;
- the preset upfront item;
- `checks.secrets_with_internet`;
- `checks.sandbox: required`;
- `grants.remember`;
- `guarded` and `empty` home for rafi's sandbox and Claude;
- secrets only in rafi's own runs for `sensitive`;
- the "may need" hint.

**M10:** the preset question in `rafi create`; release-gate canary grep over every artifact.

**After 1.0:** the `separate` workspace (with threat 30 (c) for those builds), `rafi secrets import`, Windows Credential Manager (with Windows support), vault backends, the GUI Secrets page (GUI phase 1–2), and the hosted store and `container` level (GUI phase 6).

## 7. Locked-doc changes to approve

**`REWRITE_ARCHITECTURE.md`**
- **1.2:**
  - The "Secrets leak" row gains "redact() learns every value rafi hands a child, with encodings".
  - The phrase "credentials are named, never stored" becomes "named in the project, stored only in the OS secret store (7.12)".
  - Two new rows. *Agents read secrets*: allowlisted agent environments, guarded or empty home. *A test sends a secret out*: declared names only, `secrets_with_internet`, and in `sensitive`, rafi's own runs only.
- **3.4:** `check.run` gains `secrets` and `env_missing` (names only).
- **3.8:** a `~/.rafi/secrets.yaml` row.
- **6.9** "Where and with what access": a bullet for the test allowlist, `checks.env` and declared secrets.
- **7.2 and 7.3:** the Credentials row resolves from the store, then the shell; the item text names `rafi secrets set`.
- **7.4:** auto-approve fills `security.preset` with `standard` and never loosens it.
- **7.11:** a bullet for a secret plus internet, and the guarded and empty home mapped onto each runtime.
- **New 7.12, "Secrets and presets":** sections 1–3 of this doc, condensed.
- **8.2:** a `secrets: SecretStore` seam; the `env` comment adds "never passed whole to a child".
- **8.6:** the preset layer.
- **10.2:** the setup script gets the test environment.
- **11.5:** provider login variables pass through, and the store refuses them.
- **13:** the new keys.
- **14:** M2, M7 and M10 Builds and Security lines as in section 6 above; 14.2 counts.
- **15:** decision 12, "Secrets and presets" (REQ ARCH-14).

**`REWRITE_REQUIREMENTS.md`**
- **2.1:** CMD-38, `rafi secrets set|list|check|remove|use`.
- **5.5:**
  - FMT-C27 `security.preset`;
  - FMT-C28 `checks.env`;
  - FMT-C29 `checks.secrets`;
  - FMT-C30 `agents.env`;
  - FMT-C31 `isolation.home` (`real`, `guarded`, `empty`), plus `isolation.deny_read`;
  - FMT-C32 `grants.remember`;
  - FMT-C33 `checks.secrets_with_internet` (`allow`, `warn`, `ask`);
  - FMT-C34 `checks.sandbox` (`preferred`, `required`);
  - `isolation.workspace` reserved and rejected, as `workflows:` is.
- **8.25:**
  - NEW-SEC-5: agents get the agent allowlist, never a store secret.
  - NEW-SEC-6: test runs and the setup script get the test allowlist plus declared names, and a ticket's credentials reach only its runs.
  - NEW-SEC-7: values only in the OS store; names in `~/.rafi/secrets.yaml`; never in the repo, the log, an export, a notification, argv or the GUI; provider logins refused.
  - NEW-SEC-8: redaction learns every value handed out, with encodings.
  - NEW-SEC-9: three presets, layered, overridable, lockable; auto-approve never loosens.
  - NEW-SEC-10: guarded and empty home.
  - NEW-SEC-11: a secret plus internet follows the preset; in `sensitive`, secrets go only to rafi's own runs.
  - NEW-SEC-12: the `deps.secrets` seam, write-only values, and per-tenant isolation designed for.
- **NEW-SEC-4:** add "unless `checks.sandbox: required`, which refuses."
- **9.0:** an ARCH-14 decision row.

**`REWRITE_SCENARIOS.md`** (four new scenarios, 122 → 126)
- **S-SEC-1, agents never see a secret.** Canary shell variables and store secrets are absent from both runtimes' environments and the Codex shell policy. Partial in M2 (environments); full in M7, where reads of a guarded path and of the real home under `empty` are denied.
- **S-SEC-2, tests get only what they declared** (full in M2): an undeclared variable is absent; a `checks.env` name is present; base64 and hex canaries are redacted; no canary in any event, blob, terminal output or export.
- **S-SEC-3, `rafi secrets`** (M7): set with hidden input, list without values, check, remove; a provider key refused; the upfront credential item resolves from the store, and its question takes no value; a ticket's secret reaches only its runs.
- **S-SEC-4, presets** (M7): chosen, overridden per key with sources shown, locked by policy; auto-approve fills `standard`; `sensitive` refuses a missing sandbox, offers no "Always allow", asks before a secret plus internet, and keeps secrets out of agent-called runs.
- **S-CLI-1:** its command list gains `rafi secrets`, which says "not built yet" and exits 1 until M7.

**`REWRITE_M2_PLAN.md` 10.7** (another session owns it; not edited here): row 14 would point at this decision and S-SEC-2.

## 8. Product questions

1. **Allowlist by default:** should tests get only the base set plus `checks.env` names in every preset, though some existing tests fail until you list what they need?
   *Recommended: yes.* It's the only fix that doesn't depend on guessing names, and the "may need" hint makes the fix one line.
2. **Storing values:** may rafi store secret values, only in the OS store via `rafi secrets set`?
   *Recommended: yes.* Questions and notifications still never take a value, and Claude and Codex logins are refused, so S-BLK-9 and decision 4 hold; only 1.2's "never stored" wording changes.
3. **No OS store:** on headless Linux and CI, use the shell environment, with no rafi-encrypted file in 1.0?
   *Recommended: yes.* CI already has its own secrets, and an encrypted file just moves the problem to its key.
4. **Presets:** `greenfield`, `standard` (default), `sensitive`, with auto-approve never picking a looser one?
   *Recommended: yes.* Three names cover your two ends and the middle; anything finer is a per-key override.
5. **Secret plus internet:** in `sensitive`, does a run holding a secret get internet only if you allow it for that build?
   *Recommended: yes, per secret and ticket, "Allow once" only.* It's the one combination that turns a leak into a loss.
6. **Separate workspace:** after 1.0, with 1.0 shipping the guarded or empty home plus threat 30's option (a)?
   *Recommended: yes.* The workspace changes ARCH 3's layout and delivery; the home levels get most of the benefit at a fraction of the cost.
