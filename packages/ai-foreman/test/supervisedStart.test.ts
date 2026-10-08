import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readBuildRuns } from "../src/buildRuns.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { WorkflowReader } from "../src/workflowReader.js";
import { processStartIdentity } from "../src/processIdentity.js";

for (const mode of ["current", "question", "branch", "crash", "preparation-crash", "detached", "parent-death", "cancel", "competing", "hung-worker"] as const) test(`actual supervised CLI ${mode}`, { timeout: mode === "hung-worker" ? 160000 : 30000 }, async t => {
  const crash = mode === "crash";
  const root = mkdtempSync(join(tmpdir(), "rafi-supervised-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const bin = join(root, "bin"); mkdirSync(bin);
  const provider = join(bin, "codex");
  copyFileSync(fileURLToPath(new URL("fixtures/build-stall-codex.cjs", import.meta.url)), provider); chmodSync(provider, 0o755);
  if (mode === "branch") {
    const { cmdInit, cmdUpdate } = await import("../src/tickets/commands.js");
    const { stringify } = await import("yaml");
    cmdInit(root, { appName: "test", timezone: "UTC" });
    writeFileSync(join(root, ".tickets/tickets.yaml"), stringify({ tickets: [{ id: "T001", order: 1, title: "Implement", area: "test", priority: "P1", size: "S", risk: "Low", summary: "work", acceptance: ["works"], required_tests: ["tests"], likely_files: [], depends_on: [] }] }));
    cmdUpdate(root, "T001", { status: "next", actor: "test" });
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]);
  }
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "start", root, "--steps", "1", "--no-qa", "--yes", "--agent", "codex", ...(mode === "branch" ? ["--branch-per-ticket", "--completion", "none"] : []), ...(mode === "detached" ? ["--detach"] : [])], {
    env: { ...process.env, RAFI_BUILD_WORKER_RUN: "", RAFI_DETACHED_SUPERVISOR_RUN: "", RAFI_FIXTURE_QUESTION: mode === "question" ? "1" : "0", RAFI_FIXTURE_CRASH_PREPARATION: mode === "preparation-crash" ? "1" : "0", RAFI_FIXTURE_CRASH_ON_WORK: crash ? "1" : "0", RAFI_FIXTURE_HANG_WORKER: mode === "hung-worker" ? "1" : "0", RAFI_FIXTURE_WAIT_ON_WORK: ["parent-death", "cancel", "competing"].includes(mode) ? "1" : "0", PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
  if (["parent-death", "cancel", "competing", "hung-worker"].includes(mode)) {
    const until = Date.now() + 10000;
    while (!existsSync(join(root, "work-started")) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(existsSync(join(root, "work-started")), output);
    if (mode === "competing") {
      const rival = spawnSync(process.execPath, child.spawnargs.slice(1), { encoding: "utf8", timeout: 10000,
        env: { ...process.env, RAFI_BUILD_WORKER_RUN: "", RAFI_DETACHED_SUPERVISOR_RUN: "", PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(rival.status, 1, rival.stdout + rival.stderr);
      assert.match(rival.stderr, /supervisor already active/);
    }
    if (mode !== "hung-worker") child.kill(mode === "parent-death" ? "SIGKILL" : "SIGTERM");
  }
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (["parent-death", "cancel", "competing", "hung-worker"].includes(mode)) {
    const worker = Number(readFileSync(join(root, "work-started"), "utf8"));
    const until = Date.now() + 18000;
    let alive = true;
    while (alive && Date.now() < until) { try { process.kill(worker, 0); } catch { alive = false; } if (alive) await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(alive, false, "orphaned or cancelled worker must stop within cleanup bound");
    const record = readBuildRuns(root)[0]!;
    const db = new WorkflowDb(root);
    try { assert.equal(db.unresolvedRoleDispatches(record.runId, "builder").length, 1); assert.notEqual(record.status, "completed"); }
    finally { db.close(); }
    return;
  }
  if (mode === "preparation-crash" && processStartIdentity() === "unavailable") {
    assert.equal(code, 2, "Unverifiable process ownership must pause instead of restarting");
    return;
  }
  if (mode === "question") {
    assert.equal(code, 2, output);
    const run = readBuildRuns(root)[0]!;
    const db = new WorkflowDb(root);
    try {
      const pending = db.pendingHumanDecisions(run.runId);
      assert.equal(pending.length, 1);
      assert.equal(db.supervisorState(run.runId)?.status, "waiting_for_human");
      assert.match(output, /activity=paused/);
      assert.doesNotMatch(output, /activity=completed/);
      assert.ok(output.includes(`--run ${run.runId} --decision ${pending[0]!.decisionId}`), output);
      assert.ok(output.includes(`rafi build:resume ${root} --run ${run.runId}`), output);
      assert.equal(existsSync(join(root, "implemented.txt")), false);
    } finally { db.close(); }
    return;
  }
  const reader = new WorkflowReader(root);
  const recoveryEvidence = reader.buildRuns().map(run => ({ checkpoint: run.checkpoint, events: reader.events(run.runId).filter(event => event.type === "worker_reconciliation_required") }));
  reader.close();
  assert.equal(code, crash ? 2 : 0, output + JSON.stringify(recoveryEvidence));
  if (mode === "detached") {
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const run = readBuildRuns(root)[0];
      if (run?.status === "completed") {
        const db = new WorkflowDb(root);
        let stopped: boolean;
        try { stopped = db.supervisorState(run.runId)?.status === "stopped"; } finally { db.close(); }
        if (stopped) break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const run = readBuildRuns(root)[0]!;
  assert.ok(run, output);
  const db = new WorkflowDb(root);
  try {
    assert.equal(db.supervisorState(run.runId)?.workerGeneration, mode === "preparation-crash" ? 2 : 1);
    assert.equal(db.supervisorState(run.runId)?.status, crash ? "waiting_for_human" : "stopped");
    assert.equal(db.unresolvedRoleDispatches(run.runId, "builder").length, crash ? 1 : 0);
  } finally { db.close(); }
});

test("supervisor ownership is exclusive even for concurrent starts in one process", async t => {
  const { DurableSupervisor } = await import("../src/supervisor.js");
  const { resolveAutonomyPolicy } = await import("../src/recoveryPolicy.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-supervisor-race-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let finish!: (result: { kind: "completed" }) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const options = { projectDir: root, runId: "run", policy: resolveAutonomyPolicy(undefined), checkpoint: () => "work", spawnWorker: () => ({ result: new Promise<{ kind: "completed" }>(resolve => { finish = resolve; started(); }), stop() {} }) };
  const first = new DurableSupervisor(options).run();
  await ready;
  await assert.rejects(new DurableSupervisor(options).run(), /already active/);
  await assert.rejects(new DurableSupervisor({ ...options, runId: "other-run" }).run(), /already active/);
  finish({ kind: "completed" });
  assert.equal((await first).kind, "completed");
});

test("supervisor retry limits do not reset when a checkpoint label changes", async t => {
  const { DurableSupervisor } = await import("../src/supervisor.js");
  const { resolveAutonomyPolicy } = await import("../src/recoveryPolicy.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-supervisor-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = resolveAutonomyPolicy(undefined); policy.limits.workerRestartsPerCheckpoint = 1;
  let calls = 0;
  const result = await new DurableSupervisor({ projectDir: root, runId: "run", policy, checkpoint: () => `cosmetic-${calls}`, sleep: async () => {}, spawnWorker: () => { calls++; return { result: Promise.resolve({ kind: "crashed" as const, detail: "fixture" }), stop() {} }; } }).run();
  assert.equal(result.kind, "failed");
  assert.equal(calls, 2);
});
