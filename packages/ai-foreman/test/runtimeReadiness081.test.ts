import { chmodSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClaudeSdkFailure, classifyRuntimeFailure, formatRuntimeProbeFailure, probeRuntime, sanitizeDiagnostics } from "../src/runtimeReadiness.js";

test("runtime failures are phase-aware and login guidance is authentication-only", () => {
  assert.equal(classifyRuntimeFailure("401 not logged in"), "authentication");
  assert.equal(classifyRuntimeFailure("429 rate limit exceeded"), "rate-limit");
  assert.equal(classifyRuntimeFailure("getaddrinfo ENOTFOUND"), "network");
  assert.equal(classifyRuntimeFailure("bad compiler", "compiler-update"), "compiler-update");
  const auth = formatRuntimeProbeFailure({ ok: false, runtime: "claude", phase: "readiness", category: "authentication", executable: "claude", cwd: "/tmp", timedOut: false, exitCode: 1, signal: null, diagnostics: "not logged in", environmentNames: [], recoveryChoices: ["retry", "switch", "cancel"] });
  const network = formatRuntimeProbeFailure({ ok: false, runtime: "claude", phase: "readiness", category: "network", executable: "claude", cwd: "/tmp", timedOut: false, exitCode: 1, signal: null, diagnostics: "network down", environmentNames: [], recoveryChoices: ["retry", "switch", "cancel"] });
  assert.match(auth, /approved by your organization/);
  assert.doesNotMatch(auth, /--claudeai|setup-token|auth logout/);
  assert.doesNotMatch(network, /approved by your organization/);
});

test("runtime probe reports the absolute executable actually invoked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-runtime-path-"));
  const executable = join(dir, "claude");
  writeFileSync(executable, "#!/bin/sh\nprintf OK\n", "utf8");
  chmodSync(executable, 0o755);
  const result = await probeRuntime(dir, "claude", { env: { PATH: dir }, timeoutMs: 10_000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.executable, executable);
});

test("structured Claude SDK failures take precedence over vague API text", () => {
  assert.equal(classifyClaudeSdkFailure("authentication_failed", null, "API Error"), "authentication");
  assert.equal(classifyClaudeSdkFailure("oauth_org_not_allowed", 403, "API Error"), "authorization");
  assert.equal(classifyClaudeSdkFailure("rate_limit", 429, "API Error"), "rate-limit");
  assert.equal(classifyClaudeSdkFailure("model_not_found", 400, "API Error"), "configuration");
  assert.equal(classifyClaudeSdkFailure(undefined, 407, "API Error"), "network");
});

test("runtime diagnostics remove ANSI and secrets and enforce the byte cap", () => {
  const value = sanitizeDiagnostics(`\u001b[31merror\u001b[0m token=sk_${"a".repeat(80)} ${"x".repeat(20_000)}`, 512);
  assert.doesNotMatch(value, /\u001b/);
  assert.doesNotMatch(value, /sk_a/);
  assert.ok(Buffer.byteLength(value) <= 512);
  assert.match(value, /<redacted>/);
});

for (const scenario of ["hung-shutdown", "inherited-stdio", "redirected-stdio-child", "invalid-completion", "cancelled"] as const) test(`readiness ${scenario} remains bounded and cannot turn stdout into success`, async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-readiness-lifecycle-"));
  try {
    const script = scenario === "inherited-stdio"
      ? "printf 'OK\\n'; /bin/sleep 30 & exit 0"
      : scenario === "redirected-stdio-child" ? "/bin/sh -c 'trap \"\" TERM; /bin/sleep 8; printf alive > orphan-marker; /bin/sleep 2' >/dev/null 2>&1 & printf 'OK\\n'; /bin/sleep 30"
      : scenario === "invalid-completion" ? "printf 'unrelated output\\n'"
      : "printf 'OK\\n'; /bin/sleep 30";
    const executable = join(root, "codex"); writeFileSync(executable, `#!/bin/sh\n${script}\n`); chmodSync(executable, 0o755);
    const controller = new AbortController(); const traces: string[] = [];
    if (scenario === "cancelled") setTimeout(() => controller.abort(), 40);
    const began = performance.now();
    // Leave enough time for the shell to start under workspace-suite load; a
    // 200 ms deadline can kill it before the behavior under test even begins.
    const result = await probeRuntime(root, "codex", { env: { PATH: root }, timeoutMs: scenario === "invalid-completion" ? 5000 : 3000, signal: controller.signal, onTrace: event => traces.push(event.phase) });
    assert.equal(result.ok, scenario === "inherited-stdio"); assert.ok(performance.now() - began < (scenario === "invalid-completion" ? 6500 : 4500));
    assert.ok(traces.includes("spawn")); assert.ok(traces.includes("settled"));
    if (scenario === "invalid-completion") assert.equal(result.category, "malformed-protocol");
    else if (scenario === "inherited-stdio") { assert.equal(result.category, "ready"); assert.ok(traces.includes("owned-child-cleanup")); }
    else if (scenario === "cancelled") assert.match(result.diagnostics, /cancelled/);
    else { assert.equal(result.category, "timeout"); assert.ok(traces.includes("output"), `fixture must produce output before timeout: ${JSON.stringify(traces)}`); }
    if (scenario === "redirected-stdio-child") {
      await new Promise(resolve => setTimeout(resolve, 8100));
      assert.equal(existsSync(join(root, "orphan-marker")), false, "owned descendant must not survive just because the parent closed stdio");
      assert.ok(traces.includes("owned-child-cleanup"));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("successful build readiness is attributed to its owner across external worktrees", async () => {
  const { WorkflowDb } = await import("../src/workflowDb.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-probe-owner-"));
  const worktree = mkdtempSync(join(tmpdir(), "rafi-probe-worktree-"));
  const db = new WorkflowDb(root);
  try {
    const authority = db.acquireBuildAdmission("build", "worker");
    writeFileSync(join(worktree, "codex"), "#!/bin/sh\nprintf OK\n", { mode: 0o755 });
    const result = await probeRuntime(worktree, "codex", { env: { PATH: worktree }, build: { project: root, runId: "build", authority } });
    assert.equal(result.ok, true, result.diagnostics);
    const rows = (db as any).db.prepare("SELECT * FROM build_owned_processes WHERE run_id='build'").all();
    assert.equal(rows.length, 1);
    assert.equal(existsSync(join(worktree, ".rafi/recovery.sqlite3")), false);
    db.releaseBuildAdmission(authority);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); rmSync(worktree, { recursive: true, force: true }); }
});

test("OK with a surviving redirected descendant is cleaned before build readiness succeeds", async () => {
  const { WorkflowDb } = await import("../src/workflowDb.js");
  const { processGroupQuiescent } = await import("../src/processIdentity.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-probe-descendant-"));
  const db = new WorkflowDb(root);
  try {
    const authority = db.acquireBuildAdmission("build", "worker");
    writeFileSync(join(root, "codex"), "#!/bin/sh\n/bin/sleep 30 >/dev/null 2>&1 &\nprintf OK\n", { mode: 0o755 });
    const result = await probeRuntime(root, "codex", { env: { PATH: root }, build: { project: root, runId: "build", authority } });
    const row = (db as any).db.prepare("SELECT pid FROM build_owned_processes WHERE run_id='build'").get() as {pid:number};
    assert.equal(processGroupQuiescent(row.pid), true);
    assert.equal(result.ok, true, result.diagnostics);
    assert.deepEqual(db.unresolvedPreparationProcesses("build"), []);
    db.releaseBuildAdmission(authority);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});


test("stale or wrong-run readiness authority rejects before spawn", async () => {
  const { WorkflowDb } = await import("../src/workflowDb.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-probe-stale-"));
  const db = new WorkflowDb(root);
  try {
    const authority = db.acquireBuildAdmission("run", "worker");
    db.releaseBuildAdmission(authority);
    await assert.rejects(probeRuntime(root, "codex", { build: { project: root, runId: "run", authority } }), /ownership changed/);
    await assert.rejects(probeRuntime(root, "codex", { build: { project: root, runId: "other", authority } }), /Invalid build readiness owner/);
    assert.equal((db as any).db.prepare("SELECT COUNT(*) n FROM build_owned_processes").get().n, 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("unresolved readiness blocks the current build's dispatch and the next probe", async () => {
  const { WorkflowDb } = await import("../src/workflowDb.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-probe-uncertain-"));
  const db = new WorkflowDb(root);
  try {
    const authority = db.acquireBuildAdmission("run", "worker");
    const id = db.beginOwnedPreparationProcess(authority);
    assert.throws(() => db.planOperation({ runId: "run", idempotencyKey: "dispatch", kind: "provider-dispatch", intent: {} }), /cleanup/);
    await assert.rejects(probeRuntime(root, "codex", { build: { project: root, runId: "run", authority } }), /cleanup/);
    assert.throws(() => db.acquireBuildAdmission("competitor", "worker"), /descendants/);
    db.finishOwnedPreparationProcess(authority, id, true);
    db.planOperation({ runId: "run", idempotencyKey: "dispatch", kind: "provider-dispatch", intent: {} });
    db.releaseBuildAdmission(authority);
    db.acquireBuildAdmission("competitor", "worker");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("probe cleanup follows an escaped process group through its inherited ownership tag", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const { WorkflowDb } = await import("../src/workflowDb.js");
  const { taggedProcesses } = await import("../src/processIdentity.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-probe-escaped-"));
  const db = new WorkflowDb(root);
  try {
    const authority = db.acquireBuildAdmission("build", "worker");
    writeFileSync(join(root, "codex"), `#!${process.execPath}\nconst {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); c.unref(); console.log('OK');`, { mode: 0o755 });
    const result = await probeRuntime(root, "codex", { env: { PATH: root }, build: { project: root, runId: "build", authority } });
    assert.equal(result.ok, true, result.diagnostics);
    const row = (db as any).db.prepare("SELECT id,state,outcome_json FROM build_owned_processes").get();
    assert.deepEqual(taggedProcesses(row.id), []);
    assert.equal(row.state, "quiescent");
    assert.equal(JSON.parse(row.outcome_json).ready, true);
    db.releaseBuildAdmission(authority);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("registration and completion journal errors reject promptly with durable uncertainty", async () => {
  const { WorkflowDb } = await import("../src/workflowDb.js");
  const { RuntimeCleanupError } = await import("../src/runtimeReadiness.js");
  for (const method of ["authorizeReadinessHelper", "reconcileReadiness"] as const) {
    const root = mkdtempSync(join(tmpdir(), "rafi-probe-journal-fault-"));
    const db = new WorkflowDb(root);
    const original = WorkflowDb.prototype[method];
    try {
      const authority = db.acquireBuildAdmission("build", "worker");
      writeFileSync(join(root, "codex"), "#!/bin/sh\nprintf OK\n", { mode: 0o755 });
      WorkflowDb.prototype[method] = () => { throw new Error("injected storage fault"); };
      await assert.rejects(probeRuntime(root, "codex", { build: { project: root, runId: "build", authority }, env: { PATH: root } }), RuntimeCleanupError);
      assert.equal((db as any).db.prepare("SELECT COUNT(*) n FROM build_owned_processes WHERE state <> 'quiescent'").get().n, method === "authorizeReadinessHelper" ? 0 : 1);
      Object.defineProperty(WorkflowDb.prototype, method, { value: original, writable: true, configurable: true });
      assert.deepEqual(await db.reconcileReadiness("build", authority), []);
      const retry = await probeRuntime(root, "codex", { build: { project: root, runId: "build", authority }, env: { PATH: root } });
      assert.equal(retry.ok, true, retry.diagnostics);
    } finally { Object.defineProperty(WorkflowDb.prototype, method, { value: original, writable: true, configurable: true }); db.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("helper registration failure never dispatches provider and permits retry", { skip: process.platform === "win32" }, async () => {
  const { WorkflowDb } = await import("../src/workflowDb.js");
  const { RuntimeCleanupError } = await import("../src/runtimeReadiness.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-register-fault-"));
  const db = new WorkflowDb(root);
  try {
    const authority = db.acquireBuildAdmission("run", "worker");
    writeFileSync(join(root, "codex"), "#!/bin/sh\nprintf called >> dispatches\nprintf OK\n", { mode: 0o755 });
    (db as any).db.exec("CREATE TRIGGER registration_fault BEFORE UPDATE OF pid ON build_owned_processes BEGIN SELECT RAISE(ABORT,'registration fault'); END");
    await assert.rejects(probeRuntime(root, "codex", { env: { PATH: root }, build: { project: root, runId: "run", authority } }), RuntimeCleanupError);
    assert.equal(existsSync(join(root, "dispatches")), false);
    assert.deepEqual(db.readinessProcesses(), []);
    (db as any).db.exec("DROP TRIGGER registration_fault");
    const result = await probeRuntime(root, "codex", { env: { PATH: root }, build: { project: root, runId: "run", authority } });
    assert.equal(result.ok, true, result.diagnostics);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
test("gated missing provider preserves missing-executable classification", async () => {
  const { WorkflowDb } = await import("../src/workflowDb.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-missing-provider-"));
  const db = new WorkflowDb(root);
  try {
    const authority = db.acquireBuildAdmission("run", "worker");
    const result = await probeRuntime(root, "codex", { env: { PATH: root, Path: root }, build: { project: root, runId: "run", authority } });
    assert.equal(result.category, "missing-executable", result.diagnostics);
    assert.deepEqual(db.readinessProcesses(), []);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("lost authorization acknowledgement preserves authorized history and safely retries", { skip: process.platform === "win32" }, async () => {
  const { WorkflowDb } = await import("../src/workflowDb.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-lost-probe-ack-"));
  const db = new WorkflowDb(root);
  const authorize = WorkflowDb.prototype.authorizeReadinessHelper;
  try {
    const authority = db.acquireBuildAdmission("run", "worker");
    writeFileSync(join(root, "codex"), "#!/bin/sh\nprintf called >> dispatches\nprintf OK\n", { mode: 0o755 });
    WorkflowDb.prototype.authorizeReadinessHelper = function(...args) { authorize.apply(this, args); throw new Error("acknowledgement lost after commit"); };
    await assert.rejects(probeRuntime(root, "codex", { env: { PATH: root }, build: { project: root, runId: "run", authority } }), /acknowledgement lost/);
    const row = (db as any).db.prepare("SELECT state,outcome_json FROM build_owned_processes").get();
    assert.equal(JSON.parse(row.outcome_json).startup, "authorized");
    assert.equal(row.state, "quiescent");
    assert.equal(existsSync(join(root, "dispatches")), false);
    WorkflowDb.prototype.authorizeReadinessHelper = authorize;
    const retry = await probeRuntime(root, "codex", { env: { PATH: root }, build: { project: root, runId: "run", authority } });
    assert.equal(retry.ok, true, retry.diagnostics);
  } finally { WorkflowDb.prototype.authorizeReadinessHelper = authorize; db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("readiness helper preserves provider exit signal", { skip: process.platform === "win32" }, async () => {
  const { WorkflowDb } = await import("../src/workflowDb.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-provider-signal-"));
  const db = new WorkflowDb(root);
  try {
    const authority = db.acquireBuildAdmission("run", "worker");
    writeFileSync(join(root, "codex"), "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });
    const result = await probeRuntime(root, "codex", { env: { PATH: root }, build: { project: root, runId: "run", authority } });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, "SIGTERM");
    assert.deepEqual(db.readinessProcesses(), []);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("registered helper retains its group until descendants with scrubbed environments are cleaned", { skip: process.platform === "win32" }, async () => {
  const { WorkflowDb } = await import("../src/workflowDb.js");
  const { processGroupQuiescent } = await import("../src/processIdentity.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-probe-group-"));
  const db = new WorkflowDb(root);
  try {
    const authority = db.acquireBuildAdmission("run", "worker");
    writeFileSync(join(root, "codex"), `#!${process.execPath}\nconst c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{},stdio:'ignore'});c.unref();console.log('OK');`, { mode: 0o755 });
    const result = await probeRuntime(root, "codex", { env: { PATH: root }, build: { project: root, runId: "run", authority } });
    assert.equal(result.ok, true, result.diagnostics);
    const row = (db as any).db.prepare("SELECT pid FROM build_owned_processes").get();
    assert.equal(processGroupQuiescent(row.pid), true);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("embedded eval callers launch only the packaged helper and create no standalone recovery DB", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "rafi-embedded-probe-"));
  try {
    writeFileSync(join(root, "codex"), "#!/bin/sh\nprintf OK\n", { mode: 0o755 });
    const source = `import {probeRuntime} from ${JSON.stringify(new URL("../dist/runtimeReadiness.js", import.meta.url).href)}; const result=await probeRuntime(${JSON.stringify(root)},'codex',{env:{PATH:${JSON.stringify(root)}},timeoutMs:5000}); console.log(result.category);`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /ready/);
    assert.equal(existsSync(join(root, ".rafi")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standalone denied inventory rejects success, blocks retry, and recovers after visibility returns", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-standalone-denied-"));
  const prior = process.env.PATH;
  const helpers: number[] = [];
  try {
    writeFileSync(join(root, "codex"), `#!${process.execPath}\nconsole.log('OK');\n`, { mode: 0o755 });
    // Identity remains available on Linux via procfs, but group/tag inventory
    // is unavailable on both Unix implementations without ps.
    process.env.PATH = root;
    const opts = { env: { PATH: root }, onTrace: (event: { phase: string; pid?: number }) => { if (event.phase === "spawn" && event.pid) helpers.push(event.pid); } };
    await assert.rejects(probeRuntime(root, "codex", opts), /Standalone probe cleanup is unverified/);
    await assert.rejects(probeRuntime(root, "codex", opts), /Previous standalone probe cleanup is unverified/);
    assert.equal(helpers.length, 1, "blocked retry must not spawn another provider/helper");
    process.env.PATH = prior;
    const result = await probeRuntime(root, "codex", opts);
    assert.equal(result.ok, true, result.diagnostics);
    assert.equal(helpers.length, 2);
    assert.equal(existsSync(join(root, ".rafi/recovery.sqlite3")), false);
  } finally {
    process.env.PATH = prior;
    // Only the disposable process groups created by this test are eligible.
    for (const pid of helpers) try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});
