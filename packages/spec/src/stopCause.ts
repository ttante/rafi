import { z } from "zod";

export const stopCauseValues = [
  "user-sigint", "parent-sigterm", "heartbeat-timeout",
  "heartbeat-persistence-failure", "readiness-failure", "launch-failure",
  "worker-exit", "worker-disconnect", "supervisor-process-exit",
  "human-decision", "worker-reconciliation-required", "unknown",
] as const;
export type StopCauseName = typeof stopCauseValues[number];
export type StopCauseActor = "user" | "supervisor" | "worker" | "parent" | "provider" | "database" | "readiness" | "external" | "unknown";
export type StopCauseSource = "signal" | "heartbeat" | "persistence" | "readiness" | "launch" | "worker" | "supervisor" | "human-decision" | "reconciliation" | "host";

export interface StopCause {
  version: 1;
  cause: StopCauseName;
  source: StopCauseSource;
  actor: StopCauseActor;
  runId: string;
  supervisorGeneration?: number;
  workerGeneration?: number;
  pid?: number;
  processStart?: string;
  checkpoint: string;
  at: string;
  requested: boolean;
  detail?: string;
}

export const stopCauseSchema = z.object({
  version: z.literal(1),
  cause: z.enum(stopCauseValues),
  source: z.enum(["signal", "heartbeat", "persistence", "readiness", "launch", "worker", "supervisor", "human-decision", "reconciliation", "host"]),
  actor: z.enum(["user", "supervisor", "worker", "parent", "provider", "database", "readiness", "external", "unknown"]),
  runId: z.string().min(1).max(256),
  supervisorGeneration: z.number().int().nonnegative().optional(),
  workerGeneration: z.number().int().nonnegative().optional(),
  pid: z.number().int().positive().optional(),
  processStart: z.string().max(256).optional(),
  checkpoint: z.string().min(1).max(256),
  at: z.string().datetime(),
  requested: z.boolean(),
  detail: z.string().max(2048).optional(),
}).strict();

export function parseStopCause(value: unknown): StopCause {
  return stopCauseSchema.parse(value) as StopCause;
}

export function stopCause(input: Omit<StopCause, "version">): StopCause {
  return parseStopCause({ version: 1, ...input });
}
