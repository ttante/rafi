import { createHash } from "node:crypto";
import type { QaFindingRefV2 } from "rafi-spec";

export const QA_PROTOCOL_VERSION = 2 as const;

export type QaProtocolState =
  | "idle"
  | "source-frozen"
  | "review-ready"
  | "turn-intended"
  | "turn-uncertain"
  | "review-failed"
  | "remediation-intended"
  | "remediation-uncertain"
  | "recheck-required"
  | "operator-menu"
  | "passed"
  | "waived"
  | "finalizing"
  | "completed";

export interface FrozenQaSourceStateV2 {
  version: 2;
  runId: string;
  ticketId: string;
  originDigest: string;
  contentDigest: string;
  digest: string;
  capturedAt: string;
  paths: Array<{ path: string; staged: string[]; unstaged: string[]; headObject?: string; indexObject?: string; worktreeObject?: string; untracked?: { kind: "file" | "symlink"; mode: number; digest: string } }>;
}

export interface QaConfinementV2 {
  version: 2;
  sourceMode: "read-only";
  scratchMode: "isolated";
  networkMode: "disabled" | "provider-required";
  settingsSources: "none";
  environmentDigest: string;
  policyDigest: string;
}

export interface QaReviewBasisV2 {
  version: 2;
  ticketDigest: string;
  instructionDigest: string;
  roleInstructionsDigest: string;
  skillsDigest: string;
  runtimeDigest: string;
  validationChecklistDigest: string;
  confinementDigest: string;
  digest: string;
}

export interface ProviderSessionRefV2 {
  version: 2;
  provider: "claude" | "codex";
  sessionId: string;
  role: "qa";
  stream: "qa";
  generation: number;
  cwd: string;
  configRoot: string;
  createdAt: string;
  validatedAt: string;
}

export interface QaSessionHandleV2 {
  version: 2;
  session: ProviderSessionRefV2;
  sourceStateDigest: string;
  reviewBasisDigest: string;
  confinementDigest: string;
  acceptedHandoffReceiptDigest?: string;
}

export interface QaTurnIntentV2 {
  version: 2;
  operationId: string;
  runId: string;
  ticketId: string;
  reviewNumber: number;
  sessionGeneration: number;
  slot: string;
  sourceStateDigest: string;
  reviewBasisDigest: string;
  providerSession: ProviderSessionRefV2;
  instructionDigest: string;
  intendedAt: string;
}

export interface QaTurnReceiptV2 {
  version: 2;
  operationId: string;
  dispatch: "not-dispatched" | "completed" | "uncertain";
  providerTurnId?: string;
  providerInstructionDigest?: string;
  rawResponseDigest?: string;
  cleanedResponseDigest?: string;
  eventStreamDigest?: string;
  terminalEventObserved: boolean;
  sourceStateDigest: string;
  reviewBasisDigest: string;
  completedAt: string;
}

export interface HandoffAcceptanceReceiptV2 {
  version: 2;
  operationId: string;
  runId: string;
  ticketId: string;
  qaRevision: number;
  sourceStateDigest: string;
  predecessorSourceStateDigest: string;
  reviewBasisDigest: string;
  requiresFullReview: boolean;
  confinementDigest: string;
  predecessor: ProviderSessionRefV2;
  successor: ProviderSessionRefV2;
  manifestDigest: string;
  continuityCheckpointDigest: string;
  acceptanceCheckpointDigest: string;
  packetDigest: string;
  inventoryDigest: string;
  resources: Array<{
    label: string;
    digest: string;
    authoritative: boolean;
    requiredForRecovery: boolean;
    mediaType: string;
    path: string;
    purpose: string;
    bytes: number;
  }>;
  acceptedAt: string;
}

export interface BuilderRemediationReceiptV2 {
  version: 2;
  operationId: string;
  runId: string;
  ticketId: string;
  reportDigest: string;
  sourceStateDigest: string;
  requestDigest: string;
  responseDigest: string;
  summaryDigest: string;
  providerTurnId: string;
  completedAt: string;
}

export interface QaPassCertificateV2 {
  version: 2;
  certificateId: string;
  runId: string;
  ticketId: string;
  qaRevision: number;
  sourceStateDigest: string;
  reviewBasisDigest: string;
  turnReceiptDigest: string;
  unresolvedReportCount: 0;
  issuedAt: string;
  consumedAt?: string;
  consumedBy?: string;
}

export type QaReportDisposition = "open" | "recheck-required" | "superseded" | "verified-fixed" | "waived";

export interface QaReducerStateV2 {
  version: 2;
  runId: string;
  ticketId: string;
  revision: number;
  state: QaProtocolState;
  reviewNumber: number;
  remediationGeneration: number;
  sourceStateDigest?: string;
  reviewBasisDigest?: string;
  sessionGeneration: number;
  retrySlot?: string;
  openReportDigests: string[];
  passCertificateId?: string;
}

export type QaReducerEventV2 =
  | { type: "source-frozen"; sourceStateDigest: string }
  | { type: "review-ready"; reviewBasisDigest: string; sessionGeneration: number }
  | { type: "turn-intended"; slot: string }
  | { type: "turn-uncertain" }
  | { type: "source-drift" }
  | { type: "review-failed"; reportDigest: string }
  | { type: "remediation-intended" }
  | { type: "remediation-uncertain" }
  | { type: "remediation-failed" }
  | { type: "remediation-received" }
  | { type: "remediation-source-changed"; reason: string }
  | { type: "source-drift-before-remediation"; reason: string }
  | { type: "operator-menu" }
  | { type: "review-passed"; passCertificateId: string }
  | { type: "waived" }
  | { type: "pass-invalidated"; reason: string }
  | { type: "finalization-started" }
  | { type: "finalization-invalidated"; reason: string }
  | { type: "completed" };

export function initialQaReducerState(runId: string, ticketId: string): QaReducerStateV2 {
  return { version: 2, runId, ticketId, revision: 0, state: "idle", reviewNumber: 0, remediationGeneration: 0, sessionGeneration: 0, openReportDigests: [] };
}

/** Pure, exhaustive transition function. Invalid protocol edges fail closed. */
export function reduceQaState(current: QaReducerStateV2, event: QaReducerEventV2): QaReducerStateV2 {
  const next = { ...current, revision: current.revision + 1 };
  switch (event.type) {
    case "source-frozen":
      if (!["idle", "recheck-required", "operator-menu", "turn-uncertain", "remediation-uncertain", "passed"].includes(current.state)) invalid(current, event);
      return { ...next, state: "source-frozen", sourceStateDigest: event.sourceStateDigest, reviewBasisDigest: undefined, retrySlot: undefined, passCertificateId: undefined };
    case "review-ready":
      if (current.state !== "source-frozen") invalid(current, event);
      return { ...next, state: "review-ready", reviewBasisDigest: event.reviewBasisDigest, sessionGeneration: event.sessionGeneration, reviewNumber: current.reviewNumber + 1 };
    case "turn-intended":
      if (current.state !== "review-ready" && current.state !== "turn-intended") invalid(current, event);
      return { ...next, state: "turn-intended", retrySlot: event.slot };
    case "turn-uncertain":
      if (current.state !== "turn-intended") invalid(current, event);
      return { ...next, state: "turn-uncertain" };
    case "source-drift":
      if (current.state !== "turn-intended") invalid(current, event);
      return { ...next, state: "recheck-required", retrySlot: undefined };
    case "review-failed":
      if (current.state !== "turn-intended") invalid(current, event);
      return { ...next, state: "review-failed", retrySlot: undefined, openReportDigests: unique([...current.openReportDigests, event.reportDigest]) };
    case "remediation-intended":
      if (current.state !== "review-failed") invalid(current, event);
      return { ...next, state: "remediation-intended", remediationGeneration: current.remediationGeneration + 1 };
    case "remediation-uncertain":
      if (current.state !== "remediation-intended") invalid(current, event);
      return { ...next, state: "remediation-uncertain" };
    case "remediation-failed":
      if (current.state !== "remediation-intended") invalid(current, event);
      return { ...next, state: "operator-menu" };
    case "remediation-received":
      if (current.state !== "remediation-intended") invalid(current, event);
      return { ...next, state: "recheck-required" };
    case "remediation-source-changed":
      if (!["operator-menu", "remediation-uncertain", "remediation-intended"].includes(current.state) || !event.reason.trim()) invalid(current, event);
      return { ...next, state: "recheck-required", retrySlot: undefined };
    case "source-drift-before-remediation":
      if (!["review-failed", "remediation-intended"].includes(current.state) || !event.reason.trim()) invalid(current, event);
      return { ...next, state: "recheck-required", retrySlot: undefined };
    case "operator-menu":
      if (!["idle", "source-frozen", "review-ready", "turn-intended", "turn-uncertain", "review-failed", "remediation-uncertain", "recheck-required"].includes(current.state)) invalid(current, event);
      return { ...next, state: "operator-menu", retrySlot: undefined };
    case "review-passed":
      if (current.state !== "turn-intended") invalid(current, event);
      return { ...next, state: "passed", retrySlot: undefined, openReportDigests: [], passCertificateId: event.passCertificateId };
    case "waived":
      if (current.state !== "operator-menu" && current.state !== "review-failed") invalid(current, event);
      return { ...next, state: "waived", openReportDigests: [] };
    case "pass-invalidated":
      if (current.state !== "passed" || !event.reason.trim()) invalid(current, event);
      return { ...next, state: "operator-menu", retrySlot: undefined, passCertificateId: undefined };
    case "finalization-started":
      if (current.state !== "passed" && current.state !== "waived") invalid(current, event);
      return { ...next, state: "finalizing" };
    case "finalization-invalidated":
      if (current.state !== "finalizing" || !event.reason.trim()) invalid(current, event);
      return { ...next, state: "operator-menu", retrySlot: undefined, passCertificateId: undefined };
    case "completed":
      if (current.state !== "finalizing") invalid(current, event);
      return { ...next, state: "completed" };
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function qaDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(`rafi.qa.v2\0${domain}\0`).update(canonicalJson(value)).digest("hex");
}

export function createQaFindingRefs(input: { runId: string; ticketId: string; reviewAttemptId: string; reportDigest: string; rawFindingIds: string[] }): QaFindingRefV2[] {
  return input.rawFindingIds.map((rawId, ordinal) => {
    const identity = { runId: input.runId, ticketId: input.ticketId, reviewAttemptId: input.reviewAttemptId, reportDigest: input.reportDigest, ordinal, rawId };
    return { version: 2, findingKey: qaDigest("qa-finding-ref", identity), reportDigest: input.reportDigest, reviewAttemptId: input.reviewAttemptId, ordinal, rawId };
  });
}

export const QA_REPORT_CORRECTION_POLICY = Object.freeze({
  initialSlot: "initial",
  sameSessionCorrectionSlots: Object.freeze(["correction-1"]),
  automaticFreshReconstruction: false,
  operatorFreshReconstruction: false,
});

function invalid(state: QaReducerStateV2, event: QaReducerEventV2): never {
  throw new Error(`invalid QA V2 transition ${state.state} -> ${event.type}`);
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
