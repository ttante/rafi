import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuildRun, releaseBuildLease } from "ai-foreman/build-runs.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";
import { createInterviewRecord, saveInterviewRecord } from "ai-foreman/interviews.js";
import { buildResumeCommand, resumeChoices } from "../src/resume.js";
import { addBuildRecoveryOptions } from "../src/buildRecoveryOptions.js";
import { Command } from "commander";

for (const kind of ["build", "interview"] as const) {
  test(`rafi resume lists both kinds newest first and routes selected ${kind}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "rafi-resume-picker-"));
    try {
      const interview = saveInterviewRecord(dir, createInterviewRecord({ workflow: "plan", invocation: {}, checkpoint: "agent-run", now: new Date(0) }), new Date(0));
      const run = releaseBuildLease(dir, createBuildRun({ repositoryRoot: dir, tickets: ["T001"] }), "recoverable");
      let selected = "";
      await buildResumeCommand({
        select: async choices => {
          assert.equal(choices.length, 2);
          assert.equal(choices[0].kind, "build");
          return choices.find(choice => choice.kind === kind)!.value;
        },
        resumeBuild: async args => { assert.deepEqual(args, [dir, "--run", run.runId]); selected = "build"; },
        resumeInterview: async (root, record) => { assert.equal(root, dir); assert.equal(record.id, interview.id); selected = "interview"; },
      }).parseAsync([dir], { from: "user" });
      assert.equal(selected, kind);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("resume picker cancellation and completed/superseded filtering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-resume-filter-"));
  try {
    for (const status of ["completed", "superseded", "interrupted"] as const) releaseBuildLease(dir, createBuildRun({ repositoryRoot: dir, tickets: ["T001"] }), status);
    const choices = resumeChoices(dir);
    assert.equal(choices.length, 1);
    await buildResumeCommand({ select: async () => undefined,
      resumeBuild: async () => { throw new Error("cancelled"); }, resumeInterview: async () => { throw new Error("cancelled"); },
    }).parseAsync([dir], { from: "user" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("preparation-only interrupted starts appear beside build checkpoints", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-resume-preparation-"));
  try {
    const db = new WorkflowDb(dir);
    db.ensureRun("latest-preparation", "build");
    db.transition("latest-preparation", { status: "paused", checkpoint: "preparing" });
    db.close();
    assert.equal(resumeChoices(dir)[0].id, "latest-preparation");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit interview resume and discard remain supported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-resume-interview-"));
  try {
    const record = saveInterviewRecord(dir, createInterviewRecord({ workflow: "plan", invocation: {}, checkpoint: "agent-run" }));
    let resumed = 0;
    const options = { resumeBuild: async () => { throw new Error("wrong route"); }, resumeInterview: async () => { resumed++; } };
    await buildResumeCommand(options).parseAsync([dir, "--id", record.id], { from: "user" });
    assert.equal(resumed, 1);
    await buildResumeCommand(options).parseAsync([dir, "--discard", record.id], { from: "user" });
    assert.equal(resumeChoices(dir).length, 0);
    await assert.rejects(buildResumeCommand(options).parseAsync([dir, "--run", "x", "--id", "y"], { from: "user" }), /choose only one/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("short resume forwards every explicitly supplied public build recovery option", async () => {
  const flags = ["--ticket", "T001", "--qa-revision", "0", "--inspect", "--yes", "--no", "--fresh-with-handoff", "--fresh-session", "--guided-recovery", "--agent", "codex", "--model", "test-model"];
  // Conflicting modes are deliberately retained for the build command's validator.
  const command = buildResumeCommand({ resumeBuild: async args => { assert.deepEqual(args, [process.cwd(), "--run", "run", ...flags]); }, resumeInterview: async () => { throw new Error("wrong route"); } });
  assert.deepEqual(command.options.filter(option => !["run", "id", "discard"].includes(option.attributeName())).map(option => option.flags), addBuildRecoveryOptions(new Command()).options.map(option => option.flags));
  await command.parseAsync(["--run", "run", ...flags], { from: "user" });
});

for (const mode of ["id", "discard", "picker"] as const) test(`build recovery options cannot affect an interview through ${mode}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-resume-interview-options-"));
  try {
    const record = saveInterviewRecord(dir, createInterviewRecord({ workflow: "plan", invocation: {}, checkpoint: "agent-run" }));
    const command = buildResumeCommand({ select: async choices => choices[0].value, resumeBuild: async () => { throw new Error("unexpected dispatch"); }, resumeInterview: async () => { throw new Error("unexpected dispatch"); } });
    await assert.rejects(command.parseAsync([dir, ...(mode === "picker" ? [] : [`--${mode}`, record.id]), "--fresh-session"], { from: "user" }), /Build recovery options cannot be used with an interview/);
    assert.equal(resumeChoices(dir).some(choice => choice.id === record.id), true, "rejected discard must preserve interview");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("picker-selected build receives explicit recovery options", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-resume-build-options-"));
  try {
    const run = releaseBuildLease(dir, createBuildRun({ repositoryRoot: dir, tickets: ["T001"] }), "recoverable");
    await buildResumeCommand({ select: async choices => choices[0].value, resumeBuild: async args => { assert.deepEqual(args, [dir, "--run", run.runId, "--no", "--fresh-session"]); }, resumeInterview: async () => { throw new Error("wrong route"); } }).parseAsync([dir, "--no", "--fresh-session"], { from: "user" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
