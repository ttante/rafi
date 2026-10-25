import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { WorkflowDb } from "../src/workflowDb.js";
import { WorkflowReader } from "../src/workflowReader.js";
import { cutoverOwnershipMatrix, STRUCTURED_AUDIT_CLOSURE, STRUCTURED_CUTOVER, STRUCTURED_CUTOVER_REASON } from "../src/structuredCutover.js";
import { createInterviewRecord, readInterviewRecords, saveInterviewRecord, resumeInterviewRecord } from "../src/interviews.js";
import { admitFixtureWork } from "./helpers/workAdmission.js";
import { journalStructuredDispatch, nativePolicy } from "../src/structuredOperation.js";
import { ticketPlanOutput, workReportOutput } from "rafi-spec";
import { canonicalFixtureTurn } from "./helpers/nativeOutput.js";
import type { BuilderAdapter } from "../src/adapters/types.js";

test("fresh host-only interviews survive initial cutover before a provider dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "cutover-human-only-"));
  try {
    const record = createInterviewRecord({ workflow: "plan", invocation: { projectDir: root }, answers: { brief: "Keep this answer" }, checkpoint: "agent-run", outputs: ["docs/rafi-plan.md"] });
    saveInterviewRecord(root, record);
    const db = new WorkflowDb(root); db.close();
    const retained = resumeInterviewRecord(root, record.id, "plan");
    assert.equal(retained.answers.brief, "Keep this answer");
    assert.equal(retained.status, "in_progress");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function resetMigration(path: string): void {
  const raw = new Database(path);
  raw.function("rafi_protocol_v3", () => 1);
  raw.function("rafi_writer_protocol", () => 4);
  raw.function("rafi_structured_communication_protocol", () => 2);
  raw.function("rafi_structured_authority_revision", () => 3);
  raw.function("rafi_build_writer_run", () => ""); raw.function("rafi_build_writer_token", () => "");
  raw.function("rafi_build_lease_owner", () => ""); raw.function("rafi_build_lease_generation", () => -1);
  raw.prepare("DELETE FROM structured_communication_cutover WHERE migration=?").run(STRUCTURED_CUTOVER);
  raw.close();
}

test("cutover fences every status, purges only owned authority, and preserves human/project evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "cutover-ownership-"));
  let db = new WorkflowDb(root);
  const path = db.path;
  try {
    for (const status of ["running", "paused", "blocked", "completed", "failed", "cancelled", "superseded"] as const) {
      const id = `old-${status}`;
      db.ensureRun(id);
      db.planOperation({ runId: id, idempotencyKey: id, kind: "provider-dispatch", intent: { protocolVersion: 2, tuple: { spoof: "not a valid tuple" } } });
      db.appendContinuityEvent({ runId: id, role: "builder", kind: "provider_response_received", payload: { text: "legacy" }, authoritativeStateRevision: 0 });
      db.ensureHumanDecision({ runId: id, decisionKey: id, interruptionId: "user", prompt: "Keep this answer", choices: [{ id: "keep", label: "Keep" }] });
      if (status !== "running") db.transition(id, { checkpoint: "old", status });
    }
    db.ensureRun("untouched");
    db.appendContinuityEvent({ runId: "untouched", role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 0 });
    const evidence = db.putEvidence("qa", Buffer.from("Ambiguous historical evidence must remain"));
    const ownedEvidence = db.putEvidence("qa", Buffer.from("Solely owned transport bytes"));
    const sharedEvidence = db.putEvidence("qa", Buffer.from("Shared transport bytes"));
    db.recordCommunicationEvidenceRefs("old-running", [ownedEvidence, sharedEvidence]);
    db.transition("untouched", { checkpoint: "host-only", state: { sharedEvidence } });
    admitFixtureWork(db, "old-running", "T1");
    db.beginQaTurn({ version: 2, operationId: "old-review", runId: "old-running", ticketId: "T1", reviewNumber: 1, sessionGeneration: 0, slot: "initial",
      sourceStateDigest: "source", reviewBasisDigest: "basis", instructionDigest: "old", intendedAt: new Date(0).toISOString(),
      providerSession: { version: 2, provider: "codex", sessionId: "old", role: "qa", stream: "qa", generation: 0, cwd: root, configRoot: root, createdAt: new Date(0).toISOString(), validatedAt: new Date(0).toISOString() } });
    db.finishQaTurn({ version: 2, operationId: "old-review", dispatch: "uncertain", terminalEventObserved: false, sourceStateDigest: "source", reviewBasisDigest: "basis", completedAt: new Date(0).toISOString() });
    mkdirSync(join(root, ".tickets"), { recursive: true });
    writeFileSync(join(root, ".tickets", "tickets.yaml"), "user-owned-ticket\n");
    db.close(); resetMigration(path);
    assert.throws(() => new WorkflowReader(root), /v2-cutover-pending/);
    db = new WorkflowDb(root);
    for (const status of ["running", "paused", "blocked", "completed", "failed", "cancelled", "superseded"]) {
      const id = `old-${status}`;
      assert.equal(db.getRun(id)!.status, "superseded");
      assert.equal(db.getRun(id)!.checkpoint, STRUCTURED_CUTOVER_REASON);
      assert.equal(db.operations(id).length, 0);
      assert.equal(db.continuityEvents(id).length, 0);
      assert.equal(db.pendingHumanDecisions(id).length, 1);
      assert.throws(() => db.transition(id, { checkpoint: "undo" }), /cannot resume/);
      assert.throws(() => db.planOperation({ runId: id, idempotencyKey: `replay-${id}`, kind: "provider-dispatch", intent: {} }), /cannot resume/);
    }
    assert.equal(db.getRun("untouched")!.status, "running");
    assert.equal(db.continuityEvents("untouched").length, 1);
    assert.ok(db.getEvidence(evidence));
    assert.equal(db.getEvidence(ownedEvidence), undefined);
    assert.ok(db.getEvidence(sharedEvidence));
    assert.equal(readFileSync(join(root, ".tickets", "tickets.yaml"), "utf8"), "user-owned-ticket\n");
    const raw = new Database(path, { readonly: true });
    try {
      assert.ok((raw.prepare("SELECT count(*) n FROM structured_cutover_quarantine").get() as { n: number }).n >= 14);
      const matrix = cutoverOwnershipMatrix(raw);
      assert.equal(matrix.find(entry => entry.table === "operation_journal")!.disposition, "purge-owned");
      assert.equal(matrix.find(entry => entry.table === "human_decisions")!.disposition, "retain");
      assert.deepEqual(raw.pragma("foreign_key_check"), []);
      assert.equal((raw.prepare("SELECT count(*) n FROM qa_turn_events WHERE operation_id='old-review'").get() as { n: number }).n, 0, "child authority is removed before its owner");
    } finally { raw.close(); }
    db.close(); db = new WorkflowDb(root);
    assert.equal(db.getRun("old-running")!.status, "superseded", "cutover is idempotent");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a fully verified native run survives cutover without descriptor substitution", async () => {
  const root = mkdtempSync(join(tmpdir(), "cutover-valid-native-"));
  const ref = { version: 1 as const, provider: "codex" as const, role: "builder" as const, stream: "builder", generation: 0, sessionId: "native",
    cwd: root, configRoot: root, source: "observed" as const, createdAt: new Date(0).toISOString() };
  const adapter: BuilderAdapter = { agent: "codex", sessionId: () => ref.sessionId, sessionRef: () => ref, prepareSession: async () => ref,
    sendTurn: async (_text, policy) => canonicalFixtureTurn(policy, ref.sessionId, { disposition: "modified", evidence: ["observed"], coverage: null, graphMaintenance: null }, "codex"),
    async *events() {}, async close() {} };
  try {
    await journalStructuredDispatch(root, adapter, "work", nativePolicy(workReportOutput, { dispatchId: "native", journalRunId: "native-run" }), (text, policy) => adapter.sendTurn(text, policy));
    const before = new WorkflowDb(root), path = before.path; before.close();
    const packet = join(root, ".foreman", "qa-report-recovery", "native-packet");
    mkdirSync(packet, { recursive: true }); writeFileSync(join(packet, "manifest.json"), JSON.stringify({ runId: "native-run" }));
    resetMigration(path);
    const db = new WorkflowDb(root);
    try { assert.equal(db.getRun("native-run")!.status, "running"); assert.doesNotThrow(() => db.replayStructuredDispatch("native", workReportOutput)); assert.equal(existsSync(join(packet, ".structured-communication-v2-cutover")), true, "unrelated native work cannot authorize an unowned recovery packet"); }
    finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("interview cutover preserves answers and refuses stale checkpoint writes", () => {
  const root = mkdtempSync(join(tmpdir(), "cutover-interview-"));
  const initial = new WorkflowDb(root), path = initial.path;
  initial.close();
  try {
    const record = createInterviewRecord({ workflow: "plan", invocation: { projectDir: root }, answers: { name: "Keep my answer" }, checkpoint: "agent-run" });
    saveInterviewRecord(root, record);
    const file = join(root, ".rafi", "interviews", `${record.id}.json`);
    const legacy = { ...record, communicationProtocolVersion: undefined };
    writeFileSync(file, JSON.stringify(legacy));
    const sessions = join(root, ".foreman", "delivery-sessions");
    mkdirSync(sessions, { recursive: true }); writeFileSync(join(sessions, "old.json"), JSON.stringify({ sessionId: "legacy" }));
    const packet = join(root, ".foreman", "qa-report-recovery", "old-packet");
    mkdirSync(packet, { recursive: true }); writeFileSync(join(packet, "manifest.json"), JSON.stringify({ runId: "legacy" }));
    resetMigration(path);
    const migrated = new WorkflowDb(root); migrated.close();
    const retained = readInterviewRecords(root).records[0]!;
    assert.equal(retained.status, "incompatible");
    assert.equal(retained.answers.name, "Keep my answer");
    assert.ok(retained.structuredCommunicationCutover?.archiveDigest);
    assert.equal(JSON.parse(readFileSync(join(sessions, "old.json"), "utf8")).checkpoint, STRUCTURED_CUTOVER_REASON);
    assert.ok(existsSync(join(packet, ".structured-communication-v2-cutover")));
    assert.throws(() => resumeInterviewRecord(root, record.id, "plan"), /not found/);
    assert.throws(() => saveInterviewRecord(root, record), /cannot resume/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown ownership or malformed projection rolls back completion and keeps readers fenced", () => {
  const root = mkdtempSync(join(tmpdir(), "cutover-rollback-"));
  const current = new WorkflowDb(root), path = current.path;
  current.close();
  try {
    resetMigration(path);
    const raw = new Database(path);
    raw.exec("CREATE TABLE unknown_authority(run_id TEXT,receipt_json TEXT)"); raw.close();
    assert.throws(() => new WorkflowDb(root), /does not classify unknown_authority/);
    assert.throws(() => new WorkflowReader(root), /v2-cutover-pending/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed projections preserve original bytes and old SQL writers cannot bypass a completed fence", () => {
  const root = mkdtempSync(join(tmpdir(), "cutover-malformed-"));
  const db = new WorkflowDb(root), path = db.path;
  db.ensureRun("run"); db.close();
  try {
    mkdirSync(join(root, ".rafi", "interviews"), { recursive: true });
    const projection = join(root, ".rafi", "interviews", "bad.json");
    writeFileSync(projection, "{broken"); resetMigration(path);
    new WorkflowDb(root).close();
    const reader = new WorkflowReader(root); reader.close();
    const quarantined = JSON.parse(readFileSync(projection, "utf8"));
    assert.equal(quarantined.status, "incompatible");
    assert.equal(readFileSync(join(root, ".rafi", "communication-quarantine", `${quarantined.structuredCommunicationCutover.archiveDigest}.json`), "utf8"), "{broken");
    const old = new Database(path);
    try {
      old.function("rafi_structured_authority_revision", () => 3);
      old.function("rafi_structured_communication_protocol", () => 1);
      old.function("rafi_writer_protocol", () => 4);
      old.function("rafi_protocol_v3", () => 1);
      old.function("rafi_build_writer_run", () => ""); old.function("rafi_build_writer_token", () => "");
      old.function("rafi_build_lease_owner", () => ""); old.function("rafi_build_lease_generation", () => -1);
      assert.throws(() => old.prepare("UPDATE workflow_runs SET checkpoint='legacy-resume' WHERE run_id='run'").run(), /v2 writer required/);
      assert.throws(() => old.prepare("DELETE FROM structured_communication_cutover").run(), /v2 writer required/);
    } finally { old.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("file quarantine survives rollback after replacement and repair resumes idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "cutover-file-rollback-"));
  const initial = new WorkflowDb(root), path = initial.path; initial.close();
  try {
    const directory = join(root, ".rafi", "interviews"); mkdirSync(directory, { recursive: true });
    const projection = join(directory, "broken.json"); writeFileSync(projection, "{original malformed bytes");
    resetMigration(path);
    const fault = new Database(path);
    fault.exec("CREATE TRIGGER audit_file_commit_fault BEFORE INSERT ON structured_communication_cutover BEGIN SELECT RAISE(ABORT,'Injected repair commit failure'); END;"); fault.close();
    assert.throws(() => new WorkflowDb(root), /Injected repair commit failure/);
    assert.throws(() => new WorkflowReader(root), /v2-cutover-pending/);
    const incompatible = JSON.parse(readFileSync(projection, "utf8"));
    const archive = join(root, ".rafi", "communication-quarantine");
    assert.equal(readFileSync(join(archive, `${incompatible.structuredCommunicationCutover.archiveDigest}.json`), "utf8"), "{original malformed bytes");
    const stages = readdirSync(archive).filter(name => name.endsWith(".stage.json")); assert.equal(stages.length, 1);
    const stage = JSON.parse(readFileSync(join(archive, stages[0]!), "utf8")); assert.equal(stage.path, projection);
    const resume = new Database(path); resume.exec("DROP TRIGGER audit_file_commit_fault"); resume.close();
    new WorkflowDb(root).close(); new WorkflowReader(root).close(); new WorkflowDb(root).close();
    assert.equal(readFileSync(projection, "utf8"), stage.replacement);
    assert.equal(readdirSync(archive).filter(name => name.endsWith(".stage.json")).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a live workflow owner keeps incompatible state behind the pending fence", () => {
  const root = mkdtempSync(join(tmpdir(), "cutover-live-owner-"));
  const db = new WorkflowDb(root), path = db.path;
  db.ensureRun("old");
  db.planOperation({ runId: "old", idempotencyKey: "old", kind: "provider-dispatch", intent: { protocolVersion: 1 } });
  const lease = db.acquireLease("old");
  try {
    resetMigration(path);
    assert.throws(() => new WorkflowDb(root), /v2-cutover-pending: stop the existing workflow owner/);
    assert.throws(() => new WorkflowReader(root), /v2-cutover-pending/);
    assert.equal(db.operation("old")!.status, "planned", "pending migration does not delete active-owner evidence");
  } finally { db.releaseLease(lease); db.close(); rmSync(root, { recursive: true, force: true }); }
});


test("malformed completion remains pending for read-only and readiness admission", () => {
  const root = mkdtempSync(join(tmpdir(), "cutover-malformed-completion-"));
  try {
    const owner = new WorkflowDb(root), path = owner.path; owner.close();
    const raw = new Database(path); raw.function("rafi_protocol_v3", () => 1);
    raw.function("rafi_writer_protocol", () => 4);
    raw.function("rafi_structured_communication_protocol", () => 2);
    raw.function("rafi_structured_authority_revision", () => 3);
    raw.prepare("UPDATE structured_communication_cutover SET details_json='broken' WHERE migration=?").run(STRUCTURED_AUDIT_CLOSURE); raw.close();
    assert.throws(() => new WorkflowReader(root), /v2-cutover-pending/);
    assert.throws(() => new WorkflowDb(root, path, { runId: "run" }), /v2-cutover-pending/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


for (const mode of ["valid", "foreign-tuple", "missing-evidence"] as const) test(`ticket-plan interview cutover verifies its journal reference: ${mode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cutover-ticket-plan-reference-"));
  const interview = createInterviewRecord({ workflow: "tickets-plan", invocation: { projectDir: root }, checkpoint: "proposal" });
  const runId = `ticket-plan:${interview.id}`;
  const ref = { version: 1 as const, provider: "codex" as const, role: "planner" as const, stream: "planner", generation: 0, sessionId: "planner",
    cwd: root, configRoot: root, source: "observed" as const, createdAt: new Date(0).toISOString() };
  const proposal = { version: 1, title: "Plan", markdown: "# Plan", additions: [], edits: [], supersessions: [], state_changes: [], source_reconciliation: [], future_work: [], next: { ticket_ids: [], replace_existing: false } };
  const adapter: BuilderAdapter = { agent: "codex", sessionId: () => ref.sessionId, sessionRef: () => ref, prepareSession: async () => ref,
    sendTurn: async (_text, policy) => canonicalFixtureTurn(policy, ref.sessionId, proposal, "codex"), async *events() {}, async close() {} };
  try {
    const result = await journalStructuredDispatch(root, adapter, "plan", nativePolicy(ticketPlanOutput, { journalRunId: runId }), (text, policy) => adapter.sendTurn(text, policy));
    const db = new WorkflowDb(root), path = db.path;
    const receipt = db.operation(result.selectedDispatch!.dispatchId)!.result as { responseDigest: string };
    db.close();
    interview.runtime = { runtime: "codex", sessionId: ref.sessionId };
    interview.decisions.nativeDispatch = { version: 2, runId, dispatchId: result.selectedDispatch!.dispatchId,
      tupleDigest: mode === "foreign-tuple" ? "foreign" : result.selectedDispatch!.digest };
    saveInterviewRecord(root, interview);
    if (mode === "missing-evidence") {
      const corrupt = new WorkflowDb(root);
      try { (corrupt as unknown as { db: Database.Database }).db.prepare("DELETE FROM content_refs WHERE digest=?").run(receipt.responseDigest); }
      finally { corrupt.close(); }
    }
    resetMigration(path);
    const reopened = new WorkflowDb(root); reopened.close();
    const retained = readInterviewRecords(root).records.find(record => record.id === interview.id)!;
    assert.equal(Boolean(retained.structuredCommunicationCutover), mode !== "valid");
    assert.equal(retained.answers && typeof retained.answers, "object");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
