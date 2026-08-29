import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityReporter, withActivityContext, withActivityPhase } from "../src/activity.js";

function output(isTTY: boolean): { chunks: string[]; target: { isTTY: boolean; write(text: string): void } } {
  const chunks: string[] = [];
  return { chunks, target: { isTTY, write: (text) => { chunks.push(text); } } };
}

test("TTY activity continuously redraws one elapsed-time line and cleans it up", async () => {
  const sink = output(true);
  await withActivityContext("test", async () => {
    await withActivityPhase("planning tickets", async () => {
      await new Promise((resolve) => setTimeout(resolve, 24));
    });
  }, { output: sink.target, displayDelayMs: 0, tickMs: 5, quietWarningMs: 10_000 });
  const rendered = sink.chunks.join("");
  assert.match(rendered, /RAFI working: planning tickets/);
  assert.match(rendered, /\r\x1b\[2K/);
  assert.equal(rendered.endsWith("\r\x1b[2K"), true);
});

test("non-TTY activity emits heartbeat lines without ANSI", async () => {
  const sink = output(false);
  const reporter = new ActivityReporter("test", { output: sink.target, displayDelayMs: 0, tickMs: 5, heartbeatMs: 10, quietWarningMs: 10_000 });
  const end = reporter.begin("fetching sources");
  await new Promise((resolve) => setTimeout(resolve, 28));
  end();
  reporter.dispose();
  const rendered = sink.chunks.join("");
  assert.match(rendered, /rafi working: fetching sources/);
  assert.doesNotMatch(rendered, /\x1b/);
  assert.ok(rendered.trim().split("\n").length >= 2);
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
  const reporter = new ActivityReporter("test", { output: sink.target, displayDelayMs: 0 });
  const end = reporter.begin("Codex planning");
  reporter.note("rafi: Codex connection closed mid-response; retrying");
  end();
  reporter.dispose();
  assert.match(sink.chunks.join(""), /connection closed mid-response; retrying\n/);
});

test("paused activity does not redraw over an interactive prompt", async () => {
  const sink = output(true);
  const reporter = new ActivityReporter("test", { output: sink.target, displayDelayMs: 0, tickMs: 5, quietWarningMs: 10_000 });
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
  const reporter = new ActivityReporter("build", { output: sink.target, displayDelayMs: 0, tickMs: 5, quietWarningMs: 10_000 });
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
