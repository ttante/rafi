// Group G of ARCH 3.4: tools, recordings, history and imports.
import { z } from "zod";
import { def, digest, nullableText, ticketId, type EventDef } from "./envelope.js";
import { trackerStatus } from "./project.js";

export const progressEntry = z.object({
  kind: z.enum(["ticket", "question", "answer"]),
  key: z.string().min(1),
  status: trackerStatus.nullable(),
  at: z.string().datetime(),
}).strict();

export const historyEvents: readonly EventDef[] = [
  def("tool.added", "state", "project", { name: z.string(), entry_digest: digest }),
  def("recording.saved", "state", "ticket", {
    ticket: ticketId, req: z.number().int().positive().nullable(),
    kind: z.enum(["screenshot", "video", "trace"]), path: z.string(), bytes: z.number().int().nonnegative(),
  }),
  def("recording.removed", "state", "ticket", { path: z.string(), why: z.string() }),
  def("history.deleted", "state", "project", { runs: z.array(z.string()), counts: z.record(z.string(), z.number()) }),
  def("logs.imported", "state", "project", { file: z.string(), runs: z.array(z.string()) }),
  def("progress.imported", "state", "ticket", { entry: progressEntry, chose: z.enum(["ours", "theirs"]) }),
  def("notify.sent", "detail", "none", {
    question: nullableText, event: nullableText, channel: z.string(), shown: z.array(z.string()),
    more: z.boolean(), outcome: z.string(),
  }),
  def("notify.reminder", "detail", "none", {
    question: nullableText, event: nullableText, channel: z.string(), shown: z.array(z.string()),
    more: z.boolean(), outcome: z.string(),
  }),
];
