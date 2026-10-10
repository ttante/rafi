import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityReporter, reportBuilderEvent, withActivityContext, withActivityPhase } from "../src/activity.js";

function output(isTTY: boolean): { chunks: string[]; target: { isTTY: boolean; write(text: string): void } } {
  const chunks: string[] = [];
  return { chunks, target: { isTTY, write: (text) => { chunks.push(text); } } };
}

function stripAnsi(value: string): string { return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""); }

test("status spam cannot hide useful-progress age and human waits do not consume it", () => {
  const sink = output(false);
  let now = 0;
  const reporter = new ActivityReporter("test", { output: sink.target, now: () => now, usefulProgressWarningMs: 100, quietWarningMs: 10000 });
  const end = reporter.begin("long verification");
  now = 90; reporter.pulse();
  const resume = reporter.pause();
  now = 1090; resume();
  assert.doesNotMatch(sink.chunks.join(""), /no completed tool/);
  now = 1110; reporter.update("long verification");
  assert.equal(sink.chunks.join("").match(/no completed tool/g)?.length, 1);
  now = 1200; reporter.pulse();
  assert.equal(sink.chunks.join("").match(/no completed tool/g)?.length, 1);
  reporter.completedWork();
  now = 1310; reporter.update("next verification");
  assert.equal(sink.chunks.join("").match(/no completed tool/g)?.length, 2);
  end(); reporter.dispose();
});

test("TTY activity continuously redraws one elapsed-time line and cleans it up", async () => {
  const sink = output(true);
  await withActivityContext("test", async () => {
    await withActivityPhase("planning tickets", async () => {
      await new Promise((resolve) => setTimeout(resolve, 24));
    });
  }, { output: sink.target, displayDelayMs: 0, tickMs: 5, quietWarningMs: 10_000, ttyMode: "cursor" });
  const rendered = sink.chunks.join("");
  assert.match(stripAnsi(rendered), /RAFI working: planning tickets/);
  assert.match(rendered, /\r\x1b\[2K/);
  assert.equal(rendered.endsWith("\r\x1b[2K"), true);
});

test("non-TTY activity coalesces unchanged heartbeats without ANSI", async () => {
  const sink = output(false);
  const reporter = new ActivityReporter("test", { output: sink.target, displayDelayMs: 0, tickMs: 5, heartbeatMs: 10, quietWarningMs: 10_000 });
  const end = reporter.begin("fetching sources");
  await new Promise((resolve) => setTimeout(resolve, 28));
  end();
  reporter.dispose();
  const rendered = sink.chunks.join("");
  assert.match(rendered, /rafi working: fetching sources/);
  assert.doesNotMatch(rendered, /\x1b/);
  assert.equal(rendered.trim().split("\n").length, 1);
});

test("TTY activity colors host labels, while redirected forced color remains opt-in", () => {
  const ttySink = output(true);
  const ttyReporter = new ActivityReporter("test", { output: ttySink.target, colorEnvironment: {}, displayDelayMs: 0, ttyMode: "records" });
  const ttyEnd = ttyReporter.begin("building");
  ttyEnd(); ttyReporter.dispose();
  assert.match(ttySink.chunks.join(""), /\x1b\[36mRAFI\x1b\[39m/);

  const pipeSink = output(false);
  const pipeReporter = new ActivityReporter("test", { output: pipeSink.target, colorEnvironment: {}, displayDelayMs: 0 });
  const pipeEnd = pipeReporter.begin("building");
  pipeEnd(); pipeReporter.dispose();
  assert.doesNotMatch(pipeSink.chunks.join(""), /\x1b/);
});

test("activity note and persistent output cannot emit hostile terminal controls", () => {
  const sink = output(false);
  const reporter = new ActivityReporter("test", { output: sink.target, colorEnvironment: {} });
  reporter.note("safe\x1b]0;title\x07 text\nnext");
  reporter.writePersistent("persistent\x1b[2J\nline\x01");
  const rendered = sink.chunks.join("");
  assert.doesNotMatch(rendered, /\x1b\](?:0;title|\[2J)/);
  assert.doesNotMatch(rendered, /\x01/);
  assert.match(rendered, /safe text\nnext\n/);
  assert.match(rendered, /persistent\nline/);
});

test("non-TTY activity coalesces numeric-only status changes", () => {
  const sink = output(false);
  let now = 0;
  const reporter = new ActivityReporter("test", { output: sink.target, now: () => now, displayDelayMs: 0 });
  const end = reporter.begin("building ticket T001");
  sink.chunks.length = 0;
  now = 10_000;
  reporter.update("building ticket T002", "context 20%", { provider: "codex", model: "gpt-5.4" });
  now = 20_000;
  reporter.update("building ticket T003", "context 30%", { provider: "codex", model: "gpt-5.5" });
  assert.equal(sink.chunks.length, 1);
  assert.match(sink.chunks[0]!, /ticket T002/);
  end();
  reporter.dispose();
});

test("quiet provider warning is durable and repeats only after a new signal", async () => {
  const sink = output(false);
  const reporter = new ActivityReporter("test", { output: sink.target, displayDelayMs: 0, tickMs: 5, heartbeatMs: 100, quietWarningMs: 12 });
  const end = reporter.begin("Codex planning");
  reporter.update("Codex planning", undefined, { provider: "codex" });
  await new Promise((resolve) => setTimeout(resolve, 28));
  assert.equal(sink.chunks.join("").match(/RAFI is still responsive/g)?.length, 1);
  reporter.pulse("received provider status");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sink.chunks.join("").match(/RAFI is still responsive/g)?.length, 2);
  end();
  reporter.dispose();
});

test("retry notes are permanent lines", () => {
  const sink = output(true);
  const reporter = new ActivityReporter("test", { output: sink.target, displayDelayMs: 0, ttyMode: "cursor" });
  const end = reporter.begin("Codex planning");
  reporter.note("rafi: Codex connection closed mid-response; retrying");
  end();
  reporter.dispose();
  assert.match(sink.chunks.join(""), /connection closed mid-response; retrying\n/);
});

test("paused activity does not redraw over an interactive prompt", async () => {
  const sink = output(true);
  const reporter = new ActivityReporter("test", { output: sink.target, displayDelayMs: 0, tickMs: 5, quietWarningMs: 10_000, ttyMode: "cursor" });
  const end = reporter.begin("planning");
  await new Promise((resolve) => setTimeout(resolve, 8));
  const resume = reporter.pause();
  const pausedLength = sink.chunks.length;
  await new Promise((resolve) => setTimeout(resolve, 16));
  assert.equal(sink.chunks.length, pausedLength);
  resume();
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.ok(sink.chunks.length > pausedLength);
  end();
  reporter.dispose();
});

test("TTY agent status remains the bottom-most live line between activity phases", async () => {
  const sink = output(true);
  const reporter = new ActivityReporter("build", { output: sink.target, displayDelayMs: 0, tickMs: 5, quietWarningMs: 10_000, ttyMode: "cursor" });
  reporter.setAgentStatus("builder codex/gpt-test; activity=building; context measuring…; compactions=0; handoff=0");
  const end = reporter.begin("running tests");
  await new Promise((resolve) => setTimeout(resolve, 8));
  end();
  const phaseEndedAt = sink.chunks.length;
  await new Promise((resolve) => setTimeout(resolve, 12));
  const later = sink.chunks.slice(phaseEndedAt).join("");
  assert.match(later, /builder codex\/gpt-test/);
  assert.match(later, /context measuring…/);
  reporter.setAgentStatus(undefined);
  const beforeDispose = sink.chunks.join("");
  assert.equal(beforeDispose.endsWith("\r\x1b[2K"), true);
  reporter.dispose();
});

test("cursor TTY replaces numeric-only changes and appends textual activity changes", () => {
  const sink = output(true);
  let now = 0;
  const reporter = new ActivityReporter("build", { output: sink.target, now: () => now, displayDelayMs: 0, ttyMode: "cursor" });
  const end = reporter.begin("starting Claude turn");
  reporter.update("starting Claude turn", "ticket T001 context 10%", { provider: "claude", model: "claude-3.7" });

  const beforeNumbers = sink.chunks.length;
  now = 12_000;
  reporter.update("starting Claude turn", "ticket T002 context 20%", { provider: "claude", model: "claude-4.1" });
  const numericUpdate = sink.chunks.slice(beforeNumbers).join("");
  assert.match(numericUpdate, /^\r\x1b\[2K/);
  assert.doesNotMatch(numericUpdate, /\n/);

  const beforeActivity = sink.chunks.length;
  reporter.update("processing agent response", "ticket T002 context 20%", { provider: "claude", model: "claude-4.1" });
  const activityUpdate = sink.chunks.slice(beforeActivity).join("");
  assert.match(activityUpdate, /^\n\r\x1b\[2K/);
  assert.match(activityUpdate, /processing agent response/);
  end();
  reporter.dispose();
});

test("record TTY coalesces numeric updates and emits the latest state on semantic change", () => {
  const sink = output(true);
  let now = 0;
  const reporter = new ActivityReporter("build", { output: sink.target, now: () => now, displayDelayMs: 0, ttyMode: "records" });
  const end = reporter.begin("starting Claude turn");
  reporter.update("starting Claude turn", "context 10%", { provider: "claude", model: "claude-3.7" });
  reporter.setAgentStatus("builder claude/claude-3.7; activity=building; context 10.0%; compactions=0; handoff=0");
  sink.chunks.length = 0;

  now = 10_000;
  reporter.setAgentStatus("builder claude/claude-4.1; activity=building; context 20.0%; compactions=1; handoff=2");
  reporter.pulse("context 20%");
  assert.equal(sink.chunks.length, 0);

  reporter.update("processing agent response", "context 20%", { provider: "claude", model: "claude-4.1" });
  assert.equal(sink.chunks.length, 1);
  assert.match(sink.chunks[0]!, /processing agent response/);
  assert.match(sink.chunks[0]!, /context 20\.0%; compactions=1; handoff=2/);
  assert.equal(sink.chunks[0]!.endsWith("\n"), true);
  end();
  reporter.dispose();
});

test("automatic TTY records coalesce timer and numeric-only changes without ANSI", () => {
  const originalMode = process.env.RAFI_ACTIVITY_RENDER_MODE;
  const originalTerm = process.env.TERM;
  try {
    delete process.env.RAFI_ACTIVITY_RENDER_MODE;
    process.env.TERM = "xterm-256color";
    const sink = output(true);
    let now = 0;
    const reporter = new ActivityReporter("build", { output: sink.target, colorEnvironment: { NO_COLOR: "" }, now: () => now, displayDelayMs: 0 });
    const end = reporter.begin("checking ticket 1");
    now = 10_000;
    reporter.update("checking ticket 2");
    now = 20_000;
    reporter.update("checking ticket 3");
    assert.equal(sink.chunks.length, 1);
    assert.equal(sink.chunks[0]!.endsWith("\n"), true);
    assert.doesNotMatch(sink.chunks.join(""), /\x1b/);

    reporter.update("processing agent response");
    assert.equal(sink.chunks.length, 2);
    end();
    reporter.dispose();
  } finally {
    if (originalMode === undefined) delete process.env.RAFI_ACTIVITY_RENDER_MODE;
    else process.env.RAFI_ACTIVITY_RENDER_MODE = originalMode;
    if (originalTerm === undefined) delete process.env.TERM;
    else process.env.TERM = originalTerm;
  }
});

test("record TTY resets semantic coalescing after an activity lifecycle ends", () => {
  const sink = output(true);
  const reporter = new ActivityReporter("test", { output: sink.target, displayDelayMs: 0, ttyMode: "records" });
  reporter.begin("checking ticket 1")();
  reporter.begin("checking ticket 2")();
  assert.equal(sink.chunks.filter((chunk) => stripAnsi(chunk).includes("RAFI working: checking ticket")).length, 2);
  reporter.dispose();
});

test("record TTY keeps persistent output without repeating the current status", () => {
  const sink = output(true);
  const reporter = new ActivityReporter("test", { output: sink.target, displayDelayMs: 0, ttyMode: "records" });
  const end = reporter.begin("running command 1");
  const statusLinesBefore = sink.chunks.filter((chunk) => stripAnsi(chunk).includes("RAFI working:")).length;
  reporter.writePersistent("command output");
  reporter.note("rafi: retrying provider request");
  const statusLinesAfter = sink.chunks.filter((chunk) => stripAnsi(chunk).includes("RAFI working:")).length;
  assert.equal(statusLinesAfter, statusLinesBefore);
  assert.match(sink.chunks.join(""), /command output\n/);
  assert.match(sink.chunks.join(""), /rafi: retrying provider request\n/);
  end();
  reporter.dispose();
});

test("non-TTY heartbeat behavior ignores TTY rendering overrides", () => {
  const sink = output(false);
  const reporter = new ActivityReporter("test", { output: sink.target, displayDelayMs: 0, heartbeatMs: 1, ttyMode: "records" });
  const end = reporter.begin("fetching source 1");
  reporter.update("fetching source 2");
  end();
  reporter.dispose();
  const rendered = sink.chunks.join("");
  assert.match(rendered, /^\[/);
  assert.match(stripAnsi(rendered), /rafi working:/);
  assert.doesNotMatch(stripAnsi(rendered), /RAFI working:/);
  assert.doesNotMatch(rendered, /\x1b/);
});

test("automatic TTY mode is safe for every host and honors explicit overrides", () => {
  const original = {
    mode: process.env.RAFI_ACTIVITY_RENDER_MODE,
    codex: process.env.CODEX_CI,
    ci: process.env.CI,
    term: process.env.TERM,
  };
  const render = (environment: { mode?: string; codex?: string; ci?: string; term?: string }, ttyMode?: "auto" | "cursor" | "records"): string => {
    for (const [key, value] of Object.entries({
      RAFI_ACTIVITY_RENDER_MODE: environment.mode,
      CODEX_CI: environment.codex,
      CI: environment.ci,
      TERM: environment.term,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const sink = output(true);
    const reporter = new ActivityReporter("test", { output: sink.target, displayDelayMs: 0, ttyMode });
    reporter.begin("checking")();
    reporter.dispose();
    return sink.chunks[0] ?? "";
  };

  try {
    assert.equal(render({ term: "xterm-256color" }).endsWith("\n"), true);
    assert.equal(render({ codex: "1", term: "xterm-256color" }).endsWith("\n"), true);
    assert.equal(render({ ci: "true", term: "xterm-256color" }).endsWith("\n"), true);
    assert.equal(render({ term: "dumb" }).endsWith("\n"), true);
    assert.match(render({ mode: "cursor", codex: "1", term: "dumb" }), /^\r\x1b\[2K/);
    assert.equal(render({ mode: "records", term: "xterm-256color" }).endsWith("\n"), true);
    assert.equal(render({ mode: "auto", term: "xterm-256color" }).endsWith("\n"), true);
    assert.equal(render({ mode: "invalid", term: "xterm-256color" }).endsWith("\n"), true);
    assert.match(render({ mode: "records" }, "cursor"), /^\r\x1b\[2K/);
    assert.equal(render({ mode: "cursor" }, "records").endsWith("\n"), true);
    assert.match(render({ mode: "cursor" }, "auto"), /^\r\x1b\[2K/);
  } finally {
    for (const [key, value] of Object.entries({
      RAFI_ACTIVITY_RENDER_MODE: original.mode,
      CODEX_CI: original.codex,
      CI: original.ci,
      TERM: original.term,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("tool lifecycle presentation preserves useful status and liveness", async () => {
  const sink = output(true);
  let now = 0;
  await withActivityContext("test", async () => {
    await withActivityPhase("planning", async () => {
      reportBuilderEvent({ kind: "activity", state: "reading repository", provider: "claude" });
      sink.chunks.length = 0;

      reportBuilderEvent({ kind: "tool", name: "tool_result", input: {}, lifecycle: "completed", status: "completed" });
      assert.equal(sink.chunks.length, 0);

      reportBuilderEvent({ kind: "tool", name: "Bash", input: { command: "pnpm test" }, lifecycle: "started" });
      assert.equal(sink.chunks.length, 1);
      assert.match(sink.chunks[0]!, /running Bash/);
      assert.match(sink.chunks[0]!, /pnpm test/);

      sink.chunks.length = 0;
      now = 10_000;
      reportBuilderEvent({ kind: "tool", name: "Bash", input: {}, lifecycle: "progress", durationMs: 10_000 });
      reportBuilderEvent({ kind: "tool", name: "Bash", input: {}, lifecycle: "completed", status: "completed", exitCode: 0 });
      assert.equal(sink.chunks.length, 0);

      reportBuilderEvent({ kind: "tool", name: "Write", input: {}, lifecycle: "completed", status: "ERROR" });
      assert.equal(sink.chunks.length, 1);
      assert.match(sink.chunks[0]!, /tool failed.*Write/);

      sink.chunks.length = 0;
      now = 20_000;
      reportBuilderEvent({ kind: "tool", name: "Bash", input: {}, lifecycle: "completed", exitCode: 1 });
      assert.equal(sink.chunks.length, 1);
      assert.match(sink.chunks[0]!, /tool failed.*Bash/);

      now = 30_000;
      await new Promise((resolve) => setTimeout(resolve, 8));
      assert.equal(sink.chunks.length, 1);

      sink.chunks.length = 0;
      reportBuilderEvent({ kind: "tool", name: "Read", input: { file_path: "README.md" } });
      assert.equal(sink.chunks.length, 1);
      assert.match(sink.chunks[0]!, /running Read.*README\.md/);
    });
  }, { output: sink.target, now: () => now, displayDelayMs: 0, tickMs: 5, quietWarningMs: 100_000, ttyMode: "records" });
});

test("successful tool completion refreshes the quiet clock without creating a record", async () => {
  const sink = output(true);
  let now = 0;
  await withActivityContext("test", async () => {
    await withActivityPhase("planning", async () => {
      reportBuilderEvent({ kind: "activity", state: "reading repository", provider: "claude" });
      sink.chunks.length = 0;

      now = 20;
      reportBuilderEvent({ kind: "tool", name: "tool_result", input: {}, lifecycle: "completed", status: "completed" });
      assert.equal(sink.chunks.length, 0);

      await new Promise((resolve) => setTimeout(resolve, 8));
      assert.doesNotMatch(sink.chunks.join(""), /still responsive/);

      now = 31;
      await new Promise((resolve) => setTimeout(resolve, 8));
      assert.equal(sink.chunks.join("").match(/still responsive/g)?.length, 1);
    });
  }, { output: sink.target, now: () => now, displayDelayMs: 0, tickMs: 5, quietWarningMs: 10, ttyMode: "records" });
});

test("post-answer quiet status explicitly reports absent Claude stream resumption", () => {
  const sink = output(false);
  let now = 0;
  const reporter = new ActivityReporter("test", { output: sink.target, now: () => now, displayDelayMs: 0, quietWarningMs: 10 });
  const end = reporter.begin("planning");
  reporter.update("answer sent; waiting for Claude");
  now = 20;
  reporter.pulse();
  now = 40;
  // A status redraw without a new provider signal reaches the quiet warning.
  reporter.setAgentStatus("planner");
  assert.match(sink.chunks.join(""), /Claude has not resumed its stream yet after your answer was sent/);
  reporter.update("Claude stream resumed");
  sink.chunks.length = 0;
  now = 60;
  reporter.setAgentStatus("planner");
  assert.doesNotMatch(sink.chunks.join(""), /has not resumed/);
  end();
  reporter.dispose();
});
