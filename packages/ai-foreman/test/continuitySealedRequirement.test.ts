import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { structuredDigest, workReportOutput, type ContinuityDelta, type ProviderSessionRefV1, type ResolvedAgentSettings } from "rafi-spec";
import type { BuilderAdapter, BuilderEvent, TurnRequest, TurnResult } from "../src/adapters/types.js";
import { CONTINUITY_REQUIRED_INSTRUCTION, ContinuityAdapter } from "../src/continuity.js";
import { graphContext, sendGraphTurn } from "../src/graph/turn.js";
import { nativePolicy, structuredTurnErrorMessage } from "../src/structuredOperation.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { RoleStatusAdapter } from "../src/statusReporter.js";
import { nativeFixtureTurn } from "./helpers/nativeOutput.js";

const DELTA: ContinuityDelta = { version: 1, decisions: [], constraints: [], discoveries: [], completedActions: [], evidence: [], failures: [], blockers: [], openWork: [], nextAction: "continue" };
const SETTINGS: ResolvedAgentSettings = {
  role: "builder", source: "project", make: "claude", model: "default", reasoning: "default", fast: false,
  session_strategy: "compact", settings_revision: 1, display_session_cost: false, auto_compact_threshold_percent: 50, compact_maximum: 1,
};
const PAYLOAD = { disposition: "already-satisfied", evidence: ["fixture"], coverage: null, graphMaintenance: null };

/** Provider fake: records what actually reached transport and answers with the given continuity. */
class Provider implements BuilderAdapter {
  readonly agent = "claude" as const;
  readonly sent: Array<{ text: string; policy?: TurnRequest }> = [];
  constructor(readonly root: string, private readonly continuity: () => unknown) {}
  async sendTurn(text: string, policy?: TurnRequest): Promise<TurnResult> {
    this.sent.push({ text, policy });
    return { ...nativeFixtureTurn(policy, "session-1", PAYLOAD, "claude", undefined, this.continuity()), text: JSON.stringify({ steps: [] }) };
  }
  sessionId(): string { return "session-1"; }
  sessionRef(): ProviderSessionRefV1 {
    return { version: 1, provider: "claude", sessionId: "session-1", role: "builder", stream: "builder", generation: 0, cwd: this.root, configRoot: this.root,
      workspaceIdentity: "workspace", source: "observed", createdAt: "2026-01-01T00:00:00.000Z", validatedAt: "2026-01-01T00:00:00.000Z" };
  }
  async prepareSession(): Promise<ProviderSessionRefV1> { return this.sessionRef(); }
  async *events(): AsyncIterable<BuilderEvent> {}
  async close(): Promise<void> {}
}

function setup(continuity: () => unknown, decorate = false) {
  const root = mkdtempSync(join(tmpdir(), "rafi-sealed-continuity-"));
  const provider = new Provider(root, continuity);
  const continuous = new ContinuityAdapter({ adapter: provider, projectDir: root, runId: "run", role: "builder", settings: SETTINGS });
  const adapter: BuilderAdapter = decorate ? new RoleStatusAdapter(continuous, () => {}, () => {}) : continuous;
  const send = (instruction: string) => sendGraphTurn(adapter, instruction, graphContext(root, root, "build-preflight", instruction), nativePolicy(workReportOutput, { purpose: "planning", journalRunId: "run" }));
  return { root, provider, continuous, send };
}

for (const decorate of [false, true]) test(`graph dispatch seals the continuity requirement into the provider instruction${decorate ? " (decorated)" : ""}`, async () => {
  const { root, provider, continuous, send } = setup(() => DELTA, decorate);
  try {
    const result = await send("plan the work");
    assert.equal(result.isError, false, structuredTurnErrorMessage(result));
    assert.deepEqual(result.continuity, DELTA);
    assert.equal(provider.sent.length, 1);
    const { text, policy } = provider.sent[0]!;
    assert.equal(text.split(CONTINUITY_REQUIRED_INSTRUCTION).length - 1, 1, "requirement is present exactly once");
    // The requirement is part of the sealed tuple's rendered instruction, not appended after sealing.
    assert.equal(structuredDigest(text), policy?.selectedDispatch?.instructionDigest);
    const db = new WorkflowDb(root);
    try {
      assert.equal(db.pendingStructuredPostprocessing("run").length, 0);
      assert.equal(db.continuityHead("run", "builder")?.state, "current");
    } finally { db.close(); }
    // A second dispatch is admitted and still carries the requirement once.
    const second = await send("revise the plan");
    assert.equal(second.isError, false, structuredTurnErrorMessage(second));
    assert.equal(provider.sent[1]!.text.split(CONTINUITY_REQUIRED_INSTRUCTION).length - 1, 1);
  } finally { await continuous.close(); }
});

test("null continuity is rejected before confirmation and never leaves pending postprocessing", async () => {
  const { root, continuous, send } = setup(() => null);
  try {
    const result = await send("plan the work");
    assert.equal(result.isError, true);
    assert.equal(result.structured?.state, "rejected");
    if (result.structured?.state === "rejected") {
      assert.equal(result.structured.reason, "invalid-contract");
      assert.match(result.structured.detail, /continuity delta: delta must be an object/);
    }
    const message = structuredTurnErrorMessage(result, "Build preflight");
    assert.match(message, /^Build preflight was rejected \(invalid-contract\): .*continuity/);
    assert.doesNotMatch(message, /"steps"/, "the response body is not reported as the error");
    const db = new WorkflowDb(root);
    try {
      const dispatchId = result.selectedDispatch!.dispatchId;
      assert.notEqual(db.operation(dispatchId)?.status, "confirmed");
      assert.equal(db.pendingStructuredPostprocessing("run").length, 0);
    } finally { db.close(); }
  } finally { await continuous.close(); }
});

test("turn error message prefers retained continuity failure over successful response text", () => {
  const turn = { text: '{"steps":[{"ticket":"T1","work":"x"}]}', isError: true, numTurns: 1, costUsd: 0, continuityErrors: ["Error: invalid continuity delta: delta must be an object"] } as TurnResult;
  assert.equal(structuredTurnErrorMessage(turn, "Build preflight"), "Build preflight failed continuity postprocessing: Error: invalid continuity delta: delta must be an object");
  assert.equal(structuredTurnErrorMessage({ text: "plain failure", isError: true, numTurns: 1, costUsd: 0 } as TurnResult), "plain failure");
});
