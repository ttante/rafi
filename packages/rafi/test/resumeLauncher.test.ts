import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchResumeStart, resumeExitCode } from "../src/resumeLauncher.js";

test("resume launcher preserves exit codes and keeps parent timers running", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-async-launch-"));
  const entry = join(root, "child.mjs");
  writeFileSync(entry, "setTimeout(() => process.exit(7), 100);");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
  try {
    assert.equal(await launchResumeStart(entry, []), 7);
    assert.ok(ticks > 0, "launcher must not block ownership heartbeats");
    assert.equal(process.listenerCount("SIGINT"), before.int);
    assert.equal(process.listenerCount("SIGTERM"), before.term);
  } finally { clearInterval(timer); rmSync(root, { recursive: true, force: true }); }
});

test("resume launcher forwards termination and preserves the child result", { timeout: 15000, skip: process.platform === "win32" ? "Windows termination cannot be trapped as SIGTERM; native Job Object death tests cover cleanup" : false }, async t => {
  const { spawn } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "rafi-launch-signal-"));
  const entry = join(root, "child.mjs");
  writeFileSync(entry, "process.once('SIGTERM', () => process.exit(42)); console.log('READY'); setInterval(() => {}, 1000);");
  const module = new URL("../src/resumeLauncher.ts", import.meta.url).href;
  const parentEntry = join(root, "parent.mts");
  writeFileSync(parentEntry, `import { launchResumeStart, resumeExitCode } from ${JSON.stringify(module)}; process.exitCode = await launchResumeStart(process.argv[2], []);`);
  const parent = spawn(process.execPath, ["--import", "tsx", parentEntry, entry], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { parent.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => {
    parent.once("error", reject);
    parent.stdout.on("data", value => { if (String(value).includes("READY")) resolve(); });
    parent.once("exit", code => reject(new Error(`launcher exited before readiness: ${code}`)));
  });
  const exited = new Promise(resolve => parent.once("exit", resolve));
  parent.kill("SIGTERM");
  assert.equal(await exited, 42);
});

test("resume launcher distinguishes a definite spawn failure and removes signal handlers", async () => {
  const { ResumeSpawnError } = await import("../src/resumeLauncher.js");
  const original = process.execPath;
  const root = mkdtempSync(join(tmpdir(), "rafi-spawn-failure-"));
  const before = process.listenerCount("SIGTERM");
  try {
    Object.defineProperty(process, "execPath", { value: join(root, "missing-node") });
    await assert.rejects(launchResumeStart("unused", []), error => error instanceof ResumeSpawnError && error.code === "ENOENT");
    assert.equal(process.listenerCount("SIGTERM"), before);
  } finally { Object.defineProperty(process, "execPath", { value: original }); rmSync(root, { recursive: true, force: true }); }
});

test("real gated preclaim CLI failure retires and reuses the same successor", async () => {
  const { WorkflowDb } = await import("ai-foreman/workflow-db.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-gated-failure-"));
  const db = new WorkflowDb(root);
  try {
    const args = ["start", root, "--steps", "1"];
    db.ensureRun("old");
    const retry = db.reservePreparationRetry("old", args);
    db.dispatchBuildLaunch(retry.authority, retry.launch.token);
    const entry = join(root, "reject.mjs");
    writeFileSync(entry, "process.exitCode=7;");
    const outcome = await launchResumeStart(entry, [...args, "--preparation-run", retry.runId, "--launch-token", retry.launch.token], { authority: retry.authority });
    assert.equal(resumeExitCode(outcome), 7);
    assert.equal(typeof outcome === "object" && outcome.registered && !outcome.claimed, true);
    assert.equal(db.buildLaunch(retry.launch.token)?.acknowledged, true);
    assert.equal(db.reconcileBuildLaunches(retry.runId, retry.authority), "retired");
    db.releaseBuildAdmission(retry.authority);
    assert.equal(db.reservePreparationRetry(retry.runId, args).runId, retry.runId);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("registered child whose launcher disconnects exits before loading the CLI", { timeout: 15000 }, async () => {
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { WorkflowDb } = await import("ai-foreman/workflow-db.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-gate-orphan-"));
  const db = new WorkflowDb(root);
  try {
    const args = ["start", root, "--steps", "1"];
    db.ensureRun("old"); const retry = db.reservePreparationRetry("old", args);
    db.dispatchBuildLaunch(retry.authority, retry.launch.token);
    const marker = join(root, "dispatched"); const entry = join(root, "entry.mjs");
    writeFileSync(entry, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe');`);
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/resumeLaunchGate.ts", import.meta.url)), entry, root, retry.launch.token, ...args], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
    await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); child.once("exit", code => reject(new Error(`early exit ${code}`))); });
    child.disconnect();
    assert.notEqual(await exited, 0);
    assert.equal(existsSync(marker), false);
    assert.equal(db.reconcileBuildLaunches(retry.runId, retry.authority), "retired");
    db.releaseBuildAdmission(retry.authority);
    assert.equal(db.reservePreparationRetry(retry.runId, args).runId, retry.runId);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
