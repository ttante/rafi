import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { SavedTicketDefinitionSnapshot, TicketGroup, TicketGroupId, TicketGroupOrigin } from "rafi-spec";

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

export interface TicketGroupValidationIssue {
  code: "missing-membership" | "multiple-membership" | "unknown-member" | "empty-group" | "sequence-corruption" | "reused-id" | "snapshot-corruption" | "receipt-without-group";
  message: string;
  groupId?: TicketGroupId;
  ticketId?: string;
}

/** The only valid initial/fully-reset active state for a ticket. */
export function pristineTicketState(ticketId: string, now: string, actor: string | null = null): TicketState {
  return {
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
    updated_by: actor,
  };
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

CREATE TABLE IF NOT EXISTS ticket_groups (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0,
  operation_id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS ticket_group_members (
  group_sequence INTEGER NOT NULL REFERENCES ticket_groups(sequence) ON DELETE RESTRICT,
  ticket_id TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  snapshot_validated_at TEXT NOT NULL,
  PRIMARY KEY(group_sequence, ticket_id),
  UNIQUE(group_sequence, position),
  CHECK(position >= 1)
);

CREATE TABLE IF NOT EXISTS ticket_group_receipts (
  operation_id TEXT PRIMARY KEY,
  group_sequence INTEGER NOT NULL UNIQUE REFERENCES ticket_groups(sequence) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_group_sequence_ledger (
  sequence INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  allocated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ticket_state_status ON ticket_state(status);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_id ON ticket_events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_events_timestamp ON ticket_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_validation_snapshots_timestamp ON validation_snapshots(timestamp);
CREATE INDEX IF NOT EXISTS idx_future_work_disposition ON future_work(disposition);
CREATE INDEX IF NOT EXISTS idx_review_recommendations_status ON review_recommendations(status);
CREATE INDEX IF NOT EXISTS idx_operation_receipts_run ON operation_receipts(run_id);
CREATE INDEX IF NOT EXISTS idx_ticket_group_members_group ON ticket_group_members(group_sequence, position);
`;

export class StateDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(INIT_SQL);
    this.db.prepare(`INSERT OR IGNORE INTO ticket_group_sequence_ledger(sequence,operation_id,allocated_at)
      SELECT sequence,operation_id,created_at FROM ticket_groups`).run();
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

  deleteState(ticketId: string): void {
    this.db.prepare("DELETE FROM ticket_state WHERE ticket_id = ?").run(ticketId);
  }

  upsertState(
    ticketId: string,
    patch: Partial<Omit<TicketState, "ticket_id">>,
    now: string,
  ): void {
    const existing = this.getState(ticketId);
    const base: TicketState = existing ?? pristineTicketState(ticketId, now);
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

  insertEvent(event: Omit<TicketEvent, "id">): number {
    const result = this.db.prepare(`
      INSERT INTO ticket_events (
        timestamp,actor,ticket_id,event_type,old_status,new_status,
        summary,validation,evidence,payload_json
      ) VALUES (
        @timestamp,@actor,@ticket_id,@event_type,@old_status,@new_status,
        @summary,@validation,@evidence,@payload_json
      )
    `).run(event);
    return Number(result.lastInsertRowid);
  }

  deleteEvents(ids: number[]): void {
    const remove = this.db.prepare("DELETE FROM ticket_events WHERE id = ?");
    for (const id of ids) remove.run(id);
  }

  getRecentEvents(limit: number): TicketEvent[] {
    return this.db
      .prepare("SELECT * FROM ticket_events ORDER BY timestamp DESC, id DESC LIMIT ?")
      .all(limit) as TicketEvent[];
  }

  getTicketEvents(ticketId: string): TicketEvent[] {
    return this.db
      .prepare("SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY timestamp, id")
      .all(ticketId) as TicketEvent[];
  }

  getAllTicketEvents(): TicketEvent[] {
    return this.db
      .prepare("SELECT * FROM ticket_events WHERE ticket_id IS NOT NULL ORDER BY timestamp, id")
      .all() as TicketEvent[];
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

  getValidationSnapshots(scope?: string): ValidationSnapshot[] {
    if (scope !== undefined) {
      return this.db
        .prepare("SELECT * FROM validation_snapshots WHERE scope = ? ORDER BY timestamp, id")
        .all(scope) as ValidationSnapshot[];
    }
    return this.db
      .prepare("SELECT * FROM validation_snapshots ORDER BY timestamp, id")
      .all() as ValidationSnapshot[];
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

  deleteRecentCompleted(ticketId: string): void {
    this.db.prepare("DELETE FROM recent_completed_context WHERE ticket_id = ?").run(ticketId);
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

  // ── immutable ticket creation groups ─────────────────────────────────────

  createTicketGroup(input: {
    origin: TicketGroupOrigin;
    operationId: string;
    members: Array<{ ticketId: string; definition: unknown; validatedAt?: string }>;
    legacy?: boolean;
    createdAt?: string;
  }): TicketGroup {
    const existing = this.getTicketGroupByOperation(input.operationId);
    if (existing) {
      const requestedIds = input.members.map((member) => member.ticketId);
      const existingIds = existing.members.map((member) => member.ticketId);
      if (existing.origin !== input.origin || JSON.stringify(existingIds) !== JSON.stringify(requestedIds)) throw new Error(`ticket group operation ${input.operationId} was retried with different immutable membership`);
      return existing;
    }
    if (!input.operationId.trim()) throw new Error("ticket group operation ID must not be empty");
    if (input.members.length === 0) throw new Error("ticket creation updates/no-ops must not create an empty group");
    const ids = input.members.map((member) => member.ticketId);
    if (new Set(ids).size !== ids.length) throw new Error("ticket group members must be unique");
    const createdAt = input.createdAt ?? new Date().toISOString();
    return this.transaction(() => {
      const result = this.db.prepare("INSERT INTO ticket_groups(origin,created_at,legacy,operation_id) VALUES(?,?,?,?)")
        .run(input.origin, createdAt, input.legacy ? 1 : 0, input.operationId);
      const sequence = Number(result.lastInsertRowid);
      this.db.prepare("INSERT INTO ticket_group_sequence_ledger(sequence,operation_id,allocated_at) VALUES(?,?,?)").run(sequence, input.operationId, createdAt);
      const insert = this.db.prepare(`INSERT INTO ticket_group_members(group_sequence,ticket_id,position,snapshot_json,snapshot_digest,snapshot_validated_at)
        VALUES(?,?,?,?,?,?)`);
      input.members.forEach((member, index) => {
        const snapshot = makeDefinitionSnapshot(member.ticketId, member.definition, member.validatedAt ?? createdAt);
        insert.run(sequence, member.ticketId, index + 1, JSON.stringify(snapshot.definition), snapshot.digest, snapshot.validatedAt);
        // The creation receipt, immutable membership, recoverable definition,
        // and initial active state are one SQLite publication. Existing state
        // is preserved on replay or when importing an externally completed
        // ticket.
        if (!this.getState(member.ticketId)) {
          this.upsertState(member.ticketId, pristineTicketState(member.ticketId, createdAt, "rafi ticket publication"), createdAt);
        }
      });
      this.db.prepare("INSERT INTO ticket_group_receipts(operation_id,group_sequence,created_at) VALUES(?,?,?)").run(input.operationId, sequence, createdAt);
      return this.getTicketGroupBySequence(sequence)!;
    });
  }

  /** Update only the recoverable definition; membership and order never change. */
  updateTicketDefinitionSnapshot(ticketId: string, definition: unknown, validatedAt = new Date().toISOString()): SavedTicketDefinitionSnapshot {
    const snapshot = makeDefinitionSnapshot(ticketId, definition, validatedAt);
    const result = this.db.prepare(`UPDATE ticket_group_members SET snapshot_json=?,snapshot_digest=?,snapshot_validated_at=? WHERE ticket_id=?`)
      .run(JSON.stringify(snapshot.definition), snapshot.digest, snapshot.validatedAt, ticketId);
    if (result.changes !== 1) throw new Error(`ticket ${ticketId} has no creation-group membership`);
    return snapshot;
  }

  getTicketGroupByOperation(operationId: string): TicketGroup | undefined {
    const row = this.db.prepare("SELECT sequence FROM ticket_groups WHERE operation_id=?").get(operationId) as { sequence: number } | undefined;
    return row ? this.getTicketGroupBySequence(row.sequence) : undefined;
  }

  getTicketGroup(groupId: string): TicketGroup | undefined {
    const match = /^TG-([1-9]\d*)$/.exec(groupId);
    return match ? this.getTicketGroupBySequence(Number(match[1])) : undefined;
  }

  getTicketGroupForTicket(ticketId: string): TicketGroup | undefined {
    const row = this.db.prepare("SELECT group_sequence AS sequence FROM ticket_group_members WHERE ticket_id=?").get(ticketId) as { sequence: number } | undefined;
    return row ? this.getTicketGroupBySequence(row.sequence) : undefined;
  }

  listTicketGroups(): TicketGroup[] {
    const rows = this.db.prepare("SELECT sequence FROM ticket_groups ORDER BY sequence DESC").all() as Array<{ sequence: number }>;
    return rows.map((row) => this.getTicketGroupBySequence(row.sequence)!);
  }

  /** One-time migration for repositories whose complete ticket set predates groups. */
  ensureSyntheticLegacyGroup(definitions: Array<{ id: string } & Record<string, unknown>>, now = new Date()): TicketGroup | undefined {
    if (definitions.length === 0 || this.listTicketGroups().length > 0) return undefined;
    return this.createTicketGroup({
      origin: "legacy",
      operationId: "ticket-groups:synthetic-legacy:v1",
      legacy: true,
      createdAt: now.toISOString(),
      members: definitions.map((definition) => ({ ticketId: definition.id, definition, validatedAt: now.toISOString() })),
    });
  }

  ungroupedTicketIds(ticketIds: readonly string[]): string[] {
    const grouped = new Set((this.db.prepare("SELECT ticket_id FROM ticket_group_members").all() as Array<{ ticket_id: string }>).map((row) => row.ticket_id));
    return ticketIds.filter((ticketId) => !grouped.has(ticketId));
  }

  repairTicketGroups(definitions: Array<{ id: string } & Record<string, unknown>>, operationId: string, now = new Date()): TicketGroup | undefined {
    const ungrouped = new Set(this.ungroupedTicketIds(definitions.map((definition) => definition.id)));
    if (ungrouped.size === 0) return undefined;
    return this.createTicketGroup({
      origin: "repair", operationId, createdAt: now.toISOString(),
      members: definitions.filter((definition) => ungrouped.has(definition.id)).map((definition) => ({ ticketId: definition.id, definition })),
    });
  }

  validateTicketGroups(knownTicketIds: readonly string[] = []): TicketGroupValidationIssue[] {
    const issues: TicketGroupValidationIssue[] = [];
    const groups = this.listTicketGroups();
    const known = new Set(knownTicketIds);
    for (const group of groups) {
      if (group.members.length === 0) issues.push({ code: "empty-group", groupId: group.id, message: `${group.id} has no members` });
      for (const member of group.members) {
        if (known.size > 0 && !known.has(member.ticketId)) issues.push({ code: "unknown-member", groupId: group.id, ticketId: member.ticketId, message: `${group.id} references unknown ticket ${member.ticketId}` });
        if (definitionDigest(member.snapshot.definition) !== member.snapshot.digest) issues.push({ code: "snapshot-corruption", groupId: group.id, ticketId: member.ticketId, message: `${group.id} snapshot for ${member.ticketId} does not match its digest` });
      }
    }
    for (const ticketId of known) if (!this.getTicketGroupForTicket(ticketId)) issues.push({ code: "missing-membership", ticketId, message: `ticket ${ticketId} has no creation-group membership` });
    const duplicates = this.db.prepare("SELECT ticket_id,COUNT(*) AS count FROM ticket_group_members GROUP BY ticket_id HAVING COUNT(*)<>1").all() as Array<{ ticket_id: string; count: number }>;
    for (const row of duplicates) issues.push({ code: "multiple-membership", ticketId: row.ticket_id, message: `ticket ${row.ticket_id} belongs to ${row.count} creation groups` });
    const maximum = groups.reduce((value, group) => Math.max(value, group.sequence), 0);
    const sequence = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='ticket_groups'").get() as { seq: number } | undefined;
    if (maximum > 0 && (!sequence || sequence.seq < maximum)) issues.push({ code: "sequence-corruption", message: `ticket group sequence is ${sequence?.seq ?? "missing"}, below allocated ${maximum}` });
    const missingLedger = this.db.prepare("SELECT sequence FROM ticket_groups WHERE sequence NOT IN (SELECT sequence FROM ticket_group_sequence_ledger)").all() as Array<{ sequence: number }>;
    for (const row of missingLedger) issues.push({ code: "sequence-corruption", groupId: `TG-${row.sequence}` as TicketGroupId, message: `TG-${row.sequence} has no immutable allocation ledger entry` });
    const reused = this.db.prepare(`SELECT g.sequence FROM ticket_groups g JOIN ticket_group_sequence_ledger l ON l.sequence=g.sequence WHERE g.operation_id<>l.operation_id`).all() as Array<{ sequence: number }>;
    for (const row of reused) issues.push({ code: "reused-id", groupId: `TG-${row.sequence}` as TicketGroupId, message: `TG-${row.sequence} was reused for a different creation operation` });
    const deletedAllocations = this.db.prepare("SELECT sequence FROM ticket_group_sequence_ledger WHERE sequence NOT IN (SELECT sequence FROM ticket_groups)").all() as Array<{ sequence: number }>;
    for (const row of deletedAllocations) issues.push({ code: "sequence-corruption", groupId: `TG-${row.sequence}` as TicketGroupId, message: `allocated TG-${row.sequence} is missing; group IDs must never be deleted or reused` });
    const orphanReceipts = this.db.prepare("SELECT operation_id FROM ticket_group_receipts WHERE group_sequence NOT IN (SELECT sequence FROM ticket_groups)").all() as Array<{ operation_id: string }>;
    for (const row of orphanReceipts) issues.push({ code: "receipt-without-group", message: `creation receipt ${row.operation_id} has no group` });
    return issues;
  }

  private getTicketGroupBySequence(sequence: number): TicketGroup | undefined {
    const row = this.db.prepare("SELECT * FROM ticket_groups WHERE sequence=?").get(sequence) as { sequence: number; origin: TicketGroupOrigin; created_at: string; legacy: number; operation_id: string } | undefined;
    if (!row) return undefined;
    const members = this.db.prepare("SELECT * FROM ticket_group_members WHERE group_sequence=? ORDER BY position").all(sequence) as Array<{ ticket_id: string; position: number; snapshot_json: string; snapshot_digest: string; snapshot_validated_at: string }>;
    return {
      id: `TG-${row.sequence}` as TicketGroupId,
      sequence: row.sequence,
      origin: row.origin,
      createdAt: row.created_at,
      legacy: Boolean(row.legacy),
      operationId: row.operation_id,
      members: members.map((member) => ({
        groupId: `TG-${row.sequence}` as TicketGroupId,
        ticketId: member.ticket_id,
        position: member.position,
        snapshot: { version: 1, ticketId: member.ticket_id, definition: parseSnapshot(member.snapshot_json), digest: member.snapshot_digest, validatedAt: member.snapshot_validated_at },
      })),
    };
  }

  // ── transactions ──────────────────────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    return (this.db.transaction(fn) as () => T)();
  }
}

function makeDefinitionSnapshot(ticketId: string, definition: unknown, validatedAt: string): SavedTicketDefinitionSnapshot {
  const cloned = JSON.parse(JSON.stringify(definition)) as unknown;
  if (cloned && typeof cloned === "object" && !Array.isArray(cloned)) {
    const definitionId = (cloned as Record<string, unknown>).id;
    if (definitionId !== undefined && definitionId !== ticketId) throw new Error(`ticket definition snapshot ID ${String(definitionId)} does not match group member ${ticketId}`);
  }
  return { version: 1, ticketId, definition: cloned, digest: definitionDigest(cloned), validatedAt };
}
function definitionDigest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function parseSnapshot(value: string): unknown { try { return JSON.parse(value); } catch { return { __rafi_corrupt_snapshot: true, raw: value }; } }
