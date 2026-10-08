import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaNonconvergenceHandler, createQaReportRecoveryHandler } from "../src/cli/start.js";
import { HumanDecisionRequired } from "../src/humanDecision.js";
import { WorkflowDb } from "../src/workflowDb.js";
import type { QaNonconvergenceContext, QaReportRecoveryHandler } from "../src/qaReview.js";

test("redirected QA waiver requires two persisted explicit decisions", async t => {
  const dir = mkdtempSync(join(tmpdir(), "qa-decisions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const handler = createQaNonconvergenceHandler(dir, true, undefined, undefined, () => "run");
  const context: QaNonconvergenceContext = { ticket: { id: "T001", title: "Repair", order: 1, area: "core", priority: "P1", size: "M", risk: "Low", summary: "Repair the issue", likely_files: [], depends_on: [], acceptance: [], required_tests: [] }, history: [{ cycle: 1, outcome: "qa_fail", detail: "unresolved" }], builderWorktree: dir };
  await assert.rejects(handler(context), HumanDecisionRequired);
  const db = new WorkflowDb(dir);
  try {
    db.answerHumanDecision("run", db.pendingHumanDecisions("run")[0]!.decisionId, "waive");
    await assert.rejects(handler(context), HumanDecisionRequired);
    const confirmation = db.pendingHumanDecisions("run")[0]!;
    assert.match(confirmation.prompt, /validation_result=failed/);
    db.answerHumanDecision("run", confirmation.decisionId, "yes");
    assert.deepEqual(await handler(context), { action: "waive" });
    await assert.rejects(handler({ ...context, history: [...context.history, { cycle: 2, outcome: "qa_fail", detail: "new finding" }] }), HumanDecisionRequired);
    assert.equal(db.pendingHumanDecisions("run").length, 1, "old waiver cannot approve changed findings");
  } finally { db.close(); }
});

test("QA report recovery persists custom instructions scoped to packet digest", async t => {
  const dir = mkdtempSync(join(tmpdir(), "qa-report-decisions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const handler = createQaReportRecoveryHandler(dir, true);
  const context = { packet: { directory: dir, manifest: { runId: "run", ticketId: "T001", packetDigest: "digest-one" } }, contextUsage: {} } as Parameters<QaReportRecoveryHandler>[0];
  await assert.rejects(handler(context), HumanDecisionRequired);
  const db = new WorkflowDb(dir);
  try {
    db.answerHumanDecision("run", db.pendingHumanDecisions("run")[0]!.decisionId, "guidance");
    await assert.rejects(handler(context), HumanDecisionRequired);
    db.answerHumanDecision("run", db.pendingHumanDecisions("run")[0]!.decisionId, "custom", undefined, "Check the actual failing command");
    assert.deepEqual(await handler(context), { action: "guidance", instructions: "Check the actual failing command", route: "fresh" });
    await assert.rejects(handler({ ...context, packet: { ...context.packet, manifest: { ...context.packet.manifest, packetDigest: "digest-two" } } }), HumanDecisionRequired);
  } finally { db.close(); }
});
