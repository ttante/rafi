// Regression tests converted from the October 2026 build-stall investigation.
// Assertions verify repaired behavior for each originally reproduced defect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderSessionRefV1, ResolvedAgentSettings } from "rafi-spec";
import type { BuilderAdapter, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { Foreman } from "../src/foreman.js";
import { Log } from "../src/log.js";
import { ContinuityAdapter, baselineContinuityDelta } from "../src/continuity.js";
import { HandoffService } from "../src/handoffs.js";
import { RoleSessionController, ThresholdCompactionController } from "../src/sessionLifecycle.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { findResumableBranchSessions } from "../src/branch/resume.js";

const settings: ResolvedAgentSettings = {
  role: "builder", source: "project", make: "codex", model: "default",
  reasoning: "default", fast: false, session_strategy: "compact",
  settings_revision: 1, display_session_cost: false, auto_compact_threshold_percent: 65, compact_maximum: 10,
};
const delta = baselineContinuityDelta("Implement the next ticket");
const marker = `RAFI_CONTINUITY_DELTA: ${JSON.stringify(delta)}`;
const result = (text: string, isError = false): TurnResult => ({ text, isError, numTurns: 1, costUsd: 0 });

class ScriptedBuilder implements BuilderAdapter {
  readonly agent = "codex" as const;
  readonly instructions: string[] = [];
  compactCalls = 0;
  closed = false;
  ref: ProviderSessionRefV1;
  constructor(cwd: string, id: string, generation = 0, private readonly turns: TurnResult[] = []) {
    this.ref = {
      version: 1, provider: "codex", sessionId: id, role: "builder", stream: "builder",
      generation, cwd, configRoot: cwd, workspaceIdentity: "fixture",
      source: "observed", createdAt: new Date(0).toISOString(), validatedAt: new Date(0).toISOString(),
    };
  }
  async sendTurn(instruction: string): Promise<TurnResult> {
    this.instructions.push(instruction);
    const turn = this.turns.shift();
    if (!turn) throw new Error("fixture turn budget exhausted");
    return turn;
  }
  sessionId(): string { return this.ref.sessionId; }
  sessionRef(): ProviderSessionRefV1 { return this.ref; }
  adoptSessionRef(ref: ProviderSessionRefV1): void { this.ref = ref; }
  async contextUsage() { return { used: 10, maximum: 100, percentage: 10 }; }
  async compact() { this.compactCalls++; return { ok: true }; }
  async *events(): AsyncIterable<BuilderEvent> {}
  async close() { this.closed = true; }
}

function fixture(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-stall-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("recovery advances beyond historical predecessor generations without rewriting old evidence", t => {
  const dir = fixture(t);
  const predecessor = new ScriptedBuilder(dir, "predecessor", 2);
  const db = new WorkflowDb(dir);
  db.ensureRun("template");
  db.publishContinuityCheckpoint({ runId: "template", role: "builder", delta, authoritativeStateRevision: 1, sessionRef: predecessor.sessionRef() });
  db.close();
  const service = new HandoffService(dir);
  const template = service.stage({ runId: "template", role: "builder", reason: "template", predecessorSessionId: predecessor.sessionId(), predecessorSessionRef: predecessor.sessionRef(), compactionCount: 0, compactMaximum: 10 });
  const legacyOwner = new ScriptedBuilder(dir, "legacy-owner", 1);
  const legacy = new WorkflowDb(dir);
  legacy.ensureRun("legacy");
  legacy.publishContinuityCheckpoint({ runId: "legacy", role: "builder", delta, authoritativeStateRevision: 1, sessionRef: legacyOwner.sessionRef() });
  legacy.claimInitialRoleLease("legacy", "builder", legacyOwner.sessionRef());
  legacy.stageHandoff({ ...template.manifest, runId: "legacy", generation: 1 }, template.markdown);
  const before = legacy.handoffContent("legacy", 1);
  legacy.close();
  const repaired = service.stage({ runId: "legacy", role: "builder", reason: "explicit recovery", predecessorSessionId: legacyOwner.sessionId(), predecessorSessionRef: legacyOwner.sessionRef(), compactionCount: 0, compactMaximum: 10 });
  assert.equal(repaired.manifest.generation, 3);
  const after = new WorkflowDb(dir);
  try { assert.deepEqual(after.handoffContent("legacy", 1), before); }
  finally { after.close(); }
});

test("investigation: accepted first handoff advances beyond a predecessor from another run", async t => {
  const dir = fixture(t);
  const predecessor = new ScriptedBuilder(dir, "old-run-session", 2);
  const successor = new ScriptedBuilder(dir, "new-run-successor", 0, [result(`HANDOFF_ACCEPTED\n${marker}`), result("implemented")]);
  const db = new WorkflowDb(dir);
  db.ensureRun("new-run");
  db.publishContinuityCheckpoint({ runId: "new-run", role: "builder", delta, authoritativeStateRevision: 1, sessionRef: predecessor.sessionRef() });
  db.claimInitialRoleLease("new-run", "builder", predecessor.sessionRef());
  db.close();
  const controller = RoleSessionController.managed({
    projectDir: dir, runId: "new-run", role: "builder", initialSettings: settings,
    handoff: async () => {
      const transferred = await new HandoffService(dir).transfer({
        runId: "new-run", role: "builder", reason: "fresh boundary",
        predecessorSessionId: predecessor.sessionId(), predecessorSessionRef: predecessor.sessionRef(),
        compactionCount: 0, compactMaximum: 10,
      }, async () => successor);
      await predecessor.close();
      return transferred.successor;
    },
  });
  const transition = await controller.atWorkSessionBoundary(predecessor, "implement", "fresh");
  await transition.adapter.sendTurn("implement");
  const inspected = new WorkflowDb(dir);
  try {
    assert.equal(inspected.handoffs("new-run")[0]?.state, "accepted");
    assert.equal(inspected.handoffs("new-run")[0]?.generation, 3);
    assert.equal(successor.instructions.length, 2, "accepted successor receives the next implementation");
    assert.equal(predecessor.closed, true, "predecessor closes after validated acceptance");
  } finally { inspected.close(); await successor.close(); }
});

test("investigation: superseding a run retires its branch session", t => {
  const dir = fixture(t);
  mkdirSync(join(dir, ".foreman"));
  const db = new WorkflowDb(dir);
  try {
    db.ensureRun("old-run", "build");
    db.recordBranchResumeSession("old-run", { ticket: "T001", branch: "feature/unit", base: "main", worktreePath: dir, sessionId: "stale-session", logPath: "structured-recovery" });
    db.transition("old-run", { status: "superseded", checkpoint: "superseded-by-start-over" });
    assert.deepEqual(findResumableBranchSessions(join(dir, ".foreman")), []);
  } finally { db.close(); }
});

test("investigation: ordinary compact boundaries continue at ten percent occupancy", async t => {
  const dir = fixture(t);
  const adapter = new ScriptedBuilder(dir, "session");
  const controller = new ThresholdCompactionController({ projectDir: dir, runId: "run", role: "builder", initialSettings: settings });
  const boundary = await controller.atWorkSessionBoundary(adapter, "next ticket");
  assert.equal(boundary.action, "below-threshold");
  assert.equal(adapter.compactCalls, 0);
  assert.equal(boundary.effectiveThreshold, 65);
});

test("investigation: repeated blocked replies stop after one explanation", async t => {
  const dir = fixture(t);
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const restore = () => {
    if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin); else Reflect.deleteProperty(process.stdin, "isTTY");
    if (stdout) Object.defineProperty(process.stdout, "isTTY", stdout); else Reflect.deleteProperty(process.stdout, "isTTY");
  };
  try {
    const adapter = new ScriptedBuilder(dir, "session", 0, [
      ...Array.from({ length: 8 }, () => result('STEP_STATUS: blocked | reason="Registry unavailable"')),
      result('STEP_STATUS: done | summary="fixture stop"'),
    ]);
    const foreman = new Foreman(adapter, new Log(join(dir, "log.jsonl")), false, false);
    assert.equal((await foreman.runInstruction("implement")).status.kind, "blocked");
    assert.equal(adapter.instructions.length, 2);
    assert.ok(adapter.instructions.slice(1).every(text => text.includes("Registry unavailable")));
  } finally { restore(); }
});

test("investigation: a provider error cannot be overwritten by a status correction", async t => {
  const dir = fixture(t);
  const adapter = new ScriptedBuilder(dir, "session", 0, [
    result("Provider turn failed after dispatch", true),
    result('STEP_STATUS: done | summary="Ready"'),
  ]);
  const foreman = new Foreman(adapter, new Log(join(dir, "log.jsonl")), false, false);
  const batch = await foreman.runBatch(1);
  assert.equal(batch.completed, 0);
  assert.equal(batch.outcome, "blocked");
  assert.equal(adapter.instructions.length, 1);
});

test("investigation: repairing continuity processes the original handoff request once", async t => {
  const dir = fixture(t);
  let handled = 0;
  const handoffRequest = ["RAFI_HANDOFF_REQUEST_START", JSON.stringify({
    version: 1, reason: "context pressure", decisions: [], constraints: [], discoveries: [],
    completed_actions: [], evidence: [], failures: [], blockers: [], open_work: ["implement"],
    next_action: "implement", role_state: {},
  }), "RAFI_HANDOFF_REQUEST_END"].join("\n");
  const adapter = new ScriptedBuilder(dir, "session", 0, [result(handoffRequest), result(marker)]);
  const wrapped = new ContinuityAdapter({ adapter, projectDir: dir, runId: "run", role: "builder", settings,
    handleHandoffRequest: async () => { handled++; return undefined; },
  });
  try {
    const output = await wrapped.sendTurn("implement");
    assert.equal(handled, 1);
    assert.match(output.text, /RAFI_HANDOFF_REQUEST_START/);
    assert.equal(adapter.instructions.length, 2);
  } finally { await wrapped.close(); }
});

test("investigation: Codex initialization has a bounded preparation deadline", async t => {
  const dir = fixture(t);
  const adapter = new CodexAdapter({ cwd: dir, permission: async () => ({ behavior: "allow" }), providerIdleTimeoutMs: 10, preparationTimeoutMs: 10, rpcTimeoutMs: 10 });
  // Exercise the production request path with a transport that accepts writes
  // but never replies. No executable, network, or live provider is used.
  const internals = adapter as unknown as {
    initialized: boolean;
    process: { stdin: { writable: boolean; write: () => void }; exitCode: number };
  };
  internals.initialized = true;
  internals.process = { stdin: { writable: true, write: () => {} }, exitCode: 0 };
  let completed = false;
  const pending = adapter.sendTurn("implement").then(value => { completed = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(completed, true, "thread/start is bounded before implementation dispatch");
  await adapter.close();
  assert.equal((await pending).isError, true);
});

test("investigation: recorded Codex usage preserves cumulative accounting without false compaction", async t => {
  const dir = fixture(t);
  const adapter = new CodexAdapter({ cwd: dir, permission: async () => ({ behavior: "allow" }), resumeSessionId: "recorded-session" });
  adapter.adoptSessionRef(new ScriptedBuilder(dir, "recorded-session").sessionRef());
  const internal = adapter as unknown as { handle(message: unknown): void };
  const publish = (latest: number) => internal.handle({
    method: "thread/tokenUsage/updated",
    params: { threadId: "recorded-session", tokenUsage: {
      // MoneyFarm, 2026-10-07 22:56:43.877Z; total persists after compaction.
      total: { totalTokens: 3_555_538, inputTokens: 3_509_883, outputTokens: 45_655 },
      last: { totalTokens: latest }, modelContextWindow: 258_400,
    } },
  });
  publish(111_524);
  assert.ok(111_524 / 258_400 * 100 < settings.auto_compact_threshold_percent);
  assert.ok(Math.abs((await adapter.contextUsage())!.percentage! - 43.1594) < 0.001);
  let compactCalls = 0;
  adapter.compact = async () => { compactCalls++; publish(23_635); return { ok: true }; };
  const controller = new ThresholdCompactionController({ projectDir: dir, runId: "usage-run", role: "builder", initialSettings: settings });
  try {
    assert.equal((await controller.atSafeBoundary(adapter, "recorded provider turn")).action, "below-threshold");
    assert.equal(compactCalls, 0);
    publish(23_635);
    assert.ok(Math.abs((await adapter.contextUsage())!.percentage! - 9.1467) < 0.001);
    assert.equal((await adapter.sessionUsage())?.totalTokens, 3_555_538, "cumulative usage remains valid for accounting");
  } finally { await adapter.close(); }
});
