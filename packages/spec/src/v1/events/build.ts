// Group B of ARCH 3.4: builds.
import { z } from "zod";
import { def, digest, ticketId, type EventDef } from "./envelope.js";

const settingValue = z.object({ value: z.unknown(), source: z.string() }).strict();
const scope = z.object({
  kind: z.enum(["steps", "to_ticket", "stacks", "ticket", "all"]),
  value: z.union([z.number().int().positive(), z.string(), z.array(z.string()), z.null()]),
  skip: z.array(ticketId),
}).strict();

export const buildEvents: readonly EventDef[] = [
  def("build.started", "state", "build", {
    workflow: z.object({ id: z.string(), version: z.number().int().positive(), digest }).strict(),
    scope, tickets: z.array(ticketId), settings: z.record(z.string(), settingValue),
    engine_version: z.string(), argv: z.array(z.string()),
  }),
  def("build.owner_acquired", "state", "build", {
    instance: z.string(), host: z.string(), pid: z.number().int().nonnegative(),
  }),
  def("build.owner_released", "state", "build", { reason: z.enum(["finished", "stopped", "waiting", "failed"]) }),
  def("build.owner_lost", "state", "build", { last_heartbeat_at: z.string().datetime() }),
  def("build.resumed", "state", "build", { from_state: z.string() }),
  def("build.waiting", "state", "build", { questions: z.array(z.string()) }),
  def("build.unwaiting", "state", "build", { questions: z.array(z.string()) }),
  def("build.pause_requested", "state", "build", { source: z.string(), boundary: z.string().nullable() }),
  def("build.paused", "state", "build", { source: z.string(), boundary: z.string().nullable() }),
  def("build.unpause_requested", "state", "build", { source: z.string(), boundary: z.string().nullable() }),
  def("build.unpaused", "state", "build", { source: z.string(), boundary: z.string().nullable() }),
  def("build.stop_requested", "state", "build", {
    mode: z.enum(["graceful", "now"]), source: z.enum(["rafi-stop", "ctrl-c", "gui", "manager"]),
  }),
  def("build.stopped", "state", "build", { cause: z.enum(["stop", "cancel", "ctrl-c"]) }),
  def("build.finished", "state", "build", {
    complete: z.boolean(), done: z.array(ticketId), left: z.array(ticketId),
  }),
  def("build.failed", "state", "build", { error: z.string(), message: z.string() }),
];
