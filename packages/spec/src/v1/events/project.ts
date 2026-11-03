// Group A of ARCH 3.4: project, plan and tickets.
import { z } from "zod";
import { by, def, digest, id, nullableText, ticketId, type EventDef } from "./envelope.js";

const trackerStatus = z.enum(["planned", "next", "in_progress", "blocked", "done", "canceled", "obsolete"]);
const tagReason = z.object({ tag: z.string().min(1), reason: z.string() }).strict();
const changeItem = z.object({ ticket: ticketId, field: z.string().min(1), change: z.string().optional() }).strict();

export const projectEvents: readonly EventDef[] = [
  def("project.created", "state", "project", { app_name: z.string(), rafi_version: z.string() }),
  def("project.migrated", "state", "project", {
    from: z.literal("0.10.x"), files: z.array(z.string()), kept: z.array(z.string()), dropped: z.array(z.string()),
    state: z.enum(["ready", "ticketing", "draft"]),
  }),
  def("project.archived", "state", "project", {}),
  def("project.unarchived", "state", "project", {}),
  def("plan.started", "state", "project", { mode: z.enum(["new", "revise"]), interview_id: nullableText }),
  def("plan.proposed", "state", "project", {
    plan_id: id, revision: z.number().int().nonnegative(), digest, path: z.string(),
  }),
  def("plan.approved", "state", "project", {
    plan_id: id, revision: z.number().int().nonnegative(), digest, by: z.enum(["user", "auto-approve", "carried"]),
  }),
  def("plan.rejected", "state", "project", { feedback: z.string() }),
  def("plan.failed", "state", "project", { reason: z.string() }),
  def("plan.changed", "state", "project", {
    from_rev: z.number().int().nonnegative(), to_rev: z.number().int().nonnegative(),
    kind: z.enum(["update", "restore"]), by: z.enum(["planner", "user"]), why: z.string(),
    items: z.array(changeItem), applied: z.boolean(),
    told: z.array(z.enum(["terminal", "notification", "summary"])),
  }),
  def("plan.reset", "state", "project", { to_rev: z.number().int().nonnegative(), tickets: z.array(ticketId) }),
  def("scope.approved", "state", "project", { fp: digest, by }),
  def("tickets.populated", "state", "project", {
    plan_rev: z.number().int().nonnegative(), added: z.array(ticketId), retired: z.array(ticketId),
    group: nullableText,
  }),
  // An item whose field is "added" adds that ticket (plan choice: how 4.4's "adding a ticket" is read).
  def("tickets.changed", "state", "project", {
    by: z.enum(["user", "planner"]),
    items: z.array(z.object({ ticket: ticketId, field: z.string().min(1) }).strict()),
    material: z.boolean(),
  }),
  def("ticket.added", "state", "ticket", {
    ticket: ticketId, source: z.enum(["ci", "recheck"]), requirements: z.array(z.string()), hint: nullableText,
  }),
  def("ticket.status_set", "state", "ticket", {
    status: trackerStatus, summary: nullableText, validation: nullableText, evidence: nullableText, by,
  }),
  def("ticket.tags_added", "state", "ticket", { tags: z.array(tagReason) }),
  def("ticket.group_created", "state", "project", { group: z.string(), tickets: z.array(ticketId) }),
  def("ticket.risk_waiver_recorded", "state", "ticket", { note: z.string(), by }),
  def("future_work.added", "state", "project", { id, title: z.string(), from: nullableText }),
  def("future_work.accepted", "state", "project", { id, ticket: ticketId }),
  def("recommendation.recorded", "state", "project", { id, text: z.string(), ticket: ticketId.nullable() }),
  def("recommendation.resolved", "state", "project", { id, resolution: z.string() }),
];

export { trackerStatus };
