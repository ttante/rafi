// Appending: validate, redact, size check, transition check, idempotency, one transaction per outcome.
import { checkEnvelope, checkEventData, eventRegistry, EVENT_DATA_LIMIT } from "rafi-spec/v1";
import type { Db } from "../deps/types.js";
import type { Log } from "./db.js";
import { parseRow } from "./read.js";
import type { Redactor } from "./redact.js";
import type { NewEvent, StoredEvent } from "./types.js";

export class InvalidEventError extends Error {
  readonly category = "bug";
}

export interface AppendContext {
  readonly log: Log;
  readonly redact: Redactor;
  now(): Date;
  newId(): string;
  /** Checks the events against the folded state; returns a reason when a transition is invalid. */
  checkTransition?(events: readonly StoredEvent[]): string | null;
}

export interface AppendResult {
  readonly events: readonly StoredEvent[];
  readonly replayed: boolean;
}

const INSERT = `INSERT INTO events (id, run_id, ticket_id, type, v, class, at, actor, source, origin, idem_key, data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)`;

/** A ticket event whose data names its ticket gets that ticket_id; a different envelope ticket_id is a bug. */
function ticketOf(event: NewEvent, scope: string, data: unknown): string | null {
  const named = (data as { ticket?: unknown } | null)?.ticket;
  if (scope !== "ticket" || typeof named !== "string") return event.ticket_id ?? null;
  if (event.ticket_id != null && event.ticket_id !== named) {
    throw new InvalidEventError(
      `${event.type}: ticket_id ${event.ticket_id} isn't the ticket its data names (${named})`);
  }
  return named;
}

function prepare(ctx: AppendContext, event: NewEvent, idemKey: string | null): Omit<StoredEvent, "seq"> {
  const entry = eventRegistry.get(event.type);
  if (!entry) throw new InvalidEventError(`unknown event type ${event.type}`);
  const data = ctx.redact.value(event.data);
  const checked = checkEventData(event.type, entry.v, data);
  if (!checked.ok) throw new InvalidEventError(checked.reason);
  const size = Buffer.byteLength(JSON.stringify(checked.data), "utf8");
  if (size > EVENT_DATA_LIMIT) throw new InvalidEventError(`${event.type} data is over 64 KB`);
  const envelope = {
    id: ctx.newId(), run_id: event.run_id ?? null, ticket_id: ticketOf(event, entry.scope, checked.data),
    type: event.type, v: entry.v, class: entry.class, at: ctx.now().toISOString(), actor: event.actor,
    source: event.source ?? null, origin: "local" as const, idem_key: idemKey,
  };
  const valid = checkEnvelope(envelope, { stored: false });
  if (!valid.ok) throw new InvalidEventError(`${event.type}: ${valid.reason}`);
  return { ...envelope, data: checked.data };
}

function replay(db: Db, idemKey: string): StoredEvent[] {
  const rows = db.prepare("SELECT * FROM events WHERE idem_key = ? ORDER BY seq").all(idemKey);
  return (rows as Record<string, unknown>[]).map((row) => {
    const parsed = parseRow(row);
    if (!parsed.event) throw new InvalidEventError(`stored event ${String(row.seq)}: ${parsed.violation?.reason}`);
    return parsed.event;
  });
}

/** Appends events in one transaction. An invalid event or transition throws and writes nothing (ARCH 3.3).
 * `inTx` runs first inside the same transaction (C132: the lease row with the owner events); throwing aborts. */
export async function append(
  ctx: AppendContext, events: readonly NewEvent[], o: { idemKey?: string; inTx?: (db: Db) => void } = {},
): Promise<AppendResult> {
  const idemKey = o.idemKey ?? null;
  const prepared = events.map((event) => prepare(ctx, event, idemKey));
  return ctx.log.write((db) => {
    if (idemKey !== null) {
      const earlier = replay(db, idemKey);
      if (earlier.length) return { events: earlier, replayed: true };
    }
    o.inTx?.(db);
    const insert = db.prepare(INSERT);
    const written = prepared.map((event) => {
      const info = insert.run(event.id, event.run_id, event.ticket_id, event.type, event.v, event.class,
        event.at, event.actor, event.source, event.idem_key, JSON.stringify(event.data));
      return { ...event, seq: Number(info.lastInsertRowid) };
    });
    const reason = ctx.checkTransition?.(written) ?? null;
    if (reason) throw new InvalidEventError(`invalid transition: ${reason}`);
    return { events: written, replayed: false };
  });
}
