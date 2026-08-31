import { test } from "node:test";
import assert from "node:assert/strict";
import type { BuilderAdapter, BuilderEvent, ContextUsage, ProviderSessionUsage, TurnResult } from "../src/adapters/types.js";
import { AgentStatusReporter, type AgentStatusReporterInput, type AgentStatusSnapshot, type StatusClock } from "../src/statusReporter.js";

class StatusAdapter implements BuilderAdapter {
  readonly agent = "codex" as const;
  context?: ContextUsage;
  usage?: ProviderSessionUsage;
  contextPolls = 0;
  async sendTurn(): Promise<TurnResult> { return { text: "", isError: false, numTurns: 1, costUsd: 0 }; }
  sessionId(): string | undefined { return "session-1"; }
  async contextUsage(): Promise<ContextUsage | undefined> { this.contextPolls += 1; return this.context; }
  async sessionUsage(): Promise<ProviderSessionUsage | undefined> { return this.usage; }
  async *events(): AsyncIterable<BuilderEvent> {}
  async close(): Promise<void> {}
}

const clock: StatusClock = {
  now: () => new Date("2026-08-28T12:00:00.000Z"),
  setInterval: () => 1,
  clearInterval: () => {},
};

test("status reporter never fabricates zero occupancy and marks unavailable then stale samples truthfully", async () => {
  const adapter = new StatusAdapter();
  const lines: string[] = [];
  const snapshots: AgentStatusSnapshot[] = [];
  const reporter = new AgentStatusReporter({
    runId: "run-1", role: "builder", provider: "codex", model: "gpt-test", reasoning: "high", fast: false,
    step: 1, total: 2, phase: "building", sessionTransition: "initial", settingsRevision: 3,
    displaySessionCost: false, adapter, compactionCount: 2, handoffGeneration: 1,
  }, (line, snapshot) => { lines.push(line); snapshots.push(snapshot); }, clock);
  reporter.start();
  assert.match(lines.at(-1) ?? "", /context measuring…/);
  assert.doesNotMatch(lines.at(-1) ?? "", /0%/);
  await reporter.tick();
  assert.match(lines.at(-1) ?? "", /context unavailable/);
  adapter.context = { used: 60, maximum: 120, percentage: 50, source: "provider-event", observedAt: "2026-08-28T11:59:59.000Z" };
  await reporter.tick();
  assert.match(lines.at(-1) ?? "", /context 50\.0% \(60\/120\)/);
  assert.equal(snapshots.at(-1)?.contextSample.settingsRevision, 3);
  assert.equal(snapshots.at(-1)?.contextSample.compactionCount, 2);
  adapter.context = undefined;
  await reporter.tick();
  assert.match(lines.at(-1) ?? "", /context 50\.0% \(60\/120\) stale/);
  reporter.stop();
});

test("session display prefers authoritative provider cost, falls back to tokens, and otherwise says unavailable", async () => {
  const adapter = new StatusAdapter();
  adapter.context = { used: 10, maximum: 100, percentage: 10 };
  const lines: string[] = [];
  const reporter = new AgentStatusReporter({
    runId: "run-1", role: "qa", provider: "codex", model: "gpt-test", reasoning: "medium", fast: false,
    step: 1, total: 1, phase: "QA review", sessionTransition: "QA session", settingsRevision: 1,
    displaySessionCost: true, adapter,
  }, (line) => lines.push(line), clock);
  reporter.start();
  adapter.usage = { totalTokens: 1234, authoritativeCostUsd: 0.42, observedAt: "2026-08-28T12:00:00.000Z", source: "provider" };
  await reporter.tick();
  assert.match(lines.at(-1) ?? "", /session cost \$0\.4200 \(provider\)/);
  adapter.usage = { inputTokens: 1000, outputTokens: 234, totalTokens: 1234, observedAt: "2026-08-28T12:00:00.000Z", source: "provider" };
  await reporter.tick();
  assert.match(lines.at(-1) ?? "", /session tokens 1234/);
  adapter.usage = undefined;
  await reporter.tick();
  assert.match(lines.at(-1) ?? "", /session usage unavailable/);
  reporter.stop();
});

test("coordinated status uses the enforcement sample, exposes policy state, and invalidates pre-compact occupancy immediately", async () => {
  const adapter = new StatusAdapter();
  adapter.context = { used: 90, maximum: 100, percentage: 90 };
  const baseSample = {
    version: 1 as const, runId: "run-1", role: "builder" as const, provider: "codex" as const,
    providerSessionId: "session-1", model: "gpt-test", observedAt: "2026-08-28T12:00:00.000Z",
    source: "provider-event" as const, freshness: "fresh" as const, used: 20, maximum: 100, percentage: 20,
    settingsRevision: 4, compactionCount: 3, handoffGeneration: 1, sequence: 7, thresholdGeneration: 2,
  };
  let coordinated: NonNullable<ReturnType<NonNullable<AgentStatusReporterInput["contextSnapshot"]>>> = {
    role: "builder" as const, provider: "codex" as const, model: "gpt-test", lifecycleState: "armed",
    contextSample: baseSample, configuredCeilingPercent: 50, installedNativeTokenLimit: 4800,
    installedNativePercent: 48, compactionCount: 3, compactMaximum: 10, settingsRevision: 4,
  };
  const lines: string[] = [];
  const snapshots: AgentStatusSnapshot[] = [];
  const reporter = new AgentStatusReporter({
    runId: "run-1", role: "builder", provider: "codex", model: "gpt-test", reasoning: "high", fast: false,
    step: 1, total: 1, phase: "building", sessionTransition: "same session", settingsRevision: 1,
    displaySessionCost: false, adapter, contextSnapshot: () => coordinated,
  }, (line, snapshot) => { lines.push(line); snapshots.push(snapshot); }, clock);
  await reporter.tick();
  assert.equal(adapter.contextPolls, 0, "status must not independently poll occupancy when a coordinator exists");
  assert.match(lines.at(-1) ?? "", /context 20\.0%/);
  assert.match(lines.at(-1) ?? "", /ceiling=50%/);
  assert.match(lines.at(-1) ?? "", /native=48\.0%\/4800/);
  assert.match(lines.at(-1) ?? "", /state=armed/);
  assert.match(lines.at(-1) ?? "", /compactions=3\/10/);
  assert.equal(snapshots.at(-1)?.settingsRevision, 4);

  coordinated = {
    ...coordinated,
    lifecycleState: "compacted_unverified",
    contextSample: { ...baseSample, source: "post-compact", freshness: "measuring", used: undefined, maximum: undefined, percentage: undefined },
  };
  await reporter.tick();
  assert.match(lines.at(-1) ?? "", /context measuring…/);
  assert.doesNotMatch(lines.at(-1) ?? "", /20\.0%|90\.0%/);
  assert.match(lines.at(-1) ?? "", /state=verifying/);
  reporter.stop();
});
