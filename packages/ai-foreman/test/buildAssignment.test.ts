import { admitFixtureWork, seedQaReceipt } from "./helpers/workAdmission.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginBuildAssignment, captureBuildSource, finishBuildAssignment, assertBuildAssignmentReconciled, isInterruptedBuilderRecovery, retireBuildExecutionForStartOver } from "../src/buildAssignment.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { BuildInterventionControl, parseManagerAction } from "../src/buildInterventions.js";
import { qaDigest } from "../src/qaProtocolV2.js";

test("no-commit source capture honors Git ignores instead of recursively hashing dependency trees", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-source-capture-"));
  try {
    const git = (args: string[]) => execFileSync("git", ["-C", root, ...args]);
    git(["init", "-q"]);
    writeFileSync(join(root, ".gitignore"), "vendor/\n");
    mkdirSync(join(root, "vendor", "huge"), { recursive: true });
    writeFileSync(join(root, "vendor", "huge", "ignored.txt"), "ignored");
    mkdirSync(join(root, "nested-repo", ".git"), { recursive: true });
    writeFileSync(join(root, "product.txt"), "product");
    const captured = captureBuildSource(root);
    assert.deepEqual(captured.untracked.map(item => item.path), [".gitignore", "product.txt"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assignment conflict retains large existing and changed product files within evidence item limits", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-assignment-large-"));
  try {
    const path = join(root, "asset.bin");
    const before = Buffer.alloc(20 * 1024 * 1024, 42);
    const after = Buffer.alloc(20 * 1024 * 1024, 43);
    writeFileSync(path, before);
    const setup = new WorkflowDb(root);
    try {admitFixtureWork(setup,"run","T002");} finally {setup.close();}
    const assignment = beginBuildAssignment(root, "run", "T002", root, "Implement T002");
    writeFileSync(path, after);
    const response = 'STEP_STATUS: done | ticket="T001" summary="foreign work"';
    assert.match(finishBuildAssignment(root, assignment, { text: response, isError: false, numTurns: 1, costUsd: 0 }, { kind: "done", ticket: "T001" })!, /native result|native work-report/i);
    const db = new WorkflowDb(root);
    try {
      const operation = db.operations("run")[0]!;
      type Retained = { untracked: Array<{ path: string; evidenceChunks: string[]; byteLength: number }> };
      const original = (operation.intent as { before: Retained }).before.untracked.find(file => file.path === "asset.bin")!;
      const changed = (operation.result as { after: Retained }).after.untracked.find(file => file.path === "asset.bin")!;
      for (const [record, bytes] of [[original, before], [changed, after]] as const) {
        assert.equal(record.byteLength, bytes.length);
        assert.equal(record.evidenceChunks.length, 3);
        assert.deepEqual(Buffer.concat(record.evidenceChunks.map(digest => db.getEvidence(digest)!)), bytes);
      }
      assert.equal(db.getEvidence((operation.result as { responseDigest: string }).responseDigest)!.toString(), response);
      assert.deepEqual(readFileSync(path), after);
    } finally { db.close(); }
    assert.throws(() => assertBuildAssignmentReconciled(root, "run"), /requires assignment reconciliation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("completed assignments in removed worktrees do not block another run",()=>{
  const root=mkdtempSync(join(tmpdir(),"assignment-project-")),oldWorktree=mkdtempSync(join(tmpdir(),"assignment-old-worktree-"));
  try {
    const db=new WorkflowDb(root);try{admitFixtureWork(db,"old","T1");admitFixtureWork(db,"new","T2");}finally{db.close();}
    const assignment=beginBuildAssignment(root,"old","T1",oldWorktree,"Implement T1");
    finishBuildAssignment(root,assignment,{text:'STEP_STATUS: done | ticket="T1" summary="done"',isError:false,numTurns:1,costUsd:0,turnId:"completed-turn"},{kind:"done",ticket:"T1"});
    rmSync(oldWorktree,{recursive:true,force:true});
    assert.doesNotThrow(()=>assertBuildAssignmentReconciled(root,"new",root));
  }finally{rmSync(root,{recursive:true,force:true});rmSync(oldWorktree,{recursive:true,force:true});}
});

test("an unresolved assignment in the same canonical workspace fences another run",()=>{
  const root=mkdtempSync(join(tmpdir(),"assignment-shared-workspace-"));
  try {
    const db=new WorkflowDb(root);try{admitFixtureWork(db,"old","T1");admitFixtureWork(db,"new","T2");}finally{db.close();}
    beginBuildAssignment(root,"old","T1",root,"Implement T1");
    assert.throws(()=>assertBuildAssignmentReconciled(root,"new",root),/requires assignment reconciliation/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

for (const boundary of ["budget", "requirements", "withdraw", "rollback"] as const) test(`Builder follow-up ${boundary} leaves no partial reservation or invalidated pass`,()=>{
  const root=mkdtempSync(join(tmpdir(),"assignment-followup-"));
  let certificateId:string, authorizationId:string|undefined;
  try {
    writeFileSync(join(root,"source.txt"),"completed source\n");
    const db=new WorkflowDb(root);
    try {
      admitFixtureWork(db,"run","T1");
      let head=db.qaTicketHead("run","T1");
      head=db.transitionQa("run","T1",head.revision,{type:"source-frozen",sourceStateDigest:"source"});
      head=db.transitionQa("run","T1",head.revision,{type:"review-ready",reviewBasisDigest:"basis",sessionGeneration:0});
      head=db.transitionQa("run","T1",head.revision,{type:"turn-intended",slot:"initial"});
      db.beginQaReviewAttempt({attemptId:"passed-review",runId:"run",ticketId:"T1",reviewNumber:head.reviewNumber,cycle:1,remediationGeneration:0,sourceDigest:"source"});
      db.finishQaReviewAttempt("passed-review",{status:"passed"});
      const certificate=db.commitQaPass({runId:"run",ticketId:"T1",qaRevision:head.revision+1,sourceStateDigest:"source",reviewBasisDigest:"basis",turnReceiptDigest:seedQaReceipt(db,"run","T1",head.reviewNumber,"source","basis")},head.revision);
      certificateId=certificate.certificateId;
      const control=new BuildInterventionControl(root,"run","T1");
      try {
        const user="/guide-builder run T1 Check empty input",record=control.enqueue(parseManagerAction(user,"guide",0)!,user);
        if(boundary==="withdraw") {const user=`/withdraw run T1 ${record.instructionId}`;control.enqueue(parseManagerAction(user,"withdraw",control.revision())!,user);}
        if(boundary==="rollback") {const user="/request-attempt run T1 One follow-up";control.enqueue(parseManagerAction(user,"extra",control.revision())!,user);authorizationId=db.consumeInstructionControls("run","T1","attempts");assert.ok(authorizationId);}
      }finally{control.close();}
    }finally{db.close();}
    const before = new WorkflowDb(root);
    const beforeOperations = before.operations("run"); before.close();
    const original=WorkflowDb.prototype.planOperation;
    if(boundary==="rollback")WorkflowDb.prototype.planOperation=function(){throw new Error("Injected failure after budget and certificate writes");};
    try {assert.throws(()=>beginBuildAssignment(root,"run","T1",root,"Follow waiting guidance",{reviewAttemptId:"passed-review",requirementsDigest:boundary==="requirements"?"foreign":qaDigest("admitted-requirements",{id:"T1"}),maximum:boundary==="budget"?0:1,authorizationId}),/budget exhausted|requirements changed|No eligible|Injected failure/);}finally{WorkflowDb.prototype.planOperation=original;}
    const check=new WorkflowDb(root);
    try {
      assert.equal(check.qaTicketHead("run","T1").state,"passed");assert.equal(check.qaAutomaticRemediationCount("run","T1"),0);assert.deepEqual(check.operations("run"),beforeOperations);
      if(authorizationId)assert.equal(check.consumeInstructionControls("run","T1","attempts"),authorizationId);
      check.consumeQaPassCertificate("run","T1",certificateId!,"unchanged-pass");
    }finally{check.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});


import type { BuildRunRecordV2 } from "rafi-spec";

test("only a frozen decision for the same interrupted Builder ticket and session can defer unrelated QA", () => {
  const ref = { version: 1, provider: "codex", sessionId: "session", generation: 1, role: "builder", stream: "builder", cwd: "/workspace", configRoot: "/workspace" };
  const run = {
    runId: "run", tickets: ["T007"], interruptedBuilderContinuation: { ticketIds: ["T007"], sessionRef: ref },
    recoveryDecision: { runId: "run", mode: "exact-session", role: "builder", executionTickets: ["T007"], predecessorSessionRef: ref },
  } as unknown as BuildRunRecordV2;
  assert.equal(isInterruptedBuilderRecovery(run), true);
  assert.equal(isInterruptedBuilderRecovery(undefined), false);
  for (const patch of [
    { role: "qa" }, { mode: "fresh-with-handoff" }, { runId: "another-run" }, { executionTickets: ["T001"] }, { executionTickets: ["T007", "T001"] },
    { predecessorSessionRef: { ...ref, sessionId: "another-session" } }, { predecessorSessionRef: { ...ref, generation: 2 } },
    { predecessorSessionRef: { ...ref, role: "qa", stream: "qa" } }, { predecessorSessionRef: { ...ref, cwd: "/other-worktree" } },
  ]) assert.equal(isInterruptedBuilderRecovery({ ...run, recoveryDecision: { ...run.recoveryDecision, ...patch } } as BuildRunRecordV2), false, JSON.stringify(patch));
});

test("start-over retirement requires a recorded intent and refuses unfinished publications", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-retire-guards-"));
  try {
    const db = new WorkflowDb(root);
    db.ensureRun("old", "build");
    db.planOperation({ runId: "old", idempotencyKey: "dispatch", kind: "provider-dispatch", intent: { role: "builder" } });
    db.updateOperation("dispatch", "in_progress");
    const unrelated = db.createRun({ kind: "recovery", originalWork: { run: { runId: "other" } }, state: { operation: "build-start-over" } });
    const proper = db.createRun({ kind: "recovery", originalWork: { run: { runId: "old" } }, remainingWork: { action: "restart-current", tickets: ["T007"] }, state: { operation: "build-start-over" } });
    db.beginPublication("old", { operation: "ticket-complete" }, {});
    db.close();
    assert.throws(() => retireBuildExecutionForStartOver(root, "old", unrelated.runId), /recorded start-over intent/);
    assert.throws(() => retireBuildExecutionForStartOver(root, "old", proper.runId), /pending publication/);
    const after = new WorkflowDb(root);
    try { assert.equal(after.operation("dispatch")?.status, "in_progress"); } finally { after.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("a superseded label alone cannot bypass unresolved assignment reconciliation", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-retire-evidence-"));
  try {
    const db = new WorkflowDb(root);
    admitFixtureWork(db, "old", "T007");
    db.planOperation({ runId: "old", idempotencyKey: "assignment", kind: "build-assignment", intent: { ticketId: "T007", worktree: root } });
    db.updateOperation("assignment", "in_progress");
    const operation = db.createRun({ kind: "recovery", originalWork: { run: { runId: "old" } }, state: { operation: "build-start-over", gitPreserved: true, resetId: "claimed-reset" } });
    db.transition("old", { status: "superseded", checkpoint: "unproven-retirement", state: { supersededBy: operation.runId } });
    db.close();
    assert.throws(() => assertBuildAssignmentReconciled(root, "old"), /requires assignment reconciliation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
