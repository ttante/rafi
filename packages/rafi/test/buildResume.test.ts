import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";

import { createBuildRun, persistBuildSession, releaseBuildLease } from "ai-foreman/build-runs.js";
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
    run = persistBuildSession(dir, run, "builder", "session-123");
    run = releaseBuildLease(dir, run, "recoverable");
    let invoked: string[] | undefined;
    const command = buildBuildResumeCommand({ executeStart: (args) => { invoked = args; return 0; } });

    await command.parseAsync([dir, "--run", run.runId, "--yes"], { from: "user" });

    assert.deepEqual(invoked, [
      "start",
      resolve(dir),
      "--steps",
      "1",
      "--yes",
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

    assert.deepEqual(invoked, ["start", resolve(dir), "--steps", "1", "--yes", "--agent", "claude"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
