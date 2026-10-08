import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuestionRoundTripTrace, type QuestionTrace } from "../src/questionTrace.js";
import { Log } from "../src/log.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";
import type { BuilderAdapterOptions, PermissionDecision } from "../src/adapters/types.js";

test("question traces measure each boundary and clean up concurrent callbacks", () => {
  let now = 0;
  const records: QuestionTrace[] = [];
  const spans: string[] = [];
  const trace = new QuestionRoundTripTrace("planning", (event) => { records.push(event); }, {
    start: (id) => { spans.push(`start:${id}`); return id; },
    finish: (id, outcome) => { spans.push(`finish:${id}:${outcome}`); },
  }, () => now);
  const first = trace.begin();
  const second = trace.begin();
  now = 100;
  trace.returned(first, "allowed");
  now = 125;
  trace.message("provider-retry");
  trace.message("stream-message");
  now = 200;
  trace.returned(second, "allowed");
  now = 230;
  trace.message("provider-error");
  trace.finish("result-error");
  trace.finish("closed");
  trace.returned(first, "allowed");
  assert.notEqual(first, second);
  assert.deepEqual(records.filter((r) => r.attemptId === first).map((r) => [r.stage, r.outcome, r.durationMs]), [
    ["sdk-request", "pending", 0], ["local-permission-start", "pending", 0],
    ["answer-returned", "allowed", 100], ["next-stream-message", "provider-retry", 25],
    ["provider-signal", "provider-error", 105], ["terminal", "result-error", 0],
  ]);
  assert.equal(records.filter((r) => r.stage === "next-stream-message").length, 2);
  assert.equal(spans.length, 4);
  assert.equal(records.every((r) => r.runtimePhase === "planning"), true);
});

test("redacted traces work with standalone JSONL logs and survive failed sinks and spans", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-question-trace-"));
  try {
    const path = join(dir, "planner.jsonl");
    const log = new Log(path);
    const trace = new QuestionRoundTripTrace("planning", (event) => log.write("question-round-trip", { ...event }));
    trace.returned(trace.begin(), "denied");
    trace.finish("stream-ended");
    const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 4);
    for (const record of records) assert.deepEqual(Object.keys(record).sort(), ["ts", "event", "attemptId", "timestamp", "elapsedMs", "durationMs", "runtimePhase", "stage", "outcome"].sort());
    for (const sink of [() => { throw new Error("private credentials"); }, async () => { throw new Error("private URL"); }]) {
      const failing = new QuestionRoundTripTrace("builder", sink, {
        start: () => { throw new Error("span failed"); }, finish: () => { throw new Error("span failed"); },
      });
      failing.returned(failing.begin(), "allowed");
      failing.message("stream-message");
      failing.finish("result");
    }
    await new Promise((resolve) => setImmediate(resolve));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Drive the actual SDK callback and stream pump without a provider connection.
function harness(permission: BuilderAdapterOptions["permission"], records: QuestionTrace[], idleMs = 1000) {
  const stream = new AsyncQueue<unknown>();
  let callback!: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: (input: { options: { canUseTool: typeof callback } }) => unknown) => ClaudeAdapter;
  const adapter = new Constructor({ cwd: "/tmp/test", runtimePhase: "planning", permission, providerIdleTimeoutMs: idleMs, onQuestionTrace: (event) => { records.push(event); } }, ({ options }) => {
    callback = options.canUseTool;
    return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), interrupt: async () => { stream.close(); } };
  });
  return { adapter, stream, ask: () => callback("AskUserQuestion", { questions: [{ question: "SECRET QUESTION", header: "SECRET HEADER" }], secret: "SECRET INPUT" }) };
}

test("SDK answer boundary precedes resumed stream and result without logging payloads", async () => {
  const records: QuestionTrace[] = [];
  const answer: PermissionDecision = { behavior: "allow", updatedInput: { answers: { "SECRET QUESTION": "SECRET ANSWER" } } };
  const { adapter, stream, ask } = harness(async () => answer, records);
  const turn = adapter.sendTurn("private instruction");
  assert.deepEqual(await ask(), { ...answer, updatedPermissions: undefined, toolUseID: undefined });
  stream.push({ type: "stream_event" });
  stream.push({ type: "result", subtype: "success", result: "SECRET RESULT", is_error: false, num_turns: 1, total_cost_usd: 0 });
  assert.equal((await turn).isError, false);
  await adapter.close();
  assert.deepEqual(records.map((r) => r.stage), ["sdk-request", "local-permission-start", "answer-returned", "next-stream-message", "terminal"]);
  assert.equal(records.at(-1)?.outcome, "result");
  assert.doesNotMatch(JSON.stringify(records), /SECRET|private instruction/);
});

test("idle timeout starts after answer and reports absent stream resumption", async () => {
  const records: QuestionTrace[] = [];
  let answer!: (decision: PermissionDecision) => void;
  const { adapter, ask } = harness(() => new Promise((resolve) => { answer = resolve; }), records, 15);
  const turn = adapter.sendTurn("private instruction");
  const permission = ask();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(records.some((r) => r.stage === "terminal"), false);
  answer({ behavior: "allow", updatedInput: { answers: { secret: "secret" } } });
  await permission;
  // Keep the event loop alive while the production watchdog is unref'ed.
  const alive = setTimeout(() => {}, 1000);
  try {
    const result = await turn;
    assert.match(result.text, /Claude has not resumed its stream yet/);
    assert.equal(result.failure?.dispatchState, "unknown");
    assert.equal(records.at(-1)?.outcome, "idle-timeout");
  } finally { clearTimeout(alive); await adapter.close(); }
});

test("local callback errors and close while prompting leave no dangling attempt", async () => {
  const records: QuestionTrace[] = [];
  const failed = harness(async () => { throw new Error("SECRET CALLBACK ERROR"); }, records);
  await assert.rejects(failed.ask(), /SECRET CALLBACK ERROR/);
  await failed.adapter.close();
  assert.equal(records.at(-1)?.outcome, "callback-error");
  assert.equal(records.some((r) => r.stage === "answer-returned"), false);
  const closedRecords: QuestionTrace[] = [];
  let answer!: (decision: PermissionDecision) => void;
  const closed = harness(() => new Promise((resolve) => { answer = resolve; }), closedRecords);
  const permission = closed.ask();
  await closed.adapter.close();
  answer({ behavior: "deny", message: "SECRET DENIAL" });
  await permission;
  assert.equal(closedRecords.at(-1)?.outcome, "closed");
  assert.doesNotMatch(JSON.stringify([...records, ...closedRecords]), /SECRET/);
});

test("stream failure and premature stream end preserve the exact terminal boundary", async () => {
  for (const fail of [false, true]) {
    const records: QuestionTrace[] = [];
    const { adapter, stream, ask } = harness(async () => ({ behavior: "allow" }), records);
    const turn = adapter.sendTurn("private instruction");
    await ask();
    if (fail) {
      // A malformed SDK message causes the stream handler to throw into pump().
      stream.push({ type: "assistant", message: null });
    } else stream.close();
    assert.equal((await turn).isError, true);
    await adapter.close();
    assert.equal(records.at(-1)?.outcome, fail ? "stream-error" : "stream-ended");
  }
});

test("auth-status errors are categorized before and after stream resumption", async () => {
  for (const resumed of [false, true]) {
    const records: QuestionTrace[] = [];
    const { adapter, stream, ask } = harness(async () => ({ behavior: "allow" }), records);
    const turn = adapter.sendTurn("private instruction");
    await ask();
    if (resumed) stream.push({ type: "stream_event" });
    stream.push({ type: "auth_status", error: "SECRET AUTH ERROR", output: ["SECRET AUTH OUTPUT"] });
    stream.push({ type: "system", subtype: "api_retry", error: "SECRET RETRY ERROR", error_status: 503, attempt: 1, max_retries: 2, retry_delay_ms: 10 });
    stream.push({ type: "assistant", error: "authentication_failed", message: { content: [] } });
    stream.close();
    try { await turn; } finally { await adapter.close(); }
    assert.deepEqual(records.filter((r) => r.stage === "next-stream-message").map((r) => r.outcome), [resumed ? "stream-message" : "provider-auth-error"]);
    assert.deepEqual(records.filter((r) => r.stage === "provider-signal").map((r) => r.outcome), resumed
      ? ["provider-auth-error", "provider-retry", "provider-auth-error"]
      : ["provider-retry", "provider-auth-error"]);
    assert.equal(records.at(-1)?.outcome, "stream-ended");
    assert.doesNotMatch(JSON.stringify(records), /SECRET|authentication_failed/);
  }
});

test("later provider signals do not reopen or finish the answer wait span again", () => {
  const records: QuestionTrace[] = [];
  const finishes: string[] = [];
  let starts = 0;
  const trace = new QuestionRoundTripTrace("planning", (record) => { records.push(record); }, {
    start: (id) => { starts++; return id; },
    finish: (_id, outcome) => { finishes.push(outcome); },
  });
  trace.returned(trace.begin(), "allowed");
  trace.message("stream-message");
  trace.message("provider-auth-error");
  trace.message("provider-retry");
  trace.message("provider-error");
  trace.message("stream-message");
  trace.finish("idle-timeout");
  trace.message("provider-retry");
  assert.equal(starts, 1);
  assert.deepEqual(finishes, ["stream-message"]);
  assert.deepEqual(records.filter((r) => r.stage === "provider-signal").map((r) => r.outcome), ["provider-auth-error", "provider-retry", "provider-error"]);
  assert.equal(records.at(-1)?.outcome, "idle-timeout");
});
