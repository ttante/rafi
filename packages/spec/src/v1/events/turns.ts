// Group C of ARCH 3.4: steps and turns.
import { z } from "zod";
import { def, digest, nullableText, type EventDef } from "./envelope.js";

const outcome = z.enum(["ok", "format", "content", "provider", "timeout", "cancelled", "quota", "auth"]);
const key = z.string().min(1);

export const turnEvents: readonly EventDef[] = [
  def("ticket.started", "state", "ticket", { resume_step: nullableText }),
  def("step.started", "state", "ticket", { step: z.string().min(1), attempt: z.number().int().positive() }),
  def("step.failed", "state", "ticket", { category: z.string(), reason: z.string(), circling: z.boolean() }),
  def("turn.retry", "state", "ticket", {
    key, category: z.string(), attempt: z.number().int().positive(), delay_ms: z.number().int().nonnegative(),
    reason: z.string(),
  }),
  def("turn.intent", "detail", "none", {
    key, role: z.string(), runtime: z.enum(["codex", "claude"]), model: nullableText, effort: nullableText,
    fast: z.boolean(), session: z.enum(["new", "reused"]), schema: z.string(),
    instruction_chars: z.number().int().nonnegative(), instruction_digest: digest, tools: z.array(z.string()),
    grants: z.array(z.string()), redo: z.boolean(),
  }),
  def("turn.sent", "detail", "none", { key, native_session: nullableText, native_turn: nullableText }),
  def("turn.reply", "detail", "none", {
    key, outcome, errors: z.array(z.string()), raw: digest.nullable(),
    usage: z.object({
      input: z.number().nonnegative(), output: z.number().nonnegative(), cost: z.number().nullable(),
      measured: z.boolean(),
    }).strict(),
    timing: z.object({
      first_output_ms: z.number().nullable(), agent_ms: z.number(), tools_ms: z.number(), rafi_ms: z.number(),
    }).strict(),
  }),
  def("turn.repair", "detail", "none", {
    key, error: z.string(), at_byte: z.number().int().nullable(), accepted: z.boolean(), why: nullableText,
  }),
  def("turn.cancelled", "detail", "none", { key, cause: z.string(), confirmed: z.boolean() }),
  def("turn.activity", "detail", "none", { key, kind: z.string(), text: z.string() }),
  def("turn.tool", "detail", "none", {
    key, run: z.number().int().positive().nullable(), tool: z.string(), command: nullableText,
    outcome: z.enum(["completed", "failed", "timed-out", "cancelled", "unknown"]),
    exit_code: z.number().int().nullable(), duration_ms: z.number().nullable(), output_digest: digest.nullable(),
    harmless: z.boolean(),
  }),
  def("turn.prompt", "detail", "none", { key, blob: digest }),
];
