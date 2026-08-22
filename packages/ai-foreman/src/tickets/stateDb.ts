import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TicketStatus = "planned" | "next" | "in_progress" | "blocked" | "done" | "canceled" | "obsolete";
export type ValidationResult = "passed" | "failed" | "not_run" | "not_applicable";

export interface TicketState {
  ticket_id: string;
  status: TicketStatus;
  owner: string | null;
  current_step: string | null;
  next_action: string | null;
  blocked_by_json: string;
  blocker_type: string | null;
  blocker_notes: string | null;
  first_blocked_at: string | null;
  last_checked_at: string | null;
  last_worked_at: string | null;
  completed_at: string | null;
  attempt_count: number;
  last_error: string | null;
  evidence: string | null;
  validation_result: ValidationResult | null;
  validation_commands: string | null;
  validation_notes: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface TicketEvent {
  id?: number;
  timestamp: string;
  actor: string | null;
  ticket_id: string | null;
  event_type: string;
  old_status: string | null;
  new_status: string | null;
  summary: string;
  validation: string | null;
  evidence: string | null;
  payload_json: string;
}

export interface ValidationSnapshot {
  id?: number;
  timestamp: string;
  scope: string;
  result: ValidationResult;
  commands: string | null;
  evidence: string | null;
  notes: string | null;
}

export interface FutureWorkItem {
  id?: number;
  discovered_at: string;
  source_ticket: string | null;
  proposed_ticket: string | null;
  priority_guess: string | null;
  area: string | null;
  summary: string;
  rationale: string | null;
  needs_decision_from: string | null;
  disposition: "triage" | "accepted" | "rejected" | "merged" | "queued";
}

export interface RecentCompletedContext {
  ticket_id: string;
  why_it_remains_here: string;
  pinned_until: string | null;
  updated_at: string;
}

export interface ArchiveIndexEntry {
  archive_file: string;
  scope: string;
  last_updated: string | null;
  notes: string | null;
}

export type ReviewRecommendationStatus = "pending" | "accepted" | "deferred" | "dismissed";

export interface ReviewRecommendation {
  id?: number;
  created_at: string;
  kind: string;
  status: ReviewRecommendationStatus;
  summary: string;
  rationale: string | null;
  ticket_ids_json: string;
  patch_json: string;
  source_json: string;
  updated_at: string | null;
}

export interface OperationReceipt {
  operation_id: string;
  operation_type: string;
  ticket_id: string | null;
  run_id: string;
  completed_at: string;
  payload_json: string;
}

const INIT_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ticket_state (
  ticket_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'planned',
  owner TEXT,
  current_step TEXT,
  next_action TEXT,
  blocked_by_json TEXT NOT NULL DEFAULT '[]',
  blocker_type TEXT,
  blocker_notes TEXT,
  first_blocked_at TEXT,
  last_checked_at TEXT,
  last_worked_at TEXT,
  completed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  evidence TEXT,
  validation_result TEXT,
  validation_commands TEXT,
  validation_notes TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  CHECK (status IN ('planned','next','in_progress','blocked','done','canceled','obsolete')),
  CHECK (validation_result IS NULL OR validation_result IN ('passed','failed','not_run','not_applicable'))
);

CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  actor TEXT,
  ticket_id TEXT,
  event_type TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  summary TEXT NOT NULL,
  validation TEXT,
  evidence TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS validation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  scope TEXT NOT NULL,
  result TEXT NOT NULL,
  commands TEXT,
  evidence TEXT,
  notes TEXT,
  CHECK (result IN ('passed','failed','not_run','not_applicable'))
);

CREATE TABLE IF NOT EXISTS future_work (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discovered_at TEXT NOT NULL,
  source_ticket TEXT,
  proposed_ticket TEXT,
  priority_guess TEXT,
  area TEXT,
  summary TEXT NOT NULL,
  rationale TEXT,
  needs_decision_from TEXT,
  disposition TEXT NOT NULL DEFAULT 'triage',
  CHECK (disposition IN ('triage','accepted','rejected','merged','queued'))
);

CREATE TABLE IF NOT EXISTS recent_completed_context (
  ticket_id TEXT PRIMARY KEY,
  why_it_remains_here TEXT NOT NULL,
  pinned_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_index (
  archive_file TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  last_updated TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS review_recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  summary TEXT NOT NULL,
  rationale TEXT,
  ticket_ids_json TEXT NOT NULL DEFAULT '[]',
  patch_json TEXT NOT NULL DEFAULT '{}',
  source_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT,
  CHECK (status IN ('pending','accepted','deferred','dismissed'))
);

CREATE TABLE IF NOT EXISTS operation_receipts (
  operation_id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  ticket_id TEXT,
  run_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ticket_state_status ON ticket_state(status);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_id ON ticket_events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_events_timestamp ON ticket_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_validation_snapshots_timestamp ON validation_snapshots(timestamp);
CREATE INDEX IF NOT EXISTS idx_future_work_disposition ON future_work(disposition);
CREATE INDEX IF NOT EXISTS idx_review_recommendations_status ON review_recommendations(status);
CREATE INDEX IF NOT EXISTS idx_operation_receipts_run ON operation_receipts(run_id);
`;

export class StateDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(INIT_SQL);
    this.migrateObsoleteStatus();
  }

  private migrateObsoleteStatus(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ticket_state'").get() as { sql: string } | undefined;
    if (!row || row.sql.includes("'obsolete'")) return;
    this.db.pragma("foreign_keys = OFF");
    this.db.exec(`
      DROP INDEX IF EXISTS idx_ticket_state_status;
      ALTER TABLE ticket_state RENAME TO ticket_state_legacy;
      CREATE TABLE ticket_state (
        ticket_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'planned',owner TEXT,current_step TEXT,next_action TEXT,
        blocked_by_json TEXT NOT NULL DEFAULT '[]',blocker_type TEXT,blocker_notes TEXT,first_blocked_at TEXT,last_checked_at TEXT,
        last_worked_at TEXT,completed_at TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,last_error TEXT,evidence TEXT,
        validation_result TEXT,validation_commands TEXT,validation_notes TEXT,updated_at TEXT NOT NULL,updated_by TEXT,
        CHECK (status IN ('planned','next','in_progress','blocked','done','canceled','obsolete')),
        CHECK (validation_result IS NULL OR validation_result IN ('passed','failed','not_run','not_applicable'))
      );
      INSERT INTO ticket_state SELECT * FROM ticket_state_legacy;
      DROP TABLE ticket_state_legacy;
      CREATE INDEX idx_ticket_state_status ON ticket_state(status);
    `);
    this.db.pragma("foreign_keys = ON");
  }

  close(): void {
    this.db.close();
  }

  // ── ticket_state ──────────────────────────────────────────────────────────

  getState(ticketId: string): TicketState | undefined {
    return this.db
      .prepare("SELECT * FROM ticket_state WHERE ticket_id = ?")
      .get(ticketId) as TicketState | undefined;
  }

  getAllStates(): Map<string, TicketState> {
    const rows = this.db.prepare("SELECT * FROM ticket_state").all() as TicketState[];
    const m = new Map<string, TicketState>();
    for (const row of rows) m.set(row.ticket_id, row);
    return m;
  }

  upsertState(
    ticketId: string,
    patch: Partial<Omit<TicketState, "ticket_id">>,
    now: string,
  ): void {
    const existing = this.getState(ticketId);
    const base: TicketState = existing ?? {
      ticket_id: ticketId,
      status: "planned",
      owner: null,
      current_step: null,
      next_action: null,
      blocked_by_json: "[]",
      blocker_type: null,
      blocker_notes: null,
      first_blocked_at: null,
      last_checked_at: null,
      last_worked_at: null,
      completed_at: null,
      attempt_count: 0,
      last_error: null,
      evidence: null,
      validation_result: null,
      validation_commands: null,
      validation_notes: null,
      updated_at: now,
      updated_by: null,
    };
    const merged: TicketState = { ...base, ...patch, ticket_id: ticketId, updated_at: now };

    if (existing) {
      this.db.prepare(`
        UPDATE ticket_state SET
          status=@status, owner=@owner, current_step=@current_step,
          next_action=@next_action, blocked_by_json=@blocked_by_json,
          blocker_type=@blocker_type, blocker_notes=@blocker_notes,
          first_blocked_at=@first_blocked_at, last_checked_at=@last_checked_at,
          last_worked_at=@last_worked_at, completed_at=@completed_at,
          attempt_count=@attempt_count, last_error=@last_error,
          evidence=@evidence, validation_result=@validation_result,
          validation_commands=@validation_commands, validation_notes=@validation_notes,
          updated_at=@updated_at, updated_by=@updated_by
        WHERE ticket_id=@ticket_id
      `).run(merged);
    } else {
      this.db.prepare(`
        INSERT INTO ticket_state (
          ticket_id,status,owner,current_step,next_action,blocked_by_json,
          blocker_type,blocker_notes,first_blocked_at,last_checked_at,
          last_worked_at,completed_at,attempt_count,last_error,evidence,
          validation_result,validation_commands,validation_notes,updated_at,updated_by
        ) VALUES (
          @ticket_id,@status,@owner,@current_step,@next_action,@blocked_by_json,
          @blocker_type,@blocker_notes,@first_blocked_at,@last_checked_at,
          @last_worked_at,@completed_at,@attempt_count,@last_error,@evidence,
          @validation_result,@validation_commands,@validation_notes,@updated_at,@updated_by
        )
      `).run(merged);
    }
  }

  // ── ticket_events ─────────────────────────────────────────────────────────

  insertEvent(event: Omit<TicketEvent, "id">): void {
    this.db.prepare(`
      INSERT INTO ticket_events (
        timestamp,actor,ticket_id,event_type,old_status,new_status,
        summary,validation,evidence,payload_json
      ) VALUES (
        @timestamp,@actor,@ticket_id,@event_type,@old_status,@new_status,
        @summary,@validation,@evidence,@payload_json
      )
    `).run(event);
  }

  getRecentEvents(limit: number): TicketEvent[] {
    return this.db
      .prepare("SELECT * FROM ticket_events ORDER BY timestamp DESC, id DESC LIMIT ?")
      .all(limit) as TicketEvent[];
  }

  // ── validation_snapshots ──────────────────────────────────────────────────

  insertValidationSnapshot(snap: Omit<ValidationSnapshot, "id">): void {
    this.db.prepare(`
      INSERT INTO validation_snapshots (timestamp,scope,result,commands,evidence,notes)
      VALUES (@timestamp,@scope,@result,@commands,@evidence,@notes)
    `).run(snap);
  }

  getRecentValidationSnapshot(): ValidationSnapshot | undefined {
    return this.db
      .prepare("SELECT * FROM validation_snapshots ORDER BY timestamp DESC, id DESC LIMIT 1")
      .get() as ValidationSnapshot | undefined;
  }

  // ── future_work ───────────────────────────────────────────────────────────

  insertFutureWork(item: Omit<FutureWorkItem, "id">): number {
    const r = this.db.prepare(`
      INSERT INTO future_work (
        discovered_at,source_ticket,proposed_ticket,priority_guess,
        area,summary,rationale,needs_decision_from,disposition
      ) VALUES (
        @discovered_at,@source_ticket,@proposed_ticket,@priority_guess,
        @area,@summary,@rationale,@needs_decision_from,@disposition
      )
    `).run(item);
    return r.lastInsertRowid as number;
  }

  getFutureWork(): FutureWorkItem[] {
    return this.db
      .prepare("SELECT * FROM future_work ORDER BY id")
      .all() as FutureWorkItem[];
  }

  getFutureWorkById(id: number): FutureWorkItem | undefined {
    return this.db
      .prepare("SELECT * FROM future_work WHERE id = ?")
      .get(id) as FutureWorkItem | undefined;
  }

  updateFutureWorkDisposition(id: number, disposition: string): void {
    this.db.prepare("UPDATE future_work SET disposition = ? WHERE id = ?").run(disposition, id);
  }

  // ── recent_completed_context ──────────────────────────────────────────────

  getRecentCompleted(): RecentCompletedContext[] {
    return this.db
      .prepare("SELECT * FROM recent_completed_context ORDER BY updated_at DESC")
      .all() as RecentCompletedContext[];
  }

  upsertRecentCompleted(row: RecentCompletedContext): void {
    this.db.prepare(`
      INSERT INTO recent_completed_context (ticket_id,why_it_remains_here,pinned_until,updated_at)
      VALUES (@ticket_id,@why_it_remains_here,@pinned_until,@updated_at)
      ON CONFLICT(ticket_id) DO UPDATE SET
        why_it_remains_here=excluded.why_it_remains_here,
        pinned_until=excluded.pinned_until,
        updated_at=excluded.updated_at
    `).run(row);
  }

  // ── archive_index ─────────────────────────────────────────────────────────

  getArchiveIndex(): ArchiveIndexEntry[] {
    return this.db
      .prepare("SELECT * FROM archive_index ORDER BY last_updated DESC")
      .all() as ArchiveIndexEntry[];
  }

  // ── review_recommendations ────────────────────────────────────────────────

  insertReviewRecommendation(item: Omit<ReviewRecommendation, "id">): number {
    const r = this.db.prepare(`
      INSERT INTO review_recommendations (
        created_at,kind,status,summary,rationale,ticket_ids_json,patch_json,source_json,updated_at
      ) VALUES (
        @created_at,@kind,@status,@summary,@rationale,@ticket_ids_json,@patch_json,@source_json,@updated_at
      )
    `).run(item);
    return r.lastInsertRowid as number;
  }

  getReviewRecommendations(status?: ReviewRecommendationStatus): ReviewRecommendation[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM review_recommendations WHERE status = ? ORDER BY id")
        .all(status) as ReviewRecommendation[];
    }
    return this.db
      .prepare("SELECT * FROM review_recommendations ORDER BY id")
      .all() as ReviewRecommendation[];
  }

  getReviewRecommendation(id: number): ReviewRecommendation | undefined {
    return this.db
      .prepare("SELECT * FROM review_recommendations WHERE id = ?")
      .get(id) as ReviewRecommendation | undefined;
  }

  updateReviewRecommendationStatus(id: number, status: ReviewRecommendationStatus, updatedAt: string): void {
    this.db
      .prepare("UPDATE review_recommendations SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, id);
  }

  // ── operation_receipts ───────────────────────────────────────────────────

  getOperationReceipt(operationId: string): OperationReceipt | undefined {
    return this.db.prepare("SELECT * FROM operation_receipts WHERE operation_id = ?").get(operationId) as OperationReceipt | undefined;
  }

  recordOperationReceipt(receipt: OperationReceipt): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO operation_receipts (
        operation_id,operation_type,ticket_id,run_id,completed_at,payload_json
      ) VALUES (
        @operation_id,@operation_type,@ticket_id,@run_id,@completed_at,@payload_json
      )
    `).run(receipt);
    return result.changes === 1;
  }

  // ── transactions ──────────────────────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    return (this.db.transaction(fn) as () => T)();
  }
}
