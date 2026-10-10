import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseQaResponseContract, type ContinuityDelta, type ProviderSessionRefV1, type ResolvedAgentSettings } from "rafi-spec";
import type { BuilderAdapter, BuilderEvent, CompactResult, ContextUsage, NativeAutoCompactionPolicy, NativeCompaction, TurnResult } from "../src/adapters/types.js";
import { ContinuityAdapter } from "../src/continuity.js";
import { HANDOFF_ACCEPTED, HandoffAcceptanceError, HandoffLoopError, HandoffService } from "../src/handoffs.js";
import { ThresholdCompactionController } from "../src/sessionLifecycle.js";
import { applyTicketPopulation, recoverTicketPublications } from "../src/ticketPopulation.js";
import { cmdInit } from "../src/tickets/commands.js";
import { StateDb } from "../src/tickets/stateDb.js";
import { loadTickets } from "../src/tickets/ticketLoader.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { SessionUnavailableError } from "../src/adapters/sessionFailure.js";
import { providerSessionKey } from "../src/sessionIdentity.js";

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
      source: "observed", createdAt: "2026-01-01T00:00:00.000Z", validatedAt: "2026-01-01T00:00:00.000Z",
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

test("uncertain compaction survives restart and late completion stays with its original session", async () => {
  const projectDir = root("rafi-late-compact-");
  const adapter = new FakeAdapter("session-1", [], [{ used: 60, maximum: 100, percentage: 60 }]);
  let listener: ((event: BuilderEvent) => void) | undefined;
  Object.assign(adapter, { observeEvents: (next: (event: BuilderEvent) => void) => { listener = next; return () => { listener = undefined; }; } });
  adapter.compact = async () => {
    adapter.compactCalls++;
    const failure = new SessionUnavailableError({ runtime: "codex", phase: "turn", dispatchState: "unknown", executable: "codex", cwd: projectDir, diagnostics: "compaction wait expired" });
    return { ok: false, error: failure.message, failure: failure.failure };
  };
  let handoffs = 0;
  const options = { projectDir, runId: "run", role: "builder" as const, initialSettings: SETTINGS, handoff: async () => { handoffs++; return new FakeAdapter("successor"); } };
  await assert.rejects(new ThresholdCompactionController(options).atSafeBoundary(adapter, "first action"), /expired/);
  const reopened = new ThresholdCompactionController(options);
  await assert.rejects(reopened.atSafeBoundary(adapter, "changed action"), /unresolved outcome/);
  await assert.rejects(reopened.atWorkSessionBoundary(adapter, "fresh action", "fresh"), /unresolved outcome/);
  assert.equal(adapter.compactCalls, 1); assert.equal(handoffs, 0);
  const db = new WorkflowDb(projectDir);
  try {
    assert.equal(db.unresolvedCompactions("run", "builder", providerSessionKey(adapter.sessionRef()!))[0]!.status, "uncertain");
    listener!({ kind: "session-transition", transition: "compacted" });
    listener!({ kind: "session-transition", transition: "compacted" });
    assert.equal(db.unresolvedCompactions("run", "builder", providerSessionKey(adapter.sessionRef()!)).length, 0);
    assert.equal(db.successfulCompactionCount("run", "builder", adapter.sessionRef()!), 1);
    assert.equal(db.successfulCompactionCount("run", "builder", new FakeAdapter("successor").sessionRef()!), 0);
    assert.equal(db.continuityEvents("run").filter(event => event.kind === "late_compaction_completion").length, 1);
  } finally { db.close(); }
});
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
    runId: "run-1", role: "qa", kind: "handback_turn_completed", payload: {}, authoritativeStateRevision: 1,
  });
  assert.equal(db.hasUncheckpointedRoleTurn("run-1", "builder"), true, "a different role cannot clear Builder uncertainty");
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

test("recovery handoff returns and durably indexes the exact complete acceptance receipt", async () => {
  const projectDir = root("rafi-recovery-receipt-");
  const db = new WorkflowDb(projectDir);
  db.ensureRun("run-1");
  db.appendContinuityEvent({ runId: "run-1", role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1 });
  db.publishContinuityCheckpoint({ runId: "run-1", role: "builder", delta: EMPTY_DELTA, authoritativeStateRevision: 1 });
  db.close();
  const transfer = await new HandoffService(projectDir).transfer({
    runId: "run-1", role: "builder", reason: "recover exact packet", compactionCount: 0, compactMaximum: 10,
    resources: [{ label: "packet/manifest.json", content: "packet", authoritative: true, requiredForRecovery: true, path: "packet/manifest.json", purpose: "Authoritative recovery packet manifest", mediaType: "application/json" }],
  }, async () => new FakeAdapter("session-2"));
  assert.ok(transfer.acceptanceReceipt);
  const resource = transfer.acceptanceReceipt.resources.find((item) => item.label === "packet/manifest.json");
  assert.deepEqual(resource, {
    label: "packet/manifest.json", digest: createHash("sha256").update("packet").digest("hex"), authoritative: true,
    requiredForRecovery: true, mediaType: "application/json", path: "packet/manifest.json",
    purpose: "Authoritative recovery packet manifest", bytes: 6,
  });
  assert.equal(transfer.acceptanceReceipt.acceptanceCheckpointDigest, transfer.acceptanceCheckpointDigest);
  const after = new WorkflowDb(projectDir);
  assert.match(after.handoff("run-1", transfer.manifest.generation)?.acceptanceReceiptDigest ?? "", /^[a-f0-9]{64}$/);
  after.close();
});

test("recovery handoff fails closed without a scoped successor identity", async () => {
  class UnscopedAdapter extends FakeAdapter { override sessionRef(): undefined { return undefined; } }
  const projectDir = root("rafi-recovery-unscoped-");
  const db = new WorkflowDb(projectDir);
  db.ensureRun("run-1");
  db.appendContinuityEvent({ runId: "run-1", role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1 });
  db.publishContinuityCheckpoint({ runId: "run-1", role: "builder", delta: EMPTY_DELTA, authoritativeStateRevision: 1 });
  db.close();
  await assert.rejects(
    new HandoffService(projectDir).transfer({
      runId: "run-1", role: "builder", reason: "recover exact packet", compactionCount: 0, compactMaximum: 10,
      resources: [{ label: "packet", content: "packet", authoritative: true, requiredForRecovery: true, purpose: "Recovery packet", bytes: 6 }],
    }, async () => new UnscopedAdapter("session-2")),
    (error: unknown) => error instanceof Error && error.name === "HumanDecisionRequired" && error.message.includes("missing-scoped-successor-session"),
  );
  const persisted = new WorkflowDb(projectDir);
  try { assert.equal(persisted.pendingHumanDecisions("run-1").length, 1); assert.equal(persisted.roleMutationLease("run-1", "builder"), undefined); }
  finally { persisted.close(); }
});

test("handoff acceptance gives a malformed acknowledgement one bounded correction turn", async () => {
  const projectDir = root("rafi-handoff-correction-");
  const db = new WorkflowDb(projectDir);
  db.ensureRun("run-1");
  db.appendContinuityEvent({ runId: "run-1", role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1 });
  db.publishContinuityCheckpoint({ runId: "run-1", role: "builder", delta: EMPTY_DELTA, authoritativeStateRevision: 1 });
  db.claimInitialRoleLease("run-1", "builder", "session-1");
  db.close();
  const successor = new FakeAdapter("session-2", [
    { text: "I accept, but used the wrong protocol", isError: false, numTurns: 1, costUsd: 0 },
    { text: `${HANDOFF_ACCEPTED}\n${MARKER}`, isError: false, numTurns: 1, costUsd: 0 },
  ]);

  const transfer = await new HandoffService(projectDir).transfer({
    runId: "run-1", role: "builder", reason: "fresh boundary", predecessorSessionId: "session-1", compactionCount: 0, compactMaximum: 10,
  }, async () => successor);

  assert.equal(transfer.successorSessionId, "session-2");
  assert.equal(successor.closed, false);
});

test("handoff rejection reports the precise typed cause and retains the predecessor lease", async () => {
  const projectDir = root("rafi-handoff-rejection-");
  const db = new WorkflowDb(projectDir);
  db.ensureRun("run-1");
  db.appendContinuityEvent({ runId: "run-1", role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1 });
  db.publishContinuityCheckpoint({ runId: "run-1", role: "builder", delta: EMPTY_DELTA, authoritativeStateRevision: 1 });
  db.claimInitialRoleLease("run-1", "builder", "session-1");
  db.close();
  const service = new HandoffService(projectDir);
  const staged = service.stage({ runId: "run-1", role: "builder", reason: "fresh boundary", predecessorSessionId: "session-1", compactionCount: 0, compactMaximum: 10 });
  const successor = new FakeAdapter("session-2", [
    { text: "wrong", isError: false, numTurns: 1, costUsd: 0 },
    { text: "still wrong", isError: false, numTurns: 1, costUsd: 0 },
  ]);

  await assert.rejects(
    service.acceptStaged(staged, successor),
    (error: unknown) => error instanceof HandoffAcceptanceError && error.code === "missing-acknowledgement" && /predecessor retains the lease/.test(error.message),
  );
  const after = new WorkflowDb(projectDir);
  assert.equal(after.roleMutationLease("run-1", "builder")?.providerSessionId, "session-1");
  assert.equal(after.handoff("run-1", staged.manifest.generation)?.state, "failed");
  after.close();
  assert.equal(successor.closed, true);
});

test("handoff recovery can switch to a verified provider and records it only after acceptance", async () => {
  const projectDir = root("rafi-handoff-switch-");
  const db = new WorkflowDb(projectDir);
  db.ensureRun("run-1");
  db.appendContinuityEvent({ runId: "run-1", role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1 });
  db.publishContinuityCheckpoint({ runId: "run-1", role: "builder", delta: EMPTY_DELTA, authoritativeStateRevision: 1 });
  db.claimInitialRoleLease("run-1", "builder", "session-1");
  db.close();
  const rejected = new FakeAdapter("session-2", [
    { text: "wrong", isError: false, numTurns: 1, costUsd: 0 },
    { text: "still wrong", isError: false, numTurns: 1, costUsd: 0 },
  ], undefined, undefined, "codex");
  const accepted = new FakeAdapter("session-3", [], undefined, undefined, "claude");
  let acceptedProvider: string | undefined;
  const requested: Array<string | undefined> = [];

  const transfer = await new HandoffService(projectDir).transfer({
    runId: "run-1", role: "builder", reason: "fresh boundary", predecessorSessionId: "session-1", compactionCount: 0, compactMaximum: 10,
  }, async (_staged, runtime) => {
    requested.push(runtime);
    return runtime === "claude" ? accepted : rejected;
  }, {
    allowProviderSwitch: true,
    choose: async () => "switch",
    onAccepted: (result) => { acceptedProvider = result.successor.agent; },
  });

  assert.deepEqual(requested, [undefined, "claude"]);
  assert.equal(transfer.successor.agent, "claude");
  assert.equal(acceptedProvider, "claude");
  const after = new WorkflowDb(projectDir);
  assert.equal(after.roleMutationLease("run-1", "builder")?.providerSessionId, "session-3");
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

test("validated handback progress resets the Builder handoff limit without counting another role's work", () => {
  const projectDir = root("rafi-handoff-progress-");
  const db = new WorkflowDb(projectDir);
  try {
    db.ensureRun("run-1");
    db.publishContinuityCheckpoint({ runId: "run-1", role: "builder", delta: EMPTY_DELTA, authoritativeStateRevision: 1 });
    for (let index = 0; index < 2; index++) db.appendContinuityEvent({ runId: "run-1", role: "host", kind: "builder_handoff_requested", payload: { request: index + 1 }, authoritativeStateRevision: 1 });
    const delta = { ...EMPTY_DELTA, completedActions: ["Addressed the QA finding"] };
    db.appendContinuityEvent({ runId: "run-1", role: "qa", kind: "turn_completed", payload: { delta }, authoritativeStateRevision: 1 });
    const service = new HandoffService(projectDir);
    assert.throws(() => service.stage({ runId: "run-1", role: "builder", reason: "still no Builder progress", requestedByBuilder: true, compactionCount: 0, compactMaximum: 10 }), HandoffLoopError);
    db.appendContinuityEvent({ runId: "run-1", role: "builder", kind: "handback_turn_completed", payload: { delta }, authoritativeStateRevision: 1 });
    db.publishContinuityCheckpoint({ runId: "run-1", role: "builder", delta, authoritativeStateRevision: 1 });
    assert.doesNotThrow(() => service.stage({ runId: "run-1", role: "builder", reason: "progress after QA", requestedByBuilder: true, compactionCount: 0, compactMaximum: 10 }));
  } finally { db.close(); }
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

test("continuity preserves the adapter's exact provider instruction", async () => {
  const projectDir = root("rafi-continuity-provider-prompt-");
  const provider = new FakeAdapter("session-provider-prompt");
  provider.sendTurn = async (instruction?: string) => ({ text: `STEP_STATUS: done\n${MARKER}`, isError: false, numTurns: 1, costUsd: 0,
    hostInstruction: instruction, providerInstruction: `ROLE-AND-SKILLS\n${instruction ?? ""}` });
  const adapter = new ContinuityAdapter({ adapter: provider, projectDir, runId: "run-provider-prompt", role: "builder", settings: SETTINGS });
  const result = await adapter.sendTurn("host action");
  assert.equal(result.hostInstruction, "host action");
  assert.match(result.providerInstruction ?? "", /^ROLE-AND-SKILLS\nhost action/);
  assert.match(result.providerInstruction ?? "", /RAFI_CONTINUITY_DELTA/);
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

test("legacy continuity successor fallback requires an exact first-line acceptance marker", async () => {
  const projectDir = root("rafi-continuity-exact-acceptance-");
  const predecessor = new FakeAdapter("session-1", [
    { text: "STEP_STATUS: done", isError: false, numTurns: 1, costUsd: 0 },
    { text: "still not a continuity delta", isError: false, numTurns: 1, costUsd: 0 },
  ]);
  const successor = new FakeAdapter("session-2", [
    { text: `HANDOFF_ACCEPTED extra text\n${MARKER}`, isError: false, numTurns: 1, costUsd: 0 },
  ]);
  const adapter = new ContinuityAdapter({
    adapter: predecessor, projectDir, runId: "run-1", role: "builder", settings: SETTINGS,
    createSuccessor: async () => successor,
  });

  await assert.rejects(adapter.sendTurn("do work"), /fresh successor did not validate/);
  assert.equal(successor.closed, true);
  await adapter.close();
});

test("QA single-turn continuity errors remain typed and preserve the completed provider evidence", async () => {
  const projectDir = root("rafi-qa-continuity-error-");
  const original = { text: 'STEP_STATUS: qa_pass | summary="reviewed"', isError: false, numTurns: 1, costUsd: 0, turnId: "observed-review" };
  const adapter = new FakeAdapter("qa-missing-marker", [original]);
  adapter.adoptSessionRef({ ...adapter.sessionRef()!, role: "qa", stream: "qa", cwd: projectDir, configRoot: projectDir });
  let dispatchedInstruction = "";
  const send = adapter.sendTurn.bind(adapter);
  adapter.sendTurn = async (...args: unknown[]) => { dispatchedInstruction = String(args[0]); return send(); };
  const wrapper = new ContinuityAdapter({ projectDir, runId: "run", role: "qa", settings: { ...SETTINGS, role: "qa" }, adapter, durableSingleTurn: true });
  try {
    const result = await wrapper.sendTurn("review current source");
    assert.equal(result.isError, true);
    assert.deepEqual(result.continuityErrors, ["missing continuity marker"]);
    assert.match(dispatchedInstruction, /required even when the review requests only a report or status/);
    assert.match(dispatchedInstruction, /before RAFI_QA_FAILURE_REPORT_START/);
    assert.equal(result.rawResponse, original.text);
    assert.equal(result.turnId, original.turnId);
    assert.equal(result.failure, undefined);
    const db = new WorkflowDb(projectDir);
    try {
      assert.equal(db.unresolvedRoleDispatches("run", "qa").length, 0);
      assert.equal(db.continuityHead("run", "qa")?.state, "current", "the valid baseline remains available for a fresh handoff");
    } finally { db.close(); }
  } finally { await wrapper.close(); }
});


test("QA continuity can precede the failure envelope without breaking report validation", async () => {
  const projectDir = root("rafi-qa-continuity-format-");
  const report = { version: 1, summary: "Missing guard", checks_run: [{ check: "inspection", outcome: "failed", evidence: "guard absent" }],
    findings: [{ id: "F1", requirement: "guard", locations: ["source.ts"], problem: "guard absent", evidence: "inspection", expected: "guard present", fix_direction: "add guard", verification: ["inspect source"] }], observations: [] };
  const text = `${MARKER}\nRAFI_QA_FAILURE_REPORT_START\n${JSON.stringify(report)}\nRAFI_QA_FAILURE_REPORT_END\nSTEP_STATUS: qa_fail | issues="Missing guard"`;
  const adapter = new FakeAdapter("qa-complete-marker", [{ text, isError: false, numTurns: 1, costUsd: 0 }]);
  adapter.adoptSessionRef({ ...adapter.sessionRef()!, role: "qa", stream: "qa", cwd: projectDir, configRoot: projectDir });
  const wrapper = new ContinuityAdapter({ projectDir, runId: "run", role: "qa", settings: { ...SETTINGS, role: "qa" }, adapter, durableSingleTurn: true });
  try {
    const result = await wrapper.sendTurn("return the exact QA report");
    assert.equal(result.isError, false);
    assert.equal(parseQaResponseContract(result.text).valid, true);
    assert.equal(result.rawResponse, text);
    assert.doesNotMatch(result.text, /RAFI_CONTINUITY_DELTA/);
  } finally { await wrapper.close(); }
});

for (const role of ["builder", "qa"] as const) for (const outcome of ["valid", "invalid", "error", "unknown"] as const) test(`fresh recovery validates new ownership before context probes: ${role}/${outcome}`, async () => {
  const { rmSync } = await import("node:fs");
  const projectDir = root("rafi-fresh-owner-");
  const db = new WorkflowDb(projectDir);
  try {
    db.claimInitialRoleLease("run", role, { ...new FakeAdapter("old").sessionRef()!, role });
    if (outcome === "unknown") {
      db.planOperation({ runId: "run", idempotencyKey: "old-dispatch", kind: "provider-dispatch", intent: { role } });
      db.updateOperation("old-dispatch", "in_progress");
      db.updateOperation("old-dispatch", "uncertain");
    }
    let turns = 0;
    const adapter = new FakeAdapter("fresh");
    adapter.adoptSessionRef({ ...adapter.sessionRef()!, role });
    adapter.sendTurn = async (...args: unknown[]) => {
      turns++;
      assert.equal((args[1] as { responseOnly?: boolean }).responseOnly, true);
      return { text: outcome === "invalid" ? "missing continuity" : MARKER, isError: outcome === "error", numTurns: 1, costUsd: 0 };
    };
    const continuous = new ContinuityAdapter({ adapter, projectDir, runId: "run", role, settings: { ...SETTINGS, role }, durableSingleTurn: role === "qa", replaceRecoveryLeaseAfterCheckpoint: true });
    if (outcome === "valid") {
      await continuous.validateFreshRecovery();
      assert.equal(db.roleMutationLease("run", role)?.providerSessionId, "fresh");
      await continuous.validateFreshRecovery(); assert.equal(turns, 1);
    } else {
      await assert.rejects(continuous.validateFreshRecovery(), /checkpoint|completion/);
      assert.equal(db.roleMutationLease("run", role)?.providerSessionId, "old");
      assert.equal(turns, outcome === "unknown" ? 0 : 1);
      assert.equal(adapter.closed, true, "failed validation must close the unused replacement");
    }
    await continuous.close();
  } finally { db.close(); rmSync(projectDir, { recursive: true, force: true }); }
});

test("legacy missing threshold waits until 65 percent while explicit 50 stays configurable", async () => {
  const projectDir = root("rafi-default-compact-");
  const { auto_compact_threshold_percent: _missing, ...legacy } = SETTINGS;
  const adapter = new FakeAdapter("default-session", [], [
    { used: 60, maximum: 100, percentage: 60 },
    { used: 65, maximum: 100, percentage: 65 },
    { used: 20, maximum: 100, percentage: 20 },
  ]);
  const controller = new ThresholdCompactionController({ projectDir, runId: "default-run", role: "builder", initialSettings: legacy as ResolvedAgentSettings });
  const below = await controller.atSafeBoundary(adapter, "frozen work");
  assert.equal(below.effectiveThreshold, 65);
  assert.equal(below.action, "below-threshold");
  assert.equal(adapter.compactCalls, 0);
  adapter.advanceUsage();
  assert.equal((await controller.atSafeBoundary(adapter, "frozen work")).action, "compacted");
  assert.equal(adapter.compactCalls, 1);
  const explicit = new ThresholdCompactionController({ projectDir: root("rafi-explicit-compact-"), runId: "explicit-run", role: "builder", initialSettings: SETTINGS });
  assert.equal(explicit.effectiveSettings().auto_compact_threshold_percent, 50);
});
