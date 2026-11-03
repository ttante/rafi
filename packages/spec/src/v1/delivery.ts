// The 1.0 delivery file, `.tickets/delivery.yaml` (ARCH 13; read in M2, delivery itself is M5).
import { z } from "zod";

export const deliveryUnit = z.object({
  id: z.string().min(1),
  tickets: z.array(z.string()).min(1),
  completion: z.enum(["pr", "pr-ready", "auto-merge", "direct-merge", "none"]).optional(),
  branch: z.string().optional(),
  dependency_mode: z.string().optional(),
}).passthrough();

export type DeliveryUnit = z.infer<typeof deliveryUnit>;
export type DeliveryCheck = { ok: true; units: DeliveryUnit[] } | { ok: false; message: string };

export function checkDeliveryFile(value: unknown): DeliveryCheck {
  const list = (value as { delivery_units?: unknown } | null)?.delivery_units ?? [];
  if (!Array.isArray(list)) return { ok: false, message: "delivery.yaml: `delivery_units` must be a list." };
  const units: DeliveryUnit[] = [];
  for (const [index, raw] of list.entries()) {
    const parsed = deliveryUnit.safeParse(raw);
    const name = String((raw as { id?: unknown } | null)?.id ?? `#${index + 1}`);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { ok: false, message: `delivery.yaml: unit ${name}: ${issue?.path.join(".")} ${issue?.message}.` };
    }
    units.push(parsed.data);
  }
  return { ok: true, units };
}
