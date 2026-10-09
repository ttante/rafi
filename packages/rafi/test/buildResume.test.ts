import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";

import { createBuildRun, persistBuildSession, projectBuildRecovery, readBuildRuns, releaseBuildLease } from "ai-foreman/build-runs.js";
import { createProviderSessionRef } from "ai-foreman/session-identity.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";
import { createQaRecoveryPacket } from "ai-foreman/qa-recovery.js";
import type { BuildRunRecordV2 } from "rafi-spec";
import { buildBuildResumeCommand } from "../src/buildResume.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";

function initializedProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-resume-"));
  writeFileSync(join(dir, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())), "utf8");
  mkdirSync(join(dir, ".tickets"), { recursive: true });
  writeFileSync(join(dir, ".tickets/config.yaml"), "app_name: Test\n", "utf8");
  writeFileSync(join(dir, ".tickets/tickets.yaml"), "tickets: []\n", "utf8");
  writeFileSync(join(dir, ".tickets/ticket-state.sqlite"), Buffer.from("SQLite format 3\0"));
  return dir;
}

function initializeGit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "resume@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Resume Test"], { cwd: dir });
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
}

function scopedSession(dir: string, sessionId: string, provider: "claude" | "codex" = "codex") {
  return createProviderSessionRef({
    provider,
    sessionId,
    role: "builder",
    stream: "builder",
    cwd: dir,
    configRoot: dir,
    source: "observed",
  });
}

function decisionDigest(dir: string, runId: string): string {
  return createHash("sha256").update(JSON.stringify(readBuildRuns(dir).find((run) => run.runId === runId)!.recoveryDecision)).digest("hex");
}

function attachLegacyQaRecovery(dir: string, runId: string): string {
  const packet = join(dir, ".foreman", "qa-report-recovery", "legacy-v1");
  mkdirSync(packet, { recursive: true });
  writeFileSync(join(packet, "manifest.json"), JSON.stringify({ version: 1, packetId: "legacy-packet", packetDigest: "0".repeat(64), runId, ticketId: "T011", resources: [] }));
  const db = new WorkflowDb(dir);
  const fixtureLease = db.acquireLease(runId);
  const run = db.getRun(runId)!;
  db.transition(runId, {
    status: run.status, checkpoint: run.checkpoint, remainingWork: run.remainingWork,
    state: { ...run.state, qaReportRecovery: { packetPath: packet, packetDigest: "0".repeat(64), pendingAction: "operator-menu", ticketId: "T011" } },
    event: "legacy_qa_packet_fixture", payload: { packet },
  });
  db.releaseLease(fixtureLease); db.close();
  return packet;
}

async function availableProjection(projectDir: string, run: BuildRunRecordV2, now = new Date(), ticket?: string) {
  const frozen = projectBuildRecovery(projectDir, run, now, ticket);
  const ref = frozen.sessionCandidateRef;
  return projectBuildRecovery(projectDir, run, now, ticket, ref ? {
    version: 1,
    status: "available",
    checkedAt: now.toISOString(),
    observedCwd: ref.cwd,
    sessionRef: { ...ref, validatedAt: now.toISOString() },
  } : undefined);
}

test("build:resume converts a recoverable run into an exact-session start", async () => {
  const dir = initializedProject();
  try {
    const settings = {
      role: "builder" as const,
      source: "project" as const,
      make: "codex" as const,
      model: "gpt-test",
      reasoning: "high",
      fast: true,
    };
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"], builder: settings });
    run = persistBuildSession(dir, run, "builder", scopedSession(dir, "session-123"));
    run = releaseBuildLease(dir, run, "recoverable");
    let invoked: string[] | undefined;
    const command = buildBuildResumeCommand({ executeStart: (args) => {
      const childDb = new WorkflowDb(dir);
      try { assert.equal(childDb.currentLease(), undefined, "resume CLI must release its parent lease before launching the new supervisor"); }
      finally { childDb.close(); }
      invoked = args;
      return 0;
    }, resolveProjection: availableProjection });

    await command.parseAsync([dir, "--run", run.runId, "--yes"], { from: "user" });

    assert.deepEqual(withoutLaunchToken(invoked), [
      "start",
      resolve(dir),
      "--steps",
      "1",
      "--recover-run",
      run.runId,
      "--recovery-mode",
      "exact-session",
      "--recovery-decision-digest", decisionDigest(dir, run.runId),
      "--ticket", "T001",
      "--resume",
      "session-123",
      "--agent",
      "codex",
      "--model",
      "gpt-test",
      "--effort",
      "high",
      "--fast",
    ]);
    assert.equal(readBuildRuns(dir).find((candidate) => candidate.runId === run.runId)?.recoveryDecision?.planUpdateApproval, "auto");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build:resume selects a recoverable run directly by ticket", async () => {
  const dir = initializedProject();
  try {
    const settings = {
      role: "builder" as const,
      source: "project" as const,
      make: "codex" as const,
      model: "default",
      reasoning: "default",
      fast: false,
    };
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T004", "T006"], builder: settings });
    run = persistBuildSession(dir, run, "builder", scopedSession(dir, "session-ticket"));
    run = releaseBuildLease(dir, run, "recoverable");
    let invoked: string[] | undefined;
    const command = buildBuildResumeCommand({ executeStart: (args) => { invoked = args; return 0; }, resolveProjection: availableProjection });

    await command.parseAsync([dir, "--ticket", "T006", "--yes"], { from: "user" });

    assert.equal(invoked?.includes(run.runId), true);
    assert.equal(invoked?.join(" ").includes("--steps 1"), true);
    assert.equal(invoked?.join(" ").includes("--ticket T006"), true);
    assert.deepEqual(withoutLaunchToken(invoked).slice(-4), ["--resume", "session-ticket", "--agent", "codex"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build:resume reports an unmatched ticket instead of opening the picker", async () => {
  const dir = initializedProject();
  try {
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T005"] });
    run = releaseBuildLease(dir, run, "recoverable");
    const command = buildBuildResumeCommand({ executeStart: () => 0 });

    await assert.rejects(
      command.parseAsync([dir, "--ticket", "T999", "--yes"], { from: "user" }),
      /no recoverable build run found for ticket T999; recoverable tickets: T005/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build:resume supports explicit fresh-session recovery", async () => {
  const dir = initializedProject();
  try {
    const settings = {
      role: "builder" as const,
      source: "project" as const,
      make: "claude" as const,
      model: "default",
      reasoning: "default",
      fast: false,
    };
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T002"], builder: settings });
    run = releaseBuildLease(dir, run, "recoverable");
    let invoked: string[] | undefined;
    const command = buildBuildResumeCommand({ executeStart: (args) => { invoked = args; return 0; } });

    await command.parseAsync([dir, "--run", run.runId, "--yes", "--fresh-session"], { from: "user" });

    assert.deepEqual(withoutLaunchToken(invoked), [
      "start", resolve(dir), "--steps", "1", "--recover-run", run.runId,
      "--recovery-mode", "fresh-recovery-only", "--recovery-decision-digest", decisionDigest(dir, run.runId), "--ticket", "T002", "--agent", "claude",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build:resume rejects a wrong-ticket branch recovery before projection or execution", async () => {
  const dir = initializedProject();
  try {
    initializeGit(dir);
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T021", "T022"], branchMode: "shared" });
    createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: run.runId, ticketId: "T021", cycle: 1, reviewAttempt: 1, recoveryStage: "operator-menu", pendingAction: "operator-menu", resources: { prompt: { value: "review", purpose: "Exact review prompt", exactText: true } } });
    run = releaseBuildLease(dir, run, "recoverable");
    let projected = false;
    let invoked = false;
    const command = buildBuildResumeCommand({
      executeStart: () => { invoked = true; return 0; },
      resolveProjection: async (projectDir, selectedRun, now, ticket) => { projected = true; return availableProjection(projectDir, selectedRun, now, ticket); },
    });
    await assert.rejects(
      command.parseAsync([dir, "--ticket", "T022", "--yes", "--fresh-with-handoff"], { from: "user" }),
      /conflicts with pending QA recovery ticket T021/,
    );
    assert.equal(projected, false);
    assert.equal(invoked, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build:resume scopes a pending V2 QA packet and accepts only one undispatched successor revision", async () => {
  const dir = initializedProject();
  try {
    initializeGit(dir);
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T031", "T032"], branchMode: "shared", qa: { role: "qa", source: "project", make: "codex", model: "default", reasoning: "default", fast: false } });
    const packet = createQaRecoveryPacket({ projectDir: dir, reviewedWorktree: dir, runId: run.runId, ticketId: "T032", cycle: 1, reviewAttempt: 1, recoveryStage: "operator-menu", pendingAction: "operator-menu", resources: { prompt: { value: "review", purpose: "Exact review prompt", exactText: true } } });
    const db = new WorkflowDb(dir);
    db.beginQaReviewAttempt({ attemptId: packet.manifest.reviewAttemptId, runId: run.runId, ticketId: "T032", reviewNumber: 1, cycle: 1, remediationGeneration: 0, sourceDigest: packet.manifest.reviewedStateDigest });
    let protocolHead = db.qaTicketHead(run.runId, "T032");
    protocolHead = db.transitionQa(run.runId, "T032", protocolHead.revision, { type: "source-frozen", sourceStateDigest: packet.manifest.reviewedStateDigest });
    protocolHead = db.transitionQa(run.runId, "T032", protocolHead.revision, { type: "review-ready", reviewBasisDigest: "b".repeat(64), sessionGeneration: 1 });
    protocolHead = db.transitionQa(run.runId, "T032", protocolHead.revision, { type: "turn-intended", slot: "initial" });
    protocolHead = db.transitionQa(run.runId, "T032", protocolHead.revision, { type: "operator-menu" });
    db.finishQaReviewAttempt(packet.manifest.reviewAttemptId, { status: "interrupted", detail: "simulated crash before packet review identity publication" });
    protocolHead = db.transitionQa(run.runId, "T032", protocolHead.revision, { type: "source-frozen", sourceStateDigest: packet.manifest.reviewedStateDigest });
    protocolHead = db.transitionQa(run.runId, "T032", protocolHead.revision, { type: "review-ready", reviewBasisDigest: "c".repeat(64), sessionGeneration: 2 });
    db.beginQaReviewAttempt({ attemptId: "undispatched-successor", runId: run.runId, ticketId: "T032", reviewNumber: 2, cycle: 1, remediationGeneration: 0, sourceDigest: packet.manifest.reviewedStateDigest });
    db.appendContinuityEvent({ runId: run.runId, role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1 });
    db.publishContinuityCheckpoint({ runId: run.runId, role: "qa", authoritativeStateRevision: 1, delta: { version: 1, decisions: [], constraints: [], discoveries: [], completedActions: [], evidence: [], failures: [], blockers: [], openWork: ["recover QA report"], nextAction: "resume QA recovery" } });
    db.close();
    run = releaseBuildLease(dir, run, "recoverable");
    let invoked: string[] | undefined;
    const command = buildBuildResumeCommand({ executeStart: (args) => { invoked = args; return 0; }, resolveProjection: availableProjection });
    await command.parseAsync([dir, "--run", run.runId, "--yes"], { from: "user" });
    assert.equal(invoked![invoked!.indexOf("--qa-revision") + 1], String(protocolHead.revision));
    assert.ok(invoked);
    assert.equal(invoked[invoked.indexOf("--ticket") + 1], "T032");
    assert.equal(invoked[invoked.indexOf("--steps") + 1], "1");
    assert.equal(invoked.includes("--branch-per-ticket"), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build:resume discovers a pending durable QA reducer even without a packet", async () => {
  const dir = initializedProject();
  try {
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T041"], builder: { role: "builder", source: "project", make: "codex", model: "default", reasoning: "default", fast: false } });
    const db = new WorkflowDb(dir);
    let head = db.qaTicketHead(run.runId, "T041");
    head = db.transitionQa(run.runId, "T041", head.revision, { type: "source-frozen", sourceStateDigest: "a".repeat(64) });
    head = db.transitionQa(run.runId, "T041", head.revision, { type: "review-ready", reviewBasisDigest: "b".repeat(64), sessionGeneration: 1 });
    head = db.transitionQa(run.runId, "T041", head.revision, { type: "turn-intended", slot: "initial" });
    head = db.transitionQa(run.runId, "T041", head.revision, { type: "review-failed", reportDigest: "c".repeat(64) });
    db.close();
    run = releaseBuildLease(dir, run, "recoverable");
    let invoked: string[] | undefined;
    const command = buildBuildResumeCommand({ executeStart: (args) => { invoked = args; return 0; }, resolveProjection: availableProjection });
    await command.parseAsync([dir, "--run", run.runId, "--yes", "--fresh-session"], { from: "user" });
    assert.ok(invoked);
    assert.equal(invoked[invoked.indexOf("--ticket") + 1], "T041");
    assert.equal(invoked[invoked.indexOf("--qa-revision") + 1], String(head.revision));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build:resume refuses to treat a V1 QA packet as authoritative", async () => {
  const dir = initializedProject();
  try {
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T011"] });
    run = releaseBuildLease(dir, run, "recoverable");
    attachLegacyQaRecovery(dir, run.runId);
    const command = buildBuildResumeCommand({ executeStart: () => 0 });
    await assert.rejects(
      command.parseAsync([dir, "--run", run.runId, "--yes"], { from: "user" }),
      /legacy QA recovery V1 packet/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build:resume exposes no legacy QA execution option", async () => {
  const dir = initializedProject();
  try {
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T011"] });
    run = releaseBuildLease(dir, run, "recoverable");
    const command = buildBuildResumeCommand({ executeStart: () => 0, resolveProjection: availableProjection }).exitOverride();
    await assert.rejects(command.parseAsync([dir, "--run", run.runId, "--yes", "--legacy-qa-recovery", "restart"], { from: "user" }), /unknown option/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build:resume recovers shared and mixed modes with isolated-branch flags", async () => {
  for (const branchMode of ["shared", "mixed"] as const) {
    const dir = initializedProject();
    try {
      const settings = {
        role: "builder" as const,
        source: "project" as const,
        make: "codex" as const,
        model: "default",
        reasoning: "default",
        fast: false,
      };
      let run = createBuildRun({ repositoryRoot: dir, tickets: ["T003"], branchMode, builder: settings });
      run = persistBuildSession(dir, run, "builder", scopedSession(dir, `session-${branchMode}`));
      run = releaseBuildLease(dir, run, "recoverable");
      let invoked: string[] | undefined;
      const command = buildBuildResumeCommand({ executeStart: (args) => { invoked = args; return 0; }, resolveProjection: availableProjection });

      await command.parseAsync([dir, "--run", run.runId, "--yes"], { from: "user" });

      assert.deepEqual(withoutLaunchToken(invoked), [
        "start",
        resolve(dir),
        "--steps",
        "1",
        "--recover-run",
        run.runId,
        "--recovery-mode",
        "exact-session",
        "--recovery-decision-digest", decisionDigest(dir, run.runId),
        "--branch-per-ticket",
        "--resume",
        `session-${branchMode}`,
        "--agent",
        "codex",
      ], branchMode);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("build:resume --no is explicit review mode and refuses non-interactive mutation", async () => {
  const dir = initializedProject();
  try {
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T007"], builder: {
      role: "builder", source: "project", make: "codex", model: "default", reasoning: "default", fast: false,
    } });
    run = releaseBuildLease(dir, run, "recoverable");
    let invoked = false;
    const command = buildBuildResumeCommand({ executeStart: () => { invoked = true; return 0; } });

    await assert.rejects(
      command.parseAsync([dir, "--run", run.runId, "--no", "--fresh-session"], { from: "user" }),
      /--no requires an interactive TTY/,
    );
    assert.equal(invoked, false);
    assert.equal(readBuildRuns(dir).find((candidate) => candidate.runId === run.runId)?.recoveryDecision, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build:resume rejects conflicting plan-update approval flags", async () => {
  const dir = initializedProject();
  try {
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T008"] });
    run = releaseBuildLease(dir, run, "recoverable");
    const command = buildBuildResumeCommand({ executeStart: () => 0 });
    await assert.rejects(
      command.parseAsync([dir, "--run", run.runId, "--yes", "--no", "--fresh-session"], { from: "user" }),
      /--yes and --no are mutually exclusive/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build:resume without an approval flag records the interactive review choice only for this resume", async () => {
  const dir = initializedProject();
  try {
    const settings = { role: "builder" as const, source: "project" as const, make: "codex" as const, model: "default", reasoning: "default", fast: false };
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T009"], builder: settings });
    run = persistBuildSession(dir, run, "builder", scopedSession(dir, "session-review"));
    run = releaseBuildLease(dir, run, "recoverable");
    let invoked: string[] = [];
    const command = buildBuildResumeCommand({
      executeStart: (args) => { invoked = args; return 0; },
      resolveProjection: availableProjection,
      resolvePlanUpdateApproval: async () => "review",
    });

    await command.parseAsync([dir, "--run", run.runId], { from: "user" });

    assert.equal(invoked.includes("--yes"), false);
    assert.equal(readBuildRuns(dir).find((candidate) => candidate.runId === run.runId)?.recoveryDecision?.planUpdateApproval, "review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build:resume propagates the child status without adding a redundant wrapper failure", async () => {
  const dir = initializedProject();
  const priorExitCode = process.exitCode;
  try {
    const settings = { role: "builder" as const, source: "project" as const, make: "codex" as const, model: "default", reasoning: "default", fast: false };
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T010"], builder: settings });
    run = releaseBuildLease(dir, run, "recoverable");
    const command = buildBuildResumeCommand({ executeStart: () => 2 });

    await command.parseAsync([dir, "--run", run.runId, "--yes", "--fresh-session"], { from: "user" });

    assert.equal(process.exitCode, 2);
  } finally {
    process.exitCode = priorExitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build:resume rejects state changed during prompting before saving or dispatching", async () => {
  const dir = initializedProject();
  try {
    const settings = { role: "builder" as const, source: "project" as const, make: "codex" as const, model: "default", reasoning: "default", fast: false };
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T010"], builder: settings });
    run = releaseBuildLease(dir, run, "recoverable");
    let invoked = false;
    const command = buildBuildResumeCommand({ executeStart: () => { invoked = true; return 0; }, resolvePlanUpdateApproval: async () => {
      const db = new WorkflowDb(dir);
      try {
        const current = db.getRun(run.runId)!;
        db.transition(run.runId, { status: current.status, checkpoint: "changed-by-other-supervisor", remainingWork: current.remainingWork, state: current.state, event: "concurrent_resume_test" });
      } finally { db.close(); }
      return "auto";
    } });
    await assert.rejects(command.parseAsync([dir, "--run", run.runId, "--fresh-session"], { from: "user" }), /Recovery state changed/);
    assert.equal(invoked, false);
    const db = new WorkflowDb(dir);
    try {
      assert.equal(db.getRun(run.runId)?.checkpoint, "changed-by-other-supervisor");
      assert.equal(db.recoveryDecisions(run.runId).length, 0);
      assert.equal(db.currentLease(), undefined);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build:resume saves its final run snapshot while holding the mutation lease", async () => {
  const dir = initializedProject();
  const original = WorkflowDb.prototype.transition;
  let checked = false;
  try {
    const settings = { role: "builder" as const, source: "project" as const, make: "codex" as const, model: "default", reasoning: "default", fast: false };
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T010"], builder: settings });
    run = releaseBuildLease(dir, run, "recoverable");
    WorkflowDb.prototype.transition = function (...args: Parameters<WorkflowDb["transition"]>) {
      if (args[0] === run.runId && args[1].checkpoint === "recovery-decision-frozen") {
        assert.equal(this.currentLease()?.pid, process.pid);
        assert.equal(this.currentLease()?.runId, run.runId);
        checked = true;
      }
      return original.apply(this, args);
    };
    const command = buildBuildResumeCommand({ executeStart: () => 0 });
    await command.parseAsync([dir, "--run", run.runId, "--yes", "--fresh-session"], { from: "user" });
    assert.equal(checked, true);
  } finally { WorkflowDb.prototype.transition = original; rmSync(dir, { recursive: true, force: true }); }
});

test("build:resume with no flags selects and resumes an unfinished build", async () => {
  const dir = initializedProject();
  try {
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"], builder: { role: "builder", source: "project", make: "codex", model: "default", reasoning: "default", fast: false } });
    run = persistBuildSession(dir, run, "builder", scopedSession(dir, "picker-session"));
    run = releaseBuildLease(dir, run, "recoverable");
    let invoked: string[] | undefined;
    await buildBuildResumeCommand({
      selectRun: async runs => { assert.equal(runs[0].runId, run.runId); return runs[0]; },
      resolvePlanUpdateApproval: async () => "review", resolveProjection: availableProjection,
      executeStart: args => { invoked = args; return 0; },
    }).parseAsync([dir], { from: "user" });
    assert.ok(invoked);
    assert.equal(invoked[invoked.indexOf("--recover-run") + 1], run.runId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cancelling the build picker does not dispatch or create a recovery decision", async () => {
  const dir = initializedProject();
  try {
    const run = releaseBuildLease(dir, createBuildRun({ repositoryRoot: dir, tickets: ["T001"] }), "recoverable");
    await buildBuildResumeCommand({ selectRun: async () => undefined,
      executeStart: () => { throw new Error("must not dispatch"); },
    }).parseAsync([dir], { from: "user" });
    assert.equal(readBuildRuns(dir)[0].recoveryDecision, undefined);
    assert.equal(readBuildRuns(dir)[0].runId, run.runId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("preparation-only builds remain selectable and replay saved argv without shell evaluation", async () => {
  const dir = initializedProject();
  try {
    const args = ["start", resolve(dir), "--steps", "9", "--model", "literal $(not-a-command)"];
    const db = new WorkflowDb(dir);
    db.ensureRun("preparation-only", "build");
    db.transition("preparation-only", { status: "paused", checkpoint: "preparing", state: { startArgs: args } });
    db.close();
    let invoked: string[] | undefined;
    await buildBuildResumeCommand({ selectRun: async runs => { assert.equal(runs[0].runId, "preparation-only"); return runs[0]; },
      executeStart: received => { invoked = received; return 0; },
    }).parseAsync([dir], { from: "user" });
    assert.deepEqual(invoked?.slice(0, args.length), args);
    assert.equal(invoked?.[args.length], "--preparation-run");
    assert.equal(invoked?.[args.length + 2], "--launch-token");
    const state = new WorkflowDb(dir);
    try {
      assert.equal(state.getRun("preparation-only")?.status, "superseded");
      assert.equal(state.preparationSuccessor("preparation-only"), invoked?.[args.length + 1]);
      assert.equal(state.buildLaunch(invoked![args.length + 3])?.state, "failed");
    } finally { state.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("multiple pending QA tickets are selectable without flags and use the selected revision", async () => {
  const dir = initializedProject();
  try {
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001", "T002"], builder: { role: "builder", source: "project", make: "codex", model: "default", reasoning: "default", fast: false } });
    run = persistBuildSession(dir, run, "builder", scopedSession(dir, "multiple-qa-session"));
    const db = new WorkflowDb(dir);
    for (const ticket of run.tickets) db.transitionQa(run.runId, ticket, 0, { type: "operator-menu" });
    const revision = db.qaTicketHead(run.runId, "T002").revision;
    db.close();
    run = releaseBuildLease(dir, run, "recoverable");
    let invoked: string[] | undefined;
    const options = {
      selectRun: async (runs: Array<typeof run & { active: boolean }>) => runs[0],
      selectTicket: async (tickets: string[]) => { assert.deepEqual(tickets, ["T001", "T002"]); return "T002"; },
      resolveProjection: availableProjection, resolvePlanUpdateApproval: async () => "review" as const,
      executeStart: (args: string[]) => { invoked = args; return 0; },
    };
    await buildBuildResumeCommand(options).parseAsync([dir], { from: "user" });
    assert.equal(invoked![invoked!.indexOf("--ticket") + 1], "T002");
    assert.equal(invoked![invoked!.indexOf("--qa-revision") + 1], String(revision));
    const launcher = new WorkflowDb(dir);
    const authority = launcher.buildAdmission()!;
    if (authority) { launcher.failBuildLaunch(authority, invoked!.at(-1)!); launcher.releaseBuildAdmission(authority); }
    launcher.close();
    invoked = undefined;
    await assert.rejects(buildBuildResumeCommand(options).parseAsync([dir, "--run", run.runId, "--ticket", "T002", "--qa-revision", "0"], { from: "user" }), /stale QA protocol revision/);
    assert.equal(invoked, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const entry of ["resume", "build:resume"]) for (const cancel of [false, true]) test(`${entry} real terminal picker ${cancel ? "cancels" : "inspects"} with no flags and does not resume a live build`, { skip: process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0 }, async () => {
  const dir = initializedProject();
  try {
    const run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"] });
    const result = spawnSync("python3", ["-c", `
import errno, fcntl, os, pty, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2], sys.argv[3]], cwd=sys.argv[4], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "TERM": "xterm", "NO_COLOR": "1"})
os.close(slave)
output = b""
selected = False
deadline = time.monotonic() + 20
try:
 while time.monotonic() < deadline:
  ready, _, _ = select.select([master], [], [], 0.1)
  if ready:
   try: data = os.read(master, 65536)
   except OSError as error:
    if error.errno == errno.EIO: break
    raise
   if not data: break
   output += data
   if not selected and (b"What should Rafi resume?" in output or b"Which interrupted build" in output):
    os.write(master, bytes([3 if sys.argv[5] == "cancel" else 13]))
    selected = True
  if child.poll() is not None: break
finally:
 if child.poll() is None: child.kill()
 child.wait()
 os.close(master)
 sys.stdout.buffer.write(output)
sys.exit(child.returncode)
`, process.execPath, fileURLToPath(new URL("../dist/index.js", import.meta.url)), entry, dir, cancel ? "cancel" : "inspect"], { encoding: "utf8", timeout: 25000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Which interrupted build|What should Rafi resume/);
    if (cancel) assert.doesNotMatch(result.stdout, /original process is verified live/);
    else assert.match(result.stdout, /original process is verified live/);
    assert.equal(readBuildRuns(dir).find(item => item.runId === run.runId)?.recoveryDecision, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("preparation recovery cannot replay uncertain execution", async () => {
  const dir = initializedProject();
  try {
    const db = new WorkflowDb(dir);
    db.ensureRun("uncertain-preparation", "build");
    db.transition("uncertain-preparation", { status: "paused", checkpoint: "preparing", state: { startArgs: ["start", resolve(dir), "--steps", "1"] } });
    db.planOperation({ runId: "uncertain-preparation", idempotencyKey: "uncertain-dispatch", kind: "provider-dispatch", intent: { role: "builder" } });
    db.updateOperation("uncertain-dispatch", "in_progress");
    db.updateOperation("uncertain-dispatch", "uncertain");
    db.close();
    await assert.rejects(buildBuildResumeCommand({ selectRun: async runs => runs[0],
      executeStart: () => { throw new Error("must not dispatch"); },
    }).parseAsync([dir], { from: "user" }), /execution evidence/);
    const reopened = new WorkflowDb(dir);
    try { assert.equal(reopened.currentLease(), undefined); assert.equal(reopened.operation("uncertain-dispatch")?.status, "uncertain"); }
    finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function withoutLaunchToken(args: string[] | undefined): string[] {
  assert.ok(args);
  assert.equal(args.at(-2), "--launch-token");
  assert.match(args.at(-1)!, /^[0-9a-f-]{36}$/);
  return args.slice(0, -2);
}

test("inspection and picker cancellation do not write durable state or probe providers", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = initializedProject();
  const snapshot = (path: string): Record<string, string> => Object.fromEntries(readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name);
    // SQLite may create read-lock SHM and an empty WAL even in readonly mode.
    // Keep native WAL reads for coherent concurrent inspection; no committed
    // database bytes, migrations, projections, or provider calls are allowed.
    if (child.endsWith("recovery.sqlite3-shm")) return [];
    if (child.endsWith("recovery.sqlite3-wal")) { assert.equal(readFileSync(child).length, 0); return []; }
    return entry.isDirectory() ? Object.entries(snapshot(child)) : [[child, createHash("sha256").update(readFileSync(child)).digest("hex")]];
  }));
  try {
    const db = new WorkflowDb(dir);
    db.ensureRun("inspect-preparation"); db.transition("inspect-preparation", { checkpoint: "preparing", state: { startArgs: ["start", dir, "--steps", "1"] } }); db.close();
    const before = snapshot(dir);
    await buildBuildResumeCommand({
      executeStart: () => { throw new Error("inspection must not launch"); },
      resolveProjection: async () => { throw new Error("inspection must not probe a provider"); },
    }).parseAsync([dir, "--run", "inspect-preparation", "--inspect"], { from: "user" });
    await buildBuildResumeCommand({ selectRun: async () => undefined, executeStart: () => { throw new Error("cancelled picker must not launch"); } }).parseAsync([dir], { from: "user" });
    assert.deepEqual(snapshot(dir), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid saved arguments create no successor until explicitly corrected", async () => {
  const dir = initializedProject();
  try {
    const db = new WorkflowDb(dir);
    db.ensureRun("invalid-options");
    db.transition("invalid-options", { checkpoint: "preparing", state: { startArgs: ["start", resolve(dir), "--steps", "1", "--stacks", "1", "--yes"] } });
    db.close();
    let dispatched = 0;
    await buildBuildResumeCommand({ executeStart: () => { dispatched++; return 0; }, correctPreparationArguments: async () => undefined }).parseAsync([dir, "--run", "invalid-options"], { from: "user" });
    const unchanged = new WorkflowDb(dir);
    assert.equal(unchanged.preparationSuccessor("invalid-options"), "invalid-options");
    unchanged.close(); assert.equal(dispatched, 0);
    let invoked: string[] = [];
    await buildBuildResumeCommand({ executeStart: args => { invoked = args; return 0; }, correctPreparationArguments: async saved => [...saved.slice(0, 2), "--steps", "2", "--yes"] }).parseAsync([dir, "--run", "invalid-options"], { from: "user" });
    assert.ok(invoked.includes("--steps"));
    assert.equal(invoked.includes("--yes"), false, "corrected scope must use the normal approval path");
    const updated = new WorkflowDb(dir);
    assert.notEqual(updated.preparationSuccessor("invalid-options"), "invalid-options");
    updated.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const alias of ["resume", "build:resume"]) for (const status of ["completed", "cancelled", "superseded"] as const) test(`${alias} selects cleanup-only ${status} run without replay`, async () => {
  const root = initializedProject();
  const { buildResumeCommand, resumeChoices } = await import("../src/resume.js");
  const db = new WorkflowDb(root);
  const oldExit = process.exitCode;
  try {
    const owner = db.acquireBuildAdmission("terminal-cleanup", "worker");
    db.beginOwnedPreparationProcess(owner, undefined, true);
    db.transition(owner.runId, { status, checkpoint: "terminal", state: {} });
    const raw = (db as any).db;
    const dead = { ...owner, pid: 2147483647 };
    raw.prepare("UPDATE build_admission SET record_json=?").run(JSON.stringify(dead));
    const row = raw.prepare("SELECT id,outcome_json FROM build_owned_processes").get();
    raw.prepare("UPDATE build_owned_processes SET outcome_json=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.outcome_json), authority: dead }), row.id);
    const before = JSON.stringify(db.getRun(owner.runId));
    const choices = resumeChoices(root);
    assert.equal(choices.length, 1); assert.match(choices[0]!.label, /cleanup only/);
    let dispatches = 0;
    const build = () => buildBuildResumeCommand({ executeStart: () => { dispatches++; return 0; }, selectRun: async runs => runs[0] });
    // Merely inspecting/cancelling must leave the probe unchanged.
    await build().parseAsync([root, "--run", owner.runId, "--inspect"], { from: "user" });
    assert.equal(db.readinessProcesses().length, 1);
    if (alias === "resume") await buildResumeCommand({ select: async values => values[0]!.value, resumeBuild: async args => { await build().parseAsync(args, { from: "user" }); }, resumeInterview: async () => { throw new Error("wrong choice"); } }).parseAsync([root], { from: "user" });
    else await build().parseAsync([root], { from: "user" });
    assert.equal(dispatches, 0);
    assert.equal(JSON.stringify(db.getRun(owner.runId)), before);
    assert.deepEqual(db.readinessProcesses(), []);
    assert.equal(resumeChoices(root).length, 0);
    db.acquireBuildAdmission("subsequent", "worker");
  } finally { process.exitCode = oldExit; db.close(); rmSync(root, { recursive: true, force: true }); }
});
