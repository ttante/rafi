import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";
import type { BuilderAdapterOptions, BuilderEvent } from "../src/adapters/types.js";

test("Claude results retain tool identity, classify uncertainty, and coalesce duplicate results", async () => {
  const stream = new AsyncQueue<unknown>();
  const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: () => unknown) => ClaudeAdapter;
  const adapter = new Constructor({ cwd: "/tmp/rafi-scripted-tools", permission: async () => ({ behavior: "deny", message: "fixture" }) }, () => ({ [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), interrupt: async () => stream.close() }));
  const events: BuilderEvent[] = [];
  const consume = (async () => { for await (const event of adapter.events()) events.push(event); })();
  try {
    const turn = adapter.sendTurn("Scripted fixture");
    for (const [id, text, failed] of [["elapsed", "TIME_ELAPSED", true], ["timeout", "command timed out", true], ["failure", "command exited 1", true], ["ok", "done", false], ["mixed", "TIME_ELAPSED: command exited 1", true], ["elapsed", "command exited 1", true]] as const) {
      if (id !== "elapsed" || text === "TIME_ELAPSED") stream.push({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "test" } }] } });
      const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: failed }] } };
      stream.push(result); stream.push(result);
    }
    stream.push({ type: "result", subtype: "success", result: "Done", is_error: false, num_turns: 1, total_cost_usd: 0 });
    await turn;
  } finally { await adapter.close(); await consume; }
  const results = events.filter((event): event is Extract<BuilderEvent, { kind: "tool" }> => event.kind === "tool" && event.lifecycle === "completed");
  assert.equal(results.length, 6);
  assert.deepEqual(results.map(event => event.name), ["Bash", "Bash", "Bash", "Bash", "Bash", "Bash"]);
  assert.deepEqual(results.map(event => event.status), ["unknown", "timed_out", "failed", "completed", "failed", "failed"]);
  assert.equal(results[0]?.completionKnown, false);
});
