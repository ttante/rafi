import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSessionRefV1, ResolvedAgentSettings } from "rafi-spec";
import type {
  BuilderAdapter,
  BuilderEvent,
  CompactResult,
  ContextManagementPolicy,
  ContextUsage,
  InterruptResult,
  PreparedContextManagement,
  TurnResult,
} from "../src/adapters/types.js";
import { ThresholdCompactionController } from "../src/sessionLifecycle.js";
import { ContinuityAdapter } from "../src/continuity.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";
import { WorkflowDb } from "../src/workflowDb.js";

type CompactStep = CompactResult & { usage?: number };

class NativeAdapter implements BuilderAdapter {
  readonly agent = "codex" as const;
  readonly timeline: string[] = [];
  readonly sent: string[] = [];
  readonly queue = new AsyncQueue<BuilderEvent>();
  prepareCalls = 0;
  updateCalls = 0;
  updateDelayMs = 0;
  updateError?: string;
  contextError?: string;
  compactCalls = 0;
  interruptCalls = 0;
  private contextSequence = 0;
  private compactionSequence = 0;
  private ref?: ProviderSessionRefV1;
  private usage: ContextUsage;
  private readonly compactSteps: CompactStep[];
  sendBehavior?: (text: string) => Promise<TurnResult> | TurnResult;

  constructor(
    private id: string | undefined,
    used: number,
    compactSteps: CompactStep[] = [],
    private readonly role: "builder" | "qa" = "builder",
  ) {
    this.compactSteps = [...compactSteps];
    this.usage = { used, maximum: 100, percentage: used, sequence: ++this.contextSequence, source: "provider-query" };
    if (id) this.ref = scopedRef(id, role);
  }

  async sendTurn(text: string): Promise<TurnResult> {
    this.timeline.push("send");
    this.sent.push(text);
    const result = await this.sendBehavior?.(text) ?? { text: "useful work continued", isError: false, numTurns: 1, costUsd: 0 };
    this.queue.push({ kind: "turn-complete", result });
    return result;
  }

  sessionId(): string | undefined { return this.id; }
  sessionRef(): ProviderSessionRefV1 | undefined { return this.ref; }
  adoptSessionRef(ref: ProviderSessionRefV1): void { this.id = ref.sessionId; this.ref = ref; }

  async prepareContextManagement(policy: ContextManagementPolicy): Promise<PreparedContextManagement> {
    this.timeline.push("prepare");
    this.prepareCalls += 1;
    if (!this.id) {
      this.id = `${this.role}-prepared`;
      this.ref = scopedRef(this.id, this.role);
    }
    return this.prepared(policy);
  }

  async updateContextManagement(policy: ContextManagementPolicy): Promise<PreparedContextManagement> {
    this.timeline.push("update");
    this.updateCalls += 1;
    if (this.updateDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.updateDelayMs));
    if (this.updateError) throw new Error(this.updateError);
    return this.prepared(policy);
  }

  async interruptTurnAtCompactionBoundary(providerEventId?: string): Promise<InterruptResult> {
    this.timeline.push("interrupt");
    this.interruptCalls += 1;
    return { ok: true, providerEventId };
  }

  async compact(): Promise<CompactResult> {
    this.timeline.push("compact");
    this.compactCalls += 1;
    const step = this.compactSteps.shift() ?? { ok: true, usage: 10 };
    if (step.usage !== undefined) this.publishUsage(step.usage, "post-compact");
    return { ok: step.ok, ...(step.error ? { error: step.error } : {}), ...(step.failure ? { failure: step.failure } : {}) };
  }

  async contextUsage(): Promise<ContextUsage> {
    if (this.contextError) throw new Error(this.contextError);
    return { ...this.usage };
  }
  events(): AsyncIterable<BuilderEvent> { return this.queue; }
  async close(): Promise<void> { this.queue.close(); }

  publishUsage(used: number, source: ContextUsage["source"] = "provider-event"): ContextUsage {
    this.usage = {
      used, maximum: 100, percentage: used, sequence: ++this.contextSequence, source,
      sessionId: this.id, model: "test-model",
    };
    this.queue.push({ kind: "context-usage", ...this.usage });
    return { ...this.usage };
  }

  publishCompactionStart(providerEventId: string): void {
    this.queue.push({
      kind: "context-compaction", phase: "started", origin: "provider-auto", providerEventId,
      providerSequence: ++this.compactionSequence, provider: "codex", sessionId: this.id,
      sessionRef: this.ref, observedAt: new Date().toISOString(),
    });
  }

  publishCompactionSuccess(providerEventId: string, postCompactSample?: ContextUsage): void {
    this.queue.push({
      kind: "context-compaction", phase: "succeeded", origin: "provider-auto", providerEventId,
      providerSequence: this.compactionSequence, provider: "codex", sessionId: this.id,
      sessionRef: this.ref, observedAt: new Date().toISOString(),
      ...(postCompactSample ? { postCompactSample } : {}),
    });
  }

  publishCompactionFailure(providerEventId: string, reason = "native failure"): void {
    this.queue.push({
      kind: "context-compaction", phase: "failed", origin: "provider-auto", providerEventId,
      providerSequence: this.compactionSequence, provider: "codex", sessionId: this.id,
      sessionRef: this.ref, observedAt: new Date().toISOString(), reason,
    });
  }

  private prepared(policy: ContextManagementPolicy): PreparedContextManagement {
    const configuredTokenLimit = Math.floor(policy.configuredThresholdPercent);
    return {
      modelContextWindow: 100,
      configuredTokenLimit,
      installedNativeTokenLimit: configuredTokenLimit,
      installedNativePercent: policy.configuredThresholdPercent,
      sample: { ...this.usage, sessionId: this.id, model: policy.model },
    };
  }
}

const SETTINGS: ResolvedAgentSettings = {
  role: "builder", source: "project", make: "codex", model: "test-model", reasoning: "high", fast: false,
  session_strategy: "compact", settings_revision: 1, display_session_cost: false,
  auto_compact_threshold_percent: 50, compact_maximum: 10,
};

function project(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }

function scopedRef(id: string, role: "builder" | "qa"): ProviderSessionRefV1 {
  return {
    version: 1, provider: "codex", sessionId: id, role, stream: role, generation: id.includes("successor") ? 1 : 0,
    cwd: `/tmp/${id}`, configRoot: "/tmp", workspaceIdentity: `workspace-${id}`,
    source: "observed", createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function controller(root: string, settings = SETTINGS, role: "builder" | "qa" = "builder", handoff?: ConstructorParameters<typeof ThresholdCompactionController>[0]["handoff"]): ThresholdCompactionController {
  return new ThresholdCompactionController({
    projectDir: root, runId: "run-1", role, initialSettings: { ...settings, role },
    requireNativeContextManagement: true, ...(handoff ? { handoff } : {}),
  });
}

test("initialization installs native control and compacts an already-over-ceiling setup before real work", async () => {
  const root = project("rafi-context-initialize-");
  const provider = new NativeAdapter(undefined, 79, [{ ok: true, usage: 20 }]);
  const managed = controller(root).manage(provider);
  const result = await managed.sendTurn("implement the ticket");
  assert.equal(result.text, "useful work continued");
  assert.deepEqual(provider.timeline.slice(0, 3), ["prepare", "compact", "send"]);
  assert.equal(provider.compactCalls, 1);
  assert.equal(managed.coordinator.snapshot()?.configuredCeilingPercent, 50);
  assert.equal(managed.coordinator.snapshot()?.contextSample.percentage, 20);
  await managed.close();
});

test("exactly-at-threshold usage is enforced and an ineffective success receives one bounded retry", async () => {
  const root = project("rafi-context-retry-");
  const provider = new NativeAdapter("builder-1", 50, [{ ok: true, usage: 55 }, { ok: true, usage: 20 }]);
  const managed = controller(root).manage(provider);
  await managed.sendTurn("continue");
  assert.equal(provider.compactCalls, 2);
  assert.equal(managed.coordinator.snapshot()?.lifecycleState, "armed");
  assert.equal(managed.coordinator.snapshot()?.compactionCount, 2);
  assert.equal(managed.coordinator.effectiveThreshold(), 50, "the configured ceiling must never be raised internally");
  await managed.close();
});

test("failed compaction retries once without consuming a compact slot", async () => {
  const root = project("rafi-context-failure-");
  const provider = new NativeAdapter("builder-1", 70, [{ ok: false, error: "temporary failure" }, { ok: true, usage: 20 }]);
  const managed = controller(root).manage(provider);
  await managed.sendTurn("continue");
  assert.equal(provider.compactCalls, 2);
  assert.equal(managed.coordinator.snapshot()?.compactionCount, 1);
  const db = new WorkflowDb(root);
  assert.deepEqual(db.compactionAttempts("run-1", "builder", provider.sessionRef()!).map((attempt) => attempt.status), ["failed", "succeeded"]);
  db.close();
  await managed.close();
});

test("provider-native in-turn compaction is verified, deduplicated, and keeps useful work in the same scoped session", async () => {
  const root = project("rafi-context-native-");
  const provider = new NativeAdapter("builder-1", 10);
  provider.sendBehavior = () => {
    provider.publishUsage(60);
    provider.publishCompactionStart("native-1");
    const post = provider.publishUsage(20, "post-compact");
    provider.publishCompactionSuccess("native-1", post);
    provider.publishCompactionSuccess("native-1", post);
    provider.queue.push({ kind: "context-usage", used: 90, maximum: 100, percentage: 90, sequence: 1, sessionId: provider.sessionId(), model: "test-model" });
    return { text: "preserved early fact and finished", isError: false, numTurns: 1, costUsd: 0 };
  };
  const managed = controller(root).manage(provider);
  const result = await managed.sendTurn("one long action");
  assert.match(result.text, /preserved early fact/);
  assert.equal(managed.sessionId(), "builder-1");
  assert.equal(managed.coordinator.snapshot()?.compactionCount, 1);
  assert.equal(managed.coordinator.snapshot()?.contextSample.percentage, 20);
  const db = new WorkflowDb(root);
  assert.equal(db.compactionAttempts("run-1", "builder", provider.sessionRef()!).length, 1);
  db.close();
  await managed.close();
});

test("a native failure plus its one host retry exhausts the durable generation retry budget", async () => {
  const root = project("rafi-context-native-failure-budget-");
  const predecessor = new NativeAdapter("builder-1", 10, [
    { ok: false, error: "host retry also failed" },
    { ok: true, usage: 10 },
  ]);
  predecessor.sendBehavior = async () => {
    predecessor.publishUsage(60);
    predecessor.publishCompactionStart("native-failed");
    predecessor.publishCompactionFailure("native-failed");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return { text: "original work completed", isError: false, numTurns: 1, costUsd: 0 };
  };
  const successor = new NativeAdapter("builder-successor", 10);
  let transfers = 0;
  const managed = controller(root, SETTINGS, "builder", async () => {
    transfers += 1;
    await predecessor.close();
    return successor;
  }).manage(predecessor);
  const result = await managed.sendTurn("long action");
  assert.equal(result.text, "original work completed");
  assert.equal(predecessor.compactCalls, 1, "the native failure already consumed the first attempt");
  assert.equal(transfers, 1);
  const db = new WorkflowDb(root);
  assert.deepEqual(
    db.compactionAttempts("run-1", "builder", predecessor.sessionRef()!).map((attempt) => attempt.status),
    ["failed", "failed"],
  );
  db.close();
  await managed.close();
});

test("an ineffective native success permits only one host retry before validated handoff", async () => {
  const root = project("rafi-context-native-ineffective-budget-");
  const predecessor = new NativeAdapter("builder-1", 10, [
    { ok: true, usage: 55 },
    { ok: true, usage: 10 },
  ]);
  predecessor.sendBehavior = async () => {
    predecessor.publishUsage(60);
    predecessor.publishCompactionStart("native-ineffective");
    const post = predecessor.publishUsage(55, "post-compact");
    predecessor.publishCompactionSuccess("native-ineffective", post);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return { text: "original work completed", isError: false, numTurns: 1, costUsd: 0 };
  };
  const successor = new NativeAdapter("builder-successor", 10);
  let transfers = 0;
  const managed = controller(root, SETTINGS, "builder", async () => {
    transfers += 1;
    await predecessor.close();
    return successor;
  }).manage(predecessor);
  await managed.sendTurn("long action");
  assert.equal(predecessor.compactCalls, 1);
  assert.equal(transfers, 1);
  const db = new WorkflowDb(root);
  assert.deepEqual(
    db.compactionAttempts("run-1", "builder", predecessor.sessionRef()!).map((attempt) => attempt.status),
    ["succeeded", "succeeded"],
  );
  db.close();
  await managed.close();
});

test("the compact maximum interrupts the next native boundary and resumes the frozen action in a fresh successor", async () => {
  const root = project("rafi-context-maximum-");
  const predecessor = new NativeAdapter("builder-1", 10);
  const predecessorRef = predecessor.sessionRef()!;
  const seed = new WorkflowDb(root);
  const attempt = seed.startCompactionAttempt({
    idempotencyKey: "seed-success", runId: "run-1", role: "builder", sessionRef: predecessorRef,
    crossingKey: "seed", origin: "provider-auto", providerEventId: "native-1",
  });
  seed.finishCompactionAttempt(attempt.idempotencyKey, { ok: true });
  seed.close();
  predecessor.sendBehavior = async () => {
    predecessor.publishCompactionStart("native-2");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(predecessor.interruptCalls, 1);
    return { text: "", isError: false, numTurns: 1, costUsd: 0, interrupted: { reason: "compaction-boundary", providerEventId: "native-2" } };
  };
  const successor = new NativeAdapter("builder-successor", 10);
  successor.sendBehavior = () => ({ text: "fresh successor completed frozen action", isError: false, numTurns: 1, costUsd: 0 });
  const settings = { ...SETTINGS, compact_maximum: 1 };
  let transfers = 0;
  const managed = controller(root, settings, "builder", async () => {
    transfers += 1;
    await predecessor.close();
    return successor;
  }).manage(predecessor);
  const result = await managed.sendTurn("frozen action");
  assert.equal(result.text, "fresh successor completed frozen action");
  assert.equal(transfers, 1);
  assert.deepEqual(predecessor.sent, ["frozen action"]);
  assert.deepEqual(successor.sent, ["frozen action"]);
  assert.equal(managed.sessionId(), "builder-successor");
  assert.equal(managed.coordinator.snapshot()?.compactionCount, 0);
  await managed.close();
});

test("a maximum-boundary interruption bypasses continuity repair and replays only through the validated successor", async () => {
  const root = project("rafi-context-maximum-continuity-");
  const predecessor = new NativeAdapter("builder-1", 10);
  const seed = new WorkflowDb(root);
  const seeded = seed.startCompactionAttempt({
    idempotencyKey: "seed-continuity-success", runId: "run-1", role: "builder", sessionRef: predecessor.sessionRef()!,
    crossingKey: "seed", origin: "provider-auto", providerEventId: "native-1",
  });
  seed.finishCompactionAttempt(seeded.idempotencyKey, { ok: true });
  seed.close();
  predecessor.sendBehavior = async () => {
    predecessor.publishCompactionStart("native-2");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return { text: "partial output", isError: false, numTurns: 1, costUsd: 0, interrupted: { reason: "compaction-boundary", providerEventId: "native-2" } };
  };
  const successor = new NativeAdapter("builder-successor", 10);
  successor.sendBehavior = () => ({
    text: 'fresh successor completed frozen action\nRAFI_CONTINUITY_DELTA: {"version":1,"decisions":[],"constraints":[],"discoveries":[],"completedActions":["completed frozen action"],"evidence":[],"failures":[],"blockers":[],"openWork":[],"nextAction":"done"}',
    isError: false, numTurns: 1, costUsd: 0,
  });
  const continuous = new ContinuityAdapter({ adapter: predecessor, projectDir: root, runId: "run-1", role: "builder", settings: { ...SETTINGS, compact_maximum: 1 } });
  let transfers = 0;
  const managed = controller(root, { ...SETTINGS, compact_maximum: 1 }, "builder", async () => {
    transfers += 1;
    await continuous.adoptValidatedSuccessor(successor);
    return continuous;
  }).manage(continuous);
  const result = await managed.sendTurn("frozen action");
  assert.equal(result.text, "fresh successor completed frozen action");
  assert.equal(transfers, 1);
  assert.equal(predecessor.sent.length, 1, "the interrupted predecessor must not receive continuity repair");
  assert.equal(successor.sent.length, 1, "the successor receives only the replayed frozen action");
  await managed.close();
});

test("a maximum boundary during continuity repair returns to the coordinator and replays the original action once", async () => {
  const root = project("rafi-context-maximum-continuity-repair-");
  const predecessor = new NativeAdapter("builder-1", 10);
  const seed = new WorkflowDb(root);
  const seeded = seed.startCompactionAttempt({
    idempotencyKey: "seed-continuity-repair-success", runId: "run-1", role: "builder", sessionRef: predecessor.sessionRef()!,
    crossingKey: "seed", origin: "provider-auto", providerEventId: "native-1",
  });
  seed.finishCompactionAttempt(seeded.idempotencyKey, { ok: true });
  seed.close();
  let predecessorTurns = 0;
  predecessor.sendBehavior = async () => {
    predecessorTurns += 1;
    if (predecessorTurns === 1) return { text: "completed work without continuity", isError: false, numTurns: 1, costUsd: 0 };
    predecessor.publishCompactionStart("native-2");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return { text: "partial repair", isError: false, numTurns: 1, costUsd: 0, interrupted: { reason: "compaction-boundary", providerEventId: "native-2" } };
  };
  const successor = new NativeAdapter("builder-successor", 10);
  successor.sendBehavior = () => ({
    text: 'fresh successor completed original action\nRAFI_CONTINUITY_DELTA: {"version":1,"decisions":[],"constraints":[],"discoveries":[],"completedActions":["completed original action"],"evidence":[],"failures":[],"blockers":[],"openWork":[],"nextAction":"done"}',
    isError: false, numTurns: 1, costUsd: 0,
  });
  const continuous = new ContinuityAdapter({ adapter: predecessor, projectDir: root, runId: "run-1", role: "builder", settings: { ...SETTINGS, compact_maximum: 1 } });
  let transfers = 0;
  const managed = controller(root, { ...SETTINGS, compact_maximum: 1 }, "builder", async () => {
    transfers += 1;
    await continuous.adoptValidatedSuccessor(successor);
    return continuous;
  }).manage(continuous);
  const result = await managed.sendTurn("original frozen action");
  assert.equal(result.text, "fresh successor completed original action");
  assert.equal(transfers, 1);
  assert.equal(predecessor.sent.length, 2, "the predecessor receives the original turn and one protocol repair");
  assert.equal(successor.sent.length, 1, "the successor receives only the replayed original action");
  assert.match(successor.sent[0] ?? "", /original frozen action/);
  await managed.close();
});

test("Builder and QA enforce independent ceilings and counters", async () => {
  const root = project("rafi-context-roles-");
  const builder = new NativeAdapter("builder-1", 40, [{ ok: true, usage: 10 }], "builder");
  const qa = new NativeAdapter("qa-1", 40, [], "qa");
  const managedBuilder = controller(root, { ...SETTINGS, auto_compact_threshold_percent: 30 }, "builder").manage(builder);
  const managedQa = controller(root, { ...SETTINGS, role: "qa", auto_compact_threshold_percent: 80, compact_maximum: 2 }, "qa").manage(qa);
  await managedBuilder.sendTurn("build");
  await managedQa.sendTurn("review");
  assert.equal(builder.compactCalls, 1);
  assert.equal(qa.compactCalls, 0);
  assert.equal(managedBuilder.coordinator.snapshot()?.configuredCeilingPercent, 30);
  assert.equal(managedQa.coordinator.snapshot()?.configuredCeilingPercent, 80);
  assert.equal(managedBuilder.coordinator.snapshot()?.compactionCount, 1);
  assert.equal(managedQa.coordinator.snapshot()?.compactionCount, 0);
  await managedBuilder.close();
  await managedQa.close();
});

test("concurrent Builder worktrees retain independent scoped state, counters, and active acknowledgments", async () => {
  const root = project("rafi-context-concurrent-builders-");
  const left = new NativeAdapter("builder-left", 60, [{ ok: true, usage: 15 }]);
  const right = new NativeAdapter("builder-right", 20);
  const managedLeft = controller(root).manage(left);
  const managedRight = controller(root).manage(right);
  await Promise.all([managedLeft.sendTurn("left ticket"), managedRight.sendTurn("right ticket")]);
  assert.equal(managedLeft.coordinator.snapshot()?.compactionCount, 1);
  assert.equal(managedRight.coordinator.snapshot()?.compactionCount, 0);
  let db = new WorkflowDb(root);
  assert.deepEqual(db.activeRoleAdapters("run-1").map((record) => record.providerSessionId), ["builder-left", "builder-right"]);
  db.close();
  await managedLeft.close();
  db = new WorkflowDb(root);
  assert.deepEqual(db.activeRoleAdapters("run-1").map((record) => record.providerSessionId), ["builder-right"]);
  db.close();
  await managedRight.close();
});

test("production mode refuses adapters that cannot enforce native in-turn limits and maximum boundaries", async () => {
  const root = project("rafi-context-capability-");
  const full = new NativeAdapter("builder-1", 10);
  const provider: BuilderAdapter = {
    agent: "codex",
    sendTurn: (text) => full.sendTurn(text), sessionId: () => full.sessionId(), sessionRef: () => full.sessionRef(),
    prepareContextManagement: (policy) => full.prepareContextManagement(policy),
    updateContextManagement: (policy) => full.updateContextManagement(policy),
    contextUsage: () => full.contextUsage(), events: () => full.events(), close: () => full.close(),
  };
  const managed = controller(root).manage(provider);
  await assert.rejects(() => managed.sendTurn("must not dispatch"), /does not expose prepare, live update, and compaction-boundary interruption/);
  assert.equal(full.sent.length, 0);
  await managed.close();
});

test("continuity repair follow-ups re-enter the managed dispatcher before the provider is called again", async () => {
  const root = project("rafi-context-followup-");
  const provider = new NativeAdapter("builder-1", 20, [{ ok: true, usage: 10 }]);
  let turn = 0;
  provider.sendBehavior = async () => {
    turn += 1;
    if (turn === 1) {
      provider.publishUsage(60);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return { text: "STEP_STATUS: done", isError: false, numTurns: 1, costUsd: 0 };
    }
    return {
      text: 'RAFI_CONTINUITY_DELTA: {"version":1,"decisions":[],"constraints":[],"discoveries":[],"completedActions":[],"evidence":[],"failures":[],"blockers":[],"openWork":[],"nextAction":"continue"}',
      isError: false, numTurns: 1, costUsd: 0,
    };
  };
  const continuous = new ContinuityAdapter({ adapter: provider, projectDir: root, runId: "run-1", role: "builder", settings: SETTINGS });
  const managed = controller(root).manage(continuous);
  const result = await managed.sendTurn("do work");
  assert.equal(result.text, "STEP_STATUS: done");
  assert.equal(provider.sent.length, 2);
  const firstSend = provider.timeline.indexOf("send");
  const compact = provider.timeline.indexOf("compact");
  const secondSend = provider.timeline.lastIndexOf("send");
  assert.ok(firstSend < compact && compact < secondSend, "repair must cross the lifecycle gate before its provider turn");
  await managed.close();
});

test("a threshold-only live revision is acknowledged only after native control is installed, even before first initialization", async () => {
  const root = project("rafi-context-settings-initial-");
  const provider = new NativeAdapter("builder-1", 40, [{ ok: true, usage: 10 }]);
  const next = { ...SETTINGS, settings_revision: 2, auto_compact_threshold_percent: 30 };
  const lifecycle = new ThresholdCompactionController({
    projectDir: root, runId: "run-1", role: "builder", initialSettings: SETTINGS,
    readSettings: () => next, requireNativeContextManagement: true,
  });
  const managed = lifecycle.manage(provider);
  await managed.sendTurn("apply lowered setting");
  assert.equal(provider.prepareCalls, 1);
  assert.equal(provider.updateCalls, 0, "a pre-initialization revision should be installed by prepare, not an unsafe update");
  assert.equal(provider.compactCalls, 1);
  assert.equal(lifecycle.snapshot()?.configuredCeilingPercent, 30);
  const db = new WorkflowDb(root);
  assert.equal(db.settingsAcknowledgments(2)[0]?.providerSessionId, "builder-1");
  db.close();
  await managed.close();
});

test("raising a live ceiling cancels a not-yet-started lowered-threshold generation", async () => {
  const root = project("rafi-context-settings-raise-");
  const provider = new NativeAdapter("builder-1", 40);
  let current: ResolvedAgentSettings = SETTINGS;
  provider.sendBehavior = async () => {
    current = { ...SETTINGS, settings_revision: 2, auto_compact_threshold_percent: 30 };
    setTimeout(() => { current = { ...SETTINGS, settings_revision: 3, auto_compact_threshold_percent: 60 }; }, 70);
    await new Promise<void>((resolve) => setTimeout(resolve, 140));
    return { text: "continued", isError: false, numTurns: 1, costUsd: 0 };
  };
  const lifecycle = new ThresholdCompactionController({
    projectDir: root, runId: "run-1", role: "builder", initialSettings: SETTINGS,
    readSettings: () => current, settingsPollMs: 50, requireNativeContextManagement: true,
  });
  const managed = lifecycle.manage(provider);
  await managed.sendTurn("long action");
  assert.equal(provider.updateCalls, 2);
  assert.equal(provider.compactCalls, 0);
  assert.equal(lifecycle.snapshot()?.configuredCeilingPercent, 60);
  assert.equal(lifecycle.snapshot()?.lifecycleState, "armed");
  const db = new WorkflowDb(root);
  assert.ok(db.settingsAcknowledgments(3).some((ack) => ack.revision === 3));
  db.close();
  await managed.close();
});

test("post-turn dispatch waits for an in-flight settings install and then adopts the newest revision", async () => {
  const root = project("rafi-context-settings-serialized-");
  const provider = new NativeAdapter("builder-1", 20);
  provider.updateDelayMs = 80;
  let current: ResolvedAgentSettings = SETTINGS;
  provider.sendBehavior = async () => {
    current = { ...SETTINGS, settings_revision: 2, auto_compact_threshold_percent: 40 };
    setTimeout(() => { current = { ...SETTINGS, settings_revision: 3, auto_compact_threshold_percent: 60 }; }, 70);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    return { text: "continued", isError: false, numTurns: 1, costUsd: 0 };
  };
  const lifecycle = new ThresholdCompactionController({
    projectDir: root, runId: "run-1", role: "builder", initialSettings: SETTINGS,
    readSettings: () => current, settingsPollMs: 50, requireNativeContextManagement: true,
  });
  const managed = lifecycle.manage(provider);
  await managed.sendTurn("long action");
  assert.equal(provider.updateCalls, 2);
  assert.equal(lifecycle.snapshot()?.configuredCeilingPercent, 60);
  assert.equal(lifecycle.snapshot()?.settingsRevision, 3);
  const db = new WorkflowDb(root);
  assert.ok(db.settingsAcknowledgments(3).some((ack) => ack.revision === 3));
  db.close();
  await managed.close();
});

test("the live settings watcher remains active while the managed role is idle", async () => {
  const root = project("rafi-context-settings-idle-");
  const provider = new NativeAdapter("builder-1", 20);
  let current: ResolvedAgentSettings = SETTINGS;
  const lifecycle = new ThresholdCompactionController({
    projectDir: root, runId: "run-1", role: "builder", initialSettings: SETTINGS,
    readSettings: () => current, settingsPollMs: 50, requireNativeContextManagement: true,
  });
  const managed = lifecycle.manage(provider);
  await managed.sendTurn("initial action");
  current = { ...SETTINGS, settings_revision: 2, auto_compact_threshold_percent: 35 };
  await new Promise<void>((resolve) => setTimeout(resolve, 130));
  assert.equal(provider.updateCalls, 1);
  assert.equal(lifecycle.snapshot()?.configuredCeilingPercent, 35);
  const db = new WorkflowDb(root);
  assert.ok(db.settingsAcknowledgments(2).some((ack) => ack.providerSessionId === "builder-1"));
  assert.equal(db.activeRoleAdapters("run-1").length, 1);
  db.close();
  await managed.close();
  const closedDb = new WorkflowDb(root);
  assert.equal(closedDb.activeRoleAdapters("run-1").length, 0);
  closedDb.close();
});

test("an idle native settings failure fences new work until reconfiguration succeeds", async () => {
  const root = project("rafi-context-settings-capability-");
  const provider = new NativeAdapter("builder-1", 20);
  let current: ResolvedAgentSettings = SETTINGS;
  const lifecycle = new ThresholdCompactionController({
    projectDir: root, runId: "run-1", role: "builder", initialSettings: SETTINGS,
    readSettings: () => current, settingsPollMs: 50, requireNativeContextManagement: true,
  });
  const managed = lifecycle.manage(provider);
  await managed.sendTurn("initial action");
  provider.updateError = "native window unavailable";
  current = { ...SETTINGS, settings_revision: 2, auto_compact_threshold_percent: 35 };
  await new Promise<void>((resolve) => setTimeout(resolve, 90));
  assert.equal(provider.sent.length, 1);
  await assert.rejects(() => managed.sendTurn("must remain fenced"), /native window unavailable/);
  assert.equal(provider.sent.length, 1, "the failed revision must be installed before another provider action starts");
  provider.updateError = undefined;
  await managed.sendTurn("resume after capability recovery");
  assert.equal(provider.sent.length, 2);
  assert.equal(lifecycle.snapshot()?.settingsRevision, 2);
  await managed.close();
});

test("a native update that is unsafe during an active turn is retried as soon as the turn settles", async () => {
  const root = project("rafi-context-settings-active-defer-");
  const provider = new NativeAdapter("builder-1", 20);
  let current: ResolvedAgentSettings = SETTINGS;
  provider.sendBehavior = async () => {
    provider.updateError = "active turn must settle";
    current = { ...SETTINGS, settings_revision: 2, auto_compact_threshold_percent: 35 };
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    provider.updateError = undefined;
    return { text: "continued", isError: false, numTurns: 1, costUsd: 0 };
  };
  const lifecycle = new ThresholdCompactionController({
    projectDir: root, runId: "run-1", role: "builder", initialSettings: SETTINGS,
    readSettings: () => current, settingsPollMs: 50, requireNativeContextManagement: true,
  });
  const managed = lifecycle.manage(provider);
  await managed.sendTurn("long action");
  assert.equal(provider.sent.length, 1);
  assert.equal(lifecycle.snapshot()?.settingsRevision, 2);
  assert.equal(lifecycle.snapshot()?.configuredCeilingPercent, 35);
  const db = new WorkflowDb(root);
  assert.ok(db.settingsAcknowledgments(2).some((ack) => ack.providerSessionId === "builder-1"));
  db.close();
  await managed.close();
});

test("a transient post-turn measurement fence remeasures before allowing the next provider action", async () => {
  const root = project("rafi-context-measurement-recovery-");
  const provider = new NativeAdapter("builder-1", 20);
  provider.sendBehavior = async () => {
    provider.contextError = "usage endpoint unavailable";
    return { text: "first action completed", isError: false, numTurns: 1, costUsd: 0 };
  };
  const managed = controller(root).manage(provider);
  const first = await managed.sendTurn("first action");
  assert.equal(first.text, "first action completed");
  assert.equal(provider.sent.length, 1);
  provider.contextError = undefined;
  provider.sendBehavior = undefined;
  await managed.sendTurn("second action");
  assert.equal(provider.sent.length, 2);
  assert.equal(managed.coordinator.snapshot()?.lifecycleState, "armed");
  await managed.close();
});

test("recovery remeasures compacted-unverified state and does not blindly compact when occupancy is already below the ceiling", async () => {
  const root = project("rafi-context-recover-unverified-");
  const provider = new NativeAdapter("builder-1", 20);
  const ref = provider.sessionRef()!;
  const sample = {
    version: 1 as const, runId: "run-1", role: "builder" as const, provider: "codex" as const,
    providerSessionId: ref.sessionId, sessionRef: ref, sessionKey: "ignored", model: "test-model",
    observedAt: "2026-08-30T00:00:00.000Z", source: "post-compact" as const, freshness: "measuring" as const,
    used: 70, maximum: 100, percentage: 70, settingsRevision: 1, compactionCount: 1,
    handoffGeneration: 0, sequence: 1, thresholdGeneration: 1,
  };
  const db = new WorkflowDb(root);
  db.upsertThresholdGeneration({
    generationId: "generation-1", runId: "run-1", role: "builder", providerSessionId: ref.sessionId,
    sessionRef: ref, generation: 1, state: "compacted_unverified", configuredCeilingPercent: 50,
    installedNativeTokenLimit: 50, installedNativePercent: 50, settingsRevision: 1, model: "test-model", latestSample: sample,
  });
  db.close();
  const managed = controller(root).manage(provider);
  await managed.sendTurn("resume safely");
  assert.equal(provider.compactCalls, 0);
  assert.equal(managed.coordinator.snapshot()?.contextSample.percentage, 20);
  assert.equal(managed.coordinator.snapshot()?.lifecycleState, "armed");
  await managed.close();
});
