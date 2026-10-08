/** Opt-in build-stall canaries. Every build uses a disposable repository. */
import { createHash } from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { cmdInit, cmdUpdate } from "../packages/ai-foreman/src/tickets/commands.js";
import { readBuildRuns } from "../packages/ai-foreman/src/buildRuns.js";
import { DEFAULT_AUTONOMY_CONFIG, validateAutonomyConfig } from "../packages/ai-foreman/src/recoveryPolicy.js";
import { WorkflowReader } from "../packages/ai-foreman/src/workflowReader.js";
import { WorkflowDb } from "../packages/ai-foreman/src/workflowDb.js";
import { collectManagerDiagnostics } from "../packages/ai-foreman/src/diagnostics.js";

if (process.env.RAFI_LIVE_BUILD_STALLS !== "1") throw new Error("Set RAFI_LIVE_BUILD_STALLS=1 only after authorizing provider usage.");
const samples = Number(process.env.RAFI_LIVE_SAMPLES ?? "5");
if (!Number.isInteger(samples) || samples < 1 || samples > 20) throw new Error("RAFI_LIVE_SAMPLES must be between 1 and 20");
const scenarios = (process.env.RAFI_LIVE_SCENARIOS ?? "current,branch-qa").split(",");
if (scenarios.some(value => !["current", "branch-qa"].includes(value))) throw new Error("unknown scenario");
const root = mkdtempSync(join(tmpdir(), "rafi-live-build-stalls-"));
const workspace = resolve(fileURLToPath(new URL("..", import.meta.url)));
const results: unknown[] = [];
const versions: Record<string, unknown> = { hostDigest: createHash("sha256").update(["cli/start.js", "supervisedStart.js", "adapters/codex.js", "adapters/claude.js", "foreman.js"].map(path => readFileSync(join(workspace, "packages/ai-foreman/dist", path), "utf8")).join("\n")).digest("hex") };
const save = () => writeFileSync(join(root, "results.json"), JSON.stringify({ node: process.version, versions, samples, scenarios, results }, null, 2));
console.log(JSON.stringify({ kind: "canary-root", root }));

async function run(provider: "codex" | "claude", scenario: string, sample: number) {
  const dir = join(root, `${provider}-${scenario}-${sample}`); mkdirSync(dir);
  execFileSync("git", ["init", "-q", dir]);
  cmdInit(dir, { appName: "Build stall canary", timezone: "UTC" });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module", scripts: { test: "node --test sum.test.js" } }));
  writeFileSync(join(dir, "sum.js"), "export function sum(a, b) { throw new Error('not implemented'); }\n");
  writeFileSync(join(dir, "sum.test.js"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { sum } from './sum.js'; test('sum', () => { assert.equal(sum(2, 3), 5); assert.equal(sum(-4, 2), -2); assert.equal(sum(0, 0), 0); });\n");
  const original = readFileSync(join(dir, "sum.js"), "utf8");
  const originalTests = readFileSync(join(dir, "sum.test.js"), "utf8");
  const ticket = { id: "T001", order: 1, title: "Implement numeric sum", area: "core", priority: "P1", size: "M", risk: "Low", summary: "Implement sum(a,b) in sum.js as numeric addition. Do not change tests. Use only Node built-ins; no dependency installation or network needed.", acceptance: ["sum returns numeric addition for positive, negative and zero inputs", "Keep sum.test.js unchanged"], required_tests: ["node --test sum.test.js"], likely_files: ["sum.js"], depends_on: [] };
  writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [ticket] }));
  cmdUpdate(dir, "T001", { status: "next", actor: "canary" });
  const role = { make: provider, model: "default", reasoning: "default", fast: false, session_strategy: "compact", display_session_cost: false, auto_compact_threshold_percent: 65, compact_maximum: 10 };
  writeFileSync(join(dir, "rafi-config.yaml"), stringify({ docs: { root: "docs" }, agent_defaults: { version: 1, revision: 1, roles: { builder: role, qa: { ...role, session_strategy: "fresh" } } }, autonomy: validateAutonomyConfig({ ...DEFAULT_AUTONOMY_CONFIG, runtime_deadlines: { turn_ms: 300000 } }) }));
  writeFileSync(join(dir, "foreman.yaml"), stringify({ notifications: { enabled: false, terminal_bell: false } }));
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Rafi Canary", "-c", "user.email=canary@example.test", "commit", "-qm", "canary baseline"]);
  const started = Date.now(); let firstImplementationMs: number | undefined;
  const logPath = join(root, `${provider}-${scenario}-${sample}.log`);
  const fd = openSync(logPath, "w", 0o600);
  const args = [join(workspace, "packages/ai-foreman/dist/index.js"), "start", dir, "--steps", "1", "--yes", "--agent", provider,
    ...(scenario === "current" ? ["--no-qa"] : ["--branch-per-ticket", "--completion", "none", "--keep-worktrees"])];
  const child = spawn(process.execPath, args, { cwd: workspace, env: { ...process.env, RAFI_BUILD_WORKER_RUN: "", RAFI_DETACHED_SUPERVISOR_RUN: "" }, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const checkSource = () => {
    if (firstImplementationMs !== undefined) return;
    const record = readBuildRuns(dir)[0];
    const directories = new Set([dir, record?.repository.worktree].filter(Boolean) as string[]);
    const db = new WorkflowReader(dir);
    try { for (const session of db.branchResumeSessions(false)) directories.add(session.worktreePath); } finally { db.close(); }
    for (const directory of directories) {
      const path = join(directory, "sum.js");
      if (existsSync(path) && readFileSync(path, "utf8") !== original) { firstImplementationMs = Date.now() - started; break; }
    }
  };
  // Read-only source observation; do not open a workflow writer while migration
  // or lease acquisition is occurring in the child.
  const timer = setInterval(() => { try {
    checkSource();
  } catch { /* child may be between filesystem operations */ } }, 100);
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 600000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearInterval(timer); clearTimeout(deadline);
  try { checkSource(); } catch { /* keep incomplete evidence explicit */ }
  const record = readBuildRuns(dir)[0];
  let diagnostics: unknown; let handoffs = 0; let dispatches = 0;
  let independentlyVerified = false;
  if (record) {
    try { diagnostics = collectManagerDiagnostics(dir, { runId: record.runId, external: "off" }); } catch (error) { diagnostics = { error: String(error) }; }
    const db = new WorkflowDb(dir);
    try { handoffs = db.handoffs(record.runId).length; dispatches = db.operations(record.runId).filter(item => item.kind === "provider-dispatch").length; } finally { db.close(); }
  }
  if (code === 0 && record) {
    const reader = new WorkflowReader(dir);
    try {
      const candidate = scenario === "current" ? dir : reader.branchResumeSessions(false).find(item => existsSync(join(item.worktreePath, "sum.js")))?.worktreePath;
      if (candidate) {
        const verification = spawnSync(process.execPath, ["--test", "sum.test.js"], { cwd: candidate, encoding: "utf8", timeout: 30000 });
        independentlyVerified = verification.status === 0 && readFileSync(join(candidate, "sum.test.js"), "utf8") === originalTests;
      }
    } finally { reader.close(); }
  }
  const result = { provider, scenario, sample, dir, logPath, code, timedOut, independentlyVerified, elapsedMs: Date.now() - started, firstImplementationMs, firstImplementationMeasurement: "100ms source polling including authoritative worktree pointers", status: record?.status, handoffs, dispatches, diagnostics };
  results.push(result); save();
  console.log(JSON.stringify({ ...result, diagnostics: undefined }));
  return code === 0 && record?.status === "completed" && independentlyVerified;
}

await Promise.all((["codex", "claude"] as const).map(async provider => {
  const version = spawnSync(provider, ["--version"], { encoding: "utf8", timeout: 10000 });
  const auth = spawnSync(provider, provider === "codex" ? ["login", "status"] : ["auth", "status"], { encoding: "utf8", timeout: 10000 });
  versions[provider] = { version: version.stdout.trim(), authenticated: auth.status === 0 };
  save();
  if (auth.status !== 0) { console.log(JSON.stringify({ provider, skipped: "not authenticated" })); return; }
  for (const scenario of scenarios) for (let sample = 1; sample <= samples; sample++) {
    if (!await run(provider, scenario, sample)) { console.log(JSON.stringify({ provider, stopped: "canary failed; inspect before spending further quota" })); return; }
  }
}));
save();
console.log(JSON.stringify({ kind: "canary-finished", results: join(root, "results.json") }));
