import type { ProviderSessionRefV1 } from "rafi-spec";
import type { RuntimeFailure } from "./adapters/types.js";

export type QaDeliveryOutcome = "remediation-reported" | "blocked" | "needs-input" | "response-invalid" | "delivery-uncertain" | "source-drift";

export interface QaDeliveryInvocationV3 {
  version: 3;
  invocationId: string;
  runId: string;
  ticketId: string;
  reviewAttemptId: string;
  reportOccurrenceId: string;
  operationId?: string;
  status: "started" | "completed" | "failed";
  outcome?: QaDeliveryOutcome;
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  /** Sequential host spans; provider/capture spans within work are nested. */
  phases: Array<{ name: string; startedAt: string; completedAt?: string; elapsedMs?: number; outcome?: "completed" | "failed" }>;
}

export interface QaDeliveryTurnV3 {
  version: 3;
  turnRecordId: string;
  operationId: string;
  reportOccurrenceId: string;
  turnIndex: number;
  kind: "remediation" | "response-repair";
  parentTurnRecordId?: string;
  status: "intended" | "completed" | "delivery-uncertain";
  intendedSession: ProviderSessionRefV1;
  observedSession?: ProviderSessionRefV1;
  hostInstructionDigest: string;
  hostInstructionBytes: number;
  providerInstructionDigest?: string;
  providerInstructionBytes?: number;
  providerInstructionAvailability: "unavailable" | "captured";
  providerTurnId?: string;
  providerMetadata?: { provider: string; sessionId?: string; sessionRef?: ProviderSessionRefV1 };
  rawResponseDigest?: string;
  rawResponseBytes?: number;
  cleanedResponseDigest?: string;
  cleanedResponseBytes?: number;
  parsedResponseDigest?: string;
  providerReturnedError?: boolean;
  failure?: RuntimeFailure;
  eventEvidenceDigest?: string;
  toolCount?: number;
  terminalCount?: number;
  parserErrors?: string[];
  validationErrors?: string[];
  responseOnlyViolations?: string[];
  responseOnlySourceChanged?: boolean;
  postSourceDigest?: string;
  sourceCapture: "pending" | "captured" | "unavailable";
  sourceCaptureError?: string;
  startedAt: string;
  completedAt?: string;
  providerElapsedMs?: number;
  captureElapsedMs?: number;
  validationElapsedMs?: number;
}
