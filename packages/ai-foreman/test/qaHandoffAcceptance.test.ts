import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContinuityDelta, ProviderSessionRefV1 } from "rafi-spec";
import type { BuilderAdapter, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import { HANDOFF_ACCEPTED, HandoffAcceptanceError, HandoffService } from "../src/handoffs.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";

const delta: ContinuityDelta = { version: 1, decisions: [], constraints: [], discoveries: [], completedActions: [], evidence: [], failures: [], blockers: [], openWork: ["review"], nextAction: "review" };
const acceptedText = `${HANDOFF_ACCEPTED}\nRAFI_CONTINUITY_DELTA: ${JSON.stringify(delta)}`;

class Successor implements BuilderAdapter {
  readonly agent = "codex" as const;
  readonly queue = new AsyncQueue<BuilderEvent>();
  calls = 0;
  closed = false;
  ref: ProviderSessionRefV1;
  constructor(projectDir: string, readonly mode: "ok" | "error" | "mismatch" | "missing-terminal") {
    this.ref = { version: 1, provider: "codex", sessionId: "successor", role: "qa", stream: "qa", generation: 0,
      cwd: projectDir, configRoot: projectDir, source: "observed", createdAt: new Date(0).toISOString(), validatedAt: new Date(0).toISOString() };
  }
  async sendTurn(instruction: string): Promise<TurnResult> {
    this.calls++;
    const reported = this.mode === "mismatch" ? { ...this.ref, sessionId: "different-session" } : this.ref;
    const result: TurnResult = { text: acceptedText, isError: this.mode === "error", numTurns: 1, costUsd: 0,
      turnId: `turn-${this.calls}`, hostInstruction: instruction, providerInstruction: instruction, rawResponse: acceptedText,
      providerMetadata: { provider: this.agent, sessionId: reported.sessionId, sessionRef: reported } };
    if (this.mode !== "missing-terminal") this.queue.push({ kind: "turn-complete", result, turnId: result.turnId });
    else this.queue.close();
    return result;
  }
  sessionId(): string { return this.ref.sessionId; }
  sessionRef(): ProviderSessionRefV1 { return this.ref; }
  adoptSessionRef(ref: ProviderSessionRefV1): void { this.ref = ref; }
  events(): AsyncIterable<BuilderEvent> { return this.queue; }
  async close(): Promise<void> { this.closed = true; this.queue.close(); }
}

for (const [mode, code] of [["error", "provider-turn-failed"], ["mismatch", "successor-identity-mismatch"], ["missing-terminal", "missing-terminal-event"]] as const) {
  test(`QA handoff rejects ${mode} despite a well-formed acknowledgement`, async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "qa-handoff-validation-"));
    try {
      const db = new WorkflowDb(projectDir);
      db.ensureRun("run");
      db.appendContinuityEvent({ runId: "run", role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1 });
      db.publishContinuityCheckpoint({ runId: "run", role: "qa", delta, authoritativeStateRevision: 1 });
      db.claimInitialRoleLease("run", "qa", "predecessor");
      db.close();
      const service = new HandoffService(projectDir);
      const staged = service.stage({ runId: "run", role: "qa", reason: "recover QA", predecessorSessionId: "predecessor", compactionCount: 0, compactMaximum: 10 });
      const successor = new Successor(projectDir, mode);
      await assert.rejects(service.acceptStaged(staged, successor), (error: unknown) => error instanceof HandoffAcceptanceError && error.code === code);
      assert.equal(successor.calls, 1);
      assert.equal(successor.closed, true);
      const after = new WorkflowDb(projectDir);
      try {
        assert.equal(after.roleMutationLease("run", "qa")?.providerSessionId, "predecessor");
        assert.equal(after.handoff("run", staged.manifest.generation)?.state, "failed");
        assert.ok(after.continuityEvents("run").some((event) => event.kind === "handoff_acceptance_observed"));
      } finally { after.close(); }
    } finally { rmSync(projectDir, { recursive: true, force: true }); }
  });
}

test("validated QA handoff returns the active successor with its event stream usable", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "qa-handoff-complete-"));
  try {
    const db = new WorkflowDb(projectDir);
    db.ensureRun("run");
    db.appendContinuityEvent({ runId: "run", role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1 });
    db.publishContinuityCheckpoint({ runId: "run", role: "qa", delta, authoritativeStateRevision: 1 });
    db.close();
    const successor = new Successor(projectDir, "ok");
    const transfer = await new HandoffService(projectDir).transfer({ runId: "run", role: "qa", reason: "recover QA", compactionCount: 0, compactMaximum: 10 }, async () => successor);
    assert.equal(transfer.acceptanceReceipt?.successorSessionRef.sessionId, "successor");
    assert.equal(successor.closed, false);
    const next = await successor.sendTurn("next review");
    const event = await successor.events()[Symbol.asyncIterator]().next();
    assert.equal(event.value?.kind, "turn-complete");
    if (event.value?.kind === "turn-complete") assert.equal(event.value.turnId, next.turnId);
    await successor.close();
  } finally { rmSync(projectDir, { recursive: true, force: true }); }
});
