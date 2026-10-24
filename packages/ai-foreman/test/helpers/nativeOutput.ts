import type { BuilderAdapter, TurnRequest, TurnResult } from "../../src/adapters/types.js";
import { structuredReceipt } from "../../src/adapters/structured.js";
import { providerOutputSchema, providerWireContract, renderProviderWireInstruction, selectedDispatchTupleV2, structuredDigest } from "rafi-spec";

/** Encode canonical test data only for an explicitly requested compatibility fixture. */
export function codexWireFixture(schema: Record<string, any>, value: any, root = schema): any {
  if (schema.$ref) return codexWireFixture(schema.$ref.slice(2).split("/").reduce((node: any, key: string) => node[key.replaceAll("~1", "/").replaceAll("~0", "~")], root), value, root);
  const branches: Record<string, any>[] | undefined = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const branch = branches.find(branch => {
      if (branch.type === "null") return value === null;
      if (value === null) return branch.const === null || branch.enum?.includes(null);
      if (branch.type === "object") return typeof value === "object" && !Array.isArray(value) && Object.entries(branch.properties ?? {}).every(([key, item]) => {
        const field = item as any;
        return field.const === undefined && !field.enum || field.const === value[key] || field.enum?.includes(value[key]);
      });
      if (branch.type === "array") return Array.isArray(value) || Boolean(branch.items?.properties?.key && typeof value === "object");
      return !branch.type || branch.type === typeof value;
    });
    return branch ? codexWireFixture(branch, value, root) : value;
  }
  if (schema.type === "array" && schema.items?.properties?.key && value && !Array.isArray(value) && typeof value === "object") return Object.entries(value).map(([key, item]) => ({ key, value: codexWireFixture(schema.items.properties.value, item, root) }));
  if (schema.type === "object" && schema.properties && value && typeof value === "object") return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, value[key] === undefined ? null : codexWireFixture(child as any, value[key], root)]));
  if (Array.isArray(value) && schema.items) return value.map(item => codexWireFixture(schema.items, item, root));
  return value;
}

/**
 * Raw provider fixtures are never normalized, completed, or repaired. Use
 * this for captures and malformed-output tests.
 */
export function rawProviderFixtureTurn(policy: TurnRequest | undefined, sessionId: string, wire: unknown, provider: "claude" | "codex" = "claude"): TurnResult {
  if (!policy?.output || !policy.dispatchId) throw new Error("Fixture requires a selected native contract and dispatch identity");
  const selected = policy.wireContract ?? providerWireContract(policy.output, provider);
  const tuple = policy.selectedDispatch ?? selectedDispatchTupleV2({
    operation: policy.output.operation, schemaVersion: policy.output.schemaVersion, schemaDigest: policy.output.schemaDigest,
    provider, profile: selected.profile, variant: selected.variant, descriptorDigest: selected.descriptorDigest,
    wireSchemaDigest: selected.wireSchemaDigest, guidanceDigest: selected.guidanceDigest, normalizerId: selected.normalizerId,
    normalizerVersion: selected.normalizerVersion, maximumSchemaBytes: selected.maximumSchemaBytes,
    maximumResponseBytes: selected.maximumResponseBytes, maximumPageBytes: selected.maximumPageBytes ?? null,
    instructionDigest: structuredDigest(renderProviderWireInstruction("fixture", selected)), actionId: policy.logicalActionId ?? policy.dispatchId,
    dispatchId: policy.dispatchId, sessionId, generation: 0,
  });
  return { text: "Presentation only", isError: false, numTurns: 1, costUsd: 0, turnId: policy.dispatchId, selectedDispatch: tuple,
    structured: structuredReceipt(policy.output, provider, wire, { dispatchId: policy.dispatchId, sessionId, nativeTurnId: `native-${policy.dispatchId}` }, "decoded-json", selected, tuple) };
}

/** Build an intentionally conforming canonical-envelope fixture. Never use for a raw provider capture. */
export function canonicalFixtureTurn(policy: TurnRequest | undefined, sessionId: string, payload: unknown, provider: "claude" | "codex" = "claude", alternative?: unknown, continuity: unknown = null): TurnResult {
  if (!policy?.output || !policy.dispatchId) throw new Error("Fixture requires a selected native contract and dispatch identity");
  const value = { version: 1, operation: policy.output.operation, result: alternative ?? { kind: "completed", summary: "Fixture result", payload }, continuity };
  const selected = policy.wireContract ?? providerWireContract(policy.output, provider);
  const wire = provider === "codex" ? codexWireFixture(providerOutputSchema(policy.output, provider).schema, value) : value;
  return rawProviderFixtureTurn(policy, sessionId, wire, provider);
}

/** @deprecated Use canonicalFixtureTurn or rawProviderFixtureTurn explicitly. */
export const nativeFixtureTurn = canonicalFixtureTurn;

/** Explicit work scenario data, independent of presentation text and marker parsers. */
export function workFixtureTurn(policy: TurnRequest | undefined, sessionId: string, provider: "claude" | "codex" = "codex", alternative?: unknown, continuity: unknown = null): TurnResult {
  const payload = policy?.output?.operation === "session-initialization" ? { ready: true }
    : { disposition: "modified", evidence: ["Fixture source inspection"], coverage: null, graphMaintenance: null };
  return canonicalFixtureTurn(policy, sessionId, payload, provider, alternative, continuity);
}

/** Fixture setup prepares a stable scoped identity before the production gateway is exercised. */
export function prepareFixtureAdapter<T extends BuilderAdapter>(adapter: T, cwd: string): T {
  if (adapter.prepareSession) return adapter;
  const id = adapter.sessionId();
  if (!adapter.sessionRef?.() && id) {
    const ref = { version: 1 as const, provider: adapter.agent, sessionId: id, role: "builder" as const, stream: "builder", generation: 0,
      cwd, configRoot: cwd, source: "observed" as const, createdAt: new Date(0).toISOString(), validatedAt: new Date(0).toISOString() };
    if (adapter.adoptSessionRef) adapter.adoptSessionRef(ref);
    else adapter.sessionRef = () => ref;
  }
  adapter.prepareSession = async () => {
    const ref = adapter.sessionRef?.();
    if (!ref) throw new Error("Test adapter has no prepared scoped session");
    return ref;
  };
  return adapter;
}

export interface NativeFixtureReply { text: string; result: unknown; continuity?: unknown }
export function passedQaReply(summary: string): NativeFixtureReply {
  return { text: summary, result: { kind: "completed", summary, payload: { kind: "passed", coverage: null, verifiedInstructionIds: [] } } };
}
export function failedQaReply(report: unknown, summary = "Fixture review failed"): NativeFixtureReply {
  return { text: summary, result: { kind: "completed", summary, payload: { kind: "failed", report, coverage: null, verifiedInstructionIds: [] } } };
}
export function recoveryQaReply(instruction: string): NativeFixtureReply {
  return { text: "Recovery resources acknowledged", result: { kind: "completed", summary: "Acknowledged", payload: {
    packet: /Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1], reviewed_state: /Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1], required_resources_read: "all",
  } } };
}
export function fixtureReplyTurn(policy: TurnRequest | undefined, sessionId: string, reply: string | NativeFixtureReply, provider: "claude" | "codex" = "codex"): TurnResult {
  if (policy?.output?.operation === "session-initialization") return canonicalFixtureTurn(policy, sessionId, { ready: true }, provider);
  if (typeof reply === "string") return { ...rawProviderFixtureTurn(policy, sessionId, reply, provider), text: reply, rawResponse: reply };
  return { ...canonicalFixtureTurn(policy, sessionId, undefined, provider, reply.result, reply.continuity ?? null), text: reply.text, rawResponse: reply.text };
}
