import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildTicketsCommand } from "../src/cli/tickets.js";
import {
  checkpointInterview,
  completeInterview,
  createInterviewRecord,
  discardInterview,
  failInterview,
  fingerprintOutputs,
  INTERVIEW_DIRECTORY,
  pruneCompletedInterviews,
  readInterviewRecords,
  outputsChanged,
  unfinishedInterviews,
  resumeInterviewRecord,
} from "../src/interviews.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-interview-test-"));
}

for (const command of ["setup:init", "setup:update"] as const) test(`${command} CLI completes the selected recovery record without a replacement`, async () => {
  const dir = tempDir();
  try {
    const workflow = command === "setup:init" ? "tickets-setup-init" : "tickets-setup-update";
    const record = checkpointInterview(dir, createInterviewRecord({ workflow, invocation: { projectDir: dir }, checkpoint: "setup-section" }), {});
    await buildTicketsCommand().parseAsync(["node", "test", command, "--project", dir, "--defaults", "--population-mode", "approved_plan", "--skip-access-check", "--interview-id", record.id]);
    const records = readInterviewRecords(dir).records;
    assert.equal(records.length, 1);
    assert.equal(records[0]?.id, record.id);
    assert.equal(records[0]?.status, "completed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const workflow of ["create", "tickets-setup-init", "tickets-setup-update"] as const) test(`${workflow} recovery retains exact interview identity and cancellation remains unfinished`, () => {
  const dir = tempDir();
  try {
    const original = checkpointInterview(dir, createInterviewRecord({ workflow, invocation: { projectDir: dir }, checkpoint: "start", answers: { saved: "answer" } }), {});
    failInterview(dir, original, "start", new Error("fixture interruption"));
    const resumed = checkpointInterview(dir, resumeInterviewRecord(dir, original.id, workflow), {});
    assert.equal(resumed.id, original.id);
    assert.equal(resumed.answers.saved, "answer");
    assert.equal(readInterviewRecords(dir).records.length, 1);
    assert.notEqual(readInterviewRecords(dir).records[0]?.status, "completed");
    completeInterview(dir, resumed);
    assert.equal(readInterviewRecords(dir).records[0]?.status, "completed");
    assert.throws(() => resumeInterviewRecord(dir, original.id, workflow), /not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("interview records persist atomically, are ignored, and retain only redacted failure context", () => {
  const dir = tempDir();
  try {
    let record = createInterviewRecord({
      workflow: "plan",
      invocation: { projectDir: dir },
      checkpoint: "brief",
    });
    record = checkpointInterview(dir, record, { checkpoint: "agent-run", answers: { brief: "Add labels" } });
    record = failInterview(dir, record, "agent-run", new Error("token=secret-value planner stopped"));

    const loaded = readInterviewRecords(dir);
    assert.equal(loaded.problems.length, 0);
    assert.equal(loaded.records[0]?.answers.brief, "Add labels");
    assert.match(loaded.records[0]?.failure?.summary ?? "", /token=<redacted>/);
    assert.doesNotMatch(loaded.records[0]?.failure?.summary ?? "", /secret-value/);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".rafi/interviews/\n");
    assert.ok(existsSync(join(dir, INTERVIEW_DIRECTORY, `${record.id}.json`)));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("output fingerprints detect concurrent artifact drift before a resumed write", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "plan.md"), "first", "utf8");
    const fingerprints = fingerprintOutputs(dir, ["plan.md", "missing.md"]);
    assert.deepEqual(outputsChanged(dir, fingerprints), []);
    writeFileSync(join(dir, "plan.md"), "other interview wrote this", "utf8");
    assert.deepEqual(outputsChanged(dir, fingerprints), ["plan.md"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("completed records prune after 30 days while unfinished and malformed records remain", () => {
  const dir = tempDir();
  try {
    const old = new Date("2026-01-01T00:00:00.000Z");
    const done = completeInterview(dir, createInterviewRecord({
      workflow: "create", invocation: { projectDir: dir }, checkpoint: "done", now: old,
    }), old);
    const pending = checkpointInterview(dir, createInterviewRecord({
      workflow: "plan", invocation: { projectDir: dir }, checkpoint: "brief", now: old,
    }), { checkpoint: "brief" });
    writeFileSync(join(dir, INTERVIEW_DIRECTORY, "broken.json"), "{nope", "utf8");

    assert.deepEqual(pruneCompletedInterviews(dir, new Date("2026-02-02T00:00:00.000Z")), [done.id]);
    assert.equal(unfinishedInterviews(dir).some((record) => record.id === pending.id), true);
    assert.equal(readInterviewRecords(dir).problems.length, 1);
    assert.equal(discardInterview(dir, pending.id), true);
    assert.equal(discardInterview(dir, pending.id), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
