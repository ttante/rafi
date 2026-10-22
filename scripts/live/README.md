# Rafi live canaries

These are internal, opt-in diagnostics for real Claude/Codex connections and
recovery behavior. They are deliberately excluded from ordinary tests,
`prepublishOnly`, and both published npm packages.

Run them only with explicit authorization for paid/provider activity. Build the
workspace first; the CLI-journey scripts import `packages/*/dist`.

```bash
pnpm build
export RAFI_LIVE_DEADLINE="2026-10-16T20:00:00Z" # a short, approved deadline
```

`incident-journeys.mjs` also verifies that every package entrypoint in
`dist/` is newer than the TypeScript source tree and records a source digest
and the freshness timestamps in its evidence ledger. If that check fails,
rebuild with `npm run build` (or `pnpm build`) before starting a canary.

All runs must use disposable projects. Never point a canary at a user project,
publish packages, push Git changes, or run multiple provider canaries against
the same account/session concurrently. Retain evidence outside the project
under test. The scripts fail closed unless their explicit authorization
variable is set.

| Script | Authorization | Purpose | Platform |
| --- | --- | --- | --- |
| `build-stalls.ts` | `RAFI_LIVE_BUILD_STALLS=1` | Disposable Builder/QA stall and activity-recovery matrix. | macOS/Linux; requires selected provider CLI. |
| `claude-compaction.ts` | `RAFI_LIVE_COMPACTION=1` | Claude compaction control evidence; no model turn by default. | macOS/Linux; requires Claude CLI. |
| `claude-policy-routing.ts` | `RAFI_LIVE_RECOVERY=1` | Claude project-policy versus host-policy routing. | macOS/Linux; requires Claude CLI. |
| `fast-mode.ts` | `RAFI_LIVE_FAST_MODE=1` | Claude/Codex fast-mode capability and fallback canary. | macOS/Linux; requires selected provider CLI. |
| `recovery-boundaries.ts` | `RAFI_LIVE_RECOVERY=1` | CWD, exact-session, shell-policy, and handoff boundaries. | macOS/Linux; contains POSIX virtualenv paths. |
| `incident-journeys.mjs` | `RAFI_LIVE_INCIDENT=1` | Public create-to-build journeys plus guarded interruption/reset/start-over. | macOS/Linux; uses Unix signals. |
| `multiticket-recovery.mjs` | `RAFI_LIVE_MULTITICKET=1` | Eight-ticket, same-run resume and QA recovery canary. | macOS/Linux; guarded native-history quarantine/restoration for disposable sessions only. |

Set `RAFI_LIVE_PROVIDERS=claude`, `codex`, or `claude,codex` where a script
supports provider selection. Use the explicit package aliases (or the
equivalent Node command) for TypeScript scripts:

```bash
RAFI_LIVE_FAST_MODE=1 pnpm canary:fast-mode
```

The two `.mjs` CLI journeys run with Node after `pnpm build`. Windows support
is intentionally not claimed for the POSIX scripts above; port each shell,
signal, virtualenv, and native-history operation before enabling it there.

## Agent platform note

Do not run a canary merely because its source file is present. Several use
Unix process groups and `SIGTERM`/`SIGKILL` to create controlled interruption
scenarios; those assumptions are not equivalent to native Windows process
handling. `recovery-boundaries.ts` also uses POSIX virtualenv paths, and
`multiticket-recovery.mjs` inspects provider history in the current platform's
home directory.

On Windows, use **WSL2**, not WSL1 or a `/mnt/c/...` checkout: install Node and
the provider CLIs inside the distro, authenticate there, and clone/work under
the Linux filesystem (for example `~/repos/rafi`). WSL provider sessions and
credentials are distinct from Windows-native sessions, so never use these
canaries to inspect, move, or resume Windows-native provider history. Native
Windows support requires a dedicated port and validation of every signal,
process-containment, path, virtualenv, and history operation.

The older `scripts/live-create.mjs`, `scripts/live-ticket-plan.mjs`, and
`scripts/live-interview.mjs` remain at the root because package commands call
them directly. They are separate live smoke tests, not release gates.
