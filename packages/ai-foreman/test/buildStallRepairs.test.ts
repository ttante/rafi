import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { WorkflowDb } from "../src/workflowDb.js";
import { durableHumanDecision, HumanDecisionRequired } from "../src/humanDecision.js";
import { OperationDeadline } from "../src/util/deadline.js";
import { Foreman } from "../src/foreman.js";
import { Log } from "../src/log.js";
import { cmdInit, cmdUpdate } from "../src/tickets/commands.js";
import { StateDb } from "../src/tickets/stateDb.js";
import type { BuilderAdapter, BuilderEvent } from "../src/adapters/types.js";

function fixture(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "rafi-stall-repairs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("recovery budget survives reopening and excludes changed wording", t => {
  const dir = fixture(t);
  const first = new WorkflowDb(dir);
  assert.equal(first.reserveRecoveryAllowance("run", "T001", "blocker-explanation", 1), true);
  first.close();
  const second = new WorkflowDb(dir);
  try {
    assert.equal(second.reserveRecoveryAllowance("run", "T001", "blocker-explanation", 1), false);
    assert.equal(second.reserveRecoveryAllowance("run", "T002", "blocker-explanation", 1), true);
  } finally { second.close(); }
});

test("deferred question persists once and retrieves its correlated custom answer", async t => {
  const dir = fixture(t);
  const input = { projectDir: dir, runId: "run", key: "question", ticketId: "T001", prompt: "Which registry?", choices: [{ id: "custom", label: "Custom" }], defer: true, operation: async () => { throw new Error("must not prompt while deferring"); } };
  await assert.rejects(durableHumanDecision(input), HumanDecisionRequired);
  await assert.rejects(durableHumanDecision(input), HumanDecisionRequired);
  const db = new WorkflowDb(dir);
  try {
    const pending = db.pendingHumanDecisions("run");
    assert.equal(pending.length, 1);
    db.answerHumanDecision("run", pending[0]!.decisionId, "custom", undefined, "local mirror");
    assert.equal(await durableHumanDecision(input), "local mirror");
  } finally { db.close(); }
});

test("nested phase deadline cannot restart its outer budget", async () => {
  const deadline = new OperationDeadline("preparation", 20);
  await deadline.run(async () => { await new Promise(resolve => setTimeout(resolve, 12)); });
  await assert.rejects(deadline.run(() => new Promise(() => {})), /preparation deadline/);
});

test("blocked ticket and its dependent defer while an independent ticket completes", async t => {
  const dir = fixture(t);
  cmdInit(dir, { appName: "Test", timezone: "UTC" });
  const ticket = (id: string, order: number, depends_on: string[] = []) => ({ id, order, title: id, area: "test", priority: "P1", size: "S", risk: "Low", summary: id, acceptance: ["works"], required_tests: ["tests"], likely_files: [], depends_on });
  writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [ticket("T001", 1), ticket("T002", 2, ["T001"]), ticket("T003", 3)] }));
  cmdUpdate(dir, "T001", { status: "next", actor: "test" });
  cmdUpdate(dir, "T003", { status: "next", actor: "test" });
  const replies = ['STEP_STATUS: blocked | ticket="T001" reason="registry unavailable"', 'STEP_STATUS: done | ticket="T003" summary="implemented independent work"'];
  let turns = 0;
  const builder: BuilderAdapter = { agent: "codex", async sendTurn() { turns++; return { text: replies.shift() ?? "STEP_STATUS: plan_complete", isError: false, numTurns: 1, costUsd: 0 }; }, async *events(): AsyncIterable<BuilderEvent> {}, sessionId: () => "session", async close() {} };
  const foreman = new Foreman(builder, new Log(join(dir, "log.jsonl")), false, false, 3, dir);
  const result = await foreman.runBatch(1);
  assert.equal(result.completed, 1);
  assert.equal(turns, 2);
  const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
  try { assert.equal(db.getState("T001")?.status, "blocked"); assert.notEqual(db.getState("T002")?.status, "done"); }
  finally { db.close(); }
});

test("approved unchanged scope starts automatically, but a material ticket change needs approval even with yes", async t => {
  const { createHash } = await import("node:crypto");
  const { mkdirSync } = await import("node:fs");
  const { approvedBuildScope, requiresBuildApproval, createBuildApprovalGate } = await import("../src/buildApproval.js");
  const dir = fixture(t);
  cmdInit(dir, { appName: "Test", timezone: "UTC" });
  const ticket = { id: "T001", order: 1, title: "Implement", area: "test", priority: "P1", size: "S", risk: "Low", summary: "work", acceptance: ["works"], required_tests: ["tests"], likely_files: [], depends_on: [], plan_ref: { plan_id: "plan", revision: 1, slice_ref: "slice" } };
  writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [ticket] }));
  const canonical = (value: unknown): string => JSON.stringify(value, (_, child) => child && typeof child === "object" && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
  const plan = { version: 1, plan_id: "plan", revision: 1, content_digest: "", slices: [{ ...ticket, slice_ref: ticket.plan_ref.slice_ref }] };
  plan.content_digest = createHash("sha256").update(canonical(plan)).digest("hex");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs/rafi-plan.json"), JSON.stringify(plan));
  writeFileSync(join(dir, "rafi-config.yaml"), stringify({ docs: { root: "docs" }, tickets: { build: { branch_strategy: "current", branch_prefix: "feature" } } }));
  const db = new WorkflowDb(dir);
  db.createRun({ runId: "approved", kind: "plan" });
  db.transition("approved", { status: "completed", checkpoint: "approved", state: { planId: "plan", revision: 1, digest: plan.content_digest, decisionReceipt: { workMode: "current", branchPrefix: "feature", planDigest: plan.content_digest } } });
  db.close();
  const state = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
  state.createTicketGroup({ origin: "ticket-populate", operationId: "populate", members: [{ ticketId: "T001", definition: ticket, validatedAt: new Date().toISOString() }] });
  state.close();
  assert.equal(approvedBuildScope(dir, ["T001"]).approved, true);
  assert.equal(requiresBuildApproval(dir, ["T001"], false), false);
  assert.equal(requiresBuildApproval(dir, ["T001"], true, { branch_strategy: "branch-per-ticket" }), true);
  assert.equal(requiresBuildApproval(dir, ["T001"], false, { branch_strategy: "current" }), false);
  const later = { ...ticket, id: "T002", acceptance: ["unapproved later ticket"] };
  writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [ticket, later] }));
  let prompts = 0;
  const gate = createBuildApprovalGate(dir, ["T001", "T002"], true, { branch_strategy: "current" }, async () => { prompts++; });
  assert.equal(requiresBuildApproval(dir, ["T001"], true), false);
  await gate(); assert.equal(prompts, 1, "later ticket requires approval");
  await gate(); assert.equal(prompts, 1, "same invocation and source reuses approval");
  writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [ticket, { ...later, summary: "changed between turns" }] }));
  await gate(); assert.equal(prompts, 2, "later work cannot reuse a stale revision");
  writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [{ ...ticket, acceptance: ["changed scope"] }] }));
  const edited = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
  edited.updateTicketDefinitionSnapshot("T001", { ...ticket, acceptance: ["changed scope"] });
  edited.close();
  assert.equal(requiresBuildApproval(dir, ["T001"], true), true);
});

test("an answered deferred question resumes at a safe boundary once", async t => {
  const dir = fixture(t);
  cmdInit(dir, { appName: "Test", timezone: "UTC" });
  const tickets = ["T001", "T002"].map((id, order) => ({ id, order, title: id, area: "test", priority: "P1", size: "S", risk: "Low", summary: id, acceptance: ["works"], required_tests: ["tests"], likely_files: [], depends_on: [] }));
  writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets }));
  for (const ticket of tickets) cmdUpdate(dir, ticket.id, { status: "next", actor: "test" });
  const instructions: string[] = [];
  let runId = "";
  const builder: BuilderAdapter = { agent: "codex", async sendTurn(instruction) {
    instructions.push(instruction);
    if (instructions.length === 2) {
      const db = new WorkflowDb(dir);
      try { const question = db.pendingHumanDecisions(runId)[0]!; db.answerHumanDecision(runId, question.decisionId, "custom", undefined, "Use the local mirror"); }
      finally { db.close(); }
    }
    const text = instructions.length === 1 ? 'STEP_STATUS: needs_input | question="Which registry?" choices="Public|Local"'
      : instructions.length === 2 ? 'STEP_STATUS: done | ticket="T002" summary="independent work"' : 'STEP_STATUS: done | ticket="T001" summary="used the mirror"';
    return { text, isError: false, numTurns: 1, costUsd: 0 };
  }, async *events(): AsyncIterable<BuilderEvent> {}, sessionId: () => "session", async close() {} };
  const foreman = new Foreman(builder, new Log(join(dir, "log.jsonl")), false, false, 3, dir);
  runId = (foreman as unknown as { qaRunId: string }).qaRunId;
  const result = await foreman.runBatch(2);
  assert.equal(result.completed, 2);
  assert.equal(instructions.length, 3);
  assert.match(instructions[2]!, /Answer: Use the local mirror/);
  const db = new WorkflowDb(dir);
  try { assert.equal(db.operations(runId).filter(item => item.kind === "decision-continuation" && item.status === "confirmed").length, 1); }
  finally { db.close(); }
});


test("expired outer deadline never dispatches a subsequent phase, even when cleanup throws", async () => {
  const deadline = new OperationDeadline("outer", 5);
  await new Promise(resolve => setTimeout(resolve, 10));
  let dispatched = false;
  await assert.rejects(deadline.run(async () => { dispatched = true; }, () => { throw new Error("cleanup failed"); }), /outer deadline exceeded.*completion is unknown/);
  assert.equal(dispatched, false);
  await assert.rejects(new OperationDeadline("cleanup", 5).run(() => new Promise(() => {}), () => { throw new Error("cleanup failed"); }), /cleanup deadline exceeded/);
});
