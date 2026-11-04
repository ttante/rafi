// The 1.0 interview record (C150, FILE-31): `.rafi/interviews/<id>.json`, one per saved create, plan or
// ticket-setup interview. Strict; the checkpoint (the answers so far) is kept as an opaque JSON object.
import { z } from "zod";

export const interviewId = z.string().regex(/^[A-Za-z0-9-]+$/).max(80);

export const interviewSchema = z.object({
  version: z.literal(1), id: interviewId, workflow: z.enum(["create", "plan", "ticket-setup"]),
  status: z.enum(["in_progress", "paused", "needs_review", "completed"]), title: z.string().max(500),
  created_at: z.string().datetime(), updated_at: z.string().datetime(), completed_at: z.string().datetime().optional(),
  checkpoint: z.record(z.string(), z.unknown()),
}).strict();

export type InterviewV1 = z.infer<typeof interviewSchema>;

export function checkInterview(value: unknown): { ok: true; record: InterviewV1 } | { ok: false; reason: string } {
  const parsed = interviewSchema.safeParse(value);
  if (parsed.success) return { ok: true, record: parsed.data };
  const first = parsed.error.issues[0];
  return { ok: false, reason: `${first?.path.join(".") || "record"} ${first?.message ?? "is invalid"}` };
}
