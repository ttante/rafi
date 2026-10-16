import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";
import type { BuilderAdapterOptions, BuilderEvent } from "../src/adapters/types.js";

test("Claude results retain tool identity, classify uncertainty, and coalesce duplicate results", async () => {
  const stream = new AsyncQueue<unknown>();
  const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: () => unknown) => ClaudeAdapter;
  const traces: Array<Record<string, unknown>> = [];
  const adapter = new Constructor({ cwd: "/tmp/rafi-scripted-tools", permission: async () => ({ behavior: "deny", message: "fixture" }), onLifecycleTrace: trace => traces.push(trace) }, () => ({ [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), interrupt: async () => stream.close() }));
  const events: BuilderEvent[] = [];
  const consume = (async () => { for await (const event of adapter.events()) events.push(event); })();
  try {
    const turn = adapter.sendTurn("Scripted fixture");
    for (const [id, text, failed] of [["elapsed", "TIME_ELAPSED", true], ["timeout", "command timed out", true], ["failure", "command exited 1", true], ["ok", "done", false], ["mixed", "TIME_ELAPSED: command exited 1", true], ["provisional", "gateway result pending", true], ["elapsed", "command exited 1", true], ["host-denial", "Foreman policy: this action needs human approval (command not allow-listed) and was NOT performed. Do not retry it.", true], ["approval-pending", "approval pending", true]] as const) {
      if (id !== "elapsed" || text === "TIME_ELAPSED") stream.push({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "test" } }] } });
      const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: failed }] } };
      stream.push(result); stream.push(result);
    }
    stream.push({ type: "result", subtype: "success", result: "Done", is_error: false, num_turns: 1, total_cost_usd: 0 });
    await turn;
  } finally { await adapter.close(); await consume; }
  const results = events.filter((event): event is Extract<BuilderEvent, { kind: "tool" }> => event.kind === "tool" && event.lifecycle === "completed");
  assert.equal(results.length, 9);
  assert.ok(results.every(event => event.name === "Bash"));
  assert.deepEqual(results.map(event => event.status), ["unknown", "timed_out", "failed", "completed", "failed", "unknown", "failed", "denied", "unknown"]);
  assert.equal(results[0]?.completionKnown, false);
  const diagnostic = traces.find(trace => trace.phase === "provider-tool-result" && trace.toolCallId === "provisional");
  assert.equal(diagnostic?.classification, "unknown");
  assert.equal(diagnostic?.resultReason, "unexplained_error");
  assert.equal(diagnostic?.isError, true);
  assert.equal(typeof diagnostic?.outputDigest, "string");
  assert.equal("outputSummary" in (diagnostic ?? {}), false);
});
