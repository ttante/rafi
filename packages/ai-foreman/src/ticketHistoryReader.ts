import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { isTicketsInitialized, loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import type { TicketEvent, TicketState } from "./tickets/stateDb.js";

/** Read-only ticket history access. Unlike StateDb, construction never creates or migrates a database. */
export class TicketHistoryReader {
  readonly path?: string;
  private readonly db?: Database.Database;
  constructor(projectDir: string) {
    const root = resolve(projectDir);
    if (!isTicketsInitialized(root)) return;
    try {
      const path = resolveTicketPaths(loadTicketsConfig(root), root).stateDb;
      this.path = path;
      if (!existsSync(path)) return;
      this.db = new Database(path, { readonly: true, fileMustExist: true });
      this.db.pragma("query_only = ON");
    } catch { /* unavailable or legacy ticket setup */ }
  }
  available(): boolean { return Boolean(this.db); }
  close(): void { this.db?.close(); }
  states(ticketIds: readonly string[]): TicketState[] {
    if (!this.db || !ticketIds.length) return [];
    try { const ids = [...new Set(ticketIds)].slice(0, 500); return this.db.prepare(`SELECT * FROM ticket_state WHERE ticket_id IN (${ids.map(() => "?").join(",")}) ORDER BY ticket_id`).all(...ids) as TicketState[]; }
    catch { return []; }
  }
  events(ticketIds: readonly string[], limit = 500): TicketEvent[] {
    if (!this.db || !ticketIds.length) return [];
    try { const ids = [...new Set(ticketIds)].slice(0, 500); return this.db.prepare(`SELECT * FROM ticket_events WHERE ticket_id IN (${ids.map(() => "?").join(",")}) ORDER BY timestamp DESC,id DESC LIMIT ?`).all(...ids, Math.max(1, Math.min(2_000, limit))) as TicketEvent[]; }
    catch { return []; }
  }
  operationReceipts(runIds: readonly string[], limit = 500): Array<{ operationId: string; operationType: string; ticketId?: string; runId: string; completedAt: string; payload: unknown }> {
    if (!this.db || !runIds.length) return [];
    try {
      const ids = [...new Set(runIds)].slice(0, 100);
      return (this.db.prepare(`SELECT * FROM operation_receipts WHERE run_id IN (${ids.map(() => "?").join(",")}) ORDER BY completed_at DESC,operation_id LIMIT ?`).all(...ids, Math.max(1, Math.min(2_000, limit))) as Array<Record<string, unknown>>).map(row => ({ operationId: String(row.operation_id), operationType: String(row.operation_type), ...(row.ticket_id ? { ticketId: String(row.ticket_id) } : {}), runId: String(row.run_id), completedAt: String(row.completed_at), payload: JSON.parse(String(row.payload_json)) }));
    } catch { return []; }
  }
}
