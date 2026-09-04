import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";

import { createBuildRun, persistBuildSession, projectBuildRecovery, readBuildRuns, releaseBuildLease } from "ai-foreman/build-runs.js";
import { createProviderSessionRef } from "ai-foreman/session-identity.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";
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
      "--recovery-mode", "fresh-recovery-only", "--agent", "claude",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build:resume refuses to treat a V1 QA packet as authoritative without an explicit legacy choice", async () => {
  const dir = initializedProject();
  try {
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T011"] });
    run = releaseBuildLease(dir, run, "recoverable");
    attachLegacyQaRecovery(dir, run.runId);
    const command = buildBuildResumeCommand({ executeStart: () => 0 });
    await assert.rejects(
      command.parseAsync([dir, "--run", run.runId, "--yes"], { from: "user" }),
      /--legacy-qa-recovery restart[\s\S]*--legacy-qa-recovery historical/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy QA restart and historical modes both use a fresh validated Builder handoff", async () => {
  for (const legacyMode of ["restart", "historical"] as const) {
    const dir = initializedProject();
    try {
      let run = createBuildRun({ repositoryRoot: dir, tickets: ["T011"], builder: { role: "builder", source: "project", make: "codex", model: "default", reasoning: "default", fast: false } });
      run = persistBuildSession(dir, run, "builder", scopedSession(dir, `legacy-${legacyMode}`));
      run = releaseBuildLease(dir, run, "recoverable");
      const db = new WorkflowDb(dir);
      db.appendContinuityEvent({ runId: run.runId, role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1 });
      db.publishContinuityCheckpoint({ runId: run.runId, role: "builder", authoritativeStateRevision: 1, delta: { version: 1, decisions: [], constraints: [], discoveries: [], completedActions: [], evidence: [], failures: [], blockers: [], openWork: ["perform full QA"], nextAction: "resume Builder and create a fresh protected QA review" } });
      db.close();
      attachLegacyQaRecovery(dir, run.runId);
      let invoked: string[] | undefined;
      const command = buildBuildResumeCommand({ executeStart: (args) => { invoked = args; return 0; }, resolveProjection: availableProjection });
      await command.parseAsync([dir, "--run", run.runId, "--yes", "--legacy-qa-recovery", legacyMode, "--fresh-with-handoff"], { from: "user" });
      assert.ok(invoked);
      assert.equal(invoked.includes("--accept-handoff-role"), true);
      assert.equal(invoked[invoked.indexOf("--accept-handoff-role") + 1], "builder");
      const after = new WorkflowDb(dir);
      const pending = after.getRun(run.runId)?.state.qaReportRecovery as Record<string, unknown>;
      after.close();
      assert.equal(pending.authoritative, false);
      assert.equal(pending.pendingAction, legacyMode === "restart" ? "legacy-clean-review" : "legacy-historical-full-review");
      if (legacyMode === "historical") assert.equal(typeof pending.historicalContextPath, "string");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
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
