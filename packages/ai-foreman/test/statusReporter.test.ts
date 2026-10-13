import { test } from "node:test";
import assert from "node:assert/strict";
import type { BuilderAdapter, BuilderEvent, ContextUsage, ProviderSessionUsage, TurnResult } from "../src/adapters/types.js";
import { AgentStatusReporter, type AgentStatusSnapshot, type StatusClock } from "../src/statusReporter.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStatus } from "../src/cli/status.js";

test("status uses durable completion when a branch log lacks batch-end", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-completed-status-"));
  const original = console.log; const lines: string[] = [];
  try {
    mkdirSync(join(root, ".foreman/runs"), { recursive: true });
    writeFileSync(join(root, ".foreman/runs/done.json"), JSON.stringify({ version: 1, runId: "done", status: "completed", branchMode: "branch-per-ticket", tickets: ["T1"], checkpoint: "completed", repository: { root, worktree: root }, receipts: {}, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" }));
    writeFileSync(join(root, ".foreman/2026-01-01.jsonl"), JSON.stringify({ event: "audit", runId: "non-build-audit" }) + "\n" + JSON.stringify({ event: "branch-complete", runId: "done", ticket: "T1" }) + "\n");
    console.log = (...args) => { lines.push(args.join(" ")); };
    runStatus(root);
    assert.match(lines.join("\n"), /outcome.*completed/);
    assert.doesNotMatch(lines.join("\n"), /still in progress/);
  } finally { console.log = original; rmSync(root, { recursive: true, force: true }); }
});

test("status recognizes an unambiguous legacy branch completion without runId", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-legacy-completed-status-"));
  const original = console.log; const lines: string[] = [];
  try {
    mkdirSync(join(root, ".foreman/runs"), { recursive: true });
    writeFileSync(join(root, ".foreman/runs/done.json"), JSON.stringify({ version: 1, runId: "done", status: "completed", branchMode: "branch-per-ticket", tickets: ["T1"], checkpoint: "completed", repository: { root, worktree: root }, receipts: {}, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" }));
    // This is the shape produced by released branch runners before runId was
    // added to branch events.
    writeFileSync(join(root, ".foreman/2026-01-01.jsonl"), JSON.stringify({ ts: "2026-01-01T00:00:01Z", event: "branch-complete", ticket: "T1", branch: "rafi/T1", status: "done" }) + "\n");
    console.log = (...args) => { lines.push(args.join(" ")); };
    runStatus(root);
    assert.match(lines.join("\n"), /outcome.*completed/);
    assert.doesNotMatch(lines.join("\n"), /still in progress/);
  } finally { console.log = original; rmSync(root, { recursive: true, force: true }); }
});

test("status refuses ambiguous legacy branch completion", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-ambiguous-legacy-status-"));
  const original = console.log; const lines: string[] = [];
  try {
    mkdirSync(join(root, ".foreman/runs"), { recursive: true });
    for (const runId of ["one", "two"]) writeFileSync(join(root, `.foreman/runs/${runId}.json`), JSON.stringify({ version: 1, runId, status: "completed", branchMode: "branch-per-ticket", tickets: ["T1"], checkpoint: "completed", repository: { root, worktree: root }, receipts: {}, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" }));
    writeFileSync(join(root, ".foreman/2026-01-01.jsonl"), JSON.stringify({ event: "branch-complete", ticket: "T1" }) + "\n");
    console.log = (...args) => { lines.push(args.join(" ")); };
    runStatus(root);
    assert.match(lines.join("\n"), /in progress or did not finish/);
  } finally { console.log = original; rmSync(root, { recursive: true, force: true }); }
});

test("status does not borrow completion from an unrelated retained run", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-unmatched-status-"));
  const original = console.log; const lines: string[] = [];
  try {
    mkdirSync(join(root, ".foreman/runs"), { recursive: true });
    writeFileSync(join(root, ".foreman/runs/done.json"), JSON.stringify({ version: 1, runId: "old-done", status: "completed", branchMode: "branch-per-ticket", tickets: ["T1"], checkpoint: "completed", repository: { root, worktree: root }, receipts: {}, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" }));
    writeFileSync(join(root, ".foreman/2026-02-01.jsonl"), JSON.stringify({ event: "branch-complete", runId: "old-done" }) + "\n" + JSON.stringify({ event: "step", runId: "new-not-retained" }) + "\n");
    console.log = (...args) => { lines.push(args.join(" ")); };
    runStatus(root);
    assert.doesNotMatch(lines.join("\n"), /outcome.*completed/);
    assert.match(lines.join("\n"), /in progress or did not finish/);
  } finally { console.log = original; rmSync(root, { recursive: true, force: true }); }
});

test("status retains completed branch outcome when later audit records have another run ID", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-branch-completed-status-"));
  const original = console.log; const lines: string[] = [];
  try {
    mkdirSync(join(root, ".foreman/runs"), { recursive: true });
    writeFileSync(join(root, ".foreman/runs/done.json"), JSON.stringify({ version: 1, runId: "done", status: "completed", branchMode: "branch-per-ticket", tickets: ["T1"], checkpoint: "completed", repository: { root, worktree: root }, receipts: {}, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" }));
    writeFileSync(join(root, ".foreman/2026-01-01.jsonl"), JSON.stringify({ event: "branch-complete", runId: "done", ticket: "T1" }) + "\n" + JSON.stringify({ event: "audit-complete", runId: "audit-after-build" }) + "\n");
    console.log = (...args) => { lines.push(args.join(" ")); };
    runStatus(root);
    assert.match(lines.join("\n"), /outcome.*completed/);
    assert.doesNotMatch(lines.join("\n"), /still in progress/);
  } finally { console.log = original; rmSync(root, { recursive: true, force: true }); }
});

class StatusAdapter implements BuilderAdapter {
  readonly agent = "codex" as const;
  context?: ContextUsage;
  usage?: ProviderSessionUsage;
  async sendTurn(): Promise<TurnResult> { return { text: "", isError: false, numTurns: 1, costUsd: 0 }; }
  sessionId(): string | undefined { return "session-1"; }
  async contextUsage(): Promise<ContextUsage | undefined> { return this.context; }
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


test("ending observation does not imply completion and explicit pause remains visible", () => {
  for (const phase of [undefined, "paused", "completed"]) {
    const lines: string[] = [];
    const reporter = new AgentStatusReporter({
      runId: "run-1", role: "builder", provider: "codex", model: "test", reasoning: "high", fast: false,
      step: 1, total: 1, phase: "building", sessionTransition: "initial", settingsRevision: 1,
      displaySessionCost: false, adapter: new StatusAdapter(),
    }, line => lines.push(line), clock);
    reporter.start(); reporter.stop(phase);
    assert.ok(lines.at(-1)?.includes(`activity=${phase ?? "stopped"}`));
  }
});
