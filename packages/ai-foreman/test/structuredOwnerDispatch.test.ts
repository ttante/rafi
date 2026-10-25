import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, providerWireContract, qaVerdictOutput, workReportOutput } from "rafi-spec";
import type { BuilderAdapter } from "../src/adapters/types.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { journalStructuredDispatch, nativePolicy } from "../src/structuredOperation.js";
import { dispatchWithGraphAccess } from "../src/graph/session.js";
import { verifyPersistedDispatch } from "../src/structuredDispatchRecord.js";
import { canonicalFixtureTurn } from "./helpers/nativeOutput.js";
import { assertActiveProviderDispatch, withSealedDispatch, withEphemeralInitializationDispatch } from "../src/structuredDispatchAuthority.js";
import { admitFixtureWork } from "./helpers/workAdmission.js";

for (const owner of ["generic", "qa-review"] as const) test(`${owner} commits one immutable owner tuple before send and verifies replay`, async () => {
  const root = mkdtempSync(join(tmpdir(), "sealed-owner-"));
  const db = new WorkflowDb(root);
  const ref = { version: 1 as const, provider: "codex" as const, sessionId: "prepared", role: owner === "qa-review" ? "qa" as const : "builder" as const,
    stream: owner === "qa-review" ? "qa" : "builder", generation: 2, cwd: root, configRoot: root, source: "observed" as const, createdAt: new Date(0).toISOString() };
  const output: import("rafi-spec").OutputContract = owner === "qa-review" ? qaVerdictOutput : workReportOutput;
  let prepares = 0, sends = 0;
  db.ensureRun("run");
  if (owner === "qa-review") admitFixtureWork(db, "run", "T1");
  if (owner === "qa-review") db.beginQaTurn({ version: 2, operationId: "dispatch", runId: "run", ticketId: "T1", reviewNumber: 1, sessionGeneration: 2, slot: "initial",
    sourceStateDigest: "source", reviewBasisDigest: "basis", providerSession: { ...ref, version: 2, role: "qa", stream: "qa", validatedAt: ref.createdAt }, instructionDigest: "initial", intendedAt: ref.createdAt,
    outputContract: { protocolVersion: 2, operation: output.operation, schemaVersion: output.schemaVersion, schemaDigest: output.schemaDigest } });
  const adapter: BuilderAdapter = { agent: "codex", sessionId: () => ref.sessionId, sessionRef: () => ref,
    async prepareSession() { prepares++; assert.equal((db.operation("dispatch")!.intent as { state: string }).state, "preparing"); return ref; },
    async sendTurn(instruction, policy) {
      assertActiveProviderDispatch(policy!, instruction, "codex", ref);
      assert.throws(() => assertActiveProviderDispatch(policy!, instruction, "codex", ref), /already submitted/);
      sends++;
      assert.equal(db.operation("dispatch")!.status, "in_progress");
      assert.equal(db.structuredOwnerDispatch("dispatch").tupleDigest, policy!.selectedDispatch!.digest);
      const payload = owner === "qa-review" ? { kind: "passed", coverage: null, verifiedInstructionIds: [] }
        : { disposition: "modified", evidence: ["observed"], coverage: null, graphMaintenance: null };
      return canonicalFixtureTurn(policy, ref.sessionId, payload, "codex");
    }, async *events() {}, async close() {} };
  try {
    const result = await journalStructuredDispatch(root, adapter, "work", nativePolicy(output, { dispatchId: "dispatch", journalRunId: "run" }),
      (text, policy) => dispatchWithGraphAccess(root, adapter, text, policy, (text, policy) => adapter.sendTurn(text, policy)));
    assert.equal(result.isError, false);
    assert.equal(prepares, 1); assert.equal(sends, 1);
    const sealed = db.structuredOwnerDispatch("dispatch");
    await assert.rejects(withSealedDispatch(root, result.selectedDispatch!, async () => result), /committed sealed owner/);
    assert.throws(() => withEphemeralInitializationDispatch(root, result.selectedDispatch!, async () => result, ref), /historic|descriptor|initialization|operation/i);
    assert.equal(sealed.tupleJson, canonicalJson(result.selectedDispatch));
    assert.doesNotThrow(() => db.replayStructuredDispatch("dispatch", output));
    const readEvidence = db.getEvidence.bind(db), responseDigest = (db.operation("dispatch")!.result as { responseDigest: string }).responseDigest;
    db.getEvidence = digest => digest === responseDigest ? Buffer.from("tampered") : readEvidence(digest);
    assert.throws(() => db.replayStructuredDispatch("dispatch", output), /evidence digest mismatch/);
    db.getEvidence = digest => digest === responseDigest ? undefined : readEvidence(digest);
    assert.throws(() => db.replayStructuredDispatch("dispatch", output), /evidence is missing/);
    db.getEvidence = readEvidence;
    for (const mutation of [
      { ...sealed, tupleDigest: "foreign" }, { ...sealed, tupleJson: `${sealed.tupleJson} ` },
      { ...sealed, descriptorDigest: "foreign" }, { ...sealed, renderedInstructionDigest: "foreign" },
    ]) assert.throws(() => verifyPersistedDispatch(output, mutation, result.structured), /tuple|identity/);
    assert.throws(() => verifyPersistedDispatch(output, sealed, { ...result.structured!, selectedDispatchDigest: "foreign" } as any), /tuple/);
    await assert.rejects(dispatchWithGraphAccess(root, adapter, "changed", { ...nativePolicy(output), selectedDispatch: result.selectedDispatch, dispatchCapability: {} as any }, (text, policy) => adapter.sendTurn(text, policy)), /capability/);
    assert.equal(sends, 1, "forged capability cannot bypass durable dispatch");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap and provider crashes leave non-resumable preparation/uncertain records", async () => {
  const root = mkdtempSync(join(tmpdir(), "sealed-owner-crash-"));
  const db = new WorkflowDb(root);
  const ref = { version: 1 as const, provider: "codex" as const, sessionId: "prepared", role: "builder" as const, stream: "builder", generation: 0,
    cwd: root, configRoot: root, source: "observed" as const, createdAt: new Date(0).toISOString() };
  const adapter: BuilderAdapter = { agent: "codex", sessionId: () => ref.sessionId, sessionRef: () => ref, prepareSession: async () => { throw new Error("bootstrap crash"); },
    sendTurn: async () => { throw new Error("provider crash"); }, async *events() {}, async close() {} };
  try {
    await assert.rejects(journalStructuredDispatch(root, adapter, "work", nativePolicy(workReportOutput, { dispatchId: "bootstrap" }), (text, policy) => adapter.sendTurn(text, policy)), /bootstrap crash/);
    assert.equal(db.operation("bootstrap")!.status, "failed");
    adapter.prepareSession = async () => ref;
    await assert.rejects(journalStructuredDispatch(root, adapter, "work", nativePolicy(workReportOutput, { dispatchId: "sent" }), (text, policy) => adapter.sendTurn(text, policy)), /provider crash/);
    assert.equal(db.operation("sent")!.status, "uncertain");
    assert.throws(() => db.replayStructuredDispatch("sent", workReportOutput), /confirmed/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("rejected native material is bounded, referenced once, and cannot confirm", async () => {
  const root = mkdtempSync(join(tmpdir(), "sealed-rejected-evidence-"));
  const ref = { version: 1 as const, provider: "codex" as const, sessionId: "prepared", role: "builder" as const, stream: "builder", generation: 0,
    cwd: root, configRoot: root, source: "observed" as const, createdAt: new Date(0).toISOString() };
  const maximum = providerWireContract(workReportOutput, "codex").maximumResponseBytes;
  const raw = "x".repeat(maximum + 1);
  const adapter: BuilderAdapter = { agent: "codex", sessionId: () => ref.sessionId, sessionRef: () => ref, prepareSession: async () => ref,
    sendTurn: async (_text, policy) => ({ text: raw, isError: true, numTurns: 1, costUsd: 0, turnId: "rejected", selectedDispatch: policy!.selectedDispatch!, structured: {
      state: "rejected", reason: "invalid-contract", detail: "Invalid native material", dispatchId: policy!.dispatchId!, observedValue: { representation: "json-text", value: raw, digest: "observed" } } }),
    async *events() {}, async close() {} };
  try {
    await journalStructuredDispatch(root, adapter, "work", nativePolicy(workReportOutput, { dispatchId: "rejected" }), (text, policy) => adapter.sendTurn(text, policy));
    const db = new WorkflowDb(root);
    try {
      const operation = db.operation("rejected")!, result = operation.result as { responseDigest: string; rawDigest: string };
      assert.equal(operation.status, "uncertain");
      const receipt = JSON.parse(db.getEvidence(result.responseDigest)!.toString());
      assert.equal(receipt.receipt.observedValue, undefined);
      assert.equal(receipt.rejectedValue.evidenceDigest, result.rawDigest, "identical bounded material shares content-addressed storage");
      assert.equal(db.getEvidence(result.rawDigest)!.length, maximum);
      assert.equal(receipt.rejectedValue.originalBytes, maximum + 1);
      assert.throws(() => db.replayStructuredDispatch("rejected", workReportOutput), /confirmed persisted receipt/);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
