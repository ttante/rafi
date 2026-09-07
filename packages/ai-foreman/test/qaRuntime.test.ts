import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderSessionRefV1, ResolvedAgentSettings } from "rafi-spec";
import type { BuilderAdapter } from "../src/adapters/types.js";
import { acceptQaRuntimeHandoff, describeQaRuntimeHandle, frozenQaRuntimeSettings, type QaRuntimeMetadata } from "../src/qaRuntime.js";
import { qaDigest, type HandoffAcceptanceReceiptV2, type ProviderSessionRefV2 } from "../src/qaProtocolV2.js";

const SETTINGS: ResolvedAgentSettings = {
  role: "qa", source: "project", make: "codex", model: "original-model", reasoning: "default", fast: false,
  session_strategy: "fresh", settings_revision: 1, display_session_cost: false,
  auto_compact_threshold_percent: 50, compact_maximum: 2,
};

function adapter(provider: "claude" | "codex", id: string, generation: number): BuilderAdapter {
  const ref: ProviderSessionRefV1 = {
    version: 1, provider, sessionId: id, generation, role: "qa", stream: "qa", cwd: `/review/${id}`,
    configRoot: "/project", workspaceIdentity: id, source: "observed",
    createdAt: "2026-01-01T00:00:00.000Z", validatedAt: "2026-01-01T00:00:00.000Z",
  };
  return { agent: provider, sessionId: () => id, sessionRef: () => ref,
    sendTurn: async () => { throw new Error("unexpected provider turn"); }, async *events() {}, close: async () => {} };
}

function metadata(settings: ResolvedAgentSettings): QaRuntimeMetadata {
  return { settings: structuredClone(settings), effectiveRoleInstructions: "Exact QA role instructions", skills: [] };
}

function v2(ref: ProviderSessionRefV1): ProviderSessionRefV2 {
  return { version: 2, provider: ref.provider, sessionId: ref.sessionId, generation: ref.generation,
    role: "qa", stream: "qa", cwd: ref.cwd, configRoot: ref.configRoot,
    createdAt: ref.createdAt, validatedAt: ref.validatedAt! };
}

function receipt(predecessor: BuilderAdapter, successor: BuilderAdapter, confinementDigest: string): HandoffAcceptanceReceiptV2 {
  const body = {
    version: 2 as const, runId: "run", ticketId: "T1", qaRevision: 7,
    sourceStateDigest: "1".repeat(64), predecessorSourceStateDigest: "2".repeat(64), reviewBasisDigest: "3".repeat(64),
    requiresFullReview: true, confinementDigest, predecessor: v2(predecessor.sessionRef!()!), successor: v2(successor.sessionRef!()!),
    manifestDigest: "4".repeat(64), continuityCheckpointDigest: "5".repeat(64), acceptanceCheckpointDigest: "6".repeat(64),
    packetDigest: "7".repeat(64), inventoryDigest: qaDigest("handoff-inventory", []), resources: [], acceptedAt: "2026-01-01T00:00:01.000Z",
  };
  return { ...body, operationId: qaDigest("qa-handoff-operation", body) };
}

test("QA decoration settings use the actual frozen provider configuration and cannot mutate it", () => {
  const actual: ResolvedAgentSettings = { ...SETTINGS, make: "claude", model: "accepted-model", reasoning: "high", fast: true, settings_revision: 9, display_session_cost: true };
  const active = adapter("claude", "accepted", 2);
  const frozen = metadata(actual);
  const displayed = frozenQaRuntimeSettings(active, frozen);
  const handle = describeQaRuntimeHandle(active, frozen, { kind: "initial" });
  assert.deepEqual(displayed, actual);
  assert.deepEqual(handle.runtimeContext, actual);
  displayed.model = "later-change";
  assert.equal(frozen.settings.model, "accepted-model");
  assert.equal((handle.runtimeContext as ResolvedAgentSettings).model, "accepted-model");
  assert.throws(() => frozenQaRuntimeSettings(active, metadata(SETTINGS)), /does not match/);
  assert.throws(() => frozenQaRuntimeSettings(active, undefined), /no frozen/);
});

for (const runtime of ["claude", "codex"] as const) {
  test(`QA handoff to ${runtime} binds the successor's accepted settings and confinement`, () => {
    const predecessor = adapter("codex", "old", 0);
    const successor = adapter(runtime, "new", 1);
    const prior = describeQaRuntimeHandle(predecessor, metadata(SETTINGS), { kind: "initial" });
    const successorSettings: ResolvedAgentSettings = { ...SETTINGS, make: runtime, model: "accepted-model", reasoning: "high", fast: true, settings_revision: 4 };
    const next = describeQaRuntimeHandle(successor, metadata(successorSettings), { kind: "initial" });
    assert.notEqual(next.confinement.digest, prior.confinement.digest);
    let suppliedConfinement: string | undefined;
    const accepted = acceptQaRuntimeHandoff(next, (digest) => {
      suppliedConfinement = digest;
      return receipt(predecessor, successor, digest);
    });
    assert.equal(suppliedConfinement, next.confinement.digest);
    assert.equal(accepted.receipt.confinementDigest, accepted.handle.confinement.digest);
    assert.equal(accepted.handle.adapter, successor);
    assert.deepEqual(accepted.handle.runtimeContext, successorSettings);
    assert.deepEqual(accepted.handle.handoffReceipt, { kind: "accepted", receipt: accepted.receipt });
    assert.throws(() => acceptQaRuntimeHandoff(next, () => receipt(predecessor, successor, prior.confinement.digest)), /does not match the actual successor/);
    assert.throws(() => acceptQaRuntimeHandoff(next, (digest) => receipt(predecessor, predecessor, digest)), /does not match the actual successor/);
  });
}
