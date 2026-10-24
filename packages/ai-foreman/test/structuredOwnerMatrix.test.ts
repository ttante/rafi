import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { qaVerdictOutput, remediationOutput, workReportOutput, type OutputContract, type ProviderSessionRefV1, type QaFailureReportV1 } from "rafi-spec";
import type { BuilderAdapter } from "../src/adapters/types.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { WorkflowReader } from "../src/workflowReader.js";
import { journalStructuredDispatch, nativePolicy } from "../src/structuredOperation.js";
import { STRUCTURED_AUDIT_CLOSURE, STRUCTURED_CUTOVER, STRUCTURED_CUTOVER_REASON } from "../src/structuredCutover.js";
import { canonicalFixtureTurn } from "./helpers/nativeOutput.js";
import { assertActiveProviderDispatch } from "../src/structuredDispatchAuthority.js";
import { admitFixtureWork } from "./helpers/workAdmission.js";

const report: QaFailureReportV1 = { version: 1, summary: "Missing behavior", checks_run: [], findings: [{ id: "QA-1", requirement: "Required behavior", locations: ["src/input.ts:1"], problem: "Missing", evidence: "Observed missing behavior", expected: "Behavior exists", fix_direction: "Implement", verification: ["Run regression"] }], observations: [] };
for (const owner of ["generic", "qa-review", "qa-remediation"] as const) {
  for (const boundary of ["bootstrap", "provider", "receipt", "foreign-receipt", "session-change"] as const) {
    test(`${owner} ${boundary}: sealed owner integrity and cutover of partial authority`, async () => {
      const root = mkdtempSync(join(tmpdir(), "structured-owner-matrix-"));
      let db = new WorkflowDb(root);
      const ref: ProviderSessionRefV1 = { version: 1, provider: "codex", sessionId: "prepared", role: owner === "qa-review" ? "qa" : "builder", stream: owner === "qa-review" ? "qa" : "builder", generation: 0, cwd: root, configRoot: root, source: "observed", createdAt: new Date(0).toISOString() };
      const output: OutputContract = owner === "qa-review" ? qaVerdictOutput : owner === "qa-remediation" ? remediationOutput : workReportOutput;
      let current = ref, sends = 0;
      try {
        db.ensureRun("run");
        db.ensureHumanDecision({ runId: "run", decisionKey: "answer", interruptionId: "user", prompt: "Keep answer", choices: [{ id: "keep", label: "Keep" }] });
        if (owner !== "generic") admitFixtureWork(db, "run", "T1");
        if (owner === "qa-review") db.beginQaTurn({ version: 2, operationId: "dispatch", runId: "run", ticketId: "T1", reviewNumber: 1, sessionGeneration: 0, slot: "initial", sourceStateDigest: "source", reviewBasisDigest: "basis", providerSession: { ...ref, version: 2, role: "qa", stream: "qa", validatedAt: ref.createdAt }, instructionDigest: "initial", intendedAt: ref.createdAt });
        if (owner === "qa-remediation") {
          db.beginQaReviewAttempt({ attemptId: "review", runId: "run", ticketId: "T1", reviewNumber: 1, cycle: 1, remediationGeneration: 0, sourceDigest: "source" });
          db.finishQaReviewAttempt("review", { status: "failed", reportDigest: "report", findingIds: ["QA-1"], namespacedFindingIds: ["key"], detail: "Observed failure" });
          const retained = db.recordQaReport({ runId: "run", ticketId: "T1", reviewNumber: 1, reportDigest: "report", sourceStateDigest: "source", reviewBasisDigest: "basis", report }, ["key"]);
          db.beginQaRemediationAttempt({ attemptId: "remediation", runId: "run", ticketId: "T1", reviewAttemptId: "review", generation: 1, mode: "validated-report", requestDigest: "request" });
          db.recordQaFailureHandoffPrepared({ handoffId: "handoff", operationId: "remediation", runId: "run", ticketId: "T1", reviewAttemptId: "review", reportDigest: "report", generation: 1, reviewedContentDigest: "source", reviewBasisDigest: "basis", handoffDigest: "handoff-digest", hostInstructionDigest: "initial" });
          db.recordQaDeliveryTurn({ version: 4, turnRecordId: "dispatch", operationId: "remediation", reportOccurrenceId: retained.reportOccurrenceId, turnIndex: 0, kind: "remediation", status: "intended", intendedSession: ref, hostInstructionDigest: "initial", hostInstructionBytes: 4, providerInstructionAvailability: "unavailable", sourceCapture: "pending", startedAt: ref.createdAt });
        }
        const adapter: BuilderAdapter = { agent: "codex", sessionId: () => current.sessionId, sessionRef: () => current,
          async prepareSession() {
            assert.equal((db.operation("dispatch")!.intent as { state: string }).state, "preparing");
            if (boundary === "bootstrap") throw new Error("bootstrap fault");
            return ref;
          },
          async sendTurn(_instruction, policy) {
            assertActiveProviderDispatch(policy!, _instruction, "codex", ref);
            sends++;
            assert.equal(db.structuredOwnerDispatch("dispatch").tupleDigest, policy!.selectedDispatch!.digest);
            if (boundary === "provider") throw new Error("provider fault");
            const result = canonicalFixtureTurn(policy, ref.sessionId, undefined, "codex", { kind: "blocked", reason: "Dependency unavailable", nextAction: "Restore dependency" });
            assert.equal(result.structured?.state, "candidate");
            if (boundary === "session-change") current = { ...ref, sessionId: "foreign", generation: 1 };
            if (boundary === "foreign-receipt" && result.structured?.state === "candidate") return { ...result, selectedDispatch: policy!.selectedDispatch!, structured: { ...result.structured, selectedDispatchDigest: "foreign" } };
            return result;
          }, async *events() {}, async close() {} };
        const dispatch = () => journalStructuredDispatch(root, adapter, "work", nativePolicy(output, { dispatchId: "dispatch", logicalActionId: owner === "qa-remediation" ? "remediation" : "action", journalRunId: "run" }), (text, policy) => adapter.sendTurn(text, policy));
        if (boundary === "bootstrap" || boundary === "provider") await assert.rejects(dispatch(), /fault/);
        else {
          const result = await dispatch();
          assert.equal(result.isError, boundary !== "receipt");
        }
        const valid = boundary === "receipt";
        assert.equal(sends, boundary === "bootstrap" ? 0 : 1);
        assert.equal(db.operation("dispatch")!.status, valid ? "confirmed" : boundary === "bootstrap" ? "failed" : "uncertain");
        if (valid) assert.doesNotThrow(() => db.replayStructuredDispatch("dispatch", output));
        else assert.throws(() => db.replayStructuredDispatch("dispatch", output), /confirmed/);
        const raw = (db as unknown as { db: Database.Database }).db;
        raw.prepare("DELETE FROM structured_communication_cutover WHERE migration IN (?,?)").run(STRUCTURED_CUTOVER, STRUCTURED_AUDIT_CLOSURE);
        db.close();
        assert.throws(() => new WorkflowReader(root), /v2-cutover-pending/);
        db = new WorkflowDb(root);
        const preserved = owner === "generic" && valid;
        assert.equal(db.getRun("run")!.checkpoint === STRUCTURED_CUTOVER_REASON, !preserved);
        assert.equal(db.pendingHumanDecisions("run").length, 1);
        if (!preserved) {
          assert.equal(db.operations("run").length, 0);
          assert.equal(((db as unknown as { db: Database.Database }).db.prepare("SELECT count(*) n FROM qa_turns WHERE run_id=?").get("run") as { n: number }).n, 0);
          assert.equal(db.qaRemediationAttempts("run", "T1").length, 0);
          assert.throws(() => db.transition("run", { checkpoint: "resume" }), /cannot resume/);
        }
      } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
}
