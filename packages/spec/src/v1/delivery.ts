// The 1.0 delivery file, `.tickets/delivery.yaml` (FMT-D1, FMT-D2; read since M2, delivered from M5): `version`,
// the plan it came from, and `units[]`, each with its branch mode, completion, provider, merge method, cleanup and
// dependencies. `pr_ready` is gone (completion `pr-ready`, Q-CFG-1); `branch` names a unit's branch exactly.
import { z } from "zod";

export const deliveryUnit = z.object({
  id: z.string().min(1),
  tickets: z.array(z.string()).min(1),
  branch_mode: z.enum(["current", "per-ticket", "shared"]).optional(),
  completion: z.enum(["pr", "pr-ready", "auto-merge", "direct-merge", "none"]).optional(),
  provider: z.enum(["auto", "github", "gitlab", "local"]).optional(),
  merge_method: z.enum(["squash", "merge", "rebase"]).optional(),
  cleanup: z.boolean().optional(),
  depends_on: z.array(z.string()).optional(),
  dependency_mode: z.enum(["combine", "wait", "stack"]).optional(),
  branch: z.string().min(1).optional(),
}).strict();

export type DeliveryUnit = z.infer<typeof deliveryUnit>;
export type DeliveryCheck = { ok: true; units: DeliveryUnit[] } | { ok: false; message: string };

const header = z.object({
  version: z.literal(1).optional(),
  plan: z.object({ plan_id: z.string(), revision: z.number().int().nonnegative() }).strict().nullable().optional(),
  units: z.array(z.unknown()).optional(),
}).strict();

export function checkDeliveryFile(value: unknown): DeliveryCheck {
  if (value && typeof value === "object" && "delivery_units" in value) {
    return { ok: false, message: "delivery.yaml: delivery_units is the 0.10 name; 1.0 lists them under units." };
  }
  const top = header.safeParse(value ?? {});
  if (!top.success) {
    const issue = top.error.issues[0];
    const where = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path.join(".");
    return { ok: false, message: `delivery.yaml: ${where} ${issue?.code === "unrecognized_keys" ? "isn't a 1.0 field"
      : issue?.message}.` };
  }
  const units: DeliveryUnit[] = [];
  for (const [index, raw] of (top.data.units ?? []).entries()) {
    const parsed = deliveryUnit.safeParse(raw);
    const name = String((raw as { id?: unknown } | null)?.id ?? `#${index + 1}`);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path.join(".");
      return { ok: false, message: `delivery.yaml: unit ${name}: ${field} ${issue?.code === "unrecognized_keys"
        ? "isn't a 1.0 field" : issue?.message}.` };
    }
    units.push(parsed.data);
  }
  return { ok: true, units };
}
