import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDb } from "../src/workflowDb.js";
import { RoleSessionController } from "../src/sessionLifecycle.js";
import type { BuilderAdapter, BuilderEvent, CompactResult, TurnResult } from "../src/adapters/types.js";

class FakeAdapter implements BuilderAdapter {
  readonly agent = "codex" as const; compactCalls = 0; switchCalls = 0; closed = false;
  constructor(private readonly id: string | undefined, private readonly compactResults: CompactResult[] = [{ ok: true }], private readonly switchResult: CompactResult = { ok: true }) {}
  async sendTurn(): Promise<TurnResult> { return { text: "", isError: false, numTurns: 1, costUsd: 0 }; }
  sessionId(): string | undefined { return this.id; }
  async compact(): Promise<CompactResult> { return this.compactResults[this.compactCalls++] ?? { ok: true }; }
  async switchSettings(): Promise<CompactResult> { this.switchCalls += 1; return this.switchResult; }
  async contextUsage() { return { used: 10, maximum: 100, percentage: 10 }; }
  async *events(): AsyncIterable<BuilderEvent> {}
  async close() { this.closed = true; }
}

test("workflow DB updates snapshots and append-only events in the same lifecycle", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-workflow-")); const db = new WorkflowDb(root);
  const run = db.createRun({ kind: "build", originalWork: { tickets: ["T1", "T2"] } });
  db.transition(run.runId, { checkpoint: "builder-after", remainingWork: { tickets: ["T2"] }, event: "builder_complete" });
  db.planOperation({ runId: run.runId, idempotencyKey: `${run.runId}:push:x`, kind: "push", intent: { branch: "x" } });
  db.updateOperation(`${run.runId}:push:x`, "uncertain", { error: "network" });
  assert.equal(db.getRun(run.runId)?.checkpoint, "builder-after"); assert.deepEqual(db.events(run.runId).map((event) => event.type), ["run_created", "builder_complete"]);
  assert.equal(db.operations(run.runId)[0]?.status, "uncertain"); db.close();
});

test("live settings attempt same-provider continuation and fall back fresh on a rejected switch", async () => {
  const created: FakeAdapter[] = []; let generation = 0;
  const settings = { role: "builder" as const, make: "codex" as const, model: "old", reasoning: "high", fast: false, session_strategy: "compact" as const, display_session_cost: false, auto_compact_threshold_percent: 50, compact_maximum: 10, settings_revision: 1, source: "project" as const };
  const controller = new RoleSessionController({ role: "builder", settings, create: async () => {
    const adapter = new FakeAdapter(`s${++generation}`, [{ ok: true }], generation === 1 ? { ok: false, error: "unsupported model transition" } : { ok: true }); created.push(adapter); return adapter;
  } });
  await controller.next("initial");
  const changed = await controller.next("handoff", { ...settings, model: "new", settings_revision: 2 });
  assert.equal(changed.transition.kind, "settings-fallback"); assert.equal(changed.issue?.code, "session_model_switch_failure");
  assert.equal(created[0]?.switchCalls, 1); assert.equal(created.length, 2);
});

test("compact strategy skips the first boundary, compacts later, and falls back fresh after two failures", async () => {
  const created: FakeAdapter[] = []; let generation = 0;
  const controller = new RoleSessionController({ role: "builder", settings: { role: "builder", make: "codex", model: "x", reasoning: "high", fast: false, session_strategy: "compact", display_session_cost: false, auto_compact_threshold_percent: 50, compact_maximum: 10, settings_revision: 1, source: "project" }, create: async () => {
    const adapter = new FakeAdapter(`s${++generation}`, generation === 1 ? [{ ok: false, error: "one" }, { ok: false, error: "two" }] : [{ ok: true }]); created.push(adapter); return adapter;
  } });
  assert.equal((await controller.next("one")).transition.kind, "initial");
  const second = await controller.next("two"); assert.equal(second.transition.kind, "compaction-fallback"); assert.equal(created[0]?.compactCalls, 2); assert.equal(created.length, 2);
  await controller.close();
});
