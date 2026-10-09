import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDb } from "../src/workflowDb.js";
import { launchDigest } from "../src/buildAdmission.js";

function fixture(fn: (db: WorkflowDb, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rafi-admission-"));
  const db = new WorkflowDb(root);
  try { fn(db, root); } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}
test("admission blocks competing runs, transfers once, and fences the predecessor", () => fixture((db) => {
  const owner = db.acquireBuildAdmission("first", "coordinator");
  assert.throws(() => db.acquireBuildAdmission("second", "worker"), /admission/);
  const digest = launchDigest(["start", "project"]);
  const launch = db.reserveBuildLaunch(owner, "worker", digest);
  assert.throws(() => db.reserveBuildLaunch(owner, "worker", digest), /UNIQUE/);
  assert.throws(() => db.claimBuildLaunch("first", launch.token, "worker", digest), /Invalid/);
  db.dispatchBuildLaunch(owner, launch.token);
  assert.throws(() => db.claimBuildLaunch("first", launch.token, "worker", "wrong"), /Invalid/);
  assert.throws(() => db.claimBuildLaunch("second", launch.token, "worker", digest), /Invalid/);
  const worker = db.claimBuildLaunch("first", launch.token, "worker", digest);
  assert.notEqual(owner.token, worker.token);
  assert.throws(() => db.claimBuildLaunch("first", launch.token, "worker", digest), /Invalid/);
  assert.throws(() => db.releaseBuildAdmission(owner), /ownership changed/);
  db.releaseBuildAdmission(worker);
  const next = db.acquireBuildAdmission("first", "worker");
  assert.notEqual(next.token, worker.token);
  assert.throws(() => db.assertBuildAdmission(worker), /ownership changed/);
}));
test("definite failed launch can retry while unresolved launch cannot be released", () => fixture(db => {
  const owner = db.acquireBuildAdmission("first", "coordinator");
  const launch = db.reserveBuildLaunch(owner, "worker", "digest");
  db.dispatchBuildLaunch(owner, launch.token);
  assert.throws(() => db.releaseBuildAdmission(owner), /unresolved launch/);
  db.failBuildLaunch(owner, launch.token);
  db.reserveBuildLaunch(owner, "worker", "digest");
}));
test("migration is repeatable and preserves claimed ownership", () => fixture((db, root) => {
  const owner = db.acquireBuildAdmission("first", "worker");
  const other = new WorkflowDb(root);
  try { assert.deepEqual(other.buildAdmission(), owner); } finally { other.close(); }
}));
test("ownership v1 upgrade preserves its owner and legacy evidence while installing v2 fences", () => fixture((db, root) => {
  const owner = db.acquireBuildAdmission("legacy", "worker");
  db.transition("legacy", { checkpoint: "preparing", state: { version: 1 } });
  const raw = (db as any).db;
  raw.exec("ALTER TABLE build_owned_processes DROP COLUMN outcome_json");
  raw.exec("DROP TABLE build_child_runs; DROP TABLE build_runtime_runs; UPDATE build_ownership_schema SET version=1");
  raw.prepare("INSERT INTO build_owned_processes(id,run_id,owner,host,state) VALUES('old-probe','legacy',?,'unknown','completed')").run(owner.token);
  const upgraded = new WorkflowDb(root);
  try {
    assert.deepEqual(upgraded.buildAdmission(), owner);
    const storage = (upgraded as any).db;
    assert.equal(storage.prepare("SELECT version FROM build_ownership_schema").get().version, 2);
    assert.equal(storage.prepare("SELECT state FROM build_owned_processes WHERE id='old-probe'").get().state, "completed");
    assert.ok(storage.prepare("SELECT 1 FROM build_runtime_runs WHERE run_id='legacy'").get());
    assert.ok(storage.prepare("PRAGMA table_info(build_owned_processes)").all().some((column: { name: string }) => column.name === "outcome_json"));
    assert.equal(upgraded.unresolvedPreparationProcesses("legacy").length, 1, "migration cannot invent cleanup proof");
  } finally { upgraded.close(); }
}));
test("preparation eligibility is run-scoped and rejects durable provider evidence", () => fixture(db => {
  db.ensureRun("first"); db.ensureRun("other");
  assert.equal(db.preparationEligibility("first").eligible, true);
  db.planOperation({ runId: "other", idempotencyKey: "other:operation", kind: "provider-dispatch", intent: {} });
  assert.equal(db.preparationEligibility("first").eligible, true);
  db.planOperation({ runId: "first", idempotencyKey: "first:operation", kind: "provider-dispatch", intent: {} });
  assert.equal(db.preparationEligibility("first").eligible, false);
}));

test("two actual processes cannot admit concurrent preparation", async t => {
  const { spawn } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "rafi-admission-race-"));
  const setup = new WorkflowDb(root); setup.close();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const module = new URL("../src/workflowDb.ts", import.meta.url).href;
  const children = ["one", "two"].map(runId => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { WorkflowDb } from ${JSON.stringify(module)};
    const db = new WorkflowDb(process.argv[1]);
    process.on('message', message => {
      if (message === 'go') {
        try { db.acquireBuildAdmission(process.argv[2], 'worker'); process.send({state:'admitted'}); }
        catch (error) { process.send({state:'rejected', detail:String(error)}); }
      } else { db.close(); process.exit(0); }
    });
    process.send({state:'ready'});
  `, root, runId], { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  t.after(() => children.forEach(child => child.kill("SIGKILL")));
  const next = (child: typeof children[number]) => new Promise<{state:string;detail?:string}>((resolve, reject) => { child.once("message", value => resolve(value as {state:string})); child.once("error", reject); });
  await Promise.all(children.map(next));
  const results = children.map(next);
  children.forEach(child => child.send("go"));
  const observed = await Promise.all(results);
  assert.equal(observed.filter(item => item.state === "admitted").length, 1);
  assert.equal(observed.filter(item => item.state === "rejected").length, 1);
  assert.match(observed.find(item => item.state === "rejected")!.detail!, /admission is live/);
  const exits = children.map(child => new Promise(resolve => child.once("exit", resolve)));
  children.forEach(child => child.send("stop"));
  await Promise.all(exits);
});

test("retry supersession and launch reservation commit together and preserve frozen policy", () => fixture(db => {
  db.ensureRun("old");
  db.transition("old", { checkpoint: "preparing", state: { startArgs: ["start", db.projectDir] } });
  const retry = db.reservePreparationRetry("old", ["start", db.projectDir]);
  assert.equal(db.getRun("old")?.status, "superseded");
  assert.equal(db.preparationSuccessor("old"), retry.runId);
  assert.equal(db.buildLaunch(retry.launch.token)?.state, "reserved");
  assert.throws(() => db.reservePreparationRetry("old", ["start", db.projectDir]), /already retried/);
  db.failBuildLaunch(retry.authority, retry.launch.token);
  db.releaseBuildAdmission(retry.authority);
  const again = db.reservePreparationRetry(retry.runId, ["start", db.projectDir]);
  assert.equal(again.runId, retry.runId);
  assert.notEqual(again.launch.token, retry.launch.token);
}));

test("released workflow lease generations never repeat even with an explicit owner", () => fixture(db => {
  db.ensureRun("run");
  const first = db.acquireLease("run", "same-owner"); db.releaseLease(first);
  const second = db.acquireLease("run", "same-owner");
  assert.ok(second.generation > first.generation);
  assert.throws(() => db.heartbeatLease(first), /ownership changed/);
  db.releaseLease(first);
  assert.equal(db.currentLease()?.generation, second.generation);
}));

test("unknown future ownership schema rejects readers and writers without migration", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { WorkflowReader } = await import("../src/workflowReader.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-future-schema-"));
  try {
    const initial = new WorkflowDb(root); const path = initial.path; initial.close();
    const db = new Database(path); db.function("rafi_protocol_v3", () => 1); db.prepare("UPDATE build_ownership_schema SET version=99").run(); db.close();
    assert.throws(() => new WorkflowDb(root), /Unsupported build ownership schema/);
    assert.throws(() => new WorkflowReader(root), /Unsupported build ownership schema/);
    const after = new Database(path, { readonly: true });
    try { assert.equal((after.prepare("SELECT version FROM build_ownership_schema").get() as {version:number}).version, 99); }
    finally { after.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stale database connection cannot write dispatch intent after authority transfers", () => fixture((db, root) => {
  const original = db.acquireBuildAdmission("run", "coordinator");
  const stale = new WorkflowDb(root);
  try {
    const launch = db.reserveBuildLaunch(original, "worker", "digest"); db.dispatchBuildLaunch(original, launch.token);
    const child = new WorkflowDb(root);
    try {
      child.claimBuildLaunch("run", launch.token, "worker", "digest");
      assert.throws(() => stale.planOperation({ runId: "run", idempotencyKey: "stale-dispatch", kind: "provider-dispatch", intent: {} }), /original admission authority/);
      assert.equal(child.operation("stale-dispatch"), undefined);
      assert.throws(() => stale.transition("run", { checkpoint: "stale-status" }), /ownership changed/);
      child.ensureRun("branch-audit");
      child.planOperation({ runId: "branch-audit", idempotencyKey: "audit", kind: "audit", intent: {} });
      assert.ok(child.operation("audit"), "valid project owner can write its child workflow");
    } finally { child.close(); }
  } finally { stale.close(); }
}));

test("unacknowledged preparation subprocess intent prevents replay", () => fixture(db => {
  const owner = db.acquireBuildAdmission("run", "worker");
  const processId = db.beginOwnedPreparationProcess(owner);
  assert.deepEqual(db.unresolvedPreparationProcesses("run"), [processId]);
  assert.equal(db.preparationEligibility("run").eligible, false);
  assert.throws(() => db.releaseBuildAdmission(owner), /reconciliation/);
  db.finishOwnedPreparationProcess(owner, processId, true);
  assert.deepEqual(db.unresolvedPreparationProcesses("run"), []);
  db.releaseBuildAdmission(owner);
}));

for (const supervised of [true, false]) test(`preparation successor completes through the real ${supervised ? "supervised" : "unsupervised"} CLI`, async t => {
  const { spawnSync, execFileSync } = await import("node:child_process");
  const { copyFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = mkdtempSync(join(tmpdir(), "rafi-retry-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const bin = join(root, "bin"); mkdirSync(bin);
  const executable = join(bin, "codex");
  copyFileSync(fileURLToPath(new URL("fixtures/build-stall-codex.cjs", import.meta.url)), executable); chmodSync(executable, 0o755);
  const args = ["start", root, "--steps", "1", "--agent", "codex", "--yes", "--no-qa", ...(!supervised ? ["--no-supervisor"] : [])];
  const db = new WorkflowDb(root);
  try {
    db.ensureRun("old"); db.transition("old", { checkpoint: "preparing", state: { startArgs: args } });
    const retry = db.reservePreparationRetry("old", args);
    db.dispatchBuildLaunch(retry.authority, retry.launch.token);
    const { launchResumeStart, resumeExitCode } = await import(new URL("../../rafi/src/resumeLauncher.ts", import.meta.url).href);
    const previousPath = process.env.PATH;
    let code: number;
    try {
      process.env.PATH = `${bin}:${previousPath}`;
      code = resumeExitCode(await launchResumeStart(fileURLToPath(new URL("../src/index.ts", import.meta.url)), [...args, "--preparation-run", retry.runId, "--launch-token", retry.launch.token], { authority: retry.authority }));
    } finally { process.env.PATH = previousPath; }
    assert.equal(code, 0);
    assert.equal(db.getRun(retry.runId)?.status, "completed");
    assert.equal(db.preparationSuccessor("old"), retry.runId);
    assert.equal(db.getRun("old")?.status, "superseded");
    assert.equal(db.buildLaunch(retry.launch.token)?.state, "claimed");
    const duplicate = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url)), ...args, "--preparation-run", retry.runId, "--launch-token", retry.launch.token], { encoding: "utf8", timeout: 10000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already claimed/);
  } finally { db.close(); }
});

test("an interrupted ownership migration rolls back all new storage", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { migrateBuildAdmission } = await import("../src/buildAdmission.js");
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE workflow_runs(run_id TEXT PRIMARY KEY)");
    assert.throws(() => migrateBuildAdmission(db), /no such (table|column)/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='build_ownership_schema'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='build_admission'").get(), undefined);
  } finally { db.close(); }
});

for (const stage of ["reserved", "dispatching", "claimed"] as const) test(`launcher death at ${stage} preserves the successor and prohibits uncertain replay`, { timeout: 15000 }, async t => {
  const { spawn } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "rafi-launch-crash-"));
  const db = new WorkflowDb(root); db.ensureRun("old");
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const module = new URL("../src/workflowDb.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { WorkflowDb } from ${JSON.stringify(module)};
    const db = new WorkflowDb(process.argv[1]);
    const retry = db.reservePreparationRetry('old', ['start',process.argv[1]]);
    if (process.argv[2] !== 'reserved') db.dispatchBuildLaunch(retry.authority,retry.launch.token);
    if (process.argv[2] === 'claimed') { db.registerBuildLaunchChild(retry.launch.token); db.acknowledgeBuildLaunchChild(retry.authority,retry.launch.token,process.pid); db.claimBuildLaunch(retry.runId,retry.launch.token,'coordinator',retry.launch.digest); }
    process.send(retry.runId);
    setInterval(() => {},1000);
  `, root, stage], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => child.kill("SIGKILL"));
  const successor = await new Promise<string>((resolve, reject) => { child.once("message", message => resolve(String(message))); child.once("error", reject); child.once("exit", code => reject(new Error(`fixture exited before registration: ${code}`))); });
  const exit = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exit;
  assert.equal(db.preparationSuccessor("old"), successor);
  if (stage === "dispatching") assert.throws(() => db.reservePreparationRetry(successor, ["start", root]), /unresolved launch/);
  else assert.equal(db.reservePreparationRetry(successor, ["start", root]).runId, successor);
});

test("preparation successors retain frozen policy, restart counts, and attributable answered scope decisions", async () => {
  const { resolveAutonomyPolicy } = await import("../src/recoveryPolicy.js");
  fixture(db => {
    db.ensureRun("old");
    const policy = db.freezeAutonomyPolicy("old", resolveAutonomyPolicy(undefined));
    db.putSupervisorState("old", { status: "failed", generation: 4, workerGeneration: 3, checkpointRestarts: 2, runRestarts: 2 });
    const decision = db.ensureHumanDecision({ runId: "old", decisionKey: "old:approved-scope:unchanged-digest", interruptionId: "scope", prompt: "Approve unchanged scope?", choices: [{id:"proceed",label:"Proceed"}] });
    db.answerHumanDecision("old", decision.decisionId, "proceed");
    const retry = db.reservePreparationRetry("old", ["start", db.projectDir]);
    assert.deepEqual(db.autonomyPolicy(retry.runId), policy);
    assert.equal(db.supervisorState(retry.runId)?.runRestarts, 2);
    const inherited = db.ensureHumanDecision({ runId: retry.runId, decisionKey: `${retry.runId}:approved-scope:unchanged-digest`, interruptionId: "scope", prompt: "Approve unchanged scope?", choices: [{id:"proceed",label:"Proceed"}] });
    assert.equal(inherited.status, "answered");
    const changed = db.ensureHumanDecision({ runId: retry.runId, decisionKey: `${retry.runId}:approved-scope:changed-digest`, interruptionId: "scope", prompt: "Approve changed scope?", choices: [{id:"proceed",label:"Proceed"}] });
    assert.equal(changed.status, "pending");
  });
});

test("legacy owners without a verifiable identity block admission rather than becoming inactive", async () => {
  const { hostname } = await import("node:os");
  fixture(db => {
    db.createRun({ runId: "legacy", kind: "build", legacy: true, state: { status: "recoverable", lease: { pid: process.pid, hostname: hostname(), processStart: "unavailable" } } });
    assert.throws(() => db.acquireBuildAdmission("new", "worker"), /Legacy build legacy ownership is unknown/);
    assert.equal(db.getRun("new"), undefined);
  });
});


test("deserialized completed snapshot cannot resurrect an unlocked build", async () => {
  const { createBuildRun, completeBuildRun, readBuildRuns, saveBuildRun } = await import("../src/buildRuns.js");
  fixture((_db, root) => {
    const run = createBuildRun({ repositoryRoot: root, tickets: [] });
    completeBuildRun(root, run);
    const saved = readBuildRuns(root).find(r => r.runId === run.runId)!;
    assert.throws(() => saveBuildRun(root, { ...saved, status: "running" }), /authority|ownership/);
    assert.equal(readBuildRuns(root).find(r => r.runId === run.runId)?.status, "completed");
  });
});

test("gated launch registration must be acknowledged and retirement fences a delayed child", () => fixture(db => {
  db.ensureRun("old");
  const retry = db.reservePreparationRetry("old", ["start", db.projectDir, "--steps", "1"]);
  db.dispatchBuildLaunch(retry.authority, retry.launch.token);
  const digest = launchDigest(["start", db.projectDir, "--steps", "1"]);
  assert.throws(() => db.claimBuildLaunch(retry.runId, retry.launch.token, "coordinator", digest), /registration/);
  db.registerBuildLaunchChild(retry.launch.token);
  assert.throws(() => db.registerBuildLaunchChild(retry.launch.token), /registered/);
  assert.equal(db.reconcileBuildLaunches(retry.runId, retry.authority), "retired");
  assert.throws(() => db.acknowledgeBuildLaunchChild(retry.authority, retry.launch.token, process.pid), /acknowledged/);
  assert.throws(() => db.claimBuildLaunch(retry.runId, retry.launch.token, "coordinator", digest), /Invalid/);
  db.releaseBuildAdmission(retry.authority);
  const next = db.reservePreparationRetry(retry.runId, ["start", db.projectDir, "--steps", "1"]);
  assert.equal(next.runId, retry.runId);
  assert.notEqual(next.launch.token, retry.launch.token);
}));

test("acknowledged live child and claimed child cannot be retired", () => fixture(db => {
  db.ensureRun("old");
  const args = ["start", db.projectDir, "--steps", "1"];
  const retry = db.reservePreparationRetry("old", args);
  db.dispatchBuildLaunch(retry.authority, retry.launch.token);
  db.registerBuildLaunchChild(retry.launch.token);
  db.acknowledgeBuildLaunchChild(retry.authority, retry.launch.token, process.pid);
  assert.equal(db.reconcileBuildLaunches(retry.runId, retry.authority), "unknown");
  const owner = db.claimBuildLaunch(retry.runId, retry.launch.token, "coordinator", launchDigest(args));
  db.reconcileBuildLaunches(retry.runId, retry.authority);
  assert.equal(db.buildLaunch(retry.launch.token)?.state, "claimed");
  db.releaseBuildAdmission(owner);
}));

test("a valid admission cannot mutate an unrelated existing build", () => fixture(db => {
  db.ensureRun("unrelated");
  db.acquireBuildAdmission("owner", "worker");
  assert.throws(() => db.transition("unrelated", { checkpoint: "wrong-run" }), /another run/);
  assert.throws(() => db.planOperation({ runId: "unrelated", idempotencyKey: "wrong-run", kind: "provider-dispatch", intent: {} }), /authority/);
  assert.equal(db.operation("wrong-run"), undefined);
}));

test("unresolved legacy probes block admission even on terminal history", () => fixture(db => {
  db.ensureRun("history");
  db.transition("history", { status: "completed", checkpoint: "complete" });
  (db as any).db.prepare("INSERT INTO build_owned_processes(id,run_id,owner,pid,process_start,host,state) VALUES('legacy','history','old',NULL,NULL,'unknown','completed')").run();
  assert.throws(() => db.acquireBuildAdmission("current", "worker"), /descendants/);
  db.ensureRun("unresolved");
  (db as any).db.prepare("INSERT INTO build_owned_processes(id,run_id,owner,pid,process_start,host,state) VALUES('orphan','unresolved','old',NULL,NULL,'unknown','completed')").run();
  assert.throws(() => db.acquireBuildAdmission("next", "worker"), /descendants/);
}));

for (const mode of ["supervised", "direct", "detached"]) test(`established recovery claims its run through actual ${mode} CLI`, { timeout: 30000 }, async t => {
  const { execFileSync } = await import("node:child_process");
  const { copyFileSync, chmodSync, mkdirSync, existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { createBuildRun, releaseBuildLease, saveBuildRun } = await import("../src/buildRuns.js");
  const root = mkdtempSync(join(tmpdir(), "rafi-established-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const bin = join(root, "bin"); mkdirSync(bin);
  copyFileSync(fileURLToPath(new URL("fixtures/build-stall-codex.cjs", import.meta.url)), join(bin, "codex")); chmodSync(join(bin, "codex"), 0o755);
  let run = createBuildRun({ repositoryRoot: root, tickets: [], builder: { role: "builder", source: "project", make: "codex", model: "default", reasoning: "high", fast: false } });
  run = saveBuildRun(root, { ...run, recoveryDecision: { version: 1, mode: "fresh-recovery-only", runId: run.runId, tickets: [], role: "builder", authoritativeStateDigest: "fixture", settings: run.builder!.settings, worktree: root, planUpdateApproval: "auto", decidedAt: new Date().toISOString() } });
  run = releaseBuildLease(root, run, "recoverable");
  const args = ["start", root, "--steps", "1", "--agent", "codex", "--yes", "--no-qa", "--recover-run", run.runId, ...(mode === "direct" ? ["--no-supervisor"] : mode === "detached" ? ["--detach"] : [])];
  const db = new WorkflowDb(root);
  const prior = process.env.PATH;
  try {
    const owner = db.acquireBuildRecoveryAdmission(run.runId);
    const launch = db.reserveBuildLaunch(owner, "coordinator", launchDigest(args), "registered-v2");
    db.dispatchBuildLaunch(owner, launch.token);
    process.env.PATH = `${bin}:${prior}`;
    const { launchResumeStart, resumeExitCode } = await import(new URL("../../rafi/src/resumeLauncher.ts", import.meta.url).href);
    const code = resumeExitCode(await launchResumeStart(fileURLToPath(new URL("../src/index.ts", import.meta.url)), [...args, "--launch-token", launch.token], { authority: owner }));
    assert.equal(code, 0);
    assert.equal(db.buildLaunch(launch.token)?.state, "claimed");
    const deadline = Date.now() + 15000;
    const { classifyProcess, processGroupQuiescent } = await import("../src/processIdentity.js");
    const detachedFinished = () => {
      const supervisor = db.supervisorState(run.runId);
      return db.getRun(run.runId)?.status === "completed" && supervisor?.status === "stopped" && supervisor.pid
        && (classifyProcess(supervisor.pid, supervisor.processStart).state === "dead" || (process.platform !== "win32" && processGroupQuiescent(supervisor.pid)));
    };
    while (mode === "detached" && !detachedFinished() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (mode === "detached") assert.ok(detachedFinished(), "detached supervisor must finish before deleting its project");
    assert.equal(db.getRun(run.runId)?.status, "completed");
    assert.equal(db.preparationSuccessor(run.runId), run.runId);
    assert.equal(existsSync(join(root, "implemented.txt")), true);
  } finally { process.env.PATH = prior; db.close(); }
});
