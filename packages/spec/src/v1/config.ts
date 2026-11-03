// The 1.0 config subset M1 checks (plan choice C17): the format marker and the reserved workflows key.
// Every other key passes unchecked until its milestone.
import { z } from "zod";

export const CUSTOM_WORKFLOWS_MESSAGE = "Custom workflows aren't supported yet.";

export const configV1Schema = z
  .object({ format_version: z.literal(1) })
  .passthrough()
  .superRefine((value, ctx) => {
    if ("workflows" in value) ctx.addIssue({ code: "custom", message: CUSTOM_WORKFLOWS_MESSAGE, path: ["workflows"] });
  });

export type ConfigV1 = z.infer<typeof configV1Schema>;

export type ConfigCheck = { ok: true; config: ConfigV1 } | { ok: false; message: string };

export function checkConfigV1(value: unknown): ConfigCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "rafi-config.yaml must be a mapping of settings." };
  }
  const parsed = configV1Schema.safeParse(value);
  if (parsed.success) return { ok: true, config: parsed.data };
  const issue = parsed.error.issues[0];
  if (issue?.path[0] === "workflows") return { ok: false, message: CUSTOM_WORKFLOWS_MESSAGE };
  return { ok: false, message: "rafi-config.yaml: format_version must be the number 1." };
}
