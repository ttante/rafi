// Group E of ARCH 3.4: tickets in a build.
import { z } from "zod";
import { def, nullableText, type EventDef } from "./envelope.js";

export const blockKind = z.enum([
  "permission", "install", "service", "credential", "decision", "other", "held", "what-next", "unverified",
  "confirm", "build-wide", "manual", "limit", "unfixed",
]);
const unit = z.string().min(1);
const git = { sha: nullableText, branch: nullableText, url: nullableText, unit: nullableText };

export const ticketEvents: readonly EventDef[] = [
  def("ticket.blocked", "state", "ticket", {
    kind: blockKind, reason: z.string(), question: nullableText, waits: z.array(z.string()),
  }),
  def("ticket.unblocked", "state", "ticket", { resume_step: nullableText, by: z.string() }),
  def("ticket.dropped", "state", "ticket", { why: z.enum(["wont-do", "obsolete", "canceled"]) }),
  def("ticket.reopened", "state", "ticket", { why: z.string() }),
  def("git.committed", "state", "ticket", git),
  def("git.branch_created", "state", "ticket", git),
  def("git.pushed", "state", "build", git),
  def("pr.created", "state", "build", git),
  def("pr.merged", "state", "build", git),
  // One event marks the moment delivery finishes, carrying the ticket's validation summary (review finding 3).
  def("delivery.done", "state", "ticket", {
    unit: nullableText,
    validation: z.object({
      result: z.string(), runs: z.array(z.number().int().positive()), unverified: z.array(z.number().int()),
    }).strict(),
  }),
  def("unit.ready", "state", "build", { unit }),
  def("unit.merge_waiting", "state", "build", { unit, until: z.string().datetime() }),
  def("unit.delivered", "state", "build", { unit, how: z.enum(["merged", "pushed", "pr-opened"]) }),
  def("unit.failed", "state", "build", {
    unit, category: z.enum(["transient", "conflict", "auth", "rejected"]), message: z.string(),
  }),
  def("scan.gap", "state", "ticket", { question: z.string(), kind: z.string() }),
];
