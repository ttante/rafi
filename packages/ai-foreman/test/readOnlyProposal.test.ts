import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { durableReadOnlyProposal } from "../src/readOnlyProposal.js";
import { HumanDecisionRequired } from "../src/humanDecision.js";
import { WorkflowDb } from "../src/workflowDb.js";

test("Planner proposal survives reopen without another model call and changes with its inputs", async t => {
  const projectDir = mkdtempSync(join(tmpdir(), "planner-proposal-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  let calls = 0;
  const input = { projectDir, runId: "run", ticketId: "T001", digest: "original", operation: async () => ({ proposal: `proposal-${++calls}` }) };
  assert.deepEqual(await durableReadOnlyProposal(input), { proposal: "proposal-1" });
  assert.deepEqual(await durableReadOnlyProposal(input), { proposal: "proposal-1" });
  assert.equal(calls, 1);
  assert.deepEqual(await durableReadOnlyProposal({ ...input, digest: "changed" }), { proposal: "proposal-2" });
});

test("an interrupted Planner proposal requires a durable answer and each retry is bounded", async t => {
  const projectDir = mkdtempSync(join(tmpdir(), "planner-retry-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  let calls = 0;
  const input = { projectDir, runId: "run", ticketId: "T001", digest: "original", operation: async () => { calls++; throw new Error("lost response"); } };
  const db = new WorkflowDb(projectDir);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(durableReadOnlyProposal(input), /lost response/);
      assert.equal(calls, attempt + 1);
      if (attempt === 2) break;
      await assert.rejects(durableReadOnlyProposal(input), HumanDecisionRequired);
      assert.equal(calls, attempt + 1);
      db.answerHumanDecision("run", db.pendingHumanDecisions("run")[0]!.decisionId, "retry");
    }
    await assert.rejects(durableReadOnlyProposal(input), /budget exhausted/);
    assert.equal(calls, 3);
  } finally { db.close(); }
});
