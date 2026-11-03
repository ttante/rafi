// The event envelope of ARCH 3.2 and the helpers every event group uses.
import { z } from "zod";

export const EVENT_DATA_LIMIT = 64 * 1024;

export const eventClassSchema = z.enum(["state", "detail"]);
export const originSchema = z.enum(["local", "imported"]);
export const sourceSchema = z.enum([
  "terminal", "notification", "rafi-answer", "manager", "gui", "auto-approve", "flag", "saved", "progress-file",
]);
export const actorSchema = z.string().regex(/^(user|engine|manager|maestro|api|agent:[a-z-]+)$/);

export const ticketId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);

export const envelopeSchema = z.object({
  seq: z.number().int().positive(),
  id: z.string().min(1),
  run_id: z.string().min(1).nullable(),
  ticket_id: ticketId.nullable(),
  type: z.string().min(1),
  v: z.number().int().positive(),
  class: eventClassSchema,
  at: z.string().datetime(),
  actor: actorSchema,
  source: sourceSchema.nullable(),
  origin: originSchema,
  idem_key: z.string().nullable(),
}).strict();

export type Envelope = z.infer<typeof envelopeSchema>;
export type EventClass = z.infer<typeof eventClassSchema>;

/** What an event's state belongs to: the fold routes it by this (ARCH 3.6). */
export type EventScope = "project" | "build" | "ticket" | "none";

export interface EventDef {
  readonly type: string;
  readonly v: number;
  readonly class: EventClass;
  readonly scope: EventScope;
  readonly schema: z.ZodType;
}

export function def(type: string, cls: EventClass, scope: EventScope, shape: z.ZodRawShape): EventDef {
  return Object.freeze({ type, v: 1, class: cls, scope, schema: z.object(shape).strict() });
}

export const id = z.string().min(1);
export const nullableText = z.string().nullable();
export const runNumbers = z.array(z.number().int().positive());
export const digest = z.string().min(1);
export const by = z.enum(["user", "auto-approve", "carried", "planner", "engine", "manager", "api"]);
