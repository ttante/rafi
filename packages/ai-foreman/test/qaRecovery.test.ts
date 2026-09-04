import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BuilderAdapter, BuilderEvent, CompactResult, TurnResult } from "../src/adapters/types.js";
import { runIsolatedQa, type QaStreamState } from "../src/qaReview.js";
import { appendQaRecoveryResource, compareQaRecoveryReviewedState, createQaRecoveryPacket, LegacyQaRecoveryPacketError, loadQaRecoveryPacket, materializeQaRecoveryContext, validateManualQaReport } from "../src/qaRecovery.js";
import { createDisposableQaSnapshot } from "../src/qaSnapshot.js";
import { WorkflowDb } from "../src/workflowDb.js";

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
  async sendTurn(instruction: string): Promise<TurnResult> {
    this.instructions.push(instruction);
    const turn = this.turn++;
    const text = this.reply(instruction, turn);
    return { text, isError: false, numTurns: 1, costUsd: 0, turnId: `${this.id}-${turn}`, hostInstruction: instruction, providerInstruction: instruction, rawResponse: text, cleanedResponse: text, providerMetadata: { provider: "codex", sessionId: this.id } };
  }
  sessionId(): string { return this.id; }
  async compact(): Promise<CompactResult> { return { ok: true }; }
  async *events(): AsyncIterable<BuilderEvent> {}
  async close(): Promise<void> {}
}

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
    assert.ok(drift.drift.some((path) => path.includes("untracked")));
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
    writeFileSync(join(next.directory, "manifest.json"), readFileSync(join(next.directory, "manifests/revision-00000001.json")));
    assert.equal(loadQaRecoveryPacket(next.directory).manifest.revision, 2, "a durable revision is promoted after an interrupted manifest-pointer replacement");
    writeFileSync(join(next.directory, "prompts/correction.txt"), "tampered");
    assert.throws(() => loadQaRecoveryPacket(next.directory), /projection mismatch/);
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
        state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0, createQa: async () => qa,
        continuityManaged: true, resumedRecovery: packet, fix: async () => ({ ok: false }),
      });
      assert.equal(result.outcome, "nonconverged");
      assert.match(qa.instructions[0]!, /required recovery resource/);
      if (drift) assert.match(qa.instructions[1]!, /source has drifted.*complete review/is);
      else assert.match(qa.instructions[1]!, /Report correction only/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("a malformed resumed report gets exactly five fresh-successor corrections", async () => {
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
      state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0, createQa: async () => qa,
      continuityManaged: true, resumedRecovery: packet, fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(qa.instructions.length, 7, "acknowledgement, one report response, and exactly five corrections");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid report recovery uses exactly two current, two post-compact, and up to five fresh correction turns", async () => {
  const dir = repository();
  try {
    const current = new Adapter("qa-current", (_instruction, turn) => turn === 0 ? 'STEP_STATUS: qa_fail | issues="one issue"' : 'STEP_STATUS: qa_fail | issues="still invalid"');
    let fresh!: Adapter;
    let boundaryCalls = 0;
    const state: QaStreamState = { reviews: 0, modificationViolations: 0 };
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "compact", state, maxCycles: 0,
      recovery: { projectDir: dir, runId: "invalid-report" },
      createQa: async () => current,
      sessionBoundary: async (_adapter, _action, strategy, _cwd, recovery) => {
        boundaryCalls++; assert.equal(strategy, "fresh"); assert.ok(recovery?.packetDigest); assert.ok(recovery?.reviewedStateDigest);
        fresh = new Adapter("qa-fresh", (instruction, turn) => {
          if (turn === 0 || turn === 1) {
            const packet = /Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1];
            const reviewed = /Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1];
            return `RAFI_QA_RECOVERY_ACK packet="${packet}" reviewed_state="${reviewed}" required_resources_read="all"\nRAFI_CONTINUITY_DELTA {"version":1}`;
          }
          return turn === 5 ? validReport : 'STEP_STATUS: qa_fail | issues="still invalid"';
        });
        return fresh;
      },
      fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "nonconverged");
    assert.equal(boundaryCalls, 1);
    assert.equal(current.instructions.length, 5, "original plus four same-session corrections");
    assert.equal(fresh.instructions.length, 6, "one acknowledgement plus five corrections");
    const db = new WorkflowDb(dir);
    const pending = db.getRun("invalid-report")?.state.qaReportRecovery as Record<string, unknown>;
    db.close();
    const sealed = loadQaRecoveryPacket(String(pending.packetPath));
    for (const suffix of ["host-prompt.txt", "provider-prompt.txt", "raw-response.txt", "cleaned-response.txt", "metadata.json", "events.json"]) {
      assert.ok(sealed.manifest.resources.some((resource) => resource.path === `turns/fresh-successor-acknowledgement/${suffix}`), `missing exact acknowledgement ${suffix}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid manual JSON returns to the operator menu and can then pause", async () => {
  const dir = repository();
  try {
    const current = new Adapter("qa-current-menu", () => 'STEP_STATUS: qa_fail | issues="still invalid"');
    let fresh!: Adapter; let menuCalls = 0;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "compact", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "manual-menu" }, createQa: async () => current,
      sessionBoundary: async () => {
        fresh = new Adapter("qa-fresh-menu", (instruction, turn) => {
          if (turn === 0) return `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"\nRAFI_CONTINUITY_DELTA {"version":1}`;
          return 'STEP_STATUS: qa_fail | issues="still invalid"';
        });
        return fresh;
      },
      onReportRecovery: async () => (++menuCalls === 1 ? { action: "manual" } : { action: "pause" }),
      fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(menuCalls, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compaction failure skips post-compaction corrections and goes directly to fresh recovery", async () => {
  const dir = repository();
  try {
    const current = new Adapter("qa-current-no-compact", () => 'STEP_STATUS: qa_fail | issues="invalid"');
    current.compact = async () => ({ ok: false, error: "no compaction" });
    let fresh!: Adapter;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "compact", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "compact-failure" }, createQa: async () => current,
      sessionBoundary: async () => {
        fresh = new Adapter("qa-fresh-no-compact", (instruction, turn) => turn === 0
          ? `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"\nRAFI_CONTINUITY_DELTA {"version":1}`
          : 'STEP_STATUS: qa_fail | issues="invalid"');
        return fresh;
      },
      fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(current.instructions.length, 3, "original plus two same-session corrections");
    assert.equal(fresh.instructions.length, 6, "acknowledgement plus five fresh corrections");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an exhausted operator-requested fresh QA returns to the menu", async () => {
  const dir = repository();
  try {
    const current = new Adapter("qa-current-repeat", () => 'STEP_STATUS: qa_fail | issues="invalid"');
    let boundaryCalls = 0; let menuCalls = 0;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "compact", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "repeat-fresh-menu" }, createQa: async () => current,
      sessionBoundary: async () => {
        boundaryCalls++;
        return new Adapter(`qa-fresh-repeat-${boundaryCalls}`, (instruction, turn) => turn === 0
          ? `RAFI_QA_RECOVERY_ACK packet="${/Packet digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" reviewed_state="${/Reviewed-state digest: ([a-f0-9]{64})/.exec(instruction)?.[1]}" required_resources_read="all"\nRAFI_CONTINUITY_DELTA {"version":1}`
          : 'STEP_STATUS: qa_fail | issues="invalid"');
      },
      onReportRecovery: async () => (++menuCalls === 1 ? { action: "fresh" } : { action: "pause" }),
      fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(boundaryCalls, 2, "automatic fresh successor plus one operator-requested successor");
    assert.equal(menuCalls, 2, "fresh exhaustion must redisplay the operator menu");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an exhausted acknowledgement repair returns to the menu", async () => {
  const dir = repository();
  try {
    const current = new Adapter("qa-current-bad-ack", () => 'STEP_STATUS: qa_fail | issues="invalid"');
    let menuCalls = 0;
    const result = await runIsolatedQa({
      ticket: { id: "T1", order: 1, title: "QA", area: "test", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "test", acceptance: ["works"], required_tests: ["test"], likely_files: ["tracked.txt"] },
      builderWorktree: dir, builderSummary: "implemented", qaStrategy: "compact", state: { reviews: 0, modificationViolations: 0 }, maxCycles: 0,
      recovery: { projectDir: dir, runId: "bad-ack-menu" }, createQa: async () => current,
      sessionBoundary: async () => new Adapter("qa-fresh-bad-ack", () => "not an acknowledgement"),
      onReportRecovery: async () => { menuCalls++; return { action: "pause" }; },
      fix: async () => ({ ok: false }),
    });
    assert.equal(result.outcome, "needs-human");
    assert.equal(menuCalls, 1);
    assert.match(result.detail ?? "", /acknowledgement failed/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy historical hints are copied into a fresh snapshot as non-authoritative context", async () => {
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
        copied = readFileSync(join(cwd, ".foreman", "qa-legacy-history", "legacy-one", "old-report.txt"), "utf8") === "untrusted old report";
        return new Adapter("legacy-hints-qa", (instruction) => {
          assert.match(instruction, /Non-authoritative legacy QA context/);
          assert.match(instruction, /Perform a complete review/);
          return 'STEP_STATUS: qa_pass | summary="new full review passed"';
        });
      },
      fix: async () => ({ ok: false }),
    });
    assert.equal(copied, true);
    assert.equal(result.outcome, "passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
