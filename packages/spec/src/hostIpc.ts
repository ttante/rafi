import { z } from "zod";

const identity = z.string().min(1).max(1024);
const pid = z.number().int().min(2);
const generation = z.number().int().min(0);
/** Child messages are hints. Durable ownership remains authoritative. */
export const hostIpcSchema = z.discriminatedUnion("kind", [
  z.strictObject({ version: z.literal(1), kind: z.literal("rafi-launch-registered"), token: identity, pid }),
  z.strictObject({ version: z.literal(1), kind: z.literal("rafi-launch-ack"), token: identity, pid }),
  z.strictObject({ version: z.literal(1), kind: z.literal("rafi-worker-heartbeat"), runId: identity, generation, pid, sequence: z.number().int().min(1) }),
  z.strictObject({ version: z.literal(1), kind: z.literal("rafi-readiness-child"), runId: identity, generation, workerPid: pid, pid, active: z.boolean(), tag: identity, processStart: identity.nullable() }),
  z.strictObject({ version: z.literal(1), kind: z.literal("rafi-probe-registered"), id: identity, pid }),
  z.strictObject({ version: z.literal(1), kind: z.literal("rafi-probe-authorized"), id: identity, pid }),
  z.strictObject({ version: z.literal(1), kind: z.literal("rafi-probe-spawn-error"), id: identity, pid, code: z.string().max(256).nullable(), message: z.string().max(8192) }),
  z.strictObject({ version: z.literal(1), kind: z.literal("rafi-probe-result"), id: identity, pid, exitCode: z.number().int().nullable(), signal: z.string().max(64).nullable() }),
]);
export type HostIpc = z.infer<typeof hostIpcSchema>;
export function parseHostIpc(value: unknown): HostIpc | undefined {
  const result = hostIpcSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
