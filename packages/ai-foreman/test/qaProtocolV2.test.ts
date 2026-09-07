import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialQaReducerState, QA_REPORT_CORRECTION_POLICY, qaDigest, reduceQaState, type QaReviewBasisV2 } from "../src/qaProtocolV2.js";
import { WorkflowDb } from "../src/workflowDb.js";

test("QA V2 reducer rejects skipped edges and exposes the locked report-correction policy", () => {
  const initial = initialQaReducerState("run", "T1");
  assert.throws(() => reduceQaState(initial, { type: "review-passed", passCertificateId: "x" }), /invalid QA V2 transition/);
  const frozen = reduceQaState(initial, { type: "source-frozen", sourceStateDigest: "s" });
  const ready = reduceQaState(frozen, { type: "review-ready", reviewBasisDigest: "b", sessionGeneration: 0 });
  const intended = reduceQaState(ready, { type: "turn-intended", slot: "initial" });
  const failed = reduceQaState(intended, { type: "review-failed", reportDigest: "r" });
  const remediation = reduceQaState(failed, { type: "remediation-intended" });
  assert.equal(reduceQaState(remediation, { type: "remediation-received" }).state, "recheck-required");
  const passed = reduceQaState(intended, { type: "review-passed", passCertificateId: "certificate" });
  const invalidated = reduceQaState(passed, { type: "pass-invalidated", reason: "source drift before finalization" });
  assert.equal(invalidated.state, "operator-menu");
  assert.equal(invalidated.passCertificateId, undefined);
  assert.deepEqual(QA_REPORT_CORRECTION_POLICY.sameSessionCorrectionSlots, ["correction-1"]);
  assert.equal(QA_REPORT_CORRECTION_POLICY.automaticFreshReconstruction, false);
  assert.equal(QA_REPORT_CORRECTION_POLICY.operatorFreshReconstruction, false);
});

test("QA V2 durable head is CAS fenced and pass certificates are scoped and single-use", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-qa-v2-"));
  const db = new WorkflowDb(root);
  try {
    db.ensureRun("run");
    let head = db.qaTicketHead("run", "T1");
    head = db.transitionQa("run", "T1", head.revision, { type: "source-frozen", sourceStateDigest: "s" });
    assert.throws(() => db.transitionQa("run", "T1", 0, { type: "review-ready", reviewBasisDigest: "b", sessionGeneration: 0 }), /stale QA transition/);
    head = db.transitionQa("run", "T1", head.revision, { type: "review-ready", reviewBasisDigest: "b", sessionGeneration: 0 });
    head = db.transitionQa("run", "T1", head.revision, { type: "turn-intended", slot: "initial" });
    const certificate = db.issueQaPassCertificate({ runId: "run", ticketId: "T1", qaRevision: head.revision + 1, sourceStateDigest: "s", reviewBasisDigest: "b", turnReceiptDigest: "t" });
    head = db.transitionQa("run", "T1", head.revision, { type: "review-passed", passCertificateId: certificate.certificateId });
    db.consumeQaPassCertificate("run", "T1", certificate.certificateId, "test");
    assert.throws(() => db.consumeQaPassCertificate("run", "T1", certificate.certificateId, "again"), /already been consumed/);
    assert.throws(() => db.consumeQaPassCertificate("run", "T2", certificate.certificateId, "wrong-ticket"), /missing or scoped/);
    assert.equal(db.qaTransitions("run", "T1").at(-1)?.state.state, "passed");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("domain-separated canonical digests are stable and distinct", () => {
  assert.equal(qaDigest("basis", { b: 2, a: 1 }), qaDigest("basis", { a: 1, b: 2 }));
  assert.notEqual(qaDigest("basis", { a: 1 }), qaDigest("source", { a: 1 }));
  const fields = { version: 2 as const, ticketDigest: "t", instructionDigest: "i", roleInstructionsDigest: "r", skillsDigest: "s", runtimeDigest: "x", validationChecklistDigest: "v", confinementDigest: "c" };
  const basis: QaReviewBasisV2 = { ...fields, digest: qaDigest("review-basis-fields", fields) };
  assert.match(basis.digest, /^[a-f0-9]{64}$/);
});

test("failed rechecks retain a durable predecessor report chain", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-qa-chain-"));
  const db = new WorkflowDb(root);
  try {
    db.ensureRun("run");
    let head = db.qaTicketHead("run", "T1");
    head = db.transitionQa("run", "T1", head.revision, { type: "source-frozen", sourceStateDigest: "source-1" });
    head = db.transitionQa("run", "T1", head.revision, { type: "review-ready", reviewBasisDigest: "basis-1", sessionGeneration: 0 });
    head = db.transitionQa("run", "T1", head.revision, { type: "turn-intended", slot: "initial" });
    head = db.commitQaFailure({ reportDigest: "report-1", runId: "run", ticketId: "T1", reviewNumber: 1, sourceStateDigest: "source-1", reviewBasisDigest: "basis-1", report: { summary: "first" } }, ["run/T1/r1/F1"], head.revision);
    head = db.transitionQa("run", "T1", head.revision, { type: "remediation-intended" });
    head = db.transitionQa("run", "T1", head.revision, { type: "remediation-received" });
    head = db.transitionQa("run", "T1", head.revision, { type: "source-frozen", sourceStateDigest: "source-2" });
    head = db.transitionQa("run", "T1", head.revision, { type: "review-ready", reviewBasisDigest: "basis-2", sessionGeneration: 1 });
    head = db.transitionQa("run", "T1", head.revision, { type: "turn-intended", slot: "initial" });
    db.commitQaFailure({ reportDigest: "report-2", runId: "run", ticketId: "T1", reviewNumber: 2, sourceStateDigest: "source-2", reviewBasisDigest: "basis-2", report: { summary: "second" } }, ["run/T1/r2/F1"], head.revision);
    assert.deepEqual(db.qaReportChains("report-2").map(({ predecessorReportDigest, successorReportDigest, relation }) => ({ predecessorReportDigest, successorReportDigest, relation })), [
      { predecessorReportDigest: "report-1", successorReportDigest: "report-2", relation: "recheck-failed" },
    ]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("accepted failure, remediation, and pass boundaries commit their durable facts atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-qa-atomic-"));
  const db = new WorkflowDb(root);
  try {
    db.ensureRun("run");
    let head = db.qaTicketHead("run", "T1");
    head = db.transitionQa("run", "T1", head.revision, { type: "source-frozen", sourceStateDigest: "source-1" });
    head = db.transitionQa("run", "T1", head.revision, { type: "review-ready", reviewBasisDigest: "basis-1", sessionGeneration: 0 });
    db.beginQaReviewAttempt({ attemptId: "review-1", runId: "run", ticketId: "T1", reviewNumber: 1, cycle: 1, remediationGeneration: 0, sourceDigest: "source-1" });
    head = db.transitionQa("run", "T1", head.revision, { type: "turn-intended", slot: "initial" });
    assert.throws(() => db.commitQaFailureAttempt("review-1", {
      reportDigest: "rolled-back-report", runId: "run", ticketId: "T1", reviewNumber: 1,
      sourceStateDigest: "source-1", reviewBasisDigest: "basis-1", report: { summary: "must roll back" },
    }, ["F0"], ["run/T1/r1/F0"], "must roll back", head.revision - 1), /stale QA transition/);
    assert.equal(db.qaReviewAttempt("review-1")?.status, "started");
    assert.equal(db.qaReport("rolled-back-report"), undefined);

    head = db.commitQaFailureAttempt("review-1", {
      reportDigest: "report-1", runId: "run", ticketId: "T1", reviewNumber: 1,
      sourceStateDigest: "source-1", reviewBasisDigest: "basis-1", report: { summary: "first" },
    }, ["F1"], ["run/T1/r1/F1"], "first", head.revision);
    assert.equal(db.qaReviewAttempt("review-1")?.status, "failed");
    assert.equal(db.qaReport("report-1")?.disposition, "open");

    const intendedAt = new Date(0).toISOString();
    head = db.commitQaRemediationIntent(head.revision, {
      attemptId: "recovery-1", runId: "run", ticket: "T1", phase: "qa-remediation", cause: "qa.nonconvergence",
      operationKey: "qa-fix:T1", attempt: 1, disposition: "configured_decision", action: "retry_builder", outcome: "intended", intendedAt,
    }, { attemptId: "remediation-1", runId: "run", ticketId: "T1", reviewAttemptId: "review-1", generation: 1, mode: "validated-report", requestDigest: "request-1" });
    assert.equal(head.state, "remediation-intended");
    assert.equal(db.qaRemediationAttempt("remediation-1")?.status, "started");
    head = db.commitQaRemediationOutcome({
      recoveryAttemptId: "recovery-1", remediationAttemptId: "remediation-1", outcome: "succeeded",
      responseDigest: "response-1", summaryDigest: "summary-1", expectedRevision: head.revision,
      receipt: { version: 2, operationId: "remediation-1", runId: "run", ticketId: "T1", reportDigest: "report-1",
        sourceStateDigest: "source-1", requestDigest: "request-1", responseDigest: "response-1", summaryDigest: "summary-1",
        providerTurnId: "builder-turn-1", completedAt: new Date(1).toISOString() },
    });
    assert.equal(head.state, "recheck-required");
    assert.equal(db.qaRemediationAttempt("remediation-1")?.status, "succeeded");
    assert.equal(db.qaReport("report-1")?.disposition, "recheck-required");

    head = db.transitionQa("run", "T1", head.revision, { type: "source-frozen", sourceStateDigest: "source-2" });
    head = db.transitionQa("run", "T1", head.revision, { type: "review-ready", reviewBasisDigest: "basis-2", sessionGeneration: 1 });
    db.beginQaReviewAttempt({ attemptId: "review-2", runId: "run", ticketId: "T1", reviewNumber: 2, cycle: 2, remediationGeneration: 1, sourceDigest: "source-2" });
    head = db.transitionQa("run", "T1", head.revision, { type: "turn-intended", slot: "initial" });
    const certificate = db.commitQaPassAttempt("review-2", { runId: "run", ticketId: "T1", qaRevision: head.revision + 1,
      sourceStateDigest: "source-2", reviewBasisDigest: "basis-2", turnReceiptDigest: "turn-2" }, "fixed", head.revision);
    assert.equal(db.qaTicketHead("run", "T1").state, "passed");
    assert.equal(db.qaReviewAttempt("review-2")?.status, "passed");
    assert.equal(db.qaReport("report-1")?.disposition, "verified-fixed");
    assert.equal(certificate.unresolvedReportCount, 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("QA finalization atomically consumes its certificate, records intent, and completes", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-qa-finalize-"));
  const db = new WorkflowDb(root);
  try {
    db.ensureRun("run");
    let head = db.qaTicketHead("run", "T1");
    head = db.transitionQa("run", "T1", head.revision, { type: "source-frozen", sourceStateDigest: "source" });
    head = db.transitionQa("run", "T1", head.revision, { type: "review-ready", reviewBasisDigest: "basis", sessionGeneration: 0 });
    head = db.transitionQa("run", "T1", head.revision, { type: "turn-intended", slot: "initial" });
    const certificate = db.issueQaPassCertificate({ runId: "run", ticketId: "T1", qaRevision: head.revision + 1, sourceStateDigest: "source", reviewBasisDigest: "basis", turnReceiptDigest: "turn" });
    head = db.transitionQa("run", "T1", head.revision, { type: "review-passed", passCertificateId: certificate.certificateId });
    head = db.beginQaFinalization({ runId: "run", ticketId: "T1", certificateId: certificate.certificateId, consumer: "test", expectedSourceStateDigest: "source", expectedGitTree: "tree", allowedProjectionPaths: [], expectedRevision: head.revision, operationId: "finalize-1" });
    assert.equal(head.state, "finalizing");
    assert.throws(() => db.consumeQaPassCertificate("run", "T1", certificate.certificateId, "again"), /already been consumed/);
    db.planOperation({ runId: "run", idempotencyKey: "published", kind: "direct-merge", intent: { ticket: "T1", branch: "ticket/T1" } });
    db.updateOperation("published", "in_progress");
    db.updateOperation("published", "confirmed", { result: { commit: "published-sha" } });
    assert.throws(() => db.invalidateQaFinalization("run", "T1", head.revision, "new source edits", "ticket/T1"), /existing publication published/);
    assert.equal(db.qaTicketHead("run", "T1").state, "finalizing");
    assert.equal(db.qaFinalizationSteps("run", "T1")[0]?.status, "intended");
    assert.deepEqual(db.operation("published")?.result, { commit: "published-sha" });
    head = db.completeQaFinalization("run", "T1", head.revision, { tracker: "done" });
    assert.equal(head.state, "completed");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
