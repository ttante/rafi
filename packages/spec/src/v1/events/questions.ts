// Group F of ARCH 3.4: questions, answers and grants.
import { z } from "zod";
import { def, id, nullableText, ticketId, type EventDef } from "./envelope.js";

const guidance = { id, role: z.string(), ticket: ticketId.nullable(), text: z.string(), turn: nullableText };

export const questionEvents: readonly EventDef[] = [
  def("question.opened", "state", "project", {
    id, no: z.number().int().positive(), kind: z.string(), tickets: z.array(ticketId), text: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string() }).strict()), recommended: nullableText,
    context: nullableText, urgency: z.enum(["low", "normal", "high"]), key: nullableText,
  }),
  def("question.answered", "state", "project", {
    id, choice: nullableText, text: nullableText, note: nullableText,
    save: z.enum(["none", "build", "project", "machine"]),
  }),
  def("question.deferred", "state", "project", { id }),
  def("question.closed", "state", "project", {
    id, why: z.enum(["superseded", "stale", "ticket-dropped", "scope-changed"]),
  }),
  def("grant.recorded", "state", "project", {
    need: z.string(), scope: z.enum(["build", "machine"]), allowed: z.boolean(), tickets: z.array(ticketId),
  }),
  def("guidance.queued", "state", "project", guidance),
  def("guidance.delivered", "state", "project", guidance),
  def("guidance.acknowledged", "state", "project", guidance),
  def("guidance.withdrawn", "state", "project", guidance),
  def("guidance.superseded", "state", "project", guidance),
];
