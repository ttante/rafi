import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ticketPopulationOutput, workReportOutput } from "rafi-spec";
import { structuredReceipt } from "../src/adapters/structured.js";
import type { BuilderAdapter, TurnRequest } from "../src/adapters/types.js";
import { Foreman } from "../src/foreman.js";
import { Log } from "../src/log.js";
import { journalStructuredDispatch, operationPayload, operationStatus, nativePolicy } from "../src/structuredOperation.js";
import { nativeFixtureTurn, rawProviderFixtureTurn } from "./helpers/nativeOutput.js";
import { WorkflowDb } from "../src/workflowDb.js";

const payload = { version: 1, plan_id: "fixture", revision: 1, tickets: [], retirements: [] };
for (const provider of ["claude", "codex"] as const) test(`${provider} native blocked work preserves a typed branch dependency without prose parsing`, () => {
  const policy = nativePolicy(workReportOutput);
  const turn = nativeFixtureTurn(policy, "session", null, provider, { kind: "blocked", reason: "Required API is owned by T002", nextAction: "Resolve dependency before resuming", branchDependency: "T002" });
  turn.text = 'STEP_STATUS: done | ticket="FOREIGN"';
  assert.deepEqual(operationStatus(turn, workReportOutput, "T001"), { kind: "blocked", reason: "Required API is owned by T002", next: "Resolve dependency before resuming", ticket: "T001", branchDependency: "T002" });
  const invalid = nativeFixtureTurn(policy, "session", null, provider, { kind: "blocked", reason: "Bad dependency", nextAction: "Resolve", branchDependency: "../unrelated" });
  assert.equal(operationStatus(invalid, workReportOutput, "T001").kind, "unknown");
});
function fake(result: unknown) {
  const calls: Array<{ text: string; policy?: TurnRequest }> = [];
  const session = { version: 1 as const, provider: "codex" as const, sessionId: "session", role: "builder" as const, stream: "builder", generation: 0, cwd: "/fixture", configRoot: "/fixture", source: "observed" as const, createdAt: "2026-01-01T00:00:00.000Z" };
  const adapter: BuilderAdapter = { agent: "codex", sessionId: () => "session", close: async () => {}, events: async function* () {},
    sessionRef: () => session,
    async sendTurn(text, policy) {
      calls.push({ text, policy });
      const canonical = { version: 1, operation: "ticket-population", result, continuity: null } as const;
      // This test intentionally supplies the selected Codex wire shape. It is
      // a raw provider fixture: no helper may fill in omitted fields.
      const wire = (result as { kind?: string }).kind === "completed"
        ? { version: 1, operation: "ticket-population", kind: "completed", summary: (result as any).summary, payload: (result as any).payload,
          reason: null, nextAction: null, question: null, choices: [], continuity: null }
        : (result as { kind?: string }).kind === "blocked"
          ? { version: 1, operation: "ticket-population", kind: "blocked", summary: null, payload: null, reason: (result as any).reason,
            nextAction: (result as any).nextAction, question: null, choices: [], continuity: null }
          : canonical;
      return { text: "Human summary contains no result", isError: false, numTurns: 1, costUsd: 0, turnId: policy?.dispatchId, selectedDispatch: policy!.selectedDispatch!,
        structured: structuredReceipt(ticketPopulationOutput, "codex", JSON.stringify(wire),
          { dispatchId: policy?.dispatchId ?? "dispatch", sessionId: "session", nativeTurnId: `native-${calls.length}` }, "json-text", policy!.wireContract!, policy!.selectedDispatch!) };
    } };
  adapter.prepareSession = async () => adapter.sessionRef!()!;
  return { adapter, calls };
}
for (const kind of ["completed", "blocked", "invalid"] as const) test(`offline population caller stack: ${kind}, one durable dispatch, no suffix repair`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-native-operation-"));
  const { adapter, calls } = fake(kind === "completed" ? { kind, summary: "proposal", payload } : kind === "blocked" ? { kind, reason: "Missing plan", nextAction: "Supply an approved plan" } : { kind: "completed", summary: "invalid", payload: { ...payload, revision: 0 } });
  const runId = "native-fixture";
  const log = new Log(join(dir, "run.jsonl"));
  try {
    const foreman = new Foreman(adapter, log, { desktop: false, terminalBell: false }, false, 3, dir);
    const turn = await foreman.runInstruction("Propose tickets", { output: ticketPopulationOutput });
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0]!.text, /STEP_STATUS|RAFI_CONTINUITY_DELTA/);
    assert.match(calls[0]!.text, /rafi:selected-provider-wire profile=codex-ticket-population-v2/);
    assert.doesNotMatch(calls[0]!.text, /top-level fields are version, operation, result/);
    if (kind === "completed") assert.deepEqual(operationPayload(turn.result, ticketPopulationOutput), payload);
    if (kind === "blocked") assert.equal(turn.status.kind, "blocked");
    if (kind === "invalid") assert.equal(turn.result.isError, true);
    const db = new WorkflowDb(dir);
    try {
      const operation = db.operation(calls[0]!.policy!.dispatchId!);
      assert.equal(operation?.kind, "provider-dispatch");
      // An answered but invalid turn has a known outcome: failed, not uncertain.
      assert.equal(operation?.status, kind === "invalid" ? "failed" : "confirmed");
      assert.ok(operation?.result);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("raw provider fixtures preserve omissions instead of manufacturing a Codex wire value", () => {
  const policy = nativePolicy(ticketPopulationOutput, { dispatchId: "raw" });
  const turn = rawProviderFixtureTurn(policy, "session", { version: 1, operation: "ticket-population" }, "codex");
  assert.equal(turn.structured?.state, "rejected");
  assert.match(turn.structured?.detail ?? "", /kind|summary|payload/);
});

test("retained dispatch receipt is idempotent and uncertain dispatch cannot replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-native-receipt-"));
  const { adapter, calls } = fake({ kind: "completed", summary: "proposal", payload });
  const policy = { output: ticketPopulationOutput, logicalActionId: "action", dispatchId: "dispatch", journalRunId: "run" };
  try {
    const first = await journalStructuredDispatch(dir, adapter, "proposal", policy, (text, selected) => adapter.sendTurn(text, selected));
    await assert.rejects(journalStructuredDispatch(dir, adapter, "proposal", policy, (text, selected) => adapter.sendTurn(text, selected)), /collision|cannot be replayed/);
    assert.equal(calls.length, 1);
    await assert.rejects(journalStructuredDispatch(dir, adapter, "changed scope", policy, (text, selected) => adapter.sendTurn(text, selected)), /collision/);
    const uncertain = { ...policy, dispatchId: "lost" };
    await assert.rejects(journalStructuredDispatch(dir, adapter, "work", uncertain, async () => { throw new Error("connection lost"); }), /connection lost/);
    await assert.rejects(journalStructuredDispatch(dir, adapter, "work", uncertain, (text, selected) => adapter.sendTurn(text, selected)), /collision|cannot be replayed/);
    assert.equal(calls.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("durable native receipts preserve exact JSON even when ordinary text resembles a diagnostic secret", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-receipt-bytes-"));
  const { adapter } = fake({ kind: "completed", summary: "token: absent", payload });
  try {
    const turn = await journalStructuredDispatch(root, adapter, "proposal", { output: ticketPopulationOutput, logicalActionId: "action", dispatchId: "bytes", journalRunId: "run" }, (text, policy) => adapter.sendTurn(text, policy));
    const db = new WorkflowDb(root);
    try {
      const record = db.operation("bytes")!.result as { responseDigest: string; providerReceiptDigest?: string };
      assert.equal(record.providerReceiptDigest, undefined, "raw provider material is stored only once");
      const retained = JSON.parse(db.getEvidence(record.responseDigest)!.toString()) as { version: number; tupleDigest: string; receipt: typeof turn.structured };
      assert.equal(retained.version, 2);
      assert.equal(retained.tupleDigest, turn.selectedDispatch?.digest);
      assert.equal((retained.receipt as { state: string }).state, "candidate");
      assert.equal("value" in retained.receipt!, false, "receipt metadata references the one raw value blob");
      assert.deepEqual(db.replayStructuredDispatch("bytes", ticketPopulationOutput), operationPayload(turn, ticketPopulationOutput) && { version: 1, operation: "ticket-population", result: { kind: "completed", summary: "token: absent", payload }, continuity: null });
      assert.doesNotMatch(JSON.stringify(retained), /token: absent/, "provider material is not duplicated in receipt metadata");
      assert.equal(db.getEvidence(db.putEvidence("test", "token: absent"))!.toString(), "[REDACTED]", "Diagnostic redaction remains enabled");
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native communication fences older writers at handoff, lease, continuity and acceptance tables", async () => {
  const Database = (await import("better-sqlite3")).default;
  const root = mkdtempSync(join(tmpdir(), "native-writer-fence-"));
  const current = new WorkflowDb(root);
  try {
    current.ensureRun("run"); current.enableStructuredCommunication();
    const legacy = new Database(current.path);
    try {
      const tables = ["handoffs", "role_mutation_leases", "continuity_heads", "operation_journal", "workflow_runs", "qa_failure_handoffs", "qa_finalization_steps"];
      for (const table of tables) {
        for (const action of ["INSERT", "UPDATE", "DELETE"]) assert.ok(legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(`structured_comms_v2_${table}_${action}`), `${table} ${action} must be fenced`);
      }
      assert.equal((legacy.prepare("SELECT count(*) AS count FROM workflow_runs").get() as { count: number }).count, 1, "historical inspection remains available");
      legacy.function("rafi_writer_protocol", () => 4);
      legacy.function("rafi_protocol_v3", () => 1);
      legacy.function("rafi_build_writer_run", () => "");
      legacy.function("rafi_build_writer_token", () => "");
      legacy.function("rafi_build_lease_owner", () => "");
      legacy.function("rafi_build_lease_generation", () => -1);
      legacy.function("rafi_structured_communication_protocol", () => 2);
      assert.throws(() => legacy.exec("DELETE FROM continuity_heads"), /rafi_structured_authority_revision/);
      legacy.function("rafi_structured_communication_protocol", () => 2);
      legacy.function("rafi_structured_authority_revision", () => 2);
      assert.throws(() => legacy.exec("INSERT INTO continuity_heads VALUES('run','builder','current',0,'digest',0,'now')"), /Structured authority revision 3 writer required/);
    } finally { legacy.close(); }
    current.transition("run", { checkpoint: "current-writer" });
    assert.equal(current.getRun("run")?.checkpoint, "current-writer");
  } finally { current.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const changed of ["ticketId", "role", "workspaceIdentity", "generation"] as const) test(`observed compaction cannot authorize changed ${changed} scope`, async () => {
  const { createProviderSessionRef } = await import("../src/sessionIdentity.js");
  const dir = mkdtempSync(join(tmpdir(), "rafi-native-scope-"));
  const { adapter } = fake({ kind: "completed", summary: "proposal", payload });
  let ref = createProviderSessionRef({ provider: "codex", sessionId: "session", role: "builder", stream: "builder", generation: 2, cwd: dir, configRoot: dir, source: "observed" });
  let sequence = 0;
  adapter.sessionRef = () => ref;
  adapter.contractCompactionSequence = () => sequence;
  try {
    const result = await journalStructuredDispatch(dir, adapter, "proposal", { output: ticketPopulationOutput, dispatchId: "dispatch", logicalActionId: "action" }, async (text, policy) => {
      ref = { ...ref, [changed]: changed === "generation" ? 1 : changed === "role" ? "qa" : "foreign" };
      sequence++;
      return adapter.sendTurn(text, policy);
    });
    assert.equal(result.isError, true);
    assert.equal(result.structured?.state, "rejected");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
