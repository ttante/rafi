import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const run = db.getRun(runId)!;
  db.transition(runId, {
    status: run.status, checkpoint: run.checkpoint, remainingWork: run.remainingWork,
    state: { ...run.state, qaReportRecovery: { packetPath: packet, packetDigest: "0".repeat(64), pendingAction: "operator-menu", ticketId: "T011" } },
    event: "legacy_qa_packet_fixture", payload: { packet },
  });
  db.close();
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

    assert.deepEqual(invoked, [
      "start",
      resolve(dir),
      "--steps",
      "1",
      "--recover-run",
      run.runId,
      "--recovery-mode",
      "exact-session",
      "--recovery-decision-digest", decisionDigest(dir, run.runId),
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
    assert.deepEqual(invoked?.slice(-4), ["--resume", "session-ticket", "--agent", "codex"]);
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

    assert.deepEqual(invoked, [
      "start", resolve(dir), "--steps", "1", "--recover-run", run.runId,
      "--recovery-mode", "fresh-recovery-only", "--recovery-decision-digest", decisionDigest(dir, run.runId), "--agent", "claude",
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
    await command.parseAsync([dir, "--run", run.runId, "--ticket", "T032", "--qa-revision", String(protocolHead.revision), "--yes", "--fresh-with-handoff"], { from: "user" });
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
    await command.parseAsync([dir, "--run", run.runId, "--ticket", "T041", "--qa-revision", String(head.revision), "--yes", "--fresh-session"], { from: "user" });
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

      assert.deepEqual(invoked, [
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
