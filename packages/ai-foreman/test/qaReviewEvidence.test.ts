import test from "node:test";
import assert from "node:assert/strict";
import type { RunSpanV1 } from "rafi-spec";
import { qaCommandOutputExcerptsAllowed, selectQaCommandObservations } from "../src/qaReviewEvidence.js";
import { buildQaInstruction } from "../src/foreman.js";
import { qaHostGraphFact } from "../src/qaHostFacts.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const span = (fields: Partial<RunSpanV1>): RunSpanV1 => ({ version: 1, spanId: "span", runId: "run", kind: "tool", name: "Bash", role: "builder", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:01Z", completionKnown: true, ...fields });

test("review instructions distinguish the disposable snapshot branch from the Builder branch", () => {
  assert.match(buildQaInstruction(), /detached HEAD even when the Builder's source workspace is on a named branch/);
  assert.match(buildQaInstruction(), /use independently retained source-workspace evidence/);
});

test("graph host fact distinguishes Rafi configuration from external graph adoption", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-qa-host-fact-"));
  try {
    const fact = qaHostGraphFact(root);
    assert.match(fact, /"adoption":"not-recorded"/);
    assert.match(fact, /"enabled":false/);
    assert.match(fact, /not any external Graphify installation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.match(qaHostGraphFact(join(root, "missing")), /unavailable/);
});

test("review evidence contains only bounded matching-ticket command metadata, never output or command", () => {
  const observations = selectQaCommandObservations([
    span({ spanId: "turn", kind: "provider_turn", ticketId: "T001" }),
    span({ spanId: "other-turn", kind: "provider_turn", ticketId: "T002" }),
    span({ spanId: "test", parentSpanId: "turn", outcome: "secret status", attributes: { input: { command: "npm test secret" }, outputSummary: "secret output", outputDigest: "secret digest", exitCode: 1 } }),
    span({ spanId: "wrong-ticket", parentSpanId: "other-turn", attributes: { input: { command: "npm test" } } }),
    span({ spanId: "unknown", parentSpanId: "turn", completionKnown: false, attributes: { input: { command: "npm test" } } }),
    span({ spanId: "other-run", runId: "elsewhere", parentSpanId: "turn", attributes: { input: { command: "npm test" } } }),
    span({ spanId: "rollback", parentSpanId: "turn", attributes: { input: { command: "rafi qa-rehearse-rollback" }, exitCode: 0 } }),
  ], "run", "T001");
  assert.equal(observations.length, 2);
  const serialized = JSON.stringify(observations);
  assert.doesNotMatch(serialized, /secret|npm test|rafi qa-rehearse-rollback|wrong-ticket|other-run/);
  assert.match(serialized, /rollback-rehearsal/);
});

test("review evidence is bounded and missing diagnostic data is harmless", () => {
  const turns = span({ spanId: "turn", kind: "provider_turn", ticketId: "T001" });
  const calls = Array.from({ length: 45 }, (_, index) => span({ spanId: String(index), parentSpanId: "turn", attributes: { input: { command: "node --test" } } }));
  assert.equal(selectQaCommandObservations([turns, ...calls], "run", "T001").length, 40);
  assert.deepEqual(selectQaCommandObservations([], "run", "T001"), []);
});

test("bounded output excerpts are delivered by default with explicit opt-out and ticket scoping", () => {
  assert.equal(qaCommandOutputExcerptsAllowed("T001", undefined), true);
  assert.equal(qaCommandOutputExcerptsAllowed("T001", ""), true);
  assert.equal(qaCommandOutputExcerptsAllowed("T001", "1"), true);
  for (const off of ["0", "off", "FALSE"]) assert.equal(qaCommandOutputExcerptsAllowed("T001", off), false);
  assert.equal(qaCommandOutputExcerptsAllowed("T001", "T001"), true);
  assert.equal(qaCommandOutputExcerptsAllowed("T002", "T001"), false);
  assert.equal(qaCommandOutputExcerptsAllowed("", undefined), false);
  const turns = span({ spanId: "turn", kind: "provider_turn", ticketId: "T001" });
  const call = span({ spanId: "test", parentSpanId: "turn", attributes: { input: { command: "npm test secret-command" }, outputSummary: "output:" + "x".repeat(2000) } });
  const observations = selectQaCommandObservations([turns, call], "run", "T001", true);
  const observation = observations[0] as { outputExcerpt: string; excerptMayBeTruncated: boolean };
  assert.equal(observation.outputExcerpt.length, 1000);
  assert.equal(observation.excerptMayBeTruncated, true);
  assert.doesNotMatch(JSON.stringify(observations), /secret-command/);
});

test("host Builder test observations retain a bounded output excerpt for red/green review", async () => {
  const { observeHostBuilderTests } = await import("../src/qaBuilderEvidence.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const workspace = mkdtempSync(join(tmpdir(), "host-excerpt-"));
  writeFileSync(join(workspace, "index.mjs"), "export {};\n");
  let listener: ((event: import("../src/adapters/types.js").BuilderEvent) => void) | undefined;
  const adapter = { observeEvents: (next: typeof listener) => { listener = next; return () => {}; } } as unknown as import("../src/adapters/types.js").BuilderAdapter;
  const observations: import("../src/qaBuilderEvidence.js").HostBuilderToolObservation[] = [];
  const stop = observeHostBuilderTests(adapter, workspace, observations);
  listener!({ kind: "tool", name: "Bash", input: { command: "node --test test/subtract.test.mjs" }, lifecycle: "started", callId: "c1" });
  listener!({ kind: "tool", name: "Bash", input: {}, lifecycle: "completed", callId: "c1", completionKnown: true, exitCode: 1, outputSummary: "not ok 1 - subtract is not a function " + "é".repeat(800) });
  stop();
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.outcome, "failed");
  assert.match(observations[0]!.outputExcerpt!, /^not ok 1 - subtract is not a function/);
  assert.ok(Buffer.byteLength(observations[0]!.outputExcerpt!) <= 1000);
  assert.doesNotMatch(observations[0]!.outputExcerpt!, /�/);
});
