import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDb } from "../src/workflowDb.js";

const choices = [{ id: "retry", label: "Retry Builder fix" }, { id: "pause", label: "Pause" }];

test("an answered QA nonconvergence decision is not superseded on resume", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-nonconvergence-resume-"));
  const db = new WorkflowDb(root);
  try {
    db.ensureRun("run");
    // QA nonconvergence keys bind scope through a hash, never the raw scope revision.
    const qa = db.ensureHumanDecision({ runId: "run", decisionKey: "run:qa-nonconvergence:abc123:1:QA nonconvergence decision:h", interruptionId: "ticket:T1", prompt: "T1: QA nonconvergence decision", choices });
    db.answerHumanDecision("run", qa.decisionId, "retry");
    // A builder question from an older scope revision is still stale.
    const old = db.ensureHumanDecision({ runId: "run", decisionKey: "run:builder:T1:old-rev:h", interruptionId: "ticket:T1", prompt: "T1: builder question", choices });
    db.answerHumanDecision("run", old.decisionId, "retry");

    db.refreshStaleTicketDecisions("run", "new-rev", ["T1"]);

    assert.equal(db.humanDecision(qa.decisionId)?.status, "answered");
    assert.equal(db.operation(`decision-supersession:${qa.decisionId}`), undefined);
    const pending = db.pendingHumanDecisions("run");
    assert.deepEqual(pending.map(d => d.prompt), ["T1: builder question"], "only the stale builder answer gets re-asked");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
