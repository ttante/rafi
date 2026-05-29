import { DateTime } from "luxon";
import type { StateDb, TicketEvent } from "./stateDb.js";

export function nowTimestamp(timezone: string): string {
  return DateTime.now().setZone(timezone).toISO() ?? new Date().toISOString();
}

export function logEvent(
  db: StateDb,
  opts: {
    timestamp: string;
    actor: string | null;
    ticketId: string | null;
    eventType: string;
    oldStatus: string | null;
    newStatus: string | null;
    summary: string;
    validation?: string | null;
    evidence?: string | null;
    payload?: Record<string, unknown>;
  },
): void {
  const event: Omit<TicketEvent, "id"> = {
    timestamp: opts.timestamp,
    actor: opts.actor,
    ticket_id: opts.ticketId,
    event_type: opts.eventType,
    old_status: opts.oldStatus,
    new_status: opts.newStatus,
    summary: opts.summary,
    validation: opts.validation ?? null,
    evidence: opts.evidence ?? null,
    payload_json: JSON.stringify(opts.payload ?? {}),
  };
  db.insertEvent(event);
}
