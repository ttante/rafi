// type → { v, class, scope, schema }: used by append, read and the transition tests.
import { buildEvents } from "./build.js";
import { envelopeSchema, EVENT_DATA_LIMIT, type EventDef } from "./envelope.js";
import { historyEvents } from "./history.js";
import { projectEvents } from "./project.js";
import { questionEvents } from "./questions.js";
import { resultEvents } from "./results.js";
import { ticketEvents } from "./tickets.js";
import { turnEvents } from "./turns.js";

const all: readonly EventDef[] = Object.freeze([
  ...projectEvents, ...buildEvents, ...turnEvents, ...resultEvents, ...ticketEvents, ...questionEvents,
  ...historyEvents,
]);

export const eventRegistry: ReadonlyMap<string, EventDef> = new Map(all.map((entry) => [entry.type, entry]));

export function eventTypes(): string[] {
  return all.map((entry) => entry.type);
}

export type DataCheck = { ok: true; data: unknown } | { ok: false; reason: string };

const newEnvelope = envelopeSchema.omit({ seq: true });

/**
 * Validates an event's envelope columns, as on write (no seq yet) and on read (ARCH 3.2, 3.3, 1.2).
 * The class must be the one the registry gives the type.
 */
export function checkEnvelope(envelope: Record<string, unknown>, o: { stored: boolean }): DataCheck {
  const parsed = (o.stored ? envelopeSchema : newEnvelope).safeParse(envelope);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `envelope ${first?.path.join(".") || "row"} ${first?.message ?? "is invalid"}` };
  }
  const entry = eventRegistry.get(String(envelope.type));
  if (entry && entry.class !== envelope.class) {
    return { ok: false, reason: `envelope class ${String(envelope.class)} isn't ${entry.class} for ${entry.type}` };
  }
  return { ok: true, data: parsed.data };
}

/** Validates one event's type, version and payload, as on write and on read (ARCH 3.3, 1.2). */
export function checkEventData(type: string, v: number, data: unknown): DataCheck {
  const entry = eventRegistry.get(type);
  if (!entry) return { ok: false, reason: `unknown event type ${type}` };
  if (v !== entry.v) return { ok: false, reason: `unknown version ${v} of ${type}` };
  const size = Buffer.byteLength(JSON.stringify(data) ?? "", "utf8");
  if (size > EVENT_DATA_LIMIT) return { ok: false, reason: `${type} data is ${size} bytes, over 64 KB` };
  const parsed = entry.schema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `${type}: ${first?.path.join(".") || "data"} ${first?.message ?? "is invalid"}` };
  }
  return { ok: true, data: parsed.data };
}
