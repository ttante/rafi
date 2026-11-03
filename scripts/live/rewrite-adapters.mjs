// M2 plan 1.4: the live adapter check. Drives the built engine's real Claude and Codex adapters
// (`packages/engine/dist`) against the real providers, with the user's existing logins; nothing is configured.
// Paid: needs RAFI_LIVE_ADAPTERS=1 and a future RAFI_LIVE_DEADLINE. Not part of the fast suite or the gate.
//   pnpm -r --filter "@rafi-ai/engine..." build
//   RAFI_LIVE_ADAPTERS=1 RAFI_LIVE_DEADLINE=<ISO> node scripts/live/rewrite-adapters.mjs [--rows=a,b] [--out=DIR]
//   node scripts/live/rewrite-adapters.mjs --list      (free: loads every row and prints its name and turns)
// Models: RAFI_LIVE_CLAUDE_MODEL (default haiku), RAFI_LIVE_CODEX_MODEL (provider default), RAFI_LIVE_CODEX_EFFORT
// (default low). One model turn per row, except codex-compaction and claude-env (two each). A provider that isn't
// logged in is "skipped (not logged in)"; a row past its deadline or out of quota is "not run (deadline)" or
// "not run (quota)", never a failure (SCN 7.10). Every wire message is logged to <out>/<row>.log, token redacted.
// Rows live in rewrite-adapters/ (M2 plan 11.6); `--rows=` names are unchanged.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLAUDE_ROWS } from "./rewrite-adapters/claude-rows.mjs";
import { CODEX_ROWS } from "./rewrite-adapters/codex-rows.mjs";
import { live } from "./rewrite-adapters/harness.mjs";

const ROWS = { ...CLAUDE_ROWS, ...CODEX_ROWS };
const TWO_TURNS = new Set(["codex-compaction", "claude-env"]);
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (process.argv.includes("--list")) {
  for (const name of Object.keys(ROWS)) console.log(`${name}\t${TWO_TURNS.has(name) ? 2 : 1} turn(s)`);
  process.exit(0);
}
live.out = path.resolve(arg("out") ?? "/private/tmp/rafi-live-adapters");
live.deadline = Date.parse(process.env.RAFI_LIVE_DEADLINE ?? "");
const ONLY = arg("rows")?.split(",") ?? null;
if (process.env.RAFI_LIVE_ADAPTERS !== "1" || !(live.deadline > Date.now())) {
  console.error("The live adapter check is paid: set RAFI_LIVE_ADAPTERS=1 and a future RAFI_LIVE_DEADLINE.");
  process.exit(2);
}
live.claudeModel = process.env.RAFI_LIVE_CLAUDE_MODEL ?? "haiku";
live.codexModel = process.env.RAFI_LIVE_CODEX_MODEL || undefined;
live.codexEffort = process.env.RAFI_LIVE_CODEX_EFFORT ?? "low";
mkdirSync(live.out, { recursive: true });
const STATE = path.join(live.out, "state.json");
live.state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};

const onPath = (name) => (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, name))
  .find((f) => path.isAbsolute(f) && existsSync(f)) ?? null;
live.exe = { claude: onPath("claude"), codex: onPath("codex") };
function loggedIn(runtime) {
  if (!live.exe[runtime]) return false;
  if (runtime === "codex") return spawnSync(live.exe.codex, ["login", "status"], { stdio: "ignore" }).status === 0;
  const r = spawnSync(live.exe.claude, ["auth", "status"], { encoding: "utf8" });
  try { return JSON.parse(r.stdout).loggedIn === true; } catch { return false; }
}

const version = (exe) => (exe ? spawnSync(exe, ["--version"], { encoding: "utf8" }).stdout.trim() : null);
const summary = { at: new Date().toISOString(), out: live.out,
  versions: { claude: version(live.exe.claude), codex: version(live.exe.codex) },
  models: { claude: live.claudeModel, codex: live.codexModel ?? "(default)", codexEffort: live.codexEffort },
  rows: {} };
const login = { claude: loggedIn("claude"), codex: loggedIn("codex") };
for (const [name, run] of Object.entries(ROWS)) {
  if (ONLY && !ONLY.includes(name)) continue;
  const runtime = name.split("-")[0];
  if (!login[runtime]) { summary.rows[name] = { result: "skipped (not logged in)", turns: 0 }; continue; }
  try {
    const { r, turns, checks, skipped } = await run();
    const status = skipped ? `skipped (${skipped})` : r.status === "done" ? "ran" : `not run (${r.status})`;
    summary.rows[name] = { result: status, turns: turns ?? 0, ms: r?.ms ?? null, last: r?.last ?? null, checks,
      permissions: r?.permissions };
  } catch (error) {
    summary.rows[name] = { result: "error", error: String(error?.stack ?? error) };
  }
  writeFileSync(STATE, JSON.stringify(live.state, null, 2));
  console.log(JSON.stringify({ row: name, ...summary.rows[name] }, null, 2));
}
writeFileSync(path.join(live.out, `summary-${Date.now()}.json`), JSON.stringify(summary, null, 2));
