import { canonicalFixtureTurn } from "./helpers/nativeOutput.js";
import { withGraphDerivedAccess } from "../src/graph/derived.js";
import { graphExclusions } from "../src/graph/corpus.js";
import { loadGraphConfig } from "../src/graph/config.js";
import { digest } from "../src/graph/util.js";
import { adoptGraph, disableGraph } from "../src/graph/maintenance.js";
import { DEFAULT_GRAPH_CONFIG } from "rafi-spec";
import { admitFixtureWork } from "./helpers/workAdmission.js";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProviderSessionRefV1,
  type QaFailureReportV1,
} from "rafi-spec";
import type { BuilderAdapter, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import { QaFailureDeliveryService, QA_REMEDIATION_CHUNK_SIZE, selectQaRemediationFindingIds } from "../src/qaFailureDelivery.js";
import { canonicalJson, createQaFindingRefs } from "../src/qaProtocolV2.js";
import { qaReportDigest } from "../src/qaRecovery.js";
import { captureFrozenQaSourceAsync } from "../src/qaSnapshot.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import { WorkflowDb } from "../src/workflowDb.js";
// Legacy text markers, kept only to prove old-format output is rejected.
const BUILDER_QA_REMEDIATION_START = "RAFI_BUILDER_QA_REMEDIATION_START";
const BUILDER_QA_REMEDIATION_END = "RAFI_BUILDER_QA_REMEDIATION_END";

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

test("QA remediation chunks are bounded and never replace the full failure report", () => {
  const expanded = {
    ...report,
    findings: [
      ...report.findings,
      { ...report.findings[0]!, id: "QA-2", requirement: "second requirement" },
      { ...report.findings[0]!, id: "QA-3", requirement: "third requirement" },
    ],
  };
  assert.deepEqual(selectQaRemediationFindingIds(expanded), ["QA-1", "QA-2"]);
  assert.equal(selectQaRemediationFindingIds(expanded).length <= QA_REMEDIATION_CHUNK_SIZE, true);
  assert.equal(expanded.findings.length, 3, "the full QA report remains available to the subsequent independent review");
});

class FakeBuilder implements BuilderAdapter {
  readonly agent = "codex" as const;
  readonly instructions: string[] = [];
  private queue: BuilderEvent[] = [];
  private observers = new Set<(event: BuilderEvent) => void>();
  observeEvents(listener: (event: BuilderEvent) => void): () => void { this.observers.add(listener); return () => { this.observers.delete(listener); }; }
  private closed = false;
  response = "";
  correctionItemType = "text";
  emitTestLifecycle = false;
  ref: ProviderSessionRefV1;
  private handoffId?: string;
  private findingKey?: string;

  constructor(cwd: string, private readonly graphEnabled = false) {
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

  async sendTurn(instruction: string, policy?: Parameters<BuilderAdapter["sendTurn"]>[1]): Promise<TurnResult> {
    this.instructions.push(instruction);
    if (this.emitTestLifecycle) {
      const started: BuilderEvent = { kind: "tool", name: "Bash", input: { command: "node --test test/input.test.ts" }, lifecycle: "started", callId: "test-call", providerTurnId: policy?.dispatchId };
      for (const listener of this.observers) listener(started);
      const completed: BuilderEvent = { ...started, lifecycle: "completed", completionKnown: true, exitCode: 0 };
      for (const listener of this.observers) listener(completed);
    }
    if (!this.response) {
      const handoffId = /QA failure handoff ID: ([a-f0-9]{64})/.exec(instruction)?.[1];
      const findingKey = /QA-1 -> ([a-f0-9]{64})/.exec(instruction)?.[1];
      assert.ok(handoffId);
      assert.ok(findingKey);
      this.handoffId = handoffId;
      this.findingKey = findingKey;
      this.response = [
        BUILDER_QA_REMEDIATION_START,
        JSON.stringify({
          version: 3,
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
    const graphRequest = this.graphEnabled && this.instructions.length === 1;
    const alternative = graphRequest
      ? { kind: "graph-request", request: { kind: "rafi_graph_request", version: 1, requestId: "impact", operations: [{ operation: "query", query: "input" }] } }
      : { kind: "completed", summary: "Fixed empty input.", payload: {
        status: "done", reason: null, coverage: null,
        report: {
          version: 3, handoff_id: this.handoffId, summary: "Fixed empty input.",
          findings: [{
            finding_key: this.findingKey, raw_id: "QA-1", disposition: "fixed",
            changes: ["Added empty input guard."], evidence: "input.ts changed",
            verification: [{ check: "pnpm test", outcome: "passed", evidence: "passed" }],
          }], observations: [],
        },
      } };
    // Text is presentation-only.  The fixture authority is an explicitly
    // authored native v2 envelope, never a parser-derived marker response.
    const wire = graphRequest ? JSON.stringify(alternative.request) : this.response;
    let result: TurnResult = {
      ...canonicalFixtureTurn(policy, this.ref.sessionId, undefined, "codex", alternative),
      text: wire,
      isError: false,
      numTurns: 1,
      costUsd: 0,
      turnId: policy?.dispatchId,
      hostInstruction: instruction,
      providerInstruction: `provider role text\n${instruction}`,
      rawResponse: wire,
      cleanedResponse: wire,
      providerMetadata: { provider: "codex", sessionId: this.ref.sessionId, sessionRef: this.ref },
    };
    const item: BuilderEvent = { kind: "provider-item", provider: "claude", payloadCompleteness: "complete", itemType: this.instructions.length > 1 ? this.correctionItemType : "text", lifecycle: "completed", payload: { text: wire } };
    for (const listener of this.observers) listener(item);
    const event: BuilderEvent = { kind: "turn-complete", result, turnId: result.turnId };
    this.queue.push(event);
    for (const listener of this.observers) listener(event);
    return result;
  }

  sessionId(): string | undefined { return this.ref.sessionId; }
  sessionRef(): ProviderSessionRefV1 | undefined { return this.ref; }
  async prepareSession(): Promise<ProviderSessionRefV1> { return this.ref; }
  async *events(): AsyncIterable<BuilderEvent> { while (!this.closed || this.queue.length) { const event = this.queue.shift(); if (event) yield event; else break; } }
  async close(): Promise<void> { this.closed = true; }
}

for (const scenario of [false, true, "test-observation", "retained-repair", "revoked-repair", "inherited-report", "tool-repair", "unknown-repair"] as const) test(`QA failure delivery preserves its binding across graph exchange: ${scenario}`, async () => {
  const graphEnabled = scenario === true;
  const unsafeRepair = scenario === "tool-repair" || scenario === "unknown-repair";
  const repair = scenario === "retained-repair" || scenario === "revoked-repair" || unsafeRepair;
  const root = mkdtempSync(join(tmpdir(), "rafi-qa-delivery-"));
  try {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "input.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "input.ts"), "export const value = 2;\n");

    if(graphEnabled || typeof scenario === "string")adoptGraph(root,{config:{...structuredClone(DEFAULT_GRAPH_CONFIG),mode:"code-only"},authorization:"explicit"});
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
      db.ensureRun("run"); admitFixtureWork(db,"run",ticket.id, ticket);
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

    const builder = new FakeBuilder(root,graphEnabled);
    builder.emitTestLifecycle = scenario === "test-observation";
    if (unsafeRepair) builder.correctionItemType = scenario === "tool-repair" ? "commandExecution" : "unknown-provider-action";
    if (repair) {
      const db = new WorkflowDb(root);
      const access = { policyDigest: loadGraphConfig(root).policyDigest, workspace: root, paths: ["input.ts"], exclusionsDigest: digest("exclusions", graphExclusions(root, ["input.ts"]).text), sourceVersions: {} };
      const key = digest("session-access", { provider: builder.agent, session: builder.sessionId() });
      try { db.registerGraphEvidence(key, [access]); db.graphStore().put("session-access", key, { grants: [access] }); } finally { db.close(); }
      const send = builder.sendTurn.bind(builder);
      builder.sendTurn = async (prompt, policy) => {
        let result = await send(prompt, policy);
        if (builder.instructions.length === 1) {
          result.text = result.rawResponse = result.cleanedResponse = "Malformed remediation report";
          result = { ...result, selectedDispatch: policy!.selectedDispatch!, structured: { state: "rejected", reason: "invalid-contract", detail: "Malformed native remediation", dispatchId: policy!.dispatchId! } };
        }
        return result;
      };
    }
    const service = new QaFailureDeliveryService(scenario === "revoked-repair" ? { afterResponseStored: () => disableGraph(root) } : {});
    const inherited = scenario === "inherited-report" ? [{ policyDigest: loadGraphConfig(root).policyDigest, workspace: root, paths: ["input.ts"], exclusionsDigest: digest("exclusions", graphExclusions(root, ["input.ts"]).text), sourceVersions: {} }] : [];
    const deliveryInput = {
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
    };
    const delivery = withGraphDerivedAccess(inherited, () => service.deliver(deliveryInput, { adapter: () => builder, sessionStrategy: "compact" }));

    if (scenario === "revoked-repair") {
      await assert.rejects(delivery, /Graph access changed|revoked graph evidence/);
      assert.equal(builder.instructions.length, 1);
      return;
    }
    const result = await delivery;
    if (repair) {
      assert.equal(result.ok, false);
      assert.match(result.detail ?? "", /Malformed (?:native )?remediation/);
      const observed = new WorkflowDb(root);
      try {
        const turns = observed.qaDeliveryTurns(result.operationId!);
        assert.equal(turns.length, 1); assert.equal(builder.instructions.length, 1, "No formatting repair dispatch");
        assert.equal(observed.qaRemediationAttempts("run", ticket.id).at(-1)?.status === "succeeded", false);
      } finally { observed.close(); }
      return;
    }
    assert.equal(result.ok, true, result.detail);
    assert.equal(builder.instructions.length,graphEnabled ? 2 : 1);
    assert.match(builder.instructions[0] ?? "", /Current validated QA remediation chunk/);
    assert.match(builder.instructions[0] ?? "", /Remediation chunk:/);
    assert.match(builder.instructions[0] ?? "", /finalIndependentReviewRequired/);
    assert.match(builder.instructions[0] ?? "", new RegExp(findingRefs[0]!.findingKey));

    if (scenario === false) {
      const sent = builder.instructions.length;
      assert.equal((await service.deliver(deliveryInput, { adapter: () => builder, sessionStrategy: "compact" })).ok, true);
      assert.equal(builder.instructions.length, sent, "Verified replay never redispatches");
      const replay = WorkflowDb.prototype.replayStructuredDispatch;
      WorkflowDb.prototype.replayStructuredDispatch = function () { throw new Error("Tampered retained native evidence"); };
      try {
        await assert.rejects(service.deliver(deliveryInput, { adapter: () => builder, sessionStrategy: "compact" }), /Tampered retained native evidence/);
        assert.equal(builder.instructions.length, sent, "Unverifiable replay never redispatches");
      } finally { WorkflowDb.prototype.replayStructuredDispatch = replay; }
    }

    const finalDb = new WorkflowDb(root);
    try {
      assert.equal(finalDb.qaReport(reportDigest)?.disposition, "recheck-required");
      assert.equal(finalDb.qaRemediationAttempts("run", ticket.id).at(-1)?.status, "succeeded");
      const handoff = finalDb.qaFailureHandoffs("run", ticket.id).at(-1);
      assert.equal(handoff?.state, "recheck-required");
      const turns=finalDb.qaDeliveryTurns(result.operationId!);
      assert.deepEqual(turns.map(t=>t.kind),graphEnabled?["remediation","graph-continuation"]:["remediation"]);
      assert.equal(finalDb.qaRemediationAttempts("run",ticket.id).length,1);
      if (scenario === "test-observation") assert.ok(turns.every(turn => turn.toolCount === 2), "The explicit test lifecycle is retained as host-observed tool activity");
      else assert.ok(turns.every(turn => turn.toolCount === 0), "Native text provider-items are response content, not tools");
      assert.equal(handoff?.reportDigest, reportDigest);
      assert.equal(handoff?.responseDigest, finalDb.qaRemediationAttempts("run", ticket.id).at(-1)?.responseDigest);
      assert.equal(handoff?.builderSession?.sessionId, "builder-session-1");
      if (repair || scenario === "inherited-report") {
        const summary = finalDb.qaRemediationAttempts("run", ticket.id).at(-1)?.summaryDigest;
        assert.ok(summary);
        assert.ok(finalDb.getEvidence(summary));
        disableGraph(root);
        assert.equal(finalDb.getEvidence(summary), undefined, "transformed repair summary remains derived");
      }
    } finally { finalDb.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
