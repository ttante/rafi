import { runAuthorizedQa as runIsolatedQa } from "./helpers/workAdmission.js";
import { admitFixtureWork } from "./helpers/workAdmission.js";
// Desired invariants converted from all 26 October 2026 defect characterizations.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILDER_QA_REMEDIATION_START as START, BUILDER_QA_REMEDIATION_END as END, type QaFailureReportV1, type ProviderSessionRefV1 } from "rafi-spec";
import type { BuilderAdapter, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import { baselineContinuityDelta, ContinuityAdapter } from "../src/continuity.js";
import { QaFailureDeliveryService } from "../src/qaFailureDelivery.js";
import { canonicalJson, createQaFindingRefs, qaDigest } from "../src/qaProtocolV2.js";
import { qaReportDigest } from "../src/qaRecovery.js";
import { type QaSessionHandle } from "../src/qaReview.js";
import { captureFrozenQaSourceAsync } from "../src/qaSnapshot.js";
import { WorkflowDb } from "../src/workflowDb.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";

const ticket: TicketDef = { id: "T001", order: 1, title: "Reproducible install", area: "core", priority: "P2", size: "M", risk: "Medium", depends_on: [], summary: "Commit a lockfile", acceptance: ["Frozen installation works"], required_tests: ["pnpm install --frozen-lockfile"], likely_files: ["pnpm-lock.yaml"] };
const report: QaFailureReportV1 = { version: 1, summary: "Lockfile missing", checks_run: [{ check: "audit", outcome: "failed", evidence: "ERR_PNPM_AUDIT_NO_LOCKFILE" }], findings: [{ id: "QA-1", requirement: "Reproducible install", locations: ["pnpm-lock.yaml"], problem: "Lockfile missing", evidence: "Audit fails", expected: "Lockfile exists", fix_direction: "Generate a real lockfile", verification: ["pnpm install --frozen-lockfile"] }], observations: [] };
const correctionScenarios = new Set([
  "prologue", "trailing-brace", "errored-correction", "correction-session-switch", "missing-initial-turn",
  "needs-input", "correction-dispatch-error", "correction-capture-error", "correction-tool-with-sink",
  "correction-tool-without-sink", "correction-source-change", "blocked-correction",
]);
for (const scenario of [
  "valid", "disputed", "prologue", "trailing-brace", "errored-correction", "blocked",
  "correction-session-switch", "foreign-turn-metadata", "wrong-worktree", "missing-initial-turn", "needs-input",
  "correction-dispatch-error", "correction-capture-error", "correction-tool-with-sink", "correction-tool-without-sink",
  "correction-source-change", "initial-session-switch", "completion-write-error", "restart-budget", "pre-dispatch-drift",
  "wrapped-valid", "wrapped-repair-error", "failure-metadata", "blocked-correction", "replay-completed", "restart-identical-report",
] as const) {
  test(`handback regression protects ${scenario}`, async t => {
    const root = mkdtempSync(join(tmpdir(), "rafi-handback-audit-"));
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      writeFileSync(join(root, "source.txt"), "unchanged\n");
      execFileSync("git", ["add", "source.txt"], { cwd: root });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
      const source = await captureFrozenQaSourceAsync(root);
      const digest = qaReportDigest(report);
      const refs = createQaFindingRefs({ runId: "run", ticketId: ticket.id, reviewAttemptId: "review", reportDigest: digest, rawFindingIds: ["QA-1"] });
      const db = new WorkflowDb(root);
      try {
        db.ensureRun("run"); admitFixtureWork(db,"run",ticket.id, ticket);
        let head = db.qaTicketHead("run", ticket.id);
        head = db.transitionQa("run", ticket.id, head.revision, { type: "source-frozen", sourceStateDigest: source.digest });
        head = db.transitionQa("run", ticket.id, head.revision, { type: "review-ready", reviewBasisDigest: "basis", sessionGeneration: 0 });
        db.beginQaReviewAttempt({ attemptId: "review", runId: "run", ticketId: ticket.id, reviewNumber: 1, cycle: 1, remediationGeneration: 0, sourceDigest: source.digest });
        head = db.transitionQa("run", ticket.id, head.revision, { type: "turn-intended", slot: "initial" });
        db.putEvidence("qa", Buffer.from(canonicalJson(report)));
        db.commitQaFailureAttempt("review", { reportDigest: digest, runId: "run", ticketId: ticket.id, reviewNumber: 1, sourceStateDigest: source.digest, reviewBasisDigest: "basis", report }, ["QA-1"], refs.map(r => r.findingKey), report.summary, head.revision);
      } finally { db.close(); }
      let ref: ProviderSessionRefV1 = { version: 1, provider: "codex", sessionId: "fixture", role: "builder", stream: "builder", generation: 0, cwd: scenario === "wrong-worktree" ? join(root, "other-worktree") : root, configRoot: root, ticketId: ticket.id, source: "observed", createdAt: new Date(0).toISOString(), validatedAt: new Date(0).toISOString() };
      const prompts: string[] = [];
      const events: BuilderEvent[] = [];
      const observers = new Set<(event: BuilderEvent) => void>();
      const emit = (event: BuilderEvent) => { events.push(event); for (const observer of observers) observer(event); };
      let envelope = "";
      const builder: BuilderAdapter = {
        observeEvents: listener => { observers.add(listener); return () => { observers.delete(listener); }; },
        agent: "codex", sessionId: () => ref.sessionId, sessionRef: () => ref, async *events() { yield* events; }, close: async () => {},
        sendTurn: async (prompt): Promise<TurnResult> => {
          prompts.push(prompt);
          if (prompt.startsWith("Continuity protocol repair only.")) {
            const text = `RAFI_CONTINUITY_DELTA: ${JSON.stringify(baselineContinuityDelta())}`;
            return { text, isError: true, numTurns: 1, costUsd: 0, turnId: "errored-continuity-repair" };
          }
          if (!envelope) {
            const handoff = /QA failure handoff ID: ([a-f0-9]{64})/.exec(prompt)?.[1];
            assert.ok(handoff);
            envelope = [START, JSON.stringify({ version: 2, handoff_id: handoff, summary: scenario === "disputed" ? "Valid finding, registry unavailable, no fix possible" : "Remediation reported", findings: [{ finding_key: refs[0]!.findingKey, raw_id: "QA-1", disposition: scenario === "disputed" ? "disputed" : "fixed", changes: ["No source change in this diagnostic fixture"], evidence: "Registry unavailable", verification: [{ check: "install", outcome: "not_run", evidence: "Registry unavailable" }] }], observations: [] }), END, 'STEP_STATUS: done | summary="reported"'].join("\n");
          }
          const correction = prompts.length > 1;
          if (correction && scenario === "correction-dispatch-error") throw new Error("fixture correction connection lost");
          if (correction && scenario === "correction-capture-error") renameSync(join(root, ".git"), join(root, ".rafi", "fixture-git"));
          if (correction && scenario.startsWith("correction-tool-")) emit({ kind: "tool", name: "fixture read-only check", input: {} });
          if (correction && scenario === "correction-source-change") writeFileSync(join(root, "source.txt"), "changed during correction\n");
          if ((correction && scenario === "correction-session-switch") || scenario === "initial-session-switch") ref = { ...ref, sessionId: "replacement", generation: 1 };
          let text = scenario === "blocked" || (correction && scenario === "blocked-correction") ? 'STEP_STATUS: blocked | reason="Registry DNS unavailable"'
            : !correction && scenario === "needs-input" ? 'STEP_STATUS: needs_input | question="Which registry may I use?"'
            : !correction && correctionScenarios.has(scenario) ? `I investigated the finding.\n${envelope}`
            : correction && scenario === "trailing-brace" ? `${envelope}}` : envelope;
          if (scenario === "wrapped-valid") text = text.replace("STEP_STATUS:", `RAFI_CONTINUITY_DELTA: ${JSON.stringify(baselineContinuityDelta())}\nSTEP_STATUS:`);
          const reportedRef = scenario === "foreign-turn-metadata" ? { ...ref, sessionId: "foreign-session" } : ref;
          const result: TurnResult = { text, rawResponse: text, cleanedResponse: text, hostInstruction: prompt, providerInstruction: prompt, isError: correction && (scenario === "errored-correction" || scenario === "wrapped-repair-error"), numTurns: 1, costUsd: 0, turnId: !correction && scenario === "missing-initial-turn" ? undefined : `turn-${prompts.length}`, providerMetadata: { provider: "codex", sessionId: reportedRef.sessionId, sessionRef: reportedRef }, ...(scenario === "failure-metadata" ? { failure: { runtime: "codex" as const, phase: "turn" as const, category: "network" as const, executable: "fixture", cwd: root, diagnostics: "fixture failure despite isError=false", dispatchState: "unknown" as const } } : {}) };
          emit({ kind: "turn-complete", result, turnId: result.turnId });
          return result;
        },
      };
      const activeBuilder = scenario.startsWith("wrapped-") ? new ContinuityAdapter({
        adapter: builder, projectDir: root, runId: "run", role: "builder",
        settings: { role: "builder", source: "project", make: "codex", model: "default", reasoning: "default", fast: false, session_strategy: "compact", settings_revision: 1, display_session_cost: false, auto_compact_threshold_percent: 50, compact_maximum: 1 },
      }) : builder;
      const started = performance.now();
      const transition = WorkflowDb.prototype.transitionQaFailureHandoff;
      if (scenario === "completion-write-error") WorkflowDb.prototype.transitionQaFailureHandoff = function (...args) {
        if (args[1] === "remediation-reported") throw new Error("fixture outcome persistence interrupted");
        return transition.apply(this, args);
      };
      let thrown: unknown;
      let result: Awaited<ReturnType<QaFailureDeliveryService["deliver"]>> | undefined;
      try {
        result = await new QaFailureDeliveryService().deliver({ projectDir: root, runId: "run", ticket, builderWorktree: root, report, reportDigest: digest, reviewAttemptId: "review", reviewNumber: 1, reviewedSourceStateDigest: source.digest, reviewBasisDigest: "basis", remediationGeneration: 0, latestBuilderResult: "implemented", history: [] }, {
          adapter: () => activeBuilder, sessionStrategy: "compact", prepareBoundary: async adapter => adapter,
          ...(scenario === "correction-tool-with-sink" ? { events } : {}),
          ...(scenario === "pre-dispatch-drift" ? { beforeTurn: async () => { writeFileSync(join(root, "source.txt"), "changed before dispatch\n"); return builder; } } : {}),
        });
      } catch (error) { thrown = error; }
      finally { WorkflowDb.prototype.transitionQaFailureHandoff = transition; await activeBuilder.close(); }
      const elapsedMs = performance.now() - started;
      const noDispatch = scenario === "pre-dispatch-drift" || scenario === "wrong-worktree";
      const oneTurn = ["missing-initial-turn", "needs-input"].includes(scenario);
      assert.equal(prompts.length, noDispatch ? 0 : !oneTurn && (correctionScenarios.has(scenario) || scenario === "wrapped-repair-error") ? 2 : 1);
      assert.equal(observers.size, 0, "turn subscriptions must be released");
      const finalDb = new WorkflowDb(root);
      try {
        const handoff = finalDb.qaFailureHandoffs("run", ticket.id)[0]!;
        if (scenario === "completion-write-error") {
          assert.ok(thrown instanceof Error);
          assert.equal(handoff.state, "delivery-intended");
          assert.equal(handoff.receiptDigest, undefined);
          assert.equal(finalDb.qaTicketHead("run", ticket.id).state, "remediation-intended", "completion transaction must roll back all authoritative state");
          assert.equal(finalDb.qaRemediationAttempts("run", ticket.id)[0]!.status, "started");
          assert.ok(finalDb.qaDeliveryTurns(handoff.operationId)[0]!.rawResponseDigest, "independently captured response survives failed completion transaction");
          return;
        }
        assert.equal(thrown, undefined);
        assert.ok(result);
        const accepted = ["valid", "wrapped-valid", "disputed", "prologue", "restart-budget", "restart-identical-report", "replay-completed"].includes(scenario);
        assert.equal(result.ok, accepted, result.detail);
        if (noDispatch) {
          assert.equal(finalDb.qaRemediationAttempts("run", ticket.id).length, 0);
          if (scenario === "pre-dispatch-drift") assert.equal(handoff.state, "source-drift");
          return;
        }
        const receipt = JSON.parse(finalDb.getEvidence(handoff.receiptDigest!)!.toString());
        const turns = finalDb.qaDeliveryTurns(handoff.operationId);
        assert.equal(turns.length, prompts.length, "every dispatch, including failed corrections, is journaled");
        assert.equal(receipt.turnRecordId, turns.at(-1)!.turnRecordId);
        assert.equal(result.providerTurnId, receipt.providerTurnId);
        for (const turn of turns) {
          assert.equal(Buffer.byteLength(finalDb.getEvidence(turn.hostInstructionDigest)!), turn.hostInstructionBytes);
          if (turn.rawResponseDigest) assert.equal(Buffer.byteLength(finalDb.getEvidence(turn.rawResponseDigest)!), turn.rawResponseBytes);
        }
        assert.equal(receipt.qaApproved, false);
        if (scenario === "initial-session-switch") assert.ok(receipt.rawResponseDigest, "rejected response must be retained");
        if (["correction-session-switch", "foreign-turn-metadata", "initial-session-switch", "missing-initial-turn", "errored-correction", "failure-metadata", "wrapped-repair-error", "correction-dispatch-error", "correction-capture-error"].includes(scenario)) assert.equal(result.outcome, "delivery-uncertain");
        if (scenario === "correction-capture-error") { assert.ok(receipt.rawResponseDigest); assert.match(receipt.sourceCaptureError, /git/i); }
        if (scenario.startsWith("correction-tool-")) { assert.equal(result.ok, false); assert.match(result.detail!, /used tools/); }
        if (scenario === "correction-source-change") assert.equal(handoff.state, "recheck-required");
        if (scenario === "blocked" || scenario === "blocked-correction") { assert.equal(result.outcome, "blocked"); assert.match(result.detail!, /Registry DNS unavailable/); }
        if (scenario === "needs-input") { assert.equal(result.outcome, "needs-input"); assert.match(result.detail!, /Which registry/); assert.equal(finalDb.pendingHumanDecisions("run").length, 1); }
        if (scenario === "prologue") { assert.match(prompts[1]!, /first non-empty/); assert.ok(turns[0]!.parserErrors?.length); }
        if (scenario === "trailing-brace") { assert.match(result.detail!, /malformed STEP_STATUS field near: }/); assert.equal(result.providerTurnId, "turn-2"); }
        if (accepted) { assert.equal(finalDb.qaTicketHead("run", ticket.id).state, "recheck-required"); assert.equal(result.outcome, "remediation-reported"); }
        t.diagnostic(JSON.stringify({ scenario, elapsedMs: Math.round(elapsedMs), turns: prompts.length, promptBytes: prompts.map(p => Buffer.byteLength(p)), ok: result.ok, outcome: result.outcome }));
      } finally { finalDb.close(); }
      if (scenario === "replay-completed") {
        const replay = await new QaFailureDeliveryService().deliver({ projectDir: root, runId: "run", ticket, builderWorktree: root, report, reportDigest: digest, reviewAttemptId: "review", reviewNumber: 1, reviewedSourceStateDigest: source.digest, reviewBasisDigest: "basis", remediationGeneration: 0, latestBuilderResult: "implemented", history: [] }, { adapter: () => builder, sessionStrategy: "compact" });
        assert.equal(replay.ok, true);
        assert.equal(prompts.length, 1, "a completed operation cannot dispatch Builder twice");
      }
      if (scenario === "restart-budget" || scenario === "restart-identical-report") {
        let extraDeliveries = 0;
        const resume = () => runIsolatedQa({
          ticket, builderWorktree: root, builderSummary: "previous remediation", qaStrategy: "fresh",
          recovery: { projectDir: root, runId: "run" }, state: { reviews: 0, modificationViolations: 0 }, maxCycles: 1,
          createQa: async cwd => failingQaHandle(cwd, scenario === "restart-identical-report" ? report : { ...report, summary: "Lockfile still missing on recheck" }),
          sessionBoundary: async () => { throw new Error("unexpected session boundary"); },
          deliverFailure: async () => { extraDeliveries++; return { ok: false, detail: "fixture stops unauthorized extra budget use" }; },
        });
        const resumed = await resume();
        assert.equal(extraDeliveries, 0, "durable production operations must count across restart");
        assert.equal(resumed.outcome, "nonconverged");
        if (scenario === "restart-identical-report") {
          const checkDb = new WorkflowDb(root);
          try { assert.equal(checkDb.unresolvedQaReports("run", ticket.id).length, 2); assert.throws(() => checkDb.qaReport(digest), /ambiguous/); }
          finally { checkDb.close(); }
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

function failingQaHandle(cwd: string, reviewReport: QaFailureReportV1): QaSessionHandle {
  const ref: ProviderSessionRefV1 = { version: 1, provider: "codex", sessionId: "resumed-qa", role: "qa", stream: "qa", generation: 0, cwd, configRoot: cwd, source: "observed", createdAt: new Date(0).toISOString(), validatedAt: new Date(0).toISOString() };
  const queue: BuilderEvent[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const adapter: BuilderAdapter = {
    agent: "codex", sessionId: () => ref.sessionId, sessionRef: () => ref,
    async *events() {
      while (!closed || queue.length) {
        if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
        const event = queue.shift();
        if (event) yield event;
      }
    },
    close: async () => { closed = true; wake?.(); },
    sendTurn: async prompt => {
      const text = `RAFI_QA_FAILURE_REPORT_START\n${JSON.stringify(reviewReport)}\nRAFI_QA_FAILURE_REPORT_END\nSTEP_STATUS: qa_fail | issues="Lockfile missing"`;
      const result: TurnResult = { text, rawResponse: text, cleanedResponse: text, hostInstruction: prompt, providerInstruction: prompt, isError: false, numTurns: 1, costUsd: 0, turnId: "resumed-qa-turn", providerMetadata: { provider: "codex", sessionId: ref.sessionId, sessionRef: ref } };
      queue.push({ kind: "turn-complete", result, turnId: result.turnId });
      wake?.();
      return result;
    },
  };
  const confinement = { version: 2 as const, sourceMode: "read-only" as const, scratchMode: "isolated" as const, settingsSources: "none" as const, networkMode: "disabled" as const, environmentDigest: "1".repeat(64), policyDigest: "2".repeat(64) };
  return { adapter, sessionIdentity: () => ref, effectiveRoleInstructions: "fixture QA", runtimeContext: { test: true }, skills: [], confinement: { ...confinement, digest: qaDigest("qa-confinement", confinement) }, handoffReceipt: { kind: "initial" } };
}
