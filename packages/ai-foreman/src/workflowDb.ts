import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { OperationLifecycle, ResolvedAgentSettings, WorkflowIssue } from "rafi-spec";

export const WORKFLOW_DB_FILE = ".rafi/recovery.sqlite3";
export type WorkflowKind = "plan" | "ticket-plan" | "ticket-populate" | "uninstall" | "build" | "qa-remediation" | "recovery" | "legacy";
export type WorkflowRunStatus = "running" | "paused" | "blocked" | "completed" | "failed" | "cancelled" | "superseded";

export interface WorkflowRunSnapshot {
  runId: string;
  kind: WorkflowKind;
  status: WorkflowRunStatus;
  checkpoint: string;
  originalWork: unknown;
  remainingWork: unknown;
  state: Record<string, unknown>;
  leaseGeneration?: number;
  legacy: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OperationRecord {
  idempotencyKey: string;
  runId: string;
  kind: string;
  status: OperationLifecycle;
  intent: unknown;
  result?: unknown;
  externalId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectLease {
  owner: string;
  generation: number;
  pid: number;
  host: string;
  processStart: string;
  heartbeatAt: string;
  runId: string;
}
export interface PublicationTransaction { transactionId: string; runId: string; status: "prepared" | "staged" | "tracker_committed" | "published" | "committed" | "rolled_back"; intent: unknown; previousDigests: unknown; createdAt: string; updatedAt: string }

/** Authoritative persistence for every resumable workflow in a project. */
export class WorkflowDb {
  readonly path: string;
  private readonly db: Database.Database;

  constructor(readonly projectDir: string, path = join(resolve(projectDir), WORKFLOW_DB_FILE)) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    ensureRecoveryGitignore(resolve(projectDir));
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.importLegacyOnce();
  }

  close(): void { this.db.close(); }

  createRun(input: { runId?: string; kind: WorkflowKind; checkpoint?: string; originalWork?: unknown; remainingWork?: unknown; state?: Record<string, unknown>; legacy?: boolean }, now = new Date()): WorkflowRunSnapshot {
    const at = now.toISOString();
    const run: WorkflowRunSnapshot = {
      runId: input.runId ?? randomUUID(), kind: input.kind, status: "running", checkpoint: input.checkpoint ?? "created",
      originalWork: input.originalWork ?? {}, remainingWork: input.remainingWork ?? input.originalWork ?? {}, state: input.state ?? {},
      legacy: Boolean(input.legacy), createdAt: at, updatedAt: at,
    };
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workflow_runs(run_id,kind,status,checkpoint,original_work_json,remaining_work_json,state_json,legacy,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(run.runId, run.kind, run.status, run.checkpoint, json(run.originalWork), json(run.remainingWork), json(run.state), run.legacy ? 1 : 0, at, at);
      this.insertEvent(run.runId, "run_created", run.checkpoint, { kind: run.kind }, at);
    })();
    return run;
  }

  getRun(runId: string): WorkflowRunSnapshot | undefined {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE run_id=?").get(runId) as DbRun | undefined;
    return row ? rowToRun(row) : undefined;
  }

  activeRuns(): WorkflowRunSnapshot[] {
    return (this.db.prepare("SELECT * FROM workflow_runs WHERE status IN ('running','paused','blocked') ORDER BY created_at").all() as DbRun[]).map(rowToRun);
  }

  transition(runId: string, update: { status?: WorkflowRunStatus; checkpoint: string; remainingWork?: unknown; state?: Record<string, unknown>; event?: string; payload?: unknown }, now = new Date()): WorkflowRunSnapshot {
    const at = now.toISOString();
    return this.db.transaction(() => {
      const current = this.getRun(runId); if (!current) throw new Error(`workflow run not found: ${runId}`);
      const next = { ...current, status: update.status ?? current.status, checkpoint: update.checkpoint, remainingWork: update.remainingWork ?? current.remainingWork, state: update.state ?? current.state, updatedAt: at };
      this.db.prepare("UPDATE workflow_runs SET status=?,checkpoint=?,remaining_work_json=?,state_json=?,updated_at=? WHERE run_id=?")
        .run(next.status, next.checkpoint, json(next.remainingWork), json(next.state), at, runId);
      this.insertEvent(runId, update.event ?? "checkpoint", update.checkpoint, update.payload ?? {}, at);
      return next;
    })();
  }

  events(runId: string): Array<{ sequence: number; type: string; checkpoint: string; payload: unknown; at: string }> {
    const rows = this.db.prepare("SELECT sequence,event_type,checkpoint,payload_json,created_at FROM workflow_events WHERE run_id=? ORDER BY sequence").all(runId) as Array<{ sequence: number; event_type: string; checkpoint: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ sequence: row.sequence, type: row.event_type, checkpoint: row.checkpoint, payload: parseJson(row.payload_json), at: row.created_at }));
  }

  recordSettings(runId: string, role: string, boundary: number, settings: ResolvedAgentSettings, now = new Date()): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO role_settings(run_id,role,boundary,revision,settings_json,created_at) VALUES(?,?,?,?,?,?)")
        .run(runId, role, boundary, settings.settings_revision, json(settings), now.toISOString());
      this.insertEvent(runId, "settings_boundary", `role:${role}:${boundary}`, { revision: settings.settings_revision }, now.toISOString());
    })();
  }

  recordProjectSettingsRevision(revision: number, defaults: unknown, now = new Date()): void {
    this.db.prepare("INSERT OR REPLACE INTO project_settings_revisions(revision,defaults_json,created_at) VALUES(?,?,?)").run(revision, json(defaults), now.toISOString());
  }

  recordTelemetry(runId: string, snapshot: unknown, now = new Date()): void {
    this.db.prepare("INSERT INTO workflow_telemetry(run_id,snapshot_json,created_at) VALUES(?,?,?)").run(runId, json(snapshot), now.toISOString());
  }

  recordSession(runId: string, role: string, stream: string, sessionId: string | undefined, transition: string, settings: ResolvedAgentSettings, now = new Date()): void {
    this.db.prepare(`INSERT INTO provider_sessions(run_id,role,stream,provider,model,session_id,transition,settings_revision,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(runId, role, stream, settings.make, settings.model, sessionId ?? null, transition, settings.settings_revision, now.toISOString());
  }

  recordIssue(runId: string, issue: WorkflowIssue): number {
    const result = this.db.prepare("INSERT INTO workflow_issues(run_id,code,issue_json,created_at) VALUES(?,?,?,?)").run(runId, issue.code, json(issue), issue.occurred_at);
    this.insertEvent(runId, "issue", issue.phase, { issueId: Number(result.lastInsertRowid), code: issue.code }, issue.occurred_at);
    return Number(result.lastInsertRowid);
  }

  issues(runId: string): WorkflowIssue[] {
    return (this.db.prepare("SELECT issue_json FROM workflow_issues WHERE run_id=? ORDER BY issue_id").all(runId) as Array<{ issue_json: string }>).map((row) => parseJson(row.issue_json) as WorkflowIssue);
  }

  planOperation(input: { runId: string; idempotencyKey: string; kind: string; intent: unknown }, now = new Date()): OperationRecord {
    const at = now.toISOString();
    this.db.prepare(`INSERT INTO operation_journal(idempotency_key,run_id,kind,status,intent_json,created_at,updated_at)
      VALUES(?,?,?,'planned',?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`).run(input.idempotencyKey, input.runId, input.kind, json(input.intent), at, at);
    return this.operation(input.idempotencyKey)!;
  }

  updateOperation(idempotencyKey: string, status: OperationLifecycle, details: { result?: unknown; externalId?: string; error?: string } = {}, now = new Date()): OperationRecord {
    if (!this.operation(idempotencyKey)) throw new Error(`operation not found: ${idempotencyKey}`);
    this.db.prepare("UPDATE operation_journal SET status=?,result_json=?,external_id=?,error=?,updated_at=? WHERE idempotency_key=?")
      .run(status, details.result === undefined ? null : json(details.result), details.externalId ?? null, details.error ?? null, now.toISOString(), idempotencyKey);
    return this.operation(idempotencyKey)!;
  }

  operation(idempotencyKey: string): OperationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM operation_journal WHERE idempotency_key=?").get(idempotencyKey) as DbOperation | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  operations(runId: string): OperationRecord[] {
    return (this.db.prepare("SELECT * FROM operation_journal WHERE run_id=? ORDER BY created_at,idempotency_key").all(runId) as DbOperation[]).map(operationFromRow);
  }

  putEvidence(kind: "handoff" | "diff" | "test", value: string | Buffer, now = new Date()): string {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(sanitizeText(value));
    const digest = createHash("sha256").update(bytes).digest("hex");
    this.db.prepare("INSERT OR IGNORE INTO content_refs(digest,kind,content,created_at) VALUES(?,?,?,?)").run(digest, kind, bytes, now.toISOString());
    return digest;
  }

  getEvidence(digest: string): Buffer | undefined {
    const row = this.db.prepare("SELECT content FROM content_refs WHERE digest=?").get(digest) as { content: Buffer } | undefined;
    return row?.content;
  }

  beginPublication(runId: string, intent: unknown, previousDigests: unknown, now = new Date()): PublicationTransaction {
    const transactionId = randomUUID(); const at = now.toISOString();
    this.db.prepare("INSERT INTO publication_transactions(transaction_id,run_id,status,intent_json,previous_digests_json,created_at,updated_at) VALUES(?,?,'prepared',?,?,?,?)")
      .run(transactionId, runId, json(intent), json(previousDigests), at, at);
    this.insertEvent(runId, "publication_prepared", "publication", { transactionId }, at);
    return { transactionId, runId, status: "prepared", intent, previousDigests, createdAt: at, updatedAt: at };
  }

  updatePublication(transactionId: string, status: PublicationTransaction["status"], now = new Date()): PublicationTransaction {
    const current = this.publication(transactionId); if (!current) throw new Error(`publication transaction not found: ${transactionId}`);
    this.db.prepare("UPDATE publication_transactions SET status=?,updated_at=? WHERE transaction_id=?").run(status, now.toISOString(), transactionId);
    this.insertEvent(current.runId, `publication_${status}`, "publication", { transactionId }, now.toISOString());
    return { ...current, status, updatedAt: now.toISOString() };
  }

  publication(transactionId: string): PublicationTransaction | undefined {
    const row = this.db.prepare("SELECT * FROM publication_transactions WHERE transaction_id=?").get(transactionId) as { transaction_id: string; run_id: string; status: PublicationTransaction["status"]; intent_json: string; previous_digests_json: string; created_at: string; updated_at: string } | undefined;
    return row ? { transactionId: row.transaction_id, runId: row.run_id, status: row.status, intent: parseJson(row.intent_json), previousDigests: parseJson(row.previous_digests_json), createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }

  incompletePublications(): PublicationTransaction[] {
    const rows = this.db.prepare("SELECT transaction_id FROM publication_transactions WHERE status NOT IN ('committed','rolled_back') ORDER BY created_at").all() as Array<{ transaction_id: string }>;
    return rows.map((row) => this.publication(row.transaction_id)!);
  }

  acquireLease(runId: string, owner = `${hostname()}:${process.pid}:${randomUUID()}`, now = new Date(), staleMs = 45_000): ProjectLease {
    const at = now.toISOString(); const host = hostname(); const pid = process.pid; const processStart = processStartIdentity();
    return this.db.transaction(() => {
      const current = this.currentLease();
      if (current && leaseVerifiedLive(current, now, staleMs)) throw new Error(`project workflow lease is held by ${current.owner} for run ${current.runId}`);
      const generation = (current?.generation ?? 0) + 1;
      this.db.prepare(`INSERT INTO project_lease(singleton,owner,generation,pid,host,process_start,heartbeat_at,run_id)
        VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,pid=excluded.pid,host=excluded.host,process_start=excluded.process_start,heartbeat_at=excluded.heartbeat_at,run_id=excluded.run_id`)
        .run(owner, generation, pid, host, processStart, at, runId);
      this.db.prepare("UPDATE workflow_runs SET lease_generation=? WHERE run_id=?").run(generation, runId);
      this.insertEvent(runId, current ? "lease_takeover" : "lease_acquired", "lease", { owner, generation, previous: current?.owner }, at);
      return { owner, generation, pid, host, processStart, heartbeatAt: at, runId };
    })();
  }

  heartbeatLease(lease: ProjectLease, now = new Date()): ProjectLease {
    const at = now.toISOString();
    const result = this.db.prepare("UPDATE project_lease SET heartbeat_at=? WHERE singleton=1 AND owner=? AND generation=?").run(at, lease.owner, lease.generation);
    if (result.changes !== 1) throw new Error("workflow lease ownership changed");
    return { ...lease, heartbeatAt: at };
  }

  releaseLease(lease: ProjectLease, now = new Date()): void {
    this.db.transaction(() => {
      const result = this.db.prepare("DELETE FROM project_lease WHERE singleton=1 AND owner=? AND generation=?").run(lease.owner, lease.generation);
      if (result.changes === 1) this.insertEvent(lease.runId, "lease_released", "lease", { generation: lease.generation }, now.toISOString());
    })();
  }

  currentLease(): ProjectLease | undefined {
    const row = this.db.prepare("SELECT * FROM project_lease WHERE singleton=1").get() as DbLease | undefined;
    return row ? { owner: row.owner, generation: row.generation, pid: row.pid, host: row.host, processStart: row.process_start, heartbeatAt: row.heartbeat_at, runId: row.run_id } : undefined;
  }

  importLegacyOnce(now = new Date()): number {
    const sources = [join(this.projectDir, ".foreman", "runs"), join(this.projectDir, ".rafi", "interviews"), join(this.projectDir, ".tickets", "delivery-sessions")];
    let count = 0;
    for (const directory of sources) {
      if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
      for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
        const path = join(directory, name); const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        if (this.db.prepare("SELECT 1 FROM legacy_imports WHERE source_path=? AND digest=?").get(path, digest)) continue;
        let parsed: unknown; try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { parsed = { unreadable: true }; }
        const runId = `legacy_${digest.slice(0, 24)}`;
        if (!this.getRun(runId)) {
          this.createRun({ runId, kind: "legacy", checkpoint: "legacy-imported", originalWork: { source: path }, remainingWork: {}, state: { source: path, record: parsed }, legacy: true }, now);
          this.transition(runId, { status: "superseded", checkpoint: "legacy-imported", remainingWork: {}, event: "legacy_record_preserved" }, now);
        }
        this.db.prepare("INSERT INTO legacy_imports(source_path,digest,run_id,imported_at) VALUES(?,?,?,?)").run(path, digest, runId, now.toISOString()); count += 1;
      }
    }
    return count;
  }

  private insertEvent(runId: string, type: string, checkpoint: string, payload: unknown, at: string): void {
    this.db.prepare("INSERT INTO workflow_events(run_id,event_type,checkpoint,payload_json,created_at) VALUES(?,?,?,?,?)").run(runId, type, checkpoint, json(payload), at);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs(run_id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,checkpoint TEXT NOT NULL,original_work_json TEXT NOT NULL,remaining_work_json TEXT NOT NULL,state_json TEXT NOT NULL,lease_generation INTEGER,legacy INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),event_type TEXT NOT NULL,checkpoint TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS role_settings(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,boundary INTEGER NOT NULL,revision INTEGER NOT NULL,settings_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(run_id,role,boundary));
      CREATE TABLE IF NOT EXISTS project_settings_revisions(revision INTEGER PRIMARY KEY,defaults_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_telemetry(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,stream TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,session_id TEXT,transition TEXT NOT NULL,settings_revision INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_issues(issue_id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),code TEXT NOT NULL,issue_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_journal(idempotency_key TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),kind TEXT NOT NULL,status TEXT NOT NULL,intent_json TEXT NOT NULL,result_json TEXT,external_id TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_refs(digest TEXT PRIMARY KEY,kind TEXT NOT NULL,content BLOB NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,generation INTEGER NOT NULL,pid INTEGER NOT NULL,host TEXT NOT NULL,process_start TEXT NOT NULL,heartbeat_at TEXT NOT NULL,run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_imports(source_path TEXT NOT NULL,digest TEXT NOT NULL,run_id TEXT NOT NULL,imported_at TEXT NOT NULL,PRIMARY KEY(source_path,digest));
      CREATE TABLE IF NOT EXISTS publication_transactions(transaction_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,status TEXT NOT NULL,intent_json TEXT NOT NULL,previous_digests_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_events_run ON workflow_events(run_id,sequence);
      CREATE INDEX IF NOT EXISTS operations_run ON operation_journal(run_id,status);
    `);
  }
}

type DbRun = { run_id: string; kind: WorkflowKind; status: WorkflowRunStatus; checkpoint: string; original_work_json: string; remaining_work_json: string; state_json: string; lease_generation: number | null; legacy: number; created_at: string; updated_at: string };
type DbOperation = { idempotency_key: string; run_id: string; kind: string; status: OperationLifecycle; intent_json: string; result_json: string | null; external_id: string | null; error: string | null; created_at: string; updated_at: string };
type DbLease = { owner: string; generation: number; pid: number; host: string; process_start: string; heartbeat_at: string; run_id: string };

function rowToRun(row: DbRun): WorkflowRunSnapshot { return { runId: row.run_id, kind: row.kind, status: row.status, checkpoint: row.checkpoint, originalWork: parseJson(row.original_work_json), remainingWork: parseJson(row.remaining_work_json), state: parseJson(row.state_json) as Record<string, unknown>, ...(row.lease_generation === null ? {} : { leaseGeneration: row.lease_generation }), legacy: Boolean(row.legacy), createdAt: row.created_at, updatedAt: row.updated_at }; }
function operationFromRow(row: DbOperation): OperationRecord { return { idempotencyKey: row.idempotency_key, runId: row.run_id, kind: row.kind, status: row.status, intent: parseJson(row.intent_json), ...(row.result_json ? { result: parseJson(row.result_json) } : {}), ...(row.external_id ? { externalId: row.external_id } : {}), ...(row.error ? { error: row.error } : {}), createdAt: row.created_at, updatedAt: row.updated_at }; }
function json(value: unknown): string { return JSON.stringify(value ?? null); }
function parseJson(value: string): unknown { return JSON.parse(value); }
function sanitizeText(value: string): string { return value.replace(/\b(sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|password)\s*[:=]\s*\S+)/gi, "[REDACTED]"); }
function processStartIdentity(pid = process.pid): string { try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21] ?? "unavailable"; } catch { return "unavailable"; } }
function leaseVerifiedLive(lease: ProjectLease, now: Date, staleMs: number): boolean {
  if (now.getTime() - new Date(lease.heartbeatAt).getTime() > staleMs) return false;
  if (lease.host !== hostname()) return true;
  try { process.kill(lease.pid, 0); return processStartIdentity(lease.pid) === lease.processStart; } catch { return false; }
}
function ensureRecoveryGitignore(projectDir: string): void {
  const localExclude = join(projectDir, ".git", "info", "exclude");
  const path = existsSync(localExclude) ? localExclude : join(projectDir, ".gitignore");
  const entries = [WORKFLOW_DB_FILE, `${WORKFLOW_DB_FILE}-wal`, `${WORKFLOW_DB_FILE}-shm`];
  const existing = existsSync(path) ? readFileSync(path, "utf8") : ""; const missing = entries.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (missing.length) appendFileSync(path, `${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, "utf8");
}
