import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { WorkflowDb } from "../src/workflowDb.js";
import { recoverableBuildRuns } from "../src/buildRuns.js";
import { processStartIdentity } from "../src/processIdentity.js";

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "rafi-readiness-recovery-"));
  const db = new WorkflowDb(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, raw: (db as any).db as Database.Database };
}
function markOwnerDead(raw: Database.Database) {
  const owner = JSON.parse((raw.prepare("SELECT record_json FROM build_admission").get() as any).record_json);
  owner.pid = 2147483647;
  raw.prepare("UPDATE build_admission SET record_json=?").run(JSON.stringify(owner));
  for (const row of raw.prepare("SELECT id,outcome_json FROM build_owned_processes").all() as any[]) {
    const meta = JSON.parse(row.outcome_json);
    if (meta.authority) meta.authority.pid = owner.pid;
    raw.prepare("UPDATE build_owned_processes SET outcome_json=? WHERE id=?").run(JSON.stringify(meta), row.id);
  }
}
test("abandoned unspawned intent revokes, preserves run and permits a subsequent build", async t => {
  const { root, db, raw } = fixture(t);
  const owner = db.acquireBuildAdmission("old", "worker");
  const id = db.beginOwnedPreparationProcess(owner, undefined, true);
  const before = db.getRun("old");
  assert.throws(() => db.acquireBuildAdmission("next", "worker"));
  assert.deepEqual(await db.reconcileReadiness("old"), [id], "live owner cannot be taken over");
  markOwnerDead(raw);
  assert.deepEqual(await db.reconcileReadiness("old"), []);
  assert.deepEqual(db.getRun("old"), before);
  assert.throws(() => db.registerReadinessHelper(id), /registration rejected/);
  assert.equal(db.acquireBuildAdmission("next", "worker").runId, "next");
  assert.equal(recoverableBuildRuns(root).some(run => run.cleanupOnly), false);
});
for (const status of ["completed", "cancelled", "superseded"] as const) test(`terminal ${status} cleanup stays discoverable without build JSON`, async t => {
  const { root, db, raw } = fixture(t);
  const owner = db.acquireBuildAdmission("old", "worker");
  db.beginOwnedPreparationProcess(owner, undefined, true);
  db.transition("old", { status, checkpoint: "terminal", state: {} });
  const before = db.getRun("old");
  markOwnerDead(raw);
  const entries = recoverableBuildRuns(root);
  assert.equal(entries.length, 1); assert.equal(entries[0]!.cleanupOnly, true);
  assert.throws(() => db.acquireBuildAdmission("next", "worker"), /descendants/);
  assert.deepEqual(await db.reconcileReadiness("old"), []);
  assert.deepEqual(db.getRun("old"), before);
  assert.equal(recoverableBuildRuns(root).length, 0);
  db.acquireBuildAdmission("next", "worker");
});
test("authorized helper paused before provider cannot be revoked or cleared from empty inventory", async t => {
  const { root, db, raw } = fixture(t);
  const owner = db.acquireBuildAdmission("run", "worker");
  const id = db.beginOwnedPreparationProcess(owner, undefined, true);
  const module = new URL("../src/workflowDb.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {WorkflowDb} from ${JSON.stringify(module)}; const d=new WorkflowDb(${JSON.stringify(root)}); d.registerReadinessHelper(${JSON.stringify(id)}); d.close(); process.send('registered'); setInterval(()=>{},1000);`], { stdio: ["ignore", "ignore", "inherit", "ipc"], detached: process.platform !== "win32" });
  t.after(() => { child.kill("SIGKILL"); });
  await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error("helper exited before barrier"))); });
  db.authorizeReadinessHelper(owner, id, child.pid!);
  assert.throws(() => db.revokeReadinessHelper(id, owner), /cannot be revoked/);
  assert.equal(db.unresolvedPreparationProcesses("run").length, 1);
  const exit = new Promise(resolve => child.once("exit", resolve));
  assert.deepEqual(await db.reconcileReadiness("run", owner), []);
  await exit;
  const meta = JSON.parse((raw.prepare("SELECT outcome_json FROM build_owned_processes WHERE id=?").get(id) as any).outcome_json);
  assert.equal(meta.startup, "authorized", "cleanup preserves authorization history");
  assert.equal(meta.cleanup.state, "quiescent");
  db.beginOwnedPreparationProcess(owner, undefined, true);
});
test("open legacy SQLite writer is fenced while current writer remains usable", async t => {
  const { root, db, raw } = fixture(t);
  // Model a connection that passed its old schema check before migration.
  for (const row of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'protocol_v3_%'").all() as any[]) raw.exec(`DROP TRIGGER ${row.name}`);
  raw.prepare("UPDATE build_ownership_schema SET version=2").run();
  const old = new Database(db.path);
  t.after(() => old.close());
  assert.equal((old.prepare("SELECT version FROM build_ownership_schema").get() as any).version, 2);
  const upgraded = new WorkflowDb(root);
  try {
    assert.equal((raw.prepare("SELECT version FROM build_ownership_schema").get() as any).version, 3);
    const { acquireAdmission } = await import("../src/buildAdmission.js");
    assert.throws(() => acquireAdmission(old, root, "old", "worker"), /rafi_protocol_v3/);
    assert.throws(() => old.prepare("INSERT INTO build_runtime_runs VALUES('old')").run(), /rafi_protocol_v3/);
    assert.throws(() => old.prepare("DELETE FROM project_lease").run(), /rafi_protocol_v3/);
    assert.throws(() => old.prepare("INSERT OR REPLACE INTO build_admission VALUES(1,'{}')").run(), /rafi_protocol_v3/);
    const owner = upgraded.acquireBuildAdmission("new", "worker");
    upgraded.beginOwnedPreparationProcess(owner, undefined, true);
  } finally { upgraded.close(); }
});
test("legacy PID-less direct-spawn failure can reconcile only with attributable dead owner", async t => {
  const { db, raw } = fixture(t);
  const owner = db.acquireBuildAdmission("run", "worker");
  const id = db.beginOwnedPreparationProcess(owner);
  assert.deepEqual(await db.reconcileReadiness("run"), [id]);
  markOwnerDead(raw);
  assert.deepEqual(await db.reconcileReadiness("run"), process.platform === "win32" ? [id] : []);
});
test("unknown legacy provenance and foreign-host ownership remain visible and untouched", async t => {
  const { root, db, raw } = fixture(t);
  db.ensureRun("old"); db.transition("old", { status: "completed", checkpoint: "done" });
  raw.prepare("INSERT INTO build_owned_processes(id,run_id,owner,host,state) VALUES('unknown','old','lost','foreign','intended')").run();
  assert.deepEqual(await db.reconcileReadiness("old"), ["unknown"]);
  assert.equal(recoverableBuildRuns(root)[0]!.cleanupOnly, true);
});

test("live legacy execution defers migration without preventing read-only inspection", async t => {
  const { root, db, raw } = fixture(t);
  const owner = db.acquireBuildAdmission("legacy", "worker");
  for (const row of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'protocol_v3_%'").all() as any[]) raw.exec(`DROP TRIGGER ${row.name}`);
  raw.prepare("UPDATE build_ownership_schema SET version=2").run();
  const pending = new WorkflowDb(root);
  try { assert.throws(() => pending.beginOwnedPreparationProcess(owner, undefined, true), /migration/); }
  finally { pending.close(); }
  const { WorkflowReader } = await import("../src/workflowReader.js");
  const reader = new WorkflowReader(root);
  try { assert.equal(reader.getRun("legacy")?.runId, "legacy"); } finally { reader.close(); }
  markOwnerDead(raw);
  const upgraded = new WorkflowDb(root);
  try { const next = upgraded.acquireBuildAdmission("next", "worker"); upgraded.beginOwnedPreparationProcess(next, undefined, true); }
  finally { upgraded.close(); }
});
test("failed migration rolls compatibility guards and schema back together", async t => {
  const { db, raw } = fixture(t);
  for (const row of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'protocol_v3_%'").all() as any[]) raw.exec(`DROP TRIGGER ${row.name}`);
  raw.prepare("UPDATE build_ownership_schema SET version=2").run();
  const { migrateBuildAdmission } = await import("../src/buildAdmission.js");
  raw.function("rafi_protocol_v3", () => { throw new Error("injected migration failure"); });
  assert.throws(() => migrateBuildAdmission(raw), /injected migration failure/);
  assert.equal((raw.prepare("SELECT version FROM build_ownership_schema").get() as any).version, 2);
  assert.equal((raw.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'protocol_v3_%'").get() as any).n, 0);
  raw.function("rafi_protocol_v3", () => 1);
  migrateBuildAdmission(raw);
  db.acquireBuildAdmission("subsequent", "worker");
});

test("two reconcilers persist one cleanup without touching a different live owner", async t => {
  const { db, raw } = fixture(t);
  const owner = db.acquireBuildAdmission("run", "worker");
  db.beginOwnedPreparationProcess(owner, undefined, true);
  markOwnerDead(raw);
  const before = db.getRun("run");
  assert.deepEqual(await Promise.all([db.reconcileReadiness("run"), db.reconcileReadiness("run")]), [[], []]);
  assert.deepEqual(db.getRun("run"), before);
  const next = db.acquireBuildAdmission("other", "worker");
  const id = db.beginOwnedPreparationProcess(next, undefined, true);
  assert.deepEqual(await db.reconcileReadiness("other"), [id]);
  assert.equal(db.buildAdmission()?.token, next.token);
});

test("restricted readiness connection cannot acquire admission, modify work or touch another probe", async t => {
  const { root, db, raw } = fixture(t);
  const owner = db.acquireBuildAdmission("run", "worker");
  const id = db.beginOwnedPreparationProcess(owner, undefined, true);
  const restricted = new WorkflowDb(root, undefined, { probeId: id });
  try {
    const limited = (restricted as any).db as Database.Database;
    assert.throws(() => limited.prepare("DELETE FROM build_admission").run(), /Restricted readiness/);
    assert.throws(() => limited.prepare("UPDATE workflow_runs SET checkpoint='wrong'").run(), /Restricted readiness/);
    assert.throws(() => limited.prepare("UPDATE build_owned_processes SET run_id='other' WHERE id=?").run(id), /Restricted readiness/);
    restricted.revokeReadinessHelper(id, owner);
    assert.deepEqual(await restricted.reconcileReadiness("run", owner), []);
    assert.equal(db.buildAdmission()?.token, owner.token);
    assert.notEqual(db.getRun("run")?.checkpoint, "wrong");
  } finally { restricted.close(); }
});

test("reused leader incarnation never signals an unrelated live group", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  const { cleanupReadiness } = await import("../src/readinessCleanup.js");
  const { randomUUID } = await import("node:crypto");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await new Promise(resolve => child.once("spawn", resolve));
  const evidence = await cleanupReadiness({ id: randomUUID(), run_id: "old", owner: "old", pid: child.pid!, process_start: "different-incarnation", host: hostname(), state: "running", outcome_json: JSON.stringify({ protocol: "gated-v3", startup: "authorized" }) }, Date.now() + 200);
  assert.equal(evidence.state, "unknown");
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test("copied ownership from another project cannot be revoked or cleaned", async t => {
  const { root, db, raw } = fixture(t);
  const owner = db.acquireBuildAdmission("run", "worker");
  const id = db.beginOwnedPreparationProcess(owner, undefined, true);
  markOwnerDead(raw);
  const row = raw.prepare("SELECT outcome_json FROM build_owned_processes WHERE id=?").get(id) as any;
  const metadata = JSON.parse(row.outcome_json); metadata.authority.project = join(root, "different-project");
  raw.prepare("UPDATE build_owned_processes SET outcome_json=? WHERE id=?").run(JSON.stringify(metadata), id);
  assert.deepEqual(await db.reconcileReadiness("run"), [id]);
  assert.match(db.readinessCleanupDetails("run").join(" "), /another project/);
});

test("corrupt relationship cycles stay visible and cannot broaden cleanup scope", async t => {
  const { root, db, raw } = fixture(t);
  db.ensureRun("related");
  const owner = db.acquireBuildAdmission("run", "worker");
  const id = db.beginOwnedPreparationProcess(owner, undefined, true);
  raw.prepare("INSERT INTO build_child_runs VALUES('run','related')").run();
  raw.prepare("INSERT INTO build_child_runs VALUES('related','run')").run();
  markOwnerDead(raw);
  assert.deepEqual(await db.reconcileReadiness("run"), [id]);
  assert.match(db.readinessCleanupDetails("run").join(" "), /cycle/);
  assert.ok(recoverableBuildRuns(root).some(run => run.runId === "run"));
  raw.prepare("DELETE FROM build_child_runs WHERE child='related'").run();
  assert.deepEqual(await db.reconcileReadiness("run"), []);
});

for (const status of ["in_progress", "uncertain"]) for (const role of ["builder", "qa"]) test(`legacy ${role} ${status} dispatch survives upgrade and reaches owning recovery`, async t => {
  const { root, db, raw } = fixture(t);
  db.ensureRun("interrupted", "build");
  for (const row of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'protocol_v3_%'").all() as any[]) raw.exec(`DROP TRIGGER ${row.name}`);
  raw.prepare("UPDATE build_ownership_schema SET version=2").run();
  raw.prepare("INSERT INTO operation_journal VALUES('pending','interrupted','provider-dispatch',?,?,NULL,NULL,NULL,?,?)").run(status, JSON.stringify({ role }), new Date().toISOString(), new Date().toISOString());
  const before = raw.prepare("SELECT * FROM operation_journal").all();
  const legacy = new Database(db.path);
  const upgraded = new WorkflowDb(root);
  try {
    assert.equal((raw.prepare("SELECT version FROM build_ownership_schema").get() as any).version, 3);
    assert.deepEqual(raw.prepare("SELECT * FROM operation_journal").all(), before);
    assert.throws(() => legacy.prepare("UPDATE operation_journal SET status='completed'").run(), /rafi_protocol_v3/);
    assert.throws(() => upgraded.acquireBuildAdmission("new", "worker"), /unresolved provider dispatch/);
    assert.throws(() => upgraded.acquireBuildRecoveryAdmission("different"), /unresolved provider dispatch/);
    const owner = upgraded.acquireBuildRecoveryAdmission("interrupted");
    assert.equal(upgraded.unresolvedRoleDispatches("interrupted", role).length, 1);
    assert.deepEqual(raw.prepare("SELECT * FROM operation_journal").all(), before);
    upgraded.releaseBuildAdmission(owner);
  } finally { upgraded.close(); legacy.close(); }
});
