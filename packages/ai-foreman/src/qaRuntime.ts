import type { ResolvedAgentSettings } from "rafi-spec";
import type { BuilderAdapter } from "./adapters/types.js";
import { readOnlyPermissionConfig } from "./agentRun.js";
import { qaDigest, type HandoffAcceptanceReceiptV2 } from "./qaProtocolV2.js";
import type { QaSessionBoundaryResult, QaSessionHandle } from "./qaReview.js";

/** Captured once, from the same inputs used to construct the provider adapter. */
export interface QaRuntimeMetadata {
  settings: ResolvedAgentSettings;
  effectiveRoleInstructions: string;
  skills: QaSessionHandle["skills"];
}

export function frozenQaRuntimeSettings(adapter: BuilderAdapter, metadata: QaRuntimeMetadata | undefined): ResolvedAgentSettings {
  if (!metadata) throw new Error("QA adapter has no frozen runtime/role/skill dispatch receipt");
  if (metadata.settings.role !== "qa" || metadata.settings.make !== adapter.agent) throw new Error("QA adapter does not match its frozen runtime settings");
  return structuredClone(metadata.settings);
}

export function describeQaRuntimeHandle(adapter: BuilderAdapter, metadata: QaRuntimeMetadata | undefined, handoffReceipt: QaSessionHandle["handoffReceipt"]): QaSessionHandle {
  const settings = frozenQaRuntimeSettings(adapter, metadata);
  // `settingSources` is a Claude Agent SDK control. Claude read-only sessions
  // need the machine owner's authentication settings; Codex does not receive
  // that SDK option.
  const settingsSources = adapter.agent === "claude" ? "user" as const : "none" as const;
  const confinementPolicy = { sandboxMode: "read-only", settingsSources, permissions: readOnlyPermissionConfig(), dependencyProjection: "read-only-symlink", scratch: "sibling-temp-directory" };
  const confinementBase = {
    version: 2 as const, sourceMode: "read-only" as const, scratchMode: "isolated" as const,
    settingsSources, networkMode: "provider-required" as const,
    environmentDigest: qaDigest("qa-confinement-environment", { runtime: settings.make, model: settings.model, reasoning: settings.reasoning, fast: settings.fast, platform: process.platform, arch: process.arch }),
    policyDigest: qaDigest("qa-confinement-policy", confinementPolicy),
  };
  return {
    adapter,
    sessionIdentity: () => {
      const ref = adapter.sessionRef?.();
      if (!ref) throw new Error("QA session has no scoped provider identity");
      return ref;
    },
    effectiveRoleInstructions: metadata!.effectiveRoleInstructions,
    runtimeContext: settings,
    skills: structuredClone(metadata!.skills),
    confinement: { ...confinementBase, digest: qaDigest("qa-confinement", confinementBase) },
    handoffReceipt,
  };
}

/** Construct and retain the receipt against the actual accepted successor. */
export function acceptQaRuntimeHandoff(handle: QaSessionHandle, createReceipt: (confinementDigest: string) => HandoffAcceptanceReceiptV2): QaSessionBoundaryResult {
  const receipt = createReceipt(handle.confinement.digest);
  const successor = handle.sessionIdentity();
  if (receipt.confinementDigest !== handle.confinement.digest || receipt.successor.provider !== successor.provider
    || receipt.successor.sessionId !== successor.sessionId || receipt.successor.generation !== successor.generation
    || receipt.successor.cwd !== successor.cwd || receipt.successor.configRoot !== successor.configRoot) {
    throw new Error("QA acceptance receipt does not match the actual successor handle");
  }
  return { handle: { ...handle, handoffReceipt: { kind: "accepted", receipt } }, receipt };
}
