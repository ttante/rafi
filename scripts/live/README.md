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
| `structured-output.mjs` | `RAFI_LIVE_STRUCTURED=1` and future `RAFI_LIVE_DEADLINE` | Bounded text/structured result, schema change, session resume and interruption interface probes. See `../comms/README.md`; not a production migration gate. | macOS/Linux; selected provider CLI authenticated. |
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

### Native handoff, large contract and compaction conformance

`RAFI_LIVE_STRUCTURED=1 RAFI_LIVE_DEADLINE=<future-ISO-time> pnpm canary:structured-handoffs` exercises the actual production adapters, durable handoff service, contract delivery and continuity wrapper. Use `RAFI_LIVE_PROVIDERS=claude` or `codex` for a focused rerun. It bounds host dispatches to twelve per provider and turns to 90 seconds within the absolute deadline. The fixture denies domain tools and uses synthetic work: successful transport does not certify product behavior.

Evidence includes predecessor/successor identities, exact resource transfer, a 360 KB Unicode contract context, observed native compaction, rejection of the old delivery receipt, renewal, and a final checkpoint with no unresolved dispatch. Results retain failures, provider versions and source hashes outside the provider workspace.

The public `canary:incident-journeys` now freezes the compiled workspace packages into its evidence directory and records a file manifest and digest. External dependencies remain local links. This prevents concurrent packaging tests from replacing the CLI or internal package code between journey phases. Rebuild before each new candidate; do not infer freshness from Git HEAD alone in a dirty working tree.

The public CLI journey requires a consumed QA certificate and completed ticket-finalization record for **each** of its two approved tickets. It follows up to two independently scheduled delivery units through the public approval/resume commands and stops if a unit makes no certified progress. A certificate without successful finalization, an invalidated certificate, or implemented source alone is insufficient. The harness supports explicitly continuing a completed unit only with the same compiled-candidate digest and predecessor evidence ledger (`RAFI_LIVE_CONTINUE_COMPLETED=1`, `RAFI_LIVE_PREDECESSOR_EVIDENCE`, and `RAFI_LIVE_CONTINUE_INTERRUPTED_PROJECT`); this never replays an uncertain failed dispatch.
