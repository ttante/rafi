// Group A of ARCH 3.4: project, plan and tickets.
import { z } from "zod";
import { by, def, digest, id, nullableText, ticketId, type EventDef } from "./envelope.js";

/** P41: the digests of `.tickets/tickets.yaml` and `delivery.yaml` as rafi read or wrote them (null: not read). The
 * first-write adoption (M2) predates them, so they may be absent. */
const fileDigests = { digest: digest.nullable().optional(), delivery_digest: digest.nullable().optional() };

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
    group: nullableText, ...fileDigests,
  }),
  // An item whose field is "added" adds that ticket (plan choice: how 4.4's "adding a ticket" is read).
  def("tickets.changed", "state", "project", {
    by: z.enum(["user", "planner"]),
    items: z.array(z.union([z.object({ ticket: ticketId, field: z.string().min(1) }).strict(),
      z.object({ unit: z.string().min(1), field: z.string().min(1) }).strict()])),
    material: z.boolean(), ...fileDigests,
  }),
  // P50: a `conflict` fix ticket names the delivery unit it repairs; `unit` is null (or absent, M1–M4) otherwise.
  def("ticket.added", "state", "ticket", {
    ticket: ticketId, source: z.enum(["ci", "recheck", "conflict"]), requirements: z.array(z.string()),
    hint: nullableText, unit: nullableText.optional(),
  }),
  def("ticket.status_set", "state", "ticket", {
    status: trackerStatus, summary: nullableText, validation: nullableText, evidence: nullableText, by,
  }),
  def("ticket.tags_added", "state", "ticket", { tags: z.array(tagReason) }),
  // "As today's tracker records" (ARCH 3.4 :277; M5 plan item 11): a group keeps each member's definition as a
  // blob, so `rafi tickets reset --deleted-tickets restore` can bring a deleted one back (C232).
  def("ticket.group_created", "state", "project", {
    group: z.string().regex(/^TG-\d+$/), tickets: z.array(ticketId), origin: z.enum(["repair", "populate", "future-work"]),
    members: z.array(z.object({ ticket: ticketId, definition: digest }).strict()),
  }),
  def("ticket.risk_waiver_recorded", "state", "ticket", { note: z.string(), by }),
  // FLAG-TK-15's fields: `from` is --source-ticket.
  def("future_work.added", "state", "project", {
    id, title: z.string(), from: nullableText, proposed_ticket: nullableText,
    priority: z.enum(["P0", "P1", "P2", "P3"]).nullable(), area: nullableText, rationale: nullableText,
    needs_decision_from: nullableText,
  }),
  def("future_work.accepted", "state", "project", { id, ticket: ticketId }),
  // A split, combine or duplicate recommendation with the ticket change accepting it makes (today's `patch`).
  def("recommendation.recorded", "state", "project", {
    id, text: z.string(), ticket: ticketId.nullable(), kind: z.enum(["split", "combine", "duplicate"]),
    patch: z.object({ add: z.array(z.record(z.string(), z.unknown())).default([]),
      update: z.array(z.object({ id: ticketId, set: z.record(z.string(), z.unknown()) }).strict()).default([]),
      remove: z.array(ticketId).default([]) }).strict(),
  }),
  def("recommendation.resolved", "state", "project", { id, resolution: z.enum(["accepted", "dismissed",
    "deferred"]) }),
];

export { trackerStatus };
