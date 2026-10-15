import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBuildRun, releaseBuildLease, readBuildRuns } from "ai-foreman/build-runs.js";
import { applyStartOverGit, inventoryBuildStartOver, planStartOverGit, buildBuildStartOverCommand, resolveStartOverCleanup } from "../src/buildStartOver.js";

function git(cwd: string, args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }

test("local start-over archives commits and dirty work, reports branch, and restores original baseline", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-start-over-"));
  try {
    git(dir, ["init", "-b", "main"]); git(dir, ["config", "user.email", "test@example.test"]); git(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "app.txt"), "baseline\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "baseline"]);
    const baseline = git(dir, ["rev-parse", "HEAD"]);
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"], baseRef: "main" });
    run = releaseBuildLease(dir, run, "recoverable");
    writeFileSync(join(dir, "app.txt"), "committed work\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "work"]);
    writeFileSync(join(dir, "extra.txt"), "dirty work\n");
    const inventory = inventoryBuildStartOver(dir, { ...run, active: false });
    assert.equal(inventory.recommended, "restart-current");
    const planned = planStartOverGit(inventory, "archive-restart");
    const result = applyStartOverGit(inventory, "archive-restart", planned);
    assert.match(result.archiveBranch!, /^archive\/main-/);
    assert.equal(git(dir, ["branch", "--show-current"]), "main");
    assert.equal(git(dir, ["rev-parse", "HEAD"]), baseline);
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "baseline\n");
    assert.equal(git(dir, ["show", `${result.archiveBranch}:extra.txt`]), "dirty work");
    assert.deepEqual(applyStartOverGit(inventory, "archive-restart", planned), result);
    assert.equal(git(dir, ["branch", "--list", "archive/*"]).split("\n").filter(Boolean).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy incomplete baseline offers archive/preserve and restarts from the detected current base without rewriting the original", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-start-over-legacy-"));
  try {
    git(dir, ["init", "-b", "main"]); git(dir, ["config", "user.email", "test@example.test"]); git(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "app.txt"), "baseline\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "baseline"]);
    git(dir, ["switch", "-c", "feature/legacy"]);
    writeFileSync(join(dir, "app.txt"), "committed legacy work\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "legacy work"]);
    const originalHead = git(dir, ["rev-parse", "HEAD"]);
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"] }); run = releaseBuildLease(dir, run, "recoverable");
    run = { ...run, repository: { ...run.repository, baselineComplete: false, git: { ...run.repository.git, baselineHead: undefined, baseRef: undefined } } };
    writeFileSync(join(dir, "extra.txt"), "uncommitted legacy work\n");
    const inventory = inventoryBuildStartOver(dir, { ...run, active: false });
    assert.deepEqual(inventory.choices, ["restart-current", "archive-new-branch", "new-branch", "manual", "cancel"]);
    assert.equal(inventory.choices.includes("archive-restart"), false);
    assert.equal(inventory.baseRef, "main");
    assert.equal(inventory.recommended, "restart-current");
    const result = applyStartOverGit(inventory, "archive-new-branch");
    assert.match(result.archiveBranch!, /^archive\/feature-legacy-/);
    assert.equal(git(dir, ["show", `${result.archiveBranch}:extra.txt`]), "uncommitted legacy work");
    assert.equal(git(dir, ["rev-parse", "feature/legacy"]), originalHead);
    assert.equal(git(dir, ["rev-parse", "HEAD"]), git(dir, ["rev-parse", "main"]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("merged work exposes retain, reviewable revert, manual, and cancel choices", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-start-over-merged-"));
  try {
    git(dir, ["init", "-b", "main"]); git(dir, ["config", "user.email", "test@example.test"]); git(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "app.txt"), "baseline\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "baseline"]);
    const baseline = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["switch", "-c", "feature/merged"]);
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"], baseRef: "main", baseHead: baseline }); run = releaseBuildLease(dir, run, "recoverable");
    writeFileSync(join(dir, "app.txt"), "merged work\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "work"]);
    const runHead = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["switch", "main"]); git(dir, ["merge", "--ff-only", "feature/merged"]); git(dir, ["switch", "feature/merged"]);
    run = { ...run, repository: { ...run.repository, git: { ...run.repository.git, startHead: runHead } } };
    const inventory = inventoryBuildStartOver(dir, { ...run, active: false });
    assert.equal(inventory.merged, true);
    assert.deepEqual(inventory.choices, ["restart-current", "retain-merged", "revert-branch", "manual", "cancel"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pushed work is left on the original branch and restarts on a collision-safe new branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-start-over-pushed-"));
  try {
    git(dir, ["init", "-b", "main"]); git(dir, ["config", "user.email", "test@example.test"]); git(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "app.txt"), "baseline\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "baseline"]);
    const baseline = git(dir, ["rev-parse", "HEAD"]);
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"], baseRef: "main" }); run = releaseBuildLease(dir, run, "recoverable");
    writeFileSync(join(dir, "app.txt"), "pushed work\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "work"]);
    const oldHead = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["branch", "main-restart-2", baseline]);
    run = { ...run, repository: { ...run.repository, git: { ...run.repository.git, upstream: "origin/main" } } };
    const inventory = inventoryBuildStartOver(dir, { ...run, active: false });
    assert.equal(inventory.recommended, "restart-current");
    const result = applyStartOverGit(inventory, "new-branch");
    assert.equal(result.restartBranch, "main-restart-3");
    assert.equal(git(dir, ["rev-parse", "main"]), oldHead);
    assert.equal(git(dir, ["rev-parse", "HEAD"]), baseline);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dirty work on a pushed branch is classified as unexpected and must be moved first", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-start-over-pushed-dirty-"));
  try {
    git(dir, ["init", "-b", "main"]); git(dir, ["config", "user.email", "test@example.test"]); git(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "app.txt"), "baseline\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "baseline"]);
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"], baseRef: "main" }); run = releaseBuildLease(dir, run, "recoverable");
    run = { ...run, repository: { ...run.repository, git: { ...run.repository.git, upstream: "origin/main" } } };
    writeFileSync(join(dir, "dirty.txt"), "do not sweep\n");
    const inventory = inventoryBuildStartOver(dir, { ...run, active: false });
    assert.deepEqual(inventory.unexpectedPaths, ["dirty.txt"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { stringify } from "yaml";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";
import { StateDb } from "../../ai-foreman/dist/tickets/stateDb.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";
import { assertBuildAssignmentReconciled } from "ai-foreman/build-assignment.js";
import { offerStartRecovery } from "../src/startRecovery.js";
import { buildStartCommand } from "ai-foreman/cli/start.js";

function recoveryProject() {
  const dir = mkdtempSync(join(tmpdir(), "rafi-start-over-command-"));
  git(dir, ["init", "-b", "main"]); git(dir, ["config", "user.email", "test@example.test"]); git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "app.txt"), "baseline\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "baseline"]);
  mkdirSync(join(dir, ".tickets"));
  writeFileSync(join(dir, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())));
  writeFileSync(join(dir, ".tickets/config.yaml"), "app_name: Test\n");
  writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: ["T001", "T007", "T008"].map((id, order) => ({ id, order, title: id, area: "core", priority: "P2", size: "S", risk: "Low", depends_on: [], summary: id, acceptance: ["works"], required_tests: ["test"], likely_files: ["app.txt"] })) }));
  const state = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
  state.upsertState("T001", { status: "done", evidence: "completed" }, new Date().toISOString());
  state.upsertState("T007", { status: "in_progress", attempt_count: 2 }, new Date().toISOString());
  state.upsertState("T008", { status: "blocked" }, new Date().toISOString());
  state.close();
  let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001", "T007", "T008"] });
  run = releaseBuildLease(dir, run, "recoverable");
  return { dir, run };
}

test("fresh start offers recovery and confirmed restart clears abandoned dispatch without replay", async () => {
  const { dir, run } = recoveryProject();
  try {
    const db = new WorkflowDb(dir);
    const lease = db.acquireLease(run.runId);
    db.planOperation({ runId: run.runId, idempotencyKey: "start-blocker", kind: "provider-dispatch", intent: { role: "builder" } });
    db.updateOperation("start-blocker", "in_progress");
    db.releaseLease(lease); db.close();
    const calls: string[] = [];
    const actions = {
      choose: async () => "cancel" as const,
      resume: async () => { calls.push("resume"); },
      restart: async (project: string, id: string, action?: "restart-current") => {
        calls.push("restart");
        await buildBuildStartOverCommand().parseAsync([project, "--run", id, "--action", action!, "--yes"], { from: "user" });
      },
    };
    assert.equal(await offerStartRecovery(dir, actions), false);
    const before = new WorkflowDb(dir);
    assert.equal(before.operation("start-blocker")?.status, "in_progress"); before.close();
    assert.deepEqual(calls, []);
    assert.equal(await offerStartRecovery(dir, { ...actions, choose: async () => "resume" }), false);
    assert.deepEqual(calls, ["resume"]);
    assert.equal(await offerStartRecovery(dir, { ...actions, choose: async () => "restart-current" }), false);
    assert.deepEqual(calls, ["resume", "restart"]);
    const after = new WorkflowDb(dir);
    assert.equal(after.operation("start-blocker")?.status, "failed");
    assert.equal((after.operation("start-blocker")?.result as { providerReplayAuthorized?: boolean }).providerReplayAuthorized, false);
    after.close();
    assert.equal(await offerStartRecovery(dir, actions), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fresh start recovery routes archive to preservation chooser and blocks unattended launch", async () => {
  const { dir, run } = recoveryProject();
  const savedExitCode = process.exitCode;
  try {
    const db = new WorkflowDb(dir); const lease = db.acquireLease(run.runId);
    db.planOperation({ runId: run.runId, idempotencyKey: "qa-start-blocker", kind: "provider-dispatch", intent: { role: "qa" } });
    db.updateOperation("qa-start-blocker", "in_progress"); db.updateOperation("qa-start-blocker", "uncertain");
    db.releaseLease(lease); db.close();
    let called = false;
    const actions = { resume: async () => { throw new Error("unexpected resume"); }, restart: async (project: string, id: string, action?: "restart-current") => {
      assert.equal(project, dir); assert.equal(id, run.runId); assert.equal(action, undefined); called = true;
    } };
    assert.equal(await offerStartRecovery(dir, actions), false);
    assert.equal(process.exitCode, 2); assert.equal(called, false);
    process.exitCode = savedExitCode;
    assert.equal(await offerStartRecovery(dir, { ...actions, choose: async () => "archive" }), false);
    assert.equal(called, true);
  } finally { process.exitCode = savedExitCode; rmSync(dir, { recursive: true, force: true }); }
});

test("start command redirects before ticket lookup or provider setup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-start-redirect-"));
  try {
    let called = false;
    await buildStartCommand({ beforeFreshStart: async project => { assert.equal(project, dir); called = true; return false; } })
      .parseAsync([dir, "--steps", "8", "--yes", "--ticket", "NOT-INITIALIZED"], { from: "user" });
    assert.equal(called, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restart-current retires broken execution, preserves branch and bytes, and resets only unfinished run tickets", async () => {
  const { dir, run } = recoveryProject();
  try {
    const beforeHead = git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "app.txt"), "preserved implementation\n");
    writeFileSync(join(dir, "untracked.txt"), "preserved untracked\n");
    const db = new WorkflowDb(dir);
    const fixtureLease = db.acquireLease(run.runId);
    db.admitWork({ runId: run.runId, kind: "ticket", ticketId: "T007", definition: { id: "T007" }, approvalId: "fixture", scopeRevision: "fixture", provenance: { userTurn: "Approved T007", reason: "recovery fixture" } });
    db.planOperation({ runId: run.runId, idempotencyKey: "interrupted-assignment", kind: "build-assignment", intent: { ticketId: "T007", worktree: dir } });
    db.updateOperation("interrupted-assignment", "in_progress");
    db.planOperation({ runId: run.runId, idempotencyKey: "interrupted-dispatch", kind: "provider-dispatch", intent: { role: "builder" } });
    db.updateOperation("interrupted-dispatch", "in_progress");
    db.updateOperation("interrupted-dispatch", "uncertain");
    db.beginPublication(run.runId, { operation: "build-run-projection", target: join(dir, ".foreman", "runs", `${run.runId}.json`) }, {});
    db.releaseLease(fixtureLease);
    db.close();
    await buildBuildStartOverCommand().parseAsync([dir, "--run", run.runId, "--action", "restart-current", "--yes"], { from: "user" });
    assert.equal(git(dir, ["branch", "--show-current"]), "main");
    assert.equal(git(dir, ["rev-parse", "HEAD"]), beforeHead);
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "preserved implementation\n");
    assert.equal(readFileSync(join(dir, "untracked.txt"), "utf8"), "preserved untracked\n");
    const state = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      assert.equal(state.getState("T001")?.status, "done");
      assert.equal(state.getState("T001")?.evidence, "completed");
      assert.equal(state.getState("T007")?.status, "planned");
      assert.equal(state.getState("T008")?.status, "planned");
    } finally { state.close(); }
    assert.equal(readBuildRuns(dir).find(item => item.runId === run.runId)?.status, "superseded");
    const after = new WorkflowDb(dir);
    try {
      assert.equal(after.incompletePublications().length, 0, "the superseding projection also reconciles interrupted projection publication");
      assert.equal(after.operation("interrupted-dispatch")?.status, "failed");
      assert.equal((after.operation("interrupted-dispatch")?.result as { outcomeUnknown?: boolean }).outcomeUnknown, true);
      assert.equal(after.operation("interrupted-assignment")?.status, "in_progress", "historical evidence remains intact");
      assert.doesNotThrow(() => assertBuildAssignmentReconciled(dir, "new-run"));
      const admission = after.acquireBuildAdmission("new-run", "coordinator");
      after.releaseBuildAdmission(admission);
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restart-current validates explicit reset scope before modifying execution", async () => {
  const { dir, run } = recoveryProject();
  try {
    await assert.rejects(buildBuildStartOverCommand().parseAsync([dir, "--run", run.runId, "--action", "restart-current", "--tickets", "FOREIGN", "--yes"], { from: "user" }), /only tickets in the selected run/);
    assert.equal(readBuildRuns(dir).find(item => item.runId === run.runId)?.status, "recoverable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cleanup pauses noninteractive restart, explains options, and verifies manual handling", async () => {
  const { dir, run } = recoveryProject();
  const previousExitCode = process.exitCode;
  try {
    writeFileSync(join(dir, "pre-run.txt"), "preserve me");
    const inventory = inventoryBuildStartOver(dir, { ...run, active: false });
    const bytes = readFileSync(join(dir, "rafi-config.yaml"));
    assert.equal(await resolveStartOverCleanup(inventory), false);
    assert.equal(process.exitCode, 2);
    assert.deepEqual(readFileSync(join(dir, "rafi-config.yaml")), bytes);
    assert.equal(await resolveStartOverCleanup(inventory, "handled"), false);
    assert.equal(readBuildRuns(dir).find(item => item.runId === run.runId)?.status, "recoverable");
  } finally { process.exitCode = previousExitCode; rmSync(dir, { recursive: true, force: true }); }
});


test("stash choice preserves implementation bytes in Git and keeps tracker/configuration in place", async () => {
  const { dir, run } = recoveryProject();
  try {
    writeFileSync(join(dir, "app.txt"), "stash implementation\n");
    writeFileSync(join(dir, "extra.txt"), "stash untracked\n");
    const config = readFileSync(join(dir, "rafi-config.yaml"));
    const choices = ["stash"] as const;
    assert.equal(await resolveStartOverCleanup(inventoryBuildStartOver(dir, { ...run, active: false }), undefined, { choose: async () => choices[0], confirm: async () => true }), true);
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "baseline\n");
    assert.deepEqual(readFileSync(join(dir, "rafi-config.yaml")), config);
    const state = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try { assert.equal(state.getState("T001")?.status, "done"); } finally { state.close(); }
    assert.equal(git(dir, ["show", "stash@{0}:app.txt"]), "stash implementation");
    assert.equal(git(dir, ["show", "stash@{0}^3:extra.txt"]), "stash untracked");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("discard requires separate confirmation, keeps untracked files, and waits for verified manual cleanup", async () => {
  const { dir, run } = recoveryProject();
  try {
    writeFileSync(join(dir, "app.txt"), "discard implementation\n");
    writeFileSync(join(dir, "extra.txt"), "manual untracked\n");
    let prompts = 0;
    assert.equal(await resolveStartOverCleanup(inventoryBuildStartOver(dir, { ...run, active: false }), undefined, {
      choose: async () => {
        if (prompts++ === 0) return "discard";
        assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "baseline\n");
        assert.equal(readFileSync(join(dir, "extra.txt"), "utf8"), "manual untracked\n");
        rmSync(join(dir, "extra.txt"));
        return "handled";
      }, confirm: async message => { assert.match(message, /Permanently discard/); return true; },
    }), true);
    assert.equal(prompts, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("declining destructive cleanup and cancelling preserves every source byte", async () => {
  const { dir, run } = recoveryProject();
  try {
    writeFileSync(join(dir, "app.txt"), "keep this work\n");
    let selected = false;
    assert.equal(await resolveStartOverCleanup(inventoryBuildStartOver(dir, { ...run, active: false }), undefined, {
      choose: async () => { if (selected) return "cancel"; selected = true; return "discard"; }, confirm: async () => false,
    }), false);
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "keep this work\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a crash after supersession can finish the same start-over without resetting tickets twice", async () => {
  const { dir, run } = recoveryProject();
  try {
    writeFileSync(join(dir, "app.txt"), "keep after crash\n");
    await assert.rejects(buildBuildStartOverCommand({ afterSupersession: () => { throw new Error("simulated host interruption"); } }).parseAsync([dir, "--run", run.runId, "--action", "restart-current", "--tickets", "T007", "--yes"], { from: "user" }), /simulated host interruption/);
    assert.equal(readBuildRuns(dir).find(item => item.runId === run.runId)?.status, "superseded");
    await buildBuildStartOverCommand().parseAsync([dir, "--run", run.runId, "--yes"], { from: "user" });
    const state = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      assert.equal(state.getTicketEvents("T007").filter(item => item.event_type === "ticket_reset").length, 1);
      assert.equal(state.getState("T008")?.status, "blocked");
    } finally { state.close(); }
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "keep after crash\n");
    const db = new WorkflowDb(dir);
    try { assert.equal(db.resumableRuns("recovery").filter(item => item.state.operation === "build-start-over").length, 0); } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("stash handles staged renames and literal filenames with spaces, Unicode and brackets", async () => {
  const { dir, run } = recoveryProject();
  try {
    const renamed = " renamed ü [x].txt";
    git(dir, ["mv", "app.txt", renamed]);
    writeFileSync(join(dir, renamed), "renamed implementation\n");
    const inventory = inventoryBuildStartOver(dir, { ...run, active: false });
    assert.deepEqual(inventory.dirtyPaths, [renamed, "app.txt"]);
    assert.equal(await resolveStartOverCleanup(inventory, undefined, { choose: async () => "stash", confirm: async () => true }), true);
    assert.equal(git(dir, ["show", `stash@{0}:${renamed}`]), "renamed implementation");
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "baseline\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("Git rollback preserves tracked tracker definitions and configuration, including file permissions", async () => {
  const { dir, run } = recoveryProject();
  try {
    git(dir, ["add", "rafi-config.yaml", ".tickets/config.yaml", ".tickets/tickets.yaml"]);
    git(dir, ["commit", "-m", "setup metadata after original baseline"]);
    const config = readFileSync(join(dir, "rafi-config.yaml"));
    const definitions = readFileSync(join(dir, ".tickets/tickets.yaml"));
    if (process.platform !== "win32") chmodSync(join(dir, "rafi-config.yaml"), 0o600);
    writeFileSync(join(dir, "app.txt"), "archive this implementation\n");
    await buildBuildStartOverCommand().parseAsync([dir, "--run", run.runId, "--action", "archive-restart", "--yes"], { from: "user" });
    assert.deepEqual(readFileSync(join(dir, "rafi-config.yaml")), config);
    assert.deepEqual(readFileSync(join(dir, ".tickets/tickets.yaml")), definitions);
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "baseline\n");
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "rafi-config.yaml")).mode & 0o777, 0o600);
    assert.equal(readBuildRuns(dir).find(item => item.runId === run.runId)?.status, "superseded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
