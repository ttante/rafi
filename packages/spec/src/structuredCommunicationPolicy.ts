import { structuredCommunicationControlSitesV2 } from "./structuredCommunicationSites.js";
/**
 * Product decisions that bound structured-communication v2.  They live in
 * spec so page-ledger, manifest, runtime, and release tooling share exactly
 * the same values rather than silently growing independent defaults.
 */
export interface TicketPagingLimitsV2 {
  readonly maximumPagesPerArtifact: number;
  readonly maximumTicketsPerPage: number;
  readonly maximumCanonicalPageBytes: number;
  readonly maximumCanonicalAggregateBytes: number;
}

export interface LiveStructuredValidationConfigurationV2 {
  readonly credentialScope: string;
  readonly retainedLogDirectory: string;
}

/**
 * A provider control is transport maintenance, never workflow authority.  It
 * is deliberately not an OutputContract: callers must not reinterpret a
 * control response as a structured business result.
 */
export interface ProviderControlOperationV2 {
  readonly provider: "claude" | "codex";
  readonly command: string;
  readonly purpose: "session-initialization" | "context-inspection" | "context-compaction" | "model-selection" | "transport-settings";
  readonly completion: "provider-acknowledgement" | "zero-model-turn" | "context-transition";
  readonly workflowAuthority: false;
  readonly callSites: readonly string[];
}

const providerControls = Object.freeze([
  Object.freeze({ provider: "claude" as const, command: "/context", purpose: "session-initialization" as const, completion: "zero-model-turn" as const, workflowAuthority: false as const }),
  Object.freeze({ provider: "claude" as const, command: "/compact", purpose: "context-compaction" as const, completion: "context-transition" as const, workflowAuthority: false as const }),
  Object.freeze({ provider: "claude" as const, command: "/model", purpose: "model-selection" as const, completion: "provider-acknowledgement" as const, workflowAuthority: false as const }),
  Object.freeze({ provider: "claude" as const, command: "applyFlagSettings", purpose: "transport-settings" as const, completion: "provider-acknowledgement" as const, workflowAuthority: false as const }),
  Object.freeze({ provider: "claude" as const, command: "getContextUsage", purpose: "context-inspection" as const, completion: "provider-acknowledgement" as const, workflowAuthority: false as const }),
  Object.freeze({ provider: "codex" as const, command: "thread/compact/start", purpose: "context-compaction" as const, completion: "context-transition" as const, workflowAuthority: false as const }),
].map(control => Object.freeze({ ...control,
  callSites: Object.freeze([...(structuredCommunicationControlSitesV2[`${control.provider}/${control.command}`] ?? [])]),
})) satisfies readonly ProviderControlOperationV2[]);

export function providerControlOperationV2(provider: ProviderControlOperationV2["provider"], command: string): ProviderControlOperationV2 {
  const control = providerControls.find(entry => entry.provider === provider && entry.command === command);
  if (!control) throw new Error(`Unregistered provider control operation: ${provider}/${command}`);
  return control;
}

export function providerControlOperationsV2(): readonly ProviderControlOperationV2[] {
  return providerControls;
}

const ticketPaging = Object.freeze({
  maximumPagesPerArtifact: 60,
  maximumTicketsPerPage: 150,
  maximumCanonicalPageBytes: 750 * 1024,
  maximumCanonicalAggregateBytes: 6 * 1024 * 1024,
}) satisfies TicketPagingLimitsV2;

export const structuredCommunicationPolicyV2 = Object.freeze({
  protocolVersion: 2 as const,
  ticketPaging,
  intermediateRequestExceptions: Object.freeze([
    "graph-request",
    "source-request",
    "evidence-request",
    "handoff-request",
  ] as const),
  liveValidation: Object.freeze({
    maximumSpendUsd: null,
    requireAuthoritativeCost: false,
    strictMaximumSpendUsd: 5,
    maximumElapsedMs: 30 * 60 * 1000,
    /**
     * Live validation is intentionally not runnable until the release owner
     * supplies both values.  A missing value is not a permissive default.
     */
    credentialScope: null as string | null,
    retainedLogDirectory: null as string | null,
  }),
});

export type StructuredIntermediateRequestException =
  (typeof structuredCommunicationPolicyV2.intermediateRequestExceptions)[number];

/** The closed v2 intermediate-result surface. Evidence is one kind with a typed subject. */
export type IntermediateResultV2 =
  | { readonly kind: "graph-request" }
  | { readonly kind: "source-request" }
  | { readonly kind: "handoff-request" }
  | { readonly kind: "evidence-request"; readonly evidenceType: "run" | "qa" | "graph" };

export function assertIntermediateResultV2(value: unknown): asserts value is IntermediateResultV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Structured intermediate result must be an object");
  const result = value as Record<string, unknown>;
  // An intermediate request is itself the provider result.  Accepting a
  // nested `result`/`payload` envelope would let a terminal response smuggle
  // an otherwise-valid request shape through the exception path.
  if ("result" in result || "payload" in result || typeof result.kind !== "string") {
    throw new Error("Structured intermediate result cannot be a terminal envelope");
  }
  if (result.kind === "evidence-request") {
    if (result.evidenceType === "run" || result.evidenceType === "qa" || result.evidenceType === "graph") return;
    throw new Error("Structured evidence-request requires a supported evidenceType");
  }
  if (result.kind === "graph-request" || result.kind === "source-request" || result.kind === "handoff-request") return;
  throw new Error(`Unapproved structured intermediate request: ${result.kind}`);
}

/**
 * Page-ledger constructors must accept this value explicitly.  Keeping the
 * validation here prevents a later caller from silently treating zero, NaN,
 * or an aggregate smaller than one page as a safe default.
 */
export function validateTicketPagingLimitsV2(limits: TicketPagingLimitsV2): TicketPagingLimitsV2 {
  const values = Object.values(limits);
  if (values.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error("Ticket paging limits must be positive safe integers");
  }
  if (limits.maximumCanonicalAggregateBytes < limits.maximumCanonicalPageBytes) {
    throw new Error("Ticket paging aggregate byte limit cannot be smaller than a page");
  }
  return Object.freeze({ ...limits });
}

/** Reject newly introduced request-shaped results until product policy names them. */
export function assertStructuredIntermediateRequestAllowed(kind: string): void {
  if (!kind.endsWith("-request")) return;
  if (!(structuredCommunicationPolicyV2.intermediateRequestExceptions as readonly string[]).includes(kind)) {
    throw new Error(`Unapproved structured intermediate request: ${kind}`);
  }
}

export function assertLiveStructuredValidationConfigured(policy = structuredCommunicationPolicyV2): asserts policy is typeof structuredCommunicationPolicyV2 & {
  liveValidation: { credentialScope: string; retainedLogDirectory: string };
} {
  if (!policy.liveValidation.credentialScope || !policy.liveValidation.retainedLogDirectory) {
    throw new Error("Live structured validation is not configured with credential scope and retained-log directory");
  }
}

export function resolveLiveStructuredValidationConfigurationV2(input: {
  credentialScope?: string | null;
  retainedLogDirectory?: string | null;
}): LiveStructuredValidationConfigurationV2 {
  const credentialScope = input.credentialScope?.trim();
  const retainedLogDirectory = input.retainedLogDirectory?.trim();
  if (!credentialScope || !retainedLogDirectory) {
    throw new Error("Live structured validation requires an explicit credential scope and retained-log directory");
  }
  return Object.freeze({ credentialScope, retainedLogDirectory });
}
