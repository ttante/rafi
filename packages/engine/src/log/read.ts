// Reading by cursor, run or ticket, validated on read (plan choice C9). Bad rows become violations.
import { checkEnvelope, checkEventData } from "rafi-spec/v1";
import type { Db } from "../deps/types.js";
import type { StoredEvent, Violation } from "./types.js";

export interface ReadQuery {
  readonly from?: number;
  readonly run?: string;
  readonly ticket?: string;
  readonly origin?: "local" | "imported" | "any";
}

export interface ReadResult {
  readonly events: StoredEvent[];
  readonly violations: Violation[];
  readonly cursor: number;
}

export function rowToEvent(row: Record<string, unknown>, data: unknown): StoredEvent {
  return {
    seq: Number(row.seq), id: String(row.id), run_id: (row.run_id as string | null) ?? null,
    ticket_id: (row.ticket_id as string | null) ?? null, type: String(row.type), v: Number(row.v),
    class: row.class as "state" | "detail", at: String(row.at), actor: String(row.actor),
    source: (row.source as string | null) ?? null, origin: row.origin as "local" | "imported",
    idem_key: (row.idem_key as string | null) ?? null, data,
  };
}

function query(db: Db, q: ReadQuery): Record<string, unknown>[] {
  const where = ["seq > ?"];
  const params: unknown[] = [q.from ?? 0];
  if (q.run !== undefined) { where.push("run_id = ?"); params.push(q.run); }
  if (q.ticket !== undefined) { where.push("ticket_id = ?"); params.push(q.ticket); }
  const origin = q.origin ?? "local";
  if (origin !== "any") { where.push("origin = ?"); params.push(origin); }
  const sql = `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq`;
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

export function parseRow(row: Record<string, unknown>): { event?: StoredEvent; violation?: Violation } {
  const seq = Number(row.seq);
  const type = String(row.type);
  let data: unknown;
  try {
    data = JSON.parse(String(row.data));
  } catch {
    return { violation: { seq, type, reason: "data isn't valid JSON" } };
  }
  const checked = checkEventData(type, Number(row.v), data);
  if (!checked.ok) return { violation: { seq, type, reason: checked.reason } };
  const { data: _raw, ...envelope } = row;
  const valid = checkEnvelope(envelope, { stored: true });
  if (!valid.ok) return { violation: { seq, type, reason: valid.reason } };
  return { event: rowToEvent(row, checked.data) };
}

/** Reads events after a cursor in seq order. Imported events come back only when asked for (ARCH 3.6). */
export function readEvents(db: Db, q: ReadQuery = {}): ReadResult {
  const events: StoredEvent[] = [];
  const violations: Violation[] = [];
  let cursor = q.from ?? 0;
  for (const row of query(db, q)) {
    const parsed = parseRow(row);
    if (parsed.event) events.push(parsed.event);
    if (parsed.violation) violations.push(parsed.violation);
    cursor = Math.max(cursor, Number(row.seq));
  }
  return { events, violations, cursor };
}
