import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { BuilderAdapter, BuilderEvent, CompactResult, TurnResult } from "../src/adapters/types.js";
import { beginQaFinalization, completeQaFinalization, runIsolatedQa, verifyPendingQaFinalizationSource, type QaSessionBoundaryRecovery, type QaSessionBoundaryResult, type QaSessionHandle, type QaStreamState } from "../src/qaReview.js";
import type { ProviderSessionRefV1 } from "rafi-spec";
import { appendQaRecoveryResource, compareQaRecoveryReviewedState, createQaRecoveryPacket, LegacyQaRecoveryPacketError, loadQaRecoveryPacket, materializeQaRecoveryContext, recoverPendingQaRecoveryPublications, updateQaRecoveryPosition, validateManualQaReport } from "../src/qaRecovery.js";
import { createDisposableQaSnapshot } from "../src/qaSnapshot.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { qaDigest, type HandoffAcceptanceReceiptV2, type ProviderSessionRefV2 } from "../src/qaProtocolV2.js";

function repository(): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-recovery-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "qa@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "QA Test"], { cwd: dir });
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  writeFileSync(join(dir, "tracked.txt"), "changed\n");
  writeFileSync(join(dir, "untracked.txt"), "exact untracked\n");
  return dir;
}

const validReport = `RAFI_QA_FAILURE_REPORT_START\n${JSON.stringify({ version: 1, summary: "one issue", checks_run: [{ check: "test", command: "pnpm test", outcome: "failed", evidence: "failed" }], findings: [{ id: "F1", requirement: "works", locations: ["tracked.txt"], problem: "broken", evidence: "test failed", expected: "passes", fix_direction: "repair", verification: ["pnpm test"] }], observations: [] })}\nRAFI_QA_FAILURE_REPORT_END\nSTEP_STATUS: qa_fail | issues="one issue"`;

class Adapter implements BuilderAdapter {
  readonly agent = "codex" as const;
  instructions: string[] = [];
  constructor(readonly id: string, private readonly reply: (instruction: string, turn: number) => string, private turn = 0) {}
  private eventQueue: BuilderEvent[] = [];
  private eventWaiters: Array<() => void> = [];
  private closed = false;
  private ref?: ProviderSessionRefV1;
  async sendTurn(instruction: string): Promise<TurnResult> {
    this.instructions.push(instruction);
    const turn = this.turn++;
    const text = this.reply(instruction, turn);
    const result = { text, isError: false, numTurns: 1, costUsd: 0, turnId: `${this.id}-${turn}`, hostInstruction: instruction, providerInstruction: instruction, rawResponse: text, cleanedResponse: text, providerMetadata: { provider: "codex" as const, sessionId: this.id, sessionRef: this.ref } };
    this.eventQueue.push({ kind: "turn-complete", result, turnId: result.turnId }); this.eventWaiters.splice(0).forEach((wake) => wake());
    return result;
  }
  sessionId(): string { return this.id; }
  sessionRef(): ProviderSessionRefV1 | undefined { return this.ref; }
  adoptSessionRef(ref: ProviderSessionRefV1): void { this.ref = ref; }
  async compact(): Promise<CompactResult> { return { ok: true }; }
  async *events(): AsyncIterable<BuilderEvent> { while (!this.closed || this.eventQueue.length) { if (!this.eventQueue.length) await new Promise<void>((resolve) => this.eventWaiters.push(resolve)); const event = this.eventQueue.shift(); if (event) yield event; } }
  async close(): Promise<void> { this.closed = true; this.eventWaiters.splice(0).forEach((wake) => wake()); }
}

class SetupTurnAdapter extends Adapter {
  private prepared = false;
  requiresAutoCompactionSetupTurn(): boolean { return !this.prepared; }
  async prepareAutoCompaction(): Promise<void> { if (this.instructions.length > 0) this.prepared = true; }
}

function sessionRef(adapter: Adapter, cwd: string): ProviderSessionRefV1 {
  return { version: 1, provider: adapter.agent, sessionId: adapter.id, role: "qa", stream: "qa", generation: 1, cwd, configRoot: cwd, source: "observed", createdAt: new Date(0).toISOString(), validatedAt: new Date(0).toISOString() };
}
function qaHandle(adapter: Adapter, cwd: string): QaSessionHandle {
  const fields = { version: 2 as const, sourceMode: "read-only" as const, scratchMode: "isolated" as const, settingsSources: "none" as const, networkMode: "disabled" as const, environmentDigest: "1".repeat(64), policyDigest: "2".repeat(64) };
  const ref = sessionRef(adapter, cwd); adapter.adoptSessionRef(ref);
  return { adapter, sessionIdentity: () => ref, effectiveRoleInstructions: "test QA role", runtimeContext: { test: true }, skills: [], confinement: { ...fields, digest: qaDigest("qa-confinement", fields) }, handoffReceipt: { kind: "initial" } };
}
function acceptedBoundary(adapter: Adapter, cwd: string, recovery?: QaSessionBoundaryRecovery): QaSessionBoundaryResult {
  const successor = sessionRef(adapter, cwd);
  const scoped = (ref: ProviderSessionRefV1): ProviderSessionRefV2 => ({ version: 2, provider: ref.provider, sessionId: ref.sessionId, role: "qa", stream: "qa", generation: ref.generation, cwd: ref.cwd, configRoot: ref.configRoot, createdAt: ref.createdAt, validatedAt: ref.validatedAt! });
  const resources = [
    { label: "continuity-checkpoint", digest: "b".repeat(64), authoritative: true, requiredForRecovery: false, mediaType: "application/vnd.rafi.digest", path: "db:continuity-checkpoint", purpose: "Digest reference to the durable role continuity checkpoint", bytes: 64 },
    { label: "authoritative-run-state", digest: "d".repeat(64), authoritative: true, requiredForRecovery: false, mediaType: "application/vnd.rafi.digest", path: "db:authoritative-run-state", purpose: "Digest reference to the durable run continuity state", bytes: 64 },
    { label: "frozen-qa-action", digest: "e".repeat(64), authoritative: true, requiredForRecovery: false, mediaType: "application/octet-stream", path: "embedded:frozen-qa-action", purpose: "Frozen QA action across the session boundary", bytes: 1 },
    ...(recovery?.resources ?? []).map((item) => ({ ...item, authoritative: true })),
  ];
  const base = { version: 2 as const, runId: recovery?.runId ?? "test-run", ticketId: recovery?.ticketId ?? "T-1", qaRevision: 1,
    sourceStateDigest: recovery?.reviewedStateDigest ?? "d".repeat(64), predecessorSourceStateDigest: recovery?.reviewedStateDigest ?? "d".repeat(64),
    reviewBasisDigest: "e".repeat(64), requiresFullReview: true, confinementDigest: qaHandle(adapter, cwd).confinement.digest,
    predecessor: scoped({ ...successor, sessionId: `${successor.sessionId}-predecessor` }), successor: scoped(successor),
    manifestDigest: "a".repeat(64), continuityCheckpointDigest: "b".repeat(64), acceptanceCheckpointDigest: "c".repeat(64),
    packetDigest: recovery?.packetDigest ?? "f".repeat(64), inventoryDigest: qaDigest("handoff-inventory", resources), resources, acceptedAt: new Date(0).toISOString() };
  const receipt: HandoffAcceptanceReceiptV2 = { ...base, operationId: qaDigest("qa-handoff-operation", base) };
  if (recovery?.packetPath) {
    const marker = `${sep}.foreman${sep}`;
    const markerIndex = recovery.packetPath.indexOf(marker);
    if (markerIndex < 0) throw new Error("test recovery packet is outside a project");
    const db = new WorkflowDb(recovery.packetPath.slice(0, markerIndex));
    try { db.ensureRun(receipt.runId); db.recordQaHandoffReceipt(receipt); } finally { db.close(); }
  }
  return { handle: { ...qaHandle(adapter, cwd), handoffReceipt: { kind: "accepted", receipt } }, receipt };
}
function qaHandleForPacket(adapter: Adapter, cwd: string, packet: ReturnType<typeof createQaRecoveryPacket>): QaSessionHandle {
  return acceptedBoundary(adapter, cwd, { runId: packet.manifest.runId, ticketId: packet.manifest.ticketId, packetId: packet.manifest.packetId,
    packetDigest: packet.manifest.packetDigest, reviewedStateDigest: packet.manifest.reviewedStateDigest, packetPath: packet.directory,
    resources: packet.manifest.resources.map((item) => ({ label: item.path, purpose: item.purpose, bytes: item.bytes, digest: item.digest, requiredForRecovery: item.requiredForRecovery, mediaType: item.mediaType, path: item.path })) }).handle;
}
const unavailableBoundary = async (): Promise<QaSessionBoundaryResult> => { throw new Error("unexpected QA session boundary"); };

test("wrong-scope resumed packets are rejected before snapshot or QA session allocation", async () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "wrong-scope", ticketId: "T2", cycle: 1, reviewAttempt: 1, recoveryStage: "operator-menu", resources: {} });
    let created = false;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "wrong-scope" }, resumedRecovery: packet, sessionBoundary: unavailableBoundary,
      createQa: async (cwd) => { created = true; return qaHandle(new Adapter("must-not-start", () => ""), cwd); },
      fix: async () => { throw new Error("Builder must not run for wrong-scope recovery"); },
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(created, false);
    const db = new WorkflowDb(dir);
    try { assert.equal(db.qaTicketHead("wrong-scope", "T1").state, "idle"); }
    finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("errored packet acknowledgement cannot authorize a full review or acknowledgement replay", async () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "ack-provider-error", ticketId: "T1", cycle: 1, reviewAttempt: 1, recoveryStage: "operator-menu", resources: { prompt: { value: "old review", purpose: "old review" } } });
    const adapter = new Adapter("ack-error", (instruction) => `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"`);
    const send = adapter.sendTurn.bind(adapter);
    adapter.sendTurn = async (instruction) => ({ ...await send(instruction), isError: true });
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "ack-provider-error" }, resumedRecovery: packet, continuityManaged: true,
      createQa: async (cwd) => qaHandleForPacket(adapter, cwd, packet), sessionBoundary: unavailableBoundary,
      onReportRecovery: async () => ({ action: "pause" }), fix: async () => { assert.fail("failed acknowledgement must not dispatch Builder"); },
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(adapter.instructions.length, 1);
    assert.match(result.detail ?? "", /reconstruction is no longer authoritative|complete fresh QA review/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("finalization source drift pauses durably and a restarted full QA can complete", async () => {
  const dir = repository();
  let reviews = 0;
  try {
    const review = () => runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "finalization-drift" }, sessionBoundary: unavailableBoundary,
      createQa: async (cwd) => qaHandle(new Adapter(`full-review-${++reviews}`, () => 'STEP_STATUS: qa_pass | summary="complete review passed"'), cwd),
      fix: async () => { throw new Error("Builder must not replay during finalization recheck"); },
    });
    const first = await review();
    assert.equal(first.outcome, "passed");
    await beginQaFinalization(dir, dir, "finalization-drift", "T1", first.passCertificateId!, first.sourceStateDigest!, "ticket-complete:T1");
    writeFileSync(join(dir, "tracked.txt"), "new work while finalization was paused\n");
    await assert.rejects(verifyPendingQaFinalizationSource(dir, dir, "finalization-drift", "T1"), /Resume with:.*--qa-revision \d+ --fresh-with-handoff/);
    const paused = new WorkflowDb(dir);
    try {
      assert.equal(paused.qaTicketHead("finalization-drift", "T1").state, "operator-menu");
      assert.equal(paused.qaFinalizationSteps("finalization-drift", "T1")[0]?.status, "invalidated");
      assert.throws(() => paused.consumeQaPassCertificate("finalization-drift", "T1", first.passCertificateId!, "replay"), /already been consumed/);
    } finally { paused.close(); }
    const second = await review();
    assert.equal(second.outcome, "passed");
    assert.equal(reviews, 2);
    assert.notEqual(second.sourceStateDigest, first.sourceStateDigest);
    await beginQaFinalization(dir, dir, "finalization-drift", "T1", second.passCertificateId!, second.sourceStateDigest!, "ticket-complete:T1");
    await verifyPendingQaFinalizationSource(dir, dir, "finalization-drift", "T1");
    completeQaFinalization(dir, "finalization-drift", "T1");
    const completed = new WorkflowDb(dir);
    try {
      assert.equal(completed.qaTicketHead("finalization-drift", "T1").state, "completed");
      assert.deepEqual(completed.qaFinalizationSteps("finalization-drift", "T1").map((step) => step.status), ["invalidated", "completed"]);
    } finally { completed.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source drift before finalization intent durably invalidates the pass and schedules recheck", async () => {
  const dir = repository();
  try {
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "pre-finalization-drift" }, sessionBoundary: unavailableBoundary,
      createQa: async (cwd) => qaHandle(new Adapter("pre-finalization-review", () => 'STEP_STATUS: qa_pass | summary="complete review passed"'), cwd),
      fix: async () => { throw new Error("Builder must not run for a passing review"); },
    });
    assert.equal(result.outcome, "passed");
    writeFileSync(join(dir, "tracked.txt"), "changed after pass, before finalization intent\n");
    await assert.rejects(
      beginQaFinalization(dir, dir, "pre-finalization-drift", "T1", result.passCertificateId!, result.sourceStateDigest!, "ticket-complete:T1"),
      /Resume with:.*--qa-revision \d+ --fresh-with-handoff/,
    );
    const db = new WorkflowDb(dir);
    try {
      const head = db.qaTicketHead("pre-finalization-drift", "T1");
      assert.equal(head.state, "operator-menu");
      assert.equal(head.passCertificateId, undefined);
      assert.equal(db.qaFinalizationSteps("pre-finalization-drift", "T1").length, 0);
      assert.throws(() => db.consumeQaPassCertificate("pre-finalization-drift", "T1", result.passCertificateId!, "replay"), /already been consumed/);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("publication recovery rejects a symlinked ancestor before restoring any manifest bytes", () => {
  const dir = repository();
  const outside = mkdtempSync(join(tmpdir(), "qa-publication-outside-"));
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "symlink-intent", ticketId: "T1", cycle: 1, reviewAttempt: 1, recoveryStage: "operator-menu", resources: {} });
    const raw = new Database(join(dir, ".rafi/recovery.sqlite3"));
    raw.prepare("UPDATE qa_packet_projections SET status='intended' WHERE packet_digest=?").run(packet.manifest.packetDigest);
    raw.close();
    rmSync(join(packet.directory, "manifest.json"));
    rmSync(join(packet.directory, "manifests", "revision-00000001.json"));
    const parent = dirname(packet.directory);
    const relocated = join(outside, "ticket");
    renameSync(parent, relocated);
    symlinkSync(relocated, parent, "dir");
    assert.throws(() => recoverPendingQaRecoveryPublications(dir, "symlink-intent"), /unsafe or symlinked/);
    assert.equal(existsSync(join(packet.directory, "manifest.json")), false);
    assert.equal(existsSync(join(packet.directory, "manifests", "revision-00000001.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

for (const route of ["automatic", "operator", "resumed-operator"] as const) {
  test(`${route} errored full review forbids correction and manual/plain reconstruction`, async () => {
    const dir = repository();
    try {
      const runId = `errored-full-${route}`;
      const packet = route === "resumed-operator" ? createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId, ticketId: "T1", cycle: 1, reviewAttempt: 1, recoveryStage: "operator-menu", resources: { prompt: { value: "old review", purpose: "old review" } } }) : undefined;
      const invalid = 'STEP_STATUS: qa_fail | issues="missing structured report"';
      let boundaryCount = 0;
      let menuCount = 0;
      let fixes = 0;
      let failedAdapter: Adapter | undefined;
      const freshAdapter = (id: string, failReview: boolean): Adapter => {
        const adapter = new Adapter(id, (instruction) => {
          if (instruction.includes("Packet digest:")) return `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"`;
          if (failReview && instruction.includes("Report correction only")) return validReport;
          return invalid;
        });
        if (failReview) {
          failedAdapter = adapter;
          const send = adapter.sendTurn.bind(adapter);
          adapter.sendTurn = async (instruction) => ({ ...await send(instruction), isError: instruction.includes("QA handoff:") });
        }
        return adapter;
      };
      const original = new Adapter("original", (_instruction, turn) => {
        if (route === "automatic" && turn === 2) writeFileSync(join(dir, "tracked.txt"), "source drift before automatic successor\n");
        return invalid;
      });
      const result = await runIsolatedQa({
        ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
        builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 1,
        recovery: { projectDir: dir, runId }, continuityManaged: true, ...(packet ? { resumedRecovery: packet } : {}),
        createQa: async (cwd) => packet ? qaHandleForPacket(freshAdapter("resumed", false), cwd, packet) : qaHandle(original, cwd),
        sessionBoundary: async (_handle, _action, _strategy, cwd, recovery) => {
          boundaryCount++;
          return acceptedBoundary(freshAdapter(`fresh-${boundaryCount}`, route !== "operator" || boundaryCount === 2), cwd, recovery);
        },
        onReportRecovery: async () => {
          menuCount++;
          if (route !== "automatic" && menuCount === 1) {
            writeFileSync(join(dir, "tracked.txt"), "source drift before operator successor\n");
            return { action: "fresh" };
          }
          const attempt = menuCount - (route === "automatic" ? 0 : 1);
          return attempt === 1 ? { action: "plain" } : attempt === 2 ? { action: "manual" } : { action: "pause" };
        },
        fix: async () => { fixes++; return { ok: false }; },
      });
      assert.equal(result.outcome, "needs-human");
      assert.equal(fixes, 0);
      assert.equal(failedAdapter, undefined, "fresh successor reconstruction is disabled");
      assert.equal(boundaryCount, 0);
      assert.match(result.detail ?? "", /full QA review failed|complete fresh QA review/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("correction turns retain their identity after same-session compaction revalidation", async () => {
  const dir = repository();
  try {
    let calls = 0;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 1,
      recovery: { projectDir: dir, runId: "session-revalidation" }, sessionBoundary: unavailableBoundary,
      createQa: async (cwd) => {
        const adapter = new Adapter("stable-session", () => ++calls === 1 ? 'STEP_STATUS: qa_fail | issues="missing report"' : validReport) as Adapter & { prepareAutoCompaction(): Promise<void> };
        const handle = qaHandle(adapter, cwd);
        adapter.prepareAutoCompaction = async () => { adapter.adoptSessionRef({ ...adapter.sessionRef()!, validatedAt: new Date().toISOString() }); };
        return handle;
      },
      fix: async () => ({ ok: false, detail: "intentional test stop after corrected report" }),
    });
    assert.equal(calls, 2);
    assert.equal(result.outcome, "blocked");
    const db = new WorkflowDb(dir);
    try { assert.equal(db.qaReviewAttempts("session-revalidation", "T1")[0]?.status, "failed"); }
    finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejected provider identity preserves exact returned evidence without accepting a verdict", async () => {
  const dir = repository();
  try {
    await assert.rejects(runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "identity-rejected" }, sessionBoundary: unavailableBoundary,
      createQa: async (cwd) => {
        const adapter = new Adapter("expected-session", () => 'STEP_STATUS: qa_pass | summary="untrusted pass"');
        const original = adapter.sendTurn.bind(adapter);
        adapter.sendTurn = async (instruction) => {
          const result = await original(instruction);
          return { ...result, rawResponse: "EXACT REJECTED RESPONSE", providerInstruction: "EXACT REJECTED PROMPT", providerMetadata: { provider: "codex", sessionId: "unexpected-session", sessionRef: { ...adapter.sessionRef()!, sessionId: "unexpected-session" } } };
        };
        return qaHandle(adapter, cwd);
      }, fix: async () => ({ ok: false }),
    }), /identity changed/);
    const rawDb = new Database(join(dir, ".rafi/recovery.sqlite3"), { readonly: true });
    const row = rawDb.prepare("SELECT status,receipt_json FROM qa_turns WHERE run_id=?").get("identity-rejected") as { status: string; receipt_json: string };
    rawDb.close();
    assert.equal(row.status, "uncertain");
    const receipt = JSON.parse(row.receipt_json);
    const db = new WorkflowDb(dir);
    try {
      assert.equal(db.getEvidence(receipt.rawResponseDigest)?.toString(), "EXACT REJECTED RESPONSE");
      assert.equal(db.getEvidence(receipt.providerInstructionDigest)?.toString(), "EXACT REJECTED PROMPT");
      assert.match(db.getEvidence(receipt.eventStreamDigest)?.toString() ?? "", /unexpected-session/);
      assert.notEqual(db.qaTicketHead("identity-rejected", "T1").state, "passed");
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("packet storage is owner-only, digest-addressed, locally excluded, and mutation sealed", () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "../run unsafe", ticketId: "T/1", cycle: 1, reviewAttempt: 1, recoveryStage: "same-session", reportJson: "{}", resources: { prompt: { value: "exact prompt", purpose: "prompt", exactText: true } } });
    assert.ok(packet.directory.startsWith(join(dir, ".foreman/qa-report-recovery/")));
    assert.equal(lstatSync(packet.directory).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(packet.directory, "manifest.json")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(packet.directory, "context/prompt.txt"), "utf8"), "exact prompt");
    assert.equal(loadQaRecoveryPacket(packet.directory).manifest.packetDigest, packet.manifest.packetDigest);
    const unchanged = compareQaRecoveryReviewedState(packet, dir);
    assert.equal(unchanged.matches, true, JSON.stringify(unchanged));
    writeFileSync(join(dir, "untracked.txt"), "drifted\n");
    const drift = compareQaRecoveryReviewedState(packet, dir);
    assert.equal(drift.matches, false);
    assert.ok(drift.drift.includes("untracked.txt"));
    assert.ok(drift.drift.every((path) => !path.includes("integrity.json") && !path.includes("untracked-manifest.json")));
    const exclude = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: dir, encoding: "utf8" }).trim();
    assert.match(readFileSync(exclude, "utf8"), /qa-report-recovery/);
    const materialized = materializeQaRecoveryContext(packet, dir);
    materialized.verify();
    chmodSync(join(materialized.path, "context/prompt.txt"), 0o600);
    writeFileSync(join(materialized.path, "context/prompt.txt"), "mutated");
    assert.throws(() => materialized.verify(), /mutation detected/);
    const manual = validateManualQaReport(packet);
    assert.ok(manual.errors.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("full reviewed-state binding detects staged versus unstaged changes with path-level drift", () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "stage-drift", ticketId: "T1", cycle: 1, reviewAttempt: 1, recoveryStage: "same-session", resources: { prompt: { value: "review", purpose: "prompt", exactText: true } } });
    writeFileSync(join(dir, "tracked.txt"), "different bytes with the same modified status\n");
    const contentComparison = compareQaRecoveryReviewedState(packet, dir);
    assert.equal(contentComparison.matches, false);
    assert.ok(contentComparison.drift.includes("tracked.txt"), "same-status content drift remains path-level");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    const comparison = compareQaRecoveryReviewedState(packet, dir);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.drift.includes("tracked.txt"));
    assert.ok(!comparison.drift.some((path) => path.endsWith(".json")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("V2 revisions are append-only, content-addressed, and detect sealed tampering", () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "lineage", ticketId: "T1", cycle: 1, reviewAttempt: 1, reviewAttemptId: "attempt-one", recoveryStage: "same-session", resources: { prompt: { value: "first", purpose: "prompt", exactText: true } } });
    assert.equal(packet.manifest.version, 2);
    assert.equal(packet.manifest.revision, 1);
    const next = appendQaRecoveryResource(packet, "prompts/correction.txt", "second", { purpose: "correction", exact: true });
    assert.equal(next.manifest.revision, 2);
    assert.equal(next.manifest.parentPacketDigest, packet.manifest.packetDigest);
    assert.ok(readFileSync(join(next.directory, "manifests/revision-00000001.json"), "utf8").includes(packet.manifest.packetDigest));
    const correction = next.manifest.resources.find((resource) => resource.path === "prompts/correction.txt")!;
    assert.equal(readFileSync(join(next.directory, correction.objectPath!), "utf8"), "second");
    const rawDb = new Database(join(dir, ".rafi/recovery.sqlite3"));
    rawDb.prepare("UPDATE qa_recovery_heads SET packet_digest=?,reviewed_state_digest=?,revision=?,correction_turns=?,pending_action=? WHERE run_id=? AND ticket_id=?")
      .run(packet.manifest.packetDigest, packet.manifest.reviewedStateDigest, packet.manifest.revision, packet.manifest.correctionTurns, packet.manifest.pendingAction, packet.manifest.runId, packet.manifest.ticketId);
    rawDb.prepare("UPDATE qa_packet_projections SET status='intended' WHERE packet_digest=?").run(next.manifest.packetDigest);
    rawDb.close();
    writeFileSync(join(next.directory, "manifest.json"), readFileSync(join(next.directory, "manifests/revision-00000001.json")));
    assert.equal(loadQaRecoveryPacket(next.directory).manifest.revision, 1, "packet loading is read-only and never promotes a filesystem-ahead revision");
    const retried = appendQaRecoveryResource(packet, "prompts/correction.txt", "second", { purpose: "correction", exact: true });
    assert.equal(retried.manifest.revision, 2, "the same logical mutation completes a revision-file-ahead crash");
    const reconciledDb = new WorkflowDb(dir);
    assert.equal(reconciledDb.qaRecoveryHead("lineage", "T1")?.packetDigest, next.manifest.packetDigest);
    assert.equal(reconciledDb.qaPacketProjection(next.manifest.packetDigest)?.status, "published");
    reconciledDb.close();
    writeFileSync(join(next.directory, "prompts/correction.txt"), "tampered");
    assert.throws(() => loadQaRecoveryPacket(next.directory), /projection mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit startup reconciliation completes a manifest-ahead packet publication", () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "manifest-ahead", ticketId: "T1", cycle: 1, reviewAttempt: 1, recoveryStage: "operator-menu", pendingAction: "operator-menu", resources: { prompt: { value: "review", purpose: "prompt", exactText: true } } });
    const rawDb = new Database(join(dir, ".rafi/recovery.sqlite3"));
    rawDb.prepare("DELETE FROM qa_recovery_heads WHERE run_id=? AND ticket_id=?").run(packet.manifest.runId, packet.manifest.ticketId);
    rawDb.prepare("UPDATE qa_packet_projections SET status='intended' WHERE packet_digest=?").run(packet.manifest.packetDigest);
    rawDb.close();
    const recovered = recoverPendingQaRecoveryPublications(dir, packet.manifest.runId);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.manifest.packetDigest, packet.manifest.packetDigest);
    const db = new WorkflowDb(dir);
    assert.equal(db.qaRecoveryHead(packet.manifest.runId, packet.manifest.ticketId)?.packetDigest, packet.manifest.packetDigest);
    assert.equal(db.qaPacketProjection(packet.manifest.packetDigest)?.status, "published");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit startup reconciliation restores manifest bytes after a crash immediately after SQLite intent", () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "intent-only", ticketId: "T1", cycle: 1, reviewAttempt: 1,
      recoveryStage: "operator-menu", pendingAction: "operator-menu", resources: { prompt: { value: "review", purpose: "prompt", exactText: true } } });
    const revision = join(packet.directory, "manifests/revision-00000001.json");
    const rawDb = new Database(join(dir, ".rafi/recovery.sqlite3"));
    rawDb.prepare("DELETE FROM qa_recovery_heads WHERE run_id=? AND ticket_id=?").run(packet.manifest.runId, packet.manifest.ticketId);
    rawDb.prepare("UPDATE qa_packet_projections SET status='intended' WHERE packet_digest=?").run(packet.manifest.packetDigest);
    rawDb.close();
    rmSync(join(packet.directory, "manifest.json"));
    rmSync(revision);

    const recovered = recoverPendingQaRecoveryPublications(dir, packet.manifest.runId);
    assert.equal(recovered[0]?.manifest.packetDigest, packet.manifest.packetDigest);
    assert.ok(existsSync(revision));
    const db = new WorkflowDb(dir);
    assert.equal(db.qaRecoveryHead(packet.manifest.runId, packet.manifest.ticketId)?.packetDigest, packet.manifest.packetDigest);
    assert.equal(db.qaPacketProjection(packet.manifest.packetDigest)?.status, "published");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("packet retry never quarantines bytes covered by a durable publication intent", () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "intent-owned", ticketId: "T1", cycle: 1, reviewAttempt: 1,
      reviewAttemptId: "same-attempt", recoveryStage: "operator-menu", pendingAction: "operator-menu",
      resources: { prompt: { value: "review", purpose: "prompt", exactText: true } } });
    const rawDb = new Database(join(dir, ".rafi/recovery.sqlite3"));
    rawDb.prepare("DELETE FROM qa_recovery_heads WHERE run_id=? AND ticket_id=?").run(packet.manifest.runId, packet.manifest.ticketId);
    rawDb.prepare("UPDATE qa_packet_projections SET status='intended' WHERE packet_digest=?").run(packet.manifest.packetDigest);
    rawDb.close();
    rmSync(join(packet.directory, "manifest.json"));
    rmSync(join(packet.directory, "manifests/revision-00000001.json"));

    assert.throws(() => createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "intent-owned", ticketId: "T1", cycle: 1, reviewAttempt: 1,
      reviewAttemptId: "same-attempt", recoveryStage: "operator-menu", pendingAction: "operator-menu",
      resources: { prompt: { value: "replacement", purpose: "prompt", exactText: true } } }), /must be reconciled, not replaced/);
    assert.equal(readdirSync(join(packet.directory, "objects")).length > 0, true);
    assert.equal(readdirSync(join(packet.directory, "..")).some((name) => name.includes("abandoned")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startup reconciliation resolves a packet left behind by an atomic terminal QA decision", () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "terminal-packet", ticketId: "T1", cycle: 1, reviewAttempt: 1,
      recoveryStage: "operator-menu", pendingAction: "operator-menu", resources: { prompt: { value: "review", purpose: "prompt", exactText: true } } });
    const db = new WorkflowDb(dir);
    let head = db.qaTicketHead(packet.manifest.runId, packet.manifest.ticketId);
    head = db.transitionQa(packet.manifest.runId, packet.manifest.ticketId, head.revision, { type: "operator-menu" });
    db.transitionQa(packet.manifest.runId, packet.manifest.ticketId, head.revision, { type: "waived" });
    db.close();
    const recovered = recoverPendingQaRecoveryPublications(dir, packet.manifest.runId);
    assert.equal(recovered.at(-1)?.manifest.pendingAction, "resolved");
    const verified = new WorkflowDb(dir);
    assert.equal(verified.pendingQaRecoveryHeads(packet.manifest.runId).length, 0);
    verified.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("packet loading is read-only and a resolved durable lineage permits a later packet", () => {
  const dir = repository();
  try {
    const first = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "repeat-packet", ticketId: "T1", cycle: 1, reviewAttempt: 1, recoveryStage: "automatic-recovery", resources: { prompt: { value: "first", purpose: "First prompt", exactText: true } } });
    const db = new WorkflowDb(dir); db.ensureRun("repeat-packet"); db.close();
    loadQaRecoveryPacket(first.directory);
    const reconciled = new WorkflowDb(dir);
    assert.equal(reconciled.qaRecoveryHead("repeat-packet", "T1")?.packetDigest, first.manifest.packetDigest);
    reconciled.close();
    updateQaRecoveryPosition(first, "resolved", 0, "resolved");
    const second = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "repeat-packet", ticketId: "T1", cycle: 2, reviewAttempt: 2, recoveryStage: "automatic-recovery", resources: { prompt: { value: "second", purpose: "Second prompt", exactText: true } } });
    assert.notEqual(second.manifest.packetId, first.manifest.packetId);
    const after = new WorkflowDb(dir);
    assert.equal(after.qaRecoveryHead("repeat-packet", "T1")?.packetId, second.manifest.packetId);
    after.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("V2 loading rejects owner-visible permission expansion", () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "permissions", ticketId: "T1", cycle: 1, reviewAttempt: 1, recoveryStage: "same-session", resources: { prompt: { value: "first", purpose: "prompt", exactText: true } } });
    chmodSync(join(packet.directory, "manifest.json"), 0o644);
    assert.throws(() => loadQaRecoveryPacket(packet.directory), /unsafe permissions/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("operator-edited report.json remains loadable and valid bytes are resealed in a new revision", () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "manual", ticketId: "T1", cycle: 1, reviewAttempt: 1, recoveryStage: "operator-menu", reportJson: "{}", resources: { prompt: { value: "first", purpose: "prompt", exactText: true } } });
    const body = JSON.stringify({ version: 1, summary: "fixed report", checks_run: [{ check: "test", outcome: "failed", evidence: "failed" }], findings: [{ id: "F1", requirement: "works", locations: ["tracked.txt"], problem: "broken", evidence: "failed", expected: "works", fix_direction: "repair", verification: ["test"] }], observations: [] });
    writeFileSync(join(packet.directory, "report.json"), body);
    assert.equal(loadQaRecoveryPacket(packet.directory).manifest.packetDigest, packet.manifest.packetDigest);
    const accepted = validateManualQaReport(packet);
    assert.equal(accepted.errors.length, 0);
    assert.equal(accepted.report?.summary, "fixed report");
    assert.ok(accepted.packet.manifest.resources.some((resource) => resource.path.startsWith("accepted-reports/") && resource.integrityPolicy === "sealed"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("packet creation uses the frozen snapshot even when the live Builder worktree changes later", () => {
  const dir = repository();
  const snapshot = createDisposableQaSnapshot(dir);
  try {
    writeFileSync(join(dir, "untracked.txt"), "later live bytes\n");
    const packet = createQaRecoveryPacket({ projectDir: dir, frozenState: snapshot.frozenState, runId: "frozen", ticketId: "T1", cycle: 1, reviewAttempt: 1, recoveryStage: "same-session", resources: { prompt: { value: "review", purpose: "prompt", exactText: true } } });
    const stored = packet.manifest.resources.find((resource) => resource.path === "reviewed-state/original/untracked/000000.bin")!;
    assert.equal(readFileSync(join(packet.directory, stored.path), "utf8"), "exact untracked\n");
    assert.notEqual(packet.manifest.reviewedStateDigest, compareQaRecoveryReviewedState(packet, dir).currentDigest);
  } finally { snapshot.remove(); rmSync(dir, { recursive: true, force: true }); }
});

test("legacy V1 packets are detected and never loaded as authoritative V2 packets", () => {
  const dir = repository();
  try {
    const legacy = join(dir, ".foreman", "qa-report-recovery", "legacy");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "manifest.json"), JSON.stringify({ version: 1, packetId: "old", packetDigest: "0".repeat(64), runId: "run", ticketId: "T1", resources: [] }));
    assert.throws(() => loadQaRecoveryPacket(legacy), LegacyQaRecoveryPacketError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("frozen snapshots preserve staged, unstaged, executable, and untracked symlink state", () => {
  const dir = repository();
  try {
    writeFileSync(join(dir, "tracked.txt"), "staged\n"); chmodSync(join(dir, "tracked.txt"), 0o755);
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    writeFileSync(join(dir, "tracked.txt"), "staged\nunstaged\n");
    symlinkSync("tracked.txt", join(dir, "link.txt"));
    const snapshot = createDisposableQaSnapshot(dir);
    try {
      assert.equal(readFileSync(join(snapshot.path, "tracked.txt"), "utf8"), "staged\nunstaged\n");
      assert.equal(lstatSync(join(snapshot.path, "tracked.txt")).mode & 0o111, 0o111);
      assert.equal(readlinkSync(join(snapshot.path, "link.txt")), "tracked.txt");
      assert.ok(execFileSync("git", ["diff", "--cached"], { cwd: snapshot.path, encoding: "utf8" }).length > 0);
      assert.ok(execFileSync("git", ["diff"], { cwd: snapshot.path, encoding: "utf8" }).length > 0);
    } finally { snapshot.remove(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("packet creation rejects a symlinked recovery path", () => {
  const dir = repository();
  const outside = mkdtempSync(join(tmpdir(), "qa-recovery-outside-"));
  try {
    mkdirSync(join(dir, ".foreman"), { recursive: true });
    symlinkSync(outside, join(dir, ".foreman", "qa-report-recovery"), "dir");
    assert.throws(() => createQaRecoveryPacket({
      projectDir: dir, reviewedWorktree: dir, runId: "run", ticketId: "T1", cycle: 1, reviewAttempt: 1,
      recoveryStage: "same-session", resources: { prompt: { value: "x", purpose: "prompt", exactText: true } },
    }), /symlink is not allowed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resumed recovery acknowledges the packet and reconstructs only when reviewed state is unchanged", async () => {
  for (const drift of [false, true]) {
    const dir = repository();
    try {
      const packet = createQaRecoveryPacket({
        projectDir: dir, reviewedWorktree: dir, runId: "resume-run", ticketId: "T1", cycle: 1, reviewAttempt: 1,
        recoveryStage: "operator-menu", resources: { prompt: { value: "original review", purpose: "prompt", exactText: true } },
      });
      if (drift) writeFileSync(join(dir, "tracked.txt"), "changed again\n");
      const qa = new Adapter(`qa-resume-${drift}`, (instruction, turn) => {
        if (turn === 0) {
          const packetDigest = /Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1];
          const reviewed = /Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1];
          return `RAFI_QA_RECOVERY_ACK packet="${packetDigest}" reviewed_state="${reviewed}" required_resources_read="all"`;
        }
        return validReport;
      });
      const result = await runIsolatedQa({
        ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
        builderWorktree: dir, builderSummary: "exact builder response", qaStrategy: "fresh",
        recovery: { projectDir: dir, runId: "resume-run" },
        state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0, createQa: async (cwd) => qaHandleForPacket(qa, cwd, packet), sessionBoundary: unavailableBoundary,
        continuityManaged: true, resumedRecovery: packet, fix: async () => ({ ok: false }),
      });
      assert.equal(result.outcome, "nonconverged");
      assert.match(qa.instructions[0]!, /required recovery resource/);
      if (drift) assert.match(qa.instructions[1]!, /complete review.*source has drifted/is);
      else assert.match(qa.instructions[1]!, /fresh QA session.*complete review/is);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("a malformed resumed report fails closed without reconstruction", async () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({
      projectDir: dir, reviewedWorktree: dir, runId: "resume-invalid", ticketId: "T1", cycle: 1, reviewAttempt: 1,
      recoveryStage: "operator-menu", resources: { prompt: { value: "original review", purpose: "prompt", exactText: true } },
    });
    const qa = new Adapter("qa-resume-invalid", (instruction, turn) => {
      if (turn === 0) {
        const packetDigest = /Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1];
        const reviewed = /Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1];
        return `RAFI_QA_RECOVERY_ACK packet="${packetDigest}" reviewed_state="${reviewed}" required_resources_read="all"`;
      }
      return 'STEP_STATUS: qa_fail | issues="still invalid"';
    });
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh",
      recovery: { projectDir: dir, runId: "resume-invalid" },
      state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0, createQa: async (cwd) => qaHandleForPacket(qa, cwd, packet), sessionBoundary: unavailableBoundary,
      continuityManaged: true, resumedRecovery: packet, fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(qa.instructions.length, 2, "acknowledgement and one report response only");
    assert.match(result.detail ?? "", /reconstruction is no longer authoritative|complete fresh QA review/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a malformed resumed acknowledgement fails closed without operator-menu callback", async () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "resume-bad-ack", ticketId: "T1", cycle: 1, reviewAttempt: 1, recoveryStage: "operator-menu", pendingAction: "operator-menu", resources: { prompt: { value: "original review", purpose: "prompt", exactText: true } } });
    const qa = new Adapter("qa-resume-bad-ack", () => "not an acknowledgement");
    let menuCalls = 0;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", recovery: { projectDir: dir, runId: "resume-bad-ack" },
      state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0, createQa: async (cwd) => qaHandleForPacket(qa, cwd, packet), sessionBoundary: unavailableBoundary,
      continuityManaged: true, resumedRecovery: packet, onReportRecovery: async () => { menuCalls++; return { action: "pause" }; }, fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(menuCalls, 0);
    assert.equal(qa.instructions.length, 2, "acknowledgement repair does not start report corrections");
    assert.match(result.detail ?? "", /reconstruction is no longer authoritative|complete fresh QA review/);
    const db = new WorkflowDb(dir); const head = db.qaRecoveryHead("resume-bad-ack", "T1"); db.close();
    assert.equal(head?.pendingAction, "operator-menu");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a resumed session without an acceptance receipt fails closed without report work", async () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "resume-no-receipt", ticketId: "T1", cycle: 1, reviewAttempt: 1, recoveryStage: "operator-menu", pendingAction: "operator-menu", resources: { prompt: { value: "original review", purpose: "prompt", exactText: true } } });
    const qa = new Adapter("qa-resume-no-receipt", () => validReport);
    let menuCalls = 0;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", recovery: { projectDir: dir, runId: "resume-no-receipt" },
      state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0, createQa: async (cwd) => qaHandle(qa, cwd), sessionBoundary: unavailableBoundary,
      continuityManaged: true, resumedRecovery: packet, onReportRecovery: async () => { menuCalls++; return { action: "pause" }; }, fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(menuCalls, 0);
    assert.equal(qa.instructions.length, 0, "an unaccepted resumed session cannot receive packet or report work");
    assert.match(result.detail ?? "", /reconstruction is no longer authoritative|complete fresh QA review/);
    const db = new WorkflowDb(dir); const head = db.qaRecoveryHead("resume-no-receipt", "T1"); db.close();
    assert.equal(head?.pendingAction, "operator-menu");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid report recovery uses one same-session correction and then requires fresh review", async () => {
  const dir = repository();
  try {
    const current = new Adapter("qa-current", (_instruction, turn) => turn === 0 ? 'STEP_STATUS: qa_fail | issues="one issue"' : 'STEP_STATUS: qa_fail | issues="still invalid"');
    let boundaryCalls = 0;
    let fresh: Adapter | undefined;
    const state: QaStreamState = { reviews: 0, modificationViolations: 0 };
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "compact", state, maxCycles: 0,
      recovery: { projectDir: dir, runId: "invalid-report" },
      createQa: async (cwd) => qaHandle(current, cwd),
      sessionBoundary: async (_handle, _action, strategy, cwd, recovery) => {
        boundaryCalls++; assert.equal(strategy, "fresh"); assert.ok(recovery?.packetDigest); assert.ok(recovery?.reviewedStateDigest);
        fresh = new Adapter("qa-fresh", (instruction, turn) => {
          if (turn === 0 || turn === 1) {
            const packet = /Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1];
            const reviewed = /Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1];
            return `RAFI_QA_RECOVERY_ACK packet="${packet}" reviewed_state="${reviewed}" required_resources_read="all"\nRAFI_CONTINUITY_DELTA {"version":1}`;
          }
          return turn === 2 ? validReport : 'STEP_STATUS: qa_fail | issues="still invalid"';
        });
        return acceptedBoundary(fresh, cwd, recovery);
      },
      fix: async () => ({ ok: false }),
    });
    void fresh;
    assert.equal(result.outcome, "needs-human");
    assert.equal(boundaryCalls, 0);
    assert.equal(current.instructions.length, 2, "original plus one same-session correction");
    assert.match(result.detail ?? "", /complete fresh QA review/);
    const db = new WorkflowDb(dir);
    const pending = db.getRun("invalid-report")?.state.qaReportRecovery as Record<string, unknown>;
    db.close();
    const sealed = loadQaRecoveryPacket(String(pending.packetPath));
    assert.ok(sealed.manifest.resources.some((resource) => resource.path.startsWith("turns/correction-01/")), "same-session correction evidence is sealed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid manual JSON is not an authoritative recovery route", async () => {
  const dir = repository();
  try {
    const current = new Adapter("qa-current-menu", () => 'STEP_STATUS: qa_fail | issues="still invalid"');
    let fresh!: Adapter; let menuCalls = 0;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "compact", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "manual-menu" }, createQa: async (cwd) => qaHandle(current, cwd),
      sessionBoundary: async (_handle, _action, _strategy, cwd, recovery) => {
        fresh = new Adapter("qa-fresh-menu", (instruction, turn) => {
          if (turn === 0) return `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"\nRAFI_CONTINUITY_DELTA {"version":1}`;
          return 'STEP_STATUS: qa_fail | issues="still invalid"';
        });
        return acceptedBoundary(fresh, cwd, recovery);
      },
      onReportRecovery: async () => (++menuCalls === 1 ? { action: "manual" } : { action: "pause" }),
      fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(menuCalls, 0);
    assert.match(result.detail ?? "", /complete fresh QA review|correction exhausted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("report recovery never uses provider compaction or automatic fresh reconstruction", async () => {
  const dir = repository();
  try {
    const current = new Adapter("qa-current-no-compact", () => 'STEP_STATUS: qa_fail | issues="invalid"');
    let compactCalls = 0;
    current.compact = async () => { compactCalls++; return { ok: false, error: "must not compact" }; };
    let boundaryCalls = 0;
    let fresh: Adapter | undefined;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "compact", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "compact-failure" }, createQa: async (cwd) => qaHandle(current, cwd),
      sessionBoundary: async (_handle, _action, _strategy, cwd, recovery) => {
        boundaryCalls++;
        fresh = new Adapter("qa-fresh-no-compact", (instruction, turn) => turn === 0
          ? `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"\nRAFI_CONTINUITY_DELTA {"version":1}`
          : 'STEP_STATUS: qa_fail | issues="invalid"');
        return acceptedBoundary(fresh, cwd, recovery);
      },
      fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(current.instructions.length, 2, "original plus one same-session correction");
    assert.equal(boundaryCalls, 0, "automatic fresh report reconstruction is disabled");
    assert.equal(fresh, undefined);
    assert.equal(compactCalls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an exhausted operator-requested fresh QA cannot reconstruct a report", async () => {
  const dir = repository();
  try {
    const current = new Adapter("qa-current-repeat", () => 'STEP_STATUS: qa_fail | issues="invalid"');
    let boundaryCalls = 0; let menuCalls = 0; const successors: Adapter[] = [];
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "compact", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "repeat-fresh-menu" }, createQa: async (cwd) => qaHandle(current, cwd),
      sessionBoundary: async (_handle, _action, _strategy, cwd, recovery) => {
        boundaryCalls++;
        const adapter = new Adapter(`qa-fresh-repeat-${boundaryCalls}`, (instruction, turn) => turn === 0
          ? `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"\nRAFI_CONTINUITY_DELTA {"version":1}`
          : 'STEP_STATUS: qa_fail | issues="invalid"');
        successors.push(adapter);
        return acceptedBoundary(adapter, cwd, recovery);
      },
      onReportRecovery: async () => {
        menuCalls++;
        if (menuCalls === 1) {
          writeFileSync(join(dir, "tracked.txt"), "changed while recovery menu was open\n");
          return { action: "fresh" };
        }
        return { action: "pause" };
      },
      fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(boundaryCalls, 0, "operator-requested fresh report reconstruction is disabled");
    assert.equal(menuCalls, 0);
    assert.equal(successors.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exhausted report correction does not enter acknowledgement repair", async () => {
  const dir = repository();
  try {
    const current = new Adapter("qa-current-bad-ack", () => 'STEP_STATUS: qa_fail | issues="invalid"');
    let menuCalls = 0;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "compact", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "bad-ack-menu" }, createQa: async (cwd) => qaHandle(current, cwd),
      sessionBoundary: async (_handle, _action, _strategy, cwd, recovery) => acceptedBoundary(new Adapter("qa-fresh-bad-ack", () => "not an acknowledgement"), cwd, recovery),
      onReportRecovery: async () => { menuCalls++; return { action: "pause" }; },
      fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(menuCalls, 0);
    assert.match(result.detail ?? "", /complete fresh QA review|correction exhausted/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("disabled fresh recovery does not expose acknowledgement context mutation path", async () => {
  const dir = repository();
  try {
    const current = new Adapter("qa-current-ack-mutation", () => 'STEP_STATUS: qa_fail | issues="invalid"');
    let fresh: Adapter | undefined; let freshCwd = ""; let menuCalls = 0;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "ack-context-mutation" }, createQa: async (cwd) => qaHandle(current, cwd),
      continuityManaged: true,
      sessionBoundary: async (_handle, _action, _strategy, cwd, recovery) => {
        freshCwd = cwd;
        fresh = new Adapter("qa-fresh-ack-mutation", (instruction) => {
          const relative = /Recovery context directory: (.+)/.exec(instruction)?.[1];
          if (!relative) return validReport;
          writeFileSync(join(freshCwd, relative, "manifest.json"), "mutated");
          return `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"`;
        });
        return acceptedBoundary(fresh, cwd, recovery);
      },
      onReportRecovery: async () => { menuCalls++; return { action: "pause" }; }, fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(menuCalls, 0);
    assert.equal(fresh, undefined);
    assert.equal(freshCwd, "");
    assert.match(result.detail ?? "", /complete fresh QA review|correction exhausted/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("disabled fresh recovery does not expose fresh full-review context mutation path", async () => {
  const dir = repository();
  try {
    const current = new Adapter("qa-current-review-mutation", () => 'STEP_STATUS: qa_fail | issues="invalid"');
    let fresh: Adapter | undefined; let freshCwd = ""; let menuCalls = 0;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "review-context-mutation" }, createQa: async (cwd) => qaHandle(current, cwd),
      continuityManaged: true,
      sessionBoundary: async (_handle, _action, _strategy, cwd, recovery) => {
        freshCwd = cwd;
        fresh = new Adapter("qa-fresh-review-mutation", (instruction, turn) => {
          if (turn === 0) return `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"`;
          const contextRoot = join(freshCwd, ".foreman", "qa-recovery-context");
          const contextName = readdirSync(contextRoot)[0];
          if (!contextName) throw new Error("materialized recovery context is missing");
          writeFileSync(join(contextRoot, contextName, "manifest.json"), "mutated");
          return validReport;
        });
        return acceptedBoundary(fresh, cwd, recovery);
      },
      onReportRecovery: async () => { menuCalls++; return { action: "pause" }; }, fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(menuCalls, 0);
    assert.equal(fresh, undefined);
    assert.equal(freshCwd, "");
    assert.match(result.detail ?? "", /complete fresh QA review|correction exhausted/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy historical hints are not projected into authoritative V2 QA snapshots", async () => {
  const dir = repository();
  try {
    const history = join(dir, ".foreman", "qa-legacy-history", "legacy-one");
    mkdirSync(history, { recursive: true, mode: 0o700 });
    writeFileSync(join(history, "historical-context.json"), JSON.stringify({ authoritative: false, incomplete: true }));
    writeFileSync(join(history, "old-report.txt"), "untrusted old report");
    const db = new WorkflowDb(dir);
    const run = db.ensureRun("legacy-hints");
    db.transition("legacy-hints", {
      status: run.status, checkpoint: run.checkpoint, remainingWork: run.remainingWork,
      state: { ...run.state, qaReportRecovery: { pendingAction: "legacy-historical-full-review", historicalContextPath: history, authoritative: false } },
      event: "legacy_hints_fixture", payload: {},
    });
    db.close();
    let copied = false;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "legacy-hints" },
      createQa: async (cwd) => {
        copied = existsSync(join(cwd, ".foreman", "qa-legacy-history", "legacy-one", "old-report.txt"));
        return qaHandle(new Adapter("legacy-hints-qa", (instruction) => {
          assert.doesNotMatch(instruction, /Non-authoritative legacy QA context/);
          return 'STEP_STATUS: qa_pass | summary="new full review passed"';
        }), cwd);
      },
      sessionBoundary: unavailableBoundary,
      fix: async () => ({ ok: false }),
    });
    assert.equal(copied, false);
    assert.equal(result.outcome, "passed", JSON.stringify(result));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a provider context-window discovery turn is journaled before the first QA review", async () => {
  const dir = repository();
  try {
    const qa = new SetupTurnAdapter("qa-setup", (_instruction, turn) => turn === 0
      ? "context ready"
      : 'STEP_STATUS: qa_pass | summary="reviewed after setup"');
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh",
      recovery: { projectDir: dir, runId: "journaled-setup" }, state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      createQa: async (cwd) => qaHandle(qa, cwd), sessionBoundary: unavailableBoundary, fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "passed", JSON.stringify(result));
    assert.equal(qa.instructions.length, 2);
    assert.match(qa.instructions[0]!, /session initialization only/);
    assert.match(qa.instructions[1]!, /Now QA the ticket/);
    const rawDb = new Database(join(dir, ".rafi/recovery.sqlite3"));
    const slots = rawDb.prepare("SELECT retry_slot,status FROM qa_turns WHERE run_id=? AND ticket_id=? ORDER BY created_at").all("journaled-setup", "T1") as Array<{ retry_slot: string; status: string }>;
    rawDb.close();
    assert.deepEqual(slots, [
      { retry_slot: "session-initialization", status: "completed" },
      { retry_slot: "initial", status: "completed" },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review and Builder remediation history survives a fresh host process state", async () => {
  const dir = repository();
  try {
    const ticket = { id: "T1", order: 1, title: "QA", area: "test", priority: "P1" as const, size: "S" as const, risk: "Low" as const, depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] };
    let created = 0;
    const first = await runIsolatedQa({ ticket, builderWorktree: dir, builderSummary: "initial result", qaStrategy: "fresh", recovery: { projectDir: dir, runId: "durable-history" },
      state: { reviews: 0, modificationViolations: 0 }, maxCycles: 1, sessionBoundary: unavailableBoundary,
      createQa: async (cwd) => qaHandle(new Adapter(`history-${++created}`, () => created === 1 ? validReport : 'STEP_STATUS: qa_pass | summary="fixed"'), cwd),
      fix: async (request) => {
        assert.equal(request.kind, "validated-report");
        if (request.kind === "validated-report") assert.equal(request.report.findings[0]!.id, "F1");
        return { ok: true, response: 'Builder exact remediation\nSTEP_STATUS: done | summary="fixed"', summary: "bounded fix summary", providerTurnId: "builder-fix-1" };
      },
    });
    assert.equal(first.outcome, "passed");
    const db = new WorkflowDb(dir);
    const reviews = db.qaReviewAttempts("durable-history", "T1");
    const fixes = db.qaRemediationAttempts("durable-history", "T1");
    assert.equal(reviews.length, 2);
    assert.deepEqual(reviews.map((item) => item.remediationGeneration), [0, 1]);
    assert.match(reviews[0]?.namespacedFindingIds?.[0] ?? "", /^[a-f0-9]{64}$/);
    assert.equal(fixes.length, 1);
    assert.match(db.getEvidence(fixes[0]!.responseDigest!)?.toString() ?? "", /Builder exact remediation/);
    db.close();

    let restartPrompt = "";
    const restarted = await runIsolatedQa({ ticket, builderWorktree: dir, builderSummary: "fixed result", qaStrategy: "fresh", recovery: { projectDir: dir, runId: "durable-history" },
      state: { reviews: 0, modificationViolations: 0 }, maxCycles: 1, sessionBoundary: unavailableBoundary,
      createQa: async (cwd) => qaHandle(new Adapter("history-restart", (instruction) => { restartPrompt = instruction; return 'STEP_STATUS: qa_pass | summary="still fixed"'; }), cwd),
      fix: async () => ({ ok: false }),
    });
    assert.equal(restarted.outcome, "passed");
    const restartedDb = new WorkflowDb(dir);
    assert.equal(restartedDb.qaReviewAttempts("durable-history", "T1").at(-1)?.remediationGeneration, 1);
    restartedDb.close();
    assert.match(restartPrompt, /Prior authoritative QA\/report and Builder-remediation history/);
    assert.match(restartPrompt, /bounded fix summary|Builder exact remediation/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a resumed acknowledgement failure cannot reconstruct through another QA session", async () => {
  const dir = repository();
  try {
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: "resumed-seal", ticketId: "T1", cycle: 1,
      reviewAttempt: 1, recoveryStage: "operator-menu", resources: { prompt: { value: "prior review", purpose: "original review", exactText: true } } });
    const original = new Adapter("resumed-bad-ack", () => "invalid acknowledgement");
    let originalCwd = "";
    let successorCwd = "";
    let menuCalls = 0;
    const successor = new Adapter("resumed-good-successor", (instruction, turn) => turn === 0
      ? `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"`
      : 'STEP_STATUS: qa_pass | summary="fresh review passed"');
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", recovery: { projectDir: dir, runId: "resumed-seal" },
      state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0, continuityManaged: true, resumedRecovery: packet,
      createQa: async (cwd) => { originalCwd = cwd; return qaHandleForPacket(original, cwd, packet); },
      sessionBoundary: async (_handle, _action, _strategy, cwd, recovery) => { successorCwd = cwd; return acceptedBoundary(successor, cwd, recovery); },
      onReportRecovery: async () => { menuCalls++; return { action: "fresh" }; }, fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(menuCalls, 0);
    assert.equal(original.instructions.length, 2);
    assert.equal(successor.instructions.length, 0);
    assert.match(result.detail ?? "", /reconstruction is no longer authoritative|complete fresh QA review/);
    assert.equal(existsSync(originalCwd), false);
    assert.equal(successorCwd, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an existing unresolved packet follows a changed-source recheck and remains resumable after a blocker", async () => {
  const dir = repository();
  try {
    const ticket = { id: "T1", order: 1, title: "QA", area: "test", priority: "P1" as const, size: "S" as const, risk: "Low" as const, depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] };
    let created = 0;
    const result = await runIsolatedQa({ ticket, builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh",
      recovery: { projectDir: dir, runId: "packet-recheck" }, state: { reviews: 0, modificationViolations: 0 }, maxCycles: 1,
      createQa: async (cwd) => {
        const cycle = ++created;
        return qaHandle(new Adapter(`packet-recheck-${cycle}`, (_instruction, turn) => cycle === 1
          ? turn === 0 ? 'STEP_STATUS: qa_fail | issues="one issue"' : validReport
          : 'STEP_STATUS: blocked | reason="external test unavailable"'), cwd);
      }, sessionBoundary: unavailableBoundary,
      fix: async () => {
        writeFileSync(join(dir, "tracked.txt"), "remediated source\n");
        return { ok: true, response: 'exact fix\nSTEP_STATUS: done | summary="fixed"', summary: "fixed", providerTurnId: "packet-recheck-fix" };
      },
    });
    assert.equal(result.outcome, "needs-human");
    const db = new WorkflowDb(dir);
    const head = db.qaTicketHead("packet-recheck", "T1");
    const pending = db.qaRecoveryHead("packet-recheck", "T1")!;
    const packet = loadQaRecoveryPacket(pending.packetPath);
    const attempt = db.qaReviewAttempt(packet.manifest.reviewAttemptId)!;
    assert.equal(packet.manifest.reviewAttempt, head.reviewNumber);
    assert.equal(attempt.reviewNumber, head.reviewNumber);
    assert.equal(packet.manifest.reviewedStateDigest, head.sourceStateDigest);
    assert.equal(packet.manifest.pendingAction, "operator-menu");
    assert.notEqual(packet.manifest.originalReviewedStateDigest, packet.manifest.reviewedStateDigest);
    db.close();
    const qa = new Adapter("packet-recheck-resumed", (instruction, turn) => turn === 0
      ? `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"`
      : 'STEP_STATUS: qa_pass | summary="recheck passed"');
    const resumed = await runIsolatedQa({ ticket, builderWorktree: dir, builderSummary: "fixed", qaStrategy: "fresh",
      recovery: { projectDir: dir, runId: "packet-recheck" }, state: { reviews: 0, modificationViolations: 0 }, maxCycles: 1,
      resumedRecovery: packet, continuityManaged: true, createQa: async (cwd) => qaHandleForPacket(qa, cwd, packet),
      sessionBoundary: unavailableBoundary, fix: async () => { throw new Error("completed Builder fix must not replay"); },
    });
    assert.equal(resumed.outcome, "passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("plain fallback is not used as an authoritative Builder remediation route", async () => {
  const dir = repository();
  try {
    let created = 0;
    let fixes = 0;
    let menuCalls = 0;
    let secondReviewPrompt = "";
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", recovery: { projectDir: dir, runId: "packet-reuse" },
      state: { reviews: 0, modificationViolations: 0 }, maxCycles: 1, continuityManaged: true,
      createQa: async (cwd) => {
        const cycle = ++created;
        return qaHandle(new Adapter(`packet-reuse-${cycle}`, (instruction, turn) => {
          if (cycle === 2 && turn === 0) secondReviewPrompt = instruction;
          return cycle === 2 && turn > 0 ? validReport : 'STEP_STATUS: qa_fail | issues="plain blocking issue"';
        }), cwd);
      },
      sessionBoundary: async (_handle, _action, _strategy, cwd, recovery) => acceptedBoundary(new Adapter("packet-reuse-fresh", (instruction, turn) => turn === 0
        ? `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"`
        : 'STEP_STATUS: qa_fail | issues="plain blocking issue"'), cwd, recovery),
      onReportRecovery: async () => (++menuCalls === 1 ? { action: "plain" } : { action: "pause" }),
      fix: async () => { fixes++; return { ok: true, response: 'plain fix exact response\nSTEP_STATUS: done | summary="fixed"', summary: "plain fix summary", providerTurnId: "plain-fix" }; },
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(fixes, 0, "plain fallback is not dispatched to Builder");
    assert.equal(menuCalls, 0);
    assert.equal(secondReviewPrompt, "");
    assert.match(result.detail ?? "", /complete fresh QA review|correction exhausted/);
    const db = new WorkflowDb(dir);
    const head = db.qaTicketHead("packet-reuse", "T1");
    const packet = loadQaRecoveryPacket(db.qaRecoveryHead("packet-reuse", "T1")!.packetPath);
    assert.equal(packet.manifest.reviewAttempt, 1);
    assert.equal(packet.manifest.reviewAttempt, head.reviewNumber);
    assert.equal(db.qaReviewAttempt(packet.manifest.reviewAttemptId)?.reviewNumber, head.reviewNumber);
    assert.ok(packet.manifest.resources.some((resource) => resource.path === "context/original-raw-response.txt"));
    assert.equal(db.qaReviewAttempts("packet-reuse", "T1").at(-1)?.remediationGeneration, 0);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startup reconciles a changed-source recheck allocated before packet review identity publication", async () => {
  const dir = repository();
  const originalCommit = WorkflowDb.prototype.commitQaReviewReady;
  let allocations = 0;
  try {
    WorkflowDb.prototype.commitQaReviewReady = function (...args: Parameters<WorkflowDb["commitQaReviewReady"]>) {
      const head = originalCommit.apply(this, args);
      if (++allocations === 2) throw new Error("simulated crash after review allocation");
      return head;
    };
    let created = 0;
    await assert.rejects(runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "fresh", recovery: { projectDir: dir, runId: "recheck-allocation-crash" },
      state: { reviews: 0, modificationViolations: 0 }, maxCycles: 1,
      createQa: async (cwd) => qaHandle(new Adapter(`allocation-${++created}`, (_instruction, turn) => turn === 0
        ? 'STEP_STATUS: qa_fail | issues="one issue"' : validReport), cwd), sessionBoundary: unavailableBoundary,
      fix: async () => {
        writeFileSync(join(dir, "tracked.txt"), "changed by completed Builder fix\n");
        return { ok: true, response: 'STEP_STATUS: done | summary="fixed"', summary: "fixed", providerTurnId: "allocation-fix" };
      },
    }), /simulated crash after review allocation/);
    WorkflowDb.prototype.commitQaReviewReady = originalCommit;
    const beforeDb = new WorkflowDb(dir);
    const head = beforeDb.qaTicketHead("recheck-allocation-crash", "T1");
    const before = loadQaRecoveryPacket(beforeDb.qaRecoveryHead("recheck-allocation-crash", "T1")!.packetPath);
    assert.equal(head.state, "review-ready");
    assert.equal(head.reviewNumber, 2);
    assert.equal(before.manifest.reviewAttempt, 1);
    assert.equal(beforeDb.qaReviewAttempt(before.manifest.reviewAttemptId)?.status, "failed");
    assert.equal(before.manifest.reviewedStateDigest, head.sourceStateDigest);
    beforeDb.close();
    const reconciled = recoverPendingQaRecoveryPublications(dir, "recheck-allocation-crash");
    assert.equal(reconciled.length, 1);
    const after = reconciled[0]!;
    const afterDb = new WorkflowDb(dir);
    assert.equal(after.manifest.reviewAttempt, head.reviewNumber);
    assert.equal(afterDb.qaReviewAttempt(after.manifest.reviewAttemptId)?.reviewNumber, head.reviewNumber);
    assert.equal(afterDb.qaReviewAttempt(after.manifest.reviewAttemptId)?.status, "started");
    afterDb.close();
    assert.deepEqual(recoverPendingQaRecoveryPublications(dir, "recheck-allocation-crash"), []);
  } finally {
    WorkflowDb.prototype.commitQaReviewReady = originalCommit;
    rmSync(dir, { recursive: true, force: true });
  }
});
