import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILDER_QA_REMEDIATION_END,
  BUILDER_QA_REMEDIATION_START,
  type ProviderSessionRefV1,
  type QaFailureReportV1,
} from "rafi-spec";
import type { BuilderAdapter, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import { QaFailureDeliveryService } from "../src/qaFailureDelivery.js";
import { canonicalJson, createQaFindingRefs } from "../src/qaProtocolV2.js";
import { qaReportDigest } from "../src/qaRecovery.js";
import { captureFrozenQaSourceAsync } from "../src/qaSnapshot.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import { WorkflowDb } from "../src/workflowDb.js";

const ticket: TicketDef = {
  id: "T001",
  order: 1,
  title: "Handle empty input",
  area: "core",
  priority: "P2",
  size: "M",
  risk: "Medium",
  depends_on: [],
  summary: "Return an empty result for empty input.",
  acceptance: ["empty input returns []"],
  required_tests: ["pnpm test"],
  likely_files: ["input.ts"],
};

const report: QaFailureReportV1 = {
  version: 1,
  summary: "Empty input fails",
  checks_run: [{ check: "unit", command: "pnpm test", outcome: "failed", evidence: "empty input test failed" }],
  findings: [{
    id: "QA-1",
    requirement: "empty input returns []",
    locations: ["src/input.ts:1"],
    problem: "throws on empty input",
    evidence: "TypeError from test",
    expected: "return []",
    fix_direction: "guard empty array",
    verification: ["run pnpm test"],
  }],
  observations: ["happy path still passes"],
};

class FakeBuilder implements BuilderAdapter {
  readonly agent = "codex" as const;
  readonly instructions: string[] = [];
  private queue: BuilderEvent[] = [];
  private observers = new Set<(event: BuilderEvent) => void>();
  observeEvents(listener: (event: BuilderEvent) => void): () => void { this.observers.add(listener); return () => { this.observers.delete(listener); }; }
  private closed = false;
  response = "";
  ref: ProviderSessionRefV1;

  constructor(cwd: string) {
    const now = new Date(0).toISOString();
    this.ref = {
      version: 1,
      provider: "codex",
      sessionId: "builder-session-1",
      role: "builder",
      stream: "builder",
      generation: 0,
      cwd,
      configRoot: cwd,
      ticketId: "T001",
      source: "observed",
      createdAt: now,
      validatedAt: now,
    };
  }

  async sendTurn(instruction: string): Promise<TurnResult> {
    this.instructions.push(instruction);
    if (!this.response) {
      const handoffId = /QA failure handoff ID: ([a-f0-9]{64})/.exec(instruction)?.[1];
      const findingKey = /QA-1 -> ([a-f0-9]{64})/.exec(instruction)?.[1];
      assert.ok(handoffId);
      assert.ok(findingKey);
      this.response = [
        BUILDER_QA_REMEDIATION_START,
        JSON.stringify({
          version: 2,
          handoff_id: handoffId,
          summary: "Fixed empty input.",
          findings: [{
            finding_key: findingKey,
            raw_id: "QA-1",
            disposition: "fixed",
            changes: ["Added empty input guard."],
            evidence: "input.ts changed",
            verification: [{ check: "pnpm test", outcome: "passed", evidence: "passed" }],
          }],
          observations: [],
        }),
        BUILDER_QA_REMEDIATION_END,
        'STEP_STATUS: done | summary="fixed"',
      ].join("\n");
    }
    const result: TurnResult = {
      text: this.response,
      isError: false,
      numTurns: 1,
      costUsd: 0,
      turnId: "builder-turn-1",
      hostInstruction: instruction,
      providerInstruction: `provider role text\n${instruction}`,
      rawResponse: this.response,
      cleanedResponse: this.response,
      providerMetadata: { provider: "codex", sessionId: this.ref.sessionId, sessionRef: this.ref },
    };
    const event: BuilderEvent = { kind: "turn-complete", result, turnId: result.turnId };
    this.queue.push(event);
    for (const listener of this.observers) listener(event);
    return result;
  }

  sessionId(): string | undefined { return this.ref.sessionId; }
  sessionRef(): ProviderSessionRefV1 | undefined { return this.ref; }
  async *events(): AsyncIterable<BuilderEvent> { while (!this.closed || this.queue.length) { const event = this.queue.shift(); if (event) yield event; else break; } }
  async close(): Promise<void> { this.closed = true; }
}

test("QA failure delivery service sends complete source-bound handoff and requires QA recheck", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-qa-delivery-"));
  try {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "input.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "input.ts"), "export const value = 2;\n");

    const source = await captureFrozenQaSourceAsync(root);
    const reportDigest = qaReportDigest(report);
    const findingRefs = createQaFindingRefs({
      runId: "run",
      ticketId: ticket.id,
      reviewAttemptId: "review-1",
      reportDigest,
      rawFindingIds: report.findings.map((finding) => finding.id),
    });
    const db = new WorkflowDb(root);
    try {
      db.ensureRun("run");
      let head = db.qaTicketHead("run", ticket.id);
      head = db.transitionQa("run", ticket.id, head.revision, { type: "source-frozen", sourceStateDigest: source.digest });
      head = db.transitionQa("run", ticket.id, head.revision, { type: "review-ready", reviewBasisDigest: "basis-1", sessionGeneration: 0 });
      db.beginQaReviewAttempt({ attemptId: "review-1", runId: "run", ticketId: ticket.id, reviewNumber: 1, cycle: 1, remediationGeneration: 0, sourceDigest: source.digest });
      head = db.transitionQa("run", ticket.id, head.revision, { type: "turn-intended", slot: "initial" });
      db.putEvidence("qa", Buffer.from(canonicalJson(report)));
      db.commitQaFailureAttempt("review-1", {
        reportDigest,
        runId: "run",
        ticketId: ticket.id,
        reviewNumber: 1,
        sourceStateDigest: source.digest,
        reviewBasisDigest: "basis-1",
        report,
      }, report.findings.map((finding) => finding.id), findingRefs.map((finding) => finding.findingKey), report.summary, head.revision);
    } finally { db.close(); }

    const builder = new FakeBuilder(root);
    const service = new QaFailureDeliveryService();
    const result = await service.deliver({
      projectDir: root,
      runId: "run",
      ticket,
      builderWorktree: root,
      report,
      reportDigest,
      reviewAttemptId: "review-1",
      reviewNumber: 1,
      reviewedSourceStateDigest: source.digest,
      reviewBasisDigest: "basis-1",
      remediationGeneration: 0,
      latestBuilderResult: "implemented",
      history: [],
    }, { adapter: () => builder, sessionStrategy: "compact" });

    assert.equal(result.ok, true, result.detail);
    assert.match(builder.instructions[0] ?? "", /Current validated QA failure report/);
    assert.match(builder.instructions[0] ?? "", new RegExp(findingRefs[0]!.findingKey));

    const finalDb = new WorkflowDb(root);
    try {
      assert.equal(finalDb.qaReport(reportDigest)?.disposition, "recheck-required");
      assert.equal(finalDb.qaRemediationAttempts("run", ticket.id).at(-1)?.status, "succeeded");
      const handoff = finalDb.qaFailureHandoffs("run", ticket.id).at(-1);
      assert.equal(handoff?.state, "recheck-required");
      assert.equal(handoff?.reportDigest, reportDigest);
      assert.equal(handoff?.responseDigest, finalDb.qaRemediationAttempts("run", ticket.id).at(-1)?.responseDigest);
      assert.equal(handoff?.builderSession?.sessionId, "builder-session-1");
    } finally { finalDb.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
