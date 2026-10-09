import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { bindBuildAuthority, BUILD_RUN_DIRECTORY, buildRecoveryPreview, completeBuildRun, createBuildRun, currentBranchRecoveryTicket, currentBranchTicketProgress, recoveryExecutionTickets, finishRecoveredTicketScope, heartbeatBuildRun, persistBuildSession, readBuildRuns, recordBuildReceipt, recoverableBuildRuns, releaseBuildLease, resumeBuildRun, saveBuildRun } from "../src/buildRuns.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { cmdInit } from "../src/tickets/commands.js";
import { StateDb } from "../src/tickets/stateDb.js";

test("child recovery rejects a superseded decision after acquiring its lease", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-recovery-decision-"));
  try {
    const settings = {
      role: "builder" as const, source: "project" as const, make: "codex" as const,
      model: "default", reasoning: "high", fast: false, session_strategy: "compact" as const,
      display_session_cost: false, auto_compact_threshold_percent: 50,
      compact_maximum: 10, settings_revision: 0,
    };
    let run = createBuildRun({ tickets: ["T001"], repositoryRoot: dir, builder: settings });
    run = releaseBuildLease(dir, run, "recoverable");
    const receipt = { version: 1 as const, mode: "fresh-recovery-only" as const, runId: run.runId, tickets: run.tickets, role: "builder" as const, authoritativeStateDigest: "state", settings, worktree: dir, planUpdateApproval: "auto" as const, decidedAt: new Date(0).toISOString() };
    const expectedRecoveryDecisionDigest = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    const editor = new WorkflowDb(dir);
    const editorLease = editor.acquireLease(run.runId);
    saveBuildRun(dir, bindBuildAuthority({ ...run, recoveryDecision: { ...receipt, decidedAt: new Date(1).toISOString() } }, editorLease));
    editor.releaseLease(editorLease); editor.close();
    assert.throws(() => resumeBuildRun(dir, run.runId, { expectedRecoveryDecisionDigest }), /Recovery decision changed/);
    const db = new WorkflowDb(dir);
    try { assert.equal(db.currentLease(), undefined); assert.equal(db.getRun(run.runId)?.status, "paused"); }
    finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build records atomically retain sessions, receipts, and completed history", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-run-"));
  try {
    const settings = { role: "builder" as const, source: "project" as const, make: "codex" as const, model: "default", reasoning: "high", fast: false };
    let run = createBuildRun({ tickets: ["T001", "T002"], repositoryRoot: dir, builder: settings, qa: { ...settings, role: "qa" } });
    run = persistBuildSession(dir, run, "builder", "session-1");
    run = recordBuildReceipt(dir, run, "commit:T001", { externalId: "abc123" });
    const duplicate = recordBuildReceipt(dir, run, "commit:T001", { externalId: "wrong" });
    assert.equal(duplicate.receipts["commit:T001"]?.externalId, "abc123");
    assert.match(buildRecoveryPreview(run).join("\n"), /Builder session candidate requires validation/);
    run = completeBuildRun(dir, run);
    assert.equal(readBuildRuns(dir)[0]?.status, "completed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("released build leases become recoverable without deleting partial state", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-run-"));
  try {
    let run = createBuildRun({ tickets: ["T010"], repositoryRoot: dir });
    run = releaseBuildLease(dir, run, "recoverable");
    assert.equal(run.lease, undefined);
    assert.equal(readBuildRuns(dir)[0]?.checkpoint, "created");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const remaining of ["in_progress", "blocked", "missing", "done"] as const) test(`ticket recovery completes only its verified scope with ${remaining} remaining state`, () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-recovered-scope-"));
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    const run = createBuildRun({ repositoryRoot: dir, tickets: ["T001", "T002", "T003"] });
    const tickets = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      for (const id of ["T001", "T003"]) tickets.upsertState(id, { status: "done" }, new Date().toISOString());
      if (remaining !== "missing") tickets.upsertState("T002", { status: remaining }, new Date().toISOString());
      tickets.upsertState("UNRELATED", { status: "in_progress" }, new Date().toISOString());
    } finally { tickets.close(); }
    const next = finishRecoveredTicketScope(dir, run, "qa-recovery-complete");
    assert.equal(next.status, remaining === "done" ? "completed" : "recoverable");
    assert.equal(next.lease, undefined);
    assert.deepEqual(next.tickets, run.tickets);
    assert.deepEqual(next.progress.completedTickets, remaining === "done" ? run.tickets : ["T001", "T003"]);
    assert.deepEqual(next.progress.remainingTickets, remaining === "done" ? [] : ["T002"]);
    if (remaining !== "done") assert.equal(next.currentTicket, "T002");
    assert.deepEqual(readBuildRuns(dir)[0]?.progress, next.progress);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ticket recovery retains the QA finalization guard even when tracker says done", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-recovered-qa-guard-"));
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    const run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"] });
    const tickets = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try { tickets.upsertState("T001", { status: "done" }, new Date().toISOString()); } finally { tickets.close(); }
    const db = new WorkflowDb(dir);
    try {
      const head = db.qaTicketHead(run.runId, "T001");
      db.transitionQa(run.runId, "T001", head.revision, { type: "source-frozen", sourceStateDigest: "a".repeat(64) });
      assert.throws(() => completeBuildRun(dir, run), /QA|qa/);
      const next = finishRecoveredTicketScope(dir, run, "qa-recovery-complete");
      assert.equal(next.status, "recoverable");
      assert.deepEqual(next.progress.remainingTickets, ["T001"]);
      assert.notEqual(db.getRun(run.runId)?.status, "completed");
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("current-branch recovery resolves its durable ticket and rejects an out-of-scope projection", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-recovery-ticket-selection-"));
  try {
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001", "T002"] });
    run = saveBuildRun(dir, { ...run, currentTicket: "T002" });
    assert.equal(currentBranchRecoveryTicket(dir, run), "T002");
    // A mismatched persisted selection must not dispatch generic or unrelated work.
    run = saveBuildRun(dir, { ...run, currentTicket: "OTHER" });
    assert.throws(() => currentBranchRecoveryTicket(dir, run), /outside the saved run scope/);
    releaseBuildLease(dir, run, "recoverable");
    const empty = createBuildRun({ repositoryRoot: dir, tickets: [] });
    assert.equal(currentBranchRecoveryTicket(dir, empty), undefined, "unticketed legacy starts retain their existing behavior");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pure heartbeats update only the authoritative lease row", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-heartbeat-"));
  try {
    const created = createBuildRun({ runId: "heartbeat-run", tickets: ["T001"], repositoryRoot: dir, now: new Date("2025-01-01T00:00:00.000Z") });
    const snapshot = join(dir, BUILD_RUN_DIRECTORY, `${created.runId}.json`);
    const beforeMtime = statSync(snapshot).mtimeMs;
    const db = new Database(join(dir, ".rafi", "recovery.sqlite3"), { readonly: true });
    const count = (table: string): number => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    const before = { events: count("workflow_events"), sessions: count("provider_sessions"), imports: count("legacy_imports") };
    db.close();

    const next = heartbeatBuildRun(dir, created, new Date("2025-01-01T00:00:10.000Z"));
    assert.equal(next.lease?.heartbeatAt, "2025-01-01T00:00:10.000Z");
    assert.equal(statSync(snapshot).mtimeMs, beforeMtime);
    const afterDb = new Database(join(dir, ".rafi", "recovery.sqlite3"), { readonly: true });
    const afterCount = (table: string): number => Number((afterDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    assert.deepEqual({ events: afterCount("workflow_events"), sessions: afterCount("provider_sessions"), imports: afterCount("legacy_imports") }, before);
    assert.equal((afterDb.prepare("SELECT heartbeat_at FROM project_lease WHERE singleton=1").get() as { heartbeat_at: string }).heartbeat_at, "2025-01-01T00:00:10.000Z");
    assert.equal((afterDb.prepare("SELECT legacy FROM workflow_runs WHERE run_id=?").get(created.runId) as { legacy: number }).legacy, 0);
    afterDb.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build records persist shared and mixed branch allocation modes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-run-modes-"));
  try {
    const shared = createBuildRun({ tickets: ["T020"], repositoryRoot: dir, branchMode: "shared" });
    releaseBuildLease(dir, shared, "recoverable");
    const mixed = createBuildRun({ tickets: ["T021", "T022"], repositoryRoot: dir, branchMode: "mixed" });
    releaseBuildLease(dir, mixed, "recoverable");
    assert.deepEqual(readBuildRuns(dir).map((run) => run.branchMode).sort(), ["mixed", "shared"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recoverable runs infer tickets omitted by legacy current-branch records", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-run-legacy-ticket-"));
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    let run = createBuildRun({
      tickets: [],
      repositoryRoot: dir,
      branchMode: "current",
      now: new Date("2025-01-01T00:00:00.000Z"),
    });
    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      db.insertEvent({
        timestamp: "2025-01-01T00:00:01.000Z",
        actor: "foreman",
        ticket_id: "T030",
        event_type: "update",
        old_status: "next",
        new_status: "in_progress",
        summary: "Starting step 1 of 1",
        validation: null,
        evidence: null,
        payload_json: "{}",
      });
    } finally {
      db.close();
    }
    run = releaseBuildLease(dir, run, "recoverable");

    const recovered = recoverableBuildRuns(dir).find((candidate) => candidate.runId === run.runId);
    assert.deepEqual(recovered?.tickets, ["T030"]);
    assert.equal(recovered?.currentTicket, "T030");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a superseded authoritative run cannot be resurrected through an old projection", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-retired-resume-"));
  try {
    const run = createBuildRun({ tickets: ["T1"], repositoryRoot: dir });
    releaseBuildLease(dir, run, "recoverable");
    const db = new WorkflowDb(dir);
    const authority = db.acquireLease(run.runId);
    db.transition(run.runId, { status: "superseded", checkpoint: "start-over" });
    db.releaseLease(authority);
    db.close();
    assert.equal(readBuildRuns(dir)[0]?.status, "superseded");
    assert.throws(() => resumeBuildRun(dir, run.runId, {}), /superseded/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("projection publication failure retains the DB revision and reconciles on the next safe save", async () => {
  const { mkdirSync, readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "rafi-projection-fault-"));
  try {
    const initial = createBuildRun({ tickets: ["T001"], repositoryRoot: dir });
    const path = join(dir, BUILD_RUN_DIRECTORY, `${initial.runId}.json`);
    rmSync(path);
    mkdirSync(path); // Inject a deterministic rename failure after DB commit.
    assert.throws(() => saveBuildRun(dir, { ...initial, checkpoint: "new-authoritative-revision" }));
    const recovered = readBuildRuns(dir)[0]!;
    assert.equal(recovered.checkpoint, "new-authoritative-revision");
    const db = new WorkflowDb(dir);
    try { assert.equal(db.incompletePublications().filter(item => (item.intent as { operation?: string }).operation === "build-run-projection").length, 1); }
    finally { db.close(); }
    rmSync(path, { recursive: true });
    saveBuildRun(dir, { ...initial, ...recovered });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).checkpoint, "new-authoritative-revision");
    const after = new WorkflowDb(dir);
    try { assert.equal(after.incompletePublications().length, 0); }
    finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing run projection does not hide authoritative state and read does not rewrite the DB", async () => {
  const { readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "rafi-projection-reader-"));
  try {
    const run = createBuildRun({ tickets: ["T001"], repositoryRoot: dir });
    rmSync(join(dir, BUILD_RUN_DIRECTORY), { recursive: true });
    const database = join(dir, ".rafi/recovery.sqlite3");
    const before = createHash("sha256").update(readFileSync(database)).digest("hex");
    assert.equal(readBuildRuns(dir)[0]?.runId, run.runId);
    assert.equal(createHash("sha256").update(readFileSync(database)).digest("hex"), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("start-over authority can supersede its original run without borrowing its old lease", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-supersession-authority-"));
  try {
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"] });
    run = releaseBuildLease(dir, run, "recoverable");
    const db = new WorkflowDb(dir);
    try {
      const operation = db.createRun({ kind: "recovery", checkpoint: "start-over", originalWork: {}, remainingWork: {}, state: {} });
      const admission = db.acquireBuildRecoveryAdmission(operation.runId);
      const lease = db.acquireLease(operation.runId);
      assert.throws(() => saveBuildRun(dir, bindBuildAuthority({ ...run, status: "running" }, lease)), /original workflow authority/);
      const superseded = saveBuildRun(dir, bindBuildAuthority({ ...run, status: "superseded", supersededBy: operation.runId }, lease));
      assert.equal(superseded.status, "superseded");
      assert.equal(db.currentLease()?.runId, operation.runId);
      db.releaseLease(lease); db.releaseBuildAdmission(admission);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing, released and serialized authority rejects without changing initialized files or DB", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "rafi-authority-reject-"));
  try {
    const run = createBuildRun({ repositoryRoot: root, tickets: [] });
    releaseBuildLease(root, run);
    const dbPath = join(root, ".rafi/recovery.sqlite3");
    const projection = join(root, BUILD_RUN_DIRECTORY);
    rmSync(projection, { recursive: true });
    const before = readFileSync(dbPath);
    for (const value of [run, JSON.parse(JSON.stringify(run))]) assert.throws(() => saveBuildRun(root, value), /authority|ownership/);
    assert.equal(existsSync(projection), false);
    assert.deepEqual(readFileSync(dbPath), before);
    const db = new WorkflowDb(root);
    try {
      assert.throws(() => db.transition(run.runId, { checkpoint: "unowned" }), /authority/);
      assert.throws(() => db.recordSession(run.runId, "builder", "builder", "unowned", "checkpoint", { role: "builder", source: "project", make: "codex", model: "default", reasoning: "default", fast: false, session_strategy: "compact", display_session_cost: false, auto_compact_threshold_percent: 50, compact_maximum: 10, settings_revision: 0 }), /authority/);
      assert.throws(() => db.planOperation({ runId: run.runId, idempotencyKey: "unowned", kind: "provider-dispatch", intent: {} }), /authority/);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const status of ["completed", "cancelled", "superseded"] as const) test(`terminal ${status} cannot be reactivated even after acquiring a new lease`, () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-terminal-fence-"));
  try {
    const run = createBuildRun({ repositoryRoot: root, tickets: [] });
    const db = new WorkflowDb(root);
    db.transition(run.runId, { status, checkpoint: "terminal" });
    assert.throws(() => db.transition(run.runId, { status: "running", checkpoint: "resurrected" }), /terminal/);
    assert.throws(() => saveBuildRun(root, { ...run, status: "running" }), /rewrite/);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

 test("crash and interrupted reconciliation retain earlier blocked tickets after later completion", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-partial-crash-"));
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001", "T002"] });
    run = saveBuildRun(dir, { ...run, currentTicket: "T002" });
    const tickets = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try { tickets.upsertState("T001", { status: "blocked" }, new Date().toISOString()); tickets.upsertState("T002", { status: "done" }, new Date().toISOString()); } finally { tickets.close(); }
    assert.equal(currentBranchRecoveryTicket(dir, run), "T001");
    assert.deepEqual(currentBranchTicketProgress(dir, run)?.completed, ["T002"]);
    run = finishRecoveredTicketScope(dir, run, "interrupted");
    assert.equal(run.currentTicket, "T001");
    assert.deepEqual(run.progress.remainingTickets, ["T001"]);
    assert.deepEqual(run.progress.completedTickets, ["T002"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unanswered decisions prevent terminal completion even when tracker is done", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-question-finalize-"));
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    const run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"] });
    const state = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try { state.upsertState("T001", { status: "done" }, new Date().toISOString()); } finally { state.close(); }
    const db = new WorkflowDb(dir);
    try { db.ensureHumanDecision({ decisionKey: "unanswered", runId: run.runId, interruptionId: "ticket:T001", prompt: "Choose", choices: [{ id: "a", label: "A" }] }); } finally { db.close(); }
    assert.throws(() => completeBuildRun(dir, run), /unanswered/);
    assert.equal(finishRecoveredTicketScope(dir, run, "paused").status, "recoverable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("execution scope distinguishes frozen bare resume, explicit and legacy selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-execution-scope-"));
  try {
    const run = createBuildRun({ repositoryRoot: dir, tickets: ["T001", "T002"] });
    assert.deepEqual(recoveryExecutionTickets(run, [], false), run.tickets);
    assert.deepEqual(recoveryExecutionTickets(run, ["T001"], false), ["T001"]);
    assert.deepEqual(recoveryExecutionTickets(run, ["T001"], true), ["T001"]);
    const frozen = { ...run, recoveryDecision: { executionTickets: run.tickets } as NonNullable<typeof run.recoveryDecision> };
    assert.deepEqual(recoveryExecutionTickets(frozen, ["T001"], true), run.tickets);
    assert.deepEqual(recoveryExecutionTickets(frozen, ["T001"], false), ["T001"]);
    assert.throws(() => recoveryExecutionTickets(frozen, ["OTHER"], true), /scope/);
    frozen.recoveryDecision.executionTickets = ["T001"];
    assert.throws(() => recoveryExecutionTickets(frozen, ["T002"], true), /scope/);
    frozen.recoveryDecision.executionTickets = [];
    assert.throws(() => recoveryExecutionTickets(frozen, [], true), /scope/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tracker completion cannot finalize an uncertain provider dispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-uncertain-completion-"));
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    const run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"] });
    const state = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try { state.upsertState("T001", { status: "done" }, new Date().toISOString()); } finally { state.close(); }
    const db = new WorkflowDb(dir);
    try {
      db.planOperation({ runId: run.runId, idempotencyKey: "unknown-turn", kind: "provider-dispatch", intent: { role: "builder" } });
      db.updateOperation("unknown-turn", "in_progress"); db.updateOperation("unknown-turn", "uncertain");
      assert.throws(() => finishRecoveredTicketScope(dir, run, "reconcile"), /unresolved provider/);
      assert.notEqual(db.getRun(run.runId)?.status, "completed");
      assert.equal(db.operation("unknown-turn")?.status, "uncertain");
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unreadable tracker remains inspectable and never authorizes completion", async () => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "rafi-unreadable-tracker-"));
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    const run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"] });
    const path = join(dir, ".tickets/ticket-state.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    writeFileSync(path, "legacy or damaged tracker");
    assert.equal(currentBranchRecoveryTicket(dir, run), "T001");
    assert.deepEqual(currentBranchTicketProgress(dir, run)?.completed, []);
    assert.equal(finishRecoveredTicketScope(dir, run, "interrupted").status, "recoverable");
    assert.equal(readFileSync(path, "utf8"), "legacy or damaged tracker");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
