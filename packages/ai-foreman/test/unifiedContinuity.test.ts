import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ContinuityDelta, ProviderSessionRefV1, ResolvedAgentSettings } from "rafi-spec";
import type { BuilderAdapter, BuilderEvent, CompactResult, ContextUsage, NativeAutoCompactionPolicy, NativeCompaction, TurnResult } from "../src/adapters/types.js";
import { ContinuityAdapter } from "../src/continuity.js";
import { HANDOFF_ACCEPTED, HandoffLoopError, HandoffService } from "../src/handoffs.js";
import { ThresholdCompactionController } from "../src/sessionLifecycle.js";
import { applyTicketPopulation, recoverTicketPublications } from "../src/ticketPopulation.js";
import { cmdInit } from "../src/tickets/commands.js";
import { StateDb } from "../src/tickets/stateDb.js";
import { loadTickets } from "../src/tickets/ticketLoader.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import { WorkflowDb } from "../src/workflowDb.js";

const EMPTY_DELTA: ContinuityDelta = {
  version: 1,
  decisions: [], constraints: [], discoveries: [], completedActions: [], evidence: [], failures: [], blockers: [], openWork: ["continue"], nextAction: "continue",
};
const MARKER = `RAFI_CONTINUITY_DELTA: ${JSON.stringify(EMPTY_DELTA)}`;
const SETTINGS: ResolvedAgentSettings = {
  role: "builder", source: "project", make: "codex", model: "default", reasoning: "default", fast: false,
  session_strategy: "compact", settings_revision: 1, display_session_cost: false,
  auto_compact_threshold_percent: 50, compact_maximum: 1,
};

class FakeAdapter implements BuilderAdapter {
  readonly agent: "claude" | "codex";
  compactCalls = 0;
  closed = false;
  private usageIndex = 0;
  private adoptedRef?: ProviderSessionRefV1;
  nativeCompactions: NativeCompaction[] = [];
  policy?: NativeAutoCompactionPolicy;
  constructor(
    private readonly id: string | undefined,
    private readonly turns: TurnResult[] = [],
    private readonly usages: ContextUsage[] = [{ used: 10, maximum: 100, percentage: 10 }],
    private readonly compactResult: CompactResult = { ok: true },
    agent: "claude" | "codex" = "codex",
  ) { this.agent = agent; }
  async sendTurn(): Promise<TurnResult> {
    return this.turns.shift() ?? { text: `${HANDOFF_ACCEPTED}\n${MARKER}`, isError: false, numTurns: 1, costUsd: 0 };
  }
  sessionId(): string | undefined { return this.id; }
  sessionRef(): ProviderSessionRefV1 | undefined {
    return this.adoptedRef ?? (this.id ? {
      version: 1, provider: this.agent, sessionId: this.id, role: "builder", stream: "builder", generation: 0,
      cwd: `/test/${this.id}`, configRoot: "/test", workspaceIdentity: `workspace-${this.id}`,
      source: "observed", createdAt: "2026-01-01T00:00:00.000Z",
    } : undefined);
  }
  adoptSessionRef(ref: ProviderSessionRefV1): void { this.adoptedRef = ref; }
  async compact(): Promise<CompactResult> { this.compactCalls += 1; this.usageIndex = Math.min(this.usageIndex + 1, this.usages.length - 1); return this.compactResult; }
  async prepareAutoCompaction(_threshold?: number): Promise<void> {}
  autoCompactionPolicy(): NativeAutoCompactionPolicy | undefined { return this.policy; }
  async contextUsage(): Promise<ContextUsage | undefined> { return this.usages[this.usageIndex]; }
  drainNativeCompactions(): NativeCompaction[] { const pending = this.nativeCompactions; this.nativeCompactions = []; return pending; }
  advanceUsage(): void { this.usageIndex = Math.min(this.usageIndex + 1, this.usages.length - 1); }
  async *events(): AsyncIterable<BuilderEvent> {}
  async close(): Promise<void> { this.closed = true; }
}

function root(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }
function definition(id: string, title = id): Record<string, unknown> { return { id, order: Number(id.replace(/\D/g, "")) * 1000, title, depends_on: [] }; }

test("ticket groups allocate stable monotonic IDs, preserve order, and reuse an operation only idempotently", () => {
  const db = new StateDb(join(root("rafi-groups-"), "state.sqlite"));
  const first = db.createTicketGroup({ origin: "ticket-plan", operationId: "op-1", members: [
    { ticketId: "T002", definition: definition("T002") },
    { ticketId: "T001", definition: definition("T001") },
  ] });
  const replay = db.createTicketGroup({ origin: "ticket-plan", operationId: "op-1", members: [
    { ticketId: "T002", definition: definition("T002") },
    { ticketId: "T001", definition: definition("T001") },
  ] });
  const second = db.createTicketGroup({ origin: "import", operationId: "op-2", members: [{ ticketId: "T003", definition: definition("T003") }] });
  assert.equal(first.id, "TG-1");
  assert.equal(replay.id, "TG-1");
  assert.equal(second.id, "TG-2");
  assert.deepEqual(first.members.map((member) => member.ticketId), ["T002", "T001"]);
  assert.equal(db.getState("T001")?.status, "planned");
  assert.equal(db.getState("T001")?.updated_by, "rafi ticket publication");
  assert.deepEqual(db.listTicketGroups().map((group) => group.id), ["TG-2", "TG-1"]);
  assert.throws(() => db.createTicketGroup({ origin: "ticket-plan", operationId: "op-1", members: [{ ticketId: "T001", definition: definition("T001") }] }), /different immutable membership/);
  db.updateTicketDefinitionSnapshot("T001", definition("T001", "latest valid definition"));
  assert.equal((db.getTicketGroup("TG-1")?.members[1]?.snapshot.definition as { title: string }).title, "latest valid definition");
  assert.deepEqual(db.validateTicketGroups(["T001", "T002", "T003"]), []);
  db.close();
});

test("legacy tickets form one synthetic group and later ungrouped tickets require a separate repair group", () => {
  const db = new StateDb(join(root("rafi-group-repair-"), "state.sqlite"));
  const legacy = db.ensureSyntheticLegacyGroup([definition("T001"), definition("T002")] as Array<{ id: string } & Record<string, unknown>>);
  assert.equal(legacy?.id, "TG-1");
  assert.equal(legacy?.legacy, true);
  assert.deepEqual(db.ungroupedTicketIds(["T001", "T002", "T003"]), ["T003"]);
  const repair = db.repairTicketGroups([definition("T003")] as Array<{ id: string } & Record<string, unknown>>, "repair-1");
  assert.equal(repair?.id, "TG-2");
  assert.equal(repair?.origin, "repair");
  assert.equal(db.ensureSyntheticLegacyGroup([definition("T004")] as Array<{ id: string } & Record<string, unknown>>), undefined);
  db.close();
});

test("ticket population receipt closes the tracker-commit crash window and recovery refreshes validated snapshots", () => {
  const projectDir = root("rafi-population-recovery-");
  cmdInit(projectDir, {});
  const ticket: TicketDef = {
    id: "T001", order: 1000, title: "Original", area: "core", priority: "P1", size: "S", risk: "Low",
    depends_on: [], summary: "Original ticket", acceptance: ["works"], required_tests: ["test"], likely_files: ["src/index.ts"],
    plan_ref: { plan_id: "plan-1", revision: 1, slice_ref: "slice-1" },
  };
  const delivery = { version: 1 as const, plan: { plan_id: "plan-1", revision: 1 }, units: [
    { id: "unit-1", tickets: [ticket.id], branch_mode: "current" as const, completion: "none" as const, provider: "local" as const },
  ], stacks: [] };
  const applied = applyTicketPopulation(projectDir, { tickets: [ticket], delivery, retirements: [], sliceToTicket: new Map([["slice-1", ticket.id]]) });
  const statePath = join(projectDir, ".tickets", "ticket-state.sqlite");
  let state = new StateDb(statePath);
  assert.ok(state.getOperationReceipt(`ticket-populate-publication:${applied.runId}`));
  assert.equal(state.getTicketGroup("TG-1")?.members[0]?.snapshot.definition && (state.getTicketGroup("TG-1")!.members[0]!.snapshot.definition as TicketDef).title, "Original");
  state.close();

  const updated = { ...ticket, title: "Recovered update", summary: "Published after a simulated crash" };
  const workflow = new WorkflowDb(projectDir);
  const run = workflow.createRun({ kind: "ticket-populate", originalWork: { tickets: [ticket.id] } });
  const stage = join(projectDir, ".rafi", "staging", "simulated-crash");
  const stagedTickets = join(stage, "tickets.yaml");
  const stagedDelivery = join(stage, "delivery.yaml");
  mkdirSync(stage, { recursive: true });
  writeFileSync(stagedTickets, stringify({ tickets: [updated] }), "utf8");
  writeFileSync(stagedDelivery, stringify(delivery), "utf8");
  const operationId = `ticket-populate-publication:${run.runId}`;
  const publication = workflow.beginPublication(run.runId, {
    operation: "ticket-populate", operationId, stage, managedTicketIds: [ticket.id],
    files: [
      { staged: stagedTickets, target: join(projectDir, ".tickets", "tickets.yaml") },
      { staged: stagedDelivery, target: join(projectDir, ".tickets", "delivery.yaml") },
    ],
  }, {});
  workflow.updatePublication(publication.transactionId, "staged");
  workflow.close();
  state = new StateDb(statePath);
  state.recordOperationReceipt({ operation_id: operationId, operation_type: "ticket-populate-publication", ticket_id: null, run_id: run.runId, completed_at: new Date().toISOString(), payload_json: JSON.stringify({ transactionId: publication.transactionId }) });
  state.close();

  assert.deepEqual(recoverTicketPublications(projectDir), [publication.transactionId]);
  assert.equal(loadTickets(join(projectDir, ".tickets", "tickets.yaml"))[0]?.title, "Recovered update");
  state = new StateDb(statePath);
  assert.equal((state.getTicketGroup("TG-1")?.members[0]?.snapshot.definition as TicketDef).title, "Recovered update");
  state.close();
  const recoveredWorkflow = new WorkflowDb(projectDir);
  assert.equal(recoveredWorkflow.publication(publication.transactionId)?.status, "committed");
  assert.equal(recoveredWorkflow.getRun(run.runId)?.status, "completed");
  recoveredWorkflow.close();
});

test("threshold compaction records observable success and hands off instead of exceeding the maximum", async () => {
  const projectDir = root("rafi-compact-");
  const predecessor = new FakeAdapter("session-1", [], [
    { used: 60, maximum: 100, percentage: 60 },
    { used: 20, maximum: 100, percentage: 20 },
    { used: 70, maximum: 100, percentage: 70 },
  ]);
  const successor = new FakeAdapter("session-2", [], [{ used: 10, maximum: 100, percentage: 10 }]);
  let handoffs = 0;
  const controller = new ThresholdCompactionController({
    projectDir, runId: "run-1", role: "builder", initialSettings: SETTINGS,
    handoff: async () => { handoffs += 1; return successor; },
  });
  const first = await controller.atSafeBoundary(predecessor, "frozen action");
  assert.equal(first.action, "compacted");
  assert.equal(first.compactionCount, 1);
  // Re-arm below the threshold, then observe the next crossing on the same session.
  await controller.atSafeBoundary(predecessor, "frozen action");
  predecessor.advanceUsage();
  const second = await controller.atSafeBoundary(predecessor, "frozen action");
  assert.equal(second.action, "handed-off");
  assert.equal(second.adapter.sessionId(), "session-2");
  assert.equal(handoffs, 1);
  const db = new WorkflowDb(projectDir);
  assert.equal(db.successfulCompactionCount("run-1", "builder", predecessor.sessionRef()!), 1);
  db.close();
});

test("provider-native compactions are persisted and force a successor before another Builder turn", async () => {
  const projectDir = root("rafi-native-compact-");
  const predecessor = new FakeAdapter("session-1", [], [{ used: 20, maximum: 100, percentage: 20 }]);
  predecessor.nativeCompactions.push({ id: "native-1", occurredAt: "2026-01-01T00:00:00.000Z", provider: "codex" });
  const successor = new FakeAdapter("session-2", [], [{ used: 10, maximum: 100, percentage: 10 }]);
  const controller = new ThresholdCompactionController({
    projectDir, runId: "run-1", role: "builder", initialSettings: SETTINGS,
    handoff: async () => successor,
  });
  const result = await controller.atSafeBoundary(predecessor, "next frozen action");
  assert.equal(result.action, "handed-off");
  const db = new WorkflowDb(projectDir);
  assert.equal(db.successfulCompactionCount("run-1", "builder", predecessor.sessionRef()!), 1);
  db.close();
});

test("provider-native QA compactions are persisted against the disposable QA session", async () => {
  const projectDir = root("rafi-native-qa-compact-");
  const qa = new FakeAdapter("qa-session-1", [], [{ used: 20, maximum: 100, percentage: 20 }]);
  qa.nativeCompactions.push({ id: "native-qa-1", occurredAt: "2026-01-01T00:00:00.000Z", provider: "codex" });
  const controller = new ThresholdCompactionController({
    projectDir, runId: "run-1", role: "qa", initialSettings: { ...SETTINGS, role: "qa" },
  });
  assert.equal(await controller.observeNativeCompactions(qa), 1);
  const db = new WorkflowDb(projectDir);
  assert.equal(db.successfulCompactionCount("run-1", "qa", qa.sessionRef()!), 1);
  db.close();
});

test("an uncheckpointed provider turn is visible to recovery as uncertain", () => {
  const projectDir = root("rafi-uncheckpointed-turn-");
  const db = new WorkflowDb(projectDir);
  db.ensureRun("run-1");
  db.appendContinuityEvent({
    runId: "run-1", role: "host", kind: "turn_started", payload: { role: "builder" }, authoritativeStateRevision: 1,
  });
  assert.equal(db.hasUncheckpointedRoleTurn("run-1", "builder"), true);
  db.appendContinuityEvent({
    runId: "run-1", role: "builder", kind: "turn_completed", payload: {}, authoritativeStateRevision: 1,
  });
  assert.equal(db.hasUncheckpointedRoleTurn("run-1", "builder"), false);
  db.close();
});

test("a threshold-only live update reconfigures the active provider before acknowledgement", async () => {
  const projectDir = root("rafi-native-live-");
  const predecessor = new FakeAdapter("session-1", [], [{ used: 20, maximum: 100, percentage: 20 }]);
  let configured: number | undefined;
  predecessor.prepareAutoCompaction = async (threshold) => { configured = threshold; };
  const next = { ...SETTINGS, auto_compact_threshold_percent: 70, settings_revision: 2 };
  const controller = new ThresholdCompactionController({ projectDir, runId: "run-1", role: "builder", initialSettings: SETTINGS, readSettings: () => next });
  await controller.atSafeBoundary(predecessor, "frozen action");
  assert.equal(configured, 70);
  const db = new WorkflowDb(projectDir);
  assert.equal(db.settingsAcknowledgments(2)[0]?.providerSessionId, "session-1");
  db.close();
});

test("Builder and QA use a provider-clamped native ceiling at safe boundaries", async () => {
  for (const role of ["builder", "qa"] as const) {
    const projectDir = root(`rafi-clamped-${role}-`);
    const adapter = new FakeAdapter(`${role}-session`, [], [{ used: 75, maximum: 100, percentage: 75 }], { ok: true }, "claude");
    adapter.policy = {
      requestedThresholdPercent: 50,
      effectiveThresholdPercent: 79,
      modelContextWindow: 100,
      triggerTokens: 79,
    };
    const controller = new ThresholdCompactionController({
      projectDir,
      runId: `run-${role}`,
      role,
      initialSettings: { ...SETTINGS, role },
    });
    const result = await controller.atSafeBoundary(adapter, "frozen action");
    assert.equal(result.effectiveThreshold, 79);
    assert.equal(result.action, "below-threshold");
    assert.equal(adapter.compactCalls, 0);
  }
});

test("a newer live provider revision is acknowledged only after its validated settings boundary returns the requested provider", async () => {
  const projectDir = root("rafi-live-settings-");
  const predecessor = new FakeAdapter("session-1", [], [{ used: 20, maximum: 100, percentage: 20 }]);
  const successor = new FakeAdapter("session-2", [], [{ used: 20, maximum: 100, percentage: 20 }], { ok: true }, "claude");
  const next: ResolvedAgentSettings = { ...SETTINGS, make: "claude", model: "new-model", settings_revision: 2, auto_compact_threshold_percent: 80, compact_maximum: 2 };
  let transfers = 0;
  const controller = new ThresholdCompactionController({
    projectDir, runId: "run-1", role: "builder", initialSettings: SETTINGS,
    readSettings: () => next,
    settingsBoundary: async ({ current, next: requested }) => {
      transfers += 1;
      assert.equal(current.make, "codex");
      assert.equal(requested.make, "claude");
      return successor;
    },
  });
  const result = await controller.atSafeBoundary(predecessor, "frozen action");
  assert.equal(result.adapter, successor);
  assert.equal(result.action, "below-threshold");
  assert.equal(transfers, 1);
  const db = new WorkflowDb(projectDir);
  assert.equal(db.settingsAcknowledgments(2)[0]?.providerSessionId, "session-2");
  db.close();
});

test("a fresh successor that bootstraps above threshold compacts once and adopts only a run-local raised threshold", async () => {
  const projectDir = root("rafi-high-bootstrap-");
  const predecessor = new FakeAdapter("session-1", [], [{ used: 70, maximum: 100, percentage: 70 }]);
  const successor = new FakeAdapter("session-2", [], [
    { used: 70, maximum: 100, percentage: 70 },
    { used: 65, maximum: 100, percentage: 65 },
  ]);
  const controller = new ThresholdCompactionController({
    projectDir, runId: "run-1", role: "builder", initialSettings: SETTINGS,
    historicalCountUncertain: true,
    handoff: async () => successor,
  });
  const result = await controller.atSafeBoundary(predecessor, "frozen action");
  assert.equal(result.action, "handed-off");
  assert.equal(result.adapter, successor);
  assert.equal(successor.compactCalls, 1);
  assert.equal(result.sample.percentage, 65);
  assert.equal(result.effectiveThreshold, 75);
  assert.equal(controller.effectiveSettings().auto_compact_threshold_percent, 50);
});

test("validated handoff moves the sole role lease only after a fresh successor accepts", async () => {
  const projectDir = root("rafi-handoff-");
  const db = new WorkflowDb(projectDir);
  db.ensureRun("run-1");
  db.appendContinuityEvent({ runId: "run-1", role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1 });
  db.publishContinuityCheckpoint({ runId: "run-1", role: "builder", delta: EMPTY_DELTA, authoritativeStateRevision: 1 });
  db.claimInitialRoleLease("run-1", "builder", "session-1");
  db.close();
  const successor = new FakeAdapter("session-2");
  const transfer = await new HandoffService(projectDir).transfer({
    runId: "run-1", role: "builder", reason: "fresh boundary", predecessorSessionId: "session-1", compactionCount: 1, compactMaximum: 1,
  }, async () => successor);
  assert.equal(transfer.successorSessionId, "session-2");
  const after = new WorkflowDb(projectDir);
  assert.equal(after.roleMutationLease("run-1", "builder")?.runId, "run-1");
  assert.equal(after.roleMutationLease("run-1", "builder")?.role, "builder");
  assert.equal(after.roleMutationLease("run-1", "builder")?.generation, 1);
  assert.equal(after.roleMutationLease("run-1", "builder")?.providerSessionId, "session-2");
  assert.equal(after.roleMutationLease("run-1", "builder")?.sessionRef?.generation, 1);
  after.close();
});

test("a third consecutive unproductive Builder handoff request is fenced", () => {
  const projectDir = root("rafi-handoff-loop-");
  const db = new WorkflowDb(projectDir);
  db.ensureRun("run-1");
  db.appendContinuityEvent({ runId: "run-1", role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1 });
  db.publishContinuityCheckpoint({ runId: "run-1", role: "builder", delta: EMPTY_DELTA, authoritativeStateRevision: 1 });
  db.close();
  const service = new HandoffService(projectDir);
  for (let index = 0; index < 2; index++) {
    const events = new WorkflowDb(projectDir);
    events.appendContinuityEvent({ runId: "run-1", role: "builder", kind: "turn_completed", payload: { delta: EMPTY_DELTA }, authoritativeStateRevision: 1 });
    events.close();
    service.stage({ runId: "run-1", role: "builder", reason: `request ${index + 1}`, requestedByBuilder: true, compactionCount: 0, compactMaximum: 10 });
  }
  assert.throws(() => service.stage({ runId: "run-1", role: "builder", reason: "request 3", requestedByBuilder: true, compactionCount: 0, compactMaximum: 10 }), HandoffLoopError);
  const paused = new WorkflowDb(projectDir);
  assert.equal(paused.continuityHead("run-1", "builder")?.state, "degraded");
  assert.equal(paused.continuityEvents("run-1").at(-1)?.kind, "builder_handoff_loop_paused");
  paused.close();
});

test("continuity protocol repairs one invalid delta in-session and advances the durable head", async () => {
  const projectDir = root("rafi-continuity-");
  const provider = new FakeAdapter("session-1", [
    { text: "STEP_STATUS: done", isError: false, numTurns: 1, costUsd: 0 },
    { text: MARKER, isError: false, numTurns: 1, costUsd: 0 },
  ]);
  const adapter = new ContinuityAdapter({ adapter: provider, projectDir, runId: "run-1", role: "builder", settings: SETTINGS });
  const result = await adapter.sendTurn("do work");
  assert.equal(result.text, "STEP_STATUS: done");
  const db = new WorkflowDb(projectDir);
  assert.equal(db.continuityHead("run-1", "builder")?.state, "current");
  assert.equal(db.continuityCheckpoints("run-1", "builder").length, 2);
  assert.equal(db.roleMutationLease("run-1", "builder")?.providerSessionId, "session-1");
  db.close();
  await adapter.close();
});

test("double-invalid continuity uses a bundled handoff and moves the lease only after successor acceptance", async () => {
  const projectDir = root("rafi-continuity-handoff-");
  const predecessor = new FakeAdapter("session-1", [
    { text: "STEP_STATUS: done", isError: false, numTurns: 1, costUsd: 0 },
    { text: "still not a continuity delta", isError: false, numTurns: 1, costUsd: 0 },
  ]);
  const successor = new FakeAdapter("session-2");
  const adapter = new ContinuityAdapter({
    adapter: predecessor, projectDir, runId: "run-1", role: "builder", settings: SETTINGS,
    recoverWithHandoff: async ({ reason, reconstruction }) => {
      const transfer = await new HandoffService(projectDir).transfer({
        runId: "run-1", role: "builder", reason, predecessorSessionId: "session-1",
        allowNonCurrentContinuity: true, roleState: { reconstruction },
        compactionCount: 0, compactMaximum: 10,
      }, async () => successor);
      return transfer.successor;
    },
  });
  const result = await adapter.sendTurn("do work");
  assert.equal(result.text, "STEP_STATUS: done");
  assert.equal(predecessor.closed, true);
  const db = new WorkflowDb(projectDir);
  assert.equal(db.continuityHead("run-1", "builder")?.state, "current");
  assert.equal(db.handoffs("run-1").at(-1)?.state, "accepted");
  assert.equal(db.roleMutationLease("run-1", "builder")?.providerSessionId, "session-2");
  db.close();
  await adapter.close();
});
