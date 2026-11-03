// The committed progress file, `.rafi/progress.yaml` (ARCH 3.7): ticket status, open questions, saved answers.
import { z } from "zod";

const status = z.enum(["planned", "next", "in_progress", "blocked", "done", "canceled", "obsolete"]);

export const progressFile = z.object({
  version: z.literal(1),
  tickets: z.record(z.string(), z.object({
    status, at: z.string(), reason: z.string().optional(), question: z.number().int().positive().optional(),
    step: z.string().optional(), fixes: z.number().int().nonnegative().optional(),
  }).strict()),
  questions: z.record(z.string(), z.object({
    at: z.string(), kind: z.string(), tickets: z.array(z.string()), text: z.string(), options: z.array(z.string()),
  }).strict()),
  answers: z.record(z.string(), z.object({
    at: z.string(), choice: z.string().nullable(), source: z.string(),
  }).strict()),
}).strict();

export type ProgressFile = z.infer<typeof progressFile>;

export function checkProgressFile(value: unknown): { ok: true; file: ProgressFile } | { ok: false; message: string } {
  const parsed = progressFile.safeParse(value);
  if (parsed.success) return { ok: true, file: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, message: `progress.yaml: ${issue?.path.join(".") || "file"} ${issue?.message ?? "is invalid"}.` };
}
