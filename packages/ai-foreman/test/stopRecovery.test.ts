import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowDb } from "../src/workflowDb.js";
import { durableHumanDecision, HumanDecisionRequired, servicePendingHumanDecisions, decisionResponse } from "../src/humanDecision.js";
import { formatDecisionCommands } from "../src/recoveryGuidance.js";
import { AuthorizedForeman as Foreman, admitFixtureWork } from "./helpers/workAdmission.js";
import { Log } from "../src/log.js";
import { cmdInit, cmdUpdate } from "../src/tickets/commands.js";
import { StateDb } from "../src/tickets/stateDb.js";
import type { BuilderAdapter } from "../src/adapters/types.js";
function fixture(t: { after(fn: () => void): void }) { const root = mkdtempSync(join(tmpdir(), "rafi-stop-fixed-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
test("service preserves decision identity, pauses safely, and excludes unrelated tickets", async t => {
  const root = fixture(t), db = new WorkflowDb(root);
  try {
    db.ensureRun("run");
    const d = db.ensureHumanDecision({ runId: "run", decisionKey: "question", interruptionId: "ticket:T001", prompt: "Source?", choices: [{ id: "option-1", label: "Use supplied source" }] });
    db.ensureHumanDecision({ runId: "run", decisionKey: "other", interruptionId: "ticket:T002", prompt: "Other?", choices: [{ id: "yes", label: "Yes" }] });
    assert.equal(await servicePendingHumanDecisions({ projectDir: root, runId: "run", tickets: ["T001"], prompt: async x => { assert.equal(x.decisionId, d.decisionId); return undefined; } }), false);
    assert.equal(db.humanDecision(d.decisionId)?.status, "pending");
    assert.equal(db.getRun("run")?.checkpoint, "waiting-for-human");
    assert.equal(await servicePendingHumanDecisions({ projectDir: root, runId: "run", tickets: ["T001"], prompt: async () => "option-1" }), true);
    assert.equal(decisionResponse(db.humanDecision(d.decisionId)!), "Use supplied source");
    assert.equal(db.pendingHumanDecisions("run").length, 1);
    assert.equal(decisionResponse({ selectedChoiceId: "proceed", choices: [{ id: "proceed", label: "Proceed" }] }), "proceed");
  } finally { db.close(); }
});
test("legacy prose IDs survive upgrading the menu without duplicating the pending question", async t => {
  const root = fixture(t), label = "Restore 'network'; (recommended)";
  const common = { projectDir: root, runId: "run", key: "builder:T001:revision", ticketId: "T001", prompt: "Source?", defer: true, operation: async () => label };
  await assert.rejects(durableHumanDecision({ ...common, choices: [{ id: label, label }] }), HumanDecisionRequired);
  await assert.rejects(durableHumanDecision({ ...common, choices: [{ id: "option-1", label }] }), HumanDecisionRequired);
  const db = new WorkflowDb(root); try { assert.equal(db.pendingHumanDecisions("run").length, 1); assert.equal(db.pendingHumanDecisions("run")[0]!.choices[0]!.id, label); } finally { db.close(); }
});
test("generated commands preserve literal legacy choice arguments and can answer the store", t => {
  const root = fixture(t);
  for (const label of ["Use source 'a'; $(exit 9) | (x) Ω", "second"]) {
    const command = formatDecisionCommands(root, "run", { decisionId: "decision", choices: [{ id: label, label }] }).find(line => line.includes("build:decide"))!;
    const args = JSON.parse(execFileSync("/bin/sh", ["-c", `rafi() { "${process.execPath}" -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"; }; ${command}`], { encoding: "utf8" }));
    assert.deepEqual(args, ["build:decide", root, "--run", "run", "--decision", "decision", "--choice", label]);
    const db = new WorkflowDb(root); try { const d = db.ensureHumanDecision({ runId: "run", decisionKey: label, interruptionId: "question", prompt: label, choices: [{ id: label, label }] }); assert.equal(db.answerHumanDecision("run", d.decisionId, String(args.at(-1))).selectedChoiceId, label); } finally { db.close(); }
  }
});
for (const scenario of ["dependent", "mixed", "limit"] as const) test(`same-run servicing: ${scenario}`, async t => {
  const root = fixture(t); cmdInit(root, { appName: "Test", timezone: "UTC" });
  const ids = scenario === "mixed" ? ["T001", "T002", "T003"] : ["T001", "T002"];
  writeFileSync(join(root, ".tickets/tickets.yaml"), JSON.stringify({ tickets: ids.map((id, order) => ({ id, order, title: id, area: "test", priority: "P1", size: "S", risk: "Low", summary: id, acceptance: ["works"], required_tests: ["test"], likely_files: [], depends_on: scenario !== "limit" && id === "T002" ? ["T001"] : [] })) }));
  for (const id of ids.filter(id => scenario === "limit" || id !== "T002")) cmdUpdate(root, id!, { status: "next" });
  const instructions: string[] = []; let prompts = 0;
  const builder: BuilderAdapter = { agent: "codex", sessionId: () => "fake", async close() {}, async *events() {}, async sendTurn(instruction) {
    instructions.push(instruction); const ticket = instruction.match(/Assigned ticket: (T\d+)/)?.[1]!;
    return { text: instructions.length === 1 ? `STEP_STATUS: needs_input | ticket="${ticket}" question="Source?" choices="Local|Download"` : `STEP_STATUS: done | ticket="${ticket}" summary="complete"`, isError: false, numTurns: 1, costUsd: 0 };
  } };
  const foreman = new Foreman(builder, new Log(join(root, "log")), false, false, 3, root);
  (foreman as unknown as { decisionPrompt: () => Promise<string> }).decisionPrompt = async () => { prompts++; assert.equal(instructions.length, scenario === "dependent" ? 1 : 2); return "option-1"; };
  const result = await foreman.runBatch(scenario === "limit" ? 1 : ids.length);
  assert.equal(result.completed, scenario === "limit" ? 1 : ids.length); assert.equal(prompts, 1);
  if (scenario === "limit") { assert.equal(instructions.length, 2); const db = new StateDb(join(root, ".tickets/ticket-state.sqlite")); try { assert.equal(db.getState("T001")?.blocker_type, "input"); assert.match(db.getState("T001")?.blocker_notes ?? "", /Source\?/); } finally { db.close(); } }
  else { assert.equal(result.outcome, "all-done"); assert.match(instructions.find(i => i.includes("Scoped answers"))!, /Answer: Local/); }
});
test("cancel retires pending decisions, preserves their evidence, and prevents reactivation", t => {
  const db = new WorkflowDb(fixture(t)); try { db.ensureRun("run"); const d = db.ensureHumanDecision({ runId: "run", decisionKey: "x", interruptionId: "ticket:T001", prompt: "Source?", choices: [{ id: "x", label: "X" }] }); db.cancelPendingHumanDecisions("run", "cancelled"); db.transition("run", { status: "cancelled", checkpoint: "cancelled" }); assert.equal(db.pendingHumanDecisions("run").length, 0); assert.equal(db.humanDecision(d.decisionId)?.status, "cancelled"); assert.equal(db.humanDecision(d.decisionId)?.prompt, "Source?"); assert.throws(() => db.transition("run", { status: "running", checkpoint: "resume" }), /terminal/); } finally { db.close(); }
});

test("stale pending questions are superseded before prompting, retaining original evidence", async t => {
  const root = fixture(t), db = new WorkflowDb(root);
  try {
    db.ensureRun("run");
    const old = db.ensureHumanDecision({ runId: "run", decisionKey: "run:builder:T001:old:digest", interruptionId: "ticket:T001", prompt: "Source?", choices: [{ id: "local", label: "Local" }] });
    let replacement = "";
    await servicePendingHumanDecisions({ projectDir: root, runId: "run", scopeRevision: "new", prompt: async d => { assert.notEqual(d.decisionId, old.decisionId); replacement = d.decisionId; return "local"; } });
    assert.equal(db.humanDecision(old.decisionId)?.status, "cancelled"); assert.equal(db.humanDecision(replacement)?.status, "answered");
    assert.equal(db.answeredTicketDecisions("run", "new").length, 1);
  } finally { db.close(); }
});
test("only a proven not-sent continuation may retry; unknown or in-progress actions require reconciliation", t => {
  const db = new WorkflowDb(fixture(t)); try {
    db.ensureRun("run");
    for (const [id, outcome] of [["not-sent", "failed"], ["unknown", "uncertain"], ["active", "in_progress"]] as const) {
      const key = db.nextDecisionContinuationKey("run", id);
      db.planOperation({ runId: "run", idempotencyKey: key, kind: "decision-continuation", intent: { decisionId: id } }); db.updateOperation(key, "in_progress");
      if (outcome !== "in_progress") db.updateOperation(key, outcome, { result: { dispatchState: id } });
      assert.equal(db.decisionContinuationAvailable("run", id), id === "not-sent");
      if (id === "not-sent") assert.match(db.nextDecisionContinuationKey("run", id), /retry-1$/);
      else assert.throws(() => db.nextDecisionContinuationKey("run", id), /reconciliation/);
    }
  } finally { db.close(); }
});

test("explicit question cancellation supersedes pending questions and records a terminal reason", async t => {
  const { HumanDecisionCancelled } = await import("../src/humanDecision.js");
  const root = fixture(t), db = new WorkflowDb(root);
  try {
    db.ensureRun("run"); const d = db.ensureHumanDecision({ runId: "run", decisionKey: "x", interruptionId: "ticket:T001", prompt: "Source?", choices: [{ id: "local", label: "Local" }] });
    await assert.rejects(servicePendingHumanDecisions({ projectDir: root, runId: "run", prompt: async () => "__rafi_cancel__" }), HumanDecisionCancelled);
    assert.equal(db.getRun("run")?.status, "cancelled"); assert.equal(db.humanDecision(d.decisionId)?.status, "cancelled");
    assert.equal(db.events("run").at(-1)?.type, "user_cancelled");
  } finally { db.close(); }
});

test("inline answered continuation is journaled and cannot be replayed after dispatch", async t => {
  const { buildScopeRevision } = await import("../src/buildApproval.js");
  const root = fixture(t); cmdInit(root, { appName: "Test", timezone: "UTC" });
  writeFileSync(join(root, ".tickets/tickets.yaml"), JSON.stringify({ tickets: [{ id: "T001", order: 1, title: "One", area: "test", priority: "P1", size: "S", risk: "Low", summary: "One", acceptance: ["works"], required_tests: ["test"], likely_files: [], depends_on: [] }] }));
  cmdUpdate(root, "T001", { status: "next" });
  let calls = 0, decisionId = "";
  const builder: BuilderAdapter = { agent: "codex", sessionId: () => "fake", async close() {}, async *events() {}, async sendTurn(instruction) {
    if (++calls === 1) {
      await assert.rejects(durableHumanDecision({ projectDir: root, runId: identity.qaRunId, key: `builder:T001:${buildScopeRevision(root)}`, ticketId: "T001", prompt: "Source?", choices: [{ id: "option-1", label: "Local" }, { id: "custom", label: "Custom response" }], defer: true, operation: async () => "Local" }), HumanDecisionRequired);
      const db = new WorkflowDb(root); try { decisionId = db.pendingHumanDecisions(identity.qaRunId)[0]!.decisionId; db.answerHumanDecision(identity.qaRunId, decisionId, "option-1"); } finally { db.close(); }
      return { text: 'STEP_STATUS: needs_input | ticket="T001" question="Source?" choices="Local"', isError: false, numTurns: 1, costUsd: 0 };
    }
    assert.match(instruction, /Local/);
    return { text: 'STEP_STATUS: done | ticket="T001" summary="complete"', isError: false, numTurns: 1, costUsd: 0 };
  } };
  const foreman = new Foreman(builder, new Log(join(root, "log")), false, false, 3, root);
  const identity = foreman as unknown as { qaRunId: string; currentTicketId: string; continueIndependentTickets: boolean; doTurn(instruction: string): Promise<unknown> };
  const admissionDb=new WorkflowDb(root);try{admitFixtureWork(admissionDb,identity.qaRunId,"T001");}finally{admissionDb.close();}
  identity.currentTicketId = "T001"; identity.continueIndependentTickets = false;
  await identity.doTurn("Implement T001");
  const db = new WorkflowDb(root); try { assert.equal(calls, 2); assert.equal(db.operation(`decision-continuation:${decisionId}`)?.status, "confirmed"); assert.equal(db.decisionContinuationAvailable(identity.qaRunId, decisionId), false); } finally { db.close(); }
});

test("durable ticket answer cannot be reused after its continuation was dispatched", async t => {
  const root = fixture(t);
  const input = { projectDir: root, runId: "run", key: "builder:T001:revision", ticketId: "T001", prompt: "Source?", choices: [{ id: "option-1", label: "Local" }], defer: true, operation: async () => "Local" };
  await assert.rejects(durableHumanDecision(input), HumanDecisionRequired);
  const db = new WorkflowDb(root);
  try {
    const decision = db.pendingHumanDecisions("run")[0]!;
    db.answerHumanDecision("run", decision.decisionId, "option-1");
    assert.equal(await durableHumanDecision(input), "Local");
    const key = db.nextDecisionContinuationKey("run", decision.decisionId);
    db.planOperation({ runId: "run", idempotencyKey: key, kind: "decision-continuation", intent: { decisionId: decision.decisionId } });
    db.updateOperation(key, "in_progress");
    await assert.rejects(durableHumanDecision(input), /already been dispatched or is uncertain/);
  } finally { db.close(); }
});
