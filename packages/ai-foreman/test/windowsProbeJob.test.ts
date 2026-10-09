import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { windowsProbeCommand, windowsProbeJobState, windowsRuntimeInvocation } from "../src/windowsProbeJob.js";
import { classifyProcess, processStartIdentity } from "../src/processIdentity.js";
import { probeRuntime } from "../dist/runtimeReadiness.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { inspectReadiness } from "../src/readinessCleanup.js";
import Database from "better-sqlite3";

// These assertions run on every platform. Native tests below run on Windows CI.
test("Windows containment separates argv data from PowerShell code", () => {
  const injection = 'literal " $(value) & %PATH% ! ^';
  const command = windowsProbeCommand(randomUUID(), "provider.exe", [injection], "C:\\project space", "win:123");
  assert.equal(JSON.parse(command.config).args[0], injection);
  const script = Buffer.from(command.args.at(-1)!, "base64").toString("utf16le");
  assert.equal(script.includes(injection), false);
  assert.ok(command.args.join(" ").length < 30000, "encoded helper fits Windows CreateProcess command limits");
  assert.throws(() => windowsProbeCommand(randomUUID(), "provider.exe", [], ".", "unavailable"), /identity/);
  assert.equal(windowsProbeJobState("not-a-job-token"), "unknown");
});

test("standard npm Windows shims resolve to Node argv without cmd.exe", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-shim-"));
  try {
    writeFileSync(join(root, "provider.js"), "console.log('OK')");
    const shim = join(root, "codex.cmd");
    writeFileSync(shim, '@echo off\n"%_prog%" "%dp0%/provider.js" %*\n');
    const result = windowsRuntimeInvocation(shim, ["literal & data"]);
    assert.equal(result.executable, process.execPath);
    assert.deepEqual(result.args, [join(root, "provider.js"), "literal & data"]);
    writeFileSync(shim, "custom unsafe shell command");
    assert.throws(() => windowsRuntimeInvocation(shim, []), /Unsupported/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of ["normal", "descendant", "cancel"] as const) test(`Windows Job Object readiness ${scenario}`, { skip: process.platform !== "win32", timeout: 90000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi windows probe "));
  const worktree = join(root, "external worktree ü"); mkdirSync(worktree);
  const db = new WorkflowDb(root);
  try {
    const authority = db.acquireBuildAdmission("run", "worker");
    const marker = join(worktree, "descendant.pid");
    writeFileSync(join(worktree, "provider.cjs"), scenario === "normal" ? "console.log('OK');" : `
      const {spawn}=require('node:child_process');const fs=require('node:fs');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); child.unref();
      fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));console.log('OK');
      ${scenario === "cancel" ? "setInterval(()=>{},1000);" : ""}
    `);
    writeFileSync(join(worktree, "codex.cmd"), '@echo off\n"%_prog%" "%dp0%/provider.cjs" %*\n');
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (scenario === "cancel") timer = setInterval(() => { if (existsSync(marker)) { clearInterval(timer); controller.abort(); } }, 50);
    let result;
    try { result = await probeRuntime(worktree, "codex", { build: { project: root, runId: "run", authority }, env: { ...process.env, PATH: worktree, Path: worktree }, signal: controller.signal, timeoutMs: 30000 }); }
    finally { clearInterval(timer); }
    assert.equal(result.ok, scenario !== "cancel", result.diagnostics);
    assert.equal(existsSync(join(worktree, ".rafi/recovery.sqlite3")), false);
    assert.deepEqual(db.unresolvedPreparationProcesses("run"), []);
    if (scenario !== "normal") assert.equal(classifyProcess(Number(readFileSync(marker, "utf8")), "unavailable").state, "dead");
    db.releaseBuildAdmission(authority);
    const next = db.acquireBuildAdmission("next", "worker"); db.releaseBuildAdmission(next);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Windows helper death closes its job and prevents detached descendants surviving", { skip: process.platform !== "win32", timeout: 90000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-job-death-"));
  const tag = randomUUID();
  const marker = join(root, "child.pid");
  const command = windowsProbeCommand(tag, process.execPath, ["-e", `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000);`], root, processStartIdentity());
  const child = spawn(command.executable, command.args, { env: { ...process.env, RAFI_WINDOWS_PROBE_CONFIG: command.config }, stdio: "ignore" });
  try {
    const until = Date.now() + 30000;
    while (!existsSync(marker) && Date.now() < until && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(existsSync(marker), "provider must execute after job assignment");
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
    assert.ok(["absent", "empty"].includes(windowsProbeJobState(tag)));
    assert.equal(classifyProcess(Number(readFileSync(marker, "utf8")), "unavailable").state, "dead");
  } finally { child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
});

test("Windows helper stops its job when the owning Rafi process dies", { skip: process.platform !== "win32", timeout: 90000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-job-owner-death-"));
  const marker = join(root, "provider.pid");
  const entry = join(root, "owner.mts");
  writeFileSync(entry, `
    import {spawn} from 'node:child_process';
    import {windowsProbeCommand} from ${JSON.stringify(new URL("../src/windowsProbeJob.ts", import.meta.url).href)};
    import {processStartIdentity} from ${JSON.stringify(new URL("../src/processIdentity.ts", import.meta.url).href)};
    const command=windowsProbeCommand(${JSON.stringify(randomUUID())},process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`)}],${JSON.stringify(root)},processStartIdentity());
    spawn(command.executable,command.args,{env:{...process.env,RAFI_WINDOWS_PROBE_CONFIG:command.config},stdio:'ignore'});
    setInterval(()=>{},1000);
  `);
  const owner = spawn(process.execPath, ["--import", "tsx", entry], { stdio: "ignore" });
  try {
    const until = Date.now() + 30000;
    while (!existsSync(marker) && Date.now() < until && owner.exitCode === null) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(existsSync(marker));
    const pid = Number(readFileSync(marker, "utf8"));
    const exited = new Promise(resolve => owner.once("exit", resolve)); owner.kill("SIGKILL"); await exited;
    const stopped = Date.now() + 10000;
    while (classifyProcess(pid, "unavailable").state !== "dead" && Date.now() < stopped) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(classifyProcess(pid, "unavailable").state, "dead");
  } finally { owner.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
});

test("Windows gated job creator cannot execute after startup EOF", { skip: process.platform !== "win32", timeout: 90000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi Windows gate "));
  const tag = randomUUID();
  const marker = join(root, "executed");
  const command = windowsProbeCommand(tag, process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`], root, processStartIdentity(), true);
  const child = spawn(command.executable, command.args, { env: { ...process.env, RAFI_WINDOWS_PROBE_CONFIG: command.config }, stdio: ["pipe", "ignore", "pipe"] });
  try {
    const result = new Promise(resolve => child.once("close", resolve));
    child.stdin.end();
    assert.equal(await result, 125);
    assert.equal(existsSync(marker), false);
    assert.equal(windowsProbeJobState(tag), "absent");
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test("Windows production reconciliation fences a paused creator before late authorization", { skip: process.platform !== "win32", timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi paused Windows creator "));
  const marker = join(root, "executed");
  const db = new WorkflowDb(root);
  const authority = db.acquireBuildAdmission("paused", "worker");
  const tag = db.beginOwnedPreparationProcess(authority, undefined, true);
  // This test-owned barrier replaces only the instant at which the real helper
  // writes its creator's stdin. Registration/authorization/cleanup are production.
  const entry = join(root, "paused-helper.mjs");
  writeFileSync(entry, `
    import {spawn} from 'node:child_process';
    import {WorkflowDb} from ${JSON.stringify(new URL("../dist/workflowDb.js", import.meta.url).href)};
    import {windowsProbeCommand} from ${JSON.stringify(new URL("../dist/windowsProbeJob.js", import.meta.url).href)};
    import {processStartIdentity} from ${JSON.stringify(new URL("../dist/processIdentity.js", import.meta.url).href)};
    const db=new WorkflowDb(${JSON.stringify(root)},undefined,{probeId:${JSON.stringify(tag)}});
    db.registerReadinessHelper(${JSON.stringify(tag)});
    const authorized=new Promise(resolve=>process.once('message',resolve));
    process.send({kind:'registered'}); await authorized;
    db.assertReadinessHelper(${JSON.stringify(tag)});
    const command=windowsProbeCommand(${JSON.stringify(tag)},process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`)}],${JSON.stringify(root)},processStartIdentity(),true);
    const creator=spawn(command.executable,command.args,{env:{...process.env,RAFI_WINDOWS_PROBE_CONFIG:command.config},stdio:['pipe','ignore','inherit']});
    creator.stdin.on('error',()=>{});
    db.recordReadinessCreator(${JSON.stringify(tag)},creator.pid);
    process.on('message',message=>{if(message==='late-authorize')creator.stdin.end('rafi-create-job\\n');});
    process.send({kind:'paused',pid:creator.pid});
    setInterval(()=>{},1000);
  `);
  const child = spawn(process.execPath, [entry], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let diagnostics = ""; child.stderr!.on("data", chunk => { diagnostics += chunk; });
  const closed = new Promise(resolve => child.once("close", resolve));
  const message = (kind: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`helper did not reach ${kind}: ${diagnostics}`)), 30000);
    const receive = (value: any) => { if (value?.kind === kind) finish(); };
    const exit = () => finish(new Error(`helper exited before ${kind}: ${diagnostics}`));
    function finish(error?: Error) { clearTimeout(timer); child.off("message", receive); child.off("exit", exit); child.off("error", finish); error ? reject(error) : resolve(); }
    child.on("message", receive); child.once("exit", exit); child.once("error", finish);
  });
  try {
    await message("registered");
    db.authorizeReadinessHelper(authority, tag, child.pid!);
    const paused = message("paused"); child.send("authorize"); await paused;
    const row = db.readinessProcesses("paused")[0]!;
    const metadata = JSON.parse(row.outcome_json!);
    assert.equal(metadata.startup, "authorized");
    assert.equal(classifyProcess(metadata.creator.pid, metadata.creator.start).state, "live");
    assert.equal(windowsProbeJobState(tag), "absent");
    assert.equal(inspectReadiness(row).state, "unknown", "an absent job cannot clear a live creator");
    assert.deepEqual(await db.reconcileReadiness("paused", authority, Date.now() - 1), [tag]);
    assert.throws(() => db.beginOwnedPreparationProcess(authority, undefined, true), /unresolved/);
    assert.equal(existsSync(marker), false);
    // The decisive termination and durable receipt must come from production.
    assert.deepEqual(await db.reconcileReadiness("paused", authority, Date.now() + 30000), []);
    assert.equal(classifyProcess(row.pid!, row.process_start!).state, "dead");
    assert.equal(classifyProcess(metadata.creator.pid, metadata.creator.start).state, "dead");
    const reader = new Database(db.path, { readonly: true });
    let saved: { state: string; outcome_json: string };
    try { saved = reader.prepare("SELECT state,outcome_json FROM build_owned_processes WHERE id=?").get(tag) as typeof saved; }
    finally { reader.close(); }
    assert.equal(saved.state, "quiescent");
    assert.equal(JSON.parse(saved.outcome_json).startup, "authorized");
    assert.equal(JSON.parse(saved.outcome_json).cleanup.state, "quiescent");
    // A late parent authorization cannot cross the now-closed helper channel.
    await new Promise<void>(resolve => { try { child.send("late-authorize", () => resolve()); } catch { resolve(); } });
    await closed;
    assert.equal(existsSync(marker), false);
    assert.ok(["absent", "empty"].includes(windowsProbeJobState(tag)));
    writeFileSync(join(root, "provider.cjs"), "console.log('OK');");
    writeFileSync(join(root, "codex.cmd"), '@echo off\n"%_prog%" "%dp0%/provider.cjs" %*\n');
    const retry = await probeRuntime(root, "codex", { build: { project: root, runId: "paused", authority }, env: { ...process.env, PATH: root, Path: root }, timeoutMs: 30000 });
    assert.equal(retry.ok, true, retry.diagnostics);
    assert.deepEqual(db.readinessProcesses(), []);
    db.releaseBuildAdmission(authority);
  } finally { child.kill(); await closed; db.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
