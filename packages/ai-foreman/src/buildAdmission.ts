import { registerHandbackWriter } from "./qaHandbackMigration.js";
import type { ProjectLease } from "./workflowDb.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { classifyProcess, processStartIdentity } from "./processIdentity.js";

export class BuildOwnershipError extends Error {
  constructor(readonly code: "stale-owner" | "unknown-owner" | "active-owner" | "invalid-launch", message: string) {
    super(message); this.name = "BuildOwnershipError";
  }
}

export interface BuildAdmission {
  token: string; runId: string; project: string; pid: number; host: string;
  processStart: string; phase: "coordinator" | "worker"; heartbeatAt: string;
}
export interface BuildLaunch {
  token: string; runId: string; project: string; launcher: string; role: BuildAdmission["phase"];
  digest: string; state: "reserved" | "dispatching" | "claimed" | "failed";
  claimant?: BuildAdmission; createdAt: string;
  protocol?: "registered-v2"; child?: { pid: number; processStart: string; host: string }; acknowledged?: boolean;
}
export function canonicalProject(project: string): string { return realpathSync(resolve(project)); }
const localAuthorities = new Map<string, BuildAdmission>();
const invocation = new AsyncLocalStorage<{ authority?: BuildAdmission; leases?: Map<string, ProjectLease> }>();
const localLeases = new Map<string, ProjectLease>();
export function originalBuildLease(project: string): ProjectLease | undefined { return (invocation.getStore()?.leases ?? (invocation.getStore() ? new Map() : localLeases)).get(canonicalProject(project)); }
export function rememberOriginalLease(project: string, lease: ProjectLease): void { const scope = invocation.getStore(); const leases = scope ? (scope.leases ??= new Map()) : localLeases; leases.set(canonicalProject(project), lease); }
export function forgetOriginalLease(project: string, lease: ProjectLease): void { const leases = invocation.getStore()?.leases ?? localLeases; if (leases.get(canonicalProject(project))?.owner === lease.owner) leases.delete(canonicalProject(project)); }
export function withBuildInvocation<T>(work: () => T): T { return invocation.run({}, work); }
export function localBuildAuthority(project: string): BuildAdmission | undefined { const scope = invocation.getStore(); const authority = scope ? scope.authority : localAuthorities.get(canonicalProject(project)); return authority?.project === canonicalProject(project) ? authority : undefined; }
export function rememberBuildAuthority(authority: BuildAdmission): void { const scope = invocation.getStore(); if (scope) scope.authority = authority; else localAuthorities.set(authority.project, authority); }
export function forgetBuildAuthority(authority: BuildAdmission): void { const scope = invocation.getStore(); if (scope?.authority?.token === authority.token) delete scope.authority; if (!scope && localAuthorities.get(authority.project)?.token === authority.token) localAuthorities.delete(authority.project); }
export function launchDigest(args: readonly string[]): string {
  const options: string[][] = [];
  for (let i = 2; i < args.length; i++) {
    const option = [args[i]!];
    if (args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) option.push(args[++i]!);
    options.push(option);
  }
  options.sort((a, b) => a[0]!.localeCompare(b[0]!));
  return createHash("sha256").update(JSON.stringify([args[0], args[1], options])).digest("hex");
}

export function checkBuildOwnershipSchema(db: Database.Database): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='build_ownership_schema'").get();
  if (!exists) return;
  const row = db.prepare("SELECT version FROM build_ownership_schema WHERE singleton=1").get() as {version:number}|undefined;
  if (!row || ![1, 2, 3].includes(row.version)) throw new Error(`Unsupported build ownership schema ${row?.version ?? "missing"}; upgrade Rafi before accessing it`);
}

const ownershipHeartbeats = new Map<string, ReturnType<typeof setInterval>>();
export function maintainBuildAdmission(authority: BuildAdmission): void {
  const timer = setInterval(() => {
    let db: Database.Database | undefined;
    try {
      db = new Database(join(authority.project, ".rafi/recovery.sqlite3"), { fileMustExist: true });
      db.function("rafi_protocol_v3", () => 1);
      registerHandbackWriter(db);
      const changed = db.prepare("UPDATE build_admission SET record_json=json_set(record_json,'$.heartbeatAt',?) WHERE singleton=1 AND json_extract(record_json,'$.token')=?").run(new Date().toISOString(), authority.token);
      if (changed.changes !== 1) stopBuildAdmissionHeartbeat(authority);
    } catch { stopBuildAdmissionHeartbeat(authority); }
    finally { db?.close(); }
  }, 5000);
  timer.unref();
  ownershipHeartbeats.set(authority.token, timer);
}
export function stopBuildAdmissionHeartbeat(authority: BuildAdmission): void {
  const timer = ownershipHeartbeats.get(authority.token);
  if (timer) clearInterval(timer);
  ownershipHeartbeats.delete(authority.token);
}

/** Additive, transactional storage. Readers never invoke this migration. */
export function migrateBuildAdmission(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS build_ownership_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
      INSERT OR IGNORE INTO build_ownership_schema VALUES(1,1);`);
    const version = (db.prepare("SELECT version FROM build_ownership_schema WHERE singleton=1").get() as {version:number}).version;
    if (![1, 2, 3].includes(version)) throw new Error(`Unsupported build ownership schema ${version}; upgrade Rafi before writing`);
    if (version >= 2) { migrateReadinessProtocol(db); return; }
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_lease_sequence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL);
      INSERT OR IGNORE INTO workflow_lease_sequence VALUES(1,0);
      CREATE TABLE IF NOT EXISTS build_runtime_runs(run_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS build_child_runs(child TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),parent TEXT NOT NULL REFERENCES workflow_runs(run_id),CHECK(child<>parent));
      CREATE TABLE IF NOT EXISTS build_admission(singleton INTEGER PRIMARY KEY CHECK(singleton=1),record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS build_retry_lineage(predecessor TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),successor TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id),project TEXT NOT NULL,created_at TEXT NOT NULL,CHECK(predecessor<>successor));
      CREATE TABLE IF NOT EXISTS build_owned_processes(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,owner TEXT NOT NULL,pid INTEGER,process_start TEXT,host TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS build_launches(token TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),state TEXT NOT NULL,record_json TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS build_launch_exclusive ON build_launches(run_id) WHERE state IN ('reserved','dispatching');`);
    if (!(db.prepare("PRAGMA table_info(build_owned_processes)").all() as Array<{name:string}>).some(column => column.name === "outcome_json")) db.exec("ALTER TABLE build_owned_processes ADD COLUMN outcome_json TEXT");
    db.exec(`CREATE TRIGGER IF NOT EXISTS build_lineage_project BEFORE INSERT ON build_retry_lineage
      WHEN NEW.project<>COALESCE((SELECT json_extract(record_json,'$.project') FROM build_admission WHERE singleton=1),'')
      BEGIN SELECT RAISE(ABORT,'Retry lineage project does not match admission'); END;
      CREATE TRIGGER IF NOT EXISTS build_lineage_cycle BEFORE INSERT ON build_retry_lineage
      WHEN EXISTS(WITH RECURSIVE chain(id) AS (SELECT NEW.successor UNION SELECT successor FROM build_retry_lineage JOIN chain ON predecessor=chain.id) SELECT 1 FROM chain WHERE id=NEW.predecessor)
      BEGIN SELECT RAISE(ABORT,'Retry lineage cycle is invalid'); END;
      CREATE TRIGGER IF NOT EXISTS build_lineage_immutable BEFORE UPDATE ON build_retry_lineage
      BEGIN SELECT RAISE(ABORT,'Retry lineage is immutable'); END;`);
    db.prepare("UPDATE build_ownership_schema SET version=2 WHERE singleton=1").run();
    db.exec("INSERT OR IGNORE INTO build_runtime_runs SELECT run_id FROM workflow_runs WHERE kind='build' AND json_extract(state_json,'$.version') IS NOT NULL");
    const qaTables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>)
      .map(row => row.name).filter(name => /^qa_[a-z_]+$/.test(name) && (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{name:string}>).some(column => column.name === "run_id"));
    for (const table of [...new Set(["operation_journal", "provider_sessions", "role_mutation_leases", "continuity_heads", "continuity_checkpoints", "continuity_events", "handoffs", "compaction_attempts", "recovery_decisions", "recovery_attempts", "role_settings", "publication_transactions", "branch_resume_sessions", ...qaTables])]) {
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const target = action === "DELETE" ? "OLD" : "NEW";
        db.exec(`DROP TRIGGER IF EXISTS build_fence_${table}_${action.toLowerCase()};
          CREATE TRIGGER build_fence_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table}
          WHEN (EXISTS(SELECT 1 FROM build_admission) OR rafi_build_writer_run()<>'' OR EXISTS(SELECT 1 FROM build_runtime_runs WHERE run_id=${target}.run_id))
          AND NOT EXISTS(SELECT 1 FROM build_admission WHERE json_extract(record_json,'$.token')=rafi_build_writer_token() AND (json_extract(record_json,'$.runId')=${target}.run_id OR EXISTS(SELECT 1 FROM build_child_runs c WHERE c.child=${target}.run_id AND c.parent=json_extract(record_json,'$.runId')) OR EXISTS(SELECT 1 FROM workflow_runs r WHERE r.run_id=${target}.run_id AND r.status='superseded' AND json_extract(r.state_json,'$.supersededBy')=json_extract(record_json,'$.runId'))))
          AND NOT (NOT EXISTS(SELECT 1 FROM build_admission) AND EXISTS(SELECT 1 FROM project_lease WHERE owner=rafi_build_lease_owner() AND generation=rafi_build_lease_generation() AND (run_id=${target}.run_id OR EXISTS(SELECT 1 FROM workflow_runs r WHERE r.run_id=project_lease.run_id AND r.kind='recovery' AND json_extract(r.state_json,'$.operation')='build-start-over'))))
          BEGIN SELECT RAISE(ABORT,'Build mutation rejected: original admission authority is stale or missing'); END;`);
      }
    }
    migrateReadinessProtocol(db);
  }).immediate();
}
export function readAdmission(db: Database.Database): BuildAdmission | undefined {
  const row = db.prepare("SELECT record_json FROM build_admission WHERE singleton=1").get() as {record_json:string}|undefined;
  return row ? JSON.parse(row.record_json) : undefined;
}
export function assertAdmission(db: Database.Database, authority: BuildAdmission): void {
  const held = readAdmission(db);
  if (!held || held.token !== authority.token || held.runId !== authority.runId || held.project !== authority.project) throw new BuildOwnershipError("stale-owner", "Build admission ownership changed; stale caller cannot mutate or dispatch");
}
export function acquireAdmission(db: Database.Database, project: string, runId: string, phase: BuildAdmission["phase"]): BuildAdmission {
  return db.transaction(() => {
    const held = readAdmission(db);
    if (held) {
      const owner = classifyProcess(held.pid, held.processStart, held.host);
      if (owner.state !== "dead") throw new BuildOwnershipError(owner.state === "live" ? "active-owner" : "unknown-owner", `Build ${held.runId} admission is ${owner.state}: ${owner.reason}`);
      // A reserved launch cannot spawn until its owner conditionally marks it
      // dispatching. Fence that transition before replacing a proven-dead owner.
      for (const row of db.prepare("SELECT record_json FROM build_launches WHERE run_id=? AND state='reserved'").all(held.runId) as Array<{record_json:string}>) {
        const launch = JSON.parse(row.record_json) as BuildLaunch;
        db.prepare("UPDATE build_launches SET state='failed',record_json=? WHERE token=?").run(JSON.stringify({ ...launch, state: "failed" }), launch.token);
      }
      const pending = db.prepare("SELECT 1 FROM build_launches WHERE run_id=? AND state='dispatching'").get(held.runId);
      if (pending) throw new Error(`Build ${held.runId} has an unresolved launch; reconcile its child before retrying`);
    }
    db.prepare("INSERT OR IGNORE INTO build_runtime_runs VALUES(?)").run(runId);
    const authority: BuildAdmission = { token: randomUUID(), project: canonicalProject(project), runId, pid: process.pid, host: hostname(), processStart: processStartIdentity(), phase, heartbeatAt: new Date().toISOString() };
    db.prepare("INSERT OR REPLACE INTO build_admission VALUES(1,?)").run(JSON.stringify(authority));
    return authority;
  }).immediate();
}
export function releaseAdmission(db: Database.Database, authority: BuildAdmission): void {
  db.transaction(() => {
    assertAdmission(db, authority);
    if (db.prepare("SELECT 1 FROM build_launches WHERE run_id=? AND state IN ('reserved','dispatching')").get(authority.runId)) throw new Error("Cannot release admission with an unresolved launch");
    db.prepare("DELETE FROM build_admission WHERE singleton=1").run();
  }).immediate();
}
export function reserveLaunch(db: Database.Database, authority: BuildAdmission, role: BuildAdmission["phase"], digest: string, protocol?: BuildLaunch["protocol"]): BuildLaunch {
  return db.transaction(() => {
    assertAdmission(db, authority);
    const launch: BuildLaunch = { token: randomUUID(), runId: authority.runId, project: authority.project, launcher: authority.token, role, digest, protocol, state: "reserved", createdAt: new Date().toISOString() };
    db.prepare("INSERT INTO build_launches VALUES(?,?,?,?)").run(launch.token, launch.runId, launch.state, JSON.stringify(launch));
    return launch;
  }).immediate();
}
export function readLaunch(db: Database.Database, token: string): BuildLaunch | undefined {
  const row = db.prepare("SELECT record_json FROM build_launches WHERE token=?").get(token) as {record_json:string}|undefined;
  return row ? JSON.parse(row.record_json) : undefined;
}
export function setLaunchState(db: Database.Database, authority: BuildAdmission, token: string, state: "dispatching" | "failed"): void {
  db.transaction(() => {
    assertAdmission(db, authority);
    const launch = readLaunch(db, token);
    if (state === "failed" && launch?.state === "failed" && launch.launcher === authority.token) return;
    if (!launch || launch.launcher !== authority.token || !(state === "dispatching" ? launch.state === "reserved" : ["reserved", "dispatching"].includes(launch.state))) throw new Error("Invalid launch transition");
    db.prepare("UPDATE build_launches SET state=?,record_json=? WHERE token=?").run(state, JSON.stringify({ ...launch, state }), token);
  }).immediate();
}
export function claimLaunch(db: Database.Database, project: string, runId: string, token: string, role: BuildAdmission["phase"], digest: string): BuildAdmission {
  return db.transaction(() => {
    const launch = readLaunch(db, token);
    const owner = readAdmission(db);
    if (!launch || launch.state !== "dispatching" || launch.project !== canonicalProject(project) || launch.runId !== runId || launch.role !== role || launch.digest !== digest || owner?.token !== launch.launcher || owner.host !== hostname()) throw new BuildOwnershipError("invalid-launch", "Invalid, stale, or already claimed build launch authorization");
    if (launch.protocol === "registered-v2" && (!launch.acknowledged || launch.child?.pid !== process.pid || launch.child.processStart !== processStartIdentity() || launch.child.host !== hostname())) throw new BuildOwnershipError("invalid-launch", "Build child registration was not acknowledged");
    const authority: BuildAdmission = { ...owner, token: randomUUID(), phase: role, pid: process.pid, host: hostname(), processStart: processStartIdentity(), heartbeatAt: new Date().toISOString() };
    db.prepare("UPDATE build_admission SET record_json=? WHERE singleton=1").run(JSON.stringify(authority));
    db.prepare("UPDATE build_launches SET state='claimed',record_json=? WHERE token=?").run(JSON.stringify({ ...launch, state: "claimed", claimant: authority }), token);
    return authority;
  }).immediate();
}


/** Child registration grants no mutation/provider authority. Competes atomically with retirement. */
export function registerLaunchChild(db: Database.Database, token: string, project: string): void {
  db.transaction(() => {
    const launch = readLaunch(db, token);
    if (!launch || launch.state !== "dispatching" || launch.protocol !== "registered-v2" || launch.project !== canonicalProject(project) || launch.child) throw new BuildOwnershipError("invalid-launch", "Launch is retired, already registered, or invalid");
    const child = { pid: process.pid, processStart: processStartIdentity(), host: hostname() };
    if (child.processStart === "unavailable") throw new BuildOwnershipError("unknown-owner", "Cannot register child process identity");
    db.prepare("UPDATE build_launches SET record_json=? WHERE token=?").run(JSON.stringify({ ...launch, child }), token);
  }).immediate();
}
export function acknowledgeLaunchChild(db: Database.Database, authority: BuildAdmission, token: string, pid: number): void {
  db.transaction(() => {
    assertAdmission(db, authority);
    const launch = readLaunch(db, token);
    if (!launch || launch.state !== "dispatching" || launch.launcher !== authority.token || launch.child?.pid !== pid || classifyProcess(pid, launch.child.processStart, launch.child.host).state !== "live") throw new BuildOwnershipError("invalid-launch", "Registered child cannot be acknowledged");
    db.prepare("UPDATE build_launches SET record_json=? WHERE token=?").run(JSON.stringify({ ...launch, acknowledged: true }), token);
  }).immediate();
}
/** Restricted retirement only; does not grant execution authority or replay work. */
export function reconcileLaunch(db: Database.Database, token: string, original?: BuildAdmission): "retired" | "claimed" | "unknown" {
  return db.transaction(() => {
    const launch = readLaunch(db, token);
    if (!launch || launch.state === "failed") return "retired";
    if (launch.state === "claimed") return "claimed";
    const owner = readAdmission(db);
    if (!owner || owner.token !== launch.launcher) return "unknown";
    const callerOwns = original?.token === owner.token;
    if (!callerOwns && classifyProcess(owner.pid, owner.processStart, owner.host).state !== "dead") return "unknown";
    // New gated children cannot enter the CLI until durable acknowledgement.
    // Fence the token even if a delayed bootstrap is still registering.
    const safe = launch.state === "reserved" || (launch.protocol === "registered-v2" && (!launch.acknowledged || (launch.child && classifyProcess(launch.child.pid, launch.child.processStart, launch.child.host).state === "dead")));
    if (!safe) return "unknown";
    db.prepare("UPDATE build_launches SET state='failed',record_json=? WHERE token=?").run(JSON.stringify({ ...launch, state: "failed" }), token);
    return "retired";
  }).immediate();
}

/** Old open connections lack this function, even if they passed a prior schema check. */
function migrateReadinessProtocol(db: Database.Database): void {
  const version = (db.prepare("SELECT version FROM build_ownership_schema").get() as {version:number}).version;
  if (version === 3) return;
  const owner = readAdmission(db);
  // Leave legacy inspection/restricted cleanup available. New execution requires v3.
  if (owner && classifyProcess(owner.pid, owner.processStart, owner.host).state !== "dead") return;
  const lease = db.prepare("SELECT pid,process_start,host FROM project_lease").get() as {pid:number;process_start:string;host:string}|undefined;
  if (lease && classifyProcess(lease.pid, lease.process_start, lease.host).state !== "dead") return;
  for (const row of db.prepare("SELECT state_json FROM supervisor_leases WHERE status IN ('running','stopping')").all() as Array<{state_json:string}>) {
    const state = JSON.parse(row.state_json);
    if (!state.pid || classifyProcess(state.pid, state.processStart).state !== "dead") return;
  }
  for (const row of db.prepare("SELECT record_json FROM build_launches WHERE state IN ('reserved','dispatching')").all() as Array<{record_json:string}>) {
    const launch = JSON.parse(row.record_json) as BuildLaunch;
    if (reconcileLaunch(db, launch.token) === "unknown") return;
  }
  // Local executable ownership must be reconciled before semantic migration.
  if (db.prepare("SELECT 1 FROM build_owned_processes WHERE state<>'quiescent' LIMIT 1").get()) return;
  // Remote uncertainty survives migration unchanged. Recovery needs the new
  // writer fences to reconcile it; ordinary admission still rejects dispatch uncertainty.
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>);
  for (const {name} of tables) {
    if (!/^[a-z_]+$/.test(name)) throw new Error("Unexpected ownership table");
    for (const action of ["INSERT", "UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER IF NOT EXISTS protocol_v3_${name}_${action} BEFORE ${action} ON ${name} BEGIN SELECT CASE WHEN rafi_protocol_v3()<>1 THEN RAISE(ABORT,'Incompatible writer protocol') END; END`);
  }
  db.prepare("UPDATE build_ownership_schema SET version=3").run();
}
